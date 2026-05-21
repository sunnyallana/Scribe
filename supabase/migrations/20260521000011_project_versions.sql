-- Project version snapshots. Metadata only; the actual file contents are
-- stored in the `version-snapshots` Storage bucket as a single JSON object
-- per version (small projects only, which is the v1 scope).

create table public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references public.users(id) on delete set null,
  label text,
  storage_key text not null,
  file_count integer not null default 0,
  total_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

create index project_versions_project_id_idx
  on public.project_versions (project_id, created_at desc);

alter table public.project_versions enable row level security;

create policy "project_versions_select_member"
  on public.project_versions for select
  using (public.is_project_member(project_id, auth.uid()));

create policy "project_versions_insert_member"
  on public.project_versions for insert
  with check (public.is_project_member(project_id, auth.uid()));

create policy "project_versions_delete_owner"
  on public.project_versions for delete
  using (public.my_project_role(project_id) = 'owner');
