#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SLOT_ENV_SCRIPT="$SCRIPT_DIR/slot-env.sh"
DEFAULT_PROFILE_CONFIG_DIR="$HOME/.tango/profiles/default/config"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat >&2 <<EOF
Usage: $0 <branch-name> [--slot N] [--agent codex|claude-code] [--from REF]
EOF
  exit 1
}

default_from_ref() {
  if git -C "$REPO_DIR" cat-file -e main:scripts/dev/slot-env.sh >/dev/null 2>&1 \
    && git -C "$REPO_DIR" cat-file -e main:scripts/dev/claim-bot.sh >/dev/null 2>&1; then
    printf 'main\n'
    return 0
  fi

  if git -C "$REPO_DIR" rev-parse --verify "feature/phase2d-bot-polish^{commit}" >/dev/null 2>&1; then
    printf 'feature/phase2d-bot-polish\n'
    return 0
  fi

  printf 'main\n'
}

ensure_command_exists() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command '$1' not found on PATH."
  fi
}

normalize_agent() {
  case "$1" in
    "")
      printf 'none\n'
      ;;
    codex)
      printf 'codex\n'
      ;;
    claude|claude-code)
      printf 'claude-code\n'
      ;;
    *)
      fail "Invalid agent '$1'. Expected codex or claude-code."
      ;;
  esac
}

write_slot_instructions() {
  local worktree_path="$1"
  local slot="$2"
  local branch_name="$3"

  cat >"$worktree_path/CLAUDE.md.slot" <<EOF
# Slot Mode Instructions
You are operating in parallel dev slot wt-$slot on branch \`$branch_name\`.
- Your test Discord threads are in the per-agent smoke test channels (created when you claim the bot)
- To do a live Discord test: \`scripts/dev/claim-bot.sh $slot --live\`
- To release: \`scripts/dev/release-bot.sh $slot --live\`
- Your database is isolated at \`~/.tango/profiles/wt-$slot/data/tango.sqlite\`
- DO NOT modify files outside this worktree
- DO NOT push to main without PM approval
EOF
}

pick_slot() {
  local requested_slot="$1"
  local slot=""
  local slot_root="" existing_worktree=""

  if [ -n "$requested_slot" ]; then
    validate_slot "$requested_slot"
    slot_root="$(slot_root_path "$requested_slot")"
    existing_worktree="$(find_slot_worktree_path "$requested_slot")"
    if [ -n "$existing_worktree" ]; then
      fail "Slot wt-$requested_slot is already active at $(display_path "$existing_worktree")."
    fi
    if slot_root_has_entries "$slot_root"; then
      fail "Slot wt-$requested_slot is not free: $(display_path "$slot_root") contains existing files."
    fi
    printf '%s\n' "$requested_slot"
    return 0
  fi

  for slot in 1 2 3; do
    if slot_is_free "$slot"; then
      printf '%s\n' "$slot"
      return 0
    fi
  done

  fail "All worktree slots are taken. Release one with scripts/dev/release-worktree.sh <slot> first."
}

slot=""
requested_slot=""
agent=""
agent_label="none"
branch_name=""
from_ref="$(default_from_ref)"
from_ref_explicit=0

if [ "$#" -lt 1 ]; then
  usage
fi

branch_name="$1"
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --slot)
      shift
      [ "$#" -gt 0 ] || usage
      requested_slot="$1"
      ;;
    --agent)
      shift
      [ "$#" -gt 0 ] || usage
      agent="$1"
      ;;
    --from)
      shift
      [ "$#" -gt 0 ] || usage
      from_ref="$1"
      from_ref_explicit=1
      ;;
    *)
      usage
      ;;
  esac
  shift
done

git check-ref-format --branch "$branch_name" >/dev/null 2>&1 || fail "Invalid branch name '$branch_name'."
git -C "$REPO_DIR" rev-parse --verify "${from_ref}^{commit}" >/dev/null 2>&1 || fail "Base ref '$from_ref' not found."
ensure_command_exists git
ensure_command_exists npm
ensure_command_exists tmux

agent_label="$(normalize_agent "$agent")"
case "$agent_label" in
  codex)
    ensure_command_exists codex
    ;;
  claude-code)
    ensure_command_exists claude
    ;;
esac

slot="$(pick_slot "$requested_slot")"
dev_session_name="dev-wt-$slot"
if tmux_session_exists "$dev_session_name"; then
  fail "Slot wt-$slot already has a developer session; release first or reuse: $dev_session_name"
fi

main_repo_dir="$(resolve_tango_repo_dir)"
main_env_file="$main_repo_dir/.env"
if [ ! -f "$main_env_file" ]; then
  fail "Expected .env at $(display_path "$main_env_file"), but it was not found."
fi

if [ "$from_ref_explicit" -eq 0 ] && [ "$from_ref" != "main" ]; then
  echo "main does not yet contain the slot-mode scripts; defaulting spawn base to $from_ref"
fi

if [ ! -d "$DEFAULT_PROFILE_CONFIG_DIR" ]; then
  fail "Default profile config not found at $(display_path "$DEFAULT_PROFILE_CONFIG_DIR")."
fi

slot_root="$(slot_root_path "$slot")"
worktree_path="$slot_root/$branch_name"
if [ -e "$worktree_path" ]; then
  fail "Worktree path already exists: $(display_path "$worktree_path")."
fi

mkdir -p "$(dirname "$worktree_path")"

echo "Creating worktree wt-$slot at $(display_path "$worktree_path") from $from_ref"
git -C "$REPO_DIR" worktree add -b "$branch_name" "$worktree_path" "$from_ref"

slot_profile_dir="$(slot_profile_path "$slot")"
mkdir -p "$slot_profile_dir"

if [ ! -e "$slot_profile_dir/config" ]; then
  echo "Seeding profile config at $(display_path "$slot_profile_dir/config")"
  cp -R "$DEFAULT_PROFILE_CONFIG_DIR" "$slot_profile_dir/config"
else
  echo "Profile config already present at $(display_path "$slot_profile_dir/config"); leaving it in place"
fi

mkdir -p "$slot_profile_dir/data"
ln -sf "$main_env_file" "$worktree_path/.env"
"$SLOT_ENV_SCRIPT" "$slot" >"$worktree_path/.env.slot"
write_slot_instructions "$worktree_path" "$slot" "$branch_name"

echo "Installing dependencies in $(display_path "$worktree_path")"
(cd "$worktree_path" && npm install)

echo "Building repo in $(display_path "$worktree_path")"
(cd "$worktree_path" && npm run build)

tmux new-session -d -s "$dev_session_name" -c "$worktree_path"

launch_command=""
case "$agent_label" in
  codex)
    launch_command="codex --model gpt-5.4 --dangerously-bypass-approvals-and-sandbox"
    ;;
  claude-code)
    launch_command="claude --dangerously-skip-permissions --model claude-opus-4-8 --effort max"
    ;;
esac

if [ -n "$launch_command" ]; then
  tmux send-keys -t "$dev_session_name" "$launch_command" C-m
fi

echo
echo "Spawn complete"
echo "slot:          wt-$slot"
echo "branch:        $branch_name"
echo "agent:         $agent_label"
echo "worktree:      $(display_path "$worktree_path")"
echo "tmux session:  $dev_session_name"
echo "attach with:   tmux attach -t $dev_session_name"
echo "claim bot:     scripts/dev/claim-bot.sh $slot --live"
echo "release bot:   scripts/dev/release-bot.sh $slot --live"
