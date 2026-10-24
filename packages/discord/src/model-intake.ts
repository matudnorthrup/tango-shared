/**
 * Model intake — the periodic "is there a better model yet?" check-in.
 *
 * Nightly (quiet hours): diff the live Ollama Cloud catalog and the Anthropic
 * model list against the models already seen. Most nights nothing is new and the
 * job stays silent. When something new appears, run a SCREEN: one run per
 * candidate on a small representative fixture set, new models vs each fixture's
 * production incumbent, judged by the usual panel. Then report whether any new
 * model beats an incumbent and hand over the exact full bake-off command.
 *
 * The screen is deliberately small, and it respects the Ollama session limit
 * that production shares (2026-09-24 incident): it stops and defers to the next
 * night when session usage is high. Models are marked seen only after a
 * complete screen. Assignments never change automatically — a screen is the
 * trigger for a real bake-off, not a verdict.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { DeterministicResult } from "@tango/core";

/** Representative screen: judgment conversation, bounded tools, extraction,
 *  route tooling, a light scheduled job, a quick answer. */
export const INTAKE_SCREEN_FIXTURES = [
  "agents/evals/model-bakeoff/tasks/piper-email-triage-decision.json",
  "agents/evals/model-bakeoff/tasks/state-reconciler.json",
  "agents/evals/model-bakeoff/tasks/memory-extraction-nothing-worth-saving.json",
  "agents/evals/model-bakeoff/tasks/research-sync-notion-obsidian.json",
  "agents/evals/model-bakeoff/tasks/job-memory-maintenance.json",
  "agents/evals/model-bakeoff/tasks/watson-slack-find-explainer.json",
];

const OLLAMA_SESSION_CEILING = 0.5;

export interface IntakeState {
  seen: string[];
  lastRunAt?: string;
  lastScreenAt?: string;
}

export interface ScreenRow {
  fixture: string;
  incumbent: string | null;
  scores: Array<{ model: string; passRate: number; rubricMean: number | null; meanSeconds: number | null }>;
}

/** Only chat-model ids are intake candidates. */
export function isIntakeCandidate(id: string): boolean {
  return !/embed|rerank|guard|moderation|whisper|tts/iu.test(id);
}

export function diffNewModels(catalogIds: string[], seen: Iterable<string>): string[] {
  const known = new Set(seen);
  return [...new Set(catalogIds)].filter((id) => isIntakeCandidate(id) && !known.has(id)).sort();
}

/** A new model "beats" an incumbent on a fixture when it passes every run and
 *  its rubric is at least the incumbent's (screens are 1 run: this is a
 *  trigger for a real bake-off, not a verdict). */
export function summarizeScreen(rows: ScreenRow[], newModels: string[]): { lines: string[]; contenders: string[] } {
  const wins = new Map<string, number>();
  const lines: string[] = [];
  for (const row of rows) {
    const inc = row.scores.find((s) => s.model === row.incumbent);
    const fmt = (s: ScreenRow["scores"][number]) =>
      `${s.model} ${s.passRate < 1 ? "FAIL" : (s.rubricMean ?? 0).toFixed(2)}${s.meanSeconds != null ? ` @${Math.round(s.meanSeconds)}s` : ""}`;
    const challengers = row.scores.filter((s) => newModels.includes(s.model));
    for (const s of challengers) {
      if (s.passRate >= 1 && s.rubricMean != null && (!inc || inc.rubricMean == null || s.rubricMean >= inc.rubricMean)) {
        wins.set(s.model, (wins.get(s.model) ?? 0) + 1);
      }
    }
    lines.push(`- \`${path.basename(row.fixture, ".json")}\` — incumbent ${inc ? fmt(inc) : row.incumbent ?? "?"}; ${challengers.map(fmt).join(", ") || "no challenger runs"}`);
  }
  const contenders = [...wins.entries()].filter(([, n]) => n >= Math.ceil(rows.length / 2)).map(([m]) => m);
  return { lines, contenders };
}

export function renderIntakeReport(input: {
  newModels: string[];
  rows: ScreenRow[];
  deferred: boolean;
}): string {
  const { lines, contenders } = summarizeScreen(input.rows, input.newModels);
  const out = [
    `**Model intake** — new models available: ${input.newModels.map((m) => `\`${m}\``).join(", ")}`,
    `Screen (1 run each vs production incumbents, judge panel):`,
    ...lines,
  ];
  if (input.deferred) {
    out.push("", "⏸️ Screen paused: Ollama session usage is high (it's shared with production). The rest runs tomorrow night.");
  }
  if (contenders.length > 0) {
    out.push(
      "",
      `🏁 **Worth a full bake-off:** ${contenders.join(", ")} matched or beat the incumbent on at least half the screens.`,
      "Run the full suite (throttled) before changing any assignment, e.g.:",
      `\`node scripts/model-bakeoff.mjs --task <fixture> --models ${contenders.join(",")},<incumbent> --judges sonnet,deepseek-v4-pro\``,
    );
  } else if (!input.deferred) {
    out.push("", "No new model beat the incumbents on this screen. No action needed.");
  }
  return out.join("\n");
}

export interface IntakeDeps {
  repoRoot: string;
  statePath: string;
  fetchOllamaCatalog: () => Promise<string[]>;
  fetchAnthropicModels: () => Promise<string[]>;
  ollamaSessionUsage: () => Promise<number>;
  /** Run one screen fixture; resolves to its per-model summary. */
  runScreenFixture: (fixture: string, models: string[]) => Promise<ScreenRow>;
  now?: () => Date;
}

function readState(statePath: string): IntakeState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as IntakeState;
  } catch {
    return null;
  }
}

function writeState(statePath: string, state: IntakeState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export async function runModelIntake(deps: IntakeDeps): Promise<DeterministicResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const [ollama, anthropic] = await Promise.all([
    deps.fetchOllamaCatalog().catch(() => [] as string[]),
    deps.fetchAnthropicModels().catch(() => [] as string[]),
  ]);
  if (ollama.length === 0 && anthropic.length === 0) {
    return { status: "error", summary: "Model intake: could not read either model catalog." };
  }
  const catalog = [...ollama, ...anthropic.filter((id) => id.startsWith("claude-"))];

  const state = readState(deps.statePath);
  if (!state) {
    // First run: today's catalogs are the baseline (the Sept 2026 fleet
    // bake-off covered them). Only models that appear AFTER this are screened.
    writeState(deps.statePath, { seen: [...new Set(catalog)].sort(), lastRunAt: now });
    return { status: "skipped", data: { seeded: catalog.length } };
  }

  const newModels = diffNewModels(catalog, state.seen);
  if (newModels.length === 0) {
    writeState(deps.statePath, { ...state, lastRunAt: now });
    return { status: "skipped", data: { newModels: 0 } };
  }

  const rows: ScreenRow[] = [];
  let deferred = false;
  const needsOllama = newModels.some((m) => !m.startsWith("claude-"));
  for (const fixture of INTAKE_SCREEN_FIXTURES) {
    // The judge panel uses Ollama too, so check before every fixture.
    if ((await deps.ollamaSessionUsage().catch(() => 1)) >= OLLAMA_SESSION_CEILING) {
      deferred = true;
      break;
    }
    const incumbent = readIncumbent(path.join(deps.repoRoot, fixture));
    rows.push(await deps.runScreenFixture(fixture, [...newModels, ...(incumbent ? [incumbent] : [])]));
  }

  if (!deferred) {
    writeState(deps.statePath, { seen: [...new Set([...state.seen, ...newModels])].sort(), lastRunAt: now, lastScreenAt: now });
  } else {
    writeState(deps.statePath, { ...state, lastRunAt: now });
  }
  if (rows.length === 0) {
    // Deferred before anything ran: stay quiet; tomorrow retries.
    return { status: "skipped", data: { newModels, deferred, needsOllama } };
  }
  return {
    status: "ok",
    summary: renderIntakeReport({ newModels, rows, deferred }),
    data: { newModels, deferred, screened: rows.length },
  };
}

function readIncumbent(fixturePath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { incumbentModel?: unknown };
    return typeof raw.incumbentModel === "string" ? raw.incumbentModel : null;
  } catch {
    return null;
  }
}

/** Production runner: shells out to the bake-off harness for one screen fixture. */
export function spawnScreenFixture(repoRoot: string, timeoutMs = 30 * 60 * 1000) {
  return (fixture: string, models: string[]): Promise<ScreenRow> =>
    new Promise((resolve) => {
      const incumbent = readIncumbent(path.join(repoRoot, fixture));
      const args = [
        "scripts/model-bakeoff.mjs", "--task", fixture, "--models", models.join(","),
        "--runs", "1", "--no-verdict", "--benchmarks", "none",
        "--judges", "sonnet,deepseek-v4-pro", "--concurrency", "2",
      ];
      const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", () => undefined);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("close", () => {
        clearTimeout(timer);
        const match = stdout.match(/Full results \(private\): (.+\.json)/u);
        let scores: ScreenRow["scores"] = [];
        if (match) {
          try {
            const results = JSON.parse(fs.readFileSync(match[1]!.trim(), "utf8")) as {
              summaries: Array<{ model: string; passRate: number; rubricMean: number | null; meanSeconds: number | null }>;
            };
            scores = results.summaries.map((s) => ({ model: s.model, passRate: s.passRate, rubricMean: s.rubricMean, meanSeconds: s.meanSeconds }));
          } catch {
            scores = [];
          }
        }
        resolve({ fixture, incumbent, scores });
      });
    });
}
