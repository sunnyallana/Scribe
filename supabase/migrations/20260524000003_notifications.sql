-- Notification inbox. One row per delivered event (mention, reply,
-- share-redeemed, invite-accepted). The bell-icon dropdown in the
-- web app queries this table; toasts that vanish are replaced by
-- persistent entries here.
--
-- `payload` is a free-form jsonb blob — different notification kinds
-- store different fields (project_id, comment_id, sender_id, etc.).
-- The frontend resolves the kind + payload to a navigation target
-- and a localised summary string.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('mention', 'comment_reply', 'invite_accepted', 'share_redeemed')),
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Hot-path indexes: list newest-first per user, and a partial index
-- for the unread-count badge query (small, fits in cache).
create index notifications_user_recent_idx
  on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;
