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

const counts = await c.query(`
  select doc_id, count(*) as updates, max(created_at) as latest
  from public.yjs_updates
  group by doc_id
  order by latest desc nulls last
  limit 20
`);
console.log('yjs_updates by doc_id:');
for (const row of counts.rows) console.log(' ', row);

const proj = await c.query(
  'select id, name, owner_id, updated_at from public.projects order by updated_at desc limit 10',
);
console.log('\nrecent projects:');
for (const row of proj.rows) console.log(' ', row);

const files = await c.query(
  'select id, project_id, path, size_bytes from public.project_files order by updated_at desc limit 20',
);
console.log('\nrecent files:');
for (const row of files.rows) console.log(' ', row);

await c.end();
