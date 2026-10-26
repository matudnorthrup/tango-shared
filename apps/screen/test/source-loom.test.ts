import * as fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { closingHandoff, AttachmentFiles, createLoomServer, LoomHost, LoomStore, type OpenSessionOptions, type Runtime, type RuntimeEvent, type RuntimeSession } from '@tango/loom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deskStatus } from '../server/desk/status.js';
import { applyJobHold, jobHoldFor, recordJobHold } from '../server/desk/job-holds.js';
import { DeskLoomSource, backgroundOf, loomFromEnv, settledChoice, toolLine } from '../server/desk/source-loom.js';
import { DeskFeed } from '../server/desk/feed.js';
import { DeskDecided } from '../server/desk/decided.js';
import { DeskUpdates } from '../server/desk/updates.js';
import { DatabaseSync } from 'node:sqlite';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { DeskMail } from '../server/desk/mail.js';
import { needsOwner } from '../server/desk/status.js';
import { Hono } from 'hono';
import { itemDetail } from '../server/desk/view.js';
import { AGENT, cid, makeHarness, msg, type Harness } from './desk-harness.js';

// The desk against the real Loom HTTP server, in process, with a fake harness behind it.

class FakeSession implements RuntimeSession {
  turns: { runId: string; text: string; images?: { mimeType: string; data: string }[] }[] = [];
  answers: { requestId: string; answer: unknown }[] = [];
  constructor(
    readonly options: OpenSessionOptions,
    readonly emit: (event: RuntimeEvent) => void,
  ) {}
  get run(): string {
    return this.turns.at(-1)!.runId;
  }
  startTurn(run: { runId: string; text: string; images?: { mimeType: string; data: string }[] }): void {
    this.turns.push(run);
  }
  interrupted = 0;
  async interrupt(): Promise<void> {
    this.interrupted++;
    this.emit({ type: 'turn.failed', runId: this.run, failure: { kind: 'interrupted', message: 'Stopped' } });
  }
  respond(requestId: string, answer: unknown): void {
    this.answers.push({ requestId, answer });
  }
  async close(): Promise<void> {}
  complete(text: string): void {
    // Cooperating fake model: status tests use recorded tool hand-offs, never infer asks from prose.
    const store = loom.store;
    if (!store.db.prepare('SELECT 1 FROM turn_handoffs WHERE run_id=?').get(this.run)) {
      const handoff = closingHandoff(text, true) ?? { owner: 'none', text: 'done' };
      const next = handoff.owner === 'you' ? { kind: 'human', who: 'fixture-owner' }
        : handoff.owner === 'me' ? { kind: 'agent', who: `loom:${this.options.threadId}` }
        : handoff.owner === 'waiting' ? { kind: 'system', who: handoff.waitingOn ?? 'CI' }
        : { kind: 'nobody', who: '' };
      store.db.prepare('INSERT INTO turn_handoffs (run_id,thread_id,record) VALUES (?,?,?)').run(this.run, this.options.threadId,
        JSON.stringify({ ...handoff, next, source: 'tool', runId: this.run, at: store.now(), messageId: null }));
    }
    this.emit({ type: 'message.completed', runId: this.run, text });
    this.emit({ type: 'turn.completed', runId: this.run });
  }
}

class FakeRuntime implements Runtime {
  sessions: FakeSession[] = [];
  async open(options: OpenSessionOptions, emit: (event: RuntimeEvent) => void): Promise<RuntimeSession> {
    const session = new FakeSession(options, emit);
    this.sessions.push(session);
    return session;
  }
  get last(): FakeSession {
    return this.sessions.at(-1)!;
  }
}

const TOKEN = 'test-token';
let h: Harness;
let runtime: FakeRuntime;
let loom: { store: LoomStore; host: LoomHost; server: Server };
let port: number;
let urls: string[];
let logged: string[];
let source: DeskLoomSource;

async function startLoom(listenOn = 0): Promise<number> {
  const store = new LoomStore(path.join(h.dir, 'loom.sqlite'));
  store.now = () => h.clock.now;
  const host = new LoomHost(store, { claude: runtime }, { attachments: new AttachmentFiles(path.join(h.dir, 'loom-attachments')) });
  await host.recover();
  const server = createLoomServer(host, { token: TOKEN });
  server.on('request', (req) => urls.push(req.url ?? ''));
  await new Promise<void>((resolve) => server.listen(listenOn, '127.0.0.1', resolve));
  loom = { store, host, server };
  return (server.address() as AddressInfo).port;
}

async function stopLoom(): Promise<void> {
  loom.server.closeAllConnections();
  await new Promise((resolve) => loom.server.close(resolve));
  await loom.host.closeAll();
  loom.store.close();
}

beforeEach(async () => {
  h = makeHarness();
  runtime = new FakeRuntime();
  urls = [];
  logged = [];
  port = await startLoom();
  fs.writeFileSync(path.join(h.dir, 'token'), `${TOKEN}\n`);
  source = new DeskLoomSource({ core: h.core, url: `http://127.0.0.1:${port}`, tokenFile: path.join(h.dir, 'token'), retryMs: 20, maxRetryMs: 100, log: (event) => logged.push(event) });
  // The harness only registered Discord; Loom owns its items' write side.
  (h.core as unknown as { options: { adapters: unknown[] } }).options.adapters.push(source);
  source.start();
});

afterEach(async () => {
  source.stop();
  await stopLoom();
  h.close();
});

const item = (threadId: string) => h.core.item(`loom:${threadId}`);
/** Waits until the desk has filed everything Loom said so far and `check` holds. */
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await source.idle();
    check();
  }, { timeout: 3_000, interval: 10 });

async function newThread(text = 'Build the overview map'): Promise<string> {
  const result = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text });
  return result.threadId!;
}

const tick = () => (h.clock.now += 1_000);

describe('Loom source', () => {
  it('refreshes phase metadata on messages already ingested, without duplicating their text', async () => {
    const id = await newThread();
    const runId = runtime.last.run;
    tick();
    runtime.last.emit({ type: 'message.completed', runId, messageId: 'phase-note', text: 'Working on it.' });
    await until(() => expect(h.core.store.messages(`loom:${id}`).some(m => m.messageId === 'loom:phase-note')).toBe(true));
    tick();
    runtime.last.emit({ type: 'message.phase', runId, messageIds: ['phase-note'], phase: 'note' });
    runtime.last.emit({ type: 'message.completed', runId, text: 'Finished.', phase: 'answer' });
    await until(() => {
      const detail = itemDetail(h.core, `loom:${id}`, []);
      expect(detail?.sinceOwner?.first?.text).toBe('Finished.');
      expect(detail?.sinceOwner?.first?.notes).toMatchObject([{ text: 'Working on it.' }]);
      expect(h.core.store.messages(`loom:${id}`).filter(m => m.messageId === 'loom:phase-note')).toHaveLength(1);
    });
  });

  it.each(['tango-agent', 'tango-job', 'probe'])('does not list %s Loom threads twice', async (kind) => {
    // Exercise ingestion directly so this remains independent of Loom part A.
    (source as unknown as { ingest(detail: unknown): void }).ingest({
      thread: { id: 'tango-owned', kind }, runs: [], messages: [], items: [], requests: [],
    });
    expect(item('tango-owned')).toBeFalsy();
  });

  it('retires probes filed before the desk upgrade without summarizing them', async () => {
    const id = 'previous-probe';
    h.core.ensureItem({ id: `loom:${id}`, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', createdAt: h.clock.now, place: 'Research' }, 'agent');
    h.core.store.patchItem(`loom:${id}`, { messageCount: 1, facts: { contentKey: 'old:1' } });
    h.core.store.setMarker(`loom:${id}`, JSON.stringify({ settled: false }));
    const schedule = vi.spyOn(h.core, 'scheduleSummary');
    const summarize = vi.fn(h.summarizer.impl); h.summarizer.impl = summarize;
    (source as unknown as { ingest(detail: unknown): void }).ingest({
      thread: { id, kind: 'probe' }, runs: [], messages: [], items: [], requests: [],
    });
    await source.idle();
    await h.core.drainSummaries();
    expect(item(id)?.disposition).toBe('done');
    expect(schedule).not.toHaveBeenCalled();
    expect(h.core.store.marker(`loom:${id}`)).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('probe events produce no summary, Feed or catch-up source activity and remain readable', async () => {
    const ingest = source as unknown as { ingest(detail: unknown): void };
    const feed = new DeskFeed(h.db, () => h.clock.now);
    (h.core as unknown as { options: { feed: DeskFeed } }).options.feed = feed;
    const summarize = vi.fn(h.summarizer.impl); h.summarizer.impl = summarize;
    const settled = vi.spyOn(h.core, 'settle');
    const facts = vi.spyOn(h.core, 'setFacts');
    const thread = loom.store.tx(() => loom.store.createThread({ id: 'probe-hidden', kind: 'probe', title: 'Internal research', cwd: '/work/tango', provider: 'claude' }));
    ingest.ingest({ thread, runs: [{ id: 'r', status: 'completed', ended_at: 12 }], messages: [{ role: 'assistant', text: '{"answer":"yes"}' }], items: [], requests: [] });
    await source.idle();
    expect(item(thread.id)).toBeFalsy();
    expect(settled).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(feed.recent()).toEqual([]);
    expect((await source.threads())?.some(t => t.id === thread.id)).toBe(false);
    const response = await fetch(`http://127.0.0.1:${port}/threads/${thread.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
  });

  it('a scheduled job that asks the owner something is filed until the ask is answered', async () => {
    const result = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Nightly review', kind: 'tango-job' });
    const id = result.threadId!;
    await source.idle();
    expect(item(id)).toBeFalsy();
    tick();
    runtime.last.emit({
      type: 'request.opened', runId: runtime.last.run, requestId: 'job-q', kind: 'question',
      payload: { questions: [{ question: 'Archive these 3 receipts?', header: 'Receipts', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }] },
    });
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', facts: { pending: { kind: 'question', requestId: 'job-q' } } }));
  });

  it("a scheduled job's answered brief keeps its rule line on the item it files as done", async () => {
    const id = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Nightly review', kind: 'tango-job' })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: {
      class: 'product-choice-in-scope', about: 'Test project', ask: 'Archive receipts monthly? Recommend: yes.', door: 'two-way', blast: 'private', standing: 'Receipts pile up.', background: 'The nightly job files them.',
      proposedRule: 'Next time, for receipt archiving, archive monthly',
      options: [{ key: 'A', label: 'Monthly', consequence: 'Tidy', recommended: true }, { key: 'B', label: 'Never', consequence: 'Piles up' }] } });
    await until(() => expect(item(id)!.facts.pending?.requestId).toBe('decision:D-4'));
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { requestId: 'decision:D-4', answers: { decision: 'A · Monthly (Recommended)' }, rule: 'always' } })).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.rulesSaved).toMatchObject([{ decisionId: 'D-4', choice: 'always', ruleId: 'R-1', ruleState: 'active' }]));
  });

  it('a new thread shows with its words, working while it runs and back once it answers', async () => {
    const id = await newThread();
    await until(() => expect(item(id)).toMatchObject({ source: 'loom', kind: 'thread', agentName: 'Loom', area: 'tango', place: 'tango · Build the overview map', nextStep: 'working', messageCount: 1 }));
    tick();
    runtime.last.complete('The overview map is up.');
    await until(() => expect(item(id)).toMatchObject({ messageCount: 2, facts: { running: null, lastAuthor: 'agent' } }));
    expect(item(id)!.nextStep).not.toBe('working');
  });

  it("a thread's context size reaches its facts from Loom's usage record", async () => {
    const id = await newThread();
    const session = runtime.last;
    session.emit({ type: 'context.observed', runId: session.run, context: 312_000, cacheRead: 300_000, cacheWrite: 11_000, output: 400 });
    session.complete('Done.');
    await until(() => expect(item(id)!.facts.context).toMatchObject({ tokens: 312_000, today: 312_000, callsToday: 1 }));
  });

  it('a question is a pending card, and its answer reaches the harness as AskUserQuestion answers', async () => {
    const id = await newThread();
    tick();
    runtime.last.emit({
      type: 'request.opened',
      runId: runtime.last.run,
      requestId: 'req-1',
      kind: 'question',
      payload: {
        questions: [
          { question: 'Which cleanups?', header: 'Cleanup', options: [{ label: 'All', description: 'Everything' }, { label: 'Only lint', description: '' }], multiSelect: false },
          { question: 'Which checks?', header: 'Checks', options: [{ label: 'Types', description: '' }, { label: 'Tests', description: '' }], multiSelect: true },
        ],
      },
    });
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', ask: 'Which cleanups? (+1 more)', options: ['All', 'Only lint'], facts: { pending: { kind: 'question', requestId: 'req-1' } } }));
    expect(item(id)!.facts.pending!.questions[1]).toMatchObject({ id: 'Which checks?', multiSelect: true });

    const result = await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { requestId: 'req-1', answers: { 'Which cleanups?': 'All', 'Which checks?': ['Types', 'Tests'] } } });
    expect(result).toMatchObject({ status: 'applied' });
    expect(runtime.last.answers).toEqual([{ requestId: 'req-1', answer: { answers: { 'Which cleanups?': 'All', 'Which checks?': 'Types, Tests' } } }]);
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'working', facts: { pending: null } }));
    // Answered already: a second answer to it is the question having changed.
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { answers: { 'Which cleanups?': 'All', 'Which checks?': ['Types'] } } })).toMatchObject({ status: 'failed' });
  });

  it('an owner reply moves a brief out of Needs you until the responsible turn ends', async () => {
    const id = await newThread();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: {
      class: 'plan-approval', about: 'Test project', ask: 'Use the monthly plan? Recommend: monthly.', door: 'two-way', blast: 'private',
      standing: 'Both plans work.', background: 'Choose a billing period.',
      options: [{ key: 'A', label: 'Monthly', consequence: 'Flexible', recommended: true }, { key: 'B', label: 'Annual', consequence: 'Locked in' }],
      proposedRule: 'Next time, for fixture plans, use monthly',
    } });
    runtime.last.complete('Brief D-4 is up.');
    await until(() => expect(item(id)!.facts.pending?.requestId).toBe('decision:D-4'));
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: 'Explain the tradeoff' });
    await until(() => expect(item(id)!.facts.discussing).toMatchObject([{ id: 'D-4' }]));
    expect(item(id)!.facts.pending).toBeNull();
    expect(item(id)!.facts.openBriefCount).toBe(0);
    expect(deskStatus(item(id)!, h.clock.now)).toMatchObject({ countsForOwner: false, detail: 'In discussion · D-4' });
    tick(); runtime.last.complete('Here is the tradeoff.');
    await until(() => expect(item(id)!.facts.pending?.brief?.unaddressedAt).toBeTruthy());
    expect(deskStatus(item(id)!, h.clock.now).pill).toBe('needs');
  });

  it.each([[false, 'keep'], [true, 'keep'], [false, 'update'], [true, 'update']] as const)('a brief stays in discussion until viewed (steered: %s, action: %s)', async (steered, action) => {
    const id = await newThread();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: {
      class: 'plan-approval', about: 'Test project', ask: 'Use the monthly plan? Recommend: monthly.', door: 'two-way', blast: 'private',
      standing: 'Both plans work.', background: 'Choose a billing period.',
      options: [{ key: 'A', label: 'Monthly', consequence: 'Flexible', recommended: true }, { key: 'B', label: 'Annual', consequence: 'Locked in' }],
      proposedRule: 'Next time, for fixture plans, use monthly',
    } });
    if (!steered) runtime.last.complete('Brief D-4 is up.');
    await until(() => expect(item(id)!.facts.pending?.requestId).toBe('decision:D-4'));
    tick();
    const inject = vi.fn();
    if (steered) Object.assign(runtime.last, { inject });
    const reply = await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: 'Explain the tradeoff', steer: steered });
    if (steered) {
      expect(reply.steered).toBe(true);
      expect(inject).toHaveBeenCalled();
      expect(loom.store.run(reply.runId!)!.started_at).toBeLessThan(loom.store.decision('D-4')!.discussing_since!);
    }
    await until(() => expect(item(id)!.facts.discussing).toMatchObject([{ id: 'D-4' }]));
    expect(item(id)!.facts.discussing?.[0]?.runId).toBe(reply.runId);
    expect(item(id)!.facts.pending).toBeNull();
    expect(item(id)!.facts.openBriefCount).toBe(0);
    expect(deskStatus(item(id)!, h.clock.now)).toMatchObject({ countsForOwner: false, detail: 'In discussion · D-4' });
    await loom.host.execute({ type: action === 'keep' ? 'decision.keep' : 'decision.update', commandId: cid(), threadId: id, decisionId: 'D-4', why: 'The owner asked about the links', ...(action === 'update' ? { changes: { standing: 'The links now show both plans.' } } : {}) });
    runtime.last.emit({ type: 'message.completed', runId: runtime.last.run, text: 'Here are the fixed links.' });
    await until(() => expect(item(id)!.facts.lastAgentWords?.text).toBe('Here are the fixed links.'));
    expect(await h.core.command({ commandId: cid(), type: 'viewed', itemId: `loom:${id}`, args: { ms: 3000 } })).toMatchObject({ status: 'applied' });
    expect(item(id)!.seen).toBe('seen');
    tick(); runtime.last.emit({ type: 'turn.completed', runId: runtime.last.run });
    await until(() => expect(item(id)!.seen).not.toBe('seen'));
    await until(() => expect(item(id)!.facts.lastAgentWords?.text).toBe('Here are the fixed links.'));
    expect(item(id)!.facts.pending).toBeNull();
    expect(deskStatus(item(id)!, h.clock.now)).toMatchObject({ basis: 'source:discussion' });
    tick();
    await h.core.command({ commandId: cid(), type: 'viewed', itemId: `loom:${id}`, args: { ms: 2999 } });
    expect(loom.store.decision('D-4')!.discussing_since).not.toBeNull();
    await h.core.command({ commandId: cid(), type: 'viewed', itemId: `loom:${id}`, args: { ms: 3000 } });
    await until(() => expect(item(id)!.facts.pending?.requestId).toBe('decision:D-4'));
    expect(loom.store.decision('D-4')).toMatchObject({ unaddressed_at: null, window_from: h.clock.now });
    expect(deskStatus(item(id)!, h.clock.now).pill).toBe('needs');
  });

  it('a decision brief is Needs you between turns; a chip answers it in Loom and wakes the thread with the choice', async () => {
    const id = await newThread();
    tick();
    const brief = {
      class: 'plan-approval', about: 'Test project',
      ask: 'Ship decision briefs as planned? Recommend: yes.',
      door: 'two-way',
      blast: 'private',
      standing: 'Loom tools and the desk card are built and tested.',
      background: 'Phase 1 of the decisions pillar: briefs replace questions in replies.',
      options: [
        { key: 'A', label: 'Ship it', consequence: 'Agents start sending briefs', recommended: true },
        { key: 'B', label: 'Hold', consequence: 'Nothing changes yet' },
      ],
      assets: [{ kind: 'pr', title: 'PR', url: 'https://github.com/example/repo/pull/1' }],
      proposedRule: 'Next time, for phase plans already in the spec, go ahead without asking',
    };
    const asked = await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief });
    runtime.last.complete('Brief D-4 is up.');
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', ask: brief.ask, facts: { pending: { kind: 'question', requestId: `decision:${asked.decisionId}` } } }));
    const pending = item(id)!.facts.pending!;
    expect(pending.options).toEqual(['A · Ship it (Recommended)', 'B · Hold']);
    expect(pending.brief).toMatchObject({ id: 'D-4', candidate: true, standing: brief.standing, assets: brief.assets, proposedRule: brief.proposedRule });
    expect(deskStatus(item(id)!, h.clock.now).move).toBe('needs');

    tick();
    expect(await h.core.command({ commandId: cid(), type: 'answer', itemId: `loom:${id}`, args: { option: 'A · Ship it (Recommended)' } })).toMatchObject({ status: 'applied' });
    // D-61: a first approval as recommended is a precedent ("Just this once"), not a rule.
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'A', followed_recommendation: 1, rule_choice: 'once', precedent: 1 });
    await vi.waitFor(() => expect(runtime.last.turns.at(-1)?.text).toContain('I chose A: Ship it.'));
    await until(() => expect(item(id)!.facts.pending).toBeNull());
    // Answered: answering again is the question having changed.
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { requestId: 'decision:D-4', answers: { decision: 'B · Hold' } } })).toMatchObject({ status: 'failed' });
  });

  it("the owner's desk activity is Loom's active time, and a level 3 brief shows how much of its veto window is left", async () => {
    const id = await newThread();
    tick();
    // As setup.ts wires it.
    h.core.onOwnerActivity((at, from) => source.beat(at, from));
    h.core.noteScreenActivity();
    await vi.waitFor(() => expect(loom.host.presence.lastBeat()).toBe(h.clock.now));
    const brief = {
      class: 'product-choice-in-scope', about: 'Test project', ask: 'Label the countdown in active time? Recommend: yes.', door: 'two-way', blast: 'private',
      standing: 'Countdowns run on active time.', background: 'D-1 set the window.', proposedRule: 'Next time, for countdown copy, use active time',
      options: [{ key: 'A', label: 'Active time', consequence: 'Honest', recommended: true }, { key: 'B', label: 'Clock', consequence: 'Wrong when idle' }],
    };
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief });
    await until(() => expect(item(id)!.facts.pending?.brief).toMatchObject({ level: 3, defaultOption: 'A', vetoLeftMs: 4 * 60 * 60_000, vetoWindowMs: 4 * 60 * 60_000 }));
    // The card splits each option label by the brief's own keys (TGO-1080).
    expect(item(id)!.facts.pending!.brief!.optionKeys).toEqual(item(id)!.facts.pending!.questions[0].options.map((o) => o.label.split(' · ')[0]));
    expect(item(id)!.facts.pending!.questions[0]!.header).toBe('Your options');
  });

  it('what agents decided: level 4 logs and level 3 defaults read from Loom, with Undo and "I wouldn\'t have" back into Loom', async () => {
    const decided = new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now });
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided });
    // Loom reads up to the millisecond before now (a same-millisecond write comes in the next read): reads step the clock.
    const get = async () => { h.clock.now += 1; return (await source.decided(0))!; };
    const post = (route: string, body: unknown) => app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const merge = await newThread('Merge the reconnect fix');
    const copy = await newThread('Countdown copy');
    const session = (threadId: string) => runtime.sessions.find((s) => s.options.threadId === threadId)!;
    await vi.waitFor(() => expect(session(merge)).toBeTruthy());
    session(merge).complete('Merged.');
    tick();
    await loom.host.execute({ type: 'decision.log', commandId: cid(), threadId: merge, class: 'merge-when-green', summary: 'Merged #12: CI green, threads resolved', undo: 'Revert the merge commit', ref: 'https://github.com/example/repo/pull/12' });
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: copy, brief: {
      class: 'product-choice-in-scope', about: 'Test project', ask: 'Label the countdown in active time? Recommend: yes.', door: 'two-way', blast: 'private',
      standing: 'Countdowns run on active time.', background: 'D-1 set the window.', proposedRule: 'Next time, for countdown copy, use active time',
      options: [{ key: 'A', label: 'Active time', consequence: 'Honest', recommended: true }, { key: 'B', label: 'Clock', consequence: 'Wrong when idle' }] } });
    for (let m = 0; m <= 240; m++) { h.clock.now += 60_000; loom.host.beat(); }
    (loom.host as unknown as { vetoClock: { tick(): void } }).vetoClock.tick();

    const first = await get();
    expect(first.decisions.map((d) => [d.id, d.status, d.class])).toEqual([['D-5', 'defaulted', 'product-choice-in-scope'], ['D-4', 'acted', 'merge-when-green']]);
    expect(first.decisions[1]).toMatchObject({ thread_id: merge, summary: 'Merged #12: CI green, threads resolved', undo: 'Revert the merge commit', ref: 'https://github.com/example/repo/pull/12', reversal: null });
    expect(first.decisions[0]).toMatchObject({ thread_id: copy, summary: expect.stringContaining('→ A · Active time'), undo: null });

    // "I wouldn't have": recorded in Loom, nothing wakes.
    const runs = loom.store.runs(copy).length;
    expect((await post('/api/desk/decided/reverse', { decisionId: 'D-5', undo: false, note: 'I like clocks', commandId: cid() })).status).toBe(200);
    expect(loom.store.decision('D-5')).toMatchObject({ reversal: 'disagree', reversal_note: 'I like clocks' });
    // Undo: the thread that did it wakes with the owner's words.
    const undoId = cid();
    expect((await post('/api/desk/decided/reverse', { decisionId: 'D-4', undo: true, note: 'Wait for the second review', commandId: undoId })).status).toBe(200);
    // Its answer lost, the desk retries with the same command id: Loom replays the receipt, no "already reversed".
    expect((await post('/api/desk/decided/reverse', { decisionId: 'D-4', undo: true, note: 'Wait for the second review', commandId: undoId })).status).toBe(200);
    await vi.waitFor(() => expect(session(merge).turns.at(-1)?.text).toContain('Undo D-4: Merged #12: CI green, threads resolved. Wait for the second review'));
    expect(loom.store.runs(copy)).toHaveLength(runs);
    // A retry of the same command (its answer was lost) replays Loom's receipt instead of failing as "already reversed".
    // Twice is refused, with Loom's reason.
    const again = await post('/api/desk/decided/reverse', { decisionId: 'D-4', undo: true, commandId: cid() });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: expect.stringMatching(/already reversed/) });
    expect((await get()).decisions).toMatchObject([{ id: 'D-5', reversal: 'disagree' }, { id: 'D-4', reversal: 'undo' }]);

    // The Decided for you card and its seen cursor are retired: these reach the owner as catch-up lines.
    expect((await app.request('/api/desk/decided')).status).toBe(404);
    tick();
    await loom.host.execute({ type: 'decision.log', commandId: cid(), threadId: merge, class: 'pr-housekeeping', summary: 'Marked #13 ready for review' });
    expect((await get()).decisions.map((d) => d.id)).toContain('D-6');
    // Loom not answering is an unknown outcome (502, unknown), so the desk keeps the command id for its retry.
    await stopLoom();
    const lost = await post('/api/desk/decided/reverse', { decisionId: 'D-6', undo: false, commandId: cid() });
    expect(lost.status).toBe(502);
    expect(await lost.json()).toMatchObject({ unknown: true });
    port = await startLoom(port);
  });

  it('catch-up Accept: takes the recommendation through the normal answer path, with no new rule; a chapter that changed is refused with its plan (TGO-1103)', async () => {
    const decided = new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now });
    const updates = new DeskUpdates({ db: new DatabaseSync(':memory:'), items: () => h.core.items(), spaceOf: () => 'project:p', coverThread: () => {}, thread: { coveredUntil: () => null, messagesBetween: () => 0 }, exec: null, now: () => h.clock.now });
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided, updates });
    const post = (route: string, body: unknown) => app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const chapter = async () => (await app.request('/api/desk/chapters/project:p')).json() as Promise<{ plan: { updateIds: number[]; revision: string; line: string; take: unknown[] }; briefs: Array<{ id: string; options: Array<{ key: string; recommended: boolean }> }> }>;
    const id = await newThread('Countdown copy');
    const session = () => runtime.sessions.find((s) => s.options.threadId === id)!;
    await vi.waitFor(() => expect(session()).toBeTruthy());
    session().complete('Built.');
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: {
      class: 'product-choice-in-scope', about: 'Test project', ask: 'Label the countdown in active time? Recommend: yes.', door: 'two-way', blast: 'private',
      standing: 'Countdowns run on active time.', background: 'D-1 set the window.', proposedRule: 'Next time, for countdown copy, use active time',
      options: [{ key: 'A', label: 'Active time', consequence: 'Honest', recommended: true }, { key: 'B', label: 'Clock', consequence: 'Wrong when idle' }],
    } });
    await until(() => expect(item(id)!.facts.openBrief?.brief?.id).toBeTruthy());
    const briefId = item(id)!.facts.openBrief!.brief!.id;
    updates.record({ spaceId: 'project:p', itemId: `loom:${id}`, kind: 'needs', title: 'Label the countdown in active time?', briefId, source: 'auto:brief' });
    updates.record({ spaceId: 'project:p', kind: 'shipped', title: 'Countdown shipped', source: 'lead' });

    const shown = await chapter();
    // The open brief is a line, not also waiting (the card would show it twice).
    expect((shown as unknown as { waiting: unknown[] }).waiting).toEqual([]);
    expect(shown.plan.line).toContain("choose A on “Label the countdown in active time”");
    expect(shown.briefs[0]).toMatchObject({ id: briefId, options: [{ key: 'A', recommended: true }, { key: 'B', recommended: false }] });
    // Something new since the owner looked: refused with the new plan, nothing answered.
    updates.record({ spaceId: 'project:p', kind: 'fyi', title: 'Something new', source: 'lead' });
    const refused = await post('/api/desk/chapters/project:p/accept', { updateIds: shown.plan.updateIds, revision: shown.plan.revision });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ changed: true, plan: { updateIds: expect.any(Array) } });
    expect(loom.store.decision(briefId)!.status).toBe('open');

    const again = await chapter();
    const command = { updateIds: again.plan.updateIds, revision: again.plan.revision, commandId: cid() };
    const accepted = await post('/api/desk/chapters/project:p/accept', command);
    const first = await accepted.json();
    expect(first).toMatchObject({ ok: true, applied: { took: [briefId], seen: 2 }, failed: [] });
    // The response lost on the way: the same command gets the same answer back, not "something new came in".
    const retried = await post('/api/desk/chapters/project:p/accept', command);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(first);
    // Answered as a tap would, but never a rule: Accept answers a candidate "Ask me next time".
    expect(loom.store.decision(briefId)).toMatchObject({ status: 'answered', rule_id: null });
    expect((await chapter()).plan.updateIds).toEqual([]);
  });

  it('rule chips: an answer says how it counts; a new rule is a catch-up moment, where its chips change it; the weekly review reads Loom', async () => {
    const decided = new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now });
    const updates = new DeskUpdates({ db: new DatabaseSync(':memory:'), items: () => h.core.items(), spaceOf: () => 'project:p', coverThread: () => {}, thread: { coveredUntil: () => null, messagesBetween: () => 0 }, exec: null, now: () => h.clock.now });
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided, updates });
    const post = (route: string, body: unknown) => app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const id = await newThread('Countdown copy');
    const session = () => runtime.sessions.find((s) => s.options.threadId === id)!;
    await vi.waitFor(() => expect(session()).toBeTruthy());
    session().complete('Built.');
    const brief = (rule: string) => ({
      class: 'product-choice-in-scope', about: 'Test project', ask: 'Label the countdown in active time? Recommend: yes.', door: 'two-way', blast: 'private',
      standing: 'Countdowns run on active time.', background: 'D-1 set the window.', proposedRule: rule,
      options: [{ key: 'A', label: 'Active time', consequence: 'Honest', recommended: true }, { key: 'B', label: 'Clock', consequence: 'Wrong when idle' }],
    });
    const answer = async (decisionId: string, args: Record<string, unknown>) => {
      await until(() => expect(item(id)!.facts.pending?.requestId).toBe(`decision:${decisionId}`));
      return h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { requestId: `decision:${decisionId}`, answers: { decision: 'A · Active time (Recommended)' }, ...args } });
    };

    // "Just this once", with a reason: no rule; kept as a precedent (D-61).
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: brief('Next time, for countdown copy, use active time') });
    // A rule that isn't one of the three is refused, not dropped: the brief stays open (dropped, it would default to Always).
    expect(await answer('D-4', { rule: 'oncee' })).toMatchObject({ status: 'failed' });
    expect(loom.store.decision('D-4')!.status).toBe('open');
    expect(await answer('D-4', { rule: 'once', reason: 'Copy differs per card' })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ rule_choice: 'once', answer_reason: 'Copy differs per card', rule_id: null, precedent: 1 });
    await vi.waitFor(() => expect(session().turns.at(-1)?.text).toContain("it's a precedent, not a rule"));
    session().complete('Done.');

    // Always on the chip makes the rule at once (no longer the default: D-61).
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: brief('Next time, for timer labels, use active time') });
    expect(await answer('D-5', { rule: 'always' })).toMatchObject({ status: 'applied' });
    expect(loom.host.rules.rule('R-1')).toMatchObject({ scope: 'timer labels', level: 4, state: 'active' });

    h.clock.now += 1;
    const read = (await source.decided(0))!;
    // The owner's own rule isn't "decided for them": not a catch-up moment; the answered brief says it was saved.
    expect(read.rules).toEqual([]);
    await until(() => expect(item(id)!.facts.rulesSaved).toMatchObject([{ decisionId: 'D-5', choice: 'always', ruleId: 'R-1', ruleState: 'active', text: 'for timer labels, use active time' }, { decisionId: 'D-4', choice: 'once' }]));
    // A rule line already in the catch-up (recorded before) is handled by the chip too; a fine-by-me line on the same decision isn't one.
    const ruleLine = updates.record({ spaceId: 'project:p', itemId: `loom:${id}`, kind: 'decided', alwaysMoment: true, title: 'R-1: for timer labels, use active time', decisionId: 'D-5', data: { ruleEvent: 'rule-created', rule: 'R-1', ruleChoice: 'always' }, source: 'auto:decision', subject: 'rule:E-1' });
    const plain = updates.record({ spaceId: 'project:p', kind: 'decided', title: 'Answered D-5', decisionId: 'D-5', source: 'auto:decision', subject: 'decision:D-5' });
    // Changed from the answered brief: Ask me next time (its Undo) withdraws it.
    const changed = await post('/api/desk/decided/rule', { decisionId: 'D-5', rule: 'next-time', commandId: cid() });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ ok: true, rule: null, ruleState: 'retired' });
    expect(loom.host.rules.rule('R-1')!.state).toBe('retired');
    await until(() => expect(item(id)!.facts.rulesSaved![0]).toMatchObject({ choice: 'next-time', ruleId: 'R-1', ruleState: 'retired' }));
    expect(updates.get(ruleLine.id)).toMatchObject({ seenVia: 'acted', outcome: 'next-time', data: { ruleEvent: 'rule-created', ruleChoice: 'next-time' } });
    expect(updates.get(plain.id)!.seenAt).toBeNull();
    const refused = await post('/api/desk/decided/rule', { decisionId: 'D-404', rule: 'always', commandId: cid() });
    expect(refused.status).toBe(409);
    expect((await post('/api/desk/decided/rule', { decisionId: 'D-5', rule: 'sometimes' })).status).toBe(400);

    // The review: due until put away, then back in a week.
    const review = async () => { h.clock.now += 1; return (await app.request('/api/desk/decided/review')).json() as Promise<{ due: boolean; review: { until: number; created: unknown[]; suspended: unknown[] } }>; };
    const shown = await review();
    expect(shown).toMatchObject({ due: true, review: { created: [expect.objectContaining({ rule: 'R-1' })], suspended: [expect.objectContaining({ kind: 'rule-withdrawn' })] } });
    // A change lands between reading the review and "Got it": it isn't in the one they saw, so it waits for the next.
    h.clock.now += 60_000;
    const again = await post('/api/desk/decided/rule', { decisionId: 'D-5', rule: 'always', commandId: cid() });
    // One decision, one rule: Always again brings R-1 back rather than making a second rule.
    expect(await again.json()).toMatchObject({ ok: true, rule: 'R-1', ruleState: 'active' });
    expect(loom.host.rules.rule('R-1')!.state).toBe('active');
    expect(loom.host.rules.rule('R-2')).toBeUndefined();
    expect((await post('/api/desk/decided/review/seen', { until: shown.review.until })).status).toBe(200);
    expect(decided.reviewSeenAt()).toBe(shown.review.until);
    expect((await review()).due).toBe(false);
    // A week on, it reads from the end of the one they saw, however late they come back: the change is in it.
    h.clock.now += 9 * 86_400_000;
    expect(await review()).toMatchObject({ due: true, review: { created: [expect.objectContaining({ rule: 'R-1', kind: 'rule-restored' })] } });
    // A rule due for review: Got it moves it to its next review in Loom, so it doesn't come back every week.
    h.clock.now += 85 * 86_400_000;
    const due = await review() as unknown as { review: { until: number; due: Array<{ id: string }> } };
    expect(due.review.due.map((r) => r.id)).toEqual(['R-1']);
    expect((await post('/api/desk/decided/review/seen', { until: due.review.until, rules: ['R-1'], commandId: cid() })).status).toBe(200);
    expect(loom.host.rules.rule('R-1')!.review_at).toBeGreaterThan(h.clock.now + 80 * 86_400_000);
    // Left unread for weeks, the review still reaches back to the last one: nothing older than 30 days is dropped.
    const seenUntil = decided.reviewSeenAt()!;
    h.clock.now += 3_600_000;
    expect((await post('/api/desk/decided/rule', { decisionId: 'D-4', rule: 'always', commandId: cid() })).status).toBe(200);
    h.clock.now += 40 * 86_400_000;
    const late = await review() as unknown as { due: boolean; review: { since: number; created: Array<{ rule: string }> } };
    expect(late.review.since).toBe(seenUntil + 1);
    expect(late.review.created.map((e) => e.rule)).toContain('R-2');
    expect((await post('/api/desk/decided/review/seen', { until: (late.review as unknown as { until: number }).until })).status).toBe(200);
    // Put away again, with nothing new, it stays away.
    expect((await post('/api/desk/decided/review/seen', { until: h.clock.now })).status).toBe(200);
    h.clock.now += 8 * 86_400_000;
    expect((await review()).due).toBe(false);
  });

  it('D-61: the second similar approval proposes one rule on the answered brief, made with one tap', async () => {
    const decided = new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now });
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided });
    const post = (route: string, body: unknown) => app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const id = await newThread('Countdown copy');
    const session = () => runtime.sessions.find((s) => s.options.threadId === id)!;
    await vi.waitFor(() => expect(session()).toBeTruthy());
    session().complete('Built.');
    const brief = (ask: string, rule: string) => ({
      class: 'product-choice-in-scope', about: 'Test project', ask, door: 'two-way', blast: 'private', standing: 'Countdowns run on active time.', background: 'D-1 set the window.', proposedRule: rule,
      options: [{ key: 'A', label: 'Active time', consequence: 'Honest', recommended: true }, { key: 'B', label: 'Clock', consequence: 'Wrong when idle' }],
    });
    const answer = async (decisionId: string) => {
      await until(() => expect(item(id)!.facts.pending?.requestId).toBe(`decision:${decisionId}`));
      return h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { requestId: `decision:${decisionId}`, answers: { decision: 'A · Active time (Recommended)' } } });
    };
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: brief('Label the countdown in active time? Recommend: yes.', 'Next time, for countdown copy, use active time') });
    expect(await answer('D-4')).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.rulesSaved?.[0]).toMatchObject({ decisionId: 'D-4', choice: 'once', precedent: true, proposal: null }));
    session().complete('Done.');
    // The second similar call: its card says so; the answer proposes a rule for both.
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: brief('Label the badge countdown in active time? Recommend: yes.', 'Next time, for countdown copy on badges, use active time') });
    await until(() => expect(item(id)!.facts.pending?.brief).toMatchObject({ id: 'D-5', precedentOf: 'D-4' }));
    expect(await answer('D-5')).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.rulesSaved?.[0]).toMatchObject({ decisionId: 'D-5', proposal: { from: ['D-4', 'D-5'], state: 'proposed', text: 'Next time, for countdown copy, use active time without asking' } }));
    expect(loom.host.rules.all().filter((r) => r.state === 'active')).toEqual([]);
    // Make it a rule: one tap.
    const made = await post('/api/desk/decided/rule', { decisionId: 'D-5', rule: 'always', proposal: 'Next time, for countdown copy, use active time without asking', commandId: cid() });
    expect(await made.json()).toMatchObject({ ok: true, rule: 'R-1', ruleState: 'active' });
    expect(loom.host.rules.rule('R-1')).toMatchObject({ scope: 'countdown copy', source: '["D-4","D-5"]' });
    await until(() => expect(item(id)!.facts.rulesSaved?.[0]).toMatchObject({ choice: 'always', ruleId: 'R-1', ruleState: 'active', proposal: { state: 'made' } }));
  });

  it('a plan asks for approval: Approve approves, anything else sends it back with the feedback', async () => {
    const id = await newThread();
    tick();
    runtime.last.emit({ type: 'request.opened', runId: runtime.last.run, requestId: 'plan-1', kind: 'plan', payload: { plan: '1. Add the table\n2. Wire the route' } });
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', ask: 'Approve this plan?', options: ['Approve', 'Request changes'] }));
    // The plan itself is in the conversation, so the owner reads what they approve.
    expect(h.core.store.messages(`loom:${id}`).map((message) => message.text)).toContain('1. Add the table\n2. Wire the route');
    await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { answers: { plan: 'Approve' } } });
    expect(runtime.last.answers.at(-1)).toEqual({ requestId: 'plan-1', answer: { approve: true } });

    tick();
    runtime.last.emit({ type: 'request.opened', runId: runtime.last.run, requestId: 'plan-2', kind: 'plan', payload: { plan: 'Rewrite it in Rust' } });
    await until(() => expect(item(id)!.facts.pending).toMatchObject({ requestId: 'plan-2' }));
    await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { answers: { plan: 'Keep it TypeScript' } } });
    expect(runtime.last.answers.at(-1)).toEqual({ requestId: 'plan-2', answer: { approve: false, feedback: 'Keep it TypeScript' } });
  });

  it('a reply submits a turn that queues behind the running one; stopped threads and a dead Loom are refused', async () => {
    const id = await newThread();
    await until(() => expect(item(id)).toBeTruthy());
    tick();
    expect(await h.core.command({ commandId: 'reply-1', type: 'reply', itemId: `loom:${id}`, args: { text: 'Also add a legend' } })).toMatchObject({ status: 'applied' });
    expect(loom.store.runs(id).map((run) => [run.text, run.status])).toEqual([['Build the overview map', 'running'], ['Also add a legend', 'queued']]);
    tick();
    runtime.last.complete('Map done.');
    await vi.waitFor(() => expect(runtime.last.turns.map((turn) => turn.text)).toEqual(['Build the overview map', 'Also add a legend']));
    await until(() => expect(item(id)).toMatchObject({ messageCount: 3, nextStep: 'working' }));

    const row = item(id)!;
    await loom.host.execute({ type: 'stop', commandId: cid(), threadId: id });
    expect(await source.reply(row, 'more', { commandId: cid() })).toEqual({ ok: false, error: 'this thread was stopped in Loom' });
    const dead = new DeskLoomSource({ core: h.core, url: 'http://127.0.0.1:1', tokenFile: path.join(h.dir, 'token') });
    expect(await dead.reply(row, 'more', { commandId: cid() })).toMatchObject({ ok: false, unknown: true });
  });

  it('a usage limit shows as failed, saying so', async () => {
    const id = await newThread();
    tick();
    runtime.last.emit({ type: 'turn.failed', runId: runtime.last.run, failure: { kind: 'usage_limit', message: "You've hit your limit", resetAt: h.clock.now + 3_600_000 } });
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'failed', facts: { failed: { reason: 'usage_limit' } } }));
    expect(item(id)!.facts.failed!.message).toMatch(/^Usage limit reached \(resets .+\): You've hit your limit$/);
  });

  it('Clear and Undo write the standing handoff to Loom without settling it', async () => {
    const id = await newThread();
    await loom.host.execute({ type: 'role', commandId: cid(), threadId: id, role: 'default' });
    tick();
    runtime.last.complete('**Next — you:** buy the headlight.');
    await until(() => expect(item(id)?.facts.openAsk).toBeTruthy());
    const ask = loom.store.thread(id)!.ask;
    tick();
    const clear = await h.core.command({ commandId: cid(), type: 'done', itemId: `loom:${id}` });
    expect(clear.outcome).toMatchObject({ cleared: true, writeback: { outcome: 'ok' } });
    expect(loom.store.thread(id)!.ask).toBeNull();
    expect(loom.store.thread(id)!.settled_at).toBeNull();
    loom.host.rebuildAsks();
    expect(loom.store.thread(id)!.ask).toBeNull();
    await until(() => expect(item(id)?.facts.openAsk).toBeNull());
    await h.core.command({ commandId: cid(), type: 'undo', itemId: `loom:${id}`, args: { seq: clear.outcome!.seq } });
    expect(loom.store.thread(id)!.ask).toBe(ask);
    await until(() => expect(item(id)?.facts.openAsk).toBeTruthy());
  });

  it('restores a settled default without filing the desk row', async () => {
    const id = await newThread();
    runtime.last.complete('Done.');
    await until(() => expect(item(id)?.messageCount).toBe(2));
    await loom.host.execute({ type: 'settle', commandId: cid(), threadId: id });
    await until(() => expect(item(id)?.disposition).toBe('done'));
    await loom.host.execute({ type: 'role', commandId: cid(), threadId: id, role: 'default' });
    await until(() => {
      expect(item(id)?.disposition).toBe('active');
      expect(loom.store.thread(id)!.settled_at).toBeNull();
    });
    await loom.host.execute({ type: 'settle', commandId: cid(), threadId: id });
    await until(() => {
      expect(item(id)?.disposition).toBe('active');
      expect(loom.store.thread(id)!.settled_at).toBeNull();
    });
  });

  it('Done settles the thread in Loom, and a deleted thread is done on the desk', async () => {
    const id = await newThread();
    tick();
    runtime.last.complete('Done here.');
    await until(() => expect(item(id)).toMatchObject({ messageCount: 2 }));
    expect(await h.core.command({ commandId: cid(), type: 'done', itemId: `loom:${id}` })).toMatchObject({ status: 'applied', outcome: { writeback: { outcome: 'ok' } } });
    expect(loom.store.thread(id)!.settled_at).not.toBeNull();

    const other = await newThread('Second thread');
    await until(() => expect(item(other)).toMatchObject({ disposition: 'active' }));
    await loom.host.execute({ type: 'delete', commandId: cid(), threadId: other });
    await until(() => expect(item(other)).toMatchObject({ disposition: 'done' }));
  });

  it('reconnects after Loom restarts and resumes from the last sequence it saw', async () => {
    const id = await newThread();
    await until(() => expect(item(id)).toMatchObject({ messageCount: 1 }));
    const seen = loom.store.highWater();
    await stopLoom();
    // Down for a moment: the source retries without throwing into the desk.
    await new Promise((resolve) => setTimeout(resolve, 150));
    urls = [];
    await startLoom(port);
    // The restart interrupted the turn; a new reply after it still arrives.
    tick();
    await vi.waitFor(() => expect(urls.some((url) => url.startsWith('/events?after='))).toBe(true), { timeout: 3_000 });
    const after = Number(urls.find((url) => url.startsWith('/events?after='))!.split('=')[1]);
    expect(after).toBeGreaterThanOrEqual(seen);
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: 'Pick it back up' });
    await until(() => expect(h.core.store.messages(`loom:${id}`).map((message) => message.text)).toContain('Pick it back up'));
    expect(logged).toContain('desk.loom.stream.error');
  });

  it('waits without a token, then connects once Loom writes one', async () => {
    // The suite's own source is connected first, so nothing below is its doing.
    await vi.waitFor(() => expect(urls).toContain('/events'));
    const quiet: string[] = [];
    const tokenFile = path.join(h.dir, 'later-token');
    const waiting = new DeskLoomSource({ core: h.core, url: `http://127.0.0.1:${port}`, tokenFile, retryMs: 20, maxRetryMs: 40, log: (event) => quiet.push(event) });
    urls = [];
    waiting.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quiet).toEqual(['desk.loom.inert']);
    expect(urls).toEqual([]);
    fs.writeFileSync(tokenFile, `${TOKEN}\n`);
    await vi.waitFor(() => expect(urls).toContain('/events'));
    waiting.stop();
  });

  it('finds Loom on LOOM_PORT when no LOOM_URL is set', () => {
    fs.writeFileSync(path.join(h.dir, 'token'), `${TOKEN}\n`);
    expect(loomFromEnv({ LOOM_HOME: h.dir, LOOM_PORT: '9555' })).toEqual({ url: 'http://127.0.0.1:9555', tokenFile: path.join(h.dir, 'token'), accountsFile: path.join(h.dir, 'accounts.json') });
    expect(loomFromEnv({ LOOM_HOME: h.dir, LOOM_ACCOUNTS: '/custom/accounts.json' })!.accountsFile).toBe('/custom/accounts.json');
    expect(loomFromEnv({ LOOM_HOME: h.dir })!.url).toBe('http://127.0.0.1:9420');
    expect(loomFromEnv({ LOOM_HOME: path.join(h.dir, 'nowhere') })).toBeNull();
  });
});

describe('Loom threads in their repo', () => {
  it("files a worktree thread under its repo's project, with the project's icon and color", async () => {
    source.stop();
    const projects = { '/repos/acme': { name: 'acme', icon: 'mountain', color: 'blue' } };
    const placed = new DeskLoomSource({
      core: h.core,
      url: `http://127.0.0.1:${port}`,
      tokenFile: path.join(h.dir, 'token'),
      retryMs: 20,
      maxRetryMs: 100,
      projectFor: (dir) => (dir.startsWith('/repos/acme') ? projects['/repos/acme'] : null),
    });
    placed.start();
    const r = await loom.host.execute({ type: 'submit', commandId: 'p1', text: 'Build the hub', cwd: '/wts/acme/loom-abc12345', repo: '/repos/acme', provider: 'claude', title: 'Build the hub' });
    await vi.waitFor(async () => {
      await placed.idle();
      expect(h.core.item(`loom:${r.threadId}`)).toMatchObject({ area: 'acme', place: 'acme · Build the hub' });
      expect(h.core.item(`loom:${r.threadId}`)!.facts.project).toEqual(projects['/repos/acme']);
    });
    placed.stop();
  });

  it('files threads again when the workspaces arrive late, and drops a project that no longer matches', async () => {
    source.stop();
    let projects: Record<string, { name: string; icon: string | null; color: string | null }> = {};
    const placed = new DeskLoomSource({ core: h.core, url: `http://127.0.0.1:${port}`, tokenFile: path.join(h.dir, 'token'), retryMs: 20, maxRetryMs: 100, projectFor: (dir) => projects[dir] ?? null });
    placed.start();
    const r = await loom.host.execute({ type: 'submit', commandId: 'late1', text: 'Build it', cwd: '/wts/x', repo: '/repos/acme', provider: 'claude', title: 'Build it' });
    await vi.waitFor(async () => {
      await placed.idle();
      expect(h.core.item(`loom:${r.threadId}`)).toMatchObject({ area: 'acme' });
    });
    expect(h.core.item(`loom:${r.threadId}`)!.facts.project ?? null).toBeNull();
    // Loom's first poll lands: the idle thread picks up its project without any Loom change.
    projects = { '/repos/acme': { name: 'acme', icon: 'mountain', color: 'blue' } };
    placed.refile();
    await vi.waitFor(async () => {
      await placed.idle();
      expect(h.core.item(`loom:${r.threadId}`)!.facts.project).toEqual(projects['/repos/acme']);
    });
    // The project goes away: so does the card's icon.
    projects = {};
    placed.refile();
    await vi.waitFor(async () => {
      await placed.idle();
      expect(h.core.item(`loom:${r.threadId}`)!.facts.project ?? null).toBeNull();
    });
    placed.stop();
  });

  it('a rename on the desk is the thread’s name in Loom, and Loom keeps it', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: 'n1', text: '# Handoff: build it', cwd: '/repos/sideproject', provider: 'claude', title: '# Handoff: build it', autoTitle: true });
    await until(() => expect(item(r.threadId!)).toBeTruthy());
    const place = await source.rename(item(r.threadId!)!, 'Sideproject Build');
    expect(place).toBe('sideproject · Sideproject Build');
    expect(loom.store.thread(r.threadId!)).toMatchObject({ title: 'Sideproject Build', title_source: 'owner' });
    await until(() => expect(item(r.threadId!)!.place).toBe('sideproject · Sideproject Build'));
  });

  it('a role Loom keeps is the desk’s, and the desk’s role command changes it in Loom', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: 'w1', text: 'Watch PRs', cwd: '/work/tango', provider: 'claude', role: 'ops', parentThreadId: 'agent:compass' });
    await until(() => expect(item(r.threadId!)!.facts).toMatchObject({ role: 'ops', parentItemId: 'agent:compass' }));
    expect(await h.core.command({ commandId: cid(), type: 'role', itemId: `loom:${r.threadId}`, args: { role: 'worker' } })).toMatchObject({ status: 'applied' });
    expect(loom.store.thread(r.threadId!)).toMatchObject({ role: 'worker', parent_thread_id: 'agent:compass' });
    await until(() => expect(item(r.threadId!)!.facts.role).toBe('worker'));
  });

  it('follows Loom back to the default role, and writes a started thread’s worker role to Loom once', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: 'w2', text: 'Watch PRs', cwd: '/work/tango', provider: 'claude', role: 'ops', parentThreadId: 'agent:compass' });
    await until(() => expect(item(r.threadId!)!.facts.role).toBe('ops'));
    await loom.host.execute({ type: 'role', commandId: 'w3', threadId: r.threadId!, role: 'interactive', parentThreadId: null });
    await until(() => expect(item(r.threadId!)!.facts).toMatchObject({ role: 'interactive', parentItemId: null }));

    // A thread from before roles: Loom says interactive, but the desk saw another conversation start it.
    const old = await loom.host.execute({ type: 'submit', commandId: 'w4', text: 'Playtest', cwd: '/work/tango', provider: 'claude' });
    h.core.store.db.exec("CREATE TABLE IF NOT EXISTS desk_mail (id TEXT PRIMARY KEY, from_item TEXT, to_item TEXT, kind TEXT, created_at INTEGER)");
    h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, kind, created_at) VALUES ('m1', 'loom:card', ?, 'start', 1)").run(`loom:${old.threadId}`);
    h.core.roles.invalidate();
    loom.store.updateThread(old.threadId!, { title: 'Playtest' });
    await vi.waitFor(() => expect(loom.store.thread(old.threadId!)).toMatchObject({ role: 'worker', parent_thread_id: 'loom:card' }));
    await until(() => expect(item(old.threadId!)!.facts).toMatchObject({ role: 'worker', parentItemId: 'loom:card' }));
  });

  it('starts a thread with its role and owner', async () => {
    const started = await source.startThread({ commandId: 's1', text: 'Playtest round 7', repoPath: '/work/tango', mode: 'local', role: 'worker', parentThreadId: 'loom:card' });
    expect(started.ok && loom.store.thread(started.threadId)).toMatchObject({ role: 'worker', parent_thread_id: 'loom:card' });
  });
});

describe('images on Loom threads', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const image = { name: 'bug.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` };

  it('a reply with a screenshot reaches the harness, and the transcript shows it from Loom', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Fix the layout' });
    await until(() => expect(item(r.threadId!)).toBeTruthy());
    runtime.last.complete('Looking.');
    expect(await source.reply(item(r.threadId!)!, 'It looks like this', { commandId: cid(), attachments: [image] })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runtime.last.turns.at(-1)).toMatchObject({ text: 'It looks like this', images: [{ mimeType: 'image/png', data: PNG.toString('base64') }] }));
    let shown: { url: string; name: string; mimeType: string }[] = [];
    await vi.waitFor(async () => {
      await source.idle();
      const message = h.core.store.messages(`loom:${r.threadId}`).find((m) => m.text === 'It looks like this');
      shown = (message?.attachments ?? []) as typeof shown;
      expect(shown).toHaveLength(1);
    });
    expect(shown[0]).toMatchObject({ name: 'bug.png', mimeType: 'image/png' });
    const id = shown[0]!.url.split('/').pop()!;
    const served = await source.image(id);
    expect(served?.mimeType).toBe('image/png');
    expect(Buffer.from(served!.bytes).equals(PNG)).toBe(true);
    expect(await source.image('not-there')).toBeNull();
  });

  it("a message that is only a picture still shows", async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: '', attachments: [image] });
    await vi.waitFor(async () => {
      await source.idle();
      expect(h.core.store.messages(`loom:${r.threadId}`).some((m) => (m.attachments ?? []).length === 1)).toBe(true);
    });
  });
});

describe('Loom tool activity', () => {
  it('reads each tool call the way the owner would say it', () => {
    expect(toolLine('Bash', JSON.stringify({ command: 'npm test -w @tango/loom\nmore' }), 'running')).toBe('Running `npm test -w @tango/loom`');
    expect(toolLine('Bash', JSON.stringify({ command: 'ls' }), 'completed')).toBe('Ran `ls`');
    expect(toolLine('Edit', JSON.stringify({ file_path: '/work/tango/src/store.ts' }), 'completed')).toBe('Edited store.ts');
    expect(toolLine('Grep', JSON.stringify({ pattern: 'TODO' }), 'running')).toBe('Searching for “TODO”');
    expect(toolLine('WebFetch', JSON.stringify({ url: 'https://example.com/a/b' }), 'completed')).toBe('Fetched example.com');
    expect(toolLine('Agent', JSON.stringify({ description: 'Review the diff' }), 'running')).toBe('Delegating: Review the diff');
    expect(toolLine('mcp__linear__save_issue', '{}', 'completed')).toBe('linear: save_issue');
    expect(toolLine('Bash', '{"command": "cut off', 'failed')).toBe('Ran (failed)');
  });

  it('shows the latest tool call under a Loom thread while it works', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the tests' });
    await until(() => expect(item(r.threadId!)).toBeTruthy());
    runtime.last.emit({ type: 'tool.updated', runId: r.runId!, itemId: 'tu1', name: 'Bash', input: JSON.stringify({ command: 'npm test' }), status: 'running' });
    await until(() => expect(item(r.threadId!)!.activity).toMatchObject({ text: 'Running `npm test`' }));
    runtime.last.emit({ type: 'tool.updated', runId: r.runId!, itemId: 'tu1', name: '', output: 'ok', status: 'completed' });
    await until(() => expect(item(r.threadId!)!.activity).toMatchObject({ text: 'Ran `npm test`' }));
    // A tool call is activity: the thread sorts and ages as busy, not as of its last state change.
    const before = item(r.threadId!)!.lastActivityAt;
    tick();
    runtime.last.emit({ type: 'tool.updated', runId: r.runId!, itemId: 'tu2', name: 'Read', input: JSON.stringify({ file_path: '/work/tango/a.ts' }), status: 'running' });
    await until(() => expect(item(r.threadId!)!.lastActivityAt).toBeGreaterThan(before));
  });

  it('a turn that ends with background work still running stays working, not back with the owner', async () => {
    const id = await newThread('Review the PR with two subagents');
    tick();
    runtime.last.emit({ type: 'background.changed', tasks: [{ id: 't1', kind: 'local_agent', description: 'review' }] });
    runtime.last.complete("Two reviewers are running. **Next — me:** merge once they're back.");
    await until(() => expect(item(id)).toMatchObject({ facts: { running: null, background: 'working', lastAuthor: 'agent' }, nextStep: 'working', nextStepBasis: 'source:background' }));
    tick();
    runtime.last.emit({ type: 'background.changed', tasks: [] });
    await until(() => expect(item(id)!.facts.background).toBeNull());
    expect(item(id)!.nextStep).not.toBe('working');
  });

  it('a turn that hands the owner the next move is theirs, even with background work still running', async () => {
    const id = await newThread('Draft the model');
    tick();
    runtime.last.emit({ type: 'background.changed', tasks: [{ id: 't1', kind: 'local_bash', description: 'wait for the deploy' }] });
    runtime.last.complete('Here is the model.\n\n**Next — you:** tell me whether it matches what you meant.');
    await until(() => expect(item(id)).toMatchObject({ facts: { background: 'working' }, nextStep: 'your_move', nextStepBasis: 'source:ask', ask: 'tell me whether it matches what you meant.' }));
  });

  it("an ask stays the owner's while another agent's mail runs a turn, until the owner answers", async () => {
    const id = await newThread('Draft the model');
    tick();
    runtime.last.complete('Here is the model.\n\n**Next — you:** pick a layout.');
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', nextStepBasis: 'source:ask', facts: { openAsk: { text: 'pick a layout.' } } }));
    tick();
    // Desk mail reaches Loom marked as mail (origin peer): it never answers the owner's ask.
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: '✉️ Mail from “tango · Other” [loom:other] · m-1\n\nNo cost on my side.', origin: { kind: 'peer', name: 'tango · Other', from: 'loom:other', mailId: 'm-1' } } as never);
    runtime.last.emit({ type: 'message.completed', runId: runtime.last.run, text: 'Noted. Fixing the spec gaps now.' });
    await until(() => expect(item(id)).toMatchObject({ facts: { running: { turnId: runtime.last.run } }, nextStep: 'your_move', ask: 'pick a layout.' }));
    tick();
    runtime.last.complete('Spec gaps fixed.');
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: 'Layout B' } as never);
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'working', facts: { openAsk: null } }));
  });

  it("a worker's reply the desk relays as a new turn reaches Loom as mail: the owner's ask stays open (TGO-1032 shadow, 10/20)", async () => {
    const id = await newThread('Run the notifications work');
    tick();
    runtime.last.complete('Workers are on it.\n\n**Next — you:** enable push on the preview.');
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', nextStepBasis: 'source:ask', facts: { openAsk: { text: 'enable push on the preview.' } } }));
    tick();
    // The desk's relay (mail.ts relay), not a steer: a plain reply command from the agent actor.
    const result = await h.core.command({ commandId: 'mail-reply-m-7-0', type: 'reply', itemId: `loom:${id}`, args: { text: '✉️ Reply from “acme · Metrics” [loom:metrics] · m-7\n\nHoldout card re-staged.' }, actor: 'agent' });
    expect(result.status).toBe('applied');
    const mail = loom.store.messages(id).filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.parse(mail.origin!)).toMatchObject({ kind: 'peer', name: 'acme · Metrics', from: 'loom:metrics', mailId: 'm-7' });
    expect(loom.store.thread(id)!.ask).not.toBeNull();
    // Its turn hands off to the workers: about what started it, so the owner's ask stands.
    await loom.host.kick(id);
    tick();
    runtime.last.complete('Relayed.\n\n**Next — waiting on the workers:** the PRs leaving Draft, then I relay here.');
    await until(() => expect(item(id)).toMatchObject({ nextStep: 'your_move', nextStepBasis: 'source:ask', facts: { openAsk: { text: 'enable push on the preview.' } } }));
  });

  it('an armed Loom wait is Waiting without a busy dot until it ends', async () => {
    const id = await newThread('Ship the fix');
    tick();
    // The agent arms the wait during its turn, as a real one does; a "me" hand-off with nothing armed would get the stall wake.
    const wait = loom.host.triggers.create(id, 'time', { afterMinutes: 30 }, 'merge #724 when green', 60);
    runtime.last.complete('#724 is open.\n\n**Next — me:** merge and deploy once CI and Codex review finish on #724.');
    await until(() => expect(item(id)!.facts.running).toBeNull());
    await until(() => expect(item(id)).toMatchObject({ facts: { background: 'monitoring' }, nextStep: 'watching', nextStepBasis: 'source:wait' }));
    expect(deskStatus(item(id)!)).toMatchObject({ move: 'watching', busy: null });
    loom.host.triggers.cancel(wait);
    await until(() => expect(item(id)!.facts.background).toBeNull());
    expect(deskStatus(item(id)!).busy).toBeNull();
  });

  it('what is in flight comes through in the agent’s words: tasks with their start, waits with their end', async () => {
    const id = await newThread('Ship the fix');
    tick();
    const started = h.clock.now;
    runtime.last.emit({ type: 'background.changed', tasks: [{ id: 't1', kind: 'local_bash', description: 'npm test -w @tango/loom' }, { id: 'm1', kind: 'monitor', description: 'CI on #741', ambient: true }] });
    runtime.last.complete('Tests and CI are running. **Next — me:** merge when green.');
    const wait = loom.host.triggers.create(id, 'pr', { repo: 'acme/app', number: 741, until: 'approved' }, '', 60);
    await until(() => expect(item(id)!.facts.inFlight).toEqual([
      { kind: 'shell', text: 'npm test -w @tango/loom', since: started },
      { kind: 'monitor', text: 'CI on #741', since: started, watcher: true },
      { kind: 'wait', waitKind: 'pr', text: 'waiting for PR acme/app#741 to be approved', since: expect.any(Number), until: expect.any(Number) },
    ]));
    loom.host.triggers.cancel(wait);
    runtime.last.emit({ type: 'background.changed', tasks: [] });
    await until(() => expect(item(id)!.facts.inFlight).toBeNull());
  });

  it("a recorded errand ask stays open across an unrelated mail turn", async () => {
    const id = await newThread('Fix the headlight');
    tick();
    runtime.last.complete('Found the part.\n\n**Next — you:** Buy the headlight.');
    await until(() => expect(item(id)!.askRecord).toMatchObject({ kind: 'decision', kindBy: 'source' }));
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: '✉️ Mail from “tango · Other” [loom:other] · m-1\n\nCI?', origin: { kind: 'peer', name: 'tango · Other', from: 'loom:other', mailId: 'm-1' } } as never);
    await until(() => expect(runtime.last.turns.length).toBe(2));
    tick();
    runtime.last.complete("**Next — waiting on CI for PR #9:** then I'll merge it.");
    await until(() => expect(h.core.store.messages(`loom:${id}`).at(-1)?.text).toContain("then I'll merge"));
    await until(() => expect(item(id)!.facts.running).toBeNull());
    expect(item(id)).toMatchObject({ facts: { openAsk: { text: 'Buy the headlight.' } }, askRecord: { kind: 'decision', kindBy: 'source' } });
  });

  it('a turn that failed on a usage limit, with Loom holding queued work on account limits, reads held, not failed', async () => {
    const id = await newThread('Long job');
    tick();
    runtime.last.emit({ type: 'turn.failed', runId: runtime.last.run, failure: { kind: 'usage_limit', message: 'limit', resetAt: h.clock.now + 3_600_000 } } as never);
    await until(() => expect(item(id)!.facts.failed).toBeTruthy());
    // Loom holds the next turn on account limits, with work queued behind it.
    loom.store.tx(() => {
      loom.store.createRun(id, 'continue', 'go on');
      loom.store.updateThread(id, { admission: 'account_limit' } as never);
    });
    await until(() => expect(item(id)!.facts).toMatchObject({ held: { reason: 'account_limit' }, failed: null }));
  });

  it("a worker's mail that Loom holds before its turn never reads as a stalled owner message (10/19: Decision Delegation read Failed)", async () => {
    const id = await newThread('Decide the packet');
    tick();
    runtime.last.complete('Done.\n\n**Next — none:** done.');
    await until(() => expect(item(id)!.facts.running).toBeNull());
    // 17 minutes later a worker's reply arrives as mail; Loom queues its run and holds it about a minute.
    h.clock.now += 17 * 60_000;
    loom.store.tx(() => {
      const run = loom.store.createRun(id, 'user', '✉️ Reply from “tango · Worker” [loom:w] · m-9\n\nDone.');
      loom.store.addMessage(id, run.id, 'user', '✉️ Reply from “tango · Worker” [loom:w] · m-9\n\nDone.', { kind: 'peer', name: 'tango · Worker', from: 'loom:w', mailId: 'm-9' });
    });
    await until(() => expect(item(id)!.facts).toMatchObject({ lastAuthor: 'owner', lastAuthorMail: true, held: { reason: 'queued' } }));
    // Past the stall window: still not Failed, since nothing of the owner's is waiting and the run is queued.
    h.clock.now += 5 * 60_000;
    h.core.tick();
    expect(deskStatus(item(id)!, h.clock.now).live).not.toBe('failed');
    expect(item(id)!.nextStep).not.toBe('failed');
    // Loom starts the held run: busy, as any turn.
    await loom.host.kick(id);
    await until(() => expect(deskStatus(item(id)!, h.clock.now)).toMatchObject({ busy: 'working' }));
  });

  it("a scheduled job Loom holds on account limits says Waiting on its schedule row, not the scheduler's timeout as Failed", async () => {
    const rowId = 'schedule:daily-brief';
    h.core.ensureItem({ id: rowId, source: 'schedule', kind: 'thread', conversationKey: rowId, agentId: 'agent-a', agentName: 'Agent A', place: 'Daily Brief', area: 'Jobs', createdAt: h.clock.now }, 'agent');
    // The scheduler's own reading: its turn timed out waiting.
    h.core.setFacts(rowId, { failed: { at: h.clock.now, reason: 'schedule', message: 'scheduled turn timed out' }, lastAuthor: 'agent' });
    tick();
    const reset = h.clock.now + 2 * 86_400_000;
    loom.store.tx(() => {
      const t = loom.store.createThread({ kind: 'tango-job', title: 'Daily Brief', cwd: '/work/tango', provider: 'claude' } as never);
      loom.store.createRun(t.id, 'user', 'run the brief');
      loom.store.updateThread(t.id, { admission: 'account_limit', admission_until: reset } as never);
    });
    await until(() => expect(h.core.item(rowId)!.facts.held).toEqual({ reason: 'account_limit', until: reset }));
    expect(deskStatus(h.core.item(rowId)!, h.clock.now)).toMatchObject({ pill: 'waiting', detail: expect.stringMatching(/^Held: the account hit its usage limit/), countsForOwner: false });
    // Kept by title for a row filed later (the schedule poll can come after Loom's snapshot; Codex review on #832).
    expect(jobHoldFor(h.core, 'Daily Brief')).toEqual({ reason: 'account_limit', until: reset });
  });

  it('a job hold waits for its schedule row, and two schedules sharing a title get none (Codex review on #832)', () => {
    recordJobHold(h.core, 'Night Sweep', { reason: 'disk_low', until: null });
    // The row arrives after Loom said so: applied then.
    h.core.ensureItem({ id: 'schedule:night-sweep', source: 'schedule', kind: 'thread', conversationKey: 'schedule:night-sweep', agentId: 'agent-a', agentName: 'Agent A', place: 'Night Sweep', area: 'Jobs', createdAt: h.clock.now }, 'agent');
    applyJobHold(h.core, 'Night Sweep');
    expect(h.core.item('schedule:night-sweep')!.facts.held).toEqual({ reason: 'disk_low', until: null });
    // A second schedule with the same title: neither row takes a hold that may be the other's.
    h.core.ensureItem({ id: 'schedule:night-sweep-2', source: 'schedule', kind: 'thread', conversationKey: 'schedule:night-sweep-2', agentId: 'agent-a', agentName: 'Agent A', place: 'Night Sweep', area: 'Jobs', createdAt: h.clock.now }, 'agent');
    recordJobHold(h.core, 'Night Sweep', { reason: 'memory', until: null });
    expect(h.core.item('schedule:night-sweep-2')!.facts.held ?? null).toBeNull();
  });

  it('only a monitor left running is watching', async () => {
    const id = await newThread('Watch CI');
    tick();
    runtime.last.emit({ type: 'background.changed', tasks: [{ id: 'm1', kind: 'monitor', description: 'CI' }] });
    runtime.last.complete('Watching CI.');
    await until(() => expect(item(id)).toMatchObject({ facts: { background: 'monitoring' }, nextStep: 'watching', nextStepBasis: 'source:background' }));
  });

  it('a turn still talking after half an hour is working, not gone', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Long job' });
    await until(() => expect(item(r.threadId!)!.nextStep).toBe('working'));
    h.clock.now += 40 * 60_000;
    runtime.last.emit({ type: 'tool.updated', runId: r.runId!, itemId: 'tu1', name: 'Bash', input: JSON.stringify({ command: 'npm test' }), status: 'running' });
    await until(() => expect(item(r.threadId!)!.facts.running?.lastAt).toBe(h.clock.now));
    h.core.tick();
    expect(item(r.threadId!)!.nextStep).toBe('working');
  });
});

describe('Loom threads get the coding-thread treatment', () => {
  it('a new Loom thread has its type guessed from the opening, like a Loom thread', async () => {
    const calls: Array<{ repo: string | null; title: string; opening: string }> = [];
    (h.core as unknown as { options: { autoTag: unknown } }).options.autoTag = async (input: { repo: string | null; title: string; opening: string }) => {
      calls.push(input);
      return { type: 'bug', confidence: 0.9 };
    };
    h.core.store.setSetting('autotag_since', String(h.clock.now - 3_600_000));
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Checkout crashes on submit', title: 'Checkout crash' });
    await until(() => expect(item(r.threadId!)).toBeTruthy());
    await h.core.maybeAutoTag(`loom:${r.threadId}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ repo: 'tango', title: 'Checkout crash', opening: 'Checkout crashes on submit' });
    expect(item(r.threadId!)!.facts).toMatchObject({ type: 'bug', autoTag: { type: 'bug', applied: true } });
    expect(item(r.threadId!)!.facts.stage).toBeUndefined();
  });
});

describe('Keep this session and Fresh start on a Loom thread', () => {
  it('keeps the session in Loom, shows it on the thread, and asks a fresh start', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Long project' });
    runtime.last.complete('Started.');
    await until(() => expect(item(r.threadId!)!.facts.keepSession).toBe(false));
    const kept = await h.core.command({ commandId: cid(), type: 'keep', itemId: `loom:${r.threadId}`, actor: 'owner', args: { keep: true } });
    expect(kept).toMatchObject({ status: 'applied', outcome: { keepSession: true } });
    expect(loom.store.thread(r.threadId!)!.fresh_opt_out).toBe(1);
    expect(item(r.threadId!)!.facts.keepSession).toBe(true);
    loom.store.updateThread(r.threadId!, { native_session_id: 'native-1' });
    const fresh = await h.core.command({ commandId: cid(), type: 'fresh', itemId: `loom:${r.threadId}`, actor: 'owner', args: {} });
    expect(fresh).toMatchObject({ status: 'applied', outcome: { fresh: true } });
    expect(JSON.parse(loom.store.thread(r.threadId!)!.fresh!)).toMatchObject({ reason: 'owner' });
    await h.core.command({ commandId: cid(), type: 'keep', itemId: `loom:${r.threadId}`, actor: 'owner', args: { keep: false } });
    expect(loom.store.thread(r.threadId!)!.fresh_opt_out ?? null).toBeNull();
  });
});

describe('The daily budget on a Loom thread', () => {
  it('shows today against the budget, holds automatic turns past it, and Raise lets them go', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Big job' });
    runtime.last.complete('Started.');
    await until(() => expect(item(r.threadId!)!.facts.budget).toMatchObject({ limit: 100_000_000 }));
    loom.host.setBudget(r.threadId!, 1_000);
    loom.host.usage.record(r.threadId!, r.runId!, { context: 1_000, cacheRead: 1_000, cacheWrite: 0, output: 1 });
    const wake = loom.store.tx(() => loom.store.createRun(r.threadId!, 'wake', 'check CI'));
    await loom.host.kick(r.threadId!);
    expect(loom.store.run(wake.id)!.status).toBe('queued');
    await until(() => expect(item(r.threadId!)!.facts.held).toMatchObject({ reason: 'budget' }));
    expect(item(r.threadId!)!.facts.budget).toMatchObject({ limit: 1_000, today: 1_000, share: 1 });
    const raised = await h.core.command({ commandId: cid(), type: 'raise', itemId: `loom:${r.threadId}`, actor: 'owner', args: {} });
    expect(raised).toMatchObject({ status: 'applied', outcome: { budget: { limit: 1_500, raised: 500 } } });
    await until(() => expect(loom.store.run(wake.id)!.status).toBe('running'));
  });
});

describe('Stop on a Loom thread', () => {
  it('stops the turn in progress from the desk; the thread stays open for the next message', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the long migration' });
    await until(() => expect(item(r.threadId!)).toMatchObject({ nextStep: 'working' }));
    const result = await h.core.command({ commandId: cid(), type: 'stop', itemId: `loom:${r.threadId}`, actor: 'owner', args: {} });
    expect(result).toMatchObject({ status: 'applied', outcome: { stopped: true } });
    expect(runtime.last.interrupted).toBe(1);
    expect(loom.store.run(r.runId!)!.status).toBe('interrupted');
    await until(() => expect(item(r.threadId!)!.facts.running ?? null).toBeNull());
    expect(await source.reply(item(r.threadId!)!, 'Do the small one instead', { commandId: cid() })).toMatchObject({ ok: true });
  });

  it('refuses when nothing is running', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Quick one' });
    await until(() => expect(item(r.threadId!)).toBeTruthy());
    runtime.last.complete('Done.');
    await until(() => expect(item(r.threadId!)!.facts.running ?? null).toBeNull());
    const result = await h.core.command({ commandId: cid(), type: 'stop', itemId: `loom:${r.threadId}`, actor: 'owner', args: {} });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('nothing is running') });
    expect(runtime.last.interrupted).toBe(0);
  });
});

describe('Stop never hits the next turn', () => {
  it('a Stop for a turn that already finished is refused, and the queued turn runs on', async () => {
    const r = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'First' });
    await until(() => expect(item(r.threadId!)).toMatchObject({ nextStep: 'working' }));
    const seen = item(r.threadId!)!;
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: r.threadId, text: 'Second' });
    runtime.last.complete('First done.');
    await vi.waitFor(() => expect(runtime.last.turns.map((t) => t.text)).toEqual(['First', 'Second']));
    // The desk still shows the first turn running when the owner taps Stop.
    expect(await source.interrupt(seen)).toEqual({ ok: false, error: 'that turn already finished, so nothing was stopped' });
    expect(runtime.last.interrupted).toBe(0);
  });
});

describe('background work, as the desk reads it', () => {
  it('work keeps a thread working; watchers alone (ambient, monitors) mean watching', () => {
    const of = (tasks: unknown[]) => backgroundOf({ background: JSON.stringify(tasks) });
    expect(of([])).toBeNull();
    expect(of([{ id: 't1', kind: 'local_bash', description: 'build' }])).toBe('working');
    expect(of([{ id: 'w1', kind: 'monitor', description: 'watch PR', ambient: true }])).toBe('monitoring');
    expect(of([{ id: 'w2', kind: 'local_bash', description: 'watch CI', ambient: true }])).toBe('monitoring');
    expect(of([{ id: 't1', kind: 'local_bash', description: 'build' }, { id: 'w1', kind: 'monitor', description: 'watch PR', ambient: true }])).toBe('working');
  });
});

describe('briefs passed up intact (TGO-1075)', () => {
  const session = (threadId: string) => runtime.sessions.find((entry) => entry.options.threadId === threadId)!;
  const BRIEF = {
    class: 'plan-approval', about: 'Test project',
    ask: 'Finish the filter upgrade: steps 4, 6 and 7? Recommend: all three.',
    door: 'two-way',
    blast: 'private',
    standing: 'Filter search is live; saved filters are half built.',
    background: 'The desk filter upgrade has seven steps; the owner approved the first three.',
    options: [
      { key: 'A', label: 'Build 4, 6 and 7', consequence: 'About two days; the whole plan ships', recommended: true },
      { key: 'B', label: 'Only saved filters', consequence: 'Half a day; 4 and 7 wait' },
      { key: 'C', label: 'Stop after search', consequence: 'Nothing more is built' },
    ],
    proposedRule: 'Next time, for steps already in an approved plan, build them without asking',
  };
  const LABEL_A = 'A · Build 4, 6 and 7 (Recommended)';
  const needsRows = () => h.core.items().filter((entry) => needsOwner(entry, h.clock.now)).map((entry) => entry.id);

  /** The Filter thread raises D-4; the Tango Desk lead (a space default) points the owner at it. */
  async function leadNaming(): Promise<{ filter: string; lead: string }> {
    const filter = await newThread('Filter System Audit and Upgrade');
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: filter, brief: BRIEF });
    session(filter).complete('Brief D-4 is up.');
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    tick();
    session(lead).complete('Filter work is waiting on you.\n\n**Next — you:** answer D-4 on your desk: build 4, 6 and 7, only 6, or stop after 5.');
    await until(() => expect(item(lead)!.facts.carried?.length).toBe(1));
    return { filter, lead };
  }

  it("an ask naming D-n is the owner's even when it answers another agent's mail: the row carries the brief (D-228)", async () => {
    const filter = await newThread('Filter System Audit and Upgrade');
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: filter, brief: BRIEF });
    session(filter).complete('Brief D-4 is up.');
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    session(lead).complete('Up.');
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: '✉️ Mail from “T3 cutover” [loom:other] · m-1\n\nState?', origin: { kind: 'peer', name: 'T3 cutover', from: 'loom:other', mailId: 'm-1' } } as never);
    session(lead).complete('Filter work is waiting.\n\n**Next — you:** answer D-4 on the desk.');
    // A pointer at a brief is the owner's call under the board, whoever started the turn.
    await until(() => expect(item(lead)!.facts.carried).toMatchObject([{ why: 'named', counts: true, from: { itemId: `loom:${filter}` } }]));
    expect(item(lead)!.facts.openAsk).not.toHaveProperty('to');
    expect(item(lead)!.facts.pending).toMatchObject({ requestId: 'decision:D-4' });
    expect(needsRows()).toEqual([`loom:${lead}`]);
  });

  it("a row whose ask is another agent's still carries a decision its newest words name (Codex review on #931)", async () => {
    const filter = await newThread('Filter System Audit and Upgrade');
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: filter, brief: BRIEF });
    session(filter).complete('Brief D-4 is up.');
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    session(lead).complete('Up.');
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: '✉️ Mail from “T3 cutover” [loom:other] · m-1\n\nState?', origin: { kind: 'peer', name: 'T3 cutover', from: 'loom:other', mailId: 'm-1' } } as never);
    await loom.host.execute({ type: 'handoff.record', commandId: cid(), threadId: lead, owner: 'agent', to: 'loom:other', text: 'send me the logs.', runId: loom.store.activeRun(lead)!.id } as never);
    session(lead).complete('D-4 is still open on the desk.\n\n**Next — you:** send me the logs.');
    await until(() => expect(item(lead)!.facts.openAsk).toMatchObject({ to: 'T3 cutover' }));
    await until(() => expect(item(lead)!.facts.carried).toMatchObject([{ from: { itemId: `loom:${filter}` } }]));
  });

  it('a lead that names D-n shows the full brief, labelled where it came from, and the decision counts once, there', async () => {
    const { filter, lead } = await leadNaming();
    const row = item(lead)!;
    expect(row.nextStep).toBe('your_move');
    expect(row.facts.pending).toMatchObject({ requestId: 'decision:D-4', question: BRIEF.ask, options: [LABEL_A, 'B · Only saved filters', 'C · Stop after search'] });
    expect(row.facts.pending!.brief).toMatchObject({ id: 'D-4', standing: BRIEF.standing, background: BRIEF.background, from: { itemId: `loom:${filter}`, title: 'Filter System Audit and Upgrade' } });
    expect(row.facts.carried).toMatchObject([{ why: 'named', counts: true, from: { itemId: `loom:${filter}` } }]);
    // One decision, one Needs you: the lead's row. The Filter thread says who carries it.
    expect(item(filter)!.facts.carriedBy).toEqual({ itemId: `loom:${lead}`, title: expect.any(String) });
    expect(item(filter)!.askRecord).toMatchObject({ state: 'duplicate', of: `loom:${lead}` });
    expect(needsRows()).toEqual([`loom:${lead}`]);
  });

  it("a chip on the lead's row answers the original decision; the lead's ask naming it clears and it hears how it went", async () => {
    const { filter, lead } = await leadNaming();
    expect(loom.store.thread(lead)!.ask).toContain('D-4');
    const leadTurns = session(lead).turns.length;
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'answer', itemId: `loom:${lead}`, args: { option: LABEL_A } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'A', decided_by: 'person' });
    // The thread that raised it wakes with the owner's choice; the lead gets a short FYI, and stops pointing at it.
    await vi.waitFor(() => expect(session(filter).turns.at(-1)?.text).toContain('I chose A: Build 4, 6 and 7.'));
    await vi.waitFor(() => expect(session(lead).turns.length).toBe(leadTurns + 1));
    expect(session(lead).turns.at(-1)!.text).toMatch(/decision D-4 .*is settled: the owner chose A · Build 4, 6 and 7.*don't ask the owner about D-4 again/s);
    expect(loom.store.thread(lead)!.ask).toBeNull();
    await until(() => expect(item(lead)!.facts.carried).toBeUndefined());
    expect(item(filter)!.facts.carriedBy).toBeUndefined();
    await until(() => expect(needsRows()).toEqual([]));
  });

  describe("a brief's page (TGO-1110)", () => {
    const COPY = {
      class: 'product-choice-in-scope', about: 'Test project', ask: 'Label the countdown in active time? Recommend: yes.', door: 'two-way', blast: 'private',
      standing: 'Countdowns run on active time.', background: 'D-1 set the window.', proposedRule: 'Next time, for countdown copy, use active time',
      options: [{ key: 'A', label: 'Active time', consequence: 'Honest', recommended: true }, { key: 'B', label: 'Clock', consequence: 'Wrong when idle' }],
    };
    const api = () => {
      const app = new Hono();
      registerDeskRoutes(app, { core: h.core, scenes: () => [], decided: new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now }) });
      return (route: string) => app.request(route);
    };

    it('serves the open brief as its card, with where it was raised and who carries it; unknown ids are refused', async () => {
      const { filter, lead } = await leadNaming();
      const get = api();
      const page = (await (await get('/api/desk/decisions/D-4')).json()) as Record<string, any>;
      expect(page).toMatchObject({ id: 'D-4', status: 'open', class: 'plan-approval', revision: 1, outcome: null, raisedOn: { itemId: `loom:${filter}`, title: 'Filter System Audit and Upgrade' }, carriedBy: [{ itemId: `loom:${lead}` }] });
      expect(page.pending).toMatchObject({ requestId: 'decision:D-4', question: BRIEF.ask, options: [LABEL_A, 'B · Only saved filters', 'C · Stop after search'], brief: { id: 'D-4', proposedRule: BRIEF.proposedRule } });
      expect(await (await get('/api/desk/decisions')).json()).toEqual({ ids: [4] });
      expect((await get('/api/desk/decisions/D-99')).status).toBe(404);
      expect((await get('/api/desk/decisions/nope')).status).toBe(400);
    });

    it('answering through the raising thread (as the page does) closes it, and the page then shows who decided, which option and when', async () => {
      const { filter } = await leadNaming();
      tick();
      expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${filter}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A }, rule: 'once', reason: 'Not a pattern' } })).toMatchObject({ status: 'applied' });
      const page = (await (await api()('/api/desk/decisions/D-4')).json()) as Record<string, any>;
      expect(page).toMatchObject({ status: 'answered', pending: null, carriedBy: [], outcome: { by: 'owner-desk', option: { key: 'A', label: 'Build 4, 6 and 7' }, reason: 'Not a pattern', in: null } });
      expect(page.brief.standing).toBe(BRIEF.standing);
    });

    it('the decision page still answers a brief while it is in discussion', async () => {
      const { filter } = await leadNaming();
      tick();
      await loom.host.execute({ type: 'submit', commandId: cid(), threadId: filter, text: 'Explain the tradeoffs' });
      await until(() => expect(item(filter)!.facts.discussing).toMatchObject([{ id: 'D-4' }]));
      const page = await (await api()('/api/desk/decisions/D-4')).json() as Record<string, any>;
      expect(page.pending.requestId).toBe('decision:D-4');
      expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${filter}`, args: { requestId: page.pending.requestId, answers: { decision: LABEL_A }, rule: 'once' } })).toMatchObject({ status: 'applied' });
      expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', discussing_since: null });
    });

    it('a thread with two open briefs shows its newest on its row; the older one still opens and answers from its page', async () => {
      const { filter } = await leadNaming();
      tick();
      await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: filter, brief: COPY });
      await until(() => expect(item(filter)!.facts.pending?.requestId).toBe('decision:D-5'));
      const get = api();
      expect(((await (await get('/api/desk/decisions/D-4')).json()) as Record<string, any>).pending).toMatchObject({ requestId: 'decision:D-4' });
      tick();
      expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${filter}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } })).toMatchObject({ status: 'applied' });
      expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'A' });
      expect(loom.store.decision('D-5')!.status).toBe('open');
    });

    it("closed in chat from the lead's own conversation: the page names where the owner said it", async () => {
      const { filter, lead } = await leadNaming();
      await loom.host.execute({ type: 'decision.close', commandId: cid(), threadId: lead, decisionId: 'D-4', outcome: 'answered-in-chat', option: 'B', note: 'Only saved filters, said to the lead' });
      const page = (await (await api()('/api/desk/decisions/D-4')).json()) as Record<string, any>;
      expect(page).toMatchObject({ status: 'answered', raisedOn: { itemId: `loom:${filter}` }, outcome: { by: 'owner-chat', option: { key: 'B' }, text: 'Only saved filters, said to the lead', in: { itemId: `loom:${lead}` } } });
      await vi.waitFor(() => expect(session(filter).turns.at(-1)?.text).toMatch(/was answered by the owner in .*B · Only saved filters — Only saved filters, said to the lead/s));
    });
  });

  it('a carrier keeps its reply visible until an owner action acknowledges it', async () => {
    const { filter, lead } = await leadNaming();
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: 'Fix the links' });
    await loom.host.execute({ type: 'decision.keep', commandId: cid(), threadId: lead, decisionId: 'D-4', why: 'Links are separate' });
    session(lead).complete('Here are the fixed links.');
    await until(() => expect(item(lead)!.facts.lastAgentWords?.text).toBe('Here are the fixed links.'));
    expect(deskStatus(item(lead)!, h.clock.now).basis).toBe('source:discussion');
    tick();
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: `loom:${lead}`, actor: 'agent' });
    expect(loom.store.decision('D-4')!.discussing_since).not.toBeNull();
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: `loom:${lead}` });
    await until(() => expect(item(filter)!.facts.openBrief?.requestId).toBe('decision:D-4'));
    expect(loom.store.decision('D-4')).toMatchObject({ discussing_since: null, unaddressed_at: null, window_from: h.clock.now });
  });

  it('a brief shown beside the row’s own question is answered as itself: the original resolves, the row’s own stays', async () => {
    const { filter, lead } = await leadNaming();
    // The lead now asks its own question too: the carried brief shows beside it, answered by its request id.
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: 'What next for the space?', origin: { kind: 'peer', from: 'loom:other' } });
    await vi.waitFor(() => expect(session(lead).turns.at(-1)!.text).toContain('What next for the space?'));
    // Peer work does not start an owner discussion: the separate live question and brief coexist.
    session(lead).emit({ type: 'request.opened', runId: session(lead).run, requestId: 'own-q', kind: 'question', payload: { questions: [{ question: 'Which space next?', header: 'Space', options: [{ label: 'Home', description: '' }, { label: 'Work', description: '' }], multiSelect: false }] } });
    await until(() => expect(item(lead)!.facts.pending?.requestId).toBe('own-q'));
    expect(item(lead)!.facts.carried).toMatchObject([{ counts: true, pending: { requestId: 'decision:D-4' } }]);
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${lead}`, args: { requestId: 'decision:D-4', answers: { decision: 'B · Only saved filters' } } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'B' });
    await vi.waitFor(() => expect(session(filter).turns.at(-1)?.text).toContain('I chose B: Only saved filters.'));
    await until(() => expect(item(lead)!.facts.carried).toBeUndefined());
    expect(item(lead)!.facts.pending?.requestId).toBe('own-q');
  });

  it('a failed lead never takes the count, even with a pending flag left behind: the raising thread keeps it', async () => {
    const { filter, lead } = await leadNaming();
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: 'Go on.' });
    await vi.waitFor(() => expect(session(lead).turns.at(-1)!.text).toContain('Go on.'));
    session(lead).emit({ type: 'turn.failed', runId: session(lead).run, failure: { kind: 'error', message: 'Overloaded' } });
    await until(() => expect(item(lead)!.nextStep).toBe('failed'));
    // A pending flag the errored turn left behind (as Loom does; deskStatus lets the failure outrank it).
    h.core.setFacts(`loom:${lead}`, { pending: { kind: 'question', requestId: 'left-q', questions: [], question: 'Which?', options: [], at: h.clock.now } });
    expect(item(lead)).toMatchObject({ nextStep: 'failed', facts: { pending: { requestId: 'left-q' } } });
    expect(item(lead)!.facts.carried).toBeUndefined();
    expect(item(filter)!.facts.carriedBy).toBeUndefined();
    expect(needsRows()).toContain(`loom:${filter}`);
  });

  it('a lead carries its own worker’s open brief without naming it', async () => {
    const lead = await newThread('Plan the desk filters');
    tick();
    session(lead).complete('Started a worker for step 6.');
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build step 6', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(item(lead)!.facts.carried).toMatchObject([{ why: 'worker', counts: true, from: { itemId: `loom:${worker}` } }]));
    expect(item(lead)!.facts.pending!.brief).toMatchObject({ id: 'D-4', from: { itemId: `loom:${worker}` } });
    expect(item(worker)!.facts.carriedBy).toMatchObject({ itemId: `loom:${lead}` });
    expect(needsRows()).toEqual([`loom:${lead}`]);
  });

  it('a worker started by a worker: its brief goes up past it to the lead that speaks to the owner', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const mid = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Plan the filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    const leaf = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build step 6', role: 'worker', parentThreadId: `loom:${mid}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: leaf, brief: BRIEF });
    session(leaf).complete('Brief D-4 is up.');
    await until(() => expect(item(lead)!.facts.carried).toMatchObject([{ why: 'worker', counts: true, from: { itemId: `loom:${leaf}` } }]));
    expect(item(mid)!.facts.carried).toBeUndefined();
    expect(item(leaf)!.facts.carriedBy).toMatchObject({ itemId: `loom:${lead}` });
    expect(needsRows()).toEqual([`loom:${lead}`]);
    // A screen showing the lead hears when the leaf's brief settles: the lead is announced, not only the leaf and mid.
    const announced: string[] = [];
    const off = h.core.subscribe((event) => { if (event.type === 'item') announced.push(event.id); });
    tick();
    await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${lead}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } });
    await until(() => expect(item(lead)!.facts.carried).toBeUndefined());
    off();
    expect(announced).toContain(`loom:${lead}`);
  });

  it('a row that names a brief is announced when the brief opens, so its open page shows the card', async () => {
    const filter = await newThread('Filter System Audit and Upgrade');
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    tick();
    session(lead).complete('**Next — you:** answer D-4 on your desk.');
    await until(() => expect(item(lead)!.nextStep).toBe('your_move'));
    const announced: string[] = [];
    const off = h.core.subscribe((event) => { if (event.type === 'item') announced.push(event.id); });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: filter, brief: BRIEF });
    await until(() => expect(item(lead)!.facts.carried).toHaveLength(1));
    off();
    expect(announced).toContain(`loom:${lead}`);
  });

  it('a lead outside Loom (a Discord chapter) carries its Loom worker’s brief, and the desk tells it how the decision went', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the filter work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ why: 'worker', counts: true }]));
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    h.core.onOwnerPostedUp((post) => mail.ownerPostUp(post));
    tick();
    // The carried card has its own rule chips: their choice and reason reach the original decision.
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: leadId, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A }, rule: 'once', reason: 'Plans differ' } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ rule_choice: 'once', answer_reason: 'Plans differ', rule_id: null });
    await vi.waitFor(async () => {
      await source.idle();
      const told = h.posted.map((body) => String((body.data as { text?: string } | undefined)?.text ?? '')).find((text) => text.includes('Decision D-4'));
      expect(told).toMatch(/which you carried for .*is settled: the owner answered it: A · Build 4, 6 and 7\./s);
    }, { timeout: 3_000, interval: 20 });
    // One note for one answer: Loom's answer turn on the worker isn't forwarded up as the owner's words too.
    await source.idle();
    await mail.tick();
    expect(h.posted.filter((body) => String((body.data as { text?: string } | undefined)?.text ?? '').includes('D-4'))).toHaveLength(1);
    expect(h.core.item(leadId)!.facts.carried).toBeUndefined();

    // Deleted with an open brief: the Discord lead still hears it was withdrawn.
    const other = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Mutes', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    const asked = await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: other, brief: { ...BRIEF, ask: 'Mute per space or per thread? Recommend: per space.', proposedRule: 'Next time, for mute scope, mute per space without asking' } });
    await until(() => expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ pending: { requestId: `decision:${asked.decisionId}` } }]));
    await loom.host.execute({ type: 'delete', commandId: cid(), threadId: other });
    await vi.waitFor(async () => {
      await source.idle();
      const told = h.posted.map((body) => String((body.data as { text?: string } | undefined)?.text ?? '')).find((text) => text.includes(`Decision ${asked.decisionId}`));
      expect(told).toMatch(/is settled: the thread that raised it was deleted, so it is withdrawn\. Don't ask/);
    }, { timeout: 3_000, interval: 20 });
  });

  it('a lead outside Loom that only starts carrying after the brief opens (parked, then picked up) still hears how it went', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the filter work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    await h.core.command({ commandId: cid(), type: 'park', itemId: leadId });
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(item(worker)!.facts.pending?.requestId).toBe('decision:D-4'));
    expect(h.core.item(leadId)!.facts.carried).toBeUndefined();
    // The worker's open page hears its brief is now carried: it is announced along with the lead.
    const announced: string[] = [];
    const off = h.core.subscribe((event) => { if (event.type === 'item') announced.push(event.id); });
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: leadId });
    off();
    expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ why: 'worker' }]);
    expect(announced).toEqual(expect.arrayContaining([leadId, `loom:${worker}`]));
    tick();
    // Answered on the worker itself: the raising thread isn't read again between the pickup and the answer.
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${worker}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } })).toMatchObject({ status: 'applied' });
    await vi.waitFor(async () => {
      await source.idle();
      const told = h.posted.map((body) => String((body.data as { text?: string } | undefined)?.text ?? '')).find((text) => text.includes('Decision D-4'));
      expect(told).toMatch(/is settled: the owner answered it: A · Build 4, 6 and 7\./);
    }, { timeout: 3_000, interval: 20 });
  });

  it('a worker whose lead is put away shows its brief itself until the lead is back', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    session(lead).complete('Started the filter worker.');
    await until(() => expect(item(lead)!.facts.running).toBeNull());
    await h.core.command({ commandId: cid(), type: 'park', itemId: `loom:${lead}` });
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(item(worker)!.facts.leadAway).toMatchObject({ itemId: `loom:${lead}` }));
    await until(() => expect(needsRows()).toEqual([`loom:${worker}`]));
    // A live question on the worker too: both stay the owner's while the lead is away.
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: worker, text: 'Check the flag names.', origin: { kind: 'peer', from: 'loom:other' } });
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('Check the flag names.'));
    // Peer work does not start an owner discussion: the separate live question and brief coexist.
    session(worker).emit({ type: 'request.opened', runId: session(worker).run, requestId: 'w-live', kind: 'question', payload: { questions: [{ question: 'Which flag prefix?', header: 'Flags', options: [{ label: 'desk.', description: '' }, { label: 'ff.', description: '' }], multiSelect: false }] } });
    await until(() => expect(item(worker)!.facts.pending?.requestId).toBe('w-live'));
    expect(item(worker)!.facts.leadAway).toBeTruthy();
    expect(item(worker)!.facts.carried).toMatchObject([{ why: 'own', pending: { requestId: 'decision:D-4' } }]);
    expect(needsRows()).toEqual([`loom:${worker}`]);
    await loom.host.execute({ type: 'answer', commandId: cid(), requestId: 'w-live', answer: { answers: { 'Which flag prefix?': 'desk.' } } });
    await until(() => expect(item(worker)!.facts.pending?.requestId).toBe('decision:D-4'));
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: `loom:${lead}` });
    expect(item(worker)!.facts.leadAway).toBeUndefined();
    expect(needsRows()).toEqual([`loom:${lead}`]);
  });

  it('a worker that reports to a job shows its brief on the lead the job reports to, or on itself when there is none', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const job = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Nightly filter audit', role: 'ops', parentThreadId: `loom:${lead}` })).threadId!;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Fix what the audit found', role: 'worker', parentThreadId: `loom:${job}` })).threadId!;
    const lone = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Old audit', role: 'ops' })).threadId!;
    const orphan = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Fix the old one', role: 'worker', parentThreadId: `loom:${lone}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: orphan, brief: { ...BRIEF, ask: 'Mute per space or per thread? Recommend: per space.', proposedRule: 'Next time, for mute scope, mute per space without asking' } });
    await until(() => expect(item(lead)!.facts.carried).toMatchObject([{ why: 'worker', counts: true, from: { itemId: `loom:${worker}` } }]));
    await until(() => expect(item(orphan)!.facts.leadAway).toBeTruthy());
    expect(needsRows().sort()).toEqual([`loom:${lead}`, `loom:${orphan}`].sort());
  });

  it('the owner’s words in a nested worker go to the lead the owner sees, past the worker between', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const mid = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Plan the filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    const leaf = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build step 6', role: 'worker', parentThreadId: `loom:${mid}` })).threadId!;
    await until(() => expect(item(leaf)!.facts.parentItemId).toBe(`loom:${mid}`));
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    h.core.onOwnerPostedUp((post) => mail.ownerPostUp(post));
    tick();
    await h.core.command({ commandId: cid(), type: 'reply', itemId: `loom:${leaf}`, args: { text: 'Keep step 6 behind a flag.' } });
    await vi.waitFor(async () => {
      await source.idle();
      const sent = h.core.store.db.prepare('SELECT to_item FROM desk_mail WHERE from_item = ?').all(`loom:${leaf}`) as Array<{ to_item: string }>;
      expect(sent.map((row) => row.to_item)).toEqual([`loom:${lead}`]);
    }, { timeout: 3_000, interval: 20 });
  });

  it('a lead that no longer carries a brief isn’t told when it settles', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the filter work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ why: 'worker' }]));
    // The worker is promoted to a thread of its own: the lead no longer has its brief.
    await h.core.command({ commandId: cid(), type: 'role', itemId: `loom:${worker}`, args: { role: 'interactive' } });
    await until(() => expect(h.core.item(leadId)!.facts.carried).toBeUndefined());
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${worker}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } })).toMatchObject({ status: 'applied' });
    await vi.waitFor(() => expect(loom.store.decision('D-4')!.status).toBe('answered'));
    await until(() => expect(h.core.item(`loom:${worker}`)!.facts.answeredBrief).toMatchObject({ id: 'D-4', choice: 'A · Build 4, 6 and 7' }));
    await source.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await source.idle();
    expect(h.posted.some((body) => String((body.data as { text?: string } | undefined)?.text ?? '').includes('Decision D-4'))).toBe(false);
  });

  it('a failed lead doesn’t carry its worker’s brief: the worker shows it until the lead is back', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    session(lead).emit({ type: 'turn.failed', runId: session(lead).run, failure: { kind: 'error', message: 'Overloaded' } });
    await until(() => expect(item(lead)!.nextStep).toBe('failed'));
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(item(worker)!.facts.leadAway).toMatchObject({ itemId: `loom:${lead}` }));
    expect(item(lead)!.facts.carried).toBeUndefined();
    await until(() => expect(needsRows()).toEqual(expect.arrayContaining([`loom:${worker}`, `loom:${lead}`])));
  });

  it('a live question on a thread with an open brief doesn’t read as the brief settling', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the filter work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ why: 'worker' }]));
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: worker, text: 'Check the flag names too.', origin: { kind: 'peer', from: 'loom:other' } });
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('Check the flag names too.'));
    // Peer work does not start an owner discussion: the separate live question and brief coexist.
    session(worker).emit({ type: 'request.opened', runId: session(worker).run, requestId: 'live-q', kind: 'question', payload: { questions: [{ question: 'Which flag prefix?', header: 'Flags', options: [{ label: 'desk.', description: '' }, { label: 'ff.', description: '' }], multiSelect: false }] } });
    await until(() => expect(item(worker)!.facts.pending?.requestId).toBe('live-q'));
    await source.idle();
    expect(h.posted.some((body) => String((body.data as { text?: string } | undefined)?.text ?? '').includes('Decision D-4'))).toBe(false);
    expect(loom.store.decision('D-4')!.status).toBe('open');
    // The open brief stays carried on the lead while the live question has the pending slot, and answers from there.
    expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ pending: { requestId: 'decision:D-4' } }]);
    expect(needsRows()).toContain(leadId);
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: leadId, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'A' });
    expect(item(worker)!.facts.pending?.requestId).toBe('live-q');
  });

  it('a thread with an open brief and a live question shows both, and the brief answers from its row', async () => {
    const id = await newThread('Filter System Audit and Upgrade');
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    session(id).emit({ type: 'request.opened', runId: session(id).run, requestId: 'own-live', kind: 'question', payload: { questions: [{ question: 'Which flag prefix?', header: 'Flags', options: [{ label: 'desk.', description: '' }, { label: 'ff.', description: '' }], multiSelect: false }] } });
    await until(() => expect(item(id)!.facts.pending?.requestId).toBe('own-live'));
    expect(item(id)!.facts.carried).toMatchObject([{ why: 'own', counts: true, pending: { requestId: 'decision:D-4' } }]);
    const { briefing } = await import('../server/desk/view.js');
    expect(briefing(h.core).text).toContain('Also decision D-4');
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${id}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered' });
    expect(item(id)!.facts.pending?.requestId).toBe('own-live');
  });

  it('a thread whose brief is carried still asks its own live question', async () => {
    const filter = await newThread('Filter System Audit and Upgrade');
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: filter, brief: BRIEF });
    session(lead).complete('**Next — you:** answer D-4 on your desk.');
    await until(() => expect(item(lead)!.facts.carried).toHaveLength(1));
    session(filter).emit({ type: 'request.opened', runId: session(filter).run, requestId: 'own-live', kind: 'question', payload: { questions: [{ question: 'Which flag prefix?', header: 'Flags', options: [{ label: 'desk.', description: '' }, { label: 'ff.', description: '' }], multiSelect: false }] } });
    await until(() => expect(item(filter)!.facts.pending?.requestId).toBe('own-live'));
    expect(item(lead)!.facts.carried).toMatchObject([{ pending: { requestId: 'decision:D-4' } }]);
    expect(needsRows().sort()).toEqual([`loom:${filter}`, `loom:${lead}`].sort());
  });

  it('a worker under a parked lead keeps its brief counted when another thread only names it', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    const other = await newThread('Release notes');
    tick();
    session(lead).complete('Started the filter worker.');
    await until(() => expect(item(lead)!.facts.running).toBeNull());
    await h.core.command({ commandId: cid(), type: 'park', itemId: `loom:${lead}` });
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    session(other).complete('The filter notes wait on D-4.');
    await until(() => expect(item(other)!.facts.carried).toMatchObject([{ why: 'named', counts: false }]));
    expect(item(worker)!.facts.leadAway).toMatchObject({ itemId: `loom:${lead}` });
    expect(needsRows()).toContain(`loom:${worker}`);
  });

  it('a stopped lead doesn’t carry its worker’s brief: the worker shows it', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'stop', commandId: cid(), threadId: lead });
    await until(() => expect(item(lead)!.facts.stoppedAtSource).toBe(true));
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(item(worker)!.facts.leadAway).toMatchObject({ itemId: `loom:${lead}` }));
    expect(item(lead)!.facts.carried).toBeUndefined();
    await until(() => expect(needsRows()).toContain(`loom:${worker}`));
  });

  it('a lead outside Loom parked for the brief’s whole life still hears how it went', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the filter work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    await h.core.command({ commandId: cid(), type: 'park', itemId: leadId });
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(item(worker)!.facts.pending?.requestId).toBe('decision:D-4'));
    expect(h.core.item(leadId)!.facts.carried).toBeUndefined();
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${worker}`, args: { requestId: 'decision:D-4', answers: { decision: 'B · Only saved filters' } } })).toMatchObject({ status: 'applied' });
    await vi.waitFor(async () => {
      await source.idle();
      const told = h.posted.map((body) => String((body.data as { text?: string } | undefined)?.text ?? '')).find((text) => text.includes('Decision D-4'));
      expect(told).toMatch(/is settled: the owner answered it: B · Only saved filters\./);
    }, { timeout: 3_000, interval: 20 });
  });

  it('a lead outside Loom still hears how its brief went after a desk restart between carrying and settling', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the filter work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ why: 'worker' }]));
    // The desk restarts: what it held in memory is gone; its store isn't.
    (h.core as unknown as { carriersLastSeen: Map<string, unknown> }).carriersLastSeen.clear();
    h.core.setFacts(`loom:${worker}`, { pending: null });
    tick();
    await loom.host.execute({ type: 'decision.answer', commandId: cid(), decisionId: 'D-4', option: 'A' });
    await vi.waitFor(async () => {
      await source.idle();
      const told = h.posted.map((body) => String((body.data as { text?: string } | undefined)?.text ?? '')).find((text) => text.includes('Decision D-4'));
      expect(told).toMatch(/is settled: the owner answered it: A · Build 4, 6 and 7\./);
    }, { timeout: 3_000, interval: 20 });
  });

  it('a settled brief reads as what it came to: the option with its label, and the owner’s own words', () => {
    const brief = { options: [{ key: 'A', label: 'Build 4, 6 and 7', consequence: '' }, { key: 'B', label: 'Only saved filters', consequence: '' }] } as never;
    expect(settledChoice({ answer_option: 'B', answer_text: null, brief })).toBe('B · Only saved filters');
    expect(settledChoice({ answer_option: null, answer_text: 'Do 6, then ask me about 7', brief })).toBe('“Do 6, then ask me about 7”');
    expect(settledChoice({ answer_option: 'A', answer_text: 'but not tonight', brief })).toBe('A · Build 4, 6 and 7 (“but not tonight”)');
    expect(settledChoice({ answer_option: null, answer_text: null, brief })).toBe('');
  });

  it('the briefing names every brief a lead counts, not only its own question', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const one = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    const two = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Mutes', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: one, brief: BRIEF });
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: two, brief: { ...BRIEF, ask: 'Mute per space or per thread? Recommend: per space.', proposedRule: 'Next time, for mute scope, mute per space without asking' } });
    await until(() => expect(item(lead)!.facts.carried).toHaveLength(2));
    const { briefing } = await import('../server/desk/view.js');
    const said = briefing(h.core);
    expect(said.yourMove).toHaveLength(1);
    expect(said.text).toContain('Finish the filter upgrade');
    expect(said.text).toMatch(/\n  Also decision D-[45] from (Filters|Mutes): /);
    expect(said.text).toContain('Mute per space or per thread?');
  });

  it('a worker whose own lead is gone carries its child’s brief and hears how it went', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const mid = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Plan the filters', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    const leaf = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build step 6', role: 'worker', parentThreadId: `loom:${mid}` })).threadId!;
    tick();
    session(lead).complete('Started the planner.');
    session(mid).complete('Started the builder.');
    await until(() => expect(item(mid)!.facts.running).toBeNull());
    // The lead is finished: the planner now speaks to the owner itself.
    // A standing lead must become an ordinary thread before Done can end it.
    await loom.host.execute({ type: 'role', commandId: cid(), threadId: lead, role: 'interactive' });
    await until(() => expect(item(lead)!.facts.role).toBe('interactive'));
    await h.core.command({ commandId: cid(), type: 'done', itemId: `loom:${lead}` });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: leaf, brief: BRIEF });
    session(leaf).complete('Brief D-4 is up.');
    await until(() => expect(item(mid)!.facts.carried).toMatchObject([{ why: 'worker', counts: true, from: { itemId: `loom:${leaf}` } }]));
    const midTurns = session(mid).turns.length;
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${mid}`, args: { requestId: 'decision:D-4', answers: { decision: LABEL_A } } })).toMatchObject({ status: 'applied' });
    await vi.waitFor(async () => {
      await source.idle();
      expect(session(mid).turns.length).toBe(midTurns + 1);
    }, { timeout: 3_000, interval: 20 });
    expect(session(mid).turns.at(-1)!.text).toMatch(/Decision D-4 .*which you carried for .*is settled: the owner answered it: A · Build 4, 6 and 7\./s);
  });

  it('every owner message in a worker goes up, even when one poll brings several with a newer agent reply', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    await until(() => expect(item(lead)).toBeTruthy());
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    h.core.onOwnerPostedUp((post) => mail.ownerPostUp(post));
    const at = h.clock.now;
    const message = (id: string, role: 'user' | 'assistant', text: string, offset: number) => ({ id, role, text, created_at: at + offset });
    // One read of the worker: its task, two owner messages, then the agent's reply, filed together. The task isn't sent up.
    (source as unknown as { ingest(detail: unknown): void }).ingest({
      thread: { id: 'poll-worker', title: 'Filter System Audit and Upgrade', cwd: '/work/tango', status: 'idle', role: 'worker', parent_thread_id: `loom:${lead}`, created_at: at, updated_at: at + 3, settled_at: null, ask: null },
      runs: [], items: [], requests: [],
      messages: [message('m0', 'user', 'Audit the desk filters.', 0), message('m1', 'user', 'Build step 6 first.', 1), message('m2', 'user', 'And keep D-4 open until it ships.', 2), message('m3', 'assistant', 'On it.', 3)],
    });
    await vi.waitFor(() => {
      const sent = h.core.store.db.prepare('SELECT text FROM desk_mail WHERE from_item = ? ORDER BY created_at, rowid').all('loom:poll-worker') as Array<{ text: string }>;
      expect(sent.map((row) => row.text)).toEqual([expect.stringContaining('Build step 6 first.'), expect.stringContaining('They concern decision D-4.')]);
    });
    // An old conversation filed for the first time is history: nothing goes up.
    (source as unknown as { ingest(detail: unknown): void }).ingest({
      thread: { id: 'old-worker', title: 'Old work', cwd: '/work/tango', status: 'idle', role: 'worker', parent_thread_id: `loom:${lead}`, created_at: at - 86_400_000, updated_at: at - 86_400_000, settled_at: null, ask: null },
      runs: [], items: [], requests: [],
      messages: [message('o1', 'user', 'Yesterday’s words.', -86_400_000)],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.core.store.db.prepare('SELECT COUNT(*) AS n FROM desk_mail WHERE from_item = ?').get('loom:old-worker')).toEqual({ n: 0 });
  });

  it('a worker answered directly: its lead hears it and its ask on that D-id clears; the owner’s other words there reach it as mail', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    tick();
    session(lead).complete('Started the filter worker.');
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Filter System Audit and Upgrade', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: 'Where are the filters?' });
    await vi.waitFor(() => expect(session(lead).turns.at(-1)!.text).toContain('Where are the filters?'));
    session(lead).complete('The remaining filters are waiting on decision D-4.\n\n**Next — you:** answer D-4 on your desk: build 4, 6 and 7, only 6, or stop after 5.');
    await until(() => expect(loom.store.thread(lead)!.ask).toContain('D-4'));
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now, steer: (to, text, origin, commandId) => source.steer(to, text, origin, commandId) });
    h.core.onOwnerPostedUp((post) => mail.ownerPostUp(post));
    const leadTurns = session(lead).turns.length;
    tick();
    // The owner opens the worker itself and answers its brief there.
    await until(() => expect(item(worker)!.facts.pending?.requestId).toBe('decision:D-4'));
    expect(await h.core.command({ commandId: cid(), type: 'answer', itemId: `loom:${worker}`, args: { option: LABEL_A } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'A' });
    expect(loom.store.thread(lead)!.ask).toBeNull();
    // The lead hears it once: from Loom, which doesn't depend on mail; the desk doesn't mail Loom's answer turn too.
    await vi.waitFor(async () => {
      await source.idle();
      await mail.tick();
      expect(session(lead).turns.length).toBe(leadTurns + 1);
    }, { timeout: 3_000, interval: 20 });
    expect(session(lead).turns.at(-1)!.text).toMatch(/decision D-4 .*is settled: the owner chose A · Build 4, 6 and 7/s);
    await mail.tick();
    expect(session(lead).turns.length).toBe(leadTurns + 1);
    // The owner's own words in the worker reach the lead at once, as mail from the worker.
    session(lead).complete('Noted.');
    await until(() => expect(item(lead)!.facts.running).toBeNull());
    tick();
    await h.core.command({ commandId: cid(), type: 'reply', itemId: `loom:${worker}`, args: { text: 'Also keep step 5 behind its flag until D-4 ships.' } });
    await vi.waitFor(async () => {
      await source.idle();
      await mail.tick();
      expect(session(lead).turns.length).toBe(leadTurns + 2);
    }, { timeout: 3_000, interval: 20 });
    const heard = session(lead).turns.at(-1)!.text;
    expect(heard).toContain(`[loom:${worker}]`);
    expect(heard).toContain('Also keep step 5 behind its flag until D-4 ships.');
    expect(heard).toContain('They concern decision D-4.');
    // Typed by the owner, words shaped like Loom's answer turn still go up: only the desk's own answer is skipped.
    session(lead).complete('Noted.');
    await until(() => expect(item(lead)!.facts.running).toBeNull());
    tick();
    await h.core.command({ commandId: cid(), type: 'reply', itemId: `loom:${worker}`, args: { text: 'Decision D-4: actually make it B.' } });
    await vi.waitFor(async () => {
      await source.idle();
      await mail.tick();
      expect(session(lead).turns.at(-1)!.text).toContain('Decision D-4: actually make it B.');
    }, { timeout: 3_000, interval: 20 });
    // With mail switched off for the lead, the owner's words still reach it, straight in.
    session(lead).complete('Noted.');
    await until(() => expect(item(lead)!.facts.running).toBeNull());
    mail.setOff(`loom:${lead}`, true);
    tick();
    await h.core.command({ commandId: cid(), type: 'reply', itemId: `loom:${worker}`, args: { text: 'Ship it tonight.' } });
    await vi.waitFor(async () => {
      await source.idle();
      expect(session(lead).turns.at(-1)!.text).toContain('Ship it tonight.');
    }, { timeout: 3_000, interval: 20 });
    await until(() => expect(needsRows()).toEqual([]));
  });
});

describe('briefs revised in place (TGO-1079)', () => {
  const session = (threadId: string) => runtime.sessions.find((entry) => entry.options.threadId === threadId)!;
  const BRIEF = {
    class: 'product-choice-in-scope', about: 'Test project',
    ask: 'Show the veto countdown in active time? Recommend: yes.',
    door: 'two-way',
    blast: 'private',
    standing: 'The countdown pauses while the owner is idle.',
    background: 'D-1 set the veto window to 4 hours of active time.',
    options: [
      { key: 'A', label: 'Active time left', consequence: 'Honest about what the timer counts', recommended: true },
      { key: 'B', label: 'A clock time', consequence: 'Wrong whenever the owner goes idle' },
    ],
    proposedRule: 'Next time, for desk timer copy, use active time without asking',
  };
  const SWITCHED = [
    { key: 'A', label: 'Active time left', consequence: 'Honest about what the timer counts' },
    { key: 'B', label: 'A clock time', consequence: 'Right, now that the desk pings every minute', recommended: true },
  ];
  const posted = () => h.posted.map((body) => String((body.data as { text?: string } | undefined)?.text ?? ''));

  /** A lead; its worker raises D-4, which the lead carries; the worker starts a sub-worker of its own. */
  async function chain(): Promise<{ lead: string; worker: string; sub: string }> {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    tick();
    session(lead).complete('Started a worker for the countdown.');
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build the countdown', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up; a sub-worker is checking the desk pings.');
    const sub = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Check the desk pings', role: 'worker', parentThreadId: `loom:${worker}` })).threadId!;
    tick();
    session(sub).complete('Checking.');
    await until(() => expect(item(lead)!.facts.carried).toMatchObject([{ why: 'worker', counts: true, from: { itemId: `loom:${worker}` } }]));
    expect(item(lead)!.facts.pending!.brief).toMatchObject({ id: 'D-4', revision: 1, updated: null });
    return { lead, worker, sub };
  }

  it("a worker below updates the brief its lead carries: same id, the lead's card shows the new revision and what changed", async () => {
    const { lead, worker, sub } = await chain();
    const workerTurns = session(worker).turns.length;
    tick();
    const updated = await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: sub, decisionId: 'D-4', changes: { options: SWITCHED }, why: 'The desk pings every minute' });
    expect(updated).toMatchObject({ decisionId: 'D-4', revision: 2, material: true });
    await until(() => expect(item(lead)!.facts.pending!.brief).toMatchObject({ id: 'D-4', revision: 2, defaultOption: 'B', updated: { at: h.clock.now, what: 'recommendation A → B · options · default A → B', why: 'The desk pings every minute' } }));
    expect(item(lead)!.facts.pending).toMatchObject({ requestId: 'decision:D-4', options: ['A · Active time left', 'B · A clock time (Recommended)'] });
    // The worker that raised it hears its brief changed, once; the lead hears it from Loom too.
    await vi.waitFor(() => expect(session(worker).turns.length).toBe(workerTurns + 1));
    expect(session(worker).turns.at(-1)!.text).toMatch(/your decision D-4 was updated by .*\(revision 2\): recommendation A → B/);
    await vi.waitFor(() => expect(session(lead).turns.at(-1)!.text).toMatch(/decision D-4, raised on .*was updated by .*Point the owner at D-4 as before/s));
    // Still one decision on the desk, the same one.
    expect(h.core.items().filter((entry) => needsOwner(entry, h.clock.now)).map((entry) => entry.id)).toEqual([`loom:${lead}`]);
  });

  it('an answer to the revision the owner saw before it changed is refused, and nothing reaches the thread', async () => {
    const { lead, worker, sub } = await chain();
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: sub, decisionId: 'D-4', changes: { options: SWITCHED }, why: 'The desk pings every minute' });
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('was updated by'));
    session(worker).complete('Noted.');
    const workerRuns = loom.store.runs(worker).length;
    // The desk already shows revision 2: the old card's answer is refused at the desk.
    await until(() => expect(item(lead)!.facts.pending!.brief!.revision).toBe(2));
    const stale = await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${lead}`, args: { requestId: 'decision:D-4', answers: { decision: 'A · Active time left' }, revision: 1 } });
    expect(stale).toMatchObject({ status: 'failed', outcome: { changed: true } });
    expect(stale.error).toMatch(/the question changed: it was updated since you looked \(recommendation A → B/);
    // The desk hasn't read the change yet: Loom refuses it, and the desk says the same.
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: sub, decisionId: 'D-4', changes: { options: BRIEF.options }, why: 'The pings stop when the tab is hidden' });
    const raced = await (source as unknown as { resolveBrief(threadId: string, resolution: unknown, context: unknown): Promise<{ ok: boolean; changed?: boolean; error?: string }> })
      .resolveBrief(worker, { kind: 'respond', requestId: 'decision:D-4', answers: { decision: 'B · A clock time (Recommended)' }, revision: 2 }, { commandId: cid() });
    expect(raced).toMatchObject({ ok: false, changed: true, error: expect.stringMatching(/updated since you looked/) });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'open', revision: 3 });
    // Only revision 3's FYI reached the thread; no answer did.
    expect(loom.store.runs(worker).length).toBe(workerRuns + 1);
    expect(loom.store.messages(worker).at(-1)!.text).toContain('(revision 3)');
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('(revision 3)'));
    session(worker).complete('Noted again.');
    // The revision on the card now goes through.
    await until(() => expect(item(lead)!.facts.pending!.brief!.revision).toBe(3));
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${lead}`, args: { requestId: 'decision:D-4', answers: { decision: 'A · Active time left (Recommended)' }, revision: 3 } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'A' });
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('I chose A: Active time left.'));
  });

  it('a revised candidate brief keeps its proposed rule and rule chips; answering the new revision with a chip makes the rule', async () => {
    const { lead, worker, sub } = await chain();
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: sub, decisionId: 'D-4', changes: { options: SWITCHED, proposedRule: 'Next time, for desk timer copy, use clock time without asking' }, why: 'The desk pings every minute' });
    await until(() => expect(item(lead)!.facts.pending!.brief).toMatchObject({ id: 'D-4', revision: 2, candidate: true, proposedRule: 'Next time, for desk timer copy, use clock time without asking' }));
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: `loom:${lead}`, args: { requestId: 'decision:D-4', answers: { decision: 'B · A clock time (Recommended)' }, rule: 'always', reason: 'Pings are reliable now', revision: 2 } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'answered', answer_option: 'B', rule_choice: 'always', answer_reason: 'Pings are reliable now', rule_id: 'R-1' });
    expect(loom.host.rules.rule('R-1')).toMatchObject({ scope: 'desk timer copy', action: 'use clock time', state: 'active' });
    // The worker's revision FYI turn finishes first; the answer is the next turn.
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('(revision 2)'));
    session(worker).complete('Noted.');
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toContain('I chose B: A clock time.'));
  });

  it('a material change restarts the level 3 window the card counts down; a copy edit does not', async () => {
    const { lead, sub } = await chain();
    for (let m = 0; m < 3 * 60; m++) { h.clock.now += 60_000; loom.host.beat(); }   // three active hours
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: sub, decisionId: 'D-4', changes: { standing: 'Still pausing while idle.' }, why: 'Copy' });
    await until(() => expect(item(lead)!.facts.pending!.brief).toMatchObject({ revision: 2, vetoLeftMs: 60 * 60_000 - 1_000, updated: { what: 'where it stands' } }));
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: sub, decisionId: 'D-4', changes: { options: SWITCHED }, why: 'The desk pings every minute' });
    await until(() => expect(item(lead)!.facts.pending!.brief).toMatchObject({ revision: 3, defaultOption: 'B', vetoLeftMs: 4 * 60 * 60_000 }));
  });

  it('marked moot from a worker below: the brief leaves every row, and the thread that raised it and its lead hear why', async () => {
    const { lead, worker, sub } = await chain();
    tick();
    const closed = await loom.host.execute({ type: 'decision.close', commandId: cid(), threadId: sub, decisionId: 'D-4', outcome: 'moot', note: 'The desk already shows active time; it shipped in #770' });
    expect(new Set(closed.told)).toEqual(new Set([lead, worker]));
    expect(loom.store.decision('D-4')).toMatchObject({ status: 'moot', answer_text: 'The desk already shows active time; it shipped in #770' });
    await until(() => expect(item(lead)!.facts.carried).toBeUndefined());
    expect(item(worker)!.facts.pending).toBeNull();
    await vi.waitFor(() => expect(session(worker).turns.at(-1)!.text).toMatch(/your decision D-4 .*was marked moot by .*: The desk already shows active time; it shipped in #770\. Nothing goes ahead from it/s));
    await vi.waitFor(() => expect(session(lead).turns.at(-1)!.text).toMatch(/decision D-4 .*is settled: .* marked it moot: The desk already shows active time.*Nothing goes ahead from it/s));
  });

  it('a worker whose lead is gone, carrying its child’s brief, hears a material revision once: from Loom when it names it, else from the desk', async () => {
    const lead = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Run the Tango Desk space', role: 'default' })).threadId!;
    const mid = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Plan the countdown', role: 'worker', parentThreadId: `loom:${lead}` })).threadId!;
    const leaf = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build the countdown', role: 'worker', parentThreadId: `loom:${mid}` })).threadId!;
    tick();
    session(lead).complete('Started the planner.');
    session(mid).complete('Started the builder.');
    await until(() => expect(item(mid)!.facts.running).toBeNull());
    // A standing lead must become an ordinary thread before Done can end it.
    await loom.host.execute({ type: 'role', commandId: cid(), threadId: lead, role: 'interactive' });
    await until(() => expect(item(lead)!.facts.role).toBe('interactive'));
    await h.core.command({ commandId: cid(), type: 'done', itemId: `loom:${lead}` });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: leaf, brief: BRIEF });
    session(leaf).complete('Brief D-4 is up.');
    await until(() => expect(item(mid)!.facts.carried).toMatchObject([{ why: 'worker', counts: true, from: { itemId: `loom:${leaf}` } }]));
    const revisionTurns = () => session(mid).turns.filter((turn) => /revision \d/.test(turn.text));
    // It doesn't name D-4: only the desk knows it carries it, and tells it.
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: leaf, decisionId: 'D-4', changes: { options: SWITCHED }, why: 'The desk pings every minute' });
    await vi.waitFor(async () => { await source.idle(); expect(revisionTurns()).toHaveLength(1); }, { timeout: 3_000, interval: 20 });
    expect(revisionTurns()[0]!.text).toMatch(/which you carry for .*was updated \(revision 2\)/s);
    session(mid).complete('Still waiting on D-4 for the builder.');
    await until(() => expect(item(mid)!.facts.running).toBeNull());
    // Now its newest words name D-4: Loom tells it, and the desk doesn't a second time (Codex review on #811).
    tick();
    const updated = await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: leaf, decisionId: 'D-4', changes: { options: BRIEF.options }, why: 'The pings stop when the tab is hidden' });
    expect(updated.told).toContain(mid);
    await vi.waitFor(() => expect(revisionTurns()).toHaveLength(2));
    await until(() => expect(item(mid)!.facts.carried![0]!.pending.brief!.revision).toBe(3));
    await source.idle();
    // A steer lands in the running turn, so count what reached the thread, not turns.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await source.idle();
    expect(loom.store.messages(mid).filter((m) => m.role === 'user' && m.text.includes('(revision 3)'))).toHaveLength(1);
    expect(revisionTurns()[1]!.text).toMatch(/^Loom: decision D-4, raised on .*\(revision 3\)/s);
    // The carrier makes a change itself: nobody tells it about its own update (Codex review on #811).
    session(mid).complete('Noted.');
    await until(() => expect(item(mid)!.facts.running).toBeNull());
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: mid, decisionId: 'D-4', changes: { default: 'B' }, why: 'B is safer unattended.' });
    await until(() => expect(item(mid)!.facts.carried![0]!.pending.brief!.revision).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await source.idle();
    expect(loom.store.messages(mid).filter((m) => m.role === 'user' && m.text.includes('(revision 4)'))).toHaveLength(0);
  });

  it('a lead outside Loom (a Discord chapter) carrying the brief hears each material revision once, and no copy edit', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'Starting the countdown work.')]);
    await h.source.poll();
    const leadId = h.core.items().find((entry) => entry.source === 'discord')!.id;
    const worker = (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build the countdown', role: 'worker', parentThreadId: leadId })).threadId!;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: worker, brief: BRIEF });
    session(worker).complete('Brief D-4 is up.');
    await until(() => expect(h.core.item(leadId)!.facts.carried).toMatchObject([{ why: 'worker', counts: true }]));
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: worker, decisionId: 'D-4', changes: { standing: 'Still pausing while idle.' }, why: 'Copy' });
    await until(() => expect(h.core.item(leadId)!.facts.carried![0]!.pending.brief!.revision).toBe(2));
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: worker, decisionId: 'D-4', changes: { options: SWITCHED }, why: 'The desk pings every minute.' });
    await vi.waitFor(async () => {
      await source.idle();
      expect(posted().find((text) => text.includes('Decision D-4'))).toMatch(/which you carry for .*was updated \(revision 3\): recommendation A → B · options · default A → B\. Why: The desk pings every minute\. It is still open as D-4/s);
    }, { timeout: 3_000, interval: 20 });
    await source.idle();
    await source.idle();
    expect(posted().filter((text) => text.includes('Decision D-4'))).toHaveLength(1);
    // Two material revisions between the desk's reads: the lead hears each (Codex review on #811).
    source.stop();
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: worker, decisionId: 'D-4', changes: { options: BRIEF.options }, why: 'The pings stop when the tab is hidden.' });
    tick();
    await loom.host.execute({ type: 'decision.update', commandId: cid(), threadId: worker, decisionId: 'D-4', changes: { default: 'B' }, why: 'B is safer unattended.' });
    source.start();
    await vi.waitFor(async () => {
      await source.idle();
      const told = posted().filter((text) => text.includes('Decision D-4'));
      expect(told).toHaveLength(3);
      expect(told[1]).toMatch(/\(revision 4\): recommendation B → A/);
      expect(told[2]).toMatch(/\(revision 5\): default A → B/);
    }, { timeout: 3_000, interval: 20 });
  });
});

describe("a Discord row shows its agent's Loom records", () => {
  const BRIEF = {
    class: 'spend', about: 'Test project', ask: 'Buy the 10G card? Recommend: A.', door: 'two-way', blast: 'private', standing: 'The NAS link is slow.', background: 'One card and a switch.',
    options: [{ key: 'A', label: 'Buy', consequence: 'Fast', recommended: true }, { key: 'B', label: 'Wait', consequence: 'Slow' }],
  };
  const links = new Map<string, { agentId: string; conversation: string }>();
  beforeEach(() => {
    links.clear();
    (source as unknown as { options: { discordLinks: unknown } }).options.discordLinks = { linkOf: (id: string) => links.get(id) ?? null };
  });
  const discordRow = (id: string, conversationKey: string, kind: 'thread' | 'chapter', createdAt: number) =>
    h.core.ensureItem({ id, source: 'discord', kind, conversationKey, agentId: AGENT.id, agentName: AGENT.name, createdAt, place: kind === 'thread' ? 'NAS upgrade' : null }, 'agent');
  const agentThread = async () => (await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Find a 10G card', kind: 'tango-agent' })).threadId!;
  const status = (id: string, patch: Record<string, unknown> = {}) => deskStatus({ ...h.core.item(id)!, seen: 'seen', ...patch } as never, h.clock.now);

  it("an open brief reads Needs you on the Discord thread's row, done or not, and its answer goes to Loom", async () => {
    discordRow('discord:thread:111', 'thread:111', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:111' });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    await until(() => expect(h.core.item('discord:thread:111')!.facts).toMatchObject({ loomThreadId: id, openBriefCount: 1, pending: { requestId: expect.stringMatching(/^decision:D-/) } }));
    // Not a row of its own: the ask counts once, on the row the owner reads.
    expect(item(id)).toBeFalsy();
    expect(status('discord:thread:111')).toMatchObject({ pill: 'needs', layer: 'needs', countsForOwner: true, detail: 'Buy the 10G card? Recommend: A.' });
    // Done never hides an open brief (spec): it stays in Needs you until the record closes.
    expect(status('discord:thread:111', { disposition: 'done' })).toMatchObject({ pill: 'needs', layer: 'needs', countsForOwner: true, detail: expect.stringMatching(/^marked done, still open/) });
    const requestId = h.core.item('discord:thread:111')!.facts.pending!.requestId;
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: 'discord:thread:111', args: { requestId, answers: { decision: 'A · Buy (Recommended)' } } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decisions(id).find((d) => `decision:${d.id}` === requestId)?.status).toBe('answered');
    await until(() => expect(h.core.item('discord:thread:111')!.facts).toMatchObject({ pending: null, openBrief: null, openBriefCount: 0, answeredBrief: { choice: 'A · Buy' } }));
    expect(status('discord:thread:111').pill).not.toBe('needs');
  });

  it.each(['viewed', 'seen', 'park'] as const)('a linked Discord %s acknowledges its completed Loom discussion', async (type) => {
    const rowId = 'discord:thread:115';
    discordRow(rowId, 'thread:115', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:115' });
    const result = await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    runtime.last.complete('Brief is up.');
    await until(() => expect(h.core.item(rowId)!.facts.loomThreadId).toBe(id));
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: 'Explain the links' });
    await loom.host.execute({ type: 'decision.keep', commandId: cid(), threadId: id, decisionId: result.decisionId!, why: 'Different topic' });
    await until(() => expect(h.core.item(rowId)!.facts.discussing?.length).toBe(1));
    runtime.last.emit({ type: 'message.completed', runId: runtime.last.run, text: 'Here are the links.' });
    await h.core.command({ commandId: cid(), type: 'viewed', itemId: rowId, args: { ms: 3000 } });
    expect(h.core.item(rowId)!.seen).toBe('seen');
    tick(); runtime.last.emit({ type: 'turn.completed', runId: runtime.last.run });
    await until(() => expect(h.core.item(rowId)!.seen).not.toBe('seen'));
    tick();
    expect(await h.core.command({ commandId: cid(), type, itemId: rowId, args: { ms: 3000 } })).toMatchObject({ status: 'applied' });
    await until(() => expect(loom.store.decision(result.decisionId!)!.discussing_since).toBeNull());
    expect(loom.store.decision(result.decisionId!)!.window_from).toBe(h.clock.now);
  });

  it("a Next — you ask from the agent's Loom thread reads Needs you on its Discord row", async () => {
    discordRow('discord:thread:112', 'thread:112', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:112' });
    tick();
    runtime.last.complete('Two cards fit.\n\n**Next — you:** watch the two videos, then pick one.');
    await until(() => expect(h.core.item('discord:thread:112')!.facts.openAsk).toMatchObject({ text: 'watch the two videos, then pick one.' }));
    expect(status('discord:thread:112')).toMatchObject({ pill: 'needs', countsForOwner: true, detail: 'watch the two videos, then pick one.' });
  });

  it("a brief's page points at the Discord row, so its answer lands there", async () => {
    discordRow('discord:thread:113', 'thread:113', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:113' });
    tick();
    const { decisionId } = await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF }) as { decisionId: string };
    await until(() => expect(h.core.item('discord:thread:113')!.facts.loomThreadId).toBe(id));
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided: new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now }) });
    const page = (await (await app.request(`/api/desk/decisions/${decisionId}`)).json()) as Record<string, any>;
    expect(page.raisedOn).toMatchObject({ itemId: 'discord:thread:113' });
  });

  it("an older brief the Discord row doesn't show still answers from its page, through Loom", async () => {
    discordRow('discord:thread:115', 'thread:115', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:115' });
    tick();
    const older = (await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF }) as { decisionId: string }).decisionId;
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: { ...BRIEF, class: 'plan-approval', about: 'Test project', door: 'one-way', ask: 'Approve the install plan? Recommend: A.' } });
    await until(() => expect(h.core.item('discord:thread:115')!.facts).toMatchObject({ openBriefCount: 2, pending: { requestId: expect.not.stringMatching(`decision:${older}$`) } }));
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: 'discord:thread:115', args: { requestId: `decision:${older}`, answers: { decision: 'A · Buy (Recommended)' } } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision(older)).toMatchObject({ status: 'answered', answer_option: 'A' });
  });

  it("an older thread's open brief still answers from its page after the conversation moves to a newer thread", async () => {
    discordRow('discord:thread:117', 'thread:117', 'thread', h.clock.now);
    const older = await agentThread();
    links.set(older, { agentId: AGENT.id, conversation: 'thread:117' });
    tick();
    const decisionId = (await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: older, brief: BRIEF }) as { decisionId: string }).decisionId;
    await until(() => expect(h.core.item('discord:thread:117')!.facts.loomThreadId).toBe(older));
    links.delete(older);
    const newer = await agentThread();
    links.set(newer, { agentId: AGENT.id, conversation: 'thread:117' });
    tick();
    runtime.last.complete('**Next — you:** pick a switch.');
    await until(() => expect(h.core.item('discord:thread:117')!.facts.loomThreadId).toBe(newer));
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided: new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now }) });
    expect(((await (await app.request(`/api/desk/decisions/${decisionId}`)).json()) as Record<string, any>).raisedOn).toMatchObject({ itemId: 'discord:thread:117' });
    tick();
    expect(await h.core.command({ commandId: cid(), type: 'respond', itemId: 'discord:thread:117', args: { requestId: `decision:${decisionId}`, answers: { decision: 'A · Buy (Recommended)' } } })).toMatchObject({ status: 'applied' });
    expect(loom.store.decision(decisionId)).toMatchObject({ status: 'answered', answer_option: 'A' });
  });

  it("an older thread's open brief comes back on the row once the newer thread holds nothing there", async () => {
    discordRow('discord:thread:119', 'thread:119', 'thread', h.clock.now);
    const older = await agentThread();
    links.set(older, { agentId: AGENT.id, conversation: 'thread:119' });
    tick();
    const decisionId = (await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: older, brief: BRIEF }) as { decisionId: string }).decisionId;
    await until(() => expect(h.core.item('discord:thread:119')!.facts.loomThreadId).toBe(older));
    links.delete(older);
    const newer = await agentThread();
    links.set(newer, { agentId: AGENT.id, conversation: 'thread:119' });
    tick();
    runtime.last.complete('**Next — you:** pick a switch.');
    await until(() => expect(h.core.item('discord:thread:119')!.facts).toMatchObject({ loomThreadId: newer, openAsk: { text: 'pick a switch.' } }));
    tick();
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: newer, text: 'the 8-port one' });
    runtime.last.complete('Ordered.\n\n**Next — none:** done.');
    await until(() => expect(h.core.item('discord:thread:119')!.facts).toMatchObject({ loomThreadId: older, openBrief: { requestId: `decision:${decisionId}` } }));
    expect(status('discord:thread:119')).toMatchObject({ pill: 'needs', countsForOwner: true });
  });

  it("a closed brief's page still names the Discord row it was on", async () => {
    discordRow('discord:thread:118', 'thread:118', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:118' });
    tick();
    const decisionId = (await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF }) as { decisionId: string }).decisionId;
    await until(() => expect(h.core.item('discord:thread:118')!.facts.loomThreadId).toBe(id));
    await loom.host.execute({ type: 'decision.close', commandId: cid(), threadId: id, decisionId, outcome: 'withdrawn', note: 'not needed' });
    await until(() => expect(h.core.item('discord:thread:118')!.facts.loomThreadId).toBeNull());
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], decided: new DeskDecided({ source, settings: h.core.store, now: () => h.clock.now }) });
    expect(((await (await app.request(`/api/desk/decisions/${decisionId}`)).json()) as Record<string, any>).raisedOn).toMatchObject({ itemId: 'discord:thread:118' });
  });

  it('a deleted agent thread takes its records off the Discord row', async () => {
    discordRow('discord:thread:116', 'thread:116', 'thread', h.clock.now);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:116' });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    await until(() => expect(h.core.item('discord:thread:116')!.facts.loomThreadId).toBe(id));
    await loom.host.execute({ type: 'delete', commandId: cid(), threadId: id });
    await until(() => expect(h.core.item('discord:thread:116')!.facts).toMatchObject({ pending: null, openBrief: null, openAsk: null, loomThreadId: null }));
    expect(h.core.store.marker(`loom-link:${id}`)).toBeNull();
  });

  it("a stale Loom thread never clears the row a newer thread of the same conversation now owns", async () => {
    discordRow('discord:thread:114', 'thread:114', 'thread', h.clock.now);
    const older = await agentThread();
    links.set(older, { agentId: AGENT.id, conversation: 'thread:114' });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: older, brief: BRIEF });
    await until(() => expect(h.core.item('discord:thread:114')!.facts.loomThreadId).toBe(older));
    // The conversation moves to a newer thread: provider_sessions maps it now, the older thread maps nowhere.
    links.delete(older);
    const newer = await agentThread();
    links.set(newer, { agentId: AGENT.id, conversation: 'thread:114' });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: newer, brief: { ...BRIEF, ask: 'Buy the switch? Recommend: A.' } });
    await until(() => expect(h.core.item('discord:thread:114')!.facts.loomThreadId).toBe(newer));
    // The older thread is read again (its brief closes): the newer thread's records stay.
    const brief = loom.store.decisions(older).find((d) => d.status === 'open')!;
    await loom.host.execute({ type: 'decision.close', commandId: cid(), threadId: older, decisionId: brief.id, outcome: 'moot', note: 'moved' });
    tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.core.item('discord:thread:114')!.facts).toMatchObject({ loomThreadId: newer, openBrief: expect.objectContaining({ question: 'Buy the switch? Recommend: A.' }) });
  });

  it("a failed link lookup is tried again on the health tick, so an open brief still reaches its row", async () => {
    discordRow('discord:thread:120', 'thread:120', 'thread', h.clock.now);
    let failing = true;
    (source as unknown as { options: { discordLinks: unknown } }).options.discordLinks = { linkOf: (id: string) => (failing ? undefined : links.get(id) ?? null) };
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'thread:120' });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    await until(() => expect((source as unknown as { unlinked: Set<string> }).unlinked.has(id)).toBe(true));
    expect(h.core.item('discord:thread:120')!.facts.pending ?? null).toBeNull();
    failing = false;
    source.relink();
    await until(() => expect(h.core.item('discord:thread:120')!.facts).toMatchObject({ loomThreadId: id, pending: { requestId: expect.stringMatching(/^decision:D-/) } }));
  });

  it('in a home channel the record goes on the chapter that was talking when it was raised, not the newest-created one', async () => {
    // A long-lived chapter (created days ago, still in use) and a newer one the owner already finished.
    discordRow('discord:chapter:6000:old', 'channel:6000', 'chapter', h.clock.now - 7 * 86_400_000);
    discordRow('discord:chapter:6000:newer', 'channel:6000', 'chapter', h.clock.now - 2 * 86_400_000);
    h.core.store.addMessage({ messageId: 'm-newer', itemId: 'discord:chapter:6000:newer', author: 'agent', at: h.clock.now - 86_400_000, text: 'Done with that.' });
    h.core.store.addMessage({ messageId: 'm-old', itemId: 'discord:chapter:6000:old', author: 'owner', at: h.clock.now - 60_000, text: 'Ready to push the newsletter?' });
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'channel:6000' });
    tick();
    runtime.last.complete('Drafted.\n\n**Next — you:** say promote when ready.');
    await until(() => expect(h.core.item('discord:chapter:6000:old')!.facts.openAsk).toMatchObject({ text: 'say promote when ready.' }));
    expect(h.core.item('discord:chapter:6000:newer')!.facts.openAsk ?? null).toBeNull();
    // Another request lands in the other chapter half a minute later; filing the record again keeps it where it was raised.
    h.core.store.addMessage({ messageId: 'm-other', itemId: 'discord:chapter:6000:newer', author: 'owner', at: h.clock.now + 30_000, text: 'Something else.' });
    h.clock.now += 45_000;
    (source as unknown as { unlinked: Set<string> }).unlinked.add(id);
    source.relink();
    await source.idle();
    expect(h.core.item('discord:chapter:6000:old')!.facts.openAsk).toMatchObject({ text: 'say promote when ready.' });
    expect(h.core.item('discord:chapter:6000:newer')!.facts.openAsk ?? null).toBeNull();
  });

  it('keeps an answered brief in its original chapter when a newer request moves to another chapter', async () => {
    const a = 'discord:chapter:7000:a', b = 'discord:chapter:7000:b';
    discordRow(a, 'channel:7000', 'chapter', h.clock.now - 60_000);
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'channel:7000' });
    h.core.store.addMessage({ messageId: 'chapter-a', itemId: a, author: 'owner', at: h.clock.now, text: 'Compare the cards.' });
    tick();
    const d = await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    await until(() => expect(h.core.item(a)!.facts.openBrief?.requestId).toBe(`decision:${d.decisionId}`));
    tick();
    await h.core.command({ commandId: cid(), type: 'respond', itemId: a, args: { requestId: `decision:${d.decisionId}`, answers: { decision: 'A · Buy (Recommended)' } } });
    await until(() => expect(h.core.item(a)!.facts.answeredBrief?.id).toBe(d.decisionId));
    tick();
    discordRow(b, 'channel:7000', 'chapter', h.clock.now);
    h.core.store.addMessage({ messageId: 'chapter-b', itemId: b, author: 'owner', at: h.clock.now, text: 'Now compare switches.' });
    const ownReceipt = { id: 'D-99', choice: 'B · Wait', at: h.clock.now - 120_000 };
    h.core.setFacts(b, { answeredBrief: ownReceipt });
    tick();
    const newer = await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: { ...BRIEF, ask: 'Buy the switch? Recommend: A.' } });
    await until(() => expect(h.core.item(b)!.facts.openBrief?.requestId).toBe(`decision:${newer.decisionId}`));
    (source as unknown as { unlinked: Set<string> }).unlinked.add(id);
    source.relink();
    await source.idle();
    expect(h.core.item(a)!.facts.answeredBrief?.id).toBe(d.decisionId);
    expect(h.core.item(b)!.facts.answeredBrief).toEqual(ownReceipt);
  });

  it('in a home channel the brief goes on the chapter it was raised in, and waits for a chapter not filed yet', async () => {
    const id = await agentThread();
    links.set(id, { agentId: AGENT.id, conversation: 'channel:5000' });
    tick();
    await loom.host.execute({ type: 'decision.request', commandId: cid(), threadId: id, brief: BRIEF });
    // No chapter yet: nothing filed, and the thread is read again once one is.
    await until(() => expect((source as unknown as { unlinked: Set<string> }).unlinked.has(id)).toBe(true));
    discordRow('discord:chapter:5000:1', 'channel:5000', 'chapter', h.clock.now - 60_000);
    discordRow('discord:chapter:5000:2', 'channel:5000', 'chapter', h.clock.now + 60_000);
    source.relink();
    await until(() => expect(h.core.item('discord:chapter:5000:1')!.facts.pending?.requestId).toMatch(/^decision:D-/));
    expect(h.core.item('discord:chapter:5000:2')!.facts.pending ?? null).toBeNull();
  });
});

it('first ingestion fetches an old ask report beyond the latest twenty messages and carries legacy wake causes', async () => {
  source.stop();
  const t = loom.store.createThread({ kind: 'coding', title: 'Export review', cwd: '/work/tango', provider: 'claude' });
  const r = loom.store.createRun(t.id, 'user', 'Export report');
  const m = loom.store.addMessage(t.id, r.id, 'assistant', 'The full export report is ready for review.');
  loom.store.updateRun(r.id, { status: 'completed', ended_at: h.clock.now });
  loom.store.updateThread(t.id, { ask: JSON.stringify({ text: 'Watch the finished export cut', at: h.clock.now, messageId: m.id, runId: r.id }) });
  // This is historical fixture data, ingested only after all 140 runs exist.
  // Commit it together rather than fsyncing every fixture mutation separately.
  loom.store.tx(() => {
    for (let i = 0; i < 140; i++) {
      tick();
      const w = loom.store.createRun(t.id, 'wake', 'Loom: Your closing "Next — you" ("review") is still open from before. Say "still open" instead of repeating it. (Delegation board: ask once.)');
      loom.store.db.prepare('UPDATE runs SET wake_cause = NULL WHERE id = ?').run(w.id);
      loom.store.addMessage(t.id, w.id, 'assistant', 'Still open.');
      loom.store.updateRun(w.id, { status: 'completed', ended_at: h.clock.now });
    }
  });
  (source as unknown as { ingest(detail: unknown): void }).ingest(loom.host.detail(t.id));
  const detail = itemDetail(h.core, `loom:${t.id}`, [])!;
  expect(detail.reply!.text).toBe('The full export report is ready for review.');
  expect(detail.laterNotes!.count).toBe(140);
  expect(detail.messages.at(-1)!.meta!.wake!.cause).toBe('corrective');
});

describe('typed ask card transitions', () => {
  async function declared(steps?: string[]) {
    const id = await newThread();
    await loom.host.execute({ type: 'handoff.record', commandId: cid(), threadId: id, owner: 'you', text: 'Connect and unlock the backup drive', ask: { kind: 'do', ...(steps ? { steps } : {}) }, runId: loom.store.activeRun(id)!.id } as never);
    runtime.last.complete('Waiting for the drive.');
    await until(() => expect(item(id)?.facts.openAsk?.kind).toBe('do'));
    return id;
  }
  it('resolves each step through the route as the person, without owner messages', async () => {
    const id = await declared(['Connect the drive', 'Unlock the drive']);
    const askId = item(id)!.facts.openAsk!.id!;
    const before = loom.store.messages(id).filter(m => m.role === 'user').length;
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [] });
    const send = async (step: string) => (await app.request(`/api/desk/asks/${askId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: cid(), step }) })).json();
    expect(await send('1')).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.openAsk?.steps?.[0]).toMatchObject({ by: 'person' }));
    expect(item(id)!.facts.openAsk?.status).toBe('open');
    expect(await send('2')).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.askLedger?.status).toBe('done'));
    expect(deskStatus(item(id)!, h.clock.now).countsForOwner).toBe(false);
    expect(loom.store.messages(id).filter(m => m.role === 'user').length).toBe(before);
    expect(loom.store.db.prepare('SELECT resolved_by FROM asks WHERE id=?').get(askId)).toMatchObject({ resolved_by: 'person' });
  });
  it.each(['stale', 'not_open'])('maps Loom %s after the ledger pre-check to changed', async code => {
    const id = await declared();
    const askId = item(id)!.facts.openAsk!.id!;
    const adapter = source as unknown as { send(command: unknown): Promise<unknown>; resolveAsk(item: unknown, askId: string, args: unknown, context: unknown): Promise<unknown> };
    const send = vi.spyOn(adapter, 'send').mockResolvedValueOnce({ ok: false, code, error: 'The ask changed' });
    try {
      expect(await adapter.resolveAsk(h.core.store.item(`loom:${id}`), askId, { by: 'person', revision: 1 }, { commandId: cid() })).toMatchObject({ ok: false, changed: true });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ask.resolve', revision: 1 }));
    } finally { send.mockRestore(); }
  });
  it('a re-recorded migrated do ask resolves through the desk', async () => {
    const id = await declared();
    const askId = item(id)!.facts.openAsk!.id!;
    loom.store.db.prepare("UPDATE asks SET legacy=1 WHERE id=?").run(askId);
    await loom.host.execute({ type: 'submit', commandId: cid(), threadId: id, text: 'Re-record the ask', origin: { kind: 'peer', from: 'loom:fixture-lead', name: 'Lead', mailId: cid() } });
    await loom.host.execute({ type: 'handoff.record', commandId: cid(), threadId: id, owner: 'you', text: 'Connect and unlock the backup drive', ask: { kind: 'do' } });
    runtime.last.complete('Kind declared.');
    await until(() => expect(item(id)!.facts.askLedger).toMatchObject({ id: askId, revision: 2, legacy: 0 }));
    expect(await h.core.command({ type: 'ask.resolve', commandId: cid(), itemId: `loom:${id}`, args: { askId, revision: 2 } })).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.askLedger?.status).toBe('done'));
  });
  it('ordinary Done closes the ledger ask and its desk Undo reopens it', async () => {
    const id = await declared();
    const askId = item(id)!.facts.openAsk!.id!;
    tick();
    const done = await h.core.command({ type: 'done', commandId: cid(), itemId: `loom:${id}` });
    expect(done.status).toBe('applied');
    await until(() => expect(item(id)?.facts.askLedger?.status).toBe('closed-by-done'));
    expect(loom.store.db.prepare('SELECT status,resolved_by FROM asks WHERE id=?').get(askId)).toMatchObject({ status: 'closed-by-done', resolved_by: 'desk' });
    expect(await h.core.command({ type: 'undo', commandId: cid(), itemId: `loom:${id}`, args: { seq: done.outcome?.seq } })).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)?.facts.openAsk?.status).toBe('open'));
    expect(deskStatus(item(id)!, h.clock.now).countsForOwner).toBe(true);
  });
  it('a tick for the revision the owner saw before the ask was re-recorded is refused, and so is one on an ask already closed', async () => {
    const id = await declared(['Connect the drive', 'Unlock the drive']);
    const askId = item(id)!.facts.openAsk!.id!;
    // The thread's next turn re-records the same ask with another step first: the same id, revision 2.
    const wake = loom.store.tx(() => loom.store.createRun(id, 'wake', 'Loom: carry on'));
    await loom.host.kick(id);
    await until(() => expect(loom.store.run(wake.id)!.status).toBe('running'));
    await loom.host.execute({ type: 'handoff.record', commandId: cid(), threadId: id, owner: 'you', text: 'Connect and unlock the backup drive', ask: { kind: 'do', steps: ['Label the drive', 'Connect the drive', 'Unlock the drive'] }, runId: wake.id } as never);
    runtime.last.complete('Still waiting for the drive.');
    await until(() => expect(item(id)!.facts.openAsk).toMatchObject({ id: askId, revision: 2 }));
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [] });
    const send = async (body: Record<string, unknown>) => (await app.request(`/api/desk/asks/${askId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: cid(), ...body }) })).json();
    const steps = () => JSON.parse((loom.store.db.prepare('SELECT steps FROM asks WHERE id=?').get(askId) as { steps: string }).steps) as Array<{ text: string; done_at?: number }>;
    // The old card's tick names revision 1 (its step 1 was "Connect", now step 2): refused at the desk, nothing marked.
    // Once revised, a tick has to say which revision it saw.
    expect(await send({ step: '1', revision: 1 })).toMatchObject({ status: 'failed', error: expect.stringContaining('revision 2'), outcome: { changed: true } });
    expect(await send({ step: '1' })).toMatchObject({ status: 'failed', outcome: { changed: true } });
    // Loom's ledger is the fact: the source refuses a revision Loom has moved past even when the desk's copy agrees with the card.
    const direct = await (source as unknown as { resolveAsk(item: unknown, askId: string, args: unknown, context: unknown): Promise<{ ok: boolean; changed?: boolean; error?: string }> })
      .resolveAsk(h.core.store.item(`loom:${id}`), askId, { by: 'person', step: '1', revision: 1 }, { commandId: cid() });
    expect(direct).toMatchObject({ ok: false, changed: true, error: expect.stringContaining('revision 2') });
    expect(steps().every((step) => step.done_at === undefined)).toBe(true);
    // The revision on the card now goes through, and marks the step the owner saw.
    expect(await send({ step: '1', revision: 2 })).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.openAsk?.steps?.[0]).toMatchObject({ text: 'Label the drive', by: 'person' }));
    expect(await send({ step: '2', revision: 2 })).toMatchObject({ status: 'applied' });
    expect(await send({ step: '3', revision: 2 })).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)!.facts.askLedger?.status).toBe('done'));
    // Did it on an ask already closed is refused as changed, not dropped (Loom itself answers a closed ask with nothing).
    expect(await send({ step: '3', revision: 2 })).toMatchObject({ status: 'failed', error: expect.stringContaining('already done'), outcome: { changed: true } });
  });
  it('Done records closed-by-done and Undo restores the open ledger row', async () => {
    const id = await declared();
    tick();
    // The Done action on a standing conversation writes clear and Undo writes clear.undo.
    await h.core.command({ type: 'role', commandId: cid(), itemId: `loom:${id}`, args: { role: 'default' } });
    await until(() => expect(item(id)?.facts.role).toBe('default'));
    const done = await h.core.command({ type: 'done', commandId: cid(), itemId: `loom:${id}` });
    expect(done).toMatchObject({ status: 'applied', outcome: { cleared: true } });
    await until(() => expect(item(id)?.facts.askLedger?.status).toBe('closed-by-done'));
    expect(deskStatus(item(id)!, h.clock.now).countsForOwner).toBe(false);
    expect(await h.core.command({ type: 'undo', commandId: cid(), itemId: `loom:${id}`, args: { seq: done.outcome?.seq } })).toMatchObject({ status: 'applied' });
    await until(() => expect(item(id)?.facts.openAsk?.status).toBe('open'));
    expect(deskStatus(item(id)!, h.clock.now).countsForOwner).toBe(true);
  });
});

it('retires a worker handoff on the desk when its lead finishes receiving it, despite the lead timer', async () => {
  const lead = await newThread('Lead'); const leadSession = runtime.last;
  leadSession.complete('Ready.'); tick();
  const start = await loom.host.execute({ type: 'submit', commandId: cid(), cwd: '/work/tango', provider: 'claude', text: 'Build', parentThreadId: `loom:${lead}`, role: 'worker' });
  const worker = start.threadId!; const workerSession = runtime.last;
  await loom.host.execute({ type: 'handoff.record', commandId: cid(), threadId: worker, kind: 'agent', who: `loom:${lead}`, text: 'Review the completed work', ask: { kind: 'do' } });
  workerSession.complete('Work complete.');
  await until(() => expect(deskStatus(item(worker)!, h.clock.now).pill).toBe('waiting'));
  expect(loom.host.triggers.list(worker, 'waiting')).toHaveLength(0);
  tick();
  await loom.host.execute({ type: 'submit', commandId: cid(), threadId: lead, text: `✉️ Reply from “Worker” [loom:${worker}] · m-report\n\nWork complete.`, origin: { kind: 'peer', from: `loom:${worker}`, mailId: 'm-report' } });
  loom.host.triggers.create(lead, 'time', { afterMinutes: 60 }, 'Separate work');
  leadSession.complete('Received.');
  await until(() => expect(item(worker)!.facts.openAsk).toBeNull());
  expect(deskStatus(item(worker)!, h.clock.now).pill).not.toBe('waiting');
  await until(() => expect(deskStatus(item(lead)!, h.clock.now).pill).toBe('waiting'));
});
