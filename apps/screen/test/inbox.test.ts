import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { snowflakeAt, snowflakeTime, type DiscordMessage } from '../server/discord.js';
import { Hub } from '../server/hub.js';
import { InboxEngine, type Conversation } from '../server/inbox.js';
import { InboxRules } from '../server/inbox-rules.js';
import { InboxStore } from '../server/inbox-store.js';
import { briefing, inboxView } from '../server/inbox-view.js';
import { asksOwner, textSummary, type SummaryInput, type Summarizer } from '../server/inbox-summarize.js';
import { SceneStore } from '../server/store.js';

const OWNER = '111';
const SIERRA = { id: 'sierra', name: 'Sierra', homeChannelId: 'c-sierra' };
const MALIBU = { id: 'malibu', name: 'Malibu', homeChannelId: 'c-malibu' };
const home = (agent = SIERRA): Conversation => ({ channelId: agent.homeChannelId, agent, thread: null });
const thread = (id: string, title: string, agent = SIERRA): Conversation => ({ channelId: id, agent, thread: title });

let dir: string;
let clock: number;
let store: InboxStore;
let engine: InboxEngine;
let rulesPath: string;
let summaries: SummaryInput[];
let summarizer: Summarizer;
let changed: string[];

function msg(minute: number, author: 'agent' | 'owner', content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  const at = 1_790_000_000_000 + minute * 60_000;
  return {
    id: snowflakeAt(at),
    channel_id: 'x',
    content,
    author: author === 'owner' ? { id: OWNER, username: 'owner' } : { id: '999', bot: true, username: 'Sierra' },
    ...(author === 'agent' ? { webhook_id: 'w' } : {}),
    ...extra,
  };
}

function build(rules = '') {
  if (rules) fs.writeFileSync(rulesPath, rules);
  const db = new DatabaseSync(path.join(dir, 'inbox.db'));
  store = new InboxStore(db, () => clock);
  engine = new InboxEngine({
    store,
    discord: null,
    agents: [SIERRA, MALIBU],
    ownerIds: [OWNER],
    rules: new InboxRules(rulesPath, () => clock),
    summarize: (input) => summarizer(input),
    onChange: (ids) => changed.push(...ids),
    now: () => clock,
    summaryDelayMs: 10,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
  rulesPath = path.join(dir, 'rules.yaml');
  clock = 1_790_000_000_000 + 600 * 60_000;
  summaries = [];
  changed = [];
  summarizer = async (input) => {
    summaries.push(input);
    const last = [...input.messages].reverse().find((message) => message.author === 'agent')?.text ?? '';
    return { summary: `S: ${textSummary(last, 40)}`, needsYou: asksOwner(last), continues: null, source: 'model' };
  };
  build();
});

afterEach(() => {
  engine.close();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('grouping', () => {
  it('one item per thread; the owner replying marks it read and in progress', async () => {
    const t = thread('t1', 'Bike speaker');
    await engine.ingest(t, msg(1, 'agent', 'Three picks are ready. Which one?'));
    expect(store.get('thread:t1')).toMatchObject({ state: 'queued', status: 'needs_you', place: 'Bike speaker' });
    await engine.ingest(t, msg(2, 'owner', 'The Pioneer'));
    expect(store.get('thread:t1')).toMatchObject({ state: 'read', note: 'replied', status: 'in_progress' });
    await engine.ingest(t, msg(3, 'agent', 'Ordered notes saved.'));
    expect(store.get('thread:t1')).toMatchObject({ state: 'queued', status: 'done', messageCount: 3 });
  });

  it('a scheduled post after a quiet gap is its own item', async () => {
    await engine.ingest(home(), msg(1, 'agent', 'Morning brief: three things.'));
    await engine.ingest(home(), msg(300, 'agent', 'Evening check-in: anything to log?'));
    expect(store.list()).toHaveLength(2);
  });

  it("treats voice transcripts and the screen's relayed posts as the owner", async () => {
    await engine.ingest(home(), msg(1, 'agent', 'Want me to book it?'));
    await engine.ingest(home(), msg(2, 'agent', '\u200BYes, book it'));
    expect(store.list()[0]!.state).toBe('read');
    await engine.ingest(home(), msg(3, 'agent', 'Booked. Anything else?'));
    await engine.ingest(home(), msg(4, 'agent', '🖥️ The owner replied from the screen (re: "x"):\nno thanks'));
    expect(store.list()[0]).toMatchObject({ state: 'read', status: 'in_progress' });
  });

  it('skips state-reconciler notices and background-job bookkeeping', async () => {
    await engine.ingest(home(), msg(1, 'agent', '⟢ state: project/bike next action updated'));
    await engine.ingest(home(), msg(2, 'agent', '⚙️ Background job **sweep** finished after 2m.'));
    expect(store.list()).toHaveLength(0);
    await engine.ingest(home(), msg(3, 'agent', 'Here is the plan.\n⟢ state: project/x updated'));
    expect(store.list()[0]!.lastText).toBe('Here is the plan.');
  });

  it('ignores other people', async () => {
    await engine.ingest(home(), msg(1, 'owner', 'hi', { author: { id: '222', username: 'someone' } }));
    expect(store.list()).toHaveLength(0);
  });

});

describe('summaries', () => {
  it('keeps in-progress when the owner spoke last', async () => {
    const t = thread('t2', 'Trip');
    await engine.ingest(t, msg(1, 'agent', 'Route options?'));
    await engine.ingest(t, msg(2, 'owner', 'the coast one'));
    await engine.summarizeNow('thread:t2');
    expect(store.get('thread:t2')!.status).toBe('in_progress');
  });
});

describe('operator items', () => {
  it("merges with Discord's copy by message id", async () => {
    const message = msg(1, 'agent', 'Brand K confirmed. Check buttons next?');
    const item = engine.addFromOperator({ agentId: 'sierra', channelId: 'c-sierra', messageIds: [message.id], taskId: 't7', summary: 'Brand K confirmed', kind: 'question' });
    expect(item).toMatchObject({ id: 'task:t7', kind: 'task', status: 'needs_you' });
    await engine.ingest(home(), message);
    expect(store.list()).toHaveLength(1);
    expect(store.get('task:t7')).toMatchObject({ lastText: 'Brand K confirmed. Check buttons next?' });
  });

  it('done sticks when the poll reads, afterwards, a message posted before the owner marked it', async () => {
    const t = thread('t9', 'Plates');
    await engine.ingest(t, msg(1, 'owner', 'Print the form.'));
    await engine.ingest(t, msg(2, 'agent', 'Starting the print.'));
    const late = msg(3, 'agent', 'The form printed.'); // posted before "done"...
    clock = snowflakeTime(late.id) + 30_000;
    engine.mark('thread:t9', 'read', 'done'); // ...the owner says done
    await engine.ingest(t, late); // ...and the poll reads it only now
    expect(store.get('thread:t9')).toMatchObject({ state: 'read', note: 'done', lastText: 'The form printed.' });
    await engine.ingest(t, msg(5, 'agent', 'One more thing.')); // posted after "done"
    expect(store.get('thread:t9')!.state).toBe('queued'); // a genuinely new message still reopens
  });

    it("an answer the operator files before Discord's copy still lands with its ask", async () => {
    // A quick voice exchange: the operator relays the answer at once; the inbox reads Discord later.
    const ask = msg(1, 'owner', 'Add item alpha to the list.');
    const answer = msg(2, 'agent', 'Alpha added.');
    engine.addFromOperator({ agentId: 'sierra', channelId: 'c-sierra', messageIds: [answer.id], taskId: 't9', summary: 'Alpha added', kind: 'result' });
    await engine.ingest(home(), ask);
    await engine.ingest(home(), answer);
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'done', lastText: 'Alpha added.', taskId: 't9' });
    expect(store.messages(items[0]!.id).map((row) => [row.author, row.text])).toEqual([
      ['owner', 'Add item alpha to the list.'],
      ['agent', 'Alpha added.'],
    ]);
  });

  it('a placeholder in a thread folds into the thread, and what the owner did with it carries over', async () => {
    // A new thread the inbox hasn't read yet: the operator's copy of the answer comes first.
    const t = thread('t5', 'Docs');
    const ask = msg(2, 'owner', 'Yes, publish it.');
    const answer = msg(3, 'agent', 'Published.');
    const placeholder = engine.addFromOperator({ agentId: 'sierra', channelId: 't5', messageIds: [answer.id], taskId: 't11', summary: 'Published', kind: 'result' });
    engine.mark(placeholder.id, 'heard'); // the owner heard it by voice
    engine.ack(placeholder.id); // and gave it a 👍
    await engine.ingest(t, ask);
    await engine.ingest(t, answer);
    expect(store.list().map((item) => item.id)).toEqual(['thread:t5']);
    expect(store.get('thread:t5')).toMatchObject({ status: 'done', acked: true, taskId: 't11', lastText: 'Published.' });
    // The voice side still holding the placeholder's id reaches the thread.
    expect(engine.resolveId(placeholder.id)).toBe('thread:t5');
  });

  it('self-repair fills empty answers, folds placeholders into their asks, and settles answered items', async () => {
    // What the old race left behind: the ask in a topic stuck "in progress", its answer in a
    // placeholder with no text.
    const ask = msg(1, 'owner', 'Add item gamma to the list.');
    const answer = msg(2, 'agent', 'Gamma added.');
    await engine.ingest(home(), ask);
    const topicId = store.list()[0]!.id;
    store.create({ id: 'task:sierra:old', kind: 'task', agentId: 'sierra', agentName: 'Sierra', channelId: 'c-sierra', summary: 'Gamma added', status: 'done' });
    store.addMessage({ messageId: answer.id, itemId: 'task:sierra:old', channelId: 'c-sierra', author: 'agent', at: snowflakeTime(answer.id), text: '' });
    expect(store.get(topicId)!.status).toBe('in_progress');
    const healer = new InboxEngine({
      store,
      discord: { message: async () => answer } as never,
      agents: [SIERRA, MALIBU],
      ownerIds: [OWNER],
      rules: new InboxRules(rulesPath, () => clock),
      summarize: (input) => summarizer(input),
      now: () => clock,
      summaryDelayMs: 10,
    });
    engine.mark('task:sierra:old', 'heard'); // the owner already heard it by voice
    expect(await healer.repair()).toEqual({ filled: 1, removed: 0, folded: 1, settled: 0 });
    expect(store.get(topicId)!.state).toBe('heard');
    healer.close();
    expect(store.list().map((item) => item.id)).toEqual([topicId]);
    expect(store.get(topicId)).toMatchObject({ status: 'done', lastText: 'Gamma added.' });
    expect(store.messages(topicId).map((row) => [row.author, row.text])).toEqual([
      ['owner', 'Add item gamma to the list.'],
      ['agent', 'Gamma added.'],
    ]);
  });

  it('self-repair settles an item still "in progress" after its agent answered', async () => {
    const ask = msg(1, 'owner', 'Add item delta to the list.');
    await engine.ingest(home(), ask);
    const topicId = store.list()[0]!.id;
    // The answer got stored without updating the item (an older race).
    store.addMessage({ messageId: msg(2, 'agent', 'x').id, itemId: topicId, channelId: 'c-sierra', author: 'agent', at: snowflakeTime(msg(2, 'agent', 'x').id), text: 'Delta added. Want epsilon too?' });
    expect(store.get(topicId)!.status).toBe('in_progress');
    expect(await engine.repair()).toEqual({ filled: 0, removed: 0, folded: 0, settled: 1 });
    expect(store.get(topicId)).toMatchObject({ status: 'needs_you', lastText: 'Delta added. Want epsilon too?', state: 'queued' });
  });

  it('reads the conversation first when the operator files an answer Discord has not been read for', async () => {
    const ask = msg(1, 'owner', 'Add item beta to the list.');
    const answer = msg(2, 'agent', 'Beta added.');
    const reads: string[] = [];
    const discord = {
      messages: async (channelId: string) => {
        reads.push(channelId);
        return [ask, answer];
      },
      messagesSince: async () => [ask, answer],
      channel: async () => ({ id: 'c-sierra', last_message_id: answer.id }),
      activeThreads: async () => [],
    };
    store.setMarker('c-sierra', '0');
    const synced = new InboxEngine({
      store,
      discord: discord as never,
      agents: [SIERRA, MALIBU],
      ownerIds: [OWNER],
      rules: new InboxRules(rulesPath, () => clock),
      summarize: (input) => summarizer(input),
      now: () => clock,
      summaryDelayMs: 10,
    });
    const item = await synced.addFromOperatorInOrder({ agentId: 'sierra', channelId: 'c-sierra', messageIds: [answer.id], taskId: 't10', summary: 'Beta added', kind: 'result' });
    synced.close();
    expect(reads).toEqual(['c-sierra']);
    expect(store.list()).toHaveLength(1);
    expect(item).toMatchObject({ status: 'done', taskId: 't10' });
    expect(item.id.startsWith('task:')).toBe(false);
  });

  it('heard never overrides later; read holds until new agent activity', async () => {
    await engine.ingest(home(), msg(1, 'agent', 'Report ready.'));
    const id = store.list()[0]!.id;
    engine.mark(id, 'later', 'after lunch');
    engine.mark(id, 'heard');
    expect(store.get(id)).toMatchObject({ state: 'later', note: 'after lunch' });
    engine.mark(id, 'read');
    await engine.ingest(home(), msg(2, 'agent', 'One more thing.'));
    expect(store.get(id)!.state).toBe('queued');
  });
});

describe('views and rules', () => {
  beforeEach(async () => {
    await engine.ingest(thread('t1', 'Library calendar', { id: 'papa', name: 'Papa', homeChannelId: 'c-papa' }), msg(1, 'agent', 'Can you confirm the speakers?'));
    await engine.ingest(thread('t2', 'PR review', { id: 'victor', name: 'Victor', homeChannelId: 'c-victor' }), msg(2, 'agent', 'PR ready: https://github.com/o/r/pull/12'));
    await engine.ingest(home(), msg(3, 'agent', 'Gas is cheaper in Riverton. Want the route?'));
  });

  it('smart sort: rule priority, then needs-you, then newest; quiet items sink', async () => {
    clock = new Date('2026-10-07T12:00:00').getTime(); // a Wednesday
    fs.writeFileSync(rulesPath, 'rules:\n  - name: Papa quiet\n    match: { agent: papa }\n    quiet_until: sunday\n  - name: Victor PRs\n    match: { agent: victor, text: "github.com/.+/pull/" }\n    priority: top\n    label: PR\n');
    const rules = new InboxRules(rulesPath, () => clock);
    const items = inboxView(store, rules, [], { filter: 'open' });
    expect(items.map((item) => item.agentId)).toEqual(['victor', 'sierra', 'papa']);
    expect(items[0]!.labels).toEqual(['PR']);
    expect(items[2]!.quiet).toBe(true);
    clock = new Date('2026-10-11T12:00:00').getTime(); // Sunday
    expect(inboxView(store, rules, [], { filter: 'open' }).find((item) => item.agentId === 'papa')!.quiet).toBe(false);
  });

  it('filters by status and agent', async () => {
    const rules = new InboxRules(null);
    expect(inboxView(store, rules, [], { filter: 'needs_you' }).map((item) => item.agentId).sort()).toEqual(['papa', 'sierra']);
    expect(inboxView(store, rules, [], { filter: 'open', agentId: 'sierra-ollama' })).toHaveLength(1);
  });

  it('keeps the last good rules when the file breaks', async () => {
    fs.writeFileSync(rulesPath, 'rules:\n  - name: ok\n    match: { agent: victor }\n    priority: top\n');
    const rules = new InboxRules(rulesPath);
    expect(rules.list()).toHaveLength(1);
    fs.writeFileSync(rulesPath, 'rules: [\n');
    fs.utimesSync(rulesPath, new Date(), new Date(Date.now() + 5000));
    expect(rules.list()).toHaveLength(1);
    expect(rules.error).toBeTruthy();
  });

  it('briefs the open items, waiting-on-you first', async () => {
    const result = briefing(store, new InboxRules(null), clock);
    expect(result.counts).toMatchObject({ open: 3, needsYou: 2 });
    expect(result.text).toMatch(/^Waiting on you: /);
  });
});

describe('inbox API', () => {
  let replies: Array<{ agentId: string; channelId: string; text: string }>;
  let reactions: string[];
  let screens: Array<{ event: string; data: unknown }>;

  function app() {
    const scenes = new SceneStore(path.join(dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    hub.addScreen('', { send: (event, data) => screens.push({ event, data }) });
    // Rebuild the engine so its change events reach this hub.
    const db = new DatabaseSync(path.join(dir, 'inbox.db'));
    store = new InboxStore(db, () => clock);
    engine = new InboxEngine({ store, discord: null, agents: [SIERRA], ownerIds: [OWNER], rules: new InboxRules(null), summarize: summarizer, onChange: (ids) => hub.inboxChanged(ids), now: () => clock, summaryDelayMs: 10 });
    return createApp({
      store: scenes,
      hub,
      publicDir: dir,
      inbox: {
        engine,
        rules: new InboxRules(null),
        reply: async (input) => {
          replies.push(input);
          return 'agent';
        },
        react: async (_channel, messageId, emoji) => {
          reactions.push(`${messageId}:${emoji}`);
        },
      },
    });
  }
  const post = async (a: ReturnType<typeof app>, url: string, body: unknown = {}) =>
    (await a.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;

  beforeEach(() => {
    replies = [];
    reactions = [];
    screens = [];
  });

  it('lists, replies, reacts, parks, and tells screens', async () => {
    const a = app();
    const question = msg(1, 'agent', 'Which speaker?');
    await engine.ingest(thread('t1', 'Speaker'), question);
    const listed = (await (await a.request('/api/inbox?filter=needs_you')).json()) as any;
    expect(listed.items.map((item: any) => item.id)).toEqual(['thread:t1']);
    expect(listed.counts.needs_you).toBe(1);

    const replied = await post(a, '/api/inbox/thread:t1/reply', { text: 'the Brand K' });
    expect(replies).toEqual([{ agentId: 'sierra', channelId: 't1', text: 'the Brand K', title: expect.any(String) }]);
    expect(replied).toMatchObject({ state: 'read', status: 'in_progress' });

    await engine.ingest(thread('t1', 'Speaker'), msg(5, 'agent', 'Brand K it is.'));
    await post(a, '/api/inbox/thread:t1/react', { emoji: '👍' });
    expect(reactions).toEqual([`${store.get('thread:t1')!.lastAgentMessageId}:👍`]);
    expect(store.get('thread:t1')).toMatchObject({ state: 'heard', acked: true, note: 'seen' });

    await post(a, '/api/inbox/thread:t1/later', { note: 'tonight' });
    expect(store.get('thread:t1')).toMatchObject({ state: 'later', note: 'tonight' });
    expect(screens.some((entry) => entry.event === 'inbox')).toBe(true);
  });

  it('accepts operator items and serves the briefing', async () => {
    const a = app();
    const item = await post(a, '/api/inbox/items', { agentId: 'sierra', summary: 'Brand K confirmed.', taskId: 't9', kind: 'result' });
    expect(item).toMatchObject({ id: 'task:t9', agentName: 'Sierra' });
    const brief = (await (await a.request('/api/inbox/briefing')).json()) as any;
    expect(brief.counts.open).toBe(1);
  });
});

describe('active', () => {
  it('is everything in play: not parked, not finished; a reply keeps it active while the agent works', async () => {
    const { isActive } = await import('../server/inbox-view.js');
    const base = { status: 'needs_you' as const, note: null, lastActivityAt: clock };
    expect(isActive({ ...base, state: 'queued' }, clock)).toBe(true);
    expect(isActive({ ...base, state: 'later' }, clock)).toBe(false);
    expect(isActive({ ...base, state: 'heard' }, clock)).toBe(true);
    expect(isActive({ ...base, state: 'read', status: 'in_progress', note: 'replied' }, clock)).toBe(true);
    expect(isActive({ ...base, state: 'read', status: 'in_progress', note: null }, clock)).toBe(true);
    expect(isActive({ ...base, state: 'read', status: 'in_progress', note: 'done, thread closed' }, clock)).toBe(false);
    expect(isActive({ ...base, state: 'read', status: 'done', note: 'reacted' }, clock)).toBe(false);
    expect(isActive({ ...base, state: 'read', status: 'in_progress', note: 'replied' }, clock + 3 * 86_400_000)).toBe(false);
  });

  it('a parked needs-you item leaves Active and Needs you, and shows under Later only', async () => {
    await engine.ingest(thread('t9', 'Transfer'), msg(1, 'agent', 'Include the parts charges?'));
    engine.mark('thread:t9', 'later', 'payday');
    const rules = new InboxRules(null);
    const ids = (filter: Parameters<typeof inboxView>[3]['filter']) => inboxView(store, rules, [], { filter, now: clock }).map((item) => item.id);
    expect(ids('active')).not.toContain('thread:t9');
    expect(ids('needs_you')).not.toContain('thread:t9');
    expect(ids('later')).toEqual(['thread:t9']);
    expect(ids('archive')).not.toContain('thread:t9');
  });

  it('what you asked an agent stays active (In progress) until it answers or you finish it', async () => {
    await engine.ingest(thread('t8', 'Route'), msg(1, 'agent', 'Coast or fast?'));
    await engine.ingest(thread('t8', 'Route'), msg(2, 'owner', 'coast, and find diesel on the way'));
    const rules = new InboxRules(null);
    expect(inboxView(store, rules, [], { filter: 'in_progress', now: clock }).map((item) => item.id)).toEqual(['thread:t8']);
    expect(inboxView(store, rules, [], { filter: 'active', now: clock }).map((item) => item.id)).toContain('thread:t8');
  });
});

describe('acknowledgments', () => {
  it('classifies short thanks as done, thanks-plus-later as seen, anything else as a reply', async () => {
    const { acknowledgment } = await import('../server/inbox.js');
    expect(acknowledgment('thanks!')).toBe('done');
    expect(acknowledgment('Sounds good, thank you 🙏')).toBe('done');
    expect(acknowledgment('perfect')).toBe('done');
    expect(acknowledgment("thanks, I'll look at it later")).toBe('seen');
    expect(acknowledgment('thanks, can you also check diesel?')).toBeNull();
    expect(acknowledgment('ok do the coast route')).toBeNull();
    expect(acknowledgment('yes please add onions to both')).toBeNull();
  });

  it('"thanks" on an update in a thread finishes it, and the agent\'s sign-off does not reopen it', async () => {
    const t = thread('t7', 'Stripes');
    await engine.ingest(t, msg(1, 'agent', 'Removal steps are posted above.'));
    await engine.ingest(t, msg(2, 'owner', 'perfect, thanks!'));
    expect(store.get('thread:t7')).toMatchObject({ state: 'read', note: 'acknowledged', status: 'done' });
    await engine.ingest(t, msg(3, 'agent', 'Anytime! Good luck with the stripes.'));
    expect(store.get('thread:t7')).toMatchObject({ state: 'read', note: 'acknowledged' });
    await engine.ingest(t, msg(4, 'agent', 'One more thing: the adhesive remover I listed was discontinued. Want the replacement?'));
    expect(store.get('thread:t7')).toMatchObject({ state: 'queued', status: 'needs_you' });
  });

  it('in a home channel, thanks attaches to the update instead of starting a new exchange', async () => {
    await engine.ingest(home(), msg(1, 'agent', 'Diesel is $4.10 in Riverton.'));
    await engine.ingest(home(), msg(2, 'owner', 'thank you'));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ state: 'read', note: 'acknowledged' });
  });

  it('"sounds good" answering a question is a reply: the agent goes to work', async () => {
    const t = thread('t6', 'Order');
    await engine.ingest(t, msg(1, 'agent', 'Want me to order the Brand K?'));
    await engine.ingest(t, msg(2, 'owner', 'sounds good'));
    expect(store.get('thread:t6')).toMatchObject({ state: 'read', note: 'replied', status: 'in_progress' });
  });

  it("thanks with a later hint is seen and stays active, quietly", async () => {
    const t = thread('t5', 'Plates');
    await engine.ingest(t, msg(1, 'agent', 'Here are five plate ideas.'));
    await engine.ingest(t, msg(2, 'owner', "thanks, I'll look later"));
    expect(store.get('thread:t5')).toMatchObject({ acked: true, state: 'heard' });
  });
});

describe('requests', () => {
  it('shows what the owner asked while the agent works, then the answer', async () => {
    const t = thread('t4', 'Diesel');
    await engine.ingest(t, msg(1, 'agent', 'Route is set.'));
    await engine.ingest(t, msg(2, 'owner', 'find diesel under $4 along the way'));
    expect(store.get('thread:t4')).toMatchObject({ status: 'in_progress', summary: 'find diesel under $4 along the way', summarySource: 'request' });
    await engine.ingest(t, msg(3, 'agent', 'Riverton Chevron, $3.89.'));
    await engine.summarizeNow('thread:t4');
    expect(store.get('thread:t4')).toMatchObject({ status: 'done', summarySource: 'model' });
  });

  it("a voice request's bracketed operator notes are not part of the ask", async () => {
    await engine.ingest(home(), msg(1, 'agent', '​[A screen is live where the user can see it.]\n\n[Test guard.]\n\nlog my lunch: chili bowl'));
    expect(store.list()[0]).toMatchObject({ summary: 'log my lunch: chili bowl', status: 'in_progress' });
  });

});

describe('operator answers before Discord catches up', () => {
  it('attach to the conversation the owner asked in, and Discord\'s copy lands there too', async () => {
    await engine.ingest(home(), msg(1, 'agent', '\u200Bsubscribe me to the 240-count bottle'));
    const asked = store.list()[0]!;
    expect(asked.status).toBe('in_progress');
    const reply = msg(2, 'agent', 'Done: subscribed, first ship Oct 22.');
    const item = engine.addFromOperator({ agentId: 'sierra', channelId: 'c-sierra', messageIds: [reply.id], summary: 'Subscribed, first ship Oct 22.' });
    expect(item.id).toBe(asked.id);
    expect(item).toMatchObject({ status: 'done', state: 'queued' });
    await engine.ingest(home(), reply);
    expect(store.list()).toHaveLength(1);
    expect(store.get(asked.id)).toMatchObject({ lastText: 'Done: subscribed, first ship Oct 22.' });
  });
});
