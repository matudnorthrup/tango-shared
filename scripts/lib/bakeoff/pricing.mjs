// Pricing: cost-per-run from token usage and a human-maintained price table.
//
// agents/evals/model-bakeoff/pricing.json holds per-Mtoken USD prices. Prices we
// don't actually know stay null — the verdict then ranks by measured tokens and
// says so. Never invent a price.

import { readFileSync, existsSync } from "node:fs";

export function loadPricing(path) {
  if (!path || !existsSync(path)) return { models: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { models: parsed.models ?? {} };
  } catch {
    return { models: {} };
  }
}

/** USD cost of one run, or null when the model's price is unknown. */
export function runCostUsd(usage, price) {
  if (!usage || !price) return null;
  const { inputPerMTokUSD, outputPerMTokUSD } = price;
  if (typeof inputPerMTokUSD !== "number" || typeof outputPerMTokUSD !== "number") return null;
  const inputTokens = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const outputTokens = usage.outputTokens ?? 0;
  return (inputTokens * inputPerMTokUSD + outputTokens * outputPerMTokUSD) / 1_000_000;
}
