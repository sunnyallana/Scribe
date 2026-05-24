import pg from 'pg';
const c = new pg.Client({ host: 'aws-1-ap-southeast-2.pooler.supabase.com', port: 5432, user: 'postgres.sgmbvxqgowbpyehwmedv', password: 'Oc16OInTHRrvU5wu', database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("drop policy if exists storage_version_snapshots_insert on storage.objects");
await c.query(`create policy storage_version_snapshots_insert on storage.objects for insert with check (
  bucket_id = 'version-snapshots'
  and public.is_project_member((storage.foldername(name))[1]::uuid, auth.uid())
)`);
console.log('storage version-snapshots INSERT policy added');
await c.end();
