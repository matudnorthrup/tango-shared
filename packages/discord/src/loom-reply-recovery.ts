import type { AgentConfig } from "@tango/core";
import { evaluateAccess, resolveAccessPolicy, type AccessPolicy, type AccessEvaluationInput } from "./access-control.js";
import { loomRunResponse, liveLoomDeliveries, type LoomDelivery, type LoomThreadDetail, type RuntimeResponse, type TangoStorage, type ModelRunInsertInput } from "@tango/core";

export const LOOM_FAILURE_NOTICE = "Something went wrong processing your message. Please try again.";
export const LOOM_PENDING_NOTICE = "Your message is still queued or running. I’ll deliver the answer here when it finishes; you don’t need to retry.";

/** A retry notice reveals pending agent activity, so apply that agent's full policy first. */
export async function sendPendingLoomRetryNotice(options: {
  agent: AgentConfig | undefined;
  defaults: AccessPolicy;
  access: AccessEvaluationInput;
  send: (text: string) => Promise<unknown>;
}): Promise<void> {
  if (!options.agent || !evaluateAccess(options.access, resolveAccessPolicy(options.agent, options.defaults)).allowed) return;
  await options.send(LOOM_PENDING_NOTICE);
}

/** Check on receipt, before channel serialization: a retry may otherwise wait behind the answer and start fresh. */
export function pendingLoomRetry(records: LoomDelivery[], destination: string | { conversationKey: string }, text: string): LoomDelivery | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!normalized) return undefined;
  return records.find(record => (typeof destination === "string"
    ? (record.threadId ?? record.channelId) === destination
    : record.conversationKey === destination.conversationKey) && (
    /^(?:please )?(?:continue|retry|try again)(?: please)?$/.test(normalized)
    || record.context.retryText?.trim().toLowerCase().replace(/[.!?]+$/, "") === normalized
  ));
}

type Store = Pick<TangoStorage, "listPendingLoomDeliveries" | "claimLoomDelivery" | "finishLoomDelivery">;

/** Persist before acknowledging Loom: either side may restart between these writes. */
export async function registerDecisionDeliveries(options: {
  store: Pick<TangoStorage, "latestLoomDelivery" | "insertLoomDelivery">;
  read: () => Promise<Array<{ runId: string; loomThreadId: string; prompt: string; createdAt: number }>>;
  acknowledge: (runId: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<void> {
  for (const wake of await options.read()) {
    try {
      const route = options.store.latestLoomDelivery(wake.loomThreadId);
      if (!route) {
        options.log?.(`Decision reply run=${wake.runId}: waiting for bot delivery route`);
        continue;
      }
      const occurredAt = new Date(wake.createdAt).toISOString();
      options.store.insertLoomDelivery({ ...route, runId: wake.runId, messageId: "", createdAt: occurredAt,
        context: { ...route.context, prompt: wake.prompt, occurredAt, requestMessageId: null } });
      await options.acknowledge(wake.runId);
    } catch (error) {
      options.log?.(`Decision reply registration run=${wake.runId}: ${String(error)}`);
    }
  }
}

/** Durable claims favor at-most-once posting, including after a process crash. */
export async function recoverLoomReplies(options: {
  store: Store;
  readThread: (id: string) => Promise<LoomThreadDetail>;
  deliver: (record: LoomDelivery, response: RuntimeResponse) => Promise<void>;
  now?: number;
  log?: (message: string) => void;
}): Promise<void> {
  if (process.env.TANGO_LOOM_RECOVER_REPLIES === "off") return;
  for (const record of options.store.listPendingLoomDeliveries()) {
    if (liveLoomDeliveries.has(record.runId)) continue;
    try {
      const detail = await options.readThread(record.loomThreadId);
      if (liveLoomDeliveries.has(record.runId)) continue;
      const run = detail.runs.find(run => run.id === record.runId);
      const failed = ["failed", "interrupted", "canceled", "cancelled"].includes(run?.status ?? "");
      if (run?.status !== "completed" && !failed) {
        if (!run && (options.now ?? Date.now()) - Date.parse(record.createdAt) > 86_400_000) {
          options.store.finishLoomDelivery(record.runId, "abandoned");
          options.log?.(`Abandoned Loom reply run=${record.runId}: no terminal run after 24h`);
        }
        continue;
      }
      if (!options.store.claimLoomDelivery(record.runId)) continue;
      const durationMs = run?.started_at != null && run.ended_at != null ? Math.max(0, run.ended_at - run.started_at) : 0;
      const response = loomRunResponse(detail, record.runId, record.loomThreadId, durationMs, record.context.model);
      if (failed) { response.text = LOOM_FAILURE_NOTICE; response.metadata = { ...response.metadata, error: true }; }
      await options.deliver(record, response);
      options.store.finishLoomDelivery(record.runId, "delivered");
    } catch (error) {
      options.log?.(`Loom reply recovery run=${record.runId}: ${String(error)}`);
    }
  }
}

/** Primary turn telemetry; the post-turn hook records only its own reconciler call. */
export function recoveredLoomModelRun(record: LoomDelivery, response: RuntimeResponse, responseMessageId: number | null): ModelRunInsertInput {
  const isError = response.metadata?.error === true;
  return {
    sessionId: record.context.sessionId, agentId: record.agentId, providerName: "loom",
    conversationKey: record.conversationKey, providerSessionId: record.loomThreadId,
    model: response.model, latencyMs: response.durationMs, isError,
    errorMessage: isError ? LOOM_FAILURE_NOTICE : null,
    requestMessageId: record.context.requestMessageId, responseMessageId,
    metadata: { loomRunId: record.runId, runtimePath: "v2" },
  };
}
