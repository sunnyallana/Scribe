# Scribe — prerequisites & post-install notes

Most of what you need is bundled with the installer; this file
documents what's provided, what's optional, and what the app expects
to be reachable.

## Bundled with the installer

| Component            | What it does                                       | Where it lives after install                                                  |
| -------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Scribe desktop**   | The editor + Tauri shell                           | `Scribe.exe` next to this file                                                |
| **WebView2 runtime** | Renders the SPA inside the Tauri window            | System-wide (auto-installed by the NSIS bootstrapper on first run if missing) |
| **Tectonic**         | LaTeX engine — the always-on fallback for compiles | `resources\tectonic.exe` next to `Scribe.exe`                                 |

That set is enough to start a project, edit `.tex` / `.bib` files,
and run a local compile. Nothing else is strictly required.

## Optional — offered during install (Windows)

| Component                                    | Why                                                                                                                   | How                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MiKTeX** (provides `pdflatex` / `latexmk`) | Faster compiles with proper multi-pass `\cite{}` / `\ref{}` resolution. Scribe prefers it over tectonic when present. | The NSIS installer's post-install step asks once; on Yes it runs `winget install MiKTeX.MiKTeX --silent`. You can skip it then install manually later — Scribe will auto-detect on next launch. |
| **Pandoc**                                   | Project export to `.docx` / `.md` / `.html`                                                                           | `winget install JohnMacFarlane.Pandoc`                                                                                                                                                          |
| **chktex**                                   | Inline LaTeX style linting                                                                                            | Ships with MiKTeX (`miktex-chktex`) or TeX Live                                                                                                                                                 |

## Server connection (only matters online)

The desktop shell can run **fully offline** for local LaTeX editing
and compile. Sign-in, real-time collaboration, comments, version
history, AI features, and project sharing need to reach a Scribe
backend:

- **Self-hosted:** point the desktop at your own Scribe server (the
  config UI lives in Settings → Server).
- **Cloud (when available):** the public Scribe service.
- **Air-gapped:** offline edits queue in the local SQLite mirror
  (`%LOCALAPPDATA%\io.scribe.desktop\scribe.db`) and push to the
  server on next reconnect.

## OS support

- **Windows 10 21H2+** and **Windows 11** (x64). Tested on 11.
- **macOS / Linux**: the Tauri shell builds for both but this
  installer is Windows-only. macOS DMG / Linux deb/AppImage are a
  separate release; tectonic for those platforms needs to be staged
  before `tauri build` (see `apps/desktop/README` in the repo).

## Where the app stores data

| Path                                                          | What                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `%LOCALAPPDATA%\io.scribe.desktop\scribe.db`                  | SQLite mirror — projects, files, Yjs updates, sync state                                               |
| `%LOCALAPPDATA%\io.scribe.desktop\workdirs\<project-id>\`     | Materialised LaTeX source for each project's most recent compile, plus the emitted PDF / `.synctex.gz` |
| `%APPDATA%\io.scribe.desktop\`                                | Tauri/WebView2 cookies + per-window state                                                              |
| `%LOCALAPPDATA%\Programs\Scribe\` (or wherever you installed) | The app exe + bundled tectonic + this file                                                             |

The uninstaller offers to remove `%LOCALAPPDATA%\io.scribe.desktop\`
on the way out — say **No** if you're upgrading and want to keep
your projects.

## Troubleshooting

- **"compile failed (exit 11)" / "kpsewhich: running with elevated privileges"** — you launched the app from an elevated shell and MiKTeX refuses to run as admin. Either start Scribe from a normal user terminal, or force the tectonic engine (Settings → Compile → Engine).
- **"compile_prepare_workdir: 0 files materialised"** — the initial sync hasn't run yet for this project. Either let the auto-sync finish (you'll see a brief spinner in the status bar) or hit refresh on the file tree.
- **PDF preview is blank after a successful compile** — the engine ran but didn't emit a PDF. Check the compile log for halt-on-error LaTeX errors; tectonic will report them with file + line numbers.

For anything else: `apps\desktop\src-tauri\target\debug.log` (dev
builds) and the Help → Diagnostics view (release builds) have the
detailed event stream.
