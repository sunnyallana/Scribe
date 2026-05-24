import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();

await c.query("drop policy if exists projects_select_member_or_public on public.projects");
await c.query(`create policy projects_select_member_or_public on public.projects for select using (
  is_public or owner_id = auth.uid() or public.is_project_member(id, auth.uid())
)`);
console.log('projects SELECT policy now allows owner_id = auth.uid()');

// Verify
const u = await c.query("select pg_get_expr(polqual, polrelid) as q from pg_policy where polrelid='public.projects'::regclass and polname='projects_select_member_or_public'");
console.log('new policy:', u.rows);

// Now insert again to confirm
const userId = '05a147f9-3d78-4216-80fe-764f38a6078a';
await c.query("set role authenticated");
await c.query(`set request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`);
try {
  const r = await c.query("insert into public.projects (name, owner_id, template, compiler) values ('AfterFix', $1::uuid, 'article', 'tectonic') returning id, owner_id", [userId]);
  console.log('insert OK', r.rows);
} catch (e) {
  console.log('insert FAIL', e.message);
}

await c.end();
