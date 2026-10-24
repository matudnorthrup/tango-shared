import { describe, expect, it } from 'vitest';
import { extractArtifacts } from '../server/desk/artifacts.js';
import { initialAttention, reduceAttention, replayAttention } from '../server/desk/attention.js';
import { latestSweepTime, nextWeekday } from '../server/desk/core.js';
import { closingHandoff, deriveNextStep, type StepInput } from '../server/desk/next-step.js';
import { aggregateReviews, reviewFact } from '../server/desk/source-github.js';
import { parsePrUrl } from '../server/desk/artifacts.js';
import { cleanNext, fallbackSummary, isAckOnly, parseModelSummary, validOptions } from '../server/desk/summarize.js';
import type { Attention, DeskEvent, DeskSummary } from '../server/desk/types.js';

const T = 1_790_000_000_000;
type Ev = Pick<DeskEvent, 'type' | 'at' | 'payload' | 'actor'>;
const ev = (type: DeskEvent['type'], payload: Record<string, unknown> = {}, at = T): Ev => ({ type, at, payload, actor: 'system' });
const run = (...events: Ev[]): Attention => events.reduce(reduceAttention, initialAttention('i'));

describe('attention reducer', () => {
  it('starts New for agent-started items and Seen for owner-started ones', () => {
    expect(run(ev('source.created', { by: 'agent' }))).toMatchObject({ disposition: 'active', seen: 'new' });
    expect(run(ev('source.created', { by: 'owner' }))).toMatchObject({ disposition: 'active', seen: 'seen' });
  });

  it('infers seen from engagement; passive views never pull an item out of snooze or done', () => {
    const created = ev('source.created', { by: 'agent' });
    for (const via of ['viewed', 'heard', 'briefed', 'read']) expect(run(created, ev('seen', { via })).seen).toBe('seen');
    expect(run(created, ev('park'), ev('seen', { via: 'viewed' })).disposition).toBe('parked');
    expect(run(created, ev('done'), ev('seen', { via: 'heard' })).disposition).toBe('done');
    // Mark read and Mark unread: wherever it is, and it stays there.
    expect(run(created, ev('snooze', { until: T + 60_000 }), ev('seen', { via: 'read' }))).toMatchObject({ disposition: 'snoozed', seen: 'seen' });
    expect(run(created, ev('done'), ev('seen', { via: 'read' }))).toMatchObject({ disposition: 'done', seen: 'seen' });
    expect(run(created, ev('seen', { via: 'read' }), ev('done'), ev('unseen'))).toMatchObject({ disposition: 'done', seen: 'new' });
    expect(run(created, ev('seen', { via: 'read' }), ev('unseen'))).toMatchObject({ disposition: 'active', seen: 'new' });
    // 👀 is "keep it in my rotation": it brings a parked item back.
    expect(run(created, ev('park'), ev('seen', { via: 'explicit' }))).toMatchObject({ disposition: 'active', seen: 'seen' });
    // The owner writing in the conversation picks a finished one back up.
    expect(run(created, ev('done'), ev('source.owner_posted'))).toMatchObject({ disposition: 'active', seen: 'seen' });
  });

  it('a message filed after the operator already spoke it (or the owner wrote after it) is not news (late poll, 10/06)', () => {
    const created = ev('source.created', { by: 'agent' }, T);
    // Heard by voice at T+20s; the poll files the agent message (posted at T+5s) at T+40s.
    expect(run(created, ev('seen', { via: 'heard' }, T + 20_000), ev('source.activity', { step: 'your_move', at: T + 5_000 }, T + 40_000)).seen).toBe('seen');
    expect(run(created, ev('source.owner_posted', { at: T + 20_000 }, T + 60_000), ev('source.activity', { step: 'fyi', at: T + 5_000 }, T + 70_000)).seen).toBe('seen');
    // Only opening it on the desk doesn't cover a message the desk hadn't polled yet.
    expect(run(created, ev('seen', { via: 'viewed' }, T + 20_000), ev('source.activity', { step: 'your_move', at: T + 5_000 }, T + 40_000)).seen).toBe('new');
    // A message posted after the engagement is news.
    expect(run(created, ev('seen', { via: 'heard' }, T + 20_000), ev('source.activity', { step: 'your_move', at: T + 30_000 }, T + 40_000)).seen).toBe('new');
  });

  it('new agent activity: done and parked reopen unless ack-only; seen becomes new for your_move/failed, else updated', () => {
    const seen = [ev('source.created', { by: 'agent' }), ev('seen', { via: 'explicit' })];
    expect(run(...seen, ev('source.activity', { step: 'fyi' })).seen).toBe('updated');
    expect(run(...seen, ev('source.activity', { step: 'watching' })).seen).toBe('updated');
    expect(run(...seen, ev('source.activity', { step: 'your_move' })).seen).toBe('new');
    expect(run(...seen, ev('source.activity', { step: 'failed' })).seen).toBe('new');
    expect(run(...seen, ev('done'), ev('source.activity', { step: 'fyi', ackOnly: true })).disposition).toBe('done');
    expect(run(...seen, ev('done'), ev('source.activity', { step: 'fyi', ackOnly: false }))).toMatchObject({ disposition: 'active', seen: 'new' });
    // Parked is out of the way until there's news: the same as done.
    expect(run(...seen, ev('park'), ev('source.activity', { step: 'fyi', ackOnly: true })).disposition).toBe('parked');
    expect(run(...seen, ev('park'), ev('source.activity', { step: 'fyi' }))).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: false });
  });

  it('a step that turns urgent later (a late summary) makes a seen item new', () => {
    const seen = [ev('source.created', { by: 'agent' }), ev('seen', { via: 'explicit' })];
    expect(run(...seen, ev('source.step', { from: 'fyi', to: 'your_move' })).seen).toBe('new');
    expect(run(...seen, ev('source.step', { from: 'fyi', to: 'watching' })).seen).toBe('seen');
  });

  it('snoozes: time and desk snoozes ignore agent posts; agent_posts returns as new from snooze; expiry returns as new', () => {
    const base = [ev('source.created', { by: 'agent' }), ev('seen', { via: 'explicit' })];
    const timed = run(...base, ev('snooze', { until: T + 3_600_000 }));
    expect(timed).toMatchObject({ disposition: 'snoozed', snoozeUntil: T + 3_600_000 });
    expect(reduceAttention(timed, ev('source.activity', { step: 'fyi' })).disposition).toBe('snoozed');
    expect(reduceAttention(timed, ev('snooze.expired', { reason: 'time' }))).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: true });
    const onPost = run(...base, ev('snooze', { trigger: 'agent_posts' }));
    expect(reduceAttention(onPost, ev('source.activity', { step: 'fyi' }))).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: true });
    const desk = run(...base, ev('snooze', { trigger: 'desk' }));
    expect(reduceAttention(desk, ev('source.activity', { step: 'fyi' })).disposition).toBe('snoozed');
    expect(reduceAttention(desk, ev('snooze.expired', { reason: 'desk' })).backFromSnooze).toBe(true);
  });

  it("Loom's own snooze ending returns an active item as new but leaves a local snooze alone", () => {
    const active = run(ev('source.created', { by: 'agent' }), ev('seen', { via: 'explicit' }));
    expect(reduceAttention(active, ev('snooze.expired', { reason: 'source' }))).toMatchObject({ seen: 'new', backFromSnooze: true });
    const local = reduceAttention(active, ev('snooze', { until: T + 99 }));
    expect(reduceAttention(local, ev('snooze.expired', { reason: 'source' })).disposition).toBe('snoozed');
  });

  it('chapter settle, sweep keep/drop, pickup, park, source done', () => {
    const base = [ev('source.created', { by: 'agent' })];
    expect(run(...base, ev('chapter.settled')).disposition).toBe('done');
    expect(run(...base, ev('park'), ev('sweep.keep'))).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(run(...base, ev('park'), ev('sweep.drop')).disposition).toBe('done');
    expect(run(...base, ev('park'), ev('pickup')).disposition).toBe('active');
    expect(run(...base, ev('source.done')).disposition).toBe('done');
  });

  it('records write-back outcomes apart from the decision', () => {
    const done = run(ev('source.created', { by: 'agent' }), ev('done'), ev('writeback', { action: 'done', outcome: 'failed', error: 'HTTP 403', at: T }));
    expect(done).toMatchObject({ disposition: 'done', writeback: { outcome: 'failed', error: 'HTTP 403' } });
  });

  it('replays the log, skipping undone events', () => {
    const events = [
      { seq: 1, ...ev('source.created', { by: 'agent' }), undoesSeq: null },
      { seq: 2, ...ev('seen', { via: 'explicit' }), undoesSeq: null },
      { seq: 3, ...ev('done'), undoesSeq: null },
      { seq: 4, ...ev('undo', { seq: 3 }), undoesSeq: 3 },
    ];
    expect(replayAttention('i', events)).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(replayAttention('i', events.slice(0, 3)).disposition).toBe('done');
  });
});

const summary = (patch: Partial<DeskSummary> = {}): DeskSummary => ({
  gist: 'Where it stands.',
  step: 'fyi',
  ask: null,
  options: [],
  context: [],
  ownerAsk: null,
  watchUntil: null,
  ackOnly: false,
  waitingOn: null,
  source: 'model',
  contentKey: 'k',
  at: T,
  ...patch,
});
const step = (patch: Partial<StepInput> = {}) =>
  deriveNextStep({ facts: { contentKey: 'k' }, summary: null, fallbackStep: 'fyi', lastActivityAt: T, lastOwnerMessageAt: null, now: T, formatTime: () => '6:00 PM', ...patch });

describe('next step: compatibility projection of recorded status', () => {
  it('an open ask beats background work and monitoring', () => {
    for (const background of ['working', 'monitoring'] as const) expect(step({ facts: { contentKey: 'k', background, openAsk: { text: 'Choose?', at: T } } })).toMatchObject({ step: 'your_move', basis: 'source:ask', ask: 'Choose?' });
  });
  it('a standing prose handoff does not reopen a source record', () => {
    const standing = { handoff: { owner: 'you' as const, text: 'Choose?' }, at: T - 1000 };
    expect(step({ facts: { contentKey: 'k', openAsk: null }, standing })).toMatchObject({ step: 'fyi', ask: null });
    expect(step({ facts: { contentKey: 'k', openAsk: { text: 'Choose?', at: T - 1000 }, running: { since: T } }, standing })).toMatchObject({ step: 'your_move' });
  });
  it('a later run clears failure; an open request then beats that run', () => {
    const facts = { contentKey: 'k', failed: { at: T, reason: 'error', message: 'crashed' }, running: { since: T - 1 }, pending: { kind: 'question' as const, question: 'Which?', options: ['A', 'B'], at: T } };
    expect(step({ facts })).toMatchObject({ step: 'failed', basis: 'source:failed', ask: 'crashed' });
    expect(step({ facts: { ...facts, running: { since: T + 1 } } })).toMatchObject({ step: 'your_move', basis: 'source:question', ask: 'Which?', options: ['A', 'B'] });
    expect(step({ facts: { ...facts, failed: null, pending: null } })).toMatchObject({ step: 'working' });
    expect(step({ facts: { contentKey: 'k', job: { id: 'j', agentId: 'a', label: 'Batch', startedAt: T, deadlineAt: null } } })).toMatchObject({ step: 'working', basis: 'source:job' });
  });
  it('an owner message alone does not clear a recorded failure', () => {
    expect(step({ facts: { contentKey: 'k', failed: { at: T - 10, reason: 'error', message: 'x' } }, lastOwnerMessageAt: T - 5 })).toMatchObject({ step: 'failed' });
    expect(step({ facts: { contentKey: 'k', running: { since: T - 31 * 60_000 }, heartbeatAt: T } })).toMatchObject({ step: 'working' });
    expect(step({ facts: { contentKey: 'k', running: { since: T }, heartbeatAt: T - 120_001 } })).toMatchObject({ step: 'fyi', basis: 'source:heartbeat' });
  });
  for (const contentKey of ['old', 'k']) {
    it(`${contentKey}: summary asks and fallback words never set a step`, () => {
      expect(step({ summary: summary({ contentKey, step: 'your_move', ask: 'Which?' }), fallbackStep: 'your_move' })).toMatchObject({ step: 'fyi', ask: null, basis: 'source:responding' });
    });
  }
  for (const hours of [1, 25, 49]) {
    it(`${hours}h: a promised update or named person in a summary creates no wait or nudge`, () => {
      for (const waitingOn of [null, { who: 'Reviewer', what: 'copy review' }]) expect(step({ summary: summary({ step: 'watching', watchUntil: new Date(T).toISOString(), waitingOn }), now: T + hours * 3_600_000 })).toMatchObject({ step: 'fyi', watching: null, ask: null });
    });
  }
  it('PR reviews never ask the owner, even after a summary or newer agent words', () => {
    for (const state of ['pending', 'changes_requested', 'approved'] as const) {
      const facts = { contentKey: 'k', openedPrUrls: ['https://github.com/acme/widgets/pull/42'], prReview: { state, reviewers: ['reviewer'], number: 42, since: T } };
      for (const lastAgentAt of [T - 1000, T + 1000]) expect(step({ facts, summary: summary({ step: 'your_move', ask: 'Merge?' }), lastAgentAt })).toMatchObject({ step: state === 'approved' ? 'fyi' : 'watching', ask: null });
    }
  });
  it('a recorded wait keeps its target and observation age', () => {
    expect(step({ facts: { contentKey: 'k', waits: [{ id: 'w', kind: 'pr', target: 'PR #42', armedAt: T, lastCheckedAt: T }] } })).toMatchObject({ step: 'watching', basis: 'source:wait', watching: { reason: 'PR #42 · checked 0m ago' } });
  });
  it('closing prose and summary asks do not substitute for a recorded ask', () => {
    const handoff = { owner: 'you' as const, text: 'say go' };
    expect(step({ handoff, lastAgentAt: T, summary: summary({ step: 'your_move', ask: 'Which?', options: ['A'] }) })).toMatchObject({ step: 'fyi', basis: 'source:responding', ask: null, options: [] });
    expect(step({ handoff: { ...handoff, text: '' }, lastAgentAt: T, summary: summary({ step: 'your_move', ask: 'Which?' }) })).toMatchObject({ step: 'fyi', ask: null, options: [] });
    expect(step({ handoff, lastAgentAt: T - 1000, lastOwnerMessageAt: T })).toMatchObject({ step: 'fyi', ask: null });
  });
});

describe('gh review mapping', () => {
  it('maps reviewDecision and requested reviewers, keeping `since` while the state holds', () => {
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'reviewer-a' }, { slug: 'team-x' }] }, 7, null, T)).toEqual({ state: 'pending', reviewers: ['reviewer-a', 'team-x'], number: 7, since: T });
    const pending = reviewFact({ state: 'OPEN', reviewRequests: [{ login: 'reviewer-a' }] }, 7, null, T)!;
    expect(reviewFact({ state: 'OPEN', reviewRequests: [{ login: 'reviewer-a' }] }, 7, pending, T + 999)!.since).toBe(T);
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'APPROVED' }, 7, pending, T + 5)).toMatchObject({ state: 'approved', since: T + 5 });
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' }, 7, null, T)!.state).toBe('changes_requested');
    expect(reviewFact({ state: 'MERGED', reviewDecision: 'APPROVED' }, 7, null, T)).toBeNull();
    expect(reviewFact({ state: 'OPEN', reviewDecision: '' }, 7, null, T)).toBeNull();
  });

  it('required review with nobody left requested still waits; drafts and bots do not count; a watched PR reads the reviewers themselves', () => {
    const commented = [{ state: 'COMMENTED', author: { login: 'reviewer-a' }, authorAssociation: 'MEMBER' }, { state: 'COMMENTED', author: { login: 'review-bot' }, authorAssociation: 'NONE' }, { state: 'COMMENTED', author: { login: 'ci[bot]' }, authorAssociation: 'MEMBER' }];
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], reviews: commented }, 7, null, T)).toEqual({ state: 'pending', reviewers: ['reviewer-a'], number: 7, since: T });
    expect(reviewFact({ state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [] }, 7, null, T)).toBeNull();
    expect(reviewFact({ state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [] }, 7, null, T, { explicit: true })!.state).toBe('pending');
    // No review rule on the repo: unwatched waits on nothing; watched follows each reviewer's latest decision.
    expect(reviewFact({ state: 'OPEN', reviewDecision: '' }, 7, null, T, { explicit: true })).toEqual({ state: 'pending', reviewers: [], number: 7, since: T });
    const flipped = [{ state: 'CHANGES_REQUESTED', author: { login: 'a' }, authorAssociation: 'MEMBER' }, { state: 'COMMENTED', author: { login: 'a' }, authorAssociation: 'MEMBER' }, { state: 'APPROVED', author: { login: 'b' }, authorAssociation: 'MEMBER' }];
    expect(reviewFact({ state: 'OPEN', reviewDecision: '', reviews: flipped }, 7, null, T, { explicit: true })).toMatchObject({ state: 'changes_requested', reviewers: ['a'] });
    flipped.push({ state: 'APPROVED', author: { login: 'a' }, authorAssociation: 'MEMBER' });
    expect(reviewFact({ state: 'OPEN', reviewDecision: '', reviews: flipped }, 7, null, T, { explicit: true })).toMatchObject({ state: 'approved', reviewers: ['a', 'b'] });
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'APPROVED', reviews: flipped }, 7, null, T)).toMatchObject({ state: 'approved', reviewers: ['a', 'b'] });
    // When the deciding review landed (the latest human one in that state).
    const dated = [{ state: 'APPROVED', author: { login: 'a' }, authorAssociation: 'MEMBER', submittedAt: '2026-10-13T12:00:00Z' }, { state: 'APPROVED', author: { login: 'b' }, authorAssociation: 'MEMBER', submittedAt: '2026-10-13T14:00:00Z' }, { state: 'APPROVED', author: { login: 'bot' }, authorAssociation: 'NONE', submittedAt: '2026-10-14T00:00:00Z' }];
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'APPROVED', reviews: dated }, 7, null, T)!.decidedAt).toBe(Date.parse('2026-10-13T14:00:00Z'));
    expect(reviewFact({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'a' }] }, 7, null, T)).not.toHaveProperty('decidedAt');
  });

  it('several PRs read as one: changes requested, then still waiting, then approved', () => {
    const fact = (state: 'pending' | 'approved' | 'changes_requested', number: number) => ({ state, reviewers: [], number, since: T });
    expect(aggregateReviews([fact('approved', 1), fact('pending', 2)])).toMatchObject({ state: 'pending', number: 2 });
    expect(aggregateReviews([fact('pending', 2), fact('changes_requested', 3)])).toMatchObject({ state: 'changes_requested', number: 3 });
    expect(aggregateReviews([])).toBeNull();
  });

  it('PR links canonicalize', () => {
    expect(parsePrUrl('https://github.com/acme/api/pull/31/files?w=1')).toEqual({ url: 'https://github.com/acme/api/pull/31', number: 31 });
    expect(parsePrUrl('github.com/acme/api/pull/31')).toEqual({ url: 'https://github.com/acme/api/pull/31', number: 31 });
    expect(parsePrUrl('https://github.com/acme/api/issues/31')).toBeNull();
  });
});

describe('summarizer contract', () => {
  const input = (agent: string) => ({ agentName: 'Sierra', place: null, messages: [{ author: 'owner' as const, text: 'Find me a speaker' }, { author: 'agent' as const, text: agent }] });

  it('keeps only options the agent spelled out', () => {
    const last = 'I found two: the Brand P DMH-1770 or the Sony XAV-AX4000. Which one?';
    expect(validOptions(['the Brand P DMH-1770', 'the Sony XAV-AX4000'], last)).toEqual(['the Brand P DMH-1770', 'the Sony XAV-AX4000']);
    expect(validOptions(['Brand P DMH-1770', 'a Brand K'], last)).toEqual([]);
    const parsed = parseModelSummary(JSON.stringify({ gist: 'Two picks.', step: 'your_move', ask: 'Which one?', options: ['Brand P DMH-1770', 'Brand K X'] }), input(last));
    expect(parsed).toMatchObject({ step: 'your_move', ask: 'Which one?', options: [], source: 'model' });
  });

  it('the next action is a few plain words, only on the owner\'s move; links, paths and ids are dropped', () => {
    const asked = parseModelSummary(JSON.stringify({ gist: 'Two picks.', step: 'your_move', ask: 'Which one?', next: 'pick the Pioneer or the Brand K.' }), input('Pioneer or Brand K?'));
    expect(asked.next).toBe('Pick the Pioneer or the Brand K');
    const fyi = parseModelSummary(JSON.stringify({ gist: 'Installed.', step: 'fyi', next: 'Enjoy the speaker' }), input('All installed.'));
    expect(fyi.next).toBeNull();
    expect(cleanNext('net/tango-screen/?')).toBeNull();
    expect(cleanNext('Review create-scenario-publication-documents.sql')).toBeNull();
    expect(cleanNext('Merge PR #39')).toBeNull();
    expect(cleanNext('Point the pin at a99fe02641')).toBeNull();
    expect(cleanNext('Approve')).toBeNull();
    expect(cleanNext("Approve this week's tester payouts")).toBe("Approve this week's tester payouts");
  });

  it('maps waitingOn: a named person makes it watching; the owner never counts', () => {
    const parsed = parseModelSummary(JSON.stringify({ gist: 'Sent for review.', step: 'fyi', waitingOn: { who: 'Ana', what: 'copy review' } }), input('Sent the draft to Ana for review.'));
    expect(parsed).toMatchObject({ step: 'watching', waitingOn: { who: 'Ana', what: 'copy review' } });
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'your_move', waitingOn: { who: 'you', what: 'an answer' } }), input('Which?')).waitingOn).toBeNull();
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'fyi', waitingOn: null }), input('Done.')).waitingOn).toBeNull();
    expect(fallbackSummary(input('Sent to Ana.')).waitingOn).toBeNull();
  });

  it('a report thread is your_move only with an explicit ask (Chief briefing, 10/07)', () => {
    const report = (agent: string) => ({ ...input(agent), kind: 'report' as const });
    const briefing = 'Delivery briefing ready. No new decision needed from you.';
    // The model called a fresh briefing the owner's move with nothing to ask: on a report thread that is FYI.
    expect(parseModelSummary(JSON.stringify({ gist: 'Briefing ready; nothing needs a decision.', step: 'your_move', ask: null }), report(briefing))).toMatchObject({ step: 'fyi', ask: null });
    // An explicit ask still reaches the owner.
    expect(parseModelSummary(JSON.stringify({ gist: 'Merge is blocked.', step: 'your_move', ask: 'Approve the merge?' }), report('Approve the merge?'))).toMatchObject({ step: 'your_move', ask: 'Approve the merge?' });
    // Without the rule, the general reading stands.
    expect(parseModelSummary(JSON.stringify({ gist: 'Plan ready to read.', step: 'your_move', ask: null }), input('The plan is ready.')).step).toBe('your_move');
    // The text fallback carries an earlier open decision on a report thread only when it had an ask.
    const previous = { step: 'your_move' as const, gist: 'Briefing ready.', ask: null };
    expect(fallbackSummary({ ...report('Next checkpoint at 3.'), messages: [{ author: 'agent' as const, text: 'Next checkpoint at 3.' }], previous }).step).toBe('fyi');
    expect(fallbackSummary({ ...input('Next checkpoint at 3.'), messages: [{ author: 'agent' as const, text: 'Next checkpoint at 3.' }], previous }).step).toBe('your_move');
  });

  it('keeps a short "about" line; missing or blank is null, and the text fallback has none', () => {
    expect(parseModelSummary(JSON.stringify({ gist: 'Ready to read.', step: 'your_move', about: '  Harbor tide table   search ' }), input('Ready.')).about).toBe('Harbor tide table search');
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'fyi', about: 'one two three four five six seven eight nine ten' }), input('Done.')).about).toBe('one two three four five six seven eight');
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'fyi', about: ' ' }), input('Done.')).about).toBeNull();
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'fyi' }), input('Done.')).about).toBeNull();
    expect(fallbackSummary(input('Done.')).about).toBeNull();
  });

  it('drops a bad watchUntil and an empty gist throws (caller falls back)', () => {
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'watching', watchUntil: 'at six' }), input('Back at six.')).watchUntil).toBeNull();
    expect(() => parseModelSummary('{"gist": ""}', input('x'))).toThrow();
  });

  it('ack check: pleasantries are ack-only, real updates are not', () => {
    for (const text of ['thanks!', "You're welcome!", '👍', 'Anytime!']) expect(isAckOnly(text)).toBe(true);
    for (const text of ['Ordered the part.', 'Which one?', "You're welcome! Also, the price dropped to $80 — want it?"]) expect(isAckOnly(text)).toBe(false);
  });

  it('the deterministic fallback reads a closing question as your move with that question', () => {
    expect(fallbackSummary(input('I compared both. Should I order the Pioneer?'))).toMatchObject({ step: 'your_move', ask: 'Should I order the Pioneer?', options: [] });
  });

  it('options of a carried earlier choice survive when the last message answers a side question', () => {
    const carried = { agentName: 'Sierra', place: null, messages: [{ author: 'agent' as const, text: 'Brand K DMX958XR or Brand P DMH-WT6000NEX?' }, { author: 'owner' as const, text: 'What is the VIN?' }, { author: 'agent' as const, text: 'The VIN is 1ABC.' }] };
    expect(parseModelSummary(JSON.stringify({ gist: 'Pick open.', step: 'your_move', ask: 'Which speaker?', options: ['Brand K DMX958XR', 'Brand P DMH-WT6000NEX'] }), carried).options).toEqual(['Brand K DMX958XR', 'Brand P DMH-WT6000NEX']);
  });

  it('the fallback keeps an open decision from the previous summary unless the owner wrote since', () => {
    const previous = { step: 'your_move' as const, gist: 'Two picks.', ask: 'Brand K or Pioneer?' };
    const agentOnly = { agentName: 'Sierra', place: null, messages: [{ author: 'agent' as const, text: 'The VIN is 1ABC.' }], previous };
    expect(fallbackSummary(agentOnly)).toMatchObject({ step: 'your_move', ask: 'Brand K or Pioneer?' });
    expect(fallbackSummary({ ...input('The VIN is 1ABC.'), previous })).toMatchObject({ step: 'fyi', ask: null });
  });
});

describe('artifacts', () => {
  it('extracts PRs, CI runs, previews and tailnet links as one flat list, PRs and CI first', () => {
    const artifacts = extractArtifacts(
      [
        [
          'PR: https://github.com/acme/widgets/pull/12. Preview at https://pr-12.preview.example.com/ (and https://pr-12.preview.example.com/ again).',
          'CI: https://github.com/acme/widgets/actions/runs/77',
          'Screenshots: https://your-host.example.ts.net/artifacts/pr-12/before.png and https://your-host.example.ts.net/artifacts/pr-12/after.png',
          'Prototype: https://your-host.example.ts.net/artifacts/pr-12/empty-state.html and the dev server https://your-host.example.ts.net:3101/',
          'Unrelated: https://example.com/page',
        ].join('\n'),
      ],
      { pullRequest: { url: 'https://github.com/acme/widgets/pull/12', number: 12 } },
    );
    expect(artifacts.map((artifact) => [artifact.kind, artifact.label])).toEqual([
      ['pr', 'PR #12'],
      ['ci', 'CI run 77'],
      ['preview', 'pr-12.preview.example.com'],
      ['file', 'before.png'],
      ['file', 'after.png'],
      ['prototype', 'empty-state'],
      ['prototype', ':3101'],
    ]);
  });

  it("labels links with the agent's own names and keeps only the newest turn's links", () => {
    const older = [
      'The mockup is up.',
      '1. [Play-style onboarding mockup](https://your-host.example.ts.net/artifacts/playstyle/index.html)',
      '2. Mockup screenshots: [A question](https://your-host.example.ts.net/artifacts/playstyle/a-question.png) · [A result](https://your-host.example.ts.net/artifacts/playstyle/a-result.png)',
    ].join('\n');
    const newer = [
      'Filed it.',
      '**Live links**',
      '1. [Walkthrough deck (team link)](https://cdn.example.com/explorations/deck/index.html)',
      '2. [ACM-318: Orchard worlds like this](https://linear.app/acme/issue/ACM-318/concept)',
      '3. [Play-style onboarding prototype (tailnet only)](https://your-host.example.ts.net/artifacts/playstyle/index.html)',
      '4. Question screens: [A](https://your-host.example.ts.net/artifacts/playstyle/glance-A.png) · [B](https://your-host.example.ts.net/artifacts/playstyle/glance-B.png)',
      '5. [Agent Desk: the "playstyle" slot](https://your-host.example.ts.net/tango-screen/)',
      '6. [Research page on your tailnet](https://your-host.example.ts.net/artifacts/newsletter/index.html)',
      '- PR #448 (stale updates after a reply): https://github.com/acme/widgets/pull/448',
      '- Decision packet — https://your-host.example.ts.net/artifacts/pr-12-decision/README.md',
    ].join('\n');
    const artifacts = extractArtifacts([older, newer, 'Thanks, nothing else to add.']);
    expect(artifacts.map((artifact) => [artifact.kind, artifact.label])).toEqual([
      ['pr', 'PR #448 (stale updates after a reply)'],
      ['doc', 'Walkthrough deck (team link)'],
      ['link', 'ACM-318: Orchard worlds like this'],
      ['prototype', 'Play-style onboarding prototype'],
      ['file', 'Question screens: A'],
      ['file', 'Question screens: B'],
      ['prototype', 'Research page'],
      ['file', 'Decision packet'],
    ]);
  });

  it('keeps a named URL whole when it holds parentheses', () => {
    const artifacts = extractArtifacts(['1. [Reference](https://example.com/wiki/Foo_(bar)) and [Shots](https://your-host.example.ts.net/artifacts/a_(1)/shot.png).']);
    expect(artifacts).toEqual([
      { kind: 'link', label: 'Reference', url: 'https://example.com/wiki/Foo_(bar)' },
      { kind: 'file', label: 'Shots', url: 'https://your-host.example.ts.net/artifacts/a_(1)/shot.png' },
    ]);
  });

  it('names an unnamed index page or README by its folder, and keeps the thread PR when the latest turn omits it', () => {
    const artifacts = extractArtifacts(['See https://your-host.example.ts.net/artifacts/acme-newsletter/index.html and https://your-host.example.ts.net/artifacts/runtime-notes/README.md'], {
      pullRequest: { url: 'https://github.com/acme/widgets/pull/9', number: 9 },
    });
    expect(artifacts.map((artifact) => artifact.label)).toEqual(['PR #9', 'acme newsletter', 'runtime notes']);
  });
});

describe('calendar helpers', () => {
  it('sweep time is the last sweep day at 07:00; quiet_until snoozes to the next such weekday', () => {
    const saturdayNoon = new Date(2026, 9, 10, 12, 0).getTime(); // Sat Oct 10 2026
    expect(new Date(latestSweepTime(saturdayNoon, 'saturday'))).toEqual(new Date(2026, 9, 10, 7, 0));
    expect(new Date(latestSweepTime(saturdayNoon, 'monday'))).toEqual(new Date(2026, 9, 5, 7, 0));
    expect(new Date(latestSweepTime(new Date(2026, 9, 10, 6, 0).getTime(), 'saturday'))).toEqual(new Date(2026, 9, 3, 7, 0));
    expect(new Date(nextWeekday(saturdayNoon, 'monday')!)).toEqual(new Date(2026, 9, 12, 7, 0));
  });
});

it('a summary waiting on the owner becomes their move instead of FYI', () => {
  for (const who of ['you', 'the owner', 'owner']) {
    expect(parseModelSummary(JSON.stringify({ gist: 'Sign-in blocked.', step: 'fyi', waitingOn: { who, what: 'sign in' } }), { kind: 'report', messages: [] } as never)).toMatchObject({ step: 'your_move', ask: 'sign in', waitingOn: null });
  }
});

it('a summary recognizes the privately configured owner name', () => {
  const previous = process.env.TANGO_OWNER_NAME;
  try {
    process.env.TANGO_OWNER_NAME = 'Avery';
    expect(parseModelSummary(JSON.stringify({ gist: 'Blocked.', step: 'watching', waitingOn: { who: 'Avery', what: 'sign in' } }), { agentName: 'Agent', messages: [] } as never)).toMatchObject({ step: 'your_move', ask: 'sign in', waitingOn: null });
  } finally {
    if (previous === undefined) delete process.env.TANGO_OWNER_NAME;
    else process.env.TANGO_OWNER_NAME = previous;
  }
});
