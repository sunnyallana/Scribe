-- Yjs binary updates. One row per update; the server compacts them on a
-- schedule into a single "snapshot" row (clock = 0 in our convention).
-- update_data is base64-encoded so PostgREST returns it as a plain string
-- the server can decode without dealing with hex-prefixed bytea.

create table public.yjs_updates (
  id bigserial primary key,
  doc_id text not null,
  update_data text not null,
  clock integer not null default 0,
  created_at timestamptz not null default now()
);

create index yjs_updates_doc_id_idx
  on public.yjs_updates (doc_id, created_at);

create index yjs_updates_doc_clock_idx
  on public.yjs_updates (doc_id, clock);

-- doc_id is conventionally `<project_id>/<file_id>`; we extract the project
-- id from the first segment for RLS.
create or replace function public.yjs_doc_project_id(p_doc_id text) returns uuid as $$
  select (split_part(p_doc_id, '/', 1))::uuid;
$$ language sql immutable;

alter table public.yjs_updates enable row level security;

-- Members can read their project's updates.
create policy "yjs_updates_select_member"
  on public.yjs_updates for select
  using (
    public.is_project_member(public.yjs_doc_project_id(doc_id), auth.uid())
  );

-- Inserts via service role only — the Fastify server writes them.
create policy "yjs_updates_service_insert"
  on public.yjs_updates for insert
  with check (true);
