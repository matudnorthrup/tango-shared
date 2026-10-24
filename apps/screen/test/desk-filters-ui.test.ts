import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import * as ui from '../public/desk/filters.js';
import * as server from '../server/desk/filters.js';

// The board's filter logic in the browser: toggles, Show, the button label, and parsing that
// matches the server's (the fixtures rely on it). Synthetic names only.

const none = { hideAgents: [], hideRepos: [], hideTypes: [] };

describe('filter toggles', () => {
  it('flips one value at a time: agents to their persona, types lowercase without the colon, repos ignoring case', () => {
    let f = ui.toggleFilter(none, 'agent', 'Sierra-Ollama');
    expect(f.hideAgents).toEqual(['sierra']);
    f = ui.toggleFilter(f, 'type', 'Bug:');
    f = ui.toggleFilter(f, 'repo', 'Alpha');
    expect(f).toEqual({ hideAgents: ['sierra'], hideRepos: ['Alpha'], hideTypes: ['bug'] });
    expect(ui.isHidden(f, 'repo', 'alpha')).toBe(true);
    expect(ui.isHidden(f, 'agent', 'sierra-classic')).toBe(true);
    f = ui.toggleFilter(f, 'repo', 'alpha');
    f = ui.toggleFilter(f, 'agent', 'sierra');
    expect(f).toEqual({ hideAgents: [], hideRepos: [], hideTypes: ['bug'] });
    expect(ui.hiddenCount(f)).toBe(1);
  });

  it('Show removes exactly the filters that hid the item', () => {
    const f = { hideAgents: ['loom', 'watson'], hideRepos: ['alpha'], hideTypes: ['bug', 'ops'] };
    expect(ui.showFiltered(f, [{ facet: 'agent', value: 'loom' }, { facet: 'type', value: 'bug' }])).toEqual({ hideAgents: ['watson'], hideRepos: ['alpha'], hideTypes: ['ops'] });
  });

  it('tolerates a missing or malformed filters payload', () => {
    expect(ui.normalizeFilters(undefined)).toEqual(none);
    expect(ui.normalizeFilters({ hideAgents: 'x', hideTypes: ['ok', 3] })).toEqual({ hideAgents: [], hideRepos: [], hideTypes: ['ok'] });
  });
});

describe('browser parsing matches the server', () => {
  const items = [
    { agentId: 'loom', agentName: 'Loom', source: 'loom', area: 'alpha', place: 'alpha · bug:Fix login' },
    { agentId: 'loom', agentName: 'Loom', source: 'loom', area: null, place: 'beta · ops: Monitor' },
    { agentId: 'loom', agentName: 'Loom', source: 'loom', area: 'Gamma', place: 'gamma · Plain title' },
    { agentId: 'sierra-ollama', agentName: 'Sierra', source: 'discord', area: null, place: 'chore: tidy' },
    { agentId: 'watson', agentName: 'Watson', source: 'discord', area: null, place: null },
  ];
  const filters = { hideAgents: ['sierra'], hideRepos: ['ALPHA', 'gamma'], hideTypes: ['ops'] };

  it('repos, titles, types and matches agree', () => {
    for (const item of items) {
      expect(ui.itemRepo(item)).toBe(server.itemRepo(item as never));
      expect(ui.itemTitle(item)).toBe(server.itemTitle(item as never));
      expect(ui.itemType(item)).toBe(server.itemType(item as never));
      expect(ui.filterMatches(item, filters)).toEqual(server.filterMatches(item as never, filters));
    }
    for (const title of ['bug:Fix', 'Ops: x', 'https://example.com', 'Re-plan the week in detail: notes', '', 'feat:']) {
      expect(ui.threadType(title)).toBe(server.threadType(title));
    }
  });

  it('facets agree', () => {
    expect(ui.facetsFor(items, filters)).toEqual(server.facetsFor(items as never, filters));
  });
});

describe('the store saves filters safely', () => {
  // A client whose settings saves resolve or fail when the test says so.
  function fakeClient() {
    const pending: Array<{ body: any; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const client = {
      mode: 'live',
      items: async () => ({ items: [], counts: {} }),
      facets: async () => ({ agents: [], repos: [], types: [] }),
      saveSettings: (body: any) => new Promise((resolve, reject) => pending.push({ body, resolve, reject })),
    };
    return { client, pending };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const saved = (filters: object) => ({ sweepDay: 'saturday', filters: { ...none, ...filters } });

  async function makeStore() {
    // @ts-expect-error plain browser module, no types
    const { createStore } = await import('../public/desk/store.js');
    const { client, pending } = fakeClient();
    return { store: createStore(client), pending };
  }

  it('a settings event from another screen wins over this screen’s save still in flight', async () => {
    const { store, pending } = await makeStore();
    const ok = store.toggleFilter('type', 'bug');
    expect(store.state.filters.hideTypes).toEqual(['bug']);
    store.handlers.onSettings(saved({ hideAgents: ['watson'] }));
    pending[0]!.resolve(saved({ hideTypes: ['bug'] }));
    expect(await ok).toBe(true);
    expect(store.state.filters).toEqual({ ...none, hideAgents: ['watson'] });
  });

  it('agent icons: an icon then a color picked before the first save lands keeps both; a refused save rolls back', async () => {
    const { store, pending } = await makeStore();
    store.saveAgentIcons({ sierra: { icon: 'rocket', color: null } });
    expect(store.state.agentIcons.sierra).toEqual({ icon: 'rocket', color: null });
    // The color is picked from what the page shows now: the new icon.
    store.saveAgentIcons({ sierra: { ...store.state.agentIcons.sierra, color: 'rose' } });
    pending[0]!.resolve({ agentIcons: { sierra: { icon: 'rocket', color: null } } });
    await flush(); // settings writes go in order: the second is sent once the first has answered
    pending[1]!.resolve({ agentIcons: { sierra: { icon: 'rocket', color: 'rose' } } });
    await flush();
    expect(store.state.agentIcons.sierra).toEqual({ icon: 'rocket', color: 'rose' });
    const refused = store.saveAgentIcons({ sierra: null });
    expect(store.state.agentIcons.sierra).toBeUndefined();
    pending[2]!.reject(Object.assign(new Error('nope'), { body: { error: 'nope' } }));
    expect(await refused).toBe('nope');
    expect(store.state.agentIcons.sierra).toEqual({ icon: 'rocket', color: 'rose' });
  });

  it('repo icons: saved by the name in lower case, then the server’s answer; a refused save rolls back', async () => {
    const { store, pending } = await makeStore();
    store.saveRepoIcons({ Tango: { icon: 'music', color: null } });
    expect(store.state.repoIcons.tango).toEqual({ icon: 'music', color: null });
    pending[0]!.resolve({ repoIcons: { tango: { icon: 'music', color: null } } });
    await flush();
    const refused = store.saveRepoIcons({ tango: null });
    expect(store.state.repoIcons.tango).toBeUndefined();
    pending[1]!.reject(Object.assign(new Error('nope'), { body: { error: 'nope' } }));
    expect(await refused).toBe('nope');
    expect(store.state.repoIcons.tango).toEqual({ icon: 'music', color: null });
    store.handlers.onSettings({ repoIcons: { acme: { icon: 'mountain', color: 'rose' } } });
    expect(store.state.repoIcons).toEqual({ acme: { icon: 'mountain', color: 'rose' } });
  });

  it('icons: a settings event from another screen wins over this screen’s icon save still in flight', async () => {
    const { store, pending } = await makeStore();
    const ok = store.saveRepoIcons({ tango: { icon: 'music', color: null } });
    const agent = store.saveAgentIcons({ sierra: { icon: 'rocket', color: null } });
    const newer = { repoIcons: { tango: { icon: 'music', color: null }, acme: { icon: 'mountain', color: null } }, agentIcons: { sierra: { icon: 'rocket', color: null }, watson: { icon: 'calendar', color: null } } };
    store.handlers.onSettings(newer);
    pending[0]!.resolve({ repoIcons: { tango: { icon: 'music', color: null } } });
    await flush(); // settings writes go in order: the second is sent once the first has answered
    pending[1]!.resolve({ agentIcons: { sierra: { icon: 'rocket', color: null } } });
    expect(await ok).toBeNull();
    expect(await agent).toBeNull();
    expect(store.state.repoIcons).toEqual(newer.repoIcons);
    expect(store.state.agentIcons).toEqual(newer.agentIcons);
  });

  it('a failed save in flight does not roll back a newer settings event', async () => {
    const { store, pending } = await makeStore();
    const ok = store.toggleFilter('type', 'bug');
    store.handlers.onSettings(saved({ hideRepos: ['alpha'] }));
    pending[0]!.reject(new Error('network'));
    expect(await ok).toBe(false);
    expect(store.state.filters).toEqual({ ...none, hideRepos: ['alpha'] });
  });

  it('a failed save with nothing newer rolls back and says so', async () => {
    const { store, pending } = await makeStore();
    const ok = store.toggleFilter('agent', 'sierra');
    pending[0]!.reject(new Error('network'));
    expect(await ok).toBe(false);
    expect(store.state.filters).toEqual(none);
    expect(store.state.toasts.map((t: any) => t.text)).toEqual(['Mute didn’t save: network']);
  });

  it('Show announces "Back on the board" only after the save succeeds', async () => {
    const { store, pending } = await makeStore();
    store.handlers.onSettings(saved({ hideAgents: ['watson'] }));
    const shown = store.showFiltered([{ facet: 'agent', value: 'watson' }]);
    await flush();
    expect(store.state.toasts).toEqual([]);
    pending[0]!.resolve(saved({}));
    expect(await shown).toBe(true);
    expect(store.state.toasts.map((t: any) => t.text)).toEqual(['Unmuted']);

    store.handlers.onSettings(saved({ hideAgents: ['watson'] }));
    const failed = store.showFiltered([{ facet: 'agent', value: 'watson' }]);
    pending[1]!.reject(new Error('offline'));
    expect(await failed).toBe(false);
    expect(store.state.filters.hideAgents).toEqual(['watson']);
    expect(store.state.toasts.map((t: any) => t.text)).toEqual(['Unmuted', 'Mute didn’t save: offline']);
  });
});

describe('text size (this device)', () => {
  const stubs = () => {
    const stored = new Map<string, string>();
    const props = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    };
    (globalThis as Record<string, unknown>).document = { documentElement: { style: { setProperty: (k: string, v: string) => void props.set(k, v) } } };
    return { stored, props };
  };

  it('defaults to 1.2, saves a pick for this device, clamps, and forgets a reset to the default', () => {
    const { stored, props } = stubs();
    expect(ui.savedTextScale()).toBe(1.2);
    expect(ui.applyTextScale(1.47, { save: true })).toBe(1.45);
    expect(props.get('--scale')).toBe('1.45');
    expect(ui.savedTextScale()).toBe(1.45);
    expect(ui.applyTextScale(9, { save: true })).toBe(2);
    ui.applyTextScale(1.2, { save: true });
    expect(stored.size).toBe(0);
  });

  it('blocked storage still renders at the default', () => {
    stubs();
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(ui.savedTextScale()).toBe(1.2);
    expect(ui.applyTextScale(1.5, { save: true })).toBe(1.5);
  });
});

describe('List preview lines (this device)', () => {
  const stubs = () => {
    const stored = new Map<string, string>();
    const props = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    };
    (globalThis as Record<string, unknown>).document = { documentElement: { style: { setProperty: (k: string, v: string) => void props.set(k, v) } } };
    return { stored, props };
  };

  it('defaults to 3, saves a pick for this device, and forgets a reset to the default', () => {
    const { stored, props } = stubs();
    expect(ui.savedPreviewLines()).toBe(3);
    expect(ui.applyPreviewLines(5, { save: true })).toBe(5);
    expect(props.get('--list-lines')).toBe('5');
    expect(props.get('--list-body')).toBe('-webkit-box');
    expect(ui.savedPreviewLines()).toBe(5);
    ui.applyPreviewLines(3, { save: true });
    expect(stored.size).toBe(0);
  });

  it('All lifts the clamp, None hides the paragraph, and a stray value falls back to 3', () => {
    const { props } = stubs();
    expect(ui.applyPreviewLines('all', { save: true })).toBe('all');
    expect(props.get('--list-lines')).toBe('none');
    expect(ui.savedPreviewLines()).toBe('all');
    expect(ui.applyPreviewLines(0, { save: true })).toBe(0);
    expect(props.get('--list-body')).toBe('none');
    expect(ui.savedPreviewLines()).toBe(0);
    expect(ui.applyPreviewLines(42)).toBe(3);
  });
});
