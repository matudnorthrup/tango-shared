#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 /absolute/path/to/tango-server-entry.js [/absolute/path/to/node]" >&2
  exit 2
fi
SERVER="$1"
NODE="${2:-$(command -v node)}"
case "$SERVER" in /*) ;; *) echo 'Server entry must be an absolute path.' >&2; exit 2;; esac
case "$NODE" in /*) ;; *) echo 'Node must be an absolute path.' >&2; exit 2;; esac
[ -f "$SERVER" ] || { echo 'Server entry does not exist.' >&2; exit 2; }
[ -x "$NODE" ] || { echo 'Node executable does not exist.' >&2; exit 2; }
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/ModuleCache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/ModuleCache"
SWIFT_FLAGS=()
if [ "${TANGO_SWIFT_DISABLE_SANDBOX:-0}" = 1 ]; then SWIFT_FLAGS+=(--disable-sandbox); fi
swift build ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"} --package-path "$ROOT" -c release -debug-info-format none
BIN="$(swift build ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"} --package-path "$ROOT" -c release -debug-info-format none --show-bin-path)"
# Never rebuild an executable bundle in place: a prior build may be running.
mkdir -p "$ROOT/build"
BUILD_DIR="$(mktemp -d "$ROOT/build/candidate.XXXXXX")"
APP="$BUILD_DIR/Tango.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Library/LaunchAgents"
cp "$BIN/Tango" "$APP/Contents/MacOS/Tango"
# A private copy gives SMAppService a real bundle-relative executable, not a
# symlink escaping the signed bundle. Server code stays at the supplied path.
cp "$NODE" "$APP/Contents/MacOS/tango-server-node"
/usr/bin/python3 - "$ROOT" "$APP" "$SERVER" <<'PY'
import json, os, pathlib, plistlib, sys
root, app, server = map(pathlib.Path, sys.argv[1:])
version_file = root / 'VERSION'
version = version_file.read_text().strip() if version_file.exists() else json.loads((root.parent.parent / 'package.json').read_text()).get('version', '0.1.0')
info = dict(CFBundleExecutable='Tango', CFBundleIdentifier='com.tango.app', CFBundleName='Tango', CFBundlePackageType='APPL', CFBundleShortVersionString=version, CFBundleVersion=version, LSUIElement=True, LSMinimumSystemVersion='15.0', NSHighResolutionCapable=True,
    NSMicrophoneUsageDescription='Hold the push-to-talk shortcut to dictate a reply to your open desk thread.',
    # Without a usage string macOS denies LAN connections from the server tree silently instead of asking.
    NSLocalNetworkUsageDescription='Tango Server and its agents reach devices on your local network, such as the printer monitor reaching the printer.')
with (app / 'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
with (root / 'Resources/com.tango.server.plist').open('rb') as f: agent = plistlib.load(f)
agent['WorkingDirectory'] = os.environ.get('TANGO_REPO_DIR') or str((server.parent / '../../..').resolve())
agent['BundleProgram'] = 'Contents/MacOS/tango-server-node'
agent['ProgramArguments'] = [agent['BundleProgram'], str(server), 'run']
# launchd gives agents a bare PATH: carry the builder's PATH so managed services find node and user CLIs.
agent['EnvironmentVariables'] = {'PATH': os.environ.get('TANGO_SERVER_PATH') or os.environ.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')}
logs = pathlib.Path.home() / '.tango' / 'server'
agent['StandardOutPath'] = str(logs / 'launchd.out.log')
agent['StandardErrorPath'] = str(logs / 'launchd.err.log')
with (app / 'Contents/Library/LaunchAgents/com.tango.server.plist').open('wb') as f: plistlib.dump(agent, f)
PY
# No --deep: re-signing the copied Node renames its code identity, and macOS then drops
# the Local Network allowance granted to that Node, blocking the server tree from the LAN.
# Verify the input and compare the copy after signing: preserve Node's identity.
codesign --verify --strict "$NODE"
codesign -s - --force --entitlements "$ROOT/Resources/Tango.entitlements" "$APP"
cmp "$NODE" "$APP/Contents/MacOS/tango-server-node"
codesign --verify --deep --strict "$APP"
echo "Install only with scripts/install-app.py; never copy over an installed app." >&2
echo "$APP"
