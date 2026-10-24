import { defaultContext, discoverLaunchd, discoverTmux, normalizeAnnotations, openLedger, parsePs, probeService, PS_ARGS, recordEvent, resolveSystemDbPath, type RecordEventInput } from '@tango/system';
import type { SystemContext } from '@tango/system';
import type { Service } from './config.js';
export interface Reading {
    ok: boolean;
    detail: string;
    unavailable?: boolean;
    pid?: number | null;
    memoryBytes?: number | null;
    cpuPct?: number | null;
    logs?: string[];
}
export function createSystemProbe(context: (annotations: ReturnType<typeof normalizeAnnotations>) => SystemContext = defaultContext) {
    return async function probe(s: Service, managedPid?: number): Promise<Reading> {
        const h = s.health;
        // Adoption supplies identity and resources; explicit health supplies the verdict.
        const ctx = context(normalizeAnnotations({}));
        const snapshot = await ctx.exec('ps', PS_ARGS, { timeoutMs: 3000 });
        const processes = parsePs(snapshot.stdout);
        type Target = NonNullable<Service['adopt']>;
        const discover = async (target: Target, explicitHealth = false): Promise<Reading> => {
            const discoveryCtx = { ...ctx, annotations: normalizeAnnotations({
                prefixes: { launchd: 'launchd' in target ? [target.launchd] : [] },
                tmux: 'tmux' in target ? { session: target.tmux.split(':')[0] } : {},
            }) };
            const input = { ctx: discoveryCtx, prev: () => null, processes };
            const found = 'launchd' in target ? await discoverLaunchd(input) : await discoverTmux(input, async () => null, target.socket);
            const job = found.jobs.find(j => 'launchd' in target ? j.id === `launchd:${target.launchd}` : j.probe?.tmux === target.tmux);
            const pid = typeof job?.facts?.pid === 'number' ? job.facts.pid : null;
            const panePid = job?.facts?.panePid;
            let alive = !!pid && job?.lastStatus === 'running';
            if (explicitHealth) {
                if ('tmux' in target) alive = alive && processes.some(p => p.pid === panePid);
                else if (job?.facts?.launchdState != null) alive = job.facts.launchdState === 'running';
            }
            return { ok: alive, detail: !found.complete ? 'Discovery unavailable' : alive ? 'Process running' : 'Process not found',
                unavailable: !found.complete || (explicitHealth && 'tmux' in target && snapshot.code !== 0), pid, logs: [...new Set(job?.logs ?? [])] };
        };
        const adopted = s.adopt ? await discover(s.adopt) : undefined;
        let pid = adopted?.pid ?? managedPid ?? null;
        let result: Reading;
        if ('http' in h || 'port' in h) {
            result = await probeService(ctx, { id: s.id, name: s.name, ...('http' in h ? { url: h.http } : { port: h.port }) });
        } else if ('process' in h) {
            const re = new RegExp(h.process);
            const matched = processes.find(p => p.uid === ctx.uid && p.pid !== process.pid && (!managedPid || p.pid === managedPid) && re.test(p.command));
            if (!s.adopt) pid = matched?.pid ?? null;
            result = { ok: !!matched, detail: matched ? 'Process running' : 'Process not found', unavailable: snapshot.code !== 0 };
        } else if ('tmux' in h || 'launchd' in h) {
            const target: Target = 'tmux' in h ? { tmux: h.tmux, socket: h.socket } : { launchd: h.launchd };
            result = await discover(target, true);
            if (!s.adopt && !managedPid) pid = result.pid ?? null;
        } else {
            result = adopted!;
        }
        if (s.mode === 'managed' && (!managedPid || snapshot.code !== 0 || !processes.some(p => p.pid === managedPid))) {
            result = { ...result, ok: false, detail: result.ok ? 'port answered but the managed child is not running' : 'Managed child is not running' };
        }
        const logs = adopted?.logs ?? result.logs ?? [];
        let memoryBytes: number | null = null;
        if (pid) {
            const rss = await ctx.exec('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 2000 });
            const kb = Number(rss.stdout.trim());
            if (rss.code === 0 && rss.stdout.trim() && Number.isFinite(kb))
                memoryBytes = kb * 1024;
        }
        return { ...result, pid, memoryBytes, cpuPct: processes.find(p => p.pid === pid)?.cpu ?? null, logs };
    };
}
export const probe = createSystemProbe();
/** Lazy ledger opening is essential: observe-only runs never write or create a database. */
export function ingest(event: RecordEventInput): void {
    const ledger = openLedger({ path: resolveSystemDbPath() });
    try {
        recordEvent(ledger, event);
    }
    finally {
        ledger.close();
    }
}
