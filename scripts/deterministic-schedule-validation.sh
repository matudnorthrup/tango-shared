#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_PATH="$(
  node --import tsx -e '
    const dotenv = await import("dotenv");
    dotenv.default.config();
    const runtimePaths = await import("./packages/core/src/runtime-paths.ts");
    console.log(runtimePaths.resolveDatabasePath(process.env.TANGO_DB_PATH));
  '
)"

run_schedule() {
  local schedule_id="$1"
  local timeout_seconds="$2"
  local baseline_id

  baseline_id="$(sqlite3 "$DB_PATH" "select coalesce(max(id), 0) from schedule_runs where schedule_id = '$schedule_id';")"

  echo "[schedules] trigger=$schedule_id timeout=${timeout_seconds}s baseline_id=${baseline_id}"

  local trigger_response
  trigger_response="$(curl -fsS "http://127.0.0.1:9200/trigger/${schedule_id}")"
  echo "$trigger_response"

  if [[ "$trigger_response" == *'"status":"skipped"'* ]]; then
    return 0
  fi

  SCHEDULE_ID="$schedule_id" TIMEOUT_SECONDS="$timeout_seconds" DB_PATH="$DB_PATH" BASELINE_ID="$baseline_id" python3 - <<'PY'
import json
import os
import sqlite3
import sys
import time

db_path = os.environ["DB_PATH"]
schedule_id = os.environ["SCHEDULE_ID"]
timeout_seconds = int(os.environ["TIMEOUT_SECONDS"])
baseline_id = int(os.environ["BASELINE_ID"])

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

start = time.time()
latest = None
created = None
while time.time() - start < timeout_seconds:
    created = conn.execute(
        """
        select id, status, started_at, finished_at, duration_ms, delivery_status, summary, error
        from schedule_runs
        where schedule_id = ?
          and id > ?
        order by id desc
        limit 1
        """,
        (schedule_id, baseline_id),
    ).fetchone()
    if created and created["status"] != "running":
        print(json.dumps({key: created[key] for key in created.keys()}, ensure_ascii=True))
        if created["status"] != "ok":
            sys.exit(2)
        sys.exit(0)
    time.sleep(5)

if created is None:
    created = conn.execute(
        """
        select id, status, started_at, finished_at, duration_ms, delivery_status, summary, error
        from schedule_runs
        where schedule_id = ?
          and id > ?
        order by id desc
        limit 1
        """,
        (schedule_id, baseline_id),
    ).fetchone()

payload = {key: created[key] for key in created.keys()} if created else {"schedule_id": schedule_id, "status": "missing"}
print(json.dumps(payload, ensure_ascii=True))
sys.exit(124)
PY
}

echo "[schedules] Watson deterministic schedule validation"
echo "[schedules] repo=$ROOT"
echo "[schedules] started=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

echo "[schedules] bot status"
npm run bot:status

echo "[schedules] bridge health"
curl -fsS http://127.0.0.1:8787/health
echo

status=0
run_schedule "manual-test-weekly-finance-review" 480 || status=$?
if [ "$status" -eq 0 ]; then
  run_schedule "manual-test-nightly-transaction-categorizer" 480 || status=$?
fi
if [ "$status" -eq 0 ]; then
  run_schedule "manual-test-receipt-cataloger" 1200 || status=$?
fi
if [ "$status" -eq 0 ]; then
  run_schedule "manual-test-daily-email-review" 600 || status=$?
fi

if [ "$status" -eq 0 ]; then
  echo "[schedules] validation passed"
  exit 0
fi

echo "[schedules] validation failed with status=$status"
echo "[schedules] collecting diagnostics"

npm run bot:status || true
npm run diag:deterministic-incidents -- --agent watson --limit 20 || true
npm run diag:deterministic-regressions -- --agent watson --limit 12 || true
sqlite3 -header -column "$DB_PATH" \
  "select id, schedule_id, status, started_at, finished_at, duration_ms, delivery_status, substr(summary,1,120) as summary, substr(error,1,120) as error from schedule_runs where schedule_id like 'manual-test-%' order by id desc limit 12;" \
  || true

exit "$status"
