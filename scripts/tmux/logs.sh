#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"

WINDOW_NAME="${TANGO_DISCORD_WINDOW:-discord}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
LINES="${1:-80}"

if ! tmux_service_target_is_running "$TARGET"; then
  echo "No Tango Discord tmux target running (expected '$TARGET')"
  exit 1
fi

tango_service_tmux capture-pane -t "$TARGET" -p | tail -n "$LINES"
