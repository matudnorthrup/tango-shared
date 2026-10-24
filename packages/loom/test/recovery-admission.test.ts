import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveryPaused } from "../src/recovery-admission.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const dirs: string[] = [];
const hosts: LoomHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) { await h.closeAll(); h.store.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loom-recovery-admission-")); dirs.push(dir);
  const file = join(dir, "health.json");
  return { file, write: (alerts: string[] = [], at = Date.now() / 1000) => writeFileSync(file, JSON.stringify({ at, ok: alerts.length === 0, alerts })) };
}
describe("recovery admission", () => {
  it("keeps unavailable monitoring as alarm-only and pauses only on fresh actionable reports", () => {
    const f = fixture();
    expect(recoveryPaused(undefined)).toBe(false);
    expect(recoveryPaused(f.file)).toBe(false);
    writeFileSync(f.file, "{"); expect(recoveryPaused(f.file)).toBe(false);
    f.write([], Date.now() / 1000 - 121); expect(recoveryPaused(f.file)).toBe(false);
    f.write([], Date.now() / 1000 + 60); expect(recoveryPaused(f.file)).toBe(false);
    f.write(); expect(recoveryPaused(f.file)).toBe(false);
    f.write(["bundle_failed"]); expect(recoveryPaused(f.file)).toBe(false);
  });
  it.each(["destination_low_space", "replica_lag"])("pauses and clears %s", alert => {
    const f = fixture(); f.write([alert]); expect(recoveryPaused(f.file)).toBe(true);
    f.write(); expect(recoveryPaused(f.file)).toBe(false);
  });
  it.each(["destination_space_warn", "destination_prune_failed", "source_low_space", "replica_unavailable", "backup_supervisor_stopped", "marker_failed", "bundle_failed"])("keeps %s as an alarm only", alert => {
    const f = fixture(); f.write([alert]); expect(recoveryPaused(f.file)).toBe(false);
  });
  it("allows a runtime override, and ignores stale actionable alarms", () => {
    const f = fixture(); f.write(["replica_lag"], Date.now() / 1000 - 121);
    expect(recoveryPaused(f.file)).toBe(false);
    f.write(["replica_lag"]); expect(recoveryPaused(f.file)).toBe(true);
    writeFileSync(`${f.file}.override`, "allow\n"); expect(recoveryPaused(f.file)).toBe(false);
    rmSync(`${f.file}.override`); expect(recoveryPaused(f.file)).toBe(true);
  });
  it("preserves a provider retry reason and deadline while recovery is unhealthy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fixture(); f.write(["destination_low_space"]);
    const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime }, { recoveryHealthFile: f.file }); hosts.push(host);
    const first = await host.execute({ type: "submit", commandId: "busy-first", provider: "fake", cwd: "/repo", text: "hello" });
    const until = Date.now() + 60_000;
    store.updateThread(first.threadId!, { admission: "provider_busy", admission_until: until });
    await host.kick(first.threadId!);
    expect(store.thread(first.threadId!)).toMatchObject({ admission: "provider_busy", admission_until: until });
    f.write(); await vi.advanceTimersByTimeAsync(30_000);
    expect(store.runs(first.threadId!)[0]?.status).toBe("queued");
    expect(store.thread(first.threadId!)).toMatchObject({ admission: "provider_busy", admission_until: until });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.runs(first.threadId!)[0]?.status).toBe("running");
  });
  it("holds cold and warm owner turns, keeps running work intact, and resumes from its retry timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fixture(); f.write(["destination_low_space"]);
    const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime }, { recoveryHealthFile: f.file }); hosts.push(host);
    const first = await host.execute({ type: "submit", commandId: "recovery-first", provider: "fake", cwd: "/repo", text: "hello" });
    expect(store.thread(first.threadId!)?.admission).toBe("recovery_unhealthy");
    expect(store.runs(first.threadId!)[0]?.status).toBe("queued");
    writeFileSync(`${f.file}.override`, "allow"); await vi.advanceTimersByTimeAsync(30_000);
    expect(store.runs(first.threadId!)[0]?.status).toBe("running");
    rmSync(`${f.file}.override`);
    const session = runtime.last;
    f.write(["replica_lag"]);
    const next = await host.execute({ type: "submit", commandId: "recovery-next", threadId: first.threadId!, text: "again" });
    expect(store.runs(first.threadId!).filter(r => r.status === "running")).toHaveLength(1);
    session.complete(); await host.kick(first.threadId!);
    expect(store.run(next.runId!)?.status).toBe("queued");
    expect(store.thread(first.threadId!)?.admission).toBe("recovery_unhealthy");
    f.write(); await vi.advanceTimersByTimeAsync(30_000);
    expect(store.run(next.runId!)?.status).toBe("running");
    expect(store.thread(first.threadId!)?.admission).toBeNull();
    expect(runtime.last).toBe(session);
  });
});

it.each(["destination_low_space", "replica_lag"])("admits assistant owner turns during %s while background jobs remain held", async alert => {
  const f = fixture(); f.write([alert]);
  const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime }, { recoveryHealthFile: f.file }); hosts.push(host);
  const job = await host.execute({ type: "submit", commandId: "job", provider: "fake", cwd: "/repo", kind: "tango-job", text: "scheduled" });
  const assistant = await host.execute({ type: "submit", commandId: "assistant", provider: "fake", cwd: "/repo", kind: "tango-agent", text: "hello" });
  expect(store.run(job.runId!)?.status).toBe("queued");
  expect(store.run(assistant.runId!)?.status).toBe("running");
  runtime.last.complete(); await host.kick(assistant.threadId!);
  const wake = store.createRun(assistant.threadId!, "wake", "background");
  await host.kick(assistant.threadId!);
  expect(store.run(wake.id)?.status).toBe("queued");
  const reply = await host.execute({ type: "submit", commandId: "reply", threadId: assistant.threadId!, text: "another question" });
  expect(store.run(reply.runId!)?.status).toBe("running");
  expect(store.run(wake.id)?.status).toBe("queued");
});

it("keeps the local disk safety floor for assistant turns even with a recovery exemption", async () => {
  const f = fixture(); f.write(["destination_low_space"]);
  const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime }, { recoveryHealthFile: f.file,
    pressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 100 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 } }),
  }); hosts.push(host);
  const assistant = await host.execute({ type: "submit", commandId: "low-disk", provider: "fake", cwd: "/repo", kind: "tango-agent", text: "hello" });
  expect(store.run(assistant.runId!)?.status).toBe("queued");
  expect(store.thread(assistant.threadId!)?.admission).toBe("disk_low");
});
