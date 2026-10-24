import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { toIso } from "./context.js";
import { hasOpenIncidentOfKind, recordEvent } from "./incidents.js";
import { getJob } from "./jobs.js";
import { getCursor, setCursor, tx } from "./ledger.js";
import { recordRun } from "./runs.js";
import type { Ledger, RunRow } from "./types.js";

export const SCHEDULE_CURSOR = "schedule_runs";
const STATUS: Record<string, RunRow["status"]> = { ok: "ok", skipped: "quiet", error: "failed" };
/** A first ingestion starts this far back instead of replaying all history. */
const FIRST_LOOKBACK_MS = 2 * 86_400_000;
/** A row still 'running' after this long is stale (the bot died mid-run); ingestion moves past it. */
const STALE_RUNNING_MS = 6 * 3_600_000;

interface ScheduleRunRow {
  id: number;
  schedule_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  duration_ms: number | null;
  error: string | null;
  summary: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
}

/**
 * Copies new `schedule_runs` rows into `runs` (ok → ok, skipped → quiet,
 * error → failed), applying thresholds and recoveries, and turns failed
 * deliveries into `delivery.failed` events. Stops at a row still running so it
 * is picked up once it finishes.
 */
export function ingestScheduleRuns(l: Ledger, tangoDbPath: string, opts: { now?: Date; batch?: number } = {}): { ingested: number; cursor: number } {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 5000;
  if (!fs.existsSync(tangoDbPath)) return { ingested: 0, cursor: Number(getCursor(l, SCHEDULE_CURSOR) ?? 0) };
  const src = new DatabaseSync(tangoDbPath, { readOnly: true });
  try {
    src.exec("PRAGMA busy_timeout = 3000;");
    let cursor = Number(getCursor(l, SCHEDULE_CURSOR) ?? NaN);
    if (!Number.isFinite(cursor)) {
      const since = new Date(now.getTime() - FIRST_LOOKBACK_MS).toISOString();
      const row = src.prepare("SELECT MIN(id) AS id FROM schedule_runs WHERE started_at >= ?").get(since) as { id: number | null };
      const max = src.prepare("SELECT MAX(id) AS id FROM schedule_runs").get() as { id: number | null };
      cursor = row.id != null ? row.id - 1 : (max.id ?? 0);
    }
    const rows = src
      .prepare(
        "SELECT id, schedule_id, started_at, finished_at, status, duration_ms, error, summary, delivery_status, delivery_error FROM schedule_runs WHERE id > ? ORDER BY id LIMIT ?",
      )
      .all(cursor, batch) as unknown as ScheduleRunRow[];
    let ingested = 0;
    tx(l, () => {
      for (const r of rows) {
        const startedAt = toIso(r.started_at) ?? now.toISOString();
        if (r.status === "running") {
          if (now.getTime() - Date.parse(startedAt) < STALE_RUNNING_MS) break;
          cursor = r.id;
          continue;
        }
        const jobId = `schedule:${r.schedule_id}`;
        const finishedAt = toIso(r.finished_at) ?? startedAt;
        const status = STATUS[r.status] ?? "failed";
        recordRun(
          l,
          {
            jobId,
            startedAt,
            finishedAt,
            status,
            durationMs: r.duration_ms,
            summary: (status === "failed" ? r.error || r.summary : r.summary || r.error) ?? null,
            sourceRef: `schedule_runs:${r.id}`,
          },
          { source: "scheduler", at: finishedAt },
        );
        const name = getJob(l, jobId)?.name ?? r.schedule_id;
        if (r.delivery_status === "failed") {
          recordEvent(l, {
            source: "scheduler",
            kind: "delivery.failed",
            severity: "error",
            title: `${name} delivery failed`,
            jobId,
            detail: r.delivery_error ?? undefined,
            data: { sourceRef: `schedule_runs:${r.id}` },
            at: finishedAt,
          });
        } else if (r.delivery_status === "delivered" && hasOpenIncidentOfKind(l, jobId, ["delivery.failed"])) {
          recordEvent(l, { source: "scheduler", kind: "delivery.ok", severity: "recovery", title: `${name} delivered again`, jobId, at: finishedAt });
        }
        cursor = r.id;
        ingested += 1;
      }
      setCursor(l, SCHEDULE_CURSOR, String(cursor));
    });
    return { ingested, cursor };
  } finally {
    src.close();
  }
}
