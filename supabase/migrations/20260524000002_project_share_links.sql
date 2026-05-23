-- Shareable project links — opaque tokens the owner can hand out so
-- collaborators can join the project without an emailed invite. The
-- redeem flow inserts a `project_members` row (de-duplicated per user
-- via the existing unique index), so once redeemed the visitor is a
-- first-class member and the rest of the app keeps working as-is.
--
-- v1 deliberately constrains role to 'viewer' or 'commenter' — sharing
-- editor access via link bypasses owner approval, which we want to
-- gate behind explicit per-email invites for now.

create table public.project_share_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  token text not null unique,
  role text not null check (role in ('viewer', 'commenter')),
  created_by uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Null = never expires (owner can still revoke). When set, the
  -- redeem endpoint rejects after the timestamp.
  expires_at timestamptz,
  revoked_at timestamptz
);

create index project_share_links_project_id_idx
  on public.project_share_links (project_id);
create index project_share_links_active_idx
  on public.project_share_links (project_id, created_at desc)
  where revoked_at is null;
