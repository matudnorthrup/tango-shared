#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed workout-ui; then
  ts_status workout-ui
  exit $?
fi
source "$SCRIPT_DIR/session.sh"

WINDOW_NAME="${TANGO_WORKOUT_UI_WINDOW:-workout-ui}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
LINES="${1:-40}"

if ! tmux_service_target_is_running "$TARGET"; then
  echo "status=stopped"
  echo "target=$TARGET"
  exit 1
fi

echo "status=running"
echo "target=$TARGET"
tango_service_tmux list-panes -t "$TARGET" -F "pane=#{pane_index} dead=#{pane_dead} command=#{pane_current_command}"
echo "--- recent logs ---"
tango_service_tmux capture-pane -t "$TARGET" -p | tail -n "$LINES"
