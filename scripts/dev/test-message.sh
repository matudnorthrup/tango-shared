#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/test-message.sh --thread <thread-id> --message "What time is it?" [--wait-response] [--wait-state-receipt] [--timeout 30] [--cleanup]
  scripts/dev/test-message.sh --channel <channel-id> --message "Probe"
  scripts/dev/test-message.sh --agent <agent-id> [--slot 1|2|3] --message "Probe"

This is a thin wrapper around the TypeScript Discord test harness.
Use --help after the wrapper arguments to see the full CLI.
EOF
}

if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

# Source env overlays so the harness gets DISCORD_TOKEN and the correct
# TANGO_PROFILE for DB resolution (slot bot writes to wt-{N}'s DB).
set -a
if [ -f "$REPO_DIR/.env" ]; then source "$REPO_DIR/.env"; fi
if [ -f "$REPO_DIR/.env.slot" ]; then source "$REPO_DIR/.env.slot"; fi
set +a

exec node --import tsx "$REPO_DIR/scripts/testing/discord-test-harness.ts" "$@"
