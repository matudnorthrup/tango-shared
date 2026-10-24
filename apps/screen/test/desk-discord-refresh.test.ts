import * as path from 'node:path';
import { createApp } from '../server/app.js';
import { createDesk } from '../server/desk/setup.js';
import type { DiscordRest } from '../server/discord.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

let h: Harness;
afterEach(() => h?.close());
const event = (conversationKey: string, type: 'turn.finished' | 'turn.failed' = 'turn.finished') => ({
  type, conversationKey, agentId: AGENT.id, channelId: AGENT.homeChannelId, turnId: 'turn', at: NOW,
});
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Discord terminal event refresh', () => {
  it.each(['thread', 'channel'] as const)('reads a %s immediately, coalescing a burst without a full poll', async (kind) => {
    h = makeHarness();
    const id = kind === 'thread' ? '7001' : AGENT.homeChannelId;
    h.discord.threads = [{ id, parent_id: AGENT.homeChannelId, name: 'Test conversation' }];
    h.discord.push(id, msg(-1, 'owner', 'Please check this.'));
    await h.source.catchUp(id);
    const reply = msg(0, 'agent', 'The check is complete.');
    h.discord.push(id, reply);
    const read = vi.spyOn(h.discord, 'messages');
    const discover = vi.spyOn(h.discord, 'activeThreads');
    for (let i = 0; i < 5; i++) h.core.agentEvent(event(`${kind}:${id}`));
    await drain();
    const item = h.core.itemForConversation(`${kind}:${id}`)!;
    expect(h.core.store.messages(item.id).map((m) => m.text)).toContain(reply.content);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe(id);
    expect(discover).not.toHaveBeenCalled();
  });

  it('discovers a new thread on failure, even before an item exists', async () => {
    h = makeHarness();
    h.discord.threads = [{ id: '7001', parent_id: AGENT.homeChannelId, name: 'New thread' }];
    h.discord.push('7001', msg(0, 'agent', 'The check failed.'));
    expect(h.core.agentEvent(event('thread:7001', 'turn.failed'))).toEqual({ itemId: null });
    await drain();
    expect(h.core.item('discord:thread:7001')).toMatchObject({ messageCount: 1 });
  });

  it('waits for a regular poll read before a single trailing refresh', async () => {
    h = makeHarness();
    h.discord.push(AGENT.homeChannelId, msg(-1, 'owner', 'Check this.'));
    await h.source.poll();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = h.discord.messages.bind(h.discord);
    const read = vi.spyOn(h.discord, 'messages').mockImplementation(async (...args) => { await gate; return original(...args); });
    const polling = h.source.poll();
    await drain();
    h.discord.push(AGENT.homeChannelId, msg(0, 'agent', 'Done.'));
    h.core.agentEvent(event(`channel:${AGENT.homeChannelId}`));
    await drain();
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await polling;
    await drain();
    expect(h.core.itemForConversation(`channel:${AGENT.homeChannelId}`)?.messageCount).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['poll', 'catchUp', 'refresh'] as const)('reads again after a %s fetched before the reply, coalescing terminal events', async (kind) => {
    h = makeHarness();
    const id = AGENT.homeChannelId;
    h.discord.push(id, msg(-1, 'agent', 'Checking.', {
      reactions: [{ count: 1, me: false, emoji: { id: null, name: '👀' } }],
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reactions = vi.spyOn(h.discord, 'reactionUsers').mockImplementationOnce(async () => { await gate; return []; });
    const initialRead = vi.spyOn(h.discord, 'messagesSince');
    const trailingRead = vi.spyOn(h.discord, 'messages');
    const reading = kind === 'poll' ? h.source.poll() : kind === 'catchUp' ? h.source.catchUp(id) : h.source.refresh(id);
    await drain();
    // The fetch has resolved and its old messages were ingested; reaction processing holds the read open.
    expect(initialRead).toHaveBeenCalledOnce();
    expect(reactions).toHaveBeenCalledOnce();
    expect(h.core.itemForConversation(`channel:${id}`)?.messageCount).toBe(1);
    const reply = msg(0, 'agent', 'Here is the final answer.');
    h.discord.push(id, reply);
    for (let i = 0; i < 5; i++) h.core.agentEvent(event(`channel:${id}`));
    await drain();
    expect(trailingRead).not.toHaveBeenCalled();
    release();
    await reading;
    await drain();
    expect(trailingRead).toHaveBeenCalledOnce();
    const item = h.core.itemForConversation(`channel:${id}`)!;
    expect(h.core.store.messages(item.id).map((m) => m.text)).toContain(reply.content);
  });

  it('does not wait behind a different conversation and ignores nonterminal events', async () => {
    h = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = h.discord.messagesSince.bind(h.discord);
    vi.spyOn(h.discord, 'messagesSince').mockImplementation(async (id, since) => {
      if (id === AGENT.homeChannelId) await gate;
      return original(id, since);
    });
    const polling = h.source.poll();
    await drain();
    h.discord.threads = [{ id: '7001', parent_id: AGENT.homeChannelId, name: 'New thread' }];
    h.discord.push('7001', msg(0, 'agent', 'Done.'));
    h.core.agentEvent({ ...event('thread:7001'), type: 'turn.started' });
    await drain();
    expect(h.core.item('discord:thread:7001')).toBeNull();
    h.core.agentEvent(event('thread:7001'));
    await drain();
    expect(h.core.item('discord:thread:7001')?.messageCount).toBe(1);
    release();
    await polling;
  });

  it('logs read failures without throwing and permits a later retry', async () => {
    const log = vi.fn();
    h = makeHarness({ log });
    vi.spyOn(h.discord, 'messagesSince').mockRejectedValueOnce(new Error('Discord unavailable'));
    expect(() => h.core.agentEvent(event(`channel:${AGENT.homeChannelId}`))).not.toThrow();
    await drain();
    expect(log).toHaveBeenCalledWith('desk.discord.refresh.error', expect.objectContaining({ message: 'Discord unavailable' }));
    h.discord.push(AGENT.homeChannelId, msg(0, 'agent', 'Recovered.'));
    h.core.agentEvent(event(`channel:${AGENT.homeChannelId}`));
    await drain();
    expect(h.core.itemForConversation(`channel:${AGENT.homeChannelId}`)?.messageCount).toBe(1);
  });
});

// Exercise the production setup and HTTP event route, including its source-error trace wiring.
it('accepts HTTP terminal events promptly and traces a failed refresh', async () => {
  h = makeHarness();
  const scenes = new SceneStore(path.join(h.dir, 'scenes'));
  const hub = new Hub(scenes, async () => 'agent');
  const desk = createDesk({
      conversationFetch: async () => Response.json({ conversations: [], cursor: 0 }),
    db: scenes.db, hub, discord: h.discord as unknown as DiscordRest, agents: [AGENT], ownerIds: [], rules: null,
    summarize: async () => { throw new Error('No model calls'); }, postToBot: async () => 'agent',
    jobsDir: path.join(h.dir, 'jobs'), jobBridgeUrl: 'http://127.0.0.1:9', collaborationToken: '', log: () => {},
    githubReviews: false, systemDb: false,
  });
  const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { ...desk.routes, scenes: () => hub.liveScenes() }, compat: desk.compat } });
  const post = () => app.request('/api/desk/agent-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event(`channel:${AGENT.homeChannelId}`)) });
  try {
    const read = vi.spyOn(h.discord, 'messagesSince').mockRejectedValueOnce(new Error('Discord unavailable'));
    expect((await post()).status).toBe(200);
    await drain();
    expect(desk.trace.query({ kinds: ['source.error'] })).toEqual([expect.objectContaining({
      summary: 'desk.discord.refresh.error: Discord unavailable',
    })]);
    read.mockResolvedValue([msg(0, 'agent', 'The answer arrived.')]);
    const started = performance.now();
    expect((await post()).status).toBe(200);
    await drain();
    expect(desk.core.itemForConversation(`channel:${AGENT.homeChannelId}`)?.messageCount).toBe(1);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    console.info(`Terminal HTTP event to item update: ${Math.round(elapsed)} ms (fake Discord, no poll)`);
  } finally {
    desk.close(); hub.close(); scenes.db.close();
  }
});

it.each(['shadow', 'tango'] as const)('only awaits the store refresh in %s mode when it is authoritative', async (mode) => {
  h = makeHarness();
  const scenes = new SceneStore(path.join(h.dir, 'scenes'));
  const hub = new Hub(scenes, async () => 'agent');
  let rejectStore!: (error: Error) => void;
  const pendingStore = new Promise<Response>((_resolve, reject) => { rejectStore = reject; });
  const conversationFetch = vi.fn(() => pendingStore);
  const log = vi.fn();
  const desk = createDesk({
    conversationMode: mode, conversationFetch,
    db: scenes.db, hub, discord: h.discord as unknown as DiscordRest, agents: [AGENT], ownerIds: [], rules: null,
    summarize: async () => { throw new Error('No model calls'); }, postToBot: async () => 'agent',
    jobsDir: path.join(h.dir, 'jobs'), jobBridgeUrl: 'http://127.0.0.1:9', collaborationToken: '', log,
    githubReviews: false, systemDb: false,
  });
  let settled = false;
  // Exercise the actual callback passed by setup to the core, including its completion boundary.
  const refreshing = desk.core['options'].refreshConversation!(AGENT.homeChannelId)
    .then(() => { settled = true; }, () => { settled = true; });
  try {
    await drain();
    expect(conversationFetch).toHaveBeenCalledOnce();
    expect(settled).toBe(mode === 'shadow');
    rejectStore(new Error('Store unavailable'));
    await refreshing;
    await drain();
    if (mode === 'shadow') {
      expect(log).toHaveBeenCalledWith('desk.tango.poll.error', { message: 'Error: Store unavailable' });
    }
  } finally {
    rejectStore(new Error('Test cleanup'));
    await refreshing;
    await drain();
    desk.close(); hub.close(); scenes.db.close();
  }
});
