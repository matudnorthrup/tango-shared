import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";

dotenv.config();

type TurnRow = {
  id: string;
  createdAt: string;
  sessionId: string;
  agentId: string;
  routeOutcome: "executed" | "clarification" | "fallback";
  responseMessageId: number | null;
  responseText: string | null;
  hasWriteOperations: number;
  receiptsJson: string | null;
};

type ActiveTaskRow = {
  id: string;
  sessionId: string;
  agentId: string;
  status: string;
  title: string;
  objective: string;
  updatedAt: string;
};

type ParsedReceipt = {
  warnings: string[];
  hasWriteOperations: boolean;
  operations: Array<Record<string, unknown>>;
  data: Record<string, unknown>;
};

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

function parseReceipts(receiptsJson: string | null): ParsedReceipt[] {
  if (!receiptsJson) return [];
  try {
    const parsed = JSON.parse(receiptsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((receipt) => {
      const record = receipt && typeof receipt === "object" && !Array.isArray(receipt)
        ? receipt as Record<string, unknown>
        : {};
      const warnings = Array.isArray(record.warnings)
        ? record.warnings.filter((warning): warning is string => typeof warning === "string")
        : [];
      const operations = Array.isArray(record.operations)
        ? record.operations.filter((operation): operation is Record<string, unknown> =>
          Boolean(operation) && typeof operation === "object" && !Array.isArray(operation))
        : [];
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : {};
      return {
        warnings,
        hasWriteOperations: record.hasWriteOperations === true,
        operations,
        data,
      };
    });
  } catch {
    return [];
  }
}

function extractWarnings(receipts: readonly ParsedReceipt[]): string[] {
  return [...new Set(receipts.flatMap((receipt) => receipt.warnings))];
}

function extractRuntimeReplayFlags(receipts: readonly ParsedReceipt[]): string[] {
  const flags = new Set<string>();
  for (const receipt of receipts) {
    const workerText = receipt.data["workerText"];
    if (typeof workerText !== "string" || workerText.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(workerText) as Record<string, unknown>;
      const replay = parsed.runtimeReplay;
      if (!replay || typeof replay !== "object" || Array.isArray(replay)) {
        continue;
      }
      if ((replay as Record<string, unknown>).diaryWriteRecovered === true) {
        flags.add("diaryWriteRecovered");
      }
      if ((replay as Record<string, unknown>).diaryRefreshRecovered === true) {
        flags.add("diaryRefreshRecovered");
      }
    } catch {
      // ignore non-JSON worker text
    }
  }
  return [...flags];
}

function hasSuccessfulWriteOperation(receipts: readonly ParsedReceipt[]): boolean {
  return receipts.some((receipt) =>
    receipt.hasWriteOperations && receipt.operations.some((operation) => {
      if (operation.name !== "fatsecret_api") {
        return false;
      }
      const input = operation.input;
      const output = operation.output;
      const method = input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>).method
        : null;
      if (typeof method !== "string" || !/^food_entry_(create|edit|delete)$/u.test(method)) {
        return false;
      }
      if (!output || typeof output !== "object" || Array.isArray(output)) {
        return false;
      }
      const record = output as Record<string, unknown>;
      return record.ok === true || (typeof record.value === "string" && record.value.trim().length > 0);
    }),
  );
}

function responseSuggestsSuccess(text: string | null): boolean {
  return typeof text === "string"
    && /\blocked now\b|\bwent in\b|\bshould finally show\b|\blogged\b|\brepaired\b|\bpatched\b|\bfixed\b|\bstuck in fatsecret\b/iu.test(text);
}

function responseSuggestsFailure(text: string | null): boolean {
  return typeof text === "string"
    && /\bcould not\b|\bcan't\b|\bdid not stick\b|\bblocked\b|\bcancelled\b|\bcould not be verified\b|\bunconfirmed\b|\bno dice\b/iu.test(text);
}

function isSevereWarning(warning: string): boolean {
  return /\bcancelled\b|\bblocked result\b|\bcould not be verified\b|\bremain unconfirmed\b|\bdid not stick\b|\bno .*writes were performed\b/iu.test(warning);
}

function responseAcknowledgesWarning(text: string | null, warning: string): boolean {
  if (typeof text !== "string" || text.trim().length === 0) {
    return false;
  }

  const normalizedText = text.toLowerCase();
  const normalizedWarning = warning.toLowerCase();

  if (
    normalizedWarning.includes("could not be verified")
    || normalizedWarning.includes("cannot be stated precisely")
    || normalizedWarning.includes("incomplete category rollup")
    || normalizedWarning.includes("incomplete in this environment")
    || normalizedWarning.includes("incomplete budget")
  ) {
    return /\bcaveat\b|\bincomplete\b|\bcan't give\b|\bcannot give\b|\bstrict\b|\bwithout making it up\b|\bcan't verify\b|\bcannot verify\b|\bcould not verify\b|\bnot be verified\b|\bcannot be stated precisely\b/u
      .test(normalizedText);
  }

  if (normalizedWarning.includes("completed_with_limitations") || normalizedWarning.includes("partial")) {
    return /\blimit(?:ation|ations)?\b|\bpartial\b|\bincomplete\b|\bcaveat\b/u.test(normalizedText);
  }

  return false;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function main(): void {
  const db = new DatabaseSync(getDbPath(), { readOnly: true });
  const limit = Number.parseInt(getArg("--limit") ?? "30", 10);
  const sessionId = getArg("--session");
  const agentId = getArg("--agent");

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

  const turnRows = db.prepare(
    `SELECT
       dt.id AS id,
       dt.created_at AS createdAt,
       dt.session_id AS sessionId,
       dt.agent_id AS agentId,
       dt.route_outcome AS routeOutcome,
       dt.response_message_id AS responseMessageId,
       msg.content AS responseText,
       dt.has_write_operations AS hasWriteOperations,
       dt.receipts_json AS receiptsJson
     FROM deterministic_turns dt
     LEFT JOIN messages msg ON msg.id = dt.response_message_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY dt.created_at DESC, dt.rowid DESC
     LIMIT ?`,
  ).all(...params, Number.isFinite(limit) && limit > 0 ? limit : 30) as TurnRow[];

  const activeTaskRows = db.prepare(
    `SELECT
       id,
       session_id AS sessionId,
       agent_id AS agentId,
       status,
       title,
       objective,
       updated_at AS updatedAt
     FROM active_tasks
     WHERE status = 'blocked'
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(Math.max(limit, 20)) as ActiveTaskRow[];

  const incidents: string[] = [];
  const recoveredWrites: string[] = [];

  for (const row of turnRows) {
    const receipts = parseReceipts(row.receiptsJson);
    const warnings = extractWarnings(receipts);
    const severeWarnings = warnings.filter((warning) => isSevereWarning(warning));
    const unacknowledgedSevereWarnings = severeWarnings.filter((warning) =>
      !responseAcknowledgesWarning(row.responseText, warning)
    );
    const replayFlags = extractRuntimeReplayFlags(receipts);
    const successfulWrites = hasSuccessfulWriteOperation(receipts);

    if (replayFlags.length > 0) {
      recoveredWrites.push(
        `[${row.createdAt}] ${row.agentId} ${row.sessionId} id=${row.id} replay=${replayFlags.join(",")}`,
      );
    }

    if (responseSuggestsSuccess(row.responseText) && unacknowledgedSevereWarnings.length > 0) {
      incidents.push(
        `[reply/receipt mismatch: success-with-warnings] ${row.id} ${row.agentId} ${row.sessionId} ` +
        `reply=${truncate(row.responseText ?? "", 180)} warnings=${unacknowledgedSevereWarnings.join(" | ")}`,
      );
    }

    if (responseSuggestsFailure(row.responseText) && (replayFlags.length > 0 || successfulWrites)) {
      incidents.push(
        `[reply/receipt mismatch: failure-with-recovery] ${row.id} ${row.agentId} ${row.sessionId} ` +
        `reply=${truncate(row.responseText ?? "", 180)} replay=${replayFlags.join(",") || "-"} writes=${successfulWrites ? "yes" : "no"}`,
      );
    }

    if (warnings.some((warning) => /cancelled MCP tool call/iu.test(warning))) {
      incidents.push(
        `[provider-cancelled-tool] ${row.id} ${row.agentId} ${row.sessionId} warnings=${truncate(warnings.join(" | "), 220)}`,
      );
    }
  }

  for (const task of activeTaskRows) {
    const latestTurn = turnRows.find((row) => row.sessionId === task.sessionId && row.agentId === task.agentId);
    if (!latestTurn) continue;
    const receipts = parseReceipts(latestTurn.receiptsJson);
    const warnings = extractWarnings(receipts);
    const severeWarnings = warnings.filter((warning) => isSevereWarning(warning));
    const replayFlags = extractRuntimeReplayFlags(receipts);
    const successfulWrites = hasSuccessfulWriteOperation(receipts);
    const recoveredCommittedWrite = replayFlags.includes("diaryWriteRecovered");
    if (successfulWrites || recoveredCommittedWrite || responseSuggestsSuccess(latestTurn.responseText)) {
      incidents.push(
        `[blocked-task-after-success] task=${task.id} ${task.agentId} ${task.sessionId} ` +
        `title=${truncate(task.title, 80)} latestTurn=${latestTurn.id} replay=${replayFlags.join(",") || "-"} ` +
        `writes=${successfulWrites ? "yes" : "no"} reply=${truncate(latestTurn.responseText ?? "", 160)}`,
      );
    }
  }

  console.log(`db=${getDbPath()}`);
  console.log(`turns_scanned=${turnRows.length}`);
  console.log(`blocked_tasks_scanned=${activeTaskRows.length}`);
  console.log("");

  console.log("Recovered writes:");
  if (recoveredWrites.length === 0) {
    console.log("  (none)");
  } else {
    for (const line of recoveredWrites) {
      console.log(`  ${line}`);
    }
  }

  console.log("");
  console.log("Incidents:");
  if (incidents.length === 0) {
    console.log("  (none)");
  } else {
    for (const line of incidents) {
      console.log(`  ${line}`);
    }
  }
}

main();
