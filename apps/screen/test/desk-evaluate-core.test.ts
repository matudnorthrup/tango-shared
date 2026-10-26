import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHarness, NOW, cid, type Harness } from './desk-harness.js';
import { presentItem, nextUpQueue } from '../server/desk/view.js';
import { DeskUpdates } from '../server/desk/updates.js';
import { DatabaseSync } from 'node:sqlite';
let h: Harness;
afterEach(() => h?.close());
const make = (id: string) => h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Agent', place: id, createdAt: NOW - 1000 }, 'agent');
describe('read-time status integration', () => {
  it('next up preserves Stuck alongside its failed compatibility step', () => {
    h = makeHarness();
    make('loom:stuck');
    h.core.setFacts('loom:stuck', { handoff: { owner: 'me', text: 'Run tests', at: NOW, source: 'tool', stuck: true } });
    expect(nextUpQueue(h.core).find(i => i.id === 'loom:stuck')).toMatchObject({ pill: 'stuck', step: 'failed' });
  });
  it('counts running descendants at any depth, once each', () => {
    h = makeHarness();
    for (const id of ['loom:lead', 'loom:worker', 'loom:child']) make(id);
    h.core.roles.set('loom:worker', { role: 'worker', parentItemId: 'loom:lead' }, 'source', NOW);
    h.core.roles.set('loom:child', { role: 'worker', parentItemId: 'loom:worker' }, 'source', NOW);
    h.core.setFacts('loom:lead', { held: { reason: 'waiting for workers' } });
    h.core.setFacts('loom:child', { running: { since: NOW }, heartbeatAt: NOW });
    expect(presentItem(h.core.item('loom:lead')!).status).toMatchObject({ pill: 'working', detail: '1 worker' });
    h.core.setFacts('loom:child', { running: null });
    expect(presentItem(h.core.item('loom:lead')!).status.pill).toBe('waiting');
  });
  it('routes ops nested under ops to their live lead; an away lead returns the ask to owner', async () => {
    h = makeHarness();
    for (const id of ['loom:lead', 'loom:ops', 'loom:job']) make(id);
    h.core.roles.set('loom:ops', { role: 'ops', parentItemId: 'loom:lead' }, 'source', NOW);
    h.core.roles.set('loom:job', { role: 'ops', parentItemId: 'loom:ops' }, 'source', NOW);
    h.core.setFacts('loom:job', { openAsk: { text: 'Sign in', at: NOW } });
    expect(presentItem(h.core.item('loom:job')!).status).toMatchObject({ pill: 'waiting', audience: 'lead', countsForOwner: false });
    await h.core.command({ commandId: cid(), type: 'park', itemId: 'loom:lead' });
    expect(presentItem(h.core.item('loom:job')!).status).toMatchObject({ pill: 'needs', audience: 'owner', countsForOwner: true });
  });
  it('read preserves Needs you and its count; Done records the close and prevents poll resurrection', async () => {
    h = makeHarness();
    make('loom:ask');
    h.core.setFacts('loom:ask', { openAsk: { text: 'Approve', at: NOW - 100 } });
    expect(nextUpQueue(h.core).map(i => i.id)).toContain('loom:ask');
    await h.core.command({ commandId: cid(), type: 'viewed', itemId: 'loom:ask', args: { ms: 3000 } });
    expect(presentItem(h.core.item('loom:ask')!).status).toMatchObject({ pill: 'needs', unread: false, countsForOwner: true });
    await h.core.command({ commandId: cid(), type: 'done', itemId: 'loom:ask' });
    expect(h.core.store.eventsFor('loom:ask').find(e => e.type === 'done')?.payload).toMatchObject({ askClosed: { reason: 'closed by done' } });
    h.core.setFacts('loom:ask', { openAsk: { text: 'Approve', at: NOW - 100 } });
    await h.core.command({ commandId: cid(), type: 'reopen', itemId: 'loom:ask' });
    expect(presentItem(h.core.item('loom:ask')!).status.pill).toBe('idle');
  });
  it('undoing Done puts back the ask it closed', async () => {
    h = makeHarness();
    make('loom:undo');
    h.core.setFacts('loom:undo', { openAsk: { text: 'Approve', at: NOW - 100 } });
    const done = await h.core.command({ commandId: cid(), type: 'done', itemId: 'loom:undo' });
    expect(h.core.item('loom:undo')!.facts.openAsk).toBeNull();
    const seq = h.core.store.eventsFor('loom:undo').find(e => e.type === 'done')!.seq;
    await h.core.command({ commandId: cid(), type: 'undo', itemId: 'loom:undo', args: { seq } });
    expect(done.status).toBe('applied');
    expect(h.core.item('loom:undo')!.facts.openAsk).toMatchObject({ text: 'Approve' });
    expect(presentItem(h.core.item('loom:undo')!).status.pill).toBe('needs');
    // The source's next poll of the same ask is accepted again.
    h.core.setFacts('loom:undo', { openAsk: { text: 'Approve', at: NOW - 100 } });
    expect(h.core.item('loom:undo')!.facts.openAsk).toMatchObject({ text: 'Approve' });
  });
  it('undoing Done leaves an ask the source closed meanwhile closed', async () => {
    h = makeHarness();
    make('loom:closed');
    h.core.setFacts('loom:closed', { openAsk: { text: 'Approve', at: NOW - 100 } });
    await h.core.command({ commandId: cid(), type: 'done', itemId: 'loom:closed' });
    h.core.setFacts('loom:closed', { openAsk: { text: 'Approve', at: NOW - 100 } });
    h.core.setFacts('loom:closed', { openAsk: null });
    const seq = h.core.store.eventsFor('loom:closed').find(e => e.type === 'done')!.seq;
    await h.core.command({ commandId: cid(), type: 'undo', itemId: 'loom:closed', args: { seq } });
    expect(h.core.item('loom:closed')!.facts.openAsk).toBeNull();
    expect(presentItem(h.core.item('loom:closed')!).status.pill).toBe('idle');
  });
  it('catch-up uses the row predicate for an ask even after reading it', async () => {
    h = makeHarness();
    make('loom:ask');
    h.core.setFacts('loom:ask', { openAsk: { text: 'Approve plan', at: NOW - 100 } });
    const db = new DatabaseSync(':memory:');
    try {
      const updates = new DeskUpdates({ db, items: () => h.core.items(), spaceOf: () => 'project:test', now: () => NOW });
      updates.syncStatuses();
      expect(updates.list().find(u => u.kind === 'needs')?.status?.countsForOwner).toBe(true);
      await h.core.command({ commandId: cid(), type: 'seen', itemId: 'loom:ask' });
      expect(updates.list().find(u => u.kind === 'needs')?.status?.countsForOwner).toBe(true);
      await h.core.command({ commandId: cid(), type: 'done', itemId: 'loom:ask' });
      expect(updates.list().filter(u => u.kind === 'needs')).toHaveLength(0);
    } finally { db.close(); }
  });
  it('catch-up records an ask once: a long ask, or the thread starting and stopping, writes no new line', () => {
    h = makeHarness();
    make('loom:long');
    const text = `Approve the plan: ${'every step in order, '.repeat(20)}`;
    h.core.setFacts('loom:long', { openAsk: { text, at: NOW - 100 } });
    const db = new DatabaseSync(':memory:');
    try {
      const updates = new DeskUpdates({ db, items: () => h.core.items(), spaceOf: () => 'project:test', now: () => NOW });
      const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM desk_updates WHERE source = 'auto:status'").get() as { n: number }).n;
      updates.syncStatuses();
      updates.syncStatuses();
      expect(rows()).toBe(1);
      make('loom:busy');
      h.core.setFacts('loom:busy', { openAsk: { text: 'Pick a layout', at: NOW - 100 } });
      updates.syncStatuses();
      h.core.setFacts('loom:busy', { background: 'working' });
      expect(presentItem(h.core.item('loom:busy')!).status).toMatchObject({ pill: 'needs', detail: 'Pick a layout · still working' });
      updates.syncStatuses();
      h.core.setFacts('loom:busy', { background: null });
      updates.syncStatuses();
      expect(rows()).toBe(2);
    } finally { db.close(); }
  });
});

describe('owner records and diagnostics', () => {
  it('logs a missed ask by id once per summary, with no status change', () => {
    const log = vi.fn();
    h = makeHarness({ log });
    make('loom:summary');
    h.core.store.patchItem('loom:summary', { summary: { gist: 'Waiting on your approval', step: 'your_move', contentKey: '', at: NOW } as never });
    h.core.refresh('loom:summary');
    h.core.refresh('loom:summary');
    expect(log.mock.calls.filter(call => call[0] === 'desk.missed_ask')).toEqual([['desk.missed_ask', { itemId: 'loom:summary', basis: 'source:responding' }]]);
    expect(presentItem(h.core.item('loom:summary')!).status.pill).toBe('idle');
  });
  it('retained T3 prose does not recreate an owner ask during read-time projections', () => {
    h = makeHarness();
    h.core.ensureItem({ id: 't3:ask', source: 't3', kind: 'thread', conversationKey: 't3:ask', agentId: 't3', agentName: 'Agent', place: 'A task', createdAt: NOW - 1000 }, 'agent');
    h.core.recordMessage('t3:ask', { messageId: 'a', author: 'agent', at: NOW, text: 'A report.\nNext — you: Pick a plan.' });
    h.core.refresh('t3:ask');
    expect(presentItem(h.core.item('t3:ask')!).status.pill).toBe('idle');
  });
});

describe('status.entered', () => {
  it('fires once when a row enters Needs you or Failed, not on the first sight of a row', async () => {
    const { DeskFeed } = await import('../server/desk/feed.js');
    const feedDb = new DatabaseSync(':memory:');
    const feed = new DeskFeed(feedDb, () => NOW);
    h = makeHarness({ feed });
    const events: unknown[] = [];
    h.core.subscribe(e => { if (e.type === 'status.entered') events.push(e.entered); });
    make('loom:e');
    h.core.flush();
    h.core.setFacts('loom:e', { openAsk: { text: 'Approve', at: NOW } });
    h.core.flush();
    expect(events).toEqual([{ itemId: 'loom:e', pill: 'needs', from: 'idle', at: NOW }]);
    h.core.setFacts('loom:e', { openAsk: { text: 'Approve again', at: NOW + 1 } });
    h.core.flush();
    expect(events).toHaveLength(1);
    h.core.setFacts('loom:e', { failed: { at: NOW + 2, reason: 'error', message: 'crashed' } });
    h.core.flush();
    expect(events).toHaveLength(2);
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map(p => p.kind)).toContain('failed');
    feedDb.close();
  });
  it('posts no Needs you while the owner had the last word; a Failed still posts', async () => {
    const { DeskFeed } = await import('../server/desk/feed.js');
    const feedDb = new DatabaseSync(':memory:');
    const feed = new DeskFeed(feedDb, () => NOW);
    h = makeHarness({ feed });
    make('loom:o');
    h.core.flush();
    h.core.store.addMessage({ messageId: 'loom:o:m1', itemId: 'loom:o', author: 'owner', at: NOW, text: 'The trip is the 3rd to the 9th.' });
    const states = () => feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter(p => p.kind !== 'started').map(p => p.kind);
    h.core.setFacts('loom:o', { openAsk: { text: 'Book it?', at: NOW } });
    h.core.flush();
    expect(states()).toEqual([]);
    h.core.setFacts('loom:o', { failed: { at: NOW + 1, reason: 'error', message: 'crashed' } });
    h.core.flush();
    expect(states()).toEqual(['failed']);
    // The agent's own question before any reply is new to the owner: it posts.
    make('loom:q');
    h.core.flush();
    h.core.store.addMessage({ messageId: 'loom:q:m1', itemId: 'loom:q', author: 'owner', at: NOW, text: 'The trip is the 3rd to the 9th.' });
    h.core.setFacts('loom:q', { pending: { kind: 'question', question: 'Window or aisle?', options: [], at: NOW + 1 } as never });
    h.core.flush();
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter(p => p.itemId === 'loom:q' && p.kind === 'needs')).toHaveLength(1);
    feedDb.close();
  });
  it('posts a Failed only when it is the owner\'s: a worker\'s failure goes to its live lead, not the Feed', async () => {
    const { DeskFeed } = await import('../server/desk/feed.js');
    const feedDb = new DatabaseSync(':memory:');
    const feed = new DeskFeed(feedDb, () => NOW);
    h = makeHarness({ feed });
    for (const id of ['loom:lead', 'loom:worker']) make(id);
    h.core.roles.set('loom:worker', { role: 'worker', parentItemId: 'loom:lead' }, 'source', NOW);
    h.core.flush();
    h.core.setFacts('loom:worker', { failed: { at: NOW, reason: 'error', message: 'tests red' } });
    h.core.flush();
    const states = () => feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter(p => p.kind !== 'started');
    expect(states()).toEqual([]);
    h.core.setFacts('loom:lead', { failed: { at: NOW, reason: 'error', message: 'crashed' } });
    h.core.flush();
    expect(states()).toMatchObject([{ kind: 'failed', itemId: 'loom:lead', data: { source: 'status.entered', from: 'idle' } }]);
    feedDb.close();
  });
  it('posts Stuck when a wait\'s third check in a row fails, whatever the pill, and again only after it recovers', async () => {
    const { DeskFeed } = await import('../server/desk/feed.js');
    const feedDb = new DatabaseSync(':memory:');
    const feed = new DeskFeed(feedDb, () => h.clock.now);
    h = makeHarness({ feed });
    make('loom:s');
    const wait = (consecutiveErrors: number, checkError: string | null = 'HTTP 502') => ({ waits: [{ id: 'w1', kind: 'pr' as const, target: 'PR #5 review', armedAt: NOW - 1000, checkError, consecutiveErrors, errorSince: NOW - 500 }] });
    h.core.setFacts('loom:s', wait(0, null));
    h.core.flush();
    const states = () => feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter(p => p.kind !== 'started');
    const kinds = () => states().map(p => p.kind);
    h.core.setFacts('loom:s', wait(1));
    h.core.flush();
    h.core.setFacts('loom:s', wait(2));
    h.core.flush();
    expect(kinds()).toEqual([]);
    // A running turn reads Working, not Unknown: Stuck reads the wait, never the pill.
    h.core.setFacts('loom:s', { ...wait(3), running: { since: NOW }, heartbeatAt: NOW });
    h.core.flush();
    expect(states()).toMatchObject([{ kind: 'stuck', itemId: 'loom:s', text: 'PR #5 review check failing: HTTP 502', data: { source: 'wait', waitId: 'w1' } }]);
    h.core.setFacts('loom:s', wait(4));
    h.core.flush();
    expect(kinds()).toEqual(['stuck']);
    h.core.setFacts('loom:s', { ...wait(0, null), running: null });
    h.core.flush();
    // Past the merge window: breaking again is a post of its own.
    h.clock.now += 10 * 60_000;
    h.core.setFacts('loom:s', wait(3));
    h.core.flush();
    expect(feedDb.prepare("SELECT count(*) AS n FROM desk_feed WHERE kind = 'stuck'").get()).toEqual({ n: 2 });
    feedDb.close();
  });
  it('posts Stuck for each wait that breaks in one flush', async () => {
    const { DeskFeed } = await import('../server/desk/feed.js');
    const feedDb = new DatabaseSync(':memory:');
    const feed = new DeskFeed(feedDb, () => h.clock.now);
    h = makeHarness({ feed });
    make('loom:s');
    h.core.flush();
    const broken = (id: string, target: string) => ({ id, kind: 'pr' as const, target, armedAt: NOW - 1000, checkError: 'HTTP 502', consecutiveErrors: 3, errorSince: NOW - 500 });
    h.core.setFacts('loom:s', { waits: [broken('w1', 'PR #5 review'), broken('w2', 'PR #6 review')] });
    h.core.flush();
    expect(feedDb.prepare("SELECT key FROM desk_feed WHERE kind = 'stuck' ORDER BY seq").all()).toEqual([{ key: 'wait:loom:s:w1' }, { key: 'wait:loom:s:w2' }]);
    feedDb.close();
  });
  it('a Stuck post keeps its own key: it never folds into a Needs you post, nor a summary into it', async () => {
    const { DeskFeed } = await import('../server/desk/feed.js');
    const feedDb = new DatabaseSync(':memory:');
    const feed = new DeskFeed(feedDb, () => h.clock.now);
    h = makeHarness({ feed });
    make('loom:s');
    h.core.flush();
    feed.post({ kind: 'needs', itemId: 'loom:s', title: 'Pick one', text: '', key: 'thread:loom:s', mergeMs: 5 * 60_000 });
    h.core.setFacts('loom:s', { waits: [{ id: 'w1', kind: 'pr' as const, target: 'PR #5 review', armedAt: NOW - 1000, checkError: 'HTTP 502', consecutiveErrors: 3, errorSince: NOW - 500 }] });
    h.core.flush();
    feed.post({ kind: 'update', itemId: 'loom:s', title: 'Still at it', text: 'Words', data: { update: true }, key: 'thread:loom:s', mergeMs: 5 * 60_000 });
    const rows = feedDb.prepare("SELECT kind, text, key FROM desk_feed WHERE kind IN ('needs', 'stuck') ORDER BY seq").all();
    expect(rows).toMatchObject([{ kind: 'needs', key: 'thread:loom:s' }, { kind: 'stuck', text: 'PR #5 review check failing: HTTP 502', key: 'wait:loom:s:w1' }]);
    feedDb.close();
  });
  it('after a restart, a stored row that later turns Needs you still enters', async () => {
    const { DeskCore } = await import('../server/desk/core.js');
    h = makeHarness();
    make('loom:r');
    h.core.flush();
    const restarted = new DeskCore({ store: h.core.store, summarize: async () => { throw new Error('unused'); }, now: () => NOW } as ConstructorParameters<typeof DeskCore>[0]);
    const events: unknown[] = [];
    restarted.subscribe(e => { if (e.type === 'status.entered') events.push(e.entered); });
    restarted.setFacts('loom:r', { openAsk: { text: 'Approve', at: NOW } });
    restarted.flush();
    expect(events).toEqual([{ itemId: 'loom:r', pill: 'needs', from: 'idle', at: NOW }]);
  });
});
