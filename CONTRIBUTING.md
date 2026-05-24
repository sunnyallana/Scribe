# Contributing to Scribe

Thanks for your interest. Scribe is an AGPL-3.0 project; contributions stay under
that licence. The bar to land a change is "clear value, tests where the bug would
recur, no regressions in the pipeline gates."

---

## TL;DR

```bash
git clone https://github.com/sunnyallana/Scribe.git
cd Scribe
./scripts/setup.sh        # or .\scripts\setup.ps1 on Windows
./scripts/run.sh          # boots Redis + API + SPA
```

Edit code. Open a PR. Pipeline gates run on every push; they must stay green.

---

## Repo layout

The full file-by-file map lives in [`PLAN.md`](./PLAN.md#4-monorepo-layout-file-by-file).
The headline split:

- `apps/web/` — Vite + React SPA.
- `apps/desktop/` — Tauri 2 shell. Standalone Cargo crate; reuses the SPA build from `apps/web`.
- `packages/` — internal libraries (`@scribe/editor`, `@scribe/ui`, `@scribe/shared`, …).
- `servers/rust/` — the Axum server + workers in a Cargo workspace.
- `supabase/migrations/` — forward-only SQL migrations.
- `scripts/` — cross-platform setup + run helpers + DB probes.

---

## Engineering standards

These are non-negotiable; PRs that violate them are sent back. The full version
lives in [`PLAN.md §1.5`](./PLAN.md#15-engineering-principles--ux-pillars); the
must-know subset:

- **Strict TypeScript.** `strict: true`, `noUncheckedIndexedAccess: true`, no `any`.
  ESLint forbids casts at non-boundary code.
- **Hexagonal Rust services.** A service is a struct over `PgPool` and its
  collaborators; HTTP/Axum lives only at the edge. No DB types leak into the API.
- **DTO boundary.** Inputs and outputs are zod schemas (TS) or `serde`-derived structs
  (Rust). Schemas are the contract; never serialise a raw DB row.
- **Result-shaped errors.** Backend services return `Result<T, E>`; throws are
  reserved for bugs. The route layer maps `Result::Err` to HTTP status codes.
- **No dead code, no orphan feature flags.** When a feature ships, its scaffolding
  comes out in the same PR.
- **One source of truth per state.** UI state in Zustand; server state in TanStack
  Query; derived state computed at the use site.

---

## Workflow

1. **Discuss first if it's >100 LoC.** Open an issue with the rough shape of the
   change before writing code. Avoids the "interesting work, wrong direction" PR.
2. **Branch.** `git checkout -b feature/<short-slug>` or `fix/<short-slug>`.
3. **Code.** Match the style of the surrounding files; ESLint and rustfmt will
   yell at you for the structural stuff.
4. **Test.** Adding a regression test for a bug fix is required. New features
   should have at least one Vitest (TS) or `#[test]` (Rust) covering the golden
   path.
5. **Run the gates locally.** See below.
6. **Open the PR.** Use the PR template; reference the issue if there is one. CI
   re-runs everything against the merge commit.

---

## Pipeline gates

Every PR must pass all of these. They run in CI but please run them locally
before pushing — turnaround is much faster.

```bash
# Lint everything (web + every package + the Rust workspaces)
pnpm -r run lint
cargo clippy --manifest-path servers/rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

# Type-check everything
pnpm -r run typecheck

# Tests (TS-side; Rust tests are in clippy --all-targets above when -- -D warnings)
pnpm -r run test

# Build everything
pnpm -r run build
cargo build --manifest-path servers/rust/Cargo.toml --workspace --release
```

A passing local run does *not* guarantee CI passes — CI also runs Playwright E2E
against a fresh Supabase instance. Don't be surprised if a flake there sends the PR
back for one re-run.

---

## Commit messages

Follow Conventional-Commits-ish prefixes, short subject, body explains *why*:

```
feat: ghost-text completion for the editor

CodeMirror's built-in inline-suggestion API doesn't survive Yjs sync —
the placeholder widget is replaced by remote updates before the user
can press Tab. The custom widget here uses a decoration set keyed on
view.state.field so Yjs rebroadcasts no-op against it.
```

`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`. The body should answer
"why is this change correct?" — not just describe the diff.

---

## Reviewing

- Drive-by reviews are welcome. You don't need a maintainer hat to leave comments.
- Code review focuses on **correctness, regressions, principles violations**.
  Stylistic nits are auto-fixable, so we don't slow PRs down on them.
- Approve only when you would deploy this commit yourself.

---

## What to work on

- **GitHub sync** is the only Overleaf-parity feature still open — see
  [`PLAN.md §12 row 6.6`](./PLAN.md). Blocked on OAuth-app setup, not on code.
- The PLAN's "Not in scope" list at the bottom of §12 is a fair menu of larger
  bets: inverse SyncTeX, full CRDT track-changes, external KMS for AI keys,
  KaTeX inside hover previews.
- Bug fixes are always welcome. Tag the issue with `good first issue` if you spot
  one that doesn't need deep system knowledge.

---

## Security

Found something exploitable? Don't open a public issue. Email
**sunny.shaban@astera.com** with the details and a CVE-style description; I'll
get back within a few days.

For the standard threat model (auth, AI key encryption, RLS posture), see
[`PLAN.md §6 → Security checklist`](./PLAN.md#security-checklist-from-spec-made-concrete).

---

## Licence

Scribe is [AGPL-3.0-or-later](./LICENSE). Anything you contribute lands under the
same licence; the AGPL's network-clause keeps modifications open for any
self-hosted instance.

By opening a PR you confirm you have the right to release the change under AGPL.
