import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServiceView } from './supervisor.js';

// 0: success, 1: negative predicate/state or rejected action, 2: usage,
// 3: unavailable server/token, 4: unknown service.
export async function serviceCommand(argv: string[]): Promise<number> {
    const verbose = argv.includes('-v');
    const [command, id, ...extra] = argv.filter(a => a !== '-v');
    if (!command || extra.length || (!id && command !== 'status') ||
        !['managed', 'status', 'start', 'stop', 'restart'].includes(command)) {
        if (verbose) console.error('Usage: tango-server managed|status|start|stop|restart <id> [-v]');
        return 2;
    }
    try {
        const home = process.env.TANGO_SERVER_HOME ?? path.join(os.homedir(), '.tango/server');
        const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
        const request = async (route: string, method = 'GET') => {
            const response = await fetch(`http://127.0.0.1:${process.env.TANGO_SERVER_PORT ?? 9440}${route}`, {
                method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) throw new Error(`Server HTTP ${response.status}`);
            return response.json();
        };
        const { services } = await request('/services') as { services: ServiceView[] };
        if (!id) { if (verbose) console.table(services); return 0; }
        const service = services.find(s => s.id === id);
        if (!service) return command === 'managed' ? 1 : 4;
        if (verbose) console.log(JSON.stringify(service));
        // Ownership persists while stopped, waiting for dependencies or failing.
        if (command === 'managed') return service.mode === 'managed' ? 0 : 1;
        if (command === 'status') return service.state === 'running' ? 0 : 1;
        if (service.mode !== 'managed') return 1;
        const result = await request(`/services/${encodeURIComponent(id)}/${command}`, 'POST') as { ok: boolean };
        return result.ok === true ? 0 : 1;
    } catch (err) {
        if (verbose) console.error(String(err));
        // Unknown ownership is not "unmanaged": callers must not fall back to a legacy start (it could double a service).
        return 3;
    }
}
