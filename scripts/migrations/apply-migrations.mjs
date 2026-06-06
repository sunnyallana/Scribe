// One-off migration runner. Connects to your project's Postgres (config
// derived from .env — see ./env.mjs) and applies every file in
// supabase/migrations/ in filename order. Idempotent? No — run once per
// project; for incremental applies prefer `pnpm exec supabase db push`.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { connectAny, resolveDbConfig } from './env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');

const client = await connectAny(resolveDbConfig());

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
