#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"
WT_STOP_SCRIPT="$REPO_DIR/scripts/tmux/wt/stop.sh"
source "$REPO_DIR/scripts/tmux/session.sh"

usage() {
  echo "Usage: $0 <slot: 1|2|3> [--live]" >&2
  exit 1
}

fail() {
  echo "$*" >&2
  exit 1
}

validate_slot() {
  case "$1" in
    1|2|3) ;;
    *)
      fail "Invalid slot '$1'. Expected 1, 2, or 3."
      ;;
  esac
}

read_lock_field() {
  local status_output="$1"
  local field_name="$2"

  printf '%s\n' "$status_output" | sed -n "s/^${field_name}=//p" | sed -n '1p'
}

main_discord_target() {
  if tango_service_tmux has-session -t tango 2>/dev/null \
    && tango_service_tmux list-windows -t tango -F '#{window_name}' 2>/dev/null | grep -qx 'discord'; then
    printf 'tango:discord\n'
    return 0
  fi

  if tango_service_tmux has-session -t tango-discord 2>/dev/null; then
    printf 'tango-discord\n'
    return 0
  fi

  printf 'tango:discord\n'
}

resolve_main_repo_dir() {
  if [ -n "${TANGO_MAIN_REPO_DIR:-}" ]; then
    printf '%s\n' "$TANGO_MAIN_REPO_DIR"
    return 0
  fi

  local main_repo_dir
  main_repo_dir="$(git -C "$REPO_DIR" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | sed -n '1p')"
  if [ -z "$main_repo_dir" ]; then
    fail "Unable to resolve main repo worktree. Set TANGO_MAIN_REPO_DIR."
  fi

  printf '%s\n' "$main_repo_dir"
}

start_main_discord() {
  local main_repo_dir=""
  local main_start_script=""
  local node_bin="${TANGO_NODE_BIN:-/Users/you/.nvm/versions/node/v24.14.0/bin/node}"
  local run_cmd=""

  main_repo_dir="$(resolve_main_repo_dir)"
  main_start_script="$main_repo_dir/scripts/tmux/start.sh"

  if [ ! -x "$node_bin" ]; then
    node_bin="$(command -v node || true)"
  fi

  if [ -z "${node_bin:-}" ]; then
    fail "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  fi

  if [ ! -f "$main_repo_dir/packages/discord/dist/main.js" ]; then
    fail "Build output not found at $main_repo_dir/packages/discord/dist/main.js"
  fi

  printf -v run_cmd '%s' "cd \"$main_repo_dir\" && env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$node_bin\" packages/discord/dist/main.js"
  sync_tmux_service_environment "$(resolve_tango_tmux_session_name)"

  if tango_service_tmux has-session -t tango 2>/dev/null; then
    if ! tango_service_tmux list-windows -t tango -F '#{window_name}' 2>/dev/null | grep -qx 'discord'; then
      tango_service_tmux new-window -t tango -n discord -c "$main_repo_dir" "$run_cmd"
    fi
    return 0
  fi

  "$main_start_script"
}

wait_for_discord_ready() {
  local target="$1"
  local timeout_seconds="$2"
  local waited=0

  while [ "$waited" -lt "$timeout_seconds" ]; do
    if tango_service_tmux capture-pane -J -p -S -2000 -t "$target" 2>/dev/null | grep -q '\[tango-discord\] connected as '; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi

slot="$1"
validate_slot "$slot"
shift

live_mode=0
if [ "$#" -eq 1 ]; then
  [ "$1" = "--live" ] || usage
  live_mode=1
fi

lock_status="$("$BOT_LOCK_SCRIPT" status)"
lock_slot="$(read_lock_field "$lock_status" slot)"
watcher_pid="$(read_lock_field "$lock_status" watcher_pid)"

if [ "$lock_status" = "not held" ]; then
  fail "Bot lock is not held."
fi

if [ "$lock_slot" != "$slot" ]; then
  fail "Bot lock is held by slot ${lock_slot:-unknown}, not slot $slot."
fi

if [ "$live_mode" -eq 0 ]; then
  echo "[DRY-RUN] would stop tango-wt-$slot:discord"
  echo "[DRY-RUN] would wait for tango-wt-$slot:discord to exit"
  echo "[DRY-RUN] would start tango:discord"
  echo "[DRY-RUN] would wait for main Discord bot to report ready"
  if [ -n "$watcher_pid" ]; then
    echo "[DRY-RUN] would kill auto-release watcher pid=$watcher_pid"
  fi
  echo "[DRY-RUN] would append release event to history log"
  echo "[DRY-RUN] would release lock for slot $slot"
  exit 0
fi

if [ -n "$watcher_pid" ]; then
  if [ "${TANGO_AUTO_RELEASE_ACTIVE:-0}" = "1" ] && [ "${TANGO_AUTO_RELEASE_PID:-}" = "$watcher_pid" ]; then
    :
  else
    kill "$watcher_pid" >/dev/null 2>&1 || true
  fi
fi

"$WT_STOP_SCRIPT" "$slot" --window discord
start_main_discord

main_target="$(main_discord_target)"
if ! wait_for_discord_ready "$main_target" 60; then
  fail "Main Discord bot did not report ready within 60 seconds."
fi

"$BOT_LOCK_SCRIPT" release "$slot" >/dev/null
echo "Released Discord bot for slot wt-$slot and restarted main at $main_target"
