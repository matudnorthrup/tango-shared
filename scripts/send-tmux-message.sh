#!/bin/bash
# send-tmux-message.sh — reliably send a multi-line message to a tmux session running Claude Code or Codex
#
# Usage:
#   scripts/send-tmux-message.sh <target-session> <message-file>
#   scripts/send-tmux-message.sh TANGO-PM-myproject /tmp/message.md
#
# Why this exists:
# Claude Code's paste detection buffers multi-line tmux pastes as "[Pasted text +N lines]"
# and the trailing newline gets absorbed. Agents have consistently forgotten to send the
# extra Enter afterwards, causing reports to sit unsent in the receiving session's buffer.
# This script guarantees submission with verification.

set -euo pipefail

TARGET="${1:-}"
MSG_FILE="${2:-}"

if [[ -z "$TARGET" || -z "$MSG_FILE" ]]; then
  echo "Usage: $0 <target-session> <message-file>" >&2
  echo "Example: $0 TANGO-PM-myproject /tmp/message.md" >&2
  exit 1
fi

if [[ ! -f "$MSG_FILE" ]]; then
  echo "Error: message file '$MSG_FILE' not found" >&2
  exit 1
fi

if ! tmux has-session -t "$TARGET" 2>/dev/null; then
  echo "Error: tmux session '$TARGET' not found" >&2
  exit 1
fi

# Step 1: Paste the content
tmux send-keys -t "$TARGET" "$(cat "$MSG_FILE")" C-m

# Step 2: Wait for paste buffer to settle (Claude Code needs time to register the paste)
sleep 3

# Step 3: Explicit Enter to submit
tmux send-keys -t "$TARGET" Enter

# Step 4: Wait and verify
sleep 3
CAPTURE=$(tmux capture-pane -t "$TARGET" -p -S -30)

# If we still see [Pasted text ... lines] hanging in the input, send another Enter
if echo "$CAPTURE" | grep -qE '\[Pasted text \+[0-9]+ lines\]' ; then
  echo "WARN: pasted text still in input buffer, sending recovery Enter" >&2
  tmux send-keys -t "$TARGET" Enter
  sleep 2
  CAPTURE=$(tmux capture-pane -t "$TARGET" -p -S -30)
  if echo "$CAPTURE" | grep -qE '\[Pasted text \+[0-9]+ lines\]' ; then
    echo "ERROR: message still not submitted after recovery. Manual intervention needed." >&2
    echo "Session: $TARGET" >&2
    exit 2
  fi
fi

echo "Message delivered to $TARGET"
