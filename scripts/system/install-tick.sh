#!/usr/bin/env bash
# Installs the system tick (docs/specs/system-visibility.md) as a LaunchAgent
# that runs every 60 s, plus ~/bin/tango-event and ~/bin/tango-run shims that
# point at this checkout's built CLIs.
#
#   scripts/system/install-tick.sh [--dry-run] [live checkout]
#
# The checkout defaults to the one this script is in; build it first
# (npm run build -w @tango/system). --dry-run prints what would be written and
# run, and changes nothing.
#
# Env: TANGO_HOME (default ~/.tango), TANGO_PROFILE (default "default"),
# TANGO_ENV_FILE (default <checkout>/.env), TANGO_BIN_DIR (default ~/bin).
# Uninstall: launchctl bootout gui/$(id -u)/com.tango.system-tick && rm the plist and shims.
set -euo pipefail

DRY=0
REPO_DIR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) REPO_DIR="$arg" ;;
  esac
done
REPO_DIR="$(cd "${REPO_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd)"

LABEL="com.tango.system-tick"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROFILE="${TANGO_PROFILE:-default}"
TANGO_HOME_DIR="${TANGO_HOME:-$HOME/.tango}"
LOG_DIR="$TANGO_HOME_DIR/profiles/$PROFILE/logs"
LOG="$LOG_DIR/system-tick.log"
ENV_FILE="${TANGO_ENV_FILE:-$REPO_DIR/.env}"
BIN_DIR="${TANGO_BIN_DIR:-$HOME/bin}"
NODE_BIN="$(command -v node || true)"
DIST="$REPO_DIR/packages/system/dist/cli"

[[ -n "$NODE_BIN" ]] || { echo "node not found on PATH" >&2; exit 1; }
if [[ ! -f "$DIST/tango-system.js" ]]; then
  if [[ "$DRY" == "1" ]]; then
    echo "note: $DIST/tango-system.js is not built yet (npm run build -w @tango/system)"
  else
    echo "not built: $DIST/tango-system.js (run npm run build -w @tango/system)" >&2
    exit 1
  fi
fi

# XML-escaped: a path with & or < would otherwise produce a broken plist.
xml() { python3 -c 'import sys, xml.sax.saxutils as x; print(x.escape(sys.argv[1]), end="")' "$1"; }
NODE_DIR="$(dirname "$NODE_BIN")"

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
    <string>$(xml "$DIST/tango-system.js")</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO_DIR")</string>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TANGO_REPO_DIR</key><string>$(xml "$REPO_DIR")</string>
    <key>TANGO_ENV_FILE</key><string>$(xml "$ENV_FILE")</string>
    <key>TANGO_PROFILE</key><string>$(xml "$PROFILE")</string>
    <key>TANGO_HOME</key><string>$(xml "$TANGO_HOME_DIR")</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(xml "$NODE_DIR")</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
}

# tango-event never breaks its caller: a missing build is a warning (exit 2 only with --strict).
event_shim() {
  cat <<SHIM
#!/bin/sh
# Installed by scripts/system/install-tick.sh; points at $REPO_DIR.
JS="$DIST/tango-event.js"
if [ ! -f "\$JS" ]; then
  echo "tango-event: warning: \$JS is not built; event not recorded" >&2
  for a in "\$@"; do [ "\$a" = "--strict" ] && exit 2; done
  exit 0
fi
exec "$NODE_BIN" "\$JS" "\$@"
SHIM
}

# tango-run always runs the command, recorded or not.
run_shim() {
  cat <<SHIM
#!/bin/sh
# Installed by scripts/system/install-tick.sh; points at $REPO_DIR.
JS="$DIST/tango-run.js"
if [ ! -f "\$JS" ]; then
  echo "tango-run: warning: \$JS is not built; run not recorded" >&2
  while [ \$# -gt 0 ] && [ "\$1" != "--" ]; do shift; done
  [ "\$1" = "--" ] && shift
  exec "\$@"
fi
exec "$NODE_BIN" "\$JS" "\$@"
SHIM
}

if [[ "$DRY" == "1" ]]; then
  echo "=== would write $PLIST ==="
  plist_body
  echo "=== would write $BIN_DIR/tango-event ==="
  event_shim
  echo "=== would write $BIN_DIR/tango-run ==="
  run_shim
  echo "=== would run ==="
  echo "mkdir -p $LOG_DIR $BIN_DIR"
  echo "plutil -lint $PLIST"
  echo "launchctl bootout gui/$(id -u)/$LABEL (if loaded)"
  echo "launchctl bootstrap gui/$(id -u) $PLIST"
  TMP_PLIST="$(mktemp -t system-tick-plist)"
  plist_body > "$TMP_PLIST"
  plutil -lint "$TMP_PLIST" >/dev/null && echo "plist lint: ok"
  rm -f "$TMP_PLIST"
  exit 0
fi

mkdir -p "$LOG_DIR" "$BIN_DIR" "$(dirname "$PLIST")"
plist_body > "$PLIST"
plutil -lint "$PLIST" >/dev/null || { echo "generated plist is invalid: $PLIST" >&2; exit 1; }
event_shim > "$BIN_DIR/tango-event"
run_shim > "$BIN_DIR/tango-run"
chmod 755 "$BIN_DIR/tango-event" "$BIN_DIR/tango-run"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every 60 s); log $LOG; shims in $BIN_DIR"
