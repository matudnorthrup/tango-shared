#!/usr/bin/env python3
"""Health-tick entry point, installed with namespace_guard.py outside the replica."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

import namespace_guard as guard


def tick(config, state, guard_state, backup_script, event_command):
    # The canary check is independent of the backup executable and health cache.
    try:
        with guard_state.with_suffix(guard_state.suffix + '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            identity = guard.check(guard.read_json(config), guard_state, event_command)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as e:
        identity = {'ok': False, 'alerts': ['namespace_guard_unavailable'], 'error': str(e)}
    try:
        p = subprocess.run([sys.executable, str(backup_script), 'status', str(config)],
                           capture_output=True, text=True, timeout=15)
        status = json.loads(p.stdout)
        failed = p.returncode != 0
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        failed, status = True, {'alerts': ['monitor_failed'], 'error': str(e)}
    # The latched identity incident has its own delivery. Generic recoveries must
    # never resolve it or emit a second copy of the same incident.
    if 'namespace_guard_unavailable' in identity['alerts']:
        failed = True
        status.setdefault('alerts', []).append('namespace_guard_unavailable')
        status['guard_error'] = identity.get('error')
    previous = guard.read_json(state) if state.exists() else None
    current = {'failed': failed, 'alerts': sorted(status.get('alerts', []))}
    if current != previous:
        args = [event_command, '--strict', '--source', 'loom-recovery', '--job', 'launchd:com.tango.loom-recovery',
                '--kind', 'recovery.health', '--severity', 'error' if failed else 'recovery',
                '--title', 'Loom recovery health', '--detail', json.dumps(status)]
        if not failed:
            args += ['--resolves-kind', 'recovery.health', '--resolves-title', 'Loom recovery health']
        subprocess.run(args, check=True, capture_output=True, text=True, timeout=20)
        guard.save(state, current)
    status['namespace_guard'] = identity
    status['ok'] = not failed and identity['ok']
    return status


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('config', type=Path)
    p.add_argument('--state', required=True, type=Path)
    p.add_argument('--guard-state', required=True, type=Path)
    p.add_argument('--backup-script', required=True, type=Path)
    p.add_argument('--event-command', required=True)
    a = p.parse_args()
    with a.state.with_suffix(a.state.suffix + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = tick(a.config, a.state, a.guard_state, a.backup_script, a.event_command)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
