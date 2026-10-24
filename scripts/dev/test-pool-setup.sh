#!/usr/bin/env bash
# Prepares a machine to take test runs from the test pool (see test-pool.mjs): installs this machine's Node version
# under ~/tango-pool/node there, and makes the mirrors and isolated home directories. Safe to re-run.
#   scripts/dev/test-pool-setup.sh me@100.x.y.z
set -euo pipefail
host="${1:?usage: test-pool-setup.sh <ssh destination>}"
version="$(node --version)"
ssh -o BatchMode=yes "$host" /bin/bash -s -- "$version" <<'REMOTE'
set -euo pipefail
version="$1"; P="$HOME/tango-pool"
mkdir -p "$P/mirrors" "$P/homes"; rm -rf "$P/home"
if [ "$("$P/node/bin/node" --version 2>/dev/null)" != "$version" ]; then
  arch="$(uname -m)"; [ "$arch" = x86_64 ] && arch=x64
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-darwin-$arch.tar.gz" | tar -xz -C "$tmp"
  rm -rf "$P/node" && mv "$tmp/node-$version-darwin-$arch" "$P/node" && rmdir "$tmp"
fi
echo "$(hostname -s): node $("$P/node/bin/node" --version), $(df -h "$P" | awk 'NR==2 {print $4}') free"
REMOTE
