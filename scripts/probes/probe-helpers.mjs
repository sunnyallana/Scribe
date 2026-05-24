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
  "select proname, prosecdef, pg_get_functiondef(oid) as src from pg_proc where proname in ('is_project_member','my_project_role','project_role','handle_new_project') and pronamespace = 'public'::regnamespace",
);
for (const row of r.rows) {
  console.log('=====', row.proname, '(security_definer=' + row.prosecdef + ') =====');
  console.log(row.src);
  console.log('');
}
await c.end();
