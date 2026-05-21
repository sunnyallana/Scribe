import { Avatar, AvatarFallback, AvatarImage } from '@scribe/ui';
import { useTranslation } from 'react-i18next';

import type { PresenceUser } from '@scribe/yjs-provider';

interface PresenceAvatarsProps {
  readonly peers: readonly PresenceUser[];
  readonly localUser?: PresenceUser | null;
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function PresenceDot({ user }: { readonly user: PresenceUser }) {
  return (
    <Avatar
      className="h-7 w-7 ring-2 ring-background"
      style={{ borderColor: user.color }}
      title={user.displayName}
    >
      <AvatarImage src="" alt="" />
      <AvatarFallback
        className="text-[10px] font-semibold"
        style={{ backgroundColor: user.color, color: '#fff' }}
      >
        {initialsFor(user.displayName)}
      </AvatarFallback>
    </Avatar>
  );
}

export function PresenceAvatars({ peers, localUser }: PresenceAvatarsProps) {
  const { t } = useTranslation();
  if (peers.length === 0 && localUser === null) return null;
  return (
    <div className="flex items-center -space-x-2" aria-label={t('collab.presenceLabel')}>
      {localUser !== null && localUser !== undefined ? <PresenceDot user={localUser} /> : null}
      {peers.map((peer) => (
        <PresenceDot key={peer.userId} user={peer} />
      ))}
    </div>
  );
}
