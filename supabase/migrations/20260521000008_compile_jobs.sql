-- Compile jobs: one row per compile attempt. The BullMQ worker writes
-- status, exit code, artifact storage keys, and parsed log entries.

create table public.compile_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  triggered_by uuid references public.users(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'success', 'error', 'cancelled')),
  engine text not null
    check (engine in ('tectonic', 'pdflatex', 'xelatex', 'lualatex')),
  main_file text not null,
  exit_code integer,
  pdf_key text,
  log_key text,
  synctex_key text,
  error_message text,
  entries jsonb,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index compile_jobs_project_id_idx
  on public.compile_jobs (project_id, enqueued_at desc);

create index compile_jobs_status_idx
  on public.compile_jobs (status)
  where status in ('queued', 'running');

-- Retention trigger: when a new job for project X is inserted, prune the
-- oldest jobs beyond N (configurable via MAX_COMPILE_ARTIFACTS_PER_PROJECT
-- env on the server side; here we keep the default of 10 hard-coded).
create or replace function public.prune_compile_jobs() returns trigger as $$
declare
  retain_count constant integer := 10;
begin
  delete from public.compile_jobs
   where project_id = new.project_id
     and id not in (
       select id from public.compile_jobs
        where project_id = new.project_id
        order by enqueued_at desc
        limit retain_count
     );
  return new;
end;
$$ language plpgsql security definer;

create trigger compile_jobs_prune
  after insert on public.compile_jobs
  for each row
  execute function public.prune_compile_jobs();

-- RLS: members read their project's jobs; only the service role inserts/updates.
alter table public.compile_jobs enable row level security;

create policy "compile_jobs_select_member"
  on public.compile_jobs for select
  using (public.is_project_member(project_id, auth.uid()));

create policy "compile_jobs_insert_member"
  on public.compile_jobs for insert
  with check (public.is_project_member(project_id, auth.uid()));
