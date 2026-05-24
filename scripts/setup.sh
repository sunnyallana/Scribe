#!/usr/bin/env bash
# Scribe — one-shot setup for Linux and macOS.
#
# Installs every runtime tool the project needs:
#   • Node 22+ (corepack → pnpm)
#   • Rust toolchain (rustup)
#   • Redis  (compile queue)
#   • Tectonic (LaTeX engine)
#   • Tauri runtime libs (webkit2gtk / libsoup / patchelf on Linux,
#     Xcode CLT on macOS) so `run-desktop.sh` works without a second
#     install round
#   • Optional: pandoc, chktex (export + style linter)
#
# Then runs `pnpm install` and `cargo build` to materialise all
# project-level dependencies.
#
# Idempotent: re-running skips anything already present.
# Usage:  ./scripts/setup.sh
#         ./scripts/setup.sh --skip-rust       (if you already have rustup)
#         ./scripts/setup.sh --no-optional     (skip pandoc + chktex)
#         ./scripts/setup.sh --no-desktop      (skip Tauri / desktop libs)
#         ./scripts/setup.sh --skip-build      (skip the final cargo build pre-warm)

set -euo pipefail

# ---------- pretty output ---------------------------------------------------
BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m')
RESET=$(printf '\033[0m')

info()  { printf "%s▶%s %s\n" "$GREEN" "$RESET" "$*"; }
warn()  { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
fail()  { printf "%s✗%s %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }
skip()  { printf "%s·%s %s%s%s\n" "$DIM" "$RESET" "$DIM" "$*" "$RESET"; }

# ---------- args ------------------------------------------------------------
SKIP_RUST=0
INSTALL_OPTIONAL=1
INSTALL_DESKTOP=1
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-rust) SKIP_RUST=1 ;;
    --no-optional) INSTALL_OPTIONAL=0 ;;
    --no-desktop) INSTALL_DESKTOP=0 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --help|-h)
      sed -n '2,22p' "$0"; exit 0 ;;
    *) fail "unknown flag: $arg" ;;
  esac
done

# ---------- OS detection ----------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *) fail "unsupported OS: $(uname -s). Use setup.ps1 on Windows." ;;
esac
info "Detected OS: ${BOLD}$OS${RESET}"

# Project root = parent of this script's directory.
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$REPO_ROOT"
info "Project root: $REPO_ROOT"

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- Homebrew (macOS only) ------------------------------------------
if [[ "$OS" == "mac" ]]; then
  if ! have brew; then
    info "Installing Homebrew…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # brew puts itself in either /opt/homebrew (Apple Silicon) or /usr/local (Intel).
    if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  else
    skip "Homebrew present ($(brew --version | head -1))"
  fi
  # Xcode Command Line Tools — provides clang/ld so cargo can link.
  # `xcode-select -p` exits non-zero when the tools aren't installed.
  if ! xcode-select -p >/dev/null 2>&1; then
    info "Installing Xcode Command Line Tools (you may see a system dialog)…"
    xcode-select --install || true
    warn "Re-run setup.sh after the Command Line Tools installer finishes."
  else
    skip "Xcode Command Line Tools present"
  fi
fi

# ---------- Linux package manager detection --------------------------------
# We bind a single PKG verb ("apt" | "dnf" | "pacman" | "none") and let the
# wrapper functions dispatch — keeps the per-tool blocks readable instead
# of forking three times per install.
PKG=none
if [[ "$OS" == "linux" ]]; then
  if have apt-get; then PKG=apt
  elif have dnf;     then PKG=dnf
  elif have pacman;  then PKG=pacman
  else warn "No supported package manager (apt/dnf/pacman) found. Tool installs may need manual steps."
  fi
  if [[ "$PKG" != "none" ]]; then info "Linux package manager: ${BOLD}$PKG${RESET}"; fi
fi

# Install a list of packages via whichever manager we detected. Already-
# installed packages are silently skipped on all three (it's idempotent).
pkg_install() {
  case "$PKG" in
    apt)
      sudo apt-get update -qq
      sudo apt-get install -y "$@"
      ;;
    dnf)
      sudo dnf install -y "$@"
      ;;
    pacman)
      # `--needed` is the pacman equivalent of "skip if already installed".
      # `--noconfirm` keeps the script non-interactive.
      sudo pacman -Sy --needed --noconfirm "$@"
      ;;
    *)
      warn "No package manager — please install manually: $*"
      ;;
  esac
}

# ---------- Node 22+ + corepack/pnpm ---------------------------------------
# pnpm 11.x dropped Node 20 support; 22.13 is the floor. 22.x is the
# current LTS ("jod") so this is the same line Node's release calendar
# recommends.
NODE_MAJOR=0
if have node; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
fi
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  info "Installing Node 22+ …"
  case "$OS:$PKG" in
    mac:*)
      brew install node@22
      brew link --overwrite --force node@22 || true
      ;;
    linux:apt)
      # Ubuntu / Debian default repos lag the current LTS; NodeSource's
      # setup script adds the upstream LTS repo.
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      pkg_install nodejs
      ;;
    linux:dnf)
      # Fedora 40+ ships Node 22 as the active module stream. The reset
      # / enable lines are no-ops if it's already the active stream.
      sudo dnf module reset -y nodejs 2>/dev/null || true
      sudo dnf module enable -y nodejs:22 2>/dev/null || true
      pkg_install nodejs npm
      ;;
    linux:pacman)
      # Arch repos always carry current Node — `nodejs` + `npm` is enough.
      pkg_install nodejs npm
      ;;
    *)
      fail "Couldn't auto-install Node. Install Node 22+ manually then re-run."
      ;;
  esac
else
  skip "Node $(node -v) present"
fi

if ! have pnpm; then
  info "Enabling pnpm via corepack…"
  sudo corepack enable || corepack enable
  # corepack lazily-installs on first use; nudge it now so the next
  # `pnpm install` doesn't pause for the prompt.
  CI=true pnpm --version >/dev/null
else
  skip "pnpm $(pnpm --version) present"
fi

# ---------- Build essentials (Linux) ---------------------------------------
# Cargo invokes the system linker + cc for several transitive native
# crates (ring, openssl-sys via vendored builds, etc.). Without these,
# `cargo build` fails with "linker `cc` not found" on minimal installs.
if [[ "$OS" == "linux" ]]; then
  case "$PKG" in
    apt)    pkg_install build-essential pkg-config libssl-dev curl ca-certificates ;;
    dnf)    pkg_install gcc gcc-c++ make pkgconf-pkg-config openssl-devel curl ca-certificates ;;
    pacman) pkg_install base-devel openssl curl ca-certificates ;;
  esac
fi

# ---------- Tauri desktop runtime libs -------------------------------------
# webkit2gtk hosts the SPA inside the desktop window; libsoup is its
# HTTP transport; librsvg renders the menubar icons; patchelf is what
# `tauri bundle` uses to fix up the resulting binary's RPATH. Without
# all four, `pnpm tauri dev` errors out inside Cargo's link step with
# the kind of "package_name not found via pkg-config" message that
# wastes an hour to chase. `--no-desktop` skips the lot for setups
# that will only ever ssh into the API.
if [[ "$INSTALL_DESKTOP" == "1" && "$OS" == "linux" ]]; then
  info "Installing Tauri desktop runtime libs (webkit2gtk, libsoup, librsvg, patchelf)…"
  case "$PKG" in
    apt)
      # 24.04 ships webkit2gtk-4.1 / libsoup-3; 22.04 still has the 4.0
      # / soup-2 names — apt-get's `Has::` selector picks whichever set
      # is available so the same line works on both. If both 4.1 and
      # 4.0 packages exist we prefer 4.1 (Tauri 2.x default).
      if apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
        pkg_install libwebkit2gtk-4.1-dev libsoup-3.0-dev libappindicator3-dev librsvg2-dev patchelf
      else
        pkg_install libwebkit2gtk-4.0-dev libsoup2.4-dev libappindicator3-dev librsvg2-dev patchelf
      fi
      ;;
    dnf)
      pkg_install webkit2gtk4.1-devel libsoup3-devel libappindicator-gtk3-devel librsvg2-devel patchelf || \
        pkg_install webkit2gtk4.0-devel libsoup-devel libappindicator-gtk3-devel librsvg2-devel patchelf
      ;;
    pacman)
      # Arch ships current versions; webkit2gtk-4.1 is the package name.
      pkg_install webkit2gtk-4.1 libsoup3 libappindicator-gtk3 librsvg patchelf
      ;;
    *)
      warn "Couldn't auto-install Tauri runtime libs. Desktop builds may fail."
      ;;
  esac
fi

# ---------- Rust toolchain --------------------------------------------------
if [[ "$SKIP_RUST" == "0" ]]; then
  if ! have cargo; then
    info "Installing Rust via rustup…"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    # Make cargo available in the current shell.
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  else
    skip "Rust $(cargo --version) present"
  fi
fi

# ---------- Redis -----------------------------------------------------------
if ! have redis-server && ! have redis-cli; then
  info "Installing Redis…"
  case "$OS:$PKG" in
    mac:*)
      brew install redis
      ;;
    linux:apt)
      pkg_install redis-server
      ;;
    linux:dnf)
      # On Fedora the package is just `redis`, and the binary is
      # `redis-server` once installed.
      pkg_install redis
      ;;
    linux:pacman)
      pkg_install redis
      ;;
    *)
      warn "Install Redis manually (compile queue requires it)."
      ;;
  esac
else
  skip "Redis present"
fi

# ---------- Tectonic --------------------------------------------------------
if ! have tectonic; then
  info "Installing Tectonic (LaTeX engine)…"
  if [[ "$OS" == "mac" ]]; then
    brew install tectonic
  else
    # Linux: the official installer drops a single binary in $HOME/.cargo/bin
    # if cargo is on PATH; otherwise it asks for a writable dir.
    curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh
  fi
else
  skip "Tectonic present ($(tectonic --version 2>/dev/null | head -1))"
fi

# ---------- Optional: pandoc + chktex --------------------------------------
if [[ "$INSTALL_OPTIONAL" == "1" ]]; then
  if ! have pandoc; then
    info "Installing pandoc (export to .md / .docx)…"
    case "$OS:$PKG" in
      mac:*)        brew install pandoc ;;
      linux:apt)    pkg_install pandoc ;;
      linux:dnf)    pkg_install pandoc ;;
      linux:pacman) pkg_install pandoc-cli ;;  # Arch packages the CLI separately from the lib
      *)            warn "Install pandoc manually if you want .md/.docx export." ;;
    esac
  else skip "pandoc present"
  fi
  if ! have chktex; then
    info "Installing chktex (LaTeX style linter)…"
    case "$OS:$PKG" in
      mac:*)        brew install chktex ;;
      linux:apt)    pkg_install chktex ;;
      linux:dnf)    pkg_install texlive-chktex ;;   # Fedora bundles it under texlive-*
      linux:pacman) pkg_install texlive-binextra ;; # Arch ships chktex inside texlive-binextra
      *)            warn "Install chktex manually if you want the LaTeX style linter." ;;
    esac
  else skip "chktex present"
  fi
fi

# ---------- .env scaffold ---------------------------------------------------
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  if [[ -f "$REPO_ROOT/.env.example" ]]; then
    info "No .env found — copying from .env.example"
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    warn "Edit .env and fill in your SUPABASE_* keys + DATABASE_URL before running the API."
  else
    warn "No .env or .env.example present. The API will start in degraded mode."
  fi
fi

# ---------- Project deps ----------------------------------------------------
info "Installing JS workspace dependencies (pnpm install)…"
# CI=true skips the corepack first-run prompt; the project's package.json
# also marks msgpackr-extract as ignored to side-step its postinstall.
CI=true pnpm install

if [[ "$SKIP_BUILD" == "0" ]]; then
  info "Pre-building Rust workspace (cargo build, this can take a few minutes on first run)…"
  cargo build --manifest-path servers/rust/Cargo.toml --workspace --quiet
else
  skip "Skipping cargo pre-build (--skip-build)"
fi

# ---------- .env sanity check ----------------------------------------------
# Surface any required keys still at their placeholder so the user
# doesn't get a boot-time crash. Looks for either an empty value (KEY=)
# or one of the placeholders ".env.example" ships with. Non-fatal —
# we just remind.
ENV_MISSING=()
if [[ -f "$REPO_ROOT/.env" ]]; then
  while IFS= read -r line; do
    # Skip blank lines and comments. `[[:space:]]` is POSIX-portable
    # in bash's `[[ =~ ]]`; `\s` would only work on the GNU build.
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_JWT_SECRET|DATABASE_URL|VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)
        if [[ -z "$val" || "$val" == "http://127.0.0.1:54321" ]]; then
          ENV_MISSING+=("$key")
        fi
        ;;
    esac
  done < "$REPO_ROOT/.env"
fi

cat <<EOF

${GREEN}${BOLD}Setup complete.${RESET}

Next:
EOF

if [[ ${#ENV_MISSING[@]} -gt 0 ]]; then
  cat <<EOF
  ${YELLOW}!${RESET} .env still has placeholder values for:
      $(printf '%s ' "${ENV_MISSING[@]}")
    See ${BOLD}docs/env-vars.md${RESET} for where to obtain each value.
EOF
fi

cat <<EOF
  • Apply Supabase migrations against your project:
      ${BOLD}supabase db push${RESET}      (or: pnpm supabase:start for the local stack)
  • Browser dev:
      ${BOLD}./scripts/run.sh${RESET}              (Redis + Rust API + Vite SPA)
  • Native desktop dev:
      ${BOLD}./scripts/run-desktop.sh${RESET}      (Redis + Rust API + Tauri shell)

Optional knobs (add to .env):
  • TECTONIC_BIN=$(command -v tectonic 2>/dev/null || echo "/path/to/tectonic")
  • CHKTEX_BIN=$(command -v chktex 2>/dev/null || echo "/path/to/chktex")   (enables style linter)
EOF
