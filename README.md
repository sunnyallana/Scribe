<div align="center">

<img src="apps/web/public/favicon.svg" alt="Scribe logo" width="84" height="84" />

# Scribe

**A self-hostable, collaborative LaTeX editor.**
An open alternative to Overleaf — one binary, real-time multi-user, AI-assisted.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Stack: React + Rust](https://img.shields.io/badge/stack-React%20%2B%20Rust-1f1f1f)](#tech-stack)
[![Editor: CodeMirror 6](https://img.shields.io/badge/editor-CodeMirror%206-0f172a)](https://codemirror.net)
[![Realtime: Yjs](https://img.shields.io/badge/realtime-Yjs%20CRDT-0a7e8c)](https://docs.yjs.dev)
[![Compile: Tectonic / latexmk](https://img.shields.io/badge/compile-Tectonic%20%7C%20latexmk-0f766e)](#compile-engines)
[![Self-hostable](https://img.shields.io/badge/self--hostable-yes-22c55e)](#run-it-locally)

</div>

---

## What it is

Scribe is a collaborative LaTeX editor that runs entirely on infrastructure you control.
Write papers side-by-side with co-authors in real time — same low-latency multi-cursor
feel as Google Docs, plus peer-to-peer voice chat when you need to discuss a tricky
section. Compile to PDF with Tectonic (single binary, auto-fetched CTAN packages) or your
existing TeX Live; search CrossRef + arXiv and drop citations straight into your `.bib`;
share a read-only project URL with anyone signed in; export to Markdown or Word via
Pandoc; and call out to any AI provider — OpenAI, Anthropic, Gemini, Ollama, or any
OpenAI-compatible endpoint — for inline assistance.

The whole stack is two processes: a Rust API (Axum + Tokio + sqlx) and a Vite-built React
SPA. State lives in Supabase Postgres + Storage + Redis. There is no Java, no PHP, no
multi-gigabyte LaTeX distribution mandated — the smallest deploy is a single Rust binary
and a Postgres connection string.

## Highlights

### For writers
- **Real-time multi-author editing** with coloured cursors and live presence avatars,
  backed by a Yjs CRDT — conflict-free even if two people type into the same line at the
  same time.
- **Real-time voice chat** between collaborators via WebRTC peer-to-peer mesh — Opus at
  48 kbps, browser-native echo-cancel / noise-suppression, per-peer mute and master
  speaker mute. Active-speaker indicator pulses the call icon. Server never touches the
  audio bytes — media is DTLS-SRTP between peers.
- **Multi-file editor tabs** above the editor — Ctrl/Cmd+W to close, middle-click close,
  scrollable strip restored from the last session per project.
- **Three-tier roles**: owner / editor / viewer. Viewers can compile and read but never
  write; editors get full access; owners get destructive ops.
- **Live PDF preview** with continuous scroll, virtualised rendering for large docs,
  SyncTeX click-to-source, quick-jump page input, and a switchable paged mode for
  documents over 50 pages. The last rendered PDF + zoom + split position are restored on
  refresh, so reload never costs you a recompile.
- **Bibliography panel** parses every `.bib` file in the project, auto-completes
  `\cite{...}` against keys, and surfaces author/title/year for each entry.
- **Citation search** against CrossRef + arXiv from inside the app — one-click
  "Add to .bib" appends a formatted BibTeX entry to the project's bib file (or creates
  `references.bib` if there isn't one yet).
- **Project-wide find & replace** in a dedicated right-panel tab — case-sensitive, whole-
  word, regex toggles; results grouped per file; "Replace all" rewrites every affected
  file in one operation.
- **Hover preview** for `\ref{...}` / `\eqref{...}` / `\cite{...}` — pops the source of
  the equation / figure / theorem block (with file:line) or the parsed bib entry, without
  navigating away.
- **Suggestion mode** for comments — propose a text replacement for an anchored range;
  reviewers Apply (writes the replacement) or Dismiss. Lighter-weight than full track-
  changes, but covers the "supervisor proposes, author accepts" workflow.
- **Style-lint via chktex** runs on every keystroke pause (800 ms debounced) and on
  compile. Warnings appear in a separate "Style lint" section in the log panel with
  concrete `Fix:` hints; toggle off any time from Settings → Editor.
- **Notification inbox** — bell icon in the nav with unread badge. Mentions, comment
  replies, share-link redemptions show up as persistent notifications you can click into.
- **Shareable project links** — owners issue a read-only or comment-only URL with optional
  expiry that any signed-in user can redeem to join the project, no email needed.
- **Community template gallery** — IEEE conference, ACM article, multi-chapter thesis,
  problem-set, conference poster, plus the six built-in templates. Loaded from a JSON
  manifest in the SPA's public folder.
- **Version snapshots** of the whole project, restorable in one click.
- **AI assist** as inline rewrites, chat, and slash-command rephrasing — provider chosen
  per user, key encrypted at rest with AES-256-GCM, never leaves the server.
- **Math palette**, **outline panel**, **comments**, **invite-by-email** flow with one-
  click copyable links.
- **Export**: download the rendered PDF, ship the source as a `.zip`, or convert with
  Pandoc to Markdown / DOCX directly from the project menu.
- **Multi-language UI**: English, French, Spanish, German, and Urdu (with RTL support).
  Every string flows through `react-i18next` — adding a language is a translation file
  drop.

### For self-hosters
- **One binary** for the backend (`cargo run -p scribe-server`) — no Node runtime, no
  container choreography to get started.
- **One-shot setup scripts** — `./scripts/setup.sh` (Linux apt/dnf/pacman + macOS Homebrew)
  or `.\scripts\setup.ps1` (Windows + winget) install every runtime dep and pre-build the
  workspace. `./scripts/run.sh` / `.\scripts\run.ps1` brings up Redis + API + SPA with
  prefixed log streams.
- **Switchable compile engine with fallback**: `tectonic` (single static binary, auto-
  fetched packages, ~4 s warm) or `latexmk`-style multi-pass against a local TeX Live /
  MiKTeX (~1.5 s warm). Configure `COMPILE_ENGINE=…` and optionally
  `COMPILE_FALLBACK_ENGINE=…` — when the primary returns non-zero, the worker auto-retries
  with the fallback so a project that needs a package not in the tectonic bundle still
  compiles via latexmk.
- **Optional chktex integration** — set `CHKTEX_BIN=/path/to/chktex` and every compile
  + every typing-pause runs a style-lint pass. Warnings come back with concrete `Fix:`
  hints derived from the chktex message text (robust to chktex's per-version rule
  renumbering).
- **Pluggable storage** via the `Storage` trait — currently Supabase Storage; an S3
  adapter is a ~150-line module.
- **Pluggable AI providers** via the same adapter pattern — bring your own endpoint.
- **Response cache** (Moka L1 + Redis L2 + circuit breaker) on the hot read endpoints,
  with cache-disabled mode for dev.
- **OpenTelemetry** + Prometheus exporters baked in; structured `tracing` logs.

## Screenshots

> _Captures land here once the design pass is finalised. Run it locally for the moment._

## Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, TypeScript (`strict`), Vite, Tailwind, shadcn/ui, Zustand, TanStack Query, react-i18next |
| **Editor** | CodeMirror 6 with a custom Lezer-based LaTeX grammar, custom Yjs binding |
| **PDF viewer** | pdf.js with HiDPI oversampling, GPU acceleration, OffscreenCanvas, SyncTeX |
| **Realtime** | Yjs (CRDT) + a Rust WebSocket fan-out (`scribe-yjs`) with per-doc broadcast and read-only enforcement |
| **Backend** | Rust, Axum 0.7, Tokio 1.40, sqlx 0.8, hyper, tower-http |
| **Auth** | Supabase Auth (JWT, ES256 / RS256 via JWKS); response cache + circuit breaker |
| **Database & storage** | Supabase Postgres + Storage |
| **Queue** | Redis (BLPOP-based job queue, BullMQ-compatible naming) |
| **Compile** | Tectonic by default; switch to latexmk-style multi-pass against TeX Live / MiKTeX |
| **Export** | Pandoc 3.x (LaTeX → Markdown / DOCX) |
| **AI** | OpenAI, Anthropic, Gemini, Ollama, LM Studio, any OpenAI-compatible endpoint |
| **Build** | Turborepo + pnpm workspaces; Cargo workspace for the Rust crates |
| **License** | [AGPL-3.0-or-later](./LICENSE) |

## Architecture

```
                                ┌────────────────────────────┐
                                │  React SPA (apps/web)      │
                                │  CodeMirror 6 + pdf.js     │
                                │  Yjs provider + Zustand    │
                                └──────────────┬─────────────┘
                                               │ HTTP + WS (Yjs awareness, compile stream)
                                               ▼
            ┌──────────────────────────────────────────────────────────────┐
            │  scribe-server (Rust / Axum / Tokio)                          │
            │  • REST routes (projects, files, members, AI, exports, ...)   │
            │  • Yjs hub (per-doc fan-out, read-only enforcement)           │
            │  • Voice signaling hub (WebRTC SDP + ICE fan-out — no media)  │
            │  • Compile queue producer                                     │
            │  • Response cache: Moka L1 → Redis L2 → circuit breaker       │
            └────────────┬─────────────┬─────────────┬────────────────────┘
                         │             │             │
                         ▼             ▼             ▼
                 ┌────────────┐  ┌────────────┐  ┌───────────────┐
                 │ Supabase   │  │ Redis      │  │ scribe-compile │
                 │ Postgres   │  │ Queue +    │  │ worker(s)      │
                 │ + Storage  │  │ Pub/Sub    │  │ Tectonic |     │
                 │ + Auth     │  │            │  │ latexmk path   │
                 └────────────┘  └────────────┘  └───────────────┘
```

## Run it locally

### Fast path — use the bundled scripts

```bash
# Linux (Debian/Ubuntu/Fedora/Arch) or macOS
./scripts/setup.sh        # installs Node 20+, pnpm, Rust, Redis, Tectonic, chktex
./scripts/run.sh          # starts Redis + API + SPA with prefixed log streams

# Windows 10/11 (PowerShell, requires winget)
.\scripts\setup.ps1
.\scripts\run.ps1
```

`setup` is idempotent (re-running skips anything already present) and copies
`.env.example` → `.env` on first run; fill in the Supabase keys + `DATABASE_URL`
before `run`. See [`scripts/README.md`](./scripts/README.md) for flags and per-distro
notes.

### Manual path

#### Prerequisites

- **Rust 1.75+** (`rustup default stable`)
- **Node 20+** and **pnpm 11+**
- **Docker** (only if you want to run the local Supabase stack — the hosted Supabase
  flow doesn't need it)
- **Tectonic** binary on PATH (the [release page](https://tectonic-typesetting.github.io/)
  has prebuilds for every OS), *or* a local TeX Live / MiKTeX install if you'd rather
  drive `latexmk` — or both, and let the engine-fallback machinery handle either
- **Pandoc 3+** if you want the Markdown / DOCX export feature
- **chktex** (ships with MiKTeX / TeX Live) for style linting — optional
- **Redis** for the compile queue (`docker run -p 6379:6379 redis:7-alpine` works)

#### One-time setup

```bash
git clone https://github.com/sunnyallana/Scribe.git
cd Scribe
pnpm install

cp .env.example .env
# Edit .env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# SUPABASE_JWT_SECRET, DATABASE_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
# Optional: TECTONIC_BIN, LATEXMK_BIN, CHKTEX_BIN, AI_KEY_ENCRYPTION_KEY,
# COMPILE_FALLBACK_ENGINE.
```

#### Day-to-day dev loop

Two terminals:

```bash
# Terminal 1 — API + compile worker + Yjs hub + voice signaling
cargo run --manifest-path servers/rust/Cargo.toml -p scribe-server
#   → http://localhost:3000  (or whatever PORT in .env)

# Terminal 2 — SPA with HMR
pnpm --filter @scribe/web dev
#   → http://localhost:5173
```

Open `http://localhost:5173` and sign up. If you're using the local Supabase stack,
invite emails go to **Inbucket** (`http://localhost:54324`) — no SMTP needed locally.

## Compile engines

Set `COMPILE_ENGINE=tectonic` (default) or `COMPILE_ENGINE=latexmk` and restart the
server. Tradeoffs:

| Engine | Cold | Warm | Setup |
|---|---|---|---|
| **Tectonic** | ~15 s (one-time CTAN bundle download) | ~4 s | Single binary, drops in anywhere |
| **latexmk-style** (multi-pass) | ~5 s | ~1.5 s | Needs TeX Live or MiKTeX installed |

Both produce the same `.pdf` + `.synctex.gz` + `.log` artifact set; the SPA can't tell
them apart.

### Fallback

Set `COMPILE_FALLBACK_ENGINE=` to the *other* engine and the worker will auto-retry
when the primary returns non-zero. A common configuration on a workstation that has
both installed:

```
COMPILE_ENGINE=latexmk           # fast warm rebuilds via MiKTeX/TeX Live
COMPILE_FALLBACK_ENGINE=tectonic # safety net when a project misses a local package
```

The compile log reports the engine that produced the result; identical engine on both
fields is ignored (no point running the same compile twice).

## Configuration

`/.env.example` is the authoritative list. Key knobs:

| Variable | Effect |
|---|---|
| `DATABASE_URL` | Postgres pooler URL (session pooler, port 5432) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Auth + storage |
| `SUPABASE_JWT_SECRET` | Used to verify access tokens server-side |
| `REDIS_URL` | Queue + L2 cache; falls back to in-process L1 only when unset |
| `COMPILE_ENGINE` | `tectonic` (default) or `latexmk` |
| `COMPILE_FALLBACK_ENGINE` | Engine the worker re-runs with when the primary fails. Set to the other engine for a self-healing pipeline. |
| `TECTONIC_BIN`, `LATEXMK_BIN`, `LATEX_ENGINE`, `PANDOC_BIN` | Override binary paths |
| `TECTONIC_CACHE_DIR` | Override tectonic's CTAN-bundle cache location. Usually unset — its OS default is already populated. |
| `CHKTEX_BIN` | Path to `chktex`. When set, every compile + every typing pause runs a style-lint pass. Unset disables linting entirely. |
| `SCRIBE_ENV` | `development` / `production` / `testing` — drives feature-flag defaults |
| `SCRIBE_FEATURE_*` | Per-feature toggles (`CACHE_ENABLED`, `YJS_REALTIME`, `RATE_LIMITING`, etc.) |
| `AI_KEY_ENCRYPTION_KEY` | Required for `/api/ai/*` — `openssl rand -base64 32` |

## Project layout

```
Scribe/
├── apps/
│   └── web/                    Vite + React SPA
├── packages/
│   ├── shared/                 Cross-cutting types, schemas
│   ├── ui/                     Design system (tokens, themes, shadcn primitives)
│   ├── editor/                 CodeMirror 6 LaTeX editor + custom Yjs binding
│   ├── compiler-client/        Log parser + compile types
│   └── yjs-provider/           Yjs client + presence + WS reconnect
├── servers/
│   └── rust/
│       └── crates/
│           ├── scribe-server       Axum API + routes + state
│           ├── scribe-compile      Compile worker (Tectonic / latexmk dispatch)
│           ├── scribe-yjs          Yjs hub + per-doc broadcast
│           ├── scribe-storage      Supabase Storage adapter
│           ├── scribe-auth         JWT verification + JWKS cache
│           ├── scribe-ai           AI provider adapters
│           └── scribe-shared       Cross-crate types
├── supabase/                   Migrations + seed data
├── scripts/
│   ├── setup.{sh,ps1}          Cross-platform one-shot install
│   ├── run.{sh,ps1}            Start Redis + API + SPA together
│   ├── migrations/             One-off DB migration runners
│   ├── probes/                 Read-only DB / auth diagnostics
│   └── utils/                  Misc helpers (demo walkthrough, JWT tester, …)
├── .env.example                All env vars + feature flags
├── PLAN.md                     Full roadmap + principles
└── README.md
```

## Engineering principles

- **Strict TypeScript** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, zero
  implicit `any`.
- **Hexagonal Rust services** — every service is a struct with a `PgPool` and explicit
  collaborators; HTTP/Axum lives only at the edge.
- **Adapter pattern** for AI providers, storage, compile engines — swap implementations
  via env var, not code changes.
- **Result-shaped errors** in TypeScript; typed `ApiError` enum across the wire.
- **Accessible by default** — WCAG AA, keyboard-first, focus-trapped dialogs, three
  themes (Light, Dark, High Contrast).
- **i18n-first** — every string flows through `react-i18next`; English bundled, more
  languages straightforward to add.

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| 0 | Monorepo foundation | done |
| 1 | Auth, projects, files | done |
| 2 | LaTeX editor + compile + PDF preview + SyncTeX | done |
| 3 | Realtime collab + presence + version history + comments | done |
| 4 | AI assistance (six providers, encrypted keys) | done |
| 5 | Bibliography, templates, settings UI, exports | done |
| 5.5 | Voice chat · multi-file tabs · citation lookup · shareable links · i18n | done |
| 5.6 | Find/replace · hover preview · suggestion mode · chktex live-lint · notification inbox · community templates · compile-engine fallback | done |
| 6 | Tauri desktop app + offline sync | in progress |
| 7 | Docker self-hosting recipe + `CONTRIBUTING.md` | in progress |

The only Overleaf-parity item still on the backlog is **GitHub sync** (OAuth + push/pull).
See `PLAN.md` §12 for the full status table.

## License

[AGPL-3.0-or-later](./LICENSE) — same family as Overleaf Community Edition. If you run a
modified version as a network service, the modifications must be shared back.

## Author

Built by [**Sunny Shaban Ali**](https://github.com/sunnyallana). Issues, PRs, and
feature requests are welcome.

---

<div align="center">

[Quick start](#run-it-locally) · [Tech stack](#tech-stack) · [Architecture](#architecture) · [Roadmap](#roadmap) · [License](#license)

</div>
