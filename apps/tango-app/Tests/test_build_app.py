"""Exercise the real build script with inert compiler/signing boundaries."""
import os
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest


class BuildAppTests(unittest.TestCase):
    def test_embedded_program_arguments_survive_bundle_move(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(source / 'scripts/build-app.sh', root / 'scripts/build-app.sh')
            shutil.copytree(source / 'Resources', root / 'Resources')
            (root / 'VERSION').write_text('0.0.0')
            binaries = root / 'fake-bin'
            binaries.mkdir()
            (binaries / 'Tango').write_text('inert app')
            (binaries / 'swift').write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_BIN"\n')
            (binaries / 'codesign').write_text('''#!/usr/bin/python3
import json, os, sys
with open(os.environ['SIGN_LOG'], 'a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
''')
            (binaries / 'node').write_text('#!/bin/sh\nexit 0\n')
            for name in ['swift', 'codesign', 'node']:
                (binaries / name).chmod(0o755)
            server = root / 'server.js'
            server.write_text('// fixture')
            env = dict(os.environ, PATH=f'{binaries}:/usr/bin:/bin', FAKE_BIN=str(binaries), SIGN_LOG=str(root / 'sign.jsonl'), TANGO_REPO_DIR=str(root / 'server-repo'))
            result = subprocess.run(['bash', str(root / 'scripts/build-app.sh'), str(server), str(binaries / 'node')], env=env, check=True, capture_output=True, text=True)
            app = Path(result.stdout.strip().splitlines()[-1])
            with (app / 'Contents/Info.plist').open('rb') as stream:
                self.assertIn('NSMicrophoneUsageDescription', plistlib.load(stream))
            calls = [json.loads(line) for line in (root / 'sign.jsonl').read_text().splitlines()]
            signing = [args for args in calls if '--force' in args]
            self.assertEqual(len(signing), 1)
            self.assertNotIn('--deep', signing[0])
            self.assertEqual(signing[0][-1], str(app))
            entitlement_path = signing[0][signing[0].index('--entitlements') + 1]
            with open(entitlement_path, 'rb') as stream:
                self.assertEqual(plistlib.load(stream), {'com.apple.security.device.audio-input': True})
            self.assertEqual((app / 'Contents/MacOS/tango-server-node').read_bytes(), (binaries / 'node').read_bytes())
            installed = root / 'Installed.app'
            app.rename(installed)
            with (installed / 'Contents/Library/LaunchAgents/com.tango.server.plist').open('rb') as stream:
                agent = plistlib.load(stream)
            self.assertEqual(agent['ProgramArguments'], ['Contents/MacOS/tango-server-node', str(server), 'run'])
            self.assertEqual(agent['BundleProgram'], agent['ProgramArguments'][0])
            self.assertEqual(agent['WorkingDirectory'], str(root / 'server-repo'))
            self.assertTrue((installed / agent['BundleProgram']).is_file())


if __name__ == '__main__':
    unittest.main()
