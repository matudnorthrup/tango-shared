import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snowflakeAt } from '../server/discord.js';
import { DeskFeed, collapseRepeats, showAs, type FeedSettings, parseFeedSettings, readFeedSettings, type FeedPost } from '../server/desk/feed.js';
import { fallbackSummary, parseModelSummary, type DeskSummaryInput } from '../server/desk/summarize.js';
import { feedSeed } from '../server/desk/setup.js';
import { AGENT, NOW, cid, makeHarness, msg, type Harness } from './desk-harness.js';

// The desk's news feed (desk/feed.ts): posts, coalescing, and the owner's settings applied on read.

let dir: string;
let db: DatabaseSync;
let clock: number;
let feed: DeskFeed;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-feed-'));
  db = new DatabaseSync(path.join(dir, 'feed.db'));
  clock = new Date('2026-10-16T09:00:00').getTime();
  feed = new DeskFeed(db, () => clock);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('desk feed', () => {
  it('fills a scoped feed before applying the page limit', () => {
    feed.post({ kind: 'update', itemId: 'inside', title: 'Inside' });
    for (let n = 0; n < 205; n++) {
      clock += 1000;
      feed.post({ kind: 'update', itemId: 'outside', title: 'Outside' });
    }
    expect(feed.recent({ limit: 1, matches: (post) => post.itemId === 'inside' }).map((p) => p.title)).toEqual(['Inside']);
  });

  it("what a lead's workers posted since a time: a needs post freshened in place counts from when its words changed", () => {
    const worker = { kind: 'needs' as const, itemId: 't3:w', key: 'thread:t3:w', data: { update: true }, mergeMs: 5 * 60_000, throttleMs: 7 * 60_000 };
    feed.post({ ...worker, title: 'Pick a layout', text: 'Two layouts ready.' });
    clock += 60_000;
    // The lead posts after it.
    feed.post({ kind: 'update', itemId: 't3:lead', key: 'thread:t3:lead', title: 'Plan', text: 'A worker has two layouts.', data: { update: true } });
    const leadAt = feed.lastPostAt('thread:t3:lead')!;
    expect(feed.postedSince(['thread:t3:w'], leadAt)).toEqual([]);
    // Still needs the owner, new words: the post freshens where it is, its time unchanged, and it counts as said since.
    clock += 60_000;
    feed.post({ ...worker, title: 'Pick a layout', text: 'Two layouts ready; the second is faster.' });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter((p) => p.itemId === 't3:w')).toHaveLength(1);
    expect(feed.postedSince(['thread:t3:w'], leadAt).map((p) => p.text)).toEqual(['Two layouts ready; the second is faster.']);
    expect(feed.lastPostAt('thread:t3:w')).toBe(clock);
    expect(feed.lastPostAt('thread:t3:nobody')).toBeNull();
  });

  it("a worker posting in the same millisecond as its lead, after it, still counts as posted since", () => {
    feed.post({ kind: 'update', itemId: 't3:lead', key: 'thread:t3:lead', title: 'Plan', text: 'Plan set.', data: { update: true } });
    feed.post({ kind: 'update', itemId: 't3:w', key: 'thread:t3:w', title: 'Fix merged', text: 'The fix is merged.', data: { update: true } });
    const mark = feed.lastPostMark('thread:t3:lead')!;
    expect(mark.at).toBe(clock);
    expect(feed.postedSince(['thread:t3:w'], mark.at, 8, mark.rev).map((p) => p.text)).toEqual(['The fix is merged.']);
    // Without the seq, the same-millisecond post is behind the cutoff.
    expect(feed.postedSince(['thread:t3:w'], mark.at)).toEqual([]);
  });

  it("a worker's older post freshened in the same millisecond as its lead's, after it, counts as posted since", () => {
    const worker = { kind: 'needs' as const, itemId: 't3:w', key: 'thread:t3:w', data: { update: true }, throttleMs: 7 * 60_000 };
    feed.post({ ...worker, title: 'Pick a layout', text: 'Two layouts ready.' });
    clock += 60_000;
    feed.post({ kind: 'update', itemId: 't3:lead', key: 'thread:t3:lead', title: 'Plan', text: 'A worker has two layouts.', data: { update: true } });
    // Rewritten after the lead's post, in the same millisecond: its seq is older, but it was written later.
    feed.post({ ...worker, title: 'Pick a layout', text: 'Two layouts ready; the second is faster.' });
    const mark = feed.lastPostMark('thread:t3:lead')!;
    expect(feed.postedSince(['thread:t3:w'], mark.at, 8, mark.rev).map((p) => p.text)).toEqual(['Two layouts ready; the second is faster.']);
    // And the other way round: the lead's post rewritten after the worker's is behind it.
    feed.post({ kind: 'update', itemId: 't3:lead', key: 'thread:t3:lead', title: 'Plan', text: 'A worker has two layouts; the second is faster.', data: { update: true }, mergeMs: 5 * 60_000 });
    const after = feed.lastPostMark('thread:t3:lead')!;
    expect(after.at).toBe(clock);
    expect(feed.postedSince(['thread:t3:w'], after.at, 8, after.rev)).toEqual([]);
  });

  it("a worker's new post after its lead's post was rewritten, in the same millisecond, counts as posted since", () => {
    feed.post({ kind: 'needs', itemId: 't3:lead', key: 'thread:t3:lead', title: 'Plan', text: 'Pick a plan.', data: { update: true }, throttleMs: 7 * 60_000 });
    clock += 60_000;
    // The lead's post freshens in place, then the worker posts, all in one millisecond.
    feed.post({ kind: 'needs', itemId: 't3:lead', key: 'thread:t3:lead', title: 'Plan', text: 'Pick a plan; two are ready.', data: { update: true }, throttleMs: 7 * 60_000 });
    feed.post({ kind: 'update', itemId: 't3:w', key: 'thread:t3:w', title: 'Built', text: 'Plan B is built.', data: { update: true } });
    const mark = feed.lastPostMark('thread:t3:lead')!;
    expect(feed.postedSince(['thread:t3:w'], mark.at, 8, mark.rev).map((p) => p.text)).toEqual(['Plan B is built.']);
  });

  it('writes posts newest first and tells listeners', () => {
    const heard: FeedPost[] = [];
    feed.subscribe((post) => heard.push(post));
    feed.post({ kind: 'done', itemId: 'loom:a', agentName: 'Victor', title: 'Reconnect fix', text: 'Merged and live.' });
    clock += 60_000;
    feed.post({ kind: 'project', projectId: 'p1', title: 'Desk reliability', text: 'Two of three fixes shipped.' });
    expect(feed.recent().map((p) => p.title)).toEqual(['Desk reliability', 'Reconnect fix']);
    expect(heard.map((p) => p.kind)).toEqual(['done', 'project']);
  });

  it('a state change and an update close together are one post: the state as the pill, the update as the words', () => {
    feed.post({ kind: 'needs', itemId: 'loom:a', title: 'Sidebar status', key: 'thread:loom:a', mergeMs: 5 * 60_000 });
    clock += 10_000;
    feed.post({ kind: 'update', itemId: 'loom:a', title: 'Two sidebar designs ready', text: 'Pick one.', data: { update: true, headline: true }, key: 'thread:loom:a', mergeMs: 5 * 60_000 });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } })).toMatchObject([{ kind: 'needs', title: 'Two sidebar designs ready', text: 'Pick one.', data: { headline: true, update: true } }]);
    // A later summary while it still needs the owner is its own post, not an overwrite.
    clock += 30_000;
    feed.post({ kind: 'needs', itemId: 'loom:a', title: 'Still waiting on a pick', data: { update: true, headline: true }, key: 'thread:loom:a', mergeMs: 5 * 60_000 });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => p.title)).toEqual(['Still waiting on a pick', 'Two sidebar designs ready']);
    // Updates never merge into each other: a later one is a post of its own.
    clock += 60_000;
    feed.post({ kind: 'update', itemId: 'loom:a', title: 'Picked the quiet one', data: { update: true, headline: true }, key: 'thread:loom:a', mergeMs: 5 * 60_000 });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => p.kind)).toEqual(['update', 'needs', 'needs']);
  });

  it('two updates with the same words stay two posts', () => {
    const up = () => feed.post({ kind: 'update', itemId: 'loom:q', title: 'Same', text: 'Same words.', data: { update: true }, key: 'thread:loom:q', mergeMs: 5 * 60_000 });
    up();
    clock += 60_000;
    up();
    expect(feed.recent().length).toBe(2);
  });

  it("a bare state change relabels only its own summary's update, by its content key", () => {
    const up = (key: string) => feed.post({ kind: 'update', itemId: 'loom:k', title: 'Words', text: 'Same words.', data: { update: true, contentKey: key }, key: 'thread:loom:k', mergeMs: 5 * 60_000 });
    up('k1');
    clock += 60_000;
    feed.post({ kind: 'needs', itemId: 'loom:k', title: 'Words', text: 'Same words.', data: { contentKey: 'k2' }, key: 'thread:loom:k', mergeMs: 5 * 60_000 });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => p.kind)).toEqual(['needs', 'update']);
    clock += 60_000;
    up('k3');
    clock += 60_000;
    feed.post({ kind: 'needs', itemId: 'loom:k', title: 'Words', text: 'Same words.', data: { contentKey: 'k3' }, key: 'thread:loom:k', mergeMs: 5 * 60_000 });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => p.kind)).toEqual(['needs', 'needs', 'update']);
  });

  it('a bare state with the same words as an earlier state post is a post of its own', () => {
    feed.post({ kind: 'needs', itemId: 'loom:r', title: 'Pick', text: 'Same words.', data: { update: true }, key: 'thread:loom:r', mergeMs: 5 * 60_000 });
    clock += 60_000;
    feed.post({ kind: 'needs', itemId: 'loom:r', title: 'Pick', text: 'Same words.', key: 'thread:loom:r', mergeMs: 5 * 60_000 });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).length).toBe(2);
  });

  it('a bare turn to the owner never relabels an earlier update; Done may', () => {
    const at = (kind: string, title: string, update = false) => feed.post({ kind: kind as 'update', itemId: 'loom:b', title, data: update ? { update: true } : {}, key: 'thread:loom:b', mergeMs: 5 * 60_000 });
    at('update', 'Working on it', true);
    clock += 60_000;
    at('needs', 'Thread turned');
    clock += 1000;
    at('needs', 'Pick one of two', true);
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => [p.kind, p.title])).toEqual([['needs', 'Pick one of two'], ['update', 'Working on it']]);
    clock += 60_000;
    at('done', 'Done');
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => [p.kind, p.title])).toEqual([['done', 'Pick one of two'], ['update', 'Working on it']]);
  });

  it('a thread at work posts at most every few minutes; the newest held words post when the time comes', async () => {
    vi.useFakeTimers();
    try {
      const every = 7 * 60_000;
      const update = (title: string) => feed.post({ kind: 'update', itemId: 'loom:w', title, data: { update: true }, key: 'thread:loom:w', throttleMs: every });
      update('First');
      clock += 60_000;
      update('Second');
      clock += 60_000;
      update('Third');
      expect(feed.recent().map((p) => p.title)).toEqual(['First']);
      clock += every;
      vi.advanceTimersByTime(every);
      expect(feed.recent().map((p) => [p.title, p.count])).toEqual([['Third', 2], ['First', 1]]);
      // Something immediate (needs you) drops what was held and posts at once.
      update('Fourth');
      clock += 10;
      feed.post({ kind: 'needs', itemId: 'loom:w', title: 'Needs you', key: 'thread:loom:w', mergeMs: 1 });
      vi.advanceTimersByTime(every);
      expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => p.title)).toEqual(['Needs you', 'Third', 'First']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change of state posts at once; more of the same state freshens that post in place', () => {
    const post = (kind: string, title: string) => feed.post({ kind: kind as 'update', itemId: 'loom:s', title, data: { update: true, headline: true }, key: 'thread:loom:s', mergeMs: 5 * 60_000, throttleMs: 7 * 60_000 });
    post('update', 'Working');
    clock += 60_000;
    post('needs', 'Ready for you');
    const at = feed.recent({ settings: { chatter: 'hidden', needsYou: true } })[0]!.at;
    clock += 30_000;
    post('needs', 'Still ready, reworded');
    const posts = feed.recent({ settings: { chatter: 'hidden', needsYou: true } });
    expect(posts.map((p) => [p.kind, p.title])).toEqual([['needs', 'Still ready, reworded'], ['update', 'Working']]);
    expect(posts[0]!.at).toBe(at);
  });

  it('mail repeats its kind but still waits its turn, counted; a fresher state drops a held update', async () => {
    vi.useFakeTimers();
    try {
      const every = 7 * 60_000;
      const mail = (text: string) => feed.post({ kind: 'mail', title: 'A → B', text, data: { pair: 'a|b' }, key: 'mail:a|b', throttleMs: every });
      mail('one');
      clock += 60_000;
      mail('two');
      clock += 60_000;
      mail('three');
      expect(feed.recent({ settings: { chatter: 'shown', needsYou: true } }).map((p) => p.text)).toEqual(['one']);
      clock += every;
      vi.advanceTimersByTime(every);
      expect(feed.recent({ settings: { chatter: 'shown', needsYou: true } }).map((p) => [p.text, p.count])).toEqual([['three', 2], ['one', 1]]);

      const t = (kind: string, title: string) => feed.post({ kind: kind as 'update', itemId: 'loom:h', title, data: { update: true }, key: 'thread:loom:h', mergeMs: 5 * 60_000, throttleMs: every });
      t('needs', 'Pick one');
      clock += 60_000;
      t('update', 'Back at work');
      clock += 60_000;
      t('needs', 'Pick one, reworded');
      vi.advanceTimersByTime(every);
      expect(feed.recent({ settings: { chatter: 'hidden', needsYou: true } }).map((p) => p.title)).toEqual(['Pick one, reworded']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shutdown posts what the throttle held instead of losing it', () => {
    feed.post({ kind: 'update', itemId: 'loom:z', title: 'First', key: 'thread:loom:z', throttleMs: 7 * 60_000 });
    clock += 60_000;
    feed.post({ kind: 'update', itemId: 'loom:z', title: 'Held', key: 'thread:loom:z', throttleMs: 7 * 60_000 });
    feed.close();
    expect(feed.recent().map((p) => p.title)).toEqual(['Held', 'First']);
  });

  it('applies the settings when read: agent chatter; state posts always come back (the screen folds closed ones)', () => {
    feed.post({ kind: 'needs', itemId: 'loom:a', title: 'Merge now?' });
    feed.post({ kind: 'needs', itemId: 'loom:b', title: 'Picked a ferry', text: 'Booked the 9:10.', data: { update: true } });
    feed.post({ kind: 'mail', title: 'A → B', text: 'hello', data: { pair: 'a|b' } });
    feed.post({ kind: 'stuck', itemId: 'loom:d', title: 'Watching CI', text: 'PR #5 checks check failing: 502' });
    feed.post({ kind: 'done', itemId: 'loom:c', title: 'Done thing' });
    expect(feed.recent({ settings: { chatter: 'hidden', needsYou: false } }).map((p) => p.kind)).toEqual(['done', 'stuck', 'needs', 'needs']);
    expect(feed.recent({ settings: { chatter: 'shown', needsYou: true } }).map((p) => p.kind)).toEqual(['done', 'stuck', 'mail', 'needs', 'needs']);
  });

  it('reads back past a page of hidden chatter to fill the feed', () => {
    feed.post({ kind: 'done', itemId: 'loom:a', title: 'Older done' });
    for (let i = 0; i < 450; i += 1) {
      clock += 1000;
      feed.post({ kind: 'mail', title: `m${i}`, data: { pair: `p${i}` } });
    }
    expect(feed.recent({ limit: 60 }).map((p) => p.title)).toEqual(['Older done']);
  });

  it('leaves out threads that are no conversation (a coordinator)', () => {
    feed.post({ kind: 'update', itemId: 'coord:1', title: 'Coordinator' });
    feed.post({ kind: 'update', itemId: 'loom:a', title: 'Real' });
    expect(feed.recent({ hidden: (id) => id === 'coord:1' }).map((p) => p.title)).toEqual(['Real']);
    // Mail between two threads goes when either is hidden.
    feed.post({ kind: 'mail', title: 'A → B', data: { pair: 'a|b', from: 'loom:a', to: 'coord:1' } });
    expect(feed.recent({ hidden: (id) => id === 'coord:1', settings: { chatter: 'daily', needsYou: false } }).map((p) => p.title)).toEqual(['Real']);
  });

  it('keeps two weeks', () => {
    feed.post({ kind: 'done', title: 'Old' });
    clock += 15 * 24 * 3600_000;
    feed.post({ kind: 'done', title: 'New' });
    feed.prune();
    expect(feed.recent().map((p) => p.title)).toEqual(['New']);
  });

  it('reads and checks the feed settings', () => {
    expect(readFeedSettings(null)).toEqual({ chatter: 'hidden', needsYou: false, summaries: false, usage: true });
    expect(readFeedSettings('{"chatter":"shown","needsYou":true,"summaries":true}')).toEqual({ chatter: 'shown', needsYou: true, summaries: true, usage: true });
    // `daily` was the first name for showing it.
    expect(readFeedSettings('{"chatter":"daily"}')).toEqual({ chatter: 'shown', needsYou: false, summaries: false, usage: true });
    expect(parseFeedSettings({ needsYou: true }, { chatter: 'shown', needsYou: false, summaries: false, usage: true })).toEqual({ settings: { chatter: 'shown', needsYou: true, summaries: false, usage: true } });
    expect(parseFeedSettings({ summaries: true }, { chatter: 'shown', needsYou: false, summaries: false, usage: true })).toEqual({ settings: { chatter: 'shown', needsYou: false, summaries: true, usage: true } });
    expect(parseFeedSettings({ chatter: 'loud' }, { chatter: 'hidden', needsYou: false, summaries: false })).toEqual({ error: 'feed.chatter must be hidden or shown' });
    expect(parseFeedSettings({ summaries: 'yes' }, { chatter: 'hidden', needsYou: false, summaries: false })).toEqual({ error: 'feed.summaries must be true or false' });
    // Account usage is on until turned off.
    expect(readFeedSettings('{"usage":false}').usage).toBe(false);
    expect(parseFeedSettings({ usage: false }, { chatter: 'hidden', needsYou: false, summaries: false, usage: true })).toEqual({ settings: { chatter: 'hidden', needsYou: false, summaries: false, usage: false } });
    expect(parseFeedSettings({ usage: 'no' }, { chatter: 'hidden', needsYou: false, summaries: false })).toEqual({ error: 'feed.usage must be true or false' });
  });
});

describe('what the desk posts', () => {
  // A desk with a feed, over the test harness's fake Discord.
  const HOME = AGENT.homeChannelId;
  // Thread ids minted for when each thread began (a Discord id carries its creation time).
  const T7001 = snowflakeAt(NOW - 15 * 60_000);
  const T7002 = snowflakeAt(NOW - 15 * 60_000);
  const T7003 = snowflakeAt(NOW - 15 * 60_000);
  const T7004 = snowflakeAt(NOW - 15 * 60_000);
  const T7005 = snowflakeAt(NOW - 15 * 60_000);
  const T7006 = snowflakeAt(NOW - 200 * 60_000);
  const T7007 = snowflakeAt(NOW - 57600 * 60_000);
  const thread = (id: string, name = 'Speaker') => ({ id, name, parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) });
  const model = (gist: string, title: string) => async () => ({ gist, title, step: 'fyi' as const, ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'model' as const });
  let h: Harness;
  let deskFeed: DeskFeed;

  beforeEach(() => {
    const feedDb = new DatabaseSync(path.join(dir, 'desk.db'));
    deskFeed = new DeskFeed(feedDb, () => h.clock.now);
    h = makeHarness({ feed: deskFeed });
  });
  afterEach(() => h.close());

  it('posts a new thread, its updates in its own words under its own name, and its done', async () => {
    h.discord.threads = [thread(T7001)];
    h.summarizer.impl = model('Looking for a used receiver under $300.', 'Speaker receiver hunt');
    h.discord.channels.set(T7001, [msg(-10, 'agent', 'On it: searching listings.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    let posts = deskFeed.recent();
    expect(posts).toHaveLength(1);
    // New thread, with its first update folded in; headed by the thread's name, not the summary's headline.
    expect(posts[0]).toMatchObject({ kind: 'started', itemId: `discord:thread:${T7001}`, agentName: 'Sierra', title: h.core.title(h.core.store.item(`discord:thread:${T7001}`)!), text: 'Looking for a used receiver under $300.' });
    expect(posts[0]!.title).not.toBe('Speaker receiver hunt');

    // Same words again: no post. New words an hour later: an update of its own.
    h.clock.now = NOW + 3_600_000;
    h.summarizer.impl = model('Found a vintage receiver for $240; pickup Saturday.', 'Receiver found');
    h.discord.push(T7001, msg(55, 'agent', 'Found one: a vintage receiver for $240.'));
    await h.source.poll();
    await h.core.drainSummaries();
    posts = deskFeed.recent();
    expect(posts.map((p) => [p.kind, p.text])).toEqual([
      ['update', 'Found a vintage receiver for $240; pickup Saturday.'],
      ['started', 'Looking for a used receiver under $300.'],
    ]);

    // Done right after the update: one post, Done with the update's words.
    await h.core.command({ commandId: cid(), type: 'done', itemId: `discord:thread:${T7001}` });
    expect(deskFeed.recent().map((p) => [p.kind, p.text])).toEqual([
      ['done', 'Found a vintage receiver for $240; pickup Saturday.'],
      ['started', 'Looking for a used receiver under $300.'],
    ]);
    // Undone: it's the update again.
    const done = h.core.store.recentEvents(5, ['done'])[0]!;
    await h.core.command({ commandId: cid(), type: 'undo', itemId: `discord:thread:${T7001}`, args: { seq: done.seq } });
    expect(deskFeed.recent().map((p) => p.kind)).toEqual(['update', 'started']);
  });

  it('a summary asking the owner is an update until a record opens', async () => {
    h.discord.threads = [thread(T7002)];
    h.discord.channels.set(T7002, [msg(-30, 'agent', 'Working on the sidebar.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    h.clock.now = NOW + 3_600_000;
    h.summarizer.impl = async () => ({ ...(await model('Two designs are ready to pick from.', 'Pick a sidebar design')()), step: 'your_move' as const, ask: 'Which design?', headline: 'Quieter sidebar designs ready', paragraph: 'Both versions are up; pick the one that reads better.' });
    h.discord.push(T7002, msg(55, 'agent', 'Both sidebar designs are ready. Which one?'));
    await h.source.poll();
    await h.core.drainSummaries();
    const posts = deskFeed.recent({ settings: { chatter: 'hidden', needsYou: true } });
    expect(posts[0]).toMatchObject({ kind: 'update', title: 'Quieter sidebar designs ready', text: 'Both versions are up; pick the one that reads better.', data: { headline: true, update: true } });
    expect(posts.filter((p) => p.firstAt >= NOW + 3_600_000)).toHaveLength(1);
  });

  it('summary asks and Discord closing text cannot beat a monitor; a recorded ask does', async () => {
    h.discord.threads = [thread(T7003)];
    h.discord.channels.set(T7003, [msg(-30, 'agent', 'Working on the layout.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    const id = `discord:thread:${T7003}`;
    h.core.setFacts(id, { background: 'monitoring' });
    h.clock.now = NOW + 3_600_000;
    h.summarizer.impl = async () => ({ ...(await model('Two layouts are ready.', 'Pick a layout')()), step: 'your_move' as const, ask: 'Which layout?', headline: 'Two layouts ready', paragraph: 'Both layouts are up; pick one.' });
    h.discord.push(T7003, msg(55, 'agent', 'Next — you: choose a layout'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(h.core.store.item(id)).toMatchObject({ nextStep: 'watching', nextStepBasis: 'source:background' });
    expect(deskFeed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter((p) => p.kind === 'needs')).toEqual([]);
    const entered: string[] = [];
    h.core.subscribe((event) => { if (event.type === 'status.entered') entered.push(event.entered.pill); });
    h.core.setFacts(id, { openAsk: { text: 'Choose a layout', at: h.clock.now } });
    h.core.refresh(id);
    h.core.flush();
    expect(entered).toEqual(['needs']);
    expect(deskFeed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter((p) => p.kind === 'needs')).toHaveLength(1);
    h.core.setFacts(id, { background: null });
    h.core.tick();
    expect(h.core.store.item(id)!.nextStep).toBe('your_move');
    expect(entered).toEqual(['needs']);
    expect(deskFeed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter((p) => p.kind === 'needs')).toHaveLength(1);
  });

  it('a thread parked before its turn ends makes no needs-you post', async () => {
    h.discord.threads = [thread(T7004)];
    h.discord.channels.set(T7004, [msg(-30, 'agent', 'Working.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    const id = `discord:thread:${T7004}`;
    h.core.setFacts(id, { background: 'monitoring' });
    h.clock.now = NOW + 3_600_000;
    h.core.setFacts(id, { running: { since: h.clock.now } });
    h.summarizer.impl = async () => ({ ...(await model('Ready to pick.', 'Pick')()), step: 'your_move' as const, ask: 'Which?' });
    h.discord.push(T7004, msg(55, 'agent', 'Which one?'));
    await h.source.poll();
    await h.core.drainSummaries();
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.core.setFacts(id, { background: null, running: null });
    h.core.tick();
    expect(deskFeed.recent({ settings: { chatter: 'hidden', needsYou: true } }).filter((p) => p.kind === 'needs')).toEqual([]);
  });

  it('a re-summary of the same words is not news', async () => {
    h.discord.threads = [thread(T7004)];
    h.summarizer.impl = model('Plan drafted.', 'Plan');
    h.discord.channels.set(T7004, [msg(-10, 'agent', 'Here is the plan.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent()).toHaveLength(1);
    // The same words summarized again (as after a prompt-version bump), worded differently: no post.
    h.summarizer.impl = model('The plan is drafted.', 'Plan');
    h.core.store.patchItem(`discord:thread:${T7004}`, { summary: { ...h.core.item(`discord:thread:${T7004}`)!.summary!, version: 1 } });
    (h.core as unknown as { scheduleSummary(id: string): void }).scheduleSummary(`discord:thread:${T7004}`);
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['Plan drafted.']);
  });

  it('done, reopened and done again moments later is one Done; undoing the first keeps it', async () => {
    h.discord.threads = [thread(T7005)];
    h.discord.channels.set(T7005, [msg(-10, 'agent', 'Newsletter drafted.')]);
    await h.source.poll();
    const id = `discord:thread:${T7005}`;
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    const first = h.core.store.recentEvents(5, ['done'])[0]!;
    await h.core.command({ commandId: cid(), type: 'reopen', itemId: id });
    h.clock.now = NOW + 60_000;
    await h.core.command({ commandId: cid(), type: 'done', itemId: id });
    expect(deskFeed.recent().filter((p) => p.kind === 'done')).toHaveLength(1);
    await h.core.command({ commandId: cid(), type: 'undo', itemId: id, args: { seq: first.seq } });
    expect(deskFeed.recent().filter((p) => p.kind === 'done')).toHaveLength(1);
  });

  it('a backfilled old thread is not news: no New thread, no Update', async () => {
    // A thread whose conversation began days ago, discovered only now (a source read for the first time).
    const old = { id: T7007, name: 'Old', parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) };
    h.discord.threads = [old];
    h.summarizer.impl = model('Wrapped up last week.', 'Old thread');
    h.discord.channels.set(T7007, [msg(-3 * 24 * 60, 'agent', 'All done here.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent()).toEqual([]);
  });

  it('an old thread found now through a fresh message is an update, not a new thread', async () => {
    const old = snowflakeAt(NOW - 90 * 86_400_000);
    h.discord.threads = [{ id: old, name: 'Old', parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
    h.summarizer.impl = model('Picked the thread back up.', 'Old thread');
    h.discord.channels.set(old, [msg(-5, 'agent', 'Back on this one.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.kind)).toEqual(['update']);
  });

  it('a text fallback (model down) is not news: the new thread posts, no update', async () => {
    h.discord.threads = [thread(T7002)];
    h.discord.channels.set(T7002, [msg(-10, 'agent', 'Working on it.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => [p.kind, p.text, p.count])).toEqual([['started', '', 1]]);
  });

  it('a summary on a thread under way is an update, carrying its paragraph', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    h.summarizer.impl = async () => ({ ...(await model('Short gist.', 'Decide on the list order')()), paragraph: 'Drafted two orders. Still checking which reads better; nothing for you yet.' });
    h.discord.push(T7006, msg(115, 'agent', 'Two orders drafted.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent()[0]).toMatchObject({ kind: 'update', text: 'Drafted two orders. Still checking which reads better; nothing for you yet.' });
    expect(deskFeed.recent()[0]!.title).not.toBe('Decide on the list order');
  });

  it("the owner's own words aren't news: nothing posts until the agent answers, and the answer's summary does", async () => {
    // Live 10/21: the owner's own note, retold as "…the agent hasn't answered yet", posted as an update.
    const id = `discord:thread:${T7006}`;
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    const before = deskFeed.recent().length;
    h.clock.now = NOW + 2 * 3600_000;
    h.summarizer.impl = model('You sent the trip dates; the agent hasn\'t answered yet.', 'Trip dates');
    h.discord.push(T7006, msg(115, 'owner', 'The trip is the 3rd to the 9th.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent()).toHaveLength(before);
    // The card still says where things stand; the owner just isn't told what they said.
    expect(h.core.item(id)!.summary!.gist).toBe('You sent the trip dates; the agent hasn\'t answered yet.');
    h.clock.now += 60_000;
    h.summarizer.impl = model('The agent saved the trip dates and found two flights.', 'Trip dates');
    h.discord.push(T7006, msg(116, 'agent', 'Saved the dates. Two flights fit.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().slice(0, deskFeed.recent().length - before).map((p) => [p.kind, p.text])).toEqual([['update', 'The agent saved the trip dates and found two flights.']]);
  });

  it('a summary that only says where things stand again is not news; the next one is judged against what last posted', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    // What each summary was told: the previous summary's words, and what the owner last heard.
    const seen: Array<{ gist: string; heard: string | null } | null> = [];
    const say = (gist: string, whatsNew: string | null) => async (input: DeskSummaryInput) => {
      seen.push(input.previous ? { gist: input.previous.gist, heard: input.previous.heard ?? null } : null);
      return { ...(await model(gist, 'Build')()), whatsNew };
    };
    h.summarizer.impl = say('The fix is built and in review.', 'fix built and sent for review');
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
    // A reply to another agent's mail that says the same thing in other words: the card updates, the feed doesn't post.
    h.clock.now += 8 * 60_000;
    h.summarizer.impl = say('The fix is still waiting on its review.', null);
    h.discord.push(T7006, msg(123, 'agent', 'Still waiting on the review; meanwhile the other thread merged its change.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(h.core.item(`discord:thread:${T7006}`)!.summary!.gist).toBe('The fix is still waiting on its review.');
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
    // Real news posts; it was judged against the last post's words, not the restatement's.
    h.clock.now += 8 * 60_000;
    h.summarizer.impl = say('The fix is merged and live.', 'the fix is merged and live');
    h.discord.push(T7006, msg(131, 'agent', 'Merged and deployed.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is merged and live.', 'The fix is built and in review.']);
    expect(seen).toEqual([null, { gist: 'The fix is built and in review.', heard: 'The fix is built and in review.' }, { gist: 'The fix is still waiting on its review.', heard: 'The fix is built and in review.' }]);
  });

  it('a recurring run that only started, came back as before, or woke to nothing is not news; a new finding posts', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    const heard: Array<string | null> = [];
    const say = (gist: string, routine: boolean) => async (input: DeskSummaryInput) => {
      heard.push(input.previous?.heard ?? null);
      return { ...(await model(gist, 'Delivery check')()), whatsNew: 'the check ran', routine };
    };
    h.summarizer.impl = say('The morning check found a merge conflict.', false);
    h.discord.push(T7006, msg(115, 'agent', 'Morning check: one fix hit a merge conflict; handed to its owner.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The morning check found a merge conflict.']);
    // The next run starting, then finishing with the same gaps: the card updates, the Feed doesn't post.
    for (const [minute, gist] of [[123, 'The ten o’clock check is running.'], [131, 'The ten o’clock check finished; the same gaps remain.']] as const) {
      h.clock.now += 8 * 60_000;
      h.summarizer.impl = say(gist, true);
      h.discord.push(T7006, msg(minute, 'agent', gist));
      await h.source.poll();
      await h.core.drainSummaries();
      expect(h.core.item(`discord:thread:${T7006}`)!.summary!.gist).toBe(gist);
    }
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The morning check found a merge conflict.']);
    // A run that finds something new posts, judged against the last post, not the runs between.
    h.clock.now += 8 * 60_000;
    h.summarizer.impl = say('A new complaint about uploads turned up.', false);
    h.discord.push(T7006, msg(139, 'agent', 'New: two players report uploads failing.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['A new complaint about uploads turned up.', 'The morning check found a merge conflict.']);
    expect(heard.at(-1)).toBe('The morning check found a merge conflict.');
  });

  it("a worker's progress goes to its lead, not the Feed; with its lead put away, it posts its own", async () => {
    const lead = `discord:thread:${T7004}`;
    const W = snowflakeAt(NOW - 16 * 60_000);
    const worker = `discord:thread:${W}`;
    h.discord.threads = [thread(T7004, 'Lead'), thread(W, 'Worker')];
    h.discord.channels.set(T7004, [msg(-10, 'agent', 'Starting.')]);
    h.discord.channels.set(W, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'role', itemId: worker, args: { role: 'worker', parentItemId: lead } });
    h.clock.now = NOW + 2 * 3600_000;
    h.summarizer.impl = async (input: DeskSummaryInput) => ({ ...(await model(input.messages.at(-1)!.text, 'Work')()), whatsNew: 'news' });
    h.discord.push(W, msg(115, 'agent', 'The build is under way.'));
    await h.source.poll();
    await h.core.drainSummaries();
    const workerPosts = () => deskFeed.recent().filter((post) => post.itemId === worker && post.text).map((post) => post.text);
    expect(h.core.item(worker)!.summary!.gist).toBe('The build is under way.');
    expect(workerPosts()).toEqual([]);
    // The lead is put away: no one tells the owner the worker's news, so the worker does.
    await h.core.command({ commandId: cid(), type: 'done', itemId: lead });
    h.clock.now += 8 * 60_000;
    h.discord.push(W, msg(123, 'agent', 'The fix is merged and live.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(workerPosts()).toEqual(['The fix is merged and live.']);
  });

  it('labels a summary post, and drops it for a thread that posts its own updates (feed-status.md "Leads")', async () => {
    const id = `discord:thread:${T7002}`;
    h.discord.threads = [thread(T7002)];
    h.summarizer.impl = model('Looking for a used receiver under $300.', 'Speaker receiver hunt');
    h.discord.channels.set(T7002, [msg(-10, 'agent', 'On it: searching listings.')]);
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent()[0]!.data).toMatchObject({ summary: true });
    // The thread writes its own update: its next summary doesn't post.
    h.clock.now = NOW + 3_600_000;
    deskFeed.postLedger({ post: { kind: 'update', itemId: id, title: 'Found a vintage receiver', key: 'ledger:lead:1', data: { source: 'ledger', lead: true } }, ref: 'ledger:1', rank: 3, pr: false });
    h.clock.now += 60_000;
    h.summarizer.impl = model('Found a vintage receiver for $240; pickup Saturday.', 'Receiver found');
    h.discord.push(T7002, msg(61, 'agent', 'Found one: a vintage receiver for $240.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.title)).toEqual(['Found a vintage receiver', expect.any(String)]);
    // Not posted, so not heard: what the owner last heard is still the first summary.
    expect(h.core.item(id)!.summary!.postedGist).toBe('Looking for a used receiver under $300.');
    // Kept on by the owner: a summary posts again once the update is past the throttle window.
    h.core.store.setSetting('feed', JSON.stringify({ chatter: 'hidden', needsYou: false, summaries: true }));
    h.clock.now += 10 * 60_000;
    h.summarizer.impl = model('Picked up the vintage receiver; it works.', 'Receiver home');
    h.discord.push(T7002, msg(72, 'agent', 'Picked it up.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent()[0]).toMatchObject({ kind: 'update', text: 'Picked up the vintage receiver; it works.', data: { summary: true } });
  });

  it('logs a Summary posted soon after another post on its thread (the missed-repeat log)', () => {
    const pairs: Array<{ wouldDrop: boolean; overlap: number }> = [];
    deskFeed.onRepeat = (pair) => pairs.push(pair);
    deskFeed.post({ kind: 'update', itemId: 'a', title: 'Receiver found', text: 'Found a vintage receiver receiver for 240 dollars, pickup Saturday morning.', data: { update: true, summary: true }, key: 'thread:a' });
    h.clock.now += 10 * 60_000;
    deskFeed.post({ kind: 'update', itemId: 'a', title: 'Receiver found', text: 'Found a vintage receiver receiver for 240 dollars, pickup Saturday afternoon.', data: { update: true, summary: true }, key: 'thread:a' });
    expect(pairs).toMatchObject([{ wouldDrop: true }]);
    expect(pairs[0]!.overlap).toBeGreaterThan(0.4);
  });

  it('with nothing posted yet (the model was down), the first real summary posts even when it says nothing is new', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    // The model is down: a text fallback summarizes, and nothing posts.
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(h.core.item(`discord:thread:${T7006}`)!.summary!.postedGist).toBeNull();
    expect(deskFeed.recent()).toEqual([]);
    // The model is back and, seeing the same words, says nothing is new: the owner heard none of it, so it posts.
    // The fallback's words still reach it as the earlier state, so an open decision older than the window carries forward.
    h.clock.now += 8 * 60_000;
    const seen: Array<{ gist: string; heard: string | null } | null> = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      seen.push(input.previous ? { gist: input.previous.gist, heard: input.previous.heard ?? null } : null);
      return { ...(await model('The fix is built and in review.', 'Build')()), whatsNew: null };
    };
    h.discord.push(T7006, msg(123, 'agent', 'Still waiting on the review.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(seen).toEqual([{ gist: 'Built the fix; review requested.', heard: null }]);
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
  });

  it('what the owner heard is what the feed posted: the paragraph when the summary gave one', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    const seen: Array<string | null> = [];
    const paragraph = 'The fix is built and in review; two edge cases are listed for a follow-up.';
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      seen.push(input.previous?.heard ?? null);
      return { ...(await model('The fix is built and in review.', 'Build')()), paragraph, whatsNew: 'fix built and in review' };
    };
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested; two edge cases noted for later.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual([paragraph]);
    h.clock.now += 8 * 60_000;
    h.discord.push(T7006, msg(123, 'agent', 'Still in review.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(seen).toEqual([null, paragraph]);
  });

  it("a lead retelling what its workers just posted isn't news; its own news still posts", async () => {
    const lead = `discord:thread:${T7004}`;
    const W = snowflakeAt(NOW - 16 * 60_000);
    const worker = `discord:thread:${W}`;
    h.discord.threads = [thread(T7004, 'Lead'), thread(W, 'Worker')];
    h.discord.channels.set(T7004, [msg(-10, 'agent', 'Starting.')]);
    h.discord.channels.set(W, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'role', itemId: worker, args: { role: 'worker', parentItemId: lead } });
    h.clock.now = NOW + 2 * 3600_000;
    // What the lead's summaries were told its workers had posted.
    let told: string[][] = [];
    let leadSays = { gist: 'Plan set; a worker is building the fix.', whatsNew: 'plan set' as string | null };
    let workerSays = { gist: 'Building the fix.', whatsNew: 'building the fix' as string | null };
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      if (input.itemId === lead) told.push((input.workersPosted ?? []).map((post) => post.text));
      const says = input.itemId === lead ? leadSays : workerSays;
      return { ...(await model(says.gist, 'Work')()), whatsNew: says.whatsNew };
    };
    h.discord.push(T7004, msg(115, 'agent', 'Plan set; started a worker on the fix.'));
    h.discord.push(W, msg(115, 'agent', 'Building the fix.'));
    await h.source.poll();
    await h.core.drainSummaries();
    // What the lead said in its own words (its bare start carries none).
    const leadPosts = () => deskFeed.recent().filter((post) => post.itemId === lead && post.text).map((post) => post.text);
    expect(leadPosts()).toEqual(['Plan set; a worker is building the fix.']);
    // The worker's own progress goes to its lead, not the Feed.
    expect(deskFeed.recent().filter((post) => post.itemId === worker && post.text)).toEqual([]);
    // The worker's news reaches the Feed some other way (a Shipped post).
    h.clock.now += 8 * 60_000;
    workerSays = { gist: 'The fix is merged and live.', whatsNew: 'fix merged and live' };
    h.discord.push(W, msg(123, 'agent', 'Merged and deployed.'));
    await h.source.poll();
    await h.core.drainSummaries();
    deskFeed.post({ kind: 'update', itemId: worker, title: 'Fix merged', text: 'The fix is merged and live.', data: { update: true }, key: `thread:${worker}` });
    // The lead passes it on: its summary sees what the worker posted, says nothing is new, and the feed doesn't post.
    h.clock.now += 8 * 60_000;
    told = [];
    leadSays = { gist: 'The fix is merged and live.', whatsNew: null };
    h.discord.push(T7004, msg(131, 'agent', 'The worker merged the fix and it is live.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(told).toEqual([['The fix is merged and live.']]);
    expect(h.core.item(lead)!.summary!.gist).toBe('The fix is merged and live.');
    expect(leadPosts()).toEqual(['Plan set; a worker is building the fix.']);
    // The lead's own news (an ask of the owner) posts.
    h.clock.now += 8 * 60_000;
    leadSays = { gist: 'Pick the rollout order.', whatsNew: 'needs your call on the rollout order' };
    h.discord.push(T7004, msg(139, 'agent', 'Next I need your call on the rollout order.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(leadPosts()).toEqual(['Pick the rollout order.', 'Plan set; a worker is building the fix.']);
    // Once the lead has posted, what its worker posted before that is behind it.
    h.clock.now += 8 * 60_000;
    told = [];
    h.discord.push(T7004, msg(147, 'agent', 'Still waiting on the rollout call.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(told).toEqual([[]]);
  });

  it("a lead back after hours is told everything its workers posted since its own last post, not just the last few hours", async () => {
    const lead = `discord:thread:${T7004}`;
    const W = snowflakeAt(NOW - 16 * 60_000);
    const worker = `discord:thread:${W}`;
    h.discord.threads = [thread(T7004, 'Lead'), thread(W, 'Worker')];
    h.discord.channels.set(T7004, [msg(-10, 'agent', 'Starting.')]);
    h.discord.channels.set(W, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'role', itemId: worker, args: { role: 'worker', parentItemId: lead } });
    h.clock.now = NOW + 2 * 3600_000;
    const told: string[][] = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      if (input.itemId === lead) told.push((input.workersPosted ?? []).map((post) => post.text));
      const last = input.messages.at(-1)!.text;
      return { ...(await model(input.itemId === lead ? 'Plan set.' : last === 'Merged and deployed.' ? 'The fix is merged and live.' : 'Building the fix.', 'Work')()), whatsNew: 'news' };
    };
    h.discord.push(T7004, msg(115, 'agent', 'Plan set.'));
    await h.source.poll();
    await h.core.drainSummaries();
    // The worker's news reaches the Feed half an hour later (a Shipped post); the lead speaks again eight hours after that.
    h.clock.now += 30 * 60_000;
    deskFeed.post({ kind: 'update', itemId: worker, title: 'Fix merged', text: 'The fix is merged and live.', data: { update: true }, key: `thread:${worker}` });
    h.clock.now += 8 * 3600_000;
    told.length = 0;
    h.discord.push(T7004, msg(625, 'agent', 'Back: the worker merged the fix earlier.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(told).toEqual([['The fix is merged and live.']]);
  });

  it('a worker posting while its lead is being summarized sends the lead back to the model with that post', async () => {
    const lead = `discord:thread:${T7004}`;
    const W = snowflakeAt(NOW - 16 * 60_000);
    const worker = `discord:thread:${W}`;
    h.discord.threads = [thread(T7004, 'Lead'), thread(W, 'Worker')];
    h.discord.channels.set(T7004, [msg(-10, 'agent', 'Starting.')]);
    h.discord.channels.set(W, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'role', itemId: worker, args: { role: 'worker', parentItemId: lead } });
    h.clock.now = NOW + 2 * 3600_000;
    // Both threads' first summaries run together; the worker's goes to its lead, not the Feed.
    h.summarizer.impl = async (input: DeskSummaryInput) => ({ ...(await model(input.itemId === lead ? 'Plan set.' : 'Worker started.', 'Work')()), whatsNew: 'started' });
    h.discord.push(T7004, msg(115, 'agent', 'Plan set.'));
    await h.source.poll();
    await h.core.drainSummaries();
    h.clock.now += 8 * 60_000;
    // The worker's post lands while the lead's model call is out: that answer is stale, and the lead is asked again.
    const told: string[][] = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      told.push((input.workersPosted ?? []).map((post) => post.text));
      if (told.length === 1) deskFeed.post({ kind: 'update', itemId: worker, title: 'Fix merged', text: 'The fix is merged and live.', data: { update: true }, key: `thread:${worker}` });
      return { ...(await model('The fix is merged and live.', 'Work')()), whatsNew: told.length === 1 ? 'fix merged and live' : null };
    };
    h.discord.push(T7004, msg(123, 'agent', 'The worker merged the fix and it is live.'));
    await h.source.poll();
    await h.core.drainSummaries();
    // The stale answer is dropped and rescheduled: the next drain runs it.
    await h.core.drainSummaries();
    expect(told).toEqual([[], ['The fix is merged and live.']]);
    expect(deskFeed.recent().filter((post) => post.itemId === lead && post.text).map((post) => post.text)).toEqual(['Plan set.']);
  });

  it("a worker's post retitled while its lead is being summarized sends the lead back to the model", async () => {
    const lead = `discord:thread:${T7004}`;
    const W = snowflakeAt(NOW - 16 * 60_000);
    const worker = `discord:thread:${W}`;
    h.discord.threads = [thread(T7004, 'Lead'), thread(W, 'Worker')];
    h.discord.channels.set(T7004, [msg(-10, 'agent', 'Starting.')]);
    h.discord.channels.set(W, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'role', itemId: worker, args: { role: 'worker', parentItemId: lead } });
    h.clock.now = NOW + 2 * 3600_000;
    h.summarizer.impl = async (input: DeskSummaryInput) => ({ ...(await model(input.itemId === lead ? 'Plan set.' : 'Worker started.', 'Work')()), whatsNew: 'started' });
    h.discord.push(T7004, msg(115, 'agent', 'Plan set.'));
    await h.source.poll();
    await h.core.drainSummaries();
    h.clock.now += 60_000;
    // A needs post from the worker; the same words with a new headline freshen it in place.
    const post = { kind: 'needs' as const, itemId: worker, text: 'Pick a rollout order.', data: { update: true, headline: true }, key: `thread:${worker}`, throttleMs: 7 * 60_000 };
    deskFeed.post({ ...post, title: 'Rollout order' });
    h.clock.now += 60_000;
    const told: string[][] = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      if (input.itemId === lead) told.push((input.workersPosted ?? []).map((p) => p.title));
      if (told.length === 1) deskFeed.post({ ...post, title: 'Rollout order: canary first?' });
      return { ...(await model('The worker needs a rollout call.', 'Work')()), whatsNew: null };
    };
    h.discord.push(T7004, msg(123, 'agent', 'The worker needs a rollout call.'));
    await h.source.poll();
    await h.core.drainSummaries();
    await h.core.drainSummaries();
    expect(told.map((titles) => titles[0])).toEqual(['Rollout order', 'Rollout order: canary first?']);
  });

  it('a summary from before v14 (no record of what posted) counts its own feed text as heard: the paragraph, not just the gist', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    const paragraph = 'The fix is built and in review; two edge cases are listed for a follow-up.';
    h.summarizer.impl = async () => ({ ...(await model('The fix is built and in review.', 'Build')()), paragraph, whatsNew: 'fix built and in review' });
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested; two edge cases noted for later.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual([paragraph]);
    // The summary as v13 left it: the paragraph posted, but no record of it.
    const id = `discord:thread:${T7006}`;
    const { postedGist: _, ...legacy } = h.core.item(id)!.summary!;
    h.core.store.patchItem(id, { summary: { ...legacy, version: 13 } });
    // The start-time re-summary of the same words (no news) writes the record: the paragraph, as the feed showed it.
    const seen: Array<string | null> = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      seen.push(input.previous?.heard ?? null);
      return { ...(await model('The fix is in review.', 'Build')()), paragraph: 'The fix is in review.', whatsNew: null };
    };
    (h.core as unknown as { scheduleSummary(id: string): void }).scheduleSummary(id);
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual([paragraph]);
    expect(h.core.item(id)!.summary!.postedGist).toBe(paragraph);
    // A later restatement of a fact only the paragraph carried is judged against the paragraph.
    h.clock.now += 8 * 60_000;
    h.discord.push(T7006, msg(123, 'agent', 'Still in review; the two edge cases are still listed for the follow-up.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(seen).toEqual([paragraph, paragraph]);
    expect(deskFeed.recent().map((p) => p.text)).toEqual([paragraph]);
  });

  it('a text fallback from before v14 (no record) on a thread that never posted leaves nothing heard: the first real summary posts', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    // The model was down: a text fallback summarized, and nothing posted. As v13 left it: no record field at all.
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested.'));
    await h.source.poll();
    await h.core.drainSummaries();
    const id = `discord:thread:${T7006}`;
    expect(h.core.item(id)!.summary).toMatchObject({ source: 'text', version: 0 });
    const { postedGist: _, ...legacy } = h.core.item(id)!.summary!;
    h.core.store.patchItem(id, { summary: legacy });
    expect(deskFeed.recent()).toEqual([]);
    // The model is back (a text fallback is never stamped current, so its words are summarized again) and, seeing the
    // fallback's words, says nothing is new: the owner heard none of it, so this first real summary posts.
    const seen: Array<string | null> = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      seen.push(input.previous?.heard ?? null);
      return { ...(await model('The fix is built and in review.', 'Build')()), whatsNew: null };
    };
    (h.core as unknown as { scheduleSummary(id: string): void }).scheduleSummary(id);
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
    expect(h.core.item(id)!.summary!.postedGist).toBe('The fix is built and in review.');
    // From here the record is real: a restatement is judged against it and doesn't post again.
    h.clock.now += 8 * 60_000;
    h.discord.push(T7006, msg(123, 'agent', 'Still waiting on the review.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(seen).toEqual([null, 'The fix is built and in review.']);
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
  });

  it('a text fallback from before v14 that followed a real post: that post is what was heard, so a restatement stays off the feed', async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    // A model summary posted.
    h.summarizer.impl = async () => ({ ...(await model('The fix is built and in review.', 'Build')()), whatsNew: 'fix built and in review' });
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
    // Then the model went down: a text fallback took the next words, as v13 left it, with no record of what posted.
    h.clock.now += 8 * 60_000;
    h.summarizer.impl = async (input: DeskSummaryInput) => fallbackSummary(input);
    h.discord.push(T7006, msg(123, 'agent', 'Still waiting on the review.'));
    await h.source.poll();
    await h.core.drainSummaries();
    const id = `discord:thread:${T7006}`;
    expect(h.core.item(id)!.summary).toMatchObject({ source: 'text', version: 0 });
    const { postedGist: _, ...legacy } = h.core.item(id)!.summary!;
    h.core.store.patchItem(id, { summary: legacy });
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
    // The model is back and says nothing is new: the owner heard the post before the fallback, so it stays one post.
    const seen: Array<string | null> = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      seen.push(input.previous?.heard ?? null);
      return { ...(await model('The fix is still in review.', 'Build')()), whatsNew: null };
    };
    (h.core as unknown as { scheduleSummary(id: string): void }).scheduleSummary(id);
    await h.core.drainSummaries();
    expect(seen).toEqual(['The fix is built and in review.']);
    expect(deskFeed.recent().map((p) => p.text)).toEqual(['The fix is built and in review.']);
    expect(h.core.item(id)!.summary!.postedGist).toBe('The fix is built and in review.');
  });

  it("a model summary from before v14 whose post the feed has let go (two weeks) counts its own feed text as heard", async () => {
    h.discord.threads = [thread(T7006)];
    h.discord.channels.set(T7006, [msg(-10, 'agent', 'Starting.')]);
    await h.source.poll();
    h.clock.now = NOW + 2 * 3600_000;
    const paragraph = 'The fix is built and in review; two edge cases are listed for a follow-up.';
    h.summarizer.impl = async () => ({ ...(await model('The fix is built and in review.', 'Build')()), paragraph, whatsNew: 'fix built and in review' });
    h.discord.push(T7006, msg(115, 'agent', 'Built the fix; review requested; two edge cases noted for later.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(deskFeed.recent().map((p) => p.text)).toEqual([paragraph]);
    // As v13 left it, and quiet for 15 days: the feed no longer has the post when the start-time re-summary runs.
    const id = `discord:thread:${T7006}`;
    const { postedGist: _, ...legacy } = h.core.item(id)!.summary!;
    h.core.store.patchItem(id, { summary: { ...legacy, version: 13 } });
    h.clock.now += 15 * 86_400_000;
    deskFeed.prune();
    expect(deskFeed.recent()).toEqual([]);
    const seen: Array<string | null> = [];
    h.summarizer.impl = async (input: DeskSummaryInput) => {
      seen.push(input.previous?.heard ?? null);
      return { ...(await model('The fix is in review.', 'Build')()), paragraph: 'The fix is in review.', whatsNew: null };
    };
    (h.core as unknown as { scheduleSummary(id: string): void }).scheduleSummary(id);
    await h.core.drainSummaries();
    expect(h.core.item(id)!.summary!.postedGist).toBe(paragraph);
    // The thread speaks again, saying where it stands: judged against what posted, not news.
    h.clock.now += 8 * 60_000;
    h.discord.push(T7006, msg(123, 'agent', 'Still in review; the two edge cases are still listed for the follow-up.'));
    await h.source.poll();
    await h.core.drainSummaries();
    expect(seen).toEqual([paragraph, paragraph]);
    expect(deskFeed.recent()).toEqual([]);
  });

  it("seeds with what was done today and the projects' digests", async () => {
    h.discord.threads = [thread(T7003)];
    h.discord.channels.set(T7003, [msg(-10, 'agent', 'Newsletter drafted.')]);
    await h.source.poll();
    await h.core.command({ commandId: cid(), type: 'done', itemId: `discord:thread:${T7003}` });
    h.core.store.setSetting('projects', JSON.stringify([{ id: 'p1', name: 'Club', color: 'blue', createdAt: NOW - 86_400_000 }]));
    h.core.store.setSetting('coordinators', JSON.stringify({ p1: { projectId: 'p1', threadId: null, createdAt: NOW, watch: {}, reach: 'approve', drafts: [], status: { text: 'Newsletter is out.', line: 'Out.', at: NOW - 60_000, basis: '', source: 'model' }, digests: [{ at: NOW - 3_600_000, text: 'Yesterday: newsletter drafted.' }] } }));
    const seed = feedSeed(h.core, NOW + 1000);
    expect(seed.map((p) => [p.kind, p.text])).toEqual([
      ['project', 'Yesterday: newsletter drafted.'],
      ['project', 'Newsletter is out.'],
      ['done', expect.any(String)],
    ]);
  });
});

describe('each event once (collapseRepeats)', () => {
  let seq = 0;
  const post = (over: Partial<FeedPost>): FeedPost => ({ seq: (seq += 1), at: 0, firstAt: 0, kind: 'update', itemId: 'a', projectId: null, agentName: 'Loom', title: '', text: '', count: 1, data: { update: true }, ...over });
  const MIN = 60_000;

  it('keeps a Needs you post and the later summary that restates it', () => {
    const needs = post({ at: 0, kind: 'needs', title: 'Spec ready for approval', text: 'The Feed status spec is drafted and waiting on your approval to build it in three parts.' });
    const later = post({ at: 5 * MIN, title: 'Spec ready for approval', text: 'The Feed status spec is drafted and still waiting on your approval to build it in three parts.' });
    expect(collapseRepeats([later, needs]).map((p) => p.seq)).toEqual([later.seq, needs.seq]);
  });

  it('shows one owner decision once when three posts tell it', () => {
    const first = post({ at: 0, itemId: 'worker', title: 'Owner approves the small build', text: 'You picked the recommended small version: cap agent builds and tests first, then add an away button.' });
    const lead = post({ at: 10_000, itemId: 'lead', title: 'All three parts being built', text: 'You picked the recommended option, so the worker is building all three parts: cap on agent builds and tests, the away button.' });
    const again = post({ at: 20_000, itemId: 'worker', kind: 'needs', title: 'Resource caps approved', text: 'The owner approved the small version: cap agent builds and tests, add an away button.' });
    const link = post({ kind: 'mail', itemId: null, at: 30_000, text: 'Build it in this thread', data: { from: 'lead', to: 'worker' } });
    expect(collapseRepeats([again, lead, first], [link, again, lead, first]).map((p) => p.seq)).toEqual([again.seq]);
    expect(collapseRepeats([again, lead, first], [link, again, lead, first])[0]!.count).toBe(2);
    // Unrelated threads (no shared project, no mail between them) keep their own tellings.
    expect(collapseRepeats([again, lead, first]).map((p) => p.seq)).toEqual([again.seq, lead.seq]);
  });

  it('keeps two different owner decisions apart, and relates threads by project as the thread has it now', () => {
    const red = post({ at: 0, itemId: 'a', title: 'Owner approved the red design', text: 'You approved the red design for the checkout button and the colour tokens.' });
    const blue = post({ at: MIN, itemId: 'a', title: 'Owner approved the blue launch schedule', text: 'You approved the blue launch schedule for the November release train.' });
    expect(collapseRepeats([blue, red]).map((p) => p.seq)).toEqual([blue.seq, red.seq]);
    const worker = post({ at: 0, itemId: 'w', title: 'Both desk fixes merged and running', text: 'The ask box fix and the start fix are merged and running.' });
    const lead = post({ at: 5 * MIN, itemId: 'l', title: 'Both desk fixes merged and live', text: 'The ask box fix and the start fix are merged and live.' });
    expect(collapseRepeats([lead, worker], [lead, worker], () => 'p1').map((p) => p.seq)).toEqual([worker.seq]);
  });

  it('keeps distinct news from one thread, and the same words from another thread much later', () => {
    const a = post({ at: 0, title: 'Third review found one more edge case', text: 'A title that is only an id showed the bare id.' });
    const b = post({ at: 5 * MIN, title: 'Checks green; merging and deploying now', text: 'The last review left one small case and checks are green.' });
    const c = post({ at: 60 * MIN, itemId: 'other', title: 'Checks green; merging and deploying now', text: 'The last review left one small case and checks are green.' });
    expect(collapseRepeats([c, b, a]).map((p) => p.seq)).toEqual([c.seq, b.seq, a.seq]);
  });

  it('keeps a lead\'s retelling out when it repeats its worker\'s news within minutes', () => {
    const worker = post({ at: 0, itemId: 'worker', title: 'Both desk fixes merged and running', text: 'The ask box fix and the start fix are merged and running.' });
    const lead = post({ at: 5 * MIN, itemId: 'lead', title: 'Both desk fixes merged and live', text: 'The ask box fix and the start fix are merged and live.' });
    const link = post({ kind: 'mail', itemId: null, at: 6 * MIN, text: 'Fixes are live', data: { from: 'worker', to: 'lead' } });
    expect(collapseRepeats([lead, worker], [link, lead, worker]).map((p) => p.seq)).toEqual([worker.seq]);
    expect(collapseRepeats([lead, worker]).map((p) => p.seq)).toEqual([lead.seq, worker.seq]);
  });

  it('drops mail receipts and a mail its thread then restates; keeps agents actually talking', () => {
    const receipt = post({ kind: 'mail', itemId: null, at: 0, text: "The owner's words went straight to “x” [loom:1]", data: { from: 'a', to: 'b' } });
    const talk = post({ kind: 'mail', itemId: null, at: 0, text: 'Which port does the tile server listen on?', data: { from: 'a', to: 'b' } });
    const echo = post({ kind: 'mail', itemId: null, at: 0, text: 'Build the approved plan in this thread, one slice per PR', data: { from: 'lead', to: 'b' } });
    const before = post({ at: -MIN, itemId: 'b', title: 'Build approved', text: 'Told to build the approved plan in this thread, one slice per PR.' });
    expect(collapseRepeats([echo, before]).map((p) => p.seq)).toEqual([echo.seq, before.seq]);
    const update = post({ at: MIN, itemId: 'b', title: 'Build approved', text: 'Told to build the approved plan in this thread, one slice per PR.' });
    const bundled = post({ kind: 'mail', itemId: null, at: 0, count: 2, text: "The owner's words went straight to “x” [loom:1]", data: { from: 'a', to: 'b' } });
    expect(collapseRepeats([bundled]).map((p) => p.seq)).toEqual([bundled.seq]);
    expect(collapseRepeats([update, echo, talk, receipt]).map((p) => p.seq)).toEqual([update.seq, talk.seq]);
  });

  it('keeps a failure and its recovery as two events', () => {
    const failed = post({ at: 0, itemId: 'a', title: 'Deployment failed production health checks', text: 'The deployment failed the production health checks.' });
    const passed = post({ at: 5 * MIN, itemId: 'a', title: 'Deployment passed production health checks', text: 'The deployment passed the production health checks.' });
    expect(collapseRepeats([passed, failed]).map((p) => p.seq)).toEqual([passed.seq, failed.seq]);
  });

  it('uses mail a scope leaves out to relate threads', () => {
    const worker = post({ at: 0, itemId: 'w', title: 'Both desk fixes merged and running', text: 'The ask box fix and the start fix are merged and running.' });
    const lead = post({ at: 5 * MIN, itemId: 'l', title: 'Both desk fixes merged and live', text: 'The ask box fix and the start fix are merged and live.' });
    const link = post({ kind: 'mail', itemId: null, at: 6 * MIN, text: 'Fixes are live', data: { from: 'w', to: 'l' } });
    const shown = showAs([lead, worker], { chatter: 'hidden', needsYou: true } as FeedSettings, undefined, [link]);
    expect(shown.map((p) => p.seq)).toEqual([worker.seq]);
  });

  it('keeps a recovery that names its failure apart, and decisions that pick different options apart', () => {
    const failed = post({ at: 0, itemId: 'a', title: 'Deployment failed production health checks', text: 'The deployment failed the production health checks.' });
    const healthy = post({ at: 5 * MIN, itemId: 'a', title: 'Deployment is healthy again after failed production health checks', text: 'The deployment is healthy again after the failed production health checks.' });
    expect(collapseRepeats([healthy, failed]).map((p) => p.seq)).toEqual([healthy.seq, failed.seq]);
    const dark = post({ at: 0, itemId: 'a', title: 'Owner approved dark mode for the checkout button', text: 'You approved dark mode for the checkout button after accessibility review.' });
    const light = post({ at: MIN, itemId: 'b', title: 'Owner approved light mode for the checkout button', text: 'You approved light mode for the checkout button after accessibility review.' });
    expect(collapseRepeats([light, dark], [light, dark], () => 'p1').map((p) => p.seq)).toEqual([light.seq, dark.seq]);
  });
});

describe('what is new (summary v14)', () => {
  const input: DeskSummaryInput = { agentName: 'Loom', place: null, messages: [{ author: 'agent', text: 'Built it and asked for a review.' }] };
  it('keeps what the model says is new, and null when it says nothing is', () => {
    expect(parseModelSummary(JSON.stringify({ gist: 'Built.', step: 'fyi', whatsNew: 'fix built and sent for review' }), input).whatsNew).toBe('fix built and sent for review');
    expect(parseModelSummary(JSON.stringify({ gist: 'Built.', step: 'fyi', whatsNew: null }), input).whatsNew).toBeNull();
    expect(parseModelSummary(JSON.stringify({ gist: 'Built.', step: 'fyi', whatsNew: '  ' }), input).whatsNew).toBeNull();
    expect(parseModelSummary(JSON.stringify({ gist: 'Built.', step: 'fyi' }), input).whatsNew).toBeNull();
    // A recurring run with nothing new: only a literal true holds the post.
    expect(parseModelSummary(JSON.stringify({ gist: 'Check ran.', step: 'fyi', routine: true }), input).routine).toBe(true);
    expect(parseModelSummary(JSON.stringify({ gist: 'Check ran.', step: 'fyi', routine: 'yes' }), input).routine).toBe(false);
    expect(parseModelSummary(JSON.stringify({ gist: 'Built.', step: 'fyi' }), input).routine).toBe(false);
  });
});
