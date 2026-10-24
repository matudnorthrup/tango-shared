#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tango-server.sh"
if ts_managed usage-ui; then
  ts_start usage-ui
  exit $?
fi
source "$SCRIPT_DIR/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"

SESSION_NAME="$(resolve_tango_tmux_session_name)"
WINDOW_NAME="${TANGO_USAGE_UI_WINDOW:-usage-ui}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
NODE_BIN="${TANGO_NODE_BIN:-$(command -v node || true)}"
APP_DIR="$REPO_DIR/apps/usage-ui"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "No Node runtime found. Install Node 24 or set TANGO_NODE_BIN."
  exit 1
fi

if [ ! -f "$APP_DIR/dist/server/main.js" ]; then
  echo "Build output not found at apps/usage-ui/dist/server/main.js"
  echo "Run: npm run build -w @tango/usage-ui"
  exit 1
fi

if tmux_service_target_is_running "$TARGET"; then
  echo "tmux target '$TARGET' already running"
  exit 0
fi

sync_tmux_service_environment "$SESSION_NAME"

# A new window in an existing tmux session inherits that session's
# environment, not this shell's. Forward the usage-ui settings explicitly.
ENV_PREFIX=""
while IFS='=' read -r name _; do
  case "$name" in
    TANGO_PROFILE|USAGE_UI_*|AI_USAGE_*) ENV_PREFIX+="$(printf '%q=%q ' "$name" "${!name}")" ;;
  esac
done < <(env)
RUN_CMD="cd \"$APP_DIR\" && env ${ENV_PREFIX}\"$NODE_BIN\" dist/server/main.js"

if tango_service_tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tango_service_tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$APP_DIR" "$RUN_CMD"
else
  tango_service_tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$APP_DIR" "$RUN_CMD"
fi

echo "Started Usage UI in tmux target '${SESSION_NAME}:${WINDOW_NAME}' (port ${USAGE_UI_PORT:-9380})"
