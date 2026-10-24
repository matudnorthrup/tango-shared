#!/usr/bin/env bash
# Waits until the bot has no turns in flight (Discord channel queues and voice turns), so a
# restart doesn't cut off an agent mid-answer. A silent log is not proof: a turn can think
# for minutes without logging.
#
#   scripts/tmux/wait-bot-idle.sh [timeout-seconds]   (default 600)
#
# Exit 0 when idle for two checks in a row, 1 on timeout, 2 if the bot is not answering.
set -euo pipefail
timeout="${1:-600}"
url="${TANGO_TRIGGER_URL:-http://127.0.0.1:9200}/status/work"
deadline=$(( $(date +%s) + timeout ))
quiet=0
while :; do
  if ! body="$(curl -sf --max-time 5 "$url")"; then
    echo "bot not answering at $url (an older build has no /status/work; check the log by hand)" >&2
    exit 2
  fi
  if [[ "$body" == *'"channelTurns":0'* && "$body" == *'"voiceTurns":0'* ]]; then
    quiet=$((quiet + 1))
    if (( quiet >= 2 )); then echo "idle: $body"; exit 0; fi
  else
    quiet=0
    echo "busy: $body"
  fi
  if (( $(date +%s) >= deadline )); then echo "still busy after ${timeout}s: $body" >&2; exit 1; fi
  sleep 3
done
