import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import plistlib
import http.server
import threading
import time

spec = importlib.util.spec_from_file_location('installer', Path(__file__).parents[1] / 'scripts/install-app.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TransactionTests(unittest.TestCase):
    def test_idle_gate_race_releases_then_succeeds(self):
        i = object.__new__(m.Installer)
        i.a = SimpleNamespace(timeout=1, idle_timeout=10, drain_timeout=1)
        clock = [0.0]
        state = {'on': False, 'reason': None}
        posts, events = [], []
        i.record = lambda event, **data: events.append(event)
        def api(route, body=None):
            if body is not None:
                posts.append(body.copy())
                state.update(body)
            # First engagement races with a new turn, second is idle.
            running = 1 if state['on'] and len(posts) == 1 else 0
            return dict(state, running=running)
        i.api = api
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(m.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0] + n)):
            i.acquire_idle({'on': False})
        self.assertEqual([p['on'] for p in posts], [True, False, True])
        self.assertEqual(events.count('drain-retry-released'), 1)
        self.assertEqual(events[-1], 'idle-acquired')

    def test_deadline_recovers_without_replacement_and_keeps_prior_state(self):
        for prior in (False, True):
            version, events, state = self.exercise(running=1, prior=prior)
            self.assertEqual(version, 'old')
            self.assertNotIn('stop', events)
            self.assertNotIn('rename', events)
            self.assertIn('idle-deadline-expired', events)
            self.assertIn('recovered', events)
            self.assertEqual(state['on'], prior)
            if prior:
                self.assertEqual(state['reason'], 'previous')

    def test_deadline_during_racing_turn_releases_maintenance(self):
        version, events, state = self.exercise(race=True)
        self.assertEqual(version, 'old')
        self.assertIn('idle-deadline-expired', events)
        self.assertIn('recovered', events)
        self.assertNotIn('stop', events)
        self.assertFalse(state['on'])

    def test_external_changes_during_idle_are_never_restored(self):
        for prior in (False, True):
            def change(state, body, events):
                if 'waiting-for-idle' in events:
                    state.update(on=not prior, reason='external')
            version, events, state = self.exercise(prior=prior, maintenance_hook=change)
            self.assertEqual(version, 'old')
            self.assertEqual(state['on'], not prior)
            self.assertEqual(state['posts'], [])
            self.assertIn('maintenance-changed-externally', events)
            self.assertIn('recovered', events)
            self.assertNotIn('recovery-failed-maintenance-retained', events)

    def test_external_changes_during_drain_are_never_restored(self):
        for prior in (False, True):
            for external_on in (False, True):
                def change(state, body, events):
                    if 'maintenance-confirmed' in events:
                        state.update(on=external_on, reason='external')
                version, events, state = self.exercise(prior=prior, maintenance_hook=change)
                self.assertEqual(version, 'old')
                self.assertEqual(state['on'], external_on)
                self.assertEqual(state['reason'], 'external')
                self.assertEqual(state['posts'], [{'on': True, 'reason': 'Tango.app installation'}])
                self.assertIn('recovered', events)
                self.assertNotIn('stop', events)

    def test_release_checks_ownership_again(self):
        i = object.__new__(m.Installer)
        i.maintenance_held = True
        i.a = SimpleNamespace(timeout=1)
        i.record = lambda *args, **kwargs: None
        with patch.object(i, 'api', return_value={'on': True, 'reason': 'external'}) as api:
            self.assertFalse(i.restore_maintenance({'on': False}, True))
        self.assertEqual(api.call_args_list, [unittest.mock.call('/maintenance')])
        self.assertFalse(i.maintenance_held)

    def test_null_prior_reason_preserved(self):
        _, events, state = self.exercise(prior=True, prior_reason=None)
        self.assertIn('complete', events)
        self.assertIsNone(state['reason'])

    def test_main_exits_two_for_deadline(self):
        with patch.object(m, 'run', side_effect=m.IdleDeadlineExpired('deadline')), \
             patch('sys.stderr'):
            with self.assertRaises(SystemExit) as caught:
                m.main()
        self.assertEqual(caught.exception.code, 2)

    def test_idle_and_drain_retry_transient_reads(self):
        for error in (m.urllib.error.HTTPError('fixture', 502, 'restart', {}, None),
                      m.http.client.RemoteDisconnected('closed'), TimeoutError('timeout')):
            for phase in ('idle', 'drain'):
                i = object.__new__(m.Installer)
                i.a = SimpleNamespace(timeout=1, idle_timeout=10, drain_timeout=2)
                i.record = lambda *args, **kwargs: None
                i.maintenance_held = False
                off = {'on': False, 'running': 0}
                on = {'on': True, 'reason': 'Tango.app installation', 'running': 0}
                responses = [error, off, {}, on, on] if phase == 'idle' else [off, {}, on, error, on]
                with patch.object(i, 'api', side_effect=responses), patch.object(m.time, 'sleep'):
                    i.acquire_idle(off)
                self.assertTrue(i.maintenance_held)

    def test_lost_engage_confirmation_recovers_possible_ownership(self):
        for failure in ('timeout', 'signal'):
            def lose_confirmation(state, body, events):
                if body is None and state['posts'] and 'failed' not in events:
                    if failure == 'signal':
                        raise RuntimeError('Installer interrupted by signal 15')
                    raise m.urllib.error.HTTPError('fixture', 502, 'confirmation lost', {}, None)
            version, events, state = self.exercise(maintenance_hook=lose_confirmation)
            self.assertEqual(version, 'old')
            self.assertFalse(state['on'])
            self.assertEqual([p['on'] for p in state['posts']], [True, False])
            self.assertIn('recovered', events)
            self.assertNotIn('stop', events)

    def test_retry_logs_are_rate_limited_without_skipping_probes(self):
        i = object.__new__(m.Installer)
        with patch.object(i, 'api', side_effect=TimeoutError('outage')) as api, \
             patch.object(i, 'record') as record, \
             patch.object(m.time, 'monotonic', side_effect=[0, 0.5, 29.5, 30, 30.5]):
            for _ in range(5):
                self.assertIsNone(i.poll_maintenance())
        self.assertEqual(api.call_count, 5)
        self.assertEqual(record.call_count, 2)

    def test_stop_accepts_response_after_term_grace(self):
        class SlowStop(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                time.sleep(10.2)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *args):
                pass

        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), SlowStop) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                i = object.__new__(m.Installer)
                i.token = 'fixture'
                i.a = SimpleNamespace(url=f'http://127.0.0.1:{server.server_port}', timeout=120)
                self.assertTrue(i.api('/services/worker/stop', {})['ok'])
            finally:
                server.shutdown()
                thread.join()

    def test_stop_budget_has_floor_and_honors_timeout(self):
        i = object.__new__(m.Installer)
        i.token = 'fixture'
        for configured, expected in [(0.01, 15), (240, 240)]:
            i.a = SimpleNamespace(url='http://127.0.0.1:1', timeout=configured)
            with patch.object(m.urllib.request.OpenerDirector, 'open') as request, patch.object(m.json, 'load', return_value={'ok':True}):
                i.api('/services/worker/stop', {})
                self.assertEqual(request.call_args.kwargs['timeout'], expected)
                i.api('/health')
                self.assertEqual(request.call_args.kwargs['timeout'], 10)

    def test_maintenance_lost_response_confirms_without_reposting(self):
        i = object.__new__(m.Installer)
        i.a = SimpleNamespace(timeout=0.01)
        i.record = lambda *a, **k: None
        error = m.urllib.error.HTTPError('fixture', 502, 'timeout', {}, None)
        with patch.object(i, 'api', side_effect=[error, {'on': False}]) as api:
            i.set_maintenance({'on': False})
            self.assertEqual(api.call_args_list, [unittest.mock.call('/maintenance', {'on': False}),
                                                 unittest.mock.call('/maintenance')])
        with patch.object(i, 'api', side_effect=lambda route, body=None: (_ for _ in ()).throw(error) if body else {'on': True}):
            with self.assertRaisesRegex(RuntimeError, 'maintenance state confirmation'):
                i.set_maintenance({'on': False})

    def test_transport_errors_use_bounded_confirmation_without_repost(self):
        for error in [m.http.client.RemoteDisconnected('closed'), ConnectionResetError(),
                      m.http.client.BadStatusLine('bad'), OSError('transport')]:
            for phase in ('post', 'get'):
                with self.subTest(error=type(error), phase=phase):
                    i = object.__new__(m.Installer)
                    i.a = SimpleNamespace(timeout=0.01)
                    i.record = lambda *a, **k: None
                    responses = [error, {'on': False}] if phase == 'post' else [{}, error, {'on': False}]
                    with patch.object(i, 'api', side_effect=responses) as api, patch.object(m.time, 'sleep'):
                        i.set_maintenance({'on': False})
                        self.assertEqual(sum(len(c.args) == 2 for c in api.call_args_list), 1)
                    with patch.object(i, 'api', side_effect=error), patch.object(m.time, 'sleep'):
                        with self.assertRaisesRegex(RuntimeError, 'maintenance state confirmation'):
                            i.set_maintenance({'on': False})

    def test_redirects_never_receive_bearer_token(self):
        received = []
        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/token-sink')
                self.end_headers()
            do_POST = do_GET
            def log_message(self, *args):
                pass
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Redirect) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                i = object.__new__(m.Installer)
                i.token = 'fixture'
                i.a = SimpleNamespace(url=f'http://127.0.0.1:{server.server_port}', timeout=1)
                for body in (None, {'on': False}):
                    with self.assertRaises(m.urllib.error.HTTPError) as caught:
                        i.api('/maintenance', body)
                    self.assertEqual(caught.exception.code, 302)
                self.assertEqual(received, ['/maintenance', '/maintenance'])
            finally:
                server.shutdown()
                thread.join()

    def test_release_failure_keeps_healthy_candidate_and_backup(self):
        version, events, state = self.exercise(failure='release')
        self.assertEqual(version, 'new')
        self.assertTrue(state['loaded'])
        self.assertTrue(state['on'])
        self.assertEqual(events.count('stop'), 1)
        self.assertNotIn('backup-restored', events)
        self.assertNotIn('complete', events)
        self.assertIn('healthy-install-maintenance-unconfirmed', events)

    def test_maintenance_auth_error_is_not_retried(self):
        i = object.__new__(m.Installer)
        with patch.object(i, 'api', side_effect=m.urllib.error.HTTPError('fixture', 401, 'unauthorized', {}, None)) as api:
            with self.assertRaises(m.urllib.error.HTTPError):
                i.set_maintenance({'on': False})
            self.assertEqual(api.call_count, 1)

    def exercise(self, failure=None, running=0, ack='worker', prior=False, race=False, maintenance_hook=None, prior_reason='previous'):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        target, source = root/'Tango.app', root/'new.app'
        for app, version in [(target, 'old'), (source, 'new')]:
            app.mkdir()
            (app/'version').write_text(version)
        (root/'token').write_text('fixture')
        plist = root/'fixture.plist'
        plist.write_bytes(plistlib.dumps({'Label':'fixture', 'ExitTimeOut':30,
            'ProgramArguments':[str(target/'Contents/MacOS/tango-server-node')]}))
        a = SimpleNamespace(target=str(target), source=str(source), token=str(root/'token'),
            label='fixture', login_label='fixture-login', plist=str(plist),
            url='http://127.0.0.1:1', timeout=0.01, idle_timeout=0.02, drain_timeout=0.01, interrupt_services=ack)
        i = m.Installer(a)
        events = []
        state = {'loaded':True, 'on':prior, 'reason':prior_reason, 'fail':failure, 'posts':[]}
        def record(event, **data):
            events.append(event)
            if failure == 'hangup':
                with patch('builtins.print', side_effect=OSError(5, 'terminal closed')):
                    m.Installer.record(i, event, **data)
                if event == 'failed':
                    for sig in (m.signal.SIGTERM, m.signal.SIGHUP):
                        self.assertEqual(m.signal.getsignal(sig), m.signal.SIG_IGN)
                        m.signal.raise_signal(sig)
        i.record = record
        i.owner = lambda: 123
        def preflight():
            if failure == 'outside-user':
                raise RuntimeError('Quit Tango.app')
        i.preflight_users = preflight
        i.unused = lambda app: True
        i.jobs = lambda: {'fixture'} if state['loaded'] else set()
        def verify(app):
            if failure == 'signature' and app == source:
                raise RuntimeError('bad signature')
            return (app/'version').read_text()
        i.verify = verify
        def run(*args, **kwargs):
            if args[0] == '/usr/bin/ditto':
                import shutil
                shutil.copytree(args[1], args[2])
            return SimpleNamespace(stdout='com.tango.server: not registered', returncode=0)
        i.run = run
        def api(route, body=None):
            if route == '/maintenance':
                if maintenance_hook:
                    maintenance_hook(state, body, events)
                if body is not None:
                    if 'reason' in body and not isinstance(body['reason'], str):
                        raise m.urllib.error.HTTPError('fixture', 400, 'reason must be a string', {}, None)
                    state['posts'].append(body.copy())
                if failure == 'release' and body is not None and not body['on']:
                    raise RuntimeError('maintenance unavailable')
                if body is not None: state.update(on=body['on'], reason=body.get('reason'))
                return {'on':state['on'], 'reason':state.get('reason', 'previous'), 'running':(1 if race and state['on'] else running), 'queued':2}
            if route == '/services':
                return {'services':[{'id':'worker','mode':'managed','state':'running','pid':456}]}
            return {'ok':True}
        i.api = api
        def stop():
            events.append('stop')
            if failure == 'stop':
                raise RuntimeError('Cannot establish stopped executable')
            state['loaded'] = False
            if failure == 'hangup':
                raise RuntimeError('Installer interrupted by SIGHUP')
            if failure == 'bundle-busy':
                raise RuntimeError('Bundle remains open after bootout')
        def start():
            self.assertFalse(state['loaded'], 'overlapping supervisors')
            state['loaded'] = True
            events.append('start-' + (target/'version').read_text())
            if state['fail'] == 'health':
                state['fail'] = None
                raise RuntimeError('unhealthy candidate')
        i.stop, i.start = stop, start
        with patch.object(Path, 'rename', autospec=True, side_effect=lambda src, dst: self.rename(src, dst, state, events)):
            if failure or running or race or maintenance_hook or ack != 'worker':
                with self.assertRaises(RuntimeError): i.install()
            else: i.install()
        if failure == 'hangup':
            journal = [m.json.loads(line)['event'] for line in i.journal.read_text().splitlines()]
            self.assertIn('failed', journal)
            self.assertIn('recovered', journal)
        if failure == 'release':
            self.assertEqual((i.journal.parent/'backup.app'/'version').read_text(), 'old')
            self.assertFalse((i.journal.parent/'complete.json').exists())
        return (target/'version').read_text(), events, state

    def rename(self, src, dst, state, events):
        self.assertFalse(state['loaded'], 'renamed bundle while supervisor running')
        events.append('rename')
        if state['fail'] == 'swap' and src.name == 'candidate.app':
            state['fail'] = None
            raise RuntimeError('Candidate rename failed')
        import os
        os.rename(src, dst)
        return dst

    def test_install_and_prior_maintenance(self):
        for prior in (False, True):
            version, events, state = self.exercise(prior=prior)
            self.assertEqual(version, 'new')
            self.assertEqual(state['on'], prior)
            self.assertIn('interruption-accounting', events)
            self.assertIn('complete', events)
            self.assertIn('idle-acquired', events)
            self.assertNotIn('drain-retry-released', events)
            if prior:
                self.assertEqual(state['reason'], 'previous')

    def test_failed_health_restores_backup(self):
        version, events, state = self.exercise(failure='health')
        self.assertEqual(version, 'old')
        self.assertEqual(events.count('stop'), 2)
        self.assertIn('backup-restored', events)
        self.assertTrue(state['loaded'])
        self.assertFalse(state['on'])

    def test_failed_candidate_rename_restores_missing_target(self):
        version, events, state = self.exercise(failure='swap')
        self.assertEqual(version, 'old')
        self.assertIn('backup-restored', events)
        self.assertTrue(state['loaded'])

    def test_unconfirmed_shutdown_never_moves_bundle(self):
        version, events, state = self.exercise(failure='stop')
        self.assertEqual(version, 'old')
        self.assertNotIn('rename', events)
        self.assertIn('recovery-failed-maintenance-retained', events)
        self.assertTrue(state['on'])

    def test_unrelated_bundle_user_does_not_enable_maintenance(self):
        version, events, state = self.exercise(failure='outside-user')
        self.assertEqual(version, 'old')
        self.assertNotIn('stop', events)
        self.assertNotIn('interruption-accounting', events)
        self.assertFalse(state['on'])

    def test_hup_and_term_use_same_recovery_exception(self):
        with patch.object(m.sys, 'argv', ['install-app.py', 'source', '--target', 'target', '--plist', 'plist']), \
             patch.object(m.sys, 'platform', 'linux'), \
             patch.object(m.signal, 'signal') as register:
            with self.assertRaises(SystemExit):
                m.main()
        handlers = dict(call.args for call in register.call_args_list)
        self.assertIs(handlers[m.signal.SIGHUP], handlers[m.signal.SIGTERM])
        with self.assertRaisesRegex(RuntimeError, 'Installer interrupted by signal'):
            handlers[m.signal.SIGHUP](m.signal.SIGHUP, None)

    def test_bundle_busy_after_bootout_recovers_without_moving_bundle(self):
        version, events, state = self.exercise(failure='bundle-busy')
        self.assertEqual(version, 'old')
        self.assertNotIn('rename', events)
        self.assertEqual(events.count('stop'), 1)
        self.assertIn('start-old', events)
        self.assertTrue(state['loaded'])
        self.assertFalse(state['on'])

    def test_health_retries_subprocess_timeout(self):
        i = object.__new__(m.Installer)
        i.a = SimpleNamespace(timeout=1)
        i.expected_services = set()
        i.api = lambda route: {'ok': True, 'services': []}
        with patch.object(i, 'owner', side_effect=[m.subprocess.TimeoutExpired('launchctl', 60), 123]) as owner:
            i.wait(i.healthy, 'health')
            self.assertEqual(owner.call_count, 2)

    def test_preflight_allows_descendants_but_refuses_menu_app(self):
        i = object.__new__(m.Installer)
        i.target = Path('/fixture/Tango.app')
        i.owner = lambda: 123
        for users, refused in [('123\n456\n789\n', False), ('123\n999\n', True)]:
            with patch.object(i, 'run', side_effect=[
                SimpleNamespace(stdout='123 1\n456 123\n789 456\n999 1\n'),
                SimpleNamespace(stdout=users, stderr='', returncode=0)]):
                if refused:
                    with self.assertRaisesRegex(RuntimeError, 'Quit Tango.app.*999'):
                        i.preflight_users()
                else:
                    i.preflight_users()

    def test_cleanup_keeps_two_completed_and_preserves_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            i = object.__new__(m.Installer)
            i.target = Path(temp) / 'Tango.app'
            i.unused = lambda app: True
            directories = []
            for n in range(4):
                directory = Path(temp) / f'.tango-install-{n}'
                directory.mkdir()
                (directory / 'original.app').mkdir()
                if n < 3:
                    (directory / 'complete.json').write_text(m.json.dumps({'target': str(i.target), 'at': n}))
                directories.append(directory)
            i.cleanup_transactions(directories[2])
            self.assertFalse(directories[0].exists())
            self.assertTrue(directories[1].exists())
            self.assertFalse((directories[2] / 'original.app').exists())
            self.assertTrue((directories[3] / 'original.app').exists())

    def test_closed_terminal_and_repeated_signals_do_not_block_recovery(self):
        handlers = {sig: m.signal.getsignal(sig) for sig in (m.signal.SIGTERM, m.signal.SIGHUP)}
        version, events, state = self.exercise(failure='hangup')
        self.assertEqual(version, 'old')
        self.assertIn('start-old', events)
        self.assertTrue(state['loaded'])
        self.assertFalse(state['on'])
        for sig, handler in handlers.items():
            self.assertEqual(m.signal.getsignal(sig), handler)

    def test_incomplete_service_health_retries(self):
        i = object.__new__(m.Installer)
        i.owner = lambda: 123
        i.expected_services = {'worker'}
        for row in [{'id': 'worker'}, {'id': 'worker', 'state': 'running'},
                    {'id': 'worker', 'state': 'running', 'health': None},
                    {'id': 'worker', 'state': 'running', 'health': {}}]:
            i.api = lambda route: {'ok': True} if route == '/health' else {'services': [row]}
            self.assertFalse(i.healthy())

    def test_interrupted_prune_keeps_marker_for_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            i = object.__new__(m.Installer)
            i.target = Path(temp) / 'Tango.app'
            i.unused = lambda app: True
            directories = []
            for n in range(3):
                directory = Path(temp) / f'.tango-install-{n}'
                directory.mkdir()
                (directory / 'backup.app').mkdir()
                (directory / 'complete.json').write_text(m.json.dumps({'target': str(i.target), 'at': n}))
                directories.append(directory)
            with patch.object(m.shutil, 'rmtree', side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):
                    i.cleanup_transactions(directories[2])
            self.assertTrue((directories[0] / 'complete.json').exists())
            i.cleanup_transactions(directories[2])
            self.assertFalse(directories[0].exists())

    def test_missing_expected_service_is_unhealthy(self):
        i = object.__new__(m.Installer)
        i.owner = lambda: 123
        i.expected_services = {'missing-service'}
        i.api = lambda route: {'ok':True} if route == '/health' else {'services':[]}
        self.assertFalse(i.healthy())

    def test_duplicate_login_owner_is_rejected(self):
        i = object.__new__(m.Installer)
        i.a = SimpleNamespace(label='external', login_label='login')
        i.jobs = lambda: {'external', 'login'}
        with self.assertRaisesRegex(RuntimeError, 'login item is loaded'):
            i.owner()

    def test_bad_signature_does_not_stop(self):
        version, events, state = self.exercise(failure='signature')
        self.assertEqual(version, 'old')
        self.assertNotIn('stop', events)

    def test_busy_turns_and_unacknowledged_services_abort(self):
        for kwargs in ({'running':1}, {'ack':''}):
            version, events, state = self.exercise(**kwargs)
            self.assertEqual(version, 'old')
            self.assertNotIn('stop', events)
            self.assertFalse(state['on'])


class JobTests(unittest.TestCase):
    def test_claim_survives_failure_success_and_reexecution(self):
        spec = importlib.util.spec_from_file_location('job', Path(__file__).parents[1] / 'scripts/install-job.py')
        job = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(job)
        for code in (0, 7):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                command = [m.sys.executable, '-c',
                           'from pathlib import Path; import sys; '
                           'p=Path(sys.argv[1]); p.write_text(p.read_text()+"x" if p.exists() else "x"); '
                           'sys.exit(int(sys.argv[2]))', str(root/'runs'), str(code)]
                self.assertEqual(job.execute(root, command), code)
                self.assertEqual(job.execute(root, command), 0)
                self.assertEqual((root/'runs').read_text(), 'x')
                self.assertEqual(m.json.loads((root/'result.json').read_text())['exitCode'], code)


if __name__ == '__main__':
    unittest.main()
