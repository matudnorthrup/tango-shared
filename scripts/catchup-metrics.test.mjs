import assert from "node:assert/strict";
import test from "node:test";
import { ownedAsks, acceptUsage, quantile, briefLines, chapterOutcomes, handling, leadReplyWords, momentsPerSpace, neverOpenedAfterAway } from "./catchup-metrics.mjs";

const DAY = 86_400_000;
const NOW = 100 * DAY;

test("a lead's final reply is the last message of each run, and interactive threads count on their own", () => {
  const r = leadReplyWords([
    { thread_id: "a", run_id: "r1", role: "default", text: "working on it", created_at: 1 },
    { thread_id: "a", run_id: "r1", role: "default", text: "done: merged and live", created_at: 2 },
    { thread_id: "b", run_id: "r2", role: "default", text: "one two three four five six", created_at: 3 },
    { thread_id: "c", run_id: "r3", role: "interactive", text: "a much longer answer to the owner here", created_at: 4 },
  ]);
  assert.equal(r.leads.replies, 2);
  assert.equal(r.leads.median, 4); // nearest rank: the smaller of two
  assert.equal(r.leads.p90, 6);
  assert.equal(r.leads.target, 60);
  assert.equal(r.interactive.replies, 1);
  assert.equal(r.interactive.median, 8);
});

test("moments handled within a day; a deferral isn't handling", () => {
  const at = NOW - 3 * DAY;
  const r = handling(
    [
      { space_id: "s", at, seen_at: at + 1000, seen_via: "read" },
      { space_id: "s", at, seen_at: at + 2 * DAY, seen_via: "read" }, // late
      { space_id: "t", at, seen_at: at + 1000, seen_via: "accepted" },
      { space_id: "u", at, seen_at: at + 1000, seen_via: "deferred" }, // deferred isn't handled
      { space_id: "v", at: NOW - 1000, seen_at: null, seen_via: null }, // too new to count
      { space_id: "w", at, seen_at: null, seen_via: null, superseded_by: 9 }, // replaced unseen: the newer line counts
      { space_id: "w", at, seen_at: at + 2 * DAY, seen_via: "read", superseded_by: 9 }, // seen, then replaced: still counts
    ],
    NOW,
  );
  assert.equal(r.moments, 5);
  assert.equal(r.handledWithinDay, 0.4);
});

test("a chapter is one Accept or Defer, however many lines or days it spans", () => {
  const r = chapterOutcomes([
    // One Accept over two days' moments and a smaller line: one chapter.
    { space_id: "s", seen_at: 5 * DAY, seen_via: "accepted" },
    { space_id: "s", seen_at: 5 * DAY, seen_via: "accepted" },
    { space_id: "s", seen_at: 5 * DAY, seen_via: "accepted" },
    // A chapter of smaller updates only, deferred.
    { space_id: "t", seen_at: 5 * DAY, seen_via: "deferred" },
    { space_id: "t", seen_at: 5 * DAY, seen_via: "deferred" },
    // The same space accepted again later: a second chapter.
    { space_id: "s", seen_at: 6 * DAY, seen_via: "accepted" },
    // That Accept's next writes, a moment and then 40 s later (it waited on Loom): still one chapter.
    { space_id: "s", seen_at: 6 * DAY + 3, seen_via: "accepted" },
    { space_id: "s", seen_at: 6 * DAY + 40_000, seen_via: "accepted" },
    { space_id: "u", seen_at: 5 * DAY, seen_via: "read" }, // handled one by one, not a chapter action
  ]);
  assert.equal(r.chapters, 3);
  assert.equal(r.caughtUp, 2);
  assert.equal(r.left, 1);
});

test("Accept against one by one, with reversals within 7 days", () => {
  const r = acceptUsage(
    [
      { brief_id: "D-1", decision_id: "D-1", seen_via: "accepted", outcome: "A", resolved_at: 10 * DAY, seen_at: 10 * DAY },
      { brief_id: "D-2", decision_id: "D-2", seen_via: "accepted", outcome: "fine", resolved_at: 10 * DAY, seen_at: 10 * DAY },
      { brief_id: "D-3", decision_id: "D-3", seen_via: "acted", outcome: "B", resolved_at: 10 * DAY, seen_at: 10 * DAY },
      { brief_id: "D-4", decision_id: "D-4", seen_via: null, outcome: null, resolved_at: null, seen_at: null }, // still open
      // Left for the owner by an Accept (marked accepted, no outcome), answered one by one later.
      { brief_id: "D-5", decision_id: "D-5", seen_via: "accepted", outcome: null, resolved_at: 11 * DAY, seen_at: 10 * DAY },
      // Resolved without the owner: a default ran, or the brief went moot. Neither is an answer.
      { brief_id: "D-6", decision_id: "D-6", seen_via: null, outcome: null, resolved_at: 11 * DAY, seen_at: null },
      { brief_id: "D-7", decision_id: "D-7", seen_via: "accepted", outcome: null, resolved_at: 11 * DAY, seen_at: 10 * DAY },
    ],
    [
      { id: "D-1", status: "answered", supersedes: null, created_at: 9 * DAY, resolved_at: 10 * DAY, reversed_at: 12 * DAY },
      { id: "D-2", status: "answered", supersedes: null, created_at: 9 * DAY, resolved_at: 10 * DAY, reversed_at: null },
      { id: "D-3", status: "answered", supersedes: null, created_at: 9 * DAY, resolved_at: 10 * DAY, reversed_at: null },
      { id: "D-5", status: "answered", supersedes: null, created_at: 9 * DAY, resolved_at: 11 * DAY, reversed_at: 12 * DAY },
      { id: "D-6", status: "defaulted", supersedes: null, created_at: 9 * DAY, resolved_at: 11 * DAY, reversed_at: null },
      { id: "D-7", status: "moot", supersedes: null, created_at: 9 * DAY, resolved_at: 11 * DAY, reversed_at: null },
      { id: "D-8", status: "answered", supersedes: "D-7", created_at: 12 * DAY, resolved_at: null, reversed_at: null }, // replaces a moot brief: no reversal
      { id: "D-9", supersedes: "D-3", created_at: 20 * DAY, resolved_at: null, reversed_at: null }, // too late to count
    ],
    NOW,
  );
  assert.equal(r.answered, 4);
  assert.equal(r.accept.briefs, 2);
  assert.equal(r.accept.reversedIn7d, 1);
  assert.equal(r.oneByOne.briefs, 2);
  assert.equal(r.oneByOne.reversedIn7d, 1);
  assert.equal(r.accept.reversalRate, 0.5);
});

test("a reversal rate counts only answers a week old", () => {
  const recent = NOW - 2 * DAY;
  const r = acceptUsage(
    [
      { brief_id: "D-1", decision_id: "D-1", seen_via: "accepted", outcome: "A", resolved_at: NOW - 10 * DAY, seen_at: NOW - 10 * DAY },
      { brief_id: "D-2", decision_id: "D-2", seen_via: "accepted", outcome: "A", resolved_at: recent, seen_at: recent }, // window still open
    ],
    [
      { id: "D-1", supersedes: null, created_at: NOW - 11 * DAY, resolved_at: NOW - 10 * DAY, reversed_at: NOW - 9 * DAY },
      { id: "D-2", supersedes: null, created_at: recent, resolved_at: recent, reversed_at: null },
    ],
    NOW,
  );
  assert.equal(r.accept.briefs, 2);
  assert.equal(r.accept.settled, 1);
  assert.equal(r.accept.reversalRate, 1);
});

test("one line per brief: the answered one, superseded or not, else the latest", () => {
  const lines = briefLines([
    { brief_id: "D-1", at: 1, resolved_at: 5 }, // answered, then superseded by its decided line
    { brief_id: "D-1", at: 3, resolved_at: null }, // a revision still showing
    { brief_id: "D-2", at: 1, resolved_at: null },
    { brief_id: "D-2", at: 2, resolved_at: null },
  ]);
  assert.deepEqual(lines.map((l) => [l.brief_id, l.at]), [["D-1", 1], ["D-2", 2]]);
});

test("moments per space per day, busiest first", () => {
  const since = NOW - 14 * DAY;
  const r = momentsPerSpace(
    [
      { space_id: "a", at: since + DAY },
      { space_id: "a", at: since + 8 * DAY },
      { space_id: "b", at: since + 9 * DAY },
    ],
    since,
    NOW,
  );
  assert.equal(r.spaces[0].space, "a");
  assert.equal(r.spaces[0].perDay, 2 / 14);
  assert.deepEqual(r.byWeek.map((w) => w.week), [1, 2]);
});

test("a moment replaced before the owner saw it isn't counted again", () => {
  const from = NOW - DAY;
  const r = momentsPerSpace(
    [
      { space_id: "a", at: from, superseded_by: 2, seen_at: null },
      { space_id: "a", at: from, superseded_by: 3, seen_at: null },
      { space_id: "a", at: from, superseded_by: null, seen_at: null },
      { space_id: "b", at: from, superseded_by: 5, seen_at: from + 1000 }, // seen, then replaced: it reached the owner
    ],
    from,
    NOW,
  );
  assert.equal(r.perDay, 2);
  assert.deepEqual(r.spaces.map((s) => [s.space, s.perDay]), [["a", 1], ["b", 1]]);
});

test("per-day rates divide by the days the data covers, not the whole window", () => {
  // The ledger starts two days before now, inside a 14-day window: 6 moments is 3 a day, not 6/14.
  const from = NOW - 2 * DAY;
  const r = momentsPerSpace([0, 1, 2, 3, 4, 5].map((i) => ({ space_id: "a", at: from + i * 3_600_000 })), from, NOW);
  assert.equal(r.perDay, 3);
  assert.equal(r.spaces[0].perDay, 3);
  assert.deepEqual(r.byWeek, [{ week: 1, perDay: 3 }]);
});

test("a thread posted in while away and not opened soon after counts as never opened", () => {
  const presence = [
    { start: 0, last: 10 * DAY },
    { start: 11 * DAY, last: 12 * DAY }, // a day away
  ];
  const posts = [
    { item_id: "loom:a", at: 10.5 * DAY },
    { item_id: "loom:b", at: 10.5 * DAY },
    { item_id: "loom:c", at: 5 * DAY }, // while present
  ];
  const opens = [{ item_id: "loom:a", at: 11.2 * DAY }];
  const r = neverOpenedAfterAway(presence, posts, opens, 4 * 3_600_000, NOW);
  assert.equal(r.stretches, 1);
  assert.equal(r.activeThreads, 2);
  assert.equal(r.neverOpened, 1);
  assert.equal(r.longestGapMs, DAY);
});

test("an away stretch the window starts inside counts, from the span before it", () => {
  // The read query adds the last span before the window; here it ends at day 10, and the owner returns at day 11.
  const presence = [
    { start: 11 * DAY, last: 12 * DAY },
    { start: 0, last: 10 * DAY },
  ];
  const r = neverOpenedAfterAway(presence, [{ item_id: "loom:a", at: 10.8 * DAY }], [], 4 * 3_600_000, NOW);
  assert.equal(r.stretches, 1);
  assert.equal(r.neverOpened, 1);
});

test("percentiles are nearest rank", () => {
  assert.equal(quantile([1, 2], 0.5), 1);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.5), null);
});

test("a quiet week still shows, at zero", () => {
  const since = NOW - 14 * DAY;
  const r = momentsPerSpace([{ space_id: "a", at: since + DAY }], since, NOW);
  assert.deepEqual(r.byWeek, [{ week: 1, perDay: 1 / 7 }, { week: 2, perDay: 0 }]);
});


test("owned asks count copies at posting time and stale own-thread replies, within the window", () => {
  const title = "Approve the revised launch plan for the sample service";
  const line = (item_id, at, extra = {}) => ({ item_id, at, title, source: "auto:status", resolved_at: null, superseded_by: null, ...extra });
  const lines = [
    line("loom:worker", NOW - 3 * DAY),
    line("loom:lead", NOW - DAY),
    line("loom:lead", NOW - DAY, { title: "D-358 is still open", source: "lead" }),
    line("loom:lead", NOW - DAY, { title: "D-3580 is still open", source: "lead" }),
    line("loom:unrelated", NOW - DAY),
    line("loom:closed", NOW - DAY, { resolved_at: NOW - 1000 }),
    line("loom:replaced", NOW - DAY, { superseded_by: 99, superseded_at: NOW - 1000 }),
    line("loom:short", NOW - DAY, { title: "Approve?" }),
    line("loom:worker", NOW - 3 * DAY, { title: "Approve?" }),
  ];
  const decisions = [{ id: "D-358", thread_id: "worker", created_at: NOW - 2 * DAY, resolved_at: NOW - 1000 }];
  const threads = [{ id: "worker", role: "worker", parent_thread_id: "loom:lead" }];
  const posts = ["lead", "closed", "replaced"].map(id => ({ item_id: `loom:${id}`, at: NOW - DAY / 2 }));
  posts.push({ item_id: "loom:unrelated", at: NOW - 1000 });
  assert.deepEqual(ownedAsks(lines, decisions, threads, posts, NOW - 2 * DAY, NOW), { asks: 7, copies: 2, stillOpenAfterReply: 3 });
  decisions[0].resolved_at = NOW - 2 * DAY;
  assert.equal(ownedAsks(lines, decisions, threads, posts, NOW - 2 * DAY, NOW).copies, 1);
});

test("the metrics CLI reads synthetic databases with the same window flags", async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'catchup-owned-asks-'));
  try {
    const screen = new DatabaseSync(join(dir, 'screen.db'));
    const loom = new DatabaseSync(join(dir, 'loom.sqlite'));
    screen.exec(`CREATE TABLE desk_updates (id INTEGER PRIMARY KEY, item_id TEXT, space_id TEXT, kind TEXT,
      title TEXT, source TEXT, at INTEGER, moment INTEGER, seen_at INTEGER, seen_via TEXT,
      superseded_by INTEGER, resolved_at INTEGER, brief_id TEXT, decision_id TEXT, outcome TEXT);
      CREATE TABLE desk_messages (item_id TEXT, author TEXT, at INTEGER);
      CREATE TABLE desk_events (item_id TEXT, type TEXT, at INTEGER, payload TEXT);`);
    loom.exec(`CREATE TABLE threads (id TEXT, role TEXT, parent_thread_id TEXT);
      CREATE TABLE runs (id TEXT, status TEXT);
      CREATE TABLE messages (thread_id TEXT, run_id TEXT, role TEXT, text TEXT, origin TEXT, created_at INTEGER);
      CREATE TABLE decisions (id TEXT, thread_id TEXT, status TEXT, supersedes TEXT, created_at INTEGER,
        resolved_at INTEGER, reversed_at INTEGER);
      CREATE TABLE presence (start INTEGER, last INTEGER);`);
    const now = Date.now();
    const title = 'Approve the revised launch plan for the sample service';
    const insert = screen.prepare("INSERT INTO desk_updates (id,item_id,space_id,kind,title,source,at,moment) VALUES (?,?,'project:sample','needs',?,?,?,1)");
    insert.run(1, 'loom:worker', title, 'auto:status', now - 2 * DAY);
    insert.run(2, 'loom:lead', title, 'auto:status', now - DAY);
    insert.run(3, 'loom:lead', 'D-358 is still open', 'lead', now - DAY);
    loom.exec("INSERT INTO threads VALUES ('worker','worker','loom:lead'),('lead','default',NULL)");
    loom.prepare("INSERT INTO decisions (id,thread_id,status,created_at) VALUES ('D-358','worker','open',?)").run(now - 2 * DAY);
    loom.prepare("INSERT INTO messages (thread_id,role,text,created_at) VALUES ('lead','user','Approved',?)").run(now - 3 * 3_600_000);
    // A peer reply in the worker's thread must not make its own line stale.
    loom.prepare("INSERT INTO messages (thread_id,role,text,origin,created_at) VALUES ('worker','user','Continue','{}',?)").run(now - 3 * 3_600_000);
    screen.close();
    loom.close();
    const result = spawnSync(process.execPath, ['scripts/catchup-metrics.mjs', '--days', '14'], {
      encoding: 'utf8', env: { ...process.env, SCREEN_DATA_DIR: dir, LOOM_DB: join(dir, 'loom.sqlite') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Asks that were copies: 2 of 3/);
    assert.match(result.stdout, /Asks still open more than an hour after an owner reply in their thread: 2 of 3/);
    t.diagnostic(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("three renewals of an ask count once in both ownership metrics and their base", () => {
  const lines = [0, 1, 2].map(i => ({
    id: i + 1, item_id: "loom:lead", at: NOW - DAY + i * 1000,
    title: i === 1 ? "**D-358** is still open!" : "D-358 is still open",
    source: "auto:status", resolved_at: null, superseded_by: null,
  }));
  const decisions = [{ id: "D-358", thread_id: "worker", created_at: NOW - 2 * DAY, resolved_at: null }];
  const posts = [{ item_id: "loom:lead", at: NOW - DAY / 2 }];
  assert.deepEqual(ownedAsks(lines, decisions, [], posts, NOW - 2 * DAY, NOW),
    { asks: 1, copies: 1, stillOpenAfterReply: 1 });
  // Historical renewals still establish that the ask was a copy; only the current line is left open.
  lines[0].superseded_by = 2;
  lines[1].superseded_by = 3;
  assert.deepEqual(ownedAsks(lines, decisions, [], posts, NOW - 2 * DAY, NOW),
    { asks: 1, copies: 1, stillOpenAfterReply: 1 });
  // Matching words in a different thread remain a separate ask.
  lines.push({ ...lines[2], id: 4, item_id: "loom:other" });
  assert.deepEqual(ownedAsks(lines, decisions, [], posts, NOW - 2 * DAY, NOW),
    { asks: 2, copies: 2, stillOpenAfterReply: 1 });
});
