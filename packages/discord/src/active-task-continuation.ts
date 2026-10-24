import type {
  ActiveTaskRecord,
  ActiveTaskStatus,
  ActiveTaskStatusUpdateInput,
  ActiveTaskUpsertInput,
  ChatProvider,
  V2AgentConfig,
} from "@tango/core";
import { resolveExtractionProvider } from "./extraction-provider.js";

/**
 * Active-task continuation for the v2 runtime.
 *
 * The legacy mechanism (active-task-state.ts, retired 2026-05-25) ran inside
 * the deterministic turn executor and died with it; the v2 TangoRouter never
 * captured tasks, which left active_tasks dormant after the 2026-04-21 v2
 * flip (TGO-743). This module rebuilds the loop on the v2 pattern already
 * proven by post-turn memory extraction:
 *
 * - post-turn: a lightweight extraction call sees the exchange plus the
 *   session's open tasks and returns tasks to resolve (completed/canceled)
 *   and at most one new unfinished commitment to capture
 * - pre-turn: buildWarmStartContext appends the open tasks so the next turn
 *   can pick the work back up
 */

export const OPEN_ACTIVE_TASK_STATUSES: ReadonlySet<ActiveTaskStatus> = new Set([
  "proposed",
  "awaiting_user",
  "ready",
  "running",
  "blocked",
]);

const CAPTURE_STATUSES = new Set<ActiveTaskStatus>(["awaiting_user", "blocked"]);
const RESOLUTION_STATUSES = new Set<ActiveTaskStatus>(["completed", "canceled"]);
const CAPTURE_SOURCE_KINDS = new Set([
  "assistant-offer",
  "assistant-clarification",
  "execution-blocked",
  "dangling-intent",
]);

const CAPTURE_EXPIRY_HOURS = 72;
const EXTRACTION_MAX_ATTEMPTS = 2;
const EXTRACTION_RETRY_DELAY_MS = 2_000;
const WARM_START_TASK_LIMIT = 3;
const OPEN_TASK_QUERY_LIMIT = 5;

export interface ActiveTaskStorage {
  listActiveTasks(options: { sessionId: string; agentId: string; limit?: number }): ActiveTaskRecord[];
  upsertActiveTask(input: ActiveTaskUpsertInput): string;
  updateActiveTaskStatus(input: ActiveTaskStatusUpdateInput): boolean;
}

export interface ActiveTaskTurnContext {
  sessionId: string;
  agentId: string;
  userMessage: string;
  agentResponse: string;
  toolsUsed?: readonly string[];
  requestMessageId?: number | null;
  responseMessageId?: number | null;
}

export interface ActiveTaskContinuationSettings {
  extractionProvider: string;
  extractionModel: string;
}

export interface ActiveTaskCapture {
  title: string;
  objective: string;
  status: ActiveTaskStatus;
  clarificationQuestion?: string;
  suggestedNextAction?: string;
  sourceKind: string;
}

export interface ActiveTaskPlan {
  resolutions: Array<{ id: string; status: ActiveTaskStatus }>;
  capture: ActiveTaskCapture | null;
}

/**
 * Per-agent gate. Default is enabled for every v2 agent; the optional
 * active_tasks yaml section disables it or overrides the extraction target.
 * Provider/model fall back to the agent's memory-extraction settings so
 * Ollama clones extract on Ollama instead of billing the Claude CLI.
 */
export function resolveActiveTaskContinuationSettings(
  v2Config: V2AgentConfig | null | undefined,
): ActiveTaskContinuationSettings | null {
  if (!v2Config) {
    return null;
  }
  if (v2Config.activeTasks?.continuation === "disabled") {
    return null;
  }

  const extractionModel = v2Config.activeTasks?.extractionModel ?? v2Config.memory.extractionModel;
  return {
    extractionProvider: resolveExtractionProvider(
      v2Config,
      v2Config.activeTasks?.extractionProvider ?? v2Config.memory.extractionProvider,
      extractionModel,
    ),
    extractionModel,
  };
}

export function renderActiveTasksWarmStartBlock(
  tasks: readonly ActiveTaskRecord[],
  options: { limit?: number } = {},
): string | undefined {
  const openTasks = tasks.filter((task) => OPEN_ACTIVE_TASK_STATUSES.has(task.status));
  if (openTasks.length === 0) {
    return undefined;
  }

  const limit = Math.max(options.limit ?? WARM_START_TASK_LIMIT, 1);
  const lines = ["Active tasks (unfinished from earlier in this conversation):"];
  for (const task of openTasks.slice(0, limit)) {
    const details: string[] = [];
    if (task.clarificationQuestion) {
      details.push(`asked: "${truncate(task.clarificationQuestion, 140)}"`);
    }
    if (task.suggestedNextAction) {
      details.push(`next: ${truncate(task.suggestedNextAction, 140)}`);
    }
    const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
    lines.push(`- [${task.status}] ${task.title} — ${truncate(task.objective, 200)}${suffix}`);
  }
  lines.push(
    'If the user\'s message refers to one of these (even indirectly, e.g. "yeah, go ahead" or "any update?"), continue that task and complete it now.',
  );
  return lines.join("\n");
}

export function buildActiveTaskExtractionPrompt(
  context: ActiveTaskTurnContext,
  openTasks: readonly ActiveTaskRecord[],
): string {
  const openTasksJson =
    openTasks.length > 0
      ? JSON.stringify(
          openTasks.map((task) => ({
            id: task.id,
            status: task.status,
            title: task.title,
            objective: truncate(task.objective, 200),
          })),
        )
      : "none";
  const toolsUsed =
    context.toolsUsed && context.toolsUsed.length > 0 ? context.toolsUsed.join(", ") : "none";

  return [
    "You maintain an assistant's \"active tasks\" list: unfinished commitments from a conversation that should be continued in later turns.",
    "",
    `Open tasks: ${openTasksJson}`,
    "",
    "Latest exchange:",
    `User: ${truncate(context.userMessage, 1_500)}`,
    `Assistant: ${truncateMiddle(context.agentResponse, 2_000, 2_000)}`,
    `Tools used this turn: ${toolsUsed}`,
    "",
    "Return ONLY a JSON object:",
    "{",
    '  "resolutions": [{"id": "<open task id>", "status": "completed" | "canceled"}],',
    '  "capture": null | {',
    '    "title": "<short imperative title>",',
    '    "objective": "<one sentence: what remains to be done, specific enough to resume later>",',
    '    "status": "awaiting_user" | "blocked",',
    '    "clarification_question": "<question the assistant ended on, if any>",',
    '    "suggested_next_action": "<the concrete next step>",',
    '    "source_kind": "assistant-offer" | "assistant-clarification" | "execution-blocked" | "dangling-intent"',
    "  }",
    "}",
    "",
    "Rules:",
    "- resolutions: every open task this exchange finished (the assistant delivered the result) or the user canceled / no longer wants.",
    "- capture: at most ONE new unfinished commitment from THIS exchange —",
    '  the assistant offered to do something and awaits a yes ("assistant-offer"),',
    '  ended on a clarifying question ("assistant-clarification"),',
    '  tried something that failed or stalled mid-way ("execution-blocked"),',
    '  or said it would do/finish something but the turn ended without the result ("dangling-intent").',
    '- Do NOT capture work fully completed this turn, pleasantries ("let me know if you need anything"), or anything already covered by an open task.',
    '- If nothing to resolve and nothing to capture: {"resolutions": [], "capture": null}',
  ].join("\n");
}

export function parseActiveTaskPlan(text: string, openTaskIds: ReadonlySet<string>): ActiveTaskPlan {
  for (const candidate of buildJsonObjectCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    return {
      resolutions: normalizeResolutions(parsed.resolutions, openTaskIds),
      capture: normalizeCapture(parsed.capture),
    };
  }

  throw new Error("Active-task extraction did not return a valid JSON object");
}

export interface ActiveTaskPlanOutcome {
  capturedTaskId: string | null;
  capturedTitle: string | null;
  resolvedCount: number;
}

export function applyActiveTaskPlan(input: {
  storage: ActiveTaskStorage;
  context: ActiveTaskTurnContext;
  openTasks: readonly ActiveTaskRecord[];
  plan: ActiveTaskPlan;
}): ActiveTaskPlanOutcome {
  const { storage, context, openTasks, plan } = input;
  let resolvedCount = 0;

  for (const resolution of plan.resolutions) {
    const updated = storage.updateActiveTaskStatus({
      id: resolution.id,
      status: resolution.status,
      updatedByMessageId: context.responseMessageId ?? null,
    });
    if (updated) {
      resolvedCount += 1;
    }
  }

  if (!plan.capture) {
    return { capturedTaskId: null, capturedTitle: null, resolvedCount };
  }

  const resolvedIds = new Set(plan.resolutions.map((resolution) => resolution.id));
  // Re-capture guard: an extraction that repeats a still-open task refreshes
  // that row (and its expiry) instead of inserting a near-duplicate.
  const existing = openTasks.find(
    (task) => !resolvedIds.has(task.id) && normalizeTitle(task.title) === normalizeTitle(plan.capture!.title),
  );

  const capturedTaskId = storage.upsertActiveTask({
    ...(existing ? { id: existing.id } : {}),
    sessionId: context.sessionId,
    agentId: context.agentId,
    status: plan.capture.status,
    title: plan.capture.title,
    objective: plan.capture.objective,
    clarificationQuestion: plan.capture.clarificationQuestion ?? null,
    suggestedNextAction: plan.capture.suggestedNextAction ?? null,
    sourceKind: plan.capture.sourceKind,
    createdByMessageId: context.requestMessageId ?? null,
    updatedByMessageId: context.responseMessageId ?? null,
    expiresAt: futureIso(CAPTURE_EXPIRY_HOURS),
  });

  return { capturedTaskId, capturedTitle: plan.capture.title, resolvedCount };
}

export async function runActiveTaskPostTurn(input: {
  storage: ActiveTaskStorage;
  context: ActiveTaskTurnContext;
  v2Config: V2AgentConfig | null | undefined;
  resolveProvider: (name: string) => ChatProvider | undefined;
}): Promise<ActiveTaskPlanOutcome | null> {
  const settings = resolveActiveTaskContinuationSettings(input.v2Config);
  if (!settings || input.context.agentResponse.trim().length === 0) {
    return null;
  }

  const provider = input.resolveProvider(settings.extractionProvider);
  if (!provider) {
    console.warn(
      `[active-task] no provider '${settings.extractionProvider}' registered for agent ${input.context.agentId}; skipping post-turn capture`,
    );
    return null;
  }

  const openTasks = input.storage.listActiveTasks({
    sessionId: input.context.sessionId,
    agentId: input.context.agentId,
    limit: OPEN_TASK_QUERY_LIMIT,
  });

  const prompt = buildActiveTaskExtractionPrompt(input.context, openTasks);
  const openTaskIds = new Set(openTasks.map((task) => task.id));
  const plan = await extractWithRetry(prompt, openTaskIds, settings, provider);

  const outcome = applyActiveTaskPlan({
    storage: input.storage,
    context: input.context,
    openTasks,
    plan,
  });

  if (outcome.capturedTaskId || outcome.resolvedCount > 0) {
    console.log(
      `[active-task] session=${input.context.sessionId} agent=${input.context.agentId} captured=${
        outcome.capturedTitle ? JSON.stringify(truncate(outcome.capturedTitle, 80)) : "none"
      } resolved=${outcome.resolvedCount}`,
    );
  }

  return outcome;
}

/**
 * Fire-and-forget wrapper for the turn paths in main.ts: capture must never
 * block or fail an interactive turn (same contract as memory extraction).
 */
export function scheduleActiveTaskPostTurn(input: {
  storage: ActiveTaskStorage;
  context: ActiveTaskTurnContext;
  v2Config: V2AgentConfig | null | undefined;
  resolveProvider: (name: string) => ChatProvider | undefined;
}): void {
  setImmediate(() => {
    void runActiveTaskPostTurn(input).catch((error) => {
      console.warn(
        `[active-task] post-turn capture failed session=${input.context.sessionId} agent=${input.context.agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
}

async function extractWithRetry(
  prompt: string,
  openTaskIds: ReadonlySet<string>,
  settings: ActiveTaskContinuationSettings,
  provider: ChatProvider,
): Promise<ActiveTaskPlan> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await provider.generate({
        prompt,
        model: settings.extractionModel,
        reasoningEffort: "low",
      });
      return parseActiveTaskPlan(response.text, openTaskIds);
    } catch (error) {
      lastError = error;
      if (attempt < EXTRACTION_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, EXTRACTION_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

function normalizeResolutions(
  value: unknown,
  openTaskIds: ReadonlySet<string>,
): Array<{ id: string; status: ActiveTaskStatus }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const resolutions: Array<{ id: string; status: ActiveTaskStatus }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.status !== "string") {
      continue;
    }
    const id = item.id.trim();
    const status = item.status.trim() as ActiveTaskStatus;
    // Only statuses we accept and only ids the model was actually shown —
    // hallucinated ids must not touch other sessions' rows.
    if (!openTaskIds.has(id) || !RESOLUTION_STATUSES.has(status) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolutions.push({ id, status });
  }
  return resolutions;
}

function normalizeCapture(value: unknown): ActiveTaskCapture | null {
  if (!isRecord(value)) {
    return null;
  }

  const title = normalizeNonEmptyString(value.title);
  const objective = normalizeNonEmptyString(value.objective);
  const status = normalizeNonEmptyString(value.status) as ActiveTaskStatus | null;
  if (!title || !objective || !status || !CAPTURE_STATUSES.has(status)) {
    return null;
  }

  const sourceKind = normalizeNonEmptyString(value.source_kind ?? value.sourceKind);
  const clarificationQuestion = normalizeNonEmptyString(
    value.clarification_question ?? value.clarificationQuestion,
  );
  const suggestedNextAction = normalizeNonEmptyString(
    value.suggested_next_action ?? value.suggestedNextAction,
  );

  return {
    title: truncate(title, 200),
    objective: truncate(objective, 500),
    status,
    ...(clarificationQuestion ? { clarificationQuestion: truncate(clarificationQuestion, 300) } : {}),
    ...(suggestedNextAction ? { suggestedNextAction: truncate(suggestedNextAction, 300) } : {}),
    sourceKind: sourceKind && CAPTURE_SOURCE_KINDS.has(sourceKind) ? sourceKind : "assistant-offer",
  };
}

function buildJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    candidates.push(trimmed);
  }

  const fencedJsonPattern = /```(?:json)?\s*([\s\S]*?)```/giu;
  for (const match of text.matchAll(fencedJsonPattern)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1).trim());
  }

  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function truncateMiddle(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 20) {
    return text;
  }
  return `${text.slice(0, headChars)}\n…[truncated]…\n${text.slice(-tailChars)}`;
}

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
