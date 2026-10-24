import * as path from 'node:path';
import { deskStatus } from '../server/desk/status.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { parseListViews } from '../server/desk/routes.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
// @ts-expect-error plain browser module, no types
import { DEFAULT_VIEWS, currentView, describeView, newViewId, normalizeView, trophyShelf, viewItems, viewSort, viewsOf } from '../public/desk/list-views.js';
// @ts-expect-error plain browser module, no types
import { sectionsOf } from '../public/desk/list-model.js';
import { makeHarness, NOW, type Harness } from './desk-harness.js';

// The List's tabs are views the owner defines (TGO-955): filters on status and on facts the desk
// knows (live state, stage, type, project, agent), its grouping and sort. Synthetic names only.

const item = (id: string, patch: Record<string, unknown> = {}) => {
  const row = {
  id,
  source: 'loom',
  agentId: 'loom',
  agentName: 'Loom',
  place: `acme · ${id}`,
  area: 'acme',
  disposition: 'active',
  nextStep: 'fyi',
  lastActivityAt: NOW,
  facts: { project: { name: 'acme' } },
  ...patch,
  };
  return { ...row, status: deskStatus(row as never, NOW) };
};
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

describe('views', () => {
  const lists = {
    active: {
      items: [
        item('ask', { facts: { project: { name: 'acme' }, pending: { kind: 'question' }, stage: 'discovery', type: 'bug' } }),
        item('busy', { facts: { project: { name: 'acme' }, running: { since: 1 }, stage: 'building' } }),
        item('done-turn', { facts: { project: { name: 'beta' }, lastAuthor: 'agent', type: 'feat' }, place: 'beta · done-turn', area: 'beta' }),
        item('chat', { source: 'discord', agentId: 'sierra-ollama', agentName: 'Sierra', place: 'Truck', facts: { lastAuthor: 'owner' }, lastOwnerMessageAt: NOW }),
        item('dropped', { source: 'discord', agentId: 'sierra-ollama', agentName: 'Sierra', place: 'Truck', facts: { lastAuthor: 'owner' }, lastOwnerMessageAt: NOW - 10 * 60_000 }),
      ],
    },
    snoozed: { items: [item('nap', { disposition: 'snoozed' }), item('shelf', { disposition: 'parked', facts: { stage: 'feedback' } })] },
    history: { items: [item('old', { disposition: 'done' })] },
  };

  it('the built-in tabs are Needs you, Active, Later and Done', () => {
    expect(viewsOf(null).map((v: { name: string }) => v.name)).toEqual(['Needs you', 'Active', 'Later', 'Done']);
    const by = (id: string) => ids(viewItems(lists, currentView(DEFAULT_VIEWS, id)));
    expect(currentView(DEFAULT_VIEWS, 'active').id).toBe('active');
    expect(by('needs')).toEqual(['ask']);
    expect(by('active')).toEqual(['ask', 'busy', 'done-turn', 'chat', 'dropped']);
    expect(by('later')).toEqual(['nap', 'shelf']);
    expect(by('done')).toEqual(['old']);
    expect(viewSort(currentView(DEFAULT_VIEWS, 'done'))).toBe('history');
    expect(viewSort(currentView(DEFAULT_VIEWS, 'needs'))).toBe('asks');
    expect(viewsOf(null, 'project').map((v: { group: string }) => v.group)).toEqual(['live', 'live', 'live', 'none']);
    expect(viewsOf(null, 'label')).toEqual(DEFAULT_VIEWS);
  });

  it('Needs you holds Stuck rows, and a saved built-in Needs you from before Stuck gains them', () => {
    const stuck = item('stalled', { facts: { project: { name: 'acme' }, handoff: { owner: 'me', text: 'run the tests', at: NOW - 10, source: 'tool', wokeAt: NOW - 20, stuck: true } } });
    expect(ids(viewItems({ active: { items: [stuck] } }, currentView(DEFAULT_VIEWS, 'needs')))).toEqual(['stalled']);
    const saved = DEFAULT_VIEWS.map((v: Record<string, unknown>) => (v.id === 'needs' ? { ...v, live: ['needs', 'failed'] } : v));
    expect(viewsOf(saved)[0].live).toEqual(['needs', 'failed', 'stuck']);
    const narrowed = DEFAULT_VIEWS.map((v: Record<string, unknown>) => (v.id === 'needs' ? { ...v, live: ['needs'] } : v));
    expect(viewsOf(narrowed)[0].live).toEqual(['needs']);
  });

  it('filters combine: status, live state, stage (incl. none), type, workspace, agent', () => {
    const v = (spec: Record<string, unknown>) => ids(viewItems(lists, normalizeView({ id: 'x', name: 'X', ...spec })));
    expect(v({ show: 'active', type: ['bug', 'feat'] })).toEqual(['ask', 'done-turn']);
    expect(v({ show: 'active', stage: ['none'] })).toEqual(['done-turn', 'chat', 'dropped']);
    expect(v({ show: 'active', workspace: ['beta'] })).toEqual(['done-turn']);
    // A view saved before projects named workspaces `project`.
    expect(v({ show: 'active', project: ['beta'] })).toEqual(['done-turn']);
    expect(v({ show: 'active', agent: ['sierra'] })).toEqual(['chat', 'dropped']);
    expect(v({ show: 'active', live: ['unknown'] })).toEqual(['dropped']);
    expect(v({ show: 'active', live: ['failed'] })).toEqual([]);
    // Quiet is gone: a view saved with it filters on nothing it can't name.
    expect(normalizeView({ id: 'x', name: 'X', live: ['quiet', 'ready'] }).live).toEqual(['ready']);
    expect(parseListViews([{ id: 'q', name: 'Q', status: ['active'], live: ['quiet', 'failed'], group: 'none' }])).toMatchObject({ views: [{ live: ['failed'] }] });
    expect(v({ status: ['active', 'snoozed', 'parked'], stage: ['feedback', 'discovery'] })).toEqual(['ask', 'shelf']);
    // Status is pick-any like the other filters; none picked is every status, done included.
    expect(v({ status: ['parked', 'done'] })).toEqual(['shelf', 'old']);
    expect(v({ status: [] })).toEqual(['ask', 'busy', 'done-turn', 'chat', 'dropped', 'nap', 'shelf', 'old']);
  });

  it('a pending PR review is Watching, and "Waiting on review" narrows a view to just those', () => {
    const review = (state: string, nextStep: string) => ({ openedPrUrls: ['https://github.com/acme/widgets/pull/9'], project: { name: 'acme' }, lastAuthor: 'agent', prReview: { state, reviewers: ['r'], number: 9, since: 1 } });
    const reviewLists = {
      active: {
        items: [
          item('in-review', { nextStep: 'watching', nextStepBasis: 'source:pr-review', facts: review('pending', 'watching') }),
          // Several PRs: the aggregate says changes requested (answered by the agent), the desk watches the other PR.
          item('multi', { nextStep: 'watching', nextStepBasis: 'source:pr-review', facts: review('changes_requested', 'watching') }),
          // Waited past the nudge gap: the desk handed it back, so it reads Ready again.
          item('stalled', { nextStep: 'your_move', facts: review('pending', 'your_move') }),
          item('approved', { nextStep: 'your_move', facts: review('approved', 'your_move') }),
          item('job', { nextStep: 'watching', nextStepBasis: 'source:job', facts: { project: { name: 'acme' }, job: { id: 'j', label: 'sync' } } }),
        ],
      },
    };
    const v = (spec: Record<string, unknown>) => ids(viewItems(reviewLists, normalizeView({ id: 'x', name: 'X', status: ['active'], ...spec })));
    expect(v({ live: ['waiting'] })).toEqual(['in-review', 'multi', 'stalled']);
    expect(v({ live: ['working'] })).toEqual(['job']);
    expect(v({ live: ['review'] })).toEqual([]);
    expect(v({ live: ['needs', 'failed'] })).toEqual([]);
    expect(parseListViews([{ id: 'r', name: 'In review', status: ['active'], live: ['review'], group: 'project' }])).toMatchObject({ views: [{ live: ['waiting'] }] });
    // A filter value this page doesn't know (saved by a newer desk) narrows to nothing; it never shows everything.
    expect(v({ live: ['someday-state'] })).toEqual([]);
    expect(normalizeView({ id: 'x', name: 'X', live: ['quiet'] }).live).toBeUndefined();
  });

  it('views saved with the old pick-one `show` read as the matching statuses', () => {
    const v = (show: string) => normalizeView({ id: 'x', name: 'X', show }).status;
    expect(['active', 'open', 'snoozed', 'parked', 'history', 'bogus'].map(v)).toEqual([['active'], ['active', 'snoozed', 'parked'], ['snoozed'], ['parked'], ['done'], ['active']]);
    expect(viewSort(normalizeView({ id: 'x', name: 'X', show: 'history', sort: 'asks' }))).toBe('history');
    expect(viewSort(normalizeView({ id: 'x', name: 'X', status: ['done', 'parked'], sort: 'asks' }))).toBe('asks');
    expect(parseListViews([{ id: 'a', name: 'A', show: 'open', group: 'stage' }])).toEqual({ views: [{ id: 'a', name: 'A', group: 'stage', sort: 'recent', status: ['active', 'snoozed', 'parked'], show: 'open', fold: true }] });
    expect(parseListViews([{ id: 'a', name: 'A', status: ['gone'], group: 'stage' }])).toMatchObject({ error: expect.stringContaining('gone') });
  });

  it('groups by live state when asked', () => {
    const sections = sectionsOf(lists.active.items, 'live', 'recent');
    expect(sections.map((s: { label: string; items: Array<{ id: string }> }) => [s.label, ids(s.items)])).toEqual([
      ['Needs you', ['ask']],
      ['Working', ['busy', 'chat']],
      ['Idle', ['done-turn']],
      ['Unknown', ['dropped']],
    ]);
  });

  it('saved views are cleaned; unusable ones fall back to the built-ins; a device on a gone view lands on the first', () => {
    expect(normalizeView({ id: 'Bad Id', name: 'x' })).toBeNull();
    expect(normalizeView({ id: 'bugs', name: '  Bugs  ', show: 'nope', live: ['needs', 'bogus'], group: 'weird' })).toEqual({ id: 'bugs', name: 'Bugs', group: 'stage', sort: 'recent', rev: 2, status: ['active'], live: ['needs'], fold: true });
    expect(viewsOf([{ id: 'x' }])).toEqual(DEFAULT_VIEWS);
    const mine = viewsOf([{ id: 'bugs', name: 'Bugs', show: 'active', type: ['bug'], group: 'project' }, { id: 'bugs', name: 'Dup' }]);
    expect(mine.map((v: { id: string }) => v.id)).toEqual(['needs', 'active', 'later', 'done', 'bugs']);
    expect(currentView(mine, 'gone').id).toBe('needs');
    expect(currentView(mine, 'bugs').id).toBe('bugs');
    expect(newViewId(mine, 'Bugs!')).toBe('bugs-2');
    expect(describeView(mine[4], { bug: 'bug' })).toBe('Active · bug · projects folded · by project');
    // Agents together only means something grouped by workspace (Loom's projects).
    expect(normalizeView({ id: 'naps', name: 'Naps', group: 'workspace', agentsTogether: true })?.agentsTogether).toBe(true);
    expect(normalizeView({ id: 'naps', name: 'Naps', group: 'stage', agentsTogether: true })).not.toHaveProperty('agentsTogether');
    expect(describeView(normalizeView({ id: 'naps', name: 'Naps', status: ['snoozed'], group: 'workspace', agentsTogether: true }))).toBe('Snoozed · projects folded · by workspace, agents together');
    expect(normalizeView({ id: 'naps', name: 'Naps', status: ['snoozed'], group: 'none', sort: 'wake' })?.sort).toBe('wake');
    expect(DEFAULT_VIEWS.find((v: { id: string }) => v.id === 'later').sort).toBe('wake');
  });
});

describe('the trophy shelf (an empty view of what needs the owner)', () => {
  const now = new Date(2026, 9, 14, 15, 0).getTime();
  const at = (h: number, m = 0) => new Date(2026, 9, 14, h, m).getTime();
  const done = (id: string, doneAt: number, patch: Record<string, unknown> = {}) => item(id, { disposition: 'done', doneAt, lastActivityAt: doneAt, ...patch });
  const lists = {
    active: { items: [] },
    snoozed: { items: [] },
    history: {
      items: [
        done('morning', at(9, 5)),
        done('lunch', at(12, 30), { facts: { project: { name: 'beta' } }, place: 'beta · lunch', area: 'beta' }),
        done('afternoon', at(14, 10)),
        done('late', at(14, 50)),
        done('yesterday', at(9) - 24 * 3600_000),
      ],
    },
  };
  const view = (id: string) => DEFAULT_VIEWS.find((v: { id: string }) => v.id === id);

  it('counts what was done today, newest first, and keeps the newest three', () => {
    const shelf = trophyShelf(lists, view('needs'), now);
    expect(shelf.count).toBe(4);
    expect(ids(shelf.items)).toEqual(['late', 'afternoon', 'lunch']);
  });

  it('shows on Needs you only among the four built-in tabs', () => {
    expect(trophyShelf(lists, view('needs'), now)?.count).toBe(4);
    expect(trophyShelf(lists, view('active'), now)?.count).toBe(4);
    for (const id of ['later', 'done']) expect(trophyShelf(lists, view(id), now)).toBeNull();
  });

  it('a custom view’s project filter narrows the wins to that project', () => {
    const custom = normalizeView({ id: 'beta', name: 'Beta', status: ['active'], project: ['beta'] });
    expect(ids(trophyShelf(lists, custom, now).items)).toEqual(['lunch']);
  });

  it('nothing done yet today is a count of zero, not null', () => {
    expect(trophyShelf({ ...lists, history: { items: [done('yesterday', at(9) - 24 * 3600_000)] } }, view('needs'), now)).toMatchObject({ count: 0, items: [] });
  });
});

describe('the listViews setting', () => {
  let h: Harness;
  let hub: Hub;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    h = makeHarness();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50 } } });
  });
  afterEach(() => {
    hub.close();
    h.close();
  });
  const post = (body: unknown) => app.request('/api/desk/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('validates strictly: refuses, never trims', () => {
    expect(parseListViews(null)).toEqual({ views: null });
    expect(parseListViews([])).toMatchObject({ error: expect.stringContaining('non-empty') });
    expect(parseListViews([{ id: 'a', name: 'A', show: 'active', group: 'stage', live: ['bogus'] }])).toMatchObject({ error: expect.stringContaining('bogus') });
    expect(parseListViews([{ id: 'a', name: 'A', show: 'active', group: 'stage' }, { id: 'a', name: 'B', show: 'active', group: 'stage' }])).toMatchObject({ error: expect.stringContaining('share') });
    expect(parseListViews([{ id: 'a', name: 'A', status: ['snoozed'], group: 'none', sort: 'wake' }])).toMatchObject({ views: [{ sort: 'wake' }] });
    expect(parseListViews([{ id: 'a', name: 'A', status: ['snoozed'], group: 'project', agentsTogether: true }])).toMatchObject({ views: [{ agentsTogether: true }] });
    expect(parseListViews([{ id: 'a', name: 'A', status: ['snoozed'], group: 'project', agentsTogether: 'yes' }])).toMatchObject({ error: expect.stringContaining('agentsTogether') });
    expect(parseListViews([{ id: 'a', name: 'A', status: ['snoozed'], group: 'none', sort: 'bogus' }])).toMatchObject({ error: expect.stringContaining('wake') });
    expect(parseListViews([{ id: 'a', name: 'A', status: ['active'], group: 'stage', stage: ['discovery', 'none'], type: ['bug'] }])).toEqual({ views: [{ id: 'a', name: 'A', group: 'stage', sort: 'recent', status: ['active'], show: 'active', stage: ['discovery', 'none'], type: ['bug'], fold: true }] });
  });

  it('saves for every screen; null goes back to the built-in views', async () => {
    expect((await (await app.request('/api/desk/settings')).json()).listViews).toBeNull();
    const views = [{ id: 'bugs', name: 'Bugs', group: 'project', sort: 'recent', status: ['active'], type: ['bug'], fold: true }];
    // An old tab still reads `show`, kept beside `status` (Codex review on #504); a mix with no old name gets the nearest.
    const saved = [{ ...views[0], show: 'active', fold: true }];
    expect((await (await post({ listViews: views })).json()).listViews).toEqual(saved);
    expect((await (await app.request('/api/desk/settings')).json()).listViews).toEqual(saved);
    const nearest = (status?: string[]) => (parseListViews([{ id: 'm', name: 'M', status, group: 'none' }]) as { views: Array<{ show: string }> }).views[0].show;
    expect([nearest(['parked', 'done']), nearest(['active', 'snoozed']), nearest(undefined), nearest(['done'])]).toEqual(['open', 'open', 'open', 'history']);
    // Any status survives the round trip: the stored `status: []` wins over the `show` kept for old tabs.
    await post({ listViews: [{ id: 'any', name: 'Any', group: 'none' }] });
    const back = (await (await app.request('/api/desk/settings')).json()).listViews[0];
    expect(back).toMatchObject({ status: [], show: 'open' });
    expect(normalizeView(back).status).toBeUndefined();
    expect((await post({ listViews: [{ id: 'x', name: 'X', show: 'nowhere', group: 'stage' }] })).status).toBe(400);
    expect((await (await post({ listViews: null })).json()).listViews).toBeNull();
  });
});

describe('desk build', () => {
  it('the shell page carries the build it was served with', async () => {
    const { DESK_BUILD, withBuild } = await import('../server/build.js');
    expect(DESK_BUILD).toBeTruthy();
    expect(withBuild('<head>\n<meta charset="utf-8">\n</head>')).toContain(`<meta name="desk-build" content="${DESK_BUILD}">`);
  });
});
