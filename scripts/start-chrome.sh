#!/bin/bash
# Tango browser automation - starts Chrome with persistent profile on CDP port 9222
# NOTE: Must be launched from Terminal with Full Disk Access granted

PROFILE_DIR="$HOME/.tango/browser/user-data"
mkdir -p "$PROFILE_DIR"

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-client-side-phishing-detection \
  --disable-default-apps \
  --disable-hang-monitor \
  --disable-popup-blocking \
  --disable-prompt-on-repost \
  --disable-sync \
  --disable-translate \
  --metrics-recording-only \
  --safebrowsing-disable-auto-update \
  --password-store=basic \
  "$@"
