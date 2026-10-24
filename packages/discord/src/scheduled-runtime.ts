import {
  ClaudeCodeAdapter,
  LoomRuntimeAdapter,
  OllamaRuntimeAdapter,
  selectRuntimeBackend,
  type AgentRuntime,
  type AgentRuntimeConfig,
  type ChatProvider,
  type LoomSessionStore,
} from "@tango/core";

/** Each invocation owns one stateless run; no provider session survives it. */
export function createScheduledRuntime(
  config: AgentRuntimeConfig,
  ollamaProvider: ChatProvider,
  schedule: { id: string; displayName?: string },
): AgentRuntime {
  const backend = selectRuntimeBackend(config, { scheduled: true });
  if (backend === "ollama") return new OllamaRuntimeAdapter(ollamaProvider, config);
  if (backend === "loom") {
    let session: ReturnType<LoomSessionStore["getProviderSession"]> = null;
    const store: LoomSessionStore = {
      getProviderSession: () => session,
      upsertProviderSession: (record) => {
        const now = new Date().toISOString();
        session = { ...record, createdAt: now, updatedAt: now };
      },
      clearProviderSession: () => {
        const existed = session !== null;
        session = null;
        return existed;
      },
      upsertSession: () => {},
      insertLoomDelivery: () => {},
      listPendingLoomDeliveries: () => [],
    };
    return new LoomRuntimeAdapter({
      conversationKey: `schedule:${schedule.id}:${Date.now()}`,
      store,
      kind: "tango-job",
      title: schedule.displayName || schedule.id,
    });
  }
  return new ClaudeCodeAdapter();
}
