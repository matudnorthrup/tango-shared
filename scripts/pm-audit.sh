#!/bin/bash
# pm-audit.sh — audit TANGO-PM-* tmux sessions and optionally clean up idle ones
#
# Usage:
#   scripts/pm-audit.sh                 # list all PM sessions with activity status
#   scripts/pm-audit.sh --close-idle    # close sessions idle for >2 hours (default)
#   scripts/pm-audit.sh --close-idle --idle-hours 4  # override idle threshold
#   scripts/pm-audit.sh --close-shipped # close sessions that have "SHIPPED" in recent output
#   scripts/pm-audit.sh --close-all-but <session>  # close every PM session except one

set -euo pipefail

# Defaults
IDLE_HOURS=2
ACTION="list"  # list, close-idle, close-shipped, close-all-but
KEEP_SESSION=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --close-idle) ACTION="close-idle"; shift ;;
    --close-shipped) ACTION="close-shipped"; shift ;;
    --close-all-but)
      ACTION="close-all-but"
      KEEP_SESSION="${2:-}"
      if [[ -z "$KEEP_SESSION" ]]; then
        echo "Error: --close-all-but requires a session name" >&2
        exit 1
      fi
      shift 2
      ;;
    --idle-hours) IDLE_HOURS="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -15
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Get list of PM sessions with their last-activity timestamps (epoch seconds)
# tmux display-message -p -t <session> '#{session_activity}' returns epoch seconds
now=$(date +%s)
idle_threshold=$((IDLE_HOURS * 3600))

sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^TANGO-PM-' || true)

if [[ -z "$sessions" ]]; then
  echo "No TANGO-PM-* sessions found."
  exit 0
fi

printf "%-32s %-20s %-12s %s\n" "SESSION" "LAST ACTIVITY" "IDLE" "LAST LINE (approx)"
printf "%-32s %-20s %-12s %s\n" "-------" "-------------" "----" "-------------------"

to_close=()

while IFS= read -r s; do
  [[ -z "$s" ]] && continue
  activity=$(tmux display-message -p -t "$s" '#{session_activity}' 2>/dev/null || echo 0)
  idle_sec=$((now - activity))
  idle_hr=$((idle_sec / 3600))
  idle_min=$(( (idle_sec % 3600) / 60 ))
  activity_fmt=$(date -r "$activity" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "?")
  last_line=$(tmux capture-pane -t "$s" -p 2>/dev/null | grep -v '^$' | tail -1 | cut -c1-60 || echo "")

  printf "%-32s %-20s %3dh %2dm   %s\n" "$s" "$activity_fmt" "$idle_hr" "$idle_min" "$last_line"

  case "$ACTION" in
    close-idle)
      if (( idle_sec > idle_threshold )); then
        to_close+=("$s")
      fi
      ;;
    close-shipped)
      # Look for SHIPPED in recent output
      if tmux capture-pane -t "$s" -p -S -100 2>/dev/null | grep -qiE 'SHIPPED|shipped and|project completed'; then
        to_close+=("$s")
      fi
      ;;
    close-all-but)
      if [[ "$s" != "$KEEP_SESSION" ]]; then
        to_close+=("$s")
      fi
      ;;
  esac
done <<< "$sessions"

if [[ "$ACTION" == "list" ]]; then
  echo
  echo "Run with --close-idle, --close-shipped, or --close-all-but <name> to clean up."
  exit 0
fi

if [[ ${#to_close[@]} -eq 0 ]]; then
  echo
  echo "Nothing to close."
  exit 0
fi

echo
echo "Would close ${#to_close[@]} session(s):"
for s in "${to_close[@]}"; do
  echo "  - $s"
done

echo
read -r -p "Confirm? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

for s in "${to_close[@]}"; do
  tmux kill-session -t "$s" 2>/dev/null && echo "Closed: $s"
done
