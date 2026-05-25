// Smoke E2E suite. Runs against the built SPA served by `vite preview`.
// No live API / Supabase / Redis — we only assert routing + static UI
// renders without crashing. Anything that requires a real session
// (dashboard / project editor / compile) is parked behind a `.skip`
// with a comment on what would unlock it.
//
// The goal here is to catch the "PR broke the SPA bundle" or "router
// config regressed" class of bug — failures that wouldn't show up in
// vitest's pure-function tests but would be the first thing a user
// hits after deploy.

import { expect, test } from '@playwright/test';

test.describe('static routing', () => {
  test('root redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/');
    // RootLayout → AuthGuard → redirect to /login when no session.
    await expect(page).toHaveURL(/\/login$/);
  });

  test('login page renders sign-in form', async ({ page }) => {
    await page.goto('/login');
    // Page title comes straight from index.html — pinned so a tab-strip
    // regression (e.g. someone setting document.title client-side and
    // forgetting the fallback) gets caught.
    await expect(page).toHaveTitle(/Scribe/);
    // Both form fields visible. The headings/buttons can change wording
    // through i18n, but `input[type='email']` and `input[type='password']`
    // are structural — if those aren't on the page, sign-in is broken.
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    // "Sign in" submit button. Use `getByRole` so the test survives a
    // visual rewrite as long as the accessible name is preserved.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('login page links to signup', async ({ page }) => {
    await page.goto('/login');
    const signupLink = page.getByRole('link', { name: 'Sign up' });
    await expect(signupLink).toBeVisible();
    await signupLink.click();
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('signup page renders signup form', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    // The dedicated signup form has a "Sign up" submit; if a future
    // refactor merges login/signup, this assertion is what'll surface
    // the regression.
    await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible();
  });

  test('forgot-password page renders', async ({ page }) => {
    await page.goto('/forgot');
    // Just verify the email-only form rendered. No submit happens —
    // we never reach Supabase.
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('unknown route falls through to 404', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    // The NotFoundPage owns the route; locale strings change, so we
    // assert on the HTTP-status semantic of the rendered text. The
    // page is served 200 (SPA fallback) — we check the body text
    // for the 404 marker.
    await expect(page.getByText(/404|not found/i)).toBeVisible();
  });

  test('invite page with invalid token shows the appropriate error', async ({ page }) => {
    // The /invite/:token route accepts any string; it's the API that
    // rejects the token. We can at least verify the page renders
    // without crashing — even though it'll show a "loading" or
    // "invalid" state because the API isn't reachable here.
    await page.goto('/invite/this-is-not-a-real-token');
    // Don't assert on the exact error text — it varies by what the
    // network call returns. Just verify we landed on the route and
    // SOMETHING rendered (i.e. the SPA didn't white-screen).
    await expect(page).toHaveURL(/\/invite\/this-is-not-a-real-token$/);
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

test.describe('SPA bundle health', () => {
  test('no unhandled console errors on login boot', async ({ page }) => {
    // Catches the "missing dependency in the production bundle" class
    // of regression — the SPA hard-crashes silently and the user sees
    // a blank page. We listen for any console.error during the
    // initial render and fail if anything fires.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    await page.goto('/login');
    // Give React + the router a moment to finish their initial pass.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // Filter out errors that are network-related (Supabase 401 / API
    // unreachable / favicon 404) — those are expected without a live
    // backend. Anything else is a real bundle-level regression.
    const real = errors.filter(
      (e) =>
        !/Failed to load resource/i.test(e) &&
        !/net::ERR_/i.test(e) &&
        !/supabase/i.test(e) &&
        !/401|403|404/.test(e),
    );
    expect(real, real.join('\n')).toHaveLength(0);
  });
});

test.describe('full-stack flow (parked)', () => {
  // These specs need a live API + Supabase + Redis. Wiring them up
  // requires either docker-compose-in-CI or a throwaway hosted
  // Supabase project plus the runner installing tectonic. Tracked as
  // "Phase 5b" — punt until someone wires the infrastructure once.

  test.skip('signup → create project → compile → see PDF', () => {
    // Steps when this is filled in:
    //   1. page.goto('/signup'), fill email+password+display_name, submit
    //   2. The local Supabase Inbucket exposes the verification email
    //      on http://localhost:54324 — fetch it, click the link
    //   3. Land on /dashboard, click "New project", pick "Article"
    //   4. Type into the editor, hit Ctrl+Enter to compile
    //   5. Assert the PDFPreview panel shows >=1 page
  });
});
