import { describe, expect, it } from "vitest";
import { AccountPool, MIN_START_PERCENT } from "../src/pool.js";
import { LIMIT_CONTINUE_NOTE, LoomHost, MAX_LIMIT_MOVES } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const row = (name: string, fiveHour: number, sevenDay: number, extra: object = {}) => ({
  provider: "Claude",
  account: name,
  profileName: name,
  live: true,
  updatedAt: new Date(NOW - 60_000).toISOString(),
  windows: [
    { title: "5 hour", windowMinutes: 300, remainingPercent: fiveHour, resetsAt: "2026-10-15T20:00:00Z" },
    { title: "7 day", windowMinutes: 10_080, remainingPercent: sevenDay, resetsAt: "2026-10-20T00:00:00Z" },
    { title: "Fable only", windowMinutes: 10_080, remainingPercent: 1, resetsAt: "2026-10-20T00:00:00Z" },
  ],
  ...extra,
});

function pool() {
  const p = new AccountPool([
    { provider: "claude", name: "a", usageName: "A" },
    { provider: "claude", name: "b", usageName: "B" },
    { provider: "claude", name: "c", usageName: "C" },
  ]);
  p.now = () => NOW;
  return p;
}

describe("AccountPool", () => {
  it("records only accepted monitor readings, not missing, stale or offline rows", () => {
    const p = pool();
    const calls: string[] = [];
    p.onReading = (provider, name) => calls.push(`${provider}:${name}`);
    p.applyUsage([row("A", 90, 80)]);
    p.applyUsage([row("B", 80, 70, { live: false })]);
    p.applyUsage([row("C", 80, 70, { updatedAt: new Date(NOW - 3_600_000).toISOString() })]);
    p.applyUsage([]);
    expect(calls).toEqual(["claude:a"]);
  });

  it("spreads a burst across the owner's usable accounts", () => {
    const names = ["north", "east", "south", "west"];
    const p = new AccountPool(names.map((name) => ({ provider: "claude", name, usageName: name })));
    p.now = () => NOW;
    p.applyUsage([[6, 98, 40], [80, 95, 110], [45, 97, 40], [20, 99, 70]].map(([week, five, hours], i) => ({
      provider: "claude", account: names[i]!, windows: [
        { kind: "five_hour", remainingPercent: five },
        { kind: "weekly", remainingPercent: week, resetsAt: new Date(NOW + hours! * 3_600_000).toISOString() },
      ],
    })));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) { const name = p.pick("claude")!.name; counts[name] = (counts[name] ?? 0) + 1; }
    expect(counts).toEqual({ south: 7, east: 3 });
    for (let i = 0; i < 10; i++) { const name = p.pick("claude")!.name; counts[name] = (counts[name] ?? 0) + 1; }
    expect(counts.west).toBeGreaterThan(0);
  });

  it("lets a live reading steer new work before the next usage poll", () => {
    const p = pool();
    p.applyUsage([row("A", 90, 90), row("B", 90, 90)]);
    p.observe("claude", "a", { status: "allowed", utilization: 0.8, window: "five_hour" });
    expect(p.capacityWindows("claude", "a").fiveHour?.left).toBe(20);
    expect(p.capacityWindows("claude", "a").weekly?.left).toBe(90);
    expect(p.best("claude")?.name).toBe("b");
    p.observe("claude", "b", { status: "allowed", utilization: 0.85 });
    expect(p.capacityWindows("claude", "b")).toMatchObject({ fiveHour: { left: 15 }, weekly: { left: 15 } });
  });

  it("prefers expiring capacity, guards five-hour room, and decays placements", () => {
    const p = pool();
    p.applyUsage([row("A", 99, 30, { windows: [
      { kind: "five_hour", remainingPercent: 99 },
      { kind: "weekly", remainingPercent: 30, resetsAt: new Date(NOW + 12 * 3_600_000).toISOString() },
    ] }), row("B", 99, 80)]);
    expect(p.pick("claude")?.name).toBe("a");
    expect(p.score("claude", "a").load).toBe(1);
    p.now = () => NOW + 5 * 60_000;
    expect(p.score("claude", "a").load).toBe(0.5);
    p.applyUsage([row("A", 24, 99)]);
    expect(p.pick("claude")?.name).toBe("b");
    p.coolDown("claude", "b"); p.coolDown("claude", "c");
    expect(p.pick("claude")?.name).toBe("a");
  });

  it("scores without recording load, caps pace and expires placement history", () => {
    const p = pool();
    p.applyUsage([row("A", 100, 100, { windows: [
      { kind: "weekly", remainingPercent: 100, resetsAt: new Date(NOW).toISOString() },
    ] })]);
    expect(p.score("claude", "a")).toMatchObject({ pace: 5, score: 5, load: 0 });
    p.best("claude"); p.score("claude", "a");
    expect(p.score("claude", "a").load).toBe(0);
    p.placed("claude", "a");
    p.now = () => NOW + 10 * 60_000;
    expect(p.score("claude", "a").load).toBe(0);
    p.applyUsage([row("A", 100, 50, { windows: [{ kind: "weekly", remainingPercent: 50 }] })]);
    expect(p.score("claude", "a").pace).toBe(0.5);
  });

  it("restores the old ordering in greedy mode despite placement load", () => {
    const p = new AccountPool(pool().accounts, { greedy: true });
    p.now = () => NOW;
    p.applyUsage([row("A", 40, 90), row("B", 80, 60), row("C", 95, 30)]);
    expect(Array.from({ length: 10 }, () => p.pick("claude")?.name)).toEqual(Array(10).fill("b"));
  });

  it("picks the account with the most room in its tightest main window", () => {
    const p = pool();
    p.applyUsage([row("A", 40, 90), row("B", 80, 60), row("C", 95, 30)]);
    expect(p.room("claude", "a")).toMatchObject({ remaining: 40, resetsAt: Date.parse("2026-10-15T20:00:00Z") });
    expect(p.pick("claude")!.name).toBe("b");
  });

  it("ignores model-only windows, stale rows and rows that aren't live", () => {
    const p = pool();
    p.applyUsage([row("A", 50, 50), row("B", 90, 90, { updatedAt: new Date(NOW - 3_600_000).toISOString() }), row("C", 99, 99, { live: false })]);
    expect(p.room("claude", "a").remaining).toBe(50);
    expect(p.room("claude", "b").remaining).toBeNull();
    // Known room beats unknown room.
    expect(p.pick("claude")!.name).toBe("a");
  });

  it("never starts work on a nearly empty account", () => {
    const p = pool();
    p.applyUsage([row("A", MIN_START_PERCENT - 1, 90), row("B", 5, 90), row("C", 2, 90)]);
    expect(p.pick("claude")).toBeNull();
    expect(p.nextAvailableAt("claude")).toBe(Date.parse("2026-10-15T20:00:00Z"));
  });

  it("cools an account down after a limit, until its reset", () => {
    const p = pool();
    p.applyUsage([row("A", 90, 90), row("B", 50, 50), row("C", 40, 40)]);
    p.coolDown("claude", "a", NOW + 3_600_000);
    expect(p.pick("claude")!.name).toBe("b");
    p.now = () => NOW + 3_600_001;
    expect(p.usable("claude", "a")).toBe(true);
  });

  it("treats a rejected live reading as a limit and folds utilization in", () => {
    const p = pool();
    p.applyUsage([row("A", 90, 90), row("B", 50, 50)]);
    p.observe("claude", "b", { status: "allowed", utilization: 0.8 });
    expect(p.room("claude", "b").remaining).toBe(20);
    p.observe("claude", "a", { status: "rejected", resetsAt: NOW + 1000 });
    expect(p.usable("claude", "a")).toBe(false);
  });
});

const flush = () => new Promise((r) => setTimeout(r, 5));

function hostWithPool() {
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const p = new AccountPool([
    { provider: "fake", name: "a", usageName: "A" },
    { provider: "fake", name: "b", usageName: "B" },
  ]);
  p.now = () => NOW;
  p.applyUsage([
    { ...row("A", 90, 90), provider: "fake" },
    { ...row("B", 60, 60), provider: "fake" },
  ]);
  const host = new LoomHost(store, { fake: runtime }, { pool: p });
  return { store, runtime, pool: p, host };
}

describe("LoomHost with a pool", () => {
  it("starts a new thread on the account with the most room", async () => {
    const { host, runtime, store } = hostWithPool();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/r", provider: "fake" });
    expect(store.thread(r.threadId!)!.account).toBe("a");
    expect(runtime.last.options.account).toBe("a");
  });

  it("continues on another account when a turn hits a limit, on the same native session", async () => {
    const { host, runtime, store, pool } = hostWithPool();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "build it", cwd: "/r", provider: "fake" });
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-1" });
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "and then this" });
    runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit", resetAt: NOW + 7_200_000 } });
    await flush();

    expect(pool.usable("fake", "a")).toBe(false);
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.sessions[0]!.closed).toBe(true);
    expect(runtime.last.options).toMatchObject({ account: "b", nativeSessionId: "native-1" });
    // The cut-off run continues first, with a note instead of its original text; the queued reply waits its turn.
    expect(runtime.last.turns).toEqual([{ runId: r.runId, text: LIMIT_CONTINUE_NOTE }]);
    expect(store.attempts(r.runId!).map((a) => [a.account, a.status])).toEqual([["a", "failed"], ["b", "running"]]);
    runtime.last.complete();
    await flush();
    expect(runtime.last.turns.map((t) => t.text)).toEqual([LIMIT_CONTINUE_NOTE, "and then this"]);
    expect(store.thread(r.threadId!)!.account).toBe("b");
  });

  it("waits for a reset when every account is out, then carries on", async () => {
    const { host, runtime, store, pool } = hostWithPool();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "work", cwd: "/r", provider: "fake" });
    pool.coolDown("fake", "b", NOW + 50);
    runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit", resetAt: NOW + 3_600_000 } });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(store.run(r.runId!)!.status).toBe("queued");
    // Time passes: b's cooldown is over.
    pool.now = () => NOW + 60;
    await host.kick(r.threadId!);
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options.account).toBe("b");
  });

  it("stops moving a run after too many limits", async () => {
    const { host, runtime, store, pool } = hostWithPool();
    pool.accounts.push(...Array.from({ length: MAX_LIMIT_MOVES }, (_, i) => ({ provider: "fake", name: `x${i}` })));
    const r = await host.execute({ type: "submit", commandId: "c1", text: "work", cwd: "/r", provider: "fake" });
    for (let i = 0; i < MAX_LIMIT_MOVES + 2; i++) {
      if (store.run(r.runId!)!.status !== "running") break;
      runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit" } });
      await flush();
    }
    expect(store.run(r.runId!)!.status).toBe("failed");
    expect(store.attempts(r.runId!)).toHaveLength(MAX_LIMIT_MOVES);
  });

  it("closes an idle live session whose account ran low and starts the next turn elsewhere", async () => {
    const { host, runtime, store, pool } = hostWithPool();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/r", provider: "fake" });
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-1" });
    runtime.last.complete();
    await flush();
    const first = runtime.last;
    pool.observe("fake", "a", { utilization: 0.97 });
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two" });
    expect(first.closed).toBe(true);
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options).toMatchObject({ account: "b", nativeSessionId: "native-1" });
    expect(store.thread(r.threadId!)!.account).toBe("b");
  });

  it("lets startup wait for the first usage reading", async () => {
    const p = pool();
    const { startUsageFeed } = await import("../src/pool.js");
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ usage: { accounts: [row("A", 30, 30), row("B", 70, 70)] } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const feed = startUsageFeed(p, `http://127.0.0.1:${port}/api/usage`, 60_000);
    await feed.ready;
    feed.stop();
    server.close();
    expect(p.pick("claude")!.name).toBe("b");
  });

  it("moves an idle thread off an account that ran low before its next turn", async () => {
    const { host, runtime, store, pool } = hostWithPool();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/r", provider: "fake" });
    runtime.last.complete();
    runtime.last.emit({ type: "session.ended" });
    await flush();
    pool.observe("fake", "a", { utilization: 0.97 });
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two" });
    expect(store.thread(r.threadId!)!.account).toBe("b");
    expect(runtime.last.options.account).toBe("b");
  });
});

describe("per-thread account rules", () => {
  function setup() {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const p = new AccountPool([
      { provider: "fake", name: "home", usageName: "H", aliases: ["t3_home"] },
      { provider: "fake", name: "team", usageName: "T", aliases: ["t3_team"] },
      { provider: "fake", name: "spare", usageName: "S", aliases: ["t3_spare"] },
    ]);
    p.now = () => NOW;
    p.applyUsage([
      { ...row("H", 30, 30), provider: "fake" },
      { ...row("T", 50, 50), provider: "fake" },
      { ...row("S", 95, 95), provider: "fake" },
    ]);
    return { store, runtime, pool: p, host: new LoomHost(store, { fake: runtime }, { pool: p }) };
  }

  it("starts on the requested account (by alias) when it is allowed and has room", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", account: "t3_team", accounts: ["t3_team", "t3_spare"] });
    expect(store.thread(r.threadId!)).toMatchObject({ account: "team", accounts: JSON.stringify(["team", "spare"]) });
  });

  it("records a placement only for a submit that commits", async () => {
    const { host, pool } = setup();
    await expect(host.execute({ type: "submit", commandId: "bad", text: "x", cwd: "/r", provider: "fake", role: "nope" as never })).rejects.toThrow(/role/);
    expect(pool.score("fake", "spare").load).toBe(0);
    await host.execute({ type: "submit", commandId: "ok", text: "x", cwd: "/r", provider: "fake" });
    expect(pool.score("fake", "spare").load).toBe(1);
  });

  it("never places a thread outside its allowed accounts, even when another has more room", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", accounts: ["t3_home"] });
    expect(store.thread(r.threadId!)!.account).toBe("home");
  });

  it("keeps a one-account thread waiting on its own account after a limit instead of moving it", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", accounts: ["home"] });
    runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit", resetAt: NOW + 3_600_000 } });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(store.thread(r.threadId!)!.account).toBe("home");
    expect(store.run(r.runId!)!.status).toBe("queued");
  });

  it("moves a pooled thread only within its pool", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", account: "team", accounts: ["home", "team"] });
    runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit" } });
    await flush();
    // spare has the most room, but it isn't in this thread's pool.
    expect(runtime.last.options.account).toBe("home");
    expect(store.thread(r.threadId!)!.account).toBe("home");
  });

  it("refuses an unknown account name rather than widening the rules", async () => {
    const { host } = setup();
    await expect(host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", accounts: ["home", "typo"] })).rejects.toMatchObject({ code: "invalid" });
  });
});

it("matches a Codex monitor row to the provider's account and weekly room", () => {
  const pool = new AccountPool([{ provider: "codex", name: "personal", usageName: "Codex (Personal)" }]);
  pool.applyUsage([{ provider: "Codex", account: "personal", profileName: "Codex (Personal)", windows: [{ title: "7 day", remainingPercent: 42, resetsAt: "2030-01-01T00:00:00Z" }] }]);
  expect(pool.room("codex", "personal")).toMatchObject({ remaining: 42, resetsAt: Date.parse("2030-01-01T00:00:00Z") });
  expect(pool.pick("codex")?.name).toBe("personal");
});
