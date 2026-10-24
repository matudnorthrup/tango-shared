import { describe, expect, it } from "vitest";
import {
  buildSpawnSubAgentsToolDefinition,
  evaluateSubAgentBatchQuality,
  resolveSubTaskProviderNames,
  resolveSubTaskToolConfig,
  summarizeSubAgentResearchQuality,
} from "../src/mcp-sub-agent-server.js";

describe("mcp sub-agent server helpers", () => {
  it("marks spawn_sub_agents as a read-only open-world tool", () => {
    expect(buildSpawnSubAgentsToolDefinition()).toMatchObject({
      name: "spawn_sub_agents",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
  });

  it("maps abstract web tools to provider-native search and keeps MCP tool ids concrete", () => {
    expect(resolveSubTaskToolConfig([
      "web",
      "web.run",
      "web_fetch",
      "exa_search",
      "printer_command",
    ])).toEqual({
      concreteToolIds: ["exa_search", "printer_command"],
      providerAllowlist: ["WebSearch", "WebFetch"],
    });
  });

  it("treats an explicit sub-agent provider as a preferred starting point, not an exclusive one", () => {
    expect(resolveSubTaskProviderNames({
      id: "options",
      task: "Compare the lineup",
      tools: ["web"],
      provider: "claude-oauth",
    })).toEqual(["claude-oauth", "claude-oauth-secondary", "codex"]);

    expect(resolveSubTaskProviderNames({
      id: "options",
      task: "Compare the lineup",
      tools: ["web"],
      provider: "codex",
    })).toEqual(["codex", "claude-oauth", "claude-oauth-secondary"]);
  });

  it("summarizes structured research evidence for telemetry", () => {
    const summary = summarizeSubAgentResearchQuality(
      {
        id: "pricing",
        task: "Research pricing",
        tools: ["web"],
        output_schema: "research_evidence_v1",
        required_fields: ["price", "availability"],
      },
      JSON.stringify({
        summary: "Two options found.",
        answered_questions: [
          { question: "What is the best option?", answer: "Option A", confidence: "high" },
        ],
        required_field_values: {
          price: "$99",
          availability: "in stock",
        },
        source_urls: ["https://example.com/a"],
      }),
    );

    expect(summary).toMatchObject({
      parsed: true,
      sourceUrls: ["https://example.com/a"],
      answeredQuestions: ["What is the best option?"],
      valueKeys: ["price", "availability"],
    });
  });

  it("evaluates missing coverage and follow-up needs generically", () => {
    const evaluation = evaluateSubAgentBatchQuality({
      tasks: [{
        id: "options",
        task: "Research options",
        tools: ["web"],
        output_schema: "research_evidence_v1",
        must_answer: ["What is the best option?"],
        comparison_axes: ["price", "availability"],
        required_fields: ["price", "availability"],
        constraints: ["fits in a small space"],
        success_criteria: ["Tie the recommendation to the user's constraint"],
      }],
      results: [{
        id: "options",
        status: "completed",
        output: JSON.stringify({
          summary: "Found one option.",
          answered_questions: [
            { question: "What is the best option?", answer: "Option A", confidence: "medium" },
          ],
          required_field_values: {
            price: "$99",
          },
          source_urls: ["https://example.com/a"],
        }),
        tool_calls: [],
        duration_ms: 10,
      }],
      qualityGate: {
        task_class: "decision_support",
        must_answer: ["What is the best option?"],
        comparison_axes: ["price", "availability"],
        required_fields: ["price", "availability"],
        constraints: ["fits in a small space"],
        success_criteria: ["Tie the recommendation to the user's constraint"],
        require_structured_output: true,
        min_source_count: 1,
      },
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.missing_required_fields).toEqual(["availability"]);
    expect(evaluation.missing_comparison_axes).toEqual(["availability"]);
    expect(evaluation.missing_constraints).toEqual(["fits in a small space"]);
    expect(evaluation.missing_success_criteria).toEqual(["Tie the recommendation to the user's constraint"]);
    expect(evaluation.follow_up_recommendations).toHaveLength(1);
  });
});
