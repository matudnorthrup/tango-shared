import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module, no types
import { bulkDone, bulkMove, bulkPin, bulkRead, bulkUnread, selectionActions, selectionMenu, toggleIds } from '../public/desk/next/select.js';
// @ts-expect-error plain browser module, no types
import { contextItems } from '../public/desk/next/context.js';

// The next layout's selection: a list as a picker, and acting on every selected thread at once. Invented names only.

const NOW = 1_790_000_000_000;
type Item = Record<string, unknown>;
const thread = (id: string, over: Item = {}): Item => ({ id, source: 'discord', kind: 'thread', agentId: 'sierra', agentName: 'Sierra', place: id, facts: {}, disposition: 'active', nextStep: 'your_move', lastActivityAt: NOW - 60_000, summary: { title: id }, ...over });
const projects = [
  { id: 'p1', name: 'Desk reliability', color: 'violet', createdAt: 0 },
  { id: 'p2', name: 'Ferry trip', color: 'teal', createdAt: 0 },
];

function storeWith(items: Item[], over: Record<string, unknown> = {}) {
  let seq = 0;
  const state: Record<string, unknown> = {
    now: NOW,
    projects,
    lists: { active: { items, loaded: true }, snoozed: { items: [], loaded: true }, history: { items: [], loaded: true } },
    byId: Object.fromEntries(items.map((i) => [i.id, i])),
    presentation: { view: 'active', itemId: null },
    nextRoute: { page: 'inbox' },
    nextSelect: { kind: 'thread', ids: items.map((i) => i.id), anchor: null },
    ...over,
  };
  const store = {
    state,
    threadOpen: () => false,
    command: vi.fn(async (type: string) => ({ status: 'sent', outcome: type === 'undo' ? {} : { seq: ++seq } })),
    toast: vi.fn(),
    set: vi.fn((patch: Record<string, unknown>) => Object.assign(state, patch)),
    nextSelectEnd: vi.fn(() => (state.nextSelect = null)),
    nextSelectAll: vi.fn(),
    nextSelectStart: vi.fn(),
    nextSelectToggle: vi.fn(),
    nextOpen: vi.fn(),
    openReply: vi.fn(),
  };
  return store;
}
const labels = (items: Array<string | { label: string }>) => items.map((it) => (it === 'sep' ? '—' : (it as { label: string }).label));

describe('picking rows', () => {
  it('a tap flips one row; Shift picks the run from the last one tapped', () => {
    expect(toggleIds(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleIds(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleIds(['b'], 'd', { range: true, anchor: 'b', order: ['a', 'b', 'c', 'd', 'e'] })).toEqual(['b', 'c', 'd']);
    // Upward too, and without a row it knows: just a flip.
    expect(toggleIds([], 'a', { range: true, anchor: 'c', order: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
    expect(toggleIds([], 'x', { range: true, anchor: 'c', order: ['a', 'b', 'c'] })).toEqual(['x']);
  });
});

describe('acting on the selection', () => {
  it('counts cleared defaults separately and undoes every successful action', async () => {
    const items = [thread('t1'), thread('t2'), thread('t3'), thread('lead', { source: 'loom', facts: { role: 'default' } })];
    const store = storeWith(items);
    await bulkDone(store, items);
    const [text, opts] = store.toast.mock.calls[0];
    expect(text).toBe('Done · 3 threads · 1 cleared');
    expect(store.command.mock.calls.every((c) => c[0] === 'done')).toBe(true);
    await opts.action.fn();
    expect(store.command.mock.calls.filter((c) => c[0] === 'undo')).toHaveLength(4);
  });

  it('uses server clear outcomes when the role changed since selection', async () => {
    const items = [thread('t1')];
    const store = storeWith(items);
    store.command.mockResolvedValueOnce({ status: 'sent', outcome: { seq: 1, cleared: true } } as never);
    await bulkDone(store, items);
    expect(store.toast.mock.calls[0][0]).toBe('Done · 0 threads · 1 cleared');
  });

  it('Done goes to each thread that can be done, leaves a job running, and one Undo takes the batch back', async () => {
    const items = [thread('t1'), thread('t2', { facts: { job: { label: 'Nightly import' } } }), thread('loom', { nextStep: 'working' })];
    const store = storeWith(items);
    await bulkDone(store, items);
    expect(store.nextSelectEnd).toHaveBeenCalled();
    expect(store.command.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['done', 't1', {}],
      ['done', 't2', { stopJob: false }],
    ]);
    const [text, opts] = store.toast.mock.calls[0];
    expect(text).toBe('Done · 2 threads · 1 left as it was');
    store.command.mockClear();
    await opts.action.fn();
    expect(store.command.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['undo', { seq: 1 }],
      ['undo', { seq: 2 }],
    ]);
    expect(store.toast).toHaveBeenLastCalledWith('Undone');
  });

  it('a failed write-back is said, with Retry for just those', async () => {
    const items = [thread('t1'), thread('t2')];
    const store = storeWith(items);
    store.command.mockImplementation(async (_type: string, id: string) => ({ status: 'sent', outcome: { seq: 1, ...(id === 't2' ? { writeback: { outcome: 'failed' } } : {}) } }) as never);
    await bulkDone(store, items);
    const [text, opts] = store.toast.mock.calls[1];
    expect(text).toBe('Done here, but the write-back failed');
    expect(opts.sticky).toBe(true);
    store.command.mockClear();
    store.command.mockImplementation(async () => ({ status: 'sent', outcome: { seq: 2 } }) as never);
    await opts.action.fn();
    expect(store.command.mock.calls.map((c) => c[1])).toEqual(['t2']);
  });

  it('an undo that partly fails says so instead of Undone', async () => {
    const items = [thread('t1'), thread('t2')];
    const store = storeWith(items);
    await bulkDone(store, items);
    store.command.mockImplementationOnce(async () => ({ status: 'failed', error: 'gone' }) as never);
    await store.toast.mock.calls[0][1].action.fn();
    expect(store.toast).toHaveBeenLastCalledWith('Undo didn’t finish: 1 of 2 didn’t go back', { sticky: true });
  });

  it('a snoozed thread is acted on only while it is as shown', async () => {
    const items = [thread('t1', { disposition: 'snoozed', attentionUpdatedAt: NOW - 5 })];
    const store = storeWith(items);
    await bulkDone(store, items);
    expect(store.command).toHaveBeenCalledWith('done', 't1', { ifStateAt: NOW - 5 }, { quiet: true });
  });

  it('Move skips threads already there, and Undo puts each back where it was', async () => {
    const items = [thread('t1', { facts: { projectId: 'p1' } }), thread('t2'), thread('loom', { facts: { projectId: 'p2' } })];
    const store = storeWith(items);
    await bulkMove(store, items, 'p2');
    expect(store.command.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['t1', { projectId: 'p2' }],
      ['t2', { projectId: 'p2' }],
    ]);
    expect(store.toast.mock.calls[0][0]).toBe('Moved to Ferry trip · 2 threads · 1 left as it was');
    store.command.mockClear();
    await store.toast.mock.calls[0][1].action.fn();
    expect(store.command.mock.calls.filter((c) => c[0] === 'project').map((c) => [c[1], c[2]])).toEqual([
      ['t1', { projectId: 'p1' }],
      ['t2', { projectId: null }],
    ]);
  });

  it('bulk move Undo restores the original non-lead owner from the command outcome', async () => {
    const items = [thread('worker', { facts: { projectId: 'p1', role: 'worker', parentItemId: 'non-lead' } })];
    const store = storeWith(items);
    let owner = 'non-lead';
    store.command.mockImplementation(async (_type: string, _id: string, args: Record<string, unknown>) => {
      const previousParentItemId = owner;
      owner = String(args.parentItemId || (args.projectId === 'p2' ? 'new-lead' : 'old-lead'));
      return { status: 'sent', outcome: { parentItemId: owner, previousParentItemId } } as never;
    });
    await bulkMove(store, items, 'p2');
    expect(owner).toBe('new-lead');
    await store.toast.mock.calls[0][1].action.fn();
    expect(owner).toBe('non-lead');
  });

  it('Unpin restores the pins it took away', async () => {
    const items = [thread('t1', { facts: { pinned: true } }), thread('t2')];
    const store = storeWith(items);
    await bulkPin(store, items, false);
    expect(store.command).toHaveBeenCalledTimes(1);
    store.command.mockClear();
    await store.toast.mock.calls[0][1].action.fn();
    expect(store.command).toHaveBeenCalledWith('pin', 't1', { pinned: true }, { quiet: true });
  });

  it('a failure is counted, not hidden', async () => {
    const items = [thread('t1'), thread('t2')];
    const store = storeWith(items);
    store.command.mockImplementationOnce(async () => ({ status: 'failed', error: 'gone' }) as never);
    await bulkDone(store, items);
    expect(store.toast.mock.calls[0][0]).toBe('Done · 1 thread · 1 didn’t go through');
  });

  it('Mark read sends seen to each unread thread, so it moves from Needs you to Ready; Undo takes it back', async () => {
    const items = [thread('t1', { seen: 'new' }), thread('t2', { seen: 'updated' }), thread('loom', { seen: 'seen' }), thread('t4', { seen: 'new', disposition: 'snoozed', attentionUpdatedAt: NOW - 5 })];
    const store = storeWith(items);
    await bulkRead(store, items);
    // Wherever it is (a snoozed one too, which stays snoozed: the server's via 'read'); nothing goes to the source.
    expect(store.command.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['seen', 't1', { via: 'read' }],
      ['seen', 't2', { via: 'read' }],
      ['seen', 't4', { via: 'read', ifStateAt: NOW - 5 }],
    ]);
    const [text, opts] = store.toast.mock.calls[0];
    expect(text).toBe('Marked read · 3 threads · 1 left as it was');
    store.command.mockClear();
    await opts.action.fn();
    expect(store.command.mock.calls.map((c) => c[0])).toEqual(['undo', 'undo', 'undo']);
  });

  it('Mark unread goes to every read thread, done ones included', async () => {
    const items = [thread('t1', { seen: 'seen', disposition: 'done' }), thread('t2', { seen: 'new' }), thread('loom', { seen: 'seen', disposition: 'parked' })];
    const store = storeWith(items);
    await bulkUnread(store, items);
    expect(store.command.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['unseen', 't1'],
      ['unseen', 'loom'],
    ]);
    expect(store.toast.mock.calls[0][0]).toBe('Marked unread · 2 threads · 1 left as it was');
    store.toast.mockClear();
    await bulkUnread(store, [thread('t4', { seen: 'new' }), thread('t5', { seen: 'updated' })]);
    expect(store.toast.mock.calls[0][0]).toBe('All 2 already unread');
  });

  it('Mark read says which still need an answer: an open request stays Needs you', async () => {
    const items = [thread('t1', { seen: 'new', facts: { lastAuthor: 'agent' } }), thread('t2', { seen: 'new', status: { pill: 'needs', countsForOwner: true, audience: 'owner' }, facts: { pending: { kind: 'approval' } } })];
    const store = storeWith(items);
    await bulkRead(store, items);
    expect(store.toast.mock.calls[0][0]).toBe('Marked read · 2 threads · 1 still needs an answer');
  });

  it('nothing that can change says so instead of sending', async () => {
    const items = [thread('t1', { nextStep: 'working' })];
    const store = storeWith(items);
    await bulkDone(store, items);
    expect(store.command).not.toHaveBeenCalled();
    expect(store.toast.mock.calls[0][0]).toBe('Done: none of that one could change');
  });
});

describe('the bar and the menus', () => {
  it('the bar holds Done, Snooze, Park and Move; Back to Active takes Park’s place when all are away', () => {
    const active = storeWith([thread('t1'), thread('t2', { disposition: 'snoozed' })], { flags: { stageLabels: true } });
    expect(selectionActions(active).bar).toEqual(['read', 'done', 'snooze', 'park', 'move']);
    expect(labels(selectionActions(active).more)).toEqual(expect.arrayContaining(['Back to Active', 'Stage', 'Type', 'Pin']));
    // Stage leaves the menus while its flag is off.
    expect(labels(selectionActions(storeWith([thread('t1')])).more)).not.toContain('Stage');
    const away = storeWith([thread('t1', { disposition: 'snoozed' }), thread('t2', { disposition: 'parked' })]);
    expect(selectionActions(away).bar).toEqual(['read', 'done', 'snooze', 'pickup', 'move']);
  });

  it('Mark read leads the bar and Mark unread follows it in the menus, whatever is picked', () => {
    const store = storeWith([thread('t1', { seen: 'seen', disposition: 'done' })]);
    expect(selectionActions(store).bar[0]).toBe('read');
    expect(labels(selectionMenu(store)).slice(0, 2)).toEqual(['Mark read', 'Mark unread']);
  });

  it('projects get Wake only when one is away', () => {
    const store = storeWith([], { projects: [...projects, { id: 'p3', name: 'Old', color: 'slate', createdAt: 0, away: { kind: 'parked' } }], nextSelect: { kind: 'project', ids: ['p1'] } });
    expect(selectionActions(store).bar).toEqual(['snooze', 'park', 'finish']);
  });

  it('a right-click on a selected row acts on the whole selection; on another row it offers Select', () => {
    const store = storeWith([thread('t1'), thread('t2'), thread('loom')], { nextSelect: { kind: 'thread', ids: ['t1', 't2'] } });
    const menu = contextItems({ kind: 'thread', id: 't1' }, store);
    expect(menu.title).toBe('2 threads');
    expect(labels(menu.items).slice(0, 6)).toEqual(['Mark read', 'Mark unread', '—', 'Done', 'Snooze…', 'Park']);
    expect(labels(selectionMenu(store)).slice(-2)).toEqual(['Select all', 'Stop selecting']);
    const other = contextItems({ kind: 'thread', id: 'loom' }, store);
    expect(labels(other.items).slice(0, 2)).toEqual(['Open', 'Select']);
    other.items[1].onSelect();
    expect(store.nextSelectToggle).toHaveBeenCalledWith('loom');
  });

  it('Select on a project shows only on the Projects page, never from the sidebar', () => {
    const store = storeWith([], { nextSelect: null, nextRoute: { page: 'projects' } });
    expect(labels(contextItems({ kind: 'project', id: 'p1' }, store).items)).toContain('Select');
    expect(labels(contextItems({ kind: 'project', id: 'p1', fromSidebar: true }, store).items)).not.toContain('Select');
    store.state.nextRoute = { page: 'project', id: 'p1' };
    expect(labels(contextItems({ kind: 'project', id: 'p1' }, store).items)).not.toContain('Select');
  });
});

describe('a bulk action that partly fails', () => {
  it('offers Retry for just the threads that didn’t go through', async () => {
    const items = [thread('a'), thread('b')];
    const store = storeWith(items);
    let first = true;
    store.command = vi.fn(async (type: string, id: string) => (type === 'done' && id === 'b' && first ? ((first = false), { status: 'failed', error: 'the desk is restarting' }) : { status: 'sent', outcome: { seq: 1 } }));
    await bulkDone(store, items);
    const sticky = store.toast.mock.calls.map((c) => c[1]).find((o) => o?.sticky && o.actions?.[0]?.label === 'Retry');
    expect(sticky).toBeTruthy();
    await sticky.actions[0].fn();
    const doneIds = store.command.mock.calls.filter((c) => c[0] === 'done').map((c) => c[1]);
    expect(doneIds).toEqual(['a', 'b', 'b']);
  });
});

describe('a bulk Retry after a lost answer', () => {
  it('sends each one’s own command id again', async () => {
    const items = [thread('a')];
    const store = storeWith(items);
    let lose = true;
    store.command = vi.fn(async (_type: string, _id: string, _args: unknown, o: { commandId?: string } = {}) =>
      lose ? ((lose = false), { status: 'failed', error: 'network error', transport: true, commandId: 'cmd-1' }) : { status: 'sent', commandId: o.commandId, outcome: { seq: 2 } },
    );
    await bulkDone(store, items);
    const sticky = store.toast.mock.calls.map((c) => c[1]).find((o) => o?.sticky && o.actions?.[0]?.label === 'Retry');
    await sticky.actions[0].fn();
    expect(store.command.mock.calls[1][3]).toMatchObject({ commandId: 'cmd-1' });
  });
});

