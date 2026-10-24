import type {
  ActiveTaskRecord,
  ActiveTaskStatusUpdateInput,
  ActiveTaskUpsertInput,
  ChatProvider,
  V2AgentConfig,
} from "@tango/core";
import { describe, expect, it, vi } from "vitest";
import {
  applyActiveTaskPlan,
  buildActiveTaskExtractionPrompt,
  parseActiveTaskPlan,
  renderActiveTasksWarmStartBlock,
  resolveActiveTaskContinuationSettings,
  runActiveTaskPostTurn,
  type ActiveTaskStorage,
  type ActiveTaskTurnContext,
} from "../src/active-task-continuation.js";

function buildTask(overrides: Partial<ActiveTaskRecord> = {}): ActiveTaskRecord {
  return {
    id: "task-1",
    sessionId: "session-1",
    agentId: "sierra",
    status: "awaiting_user",
    title: "Review protein yogurt bowl recipe",
    objective: "Read the protein yogurt bowl recipe and summarize the ingredients.",
    ownerWorkerId: null,
    intentIds: [],
    missingSlots: [],
    clarificationQuestion: "Want me to pull up the recipe?",
    suggestedNextAction: "Confirm the recipe read.",
    structuredContext: null,
    sourceKind: "assistant-offer",
    createdByMessageId: null,
    updatedByMessageId: null,
    createdAt: "2026-06-10 00:00:00",
    updatedAt: "2026-06-10 00:00:00",
    resolvedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function buildV2Config(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
  return {
    id: "sierra",
    displayName: "Sierra",
    type: "assistant",
    systemPromptFile: "prompt.md",
    mcpServers: [{ name: "tango", command: "noop" }],
    runtime: {
      mode: "persistent",
      provider: "claude-code-v2",
      model: "claude-sonnet-4-6",
      reasoningEffort: "low",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
    },
    memory: {
      postTurnExtraction: "enabled",
      extractionModel: "memory-model",
      importanceThreshold: 0.4,
      scheduledReflection: "disabled",
    },
    discord: { defaultChannelId: "123" },
    ...overrides,
  };
}

function buildContext(overrides: Partial<ActiveTaskTurnContext> = {}): ActiveTaskTurnContext {
  return {
    sessionId: "session-1",
    agentId: "sierra",
    userMessage: "find me a hotel in Fairview",
    agentResponse: "I found three options. I'll keep comparing rates and report back.",
    toolsUsed: ["browser_navigate"],
    requestMessageId: 11,
    responseMessageId: 12,
    ...overrides,
  };
}

function buildStorage(openTasks: ActiveTaskRecord[] = []): ActiveTaskStorage & {
  upserts: ActiveTaskUpsertInput[];
  statusUpdates: ActiveTaskStatusUpdateInput[];
} {
  const upserts: ActiveTaskUpsertInput[] = [];
  const statusUpdates: ActiveTaskStatusUpdateInput[] = [];
  return {
    upserts,
    statusUpdates,
    listActiveTasks: () => openTasks,
    upsertActiveTask: (input) => {
      upserts.push(input);
      return input.id ?? "generated-id";
    },
    updateActiveTaskStatus: (input) => {
      statusUpdates.push(input);
      return true;
    },
  };
}

describe("resolveActiveTaskContinuationSettings", () => {
  it("defaults to the claude provider for a claude extraction model", () => {
    const config = buildV2Config();
    config.memory = { ...config.memory, extractionModel: "claude-haiku-4-5" };
    const settings = resolveActiveTaskContinuationSettings(config);
    expect(settings).toEqual({
      extractionProvider: "claude-oauth",
      extractionModel: "claude-haiku-4-5",
    });
  });

  it("routes a non-claude extraction model to ollama even on a claude-served agent", () => {
    // TGO-867: claude-primary agents kept deepseek for extraction after the
    // 2026-07-18 flip; the serving backend must not decide the provider.
    const config = buildV2Config();
    config.memory = { ...config.memory, extractionModel: "deepseek-v4-pro:cloud" };
    expect(resolveActiveTaskContinuationSettings(config)).toEqual({
      extractionProvider: "ollama",
      extractionModel: "deepseek-v4-pro:cloud",
    });
  });

  it("derives the ollama provider for ollama-backed agents", () => {
    const settings = resolveActiveTaskContinuationSettings(
      buildV2Config({ legacyProvider: { default: "ollama" } }),
    );
    expect(settings?.extractionProvider).toBe("ollama");
  });

  it("honours explicit active_tasks overrides", () => {
    const settings = resolveActiveTaskContinuationSettings(
      buildV2Config({
        activeTasks: {
          continuation: "enabled",
          extractionProvider: "codex",
          extractionModel: "task-model",
        },
      }),
    );
    expect(settings).toEqual({ extractionProvider: "codex", extractionModel: "task-model" });
  });

  it("returns null when disabled or when no v2 config exists", () => {
    expect(
      resolveActiveTaskContinuationSettings(
        buildV2Config({ activeTasks: { continuation: "disabled" } }),
      ),
    ).toBeNull();
    expect(resolveActiveTaskContinuationSettings(null)).toBeNull();
  });
});

describe("renderActiveTasksWarmStartBlock", () => {
  it("renders open tasks with clarification and next action", () => {
    const block = renderActiveTasksWarmStartBlock([buildTask()]);
    expect(block).toContain("Active tasks (unfinished from earlier in this conversation):");
    expect(block).toContain("- [awaiting_user] Review protein yogurt bowl recipe");
    expect(block).toContain('asked: "Want me to pull up the recipe?"');
    expect(block).toContain("next: Confirm the recipe read.");
    expect(block).toContain("continue that task and complete it now");
  });

  it("returns undefined when there are no open tasks", () => {
    expect(renderActiveTasksWarmStartBlock([])).toBeUndefined();
    expect(
      renderActiveTasksWarmStartBlock([buildTask({ status: "completed" })]),
    ).toBeUndefined();
  });

  it("caps the number of rendered tasks", () => {
    const tasks = Array.from({ length: 5 }, (_, index) =>
      buildTask({ id: `task-${index}`, title: `Task ${index}` }),
    );
    const block = renderActiveTasksWarmStartBlock(tasks, { limit: 2 });
    expect(block).toContain("Task 0");
    expect(block).toContain("Task 1");
    expect(block).not.toContain("Task 2");
  });
});

describe("parseActiveTaskPlan", () => {
  it("parses a plain JSON plan", () => {
    const plan = parseActiveTaskPlan(
      JSON.stringify({
        resolutions: [{ id: "task-1", status: "completed" }],
        capture: {
          title: "Finish Marriott rate comparison",
          objective: "Compare the remaining Marriott rates and report the best option.",
          status: "blocked",
          suggested_next_action: "Re-open the Marriott results and finish the comparison.",
          source_kind: "dangling-intent",
        },
      }),
      new Set(["task-1"]),
    );

    expect(plan.resolutions).toEqual([{ id: "task-1", status: "completed" }]);
    expect(plan.capture).toMatchObject({
      title: "Finish Marriott rate comparison",
      status: "blocked",
      sourceKind: "dangling-intent",
      suggestedNextAction: "Re-open the Marriott results and finish the comparison.",
    });
  });

  it("parses fenced JSON and ignores prose around it", () => {
    const plan = parseActiveTaskPlan(
      'Sure! Here is the plan:\n```json\n{"resolutions": [], "capture": null}\n```\nDone.',
      new Set(),
    );
    expect(plan).toEqual({ resolutions: [], capture: null });
  });

  it("drops hallucinated task ids and invalid statuses", () => {
    const plan = parseActiveTaskPlan(
      JSON.stringify({
        resolutions: [
          { id: "task-1", status: "completed" },
          { id: "not-a-real-task", status: "completed" },
          { id: "task-1", status: "running" },
        ],
        capture: { title: "x", objective: "y", status: "running" },
      }),
      new Set(["task-1"]),
    );
    expect(plan.resolutions).toEqual([{ id: "task-1", status: "completed" }]);
    expect(plan.capture).toBeNull();
  });

  it("falls back to assistant-offer for unknown source kinds", () => {
    const plan = parseActiveTaskPlan(
      JSON.stringify({
        resolutions: [],
        capture: { title: "x", objective: "y", status: "awaiting_user", source_kind: "weird" },
      }),
      new Set(),
    );
    expect(plan.capture?.sourceKind).toBe("assistant-offer");
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseActiveTaskPlan("no json here", new Set())).toThrow();
  });
});

describe("buildActiveTaskExtractionPrompt", () => {
  it("includes open tasks, the exchange, and tools used", () => {
    const prompt = buildActiveTaskExtractionPrompt(buildContext(), [buildTask()]);
    expect(prompt).toContain('"id":"task-1"');
    expect(prompt).toContain("find me a hotel in Fairview");
    expect(prompt).toContain("Tools used this turn: browser_navigate");
    expect(prompt).toContain("dangling-intent");
  });

  it("marks the open task list as none when empty", () => {
    const prompt = buildActiveTaskExtractionPrompt(buildContext(), []);
    expect(prompt).toContain("Open tasks: none");
  });
});

describe("applyActiveTaskPlan", () => {
  it("persists resolutions and a new capture with expiry and provenance", () => {
    const storage = buildStorage();
    const outcome = applyActiveTaskPlan({
      storage,
      context: buildContext(),
      openTasks: [buildTask()],
      plan: {
        resolutions: [{ id: "task-1", status: "completed" }],
        capture: {
          title: "Finish Marriott rate comparison",
          objective: "Compare the remaining Marriott rates.",
          status: "blocked",
          sourceKind: "dangling-intent",
        },
      },
    });

    expect(outcome.resolvedCount).toBe(1);
    expect(storage.statusUpdates).toEqual([
      { id: "task-1", status: "completed", updatedByMessageId: 12 },
    ]);
    expect(storage.upserts).toHaveLength(1);
    const upsert = storage.upserts[0]!;
    expect(upsert.id).toBeUndefined();
    expect(upsert.sessionId).toBe("session-1");
    expect(upsert.status).toBe("blocked");
    expect(upsert.sourceKind).toBe("dangling-intent");
    expect(upsert.createdByMessageId).toBe(11);
    expect(upsert.updatedByMessageId).toBe(12);
    expect(new Date(upsert.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("refreshes an open task instead of duplicating it when titles match", () => {
    const storage = buildStorage();
    const existing = buildTask({ title: "Finish Marriott rate comparison" });
    applyActiveTaskPlan({
      storage,
      context: buildContext(),
      openTasks: [existing],
      plan: {
        resolutions: [],
        capture: {
          title: "  finish marriott RATE comparison ",
          objective: "Compare the remaining Marriott rates.",
          status: "blocked",
          sourceKind: "dangling-intent",
        },
      },
    });

    expect(storage.upserts).toHaveLength(1);
    expect(storage.upserts[0]!.id).toBe("task-1");
  });

  it("does nothing beyond resolutions when capture is null", () => {
    const storage = buildStorage();
    const outcome = applyActiveTaskPlan({
      storage,
      context: buildContext(),
      openTasks: [],
      plan: { resolutions: [], capture: null },
    });
    expect(outcome).toEqual({ capturedTaskId: null, capturedTitle: null, resolvedCount: 0 });
    expect(storage.upserts).toHaveLength(0);
  });
});

describe("runActiveTaskPostTurn", () => {
  it("runs extraction through the resolved provider and applies the plan", async () => {
    const storage = buildStorage([buildTask()]);
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        resolutions: [{ id: "task-1", status: "completed" }],
        capture: null,
      }),
    });
    const provider: ChatProvider = { generate };

    const outcome = await runActiveTaskPostTurn({
      storage,
      context: buildContext(),
      v2Config: buildV2Config(),
      // The fixture's "memory-model" is not a Claude id, so it routes to ollama.
      resolveProvider: (name) => (name === "ollama" ? provider : undefined),
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "memory-model", reasoningEffort: "low" }),
    );
    expect(outcome?.resolvedCount).toBe(1);
    expect(storage.statusUpdates).toHaveLength(1);
  });

  it("skips when continuation is disabled or the provider is missing", async () => {
    const storage = buildStorage();
    expect(
      await runActiveTaskPostTurn({
        storage,
        context: buildContext(),
        v2Config: buildV2Config({ activeTasks: { continuation: "disabled" } }),
        resolveProvider: () => ({ generate: vi.fn() }),
      }),
    ).toBeNull();

    expect(
      await runActiveTaskPostTurn({
        storage,
        context: buildContext(),
        v2Config: buildV2Config(),
        resolveProvider: () => undefined,
      }),
    ).toBeNull();
  });

  it("skips empty agent responses", async () => {
    const generate = vi.fn();
    expect(
      await runActiveTaskPostTurn({
        storage: buildStorage(),
        context: buildContext({ agentResponse: "   " }),
        v2Config: buildV2Config(),
        resolveProvider: () => ({ generate }),
      }),
    ).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});
