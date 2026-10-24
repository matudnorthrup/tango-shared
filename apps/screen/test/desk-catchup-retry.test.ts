import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';
// @ts-expect-error plain browser module, no types
import { chapterUnread } from '../public/desk/next/catchup-model.js';

// Catch me up's Done here hears about an Accept, Defer or Got it that only went through on the toast's Retry, and a
// chapter read that failed can be read again (docs/specs/catch-up.md).

const plan = { updateIds: [1], revision: 'r1', line: 'Accept will mark it seen.' };
const fail = () => Object.assign(new Error('offline'), { body: { error: 'offline' } });

function setup(fails: { accept?: number; seen?: number; chapter?: number }) {
  const left = { accept: 0, seen: 0, chapter: 0, ...fails };
  const store = createStore({
    mode: 'live',
    chapters: async () => ({ chapters: [] }),
    chapter: async () => {
      if (left.chapter-- > 0) throw fail();
      return { lines: [], plan, waiting: [] };
    },
    chapterAccept: async () => {
      if (left.accept-- > 0) throw fail();
      return { failed: [] };
    },
    chapterDefer: async () => ({ failed: [] }),
    updatesSeen: async () => {
      if (left.seen-- > 0) throw fail();
      return {};
    },
  });
  const retry = () => store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
  return { store, retry };
}

describe('catch-up retries', () => {
  it('an Accept that goes through on Retry tells the page', async () => {
    const { store, retry } = setup({ accept: 1 });
    await store.loadChapter('project:desk');
    let done = 0;
    expect(await store.chapterAct('project:desk', 'accepted', { name: 'Desk', onDone: () => done++ })).toBe(false);
    expect(done).toBe(0);
    await retry();
    expect(done).toBe(1);
  });

  it('a Got it that goes through on Retry tells the page', async () => {
    const { store, retry } = setup({ seen: 1 });
    let done = 0;
    expect(await store.smallerSeen([{ spaceId: 'project:desk', ids: [4] }], { onDone: () => done++ })).toBe(false);
    expect(done).toBe(0);
    await retry();
    expect(done).toBe(1);
  });

  it('a failed chapter read offers Try again, and reading again clears it', async () => {
    const { store } = setup({ chapter: 1 });
    await store.loadChapter('project:desk');
    expect(chapterUnread(store.state.chapters['project:desk'])).toBe(true);
    await store.loadChapter('project:desk');
    expect(chapterUnread(store.state.chapters['project:desk'])).toBe(false);
    expect(store.state.chapters['project:desk'].data.plan).toEqual(plan);
  });

  it('a desk without catch-up, a read in flight, or one that kept older data is not offered Try again', () => {
    expect(chapterUnread({ data: null, loading: false, error: 'off' })).toBe(false);
    expect(chapterUnread({ data: null, loading: true, error: null })).toBe(false);
    expect(chapterUnread({ data: { lines: [] }, loading: false, error: 'offline' })).toBe(false);
    expect(chapterUnread(undefined)).toBe(false);
  });
});
