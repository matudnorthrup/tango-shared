#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed food-ui; then
  ts_stop food-ui
  exit $?
fi
source "$SCRIPT_DIR/session.sh"

WINDOW_NAME="${TANGO_FOOD_UI_WINDOW:-food-ui}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"

if tmux_service_target_is_running "$TARGET"; then
  tmux_service_target_kill "$TARGET"
  echo "Stopped Food UI at tmux target '$TARGET'"
else
  echo "No Food UI tmux target running (expected '$TARGET')"
fi
