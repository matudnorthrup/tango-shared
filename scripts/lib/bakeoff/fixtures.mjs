// Fixture loading + normalization for the model bake-off harness (v2).
//
// A fixture is the eval contract for one Tango task. v2 splits scoring into:
//   - GATES: machine-checked, binary, per-run (toolContract, outputAssertions, forbiddenTools)
//   - RUBRIC: LLM-judged quality dimensions (weights sum to 1), scored 0..1
// Reliability is measured by repeating each candidate `runs` times and gating on
// pass-rate, with defaults keyed to safetyTier: failure on write-path tasks is
// more expensive, so the bar is higher.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const HARNESS_VERSION = "2.0.0";

export const SAFETY_TIERS = ["read_only_bounded", "read_only_judgment", "write_dry_run", "write_live"];

export const SAFETY_TIER_DEFAULTS = {
  read_only_bounded: { runs: 3, passRateThreshold: 0.8 },
  read_only_judgment: { runs: 3, passRateThreshold: 0.8 },
  write_dry_run: { runs: 5, passRateThreshold: 1.0 },
  write_live: { runs: 5, passRateThreshold: 1.0 },
};

export const DEFAULT_RUBRIC_THRESHOLD = 0.7;

/** Provider discriminator: routes a model to the Claude CLI runner instead of
 *  the Ollama provider. Matches the `claude:` prefix (CLI aliases like
 *  `claude:sonnet`) and bare runtime ids (`claude-opus-4-8`) so fixtures can
 *  name candidates exactly as agent configs do. Assignability is decided by
 *  list membership (candidateModels vs benchmarkModels), not by provider —
 *  headless Claude was confirmed unmetered 2026-07-17, retiring the old
 *  "subscription print mode is never assignable" rule. */
export function isClaudeModel(model) {
  return typeof model === "string" && (model.startsWith("claude:") || model.startsWith("claude-"));
}

/** Render prior conversation turns + the current message into one prompt so
 *  every candidate (Ollama or Claude CLI) and the judge see identical context.
 *  Production Claude turns carry history via --resume and Ollama turns via
 *  warm-start transcripts; a rendered transcript is the provider-neutral form. */
export function composePrompt(history, userMessage) {
  if (!Array.isArray(history) || history.length === 0) return userMessage;
  const lines = history.map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.content}`);
  return [
    "[Earlier in this conversation]",
    lines.join("\n\n"),
    "",
    "[Current message from the user]",
    userMessage,
  ].join("\n");
}

export function normalizeFixture(raw, { sourcePath } = {}) {
  const tierDefaults = SAFETY_TIER_DEFAULTS[raw.safetyTier] ?? SAFETY_TIER_DEFAULTS.read_only_bounded;

  // Legacy `requiredTools` (v1) lifts into the v2 toolContract form.
  const toolContract = Array.isArray(raw.toolContract)
    ? raw.toolContract
    : (raw.requiredTools ?? []).map((name) => ({ name: String(name).trim() }));

  const rubric = Array.isArray(raw.rubric) ? raw.rubric : [];

  const userMessage = typeof raw.userMessage === "string" ? raw.userMessage : raw.prompt;
  const judgeRaw = raw.judge && typeof raw.judge === "object" ? raw.judge : {};
  const judgeModels = Array.isArray(judgeRaw.models) && judgeRaw.models.length > 0
    ? judgeRaw.models
    : [judgeRaw.model ?? "sonnet"];

  return {
    ...raw,
    sourcePath: sourcePath ?? raw.sourcePath,
    userMessage,
    prompt: composePrompt(raw.history, userMessage),
    history: Array.isArray(raw.history) ? raw.history : [],
    // `systemFromAgent` resolves to the agent's PRODUCTION prompt (soul, rules,
    // knowledge, profile overlays) at run time — never committed. `system` is
    // then appended as fixture-specific context (e.g. "today is …").
    systemFromAgent: typeof raw.systemFromAgent === "string" ? raw.systemFromAgent : null,
    tools: raw.tools !== false,
    runs: Number.isInteger(raw.runs) && raw.runs > 0 ? raw.runs : tierDefaults.runs,
    passRateThreshold: typeof raw.passRateThreshold === "number" ? raw.passRateThreshold : tierDefaults.passRateThreshold,
    rubricThreshold: typeof raw.rubricThreshold === "number" ? raw.rubricThreshold : DEFAULT_RUBRIC_THRESHOLD,
    // Worst-run quality floor: dependability means bounded downside, not a good
    // average. A model whose quality swings below the floor on any run is not
    // eligible, even if its mean clears the threshold (the owner 2026-06-09).
    rubricFloor:
      typeof raw.rubricFloor === "number"
        ? raw.rubricFloor
        : Math.max(0, (typeof raw.rubricThreshold === "number" ? raw.rubricThreshold : DEFAULT_RUBRIC_THRESHOLD) - 0.1),
    toolContract,
    outputAssertions: Array.isArray(raw.outputAssertions) ? raw.outputAssertions : [],
    forbiddenTools: Array.isArray(raw.forbiddenTools) ? raw.forbiddenTools : [],
    forbiddenCalls: Array.isArray(raw.forbiddenCalls) ? raw.forbiddenCalls : [],
    images: Array.isArray(raw.images) ? raw.images : [],
    candidateModels: Array.isArray(raw.candidateModels) ? raw.candidateModels : [],
    benchmarkModels: Array.isArray(raw.benchmarkModels) ? raw.benchmarkModels : [],
    incumbentModel: typeof raw.incumbentModel === "string" ? raw.incumbentModel : null,
    rubric,
    judge: {
      enabled: rubric.length > 0,
      ...judgeRaw,
      model: judgeModels[0],
      models: judgeModels,
    },
    timeoutMs: Number.isInteger(raw.timeoutMs) ? raw.timeoutMs : 300_000,
  };
}

export function loadFixture(path) {
  const sourcePath = resolve(process.cwd(), path);
  const raw = JSON.parse(readFileSync(sourcePath, "utf8"));
  return normalizeFixture(raw, { sourcePath });
}

/** Quick-mode fixture for `--prompt` runs with no JSON file. */
export function adHocFixture({ prompt, system, worker, tools }) {
  return normalizeFixture({
    id: "adhoc",
    title: "Ad hoc bake-off",
    category: "adhoc",
    worker,
    taskShape: "unknown",
    safetyTier: "read_only_bounded",
    tools,
    candidateModels: [],
    system,
    prompt,
    successCriteria: [],
    knownFailureModes: [],
    rubric: [],
  });
}
