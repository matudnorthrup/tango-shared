import { describe, expect, it } from 'vitest';

// Done (from a key, the ⋯ menu or a button) acts on the thread as the page shows it: an open thread's loaded
// detail beats an older list copy (Codex review on #634).

describe('Done acts on what is shown', () => {
  async function makeStore() {
    // @ts-expect-error plain browser module, no types
    const { createStore } = await import('../public/desk/store.js');
    const sent: Array<{ type: string; itemId: string; args: Record<string, unknown> }> = [];
    const client = {
      mode: 'live',
      items: async () => ({ items: [], counts: {} }),
      facets: async () => ({ agents: [], repos: [], types: [] }),
      command: async (c: { type: string; itemId: string; args: Record<string, unknown> }) => (sent.push(c), { status: 'sent' }),
      present: async () => ({ ok: true }),
    };
    return { store: createStore(client), sent };
  }

  it('a list copy still snoozed sends no stale guard when the open thread shows it active', async () => {
    const { store, sent } = await makeStore();
    const id = 'loom:x';
    store.set({
      byId: { [id]: { id, disposition: 'snoozed', attentionUpdatedAt: 5, facts: {} } },
      detail: { id, item: { id, disposition: 'active', attentionUpdatedAt: 9, facts: {} } },
      presentation: { view: 'conversation', itemId: id },
    });
    await store.done(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'done', itemId: id });
    expect(sent[0]!.args).not.toHaveProperty('ifStateAt');
  });

  it('a running job the open thread shows asks first, even when the list copy has none', async () => {
    const { store, sent } = await makeStore();
    const id = 'loom:y';
    const job = { name: 'npm test', since: 1 };
    store.set({
      byId: { [id]: { id, disposition: 'active', facts: {} } },
      detail: { id, item: { id, disposition: 'active', facts: { job } } },
      presentation: { view: 'conversation', itemId: id },
    });
    await store.done(id);
    expect(sent).toHaveLength(0);
    expect(store.state.confirm).toMatchObject({ kind: 'stopJob', itemId: id });
  });

  it('a control window draws the thread under a stage: its detail is what is shown', async () => {
    const { store, sent } = await makeStore();
    const id = 'loom:w';
    store.set({
      role: 'control',
      byId: { [id]: { id, disposition: 'snoozed', attentionUpdatedAt: 5, facts: {} } },
      detail: { id, item: { id, disposition: 'active', facts: {} } },
      presentation: { view: 'screen', itemId: id, sceneId: 's1' },
    });
    await store.done(id);
    expect(sent[0]!.args).not.toHaveProperty('ifStateAt');
  });

  it('back on the list, the cached detail no longer counts: the list row is what is shown', async () => {
    const { store, sent } = await makeStore();
    const id = 'loom:z';
    store.set({
      byId: { [id]: { id, disposition: 'snoozed', attentionUpdatedAt: 7, facts: {} } },
      detail: { id, item: { id, disposition: 'active', facts: { job: { name: 'old', since: 1 } } } },
      presentation: { view: 'active' },
    });
    await store.done(id);
    expect(sent[0]!.args).toMatchObject({ ifStateAt: 7 });
    expect(store.state.confirm).toBeNull();
  });
});
