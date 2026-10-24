import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { loadV2AgentConfig, resolveConfiguredPath } from "@tango/core";
import { openAtlasMemoryDatabase } from "@tango/atlas-memory";
import { AtlasMemoryClient } from "./atlas-memory-client.js";

interface ReflectionTargetRow {
  session_id: string;
  agent_id: string;
  last_source_at: string;
  covers_through: string | null;
}

export interface AtlasScheduledReflectionOptions {
  dbPath?: string;
  lookbackHours?: number;
  sessionId?: string;
  agentId?: string;
  v2AgentsDir?: string;
}

export interface AtlasScheduledReflectionResult {
  enabledAgentIds: string[];
  discoveredTargets: number;
  processedTargets: number;
  totalMemoriesCreated: number;
  processed: Array<{
    sessionId: string;
    agentId: string;
    memoriesCreated: number;
    reflections: string[];
    lastSourceAt: string;
    coversThrough: string | null;
  }>;
  errors: Array<{
    sessionId: string;
    agentId: string;
    error: string;
  }>;
}

export async function runAtlasScheduledReflections(
  options: AtlasScheduledReflectionOptions = {},
): Promise<AtlasScheduledReflectionResult> {
  const enabledAgentIds = resolveEnabledReflectionAgents(options.v2AgentsDir);
  const targets = discoverReflectionTargets({
    dbPath: options.dbPath,
    lookbackHours: options.lookbackHours,
    sessionId: options.sessionId,
    agentId: options.agentId,
    enabledAgentIds,
  });
  const client = new AtlasMemoryClient(options.dbPath);
  const processed: AtlasScheduledReflectionResult["processed"] = [];
  const errors: AtlasScheduledReflectionResult["errors"] = [];
  let totalMemoriesCreated = 0;

  try {
    for (const target of targets) {
      try {
        const result = await client.memoryReflect({
          session_id: target.session_id,
          agent_id: target.agent_id,
        });
        processed.push({
          sessionId: target.session_id,
          agentId: target.agent_id,
          memoriesCreated: result.memories_created,
          reflections: result.reflections,
          lastSourceAt: target.last_source_at,
          coversThrough: target.covers_through,
        });
        totalMemoriesCreated += result.memories_created;
      } catch (error) {
        errors.push({
          sessionId: target.session_id,
          agentId: target.agent_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    client.close();
  }

  return {
    enabledAgentIds,
    discoveredTargets: targets.length,
    processedTargets: processed.length,
    totalMemoriesCreated,
    processed,
    errors,
  };
}

function resolveEnabledReflectionAgents(v2AgentsDir?: string): string[] {
  const agentsDir = resolveConfiguredPath(v2AgentsDir ?? "config/v2/agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const agentIds: string[] = [];
  for (const entry of fs.readdirSync(agentsDir)) {
    if (!entry.endsWith(".yaml")) {
      continue;
    }

    const configPath = path.join(agentsDir, entry);

    try {
      const config = loadV2AgentConfig(configPath);
      if (config.memory.scheduledReflection === "enabled") {
        agentIds.push(config.id);
      }
    } catch (error) {
      console.warn(
        `[atlas-memory-reflection] failed to load ${configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return [...new Set(agentIds)];
}

function discoverReflectionTargets(input: {
  dbPath?: string;
  lookbackHours?: number;
  sessionId?: string;
  agentId?: string;
  enabledAgentIds: string[];
}): ReflectionTargetRow[] {
  const allowedAgentIds =
    input.agentId && input.agentId.trim().length > 0
      ? [input.agentId.trim()]
      : input.enabledAgentIds;

  if (allowedAgentIds.length === 0) {
    return [];
  }

  const { db } = openAtlasMemoryDatabase({
    ...(input.dbPath ? { dbPath: input.dbPath } : {}),
  });

  try {
    const sessionExpression = `
      COALESCE(
        json_extract(COALESCE(metadata, '{}'), '$.session_id'),
        json_extract(COALESCE(metadata, '{}'), '$.sessionId')
      )
    `;
    const whereClauses = [
      "archived_at IS NULL",
      "source != 'reflection'",
      "agent_id IS NOT NULL",
      `${sessionExpression} IS NOT NULL`,
    ];
    const params: SQLInputValue[] = [];

    if (typeof input.lookbackHours === "number" && Number.isFinite(input.lookbackHours)) {
      const cutoff = new Date(Date.now() - input.lookbackHours * 3_600_000).toISOString();
      whereClauses.push("created_at >= ?");
      params.push(cutoff);
    }

    if (input.sessionId?.trim()) {
      whereClauses.push(`${sessionExpression} = ?`);
      params.push(input.sessionId.trim());
    }

    whereClauses.push(`agent_id IN (${allowedAgentIds.map(() => "?").join(", ")})`);
    params.push(...allowedAgentIds);

    return db.prepare(`
      WITH recent_sources AS (
        SELECT
          ${sessionExpression} AS session_id,
          agent_id,
          MAX(created_at) AS last_source_at
        FROM memories
        WHERE ${whereClauses.join(" AND ")}
        GROUP BY ${sessionExpression}, agent_id
      )
      SELECT
        recent_sources.session_id,
        recent_sources.agent_id,
        recent_sources.last_source_at,
        conversation_summaries.covers_through
      FROM recent_sources
      LEFT JOIN conversation_summaries
        ON conversation_summaries.session_id = recent_sources.session_id
       AND conversation_summaries.agent_id = recent_sources.agent_id
      WHERE conversation_summaries.covers_through IS NULL
         OR recent_sources.last_source_at > conversation_summaries.covers_through
      ORDER BY recent_sources.last_source_at DESC, recent_sources.session_id ASC, recent_sources.agent_id ASC
    `).all(...params) as unknown as ReflectionTargetRow[];
  } finally {
    db.close();
  }
}
