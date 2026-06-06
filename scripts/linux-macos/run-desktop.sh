#!/usr/bin/env bash
# Scribe — bring up Redis + Rust API + Tauri desktop shell together.
#
# Behaviour:
#   • Starts Redis if it isn't already listening on 127.0.0.1:6379.
#   • Starts the Rust API (`cargo run -p scribe-server`).
#   • Starts the Tauri desktop (`pnpm --filter @scribe/desktop tauri dev`).
#     Tauri itself spawns the Vite SPA on :5173 via `beforeDevCommand`,
#     so we don't start it separately.
#   • Logs from API + Tauri stream into the current terminal, prefixed.
#   • Ctrl+C cleanly tears all three down.
#
# Use this instead of run.sh when you want the native window. The
# regular `run.sh` is still right for browser-only development.

set -euo pipefail

BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
CYAN=$(printf '\033[36m'); MAGENTA=$(printf '\033[35m'); RESET=$(printf '\033[0m')

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$REPO_ROOT"

have() { command -v "$1" >/dev/null 2>&1; }
listening() { lsof -i ":$1" -sTCP:LISTEN -t >/dev/null 2>&1 || (have ss && ss -ltn "sport = :$1" 2>/dev/null | grep -q ":$1"); }

# ---- Redis -----------------------------------------------------------------
REDIS_PID=
if listening 6379; then
  printf "%s✓%s Redis already running on :6379\n" "$GREEN" "$RESET"
else
  if ! have redis-server; then
    printf "Redis not installed. Run %s./scripts/setup.sh%s first.\n" "$BOLD" "$RESET" >&2
    exit 1
  fi
  printf "%s▶%s Starting Redis…\n" "$GREEN" "$RESET"
  redis-server --port 6379 --daemonize no --save "" --appendonly no \
    >"$REPO_ROOT/runtime.redis.log" 2>&1 &
  REDIS_PID=$!
  for _ in $(seq 1 30); do
    if listening 6379; then break; fi
    sleep 0.2
  done
  if ! listening 6379; then
    echo "Redis failed to start. See runtime.redis.log" >&2
    exit 1
  fi
fi

# `kill` only when we actually have a PID, and treat "already dead" as
# success. Written as a function so shellcheck doesn't flag the
# previous `[[ -n $PID ]] && kill || true` chain (SC2015).
maybe_kill() {
  local pid=$1
  [[ -z "$pid" ]] && return 0
  kill "$pid" 2>/dev/null || true
}

# ---- Vite port pre-check ---------------------------------------------------
# Tauri's `beforeDevCommand` runs vite with strictPort:true. If 5173 is
# busy we'll get a confusing failure deep inside the Tauri build, so
# bail out early with a friendly message.
if listening 5173; then
  printf "Port 5173 is already in use. Stop the other Vite dev server (or run.sh) before running run-desktop.\n" >&2
  maybe_kill "$REDIS_PID"
  exit 1
fi

# ---- prefix helper ---------------------------------------------------------
prefix() {
  local tag=$1 color=$2
  awk -v tag="$tag" -v color="$color" -v reset="$RESET" \
    '{ print color "[" tag "]" reset " " $0; fflush(); }'
}

API_PID=
TAURI_PID=

cleanup() {
  echo
  printf "%s⏻%s Shutting down…\n" "$YELLOW" "$RESET"
  # Tauri spawns vite + the Rust shell as children; killing the parent
  # tears them down. The API runs separately. Redis only stops if we
  # started it (matches the run.sh contract).
  maybe_kill "$TAURI_PID"
  maybe_kill "$API_PID"
  maybe_kill "$REDIS_PID"
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

printf "%s▶%s Starting Rust API (port from .env PORT, default 3000)…\n" "$GREEN" "$RESET"
(
  cargo run --manifest-path servers/rust/Cargo.toml -p scribe-server 2>&1 \
    | prefix "api" "$CYAN"
) &
API_PID=$!

printf "%s▶%s Starting Tauri desktop (window opens after Rust links)…\n" "$GREEN" "$RESET"
(
  CI=true pnpm --filter @scribe/desktop tauri dev 2>&1 \
    | prefix "tauri" "$MAGENTA"
) &
TAURI_PID=$!

cat <<EOF

${BOLD}Up.${RESET}
  • API     http://localhost:3000   (or PORT from .env)
  • SPA     http://localhost:5173   (served by Tauri's vite child)
  • Redis   127.0.0.1:6379
  • Desktop window opens when cargo finishes linking

Ctrl+C to stop everything.
EOF

wait
