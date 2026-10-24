import type { AgentRuntime, AgentRuntimeConfig } from "./agent-runtime.js";
import { LoomRuntimeAdapter, type LoomSessionStore } from "./loom-runtime-adapter.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { OllamaRuntimeAdapter } from "./ollama-runtime-adapter.js";
import type { ChatProvider } from "./provider.js";

/** Shared backend policy for conversations and stateless scheduled turns. */
export function selectRuntimeBackend(
  config: Pick<AgentRuntimeConfig, "backend" | "isolated">,
  options: { scheduled?: boolean } = {},
): NonNullable<AgentRuntimeConfig["backend"]> {
  if (config.backend === "ollama") return "ollama";
  if (config.backend === "loom"
    && process.env.TANGO_LOOM_AGENTS !== "off"
    && !(config.isolated && process.env.TANGO_LOOM_ISOLATED === "off")
    && !(options.scheduled && process.env.TANGO_LOOM_SCHEDULES === "off")) return "loom";
  return "claude-code";
}

export interface RuntimePoolOptions {
  /** Lazily resolves SQLite storage, including routers constructed before storage startup. */
  loomSessionStore?: () => LoomSessionStore;
  /**
   * Stateless chat provider used to back runtimes whose config requests the
   * "ollama" backend. Required for those agents; omit it when no v2 agent is
   * configured for Ollama. Construction throws if a turn needs it but it is
   * absent, so a misconfiguration fails loudly rather than silently using
   * Claude.
   */
  ollamaProvider?: ChatProvider;
}

export class RuntimePool {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly pendingCreates = new Map<string, Promise<AgentRuntime>>();
  private readonly ollamaProvider?: ChatProvider;

  private readonly loomSessionStore?: () => LoomSessionStore;

  constructor(options: RuntimePoolOptions = {}) {
    this.ollamaProvider = options.ollamaProvider;
    this.loomSessionStore = options.loomSessionStore;
  }

  async getOrCreate(conversationKey: string, config: AgentRuntimeConfig): Promise<AgentRuntime> {
    const existing = this.runtimes.get(conversationKey);
    if (existing) {
      return existing;
    }

    const pending = this.pendingCreates.get(conversationKey);
    if (pending) {
      return await pending;
    }

    const creation = (async () => {
      const runtime = this.createRuntime(config, conversationKey);
      await runtime.initialize(config);
      this.runtimes.set(conversationKey, runtime);
      return runtime;
    })();

    this.pendingCreates.set(conversationKey, creation);

    try {
      return await creation;
    } finally {
      this.pendingCreates.delete(conversationKey);
    }
  }

  private createRuntime(config: AgentRuntimeConfig, conversationKey: string): AgentRuntime {
    const backend = selectRuntimeBackend(config);
    if (backend === "loom") {
      if (!this.loomSessionStore) throw new Error("Loom requires a persistent session store.");
      return new LoomRuntimeAdapter({ conversationKey, store: this.loomSessionStore() });
    }
    if (backend === "ollama") {
      if (!this.ollamaProvider) {
        throw new Error(
          `Agent '${config.agentId}' requests the ollama backend but no ollamaProvider was supplied to RuntimePool.`,
        );
      }
      return new OllamaRuntimeAdapter(this.ollamaProvider, config);
    }

    return new ClaudeCodeAdapter();
  }

  resetSession(conversationKey: string, config: AgentRuntimeConfig): void {
    const runtime = this.runtimes.get(conversationKey);
    if (runtime instanceof LoomRuntimeAdapter) runtime.resetSession();
    else if (config.backend === "loom" && this.loomSessionStore) {
      // Both mappings: an isolated agent's thread is keyed apart (see LoomRuntimeAdapter.key), and a reset while
      // it runs on the CLI (a kill switch) must still start fresh when Loom comes back.
      const store = this.loomSessionStore();
      store.clearProviderSession(JSON.stringify([config.agentId, conversationKey]), "loom");
      store.clearProviderSession(JSON.stringify([config.agentId, conversationKey, "isolated"]), "loom");
    }
  }

  get(conversationKey: string): AgentRuntime | undefined {
    return this.runtimes.get(conversationKey);
  }

  async close(conversationKey: string): Promise<void> {
    const pending = this.pendingCreates.get(conversationKey);
    if (pending) {
      await pending;
    }

    const runtime = this.runtimes.get(conversationKey);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(conversationKey);
    await runtime.teardown();
  }

  async closeAll(): Promise<void> {
    const pendingCreates = [...this.pendingCreates.values()];
    if (pendingCreates.length > 0) {
      await Promise.all(pendingCreates);
    }

    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();

    const results = await Promise.allSettled(entries.map(async ([, runtime]) => {
      await runtime.teardown();
    }));

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close one or more runtimes.");
    }
  }

  keys(): string[] {
    return [...this.runtimes.keys()];
  }

  get size(): number {
    return this.runtimes.size;
  }
}
