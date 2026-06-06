#!/usr/bin/env node
// Seed a ready-to-use login so a fresh self-hosted instance isn't stuck on
// the sign-in page.
//
// A new Supabase project has email confirmation ON and (usually) no SMTP
// wired up, so signing up through the UI never completes — the
// confirmation link never arrives. This creates the account through the
// GoTrue *admin* API with the service-role key and `email_confirm: true`,
// so it works for login immediately.
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env. Email/password
// come from CLI args, then env (SEED_USER_EMAIL / SEED_USER_PASSWORD), then
// an interactive prompt.
//
//   node scripts/seed-user.mjs                       # prompts
//   node scripts/seed-user.mjs me@example.com hunter2 # positional args
//   SEED_USER_EMAIL=… SEED_USER_PASSWORD=… node scripts/seed-user.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDotEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(repoRoot, '.env'), 'utf-8').split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    /* no .env — caller may pass values another way */
  }
  return env;
}

/**
 * Create a confirmed user via the GoTrue admin API.
 * Returns { ok, status, alreadyExists, error, userId }.
 */
export async function seedUser({ baseUrl, serviceKey, email, password }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/auth/v1/admin/users`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message ?? e) };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.ok) return { ok: true, userId: body?.id };
  const text = body ? JSON.stringify(body) : '';
  // GoTrue returns 422 (or a 400/409 with an "already registered" message)
  // when the address is taken — treat that as a soft, recoverable outcome.
  const alreadyExists =
    res.status === 422 || /already.*(registered|exists)|email.*taken/i.test(text);
  return {
    ok: false,
    status: res.status,
    alreadyExists,
    error: body?.msg ?? body?.message ?? text,
  };
}

/** Basic input validation matching Supabase's defaults. */
export function validateCredentials(email, password) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email address.';
  if (!password || password.length < 6) return 'Password must be at least 6 characters.';
  return null;
}

// ---- CLI ---------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/seed-user.mjs');

if (invokedDirectly) {
  const { createInterface } = await import('node:readline/promises');
  const env = readDotEnv();
  const baseUrl = process.env.SUPABASE_URL || env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !serviceKey) {
    console.error(
      '✗ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (in .env or env vars).\n' +
        '  Run `node scripts/setup-env.mjs` first.',
    );
    process.exit(1);
  }

  let email = process.argv[2] || process.env.SEED_USER_EMAIL || '';
  let password = process.argv[3] || process.env.SEED_USER_PASSWORD || '';

  if (!email || !password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!email) email = (await rl.question('Email: ')).trim();
      // Note: readline echoes input, so the password is visible here. Pass
      // it as an arg/env var, or use the masked prompt in setup-env.mjs, to
      // avoid that.
      if (!password) password = await rl.question('Password (min 6 chars): ');
    } finally {
      rl.close();
    }
  }

  const invalid = validateCredentials(email, password);
  if (invalid) {
    console.error(`✗ ${invalid}`);
    process.exit(1);
  }

  const r = await seedUser({ baseUrl, serviceKey, email, password });
  if (r.ok) {
    console.log(`✓ Created ${email} (email pre-confirmed) — you can log in immediately.`);
    process.exit(0);
  }
  if (r.alreadyExists) {
    console.log(`! ${email} already exists — just log in with it (or pick another address).`);
    process.exit(0);
  }
  console.error(`✗ Could not create user (HTTP ${r.status}). ${r.error ?? ''}`);
  process.exit(2);
}
