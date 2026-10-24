import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// Did it and a step tick on a recorded ask carry the revision the card showed (decisions-and-delegation.md, "The
// hand-off ask", stale completions): a refusal as changed reads the desk again so the card shows the record as it is.

function setup(answers: Array<Record<string, unknown>>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let reads = 0;
  const store = createStore({
    mode: 'live',
    resolveAsk: async (id: string, body: Record<string, unknown>) => { calls.push([id, body]); return answers.shift(); },
    chapters: async () => { reads++; return { chapters: [] }; },
  });
  return { store, calls, reads: () => reads };
}

describe('Did it on a recorded ask', () => {
  it('sends the revision the card showed; a refusal as changed reads again and is not retried under the same command', async () => {
    const { store, calls, reads } = setup([{ status: 'failed', error: 'the question changed: this ask was updated since you looked (revision 2); read it again', outcome: { changed: true } }]);
    const ask = { id: 'A-1', kind: 'do', status: 'open', revision: 1, text: 'Connect the backup drive' };
    await expect(store.resolveAsk(ask, { itemId: 'loom:t', step: '1' })).rejects.toMatchObject({ definitive: true, body: { outcome: { changed: true } } });
    expect(calls).toEqual([['A-1', { commandId: expect.any(String), step: '1', revision: 1 }]]);
    expect(reads()).toBe(1);
  });
  it('an older record without a revision sends none, and a plain failure does not read again', async () => {
    const { store, calls, reads } = setup([{ status: 'failed', error: 'Service unavailable' }, { status: 'applied' }]);
    await expect(store.resolveAsk({ id: 'A-2', kind: 'do', status: 'open', text: 'Unlock it' }, { itemId: 'loom:t' })).rejects.toMatchObject({ definitive: true });
    expect(calls[0]).toEqual(['A-2', { commandId: expect.any(String) }]);
    expect(reads()).toBe(0);
    await store.resolveAsk({ id: 'A-2', kind: 'do', status: 'open', revision: 3, text: 'Unlock it' }, { itemId: 'loom:t' });
    expect(calls[1]).toEqual(['A-2', { commandId: expect.any(String), revision: 3 }]);
    expect(reads()).toBe(1);
  });
});
