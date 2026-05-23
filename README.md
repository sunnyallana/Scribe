# Scribe

A self-hostable, collaborative LaTeX editor. Open alternative to Overleaf.

> **Status: Phase 1 complete — auth + projects + files.** Sign up with email/password,
> magic link, or Google/GitHub OAuth; create projects from six LaTeX templates; upload,
> rename, and delete files; invite collaborators by email with role-based access. The
> editor and compile pipeline land in Phase 2. See [`PLAN.md`](./PLAN.md) for the
> roadmap.

## What Scribe will be

- **Web app and desktop app** sharing one React codebase (desktop wrapped by Tauri).
- **CodeMirror 6 LaTeX editor** with smart autocomplete, snippets, SyncTeX, Vim/Emacs modes.
- **PDF preview** via pdf.js with forward SyncTeX.
- **Realtime collaboration** via Yjs (CRDT) over WebSocket — colored cursors, presence,
  multi-user editing without conflicts.
- **Email-based invites** with role-based access (owner / editor / commenter / viewer).
- **Pluggable AI** — OpenAI, Anthropic, Gemini, Ollama, LM Studio, or any
  OpenAI-compatible endpoint. Configurable per-user, per-project.
- **Compile via tectonic** (server-side) or local TeX Live (desktop).
- **Self-hostable** end to end — one `docker compose up` deploys the full stack.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18, TypeScript (strict), Vite, Tailwind, shadcn/ui, Zustand, TanStack Query, react-i18next |
| Editor | CodeMirror 6 with custom Lezer LaTeX grammar |
| PDF | pdf.js |
| Realtime | Yjs + y-websocket (Postgres persistence) |
| Backend | Fastify (TypeScript, hexagonal), pino, zod |
| Database / Auth / Storage | Supabase (Postgres, GoTrue, Storage) |
| Queue | Redis + BullMQ |
| Compile | tectonic |
| Email | Nodemailer (any SMTP relay; Resend, SES, Postmark all work) |
| Desktop | Tauri (Rust) |
| Build orchestration | Turborepo + pnpm workspaces |
| License | AGPL-3.0-or-later |

## Quick start

### Build everything

Prerequisites: **Node 20+** and **pnpm 11+**.

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm run test
```

### Run the full stack locally (Phase 1)

Additional prerequisite: **Docker Desktop** (Supabase CLI uses it).

```bash
# 1. Start the local Supabase stack (Postgres + Auth + Storage + Studio + Inbucket)
pnpm supabase:start

# 2. Copy env and fill in the values printed by `supabase status`
cp .env.example .env
# Edit .env — paste SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# SUPABASE_JWT_SECRET (the JWT secret), VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

# 3. Regenerate the DB type from the live schema (optional but recommended)
pnpm gen:db

# 4. Run server and web app in two terminals
cargo run --manifest-path servers/rust/Cargo.toml -p scribe-server    # http://localhost:3000
pnpm --filter @scribe/web dev          # http://localhost:5173
```

Then open `http://localhost:5173` and sign up. Invite emails are captured by
**Inbucket** (the local mail catcher) at `http://localhost:54324` — open it to grab
the invitation link without configuring SMTP.

When you're done: `pnpm supabase:stop`.

To enable Google or GitHub OAuth locally, fill `GOOGLE_CLIENT_*` / `GITHUB_CLIENT_*` in
your shell env, then flip `enabled = true` in `supabase/config.toml` for that provider.

## Repository layout

```
xplore/
├── apps/
│   ├── web/                # Vite + React web app
│   └── desktop/            # Tauri app (Phase 6)
├── packages/
│   ├── shared/             # Cross-cutting types, schemas, Result type
│   ├── ui/                 # Design system (tokens, themes, shadcn primitives)
│   ├── editor/             # CodeMirror 6 LaTeX editor (Phase 2)
│   ├── ai/                 # AI adapter interface + implementations (Phase 4)
│   ├── compiler-client/    # Log parser + compile types (Phase 2)
│   └── yjs-provider/       # Yjs client provider (Phase 3)
├── server/                 # Fastify API + Yjs WebSocket (Phase 1+)
├── supabase/               # Migrations + seed data (Phase 1)
├── .env.example            # All env vars, marked by phase
├── PLAN.md                 # The full plan: principles, decisions, phases
└── README.md
```

## Engineering principles (summary)

See `PLAN.md` §1.5 for the full list. The non-negotiables:

- **Maximum user value** — the motto every feature is judged against.
- **Strict TypeScript** — no `any`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Hexagonal server** — services don't know about Fastify, Supabase, Redis, etc.
- **Adapter pattern** for AI providers, storage, compile engines, email.
- **Result<T, E>** for expected errors; throws only for bugs.
- **Accessible by default** — WCAG AA, keyboard-first, focus-trapped dialogs.
- **Three themes from day one** — Light, Dark, High Contrast.
- **Localizable from day one** — every string through `react-i18next`.

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| 0 | Monorepo foundation | **done** |
| 1 | Auth, projects, files (Supabase + Fastify) | **done** |
| 2 | LaTeX editor, compile pipeline, PDF preview | not started |
| 3 | Realtime collab, reviews, version history | not started |
| 4 | AI assistance (six providers, twelve features) | not started |
| 5 | Bibliography, templates, settings UI | not started |
| 6 | Tauri desktop app + offline sync | not started |
| 7 | Docker self-hosting + CONTRIBUTING.md | not started |

Each phase is independently shippable.

## License

[AGPL-3.0-or-later](./LICENSE) — same as Overleaf community edition. If you run a
modified version as a network service, you must share your modifications.

## Contributing

`CONTRIBUTING.md` lands in Phase 7. Until then, the plan in `PLAN.md` is the source of
truth for architecture and conventions.
