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

SESSION_NAME="tango-wt-$slot"
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

if [ -n "$REQUESTED_WINDOW" ]; then
  WINDOW_NAME="$REQUESTED_WINDOW"
else
  WINDOW_NAME="$(resolve_active_slot_window_name "$SESSION_NAME" || true)"
fi

if [ -z "$WINDOW_NAME" ]; then
  if [ -n "$REQUESTED_WINDOW" ]; then
    echo "No slot tmux target running (expected '${SESSION_NAME}:${REQUESTED_WINDOW}')"
  else
    echo "No slot tmux target running for session '$SESSION_NAME'"
  fi
  exit 0
fi

TARGET="${SESSION_NAME}:${WINDOW_NAME}"

if slot_tmux_window_exists "$SESSION_NAME" "$WINDOW_NAME"; then
  tango_service_tmux kill-window -t "$TARGET"
  echo "Stopped slot tmux target '$TARGET'"
else
  echo "No slot tmux target running (expected '$TARGET')"
fi
