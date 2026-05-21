import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();

const userId = '05a147f9-3d78-4216-80fe-764f38a6078a';

await c.query("set role authenticated");
await c.query(`set request.jwt.claims to '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`);

// 1. Insert into projects with the trigger DISABLED via a tx-local setting? Can't from authenticated role.
// So instead: try inserting into project_members directly first (should fail since user isn't a member of any project)
console.log('--- try direct insert into project_members (should fail) ---');
try {
  const r = await c.query("insert into public.project_members (project_id, user_id, role) values (gen_random_uuid(), $1, 'owner')", [userId]);
  console.log('insert OK', r.rows);
} catch (e) {
  console.log('insert FAIL', e.message);
}

console.log('');
console.log('--- check what my_project_role returns for a fresh project id ---');
try {
  const fakeId = '11111111-1111-1111-1111-111111111111';
  const r = await c.query("select my_project_role($1::uuid) as role", [fakeId]);
  console.log('my_project_role(fakeId) =', r.rows);
} catch (e) {
  console.log('FAIL', e.message);
}

await c.end();
