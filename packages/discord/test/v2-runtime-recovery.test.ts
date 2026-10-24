import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeTimeoutError, type AgentRuntimeConfig, type ChatProvider, type V2AgentConfig } from "@tango/core";
import {
  buildDegradedModeNote,
  buildV2RecoveryPrompt,
  createV2RuntimeFailureRecovery,
  resolveDegradedProviderChain,
} from "../src/v2-runtime-recovery.js";

function createV2Config(
  agentId: string,
  configOverrides: Partial<V2AgentConfig> = {},
): V2AgentConfig {
  return {
    id: agentId,
    displayName: agentId,
    type: "test",
    systemPromptFile: "agents/assistants/malibu/soul.md",
    mcpServers: [{ name: "memory", command: "node" }],
    runtime: {
      mode: "persistent",
      provider: "claude-code-v2",
      fallback: "codex",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
    },
    memory: {
      postTurnExtraction: "enabled",
      extractionModel: "claude-haiku-4-5",
      importanceThreshold: 0.4,
      scheduledReflection: "enabled",
    },
    discord: {
      defaultChannelId: "123",
    },
    legacyProvider: {
      default: "claude-oauth",
      fallback: ["claude-oauth-secondary", "codex", "ollama"],
    },
    ...configOverrides,
  };
}

function createRuntimeConfig(agentId: string): AgentRuntimeConfig {
  return {
    agentId,
    systemPrompt: "You are the runtime.",
    mcpServers: [],
    runtimePreferences: { model: "claude-sonnet-4-6" },
  };
}

function createDeps(overrides: {
  v2Config?: V2AgentConfig;
  providers?: Map<string, ChatProvider>;
} = {}) {
  const v2Config = overrides.v2Config ?? createV2Config("malibu");
  const providers = overrides.providers ?? new Map<string, ChatProvider>();
  return {
    v2Configs: new Map([[v2Config.id, v2Config]]),
    v2RuntimeConfigs: new Map([[v2Config.id, createRuntimeConfig(v2Config.id)]]),
    resolveProvider: (name: string) => providers.get(name),
    buildConversationKey: (channelId: string, threadId?: string) =>
      threadId ? `channel:${channelId}:thread:${threadId}` : `channel:${channelId}`,
  };
}

function createProvider(text: string): ChatProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    generate: vi.fn().mockResolvedValue({ text, metadata: { model: "test-model" } }),
  };
}

const usageLimitError = new Error(
  "Claude Code exited with code 1. stdout=Claude AI usage limit reached|1754500000",
);

const routeParams = {
  message: "hello",
  channelId: "channel-1",
  agentId: "malibu",
};

describe("resolveDegradedProviderChain", () => {
  it("filters the legacy fallback list to codex and ollama in config order", () => {
    expect(resolveDegradedProviderChain(createV2Config("malibu"))).toEqual(["codex", "ollama"]);
  });

  it("falls back to runtime.fallback codex when no legacy list exists", () => {
    const config = createV2Config("malibu", { legacyProvider: undefined });
    expect(resolveDegradedProviderChain(config)).toEqual(["codex"]);
  });

  it("returns empty when nothing is configured", () => {
    const config = createV2Config("malibu", { legacyProvider: undefined });
    config.runtime = { ...config.runtime, fallback: undefined };
    expect(resolveDegradedProviderChain(config)).toEqual([]);
    expect(resolveDegradedProviderChain(undefined)).toEqual([]);
  });
});

describe("createV2RuntimeFailureRecovery", () => {
  it("recovers a usage-limit failure on the first configured provider", async () => {
    const codex = createProvider("codex reply");
    const ollama = createProvider("ollama reply");
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ providers: new Map<string, ChatProvider>([["codex", codex], ["ollama", ollama]]) }),
    );

    const result = await recover(routeParams, usageLimitError);

    expect(result?.response.text).toBe("codex reply");
    expect(result?.response.metadata).toMatchObject({
      backend: "codex-fallback",
      degradedReason: "usage-limit",
      primaryFailure: usageLimitError.message,
    });
    expect(result?.conversationKey).toBe("channel:channel-1");
    expect(ollama.generate).not.toHaveBeenCalled();
    const request = codex.generate.mock.calls[0]?.[0] as { systemPrompt?: string };
    expect(request.systemPrompt).toContain("usage-limit");
  });

  it("degrades to ollama when codex fails", async () => {
    const codex: ChatProvider = { generate: vi.fn().mockRejectedValue(new Error("codex down")) };
    const ollama = createProvider("ollama reply");
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ providers: new Map<string, ChatProvider>([["codex", codex], ["ollama", ollama]]) }),
    );

    const result = await recover(routeParams, usageLimitError);

    expect(result?.response.text).toBe("ollama reply");
    expect(result?.response.metadata).toMatchObject({ backend: "ollama-fallback" });
  });

  it("skips unregistered providers and continues down the chain", async () => {
    const ollama = createProvider("ollama reply");
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ providers: new Map<string, ChatProvider>([["ollama", ollama]]) }),
    );

    const result = await recover(routeParams, usageLimitError);

    expect(result?.response.text).toBe("ollama reply");
  });

  it("still recovers runtime timeouts (previous behavior)", async () => {
    const codex = createProvider("codex reply");
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ providers: new Map<string, ChatProvider>([["codex", codex]]) }),
    );

    const result = await recover(
      routeParams,
      new Error("Claude Code request timed out after 900000ms."),
    );

    expect(result?.response.metadata).toMatchObject({
      backend: "codex-fallback",
      degradedReason: "timeout",
    });
  });

  it("declines unclassified failures", async () => {
    const codex = createProvider("codex reply");
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ providers: new Map<string, ChatProvider>([["codex", codex]]) }),
    );

    expect(await recover(routeParams, new Error("Something else broke"))).toBeNull();
    expect(codex.generate).not.toHaveBeenCalled();
  });

  it("declines for ollama-backed agents", async () => {
    const v2Config = createV2Config("malibu-ollama", {
      legacyProvider: { default: "ollama", fallback: ["codex"] },
    });
    const codex = createProvider("codex reply");
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ v2Config, providers: new Map<string, ChatProvider>([["codex", codex]]) }),
    );

    expect(
      await recover({ ...routeParams, agentId: "malibu-ollama" }, usageLimitError),
    ).toBeNull();
  });

  it("declines when every configured provider fails", async () => {
    const codex: ChatProvider = { generate: vi.fn().mockRejectedValue(new Error("codex down")) };
    const ollama: ChatProvider = { generate: vi.fn().mockRejectedValue(new Error("ollama down")) };
    const recover = createV2RuntimeFailureRecovery(
      createDeps({ providers: new Map<string, ChatProvider>([["codex", codex], ["ollama", ollama]]) }),
    );

    expect(await recover(routeParams, usageLimitError)).toBeNull();
  });
});

describe("buildV2RecoveryPrompt", () => {
  it("assembles context, metadata, briefing, and message", () => {
    const prompt = buildV2RecoveryPrompt({
      message: "the question",
      channelId: "channel-1",
      agentId: "malibu",
      sendOptions: {
        context: "warm start",
        currentTurnMetadataPrompt: "meta",
        turnBriefingPrompt: "briefing",
      },
    });

    expect(prompt).toBe("Context:\nwarm start\n\nmeta\n\nbriefing\n\nthe question");
  });
});

describe("buildDegradedModeNote", () => {
  it("tells the fallback model a working run ran out of time", () => {
    const note = buildDegradedModeNote("timeout", new ClaudeCodeTimeoutError(1_800_000, false));
    expect(note).toContain("still working when it hit its 30-minute time budget");
    expect(note).toContain("offer to continue");
  });

  it("keeps the generic unavailable note for a stalled run", () => {
    const note = buildDegradedModeNote("timeout", new ClaudeCodeTimeoutError(900_000, true));
    expect(note).toContain("primary tool-enabled runtime is unavailable (timeout)");
  });
});
