import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
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
  it('tells screens to re-read when a conversation goes away or comes back, without re-posting a line', () => {
    const { updates } = setup({ 'loom:game': 'active' });
    const heard: number[][] = [];
    updates.subscribe((ids) => heard.push(ids));
    for (const type of ['snooze', 'park', 'snooze.expired', 'pickup', 'undo'] as const) {
      updates.onDeskEvent({ type, itemId: 'loom:game', at: Date.now(), actor: 'owner', payload: {}, seq: 1 } as never);
    }
    expect(heard).toEqual([[], [], [], [], []]);
    // Other events don't.
    updates.onDeskEvent({ type: 'message', itemId: 'loom:game', at: Date.now(), actor: 'agent', payload: {}, seq: 2 } as never);
    expect(heard).toHaveLength(5);
  });
  it('a project snoozed, parked or woken tells screens to re-read (createDesk wiring)', async () => {
    const { createDesk } = await import('../server/desk/setup.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-away-'));
    const scenes = new SceneStore(path.join(dir, 'scenes'));
    const down = async (): Promise<never> => { throw new Error('offline'); };
    const desk = createDesk({
      conversationFetch: async () => Response.json({ conversations: [], cursor: 0 }),
      db: scenes.db, hub: new Hub(scenes, async () => 'agent'),
      discord: { channel: async () => ({}), messagesSince: down } as never,
      agents: [{ id: 'test', name: 'Test', homeChannelId: 'c' }], ownerIds: [], rules: null, summarize: down,
      postToBot: async () => 'agent', jobsDir: path.join(dir, 'jobs'), jobBridgeUrl: 'http://127.0.0.1:9/background-jobs',
      collaborationToken: '', githubReviews: false, log: () => {},
    });
    cleanups.push(() => { desk.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    desk.store.setSetting('projects', JSON.stringify([{ id: 'game', name: 'Game', createdAt: 1 }]));
    const heard: number[][] = [];
    desk.updates!.subscribe((ids) => heard.push(ids));
    await desk.core.projectAction('game', { action: 'park' });
    expect(heard).toContainEqual([]);
    heard.length = 0;
    await desk.core.projectAction('game', { action: 'wake' });
    expect(heard).toContainEqual([]);
  });
});
