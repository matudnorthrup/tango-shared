import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import type { OpenSessionOptions, RuntimeEmit, RuntimeSession } from "../src/runtime.js";
import { FakeRuntime, type FakeSession } from "./fake-runtime.js";

/** Model the release router while keeping turns and background events under test control. */
class ReleaseRuntime extends FakeRuntime {
  startedAt = Date.now();
  override get last(): FakeSession & RuntimeSession { return super.last; }
  constructor(readonly root: string, store: LoomStore) { super(store); }
  async attach(options: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession | null> {
    const session = this.sessions.findLast((entry) => entry.options.threadId === options.threadId && !entry.closed);
    if (session) Object.assign(session, { emit });
    return session ?? null;
  }
  override async open(options: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession> {
    const session = await super.open(options, emit);
    const state = JSON.parse(fs.readFileSync(path.join(this.root, "state.json"), "utf8"));
    session.hello = {
      release: state.pins[options.threadId] ?? state.current,
      instanceId: `host-${this.sessions.length}`,
      startedAt: this.startedAt,
    };
    return session;
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { maxHostAgeMs?: number; upgradeIntervalMs?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-upgrades-"));
  const store = new LoomStore(":memory:");
  const runtime = new ReleaseRuntime(root, store);
  const state = (current: string, pins: Record<string, string> = {}) => {
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ current, previous: null, candidates: [], history: [], pins }));
  };
  state("old");
  const host = new LoomHost(store, { fake: runtime }, { releasesDir: root, upgradeIntervalMs: 60_000, ...options });
  cleanups.push(async () => { await host.closeAll(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const submit = () => host.execute({ type: "submit", commandId: "start", text: "work", cwd: "/repo", provider: "fake" });
  return { root, store, runtime, host, state, submit };
}

const background = [{ id: "watch-1", kind: "monitor", description: "Watch the build finish" }];

describe("release upgrades", () => {
  it("moves idle threads on the timer and resumes their native sessions", async () => {
    const { host, runtime, store, state, submit } = setup({ upgradeIntervalMs: 10 });
    const thread = await submit();
    const old = runtime.last;
    old.emit({ type: "session.native", nativeSessionId: "native-1" });
    old.complete();
    await flush();
    state("new");
    await expect.poll(() => store.thread(thread.threadId!)!.host_release).toBe("new");
    expect(old.closed).toBe(true);
    expect(runtime.last.options.nativeSessionId).toBe("native-1");
    expect(runtime.last.turns).toHaveLength(0);
    expect(host.hasSession(thread.threadId!)).toBe(true);
  });

  it("keeps a foreground turn on its host and moves immediately after turn end", async () => {
    const { host, runtime, store, state, submit } = setup();
    const thread = await submit();
    const old = runtime.last;
    state("new");
    await host.checkUpgrades();
    expect(old.closed).toBe(false);
    expect(runtime.sessions).toHaveLength(1);
    old.complete("finished before moving");
    await expect.poll(() => store.thread(thread.threadId!)!.host_release).toBe("new");
    expect(store.run(thread.runId!)!.status).toBe("completed");
    expect(old.closed).toBe(true);
  });

  it("waits for background.changed to report no tasks", async () => {
    const { host, runtime, state, submit } = setup({ backgroundSettleMs: 0 });
    await submit();
    const old = runtime.last;
    old.emit({ type: "background.changed", tasks: background });
    old.complete();
    await flush();
    state("new");
    await host.checkUpgrades();
    expect(old.closed).toBe(false);
    old.emit({ type: "background.changed", tasks: [] });
    await host.checkUpgrades();
    expect(old.closed).toBe(true);
    expect(runtime.sessions).toHaveLength(2);
  });

  it("doesn't wait for an ambient watcher: it's kept on the thread for the desk, not work", async () => {
    const { host, runtime, state, submit, store } = setup();
    const thread = await submit();
    const old = runtime.last;
    old.emit({ type: "background.changed", tasks: [{ id: "w1", kind: "monitor", description: "Watch the PR", ambient: true }] });
    old.complete();
    await flush();
    expect(JSON.parse(store.thread(thread.threadId!)!.background!)).toEqual([{ id: "w1", kind: "monitor", description: "Watch the PR", ambient: true }]);
    state("new");
    await host.checkUpgrades();
    expect(old.closed).toBe(true);
    // Closing the harness stopped the watcher: one wake says so, truthfully (not a maximum-age cutoff).
    const wakes = store.runs(thread.threadId!).filter((run) => run.source === "wake");
    expect(wakes.map((run) => run.text)).toEqual(["Loom moved this session to release new. These watchers were stopped: Watch the PR (w1). Re-create them if you still need them."]);
  });

  it("a watcher finishing holds the upgrade for its wake, like work finishing", async () => {
    const { host, runtime, state, submit } = setup();
    await submit();
    const old = runtime.last;
    old.emit({ type: "background.changed", tasks: [{ id: "w1", kind: "monitor", description: "Watch the PR", ambient: true }] });
    old.complete();
    await flush();
    // The watcher fired: the harness wakes the agent a moment later; not a safe point yet.
    old.emit({ type: "background.changed", tasks: [] });
    await flush();
    state("new");
    await host.checkUpgrades();
    expect(old.closed).toBe(false);
  });

  it("cuts off aged background work and queues one wake naming every task", async () => {
    const { host, runtime, store, state, submit } = setup({ maxHostAgeMs: 100 });
    runtime.startedAt = Date.now() - 1_000;
    const thread = await submit();
    const old = runtime.last;
    old.emit({ type: "background.changed", tasks: [...background, { id: "shell-2", kind: "local_bash", description: "Run the slow checks" }] });
    old.complete();
    await flush();
    state("new");
    await host.checkUpgrades();
    await host.checkUpgrades();
    expect(old.closed).toBe(true);
    expect(store.thread(thread.threadId!)!.background).toBeNull();
    const wakes = store.runs(thread.threadId!).filter((run) => run.source === "wake");
    expect(wakes).toHaveLength(1);
    expect(runtime.last.turns).toHaveLength(1);
    expect(runtime.last.turns[0]!.text).toContain("Watch the build finish");
    expect(runtime.last.turns[0]!.text).toContain("Run the slow checks");
  });

  it("never cuts off an aged foreground turn", async () => {
    const { host, runtime, state, submit } = setup({ maxHostAgeMs: 100 });
    runtime.startedAt = Date.now() - 1_000;
    await submit();
    const old = runtime.last;
    old.emit({ type: "background.changed", tasks: background });
    state("new");
    await host.checkUpgrades();
    expect(old.closed).toBe(false);
    expect(runtime.sessions).toHaveLength(1);
  });

  it("keeps open questions on their original host, even after maximum age", async () => {
    const { host, runtime, store, state, submit } = setup({ maxHostAgeMs: 100 });
    runtime.startedAt = Date.now() - 1_000;
    const thread = await submit();
    const old = runtime.last;
    old.emit({ type: "request.opened", runId: thread.runId!, requestId: "question-1", kind: "question", payload: { question: "Which build?" } });
    old.complete();
    await flush();
    // Model a durable open question independently of foreground state.
    store.tx(() => store.openRequest(thread.threadId!, thread.runId!, "question", {}, "question-2"));
    state("new");
    await host.checkUpgrades();
    expect(old.closed).toBe(false);
    expect(store.request("question-2")!.status).toBe("open");
  });

  it("honors pins until removed, then rolls back through the same safe point", async () => {
    const { host, runtime, store, state, submit } = setup();
    const thread = await submit();
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-pinned" });
    runtime.last.complete();
    await flush();
    state("new", { [thread.threadId!]: "old" });
    await host.checkUpgrades();
    expect(runtime.sessions).toHaveLength(1);
    expect(store.thread(thread.threadId!)!.host_release).toBe("old");
    state("new");
    await host.checkUpgrades();
    expect(runtime.sessions).toHaveLength(2);
    expect(store.thread(thread.threadId!)!.host_release).toBe("new");
    state("old");
    await host.checkUpgrades();
    expect(runtime.sessions).toHaveLength(3);
    expect(store.thread(thread.threadId!)!.host_release).toBe("old");
    expect(runtime.last.options.nativeSessionId).toBe("native-pinned");
  });

  it("shows target release and whether safe point or maximum age is pending", async () => {
    const { host, runtime, state, submit } = setup({ maxHostAgeMs: 100 });
    const thread = await submit();
    expect(host.detail(thread.threadId!)!.thread).toMatchObject({ host_release: "old", target_release: "old", upgrade: "current" });
    state("new");
    expect(host.snapshot().threads[0]).toMatchObject({ host_release: "old", target_release: "new", upgrade: "waiting_safe_point" });
    runtime.last.hello!.startedAt = Date.now() - 1_000;
    expect(host.detail(thread.threadId!)!.thread.upgrade).toBe("max_age_pending");
    expect(host.releases()).toMatchObject({ current: "new", live_hosts: { old: 1 } });
  });

  it("restores background tasks from hello when a coordinator reattaches", async () => {
    const { host, runtime, store, root, state, submit } = setup();
    const thread = await submit();
    runtime.last.complete();
    await flush();
    runtime.last.hello!.background = background;
    await host.detachAll();
    state("new");
    const recovered = new LoomHost(store, { fake: runtime }, { releasesDir: root });
    cleanups.unshift(async () => { await recovered.closeAll(); });
    await recovered.recover();
    expect(JSON.parse(store.thread(thread.threadId!)!.background!)).toEqual(background);
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.last.closed).toBe(false);
  });

  it.each(["before close", "after close", "after replacement"])("finishes a durable host move after a crash %s without duplicating its wake", async (window) => {
    const { host, runtime, store, root, state, submit } = setup();
    const thread = await submit();
    const old = runtime.last;
    old.emit({ type: "session.native", nativeSessionId: "native-durable" });
    old.complete();
    await flush();
    const note = "Background tasks cut off: Watch the build finish (watch-1).";
    store.tx(() => store.beginHostMove(thread.threadId!, old.hello!.instanceId, note));
    state("new");
    await host.detachAll();
    if (window !== "before close") await old.close();
    if (window === "after replacement") {
      await runtime.open({ ...old.options, nativeSessionId: "native-durable" }, () => {});
      store.tx(() => store.updateThread(thread.threadId!, { host_release: "new", host_instance_id: runtime.last.hello!.instanceId }));
    }
    const recovered = new LoomHost(store, { fake: runtime }, { releasesDir: root });
    cleanups.unshift(async () => { await recovered.closeAll(); });
    await recovered.recover();
    await recovered.checkUpgrades();
    expect(old.closed).toBe(true);
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.closed).toBe(false);
    expect(runtime.last.options.nativeSessionId).toBe("native-durable");
    expect(runtime.last.turns.map((turn) => turn.text)).toEqual([note]);
    expect(store.runs(thread.threadId!).filter((run) => run.source === "wake")).toHaveLength(1);
    expect(store.hostMove(thread.threadId!)).toBeUndefined();
  });

  it("does not dispatch work held after an auth failure on an upgrade timer tick", async () => {
    const { host, runtime, store, submit } = setup();
    const thread = await submit();
    const queued = await host.execute({ type: "submit", commandId: "queued", threadId: thread.threadId!, text: "wait for auth" });
    runtime.last.emit({ type: "turn.failed", runId: thread.runId!, failure: { kind: "auth", message: "Sign in required" } });
    await flush();
    await host.checkUpgrades();
    expect(store.run(queued.runId!)!.status).toBe("queued");
    expect(runtime.last.turns.map((turn) => turn.text)).toEqual(["work"]);
  });

  it("leaves a host alive without a wake when its atomic safe-close refuses a move", async () => {
    const { host, runtime, store, state, submit } = setup();
    const thread = await submit();
    const old = runtime.last;
    old.complete();
    await flush();
    // Background work or a question can appear at the host after the coordinator checks.
    const attempts: boolean[] = [];
    old.closeForUpgrade = async (forceBackground) => { attempts.push(forceBackground); return false; };
    state("new");
    await host.checkUpgrades();
    expect(attempts).toEqual([false]);
    expect(old.closed).toBe(false);
    expect(runtime.sessions).toHaveLength(1);
    expect(store.thread(thread.threadId!)!.host_release).toBe("old");
    expect(store.runs(thread.threadId!).filter((run) => run.source === "wake")).toHaveLength(0);
    expect(store.hostMove(thread.threadId!)).toBeUndefined();
  });


  it("does not route threads to a promoted release whose hosts speak a protocol this coordinator lacks (Codex review on #651)", async () => {
    const { host, runtime, store, state, submit, root } = setup();
    const thread = await submit();
    runtime.last.complete();
    await flush();
    fs.mkdirSync(path.join(root, "next"));
    fs.writeFileSync(path.join(root, "next", "release.json"), JSON.stringify({ id: "next", hostProtocol: [1, 2], hostSpeaks: 2 }));
    state("next");
    await host.checkUpgrades();
    expect(runtime.sessions).toHaveLength(1);
    expect(store.thread(thread.threadId!)!.host_release).toBe("old");
    expect((host.snapshot().threads[0] as { upgrade: string }).upgrade).toBe("current");
  });

  it("does not move a thread in the moment between its background task ending and the wake that reports it", async () => {
    const { host, runtime, store, state, submit } = setup({ backgroundSettleMs: 200 });
    const thread = await submit();
    const old = runtime.last;
    old.emit({ type: "background.changed", tasks: background });
    old.complete();
    await flush();
    state("new");
    old.emit({ type: "background.changed", tasks: [] });
    await host.checkUpgrades();
    expect(old.closed).toBe(false);
    expect(store.thread(thread.threadId!)!.host_release).toBe("old");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await host.checkUpgrades();
    expect(store.thread(thread.threadId!)!.host_release).toBe("new");
  });
});


it("names the frozen tasks rather than the pre-close cached tasks", async () => {
  const { host, runtime, store, state, submit } = setup({ maxHostAgeMs: 0 });
  const r = await submit(); const old = runtime.last;
  old.complete(); await flush();
  old.emit({ type: "background.changed", tasks: [{ id: "cached", kind: "shell", description: "stale task" }] });
  old.closeForUpgrade = async () => [{ id: "frozen", kind: "shell", description: "actual frozen task" }];
  state("new"); await host.checkUpgrades();
  const note = store.runs(r.threadId!).find(run => run.source === "wake")!.text;
  expect(note).toContain("actual frozen task (frozen)"); expect(note).not.toContain("stale task");

});

it("a release move at the host limit replaces the host instead of stranding the thread (10/17 deploy)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-upgrade-limit-"));
  const store = new LoomStore(":memory:");
  const runtime = new ReleaseRuntime(root, store);
  const state = (current: string) => fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ current, previous: null, candidates: [], history: [], pins: {} }));
  state("old");
  const healthy = { memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1024 ** 4, freeBytes: 500 * 1024 ** 3 } };
  const host = new LoomHost(store, { fake: runtime }, { releasesDir: root, upgradeIntervalMs: 60_000, pressure: async () => healthy, warmthLimits: { maxWarmHosts: 1 } });
  cleanups.push(async () => { await host.closeAll(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const thread = await host.execute({ type: "submit", commandId: "start", text: "work", cwd: "/repo", provider: "fake" });
  runtime.last.complete();
  await flush();
  state("new");
  await host.checkUpgrades();
  expect(store.thread(thread.threadId!)!.host_release).toBe("new");
  expect(host.hasSession(thread.threadId!)).toBe(true);
  expect(store.thread(thread.threadId!)!.admission ?? null).toBeNull();
});
