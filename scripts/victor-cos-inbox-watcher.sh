#!/bin/bash

set -euo pipefail

SESSION_NAME="${VICTOR_COS_SESSION_NAME:-VICTOR-COS}"
# Target the Claude Code window explicitly (window 0), not the active window.
# The watcher runs in a separate window and tmux send-keys defaults to the
# active window, which would send the prompt back to the watcher itself.
SESSION_TARGET="${SESSION_NAME}:0"
INBOX_DIR="${VICTOR_COS_INBOX_DIR:-/tmp/victor-cos-inbox}"
OUTBOX_DIR="${VICTOR_COS_OUTBOX_DIR:-/tmp/victor-cos-outbox}"
IDLE_WAIT_SECONDS=5

mkdir -p "$INBOX_DIR" "$OUTBOX_DIR"

log() {
  printf '[victor-cos-watcher] %s\n' "$*"
}

tmux_target_available() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

pane_looks_idle() {
  local current_command pane_text last_nonempty

  current_command="$(tmux display-message -p -t "$SESSION_TARGET" '#{pane_current_command}' 2>/dev/null || true)"
  case "$current_command" in
    bash|zsh|sh|fish)
      return 0
      ;;
  esac

  pane_text="$(tmux capture-pane -t "$SESSION_TARGET" -p -S -40 2>/dev/null || true)"
  last_nonempty="$(printf '%s\n' "$pane_text" | awk 'NF { line = $0 } END { print line }')"

  case "$last_nonempty" in
    *"> "|*">"|*"$ "|*"% ")
      return 0
      ;;
  esac

  if printf '%s\n' "$pane_text" | tail -n 5 | grep -Eq '(^|[[:space:][:punct:]])[>][[:space:]]*$'; then
    return 0
  fi

  return 1
}

wait_for_victor_idle() {
  local waited=0
  while [ "$waited" -lt "$IDLE_WAIT_SECONDS" ]; do
    if pane_looks_idle; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

build_prompt() {
  local inbox_file="$1"
  local request_id="$2"
  local response_file="$3"

  node --input-type=module - "$inbox_file" "$request_id" "$response_file" <<'NODE'
import fs from "node:fs";

const [inboxFile, requestId, responseFile] = process.argv.slice(2);
const message = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
const user = message.user
  ? `${message.user.username} (${message.user.id})`
  : "unknown";
const channel = message.channel?.threadId
  ? `${message.channel.id} thread=${message.channel.threadId}`
  : `${message.channel?.id ?? "unknown"}`;
const prompt = [
  "Discord bridge message for Victor persistent session.",
  `Request ID: ${requestId}`,
  `Source: ${message.source ?? "unknown"}`,
  `User: ${user}`,
  `Channel: ${channel}`,
  `Session ID: ${message.sessionId ?? "unknown"}`,
  `Agent ID: ${message.agentId ?? "unknown"}`,
  "",
  "Message content:",
  message.content ?? "",
  "",
  "Write the final response as JSON to this exact path:",
  responseFile,
  "",
  "Response format:",
  JSON.stringify(
    {
      requestId,
      text: "your response text here",
      timestamp: new Date().toISOString(),
    },
    null,
    2,
  ),
];

process.stdout.write(prompt.join("\n"));
NODE
}

send_prompt_to_victor() {
  local prompt="$1"
  local tmp_file

  # Write the prompt to a temp file, then use send-tmux-message.sh which handles
  # Claude Code's multi-line paste detection reliably (paste + wait + Enter + verify).
  tmp_file="$(mktemp /tmp/victor-cos-prompt-XXXXXX.md)"
  printf '%s' "$prompt" > "$tmp_file"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  "$SCRIPT_DIR/send-tmux-message.sh" "$SESSION_TARGET" "$tmp_file"
  rm -f "$tmp_file"
}

deliver_file() {
  local inbox_file="$1"
  local file_name request_id response_file prompt

  file_name="$(basename "$inbox_file")"
  request_id="${file_name%.json}"
  request_id="${request_id: -36}"
  response_file="$OUTBOX_DIR/$request_id.json"

  if ! tmux_target_available; then
    log "tmux session '$SESSION_NAME' is not available; leaving '$inbox_file' queued"
    return 1
  fi

  if wait_for_victor_idle; then
    log "Victor session looks idle; delivering request '$request_id'"
  else
    log "Victor session did not look idle within ${IDLE_WAIT_SECONDS}s; delivering request '$request_id' anyway"
  fi

  prompt="$(build_prompt "$inbox_file" "$request_id" "$response_file")"
  send_prompt_to_victor "$prompt"
  rm -f "$inbox_file"
  return 0
}

process_queue() {
  local inbox_file processed_any=0

  for inbox_file in "$INBOX_DIR"/*.json; do
    if [ ! -e "$inbox_file" ]; then
      break
    fi

    processed_any=1
    if ! deliver_file "$inbox_file"; then
      break
    fi
  done

  if [ "$processed_any" -eq 1 ]; then
    :
  fi
}

watch_with_fswatch() {
  log "watching '$INBOX_DIR' with fswatch"
  fswatch -0 "$INBOX_DIR" | while IFS= read -r -d '' _event; do
    process_queue
  done
}

watch_with_inotifywait() {
  log "watching '$INBOX_DIR' with inotifywait"
  while inotifywait -qq -e create -e close_write -e moved_to "$INBOX_DIR"; do
    process_queue
  done
}

watch_with_polling() {
  log "watching '$INBOX_DIR' with polling fallback"
  while true; do
    process_queue
    sleep 1
  done
}

process_queue

if command -v fswatch >/dev/null 2>&1; then
  watch_with_fswatch
elif command -v inotifywait >/dev/null 2>&1; then
  watch_with_inotifywait
else
  watch_with_polling
fi
