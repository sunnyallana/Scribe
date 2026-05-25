# @scribe/desktop

The native [Tauri 2](https://v2.tauri.app) shell. Wraps the same
[web SPA](../web/README.md) inside a native window and adds the things
a browser can't do: local LaTeX compile against a bundled engine, a
SQLite mirror that survives a restart, OS-registered deep links,
native window menus, and a signed auto-updater.

## Install from releases

The native build ships everything needed to compile LaTeX on a fresh
machine, with no separate TeX install required. Grab an artifact from the
[Releases](https://github.com/sunnyallana/Scribe/releases) page.

```text
Scribe_<version>_x64-setup.exe     NSIS installer (recommended) · ~20 MB
Scribe_<version>_x64_en-US.msi     MSI (group-policy / IT-friendly) · ~29 MB
```

What the installer takes care of:

- **WebView2 runtime**: auto-bootstrapped by Tauri's NSIS template if
  missing.
- **Tectonic**: bundled at `<install>\resources\tectonic.exe`. Found
  first by the Rust shell's `resolve_engine`, so a fresh machine
  compiles immediately.
- **MiKTeX + Strawberry Perl**: the NSIS post-install hook offers to
  install both via `winget` so the preferred `latexmk` pipeline
  (multi-pass `\cite{}` / `\ref{}` resolution) works out of the box.
  Decline and the bundled tectonic remains as fallback.

After install you get:

- Start Menu shortcut + Add/Remove Programs entry with a custom
  uninstaller.
- `PREREQUISITES.md` at `<install>\resources\PREREQUISITES.md`
  covering OS support, data locations, and troubleshooting.
- **Auto-updater** wired against signed releases.
  `Help → Check for Updates` in the app menu.

The uninstaller asks whether to remove your local data
(`%LOCALAPPDATA%\io.scribe.desktop\`); pick **No** if you're rolling
back or upgrading.

## What's different from the browser

- **Offline-first compute**: SQLite mirrors the project tree, the
  bundled tectonic engine compiles locally, materialised workdirs
  survive restarts, and a sync engine pushes / pulls on reconnect
  with a three-way conflict modal for hard collisions.
- **Native menu** (File / Edit / View / Project / Tools / Help)
  defined in Rust, with menu events forwarded to the SPA.
- **Deep links**: OS-registered `scribe://invite/<token>` URLs open
  straight in the app.
- **Auto-updater** against signed GitHub Releases.
- **Add/Remove Programs entry** with a custom uninstaller that asks
  before removing your local data.

What the desktop shell still talks to the [Rust API](../../servers/rust/README.md) for:

| Feature                                 | Needs the API? |
| --------------------------------------- | -------------- |
| Editing a file locally                  | no             |
| Compiling locally with bundled tectonic | no             |
| Authentication, project list, file sync | **yes**        |
| Real-time collab (Yjs hub)              | **yes**        |
| Comments, share links, voice, AI        | **yes**        |

## Develop

The desktop shell is a standalone Cargo crate at `src-tauri/`, not
part of the [`servers/rust/`](../../servers/rust/README.md) workspace.

### Additional prerequisites (on top of the web list)

| Need                                | Why                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Platform-specific Tauri toolchain   | <https://v2.tauri.app/start/prerequisites/>: webview2 (Windows), webkit2gtk (Linux), Xcode (macOS)                        |
| **MSVC Build Tools** (Windows only) | Required by `cargo build` against `*-msvc` targets. Install via Visual Studio Installer → "Desktop development with C++" |

Optional but recommended on Windows: **MiKTeX** + **Strawberry Perl**
(via `winget install MiKTeX.MiKTeX StrawberryPerl.StrawberryPerl`),
so `latexmk` is available alongside the bundled tectonic.

### Dev shell

```bash
# Terminal 1: Redis  (skip if you already have one running)
docker run --rm -d --name scribe-redis -p 6379:6379 redis:7-alpine

# Terminal 2: Rust API
cargo run --manifest-path servers/rust/Cargo.toml -p scribe-server

# Terminal 3: Tauri dev shell. Loads the SPA from vite's dev server,
# wraps it in a native window, exposes the Rust IPC commands.
pnpm --filter @scribe/desktop tauri dev
```

The first `tauri dev` is slow (~5–10 min) because it compiles all the
Rust deps for the shell. Subsequent runs are incremental.

For the one-command setup, see
[`scripts/run-desktop.{sh,ps1}`](../../scripts/README.md).

### Release bundle

```bash
pnpm --filter @scribe/desktop tauri build              # signs only if env vars set
pnpm --filter @scribe/desktop tauri build --no-bundle  # binary only, no MSI/NSIS
```

Release bundles land under `src-tauri/target/release/bundle/`. For
signed releases driven by GitHub Actions, see
[`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Layout

```
apps/desktop/
├── package.json             Tauri CLI wrapper
└── src-tauri/
    ├── Cargo.toml           Standalone Cargo crate (not in the servers/rust workspace)
    ├── tauri.conf.json      Bundle config + identifier + updater pubkey
    ├── resources/           tectonic.exe + PREREQUISITES.md staged at build time
    ├── installer/
    │   ├── post-install.nsh  Offer MiKTeX + Perl via winget
    │   └── uninstall.nsh     Ask before deleting %LOCALAPPDATA%\io.scribe.desktop\
    ├── migrations/          SQLite mirror schema (001_init.sql, …)
    └── src/
        ├── main.rs          Entrypoint + menu bindings
        ├── compile.rs       Local LaTeX engine resolver + log streaming
        ├── sync.rs          Three-way conflict sync engine
        ├── db.rs            sqlx + tauri-plugin-fs scoped I/O
        └── deeplink.rs      scribe://invite/<token> handler
```

See the top-level [README](../../README.md) for the wider architecture.
