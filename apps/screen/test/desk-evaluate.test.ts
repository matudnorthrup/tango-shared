import { describe, expect, it } from 'vitest';
import { deskStatus, HEARTBEAT_FRESH_MS, WAIT_FRESH_MS, type StatusInput } from '../server/desk/status.js';
import { deriveNextStep } from '../server/desk/next-step.js';
import { statusWord } from '../server/desk/mail.js';
import { liveState, wantsOwner, tabItems, sectionsOf, TABS } from '../public/desk/list-model.js';
import { countsOf, nestedRows, shownRows } from '../public/desk/next/model.js';
import { DEFAULT_VIEWS, viewItems } from '../public/desk/list-views.js';
import { catchupNeedsOwner } from '../public/desk/next/catchup-model.js';
const now = 1_800_000_000_000;
const evaluate = (facts: StatusInput['facts'] = {}, patch: Partial<StatusInput> = {}) => deskStatus({ facts, seen: 'new', disposition: 'active', source: 'loom', ...patch }, now);
const failed = { failed: { at: now, reason: 'error', message: 'Turn crashed' } };
const needs = { openAsk: { text: 'Choose a plan', at: now } };
const working = { running: { since: now }, heartbeatAt: now };
const waiting = { waits: [{ id: 'w', kind: 'pr' as const, target: 'PR #12', armedAt: now, lastCheckedAt: now - 120_000 }] };
const cases = [['failed', failed], ['needs', needs], ['working', working], ['waiting', waiting], ['idle', {}]] as const;
describe('fact evaluator', () => {
  it.each(cases)('%s from a record', (pill, facts) => expect(evaluate(facts).pill).toBe(pill));
  for (let a = 0; a < cases.length; a++) for (let b = a + 1; b < cases.length; b++) {
    it(`${cases[a][0]} beats ${cases[b][0]}`, () => expect(evaluate({ ...cases[b][1], ...cases[a][1] }).pill).toBe(cases[a][0]));
  }
  it.each([
    [{ role: 'worker', parentItemId: 'lead' }, 'lead'],
    [{ role: 'worker', parentItemId: 'lead', leadAway: { itemId: 'lead', title: 'Lead' } }, 'owner'],
    [{ role: 'ops', parentItemId: 'lead' }, 'lead'],
    [{ role: 'worker' }, 'owner'],
    [{ role: 'ops' }, 'owner'],
    [{ role: 'worker', parentItemId: 'lead', ownerGone: true }, 'owner'],
  ] as const)('routes %j to %s', (role, audience) => {
    const status = evaluate({ ...needs, ...role });
    expect(status.audience).toBe(audience);
    expect(status.pill).toBe(audience === 'owner' ? 'needs' : 'waiting');
    expect(status.countsForOwner).toBe(audience === 'owner');
    expect(evaluate({ ...failed, ...role }).pill).toBe('failed');
  });
  it('a tree run beats a wait and preserves an ask', () => {
    expect(evaluate({ ...waiting, runningWorkers: 2 })).toMatchObject({ pill: 'working', detail: '2 workers' });
    expect(evaluate({ ...waiting, ...needs, runningWorkers: 2 })).toMatchObject({ pill: 'needs', stillWorking: true });
  });
  it('holds wait with their recorded reason', () => expect(evaluate({ held: { reason: 'capacity' } })).toMatchObject({ pill: 'waiting', detail: 'capacity' }));
  it.each(['pending', 'changes_requested', 'approved'] as const)('PR %s never asks the owner', state => {
    const facts = { openedPrUrls: ['https://github.com/acme/widgets/pull/12'], prReview: { state, number: 12, reviewers: [], since: now } };
    expect(evaluate(facts).pill).toBe(state === 'approved' ? 'idle' : 'waiting');
    expect(evaluate({ ...facts, ...working }).pill).toBe('working');
    expect(evaluate(facts).countsForOwner).toBe(false);
  });
  it('stale facts are unknown, desk asks survive', () => {
    expect(evaluate({ sourceHealth: { ok: false, at: now } }).pill).toBe('unknown');
    // sourceHealth.at reads "since": a long-healthy source is not stale.
    expect(evaluate({ sourceHealth: { ok: true, at: now - HEARTBEAT_FRESH_MS - 1 } }).pill).toBe('idle');
    expect(evaluate({ ...working, heartbeatAt: now - HEARTBEAT_FRESH_MS - 1 }).pill).toBe('unknown');
    expect(evaluate({ waits: [{ ...waiting.waits[0], lastCheckedAt: now - WAIT_FRESH_MS - 1 }] }).pill).toBe('waiting');
    expect(evaluate({ waits: [{ ...waiting.waits[0], checkError: "gh auth failed" }] }).pill).toBe('unknown');
    expect(evaluate({ ...needs, sourceHealth: { ok: false, at: now } }).pill).toBe('needs');
  });
  it('owner message starts, then becomes unknown, never failed', () => {
    expect(evaluate({ lastAuthor: 'owner' }, { lastOwnerMessageAt: now }).detail).toBe('sent');
    expect(evaluate({ lastAuthor: 'owner' }, { lastOwnerMessageAt: now - HEARTBEAT_FRESH_MS - 1 }).pill).toBe('unknown');
  });
  it('a reply past an open request is Sent, until the agent answers or raises another', () => {
    const question = { kind: 'question' as const, requestId: 'q1', questions: [], question: 'Which?', options: [], at: now - 60_000 };
    const brief = { ...question, requestId: 'decision:D-1', brief: {} as never };
    const wrote = { lastAuthor: 'owner' as const, lastOwnerRequest: { text: 'Go with B', at: now } };
    for (const open of [{ pending: question }, { openBrief: brief, openBriefCount: 2 }, { carried: [{ counts: true, pending: brief }] as never }]) {
      expect(evaluate(open).pill).toBe('needs');
      expect(evaluate({ ...open, ...wrote }, { lastOwnerMessageAt: now })).toMatchObject({ pill: 'working', detail: 'sent', countsForOwner: false, layer: 'active' });
    }
    // The run starts: Working. The agent answers with the request still open: Needs you again.
    expect(evaluate({ pending: question, ...wrote, ...working }, { lastOwnerMessageAt: now })).toMatchObject({ pill: 'working', detail: 'Turn running' });
    expect(evaluate({ pending: question, ...wrote, lastAuthor: 'agent' }, { lastOwnerMessageAt: now }).pill).toBe('needs');
    // A request raised after the words, mail from another agent, or an answer chip (no typed words filed) still asks.
    expect(evaluate({ pending: question, openBrief: { ...brief, at: now + 1 }, ...wrote }, { lastOwnerMessageAt: now }).pill).toBe('needs');
    expect(evaluate({ pending: question, ...wrote, lastAuthorMail: true }, { lastOwnerMessageAt: now }).pill).toBe('needs');
    expect(evaluate({ pending: question, lastAuthor: 'owner', lastOwnerRequest: { text: 'older', at: now - 120_000 } }, { lastOwnerMessageAt: now }).pill).toBe('needs');
    // Loom files a brief's answer as the owner's turn: it isn't typed words past the other open briefs (Codex review on #1032).
    expect(evaluate({ openBrief: brief, openBriefCount: 2, lastAuthor: 'owner', lastOwnerRequest: { text: 'Decision D-2: …', at: now, answers: 'D-2' } }, { lastOwnerMessageAt: now }).pill).toBe('needs');
    // Words past a brief, then a chip answering a later question: the chip is the latest act, so the brief asks again (Codex review on #1032).
    expect(evaluate({ openBrief: brief, ...wrote, chipAt: now + 5_000 }, { lastOwnerMessageAt: now + 5_000 }).pill).toBe('needs');
    // Loom's copy of a desk reply files the earlier source time; the reply still counts (Codex review on #1032).
    expect(evaluate({ openBrief: brief, chipAt: now - 30_000, lastAuthor: 'owner', lastOwnerRequest: { text: 'Go with B', at: now - 2_000, filedAt: now } }, { lastOwnerMessageAt: now }).pill).toBe('working');
    // Every counted carried brief is checked: one raised after the words still asks (Codex review on #1032).
    const carried = [{ counts: true, pending: brief }, { counts: true, pending: { ...brief, requestId: 'decision:D-2', at: now + 1 } }] as never;
    expect(evaluate({ carried, ...wrote }, { lastOwnerMessageAt: now }).pill).toBe('needs');
    // Done keeps an open brief in Needs you whatever was said.
    expect(evaluate({ openBrief: brief, ...wrote }, { lastOwnerMessageAt: now, disposition: 'done' })).toMatchObject({ pill: 'needs', layer: 'needs' });
  });
  it.each([['snoozed', 'later'], ['parked', 'later'], ['done', 'done']] as const)('%s placement', (disposition, layer) => expect(evaluate(needs, { disposition })).toMatchObject({ layer, countsForOwner: false }));
  it('reading only clears unread', () => {
    expect(evaluate(needs)).toMatchObject({ pill: 'needs', unread: true, countsForOwner: true });
    expect(evaluate(needs, { seen: 'seen' })).toMatchObject({ pill: 'needs', unread: false, countsForOwner: true });
  });
  it('summary asking with no record cannot create a status', () => {
    const result = deriveNextStep({ facts: {}, summary: { step: 'your_move', ask: 'Approve it', contentKey: '' } as never, fallbackStep: 'your_move', now, lastActivityAt: now, lastOwnerMessageAt: null });
    expect(result.step).toBe('fyi');
  });
  it('D-353: Loom uses its ask record, never a handoff-only fallback', () => {
    // Loom keeps its ask open across an unrelated mail turn, whose handoff is newer.
    expect(evaluate({ ...needs, handoff: { owner: 'waiting', text: 'CI', at: now + 1, source: 'closing-line' } }).pill).toBe('needs');
    expect(evaluate({ openAsk: null, handoff: { owner: 'you', text: 'Answer', at: now, source: 'tool' } }).pill).toBe('idle');
    expect(evaluate({ ...needs, handoff: null }).pill).toBe('needs');
    expect(evaluate({ handoff: { owner: 'you', text: 'Answer', at: now, source: 'tool' } }).pill).toBe('idle');
    expect(evaluate(waiting).detail).toBe('PR #12 · checked 2m ago');
  });
});
describe('surfaces read the same answer', () => {
  const item = (facts: StatusInput['facts'], disposition = 'active') => ({ id: JSON.stringify(facts), disposition, seen: 'seen', facts, status: evaluate(facts, { disposition: disposition as never, seen: 'seen' }) });
  it.each(cases)('%s row, catch-up and mail', (pill, facts) => {
    const row = item(facts);
    expect(liveState(row)).toBe(pill);
    expect(catchupNeedsOwner(row)).toBe(wantsOwner(row));
    expect(statusWord({ ...row, source: 'loom' } as never)).toBe(pill === 'needs' ? 'needs you' : pill);
  });
  it('four tabs and precedence groups', () => {
    expect(TABS.map(([id]) => id)).toEqual(['needs', 'active', 'later', 'done']);
    const rows = cases.map(([, facts]) => item(facts));
    const lists = { active: { items: rows }, snoozed: { items: [item({}, 'parked')] }, history: { items: [item({}, 'done')] } };
    expect(tabItems(lists, 'needs')).toHaveLength(2);
    expect(tabItems(lists, 'later')).toHaveLength(1);
    expect(tabItems(lists, 'done')).toHaveLength(1);
    expect(sectionsOf(rows, 'live', 'active').map(g => g.label)).toEqual(['Failed', 'Needs you', 'Working', 'Waiting', 'Idle']);
  });
});

describe('freshness and placement boundaries', () => {
  it.each([failed, working, waiting, {}])('Unknown replaces stale source facts %j', facts => {
    expect(evaluate({ ...facts, sourceHealth: { ok: false, at: now } }).pill).toBe('unknown');
    expect(evaluate({ ...facts, ...needs, sourceHealth: { ok: false, at: now } }).pill).toBe('needs');
  });
  it('every recorded request is Needs you even if its text sounds optional', () => {
    for (const kind of ['question', 'approval'] as const) expect(evaluate({ pending: { kind, question: 'Optional: buy a lamp', options: [], at: now } as never }).pill).toBe('needs');
  });
  it('new runs clear earlier failures', () => expect(evaluate({ ...failed, running: { since: now + 1 }, heartbeatAt: now }).pill).toBe('working'));
  it('saved Needs you count includes read failures and asks; Active has all rows', () => {
    const rows = cases.map(([, facts], i) => ({ id: String(i), disposition: 'active', seen: 'seen', facts, status: evaluate(facts, { seen: 'seen' }) }));
    const lists = { active: { items: rows } };
    expect(viewItems(lists, DEFAULT_VIEWS[0])).toHaveLength(2);
    expect(viewItems(lists, DEFAULT_VIEWS[1])).toHaveLength(5);
    expect(countsOf(rows).needs).toBe(2);
  });
  it('workers nest by recorded role and parent, with cycles bounded', () => {
    const lead = { id: 'lead', facts: {}, disposition: 'active' };
    const worker = { id: 'worker', facts: { role: 'worker', parentItemId: 'lead' }, disposition: 'active', status: { audience: 'lead' } };
    expect(nestedRows([lead], [worker])[0].children[0].item.id).toBe('worker');
    expect(nestedRows([lead], [{ ...worker, facts: { parentItemId: 'lead' } }])[0].children).toHaveLength(0);
    const cycle = { ...lead, facts: { role: 'worker', parentItemId: 'worker' }, status: { audience: 'lead' } };
    expect(nestedRows([cycle, worker], [cycle, worker])).toHaveLength(2);
  });
  it('a lead keeps its workers folded until the owner opens it, wherever the workers are grouped', () => {
    const lead = { id: 'lead', facts: {}, disposition: 'active' };
    const worker = { id: 'worker', facts: { role: 'worker', parentItemId: 'lead' }, disposition: 'active', status: { audience: 'lead' } };
    const other = { id: 'other', facts: {}, disposition: 'active' };
    const groups = [{ key: 'needs', items: [lead] }, { key: 'waiting', items: [worker, other] }];
    const lists = { active: { items: [lead, worker, other] } };
    const ids = (state: object) => shownRows(groups, state).map((g) => g.rows.map((i: { id: string }) => i.id));
    expect(ids({ lists })).toEqual([['lead'], ['other']]);
    expect(ids({ lists, workersOpen: ['lead'] })).toEqual([['lead', 'worker'], ['other']]);
  });
});

describe('Done closes only the Next — you ask', () => {
  it('an open brief, question or approval keeps a done row in Needs you', () => {
    for (const kind of ['brief', 'question', 'approval'] as const) {
      const status = evaluate({ pending: { kind, question: 'Pick one', options: [], at: now } as never }, { disposition: 'done' });
      expect(status).toMatchObject({ layer: 'needs', pill: 'needs', countsForOwner: true });
      expect(status.detail).toContain('marked done, still open');
    }
  });
  it('a done row with only a Next — you ask is Done', () => expect(evaluate(needs, { disposition: 'done' })).toMatchObject({ layer: 'done', countsForOwner: false }));
});
