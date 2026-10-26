import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpDeskClient } from '../src/live/desk-client.js';
import type { ThreadDirectory } from '../src/live/discord-threads.js';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import {
  DRAFT_OFF_INSTRUCTIONS,
  DRAFT_ON_INSTRUCTIONS,
  DRAFT_STILL_INSTRUCTIONS,
  DraftSession,
  addressedToOperator,
  buildDraftCompilePrompt,
  buildDraftEndPrompt,
  choosePick,
  isDraftCancel,
  isUndo,
  undoPrefix,
  matchDeskItem,
  matchTopicPick,
  pickLabels,
  isPlainYes,
  looksUnfinished,
  opensLong,
  contentBeforeFinish,
  matchDraftFinish,
  matchDraftStart,
  matchDraftTarget,
  parseDraftCompileOutput,
  trimOverlap,
  type DraftCompileInput,
  type DraftCompileResult,
  type DraftItemRef,
} from '../src/live/draft-mode.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { buildOperatorInstructions, LiveOperator, type LiveOperatorOptions } from '../src/live/live-operator.js';
import { buildExtractorPrompt, buildScreenPickPrompt, parseExtractorOutput, parseScreenPick, type ExtractorInput, type OperatorAction, type ScreenPicker, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen, scene } from './desk-fakes.js';
import { DestinationAsk, destinationQuestion, matchDestinationAnswer } from '../src/live/destination-ask.js';

// Draft mode (draft-mode.ts): the owner thinks out loud with long pauses; nothing is sent until
// the compiled message and its destination are confirmed. Plus the "Is that everything?" safety net.
// Synthetic ids only (runs of zeros).

const AGENTS: AgentDescriptor[] = [
  { id: 'sierra', name: 'Sierra', role: 'research and trips' },
  { id: 'victor', name: 'Victor', role: 'engineering' },
  { id: 'malibu', name: 'Malibu', role: 'nutrition' },
];
const THREAD = '1550000000000000003';

function desk() {
  return new FakeDesk([
    deskItem('discord:chapter:vic', 'victor', { nextStep: 'fyi' }),
    deskItem(`discord:thread:${THREAD}`, 'sierra', { threadId: THREAD, place: 'Shed vents', nextStep: 'watching' }),
  ]);
}

interface Rig {
  client: FakeClient;
  operator: LiveOperator;
  desk: FakeDesk;
  screen: FakeDeskScreen;
  backend: SimulatedAgentBackend;
  routed: ExtractorInput[];
  compiles: DraftCompileInput[];
  draft: DraftSession;
}

type CompileFn = (input: DraftCompileInput) => DraftCompileResult | Promise<DraftCompileResult>;

const compiled = (message: string, extra: Partial<DraftCompileResult> = {}): DraftCompileResult => ({
  message,
  agentId: 'sierra',
  item: null,
  threadId: null,
  newThreadTitle: null,
  questions: [],
  ...extra,
});

function setup(
  options: {
    actions?: OperatorAction[][];
    compile?: CompileFn;
    draft?: DraftSession;
    desk?: FakeDesk;
    screen?: FakeDeskScreen;
    client?: FakeClient;
    backend?: SimulatedAgentBackend;
    extra?: Partial<LiveOperatorOptions>;
  } = {},
): Rig {
  const client = options.client ?? new FakeClient();
  const routed: ExtractorInput[] = [];
  const compiles: DraftCompileInput[] = [];
  const actions = options.actions ?? [];
  const extractor: TaskExtractor = async (input) => {
    routed.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const compile = options.compile ?? ((input: DraftCompileInput) => compiled(input.fragments.join(' '), { agentId: input.target?.agentId ?? 'sierra' }));
  const draft =
    options.draft ??
    new DraftSession({
      compile: async (input) => {
        compiles.push(input);
        return compile(input);
      },
    });
  const backend = options.backend ?? new SimulatedAgentBackend({});
  const deskClient = options.desk ?? desk();
  const screen = options.screen ?? new FakeDeskScreen();
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    desk: deskClient,
    screen,
    draft,
    ...options.extra,
  });
  operator.start();
  return { client, operator, desk: deskClient, screen, backend, routed, compiles, draft };
}

/** A desk whose agent-thread starts wait on `gate` (and then fail, with `fails`). */
function slowAgentThreads(gate: Promise<void>, fails = false): FakeDesk {
  const slow = desk();
  slow.agentThreadResult = async (request) => {
    await gate;
    return fails ? { ok: false, error: 'Discord is down' } : { ok: true, threadId: '1550000000000000005', itemId: 'discord:thread:1550000000000000005', title: request.title ?? '' };
  };
  return slow;
}

/** The owner says something and GPT-Live delegates. */
async function say(rig: Rig, id: string, words: string) {
  rig.client.ask(id, words);
  await vi.advanceTimersByTimeAsync(600);
}

const commentary = (rig: Rig) => rig.client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content);
const instructions = (rig: Rig) => rig.client.appends.filter((append) => append.kind === 'instructions').map((append) => append.content);
const traced = (rig: Rig, kind: string) => rig.desk.traces.filter((entry) => entry.kind === kind);

describe('draft mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('starts on a phrase, with the target it names, and tells GPT-Live to only backchannel', async () => {
    const rig = setup();
    await say(rig, 'd1', "I've got a long message for Sierra.");
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'listening', target: { agentId: 'sierra', name: 'Sierra' }, fragments: [] });
    expect(instructions(rig)).toContain(DRAFT_ON_INSTRUCTIONS);
    expect(DRAFT_ON_INSTRUCTIONS).toMatch(/stay silent/);
    expect(DRAFT_ON_INSTRUCTIONS).toMatch(/never answer.*ask questions/);
    // Not answered on its own: live, "Go ahead, I'm listening." came before the refresher.
    expect(DRAFT_ON_INSTRUCTIONS).toMatch(/needs no reply: say nothing to it/);
    expect(rig.routed).toHaveLength(0); // no router call, nothing sent
    expect(rig.backend.sends).toHaveLength(0);
    expect(traced(rig, 'draft.start')).toHaveLength(1);
  });

  it('starts on the router\'s draft action', async () => {
    const rig = setup({ actions: [[{ type: 'draft', op: 'start', agentId: 'victor' }]] });
    await say(rig, 'd1', 'hold everything, I want to ramble for a bit before Victor gets anything');
    expect(rig.routed).toHaveLength(1);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target?.agentId).toBe('victor');
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('a draft start beats a send in the same breath', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Plan the trip.' }, { type: 'draft', op: 'start', agentId: 'sierra' }]] });
    await say(rig, 'd1', 'I want to talk to Sierra about the trip but let me get it all out first');
    expect(rig.draft.active).toBe(true);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('pauses append instead of sending: two delegations with a gap become one message; named target sends after the undo window, no question', async () => {
    const rig = setup();
    await say(rig, 'd1', 'let me think out loud for Sierra');
    await say(rig, 'd2', 'So for the coast trip, um, I think we leave Friday');
    await vi.advanceTimersByTimeAsync(40_000); // a long pause
    await say(rig, 'd3', 'and we should bring the small tent, not the big one');
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.desk.draft?.fragments).toEqual(['So for the coast trip, um, I think we leave Friday', 'and we should bring the small tent, not the big one']);

    await say(rig, 'd4', 'Okay, send it.');
    expect(rig.compiles).toHaveLength(1);
    expect(rig.compiles[0].fragments).toHaveLength(2);
    expect(rig.compiles[0].target).toMatchObject({ agentId: 'sierra' });
    // Where it goes was named: no "Send that to Sierra?", just the undo window.
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'sending', compiled: expect.stringContaining('small tent'), target: { label: 'Sierra · main channel', itemId: null } });
    expect(rig.desk.draft?.undoUntil).toBeGreaterThan(Date.now());
    expect(commentary(rig).some((text) => text.includes('Send that to'))).toBe(false);
    expect(rig.backend.sends).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request).toMatchObject({ agentId: 'sierra', message: expect.stringContaining('leave Friday') });
    expect(rig.desk.draft).toMatchObject({ active: false, status: 'sent' });
    expect(instructions(rig)).toContain(DRAFT_OFF_INSTRUCTIONS);
    // The normal send path ran; GPT-Live says only "Sent."
    expect(instructions(rig).some((text) => text.startsWith('[Routed to Sierra') && text.includes('Say only "Sent."'))).toBe(true);

    await say(rig, 'd6', 'yes');
    expect(rig.backend.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.desk.draft).toMatchObject({ active: false, fragments: [], status: 'listening' }); // cleared
    for (const kind of ['draft.start', 'draft.append', 'draft.compile', 'draft.ready', 'draft.send']) expect(traced(rig, kind).length).toBeGreaterThan(0);
  });

  it('an unnamed ordinary draft still asks "Send that to …?" and sends once on yes', async () => {
    const rig = setup();
    await say(rig, 'd1', 'start draft mode');
    await say(rig, 'd2', 'we leave Friday for the coast');
    await say(rig, 'd3', 'Okay, send it.');
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'confirm', target: { label: 'Sierra · main channel' } });
    expect(commentary(rig).at(-1)).toContain('Send that to Sierra?');
    expect(commentary(rig).at(-1)).toContain("Don't read the message out");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.backend.sends).toHaveLength(0);
    await say(rig, 'd4', 'yes');
    expect(rig.backend.sends).toHaveLength(1);
    expect(instructions(rig).some((text) => text.startsWith('[Routed to Sierra') && text.includes('"Sent to Sierra."'))).toBe(true);
    expect(traced(rig, 'draft.confirm')).toHaveLength(1);
  });

  it('collects speech even when GPT-Live does not delegate', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode');
    rig.client.user(' the deck needs a second coat before the rain');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.desk.draft?.fragments).toEqual(['the deck needs a second coat before the rain']);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('content said after the start phrase is the first fragment; overlapping words are not repeated', async () => {
    const rig = setup();
    await say(rig, 'd1', "I've got a message for Victor. The deploy script needs a dry run flag");
    expect(rig.desk.draft?.fragments).toEqual(['The deploy script needs a dry run flag']);
    await say(rig, 'd2', 'needs a dry run flag and a confirm prompt');
    expect(rig.desk.draft?.fragments).toEqual(['The deploy script needs a dry run flag', 'and a confirm prompt']);
  });

  it('after 90 s of silence asks once whether to keep holding or send', async () => {
    const rig = setup();
    await say(rig, 'd1', 'let me talk this through');
    await say(rig, 'd2', 'the gutter quote seems high');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(commentary(rig).some((text) => text.includes('keep holding'))).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(commentary(rig).filter((text) => text.includes('Want me to keep holding this, or send it?'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(commentary(rig).filter((text) => text.includes('keep holding'))).toHaveLength(1);
    expect(traced(rig, 'draft.check')).toHaveLength(1);
    await say(rig, 'd3', 'keep holding');
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.fragments).toEqual(['the gutter quote seems high']);
  });

  it('meta commands still work while drafting; they are not part of the message', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'show the board');
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
    await say(rig, 'd3', "it's for Malibu");
    expect(rig.desk.draft?.target?.agentId).toBe('malibu');
    expect(rig.desk.draft?.fragments).toEqual([]);
    await say(rig, 'd4', 'cancel the draft');
    expect(rig.draft.active).toBe(false);
    expect(rig.desk.draft?.status).toBe('cancelled');
  });

  it('a finish the phrases miss goes to the router, which may only finish or cancel', async () => {
    const rig = setup({ actions: [[{ type: 'draft', op: 'finish' }, { type: 'dispatch', agentId: 'victor', message: 'x' }]] });
    await say(rig, 'd1', 'draft mode for Victor');
    await say(rig, 'd2', 'add retries to the uploader');
    await say(rig, 'd3', 'alright I think that is ready to fire off');
    expect(rig.routed.at(-1)?.draft).toMatchObject({ active: true });
    expect(buildExtractorPrompt(rig.routed.at(-1)!)).toContain('Draft mode is ON');
    expect(rig.desk.draft?.status).toBe('sending'); // the undo window: Victor was named
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('an edit re-compiles and re-confirms; yes sends the edited message', async () => {
    const rig = setup({
      compile: (input) => (input.instruction ? compiled(`${input.previous!.message} The gate code is 4512.`) : compiled(input.fragments.join(' '))),
    });
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'please book the cabin for the weekend');
    await say(rig, 'd3', "that's it");
    await say(rig, 'd4', 'also mention the gate code is 4512');
    expect(rig.compiles.at(-1)).toMatchObject({ instruction: 'also mention the gate code is 4512', previous: { message: 'please book the cabin for the weekend' } });
    expect(rig.desk.draft).toMatchObject({ status: 'confirm', compiled: 'please book the cabin for the weekend The gate code is 4512.' });
    expect(traced(rig, 'draft.edit')).toHaveLength(1);
    expect(rig.backend.sends).toHaveLength(0);
    await say(rig, 'd5', 'yep send it');
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.message).toContain('4512');
  });

  it('"scratch that" at the confirm step discards it; nothing is sent', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'cancel my dentist appointment');
    await say(rig, 'd3', 'go ahead');
    await say(rig, 'd4', 'scratch that');
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.draft.active).toBe(false);
    expect(rig.desk.draft).toMatchObject({ status: 'cancelled', active: false });
    expect(traced(rig, 'draft.cancel')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.desk.draft?.fragments).toEqual([]);
  });

  it('asks a clarifying question before sending, then confirms with the answer folded in', async () => {
    let call = 0;
    const rig = setup({
      compile: (input) => {
        call += 1;
        if (call === 1) return compiled('Move the review to Thursday.', { questions: ['Is that this Thursday or next?'] });
        expect(input.clarifications).toEqual([{ question: 'Is that this Thursday or next?', answer: 'next Thursday' }]);
        return compiled('Move the review to next Thursday.');
      },
    });
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'move the review to Thursday');
    await say(rig, 'd3', 'send it');
    expect(rig.desk.draft).toMatchObject({ status: 'confirm', question: 'Is that this Thursday or next?' });
    expect(commentary(rig).at(-1)).toContain('Is that this Thursday or next?');
    expect(rig.backend.sends).toHaveLength(0);
    await say(rig, 'd4', 'next Thursday');
    expect(rig.desk.draft).toMatchObject({ status: 'confirm', question: null, compiled: 'Move the review to next Thursday.' });
    await say(rig, 'd5', 'yes');
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('a Send tap on the card sends; a Cancel tap discards', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode for Malibu');
    await say(rig, 'd2', 'I had oatmeal and a banana');
    await say(rig, 'd3', 'done');
    rig.desk.draftHandler?.({ action: 'send', commandId: 'c1', draftId: rig.desk.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.agentId).toBe('malibu');

    await say(rig, 'd4', 'draft mode');
    await say(rig, 'd5', 'something else');
    rig.desk.draftHandler?.({ action: 'cancel', draftId: rig.desk.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.draft.active).toBe(false);
    expect(rig.backend.sends).toHaveLength(1);
  });

  describe('destination (part of the confirm)', () => {
    it('explicit target: the agent named in the phrase goes to the compiler and onto the card', async () => {
      const rig = setup({ compile: (input) => compiled(input.fragments.join(' '), { agentId: input.target?.agentId ?? null }) });
      await say(rig, 'd1', "I've got a message for Victor");
      await say(rig, 'd2', 'the nightly build is flaky again');
      await say(rig, 'd3', "that's all");
      expect(rig.compiles[0].target).toEqual({ agentId: 'victor', name: 'Victor' });
      expect(rig.desk.draft?.target).toMatchObject({ agentId: 'victor', label: 'Victor · main channel' });
      // Named, and the compile agrees: no question, the undo window instead.
      expect(rig.desk.draft?.status).toBe('sending');
      expect(commentary(rig).some((text) => text.includes('Send that to'))).toBe(false);
    });

    it('inferred target: an existing desk thread, said in the confirmation and used for the send', async () => {
      const rig = setup({
        compile: (input) => {
          const handle = input.desk!.items.find((item) => item.place === 'Shed vents')!.handle;
          return compiled('The left vent rattles at highway speed.', { agentId: 'sierra', item: handle });
        },
      });
      await say(rig, 'd1', 'start draft mode');
      await say(rig, 'd2', 'the left vent rattles at highway speed');
      await say(rig, 'd3', 'send it');
      expect(rig.desk.draft?.target).toMatchObject({ agentId: 'sierra', where: 'Shed vents', label: 'Sierra · Shed vents thread' });
      expect(commentary(rig).at(-1)).toContain('Send that to Sierra in the "Shed vents" thread?');
      expect(traced(rig, 'draft.confirm')[0].data?.destination).toMatchObject({ kind: 'thread', threadId: THREAD });
      await say(rig, 'd4', 'yes');
      expect(rig.backend.sends).toHaveLength(1);
      expect(rig.backend.sends[0].request).toMatchObject({ agentId: 'sierra', channelId: THREAD });
    });

    it('redirect by voice: re-resolves, re-confirms, traces the change, and sends to the new place', async () => {
      const rig = setup({
        compile: (input) => (input.instruction ? compiled(input.previous!.message, { agentId: 'victor', newThreadTitle: 'Desk filters follow-up' }) : compiled('Check the desk filters.', { agentId: 'sierra' })),
      });
      await say(rig, 'd1', 'draft mode');
      await say(rig, 'd2', 'check the desk filters');
      await say(rig, 'd3', 'okay done');
      expect(rig.desk.draft?.target?.agentId).toBe('sierra');
      await say(rig, 'd4', 'no, to Victor, in a new thread');
      expect(rig.compiles.at(-1)?.instruction).toBe('no, to Victor, in a new thread');
      expect(rig.compiles.at(-1)?.previous?.destination).toBe('Sierra');
      expect(rig.desk.draft?.target).toMatchObject({ agentId: 'victor', label: 'Victor · new thread “Desk filters follow-up”' });
      expect(commentary(rig).at(-1)).toContain('Send that to Victor in a new thread, "Desk filters follow-up"?');
      expect(traced(rig, 'draft.redirect')).toHaveLength(1);
      expect(rig.backend.sends).toHaveLength(0);
      await say(rig, 'd5', 'yes');
      // A new thread starts through the desk, which posts the words and wakes the agent: nothing goes straight to Discord.
      expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'victor', prompt: 'Check the desk filters.', title: 'Desk filters follow-up' })]);
      expect(rig.backend.sends).toHaveLength(0);
    });

    it('ambiguous destination: asks instead of guessing', async () => {
      const rig = setup({ compile: () => compiled('Look into the noise.', { agentId: null }) });
      await say(rig, 'd1', 'draft mode');
      await say(rig, 'd2', 'look into the noise');
      await say(rig, 'd3', 'send it');
      expect(rig.desk.draft).toMatchObject({ status: 'confirm', question: 'Who should this go to?' });
      expect(commentary(rig).at(-1)).toContain('Who should this go to?');
      expect(rig.backend.sends).toHaveLength(0);
    });

    it('several plausible threads: the compiler\'s question is asked', async () => {
      const rig = setup({ compile: () => compiled('The vent is fixed.', { questions: ["Sierra's shed vents thread, or a new one?"] }) });
      await say(rig, 'd1', 'draft mode for Sierra');
      await say(rig, 'd2', 'the vent is fixed');
      await say(rig, 'd3', 'send it');
      expect(commentary(rig).at(-1)).toContain("Sierra's shed vents thread, or a new one?");
      expect(rig.backend.sends).toHaveLength(0);
    });
  });

  it('survives a GPT-Live reconnect: the next operator carries the draft and re-arms GPT-Live', async () => {
    const draft = new DraftSession({ compile: async (input) => compiled(input.fragments.join(' ')) });
    const deskClient = desk();
    const backend = new SimulatedAgentBackend({});
    const first = setup({ draft, desk: deskClient, backend });
    await say(first, 'd1', 'draft mode for Sierra');
    await say(first, 'd2', 'the ferry leaves at seven');
    first.operator.stop();

    const second = setup({ draft, desk: deskClient, backend });
    expect(draft.active).toBe(true);
    expect(instructions(second)).toContain(DRAFT_ON_INSTRUCTIONS);
    expect(deskClient.traces.some((entry) => entry.kind === 'draft.resume')).toBe(true);
    await say(second, 'e1', 'so we need to be there by six thirty');
    await say(second, 'e2', 'send it');
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.sends).toHaveLength(1);
    expect(backend.sends[0].request.message).toBe('the ferry leaves at seven so we need to be there by six thirty');
    expect(first.client.appends.filter((append) => append.content.includes('Send that'))).toHaveLength(0);
  });

  it('session end with an unsent draft: kept on the card with a note, traced, then cleared', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode for Sierra');
    await say(rig, 'd2', 'remember the spare key');
    rig.draft.end();
    expect(rig.desk.draft).toMatchObject({ active: false, status: 'cancelled', note: 'Not sent: the voice session ended', fragments: ['remember the spare key'] });
    expect(traced(rig, 'draft.unsent')).toHaveLength(1);
    expect(commentary(rig).at(-1)).toContain('unsent draft');
    expect(rig.backend.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect(rig.desk.draft?.fragments).toEqual([]);
  });

  it('a rejected delivery keeps the draft, back at confirm with a note; a retry can send it (PR review)', async () => {
    let fail = true;
    const deskClient = desk();
    deskClient.agentThreadResult = (request) => (fail ? { ok: false, error: 'Discord is down' } : { ok: true, threadId: '1550000000000000009', itemId: 'discord:thread:1550000000000000009', title: request.title ?? '' });
    const rig = setup({ desk: deskClient, compile: (input) => compiled(input.fragments.join(' '), { agentId: 'victor', newThreadTitle: 'Uploader retries' }) });
    await say(rig, 'd1', 'draft mode for Victor');
    await say(rig, 'd2', 'add retries to the uploader');
    await say(rig, 'd3', 'send it');
    await say(rig, 'd4', 'yes');
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.drafts.some((card) => card.status === 'sent')).toBe(false);
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'confirm', compiled: 'add retries to the uploader', note: expect.stringContaining('Discord is down') });
    expect(traced(rig, 'draft.send.failed')).toHaveLength(1);
    expect(instructions(rig).at(-1)).toContain('NOT sent');
    expect(instructions(rig)).not.toContain(DRAFT_OFF_INSTRUCTIONS);
    fail = false;
    await say(rig, 'd5', 'yes');
    // One command id per draft: the retry can't start a second thread.
    expect(rig.desk.agentThreads.map((request) => request.commandId)).toEqual([rig.desk.agentThreads[0]!.commandId, rig.desk.agentThreads[0]!.commandId]);
    expect(rig.desk.draft).toMatchObject({ active: false, status: 'sent' });
  });

  it('a desk reply that fails keeps the draft too (PR review)', async () => {
    const deskClient = new FakeDesk([deskItem('loom:th-1', 'loom', { place: 'tango · Dashboard', nextStep: 'your_move' })]);
    deskClient.respond = () => ({ status: 'failed', error: 'Loom is not running' });
    const rig = setup({ desk: deskClient, compile: (input) => compiled('Ship the dashboard fix.', { agentId: null, item: input.desk!.items[0].handle }) });
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'ship the dashboard fix');
    await say(rig, 'd3', 'send it');
    expect(rig.desk.draft?.target).toMatchObject({ label: 'Loom · tango · Dashboard' });
    await say(rig, 'd4', 'yes');
    expect(deskClient.sent('reply')).toHaveLength(1);
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'confirm', note: 'Not sent: Loom is not running' });
  });

  it('a draft for a Loom thread waiting on a question answers it; a refused answer keeps the draft (merge with #388)', async () => {
    for (const refuse of [false, true]) {
      const question = { id: 'Which database?', header: 'DB', question: 'Which database?', multiSelect: false, options: [{ label: 'Staging', description: '' }, { label: 'Production', description: '' }] };
      const deskClient = new FakeDesk([
        deskItem('loom:db', 'loom', { place: 'tango · Migrations', nextStep: 'your_move', facts: { pending: { kind: 'question', requestId: 'req-9', questions: [question], question: question.question, options: ['Staging', 'Production'], at: Date.now() } } as never }),
      ]);
      if (refuse) deskClient.respond = (command) => (command.type === 'respond' ? { status: 'failed', error: 'Loom is busy' } : { status: 'applied' });
      const rig = setup({ desk: deskClient, compile: (input) => compiled('Staging', { agentId: null, item: input.desk!.items[0].handle }) });
      await say(rig, 'd1', 'draft mode');
      await say(rig, 'd2', 'use staging for now');
      await say(rig, 'd3', 'send it');
      await say(rig, 'd4', 'yes');
      expect(deskClient.sent('respond')).toEqual([expect.objectContaining({ itemId: 'loom:db', args: { requestId: 'req-9', answers: { 'Which database?': 'Staging' } } })]);
      expect(deskClient.sent('reply')).toHaveLength(0);
      if (refuse) expect(rig.desk.draft).toMatchObject({ active: true, status: 'confirm', note: expect.stringContaining('Not sent') });
      else expect(rig.desk.draft).toMatchObject({ active: false, status: 'sent' });
      rig.operator.stop();
    }
  });

  it('a draft answering a Loom approval uses the approve outcome: accepted is sent, refused keeps the draft (desk outcome)', async () => {
    const pending = {
      kind: 'approval',
      requestId: 'ap-7',
      questions: [],
      question: 'Run the migration script',
      options: ['Approve', 'Always allow this session', 'Decline'],
      approval: { detail: 'Run the migration script', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'acceptForSession', label: 'Always allow this session' }, { decision: 'decline', label: 'Decline' }] },
      at: Date.now(),
    };
    for (const refuse of [false, true]) {
      const deskClient = new FakeDesk([deskItem('loom:mig', 'loom', { place: 'tango · Migrations', nextStep: 'your_move', facts: { pending } as never })]);
      if (refuse) deskClient.respond = (command) => (command.type === 'approve' ? { status: 'failed', error: 'approval expired' } : { status: 'applied' });
      const rig = setup({ desk: deskClient, compile: (input) => compiled('Allow it for this session.', { agentId: null, item: input.desk!.items[0].handle }) });
      await say(rig, 'd1', 'draft mode');
      await say(rig, 'd2', 'allow it for this session');
      await say(rig, 'd3', 'send it');
      await say(rig, 'd4', 'yes');
      expect(deskClient.sent('approve')).toEqual([expect.objectContaining({ args: { requestId: 'ap-7', decision: 'acceptForSession' } })]);
      if (refuse) expect(rig.desk.draft).toMatchObject({ active: true, status: 'confirm', note: 'Not sent: approval expired' });
      else expect(rig.desk.draft).toMatchObject({ active: false, status: 'sent' });
      rig.operator.stop();
    }
  });

  it('an answer the question does not accept is not sent, and the draft says why (desk outcome)', async () => {
    const question = { id: 'Which labels?', header: 'Labels', question: 'Which labels?', multiSelect: false, allowCustomAnswer: false, options: [{ label: 'bug', description: '' }, { label: 'ui', description: '' }] };
    const deskClient = new FakeDesk([
      deskItem('loom:lab', 'loom', { place: 'tango · Labels', nextStep: 'your_move', facts: { pending: { kind: 'question', requestId: 'req-3', questions: [question], question: question.question, options: ['bug', 'ui'], at: Date.now() } } as never }),
    ]);
    const rig = setup({ desk: deskClient, compile: (input) => compiled('Purple, I think.', { agentId: null, item: input.desk!.items[0].handle }) });
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'purple I think');
    await say(rig, 'd3', 'send it');
    await say(rig, 'd4', 'yes');
    expect(deskClient.sent('respond')).toHaveLength(0);
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'confirm', note: 'Not sent: the answer did not match the options' });
  });

  it('dictation that contains cancel words never discards the draft (PR review 4)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'we can cancel the draft review on Friday');
    await say(rig, 'd3', 'and never mind the cost, just book it');
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.fragments).toEqual(['we can cancel the draft review on Friday', 'and never mind the cost, just book it']);
    await say(rig, 'd4', 'send it');
    await say(rig, 'd5', 'scratch that and make it Saturday');
    expect(rig.draft.active).toBe(true); // an edit, not a cancel
    expect(rig.compiles.at(-1)?.instruction).toBe('scratch that and make it Saturday');
  });

  it('a screen tap on a draft card that is no longer current is ignored (PR review 4)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode for Malibu');
    await say(rig, 'd2', 'I had oatmeal');
    await say(rig, 'd3', 'done');
    rig.desk.draftHandler?.({ action: 'send', draftId: 'an-older-draft' });
    rig.desk.draftHandler?.({ action: 'cancel' });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.draft.active).toBe(true);
    expect(traced(rig, 'draft.screen.stale')).toHaveLength(2);
    rig.desk.draftHandler?.({ action: 'send', draftId: rig.desk.draft!.id! });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('"yes to Victor" is a redirect, not a send (PR review)', async () => {
    const rig = setup({ compile: (input) => (input.instruction ? compiled(input.previous!.message, { agentId: 'victor' }) : compiled('Check the logs.', { agentId: 'sierra' })) });
    await say(rig, 'd1', 'draft mode');
    await say(rig, 'd2', 'check the logs');
    await say(rig, 'd3', 'send it');
    await say(rig, 'd4', 'yes to Victor');
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.compiles.at(-1)?.instruction).toBe('yes to Victor');
    expect(rig.desk.draft?.target?.agentId).toBe('victor');
    await say(rig, 'd5', 'yes');
    expect(rig.backend.sends[0].request.agentId).toBe('victor');
  });

  it('text in the trigger sentence becomes the first fragment (PR review)', async () => {
    const rig = setup();
    await say(rig, 'd1', "I've got a long message for Sierra: the patio needs another coat");
    expect(rig.desk.draft).toMatchObject({ target: { agentId: 'sierra' }, fragments: ['the patio needs another coat'] });
  });

  it('a router-detected start keeps what was said for the message (PR review 2)', async () => {
    const rig = setup({ actions: [[{ type: 'draft', op: 'start', agentId: 'victor', message: 'the deploy is blocked on the migration' }]] });
    await say(rig, 'd1', 'hold everything, I want Victor to hear this properly, the deploy is blocked on the migration');
    expect(rig.desk.draft).toMatchObject({ active: true, target: { agentId: 'victor' }, fragments: ['the deploy is blocked on the migration'] });
  });

  it('a router-detected start without a message falls back to what follows the intent (PR review 2)', async () => {
    const rig = setup({ actions: [[{ type: 'draft', op: 'start' }]] });
    await say(rig, 'd1', "hold everything, I'm going to ramble for a minute — the deploy is blocked on review");
    expect(rig.desk.draft?.fragments).toEqual(['the deploy is blocked on review']);
  });

  it('speech during a slow screen-initiated send is held, then handled through the normal path (PR review 2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rig = setup({
      desk: slowAgentThreads(gate),
      actions: [[{ type: 'dispatch', agentId: 'malibu', message: 'The user had eggs.' }]],
      compile: (input) => compiled(input.fragments.join(' '), { agentId: 'victor', newThreadTitle: 'Retries' }),
    });
    await say(rig, 'd1', 'draft mode for Victor');
    await say(rig, 'd2', 'add retries');
    await say(rig, 'd3', 'send it');
    rig.desk.draftHandler?.({ action: 'send', draftId: rig.desk.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.desk.draft?.status).toBe('sending');
    await say(rig, 'd4', 'tell Malibu I had eggs');
    expect(rig.routed).toHaveLength(0); // held, not routed or added to the draft being sent
    expect(traced(rig, 'draft.queued')).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(1500);
    expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'victor', prompt: 'add retries' })]);
    expect(rig.backend.sends.map((send) => send.request.agentId)).toEqual(['malibu']);
    expect(rig.routed.at(-1)?.latestUserSpeech).toBe('tell Malibu I had eggs');
  });

  it('a compile that finishes after a reconnect is announced by the new connection (PR review 2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const draft = new DraftSession({
      compile: async (input) => {
        await gate;
        return compiled(input.fragments.join(' '));
      },
    });
    const deskClient = desk();
    const backend = new SimulatedAgentBackend({});
    const first = setup({ draft, desk: deskClient, backend });
    await say(first, 'd1', 'draft mode');
    await say(first, 'd2', 'the ferry leaves at seven');
    first.client.ask('d3', 'send it');
    await vi.advanceTimersByTimeAsync(300);
    expect(deskClient.draft?.status).toBe('compiling');
    first.operator.stop();
    const second = setup({ draft, desk: deskClient, backend });
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(deskClient.draft?.status).toBe('confirm');
    expect(commentary(second).some((text) => text.includes('Send that to Sierra?'))).toBe(true);
    expect(first.client.appends.some((append) => append.content.includes('Send that to'))).toBe(false);
    await say(second, 'e1', 'yes');
    expect(backend.sends).toHaveLength(1);
  });

  it('dictation run together with "okay send it" is the last fragment (PR review 3)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode for Sierra');
    await say(rig, 'd2', 'we need the ladder');
    await say(rig, 'd3', 'and bring the drill okay send it');
    expect(rig.compiles[0].fragments).toEqual(['we need the ladder', 'and bring the drill']);
    expect(rig.desk.draft?.status).toBe('sending');
  });

  it('a router-recognized finish keeps the dictation before the cue (PR review 3)', async () => {
    const rig = setup({ actions: [[{ type: 'draft', op: 'finish', message: 'and bring the drill' }], [{ type: 'draft', op: 'finish' }]] });
    await say(rig, 'd1', 'draft mode for Sierra');
    await say(rig, 'd2', 'and bring the drill I reckon that is ready to fire off');
    expect(rig.compiles[0].fragments).toEqual(['and bring the drill']);
    // Without the router's message: what precedes the cue.
    await say(rig, 'd3', 'never mind');
    await say(rig, 'd4', 'draft mode for Sierra');
    await say(rig, 'd5', 'and bring the ladder from the garage I think that is ready to fire off');
    expect(rig.compiles[1].fragments).toEqual(['and bring the ladder from the garage']);
  });

  it("an old session's unsent-card clear carries its own draft id, so it can't wipe a newer draft (PR review 3)", async () => {
    const deskClient = desk();
    const a = setup({ desk: deskClient });
    await say(a, 'd1', 'draft mode for Sierra');
    await say(a, 'd2', 'remember the spare key');
    a.draft.end();
    const unsent = deskClient.draft!;
    expect(unsent).toMatchObject({ status: 'cancelled', id: expect.any(String) });
    a.operator.stop();
    const b = setup({ desk: deskClient });
    await say(b, 'e1', 'draft mode for Victor');
    const newer = deskClient.draft!;
    expect(newer.id).not.toBe(unsent.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    const clear = deskClient.drafts.find((card) => card.clears);
    expect(clear).toMatchObject({ clears: unsent.id, active: false, id: null });
    expect(b.draft.active).toBe(true);
  });

  it('a send that resolves after the session ended changes nothing (PR review 3)', async () => {
    for (const fails of [false, true]) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const rig = setup({ desk: slowAgentThreads(gate, fails), compile: (input) => compiled(input.fragments.join(' '), { agentId: 'victor', newThreadTitle: 'Retries' }) });
      await say(rig, 'd1', 'draft mode for Victor');
      await say(rig, 'd2', 'add retries');
      await say(rig, 'd3', 'send it');
      rig.desk.draftHandler?.({ action: 'send', draftId: rig.desk.draft?.id ?? undefined });
      await vi.advanceTimersByTimeAsync(100);
      rig.draft.end();
      rig.operator.stop();
      const closed = rig.desk.draft!;
      expect(closed).toMatchObject({ active: false, status: 'cancelled', note: expect.stringContaining('ended while this was sending') });
      const published = rig.desk.drafts.length;
      release();
      await vi.advanceTimersByTimeAsync(500);
      expect(rig.desk.drafts).toHaveLength(published);
      expect(rig.draft.active).toBe(false);
      expect(rig.draft.state).toBe(closed);
    }
  });

  it('a Send tap shows a non-cancellable "sending" state until delivery resolves (PR review)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rig = setup({ desk: slowAgentThreads(gate), compile: (input) => compiled(input.fragments.join(' '), { agentId: 'victor', newThreadTitle: 'Retries' }) });
    await say(rig, 'd1', 'draft mode for Victor');
    await say(rig, 'd2', 'add retries');
    await say(rig, 'd3', 'send it');
    rig.desk.draftHandler?.({ action: 'send', draftId: rig.desk.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'sending' });
    expect(rig.desk.drafts.some((card) => card.status === 'sent')).toBe(false);
    rig.desk.draftHandler?.({ action: 'cancel', draftId: rig.desk.draft?.id ?? undefined }); // too late: ignored
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.draft.active).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.desk.agentThreads).toHaveLength(1);
    expect(rig.desk.draft).toMatchObject({ active: false, status: 'sent' });
  });

  it('keeps the voice connection from sleeping while drafting', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode');
    expect(rig.operator.isIdle()).toBe(false);
    await say(rig, 'd2', 'cancel the draft');
    expect(rig.operator.isIdle()).toBe(true);
  });
});

describe('live test 10/06 fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  /** Victor's chapter, Sierra's thread, and a Loom thread (handles i1, i2, i3 in the router's listing). */
  const loomDesk = () =>
    new FakeDesk([
      deskItem('discord:chapter:vic', 'victor', { nextStep: 'fyi' }),
      deskItem(`discord:thread:${THREAD}`, 'sierra', { threadId: THREAD, place: 'Shed vents', nextStep: 'watching' }),
      deskItem('loom:harbor', 'loom', { place: 'demo · Lantern Row', nextStep: 'fyi' }),
    ]);
  const refs = (deskClient: FakeDesk) =>
    deskClient.list.map((item) => ({ id: item.id, agentId: item.agentId, agentName: item.agentName, place: item.place, threadId: item.threadId, isAgent: item.agentId !== 'loom' }));

  it('more ways to ask, with an agent or a desk conversation as the target', () => {
    const items = refs(loomDesk());
    expect(matchDraftStart('Could you draft a longer message for the Lantern Row Loom thread', AGENTS, items)).toMatchObject({ item: { id: 'loom:harbor' }, rest: '' });
    expect(matchDraftStart('can you draft a message for the shed vents thread, the left one rattles', AGENTS, items)).toMatchObject({ item: { id: `discord:thread:${THREAD}` }, rest: 'the left one rattles' });
    expect(matchDraftStart('help me draft a reply to Victor', AGENTS, items)).toMatchObject({ agent: { id: 'victor' } });
    // Codex review on #703: Loom said inside the message is content, not a destination.
    expect(matchDraftStart('help me draft a reply to say Loom is down', AGENTS, items)).toMatchObject({ rest: 'say Loom is down' });
    expect(matchDraftStart('draft something for Sierra', AGENTS, items)).toMatchObject({ agent: { id: 'sierra' } });
    expect(matchDraftStart('I want to draft a quick note', AGENTS, items)).toEqual({ rest: '', reply: false });
    expect(matchDraftStart("let's draft a reply", AGENTS, items)).toEqual({ rest: '', reply: true });
    for (const phrase of ['the draft says Tuesday', 'send Sierra the draft', 'what did the draft look like']) expect(matchDraftStart(phrase, AGENTS, items), phrase).toBeNull();
    // Only a request at the start of the utterance (PR #392 review).
    for (const phrase of ['read me the draft message', 'is the draft message ready', 'what did the draft note say', 'Sierra sent the draft reply already', 'I saw your draft response', 'tell Victor to draft a note for the team']) {
      expect(matchDraftStart(phrase, AGENTS, items), phrase).toBeNull();
    }
    for (const phrase of ['draft a message for Victor', 'okay so could you draft a note', 'please draft a reply to Sierra', "let's draft something for Victor"]) {
      expect(matchDraftStart(phrase, AGENTS, items), phrase).not.toBeNull();
    }
    // Two conversations with the same title: no guess (the compile asks).
    const twice = [...items, { ...items[2]!, id: 'loom:harbor-2', place: 'other · Lantern Row' }];
    expect(matchDraftStart('could you draft a message for the Lantern Row thread', AGENTS, twice)?.item).toBeUndefined();
  });

  it('a draft for a named desk conversation keeps it as the target through compile and send', async () => {
    const deskClient = loomDesk();
    const rig = setup({ desk: deskClient, compile: (input) => compiled('Ship the fix behind a flag.', { agentId: null }) });
    await say(rig, 'd1', 'Could you draft a longer message for the Lantern Row Loom thread');
    expect(rig.draft.active).toBe(true);
    expect(rig.routed).toHaveLength(0);
    expect(rig.desk.draft?.target).toMatchObject({ agentId: 'loom', label: 'Loom · demo · Lantern Row' });
    expect(traced(rig, 'draft.start')[0].data).toMatchObject({ targetItem: 'loom:harbor' });
    await say(rig, 'd2', 'ship the fix behind a flag');
    await say(rig, 'd3', 'send it');
    expect(rig.compiles[0].targetItem).toMatchObject({ handle: 'i3', agentName: 'Loom', place: 'demo · Lantern Row' });
    expect(rig.desk.draft?.target).toMatchObject({ label: 'Loom · demo · Lantern Row', itemId: 'loom:harbor' });
    expect(rig.desk.draft?.status).toBe('sending');
    await vi.advanceTimersByTimeAsync(5000);
    expect(deskClient.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:harbor', args: { text: 'Ship the fix behind a flag.' } })]);
  });

  it('"let\'s work on a response for …" starts a reply draft, for an agent or a desk conversation', () => {
    const items = refs(loomDesk());
    expect(matchDraftStart("Hey, let's work on a response for Sierra", AGENTS, items)).toMatchObject({ agent: { id: 'sierra' }, reply: true, rest: '' });
    expect(matchDraftStart("let's work on a reply to the shed vents thread, the left one still rattles", AGENTS, items)).toMatchObject({ item: { id: `discord:thread:${THREAD}` }, reply: true, rest: 'the left one still rattles' });
    expect(matchDraftStart('can we put together an answer for the Lantern Row Loom thread', AGENTS, items)).toMatchObject({ item: { id: 'loom:harbor' }, reply: true });
    expect(matchDraftStart('help me respond to Victor', AGENTS, items)).toMatchObject({ agent: { id: 'victor' }, reply: true });
    expect(matchDraftStart("I've got a long message for Sierra", AGENTS, items)).toMatchObject({ reply: false });
    // An agent then one of their conversations (Codex review); another agent's thread title is dictation.
    expect(matchDraftStart("let's work on a response for Sierra in the shed vents thread, the left one rattles", AGENTS, items)).toMatchObject({ agent: { id: 'sierra' }, item: { id: `discord:thread:${THREAD}` }, rest: 'the left one rattles' });
    expect(matchDraftStart("let's work on a response for Victor about the shed vents thread", AGENTS, items)).toMatchObject({ agent: { id: 'victor' }, rest: 'about the shed vents thread' });
    // Possessives (Codex review): the agent is the target and "message" isn't dictation.
    expect(matchDraftStart("help me respond to Victor's message", AGENTS, items)).toMatchObject({ agent: { id: 'victor' }, reply: true, rest: '' });
    expect(matchDraftStart("let's work on a reply to Sierra's latest update, I think the vents can wait", AGENTS, items)).toMatchObject({ agent: { id: 'sierra' }, rest: 'I think the vents can wait' });
    for (const phrase of ['Sierra will work on a response tomorrow', 'did Victor respond to the email', 'the response for Sierra was fine']) expect(matchDraftStart(phrase, AGENTS, items), phrase).toBeNull();
  });

  it('a reply draft pulls up the conversation it answers, behind the Draft banner', async () => {
    const rig = setup({ desk: loomDesk() });
    await say(rig, 'd1', "Hey, let's work on a response for the shed vents thread");
    expect(rig.draft.active).toBe(true);
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: `discord:thread:${THREAD}`, reason: 'user' });
    expect(traced(rig, 'view.decision').at(-1)?.summary).toContain('draft context: open the conversation');
  });

  it("a reply draft for an agent pulls up their latest conversation, or its newer screen", async () => {
    const screen = new FakeDeskScreen();
    const rig = setup({ desk: loomDesk(), screen });
    await say(rig, 'd1', "let's work on a response for Sierra");
    expect(screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: `discord:thread:${THREAD}` });
    await say(rig, 'd2', 'cancel the draft');
    // A screen staged in that thread since its last message is where things stand.
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const before = screen.intents.length;
    await say(rig, 'd3', "let's work on a response for Sierra");
    expect(screen.shows.at(-1)).toEqual({ id: 'vents-photos', reason: 'user' });
    expect(screen.intents).toHaveLength(before);
  });

  it('a reply draft for a Loom conversation finds its screen by conversation key (no thread id)', async () => {
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('harbor-mock', 'loom', { conversationKey: 'loom:harbor', threadId: null, updatedAt: 90_000_000 })];
    const rig = setup({ desk: loomDesk(), screen });
    await say(rig, 'd1', "let's work on a reply to the Lantern Row Loom thread");
    expect(screen.shows.at(-1)).toEqual({ id: 'harbor-mock', reason: 'user' });
  });

  it('background activity after the screen (a Loom "context window updated") does not hide it: measured from the last message', async () => {
    const deskClient = loomDesk();
    const vents = deskClient.list.find((item) => item.threadId === THREAD)!;
    vents.lastActivityAt = 90_000_000 + 30 * 60_000; // activity half an hour after the screen went up
    deskClient.messages.set(vents.id, [{ author: 'agent', text: 'The mockup is on your screen.', at: 90_000_000 + 15_000 }]);
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const rig = setup({ desk: deskClient, screen });
    await say(rig, 'd1', "let's work on a response for the shed vents thread");
    expect(screen.shows.at(-1)).toEqual({ id: 'vents-photos', reason: 'user' });
  });

  it('the owner wrote after the screen went up: the conversation opens, not the stale screen (Codex review on #435)', async () => {
    const deskClient = loomDesk();
    const vents = deskClient.list.find((item) => item.threadId === THREAD)!;
    vents.lastActivityAt = 90_000_000 + 10 * 60_000;
    deskClient.messages.set(vents.id, [
      { author: 'agent', text: 'The mockup is on your screen.', at: 90_000_000 + 15_000 },
      { author: 'owner', text: 'Make the header smaller.', at: 90_000_000 + 10_000 },
    ]);
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const rig = setup({ desk: deskClient, screen });
    await say(rig, 'd1', "let's work on a response for the shed vents thread");
    expect(screen.shows).toHaveLength(0);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: `discord:thread:${THREAD}` });
  });

  it('a slow desk lookup never overrides a view the owner changed meanwhile (Codex review on #435)', async () => {
    const deskClient = loomDesk();
    deskClient.itemDelayMs = 3000;
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const rig = setup({ desk: deskClient, screen });
    rig.client.ask('d1', "let's work on a response for the shed vents thread");
    await vi.advanceTimersByTimeAsync(600);
    await screen.present({ view: 'active', reason: 'user' });
    screen.presented = { ...screen.presented!, since: Date.now() } as never;
    await vi.advanceTimersByTimeAsync(3500);
    expect(screen.shows).toHaveLength(0);
    expect(traced(rig, 'view.decision').some((entry) => entry.summary.includes('the view changed while looking it up'))).toBe(true);
  });

  it('a board tap that arrives before the screen state updates still outranks a pending lookup (Codex review 2 on #435)', async () => {
    const deskClient = loomDesk();
    deskClient.itemDelayMs = 3000;
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const rig = setup({ desk: deskClient, screen });
    rig.client.ask('d1', "let's work on a response for the shed vents thread");
    await vi.advanceTimersByTimeAsync(600);
    const vents = deskClient.list.find((item) => item.threadId === THREAD)!;
    deskClient.tap(vents.id, { view: 'active', itemId: null, conversationKey: null, since: Date.now() + 1 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(screen.shows).toHaveLength(0);
  });

  it('with a judge, relevance beats recency: an older screen the talk is still about opens; the judge sees every candidate', async () => {
    const deskClient = loomDesk();
    const vents = deskClient.list.find((item) => item.threadId === THREAD)!;
    vents.lastActivityAt = 90_000_000 + 60 * 60_000;
    deskClient.messages.set(vents.id, [
      { author: 'agent', text: 'Photos of both vents are on your screen.', at: 90_000_000 + 10_000 },
      { author: 'owner', text: 'The left one in the photos looks cracked, right?', at: 90_000_000 + 50 * 60_000 },
      { author: 'agent', text: 'Yes, the left vent in the photos has a hairline crack.', at: 90_000_000 + 60 * 60_000 },
    ]);
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const seen: Array<Parameters<ScreenPicker>[0]> = [];
    const rig = setup({ desk: deskClient, screen, extra: { pickScreen: async (input) => (seen.push(input), { pick: 'vents-photos', reason: 'the talk is still about the photos' }) } });
    await say(rig, 'd1', "let's work on a response for the shed vents thread");
    expect(seen[0]!.screens.map((candidate) => candidate.id)).toEqual(['vents-photos']);
    expect(seen[0]!.messages.at(-1)!.text).toContain('hairline crack');
    expect(screen.shows.at(-1)).toEqual({ id: 'vents-photos', reason: 'user' });
    expect(traced(rig, 'view.decision').at(-1)?.summary).toContain('judged: the talk is still about the photos');
  });

  it('with a judge, a newer screen the talk moved past loses: the conversation opens', async () => {
    const deskClient = loomDesk();
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const rig = setup({ desk: deskClient, screen, extra: { pickScreen: async () => ({ pick: null, reason: 'the talk moved on to scheduling' }) } });
    await say(rig, 'd1', "let's work on a response for the shed vents thread");
    expect(screen.shows).toHaveLength(0);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: `discord:thread:${THREAD}` });
  });

  it('a screen from another conversation is a candidate when the latest messages name it', async () => {
    const deskClient = loomDesk();
    const vents = deskClient.list.find((item) => item.threadId === THREAD)!;
    deskClient.messages.set(vents.id, [{ author: 'agent', text: 'Same parts as the Truck parts matrix, so check that screen.', at: 90_000_000 }]);
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('parts', 'victor', { threadId: '999', updatedAt: 80_000_000, title: 'Truck parts matrix' })];
    const seen: Array<Parameters<ScreenPicker>[0]> = [];
    const rig = setup({ desk: deskClient, screen, extra: { pickScreen: async (input) => (seen.push(input), { pick: 'parts', reason: 'the reply points at it' }) } });
    await say(rig, 'd1', "let's work on a response for the shed vents thread");
    expect(seen[0]!.screens).toEqual([expect.objectContaining({ id: 'parts', fromThisConversation: false })]);
    expect(screen.shows.at(-1)).toEqual({ id: 'parts', reason: 'user' });
  });

  it('a judge that fails or stalls: recency decides, and opening never waits more than ~3 s', async () => {
    const deskClient = loomDesk();
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 })];
    const rig = setup({ desk: deskClient, screen, extra: { pickScreen: () => new Promise(() => {}) } });
    rig.client.ask('d1', "let's work on a response for the shed vents thread");
    await vi.advanceTimersByTimeAsync(3600);
    expect(screen.shows.at(-1)).toEqual({ id: 'vents-photos', reason: 'user' });
  });

  it('a message newer than the screen (beyond the same turn) wins: the conversation opens (Codex review)', async () => {
    const deskClient = loomDesk();
    const vents = deskClient.list.find((item) => item.threadId === THREAD)!;
    vents.lastActivityAt = 90_000_000;
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('vents-photos', 'sierra', { threadId: THREAD, updatedAt: 90_000_000 - 60_000 })];
    const rig = setup({ desk: deskClient, screen });
    await say(rig, 'd1', "let's work on a response for the shed vents thread");
    expect(screen.shows).toHaveLength(0);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: `discord:thread:${THREAD}` });
  });

  it('a reply draft for an agent with nothing on the desk leaves the screens alone, even with a staged scene (Codex review)', async () => {
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('malibu-old', 'malibu', { updatedAt: 90_000_000 })];
    const rig = setup({ desk: loomDesk(), screen });
    await say(rig, 'd1', "let's work on a response for Malibu");
    expect(rig.draft.active).toBe(true);
    expect(screen.shows).toHaveLength(0);
    expect(screen.intents.filter((intent) => intent.view !== 'active')).toHaveLength(0);
  });

  it("a conversation the owner's filters took off the board is never pulled up (Codex review)", async () => {
    const deskClient = loomDesk();
    deskClient.list.find((item) => item.threadId === THREAD)!.filteredBy = [{ rule: 'quiet' }];
    const rig = setup({ desk: deskClient });
    await say(rig, 'd1', "let's work on a response for Sierra");
    expect(rig.draft.active).toBe(true);
    expect(rig.screen.intents.filter((intent) => intent.view === 'conversation')).toHaveLength(0);
  });

  it('"can you help me draft …" starts a draft; a target the phrase can\'t read goes to the router (live test 10/07)', () => {
    const items = refs(loomDesk());
    expect(matchDraftStart('can you help me draft a message for the Lantern Row Loom thread', AGENTS, items)).toMatchObject({ item: { id: 'loom:harbor' } });
    expect(matchDraftStart('could you help me work on a reply to Sierra', AGENTS, items)).toMatchObject({ agent: { id: 'sierra' }, reply: true });
    expect(matchDraftStart('Alright, can you help me draft a response to the uh Loom thread about the harbor', AGENTS, items)).toEqual({ aimed: true, reply: true, rest: '' });
    expect(matchDraftStart('can you help me draft a message for Sierra', AGENTS, items)?.aimed).toBeUndefined();
    // An infinitive "to" begins the content, not a destination (Codex review).
    expect(matchDraftStart('can you help me draft a reply to say the deploy failed because the key expired', AGENTS, items)).toEqual({ rest: 'say the deploy failed because the key expired', reply: true });
  });

  it('the router names the conversation a deferred start meant, and the screens follow (live test 10/07)', async () => {
    const rig = setup({ desk: loomDesk(), actions: [[{ type: 'draft', op: 'start', item: 'i3' }]] });
    await say(rig, 'd1', 'Alright, can you help me draft a response to the uh Loom thread about the harbor');
    expect(rig.routed).toHaveLength(1);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ agentId: 'loom' });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: 'loom:harbor' });
  });

  it('a deferred start the router misreads as "open" still starts the draft, so the next words are not sent (live test 10/07)', async () => {
    const deskClient = loomDesk();
    const rig = setup({ desk: deskClient, actions: [[{ type: 'desk', op: 'open', item: 'i3' }]] });
    await say(rig, 'd1', 'Alright, can you help me draft a response to the uh Loom thread about the harbor');
    expect(rig.draft.active).toBe(true);
    expect(traced(rig, 'draft.start.fallback')).toHaveLength(1);
    // The unread target's words are not the message (Codex review).
    expect(rig.desk.draft?.fragments).toEqual([]);
    await say(rig, 'd2', 'let us open with a summary of the changes and why');
    expect(deskClient.sent('reply')).toHaveLength(0);
    expect(rig.draft.active).toBe(true);
  });

  it('a deferred start survives a failed route: the draft still starts (Codex review)', async () => {
    const deskClient = loomDesk();
    const rig = setup({ desk: deskClient, extra: { extractor: async () => { throw new Error('router down'); } } });
    await say(rig, 'd1', 'Alright, can you help me draft a response to the uh Loom thread about the harbor');
    await vi.advanceTimersByTimeAsync(1500); // the router's one retry
    expect(rig.draft.active).toBe(true);
    await say(rig, 'd2', 'let us open with a summary of the changes and why');
    expect(deskClient.sent('reply')).toHaveLength(0);
  });

  it("a send leaves the board up: the thread's older screen does not come back until the answer does (10/08)", async () => {
    const screen = new FakeDeskScreen();
    screen.scenes = [scene('radar-old', 'sierra', { updatedAt: Date.now() + 5_000 })];
    const rig = setup({ screen, actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Is a speaker hookup required for the detector?' }]] });
    await say(rig, 'd1', 'Ask Sierra whether the detector has to hook into the speaker');
    expect(rig.backend.sends).toHaveLength(1);
    expect(screen.shows).toHaveLength(0);
    expect(traced(rig, 'screen.focus').at(-1)?.summary).toContain('the board stays up');
  });

  it('a plain new message for an agent leaves the screens alone', async () => {
    const rig = setup({ desk: loomDesk() });
    await say(rig, 'd1', "I've got a long message for Sierra");
    expect(rig.draft.active).toBe(true);
    expect(rig.screen.intents.filter((intent) => intent.view === 'conversation')).toHaveLength(0);
  });

  it("the router's draft start carries the named conversation", async () => {
    const deskClient = loomDesk();
    const rig = setup({ desk: deskClient, actions: [[{ type: 'draft', op: 'start', item: 'i3' }]] });
    await say(rig, 'd1', 'I need to put together something longer for that Lantern Row coding thread');
    expect(rig.routed).toHaveLength(1);
    expect(rig.desk.draft).toMatchObject({ active: true, target: { agentId: 'loom', label: 'Loom · demo · Lantern Row' } });
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'draft', draft_op: 'start', item: 'i3', agent_id: '' }] }))).toEqual([{ type: 'draft', op: 'start', item: 'i3' }]);
    expect(buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'x' })).toContain('item = the desk handle when they name a conversation');
  });

  it('holds agent updates while drafting and announces them once the draft closes', async () => {
    const backend = new SimulatedAgentBackend({ malibu: () => [{ kind: 'result', text: 'Logged the eggs, 12 grams of protein.', afterMs: 3000 }] });
    const rig = setup({ backend, actions: [[{ type: 'dispatch', agentId: 'malibu', message: 'The user had eggs.' }]] });
    await say(rig, 'd1', 'tell Malibu I had eggs');
    await say(rig, 'd2', 'draft mode for Sierra');
    await vi.advanceTimersByTimeAsync(20_000); // the result is back, and waits
    await say(rig, 'd3', 'the patio needs another coat');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(commentary(rig).some((text) => text.includes('12 grams'))).toBe(false);
    expect(traced(rig, 'speech.held')).toHaveLength(1);
    await say(rig, 'd4', 'cancel the draft');
    await vi.advanceTimersByTimeAsync(3000);
    const said = commentary(rig);
    const announced = said.findIndex((text) => text.includes('1 update came in while you were drafting'));
    const relayed = said.findIndex((text) => text.includes('12 grams'));
    expect(announced).toBeGreaterThan(-1);
    expect(relayed).toBeGreaterThan(announced);
  });

  for (const policy of ['immediate', 'model'] as const) {
    it(`${policy} delivery waits too while drafting, and goes out once the draft closes (PR #392 review)`, async () => {
      const backend = new SimulatedAgentBackend({
        malibu: () => [{ kind: 'result', text: 'Logged the eggs, 12 grams of protein.', afterMs: 3000 }],
        victor: () => [{ kind: 'result', text: 'The build is green again.', afterMs: 4000 }],
      });
      const rig = setup({
        backend,
        actions: [[{ type: 'dispatch', agentId: 'malibu', message: 'The user had eggs.' }], [{ type: 'dispatch', agentId: 'victor', message: 'Check the build.' }]],
        extra: { policy },
      });
      await say(rig, 'd1', 'tell Malibu I had eggs');
      await say(rig, 'd2', 'ask Victor to check the build');
      await say(rig, 'd3', 'draft mode for Sierra');
      await vi.advanceTimersByTimeAsync(10_000);
      const everything = () => rig.client.appends.map((append) => append.content).join('\n');
      expect(everything()).not.toContain('12 grams');
      expect(everything()).not.toContain('build is green');
      await say(rig, 'd4', 'cancel the draft');
      await vi.advanceTimersByTimeAsync(15_000);
      const said = commentary(rig);
      const announced = said.findIndex((text) => text.includes('2 updates came in while you were drafting'));
      expect(announced).toBeGreaterThan(-1);
      expect(said.findIndex((text) => text.includes('12 grams'))).toBeGreaterThan(announced);
      expect(said.findIndex((text) => text.includes('build is green'))).toBeGreaterThan(announced);
    });
  }

  it('every GPT-Live delegation while drafting is answered with "still drafting"', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode for Sierra');
    await say(rig, 'd2', 'tell it that I have');
    await say(rig, 'd3', 'passed along');
    const still = rig.client.appends.filter((append) => append.kind === 'instructions' && append.content === DRAFT_STILL_INSTRUCTIONS);
    expect(still.map((append) => append.delegationId)).toEqual(['d2', 'd3']);
    expect(DRAFT_STILL_INSTRUCTIONS).toMatch(/Never say you sent, passed along/);
    expect(rig.desk.draft?.fragments).toEqual(['tell it that I have', 'passed along']);
    expect(rig.backend.sends).toHaveLength(0);
    // A pause collected without a delegation needs no answer.
    rig.client.user(' and the ladder');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.client.appends.filter((append) => append.content === DRAFT_STILL_INSTRUCTIONS)).toHaveLength(2);
  });
});

describe('safety net: "Is that everything?"', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('holds a send that ends mid-sentence; "yes" sends it once', async () => {
    const send: OperatorAction[] = [{ type: 'dispatch', agentId: 'sierra', message: 'Book the ferry.' }];
    const rig = setup({ actions: [send] });
    await say(rig, 'd1', 'tell Sierra to book the ferry and');
    expect(rig.backend.sends).toHaveLength(0);
    expect(commentary(rig).at(-1)).toContain('Is that everything?');
    expect(traced(rig, 'safety.hold')).toHaveLength(1);
    await say(rig, 'd2', 'yes');
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.message).toBe('Book the ferry.');
    expect(rig.routed).toHaveLength(1);
  });

  it('more speech after the question is added, routed as one request, and sent without asking again', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Book the ferry.' }], [{ type: 'dispatch', agentId: 'sierra', message: 'Book the ferry for Saturday morning.' }]] });
    await say(rig, 'd1', 'tell Sierra to book the ferry, um');
    await say(rig, 'd2', 'for Saturday morning, and um');
    expect(rig.routed[1].latestUserSpeech).toBe('tell Sierra to book the ferry, um for Saturday morning, and um');
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.message).toBe('Book the ferry for Saturday morning.');
  });

  it('holds when the router flags it unfinished and there is no closing punctuation', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'victor', message: 'Look at the build.' }, { type: 'draft', op: 'unfinished' }]] });
    await say(rig, 'd1', 'ask Victor to look at the build when he gets a');
    expect(rig.backend.sends).toHaveLength(0);
    expect(traced(rig, 'safety.hold')[0].data).toMatchObject({ flagged: true });
  });

  it('a flagged reply alone is sent; a flagged reply plus new work is held', async () => {
    const reply = setup({ actions: [[{ type: 'reply', taskId: 't1', message: 'Go with the blue one.' }, { type: 'draft', op: 'unfinished' }]] });
    await say(reply, 'd1', 'yes, go with the blue one and keep the rest as it was');
    expect(traced(reply, 'safety.hold')).toHaveLength(0);
    const mixed = setup({ actions: [[{ type: 'reply', taskId: 't1', message: 'Go with the blue one.' }, { type: 'dispatch', agentId: 'victor', message: 'Look at the build.' }, { type: 'draft', op: 'unfinished' }]] });
    await say(mixed, 'd1', 'go with the blue one and ask Victor to look at the build when he gets');
    expect(mixed.backend.sends).toHaveLength(0);
    expect(traced(mixed, 'safety.hold')).toHaveLength(1);
  });

  it('never holds a complete short command', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'malibu', message: 'The user had eggs.' }]] });
    await say(rig, 'd1', 'tell Malibu I had eggs');
    expect(rig.backend.sends).toHaveLength(1);
    expect(traced(rig, 'safety.hold')).toHaveLength(0);
  });

  it('"never mind" drops the held request', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'x' }]] });
    await say(rig, 'd1', 'ask Sierra about the');
    await say(rig, 'd2', 'never mind');
    expect(rig.backend.sends).toHaveLength(0);
    expect(traced(rig, 'safety.dropped')).toHaveLength(1);
  });
});

describe('draft phrases and checks', () => {
  it('start phrases', () => {
    for (const phrase of ['draft mode', "Let's do draft mode for Sierra", 'let me think out loud', 'Let me talk this through.', "I've got a long message for Victor", 'Hang on, I\'m working this out', 'I want to dictate a note', 'confirm mode']) {
      expect(matchDraftStart(phrase, AGENTS), phrase).not.toBeNull();
    }
    expect(matchDraftStart("I've got a message for Sierra", AGENTS)?.agent?.id).toBe('sierra');
    for (const phrase of ['exit draft mode', 'tell Sierra to book the ferry', 'what do you think', 'let me know when Victor is done']) {
      expect(matchDraftStart(phrase, AGENTS), phrase).toBeNull();
    }
  });

  it('finish phrases, and content before them', () => {
    for (const phrase of ['okay send it', "that's it", 'go ahead', 'done, send that', "Okay, that's everything.", "I'm done", 'alright send it to Sierra']) {
      expect(matchDraftFinish(phrase, AGENTS), phrase).not.toBeNull();
    }
    expect(matchDraftFinish('and bring the drill. Okay, send it.', AGENTS)).toEqual({ content: 'and bring the drill.' });
    expect(matchDraftFinish('send it to Victor', AGENTS)?.agent?.id).toBe('victor');
    // Run together, no punctuation (PR review 3): only a tail opened by okay / alright.
    expect(matchDraftFinish('and bring the drill okay send it', AGENTS)).toEqual({ content: 'and bring the drill' });
    expect(matchDraftFinish("and the ladder alright that's it", AGENTS)).toEqual({ content: 'and the ladder' });
    expect(matchDraftFinish('and they should send it', AGENTS)).toBeNull();
    expect(matchDraftFinish('I think the painting is done', AGENTS)).toBeNull();
    expect(contentBeforeFinish('and bring the drill send it')).toBe('and bring the drill');
    expect(contentBeforeFinish('ready')).toBe('');
    for (const phrase of ['and then we are done with the patio by noon', 'send it to the printer', 'go ahead and paint the fence blue next week']) {
      expect(matchDraftFinish(phrase, AGENTS), phrase).toBeNull();
    }
  });

  it('cancels match the whole utterance; dictation that only contains the words is kept (PR review 4)', () => {
    for (const phrase of ['okay cancel the draft', 'actually never mind', 'wait, cancel the draft please', 'exit draft mode', 'no, forget it']) expect(isDraftCancel(phrase, 'listening'), phrase).toBe(true);
    for (const phrase of ['and never mind the cost, just book it', 'I want to cancel the meeting', 'cancel the draft review on Friday', 'tell her to forget it', 'we should stop drafting contracts by hand']) {
      expect(isDraftCancel(phrase, 'listening'), phrase).toBe(false);
      expect(isDraftCancel(phrase, 'confirm'), phrase).toBe(false);
    }
    expect(isDraftCancel('scratch that and make it Tuesday', 'confirm')).toBe(false);
    expect(isDraftCancel('okay scratch that', 'confirm')).toBe(true);
    // Answering "Where should it start?" with a change of mind (live audio test 10/18).
    expect(isDraftCancel("Actually, never mind. Don't start it.", 'confirm')).toBe(true);
    expect(isDraftCancel("don't start it", 'confirm')).toBe(true);
    expect(isDraftCancel("don't start it in tango, start it with Sierra", 'confirm')).toBe(false);
  });

  it('a start phrase ending on "for" takes the name right after it, punctuation or not (PR review 4)', () => {
    expect(matchDraftStart("I've got a long message for Sierra the patio needs another coat", AGENTS)).toEqual({ agent: AGENTS[0], rest: 'the patio needs another coat', reply: false });
    expect(matchDraftStart('take a message for Victor the build is flaky again', AGENTS)).toEqual({ agent: AGENTS[1], rest: 'the build is flaky again', reply: false });
  });

  it('cancel: explicit while listening ("scratch that" is a self-correction), looser at confirm', () => {
    expect(isDraftCancel('scratch that', 'listening')).toBe(false);
    expect(isDraftCancel('cancel the draft', 'listening')).toBe(true);
    expect(isDraftCancel('never mind', 'listening')).toBe(true);
    expect(isDraftCancel('scratch that', 'confirm')).toBe(true);
    expect(isDraftCancel("don't send it", 'confirm')).toBe(true);
  });

  it('a plain yes is a complete affirmative only; anything more is an edit (PR review)', () => {
    for (const yes of ['yes', 'Yes.', 'yep, send it', "that's everything", 'sure', 'go ahead', 'okay, yes please', 'yeah do it', 'sounds good thanks', 'Yes - Mm', 'mm, yeah', 'yes please, mhm']) expect(isPlainYes(yes), yes).toBe(true);
    for (const not of ['yes but change Tuesday to Wednesday', 'no', 'yeah, also add the address', 'not yet', 'yes to Sierra', 'yes after lunch', 'yes with the attachment', 'go ahead and send it to Victor', 'sure, in the speaker thread']) {
      expect(isPlainYes(not), not).toBe(false);
    }
  });

  it('keeps what was said in the trigger sentence after the trigger and target (PR review)', () => {
    expect(matchDraftStart("I've got a long message for Sierra: the patio needs another coat", AGENTS)).toEqual({ agent: AGENTS[0], rest: 'the patio needs another coat', reply: false });
    expect(matchDraftStart('let me think out loud, the deploy is blocked', AGENTS)).toEqual({ rest: 'the deploy is blocked', reply: false });
    expect(matchDraftStart('Draft mode for Victor. The build is flaky again', AGENTS)).toEqual({ agent: AGENTS[1], rest: 'The build is flaky again', reply: false });
    expect(matchDraftStart('okay draft mode', AGENTS)).toEqual({ rest: '', reply: false });
    // A name inside the content is content, not the target.
    expect(matchDraftStart('let me think out loud, Victor said the build is flaky', AGENTS)).toEqual({ rest: 'Victor said the build is flaky', reply: false });
  });

  it('targets in short speech only', () => {
    expect(matchDraftTarget("it's for Sierra", AGENTS)?.id).toBe('sierra');
    expect(matchDraftTarget('Victor', AGENTS)?.id).toBe('victor');
    expect(matchDraftTarget('Sierra said the trail was closed last week', AGENTS)).toBeUndefined();
  });

  it('overlap trimming', () => {
    expect(trimOverlap('we leave on friday morning', 'on friday morning early')).toBe('early');
    expect(trimOverlap('we leave on friday morning', 'friday morning')).toBeNull();
    expect(trimOverlap('we leave', 'then we eat')).toBe('then we eat');
  });

  it('unfinished: dangling ends held, complete short commands never', () => {
    for (const unfinished of ['tell Sierra the patio needs, um', 'book the ferry and', 'ask Victor about the', 'I think we should,', 'so for Sierra']) {
      expect(looksUnfinished(unfinished, { dispatch: true, names: ['Sierra', 'Victor'] }), unfinished).toBe(true);
    }
    for (const complete of ['tell Malibu I had eggs', 'lights on', 'yes', 'tell her I think so', 'ask Victor to merge it.', 'catch me up', 'request d1', 'check the weather for Saturday']) {
      expect(looksUnfinished(complete, { dispatch: true, names: ['Malibu', 'Victor'] }), complete).toBe(false);
    }
    expect(looksUnfinished('ask Victor to look at the build when he gets', { flagged: true, dispatch: true })).toBe(true);
    expect(looksUnfinished('ask Victor to look at the build.', { flagged: true, dispatch: true })).toBe(false);
    // A reply or answer is held only for a hard cue, never for the router's flag alone.
    expect(looksUnfinished('yes, go with the blue one and keep the rest as it was', { flagged: true })).toBe(false);
    expect(looksUnfinished('the first two are garden supplies, and is the third one a duplicate', { flagged: true })).toBe(false);
    expect(looksUnfinished('the first two are garden supplies, and the', { flagged: true })).toBe(true);
    // A reply riding along with new work still honours the flag.
    expect(looksUnfinished('yes, go with the blue one and ask Victor to look at the build when he gets', { flagged: true, dispatch: false, newWork: true })).toBe(true);
  });

  it('router schema and parsing carry draft actions', () => {
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'draft', draft_op: 'start', agent_id: 'sierra' }] }))).toEqual([{ type: 'draft', op: 'start', agentId: 'sierra' }]);
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'draft', draft_op: 'start', agent_id: '', message: ' the deploy is blocked ' }] }))).toEqual([{ type: 'draft', op: 'start', message: 'the deploy is blocked' }]);
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'draft', draft_op: 'finish', message: 'and bring the drill' }] }))).toEqual([{ type: 'draft', op: 'finish', message: 'and bring the drill' }]);
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'draft', draft_op: 'unfinished', message: 'x' }] }))).toEqual([{ type: 'draft', op: 'unfinished' }]);
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'draft', draft_op: 'bogus' }] }))[0].type).toBe('none');
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'x' });
    expect(prompt).toContain('draft_op start');
    expect(prompt).toContain('draft_op unfinished');
  });

  it('compile output parsing', () => {
    expect(parseDraftCompileOutput(JSON.stringify({ message: ' Hi. ', agent_id: 'sierra', item: '', thread_id: '', new_thread_title: 'Trip', questions: [' ', 'Which day?'] }))).toEqual({
      message: 'Hi.',
      agentId: 'sierra',
      item: null,
      threadId: null,
      newThreadTitle: 'Trip',
      questions: ['Which day?'],
    });
  });
});

describe('HttpDeskClient local posts carry the collaboration token (PR review)', () => {
  let server: Server;
  let base = '';
  const seen: Array<{ url: string; token: string | undefined }> = [];
  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url ?? '', token: req.headers['x-tango-collaboration-token'] as string | undefined });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('Draft card, operator status and trace all send X-Tango-Collaboration-Token', async () => {
    const client = new HttpDeskClient(base, { collaborationToken: 'test-token', traceFlushMs: 10 });
    client.publishDraft({ active: true, target: null, fragments: [], compiled: null, question: null, note: null, status: 'listening', updatedAt: 1 });
    client.publishOperator({ live: true, status: 'listening', agentName: null });
    client.trace({ kind: 'draft.start', summary: 'x' });
    await client.flushTrace();
    for (let i = 0; i < 50 && seen.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.map((entry) => entry.url).sort()).toEqual(['/api/desk/draft', '/api/desk/operator', '/api/desk/trace']);
    expect(seen.every((entry) => entry.token === 'test-token')).toBe(true);
  });

  it('the operator desk stream carries the token too (PR review 2)', async () => {
    const client = new HttpDeskClient(base, { collaborationToken: 'test-token' });
    client.connect(() => {});
    for (let i = 0; i < 50 && !seen.some((entry) => entry.url.startsWith('/api/desk/stream')); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    client.disconnect();
    expect(seen.find((entry) => entry.url.startsWith('/api/desk/stream'))).toEqual({ url: '/api/desk/stream?client=operator', token: 'test-token' });
  });

  it('defaults to TANGO_COLLABORATION_BRIDGE_TOKEN', async () => {
    const saved = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN;
    process.env.TANGO_COLLABORATION_BRIDGE_TOKEN = 'env-token';
    try {
      new HttpDeskClient(base).publishDraft({ active: false, target: null, fragments: [], compiled: null, question: null, note: null, status: 'listening', updatedAt: 1 });
      for (let i = 0; i < 50 && seen.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen[0]).toEqual({ url: '/api/desk/draft', token: 'env-token' });
    } finally {
      if (saved === undefined) delete process.env.TANGO_COLLABORATION_BRIDGE_TOKEN;
      else process.env.TANGO_COLLABORATION_BRIDGE_TOKEN = saved;
    }
  });
});

describe('where does it go? (destination-ask)', () => {
  const DOCK = '1550000000000000011';
  const TRAILER = '1550000000000000012';
  const threads: ThreadDirectory = {
    list: async () => [
      { id: DOCK, title: 'Dock lines', agentId: 'sierra', lastActiveAt: Date.now() },
      { id: TRAILER, title: 'Trailer lights', agentId: 'sierra', lastActiveAt: Date.now() },
      { id: '1550000000000000013', title: 'Uploader', agentId: 'victor', lastActiveAt: Date.now() },
    ],
    create: async (agentId, title) => ({ id: '1550000000000000019', title, agentId, lastActiveAt: Date.now() }),
  };
  const unplaced = (options: string[]): OperatorAction[] => [{ type: 'dispatch', agentId: 'sierra', message: 'Find the boat registration number.', threadOptions: options }];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('answers: main, a thread by its title, ordinals, cancel, and anything else is unclear', () => {
    const one = [{ threadId: DOCK, title: 'Dock lines' }];
    const two = [...one, { threadId: TRAILER, title: 'Trailer lights' }];
    expect(matchDestinationAnswer('main chat', one)).toEqual({ kind: 'main' });
    expect(matchDestinationAnswer('just the main one', two)).toEqual({ kind: 'main' });
    expect(matchDestinationAnswer('the dock lines thread', two)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(matchDestinationAnswer('trailer', two)).toEqual({ kind: 'thread', threadId: TRAILER });
    expect(matchDestinationAnswer('the thread', one)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(matchDestinationAnswer('the thread', two)).toEqual({ kind: 'unclear' });
    expect(matchDestinationAnswer('the last one', two)).toEqual({ kind: 'thread', threadId: TRAILER });
    expect(matchDestinationAnswer('the first thread', two)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(matchDestinationAnswer('the second thread', two)).toEqual({ kind: 'thread', threadId: TRAILER });
    expect(matchDestinationAnswer('the first one', two)).toEqual({ kind: 'main' });
    expect(matchDestinationAnswer('never mind', two)).toEqual({ kind: 'cancel' });
    expect(matchDestinationAnswer('also tell Malibu I had eggs for breakfast this morning ok', one)).toEqual({ kind: 'unclear' });
    // A short new request that mentions a chat or a title word is not an answer.
    expect(matchDestinationAnswer('tell Victor to check the chat logs', two)).toEqual({ kind: 'unclear' });
    expect(matchDestinationAnswer('can you show the trailer', two)).toEqual({ kind: 'unclear' });
    expect(matchDestinationAnswer('open the trailer doc', two)).toEqual({ kind: 'unclear' });
    expect(matchDestinationAnswer('post the dock lines update', two)).toEqual({ kind: 'unclear' });
    expect(matchDestinationAnswer('can you cancel that', two)).toEqual({ kind: 'cancel' });
    expect(matchDestinationAnswer('cancel that and tell Victor', two)).toEqual({ kind: 'unclear' });
    expect(matchDestinationAnswer('not the dock lines thread, main chat', two)).toEqual({ kind: 'main' });
    const chatty = [{ threadId: DOCK, title: 'Chat logs' }];
    expect(matchDestinationAnswer('the chat logs thread', chatty)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(matchDestinationAnswer('main chat', chatty)).toEqual({ kind: 'main' });
    const bare = [{ threadId: DOCK, title: 'Chat' }];
    expect(matchDestinationAnswer('the chat thread', bare)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(matchDestinationAnswer('main chat', bare)).toEqual({ kind: 'main' });
    expect(matchDestinationAnswer('actually can you just cancel that request please', two)).toEqual({ kind: 'cancel' });
    expect(matchDestinationAnswer('can you put it in the dock thread', two)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(matchDestinationAnswer('I meant the main chat', two)).toEqual({ kind: 'main' });
    expect(matchDestinationAnswer('yeah put it in the dock lines thread', two)).toEqual({ kind: 'thread', threadId: DOCK });
    expect(destinationQuestion('Sierra', two)).toBe("Sierra's main chat, or the Dock lines thread, or the Trailer lights thread?");
  });

  it('holds the request, asks, and sends it to the thread named in the answer', async () => {
    const rig = setup({ actions: [unplaced([DOCK])], extra: { threads } });
    await say(rig, 'd1', 'ask Sierra to find the boat registration number');
    expect(rig.backend.sends).toHaveLength(0);
    expect(commentary(rig).at(-1)).toContain("Sierra's main chat, or the Dock lines thread?");
    expect(traced(rig, 'destination.ask')).toHaveLength(1);
    await say(rig, 'd2', 'the dock lines one');
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request).toMatchObject({ agentId: 'sierra', channelId: DOCK });
    expect(rig.routed).toHaveLength(1);
  });

  it.each([false, true])('a retired connection cannot leave a destination question for its replacement (unfinished=%s)', async (unfinished) => {
    const destination = new DestinationAsk({ now: Date.now });
    const rows = await threads.list();
    let release!: (value: typeof rows) => void;
    const lookup = new Promise<typeof rows>((resolve) => { release = resolve; });
    const list = vi.fn().mockResolvedValueOnce(rows).mockReturnValue(lookup);
    const actions: OperatorAction[] = [...unplaced([DOCK]), ...(unfinished ? [{ type: 'draft', op: 'unfinished' } as const] : [])];
    const first = setup({ actions: [actions], extra: { threads: { ...threads, list }, destination } });
    await say(first, 'd1', `ask Sierra to find the boat registration number${unfinished ? ' and' : ''}`);
    if (unfinished) await say(first, 'confirm', 'yes');
    expect(list).toHaveBeenCalledTimes(2);
    first.operator.stop();
    const second = setup({ extra: { threads, destination } });
    release(rows);
    await vi.advanceTimersByTimeAsync(600);
    expect(destination.held).toBeNull();
    expect(traced(first, 'destination.ask')).toHaveLength(0);
    await say(second, 'd2', 'main chat');
    expect(first.backend.sends).toHaveLength(0);
    expect(second.backend.sends).toHaveLength(0);
    second.operator.stop();
  });

  it('"main chat" sends it to the main channel', async () => {
    const rig = setup({ actions: [unplaced([DOCK, TRAILER])], extra: { threads } });
    await say(rig, 'd1', 'ask Sierra to find the boat registration number');
    await say(rig, 'd2', 'main chat');
    expect(rig.backend.sends[0].request).toMatchObject({ agentId: 'sierra' });
    expect(rig.backend.sends[0].request.channelId).toBeUndefined();
  });

  it('something else: the request goes to the main channel and the new words are routed', async () => {
    const rig = setup({ actions: [unplaced([DOCK]), [{ type: 'dispatch', agentId: 'malibu', message: 'The user had eggs.' }]], extra: { threads } });
    await say(rig, 'd1', 'ask Sierra to find the boat registration number');
    await say(rig, 'd2', 'and tell Malibu I had eggs for breakfast this morning');
    expect(rig.backend.sends.map((send) => [send.request.agentId, send.request.channelId])).toEqual([['sierra', undefined], ['malibu', undefined]]);
    expect(traced(rig, 'destination.unclear')).toHaveLength(1);
  });

  it('never mind drops it; options that are not that agent\'s live threads are ignored', async () => {
    const dropped = setup({ actions: [unplaced([DOCK])], extra: { threads } });
    await say(dropped, 'd1', 'ask Sierra to find the boat registration number');
    await say(dropped, 'd2', 'never mind');
    expect(dropped.backend.sends).toHaveLength(0);
    const stale = setup({ actions: [unplaced(['1550000000000000013', '1550000000000000099'])], extra: { threads } });
    await say(stale, 'd1', 'ask Sierra to find the boat registration number');
    expect(stale.backend.sends[0].request).toMatchObject({ agentId: 'sierra' });
    expect(stale.backend.sends[0].request.channelId).toBeUndefined();
    expect(traced(stale, 'destination.ask')).toHaveLength(0);
  });

  it('an unanswered question expires on its own: the request is not sent and later words route normally', async () => {
    const rig = setup({ actions: [unplaced([DOCK]), [{ type: 'dispatch', agentId: 'victor', message: 'Check the chat logs.' }]], extra: { threads } });
    await say(rig, 'd1', 'ask Sierra to find the boat registration number');
    await vi.advanceTimersByTimeAsync(125_000);
    expect(traced(rig, 'destination.expired')).toHaveLength(1);
    await say(rig, 'd2', 'main chat, tell Victor to check the chat logs');
    expect(rig.backend.sends.map((send) => send.request.agentId)).toEqual(['victor']);
  });

  it('"Is that everything?" → yes still asks where it goes', async () => {
    const rig = setup({ actions: [[...unplaced([DOCK]), { type: 'draft', op: 'unfinished' }]], extra: { threads } });
    await say(rig, 'd1', 'ask Sierra to find the boat registration number and');
    expect(traced(rig, 'safety.hold')).toHaveLength(1);
    await say(rig, 'd2', 'yes');
    expect(rig.backend.sends).toHaveLength(0);
    expect(traced(rig, 'destination.ask')).toHaveLength(1);
    await say(rig, 'd3', 'the dock lines thread');
    expect(rig.backend.sends[0].request).toMatchObject({ channelId: DOCK });
  });

  it('a pause keeps the question alive', async () => {
    const rig = setup({ actions: [unplaced([DOCK])], extra: { threads } });
    await say(rig, 'd1', 'ask Sierra to find the boat registration number');
    await say(rig, 'd2', 'Tango, pause');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(traced(rig, 'destination.expired')).toHaveLength(0);
  });

  it('parses thread_options only when no thread was picked', () => {
    const base = { agent_id: 'sierra', message: 'x', thread_id: '', new_thread_title: '' };
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'dispatch', ...base, thread_options: [DOCK, TRAILER, '1'] }] }))[0]).toMatchObject({ threadOptions: [DOCK, TRAILER] });
    expect(parseExtractorOutput(JSON.stringify({ actions: [{ type: 'dispatch', ...base, thread_id: DOCK, thread_options: [TRAILER] }] }))[0]).not.toHaveProperty('threadOptions');
  });
});

describe('a named Loom thread wins over the router\'s agent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('the request is a reply on the Loom item, and nothing goes to the agent', async () => {
    const board = new FakeDesk([deskItem('loom:aaa', 'loom', { place: 'harbor · epic: Field Survey Tools' }), deskItem('discord:chapter:vic', 'victor', { nextStep: 'fyi' })]);
    const rig = setup({ desk: board, actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Why did no alert go out?' }]] });
    await say(rig, 'd1', 'ask the Loom field survey tools thread why no alert went out');
    expect(rig.backend.sends).toHaveLength(0);
    expect(board.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:aaa' })]);
    expect(traced(rig, 'routed.loom-named')).toHaveLength(1);
  });
});

// ── TGO-942: pick a conversation and talk; fewer confirmations ─────────────

describe('workbench flow: picking a conversation starts a draft for it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const PROMO = '1550000000000000011';
  const STEREO_A = '1550000000000000012';
  const STEREO_B = '1550000000000000013';
  /** Synthetic desk: a thread with a punctuated title, one with an `about`, two that tie on "speaker", a Loom thread. */
  const workDesk = () =>
    new FakeDesk([
      deskItem(`discord:thread:${PROMO}`, 'sierra', { threadId: PROMO, place: 'disc: News-Letter Promotion Strategies', nextStep: 'your_move' }),
      deskItem(`discord:thread:${THREAD}`, 'sierra', { threadId: THREAD, place: 'Shed vents', nextStep: 'watching' }),
      deskItem('discord:chapter:vic', 'victor', { nextStep: 'fyi', summary: { gist: 'build status', about: 'Nightly build flakiness' } }),
      deskItem(`discord:thread:${STEREO_A}`, 'sierra', { threadId: STEREO_A, place: 'Speaker install', nextStep: 'fyi' }),
      deskItem(`discord:thread:${STEREO_B}`, 'victor', { threadId: STEREO_B, place: 'Speaker wiring', nextStep: 'fyi' }),
      deskItem('loom:harbor', 'loom', { place: 'demo · Lantern Row', nextStep: 'fyi' }),
    ]);
  const refsOf = (deskClient: FakeDesk): DraftItemRef[] =>
    deskClient.list.map((item) => ({ id: item.id, agentId: item.agentId, agentName: item.agentName, place: item.place, threadId: item.threadId, isAgent: item.agentId !== 'loom', about: item.summary?.about ?? null }));
  const PROMO_ID = `discord:thread:${PROMO}`;
  const VENTS_ID = `discord:thread:${THREAD}`;

  describe('fuzzy matching (matchDeskItem is the one matcher)', () => {
    const items = refsOf(workDesk());
    it('ignores case, punctuation, hyphens and plurals across title, place and about', () => {
      for (const phrase of ['news-letter', 'news letter promotion', 'News Letter Promotions', 'promotion strategy', 'NEWS-LETTER PROMOTION STRATEGIES']) {
        expect(matchDeskItem(phrase, items), phrase).toMatchObject({ kind: 'match', item: { id: PROMO_ID } });
      }
      expect(matchDeskItem('the shed vent', items)).toMatchObject({ kind: 'match', item: { id: VENTS_ID } });
      // `about` counts: Victor's chapter has no place.
      expect(matchDeskItem('nightly builds', items)).toMatchObject({ kind: 'match', item: { id: 'discord:chapter:vic' } });
      expect(matchDeskItem('lantern row', items)).toMatchObject({ kind: 'match', item: { id: 'loom:harbor' } });
    });
    it('a real tie is a tie; nothing close is none; an agent name alone picks nothing', () => {
      expect(matchDeskItem('speaker', items)).toMatchObject({ kind: 'tie', items: [{ id: `discord:thread:${STEREO_A}` }, { id: `discord:thread:${STEREO_B}` }] });
      expect(matchDeskItem('speaker wiring', items)).toMatchObject({ kind: 'match', item: { id: `discord:thread:${STEREO_B}` } });
      expect(matchDeskItem('grocery list', items)).toEqual({ kind: 'none' });
      expect(matchDeskItem('Sierra', items)).toEqual({ kind: 'none' });
      expect(pickLabels(items[3]!, items[4]!)).toEqual(['Speaker install', 'Speaker wiring']);
    });
    it('topic picks: the verbs, and a bare "okay X" only when X names one item outright', () => {
      for (const phrase of ["let's talk about news-letter promotion", 'Okay, news-letter promotion', 'okay news letter promotion', 'pull up the shed vents thread', 'open shed vents', "let's work on the nightly build", "let's do lantern row", 'Alright, shed vents.']) {
        expect(matchTopicPick(phrase, items), phrase).toMatchObject({ kind: 'match' });
      }
      for (const phrase of ['okay send it', 'okay sounds good', 'okay, thanks', 'go back to the board', 'open the screen', "let's talk about dinner", 'okay so the shed vents are loud and we need a quieter fan', 'the news letter promotion is going well']) {
        expect(matchTopicPick(phrase, items), phrase).toBeNull();
      }
      // While drafting, only the explicit verbs switch: dictation that opens with "okay" stays dictation.
      expect(matchTopicPick('okay shed vents', items, { drafting: true })).toBeNull();
      expect(matchTopicPick("let's talk about shed vents", items, { drafting: true })).toMatchObject({ kind: 'match', item: { id: VENTS_ID } });
      expect(matchTopicPick("let's talk about the speaker", items)).toMatchObject({ kind: 'tie' });
    });
    it('the answer to "which one?": an ordinal or its words', () => {
      const pair: [DraftItemRef, DraftItemRef] = [items[3]!, items[4]!];
      expect(choosePick('the wiring one', pair)?.id).toBe(`discord:thread:${STEREO_B}`);
      expect(choosePick('install', pair)?.id).toBe(`discord:thread:${STEREO_A}`);
      expect(choosePick('the second one', pair)?.id).toBe(`discord:thread:${STEREO_B}`);
      expect(choosePick('what time is it', pair)).toBeNull();
    });
    it('a start phrase names a conversation loosely too', () => {
      expect(matchDraftStart('help me draft a reply to the shed vent thread, the left one rattles', AGENTS, items)).toMatchObject({ item: { id: VENTS_ID }, rest: 'the left one rattles' });
      expect(matchDraftStart('could you draft a message for the Speaker Wirings thread', AGENTS, items)).toMatchObject({ item: { id: `discord:thread:${STEREO_B}` } });
    });
  });

  it('"Okay, news-letter promotion" opens it and starts an empty draft for it, with no router call', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'Okay, news-letter promotion.');
    expect(rig.routed).toHaveLength(0);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'listening', fragments: [], target: { agentId: 'sierra', itemId: PROMO_ID, label: 'Sierra · disc: News-Letter Promotion Strategies' } });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: PROMO_ID, reason: 'user' });
    expect(instructions(rig)).toContain(DRAFT_ON_INSTRUCTIONS);
    expect(traced(rig, 'draft.pick')).toHaveLength(1);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('a tie asks once, "The X one or the Y one?", and the answer picks', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', "let's talk about the speaker");
    expect(rig.draft.active).toBe(false);
    expect(commentary(rig).at(-1)).toContain('"The Speaker install one or the Speaker wiring one?"');
    await say(rig, 'd2', 'the wiring one');
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ agentId: 'victor', itemId: `discord:thread:${STEREO_B}` });
    expect(rig.routed).toHaveLength(0);
  });

  it("a pick the fast path can't read goes to the router, whose draft start opens it", async () => {
    const rig = setup({ desk: workDesk(), actions: [[{ type: 'draft', op: 'start', item: 'i2' }]] });
    await say(rig, 'd1', "let's get into Sierra's car noise thing");
    expect(rig.routed).toHaveLength(1);
    const prompt = buildExtractorPrompt(rig.routed[0]!);
    expect(prompt).toMatch(/Picking a conversation to work on is draft start/);
    expect(prompt).toContain('(about: Nightly build flakiness)');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: VENTS_ID });
  });

  it('"I\'m done" on a picked conversation: no confirmation, sending with undoUntil, sent after 3 s, "Sent."', async () => {
    const rig = setup({ desk: workDesk(), compile: (input) => compiled('Lead with the bundle offer.', { agentId: 'sierra', item: input.targetItem?.handle ?? null }) });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    await say(rig, 'd3', "I'm done.");
    expect(rig.compiles[0].targetItem).toMatchObject({ handle: 'i1' });
    expect(buildDraftCompilePrompt({ ...rig.compiles[0]!, fragments: ['x'] })).toContain('never ask where it goes');
    expect(rig.desk.draft).toMatchObject({ status: 'sending', compiled: 'Lead with the bundle offer.', target: { itemId: PROMO_ID } });
    const undoUntil = rig.desk.draft?.undoUntil ?? 0;
    expect(undoUntil - Date.now()).toBeGreaterThan(2000);
    expect(undoUntil - Date.now()).toBeLessThanOrEqual(3000);
    expect(commentary(rig).some((text) => text.includes('Send that to'))).toBe(false);
    await vi.advanceTimersByTimeAsync(undoUntil - Date.now() - 200);
    expect(rig.backend.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request).toMatchObject({ agentId: 'sierra', channelId: PROMO, message: 'Lead with the bundle offer.' });
    expect(rig.desk.draft).toMatchObject({ status: 'sent', active: false });
    expect(instructions(rig).some((text) => text.includes('Say only "Sent."'))).toBe(true);
    // Back to Active (the existing send path).
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
  });

  it('the undo window is three seconds from "I\'m done", compile time included, and never under three', async () => {
    const slow = (ms: number) => (input: Parameters<NonNullable<Parameters<typeof setup>[0]['compile']>>[0]) => {
      vi.setSystemTime(Date.now() + ms);
      return compiled('Lead with the bundle offer.', { agentId: 'sierra', item: input.targetItem?.handle ?? null });
    };
    const rig = setup({ desk: workDesk(), compile: slow(3000) });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    const doneAt = Date.now();
    await say(rig, 'd3', "I'm done.");
    const undoUntil = rig.desk.draft?.undoUntil ?? 0;
    expect(undoUntil - doneAt).toBeGreaterThanOrEqual(5900);
    expect(undoUntil - doneAt).toBeLessThanOrEqual(6700);

    const slower = setup({ desk: workDesk(), compile: slow(4600) });
    await say(slower, 'd1', 'okay news letter promotion');
    await say(slower, 'd2', 'I think we lead with the bundle offer');
    await say(slower, 'd3', "I'm done.");
    expect((slower.desk.draft?.undoUntil ?? 0) - Date.now()).toBeGreaterThanOrEqual(2300);
  });

  it('"go ahead and send it" finishes on the spot: no router call, and the closer is not part of the message', async () => {
    const rig = setup({ desk: workDesk(), compile: (input) => compiled('Lead with the bundle offer.', { agentId: 'sierra', item: input.targetItem?.handle ?? null }) });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    const routed = rig.routed.length;
    await say(rig, 'd3', 'Go ahead and send it');
    expect(rig.routed.length).toBe(routed);
    expect(rig.compiles.at(-1)!.fragments).toEqual(['I think we lead with the bundle offer']);
    expect(rig.desk.draft?.status).toBe('sending');
  });

  it('scroll commands work while drafting, addressed or not; a sentence about scrolling stays dictation', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    await say(rig, 'd3', 'Yankee, scroll up.');
    await say(rig, 'd4', 'scroll down');
    await say(rig, 'd5', 'go to the top');
    expect(rig.screen.commands).toEqual(['scroll_up', 'scroll_down', 'scroll_top']);
    expect(traced(rig, 'draft.aside')).toHaveLength(0);
    await say(rig, 'd6', 'players should not have to scroll down to find it');
    expect(rig.screen.commands).toHaveLength(3);
    expect(rig.desk.draft?.fragments).toEqual(['I think we lead with the bundle offer', 'players should not have to scroll down to find it']);
  });

  it('a Loom conversation picked by voice: the reply goes out after the undo window with "Sent."', async () => {
    const rig = setup({ desk: workDesk(), compile: () => compiled('Ship it behind a flag.', { agentId: null }) });
    await say(rig, 'd1', "let's work on lantern row");
    await say(rig, 'd2', 'ship it behind a flag');
    await say(rig, 'd3', 'okay send it');
    expect(rig.desk.draft?.status).toBe('sending');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.desk.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:harbor', args: { text: 'Ship it behind a flag.' } })]);
    expect(commentary(rig).some((text) => text.includes('Say only "Sent."'))).toBe(true);
  });

  it('a Cancel tap during the undo window stops the send; the draft is back to listening, every word kept', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one still rattles');
    await say(rig, 'd3', "that's it, send it");
    expect(rig.desk.draft?.status).toBe('sending');
    rig.desk.draftHandler?.({ action: 'cancel', commandId: 'c1', draftId: rig.desk.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft).toMatchObject({ status: 'listening', fragments: ['the left one still rattles'], compiled: null, undoUntil: null });
    expect(traced(rig, 'draft.undo')).toHaveLength(1);
    // Keep editing, then finish again: it goes this time.
    await say(rig, 'd4', 'and the right one squeaks');
    await say(rig, 'd5', "I'm done");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.message).toContain('right one squeaks');
  });

  it('"wait" / "undo" by voice during the undo window stops the send too', async () => {
    for (const word of ['wait', 'undo', 'Yankee, undo that']) {
      const rig = setup({ desk: workDesk() });
      await say(rig, 'd1', 'okay shed vents');
      await say(rig, 'd2', 'the left one still rattles');
      rig.client.ask('d3', "I'm done");
      await vi.advanceTimersByTimeAsync(600);
      expect(rig.desk.draft?.status, word).toBe('sending');
      rig.client.ask('d4', word);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rig.backend.sends, word).toHaveLength(0);
      expect(rig.desk.draft, word).toMatchObject({ status: 'listening', fragments: ['the left one still rattles'] });
      rig.operator.stop();
    }
    expect(isUndo("don't send it")).toBe(true);
    expect(isUndo('wait until Friday to book it')).toBe(false);
  });

  it('a known conversation never asks "Is that everything?", "main chat or thread?", or "keep holding?"', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'pull up news letter promotion');
    await say(rig, 'd2', 'we should also try the, um,');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(commentary(rig).some((text) => text.includes('keep holding'))).toBe(false);
    await say(rig, 'd3', "I'm done");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(commentary(rig).some((text) => /Is that everything|main chat|Send that to/.test(text))).toBe(false);
    for (const kind of ['safety.hold', 'destination.ask', 'draft.check', 'draft.confirm']) expect(traced(rig, kind), kind).toHaveLength(0);
  });

  it('a compile that moves it elsewhere still confirms', async () => {
    const rig = setup({ desk: workDesk(), compile: () => compiled('Check the wiring.', { agentId: 'victor' }) });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'check the wiring');
    await say(rig, 'd3', "I'm done");
    expect(rig.desk.draft?.status).toBe('confirm');
    expect(commentary(rig).at(-1)).toContain('Send that to Victor?');
  });

  it('tapping a card while voice is live arms an empty draft for it, with a spoken refresher', async () => {
    const rig = setup({ desk: workDesk() });
    const before = commentary(rig).length;
    rig.desk.tap(VENTS_ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft).toMatchObject({ status: 'listening', fragments: [], target: { itemId: VENTS_ID } });
    expect(instructions(rig)).toContain(DRAFT_ON_INSTRUCTIONS);
    // A short refresher of the conversation it opened, then "Go ahead."
    expect(commentary(rig).slice(before)).toHaveLength(1);
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher[\s\S]*Where it stands:[\s\S]*"Go ahead\."/);
    expect(commentary(rig).at(-1)).toMatch(/Start straight with a quick spoken refresher \(no "go ahead" or "I'm listening" before it\)/);
    expect(traced(rig, 'draft.brief')).toHaveLength(1);
    expect(rig.screen.intents).toHaveLength(0); // the desk already shows it
    expect(traced(rig, 'draft.arm')).toHaveLength(1);
    // The director's own moves arm nothing.
    rig.desk.tap(PROMO_ID, { by: 'director', reason: 'user' });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    // What they say next is dictation for it.
    await say(rig, 'd1', 'the left one still rattles at speed');
    expect(rig.desk.draft?.fragments).toEqual(['the left one still rattles at speed']);
  });

  it('a conversation picked by voice gets a refresher of where it stands; "read it all" reads the latest reply in full, adding nothing', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay news letter promotion');
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher/);
    await say(rig, 'd2', 'Yankee, read it all');
    expect(traced(rig, 'draft.read')).toHaveLength(1);
    expect(commentary(rig).at(-1)).toMatch(/Read the latest reply in this conversation aloud|no reply to read/);
    await say(rig, 'd3', 'read it to me again');
    expect(traced(rig, 'draft.read')).toHaveLength(2);
    expect(rig.desk.draft?.fragments).toEqual([]);
    await say(rig, 'd4', 'we should read it all before deciding');
    expect(rig.desk.draft?.fragments).toEqual(['we should read it all before deciding']);
  });

  it('a draft phrase naming a conversation gets the refresher too (Codex review on #433)', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'could you draft a message for the Speaker Wirings thread');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: `discord:thread:${STEREO_B}` });
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher/);
  });

  it('a slow desk: leaving during "read it all" reads nothing, and talking before the refresher arrives skips it (Codex review 2 on #433)', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay news letter promotion');
    rig.desk.itemDelayMs = 3000;
    rig.client.ask('d2', 'read it all');
    await vi.advanceTimersByTimeAsync(600);
    rig.desk.tap(PROMO_ID, { view: 'active', itemId: null, conversationKey: null, since: Date.now() + 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(traced(rig, 'draft.read')).toHaveLength(0);
    expect(commentary(rig).some((text) => text.includes('Read the latest reply'))).toBe(false);

    // A tap with a slow desk, then dictation before the refresher comes back: no refresher.
    const before = commentary(rig).length;
    rig.desk.tap(VENTS_ID, { since: Date.now() + 2 });
    await vi.advanceTimersByTimeAsync(50);
    await say(rig, 'd3', 'the left one still rattles at speed');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.desk.draft?.fragments).toEqual(['the left one still rattles at speed']);
    expect(commentary(rig).slice(before).some((text) => text.includes('quick spoken refresher'))).toBe(false);
  });

  it('"open the screen" while drafting shows it instead of becoming dictation; a sentence about a prototype stays dictation', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'open the screen');
    await say(rig, 'd3', 'Yankee, pull up the mockup');
    expect(rig.desk.draft?.fragments).toEqual([]);
    expect(traced(rig, 'draft.meta').filter((entry) => entry.summary.includes('screen command while drafting'))).toHaveLength(2);
    await say(rig, 'd4', 'we should open the prototype to everyone next week');
    expect(rig.desk.draft?.fragments).toEqual(['we should open the prototype to everyone next week']);
  });

  it('opening an item\'s screen arms a draft for it, with the refresher, like its conversation', async () => {
    const rig = setup({ desk: workDesk() });
    rig.desk.tap(VENTS_ID, { view: 'screen', sceneId: 'vents-photos' });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher/);
    expect(rig.screen.intents).toHaveLength(0); // the screen stays up
  });

  it('a screen an answer brings up mid-exchange arms a quiet draft; with no recent exchange it arms nothing', async () => {
    const rig = setup({ desk: workDesk(), compile: (input) => compiled('Lead with the bundle offer.', { agentId: 'sierra', item: input.targetItem?.handle ?? null }) });
    // Not talking to Vents lately: its screen coming up arms nothing.
    rig.desk.tap(VENTS_ID, { view: 'screen', sceneId: 'vents-photos', by: 'director', reason: 'auto', since: Date.now() + 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);
    // A reply to News-Letter Promotion goes out…
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    await say(rig, 'd3', "I'm done.");
    await vi.advanceTimersByTimeAsync(5500);
    expect(rig.draft.active).toBe(false);
    const before = commentary(rig).length;
    // …and its answer brings its screen: a quiet draft for it.
    rig.desk.tap(PROMO_ID, { view: 'screen', sceneId: 'promo-mock', by: 'director', reason: 'auto', since: Date.now() + 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: PROMO_ID });
    expect(commentary(rig).slice(before).some((text) => text.includes('quick spoken refresher'))).toBe(false);
    expect(rig.screen.intents.at(-1)?.view).not.toBe('conversation');
    await say(rig, 'd4', 'yes and add the annual plan');
    expect(rig.desk.draft?.fragments).toEqual(['yes and add the annual plan']);
  });

  it('filler said around a screen that armed a quiet draft keeps it quiet: the agent\'s answer is not held', async () => {
    const rig = setup({ desk: workDesk(), compile: (input) => compiled('Lead with the bundle offer.', { agentId: 'sierra', item: input.targetItem?.handle ?? null }) });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    await say(rig, 'd3', "I'm done.");
    await vi.advanceTimersByTimeAsync(5500);
    rig.desk.tap(PROMO_ID, { view: 'screen', sceneId: 'promo-mock', by: 'director', reason: 'auto', since: Date.now() + 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.draft.holdsUpdates).toBe(false);
    await say(rig, 'd4', 'Hmm Mm-hmm');
    expect(rig.desk.draft?.fragments).toEqual([]);
    expect(rig.draft.holdsUpdates).toBe(false);
  });

  it('"open the screen" by voice arms a draft for its conversation, with the refresher (Codex review on #438)', async () => {
    const rig = setup({ desk: workDesk() });
    const vents = rig.desk.list.find((item) => item.id === VENTS_ID)!;
    rig.screen.presented = { view: 'conversation', itemId: VENTS_ID, conversationKey: vents.conversationKey, sceneId: null, reason: 'user' } as never;
    await say(rig, 'd1', 'open the screen');
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    expect(commentary(rig).some((text) => text.includes('quick spoken refresher'))).toBe(true);
  });

  it('a discarded quiet draft is not re-armed by a re-broadcast of the same screen (Codex review on #438)', async () => {
    const rig = setup({ desk: workDesk(), compile: (input) => compiled('Lead with the bundle offer.', { agentId: 'sierra', item: input.targetItem?.handle ?? null }) });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'I think we lead with the bundle offer');
    await say(rig, 'd3', "I'm done.");
    await vi.advanceTimersByTimeAsync(5500);
    const since = Date.now() + 5;
    rig.desk.tap(PROMO_ID, { view: 'screen', sceneId: 'promo-mock', by: 'director', reason: 'auto', since });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    rig.desk.draftHandler?.({ action: 'cancel', commandId: 'c9', draftId: rig.desk.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.draft.active).toBe(false);
    rig.desk.tap(PROMO_ID, { view: 'screen', sceneId: 'promo-mock', by: 'director', reason: 'auto', since });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);
  });

  it('an update from the conversation held while the owner drafted a reply to it is dropped after the send, not played', async () => {
    const rig = setup({ desk: workDesk(), compile: (input) => compiled('Go with the public host.', { agentId: 'sierra', item: input.targetItem?.handle ?? null }) });
    await say(rig, 'd1', 'okay news letter promotion');
    await say(rig, 'd2', 'go with the public host');
    // The thread's earlier question arrives while the owner is mid-draft: held.
    const operator = rig.operator as unknown as { queue: unknown[]; pump(): Promise<void> };
    operator.queue.push({ kind: 'result', agent: { id: 'sierra', name: 'Sierra', role: '' }, update: { kind: 'question', text: 'Which host should we publish it on?' }, delegationId: null, arrivedAt: Date.now(), attempts: 0, deskItemIds: [PROMO_ID] });
    // A failure from the same item, and a question from another item, still play.
    operator.queue.push({ kind: 'result', agent: { id: 'sierra', name: 'Sierra', role: '' }, update: { kind: 'result', text: 'The upload step failed; offer to retry it.' }, delegationId: null, arrivedAt: Date.now(), attempts: 0, deskItemIds: [PROMO_ID] });
    operator.queue.push({ kind: 'result', agent: { id: 'victor', name: 'Victor', role: '' }, update: { kind: 'question', text: 'Merge the hotfix now?' }, delegationId: null, arrivedAt: Date.now(), attempts: 0, deskItemIds: [VENTS_ID] });
    await say(rig, 'd3', "I'm done.");
    await vi.advanceTimersByTimeAsync(8000);
    expect(rig.desk.sent('reply').length + rig.backend.sends.length).toBeGreaterThan(0);
    expect(commentary(rig).some((text) => text.includes('Which host should we publish it on?'))).toBe(false);
    expect(traced(rig, 'speech.superseded')).toHaveLength(1);
    expect(operator.queue.length + commentary(rig).filter((text) => text.includes('upload step failed') || text.includes('Merge the hotfix')).length).toBeGreaterThanOrEqual(2);
    expect(rig.desk.sent('heard').filter((command) => command.itemId === PROMO_ID)).toEqual([]);
  });

  it('a tap arms nothing when the voice operator is not live, or is paused', async () => {
    const rig = setup({ desk: workDesk() });
    rig.operator.stop();
    rig.desk.tap(VENTS_ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);

    const paused = setup({ desk: workDesk() });
    await say(paused, 'd1', 'Yankee, pause.');
    paused.desk.tap(VENTS_ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(paused.draft.active).toBe(false);
  });

  it('"back to the board" parks the draft and shows Active; reopening it (voice or tap) resumes the words', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay news-letter promotion');
    await say(rig, 'd2', 'lead with the bundle offer');
    await say(rig, 'd3', 'back to the board');
    expect(rig.draft.active).toBe(false);
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
    expect(rig.desk.draft).toMatchObject({ active: false, fragments: [] });
    expect(traced(rig, 'draft.park')).toHaveLength(1);
    expect(rig.backend.sends).toHaveLength(0);

    await say(rig, 'd4', "let's talk about news letter promotion");
    expect(rig.desk.draft).toMatchObject({ active: true, status: 'listening', fragments: ['lead with the bundle offer'], target: { itemId: PROMO_ID } });
    expect(commentary(rig).at(-1)).toContain('Picking up where you left off');

    // Parked again, then a tap brings it back.
    await say(rig, 'd5', 'and mention the referral credit');
    await say(rig, 'd6', 'go back to the board');
    expect(rig.draft.active).toBe(false);
    rig.desk.tap(PROMO_ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.desk.draft?.fragments).toEqual(['lead with the bundle offer', 'and mention the referral credit']);
  });

  it('picking another conversation mid-draft parks this one and starts that one', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay news-letter promotion');
    await say(rig, 'd2', 'lead with the bundle offer');
    await say(rig, 'd3', "let's talk about the shed vents");
    expect(rig.desk.draft).toMatchObject({ active: true, fragments: [], target: { itemId: VENTS_ID } });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: VENTS_ID });
    await say(rig, 'd4', 'the left one rattles');
    // A tap on the first one switches back, and its words come with it.
    rig.desk.tap(PROMO_ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.desk.draft).toMatchObject({ fragments: ['lead with the bundle offer'], target: { itemId: PROMO_ID } });
    await say(rig, 'd5', 'pull up shed vents');
    expect(rig.desk.draft).toMatchObject({ fragments: ['the left one rattles'], target: { itemId: VENTS_ID } });
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('"never mind" discards the draft and shows Active; reopening starts empty', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', 'never mind');
    expect(rig.draft.active).toBe(false);
    expect(rig.desk.draft).toMatchObject({ status: 'cancelled' });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
    await say(rig, 'd4', 'okay shed vents');
    expect(rig.desk.draft).toMatchObject({ active: true, fragments: [] });
  });

  it('"Yankee, …" mid-draft is answered aloud and never added; its commands still work', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', 'Yankee, what did Sierra say about this yesterday?');
    expect(rig.desk.draft?.fragments).toEqual(['the left one rattles']);
    expect(commentary(rig).at(-1)).toMatch(/not part of the draft.*Answer it briefly/);
    expect(traced(rig, 'draft.aside')).toHaveLength(1);
    await say(rig, 'd4', 'Yankee, send it.');
    expect(rig.desk.draft?.status).toBe('sending');
    expect(rig.compiles[0].fragments).toEqual(['the left one rattles']);
    expect(addressedToOperator('Yanky, hold on')).toBe('hold on');
    expect(addressedToOperator('the Yankees won')).toBeNull();
    expect(DRAFT_ON_INSTRUCTIONS).toMatch(/clearly addressed to you.*Yankee/);
    expect(DRAFT_ON_INSTRUCTIONS).toMatch(/after a pause finishes the draft/);
  });

  it('"Yankee, over" / "Yankee out" / "Yankee, done" sign off a draft; dictation that mentions Yankee does not', async () => {
    for (const signoff of ['Yankee, over.', 'Yankee out', 'Yankee, done.', 'Yankee over and out', 'hey Yanky, over']) {
      const rig = setup({ desk: workDesk() });
      await say(rig, 'd1', 'okay shed vents');
      await say(rig, 'd2', 'the left one rattles');
      await say(rig, 'd3', signoff);
      expect(rig.desk.draft?.status).toBe('sending');
      expect(rig.compiles[0].fragments).toEqual(['the left one rattles']);
    }
    // Codex review on #451: a question to the operator with the sign-off after it is an aside, never dictation.
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', 'Yankee, what did Sierra say? Yankee, over.');
    expect(rig.desk.draft?.fragments).toEqual(['the left one rattles']);
    expect(rig.desk.draft?.status).not.toBe('sending');
    await say(rig, 'd4', '[sniff] Yankee, what did Sierra say? Yankee, over.');
    expect(rig.desk.draft?.fragments).toEqual(['the left one rattles']);
    expect(rig.desk.draft?.status).not.toBe('sending');
    // An ordinary closer after addressed dictation that names the operator still sends it.
    await say(rig, 'd5', 'Yankee, tell Sierra that Yankee is ready. Send it.');
    expect(rig.desk.draft?.status).toBe('sending');
    expect(rig.compiles[0].fragments).toEqual(['the left one rattles', 'tell Sierra that Yankee is ready.']);
    expect(matchDraftFinish('the left one rattles. Yankee, over.', AGENTS)).toMatchObject({ content: 'the left one rattles.' });
    expect(matchDraftFinish('Mm Yankee out', AGENTS)).toMatchObject({ content: '' });
    expect(matchDraftFinish('the game is over', AGENTS)).toBeNull();
    expect(matchDraftFinish('the Yankees are out of it', AGENTS)).toBeNull();
  });

  it('nothing dictated yet: a desk command is that, and "I\'m done" goes back to normal routing', async () => {
    const rig = setup({ desk: workDesk(), actions: [[{ type: 'none', reason: 'test' }]] });
    rig.desk.tap(VENTS_ID);
    await vi.advanceTimersByTimeAsync(50);
    await say(rig, 'd1', 'mark it done');
    expect(rig.draft.active).toBe(false);
    expect(rig.desk.sent('done')).toEqual([expect.objectContaining({ itemId: VENTS_ID })]);

    rig.desk.tap(PROMO_ID);
    await vi.advanceTimersByTimeAsync(50);
    await say(rig, 'd2', "I'm done");
    expect(rig.draft.active).toBe(false);
    expect(rig.compiles).toHaveLength(0);
    expect(rig.routed).toHaveLength(1);
  });

  it('a draft only armed by a tap does not hold agent updates; the first words do', async () => {
    const backend = new SimulatedAgentBackend({ malibu: () => [{ kind: 'result', text: 'Logged the eggs, 12 grams of protein.', afterMs: 3000 }] });
    const rig = setup({ backend, desk: workDesk(), actions: [[{ type: 'dispatch', agentId: 'malibu', message: 'The user had eggs.' }]] });
    await say(rig, 'd1', 'tell Malibu I had eggs');
    rig.desk.tap(VENTS_ID);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rig.draft.active).toBe(true);
    expect(commentary(rig).some((text) => text.includes('12 grams'))).toBe(true);
    expect(traced(rig, 'speech.held')).toHaveLength(0);
    expect(rig.draft.holdsUpdates).toBe(false);
    await say(rig, 'd2', 'the left one rattles');
    expect(rig.draft.holdsUpdates).toBe(true);
  });

  it('a compile that fails falls back to the words as said, and that is always confirmed, never auto-sent (Codex review 2 on #431)', async () => {
    const rig = setup({
      desk: workDesk(),
      compile: () => {
        throw new Error('model unavailable');
      },
    });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', "I'm done");
    expect(rig.desk.draft).toMatchObject({ status: 'confirm', undoUntil: null });
    expect(commentary(rig).at(-1)).toContain('Send that to');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.backend.sends).toHaveLength(0);
    await say(rig, 'd4', 'yes');
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.message).toBe('the left one rattles');

    // No compiler at all: the same.
    const bare = setup({ desk: workDesk(), draft: new DraftSession({}) });
    await say(bare, 'd1', 'okay shed vents');
    await say(bare, 'd2', 'the left one rattles');
    await say(bare, 'd3', "I'm done");
    expect(bare.desk.draft?.status).toBe('confirm');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bare.backend.sends).toHaveLength(0);
  });

  it('"wait, one more thing…" during the undo window stops the send and adds the rest (Codex review 2 on #431)', async () => {
    const cases: Array<[string, string]> = [
      ['wait, one more thing, bring the gate code', 'bring the gate code'],
      ['hold on, add the gate code', 'add the gate code'],
      ['no wait, make it Saturday', 'make it Saturday'],
      ['actually, also mention the dog', 'also mention the dog'],
      ['Yankee, wait, the code is 4512', 'the code is 4512'],
    ];
    for (const [words, added] of cases) {
      const rig = setup({ desk: workDesk() });
      await say(rig, 'd1', 'okay shed vents');
      await say(rig, 'd2', 'the left one rattles');
      await say(rig, 'd3', "I'm done");
      expect(rig.desk.draft?.status, words).toBe('sending');
      await say(rig, 'd4', words);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rig.backend.sends, words).toHaveLength(0);
      expect(rig.desk.draft, words).toMatchObject({ status: 'listening', fragments: ['the left one rattles', added] });
      await say(rig, 'd5', "I'm done");
      await vi.advanceTimersByTimeAsync(5000);
      expect(rig.backend.sends, words).toHaveLength(1);
      expect(rig.backend.sends[0].request.message, words).toContain(added);
      rig.operator.stop();
    }
    expect(undoPrefix('wait')).toBe('');
    expect(undoPrefix('hang on, there\'s more: the side gate')).toBe('the side gate');
    expect(undoPrefix('the waiter was rude')).toBeNull();
    expect(undoPrefix('tell them to wait')).toBeNull();
  });

  it('the board tapped while paused still parks the draft; a tapped conversation while paused arms nothing (Codex review 2 on #431)', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', 'Yankee, pause.');
    expect(rig.desk.pause?.active).toBe(true);
    rig.desk.tap(PROMO_ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    rig.desk.tap(VENTS_ID, { view: 'active', itemId: null, conversationKey: null, since: Date.now() + 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);
    expect(traced(rig, 'draft.park')).toHaveLength(1);
    await say(rig, 'd4', "Yankee, I'm back.");
    await say(rig, 'd5', 'okay shed vents');
    expect(rig.desk.draft?.fragments).toEqual(['the left one rattles']);
  });

  it('a late "wait, …" heard but not yet read when the undo window ends is read first, and stops the send (Codex review 3 on #431)', async () => {
    let speaking = false;
    const rig = setup({ desk: workDesk(), extra: { isUserSpeaking: () => speaking } });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', "I'm done");
    const left = (rig.desk.draft?.undoUntil ?? 0) - Date.now();
    await vi.advanceTimersByTimeAsync(left - 300);
    // Still talking as the window ends: the send waits for them.
    speaking = true;
    rig.client.user(' wait, the code is 4512'); // no delegation: only the transcript has it
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.backend.sends).toHaveLength(0);
    speaking = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.desk.draft).toMatchObject({ status: 'listening', fragments: ['the left one rattles', 'the code is 4512'] });
    expect(traced(rig, 'draft.hold.deferred')).toHaveLength(1);
  });

  it('late speech that is not an undo is held and the send goes; speaking forever defers at most 10 s (Codex review 3 on #431)', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    await say(rig, 'd3', "I'm done");
    const left = (rig.desk.draft?.undoUntil ?? 0) - Date.now();
    await vi.advanceTimersByTimeAsync(left - 300);
    rig.client.user(' thanks');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0].request.message).toBe('the left one rattles');

    let speaking = false;
    const busy = setup({ desk: workDesk(), extra: { isUserSpeaking: () => speaking } });
    await say(busy, 'd1', 'okay shed vents');
    await say(busy, 'd2', 'the left one rattles');
    await say(busy, 'd3', "I'm done");
    speaking = true;
    await vi.advanceTimersByTimeAsync(3000 + 8000);
    expect(busy.backend.sends).toHaveLength(0); // still waiting for them to finish
    expect(busy.desk.traced('draft.hold.deferred')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(busy.backend.sends).toHaveLength(1); // bounded: 10 s past the window
  });

  it('a slow lookup for an earlier tap never arms over a later one (Codex review 3 on #431)', async () => {
    const rig = setup({ desk: workDesk() });
    const fresh = deskItem('discord:thread:1550000000000000019', 'sierra', { threadId: '1550000000000000019', place: 'Gutter quote', nextStep: 'your_move' });
    let release!: () => void;
    rig.desk.refresh = () =>
      new Promise((resolve) => {
        release = () => {
          rig.desk.list.push(fresh);
          resolve(rig.desk.list);
        };
      });
    rig.desk.tap(fresh.id, { since: Date.now() });
    await vi.advanceTimersByTimeAsync(10);
    rig.desk.tap(VENTS_ID, { since: Date.now() + 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
  });

  it('a tap counts as activity: the idle return does not park the draft it just armed (Codex review 3 on #431)', async () => {
    const rig = setup({ desk: workDesk(), extra: { idleBoardMs: 120_000 } });
    await vi.advanceTimersByTimeAsync(119_000);
    rig.desk.tap(VENTS_ID);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: VENTS_ID });
    expect(traced(rig, 'draft.park')).toHaveLength(0);
  });

  it('a connection drop during the undo window: the send goes out when the next connection attaches (Codex review on #431)', async () => {
    const draft = new DraftSession({ compile: async (input) => compiled(input.fragments.join(' '), { agentId: 'sierra' }) });
    const deskClient = workDesk();
    const backend = new SimulatedAgentBackend({});
    const first = setup({ draft, desk: deskClient, backend });
    await say(first, 'd1', 'okay shed vents');
    await say(first, 'd2', 'the left one rattles');
    await say(first, 'd3', "I'm done");
    expect(deskClient.draft?.status).toBe('sending');
    first.operator.stop();
    await vi.advanceTimersByTimeAsync(10_000); // the window ran out with nobody attached
    expect(backend.sends).toHaveLength(0);
    const second = setup({ draft, desk: deskClient, backend });
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.sends).toHaveLength(1);
    expect(deskClient.draft).toMatchObject({ status: 'sent', active: false });
    expect(draft.active).toBe(false);
    expect(second.desk.traced('draft.hold.resume')).toHaveLength(1);
    // Later speech routes normally, not queued behind a stuck send.
    await say(second, 'e1', 'tell Malibu I had eggs');
    expect(second.routed.length).toBeGreaterThan(0);
  });

  it('a reconnect inside the undo window keeps the rest of the window, and undo still works', async () => {
    const draft = new DraftSession({ compile: async (input) => compiled(input.fragments.join(' '), { agentId: 'sierra' }) });
    const deskClient = workDesk();
    const backend = new SimulatedAgentBackend({});
    const first = setup({ draft, desk: deskClient, backend });
    await say(first, 'd1', 'okay shed vents');
    await say(first, 'd2', 'the left one rattles');
    await say(first, 'd3', "I'm done");
    first.operator.stop();
    const second = setup({ draft, desk: deskClient, backend });
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.sends).toHaveLength(0);
    second.desk.draftHandler?.({ action: 'cancel', commandId: 'c1', draftId: deskClient.draft?.id ?? undefined });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.sends).toHaveLength(0);
    expect(deskClient.draft).toMatchObject({ status: 'listening', fragments: ['the left one rattles'] });
  });

  it('a tap on an item the desk listing has not caught up with refreshes and arms (Codex review on #431)', async () => {
    const rig = setup({ desk: workDesk() });
    const fresh = deskItem('discord:thread:1550000000000000019', 'sierra', { threadId: '1550000000000000019', place: 'Gutter quote', nextStep: 'your_move' });
    rig.desk.refresh = async () => {
      if (!rig.desk.list.includes(fresh)) rig.desk.list.push(fresh);
      return rig.desk.list;
    };
    rig.desk.tap(fresh.id);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: fresh.id });
  });

  it('a tap on a conversation outside the active listing (a seen chapter) reads the item and arms (TGO-1050)', async () => {
    const rig = setup({ desk: workDesk() });
    const chapter = deskItem('discord:chapter:1550000000000000030:1550000000000000031', 'sierra', { place: null, nextStep: 'fyi', seen: 'seen' });
    const item = rig.desk.item.bind(rig.desk);
    rig.desk.item = async (id) => (id === chapter.id ? { ...chapter, messages: [] } : item(id));
    rig.desk.tap(chapter.id);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: chapter.id });
  });

  it('a tap on a hidden conversation outside the listing arms nothing', async () => {
    const rig = setup({ desk: workDesk() });
    const hidden = deskItem('discord:thread:1550000000000000032', 'sierra', { threadId: '1550000000000000032', hidden: true });
    const item = rig.desk.item.bind(rig.desk);
    rig.desk.item = async (id) => (id === hidden.id ? { ...hidden, messages: [] } : item(id));
    rig.desk.tap(hidden.id);
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);
    expect(traced(rig, 'draft.arm.skipped')).toHaveLength(1);
  });

  it('a tap that still can\'t resolve is not burned: the same presentation re-broadcast arms once the item is known', async () => {
    const rig = setup({ desk: workDesk() });
    const fresh = deskItem('discord:thread:1550000000000000019', 'sierra', { threadId: '1550000000000000019', place: 'Gutter quote', nextStep: 'your_move' });
    const since = Date.now();
    rig.desk.tap(fresh.id, { since });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);
    expect(traced(rig, 'draft.arm.skipped')).toHaveLength(1);
    rig.desk.list.push(fresh);
    rig.desk.tap(fresh.id, { since });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: fresh.id });
  });

  it('the board tapped while drafting for a conversation parks it, like "back to the board"', async () => {
    const rig = setup({ desk: workDesk() });
    await say(rig, 'd1', 'okay shed vents');
    await say(rig, 'd2', 'the left one rattles');
    rig.desk.tap(VENTS_ID, { view: 'active', itemId: null, conversationKey: null, since: Date.now() + 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.draft.active).toBe(false);
    expect(traced(rig, 'draft.park')).toHaveLength(1);
    await say(rig, 'd3', 'okay shed vents');
    expect(rig.desk.draft?.fragments).toEqual(['the left one rattles']);
  });
});

describe('next up: working through what waits on the owner', () => {
  const NOW = 90_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const STEREO = '1550000000000000021';
  const STEREO_ID = `discord:thread:${STEREO}`;
  const MEMORY_ID = 'loom:memory';
  const DEPLOY_ID = 'discord:chapter:vic';
  const VENTS_ID = `discord:thread:${THREAD}`;
  const minutesAgo = (minutes: number) => NOW - minutes * 60_000;
  /** Synthetic queue, listed newest first so only waitingSince can put the oldest first. */
  const queueDesk = () =>
    new FakeDesk([
      deskItem(DEPLOY_ID, 'victor', { place: 'Deploy window', nextStep: 'your_move', ask: 'Ship tonight?', waitingSince: minutesAgo(5), lastActivityAt: minutesAgo(5) }),
      deskItem(MEMORY_ID, 'loom', { place: 'demo · memory fixes', nextStep: 'your_move', waitingSince: minutesAgo(20), lastActivityAt: minutesAgo(20) }),
      deskItem(STEREO_ID, 'sierra', { threadId: STEREO, place: 'Bike speaker', nextStep: 'your_move', waitingSince: minutesAgo(62), lastActivityAt: minutesAgo(1) }),
      deskItem(VENTS_ID, 'sierra', { threadId: THREAD, place: 'Shed vents', nextStep: 'watching', lastActivityAt: minutesAgo(90) }),
    ]);

  describe('phrases', () => {
    it('advance and list are whole utterances; bare "next" only when allowed', async () => {
      const { matchNextCommand } = await import('../src/live/next-up.js');
      for (const phrase of ['next one', 'Next up.', 'next up please', "let's go to the next one", 'on to the next one', 'go to the next one', 'next item', 'okay, next one', 'alright, on to the next one', 'move on to the next one']) {
        expect(matchNextCommand(phrase), phrase).toBe('advance');
      }
      for (const phrase of ["what's next", "what's up", "what's available", "what's waiting", "what's waiting on me", 'what do I have', "what's left", "okay what's next"]) {
        expect(matchNextCommand(phrase), phrase).toBe('list');
      }
      for (const phrase of ['the next one should be red', 'next week we leave', "what's up with the speaker", 'I want the next one in blue', 'next']) {
        expect(matchNextCommand(phrase), phrase).toBeNull();
      }
      expect(matchNextCommand('next', { bare: true })).toBe('advance');
      expect(matchNextCommand('next please', { bare: true })).toBe('advance');
    });

    it('a trailing cue on a closer splits off, keeping the closer as said', async () => {
      const { splitNextCue } = await import('../src/live/next-up.js');
      expect(splitNextCue("I'm done, next one")).toEqual({ rest: "I'm done,", op: 'advance' });
      expect(splitNextCue('send it and go to the next one')).toEqual({ rest: 'send it', op: 'advance' });
      expect(splitNextCue("okay that's it, next up")).toEqual({ rest: "okay that's it,", op: 'advance' });
      expect(splitNextCue("I'm done, what's next")).toEqual({ rest: "I'm done,", op: 'list' });
      expect(splitNextCue("send it, what's up")).toEqual({ rest: 'send it,', op: 'list' });
      expect(splitNextCue('the next one should be red')).toBeNull();
      expect(splitNextCue('next one')).toBeNull();
      expect(matchDraftFinish("I'm done,", AGENTS)).toEqual({ content: '' });
    });

    it('waits and the summary in plain words', async () => {
      const { nextSummary, spokenWait } = await import('../src/live/next-up.js');
      expect(spokenWait(30_000)).toBe('about a minute');
      expect(spokenWait(5 * 60_000)).toBe('five minutes');
      expect(spokenWait(22 * 60_000)).toBe('twenty minutes');
      expect(spokenWait(62 * 60_000)).toBe('about an hour');
      expect(spokenWait(3 * 3_600_000)).toBe('about three hours');
      expect(spokenWait(50 * 3_600_000)).toBe('two days');
      const item = (agentName: string, place: string, minutes: number) => ({ agentName, place, title: null, ask: null, step: 'your_move' as const, waitingSince: minutesAgo(minutes) });
      expect(nextSummary([], NOW)).toBe('Nothing is waiting on you.');
      expect(nextSummary([item('Sierra', 'Bike speaker', 62)], NOW)).toBe('One is waiting on you: Sierra on Bike speaker, about an hour. Say "next one" to start it.');
      expect(nextSummary([item('Sierra', 'Bike speaker', 62), item('Loom', 'demo · memory fixes', 20), item('Victor', 'Deploy window', 5), item('Malibu', 'Lunch', 1)], NOW)).toBe(
        'Four are waiting on you. Longest: Sierra on Bike speaker, about an hour. Then Loom on memory fixes, twenty minutes, and Victor on Deploy window, five minutes. Plus one more. Say "next one" to start, or name one.',
      );
    });

    it('a pick from the list just read: ordinals, whose it is, or "the X one"', async () => {
      const { chooseFromList } = await import('../src/live/draft-mode.js');
      const refs: DraftItemRef[] = [
        { id: 'a', agentId: 'sierra', agentName: 'Sierra', place: 'Bike speaker', threadId: null, isAgent: true },
        { id: 'b', agentId: 'loom', agentName: 'Loom', place: 'demo · memory fixes', threadId: null, isAgent: false },
        { id: 'c', agentId: 'victor', agentName: 'Victor', place: 'Deploy window', threadId: null, isAgent: true },
      ];
      expect(chooseFromList('the second one', refs)?.id).toBe('b');
      expect(chooseFromList("let's do the third one", refs)?.id).toBe('c');
      expect(chooseFromList('the last one', refs)?.id).toBe('c');
      expect(chooseFromList('the speaker one', refs)?.id).toBe('a');
      expect(chooseFromList('the Victor one', refs)?.id).toBe('c');
      expect(chooseFromList('speaker', refs)).toBeNull();
      expect(chooseFromList('the second time I asked about it', refs)).toBeNull();
    });

    it('the router knows next advance / list, and "what\'s waiting on me" is no longer the briefing', () => {
      const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: "what's next", desk: { items: [] } });
      expect(prompt).toMatch(/next with next_op advance/);
      expect(prompt).toMatch(/next with next_op list/);
      expect(prompt).not.toMatch(/remind: the user asks to be caught up, what is waiting on them/);
      const raw = (op: string) => JSON.stringify({ actions: [{ type: 'next', next_op: op }] });
      expect(parseExtractorOutput(raw('advance'))).toEqual([{ type: 'next', op: 'advance' }]);
      expect(parseExtractorOutput(raw('list'))).toEqual([{ type: 'next', op: 'list' }]);
      expect(parseExtractorOutput(raw('sideways'))[0]).toMatchObject({ type: 'none' });
    });
  });

  it('"next one" outside a draft opens the oldest (not the newest) and starts a draft for it, with a refresher', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    expect(rig.routed).toHaveLength(0);
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft).toMatchObject({ status: 'listening', fragments: [], target: { itemId: STEREO_ID, agentId: 'sierra' } });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: STEREO_ID });
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher[\s\S]*"Go ahead\."/);
    expect(traced(rig, 'next.advance')).toHaveLength(1);
    expect(traced(rig, 'next.advance')[0]!.data).toMatchObject({ itemId: STEREO_ID, queue: [STEREO_ID, MEMORY_ID, DEPLOY_ID] });
    // What they say next is dictation for it.
    await say(rig, 'n2', 'get the Brand K unit');
    expect(rig.desk.draft?.fragments).toEqual(['get the Brand K unit']);
  });

  it('skips the conversation open on the screen', async () => {
    const rig = setup({ desk: queueDesk() });
    rig.screen.presented = { view: 'conversation', itemId: STEREO_ID, conversationKey: null, sceneId: null };
    await say(rig, 'n1', 'Yankee, next up please');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: MEMORY_ID });
    expect(traced(rig, 'next.advance')[0]!.data).toMatchObject({ itemId: MEMORY_ID, excluded: [STEREO_ID] });
  });

  it('nothing waiting: "Nothing else is waiting on you." and the board', async () => {
    const deskClient = queueDesk();
    for (const item of deskClient.list) item.nextStep = 'fyi';
    const rig = setup({ desk: deskClient });
    rig.screen.presented = { view: 'conversation', itemId: VENTS_ID, conversationKey: null, sceneId: null };
    await say(rig, 'n1', 'on to the next one');
    expect(rig.draft.active).toBe(false);
    expect(commentary(rig).at(-1)).toContain('"Nothing else is waiting on you."');
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
    expect(traced(rig, 'next.empty')).toHaveLength(1);
  });

  it('"what\'s waiting on me" shows the board and says the count, then the first three in queue order with their waits', async () => {
    const rig = setup({ desk: queueDesk() });
    rig.screen.presented = { view: 'conversation', itemId: VENTS_ID, conversationKey: null, sceneId: null };
    await say(rig, 'n1', "what's waiting on me?");
    expect(rig.routed).toHaveLength(0);
    expect(rig.draft.active).toBe(false);
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
    expect(commentary(rig).at(-1)).toContain(
      '"Three are waiting on you. Longest: Sierra on Bike speaker, about an hour. Then Loom on memory fixes, twenty minutes, and Victor on Deploy window, five minutes. Say "next one" to start, or name one."',
    );
    expect(traced(rig, 'next.list')[0]!.data).toMatchObject({ itemIds: [STEREO_ID, MEMORY_ID, DEPLOY_ID] });
    // "Catch me up" is still the full briefing.
    await say(rig, 'n2', 'catch me up');
    expect(traced(rig, 'next.list')).toHaveLength(1);
    expect(rig.routed).toHaveLength(0);
  });

  it('"the second one" after a list picks it and starts a draft for it', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', "what's next");
    await say(rig, 'n2', 'the second one');
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: MEMORY_ID });
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher/);
    // And "the speaker one" from the same list, from the empty draft.
    await say(rig, 'n3', 'the speaker one');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: STEREO_ID });
    expect(rig.routed).toHaveLength(0);
  });

  it('"I\'m done, next one" sends after the undo window, then opens the next (never the one just sent to)', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    await say(rig, 'n2', 'get the Brand K unit');
    await say(rig, 'n3', "I'm done, next one");
    expect(rig.compiles[0]!.fragments).toEqual(['get the Brand K unit']);
    expect(rig.desk.draft).toMatchObject({ status: 'sending', compiled: 'get the Brand K unit' });
    expect(traced(rig, 'next.advance')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request).toMatchObject({ agentId: 'sierra', channelId: STEREO, message: 'get the Brand K unit' });
    // The desk still lists the speaker thread as waiting, but it was just answered: the Loom one opens.
    expect(traced(rig, 'next.advance')).toHaveLength(2);
    expect(traced(rig, 'next.advance')[1]!.data).toMatchObject({ itemId: MEMORY_ID, excluded: [STEREO_ID] });
    expect(rig.draft.active).toBe(true);
    expect(rig.desk.draft).toMatchObject({ status: 'listening', fragments: [], target: { itemId: MEMORY_ID } });
    expect(instructions(rig).some((text) => text.includes('Say only "Sent."'))).toBe(true);
    expect(commentary(rig).at(-1)).toMatch(/quick spoken refresher/);
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: MEMORY_ID });
  });

  it('"Yankee, over, next one" finishes and then opens the next, like "I\'m done, next one" (Codex review on #451)', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    await say(rig, 'n2', 'get the Brand K unit');
    await say(rig, 'n3', 'Yankee, over, next one');
    expect(rig.compiles[0]!.fragments).toEqual(['get the Brand K unit']);
    expect(rig.desk.draft).toMatchObject({ status: 'sending' });
    expect(traced(rig, 'draft.after')).toHaveLength(1);
  });

  it('an answered main-channel item (destination kind home, no itemId) is not the "next one" a moment later (Codex review on #436)', async () => {
    const deskClient = queueDesk();
    // Victor's main-channel chapter waits longest.
    Object.assign(deskClient.list.find((item) => item.id === DEPLOY_ID)!, { waitingSince: minutesAgo(90) });
    const rig = setup({ desk: deskClient, compile: () => compiled('Ship it tonight.', { agentId: 'victor' }) });
    await say(rig, 'n1', 'next one');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: DEPLOY_ID });
    await say(rig, 'n2', 'ship it tonight');
    await say(rig, 'n3', "I'm done");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request).toMatchObject({ agentId: 'victor', message: 'Ship it tonight.' });
    expect(rig.backend.sends[0]!.request).not.toHaveProperty('channelId'); // the main channel: no itemId on the destination
    expect(rig.draft.active).toBe(false);
    // The desk still lists it as waiting; a separate "next one" skips it.
    await say(rig, 'n4', 'next one');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: STEREO_ID });
    expect(traced(rig, 'next.advance').at(-1)!.data).toMatchObject({ itemId: STEREO_ID, excluded: expect.arrayContaining([DEPLOY_ID]) });
  });

  it('"I\'m done, what\'s next" sends, then reads the list', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    await say(rig, 'n2', 'get the Brand K unit');
    await say(rig, 'n3', "send it, what's next");
    expect(traced(rig, 'next.list')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(traced(rig, 'next.list')).toHaveLength(1);
    expect(commentary(rig).at(-1)).toContain('"Two are waiting on you. Longest: Loom on memory fixes');
    expect(rig.draft.active).toBe(false);
  });

  it('undo during the window calls off the advance too', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    await say(rig, 'n2', 'get the Brand K unit');
    await say(rig, 'n3', "okay that's it, next up");
    expect(rig.desk.draft?.status).toBe('sending');
    await say(rig, 'n4', 'undo');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.desk.draft).toMatchObject({ status: 'listening', fragments: ['get the Brand K unit'], target: { itemId: STEREO_ID } });
    expect(traced(rig, 'next.cancelled')).toHaveLength(1);
    expect(traced(rig, 'next.advance')).toHaveLength(1);
    // Finishing plainly later sends without advancing.
    await say(rig, 'n5', "I'm done");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(traced(rig, 'next.advance')).toHaveLength(1);
  });

  it('nothing dictated: "next one" closes this draft and opens the next right away; bare "next" counts too', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: STEREO_ID });
    await say(rig, 'n2', 'next one');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: MEMORY_ID });
    expect(rig.compiles).toHaveLength(0);
    await say(rig, 'n3', 'next');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: STEREO_ID }); // the Loom one is open now, so the oldest other
    expect(rig.backend.sends).toHaveLength(0);
    expect(traced(rig, 'next.advance')).toHaveLength(3);
  });

  it('with words drafted, "next one" saves the draft with its conversation and moves on; reopening resumes it', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    await say(rig, 'n2', 'get the Brand K unit');
    await say(rig, 'n3', 'next one');
    expect(rig.desk.draft?.target).toMatchObject({ itemId: MEMORY_ID });
    expect(commentary(rig).at(-1)).toMatch(/^\[Their draft is saved with its conversation/);
    expect(rig.backend.sends).toHaveLength(0);
    await say(rig, 'n4', 'pull up the bike speaker');
    expect(rig.desk.draft).toMatchObject({ target: { itemId: STEREO_ID }, fragments: ['get the Brand K unit'] });
  });

  it('dictation that merely says "next" stays dictation', async () => {
    const rig = setup({ desk: queueDesk() });
    await say(rig, 'n1', 'next one');
    await say(rig, 'n2', 'the next one should be red');
    await say(rig, 'n3', 'next');
    await say(rig, 'n4', "what's next");
    expect(rig.desk.draft?.fragments).toEqual(['the next one should be red', 'next', "what's next"]);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: STEREO_ID });
    expect(traced(rig, 'next.advance')).toHaveLength(1);
    expect(traced(rig, 'next.list')).toHaveLength(0);
  });

  it('the router\'s next action works the same as the fast path', async () => {
    const rig = setup({ desk: queueDesk(), actions: [[{ type: 'next', op: 'advance' }]] });
    await say(rig, 'n1', 'alright, take me to whatever has been waiting longest');
    expect(rig.routed).toHaveLength(1);
    expect(rig.desk.draft?.target).toMatchObject({ itemId: STEREO_ID });
  });
});

describe('HttpDeskClient next(): the queue, or derived from the list on an older desk', () => {
  let server: Server;
  let base = '';
  let hasNext = true;
  const hits: string[] = [];
  const listed = [
    deskItem('d:new', 'victor', { nextStep: 'your_move', waitingSince: 3000, lastActivityAt: 3000 }),
    deskItem('d:fyi', 'sierra', { nextStep: 'fyi', lastActivityAt: 500 }),
    deskItem('d:old', 'sierra', { nextStep: 'failed', lastActivityAt: 1000 }),
    deskItem('d:hidden', 'malibu', { nextStep: 'your_move', hidden: true, lastActivityAt: 100 }),
  ];
  const queue = [{ id: 'q:1', agentId: 'loom', agentName: 'Loom', place: 'demo · memory fixes', title: 'memory fixes', ask: null, step: 'your_move', waitingSince: 10 }];
  beforeEach(async () => {
    hits.length = 0;
    server = createServer((req: IncomingMessage, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/api/desk/next' && !hasNext) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/desk/next' ? { items: queue } : { items: listed }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('uses /api/desk/next when the desk has it', async () => {
    hasNext = true;
    expect(await new HttpDeskClient(base).next()).toEqual(queue);
    expect(hits).toEqual(['/api/desk/next']);
  });

  it('a 404 falls back to the active list: your move and failed, on the board, oldest wait first; then stops asking', async () => {
    hasNext = false;
    const client = new HttpDeskClient(base);
    const derived = await client.next();
    expect(derived?.map((item) => item.id)).toEqual(['d:old', 'd:new']);
    expect(derived?.[0]).toMatchObject({ step: 'failed', waitingSince: 1000 });
    expect(derived?.[1]).toMatchObject({ step: 'your_move', waitingSince: 3000 });
    await client.next();
    expect(hits.filter((url) => url === '/api/desk/next')).toHaveLength(1);
    expect(hits.filter((url) => url.startsWith('/api/desk/items'))).toHaveLength(2);
  });
});

describe('plainForSpeech', () => {
  it('drops links, tables, code and formatting marks', async () => {
    const { plainForSpeech } = await import('../src/live/live-operator.js');
    const out = plainForSpeech('## Next idea\n\n**Bold** point with a [link](https://example.com/x) and https://example.com/y\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n- bullet');
    expect(out).toBe('Next idea\nBold point with a link and\nA, B\n1, 2\nbullet');
    expect(plainForSpeech('Sentence one. '.repeat(400)).length).toBeLessThanOrEqual(3501);
  });
});

describe('repeat guard: a closer right after a send', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());
  const ask = 'Check the order details for the blue kayak and the older red kayak and compare their weights with the new ones.';

  it('"I\'m done, send that" right after a send sends nothing new: "Already sent."', async () => {
    const rig = setup({
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: ask }],
        [{ type: 'reply', taskId: 't1', message: `Please ${ask.toLowerCase()} Do you know?` }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to check the order details for both kayaks and compare the weights');
    expect(rig.backend.sends).toHaveLength(1);
    await say(rig, 'd2', "I'm done, send that");
    expect(rig.backend.sends).toHaveLength(1);
    expect(commentary(rig).at(-1)).toContain('Already sent.');
    expect(traced(rig, 'routed.repeat')).toHaveLength(1);
  });

  it('a real follow-up to the same agent still goes out, even when it shares most words', async () => {
    const rig = setup({
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: 'Check the blue kayak weight.' }],
        [{ type: 'reply', taskId: 't1', message: 'Check the red kayak weight too.' }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to check the blue kayak weight');
    await say(rig, 'd2', 'and the red one too');
    expect(rig.backend.sends).toHaveLength(2);
    expect(traced(rig, 'routed.repeat')).toHaveLength(0);
  });

  it('opposite instructions are never repeats: "do not cancel" after "cancel" goes out (Codex review on #437)', async () => {
    const rig = setup({
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: 'Cancel the blue kayak order.' }],
        [{ type: 'reply', taskId: 't1', message: 'Do not cancel the blue kayak order.' }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to cancel the blue kayak order');
    await say(rig, 'd2', "wait, don't cancel it");
    expect(rig.backend.sends).toHaveLength(2);
  });

  it('after the agent answers, "go ahead" is a real reply, not a repeat (Codex review on #437)', async () => {
    const rig = setup({
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: ask }],
        [{ type: 'reply', taskId: 't1', message: ask }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to check the order details for both kayaks');
    expect(rig.backend.sends).toHaveLength(1);
    // The simulated agent answers after 3 s.
    await vi.advanceTimersByTimeAsync(3500);
    await say(rig, 'd2', 'okay send it');
    expect(rig.backend.sends).toHaveLength(2);
  });

  it('a long ask restated with one word changed is a correction and goes out (Codex review 2 on #437)', async () => {
    const rig = setup({
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: ask }],
        [{ type: 'reply', taskId: 't1', message: ask.replace('blue kayak', 'green kayak') }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to check the order details for both kayaks');
    await say(rig, 'd2', 'sorry, I meant the green kayak, not the blue one');
    expect(rig.backend.sends).toHaveLength(2);
  });

  it('a progress note from the agent is not an answer: the closer is still a repeat (Codex review 2 on #437)', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'progress', text: 'Looking up your orders…', afterMs: 100 }, { kind: 'result', text: 'Done.', afterMs: 20_000 }] });
    const rig = setup({
      backend,
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: ask }],
        [{ type: 'reply', taskId: 't1', message: ask }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to check the order details for both kayaks');
    await vi.advanceTimersByTimeAsync(500);
    await say(rig, 'd2', "I'm done, send that");
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('a closer a minute or more after the send is routed as usual', async () => {
    const rig = setup({
      actions: [
        [{ type: 'dispatch', agentId: 'sierra', message: ask }],
        [{ type: 'reply', taskId: 't1', message: 'Go ahead and order it.' }],
      ],
    });
    await say(rig, 'd1', 'Ask Sierra to check the order details for both kayaks');
    await vi.advanceTimersByTimeAsync(61_000);
    await say(rig, 'd2', 'okay send it');
    expect(rig.backend.sends).toHaveLength(2);
  });
});

describe('screen picker parsing', () => {
  it('only a listed screen id counts; anything else is the conversation', () => {
    const input = { place: 'x', agentName: 'Sierra', now: 0, messages: [], screens: [{ id: 's1', title: 'A', summary: '', updatedAt: 0, fromThisConversation: true }] };
    expect(parseScreenPick('{"pick":"s1","reason":"r"}', input)).toEqual({ pick: 's1', reason: 'r' });
    expect(parseScreenPick('{"pick":"conversation","reason":"moved on"}', input)).toEqual({ pick: null, reason: 'moved on' });
    expect(parseScreenPick('{"pick":"made-up","reason":""}', input).pick).toBeNull();
    expect(buildScreenPickPrompt({ ...input, messages: [{ author: 'agent', text: 'hi', at: 0 }] })).toContain('id s1: "A"');
  });
});

describe('closers after filler and noise', () => {
  it('"Mm go ahead", "[sniff] Go ahead", "mm mm I\'m done" finish a draft; filler alone does not', () => {
    for (const speech of ['go ahead', 'Mm go ahead', '[sniff] Go ahead.', 'Mm Mm Go ahead.', "mm mm I'm done", '[BLANK_AUDIO] okay send it']) expect(matchDraftFinish(speech, AGENTS)).not.toBeNull();
    expect(matchDraftFinish('add the red one. Mm go ahead', AGENTS)).toMatchObject({ content: 'add the red one.' });
    expect(matchDraftFinish('Mm', AGENTS)).toBeNull();
    expect(matchDraftFinish('mm go ahead and add the red one', AGENTS)).toBeNull();
  });
});

// Start work by voice (TGO-934): "new Loom thread in tango …" is a draft for a new Loom thread. The
// compile picks the repo (or asks which), the owner confirms, and the desk's Start work launches it.
describe('draft mode: a new Loom thread', () => {
  class StartWorkDesk extends FakeDesk {
    started: Array<Record<string, unknown>> = [];
    result: { ok: true; threadId: string; itemId: string; title: string; account: string } | { ok: false; error: string } = { ok: true, threadId: 't-1', itemId: 'loom:t-1', title: 'Fix the export test', account: 'Claude (Home)' };
    async startWorkRepos() {
      return ['tango', 'acme'];
    }
    async startWork(request: Record<string, unknown>) {
      this.started.push(request);
      return this.result as never;
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the router sends "new Loom thread" requests to a Loom draft, never to an agent', () => {
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'new thread for me in Loom for the tango repo', now: Date.now() });
    expect(prompt).toContain('Starting a new coding thread');
    expect(prompt).toContain('draft start with agent_id "loom"');
    expect(prompt).toContain('new Loom thread in tango');
  });

  it('"a new Loom thread in tango" settles the repo from the request even when the compile asks which (sweep D8)', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({
      desk: startDesk,
      actions: [[{ type: 'draft', op: 'start', agentId: 'loom', message: 'make the voice pill count waiting messages' }]],
      compile: () => compiled('Make the voice pill count waiting messages.', { agentId: null, newLoomRepo: null, newThreadTitle: 'Voice pill count', questions: ['Which repo: tango, acme?'] }),
    });
    await say(rig, 'd1', 'start a new Loom thread in tango to make the voice pill count waiting messages');
    await say(rig, 'd2', "that's it, send it");
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango?');
    expect(commentary(rig).join('\n')).not.toContain('Which repo');
    await say(rig, 'd3', 'yes');
    expect(startDesk.started).toEqual([expect.objectContaining({ repo: 'tango', prompt: 'Make the voice pill count waiting messages.' })]);
  });

  it('compiles with the Loom repos, confirms "a new thread in tango", and starts it on yes', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({
      desk: startDesk,
      actions: [[{ type: 'draft', op: 'start', agentId: 'loom', message: 'fix the flaky export test' }]],
      compile: (input) => compiled('Fix the flaky export test.', { agentId: null, newLoomRepo: input.loomRepos?.includes('tango') ? 'tango' : null, newThreadTitle: 'Fix the export test' }),
    });
    await say(rig, 'd1', 'new Loom thread in tango, fix the flaky export test');
    expect(rig.draft.active).toBe(true);
    expect(startDesk.drafts.at(-1)?.fragments).toEqual(['fix the flaky export test']);
    await say(rig, 'd2', "okay, I'm done");
    expect(rig.compiles[0]).toMatchObject({ newLoom: true, loomRepos: ['tango', 'acme'] });
    // Starting a thread always asks first: no undo-window auto-send.
    expect(startDesk.drafts.at(-1)).toMatchObject({ status: 'confirm', target: { agentId: 'loom', label: 'Loom · new thread in tango “Fix the export test”', where: 'new thread in tango “Fix the export test”' } });
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango?');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(startDesk.started).toHaveLength(0);
    const draftId = startDesk.drafts.at(-1)?.id;
    expect(draftId).toBeTruthy();
    await say(rig, 'd3', 'yes');
    // The draft's own id: a retry of this draft is one thread, a new draft with the same words is another.
    expect(startDesk.started).toEqual([{ repo: 'tango', prompt: 'Fix the flaky export test.', title: 'Fix the export test', commandId: `voice-${draftId}` }]);
    expect(rig.backend.sends).toHaveLength(0);
    expect(startDesk.drafts.at(-1)).toMatchObject({ active: false, status: 'sent' });
    expect(traced(rig, 'start-work')).toHaveLength(1);
  });

  it('live session 10/10: "Yes – mm" confirms, and the late hand-off of that yes starts nothing new', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({
      desk: startDesk,
      actions: [[{ type: 'draft', op: 'start', agentId: 'loom' }], [{ type: 'draft', op: 'start', agentId: 'loom', message: 'research the health export workflow' }]],
      compile: () => compiled('Research the health export workflow.', { agentId: null, newLoomRepo: 'tango' }),
    });
    await say(rig, 'd1', 'Can you start a new Loom thread for Tango');
    expect(commentary(rig).at(-1)).toContain('"New Loom thread. What should it work on?"');
    await say(rig, 'd2', 'research the health export workflow');
    await say(rig, 'd3', "I'm done");
    expect(startDesk.drafts.at(-1)?.status).toBe('confirm');
    await vi.advanceTimersByTimeAsync(3000); // "Send that…?" is asked; the yes is its own line
    await say(rig, 'd4', 'Yes - Mm');
    expect(startDesk.started).toHaveLength(1);
    expect(rig.compiles).toHaveLength(1); // not taken as an edit
    // GPT-Live hands the same yes off again a few seconds later, with nothing new said.
    await vi.advanceTimersByTimeAsync(7000);
    rig.client.emit('delegation', { id: 'd5', offsetMs: 0, prompt: 'Yes, please' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rig.draft.active).toBe(false);
    expect(startDesk.started).toHaveLength(1);
    expect(traced(rig, 'delegation.merged').at(-1)?.data).toMatchObject({ reason: 'consumed confirmation' });
  });

  it('a prompt-only yes well after an earlier spoken yes is a new answer: it is still routed (review)', async () => {
    const rig = setup({ actions: [[{ type: 'none', reason: 'test' }], [{ type: 'none', reason: 'test' }]] });
    await say(rig, 'd1', 'yes');
    await vi.advanceTimersByTimeAsync(30_000);
    rig.client.emit('delegation', { id: 'p2', offsetMs: 0, prompt: 'yes' });
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.routed).toHaveLength(2);
    expect(traced(rig, 'delegation.merged').filter((entry) => entry.data?.reason === 'consumed confirmation')).toHaveLength(0);
  });

  it('a prompt-only yes never heard in the transcript is fresh: it is still routed (review)', async () => {
    const rig = setup({ actions: [[{ type: 'none', reason: 'test' }]] });
    rig.client.emit('delegation', { id: 'p1', offsetMs: 0, prompt: 'yes' });
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.routed).toHaveLength(1);
    expect(traced(rig, 'delegation.merged')).toHaveLength(0);
  });

  it('a new Loom draft that already has its task does not ask for it again (review)', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({ desk: startDesk, actions: [[{ type: 'draft', op: 'start', agentId: 'loom', message: 'fix the flaky export test' }]] });
    await say(rig, 'd1', 'new Loom thread in tango, fix the flaky export test');
    expect(commentary(rig).at(-1)).toContain('"Got it. Anything else for it?"');
    expect(commentary(rig).at(-1)).not.toContain('What should it work on');
  });

  it('asks which repo when the compile could not tell, and holds the draft', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({ desk: startDesk, actions: [[{ type: 'draft', op: 'start', agentId: 'loom' }]], compile: () => compiled('Fix the export test.', { agentId: null }) });
    await say(rig, 'd1', 'start a new Loom thread');
    await say(rig, 'd2', 'fix the export test');
    await say(rig, 'd3', 'send it');
    expect(startDesk.drafts.at(-1)).toMatchObject({ status: 'confirm', question: 'Which repo: tango, acme?' });
    expect(startDesk.started).toHaveLength(0);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('a repo the owner never said is a guess: it asks, and the answer settles it', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({
      desk: startDesk,
      actions: [[{ type: 'draft', op: 'start', agentId: 'loom' }]],
      // The model guesses tango from the topic; only the answer "acme" names one.
      compile: (input) => compiled('Fix the export test.', { agentId: null, newLoomRepo: input.clarifications?.length ? 'acme' : 'tango' }),
    });
    await say(rig, 'd1', 'start a new Loom thread');
    await say(rig, 'd2', 'fix the export test');
    await say(rig, 'd3', 'send it');
    expect(startDesk.drafts.at(-1)?.question).toBe('Which repo: tango, acme?');
    await say(rig, 'd4', 'acme');
    expect(rig.compiles.at(-1)?.clarifications).toEqual([{ question: 'Which repo: tango, acme?', answer: 'acme' }]);
    expect(startDesk.drafts.at(-1)).toMatchObject({ status: 'confirm', question: null, target: { label: 'Loom · new thread in acme' } });
    await say(rig, 'd5', 'yes');
    expect(startDesk.started).toEqual([expect.objectContaining({ repo: 'acme', prompt: 'Fix the export test.' })]);
  });

  it('a refused start keeps the draft and says why', async () => {
    const startDesk = new StartWorkDesk([]);
    startDesk.result = { ok: false, error: 'fatal: unable to access github.com' };
    const rig = setup({ desk: startDesk, actions: [[{ type: 'draft', op: 'start', agentId: 'loom' }]], compile: () => compiled('Fix it.', { agentId: null, newLoomRepo: 'acme' }) });
    await say(rig, 'd1', 'new Loom thread in acme');
    await say(rig, 'd2', 'fix it');
    await say(rig, 'd3', 'send it');
    await say(rig, 'd4', 'yes');
    expect(startDesk.started).toHaveLength(1);
    expect(startDesk.drafts.at(-1)).toMatchObject({ status: 'confirm', note: "Not sent: couldn't start the Loom thread (fatal: unable to access github.com)" });
  });

  it('a repo outside the desk’s list is not a destination', async () => {
    const startDesk = new StartWorkDesk([]);
    const rig = setup({ desk: startDesk, actions: [[{ type: 'draft', op: 'start', agentId: 'loom' }]], compile: () => compiled('Fix it.', { agentId: null, newLoomRepo: 'other-repo' }) });
    await say(rig, 'd1', 'new Loom thread in other-repo');
    await say(rig, 'd2', 'fix it');
    await say(rig, 'd3', 'send it');
    expect(startDesk.drafts.at(-1)?.question).toBe('Which repo: tango, acme?');
  });

  it('the compile prompt lists the repos and the new-Loom rules only when the desk can start threads', () => {
    const base = { fragments: ['fix it'], agents: AGENTS, tasks: [], threads: [], transcript: [], now: Date.now() };
    expect(buildDraftCompilePrompt(base)).not.toContain('new_loom_repo');
    const prompt = buildDraftCompilePrompt({ ...base, loomRepos: ['tango', 'acme'], newLoom: true });
    expect(prompt).toContain('Loom repos (a new Loom thread can start in one): tango, acme');
    expect(prompt).toContain('starts a NEW Loom thread');
    expect(prompt).toContain('"Which repo: <the listed repos>?"');
    expect(parseDraftCompileOutput(JSON.stringify({ message: 'Fix it.', agent_id: '', item: '', thread_id: '', new_thread_title: 'Fix', new_loom_repo: 'tango', questions: [] }))).toMatchObject({ newLoomRepo: 'tango', agentId: null });
  });

  it('"new Loom thread in tango": the router\'s agent_id "loom" is a new coding thread too, started through Start work (Loom-first)', async () => {
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'new Loom thread in tango', now: Date.now() });
    expect(prompt).toContain('"new Loom thread in tango"');
    const startDesk = new StartWorkDesk([]);
    startDesk.result = { ok: true, threadId: 'l-1', itemId: 'loom:l-1', title: 'Fix the export test', account: 'Loom (best account)' };
    const rig = setup({
      desk: startDesk,
      actions: [[{ type: 'draft', op: 'start', agentId: 'loom', message: 'fix the flaky export test' }]],
      compile: (input) => compiled('Fix the flaky export test.', { agentId: null, newLoomRepo: input.newLoom ? 'tango' : null, newThreadTitle: 'Fix the export test' }),
    });
    await say(rig, 'd1', 'new Loom thread in tango, fix the flaky export test');
    expect(rig.draft.active).toBe(true);
    await say(rig, 'd2', "okay, I'm done");
    expect(rig.compiles[0]).toMatchObject({ newLoom: true, loomRepos: ['tango', 'acme'] });
    await vi.advanceTimersByTimeAsync(3000);
    await say(rig, 'd3', 'yes');
    // No account pinned: the desk picks the repo's default, Loom when it runs.
    expect(startDesk.started).toEqual([{ repo: 'tango', prompt: 'Fix the flaky export test.', title: 'Fix the export test', commandId: expect.stringMatching(/^voice-/) }]);
    expect(rig.backend.sends).toHaveLength(0);
    expect(traced(rig, 'start-work').at(-1)?.data).toMatchObject({ threadId: 'l-1' });
  });
});

describe('draft mode: ending without a closer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  type Judge = NonNullable<ConstructorParameters<typeof DraftSession>[0]>['judgeEnd'];
  function judgedRig(verdicts: boolean[], compileMs = 0, questionsFor: (fragments: string[]) => string[] = () => []) {
    const asked: Array<{ fragments: string[]; destination: string }> = [];
    const compiles: DraftCompileInput[] = [];
    const judgeEnd: Judge = async (input) => {
      asked.push({ fragments: input.fragments, destination: input.destination });
      return { done: verdicts.shift() ?? false, reason: 'test' };
    };
    const draft = new DraftSession({
      judgeEnd,
      compile: async (input) => {
        compiles.push(input);
        if (compileMs) await new Promise((resolve) => setTimeout(resolve, compileMs));
        return compiled(input.fragments.join(' '), { agentId: input.target?.agentId ?? 'sierra', questions: questionsFor(input.fragments) });
      },
    });
    const rig = setup({ draft });
    return { rig, asked, compiles };
  }

  it.each([
    "Hey, I'm gonna ramble for a minute",
    "Hey, I'm going to ramble for a minute",
    "I'm gonna talk for a while",
    "This is a long one",
    "Bear with me",
    "Let me think out loud",
    "Let me get this all out",
  ])('cold preamble starts a closer-only draft: %s', async (preamble) => {
    const { rig, asked } = judgedRig([true]);
    await say(rig, 'd1', preamble);
    expect(rig.draft.active).toBe(true);
    expect(rig.routed).toHaveLength(0);
    expect(traced(rig, 'draft.long')).toHaveLength(1);
    await say(rig, 'd2', "It's for Sierra");
    await say(rig, 'd3', 'Bring the small tent.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(0);
    expect(rig.backend.sends).toHaveLength(0);
    await say(rig, 'd4', 'Okay send it');
    await vi.advanceTimersByTimeAsync(4000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toBe('Bring the small tent.');
  });

  it('collects a cold ramble without model delegation and sends only after a closer', async () => {
    const { rig, asked } = judgedRig([true]);
    rig.client.user("Hey, I'm gonna ramble for a minute.");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(rig.draft.active).toBe(true);
    expect(rig.routed).toHaveLength(0);
    rig.client.user(' This is for Sierra. I want a packing checklist for a weekend camping trip, and');
    await vi.advanceTimersByTimeAsync(9000);
    rig.client.user(' include a rain jacket, a tent, and a flashlight.');
    await vi.advanceTimersByTimeAsync(9000);
    expect(asked).toHaveLength(0);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.draft.routerContext().target).toBe('Sierra');
    rig.client.user(' Okay, send it.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.backend.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    const message = rig.backend.sends[0]!.request.message;
    expect(message).toContain('packing checklist');
    expect(message).toContain('flashlight');
    expect(message).not.toMatch(/ramble|This is for|send it/i);
    expect(commentary(rig).join(' ')).not.toContain('Send that to');
  });

  it('asks who a targetless ramble is for instead of accepting a compiler guess', async () => {
    const { rig } = judgedRig([true]);
    await say(rig, 'r1', "Hey, I'm gonna ramble for a minute.");
    await say(rig, 'r2', 'Bring the tent.');
    await say(rig, 'r3', 'Okay, send it.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.backend.sends).toHaveLength(0);
    expect(commentary(rig).join(' ')).toContain("Who's it for?");
    await say(rig, 'r4', 'Sierra');
    await vi.advanceTimersByTimeAsync(4000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it.each(['Send it to Sierra', 'Okay, send it to Sierra.'])(
    'finishes a held ramble with the explicit closer %s',
    async (closer) => {
      const { rig } = judgedRig([true]);
      await say(rig, 'r1', "Hey, I'm gonna ramble for a minute.");
      await say(rig, 'r2', 'Bring the tent.');
      await say(rig, 'r3', closer);
      await vi.advanceTimersByTimeAsync(2000);
      expect(rig.backend.sends).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1500);
      expect(rig.backend.sends).toHaveLength(1);
      expect(rig.backend.sends[0]!.request.message).toBe('Bring the tent.');
      expect(commentary(rig).join(' ')).not.toContain('Send that to');
    },
  );

  it('uses a destination prefix before a closer in the same utterance', async () => {
    const { rig } = judgedRig([true]);
    await say(rig, 'r1', "Hey, I'm gonna ramble for a minute.");
    await say(rig, 'r2', 'This is for Sierra. Bring the tent. Okay, send it.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toBe('Bring the tent.');
    expect(commentary(rig).join(' ')).not.toContain('Send that to');
  });

  it.each(["Who's it for?", 'Which conversation should receive this?'])(
    'accepts a conversation clarification after %s',
    async (question) => {
      const rig = setup({
        compile: (input) => compiled('Bring the tent.', input.clarifications?.length
          ? { threadId: THREAD }
          : { questions: [question] }),
      });
      await say(rig, 'r1', "Hey, I'm gonna ramble for a minute.");
      await say(rig, 'r2', 'Bring the tent.');
      await say(rig, 'r3', 'Okay, send it.');
      expect(rig.backend.sends).toHaveLength(0);
      await say(rig, 'r4', "Sierra's shed vents thread");
      expect(rig.desk.draft?.question).toBeNull();
      expect(traced(rig, 'draft.confirm')).toHaveLength(1);
      await say(rig, 'r5', 'yes');
      expect(rig.backend.sends).toHaveLength(1);
      expect(rig.backend.sends[0]!.request.channelId).toBe(THREAD);
    },
  );

  it('accepts a bare agent clarification with compiler question wording', async () => {
    const rig = setup({
      compile: (input) => compiled('Bring the tent.', {
        agentId: input.target?.agentId ?? 'sierra',
        questions: input.clarifications?.length ? [] : ['Who should receive this message?'],
      }),
    });
    await say(rig, 'r1', "Hey, I'm gonna ramble for a minute.");
    await say(rig, 'r2', 'Bring the tent.');
    await say(rig, 'r3', 'Okay, send it.');
    await say(rig, 'r4', 'Sierra');
    await vi.advanceTimersByTimeAsync(4000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('requires backend dispatch evidence before the voice model claims delivery', () => {
    const prompt = buildOperatorInstructions(AGENTS);
    expect(prompt).toContain('unless a backend instruction or commentary explicitly confirms successful dispatch for that message');
    expect(prompt).toContain('Delegating is not sending');
    expect(prompt).toContain('never invent a success confirmation');
  });

  it('a finished thought sends on its own after the undo window: no "I\'m done" needed', async () => {
    const { rig, asked } = judgedRig([true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'Do you have links for any of these?');
    await vi.advanceTimersByTimeAsync(2000);
    expect(asked).toEqual([{ fragments: ['Do you have links for any of these?'], destination: 'Sierra' }]);
    expect(traced(rig, 'draft.end.model')).toHaveLength(1);
    expect(rig.desk.draft).toMatchObject({ status: 'sending' });
    expect(rig.backend.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toContain('links');
  });

  it('not done: keeps listening, and the next pause is judged with everything said', async () => {
    const { rig, asked } = judgedRig([false, false, true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'A few things about the trip.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.desk.draft).toMatchObject({ status: 'listening' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asked).toHaveLength(2); // the pause, then one second look: not one per second
    await say(rig, 'd3', 'We leave Friday and bring the small tent.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked[2]!.fragments).toEqual(['A few things about the trip.', 'We leave Friday and bring the small tent.']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('a "not done" gets a second look once the quiet goes on, told how long it has been', async () => {
    const seen: Array<number | undefined> = [];
    const draft = new DraftSession({
      judgeEnd: async (input) => (seen.push(input.silentMs), { done: input.silentMs !== undefined, reason: 'test' }),
      compile: async (input) => compiled(input.fragments.join(' '), { agentId: 'sierra' }),
    });
    const rig = setup({ draft });
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'Is the Kraft Geek better than the Spigen? Spigen is a brand I know, but that does not mean anything.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual([undefined]);
    expect(rig.desk.draft).toMatchObject({ status: 'listening' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThanOrEqual(6000);
    expect(traced(rig, 'draft.end.model')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('the end prompt leans done, leaves out the operator\'s acknowledgements, and says how long the silence is', () => {
    const prompt = buildDraftEndPrompt({
      fragments: ['I must have missed that, can you prompt it open again'],
      destination: 'Loom',
      transcript: ['Operator: The sign-in prompt is up.', 'User: I must have missed that, can you prompt it open again', 'Operator: Checking.', 'Operator: Let me check on that. Mm-hm.'],
      silentMs: 6400,
    });
    expect(prompt).toContain('The sign-in prompt is up.');
    expect(prompt).not.toContain('Checking.');
    expect(prompt).not.toContain('Let me check');
    expect(prompt).toContain('silent for 6 seconds');
    expect(prompt).toContain('When unsure, done');
  });

  it('a sentence left hanging is never judged; nothing goes without a named destination', async () => {
    const { rig, asked } = judgedRig([true, true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'On Amazon there is a version from a brand that,');
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toHaveLength(0);
    expect(traced(rig, 'draft.end.wait')).toHaveLength(1);

    await say(rig, 'd3', 'Mm.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toHaveLength(0); // a filler-only piece says nothing new

    const noise = judgedRig([true]);
    await say(noise.rig, 'd1', 'I have a message for Sierra');
    await say(noise.rig, 'd2', 'Mm. [tongue click] okay so');
    await vi.advanceTimersByTimeAsync(3000);
    expect(noise.asked).toHaveLength(0);

    const other = judgedRig([true]);
    await say(other.rig, 'd1', 'I want to draft a message');
    await say(other.rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(other.asked).toHaveLength(0);
    expect(other.rig.backend.sends).toHaveLength(0);
  });

  it('a piece that trails off gets a second look once the quiet goes on (live 10/14: 11 s of silence, then "Send it")', async () => {
    const seen: Array<number | undefined> = [];
    const draft = new DraftSession({
      judgeEnd: async (input) => (seen.push(input.silentMs), { done: true, reason: 'test' }),
      compile: async (input) => compiled(input.fragments.join(' '), { agentId: 'sierra' }),
    });
    const rig = setup({ draft });
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'Are there any performance issues with this, or will this be... uh');
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual([]);
    expect(traced(rig, 'draft.end.wait')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(6000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('while drafting the operator is told to stay silent, never to invite more (live 10/14: "Keep going." mid-send)', () => {
    for (const note of [DRAFT_ON_INSTRUCTIONS, DRAFT_STILL_INSTRUCTIONS]) {
      expect(note).not.toMatch(/reply only with a short|at most a very brief backchannel/i);
      expect(note).toMatch(/[Nn]ever say "keep going"/);
    }
  });

  it('"this is a long one" holds the draft open until a closer', async () => {
    const { rig, asked } = judgedRig([true, true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'this is a long one');
    await say(rig, 'd3', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(0);
    expect(rig.desk.draft).toMatchObject({ status: 'listening' });
    await say(rig, 'd4', "I'm done");
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('dictation that opens with "I\'m going to think out loud" joins the draft and holds it until a closer', async () => {
    const { rig, asked } = judgedRig([true, true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', "Okay, I'm going to think out loud here. The coast trip should be Friday.");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asked).toHaveLength(0);
    expect(rig.desk.draft).toMatchObject({ status: 'listening' });
    expect(rig.desk.draft?.fragments).toHaveLength(1);
    await say(rig, 'd3', "I'm done");
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toContain('Friday');
  });

  it('an aside to the operator that opens long leaves the draft as it was', async () => {
    const { rig, asked } = judgedRig([true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', "Yankee, I'm going to think out loud about the options; what do you think?");
    expect(traced(rig, 'draft.hold')).toHaveLength(0);
    await say(rig, 'd3', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toHaveLength(1);
  });

  it('opensLong: a lead-in that says it will take a while, not the words later on', () => {
    for (const yes of ["I'm going to think out loud here, so the issue is", 'let me think this through', 'so um bear with me, this is about the trip', "this is gonna be a long one. First", "[sniff] I'm gonna ramble for a minute"]) expect(opensLong(yes), yes).toBe(true);
    for (const no of ['The response time is a long one to debug', 'Can you think out loud about the options?', 'I think through most of these at night']) expect(opensLong(no), no).toBe(false);
  });

  it('talking again in a judged send\'s undo window adds to the draft; it goes once, whole', async () => {
    const { rig, asked } = judgedRig([true, true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.draft).toMatchObject({ status: 'sending' });
    await say(rig, 'd3', 'And bring the small tent.');
    expect(rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.', 'And bring the small tent.']);
    expect(traced(rig, 'draft.undo')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.fragments).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toContain('Friday');
    expect(rig.backend.sends[0]!.request.message).toContain('small tent');
  });

  it('talking again while a judged end compiles also rejoins the draft before anything goes (Codex review on #466)', async () => {
    const { rig, asked } = judgedRig([true, true], 2000);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(1500);
    expect(rig.desk.draft).toMatchObject({ status: 'compiling' });
    await say(rig, 'd3', 'And bring the small tent.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.', 'And bring the small tent.']);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(asked).toHaveLength(2);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toContain('small tent');
  });

  it('"this is a long one" lasts through parking and reopening (Codex review on #466)', async () => {
    const { rig, asked } = judgedRig([true, true]);
    await say(rig, 'd1', "let's talk about the shed vents");
    await say(rig, 'd2', 'this is a long one');
    await say(rig, 'd3', 'The left one rattles at highway speed.');
    await say(rig, 'd4', 'back to the board');
    expect(rig.draft.active).toBe(false);
    await say(rig, 'd5', "let's talk about the shed vents");
    expect(rig.desk.draft?.fragments).toEqual(['The left one rattles at highway speed.']);
    await say(rig, 'd6', 'The right one is fine.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(0);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('in a judged send\'s undo window, dictation with a cue word joins the draft; a bare closer lets it go (Codex review 2 on #466)', async () => {
    const { rig } = judgedRig([true, true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.draft).toMatchObject({ status: 'sending' });
    await say(rig, 'd3', 'And send me the packing list too.');
    expect(rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.', 'And send me the packing list too.']);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toContain('packing list');

    const bare = judgedRig([true]);
    await say(bare.rig, 'd1', 'I have a message for Sierra');
    await say(bare.rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(2500);
    await say(bare.rig, 'd3', 'Go ahead.');
    expect(bare.rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(bare.rig.backend.sends).toHaveLength(1);
  });

  it('a message said with the draft start is judged too (Codex review 3 on #466)', async () => {
    const { rig, asked } = judgedRig([true]);
    await say(rig, 'd1', "I've got a message for Sierra: the patio needs another coat");
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('a judged end that would ask something, with speech while it compiled, goes back to listening with that speech (Codex review 4 on #466)', async () => {
    const { rig, asked } = judgedRig([true, true], 2000, (fragments) => (fragments.length === 1 ? ['What time Friday?'] : []));
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(1500);
    await say(rig, 'd3', 'And invite the neighbors too.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(commentary(rig).some((text) => text.includes('What time Friday?'))).toBe(false);
    expect(rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.', 'And invite the neighbors too.']);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(asked).toHaveLength(2);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.message).toContain('neighbors');
  });

  it('a one-word reply is judged; so is a draft once who it is for is named (Codex review 4 on #466)', async () => {
    const one = judgedRig([true]);
    await say(one.rig, 'd1', 'I have a message for Sierra');
    await say(one.rig, 'd2', 'Approved.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(one.asked).toHaveLength(1);

    const later = judgedRig([true]);
    await say(later.rig, 'd1', 'I want to draft a message');
    await say(later.rig, 'd2', 'The patio needs another coat.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(later.asked).toHaveLength(0);
    await say(later.rig, 'd3', "that's for Sierra");
    await vi.advanceTimersByTimeAsync(3000);
    expect(later.asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(later.rig.backend.sends).toHaveLength(1);
  });

  it('a command said while a judged end compiles still acts as one; picking a conversation after dictating gets judged (Codex review 5 on #466)', async () => {
    const { rig } = judgedRig([true], 2000, () => ['What time Friday?']);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(1500);
    await say(rig, 'd3', 'this is a long one');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.backend.sends).toHaveLength(0);

    const later = judgedRig([true]);
    await say(later.rig, 'd1', 'I want to draft a message');
    await say(later.rig, 'd2', 'The left one rattles at highway speed.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(later.asked).toHaveLength(0);
    later.rig.desk.tap(`discord:thread:${THREAD}`);
    await vi.advanceTimersByTimeAsync(3000);
    expect(later.asked).toHaveLength(1);
    expect(later.rig.desk.draft?.target?.itemId).toBe(`discord:thread:${THREAD}`);
    await vi.advanceTimersByTimeAsync(6000);
    expect(later.rig.backend.sends).toHaveLength(1);
  });

  it('reopening a parked draft does not send it; "a long one" in the undo window holds it; a failed compile keeps words said meanwhile (Codex review 6 on #466)', async () => {
    const parked = judgedRig([false, true]);
    await say(parked.rig, 'd1', "let's talk about the shed vents");
    await say(parked.rig, 'd2', 'The left one rattles at highway speed.');
    await vi.advanceTimersByTimeAsync(3000);
    await say(parked.rig, 'd3', 'back to the board');
    await say(parked.rig, 'd4', "let's talk about the shed vents");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(parked.asked).toHaveLength(1);
    expect(parked.rig.backend.sends).toHaveLength(0);

    const held = judgedRig([true]);
    await say(held.rig, 'd1', 'I have a message for Sierra');
    await say(held.rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(held.rig.desk.draft).toMatchObject({ status: 'sending' });
    await say(held.rig, 'd3', 'Yankee, this is a long one');
    expect(held.rig.desk.draft).toMatchObject({ status: 'listening', fragments: ['The coast trip should be Friday.'] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held.rig.backend.sends).toHaveLength(0);

    let calls = 0;
    const failing = new DraftSession({
      judgeEnd: async () => ({ done: true, reason: 'test' }),
      compile: async (input) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (calls === 1) throw new Error('compiler down');
        return compiled(input.fragments.join(' '), { agentId: 'sierra' });
      },
    });
    const rig = setup({ draft: failing });
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(1500);
    await say(rig, 'd3', 'And invite the neighbors too.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.draft?.fragments).toEqual(['The coast trip should be Friday.', 'And invite the neighbors too.']);
  });

  it('a start that says it is long needs a closer; a verdict from before a destination change does not count (Codex review 8 on #466)', async () => {
    const long = judgedRig([true]);
    await say(long.rig, 'd1', "I've got a long message for Sierra");
    await say(long.rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(long.asked).toHaveLength(0);
    expect(long.rig.backend.sends).toHaveLength(0);

    const asked: string[] = [];
    let release: (() => void) | null = null;
    const draft = new DraftSession({
      judgeEnd: async (input) => {
        asked.push(input.destination);
        if (asked.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return { done: true, reason: 'test' };
      },
      compile: async (input) => compiled(input.fragments.join(' '), { agentId: input.target?.agentId ?? 'sierra' }),
    });
    const rig = setup({ draft });
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The build is green again.');
    await vi.advanceTimersByTimeAsync(1500);
    expect(asked).toEqual(['Sierra']);
    await say(rig, 'd3', "that's for Victor");
    release!();
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toEqual(['Sierra', 'Victor']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.backend.sends[0]!.request.agentId).toBe('victor');
  });

  it('a long start routed through the model needs a closer too (Codex review 9 on #466)', async () => {
    const asked: string[] = [];
    const draft = new DraftSession({
      judgeEnd: async (input) => (asked.push(input.destination), { done: true, reason: 'test' }),
      compile: async (input) => compiled(input.fragments.join(' '), { agentId: 'sierra' }),
    });
    const rig = setup({ draft, actions: [[{ type: 'draft', op: 'start', agentId: 'sierra' }]] });
    await say(rig, 'd1', 'okay so I need to ramble a bit before Sierra gets anything');
    expect(rig.draft.active).toBe(true);
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(0);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('"hold on" in a judged undo window keeps it closer-only; filler before a late target still gets judged (Codex review 10 on #466)', async () => {
    const held = judgedRig([true, true]);
    await say(held.rig, 'd1', 'I have a message for Sierra');
    await say(held.rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(2500);
    await say(held.rig, 'd3', 'hold on');
    await say(held.rig, 'd4', 'And bring the small tent.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held.asked).toHaveLength(1);
    expect(held.rig.backend.sends).toHaveLength(0);

    const later = judgedRig([true]);
    await say(later.rig, 'd1', 'I want to draft a message');
    await say(later.rig, 'd2', 'The patio needs another coat.');
    await say(later.rig, 'd3', 'Mm.');
    await say(later.rig, 'd4', "that's for Sierra");
    await vi.advanceTimersByTimeAsync(3000);
    expect(later.asked).toHaveLength(1);
  });

  it('a pause while a verdict is out sends nothing; a long start with its first point never gets judged (Codex review 11 on #466)', async () => {
    let release: (() => void) | null = null;
    const asked: string[] = [];
    const draft = new DraftSession({
      judgeEnd: async (input) => {
        asked.push(input.destination);
        await new Promise<void>((resolve) => (release = resolve));
        return { done: true, reason: 'test' };
      },
      compile: async (input) => compiled(input.fragments.join(' '), { agentId: 'sierra' }),
    });
    const rig = setup({ draft });
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(1500);
    expect(asked).toHaveLength(1);
    await say(rig, 'd3', 'Yankee, pause.');
    release!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.backend.sends).toHaveLength(0);

    const long = judgedRig([true]);
    await say(long.rig, 'd1', "I've got a long message for Sierra: first, the coast trip should be Friday.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(long.asked).toHaveLength(0);
    expect(long.rig.backend.sends).toHaveLength(0);
  });

  it('a pause during a judged send\'s undo window holds the send until the pause ends (Codex review 12 on #466)', async () => {
    const { rig } = judgedRig([true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.draft).toMatchObject({ status: 'sending' });
    await say(rig, 'd3', 'Yankee, pause.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('"long" in the message said with the start does not make it a long one (Codex review 13 on #466)', async () => {
    const { rig, asked } = judgedRig([true]);
    await say(rig, 'd1', "I've got a message for Sierra: the endpoint has a long response time.");
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked).toHaveLength(1);
  });

  it('a cancel said during a judged compile, with more after it, still cancels; filler after "not done" asks nothing new (Codex review 16 on #466)', async () => {
    const { rig } = judgedRig([true], 2000);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(1500);
    await say(rig, 'd3', 'cancel the draft');
    await say(rig, 'd4', 'Okay, never mind that.');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rig.draft.active).toBe(false);
    expect(rig.backend.sends).toHaveLength(0);

    const filler = judgedRig([false, true]);
    await say(filler.rig, 'd1', 'I have a message for Sierra');
    await say(filler.rig, 'd2', 'The coast trip should be Friday.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(filler.asked).toHaveLength(1);
    await say(filler.rig, 'd3', 'Mm.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(filler.asked).toHaveLength(1);
    expect(filler.rig.backend.sends).toHaveLength(0);
    // The quiet goes on: the second look still comes, filler or not.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(filler.asked).toHaveLength(2);
  });

  it('filler before anything is dictated is not a message: a quiet draft stays quiet and lets the answer through', async () => {
    const { rig } = judgedRig([true]);
    await say(rig, 'd1', 'I have a message for Sierra');
    await say(rig, 'd2', 'Hmm Mm-hmm');
    expect(rig.desk.draft?.fragments).toEqual([]);
    expect(traced(rig, 'draft.filler')).toHaveLength(1);
    await say(rig, 'd3', 'Mm. The coast trip should be Friday.');
    expect(rig.desk.draft?.fragments).toEqual(['Mm. The coast trip should be Friday.']);
    // A short reply made of everyday words is a reply, not filler (Codex review on #471).
    const reply = judgedRig([]);
    await say(reply.rig, 'd1', 'I have a message for Sierra');
    await say(reply.rig, 'd2', 'Okay.');
    expect(reply.rig.desk.draft?.fragments).toEqual(['Okay.']);
  });
});
