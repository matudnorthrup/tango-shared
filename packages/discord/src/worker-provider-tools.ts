import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntimePathEnv,
  resolveDatabasePath,
  type McpServerEntry,
  type ProviderMcpServerConfig,
  type ProviderToolsConfig,
} from "@tango/core";

const EMPTY_ALLOWED_TOOL_IDS: string[] = [];

function buildPrimaryWorkerMcpServer(input: {
  workerId: string;
  mcpServerScript: string;
  persistentMcpPort?: number;
  readOnlyStep?: boolean;
  allowedToolIds?: string[];
}): ProviderMcpServerConfig {
  if (input.persistentMcpPort) {
    const proxyScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../core/dist/mcp-proxy.js",
    );
    return {
      command: process.execPath,
      args: [proxyScript],
      env: {
        MCP_PROXY_URL: `http://127.0.0.1:${input.persistentMcpPort}/mcp`,
        MCP_PROXY_ALLOWED_TOOLS: JSON.stringify(input.allowedToolIds ?? EMPTY_ALLOWED_TOOL_IDS),
        MCP_PROXY_READ_ONLY: input.readOnlyStep ? "1" : "0",
        TANGO_WORKER_ID: input.workerId,
      },
    };
  }

  return {
    command: process.execPath,
    args: [input.mcpServerScript],
    env: {
      ...buildRuntimePathEnv({
        dbPath: resolveDatabasePath(process.env.TANGO_DB_PATH),
      }),
      TANGO_WORKER_ID: input.workerId,
      TANGO_ALLOWED_TOOL_IDS: JSON.stringify(input.allowedToolIds ?? EMPTY_ALLOWED_TOOL_IDS),
      TANGO_READ_ONLY_STEP: input.readOnlyStep ? "1" : "0",
    },
  };
}

function normalizeAdditionalMcpServers(
  servers?: Record<string, McpServerEntry>,
): Record<string, ProviderMcpServerConfig> | undefined {
  if (!servers) {
    return undefined;
  }

  const entries = Object.entries(servers).flatMap(([name, server]) => {
    if ("type" in server && server.type === "url") {
      return [];
    }

    return [[
      name,
      {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      },
    ] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildWorkerProviderTools(input: {
  workerId: string;
  mcpServerScript: string;
  mcpServerName: string;
  persistentMcpPort?: number;
  readOnlyStep?: boolean;
  toolIds?: string[];
  additionalMcpServers?: Record<string, McpServerEntry>;
  additionalAllowedToolNames?: string[];
}): ProviderToolsConfig {
  const normalizedPrimaryToolIds = [...new Set(
    (input.toolIds ?? [])
      .map((toolId) => toolId.trim())
      .filter((toolId) => toolId.length > 0),
  )];
  const allowlist = [...new Set([
    ...normalizedPrimaryToolIds.map((toolId) => `mcp__${input.mcpServerName}__${toolId}`),
    ...(
      input.additionalAllowedToolNames
        ?? []
    )
      .map((toolName) => toolName.trim())
      .filter((toolName) => toolName.length > 0),
  ])];

  const additionalServers = normalizeAdditionalMcpServers(input.additionalMcpServers);
  const restrictPrimaryToolIds =
    input.toolIds
      ? normalizedPrimaryToolIds
      : (allowlist.length > 0 ? [] : undefined);

  return {
    mode: allowlist.length > 0 ? "allowlist" : "default",
    ...(allowlist.length > 0 ? { allowlist } : {}),
    permissionMode: "bypass",
    mcpServers: {
      [input.mcpServerName]: buildPrimaryWorkerMcpServer({
        workerId: input.workerId,
        mcpServerScript: input.mcpServerScript,
        persistentMcpPort: input.persistentMcpPort,
        readOnlyStep: input.readOnlyStep,
        allowedToolIds: restrictPrimaryToolIds,
      }),
      ...(additionalServers ?? {}),
    },
  };
}
