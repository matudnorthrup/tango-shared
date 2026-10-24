#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[gate] deterministic live core validation"
echo "[gate] repo=$ROOT"
echo "[gate] started=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

echo "[gate] bot status"
npm run bot:status

echo "[gate] bridge health"
curl -fsS http://127.0.0.1:8787/health
echo

status=0
if npm run test:deterministic-live-core; then
  echo "[gate] deterministic live core passed"
  exit 0
else
  status=$?
fi
echo "[gate] deterministic live core failed with status=$status"
echo "[gate] collecting diagnostics"

npm run bot:status || true
npm run diag:deterministic-turns -- --session 'project:wellness#smoke-malibu-deterministic' --agent malibu --limit 3 || true
npm run diag:deterministic-turns -- --session watson-live-deterministic --agent watson --limit 3 || true
npm run diag:deterministic-turns -- --session sierra-live-deterministic --agent sierra --limit 3 || true
npm run diag:deterministic-turns -- --session victor-live-deterministic --agent victor --limit 3 || true
npm run diag:deterministic-incidents -- --limit 20 || true

exit "$status"
