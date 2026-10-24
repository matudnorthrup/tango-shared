import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { DeskUpdates, nextMorning } from '../server/desk/updates.js';
import { planChapter } from '../server/desk/catchup-actions.js';
import { makeHarness } from './desk-harness.js';
// @ts-expect-error plain browser module
import { createStore } from '../public/desk/store.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function route() {
  const h = makeHarness();
  cleanups.push(() => h.close());
  const updates = new DeskUpdates({ db: h.db, items: () => [], spaceOf: () => null, coverThread: () => {}, exec: null });
  const line = updates.record({ spaceId: 'project:desk', kind: 'shipped', moment: true, title: 'Change shipped', source: 'test' });
  const app = new Hono();
  registerDeskRoutes(app, { core: h.core, scenes: () => [], updates });
  const plan = planChapter(updates, 'project:desk', [], Date.now());
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { updates, line, post, body: { updateIds: plan.updateIds, revision: plan.revision, commandId: 'snooze-test' } };
}

describe('catch-up snooze route (D-679)', () => {
  it('keeps the next-morning default and honors an explicit time', async () => {
    for (const explicit of [false, true]) {
      const { post, body, updates } = route();
      const backAt = Date.now() + 7_200_000;
      const before = Date.now();
      const response = await post('/api/desk/chapters/project:desk/defer', { ...body, ...(explicit ? { backAt } : {}) });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.backAt).toBe(explicit ? backAt : nextMorning(before, '06:00'));
      expect(updates.chapters()[0]).toMatchObject({ state: 'deferred', backAt: result.backAt });
      // A lost-response retry gets the receipt, without re-applying a stale chapter.
      expect(await (await post('/api/desk/chapters/project:desk/defer', { ...body, ...(explicit ? { backAt } : {}) })).json()).toEqual(result);
    }
  });
  it('replays a completed snooze after its return time without snoozing again', async () => {
    const clock = vi.spyOn(Date, 'now');
    try {
      const now = Date.now();
      clock.mockReturnValue(now);
      const { post, body, updates, line } = route();
      const backAt = now + 60_000;
      const request = { ...body, backAt };
      const first = await post('/api/desk/chapters/project:desk/defer', request);
      expect(first.status).toBe(200);
      const receipt = await first.json();
      const saved = updates.list().find((u) => u.id === line.id);
      clock.mockReturnValue(backAt + 1);
      const retry = await post('/api/desk/chapters/project:desk/defer', request);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual(receipt);
      expect(updates.list().find((u) => u.id === line.id)).toEqual(saved);
      // The elapsed time remains invalid for a new command.
      expect((await post('/api/desk/chapters/project:desk/defer', { ...request, commandId: 'new-command' })).status).toBe(400);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([0, -1, null, 'tomorrow', {}, Date.now() - 1000])('rejects invalid or past backAt %j without marking lines', async (backAt) => {
    const { post, body, updates } = route();
    expect((await post('/api/desk/chapters/project:desk/defer', { ...body, backAt })).status).toBe(400);
    expect(updates.chapters()[0].state).toBe('news');
  });
  it('preserves the per-line return time', async () => {
    const { post, line, updates } = route();
    const backAt = Date.now() + 9_000_000;
    expect((await post('/api/desk/updates/seen', { ids: [line.id], via: 'deferred', outcome: 'later', backAt })).status).toBe(200);
    expect(updates.list()[0]).toMatchObject({ backAt, seenVia: 'deferred', outcome: 'later' });
  });
});

describe('catch-up picker actions', () => {
  function setup() {
    const plan = { updateIds: [1], revision: 'r1' };
    const chapterDefer = vi.fn(async (_space, body) => ({ backAt: body.backAt }));
    const updatesSeen = vi.fn(async () => ({}));
    const store = createStore({ mode: 'live', chapterDefer, updatesSeen, chapters: async () => ({ chapters: [] }), chapter: async () => ({ plan, lines: [], waiting: [] }) });
    store.set({ projects: [{ id: 'desk', name: 'Desk' }], chapters: { 'project:desk': { data: { plan } } } });
    return { store, chapterDefer, updatesSeen };
  }
  it('does nothing until a pick, then preserves the pick through Retry and Done here', async () => {
    const { store, chapterDefer } = setup();
    const onDone = vi.fn();
    await store.chapterAct('project:desk', 'deferred', { name: 'Desk', onDone });
    expect(chapterDefer).not.toHaveBeenCalled();
    expect(store.state.catchupSnooze.name).toBe('Desk');
    store.set({ chapters: { 'project:desk': { data: { plan: { updateIds: [1, 2], revision: 'new' } } } } });
    const backAt = Date.now() + 7_200_000;
    chapterDefer.mockRejectedValueOnce(new Error('offline'));
    await store.chooseSnooze({ args: { until: new Date(backAt).toISOString() } });
    await store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
    expect(chapterDefer).toHaveBeenCalledTimes(2);
    expect(chapterDefer.mock.calls[0][1]).toEqual(chapterDefer.mock.calls[1][1]);
    expect(chapterDefer.mock.calls[1][1]).toMatchObject({ backAt, updateIds: [1], revision: 'r1' });
    expect(onDone).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.state.toasts)).toContain('briefs stay in Needs you');
  });
  it('reopens the picker when a per-line Retry has passed its return time', async () => {
    const { store, updatesSeen } = setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await store.chapterLine('project:desk', { id: 1, ids: [1, 2] }, 'defer');
      updatesSeen.mockRejectedValueOnce(new Error('response lost'));
      const backAt = now + 60_000;
      await store.chooseSnooze({ args: { until: new Date(backAt).toISOString() } });
      expect(store.state.lineLocal).toEqual({});
      clock.mockReturnValue(backAt);
      await store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
      expect(updatesSeen).toHaveBeenCalledTimes(1);
      expect(store.state.snoozeFor).toBe('line:project:desk:1');
      const later = backAt + 7_200_000;
      await store.chooseSnooze({ args: { until: new Date(later).toISOString() } });
      expect(updatesSeen).toHaveBeenLastCalledWith({ ids: [1, 2], via: 'deferred', outcome: 'later', backAt: later });
      expect(store.state.lineLocal).toEqual({});
    } finally { clock.mockRestore(); }
  });
  it('tries chapter receipt replay before reopening the picker on an expired-time refusal', async () => {
    const { store, chapterDefer } = setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const onDone = vi.fn();
    try {
      await store.chapterAct('project:desk', 'deferred', { name: 'Desk', onDone });
      chapterDefer.mockRejectedValueOnce(new Error('offline'));
      const backAt = now + 60_000;
      await store.chooseSnooze({ args: { until: new Date(backAt).toISOString() } });
      clock.mockReturnValue(backAt);
      chapterDefer.mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 400, body: { error: 'backAt must be a future time (ms)' } }));
      await store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
      expect(chapterDefer.mock.calls[1][1]).toEqual(chapterDefer.mock.calls[0][1]);
      await store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
      expect(chapterDefer).toHaveBeenCalledTimes(2);
      expect(store.state.snoozeFor).toBe('chapter:project:desk');
      expect(store.state.chapterLocal).toEqual({});
      const later = backAt + 7_200_000;
      await store.chooseSnooze({ args: { until: new Date(later).toISOString() } });
      expect(chapterDefer.mock.calls[2][1]).toMatchObject({ backAt: later, updateIds: [1], revision: 'r1' });
      expect(chapterDefer.mock.calls[2][1].commandId).not.toBe(chapterDefer.mock.calls[0][1].commandId);
      expect(onDone).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
  it('a brief uses the same picker and passes milliseconds to updates/seen', async () => {
    const { store, updatesSeen } = setup();
    await store.chapterLine('project:desk', { id: 1 }, 'defer');
    expect(updatesSeen).not.toHaveBeenCalled();
    const backAt = Date.now() + 7_200_000;
    await store.chooseSnooze({ args: { until: new Date(backAt).toISOString() } });
    expect(updatesSeen).toHaveBeenCalledWith({ ids: [1], via: 'deferred', outcome: 'later', backAt });
    expect(JSON.stringify(store.state.toasts)).toContain('It stays in Needs you.');
  });
});
