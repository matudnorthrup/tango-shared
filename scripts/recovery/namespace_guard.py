#!/usr/bin/env python3
"""External, explicitly enrolled recovery namespace guard. Never repairs its target."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import time

CANARY = '.recovery-identity'
TITLE = 'Recovery namespace identity changed'
KIND = 'recovery.namespace_identity'
# Sent over SSH from the monitoring host: missing remote tools cannot disable it.
REMOTE = r'''
import hashlib, json, os, pathlib, sys
p = json.loads(sys.argv[1])
root = pathlib.Path(p['destination'])
def regular_hash(path):
    path = pathlib.Path(path)
    if path.is_symlink() or not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()
root_ok = root.is_dir() and not root.is_symlink()
canary = root / '.recovery-identity'
if p.get('create'):
    if not root_ok:
        raise ValueError('Enrollment requires an existing regular destination directory')
    fd = os.open(canary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(p['create'])
        f.flush()
        os.fsync(f.fileno())
print(json.dumps({'root_exists': root_ok,
    'identity_hash': regular_hash(canary) if root_ok else None,
    'tools': {path: regular_hash(path) for path in p['tools']},
    'manifest_hash': regular_hash(root / 'bundles' / p['marker']['id'] / 'manifest.json') if root_ok else None}))
'''


def read_json(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    temp = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        with temp.open('x') as f:
            json.dump(value, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def target(c):
    root = c.get('remote_root')
    result = {'ssh': c['ssh'], 'destination': c['destination'],
              'tools': [c.get('remote_script') or str(Path(root) / 'bin/loom_backup.py'),
                        c.get('remote_litestream') or str(Path(root) / 'bin/litestream')]}
    if not re.fullmatch(r'[\w.@:-]+', result['ssh']) or result['ssh'].startswith('-'):
        raise ValueError('Invalid SSH target')
    if any(not Path(p).is_absolute() for p in [result['destination']] + result['tools']):
        raise ValueError('Guard paths must be absolute')
    return result


def marker(c):
    """Read the committed local last-good pointer, never a pending publication."""
    spool = Path(c['spool'])
    for _ in range(3):
        ident = read_json(spool / 'last-good.json')['id']
        if not isinstance(ident, str) or not re.fullmatch(r'[0-9a-f]{32}', ident):
            raise ValueError('Invalid last-good bundle id')
        try:
            digest = hashlib.sha256((spool / ident / 'manifest.json').read_bytes()).hexdigest()
        except FileNotFoundError:
            # Publication advances the pointer before pruning the old bundle.
            # A missing obsolete manifest says nothing about namespace identity.
            if read_json(spool / 'last-good.json')['id'] != ident:
                continue
            raise
        return {'id': ident, 'manifest_hash': digest}
    raise BlockingIOError('Last-good publication kept advancing; retry next tick')


def observe(binding, last_good, create=None):
    payload = dict(binding, marker=last_good)
    if create:
        payload['create'] = create
    args = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=1',
            binding['ssh'], shlex.join(['python3', '-c', REMOTE, json.dumps(payload)])]
    p = subprocess.run(args, check=True, capture_output=True, text=True, timeout=40)
    result = json.loads(p.stdout)
    if not isinstance(result.get('root_exists'), bool) or set(result.get('tools', {})) != set(binding['tools']):
        raise ValueError('Malformed guard observation')
    for value in [result.get('identity_hash'), result.get('manifest_hash'), *result['tools'].values()]:
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)):
            raise ValueError('Malformed guard hash')
    return result


def validate_location(c, state_path):
    # Also reject unsafe local/same-host installations, before writing anything.
    root = Path(c.get('remote_root') or c['destination']).resolve()
    for path in [state_path.resolve(), Path(__file__).resolve()]:
        if path == root or root in path.parents:
            raise ValueError('Guard code and state must live outside the protected root')


def enroll(c, state_path):
    validate_location(c, state_path)
    if state_path.exists():
        raise ValueError('Guard state already exists; enrollment never overwrites it')
    binding, last_good = target(c), marker(c)
    before = observe(binding, last_good)
    if not before['root_exists'] or not all(before['tools'].values()) or before['manifest_hash'] != last_good['manifest_hash']:
        raise ValueError('Enrollment needs existing tools and a verified last-good manifest')
    identity = secrets.token_hex(32)
    expected = hashlib.sha256(identity.encode()).hexdigest()
    observed = observe(binding, last_good, create=identity)
    if observed['identity_hash'] != expected or observed['tools'] != before['tools'] or observed['manifest_hash'] != last_good['manifest_hash']:
        raise ValueError('Enrollment changed during observation; inspect without recreating the canary')
    state = {'version': 1, 'target': binding, 'identity_hash': expected, 'tools': observed['tools'],
             'last_good_marker': last_good, 'last_seen_at': time.time(), 'incident': None, 'notified': False}
    with state_path.open('x') as f:
        json.dump(state, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    return state


def check(c, state_path, event_command=None):
    validate_location(c, state_path)
    state = read_json(state_path)
    if state.get('version') != 1:
        raise ValueError('Unsupported guard state')
    now, failures, observation = time.time(), [], None
    manifest_deferred = False
    if target(c) != state['target']:
        failures.append('configured_target_changed')
    else:
        try:
            last_good = marker(c)
        except BlockingIOError as e:
            return {'ok': False, 'alerts': ['namespace_guard_unavailable'], 'error': str(e), 'at': now}
        except (OSError, ValueError, KeyError) as e:
            failures.append('last_good_marker_unavailable')
            last_good = state['last_good_marker']
        try:
            observation = observe(state['target'], last_good)
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            # A transport failure is not evidence of deletion. Keep an existing
            # latch, but do not invent one from a timeout or SSH failure.
            if not state['incident'] and not failures:
                return {'ok': False, 'alerts': ['namespace_guard_unavailable'], 'error': str(e), 'at': now}
            failures.append('observation_unavailable')
        if observation and observation['manifest_hash'] != last_good['manifest_hash']:
            # Remote retention precedes the local pointer update. Recheck under
            # the publisher's lock before attributing a missing manifest to loss.
            # If publication is active, still check identity and tools this tick.
            try:
                with (Path(c['spool']) / 'bundle.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    last_good = marker(c)
                    observation = observe(state['target'], last_good)
            except BlockingIOError:
                manifest_deferred = True
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
                return {'ok': False, 'alerts': ['namespace_guard_unavailable'], 'error': str(e), 'at': now}
        if observation:
            if not observation['root_exists']:
                failures.append('root_missing_or_symlink')
            if observation['identity_hash'] != state['identity_hash']:
                failures.append('identity_missing_or_replaced')
            if observation['tools'] != state['tools']:
                failures.append('tools_missing_or_changed')
            if not manifest_deferred and observation['manifest_hash'] != last_good['manifest_hash']:
                failures.append('last_good_manifest_missing_or_changed')
    if failures and not state['incident']:
        state['incident'] = {'first_failed_at': now, 'last_seen_at': state['last_seen_at'],
                             'last_good_marker': state['last_good_marker'], 'failures': failures,
                             'observation': observation}
    if not failures and not state['incident'] and not manifest_deferred:
        state.update(last_seen_at=now, last_good_marker=last_good)
    save(state_path, state)  # Latch before attempting delivery; retry until accepted.
    if state['incident'] and not state['notified'] and event_command:
        subprocess.run([event_command, '--strict', '--source', 'loom-recovery', '--job', 'loom:recovery',
                        '--kind', KIND, '--severity', 'critical', '--title', TITLE,
                        '--detail', json.dumps(dict(state['incident'], target=state['target'])),
                        '--data', json.dumps({'identity': 'loom-recovery-namespace', 'notifyDetail': True})],
                       check=True, capture_output=True, text=True, timeout=20)
        state['notified'] = True
        save(state_path, state)
    return {'ok': not state['incident'], 'at': now,
            'alerts': ['namespace_identity_changed'] if state['incident'] else [],
            'incident': state['incident'], 'last_seen_at': state['last_seen_at']}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['enroll', 'check'])
    parser.add_argument('config', type=Path)
    parser.add_argument('state', type=Path)
    parser.add_argument('--event-command', help='Absolute tango-event executable; omitted for scratch checks')
    a = parser.parse_args()
    try:
        # The monitor and state belong on the source host, outside the protected
        # remote namespace. Lock both enrollment and checks, including delivery.
        with a.state.with_suffix(a.state.suffix + '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            c = read_json(a.config)
            result = enroll(c, a.state) if a.command == 'enroll' else check(c, a.state, a.event_command)
        print(json.dumps(result))
        return 0 if result.get('ok', True) else 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as e:
        print(json.dumps({'ok': False, 'alerts': ['namespace_guard_unavailable'], 'error': str(e)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
