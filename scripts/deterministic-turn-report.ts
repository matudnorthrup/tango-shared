import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";

dotenv.config();

type Row = {
  id: string;
  createdAt: string;
  sessionId: string;
  agentId: string;
  routeOutcome: "executed" | "clarification" | "fallback";
  fallbackReason: string | null;
  intentIdsJson: string | null;
  workerIdsJson: string | null;
  completedStepCount: number;
  failedStepCount: number;
  hasWriteOperations: number;
  intentLatencyMs: number | null;
  routeLatencyMs: number | null;
  executionLatencyMs: number | null;
  totalLatencyMs: number | null;
  intentProviderName: string | null;
  intentModel: string | null;
  narrationProviderName: string | null;
  narrationModel: string | null;
  receiptsJson: string | null;
};

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseWarnings(receiptsJson: string | null): string[] {
  if (!receiptsJson) return [];
  try {
    const parsed = JSON.parse(receiptsJson);
    if (!Array.isArray(parsed)) return [];
    const warnings = parsed.flatMap((receipt) => {
      if (!receipt || typeof receipt !== "object") return [];
      const value = (receipt as Record<string, unknown>)["warnings"];
      return Array.isArray(value) ? value.filter((warning): warning is string => typeof warning === "string") : [];
    });
    return [...new Set(warnings)];
  } catch {
    return [];
  }
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`;
}

function main(): void {
  const db = new DatabaseSync(getDbPath(), { readOnly: true });
  const sessionId = getArg("--session");
  const agentId = getArg("--agent");
  const routeOutcome = getArg("--outcome");
  const warningsOnly = process.argv.includes("--warnings-only");
  const limit = Number.parseInt(getArg("--limit") ?? "20", 10);

  const clauses = ["1 = 1"];
  const params: Array<string | number> = [];
  if (sessionId) {
    clauses.push("dt.session_id = ?");
    params.push(sessionId);
  }
  if (agentId) {
    clauses.push("dt.agent_id = ?");
    params.push(agentId);
  }
  if (routeOutcome) {
    clauses.push("dt.route_outcome = ?");
    params.push(routeOutcome);
  }

  const rows = db.prepare(
    `
      SELECT
        dt.id AS id,
        dt.created_at AS createdAt,
        dt.session_id AS sessionId,
        dt.agent_id AS agentId,
        dt.route_outcome AS routeOutcome,
        dt.fallback_reason AS fallbackReason,
        dt.intent_ids AS intentIdsJson,
        dt.worker_ids AS workerIdsJson,
        dt.completed_step_count AS completedStepCount,
        dt.failed_step_count AS failedStepCount,
        dt.has_write_operations AS hasWriteOperations,
        dt.intent_latency_ms AS intentLatencyMs,
        dt.route_latency_ms AS routeLatencyMs,
        dt.execution_latency_ms AS executionLatencyMs,
        dt.total_latency_ms AS totalLatencyMs,
        imr.provider_name AS intentProviderName,
        imr.model AS intentModel,
        nmr.provider_name AS narrationProviderName,
        nmr.model AS narrationModel,
        dt.receipts_json AS receiptsJson
      FROM deterministic_turns dt
      LEFT JOIN model_runs imr ON imr.id = dt.intent_model_run_id
      LEFT JOIN model_runs nmr ON nmr.id = dt.narration_model_run_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY dt.created_at DESC, dt.rowid DESC
      LIMIT ?
    `,
  ).all(...params, Number.isFinite(limit) && limit > 0 ? limit : 20) as Row[];

  const filteredRows = warningsOnly
    ? rows.filter((row) => parseWarnings(row.receiptsJson).length > 0)
    : rows;

  console.log(`db=${getDbPath()}`);
  console.log(`rows=${filteredRows.length}`);

  for (const row of filteredRows) {
    const intents = parseJsonArray(row.intentIdsJson);
    const workers = parseJsonArray(row.workerIdsJson);
    const warnings = parseWarnings(row.receiptsJson);
    console.log("");
    console.log(`[${row.createdAt}] ${row.agentId} ${row.sessionId}`);
    console.log(`  id=${row.id}`);
    console.log(`  outcome=${row.routeOutcome} intents=${intents.join(",") || "-"} workers=${workers.join(",") || "-"} writes=${row.hasWriteOperations === 1 ? "yes" : "no"}`);
    console.log(`  classifier=${row.intentProviderName ?? "-"}:${row.intentModel ?? "-"} narration=${row.narrationProviderName ?? "-"}:${row.narrationModel ?? "-"}`);
    console.log(`  latency intent=${formatMs(row.intentLatencyMs)} route=${formatMs(row.routeLatencyMs)} execution=${formatMs(row.executionLatencyMs)} total=${formatMs(row.totalLatencyMs)}`);
    console.log(`  steps completed=${row.completedStepCount} failed=${row.failedStepCount}`);
    if (row.fallbackReason) {
      console.log(`  fallbackReason=${row.fallbackReason}`);
    }
    if (warnings.length > 0) {
      console.log(`  warnings=${warnings.join(" | ")}`);
    }
  }
}

main();
