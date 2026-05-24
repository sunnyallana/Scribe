import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query("select pg_get_functiondef(oid) as src from pg_proc where proname = 'handle_new_project'");
console.log(r.rows[0]?.src ?? '(no function)');
await c.end();
