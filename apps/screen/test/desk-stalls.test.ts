import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskStore } from '../server/desk/store.js';
import { timeRequests, watchStalls, type TimedRequest } from '../server/desk/stalls.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// The desk jumping back to the board (2026-10-17): a busy server let an older move land after a newer one.
// The server side reads less, the trace says when it is busy, and a window keeps its own newest move.

const NOW = 1_790_000_000_000;

function store(now = () => NOW) {
  const db = new DatabaseSync(':memory:');
  const s = new DeskStore(db, now);
  const item = (id: string) => s.createItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', createdAt: NOW });
  return { db, s, item };
}

describe('deskItems reuse', () => {
  it('reads again once an item or its attention changes, and only then', () => {
    const { db, s, item } = store();
    item('loom:a');
    const prepare = vi.spyOn(db, 'prepare');
    const first = s.deskItems();
    const reads = () => prepare.mock.calls.filter(([sql]) => String(sql).includes('FROM desk_items i')).length;
    expect(reads()).toBe(1);
    expect(s.deskItems()).toEqual(first);
    expect(reads()).toBe(1);

    s.patchItem('loom:a', { ask: 'Which one?' });
    expect(s.deskItems()[0]!.ask).toBe('Which one?');
    expect(reads()).toBe(2);

    s.saveAttention({ itemId: 'loom:a', disposition: 'done', seen: 'seen', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, doneAt: NOW, writeback: null, updatedAt: NOW, coveredUntil: null });
    expect(s.deskItems()[0]!.disposition).toBe('done');

    item('loom:b');
    expect(s.deskItems().map((i) => i.id).sort()).toEqual(['loom:a', 'loom:b']);
    s.deleteItem('loom:b');
    expect(s.deskItems().map((i) => i.id)).toEqual(['loom:a']);
  });

  it('a write from another connection counts too', () => {
    const { db, s, item } = store();
    item('loom:a');
    s.deskItems();
    db.prepare("UPDATE desk_items SET ask = 'raw' WHERE id = 'loom:a'").run();
    expect(s.deskItems()[0]!.ask).toBe('raw');
  });

  it('a source snooze running out shows without a write', () => {
    let now = NOW;
    const { s, item } = store(() => now);
    item('loom:a');
    s.patchItem('loom:a', { facts: { sourceSnoozedUntil: NOW + 60_000 } });
    expect(s.deskItems()[0]!.disposition).toBe('snoozed');
    now = NOW + 60_001;
    expect(s.deskItems()[0]!.disposition).toBe('active');
  });

  it('a caller changing the list it got does not change the next one', () => {
    const { s, item } = store();
    item('loom:a');
    s.deskItems().pop();
    expect(s.deskItems()).toHaveLength(1);
  });
});

describe('isUndone', () => {
  it('looks the seq up by index, not by reading every event', () => {
    const { db } = store();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 AS ok FROM desk_events WHERE type = 'undo' AND undoes_seq = ?").all(5) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(' ')).toContain('desk_events_undoes');
  });
});

describe('server busy, in the trace', () => {
  afterEach(() => vi.useRealTimers());

  it('watchStalls reports a timer that fired late', () => {
    vi.useFakeTimers();
    let now = 0;
    const stalls: number[] = [];
    const stop = watchStalls({ onStall: (ms) => stalls.push(ms), thresholdMs: 250, everyMs: 100, now: () => now });
    now += 100;
    vi.advanceTimersByTime(100);
    now += 100 + 900;
    vi.advanceTimersByTime(100);
    stop();
    expect(stalls).toEqual([900]);
  });

  it('timeRequests reports a slow handler and a request that waited, not a quick one', async () => {
    let now = 10_000;
    const slow: TimedRequest[] = [];
    const app = new Hono();
    app.use('/api/*', timeRequests((r) => slow.push(r), { now: () => now }));
    app.get('/api/quick', (c) => c.text('ok'));
    app.get('/api/slow', (c) => ((now += 400), c.text('ok')));
    app.get('/api/search', (c) => ((now += 300), c.text('ok')));
    await app.request('/api/quick', { headers: { 'X-Desk-Sent-At': String(now - 10) } });
    await app.request('/api/slow');
    await app.request('/api/quick', { headers: { 'X-Desk-Sent-At': String(now - 5000) } });
    // A browser clock ahead of the server's: no wait, not a report.
    await app.request('/api/quick', { headers: { 'X-Desk-Sent-At': String(now + 9000) } });
    // Which list is kept; what the owner typed is not.
    await app.request('/api/search?q=my%20secret%20plan&view=active');
    expect(slow).toEqual([
      { method: 'GET', path: '/api/slow', ms: 400, waitedMs: null },
      { method: 'GET', path: '/api/quick', ms: 0, waitedMs: 5000 },
      { method: 'GET', path: '/api/search?q=…&view=active', ms: 300, waitedMs: null },
    ]);
  });
});

describe('a window keeps its newest move', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Hub times are the server's clock, a little after this window's own optimistic moves.
  const hubNow = Date.now() + 60_000;
  const at = (ms: number) => hubNow + ms;
  const board = (since: number) => ({ view: 'active', itemId: null, conversationKey: null, sceneId: null, by: 'screen', since, queue: [] });
  const convo = (id: string, since: number) => ({ view: 'conversation', itemId: id, conversationKey: id, sceneId: null, by: 'screen', since, queue: [] });

  function windowWithSlowServer() {
    const answers: Array<ReturnType<typeof deferred<unknown>>> = [];
    const s = createStore({
      mode: 'fixtures',
      // The service's answer: { applied, presentation }.
      present: () => {
        const answer = deferred<unknown>();
        answers.push(answer);
        return answer.promise.then((presentation) => ({ applied: true, presentation }));
      },
      item: async (id: string) => ({ item: { id }, messages: [] }),
    });
    return { s, answers };
  }

  it('Send’s “back to the board” landing after the next thread opened does not take the window back', async () => {
    const { s, answers } = windowWithSlowServer();
    s.goBoard(); // after a send
    s.openItem('loom:next'); // the owner moved on while that was stuck
    expect(s.state.presentation.itemId).toBe('loom:next');
    // The server finally applies the board, tells every screen, and answers.
    s.handlers.onPresentation(board(at(0)));
    answers[0]!.resolve(board(at(0)));
    await tick();
    expect(s.state.presentation.view).toBe('conversation');
    expect(s.state.presentation.itemId).toBe('loom:next');
    // Then the newer move lands.
    s.handlers.onPresentation(convo('loom:next', at(1)));
    answers[1]!.resolve(convo('loom:next', at(1)));
    await tick();
    expect(s.state.presentation).toMatchObject({ view: 'conversation', itemId: 'loom:next', since: at(1) });
  });

  it('a move another screen made after this one still wins once the answer is in', async () => {
    const { s, answers } = windowWithSlowServer();
    s.openItem('loom:mine');
    s.handlers.onPresentation(convo('loom:mine', at(0)));
    s.handlers.onPresentation(convo('loom:theirs', at(5)));
    answers[0]!.resolve(convo('loom:mine', at(0)));
    await tick();
    expect(s.state.presentation.itemId).toBe('loom:theirs');
  });

  it('a move that never answers holds the window for 20 s at most', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const { s } = windowWithSlowServer();
      s.openItem('loom:mine');
      s.handlers.onPresentation(convo('loom:theirs', Date.now() + 1000));
      expect(s.state.presentation.itemId).toBe('loom:mine');
      vi.advanceTimersByTime(20_001);
      expect(s.state.presentation.itemId).toBe('loom:theirs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('with nothing of its own on the way, the window follows the hub at once', () => {
    const { s } = windowWithSlowServer();
    s.handlers.onPresentation(convo('loom:elsewhere', at(0)));
    expect(s.state.presentation.itemId).toBe('loom:elsewhere');
  });
});
