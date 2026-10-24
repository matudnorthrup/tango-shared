import { afterEach, describe, expect, it } from 'vitest';
import { DeskUpdates } from '../server/desk/updates.js';
import { chapterLines, planChapter } from '../server/desk/catchup-actions.js';
import type { DeskItem } from '../server/desk/types.js';
import { makeHarness } from './desk-harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

// Items as core.items() hands them over: a project's snooze or park is already written onto its conversations.
function setup(dispositions: Record<string, DeskItem['disposition']>, awaySpaces: string[] = []) {
  const h = makeHarness();
  cleanups.push(() => h.close());
  const items = Object.entries(dispositions).map(([id, disposition]) => ({ id, disposition, facts: {}, seen: 'new' }) as unknown as DeskItem);
  const updates = new DeskUpdates({ db: h.db, items: () => items, spaceOf: () => null, awaySpaces: () => new Set(awaySpaces), coverThread: () => {}, exec: null });
  return { updates };
}

describe('Catch me up leaves out snoozed and parked conversations', () => {
  it.each(['parked', 'snoozed'] as const)('a %s conversation\'s space drops out, its lines still unseen', (disposition) => {
    const { updates } = setup({ 'loom:game': disposition, 'loom:desk': 'active' });
    const held = updates.record({ spaceId: 'project:game', itemId: 'loom:game', kind: 'shipped', moment: true, title: 'Game shipped', source: 'test' });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:desk', kind: 'shipped', moment: true, title: 'Desk shipped', source: 'test' });
    expect(updates.chapters().filter((c) => c.state === 'news').map((c) => c.spaceId)).toEqual(['project:desk']);
    expect(chapterLines(updates, 'project:game', Date.now())).toEqual([]);
    // Accept on the space can't mark what it never showed.
    expect(planChapter(updates, 'project:game', [], Date.now()).updateIds).toEqual([]);
    expect(updates.list().find((u) => u.id === held.id)?.seenAt).toBeNull();
  });
  it('keeps an active conversation\'s lines in a space that also holds an away one', () => {
    const { updates } = setup({ 'loom:a': 'active', 'loom:b': 'parked' });
    const kept = updates.record({ spaceId: 'project:desk', itemId: 'loom:a', kind: 'shipped', moment: true, title: 'A shipped', source: 'test' });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:b', kind: 'shipped', moment: true, title: 'B shipped', source: 'test' });
    expect(updates.chapters()[0]).toMatchObject({ spaceId: 'project:desk', state: 'news', moments: 1 });
    expect(chapterLines(updates, 'project:desk', Date.now()).map((u) => u.id)).toEqual([kept.id]);
  });
  it('a parked project drops out whole, its finished conversations\' lines too', () => {
    const { updates } = setup({ 'loom:old': 'done', 'loom:desk': 'active' }, ['project:game']);
    const held = updates.record({ spaceId: 'project:game', itemId: 'loom:old', kind: 'shipped', moment: true, title: 'Game shipped', source: 'test' });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:desk', kind: 'shipped', moment: true, title: 'Desk shipped', source: 'test' });
    expect(updates.chapters().filter((c) => c.state === 'news').map((c) => c.spaceId)).toEqual(['project:desk']);
    expect(chapterLines(updates, 'project:game', Date.now())).toEqual([]);
    expect(updates.list().find((u) => u.id === held.id)?.seenAt).toBeNull();
  });
});
