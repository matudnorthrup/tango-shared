import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { RemoteRuntime, RemoteSession, resolveHostRelease } from "../src/remote-runtime.js";
import type { HostHello } from "../src/host-protocol.js";
import type { RuntimeEvent } from "../src/runtime.js";
class WireSocket extends EventEmitter {
  destroyed = false;
  writes: any[] = [];
  write(line: string) { this.writes.push(JSON.parse(line)); return true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}
const hello = (): HostHello => ({ type: "hello", protocol: 1, upgradeClose: true, instanceId: "host-one", release: "dev", threadId: "thread-one", pid: 123, nativeSessionId: null, activeRunId: null, openRequests: [], answeredRequests: [], answeredAnswers: {}, lastSeq: 0 });
describe("RemoteSession", () => {
  it("buffers replay until activation and waits for its barrier", async () => {
    const socket = new WireSocket();
    const events: RuntimeEvent[] = [];
    const session = new RemoteSession(socket as unknown as Socket, hello(), (event) => events.push(event));
    session.receive({ type: "event", seq: 1, event: { type: "message.completed", runId: "run", text: "done" } });
    expect(events).toEqual([]);
    let complete = false;
    const activation = session.activate(0).then(() => { complete = true; });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(complete).toBe(false);
    session.receive({ type: "replay.end" });
    await activation;
    expect(complete).toBe(true);
    session.detach();
  });
  it("rebinds a duplicate wake and remaps following temporary run ids", async () => {
    const socket = new WireSocket();
    const events: RuntimeEvent[] = [];
    const session = new RemoteSession(socket as unknown as Socket, hello(), (event) => { events.push(event); if (event.type === "wake.started") event.bind("durable-run"); });
    session.receive({ type: "replay.end" });
    await session.activate(4);
    session.receive({ type: "event", seq: 4, event: { type: "wake.started", wakeId: "wake", text: "background" } });
    session.receive({ type: "event", seq: 5, event: { type: "message.completed", runId: "wake", text: "result" } });
    expect(socket.writes).toContainEqual({ type: "bindWake", wakeId: "wake", runId: "durable-run" });
    expect(events[1]).toEqual({ type: "message.completed", runId: "durable-run", text: "result" });
    session.acknowledge(5);
    session.receive({ type: "event", seq: 5, event: { type: "message.completed", runId: "wake", text: "result" } });
    expect(events).toHaveLength(2);
    expect(socket.writes.at(-1)).toEqual({ type: "ack", seq: 5 });
    session.detach();
  });
  it("does not synthesize a second ended event when an acknowledged host exits", async () => {
    const socket = new WireSocket();
    const events: RuntimeEvent[] = [];
    const session = new RemoteSession(socket as unknown as Socket, hello(), (event) => events.push(event));
    session.receive({ type: "replay.end" });
    await session.activate(0);
    session.receive({ type: "event", seq: 1, event: { type: "session.ended" } });
    socket.destroy();
    expect(events).toEqual([{ type: "session.ended" }]);
  });
  it("waits for host teardown before completing explicit close", async () => {
    const socket = new WireSocket();
    const session = new RemoteSession(socket as unknown as Socket, hello(), () => {});
    let closed = false;
    const closing = session.close().then(() => { closed = true; });
    session.receive({ type: "result", id: socket.writes.at(-1).id, ok: true });
    await Promise.resolve();
    expect(closed).toBe(false);
    socket.destroy();
    await closing;
    expect(closed).toBe(true);
  });
  it("rejects replay when the host disconnects before the barrier", async () => {
    const socket = new WireSocket();
    const session = new RemoteSession(socket as unknown as Socket, hello(), () => {});
    const activation = session.activate(0);
    socket.destroy();
    await expect(activation).rejects.toThrow("during replay");
  });
});
it("drains matching pending durable events once and ignores acknowledged ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "loom-pending-"));
  try {
    mkdirSync(join(home, "hosts"));
    const file = join(home, "hosts", "thread-one.pending.jsonl");
    writeFileSync(file, [hello(), { type: "event", seq: 1, event: { type: "message.completed", runId: "run", text: "done" } }, { type: "event", seq: 2, event: { type: "turn.completed", runId: "run" } }].map((m) => JSON.stringify(m)).join("\n"));
    const runtime = new RemoteRuntime({ loomHome: home, claude: { accounts: [], defaultAccount: "fake", sharedProjectsDir: join(home, "projects") } });
    const events: RuntimeEvent[] = [];
    await runtime.drainPending("thread-one", (event) => events.push(event), 1, "host-one");
    await runtime.drainPending("thread-one", (event) => events.push(event), 1, "host-one");
    expect(events).toEqual([{ type: "turn.completed", runId: "run" }]);
    expect(existsSync(file)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


it("reattaches a live host whose hello takes longer than one second", async () => {
  const { createServer } = await import("node:net");
  const { processStart } = await import("../src/proc.js");
  const home = mkdtempSync("/tmp/loom-slow-");
  mkdirSync(join(home, "hosts"));
  const server = createServer((socket) => {
    const timer = setTimeout(() => socket.write(JSON.stringify(hello()) + "\n"), 1200);
    socket.on("error", () => {});
    socket.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(home, "hosts", "thread-one.sock"), resolve); });
  try {
    writeFileSync(join(home, "hosts", "thread-one.json"), JSON.stringify({ threadId: "thread-one", pid: process.pid, started: processStart(process.pid), groups: [] }));
    const runtime = new RemoteRuntime({ loomHome: home, claude: { accounts: [], defaultAccount: "fake", sharedProjectsDir: home } });
    const session = await runtime.open({ threadId: "thread-one", cwd: "/", account: null, nativeSessionId: null }, () => {});
    expect(session.hello.instanceId).toBe("host-one");
    expect(existsSync(join(home, "hosts", "thread-one.log"))).toBe(false);
    session.detach();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

it("recovery attach waits out a live host whose hello takes longer than one second (Codex review on #638)", async () => {
  const { createServer } = await import("node:net");
  const { processStart } = await import("../src/proc.js");
  const home = mkdtempSync("/tmp/loom-slow-attach-");
  mkdirSync(join(home, "hosts"));
  const server = createServer((socket) => {
    const timer = setTimeout(() => socket.write(JSON.stringify(hello()) + "\n"), 1200);
    socket.on("error", () => {});
    socket.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(home, "hosts", "thread-one.sock"), resolve); });
  try {
    writeFileSync(join(home, "hosts", "thread-one.json"), JSON.stringify({ threadId: "thread-one", pid: process.pid, started: processStart(process.pid), groups: [] }));
    const runtime = new RemoteRuntime({ loomHome: home, claude: { accounts: [], defaultAccount: "fake", sharedProjectsDir: home } });
    const session = (await runtime.attach({ threadId: "thread-one", cwd: "/", account: null, nativeSessionId: null }, () => {}))!;
    expect(session.hello.instanceId).toBe("host-one");
    expect(existsSync(join(home, "hosts", "thread-one.log"))).toBe(false);
    session.detach();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

it("quarantines a truncated tail before emitting any partial replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "loom-corrupt-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mkdirSync(join(home, "hosts"));
    writeFileSync(join(home, "hosts", "thread-one.pending.jsonl"), JSON.stringify(hello()) + '\n{"type":');
    const runtime = new RemoteRuntime({ loomHome: home, claude: { accounts: [], defaultAccount: "fake", sharedProjectsDir: home } });
    const emit = vi.fn();
    await expect(runtime.drainPending("thread-one", emit, 0, null)).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(readdirSync(join(home, "hosts"))).toEqual([expect.stringMatching(/^thread-one.pending.corrupt-.*\.jsonl$/)]);
    expect(warn).toHaveBeenCalled();
  } finally { warn.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});


it("propagates rejected and timed out remote injection commands", async () => {
  vi.useFakeTimers();
  const socket = new WireSocket();
  const session = new RemoteSession(socket as unknown as Socket, hello(), () => {});
  try {
    const failed = session.inject("retry as queued");
    const rejection = expect(failed).rejects.toThrow("Injection unsupported");
    session.receive({ type: "result", id: socket.writes.at(-1).id, ok: false, error: "Injection unsupported" });
    await rejection;
    const timedOut = expect(session.inject("timeout")).rejects.toThrow("timed out: inject");
    await vi.advanceTimersByTimeAsync(15_000);
    await timedOut;
  } finally { session.detach(); vi.useRealTimers(); }
});


describe("host release routing", () => {
  it("routes current and pins through immutable release entries, including rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-routing-"));
    try {
      for (const id of ["old", "new"]) {
        mkdirSync(join(root, id, "packages/loom/dist"), { recursive: true });
        writeFileSync(join(root, id, "packages/loom/dist/session-host.js"), "");
      }
      const state = { current: "new", pins: { pinned: "old" } };
      writeFileSync(join(root, "state.json"), JSON.stringify(state));
      expect(resolveHostRelease("normal", root)).toEqual({ release: "new", source: false, entry: join(root, "new/packages/loom/dist/session-host.js") });
      expect(resolveHostRelease("pinned", root).release).toBe("old");
      state.current = "old";
      writeFileSync(join(root, "state.json"), JSON.stringify(state));
      expect(resolveHostRelease("normal", root).release).toBe("old");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("uses its own entry when no releases root exists and fails closed for a broken target", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-routing-"));
    try {
      expect(resolveHostRelease("thread", join(root, "absent")).entry).toMatch(/session-host\.(ts|js)$/);
      writeFileSync(join(root, "state.json"), JSON.stringify({ current: "missing" }));
      expect(() => resolveHostRelease("thread", root)).toThrow("entry missing");
      writeFileSync(join(root, "state.json"), JSON.stringify({ current: "../elsewhere" }));
      expect(() => resolveHostRelease("thread", root)).toThrow("Invalid host release");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it("accepts supported protocol hello and rejects an unsupported host", async () => {
  const { createServer } = await import("node:net");
  const home = mkdtempSync("/tmp/loom-protocol-");
  mkdirSync(join(home, "hosts"));
  let protocol = 1;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ ...hello(), protocol }) + "\n");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(home, "hosts/thread-one.sock"), resolve); });
  try {
    const runtime = new RemoteRuntime({ loomHome: home, claude: { accounts: [], defaultAccount: "fake", sharedProjectsDir: home } });
    const options = { threadId: "thread-one", cwd: "/", account: null, nativeSessionId: null };
    const session = await runtime.attach(options, () => {});
    expect(session?.hello.protocol).toBe(1);
    session?.detach();
    protocol = 2;
    expect(await runtime.attach(options, () => {})).toBeNull();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});


it("upgrade close refuses busy hosts and waits for successful teardown", async () => {
  const socket = new WireSocket();
  const session = new RemoteSession(socket as unknown as Socket, hello(), () => {});
  const refused = session.closeForUpgrade(false);
  expect(socket.writes.at(-1)).toMatchObject({ type: "closeForUpgrade", forceBackground: false });
  session.receive({ type: "result", id: socket.writes.at(-1).id, ok: false, error: "Upgrade safe point unavailable" });
  expect(await refused).toBe(false);
  let finished = false;
  const accepted = session.closeForUpgrade(true).then((result) => { finished = true; return result; });
  const tasks = [{ id: "frozen", kind: "shell", description: "frozen work" }];
  session.receive({ type: "result", id: socket.writes.at(-1).id, ok: true, tasks });
  await Promise.resolve();
  expect(finished).toBe(false);
  socket.destroy();
  expect(await accepted).toEqual(tasks);
});


it("does not report an intentional safe close as a crash", async () => {
  const socket = new WireSocket();
  const events: RuntimeEvent[] = [];
  const session = new RemoteSession(socket as unknown as Socket, hello(), event => events.push(event));
  session.receive({ type: "replay.end" });
  await session.activate(0);
  const closing = session.closeForUpgrade(false);
  session.receive({ type: "result", id: socket.writes.at(-1).id, ok: true, tasks: [] });
  socket.destroy();
  expect(await closing).toEqual([]);
  expect(events).toEqual([]);
});

it("uses legacy close for old hosts and bounds teardown waits", async () => {
  vi.useFakeTimers();
  const socket = new WireSocket();
  const session = new RemoteSession(socket as unknown as Socket, { ...hello(), upgradeClose: undefined }, () => {});
  try {
    const closing = session.closeForUpgrade(false);
    const rejection = expect(closing).rejects.toThrow("upgrade close timed out");
    expect(socket.writes.at(-1).type).toBe("close");
    session.receive({ type: "result", id: socket.writes.at(-1).id, ok: true });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  } finally { session.detach(); vi.useRealTimers(); }
});
