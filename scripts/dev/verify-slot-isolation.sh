#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SLOT_ENV_SCRIPT="$REPO_DIR/scripts/dev/slot-env.sh"
RUNTIME_PATHS_JS="$REPO_DIR/packages/core/dist/runtime-paths.js"
MAIN_DB_PATH="$HOME/.tango/profiles/default/data/tango.sqlite"

usage() {
  echo "Usage: $0 <slot: 1|2|3>" >&2
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "${slot_db_path:-}" ]; then
    rm -f "${slot_db_path}"*
  fi
}

if [ "$#" -ne 1 ]; then
  usage
fi

slot="$1"

case "$slot" in
  1|2|3) ;;
  *)
    fail "invalid slot '$slot'. Expected 1, 2, or 3."
    ;;
esac

if [ ! -f "$RUNTIME_PATHS_JS" ]; then
  fail "Build output not found at packages/core/dist/runtime-paths.js. Run: npm run build -w @tango/core"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node runtime not found. Install Node or ensure 'node' is on PATH."
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  fail "sqlite3 not found on PATH."
fi

if [ ! -f "$MAIN_DB_PATH" ]; then
  fail "Main DB not found at $MAIN_DB_PATH"
fi

read -r main_inode_before main_size_before < <(stat -f "%i %z" "$MAIN_DB_PATH") \
  || fail "Unable to stat main DB at $MAIN_DB_PATH"

slot_profile_dir="$HOME/.tango/profiles/wt-$slot"
slot_data_dir="$slot_profile_dir/data"
slot_db_path="$slot_data_dir/tango.sqlite"
expected_slot_path="$slot_db_path"
trap cleanup EXIT INT TERM

mkdir -p "$slot_data_dir"
rm -f "${slot_db_path}"*

resolved_db_path="$(
  (
    cd "$REPO_DIR"
    unset TANGO_DB_PATH TANGO_DATA_DIR TANGO_HOME TANGO_PROFILE TANGO_SLOT TANGO_VOICE_BRIDGE_ENABLED
    # macOS bash 3.2 does not reliably propagate exports through source <(cmd).
    eval "$("$SLOT_ENV_SCRIPT" "$slot")"
    node --input-type=module -e 'import { resolveDatabasePath } from "./packages/core/dist/runtime-paths.js"; console.log(resolveDatabasePath());'
  )
)"

case "$resolved_db_path" in
  "$slot_profile_dir"/*) ;;
  *)
    fail "Resolved DB path '$resolved_db_path' is outside expected slot profile '$slot_profile_dir/'"
    ;;
esac

if [ "$resolved_db_path" != "$expected_slot_path" ]; then
  fail "Resolved DB path '$resolved_db_path' did not match expected path '$expected_slot_path'"
fi

sqlite3 "$resolved_db_path" \
  "CREATE TABLE slot_verify (id INTEGER PRIMARY KEY, marker TEXT, slot TEXT);
   INSERT INTO slot_verify (marker, slot) VALUES ('verify-ok', 'wt-$slot');" \
  >/dev/null

row="$(sqlite3 "$resolved_db_path" "SELECT marker || ':' || slot FROM slot_verify ORDER BY id DESC LIMIT 1;")"
if [ "$row" != "verify-ok:wt-$slot" ]; then
  fail "Unexpected verification row '$row'"
fi

read -r main_inode_after main_size_after < <(stat -f "%i %z" "$MAIN_DB_PATH") \
  || fail "Unable to re-stat main DB at $MAIN_DB_PATH"

if [ "$main_inode_after" != "$main_inode_before" ]; then
  fail "Main DB inode changed from $main_inode_before to $main_inode_after"
fi

if [ "$main_size_after" != "$main_size_before" ]; then
  echo "WARN: main DB size changed from $main_size_before to $main_size_after while inode stayed $main_inode_after"
fi

echo "PASS: slot wt-$slot isolated correctly"
