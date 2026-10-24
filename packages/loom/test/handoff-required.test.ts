import { afterEach, describe, expect, it, vi } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";
import { MISSING_HANDOFF_WAKE_TEXT, RERECORD_ASK_WAKE_TEXT } from "../src/handoff.js";
import { createLoomServer } from "../src/http.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const flush = () => new Promise(r => setTimeout(r, 0));
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup() {
  const profile = mkdtempSync(join(tmpdir(), "rerecord-profile-"));
  mkdirSync(join(profile, "config"));
  writeFileSync(join(profile, "config", "owner.yaml"), "id: fixture-owner\ndisplay_name: Fixture Owner\n");
  vi.stubEnv("TANGO_PROFILE_DIR", profile);
  cleanups.push(() => { vi.unstubAllEnvs(); rmSync(profile, { recursive: true, force: true }); });
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(); // Deliberately uncooperative: never synthesizes a tool hand-off.
  const host = new LoomHost(store, { fake: runtime });
  cleanups.push(async () => { await host.closeAll(); store.close(); });
  return { host, store, runtime };
}
const start = (host: LoomHost, extra = {}) => host.execute({ type: "submit", commandId: crypto.randomUUID(), text: "work", cwd: "/repo", provider: "fake", ...extra });
const handoff = (host: LoomHost, threadId: string, kind: "nobody" | "agent" | "human", who?: string) => host.execute({ type: "handoff.record", commandId: crypto.randomUUID(), threadId, kind, who, text: kind === "human" ? "Review the finished export report" : "settled" });
function legacy(store: LoomStore, threadId: string, runId: string) {
  const ask = { text: "review the report", at: 1, messageId: "legacy-message", runId };
  store.tx(() => store.updateThread(threadId, { ask: JSON.stringify(ask) }));
  return ask;
}

describe("D-353: only tool hand-offs open Loom asks", () => {
  it.each(["Next — you: approve", "Next — none: done", "No closing line"])("wakes once for %s, then stops Stuck with no owner ask", async text => {
    const { host, store, runtime } = setup();
    const r = await start(host);
    runtime.last.complete(text); await flush();
    expect(store.thread(r.threadId!)!.ask).toBeNull();
    expect(store.runs(r.threadId!).at(-1)).toMatchObject({ source: "wake", text: MISSING_HANDOFF_WAKE_TEXT });
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ missingTool: true, wokeAt: expect.any(Number) });
    runtime.last.complete(text); await flush();
    expect(store.runs(r.threadId!)).toHaveLength(2);
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ missingTool: true, stuck: true });
    expect(store.thread(r.threadId!)!.ask).toBeNull();
    host.rebuildAsks();
    expect(store.thread(r.threadId!)!.ask).toBeNull();
  });
  it("does not replace an existing owner ask from prose; retirement still works", async () => {
    const { host, store, runtime } = setup();
    const r = await start(host);
    const ask = legacy(store, r.threadId!, r.runId!);
    runtime.last.complete("Next — you: a different ask"); await flush();
    expect(JSON.parse(store.thread(r.threadId!)!.ask!)).toMatchObject(ask);
    runtime.last.complete("Next — none: settled"); await flush();
    expect(store.thread(r.threadId!)!.ask).toBeNull();
  });
  it("a thread without Loom's tools still asks the owner from its closing line, with no corrective wake", async () => {
    const { host, store, runtime } = setup();
    const r = await start(host, { session: { loomTools: false } });
    runtime.last.complete("Next — you: approve the plan"); await flush();
    expect(JSON.parse(store.thread(r.threadId!)!.ask!)).toMatchObject({ text: "approve the plan" });
    expect(store.runs(r.threadId!)).toHaveLength(1);
    host.rebuildAsks();
    expect(JSON.parse(store.thread(r.threadId!)!.ask!)).toMatchObject({ text: "approve the plan" });
  });
  it("re-recording skips a thread without Loom's tools", async () => {
    const { host, store, runtime } = setup();
    const r = await start(host, { session: { loomTools: false } });
    runtime.last.complete("Next — you: approve the plan"); await flush();
    expect((await host.execute({ type: "asks.rerecord", commandId: "rerecord" })).asks).toEqual([]);
    expect(store.runs(r.threadId!)).toHaveLength(1);
    expect(JSON.parse(store.thread(r.threadId!)!.ask!)).toMatchObject({ text: "approve the plan" });
  });
  it("the older tool form (owner you, no kind) is still the desk person's ask", async () => {
    const { host, store, runtime } = setup();
    const r = await start(host);
    await host.execute({ type: "handoff.record", commandId: crypto.randomUUID(), threadId: r.threadId!, owner: "you", text: "approve the plan" });
    runtime.last.complete("Done."); await flush();
    expect(JSON.parse(store.thread(r.threadId!)!.ask!)).toMatchObject({ text: "approve the plan" });
    expect(JSON.parse(store.thread(r.threadId!)!.ask!).to).toBeUndefined();
  });
  it.each(["wait", "queued", "background", "worker", "opt-out", "stopped"])("does not wake with %s", async guard => {
    const { host, store, runtime } = setup();
    const r = await start(host, guard === "opt-out" ? { session: { loomTools: false } } : {});
    const session = runtime.last;
    if (guard === "wait") await host.execute({ type: "trigger.create", commandId: "wait", threadId: r.threadId!, kind: "time", spec: { afterMinutes: 60 }, note: "later" });
    if (guard === "queued") store.tx(() => store.createRun(r.threadId!, "wake", "already queued"));
    if (guard === "background") session.emit({ type: "background.changed", tasks: [{ id: "job", kind: "shell", description: "build" }] });
    if (guard === "worker") await start(host, { role: "worker", parentThreadId: `loom:${r.threadId}` });
    if (guard === "stopped") await host.execute({ type: "stop", commandId: "stop", threadId: r.threadId! });
    session.complete("No hand-off"); await flush();
    expect(store.runs(r.threadId!).some(run => run.text === MISSING_HANDOFF_WAKE_TEXT)).toBe(false);
  });
  it("a context-saving reset turn without a hand-off keeps the last one and wakes nothing", async () => {
    const { host, store, runtime } = setup();
    const r = await start(host);
    await handoff(host, r.threadId!, "nobody");
    store.tx(() => store.createRun(r.threadId!, "reset", "save your handoff"));
    runtime.last.complete(); await flush();
    expect(store.runs(r.threadId!).at(-1)).toMatchObject({ source: "reset" });
    runtime.last.complete("Handoff saved."); await flush();
    expect(store.runs(r.threadId!).some(run => run.text === MISSING_HANDOFF_WAKE_TEXT)).toBe(false);
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ source: "tool", text: "settled" });
    expect(host.detail(r.threadId!)!.thread.closingHandoff.missingTool).toBeUndefined();
  });
  it("a tool hand-off on the corrective wake ends the correction", async () => {
    const { host, store, runtime } = setup();
    const r = await start(host);
    runtime.last.complete(); await flush();
    await handoff(host, r.threadId!, "nobody");
    runtime.last.complete(); await flush();
    expect(store.runs(r.threadId!)).toHaveLength(2);
    expect(host.detail(r.threadId!)!.thread.closingHandoff).toMatchObject({ source: "tool", owner: "none" });
    expect(host.detail(r.threadId!)!.thread.closingHandoff?.stuck).toBeUndefined();
  });
});

describe("legacy ask re-record command", () => {
  it.each(["nobody", "agent", "human"] as const)("queues one plain wake and its %s hand-off replaces or retires the ask", async kind => {
    const { host, store, runtime } = setup();
    const lead = await start(host);
    const r = await start(host);
    // An old completed turn, as stored before the new policy. No running model involved.
    store.tx(() => {
      store.updateRun(r.runId!, { status: "completed", ended_at: store.now() });
      store.updateThread(r.threadId!, { status: "idle" });
      store.addMessage(r.threadId!, r.runId!, "assistant", "Next — you: review the report");
    });
    const ask = legacy(store, r.threadId!, r.runId!);
    host.rebuildAsks(); // Deploy startup must not silently lose the legacy ask before migration.
    expect(store.thread(r.threadId!)!.ask).not.toBeNull();
    const dry = await host.execute({ type: "asks.rerecord", commandId: "dry", dryRun: true });
    expect(dry.asks).toEqual([{ threadId: r.threadId, title: null, ask: expect.objectContaining({ text: ask.text }), queued: false }]);
    expect(store.runs(r.threadId!)).toHaveLength(1);
    const result = await host.execute({ type: "asks.rerecord", commandId: "real" });
    expect(result.asks).toHaveLength(1);
    expect(store.activeRun(r.threadId!)).toMatchObject({ source: "wake", text: RERECORD_ASK_WAKE_TEXT });
    expect((await host.execute({ type: "asks.rerecord", commandId: "again" })).asks).toEqual([]);
    await handoff(host, r.threadId!, kind, kind === "agent" ? `loom:${lead.threadId}` : kind === "human" ? "fixture-owner" : undefined);
    runtime.last.complete("Recorded"); await flush();
    const final = store.thread(r.threadId!)!.ask;
    if (kind === "agent") expect(JSON.parse(final!)).toMatchObject({ toAddress: `loom:${lead.threadId}` });
    else if (kind === "human") expect(JSON.parse(final!)).toMatchObject({ text: "Review the finished export report" });
    else expect(final).toBeNull();
    host.rebuildAsks(); expect(store.thread(r.threadId!)!.ask).toBe(final);
  });
  it("skips stopped, agent-addressed and already tool-recorded asks, and deduplicates after restart", async () => {
    const { host, store } = setup();
    const pending = await start(host);
    legacy(store, pending.threadId!, pending.runId!);
    for (const skip of ["stopped", "agent", "tool"]) {
      const r = await start(host);
      const ask = legacy(store, r.threadId!, r.runId!);
      if (skip === "stopped") await host.execute({ type: "stop", commandId: "stop", threadId: r.threadId! });
      if (skip === "agent") store.tx(() => store.updateThread(r.threadId!, { ask: JSON.stringify({ ...ask, to: "Lead", toAddress: `loom:${pending.threadId}` }) }));
      if (skip === "tool") await handoff(host, r.threadId!, "human", "fixture-owner");
    }
    expect((await host.execute({ type: "asks.rerecord", commandId: "dry", dryRun: true })).asks?.map(a => a.threadId)).toEqual([pending.threadId]);
    await host.execute({ type: "asks.rerecord", commandId: "queue" });
    await host.detachAll();
    const restarted = new LoomHost(store, { fake: new FakeRuntime() });
    cleanups.push(() => restarted.closeAll());
    expect((await restarted.execute({ type: "asks.rerecord", commandId: "retry" })).asks).toEqual([]);
  });
  it("reads the hand-off that opened the ask, not a later turn's tool hand-off that left it (Codex review on #990)", async () => {
    const { host, store } = setup();
    const r = await start(host);
    legacy(store, r.threadId!, "an-older-run");
    await handoff(host, r.threadId!, "agent", `loom:${r.threadId}`);
    expect((await host.execute({ type: "asks.rerecord", commandId: "dry", dryRun: true })).asks?.map(a => a.threadId)).toEqual([r.threadId]);
  });
  it("CLI dry-run lists fixture asks through the authenticated command endpoint", async () => {
    const { host, store } = setup();
    const r = await start(host);
    legacy(store, r.threadId!, r.runId!);
    const home = mkdtempSync(join(tmpdir(), "rerecord-cli-"));
    writeFileSync(join(home, "token"), "fixture-token");
    const server = createLoomServer(host, { token: "fixture-token" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); });
    const port = (server.address() as { port: number }).port;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "asks", "rerecord", "--dry-run"], { env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port) } });
    expect(JSON.parse(stdout).asks).toEqual([{ threadId: r.threadId, title: null, ask: expect.objectContaining({ text: "review the report" }), queued: false }]);
    expect(store.runs(r.threadId!)).toHaveLength(1);
    console.log("Re-record CLI fixture dry-run:", stdout);
  });
});
