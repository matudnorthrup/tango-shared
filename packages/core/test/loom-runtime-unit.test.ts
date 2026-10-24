import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LoomRuntimeAdapter, loomFailureError, loomRunResponse } from '../src/loom-runtime-adapter.js';
import { TangoStorage } from '../src/storage.js';
import { classifyClaudeCodeFailureError } from '../src/claude-code-failures.js';
import { SessionLifecycleManager } from '../src/session-lifecycle.js';
import { resolveIsolatedAgentWorkDir } from '../src/claude-code-adapter.js';
import { RuntimePool } from '../src/runtime-pool.js';

it('persists threads through lifecycle restart and rotates on reset', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-unit-'));
  const store = new TangoStorage(path.join(dir, 'db'));
  writeFileSync(path.join(dir, 'token'), 'fake');
  const commands: any[] = [];
  vi.stubEnv('LOOM_HOME', dir);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.body) {
      const command = JSON.parse(init.body); commands.push(command);
      return Response.json({ ok: true, result: { threadId: command.threadId ?? `t${commands.length}`, runId: 'r' } });
    }
    return Response.json({ runs: [{ id: 'r', status: 'completed' }], messages: [{ run_id: 'r', role: 'assistant', text: 'done' }], items: [] });
  }));
  const config = { agentId: 'test', backend: 'loom' as const, systemPrompt: 's', mcpServers: [], runtimePreferences: {} };
  const create = () => new SessionLifecycleManager(new RuntimePool({ loomSessionStore: () => store }));
  const first = create();
  try {
    expect((await first.sendMessage('chat', config, 'one', { context: 'warm' })).text).toBe('done');
    await first.shutdown();
    const next = create();
    await next.sendMessage('chat', config, 'two', { context: 'omit' });
    expect(commands[1]).toMatchObject({ threadId: 't1' });
    expect(commands[1].context).toBeUndefined();
    await next.closeSession('chat');
    await next.resetSession('chat', config);
    await next.sendMessage('chat', config, 'three', { context: 'fresh' });
    expect(commands[2].threadId).toBeUndefined();
    expect(commands[2].context).toBe('fresh');
    await next.shutdown();
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
it.each([['usage_limit', 'usage-limit'], ['auth', 'auth'], ['overloaded', 'overloaded'], ['crashed', null], ['other', null]])('maps %s for existing recovery', (kind, expected) => {
  expect(classifyClaudeCodeFailureError(loomFailureError({ kind }))).toBe(expected);
});

it('selects Loom only for eligible opt-in agents', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-select-'));
  const store = new TangoStorage(path.join(dir, 'db'));
  const pool = new RuntimePool({ loomSessionStore: () => store });
  const config = { agentId: 'test', backend: 'loom' as const, systemPrompt: 's', mcpServers: [], runtimePreferences: {} };
  try {
    expect(await pool.getOrCreate('on', config)).toBeInstanceOf(LoomRuntimeAdapter);
    vi.stubEnv('TANGO_LOOM_AGENTS', 'off');
    expect((await pool.getOrCreate('off', config)).type).toBe('claude-code');
    vi.stubEnv('TANGO_LOOM_AGENTS', 'on');
    expect((await pool.getOrCreate('isolated', { ...config, isolated: true })).type).toBe('loom');
    vi.stubEnv('TANGO_LOOM_ISOLATED', 'off');
    expect((await pool.getOrCreate('isolated-off', { ...config, isolated: true })).type).toBe('claude-code');
    expect((await pool.getOrCreate('owner-on', config)).type).toBe('loom');
    vi.stubEnv('TANGO_LOOM_AGENTS', 'off');
    expect((await pool.getOrCreate('all-off', { ...config, isolated: true })).type).toBe('claude-code');
  } finally { await pool.closeAll(); vi.unstubAllEnvs(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('reports tool activity once and interrupts a run at its deadline', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-events-'));
  const store = new TangoStorage(path.join(dir, 'db'));
  writeFileSync(path.join(dir, 'token'), 'fake');
  const commands: any[] = [];
  let polls = 0;
  let complete = true;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.body) {
      const command = JSON.parse(init.body); commands.push(command);
      return Response.json({ ok: true, result: { threadId: 't', runId: 'r' } });
    }
    polls++;
    return Response.json({ runs: [{ id: 'r', status: complete && polls > 1 ? 'completed' : 'running' }], messages: [{ run_id: 'old', role: 'assistant', text: 'ignore' }, { run_id: 'r', role: 'assistant', text: 'final' }], items: [{ id: 'i', run_id: 'r', name: 'Read', input: '{"file_path":"/repo/a"}', output: 'ok', status: 'completed' }] });
  }));
  const adapter = new LoomRuntimeAdapter({ conversationKey: 'chat', store, tokenFile: path.join(dir, 'token'), pollMs: 1, repoRoot: '/repo' });
  try {
    vi.stubEnv('BOT_SECRET', 'excluded');
    await adapter.initialize({ agentId: 'test', systemPrompt: 's', mcpServers: [{ name: 'mcp', command: './bin/server', args: ['packages/core/dist/mcp-proxy.js'], env: { WORKER_ID: 'test' } }], runtimePreferences: { reasoningEffort: 'max' } });
    const onEvent = vi.fn();
    const result = await adapter.send('hello', { context: 'warm', onEvent });
    expect(result.text).toBe('final');
    expect(result.toolCalls).toEqual([{ name: 'Read', input: { file_path: '/repo/a' }, output: 'ok' }]);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(commands[0]).toMatchObject({ context: 'warm', session: { effort: 'max', env: { WORKER_ID: 'test' }, mcpServers: { mcp: { command: '/repo/bin/server', args: ['/repo/packages/core/dist/mcp-proxy.js'] } } } });
    expect(commands[0].session.env.BOT_SECRET).toBeUndefined();
    complete = false;
    await expect(adapter.send('slow', { timeout: 15 })).rejects.toMatchObject({ name: 'ClaudeCodeTimeoutError', timeoutMs: 15 });
    expect(commands.at(-1).type).toBe('interrupt');
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('submits the exact isolated profile without inheriting bot env', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-isolated-'));
  const store = new TangoStorage(path.join(dir, 'db'));
  const agentId = path.basename(dir);
  const cwd = resolveIsolatedAgentWorkDir(agentId);
  writeFileSync(path.join(dir, 'token'), 'fake');
  const commands: any[] = [];
  vi.stubEnv('BOT_SECRET', 'excluded');
  vi.stubEnv('TANGO_PROFILE', 'owner');
  vi.stubEnv('TANGO_REPO_DIR', '/bot/repo');
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.body) {
      commands.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: { threadId: 't', runId: 'r' } });
    }
    return Response.json({ runs: [{ id: 'r', status: 'completed' }], messages: [], items: [] });
  }));
  try {
    const runtime = new LoomRuntimeAdapter({ conversationKey: 'chat', store, tokenFile: path.join(dir, 'token'), repoRoot: '/repo', cwd: '/bot/cwd' });
    await runtime.initialize({ agentId, isolated: true, systemPrompt: 'persona', runtimePreferences: {}, mcpServers: [{ name: 'allowed', command: './bin/mcp', args: ['packages/server.js'], env: { WORKER_ID: 'child' } }] });
    await runtime.send('hello');
    expect(commands[0].cwd).toBe(cwd);
    expect(existsSync(cwd)).toBe(true);
    expect(commands[0].context).toBeUndefined();
    expect(commands[0].session).toEqual({ system: 'persona', tools: 'none', settingSources: [], loomTools: false,
      env: { WORKER_ID: 'child', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      mcpServers: { allowed: { command: '/repo/bin/mcp', args: ['/repo/packages/server.js'], env: { WORKER_ID: 'child' } } },
    });
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); store.close();
    rmSync(cwd, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  }
});

it('starts a fresh sandbox thread when a persisted agent becomes isolated', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-transition-'));
  const store = new TangoStorage(path.join(dir, 'db'));
  writeFileSync(path.join(dir, 'token'), 'fake');
  const config = { agentId: 'test', systemPrompt: 's', mcpServers: [], runtimePreferences: {} };
  const commands: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.body) {
      const body = JSON.parse(init.body); commands.push(body);
      return Response.json({ ok: true, result: { threadId: body.threadId ?? `thread-${commands.length}`, runId: 'run' } });
    }
    return Response.json({ runs: [{ id: 'run', status: 'completed' }], messages: [], items: [] });
  }));
  const adapter = () => new LoomRuntimeAdapter({ store, conversationKey: 'chat', tokenFile: path.join(dir, 'token') });
  const agentId = `loom-transition-${path.basename(dir)}`;
  const cwd = resolveIsolatedAgentWorkDir(agentId);
  const runtime = adapter();
  try {
    await runtime.initialize({ ...config, agentId });
    await runtime.send('before isolation');
    await runtime.initialize({ ...config, agentId, isolated: true });
    expect(runtime.getSessionId()).toBeUndefined();
    await runtime.send('after isolation');
    expect(commands[1].threadId).toBeUndefined();
    expect(commands[1].cwd).toBe(cwd);
    const resumed = adapter();
    await resumed.initialize({ ...config, agentId, isolated: true });
    expect(resumed.getSessionId()).toBe('thread-2');
    await resumed.initialize({ ...config, agentId });
    expect(resumed.getSessionId()).toBe('thread-1');
  } finally { vi.unstubAllGlobals(); store.close(); rmSync(cwd, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

it('a reset while an isolated agent runs on the CLI clears its isolated Loom thread too', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-reset-'));
  const store = new TangoStorage(path.join(dir, 'db'));
  const config = { agentId: 'kid', backend: 'loom' as const, isolated: true, systemPrompt: 's', mcpServers: [], runtimePreferences: {} };
  const isolatedKey = JSON.stringify(['kid', 'chat', 'isolated']);
  try {
    store.upsertSession({ id: 's', type: 'persistent', agent: 'kid', channels: [] });
    store.upsertProviderSession({ conversationKey: isolatedKey, sessionId: 's', agentId: 'kid', providerName: 'loom', providerSessionId: 'old-thread' });
    vi.stubEnv('TANGO_LOOM_ISOLATED', 'off');
    const pool = new RuntimePool({ loomSessionStore: () => store });
    await pool.getOrCreate('chat', config);
    pool.resetSession('chat', config);
    expect(store.getProviderSession(isolatedKey, 'loom')).toBeFalsy();
  } finally { vi.unstubAllEnvs(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('delivers the whole run when a tool call splits the answer from its closing Next line', () => {
  const answer = `Your setup is right. Here is the order.\n\n${'1. Power lead on the battery. '.repeat(30).trim()}`;
  const detail = { runs: [], items: [], messages: [
    { run_id: 'old', role: 'assistant', text: 'earlier turn' },
    { run_id: 'r', role: 'assistant', text: "I'll check the manual." },
    { run_id: 'r', role: 'assistant', text: answer },
    { run_id: 'r', role: 'assistant', text: '**Next — you:** Hook it up as above, then trace from pin 16.' },
  ] };
  expect(loomRunResponse(detail as any, 'r', 't').text).toBe(`${answer}\n\n**Next — you:** Hook it up as above, then trace from pin 16.`);
  // Short messages with no long answer after them are the reply itself, kept whole.
  const short = { runs: [], items: [], messages: [{ run_id: 'r', role: 'assistant', text: 'Done.' }, { run_id: 'r', role: 'assistant', text: '**Next — none:** done.' }] };
  expect(loomRunResponse(short as any, 'r', 't').text).toBe('Done.\n\n**Next — none:** done.');
});
