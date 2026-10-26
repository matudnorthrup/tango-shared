import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listIncidents, markNotified, scheduleReminders, pendingNotifications } from "../src/incidents.js";
import {
  assess,
  defaultKeeperPaths,
  loomDueAt,
  MAX_WAKES_PER_RUN,
  runWaitKeeper,
  WAIT_KEEPER_JOB,
  type DeskRow,
  type KeeperInput,
  type LoomWait,
} from "../src/wait-keeper.js";
import { fakeFetch, tempDir, tempLedger } from "./helpers.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const H = 3_600_000;

function wait(over: Partial<LoomWait> = {}): LoomWait {
  return { id: "w1", thread_id: "t1", kind: "time", spec: JSON.stringify({ at: new Date(NOW - H).toISOString() }), note: "check CI", created_at: NOW - 3 * H, expires_at: NOW + 24 * H, ...over };
}

function row(over: Partial<DeskRow> = {}): DeskRow {
  return {
    id: "loom:a",
    source: "loom",
    disposition: "active",
    place: "tango · Thing",
    status: { busy: null },
    facts: {},
    watching: { reason: "Waiting on the lead to merge.", basis: "person", waitingOn: { who: "the lead", what: "merge #1", since: NOW - 30 * H, kind: "agent" }, overdue: null },
    ...over,
  };
}

const input = (over: Partial<KeeperInput> = {}): KeeperInput => ({ now: NOW, loom: null, desk: null, mail: null, state: { woke: {} }, ...over });

describe("assess", () => {
  it("does not mistake a Loom admission hold for a promise, while preserving queue warnings", () => {
    const held = row({
      status: { basis: "source:held", move: "watching" },
      facts: { lastAgentWords: { at: NOW - 30 * H } },
      watching: { reason: "Held: recovery storage is low or replication is behind", basis: "summary" },
    });
    const desk = { rows: [held], pending: new Set<string>() };
    expect(assess(input({ desk })).findings).toEqual([]);
    // An earlier false wake must not turn the system notice into a stuck promise.
    expect(assess(input({ desk, state: { woke: { [`promise:loom:a@${NOW - 30 * H}`]: NOW - 25 * H } } })).findings).toEqual([]);
    const findings = assess(input({ desk, loom: {
      waits: [], threads: [{ id: "a", title: "Held thread", status: "idle", admission: "recovery_unhealthy" }],
      queued: [{ thread_id: "a", created_at: NOW - H }],
    } })).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "wait.loom-queued", severity: "warning" });
    expect(findings[0]!.wake).toBeUndefined();
    // Classify by provenance, not words: an agent can make a real promise using this text.
    held.status = { basis: "summary" };
    expect(assess(input({ desk })).findings[0]?.wake).toBeDefined();
  });

  it("counts only proven active intervals, clips them to the question, and requires more than six hours", () => {
    const q = row({ watching: null, facts: { pending: { requestId: "q1", question: "Choose a cut", at: NOW - 72 * H } } });
    const desk = { rows: [q], pending: new Set([q.id]) };
    expect(assess(input({ desk, presence: null })).findings).toEqual([]);
    expect(assess(input({ desk, presence: [{ start: NOW - 8 * H, last: NOW - 2 * H }] })).findings).toEqual([]);
    const presence = [{ start: NOW - 80 * H, last: NOW - 70 * H }, { start: NOW - 5 * H, last: NOW + H }];
    const found = assess(input({ desk, presence })).findings;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "wait.question", severity: "warning" });
    expect(found[0]!.detail).toContain("7 h of your active time");
    expect(found[0]!.wake).toBeUndefined();
  });

  it("deduplicates a brief in both slots, keeps a separate live question, and ignores prose brief relays", () => {
    const brief = { requestId: "decision:D-42", question: "Approve the direction", at: NOW - 10 * H };
    const rows = [row({ watching: null, facts: { pending: brief, openBrief: brief } }),
      row({ id: "loom:lead", watching: null, facts: { openAsk: { text: "See D-42", at: NOW - 10 * H } } })];
    const presence = [{ start: NOW - 10 * H, last: NOW }];
    expect(assess(input({ desk: { rows, pending: new Set() }, presence })).findings).toHaveLength(1);
    rows[0]!.facts!.pending = { ...brief, requestId: "q2" };
    expect(assess(input({ desk: { rows, pending: new Set() }, presence })).findings).toHaveLength(2);
    rows[0]!.disposition = "done";
    expect(assess(input({ desk: { rows, pending: new Set() }, presence })).findings).toEqual([]);
  });

  it("includes every open brief and only legacy asks still classified as needing the owner", () => {
    const rows = [row({ watching: null }), row({ id: "loom:legacy", watching: null, status: { move: "needs" }, facts: { openAsk: { text: "Choose a time", at: NOW - 10 * H } } }),
      row({ id: "loom:fyi", watching: null, status: { move: "ready" }, facts: { openAsk: { text: "Try it", at: NOW - 10 * H } } })];
    const briefs = ["D-1", "D-2"].map((id) => ({ id, thread_id: "a", ask: "Choose a direction", created_at: NOW - 10 * H }));
    const result = assess(input({ desk: { rows, pending: new Set() }, presence: [{ start: NOW - 10 * H, last: NOW }], briefs }));
    expect(result.findings.map((f) => f.question?.requestId)).toEqual(["decision:D-1", "decision:D-2", null]);
  });

  it("keeps a raised question open after old presence intervals are pruned and includes blocked mail", () => {
    const r = row({ watching: null, facts: { pending: { requestId: "q1", question: "Choose", at: NOW - 60 * 24 * H } } });
    const mail = [{ to_item: r.id, to_title: "Worker", from_title: "Lead", state: "queued", created_at: NOW - H, sent_at: null }];
    const result = assess(input({ desk: { rows: [r], pending: new Set([r.id]) }, presence: [], mail, state: { woke: {}, raised: { "question:loom:a:q1": NOW - 50 * 24 * H } } }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.detail).toContain("1 queued mail message");
  });

  it("a time wait is due at its moment, any other at its expiry", () => {
    expect(loomDueAt(wait())).toBe(NOW - H);
    expect(loomDueAt(wait({ kind: "pr", spec: "{}" }))).toBe(NOW + 24 * H);
  });

  it("a Loom wait past due is a warning and wakes its idle thread once", () => {
    const loom = { waits: [wait()], threads: [{ id: "t1", title: "CI thread", status: "idle" }], queued: [] };
    const [f] = assess(input({ loom })).findings;
    expect(f).toMatchObject({ kind: "wait.loom-missed", severity: "warning", title: "Loom wait never fired: CI thread" });
    expect(f!.wake?.itemId).toBe("loom:t1");
    const again = assess(input({ loom, state: { woke: { "loom-wait:w1": NOW - H } } })).findings[0];
    expect(again!.wake).toBeUndefined();
  });

  it("a Loom wait just due, or on a running thread, is not woken", () => {
    const recent = assess(input({ loom: { waits: [wait({ spec: JSON.stringify({ at: new Date(NOW - 60_000).toISOString() }) })], threads: [], queued: [] } }));
    expect(recent.findings).toEqual([]);
    const running = assess(input({ loom: { waits: [wait()], threads: [{ id: "t1", title: "x", status: "running" }], queued: [] } }));
    expect(running.findings[0]!.wake).toBeUndefined();
  });

  it("a missed wait on a thread stopped on a question is flagged, not woken", () => {
    const asking = { waits: [wait()], threads: [{ id: "t1", title: "x", status: "waiting", open_requests: 1 }], queued: [] };
    expect(assess(input({ loom: asking })).findings[0]!.wake).toBeUndefined();
    const onDesk = { waits: [wait()], threads: [{ id: "t1", title: "x", status: "idle" }], queued: [] };
    expect(assess(input({ loom: onDesk, desk: { rows: [], pending: new Set(["loom:t1"]) } })).findings[0]!.wake).toBeUndefined();
  });

  it("a run queued on a thread that isn't running is a warning", () => {
    const loom = { waits: [], threads: [{ id: "t2", title: "Slept", status: "idle" }], queued: [{ thread_id: "t2", created_at: NOW - H }] };
    expect(assess(input({ loom })).findings).toMatchObject([{ kind: "wait.loom-queued", severity: "warning" }]);
  });

  it("a run held for the thread's budget until a set time is info; a machine-limit hold stays a warning", () => {
    const threads = [
      { id: "b", title: "Over budget", status: "idle", admission: "budget", admission_until: NOW + 4 * H },
      { id: "m", title: "Low memory", status: "idle", admission: "memory", admission_until: null },
      { id: "x", title: "Budget past reset", status: "idle", admission: "budget", admission_until: NOW - H },
    ];
    const queued = threads.map((t) => ({ thread_id: t.id, created_at: NOW - H }));
    const { findings } = assess(input({ loom: { waits: [], threads, queued } }));
    expect(findings).toMatchObject([
      { severity: "info", title: "Loom run held: Over budget" },
      { severity: "warning", title: "Loom run stuck in queue: Low memory" },
      { severity: "warning", title: "Loom run stuck in queue: Budget past reset" },
    ]);
    expect(findings[0]!.detail).toContain("for its daily budget");
    expect(findings[1]!.detail).toContain("memory is low");
    expect(findings[2]!.detail).toContain("isn't opening its host");
  });

  it("a promise to an agent with nothing behind it wakes once after a day", () => {
    const [f] = assess(input({ desk: { rows: [row()], pending: new Set() } })).findings;
    expect(f).toMatchObject({ kind: "wait.overdue", severity: "info", title: "Overdue promise: tango · Thing" });
    expect(f!.wake?.itemId).toBe("loom:a");
    expect(f!.wake?.text).toContain("Waiting on the lead to merge.");
  });

  it.each(["time", "pr", "command", "url", "thread", "file", "worker"])("an active %s wait covers a stale summary or agent promise on its own thread", (kind) => {
    const now = Date.parse("2026-10-22T17:00:00Z");
    const at = "2026-10-28T17:00:00Z";
    const rows = [row({ watching: { reason: "I will check again on Oct 28", basis: "summary" }, facts: { lastAgentWords: { at: now - 30 * H } } }), row({ id: "loom:other" })];
    const loom = { waits: [wait({ thread_id: "a", kind, spec: JSON.stringify({ at }), expires_at: Date.parse(at) + H })], threads: [], queued: [] };
    for (const covered of [rows[0]!, row()]) {
      const result = assess(input({ now, loom, desk: { rows: [covered, rows[1]!], pending: new Set() }, state: { woke: { [`promise:loom:a@${now - 30 * H}`]: now - 25 * H } } }));
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.wake?.itemId).toBe("loom:other");
    }
  });

  it("a missed or failing active wait keeps its own warning without an uncovered-promise wake", () => {
    const loom = { waits: [wait({ thread_id: "a", last_error: "check failed", error_since: NOW - H })], threads: [{ id: "a", title: "Check", status: "idle" }], queued: [] };
    const result = assess(input({ loom, desk: { rows: [row()], pending: new Set() } }));
    expect(result.findings.map((f) => f.kind)).toEqual(["wait.loom-error", "wait.loom-missed"]);
    expect(result.findings.filter((f) => f.wake)).toHaveLength(1);
  });

  it("a promise under a day old waits, unless the desk already marks it overdue", () => {
    const young = row({ watching: { reason: "r", basis: "summary", waitingOn: null, overdue: null }, facts: { lastAgentWords: { at: NOW - 2 * H } } });
    expect(assess(input({ desk: { rows: [young], pending: new Set() } })).findings).toEqual([]);
    const marked = { ...young, watching: { ...young.watching!, overdue: { kind: "agent", since: NOW, text: "nothing from the lead in a week" } } };
    expect(assess(input({ desk: { rows: [marked], pending: new Set() } })).findings[0]!.wake).toBeDefined();
  });

  it("never wakes a busy thread, one with a question pending, or a Discord agent", () => {
    const rows = [row({ id: "loom:busy", status: { busy: "agent" } }), row({ id: "loom:q" , source: "loom" }), row({ id: "discord:x", source: "discord" })];
    const { findings } = assess(input({ desk: { rows, pending: new Set(["loom:q"]) } }));
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => !f.wake)).toBe(true);
  });

  it("never wakes a retired source left in persisted desk data", () => {
    const { findings } = assess(input({ desk: { rows: [row({ id: "t3:retired", source: "t3" })], pending: new Set() } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.wake).toBeUndefined();
    expect(findings[0]!.detail).toContain("not a Loom thread");
  });

  it("waits backed by Loom, a job or a snooze are left alone; done items too", () => {
    const rows = [
      row({ watching: { reason: "monitor", basis: "background", waitingOn: null } }),
      row({ watching: { reason: "job", basis: "job", waitingOn: null } }),
      row({ disposition: "done" }),
    ];
    expect(assess(input({ desk: { rows, pending: new Set() } })).findings).toEqual([]);
  });

  it("a late check-back the desk wakes itself is flagged, not woken again", () => {
    const r = row({ watching: { reason: "I'll report back after the run.", basis: "summary", waitingOn: null, overdue: { kind: "check-back", since: NOW, text: "an update was promised" } }, facts: { lastAgentWords: { at: NOW - 30 * H } } });
    const [f] = assess(input({ desk: { rows: [r], pending: new Set() } })).findings;
    expect(f).toMatchObject({ kind: "wait.overdue" });
    expect(f!.wake).toBeUndefined();
    expect(f!.detail).toContain("the desk wakes");
  });

  it("people waits are flagged when overdue, never woken", () => {
    const person = row({ watching: { reason: "PR review", basis: "person", waitingOn: { who: "Ana", what: "review #7", since: NOW - 72 * H }, overdue: { kind: "person", since: NOW, text: "no answer from Ana" } } });
    expect(assess(input({ desk: { rows: [person], pending: new Set() } })).findings).toMatchObject([{ kind: "wait.person", severity: "info" }]);
    expect(assess(input({ desk: { rows: [person], pending: new Set() } })).findings[0]!.wake).toBeUndefined();
  });

  it("a woken promise that hasn't moved in a day turns into a warning, with no second wake", () => {
    const key = `promise:loom:a@${NOW - 30 * H}`;
    const soon = assess(input({ desk: { rows: [row()], pending: new Set() }, state: { woke: { [key]: NOW - H } } })).findings[0]!;
    expect(soon).toMatchObject({ kind: "wait.overdue" });
    expect(soon.wake).toBeUndefined();
    const stuck = assess(input({ desk: { rows: [row()], pending: new Set() }, state: { woke: { [key]: NOW - 25 * H } } })).findings[0]!;
    expect(stuck).toMatchObject({ kind: "wait.stuck", severity: "warning" });
    expect(stuck.wake).toBeUndefined();
  });

  it("mail queued for hours or unanswered for a day is grouped by recipient", () => {
    const mail = [
      { to_item: "loom:v", to_title: "Video", from_title: "Lead", state: "queued", created_at: NOW - 7 * H, sent_at: null },
      { to_item: "loom:v", to_title: "Video", from_title: "Lead", state: "queued", created_at: NOW - 8 * H, sent_at: null },
      { to_item: "loom:w", to_title: "Fresh", from_title: "Lead", state: "queued", created_at: NOW - H, sent_at: null },
      { to_item: "loom:z", to_title: "Worker", from_title: "Lead", state: "sent", created_at: NOW - 30 * H, sent_at: NOW - 30 * H },
    ];
    mail.push({ to_item: "loom:z", to_title: "Worker", from_title: "Lead", state: "unanswered", created_at: NOW - 50 * H, sent_at: NOW - 50 * H });
    mail.push({ to_item: "loom:old", to_title: "Old", from_title: "Lead", state: "unanswered", created_at: NOW - 9 * 24 * H, sent_at: NOW - 9 * 24 * H });
    const { findings } = assess(input({ mail, desk: { rows: [], pending: new Set(["loom:v"]) } }));
    expect(findings.map((f) => f.title)).toEqual(["Mail stuck for Video", "Mail stuck for Worker"]);
    expect(findings[1]!.detail).toContain("2 delivered with no answer");
    expect(findings[0]!.detail).toContain("2 queued");
    expect(findings[0]!.detail).toContain("question pending");
  });
});

describe("runWaitKeeper", () => {
  function deps(rows: DeskRow[], replies: string[] = []) {
    const dir = tempDir("keeper-");
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith("/api/desk/items?view=active")) return { status: 200, text: JSON.stringify({ items: rows }) };
      if (url.endsWith("/api/desk/commands")) {
        replies.push(String(init?.body));
        return { status: 200, text: JSON.stringify({ status: "applied" }) };
      }
      return { status: 404, text: "" };
    });
    return { fetch, dir, d: { fetch, loomUrl: "http://loom", loomToken: null, loomDbPath: join(dir, "none.sqlite"), deskUrl: "http://desk", screenDbPath: join(dir, "none.db"), statePath: join(dir, "state.json"), now: () => NOW } };
  }

  it.each(['sent', 'unanswered'])('excludes %s mail with eligible back-mail from the SQLite query', async (state) => {
    const { d, dir } = deps([]);
    const screenDbPath = join(dir, "mail.sqlite");
    const db = new DatabaseSync(screenDbPath);
    db.exec(`CREATE TABLE desk_mail (from_item TEXT, to_item TEXT, from_title TEXT, to_title TEXT,
      state TEXT, kind TEXT, expect TEXT, created_at INTEGER, sent_at INTEGER)`);
    const insert = db.prepare("INSERT INTO desk_mail VALUES (?, ?, 'Sender', 'Recipient', ?, 'mail', ?, ?, ?)");
    insert.run('loom:a', 'loom:b', state, 'reply', NOW - 40 * H, NOW - 30 * H);
    const check = async () => (await runWaitKeeper(null, { ...d, screenDbPath }, { dryRun: true })).findings.filter((f) => f.kind === 'wait.mail');
    expect(await check()).toHaveLength(1);
    // A worker's report-up is stored lead -> worker, but is not the lead's answer.
    insert.run('loom:b', 'loom:a', 'answered', 'none', NOW - 20 * H, null);
    db.exec("UPDATE desk_mail SET kind = 'report' WHERE from_item = 'loom:b'");
    expect(await check()).toHaveLength(1);
    db.exec("DELETE FROM desk_mail WHERE from_item = 'loom:b'");
    for (const excluded of ['draft', 'dropped', 'failed']) {
      insert.run('loom:b', 'loom:a', excluded, 'none', NOW - 20 * H, null);
      expect(await check()).toHaveLength(1);
      db.exec("DELETE FROM desk_mail WHERE from_item = 'loom:b'");
    }
    insert.run('loom:b', 'loom:a', 'done', 'none', NOW - 30 * H, null);
    expect(await check()).toHaveLength(1); // Strictly after delivery, not creation.
    db.exec("DELETE FROM desk_mail WHERE from_item = 'loom:b'");
    insert.run('loom:b', 'loom:other', 'done', 'none', NOW - 20 * H, null);
    expect(await check()).toHaveLength(1);
    insert.run('loom:b', 'loom:a', 'done', 'none', NOW - 20 * H, null);
    expect(await check()).toEqual([]);
    db.exec("UPDATE desk_mail SET state = 'queued' WHERE from_item = 'loom:a'");
    expect(await check()).toHaveLength(1); // Back-mail never clears undelivered mail.
    db.close();
  });

  it("accumulates sub-threshold time across restarts, extending beats and presence pruning", async () => {
    const l = tempLedger();
    const rows = [row({ watching: null, facts: { pending: { requestId: "q1", question: "Choose", at: NOW - 60 * 24 * H } } })];
    const { d, dir } = deps(rows);
    const dbPath = join(dir, "presence.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE presence (start INTEGER, last INTEGER); CREATE TABLE decisions (id TEXT, thread_id TEXT, ask TEXT, created_at INTEGER, status TEXT)");
    db.prepare("INSERT INTO presence VALUES (?, ?)").run(NOW - 4 * H, NOW - H);
    const full = { ...d, loomDbPath: dbPath };
    expect((await runWaitKeeper(l, full)).findings).toEqual([]);
    expect((await runWaitKeeper(l, full)).findings).toEqual([]); // No double counting.
    db.prepare("UPDATE presence SET last = ?").run(NOW);
    expect((await runWaitKeeper(l, full)).findings).toEqual([]);
    const saved = JSON.parse(readFileSync(d.statePath, "utf8"));
    expect(saved.questionTime["question:loom:a:q1"].active).toBe(4 * H);
    db.exec("DELETE FROM presence");
    const later = NOW + 40 * 24 * H;
    db.prepare("INSERT INTO presence VALUES (?, ?)").run(later - 2 * H, later);
    expect((await runWaitKeeper(l, { ...full, now: () => later })).findings).toEqual([]); // Exactly six hours.
    db.prepare("UPDATE presence SET last = ?").run(later + H);
    const result = await runWaitKeeper(l, { ...full, now: () => later + H });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.detail).toContain("7 h of your active time");
    expect(result.woke).toEqual([]);
    db.close();
  });

  it("raises each question once across restarts and renames, never reminds, and clears only with a full reading", async () => {
    const l = tempLedger();
    const q = { requestId: "q1", question: "Choose a cut", at: NOW - 10 * H };
    const rows = [row({ watching: null, facts: { pending: q } }), row({ id: "loom:b", watching: null, facts: { pending: q } })];
    const sent: string[] = [];
    const { d, dir } = deps(rows, sent);
    const dbPath = join(dir, "presence.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE presence (start INTEGER, last INTEGER); CREATE TABLE decisions (id TEXT, thread_id TEXT, ask TEXT, created_at INTEGER, status TEXT)");
    db.prepare("INSERT INTO presence VALUES (?, ?)").run(NOW - 10 * H, NOW);
    db.close();
    const full = { ...d, loomDbPath: dbPath };
    const first = await runWaitKeeper(l, full);
    expect(first.findings).toHaveLength(2);
    expect(sent).toEqual([]);
    const incidents = listIncidents(l, { status: "active" });
    expect(incidents).toHaveLength(2); // Same titles and request IDs on different threads must not merge.
    for (const i of incidents) markNotified(l, i.id, new Date(NOW).toISOString());
    scheduleReminders(l, new Date(NOW + 48 * H).toISOString());
    expect(pendingNotifications(l, "normal")).toEqual([]);
    l.db.prepare("UPDATE incidents SET status = 'snoozed', snoozed_until = ?").run(new Date(NOW + H).toISOString());
    scheduleReminders(l, new Date(NOW + 48 * H).toISOString());
    expect(pendingNotifications(l, "normal")).toEqual([]);
    rows[0]!.place = "Renamed thread";
    rows[0]!.facts!.pending = { ...q, question: "Revised options" };
    await runWaitKeeper(l, full);
    expect(listIncidents(l).every((i) => i.count === 1)).toBe(true);
    expect((l.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='wait.question'").get() as { n: number }).n).toBe(2);
    const missing = await runWaitKeeper(l, { ...full, loomDbPath: join(dir, "missing") });
    expect(missing.resolved).toBe(0);
    rows.splice(0);
    expect((await runWaitKeeper(l, full)).resolved).toBe(2);
    // A stale source later replays a resolved question after ledger retention: the persistent marker still wins.
    l.db.exec("DELETE FROM events; DELETE FROM incidents");
    rows.push(row({ watching: null, facts: { pending: q } }));
    await runWaitKeeper(l, full);
    expect(listIncidents(l)).toEqual([]);
    rows[0]!.facts!.pending = { ...q, requestId: "q-new" };
    await runWaitKeeper(l, full);
    expect(listIncidents(l)).toHaveLength(1);
  });

  it("wakes once with an idempotent command, records the incident, and resolves it when it clears", async () => {
    const l = tempLedger();
    const sent: string[] = [];
    const { d } = deps([row()], sent);
    const first = await runWaitKeeper(l, d);
    expect(first.woke).toMatchObject([{ itemId: "loom:a", ok: true }]);
    const body = JSON.parse(sent[0]!) as { commandId: string; type: string; actor: string };
    expect(body).toMatchObject({ type: "reply", actor: "agent" });
    expect(body.commandId).toMatch(/^wait-keeper-[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(d.statePath, "utf8")).woke).toHaveProperty([`promise:loom:a@${NOW - 30 * H}`]);
    expect(listIncidents(l, { status: "active", jobId: WAIT_KEEPER_JOB }).map((i) => i.title)).toEqual(["Overdue promise: tango · Thing"]);

    const second = await runWaitKeeper(l, d);
    expect(second.woke).toEqual([]);
    expect(sent).toHaveLength(1);

    const cleared = await runWaitKeeper(l, { ...d, fetch: deps([]).fetch });
    expect(cleared.resolved).toBe(1);
    expect(listIncidents(l, { status: "active", jobId: WAIT_KEEPER_JOB })).toEqual([]);
  });

  it("clears an earlier false promise incident when the desk identifies a system hold", async () => {
    const l = tempLedger();
    const sent: string[] = [];
    const held = row({
      facts: { lastAgentWords: { at: NOW - 30 * H } },
      watching: { reason: "Held: recovery storage is low or replication is behind", basis: "summary" },
    });
    const { d } = deps([held], sent);
    // Reproduce the old projection without its source label.
    expect((await runWaitKeeper(l, d)).woke).toHaveLength(1);
    held.status = { basis: "source:held", move: "watching" };
    const report = await runWaitKeeper(l, d);
    expect(report.findings).toEqual([]);
    expect(report.woke).toEqual([]);
    expect(report.resolved).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("resolves an uncovered promise when a Loom timer is registered, and detects it again after removal", async () => {
    const l = tempLedger();
    const sent: string[] = [];
    const { d } = deps([row()], sent);
    let waits: LoomWait[] = [];
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith("/triggers?status=waiting")) return { status: 200, text: JSON.stringify(waits) };
      if (url.endsWith("/snapshot")) return { status: 200, text: JSON.stringify({ threads: [] }) };
      return d.fetch(url, init);
    });
    const full = { ...d, fetch, loomToken: "test-token" };
    expect((await runWaitKeeper(l, full)).woke).toHaveLength(1);
    waits = [wait({ thread_id: "a", spec: JSON.stringify({ at: "2026-10-28T17:00:00Z" }), expires_at: Date.parse("2026-10-29T17:00:00Z") })];
    const covered = await runWaitKeeper(l, full);
    expect(covered.findings).toEqual([]);
    expect(covered.woke).toEqual([]);
    expect(covered.resolved).toBe(1);
    expect(sent).toHaveLength(1);
    waits = []; // Fired or cancelled triggers are absent from the waiting endpoint.
    expect((await runWaitKeeper(l, full)).findings[0]!.kind).toBe("wait.overdue");
  });

  it("caps wakes per run; the rest wait for the next", async () => {
    const rows = Array.from({ length: MAX_WAKES_PER_RUN + 2 }, (_, i) => row({ id: `loom:${i}`, place: `T${i}` }));
    const sent: string[] = [];
    const { d } = deps(rows, sent);
    const r = await runWaitKeeper(tempLedger(), d);
    expect(r.woke).toHaveLength(MAX_WAKES_PER_RUN);
    const next = await runWaitKeeper(tempLedger(), d);
    expect(next.woke).toHaveLength(2);
  });

  it("keeps a wake marker past two weeks while its promise still stands, and drops it once the promise is gone", async () => {
    const sent: string[] = [];
    const { d, dir } = deps([row()], sent);
    // A full reading: Loom's API and its runs table answer too.
    const db = new DatabaseSync(join(dir, "loom.sqlite"));
    db.exec("CREATE TABLE runs (thread_id TEXT, created_at INTEGER, status TEXT)");
    db.close();
    let rows = [row()];
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith("/triggers?status=waiting")) return { status: 200, text: "[]" };
      if (url.endsWith("/snapshot")) return { status: 200, text: JSON.stringify({ threads: [] }) };
      if (url.endsWith("/api/desk/items?view=active")) return { status: 200, text: JSON.stringify({ items: rows }) };
      if (url.endsWith("/api/desk/commands")) {
        sent.push(String(init?.body));
        return { status: 200, text: JSON.stringify({ status: "applied" }) };
      }
      return { status: 404, text: "" };
    });
    const full = { ...d, fetch, loomToken: "t", loomDbPath: join(dir, "loom.sqlite") };
    await runWaitKeeper(tempLedger(), full);
    expect(sent).toHaveLength(1);
    const later = await runWaitKeeper(tempLedger(), { ...full, now: () => NOW + 30 * 24 * H });
    expect(later.woke).toEqual([]);
    expect(later.findings[0]).toMatchObject({ kind: "wait.stuck" });
    expect(Object.keys(JSON.parse(readFileSync(d.statePath, "utf8")).woke)).toHaveLength(1);
    rows = [];
    await runWaitKeeper(tempLedger(), { ...full, now: () => NOW + 31 * 24 * H });
    expect(JSON.parse(readFileSync(d.statePath, "utf8")).woke).toEqual({});
  });

  it("a Loom source that can't be read doesn't hide the others", async () => {
    const { d } = deps([]);
    const fetch = fakeFetch((url) => {
      if (url.endsWith("/triggers?status=waiting")) return { status: 200, text: JSON.stringify([wait()]) };
      if (url.endsWith("/snapshot")) return { status: 200, text: JSON.stringify({ threads: [{ id: "t1", title: "CI thread", status: "idle" }] }) };
      if (url.endsWith("/api/desk/items?view=active")) return { status: 200, text: JSON.stringify({ items: [] }) };
      return { status: 404, text: "" };
    });
    // The runs table is missing (loomDbPath points nowhere): the API's missed wait still shows.
    const r = await runWaitKeeper(null, { ...d, fetch, loomToken: "t" }, { dryRun: true });
    expect(r.findings.map((f) => f.kind)).toEqual(["wait.loom-missed"]);
    expect(r.notes.join(" ")).toContain("runs");
  });

  it("reads the screen database where SCREEN_DATA_DIR puts it", () => {
    const before = { db: process.env.TANGO_SCREEN_DB, dir: process.env.SCREEN_DATA_DIR };
    delete process.env.TANGO_SCREEN_DB;
    process.env.SCREEN_DATA_DIR = "/srv/screen-data";
    try {
      expect(defaultKeeperPaths("/p/data").screenDbPath).toBe("/srv/screen-data/screen.db");
      delete process.env.SCREEN_DATA_DIR;
      expect(defaultKeeperPaths("/p/data").screenDbPath).toBe("/p/data/screen/screen.db");
    } finally {
      if (before.db !== undefined) process.env.TANGO_SCREEN_DB = before.db;
      if (before.dir !== undefined) process.env.SCREEN_DATA_DIR = before.dir;
    }
  });

  it("a dry run sends nothing and writes nothing", async () => {
    const sent: string[] = [];
    const { d } = deps([row()], sent);
    const r = await runWaitKeeper(null, d, { dryRun: true });
    expect(r.findings[0]!.wake).toBeDefined();
    expect(sent).toEqual([]);
  });

  it("an unreadable desk keeps its incidents open", async () => {
    const l = tempLedger();
    const { d } = deps([row()]);
    await runWaitKeeper(l, d);
    const down = fakeFetch(() => ({ error: "connection refused" }));
    const r = await runWaitKeeper(l, { ...d, fetch: down });
    expect(r.resolved).toBe(0);
    expect(r.notes).toContain("desk not read");
    expect(listIncidents(l, { status: "active", jobId: WAIT_KEEPER_JOB })).toHaveLength(1);
  });
});

it("wait-keeper flags an erroring wait after 30 minutes and clears on success", () => {
  const w = wait({ kind: "pr", last_error: "gh auth failed", error_since: NOW - H });
  const check = () => assess(input({ loom: { waits: [w], threads: [], queued: [] } })).findings;
  expect(check()).toEqual([expect.objectContaining({ kind: "wait.loom-error", detail: expect.stringContaining("gh auth failed") })]);
  w.last_error = null; expect(check()).toEqual([]);
});
