#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARTIFACT_ROOT="${TMPDIR:-/tmp}/tango-deterministic-nightly/$(date -u +"%Y%m%dT%H%M%SZ")"
mkdir -p "$ARTIFACT_ROOT"

echo "[nightly] deterministic validation"
echo "[nightly] repo=$ROOT"
echo "[nightly] artifacts=$ARTIFACT_ROOT"
echo "[nightly] started=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

echo "[nightly] core live gate"
bash ./scripts/deterministic-live-core-gate.sh

echo "[nightly] watson schedule validation"
bash ./scripts/deterministic-schedule-validation.sh

echo "[nightly] incident report"
npm run diag:deterministic-incidents -- --limit 20

echo "[nightly] harvesting recent regressions"
npm run diag:deterministic-regressions -- --agent malibu --limit 20 --out "$ARTIFACT_ROOT/malibu.json"
npm run diag:deterministic-regressions -- --agent watson --limit 20 --out "$ARTIFACT_ROOT/watson.json"
npm run diag:deterministic-regressions -- --agent sierra --limit 20 --out "$ARTIFACT_ROOT/sierra.json"

echo "[nightly] complete"
