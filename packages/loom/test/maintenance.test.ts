import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomStore } from "../src/store.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";

it("drains active turns, queues new work and wakes, persists, and reports counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-maintenance-"));
  let store = new LoomStore(join(dir, "db"));
  const runtime = new FakeRuntime(store);
  let host = new LoomHost(store, { fake: runtime });
  try {
    const first = await host.execute({ type: "submit", commandId: "first", cwd: "/tmp", provider: "fake", text: "first" });
    await host.setMaintenance(true, "upgrade");
    await host.execute({ type: "submit", commandId: "steer", threadId: first.threadId, text: "keep going", steer: true });
    expect(runtime.last.injected).toEqual(["keep going"]);
    const second = await host.execute({ type: "submit", commandId: "second", cwd: "/tmp", provider: "fake", text: "second" });
    await host.warm(second.threadId!);
    expect(runtime.sessions).toHaveLength(1);
    expect(host.maintenance()).toMatchObject({ on: true, reason: "upgrade", running: 1, queued: 1 });
    runtime.last.complete();
    await host.kick(first.threadId!);
    expect(store.run(first.runId!)?.status).toBe("completed");
    expect(host.snapshot()).toMatchObject({ maintenance: true });
    expect(host.detail(second.threadId!)?.thread).toMatchObject({ maintenance: true });
    await host.execute({ type: "trigger.create", commandId: "trigger", threadId: first.threadId!, kind: "time", spec: { afterMinutes: 0 }, note: "wake" });
    await host.triggers.tick();
    expect(host.maintenance()).toMatchObject({ running: 0, queued: 2 });
    await host.closeAll(); store.close();
    store = new LoomStore(join(dir, "db")); host = new LoomHost(store, { fake: runtime });
    expect(host.maintenance()).toMatchObject({ on: true, reason: "upgrade", queued: 2 });
    await host.kick(second.threadId!);
    expect(runtime.sessions).toHaveLength(1);
    await host.setMaintenance(false);
    expect(store.run(second.runId!)?.status).toBe("running");
    expect(host.maintenance()).toMatchObject({ on: false, running: 2, queued: 0 });
  } finally {
    await host.closeAll(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

it("allows answers to an open question while holding the next run", async () => {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime(store), host = new LoomHost(store, { fake: runtime });
  try {
    const first = await host.execute({ type: "submit", commandId: "first", cwd: "/tmp", provider: "fake", text: "work" });
    runtime.last.emit({ type: "request.opened", runId: first.runId!, requestId: "question", kind: "question", payload: {} });
    await host.setMaintenance(true);
    await host.execute({ type: "answer", commandId: "answer", requestId: "question", answer: "yes" });
    expect(runtime.last.answers).toEqual([{ requestId: "question", answer: "yes" }]);
    expect(store.thread(first.threadId!)?.status).toBe("running");
    await host.execute({ type: "submit", commandId: "next", threadId: first.threadId, text: "next" });
    runtime.last.complete(); await host.kick(first.threadId!);
    expect(runtime.last.turns).toHaveLength(1);
    await host.setMaintenance(false);
    expect(runtime.last.turns).toHaveLength(2);
  } finally { await host.closeAll(); store.close(); }
});

it("closes a host that finishes opening after maintenance starts", async () => {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime(store), host = new LoomHost(store, { fake: runtime });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const open = runtime.open.bind(runtime);
  runtime.open = async (options, emit) => { await gate; return open(options, emit); };
  try {
    const submitted = host.execute({ type: "submit", commandId: "late", cwd: "/tmp", provider: "fake", text: "late" });
    await new Promise(resolve => setTimeout(resolve, 10));
    await host.setMaintenance(true, "upgrade");
    release();
    const { threadId, runId } = await submitted;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.run(runId!)?.status).toBe("queued");
    expect(runtime.sessions.every(session => session.closed)).toBe(true);
    expect(host.detail(threadId!)?.thread).toMatchObject({ warmth: "cooled" });
  } finally { await host.closeAll(); store.close(); }
});

it("closes a host when maintenance starts during activation", async () => {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime(store), host = new LoomHost(store, { fake: runtime });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const activating = new Promise<void>(resolve => { entered = resolve; });
  const open = runtime.open.bind(runtime);
  runtime.open = async (options, emit) => {
    const session = await open(options, emit);
    session.activate = async () => { entered(); await gate; };
    return session;
  };
  try {
    const submitted = host.execute({ type: "submit", commandId: "activation", cwd: "/tmp", provider: "fake", text: "late" });
    await activating;
    await host.setMaintenance(true);
    release();
    const { threadId, runId } = await submitted;
    expect(store.run(runId!)?.status).toBe("queued");
    expect(runtime.last.closed).toBe(true);
    expect(runtime.last.turns).toHaveLength(0);
    expect(host.detail(threadId!)?.thread).toMatchObject({ warmth: "cooled" });
  } finally { release(); await host.closeAll(); store.close(); }
});
