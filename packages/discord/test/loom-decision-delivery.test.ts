import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { TangoStorage, LoomRuntimeAdapter } from '@tango/core';
import { LoomStore } from '../../loom/src/store.js';
import { LoomHost } from '../../loom/src/host.js';
import { createLoomServer } from '../../loom/src/http.js';
import { FakeRuntime } from '../../loom/test/fake-runtime.js';
import { registerDecisionDeliveries, recoverLoomReplies } from '../src/loom-reply-recovery.js';

it('answers a Discord-backed brief over HTTP and recovers its reply after both stores restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-delivery-'));
  const tokenFile = join(dir, 'token'); writeFileSync(tokenFile, 'fixture-token');
  const hostOptions = { rulesFile: join(dir, 'rules.md'), releasesDir: join(dir, 'no-releases'), loomHome: dir,
    recoveryHealthFile: join(dir, 'no-health'),
    pressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1024 ** 4, freeBytes: 100 * 1024 ** 3 } }) };
  let store = new LoomStore(join(dir, 'loom.sqlite'));
  let runtime = new FakeRuntime(store);
  let host = new LoomHost(store, { fake: runtime }, hostOptions);
  let bot = new TangoStorage(join(dir, 'bot.sqlite'));
  let server = createLoomServer(host, { token: 'fixture-token' });
  const listen = async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  let port = await listen();
  const closeServer = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const call = (route: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const initial = await host.execute({ type: 'submit', commandId: 'initial', cwd: dir, provider: 'fake', kind: 'tango-agent', text: 'Choose an option' });
    runtime.last.complete('Waiting for approval'); await host.kick(initial.threadId!);
    bot.insertLoomDelivery({ runId: initial.runId!, loomThreadId: initial.threadId!, agentId: 'test',
      conversationKey: 'thread:123', channelId: '123', threadId: '123', messageId: '456', createdAt: new Date().toISOString(),
      context: { sessionId: 'fixture-session', prompt: 'Choose an option', occurredAt: new Date().toISOString() } });
    bot.finishLoomDelivery(initial.runId!, 'delivered');
    store.addDecision({ id: 'D-1', thread_id: initial.threadId!, run_id: initial.runId!, class: 'product-choice-in-scope', level: 3, candidate: 0,
      ask: 'Choose the test option?', supersedes: null,
      brief: JSON.stringify({ class: 'product-choice-in-scope', about: 'Test option', ask: 'Choose the test option?',
        options: [{ key: 'A', label: 'Proceed', recommended: true }, { key: 'B', label: 'Wait' }] }) });
    const answer = await call('/commands', { type: 'decision.answer', commandId: 'answer', decisionId: 'D-1', option: 'A' });
    expect(answer.status).toBe(200);
    const { result } = await answer.json() as { result: { runId: string } };
    runtime.last.complete('The chosen action completed.'); await host.kick(initial.threadId!);
    expect((await fetch(`http://127.0.0.1:${port}/decision-deliveries`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/decision-deliveries/${result.runId}/ack`, { method: 'POST' })).status).toBe(401);
    // Neither process needs to survive from the answer to the first delivery recovery pass.
    await closeServer(); await host.closeAll(); store.close(); bot.close();
    store = new LoomStore(join(dir, 'loom.sqlite'));
    runtime = new FakeRuntime(store);
    host = new LoomHost(store, { fake: runtime }, hostOptions);
    bot = new TangoStorage(join(dir, 'bot.sqlite'));
    server = createLoomServer(host, { token: 'fixture-token' }); port = await listen();
    const reader = new LoomRuntimeAdapter({ conversationKey: 'recovery', store: bot, port, tokenFile });
    await registerDecisionDeliveries({ store: bot, read: () => reader.readDecisionDeliveries(), acknowledge: id => reader.acknowledgeDecisionDelivery(id) });
    expect(await reader.readDecisionDeliveries()).toEqual([]);
    const deliver = vi.fn(async () => {});
    await recoverLoomReplies({ store: bot, readThread: id => reader.readThread(id), deliver });
    await recoverLoomReplies({ store: bot, readThread: id => reader.readThread(id), deliver });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: result.runId, threadId: '123' }),
      expect.objectContaining({ text: 'The chosen action completed.' }));
  } finally {
    await closeServer(); await host.closeAll(); store.close(); bot.close(); rmSync(dir, { recursive: true, force: true });
  }
});
