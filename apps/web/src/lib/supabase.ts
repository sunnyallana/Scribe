import { createClient } from '@supabase/supabase-js';

import type { Database } from '@scribe/shared';

const url: string = import.meta.env.VITE_SUPABASE_URL;
const anonKey: string = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (url === '' || anonKey === '') {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.',
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

/**
 * Resolve the API origin the SPA talks to.
 *
 *   1. If the page is loaded over a host other than 127.0.0.1 /
 *      localhost (e.g. a cloudflared tunnel or a phone hitting the
 *      dev box's LAN IP), use SAME-ORIGIN paths so requests flow
 *      through Vite's `/api` proxy. This avoids mixed-content
 *      blocks on HTTPS tunnels and CORS pain.
 *   2. Otherwise, honour the configured `VITE_API_URL` (typically
 *      `http://127.0.0.1:3010` in dev). Falls back to a sensible
 *      default if unset.
 */
function resolveApiUrl(): string {
  if (typeof window !== 'undefined') {
    // Tauri's installed-app webview loads the SPA from
    // `https://tauri.localhost/` (Windows / Linux) or
    // `tauri://localhost/` (macOS) — neither matches the
    // `localhost`/`127.0.0.1` heuristic below, and neither has a
    // `/api/*` route to proxy through. We MUST honour the explicit
    // `VITE_API_URL` baked at build time. Without this branch the
    // SPA fetches its own index.html for every API call and the
    // JSON parser bombs with "<!doctype" tokens.
    const inTauri = '__TAURI_INTERNALS__' in window;
    if (!inTauri) {
      const host = window.location.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
      if (!isLocal) {
        // Browser tab on a tunnel / phone / LAN IP — same-origin
        // paths so requests flow through Vite's `/api` proxy.
        // Avoids mixed-content blocks on HTTPS tunnels and CORS pain.
        return '';
      }
    }
  }
  const env = import.meta.env.VITE_API_URL;
  if (env !== undefined && env !== '') return env;
  return 'http://localhost:3000';
}

export const API_URL: string = resolveApiUrl();

/**
 * Build a WebSocket origin from the API URL. Three cases:
 *   1. `API_URL` is empty string → same-origin: derive from the
 *      current `window.location` (and flip http(s) → ws(s)).
 *   2. `API_URL` is an absolute URL → swap protocol.
 *   3. SSR / no `window` → return `''` (callers won't open a WS
 *      on the server anyway).
 *
 * Centralised here so the editor / compile / voice hooks all
 * agree on the rule; previously each hook had its own copy that
 * crashed on the empty-string case.
 */
export function wsOrigin(): string {
  if (API_URL !== '') {
    try {
      const u = new URL(API_URL);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return u.toString().replace(/\/$/, '');
    } catch {
      // fall through to same-origin
    }
  }
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

/**
 * Latest access token, kept in sync via `supabase.auth.onAuthStateChange`.
 *
 * Why this exists: `supabase.auth.getSession()` is async and cannot be
 * awaited inside synchronous handlers like `beforeunload` (the page is
 * about to be killed and the runtime won't pump microtasks). We mirror
 * the token here so those handlers can do `getAccessTokenSync()` and
 * send a fetch with `keepalive: true` before the tab dies. Previously
 * we parsed `localStorage` for an `sb-*-auth-token` key — which broke
 * any time the Supabase client changed its storage schema.
 */
let cachedAccessToken: string | null = null;

void supabase.auth.getSession().then(({ data }) => {
  cachedAccessToken = data.session?.access_token ?? null;
});

supabase.auth.onAuthStateChange((_event, session) => {
  cachedAccessToken = session?.access_token ?? null;
});

export function getAccessTokenSync(): string | null {
  return cachedAccessToken;
}
