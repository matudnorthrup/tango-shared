export interface ToolTelemetry {
  usedTools: string[];
  deniedTools: string[];
  usageByTool: Record<string, number>;
  denialCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeUsageToolKey(key: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/_requests?$/u, "")
    .replace(/_request$/u, "");
  return snake
    .split("_")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

function collectDeniedTools(payload: Record<string, unknown>): string[] {
  const raw = payload.permission_denials;
  if (!Array.isArray(raw)) return [];

  const denied = new Set<string>();
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const name = record.tool_name;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    denied.add(name.trim());
  }
  return [...denied];
}

function collectUsedToolsFromUsage(payload: Record<string, unknown>): Record<string, number> {
  const usage = asRecord(payload.usage);
  if (!usage) return {};

  const serverToolUse = asRecord(usage.server_tool_use ?? usage.serverToolUse);
  if (!serverToolUse) return {};

  const usageByTool: Record<string, number> = {};
  for (const [key, value] of Object.entries(serverToolUse)) {
    const count = asFiniteNumber(value);
    if (count === null || count <= 0) continue;
    const toolName = normalizeUsageToolKey(key);
    if (!toolName) continue;
    usageByTool[toolName] = count;
  }
  return usageByTool;
}

function collectUsedToolsFromBlocks(payload: Record<string, unknown>): string[] {
  const candidates = [payload.tool_uses, payload.toolUses];
  const used = new Set<string>();

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      const record = asRecord(item);
      if (!record) continue;
      const name = record.tool_name ?? record.name;
      if (typeof name !== "string" || name.trim().length === 0) continue;
      used.add(name.trim());
    }
  }

  return [...used];
}

export function emptyToolTelemetry(): ToolTelemetry {
  return {
    usedTools: [],
    deniedTools: [],
    usageByTool: {},
    denialCount: 0
  };
}

export function extractToolTelemetry(raw: unknown): ToolTelemetry {
  const payload = asRecord(raw);
  if (!payload) return emptyToolTelemetry();

  const deniedTools = collectDeniedTools(payload);
  const usageByTool = collectUsedToolsFromUsage(payload);

  const used = new Set<string>();
  for (const toolName of Object.keys(usageByTool)) {
    used.add(toolName);
  }
  for (const toolName of collectUsedToolsFromBlocks(payload)) {
    used.add(toolName);
  }

  return {
    usedTools: [...used],
    deniedTools,
    usageByTool,
    denialCount: deniedTools.length
  };
}

