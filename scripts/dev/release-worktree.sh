#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_BOT_SCRIPT="$SCRIPT_DIR/release-bot.sh"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat >&2 <<EOF
Usage: $0 <slot: 1|2|3> [--keep-branch] [--keep-profile]
EOF
  exit 1
}

prompt_remove_profile() {
  local slot="$1"
  local answer=""

  printf 'Remove profile wt-%s? [y/N] ' "$slot"
  if [ -t 0 ]; then
    read -r answer || answer=""
  else
    printf '\n'
    return 1
  fi

  case "$answer" in
    y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  usage
fi

slot="$1"
validate_slot "$slot"
shift

keep_branch=0
keep_profile=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-branch)
      keep_branch=1
      ;;
    --keep-profile)
      keep_profile=1
      ;;
    *)
      usage
      ;;
  esac
  shift
done

ensure_tmux=1
if ! command -v tmux >/dev/null 2>&1; then
  ensure_tmux=0
fi

slot_profile_dir="$(slot_profile_path "$slot")"
worktree_path="$(find_slot_worktree_path "$slot")"
branch_name=""
if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
  branch_name="$(git -C "$worktree_path" branch --show-current 2>/dev/null || true)"
fi

released_bot="no"
dev_session_result="not running"
slot_session_result="not running"
worktree_result="not found"
branch_result="kept"
profile_result="kept"

lock_status="$("$BOT_LOCK_SCRIPT" status)"
if [ "$lock_status" != "not held" ]; then
  lock_slot="$(read_lock_field "$lock_status" slot)"
  if [ "$lock_slot" = "$slot" ]; then
    echo "Bot lock held by slot wt-$slot; releasing live bot before cleanup"
    "$RELEASE_BOT_SCRIPT" "$slot" --live
    released_bot="yes"
  else
    echo "Warning: bot lock is held by slot wt-${lock_slot:-unknown}; not releasing it from wt-$slot"
  fi
fi

if [ "$ensure_tmux" -eq 1 ] && tmux_session_exists "dev-wt-$slot"; then
  tmux kill-session -t "dev-wt-$slot"
  dev_session_result="killed"
fi

if [ "$ensure_tmux" -eq 1 ] && tango_service_tmux has-session -t "tango-wt-$slot" 2>/dev/null; then
  tango_service_tmux kill-session -t "tango-wt-$slot"
  slot_session_result="killed"
elif [ "$ensure_tmux" -eq 1 ] && tmux_session_exists "tango-wt-$slot"; then
  tmux kill-session -t "tango-wt-$slot"
  slot_session_result="killed"
fi

if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
  if [ -n "$(git -C "$worktree_path" status --short 2>/dev/null || true)" ]; then
    echo "Warning: removing worktree with uncommitted changes at $(display_path "$worktree_path")"
  fi

  if [ -f "$worktree_path/CLAUDE.md.slot" ]; then
    rm -f "$worktree_path/CLAUDE.md.slot"
  fi

  git -C "$REPO_DIR" worktree remove "$worktree_path" --force
  prune_empty_slot_dirs "$slot"
  worktree_result="removed"
fi

if [ "$keep_branch" -eq 1 ]; then
  branch_result="kept (--keep-branch)"
elif [ -z "$branch_name" ]; then
  branch_result="not found"
elif ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch_name"; then
  branch_result="already absent"
elif branch_has_unpushed_commits "$branch_name"; then
  upstream_name="$(branch_upstream "$branch_name")"
  branch_result="kept (unpushed commits vs $upstream_name)"
  echo "Warning: keeping local branch '$branch_name' because it has unpushed commits relative to $upstream_name"
else
  git -C "$REPO_DIR" branch -D "$branch_name" >/dev/null
  branch_result="deleted"
fi

if [ "$keep_profile" -eq 1 ]; then
  profile_result="kept (--keep-profile)"
elif [ ! -d "$slot_profile_dir" ]; then
  profile_result="not found"
elif prompt_remove_profile "$slot"; then
  rm -rf "$slot_profile_dir"
  profile_result="removed"
else
  profile_result="kept"
fi

echo
echo "Release complete"
echo "slot:           wt-$slot"
echo "bot released:   $released_bot"
echo "dev session:    $dev_session_result"
echo "slot session:   $slot_session_result"
echo "worktree:       $worktree_result"
echo "branch:         $branch_result"
echo "profile:        $profile_result"
