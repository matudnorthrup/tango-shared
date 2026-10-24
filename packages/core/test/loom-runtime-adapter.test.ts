import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoomRuntimeAdapter, loomFailureError, liveLoomDeliveries } from '../src/loom-runtime-adapter.js';
import { TangoStorage } from '../src/storage.js';
import { RuntimePool } from '../src/runtime-pool.js';
import { ClaudeCodeTimeoutError, resolveIsolatedAgentWorkDir } from '../src/claude-code-adapter.js';
import { classifyClaudeCodeFailureError } from '../src/claude-code-failures.js';
import type { AgentRuntimeConfig } from '../src/agent-runtime.js';
let dir: string, store: TangoStorage, port: number;
let commands: any[], status: string, polls: number;
const config: AgentRuntimeConfig = { agentId: 'test', systemPrompt: 'system', backend: 'loom', runtimePreferences: { model: 'opus', reasoningEffort: 'max' }, mcpServers: [{ name: 'tools', command: './bin/tools', args: ['packages/core/dist/mcp-proxy.js', '--port', '9100'], env: { MCP_SERVER_PORT: '9100' } }] };
function adapter() { return new LoomRuntimeAdapter({ store, conversationKey: 'chat', tokenFile: path.join(dir, 'token'), port, pollMs: 5, repoRoot: '/repo' }); }
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'loom-adapter-'));
  writeFileSync(path.join(dir, 'token'), 'test');
  store = new TangoStorage(path.join(dir, 'db.sqlite'));
  commands = []; status = 'completed'; polls = 0;
  port = 9420;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test');
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string); commands.push(body);
      return Response.json({ ok: true, result: { threadId: body.threadId ?? `thread-${commands.length}`, runId: 'run' } });
    }
    polls++;
    return Response.json({ runs: [{ id: 'run', status: polls === 1 ? 'running' : status }], messages: [{ run_id: 'old', role: 'assistant', text: 'old' }, { run_id: 'run', role: 'assistant', text: 'answer' }], items: [{ id: 'tool', run_id: 'run', name: 'Read', input: '{"file_path":"/repo/a.ts"}', output: 'result', status: 'completed' }] });
  }));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); liveLoomDeliveries.clear(); store.close(); rmSync(dir, { recursive: true, force: true }); });
it('submits the session, polls, reports tools, persists across instances and resets', async () => {
  vi.stubEnv('BOT_SECRET', 'excluded'); vi.stubEnv('TANGO_PROFILE', 'test');
  const runtime = adapter(); await runtime.initialize(config);
  const onEvent = vi.fn();
  const result = await runtime.send('hello', { context: 'warm', onEvent });
  expect(result.text).toBe('answer'); expect(result.toolCalls).toEqual([{ name: 'Read', input: { file_path: '/repo/a.ts' }, output: 'result' }]);
  expect(onEvent).toHaveBeenCalledTimes(1); expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: 'tool_use', name: 'Read', activity: expect.any(String) });
  expect(commands[0]).toMatchObject({ kind: 'tango-agent', context: 'warm', session: { system: 'system', tools: 'default', effort: 'max', mcpServers: { tools: { command: '/repo/bin/tools', args: ['/repo/packages/core/dist/mcp-proxy.js', '--port', '9100'] } }, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', TANGO_PROFILE: 'test', MCP_SERVER_PORT: '9100' } } });
  expect(commands[0].session.env.BOT_SECRET).toBeUndefined();
  expect(commands[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
  const resumed = adapter(); await resumed.initialize(config); await resumed.send('again', { context: 'omit' });
  expect(commands[1].threadId).toBe('thread-1'); expect(commands[1].context).toBeUndefined();
  resumed.resetSession(); await resumed.send('fresh', { context: 'new' });
  expect(commands[2].threadId).toBeUndefined(); expect(commands[2].context).toBe('new');
});
it('interrupts on timeout', async () => {
  status = 'running'; const runtime = adapter(); await runtime.initialize(config);
  await expect(runtime.send('slow', { timeout: 40 })).rejects.toBeInstanceOf(ClaudeCodeTimeoutError);
  expect(commands.at(-1).type).toBe('interrupt');
});
it('ends promptly as a stop when the Loom thread is stopped and its run canceled (Codex review on #713)', async () => {
  status = 'canceled'; const runtime = adapter(); await runtime.initialize(config);
  const started = Date.now();
  await expect(runtime.send('stopped', { timeout: 60_000 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(5_000);
});
it.each([['usage_limit', 'usage-limit'], ['auth', 'auth'], ['overloaded', 'overloaded'], ['crashed', null], ['other', null]])('maps %s failures', (kind, reason) => {
  expect(classifyClaudeCodeFailureError(loomFailureError(JSON.stringify({ kind })))).toBe(reason);
});
it('selects Loom and respects kill switch and isolation', async () => {
  const pool = new RuntimePool({ loomSessionStore: () => store });
  expect((await pool.getOrCreate('loom', config)).type).toBe('loom');
  vi.stubEnv('TANGO_LOOM_AGENTS', 'off');
  expect((await pool.getOrCreate('off', config)).type).toBe('claude-code');
  vi.stubEnv('TANGO_LOOM_AGENTS', 'on');
  expect((await pool.getOrCreate('isolated', { ...config, isolated: true })).type).toBe('loom');
    vi.stubEnv('TANGO_LOOM_ISOLATED', 'off');
    expect((await pool.getOrCreate('isolated-off', { ...config, isolated: true })).type).toBe('claude-code');
    expect((await pool.getOrCreate('owner-on', config)).type).toBe('loom');
    vi.stubEnv('TANGO_LOOM_AGENTS', 'off');
    expect((await pool.getOrCreate('all-off', { ...config, isolated: true })).type).toBe('claude-code');
  await pool.closeAll();
});

it('submits an isolated profile with only configured MCP env and a sandbox cwd', async () => {
  vi.stubEnv('BOT_SECRET', 'excluded');
  vi.stubEnv('TANGO_PROFILE', 'owner');
  vi.stubEnv('TANGO_REPO_DIR', '/bot/repo');
  const agentId = `loom-isolation-${path.basename(dir)}`;
  const cwd = resolveIsolatedAgentWorkDir(agentId);
  const runtime = adapter();
  try {
    await runtime.initialize({ ...config, agentId, isolated: true });
    await runtime.send('hello');
    expect(commands[0].cwd).toBe(cwd);
    expect(existsSync(cwd)).toBe(true);
    expect(commands[0].context).toBeUndefined();
    expect(commands[0].session).toEqual({
      system: 'system', model: 'opus', effort: 'max', tools: 'none', settingSources: [], loomTools: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', MCP_SERVER_PORT: '9100' },
      mcpServers: { tools: { command: '/repo/bin/tools', args: ['/repo/packages/core/dist/mcp-proxy.js', '--port', '9100'], env: { MCP_SERVER_PORT: '9100' } } },
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('ties submit idempotency and durable delivery to the triggering Discord message', async () => {
  const runtime = adapter(); await runtime.initialize(config);
  const onLoomSubmitted = vi.fn();
  const response = await runtime.send('hello', { discordDelivery: { channelId: 'channel', threadId: 'thread', messageId: 'message',
    context: { sessionId: 'session', prompt: 'hello', occurredAt: new Date().toISOString() } }, onLoomSubmitted });
  expect(commands[0].commandId).toBe('discord:message');
  expect(onLoomSubmitted).toHaveBeenCalledWith('run');
  expect(response.metadata?.loomRunId).toBe('run');
  expect(store.listPendingLoomDeliveries()).toMatchObject([{ runId: 'run', loomThreadId: 'thread-1',
    agentId: 'test', conversationKey: 'chat', messageId: 'message', channelId: 'channel', threadId: 'thread' }]);
});

it('does not take ownership of a run whose delivery record could not be saved', async () => {
  const runtime = adapter(); await runtime.initialize(config);
  const onLoomSubmitted = vi.fn();
  const insert = vi.spyOn(store, 'insertLoomDelivery').mockImplementation(() => { throw new Error('database is locked'); });
  try {
    await expect(runtime.send('hello', { discordDelivery: { channelId: 'channel', messageId: 'locked',
      context: { sessionId: 'session', prompt: 'hello', occurredAt: new Date().toISOString() } }, onLoomSubmitted })).rejects.toThrow('database is locked');
    expect(onLoomSubmitted).not.toHaveBeenCalled();
    expect(liveLoomDeliveries.has('run')).toBe(false);
  } finally { insert.mockRestore(); }
});

it.each(['queued', 'running'])('detaches a durable %s reply on deadline without interrupting or failing it', async state => {
  status = state;
  const runtime = adapter(); await runtime.initialize(config);
  const error = await runtime.send('slow', { timeout: 40, discordDelivery: {
    channelId: 'channel', messageId: 'original', context: { sessionId: 'session', prompt: 'slow', occurredAt: new Date().toISOString() },
  } }).catch(error => error);
  expect(error.name).toBe('LoomPendingError');
  expect(classifyClaudeCodeFailureError(error)).toBeNull();
  expect(commands.map(command => command.type)).toEqual(['submit']);
  expect(store.listPendingLoomDeliveries()).toHaveLength(1);
  expect(runtime.active).toBe(false);
});

it('leaves a persisted delivery pending when polling loses its connection', async () => {
  const runtime = adapter(); await runtime.initialize(config);
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    if (init?.method === 'GET') return Promise.reject(new Error('connection closed'));
    return original(url, init);
  }));
  await expect(runtime.send('hello', { discordDelivery: { channelId: 'channel', messageId: 'lost-poll',
    context: { sessionId: 'session', prompt: 'hello', occurredAt: new Date().toISOString() } },
  })).rejects.toMatchObject({ name: 'LoomPendingError' });
  expect(store.listPendingLoomDeliveries()).toHaveLength(1);
  expect(commands.map(command => command.type)).toEqual(['submit']);
});

it('recovers the committed submit receipt after a slow host exhausts the foreground deadline', async () => {
  const runtime = adapter(); await runtime.initialize(config);
  const original = globalThis.fetch;
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const submits: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      submits.push(JSON.parse(init.body as string));
      if (submits.length === 1) {
        // Loom committed the command, but session opening delayed its HTTP response.
        clock.mockReturnValue(now + 31_000);
        throw new DOMException('request timed out', 'TimeoutError');
      }
    }
    return original(url, init);
  }));
  try {
    await expect(runtime.send('slow opening', { discordDelivery: { channelId: 'channel', messageId: 'slow-open',
      context: { sessionId: 'session', prompt: 'slow opening', occurredAt: new Date().toISOString() } },
    })).rejects.toMatchObject({ name: 'LoomPendingError', runId: 'run' });
    expect(submits).toHaveLength(2);
    expect(submits[0]).toEqual(submits[1]);
    expect(store.listPendingLoomDeliveries()).toMatchObject([{ runId: 'run', messageId: 'slow-open' }]);
    expect(commands.map(command => command.type)).toEqual(['submit']);
  } finally { clock.mockRestore(); }
});

it('keeps observing beyond 30 seconds when background reply recovery is disabled', async () => {
  vi.stubEnv('TANGO_LOOM_RECOVER_REPLIES', 'off');
  const runtime = adapter(); await runtime.initialize(config);
  const original = globalThis.fetch;
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'GET') clock.mockReturnValue(now + 31_000);
    return original(url, init);
  }));
  try {
    const response = await runtime.send('slow answer', { timeout: 60_000, discordDelivery: { channelId: 'channel', messageId: 'no-recovery',
      context: { sessionId: 'session', prompt: 'slow answer', occurredAt: new Date().toISOString() } },
    });
    expect(response.text).toBe('answer');
    expect(polls).toBe(2);
  } finally { clock.mockRestore(); }
});


it.each([false, true])('stops a detached delivery (recreated adapter: %s)', async recreate => {
  status = 'running';
  let runtime = adapter(); await runtime.initialize(config);
  await expect(runtime.send('slow', { timeout: 40, discordDelivery: {
    channelId: 'channel', messageId: 'stop-pending',
    context: { sessionId: 'session', prompt: 'slow', occurredAt: new Date().toISOString() },
  } })).rejects.toMatchObject({ name: 'LoomPendingError' });
  const record = store.listPendingLoomDeliveries()[0]!;
  store.insertLoomDelivery({ ...record, runId: 'other-chat', conversationKey: 'other' });
  store.insertLoomDelivery({ ...record, runId: 'other-agent', agentId: 'other' });
  if (recreate) { runtime = adapter(); await runtime.initialize(config); }
  expect(runtime.active).toBe(false);
  expect(runtime.abortActiveRun()).toBe(true);
  await vi.waitFor(() => expect(commands.filter(c => c.type === 'interrupt')).toEqual([
    expect.objectContaining({ threadId: 'thread-1', runId: 'run' }),
  ]));
  // Recovery still owns presentation of the interrupted outcome.
  expect(store.listPendingLoomDeliveries()).toHaveLength(3);
  store.finishLoomDelivery('run', 'delivered');
  expect(runtime.abortActiveRun()).toBe(false);
});
