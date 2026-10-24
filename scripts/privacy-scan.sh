#!/bin/bash
# privacy-scan.sh — blocking scan for private/profile-specific content in
# tracked repo files.
#
# Design:
#   * FAIL CLOSED. Missing tools, a missing/unreadable/empty denylist, or any
#     unexpected error exits non-zero. A finding exits 1. Config/tooling
#     problems exit 2.
#   * The denylist of personal terms lives OUTSIDE the repo (profile layer),
#     so this script and the repo contain no personal terms themselves.
#       Path: $TANGO_PRIVACY_DENYLIST_FILE
#       Default: ~/.tango/profiles/default/config/privacy/denylist.txt
#   * Structural patterns (machine paths, credential snippets, Discord
#     snowflake ids, forbidden tracked files) are inlined below — they are
#     shapes, not personal terms.
#   * Known-legitimate matches are listed in scripts/privacy-scan-allowlist.txt
#     (exact repo-relative paths, or directory prefixes ending in "/").
#     Allowlisting applies to content scans only — the forbidden-tracked-file
#     checks can never be allowlisted.
#   * Only standard tools: git, grep, awk, sed. No ripgrep dependency.
#
# Usage:
#   scripts/privacy-scan.sh
#
# Exit codes:
#   0  clean
#   1  privacy findings (blocking)
#   2  configuration or tooling error (fail closed)

set -euo pipefail

fail_config() {
  echo "privacy-scan: ERROR: $1" >&2
  exit 2
}

command -v git >/dev/null 2>&1 || fail_config "git is not available on PATH"
command -v awk >/dev/null 2>&1 || fail_config "awk is not available on PATH"
command -v grep >/dev/null 2>&1 || fail_config "grep is not available on PATH"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
  || fail_config "not inside a git repository"
cd "$ROOT"

DENYLIST_FILE="${TANGO_PRIVACY_DENYLIST_FILE:-$HOME/.tango/profiles/default/config/privacy/denylist.txt}"

[[ -e "$DENYLIST_FILE" ]] \
  || fail_config "denylist file not found: $DENYLIST_FILE (set TANGO_PRIVACY_DENYLIST_FILE)"
[[ -r "$DENYLIST_FILE" ]] \
  || fail_config "denylist file is not readable: $DENYLIST_FILE"

# Effective denylist terms: strip comments/blank lines. An empty effective
# denylist means the scan cannot do its job — fail closed.
DENYLIST_TERMS=$(mktemp)
ALLOWLIST_PATHS=$(mktemp)
MATCH_BUF=$(mktemp)
trap 'rm -f "$DENYLIST_TERMS" "$ALLOWLIST_PATHS" "$MATCH_BUF"' EXIT

grep -v '^[[:space:]]*#' "$DENYLIST_FILE" | grep -v '^[[:space:]]*$' > "$DENYLIST_TERMS" || true
[[ -s "$DENYLIST_TERMS" ]] \
  || fail_config "denylist file has no usable terms: $DENYLIST_FILE"

ALLOWLIST_FILE="scripts/privacy-scan-allowlist.txt"
if [[ -e "$ALLOWLIST_FILE" ]]; then
  [[ -r "$ALLOWLIST_FILE" ]] || fail_config "allowlist exists but is not readable: $ALLOWLIST_FILE"
  grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' > "$ALLOWLIST_PATHS" || true
fi

failures=0

report() {
  # $1 = section label; matches are read from $MATCH_BUF (file:line:content).
  local label="$1"
  if [[ -s "$MATCH_BUF" ]]; then
    printf '\n== FAIL: %s ==\n' "$label"
    sed -n '1,40p' "$MATCH_BUF"
    local total
    total=$(wc -l < "$MATCH_BUF" | tr -d ' ')
    if [[ "$total" -gt 40 ]]; then
      printf '... and %s more matches\n' "$((total - 40))"
    fi
    failures=$((failures + 1))
  fi
}

filter_allowlist() {
  # stdin: file:line:content matches; suppress files listed in the allowlist.
  awk -v allowfile="$ALLOWLIST_PATHS" '
    BEGIN {
      n = 0
      while ((getline line < allowfile) > 0) {
        if (line != "") { allow[n++] = line }
      }
      close(allowfile)
    }
    {
      file = $0
      sub(/:.*$/, "", file)
      keep = 1
      for (i = 0; i < n; i++) {
        entry = allow[i]
        if (entry ~ /\/$/) {
          if (index(file, entry) == 1) { keep = 0; break }
        } else if (file == entry) {
          keep = 0; break
        }
      }
      if (keep) { print }
    }
  '
}

# ─── 1. Forbidden tracked files (never allowlistable) ────────────────────────

forbidden_tracked=$(git ls-files -- 'agents/assistants/*/USER.md' 'agents/assistants/*/context*' || true)
if [[ -n "$forbidden_tracked" ]]; then
  printf '\n== FAIL: agent personal context files are tracked (must live in the profile layer) ==\n'
  printf '%s\n' "$forbidden_tracked"
  failures=$((failures + 1))
fi

if [[ -e docs/projects/imessage-analysis ]]; then
  printf '\n== FAIL: private workspace exists at docs/projects/imessage-analysis (must not exist in the repo checkout) ==\n'
  failures=$((failures + 1))
fi

# ─── 2. Denylist terms (case-insensitive, all tracked text files) ────────────

git grep -I -i -n -F -f "$DENYLIST_TERMS" -- . 2>/dev/null | filter_allowlist > "$MATCH_BUF" || true
report "denylist terms found in tracked files (denylist: $DENYLIST_FILE)"

# ─── 3. Machine-local user paths ──────────────────────────────────────────────
# Absolute /Users/ paths, plus home-relative paths into personal directories
# (~/Documents, ~/Desktop, ~/Downloads, ~/legacy-agent) that encode one operator's
# machine layout. Repo-relative and ~/.tango paths are fine and not matched.

git grep -I -n -E '/Users/[A-Za-z0-9._-]+|~/(Documents|Desktop|Downloads|legacy-agent)/' -- . 2>/dev/null | filter_allowlist > "$MATCH_BUF" || true
report "machine-local user paths in tracked files (/Users/... or ~/{Documents,Desktop,Downloads,legacy-agent}/...)"

# ─── 4. Credential-management snippets ────────────────────────────────────────

git grep -I -n -E 'op://|OP_SERVICE_ACCOUNT_TOKEN|~/legacy-agent/secrets' -- . 2>/dev/null | filter_allowlist > "$MATCH_BUF" || true
report "credential-management snippets in tracked files"

# ─── 5. Real-looking Discord snowflake ids (16-20 digits) ─────────────────────
# Placeholders by convention look like 100000000000000003 (a leading digit
# followed by a long zero run); any 16-20 digit token containing a run of 10+
# zeros is treated as a placeholder. Digit runs inside decimal fractions
# (preceded by ".") are ignored.

git grep -I -n -E '[0-9]{16,20}' -- . 2>/dev/null \
  | filter_allowlist \
  | awk '
    {
      content = $0
      sub(/^[^:]*:[0-9]*:/, "", content)
      rest = content
      real = 0
      while (match(rest, /[0-9]+/)) {
        tok = substr(rest, RSTART, RLENGTH)
        before = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : ""
        rest = substr(rest, RSTART + RLENGTH)
        if (length(tok) >= 16 && length(tok) <= 20 && before != "." && tok !~ /0000000000/) {
          real = 1
        }
      }
      if (real) { print }
    }
  ' > "$MATCH_BUF" || true
report "real-looking 16-20 digit snowflake ids in tracked files"

# ─── Result ──────────────────────────────────────────────────────────────────

if [[ "$failures" -gt 0 ]]; then
  printf '\nprivacy-scan: BLOCKED — %s failing check(s).\n' "$failures"
  printf 'Fix the findings, or (for verified-legitimate matches only) add the file to %s with a comment.\n' "$ALLOWLIST_FILE"
  exit 1
fi

echo "privacy-scan: OK — no findings."
exit 0
