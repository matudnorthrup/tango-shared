import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { V2AgentConfig } from "@tango/core";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createV2PostTurnHook } from "../src/v2-runtime.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(): V2AgentConfig {
  return {
    id: "watson", displayName: "Watson", type: "personal", systemPromptFile: "fixture.md", mcpServers: [],
    runtime: { mode: "persistent", provider: "claude-code-v2", model: "fixture", reasoningEffort: "low", idleTimeoutHours: 24, contextResetThreshold: 0.8 },
    memory: { postTurnExtraction: "enabled", extractionModel: "fixture-memory", importanceThreshold: 0.4, scheduledReflection: "enabled" },
    state: { reconciliation: "enabled", extractionModel: "fixture-state", alwaysOnTypes: ["project"], focusTtlDays: 7 },
    activeTasks: { continuation: "disabled" },
    discord: { defaultChannelId: "fixture" },
  };
}

describe("strict post-turn pipeline", () => {
  it("runs state and its visible receipt before downstream memory work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-pipeline-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    storage.bootstrapSessions([{ id: "session", type: "persistent", agent: "watson", channels: ["discord:fixture"] }]);
    const state = new StateService(storage.getDatabase());
    const order: string[] = [];
    const extractAndStoreMemoriesImpl = vi.fn(async (capture: { claimedStateFacts?: string[] }) => {
      order.push("memory");
      expect(capture.claimedStateFacts).toEqual(["Fixture Pipeline is active."]);
    });
    const hook = createV2PostTurnHook({
      v2Configs: new Map([["watson", config()]]),
      atlasMemoryClient: { memoryAdmin: vi.fn(), close: vi.fn() } as never,
      resolveProvider: () => ({ generate: vi.fn() }) as never,
      stateService: state,
      storage,
      runStateReconcilerImpl: (async (input: { service: StateService; turn: { turnId: string } }) => {
        order.push("state");
        const result = input.service.mutate({ typeId: "project", title: "Fixture Pipeline", status: "active", attributes: {} }, {
          actor: "reconciler", source: "reconciler", sessionId: "session", turnId: input.turn.turnId,
        });
        return { status: "ok", claimedFacts: ["Fixture Pipeline is active."], appliedEventIds: [result.event!.id], revertedEventIds: [], engagedEntityIds: [result.entity.id], rejected: [], proposals: 1, latencyMs: 1, providerName: "fixture", model: "fixture-state" };
      }) as never,
      extractAndStoreMemoriesImpl: extractAndStoreMemoriesImpl as never,
      publishStateReceipt: async (_context, receipt) => {
        order.push("receipt");
        expect(receipt).toContain("NEW project/fixture-pipeline");
      },
    });
    await hook({
      turnId: "turn-pipeline", conversationKey: "thread:fixture", sessionId: "session", agentId: "watson",
      userMessage: "Fixture Pipeline is active.", response: { text: "Acknowledged.", durationMs: 1 }, channelId: "fixture",
    });
    expect(order).toEqual(["state", "receipt", "memory"]);
    storage.close();
  });

  it("fails open into memory and still reconciles in memory-inert test channels", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-pipeline-fail-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const state = new StateService(storage.getDatabase());
    const reconciler = vi.fn(async () => ({ status: "error", claimedFacts: [], appliedEventIds: [], revertedEventIds: [], engagedEntityIds: [], rejected: [], proposals: 0, latencyMs: 1, error: "fixture" }));
    const memory = vi.fn().mockResolvedValue(undefined);
    const common = {
      v2Configs: new Map([["watson", config()]]), atlasMemoryClient: { close: vi.fn() } as never,
      resolveProvider: () => ({ generate: vi.fn() }) as never, stateService: state, storage,
      runStateReconcilerImpl: reconciler as never, extractAndStoreMemoriesImpl: memory as never,
    };
    const context = { turnId: "turn-fail", conversationKey: "thread:fixture", sessionId: "session", agentId: "watson", userMessage: "Fixture", response: { text: "Reply", durationMs: 1 }, channelId: "normal" };
    await createV2PostTurnHook(common)(context);
    expect(memory.mock.calls[0]?.[0]).toMatchObject({ claimedStateFacts: [] });
    const suppressed = createV2PostTurnHook({ ...common, extractionSuppressedChannelIds: new Set(["test-channel"]) });
    await suppressed({ ...context, turnId: "turn-test", channelId: "test-channel" });
    expect(reconciler).toHaveBeenCalledTimes(2);
    expect(memory).toHaveBeenCalledTimes(1);
    storage.close();
  });
});
