#!/usr/bin/env bash
# setup-git-hooks.sh — point git at the repo's tracked hooks (.githooks),
# enabling the pre-push privacy gate. Run once per clone.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "setup-git-hooks: not inside a git repository" >&2
  exit 2
}

git -C "$ROOT" config core.hooksPath .githooks
chmod +x "$ROOT/.githooks/pre-push" 2>/dev/null || true

echo "setup-git-hooks: core.hooksPath -> .githooks (pre-push privacy gate active)."
echo "  Denylist resolves from TANGO_PRIVACY_DENYLIST_FILE or the profile-layer default."
