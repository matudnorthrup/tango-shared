import { failThreshold } from "./annotations.js";
import { hasOpenIncidentOfKind, recordEvent } from "./incidents.js";
import { ensureJob, getJob, mapRun } from "./jobs.js";
import { nowIso, tx } from "./ledger.js";
import type { Ledger, RunRow } from "./types.js";

export const OUTPUT_TAIL_BYTES = 4096;
const RESOLVED_BY_SUCCESS = ["run.failed", "job.late", "job.restarting"];

export function tailBytes(text: string | undefined | null, max = OUTPUT_TAIL_BYTES): string | null {
  if (text == null) return null;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  return buf.subarray(buf.length - max).toString("utf8").replace(/^�+/, "");
}

export function startRun(l: Ledger, jobId: string, at?: string): number {
  return tx(l, () => {
    ensureJob(l, jobId);
    const started = at ?? nowIso();
    const res = l.db.prepare("INSERT INTO runs(job_id, started_at, status) VALUES(?, ?, 'running')").run(jobId, started);
    // wrapped: tango-run reports this job's runs, so the tick does not infer them from launchd.
    l.db
      .prepare("UPDATE jobs SET last_status = 'running', facts = json_set(COALESCE(facts, '{}'), '$.wrapped', json('true')) WHERE id = ?")
      .run(jobId);
    return Number(res.lastInsertRowid);
  });
}

function getRun(l: Ledger, id: number): RunRow | null {
  const row = l.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

/** Failed runs in a row, newest first, counting this one. Quiet runs neither break nor extend the streak. */
function failureStreak(l: Ledger, jobId: string): number {
  const rows = l.db
    .prepare("SELECT status FROM runs WHERE job_id = ? AND status IN ('ok', 'failed') ORDER BY started_at DESC, id DESC LIMIT 50")
    .all(jobId) as Array<{ status: string }>;
  let n = 0;
  for (const r of rows) {
    if (r.status !== "failed") break;
    n += 1;
  }
  return n;
}

export interface RunOutcomeOptions {
  /** Event source; tango-run by default. */
  source?: string;
  /** When the outcome happened (ingested history uses the run's own time). */
  at?: string;
}

/**
 * After a run finishes: update the job, then apply the thresholds. A failure
 * becomes a `run.failed` event once the streak reaches the criticality's
 * threshold (critical 1, normal 2, quiet never). A success after open failure
 * incidents records a recovery, which resolves `run.failed`, `job.late` and
 * `job.restarting`.
 */
export function applyRunOutcome(l: Ledger, run: RunRow, opts: RunOutcomeOptions = {}): { eventId: number | null; incidentId: number | null } {
  const at = opts.at ?? run.finishedAt ?? nowIso();
  const source = opts.source ?? "tango-run";
  const job = getJob(l, run.jobId);
  if (job) {
    l.db
      .prepare("UPDATE jobs SET last_run_at = ?, last_status = ?, last_exit = ? WHERE id = ? AND (last_run_at IS NULL OR last_run_at <= ?)")
      .run(run.startedAt, run.status, run.exitCode, job.id, run.startedAt);
  }
  const name = job?.name ?? run.jobId;
  if (run.status === "failed") {
    const crit = job?.criticality ?? "normal";
    const failAfter = typeof job?.facts.failAfter === "number" ? (job.facts.failAfter as number) : undefined;
    const threshold = failThreshold(crit, failAfter !== undefined ? { failAfter } : undefined);
    const streak = failureStreak(l, run.jobId);
    if (streak < threshold) return { eventId: null, incidentId: null };
    const detail = [
      run.exitCode != null ? `exit ${run.exitCode}` : null,
      streak > 1 ? `${streak} failures in a row` : null,
      run.summary,
      run.outputTail ? run.outputTail.split("\n").slice(-12).join("\n") : null,
    ]
      .filter(Boolean)
      .join("\n");
    const r = recordEvent(l, {
      source,
      kind: "run.failed",
      severity: crit === "critical" ? "critical" : "error",
      title: `${name} failed`,
      jobId: run.jobId,
      detail: detail || undefined,
      data: { runId: run.id, exitCode: run.exitCode, streak, sourceRef: run.sourceRef },
      at,
    });
    return { eventId: r.eventId, incidentId: r.incidentId };
  }
  if (run.status === "ok" || run.status === "quiet") {
    if (!hasOpenIncidentOfKind(l, run.jobId, RESOLVED_BY_SUCCESS)) return { eventId: null, incidentId: null };
    const r = recordEvent(l, {
      source,
      kind: "run.ok",
      severity: "recovery",
      title: `${name} recovered`,
      jobId: run.jobId,
      data: { runId: run.id, sourceRef: run.sourceRef },
      at,
    });
    return { eventId: r.eventId, incidentId: r.incidentId };
  }
  return { eventId: null, incidentId: null };
}

export function finishRun(
  l: Ledger,
  runId: number,
  r: { status: "ok" | "quiet" | "failed"; exitCode?: number; summary?: string; outputTail?: string },
): void {
  tx(l, () => {
    const run = getRun(l, runId);
    if (!run) return;
    const finished = nowIso();
    const duration = Math.max(0, Date.parse(finished) - Date.parse(run.startedAt));
    l.db
      .prepare("UPDATE runs SET finished_at = ?, status = ?, exit_code = ?, duration_ms = ?, summary = ?, output_tail = ? WHERE id = ?")
      .run(finished, r.status, r.exitCode ?? null, duration, r.summary ?? null, tailBytes(r.outputTail), runId);
    applyRunOutcome(l, getRun(l, runId)!, { at: finished });
  });
}

/** A run that is already over (ingested history). Idempotent on sourceRef. */
export function recordRun(
  l: Ledger,
  r: {
    jobId: string;
    startedAt: string;
    finishedAt?: string | null;
    status: RunRow["status"];
    exitCode?: number | null;
    durationMs?: number | null;
    summary?: string | null;
    outputTail?: string | null;
    sourceRef?: string | null;
  },
  opts: RunOutcomeOptions = {},
): number | null {
  return tx(l, () => {
    if (r.sourceRef && l.db.prepare("SELECT 1 FROM runs WHERE source_ref = ?").get(r.sourceRef)) return null;
    ensureJob(l, r.jobId);
    const res = l.db
      .prepare(
        "INSERT INTO runs(job_id, started_at, finished_at, status, exit_code, duration_ms, summary, output_tail, source_ref) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        r.jobId,
        r.startedAt,
        r.finishedAt ?? null,
        r.status,
        r.exitCode ?? null,
        r.durationMs ?? null,
        r.summary ?? null,
        tailBytes(r.outputTail),
        r.sourceRef ?? null,
      );
    const id = Number(res.lastInsertRowid);
    if (r.status !== "running") applyRunOutcome(l, getRun(l, id)!, { source: opts.source ?? "tick", at: opts.at ?? r.finishedAt ?? r.startedAt });
    return id;
  });
}
