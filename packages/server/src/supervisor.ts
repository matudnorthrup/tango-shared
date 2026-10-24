import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { RecordEventInput } from '@tango/system';
import { servicesSchema, type Service } from './config.js';
import { RotatingLog, tailLogs } from './logs.js';
import { probe, ingest, type Reading } from './system.js';
export type State = 'running' | 'starting' | 'stopped' | 'failing' | 'down' | 'unknown';
export interface ServiceView {
    id: string;
    name: string;
    group: string;
    mode: Service['mode'];
    state: State;
    pid: number | null;
    since: string;
    restarts: number;
    health: {
        ok: boolean;
        checkedAt: string | null;
        detail: string;
    };
    memoryBytes: number | null;
    cpuPct: number | null;
    budget: Service['budget'];
}
export interface Dependencies {
    command: (pid: number) => string | null;
    alive: (pid: number) => boolean;
    /** Whether something already listens on the port. A TCP connect: never lsof, which hangs on a stalled network mount. */
    portInUse: (port: number) => Promise<boolean>;
    spawn: (s: Service) => ChildProcess;
    signal: (pid: number, signal: NodeJS.Signals) => void;
    probe: (s: Service, pid?: number) => Promise<Reading>;
    now: () => number;
    groupAlive: (pid: number) => boolean;
    sleep: (ms: number) => Promise<void>;
    ingest: (event: RecordEventInput) => void;
}
interface Entry {
    config: Service;
    view: ServiceView;
    child?: ChildProcess;
    exited?: Promise<void>;
    desired: boolean;
    failures: number[];
    retryAt?: number;
    nextProbe: number;
    logs: string[];
    stop?: Promise<void>;
    /** Consecutive failed probes while running; a running service restarts only after FAILS_BEFORE_RESTART. */
    failStreak: number;
    checkingPort?: boolean;
}
/** One slow probe on a loaded machine must not bounce a healthy service. */
export const FAILS_BEFORE_RESTART = 3;
export class Supervisor {
    private entries = new Map<string, Entry>();
    private timer?: NodeJS.Timeout;
    private probes = new Map<Entry, Promise<void>>();
    private closing = false;
    private reloading = false;
    private initializing = false;
    private reloadQueue: Promise<void> = Promise.resolve();
    readonly deps: Dependencies;
    constructor(services: Service[], readonly home: string, deps: Partial<Dependencies> = {}) {
        this.deps = {
            command: pid => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() || null; } catch { return null; } },
            // EPERM: the process exists but isn't ours to signal; it is still alive.
            alive: pid => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; } },
            portInUse: port => new Promise<boolean>(resolve => {
                const sock = net.connect({ host: '127.0.0.1', port });
                const done = (inUse: boolean) => { sock.destroy(); resolve(inUse); };
                sock.setTimeout(1000, () => done(false));
                sock.once('connect', () => done(true));
                sock.once('error', () => done(false));
            }),
            spawn: s => spawn(s.command![0]!, s.command!.slice(1), { cwd: s.cwd, env: { ...process.env, ...s.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
            signal: (pid, signal) => { try {
                process.kill(-pid, signal);
            }
            catch (e) {
                // ESRCH: already gone. EPERM: a member we may not signal (it changed credentials); the rest got it.
                if (!['ESRCH', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? ''))
                    throw e;
            } },
            groupAlive: pid => { try {
                process.kill(-pid, 0);
                return true;
            }
            catch (e) {
                // ESRCH: no such group. Anything else (EPERM: a member we may not signal) means the group exists.
                return (e as NodeJS.ErrnoException).code !== 'ESRCH';
            } },
            probe, now: Date.now, sleep: ms => new Promise(r => { setTimeout(r, ms).unref(); }), ingest, ...deps,
        };
        for (const s of services)
            this.entries.set(s.id, { config: s, view: { id: s.id, name: s.name, group: s.group, mode: s.mode,
                    state: s.mode === 'observe' ? 'unknown' : 'stopped', pid: null, since: this.iso(), restarts: 0,
                    health: { ok: false, checkedAt: null, detail: 'Not checked' }, memoryBytes: null, cpuPct: null, budget: s.budget },
                desired: s.mode === 'managed', failures: [], nextProbe: 0, logs: [], failStreak: 0 });
    }
    private iso() { return new Date(this.deps.now()).toISOString(); }
    private state(e: Entry, state: State) { if (e.view.state !== state) {
        e.view.state = state;
        e.view.since = this.iso();
    } }
    private event(e: Entry, kind: string) {
        if (e.config.mode !== 'managed')
            return;
        try {
            this.deps.ingest({ source: 'tango-server', kind, jobId: `server:${e.config.id}`, title: `${e.config.name} ${kind === 'service.up' ? 'is healthy' : kind === 'service.down' ? 'is down' : 'restarting'}`, severity: kind === 'service.up' ? 'recovery' : kind === 'service.down' ? 'error' : 'warning', at: this.iso() });
        }
        catch (err) {
            process.stderr.write(`tango-server ledger: ${String(err)}\n`);
        }
    }
    list(): ServiceView[] { return [...this.entries.values()].map(e => structuredClone(e.view)); }
    private get(id: string) { const e = this.entries.get(id); if (!e)
        throw new Error('Unknown service'); return e; }
    mode(id: string) { return this.get(id).config.mode; }
    private order(): Entry[] {
        const seen = new Set<string>(), out: Entry[] = [];
        const visit = (e: Entry) => { if (seen.has(e.config.id))
            return; seen.add(e.config.id); e.config.dependsOn.forEach(id => visit(this.get(id))); out.push(e); };
        this.entries.forEach(visit);
        return out;
    }
    private ready(e: Entry) { return e.config.dependsOn.every(id => { const d = this.get(id); return d.view.state === 'running' && d.view.health.ok; }); }
    async run() {
        if (this.closing) return;
        this.initializing = true;
        try { await this.reap(); } finally { this.initializing = false; }
        if (this.closing) return;
        this.timer = setInterval(() => { void this.tick().catch(err => process.stderr.write(`tango-server tick: ${String(err)}\n`)); }, 250);
        await this.tick();
    }
    async tick(): Promise<void> {
        await Promise.all(this.step());
    }
    private step(): Promise<void>[] {
        const started: Promise<void>[] = [];
        for (const e of this.order()) {
            if (this.closing || this.reloading || this.initializing) break;
            if (e.config.mode === 'managed' && e.desired && !e.child && !e.stop && !e.checkingPort && e.view.state !== 'failing' && this.ready(e) && (e.retryAt ?? 0) <= this.deps.now())
                started.push(this.launchChecked(e));
            if (e.stop || (e.config.mode === 'managed' && !e.child) || this.probes.has(e)) continue;
            if (e.nextProbe > this.deps.now() || this.probes.size >= 6) continue;
            e.nextProbe = this.deps.now() + e.config.health.intervalSeconds * 1000;
            const pending = this.check(e).finally(() => { this.probes.delete(e); }).then(async () => {
                await Promise.all(this.step());
            });
            this.probes.set(e, pending);
            started.push(pending);
        }
        return started;
    }
    private async check(e: Entry) {
        const child = e.child;
        let r: Reading;
        try {
            r = await this.deps.probe(e.config, e.view.pid ?? undefined);
        }
        catch (err) {
            r = { ok: false, detail: String(err), unavailable: true };
        }
        if (this.closing || e.stop || (e.config.mode === 'managed' && child !== e.child))
            return;
        const childMissing = e.config.mode === 'managed' && (!child?.pid || child.exitCode != null || child.signalCode != null || !this.deps.alive(child.pid));
        if (childMissing) {
            r = { ...r, ok: false, detail: r.ok ? 'port answered but the managed child is not running' : 'Managed child is not running' };
        }
        e.nextProbe = this.deps.now() + e.config.health.intervalSeconds * 1000;
        const was = e.view.health.ok;
        e.view.health = { ok: r.ok, checkedAt: this.iso(), detail: r.detail };
        e.view.memoryBytes = r.memoryBytes ?? null;
        e.view.cpuPct = r.cpuPct ?? null;
        if (e.config.mode === 'observe') {
            e.view.pid = r.pid ?? null;
            e.logs = r.logs ?? [];
            this.state(e, r.unavailable ? 'unknown' : r.ok ? 'running' : 'down');
            return;
        }
        if (r.ok) e.failStreak = 0;
        else if (!childMissing && e.view.state === 'running' && ++e.failStreak < FAILS_BEFORE_RESTART) return;
        if (r.ok && child?.pid) this.recordCommand(e, child.pid);
        if (r.ok) {
            this.state(e, 'running');
            if (!was)
                this.event(e, 'service.up');
        }
        else if (childMissing || this.deps.now() - Date.parse(e.view.since) >= e.config.health.graceSeconds * 1000 || e.view.state === 'running') {
            this.state(e, 'down');
            if (was || e.view.restarts === 0)
                this.event(e, 'service.down');
            // A failed health check is a failure even when SIGTERM exits cleanly.
            await this.stopChild(e);
            if (e.desired)
                this.retry(e, true);
        }
    }
    private portOf(e: Entry): number | undefined {
        const h = e.config.health;
        return 'port' in h ? h.port : 'http' in h ? Number(new URL(h.http).port || (new URL(h.http).protocol === 'https:' ? 443 : 80)) : undefined;
    }
    /** Refuse to start into a port something else already holds; a check that can't decide never blocks the start. */
    private async launchChecked(e: Entry) {
        const port = this.portOf(e);
        if (port) {
            e.checkingPort = true;
            let inUse = false;
            try { inUse = await this.deps.portInUse(port); } catch { inUse = false; } finally { e.checkingPort = false; }
            if (this.closing || e.child || !e.desired) return;
            if (inUse) {
                this.state(e, 'failing');
                e.view.health = { ok: false, checkedAt: this.iso(), detail: `port ${port} is already in use by another process` };
                this.event(e, 'service.down');
                return;
            }
        }
        this.launch(e);
        // Probe the new child in the same pass, as a synchronous launch did.
        if (!this.closing) await Promise.all(this.step());
    }
    private launch(e: Entry) {
        this.state(e, 'starting');
        e.retryAt = undefined;
        e.nextProbe = 0;
        e.view.health = { ok: false, checkedAt: null, detail: 'Starting' };
        const log = new RotatingLog(path.join(this.home, 'logs', `${e.config.id}.log`));
        try {
            const child = this.deps.spawn(e.config);
            e.child = child;
            e.view.pid = child.pid ?? null;
            const write = (data: Buffer) => { try {
                log.write(data);
            }
            catch (err) {
                process.stderr.write(`tango-server log: ${String(err)}\n`);
            } };
            child.stdout?.on('data', write);
            child.stderr?.on('data', write);
            e.exited = new Promise(resolve => {
                let done = false;
                const finish = (failed: boolean) => {
                    if (done)
                        return;
                    done = true;
                    if (e.child !== child) { resolve(); return; }
                    const stopping = !!e.stop || this.closing;
                    e.child = undefined;
                    e.view.pid = null;
                    e.view.memoryBytes = null;
                    e.view.cpuPct = null;
                    e.view.health.ok = false;
                    // An exit handler must never throw: an uncaught error here took the whole server down (10/19, EPERM).
                    try {
                        if (!stopping && child.pid && this.deps.groupAlive(child.pid)) this.deps.signal(child.pid, 'SIGKILL');
                        // Keep ownership while descendants remain, including during a stop.
                        if (!child.pid || !this.deps.groupAlive(child.pid)) this.removePidfile(e.config.id);
                    } catch (err) {
                        process.stderr.write(`tango-server exit cleanup for ${e.config.id}: ${String(err)}\n`);
                    }
                    resolve();
                    if (!stopping) {
                        this.state(e, 'down');
                        this.event(e, 'service.down');
                        this.retry(e, failed);
                    }
                };
                child.once('exit', (code, signal) => finish(code !== 0 || signal !== null));
                child.once('error', () => finish(true));
            });
            if (child.pid) {
                fs.mkdirSync(path.join(this.home, 'run'), { recursive: true, mode: 0o700 });
                fs.writeFileSync(this.pidfile(e.config.id), JSON.stringify({ pid: child.pid, pgid: child.pid, startedAt: this.iso(), command: this.deps.command(child.pid) ?? e.config.command!.join(' ') }), { mode: 0o600 });
            }
        }
        catch {
            if (e.child?.pid) this.deps.signal(e.child.pid, 'SIGKILL');
            e.child = undefined;
            e.view.pid = null;
            this.state(e, 'down');
            this.event(e, 'service.down');
            this.retry(e, true);
        }
    }
    private retry(e: Entry, failed: boolean) {
        if (!e.desired || this.closing)
            return;
        const r = e.config.restart;
        if (r.policy === 'never' || (r.policy === 'on-failure' && !failed)) {
            e.desired = false;
            this.state(e, 'stopped');
            return;
        }
        const now = this.deps.now();
        e.failures = e.failures.filter(t => now - t < r.windowSeconds * 1000);
        if (e.failures.length >= r.maxRestarts) {
            this.state(e, 'failing');
            return;
        }
        e.retryAt = now + Math.min(r.backoffSeconds * 1000 * 2 ** e.failures.length, 2147483647);
        e.failures.push(now);
        e.view.restarts++;
        this.event(e, 'job.restarting');
    }
    private stopChild(e: Entry): Promise<void> {
        if (e.stop)
            return e.stop;
        const child = e.child, pid = child?.pid, exited = e.exited;
        if (!child || !pid || !exited)
            return Promise.resolve();
        // Set the stop guard before delivering signals, including synchronous injected exits.
        e.stop = Promise.resolve().then(async () => {
            const deadline = this.deps.now() + Math.min(e.config.health.graceSeconds, 10) * 1000;
            this.deps.signal(pid, 'SIGTERM');
            let ended = false;
            void exited.then(() => { ended = true; });
            await Promise.race([exited, this.deps.sleep(Math.min(e.config.health.graceSeconds, 10) * 1000)]);
            if (!ended) {
                this.deps.signal(pid, 'SIGKILL');
                await Promise.race([exited, this.deps.sleep(1000)]);
            }
            else if (this.deps.groupAlive(pid)) {
                // A parent may exit before descendants that ignored TERM. Retain group ownership
                // until the grace period expires and reap the remaining descendants too.
                await this.deps.sleep(Math.max(0, deadline - this.deps.now()));
                if (this.deps.groupAlive(pid))
                    this.deps.signal(pid, 'SIGKILL');
            }
            if (!this.deps.groupAlive(pid)) this.removePidfile(e.config.id);
        }).finally(() => { e.stop = undefined; });
        return e.stop;
    }
    async start(id: string) {
        const e = this.get(id);
        if (e.config.mode === 'observe')
            return false;
        if (this.closing)
            return false;
        if (e.stop)
            await e.stop;
        e.desired = true;
        e.failures = [];
        e.retryAt = undefined;
        if (!e.child)
            this.state(e, 'stopped');
        await this.tick();
        return true;
    }
    async stop(id: string) {
        const e = this.get(id);
        if (e.config.mode === 'observe')
            return false;
        e.desired = false;
        e.retryAt = undefined;
        await this.stopChild(e);
        this.state(e, 'stopped');
        return true;
    }
    async restart(id: string) { if (!await this.stop(id))
        return false; return this.start(id); }
    logs(id: string, lines: number) { const e = this.get(id); return tailLogs(e.config.mode === 'managed' ? [path.join(this.home, 'logs', `${id}.log`)] : e.logs, lines); }
    /** Add the child's current command line to its pidfile once it differs (a wrapper exec'd the real program). */
    private recordCommand(e: Entry, pid: number) {
        try {
            const file = this.pidfile(e.config.id);
            if (!fs.existsSync(file)) return;
            const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; command: string; commands?: string[] };
            if (record.pid !== pid) return;
            const current = this.deps.command(pid);
            const commands = record.commands ?? [record.command];
            if (!current || commands.includes(current)) return;
            fs.writeFileSync(file, JSON.stringify({ ...record, commands: [...commands, current] }), { mode: 0o600 });
        } catch (err) {
            process.stderr.write(`tango-server pidfile update for ${e.config.id}: ${String(err)}\n`);
        }
    }
    private pidfile(id: string) { return path.join(this.home, 'run', `${id}.json`); }
    private removePidfile(id: string) { fs.rmSync(this.pidfile(id), { force: true }); }
    async reap() {
        const dir = path.join(this.home, 'run');
        if (!fs.existsSync(dir)) return;
        await Promise.all(fs.readdirSync(dir).filter(f => /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(f)).map(async file => {
            // A bad pidfile must never stop the server from starting: log it, drop it, carry on.
            let record: { pid?: unknown; pgid?: unknown; command?: unknown };
            try { record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { record = {}; }
            const { pid, pgid, command } = record as { pid: number; pgid: number; command: string };
            // A wrapper (bash -lc, zsh script) that execs the real program changes the command line after spawn.
            const known = new Set<string>([command, ...(Array.isArray((record as { commands?: unknown }).commands) ? (record as { commands: string[] }).commands : [])]);
            if (!Number.isSafeInteger(pid) || pid <= 1 || pgid !== pid || typeof command !== 'string' || !command) {
                process.stderr.write(`tango-server ignored invalid pidfile ${file}\n`);
                fs.rmSync(path.join(dir, file), { force: true });
                return;
            }
            // The leader still running our command, or gone with its group still alive (orphaned
            // descendants of our child): either way that group is ours and must not outlive the record.
            const leaderAlive = this.deps.alive(pid);
            if ((leaderAlive && known.has(this.deps.command(pid) ?? '')) || (!leaderAlive && this.deps.groupAlive(pgid))) {
                this.deps.signal(pgid, 'SIGTERM');
                const grace = Math.min(this.entries.get(file.slice(0, -5))?.config.health.graceSeconds ?? 10, 15) * 1000;
                // Poll so cooperative groups do not delay startup.
                for (let elapsed = 0; elapsed < grace && this.deps.groupAlive(pgid); elapsed += 100)
                    await this.deps.sleep(Math.min(100, grace - elapsed));
                if (this.deps.groupAlive(pgid)) this.deps.signal(pgid, 'SIGKILL');
                process.stderr.write(`tango-server reaped pid ${pid} (${command})\n`);
            }
            fs.rmSync(path.join(dir, file), { force: true });
        }));
    }
    reload(services: Service[]): Promise<void> {
        const validated = servicesSchema.parse({ services }).services;
        const pending = this.reloadQueue.then(async () => {
            if (this.closing) return;
            this.reloading = true;
            try {
                const next = new Map(validated.map(s => [s.id, s]));
                const changed = this.order().reverse().filter(e => !isDeepStrictEqual(e.config, next.get(e.config.id)));
                await this.stopEntries(changed);
                if (this.closing) return;
                for (const e of changed) this.entries.delete(e.config.id);
                // Reuse initialization without replacing unchanged entries or their counters.
                const fresh = new Supervisor(validated.filter(s => !this.entries.has(s.id)), this.home, this.deps);
                for (const [id, e] of fresh.entries) this.entries.set(id, e);
            } finally { this.reloading = false; }
            await this.tick();
        });
        this.reloadQueue = pending.catch(() => {});
        return pending;
    }
    private async stopEntries(entries: Entry[]) {
        // Reverse topological order queues TERM delivery to dependents first, while
        // every grace deadline runs concurrently (long dependency chains stay bounded).
        await Promise.all(entries.filter(e => e.config.mode === 'managed').map(async e => {
            e.desired = false;
            await this.stopChild(e);
            this.state(e, 'stopped');
        }));
    }

    async shutdown() {
        this.closing = true;
        clearInterval(this.timer);
        // All grace deadlines run concurrently; dependency order governs TERM delivery.
        await this.stopEntries(this.order().reverse());
    }
}
