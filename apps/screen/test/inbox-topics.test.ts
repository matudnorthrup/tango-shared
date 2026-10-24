import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snowflakeAt, type DiscordMessage } from '../server/discord.js';
import { InboxEngine, type Conversation } from '../server/inbox.js';
import { InboxRules } from '../server/inbox-rules.js';
import { InboxStore } from '../server/inbox-store.js';
import { isActive } from '../server/inbox-view.js';
import { fallbackTopic, type TopicInput } from '../server/inbox-topics.js';

const OWNER = '111';
const MALIBU = { id: 'malibu', name: 'Malibu', homeChannelId: 'chat' };
const chat: Conversation = { channelId: 'chat', agent: MALIBU, thread: null };
// Oct 4 2026, 9:00 local.
const DAY = new Date(2026, 9, 4, 9, 0).getTime();

let dir: string;
let clock: number;
let store: InboxStore;
let engine: InboxEngine;
let assignerCalls: TopicInput[];

function msg(at: number, author: 'agent' | 'owner', content: string): DiscordMessage {
  return {
    id: snowflakeAt(at),
    channel_id: 'chat',
    content,
    author: author === 'owner' ? { id: OWNER, username: 'owner' } : { id: '999', bot: true, username: 'Malibu' },
    ...(author === 'agent' ? { webhook_id: 'w' } : {}),
  };
}

/** Food talk continues the open food topic; anything about the Bike is its own topic. */
const scriptedAssigner = async (input: TopicInput) => {
  assignerCalls.push(input);
  const subject = /bike|signal/i.test(input.message.text) ? 'Bike turn signal' : /all set|that's everything/i.test(input.message.text) ? 'wrap' : 'Food tracking';
  if (subject === 'wrap') return { topicId: input.candidates[0]?.id ?? null, title: 'Food tracking', wrapsUp: true, source: 'model' as const };
  const match = input.candidates.find((candidate) => candidate.title === subject);
  return { topicId: match?.id ?? null, title: subject, wrapsUp: false, source: 'model' as const };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-topics-'));
  clock = DAY;
  assignerCalls = [];
  store = new InboxStore(new DatabaseSync(path.join(dir, 'db')), () => clock);
  engine = new InboxEngine({
    store,
    discord: null,
    agents: [MALIBU],
    ownerIds: [OWNER],
    rules: new InboxRules(null),
    summarize: async () => ({ summary: 's', needsYou: false, continues: null, source: 'model' }),
    assignTopic: scriptedAssigner,
    now: () => clock,
    summaryDelayMs: 5,
  });
});

afterEach(() => {
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const minutes = (n: number) => DAY + n * 60_000;
const topics = () => store.list().filter((item) => item.kind === 'topic');
const byTitle = (title: string) => topics().find((item) => item.place === title)!;

describe('chat topics', () => {
  it('interleaved subjects in one chat become separate topics, and each answer lands with its ask', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: two eggs and oats'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged breakfast: 420 kcal.'));
    await engine.ingest(chat, msg(minutes(5), 'owner', 'my bike turn signal blinks fast, ideas?'));
    await engine.ingest(chat, msg(minutes(6), 'agent', 'Likely a bulb drawing low current. Check the rear first?'));
    await engine.ingest(chat, msg(minutes(90), 'owner', 'log lunch: chili bowl'));
    await engine.ingest(chat, msg(minutes(91), 'agent', 'Logged lunch: 620 kcal. 1,040 so far.'));
    expect(topics()).toHaveLength(2);
    expect(byTitle('Food tracking')).toMatchObject({ messageCount: 4, lastText: 'Logged lunch: 620 kcal. 1,040 so far.', status: 'done', state: 'queued' });
    expect(byTitle('Bike turn signal')).toMatchObject({ messageCount: 2, status: 'needs_you' });
    // Answers to the owner's ask never needed the model.
    expect(assignerCalls.map((call) => call.message.author)).toEqual(['owner', 'owner', 'owner']);
  });

  it('the rest of a reply split across messages stays with the reply', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: two eggs and oats'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged breakfast: 420 kcal. Two things to flag:'));
    // Discord splits a long reply; this part mentions the Bike, which alone would look like a new subject.
    await engine.ingest(chat, { ...msg(minutes(1) + 1000, 'agent', '1. The Bike signal question from earlier is still open.'), id: snowflakeAt(minutes(1) + 1000) });
    expect(topics()).toHaveLength(1);
    expect(byTitle('Food tracking')).toMatchObject({ messageCount: 3 });
    expect(assignerCalls.map((call) => call.message.author)).toEqual(['owner']);
  });

  it('shows the ask while the agent works', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: two eggs and oats'));
    expect(topics()[0]).toMatchObject({ place: 'Food tracking', status: 'in_progress', summary: 'log breakfast: two eggs and oats', summarySource: 'request' });
  });

  it('"thanks" settles the topic it thanks; the agent\'s sign-off does not reopen it', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged: 300 kcal.'));
    await engine.ingest(chat, msg(minutes(2), 'owner', 'thanks!'));
    await engine.ingest(chat, msg(minutes(3), 'agent', 'Anytime!'));
    expect(topics()).toHaveLength(1);
    expect(topics()[0]).toMatchObject({ state: 'read', note: 'acknowledged' });
  });

  it('a wrap-up the model recognizes closes the topic', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log dinner: salmon'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged dinner. 1,900 for the day.'));
    await engine.ingest(chat, msg(minutes(2), 'owner', "ok that's everything for today"));
    expect(topics()[0]).toMatchObject({ state: 'read', note: 'acknowledged' });
  });

  it('ignores system notices, and agreement is not a wrap-up', async () => {
    await engine.ingest(chat, { ...msg(minutes(0), 'owner', 'Spider Mites'), type: 18 });
    expect(topics()).toHaveLength(0);
    await engine.ingest(chat, msg(minutes(1), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(2), 'agent', 'Logged: 300 kcal.'));
    // The scripted assigner flags "all set" as wrap-up; "sure, add a coffee" would be flagged by a sloppy model too.
    await engine.ingest(chat, msg(minutes(3), 'owner', "all set, that's everything"));
    expect(topics()[0]).toMatchObject({ state: 'read', note: 'acknowledged' });
  });

  it('topics the owner starts settle overnight like any other', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: eggs'));
    clock = DAY + 22 * 3_600_000;
    expect(engine.settleQuiet()).toHaveLength(1);
  });

  it('a follow-up shortly after closing a topic reopens it', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged: 300 kcal.'));
    await engine.done(topics()[0]!.id);
    await engine.ingest(chat, msg(minutes(30), 'owner', 'also log a coffee with milk'));
    expect(topics()).toHaveLength(1);
    expect(topics()[0]).toMatchObject({ status: 'in_progress', messageCount: 3 });
  });
});

describe('settling', () => {
  it("settles a chat topic once its day is over; tomorrow's food talk is a new topic", async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged: 300 kcal.'));
    clock = DAY + 15 * 3_600_000; // midnight-ish, before 4 am: still the same day
    expect(engine.settleQuiet()).toEqual([]);
    clock = DAY + 22 * 3_600_000; // 7 am the next day
    const [settled] = engine.settleQuiet();
    expect(store.get(settled!)).toMatchObject({ state: 'read', note: 'settled' });
    expect(isActive(store.get(settled!)!, clock)).toBe(false);
    await engine.ingest(chat, msg(clock, 'owner', 'log breakfast: yogurt'));
    expect(topics()).toHaveLength(2);
  });

  it('replaying history (a rebuild) starts a new topic each day, as live settling would', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged: 300 kcal.'));
    await engine.ingest(chat, msg(DAY + 24 * 3_600_000, 'owner', 'log breakfast: yogurt'));
    expect(topics()).toHaveLength(2);
  });

  it('something waiting on the owner gets three quiet days; threads never settle on their own', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'bike turn signal blinks fast'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Check the rear bulb first?'));
    await engine.ingest({ channelId: 't1', agent: MALIBU, thread: 'Garage project' }, msg(minutes(2), 'agent', 'Shelf plan is posted.'));
    clock = DAY + 2 * 86_400_000;
    expect(engine.settleQuiet()).toEqual([]);
    clock = DAY + 4 * 86_400_000;
    expect(engine.settleQuiet()).toEqual([byTitle('Bike turn signal').id]);
    expect(store.get('thread:t1')!.state).toBe('queued');
  });
});

describe('corrections', () => {
  it('splits a topic at a message and merges topics back', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Logged: 300 kcal.'));
    const second = msg(minutes(2), 'owner', 'log lunch too: salad');
    await engine.ingest(chat, second);
    await engine.ingest(chat, msg(minutes(3), 'agent', 'Logged lunch.'));
    const food = topics()[0]!;
    const split = engine.split(food.id, second.id)!;
    expect(split).toMatchObject({ messageCount: 2, lastText: 'Logged lunch.' });
    expect(store.get(food.id)).toMatchObject({ messageCount: 2, lastText: 'Logged: 300 kcal.' });
    const merged = engine.merge(split.id, food.id)!;
    expect(merged.messageCount).toBe(4);
    expect(store.get(split.id)).toBeNull();
  });
});

describe('screen replies', () => {
  it('a reply from the screen, and the answer to it, stay in the topic replied to', async () => {
    await engine.ingest(chat, msg(minutes(0), 'owner', 'bike turn signal blinks fast'));
    await engine.ingest(chat, msg(minutes(1), 'agent', 'Rear or front?'));
    await engine.ingest(chat, msg(minutes(2), 'owner', 'log breakfast: eggs'));
    await engine.ingest(chat, msg(minutes(3), 'agent', 'Logged: 300 kcal.'));
    const bike = byTitle('Bike turn signal');
    engine.replied(bike.id);
    await engine.ingest(chat, msg(minutes(4), 'agent', '🖥️ The owner replied from the screen (re: "x"):\nthe rear'));
    await engine.ingest(chat, msg(minutes(5), 'agent', 'Then swap the rear bulb.'));
    expect(store.get(bike.id)).toMatchObject({ lastText: 'Then swap the rear bulb.', messageCount: 4 });
    expect(topics()).toHaveLength(2);
  });
});

describe('fallback without a model', () => {
  it('continues a topic active in the last two hours, otherwise starts a new one', () => {
    const candidate = { id: 'c1', title: 'Food tracking', standing: '', lastActivityAt: DAY, recent: [] };
    expect(fallbackTopic({ agentName: 'Malibu', message: { author: 'owner', text: 'log lunch', at: DAY + 3_600_000 }, candidates: [candidate] }).topicId).toBe('c1');
    expect(fallbackTopic({ agentName: 'Malibu', message: { author: 'owner', text: 'log lunch: chili bowl please', at: DAY + 3 * 3_600_000 }, candidates: [candidate] })).toMatchObject({
      topicId: null,
      title: 'log lunch: chili bowl please',
    });
  });
});

describe('the model call', () => {
  const candidates = [
    { id: 'topic:x:1', title: 'Coffee subscription', standing: '', lastActivityAt: DAY, recent: [] },
    { id: 'topic:x:2', title: 'Weekly reconciliation', standing: '', lastActivityAt: DAY, recent: [] },
  ];
  const withReply = (content: string) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as typeof fetch;
    return () => (globalThis.fetch = original);
  };
  const input = { agentName: 'Foxtrot', message: { author: 'owner' as const, text: 'sure, subscribe me', at: DAY }, candidates };

  it('maps a handle back to the topic', async () => {
    const { createOllamaTopicAssigner } = await import('../server/inbox-topics.js');
    const restore = withReply('{"topic":"T2","title":"Weekly reconciliation","wraps_up":false}');
    try {
      expect((await createOllamaTopicAssigner({ apiKey: 'k', model: 'm' })(input)).topicId).toBe('topic:x:2');
    } finally {
      restore();
    }
  });

  it('treats a new topic titled like an open one as that topic', async () => {
    const { createOllamaTopicAssigner } = await import('../server/inbox-topics.js');
    const restore = withReply('{"topic":null,"title":"Coffee subscription","wraps_up":false}');
    try {
      expect((await createOllamaTopicAssigner({ apiKey: 'k', model: 'm' })(input)).topicId).toBe('topic:x:1');
    } finally {
      restore();
    }
  });
});
