import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEvalBenchmarkRun } from "@tango/core";
import { openLedger, recordEvent, listIncidents } from "../../system/src/index.js";
import { memoryEvalRecoveryEvent } from "../src/memory-eval-event.js";

function evaluation(passed: boolean): MemoryEvalBenchmarkRun {
  return {
    cases: [{
      caseId: "retrieval", query: "context", passed,
      matchedExpectedTerms: [], matchedForbiddenTerms: [],
      matchedExpectedSources: [], matchedForbiddenSources: [],
      results: [], failureReasons: passed ? [] : ["missing context"],
    }],
    passedCount: passed ? 1 : 0,
    failedCount: passed ? 0 : 1,
  };
}

describe("memory evaluation recovery", () => {
  it("resolves the benchmark warning while preserving another custom incident on the same job", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-eval-event-"));
    const ledger = openLedger({ path: join(directory, "system.sqlite") });
    try {
      const warning = {
        source: "scheduler", kind: "custom", severity: "warning" as const,
        jobId: "schedule:memory-eval-report",
        title: "Memory eval: retrieval benchmarks failing",
      };
      recordEvent(ledger, warning);
      recordEvent(ledger, { ...warning, title: "Snapshot audit failed" });
      recordEvent(ledger, memoryEvalRecoveryEvent(evaluation(true))!);
      expect(listIncidents(ledger).map((incident) => incident.title)).toEqual(["Snapshot audit failed"]);
      expect(listIncidents(ledger, { status: "all" }).find((incident) => incident.title === warning.title)?.status).toBe("resolved");
      // A later miss must still alert, even after the previous recovery.
      recordEvent(ledger, warning);
      expect(listIncidents(ledger).some((incident) => incident.title === warning.title)).toBe(true);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not claim recovery for a failed, empty, or incomplete suite", () => {
    expect(memoryEvalRecoveryEvent(evaluation(false))).toBeNull();
    expect(memoryEvalRecoveryEvent({ cases: [], passedCount: 0, failedCount: 0 })).toBeNull();
    expect(memoryEvalRecoveryEvent({ ...evaluation(true), passedCount: 0 })).toBeNull();
  });
});
