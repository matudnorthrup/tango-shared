import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultContext, openLedger, listEvents } from '@tango/system';
import { createSystemProbe, ingest } from '../src/system.js';
import { serviceSchema } from '../src/config.js';
it('reuses launchd discovery, HTTP probes and process resource sampling without mutations', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'server-probe-'));
    const calls: string[] = [];
    try {
        const probe = createSystemProbe(annotations => defaultContext(annotations, { homeDir: home, uid: 501, exec: async (bin, args) => {
                calls.push(`${bin} ${args.join(' ')}`);
                let stdout = '';
                if (bin === 'ps')
                    stdout = args.includes('rss=') ? '2048' : '123 1 501 Sun Oct 18 12:00:00 2026 2.5 node example.js';
                if (bin === 'launchctl')
                    stdout = args[0] === 'list' ? '123\t0\tcom.example.worker' : 'state = running\npid = 123\n';
                return { code: 0, stdout, stderr: '', timedOut: false };
            }, fetch: async () => ({ status: 200, text: 'ok' }) }));
        const r = await probe(serviceSchema.parse({ id: 'worker', name: 'Worker', mode: 'observe', adopt: { launchd: 'com.example.worker' }, health: { http: 'http://example.test/health' } }));
        expect(r).toMatchObject({ ok: true, pid: 123, memoryBytes: 2097152, cpuPct: 2.5 });
        expect(calls).toContain('launchctl list');
        expect(calls.some(c => c.startsWith('launchctl print'))).toBe(true);
        expect(calls.every(c => c.startsWith('ps ') || c === 'launchctl list' || c.startsWith('launchctl print'))).toBe(true);
    }
    finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
it('reuses tmux discovery for an adopted session and reports unavailable process discovery', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tmux-'));
    try {
        let unavailable = false;
        const probe = createSystemProbe(annotations => defaultContext(annotations, { homeDir: home, uid: 501, exec: async (bin, args) => ({ code: unavailable ? 1 : 0, stdout: unavailable ? '' : bin === 'tmux' ? 'worker|123|0|node' : args.includes('rss=') ? '1024' : '123 1 501 Sun Oct 18 12:00:00 2026 1.5 node worker.js', stderr: '', timedOut: false }) }));
        expect(await probe(serviceSchema.parse({ id: 'worker', name: 'Worker', health: { tmux: 'example:worker' }, adopt: { tmux: 'example:worker' } }))).toMatchObject({ ok: true, pid: 123 });
        unavailable = true;
        expect(await probe(serviceSchema.parse({ id: 'worker', name: 'Worker', health: { process: 'worker.js' } }))).toMatchObject({ ok: false, unavailable: true });
    }
    finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
it('ingests managed events into a temporary system ledger with the server source', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'server-ledger-')), old = process.env.TANGO_SYSTEM_DB;
    process.env.TANGO_SYSTEM_DB = path.join(home, 'system.sqlite');
    try {
        ingest({ source: 'tango-server', kind: 'service.down', title: 'Worker is down', severity: 'error', jobId: 'server:worker' });
        const ledger = openLedger({ path: process.env.TANGO_SYSTEM_DB });
        try {
            expect(listEvents(ledger)[0]).toMatchObject({ source: 'tango-server', kind: 'service.down', jobId: 'server:worker' });
        }
        finally {
            ledger.close();
        }
    }
    finally {
        if (old === undefined)
            delete process.env.TANGO_SYSTEM_DB;
        else
            process.env.TANGO_SYSTEM_DB = old;
        fs.rmSync(home, { recursive: true, force: true });
    }
});
it('matches managed process health against its own command line',async()=>{
    const probe=createSystemProbe(annotations=>defaultContext(annotations,{uid:501,exec:async(_bin,args)=>({code:0,stdout:args.includes('rss=')?'10':'123 1 501 Sun Oct 18 12:00:00 2026 1.0 node wrong.js\n124 1 501 Sun Oct 18 12:00:00 2026 1.0 node expected.js',stderr:'',timedOut:false})}));
    const config=serviceSchema.parse({id:'worker',name:'Worker',mode:'managed',command:['node','expected.js'],health:{process:'expected.js'}});
    expect(await probe(config,123)).toMatchObject({ok:false,pid:null});
    expect(await probe(config,124)).toMatchObject({ok:true,pid:124});
});

it('uses explicit process health independently of adoption and retains adopted resources', async () => {
    const probe = createSystemProbe(annotations => defaultContext(annotations, { uid: 501, exec: async (bin, args) => ({
        code: 0, stdout: bin === 'tmux' ? 'worker|123|0|node' : args.includes('rss=') ? '1024' : '123 1 501 Sun Oct 18 12:00:00 2026 1.5 node worker.js', stderr: '', timedOut: false,
    }) }));
    const config = serviceSchema.parse({ id: 'worker', name: 'Worker', adopt: { tmux: 'example:worker' }, health: { process: 'missing.js' } });
    const { Supervisor } = await import('../src/supervisor.js');
    const s = new Supervisor([config], '', { probe });
    await s.tick();
    expect(s.list()[0]).toMatchObject({ state: 'down', pid: 123, memoryBytes: 1048576, health: { ok: false } });
    await s.shutdown();
});
it('passes explicit sockets to adoption and independent tmux health, and checks pane liveness', async () => {
    const calls: string[][] = [];
    let dead = false;
    const probe = createSystemProbe(annotations => defaultContext(annotations, { uid: 501, exec: async (bin, args) => {
        if (bin === 'tmux') calls.push(args);
        return { code: 0, stdout: bin === 'tmux' ? `worker|${dead ? 999 : 123}|0|node` : args.includes('rss=') ? '1024' : '123 1 501 Sun Oct 18 12:00:00 2026 1.5 node worker.js', stderr: '', timedOut: false };
    } }));
    const config = serviceSchema.parse({ id: 'worker', name: 'Worker', adopt: { tmux: 'example:worker', socket: '/test/adopt.sock' }, health: { tmux: 'health:worker', socket: '/test/health.sock' } });
    expect(await probe(config)).toMatchObject({ ok: true, pid: 123, memoryBytes: 1048576 });
    expect(calls.map(args => args.slice(0, 2))).toEqual([['-S', '/test/adopt.sock'], ['-S', '/test/health.sock']]);
    dead = true;
    expect(await probe(config)).toMatchObject({ ok: false });
    expect(await probe(serviceSchema.parse({ id: 'worker', name: 'Worker', adopt: { tmux: 'example:worker', socket: '/test/adopt.sock' } }))).toMatchObject({ ok: true });
});
it('uses explicit launchd job state even when adopting a live tmux pane', async () => {
    const probe = createSystemProbe(annotations => defaultContext(annotations, { uid: 501, homeDir: '/nonexistent-server-test', exec: async (bin, args) => ({
        code: 0, stdout: bin === 'tmux' ? 'worker|123|0|node' : bin === 'launchctl' ? (args[0] === 'list' ? '123\t0\tcom.example.health' : '\tstate = waiting\n\tpid = 123\n') : args.includes('rss=') ? '1024' : '123 1 501 Sun Oct 18 12:00:00 2026 1.5 node worker.js', stderr: '', timedOut: false,
    }) }));
    expect(await probe(serviceSchema.parse({ id: 'worker', name: 'Worker', adopt: { tmux: 'example:worker' }, health: { launchd: 'com.example.health' } }))).toMatchObject({ ok: false, pid: 123 });
});

it('does not trust an HTTP answer without a managed process in the snapshot', async () => {
    const probe = createSystemProbe(annotations => defaultContext(annotations, { uid: 501,
        exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
        fetch: async () => ({ status: 200, text: 'ok' }),
    }));
    const config = serviceSchema.parse({ id: 'worker', name: 'Worker', mode: 'managed', command: ['node', 'worker.js'], health: { http: 'http://example.test/health' } });
    for (const pid of [undefined, 123])
        expect(await probe(config, pid)).toMatchObject({ ok: false, detail: 'port answered but the managed child is not running' });
});
