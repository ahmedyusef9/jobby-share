#!/usr/bin/env bash
# Nightly reverse-ATS sweep → notes/scans/YYYY-MM-DD.md, newest postings first.
#
# Prefer this over Browser MCP for the bulk pass: Greenhouse/Ashby/Lever/Workday
# expose full boards over HTTP (zero LLM tokens). Use Browser MCP only for SSR
# career pages without an ATS API, or for per-URL liveness checks.
#
# Shares a lock with hourly-scan.sh so passes never stack (~50+ min Workday).
# Lock is mkdir-based (macOS has no util-linux flock).
#
# Usage:
#   scripts/nightly-ats-scan.sh              # since=2 days (catches overnight postings)
#   JOBBY_SCAN_SINCE=1 scripts/nightly-ats-scan.sh
#   scripts/nightly-ats-scan.sh --liveness   # Playwright-verify before writing (slow)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scan-lock.sh
source "$ROOT/scripts/scan-lock.sh"

SINCE="${JOBBY_SCAN_SINCE:-2}"
OUT_DIR="${JOBBY_SCAN_OUT:-$ROOT/notes/scans}"
LOG_DIR="${JOBBY_SCAN_LOG:-$HOME/Library/Logs/jobby}"
mkdir -p "$OUT_DIR" "$LOG_DIR"

STAMP="$(date '+%Y-%m-%d')"
LOG="$LOG_DIR/nightly-ats-scan-$STAMP.log"

if ! jobby_scan_acquire_lock; then
  tee -a "$LOG" <<<"[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] skipped — scan already running (lock=$JOBBY_SCAN_LOCK_DIR)"
  exit 0
fi
trap jobby_scan_release_lock EXIT

{
  echo "=== jobby nightly-ats-scan $STAMP ==="
  echo "cwd=$ROOT since=${SINCE}d out=$OUT_DIR lock=$JOBBY_SCAN_LOCK_DIR"
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  # --md-out writes a dated digest; scan-ats-full already sorts by postedAt desc.
  node scan-ats-full.mjs --since "$SINCE" --md-out "$OUT_DIR" "$@"
  echo "done $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} 2>&1 | tee -a "$LOG"

DIGEST="$OUT_DIR/$STAMP.md"
if [ -f "$DIGEST" ]; then
  echo "digest → $DIGEST"
else
  # Upstream may name the file Reverse-ATS style; surface whatever landed today.
  ls -1t "$OUT_DIR"/*"$STAMP"* 2>/dev/null | head -5 || true
fi
