#!/usr/bin/env bash
# Compatibility wrapper — reverse-ATS now lives in nightly-ats-scan.sh.
# Prefer: scripts/hourly-scan.sh (hourly light) + scripts/nightly-ats-scan.sh (heavy).
#
# Usage:
#   scripts/daily-scan.sh
#   JOBBY_SCAN_SINCE=1 scripts/daily-scan.sh
#   scripts/daily-scan.sh --liveness

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/scripts/nightly-ats-scan.sh" "$@"
