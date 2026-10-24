import type { ProviderReasoningEffort } from "./types.js";

export type SubAgentStatus = "completed" | "failed" | "timeout";

export interface SpawnSubAgentsQualityGate {
  task_class?: string;
  constraints?: string[];
  success_criteria?: string[];
  must_answer?: string[];
  comparison_axes?: string[];
  required_fields?: string[];
  min_source_count?: number;
  require_structured_output?: boolean;
}

export interface SpawnSubAgentsInput {
  sub_tasks: SubTaskSpec[];
  concurrency?: number;
  timeout_seconds?: number;
  max_rounds?: number;
  quality_gate?: SpawnSubAgentsQualityGate;
}

export interface SubTaskSpec {
  id: string;
  task: string;
  tools: string[];
  provider?: string;
  model?: string;
  reasoning_effort?: ProviderReasoningEffort;
  depends_on?: string[];
  output_schema?: "text" | "research_evidence_v1";
  constraints?: string[];
  success_criteria?: string[];
  must_answer?: string[];
  comparison_axes?: string[];
  required_fields?: string[];
}

export interface SubAgentToolCallSummary {
  name: string;
  server_name?: string;
  tool_name?: string;
  duration_ms?: number;
}

export interface SubAgentResult {
  id: string;
  status: SubAgentStatus;
  output: string;
  tool_calls: SubAgentToolCallSummary[];
  duration_ms: number;
  provider_name?: string;
  model?: string;
  cost_estimate_usd?: number;
  error?: string;
}

export interface SpawnSubAgentsOutput {
  results: SubAgentResult[];
  total_duration_ms: number;
  cost_estimate_usd: number;
}

export interface SubAgentBatchBudgetState {
  roundsUsed: number;
  totalSubAgents: number;
}

export interface RunSubAgentBatchOptions {
  executeSubTask: (task: SubTaskSpec, context: {
    round: number;
    timeoutSeconds: number;
  }) => Promise<SubAgentResult>;
  budget?: SubAgentBatchBudgetState;
  defaultConcurrency?: number;
  concurrencyMax?: number;
  defaultTimeoutSeconds?: number;
  timeoutSecondsMax?: number;
  maxRounds?: number;
  maxTotalSubAgents?: number;
}

interface NormalizedSubTaskSpec {
  id: string;
  task: string;
  tools: string[];
  provider?: string;
  model?: string;
  reasoning_effort?: ProviderReasoningEffort;
  depends_on: string[];
  output_schema?: "text" | "research_evidence_v1";
  constraints: string[];
  success_criteria: string[];
  must_answer: string[];
  comparison_axes: string[];
  required_fields: string[];
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value as number)));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const deduped = new Set<string>();
  for (const item of value) {
    const normalized = normalizeString(item);
    if (normalized.length === 0) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

function normalizeTaskSpec(raw: SubTaskSpec, index: number): NormalizedSubTaskSpec {
  const id = normalizeString(raw.id) || `sub-task-${index + 1}`;
  const task = normalizeString(raw.task);
  if (task.length === 0) {
    throw new Error(`Sub-task '${id}' is missing task instructions.`);
  }

  const tools = normalizeStringList(raw.tools);
  if (tools.length === 0) {
    throw new Error(`Sub-task '${id}' must declare at least one tool.`);
  }

  return {
    id,
    task,
    tools,
    provider: normalizeString(raw.provider) || undefined,
    model: normalizeString(raw.model) || undefined,
    reasoning_effort: raw.reasoning_effort,
    depends_on: normalizeStringList(raw.depends_on),
    output_schema: raw.output_schema,
    constraints: normalizeStringList(raw.constraints),
    success_criteria: normalizeStringList(raw.success_criteria),
    must_answer: normalizeStringList(raw.must_answer),
    comparison_axes: normalizeStringList(raw.comparison_axes),
    required_fields: normalizeStringList(raw.required_fields),
  };
}

function toFailureResult(id: string, error: unknown): SubAgentResult {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut =
    (error instanceof Error && (
      "timedOut" in error
      || /timed?\s*out|timeout/iu.test(error.message)
    ))
    || /timed?\s*out|timeout/iu.test(message);

  return {
    id,
    status: timedOut ? "timeout" : "failed",
    output: "",
    tool_calls: [],
    duration_ms: 0,
    error: message,
  };
}

export function createSubAgentBatchBudgetState(): SubAgentBatchBudgetState {
  return {
    roundsUsed: 0,
    totalSubAgents: 0,
  };
}

export async function runSubAgentBatch(
  input: SpawnSubAgentsInput,
  options: RunSubAgentBatchOptions,
): Promise<SpawnSubAgentsOutput> {
  const rawTasks = Array.isArray(input.sub_tasks) ? input.sub_tasks : [];
  if (rawTasks.length === 0) {
    throw new Error("spawn_sub_agents requires at least one sub-task.");
  }

  const tasks = rawTasks.map((task, index) => normalizeTaskSpec(task, index));
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new Error(`spawn_sub_agents received duplicate sub-task id '${task.id}'.`);
    }
    taskIds.add(task.id);
  }

  const budget = options.budget ?? createSubAgentBatchBudgetState();
  const maxRounds = clampInt(input.max_rounds, 1, options.maxRounds ?? 2, options.maxRounds ?? 2);
  const maxTotalSubAgents = Math.max(1, options.maxTotalSubAgents ?? 12);

  if (budget.roundsUsed >= maxRounds) {
    throw new Error(`spawn_sub_agents exceeded the round limit (${maxRounds}).`);
  }
  if ((budget.totalSubAgents + tasks.length) > maxTotalSubAgents) {
    throw new Error(
      `spawn_sub_agents exceeded the total sub-agent cap (${maxTotalSubAgents}). ` +
      `requested=${tasks.length} already_used=${budget.totalSubAgents}`,
    );
  }

  budget.roundsUsed += 1;
  budget.totalSubAgents += tasks.length;

  const round = budget.roundsUsed;
  const concurrency = clampInt(
    input.concurrency,
    1,
    options.concurrencyMax ?? 5,
    options.defaultConcurrency ?? 3,
  );
  const timeoutSeconds = clampInt(
    input.timeout_seconds,
    10,
    options.timeoutSecondsMax ?? 300,
    options.defaultTimeoutSeconds ?? 90,
  );

  const startedAt = Date.now();
  const results: Array<SubAgentResult | undefined> = new Array(tasks.length);
  const indexById = new Map(tasks.map((task, index) => [task.id, index] as const));
  const started = new Array(tasks.length).fill(false);
  let activeCount = 0;
  let completedCount = 0;

  const isDependencySatisfied = (task: NormalizedSubTaskSpec): {
    ready: boolean;
    failure?: string;
  } => {
    for (const dependencyId of task.depends_on) {
      const dependencyIndex = indexById.get(dependencyId);
      if (dependencyIndex === undefined) {
        return {
          ready: true,
          failure: `Dependency '${dependencyId}' is not part of this batch.`,
        };
      }
      const dependencyResult = results[dependencyIndex];
      if (!dependencyResult) {
        return { ready: false };
      }
      if (dependencyResult.status !== "completed") {
        return {
          ready: true,
          failure: `Dependency '${dependencyId}' did not complete successfully.`,
        };
      }
    }
    return { ready: true };
  };

  await new Promise<void>((resolve) => {
    let settled = false;

    const maybeResolve = () => {
      if (!settled && completedCount >= tasks.length) {
        settled = true;
        resolve();
      }
    };

    const markBlockedTasks = () => {
      let changed = false;
      for (const [index, task] of tasks.entries()) {
        if (started[index]) continue;
        const dependencyState = isDependencySatisfied(task);
        if (!dependencyState.ready || !dependencyState.failure) continue;
        started[index] = true;
        results[index] = {
          id: task.id,
          status: "failed",
          output: "",
          tool_calls: [],
          duration_ms: 0,
          error: dependencyState.failure,
        };
        completedCount += 1;
        changed = true;
      }
      return changed;
    };

    const nextRunnableIndex = (): number => {
      for (const [index, task] of tasks.entries()) {
        if (started[index]) continue;
        const dependencyState = isDependencySatisfied(task);
        if (!dependencyState.ready || dependencyState.failure) continue;
        return index;
      }
      return -1;
    };

    const schedule = () => {
      if (markBlockedTasks()) {
        maybeResolve();
      }

      while (activeCount < concurrency) {
        const index = nextRunnableIndex();
        if (index === -1) break;

        const task = tasks[index]!;
        started[index] = true;
        activeCount += 1;

        void options.executeSubTask(task, {
          round,
          timeoutSeconds,
        })
          .then((result) => {
            results[index] = {
              ...result,
              id: task.id,
            };
          })
          .catch((error) => {
            results[index] = toFailureResult(task.id, error);
          })
          .finally(() => {
            activeCount -= 1;
            completedCount += 1;
            maybeResolve();
            schedule();
          });
      }

      maybeResolve();
    };

    schedule();
  });

  const finalized = results.map((result, index) =>
    result ?? {
      id: tasks[index]!.id,
      status: "failed" as const,
      output: "",
      tool_calls: [],
      duration_ms: 0,
      error: "Sub-agent did not produce a result.",
    },
  );

  return {
    results: finalized,
    total_duration_ms: Date.now() - startedAt,
    cost_estimate_usd: finalized.reduce((total, result) => total + (result.cost_estimate_usd ?? 0), 0),
  };
}
