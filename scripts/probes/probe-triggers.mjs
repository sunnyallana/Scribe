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

const triggers = await c.query(
  "select trigger_name, event_manipulation, action_timing, action_statement from information_schema.triggers where event_object_table = 'projects' and event_object_schema = 'public'",
);
console.log('triggers on projects:', JSON.stringify(triggers.rows, null, 2));

const rls = await c.query(
  "select tablename, rowsecurity from pg_tables where tablename = 'projects' and schemaname='public'",
);
console.log('rls enabled:', rls.rows);

// Try the insert as the same role PostgREST uses
console.log('\n--- simulating auth context ---');
await c.query('set local role authenticated');
await c.query(
  'set local request.jwt.claims to \'{"sub":"05a147f9-3d78-4216-80fe-764f38a6078a","role":"authenticated"}\'',
);
try {
  const r = await c.query(
    "insert into public.projects (name, owner_id, template, compiler) values ('SQL Direct', '05a147f9-3d78-4216-80fe-764f38a6078a', 'article', 'tectonic') returning id, owner_id",
  );
  console.log('SQL insert OK:', r.rows);
} catch (e) {
  console.log('SQL insert FAILED:', e.message);
  console.log('  hint:', e.hint, 'detail:', e.detail);
}

await c.end();
