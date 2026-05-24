# Migrating from the Node server to `scribe-server` (Rust)

The new Rust backend in `rust-server/` is a drop-in replacement for the
Node/Fastify server in `../server/`. Every HTTP route, WebSocket
endpoint, and Redis pub/sub channel was ported to the same wire format,
so the existing `apps/web` SPA needs no protocol-level changes.

## TL;DR

```sh
# 1. Build the single binary (matches the same env-var schema as the Node server).
cd rust-server
cargo build --release

# 2. Stop the Node services.
pm2 stop scribe-api scribe-worker        # or docker compose stop, etc.

# 3. Run the Rust binary, pointing the SPA env var at it.
./target/release/scribe-server &
echo "VITE_API_URL=http://127.0.0.1:3000" >> ../apps/web/.env.local
cd ../apps/web && pnpm dev
```

## What changed

| concern           | Node (Fastify)                              | Rust (Axum)                                                    |
| ----------------- | ------------------------------------------- | -------------------------------------------------------------- |
| HTTP framework    | Fastify                                     | Axum 0.7                                                       |
| Auth              | `jose` JWT verify                           | `jsonwebtoken` + custom JWKS cache                             |
| Postgres          | `@supabase/supabase-js` (PostgREST)         | `sqlx` (direct Postgres)                                       |
| Storage           | `@supabase/supabase-js` Storage client      | Direct REST calls to Supabase Storage API                      |
| Yjs sync          | `yjs` + `y-protocols` (Node)                | `yrs` 0.17 + `y-sync` 0.4                                      |
| Compile queue     | BullMQ                                      | Raw Redis `LPUSH`/`BRPOP` on `scribe:compile:queue`            |
| Compile worker    | Separate `compile-worker` process           | Spawned in-process when DB + storage + Redis are all available |
| Static SPA        | Served by Vite dev server (or external CDN) | Served by the Rust binary from `SCRIBE_STATIC_DIR`             |
| AI key encryption | Node `crypto` AES-GCM                       | `aes-gcm` crate — same wire format, ciphertexts round-trip     |
| AI streaming      | Manual SSE writes                           | `axum::response::sse::Sse` with `KeepAlive`                    |

## Authorization model

RLS in the Postgres schema relied on PostgREST attaching the user's JWT
to each query so `auth.uid()` worked. The Rust server connects with a
service-role-equivalent pool and **enforces membership checks in app
code** (every service method takes a `UserId` and joins
`project_members` before doing anything project-scoped). RLS is still
enabled — it's now defense-in-depth against direct DB access from
outside the app, not the primary gate.

## Environment variables

The Rust server reads the **same env-var names** as the Node server, so
a single `.env` file works for both stacks during cutover.

| var                         | required? | notes                                                   |
| --------------------------- | --------- | ------------------------------------------------------- |
| `HOST` / `PORT`             | no        | Defaults `0.0.0.0:3000`                                 |
| `DATABASE_URL`              | yes       | Postgres pooler URL                                     |
| `SUPABASE_URL`              | yes       | Storage REST base + JWKS endpoint                       |
| `SUPABASE_ANON_KEY`         | no        | Only needed if you use it client-side                   |
| `SUPABASE_SERVICE_ROLE_KEY` | yes       | Used as the Storage bearer + DB connection              |
| `SUPABASE_JWT_SECRET`       | yes       | HS256 verifier for legacy user JWTs                     |
| `REDIS_URL`                 | yes-ish   | Required for the compile queue and SSE log stream       |
| `AI_KEY_ENCRYPTION_KEY`     | no        | Base64-encoded 32-byte KEK. Omit to disable `/api/ai`   |
| `SCRIBE_STATIC_DIR`         | no        | When set, the binary serves the SPA from this directory |

## Wire-format compatibility

- **HTTP REST**: identical paths and JSON shapes. Frontend doesn't change.
- **Yjs WebSocket** (`/api/yjs/:project/:file/socket?token=…`): same
  `y-protocols` framing. Existing `apps/web/src/hooks/useYjsDoc.ts`
  works unchanged.
- **Compile log stream** (`/api/compiles/:job/stream?token=…`): same
  JSON-per-message format (`{ type: "status" | "log" | "completed", … }`).
- **AI SSE** (`POST /api/ai/complete`): same `data: <text>\n\n` framing
  with a final `event: error` if the upstream provider fails.

## Database compatibility

- All existing tables, columns, RLS policies, and triggers are reused
  as-is. **No migrations need to run.**
- `yjs_updates.update_data` stays base64 — both stacks decode it
  identically. They can even share the same row history during cutover.
- `users.ai_config` stays a JSONB column. The Rust server writes the
  same `{provider, model, baseUrl, apiKeyEncrypted, apiKeyPreview,
updatedAt}` shape.
- `compile_jobs.entries` stays JSONB. The Rust worker writes the same
  `{level, message, file?, line?, raw?}` entries.

## Compile queue migration

The Rust worker pops from `scribe:compile:queue`, not BullMQ's keys.
This means **you cannot run both workers concurrently against the same
queue** — they'd both look at different keys and only the Rust one
would receive new jobs (since the new HTTP route enqueues to the new
key). To switch over:

1. Stop the Node API and worker.
2. Start the Rust server.
3. If any jobs were in-flight in BullMQ, they're lost — schedule a
   replay manually if needed (HTTP `POST /api/projects/:id/compile`).

For zero-downtime cutover, run both stacks on different prefixes
temporarily while you migrate.

## Building the Docker image

```sh
cd rust-server
docker build -t scribe-server -f Dockerfile ..
```

The multi-stage build:

1. Uses `cargo-chef` for cached dependency compilation.
2. Builds the SPA with pnpm in a separate stage.
3. Pulls in the statically-linked Tectonic binary from upstream.
4. Final image is `debian:bookworm-slim` + the binary + the SPA. Runs as
   a non-root user.

## Verification checklist

- [ ] `curl http://server/api/health` returns `{"ok":true}`
- [ ] `curl http://server/api/health/db` returns `{"ok":true}`
- [ ] Sign in to the SPA; the JWT in the `Authorization` header is
      accepted on `GET /api/projects`.
- [ ] Open a project; the Yjs WebSocket connects and you see your own
      cursor in the editor.
- [ ] Trigger a compile; the `/api/compiles/:id/stream` WebSocket
      streams status → log lines → completed.
- [ ] Configure an AI provider, then POST `/api/ai/complete` — tokens
      stream back as SSE.
- [ ] Upload a file (multipart) and a ZIP (web-side unpack still works).
- [ ] Restore a project version.

## Rolling back

`server/` is preserved in the tree. To revert:

```sh
pm2 start server/dist/index.js --name scribe-api
pm2 start server/dist/workers/compile.js --name scribe-worker
# unset VITE_API_URL or point it back at the Node server.
```

The shared database means no data is lost during a back-and-forth.
