import { expect, it, vi } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

it("retires only old finished jobs, cascades history, and reports the last pass", async () => {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime }, {
    pressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1000 * 1024 ** 3, freeBytes: 800 * 1024 ** 3 } }),
  });
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const day = 86_400_000, now = 20 * day;
  store.now = () => now;
  function job(id: string, ended = now - 8 * day, kind = "tango-job") {
    return store.tx(() => {
      store.createThread({ id, kind, cwd: "/tmp", provider: "fake" });
      const run = store.createRun(id, "user", "job");
      store.updateRun(run.id, { status: "completed", ended_at: ended });
      return run;
    });
  }
  try {
    const old = job("old");
    job("boundary", now - 7 * day); job("recent", now - day); job("coding", now - 8 * day, "coding");
    for (const status of ["queued", "running"] as const) {
      job(status);
      store.tx(() => {
        const run = store.createRun(status, "user", "pending");
        store.updateRun(run.id, { status });
      });
    }
    const request = job("request");
    store.tx(() => store.openRequest("request", request.id, "question", {}));
    job("decision");
    store.tx(() => store.addDecision({ id: "D-1", thread_id: "decision", run_id: null, class: "policy", level: 1, candidate: "A", ask: "Choose", brief: "{}", supersedes: null }));
    job("live"); await host.warm("live");
    expect(runtime.sessions).toHaveLength(1);
    store.tx(() => store.createThread({ id: "empty", kind: "tango-job", cwd: "/tmp", provider: "fake" }));
    expect(host.retireJobs()).toBe(1);
    expect(store.thread("old")).toBeUndefined(); expect(store.run(old.id)).toBeUndefined();
    expect(store.threads().map(t => t.id).sort()).toEqual(["boundary", "coding", "decision", "empty", "live", "queued", "recent", "request", "running"]);
    expect(await host.machine()).toMatchObject({ retiredJobs: 1 });
    expect(host.retireJobs()).toBe(0);
    expect(await host.machine()).toMatchObject({ retiredJobs: 0 });
    expect(log).toHaveBeenLastCalledWith("Loom job retirement: 0 retired");
    vi.stubEnv("LOOM_JOB_RETENTION_DAYS", "1");
    expect(host.retireJobs()).toBe(1);
    expect(store.thread("boundary")).toBeUndefined();
  } finally { vi.unstubAllEnvs(); log.mockRestore(); await host.closeAll(); store.close(); }
});

it("removes a retired job's trigger history and keeps a job that is still waiting", async () => {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime }, {
    pressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1000 * 1024 ** 3, freeBytes: 800 * 1024 ** 3 } }),
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  const day = 86_400_000, now = 20 * day;
  store.now = () => now;
  for (const id of ["done-job", "waiting-job"]) store.tx(() => {
    store.createThread({ id, kind: "tango-job", cwd: "/tmp", provider: "fake" });
    const run = store.createRun(id, "user", "job");
    store.updateRun(run.id, { status: "completed", ended_at: now - 8 * day });
  });
  try {
    const fired = host.triggers.create("done-job", "time", { at: new Date(0).toISOString() }, "old wait");
    host.triggers.cancel(fired);
    host.triggers.create("waiting-job", "file", { path: "/nonexistent/loom-retention", exists: true }, "still waiting");
    expect(host.retireJobs()).toBe(1);
    expect(store.thread("done-job")).toBeUndefined();
    expect(host.triggers.list("done-job")).toHaveLength(0);
    expect(store.thread("waiting-job")).toBeDefined();
    expect(host.triggers.list("waiting-job", "waiting")).toHaveLength(1);
  } finally { await host.closeAll(); store.close(); }
});

it("retains live, unsettled and unfinished probes, then removes the last batch and its artifacts", async () => {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "loom-retention-"));
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime();
  const host = new LoomHost(store, { codex: runtime }, { loomHome: home, fanOutArtifacts: join(home, "artifacts") });
  host.fanOuts.close();
  const day = 86_400_000, now = 20 * day;
  store.now = () => now;
  const parent = store.tx(() => store.createThread({ kind: "coding", cwd: home, provider: "codex" }));
  const batch = store.tx(() => host.fanOuts.create(parent.id, { items: ["old", "unsettled", "queued", "live", "recent"].map(label => ({ label, prompt: "read" })) }));
  const folder = join(home, "fan-outs", batch.fanOutId), artifact = join(home, "artifacts", `loom-fan-out-${batch.fanOutId}`);
  try {
    store.tx(() => {
      for (const p of batch.probes) {
        const run = store.createRun(p.threadId, "wake", "read");
        store.updateRun(run.id, { status: p.label === "queued" ? "queued" : "completed", ended_at: now - 8 * day });
        store.updateThread(p.threadId, { settled_at: p.label === "unsettled" ? null : p.label === "recent" ? now : now - 8 * day });
      }
      store.db.prepare("UPDATE fan_out_probes SET status='done'").run();
    });
    expect(host.retireJobs()).toBe(0); // Even terminal threads belong to an unfinished batch.
    const liveId = batch.probes.find(p => p.label === "live")!.threadId;
    store.db.prepare("UPDATE fan_out_probes SET status='running' WHERE thread_id=?").run(liveId);
    await host.warm(liveId);
    expect(runtime.sessions).toHaveLength(1);
    store.db.prepare("UPDATE fan_out_probes SET status='done' WHERE thread_id=?").run(liveId);
    store.db.prepare("UPDATE fan_outs SET finished=1").run();
    expect(host.retireJobs()).toBe(1);
    expect(store.thread(batch.probes[0]!.threadId)).toBeUndefined();
    expect(existsSync(folder)).toBe(true); expect(existsSync(artifact)).toBe(true);
    await host.closeAll();
    store.tx(() => {
      for (const p of batch.probes.slice(1)) {
        store.updateThread(p.threadId, { settled_at: now - 8 * day });
        for (const run of store.runs(p.threadId)) store.updateRun(run.id, { status: "completed", ended_at: now - 8 * day });
      }
    });
    expect(host.retireJobs()).toBe(4);
    expect(host.fanOuts.list(parent.id)).toEqual([]);
    expect(existsSync(folder)).toBe(false); expect(existsSync(artifact)).toBe(false);
  } finally { await host.closeAll(); store.close(); rmSync(home, { recursive: true, force: true }); }
});
