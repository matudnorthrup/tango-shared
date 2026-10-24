import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { snowflakeAt, type DiscordMessage, type DiscordRest, type DiscordThread } from '../server/discord.js';
import { Hub } from '../server/hub.js';
import { InboxEngine } from '../server/inbox.js';
import { InboxRules } from '../server/inbox-rules.js';
import { InboxStore } from '../server/inbox-store.js';
import { SceneStore } from '../server/store.js';

const OWNER = '111';
const SIERRA = { id: 'sierra', name: 'Sierra', homeChannelId: 'home' };
const NOW = 1_790_000_000_000;

function msg(minutesAgo: number, author: 'agent' | 'owner', content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: snowflakeAt(NOW - minutesAgo * 60_000),
    channel_id: 'x',
    content,
    author: author === 'owner' ? { id: OWNER, username: 'owner' } : { id: '999', bot: true, username: 'Sierra' },
    ...(author === 'agent' ? { webhook_id: 'w' } : {}),
    ...extra,
  };
}

/** Just enough of DiscordRest for the engine. */
class FakeDiscord {
  channels = new Map<string, DiscordMessage[]>();
  threads: DiscordThread[] = [];
  reactionUsersBy = new Map<string, string[]>();
  reacted: string[] = [];
  archived: string[] = [];
  async channel(id: string) {
    return { id, guild_id: 'g', last_message_id: this.channels.get(id)?.at(-1)?.id ?? null };
  }
  async activeThreads() {
    return this.threads;
  }
  async messages(channelId: string, options: { after?: string } = {}) {
    return (this.channels.get(channelId) ?? []).filter((message) => !options.after || BigInt(message.id) > BigInt(options.after));
  }
  async messagesSince(channelId: string, sinceMs: number) {
    return (this.channels.get(channelId) ?? []).filter((message) => Number((BigInt(message.id) >> 22n) + 1420070400000n) >= sinceMs);
  }
  async reactionUsers(_channel: string, messageId: string) {
    return this.reactionUsersBy.get(messageId) ?? [];
  }
  async react(channelId: string, messageId: string, emoji: string) {
    this.reacted.push(`${channelId}/${messageId}/${emoji}`);
  }
  async archiveThread(threadId: string) {
    this.archived.push(threadId);
  }
}

let dir: string;
let discord: FakeDiscord;
let store: InboxStore;
let engine: InboxEngine;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-cleanup-'));
  discord = new FakeDiscord();
  store = new InboxStore(new DatabaseSync(path.join(dir, 'db')), () => NOW);
  engine = new InboxEngine({
    store,
    discord: discord as unknown as DiscordRest,
    agents: [SIERRA],
    ownerIds: [OWNER],
    rules: new InboxRules(null),
    summarize: async () => ({ summary: 's', needsYou: false, continues: null, source: 'model' }),
    now: () => NOW,
    summaryDelayMs: 5,
  });
});

afterEach(() => {
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading further back', () => {
  it('reads threads up to 30 days old and home channels back 7 days', async () => {
    discord.channels.set('home', [msg(9 * 1440, 'agent', 'Too old.'), msg(3 * 1440, 'agent', 'Weekly report.')]);
    discord.threads = [
      { id: 't-old', name: 'Old', parent_id: 'home', last_message_id: snowflakeAt(NOW - 20 * 86_400_000) },
      { id: 't-ancient', name: 'Ancient', parent_id: 'home', last_message_id: snowflakeAt(NOW - 40 * 86_400_000) },
    ];
    discord.channels.set('t-old', [msg(20 * 1440, 'agent', 'Here is the plan.')]);
    await engine.poll();
    expect(store.list().map((item) => item.lastText).sort()).toEqual(['Here is the plan.', 'Weekly report.']);
  });

  it('marks items read when the owner already reacted in Discord', async () => {
    const reacted = msg(60, 'agent', 'Done with the research.', { reactions: [{ count: 1, me: false, emoji: { id: null, name: '✅' } }] });
    discord.channels.set('home', [reacted]);
    discord.reactionUsersBy.set(reacted.id, [OWNER]);
    await engine.poll();
    expect(store.list()[0]).toMatchObject({ state: 'read', note: 'reacted' });
  });

  it("ignores the bot's own reactions", async () => {
    discord.channels.set('home', [msg(60, 'agent', 'Update.', { reactions: [{ count: 1, me: true, emoji: { id: null, name: '✅' } }] })]);
    await engine.poll();
    expect(store.list()[0]!.state).toBe('queued');
  });

  it('a rebuild during a poll waits for it, then reads everything', async () => {
    discord.channels.set('home', [msg(30, 'agent', 'Report.')]);
    const first = engine.poll();
    const rebuilt = await engine.rebuild();
    await first;
    expect(rebuilt.messages).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('a rebuild reads everything again without reopening what Discord says is done', async () => {
    const answer = msg(30, 'agent', 'Which one?');
    discord.channels.set('home', [answer, msg(20, 'owner', 'the first')]);
    await engine.poll();
    expect(store.list()).toHaveLength(1); // the question and the answer are one topic
    await engine.rebuild();
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ lastText: 'Which one?', state: 'read', note: 'replied' });
    // A second pass over the same messages files nothing new.
    await engine.poll();
    expect(store.list().map((item) => item.messageCount)).toEqual(items.map((item) => item.messageCount));
  });
});

describe('👍 seen', () => {
  it("stays open and quiet: not waiting on you, no expiry, back to normal when the agent speaks", async () => {
    discord.channels.set('home', [msg(60, 'agent', 'Want me to order it?')]);
    await engine.poll();
    const id = store.list()[0]!.id;
    engine.ack(id);
    const rules = new InboxRules(null);
    const { inboxView } = await import('../server/inbox-view.js');
    expect(inboxView(store, rules, [], { filter: 'needs_you' })).toHaveLength(0);
    expect(inboxView(store, rules, [], { filter: 'open' })[0]).toMatchObject({ id, acked: true, state: 'heard' });
    const later = new InboxStore(store['db' as never], () => NOW + 30 * 86_400_000);
    later.prune();
    expect(store.get(id)).not.toBeNull();
    await engine.ingest({ channelId: 'home', agent: SIERRA, thread: null }, msg(0, 'agent', 'Price dropped, by the way.'));
    expect(store.get(id)).toMatchObject({ acked: false, state: 'queued' });
  });

  it("reads the owner's own Discord reactions: 👍 is seen, ✅ is done", async () => {
    const thumbs = msg(60, 'agent', 'Report A.', { reactions: [{ count: 1, me: false, emoji: { id: null, name: '👍' } }] });
    discord.threads = [{ id: 't2', name: 'B', parent_id: 'home', last_message_id: snowflakeAt(NOW - 50 * 60_000) }];
    const check = msg(50, 'agent', 'Report B.', { reactions: [{ count: 1, me: false, emoji: { id: null, name: '✅' } }] });
    discord.channels.set('home', [thumbs]);
    discord.channels.set('t2', [check]);
    discord.reactionUsersBy.set(thumbs.id, [OWNER]);
    discord.reactionUsersBy.set(check.id, [OWNER]);
    await engine.poll();
    expect(store.list().find((item) => item.lastText === 'Report A.')).toMatchObject({ acked: true, state: 'heard' });
    expect(store.get('thread:t2')).toMatchObject({ state: 'read', note: 'reacted' });
  });
});

describe('done', () => {
  it('puts a ✅ on the latest agent message and closes a thread', async () => {
    discord.threads = [{ id: 't1', name: 'Speaker', parent_id: 'home', last_message_id: snowflakeAt(NOW - 60_000) }];
    const last = msg(1, 'agent', 'Ordered.');
    discord.channels.set('t1', [msg(5, 'agent', 'Which?'), last]);
    await engine.poll();
    const result = await engine.done('thread:t1');
    expect(discord.reacted).toEqual([`t1/${last.id}/✅`]);
    expect(discord.archived).toEqual(['t1']);
    expect(result.item).toMatchObject({ state: 'read', note: 'done, thread closed' });
  });

  it('home-channel items get the ✅ but nothing is archived', async () => {
    discord.channels.set('home', [msg(5, 'agent', 'Report.')]);
    await engine.poll();
    const id = store.list()[0]!.id;
    const result = await engine.done(id);
    expect(result).toMatchObject({ reacted: true, archived: false });
    expect(discord.archived).toEqual([]);
  });

  it('bulk-done through the API', async () => {
    discord.channels.set('home', [msg(300, 'agent', 'A.'), msg(5, 'agent', 'B.')]);
    await engine.poll();
    const scenes = new SceneStore(path.join(dir, 'scenes'));
    const app = createApp({
      store: scenes,
      hub: new Hub(scenes, async () => 'agent'),
      publicDir: dir,
      inbox: { engine, rules: new InboxRules(null), reply: async () => 'agent', react: async () => {} },
    });
    const ids = store.list().map((item) => item.id);
    const response = await app.request('/api/inbox/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'done', ids }),
    });
    expect(await response.json()).toEqual({ count: 2, reacted: 2, archived: 0 });
    expect(store.list().every((item) => item.state === 'read')).toBe(true);
  });
});
