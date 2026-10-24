import type { V2MemoryScope } from "@tango/core";

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )];
}

function isCurrentMemoryScopeAgent(
  agentId: string | null,
  runtimeAgentId: string,
  memoryScope: V2MemoryScope,
): boolean {
  return !agentId || agentId === runtimeAgentId || memoryScope.aliasAgentIds.includes(agentId);
}

export function applyMemoryScopeToToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  runtimeAgentId: string,
  memoryScope: V2MemoryScope | null,
): Record<string, unknown> {
  if (!memoryScope) {
    return args;
  }

  const agentId = normalizeOptionalString(args.agent_id);
  if (!isCurrentMemoryScopeAgent(agentId, runtimeAgentId, memoryScope)) {
    return args;
  }

  if (toolName === "memory_search") {
    const agentIds = normalizeStringArray(args.agent_ids);
    const onlyCurrentScope =
      agentIds.length === 0 || agentIds.every((id) => id === runtimeAgentId || memoryScope.aliasAgentIds.includes(id));
    if (!onlyCurrentScope) {
      return args;
    }
    return {
      ...args,
      agent_id: memoryScope.canonicalAgentId,
      agent_ids: memoryScope.aliasAgentIds,
    };
  }

  if (toolName === "memory_add" || toolName === "memory_reflect") {
    return {
      ...args,
      agent_id: memoryScope.canonicalAgentId,
    };
  }

  return args;
}
