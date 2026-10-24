"""Exercise client packaging without a compiler, Node, or server installation."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

class ClientBuildTests(unittest.TestCase):
    def test_client_bundle_has_only_gui_and_is_universal_requested(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(source / 'scripts/build-client.sh', root / 'scripts/build-client.sh')
            shutil.copytree(source / 'Resources', root / 'Resources')
            (root / 'VERSION').write_text('0.0.0')
            binaries = root / 'fake-bin'; binaries.mkdir()
            (binaries / 'Tango').write_text('inert GUI')
            (binaries / 'swift').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$BUILD_LOG"\nprintf "%s\\n" "$FAKE_BIN"\n')
            (binaries / 'codesign').write_text('#!/bin/sh\nexit 0\n')
            for name in ['swift', 'codesign']:
                (binaries / name).chmod(0o755)
            env = dict(os.environ, PATH=f'{binaries}:/usr/bin:/bin', FAKE_BIN=str(binaries), BUILD_LOG=str(root/'build.log'))
            result = subprocess.run(['bash', str(root/'scripts/build-client.sh')], env=env, check=True, capture_output=True, text=True)
            app = Path(result.stdout.strip().splitlines()[-1])
            self.assertEqual(sorted(str(p.relative_to(app)) for p in app.rglob('*') if p.is_file()),
                             ['Contents/Info.plist', 'Contents/MacOS/Tango'])
            info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
            self.assertTrue(info['TangoClientOnly'])
            self.assertEqual(info['CFBundleIdentifier'], 'com.tango.client')
            self.assertNotIn('server', str(info).lower())
            self.assertIn('--arch arm64 --arch x86_64', (root/'build.log').read_text())

if __name__ == '__main__':
    unittest.main()
