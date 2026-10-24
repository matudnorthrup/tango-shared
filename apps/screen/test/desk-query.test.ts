import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matches as serverMatches, countFor as serverCount, type DeskQuery } from '../server/desk/query.js';
import { matches, facetCounts, countFor, facets, viewToQuery, openOnly } from '../public/desk/query.js';
import { filterMatches as serverHidden, itemRepo as serverRepo } from '../server/desk/filters.js';
// @ts-expect-error plain browser module, no types
import { filterMatches as browserHidden, itemRepo as browserRepo } from '../public/desk/filters.js';
// @ts-expect-error plain browser module, no types
import { DEFAULT_VIEWS, matchesView, normalizeView, viewItems } from '../public/desk/list-views.js';
// @ts-expect-error plain browser module, no types
import { applyFilter, filterOptions, inboxViews, nextListReport, reconcileSelection, spaceViews } from '../public/desk/next/model.js';
// @ts-expect-error browser module
import { overviewEmpty } from '../public/desk/next/pages.js';
// @ts-expect-error plain browser module, no types
import { filterHits, hitFacets } from '../public/desk/search-model.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// Synthetic fixture crosses the wire in both directions: server query entry point, saved tabs,
// Inbox rows/counts, local facets and search must keep exactly the same ids (TGO-1068).
const projects = [{ id: 'p1', name: 'First' }, { id: 'p2', name: 'Child', parent: 'project:p1' }];
const row = (id: string, patch: Record<string, any> = {}) => ({
  id, source: 'discord', agentId: 'Sierra-OLLAMA', agentName: 'Sierra', kind: 'thread',
  disposition: 'active', seen: 'seen', place: id, lastActivityAt: 1,
  facts: {}, status: { pill: 'working', busy: 'working', audience: 'owner' }, ...patch,
});
const rows = [
  ...['needs', 'working', 'waiting', 'failed', 'idle', 'unknown'].map((live) => row(live, { seen: live === 'needs' ? 'new' : 'seen', status: { pill: live, countsForOwner: ['needs', 'failed'].includes(live), busy: live === 'working' ? 'working' : null, audience: 'owner' } })),
  ...['snoozed', 'parked', 'done'].map((disposition) => row(disposition, { disposition })),
  row('default', { facts: { role: 'default', projectId: 'p1', stage: 'building', type: 'bug', pinned: true } }),
  row('job', { facts: { role: 'ops', projectId: 'p1' }, status: { pill: 'working', busy: 'background', audience: 'owner' } }),
  row('worker-with-lead', { facts: { role: 'worker', parentItemId: 'default', projectId: 'p2' }, status: { pill: 'failed', countsForOwner: false, busy: null, audience: 'lead' } }),
  row('orphan-worker', { facts: { role: 'worker' }, seen: 'new', status: { pill: 'needs', countsForOwner: true, busy: null, audience: 'owner' } }),
  row('override', { source: 'loom', agentId: 'loom', area: 'old-repo', place: 'old-repo · fix', facts: { agentSpace: { id: 'Compass-CLASSIC', name: 'Compass' }, project: { name: 'New-repo' }, projectId: 'missing' } }),
  row('busy-ask', { seen: 'new', status: { pill: 'needs', countsForOwner: true, busy: 'background', audience: 'owner' } }),
  row('clone-test', { agentId: 'sierra-test' }),
  row('clone-classic', { agentId: 'SIERRA-CLASSIC' }),
  row('no-persona', { source: 'loom', agentId: 'loom', area: 'New-repo' }),
];
const lists = {
  active: { loaded: true, items: rows.filter((r) => r.disposition === 'active') },
  snoozed: { loaded: true, items: rows.filter((r) => ['snoozed', 'parked'].includes(r.disposition)) },
  history: { loaded: true, items: rows.filter((r) => r.disposition === 'done') },
};
const state = { projects, lists, byId: Object.fromEntries(rows.map((r) => [r.id, r])), nextRoute: { page: 'inbox' }, listViews: DEFAULT_VIEWS, now: 1 };
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();
const query = (where: DeskQuery['where'] = {}): DeskQuery => ({ scope: { kind: 'global' }, audience: 'all', where });

describe('openOnly (search\'s default)', () => {
  it('adds open dispositions unless the query already picks some', () => {
    const base = { scope: { kind: 'global' as const }, audience: 'all' as const, where: { agent: { in: ['sierra'] } } };
    const open = openOnly(base)!;
    expect(open.where).toEqual({ agent: { in: ['sierra'] }, disposition: { in: ['active', 'snoozed', 'parked'] } });
    for (const disposition of ['active', 'snoozed', 'parked']) expect(matches({ disposition, agentId: 'sierra' }, open)).toBe(true);
    expect(matches({ disposition: 'done', agentId: 'sierra' }, open)).toBe(false);
    expect(openOnly({ ...base, where: { disposition: { in: ['done'] } } })).toBeNull();
  });
});

describe('one Desk query contract', () => {
  it.each(DEFAULT_VIEWS)('server, saved rows, Inbox counts and search agree for $id', (view: any) => {
    const q = viewToQuery(view, { audience: 'owner' });
    const expected = ids(rows.filter((r) => serverMatches(r, q, { projects, now: 1 })));
    const inbox = inboxViews(state).find((v: any) => v.view.id === view.id);
    expect(ids(inbox.items)).toEqual(expected);
    expect(serverCount(rows, q, { projects, now: 1 })).toBe(inbox.items.length);
    expect(ids(rows.filter((r) => matches(r, q, { projects, now: 1 })))).toEqual(expected);
    expect(ids(viewItems(lists, view, projects).filter((r: any) => matches(r, query(), { projects }) && r.status.audience === 'owner'))).toEqual(expected);
    expect(ids(filterHits(rows.map((r) => ({ row: r })), { view, projects }).map((h: any) => h.row))).toEqual(expected);
    expect(ids(nextListReport({ ...state, nextRoute: { page: 'inbox', view: view.id } }).rows)).toEqual(expected);
    expect(nextListReport({ ...state, nextRoute: { page: 'inbox', view: view.id } }).tabs.find((v: any) => v.id === view.id).count).toBe(inbox.items.length);
  });

  it('keeps compound sets equal, including unset, exclusion, busy, hierarchy and reports-to', () => {
    const queries = [query({ agent: { in: ['sierra'] }, disposition: { not: ['done'] } }), query({ project: { unset: true }, repo: { in: ['NEW-REPO'] } }), query({ live: { in: ['working'] }, busy: { in: ['background'] } }), query({ pinned: { in: ['true'] }, type: { in: ['bug'] } }), query({ parent: { in: ['default'] }, kind: { in: ['worker'] } }), query({ unread: { in: ['true'] }, live: { in: ['needs'] } }), { ...query(), scope: { kind: 'space' as const, id: 'project:p1', descendants: true } }];
    for (const q of queries) {
      const expected = ids(rows.filter((r) => serverMatches(r, q, { projects, now: 1 })));
      expect(ids(rows.filter((r) => matches(r, q, { projects, now: 1 })))).toEqual(expected);
      expect(countFor(rows, q, { projects, now: 1 })).toBe(expected.length);
    }
    expect(ids(rows.filter((r) => matches(r, queries[6]!, { projects })))).toEqual(['default', 'job', 'worker-with-lead']);
    expect(matches(rows.find((r) => r.id === 'busy-ask')!, query({ live: { in: ['working'] } }))).toBe(false);
  });

  it('uses one persona, including agent-space overrides, across hides, tabs, picks and search', () => {
    for (const [id, persona] of [['override', 'compass'], ['clone-test', 'sierra'], ['clone-classic', 'sierra']]) {
      const item = rows.find((r) => r.id === id)!;
      const filters = { hideAgents: [persona], hideRepos: [], hideTypes: [] };
      expect(serverHidden(item as any, filters)).toEqual([{ facet: 'agent', value: persona }]);
      expect(browserHidden(item, filters)).toEqual(serverHidden(item as any, filters));
      expect(matchesView(item, { agent: [persona] }, projects)).toBe(true);
      expect(applyFilter([item], { agent: [persona] }, projects)).toEqual([item]);
      expect(filterHits([{ row: item }], { agent: persona, projects })).toHaveLength(1);
    }
    expect(hitFacets([{ row: rows.find((r) => r.id === 'override') }]).agents[0].id).toBe('compass');
    expect(facets.agent!(rows.find((r) => r.id === 'no-persona')!)).toBe('loom');
  });

  it('resolves the same repo on browser and server, with metadata, area and title fallbacks', () => {
    for (const item of [rows.find((r) => r.id === 'override')!, row('area', { source: 'loom', area: 'Repo' }), row('title', { source: 'loom', place: 'Repo · title' })]) {
      expect(serverRepo(item)).toBe(browserRepo(item));
      const filters = { hideAgents: [], hideRepos: [String(serverRepo(item)).toUpperCase()], hideTypes: [] };
      expect(serverHidden(item as any, filters)).toEqual(browserHidden(item, filters));
      expect(serverHidden(item as any, filters)).toHaveLength(1);
    }
    expect(serverRepo(rows.find((r) => r.id === 'override')!)).toBe('New-repo');
  });

  it('conditions facet counts on every other facet, including None and zero-count picks', () => {
    const items = [row('a', { facts: { type: 'bug', stage: 'building' } }), row('b', { facts: { type: 'feat', stage: 'building' } }), row('c', { facts: { type: 'feat' } })];
    expect([...facetCounts(items, query({ type: { in: ['bug'] }, stage: { in: ['building'] } }), 'type')]).toEqual([['bug', 1], ['feat', 1]]);
    expect([...facetCounts(items, query({ type: { in: ['feat'] } }), 'stage')]).toEqual([['building', 1], [null, 1]]);
    expect(filterOptions(items, [], { type: ['feat'] }).stage.map((v: any) => v.n)).toEqual([1, 1]);
  });

  it('converts saved JSON without mutation and treats stale project ids as unset', () => {
    const view = normalizeView({ id: 'v', name: 'V', status: ['active'], stage: ['none', 'building'], fold: true, showProjects: ['active'] });
    const before = JSON.stringify(view);
    expect(matches(rows.find((r) => r.id === 'override')!, viewToQuery(view), { projects })).toBe(true);
    expect(matches(rows.find((r) => r.id === 'override')!, query({ project: { unset: true } }), { projects })).toBe(true);
    expect(matches(rows[0]!, viewToQuery({ inProject: 'some' }), { projects })).toBe(false);
    expect(matches(rows[0]!, viewToQuery({ inProject: 'none', projects: ['p1'] }), { projects })).toBe(false);
    expect(JSON.stringify(view)).toBe(before);
  });

  it('keeps each space kind tab equal to its query', () => {
    for (const view of spaceViews(lists.active.items, lists.history.items)) {
      const kinds: Record<string, object> = { overview: { kind: { not: ['worker'] } }, threads: { kind: { in: ['thread', 'default'] } }, workers: { kind: { in: ['worker'] } }, jobs: { kind: { in: ['job'] } } };
      const source = view.id === 'done' ? lists.history.items : lists.active.items;
      expect(ids(view.items)).toEqual(ids(source.filter((i) => matches(i, query(kinds[view.id] ?? {})))));
    }
  });

  it('leaves workers off a space Overview; they keep their own tab (owner, 10/19)', () => {
    const lead = row('lead', { facts: { role: 'default' } });
    const thread = row('thread', {});
    const worker = row('worker', { facts: { role: 'worker', parentItemId: 'lead' } });
    const views = spaceViews([lead, thread, worker], []);
    expect(ids(views.find((v: any) => v.id === 'overview').items)).toEqual(['lead', 'thread']);
    expect(ids(views.find((v: any) => v.id === 'workers').items)).toEqual(['worker']);
    // Only a worker here: Overview's empty line points at the Workers tab (Codex review on #776).
    expect(overviewEmpty(spaceViews([worker], []), 'Nothing yet.')).toBe("Nothing you're working on here. See Workers.");
    expect(overviewEmpty(spaceViews([], []), 'Nothing yet.')).toBe('Nothing yet.');
  });

  it('isolates project collapse keys and drops hidden selections after narrowing or changing views', () => {
    const first = row('first', { facts: { projectId: 'p1', type: 'bug' } });
    const second = row('second', { facts: { projectId: 'p2', type: 'feat' } });
    const s = { ...state, lists: { ...lists, active: { items: [first, second] } }, nextRoute: { page: 'project', id: 'p1' }, listCollapsed: ['project:p1:overview|working'] };
    expect(nextListReport(s).rows).toEqual([]);
    expect(nextListReport({ ...s, nextRoute: { page: 'project', id: 'p2' } }).rows.map((r: any) => r.id)).toEqual(['second']);
    const selection = { kind: 'thread', ids: ['first', 'second'], anchor: 'second' };
    const narrowed = { ...s, nextRoute: { page: 'inbox', view: 'active' }, nextFilter: { type: ['bug'] }, nextSelect: selection };
    expect(reconcileSelection(narrowed)).toEqual({ ...selection, ids: ['first'], anchor: null });
    expect(reconcileSelection({ ...s, nextSelect: selection, listCollapsed: [], nextPageViews: { 'project:p1': 'jobs' } }).ids).toEqual(['first']);
  });

  it('reconciles the real store selection before bulk actions can read it', () => {
    const store = createStore({ mode: 'fixtures' });
    store.set({ ...state, nextRoute: { page: 'inbox', view: 'active' }, nextSelect: { kind: 'thread', ids: ['default', 'clone-test'], anchor: 'clone-test' } });
    store.set({ nextFilter: { type: ['bug'] } });
    expect(store.state.nextSelect.ids).toEqual(['default']);
    expect(store.state.nextSelect.anchor).toBeNull();
    store.set({ nextRoute: { page: 'inbox', view: 'done' } });
    expect(store.state.nextSelect.ids).toEqual([]);
    store.set({ nextFilter: {}, nextRoute: { page: 'project', id: 'p1' }, nextSelect: { kind: 'thread', ids: ['default', 'job'], anchor: 'default' } });
    store.set({ nextPageViews: { 'project:p1': 'jobs' } });
    expect(store.state.nextSelect.ids).toEqual(['job']);
  });

  it('removes ineffective folder controls while still reading their saved fields', () => {
    const source = readFileSync(new URL('../public/desk/views-editor.js', import.meta.url), 'utf8');
    expect(source).not.toContain('Fold into folders');
    expect(source).not.toContain('Always show projects');
    expect(normalizeView({ id: 'v', name: 'V', fold: true, showProjects: ['active'] })).toMatchObject({ fold: true, showProjects: ['active'] });
  });
});

describe('the server list grouped by agent', () => {
  it('labels an agent-space section by the space, not the coding source (Codex review on #759)', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const { listItems } = await import('../server/desk/view.js');
    const h = makeHarness();
    h.core.ensureItem({ id: 'loom:m', source: 'loom', kind: 'thread', conversationKey: 'loom:m', agentId: 'loom', agentName: 'Loom', place: 'acme · Compass', createdAt: 1 }, 'agent');
    await h.core.command({ commandId: 'space-m', type: 'space', itemId: 'loom:m', args: { agent: { id: 'compass', name: 'Compass' } } } as never);
    const section = listItems(h.core, { group: 'agent' }).sections.find((s) => s.itemIds.includes('loom:m'));
    expect(section).toMatchObject({ key: 'compass', label: 'Compass' });
  });
});
