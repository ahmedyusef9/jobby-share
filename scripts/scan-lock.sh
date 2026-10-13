#!/usr/bin/env bash
# Shared scan lock helpers for macOS (no util-linux flock).
# Atomic mkdir lock with PID file + stale recovery.
#
# Usage (from sibling scripts):
#   # shellcheck source=scan-lock.sh
#   source "$(dirname "$0")/scan-lock.sh"
#   jobby_scan_acquire_lock || exit 0
#   trap jobby_scan_release_lock EXIT

JOBBY_SCAN_LOCK_DIR="${JOBBY_SCAN_LOCK:-$HOME/Library/Logs/jobby/scan.lock}"

jobby_scan_acquire_lock() {
  local dir="${JOBBY_SCAN_LOCK_DIR}"
  local pidfile="$dir/pid"
  mkdir -p "$(dirname "$dir")"

  if mkdir "$dir" 2>/dev/null; then
    echo "$$" > "$pidfile"
    return 0
  fi

  # Stale recovery: if PID is gone, take over.
  if [ -f "$pidfile" ]; then
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$old" ] && ! kill -0 "$old" 2>/dev/null; then
      rm -rf "$dir"
      if mkdir "$dir" 2>/dev/null; then
        echo "$$" > "$pidfile"
        return 0
      fi
    fi
  else
    # Lock dir without pid — treat as stale after empty.
    rm -rf "$dir"
    if mkdir "$dir" 2>/dev/null; then
      echo "$$" > "$pidfile"
      return 0
    fi
  fi

  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] skipped — scan already running (lock=$dir)"
  return 1
}

jobby_scan_release_lock() {
  local dir="${JOBBY_SCAN_LOCK_DIR}"
  local pidfile="$dir/pid"
  if [ -f "$pidfile" ]; then
    local owner
    owner="$(cat "$pidfile" 2>/dev/null || true)"
    if [ "$owner" = "$$" ]; then
      rm -rf "$dir"
    fi
  fi
}
