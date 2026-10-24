import { describe, expect, it } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import type { OpenSessionOptions, Runtime } from "../src/runtime.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("thread roles", () => {
  function setup() {
    const store = new LoomStore(":memory:");
    const fake = new FakeRuntime();
    const opened: OpenSessionOptions[] = [];
    const runtime: Runtime = { ...fake, open: (options, emit) => { opened.push(options); return fake.open(options, emit); } } as Runtime;
    return { store, host: new LoomHost(store, { fake: runtime }), opened };
  }

  it("a new thread is interactive with no owner unless started as something else", async () => {
    const { store, host } = setup();
    const plain = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/r", provider: "fake" });
    const worker = await host.execute({ type: "submit", commandId: "c2", text: "playtest", cwd: "/r", provider: "fake", role: "worker", parentThreadId: "agent:compass" });
    await flush();
    expect(store.thread(plain.threadId!)).toMatchObject({ role: "interactive", parent_thread_id: null });
    expect(store.thread(worker.threadId!)).toMatchObject({ role: "worker", parent_thread_id: "agent:compass" });
    await expect(host.execute({ type: "submit", commandId: "c3", text: "x", cwd: "/r", provider: "fake", role: "boss" as never })).rejects.toThrow(/role must be/);
  });

  it("the session opens knowing its role, and the role can change later", async () => {
    const { store, host, opened } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "watch PRs", cwd: "/r", provider: "fake", role: "ops", parentThreadId: "agent:compass" });
    await flush();
    expect(opened.at(-1)).toMatchObject({ threadId: r.threadId, role: "ops" });
    await host.execute({ type: "role", commandId: "c2", threadId: r.threadId!, role: "interactive" });
    expect(store.thread(r.threadId!)).toMatchObject({ role: "interactive", parent_thread_id: "agent:compass" });
    await host.execute({ type: "role", commandId: "c3", threadId: r.threadId!, role: "worker", parentThreadId: null });
    expect(store.thread(r.threadId!)).toMatchObject({ role: "worker", parent_thread_id: null });
  });
});
