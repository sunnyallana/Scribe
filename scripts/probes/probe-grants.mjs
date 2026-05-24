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

const grants = await c.query(
  "select grantee, privilege_type from information_schema.table_privileges where table_schema='public' and table_name='projects'",
);
console.log('projects grants:');
for (const g of grants.rows) console.log(' ', g);

const colGrants = await c.query(
  "select grantee, column_name, privilege_type from information_schema.column_privileges where table_schema='public' and table_name='projects' and grantee in ('authenticated','anon')",
);
console.log('projects column grants for auth/anon:');
for (const g of colGrants.rows) console.log(' ', g);

// What if there's no INSERT grant to 'authenticated'? That would cause RLS to deny.
console.log('');
console.log('users grants:');
const u = await c.query(
  "select grantee, privilege_type from information_schema.table_privileges where table_schema='public' and table_name='users' and grantee in ('authenticated','anon')",
);
for (const g of u.rows) console.log(' ', g);

await c.end();
