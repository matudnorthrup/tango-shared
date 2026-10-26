import type { MemoryEvalBenchmarkRun } from "@tango/core";
import type { RecordEventInput } from "@tango/system";

/** A healthy evaluation clears only its own alert, never other job incidents. */
export function memoryEvalRecoveryEvent(run: MemoryEvalBenchmarkRun): RecordEventInput | null {
  if (run.cases.length === 0 || run.failedCount > 0 || run.passedCount !== run.cases.length) return null;
  return {
    source: "scheduler",
    kind: "custom.ok",
    severity: "recovery",
    jobId: "schedule:memory-eval-report",
    title: "Memory eval: retrieval benchmarks passed",
    data: { passed: run.passedCount, total: run.cases.length },
    resolves: { kind: "custom", title: "Memory eval: retrieval benchmarks failing" },
  };
}
