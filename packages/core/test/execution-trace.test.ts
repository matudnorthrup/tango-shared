import { describe, expect, it } from "vitest";
import { extractExecutionTrace, formatExecutionTraceForLog } from "../src/execution-trace.js";

describe("execution trace", () => {
  it("extracts a compact execution trace from provider raw payloads", () => {
    const trace = extractExecutionTrace({
      execution: "wellness-local",
      execution_trace: {
        execution: "wellness-local",
        flow: "planned-read",
        planner: {
          mode: "read",
          confidence: 0.94,
          operations: [
            {
              tool: "nutrition.day_summary",
              dateScope: "yesterday",
              focus: "macros",
            },
          ],
          runtime: {
            mode: "provider",
            providerName: "claude-oauth",
          },
        },
        toolCalls: [
          {
            tool: "nutrition.day_summary",
            toolNames: ["fatsecret.day_summary"],
            input: {
              date: "2026-03-06",
              label: "yesterday",
            },
          },
        ],
        synthesis: {
          mode: "provider",
          providerName: "claude-oauth",
        },
      },
    });

    expect(trace).toEqual({
      execution: "wellness-local",
      flow: "planned-read",
      planner: {
        mode: "read",
        confidence: 0.94,
        operations: [
          {
            tool: "nutrition.day_summary",
            dateScope: "yesterday",
            focus: "macros",
          },
        ],
        runtime: {
          mode: "provider",
          providerName: "claude-oauth",
        },
      },
      toolCalls: [
        {
          tool: "nutrition.day_summary",
          toolNames: ["fatsecret.day_summary"],
          input: {
            date: "2026-03-06",
            label: "yesterday",
          },
        },
      ],
      synthesis: {
        mode: "provider",
        providerName: "claude-oauth",
      },
    });
  });

  it("formats execution traces for live logs", () => {
    const summary = formatExecutionTraceForLog({
      flow: "workflow",
      workflow: {
        id: "wellness.log_recipe_meal",
        workerId: "nutrition-logger",
        runtime: {
          mode: "provider",
          providerName: "claude-oauth",
        },
        argumentResolution: {
          mode: "provider",
          providerName: "claude-oauth",
        },
      },
      toolCalls: [
        {
          toolNames: [
            "wellnessdb.recipes.lookup",
            "wellnessdb.ingredients.lookup",
            "fatsecret.log_food",
            "fatsecret.day_summary",
          ],
        },
      ],
    });

    expect(summary).toBe(
      "flow=workflow workflow=wellness.log_recipe_meal worker=nutrition-logger route=provider:claude-oauth argres=provider:claude-oauth tools=wellnessdb.recipes.lookup,wellnessdb.ingredients.lookup,fatsecret.log_food,fatsecret.day_summary",
    );
  });

  it("formats worker-read traces for live logs", () => {
    const summary = formatExecutionTraceForLog({
      flow: "worker-read",
      worker: {
        id: "nutrition-logger",
        runtime: {
          mode: "provider",
          providerName: "claude-oauth",
        },
        planRuntime: {
          mode: "provider",
          providerName: "claude-oauth",
        },
        operations: [
          {
            toolContractId: "fatsecret.day_summary",
            arguments: {
              date_scope: "today",
              compare_date_scopes: ["today", "yesterday"],
            },
          },
        ],
      },
      toolCalls: [
        {
          toolNames: ["fatsecret.day_summary"],
        },
      ],
      synthesis: {
        mode: "provider",
        providerName: "claude-oauth",
      },
    });

    expect(summary).toBe(
      "flow=worker-read worker=nutrition-logger select=provider:claude-oauth toolplan=provider:claude-oauth ops=1 tools=fatsecret.day_summary synthesis=provider:claude-oauth",
    );
  });
});
