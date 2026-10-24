import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskGitHubReviews } from '../server/desk/source-github.js';
import { cid, makeHarness, NOW, type Harness } from './desk-harness.js';

let h: Harness;
afterEach(() => h?.close());
describe('rows without a source adapter', () => {
  it('exposes capability and matching Loom continuation; preserves Done and Reopen', async () => {
    h = makeHarness({ adapters: [{ owns: (row) => row.source === 'loom' } as never] });
    for (const source of ['t3', 'loom'] as const) h.core.store.createItem({ id: `${source}:old`, source, kind: 'thread', conversationKey: `${source}:old`, agentId: 'helper', agentName: 'Helper', place: 'maps · Overview' });
    expect(h.core.item('t3:old')).toMatchObject({ replyable: false, continuation: { id: 'loom:old', place: 'maps · Overview' } });
    expect(h.core.item('loom:old')).toMatchObject({ replyable: true, continuation: null });
    await h.core.command({ commandId: cid(), type: 'done', itemId: 't3:old' });
    expect(h.core.item('t3:old')?.disposition).toBe('done');
    await h.core.command({ commandId: cid(), type: 'reopen', itemId: 't3:old' });
    expect(h.core.item('t3:old')?.disposition).toBe('active');
    expect(h.core.store.item('t3:old')).not.toBeNull();
  });

  it.each(['CHANGES_REQUESTED', 'APPROVED'])('reads %s without waking a retired source', async (reviewDecision) => {
    h = makeHarness();
    h.core.store.createItem({ id: 't3:old', source: 't3', kind: 'thread', conversationKey: 't3:old', agentId: 'helper', agentName: 'Helper' });
    await h.core.command({ commandId: cid(), type: 'watch', itemId: 't3:old', args: { url: 'https://github.com/acme/maps/pull/7' } });
    const command = vi.spyOn(h.core, 'command');
    const github = new DeskGitHubReviews({ core: h.core, now: () => NOW, exec: async (_cmd, args) => args[0] === 'auth' ? 'Logged in' : JSON.stringify({ state: 'OPEN', reviewDecision, reviews: [{ author: { login: 'reviewer' }, state: reviewDecision, submittedAt: new Date(NOW).toISOString() }], reviewRequests: [] }) });
    expect(await github.poll()).toBe(1);
    expect(command).not.toHaveBeenCalled();
    const item = h.core.item('t3:old')!;
    expect(item.facts.prReview?.state).toBe(reviewDecision === 'APPROVED' ? 'approved' : 'changes_requested');
    expect(item.status?.detail).not.toContain('agent woken');
    if (reviewDecision === 'CHANGES_REQUESTED') expect(item.status?.detail).toContain('read-only');
    expect(item.facts.prWatches?.[0].wokeFor).toBeNull();
  });
});
