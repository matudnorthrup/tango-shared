/**
 * Zero-dependency, pure-`fetch` client for the persistent HTTP MCP server
 * (`packages/discord/src/mcp-wellness-server.ts` in `--http` mode). The server
 * speaks JSON-RPC 2.0 over `POST http://127.0.0.1:<port>/mcp` and authorizes
 * each call via the governance headers below.
 *
 * Contract (verified against mcp-wellness-server.ts HTTP mode):
 *   - tools/list → result.tools[]: { name, description, inputSchema, annotations }
 *     (inputSchema is JSON-Schema; see buildMcpListedTool in mcp-tool-metadata.ts).
 *   - tools/call → params { name, arguments } → result { content: [{ type, text }],
 *     isError? }. A denied/failed call returns isError:true with the error JSON in
 *     content[0].text (the server never throws across the wire).
 *
 * Governance headers (read by the server per request):
 *   - X-Worker-ID:        principal id → `worker:<id>` (drives permission checks).
 *   - X-Read-Only-Step:   "1" to forbid write tools for this call.
 *   - X-Allowed-Tool-Ids: comma-separated per-run allowlist (omitted = all).
 *
 * The OpenAI function-calling shape maps DIRECTLY from the MCP listed tool: the
 * JSON-Schema `inputSchema` becomes `function.parameters` with no translation.
 */

export const DEFAULT_MCP_HTTP_PORT = 9100;

/**
 * Deny-all sentinel for the X-Allowed-Tool-Ids header. Must match
 * `EMPTY_ALLOWED_TOOL_IDS` in `packages/discord/src/mcp-wellness-server.ts`: the
 * server treats an OMITTED header as "all tools allowed", so an empty per-run
 * allowlist has to send this explicit sentinel instead of omitting the header
 * (otherwise an empty allowlist would silently fail open / bypass governance).
 */
export const EMPTY_ALLOWED_TOOL_IDS = "__none__";

/** OpenAI-compatible tool definition (chat-completions `tools[]` entry). */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface McpListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpHttpToolClientOptions {
  /** Persistent HTTP MCP server port. Defaults to {@link DEFAULT_MCP_HTTP_PORT}. */
  port?: number;
  /** Override the full base URL (host + port). Wins over `port`. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 60s. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface McpToolTurnContext {
  conversationKey?: string;
  turnId?: string;
  messageId?: string;
  channelId?: string;
  threadId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export class McpHttpToolClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private rpcId = 0;

  constructor(options: McpHttpToolClientOptions = {}) {
    const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
    const baseUrl = (options.baseUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/u, "");
    this.url = `${baseUrl}/mcp`;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * List the tools this worker may use and map them into OpenAI function-calling
   * definitions. The JSON-Schema `inputSchema` maps directly to
   * `function.parameters`; no translation is applied.
   */
  async listOpenAITools(workerId: string, allowedToolIds?: string[]): Promise<OpenAIToolDefinition[]> {
    const result = await this.rpc("tools/list", {}, workerId, allowedToolIds);
    const root = asRecord(result);
    const tools = Array.isArray(root?.tools) ? (root.tools as McpListedTool[]) : [];
    const mapped: OpenAIToolDefinition[] = [];
    for (const tool of tools) {
      const name = typeof tool?.name === "string" ? tool.name : undefined;
      if (!name) continue;
      mapped.push({
        type: "function",
        function: {
          name,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: asRecord(tool.inputSchema) ?? { type: "object", properties: {} },
        },
      });
    }
    return mapped;
  }

  /**
   * Invoke a tool and return its textual result. A failed/denied call surfaces
   * the server's error text (result.content[0].text) rather than throwing, so the
   * caller can feed it back to the model as a tool result.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    workerId: string,
    allowedToolIds?: string[],
    readOnlyStep?: boolean,
    turnContext?: McpToolTurnContext,
  ): Promise<string> {
    let result: unknown;
    try {
      result = await this.rpc("tools/call", { name, arguments: args }, workerId, allowedToolIds, readOnlyStep, turnContext);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
    const root = asRecord(result);
    const content = Array.isArray(root?.content) ? root.content : [];
    const first = asRecord(content[0]);
    const text = typeof first?.text === "string" ? first.text : "";
    // isError responses still carry the error text in content[0].text; return it
    // as-is so the model sees what went wrong.
    if (text.length > 0) return text;
    return root?.isError ? JSON.stringify({ error: `Tool ${name} failed` }) : "";
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    workerId: string,
    allowedToolIds?: string[],
    readOnlyStep?: boolean,
    turnContext?: McpToolTurnContext,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Worker-ID": workerId,
    };
    // Forbid write tools for this call when the caller marks it read-only.
    if (readOnlyStep) {
      headers["X-Read-Only-Step"] = "1";
    }
    // Distinguish undefined (omit the header → server allows all tools) from an
    // empty array (send the deny-all sentinel → server denies every tool). A
    // bare length check would conflate the two and fail open on an empty
    // allowlist.
    if (allowedToolIds) {
      headers["X-Allowed-Tool-Ids"] =
        allowedToolIds.length > 0 ? allowedToolIds.join(",") : EMPTY_ALLOWED_TOOL_IDS;
    }
    if (turnContext?.conversationKey) headers["X-Tango-Conversation-Key"] = turnContext.conversationKey;
    if (turnContext?.turnId) headers["X-Tango-Turn-Id"] = turnContext.turnId;
    if (turnContext?.messageId) headers["X-Tango-Message-Id"] = turnContext.messageId;
    if (turnContext?.channelId) headers["X-Tango-Channel-Id"] = turnContext.channelId;
    if (turnContext?.threadId) headers["X-Tango-Thread-Id"] = turnContext.threadId;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method,
      params,
    });

    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`MCP ${method} failed: status=${res.status} body=${rawText.slice(0, 500)}`);
    }

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(rawText) as JsonRpcResponse;
    } catch {
      throw new Error(`MCP ${method} returned invalid JSON`);
    }

    if (parsed.error) {
      throw new Error(`MCP ${method} error: ${parsed.error.message ?? "unknown"}`);
    }
    return parsed.result;
  }
}
