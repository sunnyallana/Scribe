// Vitest config layered on top of vite.config.ts via `mergeConfig`.
// Inherits `envDir`, `resolve.alias`, and everything else vite's
// config already declares, then adds:
//   • the test-collection scope, so the Playwright specs under `e2e/`
//     don't get loaded by vitest (they use @playwright/test's globals,
//     which collide with vitest's).
//
// Why this isn't just `test:` on vite.config.ts: `vitest/config`'s
// `defineConfig` brings in a vite-5 view of types that disagrees with
// the installed vite-6, and `tsc --noEmit` then fails. Keeping the two
// configs separate but merged at runtime sidesteps the type clash.

import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['node_modules', 'dist', 'e2e/**', 'playwright-report', 'test-results'],
    },
  }),
);
