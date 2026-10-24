#!/bin/bash
# claude-rc-watchdog.sh — Keeps /remote-control connected for ALL Claude Code sessions
#
# Scans all tmux panes for running `claude` processes. For each one, checks if
# remote-control is connected. If disconnected, sends `/remote-control` to
# reconnect it when the session is idle.
#
# Usage:
#   scripts/claude-rc-watchdog.sh          # foreground
#   scripts/claude-rc-watchdog.sh --daemon # background (log only)
#
# Prerequisites:
#   - `claude remote-control` server must be running (tango:remote-control window)
#   - Claude Code sessions must be in tmux
#
# Log: ~/.tango/watchdog/rc-watchdog.log

set -uo pipefail
# No set -e — a watchdog must never crash on transient errors

CHECK_INTERVAL="${RC_WATCHDOG_INTERVAL:-60}"
RC_COOLDOWN="${RC_WATCHDOG_COOLDOWN:-300}"  # Don't retry same session for 5 min after a reconnect attempt
STATE_DIR="$HOME/.tango/watchdog"
LOG_FILE="$STATE_DIR/rc-watchdog.log"
RC_STATE_FILE="$STATE_DIR/rc-attempts.txt"

mkdir -p "$STATE_DIR"
touch "$RC_STATE_FILE"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" >> "$LOG_FILE"
  if [[ "${DAEMON:-}" != "1" ]]; then echo "$msg"; fi
}

# Find claude CLI PID that is a descendant of a given pane PID.
find_claude_pid() {
  local pane_pid="$1"
  local pid
  # Direct child
  pid=$(ps -ax -o pid=,ppid=,comm= | awk -v pp="$pane_pid" '$2 == pp && $3 == "claude" {print $1; exit}')
  if [[ -n "$pid" ]]; then echo "$pid"; return; fi
  # Grandchild (shell → node → claude)
  local child
  for child in $(ps -ax -o pid=,ppid= | awk -v pp="$pane_pid" '$2 == pp {print $1}'); do
    pid=$(ps -ax -o pid=,ppid=,comm= | awk -v pp="$child" '$2 == pp && $3 == "claude" {print $1; exit}')
    if [[ -n "$pid" ]]; then echo "$pid"; return; fi
  done
}

# Check if a pane's Claude Code session has remote-control active.
# Returns 0 if connected, 1 if not.
rc_looks_connected() {
  local target="$1"
  local pane_text
  pane_text=$(tmux capture-pane -t "$target" -p -S -30 2>/dev/null || true)

  # "Remote Control active" appears in the status bar when connected
  if echo "$pane_text" | grep -q "Remote Control active"; then
    return 0
  fi

  # "/remote-control is active" appears right after connecting
  if echo "$pane_text" | grep -q "/remote-control is active"; then
    return 0
  fi

  # Bridge URL means it just connected
  if echo "$pane_text" | grep -q "claude.ai/code"; then
    return 0
  fi

  # "Remote Control failed" means it tried and can't connect — don't retry
  if echo "$pane_text" | grep -q "Remote Control failed"; then
    return 0  # Treat as "handled" so we don't spam
  fi

  # "Remote Control connecting" means it's mid-attempt — leave it alone
  if echo "$pane_text" | grep -q "Remote Control connecting"; then
    return 0
  fi

  # "Remote Control reconnecting" means it's auto-retrying
  if echo "$pane_text" | grep -qi "Remote Control reconnecting"; then
    return 0
  fi

  # No indicators at all — assume disconnected
  return 1
}

# Check if pane looks idle (at the Claude Code prompt, not mid-response)
pane_is_idle() {
  local target="$1"
  local pane_text

  # Use a wide capture width to avoid truncation issues on narrow panes
  pane_text=$(tmux capture-pane -t "$target" -p -S -5 -J 2>/dev/null || true)

  # Claude Code status bar indicators (present when idle at prompt)
  if echo "$pane_text" | grep -qE "bypass permissions|shift\+tab to cycle|esc to interrupt"; then
    return 0
  fi

  # The ⏵⏵ prefix is unique to Claude Code's mode indicator
  if echo "$pane_text" | grep -q "⏵⏵"; then
    return 0
  fi

  # Shell prompt (Claude exited normally)
  if echo "$pane_text" | tail -2 | grep -qE '^\$|^%|user@'; then
    return 0
  fi

  return 1
}

# Send /remote-control to a Claude Code session
send_rc_reconnect() {
  local target="$1"
  tmux send-keys -t "$target" "/remote-control" C-m
  log "RECONNECT $target — sent /remote-control"
}

scan_and_reconnect() {
  while IFS= read -r line; do
    local session_name window_index pane_pid pane_index
    session_name=$(echo "$line" | cut -d'|' -f1)
    window_index=$(echo "$line" | cut -d'|' -f2)
    pane_pid=$(echo "$line" | cut -d'|' -f3)
    pane_index=$(echo "$line" | cut -d'|' -f4)

    # Skip tango service windows (discord, home, etc.)
    if [[ "$session_name" == "tango" ]]; then continue; fi

    # Skip PM and dev agent sessions — they're automated and don't need remote control
    if [[ "$session_name" == TANGO-PM-* || "$session_name" == dev-wt-* ]]; then continue; fi

    local claude_pid
    claude_pid=$(find_claude_pid "$pane_pid")
    if [[ -z "$claude_pid" ]]; then continue; fi

    # Use window index (not name) to avoid tmux parsing issues with names like "2.1.75"
    local target="${session_name}:${window_index}.${pane_index}"

    # Check if remote-control is connected
    if rc_looks_connected "$target"; then
      continue
    fi

    # Only reconnect if the session is idle
    if ! pane_is_idle "$target"; then
      log "SKIP   $target — disconnected but busy, will retry next cycle"
      continue
    fi

    # Extra safety: check if user has pending input (pasted text waiting for submit)
    local pane_check
    pane_check=$(tmux capture-pane -t "$target" -p -S -3 2>/dev/null || true)
    if echo "$pane_check" | grep -qE '\[Pasted text \+[0-9]+ lines\]'; then
      log "SKIP   $target — has pending pasted text, will retry next cycle"
      continue
    fi

    # Check cooldown — don't retry if we recently attempted this session
    local last_attempt
    last_attempt=$(grep "^${target}=" "$RC_STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2)
    if [[ -n "$last_attempt" ]]; then
      local now_ts cooldown_elapsed
      now_ts=$(date +%s)
      cooldown_elapsed=$(( now_ts - last_attempt ))
      if [[ "$cooldown_elapsed" -lt "$RC_COOLDOWN" ]]; then
        continue  # Still in cooldown
      fi
    fi

    send_rc_reconnect "$target"
    # Record attempt timestamp
    grep -v "^${target}=" "$RC_STATE_FILE" > "$RC_STATE_FILE.tmp" 2>/dev/null || true
    echo "${target}=$(date +%s)" >> "$RC_STATE_FILE.tmp"
    mv "$RC_STATE_FILE.tmp" "$RC_STATE_FILE"
    sleep 5  # Give it time to connect before checking the next session

  done < <(tmux list-panes -a -F '#{session_name}|#{window_index}|#{pane_pid}|#{pane_index}' 2>/dev/null)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--daemon" ]]; then
  DAEMON=1
fi

log "=========================================="
log "Claude RC Watchdog started (interval=${CHECK_INTERVAL}s)"
log "=========================================="

# Prevent idle sleep
if [[ "${CAFFEINATED:-}" != "1" ]] && command -v caffeinate &>/dev/null; then
  export CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi

while true; do
  scan_and_reconnect
  sleep "$CHECK_INTERVAL"
done
