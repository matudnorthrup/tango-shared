#!/usr/bin/env bash
# Focused, credential-free tests for scripts/gog-reauth.sh.

set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/gog-reauth.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gog-reauth-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

assert_contains() {
  needle="$1"
  file="$2"
  if ! grep -F -- "$needle" "$file" >/dev/null; then
    echo "Expected $file to contain: $needle" >&2
    exit 1
  fi
}

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''%s|%s\\n'\'' "$GOG_KEYRING_PASSWORD" "$*" >> "$GOG_REAUTH_TEST_LOG"' \
  > "$TMP_DIR/gog"
chmod +x "$TMP_DIR/gog"

printf '%s\n' 'GOG_KEYRING_PASSWORD=synthetic-password # comment' > "$TMP_DIR/test.env"

help_output="$TMP_DIR/help.out"
"$SCRIPT" --help > "$help_output"
assert_contains "--account EMAIL" "$help_output"
assert_contains "gmail,calendar,docs,drive" "$help_output"

missing_output="$TMP_DIR/missing.out"
if "$SCRIPT" --env-file "$TMP_DIR/test.env" > "$missing_output" 2>&1; then
  echo "Expected missing-account invocation to fail." >&2
  exit 1
fi
assert_contains "At least one --account is required." "$missing_output"

log="$TMP_DIR/gog.log"
env GOG_KEYRING_PASSWORD=stale-launcher-password \
  GOG_BIN="$TMP_DIR/gog" \
  GOG_REAUTH_TEST_LOG="$log" \
  "$SCRIPT" --env-file "$TMP_DIR/test.env" \
  --account first@example.test --account second@example.test > "$TMP_DIR/run.out"

assert_contains "synthetic-password|auth keyring file" "$log"
assert_contains "synthetic-password|auth add first@example.test --services gmail,calendar,docs,drive --force-consent" "$log"
assert_contains "synthetic-password|drive ls --account first@example.test --max 1 --plain" "$log"
assert_contains "synthetic-password|auth add second@example.test --services gmail,calendar,docs,drive --force-consent" "$log"
assert_contains "synthetic-password|drive ls --account second@example.test --max 1 --plain" "$log"
assert_contains "All 2 named account(s) refreshed and validated." "$TMP_DIR/run.out"

echo "gog-reauth tests passed"
