// End-to-end demo: drives Edge through sign-in, project creation, editing,
// compile, comments, versions. Snapshots each step.

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shotsDir = join(__dirname, '..', 'demo-screenshots');
await mkdir(shotsDir, { recursive: true });

const SUPABASE_URL = 'https://sgmbvxqgowbpyehwmedv.supabase.co';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = 'http://localhost:5173';

const TEST_EMAIL = 'demo@scribe.local';
const TEST_PASSWORD = 'Demo123!demo';

if (!SERVICE_ROLE) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY env var');
  process.exit(1);
}

// Step 1: ensure a confirmed user exists (idempotent — ok if it already does).
async function ensureUser() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: 'Demo User' },
    }),
  });
  if (r.ok) {
    const data = await r.json();
    console.log(`Created confirmed user ${data.id}`);
    return data;
  }
  if (r.status === 422) {
    console.log(`User ${TEST_EMAIL} already exists — proceeding`);
    return null;
  }
  const txt = await r.text();
  throw new Error(`Failed to create user: ${r.status} ${txt}`);
}

const user = await ensureUser();

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

let stepCounter = 1;
async function shot(label, target = page) {
  const num = String(stepCounter++).padStart(2, '0');
  const file = join(shotsDir, `${num}-${label}.png`);
  await target.screenshot({ path: file, fullPage: false });
  console.log(`  📸 ${num}-${label}.png`);
}

async function settle(ms = 600) {
  await page.waitForTimeout(ms);
}

try {
  // ----- Step 1: login page -----
  console.log('• Login page');
  await page.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });
  await shot('login');

  // ----- Step 2: sign in -----
  console.log('• Sign in');
  await page.locator('input[type="email"]').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await settle();
  await shot('dashboard-empty');

  // ----- Step 3: create project -----
  console.log('• Create project');
  await page.getByRole('button', { name: /new project/i }).first().click();
  await settle();
  await shot('new-project-dialog');

  await page.locator('#name').fill('Phase 3 Demo');
  // Pick Article via the Radix select trigger (it's a combobox/listbox, not native).
  await page.locator('#template').click();
  await settle(300);
  await page.getByRole('option', { name: 'Article' }).click();
  await settle(300);
  await page.getByRole('button', { name: /^Create$/ }).click();

  await page.waitForURL(/\/project\//, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await settle(2000);
  await shot('project-opened');

  // ----- Step 4: type into editor -----
  console.log('• Edit content');
  const editor = page.locator('.cm-content').first();
  await editor.waitFor({ state: 'visible', timeout: 15_000 });
  await editor.click();
  // Wait a beat for Yjs to sync + bootstrap from Storage if needed.
  await settle(2000);
  // Select all + replace with a complete LaTeX doc so tectonic has what it needs.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await settle(150);
  const doc = String.raw`\documentclass{article}
\usepackage[utf8]{inputenc}

\title{Phase 3 Demo}
\author{Demo User}
\date{\today}

\begin{document}
\maketitle

\section{Realtime collaboration}
Hello from the live Scribe demo. Two browsers editing this file would see
each others cursors in real time. Math: $e^{i\pi} + 1 = 0$.

\section{What is working}
\begin{itemize}
  \item Yjs over WebSocket with awareness
  \item Comments with threaded replies
  \item Version history snapshots
  \item Tectonic compile via BullMQ + Redis
\end{itemize}

\end{document}
`;
  await page.keyboard.type(doc, { delay: 1 });
  await settle(500);
  await shot('editor-edited');

  // ----- Step 5: compile -----
  console.log('• Compile');
  await page.getByRole('button', { name: /^Compile$/ }).click();
  // Tectonic's first run can take 60–120s (downloads TeX Live resources).
  await page.locator('text=/^(Success|Failed)$/').waitFor({ timeout: 240_000 }).catch(() => {});
  await settle(3000);
  await shot('compiled-pdf');

  // ----- Step 6: open ReviewPanel + add a comment -----
  console.log('• Reviews');
  await page.getByRole('button', { name: /^Reviews$/ }).click();
  await settle();
  await shot('reviews-empty');

  const draft = page.locator('textarea').first();
  await draft.fill('Looks great — minor wording fix on the intro.');
  await settle(200);
  await page.getByRole('button', { name: /add comment/i }).click();
  await settle(1500);
  await shot('reviews-with-comment');

  // Close reviews so version history can open in its place
  await page.getByRole('button', { name: /^Close$/ }).first().click();
  await settle(300);

  // ----- Step 7: Version history snapshot -----
  console.log('• Version history');
  await page.getByRole('button', { name: /^Version history$/ }).click();
  await settle();
  await shot('history-empty');

  await page.getByRole('button', { name: /snapshot now/i }).click();
  await settle(2500);
  await shot('history-snapshot');

  console.log('All steps complete.');
} catch (err) {
  console.error('Demo failed:', err);
  await shot('FAILED');
  process.exitCode = 1;
} finally {
  await browser.close();
}
