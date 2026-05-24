import { Button } from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useVoiceRoom, type VoiceRoomHandle } from '../../hooks/useVoiceRoom';
import { api } from '../../lib/api';

import type { ProjectId } from '@scribe/shared';

interface VoiceControlsProps {
  readonly projectId: ProjectId;
}

/**
 * Voice toolbar — a single call icon by default; clicking it joins
 * the room and reveals the mic + speaker controls inline. Clicking
 * the call icon again leaves the room and collapses everything
 * back to the single button.
 *
 * Idle state          →  [📞]
 * Connecting          →  [⌛]
 * Live (in call)      →  [📵 hangup]  [🎙 mic]  [🔊 speaker]
 *
 * • The call icon itself is the join/leave control — clicking it
 *   while in the call hangs up. This is the universal phone-icon
 *   pattern (Zoom, Meet, Discord) and avoids duplicate buttons.
 * • Mic toggles MUTE while in the call (it never joins/leaves).
 * • Speaker toggles incoming-audio master mute, always available.
 */
export function VoiceControls({ projectId }: VoiceControlsProps) {
  const { t } = useTranslation();
  const voice = useVoiceRoom(projectId);
  const inRoom = voice.state === 'live' || voice.state === 'connecting';
  const live = voice.state === 'live';

  // Poll the project's voice room snapshot so users NOT in the call
  // can still see "someone is on the call". Refetch every 5 s when
  // idle — that's snappy enough that a tab-switch tells you who's
  // talking, but light on the API. When we're in the call ourselves
  // the WS already broadcasts joins/leaves to us in real time, so
  // pause polling.
  const peersQuery = useQuery({
    queryKey: ['voice-peers', projectId],
    queryFn: () => api.voice.peers(projectId),
    refetchInterval: inRoom ? false : 5000,
    refetchIntervalInBackground: false,
    staleTime: 4000,
  });

  // Effective count of *other* people on the call. When we're in
  // the call ourselves, trust the local mesh state (real-time);
  // otherwise use the polled snapshot.
  const othersOnCall = inRoom ? voice.peers.length : (peersQuery.data?.peers.length ?? 0);

  // Active-speaker awareness: anyone currently transmitting voice.
  // Drives a soft emerald ring on the call button so the user sees
  // "voice is flowing" without watching avatars. We only count
  // *remote* speakers here — the local pulse-dot below already
  // signals self-transmission.
  const remoteSpeaking = (() => {
    if (!live) return false;
    for (const id of voice.speakingConnIds) {
      if (id !== 'local') return true;
    }
    return false;
  })();

  // Call button click → toggle membership. In `connecting` we
  // ignore clicks to avoid mid-flight cancellation races.
  const onCallClick = () => {
    if (voice.state === 'connecting') return;
    if (inRoom) {
      voice.leaveMic();
    } else {
      void voice.joinMic();
    }
  };

  // What the call button looks like depends on the three states.
  // `live` flips it into `PhoneOff` (red) — same icon language as
  // every other VoIP app's hangup button.
  let CallIcon = Phone;
  let callIconClass = 'h-3.5 w-3.5';
  let callLabel = t('voice.joinAndSpeak');
  if (voice.state === 'connecting') {
    callLabel = t('voice.connecting');
  } else if (live) {
    CallIcon = PhoneOff;
    callIconClass = 'h-3.5 w-3.5 text-destructive';
    callLabel = t('voice.leave');
  }

  return (
    <>
      {/* The single call icon — collapsed entry point. */}
      <Button
        variant={live ? 'default' : 'ghost'}
        size="icon"
        className={`relative h-7 w-7 transition-shadow ${
          remoteSpeaking ? 'ring-2 ring-emerald-400 ring-offset-1 ring-offset-background' : ''
        }`}
        // Tooltip carries the "N on call" hint too, so hovering
        // the icon (even when we're not in the room) tells you
        // exactly who/how-many to expect when you join.
        aria-label={
          othersOnCall > 0 && !inRoom
            ? `${callLabel} — ${t('voice.othersOnCall', { count: othersOnCall })}`
            : callLabel
        }
        title={
          othersOnCall > 0 && !inRoom
            ? `${callLabel} — ${t('voice.othersOnCall', { count: othersOnCall })}`
            : callLabel
        }
        onClick={onCallClick}
        disabled={voice.state === 'connecting'}
      >
        {voice.state === 'connecting' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <CallIcon className={callIconClass} aria-hidden="true" />
        )}
        {/* Live + unmuted indicator — small pulsing emerald dot on
            the call button so the user can see "I'm transmitting"
            at a glance even without looking at the mic icon. The
            dot brightens + grows when your voice is actually
            crossing the speaking threshold, giving a continuous
            mic-level cue. */}
        {live && voice.micEnabled ? (
          <span
            aria-hidden="true"
            className={`absolute -right-0.5 -top-0.5 rounded-full transition-all ${
              voice.localSpeaking
                ? 'h-2 w-2 bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]'
                : 'h-1.5 w-1.5 animate-pulse bg-emerald-500'
            }`}
          />
        ) : null}
        {/* Active-call count badge — visible whenever someone else
            is in the room, both for non-participants (so they know
            to join) and for participants (live peer count). The
            position differs slightly from the pulse dot above so
            both can be on the button without overlap. */}
        {othersOnCall > 0 && !(live && !voice.micEnabled) ? (
          <span
            aria-hidden="true"
            className={`absolute -right-1 -top-1 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none text-white ${
              live ? 'bg-emerald-600' : 'bg-emerald-500 animate-pulse'
            }`}
          >
            {othersOnCall > 9 ? '9+' : othersOnCall}
          </span>
        ) : null}
      </Button>

      {/* Mic + Speaker only appear while in the call. Tailwind's
          built-in animation primitives give a clean slide-in
          without any state-machine bookkeeping. */}
      {live ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 animate-in fade-in slide-in-from-left-2 duration-150"
            aria-label={voice.micEnabled ? t('voice.muteMic') : t('voice.unmuteMic')}
            title={voice.micEnabled ? t('voice.muteMic') : t('voice.unmuteMic')}
            onClick={() => {
              voice.setMicEnabled(!voice.micEnabled);
            }}
          >
            {voice.micEnabled ? (
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <MicOff className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 animate-in fade-in slide-in-from-left-2 duration-150"
            aria-label={voice.speakerEnabled ? t('voice.muteSpeaker') : t('voice.unmuteSpeaker')}
            title={voice.speakerEnabled ? t('voice.muteSpeaker') : t('voice.unmuteSpeaker')}
            onClick={() => {
              voice.setSpeakerEnabled(!voice.speakerEnabled);
            }}
          >
            {voice.speakerEnabled ? (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
            )}
          </Button>
        </>
      ) : null}

      <RemoteStreams voice={voice} />
    </>
  );
}

/**
 * Renders one hidden `<audio autoplay>` per remote peer. The
 * speaker-mute global flag is enforced by toggling `muted` on every
 * element. We intentionally don't render any visible UI here —
 * presence avatars elsewhere already indicate who's in the room.
 */
function RemoteStreams({ voice }: { readonly voice: VoiceRoomHandle }) {
  return (
    <>
      {voice.peers.map((peer) =>
        peer.stream !== null ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- live-conference audio has no caption track to attach
          <audio
            key={peer.connId}
            ref={(el) => {
              if (el !== null && el.srcObject !== peer.stream) {
                el.srcObject = peer.stream;
              }
            }}
            autoPlay
            muted={!voice.speakerEnabled}
          />
        ) : null,
      )}
    </>
  );
}
