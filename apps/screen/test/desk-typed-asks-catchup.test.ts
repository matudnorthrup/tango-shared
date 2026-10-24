import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeskUpdates } from '../server/desk/updates.js';
import { applyAccept, cardAsks, planChapter } from '../server/desk/catchup-actions.js';
import { catchupWalk } from '../server/desk/catchup-walk.js';
import { crossFolds } from '../server/desk/triage.js';
import type { DeskItem, RecordedAsk } from '../server/desk/types.js';

const NOW = 1_800_000_000_000;
function setup() {
  const ask: RecordedAsk = { id: 'A-1', kind: 'do', status: 'open', text: 'Connect both backup drives', at: NOW - 10, revision: 1, steps: [{ text: 'Connect first' }, { text: 'Connect second' }] };
  const row = { id: 'loom:sample', source: 'loom', kind: 'thread', conversationKey: 'sample', disposition: 'active', hidden: false, createdAt: NOW - 100, lastActivityAt: NOW, facts: { projectId: 'sample', openAsk: ask, askLedger: ask } } as DeskItem;
  const items = [row];
  const updates = new DeskUpdates({ db: new DatabaseSync(':memory:'), items: () => items, spaceOf: () => 'project:sample', exec: null, now: () => NOW });
  updates.syncStatuses();
  return { updates, items, row, ask };
}

describe('recorded asks in catch-up', () => {
  it('keeps one needs line through revisions and exposes the source card', () => {
    const { updates, items, ask } = setup();
    const first = updates.list()[0]!;
    expect(first.data).toMatchObject({ askId: 'A-1', askKind: 'do', askRevision: 1 });
    ask.revision = 2;
    ask.due = '2027-02-01T12:00:00Z';
    updates.syncStatuses();
    const lines = updates.list();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: first.id, data: { askRevision: 2 } });
    const asks = cardAsks(lines, items);
    expect(asks).toEqual([{ ...ask, itemId: 'loom:sample', lineId: first.id }]);
    const walk = catchupWalk({ chapters: updates.chapters(), projects: [{ id: 'sample', name: 'Sample' }], agents: [], card: () => ({ lines, waiting: [], view: updates.view('project:sample', lines), briefs: [], asks }) });
    expect(walk.focus?.ask).toMatchObject({ id: 'A-1', kind: 'do', steps: ask.steps, due: ask.due });
  });

  it('leaves asks unseen on Accept and still allows Defer', async () => {
    const { updates, items } = setup();
    const plan = planChapter(updates, 'project:sample', items, NOW);
    expect(plan.seen).toEqual([]);
    expect(plan.left).toMatchObject([{ why: 'ask' }]);
    expect(plan.line).toContain('leaves 1 ask for you');
    const result = await applyAccept({ updates, answer: async () => ({ ok: true }), confirm: async () => ({ ok: true }) }, plan, 'accept-test');
    expect(result.applied.seen).toBe(0);
    expect(updates.list()[0]?.seenAt).toBeNull();
    updates.seen(plan.updateIds, 'deferred', null);
    expect(updates.list()[0]?.seenVia).toBe('deferred');
  });

  it('settles from the ledger even when the open pointer was cleared', () => {
    const { updates, row, ask } = setup();
    ask.status = 'done';
    ask.resolved_at = NOW;
    row.facts.openAsk = null;
    updates.recheck();
    expect(updates.list()[0]).toMatchObject({ resolvedAt: NOW, data: { recheck: { source: 'ask:A-1', state: 'settled' } } });
    expect(cardAsks(updates.list(), [row])).toEqual([]);
  });

  it('does not fold different recorded asks together because their words match', () => {
    const { updates, items, ask } = setup();
    items.push({ ...items[0]!, id: 'loom:worker', conversationKey: 'worker', facts: { role: 'worker', parentItemId: 'loom:sample', ownerGone: true, openAsk: { ...ask, id: 'A-2' }, askLedger: { ...ask, id: 'A-2' } } });
    updates.syncStatuses();
    const needs = updates.list().filter((line) => line.kind === 'needs');
    expect(needs.map((line) => line.data.askId).sort()).toEqual(['A-1', 'A-2']);
    // Each stays its own line and counts: the fold across spaces goes by ask id, never by the words of a recorded ask.
    expect(crossFolds(needs, NOW).size).toBe(0);
    expect(updates.chapters().find((chapter) => chapter.spaceId === 'project:sample')).toMatchObject({ needs: 2 });
    expect(cardAsks(needs, items).map((ask) => ask.id).sort()).toEqual(['A-1', 'A-2']);
  });
});
