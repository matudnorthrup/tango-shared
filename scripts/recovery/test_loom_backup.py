import contextlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import shutil
import time
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('loom_backup.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.db = self.root / 'loom.sqlite'
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('''PRAGMA journal_mode=WAL;
                CREATE TABLE threads(id TEXT PRIMARY KEY, provider TEXT, native_session_id TEXT, cwd TEXT, repo TEXT);
                CREATE TABLE attachments(id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id), path TEXT);
                INSERT INTO threads VALUES ('fake', 'claude', 'native', '/fixture', NULL);''')
        self.transcript = self.root / 'claude-projects' / 'fixture' / 'native.jsonl'
        self.transcript.parent.mkdir(parents=True)
        self.transcript.write_text('{"text":"committed"}\n{"partial":')
        self.c = {'db': str(self.db), 'home': str(self.root), 'spool': str(self.root / 'spool')}

    def test_stable_prefix_and_hash_verification(self):
        bundle, m = b.capture(self.c)
        with contextlib.closing(sqlite3.connect(bundle / 'snapshot.sqlite')) as snapshot:
            self.assertEqual(snapshot.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        with contextlib.closing(sqlite3.connect(self.db)) as source:
            self.assertEqual(source.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
        self.assertTrue(m['complete'])
        self.assertFalse(m['threads'][0]['native_resume_verified'])
        transcript = next(e for e in m['files'] if e['path'].startswith('transcripts/'))
        p = bundle / transcript['path']
        self.assertEqual(p.read_text(), '{"text":"committed"}\n')
        b.verify(bundle)
        p.write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'Hash/size mismatch'):
            b.verify(bundle)

    def test_missing_attachment_publishes_other_threads_with_explicit_gaps(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO attachments VALUES (?, ?, ?)', ('a', 'fake', str(self.root / 'attachments' / 'missing')))
            db.execute("INSERT INTO threads VALUES ('covered', 'claude', NULL, '/fixture', NULL)")
        bundle, m = b.capture(self.c)
        self.assertFalse(m['complete'])
        self.assertEqual(m['coverage'], {'covered': ['covered'], 'not_recoverable': ['fake'], 'excluded_by_policy': []})
        self.assertEqual(m['threads'][0]['recoverability'], 'not recoverable')
        self.c.update(destination='/fixture', ssh='fixture', remote_script='/fixture/script', remote_litestream='/fixture/litestream')
        b.init_markers(self.db)
        with patch.object(b, 'remote', return_value=json.dumps({'published': True, 'hash': b.digest(bundle / 'manifest.json')})), patch.object(b, 'run'):
            b.publish(self.c, bundle, m)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM loom_recovery_bundles').fetchone()[0], 1)

    def test_archived_worktree_is_excluded_without_error(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('ALTER TABLE threads ADD COLUMN worktree_archive TEXT')
            db.execute('ALTER TABLE threads ADD COLUMN worktree_removed_at INTEGER')
            db.execute("UPDATE threads SET worktree_archive='/excluded/archive', worktree_removed_at=1")
        _, m = b.capture(self.c)
        t = m['threads'][0]
        self.assertEqual(t['errors'], [])
        self.assertTrue(t['exclusions'])
        self.assertEqual(t['recoverability'], 'excluded-by-policy')
        self.assertEqual(m['coverage']['excluded_by_policy'], ['fake'])
        self.assertEqual(m['coverage']['not_recoverable'], [])
        self.assertTrue(m['complete'])

    def test_restored_archived_thread_exports_unreferenced_checkpoint(self):
        repo, ref, old, new, _ = self.sibling_checkpoint_fixture()
        b.run(['git', '-C', repo, 'update-ref', ref, new])
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('ALTER TABLE threads ADD COLUMN worktree_archive TEXT')
            db.execute('ALTER TABLE threads ADD COLUMN worktree_removed_at INTEGER')
            db.execute("UPDATE threads SET worktree_archive='/retained/archive', worktree_removed_at=NULL")
        bundle, manifest = b.capture(self.c)
        self.assertTrue(manifest['complete'])
        self.assertEqual(manifest['coverage']['covered'], ['fake'])
        self.assertEqual(manifest['coverage']['excluded_by_policy'], [])
        self.assertTrue(manifest['threads'][0]['files'])
        self.assertEqual(b.bundled_commits(bundle / manifest['repositories'][0]['path'], {old}), {old})

    def test_explicit_exclusion_warns_on_worktree_and_recent_activity(self):
        repo, *_ = self.sibling_checkpoint_fixture()
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('ALTER TABLE threads ADD COLUMN updated_at INTEGER')
            db.execute('UPDATE threads SET cwd=?, updated_at=?', (str(repo), int(time.time() * 1000)))
        self.c['excluded_threads'] = {'fake': 'Audited disposable fixture'}
        _, manifest = b.capture(self.c)
        self.assertEqual(manifest['coverage']['excluded_by_policy'], ['fake'])
        self.assertEqual(len(manifest['threads'][0]['warnings']), 2)

    def test_retention_failure_cleanup_and_restart(self):
        with patch.object(b, 'publish'):
            good, _ = b.backup_once(self.c)
        for _ in range(3):
            with patch.object(b, 'publish', side_effect=ValueError('offline')):
                with self.assertRaisesRegex(ValueError, 'offline'):
                    b.backup_once(self.c)
            dirs = [p for p in Path(self.c['spool']).iterdir() if p.is_dir()]
            self.assertEqual(len(dirs), 2)
            self.assertIn(good, dirs)
            pending = b.last_good(self.c, 'pending.json')
            self.assertIn(pending, dirs)
        abandoned = Path(self.c['spool']) / ('.partial-' + 'a' * 32)
        abandoned.mkdir()
        with patch.object(b, 'publish'):
            latest, _ = b.backup_once(self.c)
        self.assertFalse(good.exists())
        self.assertFalse(abandoned.exists())
        self.assertTrue(latest.exists())
        b.verify(latest)

    def test_capture_exception_removes_partial(self):
        with patch.object(b, 'check_db', side_effect=ValueError('broken')):
            with self.assertRaises(ValueError):
                b.capture(self.c)
        self.assertEqual(list(Path(self.c['spool']).iterdir()), [])

    def test_invalid_pending_recaptures_and_preserves_last_good(self):
        with patch.object(b, 'publish'):
            good, _ = b.backup_once(self.c)
        for damage in ['manifest', 'file', 'missing']:
            with self.subTest(damage=damage):
                with patch.object(b, 'publish', side_effect=ValueError('offline')):
                    with self.assertRaisesRegex(ValueError, 'offline'):
                        b.backup_once(self.c)
                pending = b.last_good(self.c, 'pending.json')
                if damage == 'manifest':
                    (pending / 'manifest.json').write_text('{}')
                elif damage == 'file':
                    (pending / 'snapshot.sqlite').write_bytes(b'corrupt')
                else:
                    shutil.rmtree(pending)
                with patch.object(b, 'publish', side_effect=ValueError('offline')):
                    with self.assertRaisesRegex(ValueError, 'offline'):
                        b.backup_once(self.c)
                replacement = b.last_good(self.c, 'pending.json')
                self.assertNotEqual(replacement, pending)
                self.assertFalse(pending.exists())
                b.verify(replacement)
                b.verify(good)

    def test_retry_backoff_and_missing_status(self):
        self.assertEqual([b.retry_delay(n) for n in [1, 2, 3, 99]], [60, 120, 240, 3600])
        self.assertEqual(b.read_status(self.c)['alerts'], ['monitor_not_started'])

    def test_successful_bundle_interval_includes_work_and_survives_reload(self):
        Path(self.c['spool']).mkdir()
        # An eleven-minute capture on a ten-minute schedule is already due
        # when it finishes; a fast capture waits only the remaining interval.
        for duration in [90, 673]:
            with self.subTest(duration=duration):
                now = [1000.0]
                def backup(_):
                    now[0] += duration
                with patch.object(b.time, 'time', side_effect=lambda: now[0]), \
                     patch.object(b, 'backup_once', side_effect=backup):
                    retry = {'failures': 0, 'error': None, 'next_attempt_at': 0}
                    b.save_retry(self.c, retry, 'backup attempt interrupted')
                    b.bundle_attempt(self.c, dict(retry))
                    persisted = b.load_retry(self.c)
                self.assertEqual(persisted['next_attempt_at'], 1600)
                self.assertEqual(persisted['failures'], 0)
                self.assertIsNone(persisted['error'])
                self.assertEqual(max(0, persisted['next_attempt_at'] - now[0]), max(0, 600 - duration))

    def test_failed_slow_bundle_backs_off_from_failure_not_start(self):
        Path(self.c['spool']).mkdir()
        now = [1000.0]
        def backup(_):
            now[0] += 673
            raise ValueError('upload unavailable')
        with patch.object(b.time, 'time', side_effect=lambda: now[0]), \
             patch.object(b, 'backup_once', side_effect=backup):
            retry = {'failures': 1, 'error': 'previous failure', 'next_attempt_at': 0}
            b.save_retry(self.c, retry, 'backup attempt interrupted')
            b.bundle_attempt(self.c, dict(retry))
            persisted = b.load_retry(self.c)
        self.assertEqual(persisted['next_attempt_at'], 1793)
        self.assertEqual(persisted['failures'], 2)
        self.assertEqual(persisted['error'], 'upload unavailable')

    def test_service_caches_probe_and_backs_off_failed_bundle(self):
        self.c.update(litestream='litestream', remote_litestream='remote',
                      host='fixture', user='fixture', key_path='/key', host_key='ssh-key',
                      destination='/fixture', remote_script='/script')
        now = time.time()
        probe = {'marker': {'at': now}, 'bundle': {'captured_at': now}, 'free_bytes': 10**15}
        def failed_backup(_):
            # Even the first slow capture exposes the preceding health probe.
            status = b.read_status(self.c)
            self.assertTrue(status['ok'])
            self.assertEqual(status['at'], now)
            raise ValueError('offline')
        with patch.object(b, 'run', return_value=b.LITESTREAM_VERSION), \
             patch.object(b.subprocess, 'Popen') as popen, \
             patch.object(b, 'remote', return_value=json.dumps(probe)) as remote, \
             patch.object(b, 'backup_once', side_effect=failed_backup) as backup, \
             patch.object(b.signal, 'signal'), patch.object(b.time, 'sleep'), \
             patch.object(b.time, 'time', return_value=now), patch('builtins.print'):
            popen.return_value.poll.side_effect = [None, None, 1]
            with self.assertRaisesRegex(RuntimeError, 'Litestream exited'):
                b.service(self.c)
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(backup.call_count, 1)
            popen.return_value.terminate.assert_called_once()

    def test_service_space_warning_keeps_capturing_and_reports_context(self):
        self.c.update(litestream='litestream', remote_litestream='remote', ssh='me@mini.invalid',
                      host='fixture', user='fixture', key_path='/key', host_key='ssh-key',
                      destination='/fixture', remote_script='/script', warn_free_bytes=100 * b.GIB)
        now = time.time()
        probe = {'marker': {'at': now}, 'bundle': {'captured_at': now}, 'free_bytes': 14 * b.GIB}
        seen = []
        def backup(_):
            seen.append(b.read_status(self.c))
            raise ValueError('offline')
        with patch.object(b, 'run', return_value=b.LITESTREAM_VERSION), \
             patch.object(b.subprocess, 'Popen') as popen, \
             patch.object(b, 'remote', return_value=json.dumps(probe)), \
             patch.object(b, 'backup_once', side_effect=backup) as backup_once, \
             patch.object(b.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(10**15, 0, 10**15)), \
             patch.object(b.signal, 'signal'), patch.object(b.time, 'sleep'), \
             patch.object(b.time, 'time', return_value=now), patch('builtins.print'):
            popen.return_value.poll.side_effect = [None, None, 1]
            with self.assertRaisesRegex(RuntimeError, 'Litestream exited'):
                b.service(self.c)
        self.assertEqual(backup_once.call_count, 1)
        self.assertEqual(seen[0]['alerts'], ['destination_space_warn'])
        self.assertEqual({k: seen[0][k] for k in ['free_bytes', 'destination_host', 'destination', 'warn_free_bytes', 'pause_free_bytes']},
                         {'free_bytes': 14 * b.GIB, 'destination_host': 'mini.invalid', 'destination': '/fixture',
                          'warn_free_bytes': 100 * b.GIB, 'pause_free_bytes': 5 * b.GIB})

    def test_unwritable_health_does_not_skip_shutdown_or_leave_lock_held(self):
        import fcntl
        self.c.update(litestream='litestream', remote_litestream='remote',
                      host='fixture', user='fixture', key_path='/key', host_key='ssh-key',
                      destination='/fixture', remote_script='/script')
        now = time.time()
        probe = {'marker': {'at': now}, 'bundle': {'captured_at': now}, 'free_bytes': 10**15}
        original_write = b.atomic_json
        def write(path, value):
            if Path(path).name == 'health.json':
                raise OSError('spool unwritable')
            original_write(path, value)
        with patch.object(b, 'run', return_value=b.LITESTREAM_VERSION), \
             patch.object(b.subprocess, 'Popen') as popen, \
             patch.object(b, 'remote', return_value=json.dumps(probe)), \
             patch.object(b, 'atomic_json', side_effect=write), \
             patch.object(b.signal, 'signal'):
            popen.return_value.poll.return_value = None
            with self.assertRaisesRegex(OSError, 'spool unwritable'):
                b.service(self.c)
            popen.return_value.terminate.assert_called_once()
            popen.return_value.wait.assert_called_once_with(timeout=15)
        with (Path(self.c['spool']) / 'service.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_slow_bundle_keeps_markers_and_real_health_probes_running(self):
        self.c.update(litestream='litestream', remote_litestream='remote',
                      host='fixture', user='fixture', key_path='/key', host_key='ssh-key',
                      destination='/fixture', remote_script='/script', probe_interval_seconds=1)
        now = [time.time()]
        initial = now[0]
        started, release = threading.Event(), threading.Event()
        signals, observations = {}, []
        def slow_backup(_):
            started.set()
            if not release.wait(5):
                raise RuntimeError('test did not release capture')
        def replica(*_):
            # Initially healthy, then genuinely stuck even while the capture runs.
            at = now[0] if now[0] < initial + 180 else initial
            return json.dumps({'marker': {'at': at}, 'bundle': {'captured_at': initial},
                               'free_bytes': 10**15})
        def tick(_):
            self.assertTrue(started.wait(2))
            observations.append(b.read_status(self.c))
            with contextlib.closing(b.db_open(self.db)) as db:
                self.assertEqual(db.execute('SELECT at FROM loom_recovery_marker').fetchone()[0], now[0])
            if len(observations) == 7:
                release.set()
                signals[b.signal.SIGTERM]()
            now[0] += 60
        try:
            with patch.object(b, 'run', return_value=b.LITESTREAM_VERSION), \
                 patch.object(b.subprocess, 'Popen') as popen, \
                 patch.object(b, 'remote', side_effect=replica) as remote, \
                 patch.object(b, 'backup_once', side_effect=slow_backup) as backup, \
                 patch.object(b.signal, 'signal', side_effect=lambda sig, fn: signals.update({sig: fn})), \
                 patch.object(b.time, 'sleep', side_effect=tick), \
                 patch.object(b.time, 'time', side_effect=lambda: now[0]), patch('builtins.print'):
                popen.return_value.poll.return_value = None
                b.service(self.c)
                self.assertEqual(backup.call_count, 1)
                self.assertGreaterEqual(remote.call_count, 4)
                popen.return_value.terminate.assert_called_once()
        finally:
            release.set()
        self.assertEqual(len(observations), 7)
        self.assertTrue(all(s['bundle_running'] for s in observations))
        self.assertTrue(all('monitor_stale' not in s['alerts'] for s in observations))
        self.assertTrue(all('bundle_failed' not in s['alerts'] for s in observations))
        self.assertTrue(observations[0]['ok'])
        self.assertIn('replica_lag', observations[-1]['alerts'])
        self.assertFalse(observations[-1]['ok'])
        self.assertIsNone(b.load_retry(self.c)['error'])
        self.assertEqual(b.read_status(self.c)['alerts'], ['backup_supervisor_stopped'])

    def test_shallow_repository_restores_offline_with_boundary_and_full_repo(self):
        repo = self.root / 'full'
        b.run(['git', 'init', repo])
        b.run(['git', '-C', repo, 'config', 'user.name', 'Recovery Fixture'])
        b.run(['git', '-C', repo, 'config', 'user.email', 'fixture@example.invalid'])
        for i in range(2):
            (repo / 'proof').write_text(str(i))
            b.run(['git', '-C', repo, 'add', '.'])
            b.run(['git', '-C', repo, 'commit', '-m', 'fixture'])
        shallow = self.root / 'shallow'
        b.run(['git', 'clone', '--depth', '1', repo.as_uri(), shallow])
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE threads SET repo=?', (str(shallow),))
            db.execute("INSERT INTO threads VALUES ('covered', 'claude', NULL, '/fixture', ?)", (str(repo),))
        bundle, manifest = b.capture(self.c)
        self.assertEqual(manifest['coverage'], {'covered': ['fake', 'covered'], 'not_recoverable': [], 'excluded_by_policy': []})
        self.assertEqual(len(manifest['repositories']), 2)
        boundary = (shallow / '.git/shallow').read_text()
        b.atomic_json(Path(self.c['spool']) / 'last-good.json', {'id': manifest['id']})
        b.run(['git', '-C', shallow, 'fetch', '--deepen=1'])
        changed, changed_manifest = b.capture(self.c)
        self.assertNotEqual(manifest['repositories'][0]['shallow'], changed_manifest['repositories'][0]['shallow'])
        self.assertNotEqual((bundle / manifest['repositories'][0]['path']).stat().st_ino,
                            (changed / changed_manifest['repositories'][0]['path']).stat().st_ino)
        # The origin and original shallow checkout are unavailable during restore.
        shutil.rmtree(repo)
        shutil.rmtree(shallow)
        for index, exported in enumerate(manifest['repositories']):
            clone = self.root / ('restored-' + str(index))
            b.restore_repository(bundle / exported['path'], exported, clone)
            self.assertEqual(b.run(['git', '-C', clone, 'show', 'HEAD:proof']), '1')
        self.assertEqual((self.root / 'restored-0/shallow').read_text(), boundary)
        b.verify(bundle)

    def test_invalid_shallow_metadata_is_rejected(self):
        for boundaries in ['not-a-list', ['../shallow'], [None], ['a' * 41]]:
            with self.assertRaisesRegex(ValueError, 'Invalid shallow boundaries'):
                b.restore_repository(self.root / 'absent.bundle', {'shallow': boundaries}, self.root / 'restore')

    def test_legacy_manifest_still_verifies(self):
        bundle, manifest = b.capture(self.c)
        manifest['version'] = 1
        b.atomic_json(bundle / 'manifest.json', manifest)
        self.assertEqual(b.verify(bundle)['version'], 1)

    def test_failed_repository_is_attempted_once_per_capture(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE threads SET repo='/missing'")
            db.execute("INSERT INTO threads VALUES ('second', 'claude', NULL, '/fixture', '/missing')")
        with patch.object(b, 'run', side_effect=ValueError('repository unavailable')) as run:
            _, manifest = b.capture(self.c)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(len(manifest['coverage']['not_recoverable']), 2)

    def test_sqlite_snapshot_failure_cleans_staging(self):
        with patch.object(b, 'db_open', side_effect=sqlite3.OperationalError('database is locked')):
            with self.assertRaises(sqlite3.OperationalError):
                b.backup_once(self.c)
        self.assertEqual([p for p in Path(self.c['spool']).iterdir() if p.is_dir()], [])

    def test_remote_retention_preserves_replica_pointer_and_cleans_partial(self):
        bundles = []
        for _ in range(6):
            bundles.append(b.capture(self.c)[0])
        root = Path(self.c['spool'])
        stale = root / ('.partial-' + 'f' * 32)
        stale.mkdir()
        (stale / 'unfinished').write_text('data')
        unrelated = root / 'manual-copy'
        unrelated.mkdir()
        prepared = b.remote_prepare(root, bundles[-1].name)
        self.assertTrue(prepared['published'])
        self.assertFalse(stale.exists())
        protected = bundles[0].name
        b.remote_prune(root, 2, [protected, bundles[-1].name])
        self.assertEqual({p.name for p in bundles if p.exists()},
                         {protected, bundles[-2].name, bundles[-1].name})
        self.assertTrue(unrelated.exists())
        # With one verified copy it can never be deleted.
        b.remote_prune(root, 1, [protected])
        self.assertTrue(bundles[-1].exists())
        self.assertTrue(bundles[0].exists())

    def test_publish_resumes_after_remote_rename_and_locked_pointer(self):
        b.init_markers(self.db)
        self.c.update(destination=str(self.root / 'mini'), ssh='fixture',
                      remote_script='/script', remote_litestream='/litestream')
        uploads = []
        def remote(c, args):
            command = args[2]
            if command == 'prepare':
                return json.dumps(b.remote_prepare(args[3], args[4]))
            if command == 'finalize':
                return json.dumps(b.remote_finalize(args[3], args[4]))
            return '{}'
        def upload(args):
            uploads.append(args)
            source = args[-2]
            ident = Path(source).name
            shutil.copytree(source, Path(self.c['destination']) / 'bundles' / ('.partial-' + ident))
        original = b.db_open
        def locked(p, write=False):
            if write and Path(p) == self.db:
                raise sqlite3.OperationalError('database is locked')
            return original(p, write)
        with patch.object(b, 'remote', side_effect=remote), patch.object(b, 'run', side_effect=upload):
            with patch.object(b, 'db_open', side_effect=locked):
                with self.assertRaises(sqlite3.OperationalError):
                    b.backup_once(self.c)
            pending = b.last_good(self.c, 'pending.json')
            self.assertTrue((Path(self.c['destination']) / 'bundles' / pending.name).exists())
            bundle, manifest = b.backup_once(self.c)
            self.assertEqual(bundle, pending)
            self.assertEqual(len(uploads), 1)
            b.publish(self.c, bundle, manifest)  # Duplicate acknowledgement is safe.
            self.assertEqual(len(uploads), 1)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM loom_recovery_bundles').fetchone()[0], 1)

    def test_sqlite_failures_and_backoff_survive_service_restart(self):
        self.c.update(litestream='litestream', remote_litestream='remote',
                      host='fixture', user='fixture', key_path='/key', host_key='ssh-key',
                      destination='/fixture', remote_script='/script')
        now = time.time()
        probe = {'marker': {'at': now}, 'bundle': {'captured_at': now}, 'free_bytes': 10**15}
        for failing in ['mark', 'backup_once']:
            Path(self.c['spool']).mkdir(exist_ok=True)
            (Path(self.c['spool']) / 'retry.json').unlink(missing_ok=True)
            with patch.object(b, 'run', return_value=b.LITESTREAM_VERSION), \
                 patch.object(b.subprocess, 'Popen') as popen, \
                 patch.object(b, 'remote', return_value=json.dumps(probe)), \
                 patch.object(b, failing, side_effect=sqlite3.OperationalError('database is locked')) as action, \
                 patch.object(b.signal, 'signal'), patch.object(b.time, 'sleep'), \
                 patch.object(b.time, 'time', return_value=now), patch('builtins.print'):
                for _ in range(2):
                    popen.return_value.poll.side_effect = [None, None, 1]
                    with self.assertRaisesRegex(RuntimeError, 'Litestream exited'):
                        b.service(self.c)
                state = b.load_retry(self.c)
                self.assertEqual(state['failures'], 1)
                self.assertEqual(state['next_attempt_at'], now + 60)
                self.assertIn('database is locked', state['error'])
                if failing == 'backup_once':
                    self.assertEqual(action.call_count, 1)

    def test_foreign_key_corruption_rejected(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO attachments VALUES ('a', 'absent', '/missing')")
        with self.assertRaisesRegex(ValueError, 'foreign-key'):
            b.check_db(self.db)

    def test_git_checkpoint_objects_survive_bundle(self):
        repo = self.root / 'repo'
        b.run(['git', 'init', str(repo)])
        b.run(['git', '-C', repo, 'config', 'user.name', 'Recovery Fixture'])
        b.run(['git', '-C', repo, 'config', 'user.email', 'fixture@example.invalid'])
        (repo / 'tracked').write_text('checkpoint content')
        b.run(['git', '-C', repo, 'add', '.'])
        b.run(['git', '-C', repo, 'commit', '-m', 'fixture'])
        sha = b.run(['git', '-C', repo, 'rev-parse', 'HEAD'])
        b.run(['git', '-C', repo, 'update-ref', 'refs/loom/checkpoints/fake', sha])
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE threads SET repo=?', (str(repo),))
        bundle, m = b.capture(self.c)
        self.assertEqual(m['threads'][0]['checkpoint'], sha)
        b.atomic_json(Path(self.c['spool']) / 'last-good.json', {'id': m['id']})
        second, m2 = b.capture(self.c)
        self.assertEqual((bundle / m['repositories'][0]['path']).stat().st_ino,
                         (second / m2['repositories'][0]['path']).stat().st_ino)
        (repo / 'tracked').write_text('new checkpoint')
        b.run(['git', '-C', repo, 'commit', '-am', 'second'])
        third, m3 = b.capture(self.c)
        self.assertNotEqual((bundle / m['repositories'][0]['path']).stat().st_ino,
                            (third / m3['repositories'][0]['path']).stat().st_ino)

        clone = self.root / 'restored.git'
        b.run(['git', 'clone', '--mirror', bundle / m['repositories'][0]['path'], clone])
        self.assertEqual(b.run(['git', '-C', clone, 'show', sha + ':tracked']), 'checkpoint content')
        b.run(['git', '-C', clone, 'fsck', '--full'])

    def sibling_checkpoint_fixture(self):
        repo = self.root / 'repo'
        b.run(['git', 'init', str(repo)])
        b.run(['git', '-C', repo, 'config', 'user.name', 'Recovery Fixture'])
        b.run(['git', '-C', repo, 'config', 'user.email', 'fixture@example.invalid'])
        (repo / 'tracked').write_text('base')
        b.run(['git', '-C', repo, 'add', '.'])
        b.run(['git', '-C', repo, 'commit', '-m', 'base'])
        parent = b.run(['git', '-C', repo, 'rev-parse', 'HEAD'])
        tree = b.run(['git', '-C', repo, 'rev-parse', 'HEAD^{tree}'])
        old = b.run(['git', '-C', repo, 'commit-tree', tree, '-p', parent, '-m', 'old checkpoint'])
        (repo / 'tracked').write_text('new checkpoint content')
        b.run(['git', '-C', repo, 'add', '.'])
        new_tree = b.run(['git', '-C', repo, 'write-tree'])
        new = b.run(['git', '-C', repo, 'commit-tree', new_tree, '-p', parent, '-m', 'new checkpoint'])
        ref = 'refs/loom/checkpoints/fake'
        b.run(['git', '-C', repo, 'update-ref', ref, old])
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE threads SET repo=?', (str(repo),))
            db.execute('CREATE TABLE checkpoints(thread_id TEXT, at INTEGER, tree TEXT, ref TEXT)')
            db.execute('INSERT INTO checkpoints VALUES (?, ?, ?, ?)', ('fake', 1, tree, old))
        return repo, ref, old, new, new_tree

    def test_latest_sibling_checkpoint_covers_thread_without_history(self):
        repo, ref, old, new, tree = self.sibling_checkpoint_fixture()
        b.run(['git', '-C', repo, 'update-ref', ref, new])
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO checkpoints VALUES (?, ?, ?, ?)', ('fake', 2, tree, new))
        bundle, manifest = b.capture(self.c)
        self.assertTrue(manifest['complete'])
        self.assertEqual(manifest['threads'][0]['recorded_checkpoints'], [new])
        self.assertEqual(manifest['coverage']['covered'], ['fake'])
        objects = b.bundled_commits(bundle / manifest['repositories'][0]['path'], {old, new})
        self.assertEqual(objects, {new})

    def test_checkpoint_ref_moves_after_database_snapshot(self):
        repo, ref, old, new, _ = self.sibling_checkpoint_fixture()
        _, before = b.capture(self.c)
        self.assertTrue(before['threads'][0]['complete'])
        original = b.check_db
        def interleave(path):
            result = original(path)
            b.run(['git', '-C', repo, 'update-ref', ref, new])
            return result
        with patch.object(b, 'check_db', side_effect=interleave):
            bundle, after = b.capture(self.c)
        item = after['threads'][0]
        self.assertEqual(item['recorded_checkpoints'], [old])
        self.assertEqual(item['recoverability'], 'covered')
        self.assertEqual(item['errors'], [])
        self.assertEqual(after['coverage']['not_recoverable'], [])
        self.assertEqual(b.bundled_commits(bundle / after['repositories'][0]['path'], {old, new}), {old, new})
        b.verify(bundle)

    def test_unreferenced_checkpoint_export_and_cache_without_source_mutation(self):
        repo, ref, old, new, tree = self.sibling_checkpoint_fixture()
        b.run(['git', '-C', repo, 'update-ref', ref, new])
        refs = b.run(['git', '-C', repo, 'show-ref', '--head'])
        bundle, manifest = b.capture(self.c)
        self.assertTrue(manifest['complete'])
        exported = bundle / manifest['repositories'][0]['path']
        self.assertEqual(b.bundled_commits(exported, {old, new}), {old, new})
        b.atomic_json(Path(self.c['spool']) / 'last-good.json', {'id': manifest['id']})
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO checkpoints VALUES (?, ?, ?, ?)', ('fake', 2, tree, new))
        _, changed = b.capture(self.c)
        self.assertNotEqual(manifest['repositories'][0]['fingerprint'], changed['repositories'][0]['fingerprint'])
        self.assertEqual(refs, b.run(['git', '-C', repo, 'show-ref', '--head']))
        shutil.rmtree(repo)
        b.restore_repository(exported, manifest['repositories'][0], self.root / 'offline')
        self.assertEqual(b.run(['git', '-C', self.root / 'offline', 'cat-file', '-t', old]), 'commit')

    def test_capture_restored_repository_with_backup_refs(self):
        repo, ref, old, new, _ = self.sibling_checkpoint_fixture()
        b.run(['git', '-C', repo, 'update-ref', ref, new])
        first, manifest = b.capture(self.c)
        restored = self.root / 'restored'
        b.restore_repository(first / manifest['repositories'][0]['path'], manifest['repositories'][0], restored)
        self.assertEqual(b.run(['git', '-C', restored, 'rev-parse', 'refs/loom-backup/' + old]), old)
        shutil.rmtree(repo)
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE threads SET repo=?', (str(restored),))
        second, captured = b.capture(self.c)
        self.assertTrue(captured['complete'])
        self.assertEqual(captured['coverage']['covered'], ['fake'])
        final = self.root / 'restored-again'
        b.restore_repository(second / captured['repositories'][0]['path'], captured['repositories'][0], final)
        self.assertEqual(b.run(['git', '-C', final, 'rev-parse', 'refs/loom-backup/' + old]), old)

    def test_missing_checkpoint_remains_gap(self):
        repo, ref, old, new, tree = self.sibling_checkpoint_fixture()
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE checkpoints SET ref=?', ('f' * 40,))
        _, manifest = b.capture(self.c)
        self.assertEqual(manifest['coverage']['not_recoverable'], ['fake'])
        self.assertIn('Snapshot checkpoint inclusion not verified', manifest['threads'][0]['errors'][0])

    def test_audited_exclusion_does_not_hide_other_gaps(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO threads VALUES ('missing', 'claude', 'absent', '/fixture', NULL)")
        self.c['excluded_threads'] = {'fake': 'Completed disposable recovery fixture'}
        _, manifest = b.capture(self.c)
        self.assertFalse(manifest['complete'])
        self.assertEqual(manifest['coverage']['excluded_by_policy'], ['fake'])
        self.assertEqual(manifest['coverage']['not_recoverable'], ['missing'])

    def test_traversal_and_symlinks_rejected(self):
        for rel in ['../escape', '/absolute']:
            with self.assertRaises(ValueError):
                b.safe_child(self.root, rel)
        (self.root / 'link').symlink_to(self.transcript)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            b.safe_child(self.root, 'link')

    def test_lag_space_and_unavailable_are_alerts(self):
        source = {'at': 1000, 'token': 'new'}
        probe = {'marker': {'at': 800}, 'bundle': {'captured_at': -999}, 'free_bytes': 10}
        self.assertEqual(b.health(source, None, 1000, 100, 50)['alerts'], ['replica_unavailable'])
        self.assertEqual(set(b.health(source, probe, 1000, 100, 50)['alerts']),
                         {'replica_lag', 'destination_low_space', 'recovery_bundle_stale'})
        probe.update(marker={'at': 999}, bundle={'captured_at': 900}, free_bytes=1000)
        self.assertTrue(b.health(source, probe, 1000, 100, 50)['ok'])

    def test_space_warning_alerts_without_the_pause_alarm(self):
        source = {'at': 1000, 'token': 'new'}
        probe = {'marker': {'at': 999}, 'bundle': {'captured_at': 900}, 'free_bytes': 75}
        warned = b.health(source, probe, 1000, 100, 50)
        self.assertEqual(warned['alerts'], ['destination_space_warn'])
        self.assertFalse(warned['ok'])
        self.assertEqual(warned['free_bytes'], 75)
        probe['free_bytes'] = 49
        self.assertEqual(b.health(source, probe, 1000, 100, 50)['alerts'], ['destination_low_space'])
        self.assertEqual(b.STOP_CAPTURE & {'destination_space_warn'}, set())

    def test_space_floors_and_config_layout(self):
        self.assertEqual(b.space_floors({}), (20 * b.GIB, 5 * b.GIB))
        # Legacy min_free_bytes is the warning floor; the pause floor stays at 5 GiB.
        self.assertEqual(b.space_floors({'min_free_bytes': 20 * b.GIB}), (20 * b.GIB, 5 * b.GIB))
        self.assertEqual(b.space_floors({'warn_free_bytes': 30, 'pause_free_bytes': 10}), (30, 10))
        base = {'db': '/a/db', 'home': '/a', 'spool': '/a/spool', 'litestream': '/a/ls', 'ssh': 'me@mini',
                'host': 'mini:22', 'user': 'me', 'key_path': '/a/key', 'host_key': 'ssh-ed25519 AAA'}
        path = self.root / 'config.json'
        def load(**kw):
            path.write_text(json.dumps({**base, **kw}))
            return b.load_config(path)
        c = load(remote_root='/m/loom-recovery', destination='/m/loom-recovery/destinations/20261023T213000Z')
        self.assertEqual(c['remote_script'], '/m/loom-recovery/bin/loom_backup.py')
        self.assertEqual(c['remote_litestream'], '/m/loom-recovery/bin/litestream')
        self.assertEqual(b.destination_host(c), 'mini')
        with self.assertRaisesRegex(ValueError, 'destinations/<YYYYMMDDTHHMMSSZ>'):
            load(remote_root='/m/loom-recovery', destination='/m/loom-recovery-live-20261023T2130-reseed')
        with self.assertRaisesRegex(ValueError, 'outside the destination'):
            load(destination='/m/live', remote_script='/m/live/tools/loom_backup.py', remote_litestream='/m/bin/ls')
        with self.assertRaisesRegex(ValueError, 'pause_free_bytes'):
            load(destination='/m/live', remote_script='/m/bin/x.py', remote_litestream='/m/bin/ls',
                 warn_free_bytes=10, pause_free_bytes=20)
        self.assertEqual(b.space_floors(load(destination='/m/live', remote_script='/m/bin/x.py', remote_litestream='/m/bin/ls',
                                             min_free_bytes=21474836480)), (20 * b.GIB, 5 * b.GIB))

    def test_prune_destinations_keeps_current_previous_tooling_and_unknown(self):
        root = self.root / 'mini'
        (root / 'bin').mkdir(parents=True)
        (root / 'bin' / 'loom_backup.py').write_text('live tooling')
        dest = root / 'destinations'
        names = ['20261001T000000Z', '20261010T000000Z', '20261020T000000Z', '20261023T213000Z', '20261030T000000Z']
        for n in names:
            (dest / n / 'replica').mkdir(parents=True)
        (dest / 'notes').mkdir()
        (dest / '20260901T000000Z').symlink_to(root / 'bin')
        current = dest / '20261023T213000Z'
        with patch.object(b, 'probe_replica', return_value={'bundle': {'id': 'x'}}) as probe:
            result = b.remote_prune_destinations('/ls', root, current, 1)
        probe.assert_called_once_with('/ls', current / 'replica', current)
        self.assertEqual(result['deleted'], ['20261010T000000Z', '20261001T000000Z'])
        self.assertEqual(result['kept'], ['20261020T000000Z'])
        self.assertEqual(sorted(p.name for p in dest.iterdir()),
                         ['20260901T000000Z', '20261020T000000Z', '20261023T213000Z', '20261030T000000Z', 'notes'])
        self.assertEqual((root / 'bin' / 'loom_backup.py').read_text(), 'live tooling')
        # An unverified new destination never deletes its predecessor.
        with patch.object(b, 'probe_replica', return_value={'bundle': None}), \
             self.assertRaisesRegex(ValueError, 'no committed bundle'):
            b.remote_prune_destinations('/ls', root, current, 1)
        with patch.object(b, 'probe_replica', side_effect=AssertionError('not probed')), \
             self.assertRaisesRegex(ValueError, 'not a generated destination'):
            b.remote_prune_destinations('/ls', root, root / 'bin', 1)
        self.assertTrue((dest / '20261020T000000Z').exists())

    def test_prune_superseded_runs_once_per_destination_and_backs_off_failures(self):
        self.c.update(remote_root='/m', destination='/m/destinations/20261023T213000Z', ssh='mini',
                      remote_script='/m/bin/loom_backup.py', remote_litestream='/m/bin/litestream')
        Path(self.c['spool']).mkdir()
        self.assertIsNone(b.prune_superseded({**self.c, 'remote_root': None}, 0))
        with patch.object(b, 'remote', side_effect=b.subprocess.CalledProcessError(1, 'ssh')) as remote:
            self.assertIn('destination prune failed', b.prune_superseded(self.c, 1000))
            self.assertIn('destination prune failed', b.prune_superseded(self.c, 1100))
            self.assertEqual(remote.call_count, 1)
        with patch.object(b, 'remote', return_value=json.dumps({'deleted': ['old']})) as remote:
            self.assertIsNone(b.prune_superseded(self.c, 1000 + b.PRUNE_RETRY_SECONDS))
            self.assertIsNone(b.prune_superseded(self.c, 2000))
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(remote.call_args[0][1][2:], ['prune-destinations', '/m/bin/litestream', '/m',
                                                          '/m/destinations/20261023T213000Z', '1'])
            self.c['destination'] = '/m/destinations/20261024T000000Z'
            b.prune_superseded(self.c, 2001)
            self.assertEqual(remote.call_count, 2)

    def test_rotate_points_config_at_a_new_dated_destination_only_when_stopped(self):
        import fcntl
        base = {'db': str(self.db), 'home': str(self.root), 'spool': str(self.root / 'spool'), 'litestream': '/a/ls',
                'ssh': 'me@mini', 'host': 'mini:22', 'user': 'me', 'key_path': '/a/key', 'host_key': 'ssh-ed25519 AAA',
                'remote_root': '/m/loom-recovery', 'destination': '/m/loom-recovery/destinations/20261023T213000Z'}
        path = self.root / 'config.json'
        path.write_text(json.dumps(base))
        Path(base['spool']).mkdir()
        with (Path(base['spool']) / 'service.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'Stop the backup service'):
                b.rotate_destination(path, now=1792900000)
        result = b.rotate_destination(path, now=1792900000)
        self.assertEqual(result, {'previous': base['destination'],
                                  'destination': '/m/loom-recovery/destinations/20261025T034640Z'})
        self.assertEqual(b.read_json(path)['destination'], result['destination'])
        self.assertNotIn('remote_script', b.read_json(path))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_restore_uses_committed_bundle_and_reports_corrupt_latest(self):
        b.init_markers(self.db)
        b.mark(self.db)
        good, good_m = b.capture(self.c)
        bad, bad_m = b.capture(self.c)
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            for i, (bundle, m) in enumerate([(good, good_m), (bad, bad_m)]):
                db.execute('INSERT INTO loom_recovery_bundles VALUES (?, ?, ?, ?)',
                           (m['id'], b.digest(bundle / 'manifest.json'), m['captured_at'], time.time() + i))
        (bad / 'manifest.json').write_text('{}')
        # Also leave a perfectly valid but UNCOMMITTED newer bundle: it is ineligible.
        uncommitted, _ = b.capture(self.c)
        def litestream(args):
            self.assertEqual(args[1], 'restore')
            with contextlib.closing(sqlite3.connect(self.db)) as src, contextlib.closing(sqlite3.connect(args[3])) as dest:
                src.backup(dest)
        output = self.root / 'restored'
        with patch.object(b, 'run', side_effect=litestream):
            report = b.restore('litestream', '/replica', self.c['spool'], output)
        self.assertEqual(report['bundle_id'], good_m['id'])
        self.assertEqual(report['skipped_bundles'], ['Manifest hash mismatch'])
        self.assertFalse(report['tools_started'])
        self.assertFalse(report['triggers_started'])
        self.assertTrue(report['newer_database_requires_reconciliation'])
        self.assertTrue((output / 'replicated.sqlite').exists())
        self.assertTrue((output / 'sandbox.sqlite').exists())
        with self.assertRaises(FileExistsError):
            b.restore('litestream', '/replica', self.c['spool'], output)

    def test_unknown_provider_and_credential_companion_fail_coverage(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE threads SET provider='unsupported'")
        _, m = b.capture(self.c)
        self.assertFalse(m['complete'])
        secret = self.root / '.env'
        secret.write_text('invented fixture')
        with self.assertRaisesRegex(ValueError, 'Credential file excluded'):
            b.copy_file(secret, self.root, 'copy', [])
        self.assertFalse((self.root / 'copy').exists())

    def test_failed_publish_does_not_commit_pointer(self):
        b.init_markers(self.db)
        bundle, m = b.capture(self.c)
        self.c.update(destination='/fixture', ssh='fixture', remote_script='/fixture/script', remote_litestream='/fixture/litestream')
        with patch.object(b, 'remote', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                b.publish(self.c, bundle, m)
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM loom_recovery_bundles').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
