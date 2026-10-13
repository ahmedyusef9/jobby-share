#!/usr/bin/env bash
# JOBBY-BL-014 — durable compose image build check (survives upstream .github wipes).
# Usage (repo root):
#   ./deploy/ci/compose-build.sh
#   ./deploy/ci/compose-build.sh web    # Dockerfile.web only
#   ./deploy/ci/compose-build.sh worker # Dockerfile.worker only
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TARGET="${1:-both}"

build_web() {
  echo "==> Building web image (deploy/Dockerfile.web)"
  docker build -f deploy/Dockerfile.web -t jobby-ci-web:local .
}

build_worker() {
  echo "==> Building worker image (deploy/Dockerfile.worker)"
  docker build -f deploy/Dockerfile.worker -t jobby-ci-worker:local .
}

case "$TARGET" in
  web) build_web ;;
  worker) build_worker ;;
  both)
    build_web
    build_worker
    ;;
  *)
    echo "usage: $0 [web|worker|both]" >&2
    exit 2
    ;;
esac

echo "OK: compose image build(s) passed"
