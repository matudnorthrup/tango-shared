import { describe, expect, it } from 'vitest';
import { askOf, ledgerAskOf } from '../server/desk/source-loom.js';
import { deskStatus } from '../server/desk/status.js';
import { readAsk } from '../server/desk/asks.js';
import type { RecordedAsk } from '../server/desk/types.js';

const record = { id: 'A-1', text: 'Connect the backup drive', created_at: 100, at: 100, audience: 'owner', who: 'fixture-owner', kind: 'do' as const, status: 'open' as const, revision: 2, steps: [{ text: 'Connect' }, { text: 'Unlock' }], due: '2030-01-01T00:00:00Z' };
describe('recorded asks', () => {
  it('reads ledger fields, retains closed records, and excludes pointers', () => {
    expect(askOf(null, record)).toMatchObject({ id: 'A-1', kind: 'do', status: 'open', revision: 2, steps: record.steps });
    expect(askOf(null, { ...record, status: 'done' })).toBeNull();
    expect(ledgerAskOf({ ...record, status: 'done' })).toMatchObject({ status: 'done' });
    expect(askOf(null, { ...record, kind: 'pointer' })).toBeNull();
    expect(ledgerAskOf({ ...record, kind: 'pointer' })).toMatchObject({ id: 'A-1', kind: 'pointer' });
    expect(askOf(JSON.stringify({ text: 'Old ask', at: 100 }))).toEqual({ text: 'Old ask', at: 100 });
  });
  it('uses status instead of owner-message timestamps, with optimistic Done and legacy fallback', () => {
    const openAsk = askOf(null, record)!;
    const input = { source: 'loom' as const, seen: 'seen' as const, facts: { openAsk }, lastOwnerMessageAt: 200 };
    expect(deskStatus(input, 300).countsForOwner).toBe(true);
    for (const status of ['done', 'expired', 'closed-by-done', 'answered'] as const) {
      expect(deskStatus({ ...input, facts: { openAsk: { ...openAsk, status, at: 250 } } }, 300).countsForOwner).toBe(false);
    }
    expect(deskStatus({ ...input, facts: { openAsk, askClosedByDoneAt: 150 } }, 300).countsForOwner).toBe(false);
    // The owner's typed words past the ask are with the agent (Loom records them as answered): Sent, not Needs you.
    expect(deskStatus({ ...input, facts: { openAsk, lastAuthor: 'owner', lastOwnerRequest: { text: 'It is plugged in', at: 200 } } }, 300).countsForOwner).toBe(false);
    // Words from before the ask, or mail, never speak for it.
    expect(deskStatus({ ...input, facts: { openAsk, lastAuthor: 'owner', lastOwnerRequest: { text: 'earlier', at: 50 } } }, 300).countsForOwner).toBe(true);
    expect(deskStatus({ ...input, facts: { openAsk, lastAuthor: 'owner', lastAuthorMail: true, lastOwnerRequest: { text: 'mail', at: 200 } } }, 300).countsForOwner).toBe(true);
    expect(deskStatus({ ...input, facts: { openAsk: { text: 'Old ask', at: 100 } } }, 300).countsForOwner).toBe(false);
    expect(deskStatus({ ...input, facts: { openAsk: { text: 'Old ask', at: 250 } } }, 300).countsForOwner).toBe(true);
    expect(deskStatus({ ...input, facts: { openAsk: { ...openAsk, kind: 'pointer' } } }, 300).countsForOwner).toBe(false);
  });
  it('takes kind, due and state only from the record', () => {
    const facts = { openAsk: askOf(null, record) };
    const read = (ask: RecordedAsk) => readAsk({ step: 'your_move', basis: 'source:ask', ask: 'ignored' } as never,
      { facts: { openAsk: ask }, now: 200, lastAgentAt: 100, summary: null }, { conversationKey: 'thread' });
    expect(read(facts.openAsk!)).toMatchObject({ source: 'recorded', kind: 'todo', kindBy: 'source', key: 'A-1', dueAt: Date.parse(record.due), state: 'open' });
    expect(read({ ...facts.openAsk!, kind: 'answer', status: 'expired' })).toMatchObject({ kind: 'decision', state: 'expired' });
    expect(read({ ...facts.openAsk!, status: 'done' })).toBeNull();
  });
});
