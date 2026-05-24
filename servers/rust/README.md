# scribe-server (Rust)

A Rust + Axum reimplementation of the Scribe backend currently in
`../server/` (Node/Fastify). Goal: ship the entire backend as a single
statically-linked binary so self-hosting becomes "download + run", with
the Node server as the legacy reference until parity is verified.

## Status

Early scaffolding. Only `/api/health` is wired. Track progress against
the milestones listed in `PLAN.md` and the `rust-port` branch task list.

## Layout

```
rust-server/
├─ Cargo.toml             # workspace root
└─ crates/
   ├─ scribe-server/      # axum binary (entrypoint)
   ├─ scribe-shared/      # domain types, errors, ID newtypes
   ├─ scribe-auth/        # JWT verification, auth middleware  (stub)
   ├─ scribe-storage/     # S3-compatible storage client       (stub)
   ├─ scribe-yjs/         # yrs-based collab WebSocket server  (stub)
   ├─ scribe-compile/     # tectonic worker, Redis queue       (stub)
   └─ scribe-ai/          # 6 provider adapters + AES-GCM      (stub)
```

Each non-binary crate currently exports a `Placeholder` type so the
workspace compiles end-to-end while modules are filled in.

## Build & run

```sh
cd rust-server
cargo build
cargo run -p scribe-server
# → listening on 0.0.0.0:3001
curl http://localhost:3001/api/health
# {"ok":true,"service":"scribe-server"}
```

## Config

Reads env vars (or `.env` at the repo root) using the **same names** as
the Node server, so a single `.env` works for both during cutover:

| var                         | purpose                                |
| --------------------------- | -------------------------------------- |
| `HOST` / `PORT`             | bind address (defaults `0.0.0.0:3001`) |
| `DATABASE_URL`              | Postgres connection (sqlx)             |
| `SUPABASE_URL`              | Storage + JWKS base URL                |
| `SUPABASE_ANON_KEY`         | HS256 anon JWT secret                  |
| `SUPABASE_SERVICE_ROLE_KEY` | HS256 service-role JWT secret          |
| `SUPABASE_JWT_SECRET`       | legacy HS256 user JWT secret           |
| `REDIS_URL`                 | compile queue                          |
| `AI_KEY_ENCRYPTION_KEY`     | base64 32-byte AES-256-GCM KEK         |

## Migration path

1. Ship the Rust server on a parallel port. Run alongside the Node
   server in dev.
2. Cut endpoints over one at a time. The frontend points at the Rust
   server URL via `VITE_API_URL`.
3. Once all routes have parity (including the Yjs WebSocket sync), the
   `server/` directory becomes legacy and ships only as a reference.
