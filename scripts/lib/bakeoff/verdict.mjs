// Verdict policy: reliability gate first, then cheapest, then fastest.
//
//   eligible  = passRate >= passRateThreshold AND rubricMean >= rubricThreshold
//               (and not a benchmark-only candidate, and enough non-infra runs)
//   ranking   = pass rate DESC first — reliability dominates even above the gate,
//               because a failed job costs trust and attention, not just retry
//               tokens. At equal pass rate: cost-per-SUCCESSFUL-run ascending
//               (meanCost / passRate), token fallback when prices are unknown,
//               latency tiebreak.
//   hysteresis = a challenger only displaces the incumbent by strictly beating its
//               pass rate, or tying it while being cheaper and no worse on rubric.
//               Encodes "failure is very expensive": we never churn assignments
//               for marginal wins.
//
// Pure logic — unit tested in verdict.test.mjs.

function mean(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summarizeCandidate(fixture, { model, benchmarkOnly = false, runs }) {
  const valid = runs.filter((r) => !r.gates?.infra);
  const passes = valid.filter((r) => r.gates?.pass);
  const passRate = valid.length === 0 ? 0 : passes.length / valid.length;
  const rubricValues = valid.map((r) => r.rubricScore).filter((v) => typeof v === "number" && Number.isFinite(v));
  const rubricMean = mean(rubricValues);
  const rubricMin = rubricValues.length > 0 ? Math.min(...rubricValues) : null;
  const rubricStdDev =
    rubricValues.length > 1
      ? Math.sqrt(rubricValues.reduce((s, v) => s + (v - rubricMean) ** 2, 0) / rubricValues.length)
      : null;
  // Per-judge means (judge panel): lets a verdict show whether the Claude and
  // open-model judges agree, and exposes self-preference if they don't.
  const judgeNames = [...new Set(valid.flatMap((r) => Object.keys(r.judge?.byJudge ?? {})))];
  const rubricByJudge = Object.fromEntries(judgeNames.map((j) => [j, mean(valid.map((r) => r.judge?.byJudge?.[j]))]));
  const judgeIncompleteRuns = valid.filter((r) => r.judge?.judgeIncomplete || (r.text && r.judge?.error)).length;
  const meanSeconds = mean(valid.map((r) => r.seconds));
  const meanOutputTokens = mean(valid.map((r) => r.usage?.outputTokens));
  const costs = valid.map((r) => r.costUsd);
  const meanCostUsd = costs.some((c) => typeof c !== "number") ? null : mean(costs);
  return {
    model,
    benchmarkOnly,
    attempted: runs.length,
    validRuns: valid.length,
    infraRuns: runs.length - valid.length,
    passes: passes.length,
    passRate,
    rubricMean,
    rubricMin,
    rubricStdDev,
    rubricByJudge,
    judgeIncompleteRuns,
    meanSeconds,
    meanOutputTokens,
    meanCostUsd,
    costPerSuccessUsd: meanCostUsd != null && passRate > 0 ? meanCostUsd / passRate : null,
    tokensPerSuccess: meanOutputTokens != null && passRate > 0 ? meanOutputTokens / passRate : null,
    gateFailures: valid.flatMap((r) => (r.gates?.failures ?? []).map((f) => `${f.gate}: ${f.detail}`)),
  };
}

// Displacing an incumbent on cost requires a MEANINGFUL saving (>10%) — a 1%
// token difference is run-to-run noise, and assignment churn has its own cost.
const MEANINGFUL_COST_MARGIN = 0.9;

function cheaper(a, b) {
  if (a.costPerSuccessUsd != null && b.costPerSuccessUsd != null) {
    return a.costPerSuccessUsd < b.costPerSuccessUsd * MEANINGFUL_COST_MARGIN;
  }
  if (a.tokensPerSuccess != null && b.tokensPerSuccess != null) {
    return a.tokensPerSuccess < b.tokensPerSuccess * MEANINGFUL_COST_MARGIN;
  }
  return false;
}

function rankComparator(a, b) {
  if (a.passRate !== b.passRate) return b.passRate - a.passRate;
  if (a.costPerSuccessUsd != null && b.costPerSuccessUsd != null && a.costPerSuccessUsd !== b.costPerSuccessUsd) {
    return a.costPerSuccessUsd - b.costPerSuccessUsd;
  }
  if (a.tokensPerSuccess != null && b.tokensPerSuccess != null && a.tokensPerSuccess !== b.tokensPerSuccess) {
    return a.tokensPerSuccess - b.tokensPerSuccess;
  }
  return (a.meanSeconds ?? Infinity) - (b.meanSeconds ?? Infinity);
}

export function isEligible(fixture, summary) {
  if (summary.benchmarkOnly) return false;
  if (summary.validRuns === 0) return false;
  if (summary.passRate < fixture.passRateThreshold) return false;
  if (summary.rubricMean != null && summary.rubricMean < fixture.rubricThreshold) return false;
  // Consistency gate: the WORST run must clear the floor. A model that swings
  // between brilliant and below-bar is not dependable enough to build a
  // workflow on, regardless of its average.
  if (summary.rubricMin != null && typeof fixture.rubricFloor === "number" && summary.rubricMin < fixture.rubricFloor) {
    return false;
  }
  return true;
}

export function computeVerdict(fixture, summaries) {
  const eligible = summaries.filter((s) => isEligible(fixture, s)).sort(rankComparator);
  const winner = eligible[0] ?? null;
  const incumbent = fixture.incumbentModel
    ? summaries.find((s) => s.model === fixture.incumbentModel) ?? null
    : null;

  let recommendation = winner?.model ?? null;
  let reason = winner
    ? `cheapest reliable candidate (passRate ${pct(winner.passRate)}, ${costLabel(winner)})`
    : "no candidate met the reliability bar";

  if (winner && incumbent && incumbent.model !== winner.model && isEligible(fixture, incumbent)) {
    const beats =
      winner.passRate > incumbent.passRate ||
      (winner.passRate === incumbent.passRate &&
        cheaper(winner, incumbent) &&
        (winner.rubricMean == null || incumbent.rubricMean == null || winner.rubricMean >= incumbent.rubricMean - 0.05));
    if (!beats) {
      recommendation = incumbent.model;
      reason = `incumbent retained (hysteresis): ${winner.model} did not strictly beat it on pass rate, or cost/rubric advantage was insufficient`;
    } else {
      reason = `${winner.model} beats incumbent ${incumbent.model} (passRate ${pct(winner.passRate)} vs ${pct(incumbent.passRate)}, ${costLabel(winner)} vs ${costLabel(incumbent)})`;
    }
  }

  const assignable = summaries.filter((s) => !s.benchmarkOnly);
  const infraIncomplete = assignable.length > 0 && assignable.every((s) => s.validRuns === 0);

  return {
    fixtureId: fixture.id,
    passRateThreshold: fixture.passRateThreshold,
    rubricThreshold: fixture.rubricThreshold,
    rubricFloor: fixture.rubricFloor ?? null,
    recommendation,
    reason,
    winner: winner?.model ?? null,
    incumbent: incumbent?.model ?? null,
    eligible: eligible.map((s) => s.model),
    infraIncomplete,
  };
}

export function pct(x) {
  return x == null ? "-" : `${Math.round(x * 100)}%`;
}

export function costLabel(summary) {
  if (summary.costPerSuccessUsd != null) return `$${summary.costPerSuccessUsd.toFixed(4)}/success`;
  if (summary.tokensPerSuccess != null) return `${Math.round(summary.tokensPerSuccess)} out-tok/success (price unknown)`;
  return "cost unknown";
}
