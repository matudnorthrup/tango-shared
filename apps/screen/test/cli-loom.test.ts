import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error CLI is an executable ES module.
import { resolveConversation, run } from '../bin/tango-screen.mjs';

describe('Loom CLI conversation selection', () => {
  it('accepts a prefixed explicit Loom thread without doubling the prefix', async () => {
    expect(await resolveConversation({}, process.cwd(), { thread: 'loom:abc-123' })).toMatchObject({ conversationKey: 'loom:abc-123', thread: { id: 'abc-123' } });
  });
  it('treats a bare explicit thread id as Loom', async () => {
    expect(await resolveConversation({}, process.cwd(), { thread: 'abc-123' })).toMatchObject({ conversationKey: 'loom:abc-123' });
  });
  it('uses the current Loom session when no override is supplied', async () => {
    expect(await resolveConversation({ TANGO_DESK_ITEM: 'loom:current' }, process.cwd(), {})).toMatchObject({ conversationKey: 'loom:current' });
  });
  it.each([['peek', 't3:old'], ['send', 't3:old', 'hello'], ['thread', '--thread', 't3:old'], ['whoami', '--from', 't3:old']])('rejects retired targets before making a request: %s', async (...argv) => {
    await expect(run(argv, { env: {}, out: () => {} })).rejects.toThrow('T3 is retired; use Loom');
  });
  it('does not discover T3 data when no Loom session is selected', async () => {
    await expect(resolveConversation({}, process.cwd(), {})).rejects.toThrow('No Loom conversation selected');
  });
});

afterEach(() => vi.unstubAllGlobals());
it('discovers the current worktree PR for zero-argument watch-pr', async () => {
  const exec = vi.fn(() => 'https://github.com/example/repo/pull/42\n');
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ number: 42, url: 'https://github.com/example/repo/pull/42', onApprove: 'continue' })));
  vi.stubGlobal('fetch', fetch);
  await run(['watch-pr'], { env: { TANGO_DESK_ITEM: 'loom:current' }, cwd: '/repos/demo', out: () => {}, exec });
  expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], expect.objectContaining({ cwd: '/repos/demo' }));
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ conversationKey: 'loom:current', url: 'https://github.com/example/repo/pull/42' });
});
it('explains missing PR discovery without registering a watch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(run(['watch-pr'], { env: { TANGO_DESK_ITEM: 'loom:current' }, out: () => {}, exec: () => { throw new Error('no PR'); } })).rejects.toThrow('needs a PR URL');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([[], ['list'], ['batch-a']])('reads fan-out status for the selected thread: %j', async (...args) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-cli-'));
  fs.writeFileSync(path.join(home, 'token'), 'test-token');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ probes: [] })));
  vi.stubGlobal('fetch', fetch);
  try {
    await run(['fan-out', ...args, '--thread', 'parent'], { env: { LOOM_HOME: home, LOOM_PORT: '19420' }, out: () => {} });
    expect(fetch).toHaveBeenCalledWith(`http://127.0.0.1:19420/threads/parent/fan-outs${args[0] === 'batch-a' ? '/batch-a' : ''}`, expect.anything());
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('peek reaches a hidden probe through Loom without creating a desk row', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-peek-'));
  fs.writeFileSync(path.join(home, 'token'), 'test-token');
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"no such conversation"}', { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ thread: { kind: 'probe', title: 'Research', status: 'idle', provider: 'codex' }, messages: [{ role: 'assistant', created_at: 1, text: '{"answer":"yes"}' }] })));
  vi.stubGlobal('fetch', fetch);
  const out = vi.fn();
  try {
    await run(['peek', 'loom:probe', '--json'], { env: { LOOM_HOME: home }, out });
    expect(fetch.mock.calls[1][0]).toBe('http://127.0.0.1:9420/threads/probe');
    expect(JSON.parse(out.mock.calls[0][0]).messages[0].text).toBe('{"answer":"yes"}');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('forwards --same-tree from the current Loom parent', async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ ok: true, itemId: 'loom:worker', mail: { toTitle: 'Worker', expect: 'none' } })));
  vi.stubGlobal('fetch', fetch);
  await run(['start', 'Build the task', '--same-tree'], { env: { TANGO_DESK_ITEM: 'loom:parent' }, out: () => {} });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ from: 'loom:parent', prompt: 'Build the task', sameTree: true });
});
