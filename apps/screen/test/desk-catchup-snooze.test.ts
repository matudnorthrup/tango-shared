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

function route(items: import('../server/desk/types.js').DeskItem[] = []) {
  const h = makeHarness();
  cleanups.push(() => h.close());
  const updates = new DeskUpdates({ db: h.db, items: () => items, spaceOf: () => null, coverThread: () => {}, exec: null });
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
  it('restores a matching deferral, is retry-safe, and preserves a newer mark', async () => {
    const { post, line, updates } = route();
    const backAt = Date.now() + 9_000_000;
    const saved = updates.seen([line.id], 'deferred', 'later', { backAt })[0];
    const body = { ids: [line.id], backAt, seenAt: saved.seenAt };
    expect((await post('/api/desk/updates/restore-snooze', body)).status).toBe(200);
    expect(updates.list()[0]).toMatchObject({ seenAt: null, seenVia: null, backAt: null, outcome: null });
    expect(updates.chapters()[0].state).toBe('news');
    expect((await (await post('/api/desk/updates/restore-snooze', body)).json()).updates).toEqual([]);
    updates.seen([line.id], 'deferred', 'later', { backAt: backAt + 1000 });
    await post('/api/desk/updates/restore-snooze', body);
    expect(updates.list()[0].backAt).toBe(backAt + 1000);
  });
  it('brings an open brief back into the chapter needs count', async () => {
    const { post, updates } = route([{ id: 'sample', disposition: 'active', facts: { openBrief: { kind: 'question', question: 'Continue?', brief: { id: 'D-77' } } }, seen: 'new' } as never]);
    const line = updates.record({ itemId: 'sample', spaceId: 'project:desk', kind: 'needs', title: 'Continue?', briefId: 'D-77', source: 'test' });
    const backAt = Date.now() + 7_200_000;
    const mark = updates.seen([line.id], 'deferred', 'later', { backAt })[0];
    expect(updates.chapters()[0].needs).toBe(0);
    await post('/api/desk/updates/restore-snooze', { ids: [line.id], backAt, seenAt: mark.seenAt });
    expect(updates.chapters()[0].needs).toBe(1);
  });
  it('restores a read mark only with its timestamp and rejects unguarded requests', async () => {
    const { post, line, updates } = route();
    const saved = updates.seen([line.id], 'read', 'got-it')[0];
    expect((await post('/api/desk/updates/restore-snooze', { ids: [line.id], backAt: null, seenAt: null })).status).toBe(400);
    await post('/api/desk/updates/restore-snooze', { ids: [line.id], backAt: null, seenAt: saved.seenAt });
    expect(updates.list()[0].seenAt).toBeNull();
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


describe('thread snooze from a catch-up brief', () => {
  function setup(status = 'sent') {
    const updatesSeen = vi.fn(async () => ({}));
    const command = vi.fn(async () => ({ status, outcome: { seq: 42 }, error: status === 'failed' ? 'refused' : undefined }));
    const updatesRestoreSnooze = vi.fn(async () => ({}));
    const store = createStore({ mode: 'live', command, updatesSeen, updatesRestoreSnooze, chapters: async () => ({ chapters: [] }), chapter: async () => ({ lines: [], waiting: [] }) });
    const line = { id: 7, itemId: 'sample' };
    store.set({ byId: { sample: { id: 'sample', facts: {}, disposition: 'active' } } });
    return { store, updatesSeen, updatesRestoreSnooze, command, line };
  }
  it.each(['time', 'trigger'])('dismisses the line only after a sent %s snooze', async (kind) => {
    const { store, updatesSeen, command, line } = setup();
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    expect(updatesSeen).not.toHaveBeenCalled();
    const backAt = Date.now() + 7_200_000;
    const args = kind === 'time' ? { until: new Date(backAt).toISOString() } : { trigger: 'agent_posts' };
    await store.chooseSnooze({ type: 'snooze', key: kind, label: 'Later', args });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'snooze', itemId: 'sample', args: expect.objectContaining(args) }));
    expect(updatesSeen).toHaveBeenCalledWith(kind === 'time' ? { ids: [7], via: 'deferred', outcome: 'later', backAt } : { ids: [7], via: 'read', outcome: 'got-it' });
    expect(JSON.stringify(store.state.toasts)).not.toContain('It stays in Needs you');
  });
  it('retries a failed line write without sending the thread snooze twice', async () => {
    const { store, updatesSeen, command, line } = setup();
    updatesSeen.mockRejectedValueOnce(new Error('offline'));
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    const until = new Date(Date.now() + 7_200_000).toISOString();
    await store.chooseSnooze({ type: 'snooze', key: 'soon', label: 'In 2 hours', args: { until } });
    expect(store.state.lineLocal).toEqual({});
    await store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
    expect(command).toHaveBeenCalledTimes(1);
    expect(updatesSeen).toHaveBeenCalledTimes(2);
    expect(updatesSeen.mock.calls[0]).toEqual(updatesSeen.mock.calls[1]);
  });
  it('Undo restores the thread and line; restore Retry never undoes the thread twice', async () => {
    const { store, updatesRestoreSnooze, command, line } = setup();
    const backAt = Date.now() + 7_200_000;
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    await store.chooseSnooze({ type: 'snooze', key: 'soon', label: 'In 2 hours', args: { until: new Date(backAt).toISOString() } });
    updatesRestoreSnooze.mockRejectedValueOnce(new Error('offline'));
    await store.state.toasts.find((t: any) => t.actions?.some((a: any) => a.label === 'Undo')).actions.find((a: any) => a.label === 'Undo').fn();
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'undo', args: { seq: 42 } }));
    expect(updatesRestoreSnooze).toHaveBeenCalledWith({ ids: [7], backAt, seenAt: null });
    await store.state.toasts.at(-1).actions.find((a: any) => a.label === 'Retry').fn();
    expect(command).toHaveBeenCalledTimes(2);
    expect(updatesRestoreSnooze).toHaveBeenCalledTimes(2);
  });
  it('a failed Undo leaves the line deferred; its Retry restores both', async () => {
    const { store, updatesRestoreSnooze, command, line } = setup();
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    await store.chooseSnooze({ type: 'snooze', key: 'soon', label: 'In 2 hours', args: { until: new Date(Date.now() + 7_200_000).toISOString() } });
    command.mockResolvedValueOnce({ status: 'failed', outcome: { seq: 42 }, error: 'offline' });
    await store.state.toasts.find((t: any) => t.actions?.some((a: any) => a.label === 'Undo')).actions.find((a: any) => a.label === 'Undo').fn();
    expect(updatesRestoreSnooze).not.toHaveBeenCalled();
    await store.state.toasts.at(-1).actions.find((a: any) => a.label === 'Retry').fn();
    expect(updatesRestoreSnooze).toHaveBeenCalledOnce();
  });
  it('Undo prevents a saved line-write Retry from hiding the card again', async () => {
    const { store, updatesSeen, updatesRestoreSnooze, line } = setup();
    updatesSeen.mockRejectedValueOnce(new Error('lost response'));
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    await store.chooseSnooze({ type: 'snooze', key: 'soon', label: 'In 2 hours', args: { until: new Date(Date.now() + 7_200_000).toISOString() } });
    const retry = store.state.toasts.at(-1).actions.find((a: any) => a.label === 'Retry').fn;
    await store.state.toasts.find((t: any) => t.actions?.some((a: any) => a.label === 'Undo')).actions.find((a: any) => a.label === 'Undo').fn();
    await retry();
    expect(updatesSeen).toHaveBeenCalledOnce();
    expect(updatesRestoreSnooze).toHaveBeenCalledOnce();
  });
  it('keeps the line when the snooze fails', async () => {
    const { store, updatesSeen, line } = setup('failed');
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    await store.chooseSnooze({ type: 'snooze', key: 'post', label: 'Until they post', args: { trigger: 'agent_posts' } });
    expect(updatesSeen).not.toHaveBeenCalled();
  });
  it('cancelling then opening a normal thread snooze does not dismiss the old line', async () => {
    const { store, updatesSeen, line } = setup();
    store.openSnooze('sample', { spaceId: 'project:desk', line });
    store.set({ snoozeFor: null });
    expect(updatesSeen).not.toHaveBeenCalled();
    store.openSnooze('sample');
    await store.chooseSnooze({ type: 'snooze', key: 'post', label: 'Until they post', args: { trigger: 'agent_posts' } });
    expect(updatesSeen).not.toHaveBeenCalled();
  });
});
