import { defineConfig, devices } from '@playwright/test';

// Smoke E2E suite. Runs against the built SPA via `vite preview` —
// no live API / Supabase / Redis required. Specs in `./e2e/` exercise
// the unauthenticated routing surface (login, signup, forgot, invite,
// share) plus the public landing. Anything that needs a real session
// is parked under a `.skip` for now; the path to a real signup→compile
// flow lives in `docs/self-hosting.md` and runs against a throwaway
// Supabase project as a manual pre-release step.
//
// Run locally:    pnpm e2e
// Install browser: pnpm e2e:install   (one-shot, ~150 MB)

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  // Smoke specs are deliberately small and fast — keep the timeout
  // tight so a flaky test gets noticed instead of papered over.
  timeout: 15_000,
  expect: { timeout: 5_000 },
  // CI: bail on the first failure so we don't burn 5 minutes printing
  // a cascade of the same root cause. Locally: keep going so the dev
  // sees all broken specs in one run.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // `workers: undefined` would let Playwright pick a default based on
  // CPU count, but `exactOptionalPropertyTypes: true` in this repo
  // forbids assigning `undefined` to an optional field. Conditional
  // spread keeps the field absent locally and pins it to 1 in CI.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT.toString()}`,
    // `trace: on-first-retry` keeps artefact size sane in green-path
    // CI runs while still giving full debug info for a flake.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Auto-spawn the preview server. Playwright waits for the URL to be
  // reachable before running specs, then tears it down on exit. CI
  // sets `reuseExistingServer: false` so a stale port doesn't mask a
  // build-failure; locally we reuse if you already have it running.
  webServer: {
    command: 'pnpm --filter @scribe/web preview',
    url: `http://127.0.0.1:${PORT.toString()}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    // The SPA boot needs a few env vars to satisfy `lib/config.ts`'s
    // strict parser. We don't need real Supabase — the smoke specs
    // never reach an authenticated route — but the vars must be set
    // to avoid a hard error at module-load. CI passes real values via
    // workflow secrets so the build itself succeeds.
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? 'e2e-placeholder-anon-key',
      VITE_API_URL: process.env.VITE_API_URL ?? 'http://localhost:3000',
    },
  },
});
