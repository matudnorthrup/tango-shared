import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { blankPause, pauseView } from '../public/desk/pause-model.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// The pause pill's logic (voice pause mode): what it says, and that a tap asks the operator to resume.

const paused = { id: 'pause-7', active: true, since: 1000, waiting: 3, still: false, updatedAt: 1000 };

describe('pause pill', () => {
  it('hidden unless the operator is paused', () => {
    expect(pauseView(blankPause())).toBeNull();
    expect(pauseView(null)).toBeNull();
    expect(pauseView({ ...paused, active: false })).toBeNull();
  });

  it('"Paused · N waiting", then "Still paused" after 30 minutes', () => {
    expect(pauseView(paused)).toMatchObject({ label: 'Paused · 3 waiting', waiting: 3, still: false, canResume: true });
    expect(pauseView({ ...paused, waiting: 0 })).toMatchObject({ label: 'Paused · 0 waiting' });
    expect(pauseView({ ...paused, still: true })).toMatchObject({ label: 'Still paused · 3 waiting', still: true });
    expect(pauseView(paused).title).toContain('Yankee, I’m back');
  });

  it('while a resume tap is on its way: "Resuming…", no second tap', () => {
    expect(pauseView(paused, true)).toMatchObject({ label: 'Resuming…', canResume: false });
  });
});

describe('pause pill taps', () => {
  it('a tap sends resume with the id of the pause shown; the next pill clears it', async () => {
    const calls: Array<[string, string]> = [];
    const store = createStore({ mode: 'fixtures', pauseCommand: async (action: string, pauseId: string) => calls.push([action, pauseId]) });
    await store.resumePause(); // not paused: nothing to send
    expect(calls).toEqual([]);
    store.handlers.onPause(paused);
    await store.resumePause();
    expect(calls).toEqual([['resume', 'pause-7']]);
    expect(store.state.pausePending).toBe(true);
    await store.resumePause(); // already on its way
    expect(calls).toHaveLength(1);
    store.handlers.onPause({ ...paused, active: false, waiting: 0 });
    expect(store.state.pausePending).toBe(false);
    expect(pauseView(store.state.pause)).toBeNull();
  });

  it('a refused tap leaves the pill as it was', async () => {
    const store = createStore({
      mode: 'fixtures',
      pauseCommand: async () => {
        throw Object.assign(new Error('409'), { body: { error: 'the voice operator is not connected' } });
      },
    });
    store.handlers.onPause(paused);
    await store.resumePause();
    expect(store.state.pausePending).toBe(false);
    expect(pauseView(store.state.pause)).toMatchObject({ label: 'Paused · 3 waiting' });
  });
});
