import { describe, expect, it, vi } from "vitest";
import { LoomCommandError, LoomHost, MAX_CONTINUE_CHAIN, OVERLOAD_RETRY_NOTE, RESTART_NOTE } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

function setup() {
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  return { store, runtime, host };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("LoomHost", () => {
  it("creates a thread on first submit and starts the turn", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "hello", cwd: "/repo", provider: "fake" });
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.last.turns).toEqual([{ runId: r.runId, text: "hello" }]);
    expect(store.thread(r.threadId!)!.status).toBe("running");
    expect(store.messages(r.threadId!).map((m) => m.text)).toEqual(["hello"]);
  });

  it("returns the original result for a repeated commandId and never starts a second turn", async () => {
    const { host, runtime } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "hello", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "c1", text: "hello", cwd: "/repo", provider: "fake" });
    expect(b).toEqual(a);
    expect(runtime.last.turns).toHaveLength(1);
  });

  it("replays a rejection for a repeated commandId", async () => {
    const { host } = setup();
    const bad = { type: "submit" as const, commandId: "c1", text: "x", threadId: "missing" };
    await expect(host.execute(bad)).rejects.toThrow(LoomCommandError);
    await expect(host.execute(bad)).rejects.toMatchObject({ code: "not_found" });
  });

  it("queues replies sent while busy and runs them in order on the same session", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    await host.execute({ type: "submit", commandId: "c3", threadId: a.threadId, text: "three" });
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["one"]);
    runtime.last.complete();
    await flush();
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["one", "two"]);
    runtime.last.complete();
    await flush();
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["one", "two", "three"]);
    runtime.last.complete();
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(store.thread(a.threadId!)!.status).toBe("idle");
    expect(store.runs(a.threadId!).map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("does not persist streaming deltas but publishes them live", async () => {
    const { host, runtime, store } = setup();
    const events: unknown[] = [];
    host.subscribe((e) => events.push(e));
    const a = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "message.delta", runId: a.runId!, text: "Hel" });
    runtime.last.emit({ type: "message.delta", runId: a.runId!, text: "Hello" });
    runtime.last.complete("Hello there");
    expect(events.filter((e) => (e as { type?: string }).type === "delta")).toHaveLength(2);
    expect(store.messages(a.threadId!).map((m) => m.text)).toEqual(["hi", "Hello there"]);
  });

  it("routes a question to the Desk and the answer back to the session", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "request.opened", runId: a.runId!, requestId: "q1", kind: "question", payload: { question: "Which?" } });
    expect(store.thread(a.threadId!)!.status).toBe("waiting");
    await host.execute({ type: "answer", commandId: "c2", requestId: "q1", answer: { choice: "A" } });
    expect(runtime.last.answers).toEqual([{ requestId: "q1", answer: { choice: "A" } }]);
    expect(store.thread(a.threadId!)!.status).toBe("running");
    await expect(host.execute({ type: "answer", commandId: "c3", requestId: "q1", answer: {} })).rejects.toMatchObject({ code: "not_open" });
  });

  it("keeps a question open when the answer can't be delivered", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "request.opened", runId: a.runId!, requestId: "q1", kind: "question", payload: {} });
    runtime.last.failRespond = true;
    await expect(host.execute({ type: "answer", commandId: "c2", requestId: "q1", answer: "A" })).rejects.toMatchObject({ code: "not_delivered" });
    expect(store.request("q1")!.status).toBe("open");
    runtime.last.failRespond = false;
    await host.execute({ type: "answer", commandId: "c3", requestId: "q1", answer: "A" });
    expect(store.request("q1")!.status).toBe("answered");
    expect(runtime.last.answers).toEqual([{ requestId: "q1", answer: "A" }]);
  });

  it("holds the queue when a session ends on a usage limit", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    runtime.last.emit({ type: "session.ended", failure: { kind: "usage_limit", message: "limit" } });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(store.runs(a.threadId!).map((r) => r.status)).toEqual(["failed", "queued"]);
  });

  it("interrupts the active turn and moves on to queued work", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "long job", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "next" });
    await host.execute({ type: "interrupt", commandId: "c3", threadId: a.threadId! });
    await flush();
    expect(store.run(a.runId!)!.status).toBe("interrupted");
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["long job", "next"]);
  });

  it("holds the queue after a usage limit instead of failing the next run the same way", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    runtime.last.emit({ type: "turn.failed", runId: a.runId!, failure: { kind: "usage_limit", message: "limit" } });
    await flush();
    expect(runtime.last.turns).toHaveLength(1);
    expect(store.runs(a.threadId!).map((r) => r.status)).toEqual(["failed", "queued"]);
  });

  it("retries a turn the model turned away as overloaded, on the same session, after a visible pause", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const store = new LoomStore(":memory:");
      const runtime = new FakeRuntime(store);
      const host = new LoomHost(store, { fake: runtime }, { overloadRetryMs: [30] });
      const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
      const overloaded = { kind: "overloaded" as const, message: "Selected model is at capacity. Please try a different model." };
      runtime.last.emit({ type: "turn.failed", runId: a.runId!, failure: overloaded });
      await host.kick(a.threadId!);
      expect(store.run(a.runId!)!.status).toBe("queued");
      expect(store.thread(a.threadId!)).toMatchObject({ status: "idle", admission: "provider_busy" });
      expect(store.thread(a.threadId!)!.admission_until).toBe(Date.now() + 30);
      // Another kick during the pause (here, the owner's next message) doesn't start it early.
      await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
      await host.kick(a.threadId!);
      expect(runtime.last.turns).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(29);
      expect(runtime.last.turns).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.sessions).toHaveLength(1);
      expect(runtime.last.turns[1]).toEqual({ runId: a.runId, text: `${OVERLOAD_RETRY_NOTE}\n\none` });
      expect(store.thread(a.threadId!)).toMatchObject({ status: "running", admission: null });
      runtime.last.complete();
      await host.kick(a.threadId!);
      expect(store.run(a.runId!)!.status).toBe("completed");
      expect(runtime.last.turns.map((t) => t.text).at(-1)).toBe("two");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an overloaded turn once its retries are spent, and the queue moves on", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime }, { overloadRetryMs: [0] });
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    const overloaded = { kind: "overloaded" as const, message: "at capacity" };
    runtime.last.emit({ type: "turn.failed", runId: a.runId!, failure: overloaded });
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.last.turns.map((t) => t.runId)).toEqual([a.runId, a.runId]);
    runtime.last.emit({ type: "turn.failed", runId: a.runId!, failure: overloaded });
    await flush();
    expect(store.run(a.runId!)!.status).toBe("failed");
    expect(runtime.last.turns.map((t) => t.text).at(-1)).toBe("two");
  });

  it("drops the overload hold when the retried run is stopped while it waits", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime }, { overloadRetryMs: [60_000] });
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "turn.failed", runId: a.runId!, failure: { kind: "overloaded", message: "at capacity" } });
    await flush();
    store.updateRun(a.runId!, { status: "canceled", ended_at: Date.now() });
    await host.kick(a.threadId!);
    expect(store.thread(a.threadId!)).toMatchObject({ admission: null, admission_until: null });
    await host.closeAll();
  });

  it("stop cancels queued work, expires questions and closes the session", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    runtime.last.emit({ type: "request.opened", runId: a.runId!, requestId: "q1", kind: "question", payload: {} });
    await host.execute({ type: "stop", commandId: "c3", threadId: a.threadId! });
    expect(runtime.last.closed).toBe(true);
    expect(store.thread(a.threadId!)!.status).toBe("stopped");
    expect(store.runs(a.threadId!).map((r) => r.status)).toEqual(["canceled", "canceled"]);
    expect(store.request("q1")!.status).toBe("expired");
    await expect(host.execute({ type: "submit", commandId: "c4", threadId: a.threadId, text: "x" })).rejects.toMatchObject({ code: "stopped" });
  });

  it("records the native session id and resumes it when the session reopens", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-1" });
    runtime.last.complete();
    runtime.last.emit({ type: "session.ended" });
    await flush();
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options.nativeSessionId).toBe("native-1");
    expect(store.attempts(store.runs(a.threadId!)[0]!.id)[0]!.native_session_id).toBe("native-1");
  });

  it("ignores late events from a session that was already replaced", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    runtime.last.complete();
    await flush();
    const old = runtime.last;
    await host.closeAll();
    const b = await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    expect(runtime.sessions).toHaveLength(2);
    // The closed session reports its end only now, after the new one is running.
    old.emit({ type: "session.ended" });
    await flush();
    expect(host.hasSession(a.threadId!)).toBe(true);
    expect(store.run(b.runId!)!.status).toBe("running");
  });

  it("records a wake turn the harness started on its own", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "start a monitor", cwd: "/repo", provider: "fake" });
    runtime.last.complete();
    await flush();
    let woke = "";
    runtime.last.emit({ type: "wake.started", text: "Background task finished", bind: (id) => (woke = id) });
    expect(store.run(woke)!.source).toBe("wake");
    expect(store.thread(a.threadId!)!.status).toBe("running");
    runtime.last.emit({ type: "message.completed", runId: woke, text: "The monitor fired" });
    runtime.last.emit({ type: "turn.completed", runId: woke });
    expect(store.run(woke)!.status).toBe("completed");
  });

  it("fails a run cleanly when the session cannot open, then keeps going", async () => {
    const { host, runtime, store } = setup();
    runtime.failOpen = new Error("binary missing");
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    expect(store.run(a.runId!)!.status).toBe("failed");
    expect(JSON.parse(store.run(a.runId!)!.failure!).message).toBe("binary missing");
    runtime.failOpen = null;
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["two"]);
  });

  describe("recovery", () => {
    it("interrupts cut-off turns, expires questions and sends one continue", async () => {
      const { store } = setup();
      const host1 = new LoomHost(store, { fake: new FakeRuntime(store) });
      const a = await host1.execute({ type: "submit", commandId: "c1", text: "work", cwd: "/repo", provider: "fake" });
      store.tx(() => store.updateThread(a.threadId!, { native_session_id: "native-1" }));
      store.tx(() => store.openRequest(a.threadId!, a.runId!, "question", {}, "q1"));

      // Loom restarts: a new host over the same store.
      const runtime2 = new FakeRuntime(store);
      const host2 = new LoomHost(store, { fake: runtime2 });
      const result = await host2.recover();
      expect(result).toEqual({ interrupted: 1, continued: 1 });
      expect(store.run(a.runId!)!.status).toBe("interrupted");
      expect(store.request("q1")!.status).toBe("expired");
      expect(runtime2.last.options.nativeSessionId).toBe("native-1");
      expect(runtime2.last.turns.map((t) => t.text)).toEqual([RESTART_NOTE]);
    });

    it("stops continuing automatically after a chain of restarts", async () => {
      const { store } = setup();
      const host = new LoomHost(store, { fake: new FakeRuntime(store) });
      await host.execute({ type: "submit", commandId: "c1", text: "work", cwd: "/repo", provider: "fake" });
      const threadId = store.threads()[0]!.id;
      store.tx(() => store.updateThread(threadId, { native_session_id: "native-1" }));
      let continued = 0;
      for (let i = 0; i < MAX_CONTINUE_CHAIN + 2; i++) {
        const next = new LoomHost(store, { fake: new FakeRuntime(store) });
        continued += (await next.recover()).continued;
      }
      expect(continued).toBe(MAX_CONTINUE_CHAIN);
      expect(store.activeRun(threadId)).toBeUndefined();
    });
  });

  it("steers mail into the running turn, and queues a run when the thread is idle", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "build it", cwd: "/repo", provider: "fake" });
    const origin = { kind: "peer" as const, name: "Integration lead", from: "loom:x", mailId: "m-1" };
    const steered = await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "✉️ Mail: port?", origin, steer: true });
    expect(steered).toMatchObject({ steered: true, runId: a.runId });
    expect(runtime.last.injected).toEqual(["✉️ Mail: port?"]);
    expect(runtime.last.turns).toHaveLength(1);
    const filed = store.messages(a.threadId!).at(-1)!;
    expect(filed.run_id).toBe(a.runId);
    expect(JSON.parse(filed.origin!)).toEqual({ ...origin, inline: true });
    runtime.last.complete();
    await flush();
    // Idle: a turn of its own, the mail as its opening words.
    const idle = await host.execute({ type: "submit", commandId: "c3", threadId: a.threadId, text: "✉️ Mail: again?", origin, steer: true });
    expect(idle.steered).toBe(false);
    expect(runtime.last.turns.at(-1)!.text).toBe("✉️ Mail: again?");
    // The owner's own words carry no origin.
    expect(store.messages(a.threadId!)[0]!.origin ?? null).toBeNull();
  });

  it("files messages from other sessions once, with their origin", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake" });
    const peer = { type: "peer.message" as const, direction: "in" as const, text: "Schema migration finished", name: "api-worker", address: "uds:/tmp/x.sock", messageId: "n-1", inline: true };
    runtime.last.emit(peer);
    runtime.last.emit(peer);
    runtime.last.emit({ type: "peer.message", direction: "out", text: "thanks", name: "api-worker", address: "api-worker", messageId: "toolu_1", inline: true });
    const filed = store.messages(a.threadId!).filter((m) => m.origin);
    expect(filed.map((m) => [m.text, JSON.parse(m.origin!).kind])).toEqual([["Schema migration finished", "peer"], ["thanks", "peer-out"]]);
    expect(filed[0]!.run_id).toBe(a.runId);
  });

  it("names native peers as the owner knows them: a Loom thread's title, and replies by the address's last name", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake", title: "Tile server" });
    const prefix = a.threadId!.slice(0, 8);
    runtime.last.emit({ type: "peer.message", direction: "in", text: "port?", name: `loom-${prefix}-2e`, address: "uds:/tmp/cc-socks/1.sock", messageId: "n-1", inline: true });
    runtime.last.emit({ type: "peer.message", direction: "out", text: "8080", name: "uds:/tmp/cc-socks/1.sock", address: "uds:/tmp/cc-socks/1.sock", messageId: "t-1", inline: true });
    const names = store.messages(a.threadId!).filter((m) => m.origin).map((m) => JSON.parse(m.origin!).name);
    expect(names).toEqual(["Tile server", "Tile server"]);
  });
});

describe("interrupt bound to a run", () => {
  it("stops the run the client saw, and refuses once a different run is in progress", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime });
    const a = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/repo", provider: "fake" });
    const b = await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId, text: "two" });
    runtime.last.complete();
    await new Promise((r) => setTimeout(r, 0));
    // The client still shows run one; run two is the one going now.
    await expect(host.execute({ type: "interrupt", commandId: "c3", threadId: a.threadId!, runId: a.runId! })).rejects.toMatchObject({ code: "changed" });
    expect(runtime.last.interrupted).toBe(0);
    await host.execute({ type: "interrupt", commandId: "c4", threadId: a.threadId!, runId: b.runId! });
    expect(runtime.last.interrupted).toBe(1);
  });

  it("takes the first of two concurrent answers to one question and refuses the second (Codex review on #638)", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.emit({ type: "request.opened", runId: a.runId!, requestId: "q1", kind: "question", payload: {} });
    // A remote host acknowledges after a round trip.
    const session = runtime.last;
    const delivered: unknown[] = [];
    session.respond = ((requestId: string, answer: unknown) =>
      new Promise<void>((resolve) => setTimeout(() => { delivered.push(answer); resolve(); }, 20))) as typeof session.respond;
    const first = host.execute({ type: "answer", commandId: "a1", requestId: "q1", answer: "yes" });
    const second = host.execute({ type: "answer", commandId: "a2", requestId: "q1", answer: "no" });
    await expect(first).resolves.toBeTruthy();
    await expect(second).rejects.toMatchObject({ code: "not_open" });
    expect(delivered).toEqual(["yes"]);
    expect(JSON.parse(store.request("q1")!.answer!)).toBe("yes");
  });

  it("lets a failed interrupt be retried with the same commandId (Codex review on #638)", async () => {
    const { host, runtime } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    const session = runtime.last;
    let calls = 0;
    session.interrupt = async () => {
      calls++;
      if (calls === 1) throw new Error("Session host command timed out: interrupt");
      session.emit({ type: "turn.failed", runId: a.runId!, failure: { kind: "interrupted", message: "stopped" } });
    };
    await expect(host.execute({ type: "interrupt", commandId: "i1", threadId: a.threadId! })).rejects.toThrow("timed out");
    await host.execute({ type: "interrupt", commandId: "i1", threadId: a.threadId! });
    expect(calls).toBe(2);
  });
});

it('echoes submit command identity on the durable message without marking it as an injected steer', async () => {
  const { host, store } = setup();
  const result = await host.execute({ type: 'submit', commandId: 'receipt-submit', text: 'Receipt test', cwd: '/repo', provider: 'fake' });
  expect(store.messages(result.threadId!)[0]).toMatchObject({ command_id: 'receipt-submit', delivery: null });
  await host.execute({ type: 'submit', commandId: 'receipt-submit', text: 'Receipt test', cwd: '/repo', provider: 'fake' });
  expect(store.messages(result.threadId!)).toHaveLength(1);
});
