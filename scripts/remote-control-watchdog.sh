#!/bin/bash
# remote-control-watchdog.sh — Keeps Remote Control alive by restarting on exit
#
# Usage: scripts/remote-control-watchdog.sh [session-name]
#
# Wraps `claude remote-control` in a restart loop with caffeinate to prevent
# system idle sleep. Handles process crashes, network timeouts, and the
# WebSocket permanent-death bug (GitHub #31853).
#
# Known limitation: Server-side idle TTL (~20 min) kills sessions that receive
# no real user/model messages. This is an Anthropic server bug (#32982) that
# cannot be fixed client-side.

SESSION_NAME="${1:-Tango Dev}"
RESTART_DELAY=5
LOG_FILE="${HOME}/.tango/remote-control-watchdog.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "Watchdog started for session: $SESSION_NAME"

while true; do
    log "Starting Remote Control: $SESSION_NAME"
    caffeinate -i claude remote-control --name "$SESSION_NAME" --spawn same-dir
    EXIT_CODE=$?
    log "Remote Control exited (code $EXIT_CODE), restarting in ${RESTART_DELAY}s..."
    sleep $RESTART_DELAY
done
