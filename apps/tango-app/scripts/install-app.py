#!/usr/bin/env python3
"""Coordinated replacement of an existing externally supervised Tango.app.

Run with a Python outside the bundle. No sudo, signing, job creation, or forced
turn interruption. The journal and verified backup survive every failure.

Launch with install-job.py, end the submitting agent turn immediately, and use
loom.wait_for (or a completion trigger) to resume on result.json. Keeping that
turn open prevents the idle gate from opening. The idle/drain deadline defaults
to two hours; expiry exits 2 after recovery. No forced interruption or automatic
rerun occurs. Recovery and the replacement itself use --timeout separately.
"""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the server bearer token to a redirect target.


class IdleDeadlineExpired(RuntimeError):
    pass


class Installer:
    def __init__(self, args):
        self.a = args
        self.target = Path(args.target).resolve()
        self.source = Path(args.source).resolve()
        self.domain = f'gui/{os.getuid()}'
        self.job = f'{self.domain}/{args.label}'
        self.journal = None
        self.token = Path(args.token).expanduser().read_text().strip()

    def run(self, *args, check=True):
        result = subprocess.run(args, text=True, capture_output=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr.strip()}')
        return result

    def record(self, event, **data):
        row = dict(at=time.time(), event=event, **data)
        if self.journal:
            with self.journal.open('a') as f:
                f.write(json.dumps(row) + '\n')
                f.flush()
                os.fsync(f.fileno())
        try:
            print(json.dumps(row), flush=True)
        except OSError:
            pass  # A closed terminal must not prevent journaled recovery.

    def api(self, route, body=None):
        request = urllib.request.Request(self.a.url + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        # Stop responds only after the supervisor's TERM grace (up to 10s)
        # and KILL wait (1s). Leave response overhead, even with a short poll
        # deadline, and let --timeout extend the budget for slow machines.
        stopping = body is not None and route.startswith('/services/') and route.endswith('/stop')
        request_timeout = max(15, self.a.timeout) if stopping else 10
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=request_timeout) as response:
            return json.load(response)

    def wait(self, predicate, description):
        until = time.monotonic() + self.a.timeout
        while True:
            if predicate():
                return
            if time.monotonic() >= until:
                raise RuntimeError('Timed out: ' + description)
            time.sleep(0.5)

    def verify(self, app):
        self.run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app))
        node = app / 'Contents/MacOS/tango-server-node'
        self.run('/usr/bin/codesign', '--verify', '--strict', str(node))
        identity = self.run('/usr/bin/codesign', '-dv', '--verbose=4', str(node)).stderr
        if 'Identifier=node\n' not in identity or 'TeamIdentifier=HX7739G8FX\n' not in identity:
            raise RuntimeError('Bundled Node must retain the upstream Node.js signature (PR #901)')
        for relative in ['Contents/MacOS/Tango', 'Contents/Info.plist',
                         'Contents/Library/LaunchAgents/com.tango.server.plist']:
            if not (app / relative).is_file():
                raise RuntimeError('Incomplete app: ' + relative)
        return hashlib.sha256(node.read_bytes()).hexdigest()

    def jobs(self):
        rows = self.run('/bin/launchctl', 'list').stdout.splitlines()[1:]
        return {row.split()[-1] for row in rows if row.split()}

    def owner(self):
        labels = self.jobs()
        if self.a.login_label in labels:
            raise RuntimeError('App login item is loaded; disable it before using the external LaunchAgent installer')
        if self.a.label not in labels:
            raise RuntimeError('Expected external LaunchAgent is not loaded')
        output = self.run('/bin/launchctl', 'print', self.job).stdout
        match = re.search(r'^\s*pid = (\d+)$', output, re.M)
        if not match:
            raise RuntimeError('External LaunchAgent has no running PID')
        pid = int(match[1])
        files = self.run('/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'txt', '-Fn').stdout
        if 'n' + str(self.target / 'Contents/MacOS/tango-server-node') not in files.splitlines():
            raise RuntimeError('External LaunchAgent PID is not executing the target bundled Node')
        port = str(urllib.parse.urlparse(self.a.url).port or 80)
        listeners = self.run('/usr/sbin/lsof', '-nP', '-a', '-p', str(pid),
                             '-iTCP:' + port, '-sTCP:LISTEN', '-t', check=False)
        if listeners.returncode or str(pid) not in listeners.stdout.splitlines():
            raise RuntimeError('Health endpoint is not owned by the external LaunchAgent PID')
        return pid

    def preflight_users(self):
        """Refuse unrelated bundle users before interrupting any managed work."""
        root = self.owner()
        rows = self.run('/bin/ps', '-axo', 'pid=,ppid=').stdout.splitlines()
        parents = dict(tuple(map(int, row.split())) for row in rows if row.strip())
        tree = {root}
        while True:
            children = {pid for pid, parent in parents.items() if parent in tree}
            if children.issubset(tree):
                break
            tree.update(children)
        result = self.run('/usr/sbin/lsof', '-t', '+D', str(self.target), check=False)
        if result.returncode not in (0, 1) or result.stderr.strip():
            raise RuntimeError('Cannot inspect processes using the installed bundle')
        outsiders = set(map(int, result.stdout.split())) - tree
        if outsiders:
            raise RuntimeError('Quit Tango.app and other processes using its bundle before installing; '
                               'outside server tree PIDs: ' + ', '.join(map(str, sorted(outsiders))))

    def cleanup_transactions(self, transaction):
        # Only our completed transactions for this exact target are disposable.
        # Failed/incomplete transactions remain available for manual recovery.
        original = transaction / 'original.app'
        if original.exists() and self.unused(original):
            shutil.rmtree(original)
        completed = []
        for directory in self.target.parent.glob('.tango-install-*'):
            if directory.is_symlink() or not directory.is_dir():
                continue
            try:
                marker = json.loads((directory / 'complete.json').read_text())
                if marker['target'] == str(self.target) and isinstance(marker['at'], (int, float)):
                    completed.append((marker['at'], directory))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        for _, directory in sorted(completed, reverse=True)[2:]:
            if self.unused(directory):
                # Keep the completion marker until all payload deletion succeeds,
                # so a later install can retry an interrupted prune.
                for child in directory.iterdir():
                    if child.name == 'complete.json':
                        continue
                    if child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
                (directory / 'complete.json').unlink()
                directory.rmdir()

    def unused(self, app):
        result = self.run('/usr/sbin/lsof', '-t', '+D', str(app), check=False)
        if result.stdout.strip():
            return False
        if result.returncode != 1 or result.stderr.strip():
            raise RuntimeError('Cannot establish that the bundle is unused: ' + result.stderr)
        return True

    def stopped(self):
        return self.a.label not in self.jobs() and (not self.target.exists() or self.unused(self.target))

    def stop(self):
        if self.a.label in self.jobs():
            self.run('/bin/launchctl', 'bootout', self.job)
        self.wait(self.stopped, 'server exit and no open bundle files')
        if self.a.login_label in self.jobs():
            raise RuntimeError('Login item appeared during shutdown; refusing replacement')
        self.record('server-stopped-bundle-unused')

    def healthy(self):
        try:
            self.owner()
            if self.api('/health').get('ok') is not True:
                return False
            services = self.api('/services')['services']
            return self.expected_services.issubset({s['id'] for s in services}) and all(s.get('state') == 'running' and isinstance(s.get('health'), dict) and s['health'].get('ok') is True
                       for s in services if s['id'] in self.expected_services)
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
            return False

    def start(self):
        if self.a.label in self.jobs() or self.a.login_label in self.jobs():
            raise RuntimeError('A supervisor owner is already loaded')
        self.run('/bin/launchctl', 'bootstrap', self.domain, self.a.plist)
        self.wait(self.healthy, 'one healthy supervisor and interrupted services recovered')
        self.record('server-healthy', pid=self.owner())

    def install(self):
        if self.source == self.target or self.target in self.source.parents or self.source in self.target.parents:
            raise RuntimeError('Source and installed bundle must be separate directories')
        if not self.target.is_dir() or self.target.suffix != '.app':
            raise RuntimeError('This installer requires an existing .app and external LaunchAgent')
        with open(self.a.plist, 'rb') as f:
            agent = plistlib.load(f)
        if agent.get('Label') != self.a.label or agent.get('ProgramArguments', [None])[0] != str(self.target / 'Contents/MacOS/tango-server-node'):
            raise RuntimeError('LaunchAgent label/Node path does not match target')
        if agent.get('Program', agent['ProgramArguments'][0]) != agent['ProgramArguments'][0]:
            raise RuntimeError('LaunchAgent Program does not match bundled Node')
        if agent.get('ExitTimeOut', 0) < 30:
            raise RuntimeError('External LaunchAgent must allow ExitTimeOut >= 30 seconds')
        self.owner()
        # Existing app already supports this headless command. Refuse unknown output.
        retired = self.run(str(self.target / 'Contents/MacOS/Tango'), '--retire-login-item')
        if retired.stdout.strip() != 'com.tango.server: not registered':
            raise RuntimeError('Cannot verify that the app login item is unregistered')
        self.preflight_users()
        transaction = Path(tempfile.mkdtemp(prefix='.tango-install-', dir=self.target.parent))
        self.journal = transaction / 'journal.jsonl'
        stage, backup = transaction / 'candidate.app', transaction / 'backup.app'
        self.record('prepared', transaction=str(transaction))
        source_hash = self.verify(self.source)
        self.run('/usr/bin/ditto', str(self.source), str(stage))
        if self.verify(stage) != source_hash:
            raise RuntimeError('Node changed while staging')
        old_hash = self.verify(self.target)
        self.run('/usr/bin/ditto', str(self.target), str(backup))
        if self.verify(backup) != old_hash:
            raise RuntimeError('Backup Node differs from installed Node')
        previous = self.api('/maintenance')
        if not isinstance(previous.get('on'), bool):
            raise RuntimeError('Invalid maintenance response')
        self.preflight_users()
        changed = not previous['on']
        self.maintenance_held = False
        stopped_services = []
        swapped = False
        stop_attempted = False
        self.expected_services = set()
        try:
            self.acquire_idle(previous)
            services = self.api('/services')['services']
            managed = [s for s in services if s['mode'] == 'managed']
            self.expected_services = {s['id'] for s in managed if s['state'] in ('running', 'starting')}
            # Explicitly acknowledge every managed service: even a stopped service
            # will start on supervisor boot; its non-Loom work cannot be inferred.
            if {s['id'] for s in managed} != set(filter(None, self.a.interrupt_services.split(','))):
                raise RuntimeError('Pass --interrupt-services with exactly these managed IDs: ' + ','.join(sorted(s['id'] for s in managed)))
            self.record('interruption-accounting', services=managed, loom=self.api('/maintenance'),
                        note='Loom drained; all managed services stop. Non-Loom work may be interrupted; explicitly acknowledged.')
            # Stop through the API first so KeepAlive cannot race the drain. Stop
            # in reverse listing order; the supervisor also drains their process groups.
            for service in reversed(managed):
                stopped_services.append(service['id'])
                self.record('service-stop-requested', service=service['id'])
                if self.api('/services/' + urllib.parse.quote(service['id'], safe='') + '/stop', {}).get('ok') is not True:
                    raise RuntimeError('Service stop failed: ' + service['id'])
                self.record('service-stopped', service=service['id'])
            self.owner()
            stop_attempted = True
            self.stop()
            # Keep the original as well as the verified copy. Never delete a live inode.
            self.target.rename(transaction / 'original.app')
            swapped = True
            stage.rename(self.target)
            self.verify(self.target)
            self.record('replacement-installed')
            self.start()
        except BaseException as error:
            handlers = {sig: signal.signal(sig, signal.SIG_IGN)
                        for sig in (signal.SIGTERM, signal.SIGHUP)}
            try:
                self.record('failed', error=str(error))
                if swapped:
                    self.stop()  # A failed candidate may still own a running process.
                    self.verify(backup)
                    if self.target.exists():
                        self.target.rename(transaction / 'failed.app')
                    backup.rename(self.target)
                    self.verify(self.target)
                    self.record('backup-restored')
                    self.start()
                elif stop_attempted:
                    # No bundle moved: unrelated open files cannot block recovery.
                    self.wait(lambda: self.a.label not in self.jobs(), 'external job unloaded')
                    self.start()
                else:
                    for sid in reversed(stopped_services):
                        if self.api('/services/' + urllib.parse.quote(sid, safe='') + '/start', {}).get('ok') is not True:
                            raise RuntimeError('Service recovery failed: ' + sid)
                    if stopped_services:
                        self.wait(self.healthy, 'interrupted services recovered before releasing maintenance')
                self.restore_maintenance(previous, changed)
                self.record('recovered')
            except BaseException as recovery:
                self.record('recovery-failed-maintenance-retained' if self.maintenance_held
                            else 'recovery-failed', error=str(recovery), backup=str(backup))
                if isinstance(error, IdleDeadlineExpired):
                    raise RuntimeError('Idle deadline expired but maintenance recovery failed') from recovery
            finally:
                for sig, handler in handlers.items():
                    signal.signal(sig, handler)
            raise
        # The candidate is healthy. A control-plane release failure must not
        # stop it or replace its bundle; retain all recovery evidence instead.
        try:
            self.restore_maintenance(previous, changed)
        except BaseException as error:
            instruction = ('Healthy candidate retained. Maintenance release was not confirmed; '
                           'inspect GET /maintenance on the configured server URL, then send '
                           'an authenticated POST /maintenance with {"on":false} and confirm '
                           'with GET /maintenance. Do not rerun the installer.'
                           if changed else
                           'Healthy candidate retained. Restore the previous maintenance reason '
                           'using authenticated POST /maintenance with {"on":true,"reason":<previous reason>} '
                           'on the configured server URL (omit reason when the previous reason is null), '
                           'then confirm with GET /maintenance.')
            self.record('healthy-install-maintenance-unconfirmed', error=str(error),
                        backup=str(backup), previous=previous, recovery=instruction)
            raise RuntimeError(instruction) from error
        self.record('complete', backup=str(backup))
        # Cleanup must never roll back an already verified installation.
        try:
            (transaction / 'complete.json').write_text(json.dumps({
                'target': str(self.target), 'at': time.time()}))
            self.cleanup_transactions(transaction)
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            self.record('cleanup-deferred', error=str(error))

    def acquire_idle(self, previous):
        deadline = time.monotonic() + self.a.idle_timeout

        def check_deadline():
            if time.monotonic() >= deadline:
                self.record('idle-deadline-expired', seconds=self.a.idle_timeout)
                raise IdleDeadlineExpired('Overall idle/drain deadline expired; no replacement attempted')

        self.record('waiting-for-idle')
        while True:
            check_deadline()
            state = self.poll_maintenance()
            check_deadline()
            if state is None:
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
                continue
            if type(state.get('running')) is not int or state['running'] < 0:
                raise RuntimeError('Idle count is unavailable')
            if not self.maintenance_matches(state, previous):
                self.record('maintenance-changed-externally', state=state)
                raise RuntimeError('Maintenance changed while waiting for idle; leaving it untouched')
            if state['running'] != 0:
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
                continue
            # The POST can commit even if confirmation is lost or interrupted.
            # Recovery must inspect possible ownership before deciding to release.
            self.maintenance_held = True
            self.set_maintenance({'on': True, 'reason': 'Tango.app installation'})
            drain_deadline = min(deadline, time.monotonic() + self.a.drain_timeout)
            while True:
                check_deadline()
                drained = self.drained()
                check_deadline()
                if drained:
                    self.record('idle-acquired')
                    return
                if time.monotonic() >= drain_deadline:
                    break
                time.sleep(min(0.5, max(0, drain_deadline - time.monotonic())))
            if not self.restore_maintenance(previous, not previous['on']):
                raise RuntimeError('Maintenance changed during drain; leaving it untouched')
            self.record('drain-retry-released', previous=previous)
            # Let queued turns start before checking again; avoid maintenance churn.
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))

    @staticmethod
    def maintenance_matches(state, desired):
        return state.get('on') is desired['on'] and (
            not desired['on'] or state.get('reason') == desired.get('reason'))

    def poll_maintenance(self):
        try:
            return self.api('/maintenance')
        except (OSError, http.client.HTTPException) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code not in (502, 503, 504):
                raise
            now = time.monotonic()
            if now >= getattr(self, '_next_poll_retry_log', 0):
                self.record('maintenance-poll-retry', error=str(error))
                self._next_poll_retry_log = now + 30
            return None

    def owns_maintenance(self, state):
        if self.maintenance_matches(state, {'on': True, 'reason': 'Tango.app installation'}):
            return True
        self.maintenance_held = False
        self.record('maintenance-changed-externally', state=state)
        return False

    def drained(self):
        state = self.poll_maintenance()
        if state is None:
            return False
        if not self.owns_maintenance(state):
            raise RuntimeError('Maintenance changed during drain; leaving it untouched')
        if type(state.get('running')) is not int or state['running'] < 0:
            raise RuntimeError('Drain count is unavailable')
        return state['running'] == 0

    def set_maintenance(self, desired):
        # The proxy may time out after Loom saved the state but before queued
        # work finishes starting. Read back the committed state; never infer
        # that a lost POST response means the mutation failed, or replay it.
        try:
            self.api('/maintenance', desired)
        except (OSError, http.client.HTTPException) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code not in (502, 503, 504):
                raise
            self.record('maintenance-response-uncertain', error=str(error), desired=desired)
        def confirmed():
            try:
                state = self.api('/maintenance')
                return state.get('on') is desired['on'] and (
                    not desired['on'] or state.get('reason') == desired.get('reason'))
            except (OSError, http.client.HTTPException) as error:
                if isinstance(error, urllib.error.HTTPError) and error.code not in (502, 503, 504):
                    raise
                return False
        self.wait(confirmed, 'maintenance state confirmation')
        self.record('maintenance-confirmed', desired=desired)

    def restore_maintenance(self, previous, changed):
        if not self.maintenance_held:
            return False
        # Leave observed external changes alone. Without API compare-and-set,
        # an external change in the GET-to-POST gap can still be overwritten.
        state = None
        def available():
            nonlocal state
            state = self.poll_maintenance()
            return state is not None
        self.wait(available, 'maintenance ownership read-back')
        if not self.owns_maintenance(state):
            return False
        desired = {'on': not changed}
        if not changed and previous.get('reason') is not None:
            desired['reason'] = previous['reason']
        self.set_maintenance(desired)
        self.maintenance_held = False
        return True


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--target', required=True)
    parser.add_argument('--plist', required=True)
    parser.add_argument('--label', default='com.tango.tango-server')
    parser.add_argument('--login-label', default='com.tango.server')
    parser.add_argument('--url', default='http://127.0.0.1:9440')
    parser.add_argument('--token', default='~/.tango/server/token')
    parser.add_argument('--interrupt-services', default='')
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--idle-timeout', type=float, default=7200,
                        help='overall idle/drain admission deadline in seconds (default: 7200)')
    parser.add_argument('--drain-timeout', type=float, default=60,
                        help='maintenance drain budget before releasing and waiting again (default: 60)')
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise RuntimeError('Installer interrupted by signal ' + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    if sys.platform != 'darwin':
        parser.error('macOS is required')
    url = urllib.parse.urlparse(args.url)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path not in ('', '/'):
        parser.error('--url must be a loopback HTTP endpoint')
    args.url = args.url.rstrip('/')
    if any(not 0 < value < float("inf") for value in (args.timeout, args.idle_timeout, args.drain_timeout)):
        parser.error('timeouts must be finite and positive')
    # A persistent flock prevents two installers from passing preflight together.
    target = Path(args.target).resolve()
    with (target.parent / ('.' + target.name + '.install.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Installer(args).install()


def main():
    try:
        run()
    except IdleDeadlineExpired as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
