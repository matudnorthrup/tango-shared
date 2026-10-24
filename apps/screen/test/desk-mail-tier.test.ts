import * as fs from 'node:fs';
import * as path from 'node:path';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { DeskMail } from '../server/desk/mail.js';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { StartWork } from '../server/desk/start-work.js';
import { makeHarness } from './desk-harness.js';

it.each([false, true])('carries mail start tier and sameTree=%s to Loom submit and refuses invalid input', async sameTree => {
  const h = makeHarness();
  const commands: Record<string, unknown>[] = [];
  const projects = [{ id: 'p', title: 'tango', workspaceRoot: '/repos/tango' }];
  const tokenFile = path.join(h.dir, 'token');
  fs.writeFileSync(tokenFile, 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname === '/health') return Response.json({ ok: true, seq: 1 });
    if (url.pathname === '/commands') {
      commands.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { threadId: 'new', runId: 'r' } });
    }
    return Response.json({ thread: { id: 'new', cwd: '/repos/tango', title: 'QA', status: 'running', created_at: h.clock.now, updated_at: h.clock.now }, runs: [], messages: [], requests: [] });
  }));
  try {
    h.core.store.createItem({ id: 'loom:parent', source: 'loom', kind: 'thread', conversationKey: 'loom:parent', agentId: 'loom', agentName: 'Loom' });
    const source = new DeskLoomSource({ core: h.core, url: 'http://loom.test', tokenFile });
    const startWork = new StartWork({
      loom: source,
      repos: projects.map(project => ({ id: project.id, name: project.title, path: project.workspaceRoot })),
      accountsFile: path.join(h.dir, 'accounts.json'),
      policyFile: path.join(h.dir, 'start-work.yaml'),
      git: async (_cwd, args) => args.includes('symbolic-ref') ? 'origin/main' : 'feature/local',
      now: () => h.clock.now,
    });
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, startWork, now: () => h.clock.now });
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], mail });
    const start = (tier: unknown) => app.request('/api/desk/mail/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'loom:parent', repo: 'tango', prompt: 'Check the preview', tier, sameTree }) });
    for (const tier of ['', 'QA', 'bad_tier', 'a'.repeat(33), 7]) expect((await start(tier)).status).toBe(400);
    expect(commands).toHaveLength(0);
    const result = await start('qa');
    expect(await result.json()).toMatchObject({ ok: true });
    expect(result.status).toBe(200);
    expect(commands[0]).toMatchObject({ type: 'submit', tier: 'qa', role: 'worker', parentThreadId: 'loom:parent' });
    if (sameTree) {
      expect(commands[0]).toMatchObject({ sameTree: true });
      expect(commands[0]).not.toHaveProperty('worktree');
    } else expect(commands[0]).not.toHaveProperty('sameTree');
    const invalid = await app.request('/api/desk/mail/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'loom:parent', repo: 'tango', prompt: 'Build', sameTree: 'yes' }) });
    expect(invalid.status).toBe(400);
  } finally { vi.unstubAllGlobals(); h.close(); }
});
