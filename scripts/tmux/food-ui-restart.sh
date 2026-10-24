#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed food-ui; then
  ts_restart food-ui
  exit $?
fi

"$SCRIPT_DIR/food-ui-stop.sh" || true
"$SCRIPT_DIR/food-ui-start.sh"
