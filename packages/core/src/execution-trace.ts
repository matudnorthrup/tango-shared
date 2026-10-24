function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function sanitizeExecutionTraceValue(value: unknown, depth = 0): unknown {
  if (depth >= 6) return "[truncated]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeExecutionTraceValue(item, depth + 1));
  }

  const record = asRecord(value);
  if (!record) {
    return String(value);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 24)) {
    sanitized[key] = sanitizeExecutionTraceValue(item, depth + 1);
  }
  return sanitized;
}

export function extractExecutionTrace(raw: unknown): Record<string, unknown> | null {
  const payload = asRecord(raw);
  if (!payload) return null;

  const candidate = asRecord(payload.execution_trace ?? payload.executionTrace);
  if (!candidate) return null;

  const sanitized = sanitizeExecutionTraceValue(candidate);
  return asRecord(sanitized);
}

export function formatExecutionTraceForLog(trace: unknown): string | null {
  const record = asRecord(trace);
  if (!record) return null;

  const parts: string[] = [];
  const flow = record.flow;
  if (typeof flow === "string" && flow.trim().length > 0) {
    parts.push(`flow=${flow.trim()}`);
  }

  const planner = asRecord(record.planner);
  if (planner) {
    const plannerRuntime = asRecord(planner.runtime);
    const plannerMode = planner.mode;
    const plannerProvider = plannerRuntime?.providerName;
    if (typeof plannerMode === "string" && plannerMode.trim().length > 0) {
      parts.push(
        `plan=${plannerMode.trim()}${typeof plannerProvider === "string" && plannerProvider.trim().length > 0 ? `:${plannerProvider.trim()}` : ""}`,
      );
    }
    const operations = planner.operations;
    if (Array.isArray(operations) && operations.length > 0) {
      parts.push(`ops=${operations.length}`);
    }
  }

  const workflow = asRecord(record.workflow);
  if (workflow) {
    const workflowId = workflow.id;
    if (typeof workflowId === "string" && workflowId.trim().length > 0) {
      parts.push(`workflow=${workflowId.trim()}`);
    }
    const workerId = workflow.workerId;
    if (typeof workerId === "string" && workerId.trim().length > 0) {
      parts.push(`worker=${workerId.trim()}`);
    }
    const workflowRuntime = asRecord(workflow.runtime);
    const runtimeMode = workflowRuntime?.mode;
    const runtimeProvider = workflowRuntime?.providerName;
    if (typeof runtimeMode === "string" && runtimeMode.trim().length > 0) {
      parts.push(
        `route=${runtimeMode.trim()}${typeof runtimeProvider === "string" && runtimeProvider.trim().length > 0 ? `:${runtimeProvider.trim()}` : ""}`,
      );
    }
    const argumentResolution = asRecord(workflow.argumentResolution);
    const argumentMode = argumentResolution?.mode;
    const argumentProvider = argumentResolution?.providerName;
    if (typeof argumentMode === "string" && argumentMode.trim().length > 0) {
      parts.push(
        `argres=${argumentMode.trim()}${typeof argumentProvider === "string" && argumentProvider.trim().length > 0 ? `:${argumentProvider.trim()}` : ""}`,
      );
    }
  }

  const worker = asRecord(record.worker);
  if (worker) {
    const workerId = worker.id;
    if (typeof workerId === "string" && workerId.trim().length > 0) {
      parts.push(`worker=${workerId.trim()}`);
    }
    const selectionRuntime = asRecord(worker.runtime);
    const selectionMode = selectionRuntime?.mode;
    const selectionProvider = selectionRuntime?.providerName;
    if (typeof selectionMode === "string" && selectionMode.trim().length > 0) {
      parts.push(
        `select=${selectionMode.trim()}${typeof selectionProvider === "string" && selectionProvider.trim().length > 0 ? `:${selectionProvider.trim()}` : ""}`,
      );
    }
    const planRuntime = asRecord(worker.planRuntime);
    const planMode = planRuntime?.mode;
    const planProvider = planRuntime?.providerName;
    if (typeof planMode === "string" && planMode.trim().length > 0) {
      parts.push(
        `toolplan=${planMode.trim()}${typeof planProvider === "string" && planProvider.trim().length > 0 ? `:${planProvider.trim()}` : ""}`,
      );
    }
    const operations = Array.isArray(worker.operations) ? worker.operations : [];
    if (operations.length > 0) {
      parts.push(`ops=${operations.length}`);
    }
  }

  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const toolNames = new Set<string>();
  for (const item of toolCalls) {
    const toolCall = asRecord(item);
    if (!toolCall) continue;
    const rawNames = Array.isArray(toolCall.toolNames) ? toolCall.toolNames : [];
    for (const rawName of rawNames) {
      if (typeof rawName !== "string" || rawName.trim().length === 0) continue;
      toolNames.add(rawName.trim());
    }
  }
  if (toolNames.size > 0) {
    parts.push(`tools=${[...toolNames].join(",")}`);
  }

  const synthesis = asRecord(record.synthesis);
  if (synthesis) {
    const mode = synthesis.mode;
    const providerName = synthesis.providerName;
    if (typeof mode === "string" && mode.trim().length > 0) {
      parts.push(
        `synthesis=${mode.trim()}${typeof providerName === "string" && providerName.trim().length > 0 ? `:${providerName.trim()}` : ""}`,
      );
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}
