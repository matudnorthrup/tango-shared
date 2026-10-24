import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '../../..');
let dir: string, server: Server, env: NodeJS.ProcessEnv;
let mode = 'managed', state = 'running', ok = true, known = true;
let calls: string[];
beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-paths-'));
    fs.writeFileSync(path.join(dir, 'token'), 'test-token');
    calls = []; mode = 'managed'; state = 'running'; ok = true; known = true;
    server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        expect(req.headers.authorization).toBe('Bearer test-token');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/services' ? {
            services: (known ? ['food-ui', 'usage-ui', 'workout-ui', 'discord', 'screen', 'live-operator-test'] : []).map(id => ({ id, mode, state })),
        } : { ok }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    env = { ...process.env, TANGO_SERVER_HOME: dir, TANGO_SERVER_PORT: String((server.address() as { port: number }).port), TANGO_REPO_DIR: repo };
});
afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
});
async function run(file: string, args: string[] = []) {
    try { return { ...(await exec(file, args, { env, cwd: repo })), code: 0 }; }
    catch (err) { return err as unknown as { code: number; stdout: string; stderr: string }; }
}
function cli(...args: string[]) { return run(process.execPath, [path.join(repo, 'packages/server/dist/main.js'), ...args]); }
function stub(name: string, body: string) {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    env.PATH = `${dir}:${process.env.PATH}`;
}
it('reports managed ownership, observe, unknown, stopped and server-down exit codes quietly', async () => {
    expect(await cli('managed', 'food-ui')).toMatchObject({ code: 0, stdout: '', stderr: '' });
    state = 'stopped';
    expect((await cli('managed', 'food-ui')).code).toBe(0);
    expect((await cli('status', 'food-ui')).code).toBe(1);
    mode = 'observe';
    expect((await cli('managed', 'food-ui')).code).toBe(1);
    expect((await cli('restart', 'food-ui')).code).toBe(1);
    expect((await cli('managed', 'unknown')).code).toBe(1);
    expect((await cli('status', 'unknown')).code).toBe(4);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect((await cli('managed', 'food-ui')).code).toBe(3);
    expect((await cli('restart', 'food-ui')).code).toBe(3);
});
it('calls action endpoints and reports rejected actions and invalid usage', async () => {
    for (const action of ['start', 'stop', 'restart']) {
        expect((await cli(action, 'food-ui')).code).toBe(0);
        expect(calls).toContain(`POST /services/food-ui/${action}`);
    }
    ok = false;
    expect((await cli('restart', 'food-ui')).code).toBe(1);
    expect((await cli('restart')).code).toBe(2);
    expect((await cli('status', 'food-ui', '-v')).stdout).toContain('food-ui');
});
it('delegates all UI and bot scripts without touching tmux', async () => {
    stub('tmux', 'echo touched >> "$TANGO_SERVER_HOME/tmux.calls"; exit 1');
    stub('npm', 'exit 0'); // bot restart retains its build before delegation
    for (const id of ['food-ui', 'usage-ui', 'workout-ui', 'discord']) {
        for (const action of ['start', 'stop', 'restart', 'status']) {
            const name = id === 'discord' ? action : `${id}-${action}`;
            expect((await run('bash', [path.join(repo, `scripts/tmux/${name}.sh`)])).code).toBe(0);
            if (action !== 'status') expect(calls).toContain(`POST /services/${id}/${action}`);
        }
    }
    expect(fs.existsSync(path.join(dir, 'tmux.calls'))).toBe(false);
});
it('retains tmux stop/status for observe and unknown services', async () => {
    stub('tmux', 'echo touched >> "$TANGO_SERVER_HOME/tmux.calls"; exit 1');
    for (known of [true, false]) {
        mode = 'observe';
        expect((await run('bash', [path.join(repo, 'scripts/tmux/food-ui-stop.sh')])).code).toBe(0);
        expect((await run('bash', [path.join(repo, 'scripts/tmux/food-ui-status.sh')])).code).toBe(1);
    }
    expect(fs.readFileSync(path.join(dir, 'tmux.calls'), 'utf8')).toContain('touched');
});
it('healthcheck skips managed bot and screen, retains observe probes', async () => {
    stub('ps', 'exit 0'); stub('mount', 'exit 0'); stub('curl', 'echo probe >> "$TANGO_SERVER_HOME/probes.calls"; echo 200');
    env.TANGO_HEALTH_DIR = path.join(dir, 'health');
    env.TANGO_ENV_FILE = path.join(dir, 'absent');
    env.TANGO_HEALTH_DRY_RUN = '1';
    expect((await run('bash', [path.join(repo, 'scripts/health/tango-healthcheck.sh')])).code).toBe(0);
    const log = fs.readFileSync(path.join(dir, 'health/healthcheck.log'), 'utf8');
    expect(log).toContain('SKIP discord'); expect(log).toContain('SKIP screen');
    expect(fs.existsSync(path.join(dir, 'probes.calls'))).toBe(false);
    mode = 'observe';
    expect((await run('bash', [path.join(repo, 'scripts/health/tango-healthcheck.sh')])).code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'probes.calls'), 'utf8')).toContain('probe');
});

it.skipIf(process.platform !== 'darwin')('operator reinstallation delegates before touching launchd', async () => {
    stub('launchctl', 'echo touched >> "$TANGO_SERVER_HOME/launchctl.calls"; exit 1');
    expect((await run(process.execPath, [path.join(repo, 'scripts/voice-operator/install-launchagent.mjs'), '--operator', 'test'])).code).toBe(0);
    expect(calls).toContain('POST /services/live-operator-test/restart');
    expect(fs.existsSync(path.join(dir, 'launchctl.calls'))).toBe(false);
});

it('fails closed when the server is unreachable for a service declared managed', async () => {
    stub('tmux', 'echo touched >> "$TANGO_SERVER_HOME/tmux.calls"; exit 1');
    const profile = path.join(dir, 'profile');
    fs.mkdirSync(path.join(profile, 'config'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'config/services.yaml'), 'services:\n  - {"id": "food-ui", "mode": "managed"}\n');
    env.TANGO_PROFILE_DIR = profile;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const restart = await run('bash', [path.join(repo, 'scripts/tmux/food-ui-restart.sh')]);
    expect(restart.code).toBe(3);
    expect(restart.stderr).toContain("can't be reached");
    expect(fs.existsSync(path.join(dir, 'tmux.calls'))).toBe(false);
    // Not declared managed: the legacy path still runs when the server is down.
    await run('bash', [path.join(repo, 'scripts/tmux/usage-ui-stop.sh')]);
    expect(fs.readFileSync(path.join(dir, 'tmux.calls'), 'utf8')).toContain('touched');
});
