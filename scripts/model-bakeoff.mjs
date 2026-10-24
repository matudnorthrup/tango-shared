#!/usr/bin/env node
// Model bake-off harness v2 — evaluate which model should run a Tango task.
//
// Doctrine (docs/guides/model-selection.md): reliability first, then cost, then
// speed. Each candidate runs the SAME task N times; a run passes only if every
// machine-checked gate passes (tool contract with argument checks, output
// assertions, forbidden actions); quality is scored by a blind Claude-CLI judge
// against the fixture rubric. The verdict gates on pass-rate, then ranks the
// eligible candidates by cost-per-successful-run (token fallback when prices are
// unknown), with latency as the tiebreak and incumbent hysteresis so assignments
// only change when a challenger strictly earns it.
//
// Usage:
//   node scripts/model-bakeoff.mjs --task agents/evals/model-bakeoff/tasks/<fixture>.json [--runs N] [--models a,b] [--benchmarks claude:sonnet,claude:opus] [--no-judge] [--full]
//   node scripts/model-bakeoff.mjs --prompt "..." [--system "..."] [--worker watson-ollama] [--models a,b,c] [--no-tools] [--full]
//   Extra: --judges sonnet,glm-5.3 (judge panel)  --concurrency N (candidates in parallel; runs within a
//   candidate stay sequential)  claude-opus-5-5@high (effort suffix for Claude candidates)
//
// Requires: OLLAMA_API_KEY in .env (Ollama candidates); the :9100 MCP server when
// tools are used; a logged-in `claude` CLI for claude:* benchmarks and the judge.
// Candidates run SEQUENTIALLY so wall-clock timings are comparable.
//
// Full per-run results (transcripts) → ~/.tango/evals/results/<fixture>/ (private).
// Committed-safe verdict summary     → agents/evals/model-bakeoff/verdicts/<fixture>.json

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadFixture, adHocFixture, normalizeFixture, isClaudeModel, HARNESS_VERSION } from "./lib/bakeoff/fixtures.mjs";
import { evaluateGates } from "./lib/bakeoff/gates.mjs";
import { runOllamaOnce, runClaudeOnce, loadFixtureImages } from "./lib/bakeoff/runners.mjs";
import { judgePanel } from "./lib/bakeoff/judge.mjs";
import { resolveAgentSystemPrompt } from "./lib/bakeoff/agent-prompt.mjs";
import { loadPricing, runCostUsd } from "./lib/bakeoff/pricing.mjs";
import { summarizeCandidate, computeVerdict, isEligible, pct, costLabel } from "./lib/bakeoff/verdict.mjs";
import { isClaudeJudgeModel } from "./lib/bakeoff/claude-env.mjs";
import { persistFullResults, persistVerdictSummary, defaultResultsRoot } from "./lib/bakeoff/persist.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const csv = (value) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
// --task alongside --recompute/--rejudge means "use the current fixture file,
// not the fixture snapshot stored with the results".
const taskFileForRecompute = () => arg("task");

const DEFAULT_MODELS = [
  "deepseek-v4-pro:cloud",
  "deepseek-v4-flash",
  "minimax-m2.5",
  "kimi-k2.6",
  "glm-5.2",
];

// Judge + claude:* spawns must not depend on the interactive CLI login (it
// expired mid-run 2026-06-10, silently breaking 40 judge calls): ride the
// bot's long-lived token from .env, inherited by child processes. Must happen
// before the --rejudge/--recompute early branches, which also spawn the judge.
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  const oauthToken = readEnvKey("CLAUDE_CODE_OAUTH_TOKEN");
  if (oauthToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
}

// ---- Recompute mode: re-apply the current verdict policy to stored results ----
// Policy changes (thresholds, floors, ranking) shouldn't require re-running
// models: `--recompute <results.json>` re-summarizes and re-verdicts a stored
// run from ~/.tango/evals/results/ and refreshes the committed verdict summary.
const recomputePath = arg("recompute");
if (recomputePath) {
  const stored = JSON.parse(readFileSync(resolve(process.cwd(), recomputePath), "utf8"));
  // Re-apply the CURRENT fixture definition when available, so gate fixes
  // (not just thresholds) re-score stored runs without re-running models.
  let fixtureSource = stored.fixture;
  if (taskFileForRecompute()) fixtureSource = JSON.parse(readFileSync(resolve(process.cwd(), taskFileForRecompute()), "utf8"));
  const fx = normalizeFixture(fixtureSource, { sourcePath: fixtureSource.sourcePath ?? stored.fixture.sourcePath });
  for (const candidate of stored.candidates) {
    for (const run of candidate.runs) {
      run.gates = evaluateGates(fx, run);
    }
  }
  const summaries = stored.candidates.map((c) => summarizeCandidate(fx, c));
  const verdict = computeVerdict(fx, summaries);
  console.log(`Recompute (policy v${HARNESS_VERSION}) from ${recomputePath} — original run ${stored.when}`);
  console.log("model".padEnd(24) + "| pass | rubric mean(min) | eligible");
  for (const s of summaries) {
    const eligible = s.benchmarkOnly ? "benchmark" : isEligible(fx, s) ? "yes" : "no";
    const rubric = s.rubricMean == null ? "-" : `${s.rubricMean.toFixed(2)}(${s.rubricMin?.toFixed(2) ?? "-"})`;
    console.log(s.model.padEnd(24) + `| ${pct(s.passRate).padStart(4)} | ${rubric.padStart(16)} | ${eligible}`);
  }
  console.log(`\nVERDICT: ${verdict.recommendation ?? "NO ELIGIBLE MODEL"}\n  ${verdict.reason}`);
  const recomputedPath = persistFullResults({ fixture: fx, candidates: stored.candidates, summaries, verdict, resultsRoot: arg("results-dir") ?? defaultResultsRoot() });
  console.log(`Recomputed results: ${recomputedPath}`);
  if (!has("no-verdict")) {
    const verdictPath = persistVerdictSummary({ fixture: fx, summaries, verdict, repoRoot: ROOT });
    console.log(`Verdict summary updated: ${verdictPath}`);
  }
  process.exit(0);
}

// ---- Rejudge mode: re-run the judge over stored runs (judge-prompt iterations
// shouldn't require re-running models), then recompute the verdict. ------------
const rejudgePath = arg("rejudge");
if (rejudgePath) {
  const stored = JSON.parse(readFileSync(resolve(process.cwd(), rejudgePath), "utf8"));
  const fx = normalizeFixture(stored.fixture, { sourcePath: stored.fixture.sourcePath });
  const judgeModelsOverride = csv(arg("judges")).length > 0 ? csv(arg("judges")) : arg("judge-model") ? [arg("judge-model")] : fx.judge.models;
  const rejudgeApiKey = readEnvKey("OLLAMA_API_KEY");
  // --fill-missing: only call judges whose score is absent for a run (e.g. the
  // open-model judge was rate-limited), then recombine with the stored scores.
  const fillMissing = has("fill-missing");
  for (const candidate of stored.candidates) {
    for (const run of candidate.runs) {
      if (run.gates?.infra || !run.text) continue;
      if (fillMissing) {
        const have = run.judge?.byJudge ?? {};
        const missing = judgeModelsOverride.filter((m) => typeof have[m] !== "number");
        if (missing.length === 0) continue;
        const add = await judgePanel({ fixture: fx, run, judgeModels: missing, apiKey: rejudgeApiKey });
        const byJudge = { ...have, ...(add.byJudge ?? {}) };
        const scored = Object.values(byJudge).filter((v) => typeof v === "number");
        if (scored.length > 0) {
          run.rubricScore = scored.reduce((a, b) => a + b, 0) / scored.length;
          run.judge = { ...(run.judge ?? {}), byJudge, judgeIncomplete: scored.length < judgeModelsOverride.length, ...(add.judgeErrors ? { judgeErrors: add.judgeErrors } : {}) };
        }
        continue;
      }
      const result = await judgePanel({ fixture: fx, run, judgeModels: judgeModelsOverride, apiKey: rejudgeApiKey });
      run.rubricScore = result.error ? null : result.weighted;
      run.judge = result;
    }
    const scores = candidate.runs.map((r) => r.rubricScore).filter((s) => typeof s === "number");
    console.log(`  ${candidate.model.padEnd(24)} rubric: ${scores.map((s) => s.toFixed(2)).join(", ") || "-"}`);
  }
  const summaries = stored.candidates.map((c) => summarizeCandidate(fx, c));
  const verdict = computeVerdict(fx, summaries);
  console.log(`\nVERDICT: ${verdict.recommendation ?? "NO ELIGIBLE MODEL"}\n  ${verdict.reason}`);
  const rejudgedPath = persistFullResults({ fixture: fx, candidates: stored.candidates, summaries, verdict, resultsRoot: arg("results-dir") ?? defaultResultsRoot() });
  console.log(`Rejudged results: ${rejudgedPath}`);
  if (!has("no-verdict")) console.log(`Verdict summary updated: ${persistVerdictSummary({ fixture: fx, summaries, verdict, repoRoot: ROOT })}`);
  process.exit(0);
}

// ---- Build the fixture -------------------------------------------------------
const taskFile = arg("task");
let fixture;
if (taskFile) {
  fixture = loadFixture(taskFile);
} else if (arg("prompt")) {
  fixture = adHocFixture({
    prompt: arg("prompt"),
    system: arg("system", "You are a helpful assistant. Use tools when useful."),
    worker: arg("worker", "watson-ollama"),
    tools: !has("no-tools"),
  });
} else {
  console.error("Provide --task <fixture.json> or --prompt \"...\"");
  process.exit(2);
}
if (has("no-tools")) fixture.tools = false;
if (arg("runs")) fixture.runs = Math.max(1, Number(arg("runs")) || fixture.runs);

const candidateModels = csv(arg("models")).length > 0
  ? csv(arg("models"))
  : fixture.candidateModels.length > 0 ? fixture.candidateModels : DEFAULT_MODELS;
const benchmarkModels = arg("benchmarks") === "none"
  ? []
  : csv(arg("benchmarks")).length > 0 ? csv(arg("benchmarks")) : fixture.benchmarkModels;
const seen = new Set();
let allModels = [
  ...candidateModels.map((model) => ({ model, benchmarkOnly: false })),
  ...benchmarkModels.map((model) => ({ model: isClaudeModel(model) ? model : `claude:${model}`, benchmarkOnly: true })),
].filter(({ model }) => (seen.has(model) ? false : (seen.add(model), true)));

// --provider claude|ollama: run only that provider's candidates (split passes
// when one provider is rate-limited; results merge per model downstream).
if (arg("provider") === "claude") allModels = allModels.filter(({ model }) => isClaudeModel(model));
if (arg("provider") === "ollama") allModels = allModels.filter(({ model }) => !isClaudeModel(model));
// --exclude a,b: drop candidates already ruled out (saves shared provider quota).
if (csv(arg("exclude")).length > 0) allModels = allModels.filter(({ model }) => !csv(arg("exclude")).includes(model));

let fixtureImages = [];
if (fixture.images.length > 0) {
  try {
    fixtureImages = loadFixtureImages(fixture, ROOT);
  } catch (e) {
    console.error(`INFRA: cannot load fixture images (${String(e?.message || e)})`);
    process.exit(3);
  }
  const excluded = allModels.filter(({ model }) => isClaudeModel(model));
  if (excluded.length > 0) {
    console.log(`NOTE: vision fixture — excluding claude:* candidates (print-mode runner has no image input): ${excluded.map((m) => m.model).join(", ")}`);
    allModels = allModels.filter(({ model }) => !isClaudeModel(model));
  }
}

const judgeEnabled = fixture.judge.enabled && !has("no-judge");
const judgeModels = csv(arg("judges")).length > 0 ? csv(arg("judges")) : arg("judge-model") ? [arg("judge-model")] : fixture.judge.models;
fixture.judge.models = judgeModels;
const judgeModel = judgeModels.join("+");
const concurrency = Math.max(1, Number(arg("concurrency", "1")) || 1);
const full = has("full");

// ---- Preflight: fail loudly on INFRA problems before blaming any model --------
function readEnvKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    return (readFileSync(resolve(ROOT, ".env"), "utf8").match(new RegExp(`^${name}=(.*)$`, "m")) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}

const needsOllama = allModels.some(({ model }) => !isClaudeModel(model)) || (judgeEnabled && judgeModels.some((m) => !isClaudeJudgeModel(m)));
const needsClaude = (judgeEnabled && judgeModels.some((m) => isClaudeJudgeModel(m))) || allModels.some(({ model }) => isClaudeModel(model));

const apiKey = readEnvKey("OLLAMA_API_KEY");
if (needsOllama && !apiKey) {
  console.error("INFRA: OLLAMA_API_KEY not found in env or .env");
  process.exit(3);
}
if (needsClaude) {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error("INFRA: `claude` CLI not available (needed for the judge and claude candidates/benchmarks)");
    process.exit(3);
  }
}

// Long-horizon fixtures can raise the Ollama tool-loop cap; the provider reads
// this env at import time, so set it before the dynamic import below.
if (Number.isInteger(fixture.maxTurns) && !process.env.TANGO_MAX_TOOL_ITERS) {
  process.env.TANGO_MAX_TOOL_ITERS = String(fixture.maxTurns);
}

// Production persona: prepend the agent's real assembled prompt; the fixture's
// own `system` becomes a scenario addendum (kept separately for the judge).
if (fixture.systemFromAgent) {
  try {
    const agentPrompt = await resolveAgentSystemPrompt(fixture.systemFromAgent, ROOT);
    fixture.systemAddendum = fixture.system ?? "";
    fixture.system = fixture.systemAddendum ? `${agentPrompt}\n\n## Scenario context\n${fixture.systemAddendum}` : agentPrompt;
  } catch (e) {
    console.error(`INFRA: cannot resolve production prompt for '${fixture.systemFromAgent}' (${String(e?.message || e)})`);
    process.exit(3);
  }
}

// Production appends current-turn metadata (date, time, timezone) to every agent
// turn for BOTH adapters; without it "today"/"tomorrow" tasks are unanswerable
// and Claude vs Ollama would differ only by what the model guesses. `now` pins
// the clock for fixtures whose scenario names a specific date/time.
if (fixture.systemFromAgent || fixture.injectTurnMetadata) {
  const { buildCurrentTurnMetadataPrompt } = await import(resolve(ROOT, "packages/core/dist/current-turn-metadata.js"));
  const metadata = buildCurrentTurnMetadataPrompt({
    ...(fixture.now ? { timestamp: fixture.now, timestampSource: "fixture-pinned" } : {}),
    config: { timeZone: fixture.timeZone ?? "America/Los_Angeles" },
  });
  fixture.system = `${fixture.system}\n\n${metadata}`;
}

const { OllamaProvider } = await import(resolve(ROOT, "packages/core/dist/provider.js"));
const { McpHttpToolClient } = await import(resolve(ROOT, "packages/core/dist/mcp-http-tool-client.js"));

let toolClient;
if (fixture.tools) {
  toolClient = new McpHttpToolClient({ port: 9100, timeoutMs: 120_000 });
  try {
    const catalog = await toolClient.listOpenAITools(fixture.worker);
    const names = new Set(catalog.map((t) => t?.function?.name).filter(Boolean));
    const missing = (fixture.toolContract ?? [])
      .flatMap((c) => (Array.isArray(c.oneOfTools) ? c.oneOfTools.map((alt) => alt.name) : [c.name]))
      .filter((n) => !names.has(n));
    if (missing.length > 0) {
      console.error(`INFRA: worker '${fixture.worker}' cannot see required tool(s) [${missing.join(", ")}] on :9100 — fix governance permissions before baking off models (otherwise every model 'fails').`);
      process.exit(3);
    }
    console.log(`Tool catalog for worker '${fixture.worker}': ${names.size} tools (contract tools all visible)`);
  } catch (e) {
    console.error(`INFRA: cannot reach :9100 MCP server (${String(e?.message || e).slice(0, 200)})`);
    process.exit(3);
  }
}

const pricing = loadPricing(join(ROOT, "agents", "evals", "model-bakeoff", "pricing.json"));
const makeProvider = (model) =>
  new OllamaProvider({ baseUrl: "https://ollama.com/v1", defaultModel: model, apiKey, timeoutMs: fixture.timeoutMs, toolClient });

// ---- Run candidates × runs (sequential for comparable timings) ----------------
console.log(`\nBake-off v${HARNESS_VERSION}: ${fixture.id} — ${fixture.title}`);
console.log(`worker=${fixture.worker} tools=${fixture.tools} runs/candidate=${fixture.runs} passRate>=${fixture.passRateThreshold} rubric>=${fixture.rubricThreshold} judge=${judgeEnabled ? judgeModel : "off"}`);
console.log(`candidates: ${allModels.map((m) => m.model + (m.benchmarkOnly ? "*" : "")).join(", ")}${allModels.some((m) => m.benchmarkOnly) ? "  (*benchmark only)" : ""}\n`);
console.log("model".padEnd(24) + "| run | stop         | calls | secs | gates");

async function runOnce(model) {
  if (isClaudeModel(model)) {
    return runClaudeOnce({ model, fixture });
  }
  return runOllamaOnce({ model, fixture, makeProvider, images: fixtureImages });
}

async function runCandidate({ model, benchmarkOnly }) {
  const runs = [];
  for (let i = 1; i <= fixture.runs; i += 1) {
    let result = await runOnce(model);
    if (result.infraError) {
      await new Promise((r) => setTimeout(r, 3000));
      result = await runOnce(model); // one retry: infra flakes shouldn't burn a run
    }
    result.costUsd = runCostUsd(result.usage, pricing.models[model.replace(/^claude:/, "")]);
    result.gates = evaluateGates(fixture, result);
    runs.push(result);
    const gateLabel = result.gates.infra
      ? `INFRA: ${String(result.infraError).slice(0, 60)}`
      : result.gates.pass ? "pass" : result.gates.failures.map((f) => f.gate).join(",").slice(0, 60);
    console.log(
      model.padEnd(24) + `| ${String(i).padStart(3)} | ${String(result.stopReason).padEnd(12)} | ${String(result.toolCalls.length).padStart(5)} | ${String(Math.round(result.seconds)).padStart(4)} | ${gateLabel}`,
    );
  }
  return { model, benchmarkOnly, runs };
}

// Candidates may run in parallel (--concurrency): every candidate is a remote
// service, so local contention barely moves wall-clock; each candidate's own
// runs stay sequential so its per-run latency is not self-inflicted.
const candidates = new Array(allModels.length);
let nextCandidate = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, allModels.length) }, async () => {
    while (nextCandidate < allModels.length) {
      const index = nextCandidate++;
      candidates[index] = await runCandidate(allModels[index]);
    }
  }),
);

// ---- Judge (blind, after all runs so candidate timing stays clean) -------------
if (judgeEnabled) {
  console.log(`\nJudging ${candidates.reduce((n, c) => n + c.runs.filter((r) => !r.gates.infra && r.text).length, 0)} runs with ${judgeModel} (blind)…`);
  // Judge calls are independent — run a small pool (--judge-concurrency, default
  // 4) so a 30-run fixture doesn't spend half an hour in serial judge calls.
  const judgeJobs = candidates.flatMap((candidate) => candidate.runs.filter((run) => !run.gates.infra && run.text));
  const judgeConcurrency = Math.max(1, Number(arg("judge-concurrency", "4")) || 4);
  let nextJob = 0;
  await Promise.all(
    Array.from({ length: Math.min(judgeConcurrency, judgeJobs.length) }, async () => {
      while (nextJob < judgeJobs.length) {
        const run = judgeJobs[nextJob++];
        const verdict = await judgePanel({ fixture, run, judgeModels, apiKey });
        if (verdict.error) {
          run.rubricScore = null;
          run.judge = { error: verdict.error, byJudge: verdict.byJudge };
        } else {
          run.rubricScore = verdict.weighted;
          run.judge = verdict;
        }
      }
    }),
  );
  for (const candidate of candidates) {
    const scores = candidate.runs.map((r) => r.rubricScore).filter((s) => typeof s === "number");
    console.log(`  ${candidate.model.padEnd(24)} rubric: ${scores.map((s) => s.toFixed(2)).join(", ") || "-"}`);
  }
}

// ---- Verdict -------------------------------------------------------------------
const summaries = candidates.map((c) => summarizeCandidate(fixture, c));
const verdict = computeVerdict(fixture, summaries);

console.log(`\n=== SUMMARY (${fixture.runs} runs/candidate) ===`);
console.log("model".padEnd(24) + "| pass | rubric mean(min) | secs | out-tok | cost/success | eligible");
for (const s of summaries) {
  const eligible = s.benchmarkOnly ? "benchmark" : isEligible(fixture, s) ? "yes" : "no";
  const rubric = s.rubricMean == null ? "-" : `${s.rubricMean.toFixed(2)}(${s.rubricMin?.toFixed(2) ?? "-"})`;
  console.log(
    s.model.padEnd(24) +
    `| ${pct(s.passRate).padStart(4)} | ${rubric.padStart(16)} | ${String(s.meanSeconds == null ? "-" : Math.round(s.meanSeconds)).padStart(4)} | ${String(s.meanOutputTokens == null ? "-" : Math.round(s.meanOutputTokens)).padStart(7)} | ${costLabel(s).padEnd(12)} | ${eligible}`,
  );
  if (s.infraRuns > 0) console.log(`  ⚠ ${s.model}: ${s.infraRuns} run(s) excluded as infra failures`);
}

console.log(`\nVERDICT: ${verdict.recommendation ?? "NO ELIGIBLE MODEL"}`);
console.log(`  ${verdict.reason}`);
if (verdict.incumbent) console.log(`  incumbent: ${verdict.incumbent}`);

if (full) {
  console.log("\n=== FULL OUTPUTS ===");
  for (const c of candidates) {
    for (const [i, r] of c.runs.entries()) {
      console.log(`\n---------- ${c.model} run ${i + 1} [stop=${r.stopReason} gates=${r.gates.pass ? "pass" : "FAIL"} rubric=${r.rubricScore?.toFixed(2) ?? "-"}] ----------`);
      console.log((r.text || "").replace(/\n{3,}/g, "\n\n"));
      if (r.judge?.rationale) console.log(`\n[judge] ${r.judge.rationale}`);
    }
  }
}

// ---- Persist --------------------------------------------------------------------
const resultsPath = persistFullResults({ fixture, candidates, summaries, verdict, resultsRoot: arg("results-dir") ?? defaultResultsRoot() });
console.log(`\nFull results (private): ${resultsPath}`);
// --no-verdict: screening passes (1 run, wide roster) must not overwrite the
// committed verdict that a full reliability run produced.
if (taskFile && !has("no-verdict") && existsSync(join(ROOT, "agents", "evals", "model-bakeoff"))) {
  const verdictPath = persistVerdictSummary({ fixture, summaries, verdict, repoRoot: ROOT });
  console.log(`Verdict summary (committed-safe): ${verdictPath}`);
}

process.exit(verdict.infraIncomplete ? 3 : 0);
