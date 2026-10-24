#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"

SESSION_NAME="$(resolve_tango_tmux_session_name)"
WINDOW_NAME="${TANGO_DISCORD_WINDOW:-discord}"
NODE_BIN="${TANGO_NODE_BIN:-/Users/you/.nvm/versions/node/v24.14.0/bin/node}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  exit 1
fi

cd "$REPO_DIR"
npm run build

source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed discord; then
  ts_restart discord
  exit $?
fi

EXISTING_TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
sync_tmux_service_environment "$SESSION_NAME"
RUN_CMD="$(tango_discord_run_cmd "$REPO_DIR" "$NODE_BIN")"

# Never kill the window: if it was the session's last one, the tmux server would exit.
if ! tango_respawn_discord_window "$EXISTING_TARGET" "$REPO_DIR" "$RUN_CMD"; then
  if tmux_service_target_is_running "$EXISTING_TARGET"; then
    tmux_service_target_kill "$EXISTING_TARGET"  # a legacy standalone session
  fi
  tango_open_discord_window "$SESSION_NAME" "$WINDOW_NAME" "$REPO_DIR" "$RUN_CMD"
fi

echo "Restarted Tango Discord in tmux target '${SESSION_NAME}:${WINDOW_NAME}'"
