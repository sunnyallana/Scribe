#!/usr/bin/env node
// Interactive .env wizard for self-hosters.
//
//   node scripts/setup-env.mjs
//
// Prompts for the four values only you can provide (Supabase URL,
// publishable/anon key, secret/service-role key, database password),
// validates each one against your live project before accepting it,
// and derives everything else:
//
//   * DATABASE_URL    — probes the regional poolers to find where your
//                       project lives (the direct `db.<ref>` host is
//                       IPv6-only and unreachable from most networks),
//                       then writes the session-pooler string the Rust
//                       server needs.
//   * JWT settings    — reads your project's JWKS; modern projects sign
//                       with ES256/RS256 and need no SUPABASE_JWT_SECRET.
//                       Only legacy HS256 projects get prompted for it.
//   * VITE_* mirrors  — filled from the same answers.
//   * AI key          — AI_KEY_ENCRYPTION_KEY generated locally
//                       (32 random bytes; never leaves this machine).
//   * Tectonic        — auto-detected from PATH or ~/scribe-tools, written
//                       with forward slashes (dotenv treats backslashes in
//                       unquoted values as escapes and drops the line).
//
// Works with both key generations: new `sb_publishable_…`/`sb_secret_…`
// API keys and legacy `eyJ…` anon/service_role JWTs.
//
// Safe to re-run: an existing .env is backed up before being replaced.

import { existsSync, readdirSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const envPath = join(repoRoot, '.env');
const examplePath = join(repoRoot, '.env.example');

// ---- tiny console palette ---------------------------------------------------
const tty = process.stdout.isTTY;
const paint = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const cyan = paint(36);
const bold = paint(1);
const dim = paint(2);
const ok = (m) => console.log(`${green('✓')} ${m}`);
const warn = (m) => console.log(`${yellow('!')} ${m}`);
const fail = (m) => console.log(`${red('✗')} ${m}`);
const info = (m) => console.log(`${cyan('▶')} ${m}`);

// ---- prompt helper ----------------------------------------------------------
// Raw-mode line reader so secrets can be masked. Falls back gracefully
// when stdin is a pipe (CI / scripted runs). Input that arrives in one
// chunk with several lines (paste, pipe) is buffered across calls.
let pendingInput = '';

function ask(question, { mask = false, def } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const suffix = def !== undefined && def !== '' ? dim(` [${def}]`) : '';
    stdout.write(`${question}${suffix}: `);
    let buf = '';

    const finish = (val) => {
      stdout.write('\n');
      resolve(val.length ? val : (def ?? ''));
    };

    // Returns true once a newline terminated the answer. Any text after
    // the newline is kept for the next ask() call.
    const consume = (str) => {
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\u0003') {
          // Ctrl-C in raw mode doesn't raise SIGINT — handle it ourselves.
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          let rest = str.slice(i + 1);
          if (ch === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
          pendingInput = rest;
          return true;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          buf += ch;
          stdout.write(mask ? '*' : ch);
        }
      }
      return false;
    };

    if (pendingInput) {
      const str = pendingInput;
      pendingInput = '';
      if (consume(str)) {
        finish(buf);
        return;
      }
    }

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      if (consume(chunk.toString('utf8'))) {
        cleanup();
        finish(buf);
      }
    };
    const onEnd = () => {
      cleanup();
      finish(buf);
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}

async function askYesNo(question, def = true) {
  const answer = await ask(`${question} ${dim(def ? '(Y/n)' : '(y/N)')}`);
  if (!answer) return def;
  return /^y(es)?$/i.test(answer.trim());
}

// ---- Supabase REST validation ------------------------------------------------
// Both key generations ride in BOTH headers: legacy JWTs work with
// Authorization alone, but the new sb_* API keys are not JWTs and the
// gateway rejects a bare `Bearer sb_secret_…` with "Invalid Compact JWS".
function keyHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function http(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(12_000) });
}

async function checkAuthHealth(baseUrl, anonKey) {
  const res = await http(`${baseUrl}/auth/v1/health`, { headers: keyHeaders(anonKey) });
  if (!res.ok) throw new Error(`auth health returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.version ?? 'unknown';
}

async function fetchJwksKeys(baseUrl) {
  const res = await http(`${baseUrl}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body.keys) ? body.keys : [];
}

async function listBuckets(baseUrl, secretKey) {
  const res = await http(`${baseUrl}/storage/v1/bucket`, { headers: keyHeaders(secretKey) });
  if (!res.ok) throw new Error(`storage returned ${res.status}: ${await res.text()}`);
  return res.json();
}

const EXPECTED_BUCKETS = [
  'project-files',
  'compile-artifacts',
  'version-snapshots',
  'template-thumbnails',
];

// ---- Postgres endpoint discovery ----------------------------------------------
// Same region sweep as scripts/migrations/apply-migrations.mjs. The
// pooler host that recognises `postgres.<ref>` is the project's region;
// every other region answers "Tenant or user not found". A host that
// answers "password authentication failed" therefore proves the region
// is right and only the password is wrong.
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

function dbCandidates(ref) {
  return [
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
}

async function tryDbHost(cfg, password) {
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 6_000,
  });
  client.on('error', () => {}); // swallow late socket errors after a failed handshake
  try {
    await client.connect();
    await client.end();
    return { ...cfg, status: 'connected' };
  } catch (e) {
    try {
      await client.end();
    } catch {
      /* already dead */
    }
    const msg = String(e.message ?? e);
    if (msg.includes('password authentication failed') || e.code === '28P01') {
      return { ...cfg, status: 'auth-failed' };
    }
    return { ...cfg, status: 'unreachable', detail: msg };
  }
}

async function probeDb(candidates, password, { quiet = false } = {}) {
  const CHUNK = 12;
  const results = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    results.push(...(await Promise.all(chunk.map((c) => tryDbHost(c, password)))));
    // Stop sweeping as soon as something conclusive turned up.
    if (results.some((r) => r.status !== 'unreachable')) break;
  }
  const connected = results.filter((r) => r.status === 'connected');
  // Prefer a pooler over the direct host: poolers are IPv4-safe and the
  // session pooler is what servers/rust expects (sqlx prepared statements
  // don't survive transaction pooling).
  const winner = connected.find((r) => r.label !== 'direct') ?? connected[0] ?? null;
  const authFailed = results.filter((r) => r.status === 'auth-failed');
  if (!quiet && !winner && !authFailed.length) {
    for (const r of results.filter((x) => x.detail).slice(0, 3)) {
      console.log(dim(`    ${r.label}: ${r.detail}`));
    }
  }
  return { winner, authFailed };
}

async function countPublicTables(cfg, password) {
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8_000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const { rows } = await client.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
    );
    return rows[0].n;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

// ---- tectonic detection --------------------------------------------------------
// setup.{sh,ps1} installs tectonic under ~/scribe-tools on Windows; on
// Linux/macOS it usually ends up on PATH, in which case the default
// `TECTONIC_BIN=tectonic` already works and we leave it alone.
function findTectonic() {
  const tools = join(homedir(), 'scribe-tools');
  if (!existsSync(tools)) return null;
  for (const entry of readdirSync(tools)) {
    if (!entry.startsWith('tectonic-') || entry === 'tectonic-cache') continue;
    for (const exe of ['tectonic.exe', 'tectonic']) {
      const p = join(tools, entry, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// Forward slashes on purpose: dotenv parsers treat backslash in unquoted
// values as an escape character and silently drop the line. Windows APIs
// accept forward slashes everywhere.
const fwd = (p) => p.replaceAll('\\', '/');

// ---- .env templating ------------------------------------------------------------
// .env.example is the single source of truth for structure and comments;
// we only swap values in (and insert the few keys it doesn't carry).
function setKey(text, key, value) {
  const active = new RegExp(`^${key}=.*$`, 'm');
  if (active.test(text)) return text.replace(active, `${key}=${value}`);
  const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
  if (commented.test(text)) return text.replace(commented, `${key}=${value}`);
  return `${text.trimEnd()}\n${key}=${value}\n`;
}

function insertBefore(text, anchorRe, block) {
  if (!anchorRe.test(text)) return `${text.trimEnd()}\n${block}\n`;
  return text.replace(anchorRe, (m) => `${block}\n${m}`);
}

// ---- main -----------------------------------------------------------------------
async function main() {
  console.log(bold('\nScribe .env setup\n'));
  console.log('You will need, from your Supabase dashboard:');
  console.log('  1. The project URL                (Settings → API, or the browser address bar)');
  console.log('  2. The publishable / anon key     (Settings → API Keys)');
  console.log('  3. The secret / service_role key  (Settings → API Keys)');
  console.log('  4. The database password          (Settings → Database — reset it if unknown;');
  console.log(
    `     ${dim('the dashboard never displays it, and `[YOUR-PASSWORD]` in the connect')}`,
  );
  console.log(`     ${dim('string is a placeholder, not the value)')}`);
  console.log('');

  if (!existsSync(examplePath)) {
    fail(`.env.example not found at ${examplePath} — run from a Scribe checkout.`);
    process.exit(1);
  }

  if (existsSync(envPath)) {
    const overwrite = await askYesNo(
      `.env already exists at ${envPath}. Replace it (a backup is kept)?`,
      false,
    );
    if (!overwrite) {
      info('Keeping the existing .env. Nothing written.');
      process.exit(0);
    }
    const backup = `${envPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(envPath, backup);
    ok(`Backed up existing .env → ${backup}`);
  }

  let text = await readFile(examplePath, 'utf8');
  const summary = [];

  // ---- 1. project URL ----
  let baseUrl = '';
  let projectRef = null;
  for (;;) {
    const raw = await ask('Supabase project URL (or just the project ref)');
    let v = raw.trim().replace(/\/+$/, '');
    if (!v) {
      warn('A value is required.');
      continue;
    }
    if (/^[a-z0-9]{18,24}$/.test(v)) v = `https://${v}.supabase.co`;
    if (!/^https?:\/\//.test(v)) v = `https://${v}`;
    const m = v.match(/^https:\/\/([a-z0-9]{18,24})\.supabase\.co$/);
    if (m) {
      projectRef = m[1];
    } else {
      warn('Not a *.supabase.co URL — accepted, but the database host cannot be auto-discovered.');
    }
    baseUrl = v;
    break;
  }

  // ---- 2. publishable / anon key ----
  let anonKey = '';
  for (;;) {
    anonKey = (await ask('Publishable (or legacy anon) key')).trim();
    if (!anonKey) {
      warn('A value is required.');
      continue;
    }
    if (!/^(sb_publishable_|eyJ)/.test(anonKey)) {
      warn('Expected a key starting with `sb_publishable_` or `eyJ` (legacy anon JWT).');
      if (!(await askYesNo('Use it anyway?', false))) continue;
    }
    try {
      const version = await checkAuthHealth(baseUrl, anonKey);
      ok(`Auth reachable (GoTrue ${version}) — URL and key check out`);
      break;
    } catch (e) {
      fail(`Could not validate against ${baseUrl}/auth/v1/health — ${e.message ?? e}`);
      if (await askYesNo('Accept without validation (e.g. you are offline)?', false)) break;
    }
  }

  // ---- JWT verification mode (derived, not asked) ----
  let jwtSecret = '';
  try {
    const keys = await fetchJwksKeys(baseUrl);
    if (keys.length > 0) {
      const algs = [...new Set(keys.map((k) => k.alg).filter(Boolean))].join(', ') || 'asymmetric';
      ok(`Project signs JWTs with ${algs} — verified via JWKS, no SUPABASE_JWT_SECRET needed`);
    } else {
      warn('No JWKS published — this project uses legacy HS256 signing.');
      jwtSecret = (
        await ask('JWT secret (Settings → API → JWT Settings; blank to skip)', { mask: true })
      ).trim();
      if (!jwtSecret)
        warn(
          'Skipped: the API will not be able to verify logins until you set SUPABASE_JWT_SECRET.',
        );
    }
  } catch {
    warn(
      'Could not read JWKS; leaving SUPABASE_JWT_SECRET empty. Set it manually if logins fail to verify.',
    );
  }

  // ---- 3. secret / service_role key ----
  let secretKey = '';
  for (;;) {
    secretKey = (await ask('Secret (or legacy service_role) key', { mask: true })).trim();
    if (!secretKey) {
      warn('A value is required.');
      continue;
    }
    if (!/^(sb_secret_|eyJ)/.test(secretKey)) {
      warn('Expected a key starting with `sb_secret_` or `eyJ` (legacy service_role JWT).');
      if (!(await askYesNo('Use it anyway?', false))) continue;
    }
    try {
      const buckets = await listBuckets(baseUrl, secretKey);
      const names = new Set(buckets.map((b) => b.name));
      ok(`Storage reachable — ${buckets.length} bucket(s) visible`);
      const missing = EXPECTED_BUCKETS.filter((b) => !names.has(b));
      if (missing.length) {
        warn(`Missing Scribe buckets: ${missing.join(', ')}.`);
        warn(
          'Apply supabase/migrations/ to this project (see scripts/migrations/) before first use.',
        );
      }
      break;
    } catch (e) {
      fail(`Storage check failed — ${e.message ?? e}`);
      if (await askYesNo('Accept without validation?', false)) break;
    }
  }

  // ---- 4. database password → DATABASE_URL ----
  let databaseUrl = '';
  if (!projectRef) {
    warn('No project ref — paste the full connection string instead.');
    databaseUrl = (await ask('DATABASE_URL (blank to skip; server then runs without DB)')).trim();
  } else {
    let knownHosts = null; // once a host recognises the tenant, only retry that one
    for (;;) {
      const password = await ask('Database password', { mask: true });
      if (!password) {
        if (
          await askYesNo('Leave DATABASE_URL empty (API boots, but only /api/health works)?', false)
        )
          break;
        continue;
      }
      if (password.includes('[YOUR-PASSWORD]') || password === 'YOUR-PASSWORD') {
        warn(
          'That is the dashboard placeholder, not the password. Reset it under Settings → Database if unknown.',
        );
        continue;
      }
      info(
        knownHosts
          ? "Re-checking your project's pooler…"
          : 'Probing Supabase regions for your project (≤ ~30s)…',
      );
      const { winner, authFailed } = await probeDb(
        knownHosts ?? dbCandidates(projectRef),
        password,
      );
      if (winner) {
        databaseUrl = `postgresql://${encodeURIComponent(winner.user)}:${encodeURIComponent(password)}@${winner.host}:${winner.port}/postgres`;
        ok(`Connected via ${winner.label} (${winner.host}:${winner.port})`);
        try {
          const tables = await countPublicTables(winner, password);
          if (tables === 0) {
            warn('Database schema is empty — apply supabase/migrations/ before first use.');
          } else {
            ok(`Schema present (${tables} public tables)`);
          }
        } catch {
          /* sanity check only */
        }
        break;
      }
      if (authFailed.length) {
        knownHosts = authFailed; // region found; only the password is wrong
        warn(`Your project is behind ${authFailed[0].host}, but the password was rejected.`);
        warn(
          'If you reset it seconds ago, poolers can lag ~10–30s — retry. Otherwise re-enter it.',
        );
        continue;
      }
      fail('No Postgres endpoint reachable (network/VPN issue, or the project is paused).');
      if (!(await askYesNo('Try again?', true))) break;
    }
  }

  // ---- Redis ----
  const redisUrl = (await ask('Redis URL', { def: 'redis://127.0.0.1:6379' })).trim();

  // ---- AI key (generated locally) ----
  let aiKey = '';
  if (
    await askYesNo('Generate AI_KEY_ENCRYPTION_KEY now (needed for the AI assist routes)?', true)
  ) {
    aiKey = randomBytes(32).toString('base64');
    ok('Generated locally (32 random bytes, base64) — it never leaves this machine');
  }

  // ---- tectonic (detected) ----
  const tectonic = findTectonic();
  const cacheDir = join(homedir(), 'scribe-tools', 'tectonic-cache');

  // ---- assemble .env ----
  text = setKey(text, 'SUPABASE_URL', baseUrl);
  text = setKey(text, 'SUPABASE_ANON_KEY', anonKey);
  text = setKey(text, 'SUPABASE_SERVICE_ROLE_KEY', secretKey);
  if (jwtSecret) text = setKey(text, 'SUPABASE_JWT_SECRET', jwtSecret);
  text = setKey(text, 'VITE_SUPABASE_URL', baseUrl);
  text = setKey(text, 'VITE_SUPABASE_ANON_KEY', anonKey);
  text = setKey(text, 'REDIS_URL', redisUrl);
  if (databaseUrl) {
    text = insertBefore(
      text,
      /^SUPABASE_URL=/m,
      '# Postgres connection — session pooler (IPv4-safe), discovered by setup-env.\n' +
        `DATABASE_URL=${databaseUrl}`,
    );
  }
  if (aiKey) text = setKey(text, 'AI_KEY_ENCRYPTION_KEY', aiKey);
  if (tectonic) {
    text = setKey(text, 'TECTONIC_BIN', fwd(tectonic));
    if (existsSync(cacheDir)) {
      text = text.replace(/^TECTONIC_BIN=.*$/m, (m) => `${m}\nTECTONIC_CACHE_DIR=${fwd(cacheDir)}`);
    }
  }

  await writeFile(envPath, text, 'utf8');

  // ---- summary ----
  summary.push(['SUPABASE_URL', baseUrl]);
  summary.push(['SUPABASE_ANON_KEY / VITE_*', 'set (validated against auth)']);
  summary.push(['SUPABASE_SERVICE_ROLE_KEY', 'set (validated against storage)']);
  summary.push(['SUPABASE_JWT_SECRET', jwtSecret ? 'set (legacy HS256)' : 'not needed (JWKS)']);
  summary.push([
    'DATABASE_URL',
    databaseUrl ? 'set (connection verified)' : yellow('skipped — DB routes will 503'),
  ]);
  summary.push(['REDIS_URL', redisUrl]);
  summary.push([
    'AI_KEY_ENCRYPTION_KEY',
    aiKey ? 'generated' : yellow('skipped — /api/ai will 503'),
  ]);
  summary.push(['TECTONIC_BIN', tectonic ? fwd(tectonic) : 'tectonic (PATH lookup)']);

  console.log(`\n${bold('Written:')} ${envPath}\n`);
  for (const [k, v] of summary) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(`\n${bold('Next:')}`);
  console.log('  Windows       .\\scripts\\run.ps1');
  console.log('  Linux/macOS   ./scripts/run.sh');
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  fail(`setup-env failed: ${e?.stack ?? e}`);
  process.exit(1);
});
