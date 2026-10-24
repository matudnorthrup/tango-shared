#!/usr/bin/env bash
# Installs the Tango health check as a LaunchAgent that runs every minute.
#
#   scripts/health/install-healthcheck.sh <live checkout> [tmux socket] [tailnet URL] [screen launchd label]
#
# The check restarts the bot only through tmux (the tmux server, not launchd,
# launches it), so the bot keeps the privacy grants of the context that started
# tmux. Uninstall: launchctl bootout gui/$(id -u)/com.tango.healthcheck && rm the plist.
set -euo pipefail

REPO_DIR="${1:?usage: install-healthcheck.sh <live checkout> [tmux socket] [tailnet URL] [screen launchd label]}"
# XML-escaped: a path with & or < would otherwise produce a broken plist.
xml() { python3 -c 'import sys, xml.sax.saxutils as x; print(x.escape(sys.argv[1]), end="")' "$1"; }
SOCKET="$(xml "${2:-}")"
TAILNET_URL="$(xml "${3:-}")"
SCREEN_AGENT="$(xml "${4:-}")"
REPO_XML="$(xml "$REPO_DIR")"
NODE_DIR="$(xml "$(dirname "$(command -v node)")")"
LABEL="com.tango.healthcheck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.tango/health"
mkdir -p "$STATE_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_XML/scripts/health/tango-healthcheck.sh</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TANGO_REPO_DIR</key><string>$REPO_XML</string>
    <key>TANGO_HEALTH_SCREEN_AGENT</key><string>$SCREEN_AGENT</string>
    <key>TANGO_SERVICE_TMUX_SOCKET</key><string>$SOCKET</string>
    <key>TANGO_HEALTH_TAILNET_URL</key><string>$TAILNET_URL</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$NODE_DIR</string>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/launchd.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null || { echo "generated plist is invalid: $PLIST" >&2; exit 1; }
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every 60 s); state and log in $STATE_DIR"
