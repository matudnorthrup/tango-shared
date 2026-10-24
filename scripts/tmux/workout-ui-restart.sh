#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed workout-ui; then
  ts_restart workout-ui
  exit $?
fi

"$SCRIPT_DIR/workout-ui-stop.sh" || true
"$SCRIPT_DIR/workout-ui-start.sh"
