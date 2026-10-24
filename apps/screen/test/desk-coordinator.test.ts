import { describe, expect, it } from 'vitest';
import { answerAfter, coordinatorItemIds, withoutNextLine, BRIEF_CLOSE, BRIEF_OPEN, basisOf, countingStatus, flagsFor, panelMessage, ProjectCoordinators, TANGO_SCREEN_BIN } from '../server/desk/coordinator.js';
import type { DeskItem } from '../server/desk/types.js';
import { makeHarness, NOW } from './desk-harness.js';
const iso = (minute: number) => new Date(NOW + minute * 60_000).toISOString();
describe('retained coordinator records and helpers', () => {
  it('keeps stored coordinator identities for hiding retired records', () => {
    expect([...coordinatorItemIds(JSON.stringify({ desk: { threadId: 'old-coordinator' }, empty: { threadId: null } }))]).toEqual(['t3:old-coordinator']);
    expect([...coordinatorItemIds('invalid')]).toEqual([]);
  });
  it('drops a closing “Next —” line from answers and relayed replies', () => {
    expect(withoutNextLine('Go, for a single binary.\n\n**Next — none:** done.')).toBe('Go, for a single binary.');
    expect(withoutNextLine('Next steps are listed above.')).toBe('Next steps are listed above.');
    expect(panelMessage({ id: 'a', role: 'assistant', text: 'Fine.\n\n**Next — you:** approve it.', createdAt: iso(0) })!.text).toBe('Fine.');
  });
  it('the panel hides the brief and tells questions, answers and relays apart', () => {
    expect(panelMessage({ id: 'a', role: 'user', text: `${BRIEF_OPEN}\nrules\n${BRIEF_CLOSE}\n\nWhat’s blocking?`, createdAt: iso(0) })).toMatchObject({ kind: 'question', text: 'What’s blocking?' });
    expect(panelMessage({ id: 'b', role: 'user', text: '(Asked while looking at “X” [t3:w1])\nWhy?', createdAt: iso(0) })).toMatchObject({ kind: 'question', text: 'Why?', fromItemId: 't3:w1' });
    expect(panelMessage({ id: 'c', role: 'user', text: '[Relay] “X” answered.', createdAt: iso(0) })).toMatchObject({ kind: 'relay', text: '“X” answered.' });
    expect(panelMessage({ id: 'd', role: 'assistant', text: 'Two things.', createdAt: iso(0) })).toMatchObject({ kind: 'answer' });
    expect(panelMessage({ id: 'e', role: 'system', text: 'note', createdAt: iso(0) })).toBeNull();
  });
  it('the answer is the reply to the coordinator’s question, not to a turn the owner queued after it', () => {
    const at = 1000;
    const messages = [
      { author: 'owner', at: 1001, text: 'Question from the project coordinator for “Desk”, asked on the owner’s behalf: retry?' },
      { author: 'agent', at: 1002, text: 'Working on it.' },
      { author: 'agent', at: 1003, text: 'Retried; passing.' },
      { author: 'owner', at: 1004, text: 'Also rename the file.' },
      { author: 'agent', at: 1005, text: 'Renamed.' },
    ];
    expect(answerAfter(messages, at)).toEqual({ text: 'Retried; passing.', at: 1003 });
    expect(answerAfter(messages.slice(0, 1), at)).toBeNull();
    // Sent while it was busy: its earlier turn's reply lands first and isn't the answer (Codex review on #545).
    const busy = [{ author: 'agent', at: 1001, text: 'Finished the earlier task.' }, ...messages.map((m) => ({ ...m, at: m.at + 1 }))];
    expect(answerAfter(busy, at)).toEqual({ text: 'Retried; passing.', at: 1004 });
    expect(answerAfter(busy.slice(0, 1), at)).toBeNull();
  });
  it('flags: waiting on the owner over a day, failed with no retry, a review older than two days', () => {
    const base = { disposition: 'active', facts: {}, watching: null, lastActivityAt: NOW } as unknown as DeskItem;
    const items = [
      { ...base, id: 'a', nextStep: 'your_move', lastActivityAt: NOW - 2 * 86_400_000 },
      { ...base, id: 'b', nextStep: 'failed', facts: { failed: { at: NOW - 3 * 3_600_000, reason: 'x', message: 'x' } } },
      { ...base, id: 'c', nextStep: 'watching', facts: { prReview: { state: 'pending', reviewers: ['ana'], number: 541, since: NOW - 3 * 86_400_000 } } },
      { ...base, id: 'd', nextStep: 'your_move' },
    ] as DeskItem[];
    const flags = flagsFor(items, (i) => i.id, NOW);
    expect(flags.map((f) => [f.itemId, f.kind, f.text])).toEqual([
      ['b', 'failed', 'failed 3 hours ago and hasn’t been retried'],
      ['a', 'stalled', 'has waited on you 2 days'],
      ['c', 'review', 'PR #541 has waited 3 days for review by ana'],
    ]);
    expect(basisOf(items)).toBe(basisOf([...items].reverse()));
  });
  it('the counting fallback leads with what needs the owner', () => {
    const m = (title: string, state: string) => ({ itemId: title, title, where: '', state, disposition: 'active', lastActivityAt: '', ask: null, summary: null, waitingOn: null, pullRequest: null, failed: null, ownerAsked: null, recent: [] });
    expect(countingStatus([m('Migration', 'needs you'), m('Inbox', 'working')], [])).toEqual({ line: '1 need you, 1 working.', text: '1 need you, 1 working. On you: Migration.' });
  });
  it('does not launch a retired supervised coordinator', async () => {
    const h = makeHarness();
    try {
      const coordinator = new ProjectCoordinators({ core: h.core, start: async () => { throw new Error('must not launch'); }, write: async () => ({ text: '', line: '', source: 'text' }) });
      expect(await coordinator.ask('desk', 'Status?')).toMatchObject({ ok: false, error: expect.stringContaining('retired') });
    } finally { h.close(); }
  });
});
