-- Inline comments on a project file. anchor_line is best-effort; the source
-- of truth for "what this points at" is `body` + nearby context. Yjs-based
-- stable anchors are a future improvement.

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  file_id uuid references public.project_files(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  author_id uuid not null references public.users(id) on delete cascade,
  anchor_line integer,
  anchor_column integer,
  body text not null check (length(body) <= 4000),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index comments_project_id_idx on public.comments (project_id, created_at);
create index comments_file_id_idx on public.comments (file_id);
create index comments_parent_id_idx on public.comments (parent_id);

create trigger comments_set_updated_at
  before update on public.comments
  for each row
  execute function public.set_updated_at();

alter table public.comments enable row level security;

create policy "comments_select_member"
  on public.comments for select
  using (public.is_project_member(project_id, auth.uid()));

create policy "comments_insert_member"
  on public.comments for insert
  with check (
    public.is_project_member(project_id, auth.uid())
    and author_id = auth.uid()
  );

create policy "comments_update_author_or_owner"
  on public.comments for update
  using (
    author_id = auth.uid()
    or public.my_project_role(project_id) = 'owner'
  );

create policy "comments_delete_author_or_owner"
  on public.comments for delete
  using (
    author_id = auth.uid()
    or public.my_project_role(project_id) = 'owner'
  );
