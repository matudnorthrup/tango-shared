#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <slot: 1|2|3>" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
fi

slot="$1"

case "$slot" in
  1|2|3) ;;
  *)
    echo "Invalid slot '$slot'. Expected 1, 2, or 3." >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../session.sh"

export TANGO_REPO_DIR="$PWD"
REPO_DIR="$(resolve_tango_repo_dir)"
SESSION_NAME="tango-wt-$slot"
SLOT_ENV_FILE="$REPO_DIR/.env.slot"
SLOT_MODE="${TANGO_SLOT_MODE:-slot-probe}"
WINDOW_WIDTH=120
WINDOW_HEIGHT=5

resolve_node_bin() {
  local node_bin="${TANGO_NODE_BIN:-/Users/you/.nvm/versions/node/v24.14.0/bin/node}"

  if [ ! -x "$node_bin" ]; then
    node_bin="$(command -v node || true)"
  fi

  if [ -z "${node_bin:-}" ]; then
    echo "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN." >&2
    exit 1
  fi

  printf '%s\n' "$node_bin"
}

if [ ! -f "$SLOT_ENV_FILE" ]; then
  echo "Missing required $SLOT_ENV_FILE" >&2
  echo "Run: scripts/dev/slot-env.sh $slot > .env.slot from the worktree root" >&2
  exit 1
fi

case "$SLOT_MODE" in
  discord)
    WINDOW_NAME="discord"
    TARGET="${SESSION_NAME}:${WINDOW_NAME}"
    NODE_BIN="$(resolve_node_bin)"

    if [ ! -f "$REPO_DIR/packages/discord/dist/main.js" ]; then
      echo "Build output not found at packages/discord/dist/main.js" >&2
      echo "Run: npm run build -w @tango/discord" >&2
      exit 1
    fi

    if slot_tmux_window_exists "$SESSION_NAME" "$WINDOW_NAME"; then
      echo "tmux target '$TARGET' already running"
      exit 0
    fi

    printf "launching node packages/discord/dist/main.js with env from .env + .env.slot in window %s:discord\n" "$SESSION_NAME"
    SLOT_GIT_BRANCH="$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || true)"

    if [ -n "${DISCORD_ALLOWED_CHANNELS:-}" ]; then
      printf -v CHANNELS_CMD 'export DISCORD_ALLOWED_CHANNELS=%q && ' "$DISCORD_ALLOWED_CHANNELS"
    else
      CHANNELS_CMD='unset DISCORD_ALLOWED_CHANNELS && '
    fi

    if [ -n "$SLOT_GIT_BRANCH" ]; then
      printf -v BRANCH_CMD 'export TANGO_GIT_BRANCH=%q && ' "$SLOT_GIT_BRANCH"
    else
      BRANCH_CMD='unset TANGO_GIT_BRANCH && '
    fi

    sync_tmux_service_environment "$(resolve_tango_tmux_session_name)"

    printf -v DISCORD_CMD '%s' "cd \"$REPO_DIR\" && set -a && if [ -f .env ]; then source .env; fi && source .env.slot && set +a && ${BRANCH_CMD}${CHANNELS_CMD}env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$NODE_BIN\" packages/discord/dist/main.js"
    printf -v RUN_CMD 'bash -lc %q' "$DISCORD_CMD"

    if tango_service_tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      tango_service_tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
    else
      tango_service_tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
    fi

    echo "Started slot Discord in tmux target '${SESSION_NAME}:${WINDOW_NAME}'"
    ;;
  *)
    WINDOW_NAME="slot-probe"
    TARGET="${SESSION_NAME}:${WINDOW_NAME}"

    printf "would launch node packages/discord/dist/main.js with env from .env + .env.slot in window %s:discord\n" "$SESSION_NAME"

    if slot_tmux_window_exists "$SESSION_NAME" "$WINDOW_NAME"; then
      echo "tmux target '$TARGET' already running"
      exit 0
    fi

    printf -v PROBE_CMD '%s' "cd \"$REPO_DIR\" && set -a && if [ -f .env ]; then source .env; fi && source .env.slot && set +a && while true; do date; printf 'TANGO_PROFILE=%s\nTANGO_SLOT=%s\nTANGO_VOICE_BRIDGE_ENABLED=%s\n---\n' \"\$TANGO_PROFILE\" \"\$TANGO_SLOT\" \"\$TANGO_VOICE_BRIDGE_ENABLED\"; sleep 5; done"
    printf -v RUN_CMD 'bash -lc %q' "$PROBE_CMD"

    sync_tmux_service_environment "$(resolve_tango_tmux_session_name)"

    if tango_service_tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      tango_service_tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
      tango_service_tmux resize-window -t "$TARGET" -x "$WINDOW_WIDTH" -y "$WINDOW_HEIGHT"
    else
      tango_service_tmux new-session -d -x "$WINDOW_WIDTH" -y "$WINDOW_HEIGHT" -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
    fi

    echo "Started slot probe in tmux target '${SESSION_NAME}:${WINDOW_NAME}'"
    ;;
esac
