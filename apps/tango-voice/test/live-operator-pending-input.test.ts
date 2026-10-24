import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { DeskPendingQuestion, DeskPendingRequest } from '../src/live/desk-client.js';
import { buildAnswers, matchAnswer, matchDecision, mergeAnswers, missingScope, quickPick, speakPending } from '../src/live/desk-pending.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator, type LiveOperatorOptions } from '../src/live/live-operator.js';
import { buildExtractorPrompt, parseExtractorOutput, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen, LOUD } from './desk-fakes.js';

// A Loom thread waiting on the owner's answer (a multiple-choice question, several at once, or an
// approval), handled by voice: read out question by question, answered with spoken words matched
// to the labels, sent as one desk `respond` / `approve`. Content is synthetic.

const AGENTS: AgentDescriptor[] = [{ id: 'foxtrot', name: 'Foxtrot', role: 'finance' }];

const reviewer: DeskPendingQuestion = {
  id: 'Who should review the PR?',
  header: 'Reviewer',
  question: 'Who should review the PR?',
  multiSelect: false,
  options: [
    { label: 'Storage + prompt leads (Recommended)', description: 'Both sides of the change.' },
    { label: 'Storage lead only', description: 'Lighter.' },
    { label: 'Prompt lead only', description: 'Covers the prompt side.' },
    { label: 'Don’t request anyone', description: 'Leave it to the owner.' },
  ],
};
const merge: DeskPendingQuestion = {
  id: 'Should I merge once unblocked?',
  header: 'Merge',
  question: 'Should I merge once unblocked?',
  multiSelect: false,
  options: [
    { label: 'Merge when unblocked (Recommended)', description: '' },
    { label: 'Wait for a second review', description: '' },
  ],
};
const labels: DeskPendingQuestion = { id: 'labels', header: 'Labels', question: 'Which labels?', multiSelect: true, allowCustomAnswer: false, options: [{ label: 'bug', description: '' }, { label: 'ui', description: '' }] };

const asking = (questions: DeskPendingQuestion[], requestId = 'req-1'): DeskPendingRequest => ({ kind: 'question', requestId, questions, question: questions[0]!.question, options: questions[0]!.options.map((option) => option.label), at: Date.now() });
const approval = (): DeskPendingRequest => ({
  kind: 'approval',
  requestId: 'ap-1',
  questions: [],
  question: 'Run the migration script',
  options: ['Approve', 'Always allow this session', 'Decline'],
  approval: { detail: 'Run the migration script', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'acceptForSession', label: 'Always allow this session', warning: 'Later runs skip the prompt' }, { decision: 'decline', label: 'Decline' }] },
  at: Date.now(),
});
const loomItem = (id: string, pending: DeskPendingRequest, place = 'demo · Memory budget') =>
  deskItem(id, 'loom', { place, nextStep: 'your_move', ask: pending.question, options: pending.options, facts: { pending } });

describe('matching spoken answers to a question', () => {
  it('exact labels, ordinals, "the recommended one", unique partial matches; free text otherwise', () => {
    expect(matchAnswer(reviewer, 'storage lead only')).toEqual({ answer: 'Storage lead only', matched: true });
    expect(matchAnswer(reviewer, "let's go with the second one")).toEqual({ answer: 'Storage lead only', matched: true });
    expect(matchAnswer(reviewer, 'option three')).toEqual({ answer: 'Prompt lead only', matched: true });
    expect(matchAnswer(reviewer, 'the recommended one')).toEqual({ answer: 'Storage + prompt leads (Recommended)', matched: true });
    expect(matchAnswer(reviewer, 'prompt lead')).toEqual({ answer: 'Prompt lead only', matched: true });
    expect(matchAnswer(reviewer, 'dont request anyone')).toEqual({ answer: 'Don’t request anyone', matched: true });
    // Two labels fit: ask, never send the word as free text.
    expect(matchAnswer(reviewer, 'storage')).toEqual({ ambiguous: ['Storage + prompt leads (Recommended)', 'Storage lead only'] });
    expect(matchAnswer(reviewer, 'Someone from the platform team')).toEqual({ answer: 'Someone from the platform team', matched: false });
    expect(matchAnswer(labels, 'docs')).toBeNull(); // labels only
  });

  it('builds one answer per question; multi-select collects; missing and rejected are reported', () => {
    const pending = asking([reviewer, merge, labels]);
    const built = buildAnswers(pending, [
      { question: 'q1', answer: 'the second one' },
      { question: 'q3', answer: 'bug' },
      { question: 'Labels', answer: 'ui' },
    ]);
    expect(built.answers).toEqual({ [reviewer.id]: 'Storage lead only', labels: ['bug', 'ui'] });
    expect(built.missing.map((question) => question.header)).toEqual(['Merge']);
    expect(buildAnswers(pending, [{ question: 'q3', answer: 'docs' }]).rejected).toEqual([expect.objectContaining({ said: 'docs' })]);
    // A lone question needs no handle.
    expect(buildAnswers(asking([merge]), [{ question: '', answer: 'wait' }]).answers).toEqual({ [merge.id]: 'Wait for a second review' });
  });

  it('approval decisions only from what is offered', () => {
    expect(matchDecision(approval(), 'yes, run it')).toBe('accept');
    expect(matchDecision(approval(), 'allow it for this session')).toBe('acceptForSession');
    expect(matchDecision(approval(), 'no')).toBe('decline');
    expect(matchDecision(approval(), 'cancel it')).toBe('decline'); // cancel isn't offered: the closest no
    expect(matchDecision(approval(), '', 'acceptAlways')).toBeNull();
  });

  it('approval scope: never a broader decision than asked for; a scope not offered is a question', () => {
    const offering = (...decisions: string[]): DeskPendingRequest => ({
      ...approval(),
      approval: { detail: 'Run it', options: decisions.map((decision) => ({ decision, label: decision === 'acceptForSession' ? 'Always allow this session' : decision === 'acceptAlways' ? 'Always allow' : decision === 'accept' ? 'Approve' : 'Decline' })) },
    });
    const alwaysOnly = offering('accept', 'acceptAlways', 'decline');
    expect(matchDecision(alwaysOnly, 'allow it for this session')).toBeNull();
    expect(missingScope(alwaysOnly, 'allow it for this session')).toBe('session');
    expect(matchDecision(alwaysOnly, 'allow it for now')).toBeNull();
    expect(matchDecision(alwaysOnly, 'always allow it')).toBe('acceptAlways');
    expect(matchDecision(alwaysOnly, "yes and don't ask me again")).toBe('acceptAlways');
    expect(matchDecision(alwaysOnly, 'allow it')).toBe('accept');
    const both = offering('accept', 'acceptForSession', 'acceptAlways', 'decline');
    expect(matchDecision(both, 'always allow it')).toBe('acceptAlways');
    expect(matchDecision(both, 'allow it from now on')).toBe('acceptAlways');
    expect(matchDecision(both, 'permanently')).toBe('acceptAlways');
    expect(matchDecision(both, 'allow it for the rest of the session')).toBe('acceptForSession');
    expect(matchDecision(both, 'always allow it for this session')).toBe('acceptForSession');
    expect(matchDecision(both, 'Always allow this session')).toBe('acceptForSession'); // the label itself
    // "(Just) this once" means the same as "just this time" for the owner: session approval.
    expect(matchDecision(both, 'yes, just this once')).toBe('acceptForSession');
    expect(matchDecision(both, 'approve it this once')).toBe('acceptForSession');
    expect(matchDecision(both, 'only once')).toBe('acceptForSession');
    expect(matchDecision(alwaysOnly, 'just this once')).toBeNull();
    expect(missingScope(alwaysOnly, 'this once')).toBe('session');
    expect(matchDecision(offering('accept', 'decline'), 'only once')).toBeNull();
    // "(Just) this time" is session approval (owner decision); without a session option it is asked about.
    expect(matchDecision(both, 'allow it just this time')).toBe('acceptForSession');
    expect(matchDecision(both, 'yes this time')).toBe('acceptForSession');
    expect(matchDecision(alwaysOnly, 'just this time')).toBeNull();
    expect(missingScope(alwaysOnly, 'just this time')).toBe('session');
    expect(matchDecision(both, 'allow it every time')).toBe('acceptAlways');
    expect(matchDecision(both, 'approve')).toBe('accept');
    // The owner's words win over the model's decision; never broader than what they said.
    expect(matchDecision(both, 'allow it for this session', 'acceptAlways')).toBe('acceptForSession');
    expect(matchDecision(both, 'approve it', 'acceptAlways')).toBe('accept');
    expect(matchDecision(alwaysOnly, 'allow it for this session', 'acceptAlways')).toBeNull();
    expect(missingScope(alwaysOnly, 'allow it for this session', 'acceptAlways')).toBe('session');
    expect(matchDecision(both, 'hmm okay', 'acceptAlways')).toBe('acceptAlways'); // words say no scope: the model's stands
    const plain = offering('accept', 'decline');
    expect(matchDecision(plain, 'always allow it')).toBeNull();
    expect(missingScope(plain, 'always allow it')).toBe('permanent');
    expect(matchDecision(plain, 'no')).toBe('decline');
    expect(missingScope(plain, 'no')).toBeNull();
  });

  it('answers over several utterances: a multi-select collects (deduped), a single-select takes the latest', () => {
    const pending = asking([reviewer, labels]);
    expect(mergeAnswers(pending, { labels: ['bug'], [reviewer.id]: 'Storage lead only' }, { labels: ['ui', 'bug'], [reviewer.id]: 'Prompt lead only' })).toEqual({ labels: ['bug', 'ui'], [reviewer.id]: 'Prompt lead only' });
    expect(mergeAnswers(pending, {}, { labels: ['ui'] })).toEqual({ labels: ['ui'] });
  });

  it('a quick pick is a short ordinal or "recommended", for one single-select question only', () => {
    expect(quickPick('the first one', asking([reviewer]))).toBe('Storage + prompt leads (Recommended)');
    expect(quickPick('option 2', asking([reviewer]))).toBe('Storage lead only');
    expect(quickPick("let's go with the recommended one", asking([reviewer]))).toBe('Storage + prompt leads (Recommended)');
    expect(quickPick('the first one but tell it to hurry', asking([reviewer]))).toBeNull();
    expect(quickPick('the first one', asking([reviewer, merge]))).toBeNull();
    expect(quickPick('the first one', asking([labels]))).toBeNull();
  });

  it('reads each question with its options, the recommended one called out', () => {
    expect(speakPending('Loom (demo · Memory budget)', asking([reviewer, merge]))).toBe(
      'Loom (demo · Memory budget) is asking 2 questions. First: Who should review the PR? — options: Storage + prompt leads (recommended), Storage lead only, Prompt lead only, Don’t request anyone. And last: Should I merge once unblocked? — options: Merge when unblocked (recommended), Wait for a second review.',
    );
    expect(speakPending('Loom', approval())).toBe('Loom is asking for approval: Run the migration script — options: Approve, Always allow this session (Later runs skip the prompt), Decline.');
  });
});

describe('extractor: questions and approvals', () => {
  it('lists each question with a handle and its options, and the approval decisions', () => {
    const prompt = buildExtractorPrompt({
      agents: AGENTS,
      tasks: [],
      transcript: [],
      latestUserSpeech: 'storage lead only, and wait for a second review',
      desk: {
        items: [
          { handle: 'i1', agentName: 'Loom', place: 'demo · Memory budget', step: 'your move', line: 'x', threadId: null, questions: [{ handle: 'q1', header: 'Reviewer', question: 'Who reviews?', options: ['A (Recommended)', 'B'], multiSelect: false }, { handle: 'q2', header: 'Merge', question: 'Merge?', options: ['Yes', 'No'], multiSelect: true }] },
          { handle: 'i2', agentName: 'Loom', place: 'demo · Migration', step: 'your move', line: 'y', threadId: null, approval: { detail: 'Run the script', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'decline', label: 'Decline' }] } },
        ],
      },
    });
    expect(prompt).toContain('- i1: Loom · "demo · Memory budget" [your move]: waiting on the user\n    q1 [Reviewer]: Who reviews? (options: "A (Recommended)", "B")\n    q2 [Merge]: Merge? (options: "Yes", "No") (multi-select)');
    expect(prompt).toContain('    approval: Run the script (decisions: accept = "Approve", decline = "Decline")');
    expect(prompt).toContain('desk_op respond');
    expect(prompt).toContain('desk_op approve');
  });

  it('offers dismiss only for a question Loom lets be skipped: most need an answer', () => {
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'x', desk: { items: [] } });
    expect(prompt).not.toMatch(/dismiss/i);
    const item = { handle: 'i1', agentName: 'Loom', place: 'demo · Memory budget', step: 'your move', line: '', threadId: null };
    const skippable = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'x', desk: { items: [{ ...item, dismissible: true }] } });
    expect(skippable).toContain('desk_op dismiss');
    expect(skippable).toContain('- i1: Loom · "demo · Memory budget" [your move] [can skip]');
  });

  it('parses respond answers and approve decisions', () => {
    const fields = { agent_id: '', task_id: '', thread_id: '', new_thread_title: '', screen_op: '', message: '', option: '', until: '', trigger: '', stop_job: '', decision: '', answers: [], approval: '' };
    const raw = JSON.stringify({
      actions: [
        { ...fields, type: 'desk', desk_op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'B' }, { question: 'q2', answer: ' ' }] },
        { ...fields, type: 'desk', desk_op: 'approve', item: 'i2', approval: 'decline' },
        { ...fields, type: 'desk', desk_op: 'approve', item: 'i2', approval: 'bogus' },
      ],
    });
    expect(parseExtractorOutput(raw)).toEqual([
      { type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'B' }] },
      { type: 'desk', op: 'approve', item: 'i2', approval: 'decline' },
      { type: 'desk', op: 'approve', item: 'i2' },
    ]);
  });
});

interface Rig {
  client: FakeClient;
  operator: LiveOperator;
  desk: FakeDesk;
  screen: FakeDeskScreen;
  seen: ExtractorInput[];
  playback: LivePlaybackClock;
}

function setup(actions: OperatorAction[][], desk: FakeDesk, options: Partial<LiveOperatorOptions> = {}): Rig {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const screen = new FakeDeskScreen();
  const playback = new LivePlaybackClock();
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: new SimulatedAgentBackend({}),
    extractor,
    userActivity: new SpeechActivity(),
    playback,
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    ...options,
    desk,
    screen,
  });
  operator.start();
  return { client, operator, desk, screen, seen, playback };
}

const said = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');
const say = async (rig: Rig, id: string, words: string) => {
  rig.client.ask(id, words);
  await vi.advanceTimersByTimeAsync(3000);
};

describe('operator: answering Loom questions by voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('the extractor sees every question; spoken answers become one respond with the request id', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer, merge]))]);
    const rig = setup([[{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'prompt lead' }, { question: 'q2', answer: 'the recommended one' }] }]], desk);
    await say(rig, 'd1', 'the prompt lead, and merge when unblocked');
    expect(rig.seen[0]!.desk!.items[0]).toMatchObject({ questions: [expect.objectContaining({ handle: 'q1', header: 'Reviewer', options: reviewer.options.map((option) => option.label) }), expect.objectContaining({ handle: 'q2' })] });
    expect(rig.desk.sent('respond')).toEqual([
      expect.objectContaining({ itemId: 'loom:budget', args: { requestId: 'req-1', answers: { [reviewer.id]: 'Prompt lead only', [merge.id]: 'Merge when unblocked (Recommended)' } } }),
    ]);
    expect(said(rig.client)).toContain('Answered Loom (demo · Memory budget): Reviewer: Prompt lead only; Merge: Merge when unblocked (Recommended)');
  });

  it('asks for the questions still unanswered, keeps what was said, and sends once all are in', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer, merge]))]);
    const rig = setup(
      [
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'Someone from the platform team' }] }],
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q2', answer: 'wait for a second review' }] }],
      ],
      desk,
    );
    await say(rig, 'd1', 'someone from the platform team should review it');
    expect(rig.desk.sent('respond')).toEqual([]);
    expect(said(rig.client)).toContain('still needs an answer to: Should I merge once unblocked? (options: Merge when unblocked (Recommended), Wait for a second review). Got so far: Someone from the platform team.');
    await say(rig, 'd2', 'and wait for a second review');
    expect(rig.desk.sent('respond')).toEqual([expect.objectContaining({ args: { requestId: 'req-1', answers: { [reviewer.id]: 'Someone from the platform team', [merge.id]: 'Wait for a second review' } } })]);
  });

  it('an ambiguous answer is asked about, never sent as free text', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer]))]);
    const rig = setup([[{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'storage' }] }]], desk);
    await say(rig, 'd1', 'storage');
    expect(rig.desk.sent('respond')).toEqual([]);
    expect(said(rig.client)).toContain('"storage" could be "Storage + prompt leads (Recommended)" or "Storage lead only"');
  });

  it('"the recommended one" with one question in focus goes straight to the desk without the model', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer]))]);
    const rig = setup([], desk);
    rig.screen.presented = { view: 'conversation', itemId: 'loom:budget', conversationKey: 'loom:budget', sceneId: null };
    await say(rig, 'd1', 'the recommended one');
    expect(rig.seen).toHaveLength(0);
    expect(rig.desk.sent('respond')).toEqual([expect.objectContaining({ itemId: 'loom:budget', args: { requestId: 'req-1', answers: { [reviewer.id]: 'Storage + prompt leads (Recommended)' } } })]);
  });

  it('no shortcut with several questions, a staged scene on screen, or nothing in focus', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer, merge])), loomItem('loom:one', asking([merge], 'req-2'), 'demo · Other')]);
    const rig = setup([], desk);
    rig.screen.presented = { view: 'conversation', itemId: 'loom:budget', conversationKey: 'loom:budget', sceneId: null };
    await say(rig, 'd1', 'the first one');
    rig.screen.presented = { view: 'screen', itemId: 'loom:one', conversationKey: 'loom:one', sceneId: 's1' };
    await say(rig, 'd2', 'the first one');
    rig.screen.presented = { view: 'active', itemId: null, conversationKey: null, sceneId: null };
    await say(rig, 'd3', 'option two');
    expect(rig.seen).toHaveLength(3);
    expect(rig.desk.sent('respond')).toEqual([]);
  });

  it('approvals: the extractor\'s decision, or a short "decline it" on the approval in focus', async () => {
    const desk = new FakeDesk([loomItem('loom:migrate', approval(), 'demo · Migration')]);
    const rig = setup([[{ type: 'desk', op: 'approve', item: 'i1', approval: 'acceptForSession' }]], desk);
    await say(rig, 'd1', 'allow it for the rest of the session');
    rig.screen.presented = { view: 'conversation', itemId: 'loom:migrate', conversationKey: 'loom:migrate', sceneId: null };
    await say(rig, 'd2', 'decline it');
    expect(rig.seen).toHaveLength(1);
    expect(rig.desk.sent('approve').map((command) => command.args)).toEqual([
      { requestId: 'ap-1', decision: 'acceptForSession' },
      { requestId: 'ap-1', decision: 'decline' },
    ]);
    expect(said(rig.client)).toContain('Always allow this session: sent to Loom (demo · Migration)');
  });

  it('a go-ahead asked for in the thread\'s own words (no Loom approval prompt) is answered with a reply', async () => {
    const desk = new FakeDesk([deskItem('loom:merge', 'loom', { place: 'demo · Delivery', nextStep: 'your_move', ask: 'Approve merging the three finished changes?' })]);
    const rig = setup([[{ type: 'desk', op: 'approve', item: 'i1', approval: 'accept' }]], desk);
    await say(rig, 'd1', 'tell it to approve merging the three finished changes');
    expect(rig.desk.sent('approve')).toEqual([]);
    expect(rig.desk.sent('reply')).toEqual([
      expect.objectContaining({ itemId: 'loom:merge', args: { text: 'You asked: "Approve merging the three finished changes?" Yes, approved. Go ahead.' } }),
    ]);
    expect(said(rig.client)).not.toContain("isn't waiting on an approval");
  });

  it('a reply approval never carries a standing scope the extractor picked', async () => {
    const desk = new FakeDesk([deskItem('loom:merge', 'loom', { place: 'demo · Delivery', nextStep: 'your_move', ask: 'Merge it?' })]);
    const rig = setup([[{ type: 'desk', op: 'approve', item: 'i1', approval: 'acceptAlways' }], [{ type: 'desk', op: 'approve', item: 'i1', approval: 'decline' }]], desk);
    await say(rig, 'd1', 'approve it for this session');
    await say(rig, 'd2', 'no, decline it');
    expect(rig.desk.sent('reply').map((command) => command.args)).toEqual([
      { text: 'You asked: "Merge it?" Yes, approved. Go ahead.' },
      { text: 'You asked: "Merge it?" No, declined. Don\'t do it.' },
    ]);
  });

  it('a session approval Loom does not offer here is asked about, never sent as a broader one', async () => {
    const pending: DeskPendingRequest = { ...approval(), approval: { detail: 'Run the migration script', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'acceptAlways', label: 'Always allow' }, { decision: 'decline', label: 'Decline' }] } };
    const desk = new FakeDesk([loomItem('loom:migrate', pending, 'demo · Migration')]);
    const rig = setup([[{ type: 'desk', op: 'approve', item: 'i1', approval: 'acceptForSession' }]], desk);
    await say(rig, 'd1', 'allow it for this session');
    rig.screen.presented = { view: 'conversation', itemId: 'loom:migrate', conversationKey: 'loom:migrate', sceneId: null };
    await say(rig, 'd2', 'allow it for this session');
    expect(rig.desk.sent('approve')).toEqual([]);
    expect(said(rig.client)).toContain("The user asked to allow it for this session, but Loom doesn't offer that here. Ask the user which: Approve, Always allow, Decline. Nothing was sent.");
  });

  it('a multi-select answered over two utterances sends both picks', async () => {
    const desk = new FakeDesk([loomItem('loom:labels', asking([labels, merge]))]);
    const rig = setup(
      [
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'bug' }] }],
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'ui' }, { question: 'q1', answer: 'bug' }, { question: 'q2', answer: 'wait for a second review' }] }],
      ],
      desk,
    );
    await say(rig, 'd1', 'label it bug');
    await say(rig, 'd2', 'and ui too, and wait for a second review');
    expect(rig.desk.sent('respond')).toEqual([expect.objectContaining({ args: { requestId: 'req-1', answers: { labels: ['bug', 'ui'], [merge.id]: 'Wait for a second review' } } })]);
  });

  it('staged answers survive a failed send and go out with the next answer', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer, merge]))]);
    let fail = true;
    desk.respond = () => (fail ? { status: 'failed', error: 'answer not delivered: Loom is offline' } : { status: 'applied' });
    const rig = setup(
      [
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'Storage lead only' }, { question: 'q2', answer: 'wait for a second review' }] }],
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q2', answer: 'merge when unblocked' }] }],
      ],
      desk,
    );
    await say(rig, 'd1', 'storage lead only and wait for a second review');
    expect(said(rig.client)).toContain("That answer didn't go through for Loom (demo · Memory budget) (answer not delivered: Loom is offline)");
    expect(said(rig.client)).toContain('Their answers (Reviewer: Storage lead only; Merge: Wait for a second review) are kept');
    fail = false;
    await say(rig, 'd2', 'actually merge when unblocked');
    expect(rig.desk.sent('respond').map((command) => command.args.answers)).toEqual([
      { [reviewer.id]: 'Storage lead only', [merge.id]: 'Wait for a second review' },
      { [reviewer.id]: 'Storage lead only', [merge.id]: 'Merge when unblocked (Recommended)' },
    ]);
  });

  it("the model's approval scope is checked against the owner's words", async () => {
    const both: DeskPendingRequest = { ...approval(), approval: { detail: 'Run it', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'acceptForSession', label: 'Allow for this session' }, { decision: 'acceptAlways', label: 'Always allow' }] } };
    const alwaysOnly: DeskPendingRequest = { ...approval(), approval: { detail: 'Run it', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'acceptAlways', label: 'Always allow' }] } };
    const desk = new FakeDesk([loomItem('loom:both', both, 'demo · Both'), loomItem('loom:always', alwaysOnly, 'demo · Always')]);
    const rig = setup(
      [
        [{ type: 'desk', op: 'approve', item: 'i1', approval: 'acceptAlways' }],
        [{ type: 'desk', op: 'approve', item: 'i2', approval: 'acceptAlways' }],
      ],
      desk,
    );
    await say(rig, 'd1', 'allow the both one for this session');
    await say(rig, 'd2', 'allow the always one for this session');
    expect(rig.desk.sent('approve').map((command) => [command.itemId, command.args.decision])).toEqual([['loom:both', 'acceptForSession']]);
    expect(said(rig.client)).toContain("The user asked to allow it for this session, but Loom doesn't offer that here. Ask the user which: Approve, Always allow. Nothing was sent.");
  });

  it('staged answers are kept per request: interleaved answers to two requests do not clobber each other', async () => {
    const desk = new FakeDesk([loomItem('loom:one', asking([reviewer, merge], 'req-a'), 'demo · One'), loomItem('loom:two', asking([reviewer, merge], 'req-b'), 'demo · Two')]);
    const rig = setup(
      [
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'Storage lead only' }] }],
        [{ type: 'desk', op: 'respond', item: 'i2', answers: [{ question: 'q1', answer: 'Prompt lead only' }] }],
        [{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q2', answer: 'wait for a second review' }] }],
        [{ type: 'desk', op: 'respond', item: 'i2', answers: [{ question: 'q2', answer: 'merge when unblocked' }] }],
      ],
      desk,
    );
    for (const [id, words] of [['d1', 'one: storage lead'], ['d2', 'two: prompt lead'], ['d3', 'one: wait'], ['d4', 'two: merge']]) await say(rig, id!, words!);
    expect(rig.desk.sent('respond').map((command) => [command.itemId, command.args.answers])).toEqual([
      ['loom:one', { [reviewer.id]: 'Storage lead only', [merge.id]: 'Wait for a second review' }],
      ['loom:two', { [reviewer.id]: 'Prompt lead only', [merge.id]: 'Merge when unblocked (Recommended)' }],
    ]);
  });

  it('a request that changed is reported as not sent', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer]))]);
    desk.respond = () => ({ status: 'failed', error: 'the question changed: Loom is no longer waiting on that question' });
    const rig = setup([[{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'Storage lead only' }] }]], desk);
    await say(rig, 'd1', 'storage lead only');
    expect(said(rig.client)).toContain('changed before the answer got there, so nothing was sent');
  });

  it('a plain reply or an option answer on a Loom item with one question answers that question', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([merge]))]);
    const rig = setup([[{ type: 'desk', op: 'reply', item: 'i1', message: 'wait for a second review' }], [{ type: 'desk', op: 'answer', item: 'i1', option: 'Merge when unblocked (Recommended)' }]], desk);
    await say(rig, 'd1', 'tell it to wait for a second review');
    await say(rig, 'd2', 'actually merge when unblocked');
    expect(rig.desk.sent('reply')).toEqual([]);
    expect(rig.desk.sent('answer')).toEqual([]);
    expect(rig.desk.sent('respond').map((command) => command.args.answers)).toEqual([{ [merge.id]: 'Wait for a second review' }, { [merge.id]: 'Merge when unblocked (Recommended)' }]);
  });

  it('reading the item reads every question with its options', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer, merge]))]);
    const rig = setup([[{ type: 'desk', op: 'read', item: 'i1' }]], desk);
    await say(rig, 'd1', "what's the Loom one");
    expect(said(rig.client)).toContain('Read each question with its options, in order, then stop: Loom (demo · Memory budget) is asking 2 questions. First: Who should review the PR? — options: Storage + prompt leads (recommended)');
    expect(said(rig.client)).toContain('And last: Should I merge once unblocked?');
  });

  it('the catch-up reads a pending request question by question', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer, merge]))]);
    desk.briefingValue = { text: 'x', yourMove: [{ id: 'loom:budget', agentName: 'Loom', place: 'demo · Memory budget', step: 'your_move', ask: 'Who should review the PR? (+1 more)', options: [], context: [], gist: null, pending: asking([reviewer, merge]) }], fyi: [] };
    const rig = setup([], desk);
    await say(rig, 'd1', 'catch me up');
    expect(said(rig.client)).toContain('Catch-up, 1 of 1: Loom (demo · Memory budget) is asking 2 questions. First: Who should review the PR? — options:');
  });

  it('after an answer, a new question Loom asks without a message is relayed', async () => {
    const desk = new FakeDesk([loomItem('loom:budget', asking([reviewer]))]);
    const rig = setup([[{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'storage lead only' }] }]], desk);
    await say(rig, 'd1', 'storage lead only');
    desk.update('loom:budget', { nextStep: 'working', facts: { pending: null } });
    await vi.advanceTimersByTimeAsync(2000);
    desk.update('loom:budget', { nextStep: 'your_move', facts: { pending: { ...asking([merge], 'req-2'), at: Date.now() } } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(said(rig.client)).toContain('Loom is asking: Should I merge once unblocked? — options: Merge when unblocked (recommended), Wait for a second review.');
    for (let i = 0; i < 5; i++) rig.playback.enqueue(LOUD);
    await vi.advanceTimersByTimeAsync(7000);
  });
});
