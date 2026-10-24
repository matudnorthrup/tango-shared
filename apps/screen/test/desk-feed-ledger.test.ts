import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DeskFeed } from '../server/desk/feed.js';
import { followLedger, ledgerPost } from '../server/desk/feed-ledger.js';
import { DeskUpdates, type DeskUpdate } from '../server/desk/updates.js';
import { NOW } from './desk-harness.js';

// The Feed's posts from the catch-up ledger (docs/specs/feed-status.md "Feed and catch-up"): Decided for you, Shipped
// and a lead's own Update, each ledger row once, rows about one PR folded into one post by the PR, not by words.

const PR = 'https://github.com/acme/app/pull/12';
let nextId = 1;
function line(over: Partial<DeskUpdate>): DeskUpdate {
  const id = over.id ?? nextId++;
  return {
    id, spaceId: 'project:desk', itemId: 'loom:lead', kind: 'fyi', moment: false, title: `line ${id}`, detail: null, refs: [], shot: null, briefId: null, decisionId: null, class: null,
    coversFrom: null, coversTo: null, data: {}, source: 'lead', subject: `lead:${id}`, supersedes: null, supersededBy: null, at: NOW - 1000, seenAt: null, seenVia: null,
    outcome: null, backAt: null, resolvedAt: null, ...over,
  };
}
const merged = (over: Partial<DeskUpdate> = {}) => line({ kind: 'shipped', source: 'auto:pr', title: 'Merged PR #12: feat(desk): the new feed', refs: [{ label: 'PR #12', url: PR }], subject: 'pr:acme/app#12', ...over });
const routine = (over: Partial<DeskUpdate> = {}) => line({ kind: 'decided', source: 'auto:decision', title: 'Merged #12 once green', class: 'merge-when-green', refs: [{ label: 'PR', url: PR }], subject: `decision:D-${nextId}`, decisionId: 'D-1', ...over });

function feedOf() {
  const clock = { now: NOW };
  const feed = new DeskFeed(new DatabaseSync(':memory:'), () => clock.now);
  const post = (l: DeskUpdate) => {
    const input = ledgerPost(l, null, clock.now);
    return input ? feed.postLedger(input) : null;
  };
  const all = () => feed.recent({ settings: { chatter: 'hidden', needsYou: true, summaries: false } });
  return { feed, clock, post, all };
}

describe('which ledger rows post', () => {
  it('posts lead, merged PR and decision rows by their kind; a lead in a status pill, other sources and old rows do not', () => {
    expect(ledgerPost(line({ kind: 'fyi' }), null, NOW)?.post.kind).toBe('update');
    expect(ledgerPost(merged(), null, NOW)?.post.kind).toBe('shipped');
    expect(ledgerPost(routine(), null, NOW)?.post.kind).toBe('decided');
    expect(ledgerPost(line({ kind: 'needs' }), null, NOW)).toBeNull();
    expect(ledgerPost(line({ kind: 'failed' }), null, NOW)).toBeNull();
    for (const source of ['auto:brief', 'auto:status', 'auto:incident', 'auto:done'] as const) expect(ledgerPost(line({ kind: 'fyi', source }), null, NOW)).toBeNull();
    expect(ledgerPost(line({ at: NOW - 3 * 3600_000 }), null, NOW)).toBeNull();
    expect(ledgerPost(line({ supersededBy: 99 }), null, NOW)).toBeNull();
    expect(ledgerPost(routine({ seenVia: 'acted' }), null, NOW)).toBeNull();
  });

  it('keys a row by its PR only when it is about the PR', () => {
    expect(ledgerPost(merged(), null, NOW)!.post.key).toBe('pr:acme/app#12');
    expect(ledgerPost(line({ refs: [{ label: 'PR', url: PR }] }), null, NOW)!.post.key).toBe('pr:acme/app#12');
    expect(ledgerPost(routine(), null, NOW)!.post.key).toBe('pr:acme/app#12');
    // A decision that only links the PR for context, or a moment, is its own news.
    expect(ledgerPost(routine({ class: 'ops-own-machine', title: 'Restarted the sandbox' }), null, NOW)!.pr).toBe(false);
    expect(ledgerPost(routine({ moment: true }), null, NOW)!.pr).toBe(false);
  });
});

describe('ledger posts fold by PR', () => {
  it("a lead's update and the merge are one Shipped post in the lead's words, either order", () => {
    for (const order of ['lead first', 'merge first']) {
      const { post, all } = feedOf();
      const lead = line({ title: 'The new feed is live', detail: 'Built and merged.', refs: [{ label: 'PR', url: PR }] });
      const pr = merged();
      for (const l of order === 'lead first' ? [lead, pr] : [pr, lead]) post(l);
      const posts = all();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ kind: 'shipped', title: 'The new feed is live', text: 'Built and merged.', data: { ref: expect.arrayContaining([`ledger:${lead.id}`, `ledger:${pr.id}`]), lead: true } });
    }
  });

  it('a routine decision posts as Decided until the PR merges, then the Shipped post takes it in; after, it folds straight in', () => {
    const { post, all } = feedOf();
    const before = routine();
    post(before);
    expect(all().map((p) => p.kind)).toEqual(['decided']);
    const pr = merged();
    post(pr);
    expect(all()).toMatchObject([{ kind: 'shipped', title: 'The new feed', count: 2, data: { ref: expect.arrayContaining([`ledger:${before.id}`, `ledger:${pr.id}`]) } }]);
    post(routine());
    expect(all()).toMatchObject([{ kind: 'shipped', title: 'The new feed', count: 3 }]);
  });

  it('posts a row once, and a replaced line rewrites its post in place', () => {
    const { post, all } = feedOf();
    const first = line({ title: 'Building it', subject: 'lead:a' });
    post(first);
    post(first);
    expect(all()).toHaveLength(1);
    post(line({ title: 'Built it', subject: 'lead:a', supersedes: first.id }));
    expect(all()).toMatchObject([{ kind: 'update', title: 'Built it', count: 1 }]);
  });

  it('follows the ledger as rows are written', () => {
    const db = new DatabaseSync(':memory:');
    const clock = { now: NOW };
    const updates = new DeskUpdates({ db, items: () => [], spaceOf: () => null, exec: null, now: () => clock.now });
    const feed = new DeskFeed(db, () => clock.now);
    followLedger(updates, feed, () => null, () => clock.now);
    updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'fyi', title: 'Started the second part', source: 'lead', subject: 'lead:x' });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'needs', title: 'Pick a name', source: 'auto:brief', subject: 'brief:x' });
    expect(feed.recent().map((p) => [p.kind, p.title])).toEqual([['update', 'Started the second part']]);
    expect(feed.ledgerPosted('loom:lead', NOW - 1000)).toBe(true);
    expect(feed.ledgerPosted('loom:lead', NOW - 1000, { lead: true })).toBe(true);
    expect(feed.ledgerPosted('loom:other', NOW - 1000)).toBe(false);
  });

  it("a retracted line takes its post with it: the lead's own line replacing an automatic Finished line is one post", () => {
    const db = new DatabaseSync(':memory:');
    const clock = { now: NOW };
    const updates = new DeskUpdates({ db, items: () => [], spaceOf: () => null, exec: null, now: () => clock.now });
    const feed = new DeskFeed(db, () => clock.now);
    followLedger(updates, feed, () => null, () => clock.now);
    updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'shipped', title: 'Merged the map', source: 'auto:handoff', subject: 'handoff:loom:lead:run-1' });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:lead', kind: 'shipped', title: 'Shipped the map', source: 'lead', subject: 'lead:map' });
    expect(feed.recent().map((p) => p.title)).toEqual(['Shipped the map', 'Merged the map']);
    updates.retract('handoff:loom:lead:run-1');
    expect(feed.recent().map((p) => [p.kind, p.title])).toEqual([['shipped', 'Shipped the map']]);
  });

  it('word filters never fold a ledger post away', () => {
    const { feed, post, all, clock } = feedOf();
    post(line({ itemId: 'loom:a', title: 'The new feed reads the ledger now', detail: 'Decided, Shipped and Update posts come from records.' }));
    clock.now += 60_000;
    feed.post({ kind: 'update', itemId: 'loom:a', title: 'The new feed reads the ledger now', text: 'Decided, Shipped and Update posts come from the records.', data: { update: true, summary: true }, key: 'thread:loom:a' });
    expect(all()).toHaveLength(2);
  });

  it("a thread's Update drops the Summary the throttle holds for it, on its timer and at shutdown", () => {
    for (const end of ['timer', 'close']) {
      vi.useFakeTimers();
      const { feed, post, all, clock } = feedOf();
      const summary = (title: string) => feed.post({ kind: 'update', itemId: 'loom:lead', title, data: { update: true, summary: true }, key: 'thread:loom:lead', throttleMs: 7 * 60_000 });
      summary('Working on the feed');
      clock.now += 60_000;
      expect(summary('Still on the feed')).toBeNull();
      post(line({ title: 'The feed reads the ledger', at: clock.now }));
      if (end === 'timer') {
        clock.now += 7 * 60_000;
        vi.advanceTimersByTime(7 * 60_000);
      } else feed.close();
      expect(all().map((p) => p.title)).toEqual(['The feed reads the ledger', 'Working on the feed']);
      vi.useRealTimers();
    }
  });

  it('a replaced line counts as written when it was replaced, not when its post first went out', () => {
    const { feed, post, clock } = feedOf();
    const first = line({ title: 'Building it', subject: 'lead:a', at: clock.now });
    post(first);
    clock.now += 8 * 60_000;
    expect(feed.ledgerPosted('loom:lead', clock.now - 7 * 60_000)).toBe(false);
    post(line({ title: 'Built it', subject: 'lead:a', supersedes: first.id, at: clock.now }));
    expect(feed.ledgerPosted('loom:lead', clock.now - 7 * 60_000)).toBe(true);
  });

  it("a lead's update folded into another thread's merge is the lead's post, and both threads count as posting", () => {
    const { feed, post, all } = feedOf();
    post(merged({ itemId: 'loom:worker' }));
    post(line({ itemId: 'loom:lead', title: 'The new feed is live', refs: [{ label: 'PR', url: PR }] }));
    expect(all()).toMatchObject([{ kind: 'shipped', itemId: 'loom:lead', title: 'The new feed is live' }]);
    expect(feed.ledgerPosted('loom:lead', NOW - 5000, { lead: true })).toBe(true);
    expect(feed.ledgerPosted('loom:worker', NOW - 5000)).toBe(true);
    expect(feed.ledgerPosted('loom:worker', NOW - 5000, { lead: true })).toBe(false);
  });

  it('a replaced line that gains a PR link takes its old post with it', () => {
    const { post, all } = feedOf();
    const first = line({ title: 'Building the feed', subject: 'lead:a' });
    post(first);
    post(merged({ itemId: 'loom:worker' }));
    post(line({ title: 'The new feed is live', subject: 'lead:a', supersedes: first.id, refs: [{ label: 'PR', url: PR }] }));
    expect(all()).toMatchObject([{ kind: 'shipped', title: 'The new feed is live', itemId: 'loom:lead' }]);
  });

  it("a worker's ledger words reach its lead's summary, under whatever key they folded into", () => {
    const { feed, post } = feedOf();
    post(merged({ itemId: 'loom:worker', title: 'Merged PR #12: the new feed', detail: 'Merged.' }));
    post(line({ itemId: 'loom:worker', title: 'Tests pass', detail: 'All green.', subject: 'lead:w' }));
    expect(feed.postedSince([], NOW - 5000, 8, undefined, ['loom:worker']).map((p) => p.text).sort()).toEqual(['All green.', 'Merged.']);
    expect(feed.postedSince([], NOW - 5000, 8, undefined, ['loom:other'])).toEqual([]);
  });

  it('a replaced line rewrites its post however long ago it went out', () => {
    const { post, all, clock } = feedOf();
    const first = line({ title: 'Building it', subject: 'lead:a', at: clock.now });
    post(first);
    clock.now += 25 * 3600_000;
    post(line({ title: 'Built it', subject: 'lead:a', supersedes: first.id, at: clock.now }));
    expect(all()).toMatchObject([{ kind: 'update', title: 'Built it' }]);
  });

  it('a Shipped line with no PR, corrected, takes the pill of the correction (Codex review on #943)', () => {
    const { post, all } = feedOf();
    const first = line({ kind: 'shipped', title: 'Deployed the desk', subject: 'lead:a' });
    post(first);
    post(line({ kind: 'fyi', title: 'Correction: deployment is still awaiting approval', subject: 'lead:a', supersedes: first.id }));
    expect(all()).toMatchObject([{ kind: 'update', title: 'Correction: deployment is still awaiting approval' }]);
  });

  it("a merge with no detail still tells a lead its worker's news (Codex review on #943)", () => {
    const { feed, post } = feedOf();
    post(merged({ itemId: 'loom:worker', detail: null }));
    expect(feed.postedSince([], NOW - 5000, 8, undefined, ['loom:worker'])).toMatchObject([{ title: 'The new feed', text: '' }]);
  });

  it('a post rewritten lately outlives the two-week prune (Codex review on #943)', () => {
    const { feed, post, all, clock } = feedOf();
    let prev = line({ title: 'Day 0', subject: 'lead:a', at: clock.now });
    post(prev);
    for (let day = 1; day <= 15; day += 1) {
      clock.now += 24 * 3600_000;
      const next = line({ title: `Day ${day}`, subject: 'lead:a', supersedes: prev.id, at: clock.now });
      post(next);
      prev = next;
    }
    feed.prune();
    expect(all()).toMatchObject([{ title: 'Day 15' }]);
  });
});
