import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  AgentRegistry,
  createBuiltInProviderRegistry,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  TangoStorage,
  emptyToolTelemetry,
  extractToolTelemetry,
  loadAgentConfigs,
  loadUnifiedAgentConfigs,
  loadSessionConfigs,
  loadWorkerConfigs,
  resolveProviderCandidates,
  resolveProviderToolsForAgent,
  selectProviderByName,
  selectProviderForAgent,
  findRepoLayerPersonalPromptFindings,
  resolveConfigDir,
  resolveDatabasePath,
  resolveLegacyConfigPath,
  resolveLegacyDatabasePath,
  resolveTangoHome,
  resolveTangoProfileAgentPromptDir,
  resolveTangoProfileCacheDir,
  resolveTangoProfileConfigDir,
  resolveTangoProfileDataDir,
  resolveTangoProfileDir,
  resolveTangoProfileLogsDir,
  resolveTangoProfileName,
  resolveTangoProfilePromptsDir,
  resolveTangoProfileSkillPromptsDir,
  resolveTangoProfileToolPromptsDir,
  resolveTangoProfileWorkerPromptDir,
  traceAgentPrompt,
  traceConfigCategory,
  type ChatProvider,
  type DeadLetterStatus,
  type ModelRunRecord,
  type ProviderSessionRecord,
  type ResetSessionOptions,
  type SessionSummary
} from "@tango/core";

import { readManifest, syncToolkit } from "./toolkit.js";

const program = new Command();
program.name("tango").description("Tango command line").version("0.1.0");
program.command("toolkit").description("Manage personal MCP tool mounts")
  .command("sync")
  .option("--manifest <path>", "Toolkit YAML manifest")
  .option("--install-dir <path>", "Built Tango installation containing the proxy")
  .option("--dry-run", "Show changes without writing")
  .option("--adopt-existing", "Adopt only exactly matching existing entries")
  .action((options) => {
    const manifestPath = options.manifest ?? path.join(resolveTangoProfileConfigDir(), "toolkit.yaml");
    syncToolkit(readManifest(fs.readFileSync(manifestPath, "utf8")), {
      ...options,
      proxy: options.installDir ? path.resolve(options.installDir, "packages/core/dist/mcp-proxy.js") : undefined,
    });
  });
const validConfigCategories = new Set([
  "agents",
  "intent-contracts",
  "projects",
  "schedules",
  "sessions",
  "tool-contracts",
  "workflows",
  "workers",
]);

interface CliContext {
  configDir: string;
  dbPath: string;
  sessionConfigs: ReturnType<typeof loadSessionConfigs>;
  agentRegistry: AgentRegistry;
  storage: TangoStorage;
}

function withContext<T>(fn: (ctx: CliContext) => T): T {
  const configDir = resolveConfigDir();
  const dbPath = resolveDatabasePath();
  const sessionConfigs = loadSessionConfigs(configDir);
  const agentRegistry = new AgentRegistry(loadUnifiedAgentConfigs(configDir));
  const storage = new TangoStorage(dbPath);

  try {
    return fn({ configDir, dbPath, sessionConfigs, agentRegistry, storage });
  } finally {
    storage.close();
  }
}

async function withContextAsync<T>(fn: (ctx: CliContext) => Promise<T>): Promise<T> {
  const configDir = resolveConfigDir();
  const dbPath = resolveDatabasePath();
  const sessionConfigs = loadSessionConfigs(configDir);
  const agentRegistry = new AgentRegistry(loadUnifiedAgentConfigs(configDir));
  const storage = new TangoStorage(dbPath);

  try {
    return await fn({ configDir, dbPath, sessionConfigs, agentRegistry, storage });
  } finally {
    storage.close();
  }
}

function formatDate(value: string | null): string {
  return value ?? "-";
}

function printSessionSummary(summary: SessionSummary): void {
  console.log(
    [
      `${summary.sessionId} (${summary.sessionType})`,
      `agent=${summary.defaultAgentId}`,
      `messages=${summary.messageCount}`,
      `runs=${summary.modelRunCount}`,
      `providerSessions=${summary.providerSessionCount}`,
      `lastMessage=${formatDate(summary.lastMessageAt)}`
    ].join(" ")
  );
}

function parseRetryLimit(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function copyDirectory(input: {
  source: string;
  destination: string;
  force?: boolean;
}): void {
  fs.mkdirSync(path.dirname(input.destination), { recursive: true });
  fs.cpSync(input.source, input.destination, {
    recursive: true,
    force: input.force === true,
    errorOnExist: input.force !== true,
  });
}

function rewriteCopiedPromptFilePaths(input: {
  source: string;
  destination: string;
}): void {
  const categories = ["agents", "workers"];

  for (const category of categories) {
    const destinationDir = path.join(input.destination, category);
    if (!fs.existsSync(destinationDir)) {
      continue;
    }

    const files = fs
      .readdirSync(destinationDir)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));

    for (const file of files) {
      const destinationFile = path.join(destinationDir, file);
      const sourceFile = path.join(input.source, category, file);
      if (!fs.existsSync(sourceFile)) {
        continue;
      }

      const raw = fs.readFileSync(destinationFile, "utf8");
      const match = raw.match(/^(\s*prompt_file:\s*)(.+)\s*$/mu);
      if (!match) {
        continue;
      }

      const prefix = match[1] ?? "";
      const valueText = (match[2] ?? "").trim();
      const unquotedValue = valueText.replace(/^['"]|['"]$/g, "");
      if (!/^\.\.?(?:\/|\\)/.test(unquotedValue) || path.isAbsolute(unquotedValue)) {
        continue;
      }

      const rewrittenPath = path.resolve(path.dirname(sourceFile), unquotedValue);
      const updated = raw.replace(match[0], `${prefix}${JSON.stringify(rewrittenPath)}`);
      if (updated !== raw) {
        fs.writeFileSync(destinationFile, updated);
      }
    }
  }
}

function resolveRepoDefaultsDirForCli(): string | null {
  const legacyConfigDir = resolveLegacyConfigPath();
  const defaultsDir = path.join(legacyConfigDir, "defaults");
  return fs.existsSync(defaultsDir) ? defaultsDir : null;
}

function buildProfileOptions(profile?: string): { profile: string } | undefined {
  return profile?.trim() ? { profile: profile.trim() } : undefined;
}

function createProviders(): Map<string, ChatProvider> {
  const defaultModel = process.env.CLAUDE_MODEL?.trim();
  const resolvedDefaultModel = defaultModel && defaultModel.length > 0 ? defaultModel : "claude-sonnet-5";
  const claudeEffort = process.env.CLAUDE_EFFORT?.trim() || "medium";
  const claudeSecondaryEffort = process.env.CLAUDE_SECONDARY_EFFORT?.trim() || claudeEffort;
  const claudeHarnessEffort = process.env.CLAUDE_HARNESS_EFFORT?.trim() || claudeEffort;
  const providerTimeoutMs = parsePositiveInt(
    process.env.TANGO_PROVIDER_TIMEOUT_MS,
    DEFAULT_PROVIDER_TIMEOUT_MS
  );
  const claudeTimeoutMs = parsePositiveInt(process.env.CLAUDE_TIMEOUT_MS, providerTimeoutMs);
  const claudeSecondaryTimeoutMs = parsePositiveInt(process.env.CLAUDE_SECONDARY_TIMEOUT_MS, claudeTimeoutMs);
  const secondaryModel = process.env.CLAUDE_SECONDARY_MODEL?.trim();
  const harnessModel = process.env.CLAUDE_HARNESS_MODEL?.trim();
  const codexModel = process.env.CODEX_MODEL?.trim();
  const resolvedCodexModel = codexModel && codexModel.length > 0 ? codexModel : "gpt-6-astra";
  const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT?.trim() || "medium";
  const codexSandbox = process.env.CODEX_SANDBOX?.trim();
  const codexApprovalPolicy = process.env.CODEX_APPROVAL_POLICY?.trim();

  return createBuiltInProviderRegistry({
    claudeOauth: {
      command: process.env.CLAUDE_CLI_COMMAND?.trim() || "claude",
      defaultModel: resolvedDefaultModel,
      defaultReasoningEffort: claudeEffort as "low" | "medium" | "high" | "max" | "xhigh",
      timeoutMs: claudeTimeoutMs
    },
    ...(process.env.CLAUDE_SECONDARY_CLI_COMMAND?.trim()
      ? {
          claudeOauthSecondary: {
            command: process.env.CLAUDE_SECONDARY_CLI_COMMAND.trim(),
            defaultModel: secondaryModel && secondaryModel.length > 0 ? secondaryModel : resolvedDefaultModel,
            defaultReasoningEffort: claudeSecondaryEffort as "low" | "medium" | "high" | "max" | "xhigh",
            timeoutMs: claudeSecondaryTimeoutMs
          }
        }
      : {}),
    claudeHarness: {
      command:
        process.env.CLAUDE_HARNESS_COMMAND?.trim() ||
        process.env.CLAUDE_CLI_COMMAND?.trim() ||
        "claude",
      defaultModel: harnessModel && harnessModel.length > 0 ? harnessModel : resolvedDefaultModel,
      defaultReasoningEffort: claudeHarnessEffort as "low" | "medium" | "high" | "max" | "xhigh",
      timeoutMs: parsePositiveInt(process.env.CLAUDE_HARNESS_TIMEOUT_MS, claudeTimeoutMs)
    },
    codex: {
      command: process.env.CODEX_CLI_COMMAND?.trim() || "codex",
      defaultModel: resolvedCodexModel,
      defaultReasoningEffort: codexReasoningEffort as "low" | "medium" | "high" | "max" | "xhigh",
      timeoutMs: parsePositiveInt(process.env.CODEX_TIMEOUT_MS, providerTimeoutMs),
      sandbox:
        codexSandbox === "read-only" ||
        codexSandbox === "workspace-write" ||
        codexSandbox === "danger-full-access"
          ? codexSandbox
          : "read-only",
      approvalPolicy:
        codexApprovalPolicy === "untrusted" ||
        codexApprovalPolicy === "on-failure" ||
        codexApprovalPolicy === "on-request" ||
        codexApprovalPolicy === "never"
          ? codexApprovalPolicy
          : "never",
      skipGitRepoCheck: true
    }
  });
}

function normalizeDeadLetterStatus(value: string): DeadLetterStatus | "all" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "pending" || normalized === "resolved" || normalized === "all") {
    return normalized;
  }
  return null;
}

function metadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function printContinuityReport(input: {
  sessionId: string;
  agentId: string;
  conversationKey: string;
  configuredProviders: string[];
  effectiveProviders: string[];
  overrideProvider?: string;
  providerSessions: ProviderSessionRecord[];
  recentRuns: ModelRunRecord[];
  compactSummary?: string;
}): void {
  const providerSessionByName = new Map<string, ProviderSessionRecord>();
  for (const row of input.providerSessions) {
    if (!providerSessionByName.has(row.providerName)) {
      providerSessionByName.set(row.providerName, row);
    }
  }

  console.log("status=continuity");
  console.log(`session=${input.sessionId}`);
  console.log(`agent=${input.agentId}`);
  console.log(`conversation=${input.conversationKey}`);
  console.log(`override=${input.overrideProvider ?? "-"}`);
  console.log(`configured=${input.configuredProviders.join("|") || "-"}`);
  console.log(`effective=${input.effectiveProviders.join("|") || "-"}`);
  console.log(`compaction_summary_chars=${input.compactSummary?.length ?? 0}`);
  console.log("--- continuity ---");
  if (input.effectiveProviders.length === 0 && input.providerSessions.length === 0) {
    console.log("provider=- continuity=- updated=-");
  } else {
    for (const providerName of input.effectiveProviders) {
      const row = providerSessionByName.get(providerName);
      console.log(
        [
          `provider=${providerName}`,
          `continuity=${row?.providerSessionId ?? "-"}`,
          `updated=${row?.updatedAt ?? "-"}`
        ].join(" ")
      );
    }
    for (const row of input.providerSessions) {
      if (input.effectiveProviders.includes(row.providerName)) continue;
      console.log(
        [
          `provider=${row.providerName}`,
          `continuity=${row.providerSessionId}`,
          `updated=${row.updatedAt}`,
          "extra=yes"
        ].join(" ")
      );
    }
  }

  console.log("--- recent_runs ---");
  if (input.recentRuns.length === 0) {
    console.log("(no recent model runs)");
    return;
  }

  for (const run of input.recentRuns) {
    const warmStartUsed = metadataBoolean(run.metadata, "warmStartUsed");
    const warmStartContextChars = metadataNumber(run.metadata, "warmStartContextChars");
    console.log(
      [
        `run=${run.id}`,
        `provider=${run.providerName}`,
        `error=${run.isError ? "yes" : "no"}`,
        `warm_start=${warmStartUsed === true ? "yes" : warmStartUsed === false ? "no" : "-"}`,
        `context_chars=${warmStartContextChars ?? "-"}`,
        `at=${run.createdAt}`
      ].join(" ")
    );
  }
}

program
  .command("paths")
  .description("Show resolved runtime, profile, and legacy compatibility paths")
  .action(() => {
    const repoDefaultsDir = resolveRepoDefaultsDirForCli();
    console.log(`cwd=${process.cwd()}`);
    console.log(`env_tango_home=${process.env.TANGO_HOME?.trim() || "-"}`);
    console.log(`env_tango_profile=${process.env.TANGO_PROFILE?.trim() || "-"}`);
    console.log(`env_tango_config_dir=${process.env.TANGO_CONFIG_DIR?.trim() || "-"}`);
    console.log(`env_tango_db_path=${process.env.TANGO_DB_PATH?.trim() || "-"}`);
    console.log(`resolved_tango_home=${resolveTangoHome()}`);
    console.log(`resolved_tango_profile=${resolveTangoProfileName()}`);
    console.log(`resolved_profile_dir=${resolveTangoProfileDir()}`);
    console.log(`resolved_profile_config_dir=${resolveTangoProfileConfigDir()}`);
    console.log(`resolved_profile_data_dir=${resolveTangoProfileDataDir()}`);
    console.log(`resolved_profile_cache_dir=${resolveTangoProfileCacheDir()}`);
    console.log(`resolved_profile_logs_dir=${resolveTangoProfileLogsDir()}`);
    console.log(`resolved_profile_prompts_dir=${resolveTangoProfilePromptsDir()}`);
    console.log(`resolved_profile_tool_prompts_dir=${resolveTangoProfileToolPromptsDir()}`);
    console.log(`resolved_profile_skill_prompts_dir=${resolveTangoProfileSkillPromptsDir()}`);
    console.log(`resolved_config_dir=${resolveConfigDir()}`);
    console.log(`resolved_db_path=${resolveDatabasePath()}`);
    console.log(`legacy_repo_config_dir=${resolveLegacyConfigPath()}`);
    console.log(`repo_defaults_config_dir=${repoDefaultsDir ?? "-"}`);
    console.log(`legacy_repo_db_path=${resolveLegacyDatabasePath()}`);
  });

program
  .command("init")
  .description("Create a profile directory structure and optionally copy the active config into it")
  .option("--profile <name>", "Profile name to initialize")
  .option("--copy-current-config", "Copy the currently resolved config tree into the profile")
  .option("--force", "Overwrite existing copied files when used with --copy-current-config")
  .option("--dry-run", "Print the planned actions without writing")
  .action((options: {
    profile?: string;
    copyCurrentConfig?: boolean;
    force?: boolean;
    dryRun?: boolean;
  }) => {
    const profileOptions = buildProfileOptions(options.profile);
    const profileName = resolveTangoProfileName(profileOptions?.profile);
    const profileDir = resolveTangoProfileDir(profileOptions);
    const profileConfigDir = resolveTangoProfileConfigDir(profileOptions);
    const profilePromptsDir = resolveTangoProfilePromptsDir(profileOptions);
    const directories = [
      profileDir,
      profileConfigDir,
      resolveTangoProfileDataDir(profileOptions),
      resolveTangoProfileCacheDir(profileOptions),
      resolveTangoProfileLogsDir(profileOptions),
      path.join(profilePromptsDir, "agents"),
      path.join(profilePromptsDir, "shared"),
      path.join(profilePromptsDir, "skills"),
      path.join(profilePromptsDir, "tools"),
      path.join(profilePromptsDir, "workers"),
    ];

    console.log(`profile=${profileName}`);
    console.log(`profile_dir=${profileDir}`);
    console.log("--- directories ---");
    for (const dir of directories) {
      console.log(dir);
    }

    if (options.copyCurrentConfig) {
      console.log("--- copy_config ---");
      console.log(`from=${resolveConfigDir()}`);
      console.log(`to=${profileConfigDir}`);
      console.log(`force=${options.force === true ? "yes" : "no"}`);
    }

    if (options.dryRun) {
      return;
    }

    for (const dir of directories) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (options.copyCurrentConfig) {
      const currentConfigDir = resolveConfigDir();
      if (path.resolve(currentConfigDir) !== path.resolve(profileConfigDir)) {
        copyDirectory({
          source: currentConfigDir,
          destination: profileConfigDir,
          force: options.force,
        });
        rewriteCopiedPromptFilePaths({
          source: currentConfigDir,
          destination: profileConfigDir,
        });
      }
    }

    console.log("status=initialized");
  });

program
  .command("doctor")
  .description("Check whether Tango is still relying on repo-local mutable state")
  .option("--profile <name>", "Profile name to inspect")
  .option("--json", "Render the report as JSON")
  .action((options: { profile?: string; json?: boolean }) => {
    const profileOptions = buildProfileOptions(options.profile);
    const profileName = resolveTangoProfileName(profileOptions?.profile);
    const profileDir = resolveTangoProfileDir(profileOptions);
    const profileConfigDir = resolveTangoProfileConfigDir(profileOptions);
    const profileDataDir = resolveTangoProfileDataDir(profileOptions);
    const repoConfigDir = resolveLegacyConfigPath();
    const repoDefaultsDir = resolveRepoDefaultsDirForCli();
    const repoDbPath = resolveLegacyDatabasePath();
    const resolvedConfigDir = resolveConfigDir();
    const resolvedDbPath = resolveDatabasePath();
    const warnings: string[] = [];

    if (!repoDefaultsDir) {
      warnings.push("Repo defaults directory is missing (`config/defaults`).");
    }
    if (!fs.existsSync(profileDir)) {
      warnings.push(`Profile directory does not exist: ${profileDir}`);
    }
    if (!fs.existsSync(profileConfigDir)) {
      warnings.push(`Profile config directory does not exist: ${profileConfigDir}`);
    }
    if (!fs.existsSync(profileDataDir)) {
      warnings.push(`Profile data directory does not exist: ${profileDataDir}`);
    }
    if (path.resolve(resolvedConfigDir) === path.resolve(repoConfigDir)) {
      warnings.push("Resolved config is still pointing at the legacy repo-local config tree.");
    }
    if (path.resolve(resolvedDbPath) === path.resolve(repoDbPath)) {
      warnings.push("Resolved database is still pointing at the legacy repo-local data path.");
    }
    if (process.env.TANGO_CONFIG_DIR?.trim()) {
      warnings.push("TANGO_CONFIG_DIR is pinned explicitly; updates will not use layered repo defaults.");
    }
    if (process.env.TANGO_DB_PATH?.trim()) {
      warnings.push("TANGO_DB_PATH is pinned explicitly; runtime data will not move with profile defaults.");
    }

    const report = {
      profile: profileName,
      profileDir,
      profileConfigDir,
      profileDataDir,
      repoConfigDir,
      repoDefaultsDir,
      repoDbPath,
      resolvedConfigDir,
      resolvedDbPath,
      warnings,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`profile=${report.profile}`);
    console.log(`profile_dir=${report.profileDir}`);
    console.log(`profile_config_dir=${report.profileConfigDir}`);
    console.log(`profile_data_dir=${report.profileDataDir}`);
    console.log(`repo_config_dir=${report.repoConfigDir}`);
    console.log(`repo_defaults_config_dir=${report.repoDefaultsDir ?? "-"}`);
    console.log(`resolved_config_dir=${report.resolvedConfigDir}`);
    console.log(`resolved_db_path=${report.resolvedDbPath}`);
    console.log("--- warnings ---");
    if (warnings.length === 0) {
      console.log("ok");
      return;
    }
    for (const warning of warnings) {
      console.log(warning);
    }
  });

const configCommand = program.command("config").description("Config inspection tools");

configCommand
  .command("migrate")
  .description("Copy a repo-local or explicit config tree into a profile overlay")
  .option("--profile <name>", "Profile name to migrate into")
  .option("--from <path>", "Explicit source config directory")
  .option("--force", "Overwrite existing destination files")
  .option("--dry-run", "Print the planned copy without writing")
  .action((options: {
    profile?: string;
    from?: string;
    force?: boolean;
    dryRun?: boolean;
  }) => {
    const profileOptions = buildProfileOptions(options.profile);
    const profileName = resolveTangoProfileName(profileOptions?.profile);
    const destination = resolveTangoProfileConfigDir(profileOptions);
    const explicitSource = options.from?.trim();
    const legacySource = resolveLegacyConfigPath();
    const currentSource = resolveConfigDir();
    const source = explicitSource
      ? path.resolve(explicitSource)
      : path.resolve(legacySource) !== path.resolve(currentSource)
        ? legacySource
        : currentSource;

    console.log(`profile=${profileName}`);
    console.log(`from=${source}`);
    console.log(`to=${destination}`);
    console.log(`force=${options.force === true ? "yes" : "no"}`);

    if (path.resolve(source) === path.resolve(destination)) {
      console.log("status=noop");
      return;
    }

    if (options.dryRun) {
      return;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyDirectory({
      source,
      destination,
      force: options.force,
    });
    rewriteCopiedPromptFilePaths({
      source,
      destination,
    });
    console.log("status=migrated");
  });

configCommand
  .command("trace")
  .description("Show merged config plus source provenance for a category entry")
  .argument("<category>", "Config category")
  .argument("[id]", "Optional config entry id")
  .option("--json", "Render the trace payload as JSON")
  .action((category: string, id: string | undefined, options: { json?: boolean }) => {
    const normalizedCategory = category.trim();
    if (!validConfigCategories.has(normalizedCategory)) {
      console.error(
        `Unknown config category '${category}'. Valid categories: ${[...validConfigCategories].join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }

    const configDir = resolveConfigDir();
    const traces = traceConfigCategory({
      category: normalizedCategory as
        | "agents"
        | "intent-contracts"
        | "projects"
        | "schedules"
        | "sessions"
        | "tool-contracts"
        | "workflows"
        | "workers",
      configDir,
      id,
    });

    if (options.json) {
      console.log(JSON.stringify(traces, null, 2));
      return;
    }

    if (traces.length === 0) {
      console.log("No matching config entries.");
      return;
    }

    for (const [index, trace] of traces.entries()) {
      console.log(`[${trace.category}] ${trace.id}`);
      console.log(`resolved_config_dir=${configDir}`);
      console.log("--- sources ---");
      for (const source of trace.sourceFiles) {
        console.log(`${source.layer}:${source.role} ${source.filePath}`);
      }
      console.log("--- field_sources ---");
      for (const field of Object.keys(trace.fieldSources).sort()) {
        console.log(`${field} <- ${trace.fieldSources[field]}`);
      }
      console.log("--- merged ---");
      console.log(JSON.stringify(trace.mergedRaw, null, 2));
      if (index < traces.length - 1) {
        console.log("");
      }
    }
  });

const promptCommand = program.command("prompt").description("Prompt inspection tools");

promptCommand
  .command("trace")
  .description("Show the assembled prompt and source sections for an agent or worker")
  .argument("<kind>", "agent or worker")
  .argument("<id>", "Agent or worker id")
  .option("--json", "Render the prompt trace payload as JSON")
  .action((kind: string, id: string, options: { json?: boolean }) => {
    const normalizedKind = kind.trim().toLowerCase();
    const configDir = resolveConfigDir();

    let promptTrace:
      | {
          text: string;
          sections: Array<{
            kind: string;
            label: string;
            sourcePath: string;
            content: string;
          }>;
        }
      | null = null;
    let promptFile: string | undefined;

    if (normalizedKind === "agent") {
      const agent = loadUnifiedAgentConfigs(configDir).find((entry) => entry.id === id);
      if (!agent) {
        console.error(`Agent '${id}' not found.`);
        process.exitCode = 1;
        return;
      }
      promptFile = agent.promptFile;
      if (agent.promptFile && path.basename(agent.promptFile) === "soul.md") {
        promptTrace = traceAgentPrompt(path.dirname(agent.promptFile), {
          overlayDir: resolveTangoProfileAgentPromptDir(agent.id),
        });
      } else {
        promptTrace = {
          text: agent.prompt ?? "",
          sections: [
            {
              kind: "worker",
              label: agent.promptFile ? path.basename(agent.promptFile) : "inline",
              sourcePath: agent.promptFile ?? `inline:agent:${agent.id}`,
              content: agent.prompt ?? "",
            },
          ],
        };
      }
    } else if (normalizedKind === "worker") {
      const worker = loadWorkerConfigs(configDir).find((entry) => entry.id === id);
      if (!worker) {
        console.error(`Worker '${id}' not found.`);
        process.exitCode = 1;
        return;
      }
      promptFile = worker.promptFile;
      if (worker.promptFile && path.basename(worker.promptFile) === "soul.md") {
        promptTrace = traceAgentPrompt(path.dirname(worker.promptFile), {
          overlayDir: resolveTangoProfileWorkerPromptDir(worker.id),
        });
      } else {
        promptTrace = {
          text: worker.prompt ?? "",
          sections: [
            {
              kind: "worker",
              label: worker.promptFile ? path.basename(worker.promptFile) : "inline",
              sourcePath: worker.promptFile ?? `inline:worker:${worker.id}`,
              content: worker.prompt ?? "",
            },
          ],
        };
      }
    } else {
      console.error("Prompt trace kind must be 'agent' or 'worker'.");
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            kind: normalizedKind,
            id,
            configDir,
            promptFile: promptFile ?? null,
            promptTrace,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`[${normalizedKind}] ${id}`);
    console.log(`resolved_config_dir=${configDir}`);
    console.log(`prompt_file=${promptFile ?? "-"}`);
    console.log(`prompt_chars=${promptTrace.text.length}`);
    console.log("--- sections ---");
    for (const section of promptTrace.sections) {
      console.log(`${section.kind} ${section.label} ${section.sourcePath}`);
    }
    console.log("--- prompt ---");
    console.log(promptTrace.text);
  });

promptCommand
  .command("audit")
  .description("Find repo-layer personal prompt files that should be migrated to the active profile")
  .option("--profile <name>", "Profile name to inspect")
  .option("--json", "Render findings as JSON")
  .action((options: { profile?: string; json?: boolean }) => {
    const profileOptions = buildProfileOptions(options.profile);
    const profile = resolveTangoProfileName(profileOptions?.profile);
    const profileDir = resolveTangoProfileDir(profileOptions);
    const findings = findRepoLayerPersonalPromptFindings({
      repoRoot: process.cwd(),
      profilePathOptions: profileOptions,
    });

    if (options.json) {
      console.log(JSON.stringify({ profile, profileDir, findings }, null, 2));
      return;
    }

    console.log(`profile=${profile}`);
    console.log(`profile_dir=${profileDir}`);
    if (findings.length === 0) {
      console.log("status=ok");
      return;
    }

    console.log(`status=warnings`);
    console.log(`findings=${findings.length}`);
    for (const finding of findings) {
      console.log("");
      console.log(`[${finding.code}] agent=${finding.agentId}`);
      console.log(`repo_path=${finding.repoRelativePath}`);
      console.log(`path_kind=${finding.pathKind}`);
      if (finding.linkTarget) {
        console.log(`link_target=${finding.linkTarget}`);
      }
      console.log(`profile_target_hint=${finding.profileTargetHint}`);
      console.log(`summary=${finding.summary}`);
      console.log(`remediation=${finding.remediation}`);
    }
  });

program
  .command("status")
  .description("Show overall runtime and persistence status")
  .action(() => {
    withContext(({ configDir, dbPath, sessionConfigs, storage }) => {
      const health = storage.getHealthSnapshot();
      const summaries = storage.listStoredSessions();

      console.log(`config_dir=${configDir}`);
      console.log(`db_path=${dbPath}`);
      console.log(`configured_sessions=${sessionConfigs.length}`);
      console.log(`db_sessions=${health.sessions}`);
      console.log(`messages=${health.messages}`);
      console.log(`model_runs=${health.modelRuns}`);
      console.log(`provider_sessions=${health.providerSessions}`);
      console.log(`dead_letters_total=${health.deadLettersTotal}`);
      console.log(`dead_letters_pending=${health.deadLettersPending}`);
      console.log(`db_version=${health.dbUserVersion}`);
      console.log(`last_message_at=${formatDate(health.lastMessageAt)}`);

      if (summaries.length > 0) {
        console.log("--- sessions ---");
        for (const summary of summaries) {
          printSessionSummary(summary);
        }
      }
    });
  });

program
  .command("health")
  .description("Print machine-readable health snapshot")
  .action(() => {
    withContext(({ storage }) => {
      const health = storage.getHealthSnapshot();
      console.log(JSON.stringify(health, null, 2));
    });
  });

program
  .command("sessions")
  .description("List persisted session summaries")
  .option("--limit <n>", "Maximum sessions to display", "200")
  .action((options: { limit: string }) => {
    const limit = Number.parseInt(options.limit, 10);
    withContext(({ storage }) => {
      const summaries = storage.listStoredSessions(Number.isFinite(limit) ? limit : 200);
      if (summaries.length === 0) {
        console.log("No persisted sessions.");
        return;
      }
      for (const summary of summaries) {
        printSessionSummary(summary);
      }
    });
  });

const sessionCommand = program.command("session").description("Session operations");

sessionCommand
  .command("info")
  .description("Show session detail, recent messages, and recent model runs")
  .argument("<sessionId>", "Session ID")
  .option("--messages <n>", "Number of recent messages", "10")
  .option("--runs <n>", "Number of recent model runs", "5")
  .action((sessionId: string, options: { messages: string; runs: string }) => {
    const messageLimit = Number.parseInt(options.messages, 10);
    const runLimit = Number.parseInt(options.runs, 10);

    withContext(({ storage }) => {
      const summary = storage.getSessionSummary(sessionId);
      if (!summary) {
        console.error(`Session '${sessionId}' not found in persistence store.`);
        process.exitCode = 1;
        return;
      }

      printSessionSummary(summary);
      console.log(`updated=${summary.updatedAt}`);
      console.log(`last_model_run=${formatDate(summary.lastModelRunAt)}`);

      const resolvedMessageLimit = Number.isFinite(messageLimit) ? Math.max(messageLimit, 1) : 10;
      const messages = storage.listMessagesForSession(sessionId, 5000).slice(-resolvedMessageLimit);
      console.log("--- messages ---");
      for (const message of messages) {
        const preview = message.content.length > 120 ? `${message.content.slice(0, 117)}...` : message.content;
        console.log(
          [
            `id=${message.id}`,
            `dir=${message.direction}`,
            `vis=${message.visibility}`,
            `src=${message.source}`,
            `agent=${message.agentId ?? "-"}`,
            `at=${message.createdAt}`,
            `text=${JSON.stringify(preview)}`
          ].join(" ")
        );
      }

      const resolvedRunLimit = Number.isFinite(runLimit) ? Math.max(runLimit, 1) : 5;
      const runs = storage.listModelRunsForSession(sessionId, 5000).slice(-resolvedRunLimit);
      console.log("--- model_runs ---");
      for (const run of runs) {
        console.log(
          [
            `id=${run.id}`,
            `provider=${run.providerName}`,
            `model=${run.model ?? "-"}`,
            `mode=${run.responseMode ?? "-"}`,
            `latency_ms=${run.latencyMs ?? "-"}`,
            `input_tokens=${run.inputTokens ?? "-"}`,
            `output_tokens=${run.outputTokens ?? "-"}`,
            `cost=${run.totalCostUsd ?? "-"}`,
            `error=${run.isError ? "yes" : "no"}`,
            `at=${run.createdAt}`
          ].join(" ")
        );
      }
    });
  });

sessionCommand
  .command("reset")
  .description("Reset session state (provider continuity by default)")
  .argument("<sessionId>", "Session ID")
  .option("--hard", "Also clear persisted messages and model runs")
  .option("--diagnostics", "Clear model runs only (without deleting messages)")
  .option("--yes", "Confirm reset operation")
  .action(
    (
      sessionId: string,
      options: {
        hard?: boolean;
        diagnostics?: boolean;
        yes?: boolean;
      }
    ) => {
      if (!options.yes) {
        console.error(
          "Refusing to reset without --yes. Example: tango session reset <id> --yes [--hard|--diagnostics]"
        );
        process.exitCode = 1;
        return;
      }

      const resetOptions: ResetSessionOptions = {
        clearHistory: options.hard === true,
        clearDiagnostics: options.diagnostics === true || options.hard === true
      };

      withContext(({ storage }) => {
        const summary = storage.getSessionSummary(sessionId);
        if (!summary) {
          console.error(`Session '${sessionId}' not found in persistence store.`);
          process.exitCode = 1;
          return;
        }

        const result = storage.resetSession(sessionId, resetOptions);
        console.log(`session=${sessionId}`);
        console.log(`deleted_provider_sessions=${result.deletedProviderSessions}`);
        console.log(`deleted_messages=${result.deletedMessages}`);
        console.log(`deleted_model_runs=${result.deletedModelRuns}`);
        console.log(`deleted_dead_letters=${result.deletedDeadLetters}`);
      });
    }
  );

sessionCommand
  .command("provider")
  .description("Show or set session-level provider override")
  .argument("<sessionId>", "Session ID")
  .argument("<agentId>", "Agent ID")
  .option("--set <provider>", "Provider override to set")
  .option("--clear", "Clear provider override")
  .action(
    (
      sessionId: string,
      agentId: string,
      options: {
        set?: string;
        clear?: boolean;
      }
    ) => {
      withContext(({ storage, agentRegistry }) => {
        const summary = storage.getSessionSummary(sessionId);
        if (!summary) {
          console.error(`Session '${sessionId}' not found in persistence store.`);
          process.exitCode = 1;
          return;
        }

        const agent = agentRegistry.get(agentId);
        if (!agent) {
          console.error(`Agent '${agentId}' not found in config.`);
          process.exitCode = 1;
          return;
        }

        const providers = createProviders();
        const configuredProviders = resolveProviderCandidates(agent);

        if (options.clear === true) {
          const cleared = storage.clearSessionProviderOverride(sessionId, agent.id);

          const override = storage.getSessionProviderOverride(sessionId, agent.id);
          const effectiveProviders =
            override?.providerName && override.providerName.length > 0
              ? [override.providerName, ...configuredProviders.filter((name) => name !== override.providerName)]
              : configuredProviders;

          console.log(cleared ? "status=cleared" : "status=no-override");
          console.log(`session=${sessionId}`);
          console.log(`agent=${agent.id}`);
          console.log(`override=${override?.providerName ?? "-"}`);
          console.log(`configured=${configuredProviders.join("|") || "-"}`);
          console.log(`effective=${effectiveProviders.join("|") || "-"}`);
          return;
        }

        const setProvider = options.set?.trim();
        if (setProvider && setProvider.length > 0) {
          try {
            selectProviderByName(setProvider, providers);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
            process.exitCode = 1;
            return;
          }

          storage.upsertSessionProviderOverride({
            sessionId,
            agentId: agent.id,
            providerName: setProvider
          });

          const effectiveProviders = [
            setProvider,
            ...configuredProviders.filter((name) => name !== setProvider)
          ];
          console.log("status=set");
          console.log(`session=${sessionId}`);
          console.log(`agent=${agent.id}`);
          console.log(`override=${setProvider}`);
          console.log(`configured=${configuredProviders.join("|") || "-"}`);
          console.log(`effective=${effectiveProviders.join("|") || "-"}`);
          return;
        }

        const override = storage.getSessionProviderOverride(sessionId, agent.id);
        const effectiveProviders =
          override?.providerName && override.providerName.length > 0
            ? [
                override.providerName,
                ...configuredProviders.filter((name) => name !== override.providerName)
              ]
            : configuredProviders;

        console.log("status=show");
        console.log(`session=${sessionId}`);
        console.log(`agent=${agent.id}`);
        console.log(`override=${override?.providerName ?? "-"}`);
        console.log(`configured=${configuredProviders.join("|") || "-"}`);
        console.log(`effective=${effectiveProviders.join("|") || "-"}`);
      });
    }
  );

sessionCommand
  .command("continuity")
  .description("Show per-provider continuity and warm-start diagnostics for a session agent")
  .argument("<sessionId>", "Session ID")
  .argument("<agentId>", "Agent ID")
  .option("--runs <n>", "Recent model runs to include", "8")
  .action((sessionId: string, agentId: string, options: { runs: string }) => {
    const runLimit = Number.parseInt(options.runs, 10);

    withContext(({ storage, agentRegistry }) => {
      const summary = storage.getSessionSummary(sessionId);
      if (!summary) {
        console.error(`Session '${sessionId}' not found in persistence store.`);
        process.exitCode = 1;
        return;
      }

      const agent = agentRegistry.get(agentId);
      if (!agent) {
        console.error(`Agent '${agentId}' not found in config.`);
        process.exitCode = 1;
        return;
      }

      const configuredProviders = resolveProviderCandidates(agent);
      const override = storage.getSessionProviderOverride(sessionId, agent.id)?.providerName;
      const effectiveProviders =
        override && override.length > 0
          ? [override, ...configuredProviders.filter((name) => name !== override)]
          : configuredProviders;
      const conversationKey = `${sessionId}:${agent.id}`;
      const providerSessions = storage.listProviderSessionsForConversation(conversationKey, 40);
      const recentRuns = storage.listModelRunsForConversation(
        conversationKey,
        Number.isFinite(runLimit) ? Math.max(runLimit, 1) : 8
      );
      const compaction = storage.getSessionCompaction(sessionId, agent.id);

      printContinuityReport({
        sessionId,
        agentId: agent.id,
        conversationKey,
        configuredProviders,
        effectiveProviders,
        overrideProvider: override,
        providerSessions,
        recentRuns,
        compactSummary: compaction?.summaryText
      });
    });
  });

const deadLetterCommand = program.command("deadletters").description("Dead-letter queue operations");

deadLetterCommand
  .command("list")
  .description("List dead-letter queue entries")
  .option("--status <status>", "pending|resolved|all", "pending")
  .option("--session <sessionId>", "Filter by session ID")
  .option("--limit <n>", "Maximum entries to display", "25")
  .action((options: { status: string; session?: string; limit: string }) => {
    const status = normalizeDeadLetterStatus(options.status);
    if (!status) {
      console.error(`Invalid --status '${options.status}'. Use pending, resolved, or all.`);
      process.exitCode = 1;
      return;
    }

    const limit = Number.parseInt(options.limit, 10);
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 25;

    withContext(({ storage }) => {
      const entries = storage.listDeadLetters({
        status,
        sessionId: options.session,
        limit: resolvedLimit
      });

      if (entries.length === 0) {
        console.log("No dead-letter entries found.");
        return;
      }

      for (const entry of entries) {
        const preview =
          entry.lastErrorMessage.length > 120
            ? `${entry.lastErrorMessage.slice(0, 117)}...`
            : entry.lastErrorMessage;
        console.log(
          [
            `id=${entry.id}`,
            `status=${entry.status}`,
            `session=${entry.sessionId}`,
            `agent=${entry.agentId}`,
            `provider=${entry.providerName}`,
            `failures=${entry.failureCount}`,
            `replays=${entry.replayCount}`,
            `created=${entry.createdAt}`,
            `error=${JSON.stringify(preview)}`
          ].join(" ")
        );
      }
    });
  });

deadLetterCommand
  .command("replay")
  .description("Replay a dead-letter entry through its provider")
  .argument("<id>", "Dead-letter ID")
  .option("--force", "Replay even if already resolved")
  .action(async (id: string, options: { force?: boolean }) => {
    const numericId = Number.parseInt(id, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      console.error(`Invalid dead-letter id '${id}'.`);
      process.exitCode = 1;
      return;
    }

    await withContextAsync(async ({ storage, agentRegistry }) => {
      const deadLetter = storage.getDeadLetter(numericId);
      if (!deadLetter) {
        console.error(`Dead-letter entry '${numericId}' not found.`);
        process.exitCode = 1;
        return;
      }

      if (deadLetter.status === "resolved" && !options.force) {
        console.error(
          `Dead-letter entry '${numericId}' is already resolved. Use --force to replay again.`
        );
        process.exitCode = 1;
        return;
      }

      const configuredAgent = agentRegistry.get(deadLetter.agentId);
      const providerTools = resolveProviderToolsForAgent(configuredAgent);
      const providers = createProviders();
      let providerName = deadLetter.providerName;
      let providerResolution: "dead-letter" | "agent-default" | "agent-fallback" = "dead-letter";
      let provider: ChatProvider;
      try {
        provider = selectProviderByName(providerName, providers);
      } catch {
        if (!configuredAgent) {
          console.error(
            `Unsupported provider '${providerName}' and no matching agent config for '${deadLetter.agentId}'.`
          );
          process.exitCode = 1;
          return;
        }

        try {
          const selected = selectProviderForAgent(configuredAgent, providers);
          providerName = selected.providerName;
          provider = selected.provider;
          providerResolution = selected.usedFallback ? "agent-fallback" : "agent-default";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(message);
          process.exitCode = 1;
          return;
        }
      }

      const startedAt = Date.now();
      const continuityProviderSessionId =
        deadLetter.providerSessionId ??
        storage.getProviderSession(deadLetter.conversationKey, providerName)?.providerSessionId;
      try {
        const response = await provider.generate({
          prompt: deadLetter.promptText,
          providerSessionId: continuityProviderSessionId ?? undefined,
          systemPrompt: deadLetter.systemPrompt ?? undefined,
          tools: providerTools
        });
        const toolTelemetry = extractToolTelemetry(response.raw);

        if (response.providerSessionId) {
          storage.upsertProviderSession({
            conversationKey: deadLetter.conversationKey,
            sessionId: deadLetter.sessionId,
            agentId: deadLetter.agentId,
            providerName,
            providerSessionId: response.providerSessionId
          });
        }

        const responseMessageId = storage.insertMessage({
          sessionId: deadLetter.sessionId,
          agentId: deadLetter.agentId,
          providerName,
          direction: "outbound",
          source: "tango",
          visibility: "internal",
          discordChannelId: deadLetter.discordChannelId,
          discordUserId: null,
          discordUsername: "tango-cli",
          content: response.text,
          metadata: {
            replaySource: "cli",
            deadLetterId: deadLetter.id,
            forced: options.force === true,
            providerResolution,
            toolTelemetry
          }
        });

        const modelRunId = storage.insertModelRun({
          sessionId: deadLetter.sessionId,
          agentId: deadLetter.agentId,
          providerName,
          conversationKey: deadLetter.conversationKey,
          providerSessionId: response.providerSessionId ?? continuityProviderSessionId ?? null,
          model: response.metadata?.model,
          stopReason: response.metadata?.stopReason,
          responseMode: deadLetter.responseMode,
          latencyMs: Date.now() - startedAt,
          providerDurationMs: response.metadata?.durationMs,
          providerApiDurationMs: response.metadata?.durationApiMs,
          inputTokens: response.metadata?.usage?.inputTokens,
          outputTokens: response.metadata?.usage?.outputTokens,
          cacheReadInputTokens: response.metadata?.usage?.cacheReadInputTokens,
          cacheCreationInputTokens: response.metadata?.usage?.cacheCreationInputTokens,
          totalCostUsd: response.metadata?.totalCostUsd,
          requestMessageId: deadLetter.requestMessageId,
          responseMessageId,
          metadata: {
            replaySource: "cli",
            deadLetterId: deadLetter.id,
            forced: options.force === true,
            providerResolution,
            toolTelemetry
          },
          rawResponse:
            response.raw && typeof response.raw === "object"
              ? (response.raw as Record<string, unknown>)
              : null
        });

        storage.resolveDeadLetter({
          id: deadLetter.id,
          resolvedMessageId: responseMessageId,
          resolvedModelRunId: modelRunId,
          incrementReplayCount: true,
          metadata: {
            replaySource: "cli",
            forced: options.force === true,
            providerResolution,
            replayedAt: new Date().toISOString()
          }
        });

        const preview =
          response.text.length > 180 ? `${response.text.slice(0, 177)}...` : response.text;
        console.log(`dead_letter_id=${deadLetter.id}`);
        console.log("status=resolved");
        console.log(`provider=${providerName}`);
        console.log(`provider_resolution=${providerResolution}`);
        console.log(`model_run_id=${modelRunId}`);
        console.log(`response_message_id=${responseMessageId}`);
        console.log(`response_preview=${JSON.stringify(preview)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storage.recordDeadLetterReplayFailure({
          id: deadLetter.id,
          errorMessage: message,
          metadata: {
            replaySource: "cli",
            replayFailedAt: new Date().toISOString()
          }
        });

        storage.insertModelRun({
          sessionId: deadLetter.sessionId,
          agentId: deadLetter.agentId,
          providerName,
          conversationKey: deadLetter.conversationKey,
          providerSessionId: continuityProviderSessionId ?? null,
          responseMode: deadLetter.responseMode,
          latencyMs: Date.now() - startedAt,
          isError: true,
          errorMessage: message,
          requestMessageId: deadLetter.requestMessageId,
          metadata: {
            replaySource: "cli",
            replayFailed: true,
            deadLetterId: deadLetter.id,
            providerResolution,
            toolTelemetry: emptyToolTelemetry()
          }
        });

        console.error(`Replay failed for dead-letter '${deadLetter.id}': ${message}`);
        process.exitCode = 1;
      }
    });
  });

program.parse();
