#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed workout-ui; then
  ts_stop workout-ui
  exit $?
fi
source "$SCRIPT_DIR/session.sh"

WINDOW_NAME="${TANGO_WORKOUT_UI_WINDOW:-workout-ui}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"

if tmux_service_target_is_running "$TARGET"; then
  tmux_service_target_kill "$TARGET"
  echo "Stopped Workout UI at tmux target '$TARGET'"
else
  echo "No Workout UI tmux target running (expected '$TARGET')"
fi
