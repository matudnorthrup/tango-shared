import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeAbortedError, type AgentRuntime, type AgentRuntimeConfig, type RuntimeResponse, type SendOptions } from "./agent-runtime.js";
import { ClaudeCodeTimeoutError, resolveIsolatedAgentWorkDir } from "./claude-code-adapter.js";
import { describeToolUse, emitRuntimeTurnEvent } from "./runtime-activity.js";
import type { TangoStorage } from "./storage.js";

export type LoomSessionStore = Pick<TangoStorage, "getProviderSession" | "upsertProviderSession" | "clearProviderSession" | "upsertSession" | "insertLoomDelivery" | "listPendingLoomDeliveries">;
export interface LoomRuntimeAdapterOptions {
  conversationKey: string;
  kind?: "tango-agent" | "tango-job";
  title?: string;
  store: LoomSessionStore;
  cwd?: string;
  repoRoot?: string;
  port?: number;
  tokenFile?: string;
  pollMs?: number;
}
interface Item { id: string; run_id: string; name: string; input: unknown; output?: unknown; status: string }
export interface LoomThreadDetail {
  runs: Array<{ id: string; status: string; failure?: unknown; started_at?: number | null; ended_at?: number | null }>;
  messages: Array<{ run_id: string; role: string; text: string }>;
  items: Item[];
}
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function inputOf(value: unknown): Record<string, unknown> {
  const parsed = decoded(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
export function loomFailureError(raw: unknown): Error {
  const failure = inputOf(raw);
  const prefix: Record<string, string> = { usage_limit: "Usage limit reached", auth: "Authentication failed: authentication_error", overloaded: "Overloaded", crashed: "Loom run crashed", other: "Loom run failed" };
  if (failure.kind === "interrupted") return new RuntimeAbortedError();
  return new Error(`${prefix[String(failure.kind)] ?? "Loom run failed"}: ${String(failure.message ?? failure.kind ?? "unknown")}`);
}

/** Observation ended, but Loom still owns this durable delivery. Never trigger provider fallback. */
export class LoomPendingError extends Error {
  constructor(readonly runId: string, readonly status: string = "pending") {
    super(`Loom reply is ${status}; delivery will continue in the background.`);
    this.name = "LoomPendingError";
  }
}

/** A turn observer; teardown detaches without interrupting Loom's hosted run. */
export class LoomRuntimeAdapter implements AgentRuntime {
  readonly id = randomUUID();
  readonly type = "loom" as const;
  private config?: AgentRuntimeConfig;
  private threadId?: string;
  private runId?: string;
  private aborted = false;
  private busy = false;
  constructor(private readonly options: LoomRuntimeAdapterOptions) {}
  get active(): boolean { return this.busy; }
  private get key(): string { return JSON.stringify([this.config!.agentId, this.options.conversationKey, ...(this.config!.isolated ? ["isolated"] : [])]); }
  async initialize(config: AgentRuntimeConfig): Promise<void> {
    this.config = structuredClone(config);
    this.threadId = this.options.store.getProviderSession(this.key, "loom")?.providerSessionId;
  }
  getSessionId(): string | undefined { return this.threadId; }
  resumeSession(id: string): void { this.threadId = id; }
  resetSession(): void {
    this.options.store.clearProviderSession(this.key, "loom");
    this.threadId = undefined;
  }
  async teardown(): Promise<void> { /* Loom owns the run, including across bot shutdown. */ }
  async healthCheck(): Promise<boolean> {
    try { await readFile(this.tokenFile, "utf8"); return true; } catch { return false; }
  }
  private get tokenFile(): string {
    return this.options.tokenFile ?? path.join(process.env.LOOM_HOME ?? path.join(os.homedir(), ".tango", "loom"), "token");
  }
  private async request(route: string, body?: unknown, timeoutMs = 10_000): Promise<any> {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:${this.options.port ?? process.env.LOOM_PORT ?? 9420}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const result = await response.json() as any;
    if (!response.ok || result.ok === false) throw loomFailureError({ kind: result.code, message: result.message ?? `HTTP ${response.status}` });
    return result;
  }
  async readDecisionDeliveries(): Promise<Array<{ runId: string; loomThreadId: string; prompt: string; createdAt: number }>> {
    return (await this.request("/decision-deliveries")).deliveries;
  }
  async acknowledgeDecisionDelivery(runId: string): Promise<void> {
    await this.request(`/decision-deliveries/${encodeURIComponent(runId)}/ack`, {});
  }
  async readThread(id: string): Promise<LoomThreadDetail> {
    return this.request(`/threads/${encodeURIComponent(id)}`);
  }
  private async interrupt(): Promise<void> {
    if (this.threadId && this.runId) await this.request("/commands", { type: "interrupt", commandId: randomUUID(), threadId: this.threadId, runId: this.runId });
  }
  abortActiveRun(): boolean {
    // Foreground observation may have detached while Loom still owns tool execution.
    // Resolve persisted deliveries so a recreated adapter can stop those runs too.
    const pending = this.options.store.listPendingLoomDeliveries().filter(record =>
      record.agentId === this.config?.agentId && record.conversationKey === this.options.conversationKey
      && record.loomThreadId === this.threadId && record.runId !== this.runId);
    if (!this.busy && pending.length === 0) return false;
    this.aborted = true;
    void this.interrupt().catch(() => {});
    for (const record of pending) {
      void this.request("/commands", { type: "interrupt", commandId: randomUUID(),
        threadId: record.loomThreadId, runId: record.runId }).catch(() => {});
    }
    return true;
  }
  async send(message: string, options: SendOptions = {}): Promise<RuntimeResponse> {
    if (!this.config) throw new Error("Loom runtime not initialized.");
    if (this.busy) throw new Error("Loom runtime already running.");
    this.busy = true;
    this.aborted = false;
    const started = Date.now();
    const configuredTimeout = options.timeout ?? this.config.runtimePreferences.timeout ?? 900_000;
    // A durable Discord turn needs only a short foreground observation window; recovery owns the late answer.
    const recoverable = !!options.discordDelivery && process.env.TANGO_LOOM_RECOVER_REPLIES !== "off";
    const timeout = recoverable ? Math.min(configuredTimeout || 30_000, 30_000) : configuredTimeout;
    let pendingStatus = "queued";
    let durable = false;
    const remaining = () => timeout === 0 ? 10_000 : Math.max(1, timeout - (Date.now() - started));
    try {
      const root = this.options.repoRoot ?? process.env.TANGO_REPO_DIR ?? process.cwd();
      const expand = (value: string) => value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
      const anchor = (value: string) => !path.isAbsolute(value) && !value.startsWith("-") && (value.startsWith(".") || value.includes("/")) && !value.includes("://") ? path.resolve(root, value) : value;
      // Parity with the CLI adapter: Tango owns agent memory, so Claude Code's own auto-memory stays off.
      const env: Record<string, string> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
      for (const name of this.config.isolated ? [] : ["TANGO_PROFILE", "TANGO_REPO_DIR"]) if (process.env[name] !== undefined) env[name] = process.env[name]!;
      const mcpServers = Object.fromEntries(this.config.mcpServers.map(({ name, ...server }) => {
        for (const [key, value] of Object.entries(server.env ?? {})) env[key] = expand(value);
        return [name, { ...server, ...(server.command ? { command: anchor(server.command) } : {}), ...(server.args ? { args: server.args.map(anchor) } : {}), ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([k,v]) => [k, expand(v)])) } : {}), ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).map(([k,v]) => [k, expand(v)])) } : {}) }];
      }));
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
      const fresh = !this.threadId;
      const cwd = this.config.isolated ? resolveIsolatedAgentWorkDir(this.config.agentId) : this.options.cwd ?? process.cwd();
      if (this.config.isolated) await mkdir(cwd, { recursive: true });
      const command = {
        type: "submit", commandId: options.discordDelivery ? `discord:${options.discordDelivery.messageId}` : randomUUID(), provider: "claude",
        text: [options.currentTurnMetadataPrompt, options.turnBriefingPrompt, message].filter(Boolean).join("\n\n"),
        // Personal agents stay on the personal plan unless configured otherwise (the routing default for non-work repos).
        ...(fresh ? { cwd, title: this.options.title ?? this.config.agentId, kind: this.options.kind ?? "tango-agent", accounts: (process.env.TANGO_LOOM_ACCOUNTS ?? "personal").split(",").map((a) => a.trim()).filter(Boolean) } : { threadId: this.threadId }),
        session: { system: this.config.systemPrompt, mcpServers, model: this.config.runtimePreferences.model, effort: this.config.runtimePreferences.reasoningEffort, settingSources: this.config.isolated ? [] : ["user", "project", "local"], tools: this.config.isolated ? "none" : "default", ...(this.config.isolated ? { loomTools: false } : {}), env },
        ...(fresh && (options.context || this.config.coldStartContext) ? { context: [this.config.coldStartContext, options.context].filter(Boolean).join("\n\n") } : {}),
      };
      let result;
      try {
        result = await this.request("/commands", command, remaining());
      } catch (error) {
        if (!options.discordDelivery) throw error;
        // Submit commits its receipt before opening the host. If that opening outlasts
        // our request, replay the same id to retrieve the receipt without another run.
        // This lookup has its own budget: the foreground deadline may already be spent.
        result = await this.request("/commands", command);
      }
      this.threadId = result.result.threadId;
      this.runId = result.result.runId;
      this.options.store.upsertSession({ id: `loom:${this.key}`, type: "persistent", agent: this.config.agentId, channels: [] });
      this.options.store.upsertProviderSession({ conversationKey: this.key, sessionId: `loom:${this.key}`, agentId: this.config.agentId, providerName: "loom", providerSessionId: this.threadId! });
      if (options.discordDelivery) {
        // Persist first: ownership moves to the caller only once startup recovery could also find this run.
        this.options.store.insertLoomDelivery({ ...options.discordDelivery, context: { ...options.discordDelivery.context, model: this.config.runtimePreferences.model }, runId: this.runId!,
          agentId: this.config.agentId, conversationKey: this.options.conversationKey,
          loomThreadId: this.threadId!, createdAt: new Date().toISOString() });
        durable = true;
        liveLoomDeliveries.add(this.runId!);
        options.onLoomSubmitted?.(this.runId!);
      }
      const seen = new Set<string>();
      while (true) {
        if (this.aborted) throw new RuntimeAbortedError();
        if (timeout > 0 && Date.now() - started >= timeout) {
          if (recoverable) throw new LoomPendingError(this.runId!, pendingStatus);
          throw new ClaudeCodeTimeoutError(timeout, false);
        }
        const detail: LoomThreadDetail = await this.request(`/threads/${encodeURIComponent(this.threadId!)}`, undefined, remaining());
        const items = (detail.items ?? []).filter(item => item.run_id === this.runId);
        for (const item of items) if (!seen.has(item.id)) {
          seen.add(item.id);
          emitRuntimeTurnEvent(options.onEvent, { type: "tool_use", name: item.name, activity: describeToolUse(item.name, inputOf(item.input)), at: Date.now() });
        }
        const run = detail.runs.find(run => run.id === this.runId);
        if (run?.status === "completed") {
          return loomRunResponse(detail, this.runId!, this.threadId!, Date.now() - started, this.config.runtimePreferences.model);
        }
        pendingStatus = run?.status ?? "pending";
        if (run?.status === "failed" || run?.status === "interrupted") throw loomFailureError(run.failure ?? { kind: run.status });
        // Stopping the Loom thread cancels its queued and running runs: that ends this turn now, as a stop.
        if (run?.status === "canceled" || run?.status === "cancelled") throw loomFailureError({ kind: "interrupted" });
        await new Promise(resolve => setTimeout(resolve, Math.min(this.options.pollMs ?? 750, remaining())));
      }
    } catch (error) {
      // Once persisted, transport failures and observer deadlines cannot cancel or fail the hosted turn.
      // Recovery also owns terminal failures, avoiding a competing stateless fallback answer.
      if (recoverable && durable && this.runId && !(error instanceof RuntimeAbortedError)) {
        throw new LoomPendingError(this.runId, pendingStatus);
      }
      if (error instanceof ClaudeCodeTimeoutError || (timeout > 0 && Date.now() - started >= timeout)) {
        await this.interrupt().catch(() => {});
        throw new ClaudeCodeTimeoutError(timeout, false);
      }
      throw error;
    } finally { this.busy = false; this.runId = undefined; }
  }
}

/** Held until Discord presentation completes, not merely until polling ends. */
export const liveLoomDeliveries = new Set<string>();

/** A short message ahead of a long one in the same run is a progress note ("I'll check the manual."), as on the desk. */
const PROGRESS_NOTE = 200;
const LONG_MESSAGE = 600;

/**
 * Everything the agent said in the run. A tool call between two texts (an answer, then loom.handoff, then the
 * closing "Next —" line) splits the reply into messages, and the last one alone reads "as above" with nothing above.
 */
export function loomRunText(detail: LoomThreadDetail, runId: string): string {
  const texts = detail.messages.filter(m => m.run_id === runId && m.role === "assistant").map(m => m.text.trim()).filter(Boolean);
  return texts.filter((text, index) => text.length >= PROGRESS_NOTE || !texts.slice(index + 1).some(later => later.length >= LONG_MESSAGE)).join("\n\n");
}

export function loomRunResponse(detail: LoomThreadDetail, runId: string, threadId: string, durationMs = 0, model?: string): RuntimeResponse {
  const items = (detail.items ?? []).filter(item => item.run_id === runId);
  return {
    text: loomRunText(detail, runId),
    durationMs, model, toolsUsed: [...new Set(items.map(i => i.name))],
    toolCalls: items.map(i => ({ name: i.name, input: inputOf(i.input), output: decoded(i.output) })),
    metadata: { sessionId: threadId, backend: "loom", loomRunId: runId },
  };
}
