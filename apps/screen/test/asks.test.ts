import { describe, expect, it } from 'vitest';
import { askKey, blocksAgent, carryBriefs, dueDateIn, guessAskKind, namesDecision, readAsk, resolveAsks, type AskEntry, type CarryRow } from '../server/desk/asks.js';
import type { AskRecord } from '../server/desk/types.js';

// The ask lifecycle (docs/specs/agent-desk.md "Asks"; owner, 10/18).

const T = new Date(2026, 9, 18, 8, 8).getTime();

describe('what kind of ask the words make', () => {
  it('a leading verb of an action in the world is a to-do; a choice, approval or answer is a decision; unclear is a decision', () => {
    expect(guessAskKind('Buy the headlight at the link, or make an offer around $95.')).toBe('todo');
    expect(guessAskKind('Order two retainers. If the push-pins are missing as well, get the kit.')).toBe('todo');
    expect(guessAskKind('Call or text the accountant today to confirm the return was filed.')).toBe('todo');
    expect(guessAskKind('Check the build date on the door-jamb sticker, then buy a used liner.')).toBe('todo');
    expect(guessAskKind('after about 6:00 PM, take the parts off the bed and test-fit one track.')).toBe('todo');
    expect(guessAskKind('Create a Sketchfab API token and save it to the vault, and say where you put it.')).toBe('todo');
    expect(guessAskKind('Approve removing the four stuck exports from the drive.')).toBe('decision');
    expect(guessAskKind('Say "go" to upload the three rides privately.')).toBe('decision');
    expect(guessAskKind('Which thumbnail direction should become the channel style: A, B or C?')).toBe('decision');
    expect(guessAskKind('Sign in to the hosted MCP in this session, so I can upload the screenshots.')).toBe('decision');
    expect(guessAskKind('watch the preview and tell me whether the lip sync looks right')).toBe('decision');
    expect(guessAskKind('Read the report when you get a chance, if you want.')).toBe('soft');
    expect(guessAskKind('')).toBe('decision');
  });
});

describe('a deadline the words name', () => {
  it('reads "before Oct 15" as the end of that day, this year or next', () => {
    const due = dueDateIn('Click Confirm on the card before it expires on Oct 15 at noon.', T)!;
    expect([new Date(due).getMonth(), new Date(due).getDate(), new Date(due).getFullYear()]).toEqual([9, 15, 2026]);
    expect(dueDateIn('no date here', T)).toBeNull();
    // Eight months gone: meant for next year.
    expect(new Date(dueDateIn('pay it by Feb 1', T)!).getFullYear()).toBe(2027);
  });
});

describe('the key two rows share', () => {
  it('is the words for a long ask, and stays inside the conversation for a short one', () => {
    expect(askKey('Review **the SQL** with the #15126 owner thread, then run it.', 'a')).toBe(askKey('review the sql with the #15126 owner thread then run it', 'b'));
    expect(askKey('Say go.', 'thread:1')).not.toBe(askKey('Say go.', 'thread:2'));
  });
});

describe('reading the ask from the step', () => {
  const base = { facts: { contentKey: 'k' }, summary: null, lastAgentAt: T - 60_000, now: T };
  const row = { conversationKey: 'thread:1' };
  const step = (basis: string, ask: string) => ({ step: 'your_move' as const, basis, ask, options: [], watching: null });

  it('nothing unless the step is the owner’s move', () => {
    expect(readAsk({ step: 'fyi', basis: 'summary', ask: null, options: [], watching: null }, base, row)).toBeNull();
  });

  it('requests and recorded asks use their source; summary classifications never change them', () => {
    expect(readAsk(step('source:question', 'Front or rear?'), { ...base, facts: { contentKey: 'k', pending: { kind: 'question', at: T - 5000 } as never } }, row)).toMatchObject({ source: 'pending', kind: 'decision', kindBy: 'source', at: T - 5000, state: 'open' });
    expect(readAsk(step('source:ask', 'Buy the headlight'), { ...base, facts: { contentKey: 'k', openAsk: { text: 'Buy the headlight', at: T - 9000 } }, summary: { contentKey: 'k', askKind: 'todo' } as never }, row)).toMatchObject({ source: 'recorded', kind: 'decision', kindBy: 'source', at: T - 9000 });
    expect(readAsk(step('source:next-line', 'Buy the headlight'), base, row)).toMatchObject({ source: 'recorded', kind: 'decision', kindBy: 'source', at: T - 60_000 });
    // A summary of older words doesn't classify.
    expect(readAsk(step('source:next-line', 'Buy the headlight'), { ...base, summary: { contentKey: 'old', askKind: 'decision' } as never }, row)).toMatchObject({ kind: 'decision', kindBy: 'source' });
  });

  it('an errand the agent’s work waits on is a decision, even when the summary calls it a to-do (Zero-Downtime, 10/19)', () => {
    const todoSummary = { contentKey: 'k', askKind: 'todo' } as never;
    const recorded = (text: string) => ({ ...base, facts: { contentKey: 'k', openAsk: { text, at: T - 9000 } }, summary: todoSummary });
    // The two asks the summary filed as to-dos while the thread waited on them.
    const install = 'sign and install Tango.app, grant it Full Disk Access, and turn on start-at-login (steps 1–3 on TGO-1014); after that I move services to managed mode one at a time.';
    expect(readAsk(step('source:ask', install), recorded(install), row)).toMatchObject({ kind: 'decision', kindBy: 'source' });
    const toggle = 'in Tango.app → Settings, turn "Start Tango Server at login" off and back on.';
    expect(readAsk(step('source:ask', toggle), recorded(toggle), row)).toMatchObject({ kind: 'decision', kindBy: 'source' });
    // Its closing message says the agent goes on after it.
    expect(readAsk(step('source:ask', 'Plug the camera back in.'), { ...recorded('Plug the camera back in.'), closingText: 'Once you’ve done that, I’ll rerun the capture test.' }, row)).toMatchObject({ kind: 'decision', kindBy: 'source' });
    // A real errand stays a to-do: the agent’s work doesn’t wait on it.
    expect(readAsk(step('source:ask', 'Buy the headlight'), recorded('Buy the headlight'), row)).toMatchObject({ kind: 'decision', kindBy: 'source' });
    const cleanup = 'run your fleet-hygiene cleanup on the Loom and agentic worktrees when you can; the disk has about 15 GB free. When both Codex tasks finish, I’ll review, test and merge them.';
    expect(blocksAgent('run your fleet-hygiene cleanup on the Loom and agentic worktrees when you can', cleanup)).toBe(false);
    expect(blocksAgent('Pick up the brake pads from the shop')).toBe(false);
    // Installing a thing in the world is an errand; installing an app is setup (Codex review on #783).
    expect(blocksAgent('Install the shelf in the garage')).toBe(false);
    expect(blocksAgent('Install it under the dash')).toBe(false);
    expect(blocksAgent('install Tango.app from the build folder')).toBe(true);
    // A credential the agent's next step needs.
    expect(blocksAgent('Create a Sketchfab API token, save it to 1Password, and tell the thread where you put it.')).toBe(true);
    // A physical errand whose result the agent reads stays a to-do (owner, 10/18).
    expect(blocksAgent('Put the RCA harness in the speaker and tell me whether the hiss is gone.')).toBe(false);
    // The agent's own next step named after the errand: it waits on it (camera thread, 10/19).
    expect(blocksAgent("Move the C-to-A cable to the other rear USB-A port and tell me, and I'll run the 1080p check.")).toBe(true);
    expect(blocksAgent("join #Operator for a normal voice call. This thread wakes when you join, and I'll check the call's log.")).toBe(true);
    // An "and I'll" about the agent's own unrelated work doesn't tie the errand to it (Codex review on #789).
    expect(blocksAgent('Please buy the cable.', "I'll fix the parser, and I'll run its tests. Separately, please buy the cable.")).toBe(false);
  });

  it('wording never expires a recorded ask; a summary alone creates no record', () => {
    expect(readAsk(step('source:next-line', 'Confirm the card before it expires on Oct 15, then post it'), base, row)).toMatchObject({ state: 'open', dueAt: null });
    const later = readAsk(step('summary', 'Confirm the card'), { ...base, summary: { contentKey: 'k', askDueAt: '2026-10-20T18:00:00-07:00' } as never }, row)!;
    expect(later).toBeNull();
  });
});

describe('one ask on several rows', () => {
  const rec = (text: string, at: number, conversationKey = 'channel:c', state: AskRecord['state'] = 'open'): AskRecord => ({ source: 'summary', text, kind: 'decision', kindBy: 'words', at, dueAt: null, key: askKey(text, conversationKey), state, of: null });
  const entry = (itemId: string, over: Partial<AskEntry>): AskEntry => ({ itemId, conversationKey: 'channel:c', kind: 'chapter', createdAt: 1, active: true, ask: null, ...over });

  it('an older chapter’s ask is superseded by any newer active chapter of its conversation, ask or not', () => {
    const entries = [
      entry('ch1', { createdAt: 1, ask: rec('Whose spending was the figurine, and the meal?', 1) }),
      entry('ch2', { createdAt: 2, ask: rec('Is the figurine yours or a gift, and is the meal personal?', 2) }),
      entry('ch3', { createdAt: 3 }),
    ];
    const r = resolveAsks(entries);
    expect(r.get('ch1')).toEqual({ state: 'superseded', of: 'ch3' });
    expect(r.get('ch2')).toEqual({ state: 'superseded', of: 'ch3' });
    // A chapter out of the rotation neither supersedes nor is resolved; another conversation's chapter is nobody's.
    expect(resolveAsks([entries[0]!, { ...entries[2]!, active: false }, entry('other', { conversationKey: 'channel:d', createdAt: 9 })]).get('ch1')).toEqual({ state: 'open', of: null });
  });

  it('the same words on two threads are one ask, carried by the newest; short asks never match across threads', () => {
    const text = 'Review the SQL script with the owner thread and have it run';
    const r = resolveAsks([
      entry('t1', { conversationKey: 'thread:1', kind: 'thread', ask: rec(text, 10, 'thread:1') }),
      entry('t2', { conversationKey: 'thread:2', kind: 'thread', ask: rec(text, 20, 'thread:2') }),
      entry('loom', { conversationKey: 'thread:3', kind: 'thread', ask: rec('Say go', 30, 'thread:3') }),
      entry('t4', { conversationKey: 'thread:4', kind: 'thread', ask: rec('Say go', 40, 'thread:4') }),
    ]);
    expect(r.get('t1')).toEqual({ state: 'duplicate', of: 't2' });
    expect(r.get('t2')).toEqual({ state: 'open', of: null });
    expect(r.get('loom')).toEqual({ state: 'open', of: null });
    expect(r.get('t4')).toEqual({ state: 'open', of: null });
    // An expired ask stays expired when it is the one carried.
    expect(resolveAsks([entry('e', { kind: 'thread', conversationKey: 'thread:e', ask: rec(text, 5, 'thread:e', 'expired') })]).get('e')).toEqual({ state: 'expired', of: null });
  });
});

describe('briefs passed up intact (carryBriefs)', () => {
  const r = (itemId: string, extra: Partial<CarryRow> = {}): CarryRow => ({ itemId, role: 'interactive', parentItemId: null, ownerGone: false, active: true, live: true, briefId: null, words: '', lead: false, loom: true, ...extra });

  it('reads a decision id as written: D-6, not D-60 or XD-6', () => {
    expect(namesDecision('answer D-6 on your desk', 'D-6')).toBe(true);
    expect(namesDecision('answer D-60 on your desk', 'D-6')).toBe(false);
    expect(namesDecision('see XD-6', 'D-6')).toBe(false);
  });

  it('a row that names the brief carries it; a default or lead counts it, any other row leaves the count with the raiser', () => {
    const raised = r('filter', { briefId: 'D-6' });
    expect(carryBriefs([raised, r('desk', { role: 'default', words: 'Next — you: answer D-6.' })])).toEqual([{ decisionId: 'D-6', source: 'filter', carriers: [{ itemId: 'desk', why: 'named' }], counter: 'desk' }]);
    expect(carryBriefs([raised, r('chat', { words: 'D-6 is waiting.' })])).toMatchObject([{ carriers: [{ itemId: 'chat' }], counter: 'filter' }]);
    // A Loom or Discord row naming it doesn't carry it: Loom couldn't clear that ask when the decision settles.
    expect(carryBriefs([raised, r('loom', { role: 'default', loom: false, words: 'answer D-6' })])).toEqual([]);
    // ...but a lead on any source carries its own worker's brief.
    expect(carryBriefs([r('t3-lead', { loom: false }), r('w', { role: 'worker', parentItemId: 't3-lead', briefId: 'D-7' })])).toMatchObject([{ carriers: [{ itemId: 't3-lead', why: 'worker' }] }]);
    // A row the owner put away, a job and a worker don't carry.
    expect(carryBriefs([raised, r('a', { active: false, words: 'D-6' }), r('b', { role: 'ops', words: 'D-6' }), r('c', { role: 'worker', parentItemId: 'x', words: 'D-6' })])).toEqual([]);
  });

  it('a worker’s brief goes up to its lead without a mention, and past a worker that started it to the first lead that speaks to the owner', () => {
    expect(carryBriefs([r('lead'), r('w', { role: 'worker', parentItemId: 'lead', briefId: 'D-7' })])).toMatchObject([{ carriers: [{ itemId: 'lead', why: 'worker' }], counter: 'lead' }]);
    expect(carryBriefs([r('lead'), r('job', { role: 'ops', parentItemId: 'lead', briefId: 'D-7' })])).toMatchObject([{ source: 'job', carriers: [{ itemId: 'lead', why: 'worker' }], counter: 'lead' }]);
    const nested = [r('desk', { role: 'default' }), r('mid', { role: 'worker', parentItemId: 'desk' }), r('leaf', { role: 'worker', parentItemId: 'mid', briefId: 'D-8' })];
    expect(carryBriefs(nested)).toMatchObject([{ source: 'leaf', carriers: [{ itemId: 'desk', why: 'worker' }], counter: 'desk' }]);
    // A chain that ends in a loop, or at a job that reports to no one, has no one to carry it.
    expect(carryBriefs([r('a', { role: 'worker', parentItemId: 'b' }), r('b', { role: 'worker', parentItemId: 'a', briefId: 'D-9' })])).toEqual([]);
    expect(carryBriefs([r('job', { role: 'ops' }), r('w', { role: 'worker', parentItemId: 'job', briefId: 'D-9' })])).toEqual([]);
    // A job between the worker and its lead is passed through, as a worker is.
    expect(carryBriefs([r('desk', { role: 'default' }), r('job', { role: 'ops', parentItemId: 'desk' }), r('w', { role: 'worker', parentItemId: 'job', briefId: 'D-9' })])).toMatchObject([{ carriers: [{ itemId: 'desk', why: 'worker' }], counter: 'desk' }]);
  });
});
