import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { DeskFeed } from '../server/desk/feed.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { makeHarness, msg, type Harness } from './desk-harness.js';

let h: Harness | undefined;
afterEach(() => h?.close());

describe('window feed scope integration', () => {
  it('filters server posts through saved queries, including missing tabs', async () => {
    h = makeHarness();
    const feed = new DeskFeed(h.db, () => h!.clock.now);
    h.discord.push('5000', msg(-1, 'agent', 'Ready for an answer'));
    await h.source.poll();
    const item = h.core.items()[0];
    expect(item).toBeDefined();
    h.core.store.setSetting('list_views', JSON.stringify([{ id: 'mine', name: 'Mine', group: 'none', sort: 'recent', where: { source: { in: ['discord'] } } }]));
    feed.post({ kind: 'update', itemId: item.id, title: 'Inside' });
    feed.post({ kind: 'update', itemId: 'unknown', title: 'Outside' });
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, feed }, compat: { core: h.core, hub, rules: null, pollSources: () => h!.source.poll() } } });
    const read = async (scope: string) => (await (await app.request(`/api/desk/feed?limit=1&scope=${encodeURIComponent(scope)}`)).json()) as any;
    expect((await read('tab:mine')).posts.map((p: any) => p.title)).toEqual(['Inside']);
    expect((await read('tab:missing')).posts).toEqual([]);
    expect((await app.request('/api/desk/feed?scope=invalid')).status).toBe(400);
    hub.close();
  });

  it('reads stage visibility from stored flags without rewriting saved feed tabs', async () => {
    h = makeHarness();
    const feed = new DeskFeed(h.db, () => h!.clock.now);
    h.discord.push('5000', msg(-1, 'agent', 'Ready for an answer'));
    await h.source.poll();
    const item = h.core.items()[0]!;
    const saved = JSON.stringify([{ id: 'top', name: 'Top', group: 'none', sort: 'recent', stage: ['building'], where: { stage: { in: ['discovery', 'building'] } } }]);
    h.core.store.setSetting('list_views', saved);
    feed.post({ kind: 'update', itemId: item.id, title: 'Unstaged conversation' });
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, feed }, compat: { core: h.core, hub, rules: null, pollSources: () => h!.source.poll() } } });
    try {
      const read = async () => ((await (await app.request('/api/desk/feed?scope=tab:top')).json()) as any).posts;
      expect(await read()).toHaveLength(1); // Missing flag defaults off.
      h.core.store.setSetting('flags', JSON.stringify({ stageLabels: true }));
      expect(await read()).toEqual([]);
      h.core.store.setSetting('flags', JSON.stringify({ stageLabels: false }));
      expect(await read()).toHaveLength(1);
      expect(h.core.store.setting('list_views')).toBe(saved);
    } finally { hub.close(); }
  });

  it('with "Show answered asks" off, closed bare state posts never fill the page before an older update', async () => {
    h = makeHarness();
    const feed = new DeskFeed(h.db, () => h!.clock.now);
    h.discord.push('5000', msg(-1, 'agent', 'Working on it'));
    await h.source.poll();
    const item = h.core.items()[0]!;
    feed.post({ kind: 'update', itemId: item.id, title: 'Older news' });
    for (let i = 0; i < 5; i += 1) {
      h.clock.now += 1000;
      feed.post({ kind: 'needs', itemId: item.id, title: `Ask ${i}` });
    }
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, feed }, compat: { core: h.core, hub, rules: null, pollSources: () => h!.source.poll() } } });
    const read = async () => ((await (await app.request('/api/desk/feed?limit=2')).json()) as any).posts.map((p: any) => p.title);
    expect(await read()).toEqual(['Older news']);
    h.core.store.setSetting('feed', JSON.stringify({ chatter: 'hidden', needsYou: true }));
    expect(await read()).toEqual(['Ask 4', 'Ask 3']);
    hub.close();
  });

  it('updates the named window and dashboard metadata through its scope endpoint', async () => {
    h = makeHarness();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const events: Array<{ event: string; data: any }> = [];
    const id = hub.addScreen('Wall', { send: (event, data) => events.push({ event, data }) }, 'screen');
    const app = createApp({ store: scenes, hub, publicDir: h.dir });
    const response = await app.request(`/api/screens/${id}/feed-scope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedScope: 'tab:mine' }) });
    expect(response.status).toBe(200);
    expect(events.findLast((e) => e.event === 'role')?.data).toEqual({ feedScope: 'tab:mine' });
    expect(hub.dashboard().windows).toContainEqual(expect.objectContaining({ id, name: 'Wall', feedScope: 'tab:mine' }));
    hub.close();
  });
});

describe('project news in a scoped feed (Codex review on #801)', () => {
  it('keeps a project status or digest in its project scope and its parent projects, nowhere else', async () => {
    const { postInFeedScope } = await import('../public/desk/feed-scope.js');
    const projects = [{ id: 'parent' }, { id: 'child', parent: 'project:parent' }, { id: 'other' }];
    const news = { itemId: null, projectId: 'child' };
    expect(postInFeedScope(news, null, 'space:project:child', { projects })).toBe(true);
    expect(postInFeedScope(news, null, 'space:project:parent', { projects })).toBe(true);
    expect(postInFeedScope(news, null, 'space:project:other', { projects })).toBe(false);
    expect(postInFeedScope(news, null, 'space:agent:sierra', { projects })).toBe(false);
    expect(postInFeedScope(news, null, 'tab:needs', { projects })).toBe(false);
    expect(postInFeedScope(news, null, 'everything', { projects })).toBe(true);
  });
});
