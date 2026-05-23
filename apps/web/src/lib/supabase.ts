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

export const API_URL: string =
  import.meta.env.VITE_API_URL !== undefined && import.meta.env.VITE_API_URL !== ''
    ? import.meta.env.VITE_API_URL
    : 'http://localhost:3000';

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
