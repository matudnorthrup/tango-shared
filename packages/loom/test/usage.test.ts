import { describe, expect, it } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { dayStart, USAGE_RETENTION_MS, UsageLedger } from "../src/usage.js";
import { FakeRuntime } from "./fake-runtime.js";

describe("usage ledger", () => {
  it("counts today from local midnight and keeps the latest call's context", async () => {
    const store = new LoomStore(":memory:");
    let now = new Date(2026, 9, 19, 23, 30).getTime();
    store.now = () => now;
    const host = new LoomHost(store, { fake: new FakeRuntime() });
    const r = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake" });
    expect(host.usage.summary(r.threadId!)).toBeNull();
    host.usage.record(r.threadId!, r.runId!, { context: 300_000, cacheRead: 290_000, cacheWrite: 9_000, output: 100 });
    now = new Date(2026, 9, 20, 0, 15).getTime();
    host.usage.record(r.threadId!, r.runId!, { context: 40_000, cacheRead: 39_000, cacheWrite: 900, output: 80 });
    expect(host.usage.summary(r.threadId!)).toEqual({ tokens: 40_000, at: now, today: 40_000, callsToday: 1, day: new Date(2026, 9, 20).getTime() });
    expect(dayStart(now)).toBe(new Date(2026, 9, 20).getTime());
  });

  it("prunes history past retention when Loom starts, keeping each thread's newest sample", async () => {
    const store = new LoomStore(":memory:");
    let now = Date.UTC(2026, 8, 1);
    store.now = () => now;
    const first = new LoomHost(store, { fake: new FakeRuntime() });
    const r = await first.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/repo", provider: "fake" });
    first.usage.record(r.threadId!, null, { context: 1, cacheRead: 0, cacheWrite: 0, output: 0 });
    first.usage.record(r.threadId!, null, { context: 2, cacheRead: 0, cacheWrite: 0, output: 0 });
    now += USAGE_RETENTION_MS + 1;
    new UsageLedger(store);
    // The newest sample stays: the thread still says how large its session is.
    expect(store.db.prepare("SELECT context FROM usage").all()).toEqual([{ context: 2 }]);
  });
});
