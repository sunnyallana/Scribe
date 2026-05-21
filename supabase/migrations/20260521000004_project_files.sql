create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null,
  type text not null check (type in ('tex', 'bib', 'image', 'other')),
  storage_key text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, path)
);

create index project_files_project_id_idx on public.project_files (project_id);
create index project_files_project_path_idx on public.project_files (project_id, path);

create trigger project_files_set_updated_at
  before update on public.project_files
  for each row
  execute function public.set_updated_at();
