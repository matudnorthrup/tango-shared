#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed usage-ui; then
  ts_restart usage-ui
  exit $?
fi

"$SCRIPT_DIR/usage-ui-stop.sh" || true
"$SCRIPT_DIR/usage-ui-start.sh"
