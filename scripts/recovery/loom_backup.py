#!/usr/bin/env python3
"""Standalone Loom recovery tooling. No coordinator, provider or trigger is started."""
import argparse
import contextlib
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

VERSION = 2
GIB = 1024**3
# Below the warning floor the mini needs attention; only the pause floor (where
# replication would actually fail) holds Loom admissions.
DEFAULT_WARN_FREE = 20 * GIB
DEFAULT_PAUSE_FREE = 5 * GIB
# Generated destination names under <remote_root>/destinations; nothing else is ever pruned.
DESTINATION_NAME = re.compile(r'\d{8}T\d{6}Z')
LITESTREAM_VERSION = '0.5.17'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']
EXCLUSIONS = ['credentials, account homes, browser state', 'ignored worktree files and dependencies',
              'uncommitted edits newer than existing Loom checkpoints',
              'native provider resume (requires a later portability adapter)',
              'owner.sqlite process ownership (must not be restored)', 'offsite recovery']


def run(args, **kw):
    return subprocess.run([str(x) for x in args], check=True, capture_output=True,
                          text=True, timeout=kw.pop('timeout', 300), **kw).stdout.strip()


def remote(c, args):
    return run(SSH + [c['ssh'], shlex.join([str(a) for a in args])])


def read_json(p):
    return json.loads(Path(p).read_text())


def atomic_json(p, value):
    p = Path(p)
    temp = p.with_name(p.name + '.' + uuid.uuid4().hex + '.tmp')
    with temp.open('x') as f:
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, p)


def digest(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def db_open(p, write=False):
    db = sqlite3.connect(Path(p).resolve().as_uri() + ('?mode=rw' if write else '?mode=ro'), uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def rows(db, table):
    return [dict(r) for r in db.execute('SELECT * FROM "' + table + '"')]


def check_db(p):
    with contextlib.closing(db_open(p)) as db:
        integrity = [r[0] for r in db.execute('PRAGMA integrity_check')]
        foreign = [list(r) for r in db.execute('PRAGMA foreign_key_check')]
        if integrity != ['ok'] or foreign:
            raise ValueError('SQLite integrity/foreign-key check failed')
        return {'integrity': 'ok', 'foreign_key_violations': 0}


def prepare_restored(p):
    # Restores and online backups can produce a standalone WAL-mode main file. Let SQLite initialize
    # its WAL metadata in this isolated writable directory before read-only checks.
    with contextlib.closing(db_open(p, True)) as db:
        db.execute('PRAGMA journal_mode=DELETE')


def init_markers(p):
    with contextlib.closing(db_open(p, True)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS loom_recovery_marker (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, at REAL NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS loom_recovery_bundles (id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, captured_at REAL NOT NULL, published_at REAL NOT NULL)')


def mark(p):
    token, at = uuid.uuid4().hex, time.time()
    with contextlib.closing(db_open(p, True)) as db, db:
        db.execute('INSERT OR REPLACE INTO loom_recovery_marker VALUES (1, ?, ?)', (token, at))
    return {'token': token, 'at': at}


def space_floors(c):
    """(warn, pause) free-byte floors. Legacy `min_free_bytes` is the warning floor."""
    warn = c.get('warn_free_bytes', c.get('min_free_bytes', DEFAULT_WARN_FREE))
    return warn, min(c.get('pause_free_bytes', DEFAULT_PAUSE_FREE), warn)


def destination_host(c):
    return c.get('ssh', '').rpartition('@')[2] or None


def apply_remote_root(c):
    """Stable mini layout: tooling in <root>/bin, dated replicas in <root>/destinations.

    Tooling never lives inside a destination, so destination pruning cannot remove it.
    """
    root = c.get('remote_root')
    if root is None:
        return c
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise ValueError('remote_root must be an absolute path')
    c.setdefault('remote_script', root + '/bin/loom_backup.py')
    c.setdefault('remote_litestream', root + '/bin/litestream')
    if c.get('destination') is not None:
        dest = Path(c['destination'])
        if dest.parent != Path(root) / 'destinations' or not DESTINATION_NAME.fullmatch(dest.name):
            raise ValueError('With remote_root, destination must be <remote_root>/destinations/<YYYYMMDDTHHMMSSZ>')
    return c


def load_config(p):
    c = apply_remote_root(read_json(p))
    for key in ['db', 'home', 'spool', 'destination', 'litestream', 'remote_litestream', 'ssh', 'host', 'user', 'key_path', 'host_key', 'remote_script']:
        if not isinstance(c.get(key), str) or not c[key]:
            raise ValueError('Missing config: ' + key)
    for key in ['db', 'home', 'spool', 'destination', 'litestream', 'remote_litestream', 'key_path', 'remote_script']:
        if not Path(c[key]).is_absolute():
            raise ValueError('Paths must be absolute: ' + key)
    if c['ssh'].startswith('-') or not re.fullmatch(r'[\w.@:-]+', c['ssh']):
        raise ValueError('Invalid SSH target')
    if not c['host_key'].startswith(('ssh-', 'ecdsa-')):
        raise ValueError('Expected a pinned host public key')
    for key, default in [('bundle_interval_seconds', 600), ('probe_interval_seconds', 30), ('restore_probe_interval_seconds', 120), ('min_free_bytes', DEFAULT_WARN_FREE), ('warn_free_bytes', DEFAULT_WARN_FREE), ('pause_free_bytes', DEFAULT_PAUSE_FREE), ('max_file_bytes', 256 * 1024**2), ('remote_keep_bundles', 3), ('keep_previous_destinations', 1)]:
        if not isinstance(c.get(key, default), int) or c.get(key, default) <= 0:
            raise ValueError('Expected positive integer: ' + key)
    if 'pause_free_bytes' in c and c['pause_free_bytes'] > space_floors(c)[0]:
        raise ValueError('pause_free_bytes must not exceed the warning floor')
    for key in ['remote_script', 'remote_litestream']:
        if Path(c[key]).is_relative_to(Path(c['destination'])):
            raise ValueError(key + ' must live outside the destination (use <remote_root>/bin)')
    exclusions = c.get('excluded_threads', {})
    if not isinstance(exclusions, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in exclusions.items()):
        raise ValueError('excluded_threads must map thread ids to audited reasons')
    return c


def litestream_config(c):
    # JSON is YAML; disable environment expansion when invoking Litestream.
    return {'snapshot': {'interval': '24h', 'retention': '168h'},
            'dbs': [{'path': c['db'], 'replica': {
        'type': 'sftp', 'host': c['host'], 'user': c['user'],
        'key-path': c['key_path'], 'host-key': c['host_key'],
        'path': c['destination'] + '/replica', 'sync-interval': '5s'}}]}


def copy_file(src, root, rel, entries, jsonl=False, limit=256 * 1024 * 1024):
    src = Path(src)
    if src.name == '.env' or src.name.startswith('.env.') or src.name in ('auth.json', 'credentials.json', '.credentials.json'):
        raise ValueError('Credential file excluded from recovery archive')
    if src.is_symlink() or not src.is_file():
        raise ValueError('Missing/nonregular recovery file: ' + str(src))
    before = src.stat()
    if before.st_size > limit:
        raise ValueError('Recovery file exceeds configured limit: ' + str(src))
    with src.open('rb') as f:
        data = f.read(before.st_size)
    after = src.stat()
    if (before.st_ino, before.st_dev) != (after.st_ino, after.st_dev) or len(data) != before.st_size:
        raise ValueError('Recovery file replaced/truncated during capture')
    if jsonl:
        data = data[:data.rfind(b'\n') + 1]
        if not data:
            raise ValueError('No complete transcript records')
        for line in data.splitlines():
            if line.strip():
                json.loads(line)
        # Append is safe; rewriting the prefix is not.
        with src.open('rb') as f:
            if f.read(len(data)) != data:
                raise ValueError('Transcript prefix changed during capture')
    elif (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('Recovery file changed during capture')
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    entries.append({'path': rel, 'source': str(src), 'bytes': len(data), 'sha256': digest(target),
                    'prefix': jsonl, 'source_bytes': before.st_size})
    return rel


def transcript_files(t, c):
    sid = t.get('native_session_id')
    if not sid:
        return []
    if not re.fullmatch(r'[\w-]+', sid):
        raise ValueError('Invalid native session id')
    if t['provider'] == 'claude':
        root = Path(c['home']) / 'claude-projects'
        matches = list(root.glob('*/' + sid + '.jsonl'))
        if len(matches) != 1:
            raise ValueError('Claude transcript missing or ambiguous')
        companions = matches[0].parent / sid
        return [matches[0]] + (sorted(p for p in companions.rglob('*') if p.is_file()) if companions.exists() else [])
    if t['provider'] == 'codex':
        matches = []
        for root in c.get('codex_session_roots', []):
            matches.extend(Path(root).glob('**/*' + sid + '.jsonl'))
        if len(matches) != 1:
            raise ValueError('Codex rollout missing or ambiguous; configure session roots')
        return matches
    raise ValueError('Unsupported provider transcript')


def archived_worktree(t):
    # Restoration retains the archive path but clears the removal timestamp.
    return bool(t.get('worktree_archive')) and t.get('worktree_removed_at') is not None


def capture(c):
    staging = Path(c['spool']) / ('.partial-' + uuid.uuid4().hex)
    try:
        return capture_into(c, staging)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def capture_into(c, staging):
    """Immutable inventory + coherent SQLite snapshot + file prefixes. No implicit native resume."""
    spool = Path(c['spool'])
    spool.mkdir(parents=True, exist_ok=True)
    bundle_id = staging.name.removeprefix('.partial-')
    staging.mkdir()
    manifest = {'version': VERSION, 'id': bundle_id, 'captured_at': time.time(),
                'files': [], 'threads': [], 'repositories': [], 'exclusions': EXCLUSIONS}
    snapshot = staging / 'snapshot.sqlite'
    with contextlib.closing(db_open(c['db'])) as source, contextlib.closing(sqlite3.connect(snapshot)) as dest:
        source.backup(dest)
    prepare_restored(snapshot)
    check_db(snapshot)
    with contextlib.closing(db_open(snapshot)) as schema_db:
        manifest['schema_sha256'] = hashlib.sha256('\n'.join(r[0] or '' for r in schema_db.execute('SELECT sql FROM sqlite_master ORDER BY name')).encode()).hexdigest()
        manifest['user_version'] = schema_db.execute('PRAGMA user_version').fetchone()[0]
    manifest['release'] = c.get('release', 'unrecorded')
    manifest['files'].append({'path': 'snapshot.sqlite', 'bytes': snapshot.stat().st_size, 'sha256': digest(snapshot)})
    repos = {}
    repo_errors = {}
    checkpoint_objects = {}
    with contextlib.closing(db_open(snapshot)) as db:
        threads, attachments = rows(db, 'threads'), rows(db, 'attachments')
        attempts = rows(db, 'attempts') if db.execute("SELECT 1 FROM sqlite_master WHERE name='attempts'").fetchone() else []
        checkpoints = rows(db, 'checkpoints') if db.execute("SELECT 1 FROM sqlite_master WHERE name='checkpoints'").fetchone() else []
    # History is append-only; older checkpoints are sibling commits, not
    # ancestors of the latest ref. Only the latest snapshot row is required.
    checkpoints = list({cp['thread_id']: cp for cp in sorted(checkpoints, key=lambda cp: cp['at'])}.values())
    for t in threads:
        item = {'id': t['id'], 'native_session_id': t.get('native_session_id'), 'provider': t['provider'],
                'captured_at': manifest['captured_at'], 'files': [], 'errors': [], 'repo': t.get('repo'),
                'cwd': t['cwd'], 'native_resume_verified': False, 'exclusions': [], 'warnings': []}
        exclusion = c.get('excluded_threads', {}).get(t['id'])
        if exclusion:
            if (Path(t['cwd']) / '.git').exists():
                item['warnings'].append('Explicitly excluded thread has a current Git worktree; re-audit exclusion')
            if (t.get('updated_at') or 0) / 1000 >= manifest['captured_at'] - 86400:
                item['warnings'].append('Explicitly excluded thread has activity within 24 hours; re-audit exclusion')
        if archived_worktree(t) or exclusion:
            item.update(complete=False, recoverability='excluded-by-policy')
            item['exclusions'].append(exclusion or 'Archived worktree excluded; requires separate recovery inventory')
            manifest['threads'].append(item)
            continue
        def save(src, kind, jsonl=False):
            rel = kind + '/' + uuid.uuid4().hex + ('.jsonl' if jsonl else '')
            item['files'].append(copy_file(src, staging, rel, manifest['files'], jsonl, c.get('max_file_bytes', 256 * 1024 * 1024)))
        repo_attempt = None
        try:
            sessions = {t.get('native_session_id')} | {a.get('native_session_id') for a in attempts if a['thread_id'] == t['id']}
            item['native_sessions'] = sorted(sid for sid in sessions if sid)
            for sid in item['native_sessions']:
                for p in transcript_files({**t, 'native_session_id': sid}, c):
                    save(p, 'transcripts', p.suffix == '.jsonl')
            for a in attachments:
                if a['thread_id'] == t['id']:
                    p = Path(a['path'])
                    p.resolve().relative_to((Path(c['home']) / 'attachments').resolve())
                    save(p, 'attachments')
            repo = t.get('repo')
            if repo:
                repo_attempt = repo
                if repo in repo_errors:
                    raise ValueError(repo_errors[repo])
                if any(line.startswith('160000 ') for line in run(['git', '-C', repo, 'ls-tree', '-r', 'HEAD']).splitlines()):
                    raise ValueError('Submodule object recovery needs a dedicated exporter')
                if repo not in repos:
                    index = len(repos)
                    rel = 'repositories/' + str(index) + '.bundle'
                    out = staging / rel
                    out.parent.mkdir(exist_ok=True)
                    boundaries = shallow_boundaries(repo)
                    refs = run(['git', '-C', repo, 'show-ref', '--head'])
                    required = sorted({cp['ref'] for cp in checkpoints
                                       if any(row['id'] == cp['thread_id'] and row.get('repo') == repo
                                              and not archived_worktree(row)
                                              and row['id'] not in c.get('excluded_threads', {}) for row in threads)})
                    fingerprint = refs + '\nshallow:' + ','.join(boundaries) + '\ncheckpoints:' + ','.join(required)
                    reused = reuse_repository(c, repo, fingerprint, out)
                    if not reused:
                        export_repository(repo, refs, boundaries, required, out)
                    run(['git', '-C', repo, 'bundle', 'verify', str(out)])
                    if boundaries and not reused:
                        with tempfile.TemporaryDirectory(prefix='loom-shallow-check-') as tmp:
                            restore_repository(out, {'shallow': boundaries}, Path(tmp) / 'repo')
                    heads = run(['git', 'bundle', 'list-heads', str(out)])
                    if shallow_boundaries(repo) != boundaries:
                        raise ValueError('Shallow boundary changed during capture')
                    if run(['git', '-C', repo, 'show-ref', '--head']) != refs:
                        fingerprint = None  # Refs changed while exporting; do not cache this inventory.
                    repos[repo] = {'source': repo, 'path': rel, 'heads': heads, 'fingerprint': fingerprint, 'shallow': boundaries}
                    manifest['repositories'].append(repos[repo])
                    manifest['files'].append({'path': rel, 'bytes': out.stat().st_size, 'sha256': digest(out)})
                repo_attempt = None
                item['repository_bundle'] = repos[repo]['path']
                checkpoint_ref = 'refs/loom/checkpoints/' + t['id']
                item['checkpoint'] = next((line.split()[0] for line in repos[repo]['heads'].splitlines() if line.endswith(' ' + checkpoint_ref)), None)
                recorded = sorted({cp['ref'] for cp in checkpoints if cp['thread_id'] == t['id']})
                item['recorded_checkpoints'] = recorded
                exported = {line.split()[0] for line in repos[repo]['heads'].splitlines()}
                missing = sorted(set(recorded) - exported)
                if missing:
                    if repo not in checkpoint_objects:
                        required = {cp['ref'] for cp in checkpoints
                                    if any(row['id'] == cp['thread_id'] and row.get('repo') == repo for row in threads)}
                        checkpoint_objects[repo] = bundled_commits(staging / repos[repo]['path'], required)
                    missing = sorted(set(missing) - checkpoint_objects[repo])
                if missing:
                    raise ValueError('Snapshot checkpoint inclusion not verified: ' + ', '.join(missing))
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            if repo_attempt:
                repo_errors[repo_attempt] = str(e)
            item['errors'].append(str(e))
        item['complete'] = not item['errors']
        item['recoverability'] = 'covered' if item['complete'] else 'not recoverable'
        manifest['threads'].append(item)
    manifest['complete'] = all(t['complete'] or t['recoverability'] == 'excluded-by-policy' for t in manifest['threads'])
    manifest['coverage'] = {
        'covered': [t['id'] for t in manifest['threads'] if t['complete']],
        'not_recoverable': [t['id'] for t in manifest['threads'] if t['recoverability'] == 'not recoverable'],
        'excluded_by_policy': [t['id'] for t in manifest['threads'] if t['recoverability'] == 'excluded-by-policy']}
    atomic_json(staging / 'manifest.json', manifest)
    final = spool / bundle_id
    staging.rename(final)
    return final, manifest


def export_repository(repo, refs, boundaries, checkpoints, out):
    """Pin snapshot commits in a disposable repo; never write source refs or objects."""
    objects = Path(run(['git', '-C', repo, 'rev-parse', '--git-path', 'objects']))
    if not objects.is_absolute():
        objects = Path(repo) / objects
    with tempfile.TemporaryDirectory(prefix='loom-export-') as tmp:
        target = Path(tmp)
        object_format = run(['git', '-C', repo, 'rev-parse', '--show-object-format'])
        run(['git', 'init', '--bare', '--object-format=' + object_format, target])
        (target / 'objects/info/alternates').write_text(str(objects.resolve()) + '\n')
        if boundaries:
            (target / 'shallow').write_text('\n'.join(boundaries) + '\n')
        updates = {}
        for line in refs.splitlines():
            sha, ref = line.split()
            if ref == 'HEAD':
                run(['git', '-C', target, 'update-ref', '--no-deref', 'HEAD', sha])
            else:
                updates[ref] = sha
        for sha in checkpoints:
            if not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', sha):
                raise ValueError('Invalid checkpoint object id')
            # An actually missing object remains a per-thread gap, not a repo-wide failure.
            try:
                run(['git', '-C', target, 'cat-file', '-e', sha + '^{commit}'])
            except subprocess.CalledProcessError:
                continue
            updates['refs/loom-backup/' + sha] = sha
        run(['git', '-C', target, 'update-ref', '--stdin'], input='\n'.join('update ' + ref + ' ' + sha for ref, sha in updates.items()) + '\n')
        run(['git', '-C', target, 'bundle', 'create', str(out), '--all', 'HEAD'])


def shallow_boundaries(repo):
    path = Path(run(['git', '-C', repo, 'rev-parse', '--git-path', 'shallow']))
    if not path.is_absolute():
        path = Path(repo) / path
    return sorted(path.read_text().splitlines()) if path.exists() else []


def restore_repository(bundle, repo, target):
    boundaries = repo.get('shallow', [])
    if not isinstance(boundaries, list) or any(not isinstance(sha, str) or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', sha) for sha in boundaries):
        raise ValueError('Invalid shallow boundaries')
    if boundaries:
        # A Git bundle contains the boundary objects but not the shallow file.
        # Restore that traversal boundary before indexing; no origin or credentials needed.
        run(['git', 'init', '--bare', '--object-format=' + ('sha256' if len(boundaries[0]) == 64 else 'sha1'), target])
        (Path(target) / 'shallow').write_text('\n'.join(boundaries) + '\n')
        heads = run(['git', '-C', target, 'bundle', 'unbundle', bundle])
        for line in heads.splitlines():
            sha, ref = line.split()
            if ref == 'HEAD' or ref.startswith('refs/'):
                run(['git', '-C', target, 'update-ref', '--no-deref', ref, sha])
        for sha in boundaries:
            run(['git', '-C', target, 'cat-file', '-e', sha + '^{commit}'])
    else:
        run(['git', 'clone', '--mirror', bundle, target])
    run(['git', '-C', target, 'fsck', '--full'])


def bundled_commits(bundle, required):
    """Check only the exported object store, never the live repository."""
    with tempfile.TemporaryDirectory(prefix='loom-bundle-check-') as tmp:
        run(['git', 'init', '--bare', tmp])
        run(['git', '-C', tmp, 'bundle', 'unbundle', bundle])
        found = set()
        for sha in required:
            if not re.fullmatch(r'[0-9a-f]{40,64}', sha):
                continue
            try:
                run(['git', '-C', tmp, 'cat-file', '-e', sha + '^{commit}'])
                found.add(sha)
            except subprocess.CalledProcessError:
                pass
        return found


def last_good(c, name='last-good.json'):
    try:
        ident = read_json(Path(c['spool']) / name)['id']
        if re.fullmatch(r'[0-9a-f]{32}', ident):
            return Path(c['spool']) / ident
    except (OSError, ValueError, KeyError):
        pass
    return None


def prune_local(c):
    """Only generated bundle directories; preserve the last published copy."""
    keep = {last_good(c), last_good(c, 'pending.json')}
    for p in Path(c['spool']).iterdir():
        if re.fullmatch(r'(?:\.partial-)?[0-9a-f]{32}', p.name) and p not in keep and p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)


def reuse_repository(c, repo, fingerprint, output):
    previous = last_good(c)
    if previous is None:
        return False
    try:
        m = read_json(previous / 'manifest.json')
        old = next(r for r in m['repositories'] if r['source'] == repo and r.get('fingerprint') == fingerprint)
        entry = next(e for e in m['files'] if e['path'] == old['path'])
        source = safe_child(previous, old['path'])
        if digest(source) != entry['sha256']:
            return False
        os.link(source, output)
        return True
    except (OSError, ValueError, KeyError, StopIteration):
        return False


@contextlib.contextmanager
def bundle_lock(c):
    import fcntl
    Path(c['spool']).mkdir(parents=True, exist_ok=True)
    with (Path(c['spool']) / 'bundle.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def backup_once(c):
    with bundle_lock(c):
        return backup_once_locked(c)


def backup_once_locked(c):
    spool = Path(c['spool'])
    spool.mkdir(parents=True, exist_ok=True)
    prune_local(c)
    try:
        bundle = last_good(c, 'pending.json')
        if bundle is not None:
            try:
                manifest = verify(bundle)
            except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
                (spool / 'pending.json').unlink(missing_ok=True)
                prune_local(c)
                bundle = None
        if bundle is None:
            bundle, manifest = capture(c)
            atomic_json(spool / 'pending.json', {'id': manifest['id']})
        publish(c, bundle, manifest)
        atomic_json(spool / 'last-good.json', {'id': manifest['id']})
        (spool / 'pending.json').unlink(missing_ok=True)
        return bundle, manifest
    finally:
        prune_local(c)


def retry_delay(failures):
    return min(3600, 60 * 2 ** min(max(0, failures - 1), 6))


def load_retry(c):
    try:
        return read_json(Path(c['spool']) / 'retry.json')
    except FileNotFoundError:
        return {'failures': 0, 'next_attempt_at': 0, 'error': None}


def save_retry(c, state, error=None, *, started_at=None):
    state['failures'] = state['failures'] + 1 if error else 0
    state['error'] = str(error) if error else None
    if error:
        state['next_attempt_at'] = time.time() + retry_delay(state['failures'])
    else:
        # Successful work consumes its interval; slow captures must not add
        # another full interval to the age of the last published snapshot.
        state['next_attempt_at'] = (time.time() if started_at is None else started_at) + c.get('bundle_interval_seconds', 600)
    atomic_json(Path(c['spool']) / 'retry.json', state)


def read_status(c):
    try:
        result = read_json(Path(c['spool']) / 'health.json')
    except FileNotFoundError:
        return {'ok': False, 'alerts': ['monitor_not_started'], 'at': None}
    if time.time() - result['at'] > 120:
        result['alerts'].append('monitor_stale')
        result['ok'] = False
    return result


def safe_child(root, rel):
    p = Path(rel)
    if p.is_absolute() or '..' in p.parts or not p.parts:
        raise ValueError('Unsafe manifest path')
    target = Path(root).resolve() / p
    target.resolve().relative_to(Path(root).resolve())
    if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent.is_relative_to(Path(root).resolve())):
        raise ValueError('Symlink in recovery bundle')
    return target


def verify(bundle):
    bundle = Path(bundle)
    manifest = read_json(bundle / 'manifest.json')
    if manifest['version'] not in (1, VERSION):
        raise ValueError('Unsupported recovery format')
    for entry in manifest['files']:
        p = safe_child(bundle, entry['path'])
        if not p.is_file() or p.stat().st_size != entry['bytes'] or digest(p) != entry['sha256']:
            raise ValueError('Hash/size mismatch: ' + entry['path'])
    check_db(bundle / 'snapshot.sqlite')
    return manifest


def remote_prepare(bundles, ident):
    root = Path(bundles)
    root.mkdir(parents=True, exist_ok=True)
    final = safe_child(root, ident)
    if not re.fullmatch(r'[0-9a-f]{32}', ident):
        raise ValueError('Invalid bundle id')
    for p in root.iterdir():
        if (re.fullmatch(r'\.partial-[0-9a-f]{32}', p.name) and p.name != '.partial-' + ident
                and p.is_dir() and not p.is_symlink()):
            shutil.rmtree(p)
    if final.exists():
        verify(final)
        return {'published': True, 'hash': digest(final / 'manifest.json')}
    return {'published': False}


def remote_finalize(bundles, ident):
    if not re.fullmatch(r'[0-9a-f]{32}', ident):
        raise ValueError('Invalid bundle id')
    root = Path(bundles)
    final, partial = safe_child(root, ident), safe_child(root, '.partial-' + ident)
    if not final.exists():
        verify(partial)
        partial.rename(final)
    verify(final)
    return {'hash': digest(final / 'manifest.json')}


def remote_prune(bundles, keep, protected):
    """Keep newest N verified plus the source and replicated DB pointers.

    Caller must successfully restore the replica before authorizing deletion.
    Only generated directories in this dedicated single-writer namespace qualify.
    """
    if keep < 1:
        raise ValueError('Retention must keep at least one verified bundle')
    root = Path(bundles)
    verified = []
    for p in root.iterdir():
        if not re.fullmatch(r'[0-9a-f]{32}', p.name) or not p.is_dir() or p.is_symlink():
            continue
        try:
            m = verify(p)
            verified.append((m['captured_at'], p))
        except (OSError, ValueError, KeyError, sqlite3.Error):
            continue  # Never destroy an unverified/unknown directory automatically.
    retained = set(protected) | {p.name for _, p in sorted(verified, reverse=True)[:keep]}
    deleted = []
    for _, p in verified:
        if p.name not in retained:
            shutil.rmtree(p)
            deleted.append(p.name)
    return {'deleted': deleted, 'retained': sorted(retained)}


def publish(c, bundle, manifest):
    verify(bundle)
    dest = c['destination'] + '/bundles'
    ident = manifest['id']
    expected = digest(bundle / 'manifest.json')
    prepared = json.loads(remote(c, ['python3', c['remote_script'], 'prepare', dest, ident]))
    if not prepared['published']:
        partial = dest + '/.partial-' + ident
        args = ['rsync', '-a', '--checksum', '-e', shlex.join(SSH)]
        previous = last_good(c)
        if previous:
            args += ['--link-dest=' + dest + '/' + previous.name]
        run(args + [str(bundle) + '/', c['ssh'] + ':' + shlex.quote(partial) + '/'])
        prepared = json.loads(remote(c, ['python3', c['remote_script'], 'finalize', dest, ident]))
    if prepared['hash'] != expected:
        raise ValueError('Published manifest differs from pending bundle')
    with contextlib.closing(db_open(c['db'], True)) as db, db:
        db.execute('INSERT OR IGNORE INTO loom_recovery_bundles VALUES (?, ?, ?, ?)',
                   (ident, expected, manifest['captured_at'], time.time()))
        if db.execute('SELECT manifest_hash FROM loom_recovery_bundles WHERE id=?', (ident,)).fetchone()[0] != expected:
            raise ValueError('Committed manifest differs from pending bundle')
    # A successful restore supplies the replica's current pointer. If unavailable,
    # retain this pending bundle and retry it rather than creating further copies.
    remote(c, ['python3', c['remote_script'], 'retain', c['remote_litestream'],
               c['destination'], ident, str(c.get('remote_keep_bundles', 3))])


def probe_replica(litestream, replica, scratch):
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='probe-', dir=scratch) as tmp:
        path = Path(tmp) / 'probe.sqlite'
        run([litestream, 'restore', '-o', str(path), 'file://' + str(Path(replica).resolve())])
        prepare_restored(path)
        check_db(path)
        with contextlib.closing(db_open(path)) as db:
            marker = dict(db.execute('SELECT * FROM loom_recovery_marker WHERE id=1').fetchone())
            bundle = db.execute('SELECT * FROM loom_recovery_bundles ORDER BY published_at DESC LIMIT 1').fetchone()
        return {'marker': marker, 'bundle': dict(bundle) if bundle else None,
                'probe_seconds': time.monotonic() - started, 'free_bytes': shutil.disk_usage(replica).free}


def health(source_marker, probe, now, warn_free, pause_free, max_lag=120, max_bundle_age=1800):
    alerts = []
    if probe is None:
        return {'ok': False, 'alerts': ['replica_unavailable'], 'lag_seconds': None}
    lag = max(0, source_marker['at'] - probe['marker']['at'])
    if now - probe['marker']['at'] > max_lag or lag > max_lag:
        alerts.append('replica_lag')
    # Two floors: the warning alerts without holding Loom; low space (a hard floor where
    # replication would fail) is the one Loom pauses admissions on.
    if probe['free_bytes'] < pause_free:
        alerts.append('destination_low_space')
    elif probe['free_bytes'] < warn_free:
        alerts.append('destination_space_warn')
    if not probe.get('bundle') or now - probe['bundle']['captured_at'] > max_bundle_age:
        alerts.append('recovery_bundle_stale')
    return {'ok': not alerts, 'alerts': alerts, 'lag_seconds': lag,
            'marker_age_seconds': max(0, now - probe['marker']['at']), 'free_bytes': probe['free_bytes']}


def restore(litestream, replica, bundles, output):
    """Restore into a NEW inert directory. Never starts Loom or rewrites the source."""
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    db_path = output / 'replicated.sqlite'
    run([litestream, 'restore', '-o', str(db_path), 'file://' + str(Path(replica).resolve())])
    prepare_restored(db_path)
    checks = check_db(db_path)
    with contextlib.closing(db_open(db_path)) as db:
        candidates = rows(db, 'loom_recovery_bundles')
        marker = dict(db.execute('SELECT * FROM loom_recovery_marker WHERE id=1').fetchone())
    selected = None
    errors = []
    for candidate in sorted(candidates, key=lambda r: r['published_at'], reverse=True):
        try:
            b = safe_child(bundles, candidate['id'])
            if digest(b / 'manifest.json') != candidate['manifest_hash']:
                raise ValueError('Manifest hash mismatch')
            m = verify(b)
            selected = (b, m)
            break
        except (OSError, ValueError) as e:
            errors.append(str(e))
    if not selected:
        raise ValueError('No verified committed recovery bundle: ' + '; '.join(errors))
    b, m = selected
    shutil.copytree(b, output / 'bundle')
    # Files agree with the captured DB, not necessarily with later replicated rows.
    # Preserve the newer DB for reconciliation; never silently bind old files to it.
    shutil.copy2(b / 'snapshot.sqlite', output / 'sandbox.sqlite')
    for index, repo in enumerate(m['repositories']):
        target = output / 'repositories' / str(index)
        target.parent.mkdir(exist_ok=True)
        restore_repository(b / repo['path'], repo, target)
    report = {**checks, 'bundle_id': m['id'], 'database_marker': marker,
              'database_age_seconds': max(0, time.time() - marker['at']),
              'file_recovery_point': m['captured_at'], 'file_age_seconds': max(0, time.time() - m['captured_at']),
              'rto_seconds': time.monotonic() - started,
              'threads': m['threads'], 'tools_started': False, 'triggers_started': False,
              'native_resume_verified': False, 'newer_database_requires_reconciliation': True,
              'skipped_bundles': errors}
    atomic_json(output / 'restore-report.json', report)
    return report


# The warning keeps captures running; retention keeps the mini's bundle footprint flat.
STOP_CAPTURE = {'destination_low_space', 'source_low_space'}


PRUNE_EVERY_SECONDS = 6 * 3600
PRUNE_RETRY_SECONDS = 600


def prune_superseded(c, now):
    """After the current destination verified (a restored replica with a committed bundle),
    remove superseded dated destinations on the mini, keeping one previous.

    Runs once per new destination, then every few hours; a failure retries after ten
    minutes and stays reported until then. Returns an error string or None.
    """
    if not c.get('remote_root'):
        return None
    state_path = Path(c['spool']) / 'destinations.json'
    try:
        state = read_json(state_path)
    except (OSError, ValueError):
        state = {}
    if state.get('destination') == c['destination'] and now < state.get('next_at', 0):
        return state.get('error')
    try:
        result = json.loads(remote(c, ['python3', c['remote_script'], 'prune-destinations', c['remote_litestream'],
                                       c['remote_root'], c['destination'], str(c.get('keep_previous_destinations', 1))]))
        state = {'destination': c['destination'], 'pruned_at': now, 'next_at': now + PRUNE_EVERY_SECONDS,
                 'error': None, 'result': result}
    except (ValueError, subprocess.SubprocessError) as e:
        state = {'destination': c['destination'], 'next_at': now + PRUNE_RETRY_SECONDS,
                 'error': 'destination prune failed: ' + str(e)}
    atomic_json(state_path, state)
    return state['error']


def remote_prune_destinations(litestream, root, current, keep=1):
    """Delete superseded <root>/destinations/<stamp> replicas, keeping `keep` previous ones.

    Runs on the mini. The current destination must restore with a committed bundle first, and
    only generated stamp-named directories older than it qualify: <root>/bin, symlinks,
    unrecognized names and anything newer are never touched.
    """
    if keep < 1:
        raise ValueError('Keep at least one previous destination')
    destinations = Path(root) / 'destinations'
    current = Path(current)
    if current.parent != destinations or not DESTINATION_NAME.fullmatch(current.name):
        raise ValueError('Current destination is not a generated destination under ' + str(destinations))
    probe = probe_replica(litestream, current / 'replica', current)
    if not probe['bundle']:
        raise ValueError('Current destination has no committed bundle yet')
    older = sorted((p for p in destinations.iterdir()
                    if DESTINATION_NAME.fullmatch(p.name) and p.name < current.name
                    and p.is_dir() and not p.is_symlink()), key=lambda p: p.name, reverse=True)
    deleted = []
    for p in older[keep:]:
        shutil.rmtree(p)
        deleted.append(p.name)
    return {'deleted': deleted, 'kept': [p.name for p in older[:keep]], 'current': current.name,
            'free_bytes': shutil.disk_usage(destinations).free}


def rotate_destination(config_path, now=None):
    """Point the config at a fresh dated destination (a reseed). The service must be stopped.

    The previous destination stays until the new one verifies; the service then prunes
    superseded destinations (keeping one previous).
    """
    import fcntl
    c = load_config(config_path)
    if not c.get('remote_root'):
        raise ValueError('rotate needs remote_root (the stable mini layout)')
    spool = Path(c['spool'])
    spool.mkdir(parents=True, exist_ok=True)
    with (spool / 'service.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Stop the backup service before rotating its destination') from None
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now if now is not None else time.time()))
        new = c['remote_root'] + '/destinations/' + stamp
        if new <= c['destination']:
            raise ValueError('New destination must sort after the current one')
        raw = read_json(config_path)
        previous = raw['destination']
        raw['destination'] = new
        atomic_json(config_path, raw)
        os.chmod(config_path, 0o600)
    return {'previous': previous, 'destination': new}


def bundle_attempt(c, retry, marker_error=None):
    """One serialized attempt; reservation is already durable before submission."""
    started_at = time.time()
    try:
        if marker_error:
            raise marker_error
        backup_once(c)
        save_retry(c, retry, started_at=started_at)
    except (sqlite3.Error, OSError, ValueError, subprocess.SubprocessError) as e:
        retry['error'] = str(e)
        retry['next_attempt_at'] = time.time() + retry_delay(retry['failures'])
        atomic_json(Path(c['spool']) / 'retry.json', retry)


def service(c):
    """Opt-in supervisor; installation/activation is deliberately a separate operator action."""
    import fcntl
    spool = Path(c['spool'])
    spool.mkdir(parents=True, exist_ok=True)
    lock = (spool / 'service.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if run([c['litestream'], 'version']) != LITESTREAM_VERSION:
        raise ValueError('Expected Litestream ' + LITESTREAM_VERSION)
    config = spool / 'litestream.json'
    atomic_json(config, litestream_config(c))
    retry = load_retry(c)
    child = subprocess.Popen([c['litestream'], 'replicate', '-config', str(config), '-no-expand-env'], pass_fds=(lock.fileno(),))
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_probe = 0
    probe = None
    bundle_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="recovery-bundle")
    bundle_future = None
    bundle_error = retry["error"]
    try:
        while not stopping:
            if child.poll() is not None:
                raise RuntimeError('Litestream exited: ' + str(child.returncode))
            if bundle_future is not None and bundle_future.done():
                bundle_future.result()  # Unexpected worker failures stop supervision.
                bundle_future = None
                retry = load_retry(c)
                bundle_error = retry['error']
            failure = None
            marker_error = None
            try:
                init_markers(c['db'])
                marker = mark(c['db'])
            except sqlite3.Error as e:
                marker = {'at': time.time()}
                marker_error = e
            if time.time() >= next_probe:
                try:
                    probe = json.loads(remote(c, ['python3', c['remote_script'], 'probe', c['remote_litestream'], c['destination'] + '/replica', c['destination']]))
                except (ValueError, subprocess.SubprocessError) as e:
                    probe = None
                    failure = str(e)
                next_probe = time.time() + c.get('restore_probe_interval_seconds', 120)
            warn_free, pause_free = space_floors(c)
            status = health(marker, probe, time.time(), warn_free, pause_free,
                            max_lag=c.get('restore_probe_interval_seconds', 120) + 120,
                            max_bundle_age=max(1800, 3 * c.get('bundle_interval_seconds', 600)))
            # Context for whoever is alerted: which mini, how much room, and the floors.
            status.update(destination_host=destination_host(c), destination=c['destination'],
                          warn_free_bytes=warn_free, pause_free_bytes=pause_free)
            if probe is not None and failure is None and probe.get('bundle'):
                prune_error = prune_superseded(c, time.time())
                if prune_error:
                    status['alerts'].append('destination_prune_failed')
                    failure = prune_error
            if marker_error:
                status['alerts'].append('marker_failed')
                failure = str(marker_error)
            if shutil.disk_usage(spool).free < warn_free:
                status['alerts'].append('source_low_space')
            # Preserve a previous bundle failure while the next attempt runs.
            # Publish real probe health before submitting work to the writer.
            if bundle_error:
                status['alerts'].append('bundle_failed')
                failure = bundle_error
            status.update(at=time.time(), ok=not status['alerts'], error=failure)
            atomic_json(spool / 'health.json', status)
            if (bundle_future is None and time.time() >= retry['next_attempt_at']
                    and not STOP_CAPTURE.intersection(status['alerts'])):
                # Reserve before submission, but do not report an interrupted
                # attempt while it is still running. Prior failures stay visible.
                save_retry(c, retry, 'backup attempt interrupted')
                bundle_future = bundle_worker.submit(bundle_attempt, c, dict(retry), marker_error)
            status['bundle_running'] = bundle_future is not None
            status['next_bundle_at'] = retry['next_attempt_at']
            status.update(at=time.time(), ok=not status['alerts'], error=failure)
            atomic_json(spool / 'health.json', status)
            # Structured stderr is the alert surface for the service supervisor.
            print(json.dumps(status), file=sys.stderr, flush=True)
            for _ in range(c.get('probe_interval_seconds', 30)):
                if stopping:
                    break
                time.sleep(1)
    finally:
        # Stop reporting health immediately, but retain the spool lock and
        # replication until the writer finishes. The process supervisor must
        # stop the whole process group if its graceful shutdown deadline expires.
        try:
            with contextlib.suppress(OSError):
                atomic_json(spool / 'health.json', {'at': time.time(), 'ok': False, 'alerts': ['backup_supervisor_stopped']})
            try:
                bundle_worker.shutdown(wait=True)
            finally:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        finally:
            lock.close()
        with contextlib.suppress(OSError):
            atomic_json(spool / 'health.json', {'at': time.time(), 'ok': False, 'alerts': ['backup_supervisor_stopped']})



def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ['capture', 'publish', 'service', 'config', 'mark', 'status', 'rotate']:
        sub.add_parser(name).add_argument('config')
    p = sub.add_parser('prune-destinations')
    for arg in ['litestream', 'root', 'current', 'keep']:
        p.add_argument(arg)
    sub.add_parser('verify').add_argument('bundle')
    for command in ['prepare', 'finalize']:
        p = sub.add_parser(command)
        p.add_argument('bundles')
        p.add_argument('ident')
    p = sub.add_parser('retain')
    for arg in ['litestream', 'destination', 'ident', 'keep']:
        p.add_argument(arg)
    p = sub.add_parser('probe')
    for arg in ['litestream', 'replica', 'scratch']:
        p.add_argument(arg)
    p = sub.add_parser('restore')
    for arg in ['litestream', 'replica', 'bundles', 'output']:
        p.add_argument(arg)
    a = parser.parse_args()
    if a.command == 'verify':
        m = verify(a.bundle)
        result = {'id': m['id'], 'complete': m['complete'], 'files': len(m['files'])}
    elif a.command in ('prepare', 'finalize'):
        result = (remote_prepare if a.command == 'prepare' else remote_finalize)(a.bundles, a.ident)
    elif a.command == 'retain':
        probe = probe_replica(a.litestream, a.destination + '/replica', a.destination)
        protected = [a.ident] + ([probe['bundle']['id']] if probe['bundle'] else [])
        result = remote_prune(a.destination + '/bundles', int(a.keep), protected)
    elif a.command == 'probe':
        result = probe_replica(a.litestream, a.replica, a.scratch)
    elif a.command == 'prune-destinations':
        result = remote_prune_destinations(a.litestream, a.root, a.current, int(a.keep))
    elif a.command == 'rotate':
        result = rotate_destination(a.config)
    elif a.command == 'restore':
        result = restore(a.litestream, a.replica, a.bundles, a.output)
    else:
        c = load_config(a.config)
        if a.command == 'status':
            result = read_status(c)
            print(json.dumps(result))
            sys.exit(0 if result['ok'] else 1)
        if a.command == 'service':
            service(c)
            return
        if a.command == 'config':
            result = litestream_config(c)
        elif a.command == 'mark':
            init_markers(c['db'])
            result = mark(c['db'])
        else:
            if a.command == 'publish':
                init_markers(c['db'])
                bundle, m = backup_once(c)
            else:
                with bundle_lock(c):
                    prune_local(c)
                    bundle, m = capture(c)
            result = {'bundle': str(bundle), 'complete': m['complete'], 'threads': m['threads']}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
