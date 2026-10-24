#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { createDevTools } from "./tools.js";

const debug = (...args: unknown[]): void => {
  console.error("[tango-dev]", ...args);
};

function encodePayload(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function startTangoDevServer(): Promise<void> {
  const tools = createDevTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: "tango-dev", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) return encodePayload({ error: `Unknown tool: ${name}` }, true);
    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      return encodePayload(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return encodePayload({ error: message }, true);
    }
  });

  const shutdown = async (signal: string) => {
    debug(`Shutting down due to ${signal}`);
    try {
      await (server as any).close?.();
    } catch {}
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  debug("Starting tango-dev MCP server");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("tango-dev MCP server connected");
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  await startTangoDevServer();
}
