#!/usr/bin/env bash

if [ -n "${TANGO_WORKTREE_COMMON_SH:-}" ]; then
  return 0
fi
TANGO_WORKTREE_COMMON_SH=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKTREE_BASE="${TANGO_WORKTREE_BASE:-$HOME/GitHub/tango-worktrees}"
SLOT_PROFILE_BASE="$HOME/.tango/profiles"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"

# shellcheck disable=SC1091
source "$REPO_DIR/scripts/tmux/session.sh"

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

slot_root_path() {
  printf '%s/wt-%s\n' "$WORKTREE_BASE" "$1"
}

slot_profile_path() {
  printf '%s/wt-%s\n' "$SLOT_PROFILE_BASE" "$1"
}

display_path() {
  case "$1" in
    "$HOME")
      printf '~\n'
      ;;
    "$HOME"/*)
      printf '~/%s\n' "${1#"$HOME"/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

read_lock_field() {
  local status_output="$1"
  local field_name="$2"

  printf '%s\n' "$status_output" | sed -n "s/^${field_name}=//p" | sed -n '1p'
}

tmux_session_exists() {
  tmux has-session -t "$1" 2>/dev/null
}

slot_root_has_entries() {
  local slot_root="$1"

  if [ ! -d "$slot_root" ]; then
    return 1
  fi

  set -- "$slot_root"/*
  [ -e "$1" ]
}

find_slot_worktree_path() {
  local slot="$1"
  local slot_root prefix candidate found=""

  validate_slot "$slot"
  slot_root="$(slot_root_path "$slot")"
  prefix="$slot_root/"

  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        candidate="${line#worktree }"
        case "$candidate" in
          "$prefix"*)
            if [ -n "$found" ] && [ "$found" != "$candidate" ]; then
              fail "Multiple worktrees found under $(display_path "$slot_root")."
            fi
            found="$candidate"
            ;;
        esac
        ;;
    esac
  done < <(git -C "$REPO_DIR" worktree list --porcelain)

  if [ -n "$found" ]; then
    printf '%s\n' "$found"
  fi
}

slot_is_free() {
  local slot="$1"
  local slot_root existing_worktree=""

  validate_slot "$slot"
  slot_root="$(slot_root_path "$slot")"
  existing_worktree="$(find_slot_worktree_path "$slot")"

  if [ -n "$existing_worktree" ]; then
    return 1
  fi

  if slot_root_has_entries "$slot_root"; then
    return 1
  fi

  return 0
}

format_age_from_utc() {
  local timestamp="$1"
  local acquired_epoch="" now delta

  acquired_epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$timestamp" '+%s' 2>/dev/null || true)"
  if [ -z "$acquired_epoch" ]; then
    return 0
  fi

  now="$(date +%s)"
  delta=$((now - acquired_epoch))
  if [ "$delta" -lt 0 ]; then
    delta=0
  fi

  if [ "$delta" -lt 60 ]; then
    printf '%ss ago\n' "$delta"
    return 0
  fi

  if [ "$delta" -lt 3600 ]; then
    printf '%sm ago\n' "$((delta / 60))"
    return 0
  fi

  if [ "$delta" -lt 86400 ]; then
    printf '%sh ago\n' "$((delta / 3600))"
    return 0
  fi

  printf '%sd ago\n' "$((delta / 86400))"
}

bot_status_for_slot() {
  local slot="$1"
  local status="" lock_slot="" acquired_at="" age=""

  validate_slot "$slot"
  status="$("$BOT_LOCK_SCRIPT" status)"
  if [ "$status" = "not held" ]; then
    printf 'not claimed\n'
    return 0
  fi

  lock_slot="$(read_lock_field "$status" slot)"
  if [ "$lock_slot" != "$slot" ]; then
    printf 'not claimed\n'
    return 0
  fi

  acquired_at="$(read_lock_field "$status" acquired_at)"
  if [ -n "$acquired_at" ]; then
    age="$(format_age_from_utc "$acquired_at")"
    if [ -n "$age" ]; then
      printf 'claimed (since %s)\n' "$age"
      return 0
    fi
  fi

  printf 'claimed\n'
}

detect_agent_for_slot() {
  local slot="$1"
  local session_name="dev-wt-$slot"
  local current_command="" pane_text=""

  validate_slot "$slot"
  if ! tmux_session_exists "$session_name"; then
    printf -- '-\n'
    return 0
  fi

  current_command="$(tmux display-message -p -t "$session_name" '#{pane_current_command}' 2>/dev/null || true)"
  case "$current_command" in
    codex)
      printf 'codex\n'
      return 0
      ;;
    claude)
      printf 'claude-code\n'
      return 0
      ;;
  esac

  pane_text="$(tmux capture-pane -t "$session_name" -p -S -80 2>/dev/null || true)"
  if [ "$current_command" = "node" ] && printf '%s\n' "$pane_text" | grep -q 'claude --dangerously-skip-permissions'; then
    printf 'claude-code\n'
    return 0
  fi

  if printf '%s\n' "$pane_text" | grep -q 'codex --model gpt-5.4'; then
    printf 'codex\n'
    return 0
  fi

  if printf '%s\n' "$pane_text" | grep -q 'claude --dangerously-skip-permissions'; then
    printf 'claude-code\n'
    return 0
  fi

  printf 'none\n'
}

prune_empty_slot_dirs() {
  local slot="$1"
  local slot_root=""

  validate_slot "$slot"
  slot_root="$(slot_root_path "$slot")"
  if [ ! -d "$slot_root" ]; then
    return 0
  fi

  find "$slot_root" -depth -type d -empty -exec rmdir '{}' ';' 2>/dev/null || true
  rmdir "$slot_root" 2>/dev/null || true
}

branch_upstream() {
  local branch_name="$1"

  git -C "$REPO_DIR" rev-parse --abbrev-ref --symbolic-full-name "${branch_name}@{upstream}" 2>/dev/null || true
}

branch_has_unpushed_commits() {
  local branch_name="$1"
  local upstream="" ahead_count=0

  upstream="$(branch_upstream "$branch_name")"
  if [ -z "$upstream" ]; then
    return 1
  fi

  ahead_count="$(git -C "$REPO_DIR" rev-list --count "${upstream}..${branch_name}" 2>/dev/null || echo 0)"
  if [ "$ahead_count" -gt 0 ]; then
    return 0
  fi

  return 1
}
