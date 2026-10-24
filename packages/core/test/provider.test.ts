import { describe, expect, it } from "vitest";
import {
  buildClaudeCliArgs,
  buildCodexExecArgs,
  buildOllamaChatBody,
  parseClaudePrintJson,
  composeVisibleReply,
  parseCodexExecJson,
  parseOllamaChatResponse,
  summarizeClaudeCliFailureStdout
} from "../src/provider.js";

describe("parseClaudePrintJson", () => {
  it("parses a claude JSON result line", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"result","is_error":false,"result":"hello world","session_id":"abc-123"}\n'
    );

    expect(parsed.text).toBe("hello world");
    expect(parsed.providerSessionId).toBe("abc-123");
  });

  it("uses the last JSON line when output has prelude noise", () => {
    const parsed = parseClaudePrintJson(
      "Warning: something\n" +
        '{"type":"result","is_error":false,"result":"ignored","session_id":"one"}\n' +
        '{"type":"result","is_error":false,"result":"final answer","session_id":"two"}\n'
    );

    expect(parsed.text).toBe("final answer");
    expect(parsed.providerSessionId).toBe("two");
  });

  it("extracts normalized tool calls from Claude stream-json assistant events", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"system","subtype":"init","session_id":"sess-1"}\n' +
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ToolSearch","input":{"query":"select:mcp__example__read_status"}}]}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__example__read_status","input":{"scope":"planner"}}]}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Status read."}]}}\n' +
        '{"type":"result","is_error":false,"result":"Status read.","session_id":"sess-1"}\n'
    );

    expect(parsed.text).toBe("Status read.");
    expect(parsed.providerSessionId).toBe("sess-1");
    expect(parsed.toolCalls).toEqual([
      {
        name: "ToolSearch",
        input: {
          query: "select:mcp__example__read_status",
        },
        output: undefined,
        serverName: undefined,
        toolName: "ToolSearch",
      },
      {
        name: "mcp__example__read_status",
        input: {
          scope: "planner",
        },
        output: undefined,
        serverName: undefined,
        toolName: "mcp__example__read_status",
      },
    ]);
  });

  it("does not count init-event MCP server entries or config records as tool calls", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"system","subtype":"init","session_id":"sess-1","mcp_servers":[{"name":"location","status":"connected"},{"name":"walmart","status":"connected"}],"tools":["Bash","mcp__location__find_diesel"]}\n' +
        '{"type":"system","subtype":"config","servers":[{"name":"exa","command":"node","args":["/tmp/exa-server.js"]}]}\n' +
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__location__find_diesel","input":{"destination":"Costco, Fairview, SC","near":true}}]}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Found it."}]}}\n' +
        '{"type":"result","is_error":false,"result":"Found it.","session_id":"sess-1"}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__location__find_diesel",
        input: {
          destination: "Costco, Fairview, SC",
          near: true,
        },
        output: undefined,
        serverName: undefined,
        toolName: "mcp__location__find_diesel",
      },
    ]);
  });

  it("extracts normalized tool calls from Claude result payloads", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"result","is_error":false,"result":"done","session_id":"abc-123","tool_uses":[{"name":"mcp__example__read_status","input":{"scope":"planner"}}]}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__example__read_status",
        input: {
          scope: "planner",
        },
        output: undefined,
        serverName: undefined,
        toolName: "mcp__example__read_status",
      },
    ]);
  });

  it("throws when no valid result JSON is present", () => {
    expect(() => parseClaudePrintJson("not-json\n")).toThrow(
      "Failed to parse Claude CLI JSON output"
    );
  });

  it("extracts peak per-call context occupancy and window from the message stream", () => {
    // Two internal model calls; occupancy = input + cache_read + cache_creation
    // per call. The peak (call 2 = 91012) is the true high-water occupancy, not
    // the cross-call sum that modelUsage would report.
    const stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "working" }], usage: { input_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 35742, output_tokens: 7 } } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 12, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, output_tokens: 20 } } },
      { type: "result", is_error: false, result: "done", session_id: "abc", num_turns: 2, modelUsage: { "claude-haiku-4-5": { inputTokens: 21, outputTokens: 27, cacheReadInputTokens: 90000, cacheCreationInputTokens: 36742, contextWindow: 200000 } } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";

    const parsed = parseClaudePrintJson(stream);
    expect(parsed.metadata?.contextOccupancyTokens).toBe(91012);
    expect(parsed.metadata?.contextWindowTokens).toBe(200000);
  });

  it("reports the context-carrying model when Claude Code includes auxiliary model usage", () => {
    const parsed = parseClaudePrintJson(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "done",
        session_id: "abc",
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 3114,
            outputTokens: 14,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          "claude-opus-4-8": {
            inputTokens: 2,
            outputTokens: 25,
            cacheReadInputTokens: 15112,
            cacheCreationInputTokens: 21706,
            contextWindow: 1000000,
          },
        },
      }) + "\n",
    );

    expect(parsed.metadata?.model).toBe("claude-opus-4-8");
    expect(parsed.metadata?.contextWindowTokens).toBe(1000000);
  });

  it("reports the OBSERVED primary model, not whichever modelUsage key comes first", () => {
    // The CLI lists every model it touched this turn in arbitrary order,
    // internal helper models included, so key order is not a meaningful
    // signal. Primary = highest costUSD, with output tokens breaking exact
    // cost ties only. This fixture is deliberately discriminating: the
    // helper model is first-listed, holds the most CACHED tokens (so a
    // cached-context selector picks it, wrongly) and the most OUTPUT tokens
    // (so a weighted cost+tokens score picks it, wrongly). Only a true
    // cost-first comparison names the model that did the work.
    const parsed = parseClaudePrintJson(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "done",
        session_id: "abc",
        num_turns: 1,
        modelUsage: {
          "claude-haiku-4-5-20251001": { inputTokens: 521, outputTokens: 60000, cacheReadInputTokens: 90000, costUSD: 0.0008 },
          "claude-sonnet-5": { inputTokens: 10, outputTokens: 390, costUSD: 0.05 },
        },
      }) + "\n",
    );

    expect(parsed.metadata?.model).toBe("claude-sonnet-5");
  });
});

describe("parseClaudePrintJson error results", () => {
  it("preserves the CLI's failure text in the is_error throw", () => {
    expect(() =>
      parseClaudePrintJson(
        '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1754500000"}\n',
      ),
    ).toThrow(/Claude AI usage limit reached/u);
  });

  it("keeps the generic message when the error result has no text", () => {
    expect(() =>
      parseClaudePrintJson('{"type":"result","is_error":true}\n'),
    ).toThrow("Claude CLI returned an error result");
  });
});

describe("summarizeClaudeCliFailureStdout", () => {
  it("extracts result/error text from JSON-line output", () => {
    const summary = summarizeClaudeCliFailureStdout(
      '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1754500000"}\n',
    );
    expect(summary).toContain("Claude AI usage limit reached");
  });

  it("falls back to raw non-JSON lines", () => {
    expect(summarizeClaudeCliFailureStdout("plain failure text\n")).toBe("plain failure text");
  });

  it("returns undefined for empty output", () => {
    expect(summarizeClaudeCliFailureStdout("")).toBeUndefined();
    expect(summarizeClaudeCliFailureStdout("\n\n")).toBeUndefined();
  });
});

describe("buildClaudeCliArgs", () => {
  it("disables tools by default", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "hello"
      },
      { defaultModel: "claude-sonnet-4-6" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--model",
      "claude-sonnet-4-6",
      "hello"
    ]);
  });

  it("enables default toolset when requested", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "weather now",
        tools: { mode: "default" }
      },
      { defaultModel: "claude-sonnet-4-6" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "default",
      "--model",
      "claude-sonnet-4-6",
      "weather now"
    ]);
  });

  it("supports allowlisted tools", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "check weather",
        tools: {
          mode: "allowlist",
          allowlist: ["Bash(curl:*)", "WebSearch", "WebSearch"],
        },
        providerSessionId: "sess-1",
        systemPrompt: "You are Watson."
      },
      { defaultModel: "claude-sonnet-4-6", mcpConfigPath: "/tmp/dispatch.json" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "default",
      "--allowedTools",
      "Bash(curl:*)",
      "WebSearch",
      "--mcp-config",
      "/tmp/dispatch.json",
      "--resume",
      "sess-1",
      "--system-prompt",
      "You are Watson.",
      "--model",
      "claude-sonnet-4-6",
      "check weather"
    ]);
  });

  it("lets request model and reasoning effort override provider defaults", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "think it through",
        model: "claude-opus-4-8",
        reasoningEffort: "xhigh",
      },
      { defaultModel: "claude-sonnet-4-6", defaultReasoningEffort: "medium" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "max",
      "think it through"
    ]);
  });

  it("throws on empty allowlist mode", () => {
    expect(() =>
      buildClaudeCliArgs(
        {
          prompt: "test",
          tools: { mode: "allowlist", allowlist: [] }
        },
        { defaultModel: "claude-sonnet-4-6" }
      )
    ).toThrow(/requires at least one tool/u);
  });
});

describe("parseCodexExecJson", () => {
  it("parses codex jsonl output with thread + final agent message", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"turn.started"}\n' +
        '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":7,"output_tokens":3}}\n'
    );

    expect(parsed.providerSessionId).toBe("thread-123");
    expect(parsed.text).toBe("hello from codex");
    expect(parsed.metadata?.usage).toEqual({
      inputTokens: 11,
      cacheReadInputTokens: 7,
      outputTokens: 3
    });
  });

  it("extracts Codex MCP tool calls from completed mcp_tool_call events", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"wellness","tool":"health_query","arguments":{"command":"recovery","date":"today"},"result":null,"error":null,"status":"in_progress"}}\n' +
        '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"wellness","tool":"health_query","arguments":{"command":"recovery","date":"today"},"result":{"ok":true},"error":null,"status":"completed"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":7,"output_tokens":3}}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__wellness__health_query",
        toolName: "health_query",
        serverName: "wellness",
        input: {
          command: "recovery",
          date: "today",
        },
        output: { ok: true },
      },
    ]);
  });

  it("extracts failed Codex MCP tool calls with error payloads", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"wellness","tool":"health_query","arguments":{"command":"recovery","date":"today"},"result":null,"error":{"message":"user cancelled MCP tool call"},"status":"failed"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":7,"output_tokens":3}}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__wellness__health_query",
        toolName: "health_query",
        serverName: "wellness",
        input: {
          command: "recovery",
          date: "today",
        },
        output: { message: "user cancelled MCP tool call" },
      },
    ]);
  });

  it("extracts completed MCP tool calls into normalized toolCalls", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"turn.started"}\n' +
        '{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"example","tool":"read_status","arguments":{"scope":"planner"},"result":null,"error":null,"status":"in_progress"}}\n' +
        '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"example","tool":"read_status","arguments":{"scope":"planner"},"result":{"content":[{"type":"text","text":"ok"}]},"error":null,"status":"completed"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__example__read_status",
        input: {
          scope: "planner",
        },
        output: {
          content: [
            {
              type: "text",
              text: "ok",
            },
          ],
        },
        serverName: "example",
        toolName: "read_status",
      },
    ]);
  });

  it("throws when no agent message is present", () => {
    expect(() =>
      parseCodexExecJson(
        '{"type":"thread.started","thread_id":"thread-123"}\n' +
          '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}\n'
      )
    ).toThrow("Codex CLI returned an empty response");
  });
});

describe("buildCodexExecArgs", () => {
  it("uses codex exec with safe defaults and no search when tools are off", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "hello",
        tools: { mode: "off" }
      },
      {
        defaultModel: "gpt-5-codex",
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5-codex",
      "hello"
    ]);
  });

  it("enables search for default tool mode", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "weather in london",
        tools: { mode: "default" }
      },
      {
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "--search",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "weather in london"
    ]);
  });

  it("uses resume path and embeds system prompt", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "Give me a one line summary",
        providerSessionId: "thread-abc",
        systemPrompt: "You are Watson."
      },
      {
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "thread-abc",
      "System instructions:\nYou are Watson.\n\nUser request:\nGive me a one line summary"
    ]);
  });

  it("injects MCP server config overrides for codex", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "use configured mcp",
        tools: {
          mode: "allowlist",
          allowlist: ["WebSearch", "mcp__example__read_status"],
          mcpServers: {
            example: {
              command: "/usr/bin/env",
              args: ["node", "/tmp/mcp-example-server.js"],
              env: {
                EXAMPLE_SCOPE: "planner",
              },
            },
          },
        },
      },
      {
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "--search",
      "-c",
      "mcp_servers.example.command=\"/usr/bin/env\"",
      "-c",
      "mcp_servers.example.args=[\"node\",\"/tmp/mcp-example-server.js\"]",
      "-c",
      "mcp_servers.example.env={EXAMPLE_SCOPE=\"planner\"}",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "use configured mcp"
    ]);
  });

  it("uses request model overrides and explicit reasoning effort for codex", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "summarize this",
        model: "gpt-5.4-mini",
        reasoningEffort: "max",
        tools: { mode: "off" },
      },
      {
        defaultModel: "gpt-5.4",
        defaultReasoningEffort: "medium",
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-mini",
      "summarize this"
    ]);
  });
});

describe("buildOllamaChatBody", () => {
  it("includes a system message and a user message when systemPrompt is set", () => {
    const body = buildOllamaChatBody({
      prompt: "ping",
      systemPrompt: "You are Watson."
    });

    expect(body).toEqual({
      model: "deepseek-v4-pro:cloud",
      messages: [
        { role: "system", content: "You are Watson." },
        { role: "user", content: "ping" }
      ],
      stream: false
    });
  });

  it("omits the system message when systemPrompt is absent", () => {
    const body = buildOllamaChatBody({ prompt: "ping" });

    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(body.stream).toBe(false);
  });

  it("prefers request.model over defaultModel over the built-in default", () => {
    expect(
      buildOllamaChatBody({ prompt: "ping", model: "qwen3:cloud" }, { defaultModel: "llama4:cloud" })
        .model
    ).toBe("qwen3:cloud");

    expect(
      buildOllamaChatBody({ prompt: "ping" }, { defaultModel: "llama4:cloud" }).model
    ).toBe("llama4:cloud");

    expect(buildOllamaChatBody({ prompt: "ping" }).model).toBe("deepseek-v4-pro:cloud");
  });

  it("emits OpenAI image_url content parts when images are present", () => {
    const body = buildOllamaChatBody({
      prompt: "What is in this image?",
      images: [{ dataBase64: "QUJD", mediaType: "image/png" }],
    });

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      },
    ]);
  });

  it("keeps a plain string user message when no images are present", () => {
    const body = buildOllamaChatBody({ prompt: "no image here" });
    expect(body.messages).toEqual([{ role: "user", content: "no image here" }]);
  });
});

describe("parseOllamaChatResponse", () => {
  const samplePayload = {
    id: "chatcmpl-308",
    model: "deepseek-v4-pro:cloud",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "pong",
          reasoning: "the user said ping"
        },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 11, completion_tokens: 38, total_tokens: 49 }
  };

  it("maps the OpenAI-compatible response shape into a ProviderResponse", () => {
    const parsed = parseOllamaChatResponse(samplePayload);

    expect(parsed.text).toBe("pong");
    expect(parsed.metadata?.model).toBe("deepseek-v4-pro:cloud");
    expect(parsed.metadata?.stopReason).toBe("stop");
    expect(parsed.metadata?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 38
    });
    expect(parsed.raw).toBe(samplePayload);
  });

  it("throws when content is empty", () => {
    expect(() =>
      parseOllamaChatResponse({
        choices: [{ message: { role: "assistant", content: "   " } }]
      })
    ).toThrow("Ollama returned an empty response");
  });

  it("throws when content is missing", () => {
    expect(() =>
      parseOllamaChatResponse({
        choices: [{ message: { role: "assistant" } }]
      })
    ).toThrow("Ollama returned an empty response");
  });

  it("keeps DeepSeek reasoning only in raw, never in text", () => {
    const parsed = parseOllamaChatResponse(samplePayload);

    expect(parsed.text).toBe("pong");
    expect(parsed.text).not.toContain("the user said ping");
    const raw = parsed.raw as typeof samplePayload;
    expect(raw.choices[0]?.message.reasoning).toBe("the user said ping");
  });
});

describe("composeVisibleReply", () => {
  const answer = "Here is the full worked thought record. ".repeat(10).trim();

  it("keeps a lone final block", () => {
    expect(composeVisibleReply(["Just the answer."])).toBe("Just the answer.");
  });

  it("drops short preambles before a tool call", () => {
    expect(composeVisibleReply(["Let me check your buckets!", answer])).toBe(answer);
  });

  it("rescues a substantive answer that a post-tool sign-off would hide", () => {
    expect(composeVisibleReply([answer, "Saved."])).toBe(`${answer}\n\nSaved.`);
  });

  it("keeps a long final block on its own", () => {
    const longFinal = "Final synthesis. ".repeat(40).trim();
    expect(composeVisibleReply([answer, longFinal])).toBe(longFinal);
  });
});

describe("parseClaudePrintJson visible reply", () => {
  it("does not lose the answer when the model signs off after a tool call", () => {
    const answer = "Worked example: situation, emotion, automatic thought, evidence. ".repeat(5).trim();
    const lines = [
      { type: "assistant", message: { content: [{ type: "text", text: answer }, { type: "tool_use", id: "t1", name: "memory_add", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Saved." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Saved.", session_id: "s1" },
    ];
    const parsed = parseClaudePrintJson(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(parsed.text).toBe(`${answer}\n\nSaved.`);
  });
});
