import { describe, expect, it, vi } from 'vitest';
import { askOf, heldOf, inFlightOf } from '../server/desk/source-loom.js';
import { closingHandoff as loomHandoff } from '@tango/loom';
import { closingHandoff, deriveNextStep, RUNNING_STALE_MS, type StepInput } from '../server/desk/next-step.js';
import { statusWord } from '../server/desk/mail.js';
import { isIdle } from '../server/desk/coordinator.js';
import { deskStatus, needsOwner, STALL_MS } from '../server/desk/status.js';
import { DEFAULT_VIEWS, matchesView } from '../public/desk/list-views.js';
import { statusWords } from '../public/desk/next/model.js';

const T = 1_800_000_000_000;
const status = (patch: Record<string, unknown>) => deskStatus({ facts: {}, nextStep: 'fyi', nextStepBasis: 'fallback', seen: 'seen', ...patch } as never, T);
const step = (patch: Partial<StepInput> = {}) =>
  deriveNextStep({ facts: { contentKey: 'k' }, summary: null, fallbackStep: 'fyi', lastActivityAt: T, lastOwnerMessageAt: null, now: T, formatTime: () => '6:00 PM', ...patch });

describe('the fact evaluator', () => {
  it('retains completed fan-out links without hiding finished or stuck handoffs', () => {
    const project = (ambient: boolean) => inFlightOf({}, { tasks: [{ id: 'batch', kind: 'fan_out', ambient, description: '2 probes · 2 done', url: '/artifacts/batch/results.json' }], waits: [] } as never);
    const completed = project(false);
    expect(completed[0]).toMatchObject({ text: '2 probes · 2 done', url: '/artifacts/batch/results.json' });
    expect(completed[0].watcher).toBeUndefined();
    const handoff = { owner: 'none', at: T - 1, text: 'Done' };
    expect(status({ facts: { handoff, inFlight: project(true) } }).pill).toBe('waiting');
    expect(status({ facts: { handoff, inFlight: completed } }).pill).toBe('finished');
    expect(status({ facts: { handoff: { ...handoff, owner: 'me', stuck: true }, inFlight: completed } }).pill).toBe('stuck');
  });

  it('uses six pills, with no summary or next-step fallback', () => {
    for (const nextStep of ['your_move', 'failed', 'working', 'watching', 'fyi']) {
      expect(status({ nextStep, seen: 'new' })).toMatchObject({ pill: 'idle', countsForOwner: false, unread: true });
    }
  });
  it('ignores a retained T3 ask inferred from prose', () => {
    expect(status({ source: 't3', nextStep: 'your_move', nextStepBasis: 'source:next-line', askRecord: { text: 'Pick a plan', at: T } })).toMatchObject({ pill: 'idle', countsForOwner: false });
  });
  it('opening an ask clears only unread', () => {
    const facts = { openAsk: { text: 'Pick a layout', at: T } };
    for (const seen of ['new', 'seen']) {
      expect(status({ facts, seen })).toMatchObject({ pill: 'needs', layer: 'needs', countsForOwner: true, unread: seen !== 'seen' });
    }
  });
  it('orders failure, owner request, running work, wait and idle', () => {
    const facts = { failed: { at: T, message: 'crashed' }, pending: { kind: 'question', question: 'Approve?' }, running: { since: T - 1 }, waits: [{ id: 'w', kind: 'pr', target: 'PR #9', armedAt: T }] };
    expect(status({ facts })).toMatchObject({ pill: 'failed', countsForOwner: true });
    expect(status({ facts: { ...facts, failed: null } })).toMatchObject({ pill: 'needs', stillWorking: true, detail: 'Approve? · still working' });
    expect(status({ facts: { ...facts, failed: null, pending: null } })).toMatchObject({ pill: 'working' });
    expect(status({ facts: { ...facts, failed: null, pending: null, running: null } })).toMatchObject({ pill: 'waiting' });
    expect(status({ facts: {} })).toMatchObject({ pill: 'idle' });
  });
  it('a later run clears a failure', () => {
    expect(status({ facts: { failed: { at: T - 2 }, running: { since: T - 1 } } })).toMatchObject({ pill: 'working', countsForOwner: false });
  });
  it('uses health as since, and a failed health observation as Unknown', () => {
    expect(status({ facts: { sourceHealth: { ok: true, at: 1 } } })).toMatchObject({ pill: 'idle' });
    expect(status({ source: 'loom', facts: { sourceHealth: { ok: false, at: T, detail: 'unreachable' } } })).toMatchObject({ pill: 'unknown', detail: `loom: unreachable, since ${new Date(T).toISOString()}` });
    expect(status({ facts: { sourceHealth: { ok: false, at: T }, openAsk: { text: 'Approve?', at: T } } })).toMatchObject({ pill: 'needs' });
  });
  it('requires fresh heartbeats, with no running-duration timeout', () => {
    expect(status({ facts: { running: { since: 1 }, heartbeatAt: T } })).toMatchObject({ pill: 'working' });
    expect(status({ facts: { running: { since: 1 }, heartbeatAt: T - 120_001 } })).toMatchObject({ pill: 'unknown', stillWorking: false });
  });
  it('a wait is Unknown only while its check is failing', () => {
    const wait = { id: 'w', kind: 'pr', target: 'PR #9', armedAt: 1, lastCheckedAt: 1 };
    expect(status({ facts: { waits: [wait] } })).toMatchObject({ pill: 'waiting' });
    expect(status({ facts: { waits: [{ ...wait, checkError: 'offline' }] } })).toMatchObject({ pill: 'unknown' });
    // A newer wait failing its check is not hidden behind a healthy older one.
    expect(status({ facts: { waits: [wait, { ...wait, id: 'w2', armedAt: 2, checkError: 'offline' }] } })).toMatchObject({ pill: 'unknown' });
  });
  it('a wait reads Unknown only after three failed checks in a row, since the first of them', () => {
    const wait = { id: 'w', kind: 'pr', target: 'PR #9', armedAt: 1, lastCheckedAt: T, checkError: 'offline', errorSince: T - 600_000 };
    for (const consecutiveErrors of [1, 2]) {
      expect(status({ facts: { waits: [{ ...wait, consecutiveErrors }] } })).toMatchObject({ pill: 'waiting', detail: `PR #9 · checked 0m ago · check failed ${consecutiveErrors} of 3` });
    }
    expect(status({ source: 'loom', facts: { waits: [{ ...wait, consecutiveErrors: 3 }] } })).toMatchObject({ pill: 'unknown', detail: `loom: PR #9 check failing: offline, since ${new Date(T - 600_000).toISOString()}` });
    // The broken wait shows even behind an older one that failed only once.
    expect(status({ facts: { waits: [{ ...wait, consecutiveErrors: 1 }, { ...wait, id: 'w2', target: 'PR #10', consecutiveErrors: 4 }] } })).toMatchObject({ pill: 'unknown', detail: expect.stringContaining('PR #10') });
  });
  it('a time wait says until when, its date when not today, and no check age', () => {
    const due = (at: number) => status({ facts: { waits: [{ id: 'w', kind: 'time', target: '9:00 AM', armedAt: 1, dueAt: at, lastCheckedAt: T }] } }).detail;
    expect(due(T)).toBe('until 9:00 AM');
    const later = T + 14 * 86_400_000;
    expect(due(later)).toBe(`until ${new Date(later).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
  });
  it('a hold reads in words, with when it clears', () => {
    expect(status({ facts: { held: { reason: 'queued', until: null } } })).toMatchObject({ pill: 'waiting', detail: 'Starts shortly: a message is waiting to run' });
    expect(status({ facts: { held: { reason: 'disk_low', until: null } } }).detail).toBe('Held: the disk is nearly full');
    expect(status({ facts: { held: { reason: 'something_new', until: null } } }).detail).toBe('something_new');
    const until = T + 30 * 60_000;
    expect(status({ facts: { held: { reason: 'account_limit', until } } }).detail).toBe(`Held: the account hit its usage limit, until ${new Date(until).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
    expect(status({ facts: { held: { reason: 'provider_busy', until: null } } }).detail).toBe('Held: the model is at capacity; Loom retries it');
  });
  it('a command wait shows its note, not the shell check', () => {
    const wait = { id: 'w', kind: 'command', target: "gh pr view 938 --json statusCheckRollup | jq -e '.[] | length==0'", note: 'PR 938: CI done', armedAt: 1, lastCheckedAt: T };
    expect(status({ facts: { waits: [wait] } }).detail).toBe('PR 938: CI done · checked 0m ago');
    expect(status({ facts: { waits: [{ ...wait, note: null }] } }).detail).toBe('a command check · checked 0m ago');
  });
  it('a row with several open briefs says how many more', () => {
    const brief = { kind: 'question', requestId: 'decision:D-205', questions: [], question: 'Pick a host', options: [], at: 1, brief: { id: 'D-205' } };
    expect(status({ facts: { openBrief: brief, openBriefCount: 1 } }).detail).toBe('Pick a host');
    expect(status({ facts: { openBrief: brief, openBriefCount: 2 } }).detail).toBe('Pick a host (+1 more open brief)');
    expect(status({ facts: { openBrief: brief, openBriefCount: 3 } }).detail).toBe('Pick a host (+2 more open briefs)');
    // A live question in front of the briefs counts every brief as more.
    expect(status({ facts: { pending: { ...brief, requestId: 'q', brief: undefined, question: 'Which?' }, openBrief: brief, openBriefCount: 1 } }).detail).toBe('Which? (+1 more open brief)');
  });
  it('a pending PR review stays a review wait, not a background monitor', () => {
    const result = step({ facts: { openedPrUrls: ['https://github.com/acme/widgets/pull/9'], prReview: { state: 'pending', reviewers: ['codex'], number: 9, since: T } } as StepInput['facts'] });
    expect(result).toMatchObject({ step: 'watching', basis: 'source:pr-review' });
    expect(result.watching?.basis).not.toBe('background');
  });
  it('PR review and CI never ask the owner', () => {
    for (const state of ['pending', 'changes_requested']) expect(status({ facts: { openedPrUrls: ['https://github.com/acme/widgets/pull/9'], prReview: { state, number: 9 } } })).toMatchObject({ pill: 'waiting', countsForOwner: false });
    for (const state of ['running', 'failing']) expect(status({ facts: { openedPrUrls: ['https://github.com/acme/widgets/pull/9'], prChecks: { state, number: 9 } } })).toMatchObject({ pill: 'waiting', countsForOwner: false });
  });
  it('worker and ops requests and failures report to live leads', () => {
    for (const role of ['worker', 'ops']) {
      for (const obligation of [{ pending: { kind: 'question', question: 'Approve?' } }, { failed: { at: T, message: 'crashed' } }]) {
        const facts = { role, parentItemId: 'lead', ...obligation };
        expect(status({ facts })).toMatchObject({ audience: 'lead', countsForOwner: false, pill: 'failed' in obligation ? 'failed' : 'waiting' });
        for (const gone of [{ ownerGone: true }, { leadAway: { itemId: 'lead' } }, { parentItemId: null }]) expect(status({ facts: { ...facts, ...gone } })).toMatchObject({ audience: 'owner', countsForOwner: true });
      }
    }
  });
  it('Done closes an ask but preserves questions, approvals and briefs', () => {
    const facts = { openAsk: { text: 'Choose?', at: T } };
    expect(status({ facts, disposition: 'done' })).toMatchObject({ layer: 'done', pill: 'idle', countsForOwner: false });
    for (const request of [{ pending: { kind: 'question', question: 'Choose?' } }, { pending: { kind: 'approval', question: 'Choose?' } }, { openBrief: { kind: 'question', question: 'Choose?' } }]) {
      expect(status({ facts: { ...facts, ...request }, disposition: 'done' })).toMatchObject({ layer: 'needs', pill: 'needs', countsForOwner: true, detail: 'marked done, still open · Choose?' });
    }
  });
  it('a none hand-off is Finished, a woken me hand-off with nothing behind it is Stuck, until the owner writes', () => {
    const none = { owner: 'none', text: 'merged #953', at: T - 10, source: 'tool' };
    const stuck = { owner: 'me', text: 'run the tests', at: T - 10, source: 'tool', wokeAt: T - 20, stuck: true };
    expect(status({ facts: { handoff: none } })).toMatchObject({ pill: 'finished', detail: 'merged #953', countsForOwner: false, layer: 'active', basis: 'source:handoff' });
    expect(status({ facts: { handoff: stuck } })).toMatchObject({ pill: 'stuck', countsForOwner: true, layer: 'needs', basis: 'source:handoff-stuck' });
    expect(status({ facts: { handoff: stuck } }).detail).toMatch(/^said it would go on, nothing running since /);
    // A me hand-off Loom only woke once for is still Idle; one the owner wrote after is history.
    expect(status({ facts: { handoff: { ...stuck, stuck: undefined } } })).toMatchObject({ pill: 'idle' });
    expect(status({ facts: { handoff: none }, lastOwnerMessageAt: T - 5 })).toMatchObject({ pill: 'idle' });
    expect(status({ facts: { handoff: stuck }, lastOwnerMessageAt: T - 5 })).toMatchObject({ pill: 'idle' });
  });
  it('Finished and Stuck yield to a failure, an open brief, running work and an armed wait', () => {
    const handoff = { owner: 'none', text: 'done', at: T - 10, source: 'tool' };
    expect(status({ facts: { handoff, failed: { at: T - 1, message: 'crashed' } } })).toMatchObject({ pill: 'failed' });
    expect(status({ facts: { handoff, openBrief: { kind: 'question', question: 'Approve?', brief: true } } })).toMatchObject({ pill: 'needs' });
    expect(status({ facts: { handoff, running: { since: T - 1 } } })).toMatchObject({ pill: 'working' });
    expect(status({ facts: { handoff, runningWorkers: 1 } })).toMatchObject({ pill: 'working' });
    expect(status({ facts: { handoff, waits: [{ id: 'w', kind: 'pr', target: 'PR #9', armedAt: T }] } })).toMatchObject({ pill: 'waiting' });
    expect(status({ facts: { handoff: { ...handoff, owner: 'me', stuck: true }, waits: [{ id: 'w', kind: 'pr', target: 'PR #9', armedAt: T }] } })).toMatchObject({ pill: 'waiting' });
    // Marked done: Finished stays the pill, in Done.
    expect(status({ facts: { handoff }, disposition: 'done' })).toMatchObject({ pill: 'finished', layer: 'done' });
  });
  it('Later preserves the pill without counting it', () => {
    for (const disposition of ['snoozed', 'parked']) expect(status({ disposition, facts: { openAsk: { text: 'Choose?', at: T } } })).toMatchObject({ layer: 'later', pill: 'needs', countsForOwner: false });
  });
});

describe('the recorded ask', () => {
  const running = { contentKey: 'k', running: { since: T - 60_000, lastAt: T - 5_000 }, lastAuthor: 'agent' as const };
  it('is the owner move exactly while it is open, whatever else runs', () => {
    expect(step({ facts: { ...running, openAsk: { text: 'pick a layout', at: T - 120_000 } } })).toMatchObject({ step: 'your_move', basis: 'source:ask', ask: 'pick a layout' });
    expect(step({ facts: { contentKey: 'k', background: 'working', openAsk: { text: 'x', at: T - 120_000 } } })).toMatchObject({ step: 'your_move', basis: 'source:ask' });
    // The owner wrote after it (before Loom's echo cleared it): theirs no longer.
    expect(step({ facts: { ...running, openAsk: { text: 'x', at: T - 120_000 } }, lastOwnerMessageAt: T - 60_000 })).toMatchObject({ step: 'working' });
  });
  it("none open: a closing \"Next — you\" or a summary's ask doesn't reopen what the source closed (TGO-1032)", () => {
    const handoff = { owner: 'you' as const, text: 'say go' };
    // Decision D-97 answered: Loom closed the ask its "answer D-97" pointer made.
    expect(step({ facts: { contentKey: 'k', lastAuthor: 'agent', openAsk: null }, handoff, lastAgentAt: T - 1000 })).not.toMatchObject({ step: 'your_move' });
    const summary = { step: 'your_move', ask: 'answer D-97', options: [], gist: 'g', at: T - 1000, contentKey: 'k' };
    expect(step({ facts: { contentKey: 'k', lastAuthor: 'agent', openAsk: null }, summary, lastAgentAt: T - 1000 } as never)).toMatchObject({ step: 'fyi', ask: null });
    expect(step({ facts: { contentKey: 'k', lastAuthor: 'agent', openAsk: null, background: 'monitoring' }, summary, lastAgentAt: T - 1000 } as never)).toMatchObject({ step: 'watching' });
    expect(step({ facts: { ...running, openAsk: null }, standing: { handoff, at: T - 120_000 } })).toMatchObject({ step: 'working' });
    // A source without a typed ask does not infer an ask from closing prose.
    expect(step({ facts: { contentKey: 'k', lastAuthor: 'agent' }, handoff, lastAgentAt: T - 1000 })).toMatchObject({ step: 'fyi' });
  });
  it("Loom's hand-off reader and the desk's agree", () => {
    const cases = ['Done.\n\n**Next — you:** merge #12', '**Next — me:** wait for CI', 'Next – waiting on Ryan: review', 'No hand-off here.', '**Next — you:**\n1. Read it\n2. Say go', 'Quoted **Next — you:** mid-text\n' + 'x\n'.repeat(10)];
    for (const text of cases) expect(loomHandoff(text)).toEqual(closingHandoff(text));
  });
});

describe('views', () => {
  it('uses four tabs and the evaluator owner count after opening', () => {
    expect(DEFAULT_VIEWS.map((v: { id: string }) => v.id)).toEqual(['needs', 'active', 'later', 'done']);
    const row = { facts: { openAsk: { text: 'Choose?', at: T } }, seen: 'seen', disposition: 'active' };
    const asking = { ...row, status: deskStatus(row as never, T) };
    expect(matchesView(asking, DEFAULT_VIEWS.find((v: { id: string }) => v.id === 'needs'))).toBe(true);
    expect(matchesView(asking, DEFAULT_VIEWS.find((v: { id: string }) => v.id === 'active'))).toBe(true);
  });
});

describe('a message the source is holding', () => {
  const sent = (facts: Record<string, unknown>) => ({ facts: { lastAuthor: 'owner', ...facts }, nextStep: 'working', nextStepBasis: 'owner-last', seen: 'seen', lastOwnerMessageAt: T - 10 * 60_000, messageCount: 1 });
  it('a known hold is Waiting; an unexplained stale start is Unknown', () => {
    expect(deskStatus(sent({ held: { reason: 'disk_low' } }) as never, T).pill).toBe('waiting');
    expect(deskStatus(sent({}) as never, T).pill).toBe('unknown');
  });
});

describe('why Loom is holding a thread', () => {
  it('reads its admission, an account limit on a queued run, or maintenance with work queued', () => {
    expect(heldOf({ admission: 'waiting_for_room' }, [])).toEqual({ reason: 'waiting_for_room', until: null });
    expect(heldOf({ admission: 'disk_low', admission_until: 5 }, [])).toEqual({ reason: 'disk_low', until: 5 });
    expect(heldOf({}, [{ status: 'queued', failure: JSON.stringify({ kind: 'usage_limit', resetAt: 9 }) }])).toEqual({ reason: 'account_limit', until: 9 });
    expect(heldOf({ maintenance: true }, [{ status: 'queued', failure: null }])).toEqual({ reason: 'maintenance', until: null });
    expect(heldOf({ maintenance: true }, [{ status: 'completed', failure: null }])).toBeNull();
    // A run that really failed on a limit is a failure the owner sees, not a hold.
    expect(heldOf({}, [{ status: 'failed', failure: JSON.stringify({ kind: 'usage_limit' }) }])).toBeNull();
  });
});

describe('starting freshness', () => {
  const base = { nextStep: 'working', nextStepBasis: 'owner-last', seen: 'seen', lastOwnerMessageAt: T - 17 * 60_000, messageCount: 3 };
  it("counts only the owner's own words waiting: mail spoke last, nothing of theirs waits", () => {
    expect(deskStatus({ ...base, facts: { lastAuthor: 'owner', lastAuthorMail: true } } as never, T).live).not.toBe('failed');
    expect(deskStatus({ ...base, facts: { lastAuthor: 'owner', lastAuthorMail: false } } as never, T).pill).toBe('unknown');
  });
  it('a queued run reads Waiting without inventing a failure', () => {
    expect(deskStatus({ ...base, facts: { lastAuthor: 'owner', held: { reason: 'queued' } } } as never, T).pill).toBe('waiting');
    expect(heldOf({ status: 'idle' }, [{ status: 'queued', failure: null }])).toEqual({ reason: 'queued', until: null });
    expect(heldOf({ status: 'running' }, [{ status: 'queued', failure: null }])).toBeNull();
  });
});

describe('away rows', () => {
  it('a snoozed or parked ask waits on the owner only once it wakes', () => {
    const asking = { facts: { lastAuthor: 'agent', openAsk: { text: 'Choose?', at: T } }, nextStep: 'your_move', nextStepBasis: 'source:next-line', seen: 'new' };
    expect(needsOwner({ ...asking, disposition: 'active' } as never, T)).toBe(true);
    expect(needsOwner({ ...asking, disposition: 'snoozed' } as never, T)).toBe(false);
    expect(needsOwner({ ...asking, disposition: 'parked' } as never, T)).toBe(false);
    // The shared status says so too, for every reader (other agents' "needs owner" queries): no owner's move while away.
    expect(deskStatus({ ...asking, disposition: 'snoozed' } as never, T).pill).toBe('needs');
    expect(deskStatus({ ...asking, disposition: 'active' } as never, T).move).toBe('needs');
    // What it is doing still shows while away.
    expect(deskStatus({ facts: { background: 'monitoring' }, nextStep: 'watching', nextStepBasis: 'source:background', seen: 'seen', disposition: 'snoozed' } as never, T).move).toBe('watching');
  });
});

describe('a hold and a failure', () => {
  it('the hold outranks only the scheduler timeout it explains; any other failure stays (Codex review on #832)', () => {
    const row = (failed: Record<string, unknown>, held: Record<string, unknown> | null) => ({ facts: { lastAuthor: 'agent', failed, held }, nextStep: 'failed', nextStepBasis: 'source:failed', seen: 'seen' });
    expect(deskStatus(row({ at: T, reason: 'schedule', message: 'scheduled turn timed out' }, { reason: 'account_limit' }) as never, T)).toMatchObject({ pill: 'waiting', countsForOwner: false });
    expect(deskStatus(row({ at: T, reason: 'error', message: 'The harness crashed' }, { reason: 'disk_low' }) as never, T).move).toBe('failed');
    expect(deskStatus(row({ at: T, reason: 'schedule', message: 'the last run failed' }, { reason: 'account_limit' }) as never, T).move).toBe('failed');
    expect(deskStatus(row({ at: T, reason: 'schedule', message: 'scheduled turn timed out' }, null) as never, T).move).toBe('failed');
  });
});

describe('who an ask is for', () => {
  const asking = { facts: { lastAuthor: 'agent', openAsk: { text: 'Choose?', at: T } }, nextStep: 'your_move', nextStepBasis: 'source:next-line', seen: 'new', disposition: 'active' };
  it('a done row waits on nobody, to every reader (other agents see idle, not needs owner)', () => {
    const done = { ...asking, disposition: 'done' };
    expect(deskStatus(done as never, T)).toMatchObject({ pill: 'idle' });
    expect(needsOwner(done as never, T)).toBe(false);
    expect(statusWord(done as never)).toBe('idle');
    expect(statusWord(asking as never)).toBe('needs you');
  });
  it("an interactive or default conversation owns its asks regardless of who started it", () => {
    const child = { ...asking, facts: { lastAuthor: 'agent', openAsk: { text: 'Choose?', at: T }, role: 'interactive', parentItemId: 'loom:lead' } };
    expect(deskStatus(child as never, T).pill).toBe('needs');
    expect(statusWord(child as never)).toBe('needs you');
    expect(deskStatus({ ...child, facts: { ...child.facts, pending: { kind: 'question' } } } as never, T).move).toBe('needs');
    expect(deskStatus({ ...child, facts: { ...child.facts, ownerGone: true } } as never, T).move).toBe('needs');
    // Once the owner writes in it, it's their conversation: a later ask is theirs (only the start reply goes back).
    expect(deskStatus({ ...child, lastOwnerMessageAt: T - 60_000 } as never, T).move).toBe('needs');
    // A space's default (its standing chat) is the owner's whatever started it.
    expect(deskStatus({ ...child, facts: { ...child.facts, role: 'default' } } as never, T).move).toBe('needs');
  });
  it("an ask Loom recorded as another agent's waits on that agent, never on the owner", () => {
    const raw = JSON.stringify({ text: 'dispatch the reconciliation.', at: T, messageId: 'm', runId: 'r', to: 'T3 cutover handoff', toAddress: 'loom:lead' });
    expect(askOf(raw)).toEqual({ text: 'dispatch the reconciliation.', at: T, messageId: 'loom:m', runId: 'r', to: 'T3 cutover handoff' });
    expect(askOf(JSON.stringify({ text: 'pick', at: T }))).toEqual({ text: 'pick', at: T });
    const facts = { role: 'interactive', parentItemId: 'loom:lead', openAsk: askOf(raw) };
    expect(status({ facts })).toMatchObject({ pill: 'waiting', basis: 'source:agent-request', detail: 'Waiting on T3 cutover handoff: dispatch the reconciliation.', countsForOwner: false, layer: 'active' });
    // A worker's names the agent too, not its lead (Codex review on #931); its own requests still go to the lead.
    expect(status({ facts: { ...facts, role: 'worker', openAsk: { ...askOf(raw)!, to: 'Sibling reviewer' } } })).toMatchObject({ pill: 'waiting', basis: 'source:agent-request', detail: 'Waiting on Sibling reviewer: dispatch the reconciliation.', countsForOwner: false });
    expect(status({ facts: { ...facts, role: 'worker', pending: { kind: 'question', question: 'Approve?' } } })).toMatchObject({ pill: 'waiting', basis: 'source:lead-request', countsForOwner: false });
    // An owner request on the same row still counts.
    expect(status({ facts: { ...facts, pending: { kind: 'question', question: 'Approve?' } } })).toMatchObject({ pill: 'needs', countsForOwner: true });
  });
});

describe('a turn the source has queued', () => {
  it("queued and capacity-held turns read Waiting and never count as idle", () => {
    // A lead's mail reply: Loom queued its turn and holds it a minute; the thread itself is idle meanwhile.
    const queued = { facts: { lastAuthor: 'owner', lastAuthorMail: true, held: { reason: 'queued', until: null } }, nextStep: 'fyi', nextStepBasis: 'source:fyi', seen: 'seen', disposition: 'active' };
    expect(statusWord(queued as never)).toBe('waiting');
    expect(isIdle(queued as never)).toBe(false);
    const diskHeld = { ...queued, facts: { ...queued.facts, held: { reason: 'disk_low' } } };
    expect(statusWord(diskHeld as never)).toBe('waiting');
    expect(isIdle(diskHeld as never)).toBe(false);
    expect(isIdle({ ...queued, facts: { lastAuthor: 'agent' } } as never)).toBe(true);
  });
});

it('an idle Loom wait is Watching on the API and agent surface', () => {
  const facts = { background: 'monitoring' as const, openAsk: null, inFlight: [{ kind: 'wait' as const, waitKind: 'pr_review', text: 'PR #913 review', since: T }] };
  const derived = step({ facts });
  const item = { facts, nextStep: derived.step, nextStepBasis: derived.basis, seen: 'seen' as const };
  expect(deskStatus(item, T)).toMatchObject({ busy: null, live: 'watching' });
  expect(statusWord(item)).toBe('waiting');
  expect(derived.watching?.reason).toBe('PR #913 review');
});

it('an open Loom ask or request outranks background work in every status word', () => {
  for (const obligation of [{ openAsk: { text: 'Approve?', at: T } }, { pending: { kind: 'question' as const, question: 'Approve?', options: [] } }]) {
    const facts = { background: 'working' as const, ...obligation };
    const derived = step({ facts });
    const item = { facts, nextStep: derived.step, nextStepBasis: derived.basis, seen: 'new' as const };
    expect(deskStatus(item, T)).toMatchObject({ move: 'needs', live: 'needs', busy: 'background' });
    expect(statusWord(item)).toBe('needs you');
  }
});

it('both parsers recognize an owner handoff, but status requires a recorded ask', () => {
  for (const who of ['you', 'the owner', 'owner', 'user', 'the user']) {
    const text = `Next — waiting on ${who}: sign in`;
    expect(closingHandoff(text)).toEqual({ owner: 'you', text: 'sign in' });
    expect(loomHandoff(text)).toEqual(closingHandoff(text));
    expect(step({ handoff: closingHandoff(text), lastAgentAt: T })).toMatchObject({ step: 'fyi', ask: null });
  }
});

it('ops asks reach a live lead, otherwise the owner', () => {
  for (const obligation of [{ openAsk: { text: 'Choose?', at: T } }, { pending: { kind: 'question' } }]) {
    const facts = { role: 'ops', parentItemId: 'lead', ...obligation };
    expect(status({ nextStep: 'your_move', seen: 'new', facts })).toMatchObject({ audience: 'lead', pill: 'waiting' });
    for (const gone of [{ ownerGone: true }, { leadAway: { itemId: 'lead', title: 'Lead' } }, { parentItemId: null }]) {
      expect(status({ nextStep: 'your_move', seen: 'new', facts: { ...facts, ...gone } })).toMatchObject({ audience: 'owner', move: 'needs' });
    }
  }
});

it('the privately configured owner name is an owner move in both parsers', () => {
  vi.stubEnv('TANGO_OWNER_NAME', 'Avery');
  try {
    const text = 'Next — waiting on Avery: sign in';
    expect(closingHandoff(text)).toEqual({ owner: 'you', text: 'sign in' });
    expect(loomHandoff(text)).toEqual(closingHandoff(text));
  } finally { vi.unstubAllEnvs(); }
});

it('Loom detail preserves a wait kind and target without a schema change', () => {
  expect(inFlightOf({ background: null }, { tasks: [], waits: [{ id: 'w', kind: 'pr', note: '', text: 'PR #913 review', created_at: T }] })).toEqual([{ kind: 'wait', waitKind: 'pr', text: 'PR #913 review', since: T, until: null }]);
});

describe('the status words a row and a conversation show', () => {
  const at = (pill: string, detail: string) => statusWords({ status: { pill, detail } });
  it('puts the reason beside the pill only where it says more than the pill', () => {
    expect(at('waiting', 'PR #9 review · checked 3m ago')).toEqual({ why: 'PR #9 review · checked 3m ago', ask: null });
    expect(at('failed', 'Model at capacity · sent to owner')).toEqual({ why: 'Model at capacity · sent to owner', ask: null });
    expect(at('stuck', 'Nothing behind its hand-off')).toMatchObject({ why: 'Nothing behind its hand-off' });
    expect(at('working', 'Turn running')).toEqual({ why: null, ask: null });
    expect(at('working', '1 worker')).toEqual({ why: null, ask: null });
    expect(at('finished', 'done.')).toEqual({ why: null, ask: null });
    expect(at('idle', '')).toEqual({ why: null, ask: null });
  });
  it("keeps a Needs you row's question as its own line", () => {
    expect(at('needs', 'Which cut goes to Final Cut?')).toEqual({ why: null, ask: 'Which cut goes to Final Cut?' });
  });
});


it('D-353: an agent-addressed ask never becomes the owner’s when its lead is away or starter is another conversation', () => {
  for (const role of ['worker', 'interactive']) {
    for (const away of [{ ownerGone: true }, { leadAway: { itemId: 'lead', title: 'Lead' } }]) {
      expect(status({ source: 'loom', startedBy: 'loom:starter', facts: {
        role, parentItemId: 'loom:lead', ...away,
        openAsk: { text: 'review my report', at: T, to: 'Lead', toAddress: 'loom:lead' },
      } })).toMatchObject({ pill: 'waiting', detail: 'Waiting on Lead: review my report', countsForOwner: false });
    }
  }
});
it('D-353: omitting the tool after the corrective wake is Stuck, never Needs you', () => {
  for (const owner of ['you', 'none', 'me']) expect(status({ source: 'loom', facts: {
    handoff: { owner, text: 'prose', at: T, source: 'closing-line', missingTool: true, stuck: true },
  } })).toMatchObject({ pill: 'stuck', detail: 'No tool hand-off recorded after Loom’s corrective wake' });
});

it.each(['mentioned', 'watched'])('ignores %s PR review and checks without a live watch', relation => {
  const url = 'https://github.com/acme/widgets/pull/7';
  const facts = { handoff: { owner: 'none', at: T - 1 }, prReview: { number: 7, state: 'changes_requested', since: T - 2 }, prChecks: { number: 7, state: 'failing' }, prReviews: [{ url, number: 7, state: 'changes_requested', since: T - 2 }] };
  expect(status({ facts, prs: [{ url, number: 7, relation, watched: true }] }).pill).toBe('finished');
  expect(status({ facts, prs: [{ url, number: 7, relation: 'opened', watched: false }] }).pill).toBe('waiting');
  expect(status({ facts: { ...facts, prWatches: [{ url, number: 7 }] }, prs: [{ url, number: 7, relation }] }).pill).toBe('waiting');
});
