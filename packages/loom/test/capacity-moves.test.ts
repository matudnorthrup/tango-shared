import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createLoomServer } from "../src/http.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { AccountPool } from "../src/pool.js";
import { QuotaHistory } from "../src/forecast.js";
import { capacityRules } from "../src/capacity.js";
import { FakeRuntime } from "./fake-runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); vi.unstubAllEnvs(); });
async function setup(accounts?: string[], policy?: string, accountsFrom?: "policy") {
  const dir = mkdtempSync(join(tmpdir(), "loom-capacity-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  vi.stubEnv("TANGO_START_WORK_POLICY", join(dir, "policy.yaml"));
  if (policy) writeFileSync(join(dir, "policy.yaml"), policy);
  const store = new LoomStore(join(dir, "test.db"));
  let now = 1000;
  store.now = () => now++;
  const runtime = new FakeRuntime(store);
  const pool = new AccountPool(["a", "b", "c"].map((name) => ({ provider: "claude", name, aliases: [`claudeAgent_${name}`], usageName: name })));
  const quotaHistory = new QuotaHistory(store);
  pool.onReading = (provider, name) => quotaHistory.record(provider, name, pool.capacityWindows(provider, name));
  const host = new LoomHost(store, { claude: runtime }, { pool, quotaHistory, releasesDir: join(dir, "releases") });
  cleanups.push(async () => { await host.closeAll(); store.close(); });
  const { threadId, runId } = await host.execute({ type: "submit", commandId: "start", cwd: dir, repo: "/repos/example", text: "hello", provider: "claude", account: "a", accounts, accountsFrom });
  runtime.last.emit({ type: "session.native", nativeSessionId: "same-session" });
  const move = (account: string, commandId = "move") => host.execute({ type: "move", commandId, threadId: threadId!, account });
  return { dir, store, runtime, pool, host, threadId: threadId!, runId: runId!, move };
}

describe("capacity and moves", () => {
  it("serves forecasts alongside policy changes in the same host snapshot", async () => {
    const { host, store, pool, dir, threadId } = await setup(["a", "b"], "default: [claudeAgent_a, claudeAgent_b]\n", "policy");
    const hour = 3_600_000;
    let now = Date.parse("2030-01-01T00:00:00Z");
    store.now = pool.now = () => now;
    const resetsAt = new Date(now + 48 * hour).toISOString();
    const apply = (left: number) => pool.applyUsage([{ provider: "claude", account: "a", windows: [{ kind: "weekly", remainingPercent: left, resetsAt }] }]);
    apply(80);
    now += 4 * hour;
    apply(60);
    writeFileSync(join(dir, "policy.yaml"), "default: [claudeAgent_a, claudeAgent_b, claudeAgent_c]\n");
    const account = host.capacity().accounts[0]!;
    expect(account.forecast).toMatchObject({ burnPerDay: 120, flags: ["runs_dry"] });
    expect(account.threads[0]).toMatchObject({ itemId: `loom:${threadId}`, allowedFrom: "policy", allowed: ["claudeAgent_a", "claudeAgent_b", "claudeAgent_c"] });
    expect(account.pinned).toBe(0);
  });

  it.each([
    { cold: true, live: false, left: 20, moved: true },
    { cold: false, live: false, left: 20, moved: false },
    { cold: true, live: true, left: 20, moved: false },
    { cold: true, live: false, left: 80, moved: false },
    { cold: true, live: false, left: 45, moved: true },
    { cold: true, live: false, left: 20, greedy: true, moved: false },
    { cold: true, live: false, left: 90, five: 24, moved: true },
  ].map((test) => ({ five: 100, greedy: false, ...test })))("balances only cheap idle turns: %j", async ({ cold, live, left, moved, five, greedy }) => {
    const { host, runtime, store, pool, threadId, runId } = await setup(["a", "b"]);
    runtime.last.complete();
    await host.kick(threadId);
    if (!live) await host.closeAll();
    const now = Date.now();
    store.now = pool.now = () => now;
    pool.balance.loadWeight = 0;
    pool.balance.greedy = greedy;
    store.updateRun(runId, { ended_at: now - (cold ? 3_600_001 : 1000) });
    pool.applyUsage(["a", "b"].map((name) => ({ provider: "claude", account: name, windows: [
      { kind: "five_hour", remainingPercent: name === "a" ? five : 100 }, { kind: "weekly", remainingPercent: name === "a" ? left : 90 },
    ] })));
    await host.execute({ type: "submit", commandId: "balance-turn", threadId, text: "next" });
    expect(store.thread(threadId)?.account).toBe(moved ? "b" : "a");
    if (moved) expect(store.accountHistory(threadId).at(-1)?.reason).toBe("balance");
  });

  it("starts a queued turn on the new account when the move lands while the session is opening (Codex review on #655)", async () => {
    const { host, runtime, store, threadId, move } = await setup();
    const old = runtime.last;
    old.complete();
    await host.kick(threadId);
    await host.closeAll();
    // Opening the next session takes a moment; the move arrives during it.
    const open = runtime.open.bind(runtime);
    let moved: Promise<unknown> | undefined;
    runtime.open = async (options, emit) => {
      if (!moved) moved = move("b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return open(options, emit);
    };
    await host.execute({ type: "submit", commandId: "next", threadId, text: "after the move" });
    await moved;
    await host.kick(threadId);
    const started = runtime.sessions.filter((s) => s.turns.some((t) => t.text === "after the move"));
    expect(started).toHaveLength(1);
    expect(started[0]!.options.account).toBe("b");
    expect(store.thread(threadId)?.account).toBe("b");
  });

  it("reports a usage reading older than the freshness window as stale (Codex review on #655)", async () => {
    const { host, pool } = await setup();
    let now = Date.now();
    pool.now = () => now;
    pool.applyUsage([{ provider: "Claude", account: "a", windows: [{ kind: "five_hour", remainingPercent: 60 }] }]);
    expect(host.capacity().accounts[0]?.status).toBe("fresh");
    now += 16 * 60_000;
    expect(host.capacity().accounts[0]?.status).toBe("stale");
  });

  it("moves idle threads immediately and resumes their native session on the next turn", async () => {
    const { host, runtime, store, threadId, move } = await setup();
    const old = runtime.last;
    old.complete();
    await host.kick(threadId);
    await move("claudeAgent_b");
    expect(old.closed).toBe(true);
    expect(store.thread(threadId)?.account).toBe("b");
    expect(store.accountHistory(threadId).map(({ account, reason }) => ({ account, reason }))).toEqual([{ account: "a", reason: "start" }, { account: "b", reason: "move" }]);
    await host.execute({ type: "submit", commandId: "next", threadId, text: "next" });
    expect(runtime.last.options).toMatchObject({ account: "b", nativeSessionId: "same-session" });
    expect(runtime.last.turns[0]?.text).toBe("next");
    expect(store.accountHistory(threadId)).toHaveLength(2);
  });

  it("defers a busy move through questions and replaces it with the latest target before queued work", async () => {
    const { host, runtime, store, threadId, runId, move } = await setup();
    const old = runtime.last;
    old.emit({ type: "request.opened", runId, requestId: "q", kind: "question", payload: {} });
    await move("b");
    await move("c", "move2");
    expect(old.closed).toBe(false);
    expect(store.pendingAccountMove(threadId)).toBe("c");
    await host.execute({ type: "answer", commandId: "answer", requestId: "q", answer: "yes" });
    expect(old.closed).toBe(false);
    await host.execute({ type: "submit", commandId: "next", threadId, text: "queued" });
    old.complete();
    await host.kick(threadId);
    expect(old.closed).toBe(true);
    expect(runtime.last.options).toMatchObject({ account: "c", nativeSessionId: "same-session" });
    expect(store.accountHistory(threadId).map((h) => h.account)).toEqual(["a", "c"]);
    await move("b"); // retry of original receipt must not move back
    expect(store.pendingAccountMove(threadId)).toBe(null);
  });

  it("routes move, history and capacity requests without binding a socket", async () => {
    const { host, runtime, threadId } = await setup();
    runtime.last.complete();
    await host.kick(threadId);
    const server = createLoomServer(host, { token: "test" });
    const call = (url: string, body?: unknown, auth = true): Promise<{ status: number; body: any }> => new Promise((resolve) => {
      const req = Object.assign(new PassThrough(), { url, method: body ? "POST" : "GET", headers: { host: "localhost", ...(auth ? { authorization: "Bearer test" } : {}) } });
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(data: string) { resolve({ status, body: JSON.parse(data) }); } };
      server.emit("request", req as any, res as any);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    expect((await call(`/threads/${threadId}/move`, { commandId: "http-move", account: "b" })).status).toBe(200);
    expect((await call(`/threads/${threadId}/accounts`)).body.map((h: { reason: string }) => h.reason)).toEqual(["start", "move"]);
    expect((await call("/capacity")).body).toMatchObject({ loom: true, moves: true, machine: null });
    expect((await call("/commands", { type: "move", commandId: "http-back", threadId, account: "a" })).status).toBe(200);
    expect((await call(`/threads/${threadId}/move`, { commandId: "http-invalid", account: "nope" })).body.code).toBe("invalid");
    expect((await call("/threads/missing/move", { commandId: "http-missing", account: "a" })).status).toBe(404);
    expect((await call("/threads/missing/accounts")).status).toBe(404);
    expect((await call("/capacity", undefined, false)).status).toBe(401);
  });

  it("persists a pending target through coordinator recovery", async () => {
    const { dir, store, host, threadId, move, pool } = await setup();
    await move("b");
    await host.detachAll();
    const reopened = new LoomStore(join(dir, "test.db"));
    const runtime = new FakeRuntime(store);
    const recovered = new LoomHost(reopened, { claude: runtime }, { pool, releasesDir: join(dir, "releases") });
    cleanups.unshift(async () => { await recovered.closeAll(); reopened.close(); });
    expect(reopened.pendingAccountMove(threadId)).toBe("b");
    await recovered.recover();
    expect(runtime.last.options).toMatchObject({ account: "b", nativeSessionId: "same-session" });
    expect(reopened.pendingAccountMove(threadId)).toBeNull();
    expect(store.accountHistory(threadId).map((h) => h.reason)).toEqual(["start", "move"]);
  });

  it("refuses unknown, disallowed and missing threads", async () => {
    const { host, move } = await setup(["a", "b"]);
    await expect(move("c")).rejects.toMatchObject({ code: "invalid" });
    await expect(move("unknown", "unknown")).rejects.toMatchObject({ code: "invalid" });
    await expect(host.execute({ type: "move", commandId: "missing", threadId: "missing", account: "a" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("matches Desk CapacitySnapshot keys, maps aliases, exposes usage and routing, and excludes settled threads", async () => {
    const { dir, host, store, threadId, pool } = await setup(["a", "b"]);
    writeFileSync(join(dir, "policy.yaml"), "model: example\ndefault: claudeAgent_a\nrepos:\n  Example: [claudeAgent_a, claudeAgent_b]\n");
    pool.applyUsage([{ provider: "Claude", account: "a", windows: [{ kind: "five_hour", remainingPercent: 150, resetsAt: "2030-01-01T00:00:00Z" }, { kind: "seven_day", remainingPercent: 45 }] }]);
    pool.coolDown("claude", "b");
    const snapshot = host.capacity();
    // Field-name fixture copied from apps/screen/server/desk/capacity.ts.
    expect(Object.keys(snapshot).sort()).toEqual(["updatedAt", "loom", "moves", "accounts", "rules", "machine"].sort());
    const a = snapshot.accounts[0]!;
    expect(Object.keys(a).sort()).toEqual(["id", "name", "color", "provider", "status", "coolingUntil", "fiveHour", "weekly", "running", "idle", "threads", "floorPercent", "pinned", "warning", "score", "pace", "load", "forecast", "forecastReason"].sort());
    expect(Object.keys(a.threads[0]!).sort()).toEqual(["itemId", "title", "repo", "running", "lastActiveAt", "allowed", "allowedFrom"].sort());
    expect(a).toMatchObject({ id: "claudeAgent_a", color: null, status: "fresh", coolingUntil: null, running: 1, idle: 0, fiveHour: { left: 100, resetsAt: "2030-01-01T00:00:00.000Z" }, weekly: { left: 45, resetsAt: null } });
    expect(a.threads[0]).toMatchObject({ itemId: `loom:${threadId}`, repo: "example", allowed: ["claudeAgent_a", "claudeAgent_b"] });
    expect(snapshot.accounts[1]?.status).toBe("none");
    expect(typeof snapshot.accounts[1]?.coolingUntil).toBe("string");
    expect(snapshot.rules).toEqual({ default: ["claudeAgent_a"], repos: [{ repo: "example", accounts: ["claudeAgent_a", "claudeAgent_b"] }], error: null });
    expect(snapshot).toMatchObject({ loom: true, moves: true, machine: null });
    store.tx(() => store.updateThread(threadId, { settled_at: store.now() }));
    expect(host.capacity().accounts[0]?.threads).toEqual([]);
    writeFileSync(join(dir, "policy.yaml"), "repos: [bad]");
    expect(capacityRules(join(dir, "policy.yaml"))).toMatchObject({ default: [], repos: [], error: expect.any(String) });
  });

  it("names the account hold and its reset when every allowed account is under the floor (10/19)", async () => {
    const { host, runtime, store, pool, threadId } = await setup(["a"]);
    runtime.last.complete();
    await host.kick(threadId);
    await host.closeAll();
    const reset = Date.parse("2030-01-02T00:00:00Z");
    pool.applyUsage([{ provider: "Claude", account: "a", windows: [{ kind: "seven_day", remainingPercent: 9, resetsAt: new Date(reset).toISOString() }] }]);
    expect(host.capacity().accounts.find((a) => a.name === "a")).toMatchObject({ pinned: 1, warning: "below_floor", floorPercent: 10 });
    const { runId } = await host.execute({ type: "submit", commandId: "held", threadId, text: "still there?" });
    expect(store.run(runId!)?.status).toBe("queued");
    expect(host.snapshot().threads.find((t) => t.id === threadId)).toMatchObject({ admission: "account_limit", admission_until: reset });
    pool.applyUsage([{ provider: "Claude", account: "a", windows: [{ kind: "seven_day", remainingPercent: 15, resetsAt: new Date(reset).toISOString() }] }]);
    expect(host.capacity().accounts.find((a) => a.name === "a")?.warning).toBe("near_floor");
    // The minute sweep notices the account has room before its reset timer would.
    await host.checkWarmth();
    expect(store.run(runId!)?.status).toBe("running");
    expect(store.thread(threadId)).toMatchObject({ admission: null, admission_until: null });
  });

  it("moves a new thread off an account that can't make calls (new terms to accept) instead of failing it (10/20)", async () => {
    const { runtime, store, threadId, runId } = await setup(["a", "b"]);
    const first = runtime.last;
    first.emit({ type: "session.ended", failure: { kind: "auth", message: "Claude Code process exited with code 1\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect" } });
    await vi.waitFor(() => expect(runtime.last).not.toBe(first));
    expect(store.thread(threadId)?.account).toBe("b");
    expect(store.accountHistory(threadId).at(-1)?.reason).toBe("auth");
    expect(store.run(runId)?.status).toBe("running");
    expect(runtime.last.options.account).toBe("b");
  });

  it("one tap moves a held thread to an account it wasn't allowed on, only when the owner says so (D-42)", async () => {
    const { host, runtime, store, pool, threadId } = await setup(["a"]);
    runtime.last.complete();
    await host.kick(threadId);
    await host.closeAll();
    pool.applyUsage([{ provider: "Claude", account: "a", windows: [{ kind: "seven_day", remainingPercent: 9, resetsAt: "2030-01-02T00:00:00Z" }] }]);
    const { runId } = await host.execute({ type: "submit", commandId: "held-2", threadId, text: "still there?" });
    expect(store.thread(threadId)?.admission).toBe("account_limit");
    await expect(host.execute({ type: "move", commandId: "tap-0", threadId, account: "b" })).rejects.toThrow(/disallowed/);
    await host.execute({ type: "move", commandId: "tap-1", threadId, account: "claudeAgent_b", allow: true } as never);
    expect(JSON.parse(store.thread(threadId)!.accounts!)).toEqual(["a", "b"]);
    expect(store.thread(threadId)?.account).toBe("b");
    expect(store.run(runId!)?.status).toBe("running");
    expect(store.thread(threadId)).toMatchObject({ admission: null, admission_until: null });
  });
});


describe("policy-following accounts", () => {
  it("resolves repo pools on submit and follows additions and removals on cold placements", async () => {
    const { host, runtime, store, pool, dir, threadId, runId } = await setup(["a", "b"], "default: [a]\nrepos:\n  example: [b]", "policy");
    expect(store.thread(threadId)).toMatchObject({ account: "b", accounts_source: "policy", accounts: '["b"]' });
    runtime.last.complete(); await host.kick(threadId); await host.closeAll();
    const now = Date.now(); store.now = pool.now = () => now;
    store.updateRun(runId, { ended_at: now - 3_600_001 });
    pool.applyUsage(["a", "b", "c"].map(name => ({ provider: "claude", account: name, windows: [{ kind: "weekly", remainingPercent: name === "c" ? 95 : 20 }] })));
    writeFileSync(join(dir, "policy.yaml"), "default: [a]\nrepos:\n  example: [claudeAgent_b, c, loom, unknown]");
    await host.execute({ type: "submit", commandId: "added", threadId, text: "next" });
    expect(store.thread(threadId)?.account).toBe("c");
    expect(host.capacity().accounts[2]?.threads[0]).toMatchObject({ allowedFrom: "policy", allowed: ["claudeAgent_b", "claudeAgent_c"] });
    runtime.last.complete(); await host.kick(threadId); await host.closeAll();
    writeFileSync(join(dir, "policy.yaml"), "default: [b]");
    await host.execute({ type: "submit", commandId: "removed", threadId, text: "next again" });
    expect(store.thread(threadId)?.account).toBe("b");
    await expect(host.execute({ type: "move", commandId: "no-c", threadId, account: "c" })).rejects.toThrow(/disallowed/);
  });

  it.each(["repos: [bad]", "default: [unknown, loom]", "default: ["])("falls back to the last resolved set for unusable policy %s", async policy => {
    const { host, store, dir, threadId } = await setup(["a"], "default: [a, b]", "policy");
    writeFileSync(join(dir, "policy.yaml"), policy);
    expect(host.capacity().accounts[0]?.threads[0]?.allowed).toEqual(["claudeAgent_a", "claudeAgent_b"]);
    expect(store.thread(threadId)?.accounts).toBe('["a","b"]');
    rmSync(join(dir, "policy.yaml"));
    expect(host.capacity().accounts[0]?.threads[0]?.allowed).toEqual(["claudeAgent_a", "claudeAgent_b"]);
  });

  it("rechecks a pending move after its policy target is removed", async () => {
    const { host, runtime, store, dir, threadId } = await setup(["a", "b"], "default: [a, b]", "policy");
    await host.execute({ type: "move", commandId: "pending", threadId, account: "b" });
    writeFileSync(join(dir, "policy.yaml"), "default: [a]");
    runtime.last.complete(); await host.kick(threadId);
    expect(store.thread(threadId)?.account).toBe("a");
    expect(store.pendingAccountMove(threadId)).toBeNull();
  });

  it("keeps pins literal across policy changes", async () => {
    const { host, store, dir, threadId } = await setup(["a"], "default: [a, b]");
    writeFileSync(join(dir, "policy.yaml"), "default: [b, c]");
    expect(store.thread(threadId)?.accounts_source).toBeNull();
    expect(host.capacity().accounts[0]?.threads[0]).toMatchObject({ allowed: ["claudeAgent_a"], allowedFrom: "pinned" });
  });

  it("an explicit allow freezes the currently resolved set plus the target", async () => {
    const { host, store, dir, threadId } = await setup(["a"], "default: [a, b]", "policy");
    await host.execute({ type: "move", commandId: "allow", threadId, account: "c", allow: true });
    expect(store.thread(threadId)).toMatchObject({ accounts_source: null, accounts: '["a","b","c"]' });
    writeFileSync(join(dir, "policy.yaml"), "default: [b]");
    expect(host.capacity().accounts[0]?.threads[0]).toMatchObject({ allowedFrom: "pinned", allowed: ["claudeAgent_a", "claudeAgent_b", "claudeAgent_c"] });
  });

  it("adopts only matching open multi-seat literals at startup, canonicalizing aliases", async () => {
    const { host, store, pool, dir } = await setup(["a"]);
    await host.closeAll();
    writeFileSync(join(dir, "policy.yaml"), "default: [a, b]");
    const add = (accounts: string[]) => store.createThread({ kind: "coding", cwd: dir, provider: "claude", accounts });
    const match = add(["claudeAgent_b", "a"]), pin = add(["a"]), other = add(["a", "c"]);
    const stopped = add(["a", "b"]), settled = add(["a", "b"]);
    store.updateThread(stopped.id, { status: "stopped" }); store.updateThread(settled.id, { settled_at: 1 });
    const restarted = new LoomHost(store, { claude: new FakeRuntime(store) }, { pool, releasesDir: join(dir, "releases") });
    expect(store.thread(match.id)).toMatchObject({ accounts_source: "policy", accounts: '["a","b"]' });
    for (const t of [pin, other, stopped, settled]) expect(store.thread(t.id)?.accounts_source).toBeNull();
    await restarted.closeAll();
  });
});
