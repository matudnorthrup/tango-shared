import { readFileSync } from 'node:fs';
import { DraftSession } from '../src/live/draft-mode.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import { deadlineOf, HttpDeskClient } from '../src/live/desk-client.js';
import { parseUrgentLane, spokenThread } from '../src/live/live-operator.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { buildOperatorInstructions, LiveOperator, type LiveOperatorOptions } from '../src/live/live-operator.js';
import { HttpScreenDirector } from '../src/live/screen-director.js';
import { buildExtractorPrompt, parseExtractorOutput, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen, LOUD, scene } from './desk-fakes.js';

// The operator as a pure client of the Agent Desk (docs/specs/agent-desk.md, "Voice operator").

const AGENTS: AgentDescriptor[] = [
  { id: 'foxtrot', name: 'Foxtrot', role: 'finance' },
  { id: 'sierra', name: 'Sierra', role: 'research' },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD = '1550000000000000002';

function standardDesk() {
  return new FakeDesk([
    deskItem('discord:chapter:fox', 'foxtrot', { nextStep: 'your_move', ask: 'Vehicles transfer: $445.34 or revert to $421.37?', options: ['$445.34', 'Revert to $421.37'] }),
    deskItem(`discord:thread:${THREAD}`, 'sierra', { threadId: THREAD, place: 'Bike Turn Signal', nextStep: 'watching', summary: { gist: 'Waiting on a meter reading.' } }),
  ]);
}

interface Rig {
  client: FakeClient;
  operator: LiveOperator;
  desk: FakeDesk;
  screen: FakeDeskScreen;
  seen: ExtractorInput[];
  playback: LivePlaybackClock;
  userActivity: SpeechActivity;
  backend: SimulatedAgentBackend;
}

function setup(actions: OperatorAction[][], options: Partial<LiveOperatorOptions> & { desk?: FakeDesk; screen?: FakeDeskScreen } = {}): Rig {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const desk = options.desk ?? standardDesk();
  const screen = options.screen ?? new FakeDeskScreen();
  const playback = new LivePlaybackClock();
  const userActivity = new SpeechActivity();
  const backend = (options.backend as SimulatedAgentBackend | undefined) ?? new SimulatedAgentBackend({});
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity,
    playback,
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    ...options,
    desk,
    screen,
  });
  operator.start();
  return { client, operator, desk, screen, seen, playback, userActivity, backend };
}

const said = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');

/** The operator speaks the pending update through to the end, nobody talking over it. */
async function speakThrough(rig: Rig, words = '') {
  for (let i = 0; i < 5; i++) rig.playback.enqueue(LOUD);
  if (words) rig.client.operator(words);
  await vi.advanceTimersByTimeAsync(7000);
}

describe('operator as a desk client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  describe('routing (kept from the inbox era)', () => {
    it('a re-fired delegation with nothing new said sends nothing again', async () => {
      const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Transfer done.', afterMs: 60_000 }] });
      const send: OperatorAction[] = [{ type: 'dispatch', agentId: 'foxtrot', message: 'Do the transfer.' }];
      const rig = setup([send, send, send], { backend });
      rig.client.ask('d1', 'do the transfer');
      await vi.advanceTimersByTimeAsync(43_000);
      rig.client.emit('delegation', { id: 'd2', offsetMs: 0 }); // GPT-Live re-fires, no new words
      await vi.advanceTimersByTimeAsync(3000);
      expect(backend.sends).toHaveLength(1);
    });

    it('a delegation that is only a leftover fragment of finished speech sends nothing', async () => {
      const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Done.', afterMs: 60_000 }] });
      const send: OperatorAction[] = [{ type: 'dispatch', agentId: 'foxtrot', message: 'Wrap it up.' }];
      const rig = setup([send, send], { backend });
      rig.client.ask('d1', "tell foxtrot to wrap it up, um, because I think we've got everything else");
      await vi.advanceTimersByTimeAsync(43_000);
      // GPT-Live hands off the tail of the same sentence again, with no new words (10/06 live session).
      rig.client.emit('delegation', { id: 'd2', offsetMs: 0, prompt: "Um, because I think we've got everything else" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(backend.sends).toHaveLength(1);
    });

    it('a request that arrives only as the delegation prompt (no transcript) is still sent, once', async () => {
      const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Done.', afterMs: 100 }] });
      const move: OperatorAction[] = [{ type: 'dispatch', agentId: 'foxtrot', message: 'Move the transfer.' }];
      const rig = setup([move, move, move, move, move], { backend });
      rig.client.emit('delegation', { id: 'd1', offsetMs: 0, prompt: 'Ask Foxtrot to move the transfer' });
      await vi.advanceTimersByTimeAsync(43_000);
      rig.client.emit('delegation', { id: 'd2', offsetMs: 0, prompt: 'The user wants Foxtrot to move the transfer' });
      await vi.advanceTimersByTimeAsync(43_000);
      expect(backend.sends).toHaveLength(1);
      rig.client.emit('delegation', { id: 'd3', offsetMs: 0, prompt: 'Ask Foxtrot to move the transfer 101' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(backend.sends).toHaveLength(2);
    });

    it('retries a failed routing once, then says it failed instead of guessing', async () => {
      let calls = 0;
      const rig = setup([], {
        extractor: async () => {
          calls += 1;
          throw new Error('codex responses returned no text');
        },
      });
      rig.client.ask('d1', 'tell the docs thread to publish');
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls).toBe(2);
      expect(rig.client.appends.map((append) => append.content).join('\n')).toContain("That request didn't go through");
    });

    it('each request resolves handles against the desk it saw, even when another overlaps', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      const rig = setup([], {
        extractor: async () => {
          calls += 1;
          if (calls === 1) {
            await gate; // slow: the desk reorders and a second request lists it meanwhile
            return [{ type: 'desk', op: 'seen', item: 'i1' }];
          }
          return [{ type: 'none', reason: 'x' }];
        },
      });
      rig.client.ask('d1', 'seen the foxtrot thing');
      await vi.advanceTimersByTimeAsync(2500);
      rig.desk.list.reverse();
      rig.client.ask('d2', 'anything else?');
      await vi.advanceTimersByTimeAsync(2500);
      release();
      await vi.advanceTimersByTimeAsync(2000);
      expect(rig.desk.sent('seen').map((command) => command.itemId)).toEqual(['discord:chapter:fox']);
    });
  });

  describe('nothing sent', () => {
    const instructions = (client: FakeClient) => client.appends.filter((append) => append.kind === 'instructions').map((append) => append.content).join('\n');

    it('stays quiet on speech meant for someone else', async () => {
      const rig = setup([[{ type: 'none', reason: 'not for the operator: talking to someone in the room' }]]);
      rig.client.ask('d1', 'Riley, what sounds good for dinner');
      await vi.advanceTimersByTimeAsync(3000);
      expect(instructions(rig.client)).toContain('say nothing to it and keep listening');
      expect(instructions(rig.client)).not.toContain('who should take it');
    });

    it('after a long quiet, a short command that changes something asks "For me?" first (Codex review on #481)', async () => {
      const rig = setup([], { ownerSpeech: { lastAt: Date.now() - 5 * 60_000, addressedAt: Date.now() - 5 * 60_000 } });
      rig.screen.presented = { view: 'conversation', itemId: `discord:thread:${THREAD}`, conversationKey: `thread:${THREAD}`, sceneId: null };
      rig.client.ask('d1', 'mark it done');
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain('For me?');
      expect(rig.desk.sent('done')).toEqual([]);
      rig.client.ask('d2', 'yes');
      await vi.advanceTimersByTimeAsync(3000);
      expect(rig.desk.sent('done').map((command) => command.itemId)).toEqual([`discord:thread:${THREAD}`]);
    });

    it('room talk the router rejected does not make a later short command look mid-exchange (Codex review on #481)', async () => {
      const rig = setup([[{ type: 'none', reason: 'not for the operator' }]], { ownerSpeech: { lastAt: Date.now() - 5 * 60_000, addressedAt: Date.now() - 5 * 60_000 } });
      rig.screen.presented = { view: 'conversation', itemId: `discord:thread:${THREAD}`, conversationKey: `thread:${THREAD}`, sceneId: null };
      rig.client.ask('d1', 'thanks John, that looks great');
      await vi.advanceTimersByTimeAsync(3000);
      rig.client.ask('d2', 'mark it done');
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain('For me?');
      expect(rig.desk.sent('done')).toEqual([]);
    });

    it('mid-exchange, a short command just runs', async () => {
      const rig = setup([], { ownerSpeech: { lastAt: Date.now() - 20_000, addressedAt: Date.now() - 20_000 } });
      rig.screen.presented = { view: 'conversation', itemId: `discord:thread:${THREAD}`, conversationKey: `thread:${THREAD}`, sceneId: null };
      rig.client.ask('d1', 'mark it done');
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).not.toContain('For me?');
      expect(rig.desk.sent('done')).toHaveLength(1);
    });

    it('still asks who should take an unclear request', async () => {
      const rig = setup([[{ type: 'none', reason: 'no agent fits' }]]);
      rig.client.ask('d1', 'can someone look into the thing');
      await vi.advanceTimersByTimeAsync(3000);
      expect(instructions(rig.client)).toContain('ask the user who should take it');
    });
  });

  describe('extractor listing', () => {
    it('lists at most 60 desk items as compact lines, plus the focused item', async () => {
      const desk = new FakeDesk(
        Array.from({ length: 70 }, (_, index) => deskItem(`loom:task-${index}`, 'loom', { place: `demo · task ${index}`, summary: { gist: `A long gist that goes on and on about task number ${index} and the many details of it.` } })),
      );
      const screen = new FakeDeskScreen();
      screen.presented = { view: 'conversation', itemId: 'loom:task-68', conversationKey: 'loom:task-68', sceneId: null };
      const rig = setup([[{ type: 'none', reason: 'x' }]], { desk, screen });
      rig.client.ask('d1', 'tell the docs thread to archive the drafts');
      await vi.advanceTimersByTimeAsync(3000);
      const listing = rig.seen[0]!.desk!;
      expect(listing.items).toHaveLength(61);
      expect(listing.items.at(-1)).toMatchObject({ handle: 'i61', agentName: 'Loom', place: 'demo · task 68', threadId: null });
      expect(listing.focused).toBe('i61');
      expect(listing.items.every((item) => item.line.length <= 80)).toBe(true);
    });

    it('gives handles, steps, threads for Discord threads only, and the focused / last-discussed items', async () => {
      const screen = new FakeDeskScreen();
      screen.presented = { view: 'conversation', itemId: `discord:thread:${THREAD}`, conversationKey: `thread:${THREAD}`, sceneId: null };
      const rig = setup([], { screen });
      rig.client.ask('d1', "what's this one about");
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen[0]!.desk).toEqual({
        items: [
          expect.objectContaining({ handle: 'i1', agentName: 'Foxtrot', step: 'needs you', threadId: null, options: ['$445.34', 'Revert to $421.37'] }),
          expect.objectContaining({ handle: 'i2', agentName: 'Sierra', place: 'Bike Turn Signal', step: 'watching', threadId: THREAD }),
        ],
        focused: 'i2',
      });
    });
  });

  describe('commands', () => {
    it('every mark is a desk command with its own UUID command id, and says which item', async () => {
      const rig = setup([
        [{ type: 'desk', op: 'seen', item: 'i2' }],
        [{ type: 'desk', op: 'park', item: 'i1' }],
        [{ type: 'desk', op: 'pickup', item: 'i1' }],
        [{ type: 'desk', op: 'snooze', item: 'i1', until: '2026-10-07T15:00:00-07:00' }],
        [{ type: 'desk', op: 'answer', item: 'i1', option: 'revert to $421.37' }],
        [{ type: 'desk', op: 'retry', item: 'i2' }],
        [{ type: 'desk', op: 'done', item: 'i2' }],
      ]);
      const phrases = ['seen the turn signal thing', 'later for foxtrot', 'bring foxtrot back', 'foxtrot till 3 tomorrow', 'go with reverting', 'run sierra again', 'sierra is finished'];
      for (const [index, words] of phrases.entries()) {
        rig.client.ask(`d${index + 1}`, words);
        await vi.advanceTimersByTimeAsync(2500);
      }
      expect(rig.desk.commands.map(({ type, itemId, args }) => ({ type, itemId, args }))).toEqual([
        { type: 'seen', itemId: `discord:thread:${THREAD}`, args: {} },
        { type: 'park', itemId: 'discord:chapter:fox', args: {} },
        { type: 'pickup', itemId: 'discord:chapter:fox', args: {} },
        { type: 'snooze', itemId: 'discord:chapter:fox', args: { until: '2026-10-07T15:00:00-07:00' } },
        { type: 'answer', itemId: 'discord:chapter:fox', args: { option: 'Revert to $421.37' } },
        { type: 'retry', itemId: `discord:thread:${THREAD}`, args: {} },
        { type: 'done', itemId: `discord:thread:${THREAD}`, args: {} },
      ]);
      const ids = rig.desk.commands.map((command) => command.commandId);
      expect(ids.every((id) => UUID.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(said(rig.client)).toContain('Parked: Foxtrot: Vehicles transfer');
      expect(said(rig.client)).toContain('Answered "Revert to $421.37"');
    });

    it('done that needs a stopJob choice asks "stop the job too?" and resends with the answer', async () => {
      const rig = setup([[{ type: 'desk', op: 'done', item: 'i2' }]]);
      rig.desk.respond = (command) =>
        command.type === 'done' && command.args.stopJob === undefined
          ? { status: 'failed', error: 'stopJob is required: "Nightly import" is still running in this conversation' }
          : { status: 'applied', outcome: { writeback: { outcome: 'ok' } } };
      rig.client.ask('d1', 'sierra is finished');
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('Nightly import is still running in that conversation. Ask the user: "Stop the job too?"');
      rig.client.ask('d2', 'yes');
      await vi.advanceTimersByTimeAsync(2500);
      const dones = rig.desk.sent('done');
      expect(dones.map((command) => command.args)).toEqual([{}, { stopJob: true }]);
      expect(dones[0]!.commandId).not.toBe(dones[1]!.commandId);
      expect(rig.seen).toHaveLength(1); // the answer resolved without the model
      expect(said(rig.client)).toContain('Marked done and stopped the job');
    });

    it('asks which item when the handle is unknown and nothing is in focus', async () => {
      const rig = setup([[{ type: 'desk', op: 'done', item: 'i9' }]]);
      rig.client.ask('d1', 'finish that up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.desk.commands).toEqual([]);
      expect(said(rig.client)).toContain("couldn't tell which item");
    });

    it('a write-back failure is reported as done here but not at the source', async () => {
      const rig = setup([[{ type: 'desk', op: 'done', item: 'i1' }]]);
      rig.desk.respond = () => ({ status: 'applied', outcome: { writeback: { outcome: 'failed', error: 'archive 403' } } });
      rig.client.ask('d1', 'foxtrot is finished');
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('did not take it');
    });
  });

  describe('focus after reading: another agent\'s answer waits', () => {
    it('reading an item starts a draft for it: the read-back plays, another agent\'s answer waits until the board, and the next words are the reply', async () => {
      const backend = new SimulatedAgentBackend({ malibu: () => [{ kind: 'result', text: 'The ferry runs at 9:10 and 11:40.', afterMs: 6000 }] });
      const rig = setup([[{ type: 'dispatch', agentId: 'malibu', message: 'Look up the ferry times.' }], [{ type: 'desk', op: 'read', item: 'i1' }]], { backend });
      rig.desk.messages.set('discord:chapter:fox', [{ author: 'agent', text: 'Two hardware store charges are uncleared. Should I categorize them?', at: 2 }]);
      rig.client.ask('d1', 'ask Malibu to look up the ferry times');
      await vi.advanceTimersByTimeAsync(3000);
      rig.client.ask('d2', 'what does Foxtrot have');
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain('hardware store charges');
      // Malibu answers while the owner is in Foxtrot's conversation: it waits.
      await vi.advanceTimersByTimeAsync(8000);
      expect(said(rig.client)).not.toContain('11:40');
      rig.client.ask('d3', "leave them for now and check again on Friday");
      await vi.advanceTimersByTimeAsync(3000);
      expect(rig.desk.draft?.fragments).toEqual(["leave them for now and check again on Friday"]);
      expect(rig.desk.sent('snooze')).toEqual([]);
    });
  });

  describe('heard means heard', () => {
    it('reading an item opens its conversation and marks it heard only after playback finished', async () => {
      const rig = setup([[{ type: 'desk', op: 'read', item: 'i1' }]]);
      rig.desk.messages.set('discord:chapter:fox', [
        { author: 'owner', text: 'the board does not scroll on my phone', at: 1 },
        { author: 'agent', text: 'Should the vehicles transfer include the two parts charges?', at: 2 },
      ]);
      rig.client.ask('d1', 'what did Foxtrot need?');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.screen.intents).toContainEqual({ view: 'conversation', itemId: 'discord:chapter:fox', conversationKey: 'channel:home-foxtrot', reason: 'focus' });
      expect(said(rig.client)).toContain(`The user's own last message there (their words, not Foxtrot's): "the board does not scroll on my phone"`);
      expect(said(rig.client)).toContain('It is waiting on the user.');
      expect(rig.desk.sent('heard')).toEqual([]);
      await speakThrough(rig);
      expect(rig.desk.sent('heard')).toEqual([expect.objectContaining({ itemId: 'discord:chapter:fox', args: { playbackComplete: true } })]);
    });

    it("an agent result is marked heard on its conversation's desk item, never when interrupted", async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The rear bulb socket is corroded.', afterMs: 100 }] });
      const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Check the socket', threadId: THREAD }]], { backend });
      rig.client.ask('d1', 'have sierra check the socket');
      await vi.advanceTimersByTimeAsync(2500);
      // Talked over: not heard.
      for (let i = 0; i < 20; i++) rig.playback.enqueue(LOUD);
      for (let i = 0; i < 8; i++) {
        rig.userActivity.observe(LOUD, Date.now());
        if (i === 1) rig.client.emit('inputTranscript', { delta: 'wait, which socket is that', startMs: Date.now(), endMs: Date.now() });
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(4000);
      expect(rig.desk.sent('heard')).toEqual([]);
      // Re-released and played through: heard.
      await vi.advanceTimersByTimeAsync(2000);
      await speakThrough(rig, 'Sierra says the rear bulb socket is corroded.');
      expect(rig.desk.sent('heard')).toEqual([expect.objectContaining({ itemId: `discord:thread:${THREAD}`, args: { playbackComplete: true } })]);
    });
  });

  describe('catch me up', () => {
    it('goes Your move / Failed one at a time, then one sentence per agent, marking each briefed once heard', async () => {
      const desk = standardDesk();
      desk.briefingValue = {
        text: 'ignored',
        yourMove: [
          { id: 'discord:chapter:fox', agentName: 'Foxtrot', place: null, step: 'failed', ask: null, options: [], context: [], gist: 'The import crashed.' },
          { id: `discord:thread:${THREAD}`, agentName: 'Sierra', place: 'Bike Turn Signal', step: 'your_move', ask: 'Front or rear?', options: ['Front', 'Rear'], context: [], gist: null },
        ],
        fyi: [{ agentName: 'Malibu', itemIds: ['m1', 'm2'], sentence: 'Malibu has 2 updates, latest: macros logged.' }],
      };
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen).toHaveLength(0); // "catch me up" never waits on the model
      const spoken = () => rig.client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content);
      expect(spoken()).toEqual([expect.stringContaining("Catch-up, 1 of 2: Foxtrot's last turn failed: The import crashed.")]);
      await speakThrough(rig);
      expect(rig.desk.sent('briefed').map((command) => command.itemId)).toEqual(['discord:chapter:fox']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spoken().at(-1)).toContain('Catch-up, 2 of 2: Sierra needs the user (Bike Turn Signal): Front or rear?. Options: Front; Rear.');
      expect(rig.screen.intents).toContainEqual({ view: 'conversation', itemId: `discord:thread:${THREAD}`, conversationKey: `thread:${THREAD}`, reason: 'focus' });
      await speakThrough(rig);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spoken().at(-1)).toContain('Also, in one sentence: Malibu has 2 updates');
      await speakThrough(rig);
      expect(rig.desk.sent('briefed').map((command) => command.itemId)).toEqual(['discord:chapter:fox', `discord:thread:${THREAD}`, 'm1', 'm2']);
      expect(rig.desk.sent('heard')).toEqual([]);
    });

    it('says so when the desk cannot be reached', async () => {
      const desk = standardDesk();
      desk.briefingValue = null;
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain("couldn't reach the desk");
    });
  });

  describe('catch me up, walking the desk', () => {
    // Two moments: a brief on the Tango Desk, then something decided on the Bike project.
    const LINES = [
      { spaceId: 'desk', name: 'Tango Desk', line: { id: 11, ids: [11], kind: 'needs', title: 'Ship the voice walk?', detail: null, briefId: 'D-1', itemId: 'loom:0000', decisionId: null, waiting: true }, brief: { ask: 'Ship the voice walk?', options: [{ key: 'A', label: 'Ship it', recommended: true, answer: 'A · Ship it (Recommended)' }, { key: 'B', label: 'Wait a day', recommended: false, answer: 'B · Wait a day' }], defaultOption: 'A', revision: 3 } },
      { spaceId: 'bike', name: 'Bike', line: { id: 12, ids: [12, 13], kind: 'decided', title: 'Merged the turn signal fix', detail: null, briefId: null, itemId: 'discord:chapter:fox', decisionId: 'D-2', waiting: false }, brief: null },
    ];
    const walking = (desk: FakeDesk, gone: number[] = []) => {
      desk.walkValue = (ask) => {
        const open = LINES.filter((l) => !gone.includes(l.line.id) && !(ask.skipped ?? []).includes(l.line.id) && (!ask.space || l.spaceId === ask.space));
        const row = (l: (typeof LINES)[number]) => ({ spaceId: l.spaceId, name: l.name, summary: l.line.kind === 'needs' ? '1 needs you' : '1 decided' });
        return { focus: open[0] ? { spaceId: open[0].spaceId, name: open[0].name, headline: null, plan: { updateIds: [open[0].line.id], revision: 'heard-plan', line: 'Mark the updates seen.' }, line: open[0].line, brief: open[0].brief } : null, map: { needs: open.filter((l) => l.line.kind === 'needs').map(row), look: open.filter((l) => l.line.kind !== 'needs').map(row), smaller: [] }, left: open.length };
      };
    };
    const spoken = (rig: Rig) => rig.client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content);
    const follows = (rig: Rig) => rig.screen.commandArgs.filter((c) => c.name === 'list_place').map((c) => c.args);

    it('does not submit a queued plan before its readback completes', async () => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      // No playback completion: the owner cuts the readback short.
      rig.client.ask('d2', 'accept');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.chapterActs).toEqual([]);
    });

    it.each(['accept', 'defer'] as const)('refreshes the heard revision before %s but never adopts a new unheard update', async (how) => {
      for (const newUpdate of [false, true]) {
        const desk = standardDesk();
        walking(desk, [11]); // A normal non-waiting line, removed by the heard write.
        const mark = desk.updatesSeen.bind(desk);
        desk.updatesSeen = async (...args) => {
          const result = await mark(...args);
          desk.chapterPlanValue = { updateIds: newUpdate ? [99] : [], revision: 'after-heard', line: newUpdate ? 'One new update.' : 'Nothing left.' };
          return result;
        };
        const act = desk.chapterAct.bind(desk);
        desk.chapterAct = async (space, action, plan) => {
          desk.chapterActResult = plan.revision === desk.chapterPlanValue?.revision
            ? { ok: true, applied: { took: [], fine: [], seen: 0 } }
            : { ok: false, error: 'The chapter changed since you saw it', changed: true, plan: desk.chapterPlanValue! };
          return act(space, action, plan);
        };
        const rig = setup([], { desk });
        rig.client.ask('d1', 'catch me up');
        await vi.advanceTimersByTimeAsync(2500);
        await speakThrough(rig);
        expect(desk.seenCalls).toContainEqual({ ids: [12, 13], via: 'heard', outcome: null });
        rig.client.ask('d2', how === 'accept' ? 'accept' : 'skip this project');
        await vi.advanceTimersByTimeAsync(2500);
        expect(desk.chapterPlans).toHaveLength(1);
        expect(desk.chapterPlans[0]?.revision).toBe(newUpdate ? 'heard-plan' : 'after-heard');
        expect(spoken(rig).at(-1)?.includes('The chapter changed')).toBe(newUpdate);
        rig.operator.stop();
      }
    });

    it.each(['accept', 'defer'] as const)('submits the heard plan for %s, reads a conflict and never retries it automatically', async (how) => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      desk.chapterActResult = { ok: false, error: 'The chapter changed since you saw it', changed: true, plan: { updateIds: [11, 99], revision: 'new-plan', line: 'Mark 2 updates seen.' } };
      rig.client.ask('d2', how === 'accept' ? 'accept' : 'skip this project');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.chapterPlans).toEqual([{ updateIds: [11], revision: 'heard-plan', line: 'Mark the updates seen.' }]);
      expect(spoken(rig).at(-1)).toContain('The chapter changed: 1 new update');
      expect(spoken(rig).at(-1)).toContain('Mark 2 updates seen.');
      await speakThrough(rig);
      await vi.advanceTimersByTimeAsync(5000);
      expect(desk.chapterActs).toHaveLength(1);
      desk.chapterActResult = { ok: true, applied: { took: [], fine: [], seen: 2, filed: ['loom:done'] } };
      rig.client.ask('d3', how === 'accept' ? 'accept' : 'skip this project');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.chapterPlans[1]?.revision).toBe('new-plan');
      if (how === 'accept') expect(spoken(rig).at(-1)).toContain('marked the finished thread done');
    });

    it('reads one moment at a time, the windows following, and answers a brief and says fine by voice', async () => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen).toHaveLength(0);
      expect(spoken(rig).at(-1)).toContain("say next, skip, go with an option, that's fine, accept, or what's left.");
      expect(spoken(rig).at(-1)).toContain("Tango Desk, needs you: Ship the voice walk. Options: A, Ship it; B, Wait a day. I'd go with A.");
      expect(follows(rig)).toEqual([{ page: 'catchup', focus: 11, skipped: [] }]);
      await speakThrough(rig);

      rig.client.ask('d2', 'go with A');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen).toHaveLength(0);
      expect(rig.desk.sent('respond')).toEqual([expect.objectContaining({ itemId: 'loom:0000', args: { requestId: 'decision:D-1', answers: { decision: 'A · Ship it (Recommended)' }, revision: 3 } })]);
      expect(spoken(rig).at(-1)).toContain("Went with A, Ship it. Bike, decided for you: Merged the turn signal fix. Say that's fine, or next.");
      expect(follows(rig).at(-1)).toEqual({ page: 'catchup', focus: 12, skipped: [11] });
      await speakThrough(rig);

      rig.client.ask('d3', "that's fine");
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.confirmed).toEqual(['D-2']);
      expect(spoken(rig).at(-1)).toContain("Noted. That's everything: you're caught up.");
      expect(follows(rig).at(-1)).toEqual({ page: 'catchup', focus: null, skipped: [11, 12, 13] });
      await speakThrough(rig);

      // The walk is over: "next" is the usual next-up again, not a walk step.
      rig.client.ask('d4', 'next one');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.walkAsks).toHaveLength(3);
    });

    it('next marks a moment heard but leaves a waiting brief open; skip only passes; what is left reads the map; accept acts on the focus space', async () => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      rig.client.ask('d2', "what's left?");
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain("What's left: Tango Desk: 1 needs you. Bike: 1 decided.");
      await speakThrough(rig);
      rig.client.ask('d3', 'next');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.seenCalls).toEqual([]); // the brief still waits on the owner
      expect(spoken(rig).at(-1)).toContain('Bike, decided for you');
      await speakThrough(rig);
      rig.client.ask('d4', 'accept');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.chapterActs).toEqual([{ spaceId: 'bike', how: 'accept' }]);
      await speakThrough(rig);

      // A fresh walk: skip leaves it unseen, next marks it heard.
      const again = standardDesk();
      walking(again, [11]);
      const rig2 = setup([], { desk: again });
      rig2.client.ask('e1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig2);
      rig2.client.ask('e2', 'next');
      await vi.advanceTimersByTimeAsync(2500);
      expect(again.seenCalls).toEqual([{ ids: [12, 13], via: 'heard', outcome: null }]);
      expect(spoken(rig2).at(-1)).toContain("you're caught up");
    });

    it('keeps the moment in focus when marking it seen fails', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      desk.seenResult = { ok: false, error: 'HTTP 500' };
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      rig.client.ask('d2', 'next');
      await vi.advanceTimersByTimeAsync(2500);
      // Played through (and its one retry), then next: all tried to mark it heard, and none got through.
      expect(desk.seenCalls).toEqual([{ ids: [12, 13], via: 'heard', outcome: null }, { ids: [12, 13], via: 'heard', outcome: null }, { ids: [12, 13], via: 'heard', outcome: null }]);
      expect(spoken(rig).at(-1)).toContain("Marking that one heard didn't go through, so it stays in focus.");
      expect(spoken(rig).join(' ')).not.toContain('HTTP 500');
      expect(spoken(rig).join(' ')).not.toContain("caught up");
      await speakThrough(rig);
      rig.client.ask('d3', 'got it');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain("Marking that one read didn't go through");
      await speakThrough(rig);
      desk.seenResult = { ok: true };
      rig.client.ask('d4', 'next');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain("you're caught up");
    });

    it('asks which project when a name fits more than one, and acts on none', async () => {
      const desk = standardDesk();
      walking(desk);
      const inner = desk.walkValue!;
      desk.walkValue = (ask) => {
        const w = inner(ask);
        return w && w !== 'off' ? { ...w, map: { ...w.map, look: [...w.map.look, { spaceId: 'voice', name: 'Tango Voice', summary: '1 shipped' }] } } : w;
      };
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      rig.client.ask('d2', 'accept tango');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.chapterActs).toEqual([]);
      expect(spoken(rig).at(-1)).toContain('More than one project fits: Tango Desk, Tango Voice. Ask which one.');
      await speakThrough(rig);
      rig.client.ask('d3', 'go to tango');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain('More than one project fits');
      await speakThrough(rig);
      rig.client.ask('d4', 'accept tango voice');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.chapterActs).toEqual([]); // A named chapter not heard yet must be read before acting.
      expect(spoken(rig).at(-1)).toContain('Hear it before accepting');
    });

    it('leaves a System incident to the System page: no Accept, Got it or seen from the walk', async () => {
      const desk = standardDesk();
      const incident = { spaceId: 'system', name: 'System', headline: null, line: { id: 31, ids: [31], kind: 'failed', title: 'Voice is down', detail: null, briefId: null, itemId: null, decisionId: null, waiting: false, rule: false }, brief: null };
      desk.walkValue = (ask) => (ask.skipped ?? []).includes(31) ? { focus: null, map: { needs: [], look: [], smaller: [] }, left: 0 } : { focus: incident, map: { needs: [], look: [{ spaceId: 'system', name: 'System', summary: '1 failed' }], smaller: [] }, left: 1 };
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain("System, failed: Voice is down. It's acked or snoozed on the System page.");
      await speakThrough(rig);
      for (const [id, words] of [['d2', 'accept'], ['d3', 'skip this project'], ['d4', 'got it']] as const) {
        rig.client.ask(id, words);
        await vi.advanceTimersByTimeAsync(2500);
        expect(spoken(rig).at(-1)).toContain('System incident: it is acked or snoozed on the System page');
        await speakThrough(rig);
      }
      expect(desk.chapterActs).toEqual([]);
      rig.client.ask('d5', 'next');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.seenCalls).toEqual([]);
      expect(spoken(rig).at(-1)).toContain("you're caught up");
    });

    it('takes that is fine on a rule event as Got it, never Fine by me on the decision under it', async () => {
      const desk = standardDesk();
      const rule = { spaceId: 'bike', name: 'Bike', headline: null, line: { id: 51, ids: [51], kind: 'decided', title: 'A new rule: merge at the review cap', detail: null, briefId: null, itemId: null, decisionId: 'D-7', waiting: false, rule: true }, brief: null };
      desk.walkValue = (ask) => (ask.skipped ?? []).includes(51) ? { focus: null, map: { needs: [], look: [], smaller: [] }, left: 0 } : { focus: rule, map: { needs: [], look: [{ spaceId: 'bike', name: 'Bike', summary: '1 decided' }], smaller: [] }, left: 1 };
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain('Say got it, or next.');
      await speakThrough(rig);
      rig.client.ask('d2', "that's fine");
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.confirmed).toEqual([]);
      expect(desk.seenCalls).toEqual([{ ids: [51], via: 'heard', outcome: null }, { ids: [51], via: 'read', outcome: 'got-it' }]);
      expect(spoken(rig).at(-1)).not.toContain('Noted.');
    });

    it('calls an Accept the desk never answers unknown, not failed, and stays on the moment', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      desk.chapterActHangs = true;
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      rig.client.ask('d2', 'accept');
      await vi.advanceTimersByTimeAsync(45_000);
      expect(spoken(rig).at(-1)).not.toContain("didn't answer in time");
      await vi.advanceTimersByTimeAsync(25_000);
      expect(spoken(rig).at(-1)).toContain("The desk didn't answer in time; it may still have gone through.");
      expect(spoken(rig).join(' ')).not.toContain("didn't go through");
      expect(desk.walkAsks).toHaveLength(1);
    });

    it('logs a failed Accept that reads as a timeout, though the owner hears no error', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      desk.chapterActResult = { ok: false, error: 'request timed out' };
      const logged: Array<{ event: string; data: unknown }> = [];
      const rig = setup([], { desk, log: (event, data) => logged.push({ event, data }) });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      rig.client.ask('d2', 'accept');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).at(-1)).toContain("The desk didn't answer in time");
      expect(spoken(rig).join(' ')).not.toContain('request timed out');
      expect(logged).toContainEqual({ event: 'catchup.chapter.failed', data: expect.objectContaining({ how: 'accept', error: 'request timed out' }) });
    });

    it('marks a moment heard once its read-back plays through, even if the walk stops there; never a waiting brief', async () => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      expect(desk.seenCalls).toEqual([]); // the brief waits on the owner
      rig.client.ask('d2', 'skip');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.seenCalls).toEqual([]); // not played yet
      await speakThrough(rig);
      expect(desk.seenCalls).toEqual([{ ids: [12, 13], via: 'heard', outcome: null }]);
      rig.client.ask('d3', "that's enough");
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.seenCalls).toHaveLength(1);
    });

    it('opens the System page on open system mid-walk, not a catch-up go to', async () => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      const asks = desk.walkAsks.length;
      rig.client.ask('d2', 'open the system page');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.walkAsks).toHaveLength(asks);
      expect(spoken(rig).join(' ')).not.toContain('Nothing left to catch up on');
    });

    it('calls a Fine by me the desk never answers unknown, not failed', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      desk.decidedConfirm = () => new Promise<never>(() => {});
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      const asks = desk.walkAsks.length;
      rig.client.ask('d2', "that's fine");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(spoken(rig).at(-1)).not.toContain('Fine by me');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(spoken(rig).at(-1)).toContain("The desk didn't answer in time; Fine by me may still have gone through.");
      expect(desk.walkAsks).toHaveLength(asks);
    });

    it('moves on when marking seen is only slow, and says it may come up again', async () => {
      const fresh = standardDesk();
      walking(fresh, [11]);
      fresh.updatesSeen = () => new Promise<never>(() => {});
      const rig2 = setup([], { desk: fresh });
      rig2.client.ask('e1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      rig2.client.ask('e2', 'got it');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(spoken(rig2).at(-1)).not.toContain('slow');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(spoken(rig2).at(-1)).toContain("The desk was slow to record that one, so it may come up again. That's everything: you're caught up.");
      expect(spoken(rig2).join(' ')).not.toContain("didn't go through");
    });

    it('retires a focus cut off by skip: never read again, never marked heard', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(spoken(rig).filter((t) => t.includes('Bike, decided for you'))).toHaveLength(1);
      // Skip before the read-back plays: it goes, and the walk moves on.
      rig.client.ask('d2', 'skip');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spoken(rig).filter((t) => t.includes('Bike, decided for you'))).toHaveLength(1);
      expect(desk.seenCalls).toEqual([]);
      expect(spoken(rig).at(-1)).toContain("you're caught up");
    });

    it('never marks heard a focus the owner said skip over, though the word lands before the command', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) rig.playback.enqueue(LOUD);
      rig.client.operator('Bike, decided for you');
      for (let i = 0; i < 6; i++) {
        rig.userActivity.observe(LOUD, Date.now()); // "skip", over the read-back
        if (i === 1) rig.client.user('skip');
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(7000);
      expect(desk.seenCalls).toEqual([]);
      rig.client.emit('delegation', { id: 'd2', offsetMs: 0 });
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      expect(desk.seenCalls).toEqual([]);
      expect(spoken(rig).at(-1)).toContain("you're caught up");
    });

    it('starts a fresh walk after one left for half an hour: what it skipped comes up again', async () => {
      const desk = standardDesk();
      walking(desk);
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d2', 'skip');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.walkAsks.at(-1)?.skipped?.length).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      rig.client.ask('d3', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(desk.walkAsks.at(-1)?.skipped).toEqual([]);
      expect(spoken(rig).at(-1)).toContain('Catching you up one thing at a time');
    });

    it('retries a heard mark the desk refuses after playback, then says it may come up again', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      const calls: number[][] = [];
      desk.updatesSeen = async (ids) => (calls.push(ids), { ok: false as const, error: 'HTTP 500' });
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toEqual([[12, 13], [12, 13]]);
      expect(spoken(rig).at(-1)).toContain("Marking that one heard didn't go through, so it may come up again.");
      expect(spoken(rig).join(' ')).not.toContain('HTTP 500');
    });

    it('drops the heard retry when the owner skips meanwhile', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      const calls: number[][] = [];
      desk.updatesSeen = async (ids) => (calls.push(ids), calls.length === 1 ? { ok: false as const, error: 'HTTP 500' } : { ok: true as const });
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 5; i++) rig.playback.enqueue(LOUD);
      for (let t = 0; t < 40 && calls.length === 0; t++) await vi.advanceTimersByTimeAsync(250);
      expect(calls).toEqual([[12, 13]]);
      rig.client.ask('d2', 'skip'); // inside the retry's two seconds
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toEqual([[12, 13]]);
      expect(spoken(rig).join(' ')).not.toContain("didn't go through");
    });

    it('a heard mark that goes through on its retry says nothing', async () => {
      const desk = standardDesk();
      walking(desk, [11]);
      let tries = 0;
      desk.updatesSeen = async () => (++tries === 1 ? { ok: false as const, error: 'HTTP 500' } : { ok: true as const });
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      await vi.advanceTimersByTimeAsync(3000);
      expect(tries).toBe(2);
      expect(spoken(rig).join(' ')).not.toContain("didn't go through");
    });

    it('says so when the walk cannot be read, and reads the briefing on a desk without the ledger', async () => {
      const desk = standardDesk();
      desk.walkValue = () => null;
      const rig = setup([], { desk });
      rig.client.ask('d1', 'catch me up');
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain("couldn't reach the desk");
    });
  });

  describe('speaking unprompted', () => {
    const soon = () => new Date(Date.now() + 10 * 60_000).toISOString();

    it('does not knock for Stuck without a failed turn, matching its when-asked policy', async () => {
      const contract = JSON.parse(readFileSync(new URL('./fixtures/desk-contract.json', import.meta.url), 'utf8'));
      expect(contract.policies.pills.stuck.policy).toBe('when asked');
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      rig.desk.list.push(deskItem('stalled', 'malibu', { nextStep: 'fyi' }));
      rig.desk.agentPosts('stalled', 'I will keep going.', {
        nextStep: 'failed',
        status: { pill: 'stuck', move: 'failed', live: 'failed', busy: null, audience: 'owner', countsForOwner: true },
        lastAgentMessageId: 'stalled-new',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said(rig.client)).toBe('');
      rig.operator.stop();
    });

    it.each(['lead', 'seen', 'retired'] as const)('drops a queued knock when the ask becomes %s before the break', async (change) => {
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      const item = deskItem('pending', 'malibu', { nextStep: 'fyi' });
      rig.desk.list.push(item);
      rig.desk.agentPosts('pending', 'Choose?', { nextStep: 'your_move', ask: 'Choose?', lastAgentMessageId: 'new' });
      rig.desk.update('pending', change === 'seen' ? { seen: 'seen' } : { status: { pill: 'waiting', move: null, busy: null, countsForOwner: false, audience: change === 'lead' ? 'lead' : 'owner' } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said(rig.client)).not.toContain('has something for you');
    });

    it('rechecks each queued knock and names only the remaining owner ask', async () => {
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      for (const [id, agent] of [['one', 'malibu'], ['two', 'sierra']]) {
        rig.desk.list.push(deskItem(id!, agent!, { nextStep: 'fyi' }));
        rig.desk.agentPosts(id!, 'Choose?', { nextStep: 'your_move', ask: 'Choose?', lastAgentMessageId: 'new' });
      }
      rig.desk.update('one', { seen: 'seen' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said(rig.client)).toContain('Sierra has something for you');
      expect(said(rig.client)).not.toContain('Malibu has something');
    });

    it('speaks a your-move item with a deadline coming up, once, with deadline in the urgent lane', async () => {
      const rig = setup([], { urgentLane: ['deadline'] });
      rig.desk.list.push(deskItem('discord:chapter:mal', 'malibu', { nextStep: 'fyi' }));
      rig.desk.agentPosts('discord:chapter:mal', 'Pick a dinner before 6?', { nextStep: 'your_move', ask: 'Pick a dinner before 6?', summary: { gist: 'Dinner choice', watchUntil: soon() }, lastAgentMessageId: 'mal-2' });
      await vi.advanceTimersByTimeAsync(2500);
      // Only a knock, at a break: never the content.
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('Malibu has something for you.');
      expect(said(rig.client)).not.toContain('Pick a dinner');
      await speakThrough(rig, 'Malibu has something for you.');
      expect(rig.desk.sent('heard')).toEqual([]); // knocking is not hearing it
      rig.desk.update('discord:chapter:mal', {}); // another event for the same message
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rig.client.appends.filter((a) => a.content.includes('has something for you'))).toHaveLength(1);
    });

    it('knocks once per unseen needs-you item: more turns do not knock again until the owner has seen it', async () => {
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      const knocks = () => rig.client.appends.filter((a) => a.content.includes('has something for you')).length;
      rig.desk.list.push(deskItem('discord:chapter:mal', 'malibu', { nextStep: 'fyi' }));
      rig.desk.agentPosts('discord:chapter:mal', 'Pick a dinner?', { nextStep: 'your_move', ask: 'Pick a dinner?', lastAgentMessageId: 'mal-2' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(knocks()).toBe(1);
      await speakThrough(rig, 'Malibu has something for you.');
      // More turns on the same unseen item: no second knock.
      rig.desk.agentPosts('discord:chapter:mal', 'Or a lunch?', { nextStep: 'your_move', ask: 'Or a lunch?', lastAgentMessageId: 'mal-3' });
      await vi.advanceTimersByTimeAsync(60_000);
      rig.desk.agentPosts('discord:chapter:mal', 'Still there?', { nextStep: 'your_move', ask: 'Still there?', lastAgentMessageId: 'mal-4' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(knocks()).toBe(1);
      // The owner sees it; a later unseen turn is worth a fresh knock.
      rig.desk.update('discord:chapter:mal', { seen: 'seen' });
      await vi.advanceTimersByTimeAsync(5000);
      rig.desk.agentPosts('discord:chapter:mal', 'One more thing?', { nextStep: 'your_move', ask: 'One more thing?', seen: 'updated', lastAgentMessageId: 'mal-5' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(knocks()).toBe(2);
      await speakThrough(rig, 'Malibu has something for you.');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(knocks()).toBe(2);
    });

    it('names the thread first when relaying a threaded update, in speakable form', async () => {
      expect(spokenThread('acme · watch: Publishing Flow')).toBe('Publishing Flow');
      expect(spokenThread('tango · bug:Fix Slack-Reported Bugs')).toBe('Fix Slack-Reported Bugs');
      expect(spokenThread('Bike Turn Signal')).toBe('Bike Turn Signal');
      expect(spokenThread(null)).toBeNull();
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      rig.desk.list.push(deskItem('discord:thread:wk', 'malibu', { nextStep: 'working', place: 'ops: Meal Plan' }));
      rig.desk.messages.set('discord:thread:wk', [{ author: 'owner', text: 'Swap lunch.', at: Date.now() - 60_000 }]);
      rig.desk.agentPosts('discord:thread:wk', 'Swapped lunch for the salad.', { nextStep: 'fyi', lastAgentMessageId: 'wk-9' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('In the Meal Plan thread');
    });

    it("relays an answer to the owner's message in this voice session even when another operator sent it (operator restart, 10/06)", async () => {
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      rig.desk.list.push(deskItem('discord:thread:wk', 'malibu', { nextStep: 'working', place: 'Workout Redesign' }));
      // Sent by voice before a restart: this session has no task for it.
      rig.desk.messages.set('discord:thread:wk', [{ author: 'owner', text: 'Swap curls for chin-ups.', at: Date.now() - 60_000 }]);
      rig.desk.agentPosts('discord:thread:wk', 'Swapped. Push-ups replace the fly on B.', { nextStep: 'fyi', lastAgentMessageId: 'wk-2' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('Swapped. Push-ups replace the fly on B.');
      await speakThrough(rig);
      const spoken = said(rig.client).match(/Swapped\./g)!.length;
      rig.desk.update('discord:thread:wk', {}); // a later event for the same answer is not spoken again
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said(rig.client).match(/Swapped\./g)).toHaveLength(spoken);
    });

    it('never relays unprompted from hidden or filtered items, or from Loom threads it did not write to (live test 10/06)', async () => {
      const rig = setup([]);
      const recent = Date.now() - 60_000;
      rig.desk.list.push(
        deskItem('discord:thread:hid', 'malibu', { nextStep: 'working', hidden: true }),
        deskItem('discord:thread:filt', 'malibu', { nextStep: 'working', filteredBy: [{ kind: 'agent', value: 'malibu' }] }),
        deskItem('loom:orch', 'loom', { nextStep: 'working', place: 'demo · bug: Flaky test' }),
      );
      for (const id of ['discord:thread:hid', 'discord:thread:filt', 'loom:orch']) {
        rig.desk.messages.set(id, [{ author: 'owner', text: 'Status?', at: recent }]); // on Loom: the orchestrator thread, not the owner
        rig.desk.agentPosts(id, `Technical detail for ${id}.`, { nextStep: 'fyi', lastAgentMessageId: `${id}-2` });
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rig.client.appends).toEqual([]);
    });

    it('does not relay answers to owner messages from before the session started', async () => {
      const rig = setup([]);
      rig.desk.list.push(deskItem('discord:thread:old', 'malibu', { nextStep: 'working' }));
      rig.desk.messages.set('discord:thread:old', [{ author: 'owner', text: 'Old ask.', at: Date.now() - 40 * 60_000 }]);
      rig.desk.agentPosts('discord:thread:old', 'Late reply.', { nextStep: 'fyi', lastAgentMessageId: 'old-2' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rig.client.appends).toEqual([]);
    });

    it('stays quiet for desk items without a deadline, far-off deadlines, FYIs and seen items', async () => {
      const rig = setup([]);
      const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
      rig.desk.list.push(
        deskItem('a', 'malibu', { nextStep: 'your_move', ask: 'No deadline here?' }),
        deskItem('b', 'malibu', { nextStep: 'your_move', ask: 'Far off?', summary: { gist: '', watchUntil: later } }),
        deskItem('c', 'malibu', { nextStep: 'fyi', summary: { gist: 'Logged lunch.', watchUntil: soon() } }),
        deskItem('d', 'malibu', { nextStep: 'your_move', seen: 'seen', ask: 'Already seen?', summary: { gist: '', watchUntil: soon() } }),
      );
      for (const id of ['a', 'b', 'c', 'd']) rig.desk.update(id, {});
      await vi.advanceTimersByTimeAsync(3000);
      // The two your-move items are one knock; no content, and nothing for the FYI or the seen item.
      expect(rig.client.appends.filter((append) => append.content.includes('has something for you'))).toHaveLength(1);
      expect(said(rig.client)).not.toMatch(/No deadline|Far off|Logged lunch|Already seen/);
    });

    it('speaks what was already due on the desk when the call starts, with deadline in the urgent lane', async () => {
      const desk = standardDesk();
      desk.list.push(deskItem('due', 'sierra', { nextStep: 'your_move', ask: 'Book the campsite before it goes?', summary: { gist: '', due: soon() } }));
      const rig = setup([], { desk, urgentLane: ['deadline'] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(said(rig.client)).toContain('Sierra has something for you.');
      expect(said(rig.client)).not.toContain('campsite');
    });

    it('a session starts clear: nothing due, waiting or new on the desk is spoken unless asked (TGO-1050)', async () => {
      const desk = standardDesk();
      desk.list.push(deskItem('due', 'sierra', { nextStep: 'your_move', ask: 'Book the campsite before it goes?', summary: { gist: '', due: soon() } }));
      const rig = setup([], { desk });
      await vi.advanceTimersByTimeAsync(2500);
      rig.desk.list.push(deskItem('discord:chapter:mal', 'malibu', { nextStep: 'fyi' }));
      rig.desk.agentPosts('discord:chapter:mal', 'Pick a dinner before 6?', { nextStep: 'your_move', ask: 'Pick a dinner before 6?', summary: { gist: '', watchUntil: soon() }, lastAgentMessageId: 'mal-2' });
      await vi.advanceTimersByTimeAsync(3000);
      // Only a knock for the new needs-you item; the ask, and what was already on the desk, stay unsaid.
      expect(rig.client.appends.filter((append) => append.content.includes('has something for you'))).toHaveLength(1);
      expect(said(rig.client)).toContain('Malibu has something for you.');
      expect(said(rig.client)).not.toMatch(/Pick a dinner|campsite/);
    });

    it('relays the answer to an owner message from earlier in a long session (no 15-minute cap)', async () => {
      const rig = setup([], { sessionStartedAt: Date.now() - 60 * 60_000 });
      rig.desk.list.push(deskItem('discord:thread:mt', 'sierra', { nextStep: 'working', place: 'Bike Turn Signal' }));
      rig.desk.messages.set('discord:thread:mt', [{ author: 'owner', text: 'The reading is 5 V.', at: Date.now() - 40 * 60_000 }]);
      rig.desk.agentPosts('discord:thread:mt', 'That rules out the wiring; check the bulb next.', { nextStep: 'your_move', lastAgentMessageId: 'mt-2' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('That rules out the wiring');
    });

    it("speaks one answer per owner message: the thread's later turns are not answers (TGO-1050)", async () => {
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      rig.desk.list.push(deskItem('discord:thread:roles', 'sierra', { nextStep: 'working', place: 'Thread roles' }));
      rig.desk.messages.set('discord:thread:roles', [{ author: 'owner', text: 'Should a lead be lighter?', at: Date.now() - 60_000 }]);
      rig.desk.agentPosts('discord:thread:roles', 'Yes: a lead answers and routes, it does not build.', { nextStep: 'fyi', lastAgentMessageId: 'r-2' });
      await vi.advanceTimersByTimeAsync(2500);
      await speakThrough(rig);
      expect(said(rig.client)).toContain('a lead answers and routes');
      // Mail wakes it and it reports progress: not the owner's to hear.
      rig.desk.messages.set('discord:thread:roles', [...rig.desk.messages.get('discord:thread:roles')!, { author: 'owner', text: 'From the lead: go ahead.', at: Date.now(), meta: { mail: true } }]);
      await vi.advanceTimersByTimeAsync(1000);
      rig.desk.agentPosts('discord:thread:roles', 'Space defaults set; PR 691 rebased, CI running.', { nextStep: 'fyi', lastAgentMessageId: 'r-4' });
      await vi.advanceTimersByTimeAsync(10_000);
      rig.desk.agentPosts('discord:thread:roles', 'Both checks passed.', { nextStep: 'fyi', lastAgentMessageId: 'r-5' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said(rig.client)).not.toContain('PR 691');
      expect(said(rig.client)).not.toContain('Both checks passed');
      // The owner writes again: that answer is theirs.
      rig.desk.messages.set('discord:thread:roles', [...rig.desk.messages.get('discord:thread:roles')!, { author: 'owner', text: 'Is it live?', at: Date.now() }]);
      await vi.advanceTimersByTimeAsync(1000);
      rig.desk.agentPosts('discord:thread:roles', 'Live since 6:10.', { nextStep: 'fyi', lastAgentMessageId: 'r-7' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('Live since 6:10.');
    });

    it("relays a Loom thread's answer to the owner's own words this session, never to mail or a desk start (TGO-1050)", async () => {
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      rig.desk.list.push(deskItem('loom:audio', 'loom', { nextStep: 'working', place: 'tango · Discord Voice Audio Not Working' }), deskItem('loom:started', 'loom', { nextStep: 'working', place: 'tango · Laguna hub' }));
      rig.desk.messages.set('loom:audio', [{ author: 'owner', text: "I'm connected but don't hear talking.", at: Date.now() - 60_000 }]);
      rig.desk.messages.set('loom:started', [{ author: 'owner', text: '✉️ Mail from “Integration lead” [loom:x] · m-1\n\nBuild the hub.', at: Date.now() - 60_000, meta: { mail: { kind: 'in', peer: 'Integration lead' } } }]);
      rig.desk.agentPosts('loom:started', 'Hub scaffolded; tests running.', { nextStep: 'fyi', lastAgentMessageId: 's-2' });
      rig.desk.agentPosts('loom:audio', "I restarted the voice operator; it's hearing you again.", { nextStep: 'your_move', lastAgentMessageId: 'a-2' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain("it's hearing you again");
      expect(said(rig.client)).not.toContain('Hub scaffolded');
    });

    describe('voice stays quiet about work the owner did not ask about (noisy session 10/19)', () => {
      const askLoom = (rig: Rig, id: string, extra: Record<string, unknown> = {}) => {
        rig.desk.list.push(deskItem(id, 'loom', { nextStep: 'working', place: 'tango · Catch-up build', ...extra }));
        rig.desk.messages.set(id, [{ author: 'owner', text: 'How is the build going?', at: Date.now() - 60_000 }]);
        rig.desk.agentPosts(id, 'TGO-1102 is live; PR 825 merged after CI checks passed.', { nextStep: 'fyi', lastAgentMessageId: `${id}-2` });
      };

      it('says an asked-for reply in plain words: no ticket or PR numbers, told to say it in one sentence', async () => {
        const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
        askLoom(rig, 'loom:build');
        await vi.advanceTimersByTimeAsync(2500);
        const heard = said(rig.client);
        expect(heard).toContain('the ticket is live; the PR merged');
        expect(heard).not.toMatch(/TGO-1102|PR 825/);
        expect(heard).toContain('one plain sentence');
      });

      it('holds work news while the owner is logging food with a personal agent', async () => {
        const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Logged.', afterMs: 120_000 }] });
        const rig = setup([[{ type: 'dispatch', agentId: 'foxtrot', message: 'Log a protein shake.' }]], { backend, sessionStartedAt: Date.now() - 5 * 60_000 });
        rig.client.ask('d1', 'log a protein shake');
        await vi.advanceTimersByTimeAsync(3000);
        const before = said(rig.client);
        askLoom(rig, 'loom:build');
        await vi.advanceTimersByTimeAsync(2500);
        expect(said(rig.client)).toBe(before);
        expect(said(rig.client)).not.toContain('is live');
      });

      it('knocks instead of reading when an exchange is open, and only after the reply he is waiting for', async () => {
        const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Set one is logged.', afterMs: 90_000 }] });
        const rig = setup([[{ type: 'dispatch', agentId: 'foxtrot', message: 'Log set one.' }]], { backend, sessionStartedAt: Date.now() - 5 * 60_000 });
        rig.client.ask('d1', 'log set one');
        await vi.advanceTimersByTimeAsync(3000);
        rig.desk.projectList = [{ id: 'proj-a', name: 'Notifications' }, { id: 'proj-b', name: 'Acme' }];
        askLoom(rig, 'loom:build', { facts: { projectId: 'proj-a' } });
        askLoom(rig, 'loom:other', { place: 'tango · Other build', facts: { projectId: 'proj-b' } });
        await vi.advanceTimersByTimeAsync(40_000);
        // The exchange is open: no knock, and certainly no content.
        expect(said(rig.client)).not.toMatch(/something for you|is live|the ticket/);
        // The reply he was waiting for comes first, in full.
        for (let i = 0; i < 90 && !said(rig.client).includes('Set one is logged.'); i++) await vi.advanceTimersByTimeAsync(1000);
        await speakThrough(rig, 'Set one is logged.');
        expect(said(rig.client)).toContain('Set one is logged.');
        expect(said(rig.client)).not.toMatch(/something for you/);
        // Then, at a real break, one knock for both spaces, with none of the content.
        await vi.advanceTimersByTimeAsync(60_000);
        // He is still lifting: ten quiet minutes later the exchange is over.
        for (let i = 0; i < 700 && !said(rig.client).includes('have something for you'); i++) await vi.advanceTimersByTimeAsync(1000);
        expect(rig.client.appends.filter((a) => a.content.includes('Notifications and Acme have something for you.'))).toHaveLength(1);
        expect(said(rig.client)).not.toMatch(/is live|PR 825|TGO-1102/);
        await speakThrough(rig, 'Notifications and Acme have something for you.');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(rig.client.appends.filter((a) => a.content.includes('something for you'))).toHaveLength(1);
      });

      it('never speaks for a snoozed or parked space, but does once it wakes', async () => {
        const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
        rig.desk.projectList = [{ id: 'proj-a', name: 'Acme', away: { state: 'snoozed', until: Date.now() + 3_600_000 } }, { id: 'proj-b', name: 'Side', away: { state: 'parked' } }];
        askLoom(rig, 'loom:a', { facts: { projectId: 'proj-a' } });
        askLoom(rig, 'loom:b', { facts: { projectId: 'proj-b' } });
        await vi.advanceTimersByTimeAsync(2500);
        expect(rig.client.appends).toEqual([]);
        rig.desk.projectList = [{ id: 'proj-a', name: 'Acme', away: { state: 'snoozed', until: Date.now() - 1 } }];
        rig.desk.agentPosts('loom:a', 'The build is live.', { nextStep: 'fyi', lastAgentMessageId: 'loom:a-3' });
        await vi.advanceTimersByTimeAsync(2500);
        expect(said(rig.client)).toContain('The build is live.');
      });

      it("does not treat a tapped decision answer as something said to the thread", async () => {
        const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
        rig.desk.list.push(deskItem('loom:dec', 'loom', { nextStep: 'working', place: 'tango · Status audit' }));
        rig.desk.messages.set('loom:dec', [{ author: 'owner', text: 'Decision D-73: Run on Work? I chose C: use Work.', at: Date.now() - 60_000 }]);
        rig.desk.agentPosts('loom:dec', 'Checking tomorrow.', { nextStep: 'fyi', lastAgentMessageId: 'dec-2' });
        await vi.advanceTimersByTimeAsync(2500);
        expect(rig.client.appends).toEqual([]);
      });
    });

    it('never relays answers to what the owner typed while voice slept, nor to mail Loom wrote with no meta (TGO-1050)', async () => {
      const now = Date.now();
      const rig = setup([], { sessionStartedAt: now - 3 * 3_600_000, asleepAt: (at) => at >= now - 2 * 3_600_000 && at < now - 1000 });
      rig.desk.list.push(
        deskItem('loom:typed', 'loom', { nextStep: 'working', place: 'tango · Resource audit' }),
        deskItem('loom:lead', 'loom', { nextStep: 'working', place: 'tango · Desk lead' }),
        deskItem('loom:awake', 'loom', { nextStep: 'working', place: 'tango · Socket check' }),
      );
      rig.desk.messages.set('loom:typed', [{ author: 'owner', text: 'Did you check with the rollout thread?', at: now - 90 * 60_000 }]);
      rig.desk.messages.set('loom:lead', [{ author: 'owner', text: '✉️ Reply from “Build thread” [loom:x] · m-1\n\nShipped.', at: now - 150 * 60_000 }]);
      rig.desk.messages.set('loom:awake', [{ author: 'owner', text: 'Check the socket.', at: now - 150 * 60_000 }]);
      rig.desk.agentPosts('loom:typed', 'Yes, and most of it is in the spec.', { nextStep: 'fyi', lastAgentMessageId: 't-2' });
      rig.desk.agentPosts('loom:lead', 'The catch-up piece is live.', { nextStep: 'fyi', lastAgentMessageId: 'l-2' });
      rig.desk.agentPosts('loom:awake', 'The socket reads 12 V.', { nextStep: 'fyi', lastAgentMessageId: 'a-2' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain('12 V');
      expect(said(rig.client)).not.toContain('in the spec');
      expect(said(rig.client)).not.toContain('catch-up piece');
    });

    it("never relays the answer to an intake thread's form request, only to the owner's own reply there", async () => {
      const id = 'discord:intake:100000000000000301:100000000000000302';
      const rig = setup([], { sessionStartedAt: Date.now() - 5 * 60_000 });
      rig.desk.list.push(deskItem(id, 'malibu', { nextStep: 'working', place: 'Website request' }));
      rig.desk.messages.set(id, [{ author: 'owner', messageId: '100000000000000302', text: 'Change of plans: a different opening speaker on Sunday.', at: Date.now() - 60_000 }]);
      rig.desk.agentPosts(id, 'Speaker change staged.', { nextStep: 'fyi', lastAgentMessageId: 'p-2' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.client.appends).toEqual([]);
      rig.desk.messages.set(id, [...rig.desk.messages.get(id)!, { author: 'owner', messageId: '100000000000000303', text: 'Promote and send the emails.', at: Date.now() }]);
      await vi.advanceTimersByTimeAsync(1000);
      rig.desk.agentPosts(id, 'Promoted; the weekly email went out to the list.', { nextStep: 'fyi', lastAgentMessageId: 'p-4' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('the weekly email went out to the list');
    });

    it("a watched reply answers the owner's turn: the thread's later progress is not a second answer (Codex review on #728)", async () => {
      const desk = standardDesk();
      desk.list.push(deskItem('loom:socket', 'loom', { nextStep: 'fyi', place: 'tango · Socket check' }));
      const rig = setup([[{ type: 'desk', op: 'reply', item: 'i3', message: 'Check the socket.' }]], { desk });
      rig.client.ask('d1', 'tell the socket thread to check the socket');
      await vi.advanceTimersByTimeAsync(3000);
      expect(rig.desk.sent('reply')).toHaveLength(1);
      // The desk records the owner's reply, then the agent answers.
      rig.desk.messages.set('loom:socket', [{ author: 'owner', text: 'Check the socket.', at: Date.now() }]);
      await vi.advanceTimersByTimeAsync(1000);
      rig.desk.agentPosts('loom:socket', 'The socket reads 12 V.', { nextStep: 'fyi', lastAgentMessageId: 'w-2' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain('12 V');
      await speakThrough(rig);
      rig.desk.agentPosts('loom:socket', 'Also logged the reading in the notes.', { nextStep: 'fyi', seen: 'new', lastAgentMessageId: 'w-3' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said(rig.client)).not.toContain('logged the reading');
    });

    it('answered owner turns are shared across brains: a replacement operator does not answer them again (Codex review on #728)', async () => {
      const answeredTurns = new Set<string>();
      const start = Date.now() - 5 * 60_000;
      const first = setup([], { sessionStartedAt: start, answeredTurns });
      first.desk.list.push(deskItem('discord:thread:wk', 'malibu', { nextStep: 'working', place: 'Workout Redesign' }));
      first.desk.messages.set('discord:thread:wk', [{ author: 'owner', text: 'Swap curls for chin-ups.', at: Date.now() - 60_000 }]);
      first.desk.agentPosts('discord:thread:wk', 'Swapped.', { nextStep: 'fyi', lastAgentMessageId: 'wk-2' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(first.client)).toContain('Swapped.');
      first.operator.stop();
      const second = setup([], { desk: first.desk, sessionStartedAt: start, answeredTurns });
      second.desk.agentPosts('discord:thread:wk', 'Progress: B day rebuilt.', { nextStep: 'fyi', seen: 'new', lastAgentMessageId: 'wk-3' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(second.client.appends).toEqual([]);
    });

    it('reads the urgent lane from TANGO_OPERATOR_URGENT', () => {
      expect(parseUrgentLane(undefined)).toEqual([]);
      expect(parseUrgentLane('')).toEqual([]);
      expect(parseUrgentLane('deadline, scene,bogus')).toEqual(['deadline', 'scene']);
    });

    it("speaks a failure of this session's own request that only the desk saw", async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [] }); // the backend never answers
      const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Check the socket', threadId: THREAD }]], { backend });
      rig.client.ask('d1', 'have sierra check the socket');
      await vi.advanceTimersByTimeAsync(2500);
      rig.desk.update(`discord:thread:${THREAD}`, { nextStep: 'failed', facts: { failed: { at: Date.now(), reason: 'timeout', message: 'The turn timed out' } } });
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('the turn failed (timeout: The turn timed out). Offer to retry it.');
    });

    it('knows a deadline from due, watchUntil or a job deadline', () => {
      expect(deadlineOf({ summary: { gist: '', watchUntil: '2026-10-06T18:00:00Z' } })).toBe(Date.parse('2026-10-06T18:00:00Z'));
      expect(deadlineOf({ due: 5 })).toBe(5);
      expect(deadlineOf({ facts: { job: { label: 'x', deadlineAt: 9 } } })).toBe(9);
      expect(deadlineOf({ summary: { gist: '' } })).toBeNull();
    });
  });

  describe('presentation', () => {
    it("sending to an agent leaves the board up (opening a conversation is a request), and the destination is confirmed after routing", async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [] });
      const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Check the socket', threadId: THREAD }]], { backend });
      rig.client.ask('d1', 'have sierra check the socket');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.screen.intents).toEqual([]);
      expect(rig.client.appends).toContainEqual({ kind: 'instructions', delegationId: 'd1', content: expect.stringContaining('Routed to Sierra in the "Bike Turn Signal" thread') });
    });

    it('Done puts the board back up even when the scene on screen has no conversation key (live test 10/06)', async () => {
      const rig = setup([[{ type: 'desk', op: 'done', item: 'i1' }]]);
      rig.screen.presented = { view: 'screen', itemId: null, conversationKey: 'agent:sierra', sceneId: 's1' };
      rig.client.ask('d1', 'mark that thread as done for now');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.screen.intents).toContainEqual({ view: 'active', reason: 'done' });
    });

    it('sending a message from the Screen or Conversation view puts the board back up (live test 10/06)', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [] });
      const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Is that plan applied?', threadId: THREAD }]], { backend });
      rig.screen.presented = { view: 'screen', itemId: null, conversationKey: `thread:${THREAD}`, sceneId: 's1' };
      rig.client.ask('d1', 'did sierra apply that plan or just show it');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.screen.intents).toContainEqual({ view: 'active', reason: 'sent' });
    });

    it('"show the board" and "show the screen" are the owner\'s picks, resolved without the model', async () => {
      const rig = setup([]);
      rig.screen.presented = { view: 'conversation', itemId: 'x', conversationKey: `thread:${THREAD}`, sceneId: null };
      rig.client.ask('d1', 'show the screen');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d2', 'okay, back to the board');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.screen.intents).toEqual([
        { view: 'screen', reason: 'user', conversationKey: `thread:${THREAD}` },
        { view: 'active', reason: 'user' },
      ]);
      expect(rig.seen).toHaveLength(0);
    });

    it('says so when there is no scene for the Screen view', async () => {
      const rig = setup([]);
      rig.screen.refuse = true;
      rig.client.ask('d1', 'show me the screen');
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('Nothing is staged on the screen for this conversation');
    });

    it('two minutes after the call goes idle, the screens go back to the board, once', async () => {
      const rig = setup([], { idleBoardMs: 120_000 });
      rig.screen.presented = { view: 'conversation', itemId: 'x', conversationKey: 'thread:x', sceneId: null };
      await vi.advanceTimersByTimeAsync(110_000);
      expect(rig.screen.intents).toEqual([]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(rig.screen.intents).toEqual([{ view: 'active', reason: 'idle' }]);
      rig.screen.presented = { view: 'conversation', itemId: 'x', conversationKey: 'thread:x', sceneId: null };
      await vi.advanceTimersByTimeAsync(200_000);
      expect(rig.screen.intents).toHaveLength(1);
    });

    it('a staged screen stays up 10 minutes idle, not 2', async () => {
      const rig = setup([], { idleBoardMs: 120_000 });
      rig.screen.presented = { view: 'screen', itemId: null, conversationKey: 'agent:foxtrot', sceneId: 's1' };
      await vi.advanceTimersByTimeAsync(300_000);
      expect(rig.screen.intents).toEqual([]);
      await vi.advanceTimersByTimeAsync(320_000);
      expect(rig.screen.intents).toEqual([{ view: 'active', reason: 'idle' }]);
    });

    it('does not go idle while an agent is still working', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [] });
      const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Long research' }]], { backend, idleBoardMs: 120_000 });
      rig.client.ask('d1', 'have sierra research it');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(rig.screen.intents.filter((intent) => intent.reason === 'idle')).toEqual([]);
    });

    it('scene shows say why: a result is automatic focus, "show me" is the owner\'s pick', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Three speakers staged.', afterMs: 100 }] });
      const screen = new FakeDeskScreen();
      const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Compare speakers' }], [{ type: 'screen', op: 'show', agentId: 'sierra' }]], { backend, screen });
      rig.client.ask('d1', 'compare speakers');
      await vi.advanceTimersByTimeAsync(50);
      screen.scenes = [scene('s1', 'sierra', { updatedAt: Date.now() + 10 })];
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.shows[0]).toEqual({ id: 's1', reason: 'focus' });
      screen.current = null;
      rig.client.ask('d2', "put sierra's speaker list up");
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.shows.at(-1)).toEqual({ id: 's1', reason: 'user' });
    });
  });

  describe('deterministic target resolution', () => {
    it('resolves the Conversation view item, a named agent, or the last discussed item', async () => {
      const desk = standardDesk();
      desk.list.push(deskItem('discord:chapter:sierra', 'sierra', { nextStep: 'fyi' }));
      const rig = setup([[{ type: 'desk', op: 'read', item: 'i1' }]], { desk });
      expect(rig.operator.resolveTarget('mark it done')).toBeNull(); // nothing in focus, nothing discussed
      expect(rig.operator.resolveTarget('mark the foxtrot one done')).toBe('discord:chapter:fox');
      expect(rig.operator.resolveTarget('mark the sierra one done')).toBeNull(); // two Sierra items
      expect(rig.operator.resolveTarget('foxtrot and sierra')).toBeNull();
      rig.screen.presented = { view: 'conversation', itemId: `discord:thread:${THREAD}`, conversationKey: `thread:${THREAD}`, sceneId: null };
      expect(rig.operator.resolveTarget('mark it done')).toBe(`discord:thread:${THREAD}`);
      expect(rig.operator.resolveTarget('mark the sierra one done')).toBe(`discord:thread:${THREAD}`); // the focused one is Sierra's
      rig.screen.presented = { view: 'active', itemId: null, conversationKey: null, sceneId: null };
      rig.client.ask('d1', 'what did foxtrot need');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.operator.resolveTarget('mark that done')).toBe('discord:chapter:fox'); // last discussed
    });

    it('a short command on the item in focus goes straight to the desk without the model', async () => {
      const rig = setup([]);
      rig.screen.presented = { view: 'conversation', itemId: 'discord:chapter:fox', conversationKey: 'channel:home-foxtrot', sceneId: null };
      rig.client.ask('d1', 'mark that done');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d2', 'snooze it until they post');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d3', "snooze it until I'm at my desk");
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d4', 'snooze it');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d5', 'snooze that one');
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen).toHaveLength(0);
      expect(rig.desk.commands.map(({ type, itemId, args }) => ({ type, itemId, args }))).toEqual([
        { type: 'done', itemId: 'discord:chapter:fox', args: {} },
        { type: 'snooze', itemId: 'discord:chapter:fox', args: { trigger: 'agent_posts' } },
        { type: 'snooze', itemId: 'discord:chapter:fox', args: { trigger: 'desk' } },
        { type: 'snooze', itemId: 'discord:chapter:fox', args: { trigger: 'agent_posts' } },
        { type: 'snooze', itemId: 'discord:chapter:fox', args: { trigger: 'agent_posts' } },
      ]);
    });

    it('"tell Foxtrot that\'s done" is a message for the model to route, not a mark', async () => {
      const rig = setup([]);
      rig.screen.presented = { view: 'conversation', itemId: 'discord:chapter:fox', conversationKey: 'channel:home-foxtrot', sceneId: null };
      rig.client.ask('d1', "tell foxtrot that's done");
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen).toHaveLength(1);
      expect(rig.desk.commands).toEqual([]);
    });

    it('ambiguous targets and snoozes to a time go to the model', async () => {
      const desk = standardDesk();
      desk.list.push(deskItem('discord:chapter:sierra', 'sierra'));
      const rig = setup([], { desk });
      rig.client.ask('d1', 'mark the sierra one done');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d2', 'snooze the foxtrot one till 3');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d3', 'snooze the foxtrot one after lunch');
      await vi.advanceTimersByTimeAsync(2500);
      rig.client.ask('d4', "don't snooze the foxtrot one");
      await vi.advanceTimersByTimeAsync(2500);
      expect(rig.seen.map((input) => input.latestUserSpeech)).toEqual(['mark the sierra one done', 'snooze the foxtrot one till 3', 'snooze the foxtrot one after lunch', "don't snooze the foxtrot one"]);
      expect(rig.seen[1]!.now).toEqual(expect.any(Number)); // so "till 3" can become an ISO time
      expect(rig.desk.commands).toEqual([]);
    });
  });

  describe('replies into desk conversations', () => {
    const Loom = () => deskItem('loom:docs', 'loom', { place: 'demo · epic: Tidy the docs folder', nextStep: 'your_move', ask: 'Archive the drafts?' });

    function loomRig(actions: OperatorAction[][], extra: Partial<LiveOperatorOptions> = {}) {
      const desk = standardDesk();
      desk.list.push(Loom());
      // A chief of staff exists: Loom work must still not go to it.
      return setup(actions, { desk, defaultAgentId: 'foxtrot', ...extra });
    }

    it('a reply to a Loom item is a desk reply command, never an agent turn', async () => {
      const rig = loomRig([[{ type: 'desk', op: 'reply', item: 'i3', message: 'Archive the drafts and publish the guide.' }]]);
      rig.client.ask('d1', 'tell the Loom thread to archive the drafts and publish the guide');
      await vi.advanceTimersByTimeAsync(3000);
      expect(rig.desk.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:docs', args: { text: 'Archive the drafts and publish the guide.' }, commandId: expect.stringMatching(UUID) })]);
      expect(rig.backend.sends).toEqual([]);
      expect(said(rig.client)).toContain('Sent to the Loom thread "demo · epic: Tidy the docs folder": a coding thread in Loom');
    });

    it("relays the thread's answer from the desk stream once its turn is over; earlier messages never count", async () => {
      const rig = loomRig([[{ type: 'desk', op: 'reply', item: 'i3', message: 'Go ahead.' }]]);
      rig.desk.messages.set('loom:docs', [{ author: 'agent', text: 'Old answer from yesterday.', at: Date.now() - 86_400_000 }]);
      rig.client.ask('d1', 'go ahead');
      await vi.advanceTimersByTimeAsync(3000);
      rig.desk.agentPosts('loom:docs', 'Working on it, archiving now.', { nextStep: 'working' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).not.toContain('archiving now');
      rig.desk.agentPosts('loom:docs', 'Drafts archived; guide queued to publish.', { nextStep: 'fyi' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain('Drafts archived; guide queued to publish.');
      expect(said(rig.client)).not.toContain('Old answer from yesterday');
      await speakThrough(rig);
      expect(rig.desk.sent('heard').map((command) => command.itemId)).toEqual(['loom:docs']);
    });

    it('a failed desk reply is reported as not sent', async () => {
      const rig = loomRig([[{ type: 'desk', op: 'reply', item: 'i3', message: 'Ship it.' }]]);
      rig.desk.respond = () => ({ status: 'failed', error: 'reply not delivered: Loom is offline' });
      rig.client.ask('d1', 'tell the Loom thread to ship it');
      await vi.advanceTimersByTimeAsync(3000);
      expect(said(rig.client)).toContain("didn't reach the Loom thread");
      expect(said(rig.client)).toContain('Loom is offline');
    });

    it('after reading a Loom item the owner is in it: their answer is a draft for that thread, sent on "I\'m done"', async () => {
      const rig = loomRig([[{ type: 'desk', op: 'read', item: 'i3' }]], {
        draft: new DraftSession({ compile: async (input) => ({ message: 'Yes, go ahead and publish.', agentId: input.target?.agentId ?? null, item: input.targetItem?.handle ?? null, threadId: null, newThreadTitle: null, questions: [] }) }),
      });
      rig.client.ask('d1', "what's the docs one");
      await vi.advanceTimersByTimeAsync(3000);
      rig.client.ask('d2', 'yes go ahead and publish');
      await vi.advanceTimersByTimeAsync(3000);
      rig.client.ask('d3', "I'm done");
      await vi.advanceTimersByTimeAsync(8000);
      expect(rig.desk.sent('reply').map((command) => command.args.text)).toEqual(['Yes, go ahead and publish.']);
      expect(rig.backend.sends).toEqual([]);
    });

    it("after reading an agent item, the answer is a draft for that conversation and goes to its agent in its thread", async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Rear bulb it is.', afterMs: 100 }] });
      const rig = setup([[{ type: 'desk', op: 'read', item: 'i2' }]], {
        backend,
        threads: { list: async () => [], create: async () => { throw new Error('no'); } },
        draft: new DraftSession({ compile: async (input) => ({ message: 'It is the rear one.', agentId: 'sierra', item: input.targetItem?.handle ?? null, threadId: null, newThreadTitle: null, questions: [] }) }),
      });
      rig.client.ask('d1', "what's the turn signal one");
      await vi.advanceTimersByTimeAsync(3000);
      rig.client.ask('d2', "it's the rear one");
      await vi.advanceTimersByTimeAsync(3000);
      rig.client.ask('d3', "I'm done");
      await vi.advanceTimersByTimeAsync(8000);
      expect(backend.sends.map((send) => send.request)).toEqual([expect.objectContaining({ agentId: 'sierra', message: 'It is the rear one.', channelId: THREAD })]);
      expect(rig.desk.sent('reply')).toEqual([]);
    });

    it('status reports the desk, not "nothing pending", when agents are working or waiting', async () => {
      const desk = standardDesk();
      desk.list.push(deskItem('w', 'foxtrot', { nextStep: 'working', summary: { gist: 'Groceries recategorization' } }));
      const rig = setup([[{ type: 'status' }]], { desk });
      rig.client.ask('d1', 'have you heard back from Foxtrot?');
      await vi.advanceTimersByTimeAsync(2500);
      expect(said(rig.client)).toContain('Foxtrot is working on: Groceries recategorization');
      expect(said(rig.client)).toContain('Waiting on the user on the desk: Foxtrot: Vehicles transfer');
    });
  });

  describe('operator status and captions', () => {
    it('publishes live status, partial captions at most 4 a second, and every final line', async () => {
      const rig = setup([]);
      expect(rig.desk.operatorUpdates[0]).toMatchObject({ live: true, status: 'listening' });
      for (let i = 0; i < 20; i++) {
        rig.client.user(`word${i} `);
        await vi.advanceTimersByTimeAsync(50); // 20 deltas a second for one second
      }
      const partials = rig.desk.operatorUpdates.filter((update) => update.transcript && !update.transcript.final);
      expect(partials.length).toBeGreaterThanOrEqual(3);
      expect(partials.length).toBeLessThanOrEqual(5);
      rig.client.operator('Got it.');
      const finals = rig.desk.operatorUpdates.filter((update) => update.transcript?.final);
      expect(finals).toEqual([expect.objectContaining({ transcript: { speaker: 'user', name: 'You', text: expect.stringContaining('word19'), final: true } })]);
      await vi.advanceTimersByTimeAsync(3000); // the operator's line goes quiet: final
      expect(rig.desk.operatorUpdates.filter((update) => update.transcript?.final).at(-1)).toMatchObject({ transcript: { speaker: 'operator', text: 'Got it.', final: true } });
      rig.operator.stop();
      expect(rig.desk.operatorUpdates.at(-1)).toMatchObject({ live: false, status: 'offline' });
    });
  });

  describe('taps', () => {
    it('a tap is handled (and so acknowledged) only while the session is live', async () => {
      const rig = setup([]);
      const tap = scene('s1', 'sierra', { choices: [{ id: 'a', label: 'Rear' }], conversationKey: `thread:${THREAD}` });
      expect(rig.screen.handlers!.onInput(tap, 'choice', { choiceId: 'a' }, { commandId: 'c1' })).toBe(true);
      const handlers = rig.screen.handlers!;
      rig.operator.stop();
      expect(handlers.onInput(tap, 'choice', { choiceId: 'a' }, { commandId: 'c2' })).toBe(false);
    });
  });
});

describe('extractor desk prompt', () => {
  const base = { agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'mark that done' };

  it('lists the desk and the desk guidance only when there is a desk', () => {
    const prompt = buildExtractorPrompt({
      ...base,
      now: Date.UTC(2026, 9, 6, 19),
      desk: { items: [{ handle: 'i1', agentName: 'Sierra', place: 'Bike Turn Signal', step: 'your move', line: 'Front or rear?', threadId: THREAD, options: ['Front', 'Rear'] }], focused: 'i1', lastDiscussed: 'i1' },
    });
    expect(prompt).toContain(`- i1: Sierra · "Bike Turn Signal" [your move] thread=${THREAD}: Front or rear? (options: "Front", "Rear")`);
    expect(prompt).toContain('i1 is open in the Conversation view');
    expect(prompt).toContain('desk_op snooze');
    expect(prompt).toContain('Now: ');
    expect(buildExtractorPrompt(base)).not.toContain('desk_op');
  });

  it('parses desk actions, including snooze, answer, stop_job and sweep', () => {
    const fields = { agent_id: '', task_id: '', thread_id: '', new_thread_title: '', screen_op: '', message: '', option: '', until: '', trigger: '', stop_job: '', decision: '' };
    const raw = JSON.stringify({
      actions: [
        { ...fields, type: 'desk', desk_op: 'snooze', item: 'i2', trigger: 'agent_posts' },
        { ...fields, type: 'desk', desk_op: 'answer', item: 'i1', option: 'Rear' },
        { ...fields, type: 'desk', desk_op: 'done', item: 'i1', stop_job: 'no' },
        { ...fields, type: 'desk', desk_op: 'sweep', item: 'i3', decision: 'drop' },
        { ...fields, type: 'desk', desk_op: 'bogus', item: 'i1' },
        { ...fields, type: 'screen', screen_op: 'dashboard', item: '' },
      ],
    });
    expect(parseExtractorOutput(raw)).toEqual([
      { type: 'desk', op: 'snooze', item: 'i2', trigger: 'agent_posts' },
      { type: 'desk', op: 'answer', item: 'i1', option: 'Rear' },
      { type: 'desk', op: 'done', item: 'i1', stopJob: false },
      { type: 'desk', op: 'sweep', item: 'i3', decision: 'drop' },
      { type: 'none', reason: 'unclear desk action "bogus" on "i1"' },
      { type: 'screen', op: 'board' },
    ]);
  });

  it('tells GPT-Live to say a neutral "on it" and confirm the destination after routing', () => {
    const instructions = buildOperatorInstructions(AGENTS);
    expect(instructions).toContain('say only a neutral "On it." or "Checking." Never name where it is going');
    expect(instructions).not.toContain('Sending that to Sierra');
  });
});

describe('chief of staff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const roster: AgentDescriptor[] = [...AGENTS, { id: 'watson', name: 'Watson', role: 'chief of staff' }];

  it('an answer with nothing to attach it to, or an unknown agent, is a question: never a quiet fallback to the chief of staff', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'On it.', afterMs: 100 }] });
    const rig = setup([[{ type: 'reply', taskId: '', message: 'Both go into groceries.' }], [{ type: 'dispatch', agentId: 'someone', message: 'what should I tackle first?' }]], {
      agents: roster,
      backend,
      defaultAgentId: 'watson',
      desk: new FakeDesk(),
    });
    rig.client.ask('d1', 'both go into groceries');
    await vi.advanceTimersByTimeAsync(2500);
    rig.client.ask('d2', 'what should I tackle first');
    await vi.advanceTimersByTimeAsync(2500);
    expect(backend.sends).toEqual([]);
    expect(said(rig.client)).toContain('Ask the user only this, in a few words: "Who is that for?"');
    expect(said(rig.client)).toContain('Ask the user only this, in a few words: "Who should take that?"');
  });

  it('the router\'s ask is asked, and nothing is sent', async () => {
    const backend = new SimulatedAgentBackend({});
    const rig = setup([[{ type: 'ask', question: 'Watson, or a coding thread in tango?' }]], { agents: roster, backend, defaultAgentId: 'watson', desk: new FakeDesk() });
    rig.client.ask('d1', 'look into the flaky deploy');
    await vi.advanceTimersByTimeAsync(2500);
    expect(backend.sends).toEqual([]);
    expect(said(rig.client)).toContain('"Watson, or a coding thread in tango?"');
  });

  it('tells the voice model and the router the chief of staff is not a default', async () => {
    const { chiefOfStaff } = await import('../src/live/live-operator.js');
    expect(chiefOfStaff(roster)?.id).toBe('watson');
    expect(chiefOfStaff([{ id: 'watson-ollama', name: 'Watson', role: '' }])?.id).toBe('watson-ollama');
    const instructions = buildOperatorInstructions(roster);
    expect(instructions).toContain('Watson is the chief of staff');
    expect(instructions).toContain('It is not a default: when it is unclear who or which thread should take something, the backend asks the user');
    expect(instructions).not.toContain('Do not ask the user who should handle it.');
    const prompt = buildExtractorPrompt({ agents: roster, tasks: [], transcript: [], latestUserSpeech: 'what first?', defaultAgentId: 'watson' });
    expect(prompt).toContain('Watson (watson) is the chief of staff');
    expect(prompt).toContain('It is never a default: when it is unclear who or which thread should take something, use ask.');
    expect(prompt).not.toContain('instead of choosing none or asking who');
  });
});

// ── HTTP clients against a fake desk server ─────────────────────────────

interface FakeServer {
  url: string;
  requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  push(event: string, data: unknown): void;
  close(): Promise<void>;
}

async function fakeDeskServer(handle: (method: string, path: string, body: Record<string, unknown>, res: ServerResponse) => boolean): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const streams: ServerResponse[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = req.url ?? '';
      requests.push({ method: req.method ?? 'GET', path, body });
      if (path.startsWith('/director/stream') || path.startsWith('/api/desk/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: hello\ndata: ${JSON.stringify({ screens: [], operatorLive: true, showing: null, stages: [], presentation: { view: 'active', itemId: null, conversationKey: null, sceneId: null } })}\n\n`);
        streams.push(res);
        return;
      }
      if (handle(req.method ?? 'GET', path, body, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], screens: [], showing: null, stages: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    push: (event, data) => streams.forEach((res) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () =>
      new Promise((resolve) => {
        streams.forEach((res) => res.end());
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('HttpDeskClient', () => {
  it('retries a command after a transport failure with the same command id', async () => {
    let calls = 0;
    const server = await fakeDeskServer((method, path, body, res) => {
      if (path !== '/api/desk/commands') return false;
      calls += 1;
      res.writeHead(calls === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ commandId: body.commandId, status: 'applied' }));
      return true;
    });
    try {
      const client = new HttpDeskClient(server.url, { retryDelaysMs: [10, 10] });
      const result = await client.command('heard', 'discord:chapter:x', { playbackComplete: true });
      expect(result.status).toBe('applied');
      const sent = server.requests.filter((request) => request.path === '/api/desk/commands').map((request) => request.body);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toEqual({ commandId: expect.stringMatching(UUID), type: 'heard', itemId: 'discord:chapter:x', args: { playbackComplete: true }, actor: 'voice' });
      expect(sent[1]!.commandId).toBe(sent[0]!.commandId);
    } finally {
      await server.close();
    }
  });

  it('reports a desk that never answers as a transport failure', async () => {
    const client = new HttpDeskClient('http://127.0.0.1:9', { retryDelaysMs: [1], timeoutMs: 500 });
    const result = await client.command('seen', 'x');
    expect(result).toMatchObject({ status: 'failed', transport: true });
  });

  it('stops publishing operator status once the desk says it has no such endpoint', async () => {
    const server = await fakeDeskServer((method, path, _body, res) => {
      if (path !== '/api/desk/operator') return false;
      res.writeHead(404).end('{}');
      return true;
    });
    try {
      const client = new HttpDeskClient(server.url);
      client.publishOperator({ live: true, status: 'listening', agentName: null });
      await waitFor(() => server.requests.some((request) => request.path === '/api/desk/operator'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      client.publishOperator({ live: true, status: 'speaking', agentName: null });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.requests.filter((request) => request.path === '/api/desk/operator')).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('posts operator updates one at a time, in order, folding a waiting partial into the next', async () => {
    let first = true;
    const server = await fakeDeskServer((method, path, _body, res) => {
      if (path !== '/api/desk/operator') return false;
      // The first answer is slow: a later post must not overtake it.
      const delay = first ? 100 : 0;
      first = false;
      setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'), delay);
      return true;
    });
    try {
      const client = new HttpDeskClient(server.url);
      const line = (speaker: 'user' | 'operator', text: string, final: boolean) => ({ live: true, status: 'listening' as const, agentName: null, transcript: { speaker, name: speaker, text, final } });
      client.publishOperator(line('operator', 'Sent to Malibu.', true));
      client.publishOperator(line('user', 'Go', false));
      client.publishOperator(line('user', 'Go ahead', false)); // covers the waiting "Go"
      client.publishOperator(line('user', 'Go ahead and start it', true)); // and the final covers the partial
      await waitFor(() => server.requests.filter((request) => request.path === '/api/desk/operator').length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const texts = server.requests.filter((request) => request.path === '/api/desk/operator').map((request) => (request.body as { transcript: { text: string } }).transcript.text);
      expect(texts).toEqual(['Sent to Malibu.', 'Go ahead and start it']);
    } finally {
      await server.close();
    }
  });

  it('turns desk stream item events into handler calls and refreshes the active list', async () => {
    const server = await fakeDeskServer((method, path, _body, res) => {
      if (!path.startsWith('/api/desk/items?')) return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [deskItem('a', 'sierra')] }));
      return true;
    });
    try {
      const client = new HttpDeskClient(server.url);
      const events: string[] = [];
      client.connect((event) => events.push(event.id));
      await waitFor(() => server.requests.some((request) => request.path.startsWith('/api/desk/stream')));
      server.push('item', { id: 'a', revision: 2 });
      await waitFor(() => events.length > 0 && client.items().length > 0);
      expect(events).toEqual(['a']);
      expect(client.items().map((item) => item.id)).toEqual(['a']);
      client.disconnect();
    } finally {
      await server.close();
    }
  });
});

describe('HttpScreenDirector', () => {
  it('matches prototype results to their command: one screen’s miss loses to another’s success', async () => {
    const server = await fakeDeskServer(() => false);
    try {
      const director = new HttpScreenDirector(server.url);
      director.connect({ onStaged: () => {}, onInput: () => true });
      await waitFor(() => server.requests.some((request) => request.path.startsWith('/director/stream')));
      const pending = director.prototypeResult('cmd-a', 2000);
      server.push('prototype-result', { prototypeId: 'p1', commandId: 'cmd-b', name: 'click', ok: true, detail: 'other command' });
      server.push('prototype-result', { prototypeId: 'p1', commandId: 'cmd-a', name: 'click', ok: false, detail: 'nothing called "Go"' });
      server.push('prototype-result', { prototypeId: 'p1', commandId: 'cmd-a', name: 'click', ok: true, detail: 'Go' });
      expect(await pending).toMatchObject({ commandId: 'cmd-a', ok: true, detail: 'Go' });
      const missed = director.prototypeResult('cmd-c', 2000);
      server.push('prototype-result', { prototypeId: 'p1', commandId: 'cmd-c', name: 'click', ok: false, detail: 'nothing called "Pay"' });
      expect(await missed).toMatchObject({ commandId: 'cmd-c', ok: false });
      expect(await director.prototypeResult('cmd-d', 50)).toBeNull();
      director.disconnect();
    } finally {
      await server.close();
    }
  });

  it('connects with ?ack=1, acknowledges each tap it handles, follows presentation, and posts intents as the director', async () => {
    const server = await fakeDeskServer((method, path, body, res) => {
      if (path === '/api/desk/presentation') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied: true, presentation: { view: body.view, itemId: body.itemId ?? null, conversationKey: null, sceneId: null } }));
        return true;
      }
      if (path.startsWith('/api/input/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'acknowledged' }));
        return true;
      }
      return false;
    });
    try {
      const director = new HttpScreenDirector(server.url);
      let live = true;
      const taps: string[] = [];
      director.connect({ onStaged: () => {}, onInput: (scene) => (live ? (taps.push(scene.id), true) : false) });
      await waitFor(() => server.requests.some((request) => request.path.startsWith('/director/stream')));
      expect(server.requests.find((request) => request.path.startsWith('/director/stream'))!.path).toBe('/director/stream?ack=1');
      server.push('input', { scene: { id: 's1', agentId: 'sierra', choices: [] }, type: 'choice', data: {}, commandId: 'cmd-1' });
      await waitFor(() => server.requests.some((request) => request.path === '/api/input/cmd-1/ack'));
      live = false;
      server.push('input', { scene: { id: 's2', agentId: 'sierra', choices: [] }, type: 'choice', data: {}, commandId: 'cmd-2' });
      server.push('presentation', { view: 'conversation', itemId: 'i', conversationKey: 'thread:x', sceneId: null });
      await waitFor(() => director.presentation()?.view === 'conversation');
      expect(taps).toEqual(['s1']);
      expect(server.requests.some((request) => request.path === '/api/input/cmd-2/ack')).toBe(false);
      expect(await director.present({ view: 'active', reason: 'idle' })).toBe(true);
      expect(server.requests.find((request) => request.path === '/api/desk/presentation')!.body).toEqual({ view: 'active', reason: 'idle', by: 'director' });
      director.disconnect();
    } finally {
      await server.close();
    }
  });
});
