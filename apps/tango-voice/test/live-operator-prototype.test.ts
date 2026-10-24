import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator } from '../src/live/live-operator.js';
import type { PresentationIntent, PrototypePage, PrototypeResult, ScreenPrototype } from '../src/live/screen-director.js';
import { buildExtractorPrompt, parseExtractorOutput, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen } from './desk-fakes.js';

// The Prototype view by voice: "show me the prototype", then driving the page on it
// ("click Continue", "type my email", "go back"). Synthetic fixtures only.

const AGENTS: AgentDescriptor[] = [{ id: 'sierra', name: 'Sierra', role: 'research' }];
const PROTO: ScreenPrototype = { id: 'p1', agentId: 'loom', agentName: 'Loom · tango', conversationKey: 'loom:thread-a', name: 'main', title: 'Onboarding v2', drivable: true, version: 1, updatedAt: 1 };
const PAGE: PrototypePage = {
  path: 'index.html',
  title: 'Onboarding',
  targets: [
    { label: 'Continue', kind: 'button', inView: true },
    { label: 'Skip for now', kind: 'link', inView: true },
    { label: 'Buy the plan', kind: 'button', inView: false },
  ],
  headings: ['Welcome aboard', 'Pricing'],
  fields: ['Email'],
  scroll: { percent: 0, scrollable: true },
};

/** A screen with prototypes: the conversation has one, commands carry args, the page reports back. */
class PrototypeScreen extends FakeDeskScreen {
  sent: Array<{ name: string; args?: Record<string, unknown> }> = [];
  page: PrototypePage | null = PAGE;
  nextResult: PrototypeResult | null = null;
  activityAt = 0;
  prototypeActivityAt() {
    return this.activityAt;
  }
  lastCommandId: string | undefined;
  override async command(name: string, args?: Record<string, unknown>, commandId?: string) {
    this.sent.push({ name, ...(args ? { args } : {}) });
    this.lastCommandId = commandId;
    return true;
  }
  override async present(intent: PresentationIntent) {
    if (intent.view !== 'prototype') return super.present(intent);
    this.intents.push(intent);
    this.presented = { ...this.presented, view: 'prototype', prototypeId: PROTO.id, prototype: PROTO, prototypes: [PROTO], sceneId: null };
    return true;
  }
  prototypePage() {
    return this.presented.view === 'prototype' ? this.page : null;
  }
  waited: string[] = [];
  async prototypeResult(commandId: string) {
    this.waited.push(commandId);
    return this.nextResult;
  }
}

function setup(actions: OperatorAction[][], screen = new PrototypeScreen(), extra: Record<string, unknown> = {}) {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const desk = new FakeDesk([deskItem('loom:thread-a', 'loom', { place: 'tango · Onboarding', nextStep: 'your_move' })]);
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: new SimulatedAgentBackend({}),
    extractor,
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    desk,
    screen,
    ...extra,
  });
  operator.start();
  return { client, operator, screen, seen, desk };
}

const said = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');

describe('the Prototype view by voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('"show me the prototype" opens the conversation’s prototype as the owner’s pick', async () => {
    const screen = new PrototypeScreen();
    screen.presented = { view: 'conversation', itemId: 'loom:thread-a', conversationKey: 'loom:thread-a', sceneId: null, prototypes: [PROTO] };
    const rig = setup([[{ type: 'screen', op: 'prototype' }]], screen);
    rig.client.ask('d1', 'show me the prototype');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'prototype', reason: 'user', conversationKey: 'loom:thread-a' });
    expect(screen.presented.view).toBe('prototype');
  });

  it('no prototype: says so', async () => {
    const screen = new PrototypeScreen();
    screen.presented = { view: 'conversation', itemId: 'loom:thread-a', conversationKey: 'loom:thread-a', sceneId: null, prototypes: [PROTO] };
    screen.present = async (intent) => {
      screen.intents.push(intent);
      return false;
    };
    const rig = setup([[{ type: 'screen', op: 'prototype' }]], screen);
    rig.client.ask('d1', 'open the prototype');
    await vi.advanceTimersByTimeAsync(2500);
    expect(said(rig.client)).toContain('no prototype for this conversation');
  });

  it('the router sees the page: clickables in view first, sections, fields', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    const rig = setup([[{ type: 'none', reason: 'x' }]], screen);
    rig.client.ask('d1', 'what can I do on this page');
    await vi.advanceTimersByTimeAsync(2500);
    const input = rig.seen[0]!;
    expect(input.screen?.prototype).toMatchObject({ title: 'Onboarding v2', drivable: true, path: 'index.html', targets: PAGE.targets, headings: PAGE.headings, fields: ['Email'] });
    const prompt = buildExtractorPrompt(input);
    expect(prompt).toContain('Prototype view is up: Loom · tango\'s "Onboarding v2", on page index.html "Onboarding", scrolled 0%.');
    expect(prompt).toContain('Clickable in view: "Continue", "Skip for now" (link)');
    expect(prompt).toContain('Clickable further down: "Buy the plan"');
    expect(prompt).toContain('screen_op page_back');
  });

  it('click, fill, go to and back reach the page with their arguments; nothing is said on success', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    const rig = setup(
      [
        [{ type: 'screen', op: 'click', target: 'Continue' }],
        [{ type: 'screen', op: 'fill', target: 'Email', text: 'owner@example.test' }],
        [{ type: 'screen', op: 'go_to', target: 'Pricing' }],
        [{ type: 'screen', op: 'page_back' }],
        [{ type: 'screen', op: 'scroll_down' }],
      ],
      screen,
    );
    for (const [id, words] of [['d1', 'the continue one'], ['d2', 'type my email'], ['d3', 'go to pricing'], ['d4', 'go back'], ['d5', 'scroll down']]) {
      rig.client.ask(id!, words!);
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(screen.sent).toEqual([
      { name: 'click', args: { target: 'Continue' } },
      { name: 'fill', args: { target: 'Email', text: 'owner@example.test' } },
      { name: 'go_to', args: { target: 'Pricing' } },
      { name: 'back', args: {} },
      { name: 'scroll_down' },
    ]);
    expect(said(rig.client)).toBe('');
  });

  it('a click that found nothing: says what is in view and asks', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    screen.nextResult = { name: 'click', ok: false, detail: 'nothing called "Checkout" on the page' };
    const rig = setup([[{ type: 'screen', op: 'click', target: 'Checkout' }]], screen);
    rig.client.ask('d1', 'the checkout one');
    await vi.advanceTimersByTimeAsync(3000);
    expect(said(rig.client)).toContain('Nothing on the page matched "Checkout". What is in view: "Continue", "Skip for now".');
    // The wait is for this command's own result.
    expect(screen.waited).toEqual([screen.lastCommandId]);
    expect(screen.lastCommandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a fill with nothing to type asks what to type instead of clearing the field', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    const rig = setup([[{ type: 'screen', op: 'fill', target: 'Email' }]], screen);
    rig.client.ask('d1', 'type in the email box');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.sent).toEqual([]);
    expect(said(rig.client)).toContain('Ask what to type into "Email"');
  });

  it('"go back" on the first page: says it is already there', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    screen.nextResult = { name: 'back', ok: false, detail: 'already on the first page of the prototype' };
    const rig = setup([], screen);
    rig.client.ask('d1', 'go back');
    await vi.advanceTimersByTimeAsync(3000);
    expect(said(rig.client)).toContain("Couldn't go back: already on the first page of the prototype");
  });

  it('page ops need the Prototype view, and a drivable prototype', async () => {
    const screen = new PrototypeScreen();
    const rig = setup([[{ type: 'screen', op: 'click', target: 'Continue' }]], screen);
    rig.client.ask('d1', 'click continue');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.sent).toEqual([]);
    expect(said(rig.client)).toContain('No prototype is open');

    const devServer = new PrototypeScreen();
    await devServer.present({ view: 'prototype', reason: 'user' });
    devServer.presented = { ...devServer.presented, prototype: { ...PROTO, drivable: false } };
    const rig2 = setup([[{ type: 'screen', op: 'click', target: 'Continue' }]], devServer);
    rig2.client.ask('d1', 'click continue');
    await vi.advanceTimersByTimeAsync(3000);
    expect(devServer.sent).toEqual([]);
    expect(said(rig2.client)).toContain('dev server');
  });

  it('quick paths on the Prototype view: "click X", "go back"; "back to the board" still leaves', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    const rig = setup([], screen);
    rig.client.ask('d1', 'Click the Continue button.');
    await vi.advanceTimersByTimeAsync(3000);
    rig.client.ask('d2', 'go back');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.seen).toHaveLength(0); // no model call
    expect(screen.sent).toEqual([{ name: 'click', args: { target: 'Continue' } }, { name: 'back', args: {} }]);
    rig.client.ask('d3', 'back to the board');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.presented.view).toBe('active');
  });

  it('"click the second button" goes to the model, which has the ordered list', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    const rig = setup([[{ type: 'screen', op: 'click', target: 'Skip for now' }]], screen);
    rig.client.ask('d1', 'click the second button');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.seen).toHaveLength(1);
    expect(screen.sent).toEqual([{ name: 'click', args: { target: 'Skip for now' } }]);
  });

  it('"go back" off the Prototype view is still the board; "open the prototype" without one is the screen', async () => {
    const screen = new PrototypeScreen();
    screen.presented = { view: 'conversation', itemId: 'loom:thread-a', conversationKey: 'loom:thread-a', sceneId: null };
    const rig = setup([], screen);
    rig.client.ask('d1', 'open the prototype');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'screen' });
  });

  it('a prototype in use stays up: 10 minutes idle, counted from its last page change', async () => {
    const screen = new PrototypeScreen();
    await screen.present({ view: 'prototype', reason: 'user' });
    screen.intents.length = 0;
    const rig = setup([], screen, { idleBoardMs: 120_000 });
    await vi.advanceTimersByTimeAsync(300_000);
    screen.activityAt = Date.now(); // the owner scrolled it
    await vi.advanceTimersByTimeAsync(500_000);
    expect(screen.intents).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(screen.intents).toEqual([{ view: 'active', reason: 'idle' }]);
    void rig;
  });

  it('a draft on the Prototype view: commands in any words drive the page, feedback is dictated (live session 10/09)', async () => {
    const screen = new PrototypeScreen();
    screen.presented = { view: 'conversation', itemId: 'loom:thread-a', conversationKey: 'loom:thread-a', sceneId: null, prototypes: [PROTO] };
    const rig = setup(
      [
        [{ type: 'screen', op: 'click', target: 'Skip for now' }],
        [{ type: 'screen', op: 'click', target: 'Continue' }],
        [{ type: 'desk', op: 'reply', item: 'i1', message: 'The skip button should be smaller' }],
        [{ type: 'screen', op: 'conversation' }],
      ],
      screen,
    );
    rig.client.ask('d1', 'show me the prototype'); // the fast path opens it and arms a quiet draft for the thread
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.presented.view).toBe('prototype');
    expect(rig.desk.draft).toMatchObject({ active: true, fragments: [] });
    expect(said(rig.client)).not.toContain('Draft mode is on'); // no spoken refresher over the prototype

    rig.client.ask('d2', 'Cool, can you click the skip now button for me');
    await vi.advanceTimersByTimeAsync(3000);
    rig.client.ask('d3', 'Yankee, can you click continue');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.sent).toEqual([{ name: 'click', args: { target: 'Skip for now' } }, { name: 'click', args: { target: 'Continue' } }]);
    expect(rig.desk.draft!.fragments).toEqual([]);

    // A fast-path command mid-draft: the page moves, and nothing is said over it.
    const before = rig.client.appends.length;
    rig.client.ask('d3b', 'Click Continue');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.sent.at(-1)).toEqual({ name: 'click', args: { target: 'Continue' } });
    expect(rig.client.appends.slice(before)).toEqual([]);

    rig.client.ask('d4', 'the skip button should be smaller');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.desk.draft!.fragments).toEqual(['the skip button should be smaller']);

    rig.client.ask('d5', 'go back to the conversation view');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: 'loom:thread-a' });
    expect(rig.seen).toHaveLength(4); // the router judged every one but the fast-path click
  });

  it('parses the router’s click / fill / page_back', () => {
    const blank = { agent_id: '', task_id: '', message: '', thread_id: '', new_thread_title: '', thread_options: [], desk_op: '', item: '', option: '', until: '', trigger: '', stop_job: '', decision: '', answers: [], approval: '', draft_op: '', next_op: '' };
    const raw = JSON.stringify({
      actions: [
        { ...blank, type: 'screen', screen_op: 'click', option: ' Continue ' },
        { ...blank, type: 'screen', screen_op: 'fill', option: 'Email', message: 'owner@example.test' },
        { ...blank, type: 'screen', screen_op: 'page_back' },
        { ...blank, type: 'screen', screen_op: 'prototype' },
      ],
    });
    expect(parseExtractorOutput(raw)).toEqual([
      { type: 'screen', op: 'click', target: 'Continue' },
      { type: 'screen', op: 'fill', target: 'Email', text: 'owner@example.test' },
      { type: 'screen', op: 'page_back' },
      { type: 'screen', op: 'prototype' },
    ]);
  });
});
