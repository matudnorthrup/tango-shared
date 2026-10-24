// @ts-expect-error plain browser module, no types
import { catchupCounts, chapterIndex, placeDot } from '../public/desk/next/catchup-model.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { DeskItem } from '../server/desk/types.js';
import { DeskUpdates, momentFor, nextMorning, SYSTEM_SPACE, UNFILED_SPACE, type UpdatesDecidedSource } from '../server/desk/updates.js';
import { initialAttention, reduceAttention } from '../server/desk/attention.js';
import { plainChapter } from '../server/desk/chapter-writer.js';
import { applyAccept, chapterLines, planChapter, planLine, stale } from '../server/desk/catchup-actions.js';
import { cid, makeHarness, NOW } from './desk-harness.js';

// The catch-up ledger (docs/specs/catch-up.md): typed lines per space, superseding, seen marks, the automatic sources.

const HOUR = 3_600_000;

function item(id: string, over: Partial<DeskItem> & { facts?: Partial<DeskItem['facts']> } = {}): DeskItem {
  return {
    id,
    source: 'loom',
    kind: 'thread',
    conversationKey: id,
    agentId: 'a',
    agentName: 'A',
    place: null,
    area: null,
    channelId: null,
    threadId: null,
    summary: null,
    artifacts: [],
    activity: null,
    watching: null,
    askRecord: null,
    nextStep: 'fyi',
    nextStepBasis: 'x',
    ask: null,
    options: [],
    createdAt: NOW - 10 * HOUR,
    lastActivityAt: NOW - HOUR,
    lastAgentMessageId: null,
    lastOwnerMessageAt: null,
    messageCount: 0,
    labels: [],
    hidden: false,
    revision: 1,
    disposition: 'active',
    seen: 'new',
    snoozeUntil: null,
    snoozeTrigger: null,
    backFromSnooze: false,
    doneAt: null,
    writeback: null,
    attentionUpdatedAt: 0,
    snoozedAtSource: false,
    ...over,
    facts: { ...(over.facts ?? {}) },
  } as DeskItem;
}

function brief(id: string, cls = 'plan-approval') {
  return {
    kind: 'question',
    requestId: `decision:${id}`,
    question: `Approve the ${id} plan?`,
    options: [],
    questions: [{ id: 'decision', header: '', question: '', multiSelect: false, options: [{ label: 'A · Ship it (Recommended)' }, { label: 'B · Wait' }] }],
    at: NOW - 2 * HOUR,
    brief: { id, class: cls, level: 2 },
  } as unknown as DeskItem['facts']['openBrief'];
}

function ledger(items: DeskItem[], extra: Partial<ConstructorParameters<typeof DeskUpdates>[0]> = {}, messages: Record<string, number[]> = {}) {
  const clock = { now: NOW };
  const covered: Array<[string, number]> = [];
  const coveredTo = new Map<string, number>();
  const updates = new DeskUpdates({
    db: new DatabaseSync(':memory:'),
    items: () => items,
    spaceOf: (i) => (i.facts.projectId ? `project:${i.facts.projectId}` : null),
    coverThread: (itemId, until) => {
      covered.push([itemId, until]);
      coveredTo.set(itemId, until);
    },
    thread: { coveredUntil: (itemId) => coveredTo.get(itemId) ?? null, messagesBetween: (itemId, after, before) => (messages[itemId] ?? []).filter((at) => at > after && at < before).length },
    exec: null,
    now: () => clock.now,
    ...extra,
  });
  return { updates, clock, covered };
}

describe('moment rules', () => {
  const routine = (cls: string) => cls === 'merge-when-green';
  it('an open brief always is one; an fyi never; a routine decision never; shipped only when marked', () => {
    expect(momentFor({ kind: 'needs', moment: false }, { routine })).toBe(true);
    expect(momentFor({ kind: 'fyi', moment: true }, { routine })).toBe(false);
    expect(momentFor({ kind: 'decided', moment: true, class: 'merge-when-green' }, { routine })).toBe(false);
    expect(momentFor({ kind: 'decided', class: 'product-choice-in-scope' }, { routine })).toBe(true);
    expect(momentFor({ kind: 'shipped' }, { routine })).toBe(false);
    expect(momentFor({ kind: 'shipped', moment: true }, { routine })).toBe(true);
    expect(momentFor({ kind: 'failed' }, { routine })).toBe(true);
  });

  it('a class the owner keeps saying Fine to becomes routine; a reversal undoes that', () => {
    const { updates, clock } = ledger([]);
    for (let n = 0; n < 3; n += 1) {
      const u = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'plan-approval', title: `restart ${n}`, source: 'auto:decision', subject: `decision:D-${n}` });
      expect(u.moment).toBe(true);
      updates.seen([u.id], 'acted', 'fine');
    }
    expect(updates.routine('plan-approval')).toBe(true);
    expect(updates.record({ spaceId: 'project:p', kind: 'decided', class: 'plan-approval', title: 'restart 4', source: 'auto:decision' }).moment).toBe(false);
    // A reversal made today of a decision from weeks ago still counts: it's measured from when the owner made it.
    const reversed = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'plan-approval', title: 'restart 5', source: 'auto:decision', at: NOW - 29 * 24 * HOUR });
    updates.seen([reversed.id], 'acted', 'undo');
    expect(updates.routine('plan-approval')).toBe(false);
    clock.now += 2 * 24 * HOUR;
    expect(updates.routine('plan-approval')).toBe(false);
  });
});

describe('the ledger', () => {
  it('a newer line on the same subject replaces the older; the same news again is not a new line', () => {
    const { updates } = ledger([]);
    const failed = updates.record({ spaceId: SYSTEM_SPACE, kind: 'failed', title: 'Backup failed', source: 'auto:incident', subject: 'incident:1' });
    expect(updates.record({ spaceId: SYSTEM_SPACE, kind: 'failed', title: 'Backup failed', source: 'auto:incident', subject: 'incident:1' }).id).toBe(failed.id);
    const fixed = updates.record({ spaceId: SYSTEM_SPACE, kind: 'fyi', title: 'Backup failed: resolved', source: 'auto:incident', subject: 'incident:1' });
    expect(fixed.supersedes).toBe(failed.id);
    expect(updates.list().map((u) => u.title)).toEqual(['Backup failed: resolved']);
    expect(updates.get(failed.id)!.supersededBy).toBe(fixed.id);
    // Retracting the newer brings the older back.
    updates.retract('incident:1');
    expect(updates.list().map((u) => u.title)).toEqual(['Backup failed']);
  });

  it('chapters count open moments, waiting briefs and smaller lines; seen marks round-trip and cover each thread', () => {
    const { updates, covered, clock } = ledger([item('loom:t1', { facts: { openBrief: brief('D-1') } })]);
    const needs = updates.record({ spaceId: 'project:p', itemId: 'loom:t1', kind: 'needs', title: 'Approve?', briefId: 'D-1', source: 'auto:brief', subject: 'decision:D-1', at: NOW - 3 * HOUR, coversTo: NOW - 3 * HOUR });
    const fyi = updates.record({ spaceId: 'project:p', itemId: 'loom:t2', kind: 'fyi', title: 'Docs tidied', source: 'auto:done', at: NOW - 2 * HOUR });
    updates.record({ spaceId: 'project:q', kind: 'shipped', title: 'Merged PR #3', source: 'auto:pr', at: NOW - HOUR });
    expect(updates.chapters().map((c) => [c.spaceId, c.state, c.moments, c.needs, c.smaller])).toEqual([
      ['project:p', 'news', 1, 1, 1],
      ['project:q', 'news', 0, 0, 1],
    ]);
    const marked = updates.seen([needs.id, fyi.id], 'read');
    expect(marked.map((u) => [u.seenVia, u.seenAt])).toEqual([['read', NOW], ['read', NOW]]);
    // Only a line with a span moves its thread's read state.
    expect(covered).toEqual([['loom:t1', NOW - 3 * HOUR]]);
    // Seen, but the brief still waits on a pick: it still leads, and still dates the chapter for Oldest first.
    expect(updates.chapters()[0]).toMatchObject({ spaceId: 'project:p', state: 'caught_up', moments: 0, needs: 1, smaller: 0, since: null, oldestAt: NOW - 3 * HOUR });
    expect(updates.list({ unseen: true }).map((u) => u.spaceId)).toEqual(['project:q']);
    // A first mark stands: reading it again doesn't relabel an act.
    updates.seen([needs.id], 'acted', 'A');
    clock.now += 1000;
    expect(updates.seen([needs.id], 'read')[0]).toMatchObject({ seenVia: 'acted', outcome: 'A', seenAt: NOW });
  });

  it('deferred lines are seen until they come back', () => {
    const { updates, clock } = ledger([]);
    const u = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'spend', title: 'Bought a domain', source: 'auto:decision' });
    updates.seen([u.id], 'deferred', 'later', { backAt: NOW + 10 * HOUR });
    expect(updates.chapters()[0]).toMatchObject({ state: 'deferred', moments: 0, backAt: NOW + 10 * HOUR });
    clock.now = NOW + 11 * HOUR;
    expect(updates.chapters()[0]).toMatchObject({ state: 'news', moments: 1 });
    // Read when it's back: it's handled now.
    updates.seen([u.id], 'read');
    expect(updates.chapters()[0]).toMatchObject({ state: 'caught_up' });
  });

  it('a smaller update keeps a deferred chapter deferred; a brief still waiting leads the order, read or not (Codex review on #852)', () => {
    const items = [item('loom:b', { facts: { projectId: 'b', openBrief: brief('D-4') } })];
    const { updates } = ledger(items);
    const u = updates.record({ spaceId: 'project:d', kind: 'shipped', moment: true, title: 'Shipped', source: 'lead', at: NOW - 3 * HOUR });
    updates.seen([u.id], 'deferred', 'later', { backAt: NOW + 10 * HOUR });
    updates.record({ spaceId: 'project:d', kind: 'fyi', title: 'Docs tidied', source: 'lead', at: NOW - HOUR });
    updates.record({ spaceId: 'project:s', kind: 'fyi', title: 'Small', source: 'lead', at: NOW - HOUR });
    updates.syncBriefs();
    updates.seen([updates.latest('decision:D-4')!.id], 'read');
    expect(updates.chapters().map((c) => [c.spaceId, c.state, c.needs])).toEqual([
      ['project:b', 'caught_up', 1],
      ['project:s', 'news', 0],
      ['project:d', 'deferred', 0],
    ]);
    // A new moment brings it back.
    updates.record({ spaceId: 'project:d', kind: 'decided', class: 'product-choice-in-scope', title: 'Picked the fallback', source: 'lead' });
    expect(updates.chapters().find((c) => c.spaceId === 'project:d')).toMatchObject({ state: 'news' });
  });

  it("a brief's own Defer takes it out of today's counts while it still waits; it counts again once back", () => {
    const items = [item('loom:b', { facts: { projectId: 'b', openBrief: brief('D-4') } })];
    const { updates, clock } = ledger(items);
    updates.record({ spaceId: 'project:b', kind: 'shipped', moment: true, title: 'Shipped', source: 'lead', at: NOW - HOUR });
    updates.syncBriefs();
    updates.seen([updates.latest('decision:D-4')!.id], 'deferred', 'later', { backAt: NOW + 10 * HOUR });
    expect(updates.chapters()[0]).toMatchObject({ state: 'news', moments: 1, needs: 0 });
    clock.now = NOW + 11 * HOUR;
    expect(updates.chapters()[0]).toMatchObject({ needs: 1 });
  });

  it('reading a thread marks only the lines it showed, and only its own', () => {
    const { updates } = ledger([]);
    const shown = updates.record({ spaceId: 'project:p', itemId: 'loom:t', kind: 'fyi', title: 'one', source: 'lead', at: NOW - HOUR });
    const notShown = updates.record({ spaceId: 'project:p', itemId: 'loom:t', kind: 'fyi', title: 'two', source: 'lead', at: NOW - HOUR });
    const elsewhere = updates.record({ spaceId: 'project:p', itemId: 'loom:u', kind: 'fyi', title: 'three', source: 'lead', at: NOW - HOUR });
    expect(updates.readThread('loom:t', [shown.id, elsewhere.id])).toEqual([shown.id]);
    expect(updates.get(notShown.id)!.seenAt).toBeNull();
    expect(updates.get(elsewhere.id)!.seenAt).toBeNull();
  });

  it('a deferral that came back is read when the thread shows it, and stays handled', () => {
    const { updates, clock } = ledger([]);
    const u = updates.record({ spaceId: 'project:p', itemId: 'loom:t', kind: 'fyi', title: 'later', source: 'lead' });
    updates.seen([u.id], 'deferred', 'later', { backAt: NOW + HOUR });
    expect(updates.readThread('loom:t', [u.id])).toEqual([]);
    clock.now = NOW + 2 * HOUR;
    expect(updates.readThread('loom:t', [u.id])).toEqual([u.id]);
    expect(updates.get(u.id)).toMatchObject({ seenVia: 'read', backAt: null });
    expect(updates.chapters()[0].state).toBe('caught_up');
  });
});

describe('next morning', () => {
  it('is today at the morning time when it is still ahead, else tomorrow', () => {
    const base = new Date(NOW);
    base.setHours(4, 0, 0, 0);
    const early = base.getTime();
    expect(new Date(nextMorning(early, '06:00')).getHours()).toBe(6);
    expect(nextMorning(early, '06:00') - early).toBe(2 * HOUR);
    expect(nextMorning(early + 3 * HOUR, '06:00') - early).toBe(26 * HOUR);
  });
});

describe('covering threads', () => {
  it('seen spans cover a thread only while they join up; a gap holds the later span until it is filled', () => {
    const at = (h: number) => NOW - h * HOUR;
    const { updates, covered } = ledger([], {}, { 'loom:t': [at(9), at(8), at(6), at(4), at(3), at(1)] });
    const first = updates.record({ spaceId: 'project:p', itemId: 'loom:t', kind: 'fyi', title: 'first', source: 'lead', coversFrom: at(9), coversTo: at(8) });
    const third = updates.record({ spaceId: 'project:p', itemId: 'loom:t', kind: 'fyi', title: 'third', source: 'lead', coversFrom: at(4), coversTo: at(3) });
    const second = updates.record({ spaceId: 'project:p', itemId: 'loom:t', kind: 'fyi', title: 'second', source: 'lead', coversFrom: at(6), coversTo: at(6) });
    updates.seen([third.id], 'read');
    // The message at 9h, 8h and 6h are unseen before it: nothing moves.
    expect(covered).toEqual([]);
    updates.seen([first.id], 'read');
    expect(covered).toEqual([['loom:t', at(8)]]);
    // Filling the gap carries the cover through the span seen earlier.
    updates.seen([second.id], 'read');
    expect(covered).toEqual([['loom:t', at(8)], ['loom:t', at(3)]]);
  });
});

describe('automatic sources', () => {
  it('open briefs are needs lines in the space of the conversation, a worker rolling up to its lead', () => {
    const lead = item('loom:lead', { facts: { projectId: 'desk', carried: [{ from: { itemId: 'loom:w', title: 'Worker' }, pending: brief('D-7')!, why: 'worker', counts: true }] } });
    const worker = item('loom:w', { facts: { role: 'worker', parentItemId: 'loom:lead', carriedBy: { itemId: 'loom:lead', title: 'Lead' }, openBrief: brief('D-7') } });
    const loose = item('loom:x', { facts: { openBrief: brief('D-8', 'spend') } });
    const items = [lead, worker, loose];
    const { updates } = ledger(items);
    updates.syncBriefs();
    const lines = updates.list().reverse();
    expect(lines.map((u) => [u.subject, u.spaceId, u.kind, u.moment, u.detail])).toEqual([
      ['decision:D-7', 'project:desk', 'needs', true, 'Recommended: A · Ship it'],
      ['decision:D-8', UNFILED_SPACE, 'needs', true, 'Recommended: A · Ship it'],
    ]);
    // Still open: no new line.
    updates.syncBriefs();
    expect(updates.list()).toHaveLength(2);
    // Answered (the conversation says it has no brief now): resolved and seen, out of every count.
    items[1] = item('loom:w', { facts: { role: 'worker', parentItemId: 'loom:lead', openBrief: null } });
    // An item not yet read (no openBrief fact at all) keeps its line open.
    items[2] = item('loom:x');
    updates.syncBriefs();
    expect(updates.latest('decision:D-7')).toMatchObject({ seenVia: 'acted' });
    expect(updates.latest('decision:D-7')!.resolvedAt).not.toBeNull();
    expect(updates.latest('decision:D-8')!.resolvedAt).toBeNull();
  });

  it('a brief revised in place keeps its line with the new words; a new revision opens a seen line again', () => {
    const revised = (rev: number, question: string) => ({ ...brief('D-3'), question, brief: { id: 'D-3', class: 'plan-approval', level: 2, revision: rev } }) as unknown as DeskItem['facts']['openBrief'];
    const items = [item('loom:t', { facts: { projectId: 'desk', openBrief: revised(1, 'Approve the plan?') } })];
    const { updates } = ledger(items);
    updates.syncBriefs();
    const line = updates.latest('decision:D-3')!;
    updates.seen([line.id], 'read');
    items[0] = item('loom:t', { facts: { projectId: 'desk', openBrief: revised(2, 'Approve the smaller plan?') } });
    updates.syncBriefs();
    expect(updates.latest('decision:D-3')).toMatchObject({ id: line.id, title: 'Approve the smaller plan?', seenAt: null, data: { revision: 2 } });
    updates.syncBriefs();
    expect(updates.list()).toHaveLength(1);
    // Moved into another project: the open brief goes with it.
    items[0] = item('loom:t', { facts: { projectId: 'studio', openBrief: revised(2, 'Approve the smaller plan?') } });
    updates.syncBriefs();
    expect(updates.latest('decision:D-3')).toMatchObject({ id: line.id, spaceId: 'project:studio' });
  });

  it('pruning keeps the Fines and reversals the learning still reads', () => {
    const { updates, clock } = ledger([]);
    const fine = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'ops-own-machine', title: 'restart', source: 'auto:decision', at: NOW - 40 * 24 * HOUR });
    updates.seen([fine.id], 'acted', 'fine');
    const plain = updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'old note', source: 'lead', at: NOW - 40 * 24 * HOUR });
    expect(updates.prune()).toBe(1);
    expect(updates.get(fine.id)).not.toBeNull();
    expect(updates.get(plain.id)).toBeNull();
    // A reversal made today of a 55-day-old decision is kept for 30 days from today.
    const reversed = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'ops-own-machine', title: 'restart 2', source: 'auto:decision', at: NOW - 55 * 24 * HOUR });
    updates.seen([reversed.id], 'acted', 'undo');
    clock.now += 21 * 24 * HOUR;
    updates.prune();
    expect(updates.get(fine.id)).toBeNull();
    expect(updates.get(reversed.id)).not.toBeNull();
    clock.now += 10 * 24 * HOUR;
    updates.prune();
    expect(updates.get(reversed.id)).toBeNull();
  });

  it('decisions made for the owner replace the brief, page by page, and remember where they read to', async () => {
    const items = [item('loom:t', { facts: { projectId: 'desk', openBrief: brief('D-9', 'product-choice-in-scope') } })];
    const calls: number[] = [];
    const rows = [
      { id: 'D-9', thread_id: 't', thread_title: 't', class: 'product-choice-in-scope', level: 3, status: 'defaulted' as const, summary: 'Default ran: A · Ship it', undo: 'revert #12', ref: 'https://github.com/o/r/pull/12', at: NOW - HOUR, reversed_at: null, reversal: null, rule: null },
      { id: 'D-10', thread_id: 't', thread_title: 't', class: 'merge-when-green', level: 4, status: 'acted' as const, summary: 'Merged #12 once green', undo: null, ref: null, at: NOW - HOUR / 2, reversed_at: null, reversal: null, rule: null },
    ];
    const rules = [
      { id: 'E-1', kind: 'rule-created', at: NOW - HOUR / 3, rule: 'R-9', class: 'merge-when-green', decision: 'D-10', thread_id: 't', from_level: null, to_level: 4, text: 'R-9: merge once green without asking', rule_choice: 'always' as const, state: 'active' },
      { id: 'E-2', kind: 'rule-retired', at: NOW - HOUR / 3, rule: 'R-1', class: 'x', decision: null, thread_id: null, from_level: null, to_level: null, text: 'retired', rule_choice: null, state: null },
    ];
    const decided: UpdatesDecidedSource = {
      async decided(since) {
        calls.push(since);
        return { decisions: rows.filter((r) => r.at >= since), more: false, rules };
      },
    };
    const { updates } = ledger(items, { decided });
    updates.syncBriefs();
    await updates.syncDecided();
    const d9 = updates.latest('decision:D-9')!;
    expect(d9).toMatchObject({ kind: 'decided', moment: true, spaceId: 'project:desk', detail: 'Undo: revert #12', data: { undo: 'revert #12' }, refs: [{ label: 'github.com/o/r/pull/12', url: 'https://github.com/o/r/pull/12' }] });
    expect(updates.get(d9.supersedes!)!.resolvedAt).toBe(NOW - HOUR);
    expect(updates.latest('decision:D-10')).toMatchObject({ moment: false });
    await updates.syncDecided();
    expect(calls).toEqual([NOW - 24 * HOUR, NOW - HOUR / 2 + 1]);
    // A rule created is always a moment, even on a routine class, and keeps what its controls need.
    expect(updates.latest('rule:E-1')).toMatchObject({ kind: 'decided', moment: true, decisionId: 'D-10', data: { ruleEvent: 'rule-created', rule: 'R-9', ruleChoice: 'always' } });
    expect(updates.latest('rule:E-2')).toBeNull();
    expect(updates.chapters()[0]).toMatchObject({ moments: 2, needs: 0, smaller: 1 });
  });

  it('what the owner acknowledged on the retired Decided for you card stays seen: lines written before, and after', async () => {
    const items = [item('loom:t', { facts: { projectId: 'desk' } })];
    const row = (id: string, at: number) => ({ id, thread_id: 't', thread_title: 't', class: 'product-choice-in-scope', level: 3, status: 'acted' as const, summary: id, undo: null, ref: null, at, reversed_at: null, reversal: null });
    const rows = [row('D-1', NOW - 3 * HOUR)];
    const rules = [{ id: 'E-1', kind: 'rule-created', at: NOW - 2 * HOUR, rule: 'R-9', class: 'x', decision: 'D-2', thread_id: 't', from_level: null, to_level: 4, text: 'R-9', rule_choice: 'always' as const, state: 'active' }];
    const decided: UpdatesDecidedSource = { async decided(since) { return { decisions: rows.filter((r) => r.at >= since), more: false, rules }; } };
    const db = new DatabaseSync(':memory:');
    // The parent release: the ledger wrote D-1 unseen while the card was the owner's way to see it.
    await ledger(items, { db, decided }).updates.syncDecided();
    expect(ledger(items, { db }).updates.latest('decision:D-1')!.seenAt).toBeNull();
    // The owner pressed Seen on the card at NOW - HOUR, then upgraded; D-2 (before the cursor) and D-3 (after) arrive.
    rows.push(row('D-2', NOW - 2 * HOUR), row('D-3', NOW - HOUR / 2));
    const { updates } = ledger(items, { db, decided, decidedSeenAt: () => NOW - HOUR });
    await updates.syncDecided();
    expect(updates.latest('decision:D-1')).toMatchObject({ seenVia: 'read' });
    expect(updates.latest('decision:D-2')).toMatchObject({ seenVia: 'read' });
    expect(updates.latest('decision:D-3')).toMatchObject({ seenAt: null });
    expect(updates.latest('rule:E-1')).toMatchObject({ seenVia: 'read' });
    // Once only: a line the owner reopens later isn't marked again by the cursor.
    db.prepare("UPDATE desk_updates SET seen_at = NULL, seen_via = NULL WHERE subject = 'decision:D-1'").run();
    await updates.syncDecided();
    expect(updates.latest('decision:D-1')!.seenAt).toBeNull();
  });

  it('incidents: open critical or error ones fail in the System space, then resolve to an fyi', () => {
    const { updates } = ledger([item('system:incident:4', { source: 'system', facts: { failed: { at: NOW - HOUR, reason: 'error', message: 'Backup failed' } } })]);
    const iso = (ms: number) => new Date(ms).toISOString();
    const open = { id: 4, title: 'Backup failed', severity: 'critical', status: 'open', firstSeen: iso(NOW - HOUR), lastSeen: iso(NOW - HOUR), resolvedAt: null };
    updates.syncIncidents([open, { ...open, id: 5, severity: 'warning' }, { ...open, id: 6, firstSeen: iso(NOW - 30 * 24 * HOUR) }]);
    expect(updates.list().map((u) => [u.subject, u.kind, u.moment, u.itemId])).toEqual([['incident:4', 'failed', true, 'system:incident:4']]);
    // Held on the System page: handled. Open again later: news again.
    updates.syncIncidents([{ ...open, status: 'acked' }]);
    expect(updates.latest('incident:4')).toMatchObject({ kind: 'failed', seenVia: 'acted', outcome: 'acked' });
    expect(updates.chapters()[0].state).toBe('caught_up');
    updates.syncIncidents([{ ...open, lastSeen: iso(NOW) }]);
    expect(updates.latest('incident:4')).toMatchObject({ kind: 'failed', seenAt: null, at: NOW });
    updates.syncIncidents([{ ...open, lastSeen: iso(NOW) }]);
    expect(updates.list()).toHaveLength(1);
    updates.syncIncidents([{ ...open, status: 'resolved', resolvedAt: iso(NOW) }]);
    expect(updates.list().map((u) => [u.kind, u.title, u.moment])).toEqual([['fyi', 'Backup failed: resolved', false]]);
  });

  it('a merged PR a conversation linked is a shipped line; open ones are asked about again later, closed ones never', async () => {
    const asked: string[] = [];
    const state: Record<string, string> = { '12': 'MERGED', '13': 'OPEN', '14': 'CLOSED' };
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === 'auth') return '';
      const n = args[2].split('/').pop()!;
      asked.push(n);
      return JSON.stringify({ state: state[n], mergedAt: new Date(NOW - HOUR).toISOString(), title: `PR ${n}` });
    };
    const artifacts = ['12', '13', '14'].map((n) => ({ kind: 'pr' as const, label: `PR #${n}`, url: `https://github.com/o/r/pull/${n}` }));
    const { updates, clock } = ledger([item('loom:t', { artifacts, facts: { projectId: 'desk' } })], { exec });
    await updates.syncPullRequests();
    expect(updates.list().map((u) => [u.subject, u.kind, u.title, u.spaceId])).toEqual([['pr:o/r#12', 'shipped', 'Merged PR #12: PR 12', 'project:desk']]);
    await updates.syncPullRequests();
    expect(asked).toEqual(['12', '13', '14']);
    clock.now += 11 * 60_000;
    await updates.syncPullRequests();
    expect(asked).toEqual(['12', '13', '14', '13']);
  });

  it('a merged PR tells onMerged every conversation that linked it, once', async () => {
    const exec = async (_cmd: string, args: string[]) => (args[0] === 'auth' ? '' : JSON.stringify({ state: 'MERGED', mergedAt: new Date(NOW - HOUR).toISOString(), title: 'Importer' }));
    const artifacts = [{ kind: 'pr' as const, label: 'PR #12', url: 'https://github.com/o/r/pull/12' }];
    const merged: Array<[string, number, string]> = [];
    const items = [item('loom:worker', { artifacts, createdAt: NOW - 2 * HOUR, facts: { projectId: 'desk', role: 'worker' } }), item('loom:lead', { artifacts, createdAt: NOW - HOUR, facts: { projectId: 'desk', role: 'default' } })];
    const { updates } = ledger(items, { exec, onMerged: async (linked, pr) => (merged.push([linked.id, pr.number, pr.title]), true) });
    await updates.syncPullRequests();
    await updates.syncPendingMerged();
    await updates.syncPullRequests();
    await updates.syncPendingMerged();
    expect(merged).toEqual([['loom:worker', 12, 'Importer'], ['loom:lead', 12, 'Importer']]);
  });

  it('a merge the hook could not deliver is asked again next pass, and given up on after a day', async () => {
    const exec = async (_cmd: string, args: string[]) => (args[0] === 'auth' ? '' : JSON.stringify({ state: 'MERGED', mergedAt: new Date(NOW - HOUR).toISOString(), title: 'Importer' }));
    const artifacts = [{ kind: 'pr' as const, label: 'PR #12', url: 'https://github.com/o/r/pull/12' }];
    const items = [item('loom:worker', { artifacts, createdAt: NOW - 2 * HOUR, facts: { projectId: 'desk', role: 'worker' } })];
    let up = false;
    const calls: string[] = [];
    const { updates } = ledger(items, { exec, onMerged: async (linked) => (calls.push(linked.id), up) });
    await updates.syncPullRequests();
    await updates.syncPendingMerged();
    await updates.syncPendingMerged();
    up = true;
    await updates.syncPendingMerged();
    await updates.syncPendingMerged();
    expect(calls).toEqual(['loom:worker', 'loom:worker', 'loom:worker']);

    // Never taken: dropped after a day.
    const late = ledger(items, { exec, onMerged: async (linked) => (calls.push(`late:${linked.id}`), false) });
    await late.updates.syncPullRequests();
    late.clock.now += 2 * 24 * HOUR;
    await late.updates.syncPendingMerged();
    await late.updates.syncPendingMerged();
    expect(calls.filter((c) => c.startsWith('late:'))).toEqual([]);
  });
});

describe('settled and undone', () => {
  it('a settled chapter is a line; undoing the settle takes it back', () => {
    const items = [item('discord:chapter:1', { source: 'discord', summary: { headline: 'Nine charges sorted' } as never, facts: { projectId: 'p' } })];
    const { updates } = ledger(items);
    updates.onDeskEvent({ type: 'chapter.settled', itemId: 'discord:chapter:1', at: NOW, actor: 'system', payload: {}, seq: 5 });
    expect(updates.latest('done:discord:chapter:1')).toMatchObject({ kind: 'fyi', seenAt: null });
    updates.onDeskEvent({ type: 'undo', itemId: 'discord:chapter:1', at: NOW + 1, actor: 'owner', payload: { type: 'chapter.settled', seq: 5 }, seq: 6 });
    expect(updates.latest('done:discord:chapter:1')).toBeNull();
  });
});

describe('seen via update', () => {
  it('judges newer activity by message times, not when the poll filed it', () => {
    // The agent wrote at NOW; the poll filed it a minute later (the attention clock).
    const state = { ...initialAttention('loom:t'), seen: 'updated' as const, updatedAt: NOW + 60_000 };
    const seen = reduceAttention(state, { type: 'seen', at: NOW + 120_000, actor: 'system', payload: { via: 'update', until: NOW, newest: NOW } });
    expect(seen).toMatchObject({ seen: 'seen', coveredUntil: NOW });
    const newer = reduceAttention(state, { type: 'seen', at: NOW + 120_000, actor: 'system', payload: { via: 'update', until: NOW, newest: NOW + 30_000 } });
    expect(newer).toMatchObject({ seen: 'updated', coveredUntil: NOW });
  });
});

describe('done before a summary', () => {
  it('records the line once the summary is written', () => {
    const items = [item('loom:t', { disposition: 'done', facts: { projectId: 'p' } })];
    const { updates } = ledger(items);
    updates.onDeskEvent({ type: 'source.done', itemId: 'loom:t', at: NOW - 1000, actor: 'system', payload: {}, seq: 1 });
    expect(updates.latest('done:loom:t')).toBeNull();
    updates.syncPendingDone();
    expect(updates.latest('done:loom:t')).toBeNull();
    items[0] = item('loom:t', { disposition: 'done', summary: { headline: 'Shipped the ledger' } as never, facts: { projectId: 'p' } });
    updates.syncPendingDone();
    expect(updates.latest('done:loom:t')).toMatchObject({ kind: 'fyi', at: NOW - 1000, seenAt: null });
  });
});

describe('voice lab scratch threads', () => {
  it('never reach the catch-up, even when marked done after the fence lapsed', () => {
    const summary = { headline: 'Scratch test thread replied and is idle' } as never;
    const items = [
      item('loom:lab', { disposition: 'done', summary, facts: { projectId: 'p' } }),
      item('loom:real', { disposition: 'done', summary: { headline: 'Shipped the ledger' } as never, facts: { projectId: 'p' } }),
    ];
    const { updates } = ledger(items);
    updates.markScratch(['loom:lab']);
    updates.onDeskEvent({ type: 'done', itemId: 'loom:lab', at: NOW, actor: 'owner', payload: {}, seq: 1 });
    updates.onDeskEvent({ type: 'done', itemId: 'loom:real', at: NOW, actor: 'owner', payload: {}, seq: 2 });
    expect(updates.latest('done:loom:lab')).toBeNull();
    expect(updates.latest('done:loom:real')).not.toBeNull();
  });

  it('takes back a line recorded before the thread was marked scratch', () => {
    const items = [item('loom:lab', { disposition: 'done', summary: { headline: 'Banner color still undecided' } as never, facts: { projectId: 'p' } })];
    const { updates } = ledger(items);
    updates.onDeskEvent({ type: 'done', itemId: 'loom:lab', at: NOW, actor: 'owner', payload: {}, seq: 1 });
    expect(updates.latest('done:loom:lab')).not.toBeNull();
    updates.record({ spaceId: 'project:p', itemId: 'loom:lab', kind: 'fyi', title: 'Banner color still undecided', source: 'lead', subject: 'lead:u1', at: NOW });
    updates.markScratch(['loom:lab']);
    expect(updates.latest('done:loom:lab')).toBeNull();
    expect(updates.latest('lead:u1')).toBeNull();
  });
});

describe('on the desk', () => {
  it('Done is a line (seen when the owner did it), undo takes it back, reading marks what the thread showed, and seeing a line covers its thread', async () => {
    const h = makeHarness();
    try {
      const { core } = h;
      core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'a', agentName: 'A', summary: { headline: 'Merged and deployed the ledger', gist: 'it works' } as never });
      const updates = new DeskUpdates({ db: h.db, items: () => core.items(), spaceOf: () => 'project:desk', coverThread: (id, until) => core.coverThread(id, until), thread: { coveredUntil: (id) => core.store.attention(id)?.coveredUntil ?? null, messagesBetween: (id, a, b) => core.store.messagesBetween(id, a, b) }, exec: null, now: () => h.clock.now });
      core.subscribe((event) => {
        if (event.type === 'activity') updates.onDeskEvent(event.event);
      });
      const done = await core.command({ commandId: cid(), type: 'done', itemId: 'loom:t', actor: 'owner', args: {} });
      expect(done.status).toBe('applied');
      expect(updates.latest('done:loom:t')).toMatchObject({ kind: 'fyi', seenVia: 'acted', spaceId: 'project:desk' });
      await core.command({ commandId: cid(), type: 'undo', itemId: 'loom:t', actor: 'owner', args: { seq: (done.outcome as { seq: number }).seq } });
      expect(updates.latest('done:loom:t')).toBeNull();

      const line = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'fyi', title: 'a note', source: 'lead', at: h.clock.now - 1000 });
      h.clock.now += 5000;
      const unshown = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'fyi', title: 'not shown', source: 'lead', at: h.clock.now - 1000 });
      await core.command({ commandId: cid(), type: 'viewed', itemId: 'loom:t', actor: 'owner', args: { ms: 3500, updates: [line.id] } });
      expect(updates.get(line.id)).toMatchObject({ seenVia: 'read' });
      expect(updates.get(unshown.id)!.seenAt).toBeNull();

      const noSpan = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'fyi', title: 'no span', source: 'lead' });
      updates.seen([noSpan.id], 'accepted');
      expect(core.store.attention('loom:t')!.coveredUntil ?? null).toBeNull();
      const later = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'fyi', title: 'another', source: 'lead', at: h.clock.now + 1000, coversFrom: 0, coversTo: h.clock.now + 1000 });
      h.clock.now += 5000;
      updates.seen([later.id], 'accepted');
      expect(core.store.attention('loom:t')!.coveredUntil).toBe(later.coversTo);
    } finally {
      h.close();
    }
  });
});

describe('leads write the catch-up (TGO-1102)', () => {
  const leadLine = (seq: number, over: Record<string, unknown> = {}) => ({ id: `U-${seq}`, seq, thread_id: 'w', kind: 'failed' as const, title: 'Backup failed', detail: null, moment: null, refs: [], shot: null, supersedes: null, covers_from: NOW - 2000, covers_to: NOW - 1000, created_at: NOW - 1000, ...over });

  it("files a lead's lines in its space (a worker's in its lead's), chains supersedes, and notes set the chapter prose", async () => {
    const items = [item('loom:lead', { facts: { role: 'default', projectId: 'desk' } }), item('loom:w', { facts: { role: 'worker', parentItemId: 'loom:lead' } })];
    const pages = [
      { updates: [leadLine(1)], notes: [{ id: 'N-2', seq: 2, thread_id: 'lead', headline: 'Backups broke overnight.', status: null, created_at: NOW }], last: 2, more: true },
      { updates: [leadLine(3, { kind: 'fyi', title: 'Backup fixed', supersedes: 'U-1', moment: 0 })], notes: [], last: 3, more: false },
    ];
    const asked: number[] = [];
    const { updates } = ledger(items, { lead: { catchup: async (after) => (asked.push(after), pages.find((p) => p.last > after) ?? { updates: [], notes: [], last: after, more: false }) } });
    await updates.syncLead();
    expect(asked).toEqual([0, 2]);
    const lines = updates.list();
    expect(lines.map((u) => [u.spaceId, u.kind, u.title, u.source, u.itemId, u.coversTo])).toEqual([['project:desk', 'fyi', 'Backup fixed', 'lead', 'loom:w', NOW - 1000]]);
    expect(updates.get(lines[0]!.supersedes!)!.title).toBe('Backup failed');
    expect(updates.chapters()[0]).toMatchObject({ headline: 'Backups broke overnight.', status: null });
    // Read again from where it left off: nothing doubles.
    await updates.syncLead();
    expect(asked.at(-1)).toBe(3);
    expect(updates.list()).toHaveLength(1);
    // Its run ended: Loom sends the line again with the span through the final reply.
    pages.push({ updates: [leadLine(4, { id: 'U-3', kind: 'fyi', title: 'Backup fixed', supersedes: 'U-1', moment: 0, covers_to: NOW + 500 })], notes: [], last: 4, more: false });
    await updates.syncLead();
    expect(updates.list().map((u) => [u.title, u.coversTo])).toEqual([['Backup fixed', NOW + 500]]);
  });

  it('writes a chapter once its lines go quiet, at most every 30 minutes, and leaves a newer lead note alone', async () => {
    const written: string[] = [];
    const { updates, clock } = ledger([], { writeChapter: async (input) => (written.push(input.spaceId), { headline: `${input.open.length} open`, status: 'Fine. Next: ship' }), spaceName: () => 'Desk' });
    updates.record({ spaceId: 'project:p', kind: 'shipped', title: 'Merged #1', source: 'auto:pr', at: NOW - 60_000 });
    await updates.writeChapters();
    expect(written).toEqual([]);
    clock.now = NOW + 5 * 60_000;
    await updates.writeChapters();
    expect(written).toEqual(['project:p']);
    expect(updates.chapters()[0]).toMatchObject({ headline: '1 open', status: 'Fine. Next: ship' });
    updates.record({ spaceId: 'project:p', kind: 'shipped', title: 'Merged #2', source: 'auto:pr', at: clock.now + 1 });
    clock.now += 10 * 60_000;
    await updates.writeChapters();
    expect(written).toHaveLength(1);
    clock.now += 25 * 60_000;
    await updates.writeChapters();
    expect(written).toHaveLength(2);
    // A lead's note after the newest line stands.
    updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'Docs', source: 'lead', at: clock.now });
    clock.now += 40 * 60_000;
    updates.setProse('project:p', { headline: 'The lead says so.' }, 'lead');
    await updates.writeChapters();
    expect(written).toHaveLength(2);
    expect(updates.chapters()[0].headline).toBe('The lead says so.');
  });

  it("an old open line stays in the writer's input, and a lead note read late keeps its own time", async () => {
    const inputs: Array<{ open: string[]; handled: string[] }> = [];
    const items = [item('loom:lead', { facts: { role: 'default', projectId: 'p' } })];
    const note = { id: 'N-1', seq: 1, thread_id: 'lead', headline: 'Old note.', status: null, created_at: NOW - 20 * 60_000 };
    const page = { updates: [leadLine(2, { thread_id: 'lead', kind: 'fyi', title: 'Later line', created_at: NOW - 10 * 60_000 })], notes: [note], last: 2, more: false };
    const { updates, clock } = ledger(items, {
      lead: { catchup: async (after) => (after >= 2 ? { updates: [], notes: [], last: after, more: false } : page) },
      writeChapter: async (input) => (inputs.push({ open: input.open.map((u) => u.title), handled: input.handled.map((u) => u.title) }), { headline: 'Rewritten.', status: 'Next: x' }),
    });
    updates.record({ spaceId: 'project:p', kind: 'needs', title: 'Approve the old plan?', source: 'auto:brief', at: NOW - 5 * 24 * 3600_000 });
    await updates.syncLead();
    clock.now = NOW + 45 * 60_000;
    await updates.writeChapters();
    expect(inputs).toEqual([{ open: ['Later line', 'Approve the old plan?'], handled: [] }]);
    expect(updates.chapters()[0].headline).toBe('Rewritten.');
  });

  it("a lead's turn preamble names what the owner saw in its space since then, and what they deferred", () => {
    const items = [item('loom:lead', { facts: { role: 'default', projectId: 'desk' } })];
    const { updates, clock } = ledger(items);
    const fine = updates.record({ spaceId: 'project:desk', kind: 'decided', class: 'ops-own-machine', title: 'Restarted Loom', source: 'auto:decision' });
    const later = updates.record({ spaceId: 'project:desk', kind: 'needs', title: 'Approve the phase 3 plan?', source: 'auto:brief' });
    updates.record({ spaceId: 'project:other', kind: 'fyi', title: 'Elsewhere', source: 'lead' });
    expect(updates.seenBrief('loom:lead', NOW - 1)).toBeNull();
    clock.now += 1000;
    updates.seen([fine.id], 'acted', 'fine');
    updates.seen([later.id], 'deferred', 'later', { backAt: clock.now + 3_600_000 });
    const text = updates.seenBrief('loom:lead', NOW)!;
    expect(text).toMatch(/^\[Catch-up\] Since your last turn the owner has seen these in this space's catch-up\. Don't retell these\. Point to them\.\n- Restarted Loom \(fine by them\)\nThey deferred these/);
    expect(text).toMatch(/- Approve the phase 3 plan\?$/);
    expect(text).not.toMatch(/Elsewhere/);
    expect(updates.seenBrief('loom:lead', clock.now)).toMatch(/^\[Catch-up\][^\n]*\nThey deferred/);
    expect(updates.seenBrief('loom:nobody', NOW)).toBeNull();
  });
});

describe('a catch-up that says only what is true now', () => {
  it("a lead's turn preamble lists the space's open asks it posted, by id, so it can close the stale ones", () => {
    const items = [item('loom:lead', { facts: { role: 'default', projectId: 'desk' } })];
    const { updates } = ledger(items);
    updates.record({ spaceId: 'project:desk', kind: 'needs', title: "Accept Claude's updated terms on the new account.", source: 'lead', subject: 'lead:U-151', data: { loomId: 'U-151' } });
    updates.record({ spaceId: 'project:desk', kind: 'needs', title: 'Approve the phase 3 plan?', source: 'auto:brief' });
    updates.record({ spaceId: 'project:other', kind: 'needs', title: 'Elsewhere', source: 'lead', data: { loomId: 'U-9' } });
    const text = updates.seenBrief('loom:lead', NOW + 1)!;
    expect(text).toMatch(/^\[Catch-up\] These still show on the owner's catch-up as open\. If one is no longer true/);
    expect(text).toMatch(/- U-151 \(needs, since [^)]+\): Accept Claude's updated terms on the new account\.$/);
    // A brief closes by its decision, not by the lead; another space's ask isn't this lead's.
    expect(text).not.toMatch(/phase 3|Elsewhere/);
    // Closed by the lead (a line that supersedes it): gone from the next preamble.
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'The terms are accepted.', source: 'lead', subject: 'lead:U-151', data: { loomId: 'U-160' } });
    expect(updates.seenBrief('loom:lead', NOW + 1)).toBeNull();
  });

  it('prose saying something waits on the owner gives way to the plain version once no open ask backs it', () => {
    const items: DeskItem[] = [];
    const { updates } = ledger(items);
    updates.record({ spaceId: 'project:desk', itemId: 'loom:terms', kind: 'needs', title: "Accept Claude's updated terms on the new personal account so new threads can use it.", source: 'lead', data: { loomId: 'U-151' } });
    updates.setProse('project:desk', { headline: "Claude's new account still waits on your terms acceptance; three fixes still await your merge, and the printer monitor needs a fix picked.", status: "The new account is ready once you accept Claude's terms. Next: accept the terms." }, 'model');
    const chapter = updates.chapters().find((c) => c.spaceId === 'project:desk')!;
    expect(chapter.headline).toBe("Accept Claude's updated terms on the new personal account so new threads can use it.");
    expect(chapter.needs).toBe(0);
    expect(chapter.headline).not.toMatch(/merge|printer/);
    // Backed by an open ask, it stands.
    items.push(item('loom:terms', { facts: { projectId: 'desk', openAsk: { text: 'Accept the terms', at: NOW } } }));
    updates.setProse('project:desk', { headline: "Claude's new account still waits on your terms acceptance." }, 'model');
    const backed = updates.chapters().find((c) => c.spaceId === 'project:desk')!;
    expect(backed.waits).toBe("Waiting on you: Accept Claude's updated terms on the new personal account so new threads can use it.");
    expect(backed.headline).toBe(`${backed.waits} Claude's new account still waits on your terms acceptance.`);
  });
});

describe('lead lines before their thread is filed', () => {
  it('wait for the thread, then file in its space; a note alone still makes a chapter', async () => {
    const items: DeskItem[] = [];
    const line = { id: 'U-1', seq: 1, thread_id: 'new', kind: 'fyi' as const, title: 'Started', detail: null, moment: null, refs: [], shot: null, supersedes: null, covers_from: null, covers_to: null, created_at: NOW };
    const note = { id: 'N-2', seq: 2, thread_id: 'new', headline: 'Just begun.', status: null, created_at: NOW };
    const asked: number[] = [];
    const { updates, clock } = ledger(items, { lead: { catchup: async (after) => (asked.push(after), after >= 2 ? { updates: [], notes: [], last: after, more: false } : { updates: after < 1 ? [line] : [], notes: [note], last: 2, more: false }) } });
    await updates.syncLead();
    expect(updates.list()).toEqual([]);
    items.push(item('loom:new', { facts: { role: 'default', projectId: 'n' } }));
    await updates.syncLead();
    expect(asked).toEqual([0, 0]);
    expect(updates.list().map((u) => u.spaceId)).toEqual(['project:n']);
    expect(updates.chapters().map((c) => [c.spaceId, c.headline])).toEqual([['project:n', 'Just begun.']]);
    // A thread that never shows goes to Unfiled after a while.
    clock.now += 11 * 60_000;
    updates.setProse('project:quiet', { headline: 'Only a note.' }, 'lead');
    expect(updates.chapters().find((c) => c.spaceId === 'project:quiet')).toMatchObject({ headline: 'Only a note.', state: 'caught_up' });
  });
});

describe('lead supersedes across spaces', () => {
  it("never replaces another space's line", async () => {
    const items = [item('loom:a', { facts: { role: 'default', projectId: 'a' } }), item('loom:b', { facts: { role: 'default', projectId: 'b' } })];
    const line = (seq: number, thread: string, over: Record<string, unknown> = {}) => ({ id: `U-${seq}`, seq, thread_id: thread, kind: 'fyi' as const, title: `line ${seq}`, detail: null, moment: null, refs: [], shot: null, supersedes: null, covers_from: null, covers_to: null, created_at: NOW, ...over });
    const page = { updates: [line(1, 'a'), line(2, 'b', { supersedes: 'U-1' })], notes: [], last: 2, more: false };
    const { updates } = ledger(items, { lead: { catchup: async (after) => (after >= 2 ? { updates: [], notes: [], last: after, more: false } : page) } });
    await updates.syncLead();
    expect(updates.list().map((u) => [u.spaceId, u.title, u.supersedes]).sort()).toEqual([['project:a', 'line 1', null], ['project:b', 'line 2', null]]);
  });
});

describe('the plain chapter (no model)', () => {
  it('leaves what waits on the owner to the desk (Chapter.waits), then says what failed and shipped; status comes from the newest news, not the old status, and adds Next', () => {
    const at = NOW;
    const out = plainChapter({ spaceId: 'p', name: 'Desk', open: [{ kind: 'shipped', moment: true, title: 'Decided for you is live.', detail: null, at }, { kind: 'needs', moment: true, title: 'Approve?', detail: null, at }], handled: [], previous: { headline: null, status: 'Phase 2 done. Next: old' }, milestone: 'phase 3 plan', now: at });
    expect(out).toEqual({ headline: 'Decided for you is live.', status: 'Decided for you is live. Next: phase 3 plan', plain: true });
    expect(plainChapter({ spaceId: 'p', name: 'Desk', open: [], handled: [], previous: { headline: null, status: 'Phase 2 done. Next: old' }, milestone: null, now: at }).status).toBe('Phase 2 done.');
    // Handled before the writer ran: the news comes from what was handled, not "Nothing new".
    const handled = plainChapter({ spaceId: 'p', name: 'Desk', open: [], handled: [{ kind: 'shipped', title: 'Merged #12.', outcome: 'ok', at }], previous: { headline: null, status: null }, milestone: null, now: at });
    expect(handled.headline).toBe('Merged the PR.');
    // A handled milestone still leads when a small line is open.
    const mixed = plainChapter({ spaceId: 'p', name: 'Desk', open: [{ kind: 'fyi', moment: false, title: 'Docs tidied.', detail: null, at }], handled: [{ kind: 'shipped', title: 'Merged #12.', outcome: 'ok', at }], previous: { headline: null, status: null }, milestone: null, now: at });
    expect(mixed.headline).toBe('Merged the PR.');
  });
});

describe('a pending ask told as done', () => {
  it('is caught when a done word shares the ask\'s key words, and not otherwise', async () => {
    const { claimsDone } = await import('../server/desk/chapter-writer.js');
    const open = [{ kind: 'needs', title: 'Stage the Test 2 holdout rule?' }, { kind: 'shipped', title: 'Holdout flag created' }];
    expect(claimsDone('The Test 2 holdout rule is staged. Nothing else.', open)).toBe('Stage the Test 2 holdout rule?');
    expect(claimsDone('The holdout flag shipped; the Test 2 holdout rule waits on you.', open)).toBeNull();
    expect(claimsDone('The holdout flag shipped, but the Test 2 holdout rule still needs you.', open)).toBeNull();
    expect(claimsDone('The ask box fix shipped and the Test 2 holdout rule is approved.', open)).toBe('Stage the Test 2 holdout rule?');
    expect(claimsDone('The holdout flag exists. Staging the Test 2 holdout rule waits on you.', open)).toBeNull();
    expect(claimsDone('The ask box fix shipped.', open)).toBeNull();
    // A short ask names one thing: that one shared word is enough.
    const short = [{ kind: 'needs', title: 'Approve launch?' }];
    expect(claimsDone('The launch is approved.', short)).toBe('Approve launch?');
    expect(claimsDone('The ask box fix shipped.', short)).toBeNull();
    expect(claimsDone('The launch waits on you.', short)).toBeNull();
    // The ask's verb told back in its done form still counts as the ask's word.
    expect(claimsDone('The dashboard is deployed.', [{ kind: 'needs', title: 'Deploy dashboard?' }])).toBe('Deploy dashboard?');
    expect(claimsDone('The beta was released.', [{ kind: 'needs', title: 'Release the beta?' }])).toBe('Release the beta?');
    expect(claimsDone('The search fix shipped.', [{ kind: 'needs', title: 'Deploy dashboard?' }])).toBeNull();
    // A waiting clause excuses only itself, not a done claim joined to it by "and".
    const two = [{ kind: 'needs', title: 'Approve launch?' }, { kind: 'needs', title: 'Deploy dashboard?' }];
    expect(claimsDone('The launch is approved and the dashboard waits on you.', two)).toBe('Approve launch?');
    expect(claimsDone('The launch and the dashboard wait on you.', two)).toBeNull();
    // With no waiting in the sentence, a shared verb keeps its subjects.
    expect(claimsDone('The dashboard and API are deployed.', two)).toBe('Deploy dashboard?');
    expect(claimsDone('The launch is complete.', two)).toBe('Approve launch?');
    // A waiting clause in the sentence doesn't split the subjects of another clause's verb.
    expect(claimsDone('The dashboard and API are deployed, while the launch waits on you.', two)).toBe('Deploy dashboard?');
    expect(claimsDone('The dashboard layout was selected.', [{ kind: 'needs', title: 'Select dashboard layout?' }])).toBe('Select dashboard layout?');
    expect(claimsDone('The dashboard was chosen.', [{ kind: 'needs', title: 'Choose dashboard?' }])).toBe('Choose dashboard?');
    // Another clause's done word doesn't reach a clause that only mentions the ask.
    expect(claimsDone('The API shipped, while dashboard work continues and the launch waits on you.', [{ kind: 'needs', title: 'Approve dashboard?' }])).toBeNull();
    expect(claimsDone('Dashboard continues, but the API shipped, while the launch waits on you.', [{ kind: 'needs', title: 'Approve dashboard?' }])).toBeNull();
    // A subject longer than two words keeps its shared verb; a clause with a verb of its own isn't joined.
    expect(claimsDone('The customer admin dashboard and API are deployed, while the launch waits on you.', [{ kind: 'needs', title: 'Deploy customer admin dashboard?' }, { kind: 'needs', title: 'Approve launch?' }])).toBe('Deploy customer admin dashboard?');
    expect(claimsDone('Dashboard continues and the API shipped, while the launch waits on you.', [{ kind: 'needs', title: 'Approve dashboard?' }])).toBeNull();
    // The plain past of choose is a done word too.
    expect(claimsDone('We chose the dashboard.', [{ kind: 'needs', title: 'Choose dashboard?' }])).toBe('Choose dashboard?');
    // The subject after "and" can run any length before the verb it shares.
    expect(claimsDone('The dashboard and customer account administration service API are deployed, while launch waits on you.', two)).toBe('Deploy dashboard?');
    // Joined right to left, a clause with its own verb still isn't taken for a subject.
    expect(claimsDone('Dashboard continues and the API and workers are deployed, while the launch waits on you.', [{ kind: 'needs', title: 'Approve dashboard?' }])).toBeNull();
    expect(claimsDone('Dashboard stalled and the API and workers are deployed, while the launch waits on you.', [{ kind: 'needs', title: 'Approve dashboard?' }])).toBeNull();
    expect(claimsDone('Dashboard advances and the API and workers are deployed, while the launch waits on you.', [{ kind: 'needs', title: 'Approve dashboard?' }])).toBeNull();
    expect(claimsDone('The dashboard widgets and the API and workers are deployed, while the launch waits on you.', [{ kind: 'needs', title: 'Deploy dashboard widgets?' }])).toBe('Deploy dashboard widgets?');
    // Three subjects that share one verb still all keep it.
    expect(claimsDone('The dashboard and the API and workers are deployed, while the launch waits on you.', two)).toBe('Deploy dashboard?');
  });
});

describe('Accept and Defer (TGO-1103)', () => {
  const withBrief = (id: string, over: Record<string, unknown> = {}, options?: Array<{ label: string }>) => {
    const b = brief(id) as unknown as { questions: Array<{ options: Array<{ label: string }> }>; brief: Record<string, unknown> };
    if (options) b.questions[0]!.options = options;
    Object.assign(b.brief, over);
    return b as unknown as DeskItem['facts']['openBrief'];
  };
  const space = () => {
    const items = [
      item('loom:a', { facts: { projectId: 'p', openBrief: withBrief('D-1', { candidate: true, revision: 2 }) } }),
      item('loom:b', { facts: { projectId: 'p', openBrief: withBrief('D-2', { level: 1, class: 'spend' }) } }),
      item('loom:c', { facts: { projectId: 'p', openBrief: withBrief('D-3', { tripwire: 'money' }) } }),
      item('loom:d', { facts: { projectId: 'p', openBrief: withBrief('D-4', {}, [{ label: 'A · One' }, { label: 'B · Two' }]) } }),
    ];
    const made = ledger(items);
    made.updates.syncBriefs();
    const decided = made.updates.record({ spaceId: 'project:p', kind: 'decided', class: 'product-choice-in-scope', decisionId: 'D-9', title: 'Picked blue', source: 'auto:decision' });
    const rule = made.updates.record({ spaceId: 'project:p', kind: 'decided', class: 'policy', decisionId: 'D-10', alwaysMoment: true, data: { rule: 'R-4' }, title: 'R-4 is a rule now', source: 'auto:decision' });
    const fyi = made.updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'Docs tidied', source: 'lead' });
    return { ...made, items, decided, rule, fyi };
  };

  it('plans the recommendation where it may, Fine on real decisions, and says what it leaves and why', () => {
    const { updates, items, decided, rule, fyi } = space();
    const plan = planChapter(updates, 'project:p', items, NOW);
    expect(plan.take.map((t) => [t.briefId, t.key, t.answer, t.candidate, t.revision])).toEqual([['D-1', 'A', 'A · Ship it (Recommended)', true, 2]]);
    expect(plan.left.map((l) => [l.briefId, l.why]).sort()).toEqual([['D-2', 'owners-call'], ['D-3', 'tripwire'], ['D-4', 'no-recommendation']]);
    expect(plan.fine).toEqual([{ updateId: decided.id, decisionId: 'D-9' }]);
    expect(plan.seen.sort()).toEqual([rule.id, fyi.id].sort());
    // Briefs named by their ask, never their id; more than two left are counted.
    expect(plan.line).toBe('Accept will choose A on “Approve the decision plan” · fine on 1 decision · mark the rest seen. Left for you: 3 briefs only you can answer.');
    expect(plan.line).not.toMatch(/\bD-\d/);
  });

  it('a brief whose ask was only an id is named as a decision, never empty quotes', () => {
    const t = { updateId: 1, itemId: 'i', briefId: 'D-1', answer: 'A', key: 'A', revision: null, candidate: false, title: 'TGO-123.' };
    expect(planLine({ take: [t], fine: [], left: [{ updateId: 2, briefId: 'D-2', title: 'TGO-124', why: 'owners-call' }], seen: [] } as never)).toBe('Accept will choose A on a decision · mark the rest seen. Left for you: a decision.');
  });

  it('a demotion with no rule id is a rule event, not a decision to confirm (Codex review on #844)', () => {
    const { updates, items } = space();
    const demoted = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'pr-housekeeping', decisionId: 'D-11', alwaysMoment: true, data: { ruleEvent: 'class-demoted', rule: null }, title: 'pr-housekeeping dropped to level 3', source: 'auto:decision' });
    const plan = planChapter(updates, 'project:p', items, NOW);
    expect(plan.fine.map((f) => f.decisionId)).not.toContain('D-11');
    expect(plan.seen).toContain(demoted.id);
  });

  it('a new moment brings a deferred chapter back whole, not just the new line (Codex review on #844)', () => {
    const { updates } = ledger([]);
    const old = updates.record({ spaceId: 'project:p', kind: 'shipped', moment: true, title: 'Shipped the map', source: 'lead' });
    updates.seen([old.id], 'deferred', 'later', { backAt: NOW + 10 * HOUR });
    expect(chapterLines(updates, 'project:p', NOW)).toEqual([]);
    const small = updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'Docs tidied', source: 'lead' });
    expect(chapterLines(updates, 'project:p', NOW).map((l) => l.id)).toEqual([small.id]);
    const fresh = updates.record({ spaceId: 'project:p', kind: 'decided', class: 'product-choice-in-scope', title: 'Picked the fallback', source: 'lead' });
    expect(chapterLines(updates, 'project:p', NOW).map((l) => l.id).sort()).toEqual([old.id, small.id, fresh.id].sort());
  });

  it('the plan line counts the briefs it leaves among what it marks seen (Codex review on #844)', () => {
    const items = [item('loom:b', { facts: { projectId: 'p', openBrief: withBrief('D-2', { level: 1, class: 'spend' }) } })];
    const { updates } = ledger(items);
    updates.syncBriefs();
    expect(planChapter(updates, 'project:p', items, NOW).line).toBe('Accept will mark it seen. Left for you: “Approve the decision plan”.');
  });

  it('refuses what the owner did not see: another line, or a brief revised since', () => {
    const { updates, items } = space();
    const plan = planChapter(updates, 'project:p', items, NOW);
    expect(stale(plan, { updateIds: plan.updateIds, revision: plan.revision })).toBe(false);
    expect(stale(plan, { updateIds: plan.updateIds.slice(1), revision: plan.revision })).toBe(true);
    (items[0]!.facts.openBrief!.brief as { revision: number }).revision = 3;
    expect(stale(planChapter(updates, 'project:p', items, NOW), { updateIds: plan.updateIds, revision: plan.revision })).toBe(true);
  });

  it('Accept answers with Ask me next time on a candidate, confirms, marks everything seen; a failure stays open', async () => {
    const { updates, items, decided } = space();
    const plan = planChapter(updates, 'project:p', items, NOW);
    const answered: unknown[] = [];
    const confirmed: string[] = [];
    const result = await applyAccept({
      updates,
      answer: async (take) => (answered.push([take.briefId, take.answer, take.candidate]), { ok: true }),
      confirm: async (id) => (confirmed.push(id), id === 'D-9' ? { ok: false, error: 'Loom is down' } : { ok: true }),
    }, plan, 'c1');
    expect(answered).toEqual([['D-1', 'A · Ship it (Recommended)', true]]);
    expect(confirmed).toEqual(['D-9']);
    expect(result.failed).toEqual([{ updateId: decided.id, error: 'Loom is down' }]);
    expect(result.applied).toMatchObject({ took: ['D-1'], fine: [] });
    // Everything but the failed Fine is seen; the briefs left for the owner still wait in Needs you.
    expect(updates.list({ space: 'project:p', unseen: true }).map((u) => u.id)).toEqual([decided.id]);
    expect(updates.chapters()[0]).toMatchObject({ needs: 4 });
  });

  it('a rule event is never confirmed, even alone', () => {
    const { updates } = ledger([]);
    updates.record({ spaceId: 'project:q', kind: 'decided', class: 'policy', decisionId: 'D-10', alwaysMoment: true, data: { rule: 'R-4' }, title: 'R-4 is a rule now', source: 'auto:decision' });
    expect(planChapter(updates, 'project:q', [], NOW)).toMatchObject({ fine: [], line: 'Accept will mark it seen.' });
  });
});

describe('Finished rows in catch-up (desk-status.md, "Finished and Stuck")', () => {
  const finished = (id: string, over: Partial<DeskItem> = {}, at = NOW - HOUR) => item(id, { ...over, facts: { projectId: 'p', handoff: { owner: 'none', text: 'Merged the map', at, runId: `run-${id}`, source: 'tool' } } });

  it('a row entering Finished is one Finished line; the lead\'s own shipped line takes its place', () => {
    const items = [finished('loom:f'), finished('loom:old', {}, NOW - 10 * 24 * HOUR), finished('loom:asked', { lastOwnerMessageAt: NOW - 10 })];
    const { updates } = ledger(items);
    updates.syncFinished();
    updates.syncFinished();
    expect(updates.list().map((u) => [u.itemId, u.kind, u.title, u.source])).toEqual([['loom:f', 'shipped', 'Merged the map', 'auto:handoff']]);
    updates.record({ spaceId: 'project:p', itemId: 'loom:f', kind: 'shipped', title: 'Shipped the map', source: 'lead' });
    updates.syncFinished();
    expect(updates.list().map((u) => u.source)).toEqual(['lead']);
  });

  it('Accept marks done each row whose Finished line it showed, and says so', async () => {
    const items = [finished('loom:f'), item('loom:busy', { facts: { projectId: 'p', running: { since: NOW - 5 } } })];
    const { updates } = ledger(items);
    updates.syncFinished();
    updates.record({ spaceId: 'project:p', itemId: 'loom:busy', kind: 'shipped', title: 'Shipped the API', source: 'lead' });
    const plan = planChapter(updates, 'project:p', items, NOW);
    expect(plan.file).toEqual(['loom:f']);
    expect(plan.line).toBe('Accept will mark the finished thread done · mark all 2 seen.');
    const done: string[] = [];
    const result = await applyAccept({ updates, answer: async () => ({ ok: true }), confirm: async () => ({ ok: true }), done: async (id) => (done.push(id), { ok: true }), items: () => items }, plan, 'c1');
    expect(done).toEqual(['loom:f']);
    expect(result.applied.filed).toEqual(['loom:f']);
  });

  it('Accept distinguishes defaults and the latest chapter from ordinary Finished threads', async () => {
    const lead = finished('loom:lead');
    lead.facts.role = 'default';
    const chapter = finished('discord:chapter:new', { kind: 'chapter', conversationKey: 'channel:home', createdAt: NOW });
    const old = finished('discord:chapter:old', { kind: 'chapter', conversationKey: 'channel:home' });
    const items = [lead, chapter, old, finished('loom:thread')];
    const { updates } = ledger(items);
    updates.syncFinished();
    const plan = planChapter(updates, 'project:p', items, NOW);
    expect(plan.clear.sort()).toEqual([chapter.id, lead.id].sort());
    expect(plan.file.sort()).toEqual([old.id, 'loom:thread'].sort());
    expect(plan.line).toContain('mark 2 finished threads done · clear 2 defaults');
    const result = await applyAccept({ updates, answer: async () => ({ ok: true }), confirm: async () => ({ ok: true }), done: async (id) => ({ ok: true, cleared: plan.clear.includes(id) }), items: () => items }, plan, 'mixed');
    expect(result.applied.cleared.sort()).toEqual(plan.clear.sort());
    expect(result.applied.filed.sort()).toEqual(plan.file.sort());
    const demoted = items.map((row) => row.id === lead.id ? { ...row, facts: { ...row.facts, role: 'interactive' as const } } : row);
    // Role changes alter what the owner approved, even with identical update ids.
    const fresh = ledger(demoted).updates;
    fresh.syncFinished();
    expect(stale(planChapter(fresh, 'project:p', demoted, NOW), plan)).toBe(true);
  });

  it('Accept leaves active a Finished row that took new work while it answered the chapter\'s briefs', async () => {
    const items = [finished('loom:f')];
    const { updates } = ledger(items);
    updates.syncFinished();
    const plan = planChapter(updates, 'project:p', items, NOW);
    expect(plan.file).toEqual(['loom:f']);
    const working = item('loom:f', { facts: { projectId: 'p', running: { since: NOW - 5 } } });
    const done: string[] = [];
    const result = await applyAccept({ updates, answer: async () => ({ ok: true }), confirm: async () => ({ ok: true }), done: async (id) => (done.push(id), { ok: true }), items: () => [working] }, plan, 'c1');
    expect(done).toEqual([]);
    expect(result.applied.filed).toEqual([]);
  });

  it('a row that finishes after the card rendered makes the shown plan stale, so Accept never files what it didn\'t promise', () => {
    const busy = item('loom:busy', { facts: { projectId: 'p', running: { since: NOW - 5 } } });
    const { updates } = ledger([busy]);
    updates.record({ spaceId: 'project:p', itemId: 'loom:busy', kind: 'shipped', title: 'Shipped the API', source: 'lead' });
    const shown = planChapter(updates, 'project:p', [busy], NOW);
    expect(shown.file).toEqual([]);
    const now = planChapter(updates, 'project:p', [finished('loom:busy')], NOW);
    expect(now.file).toEqual(['loom:busy']);
    expect(stale(now, shown)).toBe(true);
  });
});

describe('edges carried from #830 and #835', () => {
  it('a deferral outlives the 30-day prune until it comes back', () => {
    const { updates, clock } = ledger([]);
    const old = updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'Old news', source: 'lead', at: NOW - 31 * 24 * HOUR });
    updates.seen([old.id], 'deferred', 'later', { backAt: NOW + HOUR });
    updates.prune();
    expect(updates.get(old.id)).not.toBeNull();
    clock.now = NOW + 2 * HOUR;
    updates.prune();
    expect(updates.get(old.id)).not.toBeNull();
    updates.seen([old.id], 'read');
    updates.prune();
    expect(updates.get(old.id)).toBeNull();
  });

  it('an open PR is still asked about after its conversation goes quiet, until it merges', async () => {
    const state: Record<string, string> = { '20': 'OPEN', '21': 'OPEN' };
    const asked: string[] = [];
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === 'auth') return '';
      const n = args[2].split('/').pop()!;
      asked.push(n);
      return JSON.stringify({ state: state[n], mergedAt: new Date(clockRef.now).toISOString(), title: `PR ${n}` });
    };
    const clockRef = { now: NOW };
    const quiet = item('loom:q', { artifacts: [{ kind: 'pr', label: 'PR #20', url: 'https://github.com/o/r/pull/20' }], lastActivityAt: NOW - HOUR, facts: { projectId: 'p' } });
    const never = item('loom:n', { artifacts: [{ kind: 'pr', label: 'PR #21', url: 'https://github.com/o/r/pull/21' }], lastActivityAt: NOW - 5 * 24 * HOUR, facts: { projectId: 'p' } });
    const { updates, clock } = ledger([quiet, never], { exec });
    await updates.syncPullRequests();
    expect(asked).toEqual(['20']);
    clock.now = clockRef.now = NOW + 4 * 24 * HOUR;
    state['20'] = 'MERGED';
    await updates.syncPullRequests();
    expect(asked).toEqual(['20', '20']);
    expect(updates.list().map((u) => u.title)).toEqual(['Merged PR #20: PR 20']);
  });

  it('a thread done again later is news again, even with the same headline; one completion twice is not', () => {
    const items = [item('loom:t', { summary: { headline: 'Backups fixed' } as never, disposition: 'done', facts: { projectId: 'p' } })];
    const { updates } = ledger(items);
    updates.onDeskEvent({ type: 'source.done', itemId: 'loom:t', at: NOW, actor: 'system', payload: {}, seq: 1 });
    updates.onDeskEvent({ type: 'done', itemId: 'loom:t', at: NOW + 1000, actor: 'system', payload: {}, seq: 2 });
    expect(updates.list()).toHaveLength(1);
    const first = updates.list()[0]!;
    updates.seen([first.id], 'read');
    updates.onDeskEvent({ type: 'source.done', itemId: 'loom:t', at: NOW + 2 * HOUR, actor: 'system', payload: {}, seq: 3 });
    expect(updates.list().map((u) => [u.title, u.seenAt])).toEqual([['Backups fixed', null]]);
  });

  it('the chapter is written again once the owner handles it', async () => {
    let n = 0;
    const { updates, clock } = ledger([], { writeChapter: async () => ({ headline: `h${++n}`, status: `s${n}` }) });
    const line = updates.record({ spaceId: 'project:p', kind: 'needs', title: 'Approve?', source: 'auto:brief', at: NOW - HOUR });
    await updates.writeChapters();
    expect(n).toBe(1);
    clock.now += 40 * 60_000;
    updates.seen([line.id], 'acted', 'A');
    await updates.writeChapters();
    expect(n).toBe(1);
    clock.now += 6 * 60_000;
    await updates.writeChapters();
    expect(updates.chapters()[0]).toMatchObject({ headline: 'h2' });
  });

  it("a stalled model never holds up the sources' pass", async () => {
    let release: () => void = () => {};
    const { updates } = ledger([], { writeChapter: () => new Promise((resolve) => { release = () => resolve(null); }) });
    updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'x', source: 'lead', at: NOW - HOUR });
    await updates.sync();
    expect(updates.writing).not.toBeNull();
    await updates.sync();
    release();
    await updates.writing;
  });
});

describe('rechecking (recheck.ts): a line follows what it rests on', () => {
  const brief = { label: 'Full brief', url: 'https://desk.example/tango-screen/decision/D-5' };
  const pr = { label: 'PR #12', url: 'https://github.com/o/r/pull/12' };
  const asking = () => [item('loom:lead', { facts: { projectId: 'desk', openAsk: { text: 'Confirm the card', at: NOW } } })];
  const decide = (updates: DeskUpdates, at: number) => updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'decided', title: 'You approved staging the holdout rule', decisionId: 'D-5', source: 'auto:decision', subject: 'decision:D-5', at });

  it('reads what a line rests on from its fields, never its words', async () => {
    const { sourcesOf, revertedBy } = await import('../server/desk/recheck.js');
    expect(sourcesOf({ briefId: 'D-1', decisionId: null, refs: [brief, pr, { label: 'x', url: 'https://example.com/D-9' }], subject: 'lead:U-1' })).toEqual(['decision:D-1', 'decision:D-5', 'pr:o/r#12']);
    expect(sourcesOf({ briefId: null, decisionId: null, refs: [], subject: 'pr:O/R#3' })).toEqual(['pr:o/r#3']);
    expect(sourcesOf({ briefId: null, decisionId: null, refs: [], subject: 'lead:U-2' })).toEqual([]);
    expect(revertedBy('Reverts o/r#12\n\nand #120 is fine', 'O/R')).toEqual([12]);
    expect(revertedBy('Reverts other/repo#12', 'o/r')).toEqual([]);
  });

  it('an unseen ask whose decision settles just leaves, quietly; Needs you stops counting it', () => {
    const { updates, clock } = ledger(asking());
    const ask = updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'needs', title: 'The holdout card is in Slack, waiting for your Confirm', refs: [brief], source: 'lead', subject: 'lead:U-1' });
    updates.recheck();
    expect(updates.chapters()[0]!.needs).toBe(1);
    expect(updates.chapters()[0]!.waits).toBe('Waiting on you: The holdout card is in Slack, waiting for your Confirm.');
    clock.now += HOUR;
    decide(updates, clock.now);
    updates.recheck();
    const after = updates.get(ask.id)!;
    expect([after.resolvedAt, after.seenVia, after.outcome, after.supersededBy]).toEqual([clock.now, 'acted', 'settled', null]);
    expect(updates.list().some((u) => u.data.changed)).toBe(false);
    expect(updates.chapters()[0]!.needs).toBe(0);
    expect(updates.chapters()[0]!.waits).toBeNull();
  });

  it('a seen ask whose decision settles gets one Changed moment saying what it was and what is true now', () => {
    const { updates, clock } = ledger(asking());
    const ask = updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'needs', title: 'The holdout card is in Slack, waiting for your Confirm', refs: [brief], source: 'lead', subject: 'lead:U-1' });
    updates.recheck();
    updates.seen([ask.id], 'read');
    clock.now += HOUR;
    decide(updates, clock.now);
    updates.recheck();
    updates.recheck();
    const changed = updates.latest('lead:U-1')!;
    expect(changed.supersedes).toBe(ask.id);
    expect([changed.kind, changed.moment, changed.seenAt, changed.title, changed.detail]).toEqual(['fyi', true, null, 'No longer needs you: The holdout card is in Slack, waiting for your Confirm', 'Settled: You approved staging the holdout rule.']);
    expect(changed.data.changed).toMatchObject({ was: 'The holdout card is in Slack, waiting for your Confirm', wasKind: 'needs' });
    expect(updates.list().filter((u) => u.data.changed)).toHaveLength(1);
    const chapter = updates.chapters()[0]!;
    expect([chapter.needs, chapter.moments >= 1]).toEqual([0, true]);
    // It goes first among the chapter's moments.
    expect(updates.view('project:desk', updates.list({ space: 'project:desk', unseen: true })).moments[0]!.line).toBe(changed.id);
  });

  it('a decision settled before rechecking began is history: a seen ask leaves quietly', () => {
    const { updates, clock } = ledger(asking());
    const ask = updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'needs', title: 'Confirm the card', refs: [brief], source: 'lead', subject: 'lead:U-1' });
    updates.seen([ask.id], 'read');
    decide(updates, clock.now - HOUR);
    updates.recheck();
    expect(updates.latest('lead:U-1')!.id).toBe(ask.id);
    expect(updates.get(ask.id)!.resolvedAt).toBe(clock.now);
  });

  it('a reverted PR: an unseen shipped line is replaced quietly, a seen one gets a Changed moment', async () => {
    const lists: string[][] = [];
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === 'auth') return '';
      if (args[1] === 'list') {
        lists.push(args);
        return JSON.stringify([{ number: 15, url: 'https://github.com/o/r/pull/15', body: 'Reverts o/r#12', mergedAt: new Date(NOW + HOUR).toISOString() }, { number: 16, url: 'https://github.com/o/r/pull/16', body: 'Reverts o/r#13', mergedAt: new Date(NOW + HOUR).toISOString() }]);
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const { updates, clock } = ledger([item('loom:t', { facts: { projectId: 'desk' } })], { exec });
    updates.recheck();
    const seen = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'shipped', title: 'Merged PR #12: Catch me up shows each ask once', refs: [pr], source: 'auto:pr', subject: 'pr:o/r#12' });
    const unseen = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'shipped', title: 'Merged PR #13: Sidebar dots', refs: [{ label: 'PR #13', url: 'https://github.com/o/r/pull/13' }], source: 'auto:pr', subject: 'pr:o/r#13' });
    updates.seen([seen.id], 'read');
    clock.now += 2 * HOUR;
    expect(await updates.syncPrStates()).toBe(1);
    // The repo's reverts are read again only after a while.
    expect(await updates.syncPrStates()).toBe(0);
    updates.recheck();
    const changed = updates.latest('pr:o/r#12')!;
    expect([changed.supersedes, changed.kind, changed.moment, changed.title, changed.detail]).toEqual([seen.id, 'fyi', true, 'Reverted: Merged PR #12: Catch me up shows each ask once', 'PR #12 was undone by PR #15.']);
    expect(changed.refs.map((r) => r.url)).toEqual([pr.url, 'https://github.com/o/r/pull/15']);
    const quiet = updates.latest('pr:o/r#13')!;
    expect([quiet.supersedes, quiet.kind, quiet.moment, quiet.seenAt, quiet.data.changed]).toEqual([unseen.id, 'fyi', false, null, undefined]);
    expect(lists[0]).toEqual(['pr', 'list', '--repo', 'o/r', '--state', 'merged', '--search', 'Revert in:title', '--limit', '30', '--json', 'number,url,body,mergedAt']);
  });

  it('a lead\'s shipped line on a PR that closed without merging is corrected; a merged one is left alone', async () => {
    const state: Record<string, string> = { '20': 'CLOSED', '21': 'MERGED' };
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === 'auth') return '';
      if (args[1] === 'list') return '[]';
      return JSON.stringify({ state: state[args[2]!.split('/').pop()!], closedAt: new Date(NOW + HOUR).toISOString() });
    };
    const { updates, clock } = ledger([item('loom:t', { facts: { projectId: 'desk' } })], { exec });
    updates.recheck();
    const closed = updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'shipped', title: 'The holdout rule is live', refs: [{ label: 'PR #20', url: 'https://github.com/o/r/pull/20' }], source: 'lead', subject: 'lead:U-20', data: { loomId: 'U-20' }, coversFrom: NOW - 2 * HOUR, coversTo: NOW - HOUR });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:t', kind: 'shipped', title: 'The sidebar dots are live', refs: [{ label: 'PR #21', url: 'https://github.com/o/r/pull/21' }], source: 'lead', subject: 'lead:U-21' });
    updates.seen([closed.id], 'read');
    clock.now += 2 * HOUR;
    await updates.syncPrStates();
    updates.recheck();
    expect(updates.latest('lead:U-20')!.title).toBe('Not shipped: The holdout rule is live');
    expect(updates.latest('lead:U-20')!.moment).toBe(true);
    // The correction stands for the same thread messages as the line it replaced.
    expect([updates.latest('lead:U-20')!.coversFrom, updates.latest('lead:U-20')!.coversTo, updates.latest('lead:U-20')!.data.loomId]).toEqual([NOW - 2 * HOUR, NOW - HOUR, 'U-20']);
    expect(updates.latest('lead:U-21')!.title).toBe('The sidebar dots are live');
  });

  it('what waits on you is built from the open asks: one by name, more by count, and the prose follows', () => {
    const items = [item('loom:lead', { facts: { projectId: 'desk', openAsk: { text: 'x', at: NOW } } })];
    const { updates } = ledger(items);
    updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'needs', title: 'Approve the holdout rule?', source: 'lead', subject: 'lead:U-1' });
    updates.setProse('project:desk', { headline: 'The sidebar dots shipped.', status: 'Quiet. Next: x.' }, 'model');
    expect(updates.chapters()[0]!.headline).toBe('Waiting on you: Approve the holdout rule. The sidebar dots shipped.');
    updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'needs', title: 'Merge the fix', source: 'lead', subject: 'lead:U-2' });
    expect(updates.chapters()[0]!.waits).toBe('2 things are waiting on you.');
  });
});

describe('Clear catches up without completion news', () => {
  it('marks current lines seen, preserves open asks, and Undo restores only unchanged clear marks', () => {
    const lead = item('loom:lead', { facts: { role: 'default', projectId: 'p', openBrief: brief('D-clear') } });
    const { updates, clock } = ledger([lead]);
    const record = (title: string) => updates.record({ spaceId: 'project:p', itemId: lead.id, kind: 'fyi', title, source: 'lead' });
    const before = record('Already read');
    updates.seen([before.id], 'read');
    const news = record('New work');
    const later = record('Deferred work');
    updates.seen([later.id], 'deferred', 'later', { backAt: NOW + HOUR });
    const ask = updates.record({ spaceId: 'project:p', itemId: lead.id, kind: 'needs', title: 'Approve the plan', source: 'lead', briefId: 'D-clear' });
    updates.onDeskEvent({ type: 'clear', itemId: lead.id, at: NOW + 1, actor: 'owner', payload: {}, seq: 40 });
    expect(updates.get(news.id)?.seenAt).toBe(NOW + 1);
    expect(updates.get(later.id)?.backAt).toBeNull();
    expect(updates.get(ask.id)?.resolvedAt).toBeNull();
    expect(updates.latest(`done:${lead.id}`)).toBeNull();
    clock.now += 10;
    updates.seen([ask.id], 'acted', 'answered');
    const newLine = record('Arrived after Clear');
    updates.onDeskEvent({ type: 'undo', itemId: lead.id, at: NOW + 20, actor: 'owner', payload: { type: 'clear', seq: 40 }, seq: 41 });
    expect(updates.get(news.id)?.seenAt).toBeNull();
    expect(updates.get(later.id)).toMatchObject({ seenVia: 'deferred', backAt: NOW + HOUR });
    expect(updates.get(before.id)?.seenVia).toBe('read');
    expect(updates.get(ask.id)?.outcome).toBe('answered');
    expect(updates.get(newLine.id)?.seenAt).toBeNull();
  });

  it('quiet chapter supersession writes no completion news and leaves unread news alone', () => {
    const row = item('discord:chapter:old', { source: 'discord', kind: 'chapter' });
    const { updates } = ledger([row]);
    const line = updates.record({ spaceId: 'agent:a', itemId: row.id, kind: 'fyi', title: 'Earlier chapter', source: 'lead' });
    updates.onDeskEvent({ type: 'chapter.superseded', itemId: row.id, at: NOW, actor: 'system', payload: {}, seq: 1 });
    expect(updates.get(line.id)?.seenAt).toBeNull();
    expect(updates.latest(`done:${row.id}`)).toBeNull();
  });
});

describe('thread-owned asks', () => {
  const ask = 'Approve the revised launch plan for the sample service';
  const asking = (id: string, extra: Partial<DeskItem['facts']> = {}) => item(id, { facts: {
    projectId: 'sample', openAsk: { text: ask, at: NOW },
    handoff: { owner: 'you', text: ask, at: NOW, source: 'tool' }, ...extra,
  } });

  it('a newer closing handoff settles only its own earlier lead asks', () => {
    const row = asking('loom:a');
    const other = asking('loom:b');
    const { updates } = ledger([row, other]);
    const old = updates.record({ spaceId: 'project:sample', itemId: row.id, kind: 'needs', title: ask, source: 'lead', at: NOW - 1 });
    const untouched = updates.record({ spaceId: 'project:sample', itemId: other.id, kind: 'needs', title: ask, source: 'lead', at: NOW + 1 });
    row.facts.openAsk = null;
    row.facts.handoff = { owner: 'none', text: 'Implemented the plan', at: NOW, source: 'tool' };
    updates.syncStatuses();
    expect(updates.get(old.id)).toMatchObject({ resolvedAt: NOW, seenVia: 'acted' });
    expect(updates.get(untouched.id)?.resolvedAt).toBeNull();
    updates.syncStatuses();
    expect(updates.get(old.id)?.resolvedAt).toBe(NOW);
  });

  it('a matching earlier lead ask folds into the handoff with one needs count and waits line', () => {
    const row = asking('loom:a');
    const { updates } = ledger([row]);
    const old = updates.record({ spaceId: 'project:sample', itemId: row.id, kind: 'needs', title: `${ask}?`, source: 'lead', at: NOW - 1 });
    updates.syncStatuses();
    const status = updates.latest(`status:${row.id}`)!;
    expect(updates.get(old.id)).toMatchObject({ resolvedAt: NOW, supersededBy: status.id });
    expect(updates.list().filter(u => u.kind === 'needs')).toHaveLength(1);
    expect(updates.chapters()[0]).toMatchObject({ needs: 1, waits: `Waiting on you: ${ask}.` });
    const chapters = updates.chapters();
    expect(catchupCounts(chapters)).toEqual({ needs: 1, moments: 1 });
    expect(placeDot({ key: 'project:sample' }, chapterIndex({ catchup: { data: chapters } }))).toBe(true);
    row.facts.openAsk = null;
    row.facts.handoff = { owner: 'none', text: 'Finished', at: NOW + 1, source: 'tool' };
    updates.syncStatuses();
    expect(catchupCounts(updates.chapters())).toEqual({ needs: 0, moments: 0 });
    expect(placeDot({ key: 'project:sample' }, chapterIndex({ catchup: { data: updates.chapters() } }))).toBe(false);
  });

  it('a handoff and lead update naming another thread’s D-358 write no copied needs line', async () => {
    const pending = brief('D-358')!;
    const lead = asking('loom:lead', { role: 'default', openAsk: { text: 'D-358 is still open', at: NOW }, carried: [{ from: { itemId: 'loom:worker', title: 'Worker' }, pending, why: 'worker', counts: true }] });
    const worker = item('loom:worker', { facts: { role: 'worker', parentItemId: lead.id, openBrief: pending, carriedBy: { itemId: lead.id, title: 'Lead' } } });
    const page = { updates: [{ id: 'U-1', seq: 1, thread_id: 'lead', kind: 'needs' as const, title: 'D-358 is still open', detail: null, moment: null, refs: [], shot: null, supersedes: null, covers_from: null, covers_to: null, created_at: NOW }], notes: [], last: 1, more: false };
    const { updates } = ledger([lead, worker], { lead: { catchup: async () => page } });
    updates.syncBriefs();
    updates.syncStatuses();
    await updates.syncLead();
    expect(updates.list().map(u => [u.itemId, u.source])).toEqual([[worker.id, 'auto:brief']]);
    expect(updates.chapters()[0]).toMatchObject({ spaceId: 'project:sample', needs: 1 });
    worker.facts.openBrief = null;
    lead.facts.carried = [];
    updates.syncBriefs();
    updates.syncStatuses();
    // Loom may re-emit the same update with a later coverage span after its run ends.
    page.updates[0]!.seq = 2;
    page.last = 2;
    await updates.syncLead();
    expect(updates.list().filter(u => u.source === 'lead')).toHaveLength(0);
    expect(updates.chapters()[0]?.needs).toBe(0);
  });

  it('a lead’s matching worker ask is counted on the worker in the lead’s space and closes with the worker', () => {
    const lead = asking('loom:lead', { role: 'default' });
    const worker = asking('loom:worker', { role: 'worker', parentItemId: lead.id, projectId: undefined });
    const { updates } = ledger([lead, worker]);
    updates.syncStatuses();
    expect(updates.list().filter(u => u.kind === 'needs').map(u => u.itemId)).toEqual([worker.id]);
    expect(updates.chapters()[0]).toMatchObject({ spaceId: 'project:sample', needs: 1, waits: `Waiting on you: ${ask}.` });
    worker.facts.openAsk = null;
    worker.facts.handoff = { owner: 'none', text: 'Finished', at: NOW + 1, source: 'tool' };
    updates.syncStatuses();
    expect(updates.chapters()[0]).toMatchObject({ needs: 0, waits: null });
    expect(updates.latest(`status:${lead.id}`)).toBeNull();
  });

  it('a lead update carries its worker ask even when the lead handoff asks for something else', async () => {
    const ownAsk = 'Approve the separate documentation plan for the sample service';
    const lead = asking('loom:lead', { role: 'default', openAsk: { text: ownAsk, at: NOW }, handoff: { owner: 'you', text: ownAsk, at: NOW, source: 'tool' } });
    const worker = asking('loom:worker', { role: 'worker', parentItemId: lead.id, projectId: undefined });
    const page = { updates: [{ id: 'U-worker', seq: 1, thread_id: 'lead', kind: 'needs' as const, title: ask, detail: null, moment: null, refs: [], shot: null, supersedes: null, covers_from: null, covers_to: null, created_at: NOW }], notes: [], last: 1, more: false };
    const { updates } = ledger([lead, worker], { lead: { catchup: async () => page } });
    updates.syncStatuses();
    expect(updates.latest(`status:${worker.id}`)).toBeNull();
    await updates.syncLead();
    updates.syncStatuses();
    expect(updates.list().filter(u => u.kind === 'needs' && u.title === ask).map(u => u.itemId)).toEqual([worker.id]);
    expect(updates.list().filter(u => u.source === 'lead')).toHaveLength(0);
    expect(updates.chapters()[0]).toMatchObject({ spaceId: 'project:sample', needs: 2 });
    worker.facts.openAsk = null;
    worker.facts.handoff = { owner: 'none', text: 'Finished', at: NOW + 1, source: 'tool' };
    updates.syncStatuses();
    // A coverage revision must not resurrect the relayed ask after the worker closes it.
    page.updates[0]!.seq = 2;
    page.last = 2;
    await updates.syncLead();
    updates.syncStatuses();
    expect(updates.list().filter(u => u.kind === 'needs').map(u => u.title)).toEqual([ownAsk]);
    expect(updates.chapters()[0]).toMatchObject({ needs: 1, waits: `Waiting on you: ${ownAsk}.` });
  });

  it('unrelated threads, short asks, and asks addressed to an agent are not worker copies', () => {
    const lead = asking('loom:lead', { role: 'default' });
    const unrelated = asking('loom:unrelated', { role: 'worker', parentItemId: 'loom:elsewhere' });
    const worker = asking('loom:worker', { role: 'worker', parentItemId: lead.id, openAsk: { text: ask, at: NOW, to: lead.id } });
    const { updates } = ledger([lead, unrelated, worker]);
    updates.syncStatuses();
    expect(updates.latest(`status:${lead.id}`)?.kind).toBe('needs');
    lead.facts.openAsk = { text: 'Approve?', at: NOW + 1 };
    worker.facts.openAsk = { text: 'Approve?', at: NOW + 1 };
    updates.syncStatuses();
    expect(updates.latest(`status:${lead.id}`)?.title).toBe('Approve?');
  });

  it.each(['resolved', 'superseded'] as const)('rewrites the headline within a minute when an ask is %s despite newer news', async (how) => {
    const row = asking('loom:a');
    let calls = 0;
    const { updates, clock } = ledger([row], { writeChapter: async () => { calls++; return { headline: 'The service is ready.', status: 'Next: run checks.' }; } });
    updates.record({ spaceId: 'project:sample', itemId: row.id, kind: 'needs', title: ask, source: 'lead', subject: 'lead:U-1', at: NOW - 1 });
    updates.setProse('project:sample', { headline: 'Waiting for the launch plan approval.' }, 'model', NOW);
    clock.now += 10_000;
    if (how === 'resolved') {
      row.facts.openAsk = null;
      row.facts.handoff = { owner: 'none', text: 'Finished', at: clock.now, source: 'tool' };
      updates.syncStatuses();
    } else updates.record({ spaceId: 'project:sample', itemId: row.id, kind: 'fyi', title: 'The plan is approved.', source: 'lead', subject: 'lead:U-1' });
    clock.now += 60_000;
    updates.record({ spaceId: 'project:sample', kind: 'fyi', title: 'Checks started.', source: 'lead' });
    await updates.writeChapters();
    expect(calls).toBe(1);
    expect(updates.chapters()[0]?.headline).toBe('The service is ready.');
  });
});
