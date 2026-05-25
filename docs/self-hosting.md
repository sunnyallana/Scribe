# Self-Hosting Scribe

A one-host Docker recipe for running Scribe on your own infrastructure. Designed for
a small team / lab; the same image scales out behind a reverse proxy when you
outgrow it.

> Looking for the _day-to-day developer_ setup (hot-reload, no Docker)? Read
> [Run from source](../README.md#run-from-source) in the root README. This document
> is for **deploying** an instance, not iterating on the code.

---

## What you'll end up with

```
                ┌────────────────────────────────────────────┐
                │  Your reverse proxy (Caddy / nginx / Traefik) │
                │  - TLS termination                          │
                │  - WebSocket upgrade /api/yjs               │
                └─────────────────────┬──────────────────────┘
                                      │
                ┌─────────────────────▼──────────────────────┐
                │  scribe-app (container)                     │
                │  - Axum API on :3000                        │
                │  - Yjs WebSocket hub                        │
                │  - Compile worker (tectonic baked in)       │
                │  - Serves the SPA bundle on /               │
                └───────┬──────────────────────┬──────────────┘
                        │                      │
                ┌───────▼──────┐    ┌──────────▼────────────┐
                │  scribe-redis│    │  Supabase (external)  │
                │  - queue     │    │  - Postgres + RLS     │
                │  - pubsub    │    │  - Auth (JWT)         │
                │  - L2 cache  │    │  - Storage (PDFs etc) │
                └──────────────┘    └───────────────────────┘
```

Two containers (`scribe-app`, `scribe-redis`) plus your choice of Supabase backend
(hosted free tier or `supabase start` locally). Operators add a reverse proxy in
front for TLS — Scribe terminates plain HTTP inside the container.

---

## Prerequisites

| Need               | Version                                | Why                                                                                                  |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Docker             | 24+                                    | Builds the image, runs the stack                                                                     |
| docker compose     | v2 (the plugin, not the legacy script) | `docker compose up`, multi-service                                                                   |
| A Supabase project | latest                                 | Auth, Postgres, Storage                                                                              |
| ~2 GB free disk    | —                                      | Image is ~600 MB, tectonic cache adds ~100 MB after the first compile                                |
| A domain + TLS     | optional                               | Required only if you want HTTPS / `scribe://invite/<token>` deep-link redirects to look professional |

You do _not_ need Rust, Node, pnpm, or a TeX distribution installed on the host —
they all live inside the build container. The runtime image carries tectonic as a
static binary.

---

## 1. Set up Supabase

Two ways: hosted (recommended for getting started) or local (good for air-gapped
testing).

### Hosted

1. <https://supabase.com/dashboard> → **New project**. Free tier is fine.
2. Wait for the project to provision.
3. Apply Scribe's migrations:

   ```bash
   # From the repo root, with `supabase` CLI installed:
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   Or run `supabase/migrations/*.sql` against `DATABASE_URL` with `psql` directly.

4. Copy the four secrets from **Settings → API** and the connection string from
   **Settings → Database → Connection string → Session pooler (5432)** into your
   `.env` — see [env-vars.md](./env-vars.md) for exactly which field maps where.

### Local

```bash
pnpm supabase:start
```

Reads `supabase/config.toml`, brings up Postgres + Auth + Storage + Inbucket
(catches outgoing email) in their own Docker network. Run `supabase status` after
boot — it prints every URL and key you need verbatim, copy them into `.env`.

When you point Scribe's Docker compose at a local Supabase, Docker's default
`bridge` network can't reach `host.docker.internal` on Linux without an extra
flag. Either run Supabase inside the same compose project (advanced — pin Supabase's
compose to the `scribe-net` network in your override file) or use the hosted flow
for any deployment that survives a reboot.

---

## 2. Write `.env`

```bash
cp .env.example .env
```

Fill in at minimum:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
SUPABASE_JWT_SECRET=<from Settings → API → JWT Secret>
DATABASE_URL=postgresql://postgres.<ref>:<pwd>@<region>.pooler.supabase.com:5432/postgres

VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
VITE_API_URL=https://scribe.your-domain.tld

AI_KEY_ENCRYPTION_KEY=<openssl rand -base64 32>

CORS_ORIGIN=https://scribe.your-domain.tld
```

`docker-compose.yml` overrides `REDIS_URL`, `HOST`, and `PORT` to compose-network
values so anything you put in `.env` for those three is ignored — that's intentional.

Every variable is documented inline in [`.env.example`](../.env.example); every
_value source_ (where to obtain it) is documented in [env-vars.md](./env-vars.md).

---

## 3. Build & start

```bash
docker compose build       # ~6–10 min the first time, cached after
docker compose up -d
docker compose logs -f app # watch the boot sequence
```

You should see, in order:

1. `config loaded` with `env=production` (or whatever `SCRIBE_ENV` you set).
2. `connected to redis at redis:6379`.
3. `jwks cache primed for issuer ...` (Scribe reaches Supabase Auth's JWKS endpoint to
   pre-verify the first batch of tokens).
4. `compile worker spawned (n=N)` — N defaults to `CPUs / 2` rounded up.
5. `listening on 0.0.0.0:3000`.

Health check: `curl http://localhost:3000/api/health` returns `200 OK` with a JSON
body. Compose's healthcheck polls the same endpoint every 15 s.

---

## 4. Put a reverse proxy in front

Scribe is HTTP-only inside the container. For anything Internet-facing, terminate
TLS at a reverse proxy. The minimal Caddyfile:

```caddy
scribe.your-domain.tld {
  reverse_proxy localhost:3000 {
    # Yjs WebSocket. Without these, the editor falls back to solo mode
    # after the collab timeout (2.5 s).
    header_up Upgrade {>Upgrade}
    header_up Connection {>Connection}
  }
}
```

nginx is the same idea but more typing — see Caddy's docs for the proxy_pass
equivalents. The key bits:

- TLS termination outside the container (Scribe trusts the `X-Forwarded-*` headers
  Caddy / nginx set).
- WebSocket upgrade headers must pass through, otherwise the realtime layer dies.
- Body limit must equal or exceed `FILE_SIZE_MAX_BYTES` (default 50 MiB).

If you're putting Scribe behind Cloudflare, set the **Bypass cache** rule on
`/api/yjs/*` — Cloudflare's default WebSocket handling is fine, but it will try to
cache the SSE-streamed `/api/ai/complete` body and ruin streaming responses.

---

## 5. Promote a first user

By default the dashboard is empty after a fresh install. Sign up via the web UI
(`https://scribe.your-domain.tld/signup`) — the first user is just a normal user; admin
permissions live at the Supabase level. To grant a user the ability to upgrade their
plan or change shared settings later, you'd run SQL via the Supabase SQL editor.

---

## Day-2 operations

### Logs

```bash
docker compose logs -f app
docker compose logs -f redis
```

Both stream structured JSON when `SCRIBE_ENV=production`. Pipe to `jq` for ad-hoc
filtering:

```bash
docker compose logs --no-color app | jq 'select(.level=="error")'
```

### Backups

The container is stateless. **Everything that matters is in Supabase Postgres and
Storage** — back those up via Supabase's own scheduled backups (paid plans) or
`pg_dump` against `DATABASE_URL`.

The two named volumes:

- `redis-data`: compile queue contents. Losing it cancels any in-flight compile;
  users hit "Compile" again and life goes on.
- `tectonic-cache`: CTAN package cache. Losing it makes the next cold compile slow
  (~15 s instead of 4 s); after that, normal.

Neither needs offsite backup.

### Upgrades

```bash
git pull
docker compose build
docker compose up -d
```

Compose recreates only the services whose image changed; Redis stays up.

Migrations: any new `supabase/migrations/*.sql` files need to be applied against
the hosted Supabase project before the new image starts (the server will refuse to
boot if `sqlx` query checks fail against an older schema). Run
`supabase db push` from your dev machine after `git pull` and before
`docker compose up`.

### Resource budget

Defaults to a single 2-vCPU / 2 GiB instance:

| Workload                                           | CPU                         | RAM      |
| -------------------------------------------------- | --------------------------- | -------- |
| Idle                                               | 0.05 vCPU                   | ~80 MiB  |
| One concurrent compile                             | 1 vCPU (tectonic CPU-bound) | ~250 MiB |
| 4 concurrent compiles                              | ~2.5 vCPU                   | ~700 MiB |
| Yjs hub with 20 active projects, ~50 collaborators | <0.1 vCPU                   | +50 MiB  |

The compile worker dominates resource usage. If users mostly write rather than
compile, you can comfortably host a small team on a $5–10 VPS. For heavy use, scale
horizontally: build the same image, run multiple containers behind a load
balancer, point all of them at the same Redis + Supabase. Redis serialises which
worker picks each compile job, so concurrency is safe across replicas.

---

## Troubleshooting

| Symptom                                                                | Likely cause                                     | Fix                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App container restart-loops with `failed to verify JWT`                | `SUPABASE_JWT_SECRET` mismatch                   | Recopy from Supabase → Settings → API → JWT Secret                                                                                                               |
| Boots, but compiling never finishes                                    | Redis not reachable                              | `docker compose logs redis`; check `REDIS_URL` resolves inside the network                                                                                       |
| Compile fails with `tectonic: package not found` for an exotic package | Bundle missing it                                | Set `COMPILE_FALLBACK_ENGINE=latexmk` and install MiKTeX/TeX Live on the host (then mount it into the container, or rebuild a custom image with TeX Live inside) |
| WebSocket disconnects every ~30 s                                      | Reverse proxy idle timeout                       | `nginx`: raise `proxy_read_timeout`; Caddy: default is fine; Cloudflare free tier caps at 100 s — sometimes you have to live with it                             |
| `prepared statement already exists` on every query                     | `DATABASE_URL` uses the transaction pooler       | Switch to the **session** pooler (port 5432)                                                                                                                     |
| AI requests 503 immediately                                            | `AI_KEY_ENCRYPTION_KEY` missing or non-base64    | `openssl rand -base64 32`, restart                                                                                                                               |
| Big `.tex` upload fails with 413                                       | Reverse proxy body limit < `FILE_SIZE_MAX_BYTES` | Raise the proxy's `client_max_body_size` (nginx) or default request body limit (Caddy auto-handles this in v2.7+)                                                |

---

## When to _not_ use Docker

If you're running Scribe on a single laptop or dev machine, the source-based flow
(`pnpm dev` + `cargo run`) is faster than rebuilding the Docker image on each
change. Switch to Docker for shared deployments.

If you want everything in one binary with no Docker at all, the prebuilt server
binary from a GitHub release plus a systemd unit file will get you there. See
[`docs/architecture.png`](./architecture.png) for the layered view; the system unit
file is a 10-line wrapper around the binary with `EnvironmentFile=/etc/scribe.env`.

---

## What's next

- Reverse proxy / TLS — pick Caddy, nginx, or Traefik per your usual ops setup.
- Backups — Supabase's scheduled backups or your own `pg_dump`.
- Monitoring — set `OTEL_EXPORTER_OTLP_ENDPOINT` and point any vendor's collector at
  it; both server-side traces and request-level metrics flow out automatically.
- Auto-update for the desktop app — only relevant if you're publishing your own
  Tauri builds. See [`docs/desktop-releases.md`](./desktop-releases.md) (or the
  release workflow in `.github/workflows/release.yml`).

Open an issue or PR at
[github.com/sunnyallana/Scribe](https://github.com/sunnyallana/Scribe) if anything
in this guide is wrong, missing, or unnecessarily painful.
