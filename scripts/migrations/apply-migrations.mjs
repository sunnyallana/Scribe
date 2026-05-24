// One-off migration runner for the hosted Supabase demo. Connects to the
// project's Postgres pooler over the IPv4 transaction pooler and applies
// every file in supabase/migrations/ in filename order. Idempotent? No —
// run once per project.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import pg from 'pg';

const { Client } = pg;

const projectRef = 'sgmbvxqgowbpyehwmedv';
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!dbPassword) {
  console.error('Set SUPABASE_DB_PASSWORD env var');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');

const REGIONS = [
  'ap-south-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ca-central-1',
  'sa-east-1',
];

const hosts = [
  { host: `db.${projectRef}.supabase.co`, port: 5432, user: 'postgres', label: 'direct' },
  ...REGIONS.flatMap((r) => [
    { host: `aws-1-${r}.pooler.supabase.com`, port: 5432, user: `postgres.${projectRef}`, label: `aws-1-${r}` },
    { host: `aws-0-${r}.pooler.supabase.com`, port: 5432, user: `postgres.${projectRef}`, label: `aws-0-${r}` },
  ]),
];

async function tryConnect() {
  for (const cfg of hosts) {
    const client = new Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: dbPassword,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8_000,
    });
    try {
      await client.connect();
      console.log(`Connected via ${cfg.label} (${cfg.host}:${cfg.port})`);
      return client;
    } catch (e) {
      console.log(`  ${cfg.label} failed: ${e.message}`);
      try { await client.end(); } catch {}
    }
  }
  throw new Error('Could not connect to any Supabase Postgres endpoint');
}

const client = await tryConnect();

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
console.log(`Applying ${files.length} migrations...`);

for (const f of files) {
  const sql = await readFile(join(migrationsDir, f), 'utf-8');
  process.stdout.write(`  ${f} ... `);
  try {
    await client.query(sql);
    console.log('ok');
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    process.exit(2);
  }
}

await client.end();
console.log('All migrations applied.');
