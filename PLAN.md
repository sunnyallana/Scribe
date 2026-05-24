# Scribe — Implementation Plan

> A planning document for the Scribe project, a self-hostable collaborative LaTeX editor
> (open alternative to Overleaf). This document is the **deliverable for this session**;
> no code has been written yet. Review, mark up, then we'll execute Phase 0.

---

## 1. Executive Summary

**What we're building:** a full-stack monorepo with a React/Vite web app, a Tauri desktop
wrapper, a Fastify backend, real-time collaboration over Yjs, Supabase for auth + DB +
storage, and a pluggable AI adapter layer.

**Realistic effort.** The spec covers ~18 implementation steps. Each is non-trivial.
Steps 5 (CodeMirror LaTeX editor), 6 (compile pipeline), 8 (Yjs collab), 12 (AI),
and 16-17 (Tauri + offline sync) are each 1-3 weeks of focused work for a single engineer.
The whole spec is a 3-6 month project for one engineer, or 6-10 weeks for a team of 3-4.

**Recommended phasing** (groups the 18 spec steps into 7 phases — see Section 7 for the
phase → step mapping):

| Phase | Goal                                       | Outcome user can see                      |
|-------|--------------------------------------------|-------------------------------------------|
| 0     | Foundation                                 | Empty monorepo builds, lints, types       |
| 1     | Auth + Projects + Files                    | Sign up, create project, upload .tex      |
| 2     | Editor + Compile + PDF                     | Edit .tex, hit compile, see PDF           |
| 3     | Realtime + Reviews + Versions              | Two users edit live, comment, restore     |
| 4     | AI                                         | Configurable AI assists in editor         |
| 5     | Polish (templates, bib, settings UI)       | Production-feeling web app                |
| 6     | Desktop + Offline                          | Tauri app, local compile, offline-first   |
| 7     | Self-hosting (Docker, docs)                | One-command deploy, CONTRIBUTING.md       |

Each phase is independently shippable as a milestone.

---

## 1.5 Engineering Principles & UX Pillars

These are **non-negotiable** standards applied to every line of code and every pixel.
Any PR that violates them is rejected, regardless of feature completeness.

### Product motto
**Maximum value to the user.** Every feature must directly enable a user goal. When two
approaches are equally valid, pick the one that is faster, clearer, or more forgiving for
the user — not the one that is cleaner for us.

### UX pillars (apply to every screen)

1. **Familiar before novel** — match Overleaf where users already have muscle memory;
   innovate only where it measurably helps.
2. **Keyboard-first** — `Cmd/Ctrl+K` opens a command palette exposing every action in the
   app. Mouse is a fallback, not the primary interface.
3. **Optimistic UI** — never block the user while the server thinks. Act locally first,
   reconcile on response, roll back on failure with a toast.
4. **Stateful indicators** — `Saved / Saving... / Offline / Conflict` is always visible.
   The user must never wonder "did that save?"
5. **No dead ends** — every empty state has a clear CTA, every error has a "what now"
   message with a concrete next action.
6. **Reversible by default** — destructive actions are soft-delete with undo (5-second
   toast). Hard delete is two clicks behind a typed-confirm.
7. **Accessible** — WCAG AA contrast, semantic HTML, focus-trapped dialogs, ARIA labels,
   full keyboard navigation. Verified by `axe-core` in CI; PRs that regress a11y fail.
8. **Localizable from day one** — every user-facing string goes through `react-i18next`.
   English-only at launch; the infrastructure is in place so any future locale is a JSON
   file away.
9. **Performance budget** — first paint ≤ 1 s, editor TTI ≤ 500 ms, compile feedback
   ≤ 300 ms after click. Lighthouse CI gates merges.
10. **Consistency** — one button style, one modal pattern, one toast system, one icon set
    (`lucide-react`), one spacing scale. Anyone editing the codebase sees a coherent system.

### Engineering practices

1. **Strict TypeScript** — `strict: true`, `noUncheckedIndexedAccess: true`,
   `exactOptionalPropertyTypes: true`. No `any`. ESLint forbids casts at non-boundary code.
2. **Hexagonal architecture on the server** — domain services don't know about Fastify,
   Supabase, BullMQ, or Nodemailer. They take adapters via constructor injection. Route
   handlers are 5-10 lines that call a service and serialize a DTO.
3. **DTO boundary** — never return raw DB rows from the API. Every endpoint has a zod
   schema for input + output. The schemas are the contract and generate TypeScript types
   shared by client and server via `@scribe/shared`.
4. **One source of truth** — UI state in Zustand, server state in TanStack Query. Derived
   state is computed at the use site, never stored. No mixing the two stores.
5. **Adapter pattern** — applied uniformly to: AI providers, file storage, compile engines,
   email, Yjs persistence. Each is a tiny interface with multiple implementations selected
   by config.
6. **Command pattern in the editor** — every action (compile, format, comment, every AI
   feature, every editor command) is registered in a `CommandRegistry`. Menus, command
   palette, and keyboard shortcuts dispatch commands by ID; nothing hardcodes a handler.
7. **Result types over throws** — backend services return `Result<T, E>` for expected
   errors (validation, not-found, permission-denied). Throws are reserved for bugs.
   The route layer maps `Result.err` to HTTP responses.
8. **Structured logging** — `pino` with consistent fields (`trace_id`, `user_id`,
   `project_id`, `route`). No `console.log` anywhere outside dev scripts.
9. **No premature abstractions** — three concrete uses before extracting an abstraction.
   One use is a coincidence, two is a pattern emerging, three is a refactor.
10. **No dead code, no orphan flags** — when a feature ships, its scaffolding (flags, dual
    code paths, temporary endpoints) is deleted in the same PR.
11. **Naming** — verbs for functions, nouns for types. `getProject` not `project`.
    `ProjectMember` not `MemberOfProject`. Enforced by ESLint naming-convention rule.
12. **Migrations are forward-only** — once merged, never edited. Backfills are separate
    scripts that can be re-run idempotently.
13. **Tests are documentation** — every public service function has at least one test;
    every UI component has a Storybook entry that doubles as a visual test snapshot.

### Design system

- All UI built from `@scribe/ui` (shadcn/ui foundation). **Zero bespoke buttons, modals,
  or inputs** in app code.
- Design tokens (color, spacing, radius, type, motion) defined once in
  `packages/ui/src/tokens.ts`. Tailwind theme reads from the tokens; CSS variables
  expose them to non-Tailwind contexts.
- Three themes from day one: **Light**, **Dark**, **High Contrast**. Theme preference
  persisted; defaults to OS.
- All icons from `lucide-react`. Mixing icon sets is forbidden.
- All animation through a single `motion` helper. No bespoke transitions.

---

## 2. Decisions Locked (formerly Open Questions)

> **Status:** All 12 decisions approved 2026-05-21 per user direction
> ("Make your best recommendation for all questions"). The recommendations below are now
> binding. Each is summarized; the full reasoning was in the previous revision of this
> document and is preserved here for posterity.

### Q1. Yjs persistence backend

The spec says y-websocket but is silent on persistence. Options:

- **(a) Postgres-backed** via a custom persistence adapter writing Y.Doc updates as binary
  rows in a `yjs_updates` table. Survives restarts; scales horizontally; aligns with
  Supabase-as-source-of-truth.
- **(b) y-leveldb** on the server's local disk. Easiest. Doesn't scale beyond one node.
- **(c) In-memory only** with snapshot to Storage on debounce. Loses recent edits on crash.

**Recommendation: (a)** — Postgres persistence, with periodic compaction. Most robust for
self-hosting; matches the rest of the stack.

### Q2. Yjs document ↔ `project_files` source of truth

When a user edits a `.tex` file, Yjs holds the live state. When does that flush back to
the file's canonical storage (Supabase Storage)?

- **(a) Debounced save** every ~5s of editor inactivity, plus on compile trigger.
- **(b) Compile-trigger only.** Minimal writes, but offline/desktop divergence is worse.
- **(c) Continuous write-through.** Simplest mental model, expensive.

**Recommendation: (a).** Yjs is the live truth during a session; Storage is the canonical
durable copy. Version snapshots (step 11) are taken from Storage, not Yjs.

### Q3. Compilation transport

How does the Fastify backend get files to the `tectonic` sidecar container?

- **(a) BullMQ job + Storage pull.** Backend enqueues a job with `project_id`. Worker
  inside `tectonic` container pulls all project files from Supabase Storage, runs tectonic,
  uploads PDF + log, marks job done. Pub-sub on the job ID streams log lines to the client.
- **(b) HTTP-based.** Backend tarballs the files, POSTs to the sidecar, gets back PDF
  bytes. Stateless and simpler but bigger payloads and no easy log streaming.

**Recommendation: (a).** BullMQ scales horizontally, streams logs naturally over Redis
pub-sub → WebSocket, and matches the spec's mention of Redis + BullMQ.

### Q4. AI key encryption — where does the master key live?

User AI keys are stored AES-256-encrypted in `users.ai_config`. The encryption key needs
to live somewhere.

- **(a) Env var** `AI_KEY_ENCRYPTION_KEY` (32 bytes, base64). Required on backend boot.
  Simplest for self-host. Documented in README.
- **(b) External KMS** (AWS KMS, GCP KMS). Overkill for self-host; document as upgrade path.
- **(c) Per-user passphrase.** User unlocks AI on each session. Worst UX.

**Recommendation: (a)** in code, with **(b)** documented in the self-hosting guide.

### Q5. Email provider abstraction

Spec says "Resend (or Nodemailer with SMTP)". Build both?

- **(a) Adapter pattern** — `MailAdapter` interface, two implementations (`ResendAdapter`,
  `SMTPAdapter`). Selected by env var. Adds a tiny bit of complexity but real flexibility.
- **(b) Nodemailer only.** Self-hosters bring their own SMTP. Resend can be configured as
  an SMTP relay if desired.

**Recommendation: (b).** Nodemailer is universal; Resend supports SMTP. One implementation,
no abstraction overhead. The "adapter" is just the SMTP settings.

### Q6. PDF compile artifact retention

Spec says "last N PDFs stored." What's N, and per what scope?

**Recommendation:** N=10 per project. Cleanup runs on `compile_jobs` insert (delete
oldest if count > 10). Configurable via env var `MAX_COMPILE_ARTIFACTS_PER_PROJECT`.

### Q7. SyncTeX scope for v1

Forward/inverse SyncTeX is **a multi-day feature on its own**. The .synctex.gz format
requires careful coordinate mapping. The `synctex-parser` npm library exists but is
unmaintained.

**Recommendation:** Implement **forward SyncTeX only** (editor line → PDF position) in
Phase 2. Defer inverse SyncTeX (PDF click → editor line) to a stretch goal. This unblocks
the spec's "click line, jump to PDF" feature without the harder coordinate math.

### Q8. Claude model version in the AI adapter

The spec specifies `claude-sonnet-4-20250514` as the default Claude model. **This is an
older model**; current latest as of 2026-05 is `claude-sonnet-4-6` and `claude-opus-4-7`.

**Recommendation:** Default the Claude adapter to `claude-sonnet-4-6` with `claude-opus-4-7`
as a "high-quality" preset. Document in README. The model name is configurable, so this
is forward-compatible.

### Q9. Spell check approach

Spec says "browser spellcheck API + custom dictionary support." The browser spellcheck API
doesn't expose underlined words programmatically — it only renders them visually. This
limits the integration:

- **(a) Visual-only** (set `spellcheck="true"` on the contenteditable). No programmatic
  access to misspellings, no custom dictionary integration, no "Add to dictionary."
- **(b) `nspell` + `dictionary-en` in JS** for full programmatic spellcheck. Works, but
  adds ~3-5 MB of dictionaries.

**Recommendation: (b)** for the editor's spell check feature, **(a)** as a fallback for
plain inputs. Custom user dictionary stored in Postgres.

### Q10. Templates Gallery — thumbnails

How are template preview thumbnails generated?

- **(a) Pre-rendered PNGs** committed to the repo (or seeded into Storage). Curated, ~10-15
  templates. Manual but predictable.
- **(b) Auto-rendered on seed** via a build script that compiles each template and uses
  pdf.js → canvas → PNG. Self-documenting but adds a build dependency.

**Recommendation: (a)** for v1. Defer (b) to the templates roadmap.

### Q11. Desktop offline sync — conflict resolution

Yjs handles content conflicts inherently. But metadata operations (file renames, deletes,
permission changes) made offline need a strategy when the desktop reconnects.

**Recommendation:** Last-write-wins on metadata, with conflict resolution UI for hard
collisions (e.g., user renamed locally, another user deleted online → present a modal).
Detailed design deferred to Phase 6.

### Q12. Cross-cutting: monorepo build tool

pnpm workspaces is locked in. But pnpm alone doesn't orchestrate builds — we need a
task runner.

- **(a) Turborepo** — caches well, well-documented, hosted cache add-on.
- **(b) Nx** — heavier, more powerful, more opinionated.
- **(c) None** — just package.json scripts using `pnpm -r run build`.

**Recommendation: (a) Turborepo.** Modest setup cost, good caching, widely understood.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (web) or Tauri (desktop) — same React app                 │
│                                                                     │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │  CodeMirror 6  │  │  pdf.js      │  │  Yjs (client)        │    │
│  │  LaTeX editor  │  │  PDF viewer  │  │  WebSocket provider  │    │
│  └────────────────┘  └──────────────┘  └──────────────────────┘    │
│           │                  │                   │                  │
│           └──────────────────┴───────────────────┘                  │
│                              │                                      │
│                  ┌───────────▼────────────┐                         │
│                  │  Zustand store         │                         │
│                  │  (UI state, project,   │                         │
│                  │   presence, settings)  │                         │
│                  └───────────┬────────────┘                         │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ HTTPS / WSS
                ┌──────────────▼───────────────┐
                │  Fastify backend             │
                │  ┌────────────────────────┐  │
                │  │ /api routes            │  │
                │  │  auth, projects,       │  │
                │  │  files, compile,       │  │
                │  │  invite, ai-proxy,     │  │
                │  │  comments, history     │  │
                │  ├────────────────────────┤  │
                │  │ y-websocket server     │  │
                │  │  (Yjs sync + presence) │  │
                │  └────────────────────────┘  │
                └──┬───────────────────────┬───┘
                   │                       │
       ┌───────────▼────────┐   ┌──────────▼─────────┐
       │  Supabase          │   │  Redis + BullMQ    │
       │  - Postgres        │   │  - Compile queue   │
       │  - Auth            │   │  - Yjs pub/sub     │
       │  - Storage         │   │  - Log streaming   │
       └────────────────────┘   └──────────┬─────────┘
                                           │
                              ┌────────────▼──────────────┐
                              │  Tectonic worker(s)        │
                              │  - Pulls files from Storage│
                              │  - Runs tectonic compiler  │
                              │  - Uploads PDF + log       │
                              └────────────────────────────┘
```

**Key data flows:**

1. **Editor session**: client connects via WebSocket to `y-websocket` server, joins the
   Y.Doc for the active file, broadcasts updates. Awareness for cursors + presence.
2. **Save**: debounced — client flushes Y.Doc text to backend `/api/files/:id/snapshot`
   endpoint → Supabase Storage.
3. **Compile**: client POSTs `/api/compile/:project_id` → backend creates `compile_jobs`
   row, enqueues BullMQ job → worker pulls files from Storage, runs tectonic, streams
   log lines via Redis pub-sub → backend forwards to client over WebSocket → on success,
   PDF uploaded to Storage, job marked complete, client fetches PDF.
4. **AI**: client POSTs `/api/ai/complete` with prompt + selection + feature kind →
   backend decrypts user's API key, calls provider via adapter, streams response back
   over Server-Sent Events.

---

## 4. Monorepo Layout (file-by-file)

```
xplore/
├── PLAN.md                          # this doc
├── README.md                        # project overview + quick start
├── CONTRIBUTING.md                  # contributor guide (Phase 7)
├── LICENSE                          # AGPL-3.0 (recommended for open Overleaf alt)
├── .env.example                     # all env vars documented
├── .gitignore
├── .editorconfig
├── .nvmrc                           # Node version pin (lts/iron, 20.x)
├── package.json                     # root, with pnpm workspaces config
├── pnpm-workspace.yaml              # workspace globs
├── pnpm-lock.yaml                   # generated
├── turbo.json                       # Turborepo pipeline config
├── tsconfig.base.json               # shared TS config extended by each package
├── eslint.config.js                 # flat config, shared lint rules
├── prettier.config.cjs              # shared formatting
├── docker-compose.yml               # full local dev stack (Phase 7)
│
├── apps/
│   ├── web/                         # Vite + React web app
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   ├── index.html
│   │   ├── public/
│   │   ├── src/
│   │   │   ├── main.tsx             # entrypoint
│   │   │   ├── App.tsx              # router root
│   │   │   ├── routes/              # Tanstack Router or React Router routes
│   │   │   │   ├── index.tsx        # landing / dashboard
│   │   │   │   ├── login.tsx
│   │   │   │   ├── signup.tsx
│   │   │   │   ├── invite.$token.tsx
│   │   │   │   ├── project.$id.tsx  # main editor page
│   │   │   │   └── settings/*.tsx
│   │   │   ├── components/          # app-level components (not in @scribe/ui)
│   │   │   │   ├── Editor/          # composes @scribe/editor
│   │   │   │   ├── PDFPreview/
│   │   │   │   ├── FileTree/
│   │   │   │   ├── CompileLog/
│   │   │   │   ├── ReviewPanel/
│   │   │   │   ├── VersionHistory/
│   │   │   │   ├── AIChat/
│   │   │   │   └── ...
│   │   │   ├── hooks/
│   │   │   ├── lib/
│   │   │   │   ├── supabase.ts
│   │   │   │   ├── api.ts           # typed API client
│   │   │   │   └── ...
│   │   │   ├── store/               # Zustand stores
│   │   │   │   ├── auth.ts
│   │   │   │   ├── project.ts
│   │   │   │   ├── editor.ts
│   │   │   │   └── settings.ts
│   │   │   └── styles/
│   │   └── tailwind.config.ts
│   │
│   └── desktop/                     # Tauri app (Phase 6)
│       ├── package.json
│       ├── tauri.conf.json
│       ├── src-tauri/               # Rust side
│       │   ├── Cargo.toml
│       │   ├── tauri.conf.json
│       │   └── src/
│       │       ├── main.rs
│       │       ├── commands.rs      # invoke handlers
│       │       ├── compile.rs       # local tectonic invocation
│       │       └── offline.rs       # SQLite sync state
│       └── src/                     # imports apps/web's React app
│           └── main.tsx
│
├── packages/
│   ├── editor/                      # @scribe/editor — CodeMirror 6 LaTeX
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts             # public API
│   │   │   ├── latex-language.ts    # Lezer grammar + LanguageSupport
│   │   │   ├── lezer-latex.grammar  # source for Lezer parser
│   │   │   ├── autocomplete.ts      # commands, refs, cites
│   │   │   ├── snippets.ts          # built-in + user snippets
│   │   │   ├── linter.ts            # error markers from compile log
│   │   │   ├── synctex.ts           # forward sync (Phase 2)
│   │   │   ├── theme.ts             # base + dark + high-contrast
│   │   │   ├── extensions/          # composable extensions
│   │   │   │   ├── auto-close-env.ts
│   │   │   │   ├── ruler.ts
│   │   │   │   ├── vim.ts
│   │   │   │   ├── emacs.ts
│   │   │   │   ├── spellcheck.ts
│   │   │   │   └── word-count.ts
│   │   │   ├── commands-db.json     # bundled LaTeX command reference
│   │   │   └── snippets-db.json
│   │   └── tests/
│   │
│   ├── ai/                          # @scribe/ai — adapters
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts             # AIAdapter interface + factory
│   │   │   ├── adapters/
│   │   │   │   ├── openai.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── gemini.ts
│   │   │   │   ├── ollama.ts
│   │   │   │   ├── lmstudio.ts
│   │   │   │   └── openai-compatible.ts
│   │   │   ├── prompts/             # feature-specific prompt templates
│   │   │   │   ├── fix-error.ts
│   │   │   │   ├── improve-writing.ts
│   │   │   │   ├── expand-section.ts
│   │   │   │   ├── summarize.ts
│   │   │   │   ├── translate.ts
│   │   │   │   ├── generate-equation.ts
│   │   │   │   ├── explain-command.ts
│   │   │   │   ├── complete-sentence.ts
│   │   │   │   ├── caption.ts
│   │   │   │   ├── grammar.ts
│   │   │   │   └── bib-suggest.ts
│   │   │   └── stream.ts            # SSE helpers
│   │   └── tests/
│   │
│   ├── compiler-client/             # @scribe/compiler-client
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── log-parser.ts        # extract errors, warnings, line numbers
│   │   │   ├── error-types.ts
│   │   │   └── trigger.ts           # debounced compile trigger
│   │   └── tests/
│   │
│   ├── yjs-provider/                # @scribe/yjs-provider
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts             # provider factory + reconnect logic
│   │   │   ├── awareness.ts         # cursor + presence helpers
│   │   │   └── auth.ts              # JWT-on-connect handshake
│   │   └── tests/
│   │
│   ├── ui/                          # @scribe/ui — shadcn/ui components
│   │   ├── package.json
│   │   ├── tailwind.config.ts
│   │   ├── components.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── components/          # ~25-30 shadcn components
│   │
│   └── shared/                      # @scribe/shared — types + utils
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── types/               # DB row types, API contracts
│           │   ├── db.ts            # generated from Supabase
│           │   ├── api.ts
│           │   └── ai.ts
│           ├── schema/              # zod schemas, shared validation
│           └── utils/
│
├── server/                          # Fastify backend
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.ts                 # server bootstrap
│   │   ├── config.ts                # env loading + validation (zod)
│   │   ├── plugins/                 # Fastify plugins
│   │   │   ├── auth.ts              # JWT verify middleware
│   │   │   ├── cors.ts
│   │   │   ├── csp.ts
│   │   │   ├── ratelimit.ts
│   │   │   └── supabase.ts          # supabase client decorator
│   │   ├── routes/
│   │   │   ├── auth.ts              # session helpers (most auth is in Supabase)
│   │   │   ├── projects.ts          # CRUD
│   │   │   ├── files.ts             # CRUD + snapshot endpoint
│   │   │   ├── compile.ts           # POST → enqueue, GET → status, WS → logs
│   │   │   ├── invite.ts            # create, accept
│   │   │   ├── ai.ts                # proxy → @scribe/ai
│   │   │   ├── comments.ts
│   │   │   ├── history.ts           # version history list, restore
│   │   │   └── templates.ts         # list, create from project
│   │   ├── services/
│   │   │   ├── compile-queue.ts     # BullMQ producer + log pub-sub
│   │   │   ├── compile-worker.ts    # BullMQ worker (runs in tectonic container)
│   │   │   ├── email.ts             # nodemailer wrapper
│   │   │   ├── storage.ts           # Supabase Storage wrappers
│   │   │   ├── ai-proxy.ts          # decrypts key, picks adapter, streams
│   │   │   ├── encryption.ts        # AES-256-GCM wrapper
│   │   │   └── yjs-persistence.ts   # Postgres-backed Yjs persistence adapter
│   │   ├── yjs-server.ts            # y-websocket attached to Fastify
│   │   └── workers/
│   │       └── compile.ts           # entry for the worker process
│   └── tests/
│
├── supabase/
│   ├── config.toml                  # supabase CLI config
│   ├── migrations/                  # SQL migrations, numbered
│   │   ├── 20260521000001_init_users.sql
│   │   ├── 20260521000002_projects.sql
│   │   ├── 20260521000003_project_members.sql
│   │   ├── 20260521000004_project_files.sql
│   │   ├── 20260521000005_compile_jobs.sql
│   │   ├── 20260521000006_comments.sql
│   │   ├── 20260521000007_project_templates.sql
│   │   ├── 20260521000008_yjs_updates.sql      # Yjs persistence
│   │   ├── 20260521000009_storage_buckets.sql
│   │   └── 20260521000010_rls_policies.sql     # all RLS policies in one place
│   ├── seed.sql                     # template scaffolding data
│   └── functions/                   # Supabase Edge Functions (if needed; likely none)
│
└── docs/
    ├── self-hosting.md
    ├── architecture.md
    ├── ai-adapters.md               # how to add a new AI adapter
    ├── api.md                       # backend API reference
    └── desktop.md                   # Tauri build/sign/distribute
```

---

## 5. Phase-by-Phase Plan

### Phase 0 — Foundation

**Goal:** monorepo skeleton with all tooling working. `pnpm install` succeeds, every
package builds, every package lints, every package typechecks.

| Task | Files | Notes |
|---|---|---|
| Root tooling | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `prettier.config.cjs`, `.editorconfig`, `.nvmrc`, `.gitignore` | Lock Node to LTS (20.x). Turborepo pipeline: `build`, `lint`, `typecheck`, `test`. |
| Shared package | `packages/shared/*` | Zod schemas + DB type stubs. Re-export `Database` type generated by Supabase CLI later. |
| UI package | `packages/ui/*` | shadcn/ui setup. Generate ~5 base components (Button, Input, Dialog, Card, Sheet). The rest are added on demand. |
| Web app skeleton | `apps/web/*` | Vite + React + Tailwind + router. One placeholder route. |
| Server skeleton | `server/*` | Fastify with one `/health` route. Env config via zod. |
| `.env.example` | root | Documents every env var planned across all phases. Marked TODO until used. |
| `README.md` | root | Project pitch, current status banner ("Phase 0 — foundation only"), dev quickstart. |

**Exit criteria:** `pnpm install && pnpm run build && pnpm run lint && pnpm run typecheck`
all pass from a clean clone.

---

### Phase 1 — Auth, Projects, Files

Spec steps 1, 2, 3, 4.

| Task | Files | Notes |
|---|---|---|
| Supabase init | `supabase/config.toml`, `supabase/migrations/*` | Local stack via `supabase start`. Migrations 1-7 + 10 (RLS). Migration 8 (yjs_updates) deferred to Phase 3. |
| RLS policies | `migrations/...rls_policies.sql` | All policies in one file is easier to audit than scattered. Tested with `pgTAP` or hand-written assertions. |
| Type generation | `packages/shared/src/types/db.ts` | `supabase gen types typescript` script in package.json. |
| Auth UI | `apps/web/src/routes/login.tsx`, `signup.tsx`, `lib/supabase.ts` | Supabase JS client. Email/password + magic link + Google + GitHub OAuth. Verification email handled by Supabase. |
| Auth middleware | `server/src/plugins/auth.ts` | Verify Supabase JWT on each protected request. `@fastify/auth` + `jose`. |
| Project routes | `server/src/routes/projects.ts` | CRUD. RLS handles authorization; backend just forwards to Supabase. |
| Dashboard UI | `apps/web/src/routes/index.tsx` | Project grid + create button (template modal stubbed). |
| File routes | `server/src/routes/files.ts` | List, upload (multipart, validate MIME, size cap), download, rename, delete. Hits Supabase Storage. |
| File tree UI | `apps/web/src/components/FileTree/*` | DnD via `@dnd-kit/sortable`. Right-click context menu. |
| Project settings | `apps/web/src/components/ProjectSettings/*` | Modal. Members list, role changer, rename, danger zone. |

**Exit criteria:** sign up, create project, upload a `.tex` file, see it in the file tree.

---

### Phase 2 — Editor, Compile, PDF

Spec steps 5, 6, 7.

| Task | Files | Notes |
|---|---|---|
| LaTeX Lezer grammar | `packages/editor/src/lezer-latex.grammar` | Custom grammar. **High risk task** — Lezer is unfamiliar to most. Estimate 2-3 days. There is a community `lezer-latex` package we should evaluate before writing from scratch. |
| LanguageSupport | `packages/editor/src/latex-language.ts` | Wires grammar to CodeMirror. |
| Editor extensions | `packages/editor/src/extensions/*` | auto-close-env, ruler, theme, word-count, snippets. |
| Autocomplete | `packages/editor/src/autocomplete.ts` | Commands from bundled DB; `\ref{}` from parsed `\label{}` calls in current file; `\cite{}` from `.bib` (Phase 5 fully). |
| Tectonic worker | `server/src/workers/compile.ts`, `Dockerfile.tectonic` | Container with tectonic binary. Pulls files from Storage to tmpdir, runs `tectonic`, captures stdout/stderr, uploads PDF + log to Storage. |
| Compile API | `server/src/routes/compile.ts` | POST → create job + enqueue. WebSocket → stream log lines via Redis pub-sub. |
| Compile UI | `apps/web/src/components/CompileLog/*` | Streaming log panel. Errors clickable → jump to source. Error markers in gutter via @scribe/editor linter ext. |
| Log parser | `packages/compiler-client/src/log-parser.ts` | Robust regex-based parser for tectonic + pdflatex error formats. |
| PDF preview | `apps/web/src/components/PDFPreview/*` | pdf.js viewer. Forward SyncTeX (line → page coords) using `synctex.gz` parsed on backend, sent alongside PDF. |
| Compile history | `apps/web/src/components/CompileLog/History.tsx` | List last 10 jobs; click to view that PDF. |

**Exit criteria:** edit `main.tex`, hit Ctrl+Enter, see PDF render in <10s for a simple doc.

---

### Phase 3 — Realtime, Reviews, Versions

Spec steps 8, 10, 11.

| Task | Files | Notes |
|---|---|---|
| Yjs migration | `migrations/...yjs_updates.sql` | Table for binary update rows; index on (doc_id, created_at). |
| Yjs persistence | `server/src/services/yjs-persistence.ts` | Custom adapter writing to Postgres. Compaction job (collapse N updates into one snapshot) runs hourly. |
| y-websocket | `server/src/yjs-server.ts` | Attached to Fastify. JWT auth on connection. |
| Yjs client provider | `packages/yjs-provider/*` | Wraps `y-websocket`; reconnect, auth, awareness. |
| Editor collab integration | `apps/web/src/components/Editor/*` | Y.Text binding, awareness → CM6 decorations for remote cursors. Presence avatars in header. |
| Comments | `server/src/routes/comments.ts`, UI in `ReviewPanel/` | CRUD; @mentions trigger emails (reuse Phase 2.5 email). |
| Track Changes | editor extension + UI | Implemented as Y.Text "suggestion" attribute; rendered as decorations. Accept = remove attribute and keep; reject = revert. |
| Version history | `server/src/routes/history.ts`, UI in `VersionHistory/` | Snapshot all `.tex` files on debounced save. Stored as `versions/<project_id>/<ts>/...` in Storage. Diff view uses `diff-match-patch`. |

**Exit criteria:** two browsers, same project, edits sync live with colored cursors;
comments thread; restore a 1-hour-old version.

---

### Phase 4 — AI

Spec step 12.

| Task | Files | Notes |
|---|---|---|
| Adapter interface | `packages/ai/src/index.ts` | `AIAdapter` interface as specified. |
| Adapters | `packages/ai/src/adapters/*` | OpenAI, Anthropic, Gemini, Ollama, LM Studio, Custom OpenAI-compatible. Each ~50-100 LOC. |
| Prompt library | `packages/ai/src/prompts/*` | One file per feature. Keep prompts versioned and easy to edit. |
| AI proxy | `server/src/services/ai-proxy.ts`, `routes/ai.ts` | Decrypts user key, picks adapter, streams via SSE. Rate limited. |
| Encryption | `server/src/services/encryption.ts` | AES-256-GCM. `AI_KEY_ENCRYPTION_KEY` env var, 32 bytes base64. |
| Settings UI — AI tab | `apps/web/src/routes/settings/ai.tsx` | Provider dropdown, key, model, host/port for local. Test button hits `/api/ai/ping`. |
| Command palette | `apps/web/src/components/AICommandPalette/*` | Ctrl+Shift+A → palette with all features. |
| Chat panel | `apps/web/src/components/AIChat/*` | Resizable right pane. Multi-turn. Insert-into-editor button. |
| Ghost text completion | `packages/editor/src/extensions/ghost-complete.ts` | Inline ghost text via CM6's `placeholder` API or a custom widget. Toggleable. |

**Default models** (recommendation — see Q8):
- OpenAI: `gpt-4o`
- Anthropic: `claude-sonnet-4-6` (NOT the older one in spec; `claude-opus-4-7` as "high quality" preset)
- Gemini: `gemini-1.5-pro`
- Ollama / LM Studio: free-text, default suggestion `llama3`

**Exit criteria:** configure OpenAI key in settings, select paragraph, "Improve writing"
returns a rewrite that can be accepted into the editor.

---

### Phase 5 — Polish (Bibliography, Templates, Settings)

Spec steps 13, 14, 15.

| Task | Files | Notes |
|---|---|---|
| BibTeX parser | `packages/shared/src/utils/bibtex.ts` | Use `@retorquere/bibtex-parser`. |
| Bib UI | `apps/web/src/components/Bibliography/*` | Searchable table. Add/edit form. Import from DOI (CrossRef API) + arXiv. |
| `\cite{}` integration | hook into `packages/editor/autocomplete.ts` | Read parsed bib entries from project store. |
| Templates seed | `supabase/seed.sql` + `supabase/functions/...` or one-time script | Inserts ~10 templates with their files into `project_templates`. |
| Template gallery | `apps/web/src/components/TemplateGallery/*` | Modal on new project. Filter by category, search. |
| Save as template | route + UI | Owner can promote a project. Templates are user-scoped or org-scoped. |
| Settings tabs | `apps/web/src/routes/settings/*` | Profile, Editor, AI (done in Phase 4), Notifications, Templates, Integrations stub, Billing stub. |

**Exit criteria:** create new project from "IEEE Article" template; import a DOI into bib;
toggle Vim mode in settings and see the editor switch.

---

### Phase 6 — Desktop + Offline

Spec steps 16, 17.

| Task | Files | Notes |
|---|---|---|
| Tauri scaffolding | `apps/desktop/*`, `src-tauri/*` | `pnpm tauri init` then customize. Window menu (File/Edit/View/Project/Tools/Help) defined in Rust. |
| Local compile | `src-tauri/src/compile.rs` | Detect bundled tectonic; fall back to system `latexmk`. Invoke and stream stdout. |
| Offline SQLite | `tauri-plugin-sql` | Mirror `project_files` and Yjs updates. Sync layer in Rust. |
| Sync engine | `src-tauri/src/sync.rs` + `apps/web/src/lib/sync.ts` | On reconnect, push local Yjs updates, pull remote updates. Metadata conflicts → modal (see Q11). |
| Deep links | tauri.conf + handler | `scribe://invite/<token>` opens app and navigates to invite route. |
| Auto-updater | `tauri-plugin-updater` | Signed updates from a release server (GitHub Releases works). |

**Exit criteria:** desktop app builds for Win/macOS/Linux, can edit and compile a project
offline, syncs when back online.

---

### Phase 7 — Self-hosting

Spec step 18.

| Task | Files | Notes |
|---|---|---|
| Backend Dockerfile | `server/Dockerfile` | Multi-stage build, slim runtime image. |
| Tectonic Dockerfile | `server/Dockerfile.tectonic` | Based on `tectonictypesetting/tectonic`. |
| docker-compose | `docker-compose.yml` | Services: `app`, `worker`, `redis`, plus `supabase` instructions (use their compose). |
| docs | `docs/self-hosting.md`, etc. | Step-by-step deploy, env var reference, AI adapter docs, troubleshooting. |
| CONTRIBUTING.md | root | How to set up dev env, code style, PR process. |
| GitHub Actions (optional but recommended) | `.github/workflows/*` | CI: lint, typecheck, test, build images. |

**Exit criteria:** fresh VM, `git clone`, set 5 env vars, `docker compose up` → working
Scribe at `http://localhost:3000`.

---

## 6. Cross-Cutting Concerns

### Testing strategy

| Layer | Tool | What we test |
|---|---|---|
| Unit | Vitest | log parser, bib parser, encryption, AI adapter formatting, Lezer grammar samples |
| Component | Vitest + Testing Library | core UI components in `@scribe/ui` |
| Integration | Vitest + supertest | Fastify routes against a test Supabase instance |
| E2E | Playwright | sign-up → create project → edit → compile → see PDF |
| RLS | pgTAP | sample queries that should/shouldn't return rows |

Not aiming for full coverage. Focus E2E on the golden path of each phase's exit criteria.

### CI/CD

- GitHub Actions matrix: lint, typecheck, test, build.
- Tauri builds for 3 platforms run on tag push.
- Docker images pushed to GHCR on merge to main.

### Security checklist (from spec, made concrete)

- JWT verify middleware on every route except `/health` and `/api/invite/accept`.
- File upload: `mime-types` check + magic-byte sniffing for images; size cap 50MB per file,
  100MB cumulative per project, configurable.
- AI keys: AES-256-GCM at rest. Never returned in API responses (return masked `sk-***1234`).
- Invite tokens: `crypto.randomBytes(32).toString('base64url')`, 7-day expiry, single-use.
- Rate limiting via `@fastify/rate-limit`: 60 req/min global, 5 concurrent compile jobs/user,
  20 AI requests/min/user.
- CORS allowlist via env. CSP set by `@fastify/helmet`.
- All inputs validated by zod schemas; never trust client.

### Telemetry / observability

- Structured logging via `pino` (Fastify's default).
- OpenTelemetry hooks (optional — env-gated). Documented in self-hosting guide.
- No external telemetry by default — self-hosted ethos.

---

## 7. Spec Step → Phase Mapping

| Spec step | Phase |
|---|---|
| 1. Supabase schema + RLS | 1 |
| 2. Auth | 1 |
| 3. Project CRUD + dashboard | 1 |
| 4. File manager + Storage | 1 |
| 5. CodeMirror LaTeX editor | 2 |
| 6. Compilation pipeline | 2 |
| 7. PDF preview | 2 |
| 8. Yjs realtime | 3 |
| 9. Email invitations | 1 (small — folded into Phase 1, not waiting until 9th) |
| 10. Comments + Track Changes | 3 |
| 11. Version history | 3 |
| 12. AI | 4 |
| 13. Bibliography | 5 |
| 14. Templates | 5 |
| 15. Settings UI | 5 (AI tab earlier in Phase 4) |
| 16. Tauri | 6 |
| 17. Offline + sync | 6 |
| 18. Docker + docs | 7 |

Two intentional deviations from the spec's ordering:
- **Step 9 (emails) moves earlier** into Phase 1 because invitations are needed to test
  Phase 1 itself (multi-user projects).
- **Step 15 (Settings UI) splits**: the AI tab lives in Phase 4 since that's when it's
  needed; the rest moves to Phase 5.

---

## 8. Recommended Deviations from the Spec

Already noted above; consolidated here for visibility.

1. **Default Claude model** updated from `claude-sonnet-4-20250514` to `claude-sonnet-4-6`
   (Q8). The spec name is from May 2025 and is an older model; we expose model choice as
   free text, so this is reversible.
2. **Forward SyncTeX only** in v1 (Q7). Inverse SyncTeX deferred.
3. **Email is Nodemailer-only**, not a pluggable adapter (Q5). Resend via SMTP.
4. **Step 9 moves earlier** to enable Phase 1 testing.
5. **Yjs persistence is Postgres-backed** (Q1) — spec is silent here, this picks one.
6. **Template thumbnails are hand-curated PNGs** for v1 (Q10).

---

## 9. Glossary of Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lezer LaTeX grammar is harder than expected | Med | High | Evaluate existing community grammars first; budget 1 week, not 1 day |
| Yjs + Postgres persistence has subtle bugs | Med | High | Use battle-tested `y-postgresql` or similar if it exists; otherwise extensive tests |
| Tectonic in container has package-fetch issues offline | High | Med | Document a "cache" volume; consider TeX Live as fallback |
| Tauri offline sync conflicts under-spec'd | High | Med | Designed in detail in Phase 6; expect a Phase 6.5 iteration |
| AI adapter rate limits trip in dev | Low | Low | Mock adapter for tests |
| Compile log streaming over WS races compile job state machine | Med | Med | Single Redis pub-sub channel per `compile_job.id` with terminal "DONE" / "ERR" message |
| Yjs `awareness` over WAN can leak cursor positions when JWT expires mid-session | Low | Med | Reconnect logic re-authenticates; drop awareness on disconnect |
| Supabase Storage rate limits hit during bulk file ops | Low | Med | Batch + retry with backoff |

---

## 10. What I'll Do After You Approve This Plan

When you say go, I'll execute **Phase 0** in one continuous pass:

1. Write root tooling files (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, etc.)
2. Create each package's skeleton with a passing build.
3. Stand up the Fastify server with a `/health` route.
4. Stand up the Vite/React app with one placeholder route.
5. Drop a working `.env.example` and a phase-aware `README.md`.
6. Run `pnpm install && pnpm run build && pnpm run lint && pnpm run typecheck` and confirm
   everything passes.

That should be one focused session. Phase 1 begins next.

---

## 11. Status

> **Plan approved 2026-05-21.** All Q1-Q12 recommendations accepted. All Section 8
> deviations accepted. License: AGPL-3.0. Standards from Section 1.5 are binding from
> the first commit.
>
> **Phase 0: complete.** Foundation shipped — monorepo builds, lints, typechecks, tests.
> **Phase 1: complete.** Supabase migrations + RLS + storage policies; Fastify server
> with hexagonal services + zod DTOs + JWT auth; web app with Supabase auth (email/
> password, magic link, Google, GitHub OAuth), dashboard, project page with file tree
> and members panel, and email-based invitation flow.
> **Phase 2: complete.** CodeMirror 6 LaTeX editor (`@scribe/editor`) with stex
> highlighting, snippets, command/ref/cite autocomplete, auto-close env, ruler,
> word count, three themes; compile pipeline using BullMQ + Redis with a tectonic
> worker process (`server/src/workers/compile.ts`) and `server/Dockerfile.tectonic`;
> Fastify routes for enqueue/status/list and a WebSocket stream for live logs;
> pdf.js preview panel; forward SyncTeX (server-uploaded `.synctex.gz` is gunzipped
> and parsed client-side via `DecompressionStream`); compile-log entries flow back
> as editor gutter diagnostics. `compile_jobs` table + retention trigger added.
> **Phase 3: complete.** Yjs collaboration: Postgres-backed
> persistence (`yjs_updates` table, base64 update rows, compaction beyond N=100
> updates), Fastify WebSocket sync server (`server/src/yjs/*`) with JWT auth and
> project-membership gating, `@scribe/yjs-provider` client with reconnect + awareness,
> `y-codemirror.next` binding wired into the editor (remote cursors via awareness),
> presence avatars in the workspace header. Comments backend (`comments` table +
> RLS, service, routes) and React `ReviewPanel` with threaded replies + resolve.
> Version history backend (`project_versions` table, snapshot JSON in
> `version-snapshots` Storage bucket, list/get/restore routes) and React
> `VersionHistory` panel with diff-match-patch preview. Track Changes shipped in
> May 2026 as a narrower MVP: suggestion comments with `replacement_text` + Apply,
> covered under §12 row 6.4. The full Y.Text custom-attribute decoration layer
> remains a future-phase candidate.
> **Phase 4: complete.** `@scribe/ai` package with `AIAdapter` interface and six
> adapters (OpenAI, Anthropic, Gemini, Ollama, LM Studio, OpenAI-compatible), a
> curated prompt library (improve/grammar/summarize/expand/complete/translate/
> equation/explain/caption/bib/chat), and a streaming helper. Server: AES-256-GCM
> envelope (`encryption.ts`) keyed by `AI_KEY_ENCRYPTION_KEY`, AI service that
> stores encrypted keys in `users.ai_config`, SSE-streaming `/api/ai/complete`,
> plus `/api/ai/config` and `/api/ai/ping`. Web: Settings → AI tab (provider
> picker, model field, base URL for local providers, masked key preview, test
> connection); `AICommandPalette` (Ctrl+Shift+A) with 9 actions over the current
> selection; `AIChat` right-side panel with multi-turn history and per-message
> "Insert into editor"; `ghost-completion` extension for the editor (Tab to
> accept, Esc to dismiss, abort-on-edit).
> **Phase 5: complete (minus stretch goals).** Hand-written BibTeX parser in
> `@scribe/shared/utils/bibtex.ts` (handles nested braces, quoted values,
> @comment / @string / @preamble), wired into the editor's `\cite{...}`
> autocomplete by way of the workspace. `BibliographyPanel` (searchable, add
> entry that appends to the project's `.bib` file). `TEMPLATE_METADATA` exposed
> as a public shared record; `TemplateGallery` card grid with search + category
> filter, swapped into `NewProjectDialog` to replace the bare select. Settings
> turned into a tabbed page (Profile / Editor / AI): profile updates display
> name and avatar via Supabase `updateUser` + `public.users` mirror; editor
> prefs (font size, ruler column, autocomplete/ghost-text/vim/lint toggles)
> persist via the existing zustand store. Stretch goals deferred per Section 11:
> billing/Plan tab, auto-rendered template thumbnails, "save existing project as
> template" route, Google/GitHub OAuth provider config (requires external app
> creation). All four pipeline gates pass.
>
> **Phase 5.5 / 5.6: complete (May 2026).** Overleaf-parity sweep over §12:
> shipped multi-file tabs, project-wide find/replace, citation lookup (CrossRef +
> arXiv), shareable project links, notification inbox, community template gallery,
> chktex live-lint with `Fix:` hints, equation/ref/cite hover preview, suggestion-
> mode comments, real-time voice chat, plus the compile-engine fallback machinery,
> TeX log-file parsing, and cross-platform setup/run scripts. Only §12 row 6.6
> (GitHub sync) remains, blocked on external OAuth setup.
>
> **Next action:** execute Phase 6 — Tauri desktop wrapper + offline sync.

## 12. Overleaf-parity candidates (post-v1)

Once Phases 0–5 are live (they are, as of 2026-05) and the v1.0 surface is
stable, the next push is closing the perceived gap with Overleaf for the
typical academic workflow. These are *candidates* — pick any subset based
on value-per-week — not a committed phase. Each line carries an impact
note + effort estimate so we can sequence by ratio later.

| # | Feature | Why it matters | Effort | Status |
|---|---|---|---|---|
| 6.1 | **Multi-file editor tabs** | Today the editor shows one file at a time; real LaTeX work moves between `main.tex`, `sec/*.tex`, `references.bib` constantly. Tab strip above the editor, unsaved-dot indicator, middle-click to close, Ctrl+W shortcut. | M | **v1 shipped 2026-05-24** |
| 6.2 | **Project-wide Find & Replace** | CodeMirror's in-file search works (Ctrl+F); the missing piece is cross-file rename of `\foo` / labels / cite-keys. New right-panel "Search" tab with hit list per file and "replace in all" mutation. | M | **v1 shipped 2026-05-24** |
| 6.3 | **Citation lookup (DOI / CrossRef / arXiv)** | Users currently leave the app to grab BibTeX from CrossRef/Zotero. A "Search citation" panel that hits CrossRef + arXiv, formats the result, appends to the project's `.bib` file in one click. Huge academic-workflow win. | L–M | **v1 shipped 2026-05-24** |
| 6.4 | **Track changes / suggestion mode** | Yjs gives us multi-user editing; track changes is the "suggest mode" supervisors and journals need. CRDT custom-attribute decoration layer on top of the existing Y.Text binding. | H | **v1 shipped 2026-05-24** — narrower-scope MVP: suggestions are stored as comments with a `replacement_text` field; the reviewer hits Apply to overwrite the anchored range. The full Y.Text custom-attribute decoration layer is still on the table for a v2. |
| 6.5 | **Project sharing via link** | One-click read-only or comment-only public URL — what people actually use day-to-day, distinct from email invites. Token-based bypass of auth on the `/project/:id` route with role pinned to viewer/commenter. | L–M | **v1 shipped 2026-05-24** — sign-in-required (not anonymous), redeems into a real `project_members` row, role-upgrade-only semantics |
| 6.6 | **Git / GitHub integration** | Push/pull to a GitHub repo. Lets users version-control + share via the world's biggest social network for code. Niche but loved by power users. Two layers: OAuth to GitHub, then a sync worker that diffs project-files against a repo. | H | not started — deferred per the skip-external-config rule (OAuth app setup) |
| 6.7 | **Template gallery from community** | Phase 5 shipped six built-in templates. A browsable catalogue (IEEE, ACM, NeurIPS, ICML, theses, CVs) is Overleaf's largest organic on-ramp. Could be a thin wrapper around the existing template loader plus a hosted JSON manifest of community contributions. | L–M | **v1 shipped 2026-05-24** — JSON manifest at `apps/web/public/community-templates.json` (IEEE, ACM, thesis, homework set, poster); client-side seed via existing `api.files.create` |
| 6.8 | **Notification inbox** | Mentions, replies to comments, invite acceptances currently surface as transient toasts and vanish. Bell-icon dropdown with unread counts + read/unread state on a new `notifications` table. Makes the app "sticky" for collaborators. | M | **v1 shipped 2026-05-24** — emit hooks on comment mentions + replies + share-link redemptions |
| 6.9 | **chktex linter integration** | Underline LaTeX style issues inline (over-bracketed eqs, `\over` vs `\frac`, double `~`, etc.). Server helper hooks into the compile pipeline; output flows through the existing `applyCompileDiagnostics` path. | M | **v1 shipped 2026-05-24** — runs both on compile AND debounced on typing-pause via new `/api/projects/:id/lint` endpoint; messages get pattern-matched `Fix:` hints; user toggle in Settings → Editor |
| 6.10 | **Equation/`\ref` hover preview** | Hover a `\ref{eq:foo}` → popover with the rendered equation; hover a `\cite{key}` → popover with the bib entry's authors/title. Uses the already-parsed `bibEntries` + a small KaTeX render. Small but instantly reads as "premium polish". | L–M | **v1 shipped 2026-05-24** — CodeMirror `hoverTooltip` extension; pops raw LaTeX source for ref/eqref (KaTeX rendering deferred) and formatted bib entry for cite |
| 6.11 | **Real-time voice chat** | Mic / speaker icons in the editor toolbar. WebRTC peer-to-peer mesh signalled over `/api/projects/:projectId/voice` (`scribe-server/src/voice/`). Browser-to-browser DTLS-SRTP for media — the server never touches audio bytes. Echo-cancel / noise-suppression via `getUserMedia` constraints. Per-peer mute broadcast + master speaker mute. Works up to ~5 participants on mesh; SFU upgrade deferred. | M | **v1 shipped 2026-05-24** |

### What's still open

The only remaining row is **6.6 Git/GitHub integration**, blocked on external OAuth-app
setup (per the project's skip-external-config rule). Everything else from §12 shipped
in May 2026.

### Adjacent improvements landed alongside §12

These weren't rows in the original table but are part of the same May 2026 push:

- **Compile-engine fallback** — `COMPILE_FALLBACK_ENGINE` env var. When the primary engine
  (tectonic / latexmk) returns non-zero, the worker re-runs with the fallback and uses
  its outcome.
- **TeX `.log` file parsing** — the parser was fed only stdout+stderr; Overfull/Underfull
  `\hbox` warnings only land in the engine's `main.log` and were therefore invisible.
  Now the worker also reads `main.log` (4 MiB cap) and feeds it through `log_parser`.
- **Cross-platform setup + run scripts** — `./scripts/setup.{sh,ps1}` and
  `./scripts/run.{sh,ps1}` covering Debian/Ubuntu apt, Fedora dnf, Arch pacman, macOS
  Homebrew, and Windows winget. See `scripts/README.md`.
- **Sticky compile duration** — the log panel now keeps the last successful duration
  visible (parenthesised + dim) while a fresh compile runs, so the timing display never
  goes blank post-compile.

### Things explicitly *not* in scope yet, to keep momentum
The spec is maximalist; the following are intentionally deferred past v1.0:

- **Inverse SyncTeX** (PDF click → editor line). Forward SyncTeX is in Phase 2; inverse
  is a stretch goal post-v1.
- **Full CRDT-based Track Changes** with per-character author attribution and a
  decoration layer that diffs ranges. The May 2026 row 6.4 shipped a narrower MVP
  (suggestion comments with `replacement_text` + Apply) that covers the supervisor-
  proposes / author-accepts workflow; the full Y.Text custom-attribute layer remains
  on the table for a future phase.
- **GitHub sync integration** (Settings → Integrations). Stubbed UI in Phase 5; full
  push/pull deferred — blocked on external OAuth-app setup.
- **Billing / Plan tab** in Settings. Shows "Self-hosted" badge only; SaaS billing is
  out of scope.
- **Auto-rendered template thumbnails**. v1 ships with hand-curated PNGs.
- **External KMS** for AI key encryption. Env-var master key for v1; KMS path
  documented but not implemented.
- **KaTeX rendering inside hover popovers**. The 6.10 row ships the raw LaTeX source
  of the surrounding equation block; rendering it as a real formula is a follow-up that
  needs `katex` added to the SPA bundle.

These can be revisited after v1.0 ships; doing so now would dilute the core experience.
