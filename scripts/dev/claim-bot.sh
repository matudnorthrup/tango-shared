#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"
AUTO_RELEASE_SCRIPT="$SCRIPT_DIR/bot-auto-release.sh"
WT_START_SCRIPT="$REPO_DIR/scripts/tmux/wt/start.sh"
DEFAULT_WAIT_TIMEOUT_SEC=600
source "$REPO_DIR/scripts/tmux/session.sh"

usage() {
  echo "Usage: $0 <slot: 1|2|3> [--live] [--no-timer] [--no-wait]" >&2
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

validate_nonnegative_integer() {
  case "$1" in
    ''|*[!0-9]*)
      fail "expected non-negative integer, got '$1'"
      ;;
  esac
}

require_slot_worktree_env() {
  local slot_env_file="$PWD/.env.slot"
  if [ ! -f "$slot_env_file" ]; then
    fail "Missing required $slot_env_file. Run scripts/dev/slot-env.sh $slot > .env.slot from the slot worktree root."
  fi
}

main_discord_window_exists() {
  tango_service_tmux has-session -t tango 2>/dev/null \
    && tango_service_tmux list-windows -t tango -F '#{window_name}' 2>/dev/null | grep -qx 'discord'
}

main_discord_session_exists() {
  tango_service_tmux has-session -t tango-discord 2>/dev/null
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

stop_main_discord() {
  if main_discord_window_exists; then
    tango_service_tmux kill-window -t tango:discord
    return 0
  fi

  if main_discord_session_exists; then
    tango_service_tmux kill-session -t tango-discord
    return 0
  fi

  fail "Main Discord bot is not running in tango:discord or tango-discord."
}

wait_for_main_discord_exit() {
  local waited=0
  while [ "$waited" -lt 10 ]; do
    if ! main_discord_window_exists && ! main_discord_session_exists; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
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
    if ! main_discord_window_exists; then
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

wait_for_slot_mode_threads() {
  local target="$1"
  local timeout_seconds="$2"
  local waited=0

  while [ "$waited" -lt "$timeout_seconds" ]; do
    if tango_service_tmux capture-pane -J -p -S -2000 -t "$target" 2>/dev/null | grep -q '\[slot-mode\] initialization complete '; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

read_lock_field() {
  local status_output="$1"
  local field_name="$2"

  printf '%s\n' "$status_output" | sed -n "s/^${field_name}=//p" | sed -n '1p'
}

acquire_bot_lock() {
  if [ "$use_wait" -eq 1 ]; then
    "$BOT_LOCK_SCRIPT" acquire "$slot" --wait --timeout "$DEFAULT_WAIT_TIMEOUT_SEC"
    return $?
  fi

  "$BOT_LOCK_SCRIPT" acquire "$slot"
}

spawn_auto_release_watcher() {
  local watcher_log="/tmp/tango-slot-$slot-autorelease.log"

  nohup "$AUTO_RELEASE_SCRIPT" "$slot" "$max_hold_sec" >"$watcher_log" 2>&1 &
  auto_release_pid="$!"

  if ! "$BOT_LOCK_SCRIPT" set-watcher "$slot" "$auto_release_pid" >/dev/null; then
    kill "$auto_release_pid" >/dev/null 2>&1 || true
    auto_release_pid=""
    fail "Unable to record auto-release watcher pid for slot $slot."
  fi
}

if [ "$#" -lt 1 ]; then
  usage
fi

slot="$1"
validate_slot "$slot"
shift

live_mode=0
use_timer=1
use_wait=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --live)
      live_mode=1
      ;;
    --no-timer)
      use_timer=0
      ;;
    --no-wait)
      use_wait=0
      ;;
    *)
      usage
      ;;
  esac
  shift
done

max_hold_sec="${TANGO_SLOT_MAX_HOLD_SEC:-300}"
validate_nonnegative_integer "$max_hold_sec"
require_slot_worktree_env

if [ "$live_mode" -eq 0 ]; then
  if [ "$use_wait" -eq 1 ]; then
    echo "[DRY-RUN] would acquire lock with --wait --timeout 600"
  else
    echo "[DRY-RUN] would acquire lock (no-wait, fail on contention)"
  fi
  echo "[DRY-RUN] would stop tango:discord"
  echo "[DRY-RUN] would wait for tango:discord to exit"
  if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
    echo "[DRY-RUN] would start tango-wt-$slot:discord with DISCORD_ALLOWED_CHANNELS=$DISCORD_ALLOWED_CHANNELS_OVERRIDE"
    echo "[DRY-RUN] would wait for tango-wt-$slot:discord to report ready"
  else
    echo "[DRY-RUN] would start tango-wt-$slot:discord with TANGO_SLOT=$slot (bot will self-provision test threads)"
    echo "[DRY-RUN] would wait for [slot-mode] thread ready lines in slot bot logs"
    echo "[DRY-RUN] would print thread URLs to operator"
  fi
  if [ "$use_timer" -eq 1 ]; then
    echo "[DRY-RUN] would spawn auto-release watcher with ${max_hold_sec}s timeout"
  fi
  echo "[DRY-RUN] would leave release command: scripts/dev/release-bot.sh $slot --live"
  exit 0
fi

lock_acquired=0
slot_bot_started=0
main_bot_stopped=0
auto_release_pid=""

cleanup_on_error() {
  local status="$1"

  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if [ -n "$auto_release_pid" ]; then
    kill "$auto_release_pid" >/dev/null 2>&1 || true
  fi

  if [ "$slot_bot_started" -eq 1 ]; then
    "$REPO_DIR/scripts/tmux/wt/stop.sh" "$slot" --window discord >/dev/null 2>&1 || true
  fi

  if [ "$main_bot_stopped" -eq 1 ]; then
    start_main_discord >/dev/null 2>&1 || true
  fi

  if [ "$lock_acquired" -eq 1 ]; then
    "$BOT_LOCK_SCRIPT" release "$slot" >/dev/null 2>&1 || true
  fi
}

trap 'cleanup_on_error "$?"' EXIT INT TERM

if ! acquire_bot_lock >/dev/null; then
  fail "Unable to acquire bot lock for slot $slot. See: scripts/dev/bot-lock.sh status"
fi
lock_acquired=1

stop_main_discord
main_bot_stopped=1

if ! wait_for_main_discord_exit; then
  fail "Main Discord bot did not exit cleanly."
fi

if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
  TANGO_SLOT_MODE=discord DISCORD_ALLOWED_CHANNELS="$DISCORD_ALLOWED_CHANNELS_OVERRIDE" "$WT_START_SCRIPT" "$slot"
else
  TANGO_SLOT_MODE=discord "$WT_START_SCRIPT" "$slot"
fi
slot_bot_started=1

if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
  if ! wait_for_discord_ready "tango-wt-$slot:discord" 60; then
    fail "Slot Discord bot did not report ready within 60 seconds."
  fi
else
  if ! wait_for_slot_mode_threads "tango-wt-$slot:discord" 60; then
    fail "Slot Discord bot did not finish slot-mode thread provisioning within 60 seconds."
  fi

  thread_urls="$(
    tango_service_tmux capture-pane -J -p -S -2000 -t "tango-wt-$slot:discord" 2>/dev/null \
      | sed -n 's/^.*\[slot-mode\] thread ready: .* url=\(.*\)$/\1/p'
  )"

  if [ -z "$thread_urls" ]; then
    fail "Slot Discord bot reported slot-mode completion without any thread URLs."
  fi

  printf '%s\n' "$thread_urls"
fi

if [ "$use_timer" -eq 1 ]; then
  spawn_auto_release_watcher
fi

trap - EXIT INT TERM
if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
  echo "Claimed Discord bot for slot wt-$slot with DISCORD_ALLOWED_CHANNELS=$DISCORD_ALLOWED_CHANNELS_OVERRIDE"
else
  echo "Claimed Discord bot for slot wt-$slot with self-provisioned slot-mode threads"
fi
echo "Release with: scripts/dev/release-bot.sh $slot --live"
