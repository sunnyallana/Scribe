create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0 and length(name) <= 200),
  description text,
  owner_id uuid not null references public.users(id) on delete cascade,
  template text not null default 'blank',
  compiler text not null default 'tectonic'
    check (compiler in ('tectonic', 'pdflatex', 'xelatex', 'lualatex')),
  main_file text not null default 'main.tex',
  is_public boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_owner_id_idx on public.projects (owner_id);
create index projects_updated_at_idx on public.projects (updated_at desc);

create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();
