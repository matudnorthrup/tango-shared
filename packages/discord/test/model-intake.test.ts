import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { diffNewModels, INTAKE_SCREEN_FIXTURES, runModelIntake, summarizeScreen, type IntakeDeps, type ScreenRow } from "../src/model-intake.js";

const repoRoot = path.resolve(__dirname, "../../..");

function deps(overrides: Partial<IntakeDeps> = {}): IntakeDeps & { statePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-"));
  return {
    repoRoot,
    statePath: path.join(dir, "model-intake.json"),
    fetchOllamaCatalog: async () => ["deepseek-v4-pro:0813", "glm-5.3"],
    fetchAnthropicModels: async () => ["claude-opus-5-5", "claude-sonnet-5"],
    ollamaSessionUsage: async () => 0.1,
    runScreenFixture: vi.fn(async (fixture: string, models: string[]): Promise<ScreenRow> => ({
      fixture,
      incumbent: models[models.length - 1] ?? null,
      scores: models.map((model, i) => ({ model, passRate: 1, rubricMean: i === 0 ? 0.95 : 0.8, meanSeconds: 10 })),
    })),
    ...overrides,
  } as IntakeDeps & { statePath: string };
}

describe("model intake", () => {
  it("seeds silently on the first run", async () => {
    const d = deps();
    const result = await runModelIntake(d);
    expect(result.status).toBe("skipped");
    expect(JSON.parse(fs.readFileSync(d.statePath, "utf8")).seen).toContain("claude-opus-5-5");
    expect(d.runScreenFixture).not.toHaveBeenCalled();
  });

  it("stays silent when nothing is new", async () => {
    const d = deps();
    await runModelIntake(d);
    const result = await runModelIntake(d);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.summary).toBeUndefined();
  });

  it("screens a new model against incumbents and recommends a full bake-off when it wins", async () => {
    const d = deps();
    await runModelIntake(d);
    d.fetchOllamaCatalog = async () => ["deepseek-v4-pro:0813", "glm-5.3", "glm-6"];
    const result = await runModelIntake(d);
    expect(result.status).toBe("ok");
    expect(d.runScreenFixture).toHaveBeenCalledTimes(INTAKE_SCREEN_FIXTURES.length);
    expect(result.summary).toMatch(/new models available: `glm-6`/);
    expect(result.summary).toMatch(/Worth a full bake-off:\*\* glm-6/);
    expect(JSON.parse(fs.readFileSync(d.statePath, "utf8")).seen).toContain("glm-6");
  });

  it("defers (and does not mark seen) when the shared Ollama session is busy", async () => {
    const d = deps();
    await runModelIntake(d);
    d.fetchAnthropicModels = async () => ["claude-opus-5-5", "claude-sonnet-5", "claude-opus-6"];
    d.ollamaSessionUsage = async () => 0.7;
    const result = await runModelIntake(d);
    expect(result.status).toBe("skipped");
    expect(JSON.parse(fs.readFileSync(d.statePath, "utf8")).seen).not.toContain("claude-opus-6");
  });

  it("ignores non-chat models and already-seen ids", () => {
    expect(diffNewModels(["a", "b", "text-embed-3", "c"], ["a"])).toEqual(["b", "c"]);
  });

  it("does not call a failing or slower-quality challenger a contender", () => {
    const rows: ScreenRow[] = [
      { fixture: "f1.json", incumbent: "inc", scores: [{ model: "new", passRate: 0, rubricMean: 0.99, meanSeconds: 1 }, { model: "inc", passRate: 1, rubricMean: 0.9, meanSeconds: 1 }] },
      { fixture: "f2.json", incumbent: "inc", scores: [{ model: "new", passRate: 1, rubricMean: 0.7, meanSeconds: 1 }, { model: "inc", passRate: 1, rubricMean: 0.9, meanSeconds: 1 }] },
    ];
    expect(summarizeScreen(rows, ["new"]).contenders).toEqual([]);
  });

  it("every screen fixture exists and names an incumbent", () => {
    for (const fixture of INTAKE_SCREEN_FIXTURES) {
      const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, fixture), "utf8"));
      expect(typeof raw.incumbentModel).toBe("string");
    }
  });
});

describe("fixture incumbents track production assignments", () => {
  // The intake screen (and bake-off hysteresis) compare against each fixture's
  // incumbentModel. A stale incumbent makes an old loser look like a contender
  // (seen live 2026-09-25), so every agent/job fixture must name what the repo
  // config actually runs — with roles resolved to their primary model.
  it("agent and scheduled-job fixtures name the configured model", async () => {
    const yaml = (await import("js-yaml")).default;
    const { parseModelRoles } = await import("@tango/core");
    const roles = parseModelRoles(fs.readFileSync(path.join(repoRoot, "config/model-roles.yaml"), "utf8"));
    const concrete = (m: string) => {
      const primary = m.startsWith("role:") ? roles.get(m.slice(5))?.models[0] ?? m : m;
      return primary.replace(/:cloud$/u, "");
    };
    const alias: Record<string, string> = { "personal-assistant": "watson", "research-assistant": "sierra" };
    const skip = new Set(["memory", "state", "finance.receipt"]);
    const mismatches: string[] = [];
    const dir = path.join(repoRoot, "agents/evals/model-bakeoff/tasks");
    for (const file of fs.readdirSync(dir)) {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if ([...skip].some((prefix) => fx.id.startsWith(prefix))) continue;
      let configured: string | undefined;
      if (fx.id.startsWith("job.")) {
        const sched = yaml.load(fs.readFileSync(path.join(repoRoot, "config/defaults/schedules", `${fx.id.slice(4)}.yaml`), "utf8")) as { provider?: { model?: string } };
        configured = sched.provider?.model;
      } else {
        const raw = String(fx.systemFromAgent ?? fx.worker).replace(/-ollama$/u, "");
        const agent = alias[raw] ?? raw;
        const cfg = yaml.load(fs.readFileSync(path.join(repoRoot, "config/v2/agents", `${agent}.yaml`), "utf8")) as { runtime?: { model?: string } };
        configured = cfg.runtime?.model;
      }
      if (!configured) continue;
      if (concrete(configured) !== concrete(String(fx.incumbentModel))) mismatches.push(`${fx.id}: fixture ${fx.incumbentModel} vs config ${configured}`);
    }
    expect(mismatches).toEqual([]);
  });
});
