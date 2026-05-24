// One-shot: apply 20260524000002_project_share_links.sql to the
// hosted Supabase demo. Use this for new migrations that haven't been
// applied yet (the bulk runner re-runs everything and trips on
// "already exists" for prior migrations).

import { readFile } from 'node:fs/promises';
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
const file = join(__dirname, '..', '..', 'supabase', 'migrations', '20260524000002_project_share_links.sql');

const cfg = {
  host: 'aws-1-ap-southeast-2.pooler.supabase.com',
  port: 5432,
  user: `postgres.${projectRef}`,
  password: dbPassword,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
};

const client = new Client(cfg);
await client.connect();
console.log('Connected.');

const sql = await readFile(file, 'utf-8');
try {
  await client.query(sql);
  console.log('Applied 20260524000002_project_share_links.sql');
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  await client.end();
  process.exit(2);
}

await client.end();
