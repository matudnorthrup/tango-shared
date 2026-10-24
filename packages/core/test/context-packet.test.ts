import { describe, expect, it } from "vitest";
import { buildContextPacket, renderContextPacket } from "../src/context-packet.js";
import type { ModelRunRecord, StoredMessageRecord } from "../src/storage.js";

function message(input: Partial<StoredMessageRecord> & Pick<StoredMessageRecord, "id" | "direction" | "content">): StoredMessageRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "tango-default",
    agentId: input.agentId ?? "watson",
    providerName: input.providerName ?? "codex",
    direction: input.direction,
    source: input.source ?? "discord",
    visibility: input.visibility ?? "public",
    discordMessageId: null,
    discordChannelId: null,
    discordUserId: null,
    discordUsername: null,
    content: input.content,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? "2026-03-05 00:00:00"
  };
}

function run(input: Partial<ModelRunRecord> & Pick<ModelRunRecord, "id" | "providerName">): ModelRunRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "tango-default",
    agentId: input.agentId ?? "watson",
    providerName: input.providerName,
    conversationKey: input.conversationKey ?? "tango-default:watson",
    providerSessionId: input.providerSessionId ?? null,
    model: input.model ?? null,
    stopReason: input.stopReason ?? null,
    responseMode: input.responseMode ?? null,
    latencyMs: input.latencyMs ?? null,
    providerDurationMs: input.providerDurationMs ?? null,
    providerApiDurationMs: input.providerApiDurationMs ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    cacheReadInputTokens: input.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: input.cacheCreationInputTokens ?? null,
    totalCostUsd: input.totalCostUsd ?? null,
    isError: input.isError ?? 0,
    errorMessage: input.errorMessage ?? null,
    requestMessageId: input.requestMessageId ?? null,
    responseMessageId: input.responseMessageId ?? null,
    metadata: input.metadata ?? null,
    rawResponse: input.rawResponse ?? null,
    createdAt: input.createdAt ?? "2026-03-05 00:00:00"
  };
}

describe("buildContextPacket", () => {
  it("builds recent turn context and excludes specified message ids", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      messages: [
        message({ id: 1, direction: "inbound", content: "first question" }),
        message({ id: 2, direction: "outbound", content: "first answer" }),
        message({ id: 3, direction: "inbound", content: "second question" })
      ],
      excludeMessageIds: [3]
    });

    expect(packet.turns).toHaveLength(2);
    expect(packet.turns[0]?.speaker).toBe("user");
    expect(packet.turns[1]?.speaker).toBe("assistant");
    expect(packet.summary).toContain("Recent turns");
    expect(packet.summary).toContain("Last user turn");
  });

  it("extracts recent tool outcomes from model run telemetry", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      messages: [],
      modelRuns: [
        run({
          id: 1,
          providerName: "codex",
          metadata: {
            toolTelemetry: {
              usedTools: ["WebSearch"],
              deniedTools: []
            }
          }
        })
      ]
    });

    expect(packet.toolOutcomes).toHaveLength(1);
    expect(packet.toolOutcomes[0]?.usedTools).toEqual(["WebSearch"]);
    expect(packet.hasHistory).toBe(true);
  });

  it("extracts recent workflow outcomes from assistant execution traces", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      messages: [
        message({
          id: 1,
          direction: "outbound",
          content: "Logged your breakfast.",
          metadata: {
            executionTrace: {
              workflow: {
                id: "wellness.log_recipe_meal",
                workerId: "nutrition-logger",
                arguments: {
                  recipe_query: "protein yogurt bowl",
                  meal: "breakfast",
                },
              },
              toolCalls: [
                {
                  toolNames: ["wellnessdb.recipes.lookup", "fatsecret.log_food"],
                },
              ],
            },
          },
        }),
      ],
    });

    expect(packet.workflowOutcomes).toHaveLength(1);
    expect(packet.workflowOutcomes[0]).toEqual({
      workflowId: "wellness.log_recipe_meal",
      workerId: "nutrition-logger",
      createdAt: "2026-03-05 00:00:00",
      arguments: {
        recipe_query: "protein yogurt bowl",
        meal: "breakfast",
      },
      toolNames: ["wellnessdb.recipes.lookup", "fatsecret.log_food"],
    });
    expect(packet.summary).toContain("Recent workflow activity captured in 1 turn");
  });
});

describe("renderContextPacket", () => {
  it("renders compact handoff text", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      compactSummary: "Compacted history: solved provider failover behavior.",
      messages: [
        message({ id: 1, direction: "inbound", content: "where are we now?" }),
        message({ id: 2, direction: "outbound", content: "we are in phase 3." })
      ]
    });

    const rendered = renderContextPacket(packet, { maxChars: 2000 });
    expect(rendered).toContain("Context handoff packet");
    expect(rendered).toContain("compacted_summary");
    expect(rendered).toContain("recent_turns");
    expect(rendered).toContain("[user at 2026-03-05 00:00:00]");
    expect(rendered).toContain("where are we now");
  });

  it("prioritizes recent turns over long compacted summaries", () => {
    const packet = buildContextPacket({
      sessionId: "project:wellness",
      agentId: "malibu",
      compactSummary:
        "Compacted history: " +
        "older context ".repeat(300),
      messages: [
        message({
          id: 1,
          sessionId: "project:wellness",
          agentId: "malibu",
          direction: "inbound",
          content: "log lunch with the recipe changes",
        }),
        message({
          id: 2,
          sessionId: "project:wellness",
          agentId: "malibu",
          direction: "outbound",
          providerName: "wellness-local",
          content: "Logged lunch and skipped garden lettuce because I could not map it cleanly.",
        }),
      ],
    });

    const rendered = renderContextPacket(packet, { maxChars: 600 });
    expect(rendered).toContain("recent_turns");
    expect(rendered).toContain("log lunch with the recipe changes");
    expect(rendered).toContain("Logged lunch and skipped garden lettuce");
    expect(rendered).toContain("compacted_summary");
    expect(rendered.indexOf("recent_turns")).toBeLessThan(rendered.indexOf("compacted_summary"));
  });

  it("renders recent workflow outcomes in the handoff packet", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      messages: [
        message({
          id: 1,
          direction: "outbound",
          content: "Relogged breakfast.",
          metadata: {
            executionTrace: {
              workflow: {
                id: "wellness.log_recipe_meal",
                workerId: "nutrition-logger",
                arguments: {
                  recipe_query: "protein yogurt bowl",
                  meal: "breakfast",
                },
              },
              toolCalls: [
                {
                  toolNames: ["wellnessdb.recipes.lookup", "fatsecret.log_food"],
                },
              ],
            },
          },
        }),
      ],
    });

    const rendered = renderContextPacket(packet, { maxChars: 2000 });
    expect(rendered).toContain("recent_workflow_outcomes");
    expect(rendered).toContain("workflow=wellness.log_recipe_meal");
    expect(rendered).toContain("worker=nutrition-logger");
    expect(rendered).toContain("tools=wellnessdb.recipes.lookup|fatsecret.log_food");
    expect(rendered).toContain("args=recipe_query|meal");
  });

  it("returns empty string for empty packet history", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      messages: []
    });

    expect(renderContextPacket(packet)).toBe("");
  });

  it("renders compacted summary even when no recent turns exist", () => {
    const packet = buildContextPacket({
      sessionId: "tango-default",
      agentId: "watson",
      compactSummary: "Compacted history: prior provider swaps and outcomes.",
      messages: []
    });

    const rendered = renderContextPacket(packet);
    expect(rendered).toContain("compacted_summary");
    expect(rendered).toContain("prior provider swaps");
  });
});
