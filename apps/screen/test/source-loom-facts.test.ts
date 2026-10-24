import { describe, expect, it, vi } from 'vitest';
import { LoomHost, LoomStore } from '@tango/loom';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { makeHarness } from './desk-harness.js';

describe('Loom recorded desk facts', () => {
  it('marks source health false when Loom cannot be reached, and true on recovery', async () => {
    const h = makeHarness(); const store = new LoomStore(':memory:'); const host = new LoomHost(store, {});
    const source = new DeskLoomSource({ core: h.core, url: 'http://example.test', tokenFile: '/unused' });
    try {
      store.tx(() => store.createThread({ id: 'health', kind: 'coding', cwd: '/repo', provider: 'fake' }));
      const internal = source as unknown as { running: boolean; ingest(detail: unknown): void; refreshHealth(): Promise<void> };
      internal.ingest(host.detail('health')); internal.running = true;
      const call = vi.spyOn(source as unknown as { call(p: string): Promise<{ status: number; body: unknown }> }, 'call').mockRejectedValue(new Error('fetch failed'));
      await internal.refreshHealth(); expect(h.core.item('loom:health')!.facts.sourceHealth).toMatchObject({ ok: false, detail: 'Loom host unreachable' });
      call.mockResolvedValue({ status: 200, body: {} });
      await internal.refreshHealth(); expect(h.core.item('loom:health')!.facts.sourceHealth?.ok).toBe(true);
    } finally { source.stop(); await host.closeAll(); store.close(); h.close(); }
  });
  it('a running Loom that refuses the token reads unhealthy (/health answers without one)', async () => {
    const h = makeHarness(); const store = new LoomStore(':memory:'); const host = new LoomHost(store, {});
    const source = new DeskLoomSource({ core: h.core, url: 'http://example.test', tokenFile: '/unused' });
    try {
      store.tx(() => store.createThread({ id: 'auth', kind: 'coding', cwd: '/repo', provider: 'fake' }));
      const internal = source as unknown as { running: boolean; ingest(detail: unknown): void; refreshHealth(): Promise<void> };
      internal.ingest(host.detail('auth')); internal.running = true;
      vi.spyOn(source, 'reachable').mockResolvedValue(true);
      vi.spyOn(source as unknown as { call(p: string): Promise<{ status: number; body: unknown }> }, 'call').mockResolvedValue({ status: 401, body: null });
      await internal.refreshHealth();
      expect(h.core.item('loom:auth')!.facts.sourceHealth).toMatchObject({ ok: false, detail: "Loom refused the desk's token" });
    } finally { source.stop(); await host.closeAll(); store.close(); h.close(); }
  });
  it('a failed read flushes the unhealthy fact once and keeps its first time', async () => {
    const h = makeHarness(); const store = new LoomStore(':memory:'); const host = new LoomHost(store, {});
    const source = new DeskLoomSource({ core: h.core, url: 'http://example.test', tokenFile: '/unused' });
    try {
      store.tx(() => store.createThread({ id: 'read', kind: 'coding', cwd: '/repo', provider: 'fake' }));
      const internal = source as unknown as { running: boolean; ingest(detail: unknown): void; markUnhealthy(id: string, err: unknown): void };
      internal.ingest(host.detail('read')); internal.running = true;
      const flush = vi.spyOn(h.core, 'flush');
      internal.markUnhealthy('read', new Error('read failed'));
      expect(flush).toHaveBeenCalledTimes(1);
      const first = h.core.item('loom:read')!.facts.sourceHealth;
      expect(first).toMatchObject({ ok: false, detail: 'read failed' });
      internal.markUnhealthy('read', new Error('again'));
      expect(flush).toHaveBeenCalledTimes(1);
      expect(h.core.item('loom:read')!.facts.sourceHealth).toEqual(first);
    } finally { source.stop(); await host.closeAll(); store.close(); h.close(); }
  });
  it('projects each armed target, handoff, run heartbeat and source observation without interpreting prose', async () => {
    const h = makeHarness();
    const store = new LoomStore(':memory:');
    const host = new LoomHost(store, {});
    try {
      store.tx(() => {
        store.createThread({ id: 'lead', kind: 'coding', title: 'Build widget', cwd: '/repo', provider: 'fake' });
        store.createThread({ id: 'worker', kind: 'coding', title: 'Widget worker', cwd: '/repo', provider: 'fake' });
        const run = store.createRun('worker', 'user', 'work'); store.updateRun(run.id, { status: 'running' });
        host.triggers.create('lead', 'time', { at: '2030-01-01T15:00:00Z' }, 'later');
        host.triggers.create('lead', 'pr', { repo: 'org/repo', number: 913, until: 'approved' }, 'review');
        host.triggers.create('lead', 'thread', { threadId: 'worker', until: 'idle' }, 'worker');
        host.triggers.create('lead', 'command', { command: 'npm test' }, 'checks');
        host.triggers.create('lead', 'url', { url: 'https://example.test/ready' }, 'ready');
        host.triggers.create('lead', 'file', { path: 'ready', exists: true }, 'file');
        host.triggers.create('lead', 'worker', { project: 'test', task: 'widget' }, 'external');
        store.db.prepare("UPDATE triggers SET last_checked_at=123,last_error='offline' WHERE kind='pr'").run();
      });
      const source = new DeskLoomSource({ core: h.core, url: 'http://example.test', tokenFile: '/unused' });
      const detail = host.detail('lead')!;
      // The error count and since (newer Loom), set here so the test doesn't depend on which Loom build it resolves.
      for (const w of detail.waits as Array<Record<string, unknown>>) if (w.kind === 'pr') Object.assign(w, { consecutive_errors: 2, error_since: 120 });
      const handoff = { owner: 'waiting' as const, text: 'review', waitingOn: 'reviewer', runId: 'run', messageId: null, at: 50, source: 'tool' as const };
      Object.assign(detail.thread, { closingHandoff: handoff, heartbeatAt: 75, sourceHealth: { ok: true, at: 100 } });
      (source as unknown as { ingest(detail: unknown): void }).ingest(detail);
      const facts = h.core.item('loom:lead')!.facts;
      expect(facts).toMatchObject({ handoff, heartbeatAt: 75, sourceHealth: { ok: true } });
      expect(facts.waits).toHaveLength(7);
      for (const [kind, target] of [['pr', 'PR #913 review'], ['thread', 'Widget worker'], ['command', 'npm test'], ['url', 'https://example.test/ready'], ['file', '/repo/ready'], ['worker', 'test/widget']]) {
        expect(facts.waits!.find(w => w.kind === kind)).toMatchObject({ target });
      }
      expect(facts.waits!.find(w => w.kind === 'time')).toMatchObject({ target: new Date('2030-01-01T15:00:00Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), dueAt: Date.parse('2030-01-01T15:00:00Z') });
      expect(facts.waits!.find(w => w.kind === 'pr')).toMatchObject({ lastCheckedAt: 123, checkError: 'offline', consecutiveErrors: 2, errorSince: 120 });
      expect(facts.waits!.every(w => w.armedAt > 0 && w.timeoutAt! > w.armedAt)).toBe(true);
    } finally { await host.closeAll(); store.close(); h.close(); }
  });
});

it('exposes created URLs, branch and canonical PR waits through Loom detail into desk facts', async () => {
  const h = makeHarness(); const store = new LoomStore(':memory:'); const host = new LoomHost(store, {});
  try {
    const thread = store.tx(() => store.createThread({ id: 'prs', kind: 'coding', cwd: '/repo', provider: 'fake' }));
    store.updateThread(thread.id, { worktree_branch: 'codex/widgets' });
    host.ledger.tool(thread, { type: 'tool.updated', runId: 'r', itemId: 'pr', name: 'Bash', input: 'gh pr create', status: 'completed', output: 'Created https://github.com/acme/widgets/pull/7' });
    host.ledger.tool(thread, { type: 'tool.updated', runId: 'r', itemId: 'legacy', name: 'Bash', input: 'gh pr create', status: 'completed' });
    host.triggers.create(thread.id, 'pr', { repo: 'acme/widgets', number: 7, until: 'approved' }, 'review');
    const source = new DeskLoomSource({ core: h.core, url: 'http://example.test', tokenFile: '/unused' });
    (source as unknown as { ingest(detail: unknown): void }).ingest(host.detail(thread.id));
    expect(h.core.item('loom:prs')?.facts).toMatchObject({ legacyPrCreates: [{ id: expect.any(String), at: expect.any(Number) }], openedPrUrls: ['https://github.com/acme/widgets/pull/7'], prBranch: { branch: 'codex/widgets', cwd: '/repo' }, waits: [{ target: 'PR #7 review', prUrl: 'https://github.com/acme/widgets/pull/7' }] });
  } finally { await host.closeAll(); store.close(); h.close(); }
});
