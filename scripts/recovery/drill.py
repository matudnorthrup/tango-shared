#!/usr/bin/env python3
"""Crash an isolated synthetic backup source and validate restoration on the mini."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid
import loom_backup as b


def drill(config, evidence):
    c = b.load_config(config)
    # A live database must never pass this guard.
    with contextlib.closing(b.db_open(c['db'])) as db:
        ids = [r[0] for r in db.execute('SELECT id FROM threads')]
        if ids != ['recovery-fixture']:
            raise ValueError('Drill requires the single synthetic thread from drill-fixture.mjs')
        if db.execute('SELECT title FROM threads').fetchone()[0] != 'Synthetic recovery drill':
            raise ValueError('Not a synthetic fixture')
    evidence = Path(evidence)
    evidence.mkdir(parents=True, exist_ok=False)
    script = Path(__file__).with_name('loom_backup.py')
    out = (evidence / 'source.stdout').open('w')
    err = (evidence / 'source.stderr').open('w')
    child = subprocess.Popen([sys.executable, str(script), 'service', str(Path(config).resolve())],
                             stdout=out, stderr=err, start_new_session=True)
    began = time.monotonic()
    try:
        # Bounded test, not a background monitor. Exercise two probe cycles and
        # give the last marker a sync interval before simulating sudden source loss.
        while time.monotonic() - began < 45:
            if child.poll() is not None:
                raise RuntimeError('Fixture backup source exited; inspect source.stderr')
            time.sleep(1)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        out.close()
        err.close()
    failed_at = time.time()
    with contextlib.closing(b.db_open(c['db'])) as db:
        final_marker = dict(db.execute('SELECT * FROM loom_recovery_marker WHERE id=1').fetchone())
    destination = c['destination'] + '/drill-' + uuid.uuid4().hex
    started = time.monotonic()
    restored = json.loads(b.remote(c, ['python3', c['remote_script'], 'restore', c['remote_litestream'],
                                     c['destination'] + '/replica', c['destination'] + '/bundles', destination]))
    checked = json.loads(b.remote(c, ['python3', str(Path(c['remote_script']).with_name('check-drill.py')), destination]))
    rpo = max(0, final_marker['at'] - restored['database_marker']['at'])
    result = {'fixture': 'single synthetic Loom thread; no production data',
              'litestream': b.LITESTREAM_VERSION, 'abrupt_source_stop': True,
              'database_rpo_seconds': rpo,
              'configured_database_sync_interval_seconds': 5,
              'rpo_caveat': 'Observed marker loss only; final sync-window writes are not tested. Healthy database RPO is about 5 seconds plus transfer latency.',
              'final_marker_matches': final_marker['token'] == restored['database_marker']['token'],
              'file_recovery_loss_window_seconds': max(0, failed_at - restored['file_recovery_point']),
              'restore_on_mini_seconds': restored['rto_seconds'],
              'restore_and_validate_wall_seconds': time.monotonic() - started,
              'integrity': restored['integrity'], 'foreign_key_violations': restored['foreign_key_violations'],
              'snapshot_bytes': Path(c['db']).stat().st_size, 'checks': checked,
              'source_health': b.read_json(Path(c['spool']) / 'health.json')}
    b.atomic_json(evidence / 'result.json', result)
    if not result['source_health']['ok'] or rpo > 60 or result['restore_and_validate_wall_seconds'] > 1800:
        raise ValueError('Recovery objective missed; inspect result.json')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('config')
    p.add_argument('evidence', help='new local evidence directory')
    a = p.parse_args()
    drill(a.config, a.evidence)
