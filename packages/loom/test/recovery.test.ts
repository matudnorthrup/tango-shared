import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LoomHost } from "../src/host.js";
import { HostOutcomeUnknown, type OpenSessionOptions, type Runtime, type RuntimeEmit, type RuntimeEvent, type RuntimeSession } from "../src/runtime.js";
import { LoomStore } from "../src/store.js";

/** A host that outlives each coordinator connection, including its replay buffer. */
class RecoverableRuntime implements Runtime {
  instanceId = "host-one";
  activeRunId: string | null = null;
  events: { seq: number; event: RuntimeEvent }[] = [];
  answeredAnswers: Record<string, unknown> = {};
  injectedSteers: string[] = [];
  injectCalls = 0;
  answers: { requestId: string; answer: unknown }[] = [];
  acknowledged: number[] = [];
  activated: number[] = [];
  turns: string[] = [];
  private emit: RuntimeEmit | null = null;

  async open(_options: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession> {
    return this.connect(emit);
  }

  async attach(_options: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession> {
    return this.connect(emit);
  }

  private connect(emit: RuntimeEmit): RuntimeSession {
    return {
      hello: { release: "test-release", instanceId: this.instanceId, activeRunId: this.activeRunId, answeredRequests: Object.keys(this.answeredAnswers), answeredAnswers: this.answeredAnswers, injectedSteers: this.injectedSteers },
      activate: (afterSeq) => {
        this.activated.push(afterSeq);
        this.emit = emit;
        // Deliberately replay even acknowledged events: coordinator deduplication is the backstop.
        for (const entry of this.events) emit(entry.event, entry.seq);
      },
      acknowledge: (seq) => this.acknowledged.push(seq),
      detach: () => { this.emit = null; },
      startTurn: ({ runId }) => { this.activeRunId = runId; this.turns.push(runId); },
      inject: async (_text, _images, steerId) => {
        if (steerId && !this.injectedSteers.includes(steerId)) { this.injectedSteers.push(steerId); this.injectCalls++; }
      },
      interrupt: async () => {},
      respond: (requestId, answer) => { this.answers.push({ requestId, answer }); },
      close: async () => { this.emit = null; },
    };
  }

  send(event: RuntimeEvent): void {
    const seq = this.events.length + 1;
    this.events.push({ seq, event });
    if (event.type === "turn.completed") this.activeRunId = null;
    this.emit?.(event, seq);
  }
}

describe("coordinator host recovery", () => {
  it("rebinds a replayed wake to the same durable run after reopening the store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loom-wake-recovery-"));
    const path = join(directory, "loom.sqlite");
    let store = new LoomStore(path);
    const runtime = new RecoverableRuntime();
    let coordinator = new LoomHost(store, { fake: runtime });
    try {
      const submitted = await coordinator.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
      const threadId = submitted.threadId!;
      runtime.send({ type: "turn.completed", runId: submitted.runId! });
      const bound: string[] = [];
      runtime.send({
        type: "wake.started", wakeId: "background-completed", text: "Background work finished",
        bind: (runId) => { bound.push(runId); runtime.activeRunId = runId; },
      });
      expect(bound).toHaveLength(1);
      const wakeRunId = bound[0];
      expect(store.run(wakeRunId)!.source).toBe("wake");
      await coordinator.detachAll();
      store.close();

      store = new LoomStore(path);
      coordinator = new LoomHost(store, { fake: runtime });
      expect(await coordinator.recover()).toEqual({ interrupted: 0, continued: 0 });
      expect(bound).toEqual([wakeRunId, wakeRunId]);
      expect(store.runs(threadId).filter((run) => run.source === "wake")).toHaveLength(1);
      expect(store.run(wakeRunId)!.status).toBe("running");
      expect(store.hostWake(threadId, runtime.instanceId, "background-completed")).toBe(wakeRunId);
    } finally {
      await coordinator.detachAll();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the message together with its sequence when checkpointing fails, then replays once", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new RecoverableRuntime();
    let coordinator = new LoomHost(store, { fake: runtime });
    const originalUpdate = store.updateThread.bind(store);
    let failCheckpoint = true;
    const checkpoint = vi.spyOn(store, "updateThread").mockImplementation((id, patch) => {
      if (failCheckpoint && patch.host_seq === 1) {
        failCheckpoint = false;
        throw new Error("checkpoint write failed");
      }
      originalUpdate(id, patch);
    });
    try {
      const submitted = await coordinator.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
      const threadId = submitted.threadId!;
      const changesBefore = store.thread(threadId)!.host_seq;
      expect(() => runtime.send({ type: "message.completed", runId: submitted.runId!, text: "Durable result" })).toThrow("checkpoint write failed");
      expect(store.thread(threadId)!.host_seq).toBe(changesBefore);
      expect(store.messages(threadId).map((message) => message.text)).toEqual(["work"]);
      expect(runtime.acknowledged).not.toContain(1);
      await coordinator.detachAll();

      coordinator = new LoomHost(store, { fake: runtime });
      expect(await coordinator.recover()).toEqual({ interrupted: 0, continued: 0 });
      expect(store.thread(threadId)!.host_seq).toBe(1);
      expect(store.messages(threadId).filter((message) => message.text === "Durable result")).toHaveLength(1);
      expect(runtime.acknowledged).toContain(1);
    } finally {
      checkpoint.mockRestore();
      await coordinator.detachAll();
      store.close();
    }
  });

  it("publishes streaming deltas without persisting a message or advancing the host checkpoint", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new RecoverableRuntime();
    const coordinator = new LoomHost(store, { fake: runtime });
    const published: unknown[] = [];
    coordinator.subscribe((event) => published.push(event));
    try {
      const submitted = await coordinator.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
      runtime.send({ type: "message.delta", runId: submitted.runId!, text: "partial text" });
      expect(store.thread(submitted.threadId!)!.host_seq).toBe(0);
      expect(store.messages(submitted.threadId!).map((message) => message.text)).toEqual(["work"]);
      expect(published).toContainEqual(expect.objectContaining({ type: "delta", runId: submitted.runId!, text: "partial text" }));
    } finally {
      await coordinator.detachAll();
      store.close();
    }
  });

  it("preserves a running turn and open question, and delivers its answer after reattach", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new RecoverableRuntime();
    const first = new LoomHost(store, { fake: runtime });
    const submitted = await first.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
    const threadId = submitted.threadId!;
    const runId = submitted.runId!;
    runtime.send({ type: "request.opened", runId, requestId: "question", kind: "question", payload: { question: "Which?" } });
    await first.detachAll();

    const recovered = new LoomHost(store, { fake: runtime });
    try {
      expect(await recovered.recover()).toEqual({ interrupted: 0, continued: 0 });
      expect(store.run(runId)!.status).toBe("running");
      expect(store.thread(threadId)!.status).toBe("waiting");
      expect(store.request("question")!.status).toBe("open");
      expect(store.runs(threadId)).toHaveLength(1);
      expect(runtime.turns).toEqual([runId]);
      await recovered.execute({ type: "answer", commandId: "answer", requestId: "question", answer: "A" });
      expect(runtime.answers).toEqual([{ requestId: "question", answer: "A" }]);
      expect(store.request("question")!.status).toBe("answered");
    } finally {
      await recovered.detachAll();
      store.close();
    }
  });

  it("persists replay sequence atomically with completed messages across reopened stores", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loom-recovery-"));
    const path = join(directory, "loom.sqlite");
    let store = new LoomStore(path);
    const runtime = new RecoverableRuntime();
    let coordinator = new LoomHost(store, { fake: runtime });
    try {
      const submitted = await coordinator.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
      const threadId = submitted.threadId!;
      const runId = submitted.runId!;
      runtime.send({ type: "session.native", nativeSessionId: "native-session" });
      await coordinator.detachAll();
      store.close();
      runtime.send({ type: "message.completed", runId, text: "Finished while disconnected" });
      runtime.send({ type: "turn.completed", runId });

      store = new LoomStore(path);
      coordinator = new LoomHost(store, { fake: runtime });
      expect(await coordinator.recover()).toEqual({ interrupted: 0, continued: 0 });
      expect(store.run(runId)!.status).toBe("completed");
      expect(store.messages(threadId).filter((message) => message.text === "Finished while disconnected")).toHaveLength(1);
      expect(store.thread(threadId)!.host_seq).toBe(3);
      await coordinator.detachAll();
      store.close();

      store = new LoomStore(path);
      coordinator = new LoomHost(store, { fake: runtime });
      expect(await coordinator.recover()).toEqual({ interrupted: 0, continued: 0 });
      expect(runtime.activated).toEqual([0, 1, 3]);
      expect(store.messages(threadId).filter((message) => message.text === "Finished while disconnected")).toHaveLength(1);
      expect(store.runs(threadId)).toHaveLength(1);
      expect(store.thread(threadId)!.host_release).toBe("test-release");
      expect(runtime.acknowledged).toContain(3);
    } finally {
      await coordinator.detachAll();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resets the replay cursor when a replacement host has a different instance identity", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new RecoverableRuntime();
    let coordinator = new LoomHost(store, { fake: runtime });
    try {
      const submitted = await coordinator.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
      const threadId = submitted.threadId!;
      const runId = submitted.runId!;
      runtime.send({ type: "session.native", nativeSessionId: "native-session" });
      runtime.send({ type: "usage.observed", utilization: 0.25 });
      expect(store.thread(threadId)!.host_seq).toBe(2);
      await coordinator.detachAll();

      runtime.instanceId = "host-two";
      runtime.events = [];
      runtime.send({ type: "message.completed", runId, text: "Replacement result" });
      runtime.send({ type: "turn.completed", runId });
      coordinator = new LoomHost(store, { fake: runtime });
      expect(await coordinator.recover()).toEqual({ interrupted: 0, continued: 0 });
      expect(runtime.activated).toEqual([0, 0]);
      expect(store.thread(threadId)!.host_instance_id).toBe("host-two");
      expect(store.run(runId)!.status).toBe("completed");
      expect(store.messages(threadId).filter((message) => message.text === "Replacement result")).toHaveLength(1);
      expect(store.runs(threadId)).toHaveLength(1);
    } finally {
      await coordinator.detachAll();
      store.close();
    }
  });
});

it("waits for host answer acceptance and shares concurrent command retries", async () => {
  const store = new LoomStore(":memory:");
  const runtime = new RecoverableRuntime();
  const open = runtime.open.bind(runtime);
  let accept!: () => void;
  let deliveries = 0;
  runtime.open = async (options, emit) => {
    const session = await open(options, emit);
    session.respond = () => {
      deliveries++;
      return new Promise<void>((resolve) => { accept = resolve; });
    };
    return session;
  };
  const host = new LoomHost(store, { fake: runtime });
  try {
    const result = await host.execute({ type: "submit", commandId: "submit", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
    runtime.send({ type: "request.opened", runId: result.runId!, requestId: "question", kind: "question", payload: {} });
    const answer = { type: "answer" as const, commandId: "answer", requestId: "question", answer: "yes" };
    const first = host.execute(answer);
    const retry = host.execute(answer);
    expect(deliveries).toBe(1);
    expect(store.request("question")!.status).toBe("open");
    accept();
    await Promise.all([first, retry]);
    expect(store.request("question")!.status).toBe("answered");
  } finally { await host.detachAll(); store.close(); }
});


it("recovers an accepted answer after the coordinator transaction failed", async () => {
  const store = new LoomStore(":memory:");
  const runtime = new RecoverableRuntime();
  const first = new LoomHost(store, { fake: runtime });
  const run = await first.execute({ type: "submit", commandId: "s", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
  runtime.send({ type: "request.opened", runId: run.runId!, requestId: "q", kind: "question", payload: {} });
  // The host accepted, but the coordinator never recorded the answer.
  runtime.answeredAnswers.q = "yes";
  await first.detachAll();
  runtime.send({ type: "turn.completed", runId: run.runId! });
  const second = new LoomHost(store, { fake: runtime });
  try {
    expect(await second.recover()).toEqual({ interrupted: 0, continued: 0 });
    expect(store.request("q")).toMatchObject({ status: "answered", answer: JSON.stringify("yes") });
    expect(store.thread(run.threadId!)!.status).toBe("idle");
  } finally { await second.detachAll(); store.close(); }
});

it("queues a steer when async injection rejects", async () => {
  const store = new LoomStore(":memory:");
  const runtime = new RecoverableRuntime();
  const open = runtime.open.bind(runtime);
  runtime.open = async (options, emit) => {
    const session = await open(options, emit);
    session.inject = async () => { throw new Error("not accepted"); };
    return session;
  };
  const host = new LoomHost(store, { fake: runtime });
  try {
    const first = await host.execute({ type: "submit", commandId: "s", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
    const result = await host.execute({ type: "submit", commandId: "steer", threadId: first.threadId, text: "keep this", steer: true });
    expect(result.steered).toBe(false);
    expect(result.runId).not.toBe(first.runId);
    expect(store.run(result.runId!)!.status).toBe("queued");
    expect(store.messages(first.threadId!).filter((m) => m.text === "keep this")).toHaveLength(1);
  } finally { await host.detachAll(); store.close(); }
});


it("continues a thread with a truncated pending tail and still recovers other threads", async () => {
  const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const { RemoteRuntime } = await import("../src/remote-runtime.js");
  const directory = mkdtempSync(join(tmpdir(), "loom-corrupt-recovery-"));
  const store = new LoomStore(":memory:");
  const fake = new RecoverableRuntime();
  const first = new LoomHost(store, { fake });
  const run = await first.execute({ type: "submit", commandId: "s", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
  fake.send({ type: "session.native", nativeSessionId: "native" });
  await first.detachAll();
  mkdirSync(join(directory, "hosts"));
  writeFileSync(join(directory, "hosts", run.threadId + ".pending.jsonl"), '{"type":');
  const remote = new RemoteRuntime({ loomHome: directory, claude: { accounts: [], defaultAccount: "fake", sharedProjectsDir: directory } });
  const runtime: Runtime = { open: fake.open.bind(fake), attach: async () => null, drainPending: remote.drainPending.bind(remote) };
  const recovered = new LoomHost(store, { fake: runtime });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await recovered.recover()).toEqual({ interrupted: 1, continued: 1 });
    expect(store.run(run.runId!)!.status).toBe("interrupted");
    expect(store.runs(run.threadId!).filter((r) => r.source === "continue")).toHaveLength(1);
    expect(readdirSync(join(directory, "hosts"))[0]).toContain(".pending.corrupt-");
  } finally { warn.mockRestore(); await recovered.detachAll(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("retries a steer whose delivery outcome is unknown with the same steer id, and never queues it twice (Codex review on #638)", async () => {
  const store = new LoomStore(":memory:");
  const runtime = new RecoverableRuntime();
  const calls: (string | undefined)[] = [];
  const open = runtime.open.bind(runtime);
  runtime.open = async (options, emit) => {
    const session = await open(options, emit);
    session.inject = async (_text, _images, steerId) => {
      calls.push(steerId);
      if (calls.length === 1) throw new HostOutcomeUnknown("Session host command timed out: inject");
    };
    return session;
  };
  const host = new LoomHost(store, { fake: runtime });
  try {
    const first = await host.execute({ type: "submit", commandId: "s", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
    const result = await host.execute({ type: "submit", commandId: "steer", threadId: first.threadId, text: "keep this", steer: true });
    expect(result.steered).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
    expect(store.pendingSteers(first.threadId!)).toEqual([]);
    expect(store.runs(first.threadId!)).toHaveLength(1);
  } finally { await host.detachAll(); store.close(); }
});

async function pendingSteers(runtime: RecoverableRuntime) {
  const store = new LoomStore(":memory:");
  const open = runtime.open.bind(runtime);
  const failing: Runtime = {
    open: async (options, emit) => {
      const session = await open(options, emit);
      session.inject = async () => { throw new HostOutcomeUnknown("Session host disconnected"); };
      return session;
    },
  };
  const host = new LoomHost(store, { fake: failing });
  const first = await host.execute({ type: "submit", commandId: "s", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
  await host.execute({ type: "submit", commandId: "a", threadId: first.threadId, text: "one", steer: true });
  await host.execute({ type: "submit", commandId: "b", threadId: first.threadId, text: "two", steer: true });
  await host.detachAll();
  return { store, threadId: first.threadId!, steers: store.pendingSteers(first.threadId!) };
}

it("on recovery, marks a pending steer the host already has as delivered and redelivers the rest once (Codex review on #638)", async () => {
  const runtime = new RecoverableRuntime();
  const { store, threadId, steers } = await pendingSteers(runtime);
  expect(steers.map((m) => m.text)).toEqual(["one", "two"]);
  runtime.injectedSteers = [steers[0]!.id]; // "one" reached the host before the coordinator died
  const recovered = new LoomHost(store, { fake: runtime });
  try {
    await recovered.recover();
    expect(store.pendingSteers(threadId)).toEqual([]);
    expect(runtime.injectCalls).toBe(1); // only "two"
    expect(store.runs(threadId).map((r) => r.text)).toEqual(["work"]);
  } finally { await recovered.detachAll(); store.close(); }
});

it("on recovery with the host gone, turns pending steers into queued runs (Codex review on #638)", async () => {
  const runtime = new RecoverableRuntime();
  const { store, threadId } = await pendingSteers(runtime);
  const gone: Runtime = { open: runtime.open.bind(runtime), attach: async () => null };
  const recovered = new LoomHost(store, { fake: gone });
  try {
    await recovered.recover();
    expect(store.pendingSteers(threadId)).toEqual([]);
    const texts = store.runs(threadId).map((r) => r.text);
    expect(texts).toEqual(expect.arrayContaining(["one", "two"]));
    // A retry of the original command reports the queued run, not the stale steer.
    const retried = await recovered.execute({ type: "submit", commandId: "a", threadId, text: "one", steer: true });
    expect(retried.steered).toBe(false);
    expect(store.run(retried.runId!)!.text).toBe("one");
  } finally { await recovered.detachAll(); store.close(); }
});


it("keeps ledger tasks and turns open when their host reattaches", async () => {
  const store = new LoomStore(":memory:"); const runtime = new RecoverableRuntime();
  let host = new LoomHost(store, { fake: runtime });
  try {
    const r = await host.execute({ type: "submit", commandId: "ledger-attach", cwd: "/repo", provider: "fake", session: { loomTools: false }, text: "work" });
    runtime.send({ type: "background.changed", tasks: [{ id: "watch", kind: "monitor", ambient: true, description: "watch build" }] });
    const before = host.ledger.rows(r.threadId!);
    await host.detachAll(); host = new LoomHost(store, { fake: runtime });
    expect(await host.recover()).toEqual({ interrupted: 0, continued: 0 });
    expect(host.ledger.rows(r.threadId!)).toEqual(before);
    expect(before.every(row => row.outcome === null)).toBe(true);
  } finally { await host.detachAll(); store.close(); }
});

it("reports an unknown-outcome action once, not on every restart (manager review)", async () => {
  const { Ledger } = await import("../src/ledger.js");
  const store = new LoomStore(":memory:");
  const thread = store.tx(() => store.createThread({ id: "t-once", cwd: "/nonexistent", kind: "coding", provider: "fake" }));
  const ledger = new Ledger(store);
  ledger.tool(thread, { type: "tool.updated", runId: "r", itemId: "call-1", name: "Bash", input: JSON.stringify({ command: "gh pr comment 5 --body hi" }), status: "running" });
  expect(await ledger.recover(thread)).toContain("outcome unknown");
  expect(await ledger.recover(thread)).toBe("");
  store.close();
});

it("an unexpected session end marks background work lost and tells the idle thread (Codex review on #685)", async () => {
  const { FakeRuntime } = await import("./fake-runtime.js");
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  try {
    const r = await host.execute({ type: "submit", commandId: "s", text: "work", cwd: "/repo", provider: "fake", session: { loomTools: false } });
    runtime.last.emit({ type: "session.native", nativeSessionId: "native" });
    runtime.last.emit({ type: "background.changed", tasks: [{ id: "bg1", kind: "local_bash", description: "Watch the build" }] });
    runtime.last.complete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.last.emit({ type: "session.ended", failure: { kind: "crashed", message: "host died" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.ledger.rows(r.threadId!).find((row) => row.ref === "bg1")?.outcome).toBe("lost");
    const note = store.runs(r.threadId!).find((run) => run.source === "continue");
    expect(note?.text).toContain("Lost local_bash: Watch the build (bg1)");
  } finally { await host.detachAll(); store.close(); }
});
