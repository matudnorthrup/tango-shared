import { describe, expect, it, vi } from "vitest";
import type { ScheduleConfig } from "@tango/core";
import { buildScheduledReviewContext, isOpenScheduleModel, selectScheduledActiveTasks, selectScheduledAgent, type ScheduledReviewContextDeps } from "../src/scheduled-review-context.js";

const config: ScheduleConfig = {
  id: "review", enabled: true, description: "Review open items", runtime: "v2",
  schedule: { cron: "0 23 * * *" },
  execution: { mode: "agent", workerId: "finance", contextDependencies: ["receipts"] },
  delivery: { agentId: "foxtrot", channelId: "finance-thread" },
};
const input = { config, agentId: "foxtrot", agentIds: ["foxtrot", "foxtrot-ollama"], task: "Generic introduction. ".repeat(20) + "Specific purchase reference at the end." };
function dependencies(): ScheduledReviewContextDeps {
  return {
    resolveConversation: vi.fn(async () => ({ sessionId: "finance-session", agentId: "foxtrot-ollama", channelId: "finance-parent", threadId: "finance-thread" })),
    buildWarmStart: vi.fn(async () => ({ prompt: "Prior confirmed category; receipt work is open.", diagnostics: {} })),
    getDependency: vi.fn(() => ({ config: { ...config, id: "receipts" }, latestRun: { id: 12, status: "running", startedAt: "2026-01-02T23:00:00Z", finishedAt: null } })),
  };
}

describe("scheduled review context", () => {
  it("uses the source thread, canonical agent and entire task with bounded stateless context", async () => {
    const deps = dependencies();
    const result = await buildScheduledReviewContext(input, deps);
    expect(deps.buildWarmStart).toHaveBeenCalledWith({ sessionId: "finance-session", agentId: "foxtrot", currentUserPrompt: input.task, discordChannelId: "finance-parent", discordThreadId: "finance-thread", orchestratorContinuityMode: "stateless", scheduledReview: true, scheduledAgentIds: input.agentIds });
    expect(result.prompt).toContain("Prior confirmed category");
    expect(result.prompt).toContain('"status":"running"');
    expect(result.diagnostics).toEqual({ conversation: "loaded", memory: "loaded", dependencyCount: 1 });
  });

  it("does not read another agent's conversation or dependency", async () => {
    const deps = dependencies();
    deps.resolveConversation = vi.fn(async () => ({ sessionId: "private-session", agentId: "victor", channelId: "private-channel" }));
    deps.getDependency = vi.fn(() => ({ config: { ...config, delivery: { agentId: "victor" } } }));
    const result = await buildScheduledReviewContext(input, deps);
    expect(deps.buildWarmStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "schedule-context:review:foxtrot" }));
    expect(deps.buildWarmStart).not.toHaveBeenCalledWith(expect.objectContaining({ discordChannelId: expect.anything() }));
    expect(result.diagnostics.conversation).toBe("unavailable");
    expect(result.prompt).toContain('"status":"unavailable"');
    expect(result.prompt).not.toContain("private");
  });

  it("still loads agent memory if Discord cannot resolve the delivery surface", async () => {
    const deps = dependencies();
    deps.resolveConversation = vi.fn(async () => { throw new Error("offline"); });
    const result = await buildScheduledReviewContext(input, deps);
    expect(result.diagnostics).toMatchObject({ conversation: "unavailable", memory: "loaded" });
    expect(result.prompt).toContain("Prior confirmed category");
  });

  it.each(["throw", "diagnostic"])("exposes unavailable context on a %s failure", async (failure) => {
    const deps = dependencies();
    deps.buildWarmStart = vi.fn(async () => {
      if (failure === "throw") throw new Error("offline");
      return { diagnostics: { error: "offline" } };
    });
    const result = await buildScheduledReviewContext(input, deps);
    expect(result.prompt).toContain("conversation=unavailable; memory=unavailable");
  });

  it("represents missing, disabled, and failed dependencies without claiming item completion", async () => {
    const deps = dependencies();
    deps.getDependency = vi.fn(() => ({ config: { ...config, enabled: false }, latestRun: { id: 3, status: "error", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" } }));
    let result = await buildScheduledReviewContext(input, deps);
    expect(result.prompt).toContain('"enabled":false');
    expect(result.prompt).toContain('"status":"error"');
    deps.getDependency = () => undefined;
    result = await buildScheduledReviewContext(input, deps);
    expect(result.prompt).toContain('"status":"unavailable"');
  });

  it("supports jobs without delivery and non-finance agents", async () => {
    const deps = dependencies();
    const result = await buildScheduledReviewContext({ ...input, agentId: "watson", agentIds: ["watson"], config: { ...config, delivery: undefined } }, deps);
    expect(deps.resolveConversation).not.toHaveBeenCalled();
    expect(result.diagnostics.conversation).toBe("not-configured");
    expect(deps.buildWarmStart).toHaveBeenCalledWith(expect.objectContaining({ agentId: "watson" }));
  });
});

describe("scheduled reasoning model selection", () => {
  const routing = { agentId: "foxtrot", config, useOllama: true, excluded: false, cloneExists: true };
  it("preserves explicitly configured model or effort instead of using a clone", () => {
    for (const provider of [{ model: "claude-sonnet-4-6" }, { reasoningEffort: "high" as const }, { default: "claude" }]) {
      expect(selectScheduledAgent({ ...routing, config: { ...config, provider } })).toBe("foxtrot");
    }
  });
  it("retains clone routing for unpinned jobs and explicit clones", () => {
    expect(selectScheduledAgent(routing)).toBe("foxtrot-ollama");
    expect(selectScheduledAgent({ ...routing, agentId: "foxtrot-ollama" })).toBe("foxtrot-ollama");
    expect(selectScheduledAgent({ ...routing, excluded: true })).toBe("foxtrot");
    expect(selectScheduledAgent({ ...routing, cloneExists: false })).toBe("foxtrot");
    expect(selectScheduledAgent({ ...routing, useOllama: false })).toBe("foxtrot");
  });
  it("routes a schedule that names an open model to the clone, even with useOllama off", () => {
    for (const model of ["role:job-digest", "deepseek-v4-pro:cloud", "deepseek-v4.1-flash"]) {
      expect(selectScheduledAgent({ ...routing, useOllama: false, config: { ...config, provider: { model } } })).toBe("foxtrot-ollama");
    }
    // …but never without a clone, and a Claude model keeps the base agent.
    expect(selectScheduledAgent({ ...routing, cloneExists: false, config: { ...config, provider: { model: "role:job-digest" } } })).toBe("foxtrot");
    expect(selectScheduledAgent({ ...routing, useOllama: false, config: { ...config, provider: { model: "claude-sonnet-5" } } })).toBe("foxtrot");
  });
  it("classifies open schedule models", () => {
    expect(isOpenScheduleModel("role:x")).toBe(true);
    expect(isOpenScheduleModel("glm-5.3")).toBe(true);
    for (const m of ["claude-opus-5-5", "claude:sonnet", "sonnet", "opus", "haiku", "fable", "", undefined]) {
      expect(isOpenScheduleModel(m)).toBe(false);
    }
  });
});


describe("scheduled open-task provenance", () => {
  it("requires a public latest source in the current surface owned by the same agent", () => {
    const tasks = [1, 2, 3, 4, 5].map((id) => ({ id, agentId: "foxtrot", createdByMessageId: id, updatedByMessageId: id === 5 ? 6 : null }));
    const messages = new Map([
      [1, { discordChannelId: "thread", visibility: "public", agentId: "foxtrot" }],
      [2, { discordChannelId: "parent", visibility: "public", agentId: "foxtrot" }],
      [3, { discordChannelId: "thread", visibility: "internal", agentId: "foxtrot" }],
      [4, { discordChannelId: "thread", visibility: "public", agentId: "victor" }],
      [5, { discordChannelId: "thread", visibility: "public", agentId: "foxtrot" }],
    ]);
    const get = (id: number) => (messages.get(id) ?? null) as never;
    expect(selectScheduledActiveTasks(tasks as never, "thread", get).map((task) => task.id)).toEqual([1]);
    expect(selectScheduledActiveTasks(tasks as never, null, get)).toEqual([]);
  });
});
