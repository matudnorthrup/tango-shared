#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/ModuleCache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/ModuleCache"
FLAGS=(--arch arm64 --arch x86_64)
if [ "${TANGO_SWIFT_DISABLE_SANDBOX:-0}" = 1 ]; then FLAGS+=(--disable-sandbox); fi
swift build "${FLAGS[@]}" --package-path "$ROOT" -c release -debug-info-format none
BIN="$(swift build "${FLAGS[@]}" --package-path "$ROOT" -c release -debug-info-format none --show-bin-path)"
mkdir -p "$ROOT/build"
BUILD_DIR="$(mktemp -d "$ROOT/build/client.XXXXXX")"
APP="$BUILD_DIR/Tango.app"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN/Tango" "$APP/Contents/MacOS/Tango"
/usr/bin/python3 - "$ROOT" "$APP" <<'PY'
import json, pathlib, plistlib, sys
root, app = map(pathlib.Path, sys.argv[1:])
version = (root/'VERSION').read_text().strip() if (root/'VERSION').exists() else json.loads((root.parent.parent/'package.json').read_text()).get('version', '0.1.0')
info = dict(CFBundleExecutable='Tango', CFBundleIdentifier='com.tango.client', CFBundleName='Tango',
    CFBundlePackageType='APPL', CFBundleShortVersionString=version,
    CFBundleVersion=version, LSUIElement=True,
    LSMinimumSystemVersion='15.0', NSHighResolutionCapable=True, TangoClientOnly=True,
    NSMicrophoneUsageDescription='Dictate a reply to your open desk conversation.')
with (app/'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
PY
codesign -s - --force --entitlements "$ROOT/Resources/Tango.entitlements" "$APP"
codesign --verify --deep --strict "$APP"
echo "Client candidate only. Do not use the host installer." >&2
echo "$APP"
