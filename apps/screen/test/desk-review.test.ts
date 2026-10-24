import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialAttention, reduceAttention } from '../server/desk/attention.js';
import { snowflakeAt } from '../server/discord.js';
import { DeskCore } from '../server/desk/core.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// Regression tests for the integration review findings (each named after the finding).

const iso = (minute: number) => new Date(NOW + minute * 60_000).toISOString();
const KEY = `channel:${AGENT.homeChannelId}`;

let h: Harness;
function turn(type: 'turn.started' | 'turn.activity' | 'turn.finished' | 'turn.failed', turnId: string, extra: Record<string, unknown> = {}) {
  return h.core.agentEvent({ type, agentId: AGENT.id, conversationKey: KEY, channelId: AGENT.homeChannelId, turnId, at: h.clock.now, ...extra });
}

const pending = (core: DeskCore) => (core as unknown as { pendingSummaries: Map<string, unknown> }).pendingSummaries;

beforeEach(() => {
  h = makeHarness();

});
afterEach(() => h.close());

describe('summary scheduling', () => {
  it('writing a summary never schedules another (no 8-second resummarize loop)', async () => {
    let calls = 0;
    h.summarizer.impl = async () => {
      calls += 1;
      return { gist: 'Weather is fine', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' };
    };
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'Weather is fine today.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(calls).toBe(1);
    expect(pending(h.core).size).toBe(0);
    h.core.tick();
    expect(pending(h.core).size).toBe(0);
  });

  it('a summary that lands for older words is dropped and rescheduled for the new ones', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    h.summarizer.impl = async (input) => {
      calls += 1;
      if (calls === 1) await gate;
      return { gist: input.messages.at(-1)!.text, step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' };
    };
    h.discord.push(AGENT.homeChannelId, msg(-2, 'agent', 'First.'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    const run = h.core.summarizeNow(id);
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'Second.'));
    await h.source.poll();
    release();
    await run;
    await h.core.drainSummaries();
    expect(h.core.item(id)!.summary?.gist).toBe('Second.');
  });
});

describe('finding 3: chapters never settle while something is going on', () => {
  it('a running turn with activity keeps the chapter open past 30 minutes', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'owner', 'Run the full migration'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    turn('turn.started', 't1');
    for (let minute = 0; minute < 35; minute += 1) {
      h.clock.now += 60_000;
      turn('turn.activity', 't1', { activity: 'Running npm test' });
      h.core.tick();
    }
    expect(h.core.item(id)).toMatchObject({ nextStep: 'working', disposition: 'active' });
  });

  it('a background job keeps it open; the standing chapter stays open even after the job ends', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'Started the nightly scan.'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    h.core.setJobs([{ id: 'job-1', agentId: AGENT.id, channelId: AGENT.homeChannelId, threadId: null, conversationKey: KEY, label: 'scan', startedAt: h.clock.now, deadlineAt: null }]);
    h.clock.now += 45 * 60_000;
    h.core.tick();
    expect(h.core.item(id)).toMatchObject({ nextStep: 'working', disposition: 'active' });
    h.core.setJobs([]);
    h.clock.now += 31 * 60_000;
    h.core.tick();
    expect(h.core.item(id)!.disposition).toBe('active');
  });

  it('a recorded wait keeps it open, regardless of the summary', async () => {
    h.summarizer.impl = async () => ({ gist: 'Sent the samples out', step: 'watching', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: { who: 'the designer', what: 'a pick' }, source: 'model' });
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'Sent the tile samples to the designer for a pick.'));
    await h.source.poll();
    await h.core.drainSummaries();
    const id = h.core.items()[0]!.id;
    h.core.setFacts(id, { waits: [{ id: 'w', kind: 'thread', target: 'Designer pick', armedAt: NOW, lastCheckedAt: NOW }] });
    h.core.refresh(id);
    h.clock.now += 40 * 60_000;
    h.core.tick();
    expect(h.core.item(id)).toMatchObject({ nextStep: 'watching', disposition: 'active' });
  });
});

describe('finding 4: a failure stays with its own chapter', () => {
  it('an old failure is not copied into a new agent-started chapter days later', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'owner', 'do x'));
    await h.source.poll();
    const first = h.core.items()[0]!.id;
    turn('turn.started', 't1');
    turn('turn.failed', 't1', { error: { reason: 'usage-limit', message: 'Usage limit' } });
    expect(h.core.item(first)!.nextStep).toBe('failed');
    h.clock.now += 2 * 86_400_000;
    h.discord.push(AGENT.homeChannelId, msg(2 * 24 * 60, 'agent', 'Morning reminder: trash day.'));
    await h.source.poll();
    const latest = h.core.items()[0]!;
    expect(latest.id).not.toBe(first);
    expect(latest.nextStep).not.toBe('failed');
    expect(latest.facts.failed ?? null).toBeNull();
    expect(h.core.item(first)!.disposition).toBe('done');
    expect(h.core.store.marker(`turn:${KEY}`)).toBeNull();
    // A later activity event in the new chapter doesn't drag the old failure in either.
    turn('turn.started', 't2');
    turn('turn.finished', 't2');
    expect(h.core.item(latest.id)!.facts.failed ?? null).toBeNull();
  });

  it('Clear preserves a failed chapter; a new running turn carries into the next chapter', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'owner', 'do x'));
    await h.source.poll();
    const first = h.core.items()[0]!.id;
    turn('turn.started', 't1');
    turn('turn.failed', 't1', { error: { reason: 'error', message: 'boom' } });
    await h.core.command({ commandId: cid(), type: 'done', itemId: first });
    expect(h.core.item(first)).toMatchObject({ disposition: 'active', nextStep: 'failed' });
    expect(JSON.parse(h.core.store.marker(`turn:${KEY}`)!)).toMatchObject({ failed: { turnId: 't1' } });
    turn('turn.started', 't2');
    // Beyond the exchange-continuation window, a new chapter takes the live turn.
    h.clock.now += 25 * 3_600_000;
    h.discord.push(AGENT.homeChannelId, msg(25 * 60, 'agent', 'Halfway there.'));
    await h.source.poll();
    const latest = h.core.items()[0]!;
    expect(latest.id).not.toBe(first);
    expect(latest.facts.running?.turnId).toBe('t2');
    expect(latest.nextStep).toBe('working');
  });

  it('a failed turn records the last good step from the activity line', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'owner', 'lower the threshold'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    turn('turn.started', 't1');
    turn('turn.activity', 't1', { activity: 'Edited health-check.ts' });
    turn('turn.failed', 't1', { error: { reason: 'overloaded', message: 'Provider overloaded' } });
    expect(h.core.item(id)!.facts).toMatchObject({ failed: { reason: 'overloaded', message: 'Provider overloaded' }, lastGoodStep: 'Edited health-check.ts' });
    turn('turn.started', 't2');
    expect(h.core.item(id)!.facts).toMatchObject({ failed: null, lastGoodStep: null });
  });
});

describe('finding 5: undoing an automatic transition sticks', () => {
  it('undoing a historical chapter.settled restores the standing chat, which never auto-settles again', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'Weather is fine today.'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    h.clock.now += 31 * 60_000;
    // A settlement written by the old idle-gap behavior remains undoable.
    const settled = h.core.store.appendEvent({ itemId: id, at: h.clock.now, type: 'chapter.settled', actor: 'system', payload: {} });
    h.core.store.saveAttention(reduceAttention(h.core.store.attention(id) ?? initialAttention(id, h.clock.now), settled));
    await h.core.command({ commandId: cid(), type: 'undo', args: { seq: settled.seq } });
    expect(h.core.item(id)!.disposition).toBe('active');
    for (let i = 0; i < 5; i += 1) {
      h.clock.now += 30 * 60_000;
      h.core.tick();
    }
    expect(h.core.item(id)!.disposition).toBe('active');
    // New activity followed by another idle gap still cannot end a standing chat.
    await h.core.command({ commandId: cid(), type: 'reply', itemId: id, args: { text: 'thanks' } });
    h.clock.now += 31 * 60_000;
    h.core.tick();
    expect(h.core.item(id)!.disposition).toBe('active');
    expect(h.core.store.eventsFor(id).filter((event) => event.type === 'chapter.settled')).toHaveLength(1);
  });

  it('an undone snooze expiry leaves the item active with the snooze cleared', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'Weather is fine today. Want the weekly view?'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { until: h.clock.now + 60_000 } });
    h.clock.now += 61_000;
    h.core.tick();
    expect(h.core.item(id)).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: true });
    const expired = h.core.store.eventsFor(id).find((event) => event.type === 'snooze.expired')!;
    await h.core.command({ commandId: cid(), type: 'undo', args: { seq: expired.seq } });
    h.clock.now += 30_000;
    h.core.tick();
    expect(h.core.item(id)).toMatchObject({ disposition: 'active', seen: 'seen', backFromSnooze: false, snoozeUntil: null });
    expect(h.core.store.eventsFor(id).filter((event) => event.type === 'snooze.expired')).toHaveLength(1);
  });
});

describe('orphaned turns', () => {
  async function started() {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'owner', 'go'));
    await h.source.poll();
    turn('turn.started', 't1');
    return h.core.items()[0]!.id;
  }

  it('closes a turn quiet for 20 min when the bot shows nothing in flight for it', async () => {
    const core = new DeskCore({ ...(h.core as unknown as { options: object }).options, botWork: async () => ({ channelTurns: 0, voiceTurns: 1, voiceConversations: ['other|42'] }) } as never);
    const id = await started();
    h.clock.now += 19 * 60_000;
    expect(await core.checkOrphanTurns()).toEqual([]);
    h.clock.now += 2 * 60_000;
    expect(await core.checkOrphanTurns()).toEqual([KEY]);
    expect(core.item(id)!.facts.running).toBeNull();
    expect(core.item(id)!.activity?.text).toMatch(/finished-unknown/);
  });

  it('keeps the lease while the bot reports that conversation in flight; closes when the bot is unreachable', async () => {
    let work: () => Promise<unknown> = async () => ({ voiceConversations: [`${AGENT.id}|${AGENT.homeChannelId}`] });
    const core = new DeskCore({ ...(h.core as unknown as { options: object }).options, botWork: () => work() } as never);
    const id = await started();
    h.clock.now += 25 * 60_000;
    expect(await core.checkOrphanTurns()).toEqual([]);
    expect(core.item(id)!.facts.running?.turnId).toBe('t1');
    work = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await core.checkOrphanTurns()).toEqual([KEY]);
  });

  it('a new turn.started replaces the lease', async () => {
    await started();
    h.clock.now += 25 * 60_000;
    turn('turn.started', 't2');
    expect(await h.core.checkOrphanTurns()).toEqual([]);
  });
});

describe('restart and retention bookkeeping', () => {
  const THREAD = '7100';
  beforeEach(() => {
    h.discord.threads = [{ id: THREAD, name: 'Weather', parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
  });
  it('a new post reopens immediately and its placement survives a restart', async () => {
    h.summarizer.impl = async () => ({ gist: 'Rain tomorrow', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' });
    h.discord.push(THREAD, msg(-10, 'agent', 'Weather is fine today.'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    h.clock.now += 60_000;
    h.discord.push(THREAD, msg(1, 'agent', 'Rain tomorrow, by the way.'));
    await h.source.poll();
    expect(h.core.item(id)!.disposition).toBe('active');
    expect(h.core.store.marker(`deferred:${id}`)).toBeNull();
    // "Restart": a fresh core over the same store.
    h.core.close();
    const core = new DeskCore({ ...(h.core as unknown as { options: object }).options } as never);
    core.start();
    await core.drainSummaries();
    core.close();
    expect(core.item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
    expect(h.core.store.marker(`deferred:${id}`)).toBeNull();
  });

  it('a deferred marker from before decidedAt is dropped at startup, never reopening the item', async () => {
    h.summarizer.impl = async () => ({ gist: 'Rain tomorrow', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' });
    h.discord.push(THREAD, msg(-10, 'agent', 'Weather is fine today.'));
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    h.clock.now += 60_000;
    h.discord.push(THREAD, msg(1, 'agent', 'Rain tomorrow, by the way.'));
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    const marker = { contentKey: h.core.item(id)!.facts.contentKey, step: 'fyi', at: NOW }; // a legacy persisted marker without decidedAt
    h.core.store.setMarker(`deferred:${id}`, JSON.stringify(marker));
    h.core.close();
    const core = new DeskCore({ ...(h.core as unknown as { options: object }).options } as never);
    core.start();
    expect(h.core.store.marker(`deferred:${id}`)).toBeNull();
    await core.drainSummaries();
    core.close();
    expect(core.item(id)!.disposition).toBe('done');
  });

  it('retention deletes the markers that belonged to a forgotten item', async () => {
    h.discord.push(THREAD, msg(-1, 'agent', 'Weather is fine today.'));
    await h.source.poll();
    const item = h.core.items()[0]!;
    await h.core.command({ commandId: cid(), type: 'done', itemId: item.id });
    h.core.store.setMarker(`nosettle:${item.id}`, '1');
    h.core.store.setMarker(`srcsnooze:${item.id}`, '1');
    expect(h.core.store.markerKeys(`reaction:${item.lastAgentMessageId}:`).length).toBeGreaterThan(0);
    h.clock.now += 31 * 86_400_000;
    expect(h.core.prune()).toEqual([item.id]);
    expect(h.core.store.marker(`nosettle:${item.id}`)).toBeNull();
    expect(h.core.store.marker(`srcsnooze:${item.id}`)).toBeNull();
    expect(h.core.store.markerKeys(`reaction:${item.lastAgentMessageId}:`)).toEqual([]);
  });

  it('the tick re-reads no messages when nobody spoke (artifact extraction is cached)', async () => {
    h.discord.push(AGENT.homeChannelId, msg(-1, 'agent', 'PR: https://github.com/acme/widgets/pull/12'));
    await h.source.poll();
    const store = h.core.store;
    const original = store.messages.bind(store);
    let reads = 0;
    store.messages = (...args: Parameters<typeof store.messages>) => {
      reads += 1;
      return original(...args);
    };
    h.core.tick();
    h.core.tick();
    expect(reads).toBe(0);
    expect(h.core.items()[0]!.artifacts).toEqual([{ kind: 'pr', label: 'PR #12', url: 'https://github.com/acme/widgets/pull/12' }]);
  });
});
