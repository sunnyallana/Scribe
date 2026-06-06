# Scripts

Operational tooling for Scribe. Pick the folder for your OS — each holds
the same three scripts (`setup`, `run`, `run-desktop`). The cross-platform
`.env` wizard sits at the top level; everything else is grouped under
three helper subfolders.

```
scripts/
├── README.md              ← you are here
├── setup-env.mjs          ← interactive .env wizard (validates keys, finds your DB host)
├── setup-env-browser.mjs  ← optional dashboard credential capture (used by setup-env)
├── seed-user.mjs          ← create a confirmed login so you're not stuck on sign-in
├── linux-macos/           ← Linux (apt / dnf / pacman) + macOS (brew)
│   ├── setup.sh                 one-shot install
│   ├── run.sh                   start Redis + API + Vite SPA together
│   └── run-desktop.sh           start Redis + API + Tauri desktop together
├── windows/               ← Windows 10/11 (winget)
│   ├── setup.ps1                one-shot install
│   ├── run.ps1                  start Redis + API + Vite SPA together
│   └── run-desktop.ps1          start Redis + API + Tauri desktop together
├── migrations/            ← one-shot DB migration runners (config from .env)
│   ├── env.mjs                  shared: derive project ref / password / host from .env
│   ├── apply-migrations.mjs     bulk: every .sql in supabase/migrations
│   ├── apply-share-links.mjs    20260524000002_project_share_links.sql
│   ├── apply-notifications.mjs  20260524000003_notifications.sql
│   └── apply-suggestions.mjs    20260524000004_comment_suggestions.sql
├── probes/                ← read-only DB / auth diagnostics
│   └── probe-*.mjs              (auth, RLS, triggers, helpers, …)
└── utils/                 ← misc helpers
    └── test-jwt.mjs             local JWT verifier
```

## Quick start

| OS                                   | Setup (once)                     | Browser run                    | Desktop run                            |
| ------------------------------------ | -------------------------------- | ------------------------------ | -------------------------------------- |
| Linux (Debian, Ubuntu, Fedora, Arch) | `./scripts/linux-macos/setup.sh` | `./scripts/linux-macos/run.sh` | `./scripts/linux-macos/run-desktop.sh` |
| macOS                                | `./scripts/linux-macos/setup.sh` | `./scripts/linux-macos/run.sh` | `./scripts/linux-macos/run-desktop.sh` |
| Windows 10/11                        | `.\scripts\windows\setup.ps1`    | `.\scripts\windows\run.ps1`    | `.\scripts\windows\run-desktop.ps1`    |

Full first-run order: **setup** → `node scripts/setup-env.mjs` (fills `.env`)
→ `pnpm exec supabase db push` (migrations) → `node scripts/seed-user.mjs`
(your first login) → **run**.

## What `setup` installs

- **Node 22+** (via NodeSource on apt, `nodejs:22` module on dnf, `nodejs` on pacman, `node@22` on brew, `OpenJS.NodeJS.LTS` on winget). pnpm 11 requires Node ≥22.13.
- **pnpm** via `corepack enable` once Node is in place.
- **Rust toolchain** via `rustup` (minimal profile). Skip with `--skip-rust` (Linux/macOS) or `-SkipRust` (Windows) if you already have it.
- **Redis** — required by the compile queue. Native packages on Linux/macOS; the [tporadowski Windows port](https://github.com/tporadowski/redis) extracted to `~/scribe-tools/redis-5.0.14.1/` on Windows.
- **Tectonic** — LaTeX engine. Brew/curl on Linux/macOS; release zip from GitHub on Windows.
- **Build essentials** (Linux only): `build-essential` / `gcc gcc-c++ make` / `base-devel` so `cargo build` can link native crates.
- **Optional**: `pandoc` (for export to .md/.docx) and `chktex` (style linter). Skip with `--no-optional` / `-NoOptional`.

It then runs `pnpm install`, builds the `@scribe/*` workspace packages (their `dist/` outputs are what Vite resolves), and runs `cargo build` so a `run` after this won't pause for compile. The `run` scripts also rebuild the workspace packages automatically if the `dist/` outputs ever go missing (e.g. after `pnpm clean`).

## What `run` starts

1. **Redis** on `127.0.0.1:6379` if it isn't already listening. The script only stops Redis if _it_ started it — already-running instances are left alone.
2. **Rust API** (`cargo run -p scribe-server`). Reads `.env`; port from `PORT` (default `3000`).
3. **Vite SPA** (`pnpm --filter @scribe/web dev`) on `:5173`.

Output from API and SPA is multiplexed with `[api]` / `[web]` line prefixes so a single terminal is enough. `Ctrl+C` tears all three down cleanly.

## What `run-desktop` starts

Use this when you want to drive the native Tauri window instead of the browser SPA.

1. **Redis** + **Rust API** — same as above.
2. **Tauri desktop** (`pnpm --filter @scribe/desktop tauri dev`). Tauri's own `beforeDevCommand` spawns the Vite SPA on `:5173` as a child, so don't run the `run` script at the same time — port 5173 must be free (the script pre-checks and bails out fast if it isn't).

Output is prefixed `[api]` / `[tauri]`. First launch links the Rust shell from scratch (~1–2 min); subsequent launches reuse cargo's incremental cache.

## `.env`

The interactive wizard asks for the four values only you can provide and
derives, validates, and writes everything else:

```bash
node scripts/setup-env.mjs
```

Easiest path: say **yes** to the browser option — the wizard opens your
Supabase dashboard, you log in (use **GitHub or email/password**; Google
blocks automated browsers), and it captures the project URL + both API
keys by itself (and can reset the database password for you). It drives
your installed Chrome/Edge via `playwright-core`. On Windows that's Edge,
already present. If you have no Chrome/Edge (common on Linux), grab
Playwright's Chromium once with `pnpm exec playwright-core install chromium`,
then re-run with `SCRIBE_DASHBOARD_BROWSER=chromium`. If the browser can't
start, the wizard just falls back to manual entry below.

Otherwise you'll be prompted for the Supabase **project URL**,
**publishable/anon key**, **secret/service_role key**, and **database
password** (reset it under Settings → Database if unknown — the dashboard
never displays it).
The wizard validates each key against your live project, sweeps the
regional poolers to discover the right `DATABASE_URL` host (the direct
`db.<ref>` endpoint is IPv6-only), reads your JWKS to decide whether
`SUPABASE_JWT_SECRET` is even needed (ES256/RS256 projects: no),
generates `AI_KEY_ENCRYPTION_KEY` locally, auto-detects tectonic, and
mirrors the `VITE_*` pair. Existing `.env` files are backed up first.
Both key generations work: new `sb_publishable_…`/`sb_secret_…` API keys
and legacy `eyJ…` JWTs.

To fill things in by hand instead: `setup` copies `.env.example` → `.env`
on first run and warns. Before `run` works, you need at minimum:

- `DATABASE_URL` — Supabase Postgres connection string (session pooler, port 5432).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`.
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values).
- `REDIS_URL=redis://127.0.0.1:6379` (already in `.env.example`).
- Optional: `TECTONIC_BIN`, `CHKTEX_BIN`, `AI_KEY_ENCRYPTION_KEY` (`openssl rand -base64 32`).

Windows path values (`TECTONIC_BIN` etc.) must use **forward slashes** —
dotenv parsers treat backslashes in unquoted values as escape characters
and silently drop the line.

## First login (so you're not stuck on the sign-in page)

A new Supabase project has email confirmation on and no SMTP, so signing
up through the app's UI never completes — the confirmation link never
arrives. Create a ready-to-use account instead:

```bash
node scripts/seed-user.mjs                          # prompts for email + password
node scripts/seed-user.mjs you@example.com hunter2  # or pass them as args
```

It uses the service-role key from `.env` and the GoTrue admin API with
`email_confirm: true`, so the account works for login immediately. **Run
it after `supabase db push`** — account creation fires the
`handle_new_user` trigger (shipped in the migrations) that creates the
profile row. The `setup-env.mjs` wizard also offers this automatically,
but only once it detects the schema is migrated.

## Distro-specific notes

- **Fedora / RHEL family**: `dnf module enable nodejs:22` is invoked to make sure Node 22 is the active stream. If your org pins a different module, the script's `module reset` will fight it — install Node yourself first if so.
- **Arch / Manjaro**: chktex lives inside `texlive-binextra`, not its own package. That's a ~200 MB install — pass `--no-optional` if you want to defer it.
- **Windows**: requires winget (ships with Windows 11; on Windows 10 install "App Installer" from the Microsoft Store first). Run the script from a regular PowerShell — elevation prompts come up per-installer. If you get **"running scripts is disabled on this system"** (the default execution policy on fresh installs), invoke it as `powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1` — same for `run.ps1` / `run-desktop.ps1`.

## Troubleshooting

- **`compile queue not configured`** in the SPA → Redis isn't listening. Re-run `run` or start it manually (`redis-server` / `~/scribe-tools/redis-5.0.14.1/redis-server.exe`).
- **`Couldn't connect to any Supabase Postgres endpoint`** → DATABASE_URL is unset or pointing at the wrong pooler. Check the Supabase dashboard → Settings → Database for the session-pooler string.
- **`linker 'cc' not found`** during `cargo build` on a fresh Linux box → the build-essentials install in `setup.sh` didn't run (you used `--skip-rust` and bypassed the section). Install your distro's compiler toolchain and re-run.
- **`pnpm install` hangs at "Choose pnpm version"** → corepack's first-run prompt. The scripts set `CI=true` to dodge it; if you re-ran pnpm by hand, prefix the command with `CI=true`.

## Running the helpers under `migrations/`, `probes/`, `utils/`

All of them are plain `node` invocations from the **repo root**:

```bash
# Apply one migration — project ref, password, and host come from .env
# (DATABASE_URL / SUPABASE_URL, as written by scripts/setup-env.mjs)
node scripts/migrations/apply-share-links.mjs

# Override the .env-derived values explicitly when needed
SUPABASE_PROJECT_REF=… SUPABASE_DB_PASSWORD=… node scripts/migrations/apply-migrations.mjs

# Run a diagnostic probe
SUPABASE_SERVICE_ROLE_KEY=… node scripts/probes/probe-auth.mjs

# Refresh the demo screenshots
SUPABASE_SERVICE_ROLE_KEY=… node scripts/utils/demo.mjs
```

The migration runners share [`migrations/env.mjs`](./migrations/env.mjs),
which derives the project ref + database password from `.env`
(`SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD` env vars override it) and
tries `DATABASE_URL`'s host first before sweeping the regional poolers.
All scripts resolve `supabase/migrations/` via `__dirname/../..`, so they
work as long as you don't move them out of their subfolder.
