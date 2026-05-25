# @scribe/web

The React + Vite + CodeMirror 6 single-page app: the editor you write in.
Runs as a regular browser SPA, and as the webview content inside the
[Tauri desktop shell](../desktop/README.md). Same source, two surfaces,
branched on `isTauri()` in the few divergent paths (compile dispatch,
sync engine, deep-link routing).

## What's in it

- **Multi-cursor editing** with coloured cursors and live presence
  avatars, backed by a Yjs CRDT, conflict-free even if two people type
  into the same line at the same time.
- **Voice chat** via WebRTC peer-to-peer mesh, Opus at 48 kbps,
  browser-native echo-cancel / noise-suppression, per-peer mute and
  master speaker mute.
- **Multi-file editor tabs** above the editor, Ctrl/Cmd+W to close,
  middle-click close, scrollable strip restored from the last session
  per project.
- **Three-tier roles**: owner / editor / viewer. Viewers can compile
  and read but never write; editors get full access; owners get
  destructive ops.
- **Live PDF preview** with continuous scroll, virtualised rendering
  for large docs, SyncTeX click-to-source, quick-jump page input, and
  a switchable paged mode for documents over 50 pages.
- **Bibliography panel** parses every `.bib` file in the project,
  auto-completes `\cite{...}` against keys, and surfaces author /
  title / year for each entry.
- **Citation search** against CrossRef + arXiv from inside the app,
  one-click "Add to .bib" appends a formatted BibTeX entry.
- **Project-wide find & replace** in a dedicated right-panel tab,
  case-sensitive, whole-word, regex toggles; results grouped per
  file; "Replace all" rewrites every affected file in one operation.
- **Hover preview** for `\ref{...}` / `\eqref{...}` / `\cite{...}`,
  pops the source of the equation / figure / theorem block (with
  file:line) or the parsed bib entry, without navigating away.
- **Suggestion mode** for comments, propose a text replacement for
  an anchored range; reviewers Apply or Dismiss.
- **Style-lint via chktex** on every keystroke pause (800 ms
  debounced) and on compile, with concrete `Fix:` hints.
- **Notification inbox**: bell icon in the nav with unread badge for
  mentions, comment replies, share-link redemptions.
- **Shareable project links**: owners issue a read-only or
  comment-only URL with optional expiry.
- **Community template gallery**: IEEE conference, ACM article,
  multi-chapter thesis, problem-set, conference poster, plus six
  built-in templates.
- **Version snapshots** of the whole project, restorable in one click.
- **AI assist** as inline rewrites, chat, and slash-command rephrasing.
- **Math palette**, **outline panel**, **comments**,
  **invite-by-email** with one-click copyable links.
- **Export**: download the rendered PDF, ship the source as a `.zip`,
  or convert with Pandoc to Markdown / DOCX.
- **Multi-language UI**: English, French, Spanish, German, Urdu
  (with RTL support). Every string flows through `react-i18next`.

## Run from source

Requires the [Rust API](../../servers/rust/README.md) to be running
(account, sync, collab, comments, share links, voice, and AI all flow
through it). For the one-shot scripted setup, see
[`scripts/README.md`](../../scripts/README.md).

```bash
# from the repo root, with .env filled in and migrations applied
pnpm install
pnpm --filter @scribe/web dev
#  → http://localhost:5173
```

If you're using a local Supabase stack, invite emails go to
**Inbucket** at `http://localhost:54324` (no SMTP needed). Every
`VITE_*` value is documented in [`docs/env-vars.md`](../../docs/env-vars.md).

## Build

```bash
pnpm --filter @scribe/web build       # tsc --noEmit && vite build
pnpm --filter @scribe/web preview     # serves the built dist/ on :4173
pnpm --filter @scribe/web e2e         # Playwright smoke specs (apps/web/e2e/)
```

## Layout

```
apps/web/
├── public/                  Static assets, robots.txt, favicon, community-templates.json
├── src/
│   ├── components/          Feature panels (Editor, PDFPreview, ReviewPanel, …)
│   ├── pages/               Route-level views (Dashboard, Project, Settings, auth/*)
│   ├── hooks/               useYjsDoc, useCompileSession, useAIStream, useVoiceRoom, …
│   ├── layouts/             AppShell + nav slots
│   ├── lib/                 supabase client, api wrapper, sync, exports, desktopDb
│   ├── stores/              Zustand stores (auth, settings, projectChrome)
│   └── i18n/                Locale bundles + react-i18next config
├── e2e/                     Playwright smoke specs (run against vite preview)
├── index.html               Vite entry
└── vite.config.ts           + vitest.config.ts (vitest extends vite via mergeConfig)
```

See the top-level [README](../../README.md) for the wider architecture
and where this SPA sits in it.
