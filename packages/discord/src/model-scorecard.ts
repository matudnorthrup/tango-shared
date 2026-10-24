// Weekly model scorecard — production is the continuous eval.
//
// Aggregates model_runs by (agent, model) over a window and flags what the
// bake-off doctrine cares about (docs/guides/model-selection.md "operating
// rule"): error-rate regressions vs the prior window, tool-iteration cap hits,
// and high-volume (agent, model) pairs whose model has never been through a
// bake-off. Pure aggregation here; the deterministic handler in main.ts feeds
// it storage rows and posts the summary.

import { isModelInOllamaCatalog } from "@tango/core";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ModelRunStatLike {
  agentId: string;
  model: string | null;
  providerName?: string;
  stopReason: string | null;
  latencyMs: number | null;
  outputTokens: number | null;
  isError: boolean;
}

export interface ModelPairStats {
  agentId: string;
  model: string;
  runs: number;
  errors: number;
  errorRate: number;
  capHits: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  meanOutputTokens: number | null;
}

export interface ModelScorecard {
  windowDays: number;
  generatedAt: string;
  pairs: ModelPairStats[];
  flags: string[];
  summary: string;
}

const CAP_STOP_REASON = "max_tool_iters";
const PAIR_KEY_SEPARATOR = "\u001f";

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

export function aggregateModelPairs(rows: ModelRunStatLike[]): ModelPairStats[] {
  const byPair = new Map<string, ModelRunStatLike[]>();
  for (const row of rows) {
    const key = `${row.agentId}${PAIR_KEY_SEPARATOR}${row.model ?? "(unknown)"}`;
    const bucket = byPair.get(key);
    if (bucket) bucket.push(row);
    else byPair.set(key, [row]);
  }

  const pairs: ModelPairStats[] = [];
  for (const [key, bucket] of byPair) {
    const splitAt = key.indexOf(PAIR_KEY_SEPARATOR);
    const agentId = key.slice(0, splitAt);
    const model = key.slice(splitAt + 1);
    const latencies = bucket
      .map((r) => r.latencyMs)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => a - b);
    const tokens = bucket
      .map((r) => r.outputTokens)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const errors = bucket.filter((r) => r.isError).length;
    pairs.push({
      agentId,
      model,
      runs: bucket.length,
      errors,
      errorRate: errors / bucket.length,
      capHits: bucket.filter((r) => r.stopReason === CAP_STOP_REASON).length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      meanOutputTokens: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null,
    });
  }
  return pairs.sort((a, b) => b.runs - a.runs);
}

/** Coverage matching is family-level for Claude tiers: verdicts record alias
 *  ids (claude:sonnet) while production logs full ids (claude-sonnet-4-6). */
export function normalizeModelForCoverage(model: string): string {
  const bare = model.replace(/^claude:/, "");
  const family = bare.match(/^claude-(opus|sonnet|haiku)\b/);
  return family?.[1] ?? bare;
}

/** Models with any bake-off verdict coverage, read from the committed verdict
 *  summaries. Claude benchmark ids count too — coverage is coverage. */
export function loadEvaluatedModels(repoRoot: string): Set<string> {
  const evaluated = new Set<string>();
  const dir = path.join(repoRoot, "agents", "evals", "model-bakeoff", "verdicts");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return evaluated;
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const entries = [parsed.latest, ...(Array.isArray(parsed.history) ? parsed.history : [])];
      for (const entry of entries) {
        for (const candidate of entry?.candidates ?? []) {
          if (typeof candidate?.model === "string") {
            evaluated.add(normalizeModelForCoverage(candidate.model));
          }
        }
      }
    } catch {
      // Unreadable verdict file — skip; the validator owns fixture hygiene.
    }
  }
  return evaluated;
}

export interface BuildScorecardInput {
  current: ModelRunStatLike[];
  previous: ModelRunStatLike[];
  /** Most-recent sub-window (e.g. 24h) — reported separately so window
   *  artifacts (like pre-migration history) are visible at a glance. */
  recent?: ModelRunStatLike[];
  evaluatedModels: Set<string>;
  windowDays: number;
  now: Date;
  /** Pairs below this run count are reported but never flagged. */
  minRunsForFlags?: number;
  /** Run count at which an unevaluated model becomes a flag. */
  minRunsForEvalFlag?: number;
  /** Live Ollama Cloud catalog ids (GET /v1/models); enables retirement flags. */
  ollamaCatalog?: string[];
  /** Every configured concrete Ollama model: agent runtime/extraction models, schedule models. */
  configuredOllamaModels?: Array<{ where: string; model: string }>;
  /** Current role resolutions (describeModelRoles) — rank > 0 means a fallback is serving. */
  roles?: Array<{ role: string; primary: string; serving: string | null; rank: number }>;
}

export function buildModelScorecard(input: BuildScorecardInput): ModelScorecard {
  const minRuns = input.minRunsForFlags ?? 5;
  const minEvalRuns = input.minRunsForEvalFlag ?? 20;
  const pairs = aggregateModelPairs(input.current);
  const previousByPair = new Map(aggregateModelPairs(input.previous).map((p) => [`${p.agentId}/${p.model}`, p]));

  const flags: string[] = [];
  for (const pair of pairs) {
    const label = `${pair.agentId} x ${pair.model}`;
    if (pair.runs >= minRuns && pair.errorRate >= 0.15) {
      flags.push(`HIGH ERROR RATE: ${label} — ${pair.errors}/${pair.runs} runs failed (${Math.round(pair.errorRate * 100)}%)`);
    }
    const prior = previousByPair.get(`${pair.agentId}/${pair.model}`);
    if (
      prior &&
      pair.runs >= minRuns &&
      prior.runs >= minRuns &&
      pair.errorRate >= 0.1 &&
      pair.errorRate >= prior.errorRate * 2
    ) {
      flags.push(`REGRESSION: ${label} — error rate ${Math.round(pair.errorRate * 100)}% vs ${Math.round(prior.errorRate * 100)}% prior window`);
    }
    if (pair.capHits > 0) {
      flags.push(`CAP HITS: ${label} — ${pair.capHits} run(s) exhausted the tool-iteration budget`);
    }
    if (pair.runs >= minEvalRuns && !input.evaluatedModels.has(normalizeModelForCoverage(pair.model))) {
      flags.push(`NEVER BAKED OFF: ${label} — ${pair.runs} production runs on a model with no verdict coverage`);
    }
  }

  // Retirements: Ollama retires whole model lines on short notice (ministral,
  // qwen3-vl, glm-5, minimax-m2.5, deepseek-v4-flash in 2026) and a retired id
  // fails every call silently. Flag every configured id missing from the catalog.
  if (input.ollamaCatalog && input.ollamaCatalog.length > 0) {
    const retired = new Map<string, string[]>();
    for (const { where, model } of input.configuredOllamaModels ?? []) {
      if (!isModelInOllamaCatalog(model, input.ollamaCatalog)) {
        retired.set(model, [...(retired.get(model) ?? []), where]);
      }
    }
    for (const [model, wheres] of retired) {
      flags.push(`RETIRED MODEL: ${model} is not in the Ollama catalog — used by ${wheres.join(", ")}`);
    }
  }
  for (const role of input.roles ?? []) {
    if (role.serving === null) {
      flags.push(`ROLE DOWN: role:${role.role} — no listed model is in the Ollama catalog`);
    } else if (role.rank > 0) {
      flags.push(`ROLE FALLBACK: role:${role.role} — primary ${role.primary} unavailable, serving ${role.serving}; re-run the role's bake-off`);
    }
  }
  // Claude family aliases (opus/sonnet) float: when an agent starts running on a
  // Claude model it didn't use in the prior window, the alias moved — re-bake.
  const priorModelsByAgent = new Map<string, Set<string>>();
  for (const p of aggregateModelPairs(input.previous)) {
    priorModelsByAgent.set(p.agentId, new Set([...(priorModelsByAgent.get(p.agentId) ?? []), p.model]));
  }
  for (const pair of pairs) {
    const prior = priorModelsByAgent.get(pair.agentId);
    if (!prior || !pair.model.startsWith("claude") || prior.has(pair.model) || pair.runs < minRuns) continue;
    const priorClaude = [...prior].filter((m) => m.startsWith("claude"));
    if (priorClaude.length > 0) {
      flags.push(`MODEL CHANGED: ${pair.agentId} now runs ${pair.model} (was ${priorClaude.join(", ")}) — re-run its bake-off fixtures`);
    }
  }

  return {
    windowDays: input.windowDays,
    generatedAt: input.now.toISOString(),
    pairs,
    flags,
    summary: renderSummary(pairs, flags, input.windowDays, input.recent),
  };
}

function fmt(value: number | null, digits = 0): string {
  return value == null ? "-" : value.toFixed(digits);
}

function renderSummary(pairs: ModelPairStats[], flags: string[], windowDays: number, recent?: ModelRunStatLike[]): string {
  const lines: string[] = [];
  const totalRuns = pairs.reduce((sum, p) => sum + p.runs, 0);
  lines.push(`**Model scorecard** — last ${windowDays}d, ${totalRuns} runs across ${pairs.length} agent x model pairs`);
  if (recent && recent.length > 0) {
    const byProvider = new Map<string, number>();
    for (const row of recent) {
      const provider = row.providerName ?? "(unknown)";
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
    }
    const split = [...byProvider.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ");
    lines.push(`Last 24h: ${recent.length} runs (${split})`);
  }
  lines.push("");
  if (flags.length > 0) {
    lines.push("Flagged:");
    for (const flag of flags) lines.push(`- ${flag}`);
    lines.push("");
  } else {
    lines.push("No flags — error rates, caps, and eval coverage all nominal.");
    lines.push("");
  }
  lines.push("```");
  lines.push("agent x model                            runs err% caps  p50s  tok");
  for (const p of pairs.slice(0, 12)) {
    const name = `${p.agentId} ${p.model}`.slice(0, 40).padEnd(40);
    lines.push(
      `${name} ${String(p.runs).padStart(4)} ${String(Math.round(p.errorRate * 100)).padStart(3)}% ${String(p.capHits).padStart(4)} ${fmt(p.p50LatencyMs == null ? null : p.p50LatencyMs / 1000).padStart(5)} ${fmt(p.meanOutputTokens).padStart(4)}`,
    );
  }
  if (pairs.length > 12) lines.push(`… +${pairs.length - 12} more pairs`);
  lines.push("```");
  return lines.join("\n");
}
