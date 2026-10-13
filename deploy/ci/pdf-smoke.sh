#!/usr/bin/env bash
# JOBBY-BL-011 — PDF / Playwright smoke via worker image (durable).
# Usage (repo root, compose stack optional):
#   ./deploy/ci/pdf-smoke.sh
#   ./deploy/ci/pdf-smoke.sh --build   # rebuild worker first
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--build" ]]; then
  docker compose -f deploy/docker-compose.yml build worker
fi

HTML=""
for candidate in \
  output/cv-ahmad-abo-alhija-checkmarx.html \
  output/cv-ahmad-abo-alhija-pointfive.html; do
  if [[ -f "$candidate" ]]; then
    HTML="/data/$candidate"
    break
  fi
done

if [[ -z "$HTML" ]]; then
  # Fall back to any tailored HTML under output/
  HOST_HTML="$(ls -t output/cv-*.html 2>/dev/null | head -1 || true)"
  if [[ -n "$HOST_HTML" ]]; then
    HTML="/data/$HOST_HTML"
  fi
fi

if [[ -z "$HTML" ]]; then
  echo "FAIL: no output/cv-*.html — run a pdf mode once or copy an HTML into output/" >&2
  exit 1
fi

STAMP="$(date +%Y-%m-%d)"
OUT="/data/output/cv-smoke-bl011-${STAMP}.pdf"
REPORT="${JOBBY_PDF_SMOKE_REPORT:-165}"

echo "==> PDF smoke via worker · html=$HTML · out=$OUT · report=$REPORT"
docker compose -f deploy/docker-compose.yml run --rm -w /data worker \
  node /data/generate-pdf.mjs \
  "$HTML" \
  "$OUT" \
  --format=a4 \
  --report="$REPORT" \
  --allow-reorder

HOST_OUT="${OUT#/data/}"
if [[ ! -s "$HOST_OUT" ]]; then
  echo "FAIL: missing or empty $HOST_OUT" >&2
  exit 1
fi

SIZE="$(wc -c < "$HOST_OUT" | tr -d ' ')"
echo "OK: $HOST_OUT ($SIZE bytes)"
