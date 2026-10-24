import { Readable } from "node:stream";
import { createLoomServer } from "../src/http.js";
import { afterEach, describe, expect, it } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";
import type { Pressure } from "../src/warmth.js";

const GB = 1024 ** 3;
const healthy = (): Pressure => ({ memory: { totalBytes: 64 * GB, freePct: 80 }, disk: { totalBytes: 1000 * GB, freeBytes: 100 * GB } });
const hosts: LoomHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) { await host.closeAll(); host.store.close(); } });
function setup(maxWarmHosts = 2, extra: { warmthStepMs?: number; pressureReadMs?: number; workerWarmFloorMs?: number } = {}) {
  const store = new LoomStore(":memory:");
  let now = Date.now();
  store.now = () => now;
  const runtime = new FakeRuntime(store);
  let pressure: Pressure | (() => Pressure) = healthy();
  const host = new LoomHost(store, { fake: runtime }, { pressure: async () => typeof pressure === "function" ? pressure() : pressure, warmthLimits: { maxWarmHosts, warmFloorMs: 600_000 }, ...extra });
  hosts.push(host);
  return { store, runtime, host, advance: (ms = 700_000) => { now += ms; }, pressure: (p: Pressure | (() => Pressure)) => { pressure = p; } };
}
let command = 0;
async function submit(host: LoomHost, threadId?: string) {
  return host.execute({ type: "submit", commandId: `c${++command}`, text: "hello", ...(threadId ? { threadId } : { provider: "fake", cwd: "/repo" }) });
}
async function idle(ctx: ReturnType<typeof setup>) {
  const result = await submit(ctx.host);
  const session = ctx.runtime.last;
  session.complete();
  await ctx.host.kick(result.threadId!);
  return { id: result.threadId!, session };
}
function wake(ctx: ReturnType<typeof setup>) {
  return ctx.store.tx(() => {
    const t = ctx.store.createThread({ kind: "coding", cwd: "/repo", provider: "fake" });
    const r = ctx.store.createRun(t.id, "wake", "wake up");
    return { t, r };
  });
}

describe("warmth and admission", () => {
  it("keeps a host with a managed build even after its turn completes", async () => {
    const c = setup(1);
    const result = await submit(c.host);
    c.host.leases.register({ threadId: result.threadId!, runId: c.runtime.last.currentRun, kind: "build", key: "managed-build", identity: { unknown: true }, policy: "manual" });
    const session = c.runtime.last;
    session.complete(); await c.host.kick(result.threadId!); c.advance();
    const pending = wake(c); await c.host.kick(pending.t.id);
    expect(session.closed).toBe(false);
    expect(c.store.run(pending.r.id)?.status).toBe("queued");
  });

  it("cools the least recently active eligible host first", async () => {
    const c = setup(2);
    const a = await idle(c); c.advance();
    const b = await idle(c); c.advance();
    const pending = wake(c);
    await c.host.kick(pending.t.id);
    expect(a.session.closed).toBe(true);
    expect(b.session.closed).toBe(false);
    expect(c.store.thread(a.id)?.cooled_at).toBe(c.store.now());
    expect(c.store.run(pending.r.id)?.status).toBe("running");
  });

  it("cools a worker soon after its turn, without the ten-minute floor; other roles keep it", async () => {
    const c = setup(4, { workerWarmFloorMs: 60_000 });
    const worker = await idle(c);
    const thread = await idle(c);
    c.store.updateThread(worker.id, { role: "worker" });
    await c.host.checkWarmth();
    expect(worker.session.closed).toBe(false);
    c.advance(90_000);
    await c.host.checkWarmth();
    expect(worker.session.closed).toBe(true);
    expect(c.store.thread(worker.id)?.cooled_at).toBe(c.store.now());
    expect(thread.session.closed).toBe(false);
  });

  it("a worker whose close never finishes is skipped by later sweeps, so the next worker still cools (Codex review on #841)", async () => {
    const c = setup(4, { workerWarmFloorMs: 60_000, warmthStepMs: 20 });
    const wedged = await idle(c);
    const next = await idle(c);
    for (const w of [wedged, next]) c.store.updateThread(w.id, { role: "worker" });
    let closes = 0;
    wedged.session.closeForUpgrade = () => { closes++; return new Promise(() => {}); };
    c.advance(90_000);
    // The minute timer fires sweeps without awaiting them; the first one hangs on the wedged close.
    void c.host.checkWarmth();
    await new Promise((r) => setTimeout(r, 50));
    void c.host.checkWarmth();
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toBe(1);
    expect(next.session.closed).toBe(true);
    // Given up on, the wedged host is dropped: the worker's next turn opens a new one instead of waiting forever.
    expect(wedged.session.closed).toBe(true);
    const opened = c.runtime.sessions.length;
    const turn = await submit(c.host, wedged.id);
    for (let i = 0; i < 20 && c.runtime.sessions.length === opened; i++) await new Promise((r) => setTimeout(r, 5));
    expect(c.runtime.sessions.length).toBe(opened + 1);
    expect(c.runtime.last.turns.at(-1)?.text).toBe("hello");
    expect(c.store.run(turn.runId!)?.status).toBe("running");
  });

  it("a worker whose close fails doesn't stop the sweep: the next worker still cools (Codex review on #841)", async () => {
    const c = setup(4, { workerWarmFloorMs: 60_000 });
    const broken = await idle(c);
    const next = await idle(c);
    for (const w of [broken, next]) c.store.updateThread(w.id, { role: "worker" });
    c.store.updateThread(broken.id, { background: JSON.stringify([{ id: "watch", kind: "monitor", description: "PR review", ambient: true }]) });
    broken.session.closeForUpgrade = async () => { throw new Error("host disconnected"); };
    c.advance(90_000);
    await c.host.checkWarmth();
    expect(next.session.closed).toBe(true);
    expect(c.store.thread(broken.id)?.cooled_at ?? null).toBeNull();
    // Its host can't take a turn any more: dropped, so the next turn opens a new one.
    expect(broken.session.closed).toBe(true);
    const opened = c.runtime.sessions.length;
    await submit(c.host, broken.id);
    for (let i = 0; i < 20 && c.runtime.sessions.length === opened; i++) await new Promise((r) => setTimeout(r, 5));
    expect(c.runtime.sessions.length).toBe(opened + 1);
    // Its watcher stopped with it, and the next turn is told (Codex review on #841).
    expect(c.runtime.last.turns.at(-1)?.text).toContain("PR review");
  });

  it("never cools a worker with work still running in its session", async () => {
    const c = setup(4, { workerWarmFloorMs: 60_000 });
    const worker = await idle(c);
    c.store.updateThread(worker.id, { role: "worker", background: JSON.stringify([{ id: "b1", kind: "local_bash", description: "npm test" }]) });
    c.advance(90_000);
    await c.host.checkWarmth();
    expect(worker.session.closed).toBe(false);
  });

  it.each(["running", "question", "background", "queued", "recent", "settling", "move", "host move"])("never cools a thread with %s activity", async kind => {
    const c = setup(1);
    const a = await idle(c);
    c.advance();
    c.store.tx(() => {
      if (kind === "running") { const r = c.store.createRun(a.id, "wake", "work"); c.store.updateRun(r.id, { status: "running" }); }
      if (kind === "question") c.store.openRequest(a.id, c.store.runs(a.id)[0]!.id, "question", {}, "q");
      if (kind === "background") c.store.updateThread(a.id, { background: JSON.stringify([{ id: "job", kind: "shell", description: "work" }]) });
      if (kind === "queued") c.store.createRun(a.id, "wake", "queued");
      if (kind === "recent") { const r = c.store.createRun(a.id, "wake", "recent"); c.store.updateRun(r.id, { status: "completed", ended_at: c.store.now() }); }
      if (kind === "move") c.store.setAccountMove(a.id, "other");
      if (kind === "host move") c.store.beginHostMove(a.id, null, null);
    });
    if (kind === "settling") {
      a.session.emit({ type: "background.changed", tasks: [{ id: "job", kind: "shell", description: "work" }] });
      a.session.emit({ type: "background.changed", tasks: [] });
    }
    // Keep the old timestamp for checks intended to isolate a blocker other than the floor.
    if (!["recent"].includes(kind)) c.store.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(c.store.now() - 700_000, a.id);
    const pending = wake(c);
    await c.host.kick(pending.t.id);
    expect(a.session.closed).toBe(false);
    expect(c.store.run(pending.r.id)?.status).toBe("queued");
    expect(c.host.detail(pending.t.id)?.thread.admission).toBe("host_cap");
  });

  it("resumes the same native session with a watcher note only on the next turn", async () => {
    const c = setup(1);
    const a = await idle(c);
    a.session.emit({ type: "session.native", nativeSessionId: "native-one" });
    a.session.emit({ type: "background.changed", tasks: [{ id: "watch", kind: "monitor", description: "PR review", ambient: true }] });
    c.advance();
    c.pressure({ ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } });
    await c.host.checkWarmth();
    expect(c.host.hasSession(a.id)).toBe(false);
    expect(c.store.nextQueuedRun(a.id)).toBeUndefined();
    c.pressure(healthy());
    await c.host.warm(a.id);
    expect(c.runtime.last.options.nativeSessionId).toBe("native-one");
    expect(c.runtime.last.turns).toHaveLength(0);
    expect(c.store.thread(a.id)?.cooled_at).toBeNull();
    await submit(c.host, a.id);
    expect(c.runtime.last.turns[0]?.text).toMatch(/^Loom paused this idle session to free memory\./);
    expect(c.runtime.last.turns[0]?.text).toContain("PR review (watch)");
    expect(c.store.thread(a.id)?.cooling_note).toBeNull();
  });

  it("retries queued work when room appears", async () => {
    const c = setup(1);
    const a = await submit(c.host);
    const pending = wake(c);
    await c.host.kick(pending.t.id);
    expect(c.store.run(pending.r.id)?.status).toBe("queued");
    c.runtime.last.complete();
    await c.host.kick(a.threadId!);
    c.advance();
    await c.host.checkWarmth();
    expect(c.store.run(pending.r.id)?.status).toBe("running");
    expect(c.store.thread(pending.t.id)?.admission).toBeNull();
  });

  it("admits owner messages over host and memory limits but refuses disk below 5 GB", async () => {
    const c = setup(0);
    c.pressure({ ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } });
    const a = await submit(c.host);
    expect(c.store.activeRun(a.threadId!)).toBeDefined();
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 4 * GB } });
    const b = await submit(c.host);
    expect(c.store.nextQueuedRun(b.threadId!)).toBeDefined();
    expect(c.host.hasSession(b.threadId!)).toBe(false);
    expect(c.host.snapshot().threads.find(t => t.id === b.threadId)).toMatchObject({ admission: "disk_low", admission_until: null });
  });

  it("an owner message skips the disk floor behind a wake and after waiting past two minutes (10/19)", async () => {
    const c = setup(4);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 4 * GB } });
    const pending = wake(c);
    await c.host.kick(pending.t.id);
    expect(c.store.thread(pending.t.id)?.admission).toBe("disk_low");
    const owner = await submit(c.host, pending.t.id);
    expect(c.host.hasSession(pending.t.id)).toBe(false);
    c.advance(10 * 60_000);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 10 * GB } });
    await c.host.checkWarmth();
    expect(c.host.hasSession(pending.t.id)).toBe(true);
    expect(c.store.thread(pending.t.id)?.admission).toBeNull();
    // The owner's message moved ahead of the wake: the exemption starts the owner's turn, not the automatic one.
    expect(c.store.run(owner.runId!)?.status).toBe("running");
    expect(c.store.run(pending.r.id)?.status).toBe("queued");
  });

  it("a session that fails to open after the owner's message moved up fails that message, not the wake (Codex review on #807)", async () => {
    const c = setup(4);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 4 * GB } });
    const pending = wake(c);
    await c.host.kick(pending.t.id);
    const owner = await submit(c.host, pending.t.id);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 10 * GB } });
    const open = c.runtime.open.bind(c.runtime);
    let failed = false;
    c.runtime.open = async (options, emit) => { if (!failed) { failed = true; throw new Error("spawn failed"); } return open(options, emit); };
    await c.host.checkWarmth();
    expect(c.store.run(owner.runId!)?.status).toBe("failed");
    expect(c.store.run(pending.r.id)?.status).not.toBe("failed");
  });

  it("a continue ahead of the owner's message keeps the strict limits and its place (Codex review on #807)", async () => {
    const c = setup(4);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 10 * GB } });
    const pending = wake(c);
    c.store.tx(() => c.store.createAttempt(c.store.run(pending.r.id)!, null, null));
    await c.host.kick(pending.t.id);
    await submit(c.host, pending.t.id);
    expect(c.host.hasSession(pending.t.id)).toBe(false);
    expect(c.store.thread(pending.t.id)?.admission).toBe("disk_low");
    expect(c.store.nextQueuedRun(pending.t.id)?.id).toBe(pending.r.id);
  });

  it("a scheduled job's opening turn doesn't get the owner's exemption; the owner's later message there does (Codex review on #831)", async () => {
    const c = setup(4);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 10 * GB } });
    const job = await c.host.execute({ type: "submit", commandId: "job-1", text: "daily briefing", provider: "fake", cwd: "/repo", kind: "tango-job" } as never);
    expect(c.store.thread(job.threadId!)?.kind).toBe("tango-job");
    expect(c.host.hasSession(job.threadId!)).toBe(false);
    expect(c.store.thread(job.threadId!)?.admission).toBe("disk_low");
    // The owner's later message on that job thread (an answer, a reply) still gets it, and goes first.
    const reply = await submit(c.host, job.threadId!);
    expect(c.host.hasSession(job.threadId!)).toBe(true);
    expect(c.store.run(reply.runId!)?.status).toBe("running");
  });

  it("names the disk floor as the reason other work waits", async () => {
    const c = setup(4);
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 10 * GB } });
    const pending = wake(c);
    await c.host.kick(pending.t.id);
    expect(c.store.run(pending.r.id)?.status).toBe("queued");
    expect(c.host.detail(pending.t.id)?.thread.admission).toBe("disk_low");
    c.pressure(healthy());
    await c.host.checkWarmth();
    expect(c.store.run(pending.r.id)?.status).toBe("running");
    expect(c.store.thread(pending.t.id)?.admission).toBeNull();
  });

  it("mail from another agent does not get the owner's exemption (Codex review on #691)", async () => {
    const c = setup(0);
    c.pressure({ ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } });
    const mail = await c.host.execute({ type: "submit", commandId: "peer-1", text: "from another agent", provider: "fake", cwd: "/repo",
      origin: { kind: "peer", name: "Other thread", address: "loom:other", messageId: "m-1" } } as never);
    expect(c.host.hasSession(mail.threadId!)).toBe(false);
    expect(c.store.thread(mail.threadId!)?.admission).toBe("memory");
  });

  it("prewarms without a turn, is idempotent, and records timings and machine fields", async () => {
    const c = setup();
    const t = c.store.tx(() => c.store.createThread({ kind: "coding", cwd: "/repo", provider: "fake" }));
    await c.host.warm(t.id);
    await c.host.warm(t.id);
    expect(c.runtime.sessions).toHaveLength(1);
    expect(c.runtime.last.turns).toHaveLength(0);
    const machine = await c.host.machine();
    expect(machine).toMatchObject({ at: c.store.now(), memory: { totalBytes: 64 * GB, agents: [] }, disk: { totalBytes: 1000 * GB, freeBytes: 100 * GB }, worktrees: { count: 0 }, warm: 1 });
    expect(machine.hostOpens).toEqual([expect.objectContaining({ threadId: t.id, reason: "warm", ms: expect.any(Number) })]);
    expect(machine.medianOpenMs).toBeGreaterThanOrEqual(0);
    expect(c.host.detail(t.id)?.thread.warmth).toBe("warm");
  });
  it("serves authenticated warm and machine routes without a network listener", async () => {
    const c = setup();
    const t = c.store.tx(() => c.store.createThread({ kind: "coding", cwd: "/repo", provider: "fake" }));
    const server = createLoomServer(c.host, { token: "test" });
    const call = (method: string, url: string, token = "test") => new Promise<{ status: number; body: any }>(done => {
      const req = Object.assign(Readable.from([]), { method, url, headers: { host: "localhost", authorization: `Bearer ${token}` } });
      let status = 0;
      server.emit("request", req, { writeHead(code: number) { status = code; }, end(data: string) { done({ status, body: JSON.parse(data) }); } });
    });
    expect((await call("GET", "/machine", "bad")).status).toBe(401);
    expect((await call("POST", "/threads/missing/warm")).status).toBe(404);
    expect((await call("POST", `/threads/${t.id}/warm`)).body.warmth).toBe("warm");
    expect((await call("POST", `/threads/${t.id}/warm`)).status).toBe(200);
    expect(c.runtime.sessions).toHaveLength(1);
    expect(c.runtime.last.turns).toHaveLength(0);
    expect((await call("GET", "/machine")).body).toMatchObject({ at: expect.any(Number), memory: { totalBytes: expect.any(Number), agents: [] }, disk: { totalBytes: expect.any(Number), freeBytes: expect.any(Number) }, worktrees: { count: 0 } });
  });

  it("re-measures pressure after each eviction and stops when pressure clears", async () => {
    const c = setup(3);
    const a = await idle(c); c.advance();
    const b = await idle(c); c.advance();
    // A pressure source that observes the close instead of a fixed snapshot.
    let reads = 0;
    c.pressure(() => { reads++; return a.session.closed ? healthy() : { ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } }; });
    await c.host.checkWarmth();
    expect(reads).toBe(2);
    expect(a.session.closed).toBe(true);
    expect(b.session.closed).toBe(false);
  });

  it("queues prewarm and retries without starting a turn", async () => {
    const c = setup(1);
    const a = await idle(c);
    const t = c.store.tx(() => c.store.createThread({ kind: "coding", cwd: "/repo", provider: "fake" }));
    expect((await c.host.warm(t.id)).admission).toBe("host_cap");
    c.advance();
    await c.host.checkWarmth();
    expect(a.session.closed).toBe(true);
    expect(c.host.hasSession(t.id)).toBe(true);
    expect(c.runtime.last.turns).toHaveLength(0);
  });

  it("serializes concurrent opens at the host limit", async () => {
    const c = setup(1);
    const a = wake(c), b = wake(c);
    await Promise.all([c.host.kick(a.t.id), c.host.kick(b.t.id)]);
    expect(c.runtime.sessions).toHaveLength(1);
    expect(c.store.run(a.r.id)?.status).toBe("running");
    expect(c.store.run(b.r.id)?.status).toBe("queued");
  });

  it("a cooled thread reopens on its next message with a resume timing", async () => {
    const c = setup(1);
    const a = await idle(c);
    a.session.emit({ type: "session.native", nativeSessionId: "same-native" });
    c.advance();
    c.pressure({ ...healthy(), memory: { totalBytes: 64 * GB, freePct: 5 } });
    await c.host.checkWarmth();
    c.pressure(healthy());
    await submit(c.host, a.id);
    expect(c.runtime.last.options.nativeSessionId).toBe("same-native");
    expect(c.runtime.last.turns[0]?.text).toBe("hello");
    const opens = c.store.db.prepare("SELECT reason FROM host_opens ORDER BY id").all();
    expect(opens).toEqual([{ reason: "new" }, { reason: "resume" }]);
  });

  it("does not dispatch into a host while cooling is awaiting its close", async () => {
    const c = setup(1);
    const a = await idle(c);
    c.advance();
    let finish!: () => void;
    const closing = new Promise<void>(resolve => { finish = resolve; });
    a.session.close = async () => { a.session.closed = true; await closing; };
    c.pressure({ ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } });
    const sweep = c.host.checkWarmth();
    while (!a.session.closed) await Promise.resolve();
    const message = submit(c.host, a.id);
    await Promise.resolve();
    expect(a.session.turns).toHaveLength(1);
    c.pressure(healthy());
    finish();
    await Promise.all([sweep, message]);
    expect(c.runtime.sessions).toHaveLength(2);
    expect(c.runtime.last.turns).toHaveLength(1);
  });

  it("preserves a watcher note across prewarming and another cooling cycle", async () => {
    const c = setup(1);
    const a = await idle(c);
    a.session.emit({ type: "background.changed", tasks: [{ id: "watch", kind: "monitor", description: "review", ambient: true }] });
    c.advance();
    const pressure = { ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } };
    c.pressure(pressure);
    await c.host.checkWarmth();
    c.pressure(healthy());
    await c.host.warm(a.id);
    c.advance();
    c.pressure(pressure);
    await c.host.checkWarmth();
    c.pressure(healthy());
    await submit(c.host, a.id);
    expect(c.runtime.last.turns[0]?.text).toContain("review (watch)");
  });


  it("low disk never cools a thread (it frees no disk), but holds back non-owner new work (manager review)", async () => {
    const c = setup(4);
    const a = await idle(c);
    c.advance();
    c.pressure({ ...healthy(), disk: { totalBytes: 1000 * GB, freeBytes: 10 * GB } });
    await c.host.checkWarmth();
    expect(c.host.hasSession(a.id)).toBe(true);
  });

  describe("a slept thread always wakes for queued work (10/18: cold threads stranded for 8.5 hours)", () => {
    /** A thread whose host was put to sleep, with nothing else on the machine. */
    async function slept(c: ReturnType<typeof setup>) {
      const a = await idle(c);
      c.advance();
      c.pressure({ ...healthy(), memory: { totalBytes: 64 * GB, freePct: 1 } });
      await c.host.checkWarmth();
      expect(c.host.hasSession(a.id)).toBe(false);
      c.pressure(healthy());
      return a;
    }
    async function answers(c: ReturnType<typeof setup>, threadId: string, runId: string) {
      for (let i = 0; i < 200 && c.store.run(runId)?.status !== "running"; i++) await new Promise(r => setTimeout(r, 5));
      expect(c.store.run(runId)?.status).toBe("running");
      c.runtime.last.complete();
      await c.host.kick(threadId);
      expect(c.store.run(runId)?.status).toBe("completed");
    }

    it("a message from another agent opens the host and completes", async () => {
      const c = setup(2);
      const a = await slept(c);
      const mail = await c.host.execute({ type: "submit", commandId: "peer-wake", text: "mail", threadId: a.id,
        origin: { kind: "peer", name: "Lead", address: "loom:lead", messageId: "m-wake" } } as never);
      await answers(c, a.id, mail.runId!);
      expect(c.store.db.prepare("SELECT threadId FROM host_opens").all()).toEqual([{ threadId: a.id }, { threadId: a.id }]);
    });

    it("a pressure reading that never returns does not hold up the open", async () => {
      const c = setup(2, { pressureReadMs: 20 });
      const a = await slept(c);
      c.pressure(() => new Promise<Pressure>(() => {}) as never);
      const r = await submit(c.host, a.id);
      await answers(c, a.id, r.runId!);
    });

    it("a warmth step that never finishes stops holding the queue", async () => {
      const c = setup(2, { warmthStepMs: 20 });
      const a = await slept(c);
      // Another thread's open hangs inside the queue (as a stuck host or read would).
      const stuck = c.store.tx(() => { const t = c.store.createThread({ kind: "coding", cwd: "/repo", provider: "fake" }); c.store.createRun(t.id, "wake", "x"); return t; });
      const open = c.runtime.open.bind(c.runtime);
      c.runtime.open = (options, emit) => options.threadId === stuck.id ? new Promise(() => {}) : open(options, emit);
      void c.host.kick(stuck.id);
      const mail = await c.host.execute({ type: "submit", commandId: "peer-after-stuck", text: "mail", threadId: a.id,
        origin: { kind: "peer", name: "Lead", address: "loom:lead", messageId: "m-stuck" } } as never);
      await answers(c, a.id, mail.runId!);
    });

    it("cools by real activity, not by bookkeeping order (Codex review on #744)", async () => {
      const c = setup(2);
      const older = await idle(c); c.advance();
      const newer = await idle(c); c.advance();
      c.store.tx(() => c.store.updateThread(older.id, { host_seq: 9 }));  // bookkeeping makes it look newest
      const pending = wake(c);
      await c.host.kick(pending.t.id);
      expect(older.session.closed).toBe(true);
      expect(newer.session.closed).toBe(false);
    });

    it("bookkeeping that touches every thread (a restart's reattach) does not stop idle hosts cooling", async () => {
      const c = setup(1);
      const a = await idle(c);
      c.advance();
      // Reattaching after a restart rewrites each host's fields (moving updated_at), and the upgrade then
      // moves the idle host to the new release.
      c.store.tx(() => c.store.updateThread(a.id, { host_seq: 5 }));
      c.store.db.prepare("INSERT INTO host_opens (threadId, reason, ms, at) VALUES (?, 'move', 1, ?)").run(a.id, c.store.now());
      const pending = wake(c);
      await c.host.kick(pending.t.id);
      expect(a.session.closed).toBe(true);
      expect(c.store.run(pending.r.id)?.status).toBe("running");
    });
  });
});

it("opens a conversational assistant ahead of waiting background hosts", async () => {
  const c = setup(10);
  const original = c.runtime.open.bind(c.runtime);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  c.runtime.open = async (options, emit) => {
    if (first) { first = false; entered(); await gate; }
    return original(options, emit);
  };
  const opening = submit(c.host);
  await started;
  const background = wake(c);
  const backgroundOpen = c.host.kick(background.t.id);
  const assistant = c.host.execute({ type: "submit", commandId: "assistant-priority", kind: "tango-agent", provider: "fake", cwd: "/repo", text: "hello" });
  // Allow both dispatch mailboxes to enqueue behind the blocked open.
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  const [, , result] = await Promise.all([opening, backgroundOpen, assistant]);
  expect(c.runtime.sessions.map(session => session.options.threadId).slice(1)).toEqual([result.threadId, background.t.id]);
});
