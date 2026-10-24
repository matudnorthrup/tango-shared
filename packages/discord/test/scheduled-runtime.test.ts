import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter, LoomRuntimeAdapter, OllamaRuntimeAdapter, RuntimePool, type AgentRuntimeConfig, type ChatProvider } from '@tango/core';
import { createScheduledRuntime } from '../src/scheduled-runtime.js';

const config: AgentRuntimeConfig = {
  agentId: 'scheduled-agent', backend: 'loom', systemPrompt: 'scheduled system',
  mcpServers: [{ name: 'test', command: './tools/test' }],
  runtimePreferences: { model: 'opus', reasoningEffort: 'high', timeout: 1000 },
  coldStartContext: 'review context',
};
const provider = {} as ChatProvider;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('submits two fresh tango-job threads with the scheduler session and title', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'schedule-loom-'));
  writeFileSync(path.join(dir, 'token'), 'test');
  vi.stubEnv('LOOM_HOME', dir);
  const commands: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.body) {
      const command = JSON.parse(init.body); commands.push(command);
      return Response.json({ ok: true, result: { threadId: `thread-${commands.length}`, runId: 'run' } });
    }
    return Response.json({ runs: [{ id: 'run', status: 'completed' }], messages: [{ run_id: 'run', role: 'assistant', text: '__NO_OUTPUT__' }], items: [] });
  }));
  try {
    for (let i = 0; i < 2; i++) {
      const runtime = createScheduledRuntime(config, provider, { id: 'daily', displayName: 'Daily review' });
      expect(runtime).toBeInstanceOf(LoomRuntimeAdapter);
      await runtime.initialize(config);
      const result = await runtime.send('task', { currentTurnMetadataPrompt: 'timestamp' });
      expect(result).toMatchObject({ text: '__NO_OUTPUT__', metadata: { backend: 'loom' } });
      await runtime.teardown();
    }
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.threadId).toBeUndefined();
      expect(command).toMatchObject({ kind: 'tango-job', title: 'Daily review', text: 'timestamp\n\ntask', context: 'review context', session: { system: 'scheduled system', model: 'opus', effort: 'high', mcpServers: { test: { command: expect.stringContaining('/tools/test') } } } });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['TANGO_LOOM_AGENTS', 'TANGO_LOOM_ISOLATED', 'TANGO_LOOM_SCHEDULES'])('respects %s and shares the pool policy', async (flag) => {
  vi.stubEnv(flag, 'off');
  const isolated = { ...config, isolated: true };
  expect(createScheduledRuntime(isolated, provider, { id: 'job' })).toBeInstanceOf(ClaudeCodeAdapter);
  const pool = new RuntimePool({ loomSessionStore: () => ({ getProviderSession: () => null, upsertProviderSession() {}, clearProviderSession() { return false; }, upsertSession() {}, insertLoomDelivery() {} }) });
  try {
    const runtime = await pool.getOrCreate('conversation', isolated);
    expect(runtime.type).toBe(flag === 'TANGO_LOOM_SCHEDULES' ? 'loom' : 'claude-code');
  } finally { await pool.closeAll(); }
});

it('keeps CLI and Ollama agents on their own adapters', () => {
  expect(createScheduledRuntime({ ...config, backend: 'claude-code' }, provider, { id: 'job' })).toBeInstanceOf(ClaudeCodeAdapter);
  vi.stubEnv('TANGO_LOOM_AGENTS', 'off');
  vi.stubEnv('TANGO_LOOM_SCHEDULES', 'off');
  expect(createScheduledRuntime({ ...config, backend: 'ollama' }, provider, { id: 'job' })).toBeInstanceOf(OllamaRuntimeAdapter);
});
