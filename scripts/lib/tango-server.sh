#!/usr/bin/env bash
# Resolve the compiled CLI from the selected checkout, never a global install.
_ts_cli() {
  local repo
  repo="${TANGO_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  "${TANGO_NODE_BIN:-node}" "$repo/packages/server/dist/main.js" "$@"
}
# 0: managed by Tango Server. 1: not managed (legacy path). When the server can't be asked (exit 3),
# fail closed for a service the service list declares managed: a legacy start could run a second copy.
# TS_UNAVAILABLE=skip (the healthcheck) treats it as managed and skips instead of exiting.
_ts_declared_managed() {
  local repo profile
  repo="${TANGO_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  profile="${TANGO_PROFILE_DIR:-$HOME/.tango/profiles/${TANGO_PROFILE:-default}}"
  cat "$repo/config/services.yaml" "$profile/config/services.yaml" 2>/dev/null \
    | grep -E "(\"id\": \"$1\"|id: $1,)" | grep -q "managed"
}
ts_managed() {
  _ts_cli managed "$1" 2>/dev/null
  local rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 3 ] || return 1
  _ts_declared_managed "$1" || return 1
  if [ "${TS_UNAVAILABLE:-}" = "skip" ]; then return 0; fi
  echo "Tango Server manages $1 but can't be reached; not falling back to a second copy." >&2
  exit 3
}
ts_restart() { _ts_cli restart "$@"; }
ts_start() { _ts_cli start "$@"; }
ts_stop() { _ts_cli stop "$@"; }
ts_status() { _ts_cli status "$@"; }
