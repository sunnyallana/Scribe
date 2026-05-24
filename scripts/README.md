# Scripts

Operational tooling for Scribe. Top level holds the six user-facing
scripts; everything else is grouped under three subfolders.

```
scripts/
├── README.md              ← you are here
├── setup.sh               ← one-shot install (Linux + macOS)
├── setup.ps1              ← one-shot install (Windows)
├── run.sh                 ← start Redis + API + Vite SPA together
├── run.ps1                ← start Redis + API + Vite SPA together (Windows)
├── run-desktop.sh         ← start Redis + API + Tauri desktop together
├── run-desktop.ps1        ← start Redis + API + Tauri desktop together (Windows)
├── migrations/            ← one-shot DB migration runners
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

| OS                                      | Setup (once)              | Browser run              | Desktop run                    |
|-----------------------------------------|---------------------------|--------------------------|--------------------------------|
| Linux (Debian, Ubuntu, Fedora, Arch)    | `./scripts/setup.sh`      | `./scripts/run.sh`       | `./scripts/run-desktop.sh`     |
| macOS                                   | `./scripts/setup.sh`      | `./scripts/run.sh`       | `./scripts/run-desktop.sh`     |
| Windows 10/11                           | `.\scripts\setup.ps1`     | `.\scripts\run.ps1`      | `.\scripts\run-desktop.ps1`    |

## What `setup` installs

- **Node 20+** (via NodeSource on apt, `nodejs:20` module on dnf, `nodejs` on pacman, `node@20` on brew, `OpenJS.NodeJS.LTS` on winget).
- **pnpm** via `corepack enable` once Node is in place.
- **Rust toolchain** via `rustup` (minimal profile). Skip with `--skip-rust` (Linux/macOS) or `-SkipRust` (Windows) if you already have it.
- **Redis** — required by the compile queue. Native packages on Linux/macOS; the [tporadowski Windows port](https://github.com/tporadowski/redis) extracted to `~/scribe-tools/redis-5.0.14.1/` on Windows.
- **Tectonic** — LaTeX engine. Brew/curl on Linux/macOS; release zip from GitHub on Windows.
- **Build essentials** (Linux only): `build-essential` / `gcc gcc-c++ make` / `base-devel` so `cargo build` can link native crates.
- **Optional**: `pandoc` (for export to .md/.docx) and `chktex` (style linter). Skip with `--no-optional` / `-NoOptional`.

It then runs `pnpm install` and `cargo build` so a `run` after this won't pause for compile.

## What `run` starts

1. **Redis** on `127.0.0.1:6379` if it isn't already listening. The script only stops Redis if *it* started it — already-running instances are left alone.
2. **Rust API** (`cargo run -p scribe-server`). Reads `.env`; port from `PORT` (default `3000`).
3. **Vite SPA** (`pnpm --filter @scribe/web dev`) on `:5173`.

Output from API and SPA is multiplexed with `[api]` / `[web]` line prefixes so a single terminal is enough. `Ctrl+C` tears all three down cleanly.

## What `run-desktop` starts

Use this when you want to drive the native Tauri window instead of the browser SPA.

1. **Redis** + **Rust API** — same as above.
2. **Tauri desktop** (`pnpm --filter @scribe/desktop tauri dev`). Tauri's own `beforeDevCommand` spawns the Vite SPA on `:5173` as a child, so don't run `./scripts/run.sh` at the same time — port 5173 must be free (the script pre-checks and bails out fast if it isn't).

Output is prefixed `[api]` / `[tauri]`. First launch links the Rust shell from scratch (~1–2 min); subsequent launches reuse cargo's incremental cache.

## `.env`

`setup` copies `.env.example` → `.env` on first run and warns. Before `run` works, you need to fill in at minimum:

- `DATABASE_URL` — Supabase Postgres connection string (session pooler, port 5432).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`.
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values).
- `REDIS_URL=redis://127.0.0.1:6379` (already in `.env.example`).
- Optional: `TECTONIC_BIN`, `CHKTEX_BIN`, `AI_KEY_ENCRYPTION_KEY` (`openssl rand -base64 32`).

## Distro-specific notes

- **Fedora / RHEL family**: `dnf module enable nodejs:20` is invoked to make sure Node 20 is the active stream. If your org pins a different module, the script's `module reset` will fight it — pass `--skip-rust` is the wrong flag for this; just install Node yourself first.
- **Arch / Manjaro**: chktex lives inside `texlive-binextra`, not its own package. That's a ~200 MB install — pass `--no-optional` if you want to defer it.
- **Windows**: requires winget (ships with Windows 11; on Windows 10 install "App Installer" from the Microsoft Store first). Run the script from a regular PowerShell — elevation prompts come up per-installer.

## Troubleshooting

- **`compile queue not configured`** in the SPA → Redis isn't listening. Re-run `run` or start it manually (`redis-server` / `~/scribe-tools/redis-5.0.14.1/redis-server.exe`).
- **`Couldn't connect to any Supabase Postgres endpoint`** → DATABASE_URL is unset or pointing at the wrong pooler. Check the Supabase dashboard → Settings → Database for the session-pooler string.
- **`linker 'cc' not found`** during `cargo build` on a fresh Linux box → the build-essentials install in `setup.sh` didn't run (you used `--skip-rust` and bypassed the section). Install your distro's compiler toolchain and re-run.
- **`pnpm install` hangs at "Choose pnpm version"** → corepack's first-run prompt. The scripts set `CI=true` to dodge it; if you re-ran pnpm by hand, prefix the command with `CI=true`.

## Running the helpers under `migrations/`, `probes/`, `utils/`

All of them are plain `node` invocations from the **repo root**:

```bash
# Apply one migration
SUPABASE_DB_PASSWORD=… node scripts/migrations/apply-share-links.mjs

# Run a diagnostic probe
SUPABASE_SERVICE_ROLE_KEY=… node scripts/probes/probe-auth.mjs

# Refresh the demo screenshots
SUPABASE_SERVICE_ROLE_KEY=… node scripts/utils/demo.mjs
```

The migration / utility scripts hard-code the project ref and resolve
`supabase/migrations/` via `__dirname/../..`, so they work as long as
you don't move them out of their subfolder.
