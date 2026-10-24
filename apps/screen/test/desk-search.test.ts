import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { DeskSearch, excerpt, parseSearchQuery, type SearchEmbedder } from '../server/desk/search.js';
import { makeHarness, NOW, type Harness } from './desk-harness.js';

// Desk search (TGO-958): what the desk files is searchable at once, stays searchable after the
// desk prunes it, Loom's whole history comes in by backfill, and meaning finds what words miss.

/**
 * Embeds by concept: a word's concept is one axis, so "wifi" lands near "router" with no word in
 * common. A small shared axis keeps texts with no concept from being zero vectors, far from all.
 */
const CONCEPTS: Record<string, number> = { router: 0, wifi: 0, network: 0, access: 0, pizza: 1, dinner: 1, recipe: 1, truck: 2, diesel: 2, engine: 2 };
const fakeEmbedder = (): SearchEmbedder & { calls: number } => ({
  model: 'fake-concepts',
  calls: 0,
  async embed(texts) {
    this.calls += 1;
    return texts.map((text) => {
      const v = [0, 0, 0, 0.2];
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) if (word in CONCEPTS) v[CONCEPTS[word]] += 1;
      return v;
    });
  },
});

let h: Harness;
let item = 0;

/** A desk item with messages, filed the way the sources file them. */
function file(title: string, messages: Array<[author: 'agent' | 'owner', text: string]>, source: 'loom' | 'discord' = 'discord'): string {
  item += 1;
  const id = source === 'loom' ? `loom:thread-${item}` : `discord:thread:${9000 + item}`;
  h.core.ensureItem({ id, source, kind: 'thread', conversationKey: id, agentId: source === 'loom' ? 'loom' : 'sierra', agentName: source === 'loom' ? 'Loom' : 'Sierra', place: title, area: source === 'loom' ? 'tango' : null, createdAt: NOW - 60 * 60_000 }, 'owner');
  messages.forEach(([author, text], n) => h.core.recordMessage(id, { messageId: `${id}:m${n}`, author, at: NOW - (messages.length - n) * 60_000, text }));
  return id;
}

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.close());

describe('parseSearchQuery', () => {
  it('needs every word, in any form, and takes a word being typed as a prefix', () => {
    expect(parseSearchQuery('router restart').match).toBe('("router" OR "router"*) AND ("restart" OR "restart"*)');
  });

  it('keeps quoted phrases together and leaves out -words', () => {
    const parsed = parseSearchQuery('"access point" -speaker');
    expect(parsed).toMatchObject({ match: '"access point"', exclude: '"speaker"' });
    expect(parsed.terms).toEqual(['access point']);
  });

  it('never passes FTS5 syntax through: stray quotes, operators and symbols are just words or nothing', () => {
    expect(parseSearchQuery('NEAR( "unterminated').match).toBe('("NEAR(" OR "NEAR("*) AND "unterminated"');
    expect(parseSearchQuery('-- ** ::').match).toBeNull();
    expect(parseSearchQuery('-only')).toMatchObject({ match: null, exclude: null });
  });
});

describe('DeskSearch: keyword', () => {
  it('a conversation named with every word outranks ones that say only one of them, however often', async () => {
    const search = new DeskSearch({ db: h.db });
    const ledgers = [1, 2].map((n) => file(`Kilo ledger update ${n}`, [['agent', 'The ledger is synced'], ['agent', 'Ledger totals match the bank ledger'], ['owner', 'Thanks for the ledger']]));
    const named = file('Kumquat ledger A', [['owner', 'Reply ready.']]);
    const hits = (await search.search('kumquat ledgers')).hits.map((hit) => hit.itemId);
    expect(hits[0]).toBe(named);
    // Nothing says both words in one message, and a title does: the any-word fallback stays out.
    expect(hits).not.toContain(ledgers[0]);
  });

  it('finds what the desk files, by title and by message, with the words marked', async () => {
    const search = new DeskSearch({ db: h.db });
    const wifi = file('Kitchen speaker drops', [['owner', 'The speaker keeps dropping off'], ['agent', 'Restarting the access point nightly at 4am fixed it']]);
    file('Dinner plans', [['owner', 'What should we cook tonight?']]);

    const byMessage = await search.search('restarting nightly');
    expect(byMessage.hits.map((hit) => hit.itemId)).toEqual([wifi]);
    expect(byMessage.hits[0].matches[0]).toMatchObject({ how: 'keyword', author: 'agent', messageId: `${wifi}:m1` });
    expect(byMessage.hits[0].matches[0].snippet).toContain('\u0002Restarting\u0003');

    // Stemmed: "restart" finds "Restarting"; a prefix finds a word still being typed.
    expect((await search.search('restart')).hits[0]?.itemId).toBe(wifi);
    expect((await search.search('kitch')).hits[0]?.matches[0]).toMatchObject({ how: 'title' });
    expect((await search.search('restart -speaker')).hits).toEqual([]);
  });

  it('ranks a conversation named for the words above one that only mentions them', async () => {
    const search = new DeskSearch({ db: h.db });
    const mention = file('Grocery run', [['agent', 'Also grabbed batteries for the router']]);
    const named = file('Router firmware', [['agent', 'Updated it']]);
    expect((await search.search('router')).hits.map((hit) => hit.itemId)).toEqual([named, mention]);
  });

  it('finds a conversation by the name the owner gave it on the desk', async () => {
    const search = new DeskSearch({ db: h.db });
    const id = file('Truck', [['agent', 'Pads are on order']]);
    await h.core.command({ commandId: 'rename-1', type: 'rename', itemId: id, args: { title: 'Brake job' } });
    expect((await search.search('brake')).hits[0]).toMatchObject({ itemId: id, matches: [{ how: 'title' }] });
  });

  it('rebuilds the item triggers an older desk left, so a rename reaches its index', async () => {
    new DeskSearch({ db: h.db });
    // The trigger as a desk before #550 created it: the title without the owner's name.
    h.db.exec(`DROP TRIGGER desk_items_search_au; CREATE TRIGGER desk_items_search_au AFTER UPDATE ON desk_items BEGIN UPDATE search_docs SET title = COALESCE(new.place, '') WHERE item_id = new.id; END;`);
    const search = new DeskSearch({ db: h.db });
    const id = file('Truck', [['agent', 'Pads are on order']]);
    await h.core.command({ commandId: 'rename-2', type: 'rename', itemId: id, args: { title: 'Brake job' } });
    expect((await search.search('brake')).hits[0]?.itemId).toBe(id);
  });

  it('indexes what the desk held before search existed', async () => {
    const id = file('Truck service', [['agent', 'Oil change booked for Thursday']]);
    const search = new DeskSearch({ db: h.db });
    expect((await search.search('oil change')).hits[0]?.itemId).toBe(id);
  });

  it('keeps a conversation searchable after the desk prunes it', async () => {
    const search = new DeskSearch({ db: h.db });
    const id = file('Old tax question', [['agent', 'The payroll notice is informational']]);
    h.core.store.deleteItem(id);
    expect(h.core.item(id)).toBeNull();
    expect((await search.search('payroll')).hits[0]?.itemId).toBe(id);
    expect(search.doc(id)).toMatchObject({ itemId: id, place: 'Old tax question', agentName: 'Sierra' });
  });

  it('follows a message whose words grew (a streamed reply filed again whole)', async () => {
    const search = new DeskSearch({ db: h.db });
    const id = file('Report', [['agent', 'Working on the']]);
    h.core.store.addMessage({ messageId: `${id}:m0`, itemId: id, author: 'agent', at: NOW, text: 'Working on the quarterly numbers' });
    expect((await search.search('quarterly')).hits[0]?.itemId).toBe(id);
  });
});

describe('DeskSearch: semantic', () => {
  it('finds a conversation by meaning when no word matches, and fuses it with keyword hits', async () => {
    const embedder = fakeEmbedder();
    const search = new DeskSearch({ db: h.db, embedder, semanticFloor: 0.3 });
    const network = file('Kitchen speaker drops', [['agent', 'Restarting the router nightly fixed the speaker dropouts']]);
    file('Weeknight cooking', [['agent', 'Here is a sheet-pan pizza recipe for dinner']]);
    expect(await search.embedPending(5)).toBeGreaterThan(0);
    expect(search.stats().pending).toBe(0);

    const result = await search.search('wifi');
    expect(result.semantic).toBe(true);
    expect(result.hits[0]).toMatchObject({ itemId: network });
    expect(result.hits[0].matches.some((m) => m.how === 'semantic')).toBe(true);
    // The cooking thread is far off: below the floor, not padding the results.
    expect(result.hits.map((hit) => hit.itemId)).toEqual([network]);
  });

  it('narrows semantic candidates before the old 25-conversation limit', async () => {
    const search = new DeskSearch({ db: h.db, embedder: fakeEmbedder(), semanticFloor: 0.3 });
    for (let i = 0; i < 30; i++) file(`Network ${i}`, [['agent', 'Restarting the router nightly fixed it']]);
    const wanted = file('Network last', [['agent', 'Restarting the router nightly fixed it']]);
    await search.embedPending(5);
    const result = await search.search('wifi', { limit: 1, eligible: (id) => id === wanted });
    expect(result).toMatchObject({ semantic: true, total: 1, more: false, hits: [{ itemId: wanted }] });
  });

  it('embeds new words as they arrive and re-embeds a message that changed', async () => {
    const embedder = fakeEmbedder();
    const search = new DeskSearch({ db: h.db, embedder, semanticFloor: 0.3 });
    const id = file('Errands', [['agent', 'Picked up the dry cleaning this afternoon']]);
    await search.embedPending(5);
    expect((await search.search('diesel')).hits).toEqual([]);
    h.core.store.addMessage({ messageId: `${id}:m0`, itemId: id, author: 'agent', at: NOW, text: 'Picked up the dry cleaning this afternoon, then filled the truck with diesel' });
    await search.embedPending(5);
    expect((await search.search('engine')).hits[0]?.itemId).toBe(id);
  });

  it('embeds everything again under a new model', async () => {
    const search = new DeskSearch({ db: h.db, embedder: fakeEmbedder(), semanticFloor: 0.3 });
    file('Network', [['agent', 'Restarting the router nightly fixed it']]);
    await search.embedPending(5);
    const next = { ...fakeEmbedder(), model: 'fake-concepts-v2' };
    const again = new DeskSearch({ db: h.db, embedder: next, semanticFloor: 0.3 });
    expect(again.stats()).toMatchObject({ chunks: 0, pending: 1 });
    await again.embedPending(5);
    expect((await again.search('wifi')).hits).toHaveLength(1);
  });

  it('falls back to keyword search when the embedder fails', async () => {
    const search = new DeskSearch({
      db: h.db,
      embedder: { model: 'down', embed: async () => Promise.reject(new Error('Voyage 503')) },
    });
    const id = file('Router', [['agent', 'rebooted']]);
    const result = await search.search('router');
    expect(result.semantic).toBe(false);
    expect(result.hits[0]?.itemId).toBe(id);
  });

  it('skips one-word replies (keyword search still has them)', async () => {
    const embedder = fakeEmbedder();
    const search = new DeskSearch({ db: h.db, embedder, semanticFloor: 0.3 });
    file('Ok', [['owner', 'Yes, ship it']]);
    await search.embedPending(5);
    expect(search.stats().pending).toBe(0);
    expect(search.stats().chunks).toBe(1); // the conversation's title only
  });
});

describe('DeskSearch: transcript', () => {
  it('pages through a conversation around a match', () => {
    const search = new DeskSearch({ db: h.db });
    const id = file('Long one', Array.from({ length: 50 }, (_, n) => ['agent', `message number ${n}`] as ['agent', string]));
    const around = search.transcript(id, { around: `${id}:m25`, limit: 10 });
    expect(around.messages.map((m) => m.messageId)).toEqual(Array.from({ length: 10 }, (_, n) => `${id}:m${20 + n}`));
    expect(around).toMatchObject({ hasEarlier: true, hasLater: true });
    const earlier = search.transcript(id, { before: `${id}:m20`, limit: 30 });
    expect(earlier.messages[0].messageId).toBe(`${id}:m0`);
    expect(earlier.hasEarlier).toBe(false);
    const latest = search.transcript(id, { limit: 5 });
    expect(latest.messages.at(-1)?.messageId).toBe(`${id}:m49`);
    expect(latest.hasLater).toBe(false);
  });
});

describe('excerpt', () => {
  it('centers on the first term it finds', () => {
    const text = `${'intro '.repeat(80)}the router was fine ${'outro '.repeat(80)}`;
    const out = excerpt(text, ['router'], 60);
    expect(out).toContain('router');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('GET /api/desk/search', () => {
  function app(search: DeskSearch) {
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    return createApp({
      store: scenes,
      hub,
      publicDir: h.dir,
      desk: { routes: { core: h.core, scenes: () => [], search }, compat: { core: h.core, hub, rules: null, pollSources: async () => ({ conversations: 0, messages: 0 }) } as never },
    });
  }

  it('applies facets and grammar before limiting and counting, including archived capability checks', async () => {
    const search = new DeskSearch({ db: h.db });
    file('Router', []);
    const wanted = file('Router in workspace', [], 'loom');
    const archived = file('Router old workspace', [], 'loom');
    h.core.store.deleteItem(archived);
    const api = app(search);
    const body = await (await api.request('/api/desk/search?' + new URLSearchParams({ q: 'router repo:tango', limit: '1', semantic: '0', where: JSON.stringify({ disposition: { in: ['active'] } }) }))).json();
    expect(body).toMatchObject({ total: 1, more: false, tokens: [{ field: 'repo', value: 'tango' }], hits: [{ itemId: wanted }] });
    const fieldOnly = await (await api.request('/api/desk/search?q=repo:tango&limit=1')).json();
    expect(fieldOnly.total).toBe(2);
    expect(fieldOnly.hits).toHaveLength(1);
    const scoped = await (await api.request('/api/desk/search?q=router&scope=space:agent:sierra')).json();
    expect(scoped.total).toBe(1);
    expect((await api.request('/api/desk/search?q=router&where=bad')).status).toBe(400);
  });

  it('include=open searches open conversations only and says what done and archived ones would add', async () => {
    const search = new DeskSearch({ db: h.db });
    const open = file('Kumquat plan', []);
    const snoozed = file('Kumquat order', []);
    h.core.store.saveAttention({ ...h.core.store.attention(snoozed)!, disposition: 'snoozed' });
    const done = file('Kumquat ledger', []);
    h.core.store.saveAttention({ ...h.core.store.attention(done)!, disposition: 'done' });
    const archived = file('Kumquat old', [], 'loom');
    h.core.store.deleteItem(archived);
    const api = app(search);
    const ask = async (params: Record<string, string>) => (await api.request('/api/desk/search?' + new URLSearchParams({ q: 'kumquat', semantic: '0', ...params }))).json();
    const narrow = await ask({ include: 'open' });
    expect(narrow.hits.map((hit: { itemId: string }) => hit.itemId).sort()).toEqual([open, snoozed].sort());
    expect(narrow).toMatchObject({ total: 2, wider: { total: 2, more: false } });
    // Widened (or a caller that doesn't ask, as voice): everything, and nothing more to add.
    const wide = await ask({ include: 'all' });
    expect(wide.total).toBe(4);
    expect(wide.wider).toBeUndefined();
    expect((await ask({})).total).toBe(4);
    // A view that already picks dispositions keeps them: no open-only default on top, no link.
    const history = await ask({ include: 'open', where: JSON.stringify({ disposition: { in: ['done'] } }) });
    expect(history.hits.map((hit: { itemId: string }) => hit.itemId)).toEqual([done]);
    expect(history.wider).toBeUndefined();
  });

  it("include=open decides its candidates as the wide search does: its results stay among the widened ones (Codex review on #865)", async () => {
    const search = new DeskSearch({ db: h.db });
    // Five done threads say both words; the one open thread says only one. Searched alone, the open thread
    // would take the any-word fallback the wide search skips, and widening would drop it.
    for (let n = 0; n < 5; n++) {
      const done = file(`Chat ${n}`, [['owner', 'the fennel lattice is ready']]);
      h.core.store.saveAttention({ ...h.core.store.attention(done)!, disposition: 'done' });
    }
    file('Chat open', [['owner', 'the fennel is ready']]);
    const api = app(search);
    const ask = async (include: string) => (await api.request('/api/desk/search?' + new URLSearchParams({ q: 'fennel lattice', semantic: '0', include }))).json();
    const narrow = await ask('open');
    const wide = await ask('all');
    const wideIds = wide.hits.map((hit: { itemId: string }) => hit.itemId);
    expect(narrow.hits.every((hit: { itemId: string }) => wideIds.includes(hit.itemId))).toBe(true);
    expect(narrow.total + narrow.wider.total).toBe(wide.total);
  });

  it('widening keeps the open results the limit would cut (Codex review on #865)', async () => {
    const search = new DeskSearch({ db: h.db });
    // Done threads named for the word outrank the open one that only says it: a wide page of two would be all done.
    for (let n = 0; n < 3; n++) {
      const done = file(`Quince ${n}`, []);
      h.core.store.saveAttention({ ...h.core.store.attention(done)!, disposition: 'done' });
    }
    const open = file('Chat open', [['owner', 'the quince is ripe']]);
    const api = app(search);
    const ask = async (include: string) => (await api.request('/api/desk/search?' + new URLSearchParams({ q: 'quince', semantic: '0', limit: '2', include }))).json();
    expect((await ask('open')).hits.map((hit: { itemId: string }) => hit.itemId)).toEqual([open]);
    const wide = await ask('all');
    expect(wide.hits.map((hit: { itemId: string }) => hit.itemId)).toContain(open);
    expect(wide.hits).toHaveLength(3);
    expect(wide.total).toBe(4);
  });

  it('resolves agent: and in: names from archived conversations too (Codex review on #799)', async () => {
    const search = new DeskSearch({ db: h.db });
    h.db.prepare("INSERT INTO search_docs (item_id, source, kind, agent_id, agent_name, title) VALUES ('discord:old-1', 'discord', 'thread', 'oldie', 'Old Agent', 'Router plans')").run();
    const api = app(search);
    for (const q of ['router agent:"Old Agent"', 'router in:"Old Agent"']) {
      const body = await (await api.request('/api/desk/search?' + new URLSearchParams({ q, semantic: '0' }))).json();
      expect(body.hits.map((hit: { itemId: string }) => hit.itemId)).toEqual(['discord:old-1']);
    }
  });

  it('returns each hit with its List row: the live item, or a done row for one the desk let go', async () => {
    const search = new DeskSearch({ db: h.db });
    const live = file('Truck tires', [['agent', 'Tire rotation done']]);
    const gone = file('Truck title', [['agent', 'Title transfer filed']]);
    h.core.store.deleteItem(gone);
    const response = await app(search).request('/api/desk/search?q=truck');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hits: Array<{ itemId: string; row: Record<string, unknown> }> };
    const rows = Object.fromEntries(body.hits.map((hit) => [hit.itemId, hit.row]));
    expect(rows[live]).toMatchObject({ id: live, disposition: 'active' });
    expect(rows[gone]).toMatchObject({ id: gone, disposition: 'done', archived: true, place: 'Truck title' });

    const transcript = await app(search).request(`/api/desk/search/transcript/${encodeURIComponent(gone)}`);
    expect(await transcript.json()).toMatchObject({ row: { id: gone, archived: true }, messages: [{ text: 'Title transfer filed' }] });
  });

  it('answers an empty query with nothing, and 404s without search', async () => {
    const search = new DeskSearch({ db: h.db });
    expect(await (await app(search).request('/api/desk/search?q=%20')).json()).toMatchObject({ hits: [] });
    const scenes = new SceneStore(path.join(h.dir, 'scenes2'));
    const hub = new Hub(scenes, async () => 'agent');
    const bare = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => [] }, compat: { core: h.core, hub, rules: null, pollSources: async () => ({ conversations: 0, messages: 0 }) } as never } });
    expect((await bare.request('/api/desk/search?q=x')).status).toBe(404);
  });
});
