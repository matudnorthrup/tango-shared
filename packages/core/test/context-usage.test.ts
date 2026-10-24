import { describe, expect, it } from "vitest";

import {
  extractContextUsageFraction,
  extractResponderContextUsage,
  formatContextUsageSummary,
  shouldResetContextPressureAlert,
  shouldSendContextPressureAlert,
} from "../src/context-usage.js";

describe("context-usage", () => {
  it("returns responder model usage with token breakdown", () => {
    const usage = extractResponderContextUsage({
      raw: {
        modelUsage: {
          "claude-haiku-4-5": {
            inputTokens: 100,
            outputTokens: 50,
            contextWindow: 200_000,
          },
          "claude-opus-4-6": {
            inputTokens: 10_000,
            outputTokens: 2_000,
            cacheReadInputTokens: 50_000,
            cacheCreationInputTokens: 0,
            contextWindow: 200_000,
          },
        },
      },
    });

    expect(usage).toBeDefined();
    expect(usage!.contextWindow).toBe(200_000);
    expect(usage!.totalTokens).toBe(62_000);
    expect(usage!.fraction).toBeCloseTo(62_000 / 200_000, 6);
  });

  it("falls back to precomputed fraction fields", () => {
    expect(extractContextUsageFraction({ contextUsage: 0.61 })).toBe(0.61);
  });

  it("formats readable context summaries", () => {
    expect(
      formatContextUsageSummary({
        fraction: 0.62,
        totalTokens: 124_000,
        contextWindow: 200_000,
      }),
    ).toBe("Context: 62% (124K / 200K tokens)");
  });

  it("fires one alert at threshold and resets after drop", () => {
    expect(shouldSendContextPressureAlert({ fraction: 0.69 }, false)).toBe(false);
    expect(shouldSendContextPressureAlert({ fraction: 0.71 }, false)).toBe(true);
    expect(shouldSendContextPressureAlert({ fraction: 0.71 }, true)).toBe(false);
    expect(shouldResetContextPressureAlert({ fraction: 0.64 })).toBe(true);
    expect(shouldResetContextPressureAlert({ fraction: 0.68 })).toBe(false);
  });

  it("derives occupancy from raw assistant stream events when normalized fields are missing", () => {
    const usage = extractResponderContextUsage({
      raw: {
        events: [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "done" }],
              usage: {
                inputTokens: 12,
                cacheReadInputTokens: 90_000,
                cacheCreationInputTokens: 1_000,
                outputTokens: 20,
              },
            },
          },
          {
            type: "result",
            modelUsage: {
              "claude-opus-4-8": {
                inputTokens: 12,
                outputTokens: 20,
                cacheReadInputTokens: 90_000,
                cacheCreationInputTokens: 1_000,
                contextWindow: 200_000,
              },
            },
          },
        ],
      },
    });

    expect(usage?.totalTokens).toBe(91_012);
    expect(usage?.fraction).toBeCloseTo(91_012 / 200_000, 6);
  });
});
