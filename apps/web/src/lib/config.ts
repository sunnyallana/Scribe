/**
 * Client-side environment + feature flag config.
 *
 * Mirrors the shape of the server's `AppConfig` so a single mental model
 * covers both halves of the stack. Server-side defaults live in Rust
 * (`crates/scribe-server/src/config.rs`); here we read Vite's
 * `import.meta.env` plus optional runtime overrides from `localStorage`.
 *
 * Resolution order (later wins):
 *   1. Per-env defaults from `DEFAULT_FLAGS[env]`.
 *   2. Vite-time env vars (`VITE_SCRIBE_ENV`, `VITE_FEATURE_<NAME>`).
 *   3. Runtime overrides in `localStorage.SCRIBE_FEATURE_<NAME>` —
 *      lets you flip flags from DevTools without rebuilding.
 *
 * To disable caching right now from the browser:
 *   localStorage.setItem('SCRIBE_FEATURE_API_CACHING', '0')
 *   location.reload()
 */

export type AppEnv = 'development' | 'production' | 'testing';

export interface FeatureFlags {
  /** Send `If-None-Match` + honour `ETag` / `Cache-Control` revalidation
   *  on API GETs. Off → every request bypasses the browser HTTP cache.
   *  Pairs with the server flag of the same name. */
  readonly apiCaching: boolean;
  /** React Query's stale-while-revalidate UX. Off → every query refetches
   *  on mount. Mainly useful for hard-debugging UI staleness. */
  readonly queryRevalidation: boolean;
  /** Yjs WebSocket realtime collab. Off would force solo-mode editing. */
  readonly yjsRealtime: boolean;
  /** Categorised debug logger (`apps/web/src/lib/debug.ts`). Off → silent. */
  readonly debugLogging: boolean;
  /** Expose `window.__scribe` / `window.__scribeDebug` for DevTools
   *  poking. Off in prod by default — no dangling session refs leaked. */
  readonly devGlobals: boolean;
}

const DEFAULT_FLAGS: Record<AppEnv, FeatureFlags> = {
  development: {
    apiCaching: false,         // off in dev — same default as the server
    queryRevalidation: true,
    yjsRealtime: true,
    debugLogging: true,
    devGlobals: true,
  },
  production: {
    apiCaching: true,
    queryRevalidation: true,
    yjsRealtime: true,
    debugLogging: false,
    devGlobals: false,
  },
  testing: {
    apiCaching: false,
    queryRevalidation: false,
    yjsRealtime: false,         // tests use the HTTP API; no WS overhead
    debugLogging: true,
    devGlobals: false,
  },
};

function detectEnv(): AppEnv {
  const raw = import.meta.env.VITE_SCRIBE_ENV;
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'production' || lower === 'prod') return 'production';
    if (lower === 'testing' || lower === 'test') return 'testing';
    if (lower === 'development' || lower === 'dev') return 'development';
  }
  // Fall back to Vite's MODE; default to development for safety so a
  // misconfigured prod build doesn't silently switch to "prod defaults"
  // (which leave debug off + caching on).
  const mode = import.meta.env.MODE;
  if (mode === 'production') return 'production';
  if (mode === 'test') return 'testing';
  return 'development';
}

/** PascalCase → SCREAMING_SNAKE_CASE for env var names. */
function envKeyFor(name: keyof FeatureFlags): string {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function parseBool(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (raw.trim().toLowerCase()) {
    case '1': case 'true': case 'yes': case 'on':
      return true;
    case '0': case 'false': case 'no': case 'off':
      return false;
    default:
      return null;
  }
}

function readFlag(name: keyof FeatureFlags, fallback: boolean): boolean {
  const envKey = `VITE_FEATURE_${envKeyFor(name)}`;
  // localStorage override wins (runtime toggle from DevTools).
  try {
    if (typeof localStorage !== 'undefined') {
      const lsKey = `SCRIBE_FEATURE_${envKeyFor(name)}`;
      const v = parseBool(localStorage.getItem(lsKey));
      if (v !== null) return v;
    }
  } catch {
    /* localStorage unavailable (SSR / private mode) — ignore */
  }
  const raw = (import.meta.env as Record<string, string | undefined>)[envKey];
  const v = parseBool(raw);
  return v !== null ? v : fallback;
}

export const env: AppEnv = detectEnv();

export const features: FeatureFlags = (() => {
  const base = DEFAULT_FLAGS[env];
  return {
    apiCaching: readFlag('apiCaching', base.apiCaching),
    queryRevalidation: readFlag('queryRevalidation', base.queryRevalidation),
    yjsRealtime: readFlag('yjsRealtime', base.yjsRealtime),
    debugLogging: readFlag('debugLogging', base.debugLogging),
    devGlobals: readFlag('devGlobals', base.devGlobals),
  };
})();

/** Convenience boolean queried at every call site that cares. Read it as
 *  `if (isDev) ...` — equivalent to `env === 'development'` but cheaper
 *  to chain. */
export const isDev: boolean = env === 'development';
export const isProd: boolean = env === 'production';
export const isTest: boolean = env === 'testing';

// Best-effort runtime toggle from DevTools:
//   __scribeConfig.setFeature('apiCaching', true)
//   __scribeConfig.dump()
if (typeof window !== 'undefined' && features.devGlobals) {
  (window as unknown as { __scribeConfig?: unknown }).__scribeConfig = {
    env,
    features,
    setFeature: (name: keyof FeatureFlags, value: boolean) => {
      try {
        localStorage.setItem(`SCRIBE_FEATURE_${envKeyFor(name)}`, value ? '1' : '0');
        // eslint-disable-next-line no-console
        console.info(`[Scribe:config] ${String(name)} = ${value} — reload to apply`);
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[Scribe:config] localStorage unavailable; couldn't set ${String(name)}`);
      }
    },
    dump: () => ({ env, features }),
  };
}
