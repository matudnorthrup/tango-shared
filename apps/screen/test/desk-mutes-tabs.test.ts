import { expect, it } from 'vitest';
import { viewsWithInboxTabs } from '../server/desk/projects.js';
import { briefing, listItems, nextUpQueue } from '../server/desk/view.js';
import { makeHarness } from './desk-harness.js';
import { deriveNextItems } from '../../tango-voice/src/live/desk-client.js';
// @ts-expect-error browser module
import { DEFAULT_VIEWS, currentView } from '../public/desk/list-views.js';
// @ts-expect-error browser module
import { inboxViews, threadsIn, ownMatch, tallyOf, rowOf } from '../public/desk/next/model.js';
// @ts-expect-error browser module
import { createStore } from '../public/desk/store.js';

const oldReady = { id: 'ready', name: 'Ready', status: ['active'], live: ['needs', 'ready', 'failed'], group: 'live', sort: 'asks', fold: true, showProjects: ['active'] };
const oldActive = { id: 'active', name: 'Active', status: ['active'], group: 'live', sort: 'recent', fold: true, showProjects: ['active'] };

it('splits untouched built-ins in place, preserves owner edits, and is idempotent', () => {
  const custom = { ...oldReady, name: 'My queue' };
  const result = viewsWithInboxTabs([custom, oldActive, oldReady]);
  expect(result).toMatchObject([custom, { id: 'needs', live: ['needs', 'failed'] }, { id: 'ready', live: ['ready'] }]);
  expect(viewsWithInboxTabs(result)).toBeNull();
  expect(viewsWithInboxTabs([{ ...oldActive, sort: 'asks' }, custom])).toBeNull();
  expect(viewsWithInboxTabs(DEFAULT_VIEWS)).toBeNull();
  expect(currentView(DEFAULT_VIEWS, 'active').id).toBe('active');
  // An owner's own tab already called `needs`: kept, and Ready is still narrowed (Codex review on #763).
  const mine = { id: 'needs', name: 'Mine', status: ['active'], live: ['needs'], group: 'none', sort: 'recent' };
  const split = viewsWithInboxTabs([mine, oldReady]);
  expect(split).toMatchObject([mine, { id: 'needs-2', name: 'Needs you', live: ['needs', 'failed'] }, { id: 'ready', live: ['ready'] }]);
  expect(viewsWithInboxTabs(split)).toBeNull();
  // Twenty tabs already: no room to split, so Ready stays as it was.
  const full = [oldReady, ...Array.from({ length: 19 }, (_, i) => ({ ...mine, id: `t${i}`, name: `T${i}` }))];
  expect(viewsWithInboxTabs(full)).toBeNull();
});

it('recognizes untouched legacy built-ins with retired grouping without changing saved inputs', () => {
  const saved = [{ ...oldActive, group: 'stage' }, { ...oldReady, group: 'stage' }];
  const original = JSON.stringify(saved);
  const migrated = viewsWithInboxTabs(saved);
  expect(migrated).toMatchObject([{ id: 'needs', live: ['needs', 'failed'] }, { id: 'ready', live: ['ready'] }]);
  expect(viewsWithInboxTabs(migrated)).toBeNull();
  expect(JSON.stringify(saved)).toBe(original);
});

it('marks startup migration once, preserving later owner changes', () => {
  const h = makeHarness();
  try {
    h.core.store.setSetting('list_views', JSON.stringify([oldActive, oldReady]));
    h.core.start();
    expect(h.core.store.setting('list_views_inbox_v1')).toBe('1');
    expect(JSON.parse(h.core.store.setting('list_views')!)[0].id).toBe('needs');
    h.core.store.setSetting('list_views', JSON.stringify([oldActive]));
    h.core.start();
    expect(JSON.parse(h.core.store.setting('list_views')!)).toEqual([oldActive]);
  } finally { h.close(); }
});

it('retains muted Active rows while Next up, owner counts, briefing, sweep and voice exclude them', () => {
  const h = makeHarness();
  try {
    h.core.ensureItem({ id: 'loom:muted', source: 'loom', kind: 'thread', conversationKey: 'loom:muted', agentId: 'loom', agentName: 'Loom', place: 'alpha · Test', area: 'alpha', createdAt: Date.now() }, 'agent');
    h.core.store.patchItem('loom:muted', { facts: { pending: { kind: 'question' } } } as any);
    h.core.store.setSetting('sweep_pending', JSON.stringify({ at: Date.now(), itemIds: ['loom:muted'] }));
    expect(nextUpQueue(h.core).map((i) => i.id)).toContain('loom:muted');
    h.core.store.setSetting('filters', JSON.stringify({ hideRepos: ['alpha'] }));
    const list = listItems(h.core);
    expect(list.items[0].filteredBy).toEqual([{ facet: 'repo', value: 'alpha' }]);
    expect(nextUpQueue(h.core)).toEqual([]);
    expect(list.counts.yourMove).toBe(0);
    expect(briefing(h.core).counts.yourMove).toBe(0);
    expect(briefing(h.core).counts.active).toBe(0);
    expect(list.sweep).toBeNull();
    expect(briefing(h.core).sweep).toBeNull();
    expect(deriveNextItems(list.items as any)).toEqual([]);
  } finally { h.close(); }
});

it('Inbox tabs exclude mutes while project membership and counts retain them', () => {
  const row = { id: 'a', source: 'loom', area: 'alpha', disposition: 'active', nextStep: 'your_move', seen: 'new', facts: { projectId: 'p' }, status: { pill: 'needs', countsForOwner: true, audience: 'owner', unread: true } };
  const state = { lists: { active: { items: [row] } }, projects: [{ id: 'p', name: 'Project' }], filters: { hideRepos: ['alpha'] } };
  expect(inboxViews(state).every((v: any) => v.items.length === 0)).toBe(true);
  const own = threadsIn(state.lists, ownMatch('project', 'p', state.projects));
  expect(own.open).toEqual([row]);
  expect(rowOf(row, { context: { kind: 'project', id: 'p' }, filters: state.filters }).facts).toContain('Muted');
  expect(rowOf(row, { filters: state.filters }).facts).not.toContain('Muted');
  expect(tallyOf(own.open).waiting).toBe(1);
  expect(inboxViews({ ...state, filters: {} })[0].items).toEqual([row]);
});

it('mute removal predicts immediately and rolls back with Retry on failed save', async () => {
  let reject!: (err: Error) => void;
  const store = createStore({ mode: 'fixtures', saveSettings: () => new Promise((_, no) => { reject = no; }) });
  store.set({ filters: { hideAgents: [], hideRepos: ['alpha'], hideTypes: [] } });
  const pending = store.toggleFilter('repo', 'alpha');
  expect(store.state.filters.hideRepos).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  reject(Object.assign(new Error('offline'), { body: { error: 'offline' } }));
  expect(await pending).toBe(false);
  expect(store.state.filters.hideRepos).toEqual(['alpha']);
  expect(store.state.toasts.at(-1).actions[0].label).toBe('Retry');
});

// @ts-expect-error browser module
import { MuteChips } from '../public/desk/next/pages.js';
// @ts-expect-error browser module
import { MutesPage } from '../public/desk/settings.js';
// @ts-expect-error browser module
import { filterHits } from '../public/desk/search-model.js';

function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}

it('renders removable named chips and Settings mute toggles with counts, including zero-row values', () => {
  const calls: unknown[] = [];
  const store = { state: { lists: { active: { items: [] } }, filters: { hideAgents: [], hideRepos: ['alpha'], hideTypes: ['bug'] } }, toggleFilter: (...args: unknown[]) => calls.push(args) };
  const chips = nodes(MuteChips({ store })).filter((n) => n.type === 'button');
  expect(chips.map((n) => n.props['aria-label'])).toEqual(['Unmute alpha']);
  chips[0].props.onClick();
  expect(calls).toEqual([['repo', 'alpha']]);
  const toggles = nodes(MutesPage({ store, head: null })).filter((n) => n.type === 'input');
  expect(toggles).toHaveLength(1);
  expect(toggles.every((n) => n.props.checked)).toBe(true);
  expect(nodes(MuteChips({ store: { ...store, state: { ...store.state, filters: {} } } }))).toEqual([]);
  const hit = { row: { id: 'a', disposition: 'active', status: { audience: 'owner' }, filteredBy: [{ facet: 'repo', value: 'alpha' }] } };
  expect(filterHits([hit])).toEqual([hit]);
});
