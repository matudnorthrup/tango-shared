import { describe, expect, it, vi } from 'vitest';
import { deskStatus } from '../server/desk/status.js';
// @ts-expect-error plain browser module, no types
import { DEFAULT_VIEWS } from '../public/desk/list-views.js';
// @ts-expect-error plain browser module, no types
import { blankSearch, createSearchActions, searchOptions, filterHits, firstMessage, hitFacets, hitStatus, markParts, sortHits } from '../public/desk/search-model.js';
// @ts-expect-error plain browser module, no types
import { highlight } from '../public/desk/search.js';

// Desk search in the browser (TGO-958): results filter through the owner's views like List rows,
// snippets mark their words, and typing searches once it pauses.

const row = (id: string, extra: Record<string, unknown> = {}) => { const item = { id, source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Loom', place: `tango · ${id}`, area: 'tango', facts: { project: { name: 'tango' } }, disposition: 'active', lastActivityAt: 0, ...extra }; return { ...item, status: deskStatus(item as never) }; };
const hit = (id: string, extra: Record<string, unknown> = {}, matches: unknown[] = []) => ({ itemId: id, score: 1, matchCount: 0, matches, row: row(id, extra) });
const view = (id: string) => DEFAULT_VIEWS.find((v: { id: string }) => v.id === id);

describe('markParts', () => {
  it('splits a snippet into marked and plain runs', () => {
    expect(markParts('…the \u0002router\u0003 was \u0002fine\u0003')).toEqual([
      { text: '…the ', mark: false },
      { text: 'router', mark: true },
      { text: ' was ', mark: false },
      { text: 'fine', mark: true },
    ]);
    expect(markParts('')).toEqual([]);
  });
});

describe('filtering results', () => {
  const hits = [
    hit('working', { facts: { running: { since: 1 }, project: { name: 'tango' } } }),
    hit('snoozed', { disposition: 'snoozed' }),
    hit('old', { disposition: 'done', archived: true, area: 'acme', place: 'acme · old', facts: { project: { name: 'acme' } } }),
    { ...hit('chat'), row: { ...row('chat'), source: 'discord', agentId: 'sierra-ollama', agentName: 'Sierra', facts: {} } },
  ];

  it("keeps what each of the owner's views keeps: a result the desk let go reads as done", () => {
    expect(filterHits(hits, { view: { id: 'running', name: 'Running', status: ['active'], live: ['working'] } }).map((h: { itemId: string }) => h.itemId)).toEqual(['working']);
    expect(filterHits(hits, { view: view('later') }).map((h: { itemId: string }) => h.itemId)).toEqual(['snoozed']);
    expect(filterHits(hits, { view: view('done') }).map((h: { itemId: string }) => h.itemId)).toEqual(['old']);
  });

  it('narrows by project (Loom only) and by agent (any variant of it)', () => {
    expect(filterHits(hits, { project: 'acme' }).map((h: { itemId: string }) => h.itemId)).toEqual(['old']);
    expect(filterHits(hits, { agent: 'sierra' }).map((h: { itemId: string }) => h.itemId)).toEqual(['chat']);
  });

  it('offers the projects and agents among the results, most first', () => {
    expect(hitFacets(hits)).toEqual({ projects: [{ name: 'tango', count: 2 }, { name: 'acme', count: 1 }], agents: [{ id: 'sierra', name: 'Sierra', count: 1 }] });
  });

  it('sorts newest first on request, else keeps the ranking', () => {
    const a = hit('a', { lastActivityAt: 1 });
    const b = hit('b', { lastActivityAt: 2 });
    expect(sortHits([a, b], 'best')).toEqual([a, b]);
    expect(sortHits([a, b], 'recent')).toEqual([b, a]);
  });

  it('says where a result stands', () => {
    expect(hitStatus(row('x', { archived: true, disposition: 'done' }))).toBe('archived');
    expect(hitStatus(row('x', { disposition: 'parked' }))).toBe('parked');
    expect(hitStatus(row('x', { facts: { pending: { kind: 'question' } } }))).toBe('needs you');
  });

  it("opens a transcript at the first matched message, not the title's line", () => {
    expect(firstMessage(hit('x', {}, [{ how: 'title', snippet: 't', messageId: null }, { how: 'keyword', snippet: 's', messageId: 'm2' }]))).toBe('m2');
  });
});

describe('highlight', () => {
  it('marks the words, any form of them, outside tags only', () => {
    expect(highlight('<p>It keeps a <a href="/router">router</a> close</p>', 'keeps router')).toBe('<p>It <mark>keeps</mark> a <a href="/router"><mark>router</mark></a> close</p>');
    expect(highlight('<p>keep it</p>', 'keeps')).toBe('<p><mark>keep</mark> it</p>');
    expect(highlight('<p>speaker</p>', '-speaker')).toBe('<p>speaker</p>');
  });
});

describe('search actions', () => {
  it('searches once typing pauses, and drops an answer for words since replaced', async () => {
    vi.useFakeTimers();
    try {
      let state: Record<string, unknown> = { search: blankSearch(), presentation: { view: 'active' } };
      const answers: Record<string, (value: unknown) => void> = {};
      const client = { search: vi.fn((q: string) => new Promise((resolve) => (answers[q] = resolve))) };
      const actions = createSearchActions({ client, get: () => state, set: (patch: Record<string, unknown>) => (state = { ...state, ...patch }), openItem: vi.fn(), goHome: vi.fn() });
      actions.setSearchQuery('rou');
      actions.setSearchQuery('router');
      await vi.advanceTimersByTimeAsync(200);
      expect(client.search).toHaveBeenCalledTimes(1);
      expect(client.search).toHaveBeenCalledWith('router', { limit: 150, where: {}, audience: 'all', scope: 'global', include: 'open' });
      // The old answer lands during the new words' pause: it never shows under them.
      actions.setSearchQuery('router x');
      answers.router!({ hits: [hit('stale')], semantic: true });
      await vi.advanceTimersByTimeAsync(0);
      expect((state.search as { hits: unknown[] }).hits).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      answers['router x']!({ hits: [hit('fresh')], semantic: false });
      await vi.advanceTimersByTimeAsync(0);
      const search = state.search as { hits: Array<{ itemId: string }>; searched: string };
      expect(search.hits.map((h) => h.itemId)).toEqual(['fresh']);
      expect(search.searched).toBe('router x');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends saved view and picker facets to the server and reruns when picks change', async () => {
    let state: any = { listViews: [{ id: 'running', name: 'Running', status: ['active'], live: ['working'] }], search: { ...blankSearch(), query: 'router', tab: 'running', project: 'desk', repo: 'tango', agent: 'sierra', scope: 'space:project:desk' } };
    expect(searchOptions(state)).toMatchObject({ audience: 'owner', scope: 'space:project:desk', where: { project: { in: ['desk'] }, workspace: { in: ['tango'] }, agent: { in: ['sierra'] }, live: { in: ['working'] } } });
    expect(searchOptions({ search: { ...blankSearch(), tab: 'unfiled', project: 'desk' }, listViews: [{ id: 'unfiled', name: 'Unfiled', inProject: 'none' }] }).where.project).toEqual({ in: ['desk'], not: ['desk'] });
    const client = { search: vi.fn(async () => ({ hits: [], total: 24, more: true, tokens: [{ field: 'is', value: 'working' }] })) };
    const actions = createSearchActions({ client, get: () => state, set: (patch: any) => { state = { ...state, ...patch }; }, openItem: vi.fn(), goHome: vi.fn() });
    await actions.setSearchOption({ repo: 'loom' });
    expect(client.search).toHaveBeenCalledWith('router', expect.objectContaining({ where: expect.objectContaining({ workspace: { in: ['loom'] } }) }));
    expect(state.search).toMatchObject({ total: 24, more: true, tokens: [{ field: 'is', value: 'working' }] });
  });

  it('opens a live result on the desk, and one the desk let go as its transcript', () => {
    let state: Record<string, unknown> = { search: { ...blankSearch(), open: true }, transcript: null };
    const openItem = vi.fn();
    const client = { transcript: vi.fn(() => new Promise(() => {})) };
    const actions = createSearchActions({ client, get: () => state, set: (patch: Record<string, unknown>) => (state = { ...state, ...patch }), openItem, goHome: vi.fn() });
    actions.openHit(hit('live'));
    expect(openItem).toHaveBeenCalledWith('live');
    actions.openHit(hit('gone', { archived: true, disposition: 'done' }, [{ how: 'keyword', snippet: 's', messageId: 'm9' }]));
    expect(client.transcript).toHaveBeenCalledWith('gone', { around: 'm9' });
    expect(state.transcript).toMatchObject({ itemId: 'gone', around: 'm9', loading: true });
    expect((state.search as { open: boolean }).open).toBe(false);
  });
});
