import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();

const userId = '05a147f9-3d78-4216-80fe-764f38a6078a';

// Method 1: Set JWT claims via the canonical method
await c.query("begin");
await c.query("set local role authenticated");
await c.query(`set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' })}'`);

const directCheck = await c.query("select auth.uid() = $1::uuid as match", [userId]);
console.log('direct match:', directCheck.rows);

// Use a SAVEPOINT so the error doesn't abort the tx
try {
  await c.query("savepoint sp1");
  // Use raw SQL with values inlined (no parameters) to rule out parameter-binding issues
  const r = await c.query(`insert into public.projects (name, owner_id, template, compiler) values ('LiteralTest', '${userId}', 'article', 'tectonic') returning id, owner_id, auth.uid() as uid_at_insert`);
  console.log('insert OK', r.rows);
} catch (e) {
  console.log('insert FAIL', e.message);
  console.log('  detail:', e.detail, 'hint:', e.hint, 'schema:', e.schema, 'table:', e.table);
  await c.query("rollback to savepoint sp1");
}

// Now check the WITH CHECK clause in isolation
const polCheck = await c.query("select polname, polcmd, pg_get_expr(polqual, polrelid) as q, pg_get_expr(polwithcheck, polrelid) as wc from pg_policy where polrelid='public.projects'::regclass and polcmd='a'");
console.log('insert policy:', polCheck.rows);

// Check if there are any policies that might be PERMISSIVE FALSE
const allPol = await c.query("select polname, polpermissive, polcmd from pg_policy where polrelid='public.projects'::regclass");
console.log('all policies:', allPol.rows);

await c.query("rollback");
await c.end();
