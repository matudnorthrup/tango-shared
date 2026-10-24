import type { AgentRuntimeConfig, RuntimeResponse, SendOptions } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const sendMessage = vi.fn();
  const resetSession = vi.fn();
  const abortActiveRun = vi.fn();
  const shutdown = vi.fn();
  const startIdleChecker = vi.fn();
  const getSession = vi.fn();
  const constructorCalls: Array<{
    pool: unknown;
    config: unknown;
    buildColdStartContext: unknown;
  }> = [];

  class MockRuntimePool {}

  class MockSessionLifecycleManager {
    constructor(pool: unknown, config?: unknown, buildColdStartContext?: unknown) {
      constructorCalls.push({
        pool,
        config,
        buildColdStartContext,
      });
    }

    readonly sendMessage = sendMessage;
    readonly resetSession = resetSession;
    readonly abortActiveRun = abortActiveRun;
    readonly shutdown = shutdown;
    readonly startIdleChecker = startIdleChecker;
    readonly getSession = getSession;
  }

  return {
    sendMessage,
    resetSession,
    abortActiveRun,
    shutdown,
    startIdleChecker,
    getSession,
    constructorCalls,
    MockRuntimePool,
    MockSessionLifecycleManager,
  };
});

vi.mock("@tango/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tango/core")>();
  return {
    ...actual,
    RuntimePool: mockState.MockRuntimePool,
    SessionLifecycleManager: mockState.MockSessionLifecycleManager,
  };
});

import { TangoRouter } from "../src/tango-router.js";

function createAgentConfig(agentId: string): AgentRuntimeConfig {
  return {
    agentId,
    systemPrompt: `You are ${agentId}.`,
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["memory.js"],
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
      timeout: 30_000,
    },
  };
}

function createDynamicAgentConfig(agentId: string): AgentRuntimeConfig {
  return {
    ...createAgentConfig(agentId),
    availableMcpServers: [
      {
        name: "attachments",
        command: "node",
        args: ["attachments.js"],
      },
      {
        name: "send-image",
        command: "node",
        args: ["send-image.js"],
      },
    ],
  };
}

function createResponse(text: string): RuntimeResponse {
  return {
    text,
    durationMs: 25,
    metadata: {
      sessionId: "session-1",
    },
  };
}

async function waitForImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

afterEach(() => {
  mockState.sendMessage.mockReset();
  mockState.resetSession.mockReset();
  mockState.abortActiveRun.mockReset();
  mockState.shutdown.mockReset();
  mockState.startIdleChecker.mockReset();
  mockState.getSession.mockReset();
  mockState.constructorCalls.length = 0;
  vi.restoreAllMocks();
});

describe("TangoRouter", () => {
  it("routes a message to the correct agent runtime", async () => {
    const alphaConfig = createAgentConfig("alpha");
    const bravoConfig = createAgentConfig("bravo");
    const response = createResponse("Routed reply");
    const sendOptions: SendOptions = { timeout: 5_000 };

    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", alphaConfig],
        ["bravo", bravoConfig],
      ]),
    });

    const result = await router.routeMessage({
      message: "hello",
      channelId: "channel-1",
      messageId: "message-1",
      occurredAt: "2026-07-12T09:00:00.000Z",
      contextRef: "topic:shared-knowledge",
      contextLabel: "shared-knowledge review",
      agentId: "bravo",
      sendOptions,
    });

    expect(result).toEqual({
      response: {
        ...response,
        metadata: {
          ...response.metadata,
          mcpTooling: {
            defaultServerNames: ["memory"],
            availableServerNames: [],
            mountedServerNames: ["memory"],
            activatedServerNames: [],
            triggerReasons: {},
          },
        },
      },
      agentId: "bravo",
      conversationKey: "channel:channel-1",
      turnId: expect.any(String),
    });
    expect(mockState.sendMessage).toHaveBeenCalledWith(
      "channel:channel-1",
      expect.objectContaining({
        ...bravoConfig,
        mcpServers: [
            {
              ...bravoConfig.mcpServers[0]!,
              env: expect.objectContaining({
                TANGO_CONVERSATION_KEY: "channel:channel-1",
                TANGO_DISCORD_CHANNEL_ID: "channel-1",
                TANGO_TURN_ID: expect.any(String),
                TANGO_MESSAGE_ID: "message-1",
                TANGO_OCCURRED_AT: "2026-07-12T09:00:00.000Z",
                TANGO_CONTEXT_REF: "topic:shared-knowledge",
                TANGO_CONTEXT_LABEL: "shared-knowledge review",
              }),
            },
          ],
        mcpMountSelection: {
          defaultServerNames: ["memory"],
          availableServerNames: [],
          mountedServerNames: ["memory"],
          activatedServerNames: [],
          triggerReasons: {},
        },
      }),
      "hello",
      sendOptions,
    );
    expect(mockState.startIdleChecker).toHaveBeenCalledTimes(1);
  });

  it("generates distinct conversation keys for channels and threads", () => {
    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    expect(router.getConversationKey("channel-1")).toBe("channel:channel-1");
    expect(router.getConversationKey("channel-1", "thread-9")).toBe("thread:thread-9");
  });

  it("keeps available MCP servers unmounted for an ordinary turn", async () => {
    const response = createResponse("Plain reply");
    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["watson", createDynamicAgentConfig("watson")],
      ]),
    });

    const result = await router.routeMessage({
      message: "Morning Watson",
      channelId: "channel-1",
      agentId: "watson",
    });

    const sentConfig = mockState.sendMessage.mock.calls[0]?.[1] as AgentRuntimeConfig;
    expect(sentConfig.mcpServers.map((server) => server.name)).toEqual(["memory"]);
    expect(sentConfig.availableMcpServers?.map((server) => server.name)).toEqual([
      "attachments",
      "send-image",
    ]);
    expect(result.response.metadata?.mcpTooling).toMatchObject({
      mountedServerNames: ["memory"],
      activatedServerNames: [],
    });
  });

  it("mounts available attachment tools when the turn needs files", async () => {
    const response = createResponse("Attachment reply");
    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["watson", createDynamicAgentConfig("watson")],
      ]),
    });

    const result = await router.routeMessage({
      message: "Can you read the PDF attachment?",
      channelId: "channel-1",
      agentId: "watson",
    });

    const sentConfig = mockState.sendMessage.mock.calls[0]?.[1] as AgentRuntimeConfig;
    expect(sentConfig.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "attachments",
    ]);
    expect(result.response.metadata?.mcpTooling).toMatchObject({
      mountedServerNames: ["memory", "attachments"],
      activatedServerNames: ["attachments"],
      triggerReasons: {
        attachments: ["turn-keyword"],
      },
    });
  });

  it("uses an explicit conversation key override when provided", async () => {
    const response = createResponse("Scoped reply");

    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    const result = await router.routeMessage({
      message: "hello",
      channelId: "channel-1",
      conversationKey: "voice:session-42:alpha",
      agentId: "alpha",
    });

    expect(result.conversationKey).toBe("voice:session-42:alpha");
    expect(mockState.sendMessage).toHaveBeenCalledWith(
      "voice:session-42:alpha",
      expect.objectContaining({
        ...createAgentConfig("alpha"),
        mcpServers: [
          {
            ...createAgentConfig("alpha").mcpServers[0]!,
            env: expect.objectContaining({
              TANGO_CONVERSATION_KEY: "voice:session-42:alpha",
              TANGO_DISCORD_CHANNEL_ID: "channel-1",
              TANGO_TURN_ID: expect.any(String),
            }),
          },
        ],
        mcpMountSelection: {
          defaultServerNames: ["memory"],
          availableServerNames: [],
          mountedServerNames: ["memory"],
          activatedServerNames: [],
          triggerReasons: {},
        },
      }),
      "hello",
      undefined,
    );
  });

  it("stamps the canonical channel (not the heuristic thread) for a voice turn in a non-default channel", async () => {
    mockState.sendMessage.mockResolvedValue(createResponse("Voice reply"));
    const router = new TangoRouter({ agentConfigs: new Map([["alpha", createAgentConfig("alpha")]]) });
    await router.routeMessage({
      message: "hello",
      channelId: "default-channel",
      threadId: "other-channel",
      conversationKey: "voice:session-42:alpha:other-channel",
      provenanceConversationKey: "channel:other-channel",
      provenanceChannel: { channelId: "other-channel" },
      agentId: "alpha",
    });
    const env = mockState.sendMessage.mock.calls.at(-1)![1].mcpServers[0].env;
    expect(env).toMatchObject({ TANGO_CONVERSATION_KEY: "channel:other-channel", TANGO_DISCORD_CHANNEL_ID: "other-channel" });
    expect(env.TANGO_DISCORD_THREAD_ID).toBeUndefined();
  });

  it("routes by the session key but stamps the canonical provenance key on tools", async () => {
    mockState.sendMessage.mockResolvedValue(createResponse("Voice reply"));

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    const result = await router.routeMessage({
      message: "hello",
      channelId: "channel-1",
      threadId: "thread-7",
      conversationKey: "voice:session-42:alpha:thread-7",
      provenanceConversationKey: "thread:thread-7",
      agentId: "alpha",
    });

    // Session resumption still follows the voice session key.
    expect(result.conversationKey).toBe("voice:session-42:alpha:thread-7");
    expect(mockState.sendMessage).toHaveBeenCalledWith(
      "voice:session-42:alpha:thread-7",
      expect.objectContaining({
        mcpServers: [
          expect.objectContaining({
            env: expect.objectContaining({
              TANGO_CONVERSATION_KEY: "thread:thread-7",
              TANGO_DISCORD_CHANNEL_ID: "channel-1",
              TANGO_DISCORD_THREAD_ID: "thread-7",
            }),
          }),
        ],
      }),
      "hello",
      undefined,
    );
  });

  it("fires the post-turn hook after returning the response", async () => {
    const response = createResponse("Async reply");
    const onPostTurn = vi.fn(async () => {});

    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
      onPostTurn,
    });

    const result = await router.routeMessage({
      message: "remember this",
      channelId: "channel-1",
      threadId: "thread-1",
      agentId: "alpha",
    });

    expect(result.response).toMatchObject({
      text: response.text,
      metadata: {
        sessionId: "session-1",
        mcpTooling: {
          mountedServerNames: ["memory"],
        },
      },
    });
    expect(onPostTurn).not.toHaveBeenCalled();

    await waitForImmediate();

    expect(onPostTurn).toHaveBeenCalledWith({
      turnId: result.turnId,
      conversationKey: "thread:thread-1",
      agentId: "alpha",
      userMessage: "remember this",
      response: result.response,
      channelId: "channel-1",
      threadId: "thread-1",
    });
  });

  it("suppresses v2 internal worker-dispatch tags before delivery and post-turn hooks", async () => {
    const response = createResponse([
      "Dispatching to fetch sources.",
      '<worker-dispatch worker="study-assistant">Fetch chapter 3 of the reading plan.</worker-dispatch>',
    ].join("\n\n"));
    const onPostTurn = vi.fn(async () => {});

    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
      onPostTurn,
    });

    const result = await router.routeMessage({
      message: "build a lesson",
      channelId: "channel-1",
      agentId: "alpha",
    });

    expect(result.response.text).toBe(
      "Sorry, I tried to use an internal worker handoff that is not available in this runtime. Please ask again and I will handle it directly.",
    );
    expect(result.response.metadata).toMatchObject({
      sessionId: "session-1",
      sanitizedInternalWorkerDispatch: true,
      originalTextLength: response.text.length,
    });

    await waitForImmediate();

    expect(onPostTurn).toHaveBeenCalledWith(expect.objectContaining({
      response: result.response,
    }));
  });

  it("delegates conversation resets to the lifecycle manager", async () => {
    const alphaConfig = createAgentConfig("alpha");

    mockState.getSession.mockReturnValue({
      conversationKey: "thread:thread-1",
      agentId: "alpha",
      state: "idle",
      lastMessageAt: new Date(),
      createdAt: new Date(),
      messageCount: 1,
    });
    mockState.resetSession.mockResolvedValue(undefined);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", alphaConfig],
      ]),
    });

    await router.resetConversation("channel-1", "thread-1");

    expect(mockState.getSession).toHaveBeenCalledWith("thread:thread-1");
    expect(mockState.resetSession).toHaveBeenCalledWith("thread:thread-1", alphaConfig);
  });

  it("delegates conversation aborts to the lifecycle manager without resetting", async () => {
    mockState.abortActiveRun.mockResolvedValue(true);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    const aborted = await router.abortConversation("channel-1", "thread-1");

    expect(aborted).toBe(true);
    expect(mockState.abortActiveRun).toHaveBeenCalledWith("thread:thread-1");
    expect(mockState.resetSession).not.toHaveBeenCalled();
  });

  it("delegates shutdown to the lifecycle manager", async () => {
    mockState.shutdown.mockResolvedValue(undefined);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    await router.shutdown();

    expect(mockState.shutdown).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error for an unknown agent id", async () => {
    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    await expect(router.routeMessage({
      message: "hello",
      channelId: "channel-1",
      agentId: "missing-agent",
    })).rejects.toThrow("Unknown agentId 'missing-agent'. No runtime config is registered.");

    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });
});
