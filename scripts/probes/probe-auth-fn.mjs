import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query("select pg_get_functiondef(oid) as src from pg_proc where proname = 'uid' and pronamespace = 'auth'::regnamespace");
console.log(r.rows[0]?.src);

// Direct: set the jwt claim and read auth.uid()
await c.query("set role authenticated");
const userId = '05a147f9-3d78-4216-80fe-764f38a6078a';
await c.query(`set request.jwt.claims to '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`);
const u = await c.query('select auth.uid() as uid, $1::uuid as expected, auth.uid() = $1::uuid as match', [userId]);
console.log('uid comparison:', u.rows);

await c.end();
