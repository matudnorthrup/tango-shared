import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { matchAccount, publicResult, StartWork } from '../server/desk/start-work.js';
import { cid, makeHarness, type Harness } from './desk-harness.js';

// Start work on Loom: the `loom` account, one submit to Loom's /commands, the new item filed at once.
// Loom is stubbed at its HTTP boundary: the request is asserted as the contract says, and the
// answers are the contract's (a thread, or git's own refusal of the worktree).

const TOKEN = 'test-token';
let h: Harness;
let server: Server;
let port: number;
let commands: Array<Record<string, unknown>>;
/** What the next submit answers; the default starts thread th-1. */
let answer: { status: number; body: unknown };
let source: DeskLoomSource;
let policyFile: string;
/** Whether the stub answers /health (Loom up) or not (stopped or restarting). */
let healthy: boolean;

const projects = [
  { id: 'p-tango', title: 'tango', workspaceRoot: '/repos/tango' },
  { id: 'p-sideproject', title: 'sideproject', workspaceRoot: '/repos/sideproject' },
];

function detail(threadId: string, cwd: string, text: string) {
  return {
    thread: { id: threadId, title: 'Fix the flaky export test.', cwd, status: 'running', created_at: h.clock.now, updated_at: h.clock.now, settled_at: null },
    runs: [{ id: 'run-1', status: 'running', failure: null, started_at: h.clock.now, ended_at: null }],
    messages: [{ id: 'm-1', role: 'user', text, created_at: h.clock.now }],
    requests: [],
  };
}

function service(withLoom = true) {
  return new StartWork({
    ...(withLoom ? { loom: source } : {}),
    repos: projects.map(p => ({ id: p.id, name: p.title, path: p.workspaceRoot })),
    accountsFile: path.join(h.dir, 'accounts.json'),
    policyFile,
    git: async (_cwd, args) => (args.includes('symbolic-ref') ? 'origin/main' : 'feature/local'),
    now: () => h.clock.now,
  });
}

beforeEach(async () => {
  h = makeHarness();
  commands = [];
  healthy = true;
  answer = { status: 200, body: { ok: true, result: { threadId: 'th-1', runId: 'run-1' } } };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/health') return healthy ? reply(200, { ok: true, seq: 1 }) : reply(503, { ok: false });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { ok: false, code: 'unauthorized' });
      if (req.method === 'POST' && req.url === '/commands') {
        commands.push(JSON.parse(raw));
        return reply(answer.status, answer.body);
      }
      const thread = /^\/threads\/([^/]+)$/.exec(req.url ?? '')?.[1];
      const submit = commands.at(-1) as { text: string; cwd?: string; worktree?: { repoPath: string } } | undefined;
      // Loom's worktree for a thread is its own checkout; the repo's path stands in for it here.
      if (thread && submit) return reply(200, detail(thread, submit.cwd ?? submit.worktree?.repoPath ?? '/repos/parent-tree', submit.text));
      reply(404, { ok: false, code: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  fs.writeFileSync(path.join(h.dir, 'token'), `${TOKEN}\n`);
  fs.writeFileSync(
    path.join(h.dir, 'accounts.json'),
    JSON.stringify({ claude: { accounts: [{ name: 'claude_home', usageName: 'Claude (Home)' }] }, codex: { accounts: [{ name: 'codex', usageName: 'ChatGPT (Home)' }] } }),
  );
  policyFile = path.join(h.dir, 'start-work.yaml');
  source = new DeskLoomSource({ core: h.core, url: `http://127.0.0.1:${port}`, tokenFile: path.join(h.dir, 'token') });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  h.close();
});

describe('Start work on Loom', () => {
  it('offers Loom as the last account only when Loom runs here, and makes it every repo’s default', async () => {
    expect((await service(false).options()).accounts.map((a) => a.id)).toEqual(['claude_home', 'codex']);
    const options = await service().options();
    expect(options.accounts.map((a) => a.id)).toEqual(['claude_home', 'codex', 'loom']);
    expect(options.accounts.at(-1)).toMatchObject({ name: 'Loom (best account)', driver: 'loom' });
    expect(options.repos.find((r) => r.name === 'tango')).toMatchObject({ account: 'loom' });
    expect((await service(false).options()).repos.find((r) => r.name === 'tango')!.account).toBe('loom');
    // "claude" still means the one Claude seat: Loom isn't one.
    expect(matchAccount('claude', options.accounts)?.id).toBe('claude_home');
    expect(matchAccount('loom', options.accounts)?.id).toBe('loom');
  });

  it('passes same-tree workers through without asking Loom to create another worktree', async () => {
    const result = await service().start({ repo: 'tango', prompt: 'Build it', sameTree: true, role: 'worker', parentItemId: 'loom:parent', commandId: cid() });
    expect(result).toMatchObject({ ok: true });
    expect(commands[0]).toMatchObject({ type: 'submit', sameTree: true, role: 'worker', parentThreadId: 'loom:parent' });
    expect(commands[0]).not.toHaveProperty('worktree');
    expect(commands[0]).not.toHaveProperty('cwd');
  });

  it('refuses same-tree without a worker parent or combined with a mode', async () => {
    for (const extra of [{}, { role: 'worker' as const }, { role: 'worker' as const, parentItemId: 'loom:parent', mode: 'auto' }]) {
      const result = await service().start({ repo: 'tango', prompt: 'Build it', sameTree: true, ...extra, commandId: cid() });
      expect(result.ok).toBe(false);
    }
    expect(commands).toEqual([]);
  });

  it('passes explicit Auto through to Loom without requesting a worktree', async () => {
    const commandId = cid();
    const result = await service().start({ repo: 'tango', prompt: 'Build it', mode: 'auto', commandId });
    expect(result).toMatchObject({ ok: true, plan: { mode: 'auto' } });
    expect(commands).toEqual([expect.objectContaining({ type: 'submit', cwd: '/repos/tango', worktree: 'auto' })]);
  });

  it('sends one submit with a worktree off the repo, and the new item is on the desk when it answers', async () => {
    const commandId = cid();
    const result = await service().start({ repo: 'tango', prompt: 'Fix the flaky export test. It fails on CI.', account: 'loom', commandId });
    expect(commands).toEqual([{ type: 'submit', commandId, text: 'Fix the flaky export test. It fails on CI.', provider: 'claude', title: 'Fix the flaky export test.', kind: 'coding', worktree: { repoPath: '/repos/tango' }, autoTitle: true }]);
    expect(result).toMatchObject({ ok: true, threadId: 'th-1', itemId: 'loom:th-1', plan: { account: { id: 'loom' }, mode: 'worktree' } });
    expect(h.core.item('loom:th-1')).toMatchObject({ source: 'loom', agentName: 'Loom', area: 'tango', nextStep: 'working' });
  });

  it("lets Loom name the thread only when the owner didn't give a title", async () => {
    await service().start({ repo: 'tango', prompt: 'Fix it', account: 'loom', title: 'Export test fix', commandId: cid() });
    expect(commands.at(-1)).toMatchObject({ title: 'Export test fix' });
    expect(commands.at(-1)).not.toHaveProperty('autoTitle');
  });

  it('local mode runs in the checkout itself; a retried command id starts nothing new', async () => {
    const svc = service();
    const commandId = cid();
    const first = await svc.start({ repo: 'sideproject', prompt: 'Tidy the README', account: 'loom', mode: 'local', commandId });
    const again = await svc.start({ repo: 'sideproject', prompt: 'Tidy the README', account: 'loom', mode: 'local', commandId });
    expect(again).toBe(first);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ commandId, cwd: '/repos/sideproject' });
    expect(commands[0]).not.toHaveProperty('worktree');
  });

  it("a refused worktree comes back as git's own message, and the same id can retry", async () => {
    answer = { status: 409, body: { ok: false, code: 'worktree_failed', message: "fatal: couldn't find remote ref main" } };
    const svc = service();
    const commandId = cid();
    const failed = await svc.start({ repo: 'tango', prompt: 'Fix it', account: 'loom', commandId });
    expect(failed).toMatchObject({ ok: false, error: "fatal: couldn't find remote ref main" });
    expect(publicResult(failed)).toMatchObject({ ok: false, error: "fatal: couldn't find remote ref main" });
    answer = { status: 200, body: { ok: true, result: { threadId: 'th-2', runId: 'run-2' } } };
    expect(await svc.start({ repo: 'tango', prompt: 'Fix it', account: 'loom', commandId })).toMatchObject({ ok: true, itemId: 'loom:th-2' });
    expect(commands.map((command) => command.commandId)).toEqual([commandId, commandId]);
  });

  it('sends plan-first instructions and images to Loom', async () => {
    const svc = service();
    const image = { name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const planned = await svc.start({ repo: 'tango', prompt: 'Plan the migration', account: 'loom', plan: true });
    expect(planned.ok).toBe(true);
    expect(commands.at(-1)?.text).toContain('wait for explicit approval before implementing');
    const withImage = await svc.start({ repo: 'tango', prompt: 'Look at this', account: 'loom', attachments: [image], commandId: cid() });
    expect(withImage).toMatchObject({ ok: true });
    expect(commands.at(-1)).toMatchObject({ attachments: [image] });
  });

  it("keeps a Loom thread inside the policy's accounts for its repo, and says which one it starts on", async () => {
    fs.writeFileSync(
      path.join(h.dir, 'accounts.json'),
      JSON.stringify({ claude: { accounts: [{ name: 'claude_home', usageName: 'Claude (Home)' }, { name: 'claude_team', usageName: 'Claude (Team)' }, { name: 'claude_spare', usageName: 'Claude (Spare)' }] } }),
    );
    fs.writeFileSync(policyFile, ['default: claude_home', 'repos:', '  sideproject: [claude_team, claude_spare]'].join('\n'));
    const svc = service();
    // An unlisted repo: the default account only.
    const check = await svc.check({ repo: 'tango', prompt: 'Fix it', account: 'loom' });
    expect(check.plan?.account).toMatchObject({ id: 'loom', name: 'Loom · Claude (Home)' });
    await svc.start({ repo: 'tango', prompt: 'Fix it', account: 'loom', commandId: cid() });
    expect(commands.at(-1)).toMatchObject({ account: 'claude_home', accounts: ['claude_home'] });
    // A pooled repo: the pool's pick to start, and only the pool afterwards.
    await svc.start({ repo: 'sideproject', prompt: 'Tidy it', account: 'loom', commandId: cid() });
    const sent = commands.at(-1) as { account: string; accounts: string[] };
    expect(commands.at(-1)).toHaveProperty('accountsFrom', 'policy');
    expect(sent.accounts).toEqual(['claude_team', 'claude_spare']);
    expect(sent.accounts).toContain(sent.account);
  });

  it('never sends a Codex account to Loom, and refuses a repo whose rules have no Claude account', async () => {
    fs.writeFileSync(policyFile, ['default: claude_home', 'repos:', '  sideproject: [codex]'].join('\n'));
    const svc = service();
    const check = await svc.check({ repo: 'sideproject', prompt: 'Tidy it', account: 'loom' });
    expect(check.ready).toBe(false);
    expect(check.problems.join(' ')).toContain('name no Claude account');
    await svc.start({ repo: 'tango', prompt: 'Fix it', account: 'loom', commandId: cid() });
    expect(commands.at(-1)).toMatchObject({ accounts: ['claude_home'] });
  });

  it('pins a Loom thread to one account the repo may use, and refuses one it may not', async () => {
    fs.writeFileSync(
      path.join(h.dir, 'accounts.json'),
      JSON.stringify({ claude: { accounts: [{ name: 'claude_home', usageName: 'Claude (Home)' }, { name: 'claude_team', usageName: 'Claude (Team)' }, { name: 'claude_spare', usageName: 'Claude (Spare)' }] } }),
    );
    fs.writeFileSync(policyFile, ['default: claude_home', 'repos:', '  sideproject: [claude_team, claude_spare]'].join('\n'));
    const svc = service();
    // No account named: Loom, the default.
    expect(await svc.start({ repo: 'sideproject', prompt: 'Tidy it', pin: 'claude_spare', commandId: cid() })).toMatchObject({ ok: true, plan: { pin: 'claude_spare' } });
    expect(commands.at(-1)).toMatchObject({ account: 'claude_spare', accounts: ['claude_spare'] });
    expect(commands.at(-1)).not.toHaveProperty('accountsFrom');
    const outside = await svc.check({ repo: 'sideproject', prompt: 'Tidy it', pin: 'claude_home' });
    expect(outside.ready).toBe(false);
    expect(outside.problems.join(' ')).toContain('sideproject may only use Claude (Team), Claude (Spare)');
    expect((await svc.check({ repo: 'sideproject', prompt: 'Tidy it', account: 'claude_team', pin: 'claude_team' })).problems.join(' ')).toContain('Only a Loom thread');
  });

  it('plans first on Loom with either a default or explicit account', async () => {
    const svc = service();
    const check = await svc.check({ repo: 'tango', prompt: 'Plan the migration', plan: true });
    expect(check).toMatchObject({ ready: true, plan: { account: { id: 'loom' }, plan: true } });
    expect((await svc.check({ repo: 'tango', prompt: 'Plan the migration', account: 'loom', plan: true, pin: 'claude_home' })).ready).toBe(true);
  });

  it('refuses supervised starts instead of weakening their approval guard', async () => {
    const svc = service();
    const check = await svc.check({ repo: 'tango', prompt: 'Coordinate', supervised: true });
    expect(check.ready).toBe(false);
    expect((await svc.check({ repo: 'tango', prompt: 'Coordinate', account: 'loom', supervised: true })).problems.join(' ')).toContain('Supervised starts are unavailable');
  });

  it('keeps Loom the default while it isn’t answering', async () => {
    healthy = false;
    const options = await service().options();
    expect(options.repos.find((r) => r.name === 'tango')!.account).toBe('loom');
    expect(options.accounts.at(-1)!.id).toBe('loom');
  });

  it('does not fall back after Loom refuses a start', async () => {
    healthy = false;
    answer = { status: 503, body: { ok: false, error: 'Loom unavailable' } };
    const result = await service().start({ repo: 'tango', prompt: 'Plan it', plan: true });
    expect(result.ok).toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.text).toContain('Plan first:');
  });

  it('plans first on Loom when the policy routes the repo to Loom', async () => {
    fs.writeFileSync(policyFile, ['repos:', '  tango: loom'].join('\n'));
    const check = await service().check({ repo: 'tango', prompt: 'Plan it', plan: true });
    expect(check).toMatchObject({ ready: true, plan: { account: { id: 'loom' } } });
  });

  it('the policy can make Loom a repo’s default', async () => {
    fs.writeFileSync(policyFile, ['repos:', '  tango: loom'].join('\n'));
    const svc = service();
    const options = await svc.options();
    expect(options.policyError).toBeNull();
    expect(options.repos.find((r) => r.name === 'tango')!.account).toBe('loom');
    expect(options.repos.find((r) => r.name === 'sideproject')!.account).toBe('loom');
    expect(await svc.start({ repo: 'tango', prompt: 'Fix it' })).toMatchObject({ ok: true, itemId: 'loom:th-1' });
    // Without Loom here, the same policy is broken, not quietly sent to T3.
    expect((await service(false).check({ repo: 'tango', prompt: 'Fix it' })).ready).toBe(false);
  });
});
