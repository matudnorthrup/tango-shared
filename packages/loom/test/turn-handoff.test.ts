import { describe, it, expect, afterEach, vi } from "vitest";
import { LoomStore } from "../src/store.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";
import { loomToolDefinitions } from "../src/claude/loom-tools.js";
import { AGENT_STALL_WAKE_TEXT, STALL_WAKE_TEXT, UNADDRESSED_WAKE_TEXT } from "../src/handoff.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const flush = () => new Promise(r => setTimeout(r, 0));
function setup() {
  const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(store); const host = new LoomHost(store, { fake: runtime });
  cleanup.push(() => host.closeAll());
  return { store, runtime, host };
}
describe("recorded closing handoffs", () => {
  it.each([['you', 'you'], ['me', 'me'], ['waiting on CI', 'waiting'], ['none', 'none'], ['waiting on you', 'you'], ['waiting on user', 'you'], ['waiting on the owner', 'you']])("retains fallback %s", async (label, owner) => {
    const { host, runtime } = setup();
    const r = await host.execute({ type: "submit", commandId: "start", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.completeWithoutHandoff(`Next — ${label}: action`); await flush();
    expect(host.detail(r.threadId!)?.thread.closingHandoff).toMatchObject({ owner, text: "action", source: "closing-line", runId: r.runId });
    if (owner === "waiting") expect(host.detail(r.threadId!)!.thread.closingHandoff?.waitingOn).toBe("CI");
  });
  it("round trips the tool record and ignores a contradictory closing line", async () => {
    const { host, runtime, store } = setup();
    expect(loomToolDefinitions("thread").find(t => t.name === "handoff")).toBeDefined();
    const r = await host.execute({ type: "submit", commandId: "start", text: "go", cwd: "/repo", provider: "fake" });
    vi.stubEnv("TANGO_OWNER_NAME", "fixture-owner");
    cleanup.push(() => vi.unstubAllEnvs());
    const dir = mkdtempSync(join(tmpdir(), "loom-tool-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "token"), "test-token");
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
      const result = await host.execute(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result }));
    });
    try {
      const tool = loomToolDefinitions(r.threadId!, { LOOM_HOME: dir, LOOM_PORT: "12345" }).find(t => t.name === "handoff")!;
      await tool.handler({ kind: "human", who: "fixture-owner", text: "Review the finished export report", runId: r.runId });
    } finally { vi.unstubAllGlobals(); }
    runtime.last.complete("Next — none: done"); await flush();
    expect(host.detail(r.threadId!)?.thread.closingHandoff).toMatchObject({ owner: "you", text: "Review the finished export report", source: "tool", runId: r.runId });
    expect(JSON.parse(store.thread(r.threadId!)!.ask!)).toMatchObject({ text: "Review the finished export report" });
    const ask = store.thread(r.threadId!)!.ask;
    host.rebuildAsks(); expect(store.thread(r.threadId!)!.ask).toBe(ask);
  });
  it("adds the table on reopening an older database without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-handoff-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "test.db"); let store = new LoomStore(path);
    store.tx(() => store.createThread({ id: "kept", kind: "coding", cwd: "/repo", provider: "fake" }));
    store.db.exec("DROP TABLE turn_handoffs"); const before = store.threads(); store.close();
    store = new LoomStore(path);
    expect(store.threads()).toEqual(before);
    expect(store.db.prepare("SELECT * FROM turn_handoffs").all()).toEqual([]); store.close();
  });
});

describe("a me hand-off with nothing behind it", () => {
  it("wakes the thread once, then marks the hand-off stuck when the wake ends the same way", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "go", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Next — me: run the tests"); await flush();
    const wake = store.runs(r.threadId!).at(-1)!;
    expect(wake).toMatchObject({ source: "wake", text: STALL_WAKE_TEXT });
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ owner: "me", wokeAt: expect.any(Number) });
    runtime.last.complete("Next — me: run the tests"); await flush();
    expect(store.runs(r.threadId!)).toHaveLength(2);
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ owner: "me", runId: wake.id, stuck: true });
  });
  it("marks the standing hand-off stuck when the wake ends with no hand-off of its own", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "go", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Next — me: run the tests"); await flush();
    runtime.last.completeWithoutHandoff("Looked again."); await flush();
    expect(store.runs(r.threadId!)).toHaveLength(2);
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ owner: "me", missingTool: true, stuck: true });
  });
  it("leaves the hand-off alone when a wait is armed or the wake carries on", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "go", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "trigger.create", commandId: "w", threadId: r.threadId!, kind: "time", spec: { afterMinutes: 60 }, note: "check back" });
    runtime.last.complete("Next — me: check back at 3"); await flush();
    expect(store.runs(r.threadId!)).toHaveLength(1);
    expect(host.detail(r.threadId!)!.thread.closingHandoff).not.toHaveProperty("wokeAt");
  });
  it("doesn't wake for a none hand-off", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "go", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Next — none: done."); await flush();
    expect(store.runs(r.threadId!)).toHaveLength(1);
  });
});

describe("a hand-off to another thread", () => {
  const tick = (host: LoomHost) => (host as unknown as { triggers: { tick(): Promise<void> } }).triggers.tick();
  const handTo = (host: LoomHost, store: LoomStore, threadId: string, who: string) =>
    host.execute({ type: "handoff.record", commandId: `h-${Math.random()}`, threadId, kind: "agent", who, text: "review my report", runId: store.activeRun(threadId)!.id });
  it("arms a wait on a busy thread and wakes this one when it settles", async () => {
    const { host, runtime, store } = setup(); let now = Date.now(); store.now = () => now;
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    await handTo(host, store, a.threadId!, `loom:${b.threadId}`);
    runtime.sessions[0]!.complete("Sent the report."); await flush();
    const wait = host.detail(a.threadId!)!.thread.waiting_on;
    expect(wait).toHaveLength(1);
    expect(wait[0]).toMatchObject({ kind: "worker" });
    await tick(host); expect(store.runs(a.threadId!)).toHaveLength(1);
    runtime.sessions[1]!.complete("Next — none: reviewed."); await flush();
    now += 61_000; await tick(host);
    const wake = store.runs(a.threadId!).at(-1)!;
    expect(wake).toMatchObject({ source: "wake" });
    expect(wake.text).toContain("review my report");
  });
  it("a busy peer's own timer does not hold the wait or re-arm after completion", async () => {
    const { host, runtime, store } = setup(); let now = Date.now(); store.now = () => now;
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    host.triggers.create(b.threadId!, "time", { afterMinutes: 120 }, "peer's own timer");
    await handTo(host, store, a.threadId!, `loom:${b.threadId}`);
    runtime.sessions[0]!.complete(); await flush();
    expect(host.triggers.list(a.threadId!, "waiting")).toHaveLength(1);
    runtime.sessions[1]!.complete(); await flush();
    await tick(host); await flush();
    expect(host.triggers.list(a.threadId!, "waiting")).toHaveLength(0);
    await handTo(host, store, a.threadId!, `loom:${b.threadId}`);
    runtime.sessions[0]!.complete(); await flush();
    expect(host.triggers.list(a.threadId!, "waiting")).toHaveLength(0);
  });
  it("arms the wait from a closing line that gives the thread's address", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    runtime.sessions[0]!.complete(`**Next — waiting on the lead (loom:${b.threadId!.slice(0, 8)}):** review my report.`); await flush();
    expect(host.detail(a.threadId!)!.thread.waiting_on).toHaveLength(1);
    expect(store.runs(a.threadId!)).toHaveLength(1);
  });
  it("wakes once when the other thread isn't working on anything, then marks the hand-off stuck", async () => {
    const { host, runtime, store } = setup();
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Ready."); await flush();
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    await handTo(host, store, a.threadId!, `loom:${b.threadId}`);
    runtime.last.complete("Over to the lead."); await flush();
    expect(store.runs(a.threadId!).at(-1)).toMatchObject({ source: "wake", text: AGENT_STALL_WAKE_TEXT });
    expect(host.detail(a.threadId!)!.thread.waiting_on).toHaveLength(0);
    await handTo(host, store, a.threadId!, `loom:${b.threadId}`);
    runtime.last.complete("Still the lead's."); await flush();
    expect(store.runs(a.threadId!)).toHaveLength(2);
    expect(host.detail(a.threadId!)!.thread.closingHandoff).toMatchObject({ stuck: true });
  });
  it("arms nothing when the other thread already waits on this one", async () => {
    const { host, runtime, store } = setup();
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "trigger.create", commandId: "w", threadId: b.threadId!, kind: "worker", spec: { threadId: a.threadId }, note: "a reports" });
    runtime.sessions[0]!.complete("Waiting on a."); await flush();
    await handTo(host, store, a.threadId!, `loom:${b.threadId}`);
    runtime.sessions[1]!.complete("Reported."); await flush();
    expect(host.detail(a.threadId!)!.thread.waiting_on).toHaveLength(0);
    expect(store.runs(a.threadId!)).toHaveLength(1);
  });
  it("arms nothing when a chain of waits from the other thread leads back to this one", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    const c = await host.execute({ type: "submit", commandId: "c", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "trigger.create", commandId: "ab", threadId: a.threadId!, kind: "worker", spec: { threadId: b.threadId }, note: "b reports" });
    await host.execute({ type: "trigger.create", commandId: "bc", threadId: b.threadId!, kind: "worker", spec: { threadId: c.threadId }, note: "c reports" });
    await handTo(host, store, c.threadId!, `loom:${a.threadId}`);
    runtime.sessions[2]!.complete("Reported."); await flush();
    expect(host.detail(c.threadId!)!.thread.waiting_on).toHaveLength(0);
  });
  it("leaves a none hand-off that mentions a thread's address alone", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "b", text: "go", cwd: "/repo", provider: "fake" });
    runtime.sessions[0]!.complete(`**Next — none:** report sent to loom:${b.threadId!.slice(0, 8)}.`); await flush();
    expect(host.detail(a.threadId!)!.thread.waiting_on).toHaveLength(0);
    expect(store.runs(a.threadId!)).toHaveLength(1);
  });
  it("asks once for the address when a closing line names the thread in words", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "a", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.completeWithoutHandoff("**Next — waiting on the Status Labels Audit thread:** it merges #958."); await flush();
    expect(store.runs(a.threadId!).at(-1)).toMatchObject({ source: "wake", text: UNADDRESSED_WAKE_TEXT });
    runtime.last.completeWithoutHandoff("**Next — waiting on CI:** checks on #12."); await flush();
    expect(store.runs(a.threadId!)).toHaveLength(2);
  });
});

describe("host liveness and failure audience", () => {
  it("accepts a heartbeat only for the active run", async () => {
    const { host, runtime } = setup();
    const r = await host.execute({ type: "submit", commandId: "go", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "host.heartbeat", runId: "old", at: 100 });
    expect(host.detail(r.threadId!)!.thread.heartbeatAt).toBeNull();
    runtime.last.emit({ type: "host.heartbeat", runId: r.runId!, at: 200 });
    expect(host.detail(r.threadId!)!.thread.heartbeatAt).toBe(200);
    expect(host.detail(r.threadId!)!.thread.sourceHealth.ok).toBe(true);
    runtime.last.complete(); expect(host.detail(r.threadId!)!.thread.heartbeatAt).toBeNull();
  });
  it.each(["worker", "ops", "job"] as const)("sends a %s failure to its live lead without clearing the worker error", async role => {
    const { host, runtime, store } = setup();
    const lead = await host.execute({ type: "submit", commandId: "lead", text: "lead", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Ready"); await flush();
    const worker = await host.execute({ type: "submit", commandId: "worker", text: "work", cwd: "/repo", provider: "fake", role: role === "job" ? "interactive" : role, kind: role === "job" ? "tango-job" : "coding", parentThreadId: `loom:${lead.threadId}` });
    runtime.last.emit({ type: "turn.failed", runId: worker.runId!, failure: { kind: "other", message: "broken build" } }); await flush();
    expect(store.run(worker.runId!)!.status).toBe("failed");
    expect(store.runs(lead.threadId!).at(-1)!.text).toContain("broken build");
    expect(store.messages(lead.threadId!).at(-1)!.origin).toContain(`failure:${worker.runId}`);
  });
  it("keeps an orphan worker failure for the owner", async () => {
    const { host, runtime, store } = setup();
    const worker = await host.execute({ type: "submit", commandId: "worker", text: "work", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: "loom:missing" });
    runtime.last.emit({ type: "turn.failed", runId: worker.runId!, failure: { kind: "other", message: "broken build" } }); await flush();
    expect(store.run(worker.runId!)!.failure).toContain("broken build");
    expect(store.threads()).toHaveLength(1); expect(store.runs(worker.threadId!)).toHaveLength(1);
  });
});
