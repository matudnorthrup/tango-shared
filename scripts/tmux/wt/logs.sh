#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <slot: 1|2|3> [lines] [--window slot-probe|discord]" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  usage
fi

slot="$1"
shift
lines="80"
REQUESTED_WINDOW=""

if [ "$#" -gt 0 ] && [ "$1" != "--window" ]; then
  lines="$1"
  shift
fi

if [ "$#" -gt 0 ]; then
  [ "$1" = "--window" ] || usage
  [ "$#" -eq 2 ] || usage
  REQUESTED_WINDOW="$2"
fi

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

if [ -z "$WINDOW_NAME" ] || ! slot_tmux_window_exists "$SESSION_NAME" "$WINDOW_NAME"; then
  if [ -n "$REQUESTED_WINDOW" ]; then
    echo "No slot tmux target running (expected '${SESSION_NAME}:${REQUESTED_WINDOW}')"
  else
    echo "No slot tmux target running for session '$SESSION_NAME'"
  fi
  exit 1
fi

TARGET="${SESSION_NAME}:${WINDOW_NAME}"
tango_service_tmux capture-pane -t "$TARGET" -p | tail -n "$lines"
