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

const r = await c.query(
  "select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr, pg_get_expr(polwithcheck, polrelid) as with_check, polroles::regrole[] from pg_policy where polrelid = 'public.projects'::regclass",
);
console.log(JSON.stringify(r.rows, null, 2));

await c.end();
