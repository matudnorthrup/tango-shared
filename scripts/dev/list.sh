#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/worktree-common.sh"

printf '%-4s %-8s %-28s %-12s %-60s %s\n' "SLOT" "STATUS" "BRANCH" "AGENT" "WORKTREE" "BOT"

for slot in 1 2 3; do
  status="empty"
  branch="-"
  agent="-"
  worktree_display="-"
  bot_display="-"

  worktree_path="$(find_slot_worktree_path "$slot")"
  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
    status="active"
    branch="$(git -C "$worktree_path" branch --show-current 2>/dev/null || printf -- '-')"
    agent="$(detect_agent_for_slot "$slot")"
    if [ "$agent" = "-" ]; then
      agent="none"
    fi
    worktree_display="$(display_path "$worktree_path")"
    bot_display="$(bot_status_for_slot "$slot")"
  else
    bot_display="$(bot_status_for_slot "$slot")"
    if [ "$bot_display" = "not claimed" ]; then
      bot_display="-"
    fi
  fi

  printf '%-4s %-8s %-28s %-12s %-60s %s\n' "$slot" "$status" "$branch" "$agent" "$worktree_display" "$bot_display"
done
