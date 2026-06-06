// Apply 20260524000004_comment_suggestions.sql to your project (config
// derived from .env — see ./env.mjs).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { connectAny, resolveDbConfig } from './env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = join(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20260524000004_comment_suggestions.sql',
);

const client = await connectAny(resolveDbConfig());

const sql = await readFile(file, 'utf-8');
try {
  await client.query(sql);
  console.log('Applied 20260524000004_comment_suggestions.sql');
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  await client.end();
  process.exit(2);
}
await client.end();
