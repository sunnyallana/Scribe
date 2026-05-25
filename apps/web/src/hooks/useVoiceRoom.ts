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
  /** Connection IDs of peers (incl. `local` for self) that have
   *  audio energy above the speaking threshold right now. Updated
   *  at ~20 Hz from a WebAudio AnalyserNode. */
  readonly speakingConnIds: ReadonlySet<string>;
  /** Convenience: am *I* currently above the speaking threshold? */
  readonly localSpeaking: boolean;
  /** Open the mic + WS, join the room. Idempotent. */
  joinMic: () => Promise<void>;
  /** Close the WS + RTCPeerConnections, stop the mic. Idempotent. */
  leaveMic: () => void;
  /** Mute / unmute the local audio track without leaving the room. */
  setMicEnabled: (enabled: boolean) => void;
  /** Mute / unmute incoming audio from every peer (master speaker). */
  setSpeakerEnabled: (enabled: boolean) => void;
}

/** Speaking-detection threshold. Empirical: typical room-noise RMS
 *  is < 0.01, conversational voice sits in the 0.03–0.2 range. The
 *  threshold is intentionally a hair above noise floor so headset
 *  breath / keyboard taps don't flicker the indicator. */
const SPEAKING_RMS_THRESHOLD = 0.03;

/** Reconnect backoff (ms) — capped at 30s. Same shape as the Yjs
 *  provider's exponential-with-jitter retry. */
const RECONNECT_BACKOFF = [800, 1600, 3200, 6400, 12_800, 25_600, 30_000];

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
 *
 * Exported (not module-local) so unit tests can pin down the SDP
 * mutation without spinning up a full RTCPeerConnection.
 */
export function tuneOpusSdp(sdp: string): string {
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
  const [speakingConnIds, setSpeakingConnIds] = useState<ReadonlySet<string>>(new Set());

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

  // --- Audio-level analysis -----------------------------------------
  // One shared AudioContext, one AnalyserNode per stream
  // (incl. `local`). The rAF loop computes RMS across all
  // analysers ~20 Hz and updates the `speakingConnIds` set only
  // when a transition happens — avoids re-rendering every frame.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());
  const analyserBufferRef = useRef<Float32Array | null>(null);
  const speakingTickRef = useRef<number | null>(null);
  const speakingSetRef = useRef<Set<string>>(new Set());

  // --- Reconnect ---------------------------------------------------
  // `intentionalLeaveRef` distinguishes a user-initiated hangup
  // (don't reconnect) from a transient network blip (do reconnect).
  // `reconnectAttemptRef` indexes into RECONNECT_BACKOFF.
  const intentionalLeaveRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Wake lock ---------------------------------------------------
  // `navigator.wakeLock` keeps the screen on while in the call —
  // mobile devices otherwise sleep mid-conversation and drop the
  // WebRTC connection. Released on leave / page hide.
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Ensure / fetch the shared AudioContext lazily. Safari requires
  // a user-gesture before the first AudioContext is created; we
  // call this from joinMic which is always behind a click.
  const ensureAudioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current !== null) return audioContextRef.current;
    try {
      const Ctor =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor === undefined) return null;
      audioContextRef.current = new Ctor();
      return audioContextRef.current;
    } catch (err) {
      log.ws.warn('AudioContext create failed', err);
      return null;
    }
  }, []);

  // Attach a `connId`-keyed analyser to a MediaStream. Idempotent
  // per connId — re-attaching replaces the old node cleanly.
  const attachAnalyser = useCallback(
    (connId: string, stream: MediaStream) => {
      const ctx = ensureAudioContext();
      if (ctx === null) return;
      const existing = analysersRef.current.get(connId);
      if (existing !== undefined) {
        try {
          existing.disconnect();
        } catch {
          /* ignore */
        }
      }
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        // 512-bin FFT gives 256 time-domain samples per frame —
        // plenty for an RMS, cheap on CPU.
        analyser.fftSize = 512;
        source.connect(analyser);
        analysersRef.current.set(connId, analyser);
      } catch (err) {
        log.ws.warn('attachAnalyser failed', err);
      }
    },
    [ensureAudioContext],
  );

  const detachAnalyser = useCallback((connId: string) => {
    const node = analysersRef.current.get(connId);
    if (node !== undefined) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
      analysersRef.current.delete(connId);
    }
  }, []);

  // Start the 50 ms RMS-sampling tick. Reads every active
  // analyser, computes RMS over the most-recent frame, and only
  // calls setState when the set of "speakers" actually changes —
  // so a quiet room won't re-render at all.
  const startSpeakingTick = useCallback(() => {
    if (speakingTickRef.current !== null) return;
    const tick = () => {
      const analysers = analysersRef.current;
      if (analysers.size === 0) {
        speakingTickRef.current = window.setTimeout(tick, 200);
        return;
      }
      let bufLen = 0;
      for (const a of analysers.values()) {
        bufLen = Math.max(bufLen, a.fftSize);
      }
      let buf = analyserBufferRef.current;
      if (buf === null || buf.length < bufLen) {
        buf = new Float32Array(bufLen);
        analyserBufferRef.current = buf;
      }
      const next = new Set<string>();
      for (const [connId, analyser] of analysers) {
        // `getFloatTimeDomainData` writes -1..1 samples; RMS of
        // that gives a normalised loudness number we threshold.
        // The cast works around TS's stricter ArrayBuffer/SAB
        // generic discrimination in newer lib.dom typings — at
        // runtime the underlying buffer is always a plain
        // ArrayBuffer for arrays we allocate ourselves.
        analyser.getFloatTimeDomainData(
          buf.subarray(0, analyser.fftSize) as Float32Array<ArrayBuffer>,
        );
        let sum = 0;
        for (let i = 0; i < analyser.fftSize; i += 1) {
          const v = buf[i] ?? 0;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / analyser.fftSize);
        if (rms > SPEAKING_RMS_THRESHOLD) next.add(connId);
      }
      // Diff against the previous set; only setState on change.
      const prev = speakingSetRef.current;
      let changed = prev.size !== next.size;
      if (!changed) {
        for (const id of next)
          if (!prev.has(id)) {
            changed = true;
            break;
          }
      }
      if (changed) {
        speakingSetRef.current = next;
        setSpeakingConnIds(next);
      }
      speakingTickRef.current = window.setTimeout(tick, 50);
    };
    speakingTickRef.current = window.setTimeout(tick, 50);
  }, []);

  const stopSpeakingTick = useCallback(() => {
    if (speakingTickRef.current !== null) {
      window.clearTimeout(speakingTickRef.current);
      speakingTickRef.current = null;
    }
    speakingSetRef.current = new Set();
    setSpeakingConnIds(new Set());
  }, []);

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
    if (ws?.readyState !== WebSocket.OPEN) return;
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
      // hand it to React state for the `<audio>` element to play
      // *and* wire it to an analyser so the active-speaker
      // indicator can light up this peer's avatar.
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? null;
        updatePeer(remoteConnId, { stream });
        if (stream !== null) {
          attachAnalyser(remoteConnId, stream);
        }
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
    [attachAnalyser, sendSignal, updatePeer],
  );

  const handleSignal = useCallback(
    async (
      from: string,
      payload: { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
    ) => {
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
    intentionalLeaveRef.current = true;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;

    for (const pc of pcsRef.current.values()) {
      pc.close();
    }
    pcsRef.current.clear();
    pendingIceRef.current.clear();

    // Drop every analyser and shut the AudioContext. Created
    // lazily on next join.
    for (const node of analysersRef.current.values()) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    analysersRef.current.clear();
    stopSpeakingTick();
    if (audioContextRef.current !== null) {
      void audioContextRef.current.close().catch(() => {
        /* ignore */
      });
      audioContextRef.current = null;
    }

    // Release the screen wake lock (mobile only — `null` on
    // unsupported platforms).
    if (wakeLockRef.current !== null) {
      void wakeLockRef.current.release().catch(() => {
        /* ignore */
      });
      wakeLockRef.current = null;
    }

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
  }, [stopSpeakingTick]);

  /** Open (or re-open) the signaling WS. Used both on first join and
   *  on automatic reconnect. Doesn't touch getUserMedia — the local
   *  stream from the original join is reused on reconnect so we
   *  don't re-prompt the user for the mic. */
  const openSignalingSocket = useCallback(async () => {
    if (projectId === null) return;
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
          readonly peers: readonly { readonly connId: string; readonly userId: string }[];
        };
        myConnIdRef.current = w.welcomeFor;
        // On reconnect, tear down any stale RTCPeerConnections —
        // the remote side sees us as a brand-new conn_id and we'll
        // re-handshake fresh.
        for (const pc of pcsRef.current.values()) pc.close();
        pcsRef.current.clear();
        for (const p of w.peers) {
          addPeer({ connId: p.connId, userId: p.userId, stream: null, muted: false });
          createPeerConnection(p.connId, true);
        }
        setState('live');
        reconnectAttemptRef.current = 0; // reset backoff on success
      } else if (msg.type === 'peerJoined') {
        const j = msg as ServerMsg & {
          readonly peer: { readonly connId: string; readonly userId: string };
        };
        addPeer({ connId: j.peer.connId, userId: j.peer.userId, stream: null, muted: false });
      } else if (msg.type === 'peerLeft') {
        const l = msg as ServerMsg & { readonly connId: string };
        const pc = pcsRef.current.get(l.connId);
        if (pc !== undefined) {
          pc.close();
          pcsRef.current.delete(l.connId);
        }
        detachAnalyser(l.connId);
        removePeer(l.connId);
      } else if (msg.type === 'signal') {
        const s = msg as ServerMsg & {
          readonly from: string;
          readonly payload: {
            kind: string;
            sdp?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
          };
        };
        void handleSignal(s.from, s.payload);
      } else if (msg.type === 'muted') {
        const m = msg as ServerMsg & { readonly connId: string; readonly muted: boolean };
        updatePeer(m.connId, { muted: m.muted });
      }
    };
    ws.onerror = () => {
      log.ws.warn('voice WS error');
    };
    ws.onclose = () => {
      // Drop stale RTCPeerConnections — they reference dead WS.
      for (const pc of pcsRef.current.values()) pc.close();
      pcsRef.current.clear();
      // If the user hung up, stop here.
      if (intentionalLeaveRef.current) return;
      if (wsRef.current !== ws) return; // a newer socket already took over
      // Schedule reconnect. Backoff caps at 30 s; we keep trying
      // forever — the user can always tap "hangup" to give up.
      const idx = Math.min(reconnectAttemptRef.current, RECONNECT_BACKOFF.length - 1);
      const delay = RECONNECT_BACKOFF[idx] ?? 30_000;
      reconnectAttemptRef.current += 1;
      setState('connecting');
      log.ws.warn('voice WS closed; reconnecting', { attempt: reconnectAttemptRef.current, delay });
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        void openSignalingSocket().catch((err: unknown) => {
          log.ws.error('voice WS reconnect failed', err);
        });
      }, delay);
    };
  }, [
    projectId,
    addPeer,
    createPeerConnection,
    detachAnalyser,
    handleSignal,
    removePeer,
    updatePeer,
  ]);

  const joinMic = useCallback(async () => {
    if (projectId === null) return;
    if (state === 'live' || state === 'connecting') return;
    setState('connecting');
    setError(null);
    intentionalLeaveRef.current = false;
    reconnectAttemptRef.current = 0;
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
      // Wire the local stream into the analyser graph so the
      // active-speaker indicator can highlight YOU when you're
      // talking, not just other peers.
      attachAnalyser('local', stream);
      startSpeakingTick();

      // Request a screen wake lock so a mobile screen-off doesn't
      // suspend the connection. Silently ignored on platforms that
      // don't support the API (older Safari, Firefox desktop).
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
        };
        if (nav.wakeLock !== undefined) {
          wakeLockRef.current = await nav.wakeLock.request('screen');
        }
      } catch (err) {
        log.ws.warn('wake-lock request failed', err);
      }

      await openSignalingSocket();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setError(msg);
      setState('error');
      teardown();
    }
  }, [
    projectId,
    state,
    micEnabled,
    attachAnalyser,
    openSignalingSocket,
    startSpeakingTick,
    teardown,
  ]);

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
  useEffect(
    () => () => {
      teardown();
    },
    [teardown, projectId],
  );

  return {
    state,
    peers,
    micEnabled,
    speakerEnabled,
    error,
    speakingConnIds,
    localSpeaking: speakingConnIds.has('local'),
    joinMic,
    leaveMic,
    setMicEnabled,
    setSpeakerEnabled,
  };
}
