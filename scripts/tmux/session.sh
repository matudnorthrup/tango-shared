#!/usr/bin/env bash
set -euo pipefail

# All Tango services live as windows inside one tmux session. By default, that
# session runs on a dedicated tmux socket so service processes are not children
# of a long-lived interactive tmux server with stale macOS auth/session state.
# Override the session name with TANGO_TMUX_SESSION if needed.
resolve_tango_tmux_session_name() {
  printf '%s\n' "${TANGO_TMUX_SESSION:-tango}"
}

resolve_tango_service_tmux_socket_name() {
  printf '%s\n' "${TANGO_SERVICE_TMUX_SOCKET_NAME:-tango-service}"
}

tango_service_tmux() {
  if [ -n "${TANGO_SERVICE_TMUX_SOCKET:-}" ]; then
    command tmux -S "$TANGO_SERVICE_TMUX_SOCKET" "$@"
  else
    command tmux -L "$(resolve_tango_service_tmux_socket_name)" "$@"
  fi
}

tango_service_tmux_command_hint() {
  if [ -n "${TANGO_SERVICE_TMUX_SOCKET:-}" ]; then
    printf 'tmux -S %q' "$TANGO_SERVICE_TMUX_SOCKET"
  else
    printf 'tmux -L %q' "$(resolve_tango_service_tmux_socket_name)"
  fi
}

# Backward-compatible helper kept for any callers that still expect a session name.
# The default changed from `tango-discord` to `tango`.
resolve_tmux_session_name() {
  resolve_tango_tmux_session_name
}

resolve_tmux_target_session_name() {
  resolve_tango_tmux_session_name
}

# Returns a tmux target string for a given service window. Examples:
#   resolve_tmux_service_target discord   -> tango:discord
#
# If a pre-consolidation standalone session (`tango-discord` or `owntracks`) is
# still running, the resolver returns that legacy target instead so in-flight
# services keep working through the migration.
resolve_tmux_service_target() {
  local window="$1"
  local session
  session="$(resolve_tango_tmux_session_name)"

  if tango_service_tmux has-session -t "$session" 2>/dev/null; then
    if tango_service_tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "$window"; then
      printf '%s:%s\n' "$session" "$window"
      return 0
    fi
  fi

  local legacy
  case "$window" in
    discord) legacy="tango-discord" ;;
    owntracks) legacy="owntracks" ;;
    *) legacy="" ;;
  esac

  if [ -n "$legacy" ] && tango_service_tmux has-session -t "$legacy" 2>/dev/null; then
    printf '%s\n' "$legacy"
    return 0
  fi

  # Nothing running yet — return the intended consolidated target so callers
  # have a stable string to create or report against.
  printf '%s:%s\n' "$session" "$window"
}

# True (exit 0) if the given tmux target currently has a live window/session.
tmux_service_target_is_running() {
  local target="$1"
  case "$target" in
    *:*)
      local s="${target%%:*}" w="${target##*:}"
      tango_service_tmux has-session -t "$s" 2>/dev/null \
        && tango_service_tmux list-windows -t "$s" -F '#{window_name}' 2>/dev/null | grep -qx "$w"
      ;;
    *)
      tango_service_tmux has-session -t "$target" 2>/dev/null
      ;;
  esac
}

# Kill whatever the target refers to — a window inside the shared session or a
# legacy standalone session.
tmux_service_target_kill() {
  local target="$1"
  case "$target" in
    *:*)
      tango_service_tmux kill-window -t "$target" 2>/dev/null || true
      ;;
    *)
      tango_service_tmux kill-session -t "$target" 2>/dev/null || true
      ;;
  esac
}

# Command for the Discord bot's tmux window. The bot exits 1 on a fatal error;
# without a supervisor the window just closed and Tango stayed down until
# someone noticed (2026-09-27: 17 min). Restart on non-zero exit after 10s, but
# give up after 5 consecutive crashes that each came within 60s of starting, so
# a broken build does not spin forever. stop/restart kill the whole window, so
# the loop never outlives an intentional stop. A clean exit (0) ends the loop.
tango_discord_run_cmd() {
  local repo_dir="$1" node_bin="$2"
  printf '%s' "cd \"$repo_dir\" && fast=0; while :; do started=\$(date +%s); env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$node_bin\" packages/discord/dist/main.js; code=\$?; [ \$code -eq 0 ] && break; if [ \$(( \$(date +%s) - started )) -lt 60 ]; then fast=\$((fast + 1)); else fast=0; fi; if [ \$fast -ge 5 ]; then echo \"[supervisor] bot crashed 5 times within 60s of start; giving up\"; break; fi; echo \"[supervisor] bot exited with code \$code; restarting in 10s\"; sleep 10; done"
}

# Open the bot's window. A fresh session means the tmux server had died (10/19:
# a stray `pkill -f ... -U 501` matched the server's own argv, which carries the
# socket path tmux-501/...), and every other window died with it. The healthcheck
# only restarts the bot, so Home and the other startup windows stayed down until
# someone restored them by hand. After creating a fresh session, bring back the
# rest of the startup services too (see restore_tango_startup_windows).
tango_open_discord_window() {
  local session_name="$1" window_name="$2" repo_dir="$3" run_cmd="$4"
  if tango_service_tmux has-session -t "$session_name" 2>/dev/null; then
    tango_service_tmux new-window -t "$session_name" -n "$window_name" -c "$repo_dir" "$run_cmd"
  else
    tango_service_tmux new-session -d -s "$session_name" -n "$window_name" -c "$repo_dir" "$run_cmd"
    restore_tango_startup_windows "$repo_dir" discord  # the startup service id, whatever the window is called
  fi
}

# Replace the bot's process in place. respawn-window keeps the window, so the
# session never drops to zero windows and the tmux server (with every other
# service window) is never torn down by a bot restart. Returns 1 when there is
# no window to respawn.
tango_respawn_discord_window() {
  local target="$1" repo_dir="$2" run_cmd="$3"
  case "$target" in *:*) ;; *) return 1 ;; esac
  tmux_service_target_is_running "$target" || return 1
  tango_service_tmux respawn-window -k -t "$target" -c "$repo_dir" "$run_cmd"
}

# Start every enabled startup service except the bot whose window is missing.
# `startup.sh --only` adds missing windows and skips existing ones, so this never
# touches a running service, and the bot is excluded so it can't start twice.
# TANGO_RESTORE_WINDOWS=0 turns it off; TANGO_STARTUP_SCRIPT overrides the script (tests).
restore_tango_startup_windows() {
  local repo_dir="$1" skip="${2:-discord}" startup plan ids
  [ "${TANGO_RESTORE_WINDOWS:-1}" = "0" ] && return 0
  startup="${TANGO_STARTUP_SCRIPT:-$repo_dir/scripts/startup.sh}"
  [ -x "$startup" ] || return 0
  local node="${TANGO_NODE_BIN:-${NODE_BIN:-}}"
  if ! plan="$(TANGO_NODE_BIN="$node" "$startup" --dry-run --skip "$skip" 2>&1)"; then
    echo "Warning: tmux session was recreated but the other startup windows were not restored: startup.sh --dry-run failed:" >&2
    printf '%s\n' "$plan" | tail -5 >&2
    return 0
  fi
  ids="$(printf '%s\n' "$plan" | sed -nE 's/^  [0-9]+\. ([A-Za-z0-9_-]+) .*/\1/p' | paste -sd, -)"
  [ -n "$ids" ] || return 0
  echo "tmux session was recreated; restoring startup windows: $ids"
  TANGO_NODE_BIN="$node" "$startup" --only "$ids" || echo "Warning: could not restore every startup window ($ids); run scripts/startup.sh --only $ids" >&2
}

resolve_tango_repo_dir() {
  if [ -n "${TANGO_REPO_DIR:-}" ]; then
    printf '%s\n' "$TANGO_REPO_DIR"
    return 0
  fi

  local script_dir current_repo
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  current_repo="$(cd "$script_dir/../.." && pwd -P)"

  printf '%s\n' "$current_repo"
}

sync_tmux_service_environment() {
  local session_name="$1"

  if ! tango_service_tmux has-session -t "$session_name" 2>/dev/null \
    && ! tango_service_tmux list-sessions >/dev/null 2>&1; then
    return 0
  fi

  # Claude Code OAuth can depend on the GUI/login session environment. Long-lived
  # tmux servers may keep a stale SSH-style environment, so refresh the small set
  # of launch/session variables before creating service windows.
  local name value
  for name in \
    HOME \
    USER \
    LOGNAME \
    SHELL \
    PATH \
    TMPDIR \
    SSH_AUTH_SOCK \
    SECURITYSESSIONID \
    XPC_FLAGS \
    XPC_SERVICE_NAME \
    __CF_USER_TEXT_ENCODING \
    __CFBundleIdentifier \
    COMMAND_MODE \
    LaunchInstanceID
  do
    if printenv "$name" >/dev/null 2>&1; then
      value="$(printenv "$name")"
      tango_service_tmux set-environment -g "$name" "$value"
    fi
  done
}

slot_tmux_window_exists() {
  local session_name="$1"
  local window_name="$2"

  tango_service_tmux has-session -t "$session_name" 2>/dev/null \
    && tango_service_tmux list-windows -t "$session_name" -F '#{window_name}' 2>/dev/null | grep -qx "$window_name"
}

resolve_active_slot_window_name() {
  local session_name="$1"
  local has_probe=0
  local has_discord=0

  if slot_tmux_window_exists "$session_name" "slot-probe"; then
    has_probe=1
  fi

  if slot_tmux_window_exists "$session_name" "discord"; then
    has_discord=1
  fi

  if [ "$has_probe" -eq 1 ] && [ "$has_discord" -eq 1 ]; then
    echo "Multiple slot windows running in session '$session_name': slot-probe, discord" >&2
    return 1
  fi

  if [ "$has_discord" -eq 1 ]; then
    printf 'discord\n'
    return 0
  fi

  if [ "$has_probe" -eq 1 ]; then
    printf 'slot-probe\n'
    return 0
  fi

  return 1
}
