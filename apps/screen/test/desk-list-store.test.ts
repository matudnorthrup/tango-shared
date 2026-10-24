import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// The lists a device kept from its last visit (list-cache.js): a reload paints at once and asks only for changes.

const list = (title: string) => ({ items: [{ id: 'loom:a', title, nextStep: 'your_move', disposition: 'active', seen: 'seen', facts: {}, labels: [] }], counts: { active: 1 }, sweep: null });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeCache(entries: Record<string, unknown> = {}) {
  const writes: Array<[string, any]> = [];
  return { writes, read: async (key: string) => (entries[key] as any) ?? null, write: async (key: string, value: unknown) => void writes.push([key, value]) };
}

/** A store on a page served as `build`, whose server answers each list with `answer(view, etag)`. */
function setup(build: string, cache: ReturnType<typeof fakeCache>, answer: (view: string, etag: string | null) => unknown) {
  const asked: Array<[string, string | null]> = [];
  (globalThis as any).document = { querySelector: () => ({ getAttribute: () => build }) };
  const store = createStore(
    {
      mode: 'live',
      itemsIfChanged: async ({ view, etag }: { view: string; etag: string | null }) => (asked.push([view, etag]), answer(view, etag)),
    },
    { listCache: cache },
  );
  delete (globalThis as any).document;
  return { store, asked };
}

afterEach(() => delete (globalThis as any).document);

describe('lists kept on the device', () => {
  it('same build: shown before the server answers, and a 304 keeps them', async () => {
    const cache = fakeCache({ 'active|step': { group: 'step', etag: '"e1"', build: 'b1', data: list('Kept') } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { store, asked } = setup('b1', cache, async (view) => (await held, view === 'active' ? { notModified: true } : { ...list(view), etag: `"${view}"` }));
    await store.restoreLists();
    expect(store.state.lists.active).toMatchObject({ loaded: true, items: [{ title: 'Kept' }] });
    store.refreshLists(0);
    await tick();
    expect(asked.find(([view]) => view === 'active')).toEqual(['active', '"e1"']);
    release();
    await tick();
    expect(store.state.lists.active.items[0].title).toBe('Kept');
    // The lists it had no copy of came whole, and were kept for next time.
    expect(cache.writes.map(([key]) => key).sort()).toEqual(['everything|step', 'history|step', 'snoozed|step']);
    expect(cache.writes[0]![1]).toMatchObject({ group: 'step', build: 'b1', etag: expect.stringMatching(/^"/) });
  });

  it('another build (a deploy): not shown until the server says it is unchanged', async () => {
    const cache = fakeCache({ 'active|step': { group: 'step', etag: '"e1"', build: 'b0', data: list('Kept') } });
    const { store, asked } = setup('b1', cache, async (view) => (view === 'active' ? { notModified: true } : { ...list(view), etag: `"${view}"` }));
    await store.restoreLists();
    expect(store.state.lists.active.loaded).toBe(false);
    store.refreshLists(0);
    await tick();
    await tick();
    expect(asked.find(([view]) => view === 'active')).toEqual(['active', '"e1"']);
    expect(store.state.lists.active).toMatchObject({ loaded: true, items: [{ title: 'Kept' }] });
  });

  it('a changed list replaces the kept one, and is kept in its place', async () => {
    const cache = fakeCache({ 'active|step': { group: 'step', etag: '"e1"', build: 'b1', data: list('Kept') } });
    const { store } = setup('b1', cache, async (view) => ({ ...list(view === 'active' ? 'Fresh' : view), etag: `"${view}-2"` }));
    await store.restoreLists();
    store.refreshLists(0);
    await tick();
    await tick();
    expect(store.state.lists.active.items[0].title).toBe('Fresh');
    expect(cache.writes.find(([key]) => key === 'active|step')![1]).toMatchObject({ etag: '"active-2"', data: { items: [{ title: 'Fresh' }] } });
    expect(cache.writes.find(([key]) => key === 'active|step')![1].data.etag).toBeUndefined();
  });
});

describe('a list update keeps what did not change', () => {
  it('an item that came back the same keeps its object (its row is not redrawn); a changed one is new', async () => {
    let round = 0;
    const two = () => ({ items: [{ id: 'loom:a', title: 'Same' }, { id: 'loom:b', title: round ? 'Changed' : 'Before' }], counts: {}, sweep: null, etag: `"r${round}"` });
    const { store } = setup('b1', fakeCache(), async (view) => (view === 'active' ? two() : { ...list(view), etag: `"${view}"` }));
    store.refreshLists(0);
    await tick();
    await tick();
    const [a1, b1] = store.state.lists.active.items;
    round = 1;
    store.refreshLists(0);
    await tick();
    await tick();
    const [a2, b2] = store.state.lists.active.items;
    expect(a2).toBe(a1);
    expect(b2).not.toBe(b1);
    expect(b2.title).toBe('Changed');
  });
});
