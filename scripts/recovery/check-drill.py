#!/usr/bin/env python3
"""Validate invented drill data only; never invokes providers or evaluates triggers."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
started = time.monotonic()
manifest = json.loads((root / 'bundle/manifest.json').read_text())
report = json.loads((root / 'restore-report.json').read_text())
with sqlite3.connect(root / 'sandbox.sqlite') as db:
    assert db.execute("SELECT text FROM runs WHERE thread_id='recovery-fixture' AND status='queued'").fetchone()[0] == 'synthetic pending input'
    assert db.execute("SELECT status FROM triggers WHERE id='fixture-trigger'").fetchone()[0] == 'waiting'
    path = db.execute("SELECT path FROM attachments WHERE id='fixture-attachment'").fetchone()[0]
attachment = next(e for e in manifest['files'] if e.get('source') == path)
assert hashlib.sha256((root / 'bundle' / attachment['path']).read_bytes()).hexdigest() == attachment['sha256']
assert (root / 'bundle' / attachment['path']).read_bytes().startswith(b'\x89PNG')
thread = next(t for t in manifest['threads'] if t['id'] == 'recovery-fixture')
assert thread['complete'] and thread['checkpoint']
repo = root / 'repositories' / '0'
content = subprocess.check_output(['git', '-C', str(repo), 'show', thread['checkpoint'] + ':proof.txt'], text=True)
assert content == 'synthetic checkpoint\n'
transcript = next(e for e in manifest['files'] if e['path'].startswith('transcripts/'))
assert json.loads((root / 'bundle' / transcript['path']).read_text())['message']['content'] == 'synthetic recovery marker'
assert report['tools_started'] is False and report['triggers_started'] is False
result = {'pending_input': 'verified', 'waiting_trigger': 'verified', 'attachment': 'hash verified',
          'checkpoint': 'object and contents verified', 'transcript': 'synthetic record verified',
          'providers_invoked': 0, 'triggers_fired': 0, 'validation_seconds': time.monotonic() - started}
print(json.dumps(result))
