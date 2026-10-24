#!/bin/bash
# claude-session-watchdog.sh — Universal watchdog for all Claude Code tmux sessions
#
# Scans every tmux pane for running `claude` processes. When a previously-active
# Claude Code session dies (process exits, crash, disconnect), the watchdog
# automatically restarts it with `claude --resume`.
#
# Usage:
#   scripts/claude-session-watchdog.sh              # run in foreground
#   scripts/claude-session-watchdog.sh --daemon      # run in background (logs only)
#
# State:
#   ~/.tango/watchdog/state.json   — tracked sessions (JSON, one per line)
#   ~/.tango/watchdog/watchdog.log — action log
#
# The watchdog does NOT monitor the `tango:*` service windows (discord, home, etc.)
# or panes running plain shells with no Claude history.

set -euo pipefail

CHECK_INTERVAL="${WATCHDOG_INTERVAL:-30}"
GRACE_SECONDS="${WATCHDOG_GRACE:-60}"
STATE_DIR="$HOME/.tango/watchdog"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/watchdog.log"
RESTART_COOLDOWN=300  # seconds between restart attempts for the same session

mkdir -p "$STATE_DIR"
touch "$STATE_FILE" "$LOG_FILE"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" >> "$LOG_FILE"
  if [[ "${DAEMON:-}" != "1" ]]; then echo "$msg"; fi
}

# Find the claude CLI PID that is a descendant of a given pane PID.
# Uses `ps` instead of `pgrep` — macOS pgrep has edge cases where it
# misses children (sandbox, session boundaries).
find_claude_pid() {
  local pane_pid="$1"
  # Direct child: shell → claude
  local pid
  pid=$(ps -ax -o pid=,ppid=,comm= | awk -v pp="$pane_pid" '$2 == pp && $3 == "claude" {print $1; exit}')
  if [[ -n "$pid" ]]; then
    echo "$pid"
    return
  fi
  # Grandchild: shell → node → claude
  local child
  for child in $(ps -ax -o pid=,ppid= | awk -v pp="$pane_pid" '$2 == pp {print $1}'); do
    pid=$(ps -ax -o pid=,ppid=,comm= | awk -v pp="$child" '$2 == pp && $3 == "claude" {print $1; exit}')
    if [[ -n "$pid" ]]; then
      echo "$pid"
      return
    fi
  done
}

# Read a value from the state file. Format: key=value, one per line.
# Uses grep -F (fixed string) to avoid regex issues with [] in session names.
state_get() {
  local key="$1"
  local line
  line=$(grep -Fn "${key}=" "$STATE_FILE" 2>/dev/null | tail -1) || true
  # grep -F might match partial keys; verify exact prefix
  if [[ -n "$line" ]]; then
    # Strip line number prefix from grep -n output
    line="${line#*:}"
    if [[ "$line" == "${key}="* ]]; then
      echo "${line#${key}=}"
    fi
  fi
}

# Write/update a value in the state file.
state_set() {
  local key="$1" value="$2"
  local tmp="$STATE_FILE.tmp"
  grep -vF "${key}=" "$STATE_FILE" > "$tmp" 2>/dev/null || true
  echo "${key}=${value}" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# Remove a key from the state file.
state_rm() {
  local key="$1"
  local tmp="$STATE_FILE.tmp"
  grep -vF "${key}=" "$STATE_FILE" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$STATE_FILE"
}

# Get all tracked session keys from state.
state_tracked_sessions() {
  grep '^tracked\.' "$STATE_FILE" 2>/dev/null | sed 's/^tracked\.\([^=]*\)=.*/\1/' | sort -u || true
}

# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

scan_and_reconcile() {
  local now
  now=$(date +%s)

  # --- Phase 1: Discover all panes currently running Claude Code ---
  local found_sessions=()

  while IFS= read -r line; do
    local session_name window_name pane_pid pane_path
    session_name=$(echo "$line" | cut -d'|' -f1)
    window_name=$(echo "$line" | cut -d'|' -f2)
    pane_pid=$(echo "$line" | cut -d'|' -f3)
    pane_path=$(echo "$line" | cut -d'|' -f4)

    # Skip tango service windows (discord, home, etc.) unless they have claude
    local claude_pid
    claude_pid=$(find_claude_pid "$pane_pid")

    if [[ -n "$claude_pid" ]]; then
      local session_key="${session_name}__${window_name}"
      found_sessions+=("$session_key")

      # Register or update tracking
      local prev
      prev=$(state_get "tracked.${session_key}")
      if [[ -z "$prev" ]]; then
        log "TRACK  ${session_name}:${window_name} (claude pid $claude_pid, cwd $pane_path)"
      fi
      state_set "tracked.${session_key}" "alive|${claude_pid}|${pane_path}|${now}"
      # Clear any dead/restart timestamps
      state_rm "dead_since.${session_key}"
      state_rm "last_restart.${session_key}"
    fi
  done < <(tmux list-panes -a -F '#{session_name}|#{window_name}|#{pane_pid}|#{pane_current_path}' 2>/dev/null)

  # --- Phase 2: Check tracked sessions that are no longer alive ---
  local tracked
  tracked=$(state_tracked_sessions)

  for session_key in $tracked; do
    local session_name window_name
    session_name="${session_key%%__*}"
    window_name="${session_key#*__}"

    # Is this session still in the found list?
    local still_alive=0
    for found in "${found_sessions[@]+"${found_sessions[@]}"}"; do
      if [[ "$found" == "$session_key" ]]; then
        still_alive=1
        break
      fi
    done

    if [[ "$still_alive" == "1" ]]; then
      continue
    fi

    # Session was tracked but claude is no longer running.
    # Check if the tmux session still exists.
    if ! tmux has-session -t "$session_name" 2>/dev/null; then
      log "REMOVE ${session_name}:${window_name} — tmux session gone, untracking"
      state_rm "tracked.${session_key}"
      state_rm "dead_since.${session_key}"
      state_rm "last_restart.${session_key}"
      continue
    fi

    # Get stored info
    local info
    info=$(state_get "tracked.${session_key}")
    local stored_path
    stored_path=$(echo "$info" | cut -d'|' -f3)

    # Mark dead timestamp if not already set
    local dead_since
    dead_since=$(state_get "dead_since.${session_key}")
    if [[ -z "$dead_since" ]]; then
      dead_since="$now"
      state_set "dead_since.${session_key}" "$dead_since"
      log "DEAD   ${session_name}:${window_name} — claude process gone, grace period started"
      continue
    fi

    # Check grace period
    local elapsed=$(( now - dead_since ))
    if [[ "$elapsed" -lt "$GRACE_SECONDS" ]]; then
      continue  # Still in grace period
    fi

    # Check restart cooldown
    local last_restart
    last_restart=$(state_get "last_restart.${session_key}")
    if [[ -n "$last_restart" ]]; then
      local cooldown_elapsed=$(( now - last_restart ))
      if [[ "$cooldown_elapsed" -lt "$RESTART_COOLDOWN" ]]; then
        continue  # Too soon since last restart attempt
      fi
    fi

    # --- Attempt restart ---
    log "RESTART ${session_name}:${window_name} — dead for ${elapsed}s, attempting restart"
    state_set "last_restart.${session_key}" "$now"

    # Check what's in the pane now
    local current_cmd
    current_cmd=$(tmux display-message -t "${session_name}:${window_name}" -p '#{pane_current_command}' 2>/dev/null || echo "unknown")

    if [[ "$current_cmd" == "zsh" || "$current_cmd" == "bash" ]]; then
      # Pane is at a shell prompt — we can restart claude
      # Use --resume to pick up where it left off, with --dangerously-skip-permissions
      # since these are automated sessions
      local restart_cmd="cd ${stored_path} && claude --resume --dangerously-skip-permissions"
      tmux send-keys -t "${session_name}:${window_name}" "$restart_cmd" C-m
      log "RESTART ${session_name}:${window_name} — sent: $restart_cmd"

      # Wait briefly and verify
      sleep 5
      local pane_pid
      pane_pid=$(tmux list-panes -t "${session_name}:${window_name}" -F '#{pane_pid}' 2>/dev/null | head -1)
      if [[ -n "$pane_pid" ]]; then
        local new_claude
        new_claude=$(find_claude_pid "$pane_pid")
        if [[ -n "$new_claude" ]]; then
          log "RESTART ${session_name}:${window_name} — SUCCESS (new claude pid $new_claude)"
          state_set "tracked.${session_key}" "alive|${new_claude}|${stored_path}|${now}"
          state_rm "dead_since.${session_key}"
        else
          log "RESTART ${session_name}:${window_name} — claude not detected yet (may still be starting)"
        fi
      fi
    else
      log "RESTART ${session_name}:${window_name} — pane running '$current_cmd', not a shell prompt — skipping"
    fi
  done
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--daemon" ]]; then
  DAEMON=1
fi

log "=========================================="
log "Claude Session Watchdog started"
log "  interval=${CHECK_INTERVAL}s  grace=${GRACE_SECONDS}s  cooldown=${RESTART_COOLDOWN}s"
log "=========================================="

# Prevent idle sleep while watchdog runs (caffeinate wraps the whole process)
if [[ "${CAFFEINATED:-}" != "1" ]] && command -v caffeinate &>/dev/null; then
  export CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi

while true; do
  scan_and_reconcile
  sleep "$CHECK_INTERVAL"
done
