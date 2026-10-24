import { describe, expect, it } from "vitest";
import { listEvents, listIncidents, recordEvent } from "../src/incidents.js";
import { getJob, listRuns, upsertJob } from "../src/jobs.js";
import { finishRun, recordRun, startRun, tailBytes } from "../src/runs.js";
import type { Criticality } from "../src/types.js";
import { minutesAgo, tempLedger } from "./helpers.js";

function job(l: ReturnType<typeof tempLedger>, criticality: Criticality, facts: Record<string, unknown> = {}) {
  upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", criticality, facts });
  return "launchd:com.example.job";
}

const runOnce = (l: ReturnType<typeof tempLedger>, id: string, status: "ok" | "failed" | "quiet") => {
  const runId = startRun(l, id);
  finishRun(l, runId, { status, exitCode: status === "failed" ? 1 : 0 });
};

describe("failed-run thresholds", () => {
  it("critical: an event on the first failure", () => {
    const l = tempLedger();
    const id = job(l, "critical");
    runOnce(l, id, "failed");
    const ev = listEvents(l);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("run.failed");
    expect(ev[0]!.severity).toBe("critical");
  });

  it("normal: an event on the second failure in a row", () => {
    const l = tempLedger();
    const id = job(l, "normal");
    runOnce(l, id, "failed");
    expect(listEvents(l)).toHaveLength(0);
    runOnce(l, id, "quiet"); // nothing-to-do runs neither break nor extend the streak
    runOnce(l, id, "failed");
    expect(listEvents(l).map((e) => e.severity)).toEqual(["error"]);
  });

  it("normal: a success in between resets the streak", () => {
    const l = tempLedger();
    const id = job(l, "normal");
    runOnce(l, id, "failed");
    runOnce(l, id, "ok");
    runOnce(l, id, "failed");
    expect(listEvents(l)).toHaveLength(0);
  });

  it("quiet: never an event, only history", () => {
    const l = tempLedger();
    const id = job(l, "quiet");
    for (let i = 0; i < 5; i++) runOnce(l, id, "failed");
    expect(listEvents(l)).toHaveLength(0);
    expect(listRuns(l, id)).toHaveLength(5);
  });

  it("an annotation's failAfter overrides the criticality", () => {
    const l = tempLedger();
    const id = job(l, "critical", { failAfter: 3 });
    runOnce(l, id, "failed");
    runOnce(l, id, "failed");
    expect(listEvents(l)).toHaveLength(0);
    runOnce(l, id, "failed");
    expect(listEvents(l)).toHaveLength(1);
  });
});

describe("recovery", () => {
  it("a success after an open failure records a recovery and resolves run.failed, job.late and job.restarting", () => {
    const l = tempLedger();
    const id = job(l, "critical");
    runOnce(l, id, "failed");
    recordEvent(l, { source: "tick", kind: "job.late", severity: "warning", title: "Job is late", jobId: id });
    expect(listIncidents(l)).toHaveLength(2);
    runOnce(l, id, "ok");
    expect(listIncidents(l)).toHaveLength(0);
    expect(listEvents(l)[0]).toMatchObject({ kind: "run.ok", severity: "recovery" });
  });

  it("a success with nothing open records no event", () => {
    const l = tempLedger();
    const id = job(l, "critical");
    runOnce(l, id, "ok");
    expect(listEvents(l)).toHaveLength(0);
  });

  it("updates the job's last run, status and exit", () => {
    const l = tempLedger();
    const id = job(l, "normal");
    const runId = startRun(l, id);
    expect(getJob(l, id)!.lastStatus).toBe("running");
    expect(getJob(l, id)!.facts.wrapped).toBe(true);
    finishRun(l, runId, { status: "failed", exitCode: 3, summary: "exit 3", outputTail: "x".repeat(10_000) });
    const j = getJob(l, id)!;
    expect(j.lastStatus).toBe("failed");
    expect(j.lastExit).toBe(3);
    const [run] = listRuns(l, id);
    expect(run!.outputTail!.length).toBe(4096);
    expect(run!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("recordRun is idempotent on sourceRef", () => {
    const l = tempLedger();
    const r = { jobId: "schedule:x", startedAt: minutesAgo(5), finishedAt: minutesAgo(4), status: "ok" as const, sourceRef: "schedule_runs:1" };
    expect(recordRun(l, r)).not.toBeNull();
    expect(recordRun(l, r)).toBeNull();
    expect(listRuns(l, "schedule:x")).toHaveLength(1);
  });

  it("tailBytes keeps the last bytes", () => {
    expect(tailBytes("abcdef", 3)).toBe("def");
    expect(tailBytes(null)).toBeNull();
  });
});
