import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAgentConfigs,
  loadIntentContractConfigs,
  loadProjectConfigs,
  loadScheduleConfigs,
  loadSessionConfigs,
  loadToolContractConfigs,
  loadWorkflowConfigs,
  loadWorkerConfigs,
  resolveConfigDir,
} from "../src/config.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

afterEach(() => {
  process.chdir(originalCwd);

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-config-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents", "shared"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents", "tools"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents", "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents", "workers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agent-prompts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "worker-prompts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tool-contracts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "intent-contracts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(dir, "schedules"), { recursive: true });
  return dir;
}

function isolateProfileHome(): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-home-"));
  tempDirs.push(homeDir);
  process.env.TANGO_HOME = homeDir;
  process.env.TANGO_PROFILE = "default";
}

describe("resolveConfigDir", () => {
  it("prefers repo defaults when config/defaults is present", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-config-defaults-"));
    tempDirs.push(repoDir);
    fs.mkdirSync(path.join(repoDir, "config", "defaults"), { recursive: true });
    process.chdir(repoDir);

    expect(fs.realpathSync(resolveConfigDir())).toBe(
      fs.realpathSync(path.join(repoDir, "config", "defaults")),
    );
  });

  it("keeps using the legacy repo-local config when it already exists", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-config-repo-"));
    tempDirs.push(repoDir);
    fs.mkdirSync(path.join(repoDir, "config"), { recursive: true });
    process.chdir(repoDir);

    expect(fs.realpathSync(resolveConfigDir())).toBe(
      fs.realpathSync(path.join(repoDir, "config")),
    );
  });

  it("falls back to the profile config directory for a clean install", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-config-clean-"));
    tempDirs.push(repoDir);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-home-"));
    tempDirs.push(homeDir);
    process.chdir(repoDir);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    expect(resolveConfigDir()).toBe(
      path.join(homeDir, "profiles", "default", "config"),
    );
  });

  it("normalizes an explicit legacy config root to repo defaults when only config/defaults exists", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-config-explicit-defaults-"));
    tempDirs.push(repoDir);
    fs.mkdirSync(path.join(repoDir, "config", "defaults", "sessions"), { recursive: true });
    process.chdir(repoDir);
    process.env.TANGO_CONFIG_DIR = "./config";

    expect(fs.realpathSync(resolveConfigDir())).toBe(
      fs.realpathSync(path.join(repoDir, "config", "defaults")),
    );
  });

  it("finds repo defaults from a nested workspace directory", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-config-nested-"));
    tempDirs.push(repoDir);
    const nestedDir = path.join(repoDir, "packages", "voice");
    fs.mkdirSync(path.join(repoDir, "config", "defaults"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });
    process.chdir(nestedDir);

    expect(fs.realpathSync(resolveConfigDir())).toBe(
      fs.realpathSync(path.join(repoDir, "config", "defaults")),
    );
  });
});

describe("loadSessionConfigs", () => {
  it("parses memory configuration blocks", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "sessions", "default.yaml"),
      [
        "id: tango-default",
        "type: persistent",
        "agent: dispatch",
        "channels:",
        "  - discord:default",
        "memory:",
        "  max_context_tokens: 16000",
        "  zones:",
        "    pinned: 0.1",
        "    summary: 0.15",
        "    memories: 0.2",
        "    recent: 0.55",
        "  summarize_window: 8",
        "  memory_limit: 30",
        "  importance_threshold: 0.3",
        "  retrieval_weights:",
        "    recency: 1",
        "    importance: 0.5",
        "    relevance: 2",
        "    source: 0.5"
      ].join("\n")
    );

    const sessions = loadSessionConfigs(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "tango-default",
      memory: {
        maxContextTokens: 16000,
        summarizeWindow: 8,
        memoryLimit: 30,
        importanceThreshold: 0.3,
        zones: {
          pinned: 0.1,
          summary: 0.15,
          memories: 0.2,
          recent: 0.55,
        },
        retrievalWeights: {
          recency: 1,
          importance: 0.5,
          relevance: 2,
          source: 0.5,
        },
      },
    });
  });

  it("loads Cod-E with stateless orchestrator continuity", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;

    const sessions = loadSessionConfigs(defaultsDir);
    const codE = sessions.find((session) => session.id === "cod-e");
    expect(codE).toMatchObject({
      id: "cod-e",
      type: "persistent",
      agent: "cod-e",
      orchestratorContinuity: "stateless",
      memory: {
        maxContextTokens: 12000,
      },
    });
  });
});

describe("loadAgentConfigs", () => {
  it("loads repo agent defaults for bundled assistant templates", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;

    expect(loadAgentConfigs(defaultsDir).map((agent) => agent.id).sort()).toEqual([
      "cod-e",
      "piper",
    ]);

    const operationsProject = loadProjectConfigs(defaultsDir).find((project) => project.id === "operations");
    expect(operationsProject).toMatchObject({
      defaultAgentId: "victor",
      workerIds: ["operations-assistant", "note-librarian"],
      toolContractIds: ["linear", "obsidian"],
    });

    expect(loadWorkerConfigs(defaultsDir)).toEqual([]);
  });

  it("parses per-agent access policy fields", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
        "response_mode: concise",
        "access:",
        "  mode: both",
        "  allowlist_channel_ids:",
        "    - \"123\"",
        "    - \"456\"",
        "  allowlist_user_ids:",
        "    - \"abc\""
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe("watson");
    expect(agents[0]?.access).toEqual({
      mode: "both",
      allowlistChannelIds: ["123", "456"],
      allowlistUserIds: ["abc"]
    });
  });

  it("keeps legacy agent config without access block", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "dispatch.yaml"),
      [
        "id: dispatch",
        "type: router",
        "provider:",
        "  default: claude-oauth"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe("dispatch");
    expect(agents[0]?.access).toBeUndefined();
  });

  it("parses provider model and reasoning overrides on agents", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "victor.yaml"),
      [
        "id: victor",
        "type: operations",
        "provider:",
        "  default: claude-oauth",
        "  model: claude-opus-4-8",
        "  reasoning_effort: max",
        "  fallback:",
        "    - codex"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents[0]?.provider).toEqual({
      default: "claude-oauth",
      model: "claude-opus-4-8",
      reasoningEffort: "max",
      fallback: ["codex"],
    });
  });

  it("loads prompt from prompt_file", () => {
    const dir = createTempConfigDir();
    const promptPath = path.join(dir, "agent-prompts", "watson.md");
    fs.writeFileSync(promptPath, "You are Watson from soul file.");

    fs.writeFileSync(
      path.join(dir, "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
        "prompt_file: ../agent-prompts/watson.md"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.prompt).toBe("You are Watson from soul file.");
    expect(agents[0]?.promptFile).toBe(promptPath);
  });

  it("parses system voice call signs, default prompt agent, Kokoro voice, and default topic/project metadata", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "dispatch.yaml"),
      [
        "id: dispatch",
        "type: router",
        "display_name: Tango",
        "provider:",
        "  default: claude-oauth",
        "default_topic: system/default",
        "default_project: personal",
        "voice:",
        "  call_signs:",
        "    - Tango",
        "  default_prompt_agent: watson",
        "  kokoro_voice: bm_george"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "dispatch",
      displayName: "Tango",
      defaultTopic: "system/default",
      defaultProject: "personal",
      voice: {
        callSigns: ["Tango"],
        defaultPromptAgent: "watson",
        kokoroVoice: "bm_george"
      }
    });
  });

  it("rejects defining both prompt and prompt_file", () => {
    const dir = createTempConfigDir();
    const promptPath = path.join(dir, "agent-prompts", "watson.md");
    fs.writeFileSync(promptPath, "prompt");

    fs.writeFileSync(
      path.join(dir, "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
        "prompt: inline prompt",
        "prompt_file: ../agent-prompts/watson.md"
      ].join("\n")
    );

    expect(() => loadAgentConfigs(dir)).toThrow(/cannot define both 'prompt' and 'prompt_file'/u);
  });

  it("parses per-agent tools config", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
        "tools:",
        "  mode: allowlist",
        "  allowlist:",
        "    - Bash(curl:*)",
        "    - WebSearch"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.tools).toEqual({
      mode: "allowlist",
      allowlist: ["Bash(curl:*)", "WebSearch"]
    });
  });

  it("parses worker orchestration metadata", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "malibu.yaml"),
      [
        "id: malibu",
        "type: wellness",
        "provider:",
        "  default: claude-oauth",
        "orchestration:",
        "  worker_ids:",
        "    - health-analyst",
        "    - nutrition-logger",
        "  write_confirmation: on-ambiguity"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents[0]?.orchestration).toEqual({
      workerIds: ["health-analyst", "nutrition-logger"],
      writeConfirmation: "on-ambiguity"
    });
  });

  it("parses deterministic routing metadata", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "malibu.yaml"),
      [
        "id: malibu",
        "type: wellness",
        "provider:",
        "  default: claude-oauth",
        "deterministic_routing:",
        "  enabled: true",
        "  project_scope: wellness",
        "  additional_domains:",
        "    - notes",
        "  confidence_threshold: 0.82",
        "  provider:",
        "    default: claude-oauth",
        "    model: claude-sonnet-4-6",
        "    reasoning_effort: low",
        "    fallback:",
        "      - codex"
      ].join("\n")
    );

    const agents = loadAgentConfigs(dir);
    expect(agents[0]?.deterministicRouting).toEqual({
      enabled: true,
      projectScope: "wellness",
      additionalDomains: ["notes"],
      confidenceThreshold: 0.82,
      provider: {
        default: "claude-oauth",
        model: "claude-sonnet-4-6",
        reasoningEffort: "low",
        fallback: ["codex"],
      },
    });
  });

  it("rejects allowlist mode without tools.allowlist", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
        "tools:",
        "  mode: allowlist"
      ].join("\n")
    );

    expect(() => loadAgentConfigs(dir)).toThrow(/must define tools.allowlist/u);
  });
});

describe("loadIntentContractConfigs", () => {
  it("parses optional safe no-op evaluation hints on intent contracts", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "intent-contracts", "finance.transaction_categorization.yaml"),
      [
        "id: finance.transaction_categorization",
        "domain: finance",
        "description: Categorize transactions.",
        "mode: write",
        "route:",
        "  kind: worker",
        "  target_id: personal-assistant",
        "evaluation:",
        "  safe_noop_allowed: true",
      ].join("\n"),
    );

    const intents = loadIntentContractConfigs(dir);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.evaluation?.safeNoopAllowed).toBe(true);
  });

  it("keeps the sinking fund contract aware of the Kilo spending reserve", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;

    const intents = loadIntentContractConfigs(defaultsDir);
    const contract = intents.find((intent) => intent.id === "finance.sinking_fund_reconciliation");

    expect(contract?.evaluation?.successCriteria).toContain(
      "Keep owner spending reserves distinct from the Kilo spending reserve; do not merge separate accounts.",
    );
    expect(contract?.evaluation?.mustAnswer).toContain(
      "What is the current period spend, already reimbursed amount, and outstanding reimbursement for the Kilo spending reserve when Kilo spending is in scope?",
    );
    expect(contract?.evaluation?.requiredFields).toContain(
      "Kilo spending reserve current balance when in scope",
    );
  });
});

describe("loadScheduleConfigs", () => {
  it("loads opt-in state tracking for finance automations and review checkpoints", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const schedules = loadScheduleConfigs(defaultsDir);

    expect(schedules.find((schedule) => schedule.id === "receipt-cataloger")?.stateTracking).toEqual({
      enabled: true,
      domain: "finance",
      cadence: "daily",
      verification: "pre_check",
      reviewChecklist: undefined,
    });
    expect(schedules.find((schedule) => schedule.id === "nightly-transaction-categorizer")?.stateTracking)
      .toMatchObject({ enabled: true, domain: "finance", cadence: "daily", verification: "pre_check" });
    expect(schedules.find((schedule) => schedule.id === "weekly-finance-review")).toMatchObject({
      execution: { timeoutSeconds: 900 },
      stateTracking: {
        enabled: true,
        domain: "finance",
        cadence: "weekly",
        verification: "none",
        reviewChecklist: "finance",
      },
      completion: {
        workflowId: "weekly-finance-review",
        scope: "weekly",
        checkBeforeRun: false,
        markOnSuccess: false,
      },
    });
    expect(schedules.find((schedule) => schedule.id === "manual-test-weekly-finance-review")).toMatchObject({
      execution: { timeoutSeconds: 900 },
      stateTracking: { enabled: true, reviewChecklist: "finance" },
      completion: { checkBeforeRun: false, markOnSuccess: false },
    });
    for (const scheduleId of [
      "nightly-transaction-categorizer",
      "manual-test-nightly-transaction-categorizer",
    ]) {
      const task = schedules.find((schedule) => schedule.id === scheduleId)?.execution.taskTemplate ?? "";
      expect(task).toContain("{{categorizationRulesPath}}");
      expect(task).toContain("{{categorizationRules}}");
      expect(task).toContain("{{budgetNeutralTransferDetails}}");
      expect(task).toContain('category named exactly "Transfer"');
      expect(task).toContain("Do not surface these transactions for spend/income review");
      expect(task).not.toContain("$TANGO_OBSIDIAN_VAULT");
    }
    for (const scheduleId of ["receipt-cataloger", "manual-test-receipt-cataloger"]) {
      const task = schedules.find((schedule) => schedule.id === scheduleId)?.execution.taskTemplate ?? "";
      expect(task).toContain("{{categorizationRulesPath}}");
      expect(task).toContain("{{categorizationRules}}");
      expect(task).toMatch(/do\s+not attempt another path lookup or fall back to a default category/u);
    }
  });

  it("runs the state lifecycle sweep on every cron interval", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const sweep = loadScheduleConfigs(defaultsDir).find((schedule) => schedule.id === "state-sweep");

    expect(sweep).toMatchObject({
      enabled: true,
      schedule: { cron: "*/10 * * * *", timezone: "America/Los_Angeles" },
      execution: { mode: "deterministic", handler: "state-sweep" },
      completion: { workflowId: "state-sweep", scope: "daily", checkBeforeRun: false },
    });
  });

  it("keeps default schedule provider models canonical", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const schedules = loadScheduleConfigs(defaultsDir);
    const shortAliasModels = schedules
      .map((schedule) => ({
        id: schedule.id,
        model: schedule.provider?.model,
      }))
      .filter((entry) => entry.model === "sonnet" || entry.model === "haiku" || entry.model === "opus");

    expect(shortAliasModels).toEqual([]);
  });

  it("requires morning planning to apply email triage rules before surfacing email tasks", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const schedules = loadScheduleConfigs(defaultsDir);
    const morningPlanning = schedules.find((schedule) => schedule.id === "morning-planning");
    const manualTest = schedules.find((schedule) => schedule.id === "manual-test-morning-planning");

    for (const schedule of [morningPlanning, manualTest]) {
      expect(schedule, "schedule exists").toBeDefined();
      const task = schedule?.execution.task ?? "";
      expect(task).toContain("References/Email Triage Rules.md");
      expect(task).toContain("filter every email-sourced item");
      expect(task).toContain("Today's Priorities");
      expect(task).toContain("Other Work");
      expect(task).toContain("alerts@example.com");
    }

    expect(manualTest?.enabled).toBe(false);
    expect(manualTest?.delivery?.channelId).toBe("100000000000001001");
    expect(manualTest?.completion?.checkBeforeRun).toBe(false);
    expect(manualTest?.completion?.markOnSuccess).toBe(false);
  });

  it("keeps daily email review manual-test triage rules aligned with production", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const schedules = loadScheduleConfigs(defaultsDir);
    const production = schedules.find((schedule) => schedule.id === "daily-email-review");
    const manualTest = schedules.find((schedule) => schedule.id === "manual-test-daily-email-review");

    for (const schedule of [production, manualTest]) {
      expect(schedule, "schedule exists").toBeDefined();
      const task = schedule?.execution.task ?? "";
      expect(task).toContain("References/Email Triage Rules.md");
      expect(task).toContain("Apply the");
      expect(task).toContain("triage rules");
      expect(task).toContain("Ignore");
      expect(task).toContain("Delegate");
    }
  });

  it("loads the nightly email unsubscribe review as a daily Email input", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const schedules = loadScheduleConfigs(defaultsDir);
    const production = schedules.find((schedule) => schedule.id === "nightly-email-unsubscribe-review");
    const manualTest = schedules.find((schedule) => schedule.id === "manual-test-nightly-email-unsubscribe-review");
    const legacyWeekly = schedules.find((schedule) => schedule.id === "weekly-email-subscriptions");

    expect(production).toMatchObject({
      enabled: true,
      runtime: "v2",
      obsidianLog: {
        domain: "Email",
        jobName: "Email Unsubscribe Review",
      },
      schedule: {
        cron: "40 3 * * *",
        timezone: "America/Los_Angeles",
      },
      execution: {
        mode: "agent",
        workerId: "personal-assistant",
        intentIds: ["email.subscription_review"],
        deterministicAgentId: "watson",
        timeoutSeconds: 540,
      },
      delivery: {
        mode: "none",
      },
      completion: {
        workflowId: "nightly-email-unsubscribe-review",
        scope: "daily",
      },
    });

    const task = production?.execution.task ?? "";
    expect(task).toContain("agents/skills/email-subscription-cleanup.md");
    expect(task).toContain("discovery-only");
    expect(task).toContain("Do not click unsubscribe links");
    expect(task).toContain("**Flagged:**");

    expect(manualTest).toMatchObject({
      enabled: false,
      runtime: "v2",
      execution: {
        mode: "agent",
        intentIds: ["email.subscription_review"],
        deterministicAgentId: "watson",
      },
      completion: {
        workflowId: "manual-test-nightly-email-unsubscribe-review",
        scope: "daily",
        checkBeforeRun: false,
        markOnSuccess: false,
      },
    });
    expect(legacyWeekly).toMatchObject({
      enabled: false,
    });
    expect(legacyWeekly?.description).toContain("Superseded by");
  });

  it("loads the Kilo ledger monitor as a daily deterministic Finance input", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;
    const schedules = loadScheduleConfigs(defaultsDir);
    const monitor = schedules.find((schedule) => schedule.id === "kilo-ledger-monitor");

    expect(monitor).toMatchObject({
      enabled: true,
      obsidianLog: {
        domain: "Finance",
        jobName: "Kilo Ledger Monitor",
      },
      schedule: {
        cron: "45 4 * * *",
        timezone: "America/Los_Angeles",
      },
      execution: {
        mode: "deterministic",
        handler: "kilo-ledger-monitor",
      },
      delivery: {
        mode: "none",
      },
      completion: {
        workflowId: "kilo-ledger-monitor",
        scope: "daily",
      },
      policy: {
        concurrencyGroup: "ledger-tasks",
      },
    });
  });

  it("parses deterministic schedule intent routing fields", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "schedules", "daily-email-review.yaml"),
      [
        "id: daily-email-review",
        "description: Run inbox maintenance.",
        "enabled: true",
        "runtime: v2",
        "obsidian_log:",
        "  domain: Email",
        "  job_name: Daily Email Review",
        "schedule:",
        "  cron: \"0 16 * * *\"",
        "execution:",
        "  mode: agent",
        "  worker_id: personal-assistant",
        "  intent_ids:",
        "    - email.inbox_maintenance",
        "  deterministic_agent_id: watson",
        "  task: Review and maintain the inbox.",
      ].join("\n"),
    );

    const schedules = loadScheduleConfigs(dir);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      id: "daily-email-review",
      runtime: "v2",
      obsidianLog: {
        domain: "Email",
        jobName: "Daily Email Review",
      },
      execution: {
        mode: "agent",
        workerId: "personal-assistant",
        intentIds: ["email.inbox_maintenance"],
        deterministicAgentId: "watson",
        task: "Review and maintain the inbox.",
      },
    });
  });
});

describe("loadProjectConfigs", () => {
  it("parses project display metadata and provider defaults", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "projects", "tango.yaml"),
      [
        "id: tango",
        "display_name: Tango MVP",
        "aliases:",
        "  - tango mvp",
        "  - tango app",
        "default_agent: watson",
        "provider:",
        "  default: claude-harness",
        "  fallback:",
        "    - codex"
      ].join("\n")
    );

    const projects = loadProjectConfigs(dir);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: "tango",
      displayName: "Tango MVP",
      aliases: ["tango mvp", "tango app"],
      defaultAgentId: "watson",
      provider: {
        default: "claude-harness",
        fallback: ["codex"]
      }
    });
  });

  it("parses project worker and tool-contract references", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "projects", "wellness.yaml"),
      [
        "id: wellness",
        "display_name: Wellness",
        "default_agent: malibu",
        "worker_ids:",
        "  - health-analyst",
        "  - nutrition-logger",
        "tool_contract_ids:",
        "  - healthdb.today_summary",
        "  - fatsecret.log_food",
        "policies:",
        "  topic_mode: optional",
        "  write_confirmation: on-ambiguity"
      ].join("\n")
    );

    const projects = loadProjectConfigs(dir);
    expect(projects[0]).toMatchObject({
      id: "wellness",
      defaultAgentId: "malibu",
      workerIds: ["health-analyst", "nutrition-logger"],
      toolContractIds: ["healthdb.today_summary", "fatsecret.log_food"],
      policies: {
        topicMode: "optional",
        writeConfirmation: "on-ambiguity"
      }
    });
  });
});

describe("loadWorkerConfigs", () => {
  it("loads worker configs with prompt files and policies", () => {
    const dir = createTempConfigDir();
    const promptPath = path.join(dir, "worker-prompts", "health-analyst.md");
    fs.writeFileSync(promptPath, "You are the health analyst worker.");

    fs.writeFileSync(
      path.join(dir, "workers", "health-analyst.yaml"),
      [
        "id: health-analyst",
        "type: analyst",
        "display_name: Health Analyst",
        "owner_agent: malibu",
        "description: Read-only health summarizer",
        "provider:",
        "  default: claude-oauth",
        "prompt_file: ../worker-prompts/health-analyst.md",
        "tool_contract_ids:",
        "  - healthdb.today_summary",
        "policy:",
        "  write_scope: none",
        "  confirm_before_write: true"
      ].join("\n")
    );

    const workers = loadWorkerConfigs(dir);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      id: "health-analyst",
      type: "analyst",
      displayName: "Health Analyst",
      ownerAgentId: "malibu",
      description: "Read-only health summarizer",
      prompt: "You are the health analyst worker.",
      promptFile: promptPath,
      toolContractIds: ["healthdb.today_summary"],
      policy: {
        writeScope: "none",
        confirmBeforeWrite: true
      }
    });
  });

  it("parses provider reasoning overrides on workers", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "workers", "dev-assistant.yaml"),
      [
        "id: dev-assistant",
        "type: developer",
        "provider:",
        "  default: claude-oauth",
        "  reasoning_effort: max",
        "  fallback:",
        "    - codex"
      ].join("\n")
    );

    const workers = loadWorkerConfigs(dir);
    expect(workers[0]?.provider).toEqual({
      default: "claude-oauth",
      reasoningEffort: "max",
      fallback: ["codex"],
    });
  });

  it("assembles worker soul prompts from soul, shared files, and knowledge", () => {
    isolateProfileHome();
    const dir = createTempConfigDir();
    const workerPromptDir = path.join(dir, "agents", "workers", "recipe-librarian");
    fs.mkdirSync(workerPromptDir, { recursive: true });

    fs.writeFileSync(path.join(dir, "agents", "shared", "AGENTS.md"), "shared agents");
    fs.writeFileSync(path.join(dir, "agents", "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(dir, "agents", "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(workerPromptDir, "soul.md"), "recipe soul");
    fs.writeFileSync(path.join(workerPromptDir, "knowledge.md"), "recipe knowledge");
    fs.writeFileSync(path.join(dir, "agents", "tools", "recipe.md"), "recipe tool doc");
    fs.writeFileSync(path.join(dir, "agents", "skills", "recipe-management.md"), "recipe skill doc");

    fs.writeFileSync(
      path.join(dir, "workers", "recipe-librarian.yaml"),
      [
        "id: recipe-librarian",
        "type: librarian",
        "provider:",
        "  default: claude-oauth",
        "prompt_file: ../agents/workers/recipe-librarian/soul.md",
        "tool_contract_ids:",
        "  - wellnessdb_update_recipe",
        "skill_doc_ids:",
        "  - recipe_format"
      ].join("\n")
    );

    const workers = loadWorkerConfigs(dir);
    expect(workers[0]).toMatchObject({
      id: "recipe-librarian",
      toolContractIds: ["wellnessdb_update_recipe"],
      skillDocIds: ["recipe_format"],
      promptFile: path.join(workerPromptDir, "soul.md"),
    });
    expect(workers[0]?.prompt).toContain("recipe soul");
    expect(workers[0]?.prompt).not.toContain("shared agents");
    expect(workers[0]?.prompt).toContain("shared rules");
    expect(workers[0]?.prompt).toContain("shared user");
    expect(workers[0]?.prompt).toContain("recipe knowledge");
    expect(workers[0]?.prompt).not.toContain("recipe tool doc");
    expect(workers[0]?.prompt).not.toContain("recipe skill doc");
  });

  it("returns an empty list when no legacy worker configs are present", () => {
    const dir = createTempConfigDir();

    expect(loadWorkerConfigs(dir)).toEqual([]);
  });
});

describe("loadToolContractConfigs", () => {
  it("parses tool contract metadata and legacy command hints", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "tool-contracts", "fatsecret.log_food.yaml"),
      [
        "id: fatsecret.log_food",
        "family: fatsecret",
        "description: Log a food entry to the legacy FatSecret diary",
        "owner_worker: nutrition-logger",
        "mode: write",
        "status: scaffold",
        "confirmation_required: true",
        "live_execution:",
        "  enabled: false",
        "  write_enabled: false",
        "integration:",
        "  system: fatsecret",
        "  target: food-diary",
        "input_fields:",
        "  - food_id",
        "  - serving_id",
        "  - units",
        "  - meal",
        "output_fields:",
        "  - food_entry_id",
        "  - calories",
        "  - protein",
        "legacy:",
        "  commands:",
        "    - node ~/.tango/tools/nutrition-coach/scripts/nutrition-helper.js log <food_id> <serving_id> <units> <meal>",
        "  read_paths:",
        "    - ~/.tango/secrets/fatsecret-api.json",
        "  write_paths:",
        "    - FatSecret diary entry for the target day and meal"
      ].join("\n")
    );

    const contracts = loadToolContractConfigs(dir);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      id: "fatsecret.log_food",
      family: "fatsecret",
      ownerWorkerId: "nutrition-logger",
      mode: "write",
      status: "scaffold",
      confirmationRequired: true,
      liveExecution: {
        enabled: false,
        writeEnabled: false
      },
      integration: {
        system: "fatsecret",
        target: "food-diary"
      },
      inputFields: ["food_id", "serving_id", "units", "meal"],
      outputFields: ["food_entry_id", "calories", "protein"],
      legacy: {
        commands: [
          "node ~/.tango/tools/nutrition-coach/scripts/nutrition-helper.js log <food_id> <serving_id> <units> <meal>"
        ],
        readPaths: ["~/.tango/secrets/fatsecret-api.json"],
        writePaths: ["FatSecret diary entry for the target day and meal"]
      }
    });
  });
});

describe("loadWorkflowConfigs", () => {
  it("parses workflow metadata and planner hints", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "workflows", "wellness.log_recipe_meal.yaml"),
      [
        "id: wellness.log_recipe_meal",
        "display_name: Log Recipe Meal",
        "description: Log a named recipe note by resolving ingredients and posting them to FatSecret",
        "owner_worker: nutrition-logger",
        "mode: write",
        "status: implemented",
        "confirmation_required: false",
        "handler: log_recipe_meal",
        "tool_contract_ids:",
        "  - wellnessdb.recipes.lookup",
        "  - wellnessdb.ingredients.lookup",
        "  - fatsecret.log_food",
        "input_fields:",
        "  - recipe_query",
        "  - meal",
        "examples:",
        "  - Can you log my protein yogurt bowl for breakfast this morning?",
        "planning:",
        "  summary: Log a recurring recipe meal without asking the user to restate ingredients if the recipe note exists.",
        "  when_to_use:",
        "    - user asks to log a named recurring meal or recipe",
        "  ask_for_clarification_when:",
        "    - multiple recipe notes match"
      ].join("\n")
    );

    const workflows = loadWorkflowConfigs(dir);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      id: "wellness.log_recipe_meal",
      displayName: "Log Recipe Meal",
      description:
        "Log a named recipe note by resolving ingredients and posting them to FatSecret",
      ownerWorkerId: "nutrition-logger",
      mode: "write",
      status: "implemented",
      confirmationRequired: false,
      handler: "log_recipe_meal",
      toolContractIds: [
        "wellnessdb.recipes.lookup",
        "wellnessdb.ingredients.lookup",
        "fatsecret.log_food",
      ],
      inputFields: ["recipe_query", "meal"],
      examples: ["Can you log my protein yogurt bowl for breakfast this morning?"],
      planning: {
        summary:
          "Log a recurring recipe meal without asking the user to restate ingredients if the recipe note exists.",
        whenToUse: ["user asks to log a named recurring meal or recipe"],
        askForClarificationWhen: ["multiple recipe notes match"],
      },
    });
  });
});

describe("loadIntentContractConfigs", () => {
  it("parses intent contracts with route, slots, and classifier hints", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "intent-contracts", "nutrition.log_recipe.yaml"),
      [
        "id: nutrition.log_recipe",
        "domain: wellness",
        "display_name: Log Recipe Meal",
        "description: Log a named recurring meal or recipe.",
        "mode: write",
        "route:",
        "  kind: workflow",
        "  target_id: wellness.log_recipe_meal",
        "slots:",
        "  - name: recipe_query",
        "    required: true",
        "    inferable: false",
        "  - name: meal",
        "    required: false",
        "    inferable: true",
        "examples:",
        "  - Log my protein yogurt bowl for breakfast",
        "can_run_in_parallel: false",
        "classifier_hints:",
        "  - Use for named recurring meals or saved recipes",
      ].join("\n"),
    );

    const contracts = loadIntentContractConfigs(dir);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      id: "nutrition.log_recipe",
      domain: "wellness",
      displayName: "Log Recipe Meal",
      description: "Log a named recurring meal or recipe.",
      mode: "write",
      route: {
        kind: "workflow",
        targetId: "wellness.log_recipe_meal",
      },
      slots: [
        {
          name: "recipe_query",
          required: true,
          inferable: false,
        },
        {
          name: "meal",
          required: false,
          inferable: true,
        },
      ],
      examples: ["Log my protein yogurt bowl for breakfast"],
      canRunInParallel: false,
      classifierHints: ["Use for named recurring meals or saved recipes"],
    });
  });
});


describe("scheduled review configuration", () => {
  it("loads context dependencies and reasoning effort through the normal config loader", () => {
    isolateProfileHome();
    const dir = createTempConfigDir();
    fs.writeFileSync(path.join(dir, "schedules", "review.yaml"), `
id: review
description: Review pending items
enabled: false
runtime: v2
schedule:
  cron: "0 23 * * *"
execution:
  mode: agent
  worker_id: finance
  task: Review items
  context_dependencies: [receipts]
provider:
  model: claude-sonnet-4-6
  reasoning_effort: high
`);
    const schedule = loadScheduleConfigs(dir).find((item) => item.id === "review");
    expect(schedule?.execution.contextDependencies).toEqual(["receipts"]);
    expect(schedule?.provider?.reasoningEffort).toBe("high");
  });
});

describe("schedule catch-up configuration", () => {
  it.each(["none", "6h", "30m", "12s", "2d"])("loads catch_up: %s", (window) => {
    isolateProfileHome();
    const dir = createTempConfigDir();
    fs.writeFileSync(path.join(dir, "schedules", "catch-up.yaml"), `
id: catch-up
description: Catch-up fixture
enabled: true
catch_up: ${window}
schedule:
  every_seconds: 3600
execution:
  mode: deterministic
  handler: fixture
`);
    expect(loadScheduleConfigs(dir).find((config) => config.id === "catch-up")?.catchUp).toBe(window);
  });

  it.each(["0h", "-1h", "6hours", "1.5h", "false"])("rejects catch_up: %s", (window) => {
    isolateProfileHome();
    const dir = createTempConfigDir();
    fs.writeFileSync(path.join(dir, "schedules", "catch-up.yaml"), `
id: catch-up
description: Catch-up fixture
enabled: true
catch_up: ${window}
schedule:
  every_seconds: 3600
execution:
  mode: deterministic
  handler: fixture
`);
    expect(() => loadScheduleConfigs(dir)).toThrow();
  });
});
