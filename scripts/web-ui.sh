#!/usr/bin/env bash
# Start the jobby web UI on a port that stays clear of the crowded dev ranges.
#
# The default deliberately sits outside 3000-3999: that band already holds other
# projects on this machine (3000, 3200), and `next dev` silently hops to the next
# free port when its target is taken. That hop is the actual problem — the app
# ends up somewhere nobody predicted, and a bookmark to the old port shows either
# nothing or a different project entirely. Here a taken port is a hard failure
# with the owning process named, so the URL is always the one printed.
#
# Lives in scripts/ rather than web/package.json: web/ is tracked from upstream,
# so a changed dev script there is a fork diff that conflicts on every merge.
#
# JOBBY-BL-079: product runtime is Docker Compose. Host port = .ports.yml compose-web.
# This script is emergency-only. --stop always works so a leftover host Next
# can be killed. Start requires JOBBY_ALLOW_HOST_NEXT=1.
#
# Usage:
#   scripts/web-ui.sh --stop
#   JOBBY_ALLOW_HOST_NEXT=1 scripts/web-ui.sh --detach

set -euo pipefail

PORT="${JOBBY_WEB_PORT:-4720}"

# Where the CV export writes finished PDFs. Exported so the detached `next dev`
# child inherits it. This is set here, not only in docker-compose.override.yml,
# because the web UI runs on the HOST: the container's JOBBY_EXPORT_DIR is a mount
# point that never applies to this process, so without this line the Export PDF
# button would keep writing into the repo's output/ while the CLI wrote elsewhere.
export JOBBY_EXPORT_DIR="${JOBBY_EXPORT_DIR:-$HOME/Documents/jobby/resume}"

# Which Claude model the AI-backed buttons use. Pinned because the account's
# DEFAULT model can run out of credits while the named models still have quota,
# and `claude -p` reports that as plain text on stdout then exits non-zero — which
# the UI could only describe as "the CLI exited with an error". Unset this to fall
# back to the account default.
export JOBBY_CLAUDE_MODEL="${JOBBY_CLAUDE_MODEL:-sonnet}"
# Cursor Agent default for Score — account frontier models often hit Pro quota first.
export JOBBY_CURSOR_MODEL="${JOBBY_CURSOR_MODEL:-composer-2.5-fast}"
# Local / tunneled Ollama via OpenCode (Config → "Ollama (via OpenCode)").
# Default points at the a remote lab host SSH tunnel; override for local :11434.
export JOBBY_OLLAMA_BASE_URL="${JOBBY_OLLAMA_BASE_URL:-http://127.0.0.1:11435/v1}"
export JOBBY_OLLAMA_MODEL="${JOBBY_OLLAMA_MODEL:-qwen3:8b}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Score workers (Claude / Codex / Cursor Agent / Ollama) must run against the checkout root.
export CAREER_OPS_ROOT="${CAREER_OPS_ROOT:-$ROOT}"
WEB_DIR="$ROOT/web"
PID_FILE="${TMPDIR:-/tmp}/jobby-web.pid"
LOG_FILE="${TMPDIR:-/tmp}/jobby-web.log"

die() {
  echo "web-ui: $1" >&2
  exit 1
}

port_owner() {
  # `lsof` exits non-zero when nothing matches, which under `pipefail` would fail
  # the whole pipeline and — inside a command substitution with `set -e` — abort
  # the script with no output at all. A free port is the expected case, so the
  # non-zero exit is swallowed here.
  { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR==2 {print $1" (pid "$2")"}'
}

stop_running() {
  [ -f "$PID_FILE" ] || { echo "No recorded web UI process."; return 0; }

  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    # Negative pid: --detach starts a new session, so the tree (npm plus the
    # next-server child holding the port) has to be signalled as a group or the
    # child keeps the port and the next start fails.
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    echo "Stopped pid $pid."
  else
    echo "Recorded pid $pid is no longer running."
  fi
  rm -f "$PID_FILE"
}

case "${1:-}" in
  --stop)
    stop_running
    exit 0
    ;;
  --detach | "") ;;
  *) die "unknown argument: $1 (expected --detach or --stop)" ;;
esac

if [ "${JOBBY_ALLOW_HOST_NEXT:-}" != "1" ]; then
  die "host next is forbidden (JOBBY-BL-079). Run: docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build  (URL = .ports.yml compose-web). Emergency only: JOBBY_ALLOW_HOST_NEXT=1 $0 ${1:-}"
fi

[ -d "$WEB_DIR/node_modules" ] || die "web dependencies are missing. Run: (cd web && npm ci)"

owner="$(port_owner)"
[ -z "$owner" ] || die "port $PORT is already taken by $owner. Set JOBBY_WEB_PORT to a free port."

cd "$WEB_DIR"

if [ "${1:-}" = "--detach" ]; then
  # setsid is absent on macOS, so Perl supplies the same detach: a new session
  # means the server is not in this shell's process group and outlives both this
  # script and the terminal it was launched from.
  perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' \
    npx next dev -p "$PORT" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null --max-time 2 "http://localhost:$PORT" 2>/dev/null; then
      echo "jobby web UI → http://localhost:$PORT  (pid $(cat "$PID_FILE"), log $LOG_FILE)"
      echo "Stop it with: scripts/web-ui.sh --stop"
      exit 0
    fi
    sleep 0.5
  done

  die "the server did not answer on port $PORT within 20s. Check $LOG_FILE"
fi

echo "jobby web UI → http://localhost:$PORT  (Ctrl-C to stop)"
exec npx next dev -p "$PORT"
