#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_LOCK_SCRIPT="${TANGO_AUTO_RELEASE_BOT_LOCK_SCRIPT:-$SCRIPT_DIR/bot-lock.sh}"
RELEASE_SCRIPT="${TANGO_AUTO_RELEASE_RELEASE_SCRIPT:-$SCRIPT_DIR/release-bot.sh}"

usage() {
  echo "Usage: $0 <slot: 1|2|3> <seconds> | --self-test" >&2
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
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

validate_nonnegative_integer() {
  case "$1" in
    ''|*[!0-9]*)
      fail "expected non-negative integer, got '$1'"
      ;;
  esac
}

read_lock_field() {
  local status_output="$1"
  local field_name="$2"

  printf '%s\n' "$status_output" | sed -n "s/^${field_name}=//p" | sed -n '1p'
}

run_watcher() {
  local slot="$1"
  local seconds="$2"
  local lock_status=""
  local lock_slot=""

  validate_slot "$slot"
  validate_nonnegative_integer "$seconds"

  sleep "$seconds"

  lock_status="$("$BOT_LOCK_SCRIPT" status)"
  if [ "$lock_status" = "not held" ]; then
    exit 0
  fi

  lock_slot="$(read_lock_field "$lock_status" slot)"
  if [ "$lock_slot" != "$slot" ]; then
    exit 0
  fi

  TANGO_AUTO_RELEASE_ACTIVE=1 TANGO_AUTO_RELEASE_PID="$$" "$RELEASE_SCRIPT" "$slot" --live
}

self_test() {
  local script_path="$0"
  local tmp_root=""
  local test_lock_dir=""
  local test_history_file=""
  local release_log=""
  local mock_release_script=""
  local status_output=""

  tmp_root="$(mktemp -d /tmp/tango-bot-auto-release-test.XXXXXX)"
  test_lock_dir="$tmp_root/bot.lock.d"
  test_history_file="$tmp_root/history.log"
  release_log="$tmp_root/release.log"
  mock_release_script="$tmp_root/mock-release.sh"

  cleanup() {
    rm -rf "$tmp_root"
  }
  trap cleanup EXIT INT TERM

  cat >"$mock_release_script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TANGO_AUTO_RELEASE_TEST_LOG"
"$TANGO_AUTO_RELEASE_BOT_LOCK_SCRIPT" release "$1" >/dev/null
EOF
  chmod +x "$mock_release_script"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" \
    "$BOT_LOCK_SCRIPT" acquire 1 >/dev/null
  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" \
    TANGO_AUTO_RELEASE_TEST_LOG="$release_log" \
    TANGO_AUTO_RELEASE_BOT_LOCK_SCRIPT="$BOT_LOCK_SCRIPT" \
    TANGO_AUTO_RELEASE_RELEASE_SCRIPT="$mock_release_script" \
    "$script_path" 1 1 >/dev/null

  grep -qx '1 --live' "$release_log" || fail "expected watcher to invoke release script with --live"
  status_output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$BOT_LOCK_SCRIPT" status)"
  [ "$status_output" = "not held" ] || fail "expected watcher to release the held lock"

  : >"$release_log"
  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" \
    TANGO_AUTO_RELEASE_TEST_LOG="$release_log" \
    TANGO_AUTO_RELEASE_BOT_LOCK_SCRIPT="$BOT_LOCK_SCRIPT" \
    TANGO_AUTO_RELEASE_RELEASE_SCRIPT="$mock_release_script" \
    "$script_path" 1 0 >/dev/null
  [ ! -s "$release_log" ] || fail "expected no release call when lock is already clear"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" \
    "$BOT_LOCK_SCRIPT" acquire 2 >/dev/null
  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" \
    TANGO_AUTO_RELEASE_TEST_LOG="$release_log" \
    TANGO_AUTO_RELEASE_BOT_LOCK_SCRIPT="$BOT_LOCK_SCRIPT" \
    TANGO_AUTO_RELEASE_RELEASE_SCRIPT="$mock_release_script" \
    "$script_path" 1 0 >/dev/null
  [ ! -s "$release_log" ] || fail "expected watcher to ignore locks held by other slots"
  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" \
    "$BOT_LOCK_SCRIPT" release 2 >/dev/null

  trap - EXIT INT TERM
  cleanup
  echo "PASS: bot-auto-release self-test"
}

if [ "$#" -eq 1 ] && [ "$1" = "--self-test" ]; then
  self_test
  exit 0
fi

if [ "$#" -ne 2 ]; then
  usage
fi

run_watcher "$1" "$2"
