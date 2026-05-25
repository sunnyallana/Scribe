# scribe-server

The Scribe backend. A Rust + Axum workspace that ships as a **single
statically-linked binary**: REST, Yjs CRDT WebSocket hub, Redis-backed
compile queue, AI proxy, all in one process. No service mesh, no Node
runtime, no container choreography to get started.

## What's in it for self-hosters

- **One binary**: `cargo run -p scribe-server` is the whole backend.
- **One-shot setup scripts**: `./scripts/setup.sh` (Linux apt / dnf /
  pacman + macOS Homebrew) or `.\scripts\setup.ps1` (Windows + winget)
  install every runtime dep and pre-build the workspace.
  `./scripts/run.sh` / `.\scripts\run.ps1` brings up Redis + API + SPA
  with prefixed log streams.
- **Switchable compile engine with fallback**: `tectonic` (single
  static binary, auto-fetched packages, ~4 s warm) or `latexmk`-style
  multi-pass against a local TeX Live / MiKTeX (~1.5 s warm). See
  [Compile engines](#compile-engines) below.
- **Optional chktex integration**: set `CHKTEX_BIN=/path/to/chktex` and
  every compile + every typing-pause runs a style-lint pass. Warnings
  come back with concrete `Fix:` hints derived from the chktex message
  text (robust to chktex's per-version rule renumbering).
- **Pluggable storage** via the `Storage` trait, currently Supabase
  Storage; an S3 adapter is a ~150-line module.
- **Pluggable AI providers** via the same adapter pattern; bring your
  own endpoint.
- **Response cache** (Moka L1 + Redis L2 + circuit breaker) on the hot
  read endpoints, with cache-disabled mode for dev.
- **OpenTelemetry** + Prometheus exporters baked in; structured
  `tracing` logs.

## Layout

```
servers/rust/
├── Cargo.toml                    workspace root
├── Cargo.lock
├── Dockerfile                    self-hosting image with tectonic baked in
├── MIGRATION.md                  notes on the Node → Rust cutover
└── crates/
    ├── scribe-server/            Axum binary: routes, state, middleware
    ├── scribe-shared/            Cross-crate types, errors, ID newtypes
    ├── scribe-auth/              JWT verification (HS256 / ES256 via JWKS)
    ├── scribe-storage/           Supabase Storage adapter
    ├── scribe-yjs/               Yjs hub + per-doc broadcast
    ├── scribe-compile/           Tectonic / latexmk dispatch + log parsing
    └── scribe-ai/                Six AI provider adapters + AES-GCM envelope
```

## Build & run

Needs Rust 1.82+, Redis 7+, and a Supabase project. For the one-shot
scripted setup, see [`scripts/README.md`](../../scripts/README.md).

```bash
# from the repo root, with .env filled in (see docs/env-vars.md)
docker run --rm -d --name scribe-redis -p 6379:6379 redis:7-alpine

cargo run --manifest-path servers/rust/Cargo.toml -p scribe-server
#   → http://localhost:3000
```

For a Docker compose deployment with tectonic baked into the image,
see [`docs/self-hosting.md`](../../docs/self-hosting.md).

## Compile engines

Set `COMPILE_ENGINE=tectonic` (default) or `COMPILE_ENGINE=latexmk` and
restart the server.

| Engine                         | Cold                                  | Warm   | Setup                              |
| ------------------------------ | ------------------------------------- | ------ | ---------------------------------- |
| **Tectonic**                   | ~15 s (one-time CTAN bundle download) | ~4 s   | Single binary, drops in anywhere   |
| **latexmk-style** (multi-pass) | ~5 s                                  | ~1.5 s | Needs TeX Live or MiKTeX installed |

Both produce the same `.pdf` + `.synctex.gz` + `.log` artifact set; the
SPA can't tell them apart.

### Fallback

Set `COMPILE_FALLBACK_ENGINE=` to the _other_ engine and the worker
auto-retries when the primary returns non-zero. A common configuration
on a workstation that has both installed:

```
COMPILE_ENGINE=latexmk           # fast warm rebuilds via MiKTeX/TeX Live
COMPILE_FALLBACK_ENGINE=tectonic # safety net when a project misses a local package
```

The compile log reports the engine that produced the result; identical
engine on both fields is ignored (no point running the same compile
twice).

## Configuration

[`.env.example`](../../.env.example) at the repo root lists every
variable inline; [`docs/env-vars.md`](../../docs/env-vars.md) tells you
exactly where each value comes from (Supabase dashboard paths, OpenSSL
command for the AI key, etc.). Key knobs:

| Variable                                                           | Effect                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                     | Postgres pooler URL (session pooler, port 5432)                                                                         |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Auth + storage                                                                                                          |
| `SUPABASE_JWT_SECRET`                                              | Used to verify access tokens server-side                                                                                |
| `REDIS_URL`                                                        | Queue + L2 cache; falls back to in-process L1 only when unset                                                           |
| `COMPILE_ENGINE`                                                   | `tectonic` (default) or `latexmk`                                                                                       |
| `COMPILE_FALLBACK_ENGINE`                                          | Engine the worker re-runs with when the primary fails                                                                   |
| `TECTONIC_BIN`, `LATEXMK_BIN`, `LATEX_ENGINE`, `PANDOC_BIN`        | Override binary paths                                                                                                   |
| `TECTONIC_CACHE_DIR`                                               | Override tectonic's CTAN-bundle cache location                                                                          |
| `CHKTEX_BIN`                                                       | Path to `chktex`. When set, every compile + every typing pause runs a style-lint pass. Unset disables linting entirely. |
| `SCRIBE_ENV`                                                       | `development` / `production` / `testing`, drives feature-flag defaults                                                  |
| `SCRIBE_FEATURE_*`                                                 | Per-feature toggles (`CACHE_ENABLED`, `YJS_REALTIME`, `RATE_LIMITING`, …)                                               |
| `AI_KEY_ENCRYPTION_KEY`                                            | Required for `/api/ai/*`. Generate with `openssl rand -base64 32`                                                       |

## Engineering principles

- **Hexagonal services**: every service is a struct with a `PgPool`
  and explicit collaborators; HTTP / Axum lives only at the edge.
- **Adapter pattern** for AI providers, storage, compile engines:
  swap implementations via env var, not code changes.
- **Result-shaped errors** with a typed `ApiError` enum across the
  wire, mirrored by the SPA's TypeScript discriminated union.
- **Single binary**, no service mesh, no container choreography
  required to bring it up.

See the top-level [README](../../README.md) for the wider architecture
and [`MIGRATION.md`](./MIGRATION.md) for the Node → Rust cutover notes.
