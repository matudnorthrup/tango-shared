import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module
import { createStore } from '../public/desk/store.js';

afterEach(() => vi.useRealTimers());
describe('project move confirmations', () => {
  it.each([
    ['picked', 'owner', {}, 'Moved to Two · reports to Lead'],
    ['automatic', undefined, { parentItemId: 'owner', previousParentItemId: 'old' }, 'Moved to Two · now reports to Lead'],
    ['no lead', undefined, { parentItemId: null, previousParentItemId: 'old' }, 'Moved to Two · reports to no one yet'],
    ['kept', undefined, {}, 'Moved to Two'],
  ])('%s', async (_label, parentItemId, outcome, message) => {
    vi.useFakeTimers();
    const command = vi.fn(async () => ({ status: 'applied', outcome }));
    const store = createStore({ mode: 'fixtures', command });
    store.set({ projects: [{ id: 'p2', name: 'Two' }], lists: { active: { items: [{ id: 'owner', source: 't3', place: 'Lead', facts: {}, disposition: 'active' }] } } });
    await store.setProject('worker', 'p2', parentItemId);
    expect(command.mock.calls[0]).toEqual([expect.objectContaining({ type: 'project', itemId: 'worker', args: { projectId: 'p2', ...(parentItemId ? { parentItemId } : {}) } })]);
    expect(store.state.toasts.at(-1).text).toBe(message);
    vi.clearAllTimers();
  });
});
