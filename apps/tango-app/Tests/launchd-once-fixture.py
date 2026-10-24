#!/usr/bin/env python3
"""Real launchd proof: successful and failed jobs each execute their payload once."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('job', Path(__file__).parents[1] / 'scripts/install-job.py')
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)
if sys.platform != 'darwin':
    raise SystemExit('macOS required')
root = Path(tempfile.mkdtemp(prefix='tango-once-fixture-')).resolve()
jobs = []
try:
    for code in (0, 7):
        directory = root / str(code)
        directory.mkdir()
        payload = directory / 'payload.py'
        payload.write_text('import pathlib,sys\np=pathlib.Path(__file__).with_name("invocations")\nwith p.open("a") as f: f.write("run\\n")\nsys.exit(' + str(code) + ')\n')
        label = job.submit([sys.executable, str(payload)], directory)
        jobs.append((f'gui/{os.getuid()}/{label}', directory, code))
    deadline = time.monotonic() + 30
    while not all((d / 'result.json').exists() for _, d, _ in jobs):
        if time.monotonic() > deadline: raise RuntimeError('job timeout')
        time.sleep(.2)
    # Beyond launchd's default ten-second throttle, for both exit statuses.
    time.sleep(12)
    for label, directory, code in jobs:
        output = subprocess.check_output(['/bin/launchctl', 'print', label], text=True)
        (directory / 'launchd-before.txt').write_text(output)
        assert '\truns = 1\n' in output, output
        assert f'last exit code = {code}' in output, output
        assert (directory / 'invocations').read_text() == 'run\n'
        assert json.loads((directory / 'result.json').read_text())['exitCode'] == code
        # Even an accidental explicit kickstart cannot repeat the payload.
        subprocess.run(['/bin/launchctl', 'kickstart', label], check=True)
    time.sleep(2)
    for label, directory, code in jobs:
        assert (directory / 'invocations').read_text() == 'run\n'
    print(json.dumps({'ok': True, 'evidence': str(root), 'exitCodes': [0, 7], 'runsBeforeKickstart': [1, 1], 'payloadCountsAfterKickstart': [1, 1]}))
finally:
    for label, _, _ in jobs:
        subprocess.run(['/bin/launchctl', 'bootout', label], capture_output=True)
