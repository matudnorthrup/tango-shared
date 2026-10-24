import type { AgentConfig, ToolMode } from "./types.js";
import type { ProviderToolsConfig } from "./provider.js";

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export type McpServerEntry =
  | { type?: "command"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "url"; url: string; authorization_token?: string };

export interface AgentToolPolicy {
  mode: ToolMode;
  allowlist: string[];
}

function normalizeToolAllowlist(value: string[] | undefined): string[] {
  if (!value) return [];
  const deduped = new Set<string>();
  for (const item of value) {
    const normalized = item.trim();
    if (normalized.length === 0) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

export function resolveAgentToolPolicy(agent: Pick<AgentConfig, "tools"> | undefined): AgentToolPolicy {
  const mode = agent?.tools?.mode ?? "off";
  if (mode !== "allowlist") {
    return {
      mode,
      allowlist: []
    };
  }

  const allowlist = normalizeToolAllowlist(agent?.tools?.allowlist);
  if (allowlist.length === 0) {
    return {
      mode: "off",
      allowlist: []
    };
  }

  return {
    mode,
    allowlist
  };
}

export function resolveProviderToolsForAgent(
  agent: Pick<AgentConfig, "tools"> | undefined
): ProviderToolsConfig {
  const policy = resolveAgentToolPolicy(agent);
  if (policy.mode === "allowlist") {
    return {
      mode: policy.mode,
      allowlist: policy.allowlist,
      ...(agent?.tools?.permissionMode ? { permissionMode: agent.tools.permissionMode } : {})
    };
  }

  return {
    mode: policy.mode,
    ...(agent?.tools?.permissionMode ? { permissionMode: agent.tools.permissionMode } : {})
  };
}
