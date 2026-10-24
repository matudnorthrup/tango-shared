import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSpaceViews, readSpaceViews } from '../server/desk/space-views.js';
import { parseSpaces } from '../server/desk/spaces.js';
// @ts-expect-error browser module
import { SPACE_VIEWS, spaceViewDefs, spaceViews, spaceGroups, pageView, nextListReport } from '../public/desk/next/model.js';
// @ts-expect-error browser module
import { putSpaceFacet } from '../public/desk/views-editor.js';
// @ts-expect-error browser module
import { createStore } from '../public/desk/store.js';
// @ts-expect-error browser module
import { contextItems } from '../public/desk/next/context.js';
const view = { id: 'here', name: 'Needs you here', where: { live: { in: ['needs', 'failed'] } }, group: 'none', sort: 'asks' };
const item = (id: string, move = 'needs', role = 'interactive') => ({ id, source: 'loom', kind: 'thread', disposition: 'active', seen: move === 'needs' ? 'new' : 'seen', place: id, status: { pill: move, countsForOwner: ['needs', 'failed'].includes(move), busy: null, audience: 'owner' }, facts: { role, projectId: 'p', lastAuthor: 'agent' }, lastActivityAt: 100 });
afterEach(() => vi.unstubAllGlobals());
describe('saved space views', () => {
  it('round-trips definitions and validates both settings and space records', () => {
    expect(parseSpaceViews([view])).toEqual({ views: [view] });
    expect(readSpaceViews(JSON.stringify([view]))).toEqual([view]);
    expect(parseSpaceViews(null)).toEqual({ views: null });
    // One set for every space (owner, 10/19): a space record keeps no views of its own.
    expect(parseSpaces({ 'project:p': { about: 'P', views: [view] } } as never, {})).toEqual({ spaces: { 'project:p': { about: 'P' } } });
    for (const bad of [[], Array(21).fill(view), [view, view], [{ ...view, name: 'x'.repeat(41) }], [{ ...view, id: '?' }], [{ ...view, where: { live: { in: ['future'] } } }], [{ ...view, where: { unknown: {} } }], [{ ...view, group: 'workspace' }], [{ ...view, sort: 'wake' }], [{ ...view, done: 'yes' }], [{ ...view, where: { pinned: { unset: 'yes' } } }]]) {
      expect(parseSpaceViews(bad)).toHaveProperty('error');
    }
  });
  it('uses one set for every project and agent, else the built-ins (owner, 10/19)', () => {
    expect(spaceViewDefs({})).toBe(SPACE_VIEWS);
    expect(spaceViewDefs({ spaceViews: [view] })).toEqual([view]);
    expect(spaceViewDefs({ spaceViews: [view], spaces: { 'project:p': { views: [{ ...view, name: 'Only here' }] } } })).toEqual([view]);
  });
  it('round-trips editor facet changes without losing exclusions or unset', () => {
    const original = { ...view, where: { kind: { not: ['worker'], unset: false } } };
    const edited = { ...original, ...putSpaceFacet(original, 'kind', 'in', ['thread', 'default']) };
    expect(parseSpaceViews([edited])).toEqual({ views: [edited] });
    expect(putSpaceFacet(edited, 'kind', 'in', []).where.kind).toEqual({ not: ['worker'], unset: false });
  });
  it('renders custom membership, preserves unknown filters, hides empty non-first views', () => {
    const rows = [item('ask'), item('idle', 'idle'), item('failure', 'failed')];
    const defs = [view, { ...view, id: 'empty', where: { kind: { in: ['future'] } } }];
    const views = spaceViews(rows, [], defs);
    expect(views.map((v: any) => v.name)).toEqual(['Needs you here']);
    expect(views[0].items.map((i: any) => i.id)).toEqual(['ask', 'failure']);
    expect(spaceGroups(views[0], views[0].items).flatMap((g: any) => g.items).map((i: any) => i.id)).toEqual(['failure', 'ask']);
    expect(spaceViews(rows, [], [defs[1]])[0].items).toEqual([]);
    expect(spaceViews(rows, [], [{ ...view, where: { future: { in: ['x'] } } }])[0].items).toEqual([]);
  });
  it('leads custom views with matching defaults and honors stage grouping', () => {
    const lead = item('lead', 'idle', 'default');
    const defs = [{ ...view, where: { kind: { not: ['worker'] } }, group: 'stage' }];
    const views = spaceViews([item('ask'), lead], [], defs);
    expect(spaceGroups(views[0], views[0].items)[0]).toMatchObject({ key: 'default', items: [lead] });
  });
  it('persists each space pick on reload and falls back when deleted or storage is broken', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
    const store = createStore({});
    store.setPageView('project:p', 'here');
    store.setPageView('agent:a', 'jobs');
    const reloaded = createStore({});
    expect(pageView(reloaded.state, 'project:p', [view])).toBe('here');
    expect(reloaded.state.nextPageViews['agent:a']).toBe('jobs');
    expect(pageView(reloaded.state, 'project:p', [{ id: 'replacement' }])).toBe('replacement');
    saved.set('desk.nextPageViews', '{');
    expect(createStore({}).state.nextPageViews).toEqual({});
  });
  it('reports renamed project and agent views to voice and opens their editor from context', () => {
    const store = createStore({});
    const renamed = { ...view, name: 'Please look here' };
    store.set({ spaceViews: [renamed], projects: [{ id: 'p', name: 'Project', createdAt: 0 }], nextRoute: { page: 'project', id: 'p' }, lists: { active: { items: [item('ask')] }, history: { items: [] } } });
    expect(nextListReport(store.state).view).toEqual({ id: 'here', name: 'Please look here' });
    const openSettings = vi.fn();
    const menu = contextItems({ kind: 'spaceview', spaceKey: 'project:p', id: 'here' }, { ...store, openSettings, threadOpen: () => false });
    menu.items[0].onSelect();
    expect(openSettings).toHaveBeenCalledWith('spaceviews', { tab: 'here' });
    store.set({ nextRoute: { page: 'agent', id: 'a' } });
    expect(nextListReport(store.state).views[0].name).toBe('Please look here');
  });
  it('shows saves immediately, rolls back failures, and offers Retry', async () => {
    const saveSettings = vi.fn().mockRejectedValue({ body: { error: 'refused' } });
    const store = createStore({ saveSettings });
    const saving = store.saveSpaceViews([view]);
    expect(store.state.spaceViews).toEqual([view]);
    expect(await saving).toBe('refused');
    expect(store.state.spaceViews).toBeNull();
    expect(store.state.toasts.at(-1).actions[0].label).toBe('Retry');
  });
});

describe('space layout and shared saves', () => {
  it('honors hidden status sections even when the first view groups by stage', () => {
    const rows = [item('failure', 'failed'), item('idle', 'idle')];
    const def = { ...view, group: 'stage' };
    expect(spaceGroups(def, rows, Date.now(), ['failed']).flatMap((g: any) => g.items).map((i: any) => i.id)).toEqual(['idle']);
    expect(spaceGroups(def, rows).flatMap((g: any) => g.items)).toHaveLength(2);
  });
  it('keeps scheduled jobs last, done queries separate, and requests first', () => {
    const job = { ...item('job', '' , 'ops'), facts: { role: 'ops', schedule: { nextRunAt: 500 } }, status: { pill: 'idle', move: null, busy: null } };
    const def = { ...view, where: {}, group: 'none' };
    expect(spaceGroups(def, [job, item('idle', 'idle'), item('ask')]).map((g: any) => g.key)).toEqual(['all', 'scheduled']);
    expect(spaceGroups(def, [job, item('idle', 'idle'), item('ask')])[0].items.map((i: any) => i.id)).toEqual(['ask', 'idle']);
    const done = { ...item('done'), disposition: 'done', doneAt: 200 };
    expect(spaceViews([item('ask')], [done], [{ ...def, done: true }])[0].items).toEqual([done]);
  });
});

it('persists and broadcasts validated space views through settings HTTP without changing Inbox tabs', async () => {
  const { Hono } = await import('hono');
  const { registerDeskRoutes } = await import('../server/desk/routes.js');
  const { makeHarness } = await import('./desk-harness.js');
  const h = makeHarness();
  const app = new Hono();
  registerDeskRoutes(app, { core: h.core, scenes: () => [], keepAliveMs: 20 });
  const post = (body: unknown) => app.request('/api/desk/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await app.request('/api/desk/stream');
    reader = response.body!.getReader();
    await reader.read();
    const saved = await (await post({ spaceViews: [view] })).json();
    expect(saved).toMatchObject({ spaceViews: [view], listViews: null });
    let text = '';
    const decoder = new TextDecoder();
    for (let n = 0; n < 10 && !text.includes('event: settings'); n++) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('event: settings');
    expect(text).toContain('Needs you here');
    expect((await post({ spaceViews: [{ ...view, where: { kind: { in: ['unknown'] } } }] })).status).toBe(400);
    expect((await (await app.request('/api/desk/settings')).json()).spaceViews).toEqual([view]);
    expect((await (await post({ spaceViews: null })).json()).spaceViews).toBeNull();
  } finally { await reader?.cancel(); h.close(); }
});
