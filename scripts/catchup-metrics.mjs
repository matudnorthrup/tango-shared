#!/usr/bin/env node
// The catch-up's metrics (docs/specs/catch-up.md "Metrics", TGO-1107): how long a lead's final reply runs, how much of
// what matters is handled within a day, how Accept is used and how often it's reversed, moments per space per day, and
// threads never opened after an away stretch. Reads the desk's ledger and Loom's store, read-only.
//
//   node scripts/catchup-metrics.mjs [--days 14] [--away-hours 4] [--json]
//
// Desk: SCREEN_DATA_DIR/screen.db, else ~/.tango/profiles/<TANGO_PROFILE|default>/data/screen/screen.db.
// Loom: LOOM_DB, else LOOM_HOME/loom.sqlite (Loom's own setting), else ~/.tango/loom/loom.sqlite.
// Both keep 30 days (ledger prune, desk items, presence), so a window longer than that undercounts.

import { askKey, namesDecision } from "../apps/screen/public/desk/ask-match.js";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** How long after an away stretch a thread may still be opened before it counts as never opened. */
const OPEN_GRACE = 3 * DAY;
/**
 * Which `seen` events mean the owner opened, read or heard a thread (not a batch "briefed", an "update" cursor, or an
 * "explicit" Seen tapped without opening it).
 */
const OPENED_VIA = new Set(["viewed", "read", "heard"]);
/**
 * One Accept marks a chapter's lines in several writes (each brief it takes, then the rest), a moment apart, and may
 * wait on Loom between them: marks in one space this close together are one action.
 */
const ACTION_GAP = 90_000;

const expandHome = (value) => (value ? value.replace(/^~(?=$|\/)/, os.homedir()) : value);

export const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank: the median of two is the smaller, and the p90 of ten the ninth.
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
};
const share = (part, whole) => (whole ? part / whole : null);
export const wordCount = (text) => (text.trim().match(/\S+/g) ?? []).length;

/** Words in each run's last reply: `messages` are Loom assistant messages of one kind of thread. */
export function replyWords(messages) {
  const last = new Map();
  for (const m of messages) {
    const key = m.run_id ?? `${m.thread_id}:${m.created_at}`;
    const prior = last.get(key);
    if (!prior || m.created_at >= prior.created_at) last.set(key, m);
  }
  const words = [...last.values()].map((m) => wordCount(m.text));
  return { replies: words.length, median: quantile(words, 0.5), p90: quantile(words, 0.9) };
}

/**
 * The spec's target is a lead's final reply (Loom's `default` threads); interactive threads are conversations with the
 * owner, where longer answers are expected, so they're reported on their own.
 */
export function leadReplyWords(messages) {
  return {
    leads: { ...replyWords(messages.filter((m) => m.role === "default")), target: 60 },
    interactive: replyWords(messages.filter((m) => m.role === "interactive")),
  };
}

/**
 * Moments handled within a day of arriving (a deferral isn't handling), over moments at least a day old. One replaced by
 * newer news before the owner saw it isn't counted: the newer line stands for it.
 */
export function handling(moments, now) {
  const mature = moments.filter((u) => u.at <= now - DAY && !(u.superseded_by != null && u.seen_at == null));
  const handled = (u) => u.seen_at != null && u.seen_via !== "deferred" && u.seen_at - u.at <= DAY;
  return { moments: mature.length, handledWithinDay: share(mature.filter(handled).length, mature.length) };
}

/**
 * Chapters caught up (Accept) against left (Defer), from the lines each action marked: one Accept or Defer marks all
 * of a chapter's lines, moments and smaller ones, within ACTION_GAP. The ledger keeps no action id and only a line's
 * latest mark, so a chapter deferred and later accepted counts once, as caught up, and two Accepts in one space within
 * ACTION_GAP count as one.
 */
export function chapterOutcomes(lines) {
  const marks = lines
    .filter((u) => u.seen_at != null && (u.seen_via === "accepted" || u.seen_via === "deferred"))
    .sort((a, b) => a.seen_at - b.seen_at);
  const last = new Map();
  const actions = [];
  for (const u of marks) {
    const key = `${u.space_id}|${u.seen_via}`;
    if (!(last.has(key) && u.seen_at - last.get(key) <= ACTION_GAP)) actions.push(u.seen_via);
    last.set(key, u.seen_at);
  }
  const caughtUp = actions.filter((via) => via === "accepted").length;
  const left = actions.length - caughtUp;
  return { chapters: actions.length, caughtUp, left, caughtUpShare: share(caughtUp, actions.length) };
}

/**
 * One needs line per brief: answering one supersedes its line with a decided one, and a revised brief gets a new line,
 * so the rows read include superseded ones. The answered line wins, else the latest.
 */
export function briefLines(rows) {
  const by = new Map();
  for (const r of rows) {
    const prior = by.get(r.brief_id);
    const answered = (u) => (u.resolved_at != null ? 1 : 0);
    if (!prior || answered(r) > answered(prior) || (answered(r) === answered(prior) && r.at >= prior.at)) by.set(r.brief_id, r);
  }
  return [...by.values()];
}

/**
 * Briefs answered by Accept against one by one, and how many of each were reversed within 7 days: Loom's own reversal
 * of the decision, or a later decision superseding it. A reversal rate counts only answers at least 7 days old, and only
 * the owner's answers count (Loom's status `answered`).
 */
export function acceptUsage(briefs, decisions, now) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const superseded = new Map();
  for (const d of decisions) if (d.supersedes) superseded.set(d.supersedes, Math.min(superseded.get(d.supersedes) ?? Infinity, d.created_at));
  const reversed = (b) => {
    const id = b.decision_id ?? b.brief_id;
    const d = byId.get(id);
    const answered = d?.resolved_at ?? b.resolved_at ?? b.seen_at;
    if (answered == null) return false;
    if (d?.reversed_at != null && d.reversed_at - answered <= WEEK) return true;
    const next = superseded.get(id);
    return next != null && next - answered <= WEEK;
  };
  const answeredAt = (b) => byId.get(b.decision_id ?? b.brief_id)?.resolved_at ?? b.resolved_at ?? b.seen_at;
  const tally = (list) => {
    const settled = list.filter((b) => answeredAt(b) != null && answeredAt(b) <= now - WEEK);
    const reversedIn7d = list.filter(reversed).length;
    return { briefs: list.length, settled: settled.length, reversedIn7d, reversalRate: share(settled.filter(reversed).length, settled.length) };
  };
  // Only the owner's answers: a brief that defaulted, was withdrawn, went moot or was superseded resolves its needs line
  // too, with no answer from the owner. A brief Loom no longer has keeps the ledger's word.
  const byOwner = (b) => {
    const d = byId.get(b.decision_id ?? b.brief_id);
    return d?.status == null || d.status === "answered";
  };
  const answered = briefs.filter((b) => b.resolved_at != null && byOwner(b));
  // Accept marks the briefs it leaves for the owner `accepted` too, with no outcome; only one it took has one (its
  // option, or "fine"). One left and answered later keeps that mark, so it counts as one by one.
  const byAccept = (b) => b.seen_via === "accepted" && b.outcome != null;
  const accept = answered.filter(byAccept);
  const oneByOne = answered.filter((b) => !byAccept(b));
  return { answered: answered.length, acceptShare: share(accept.length, answered.length), accept: tally(accept), oneByOne: tally(oneByOne) };
}

/**
 * Moments per space per day over the days the ledger covers (from `since`, its first line in the window, not the
 * window's start), busiest first, with the whole desk's daily rate by week. As in `handling`, one replaced by newer news
 * before the owner saw it isn't counted: a line rewritten many times reached the owner once.
 */
export function momentsPerSpace(all, since, now) {
  const moments = all.filter((u) => !(u.superseded_by != null && u.seen_at == null));
  const days = Math.max(1 / 24, (now - since) / DAY);
  const per = new Map();
  for (const u of moments) per.set(u.space_id, (per.get(u.space_id) ?? 0) + 1);
  const weeks = new Map();
  for (const u of moments) {
    const week = Math.floor((u.at - since) / WEEK);
    weeks.set(week, (weeks.get(week) ?? 0) + 1);
  }
  // Every week the data covers, a quiet one at zero: the trend is whether moments fall.
  for (let week = 0; week < Math.ceil(days / 7); week++) if (!weeks.has(week)) weeks.set(week, 0);
  return {
    perDay: moments.length / days,
    spaces: [...per].map(([space, count]) => ({ space, perDay: count / days })).sort((a, b) => b.perDay - a.perDay),
    byWeek: [...weeks].sort(([a], [b]) => a - b).map(([week, count]) => ({ week: week + 1, perDay: count / Math.max(1 / 24, Math.min(7, days - week * 7)) })),
  };
}

/**
 * Away stretches are gaps of at least `awayMs` between the owner's presence spans. A thread an agent posted in during
 * one, and that the owner didn't open in the stretch or within OPEN_GRACE after it, was never opened.
 */
export function neverOpenedAfterAway(presence, posts, opens, awayMs, now) {
  const spans = [...presence].sort((a, b) => a.start - b.start);
  const stretches = [];
  let longestGap = null;
  for (let i = 1; i < spans.length; i++) {
    const from = spans[i - 1].last;
    const to = spans[i].start;
    longestGap = Math.max(longestGap ?? 0, to - from);
    if (to - from >= awayMs && to + OPEN_GRACE <= now) stretches.push({ from, to });
  }
  const opened = new Map();
  for (const o of opens) (opened.get(o.item_id) ?? opened.set(o.item_id, []).get(o.item_id)).push(o.at);
  let active = 0;
  let never = 0;
  for (const { from, to } of stretches) {
    const items = new Set(posts.filter((p) => p.at > from && p.at < to).map((p) => p.item_id));
    for (const item of items) {
      active++;
      const posted = posts.filter((p) => p.item_id === item && p.at > from && p.at < to).map((p) => p.at);
      const first = Math.min(...posted);
      if (!(opened.get(item) ?? []).some((at) => at >= first && at <= to + OPEN_GRACE)) never++;
    }
  }
  return { stretches: stretches.length, longestGapMs: longestGap, activeThreads: active, neverOpened: never, neverShare: share(never, active) };
}

/** Historical copies at the time they were posted, and open asks left behind after an owner's own reply.
 * Candidates before the window still matter; only the lines being measured are windowed. Reporting lines come
 * from Loom's records. A worker reparented since the post is measured against its current parent.
 * Renewals count once per thread and normalized ask, in both numerators and their shared windowed base.
 */
export function ownedAsks(lines, decisions, threads, ownerPosts, since, now) {
  const byId = new Map(threads.map(t => [`loom:${t.id}`, t]));
  const openAt = (u, at) => u.at <= at && (u.resolved_at == null || u.resolved_at > at) &&
    (u.superseded_at == null || u.superseded_at > at);
  const measured = lines.filter(u => u.at >= since && u.at <= now);
  const distinct = rows => new Set(rows.map(u => JSON.stringify([u.item_id, askKey(u.title, u.item_id)]))).size;
  const copies = distinct(measured.filter(u => {
    if (!['lead', 'auto:status'].includes(u.source) || !u.item_id) return false;
    if (decisions.some(d => `loom:${d.thread_id}` !== u.item_id && d.created_at <= u.at &&
      (d.resolved_at == null || d.resolved_at > u.at) && namesDecision(u.title, d.id))) return true;
    return lines.some(w => {
      const thread = byId.get(w.item_id);
      return w.item_id !== u.item_id && thread?.role === 'worker' && thread.parent_thread_id === u.item_id &&
        w.source === 'auto:status' && openAt(w, u.at) && askKey(w.title, w.item_id) === askKey(u.title, u.item_id);
    });
  }));
  const stillOpenAfterReply = distinct(measured.filter(u => u.resolved_at == null && u.superseded_by == null &&
    ownerPosts.some(p => p.item_id === u.item_id && p.at > u.at && p.at < now - 3_600_000)));
  return { asks: distinct(measured), copies, stillOpenAfterReply };
}

function read(days, awayHours) {
  // Loaded here so the pure functions above test without a database.
  return import("node:sqlite").then(({ DatabaseSync }) => {
    // The Screen service's own resolution (apps/screen/server/main.ts): SCREEN_DATA_DIR, else ~/.tango/profiles/<profile>.
    const screenDir =
      expandHome(process.env.SCREEN_DATA_DIR?.trim()) || path.join(os.homedir(), ".tango", "profiles", process.env.TANGO_PROFILE?.trim() || "default", "data", "screen");
    const screenDb = path.join(screenDir, "screen.db");
    // Loom's own setting (packages/loom/src/config.ts): LOOM_HOME, default ~/.tango/loom.
    const loomHome = expandHome(process.env.LOOM_HOME?.trim()) || path.join(os.homedir(), ".tango", "loom");
    const loomDb = expandHome(process.env.LOOM_DB?.trim()) || path.join(loomHome, "loom.sqlite");
    const screen = new DatabaseSync(screenDb, { readOnly: true });
    const loom = new DatabaseSync(loomDb, { readOnly: true });
    const now = Date.now();
    const since = now - days * DAY;
    // The desk's leads are Loom's interactive and default threads; workers report to them.
    const messages = loom
      .prepare(
        // Completed runs only, as Loom's own closing word does: a failed or cancelled run's last message isn't its reply.
        `SELECT m.thread_id, m.run_id, m.text, m.created_at, t.role FROM messages m JOIN threads t ON t.id = m.thread_id
         JOIN runs r ON r.id = m.run_id
         WHERE m.role = 'assistant' AND r.status = 'completed' AND t.role IN ('interactive', 'default') AND m.created_at >= ?`,
      )
      .all(since);
    const moments = screen
      .prepare(`SELECT space_id, at, seen_at, seen_via, superseded_by FROM desk_updates WHERE moment = 1 AND at >= ?`)
      .all(since);
    const lines = screen
      .prepare(`SELECT space_id, seen_at, seen_via FROM desk_updates WHERE seen_via IN ('accepted', 'deferred') AND seen_at >= ?`)
      .all(since);
    // The ledger's first line, when it starts inside the window (a new ledger); else the window's start.
    const firstAt = screen.prepare(`SELECT MIN(at) AS at FROM desk_updates`).get()?.at ?? null;
    const dataFrom = Math.max(since, firstAt ?? since);
    const briefs = screen
      .prepare(`SELECT brief_id, decision_id, at, seen_at, seen_via, outcome, resolved_at FROM desk_updates WHERE kind = 'needs' AND brief_id IS NOT NULL AND (at >= ? OR resolved_at >= ?)`)
      .all(since, since);
    // By answer time too: a brief raised before the window and answered in it counts.
    const decisions = loom
      .prepare(`SELECT id, status, supersedes, created_at, resolved_at, reversed_at FROM decisions WHERE created_at >= ? OR resolved_at >= ?`)
      .all(since - WEEK, since);
    // With the span before the window: an away stretch the window starts inside ends at the first span in it.
    const presence = loom
      .prepare(`SELECT start, last FROM presence WHERE last >= ? UNION ALL SELECT * FROM (SELECT start, last FROM presence WHERE last < ? ORDER BY last DESC LIMIT 1)`)
      .all(since, since);
    const posts = screen.prepare(`SELECT item_id, at FROM desk_messages WHERE author = 'agent' AND at >= ?`).all(since);
    const opens = screen
      .prepare(`SELECT item_id, at, json_extract(payload, '$.via') AS via FROM desk_events WHERE type = 'seen' AND at >= ?`)
      .all(since)
      .filter((e) => OPENED_VIA.has(e.via));
    const needs = screen.prepare(`SELECT u.*, newer.at AS superseded_at FROM desk_updates u
      LEFT JOIN desk_updates newer ON newer.id = u.superseded_by WHERE u.kind = 'needs'`).all();
    const askDecisions = loom.prepare(`SELECT id, thread_id, created_at, resolved_at FROM decisions`).all();
    const threads = loom.prepare(`SELECT id, role, parent_thread_id FROM threads`).all();
    // Mail is a user-role message too; only the owner's own posts count.
    const ownerPosts = loom.prepare(`SELECT 'loom:' || thread_id AS item_id, created_at AS at FROM messages
      WHERE role = 'user' AND origin IS NULL AND created_at >= ?`).all(since);
    const ownership = ownedAsks(needs, askDecisions, threads, ownerPosts, since, now);
    screen.close();
    loom.close();
    return {
      ownedAsks: ownership,
      window: { days, from: new Date(since).toISOString(), to: new Date(now).toISOString(), dataFrom: new Date(dataFrom).toISOString() },
      leadReplies: leadReplyWords(messages),
      handling: handling(moments, now),
      chapters: chapterOutcomes(lines),
      accept: acceptUsage(briefLines(briefs), decisions, now),
      moments: momentsPerSpace(moments, dataFrom, now),
      away: { awayHours, ...neverOpenedAfterAway(presence, posts, opens, awayHours * 3_600_000, now) },
    };
  });
}

const pct = (v) => (v == null ? "—" : `${(100 * v).toFixed(0)}%`);
const num = (v, d = 1) => (v == null ? "—" : v.toFixed(d));

function print(r) {
  const out = [];
  const dataNote = r.window.dataFrom > r.window.from ? `; ledger data from ${r.window.dataFrom.slice(0, 10)}` : "";
  out.push(`Catch-up metrics, last ${r.window.days} days (${r.window.from.slice(0, 10)} to ${r.window.to.slice(0, 10)}${dataNote})`, "");
  const replies = (w) => `${w.replies} — median ${w.median ?? "—"} words, p90 ${w.p90 ?? "—"}`;
  out.push(`Asks that were copies: ${r.ownedAsks.copies} of ${r.ownedAsks.asks}`);
  out.push(`Asks still open more than an hour after an owner reply in their thread: ${r.ownedAsks.stillOpenAfterReply} of ${r.ownedAsks.asks}`);
  out.push(`Lead final replies: ${replies(r.leadReplies.leads)} (target: median under 60)`);
  out.push(`Interactive final replies: ${replies(r.leadReplies.interactive)}`);
  out.push(`Moments handled within a day: ${pct(r.handling.handledWithinDay)} of ${r.handling.moments}`);
  out.push(`Chapters caught up (Accept): ${r.chapters.caughtUp} of ${r.chapters.chapters} (${pct(r.chapters.caughtUpShare)}), left (Defer) ${r.chapters.left}`);
  out.push(
    `Briefs answered: ${r.accept.answered}, by Accept ${pct(r.accept.acceptShare)}. Reversed within 7 days: Accept ${r.accept.accept.reversedIn7d}/${r.accept.accept.briefs} (rate ${pct(r.accept.accept.reversalRate)} of ${r.accept.accept.settled} a week old), one by one ${r.accept.oneByOne.reversedIn7d}/${r.accept.oneByOne.briefs} (rate ${pct(r.accept.oneByOne.reversalRate)} of ${r.accept.oneByOne.settled})`,
  );
  out.push(`Moments per day (since ${r.window.dataFrom.slice(0, 10)}), whole desk: ${num(r.moments.perDay)}; by week: ${r.moments.byWeek.map((w) => `w${w.week} ${num(w.perDay)}`).join(", ") || "—"}`);
  for (const s of r.moments.spaces.slice(0, 8)) out.push(`  ${s.space}: ${num(s.perDay, 2)}/day`);
  out.push(
    `Threads never opened after an away stretch (≥${r.away.awayHours} h, ${r.away.stretches} stretches; longest presence gap ${r.away.longestGapMs == null ? "—" : `${num(r.away.longestGapMs / 3_600_000)} h`}): ${r.away.neverOpened} of ${r.away.activeThreads} (${pct(r.away.neverShare)})`,
  );
  console.log(out.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
  };
  const report = await read(Number(flag("days", 14)), Number(flag("away-hours", 4)));
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
}
