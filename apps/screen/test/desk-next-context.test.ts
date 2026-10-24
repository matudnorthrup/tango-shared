import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module, no types
import { contextItems } from '../public/desk/next/context.js';

// The next layout's right-click menus: what each subject's menu holds. Invented names only.

const NOW = 1_790_000_000_000;
const thread = { id: 't1', source: 'discord', kind: 'thread', agentId: 'sierra', agentName: 'Sierra', place: 'Saturday ferry', facts: {}, disposition: 'active', lastActivityAt: NOW - 60_000, summary: { title: 'Saturday ferry' } };
const projects = [
  { id: 'p1', name: 'Desk reliability', color: 'violet', createdAt: 0 },
  { id: 'p2', name: 'Old move', color: 'slate', createdAt: 0, finishedAt: NOW - 1000 },
];

function storeWith(over: Record<string, unknown> = {}) {
  const state = {
    now: NOW,
    projects,
    lists: { active: { items: [thread], loaded: true }, snoozed: { items: [], loaded: true }, history: { items: [], loaded: true } },
    byId: { t1: thread } as Record<string, unknown>,
    presentation: { view: 'active', itemId: null },
    listViews: null,
    ...over,
  };
  return {
    state,
    threadOpen: () => state.presentation.view !== 'active' && !!state.presentation.itemId,
    nextOpen: vi.fn(),
    nextGo: vi.fn(),
    openReply: vi.fn(),
    openStartWork: vi.fn(),
    openSettings: vi.fn(),
    set: vi.fn(),
  };
}
const labels = (items: Array<string | { label: string }>) => items.map((it) => (it === 'sep' ? '—' : (it as { label: string }).label));

describe('right-click menus', () => {
  it('a thread row gets Open, then the thread ⋯ menu', () => {
    const store = storeWith({ flags: { stageLabels: true } });
    const menu = contextItems({ kind: 'thread', id: 't1' }, store);
    expect(labels(menu.items).slice(0, 5)).toEqual(['Open', 'Select', '—', 'Reply', '—']);
    expect(labels(menu.items)).toEqual(expect.arrayContaining(['Snooze…', 'Park', 'Done', 'Move to project', 'Stage', 'Pin', 'Rename…']));
    expect(labels(menu.items)).not.toContain('Type');
    menu.items.find((it: { label?: string }) => it !== 'sep' && it.label === 'Reply').onSelect();
    expect(store.nextOpen).toHaveBeenCalledWith('t1');
    expect(store.openReply).toHaveBeenCalledWith('t1');
  });

  it('a thread row changes its stage from the Stage flyout', () => {
    const store = { ...storeWith({ flags: { stageLabels: true } }), setTags: vi.fn() };
    const menu = contextItems({ kind: 'thread', id: 't1' }, store);
    const stage = menu.items.find((it: { label?: string }) => it !== 'sep' && it.label === 'Stage');
    expect(labels(stage.sub).at(-1)).toBe('No stage');
    stage.sub[0].onSelect();
    expect(store.setTags).toHaveBeenCalledWith('t1', { stage: expect.any(String) });
    stage.sub.at(-1).onSelect();
    expect(store.setTags).toHaveBeenLastCalledWith('t1', { stage: null });
  });

  it('a thread row has no Stage while the stage labels flag is off', () => {
    expect(labels(contextItems({ kind: 'thread', id: 't1' }, storeWith()).items)).not.toContain('Stage');
  });

  it("the open thread's title leaves out Open, and Reply stays put", () => {
    const store = storeWith({ presentation: { view: 'conversation', itemId: 't1' } });
    const menu = contextItems({ kind: 'thread', id: 't1' }, store);
    expect(labels(menu.items)[0]).toBe('Reply');
    menu.items[0].onSelect();
    expect(store.nextOpen).not.toHaveBeenCalled();
    expect(store.openReply).toHaveBeenCalledWith('t1');
  });

  it('a project gets Open project and New thread in it, then its ⋯; a finished one has no New thread', () => {
    const store = storeWith();
    const menu = contextItems({ kind: 'project', id: 'p1' }, store);
    expect(labels(menu.items).slice(0, 4)).toEqual(['Open project', 'New thread in Desk reliability…', '—', 'Edit project…']);
    menu.items[1].onSelect();
    expect(store.openStartWork).toHaveBeenCalledWith({ projectId: 'p1' });
    const done = contextItems({ kind: 'project', id: 'p2' }, store);
    expect(labels(done.items)).not.toContain('New thread in Old move…');
    expect(labels(done.items)).toContain('Reopen project');
  });

  it('an agent gets Open and New thread, then its ⋯', () => {
    const menu = contextItems({ kind: 'agent', id: 'sierra' }, storeWith());
    expect(labels(menu.items)).toEqual(['Open Sierra', 'New thread with Sierra…', '—', 'Icon and color…', 'Edit views…', 'Space settings']);
  });

  it('a subject that is gone has no menu', () => {
    const store = storeWith();
    expect(contextItems({ kind: 'thread', id: 'nope' }, store)).toBeNull();
    expect(contextItems({ kind: 'project', id: 'nope' }, store)).toBeNull();
    expect(contextItems({ kind: 'view', id: 'nope' }, store)).toBeNull();
  });
});
