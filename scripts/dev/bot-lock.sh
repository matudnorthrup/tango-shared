#!/usr/bin/env bash
set -euo pipefail

LOCK_DIR="${TANGO_BOT_LOCK_PATH:-$HOME/.tango/slots/bot.lock.d}"
META_FILE="$LOCK_DIR/meta.env"
HISTORY_FILE="${TANGO_BOT_HISTORY_PATH:-$HOME/.tango/slots/history.log}"

usage() {
  cat >&2 <<EOF
Usage:
  $0 acquire <slot> [--wait] [--timeout <seconds>]
  $0 release <slot>
  $0 set-watcher <slot> <pid>
  $0 clear-watcher <slot>
  $0 status
  $0 history [--tail <lines>]
  $0 force-break
  $0 --self-test
EOF
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
      echo "Invalid slot '$1'. Expected 1, 2, or 3." >&2
      exit 1
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

ensure_lock_parent_dir() {
  mkdir -p "$(dirname "$LOCK_DIR")"
}

ensure_history_parent_dir() {
  mkdir -p "$(dirname "$HISTORY_FILE")"
}

current_timestamp_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

current_epoch_seconds() {
  date +%s
}

append_history_event() {
  local action="$1"
  shift

  ensure_history_parent_dir
  printf '%s %s %s\n' "$(current_timestamp_utc)" "$action" "$*" >>"$HISTORY_FILE"
}

read_lock_meta() {
  if [ ! -f "$META_FILE" ]; then
    return 1
  fi

  slot=""
  pid=""
  acquired_at=""
  acquired_epoch=""
  host=""
  watcher_pid=""

  # shellcheck disable=SC1090
  . "$META_FILE"
}

write_lock_meta() {
  local tmp_meta="$META_FILE.tmp"

  {
    printf 'slot=%s\n' "$slot"
    printf 'pid=%s\n' "$pid"
    printf 'acquired_at=%s\n' "$acquired_at"
    printf 'acquired_epoch=%s\n' "$acquired_epoch"
    printf 'host=%s\n' "$host"
    if [ -n "${watcher_pid:-}" ]; then
      printf 'watcher_pid=%s\n' "$watcher_pid"
    fi
  } >"$tmp_meta"

  mv "$tmp_meta" "$META_FILE"
}

print_status() {
  if [ ! -d "$LOCK_DIR" ]; then
    echo "not held"
    return 0
  fi

  if read_lock_meta; then
    printf 'slot=%s\n' "${slot:-unknown}"
    printf 'pid=%s\n' "${pid:-unknown}"
    printf 'acquired_at=%s\n' "${acquired_at:-unknown}"
    printf 'host=%s\n' "${host:-unknown}"
    if [ -n "${watcher_pid:-}" ]; then
      printf 'watcher_pid=%s\n' "$watcher_pid"
    fi
    return 0
  fi

  echo "held"
}

try_create_lock() {
  local requested_slot="$1"

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    return 1
  fi

  slot="$requested_slot"
  pid="$$"
  acquired_at="$(current_timestamp_utc)"
  acquired_epoch="$(current_epoch_seconds)"
  host="$(hostname)"
  watcher_pid=""

  if ! write_lock_meta; then
    rm -rf "$LOCK_DIR"
    fail "unable to write lock metadata"
  fi

  append_history_event acquire "slot=$requested_slot pid=$pid host=$host"
  echo "acquired slot=$requested_slot"
  return 0
}

acquire_lock() {
  local requested_slot="$1"
  local wait_mode="$2"
  local timeout_seconds="$3"
  local started_at=""
  local elapsed=0
  local sleep_seconds=1
  local remaining=0

  validate_slot "$requested_slot"
  validate_nonnegative_integer "$timeout_seconds"
  ensure_lock_parent_dir

  if [ "$wait_mode" -eq 0 ]; then
    if try_create_lock "$requested_slot"; then
      return 0
    fi

    echo "Bot lock already held." >&2
    print_status >&2
    exit 1
  fi

  started_at="$(current_epoch_seconds)"
  while true; do
    if try_create_lock "$requested_slot"; then
      return 0
    fi

    elapsed=$(( $(current_epoch_seconds) - started_at ))
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      echo "Timed out waiting for bot lock." >&2
      print_status >&2
      exit 1
    fi

    remaining=$(( timeout_seconds - elapsed ))
    if [ "$remaining" -lt "$sleep_seconds" ]; then
      sleep "$remaining"
    else
      sleep "$sleep_seconds"
    fi

    if [ "$sleep_seconds" -lt 10 ]; then
      sleep_seconds=$(( sleep_seconds * 2 ))
      if [ "$sleep_seconds" -gt 10 ]; then
        sleep_seconds=10
      fi
    fi
  done
}

release_lock() {
  local requested_slot="$1"
  local released_at_epoch=0
  local duration_sec=0

  validate_slot "$requested_slot"

  if [ ! -d "$LOCK_DIR" ]; then
    echo "not held"
    return 0
  fi

  if ! read_lock_meta; then
    echo "Lock metadata missing at $META_FILE" >&2
    exit 1
  fi

  if [ "${slot:-}" != "$requested_slot" ]; then
    echo "Lock held by slot ${slot:-unknown}, not slot $requested_slot." >&2
    exit 1
  fi

  if [ -n "${acquired_epoch:-}" ]; then
    released_at_epoch="$(current_epoch_seconds)"
    duration_sec=$(( released_at_epoch - acquired_epoch ))
    if [ "$duration_sec" -lt 0 ]; then
      duration_sec=0
    fi
  fi

  rm -rf "$LOCK_DIR"
  append_history_event release "slot=$requested_slot duration_sec=$duration_sec"
  echo "released slot=$requested_slot"
}

set_watcher_pid() {
  local requested_slot="$1"
  local requested_pid="$2"

  validate_slot "$requested_slot"
  validate_nonnegative_integer "$requested_pid"

  if [ ! -d "$LOCK_DIR" ]; then
    fail "bot lock is not held"
  fi

  if ! read_lock_meta; then
    fail "lock metadata missing at $META_FILE"
  fi

  if [ "${slot:-}" != "$requested_slot" ]; then
    fail "bot lock is held by slot ${slot:-unknown}, not slot $requested_slot"
  fi

  watcher_pid="$requested_pid"
  write_lock_meta
  echo "watcher_pid=$requested_pid"
}

clear_watcher_pid() {
  local requested_slot="$1"

  validate_slot "$requested_slot"

  if [ ! -d "$LOCK_DIR" ]; then
    echo "not held"
    return 0
  fi

  if ! read_lock_meta; then
    fail "lock metadata missing at $META_FILE"
  fi

  if [ "${slot:-}" != "$requested_slot" ]; then
    fail "bot lock is held by slot ${slot:-unknown}, not slot $requested_slot"
  fi

  watcher_pid=""
  write_lock_meta
  echo "watcher_pid="
}

print_history() {
  local tail_lines="$1"

  validate_nonnegative_integer "$tail_lines"

  if [ ! -f "$HISTORY_FILE" ]; then
    return 0
  fi

  tail -n "$tail_lines" "$HISTORY_FILE"
}

self_test() {
  local script_path="$0"
  local tmp_root=""
  local test_lock_dir=""
  local test_history_file=""
  local output=""
  local history_output=""
  local holder_pid=0
  local waited=0
  local acquired_after_wait=0

  tmp_root="$(mktemp -d /tmp/tango-bot-lock-test.XXXXXX)"
  test_lock_dir="$tmp_root/bot.lock.d"
  test_history_file="$tmp_root/history.log"

  cleanup() {
    if [ "$holder_pid" -gt 0 ] && kill -0 "$holder_pid" >/dev/null 2>&1; then
      kill "$holder_pid" >/dev/null 2>&1 || true
      wait "$holder_pid" >/dev/null 2>&1 || true
    fi
    rm -rf "$tmp_root"
  }
  trap cleanup EXIT INT TERM

  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" status)"
  [ "$output" = "not held" ] || fail "expected status=not held on fresh lock path"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" acquire 1 >/dev/null
  [ -d "$test_lock_dir" ] || fail "expected acquire to create $test_lock_dir"

  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" status)"
  printf '%s\n' "$output" | grep -qx 'slot=1' || fail "expected status to report slot=1"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" set-watcher 1 4242 >/dev/null
  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" status)"
  printf '%s\n' "$output" | grep -qx 'watcher_pid=4242' || fail "expected watcher_pid in status output"

  if TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" acquire 1 >/dev/null 2>&1; then
    fail "expected second acquire to fail while lock is held"
  fi

  if TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" release 2 >/dev/null 2>&1; then
    fail "expected release with wrong slot to fail"
  fi

  history_output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" history --tail 1)"
  printf '%s\n' "$history_output" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.* acquire slot=1 pid=[0-9]+ host=' \
    || fail "expected acquire history line"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" release 1 >/dev/null
  [ ! -d "$test_lock_dir" ] || fail "expected release to clear the lock directory"

  history_output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" history --tail 2)"
  printf '%s\n' "$history_output" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.* release slot=1 duration_sec=[0-9]+$' \
    || fail "expected release history line"

  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" release 1)"
  [ "$output" = "not held" ] || fail "expected release-not-held to be idempotent"

  (
    TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" acquire 2 >/dev/null
    sleep 2
    TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" release 2 >/dev/null
  ) &
  holder_pid=$!

  waited=0
  while [ "$waited" -lt 10 ]; do
    output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" status)"
    if printf '%s\n' "$output" | grep -qx 'slot=2'; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ "$waited" -lt 10 ] || fail "expected holder process to acquire slot 2"

  acquired_after_wait="$(current_epoch_seconds)"
  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" acquire 1 --wait --timeout 5 >/dev/null
  acquired_after_wait=$(( $(current_epoch_seconds) - acquired_after_wait ))
  [ "$acquired_after_wait" -ge 1 ] || fail "expected wait-mode acquire to block until holder released"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" release 1 >/dev/null
  wait "$holder_pid" >/dev/null
  holder_pid=0

  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" acquire 3 >/dev/null
  TANGO_BOT_LOCK_PATH="$test_lock_dir" TANGO_BOT_HISTORY_PATH="$test_history_file" "$script_path" force-break >/dev/null
  [ ! -d "$test_lock_dir" ] || fail "expected force-break to clear the lock directory"

  trap - EXIT INT TERM
  cleanup
  echo "PASS: bot-lock self-test"
}

if [ "$#" -lt 1 ]; then
  usage
fi

command="$1"
shift

case "$command" in
  acquire)
    [ "$#" -ge 1 ] || usage
    slot="$1"
    shift
    wait_mode=0
    timeout_seconds=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --wait)
          wait_mode=1
          ;;
        --timeout)
          shift
          [ "$#" -ge 1 ] || usage
          timeout_seconds="$1"
          ;;
        *)
          usage
          ;;
      esac
      shift
    done
    acquire_lock "$slot" "$wait_mode" "$timeout_seconds"
    ;;
  release)
    [ "$#" -eq 1 ] || usage
    release_lock "$1"
    ;;
  set-watcher)
    [ "$#" -eq 2 ] || usage
    set_watcher_pid "$1" "$2"
    ;;
  clear-watcher)
    [ "$#" -eq 1 ] || usage
    clear_watcher_pid "$1"
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    print_status
    ;;
  history)
    tail_lines=20
    if [ "$#" -eq 2 ] && [ "$1" = "--tail" ]; then
      tail_lines="$2"
    elif [ "$#" -ne 0 ]; then
      usage
    fi
    print_history "$tail_lines"
    ;;
  force-break)
    [ "$#" -eq 0 ] || usage
    if [ ! -d "$LOCK_DIR" ]; then
      echo "not held"
      exit 0
    fi
    echo "WARNING: force-breaking bot lock at $LOCK_DIR"
    rm -rf "$LOCK_DIR"
    ;;
  --self-test)
    [ "$#" -eq 0 ] || usage
    self_test
    ;;
  *)
    usage
    ;;
esac
