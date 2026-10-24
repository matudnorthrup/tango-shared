import { describe, expect, it } from "vitest";
import { jobAction } from "../src/actions.js";
import { listIncidents, recordEvent } from "../src/incidents.js";
import { upsertJob } from "../src/jobs.js";
import { runTick } from "../src/tick.js";
import { fakeCtx, fakeExec, ok, tempLedger } from "./helpers.js";

const failRun = (jobId: string) => ({ source: "test", kind: "run.failed", severity: "error" as const, title: "Exited 1", jobId });

describe("incidents that no longer apply", () => {
  it("pausing a job closes its open incidents", async () => {
    const l = tempLedger();
    const ctx = fakeCtx();
    ctx.exec = fakeExec({ "launchctl bootout": ok(), "launchctl disable": ok() });
    upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", facts: { loaded: true } });
    recordEvent(l, failRun("launchd:com.example.job"));
    expect(listIncidents(l)).toHaveLength(1);
    const r = await jobAction(l, "launchd:com.example.job", "pause", {}, ctx);
    expect(r.ok).toBe(true);
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("a tick closes delivery failures of a schedule whose delivery was turned off, and incidents of untracked processes", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "schedule:brief", runner: "schedule", name: "Brief", facts: { deliveryOff: true } });
    recordEvent(l, { source: "scheduler", kind: "delivery.failed", severity: "error", title: "Brief delivery failed", jobId: "schedule:brief" });
    recordEvent(l, { source: "tick", kind: "process.unmanaged", severity: "info", title: "Unmanaged process node x.mjs", jobId: "launchd:unmanaged-4242" });
    expect(listIncidents(l)).toHaveLength(2);
    await runTick(l, { ctx: fakeCtx(), runners: [] as never[], noNotify: true, skipSteps: ["ingest", "probe", "late", "unmanaged", "logs", "prune"] as never[] });
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("a paused job keeps incidents that stay true while paused (an oversized log), and settles after ingest", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", state: "paused" });
    recordEvent(l, failRun("launchd:com.example.job"));
    recordEvent(l, { source: "tick", kind: "log.large", severity: "warning", title: "Log is large: out.log", jobId: "launchd:com.example.job" });
    const report = await runTick(l, { ctx: fakeCtx(), runners: [] as never[], noNotify: true, skipSteps: ["probe", "late", "unmanaged", "logs", "prune"] as never[] });
    expect(listIncidents(l).map((i) => i.title)).toEqual(["Log is large: out.log"]);
    const order = Object.keys(report.steps);
    expect(order.indexOf("settle")).toBeGreaterThan(order.indexOf("ingest"));
  });
});
