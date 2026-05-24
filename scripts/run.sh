#!/usr/bin/env bash
# Scribe — bring up Redis + Rust API + Vite SPA together.
#
# Behaviour:
#   • Starts Redis if it isn't already listening on 127.0.0.1:6379.
#   • Starts the Rust API (`cargo run -p scribe-server`).
#   • Starts the SPA (`pnpm --filter @scribe/web dev`).
#   • Logs from API + SPA stream into the current terminal, prefixed.
#   • Ctrl+C cleanly tears all three down.
#
# Idempotent — running it twice doesn't duplicate processes.

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
  # `--daemonize no` so the process stays in our process group and
  # Ctrl+C reaches it. `--save ""` disables RDB snapshots — we don't
  # need persistence for the compile queue, and disabling avoids the
  # "no permission to chdir" warning when the working dir isn't
  # writable.
  redis-server --port 6379 --daemonize no --save "" --appendonly no \
    >"$REPO_ROOT/runtime.redis.log" 2>&1 &
  REDIS_PID=$!
  # Wait for Redis to actually accept connections before continuing —
  # the API's queue-init runs once at startup and won't retry.
  for _ in $(seq 1 30); do
    if listening 6379; then break; fi
    sleep 0.2
  done
  if ! listening 6379; then
    echo "Redis failed to start. See runtime.redis.log" >&2
    exit 1
  fi
fi

# ---- prefix helper ---------------------------------------------------------
# Tags each output line with [api] or [web] so a single tail is readable.
prefix() {
  local tag=$1 color=$2
  awk -v tag="$tag" -v color="$color" -v reset="$RESET" \
    '{ print color "[" tag "]" reset " " $0; fflush(); }'
}

# ---- Spawn API + SPA -------------------------------------------------------
API_PID=
WEB_PID=

cleanup() {
  echo
  printf "%s⏻%s Shutting down…\n" "$YELLOW" "$RESET"
  # Stop child processes we started. Don't kill Redis if it was already
  # running before this script — that surprised the user once before.
  [[ -n "$WEB_PID"  ]] && kill "$WEB_PID"  2>/dev/null || true
  [[ -n "$API_PID"  ]] && kill "$API_PID"  2>/dev/null || true
  [[ -n "$REDIS_PID" ]] && kill "$REDIS_PID" 2>/dev/null || true
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

printf "%s▶%s Starting Vite SPA on :5173…\n" "$GREEN" "$RESET"
(
  pnpm --filter @scribe/web dev 2>&1 | prefix "web" "$MAGENTA"
) &
WEB_PID=$!

cat <<EOF

${BOLD}Up.${RESET}
  • API   http://localhost:3000   (or PORT from .env)
  • SPA   http://localhost:5173
  • Redis 127.0.0.1:6379

Ctrl+C to stop everything.
EOF

wait
