import { createServer, type IncomingMessage } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Supervisor } from './supervisor.js';
export interface ReleaseState {
    current: string | null;
    previous: string | null;
    releases: {
        id: string;
        status: string;
        bytes: number;
        buildTime: string | null;
    }[];
}
const releaseId = z.string().regex(/^[a-zA-Z0-9-]+$/);
export function readReleases(root: string): ReleaseState {
    let state: {
        current: string | null;
        previous: string | null;
        candidates: string[];
    } = { current: null, previous: null, candidates: [] };
    if (fs.existsSync(path.join(root, 'state.json')))
        state = z.object({ current: releaseId.nullable(), previous: releaseId.nullable(), candidates: z.array(releaseId).default([]) }).parse(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')));
    function bytes(file: string): number { const s = fs.lstatSync(file); return s.isDirectory() ? fs.readdirSync(file).reduce((n, f) => n + bytes(path.join(file, f)), 0) : s.size; }
    const releases = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && releaseId.safeParse(e.name).success && fs.existsSync(path.join(root, e.name, 'release.json'))).map(e => {
        const meta = JSON.parse(fs.readFileSync(path.join(root, e.name, 'release.json'), 'utf8'));
        return { id: e.name, status: e.name === state.current ? 'current' : e.name === state.previous ? 'previous' : state.candidates.includes(e.name) ? 'candidate' : 'available', bytes: bytes(path.join(root, e.name)), buildTime: typeof meta.buildTime === 'string' ? meta.buildTime : null };
    }).sort((a, b) => b.id.localeCompare(a.id)) : [];
    return { current: state.current, previous: state.previous, releases };
}
export interface ApiOptions {
    reload?: () => Promise<void>;
    token: string;
    version?: string;
    startedAt?: string;
    releasesDir: string;
    homeDir: string;
    loomUrl: string;
    loomToken: () => string;
    fetch?: typeof fetch;
    runner?: (command: string, args: string[], options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
    }) => Promise<unknown>;
    uid?: number;
}
async function body(req: IncomingMessage): Promise<unknown> { let text = ''; for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384)
        throw new Error('Body too large');
} return JSON.parse(text); }
export function createApi(supervisor: Supervisor, o: ApiOptions) {
    const startedAt = o.startedAt ?? new Date().toISOString(), runner = o.runner ?? promisify(execFile);
    let rollingBack = false;
    const proxy = async (route: string, method = 'GET', data?: unknown) => {
        const response = await (o.fetch ?? fetch)(`${o.loomUrl}${route}`, { method, headers: { Authorization: `Bearer ${o.loomToken()}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(8000) });
        if (route === '/maintenance' && response.status === 404)
            return { status: 501, data: { code: 'loom_unsupported' } };
        return { status: response.status, data: await response.json() };
    };
    return createServer(async (req, res) => {
        const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1'), method = req.method;
            if (method === 'GET' && url.pathname === '/health') {
                send(200, { ok: true, version: o.version ?? '0.1.0', startedAt });
                return;
            }
            const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${o.token}`);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
                send(401, { ok: false });
                return;
            }
            if (method === 'GET' && url.pathname === '/services') {
                send(200, { services: supervisor.list() });
                return;
            }
            if (method === 'POST' && url.pathname === '/reload') {
                if (!o.reload) { send(501, { ok: false }); return; }
                await o.reload();
                send(200, { ok: true });
                return;
            }
            const match = url.pathname.match(/^\/services\/([^/]+)\/(logs|start|stop|restart)$/);
            if (match) {
                const id = decodeURIComponent(match[1]!), action = match[2]!;
                if (!supervisor.list().some(s => s.id === id)) {
                    send(404, { ok: false });
                    return;
                }
                if (method === 'GET' && action === 'logs') {
                    const raw = url.searchParams.get('lines') ?? '200', lines = Number(raw);
                    if (!Number.isInteger(lines) || lines < 1 || lines > 10000) {
                        send(400, { ok: false });
                        return;
                    }
                    send(200, { lines: supervisor.logs(id, lines) });
                    return;
                }
                if (method === 'POST' && action !== 'logs') {
                    if (supervisor.mode(id) === 'observe') {
                        send(409, { ok: false, code: 'observe' });
                        return;
                    }
                    const ok = await supervisor[action as 'start' | 'stop' | 'restart'](id);
                    send(200, { ok });
                    return;
                }
            }
            if (url.pathname === '/maintenance' && (method === 'GET' || method === 'POST')) {
                let data: unknown;
                if (method === 'POST') {
                    try {
                        data = z.strictObject({ on: z.boolean(), reason: z.string().optional() }).parse(await body(req));
                    }
                    catch {
                        send(400, { ok: false });
                        return;
                    }
                }
                const r = await proxy('/maintenance', method, data);
                send(r.status, r.data);
                return;
            }
            if (method === 'GET' && url.pathname === '/releases') {
                send(200, readReleases(o.releasesDir));
                return;
            }
            if (method === 'POST' && url.pathname === '/releases/rollback') {
                if (rollingBack) {
                    send(409, { ok: false, code: 'rollback_in_progress' });
                    return;
                }
                rollingBack = true;
                try {
                    const state = readReleases(o.releasesDir);
                    if (!state.current || !state.previous) {
                        send(409, { ok: false, code: 'no_previous_release' });
                        return;
                    }
                    const current = path.join(o.releasesDir, state.current);
                    const script = path.join(current, 'packages/loom/scripts/release.mjs');
                    await runner(process.execPath, [script, 'rollback'], { cwd: current, env: { ...process.env, LOOM_RELEASES_DIR: o.releasesDir } });
                    await runner('launchctl', ['kickstart', '-k', `gui/${o.uid ?? process.getuid?.() ?? 0}/com.tango.loom`], {});
                    send(200, { ok: true });
                }
                finally {
                    rollingBack = false;
                }
                return;
            }
            if (method === 'GET' && url.pathname === '/resources') {
                const r = await proxy('/machine');
                if (r.status !== 200) {
                    send(r.status, r.data);
                    return;
                }
                const disk = fs.statfsSync(o.homeDir);
                send(200, { ...(r.data as object), disk: { totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize } });
                return;
            }
            send(404, { ok: false });
        }
        catch (err) {
            send(502, { ok: false, code: 'upstream_error', detail: err instanceof Error ? err.message : String(err) });
        }
    });
}
