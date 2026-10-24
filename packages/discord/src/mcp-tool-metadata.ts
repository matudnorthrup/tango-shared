import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, GovernanceChecker } from "@tango/core";

const OPEN_WORLD_TOOLS = new Set<string>([
  "exa_search",
  "exa_answer",
  "browser",
  "study_library",
  "todoist",
  "todoist_manage",
  "walmart",
  "local_business_search",
  "driving_route",
  "route_ahead_search",
  "find_diesel",
  "walking_route",
  "spawn_sub_agents",
  "spawn_claude_session",
  "youtube_transcript",
  "youtube_analyze",
  "bank_transfer",
]);

const DESTRUCTIVE_WRITE_TOOLS = new Set<string>([
  "todoist_manage",
  "things_write",
  "dayone_write",
  "fatsecret_api",
  "tango_file",
  "discord_manage",
  "bank_transfer",
]);

const IDEMPOTENT_WRITE_TOOLS = new Set<string>([
  "printer_command",
  "openscad_render",
  "prusa_slice",
]);

function inferAccessTypeFromName(toolName: string): "read" | "write" {
  if (
    toolName.includes("read")
    || toolName.includes("list")
    || toolName.includes("search")
    || toolName.includes("query")
    || toolName.includes("get")
    || toolName.includes("lookup")
    || toolName.includes("route")
    || toolName.includes("status")
    || toolName.includes("transcript")
    || toolName.includes("analyze")
  ) {
    return "read";
  }
  return "write";
}

export function getMcpToolAnnotations(
  toolName: string,
  accessType: "read" | "write" | null,
): ToolAnnotations {
  const resolvedAccessType = accessType ?? inferAccessTypeFromName(toolName);
  const isReadOnly = resolvedAccessType === "read";

  return {
    readOnlyHint: isReadOnly,
    destructiveHint: isReadOnly ? false : DESTRUCTIVE_WRITE_TOOLS.has(toolName),
    idempotentHint: isReadOnly ? true : IDEMPOTENT_WRITE_TOOLS.has(toolName),
    openWorldHint: OPEN_WORLD_TOOLS.has(toolName),
  };
}

export function buildMcpListedTool(
  tool: AgentTool,
  governance: GovernanceChecker | null,
  accessOverride?: "read" | "write" | null,
): {
  name: string;
  description: string;
  inputSchema: AgentTool["inputSchema"];
  annotations: ToolAnnotations;
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: getMcpToolAnnotations(
      tool.name,
      accessOverride ?? governance?.getToolAccessType(tool.name) ?? null,
    ),
  };
}
