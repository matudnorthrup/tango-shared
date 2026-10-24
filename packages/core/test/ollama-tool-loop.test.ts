import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_ITERS,
  OllamaProvider,
  TOOL_LOOP_CAP_FALLBACK_TEXT,
  TOOL_LOOP_CAP_TRUNCATION_NOTICE,
  parseOllamaChatResponse,
  type ProviderToolsConfig,
} from "../src/provider.js";
import type {
  McpHttpToolClient,
  OpenAIToolDefinition,
} from "../src/mcp-http-tool-client.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A chat-completions payload as DeepSeek/Ollama returns over /v1. */
interface ChatTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason: "tool_calls" | "stop";
  promptTokens?: number;
  completionTokens?: number;
}

function buildPayload(turn: ChatTurn): Record<string, unknown> {
  return {
    model: "deepseek-v4-pro:cloud",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: turn.content ?? "",
          ...(turn.toolCalls
            ? {
                tool_calls: turn.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        },
        finish_reason: turn.finishReason,
      },
    ],
    usage: {
      prompt_tokens: turn.promptTokens ?? 0,
      completion_tokens: turn.completionTokens ?? 0,
    },
  };
}

/**
 * Stub the global fetch with a queue of chat-completion turns. Each POST to
 * /v1/chat/completions consumes the next turn. Records the request bodies so the
 * test can assert what the loop sent back.
 */
function stubFetchWithTurns(turns: ChatTurn[]): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    return new Response(JSON.stringify(buildPayload(turn)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", impl);
  return { bodies };
}

/** A fake tool client recording every callTool invocation. */
function createFakeToolClient(opts: {
  tools?: OpenAIToolDefinition[];
  onCall?: (name: string, args: Record<string, unknown>) => string;
}): McpHttpToolClient & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools = opts.tools ?? [
    {
      type: "function",
      function: { name: "log_weight", description: "Log weight", parameters: { type: "object" } },
    },
  ];
  return {
    calls,
    async listOpenAITools() {
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return opts.onCall ? opts.onCall(name, args) : '{"ok":true}';
    },
  } as unknown as McpHttpToolClient & {
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  };
}

const enabledTools: ProviderToolsConfig = { mode: "default" };

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// parseOllamaChatResponse — tool_calls surfacing
// ---------------------------------------------------------------------------

describe("parseOllamaChatResponse with tool_calls", () => {
  it("surfaces choices[0].message.tool_calls on ProviderResponse.toolCalls", () => {
    const parsed = parseOllamaChatResponse(
      buildPayload({
        toolCalls: [{ id: "call_0", name: "log_weight", arguments: '{"lbs":180}' }],
        finishReason: "tool_calls",
      }),
    );
    expect(parsed.toolCalls).toEqual([{ name: "log_weight", input: { lbs: 180 } }]);
    expect(parsed.metadata?.stopReason).toBe("tool_calls");
  });

  it("does NOT throw on empty content when tool_calls are present", () => {
    expect(() =>
      parseOllamaChatResponse(
        buildPayload({
          content: "",
          toolCalls: [{ id: "call_0", name: "log_weight", arguments: "{}" }],
          finishReason: "tool_calls",
        }),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider.generate — tool loop
// ---------------------------------------------------------------------------

describe("OllamaProvider tool loop", () => {
  it("(a) text-only single shot when no tool client is configured", async () => {
    const { bodies } = stubFetchWithTurns([
      { content: "Hello, no tools here.", finishReason: "stop", promptTokens: 10, completionTokens: 5 },
    ]);
    const provider = new OllamaProvider({ apiKey: "k" });

    const res = await provider.generate({ prompt: "hi", tools: enabledTools });

    expect(res.text).toBe("Hello, no tools here.");
    expect(res.toolCalls).toBeUndefined();
    // Single request, no `tools` field in the body (Phase 0 path preserved).
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tools).toBeUndefined();
  });

  it("(a') text-only single shot when the request disables tools", async () => {
    stubFetchWithTurns([{ content: "plain", finishReason: "stop" }]);
    const toolClient = createFakeToolClient({});
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({ prompt: "hi", tools: { mode: "off" } });

    expect(res.text).toBe("plain");
    expect(toolClient.calls).toHaveLength(0);
  });

  it("(b) one tool round: model requests a tool, client runs it, result fed back, final text", async () => {
    const { bodies } = stubFetchWithTurns([
      {
        toolCalls: [{ id: "call_0", name: "log_weight", arguments: '{"lbs":182}' }],
        finishReason: "tool_calls",
        promptTokens: 100,
        completionTokens: 20,
      },
      { content: "Logged 182 lbs.", finishReason: "stop", promptTokens: 150, completionTokens: 8 },
    ]);
    const toolClient = createFakeToolClient({
      onCall: () => '{"logged":182}',
    });
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({
      prompt: "log my weight",
      tools: enabledTools,
      workerId: "watson",
    });

    expect(res.text).toBe("Logged 182 lbs.");
    expect(toolClient.calls).toEqual([{ name: "log_weight", args: { lbs: 182 } }]);
    expect(res.toolCalls).toEqual([{ name: "log_weight", input: { lbs: 182 }, output: '{"logged":182}' }]);

    // Two round-trips. The second body must carry the assistant tool_calls turn
    // and the role:"tool" result keyed by the tool_call_id.
    expect(bodies).toHaveLength(2);
    const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
    const assistant = secondMessages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toBeDefined();
    const toolResult = secondMessages.find((m) => m.role === "tool");
    expect(toolResult).toEqual({ role: "tool", tool_call_id: "call_0", content: '{"logged":182}' });

    // Usage: peak (high-water) prompt tokens, summed completion tokens.
    expect(res.metadata?.usage?.inputTokens).toBe(150);
    expect(res.metadata?.usage?.outputTokens).toBe(28);
  });

  it("retries a rate-limited model call without re-running completed tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        requestCount++;
        if (requestCount === 1) {
          return new Response(
            JSON.stringify(
              buildPayload({
                toolCalls: [{ id: "call_0", name: "log_weight", arguments: '{"lbs":182}' }],
                finishReason: "tool_calls",
              }),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (requestCount === 2) {
          return new Response('{"error":"too many concurrent requests"}', { status: 429 });
        }
        return new Response(JSON.stringify(buildPayload({ content: "Logged 182 lbs.", finishReason: "stop" })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    );
    const toolClient = createFakeToolClient({ onCall: () => '{"logged":182}' });
    const provider = new OllamaProvider({ apiKey: "k", toolClient, retryDelayMs: 0 });

    const response = await provider.generate({ prompt: "log my weight", tools: enabledTools });

    expect(response.text).toBe("Logged 182 lbs.");
    expect(bodies).toHaveLength(3);
    expect(toolClient.calls).toEqual([{ name: "log_weight", args: { lbs: 182 } }]);
    const retriedMessages = bodies[2]?.messages as Array<Record<string, unknown>>;
    expect(retriedMessages.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      tool_call_id: "call_0",
      content: '{"logged":182}',
    });
  });

  it("(b') runs tools and continues the loop when finish_reason is \"stop\" but tool_calls are present", async () => {
    // Some models emit finish_reason:"stop" while STILL attaching tool_calls.
    // Gating on tool_calls presence (not finish_reason) means the tool must run
    // and the loop must continue to a real terminal turn.
    const { bodies } = stubFetchWithTurns([
      {
        toolCalls: [{ id: "call_0", name: "log_weight", arguments: '{"lbs":182}' }],
        // finish_reason is "stop", NOT "tool_calls" — but tools are attached.
        finishReason: "stop",
      },
      { content: "Logged 182 lbs.", finishReason: "stop" },
    ]);
    const toolClient = createFakeToolClient({ onCall: () => '{"logged":182}' });
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({ prompt: "log my weight", tools: enabledTools });

    // The tool ran despite finish_reason:"stop" ...
    expect(toolClient.calls).toEqual([{ name: "log_weight", args: { lbs: 182 } }]);
    // ... and the loop continued to a second round-trip carrying the tool result.
    expect(bodies).toHaveLength(2);
    expect(res.text).toBe("Logged 182 lbs.");
  });

  it("(c) malformed tool arguments → empty args fed in, no throw, error result surfaced to model", async () => {
    const { bodies } = stubFetchWithTurns([
      {
        toolCalls: [{ id: "call_0", name: "log_weight", arguments: "{not valid json" }],
        finishReason: "tool_calls",
      },
      { content: "Recovered.", finishReason: "stop" },
    ]);
    const toolClient = createFakeToolClient({
      // Tool reports a failure as a string; the loop must feed it back, not throw.
      onCall: () => '{"error":"missing lbs"}',
    });
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({ prompt: "log it", tools: enabledTools });

    expect(res.text).toBe("Recovered.");
    // Malformed JSON parses to {} rather than throwing.
    expect(toolClient.calls).toEqual([{ name: "log_weight", args: {} }]);
    const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
    const toolResult = secondMessages.find((m) => m.role === "tool");
    expect(toolResult?.content).toBe('{"error":"missing lbs"}');
  });

  it("(d) iteration cap is respected — a model that always requests tools cannot loop forever", async () => {
    // Every turn requests a tool → loop must stop at MAX_TOOL_ITERS.
    const { bodies } = stubFetchWithTurns([
      {
        content: "still working",
        toolCalls: [{ id: "call_x", name: "log_weight", arguments: "{}" }],
        finishReason: "tool_calls",
      },
    ]);
    const toolClient = createFakeToolClient({});
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({ prompt: "loop", tools: enabledTools });

    // Exactly MAX_TOOL_ITERS chat round-trips, then it returns the last text
    // with an explicit truncation notice — interim narration followed by
    // silence reads as the agent doing nothing (TGO-740).
    expect(bodies).toHaveLength(MAX_TOOL_ITERS);
    expect(toolClient.calls).toHaveLength(MAX_TOOL_ITERS);
    expect(res.text).toBe(`still working\n\n${TOOL_LOOP_CAP_TRUNCATION_NOTICE}`);
    expect(res.metadata?.stopReason).toBe("max_tool_iters");
  });

  it("(d') returns a deterministic fallback + max_tool_iters stopReason when the cap is hit with no final text", async () => {
    // Every turn requests a tool with NO assistant text → the cap is hit without
    // any usable content. The loop must not return a blank reply.
    stubFetchWithTurns([
      {
        // No content at all on any turn.
        toolCalls: [{ id: "call_x", name: "log_weight", arguments: "{}" }],
        finishReason: "tool_calls",
      },
    ]);
    const toolClient = createFakeToolClient({});
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({ prompt: "loop", tools: enabledTools });

    expect(res.text).toBe(TOOL_LOOP_CAP_FALLBACK_TEXT);
    expect(res.metadata?.stopReason).toBe("max_tool_iters");
  });

  it("(e) executed tool calls drive toolsUsed (deduped by the adapter)", async () => {
    stubFetchWithTurns([
      {
        toolCalls: [
          { id: "c0", name: "log_weight", arguments: '{"lbs":1}' },
          { id: "c1", name: "log_weight", arguments: '{"lbs":2}' },
          { id: "c2", name: "list_meals", arguments: "{}" },
        ],
        finishReason: "tool_calls",
      },
      { content: "done", finishReason: "stop" },
    ]);
    const toolClient = createFakeToolClient({});
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    const res = await provider.generate({ prompt: "go", tools: enabledTools });

    // Both calls run in parallel; toolCalls preserves each invocation.
    expect(toolClient.calls).toHaveLength(3);
    const names = [...new Set((res.toolCalls ?? []).map((t) => t.name))];
    expect(names.sort()).toEqual(["list_meals", "log_weight"]);
  });

  it("forwards the worker id + allowlist to the tool client", async () => {
    stubFetchWithTurns([
      {
        toolCalls: [{ id: "c0", name: "log_weight", arguments: "{}" }],
        finishReason: "tool_calls",
      },
      { content: "ok", finishReason: "stop" },
    ]);
    let listWorker: string | undefined;
    let listAllow: string[] | undefined;
    let callWorker: string | undefined;
    const toolClient = {
      async listOpenAITools(worker: string, allow?: string[]) {
        listWorker = worker;
        listAllow = allow;
        return [
          { type: "function", function: { name: "log_weight", description: "", parameters: {} } },
        ];
      },
      async callTool(_n: string, _a: Record<string, unknown>, worker: string) {
        callWorker = worker;
        return "{}";
      },
    } as unknown as McpHttpToolClient;
    const provider = new OllamaProvider({ apiKey: "k", toolClient });

    await provider.generate({
      prompt: "go",
      workerId: "watson",
      tools: { mode: "allowlist", allowlist: ["log_weight"] },
    });

    expect(listWorker).toBe("watson");
    expect(listAllow).toEqual(["log_weight"]);
    expect(callWorker).toBe("watson");
  });
});
