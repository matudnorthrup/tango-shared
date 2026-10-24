import { describe, expect, it, vi } from "vitest";
import {
  McpHttpToolClient,
  DEFAULT_MCP_HTTP_PORT,
  EMPTY_ALLOWED_TOOL_IDS,
} from "../src/mcp-http-tool-client.js";

/** A fake `fetch` that records the request and returns a JSON-RPC result body. */
function fakeFetch(result: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.(String(url), init ?? {});
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("McpHttpToolClient.listOpenAITools", () => {
  it("maps MCP listed tools into OpenAI function-calling definitions (inputSchema → parameters)", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch(
      {
        tools: [
          {
            name: "log_weight",
            description: "Record a body-weight reading.",
            inputSchema: {
              type: "object",
              properties: { lbs: { type: "number" } },
              required: ["lbs"],
            },
            annotations: { readOnlyHint: false },
          },
          {
            name: "list_meals",
            description: "List today's meals.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      (url, init) => {
        capturedUrl = url;
        capturedInit = init;
      },
    );

    const client = new McpHttpToolClient({ port: 9100, fetchImpl });
    const tools = await client.listOpenAITools("watson");

    // The JSON-Schema inputSchema maps DIRECTLY onto function.parameters.
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "log_weight",
          description: "Record a body-weight reading.",
          parameters: {
            type: "object",
            properties: { lbs: { type: "number" } },
            required: ["lbs"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_meals",
          description: "List today's meals.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);

    // POSTs JSON-RPC to /mcp on the configured port with the worker-id header.
    expect(capturedUrl).toBe(`http://127.0.0.1:9100/mcp`);
    expect(capturedInit.method).toBe("POST");
    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Worker-ID"]).toBe("watson");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.method).toBe("tools/list");
    expect(body.jsonrpc).toBe("2.0");
  });

  it("forwards an allowlist via the X-Allowed-Tool-Ids header", async () => {
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch({ tools: [] }, (_url, init) => {
      capturedInit = init;
    });
    const client = new McpHttpToolClient({ fetchImpl });
    await client.listOpenAITools("watson", ["log_weight", "list_meals"]);

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Allowed-Tool-Ids"]).toBe("log_weight,list_meals");
  });

  it("sends the deny-all sentinel (not an omitted header) for an EMPTY allowlist", async () => {
    // An omitted header means "all tools allowed" server-side, so an empty
    // per-run allowlist must send the explicit deny-all sentinel rather than fail
    // open. Distinguishes undefined (omit) from [] (deny all).
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch({ tools: [] }, (_url, init) => {
      capturedInit = init;
    });
    const client = new McpHttpToolClient({ fetchImpl });
    await client.listOpenAITools("watson", []);

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Allowed-Tool-Ids"]).toBe(EMPTY_ALLOWED_TOOL_IDS);
  });

  it("omits the X-Allowed-Tool-Ids header entirely when the allowlist is undefined", async () => {
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch({ tools: [] }, (_url, init) => {
      capturedInit = init;
    });
    const client = new McpHttpToolClient({ fetchImpl });
    await client.listOpenAITools("watson");

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Allowed-Tool-Ids"]).toBeUndefined();
  });

  it("defaults to port 9100", async () => {
    let capturedUrl = "";
    const fetchImpl = fakeFetch({ tools: [] }, (url) => {
      capturedUrl = url;
    });
    const client = new McpHttpToolClient({ fetchImpl });
    await client.listOpenAITools("watson");
    expect(capturedUrl).toBe(`http://127.0.0.1:${DEFAULT_MCP_HTTP_PORT}/mcp`);
  });
});

describe("McpHttpToolClient.callTool", () => {
  it("returns result.content[0].text for a successful call", async () => {
    let capturedBody: { method?: string; params?: { name?: string; arguments?: unknown } } = {};
    const fetchImpl = fakeFetch(
      { content: [{ type: "text", text: '{"ok":true,"id":42}' }] },
      (_url, init) => {
        capturedBody = JSON.parse(init.body as string);
      },
    );
    const client = new McpHttpToolClient({ fetchImpl });
    const out = await client.callTool("log_weight", { lbs: 180 }, "watson");

    expect(out).toBe('{"ok":true,"id":42}');
    expect(capturedBody.method).toBe("tools/call");
    expect(capturedBody.params?.name).toBe("log_weight");
    expect(capturedBody.params?.arguments).toEqual({ lbs: 180 });
  });

  it("returns the error text (does NOT throw) when result.isError is true", async () => {
    const fetchImpl = fakeFetch({
      content: [{ type: "text", text: '{"error":"Permission denied: log_weight"}' }],
      isError: true,
    });
    const client = new McpHttpToolClient({ fetchImpl });
    const out = await client.callTool("log_weight", {}, "watson");
    expect(out).toBe('{"error":"Permission denied: log_weight"}');
  });

  it("sets X-Read-Only-Step:\"1\" when the call is marked read-only", async () => {
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch(
      { content: [{ type: "text", text: "{}" }] },
      (_url, init) => {
        capturedInit = init;
      },
    );
    const client = new McpHttpToolClient({ fetchImpl });
    await client.callTool("list_meals", {}, "watson", undefined, true);

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Read-Only-Step"]).toBe("1");
  });

  it("omits X-Read-Only-Step by default", async () => {
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch(
      { content: [{ type: "text", text: "{}" }] },
      (_url, init) => {
        capturedInit = init;
      },
    );
    const client = new McpHttpToolClient({ fetchImpl });
    await client.callTool("log_weight", { lbs: 1 }, "watson");

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Read-Only-Step"]).toBeUndefined();
  });

  it("surfaces an HTTP/transport failure as an error string instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response("upstream boom", { status: 500 })) as unknown as typeof fetch;
    const client = new McpHttpToolClient({ fetchImpl });
    const out = await client.callTool("log_weight", {}, "watson");
    expect(out).toContain("error");
    expect(out).toContain("500");
  });
});
