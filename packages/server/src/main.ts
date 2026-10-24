#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serviceCommand } from './cli.js';
const home = process.env.TANGO_SERVER_HOME ?? path.join(os.homedir(), '.tango/server');
const port = Number(process.env.TANGO_SERVER_PORT ?? 9440);
const repo = process.env.TANGO_REPO_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function xml(s: string) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
export function plist() {
    const args = [process.execPath, fileURLToPath(import.meta.url), 'run'].map(a => `<string>${xml(a)}</string>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.tango.server</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ExitTimeOut</key><integer>30</integer><key>WorkingDirectory</key><string>${xml(repo)}</string></dict></plist>`;
}
async function main() {
    const command = process.argv[2];
    if (command === 'plist') {
        console.log(plist());
        return;
    }
    if (['managed', 'status', 'start', 'stop', 'restart'].includes(command ?? '')) {
        process.exitCode = await serviceCommand(process.argv.slice(2));
        return;
    }
    if (command !== 'run')
        throw new Error('Usage: tango-server run|plist|managed|status|start|stop|restart [id] [-v]');
    const [{ resolveTangoProfileDir }, { loadServices, ensureToken }, { Supervisor }, { createApi }] = await Promise.all([
        import('@tango/core'), import('./config.js'), import('./supervisor.js'), import('./api.js'),
    ]);
    const readServices = () => loadServices(path.join(repo, 'config/services.yaml'), path.join(resolveTangoProfileDir(), 'config/services.yaml'));
    const token = ensureToken(home), supervisor = new Supervisor(readServices(), home);
    const reload = async () => supervisor.reload(readServices());
    const loomHome = process.env.LOOM_HOME ?? path.join(os.homedir(), '.tango/loom');
    const server = createApi(supervisor, { reload, token, homeDir: os.homedir(), releasesDir: process.env.LOOM_RELEASES_DIR ?? path.join(os.homedir(), '.tango/releases/loom'),
        loomUrl: `http://127.0.0.1:${process.env.LOOM_PORT ?? 9420}`, loomToken: () => fs.readFileSync(path.join(loomHome, 'token'), 'utf8').trim() });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    let closing = false;
    const shutdown = async () => { if (closing)
        return; closing = true; server.close(); server.closeAllConnections(); await supervisor.shutdown(); };
    process.on('SIGHUP', () => { if (!closing) void reload().catch(err => console.error(err)); });
    process.once('SIGINT', () => { void shutdown().catch(err => { console.error(err); process.exitCode = 1; }); });
    process.once('SIGTERM', () => { void shutdown().catch(err => { console.error(err); process.exitCode = 1; }); });
    try {
        await supervisor.run();
        console.log(`tango-server listening on 127.0.0.1:${port}`);
    }
    catch (err) {
        await shutdown();
        throw err;
    }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
    void main().catch(err => { console.error(String(err)); process.exitCode = 1; });
