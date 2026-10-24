import type { V2AgentConfig } from "@tango/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildVoiceRouterErrorResult,
  buildVoiceRouterResult,
  classifyVoiceRouterFailure,
  dispatchVoiceTurnByRuntime,
  voiceTurnFailureMetadata,
  VOICE_V2_ROUTER_TIMEOUT_MS,
  VOICE_V2_TTS_ERROR_MESSAGE,
} from "../src/voice-turn-runtime-routing.js";

function createV2AgentConfig(
  provider: V2AgentConfig["runtime"]["provider"] = "claude-code-v2",
): V2AgentConfig {
  return {
    id: "malibu",
    displayName: "Malibu",
    type: "wellness",
    systemPromptFile: "agents/assistants/malibu/soul.md",
    mcpServers: [
      {
        name: "wellness",
        command: "node",
        args: ["packages/discord/dist/mcp-wellness-server.js"],
      },
    ],
    runtime: {
      mode: "persistent",
      provider,
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
      defaultChannelId: "channel-1",
    },
  };
}

describe("dispatchVoiceTurnByRuntime", () => {
  it("routes voice turns through TangoRouter when v2 is enabled", async () => {
    const routeMessage = vi.fn(async () => ({
      response: {
        text: "Routed reply",
        durationMs: 42,
        metadata: {
          sessionId: "runtime-session-1",
        },
      },
      agentId: "malibu",
      conversationKey: "voice:session-1:malibu",
    }));

    const result = await dispatchVoiceTurnByRuntime({
      transcript: "hello from voice",
      agentId: "malibu",
      channelId: "channel-1",
      threadId: "thread-7",
      conversationKey: "voice:session-1:malibu",
      v2AgentConfig: createV2AgentConfig(),
      tangoRouter: {
        routeMessage,
      },
      mapRouterResult: (routeResult) =>
        buildVoiceRouterResult({
          routeResult,
          v2AgentConfig: createV2AgentConfig(),
          turnId: "turn-1",
        }),
    });

    expect(result).toEqual({
      turnId: "turn-1",
      deduplicated: false,
      responseText: "Routed reply",
      providerName: "claude-code-v2",
      providerSessionId: "runtime-session-1",
      providerUsedFailover: false,
    });
    expect(routeMessage).toHaveBeenCalledWith({
      message: "hello from voice",
      channelId: "channel-1",
      threadId: "thread-7",
      conversationKey: "voice:session-1:malibu",
      agentId: "malibu",
      sendOptions: {
        timeout: VOICE_V2_ROUTER_TIMEOUT_MS,
      },
    });
  });

  it("keeps the voice session key for routing and exposes the canonical key as provenance", async () => {
    const routeMessage = vi.fn(async () => ({
      response: { text: "ok", durationMs: 1 },
      agentId: "malibu",
      conversationKey: "voice:session-1:malibu:thread-7",
      turnId: "turn-1",
    }));

    await dispatchVoiceTurnByRuntime({
      transcript: "hi",
      agentId: "malibu",
      channelId: "channel-1",
      threadId: "thread-7",
      conversationKey: "voice:session-1:malibu:thread-7",
      provenanceConversationKey: "thread:thread-7",
      v2AgentConfig: createV2AgentConfig(),
      tangoRouter: { routeMessage },
      mapRouterResult: () => "v2",
    });

    expect(routeMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "voice:session-1:malibu:thread-7",
      provenanceConversationKey: "thread:thread-7",
    }));
  });

  it("passes sendOptions context through to TangoRouter", async () => {
    const routeMessage = vi.fn(async () => ({
      response: {
        text: "Routed reply",
        durationMs: 42,
      },
      agentId: "malibu",
      conversationKey: "voice:session-1:malibu",
    }));

    await dispatchVoiceTurnByRuntime({
      transcript: "hello from voice",
      agentId: "malibu",
      channelId: "channel-1",
      v2AgentConfig: createV2AgentConfig(),
      tangoRouter: {
        routeMessage,
      },
      mapRouterResult: () => "v2",
      sendOptions: {
        context: "Use spoken language only.",
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:08:18.000Z",
      },
    });

    expect(routeMessage).toHaveBeenCalledWith({
      message: "hello from voice",
      channelId: "channel-1",
      agentId: "malibu",
      sendOptions: {
        timeout: VOICE_V2_ROUTER_TIMEOUT_MS,
        context: "Use spoken language only.",
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:08:18.000Z",
      },
    });
  });

  it("fails closed when v2 is disabled", async () => {
    const routeMessage = vi.fn();

    await expect(dispatchVoiceTurnByRuntime({
      transcript: "keep using legacy",
      agentId: "malibu",
      channelId: "channel-1",
      v2AgentConfig: createV2AgentConfig("legacy"),
      tangoRouter: {
        routeMessage,
      },
      mapRouterResult: () => "v2 reply",
    })).rejects.toThrow("Agent 'malibu' is not configured for the v2 voice runtime.");

    expect(routeMessage).not.toHaveBeenCalled();
  });

  it("allows voice routing errors to resolve to a TTS-friendly reply", async () => {
    const routeMessage = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });

    const result = await dispatchVoiceTurnByRuntime({
      transcript: "hello",
      agentId: "malibu",
      channelId: "channel-1",
      v2AgentConfig: createV2AgentConfig(),
      tangoRouter: {
        routeMessage,
      },
      mapRouterResult: () => {
        throw new Error("success path should not run");
      },
      onRouterError: () =>
        buildVoiceRouterErrorResult({
          v2AgentConfig: createV2AgentConfig(),
          turnId: "turn-err",
        }),
    });

    expect(result).toEqual({
      turnId: "turn-err",
      deduplicated: false,
      responseText: VOICE_V2_TTS_ERROR_MESSAGE,
      providerName: "claude-code-v2",
      providerUsedFailover: false,
      // Backward compatible: the spoken fallback stays, plus an explicit flag.
      failed: true,
      failureReason: "error",
    });
  });

  it("classifies router failures and only flags failed results in receipt metadata", () => {
    expect(classifyVoiceRouterFailure(new Error("Claude Code request timed out after 900000ms."))).toBe("timeout");
    expect(classifyVoiceRouterFailure(new Error("API Error: 529 overloaded_error"))).toBe("overloaded");
    expect(classifyVoiceRouterFailure(new Error("Claude AI usage limit reached"))).toBe("usage-limit");
    expect(classifyVoiceRouterFailure(new Error("boom"))).toBe("error");
    expect(buildVoiceRouterErrorResult({ v2AgentConfig: createV2AgentConfig(), failureReason: "empty-reply" }))
      .toMatchObject({ failed: true, failureReason: "empty-reply", responseText: VOICE_V2_TTS_ERROR_MESSAGE });
    expect(voiceTurnFailureMetadata({ failed: true, failureReason: "timeout" })).toEqual({ failed: true, failureReason: "timeout" });
    expect(voiceTurnFailureMetadata({})).toEqual({});
  });
});
