import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";
import { ensureSmokeThread } from "./discord-smoke-thread.js";

dotenv.config();

type VoiceTurnHttpResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  responseText?: string;
  providerName?: string;
  providerUsedFailover?: boolean;
  warmStartUsed?: boolean;
};

type DeterministicTurnReceipt = {
  workerId?: string;
  status?: string;
  operations?: Array<{ name?: string }>;
};

type DeterministicTurnRow = {
  id: string;
  routeOutcome: string;
  workerIds: string[];
  receipts: DeterministicTurnReceipt[];
  createdAt: string;
} | null;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getNumberArg(flag: string, fallback: number): number {
  const value = getArg(flag);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBridgeBaseUrl(): string {
  const host = process.env["TANGO_VOICE_BRIDGE_HOST"]?.trim() || "127.0.0.1";
  const port = process.env["TANGO_VOICE_BRIDGE_PORT"]?.trim() || "8787";
  return `http://${host}:${port}`;
}

function getBridgeHeaders(): Record<string, string> {
  const apiKey = process.env["TANGO_VOICE_BRIDGE_API_KEY"]?.trim();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
  }
  return JSON.parse(text) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

function loadLatestDeterministicTurn(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
): DeterministicTurnRow {
  const row = db.prepare(
    `SELECT
       id,
       route_outcome AS routeOutcome,
       worker_ids AS workerIdsJson,
       receipts_json AS receiptsJson,
       created_at AS createdAt
     FROM deterministic_turns
     WHERE session_id = ? AND agent_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).get(sessionId, agentId) as {
    id: string;
    routeOutcome: string;
    workerIdsJson: string | null;
    receiptsJson: string | null;
    createdAt: string;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    routeOutcome: row.routeOutcome,
    workerIds: parseJson<string[]>(row.workerIdsJson) ?? [],
    receipts: parseJson<DeterministicTurnReceipt[]>(row.receiptsJson) ?? [],
    createdAt: row.createdAt,
  };
}

function countSubAgentRuns(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM sub_agent_runs
     WHERE parent_session_id = ?`
  ).get(sessionId) as { count: number | bigint };

  return typeof row.count === "bigint" ? Number(row.count) : row.count;
}

function loadRecentSubAgentStatuses(
  db: DatabaseSync,
  sessionId: string,
  limit: number,
): Array<{ subTaskId: string; status: string; providerName: string | null; toolIds: string[] }> {
  if (limit <= 0) {
    return [];
  }

  const rows = db.prepare(
    `SELECT
       sub_task_id AS subTaskId,
       status,
       provider_name AS providerName,
       tool_ids AS toolIdsJson
     FROM sub_agent_runs
     WHERE parent_session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).all(sessionId, limit) as Array<{
    subTaskId: string;
    status: string;
    providerName: string | null;
    toolIdsJson: string | null;
  }>;

  return rows.map((row) => ({
    subTaskId: row.subTaskId,
    status: row.status,
    providerName: row.providerName,
    toolIds: parseJson<string[]>(row.toolIdsJson) ?? [],
  }));
}

async function waitForDeterministicTurn(input: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  previousId: string | null;
  timeoutMs: number;
}): Promise<DeterministicTurnRow> {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < input.timeoutMs) {
    const latest = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
    if (latest && latest.id !== input.previousId) {
      return latest;
    }
    await sleep(250);
  }
  return null;
}

async function main(): Promise<void> {
  // Every assertion in this smoke targets the legacy deterministic sub-agent
  // coordinator (deterministic_turns rows, spawn_sub_agents operations,
  // sub_agent_runs accounting), all retired with the v2 runtime on 2026-05-25
  // ("Retire legacy Tango runtime paths"). Running it can only fail. Exit
  // explicitly instead of reporting a misleading timeout. See TGO-716.
  console.error(
    "[subagent-smoke] DEPRECATED: the deterministic sub-agent pipeline was retired with the v2 runtime (2026-05-25); "
    + "these assertions have no v2 equivalent. See TGO-716 for the v2 smoke strategy.",
  );
  process.exit(2);

  const baseUrl = getBridgeBaseUrl();
  const headers = getBridgeHeaders();
  const sessionId = getArg("--session") ?? "sierra-live-subagent-smoke";
  const agentId = getArg("--agent") ?? "sierra";
  const transcript =
    getArg("--transcript")
    ?? "Do a deep dive on PLA food safety for kitchen use. Cover regulatory guidance, academic evidence, and practical caveats.";
  const requestedChannelId = getArg("--channel");
  const threadName = getArg("--thread-name") ?? "codex-sierra-live-subagent-smoke";
  const discordUserId = getArg("--user") ?? "live-smoke";
  const timeoutMs = getNumberArg("--timeout-ms", 240_000);
  const token = process.env["DISCORD_TOKEN"]?.trim();
  const channelId = token
    ? await ensureSmokeThread({
      token,
      agentId,
      explicitChannelId: requestedChannelId,
      explicitThreadName: threadName,
    })
    : requestedChannelId;

  console.log(`[subagent-smoke] bridge=${baseUrl}`);
  console.log(`[subagent-smoke] db=${getDbPath()}`);
  console.log(`[subagent-smoke] session=${sessionId} agent=${agentId} channel=${channelId ?? "(none)"}`);
  console.log(`[subagent-smoke] transcript=${JSON.stringify(transcript)}`);

  const health = await fetchJson<{ ok: boolean; status: string }>(`${baseUrl}/health`, {
    headers,
  });
  console.log(`[subagent-smoke] health ok=${health.ok} status=${health.status}`);

  const db = new DatabaseSync(getDbPath());
  try {
    const beforeTurn = loadLatestDeterministicTurn(db, sessionId, agentId);
    const beforeSubAgentCount = countSubAgentRuns(db, sessionId);

    console.log(
      `[subagent-smoke] previous deterministic turn=${beforeTurn?.id ?? "(none)"} ` +
      `previousSubAgentCount=${beforeSubAgentCount}`,
    );

    const response = await fetchJson<VoiceTurnHttpResponse>(`${baseUrl}/voice/turn`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        agentId,
        transcript,
        channelId,
        discordUserId,
      }),
    });

    console.log(
      `[subagent-smoke] response ok=${response.ok} provider=${response.providerName ?? "-"} ` +
      `failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
    );
    console.log(`[subagent-smoke] responseText=${JSON.stringify(response.responseText ?? "")}`);

    const latestTurn = await waitForDeterministicTurn({
      db,
      sessionId,
      agentId,
      previousId: beforeTurn?.id ?? null,
      timeoutMs,
    });
    if (!latestTurn) {
      throw new Error("Timed out waiting for a deterministic_turns row.");
    }

    const operationNames = latestTurn.receipts.flatMap((receipt) =>
      (receipt.operations ?? [])
        .map((operation) => operation?.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const totalSubAgentCount = countSubAgentRuns(db, sessionId);
    const newSubAgentCount = Math.max(totalSubAgentCount - beforeSubAgentCount, 0);
    const recentSubAgents = loadRecentSubAgentStatuses(db, sessionId, newSubAgentCount);

    console.log(
      `[subagent-smoke] deterministicTurn=${latestTurn.id} route=${latestTurn.routeOutcome} ` +
      `workers=${latestTurn.workerIds.join(",") || "-"} ops=${operationNames.join(",") || "-"} ` +
      `subAgents=${recentSubAgents.length}`,
    );
    console.log(
      `[subagent-smoke] subAgentStatuses=${recentSubAgents.map((row) =>
        `${row.subTaskId}:${row.status}:${row.providerName ?? "-"}:${row.toolIds.join("+") || "-"}`
      ).join(" | ") || "-"}`,
    );

    if (latestTurn.routeOutcome !== "executed") {
      throw new Error(`Expected executed route, got ${latestTurn.routeOutcome}`);
    }
    if (!latestTurn.workerIds.includes("research-coordinator")) {
      throw new Error(`Expected research-coordinator worker, got ${latestTurn.workerIds.join(",") || "(none)"}`);
    }
    if (!operationNames.includes("spawn_sub_agents")) {
      throw new Error(`Expected spawn_sub_agents operation, got ${operationNames.join(",") || "(none)"}`);
    }
    if (recentSubAgents.length < 2) {
      throw new Error(`Expected at least 2 persisted sub-agent runs, got ${recentSubAgents.length}`);
    }
    if (recentSubAgents.some((row) => row.status !== "completed")) {
      throw new Error(`Expected all sub-agent runs to complete, got ${recentSubAgents.map((row) => `${row.subTaskId}:${row.status}`).join(", ")}`);
    }
    if (!recentSubAgents.every((row) => row.toolIds.length > 0)) {
      throw new Error("Expected persisted sub-agent rows to include tool ids.");
    }
    if (!response.responseText || !/pla|food|kitchen|contact/i.test(response.responseText)) {
      throw new Error(`Response text did not look like deep PLA research: ${response.responseText ?? "(empty)"}`);
    }

    console.log("[subagent-smoke] live sub-agent research validation passed");
  } finally {
    db.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[subagent-smoke] failed: ${message}`);
  process.exitCode = 1;
});
