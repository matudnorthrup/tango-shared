import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamActivityParser,
  describeToolUse,
  emitRuntimeTurnEvent,
  type RuntimeTurnEvent,
} from "../src/runtime-activity.js";
import { OllamaProvider } from "../src/provider.js";
import type { McpHttpToolClient } from "../src/mcp-http-tool-client.js";

describe("describeToolUse", () => {
  it.each([
    ["Edit", { file_path: "/repo/apps/tango-voice/src/live/media-session.ts" }, "Editing media-session.ts"],
    ["MultiEdit", { file_path: "src/a.ts" }, "Editing a.ts"],
    ["Write", { file_path: "/tmp/out/report.html" }, "Writing report.html"],
    ["Read", { file_path: "/tmp/reports/foo.pdf" }, "Reading foo.pdf"],
    ["Bash", { command: "npm test -w @tango/discord" }, "Running npm test"],
    ["Bash", { command: "cd /repo && git status --short" }, "Running git status"],
    ["Bash", { command: "API_KEY=abc123 node scripts/run.mjs --live" }, "Running node run.mjs"],
    ["Bash", { command: "curl https://example.test/x?token=secret" }, "Running curl"],
    ["Bash", { command: "echo sk1234567890abcdefgh" }, "Running echo"],
    ["Bash", {}, "Running a command"],
    ["Grep", { pattern: "x" }, "Searching files"],
    ["WebSearch", { query: "weather" }, "Searching the web"],
    ["WebFetch", { url: "https://docs.example.test/page?q=1" }, "Reading docs.example.test"],
    ["Task", { prompt: "go" }, "Starting a sub-agent"],
    ["mcp__memory__memory_search", { query: "x" }, "Using memory search"],
    ["mcp__screen__screen", { action: "stage", body: "<h1>hi</h1>" }, "Using screen (stage)"],
    ["browser", { action: "navigate", url: "https://x.test" }, "Using browser (navigate)"],
    ["log_weight", { lbs: 180 }, "Using log weight"],
  ])("%s %j -> %s", (name, input, expected) => {
    expect(describeToolUse(name, input as Record<string, unknown>)).toBe(expected);
  });

  it("keeps lines short and ignores free-form action values", () => {
    expect(describeToolUse("mcp__x__" + "a_".repeat(60)).length).toBeLessThanOrEqual(60);
    expect(describeToolUse("notion", { action: "delete everything now please" })).toBe("Using notion");
  });
});

describe("createClaudeStreamActivityParser", () => {
  const assistantToolUse = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", id: `t-${name}`, name, input }] },
    });

  it("emits one event per tool_use as complete lines arrive, buffering partial lines", () => {
    const events: RuntimeTurnEvent[] = [];
    const parser = createClaudeStreamActivityParser((event) => events.push(event), () => 42);
    const line = assistantToolUse("Edit", { file_path: "src/media-session.ts" });

    parser.push(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
    parser.push(line.slice(0, 20));
    expect(events).toEqual([]);
    parser.push(line.slice(20) + "\n" + assistantToolUse("Bash", { command: "npm test" }) + "\n");

    expect(events).toEqual([
      { type: "tool_use", name: "Edit", activity: "Editing media-session.ts", at: 42 },
      { type: "tool_use", name: "Bash", activity: "Running npm test", at: 42 },
    ]);
  });

  it("ignores malformed lines, user/tool_result events and the final result", () => {
    const events: RuntimeTurnEvent[] = [];
    const parser = createClaudeStreamActivityParser((event) => events.push(event));
    parser.push("not json\n{\"type\":\"assistant\",\"message\":\n");
    parser.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } }) + "\n");
    parser.push(JSON.stringify({ type: "result", result: "done" }) + "\n");
    expect(events).toEqual([]);
  });

  it("flushes a trailing line without a newline", () => {
    const events: RuntimeTurnEvent[] = [];
    const parser = createClaudeStreamActivityParser((event) => events.push(event));
    parser.push(assistantToolUse("WebSearch", { query: "x" }));
    expect(events).toHaveLength(0);
    parser.flush();
    expect(events.map((event) => event.activity)).toEqual(["Searching the web"]);
  });

  it("never lets a throwing listener escape", () => {
    const parser = createClaudeStreamActivityParser(() => {
      throw new Error("observer broke");
    });
    expect(() => parser.push(assistantToolUse("Read", { file_path: "a.txt" }) + "\n")).not.toThrow();
    expect(() => emitRuntimeTurnEvent(() => { throw new Error("x"); }, {
      type: "tool_use", name: "Read", activity: "Reading a.txt", at: 1,
    })).not.toThrow();
  });
});

describe("Ollama tool loop activity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubTurns(turns: Array<Record<string, unknown>>) {
    let i = 0;
    vi.stubGlobal("fetch", (async (url: string) => {
      // The model catalog lookup is not a chat turn.
      if (!String(url).endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const message = turns[Math.min(i, turns.length - 1)];
      i++;
      return new Response(JSON.stringify({
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: message?.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch);
  }

  function toolClient(order: string[]): McpHttpToolClient {
    return {
      async listOpenAITools() {
        return [{ type: "function", function: { name: "memory_search", description: "", parameters: { type: "object" } } }];
      },
      async callTool(name: string) {
        order.push(`call:${name}`);
        return "{\"ok\":true}";
      },
    } as unknown as McpHttpToolClient;
  }

  it("reports each tool call before it runs, and a throwing observer does not break the loop", async () => {
    stubTurns([
      { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "memory_search", arguments: "{\"query\":\"x\"}" } }] },
      { content: "Found it." },
    ]);
    const order: string[] = [];
    const provider = new OllamaProvider({ apiKey: "k", toolClient: toolClient(order) });

    const response = await provider.generate({
      prompt: "find it",
      tools: { mode: "default" },
      onToolUse: (name, input) => {
        order.push(`activity:${name}:${String(input.query)}`);
        throw new Error("observer broke");
      },
    });

    expect(response.text).toBe("Found it.");
    expect(order).toEqual(["activity:memory_search:x", "call:memory_search"]);
  });
});
