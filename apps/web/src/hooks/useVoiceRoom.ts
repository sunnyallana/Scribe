import { type ProjectId } from '@scribe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { log } from '../lib/debug';
import { supabase, wsOrigin } from '../lib/supabase';

/**
 * One remote participant in the voice room.
 */
export interface VoicePeer {
  readonly connId: string;
  readonly userId: string;
  readonly stream: MediaStream | null;
  readonly muted: boolean;
}

export type VoiceState = 'idle' | 'connecting' | 'live' | 'error';

export interface VoiceRoomHandle {
  readonly state: VoiceState;
  readonly peers: readonly VoicePeer[];
  readonly micEnabled: boolean;
  readonly speakerEnabled: boolean;
  readonly error: string | null;
  /** Open the mic + WS, join the room. Idempotent. */
  joinMic: () => Promise<void>;
  /** Close the WS + RTCPeerConnections, stop the mic. Idempotent. */
  leaveMic: () => void;
  /** Mute / unmute the local audio track without leaving the room. */
  setMicEnabled: (enabled: boolean) => void;
  /** Mute / unmute incoming audio from every peer (master speaker). */
  setSpeakerEnabled: (enabled: boolean) => void;
}

/** Public STUN. WebRTC needs a STUN server to discover its public IP
 *  pair for NAT traversal. Google's free one is the de-facto default;
 *  for users behind symmetric NAT (rare in academic settings) a TURN
 *  relay would be needed — deliberately deferred. */
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

/** Target Opus bitrate (per peer). 48 kbps is the sweet spot for
 *  music-quality voice without saturating uplink. Default WebRTC
 *  negotiates ~24 kbps which sounds tinny and develops audible
 *  artifacts on transients. */
const OPUS_TARGET_BITRATE = 48_000;

/**
 * SDP rewriter: bumps Opus to wideband-stereo + 48 kbps + FEC, and
 * disables DTX (discontinuous transmission). DTX is the source of
 * the "weird pitch / interference" some users report — it skips
 * sending silence, then the receiver synthesises comfort noise that
 * doesn't always blend smoothly.
 *
 * The negotiation is done by appending an `fmtp` line for the Opus
 * payload type discovered in the SDP. Works on Chrome, Firefox,
 * Safari, and Edge — no codec swap, just parameter tuning.
 */
function tuneOpusSdp(sdp: string): string {
  // Each m=audio line is followed by a/v lines; we find the Opus
  // payload type from `a=rtpmap:N opus/48000/2`, then either update
  // or insert the matching `a=fmtp:N …` line.
  const rtpmap = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (rtpmap === null) return sdp;
  const pt = rtpmap[1] ?? '';
  const params = [
    'minptime=10', // 10ms frames — lower latency than the 20ms default
    'useinbandfec=1', // FEC — reconstructs occasional lost packets
    'usedtx=0', // OFF: don't pause transmission on silence
    'stereo=1', // request stereo output where the source allows
    `maxaveragebitrate=${OPUS_TARGET_BITRATE.toString()}`,
    'cbr=0', // VBR — better quality at the same average bitrate
  ].join(';');
  const fmtpLine = `a=fmtp:${pt} ${params}`;
  const existing = new RegExp(`a=fmtp:${pt}[^\\n]*`).exec(sdp);
  if (existing !== null) {
    return sdp.replace(existing[0], fmtpLine);
  }
  // No existing fmtp — insert right after the rtpmap line.
  return sdp.replace(rtpmap[0], `${rtpmap[0]}\r\n${fmtpLine}`);
}

/** After the peer connection negotiates, also bump the outbound
 *  sender's max bitrate via `RTCRtpSender.setParameters` — belt-and-
 *  braces alongside the SDP fmtp line. Some browsers honour one,
 *  some the other; setting both wins everywhere. */
async function tuneAudioSender(pc: RTCPeerConnection): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'audio') continue;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    for (const enc of params.encodings) {
      enc.maxBitrate = OPUS_TARGET_BITRATE;
      // High priority so the browser doesn't throttle voice
      // when sharing bandwidth with other tabs.
      enc.priority = 'high';
      enc.networkPriority = 'high';
    }
    try {
      await sender.setParameters(params);
    } catch (err) {
      log.ws.warn('setParameters(opus bitrate) failed', err);
    }
  }
}

interface ServerMsg {
  readonly type: 'welcome' | 'peerJoined' | 'peerLeft' | 'signal' | 'muted';
}

/**
 * Real-time audio chat for everyone in a project. Mesh topology:
 * each peer maintains one RTCPeerConnection to every other peer in
 * the same room. Signaling rides on a WebSocket to
 * `/api/projects/:projectId/voice`; media is peer-to-peer over
 * DTLS-SRTP — the server never sees audio bytes.
 *
 * Lifecycle:
 *   • `joinMic()` opens getUserMedia + WS + (on welcome) creates
 *     RTCPeerConnection to each existing peer; we are the OFFERER
 *     for those. New joiners that arrive AFTER us will offer to us.
 *   • Local-track mute toggle leaves the connection up (so
 *     resuming voice is instant) and just sets `track.enabled`.
 *   • `leaveMic()` closes everything cleanly.
 */
export function useVoiceRoom(projectId: ProjectId | null): VoiceRoomHandle {
  const [state, setState] = useState<VoiceState>('idle');
  const [peers, setPeers] = useState<readonly VoicePeer[]>([]);
  const [micEnabled, setMicEnabledState] = useState(true);
  const [speakerEnabled, setSpeakerEnabledState] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs for everything that must persist across renders without
  // re-triggering effects. The mesh state machine reads + writes
  // these directly.
  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const myConnIdRef = useRef<string | null>(null);
  // peerId → RTCPeerConnection
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // peerId → buffered ICE candidates that arrived before setRemoteDescription
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Latest peers list, kept in sync with state for callbacks.
  const peersRef = useRef<readonly VoicePeer[]>([]);
  peersRef.current = peers;

  const updatePeer = useCallback((connId: string, patch: Partial<VoicePeer>) => {
    setPeers((prev) => prev.map((p) => (p.connId === connId ? { ...p, ...patch } : p)));
  }, []);

  const addPeer = useCallback((p: VoicePeer) => {
    setPeers((prev) => (prev.some((q) => q.connId === p.connId) ? prev : [...prev, p]));
  }, []);

  const removePeer = useCallback((connId: string) => {
    setPeers((prev) => prev.filter((p) => p.connId !== connId));
  }, []);

  const sendSignal = useCallback((to: string, payload: unknown) => {
    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'signal', to, payload }));
  }, []);

  /**
   * Set up an RTCPeerConnection for a remote peer. `isOfferer = true`
   * means we'll create the offer (we're the side that joined later,
   * or in the welcome path, the new joiner offering to existing peers).
   * Returns the pc immediately; ICE negotiation runs async.
   */
  const createPeerConnection = useCallback(
    (remoteConnId: string, isOfferer: boolean): RTCPeerConnection => {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcsRef.current.set(remoteConnId, pc);

      // Attach our local audio track so the peer can hear us.
      const localStream = localStreamRef.current;
      if (localStream !== null) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      // Receive remote audio. The track arrives in an event with
      // `streams[0]` populated by Chrome / Firefox / Safari; we
      // hand it to React state for the `<audio>` element to play.
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? null;
        updatePeer(remoteConnId, { stream });
      };

      pc.onicecandidate = (e) => {
        if (e.candidate !== null) {
          sendSignal(remoteConnId, { kind: 'ice', candidate: e.candidate.toJSON() });
        }
      };

      pc.onconnectionstatechange = () => {
        // Failed / closed states surface as a leave so the UI clears
        // the slot rather than holding a dead peer.
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          pc.close();
          pcsRef.current.delete(remoteConnId);
        }
      };

      if (isOfferer) {
        void (async () => {
          try {
            const offer = await pc.createOffer();
            // Rewrite the SDP to crank Opus to wideband + 48 kbps +
            // FEC + no DTX BEFORE setLocalDescription, so the
            // browser advertises the right parameters in the offer.
            const tuned: RTCSessionDescriptionInit =
              offer.sdp !== undefined
                ? { type: offer.type, sdp: tuneOpusSdp(offer.sdp) }
                : { type: offer.type };
            await pc.setLocalDescription(tuned);
            await tuneAudioSender(pc);
            sendSignal(remoteConnId, { kind: 'offer', sdp: pc.localDescription });
          } catch (err) {
            log.ws.error('voice offer failed', err);
          }
        })();
      }

      return pc;
    },
    [sendSignal, updatePeer],
  );

  const handleSignal = useCallback(
    async (from: string, payload: { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
      let pc = pcsRef.current.get(from);
      // First contact from a peer who joined before us → they sent
      // the welcome-driven offer, so we're the answerer here.
      if (pc === undefined) {
        pc = createPeerConnection(from, false);
        addPeer({ connId: from, userId: '', stream: null, muted: false });
      }
      try {
        if (payload.kind === 'offer' && payload.sdp !== undefined) {
          await pc.setRemoteDescription(payload.sdp);
          // Drain any ICE candidates that arrived before the
          // remote description was set.
          const buffered = pendingIceRef.current.get(from) ?? [];
          for (const c of buffered) await pc.addIceCandidate(c);
          pendingIceRef.current.delete(from);
          const answer = await pc.createAnswer();
          // Mirror the offer's audio tuning on the answer side so
          // BOTH directions of the symmetric call carry the upgraded
          // Opus parameters.
          const tuned: RTCSessionDescriptionInit =
            answer.sdp !== undefined
              ? { type: answer.type, sdp: tuneOpusSdp(answer.sdp) }
              : { type: answer.type };
          await pc.setLocalDescription(tuned);
          await tuneAudioSender(pc);
          sendSignal(from, { kind: 'answer', sdp: pc.localDescription });
        } else if (payload.kind === 'answer' && payload.sdp !== undefined) {
          await pc.setRemoteDescription(payload.sdp);
          const buffered = pendingIceRef.current.get(from) ?? [];
          for (const c of buffered) await pc.addIceCandidate(c);
          pendingIceRef.current.delete(from);
        } else if (payload.kind === 'ice' && payload.candidate !== undefined) {
          if (pc.remoteDescription === null) {
            const list = pendingIceRef.current.get(from) ?? [];
            list.push(payload.candidate);
            pendingIceRef.current.set(from, list);
          } else {
            await pc.addIceCandidate(payload.candidate);
          }
        }
      } catch (err) {
        log.ws.error('voice signal handling failed', err);
      }
    },
    [addPeer, createPeerConnection, sendSignal],
  );

  const teardown = useCallback(() => {
    for (const pc of pcsRef.current.values()) {
      pc.close();
    }
    pcsRef.current.clear();
    pendingIceRef.current.clear();
    if (localStreamRef.current !== null) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    if (wsRef.current !== null) {
      wsRef.current.close();
      wsRef.current = null;
    }
    myConnIdRef.current = null;
    setPeers([]);
    setState('idle');
  }, []);

  const joinMic = useCallback(async () => {
    if (projectId === null) return;
    if (state === 'live' || state === 'connecting') return;
    setState('connecting');
    setError(null);
    try {
      // Browser permission first — must precede the WS connect so
      // we can't be in the room without an outgoing track to send.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Browser-native processing stack. `ideal` lets the
          // browser fall back gracefully if the device doesn't
          // support a constraint (e.g. some Bluetooth headsets
          // refuse 48 kHz).
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          // 48 kHz capture pairs with Opus's native rate — no
          // resampling means no aliasing artifacts. Default in
          // many browsers is 16 kHz, which sounds tinny.
          sampleRate: { ideal: 48_000 },
          sampleSize: { ideal: 16 },
          // Mono. Voice is intrinsically mono and forcing it lets
          // us spend the bandwidth budget on quality instead of
          // stereo width.
          channelCount: { ideal: 1 },
          // `latency` is a real WebRTC constraint but TypeScript's
          // lib.dom.d.ts hasn't caught up — pass it through a
          // cast. 20 ms covers most consumer mics; lower starts
          // to glitch on Bluetooth.
          ...({ latency: { ideal: 0.02 } } as unknown as MediaTrackConstraints),
        },
        video: false,
      });
      localStreamRef.current = stream;
      // Honour the persisted mic-enabled state (defaults to true).
      for (const track of stream.getAudioTracks()) {
        track.enabled = micEnabled;
      }

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token === undefined) throw new Error('no session token');
      const url = `${wsOrigin()}/api/projects/${projectId}/voice?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(event.data as string) as ServerMsg;
        } catch {
          return;
        }
        if (msg.type === 'welcome') {
          const w = msg as ServerMsg & {
            readonly welcomeFor: string;
            readonly peers: ReadonlyArray<{ readonly connId: string; readonly userId: string }>;
          };
          myConnIdRef.current = w.welcomeFor;
          // Offer to every existing peer.
          for (const p of w.peers) {
            addPeer({ connId: p.connId, userId: p.userId, stream: null, muted: false });
            createPeerConnection(p.connId, true);
          }
          setState('live');
        } else if (msg.type === 'peerJoined') {
          const j = msg as ServerMsg & {
            readonly peer: { readonly connId: string; readonly userId: string };
          };
          addPeer({ connId: j.peer.connId, userId: j.peer.userId, stream: null, muted: false });
          // Don't offer here — the joiner will send us an offer via
          // their welcome. Just be ready to answer.
        } else if (msg.type === 'peerLeft') {
          const l = msg as ServerMsg & { readonly connId: string };
          const pc = pcsRef.current.get(l.connId);
          if (pc !== undefined) {
            pc.close();
            pcsRef.current.delete(l.connId);
          }
          removePeer(l.connId);
        } else if (msg.type === 'signal') {
          const s = msg as ServerMsg & {
            readonly from: string;
            readonly payload: { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
          };
          void handleSignal(s.from, s.payload);
        } else if (msg.type === 'muted') {
          const m = msg as ServerMsg & { readonly connId: string; readonly muted: boolean };
          updatePeer(m.connId, { muted: m.muted });
        }
      };
      ws.onerror = () => {
        setError('voice WS error');
        setState('error');
      };
      ws.onclose = () => {
        // If the server closed us mid-call, tear everything down.
        if (wsRef.current === ws) teardown();
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setError(msg);
      setState('error');
      teardown();
    }
  }, [projectId, state, micEnabled, addPeer, createPeerConnection, handleSignal, removePeer, teardown, updatePeer]);

  const leaveMic = useCallback(() => {
    teardown();
  }, [teardown]);

  const setMicEnabled = useCallback((enabled: boolean) => {
    setMicEnabledState(enabled);
    const stream = localStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = enabled;
      }
    }
    // Tell peers so the UI shows the muted indicator.
    const ws = wsRef.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'mute', muted: !enabled }));
    }
  }, []);

  const setSpeakerEnabled = useCallback((enabled: boolean) => {
    setSpeakerEnabledState(enabled);
    // The `<audio>` elements consume `peer.stream` directly; the
    // master speaker mute is enforced at render time by setting
    // `<audio muted>` on every element when `!enabled`.
  }, []);

  // Tear down on unmount / project change.
  useEffect(() => () => { teardown(); }, [teardown, projectId]);

  return {
    state,
    peers,
    micEnabled,
    speakerEnabled,
    error,
    joinMic,
    leaveMic,
    setMicEnabled,
    setSpeakerEnabled,
  };
}
