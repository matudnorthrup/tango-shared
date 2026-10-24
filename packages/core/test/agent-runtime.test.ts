import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConfig } from "../src/agent-runtime.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  ClaudeCodeAdapter,
  ClaudeCodeTimeoutError,
  ISOLATED_CLAUDE_ARGS,
  isStalledClaudeRun,
  resolveIsolatedAgentWorkDir,
} from "../src/claude-code-adapter.js";
import { RuntimePool } from "../src/runtime-pool.js";

class MockChildProcess extends EventEmitter implements Partial<ChildProcessWithoutNullStreams> {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly killMock = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.killed = true;
    this.lastSignal = signal;
    if (this.closeOnSignal.has(signal)) {
      queueMicrotask(() => this.close(signal === "SIGKILL" ? null : 0, signal));
    }
    return true;
  });

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid = 12345;
  lastSignal?: NodeJS.Signals;
  stdinText = "";
  closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this.stdinText += String(chunk);
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.killMock(signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function createConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    systemPrompt: "You are the runtime.",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
        env: {
          MODE: "test",
        },
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      maxTokens: 1024,
      timeout: 1_000,
    },
    coldStartContext: "Existing context",
    ...overrides,
  };
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe("ClaudeCodeAdapter", () => {
  it("stores initialization config for later sends", async () => {
    const adapter = new ClaudeCodeAdapter();
    const config = createConfig();

    await adapter.initialize(config);

    expect((adapter as unknown as { config?: AgentRuntimeConfig }).config).toEqual(config);
    expect(adapter.active).toBe(true);
  });

  it("spawns claude with system prompt and temp MCP config file", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            is_error: false,
            result: "Hello from Claude",
            session_id: "session-1",
            tool_uses: [{ name: "mcp__memory__lookup", input: { query: "x" } }],
          }) + "\n",
        );
        child.close(0, null);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    const response = await adapter.send("Hello Claude");

    expect(response.text).toBe("Hello from Claude");
    expect(response.toolsUsed).toEqual(["mcp__memory__lookup"]);
    expect(child.stdinText).toContain("Hello Claude");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toEqual(expect.arrayContaining([
      "--verbose",
      "--output-format",
      "stream-json",
      "--append-system-prompt",
      "--mcp-config",
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "high",
      "--max-tokens",
      "1024",
    ]));

    const systemPrompt = getFlagValue(args, "--append-system-prompt");
    const mcpConfigPath = getFlagValue(args, "--mcp-config");
    expect(systemPrompt).toBe("You are the runtime.");
    expect(mcpConfigPath).toBeDefined();
    expect(JSON.parse(fs.readFileSync(mcpConfigPath!, "utf8"))).toEqual({
      mcpServers: {
        memory: {
          command: "node",
          args: ["packages/atlas-memory/dist/index.js"],
          env: {
            MODE: "test",
          },
        },
      },
    });

    await adapter.teardown();
    expect(fs.existsSync(mcpConfigPath!)).toBe(false);
  });

  it("strips built-in tools, settings, and repo context from isolated agents", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s-iso" }) + "\n",
        );
        child.close(0, null);
      });
      return child;
    });

    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tango-iso-repo-"));
    fs.mkdirSync(path.join(fakeRepo, "packages/atlas-memory/dist"), { recursive: true });
    fs.writeFileSync(path.join(fakeRepo, "packages/atlas-memory/dist/index.js"), "");
    vi.stubEnv("TANGO_REPO_DIR", fakeRepo);

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig({ agentId: "youth-test", isolated: true }));
    await adapter.send("hi");

    const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv }];
    const isolatedStart = args.indexOf("--tools");
    expect(isolatedStart).toBeGreaterThan(-1);
    expect(args.slice(isolatedStart, isolatedStart + ISOLATED_CLAUDE_ARGS.length)).toEqual([...ISOLATED_CLAUDE_ARGS]);
    expect(getFlagValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(getFlagValue(args, "--setting-sources")).toBe("");
    expect(options.cwd).toBe(resolveIsolatedAgentWorkDir("youth-test"));
    expect(fs.existsSync(options.cwd!)).toBe(true);
    expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");

    // Relative server scripts are anchored to the repo root so they still
    // resolve from the sandbox cwd.
    const mcpConfig = JSON.parse(fs.readFileSync(getFlagValue(args, "--mcp-config")!, "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(mcpConfig.mcpServers.memory.args).toEqual([
      path.join(fakeRepo, "packages/atlas-memory/dist/index.js"),
    ]);

    await adapter.teardown();
    vi.unstubAllEnvs();
    fs.rmSync(fakeRepo, { recursive: true, force: true });
  });

  it("leaves non-isolated agents on the default tool set and cwd", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s-owner" }) + "\n",
        );
        child.close(0, null);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());
    await adapter.send("hi");

    const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--tools");
    expect(options.cwd).toBeUndefined();

    await adapter.teardown();
  });

  it("preserves session id when an active run is aborted", async () => {
    const firstChild = new MockChildProcess();
    const abortedChild = new MockChildProcess();
    const resumedChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          firstChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "First response",
              session_id: "session-abc",
            }) + "\n",
          );
          firstChild.close(0, null);
        });
        return firstChild;
      })
      .mockImplementationOnce(() => abortedChild)
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          resumedChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Third response",
              session_id: "session-abc",
            }) + "\n",
          );
          resumedChild.close(0, null);
        });
        return resumedChild;
      });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    await adapter.send("First message");
    expect(adapter.getSessionId?.()).toBe("session-abc");

    const abortedSend = adapter.send("Second message");
    queueMicrotask(() => {
      adapter.abortActiveRun();
    });
    await expect(abortedSend).rejects.toMatchObject({ aborted: true });
    expect(adapter.getSessionId?.()).toBe("session-abc");

    await adapter.send("Third message");
    const thirdCall = spawnMock.mock.calls[2] as [string, string[]];
    expect(thirdCall[1]).toEqual(expect.arrayContaining(["--resume", "session-abc"]));

    await adapter.teardown();
  });

  it("uses --resume for subsequent sends after receiving a session id", async () => {
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          firstChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "First response",
              session_id: "session-abc",
            }) + "\n",
          );
          firstChild.close(0, null);
        });
        return firstChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Second response",
              session_id: "session-abc",
            }) + "\n",
          );
          secondChild.close(0, null);
        });
        return secondChild;
      });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    await adapter.send("First message");
    await adapter.send("Second message");

    const [, secondArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(secondArgs).toEqual(expect.arrayContaining(["--resume", "session-abc"]));

    await adapter.teardown();
  });

  it("injects current-turn metadata into resumed prompts without changing the system prompt", async () => {
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          firstChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "First response",
              session_id: "session-abc",
            }) + "\n",
          );
          firstChild.close(0, null);
        });
        return firstChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Second response",
              session_id: "session-abc",
            }) + "\n",
          );
          secondChild.close(0, null);
        });
        return secondChild;
      });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    await adapter.send("First message");
    const response = await adapter.send("Second message", {
      currentTurnMetadataPrompt: [
        "Current user message metadata:",
        "- local_date: Saturday, May 30, 2026",
        "- timestamp_utc: 2026-05-31T04:08:18.000Z",
      ].join("\n"),
    });

    const [, secondArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(secondArgs).toEqual(expect.arrayContaining(["--resume", "session-abc"]));
    expect(getFlagValue(secondArgs, "--append-system-prompt")).toBe("You are the runtime.");
    expect(secondChild.stdinText).toContain("Current user message metadata:");
    expect(secondChild.stdinText).toContain("Second message");
    expect(response.metadata).toMatchObject({
      currentTurnMetadataIncluded: true,
    });

    await adapter.teardown();
  });

  it("falls back to secondary Claude on authentication failure and keeps that session command", async () => {
    const primaryChild = new MockChildProcess();
    const secondaryFirstChild = new MockChildProcess();
    const secondarySecondChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          primaryChild.stdout.write(
            JSON.stringify({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "text",
                    text: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
                  },
                ],
              },
            }) + "\n",
          );
          primaryChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: true,
              session_id: "primary-session",
              error: "authentication_failed",
            }) + "\n",
          );
          primaryChild.close(1, null);
        });
        return primaryChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondaryFirstChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Recovered on secondary",
              session_id: "secondary-session",
            }) + "\n",
          );
          secondaryFirstChild.close(0, null);
        });
        return secondaryFirstChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondarySecondChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Continued on secondary",
              session_id: "secondary-session",
            }) + "\n",
          );
          secondarySecondChild.close(0, null);
        });
        return secondarySecondChild;
      });

    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      fallbackCommand: "/tmp/claude-secondary",
    });
    await adapter.initialize(createConfig());

    const firstResponse = await adapter.send("Hello Claude");
    const secondResponse = await adapter.send("Continue");

    expect(firstResponse.text).toBe("Recovered on secondary");
    expect(secondResponse.text).toBe("Continued on secondary");
    expect(adapter.getSessionId()).toBe("secondary-session");
    expect(spawnMock).toHaveBeenCalledTimes(3);

    const [firstCommand] = spawnMock.mock.calls[0] as [string, string[]];
    const [secondCommand, secondArgs] = spawnMock.mock.calls[1] as [string, string[]];
    const [thirdCommand, thirdArgs] = spawnMock.mock.calls[2] as [string, string[]];
    expect(firstCommand).toBe("claude");
    expect(secondCommand).toBe("/tmp/claude-secondary");
    expect(secondArgs).not.toContain("--resume");
    expect(thirdCommand).toBe("/tmp/claude-secondary");
    expect(thirdArgs).toEqual(expect.arrayContaining(["--resume", "secondary-session"]));
  });

  it("falls back to secondary Claude on a usage-limit failure", async () => {
    const primaryChild = new MockChildProcess();
    const secondaryChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          primaryChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: true,
              result: "Claude AI usage limit reached|1754500000",
            }) + "\n",
          );
          primaryChild.close(1, null);
        });
        return primaryChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondaryChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Recovered on secondary quota",
              session_id: "secondary-session",
            }) + "\n",
          );
          secondaryChild.close(0, null);
        });
        return secondaryChild;
      });

    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      fallbackCommand: "/tmp/claude-secondary",
    });
    await adapter.initialize(createConfig());

    const response = await adapter.send("Hello Claude");

    expect(response.text).toBe("Recovered on secondary quota");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [primaryCommand] = spawnMock.mock.calls[0] as [string, string[]];
    const [secondaryCommand] = spawnMock.mock.calls[1] as [string, string[]];
    expect(primaryCommand).toBe("claude");
    expect(secondaryCommand).toBe("/tmp/claude-secondary");
  });

  it("surfaces the usage-limit text when no fallback command is configured", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            is_error: true,
            result: "Claude AI usage limit reached|1754500000",
          }) + "\n",
        );
        child.close(1, null);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      fallbackCommand: null,
    });
    await adapter.initialize(createConfig());

    await expect(adapter.send("Hello Claude")).rejects.toThrow(/usage limit reached/iu);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await adapter.teardown();
  });

  it("falls back to secondary Claude when the primary request times out", async () => {
    vi.useFakeTimers();

    const primaryChild = new MockChildProcess();
    primaryChild.closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);
    const secondaryChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => primaryChild)
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondaryChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Recovered after primary timeout",
              session_id: "secondary-session",
            }) + "\n",
          );
          secondaryChild.close(0, null);
        });
        return secondaryChild;
      });

    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      fallbackCommand: "/tmp/claude-secondary",
    });
    await adapter.initialize(createConfig({
      runtimePreferences: { timeout: 50 },
    }));

    const sendPromise = adapter.send("This will stall on primary");
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(sendPromise).resolves.toMatchObject({
      text: "Recovered after primary timeout",
    });
    expect(primaryChild.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const [primaryCommand] = spawnMock.mock.calls[0] as [string, string[]];
    const [secondaryCommand, secondaryArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(primaryCommand).toBe("claude");
    expect(secondaryCommand).toBe("/tmp/claude-secondary");
    expect(secondaryArgs).not.toContain("--resume");

    await adapter.teardown();
  });

  it("does not retry a timed-out run on the secondary CLI while a tool is still running", async () => {
    vi.useFakeTimers();

    const primaryChild = new MockChildProcess();
    primaryChild.closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        primaryChild.stdout.write(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
          }) + "\n",
        );
      });
      return primaryChild;
    });

    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      fallbackCommand: "/tmp/claude-secondary",
    });
    await adapter.initialize(createConfig({
      runtimePreferences: { timeout: 50 },
    }));

    const sendPromise = adapter.send("Sweep every metro for listings");
    const rejection = expect(sendPromise).rejects.toMatchObject({
      name: "ClaudeCodeTimeoutError",
      stalled: false,
      timeoutMs: 50,
    });
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(primaryChild.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await adapter.teardown();
  });

  it("surfaces Claude authentication details when no fallback command is configured", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
                },
              ],
            },
          }) + "\n",
        );
        child.stdout.write(
          JSON.stringify({
            type: "result",
            is_error: true,
            error: "authentication_failed",
          }) + "\n",
        );
        child.close(1, null);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter({
      command: "claude",
      fallbackCommand: null,
    });
    await adapter.initialize(createConfig());

    await expect(adapter.send("Hello Claude")).rejects.toThrow(/Failed to authenticate|authentication_failed/u);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await adapter.teardown();
  });

  it("returns false from healthCheck when no process is running", async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    await expect(adapter.healthCheck()).resolves.toBe(false);

    await adapter.teardown();
  });

  it("teardown sends SIGTERM and then SIGKILL when the process does not exit", async () => {
    vi.useFakeTimers();

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    const child = new MockChildProcess();
    child.closeOnSignal = new Set<NodeJS.Signals>(["SIGKILL"]);
    (adapter as unknown as { child?: MockChildProcess; stateValue: string }).child = child;
    (adapter as unknown as { child?: MockChildProcess; stateValue: string }).stateValue = "active";

    const teardownPromise = adapter.teardown();
    expect(child.killMock).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(TEARDOWN_WAIT_MS);
    expect(child.killMock).toHaveBeenCalledWith("SIGKILL");

    await teardownPromise;
    expect(adapter.active).toBe(false);
  });

  it("times out a send and terminates the child process", async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    child.closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);
    spawnMock.mockImplementation(() => child);

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig({
      runtimePreferences: {
        timeout: 50,
      },
    }));

    const sendPromise = adapter.send("This will hang");
    const sendExpectation = expect(sendPromise).rejects.toThrow(/timed out/u);
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(child.killMock).toHaveBeenCalledWith("SIGTERM");

    await sendExpectation;
    await adapter.teardown();
  });

  it("keeps a send running when its timeout is explicitly disabled", async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    child.closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);
    spawnMock.mockImplementation(() => child);

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig({
      runtimePreferences: {
        timeout: 0,
      },
    }));

    const sendPromise = adapter.send("Keep working");
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(child.killMock).not.toHaveBeenCalled();
    adapter.abortActiveRun();
    await expect(sendPromise).rejects.toMatchObject({ aborted: true });
    await adapter.teardown();
  });
});

describe("RuntimePool", () => {
  it("returns the same runtime instance for the same conversation key", async () => {
    const pool = new RuntimePool();
    const config = createConfig();

    const first = await pool.getOrCreate("conversation-1", config);
    const second = await pool.getOrCreate("conversation-1", config);

    expect(first).toBe(second);

    await pool.closeAll();
  });

  it("removes a runtime when close is called", async () => {
    const pool = new RuntimePool();
    const config = createConfig();

    await pool.getOrCreate("conversation-1", config);
    expect(pool.get("conversation-1")).toBeDefined();

    await pool.close("conversation-1");

    expect(pool.get("conversation-1")).toBeUndefined();
    expect(pool.size).toBe(0);
  });

  it("closes all runtimes and clears the pool", async () => {
    const pool = new RuntimePool();
    const config = createConfig();

    await pool.getOrCreate("conversation-1", config);
    await pool.getOrCreate("conversation-2", config);

    expect(pool.keys()).toEqual(["conversation-1", "conversation-2"]);

    await pool.closeAll();

    expect(pool.keys()).toEqual([]);
    expect(pool.size).toBe(0);
  });
});

const TEARDOWN_WAIT_MS = 5_000;

describe("isStalledClaudeRun", () => {
  const line = (event: unknown) => `${JSON.stringify(event)}\n`;
  const toolUse = line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
  });
  const toolResult = line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  });

  it("treats a run with no assistant or tool events as stalled", () => {
    expect(isStalledClaudeRun(line({ type: "system", subtype: "init" }), 0)).toBe(true);
    expect(isStalledClaudeRun("", 0)).toBe(true);
  });

  it("treats a run with a tool in flight as working, however long it has been quiet", () => {
    expect(isStalledClaudeRun(toolUse, 600_000)).toBe(false);
  });

  it("treats a run with no tool in flight as stalled only after a long silence", () => {
    expect(isStalledClaudeRun(toolUse + toolResult, 30_000)).toBe(false);
    expect(isStalledClaudeRun(toolUse + toolResult, 300_000)).toBe(true);
  });

  it("keeps the timeout message shape the failure classifier matches", () => {
    expect(new ClaudeCodeTimeoutError(900_000, false).message).toMatch(
      /^Claude Code request timed out after 900000ms\./u,
    );
  });
});

describe("ClaudeCodeAdapter live activity", () => {
  it("emits tool_use activity while the CLI is still running and keeps the final parse", async () => {
    const child = new MockChildProcess();
    const events: string[] = [];
    let eventsBeforeClose: string[] = [];
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        const toolUse = JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/media-session.ts" } }] },
        });
        // Split mid-line: the activity must wait for the newline.
        child.stdout.write(toolUse.slice(0, 15));
        child.stdout.write(`${toolUse.slice(15)}\n`);
        child.stdout.write(`${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t2", name: "mcp__memory__memory_search", input: { query: "x" } }] },
        })}\n`);
        setTimeout(() => {
          eventsBeforeClose = [...events];
          child.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "All set", session_id: "session-1" })}\n`);
          child.close(0, null);
        }, 5);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());
    const response = await adapter.send("Fix it", { onEvent: (event) => events.push(event.activity) });

    expect(eventsBeforeClose).toEqual(["Editing media-session.ts", "Using memory search"]);
    expect(events).toEqual(["Editing media-session.ts", "Using memory search"]);
    expect(response.text).toBe("All set");
    expect(response.metadata?.sessionId).toBe("session-1");
  });

  it("runs unchanged with a throwing listener", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
        })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s" })}\n`);
        child.close(0, null);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());
    const response = await adapter.send("go", { onEvent: () => { throw new Error("observer broke"); } });
    expect(response.text).toBe("ok");
  });
});
