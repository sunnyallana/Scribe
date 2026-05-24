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

const fnOwner = await c.query(
  "select proowner::regrole as owner from pg_proc where proname = 'handle_new_project'",
);
console.log('handle_new_project owner:', fnOwner.rows);

const tableOwners = await c.query(
  "select relname, relowner::regrole as owner, relrowsecurity, relforcerowsecurity from pg_class where relname in ('projects','project_members','users') and relnamespace = 'public'::regnamespace",
);
console.log('tables:');
for (const t of tableOwners.rows) console.log(' ', t);

const authRole = await c.query(
  "select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('authenticated','postgres','anon','service_role','supabase_admin')",
);
console.log('roles:');
for (const r of authRole.rows) console.log(' ', r);

await c.end();
