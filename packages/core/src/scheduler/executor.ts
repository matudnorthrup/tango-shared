/**
 * Scheduler Executor — Executes a single scheduled job based on its execution mode.
 *
 * Three modes:
 * - deterministic: calls a registered handler function directly
 * - conditional-agent: calls pre-check handler, then optionally spawns agent worker
 * - agent: always spawns agent worker
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ScheduleConfig,
  V2ScheduledTurnExecuteFn,
  HandlerContext,
  RunStatus,
} from "./types.js";
import type { SchedulerStore } from "./store.js";
import { getDeterministicHandler, getPreCheckHandler } from "./handlers.js";
import { resolveDefaultObsidianVaultPath } from "../obsidian-indexer.js";

/** Safety cap on batches per drained conditional-agent run. */
const DEFAULT_DRAIN_MAX_BATCHES = 15;

export interface ExecutionResult {
  status: RunStatus;
  durationMs: number;
  summary?: string;
  error?: string;
  modelUsed?: string;
  preCheckResult?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutorDeps {
  store: SchedulerStore;
  executeV2Turn?: V2ScheduledTurnExecuteFn;
  db: import("node:sqlite").DatabaseSync;
}

function writeObsidianLog(
  config: ScheduleConfig,
  summary: string,
  status: "Done" | "Failed" = "Done",
): void {
  if (!config.obsidianLog) return;

  const { domain, jobName } = config.obsidianLog;
  const now = new Date();

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");

  const configuredVaultRoot = resolveDefaultObsidianVaultPath();
  const vaultRoot = path.resolve(configuredVaultRoot === "~"
    ? os.homedir()
    : configuredVaultRoot.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), configuredVaultRoot.slice(2))
      : configuredVaultRoot);
  const jobsDir = path.join(
    vaultRoot,
    "Records",
    "Jobs",
    domain,
  );
  const filePath = path.join(jobsDir, `${yyyy}-${mm}.md`);

  fs.mkdirSync(jobsDir, { recursive: true });
  ensureObsidianJobLogFrontmatter(filePath, domain, `${yyyy}-${mm}`);

  const truncatedSummary = truncateText(stripExplicitFlaggedSection(summary), 2000);
  const flaggedSection = buildFlaggedSection(summary);

  const entry = [
    "",
    `## ${yyyy}-${mm}-${dd} ${hh}:${min} — ${jobName}`,
    "",
    `**Status:** ${status}`,
    `**Summary:** ${truncatedSummary}`,
    "",
    flaggedSection ?? "No flagged items.",
    "",
  ].join("\n");

  fs.appendFileSync(filePath, entry, "utf8");

  console.error(
    `[scheduler] obsidian-log written: ${domain}/${yyyy}-${mm}.md for ${config.id}`,
  );
}

function ensureObsidianJobLogFrontmatter(filePath: string, domain: string, month: string): void {
  const header = buildObsidianJobLogHeader(domain, month);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header, "utf8");
    return;
  }

  const current = fs.readFileSync(filePath, "utf8");
  const trimmedStart = current.trimStart();
  if (trimmedStart.startsWith("---")) {
    if (trimmedStart !== current) {
      fs.writeFileSync(filePath, trimmedStart, "utf8");
    }
    return;
  }

  const needsTitle = !trimmedStart.startsWith("#");
  const repaired = needsTitle
    ? `${header}${trimmedStart}`
    : `${header.replace(/\n# [^\n]+\n$/u, "\n")}${trimmedStart}`;
  fs.writeFileSync(filePath, repaired, "utf8");
}

function buildObsidianJobLogHeader(domain: string, month: string): string {
  const titleDate = new Date(`${month}-01T12:00:00`);
  const title = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(titleDate);
  const areas = jobLogAreas(domain);
  const frontmatter = [
    "---",
    `date: ${month}-01`,
    "types:",
    '  - "[[Record]]"',
    "areas:",
    ...areas.map((area) => `  - "[[${area}]]"`),
    "source_kind: log",
    "record_kind: job_log",
    `job_domain: ${JSON.stringify(domain)}`,
    "---",
    "",
    `# ${domain} Jobs — ${title}`,
    "",
  ];

  return frontmatter.join("\n");
}

function jobLogAreas(domain: string): string[] {
  switch (domain) {
    case "Finance":
      return ["Finance"];
    case "Planning":
      return ["Personal"];
    case "Slack":
    case "Email":
      return ["Acme"];
    case "Vault":
      return ["Tango"];
    default:
      return ["Tango"];
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

const FLAG_SIGNAL_PATTERNS = [
  /\bneeds?\s+(?:your\s+)?(?:review|input|decision|clarification)\b/iu,
  /\btransactions?\s+held\b/iu,
  /\bambiguous\b/iu,
  /\buncategorized\b/iu,
  /\buncleared\b/iu,
  /\bbudget setup recommended\b/iu,
  /\bno budgets configured\b/iu,
  /\bover budget\b/iu,
  /\bbelow floor\b/iu,
  /\binsufficient funds\b/iu,
  /\bmissing\b/iu,
  /\bmismatch\b/iu,
  /\bfailed\b/iu,
  /\berror\b/iu,
  /\b2fa\b/iu,
  /\blogin\b/iu,
] as const;

const EXPLICIT_FLAGGED_SECTION_MAX_LENGTH = 8000;

const CLEAN_SIGNAL_PATTERNS = [
  /\bno flags?\b/iu,
  /\bno flagged items\b/iu,
  /\bno warnings?\b/iu,
  /\bno issues?\b/iu,
  /\bnone\b/iu,
] as const;

function buildFlaggedSection(summary: string): string | undefined {
  const explicit = extractExplicitFlaggedSection(summary);
  if (explicit) {
    return `**Flagged:**\n${explicit}`;
  }

  const excerpt = extractSignalExcerpt(summary);
  if (!excerpt) {
    return undefined;
  }

  return `**Flagged:**\n- Review needed: ${excerpt}`;
}

function extractExplicitFlaggedSection(summary: string): string | undefined {
  const lines = summary.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => isFlagHeading(line));
  if (startIndex === -1) {
    return undefined;
  }

  const block: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (block.length > 0 && isSectionHeading(line)) {
      break;
    }
    block.push(line);
  }

  const rendered = block.join("\n").trim();
  return rendered.length > 0
    ? truncateText(rendered, EXPLICIT_FLAGGED_SECTION_MAX_LENGTH)
    : undefined;
}

function stripExplicitFlaggedSection(summary: string): string {
  const lines = summary.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => isFlagHeading(line));
  if (startIndex === -1) {
    return summary;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (index > startIndex + 1 && isSectionHeading(lines[index] ?? "")) {
      endIndex = index;
      break;
    }
  }

  const stripped = [
    ...lines.slice(0, startIndex),
    ...lines.slice(endIndex),
  ].join("\n").trim();
  return stripped || "Completed.";
}

function extractSignalExcerpt(summary: string): string | undefined {
  const lines = summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const signalIndex = lines.findIndex((line) => hasFlagSignal(line));
  if (signalIndex === -1) {
    return undefined;
  }

  const excerptLines = lines.slice(signalIndex, signalIndex + 8);
  return truncateText(excerptLines.join(" "), 1000);
}

function isFlagHeading(line: string): boolean {
  const normalized = line
    .replace(/^#{1,6}\s*/u, "")
    .replace(/\*/gu, "")
    .replace(/:$/u, "")
    .trim()
    .toLowerCase();
  return normalized === "flagged" || normalized === "flags";
}

function isSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+\S/u.test(trimmed) || /^\*\*[^*\n]+:\*\*\s*$/u.test(trimmed);
}

function hasFlagSignal(line: string): boolean {
  if (CLEAN_SIGNAL_PATTERNS.some((pattern) => pattern.test(line))) {
    return false;
  }
  return FLAG_SIGNAL_PATTERNS.some((pattern) => pattern.test(line));
}

export async function executeSchedule(
  config: ScheduleConfig,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const { mode } = config.execution;

  try {
    switch (mode) {
      case "deterministic":
        return await executeDeterministic(config, deps, startTime);
      case "conditional-agent":
        return await executeConditionalAgent(config, deps, startTime);
      case "agent":
        return await executeAgent(config, deps, startTime);
      default:
        return {
          status: "error",
          durationMs: Date.now() - startTime,
          error: `Unknown execution mode: ${mode}`,
        };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (config.obsidianLog) {
      try {
        writeObsidianLog(config, `Error: ${error}`, "Failed");
      } catch (logError) {
        console.error(`[scheduler] obsidian-log error for failed ${config.id}:`, logError);
      }
    }
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error,
    };
  }
}

// -------------------------------------------------------------------
// Deterministic execution
// -------------------------------------------------------------------

async function executeDeterministic(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
): Promise<ExecutionResult> {
  const handlerName = config.execution.handler;
  if (!handlerName) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Deterministic schedule missing 'execution.handler'",
    };
  }

  const handler = getDeterministicHandler(handlerName);
  if (!handler) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: `No deterministic handler registered for '${handlerName}'`,
    };
  }

  const ctx: HandlerContext = {
    scheduleId: config.id,
    db: deps.db,
    lastRunAt: getLastRunDate(config.id, deps),
  };

  const timeoutMs = (config.execution.timeoutSeconds ?? 30) * 1000;
  const result = await withTimeout(handler(ctx), timeoutMs, `Handler '${handlerName}' timed out`);

  if (config.obsidianLog && (result.status === "ok" || result.status === "skipped")) {
    try {
      writeObsidianLog(config, result.summary ?? `Completed with status ${result.status}`);
    } catch (err) {
      console.error(`[scheduler] obsidian-log error for ${config.id}:`, err);
    }
  }

  return {
    status: result.status,
    durationMs: Date.now() - startTime,
    summary: result.summary,
    metadata: result.data,
  };
}

// -------------------------------------------------------------------
// Conditional-agent execution
// -------------------------------------------------------------------

async function executeConditionalAgent(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
): Promise<ExecutionResult> {
  const preCheckConfig = config.execution.preCheck;
  if (!preCheckConfig) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Conditional-agent schedule missing 'execution.pre_check'",
    };
  }

  const preCheckHandler = getPreCheckHandler(preCheckConfig.handler);
  if (!preCheckHandler) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: `No pre-check handler registered for '${preCheckConfig.handler}'`,
    };
  }

  // Drain mode keeps re-running the pre-check + agent batch until the pre-check
  // reports nothing left to process. A no-op single run (drainBatches unset)
  // behaves exactly as before: one pre-check, one batch.
  const drain = config.execution.drainBatches === true;
  const maxBatches = drain
    ? (config.execution.drainMaxBatches ?? DEFAULT_DRAIN_MAX_BATCHES)
    : 1;

  const batchSummaries: string[] = [];
  let batchesRun = 0;
  let lastResult: ExecutionResult | undefined;
  // Backlog size from the previous batch's pre-check; used to detect a stuck
  // candidate the agent can't clear (which would otherwise loop forever).
  let previousBacklog: number[] | null = null;

  for (let batch = 0; batch < maxBatches; batch++) {
    const ctx: HandlerContext = {
      scheduleId: config.id,
      db: deps.db,
      lastRunAt: getLastRunDate(config.id, deps),
    };

    const preCheckResult = await withTimeout(
      preCheckHandler(ctx),
      30_000,
      `Pre-check '${preCheckConfig.handler}' timed out`,
    );

    if (preCheckResult.action === "skip") {
      // Nothing (left) to do. On the very first pass this is the classic
      // "skipped" outcome; after one or more batches it means we drained clean.
      if (batchesRun === 0) {
        if (config.obsidianLog) {
          try {
            writeObsidianLog(config, `Skipped — ${preCheckResult.reason ?? "pre-check returned skip"}`);
          } catch (err) {
            console.error(`[scheduler] obsidian-log error for ${config.id}:`, err);
          }
        }
        return {
          status: "skipped",
          durationMs: Date.now() - startTime,
          summary: preCheckResult.reason,
          preCheckResult: JSON.stringify(preCheckResult),
        };
      }
      break;
    }

    // No-progress guard: if the backlog didn't shrink after a completed batch,
    // the agent couldn't clear the remaining candidates (e.g. a 2FA wall).
    // Stop rather than spin, and flag it in the summary.
    // Progress is any kind of work shrinking: a batch that clears a receipt can surface a
    // repair, which moves work between kinds without the total going down. drain_max_batches
    // still bounds the loop.
    if (drain && batchesRun > 0) {
      const backlog = drainBacklogCounts(preCheckResult.context);
      if (previousBacklog && !backlog.some((count, index) => count < previousBacklog![index]!)) {
        const remaining = backlog.reduce((sum, count) => sum + count, 0);
        batchSummaries.push(
          `Halted draining after batch ${batchesRun}: backlog not decreasing `
            + `(${remaining} candidate(s) remain — likely a stuck receipt needing manual attention).`,
        );
        break;
      }
      previousBacklog = backlog;
    } else if (drain) {
      previousBacklog = drainBacklogCounts(preCheckResult.context);
    }

    lastResult = await runAgentWorker(config, deps, startTime, preCheckResult.context);
    batchesRun++;
    if (lastResult.summary) {
      batchSummaries.push(lastResult.summary);
    }
    // Stop the drain on a failed batch; the caller's backoff/alerting handles it.
    if (lastResult.status !== "ok") {
      break;
    }
    if (!drain) {
      break;
    }
  }

  const combinedSummary = batchSummaries.join("\n\n---\n\n").trim() || undefined;
  return {
    status: lastResult?.status ?? "ok",
    durationMs: Date.now() - startTime,
    summary: combinedSummary ? combinedSummary.slice(0, 2000) : undefined,
    modelUsed: lastResult?.modelUsed,
    preCheckResult: JSON.stringify({ action: "proceed", batchesRun }),
    metadata: { ...(lastResult?.metadata ?? {}), batchesRun },
  };
}

/**
 * Total unresolved candidates a drained pre-check still reports. Used to detect
 * a stuck backlog (no forward progress) so the drain loop terminates.
 */
/** Remaining work per kind a batch can finish; a repair-only drain must count its repairs too. */
function drainBacklogCounts(context: Record<string, unknown> | undefined): number[] {
  return ["totalRetailerCandidateCount", "reimbursementGapCandidateCount", "invalidCategoryNoteCount"].map((key) => {
    const count = Number(context?.[key] ?? 0);
    return Number.isFinite(count) ? count : 0;
  });
}

// -------------------------------------------------------------------
// Agent execution
// -------------------------------------------------------------------

async function executeAgent(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
): Promise<ExecutionResult> {
  return await runAgentWorker(config, deps, startTime);
}

// -------------------------------------------------------------------
// Shared agent worker execution
// -------------------------------------------------------------------

async function runAgentWorker(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
  preCheckContext?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const workerId = config.execution.workerId;
  if (!workerId) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Agent schedule missing 'execution.worker_id'",
    };
  }

  // Resolve the task
  let task: string;
  if (preCheckContext && config.execution.taskTemplate) {
    task = interpolateTemplate(config.execution.taskTemplate, preCheckContext);
  } else if (config.execution.task) {
    task = config.execution.task;
  } else {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Agent schedule missing 'execution.task' or 'execution.task_template'",
    };
  }

  const timeoutMs = (config.execution.timeoutSeconds ?? 300) * 1000;

  if (config.runtime !== "v2") {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: `Agent schedule '${config.id}' must set runtime: v2; legacy worker execution has been retired.`,
    };
  }

  if (!deps.executeV2Turn) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Scheduler v2 turn executor is not configured.",
    };
  }

  const agentId = config.delivery?.agentId ?? config.execution.deterministicAgentId;
  if (!agentId) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: `Agent schedule '${config.id}' must set delivery.agent_id or execution.deterministic_agent_id.`,
    };
  }
  const v2Result = await withTimeout(
    deps.executeV2Turn({ config, task, agentId }),
    timeoutMs,
    `V2 scheduled turn for agent '${agentId}' timed out`,
  );

  // Workers can return "__NO_OUTPUT__" to signal nothing to report (e.g., no
  // uncategorized transactions). Treat as a successful skip — no delivery, no
  // summary in logs.
  const trimmedText = v2Result.text.trim();
  const fullSummary = trimmedText === "__NO_OUTPUT__" ? undefined : trimmedText;
  const summary = fullSummary ? fullSummary.slice(0, 2000) : undefined;
  if (config.obsidianLog) {
    try {
      writeObsidianLog(config, fullSummary ?? "Completed — no output");
    } catch (err) {
      console.error(`[scheduler] obsidian-log error for ${config.id}:`, err);
    }
  }

  return {
    status: "ok",
    durationMs: Date.now() - startTime,
    summary,
    modelUsed: v2Result.model,
    preCheckResult: preCheckContext ? JSON.stringify({ action: "proceed", context: preCheckContext }) : undefined,
    metadata: v2Result.metadata,
  };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function getLastRunDate(scheduleId: string, deps: ExecutorDeps): Date | undefined {
  const state = deps.store.getState(scheduleId);
  if (state?.lastRunAt) {
    return new Date(state.lastRunAt);
  }
  return undefined;
}

function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = context[key];
    if (value === undefined) return `{{${key}}}`;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
