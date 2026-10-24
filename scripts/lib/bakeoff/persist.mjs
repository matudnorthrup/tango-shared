// Result persistence.
//
// Full per-run records (including transcripts and tool outputs) can contain
// personal data — they go to ~/.tango/evals/results/, NEVER the repo. The
// committed-safe verdict summary (stats only, no transcripts) goes to
// agents/evals/model-bakeoff/verdicts/<fixture-id>.json so model assignments
// stay reviewable and trendable in git.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HARNESS_VERSION } from "./fixtures.mjs";

const HISTORY_LIMIT = 20;

export function defaultResultsRoot() {
  return join(homedir(), ".tango", "evals", "results");
}

function safeId(id) {
  return String(id ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function persistFullResults({ fixture, candidates, summaries, verdict, resultsRoot }) {
  const dir = join(resultsRoot ?? defaultResultsRoot(), safeId(fixture.id));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.json`);
  writeFileSync(
    path,
    JSON.stringify({ harnessVersion: HARNESS_VERSION, when: new Date().toISOString(), fixture, candidates, summaries, verdict }, null, 2),
  );
  return path;
}

export function persistVerdictSummary({ fixture, summaries, verdict, repoRoot }) {
  const dir = join(repoRoot, "agents", "evals", "model-bakeoff", "verdicts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeId(fixture.id)}.json`);

  const entry = {
    when: new Date().toISOString(),
    harnessVersion: HARNESS_VERSION,
    fixtureSource: fixture.sourcePath?.includes("/agents/evals/") ? fixture.sourcePath.split("/agents/evals/")[1] : undefined,
    runsPerCandidate: fixture.runs,
    judges: fixture.judge?.models,
    verdict,
    candidates: summaries.map((s) => ({
      model: s.model,
      benchmarkOnly: s.benchmarkOnly,
      validRuns: s.validRuns,
      infraRuns: s.infraRuns,
      passRate: s.passRate,
      rubricMean: s.rubricMean,
      rubricMin: s.rubricMin,
      rubricStdDev: s.rubricStdDev,
      rubricByJudge: s.rubricByJudge,
      meanSeconds: s.meanSeconds,
      meanOutputTokens: s.meanOutputTokens,
      meanCostUsd: s.meanCostUsd,
      gateFailures: s.gateFailures.slice(0, 10),
    })),
  };

  let history = [];
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8"));
      history = Array.isArray(existing.history) ? existing.history : [];
      if (existing.latest) history.unshift(existing.latest);
    } catch {
      history = [];
    }
  }

  writeFileSync(path, JSON.stringify({ latest: entry, history: history.slice(0, HISTORY_LIMIT - 1) }, null, 2));
  return path;
}
