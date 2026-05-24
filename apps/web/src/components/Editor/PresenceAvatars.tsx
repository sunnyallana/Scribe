import { Avatar, AvatarFallback, AvatarImage } from '@scribe/ui';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresenceUser } from '@scribe/yjs-provider';

interface PresenceAvatarsProps {
  readonly peers: readonly PresenceUser[];
  readonly localUser?: PresenceUser | null;
  /** Total avatars shown before collapsing into "+N". Counts the local
   *  user. Defaults to 3 (the conventional cap in Docs/Overleaf). */
  readonly maxVisible?: number;
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

function PresenceDot({
  user,
  tabCount,
}: {
  readonly user: PresenceUser;
  /** Number of awareness connections we collapsed into this single
   *  avatar. >1 means the user has the doc open in multiple tabs /
   *  browsers — we surface that via the tooltip but the avatar
   *  itself stays single (matches Google Docs / Overleaf behaviour). */
  readonly tabCount?: number;
}) {
  const showTabBadge = tabCount !== undefined && tabCount > 1;
  const titleText = showTabBadge
    ? `${user.displayName} (${tabCount.toString()} tabs)`
    : user.displayName;
  return (
    <div className="relative">
      <Avatar
        className="h-7 w-7 ring-2 ring-background"
        style={{ borderColor: user.color }}
        title={titleText}
      >
        <AvatarImage src="" alt="" />
        <AvatarFallback
          className="text-[10px] font-semibold"
          style={{ backgroundColor: user.color, color: '#fff' }}
        >
          {initialsFor(user.displayName)}
        </AvatarFallback>
      </Avatar>
      {/* Tiny multi-tab indicator — a subtle dot on the corner, not a
          loud "(2)" pill. Reads as "this user has the doc open more
          than once" without being noisy. */}
      {showTabBadge ? (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background"
          style={{ backgroundColor: user.color }}
        />
      ) : null}
    </div>
  );
}

function OverflowDot({
  count,
  hiddenNames,
}: {
  readonly count: number;
  readonly hiddenNames: readonly string[];
}) {
  // Tooltip listing the collapsed names so a glance reveals who else is
  // on the doc. Native `title` keeps the dependency footprint zero —
  // we don't need a Radix Tooltip just for this.
  const tooltip = hiddenNames.join('\n');
  return (
    <Avatar
      className="h-7 w-7 ring-2 ring-background"
      title={tooltip}
      aria-label={`+${count.toString()} more`}
    >
      <AvatarFallback className="bg-muted text-[10px] font-semibold text-foreground">
        +{count}
      </AvatarFallback>
    </Avatar>
  );
}

export function PresenceAvatars({
  peers,
  localUser,
  maxVisible = 3,
}: PresenceAvatarsProps) {
  const { t } = useTranslation();

  // Yjs's awareness has one entry per WebSocket connection (clientID),
  // so the same user with the project open in two tabs shows up as
  // two `peers`. Dedupe by `userId` here — same convention as Google
  // Docs / Overleaf — and track tab count so we can hint at it on
  // the avatar. We also drop any peer entry that matches the local
  // user's own userId in case the provider's local-clientID filter
  // misses a stale state during reconnect.
  const dedupedPeers = useMemo(() => {
    const byUser = new Map<string, { user: PresenceUser; count: number }>();
    for (const p of peers) {
      // A stale awareness state from our own previous connection can
      // briefly look like a peer entry with the same userId. Drop it.
      if (p.userId === localUser?.userId) {
        continue;
      }
      const existing = byUser.get(p.userId);
      if (existing === undefined) {
        byUser.set(p.userId, { user: p, count: 1 });
      } else {
        existing.count += 1;
      }
    }
    return Array.from(byUser.values());
  }, [peers, localUser]);

  if (dedupedPeers.length === 0 && (localUser === null || localUser === undefined)) return null;

  // Local user always takes one of the visible slots (you should always
  // see yourself). Peers fill the rest; the remainder collapses into a
  // single +N chip.
  const localTaken = localUser !== null && localUser !== undefined ? 1 : 0;
  const peersBudget = Math.max(0, maxVisible - localTaken);
  const visiblePeers = dedupedPeers.slice(0, peersBudget);
  const hiddenPeers = dedupedPeers.slice(peersBudget);
  return (
    <div className="flex items-center -space-x-2" aria-label={t('collab.presenceLabel')}>
      {localUser !== null && localUser !== undefined ? <PresenceDot user={localUser} /> : null}
      {visiblePeers.map(({ user, count }) => (
        <PresenceDot key={user.userId} user={user} tabCount={count} />
      ))}
      {hiddenPeers.length > 0 ? (
        <OverflowDot
          count={hiddenPeers.length}
          hiddenNames={hiddenPeers.map((p) => p.user.displayName)}
        />
      ) : null}
    </div>
  );
}
