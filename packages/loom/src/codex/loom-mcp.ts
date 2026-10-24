import type * as McpServer from "@modelcontextprotocol/sdk/server/index.js";
import type * as McpTransport from "@modelcontextprotocol/sdk/server/stdio.js";
import type * as McpTypes from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { loomToolDefinitions } from "../claude/loom-tools.js";

// Reuse the Agent SDK's production dependency, including its nested copy in immutable releases.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
const { Server } = sdkRequire("@modelcontextprotocol/sdk/server/index.js") as typeof McpServer;
const { StdioServerTransport } = sdkRequire("@modelcontextprotocol/sdk/server/stdio.js") as typeof McpTransport;
const { ListToolsRequestSchema, CallToolRequestSchema } = sdkRequire("@modelcontextprotocol/sdk/types.js") as typeof McpTypes;

export function createLoomStdioServer(threadId: string, env: NodeJS.ProcessEnv = process.env) {
  const definitions = loomToolDefinitions(threadId, env);
  const server = new Server({ name: "loom", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema), { io: "input" }) })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = definitions.find(t => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown Loom tool: ${request.params.name}`);
    try { return await tool.handler(z.object(tool.schema).parse(request.params.arguments ?? {})); }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const threadId = process.env.LOOM_THREAD_ID;
  if (!threadId) throw new Error("LOOM_THREAD_ID is required");
  await createLoomStdioServer(threadId).connect(new StdioServerTransport());
}
