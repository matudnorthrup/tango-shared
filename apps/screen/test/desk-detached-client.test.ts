import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveClient } from '../public/desk/api.js';

// A detached window's client (public/desk/api.js): its moves stay in the window, and it never stands in for the owner's.

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ commandId: 'c-2', status: 'applied' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

describe('a detached window’s client', () => {
  it('keeps its moves to itself and starts on the board', async () => {
    const calls = stubFetch();
    const client = createLiveClient({ screenName: 'claude-check', detached: true });
    expect(client.detached).toBe(true);
    expect(await client.present({ view: 'conversation', itemId: 'loom:next', window: { id: 'w', seq: 1 } })).toBeNull();
    expect(await client.presentation()).toMatchObject({ view: 'active', itemId: null, since: 1 });
    await client.presence();
    await client.listPage('s1', { rows: [] }, 1);
    await expect(client.setScreenRole('s1', 'screen')).rejects.toMatchObject({ status: 403 });
    await client.command({ commandId: 'c-1', type: 'viewed', itemId: 'loom:next' });
    expect(calls).toEqual([]);
  });

  it('marks what it does send, and still sends the commands a test is about', async () => {
    const calls = stubFetch();
    const client = createLiveClient({ detached: true });
    await client.command({ commandId: 'c-2', type: 'seen', itemId: 'loom:next' });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>)['X-Desk-Window']).toBe('detached');
  });
});
