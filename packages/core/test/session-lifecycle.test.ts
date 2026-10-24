import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  RuntimeResponse,
  SendOptions,
} from "../src/agent-runtime.js";
import { selectMcpServersForTurn } from "../src/mcp-mounting.js";
import { SessionLifecycleManager } from "../src/session-lifecycle.js";
import type { RuntimePool } from "../src/runtime-pool.js";

function createConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    systemPrompt: "You are the session runtime.",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["memory.js"],
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
      timeout: 1_000,
    },
    ...overrides,
  };
}

function createResponse(
  text: string,
  options: {
    sessionId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): RuntimeResponse {
  const metadata: Record<string, unknown> = {
    ...(options.metadata ?? {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };

  return {
    text,
    durationMs: 25,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

class MockRuntime implements AgentRuntime {
  readonly type = "claude-code" as const;
  active = true;
  sessionId?: string;
  readonly queuedResponses: RuntimeResponse[] = [];
  readonly sentMessages: string[] = [];

  readonly send = vi.fn(async (message: string, _options?: SendOptions) => {
    this.sentMessages.push(message);
    const response = this.queuedResponses.shift();
    if (!response) {
      throw new Error(`No queued response for ${this.id}.`);
    }

    const sessionId = typeof response.metadata?.sessionId === "string"
      ? response.metadata.sessionId
      : undefined;
    if (sessionId) {
      this.sessionId = sessionId;
    }

    return response;
  });

  readonly initialize = vi.fn(async (_config: AgentRuntimeConfig) => {
    this.active = true;
  });

  readonly teardown = vi.fn(async () => {
    this.active = false;
  });

  readonly healthCheck = vi.fn(async () => this.active);
  readonly getSessionId = vi.fn(() => this.sessionId);
  readonly resumeSession = vi.fn((sessionId: string) => {
    this.sessionId = sessionId;
  });
  readonly abortActiveRun = vi.fn(() => false);

  constructor(readonly id: string) {}

  queueResponse(response: RuntimeResponse): void {
    this.queuedResponses.push(response);
  }
}

class MockRuntimePool {
  readonly resetSession = vi.fn((_conversationKey: string, _config: AgentRuntimeConfig) => {});
  readonly getOrCreateCalls: Array<{ conversationKey: string; config: AgentRuntimeConfig }> = [];
  readonly closeCalls: string[] = [];
  closeAllCalls = 0;

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly queuedRuntimes: MockRuntime[] = [];
  private createdRuntimeCount = 0;

  enqueueRuntime(runtime: MockRuntime): MockRuntime {
    this.queuedRuntimes.push(runtime);
    return runtime;
  }

  get(conversationKey: string): AgentRuntime | undefined {
    return this.runtimes.get(conversationKey);
  }

  async getOrCreate(conversationKey: string, config: AgentRuntimeConfig): Promise<AgentRuntime> {
    this.getOrCreateCalls.push({
      conversationKey,
      config,
    });

    const existing = this.runtimes.get(conversationKey);
    if (existing) {
      return existing;
    }

    const runtime = this.queuedRuntimes.shift() ?? new MockRuntime(`runtime-${++this.createdRuntimeCount}`);
    this.runtimes.set(conversationKey, runtime);
    return runtime;
  }

  async close(conversationKey: string): Promise<void> {
    this.closeCalls.push(conversationKey);
    const runtime = this.runtimes.get(conversationKey);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(conversationKey);
    await runtime.teardown();
  }

  async closeAll(): Promise<void> {
    this.closeAllCalls += 1;

    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();

    await Promise.all(runtimes.map(async (runtime) => {
      await runtime.teardown();
    }));
  }

  keys(): string[] {
    return [...this.runtimes.keys()];
  }

  get size(): number {
    return this.runtimes.size;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionLifecycleManager", () => {
  it("creates a new session on the first send", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    const response = await manager.sendMessage("conversation-1", createConfig(), "hello");

    expect(response.text).toBe("First reply");
    expect(builder).toHaveBeenCalledWith("conversation-1", "agent-1");
    expect(pool.getOrCreateCalls).toHaveLength(1);
    expect(pool.getOrCreateCalls[0]?.config.coldStartContext).toBe(
      "Pinned facts:\nPinned fact A\n\nRecent conversation:\nRecent summary A\n\nRelevant memories:\nMemory hit A",
    );

    expect(manager.getSession("conversation-1")).toMatchObject({
      conversationKey: "conversation-1",
      agentId: "agent-1",
      state: "idle",
      messageCount: 1,
      sessionId: "session-1",
    });
  });

  it("reuses an existing session on subsequent sends", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.queueResponse(createResponse("Second reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage("conversation-1", createConfig(), "again");

    expect(pool.getOrCreateCalls).toHaveLength(1);
    expect(runtime.send).toHaveBeenCalledTimes(2);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(manager.getSession("conversation-1")?.messageCount).toBe(2);
  });

  it("rotates the provider session when the mounted MCP server set changes", async () => {
    const pool = new MockRuntimePool();
    const firstRuntime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const secondRuntime = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    firstRuntime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    secondRuntime.queueResponse(createResponse("Second reply", { sessionId: "session-2" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage(
      "conversation-1",
      createConfig({
        mcpServers: [
          {
            name: "memory",
            command: "node",
            args: ["memory.js"],
          },
          {
            name: "attachments",
            command: "node",
            args: ["attachments.js"],
          },
        ],
      }),
      "read the attachment",
    );

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(firstRuntime.teardown).toHaveBeenCalledTimes(1);
    expect(secondRuntime.resumeSession).not.toHaveBeenCalled();
    expect(manager.getSession("conversation-1")).toMatchObject({
      state: "idle",
      sessionId: "session-2",
      messageCount: 1,
      mcpServerNames: ["memory", "attachments"],
    });
  });

  it.each([
    ["Draft an email", "Approved, send it"],
    ["Hello", "Draft an email"],
  ])("resumes across lazy MCP mounting changes: %s → %s", async (first, second) => {
    const pool = new MockRuntimePool();
    const firstRuntime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const secondRuntime = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    firstRuntime.queueResponse(createResponse("Draft ready", { sessionId: "session-1" }));
    // Do not supply an ID: the second runtime must get it from resumeSession.
    secondRuntime.queueResponse(createResponse("Done"));
    const builder = vi.fn(async () => ({
      pinnedFacts: "", recentMessages: "", relevantMemories: "",
    }));
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool, undefined, builder);
    const config = createConfig({
      availableMcpServers: [{ name: "google", command: "node", args: ["google.js"] }],
    });
    const firstConfig = selectMcpServersForTurn(config, { message: first }).config;
    const secondConfig = selectMcpServersForTurn(config, { message: second }).config;
    expect(firstConfig.mcpServers).not.toEqual(secondConfig.mcpServers);

    await manager.sendMessage("conversation-1", firstConfig, first);
    await manager.sendMessage("conversation-1", secondConfig, second);

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(pool.getOrCreateCalls[1].config.mcpServers).toEqual(secondConfig.mcpServers);
    expect(secondRuntime.resumeSession).toHaveBeenCalledWith("session-1");
    expect(builder).toHaveBeenCalledTimes(1);
    expect(manager.getSession("conversation-1")).toMatchObject({
      sessionId: "session-1", messageCount: 2,
      mcpServerNames: secondConfig.mcpServers.map((server) => server.name),
    });
  });

  it.each<[string, Partial<AgentRuntimeConfig>]>([
    ["system prompt", { systemPrompt: "A different prompt" }],
    ["runtime preferences", { runtimePreferences: { model: "different-model" } }],
    ["backend", { backend: "ollama" }],
    ["isolation", { isolated: true }],
    ["default server configuration", {
      mcpServers: [{ name: "memory", command: "node", args: ["new-memory.js"] }],
    }],
    ["default server removal", { mcpServers: [] }],
  ])("starts fresh when %s changes alongside lazy mounting", async (_label, overrides) => {
    const pool = new MockRuntimePool();
    const firstRuntime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const secondRuntime = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    firstRuntime.queueResponse(createResponse("First", { sessionId: "session-1" }));
    secondRuntime.queueResponse(createResponse("Second", { sessionId: "session-2" }));
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);
    const config = createConfig({
      availableMcpServers: [{ name: "google", command: "node", args: ["google.js"] }],
    });
    await manager.sendMessage("conversation-1",
      selectMcpServersForTurn(config, { message: "Draft an email" }).config, "Draft an email");
    await manager.sendMessage("conversation-1",
      selectMcpServersForTurn({ ...config, ...overrides }, { message: "Approved" }).config, "Approved");

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(secondRuntime.resumeSession).not.toHaveBeenCalled();
    expect(manager.getSession("conversation-1")).toMatchObject({ sessionId: "session-2", messageCount: 1 });
  });

  it("starts fresh after a closed session's default server changes, even if also available lazily", async () => {
    const pool = new MockRuntimePool();
    const firstRuntime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const secondRuntime = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    firstRuntime.queueResponse(createResponse("First", { sessionId: "session-1" }));
    secondRuntime.queueResponse(createResponse("Second", { sessionId: "session-2" }));
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);
    const config = createConfig({ availableMcpServers: createConfig().mcpServers });
    await manager.sendMessage("conversation-1",
      selectMcpServersForTurn(config, { message: "Hello" }).config, "Hello");
    await manager.closeSession("conversation-1");
    const changedConfig = { ...config, mcpServers: [{ name: "memory", command: "new-command" }] };
    await manager.sendMessage("conversation-1",
      selectMcpServersForTurn(changedConfig, { message: "Again" }).config, "Again");

    expect(secondRuntime.resumeSession).not.toHaveBeenCalled();
    expect(manager.getSession("conversation-1")).toMatchObject({ sessionId: "session-2", messageCount: 1 });
  });

  it("includes attachment directory context in cold-start context", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "",
      recentMessages: "",
      relevantMemories: "Memory hit A",
      attachmentDirectories: "Relevant attachment directories:\n- attachment:1 \"Launch Screenshot\"",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");

    expect(pool.getOrCreateCalls[0]?.config.coldStartContext).toBe(
      "Relevant memories:\nMemory hit A\n\nAttachment directories:\nRelevant attachment directories:\n- attachment:1 \"Launch Screenshot\"",
    );
  });

  it("omits per-turn context once a runtime has a provider session", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.queueResponse(createResponse("Second reply", { sessionId: "session-1" }));

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    await manager.sendMessage(
      "conversation-1",
      createConfig(),
      "hello",
      {
        context: "Warm-start context A",
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:08:18.000Z",
        turnBriefingPrompt: "Session briefing (act on this every turn):\n- Search first A",
        timeout: 1_000,
      },
    );
    await manager.sendMessage(
      "conversation-1",
      createConfig(),
      "again",
      {
        context: "Warm-start context B",
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:09:18.000Z",
        turnBriefingPrompt: "Session briefing (act on this every turn):\n- Search first B",
        timeout: 2_000,
      },
    );

    expect(runtime.send).toHaveBeenNthCalledWith(
      1,
      "hello",
      {
        context: "Warm-start context A",
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:08:18.000Z",
        turnBriefingPrompt: "Session briefing (act on this every turn):\n- Search first A",
        timeout: 1_000,
      },
    );
    // On the resumed turn, warm-start `context` is dropped but the briefing
    // ("whisper") and current-turn metadata are preserved.
    expect(runtime.send).toHaveBeenNthCalledWith(
      2,
      "again",
      {
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:09:18.000Z",
        turnBriefingPrompt: "Session briefing (act on this every turn):\n- Search first B",
        timeout: 2_000,
      },
    );
  });

  it("updates lastMessageAt on each send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.queueResponse(createResponse("Second reply", { sessionId: "session-1" }));

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const firstTimestamp = manager.getSession("conversation-1")?.lastMessageAt;

    vi.setSystemTime(new Date("2026-04-21T11:00:00.000Z"));
    await manager.sendMessage("conversation-1", createConfig(), "again");
    const secondTimestamp = manager.getSession("conversation-1")?.lastMessageAt;

    expect(firstTimestamp).toBeDefined();
    expect(secondTimestamp).toBeDefined();
    expect(secondTimestamp!.getTime()).toBeGreaterThan(firstTimestamp!.getTime());
  });

  it("idle checker closes sessions past the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        idleTimeoutHours: 1,
        idleCheckIntervalMs: 1_000,
      },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    manager.startIdleChecker();

    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.get("conversation-1")).toBeUndefined();
    expect(manager.getSession("conversation-1")?.state).toBe("closed");
  });

  it("resumes a closed session on the next message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        idleTimeoutHours: 1,
        idleCheckIntervalMs: 1_000,
      },
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    manager.startIdleChecker();

    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);

    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime2.queueResponse(createResponse("Resumed reply", { sessionId: "session-1" }));

    await manager.sendMessage(
      "conversation-1",
      createConfig(),
      "welcome back",
      { context: "Should not compound into resumed session", timeout: 5_000 },
    );

    expect(runtime2.resumeSession).toHaveBeenCalledWith("session-1");
    expect(runtime2.send).toHaveBeenCalledWith("welcome back", { timeout: 5_000 });
    expect(builder).toHaveBeenCalledTimes(1);
    expect(manager.getSession("conversation-1")).toMatchObject({
      state: "idle",
      messageCount: 2,
      sessionId: "session-1",
    });
  });

  it("resetSession forces a hard reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    let buildCount = 0;
    const builder = vi.fn(async () => {
      buildCount += 1;
      return {
        pinnedFacts: `Pinned fact ${buildCount}`,
        recentMessages: `Recent summary ${buildCount}`,
        relevantMemories: `Memory hit ${buildCount}`,
      };
    });

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const beforeReset = manager.getSession("conversation-1")?.createdAt;

    vi.setSystemTime(new Date("2026-04-21T11:00:00.000Z"));
    pool.enqueueRuntime(new MockRuntime("runtime-2"));

    await manager.resetSession("conversation-1", createConfig());

    const session = manager.getSession("conversation-1");

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(session).toMatchObject({
      state: "idle",
      messageCount: 0,
    });
    expect(session?.sessionId).toBeUndefined();
    expect(session?.createdAt.getTime()).toBeGreaterThan(beforeReset!.getTime());
  });

  it("passes context again after a hard reset creates a fresh runtime", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");

    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime2.queueResponse(createResponse("Fresh reply", { sessionId: "session-2" }));
    await manager.resetSession("conversation-1", createConfig());
    await manager.sendMessage(
      "conversation-1",
      createConfig(),
      "after reset",
      { context: "Fresh warm-start context" },
    );

    expect(runtime2.resumeSession).not.toHaveBeenCalled();
    expect(runtime2.send).toHaveBeenCalledWith(
      "after reset",
      { context: "Fresh warm-start context" },
    );
  });

  it("getAllSessions returns tracked sessions", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime1.queueResponse(createResponse("Reply one", { sessionId: "session-1" }));
    runtime2.queueResponse(createResponse("Reply two", { sessionId: "session-2" }));

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage(
      "conversation-2",
      createConfig({ agentId: "agent-2" }),
      "hi",
    );

    expect(manager.getAllSessions()).toHaveLength(2);
    expect(manager.getAllSessions().map((session) => session.conversationKey)).toEqual([
      "conversation-1",
      "conversation-2",
    ]);
  });

  it("shutdown closes all sessions and stops the idle checker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime1.queueResponse(createResponse("Reply one", { sessionId: "session-1" }));
    runtime2.queueResponse(createResponse("Reply two", { sessionId: "session-2" }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        idleTimeoutHours: 1,
        idleCheckIntervalMs: 1_000,
      },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage(
      "conversation-2",
      createConfig({ agentId: "agent-2" }),
      "hi",
    );

    manager.startIdleChecker();
    await manager.shutdown();

    expect(pool.closeAllCalls).toBe(1);
    expect(manager.getAllSessions().every((session) => session.state === "closed")).toBe(true);

    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(pool.closeAllCalls).toBe(1);
    expect(pool.closeCalls).toHaveLength(0);
  });

  it("hard resets when modelUsage context fraction crosses the threshold", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    // Simulate real Claude CLI output: modelUsage nested inside raw/providerMetadata
    runtime1.queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        raw: {
          modelUsage: {
            "claude-sonnet-4-20250514": {
              inputTokens: 150000,
              outputTokens: 20000,
              cacheReadInputTokens: 650000,
              cacheCreationInputTokens: 0,
              contextWindow: 1000000,
            },
          },
        },
      },
    }));
    pool.enqueueRuntime(new MockRuntime("runtime-2"));

    let buildCount = 0;
    const builder = vi.fn(async () => {
      buildCount += 1;
      return {
        pinnedFacts: `Pinned fact ${buildCount}`,
        recentMessages: `Recent summary ${buildCount}`,
        relevantMemories: `Memory hit ${buildCount}`,
      };
    });

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { contextResetThreshold: 0.80 },
      builder,
    );

    const response = await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    // 820000 / 1000000 = 0.82, above 0.80 threshold
    expect(response.text).toBe("First reply");
    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(session?.messageCount).toBe(0);

    const notice = manager.consumeContextAutoResetNotice("conversation-1");
    expect(notice?.fraction).toBeCloseTo(0.82, 4);
    expect(manager.consumeContextAutoResetNotice("conversation-1")).toBeUndefined();
  });

  it("does not hard reset from aggregate Claude Code modelUsage across multiple turns", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        raw: {
          num_turns: 22,
          modelUsage: {
            "claude-sonnet-4-20250514": {
              inputTokens: 26,
              outputTokens: 12604,
              cacheReadInputTokens: 676482,
              cacheCreationInputTokens: 75222,
              contextWindow: 200000,
            },
          },
        },
      },
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        contextResetThreshold: 0.80,
      },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    expect(pool.closeCalls).toHaveLength(0);
    expect(pool.getOrCreateCalls).toHaveLength(1);
    expect(session?.messageCount).toBe(1);
    expect(session?.sessionId).toBe("session-1");
  });

  it("hard resets when peak-occupancy fraction crosses the threshold", async () => {
    const pool = new MockRuntimePool();
    pool.enqueueRuntime(new MockRuntime("runtime-1")).queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        providerMetadata: { contextOccupancyTokens: 170000, contextWindowTokens: 200000 },
      },
    }));
    pool.enqueueRuntime(new MockRuntime("runtime-2"));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { contextResetThreshold: 0.80 },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    // 170000 / 200000 = 0.85, above 0.80 threshold
    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(session?.messageCount).toBe(0);
  });

  it("prefers peak-occupancy over the inflated modelUsage sum (no false reset)", async () => {
    const pool = new MockRuntimePool();
    // modelUsage SUM = 751730/200000 = 3.76 (the over-count bug), but the peak
    // single-call occupancy is only 90000/200000 = 0.45 — must NOT reset.
    pool.enqueueRuntime(new MockRuntime("runtime-1")).queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        raw: {
          num_turns: 1,
          modelUsage: {
            "claude-sonnet-4-20250514": {
              inputTokens: 26,
              outputTokens: 12604,
              cacheReadInputTokens: 676482,
              cacheCreationInputTokens: 75222,
              contextWindow: 200000,
            },
          },
        },
        providerMetadata: { contextOccupancyTokens: 90000, contextWindowTokens: 200000 },
      },
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { contextResetThreshold: 0.80 },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    expect(pool.closeCalls).toHaveLength(0);
    expect(session?.messageCount).toBe(1);
  });

  it("resets a genuinely-full multi-turn session via occupancy (old num_turns guard would skip)", async () => {
    const pool = new MockRuntimePool();
    pool.enqueueRuntime(new MockRuntime("runtime-1")).queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        // Many internal turns (the old guard returned undefined and never reset),
        // but the peak single-call occupancy genuinely fills the window.
        raw: { num_turns: 22 },
        providerMetadata: { contextOccupancyTokens: 175000, contextWindowTokens: 200000 },
      },
    }));
    pool.enqueueRuntime(new MockRuntime("runtime-2"));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { contextResetThreshold: 0.80 },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    // 175000 / 200000 = 0.875, above threshold — fires despite num_turns > 1.
    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(session?.messageCount).toBe(0);
  });

  it("does not reset when modelUsage context fraction is below the threshold", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        raw: {
          modelUsage: {
            "claude-sonnet-4-20250514": {
              inputTokens: 5000,
              outputTokens: 1000,
              cacheReadInputTokens: 8000,
              cacheCreationInputTokens: 0,
              contextWindow: 200000,
            },
          },
        },
      },
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { contextResetThreshold: 0.80 },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    // 14000 / 200000 = 0.07, well below threshold
    expect(pool.closeCalls).toHaveLength(0);
    expect(session?.messageCount).toBe(1);
    expect(session?.state).toBe("idle");
  });

  it("hard resets automatically when context usage crosses the threshold (legacy keys)", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        contextUsage: 0.95,
      },
    }));
    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));

    let buildCount = 0;
    const builder = vi.fn(async () => {
      buildCount += 1;
      return {
        pinnedFacts: `Pinned fact ${buildCount}`,
        recentMessages: `Recent summary ${buildCount}`,
        relevantMemories: `Memory hit ${buildCount}`,
      };
    });

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        contextResetThreshold: 0.80,
      },
      builder,
    );

    const response = await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    expect(response.text).toBe("First reply");
    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(runtime2.resumeSession).not.toHaveBeenCalled();
    expect(session).toMatchObject({
      state: "idle",
      messageCount: 0,
    });
    expect(session?.sessionId).toBeUndefined();
  });

  it("abortActiveRun preserves provider session id without closing the runtime pool", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.abortActiveRun.mockReturnValue(true);

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);
    await manager.sendMessage("conversation-1", createConfig(), "hello");

    const aborted = await manager.abortActiveRun("conversation-1");

    expect(aborted).toBe(true);
    expect(pool.closeCalls).toEqual([]);
    expect(manager.getSession("conversation-1")).toMatchObject({
      state: "idle",
      sessionId: "session-1",
    });
  });

  it("restores provider session on the next send after abort cleared runtime binding", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.queueResponse(createResponse("Second reply", { sessionId: "session-1" }));
    runtime.abortActiveRun.mockImplementation(() => {
      runtime.sessionId = undefined;
      return true;
    });

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);
    await manager.sendMessage("conversation-1", createConfig(), "hello");

    await manager.abortActiveRun("conversation-1");

    await manager.sendMessage("conversation-1", createConfig(), "after stop");

    expect(runtime.resumeSession).toHaveBeenCalledWith("session-1");
    expect(runtime.sentMessages).toEqual(["hello", "after stop"]);
    expect(manager.getSession("conversation-1")).toMatchObject({
      state: "idle",
      sessionId: "session-1",
    });
  });
});

// T-I-035: context snapshots persist at the write point and the 70% pressure
// decision lives in the core lifecycle, so EVERY session type (typed, voice,
// schedule, collaboration) gets both — voice sessions used to compact silently.
describe("SessionLifecycleManager context hooks (T-I-035)", () => {
  const VOICE_KEY = "agent:alpha:discord:channel:1385000000000000000:alpha";

  function occupancyResponse(text: string, occupancy: number, window = 200_000): RuntimeResponse {
    return createResponse(text, {
      sessionId: "session-1",
      metadata: {
        providerMetadata: {
          contextOccupancyTokens: occupancy,
          contextWindowTokens: window,
        },
      },
    });
  }

  it("fires onContextUsageRecorded at the write point for an agent:-keyed session", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(occupancyResponse("Reply", 62_000));

    const recorded: Array<{ conversationKey: string; agentId: string; fraction: number; totalTokens: number; contextWindow: number }> = [];
    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        onContextUsageRecorded: (conversationKey, agentId, usage) => {
          recorded.push({
            conversationKey,
            agentId,
            fraction: usage.fraction,
            totalTokens: usage.totalTokens,
            contextWindow: usage.contextWindow,
          });
        },
      },
    );

    await manager.sendMessage(VOICE_KEY, createConfig(), "hello");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      conversationKey: VOICE_KEY,
      agentId: "agent-1",
      totalTokens: 62_000,
      contextWindow: 200_000,
    });
    expect(recorded[0]!.fraction).toBeCloseTo(0.31, 4);
  });

  it("fires onContextPressure at 0.70 for an agent:-keyed (voice) session", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(occupancyResponse("Reply", 140_000)); // exactly 0.70

    const pressureEvents: Array<{ conversationKey: string; fraction: number }> = [];
    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        onContextPressure: (conversationKey, _agentId, usage) => {
          pressureEvents.push({ conversationKey, fraction: usage.fraction });
        },
      },
    );

    await manager.sendMessage(VOICE_KEY, createConfig(), "hello");

    expect(pressureEvents).toHaveLength(1);
    expect(pressureEvents[0]!.conversationKey).toBe(VOICE_KEY);
    expect(pressureEvents[0]!.fraction).toBeCloseTo(0.70, 4);
  });

  it("does not fire onContextPressure below the threshold", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(occupancyResponse("Reply", 120_000)); // 0.60

    const pressureEvents: string[] = [];
    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { onContextPressure: (conversationKey) => pressureEvents.push(conversationKey) },
    );

    await manager.sendMessage(VOICE_KEY, createConfig(), "hello");

    expect(pressureEvents).toHaveLength(0);
  });

  it("keeps once-per-band semantics: marked sent means no re-fire; retries when unmarked", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(occupancyResponse("Turn 1", 142_000)); // 0.71
    runtime.queueResponse(occupancyResponse("Turn 2", 144_000)); // 0.72 — retry (delivery not marked)
    runtime.queueResponse(occupancyResponse("Turn 3", 146_000)); // 0.73 — marked, no fire

    const pressureEvents: number[] = [];
    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      { onContextPressure: (_key, _agent, usage) => pressureEvents.push(usage.fraction) },
    );

    await manager.sendMessage(VOICE_KEY, createConfig(), "one");
    // Delivery failed (not marked) → the decision fires again next turn.
    await manager.sendMessage(VOICE_KEY, createConfig(), "two");
    // Delivery owner marks sent → no further fire within the band.
    manager.markContextPressureAlertSent(VOICE_KEY);
    await manager.sendMessage(VOICE_KEY, createConfig(), "three");

    expect(pressureEvents).toHaveLength(2);
    expect(pressureEvents[0]).toBeCloseTo(0.71, 4);
    expect(pressureEvents[1]).toBeCloseTo(0.72, 4);
  });

  it("a throwing hook never breaks the turn", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(occupancyResponse("Reply", 150_000)); // 0.75 — both hooks fire

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manager = new SessionLifecycleManager(
        pool as unknown as RuntimePool,
        {
          onContextUsageRecorded: () => {
            throw new Error("snapshot store exploded");
          },
          onContextPressure: () => {
            throw new Error("pressure delivery exploded");
          },
        },
      );

      const response = await manager.sendMessage(VOICE_KEY, createConfig(), "hello");

      expect(response.text).toBe("Reply");
      expect(manager.getSession(VOICE_KEY)?.lastContextUsage?.fraction).toBeCloseTo(0.75, 4);
      const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warnings.some((line) => line.includes("snapshot hook failed"))).toBe(true);
      expect(warnings.some((line) => line.includes("pressure hook failed"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

});

describe("SessionLifecycleManager turn queue", () => {
  function slowRuntime(id: string, delays: number[]) {
    const runtime = new MockRuntime(id);
    let active = 0;
    let maxActive = 0;
    runtime.send.mockImplementation(async (message: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runtime.sentMessages.push(message);
      await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 10));
      active -= 1;
      if (message === "boom") throw new Error("turn failed");
      return createResponse(`reply to ${message}`);
    });
    return { runtime, maxActive: () => maxActive };
  }

  it("never runs two turns of one conversation at the same time", async () => {
    const pool = new MockRuntimePool();
    const { runtime, maxActive } = slowRuntime("runtime-1", [50, 10]);
    pool.enqueueRuntime(runtime);
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    const [first, second] = await Promise.all([
      manager.sendMessage("conversation-1", createConfig(), "plan the trip"),
      manager.sendMessage("conversation-1", createConfig(), "add Costco"),
    ]);

    expect(maxActive()).toBe(1);
    expect(runtime.sentMessages).toEqual(["plan the trip", "add Costco"]);
    expect([first.text, second.text]).toEqual(["reply to plan the trip", "reply to add Costco"]);
    // The queued turn reused the same runtime instead of tearing it down.
    expect(pool.closeCalls).toEqual([]);
  });

  it("runs different conversations in parallel", async () => {
    const pool = new MockRuntimePool();
    const a = slowRuntime("runtime-a", [40]);
    const b = slowRuntime("runtime-b", [40]);
    pool.enqueueRuntime(a.runtime);
    pool.enqueueRuntime(b.runtime);
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    const started = Date.now();
    await Promise.all([
      manager.sendMessage("conversation-a", createConfig(), "one"),
      manager.sendMessage("conversation-b", createConfig(), "two"),
    ]);
    expect(Date.now() - started).toBeLessThan(75);
  });

  it("lets the next turn run after a failed one", async () => {
    const pool = new MockRuntimePool();
    const { runtime } = slowRuntime("runtime-1", [20, 10]);
    pool.enqueueRuntime(runtime);
    pool.enqueueRuntime(slowRuntime("runtime-2", [10]).runtime);
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    const results = await Promise.allSettled([
      manager.sendMessage("conversation-1", createConfig(), "boom"),
      manager.sendMessage("conversation-1", createConfig(), "after"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { text: "reply to after" } });
  });
});

describe("SessionLifecycleManager per-turn provenance", () => {
  const memoryServer = (env: Record<string, string>) => ({ name: "memory", command: "node", args: ["memory.js"], env });

  it("resumes the provider session when only per-turn provenance env changes", async () => {
    const pool = new MockRuntimePool();
    const firstRuntime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const secondRuntime = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    firstRuntime.queueResponse(createResponse("Draft ready", { sessionId: "session-1" }));
    secondRuntime.queueResponse(createResponse("Sent"));
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);
    const turn = (turnId: string, messageId: string) =>
      createConfig({
        mcpServers: [memoryServer({ TANGO_CONVERSATION_KEY: "conversation-1", TANGO_TURN_ID: turnId, TANGO_MESSAGE_ID: messageId, TANGO_OCCURRED_AT: `${turnId}-at` })],
      });

    await manager.sendMessage("conversation-1", turn("turn-1", "m-1"), "Draft the club email");
    await manager.sendMessage("conversation-1", turn("turn-2", "m-2"), "Approved, send it");

    // Rebuilt so the memory server sees this turn's ids, but the same conversation continues.
    expect(pool.getOrCreateCalls[1].config.mcpServers[0].env?.TANGO_TURN_ID).toBe("turn-2");
    expect(secondRuntime.resumeSession).toHaveBeenCalledWith("session-1");
    expect(manager.getSession("conversation-1")).toMatchObject({ sessionId: "session-1", messageCount: 2 });
  });

  it("still starts fresh when a stable env value changes", async () => {
    const pool = new MockRuntimePool();
    pool.enqueueRuntime(new MockRuntime("runtime-1")).queueResponse(createResponse("One", { sessionId: "session-1" }));
    const second = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    second.queueResponse(createResponse("Two", { sessionId: "session-2" }));
    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    await manager.sendMessage("conversation-1", createConfig({ mcpServers: [memoryServer({ TANGO_CONVERSATION_KEY: "a", TANGO_TURN_ID: "1" })] }), "one");
    await manager.sendMessage("conversation-1", createConfig({ mcpServers: [memoryServer({ TANGO_CONVERSATION_KEY: "b", TANGO_TURN_ID: "2" })] }), "two");

    expect(second.resumeSession).not.toHaveBeenCalled();
    expect(manager.getSession("conversation-1")).toMatchObject({ sessionId: "session-2", messageCount: 1 });
  });
});
