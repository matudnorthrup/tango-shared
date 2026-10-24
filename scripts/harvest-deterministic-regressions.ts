import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";

dotenv.config();

type TurnRow = {
  id: string;
  createdAt: string;
  sessionId: string;
  agentId: string;
  routeOutcome: "executed" | "clarification" | "fallback";
  hasWriteOperations: number;
  intentIds: string | null;
  fallbackReason: string | null;
  receiptsJson: string | null;
  requestText: string | null;
  responseText: string | null;
};

type HarvestedReceipt = {
  warnings: string[];
  workerText: string | null;
  operationNames: string[];
  hasWriteOperations: boolean;
};

type HarvestedCase = {
  turnId: string;
  createdAt: string;
  sessionId: string;
  agentId: string;
  routeOutcome: TurnRow["routeOutcome"];
  hasWriteOperations: boolean;
  intentIds: string[];
  fallbackReason: string | null;
  requestText: string | null;
  responseText: string | null;
  receiptWarnings: string[];
  workerText: string | null;
  operationNames: string[];
};

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseReceipts(receiptsJson: string | null): HarvestedReceipt[] {
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
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : {};
      const operations = Array.isArray(record.operations)
        ? record.operations.filter((operation): operation is Record<string, unknown> =>
          Boolean(operation) && typeof operation === "object" && !Array.isArray(operation))
        : [];
      return {
        warnings,
        workerText: typeof data["workerText"] === "string" ? data["workerText"] : null,
        operationNames: [...new Set(
          operations
            .map((operation) => typeof operation.name === "string" ? operation.name : "")
            .filter((name) => name.length > 0),
        )],
        hasWriteOperations: record.hasWriteOperations === true,
      };
    });
  } catch {
    return [];
  }
}

function looksInteresting(turn: HarvestedCase): boolean {
  if (turn.routeOutcome !== "executed") {
    return true;
  }
  if (turn.fallbackReason) {
    return true;
  }
  if (turn.receiptWarnings.length > 0) {
    return true;
  }
  if (!turn.hasWriteOperations && turn.intentIds.some((intentId) => /\.(?:log|update|repair|maintenance)$/u.test(intentId))) {
    return true;
  }
  return false;
}

function truncate(value: string | null, maxChars = 4000): string | null {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function main(): void {
  const db = new DatabaseSync(getDbPath(), { readOnly: true });
  const limit = Number.parseInt(getArg("--limit") ?? "25", 10);
  const agentId = getArg("--agent");
  const sessionId = getArg("--session");
  const outPath = getArg("--out");
  const includeAll = hasFlag("--all");

  const clauses = ["1 = 1"];
  const params: Array<string | number> = [];
  if (agentId) {
    clauses.push("dt.agent_id = ?");
    params.push(agentId);
  }
  if (sessionId) {
    clauses.push("dt.session_id = ?");
    params.push(sessionId);
  }

  const turnRows = db.prepare(
    `SELECT
       dt.id AS id,
       dt.created_at AS createdAt,
       dt.session_id AS sessionId,
       dt.agent_id AS agentId,
       dt.route_outcome AS routeOutcome,
       dt.has_write_operations AS hasWriteOperations,
       dt.intent_ids AS intentIds,
       dt.fallback_reason AS fallbackReason,
       dt.receipts_json AS receiptsJson,
       request_msg.content AS requestText,
       response_msg.content AS responseText
     FROM deterministic_turns dt
     LEFT JOIN messages request_msg ON request_msg.id = dt.request_message_id
     LEFT JOIN messages response_msg ON response_msg.id = dt.response_message_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY dt.created_at DESC, dt.rowid DESC
     LIMIT ?`,
  ).all(...params, Number.isFinite(limit) && limit > 0 ? limit : 25) as TurnRow[];

  const harvested = turnRows.map((turnRow): HarvestedCase => {
    const receipts = parseReceipts(turnRow.receiptsJson);
    const warnings = [...new Set(receipts.flatMap((receipt) => receipt.warnings))];
    const workerText = receipts.find((receipt) => typeof receipt.workerText === "string" && receipt.workerText.trim().length > 0)?.workerText ?? null;
    const operationNames = [...new Set(receipts.flatMap((receipt) => receipt.operationNames))];
    return {
      turnId: turnRow.id,
      createdAt: turnRow.createdAt,
      sessionId: turnRow.sessionId,
      agentId: turnRow.agentId,
      routeOutcome: turnRow.routeOutcome,
      hasWriteOperations: turnRow.hasWriteOperations === 1 || receipts.some((receipt) => receipt.hasWriteOperations),
      intentIds: parseJsonArray(turnRow.intentIds),
      fallbackReason: turnRow.fallbackReason,
      requestText: truncate(turnRow.requestText),
      responseText: truncate(turnRow.responseText),
      receiptWarnings: warnings,
      workerText: truncate(workerText),
      operationNames,
    };
  });

  const output = includeAll ? harvested : harvested.filter((turn) => looksInteresting(turn));
  const json = JSON.stringify(output, null, 2);

  if (outPath) {
    const resolvedOutPath = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
    fs.writeFileSync(resolvedOutPath, `${json}\n`, "utf8");
    console.log(`wrote=${resolvedOutPath}`);
  }

  console.log(`db=${getDbPath()}`);
  console.log(`turns_scanned=${turnRows.length}`);
  console.log(`cases_emitted=${output.length}`);
  if (!outPath) {
    console.log(json);
  }
}

main();
