/**
 * v2-turn-evidence.ts — Shared helpers for live smoke scripts to assert on
 * what the v2 runtime records per turn.
 *
 * The deterministic intent pipeline (and its deterministic_turns table) was
 * retired on 2026-05-25 ("Retire legacy Tango runtime paths"); that table has
 * been frozen since 2026-04-28. v2 turns persist an outbound `messages` row
 * whose metadata carries the runtime path, latency, and invoked tool names
 * (`toolsUsed` on the voice-bridge path, `runtimeToolsUsed` on the Discord
 * message path). Smoke assertions read that row instead. See TGO-716.
 */
import type { DatabaseSync } from "node:sqlite";

export interface V2TurnEvidence {
  messageId: number;
  responseText: string;
  toolsUsed: string[];
  runtimePath: string | null;
  latencyMs: number | null;
  runtimeStderr: string | null;
  createdAt: string;
}

interface OutboundMessageRow {
  id: number;
  content: string | null;
  metadataJson: string | null;
  createdAt: string;
}

export function latestOutboundMessageId(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
): number {
  const row = db.prepare(
    `SELECT id
     FROM messages
     WHERE session_id = ? AND agent_id = ? AND direction = 'outbound'
     ORDER BY id DESC
     LIMIT 1`,
  ).get(sessionId, agentId) as { id: number } | undefined;
  return row?.id ?? 0;
}

function parseEvidence(row: OutboundMessageRow): V2TurnEvidence {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = row.metadataJson ? JSON.parse(row.metadataJson) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // Unparseable metadata stays empty; tool assertions on it fail loudly.
  }
  const toolsRaw = metadata["toolsUsed"] ?? metadata["runtimeToolsUsed"];
  const toolsUsed = Array.isArray(toolsRaw)
    ? toolsRaw.filter((name): name is string => typeof name === "string")
    : [];
  const runtimePath = typeof metadata["runtime"] === "string"
    ? metadata["runtime"]
    : typeof metadata["runtimePath"] === "string"
      ? metadata["runtimePath"]
      : null;
  return {
    messageId: row.id,
    responseText: (row.content ?? "").trim(),
    toolsUsed,
    runtimePath,
    latencyMs: typeof metadata["latencyMs"] === "number" ? metadata["latencyMs"] : null,
    runtimeStderr: typeof metadata["runtimeStderr"] === "string" ? metadata["runtimeStderr"] : null,
    createdAt: row.createdAt,
  };
}

export function loadV2TurnEvidence(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  afterMessageId: number,
): V2TurnEvidence | null {
  const row = db.prepare(
    `SELECT id, content, metadata_json AS metadataJson, created_at AS createdAt
     FROM messages
     WHERE session_id = ? AND agent_id = ? AND direction = 'outbound' AND id > ?
     ORDER BY id ASC
     LIMIT 1`,
  ).get(sessionId, agentId, afterMessageId) as OutboundMessageRow | undefined;
  return row ? parseEvidence(row) : null;
}

export async function waitForV2TurnEvidence(input: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  afterMessageId: number;
  timeoutMs?: number;
}): Promise<V2TurnEvidence | null> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 180_000;
  while (Date.now() - startedAt < timeoutMs) {
    const evidence = loadV2TurnEvidence(input.db, input.sessionId, input.agentId, input.afterMessageId);
    if (evidence) return evidence;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Match an expected operation name against recorded tool names. v2 records
 * MCP tools as `mcp__<server>__<tool>` while cases name bare tools
 * ("workout_sql", "find_diesel").
 */
export function toolUsedMatches(toolsUsed: string[], expected: string): boolean {
  return toolsUsed.some((name) => name === expected || name.endsWith(`__${expected}`));
}

export function deprecatedExpectationNote(scriptTag: string, caseId: string, fields: string[]): void {
  if (fields.length === 0) return;
  console.log(
    `[${scriptTag}] case=${caseId} skipped legacy deterministic expectations (${fields.join(", ")}) — the v2 runtime has no intent pipeline (TGO-716)`,
  );
}
