#!/usr/bin/env bash
# Tango full-stack startup entrypoint.
#
# Operators should keep running this script. The service layout is defined by
# config/defaults/startup.yaml and can be overlaid by the active profile at:
#
#   ~/.tango/profiles/<profile>/config/startup.yaml
#
# Profile-local startup hooks are discovered only from:
#
#   ~/.tango/profiles/<profile>/scripts/startup.d/*.sh
#
# Useful commands:
#
#   scripts/startup.sh --dry-run
#   scripts/startup.sh --health
#   scripts/startup.sh --only discord
#   scripts/startup.sh --skip owntracks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${TANGO_NODE_BIN:-}"

if [ -n "$NODE_BIN" ] && [ ! -x "$NODE_BIN" ]; then
  echo "Configured TANGO_NODE_BIN is not executable: $NODE_BIN" >&2
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "No Node runtime found. Install Node 22+ or set TANGO_NODE_BIN." >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/startup-runner.mjs" "$@"
