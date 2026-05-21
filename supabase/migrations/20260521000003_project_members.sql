create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,
  invited_email text,
  role text not null check (role in ('owner', 'editor', 'commenter', 'viewer')),
  invite_token text unique,
  invited_at timestamptz not null default now(),
  invite_expires_at timestamptz not null default (now() + interval '7 days'),
  invite_accepted_at timestamptz,
  invited_by uuid references public.users(id) on delete set null,

  constraint user_or_email check (user_id is not null or invited_email is not null)
);

create index project_members_project_id_idx on public.project_members (project_id);
create index project_members_user_id_idx on public.project_members (user_id)
  where user_id is not null;
create unique index project_members_unique_user_per_project
  on public.project_members (project_id, user_id)
  where user_id is not null;
create unique index project_members_unique_pending_invite
  on public.project_members (project_id, lower(invited_email))
  where user_id is null and invite_accepted_at is null;

-- Owner is auto-added as a project_member on project creation.
create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role, invite_accepted_at)
  values (new.id, new.owner_id, 'owner', now());
  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row
  execute function public.handle_new_project();
