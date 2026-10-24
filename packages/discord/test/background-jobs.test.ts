import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundJobManager,
  formatBackgroundJobCompletion,
  handleBackgroundJobRequest,
  type BackgroundJob,
} from "../src/background-jobs.js";

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-bg-jobs-"));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

const baseInput = {
  agentId: "sierra",
  channelId: "chan-1",
  threadId: "thread-1",
  label: "Bike sweep",
};

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("BackgroundJobManager", () => {
  it("runs a real detached job, captures output, and delivers its exit code once", async () => {
    const delivered: BackgroundJob[] = [];
    const manager = new BackgroundJobManager({
      rootDir,
      onFinished: async (job) => {
        delivered.push({ ...job });
        return true;
      },
    });

    const job = manager.startJob({ ...baseInput, command: "echo swept 80 searches\nexit 3" });
    expect(job.status).toBe("running");
    expect(job.dir.startsWith(rootDir)).toBe(true);

    await waitFor(() => fs.existsSync(path.join(job.dir, "exit_code")));
    await manager.tick();
    await manager.tick();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ exitCode: 3, status: "finished", timedOut: false });
    expect(manager.get("sierra", job.id)?.status).toBe("notified");
    expect(fs.readFileSync(path.join(job.dir, "output.log"), "utf8")).toContain("swept 80 searches");
  });

  it("retries delivery on the next tick when it fails", async () => {
    const onFinished = vi.fn<(job: BackgroundJob) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("discord down"))
      .mockResolvedValueOnce(true);
    const manager = new BackgroundJobManager({
      rootDir,
      onFinished,
      spawnJob: () => 4242,
      isAlive: () => false,
    });
    const job = manager.startJob({ ...baseInput, command: "true" });

    await manager.tick();
    expect(manager.get("sierra", job.id)?.status).toBe("finished");
    await manager.tick();
    expect(manager.get("sierra", job.id)?.status).toBe("notified");
    expect(onFinished).toHaveBeenCalledTimes(2);
  });

  it("terminates a job past its timeout, escalating to SIGKILL", async () => {
    let now = Date.parse("2026-09-27T14:00:00Z");
    let alive = true;
    const killGroup = vi.fn();
    const manager = new BackgroundJobManager({
      rootDir,
      onFinished: async () => true,
      now: () => now,
      spawnJob: () => 4242,
      isAlive: () => alive,
      killGroup,
    });
    const job = manager.startJob({ ...baseInput, command: "sleep 9999", timeoutSeconds: 120 });

    now += 60_000;
    await manager.tick();
    expect(killGroup).not.toHaveBeenCalled();

    now += 61_000;
    await manager.tick();
    expect(killGroup).toHaveBeenLastCalledWith(4242, "SIGTERM");
    now += 15_000;
    await manager.tick();
    expect(killGroup).toHaveBeenLastCalledWith(4242, "SIGKILL");

    alive = false;
    await manager.tick();
    expect(manager.get("sierra", job.id)).toMatchObject({ timedOut: true, exitCode: null, status: "notified" });
  });

  it("picks up jobs persisted by a previous bot process", async () => {
    const first = new BackgroundJobManager({
      rootDir,
      onFinished: async () => false,
      spawnJob: () => 4242,
      isAlive: () => true,
    });
    const job = first.startJob({ ...baseInput, command: "true" });
    fs.writeFileSync(path.join(job.dir, "exit_code"), "0\n");

    const delivered: string[] = [];
    const second = new BackgroundJobManager({
      rootDir,
      onFinished: async (finished) => {
        delivered.push(finished.id);
        return true;
      },
      isAlive: () => false,
      pollMs: 60_000,
    });
    second.start();
    await waitFor(() => delivered.length === 1);
    second.stop();
    expect(delivered).toEqual([job.id]);
  });

  it("caps concurrent jobs per agent", () => {
    const manager = new BackgroundJobManager({
      rootDir,
      onFinished: async () => true,
      spawnJob: () => 4242,
      isAlive: () => true,
    });
    for (let i = 0; i < 3; i += 1) manager.startJob({ ...baseInput, command: "true" });
    expect(() => manager.startJob({ ...baseInput, command: "true" })).toThrow(/already running 3/u);
    expect(() => manager.startJob({ ...baseInput, agentId: "watson", command: "true" })).not.toThrow();
  });
});

describe("handleBackgroundJobRequest", () => {
  function createManager() {
    return new BackgroundJobManager({
      rootDir,
      onFinished: async () => true,
      spawnJob: () => 4242,
      isAlive: () => true,
      killGroup: vi.fn(),
    });
  }

  it("starts a job for the trusted caller and thread", () => {
    const manager = createManager();
    const result = handleBackgroundJobRequest(manager, {
      action: "start",
      label: "Bike sweep",
      command: "node sweep.mjs",
      _requester_agent_id: "sierra",
      _channel_id: "chan-1",
      _thread_id: "thread-1",
    });
    expect(result).toMatchObject({ status: "running", label: "Bike sweep" });
    const [job] = manager.list("sierra");
    expect(job).toMatchObject({ agentId: "sierra", channelId: "chan-1", threadId: "thread-1" });
  });

  it("refuses calls without a trusted identity or conversation", () => {
    const manager = createManager();
    expect(() => handleBackgroundJobRequest(manager, { action: "list" })).toThrow(/identity/u);
    expect(() =>
      handleBackgroundJobRequest(manager, { action: "start", command: "true", _requester_agent_id: "sierra" }),
    ).toThrow(/Discord conversation/u);
  });

  it("keeps each agent to its own jobs", () => {
    const manager = createManager();
    const job = manager.startJob({ ...baseInput, command: "true" });
    expect(() =>
      handleBackgroundJobRequest(manager, { action: "cancel", job_id: job.id, _requester_agent_id: "watson" }),
    ).toThrow(/no background job/u);
    expect(handleBackgroundJobRequest(manager, { action: "list", _requester_agent_id: "watson" })).toEqual({ jobs: [] });
    expect(
      handleBackgroundJobRequest(manager, { action: "cancel", job_id: job.id, _requester_agent_id: "sierra" }),
    ).toMatchObject({ status: "cancelled" });
  });
});

describe("formatBackgroundJobCompletion", () => {
  it("describes the outcome and where the output is", () => {
    const job = {
      id: "bike-sweep-1234abcd",
      label: "Bike sweep",
      dir: "/data/background-jobs/bike-sweep-1234abcd",
      startedAt: "2026-09-27T14:00:00.000Z",
      finishedAt: "2026-09-27T14:12:30.000Z",
      exitCode: 0,
      timedOut: false,
      timeoutSeconds: 3600,
    } as BackgroundJob;
    const text = formatBackgroundJobCompletion(job, Date.parse("2026-09-27T14:13:00Z"));
    expect(text).toContain("**Bike sweep** finished after 12m 30s");
    expect(text).toContain("/data/background-jobs/bike-sweep-1234abcd/output.log");
    expect(text.length).toBeLessThan(2000);
  });
});
