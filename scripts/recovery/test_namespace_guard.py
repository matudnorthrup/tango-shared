import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import namespace_guard as g
import monitor
import loom_backup as backup


class NamespaceGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'remote/destination'
        self.root.mkdir(parents=True)
        self.spool = self.base / 'local/spool'
        self.spool.mkdir(parents=True)
        self.tool = self.base / 'remote/backup.py'
        self.tool.write_text('backup tool')
        self.binary = self.base / 'remote/litestream'
        self.binary.write_text('binary')
        self.ident = 'a' * 32
        for folder in [self.spool, self.root / 'bundles']:
            (folder / self.ident).mkdir(parents=True)
            (folder / self.ident / 'manifest.json').write_text('{"fixture":true}')
        (self.spool / 'last-good.json').write_text(json.dumps({'id': self.ident}))
        self.c = dict(ssh='fixture.invalid', destination=str(self.root), spool=str(self.spool),
                      remote_script=str(self.tool), remote_litestream=str(self.binary))
        self.state = self.base / 'guard.json'
        self.real_run = subprocess.run
        self.events = []
        def run(args, **kwargs):
            if args[0] == 'ssh':
                import shlex
                cmd = shlex.split(args[-1])
                cmd[0] = sys.executable
                return self.real_run(cmd, **kwargs)
            if args[0] == '/fixture/event':
                self.events.append(args)
                return subprocess.CompletedProcess(args, 0, '', '')
            return self.real_run(args, **kwargs)
        self.mock_run = patch.object(g.subprocess, 'run', side_effect=run).start()
        self.addCleanup(patch.stopall)
        g.enroll(self.c, self.state)

    def check(self):
        return g.check(self.c, self.state, '/fixture/event')

    def test_state_inside_protected_root_is_refused(self):
        with self.assertRaisesRegex(ValueError, "outside the protected root"):
            g.enroll(self.c, self.root / "state.json")

    def test_healthy_and_refuses_reenrollment(self):
        self.assertTrue(self.check()['ok'])
        self.assertEqual(self.events, [])
        with self.assertRaisesRegex(ValueError, 'already exists'):
            g.enroll(self.c, self.state)
        self.state.unlink()
        with self.assertRaises(subprocess.CalledProcessError):
            g.enroll(self.c, self.state)

    def test_root_removed_recreated_and_restart_remain_one_latched_alert(self):
        last = g.read_json(self.state)['last_seen_at']
        shutil.rmtree(self.root)
        first = self.check()
        self.assertIn('root_missing_or_symlink', first['incident']['failures'])
        self.assertEqual(first['incident']['last_seen_at'], last)
        self.root.mkdir()
        (self.root / g.CANARY).write_text('replacement identity')
        second = self.check()
        self.assertEqual(first['incident'], second['incident'])
        self.assertFalse(second['ok'])
        self.assertEqual(len(self.events), 1)
        self.assertEqual(g.read_json(self.state)['incident']['last_good_marker']['id'], self.ident)

    def test_missing_canary_is_never_recreated(self):
        (self.root / g.CANARY).unlink()
        self.assertFalse(self.check()['ok'])
        self.assertFalse((self.root / g.CANARY).exists())
        self.check()
        self.assertEqual(len(self.events), 1)

    def test_tool_replacement_is_latched_even_after_restoration(self):
        self.tool.write_text('changed')
        result = self.check()
        self.assertIn('tools_missing_or_changed', result['incident']['failures'])
        self.tool.write_text('backup tool')
        self.assertFalse(self.check()['ok'])
        self.assertEqual(len(self.events), 1)

    def test_missing_tool_does_not_disable_remote_probe(self):
        self.tool.unlink()
        self.assertIn('tools_missing_or_changed', self.check()['incident']['failures'])

    def test_new_successful_publication_updates_last_good_marker(self):
        ident = 'b' * 32
        for folder in [self.spool, self.root / 'bundles']:
            (folder / ident).mkdir()
            (folder / ident / 'manifest.json').write_text('{"new":true}')
        (self.spool / 'last-good.json').write_text(json.dumps({'id': ident}))
        self.assertTrue(self.check()['ok'])
        self.assertEqual(g.read_json(self.state)['last_good_marker']['id'], ident)

    def test_publication_prunes_manifest_between_pointer_and_read(self):
        ident = 'b' * 32
        for folder in [self.spool, self.root / 'bundles']:
            (folder / ident).mkdir()
            (folder / ident / 'manifest.json').write_text('{"new":true}')
        original = Path.read_bytes
        old = self.spool / self.ident / 'manifest.json'
        def read_bytes(path):
            if path == old:
                with backup.bundle_lock(self.c):
                    backup.atomic_json(self.spool / 'last-good.json', {'id': ident})
                    backup.prune_local(self.c)
            return original(path)
        with patch.object(Path, 'read_bytes', read_bytes):
            self.assertTrue(self.check()['ok'])
        self.assertFalse(old.exists())
        self.assertTrue(self.check()['ok'])
        self.assertEqual(g.read_json(self.state)['last_good_marker']['id'], ident)
        self.assertEqual(self.events, [])

    def test_continuous_publication_defers_without_latching(self):
        original = Path.read_bytes
        generation = 0
        def read_bytes(path):
            nonlocal generation
            if path.parent.parent == self.spool:
                generation += 1
                ident = format(generation, '032x')
                (self.spool / ident).mkdir()
                (self.spool / ident / 'manifest.json').write_text('{}')
                with backup.bundle_lock(self.c):
                    backup.atomic_json(self.spool / 'last-good.json', {'id': ident})
                    backup.prune_local(self.c)
            return original(path)
        with patch.object(Path, 'read_bytes', read_bytes):
            self.assertEqual(self.check()['alerts'], ['namespace_guard_unavailable'])
        self.assertEqual(generation, 3)
        self.assertIsNone(g.read_json(self.state)['incident'])
        self.assertEqual(self.events, [])

    def test_missing_current_local_manifest_still_latches(self):
        (self.spool / self.ident / 'manifest.json').unlink()
        self.assertIn('last_good_marker_unavailable', self.check()['incident']['failures'])
        self.assertEqual(len(self.events), 1)

    def test_remote_retention_during_publication_does_not_latch(self):
        ident = 'b' * 32
        for folder in [self.spool, self.root / 'bundles']:
            (folder / ident).mkdir()
            (folder / ident / 'manifest.json').write_text('{"new":true}')
        with backup.bundle_lock(self.c):
            # Remote retention removes the old bundle before the local commit.
            shutil.rmtree(self.root / 'bundles' / self.ident)
            self.assertTrue(self.check()['ok'])
            self.assertIsNone(g.read_json(self.state)['incident'])
            self.assertEqual(g.read_json(self.state)['last_good_marker']['id'], self.ident)
            backup.atomic_json(self.spool / 'last-good.json', {'id': ident})
            backup.prune_local(self.c)
        self.assertTrue(self.check()['ok'])
        self.assertEqual(g.read_json(self.state)['last_good_marker']['id'], ident)
        self.assertEqual(self.events, [])

    def test_busy_publisher_does_not_hide_identity_loss(self):
        with backup.bundle_lock(self.c):
            shutil.rmtree(self.root / 'bundles' / self.ident)
            (self.root / g.CANARY).unlink()
            result = self.check()
        self.assertIn('identity_missing_or_replaced', result['incident']['failures'])
        self.assertNotIn('last_good_manifest_missing_or_changed', result['incident']['failures'])
        self.assertEqual(len(self.events), 1)

    def test_publication_finishes_before_manifest_confirmation(self):
        ident = 'b' * 32
        for folder in [self.spool, self.root / 'bundles']:
            (folder / ident).mkdir()
            (folder / ident / 'manifest.json').write_text('{"new":true}')
        observe = g.observe
        def racing_observe(binding, marker):
            if marker['id'] == self.ident:
                with backup.bundle_lock(self.c):
                    shutil.rmtree(self.root / 'bundles' / self.ident)
                    backup.atomic_json(self.spool / 'last-good.json', {'id': ident})
                    backup.prune_local(self.c)
            else:
                # Confirmation holds the same lock as the publisher.
                with self.assertRaises(BlockingIOError):
                    with backup.bundle_lock(self.c):
                        pass
            return observe(binding, marker)
        with patch.object(g, 'observe', side_effect=racing_observe):
            self.assertTrue(self.check()['ok'])
        self.assertEqual(g.read_json(self.state)['last_good_marker']['id'], ident)
        self.assertEqual(self.events, [])

    def test_last_good_manifest_loss(self):
        (self.root / 'bundles' / self.ident / 'manifest.json').unlink()
        self.assertIn('last_good_manifest_missing_or_changed', self.check()['incident']['failures'])

    def test_transport_failure_is_unknown_not_deletion(self):
        with patch.object(g, 'observe', side_effect=subprocess.TimeoutExpired('ssh', 40)):
            result = self.check()
        self.assertEqual(result['alerts'], ['namespace_guard_unavailable'])
        self.assertIsNone(g.read_json(self.state)['incident'])
        self.assertTrue(self.check()['ok'])

    def test_target_rotation_requires_explicit_enrollment(self):
        self.c['destination'] += '-new'
        self.assertEqual(self.check()['incident']['failures'], ['configured_target_changed'])

    def test_failed_delivery_retries_persisted_latch(self):
        (self.root / g.CANARY).unlink()
        run = self.mock_run.side_effect
        def failed_event(args, **kwargs):
            if args[0] == '/fixture/event':
                raise subprocess.CalledProcessError(1, 'event')
            return run(args, **kwargs)
        with patch.object(g.subprocess, 'run', side_effect=failed_event):
            with self.assertRaises(subprocess.CalledProcessError):
                self.check()
        self.assertFalse(g.read_json(self.state)['notified'])
        self.check()
        self.check()
        self.assertEqual(len(self.events), 1)

    def test_symlink_canary_is_not_accepted(self):
        canary = self.root / g.CANARY
        copy = self.base / 'copied-identity'
        canary.rename(copy)
        canary.symlink_to(copy)
        self.assertIn('identity_missing_or_replaced', self.check()['incident']['failures'])

    def test_monitor_checks_canary_with_broken_backup_script(self):
        config = self.base / 'config.json'
        config.write_text(json.dumps(self.c))
        monitor_state = self.base / 'monitor.json'
        (self.root / g.CANARY).unlink()
        for _ in range(2):
            result = monitor.tick(config, monitor_state, self.state, self.base / 'absent.py', '/fixture/event')
            self.assertFalse(result['ok'])
        self.assertEqual(sum(g.KIND in event for event in self.events), 1)
        self.assertEqual(sum('recovery.health' in event for event in self.events), 1)
        self.assertFalse((self.root / g.CANARY).exists())


if __name__ == '__main__':
    unittest.main()
