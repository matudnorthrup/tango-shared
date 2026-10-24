#!/usr/bin/env python3
"""Submit one install outside the managed server tree; never retry a claimed job."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import uuid


def execute(root, command):
    # Survives crashes and explicit kickstart/re-bootstrap, unlike a process lock.
    # A new attempt requires a new job directory and explicit operator action.
    try:
        fd = os.open(root / 'claimed', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return 0
    with os.fdopen(fd, 'w') as f:
        f.write(str(time.time()))
        f.flush()
        os.fsync(f.fileno())
    result = subprocess.run(command)
    (root / 'result.json').write_text(json.dumps({'exitCode': result.returncode, 'finished': time.time()}))
    return result.returncode


def submit(command, root):
    label = 'com.tango.install-once.' + uuid.uuid4().hex
    plist = root / 'job.plist'
    plist.write_bytes(plistlib.dumps(dict(
        Label=label, ProgramArguments=[sys.executable, str(Path(__file__).resolve()),
                                      '--execute', str(root), *command],
        RunAtLoad=True, KeepAlive=False, ExitTimeOut=600,
        StandardOutPath=str(root / 'stdout.log'), StandardErrorPath=str(root / 'stderr.log'))))
    subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True)
    return label


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS required')
    if sys.argv[1:2] == ['--execute']:
        return execute(Path(sys.argv[2]), sys.argv[3:])
    if len(sys.argv) < 2:
        raise SystemExit('Usage: install-job.py SOURCE --target TARGET --plist PLIST [installer options]')
    root = Path(tempfile.mkdtemp(prefix='tango-install-job-')).resolve()
    command = [sys.executable, str(Path(__file__).with_name('install-app.py').resolve()), *sys.argv[1:]]
    label = submit(command, root)
    print(json.dumps({'job': f'gui/{os.getuid()}/{label}', 'evidence': str(root)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
