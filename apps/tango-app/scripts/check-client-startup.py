#!/usr/bin/env python3
"""Run after swift test and build-client.sh, passing the candidate .app path."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
app = Path(sys.argv[1]).resolve()
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info.get('TangoClientOnly') is True
assert not (app / 'Contents/Library/LaunchAgents').exists()
assert not (app / 'Contents/MacOS/tango-server-node').exists()
with tempfile.TemporaryDirectory(prefix='tango-client-home-') as directory:
    home = Path(directory)
    env = dict(os.environ, HOME=directory, CFFIXED_USER_HOME=directory)
    # The same factory gate used by TangoApp.init; spies must see zero host
    # construction/token access and zero retirement/server operations.
    subprocess.run(['swift', 'test', '--package-path', str(root), '--skip-build',
                    '--filter', 'AppModeTests'], env=env, check=True)
    # Exercise the packaged executable's real mode selection and migration gate.
    result = subprocess.run([str(app / 'Contents/MacOS/Tango'), '--retire-login-item'],
                            env=env, check=True, capture_output=True, text=True, timeout=15)
    assert 'Client mode: no server login item operation' in result.stdout
    assert not (home / '.tango').exists()
    assert not (home / 'Library/LaunchAgents').exists()
print('PASS: client startup gates host operations in an isolated home; bundle has no server payload.')
