#!/usr/bin/env bash
# Update both live source checkouts and build every workspace before any restart.
set -euo pipefail

if [ "$#" -ne 0 ] && [ "$#" -ne 2 ]; then
  echo "Usage: $0 [operator-checkout live-checkout]" >&2
  exit 2
fi
operator="${1:-$HOME/GitHub/tango-worktrees/operator}"
live="${2:-$HOME/GitHub/tango-worktrees/live}"

# Preflight both before changing either. Never stash, reset, or discard local work.
for checkout in "$operator" "$live"; do
  git -C "$checkout" rev-parse --show-toplevel >/dev/null
  if [ -n "$(git -C "$checkout" status --porcelain)" ]; then
    echo "Local changes in $checkout; update stopped. Preserve/reconcile them first." >&2
    exit 1
  fi
  if [ ! -f "$checkout/package.json" ]; then
    echo "Missing workspace root: $checkout" >&2
    exit 1
  fi
done

# Pin one revision for both copies, even if origin/main advances during the build.
for checkout in "$operator" "$live"; do
  git -C "$checkout" fetch origin main
done
revision="$(git -C "$operator" rev-parse 'origin/main^{commit}')"
git -C "$live" cat-file -e "$revision^{commit}"

# A clean tree can still contain a committed local hotfix. Refuse to leave it
# behind, even when another ref happens to retain it: it needs reconciliation.
for checkout in "$operator" "$live"; do
  if ! git -C "$checkout" merge-base --is-ancestor HEAD "$revision"; then
    echo "Local commits in $checkout are not included in $revision; update stopped." >&2
    exit 1
  fi
done

for checkout in "$operator" "$live"; do
  echo "Updating $checkout to $revision"
  git -C "$checkout" checkout --no-overwrite-ignore --detach "$revision"
  # Dependencies must already be installed. A failure stops before any restart;
  # leave the checkout in place for diagnosis rather than resetting local state.
  (cd "$checkout" && npm run build)
  echo "Built $checkout at $revision"
done

echo "Both checkouts built. Services were not restarted."
