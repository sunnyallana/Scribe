import pg from 'pg';
const c = new pg.Client({
  host: 'aws-1-ap-southeast-2.pooler.supabase.com',
  port: 5432,
  user: 'postgres.sgmbvxqgowbpyehwmedv',
  password: 'Oc16OInTHRrvU5wu',
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const userId = '05a147f9-3d78-4216-80fe-764f38a6078a';

await c.query('set role authenticated');
await c.query(
  `set request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`,
);

// Replace policy with one that RAISES the actual auth.uid() and owner_id values
await c.query('reset role');
await c.query(`
  create or replace function public.dbg_insert_check(uid uuid, own uuid) returns boolean
    language plpgsql
  as $fn$ begin
    raise notice 'WITH CHECK eval: auth.uid()=%, owner_id=%, equal=%', uid, own, (uid = own);
    return uid = own;
  end; $fn$;
`);
await c.query('drop policy if exists projects_insert_self_owner on public.projects');
await c.query(
  'create policy projects_insert_self_owner on public.projects for insert with check (public.dbg_insert_check(auth.uid(), owner_id))',
);

c.on('notice', (n) => console.log('NOTICE:', n.message));

await c.query('set role authenticated');
await c.query(
  `set request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`,
);

try {
  const r = await c.query(
    "insert into public.projects (name, owner_id, template, compiler) values ('Trace', $1::uuid, 'article', 'tectonic') returning id",
    [userId],
  );
  console.log('insert OK', r.rows);
} catch (e) {
  console.log('insert FAIL', e.message);
}

// Restore original policy
await c.query('reset role');
await c.query('drop policy if exists projects_insert_self_owner on public.projects');
await c.query(
  'create policy projects_insert_self_owner on public.projects for insert with check (auth.uid() = owner_id)',
);
await c.query('drop function if exists public.dbg_insert_check(uuid, uuid)');
console.log('restored original policy');

await c.end();
