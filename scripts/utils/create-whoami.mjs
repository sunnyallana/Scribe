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
await c.query(`
  create or replace function public.echo_auth() returns jsonb as $$
    select jsonb_build_object(
      'uid', auth.uid(),
      'role', auth.role(),
      'jwt_claims', current_setting('request.jwt.claims', true)
    )
  $$ language sql stable;
  grant execute on function public.echo_auth() to anon, authenticated, service_role;
`);
console.log('echo_auth function created');
// Force PostgREST schema reload
await c.query("notify pgrst, 'reload schema'");
console.log('schema reload notified');
await c.end();
