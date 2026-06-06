// Shared config resolution for the one-off migration runners, so they
// target *your* Supabase project instead of a hard-coded ref. Reads the
// repo-root .env (which `node scripts/setup-env.mjs` writes) and accepts
// explicit env-var overrides. Resolution order, most explicit wins:
//
//   ref:       SUPABASE_PROJECT_REF env var
//              → DATABASE_URL user/host (env var or .env)
//              → SUPABASE_URL host (env var or .env)
//   password:  SUPABASE_DB_PASSWORD env var
//              → DATABASE_URL password (env var or .env)
//   host:      DATABASE_URL's host:port is tried first; then the direct
//              `db.<ref>` host and the regional pooler sweep (the pooler
//              that recognises `postgres.<ref>` is the project's region —
//              every other region answers "Tenant or user not found").

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseDotEnv() {
  try {
    const text = readFileSync(join(repoRoot, '.env'), 'utf-8');
    const map = {};
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) map[m[1]] = m[2];
    }
    return map;
  } catch {
    return {}; // no .env — overrides via env vars still work
  }
}

export function resolveDbConfig() {
  const dotenv = parseDotEnv();
  const get = (key) => process.env[key] || dotenv[key] || '';

  let ref = process.env.SUPABASE_PROJECT_REF || '';
  let password = process.env.SUPABASE_DB_PASSWORD || '';
  let knownHost = null;

  const dbUrl = get('DATABASE_URL');
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      knownHost = {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username),
        label: 'DATABASE_URL',
      };
      if (!password) password = decodeURIComponent(u.password);
      if (!ref) {
        const m =
          u.username.match(/^postgres\.([a-z0-9]+)$/) ??
          u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
        if (m) ref = m[1];
      }
    } catch {
      // unparseable DATABASE_URL — fall through to SUPABASE_URL
    }
  }
  if (!ref) {
    const m = get('SUPABASE_URL').match(/^https:\/\/([a-z0-9]{18,24})\.supabase\.co\/?$/);
    if (m) ref = m[1];
  }

  if (!ref) {
    console.error('Could not determine the Supabase project ref.');
    console.error('Fill in SUPABASE_URL or DATABASE_URL in .env (`node scripts/setup-env.mjs`),');
    console.error('or pass SUPABASE_PROJECT_REF=<ref> explicitly.');
    process.exit(1);
  }
  if (!password) {
    console.error('Could not determine the database password.');
    console.error('Put DATABASE_URL in .env (`node scripts/setup-env.mjs`),');
    console.error('or pass SUPABASE_DB_PASSWORD=<password> explicitly.');
    process.exit(1);
  }
  return { ref, password, knownHost };
}

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

function candidateHosts({ ref, knownHost }) {
  const sweep = [
    { host: `db.${ref}.supabase.co`, port: 5432, user: 'postgres', label: 'direct' },
    ...REGIONS.flatMap((r) => [
      {
        host: `aws-1-${r}.pooler.supabase.com`,
        port: 5432,
        user: `postgres.${ref}`,
        label: `aws-1-${r}`,
      },
      {
        host: `aws-0-${r}.pooler.supabase.com`,
        port: 5432,
        user: `postgres.${ref}`,
        label: `aws-0-${r}`,
      },
    ]),
  ];
  return knownHost ? [knownHost, ...sweep.filter((c) => c.host !== knownHost.host)] : sweep;
}

/** Connect to the first reachable endpoint for this project. */
export async function connectAny(cfg) {
  for (const c of candidateHosts(cfg)) {
    const client = new Client({
      host: c.host,
      port: c.port,
      user: c.user,
      password: cfg.password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8_000,
    });
    try {
      await client.connect();
      console.log(`Connected via ${c.label} (${c.host}:${c.port})`);
      return client;
    } catch (e) {
      console.log(`  ${c.label} failed: ${e.message}`);
      try {
        await client.end();
      } catch {
        // already closed
      }
    }
  }
  throw new Error('Could not connect to any Supabase Postgres endpoint');
}
