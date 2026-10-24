import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { facetsFor, filterMatches, itemRepo, itemTitle, parseFilters, readFilters, threadType } from '../server/desk/filters.js';
import { briefing, listItems } from '../server/desk/view.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { makeHarness, NOW, type Harness } from './desk-harness.js';

// In-app desk filters (spec "Filters"): agents, Loom repos and thread types the owner hides from
// the Active board, its counts and the briefing. Synthetic names only.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.close());

function t3(id: string, repo: string, title: string, minutesAgo = 10) {
  h.core.ensureItem({ id: `loom:${id}`, source: 'loom', kind: 'thread', conversationKey: `loom:${id}`, agentId: 'loom', agentName: 'Loom', place: `${repo} · ${title}`, area: repo, createdAt: NOW - minutesAgo * 60_000 }, 'agent');
  return `loom:${id}`;
}
function discord(id: string, agentId: string, agentName: string, place: string | null, minutesAgo = 10) {
  h.core.ensureItem({ id: `discord:thread:${id}`, source: 'discord', kind: 'thread', conversationKey: `thread:${id}`, agentId, agentName, place, createdAt: NOW - minutesAgo * 60_000 }, 'agent');
  return `discord:thread:${id}`;
}
function seed() {
  return {
    ops: t3('a', 'alpha', 'ops: Delivery monitor'),
    bug: t3('b', 'alpha', 'bug:Fix the login'),
    feat: t3('c', 'beta', 'feat: New page'),
    plain: t3('d', 'beta', 'Plain thread title'),
    sierra: discord('9001', 'sierra', 'Sierra', 'Speaker'),
    clone: discord('9002', 'sierra-ollama', 'Sierra', 'chore: tidy the shed'),
    watson: discord('9003', 'watson', 'Watson', null),
  };
}
const ids = (list: { items: Array<{ id: string }> }) => list.items.map((item) => item.id).sort();
const setFilters = (filters: object) => h.core.store.setSetting('filters', JSON.stringify(filters));

describe('parsing facets', () => {
  it('reads the thread type from the start of the title: lowercased, no space needed, none when absent', () => {
    expect(threadType('bug:Fix it')).toBe('bug');
    expect(threadType('Ops: Delivery monitor')).toBe('ops');
    expect(threadType('  watch: deploy')).toBe('watch');
    expect(threadType('Plain thread title')).toBeNull();
    expect(threadType('Re-plan the week in detail: notes')).toBeNull();
    expect(threadType('https://example.com')).toBeNull();
    expect(threadType(null)).toBeNull();
  });

  it('a Loom item has a repo (its area, else the place before " · ") and a title without it; others have no repo', () => {
    expect(itemRepo({ source: 'loom', area: 'alpha', place: 'alpha · bug: x' })).toBe('alpha');
    expect(itemRepo({ source: 'loom', area: null, place: 'gamma · ops: y' })).toBe('gamma');
    expect(itemTitle({ source: 'loom', area: 'a · b', place: 'a · b · fix: z' })).toBe('fix: z');
    expect(itemRepo({ source: 'discord', area: null, place: 'alpha · bug: x' })).toBeNull();
    expect(itemTitle({ source: 'discord', area: null, place: 'bug: x' })).toBe('bug: x');
  });

  it('validates filters: arrays of strings; agents to their persona; types lowercase without the colon; de-duplicated', () => {
    expect(parseFilters({ hideAgents: ['Sierra-Ollama', 'sierra'], hideRepos: [' alpha '], hideTypes: ['Bug:', 'bug', 'OPS'] })).toEqual({ filters: { hideAgents: ['sierra'], hideRepos: ['alpha'], hideTypes: ['bug', 'ops'] } });
    expect(parseFilters({})).toEqual({ filters: { hideAgents: [], hideRepos: [], hideTypes: [] } });
    for (const bad of [null, [], 'x', { hideAgents: 'sierra' }, { hideTypes: [1] }, { hideTypes: [''] }, { hideTypes: ['two words'] }, { hideRepos: Array(101).fill('r') }, { other: [] }]) {
      expect(parseFilters(bad)).toHaveProperty('error');
    }
  });

  it('a damaged stored value reads as no filters', () => {
    h.core.store.setSetting('filters', '{nope');
    expect(readFilters(h.core.store)).toEqual({ hideAgents: [], hideRepos: [], hideTypes: [] });
  });
});

describe('the board, counts and briefing leave filtered items out', () => {
  it('with no filters everything active is on the board', () => {
    seed();
    expect(listItems(h.core).items).toHaveLength(7);
    expect(listItems(h.core).counts).toMatchObject({ active: 7, filtered: 0 });
  });

  it('hiding an agent hides its clones too', () => {
    const s = seed();
    setFilters({ hideAgents: ['sierra'], hideRepos: [], hideTypes: [] });
    expect(listItems(h.core).items).toHaveLength(7);
    expect(listItems(h.core).items.find((i) => i.id === s.clone)?.filteredBy).toEqual([{ facet: 'agent', value: 'sierra' }]);
    expect(filterMatches(h.core.item(s.clone)!, readFilters(h.core.store))).toEqual([{ facet: 'agent', value: 'sierra' }]);
  });

  it('hiding a repo hides its Loom threads only; repo match ignores case', () => {
    const s = seed();
    setFilters({ hideAgents: [], hideRepos: ['ALPHA'], hideTypes: [] });
    expect(listItems(h.core).items.filter((i) => i.filteredBy?.length).map((i) => i.id).sort()).toEqual([s.ops, s.bug].sort());
  });

  it('hiding types matches Loom and Discord titles, "bug:Fix" included; untyped items stay', () => {
    const s = seed();
    setFilters({ hideAgents: [], hideRepos: [], hideTypes: ['bug', 'ops', 'chore'] });
    const list = listItems(h.core);
    expect(list.items).toHaveLength(7);
    expect(list.counts).toMatchObject({ active: 4, filtered: 3, new: 4 });
    expect(list.sections.flatMap((section) => section.itemIds)).toHaveLength(7);
  });

  it('Everything keeps filtered items, marked with what filtered them', () => {
    const s = seed();
    setFilters({ hideAgents: ['loom'], hideRepos: [], hideTypes: ['bug'] });
    const everything = listItems(h.core, { view: 'everything' });
    expect(everything.items).toHaveLength(7);
    expect(everything.items.find((item) => item.id === s.bug)!.filteredBy).toEqual([
      { facet: 'agent', value: 'loom' },
      { facet: 'type', value: 'bug' },
    ]);
    expect(everything.items.find((item) => item.id === s.sierra)!.filteredBy).toBeUndefined();
    expect(listItems(h.core).items.find((item) => item.id === s.bug)?.filteredBy).toEqual(everything.items.find((item) => item.id === s.bug)?.filteredBy);
  });

  it('the briefing skips filtered items', () => {
    const s = seed();
    expect(briefing(h.core).counts.active).toBe(7);
    setFilters({ hideAgents: ['watson'], hideRepos: ['beta'], hideTypes: ['ops', 'bug', 'chore'] });
    const brief = briefing(h.core);
    expect(brief.counts.active).toBe(1);
    expect(brief.fyi.flatMap((entry) => entry.itemIds)).toEqual([s.sierra]);
    expect(brief.text).not.toContain('Watson');
  });
});

describe('the weekly sweep leaves filtered items out', () => {
  it('neither the sweep card nor the briefing offers a filtered candidate, active or parked', async () => {
    const s = seed();
    await h.core.command({ commandId: 'park-1', type: 'park', itemId: s.clone });
    h.core.store.setSetting('sweep_pending', JSON.stringify({ at: NOW, itemIds: [s.sierra, s.clone, s.watson] }));
    expect(listItems(h.core).sweep!.items.map((item) => item.id)).toEqual([s.sierra, s.clone, s.watson]);
    setFilters({ hideAgents: ['sierra'], hideRepos: [], hideTypes: [] });
    expect(listItems(h.core).sweep!.items.map((item) => item.id)).toEqual([s.watson]);
    expect(briefing(h.core).sweep).toEqual({ at: NOW, itemIds: [s.watson] });
    setFilters({ hideAgents: ['sierra', 'watson'], hideRepos: [], hideTypes: [] });
    expect(listItems(h.core).sweep).toBeNull();
    expect(briefing(h.core).sweep).toBeNull();
  });
});

describe('facets', () => {
  it('lists agents (clones folded into the persona), repos and types with counts; hidden values stay listed', () => {
    seed();
    const facets = facetsFor(h.core.items(), { hideAgents: ['gone'], hideRepos: [], hideTypes: ['watch'] });
    expect(facets.agents).toEqual([
      { id: 'loom', name: 'Loom', count: 4 },
      { id: 'sierra', name: 'Sierra', count: 2 },
      { id: 'watson', name: 'Watson', count: 1 },
      { id: 'gone', name: 'gone', count: 0 },
    ]);
    expect(facets.repos).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 2 },
    ]);
    expect(facets.types.map((entry) => [entry.name, entry.count])).toEqual([
      ['bug', 1],
      ['chore', 1],
      ['feat', 1],
      ['ops', 1],
      ['watch', 0],
    ]);
  });
});

describe('HTTP: settings, facets and the stream', () => {
  let hub: Hub;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50 } } });
  });
  afterEach(() => hub.close());
  const post = (body: unknown) => app.request('/api/desk/settings', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

  it("the feed's settings validate, and a change keeps what isn't given", async () => {
    expect((await post({ feed: { chatter: 'loud' } })).status).toBe(400);
    expect((await (await post({ feed: { needsYou: true } })).json()).feed).toEqual({ chatter: 'hidden', needsYou: true, summaries: false, usage: true });
    expect((await (await post({ feed: { chatter: 'shown' } })).json()).feed).toEqual({ chatter: 'shown', needsYou: true, summaries: false, usage: true });
  });

  it('the feature flags start with stage labels off, validate, and persist', async () => {
    expect((await (await app.request('/api/desk/settings')).json()).flags).toEqual({ stageLabels: false });
    expect((await post({ flags: { stageLabels: 'yes' } })).status).toBe(400);
    expect((await post({ flags: { somethingElse: true } })).status).toBe(400);
    expect((await (await post({ flags: { stageLabels: true } })).json()).flags).toEqual({ stageLabels: true });
    expect((await (await app.request('/api/desk/settings')).json()).flags).toEqual({ stageLabels: true });
  });

  it('settings carry the filters; a POST validates, persists and normalizes them, and keeps the sweep day', async () => {
    expect(await (await app.request('/api/desk/settings')).json()).toEqual({ sweepDay: 'saturday', filters: { hideAgents: [], hideRepos: [], hideTypes: [] }, agentIcons: {}, repoIcons: {}, labelOrder: expect.arrayContaining(['discovery', 'chat', 'none']), snoozeTimes: { morning: '06:00', evening: '18:00' }, listViews: null, spaceViews: null, projects: [], projectsRev: 0, mailOff: [], projectSectionsHidden: ['done'], feed: { chatter: 'hidden', needsYou: false, summaries: false, usage: true }, flags: { stageLabels: false }, spaces: {} });
    expect((await post({ filters: { hideTypes: 'bug' } })).status).toBe(400);
    expect((await post({ filters: { hideTypes: ['bug'] }, sweepDay: 'sunday' })).status).toBe(400);
    expect(readFilters(h.core.store).hideTypes).toEqual([]);
    const saved = await (await post({ filters: { hideAgents: ['Watson-ollama'], hideTypes: ['Ops:'] } })).json();
    expect(saved).toEqual({ sweepDay: 'saturday', filters: { hideAgents: ['watson'], hideRepos: [], hideTypes: ['ops'] }, agentIcons: {}, repoIcons: {}, labelOrder: expect.any(Array), snoozeTimes: { morning: '06:00', evening: '18:00' }, listViews: null, spaceViews: null, projects: [], projectsRev: 0, mailOff: [], projectSectionsHidden: ['done'], feed: { chatter: 'hidden', needsYou: false, summaries: false, usage: true }, flags: { stageLabels: false }, spaces: {} });
    await post({ sweepDay: 'monday' });
    expect(await (await app.request('/api/desk/settings')).json()).toEqual({ sweepDay: 'monday', filters: { hideAgents: ['watson'], hideRepos: [], hideTypes: ['ops'] }, agentIcons: {}, repoIcons: {}, labelOrder: expect.any(Array), snoozeTimes: { morning: '06:00', evening: '18:00' }, listViews: null, spaceViews: null, projects: [], projectsRev: 0, mailOff: [], projectSectionsHidden: ['done'], feed: { chatter: 'hidden', needsYou: false, summaries: false, usage: true }, flags: { stageLabels: false }, spaces: {} });
  });

  it('GET /api/desk/items?view=active (what the voice operator reads) and the briefing apply the filters', async () => {
    const s = seed();
    await post({ filters: { hideAgents: ['sierra'], hideRepos: ['alpha'] } });
    const body = (await (await app.request('/api/desk/items?view=active&group=step')).json()) as { items: Array<{ id: string }>; counts: { active: number; filtered: number } };
    expect(body.items).toHaveLength(7);
    expect(body.counts).toMatchObject({ active: 3, filtered: 4 });
    const brief = (await (await app.request('/api/desk/briefing')).json()) as { counts: { active: number } };
    expect(brief.counts.active).toBe(3);
  });

  it('GET /api/desk/facets reports what can be filtered', async () => {
    seed();
    const facets = (await (await app.request('/api/desk/facets')).json()) as { agents: unknown[]; repos: unknown[]; types: unknown[] };
    expect(facets.agents).toHaveLength(3);
    expect(facets.repos).toHaveLength(2);
    expect(facets.types).toHaveLength(4);
  });

  it('every screen gets a settings event when the filters change', async () => {
    const response = await app.request('/api/desk/stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (until: (text: string) => boolean) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !until(text)) {
        const chunk = await Promise.race([reader.read(), new Promise<{ value: undefined }>((resolve) => setTimeout(() => resolve({ value: undefined }), 100))]);
        if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await read((t) => t.includes('event: hello'));
    await post({ filters: { hideTypes: ['bug'] } });
    await read((t) => t.includes('event: settings'));
    await reader.cancel();
    expect(text).toContain('event: settings');
    expect(text).toContain('"hideTypes":["bug"]');
  });
});
