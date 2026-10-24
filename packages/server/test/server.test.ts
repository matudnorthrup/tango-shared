import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { serviceSchema, servicesSchema, loadServices, ensureToken } from '../src/config.js';
import { Supervisor, type Dependencies } from '../src/supervisor.js';
import { RotatingLog } from '../src/logs.js';
import { createApi } from '../src/api.js';
const dirs: string[] = [], supervisors: Supervisor[] = [], servers: Server[] = [];
function tmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-server-')); dirs.push(dir); return dir; }
function service(id: string, extra: Record<string, unknown> = {}) { return serviceSchema.parse({ id, name: id, mode: 'managed', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], health: { port: 12345, intervalSeconds: 1, graceSeconds: 0.1 }, ...extra }); }
function fake() { const child = new EventEmitter() as ChildProcess; Object.assign(child, { pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter() }); return child; }
function harness(config = [service('a')], over: Partial<Dependencies> = {}) {
    let now = 0;
    const children: ChildProcess[] = [], signals: string[] = [], events: string[] = [];
    const spawnMock = vi.fn(() => { const c = fake(); children.push(c); return c; });
    const s = new Supervisor(config, tmp(), { now: () => now, spawn: spawnMock, probe: async () => ({ ok: true, detail: 'ok' }),
        alive: () => true, command: () => 'test child', portInUse: async () => false, groupAlive: () => false, signal: (_, sig) => { signals.push(sig); children.at(-1)!.emit('exit', null, sig); }, ingest: e => { events.push(e.kind); }, ...over });
    supervisors.push(s);
    return { s, children, spawnMock, signals, events, advance: (ms: number) => { now += ms; } };
}
afterEach(async () => { for (const s of supervisors.splice(0))
    await s.shutdown(); for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
} dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });
describe('configuration', () => {
    it('rejects unknown keys at every level, unsafe ids, invalid graphs, and managed adoption', () => {
        for (const extra of [{ surprise: true }, { health: { port: 1, typo: 2 } }, { restart: { policy: 'never', typo: 2 } }, { budget: { oops: 1 } }, { adopt: { launchd: 'x', oops: 1 } }, { id: '../oops' }, { mode: 'managed', adopt: { launchd: 'x' } }])
            expect(() => service('a', extra)).toThrow();
        expect(() => servicesSchema.parse({ services: [service('a', { dependsOn: ['b'] })] })).toThrow();
        expect(() => servicesSchema.parse({ services: [service('a', { dependsOn: ['b'] }), service('b', { dependsOn: ['a'] })] })).toThrow();
    });
    it('deep merges by id and refuses unknown overlay keys', () => {
        const d = tmp(), base = path.join(d, 'base.yaml'), over = path.join(d, 'over.yaml');
        fs.writeFileSync(base, 'services:\n  - id: a\n    name: A\n    health: {port: 1234}\n    env: {A: one, B: two}\n');
        fs.writeFileSync(over, 'services:\n  - id: a\n    env: {B: three}\n    health: {intervalSeconds: 2}\n');
        expect(loadServices(base, over)[0]).toMatchObject({ mode: 'observe', env: { A: 'one', B: 'three' }, health: { port: 1234, intervalSeconds: 2 } });
        fs.writeFileSync(over, 'services:\n  - id: a\n    typo: bad\n');
        expect(() => loadServices(base, over)).toThrow();
    });
    it('creates a stable private token', () => { const d = tmp(), a = ensureToken(d); expect(ensureToken(d)).toBe(a); expect(fs.statSync(path.join(d, 'token')).mode & 0o777).toBe(0o600); });
});
describe('supervision', () => {
    it('gates dependency order on health and stops in reverse order', async () => {
        let healthy = false;
        const order: string[] = [], stops: number[] = [];
        let pid = 100;
        const children = new Map<number, ChildProcess>();
        const { s, advance } = harness([service('b', { dependsOn: ['a'] }), service('a')], {
            spawn: s => { order.push(s.id); const c = fake(); Object.assign(c, { pid: ++pid }); children.set(pid, c); return c; },
            probe: async (s) => ({ ok: s.id !== 'a' || healthy, detail: 'probe' }), signal: (pid, sig) => { stops.push(pid); children.get(pid)!.emit('exit', null, sig); },
        });
        await s.tick();
        expect(order).toEqual(['a']);
        healthy = true;
        advance(1000);
        await s.tick();
        expect(order).toEqual(['a', 'b']);
        await s.shutdown();
        expect(stops).toEqual([102, 101]);
    });
    it('uses exponential backoff then latches failing until manual start', async () => {
        const h = harness([service('a', { restart: { policy: 'always', backoffSeconds: 1, maxRestarts: 2, windowSeconds: 300 } })]);
        await h.s.tick();
        h.children.at(-1)!.emit('exit', 1, null);
        h.advance(999);
        await h.s.tick();
        expect(h.spawnMock).toHaveBeenCalledTimes(1);
        h.advance(1);
        await h.s.tick();
        h.children.at(-1)!.emit('exit', 1, null);
        h.advance(1999);
        await h.s.tick();
        expect(h.spawnMock).toHaveBeenCalledTimes(2);
        h.advance(1);
        await h.s.tick();
        h.children.at(-1)!.emit('exit', 1, null);
        expect(h.s.list()[0]).toMatchObject({ state: 'failing', restarts: 2 });
        h.advance(999999);
        await h.s.tick();
        expect(h.spawnMock).toHaveBeenCalledTimes(3);
        await h.s.start('a');
        expect(h.spawnMock).toHaveBeenCalledTimes(4);
        expect(h.events).toContain('job.restarting');
    });
    it('does not restart successful exits for on-failure, nor failures for never', async () => {
        for (const [policy, code] of [['on-failure', 0], ['never', 1]] as const) {
            const h = harness([service('a', { restart: { policy } })]);
            await h.s.tick();
            h.children[0]!.emit('exit', code, null);
            h.advance(100000);
            await h.s.tick();
            expect(h.spawnMock).toHaveBeenCalledTimes(1);
        }
    });
    it('backs off spawn errors and health failures', async () => {
        const h = harness([service('a', { health: { port: 1, graceSeconds: 0, intervalSeconds: 1 } })], { probe: async () => ({ ok: false, detail: 'bad' }) });
        await h.s.tick();
        expect(h.signals).toEqual(['SIGTERM']);
        expect(h.s.list()[0]?.restarts).toBe(1);
        const bad = harness(undefined, { spawn: () => { throw new Error('ENOENT'); } });
        await bad.s.tick();
        expect(bad.s.list()[0]?.restarts).toBe(1);
    });
    it('never spawns, signals, or ingests for observe services, including controls', async () => {
        const signal = vi.fn(), ingest = vi.fn();
        const h = harness([service('watch', { mode: 'observe', command: undefined, adopt: { launchd: 'com.example.app' } })], { signal, ingest, probe: async () => ({ ok: true, detail: 'up', pid: 999, memoryBytes: 42, cpuPct: 3 }) });
        await h.s.tick();
        for (const method of ['start', 'stop', 'restart'] as const)
            expect(await h.s[method]('watch')).toBe(false);
        await h.s.shutdown();
        expect(h.spawnMock).not.toHaveBeenCalled();
        expect(signal).not.toHaveBeenCalled();
        expect(ingest).not.toHaveBeenCalled();
        expect(h.s.list()[0]).toMatchObject({ state: 'running', pid: 999, memoryBytes: 42, cpuPct: 3 });
    });
    it('forces SIGKILL after the grace period with an injected clock', async () => {
        const sleep = vi.fn(async () => { });
        let child: ChildProcess;
        const signal = vi.fn((_: number, sig: NodeJS.Signals) => { if (sig === 'SIGKILL')
            child.emit('exit', null, sig); });
        const h = harness(undefined, { signal, sleep });
        await h.s.tick();
        child = h.children[0]!;
        await h.s.stop('a');
        expect(signal.mock.calls.map(c => c[1])).toEqual(['SIGTERM', 'SIGKILL']);
        expect(sleep).toHaveBeenCalledWith(100);
    });
    it('kills remaining descendants when their parent exits on TERM', async () => {
        const h = harness(undefined, { groupAlive: () => true, sleep: async () => { } });
        await h.s.tick();
        await h.s.stop('a');
        expect(h.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
    it('starts real detached node processes and captures both output streams', async () => {
        const d = tmp();
        const s = new Supervisor([service('real', { command: [process.execPath, '-e', "console.log('ready'); console.error('error-stream'); setInterval(()=>{},1000)"] })], d, { portInUse: async () => false, probe: async () => ({ ok: true, detail: 'up' }), ingest: () => { } });
        supervisors.push(s);
        await s.tick();
        const end = Date.now() + 3000;
        while (!s.logs('real', 20).includes('error-stream') && Date.now() < end)
            await new Promise(r => setTimeout(r, 20));
        expect(s.logs('real', 20)).toEqual(expect.arrayContaining(['ready', 'error-stream']));
        expect(s.list()[0]?.pid).toBeGreaterThan(0);
        await s.stop('real');
        expect(s.list()[0]?.state).toBe('stopped');
    });
});
it('rotates at the byte limit and keeps exactly three archives', () => {
    const file = path.join(tmp(), 'logs/a.log'), log = new RotatingLog(file, 10);
    log.write('abcdefghij');
    log.write('klmnopqrst');
    expect(fs.readFileSync(file + '.1', 'utf8')).toBe('abcdefghij');
    log.write(Buffer.alloc(45, 120));
    expect(fs.statSync(file).size).toBe(5);
    for (let i = 1; i <= 3; i++)
        expect(fs.statSync(`${file}.${i}`).size).toBe(10);
    expect(fs.existsSync(file + '.4')).toBe(false);
});
async function api(fetcher: typeof fetch = async () => new Response(JSON.stringify({ on: true, reason: 'deploy', since: 'now', running: 1, queued: 2 })), runner = vi.fn(async (..._args: unknown[]) => { })) {
    const h = harness([service('watch', { mode: 'observe', command: undefined })]);
    const root = tmp();
    for (const id of ['one', 'two']) {
        fs.mkdirSync(path.join(root, id));
        fs.writeFileSync(path.join(root, id, 'release.json'), JSON.stringify({ buildTime: '2026-01-01' }));
    }
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ current: 'two', previous: 'one', candidates: [] }));
    const reload = vi.fn(async () => {});
    const server = createApi(h.s, { reload, token: 'secret', homeDir: root, releasesDir: root, loomUrl: 'http://loom', loomToken: () => 'loom-secret', fetch: fetcher, runner, uid: 501 });
    servers.push(server);
    // Exercise the actual HTTP listener without binding a socket (sandbox disallows listen).
    const request = (p: string, method = 'GET', data?: unknown, auth = true): Promise<Response> => new Promise(resolve => {
        const req = Object.assign(Readable.from(data === undefined ? [] : [JSON.stringify(data)]), { url: p, method, headers: { ...(auth ? { authorization: 'Bearer secret' } : {}), 'content-type': 'application/json' } });
        let status = 200;
        const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => resolve(new Response(body, { status })) };
        server.emit('request', req, res);
    });
    return { ...h, request, root, runner, reload };
}
describe('HTTP API', () => {
    it('has public health and requires bearer auth everywhere else', async () => { const a = await api(); expect((await a.request('/health', 'GET', undefined, false)).status).toBe(200); for (const p of ['/services', '/maintenance', '/releases', '/resources', '/unknown'])
        expect((await a.request(p, 'GET', undefined, false)).status).toBe(401); expect((await a.request('/services')).status).toBe(200); });
    it('returns 409 for all observe controls and reads known logs', async () => { const a = await api(); for (const action of ['start', 'stop', 'restart']) {
        const r = await a.request(`/services/watch/${action}`, 'POST');
        expect(r.status).toBe(409);
        expect(await r.json()).toEqual({ ok: false, code: 'observe' });
    } expect(await (await a.request('/services/watch/logs')).json()).toEqual({ lines: [] }); expect((await a.request('/services/watch/logs?lines=-1')).status).toBe(400); expect(a.spawnMock).not.toHaveBeenCalled(); });
    it('proxies maintenance methods and auth, and maps old Loom 404 to 501', async () => {
        const mock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ on: true, reason: 'deploy', since: 'now', running: 1, queued: 2 })));
        const a = await api(mock as typeof fetch);
        expect(await (await a.request('/maintenance')).json()).toMatchObject({ on: true, running: 1, queued: 2 });
        await a.request('/maintenance', 'POST', { on: true, reason: 'deploy' });
        expect(mock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer loom-secret' }, body: JSON.stringify({ on: true, reason: 'deploy' }) });
        const old = await api((async () => new Response('not found', { status: 404 })) as typeof fetch);
        const r = await old.request('/maintenance');
        expect(r.status).toBe(501);
        expect(await r.json()).toEqual({ code: 'loom_unsupported' });
        expect((await a.request('/maintenance', 'POST', { on: 'yes' })).status).toBe(400);
    });
    it('reads release state and sizes and rolls back using only the injected runner', async () => {
        const a = await api();
        const data = await (await a.request('/releases')).json();
        expect(data).toMatchObject({ current: 'two', previous: 'one' });
        expect(data.releases[0]).toMatchObject({ id: 'two', status: 'current', buildTime: '2026-01-01' });
        expect(data.releases[0].bytes).toBeGreaterThan(0);
        expect((await a.request('/releases/rollback', 'POST')).status).toBe(200);
        expect(a.runner.mock.calls[0]).toEqual([process.execPath, [path.join(a.root, 'two/packages/loom/scripts/release.mjs'), 'rollback'], expect.objectContaining({ env: expect.objectContaining({ LOOM_RELEASES_DIR: a.root }) })]);
        expect(a.runner.mock.calls[1]).toEqual(['launchctl', ['kickstart', '-k', 'gui/501/com.tango.loom'], {}]);
    });
    it('does not kickstart when rollback fails', async () => { const runner = vi.fn(async () => { throw new Error('rollback failed'); }); const a = await api(undefined, runner); expect((await a.request('/releases/rollback', 'POST')).status).toBe(502); expect(runner).toHaveBeenCalledTimes(1); });
    it('passes machine resources through and adds home volume disk stats', async () => { const a = await api((async () => new Response(JSON.stringify({ cpu: { cores: 4 } }))) as typeof fetch); const data = await (await a.request('/resources')).json(); expect(data.cpu).toEqual({ cores: 4 }); expect(data.disk.totalBytes).toBeGreaterThan(0); expect(data.disk.freeBytes).toBeGreaterThan(0); });
});

it('keeps probes and dependency launches moving while a slow probe is pending', async () => {
    let release!: (r: { ok: boolean; detail: string }) => void;
    const calls: string[] = [];
    const h = harness([service('slow', { mode: 'observe' }), service('dependency', { mode: 'observe' }), service('worker', { dependsOn: ['dependency'] })], {
        probe: async s => { calls.push(s.id); return s.id === 'slow' ? new Promise(r => { release = r; }) : { ok: true, detail: 'up' }; },
    });
    const pending = h.s.tick();
    try {
        await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalledTimes(1));
        expect(calls).toContain('worker');
        h.advance(1000);
        await h.s.tick();
        expect(calls.filter(id => id === 'dependency')).toHaveLength(2);
        expect(calls.filter(id => id === 'slow')).toHaveLength(1);
    } finally { release({ ok: true, detail: 'up' }); await pending; }
});
it('caps concurrent probes at six across ticks and drains queued probes', async () => {
    const releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const probe = vi.fn(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise<void>(r => releases.push(r));
        active--;
        return { ok: true, detail: 'up' };
    });
    const h = harness(Array.from({ length: 9 }, (_, i) => service(`s${i}`, { mode: 'observe' })), { probe });
    const pending = h.s.tick();
    expect(probe).toHaveBeenCalledTimes(6);
    await h.s.tick();
    expect(probe).toHaveBeenCalledTimes(6);
    releases.shift()!();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(7));
    for (let i = 0; i < 8; i++) {
        await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
        releases.shift()!();
    }
    await pending;
    expect(peak).toBe(6);
    expect(h.s.list().every(s => s.state === 'running')).toBe(true);
});
it('discards a completed probe after its managed child was stopped', async () => {
    let release!: (r: { ok: boolean; detail: string }) => void;
    const h = harness(undefined, { probe: () => new Promise(r => { release = r; }) });
    const pending = h.s.tick();
    await new Promise(resolve => setImmediate(resolve)); // the port check before launch is async
    await h.s.stop('a');
    release({ ok: true, detail: 'stale' });
    await pending;
    expect(h.s.list()[0]).toMatchObject({ state: 'stopped', health: { ok: false } });
});
it('retries and discards a replaced child reading while another probe is pending', async () => {
    const releases: Array<(r: { ok: boolean; detail: string }) => void> = [];
    let first = true;
    const h = harness([service('slow', { mode: 'observe' }), service('worker')], {
        probe: s => s.id === 'slow' || first ? new Promise(r => { if (s.id === 'worker') first = false; releases.push(r); }) : Promise.resolve({ ok: true, detail: 'new child' }),
    });
    const pending = h.s.tick();
    await new Promise(resolve => setImmediate(resolve)); // the port check before launch is async
    h.children[0]!.emit('exit', 1, null);
    h.advance(1000);
    await h.s.tick();
    expect(h.spawnMock).toHaveBeenCalledTimes(2);
    releases[1]!({ ok: false, detail: 'old child' });
    await vi.waitFor(() => expect(h.s.list().find(s => s.id === 'worker')?.health.detail).toBe('new child'));
    releases[0]!({ ok: true, detail: 'slow done' });
    await pending;
    expect(h.signals).toEqual([]);
});
it('allows adoption-only timing but requires health for managed services', () => {
    expect(serviceSchema.parse({ id: 'watch', name: 'Watch', adopt: { tmux: 'example:worker', socket: '/test/socket' } }).health).toEqual({ intervalSeconds: 10, graceSeconds: 10 });
    expect(() => service('worker', { health: undefined })).toThrow();
    expect(() => service('watch', { mode: 'observe', adopt: { tmux: 'example:worker' }, health: { socket: '/test/socket' } })).toThrow();
});

it('reaps only matching stale process groups and removes stale records', async () => {
    const signal = vi.fn(), sleep = vi.fn(async () => {});
    const h = harness([service('a', { health: { port: 1, graceSeconds: 0 } })], {
        command: pid => pid === 111 ? 'owned command' : 'unrelated command',
        groupAlive: () => true, signal, sleep,
    });
    fs.mkdirSync(path.join(h.s.home, 'run'));
    for (const [id, pid] of [['a', 111], ['b', 222]] as const)
        fs.writeFileSync(path.join(h.s.home, 'run', `${id}.json`), JSON.stringify({ pid, pgid: pid, command: 'owned command', startedAt: 'then' }));
    await h.s.reap();
    expect(signal.mock.calls).toEqual([[111, 'SIGTERM'], [111, 'SIGKILL']]);
    expect(fs.readdirSync(path.join(h.s.home, 'run'))).toEqual([]);
});
it('reaps a surviving process group whose leader already exited', async () => {
    const signal = vi.fn();
    const h = harness([service('a', { health: { port: 1, graceSeconds: 0 } })], {
        alive: () => false, command: () => null, groupAlive: () => true, signal, sleep: vi.fn(async () => {}),
    });
    fs.mkdirSync(path.join(h.s.home, 'run'));
    fs.writeFileSync(path.join(h.s.home, 'run', 'a.json'), JSON.stringify({ pid: 333, pgid: 333, command: 'owned command', startedAt: 'then' }));
    await h.s.reap();
    expect(signal.mock.calls).toEqual([[333, 'SIGTERM'], [333, 'SIGKILL']]);
    expect(fs.readdirSync(path.join(h.s.home, 'run'))).toEqual([]);
});
it('drops malformed pidfiles without blocking startup', async () => {
    const signal = vi.fn();
    const h = harness([service('a', { health: { port: 1, graceSeconds: 0 } })], { signal, groupAlive: () => false });
    fs.mkdirSync(path.join(h.s.home, 'run'));
    fs.writeFileSync(path.join(h.s.home, 'run', 'a.json'), '{not json');
    fs.writeFileSync(path.join(h.s.home, 'run', 'b.json'), JSON.stringify({ pid: 1, pgid: 1, command: 'x' }));
    await expect(h.s.reap()).resolves.toBeUndefined();
    expect(signal).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(h.s.home, 'run'))).toEqual([]);
});
it('refuses foreign port listeners without spawning or killing', async () => {
    const signal = vi.fn();
    const h = harness(undefined, { portInUse: async () => true, signal });
    await h.s.tick();
    expect(h.spawnMock).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(h.s.list()[0]).toMatchObject({ state: 'failing', health: { ok: false, detail: 'port 12345 is already in use by another process' } });
    expect(h.events).toEqual(['service.down']);
});
it('rejects successful probes when the managed child is dead', async () => {
    const h = harness(undefined, { alive: () => false });
    await h.s.tick();
    expect(h.s.list()[0]).toMatchObject({ health: { ok: false, detail: 'port answered but the managed child is not running' } });
    expect(h.events).not.toContain('service.up');
});
it('reconciles only added, removed, and changed services on reload', async () => {
    const configs = [service('same'), service('change'), service('remove')];
    let pid = 100;
    const children = new Map<number, ChildProcess>();
    const signal = vi.fn((pid: number, sig: NodeJS.Signals) => children.get(pid)!.emit('exit', null, sig));
    const spawn = vi.fn(() => { const c = fake(); Object.assign(c, { pid: ++pid }); children.set(pid, c); return c; });
    const h = harness(configs, { spawn, signal });
    await h.s.tick();
    const same = h.s.list()[0];
    await h.s.reload([configs[0]!, service('change', { env: { NEW: 'yes' } }), service('add')]);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(signal.mock.calls.map(c => c[0]).sort()).toEqual([102, 103]);
    expect(h.s.list().find(s => s.id === 'same')).toEqual(same);
    expect(h.s.list().map(s => s.id).sort()).toEqual(['add', 'change', 'same']);
});
it('bounds shutdown across a dependency chain', async () => {
    const sleeps: number[] = [], signals: number[] = [];
    let pid = 100;
    const children = new Map<number, ChildProcess>();
    const h = harness([service('a'), service('b', { dependsOn: ['a'] })], {
        spawn: () => { const c = fake(); Object.assign(c, { pid: ++pid }); children.set(pid, c); return c; },
        signal: (pid, sig) => { signals.push(pid); if (sig === 'SIGKILL') children.get(pid)!.emit('exit', null, sig); },
        sleep: async ms => { sleeps.push(ms); },
    });
    await h.s.tick();
    await h.s.shutdown();
    expect(signals.slice(0, 2)).toEqual([102, 101]);
    expect(signals).toHaveLength(4);
    expect(sleeps.every(ms => ms <= 1000)).toBe(true);
});
it('kills a real child that ignores TERM within a bounded shutdown', async () => {
    const s = new Supervisor([service('ignore', { health: { process: 'node', graceSeconds: 0.05 }, command: [process.execPath, '-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"] })], tmp(), { probe: async () => ({ ok: true, detail: 'ok' }), ingest: () => {} });
    supervisors.push(s);
    await s.tick();
    await vi.waitFor(() => expect(s.logs('ignore', 10)).toContain('ready'));
    const pid = s.list()[0]!.pid!;
    const start = Date.now();
    await s.shutdown();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(() => process.kill(pid, 0)).toThrow();
});

it('authenticates reload and invokes the configured loader', async () => {
    const a = await api();
    expect((await a.request('/reload', 'POST', undefined, false)).status).toBe(401);
    expect(a.reload).not.toHaveBeenCalled();
    expect((await a.request('/reload', 'POST')).status).toBe(200);
    expect(a.reload).toHaveBeenCalledOnce();
});
it('writes ownership records on spawn and removes them on confirmed exit', async () => {
    const h = harness();
    await h.s.tick();
    const file = path.join(h.s.home, 'run/a.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: 12345, pgid: 12345, command: 'test child', startedAt: new Date(0).toISOString() });
    await h.s.stop('a');
    expect(fs.existsSync(file)).toBe(false);
});

it('caps each shutdown grace at ten seconds', async () => {
    const sleeps: number[] = [];
    let child: ChildProcess;
    const h = harness([service('a', { health: { port: 1, graceSeconds: 60 } })], {
        sleep: async ms => { sleeps.push(ms); },
        signal: (_, sig) => { if (sig === 'SIGKILL') child.emit('exit', null, sig); },
    });
    await h.s.tick();
    child = h.children[0]!;
    await h.s.shutdown();
    expect(sleeps[0]).toBe(10000);
});
it('does not wait for a stuck probe before stopping children', async () => {
    let release!: (r: { ok: boolean; detail: string }) => void;
    const h = harness(undefined, { probe: () => new Promise(r => { release = r; }) });
    const pending = h.s.tick();
    await new Promise(resolve => setImmediate(resolve)); // the port check before launch is async
    await h.s.shutdown();
    expect(h.signals).toEqual(['SIGTERM']);
    release({ ok: true, detail: 'late' });
    await pending;
    expect(h.s.list()[0]).toMatchObject({ state: 'stopped', health: { ok: false } });
});

it('prints the launchd exit timeout without installing a job', async () => {
    const { plist } = await import('../src/main.js');
    expect(plist()).toContain('<key>ExitTimeOut</key><integer>30</integer>');
});

it('restarts a running service only after three consecutive failed probes', async () => {
    let ok = true;
    const h = harness(undefined, { probe: async () => ({ ok, detail: ok ? 'up' : 'slow' }) });
    await h.s.tick();
    expect(h.s.list()[0]).toMatchObject({ state: 'running' });
    ok = false;
    for (let i = 0; i < 2; i++) { h.advance(1000); await h.s.tick(); }
    expect(h.signals).toEqual([]);
    expect(h.s.list()[0]).toMatchObject({ state: 'running', restarts: 0 });
    ok = true; h.advance(1000); await h.s.tick();
    ok = false;
    for (let i = 0; i < 2; i++) { h.advance(1000); await h.s.tick(); }
    expect(h.signals).toEqual([]);
    h.advance(1000); await h.s.tick();
    expect(h.signals).toEqual(['SIGTERM']);
    expect(h.s.list()[0]?.restarts).toBe(1);
});

it('survives a child exit when signalling its group fails (EPERM)', async () => {
    const eperm = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
    const h = harness(undefined, { groupAlive: eperm, signal: eperm });
    await h.s.tick();
    expect(h.children).toHaveLength(1);
    expect(() => h.children[0]!.emit('exit', 1, null)).not.toThrow();
    expect(h.s.list()[0]).toMatchObject({ state: 'down' });
});

it('reaps a child that exec\'d into its real program after spawn', async () => {
    let current = 'bash -lc node server.mjs';
    const signal = vi.fn();
    const h = harness([service('a', { health: { port: 1, graceSeconds: 0 } })], { command: () => current, signal: (pid, sig) => signal(pid, sig) });
    await h.s.tick();
    current = 'node server.mjs';
    h.advance(11_000); await h.s.tick();
    const record = JSON.parse(fs.readFileSync(path.join(h.s.home, 'run', 'a.json'), 'utf8'));
    expect(record.commands).toEqual(['bash -lc node server.mjs', 'node server.mjs']);
    // A new server finds the exec'd child still running and reaps it.
    const next = harness([service('a', { health: { port: 1, graceSeconds: 0 } })], { command: () => 'node server.mjs', groupAlive: () => false, signal, alive: () => true, sleep: vi.fn(async () => {}) });
    fs.mkdirSync(path.join(next.s.home, 'run'), { recursive: true });
    fs.writeFileSync(path.join(next.s.home, 'run', 'a.json'), JSON.stringify(record));
    await next.s.reap();
    expect(signal).toHaveBeenCalledWith(record.pgid, 'SIGTERM');
});

