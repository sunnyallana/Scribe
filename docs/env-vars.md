# Environment Variables — Sourcing Guide

This is the *where do I get this value* companion to [`.env.example`](../.env.example).
The example file documents every variable Scribe reads; this guide tells you where each
value actually comes from. Variables marked **required** must be set before the API
will start; everything else has a sensible default.

> Keep `.env` out of version control. The repo already `.gitignore`s it. For a
> production deploy, prefer a secrets manager (Doppler, Vault, AWS SSM, GitHub
> Actions secrets) over a long-lived file on disk.

---

## Quick map

| Variable | Where to get it | Required? |
|---|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string → **Session pooler (5432)** | yes |
| `SUPABASE_URL` | Supabase → Project Settings → API → **Project URL** | yes |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → **anon / public** key | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role** key | yes |
| `SUPABASE_JWT_SECRET` | Supabase → Project Settings → API → **JWT Secret** (legacy "JWT Settings" tab on the old dashboard) | yes |
| `VITE_SUPABASE_URL` | same value as `SUPABASE_URL` | yes |
| `VITE_SUPABASE_ANON_KEY` | same value as `SUPABASE_ANON_KEY` | yes |
| `VITE_API_URL` | URL the SPA should hit; `http://localhost:3000` for dev, your reverse-proxy origin in prod | yes |
| `REDIS_URL` | Your Redis instance; `redis://127.0.0.1:6379` for a local Docker / native install | yes (compile queue won't start otherwise) |
| `AI_KEY_ENCRYPTION_KEY` | `openssl rand -base64 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) | yes if any user enables AI |
| `SMTP_*` | Your SMTP relay (Resend, Postmark, Mailgun, Gmail App Password, …) | optional — falls back to invites-by-link |
| `COMPILE_ENGINE` / `COMPILE_FALLBACK_ENGINE` | `tectonic` or `latexmk` | optional, defaults to `tectonic` |
| `TECTONIC_BIN` / `LATEXMK_BIN` | Absolute path to the binary if not on `$PATH` | optional |
| `CHKTEX_BIN` | Path to `chktex` (ships with TeX Live / MiKTeX) | optional, off when unset |

---

## Supabase values (steps with screenshots in the dashboard)

### 1. Create the project

[Supabase Dashboard](https://supabase.com/dashboard) → **New project**. Pick a region
near your users; the free tier is plenty for a small team. Wait for the project to
finish provisioning before grabbing keys.

### 2. Get the API keys

**Settings → API**. Copy:

- **Project URL** → `SUPABASE_URL` *and* `VITE_SUPABASE_URL`
- **Project API keys → anon public** → `SUPABASE_ANON_KEY` *and* `VITE_SUPABASE_ANON_KEY`
- **Project API keys → service_role** → `SUPABASE_SERVICE_ROLE_KEY`

The `service_role` key bypasses RLS. Treat it like a root password — it goes on the
server only, never to the browser.

### 3. Get the JWT secret

Same **Settings → API** page, scroll to **JWT Settings → JWT Secret** (Supabase's new
dashboard buries it under the legacy block). Copy it into `SUPABASE_JWT_SECRET`. The
server uses it to verify access tokens locally; without it every request would have to
round-trip to `/auth/v1/user`.

### 4. Get the database URL

**Settings → Database → Connection string**. Pick **Session pooler** (port `5432`),
not the direct connection or the transaction pooler — sqlx's prepared statements need
a session-mode pooler to behave. The URL looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Paste it into `DATABASE_URL`. URL-encode any `@` / `:` / `%` in the password.

### 5. Run the migrations

```bash
pnpm supabase:start     # if you're on the local stack
supabase db push        # or apply manually against a hosted project
```

Both `psql` against `DATABASE_URL` and `supabase migration up` work for hosted
projects. Either way, the migrations in [`supabase/migrations/`](../supabase/migrations)
must land before the API starts handling traffic.

---

## Redis

Local install:

```bash
# Linux / macOS
brew install redis && brew services start redis
# or: apt install redis-server && systemctl start redis

# Windows — use the bundled scoop / vcpkg / Memurai distribution, or this repo's
# tested binary at C:\Users\<you>\scribe-tools\redis-5.0.14.1\redis-server.exe
```

Or a one-liner via Docker:

```bash
docker run --rm -d --name scribe-redis -p 6379:6379 redis:7-alpine
```

Either way, `REDIS_URL=redis://127.0.0.1:6379`. The compile queue uses a BLPOP-based
job model on top of plain Redis lists; the Yjs hub and notification fanout use Redis
pub/sub. No Cluster or Sentinel topology needed.

In Docker Compose (see [`self-hosting.md`](./self-hosting.md)), the URL becomes
`redis://redis:6379` because services address each other by service name.

---

## AI key encryption

`AI_KEY_ENCRYPTION_KEY` is a 32-byte secret encoded as base64. Scribe wraps every
user's provider API key with AES-256-GCM at rest; this is the master key.

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Never rotate** this without re-encrypting every row in `users.ai_config`. The
self-hosting guide includes a one-shot re-encryption script; if you're starting fresh,
just pick a value and back it up.

---

## SMTP (optional — for emailed invitations)

Pick one:

| Provider | Quick setup |
|---|---|
| **Resend** | Dashboard → API Keys → create. Use `smtp.resend.com:587`, user `resend`, pass = the API key. |
| **Postmark** | Servers → SMTP credentials. Host `smtp.postmarkapp.com:587`. |
| **Mailgun** | Sending → Domain settings → SMTP credentials. |
| **Gmail / Workspace** | Account → Security → 2FA → App passwords. Host `smtp.gmail.com:465`, port `465`, SSL. |
| **Local dev** | The Supabase CLI ships **Inbucket** on `http://localhost:54324`; configure `SMTP_HOST=127.0.0.1`, `SMTP_PORT=54325`. |

Without SMTP, the invite flow still works — owners just copy the link out of the
"Invite sent" toast and share it through their own channel. Read the toast text
literally; it auto-copies to the clipboard.

---

## OAuth providers (optional — Google / GitHub sign-in)

These live in the Supabase dashboard, not in `.env`:

- **Google** → Auth → Providers → Google. You need a Google Cloud OAuth 2.0 Client ID
  (Console → APIs & Services → Credentials → Create OAuth client). Redirect URL goes
  to `https://<your-supabase>.supabase.co/auth/v1/callback`.
- **GitHub** → Auth → Providers → GitHub. Create an OAuth app at
  [github.com/settings/developers](https://github.com/settings/developers). Same
  callback URL.

Scribe reads neither key from `.env`; the SPA only calls
`supabase.auth.signInWithOAuth({ provider: 'google' })`. The provider must be enabled
in the Supabase project for the flow to land.

---

## Compile engine binaries

Scribe finds compile engines via `$PATH` by default; override the location with
`TECTONIC_BIN` / `LATEXMK_BIN` if they live elsewhere.

| Binary | Install hint |
|---|---|
| `tectonic` | `cargo install tectonic` (cleanest), or download a static release from <https://tectonic-typesetting.github.io/en-US/install.html>. |
| `latexmk` | Ships with TeX Live (`apt install texlive-latex-extra`) and MiKTeX. |
| `pdflatex` / `xelatex` / `lualatex` | Same TeX Live / MiKTeX install. |
| `chktex` | Same TeX Live / MiKTeX install. Optional but recommended. |
| `pandoc` | <https://pandoc.org/installing.html>. Optional, only needed for the Markdown / DOCX export. |

`scripts/setup.sh` / `scripts/setup.ps1` install all of these on a fresh box for
their respective OS; see [`scripts/README.md`](../scripts/README.md).

---

## Observability (optional)

| Variable | Source |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Any OTLP-compatible collector — Honeycomb, Jaeger, Tempo, the OpenTelemetry Collector with a Datadog / New Relic exporter, etc. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Vendor-specific (e.g. `api-key=abc123` for Honeycomb). |
| `SENTRY_DSN` | Sentry → Project Settings → Client Keys (DSN). |

Both default to off — the server falls back to stdout-only `tracing` logs.

---

## Sanity-check

After filling in `.env`, run:

```bash
cargo run --manifest-path servers/rust/Cargo.toml -p scribe-server -- --check-config
```

The `--check-config` flag exits 0 if every required variable parses and zero remote
endpoints (Supabase, Redis, JWKS) are unreachable, and non-zero with a structured
error otherwise. Useful in CI as a smoke test before booting the full server.

---

## Where things commonly go wrong

- **"failed to verify JWT" on every request** — usually `SUPABASE_JWT_SECRET` doesn't
  match the project's actual secret. Copy it again from **Settings → API → JWT Secret**;
  Supabase's dashboard occasionally rotates secrets when projects are reset.
- **"connection refused" on Redis** — service isn't running, or `REDIS_URL` points at
  the wrong port (Docker maps `6379` by default, but custom compose files sometimes
  use `6380` to avoid conflicts).
- **"prepared statement already exists" from sqlx** — `DATABASE_URL` is pointing at the
  *transaction* pooler instead of the *session* pooler. Switch to port 5432.
- **"upload exceeds size limit" or random 413s** — your reverse proxy (nginx, Caddy,
  Cloudflare) has a smaller body limit than `FILE_SIZE_MAX_BYTES`. Match the two.
- **AI features 503 with "AI not configured"** — set `AI_KEY_ENCRYPTION_KEY`; the AI
  service refuses to start without it.
