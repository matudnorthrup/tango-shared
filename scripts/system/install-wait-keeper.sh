#!/usr/bin/env bash
# Installs the wait-keeper (packages/system/src/wait-keeper.ts) as a LaunchAgent
# that runs every 30 min: it wakes each overdue promise to come back once and
# flags stale waits on the System page.
#
#   scripts/system/install-wait-keeper.sh [--dry-run] [live checkout]
#
# The checkout defaults to the one this script is in; build it first
# (npm run build -w @tango/system). --dry-run prints the plist and changes nothing.
#
# Env: TANGO_HOME (default ~/.tango), TANGO_PROFILE (default "default"). Where the services keep their
# state, when not the defaults, is carried into the job as set here: SCREEN_DATA_DIR, TANGO_SCREEN_DB,
# TANGO_DESK_URL, LOOM_HOME, LOOM_PORT, LOOM_URL.
# Uninstall: launchctl bootout gui/$(id -u)/com.tango.wait-keeper && rm the plist.
set -euo pipefail

DRY=0
REPO_DIR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) REPO_DIR="$arg" ;;
  esac
done
REPO_DIR="$(cd "${REPO_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd)"

LABEL="com.tango.wait-keeper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROFILE="${TANGO_PROFILE:-default}"
TANGO_HOME_DIR="${TANGO_HOME:-$HOME/.tango}"
LOG_DIR="$TANGO_HOME_DIR/profiles/$PROFILE/logs"
LOG="$LOG_DIR/wait-keeper.log"
NODE_BIN="$(command -v node || true)"
CLI="$REPO_DIR/packages/system/dist/cli/tango-system.js"

[[ -n "$NODE_BIN" ]] || { echo "node not found on PATH" >&2; exit 1; }
[[ -f "$CLI" || "$DRY" == "1" ]] || { echo "not built: $CLI (run npm run build -w @tango/system)" >&2; exit 1; }

xml() { python3 -c 'import sys, xml.sax.saxutils as x; print(x.escape(sys.argv[1]), end="")' "$1"; }

# The services' own location settings, so the job reads what they use (Codex review on #770).
extra_env() {
  local name
  for name in SCREEN_DATA_DIR TANGO_SCREEN_DB TANGO_DESK_URL LOOM_HOME LOOM_PORT LOOM_URL; do
    [[ -n "${!name:-}" ]] && printf '    <key>%s</key><string>%s</string>\n' "$name" "$(xml "${!name}")"
  done
  return 0
}

plist_body() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>
    <string>$(xml "$CLI")</string>
    <string>wait-keeper</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO_DIR")</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TANGO_REPO_DIR</key><string>$(xml "$REPO_DIR")</string>
    <key>TANGO_PROFILE</key><string>$(xml "$PROFILE")</string>
    <key>TANGO_HOME</key><string>$(xml "$TANGO_HOME_DIR")</string>
$(extra_env)
  </dict>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
}

if [[ "$DRY" == "1" ]]; then
  echo "=== would write $PLIST ==="
  plist_body
  exit 0
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
plist_body > "$PLIST"
plutil -lint "$PLIST" >/dev/null || { echo "generated plist is invalid: $PLIST" >&2; exit 1; }
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every 30 min); log $LOG"
