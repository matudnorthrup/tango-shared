#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <slot: 1|2|3> [--window slot-probe|discord]" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  usage
fi

slot="$1"
shift

case "$slot" in
  1|2|3) ;;
  *)
    echo "Invalid slot '$slot'. Expected 1, 2, or 3." >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../session.sh"

REQUESTED_WINDOW=""
if [ "$#" -gt 0 ]; then
  [ "$1" = "--window" ] || usage
  [ "$#" -eq 2 ] || usage
  REQUESTED_WINDOW="$2"
fi

case "$REQUESTED_WINDOW" in
  ""|slot-probe|discord) ;;
  *)
    echo "Invalid window '$REQUESTED_WINDOW'. Expected slot-probe or discord." >&2
    exit 1
    ;;
esac

SESSION_NAME="tango-wt-$slot"
WINDOW_NAME=""

if [ -n "$REQUESTED_WINDOW" ]; then
  WINDOW_NAME="$REQUESTED_WINDOW"
else
  WINDOW_NAME="$(resolve_active_slot_window_name "$SESSION_NAME" || true)"
fi

if [ -n "$WINDOW_NAME" ]; then
  "$SCRIPT_DIR/stop.sh" "$slot" --window "$WINDOW_NAME" >/dev/null 2>&1 || true
fi

if [ "$WINDOW_NAME" = "discord" ] || [ "$REQUESTED_WINDOW" = "discord" ]; then
  TANGO_SLOT_MODE=discord "$SCRIPT_DIR/start.sh" "$slot"
  echo "Restarted slot discord in tmux session 'tango-wt-$slot'"
  exit 0
fi

"$SCRIPT_DIR/start.sh" "$slot"
echo "Restarted slot probe in tmux session 'tango-wt-$slot'"
