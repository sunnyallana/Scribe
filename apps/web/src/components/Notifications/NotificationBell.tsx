import { type Notification } from '@scribe/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, CheckCheck, MessageSquare, UserCheck, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { api } from '../../lib/api';

/**
 * Bell icon + unread count badge + dropdown with the user's
 * recent notifications. Clicking a notification marks it read and
 * navigates to the source (project, comment, etc.).
 *
 * Polls the unread count every 30 s — short enough to feel live,
 * cheap enough not to burn battery on background tabs.
 */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const countQuery = useQuery({
    queryKey: ['notifications-unread-count'],
    queryFn: () => api.notifications.unreadCount(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 25_000,
  });

  const listQuery = useQuery({
    queryKey: ['notifications-list'],
    queryFn: () => api.notifications.list({ limit: 20 }),
    // Only fetch the full list when the dropdown is open; we
    // disable + manually invalidate from the open handler below.
    enabled: false,
    staleTime: 0,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications-list'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications-list'] });
    },
  });

  const onOpenChange = (open: boolean) => {
    if (open) void listQuery.refetch();
  };

  const onClickNotification = (n: Notification) => {
    if (n.readAt === null) markRead.mutate(n.id);
    const projectId = n.payload.projectId;
    if (typeof projectId === 'string' && projectId !== '') {
      void navigate(`/project/${projectId}`);
    }
  };

  const unread = countQuery.data?.count ?? 0;
  const notifications = listQuery.data ?? [];

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-7 w-7"
          aria-label={t('notifications.openInbox')}
          title={t('notifications.openInbox')}
        >
          <Bell className="h-3.5 w-3.5" aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold leading-none text-white"
            >
              {unread > 9 ? '9+' : unread.toString()}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <h3 className="text-sm font-semibold">{t('notifications.title')}</h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 text-[10px]"
            onClick={() => { markAllRead.mutate(); }}
            disabled={markAllRead.isPending || unread === 0}
            title={t('notifications.markAllRead')}
          >
            <CheckCheck className="h-3 w-3" aria-hidden="true" />
            {t('notifications.markAllRead')}
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('notifications.empty')}
            </p>
          ) : (
            <ul>
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => { onClickNotification(n); }}
                    className={`flex w-full gap-2.5 px-3 py-2 text-left hover:bg-muted/50 ${
                      n.readAt === null ? 'bg-muted/20' : ''
                    }`}
                  >
                    <NotificationIcon kind={n.kind} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-snug">
                        <NotificationBody n={n} />
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {formatRelative(n.createdAt)}
                      </p>
                    </div>
                    {n.readAt === null ? (
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationIcon({ kind }: { readonly kind: Notification['kind'] }) {
  let Icon = Bell;
  let cls = 'text-muted-foreground';
  switch (kind) {
    case 'mention':
      Icon = AtSign;
      cls = 'text-blue-500';
      break;
    case 'comment_reply':
      Icon = MessageSquare;
      cls = 'text-emerald-500';
      break;
    case 'invite_accepted':
      Icon = UserCheck;
      cls = 'text-violet-500';
      break;
    case 'share_redeemed':
      Icon = UserPlus;
      cls = 'text-amber-500';
      break;
  }
  return (
    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted/60 ${cls}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

function NotificationBody({ n }: { readonly n: Notification }) {
  const { t } = useTranslation();
  const actor = typeof n.payload.actorName === 'string' ? n.payload.actorName : t('notifications.someone');
  const project = typeof n.payload.projectName === 'string' ? n.payload.projectName : t('notifications.aProject');
  const snippet = typeof n.payload.snippet === 'string' ? n.payload.snippet : '';
  const role = typeof n.payload.role === 'string' ? n.payload.role : '';
  switch (n.kind) {
    case 'mention':
      return (
        <>
          <strong>{actor}</strong> {t('notifications.mentionedYou', { project })}
          {snippet !== '' ? <span className="block text-[10px] text-muted-foreground">“{snippet}”</span> : null}
        </>
      );
    case 'comment_reply':
      return (
        <>
          <strong>{actor}</strong> {t('notifications.repliedToYou', { project })}
          {snippet !== '' ? <span className="block text-[10px] text-muted-foreground">“{snippet}”</span> : null}
        </>
      );
    case 'invite_accepted':
      return <><strong>{actor}</strong> {t('notifications.acceptedInvite', { project })}</>;
    case 'share_redeemed':
      return <><strong>{actor}</strong> {t('notifications.joinedViaShare', { project, role })}</>;
  }
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const ms = Date.now() - t;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m.toString()}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h.toString()}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d.toString()}d`;
  return new Date(iso).toLocaleDateString();
}
