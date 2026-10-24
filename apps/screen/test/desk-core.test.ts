import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { snowflakeAt } from '../server/discord.js';
import { SUMMARY_VERSION } from '../server/desk/core.js';
import { migrateInboxDecisions } from '../server/desk/migrate.js';
import { fallbackSummary } from '../server/desk/summarize.js';
import { DeskJobsSource } from '../server/desk/source-jobs.js';
import { listItems, briefing, activityFeed, itemDetail, nextUpQueue } from '../server/desk/view.js';
import { Hub } from '../server/hub.js';
import { InboxRules } from '../server/inbox-rules.js';
import { InboxStore } from '../server/inbox-store.js';
import { SceneStore } from '../server/store.js';
import { AGENT, cid, makeHarness, msg, NOW, OWNER, type Harness } from './desk-harness.js';

let h: Harness;
const HOME = AGENT.homeChannelId;
// A last message id far ahead, so every poll reads the thread.
const thread = (id: string, name = 'Speaker') => ({ id, name, parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) });

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => h.close());

const item = (id: string) => h.core.item(id)!;
const chapters = () => h.core.items().filter((entry) => entry.kind === 'chapter').sort((a, b) => a.createdAt - b.createdAt);

describe("the owner's activity, for Loom's veto clock", () => {
  it('a fresh owner message in Discord counts; an old one polled late does not', async () => {
    const beats: Array<[number, string]> = [];
    h.core.onOwnerActivity((at, source) => beats.push([at, source]));
    h.discord.channels.set(HOME, [msg(-90, 'agent', 'Report is up.'), msg(-80, 'owner', 'thanks')]);
    await h.source.poll();
    expect(beats).toEqual([]);
    h.discord.push(HOME, msg(-1, 'owner', 'one more thing'));
    await h.source.poll();
    expect(beats.map(([, source]) => source)).toEqual(['message']);
  });
});

describe('Discord source', () => {
  it('splits a home channel into chapters at 30-minute gaps (no topic model)', async () => {
    const first = msg(-120, 'agent', 'Morning report: three things.');
    h.discord.channels.set(HOME, [first, msg(-110, 'owner', 'thanks, what about the third?'), msg(-105, 'agent', 'It is the tire order.'), msg(-60, 'agent', 'Weather alert for the ride.')]);
    await h.source.poll();
    const list = chapters();
    expect(list.map((entry) => entry.id)).toEqual([`discord:chapter:${HOME}:${first.id}`, expect.stringMatching(new RegExp(`^discord:chapter:${HOME}:`))]);
    expect(list.map((entry) => entry.messageCount)).toEqual([3, 1]);
    expect(list[0]!.conversationKey).toBe(`channel:${HOME}`);
  });

  it('an answer past the gap continues the chapter waiting on it, and so does the agent reply', async () => {
    h.discord.channels.set(HOME, [msg(-150, 'agent', 'The report is ready. Which format do you want?')]);
    await h.source.poll();
    const initial = chapters()[0]!;
    h.core.store.patchItem(initial.id, { facts: { ...initial.facts, openAsk: { text: 'Which format?', at: NOW - 150 * 60_000 } } });
    h.core.refresh(initial.id);
    h.discord.channels.set(HOME, [
      ...h.discord.channels.get(HOME)!,
      msg(-80, 'owner', 'the short one'), // 70 minutes later: still answering that question
      msg(-30, 'agent', 'Done: short format.'), // the agent's turn took 50 minutes
      msg(-20, 'owner', 'thanks'),
      msg(-5, 'agent', 'One more note on the report.'), // within the gap of the last message
    ]);
    await h.source.poll();
    const list = chapters();
    expect(list).toHaveLength(1);
    expect(list[0]!.messageCount).toBe(5);
  });

  it('a parked or cleared chapter waiting on the agent continues past the gap', async () => {
    for (const [type, expected] of [['park', 1], ['done', 1]] as const) {
      h.close();
      h = makeHarness();
      h.discord.channels.set(HOME, [msg(-150, 'owner', 'can you price the tires?')]);
      await h.source.poll();
      const id = chapters()[0]!.id;
      h.clock.now = NOW - 140 * 60_000; // set aside before the answer came
      await h.core.command({ commandId: cid(), type, itemId: id });
      h.clock.now = NOW;
      h.discord.push(HOME, msg(-60, 'agent', 'Tires are $180 each at Tire Depot, installed. Want me to book it?')); // 90 minutes later
      await h.source.poll();
      expect(chapters()).toHaveLength(expected);
      if (type === 'park') expect(item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
    }
  });

  it('a chapter parked after the agent said it would report back continues when the report comes', async () => {
    h.discord.channels.set(HOME, [msg(-150, 'owner', 'can you price the tires?'), msg(-149, 'agent', "On it, I'll report back.")]);
    await h.source.poll();
    const id = chapters()[0]!.id;
    h.clock.now = NOW - 140 * 60_000;
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.clock.now = NOW;
    h.discord.push(HOME, msg(-30, 'agent', 'Tires are $180 each at Tire Depot, installed.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(chapters()).toHaveLength(1);
    expect(item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
  });

  it('a new topic after the gap still starts a new chapter when nothing is waiting', async () => {
    h.discord.channels.set(HOME, [msg(-150, 'agent', 'Report filed.'), msg(-80, 'owner', 'new question about the budget')]);
    await h.source.poll();
    expect(chapters()).toHaveLength(2);
  });

  it('one item per thread under the home channel; threads elsewhere are ignored', async () => {
    h.discord.threads = [thread('7001'), { ...thread('7002', 'Other'), parent_id: '9999' }];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Pioneer or Sony?')]);
    h.discord.channels.set('7002', [msg(-5, 'agent', 'not ours')]);
    await h.source.poll();
    expect(h.core.items().map((entry) => entry.id)).toEqual(['discord:thread:7001']);
    expect(item('discord:thread:7001')).toMatchObject({ kind: 'thread', place: 'Speaker', threadId: '7001', conversationKey: 'thread:7001', nextStep: 'fyi', seen: 'updated' });
  });

  it('counts voice transcripts (zero-width space) and the 🖥️ screen relay echo as the owner', async () => {
    const voice = msg(-20, 'agent', '​[A screen is live] check the tire price');
    const relay = msg(-10, 'agent', '🖥️ go with the first one');
    h.discord.channels.set(HOME, [voice, relay]);
    await h.source.poll();
    const messages = h.core.store.messages(chapters()[0]!.id);
    expect(messages.map((message) => [message.author, message.text])).toEqual([
      ['owner', 'check the tire price'],
      ['owner', 'go with the first one'],
    ]);
  });

  it('reads an old wrapped relay (nested by a re-send) as just the owner\'s words; the owner-named webhook post counts as the owner', async () => {
    const nested = msg(-10, 'agent', '🖥️ The owner replied from the screen (re: "B"):\nThe owner replied from the screen (re: "A"):\nfull shake');
    const persona = msg(-5, 'agent', '🖥️ and egg whites', { webhook_id: '4242', author: { id: '4242', username: 'Owner', bot: true } });
    h.discord.channels.set(HOME, [nested, persona]);
    await h.source.poll();
    expect(h.core.store.messages(chapters()[0]!.id).map((message) => [message.author, message.text])).toEqual([
      ['owner', 'full shake'],
      ['owner', 'and egg whites'],
    ]);
  });

  it('ignores other people and bot system notices', async () => {
    h.discord.channels.set(HOME, [msg(-5, 'owner', 'hi', { author: { id: '222', username: 'guest' } }), msg(-4, 'agent', '⚙️ Background job started'), msg(-3, 'agent', 'pinned', { type: 6 })]);
    await h.source.poll();
    expect(h.core.items()).toEqual([]);
  });

  it('reads owner reactions: 👀 seen, ✅ done (no write-back), 💤 park; the bot\'s own never count', async () => {
    const eyes = msg(-50, 'agent', 'Report A.', { reactions: [{ count: 1, me: false, emoji: { id: null, name: '👀' } }] });
    const check = msg(-5, 'agent', 'Report B.', { reactions: [{ count: 1, me: false, emoji: { id: null, name: '✅' } }] });
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B'), thread('7003', 'C')];
    const zzz = msg(-5, 'agent', 'Report C.', { reactions: [{ count: 2, me: true, emoji: { id: null, name: '💤' } }] });
    const mine = msg(-6, 'agent', 'Report D.', { reactions: [{ count: 1, me: true, emoji: { id: null, name: '✅' } }] });
    h.discord.channels.set('7001', [eyes]);
    h.discord.channels.set('7002', [check]);
    h.discord.channels.set('7003', [zzz]);
    h.discord.channels.set(HOME, [mine]);
    for (const message of [eyes, check, zzz]) h.discord.reactionUsersBy.set(message.id, [OWNER]);
    await h.source.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(item('discord:thread:7002')).toMatchObject({ disposition: 'done', writeback: null });
    expect(item('discord:thread:7003').disposition).toBe('parked');
    expect(chapters()[0]!.disposition).toBe('active');
    expect(h.discord.reacted).toEqual([]);
    expect(h.discord.archived).toEqual([]);
  });
});

describe('commands', () => {
  beforeEach(async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Ordered the Pioneer.')]);
    await h.source.poll();
  });

  it('are idempotent: a replayed commandId returns the stored result and logs nothing new', async () => {
    const command = { commandId: 'same-1', type: 'park' as const, itemId: 'discord:thread:7001' };
    const first = await h.core.command(command);
    const events = h.core.store.eventsFor('discord:thread:7001').length;
    const second = await h.core.command(command);
    expect(second).toEqual(first);
    expect(first.status).toBe('applied');
    expect(h.core.store.eventsFor('discord:thread:7001')).toHaveLength(events);
  });

  it('viewed counts after 3 s; heard needs completed playback', async () => {
    const id = 'discord:thread:7001';
    expect(item(id).seen).toBe('updated'); // owner started it, then the agent answered
    expect((await h.core.command({ commandId: cid(), type: 'viewed', itemId: id, args: { ms: 1200 } })).outcome).toMatchObject({ counted: false });
    // Every answer on an item carries its attention time, for a screen's next guarded action (ifStateAt).
    expect(typeof (await h.core.command({ commandId: cid(), type: 'viewed', itemId: id, args: { ms: 1200 } })).outcome?.attentionAt).toBe('number');
    expect(item(id).seen).toBe('updated');
    expect(await h.core.command({ commandId: cid(), type: 'heard', itemId: id, args: {} })).toMatchObject({ status: 'failed', error: expect.stringContaining('playbackComplete') });
    expect(item(id).seen).toBe('updated');
    await h.core.command({ commandId: cid(), type: 'viewed', itemId: id, args: { ms: 3000 } });
    expect(item(id).seen).toBe('seen');
  });

  it('explicit seen mirrors 👀 and park mirrors 💤 to Discord', async () => {
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'seen', itemId: id });
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.discord.reacted.map((entry) => entry.split('/')[2])).toEqual(['👀', '💤']);
  });

  it('Mark read (seen via read) reads the thread without a 👀 at the source', async () => {
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'seen', itemId: id, args: { via: 'read' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(item(id).seen).toBe('seen');
    expect(h.discord.reacted).toEqual([]);
    const unread = await h.core.command({ commandId: cid(), type: 'unseen', itemId: id });
    expect(item(id).seen).toBe('new');
    await h.core.command({ commandId: cid(), type: 'undo', itemId: id, args: { seq: (unread as { outcome: { seq: number } }).outcome.seq } });
    expect(item(id).seen).toBe('seen');
    // A stale read or unread (the row as shown before something changed it) is refused, as Done and Snooze are.
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    expect(await h.core.command({ commandId: cid(), type: 'unseen', itemId: id, args: { ifStateAt: 1 } })).toMatchObject({ status: 'failed' });
    expect(await h.core.command({ commandId: cid(), type: 'seen', itemId: id, args: { via: 'read', ifStateAt: 1 } })).toMatchObject({ status: 'failed' });
  });

  it('done writes ✅ + archive for a thread and records the outcome', async () => {
    const result = await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    expect(result).toMatchObject({ status: 'applied', outcome: { writeback: { outcome: 'ok', steps: ['reacted', 'archived'] } } });
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'done', writeback: { outcome: 'ok' } });
  });

  it('done twice (a voice re-fire) is a no-op that keeps the good write-back', async () => {
    await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    h.discord.failArchive = true; // a second archive would fail: it must not be attempted
    const again = await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    expect(again).toMatchObject({ status: 'applied', outcome: { unchanged: true, writeback: { outcome: 'ok' } } });
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'done', writeback: { outcome: 'ok' } });
    h.discord.failArchive = false;
  });

  it('scenario 14: done whose archive fails is done locally, shows the failure, and retries', async () => {
    h.discord.failArchive = true;
    const result = await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    expect(result.status).toBe('applied');
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'done', writeback: { outcome: 'failed', error: expect.stringContaining('archive') } });
    expect(itemDetail(h.core, 'discord:thread:7001', [])!.timeline.filter((beat) => beat.kind === 'fail').at(-1)!.text).toContain('Write-back failed');
    h.discord.failArchive = false;
    const retry = await h.core.command({ commandId: cid(), type: 'retry', itemId: 'discord:thread:7001' });
    expect(retry).toMatchObject({ status: 'applied', outcome: { writeback: { outcome: 'ok' } } });
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'done', writeback: { outcome: 'ok' } });
  });

  it('done on a thread the owner already closed in Discord is ok, not a failed write-back', async () => {
    h.discord.archivedThreads.add('7001');
    const result = await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    expect(result).toMatchObject({ status: 'applied', outcome: { writeback: { outcome: 'ok', steps: ['already closed'] } } });
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'done', writeback: { outcome: 'ok' } });
    expect(h.discord.archived).toEqual([]);
    h.discord.archivedThreads.clear();
  });

  it('a chapter gets only the ✅ on Done', async () => {
    h.discord.channels.set(HOME, [msg(-5, 'agent', 'Report.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'done', itemId: chapters()[0]!.id });
    expect(h.discord.archived).toEqual([]);
    expect(h.discord.reacted).toHaveLength(1);
  });

  it('reply goes through the bot exactly like the inbox (channel = thread) and is applied once accepted', async () => {
    const result = await h.core.command({ commandId: 'reply-1', type: 'reply', itemId: 'discord:thread:7001', args: { text: 'Great, install it Saturday' }, actor: 'screen' });
    expect(result).toMatchObject({ status: 'applied', outcome: { delivered: true } });
    // The command id rides along to the bot's /screen/input (a repeat of it posts once), and so does the message answered.
    const answered = item('discord:thread:7001').lastAgentMessageId;
    expect(answered).toBeTruthy();
    expect(h.posted).toEqual([{ agentId: 'sierra', channelId: '7001', sceneTitle: 'Speaker', type: 'reply', replyToMessageId: answered, data: { text: 'Great, install it Saturday' }, commandId: 'reply-1' }]);
    expect(item('discord:thread:7001')).toMatchObject({ seen: 'seen', nextStep: 'working', nextStepBasis: 'owner:last-message' });
  });

  it.each(['reply', 'viewed', 'seen'] as const)('a failed acknowledgement cannot fail %s or lose its effect', async (type) => {
    Object.assign(h.source, { seen: async () => { throw new Error('Loom unavailable'); } });
    const command = { commandId: cid(), type, itemId: 'discord:thread:7001', args: { text: 'Continue', ms: 3000 } };
    const result = await h.core.command(command);
    expect(result.status).toBe('applied');
    expect(item(command.itemId).seen).toBe('seen');
    if (type === 'reply') {
      expect(result.outcome).toMatchObject({ delivered: true });
      await h.core.command(command);
      expect(h.posted).toHaveLength(1);
    }
    if (type === 'viewed') expect(result.outcome).toMatchObject({ counted: true });
  });

  it('scenario 13: a reply that fails at the source fails and leaves the item as it was', async () => {
    h.botResult.value = 'failed:bot HTTP 500';
    const before = item('discord:thread:7001');
    const result = await h.core.command({ commandId: cid(), type: 'reply', itemId: 'discord:thread:7001', args: { text: 'keep this draft' } });
    expect(result).toMatchObject({ status: 'failed', error: 'reply not delivered: bot HTTP 500' });
    expect(item('discord:thread:7001')).toMatchObject({ seen: before.seen, nextStep: before.nextStep, revision: before.revision });
  });

  it('a bot timeout is reported as "may have been delivered", not as a plain failure', async () => {
    h.botResult.value = 'unknown:The operation was aborted due to timeout';
    const before = item('discord:thread:7001');
    const result = await h.core.command({ commandId: cid(), type: 'reply', itemId: 'discord:thread:7001', args: { text: 'ship it' } });
    expect(result).toMatchObject({ status: 'failed', error: 'unknown — may have been delivered', outcome: { delivery: 'unknown' } });
    expect(item('discord:thread:7001')).toMatchObject({ seen: before.seen, revision: before.revision });
  });

  it('a second call with the same commandId while the first is in flight awaits the same outcome', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const posted = h.posted.length;
    const original = (h.source as unknown as { options: { postToBot: (body: Record<string, unknown>) => Promise<string> } }).options;
    const postToBot = original.postToBot;
    original.postToBot = async (body) => {
      await gate;
      return postToBot(body);
    };
    const first = h.core.command({ commandId: 'same-id', type: 'reply', itemId: 'discord:thread:7001', args: { text: 'once' } });
    const second = h.core.command({ commandId: 'same-id', type: 'reply', itemId: 'discord:thread:7001', args: { text: 'once' } });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.status).toBe('applied');
    expect(h.posted.length - posted).toBe(1);
    original.postToBot = postToBot;
  });

  it('on start, commands left accepted for more than 60 s are failed as interrupted', () => {
    h.core.store.insertCommand({ commandId: 'stuck', type: 'reply', itemId: 'discord:thread:7001' });
    h.core.store.insertCommand({ commandId: 'fresh', type: 'reply', itemId: 'discord:thread:7001' });
    h.core.store.db.prepare("UPDATE desk_commands SET created_at = ? WHERE command_id = 'stuck'").run(h.clock.now - 61_000);
    expect(h.core.recoverCommands()).toBe(1);
    expect(h.core.store.command('stuck')).toMatchObject({ status: 'failed', error: 'interrupted', outcome: { error: 'interrupted' } });
    expect(h.core.store.command('fresh')).toMatchObject({ status: 'accepted' });
  });

  it('answer posts the option text as a reply', async () => {
    await h.core.command({ commandId: cid(), type: 'answer', itemId: 'discord:thread:7001', args: { option: 'The Pioneer' } });
    expect(h.posted.at(-1)).toMatchObject({ type: 'reply', data: { text: 'The Pioneer' } });
  });

  it('putting a thread away (done, park, snooze) reads it; undo takes the read back; a rule\'s snooze, the source or an agent does not read it', async () => {
    const id = 'discord:thread:7001';
    for (const command of [{ type: 'done' }, { type: 'park' }, { type: 'snooze', args: { until: NOW + 3_600_000 } }] as const) {
      expect(item(id).seen).toBe('updated');
      const put = await h.core.command({ commandId: cid(), itemId: id, ...command });
      expect(item(id)).toMatchObject({ disposition: command.type === 'done' ? 'done' : command.type === 'park' ? 'parked' : 'snoozed', seen: 'seen' });
      await h.core.command({ commandId: cid(), type: 'undo', itemId: id, args: { seq: put.outcome!.seq } });
      expect(item(id)).toMatchObject({ disposition: 'active', seen: 'updated' });
    }
    h.core.store.appendEvent({ itemId: id, type: 'snooze', actor: 'system', payload: { until: NOW + 3_600_000 }, at: NOW });
    expect(h.core.rebuildAttention(id)).toMatchObject({ disposition: 'snoozed', seen: 'updated' });
    // Settled at the source (T3 finished it) or put away by an agent: still unread.
    h.core.store.appendEvent({ itemId: id, type: 'source.done', actor: 'source', payload: {}, at: NOW });
    expect(h.core.rebuildAttention(id)).toMatchObject({ disposition: 'done', seen: 'updated' });
    h.core.store.appendEvent({ itemId: id, type: 'park', actor: 'agent', payload: {}, at: NOW });
    expect(h.core.rebuildAttention(id)).toMatchObject({ disposition: 'parked', seen: 'updated' });
  });

  it('reads the threads the owner put away before Done/Park/Snooze read them, once, at start', async () => {
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.core.store.saveAttention({ ...h.core.store.attention(id)!, seen: 'updated' }); // as a park filed before 10/17 left it
    h.core.start();
    expect(item(id)).toMatchObject({ disposition: 'parked', seen: 'seen' });
    h.core.store.saveAttention({ ...h.core.store.attention(id)!, seen: 'updated' });
    h.core.start();
    expect(item(id).seen).toBe('updated');
  });

  it('undo reverts an attention event and only attention events', async () => {
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'seen', itemId: id });
    const done = await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    const seq = done.outcome!.seq as number;
    const undo = await h.core.command({ commandId: cid(), type: 'undo', itemId: id, args: { seq } });
    expect(undo.status).toBe('applied');
    expect(item(id)).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect((await h.core.command({ commandId: cid(), type: 'undo', args: { seq } })).error).toBe('already undone');
    const writeback = h.core.store.eventsFor(id).find((event) => event.type === 'writeback')!;
    expect((await h.core.command({ commandId: cid(), type: 'undo', args: { seq: writeback.seq } })).error).toContain('cannot be undone');
    const feed = activityFeed(h.core);
    expect(feed.find((event) => event.seq === seq)).toMatchObject({ undone: true, undoable: false });
    // The projection equals a full replay.
    expect(h.core.rebuildAttention(id)).toMatchObject({ disposition: 'active', seen: 'seen' });
  });

  it('snooze validates its arguments', async () => {
    const id = 'discord:thread:7001';
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: {} })).status).toBe('failed');
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { until: new Date(NOW - 1000).toISOString() } })).status).toBe('failed');
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'desk' } })).status).toBe('applied');
  });

  it('a re-time (onlyIfSnoozed) applies only while the item is still snoozed', async () => {
    const id = 'discord:thread:7001';
    const later = { until: new Date(NOW + 3_600_000).toISOString(), onlyIfSnoozed: true };
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: later })).status).toBe('failed');
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'agent_posts' } })).status).toBe('applied');
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: later })).status).toBe('applied');
    expect(h.core.attention(id)).toMatchObject({ disposition: 'snoozed', snoozeTrigger: null });
  });

  it('an action on a snoozed row (ifStateAt) applies only while the item is as the row showed it', async () => {
    const id = 'discord:thread:7001';
    const shown = () => listItems(h.core, { view: 'snoozed' }).items.find((item) => item.id === id)!.attentionUpdatedAt;
    const later = { until: new Date(NOW + 3_600_000).toISOString() };
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'agent_posts' } });
    const a = shown();
    // Another screen changes the snooze: a picker opened on the first one can't overwrite it, or park it.
    h.clock.now = NOW + 1000;
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'desk' } });
    expect(await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { ...later, ifStateAt: a } })).toMatchObject({ status: 'failed', outcome: { changed: true, disposition: 'snoozed' } });
    expect(await h.core.command({ commandId: cid(), type: 'park', itemId: id, args: { ifStateAt: a } })).toMatchObject({ status: 'failed' });
    expect(h.core.attention(id)).toMatchObject({ disposition: 'snoozed', snoozeTrigger: 'desk' });
    // As shown now: it applies.
    const b = shown();
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { ...later, ifStateAt: b } })).status).toBe('applied');
    const c = shown();
    // Done elsewhere: Back to Active from the stale row doesn't reopen it, and a second Done is refused too.
    h.clock.now = NOW + 2000;
    await h.core.command({ commandId: cid(), type: 'done', itemId: id, args: {} });
    expect(await h.core.command({ commandId: cid(), type: 'pickup', itemId: id, args: { ifStateAt: c } })).toMatchObject({ status: 'failed', outcome: { disposition: 'done' } });
    expect(h.core.attention(id)).toMatchObject({ disposition: 'done' });
  });

  it('a one-tap snooze (onlyIfActive) applies once: a second screen tapping the same card is refused', async () => {
    const id = 'discord:thread:7001';
    const tap = { trigger: 'agent_posts', onlyIfActive: true };
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: tap })).status).toBe('applied');
    expect(await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: tap })).toMatchObject({ status: 'failed', outcome: { active: false } });
  });

  it('a notification snooze cannot reopen a done item', async () => {
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    expect(await h.core.command({ commandId: cid(), type: 'snooze', itemId: id,
      args: { until: new Date(NOW + 3_600_000).toISOString(), onlyIfActive: true } }))
      .toMatchObject({ status: 'failed', outcome: { active: false } });
    expect(h.core.attention(id)).toMatchObject({ disposition: 'done' });
  });

  it('a re-time bound to a snooze (snoozeSeq) is refused once a newer snooze replaced it', async () => {
    const id = 'discord:thread:7001';
    const first = await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'agent_posts' } });
    const firstSeq = (first.outcome as { seq: number }).seq;
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'desk' } });
    const later = { until: new Date(NOW + 3_600_000).toISOString(), onlyIfSnoozed: true };
    expect(await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { ...later, snoozeSeq: firstSeq } })).toMatchObject({ status: 'failed', outcome: { snoozed: true, replaced: true } });
    expect(h.core.attention(id)).toMatchObject({ disposition: 'snoozed', snoozeTrigger: 'desk' });
    const current = ((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { trigger: 'agent_posts' } })).outcome as { seq: number }).seq;
    expect((await h.core.command({ commandId: cid(), type: 'snooze', itemId: id, args: { ...later, snoozeSeq: current } })).status).toBe('applied');
  });
});

describe('scenario 5: stale poll after Done', () => {
  it('words posted before the decision never reopen it; any later message does, regardless of wording', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    // Discord already has a later message the poll hasn't read yet.
    h.discord.push('7001', msg(-5, 'agent', 'One more detail: it ships Friday and needs a signature on delivery, which I flagged.'));
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    await h.source.poll();
    expect(item(id).disposition).toBe('done');
    h.clock.now = NOW + 60_000;
    h.discord.push('7001', msg(2, 'agent', "You're welcome!"));
    await h.source.poll();
    expect(item(id).disposition).toBe('active');
    h.discord.push('7001', msg(3, 'agent', 'Bad news: the order was cancelled by the seller. Want me to find another listing?'));
    await h.source.poll();
    expect(item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
  });

  it.each(['done', 'park'] as const)('a short plain message reopens a %s item without consulting the summary', async (type) => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type, itemId: id });
    h.clock.now = NOW + 60_000;
    h.summarizer.impl = async () => ({ gist: 'Signing off.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: true, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(2, 'agent', 'Glad that worked out for you.'));
    await h.source.poll();
    expect(item(id).disposition).toBe('active');
    await h.core.drainSummaries();
    expect(item(id).disposition).toBe('active');
    h.summarizer.impl = async () => ({ gist: 'Part arrived.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(3, 'agent', 'The part arrived today.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
  });

  it.each(['done', 'park'] as const)('an image with no words reopens a %s item', async (type) => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type, itemId: id });
    h.clock.now = NOW + 60_000;
    let seen: string[] = [];
    h.summarizer.impl = async (input) => {
      seen = input.messages.map((m: { text: string }) => m.text);
      return { gist: 'Sent the chart.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' };
    };
    h.discord.push('7001', msg(2, 'agent', '', { attachments: [{ id: 'a1', filename: 'chart.png', content_type: 'image/png', url: 'https://cdn.example/chart.png' }] } as never));
    await h.source.poll();
    expect(item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
    await h.core.drainSummaries();
    expect(seen.at(-1)).toBe('[image: chart.png]');
  });

  it('a short update still waiting on the summary is not lost to a later ack', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.clock.now = NOW + 60_000;
    h.summarizer.impl = async () => ({ gist: 'Signing off.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: true, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(2, 'agent', 'The part arrived today.'));
    await h.source.poll();
    expect(item(id).disposition).toBe('active');
    h.discord.push('7001', msg(3, 'agent', "You're welcome!"));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(item(id)).toMatchObject({ disposition: 'active', seen: 'new' });
  });

  it('keeps the news for the List when an acknowledgment follows it before the summary', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    const id = 'discord:thread:7001';
    h.clock.now = NOW + 60_000;
    h.discord.push('7001', msg(2, 'agent', 'The part arrived today.'));
    h.discord.push('7001', msg(3, 'agent', "You're welcome!"));
    await h.source.poll();
    expect(item(id).facts.lastAgentWords).toMatchObject({ text: 'The part arrived today.' });
  });

  it('hearing a new post clears unread and keeps its recorded active placement', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.clock.now = NOW + 60_000;
    h.summarizer.impl = async () => ({ gist: 'Part arrived.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(0.5, 'agent', 'The part arrived today.'));
    await h.source.poll();
    h.clock.now = NOW + 120_000;
    await h.core.command({ commandId: cid(), type: 'heard', itemId: id, args: { playbackComplete: true } });
    await h.core.drainSummaries();
    expect(item(id).disposition).toBe('active');
  });

  it('hearing a post and receiving another post keeps the row active', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.clock.now = NOW + 60_000;
    h.summarizer.impl = async () => ({ gist: 'Signing off.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: true, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(0.5, 'agent', 'The part arrived today.'));
    await h.source.poll();
    h.clock.now = NOW + 120_000;
    await h.core.command({ commandId: cid(), type: 'heard', itemId: id, args: { playbackComplete: true } });
    h.clock.now = NOW + 180_000;
    h.discord.push('7001', msg(3, 'agent', "You're welcome!"));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(item(id).disposition).toBe('active');
  });

  it('a deferred reopen still applies the quiet rule', async () => {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const other = days[(new Date(NOW).getDay() + 3) % 7]!;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rules-')), 'rules.yaml');
    fs.writeFileSync(file, ['rules:', '  - name: parts', '    match: { text: "part arrived" }', `    quiet_until: ${other}`].join('\n'));
    h.close();
    h = makeHarness({ rules: new InboxRules(file, () => NOW) });
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.clock.now = NOW + 60_000;
    h.summarizer.impl = async () => ({ gist: 'Part arrived.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(2, 'agent', 'The part arrived today.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(item(id).disposition).toBe('snoozed');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('a summary cannot undo the owner marking a newly active row Done', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.clock.now = NOW + 60_000;
    h.summarizer.impl = async () => ({ gist: 'Part arrived.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' });
    h.discord.push('7001', msg(2, 'agent', 'The part arrived today.'));
    await h.source.poll();
    expect(item(id).disposition).toBe('active');
    h.clock.now = NOW + 120_000;
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    await h.core.drainSummaries();
    expect(item(id).disposition).toBe('done');
    expect(h.core.store.marker(`deferred:${id}`)).toBeNull();
  });
});

describe('summaries', () => {
  it('a summary cannot reopen an owner move or unread dot, and a stale summary is dropped', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'I found a couple of options for you.')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.command({ commandId: cid(), type: 'seen', itemId: id });
    let release!: () => void;
    h.summarizer.impl = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { gist: 'Two picks; wants a choice.', step: 'your_move', ask: 'Pioneer or Sony?', options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' };
    };
    const pending = h.core.summarizeNow(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await pending;
    expect(item(id)).toMatchObject({ nextStep: 'fyi', ask: null, seen: 'seen' });

    // New words land while the model thinks: its result is dropped.
    const stalePending = (async () => {
      const run = h.core.summarizeNow(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.discord.push('7001', msg(1, 'agent', 'Never mind, I ordered the Pioneer.'));
      h.clock.now = NOW + 2 * 60_000;
      await h.source.poll();
      release();
      await run;
    })();
    await stalePending;
    expect(item(id).summary!.gist).toBe('Two picks; wants a choice.'); // the stale result was not written
    expect(item(id).nextStep).toBe('fyi'); // the old summary no longer decides; the fallback does
  });

  it('hands the summarizer the previous summary, so a decision older than the last six messages carries forward', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Brand K or Pioneer?')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    const seen: unknown[] = [];
    h.summarizer.impl = async (input) => {
      seen.push(input.previous ?? null);
      return fallbackSummary(input);
    };
    await h.core.summarizeNow(id);
    h.discord.push('7001', msg(1, 'agent', 'The VIN is 1ABC.'));
    h.clock.now = NOW + 2 * 60_000;
    await h.source.poll();
    await h.core.summarizeNow(id);
    expect(seen[0]).toBeNull();
    expect(item(id).summary!.version).toBe(0); // a text fallback is asked of the model again on the next start
    // A text fallback never posts, so the owner has heard nothing yet; its words still carry forward.
    expect(seen[1]).toEqual({ step: 'your_move', gist: 'Brand K or Pioneer?', ask: 'Brand K or Pioneer?', goal: null, milestone: null, questions: [{ q: 'Brand K or Pioneer?', lean: null }], heard: null });
  });

  it('drops carried questions once the owner has written since (live 10/09: a moved-past question stayed on the card)', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Brand K or Pioneer?')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    const seen: Array<{ questions?: unknown } | null> = [];
    h.summarizer.impl = async (input) => {
      seen.push((input.previous as { questions?: unknown } | null) ?? null);
      return fallbackSummary(input);
    };
    await h.core.summarizeNow(id);
    h.clock.now = NOW + 2 * 60_000;
    h.discord.push('7001', msg(1, 'owner', 'Actually, look into the dash kit first.'));
    h.discord.push('7001', msg(2, 'agent', 'The Maestro kit fits both.'));
    await h.source.poll();
    await h.core.summarizeNow(id);
    expect(seen[1]).toMatchObject({ questions: [], ask: null, ownerReplied: true });
  });

  it('an owner reply filed late with an older timestamp still counts as replied (Codex review on #443)', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Brand K or Pioneer?')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    const seen: Array<{ questions?: unknown; ownerReplied?: boolean } | null> = [];
    h.summarizer.impl = async (input) => {
      seen.push((input.previous as { questions?: unknown; ownerReplied?: boolean } | null) ?? null);
      return fallbackSummary(input);
    };
    await h.core.summarizeNow(id);
    h.clock.now = NOW + 5 * 60_000;
    // The owner's reply was written before the summary but only polled now, together with a new agent message.
    h.discord.push('7001', msg(-4, 'owner', 'Pioneer, please.'));
    h.discord.push('7001', msg(4, 'agent', 'Ordering the Pioneer.'));
    await h.source.poll();
    await h.core.summarizeNow(id);
    expect(seen.at(-1)).toMatchObject({ ownerReplied: true, questions: [] });
  });

  it('sends every message since the previous summary, past the last six, so a settled decision is seen', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-30, 'owner', 'Find a speaker'), msg(-25, 'agent', 'Brand K or Pioneer?')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    await h.core.summarizeNow(id);
    h.discord.push('7001', msg(1, 'owner', 'Pioneer.'));
    for (let i = 2; i < 10; i += 1) h.discord.push('7001', msg(i, 'agent', `Progress note ${i}.`));
    h.clock.now = NOW + 12 * 60_000;
    await h.source.poll();
    let sent: string[] = [];
    h.summarizer.impl = async (input) => {
      sent = input.messages.map((message) => message.text);
      return fallbackSummary(input);
    };
    await h.core.summarizeNow(id);
    expect(sent[0]).toBe('Pioneer.');
    expect(sent).toHaveLength(9);
  });

  it('a new prompt version re-summarizes on start everything not Done, snoozed and parked included', async () => {
    const h2 = makeHarness({ summaryDelayMs: 0 });
    try {
      h2.discord.threads = [thread('7001'), thread('7002'), thread('7003')];
      for (const id of ['7001', '7002', '7003']) h2.discord.channels.set(id, [msg(-10, 'owner', 'Look into it'), msg(-5, 'agent', 'Here is what I found.')]);
      await h2.source.poll();
      const ids = ['7001', '7002', '7003'].map((id) => `discord:thread:${id}`);
      await Promise.all(ids.map((id) => h2.core.summarizeNow(id)));
      for (const id of ids) h2.core.store.patchItem(id, { summary: { ...h2.core.item(id)!.summary!, version: 0 } });
      await h2.core.command({ commandId: cid(), type: 'park', itemId: ids[1]! });
      await h2.core.command({ commandId: cid(), type: 'done', itemId: ids[2]! });
      const summarized: string[] = [];
      h2.summarizer.impl = async (input) => {
        summarized.push(input.messages.at(-1)!.text);
        return { ...fallbackSummary(input), source: 'model' };
      };
      h2.core.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(summarized).toHaveLength(2);
      expect(h2.core.item(ids[1]!)!.summary!.version).toBe(SUMMARY_VERSION);
      expect(h2.core.item(ids[2]!)!.summary!.version).toBe(0);
    } finally {
      h2.close();
    }
  });
});

describe('timers', () => {
  it('new chapters quietly supersede older ones; the latest never settles on idle', async () => {
    h.discord.channels.set(HOME, [msg(-100, 'agent', 'FYI the gym is closed today.'), msg(-5, 'agent', 'Should I book the 6 pm class instead?')]);
    await h.source.poll();
    h.clock.now = NOW + 31 * 60_000;
    const [quiet, asking] = chapters();
    h.core.store.patchItem(asking!.id, { facts: { ...asking!.facts, openAsk: { text: 'Book the class?', at: NOW - 5 * 60_000 } } });
    h.core.refresh(asking!.id);
    const result = h.core.tick();
    expect(result.settled).toEqual([]);
    expect(quiet!.id && item(quiet!.id).disposition).toBe('done');
    expect(item(asking!.id)).toMatchObject({ disposition: 'active', nextStep: 'your_move' });
    expect(h.core.store.eventsFor(quiet!.id).some(event => event.type === 'chapter.superseded')).toBe(true);
    expect(h.discord.reacted).toEqual([]);
  });

  it('time, desk and agent_posts snoozes each come back as New, tagged back from snooze', async () => {
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B'), thread('7003', 'C')];
    for (const id of ['7001', '7002', '7003']) h.discord.channels.set(id, [msg(-5, 'agent', `Update ${id}.`)]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: 'discord:thread:7001', args: { until: new Date(NOW + 3_600_000).toISOString() } });
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: 'discord:thread:7002', args: { trigger: 'desk' } });
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: 'discord:thread:7003', args: { trigger: 'agent_posts' } });
    h.clock.now = NOW + 30 * 60_000;
    h.core.tick();
    expect(item('discord:thread:7001').disposition).toBe('snoozed');
    h.clock.now = NOW + 61 * 60_000;
    expect(h.core.tick().expired).toContain('discord:thread:7001');
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: true });
    h.core.noteScreenActivity(); // first screen after ≥ 10 min idle
    expect(item('discord:thread:7002')).toMatchObject({ disposition: 'active', backFromSnooze: true });
    h.discord.push('7003', msg(62, 'agent', 'Price dropped.'));
    await h.source.poll();
    expect(item('discord:thread:7003')).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: true });
  });

  it('the weekly sweep collects parked items and ones untouched for a week; keep and drop', async () => {
    const saturday = new Date(2026, 9, 10, 7, 30).getTime();
    h.clock.now = saturday - 10 * 86_400_000;
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B'), thread('7003', 'C')];
    for (const id of ['7001', '7002', '7003']) h.discord.channels.set(id, [msg((h.clock.now - NOW) / 60_000 - 1, 'agent', `Update ${id}.`)]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'park', itemId: 'discord:thread:7001' });
    h.core.tick(); // first start: remembers the last sweep time, sweeps nothing
    h.clock.now = saturday - 86_400_000;
    await h.core.command({ commandId: cid(), type: 'seen', itemId: 'discord:thread:7003' }); // touched recently
    h.clock.now = saturday;
    const { sweep } = h.core.tick();
    expect(sweep!.sort()).toEqual(['discord:thread:7001', 'discord:thread:7002']);
    expect(listItems(h.core).sweep).toMatchObject({ day: 'saturday' });
    expect(listItems(h.core).sweep!.items.map((entry) => entry.id).sort()).toEqual(['discord:thread:7001', 'discord:thread:7002']);
    await h.core.command({ commandId: cid(), type: 'sweep', itemId: 'discord:thread:7001', args: { decision: 'keep' } });
    const drop = await h.core.command({ commandId: cid(), type: 'sweep', itemId: 'discord:thread:7002', args: { decision: 'drop' } });
    expect(item('discord:thread:7001')).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(item('discord:thread:7002').disposition).toBe('done');
    expect(drop.outcome!.writeback).toMatchObject({ outcome: 'ok' });
    expect(h.core.pendingSweep()).toBeNull();
    expect(h.core.tick().sweep).toBeNull(); // once per sweep time
  });

  it('a plain Done or Pick up answers the sweep too', async () => {
    const saturday = new Date(2026, 9, 10, 7, 30).getTime();
    h.clock.now = saturday - 10 * 86_400_000;
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B'), thread('7003', 'C')];
    for (const id of ['7001', '7002', '7003']) h.discord.channels.set(id, [msg((h.clock.now - NOW) / 60_000 - 1, 'agent', `Update ${id}.`)]);
    await h.source.poll();
    for (const id of ['7001', '7002', '7003']) await h.core.command({ commandId: cid(), type: 'park', itemId: `discord:thread:${id}` });
    h.core.tick();
    h.clock.now = saturday;
    expect(h.core.tick().sweep!.sort()).toEqual(['discord:thread:7001', 'discord:thread:7002', 'discord:thread:7003']);
    await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: 'discord:thread:7002' });
    expect(h.core.pendingSweep()!.itemIds).toEqual(['discord:thread:7003']);
  });

  it('honors the monday sweep setting', () => {
    h.core.store.setSetting('sweep_day', 'monday');
    expect(h.core.sweepDay()).toBe('monday');
  });
});

describe('bot turn events and background jobs', () => {
  it('turn.started → working, turn.failed → failed (new), retry re-sends the last owner request', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-60, 'agent', 'Ready when you are.'), msg(-1, 'owner', 'Re-run the price check')]);
    await h.source.poll();
    const id = 'discord:thread:7001';
    h.clock.now = NOW + 25 * 60_000; // the owner's last word alone no longer means working
    h.core.tick();
    expect(item(id).nextStep).not.toBe('working');
    h.core.agentEvent({ type: 'turn.started', agentId: 'sierra', conversationKey: 'thread:7001', channelId: '7001', threadId: '7001', turnId: 't1', at: h.clock.now });
    expect(item(id)).toMatchObject({ nextStep: 'working', nextStepBasis: 'source:running' });
    h.core.agentEvent({ type: 'turn.activity', agentId: 'sierra', conversationKey: 'thread:7001', channelId: '7001', turnId: 't1', at: h.clock.now, activity: 'Running price-check.ts' });
    expect(item(id).activity).toMatchObject({ text: 'Running price-check.ts' });
    await h.core.command({ commandId: cid(), type: 'seen', itemId: id });
    h.core.agentEvent({ type: 'turn.failed', agentId: 'sierra', conversationKey: 'thread:7001', channelId: '7001', turnId: 't1', at: h.clock.now, error: { reason: 'timeout', message: 'Turn timed out after 10 minutes' } });
    expect(item(id)).toMatchObject({ nextStep: 'failed', ask: 'Turn timed out after 10 minutes', seen: 'new', disposition: 'active' });
    const retry = await h.core.command({ commandId: cid(), type: 'retry', itemId: id });
    expect(retry.status).toBe('applied');
    expect(h.posted.at(-1)).toMatchObject({ channelId: '7001', data: { text: 'Re-run the price check' } });
    expect(item(id).nextStep).toBe('working');
  });

  it('a home-channel turn belongs to the latest chapter, and a new chapter takes over the live turn', async () => {
    h.discord.channels.set(HOME, [msg(-90, 'agent', 'Old news.')]);
    await h.source.poll();
    h.core.agentEvent({ type: 'turn.started', agentId: 'sierra', conversationKey: `channel:${HOME}`, channelId: HOME, turnId: 't9', at: NOW });
    expect(chapters()[0]!.nextStep).toBe('working');
    h.discord.push(HOME, msg(0, 'owner', 'What is on today?'));
    await h.source.poll();
    const [old, fresh] = chapters();
    expect(fresh!.nextStep).toBe('working');
    expect(old!.facts.running).toBeNull();
  });

  it('the reply that started a turn, read after the turn did, stays in the chapter that was waiting on it', async () => {
    h.discord.channels.set(HOME, [msg(-150, 'agent', 'Three charges are booked. Move the remaining amount from savings?')]);
    await h.source.poll();
    const waiting = chapters()[0]!;
    h.core.store.patchItem(waiting.id, { facts: { ...waiting.facts, openAsk: { text: 'Approve?', at: NOW - 150 * 60_000 } }, summary: { ...fallbackSummary({ agentName: 'Sierra', place: null, messages: [] }), step: 'your_move', contentKey: waiting.facts.contentKey ?? '', at: NOW } as never });
    h.core.agentEvent({ type: 'turn.started', agentId: 'sierra', conversationKey: `channel:${HOME}`, channelId: HOME, turnId: 't10', at: NOW });
    expect(chapters()[0]!.nextStep).toBe('your_move');
    h.discord.push(HOME, msg(0, 'owner', 'approve it'));
    await h.source.poll();
    expect(chapters()).toHaveLength(1);
    expect(chapters()[0]!.messageCount).toBe(2);
  });

  it('a running background job makes its thread Working; Done then needs stopJob, and true cancels it', async () => {
    const cancelled: string[] = [];
    h.close();
    h = makeHarness({ cancelJob: async (job) => void cancelled.push(`${job.agentId}/${job.id}`) });
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'Started the render; I will report back.')]);
    await h.source.poll();
    const jobsDir = path.join(h.dir, 'jobs');
    const writeJob = (id: string, job: Record<string, unknown>) => {
      fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
      fs.writeFileSync(path.join(jobsDir, id, 'job.json'), JSON.stringify({ id, agentId: 'sierra', channelId: HOME, threadId: '7001', ...job }));
    };
    writeJob('job-1', { label: 'Render the ride video', startedAt: new Date(NOW).toISOString(), timeoutSeconds: 3600, status: 'running' });
    writeJob('job-2', { status: 'notified' });
    const jobs = new DeskJobsSource({ core: h.core, dir: jobsDir });
    expect(await jobs.poll()).toBe(1);
    const id = 'discord:thread:7001';
    expect(item(id)).toMatchObject({ nextStep: 'working', watching: null });
    const refused = await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    expect(refused).toMatchObject({ status: 'failed', error: expect.stringContaining('stopJob') });
    expect(item(id).disposition).toBe('active');
    const done = await h.core.command({ commandId: cid(), type: 'done', itemId: id, args: { stopJob: true } });
    expect(done.outcome).toMatchObject({ job: { id: 'job-1', stopped: true } });
    expect(cancelled).toEqual(['sierra/job-1']);
    expect(item(id)).toMatchObject({ disposition: 'done', facts: { job: null } });
  });
});

describe('read API', () => {
  it('groups the active view into sections in order, New/Updated first, then most recent', async () => {
    h.discord.threads = [thread('7001', 'Q1'), thread('7002', 'Info'), thread('7003', 'Q2')];
    h.discord.channels.set('7001', [msg(-30, 'agent', 'Which color?')]);
    h.discord.channels.set('7002', [msg(-20, 'agent', 'Weekly numbers are in.')]);
    h.discord.channels.set('7003', [msg(-10, 'agent', 'Which size?')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'seen', itemId: 'discord:thread:7003' });
    for (const sourceId of ['7001', '7003']) {
      const row = item(`discord:thread:${sourceId}`);
      h.core.store.patchItem(row.id, { facts: { ...row.facts, openAsk: { text: 'Choose?', at: NOW - 60_000 } } });
      h.core.refresh(row.id);
    }
    const list = listItems(h.core, { view: 'active', group: 'step' });
    expect(list.sections.map((section) => [section.key, section.itemIds])).toEqual([
      ['your_move', ['discord:thread:7001', 'discord:thread:7003']],
      ['fyi', ['discord:thread:7002']],
    ]);
    expect(list.counts).toMatchObject({ active: 3, new: 2, your_move: 2, fyi: 1 });
    expect(listItems(h.core, { group: 'seen' }).sections.map((section) => section.key)).toEqual(['new', 'seen']);
    // The catch-up reads the Inbox's Needs you (10/17): the unread question, not the question the owner already
    // read (Ready). The unread update the agent finished on is an FYI, batched (owner, 10/18).
    const brief = briefing(h.core);
    expect(brief.yourMove.map((entry) => entry.id)).toEqual(['discord:thread:7001', 'discord:thread:7003']);
    expect(brief.fyi.map((entry) => entry.itemIds)).toEqual([['discord:thread:7002']]);
    // Renamed on the desk: voice hears (and can match) the owner's name, not the source's.
    await h.core.command({ commandId: 'rename-7001', type: 'rename', itemId: 'discord:thread:7001', args: { title: 'Speaker pick' } });
    expect(briefing(h.core).yourMove.find((entry) => entry.id === 'discord:thread:7001')?.place).toBe('Speaker pick');
    expect(nextUpQueue(h.core).find((entry) => entry.id === 'discord:thread:7001')?.place).toBe('Speaker pick');
  });

  it('the old /api/inbox routes are served from the desk with the old shapes', async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'Pioneer or Sony?')]);
    await h.source.poll();
    const row = item('discord:thread:7001');
    h.core.store.patchItem(row.id, { facts: { ...row.facts, openAsk: { text: 'Pioneer or Sony?', at: NOW - 5 * 60_000 } } });
    h.core.refresh(row.id);
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const app = createApp({
      store: scenes,
      hub,
      publicDir: h.dir,
      desk: {
        routes: { core: h.core, scenes: () => hub.liveScenes() },
        compat: { core: h.core, hub, rules: null, pollSources: () => h.source.poll() },
      },
    });
    const list = (await (await app.request('/api/inbox?filter=open')).json()) as { items: Array<Record<string, unknown>> };
    expect(list.items[0]).toMatchObject({ id: 'discord:thread:7001', kind: 'thread', status: 'needs_you', state: 'queued', acked: false, channelId: '7001', place: 'Speaker' });
    // Old ids still resolve.
    expect(((await (await app.request('/api/inbox/thread:7001')).json()) as { messages: unknown[] }).messages).toHaveLength(1);
    await app.request('/api/inbox/thread:7001/react', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: '👍' }) });
    expect(item('discord:thread:7001').seen).toBe('seen');
    const done = (await (await app.request('/api/inbox/discord:thread:7001/done', { method: 'POST', body: '{}' })).json()) as Record<string, unknown>;
    expect(done).toMatchObject({ state: 'read', reacted: true, archived: true });
    // The new API, with an idempotent command.
    const body = JSON.stringify({ commandId: 'http-1', type: 'reopen', itemId: 'discord:thread:7001' });
    const json = { 'Content-Type': 'application/json' };
    const first = await (await app.request('/api/desk/commands', { method: 'POST', headers: json, body })).json();
    const again = await (await app.request('/api/desk/commands', { method: 'POST', headers: json, body })).json();
    expect(again).toEqual(first);
    const items = (await (await app.request('/api/desk/items?view=active')).json()) as { items: Array<{ id: string }> };
    expect(items.items.map((entry) => entry.id)).toEqual(['discord:thread:7001']);
    // Agent events: local callers only.
    const event = { type: 'turn.started', agentId: 'sierra', conversationKey: 'thread:7001', channelId: HOME, turnId: 't', at: NOW };
    expect((await app.request('/api/desk/agent-events', { method: 'POST', headers: { ...json, 'Tailscale-User-Login': 'someone@example.com' }, body: JSON.stringify(event) })).status).toBe(403);
    expect(await (await app.request('/api/desk/agent-events', { method: 'POST', headers: json, body: JSON.stringify(event) })).json()).toEqual({ itemId: 'discord:thread:7001' });
  });
});

describe('migration from the old inbox', () => {
  it('imports later → parked, done → done, acked → seen, once', async () => {
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B')];
    const chat = msg(-30, 'agent', 'Daily summary.');
    h.discord.channels.set('7001', [msg(-40, 'agent', 'A.')]);
    h.discord.channels.set('7002', [msg(-40, 'agent', 'B.')]);
    h.discord.channels.set(HOME, [chat]);
    const old = new InboxStore(h.db, () => NOW);
    old.create({ id: 'thread:7001', kind: 'thread', agentId: 'sierra', agentName: 'Sierra', state: 'later' });
    old.create({ id: 'thread:7002', kind: 'thread', agentId: 'sierra', agentName: 'Sierra' });
    old.ack('thread:7002');
    old.create({ id: `topic:${HOME}:${chat.id}`, kind: 'topic', agentId: 'sierra', agentName: 'Sierra', lastAgentMessageId: chat.id });
    old.mark(`topic:${HOME}:${chat.id}`, 'read', 'done');
    old.create({ id: 'thread:gone', kind: 'thread', agentId: 'sierra', agentName: 'Sierra', state: 'dismissed' });
    expect(migrateInboxDecisions(h.core)).toMatchObject({ skipped: false, parked: 0, done: 0 }); // nothing read yet: retried later
    await h.source.poll();
    expect(migrateInboxDecisions(h.core)).toEqual({ skipped: false, parked: 1, done: 1, seen: 1, unmatched: 1 });
    expect(item('discord:thread:7001').disposition).toBe('parked');
    expect(item('discord:thread:7002').seen).toBe('seen');
    expect(chapters()[0]!.disposition).toBe('done');
    expect(migrateInboxDecisions(h.core).skipped).toBe(true);
    expect(h.core.store.eventsFor('discord:thread:7001').filter((event) => event.payload.migrated)).toHaveLength(1);
  });

  it('heard and plain read become seen; a T3 item later only because of a T3 snooze is not parked; waits until the sources answered', async () => {
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B'), thread('7003', 'C')];
    for (const id of ['7001', '7002', '7003']) h.discord.channels.set(id, [msg(-40, 'agent', `${id}.`)]);
    await h.source.poll();
    h.core.ensureItem({ id: 't3:x', source: 't3', kind: 'thread', conversationKey: 't3:x', agentId: 't3', agentName: 'T3', createdAt: NOW - 60 * 60_000 }, 'agent');
    const old = new InboxStore(h.db, () => NOW);
    old.create({ id: 'thread:7001', kind: 'thread', agentId: 'sierra', agentName: 'Sierra', state: 'heard' });
    old.create({ id: 'thread:7002', kind: 'thread', agentId: 'sierra', agentName: 'Sierra' });
    old.mark('thread:7002', 'read');
    old.create({ id: 'thread:7003', kind: 'thread', agentId: 'sierra', agentName: 'Sierra' });
    old.mark('thread:7003', 'read', 'replied');
    old.create({ id: 't3:x', kind: 'thread', agentId: 't3', agentName: 'T3' });
    old.mark('t3:x', 'later', 'snoozed in T3');
    // The first T3 poll hasn't succeeded yet: nothing is imported and nothing is marked complete.
    expect(migrateInboxDecisions(h.core, { ready: false })).toMatchObject({ waiting: true, seen: 0 });
    expect(h.core.store.setting('migrated_inbox_v1')).toBeNull();
    expect(migrateInboxDecisions(h.core, { ready: true })).toMatchObject({ skipped: false, parked: 0, seen: 3 });
    for (const id of ['discord:thread:7001', 'discord:thread:7002', 'discord:thread:7003']) expect(item(id)).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(item('t3:x')).toMatchObject({ disposition: 'active', seen: 'new' });
  });
});

describe('rules and retention', () => {
  it('rules keep label and hide; quiet_until becomes a snooze until that weekday', async () => {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const other = days[(new Date(NOW).getDay() + 3) % 7]!;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rules-')), 'rules.yaml');
    fs.writeFileSync(
      file,
      [
        'rules:',
        '  - name: weekly report',
        '    match: { agent: sierra, text: "weekly report" }',
        `    quiet_until: ${other}`,
        '    label: Report',
        '    priority: top',
        '  - name: noise',
        '    match: { text: "heartbeat" }',
        '    hide: true',
      ].join('\n'),
    );
    h.close();
    h = makeHarness({ rules: new InboxRules(file, () => NOW) });
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'Here is the weekly report.')]);
    h.discord.channels.set('7002', [msg(-5, 'agent', 'heartbeat ok')]);
    await h.source.poll();
    const report = item('discord:thread:7001');
    expect(report).toMatchObject({ labels: ['Report'], disposition: 'snoozed' });
    expect(new Date(report.snoozeUntil!).getDay()).toBe(days.indexOf(other));
    expect(item('discord:thread:7002')).toMatchObject({ hidden: true, disposition: 'active' });
    expect(listItems(h.core).items.map((entry) => entry.id)).toEqual([]);
    expect(listItems(h.core, { view: 'everything' }).items).toHaveLength(2);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('an edited rules file applies to items already on the desk at the next tick (10/06)', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rules-')), 'rules.yaml');
    fs.writeFileSync(file, 'rules: []\n');
    h.close();
    h = makeHarness({ rules: new InboxRules(file, () => NOW) });
    h.discord.threads = [thread('7001', 'ops: Delivery Monitor')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'All quiet.')]);
    await h.source.poll();
    h.core.tick(); // first tick applies the current rules
    expect(item('discord:thread:7001').hidden).toBe(false);
    fs.writeFileSync(file, ['rules:', '  - name: hide ops', '    match: { place: "^ops:" }', '    hide: true'].join('\n'));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a new mtime even on coarse filesystems
    h.core.tick();
    expect(item('discord:thread:7001').hidden).toBe(true);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('kind: report reaches the summarizer, and an edit that changes the kind summarizes again', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rules-')), 'rules.yaml');
    fs.writeFileSync(file, 'rules: []\n');
    h.close();
    h = makeHarness({ rules: new InboxRules(file, () => NOW) });
    const kinds: Array<string | null | undefined> = [];
    h.summarizer.impl = async (input) => {
      kinds.push(input.kind);
      return { ...fallbackSummary(input), step: input.kind === 'report' ? 'fyi' : 'your_move', source: 'model' };
    };
    h.discord.threads = [thread('7001', 'Chief')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'Delivery briefing: nothing needs you.')]);
    await h.source.poll();
    h.core.tick();
    await h.core.drainSummaries();
    expect(kinds).toEqual([null]);
    expect(item('discord:thread:7001').nextStep).toBe('fyi');
    fs.writeFileSync(file, ['rules:', '  - name: chief is a report', '    match: { place: "^Chief$" }', '    kind: report'].join('\n'));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    h.core.tick();
    await h.core.drainSummaries();
    expect(kinds).toEqual([null, 'report']);
    expect(item('discord:thread:7001').nextStep).toBe('fyi');
    // kind ignores text and status conditions on the rule.
    expect(new InboxRules(file, () => NOW).kindFor('anyone', 'Chief')).toBe('report');
    fs.writeFileSync(path.join(path.dirname(file), 'r2.yaml'), ['rules:', '  - name: r', '    match: { place: "^Chief$", text: "nope", status: needs_you }', '    kind: report'].join('\n'));
    expect(new InboxRules(path.join(path.dirname(file), 'r2.yaml'), () => NOW).kindFor('anyone', 'Chief')).toBe('report');
    // An unchanged kind is not summarized again.
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    h.core.tick();
    await h.core.drainSummaries();
    expect(kinds).toHaveLength(2);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('a summary made under a kind the rules changed mid-flight is dropped and made again', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rules-')), 'rules.yaml');
    fs.writeFileSync(file, 'rules: []\n');
    h.close();
    h = makeHarness({ rules: new InboxRules(file, () => NOW) });
    const kinds: Array<string | null | undefined> = [];
    h.summarizer.impl = async (input) => {
      kinds.push(input.kind);
      if (kinds.length === 1) {
        fs.writeFileSync(file, ['rules:', '  - name: chief is a report', '    match: { place: "^Chief$" }', '    kind: report'].join('\n'));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
      }
      return { ...fallbackSummary(input), step: input.kind === 'report' ? 'fyi' : 'your_move', source: 'model' };
    };
    h.discord.threads = [thread('7001', 'Chief')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'Delivery briefing: nothing needs you.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    expect(kinds).toEqual([null]); // dropped and rescheduled, not written
    await h.core.drainSummaries();
    expect(kinds).toEqual([null, 'report']);
    expect(item('discord:thread:7001').nextStep).toBe('fyi');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('retention forgets done items quiet for 30 days, never parked ones', async () => {
    h.discord.threads = [thread('7001', 'A'), thread('7002', 'B')];
    h.discord.channels.set('7001', [msg(-5, 'agent', 'A.')]);
    h.discord.channels.set('7002', [msg(-5, 'agent', 'B.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'done', itemId: 'discord:thread:7001' });
    await h.core.command({ commandId: cid(), type: 'park', itemId: 'discord:thread:7002' });
    h.clock.now = NOW + 31 * 86_400_000;
    expect(h.core.prune()).toEqual(['discord:thread:7001']);
    expect(h.core.store.item('discord:thread:7001')).toBeNull();
    expect(h.core.store.eventsFor('discord:thread:7001')).toEqual([]);
    expect(item('discord:thread:7002').disposition).toBe('parked');
  });
});

it('keeps both accepted owner messages in reloaded detail before source ingestion, then reconciles their echoes', async () => {
  h.discord.threads.push(thread('989'));
  h.discord.channels.set('989', [msg(-10, 'agent', 'Earlier report.')]);
  await h.source.poll();
  const id = 'discord:thread:989';
  await h.core.command({ commandId: 'receipt-1', type: 'reply', itemId: id, args: { text: 'First message' } });
  await h.core.command({ commandId: 'receipt-2', type: 'reply', itemId: id, args: { text: 'Second message' } });
  const before = itemDetail(h.core, id, [])!;
  expect(before.ownerReceipts.map(r => r.text)).toEqual(['First message', 'Second message']);
  expect(before.ownerReceipts.every(r => r.status === 'delivered')).toBe(true);
  h.core.recordMessage(id, { messageId: 'echo-1', author: 'owner', text: 'First message', at: h.clock.now, meta: { commandId: 'receipt-1' } });
  h.core.recordMessage(id, { messageId: 'echo-2', author: 'owner', text: 'Second message', at: h.clock.now, meta: { commandId: 'receipt-2' } });
  expect(itemDetail(h.core, id, [])!.ownerReceipts.map(r => r.messageId)).toEqual(['echo-1', 'echo-2']);
  h.core.recordMessage(id, { messageId: 'response', author: 'agent', text: 'Both are handled.', at: h.clock.now + 1 });
  expect(itemDetail(h.core, id, [])!.ownerReceipts).toEqual([]);
});
