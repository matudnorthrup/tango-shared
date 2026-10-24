import { describe, expect, it } from "vitest";
import {
  createSubAgentBatchBudgetState,
  runSubAgentBatch,
} from "../src/sub-agent-runner.js";

describe("runSubAgentBatch", () => {
  it("respects dependencies and preserves input order in the final results", async () => {
    const startOrder: string[] = [];
    const finishOrder: string[] = [];

    const result = await runSubAgentBatch(
      {
        sub_tasks: [
          { id: "search", task: "Search", tools: ["exa_search"] },
          { id: "analyze", task: "Analyze", tools: ["file_ops"], depends_on: ["search"] },
        ],
        concurrency: 2,
      },
      {
        executeSubTask: async (task) => {
          startOrder.push(task.id);
          if (task.id === "search") {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          finishOrder.push(task.id);
          return {
            id: task.id,
            status: "completed",
            output: `${task.id} done`,
            tool_calls: [],
            duration_ms: 5,
          };
        },
      },
    );

    expect(startOrder).toEqual(["search", "analyze"]);
    expect(finishOrder).toEqual(["search", "analyze"]);
    expect(result.results.map((item) => item.id)).toEqual(["search", "analyze"]);
    expect(result.results.every((item) => item.status === "completed")).toBe(true);
  });

  it("marks dependents as failed when an upstream task fails", async () => {
    const result = await runSubAgentBatch(
      {
        sub_tasks: [
          { id: "search", task: "Search", tools: ["exa_search"] },
          { id: "follow-up", task: "Follow up", tools: ["exa_answer"], depends_on: ["search"] },
        ],
      },
      {
        executeSubTask: async (task) => {
          if (task.id === "search") {
            return {
              id: task.id,
              status: "failed",
              output: "",
              tool_calls: [],
              duration_ms: 0,
              error: "search failed",
            };
          }

          return {
            id: task.id,
            status: "completed",
            output: "ok",
            tool_calls: [],
            duration_ms: 1,
          };
        },
      },
    );

    expect(result.results).toEqual([
      expect.objectContaining({ id: "search", status: "failed", error: "search failed" }),
      expect.objectContaining({
        id: "follow-up",
        status: "failed",
        error: "Dependency 'search' did not complete successfully.",
      }),
    ]);
  });

  it("enforces round and total sub-agent budgets across calls", async () => {
    const budget = createSubAgentBatchBudgetState();

    await runSubAgentBatch(
      {
        sub_tasks: [{ id: "one", task: "One", tools: ["exa_search"] }],
      },
      {
        budget,
        maxRounds: 1,
        maxTotalSubAgents: 2,
        executeSubTask: async (task) => ({
          id: task.id,
          status: "completed",
          output: "ok",
          tool_calls: [],
          duration_ms: 1,
        }),
      },
    );

    await expect(() =>
      runSubAgentBatch(
        {
          sub_tasks: [{ id: "two", task: "Two", tools: ["exa_search"] }],
        },
        {
          budget,
          maxRounds: 1,
          maxTotalSubAgents: 2,
          executeSubTask: async (task) => ({
            id: task.id,
            status: "completed",
            output: "ok",
            tool_calls: [],
            duration_ms: 1,
          }),
        },
      ),
    ).rejects.toThrow(/round limit/u);
  });
});
