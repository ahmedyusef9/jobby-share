#!/usr/bin/env bash
# Hourly light cross-platform scan → data/pipeline.md (Drushim, LinkedIn,
# Indeed, Google Careers, tracked companies). Zero LLM tokens.
#
# Shares a lock with nightly-ats-scan.sh so a reverse-ATS sweep never stacks
# with this pass (and vice versa). Lock is mkdir-based (macOS has no flock).
#
# Usage:
#   scripts/hourly-scan.sh
#   JOBBY_SCAN_LOCK=/tmp/other.lock scripts/hourly-scan.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scan-lock.sh
source "$ROOT/scripts/scan-lock.sh"

LOG_DIR="${JOBBY_SCAN_LOG:-$HOME/Library/Logs/jobby}"
OUT_DIR="${JOBBY_SCAN_OUT:-$ROOT/notes/scans}"
mkdir -p "$LOG_DIR" "$OUT_DIR"

STAMP="$(date '+%Y-%m-%d')"
HOUR="$(date '+%H%M')"
LOG="$LOG_DIR/hourly-scan-$STAMP.log"
NOTE="$OUT_DIR/hourly-$STAMP.md"

if ! jobby_scan_acquire_lock; then
  tee -a "$LOG" <<<"[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] skipped — scan already running (lock=$JOBBY_SCAN_LOCK_DIR)"
  exit 0
fi
trap jobby_scan_release_lock EXIT

{
  echo "=== jobby hourly-scan $STAMP $HOUR ==="
  echo "cwd=$ROOT lock=$JOBBY_SCAN_LOCK_DIR"
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  # Light pass: portals.yml local parsers + tracked ATS boards (not reverse-ATS).
  node scan.mjs
  echo "done $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} 2>&1 | tee -a "$LOG"

{
  echo ""
  echo "## Hourly run $HOUR ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))"
  echo ""
  echo "- Command: \`node scan.mjs\` (Drushim / LinkedIn / Indeed / Google / tracked companies)"
  echo "- Log: \`$LOG\`"
  echo ""
} >> "$NOTE"
