import { describe, expect, it } from 'vitest';
import { parseListViews } from '../server/desk/routes.js';
import { matches, viewToQuery } from '../public/desk/query.js';
// @ts-expect-error browser module
import { DEFAULT_VIEWS, normalizeView } from '../public/desk/list-views.js';
// @ts-expect-error browser module
import { NONE, FILTER_FACETS, applyFilter, facetLabel, filterOptions, filteredView, inboxViews, nextListReport } from '../public/desk/next/model.js';
// @ts-expect-error browser module
import { FilterChips, isPlainHistory, saveFilteredTab } from '../public/desk/next/pages.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

const projects = [{ id: 'p', name: 'Desk' }];
const row = (id: string, facts = {}, busy: string | null = null, seen = 'seen') => ({
  id, source: 'loom', agentId: 'loom', agentName: 'Loom', area: 'Repo', place: id,
  disposition: 'active', seen, facts, status: { pill: 'needs', countsForOwner: true, busy, audience: 'owner' },
});
const rows = [row('bug', { type: 'bug', projectId: 'p', pinned: true }, 'background', 'new'), row('feature', { type: 'feat', role: 'default' }, 'working'), row('idle'), row('other', { type: 'bug', agentSpace: { id: 'helper', name: 'Helper' } })];
const base = { id: 'all', name: 'All', status: ['active'], group: 'none', sort: 'recent', fold: false };
const state = { lists: { active: { loaded: true, items: rows }, history: { loaded: true, items: [] }, snoozed: { loaded: true, items: [] } }, projects, listViews: [base], nextRoute: { page: 'inbox', view: 'all' }, now: 1 };
const ids = (items: any[]) => items.map((i) => i.id).sort();

describe('Inbox filter facets', () => {
  it.each([
    ['busy', ['background'], ['bug']], ['busy', [NONE], ['idle', 'other']], ['busy', ['working', NONE], ['feature', 'idle', 'other']],
    ['unread', ['true'], ['bug']], ['unread', ['false'], ['feature', 'idle', 'other']],
    ['kind', ['default'], ['feature']], ['kind', ['thread'], ['bug', 'idle', 'other']],
    ['pinned', ['true'], ['bug']], ['pinned', ['false'], ['feature', 'idle', 'other']],
    ['space', ['project:p'], ['bug']], ['space', ['agent:helper'], ['other']], ['space', [NONE], ['feature', 'idle']],
  ])('%s %j uses the shared membership contract', (facet, values, expected) => {
    expect(ids(applyFilter(rows, { [facet as string]: values }, projects))).toEqual(expected);
  });
  it('conditions counts on other picks and retains zero-count picks', () => {
    expect(FILTER_FACETS.map(([key]: string[]) => key)).toEqual(expect.arrayContaining(['busy', 'unread', 'kind', 'pinned', 'space']));
    const options = filterOptions(rows, projects, { busy: ['background'], type: ['feat'] });
    expect(options.type).toBeUndefined(); // Type no longer appears in the filter menu.
    expect(options.busy).toEqual(expect.arrayContaining([{ value: 'working', label: 'Working', n: 1 }, { value: 'background', label: 'Background', n: 0 }]));
    expect(facetLabel('space', 'project:p', projects, rows)).toBe('Desk');
    expect(facetLabel('space', 'agent:helper', projects, rows)).toBe('Helper');
  });
  it('renders device chips that remove immediately and clear independently of mutes', () => {
    const calls: any[] = [];
    const store = { state: { ...state, nextFilter: { busy: ['background'], type: ['bug'] } }, nextSetFilter: (v: any) => calls.push(v) };
    const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' ? [v, ...nodes(v.props?.children)] : [];
    const buttons = nodes(FilterChips({ store, items: rows })).filter((n) => n.type === 'button');
    buttons.find((n) => n.props['aria-label'] === 'Remove Busy: Background').props.onClick();
    expect(calls[0]).toEqual({ busy: [], type: ['bug'] });
    buttons.at(-1).props.onClick();
    expect(calls[1]).toEqual({});
  });
});


describe('saved filter membership and validation', () => {
  it('can save from every built-in tab, including To-dos', () => {
    expect(parseListViews([...DEFAULT_VIEWS, filteredView(DEFAULT_VIEWS[2], { busy: ['background'] }, DEFAULT_VIEWS, 'Background to-dos')])).not.toHaveProperty('error');
  });
  it('adapts new arrays, retaining unknown values as narrowing constraints', () => {
    const view = normalizeView({ ...base, busy: ['background'], unread: ['true'], kind: ['thread'], pinned: ['true'] });
    expect(ids(rows.filter((r) => matches(r, viewToQuery(view), { projects })))).toEqual(['bug']);
    for (const key of ['busy', 'unread', 'kind', 'pinned']) {
      expect(parseListViews([{ ...base, [key]: ['unknown'] }])).toHaveProperty('error');
      expect(rows.filter((r) => matches(r, viewToQuery(normalizeView({ ...base, [key]: ['unknown'] })), { projects }))).toEqual([]);
      expect(parseListViews([{ ...base, where: { [key]: { in: ['unknown'] } } }])).toHaveProperty('error');
    }
    expect(parseListViews([{ ...base, where: { bogus: { in: ['x'] } } }])).toHaveProperty('error');
    expect(parseListViews([{ ...base, where: { busy: { unset: 'yes' } } }])).toHaveProperty('error');
  });
  it('preserves exactly the shown ids through save, server parsing, normalization and voice', () => {
    const views = [base, { ...base, type: ['bug'] }, { ...base, where: { disposition: { in: ['snoozed'] } } }, { ...base, stage: ['none'] }, { ...base, inProject: 'some' }, { ...base, inProject: 'none' }, { ...base, workspace: ['REPO'] }, { ...base, agent: ['Helper-CLASSIC'] }, { ...base, busy: ['working', 'none'] }, { ...base, where: { type: { not: ['bug'] }, busy: { unset: false } } }];
    const picks = [{ busy: ['background'], type: ['bug'] }, { type: ['feat'] }, { type: [NONE] }, { type: ['bug', NONE] }, { project: [NONE] }, { project: ['p', NONE] }, { busy: [NONE] }, { kind: ['thread'], pinned: ['true'], unread: ['true'], space: ['project:p'] }, { repo: ['repo'] }, { agent: ['helper'] }];
    for (const view of views) for (const filter of picks) {
      const before = inboxViews({ ...state, listViews: [view] }).find((v: any) => v.view.id === view.id).items;
      const expected = ids(applyFilter(before, filter, projects));
      const saved = filteredView(view, filter, [view], 'Bugs · Background');
      const parsed = parseListViews(JSON.parse(JSON.stringify([saved])));
      expect(parsed).not.toHaveProperty('error');
      if (!('views' in parsed) || !parsed.views) throw new Error('save rejected');
      const after = { ...state, listViews: parsed.views.map((v) => normalizeView(v)), nextRoute: { page: 'inbox', view: saved.id }, nextFilter: {} };
      expect(ids(inboxViews(after).find((v: any) => v.view.id === saved.id).items)).toEqual(expected);
      const report = nextListReport(after);
      expect(ids(report.rows)).toEqual(expected);
      expect(report.tabs.find((t: any) => t.id === saved.id).name).toBe('Bugs · Background');
      expect(ids(nextListReport({ ...state, listViews: [view], nextFilter: filter }).rows)).toEqual(expected);
    }
  });
});


it('saves shared tabs before clearing device picks and switching; failure and a newly full tab set preserve both', async () => {
  const calls: any[] = [];
  let fail: string | null = 'offline';
  const store = { state, saveListViews: async (views: any[]) => { calls.push(views); return fail; }, nextSetFilter: (filter: any) => calls.push(filter), nextGo: (route: any) => calls.push(route) };
  const draft = { view: base, filter: { busy: ['background'] } };
  expect(await saveFilteredTab(store, draft, 'Background')).toBe('offline');
  expect(calls).toHaveLength(1);
  fail = null;
  expect(await saveFilteredTab(store, draft, 'Background')).toBeNull();
  expect(calls[1]).toHaveLength(6);
  expect(calls[2]).toEqual({});
  expect(calls[3]).toEqual({ page: 'inbox', view: 'background' });
  store.state = { ...state, listViews: Array.from({ length: 20 }, (_, i) => ({ ...base, id: `tab-${i}` })) };
  expect(await saveFilteredTab(store, draft, 'Too many')).toContain('20-tab limit');
  expect(calls).toHaveLength(4);
});


it('keeps an empty saved filter empty instead of substituting completed work', () => {
  const done = { ...rows[0], id: 'done-bug', disposition: 'done', doneAt: Date.now() };
  const s = { ...state, now: Date.now(), lists: { ...state.lists, active: { loaded: true, items: [] }, history: { loaded: true, items: [done] } } };
  const filter = { repo: ['other-repo'] };
  expect(nextListReport({ ...s, nextFilter: filter }).rows).toEqual([]);
  const saved = filteredView(base, filter, [base], 'Bugs');
  const parsed = parseListViews([saved]);
  if (!('views' in parsed) || !parsed.views) throw new Error('save rejected');
  expect(nextListReport({ ...s, nextFilter: {}, nextRoute: { page: 'inbox', view: saved.id }, listViews: parsed.views }).rows).toEqual([]);
});

describe('quick view edits', () => {
  it("keep each other: an echo of an earlier save can't put back the views before a newer one", async () => {
    const answers: Array<(value: unknown) => void> = [];
    const store = createStore({ saveSettings: () => new Promise((resolve) => answers.push(resolve)) });
    const a = [{ id: 'all', name: 'All', status: ['active'], group: 'none', sort: 'recent', where: { kind: { in: ['default'] } } }];
    const b = [{ ...a[0], where: { kind: { in: ['default'] }, pinned: { in: ['true'] } } }];
    const first = store.saveListViews(a);
    const second = store.saveListViews(b);
    // The first save's broadcast arrives while the second is on its way.
    store.handlers.onSettings({ listViews: a });
    expect(store.state.listViews).toEqual(b);
    answers[0]!({ listViews: a });
    await first;
    await Promise.resolve();
    answers[1]?.({ listViews: b });
    await second;
    expect(store.state.listViews).toEqual(b);
    // With nothing on its way, another screen's views show.
    store.handlers.onSettings({ listViews: a });
    expect(store.state.listViews).toEqual(a);
  });
});

describe('the shelf’s History link', () => {
  it('opens only a History tab with no other filter (Codex review on #794)', () => {
    const history = DEFAULT_VIEWS.find((v: any) => v.id === 'done');
    expect(isPlainHistory(history)).toBe(true);
    expect(isPlainHistory({ ...history, where: { type: { in: ['bug'] } } })).toBe(false);
    expect(isPlainHistory({ ...history, type: ['bug'] })).toBe(false);
    expect(isPlainHistory(DEFAULT_VIEWS[0])).toBe(false);
  });
});
