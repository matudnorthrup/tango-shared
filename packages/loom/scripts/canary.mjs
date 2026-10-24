#!/usr/bin/env node
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { run, liveHostLedgers, atomicJSON, processStart } from './release.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, timeout) {
  const end = Date.now() + timeout;
  let value, error;
  while (Date.now() < end) {
    try { value = await read(); if (accept(value)) return value; } catch (caught) { error = caught; }
    await delay(30);
  }
  throw new Error(`Canary timed out: ${label}: ${JSON.stringify(value)} ${error ?? ''}`);
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
/** Run the very same scratch coordinator/host drill with either Claude or the process fake. */
export async function canary(id, options = {}) {
  const root = resolve(options.root ?? process.env.LOOM_RELEASES_DIR ?? join(homedir(), '.tango/releases/loom'));
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Usage: canary <id> --account <name> [--accounts <file>]');
  const state = JSON.parse(fs.readFileSync(join(root, 'state.json'), 'utf8'));
  if (!state.candidates.includes(id)) throw new Error('Only candidates can be canaried');
  const release = join(root, id);
  const main = join(release, 'packages/loom/dist/main.js');
  if (!fs.existsSync(main)) throw new Error('Candidate has no coordinator');
  if (!options.account) throw new Error('--account is required (manager-run only)');
  const fake = options.fake === true;
  let account;
  if (fake) account = { name: options.account };
  else {
    const accountsFile = options.accounts ?? process.env.LOOM_ACCOUNTS;
    if (!accountsFile) throw new Error('Set --accounts or LOOM_ACCOUNTS to the manager account configuration');
    account = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).claude?.accounts.find(a => a.name === options.account);
    if (!account) throw new Error(`Unknown Claude account: ${options.account}`);
  }
  // Short paths are required for Unix sockets on macOS.
  const home = fs.mkdtempSync('/tmp/loom-canary-');
  const token = randomUUID();
  const timeout = options.timeout ?? 120_000;
  let child, call, output = '';
  const checks = [];
  const start = async () => {
    const port = await freePort();
    child = spawn(process.execPath, [main], {
      env: { ...process.env, LOOM_HOME: home, TANGO_PROFILE_DIR: join(home, 'profile'), LOOM_RULES_FILE: join(home, 'profile', 'decisions', 'rules.md'), LOOM_PORT: String(port), LOOM_RELEASES_DIR: join(home, 'releases'), LOOM_RELEASE: id,
        LOOM_ACCOUNTS: join(home, 'accounts.json'), LOOM_USAGE_URL: '', LOOM_FAKE_RUNTIME: fake ? '1' : '', LOOM_FAKE_TURN_MS: '1800' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { output = (output + data).slice(-16000); });
    child.stderr.on('data', data => { output = (output + data).slice(-16000); });
    call = async (path, command) => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Canary coordinator exited: ${output}`);
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(command ? { method: 'POST', body: JSON.stringify(command) } : {}), signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(JSON.stringify(body));
      return body;
    };
    await until(() => call('/health'), body => body.ok, 'health', timeout);
  };
  const command = value => call('/commands', { commandId: randomUUID(), ...value });
  const detail = id => call(`/threads/${id}`);
  const waitRun = (thread, run, status) => until(() => detail(thread), body => body.runs.some(r => r.id === run && r.status === status), status, timeout);
  const submit = async (threadId, text) => (await command({ type: 'submit', ...(threadId ? { threadId } : { provider: 'claude', cwd: home, account: options.account, accounts: [options.account], autoTitle: false }), text })).result;
  const ledger = thread => JSON.parse(fs.readFileSync(join(home, 'hosts', `${thread}.json`), 'utf8'));
  try {
    fs.writeFileSync(join(home, 'token'), token, { mode: 0o600 });
    atomicJSON(join(home, 'accounts.json'), { claude: { default: account.name, accounts: [account] } });
    fs.mkdirSync(join(home, 'releases'));
    fs.symlinkSync(release, join(home, 'releases', id));
    atomicJSON(join(home, 'releases/state.json'), { current: id, previous: null, candidates: [], history: [], pins: {} });
    await start();
    const first = await submit(null, 'Reply with CANARY_OK.');
    const completed = await waitRun(first.threadId, first.runId, 'completed');
    const native = completed.thread.native_session_id;
    if (!native || completed.thread.host_release !== id) throw new Error('Canary did not open a native session on the candidate');
    checks.push('submit');
    const longPrompt = fake ? 'canary slow crash' : 'Use the Bash tool to run sleep 12, then reply CANARY_CRASH_OK.';
    const crash = await submit(first.threadId, longPrompt);
    await waitRun(first.threadId, crash.runId, 'running');
    const pid = ledger(first.threadId).pid;
    await stop(child, 'SIGKILL');
    await start();
    if (ledger(first.threadId).pid !== pid) throw new Error('Canary failed to reattach original host');
    const recovered = await waitRun(first.threadId, crash.runId, 'completed');
    if (recovered.runs.filter(r => r.id === crash.runId).length !== 1) throw new Error('Crash duplicated run');
    checks.push('crash-reattach');
    const interrupt = await submit(first.threadId, fake ? 'canary slow interrupt' : 'Use the Bash tool to run sleep 30, then reply CANARY_INTERRUPT_FAILED.');
    await waitRun(first.threadId, interrupt.runId, 'running');
    await command({ type: 'interrupt', threadId: first.threadId, runId: interrupt.runId });
    await waitRun(first.threadId, interrupt.runId, 'interrupted');
    checks.push('interrupt');
    // An idle host loss forces a new process to open the recorded native session.
    await stop(child);
    const live = liveHostLedgers(home).find(h => h.threadId === first.threadId);
    if (!live) throw new Error('Missing live native session host');
    process.kill(live.pid, 'SIGKILL');
    await until(() => liveHostLedgers(home), hosts => !hosts.some(h => h.pid === live.pid), 'host exit', timeout);
    await start();
    const resumed = await submit(first.threadId, 'Reply with CANARY_RESUME_OK.');
    const final = await waitRun(first.threadId, resumed.runId, 'completed');
    if (final.thread.native_session_id !== native || ledger(first.threadId).pid === live.pid) throw new Error('Native session did not resume on a new host');
    checks.push('native-resume');
    // Promotion checks the real hosts directory, never the scratch directory.
    run(['promote', id], { root, ...(options.loomHome ? { loomHome: options.loomHome } : {}) });
    return { id, checks };
  } finally {
    await stop(child);
    for (const host of liveHostLedgers(home)) {
      for (const group of host.groups ?? []) {
        // Host owns harness cleanup on graceful close; forced scratch cleanup also checks identity.
        const match = liveHostLedgers(home).find(h => h.pid === host.pid);
        if (match && group.pid > 1 && group.started && processStart(group.pid) === group.started) { try { process.kill(-group.pid, 'SIGKILL'); } catch {} }
      }
      try { process.kill(host.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [id, ...args] = process.argv.slice(2);
  const options = {};
  try {
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!['--account', '--accounts'].includes(flag) || !value) throw new Error('Usage: canary <id> --account <name> [--accounts <file>]');
      options[flag.slice(2)] = value;
    }
    console.log(JSON.stringify(await canary(id, options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
