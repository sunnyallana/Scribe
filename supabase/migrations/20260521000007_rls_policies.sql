-- ============================================================
-- Row Level Security policies for all public.* tables and storage.
-- All policies in one file for auditability.
-- ============================================================

-- ---------- public.users ----------
alter table public.users enable row level security;

create policy "users_select_self"
  on public.users for select
  using (auth.uid() = id);

create policy "users_update_self"
  on public.users for update
  using (auth.uid() = id);

-- ---------- public.projects ----------
alter table public.projects enable row level security;

-- Owner is always visible to themselves so INSERT ... RETURNING works
-- before the AFTER trigger has populated project_members.
create policy "projects_select_member_or_public"
  on public.projects for select
  using (
    is_public
    or owner_id = auth.uid()
    or public.is_project_member(id, auth.uid())
  );

create policy "projects_insert_self_owner"
  on public.projects for insert
  with check (auth.uid() = owner_id);

create policy "projects_update_owner"
  on public.projects for update
  using (public.my_project_role(id) = 'owner');

create policy "projects_delete_owner"
  on public.projects for delete
  using (auth.uid() = owner_id);

-- ---------- public.project_members ----------
alter table public.project_members enable row level security;

-- Members can read their own membership rows AND any membership row of a
-- project they belong to (to see collaborators).
create policy "project_members_select"
  on public.project_members for select
  using (
    user_id = auth.uid()
    or public.is_project_member(project_id, auth.uid())
  );

create policy "project_members_insert_owner"
  on public.project_members for insert
  with check (public.my_project_role(project_id) = 'owner');

create policy "project_members_update_owner"
  on public.project_members for update
  using (public.my_project_role(project_id) = 'owner');

create policy "project_members_delete_owner_or_self"
  on public.project_members for delete
  using (
    public.my_project_role(project_id) = 'owner'
    or user_id = auth.uid()
  );

-- ---------- public.project_files ----------
alter table public.project_files enable row level security;

create policy "project_files_select_member"
  on public.project_files for select
  using (public.is_project_member(project_id, auth.uid()));

create policy "project_files_insert_editor_or_owner"
  on public.project_files for insert
  with check (public.my_project_role(project_id) in ('owner', 'editor'));

create policy "project_files_update_editor_or_owner"
  on public.project_files for update
  using (public.my_project_role(project_id) in ('owner', 'editor'));

create policy "project_files_delete_editor_or_owner"
  on public.project_files for delete
  using (public.my_project_role(project_id) in ('owner', 'editor'));

-- ---------- storage.objects ----------
-- Storage keys are namespaced by project id: <project_id>/<rest>
-- We extract the project id from the first path segment.

create policy "storage_project_files_select"
  on storage.objects for select
  using (
    bucket_id = 'project-files'
    and public.is_project_member(
      (storage.foldername(name))[1]::uuid,
      auth.uid()
    )
  );

create policy "storage_project_files_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'project-files'
    and public.my_project_role((storage.foldername(name))[1]::uuid)
      in ('owner', 'editor')
  );

create policy "storage_project_files_update"
  on storage.objects for update
  using (
    bucket_id = 'project-files'
    and public.my_project_role((storage.foldername(name))[1]::uuid)
      in ('owner', 'editor')
  );

create policy "storage_project_files_delete"
  on storage.objects for delete
  using (
    bucket_id = 'project-files'
    and public.my_project_role((storage.foldername(name))[1]::uuid)
      in ('owner', 'editor')
  );

-- Compile artifacts: members read, only service role writes.
create policy "storage_compile_artifacts_select"
  on storage.objects for select
  using (
    bucket_id = 'compile-artifacts'
    and public.is_project_member(
      (storage.foldername(name))[1]::uuid,
      auth.uid()
    )
  );

-- Version snapshots: members read and write (snapshots are taken from the
-- client through the user-context Supabase client).
create policy "storage_version_snapshots_select"
  on storage.objects for select
  using (
    bucket_id = 'version-snapshots'
    and public.is_project_member(
      (storage.foldername(name))[1]::uuid,
      auth.uid()
    )
  );

create policy "storage_version_snapshots_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'version-snapshots'
    and public.is_project_member(
      (storage.foldername(name))[1]::uuid,
      auth.uid()
    )
  );

-- Template thumbnails: world readable (bucket is public anyway).
create policy "storage_template_thumbnails_select"
  on storage.objects for select
  using (bucket_id = 'template-thumbnails');
