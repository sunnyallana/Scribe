// Browser-assisted credential capture for setup-env.mjs.
//
// Opens a real (headed) browser on the Supabase dashboard; you log in;
// the script then reads your project list and API keys through the
// platform API the dashboard itself uses — no DOM scraping — and can
// optionally reset the database password to a locally-generated one.
//
// Notes:
//   * Uses playwright-core (a devDependency). Drives your installed
//     Edge/Chrome by default; set SCRIBE_DASHBOARD_BROWSER=chromium to use
//     Playwright's bundled Chromium instead (a clean, separate browser —
//     handy when your system browser is already open).
//   * The browser profile persists under ~/scribe-tools/ so you stay
//     logged in across re-runs.
//   * Every captured value is still validated by setup-env.mjs exactly
//     like a hand-typed one, so a drifted platform API degrades to
//     manual entry instead of writing a broken .env.

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DASHBOARD = 'https://supabase.com/dashboard/projects';
const PLATFORM = 'https://api.supabase.com/platform';
// API keys live on the Management API (v1), not the platform API — the
// dashboard's own API-keys page fetches /v1/projects/{ref}/api-keys.
const MGMT = 'https://api.supabase.com/v1';
const LOGIN_TIMEOUT_MS = Number(process.env.SCRIBE_DASHBOARD_LOGIN_TIMEOUT_MS ?? 300_000);

/** fetch() from inside the dashboard page so its session applies. */
async function pageFetch(page, url, init = undefined) {
  return page.evaluate(
    async ({ url, init }) => {
      try {
        const r = await fetch(url, {
          credentials: 'include',
          ...(init ?? {}),
          headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        });
        let body = null;
        try {
          body = await r.json();
        } catch {
          /* non-JSON body */
        }
        return { ok: r.ok, status: r.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: null, error: String(e) };
      }
    },
    { url, init },
  );
}

// The dashboard authenticates to the platform API with a GoTrue bearer
// token kept in localStorage, not a cookie — so a cookie-only fetch reads
// as logged-out even after a successful sign-in. Pull every JWT-shaped
// access token out of localStorage so we can try them as Bearer creds.
async function collectAccessTokens(page) {
  return page
    .evaluate(() => {
      const out = new Set();
      const looksJwt = (s) => typeof s === 'string' && s.split('.').length === 3 && s.length > 40;
      const visit = (v) => {
        if (!v) return;
        if (looksJwt(v)) out.add(v);
        else if (typeof v === 'object') {
          if (looksJwt(v.access_token)) out.add(v.access_token);
          if (v.currentSession && looksJwt(v.currentSession.access_token)) {
            out.add(v.currentSession.access_token);
          }
        }
      };
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const raw = localStorage.getItem(localStorage.key(i));
          try {
            visit(JSON.parse(raw));
          } catch {
            visit(raw);
          }
        }
      } catch {
        /* localStorage blocked */
      }
      return [...out];
    })
    .catch(() => []);
}

// Returns { headers } that authenticate to the platform API, or null if
// no working session is present yet. Tries cookies first, then each
// localStorage bearer token.
async function resolveAuth(page) {
  const cookie = await pageFetch(page, `${PLATFORM}/profile`).catch(() => null);
  if (cookie?.ok) return { headers: {} };
  for (const token of await collectAccessTokens(page)) {
    const r = await pageFetch(page, `${PLATFORM}/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (r?.ok) return { headers: { Authorization: `Bearer ${token}` } };
  }
  return null;
}

export async function captureFromDashboard({ ask, askYesNo, info, warn, ok }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return { error: 'playwright-core is not installed (run pnpm install).' };
  }

  // Drive a browser that's already on the machine — playwright-core
  // ships none. Edge is preinstalled on Windows 10/11; Chrome covers
  // macOS/Linux. The profile dir keeps you logged in across runs.
  const profileDir = join(homedir(), 'scribe-tools', 'supabase-dashboard-profile');
  // Strip the automation fingerprint. Without this, Google's OAuth
  // ("Couldn't sign you in — this browser or app may not be secure")
  // and similar IdP bot-checks refuse the login because Playwright sets
  // `navigator.webdriver=true` and the `--enable-automation` switch.
  // We're automating the user's own sign-in to their own dashboard, so
  // clearing those false-positive signals is legitimate; it is not
  // detection evasion against a target.
  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 850 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
  // Browser choice. `SCRIBE_DASHBOARD_BROWSER` forces one:
  //   chromium  → Playwright's bundled Chromium (a clean, separate browser —
  //               best when your system Edge/Chrome is already open)
  //   chrome / msedge / edge → that system browser
  // Default order tries the system browsers first (your saved logins), then
  // falls back to bundled Chromium. `undefined` channel = bundled.
  const pref = (process.env.SCRIBE_DASHBOARD_BROWSER ?? '').trim().toLowerCase();
  const channelMap = {
    chromium: undefined,
    bundled: undefined,
    chrome: 'chrome',
    msedge: 'msedge',
    edge: 'msedge',
  };
  const channels = pref ? [channelMap[pref] ?? undefined] : ['msedge', 'chrome', undefined];
  let context = null;
  for (const channel of channels) {
    try {
      context = await chromium.launchPersistentContext(profileDir, { channel, ...launchOpts });
      info(`Using ${channel ?? 'bundled Chromium'}.`);
      break;
    } catch {
      /* try the next channel */
    }
  }
  if (!context) {
    // playwright-core ships no browser binaries. Windows always has Edge;
    // elsewhere there may be neither a system Chrome/Edge nor a downloaded
    // Chromium. Point at the exact command that fixes it.
    return {
      error:
        'Could not launch a browser. Either install Google Chrome, or download ' +
        "Playwright's Chromium once with `pnpm exec playwright-core install chromium` " +
        'and re-run (optionally with SCRIBE_DASHBOARD_BROWSER=chromium).',
    };
  }

  try {
    // navigator.webdriver leaks through even with the flag above on some
    // Chromium builds; nuke it before any page script runs so IdP
    // bot-checks see a normal browser.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    info('Browser opened. Log into Supabase in that window — the wizard waits for you.');
    info('(Leave the window open; it closes by itself when the capture finishes.)');
    info(
      'If Google still blocks sign-in, use email/password or GitHub — or skip and paste keys manually.',
    );

    // Poll until a usable session appears (cookie or localStorage bearer).
    const debug = /^(1|true|yes)$/i.test(process.env.SCRIBE_DASHBOARD_DEBUG ?? '');
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let auth = null;
    let ticks = 0;
    while (Date.now() < deadline) {
      auth = await resolveAuth(page);
      if (auth) break;
      // Every ~10s, surface what we actually see so a timeout is diagnosable
      // rather than opaque: where the page is, whether a session token exists
      // yet, and what the profile endpoint returns.
      if (debug && ticks % 5 === 0) {
        const url = page.url();
        const tokens = await collectAccessTokens(page);
        const probe = await pageFetch(page, `${PLATFORM}/profile`).catch(() => null);
        let bearer = null;
        if (tokens[0]) {
          bearer = await pageFetch(page, `${PLATFORM}/profile`, {
            headers: { Authorization: `Bearer ${tokens[0]}` },
          }).catch(() => null);
        }
        warn(
          `[debug] page=${url.slice(0, 60)} tokens=${tokens.length} ` +
            `cookieProfile=${probe?.status ?? 'err'} bearerProfile=${bearer?.status ?? 'n/a'}`,
        );
      }
      ticks += 1;
      await page.waitForTimeout(2_000);
    }
    if (!auth) {
      return { error: 'Timed out waiting for the dashboard login.' };
    }
    // All platform calls reuse the resolved auth headers.
    const api = (url, init = {}) =>
      pageFetch(page, url, { ...init, headers: { ...auth.headers, ...(init.headers ?? {}) } });
    ok('Logged in.');

    // ---- pick the project ----
    const projectsResp = await api(`${PLATFORM}/projects`);
    const projects = Array.isArray(projectsResp.body)
      ? projectsResp.body
      : (projectsResp.body?.projects ?? []);
    if (!projectsResp.ok || projects.length === 0) {
      return { error: `Could not list projects (HTTP ${projectsResp.status}).` };
    }
    let project = projects[0];
    if (projects.length > 1) {
      console.log('');
      projects.forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.name ?? '(unnamed)'}  (${p.ref})  ${p.status ?? ''}`);
      });
      for (;;) {
        const n = Number((await ask(`Which project? (1-${projects.length})`, { def: '1' })).trim());
        if (Number.isInteger(n) && n >= 1 && n <= projects.length) {
          project = projects[n - 1];
          break;
        }
        warn('Not a valid choice.');
      }
    }
    const ref = project.ref;
    ok(`Project: ${project.name ?? ref} (${ref})`);

    // ---- API keys ----
    // A project can expose BOTH key generations at once. Prefer the new
    // sb_publishable_/sb_secret_ format (what the server + .env use today),
    // falling back to the legacy anon/service_role JWTs when that's all
    // there is. Endpoint field names have drifted, so read any string.
    let anonNew = '';
    let anonLegacy = '';
    let secretNew = '';
    let secretLegacy = '';
    for (const query of ['?reveal=true', '?reveal=false']) {
      const keysResp = await api(`${MGMT}/projects/${ref}/api-keys${query}`);
      const keys = Array.isArray(keysResp.body)
        ? keysResp.body
        : (keysResp.body?.api_keys ?? keysResp.body?.keys ?? []);
      if (debug) {
        const shape = Array.isArray(keys) && keys[0] ? Object.keys(keys[0]).join(',') : '—';
        warn(
          `[debug] api-keys${query}: HTTP ${keysResp.status}, ${keys.length} entries, fields=[${shape}]`,
        );
      }
      for (const k of keys) {
        const v = k.api_key ?? k.apiKey ?? k.secret ?? k.value ?? (typeof k === 'string' ? k : '');
        if (!v) continue;
        const tag = `${k.name ?? ''} ${k.type ?? ''}`.toLowerCase();
        if (v.startsWith('sb_publishable_')) anonNew ||= v;
        else if (tag.includes('anon') || tag.includes('publishable')) anonLegacy ||= v;
        if (v.startsWith('sb_secret_')) secretNew ||= v;
        else if (tag.includes('service_role') || tag.includes('secret')) secretLegacy ||= v;
      }
      if ((anonNew || anonLegacy) && (secretNew || secretLegacy)) break;
    }
    const anonKey = anonNew || anonLegacy;
    const secretKey = secretNew || secretLegacy;
    if (anonKey) ok(`Captured publishable/anon key${anonNew ? '' : ' (legacy JWT)'}.`);
    else warn('Could not capture the publishable key — you will be prompted for it.');
    if (secretKey) ok(`Captured secret/service_role key${secretNew ? '' : ' (legacy JWT)'}.`);
    else warn('Could not capture the secret key — you will be prompted for it.');

    // ---- database password (reset only with explicit consent) ----
    let dbPassword = null;
    const wantReset = await askYesNo(
      'Reset the database password now to a generated one? (anything using the old password must be updated)',
      false,
    );
    if (wantReset) {
      const candidate = randomBytes(18).toString('base64url');
      const resetResp = await api(`${PLATFORM}/projects/${ref}/db-password`, {
        method: 'PATCH',
        body: JSON.stringify({ password: candidate }),
      });
      if (resetResp.ok) {
        dbPassword = candidate;
        ok('Database password reset (poolers can take ~10-30s to pick it up).');
      } else {
        warn(`Password reset failed (HTTP ${resetResp.status}) — you will be prompted instead.`);
      }
    }

    return {
      baseUrl: `https://${ref}.supabase.co`,
      ref,
      anonKey: anonKey || null,
      secretKey: secretKey || null,
      dbPassword,
    };
  } catch (e) {
    // Closing the window mid-flow is the common case here — surface it
    // as a clean fallback instead of an exception.
    const msg = String(e?.message ?? e).split('\n')[0];
    if (/closed/i.test(msg)) {
      return { error: 'The browser window was closed before the capture finished.' };
    }
    return { error: `Browser capture aborted (${msg}).` };
  } finally {
    await context.close().catch(() => {});
  }
}
