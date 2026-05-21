import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();

// Replace handle_new_project with one that logs what role it sees.
await c.query(`
  create or replace function public.handle_new_project() returns trigger
    language plpgsql security definer set search_path to public
  as $fn$
  begin
    raise notice 'handle_new_project: current_user=%, session_user=%, auth.uid()=%', current_user, session_user, auth.uid();
    insert into public.project_members (project_id, user_id, role, invite_accepted_at)
    values (new.id, new.owner_id, 'owner', now());
    return new;
  end;
  $fn$;
`);

await c.query("set role authenticated");
const userId = '05a147f9-3d78-4216-80fe-764f38a6078a';
await c.query(`set request.jwt.claims to '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`);

c.on('notice', (n) => console.log('NOTICE:', n.message));

try {
  const r = await c.query("insert into public.projects (name, owner_id, template, compiler) values ('Diag', $1::uuid, 'article', 'tectonic') returning id", [userId]);
  console.log('insert OK', r.rows);
} catch (e) {
  console.log('insert FAIL', e.message);
}

await c.end();
