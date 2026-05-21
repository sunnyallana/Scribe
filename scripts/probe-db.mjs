import pg from 'pg';

const client = new pg.Client({
  host: 'aws-1-ap-southeast-2.pooler.supabase.com',
  port: 5432,
  user: 'postgres.sgmbvxqgowbpyehwmedv',
  password: 'Oc16OInTHRrvU5wu',
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await client.connect();

console.log('auth.users:');
const a = await client.query('select id, email from auth.users');
for (const row of a.rows) console.log(`  ${row.id}  ${row.email}`);

console.log('public.users:');
const p = await client.query('select id, email from public.users');
for (const row of p.rows) console.log(`  ${row.id}  ${row.email}`);

console.log('public.projects:');
const proj = await client.query('select id, name, owner_id from public.projects');
for (const row of proj.rows) console.log(`  ${row.id}  ${row.name}  owner=${row.owner_id}`);

await client.end();
