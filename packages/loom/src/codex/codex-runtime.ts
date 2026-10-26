import { resourceRunContext } from "../resource-client.js";
import { LOOM_GUIDANCE, roleGuidance } from "../instructions.js";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnGroup, killGroup, type SpawnLedger } from "../proc.js";
import type { BackgroundTask, OpenSessionOptions, Runtime, RuntimeEmit, RuntimeFailure, RuntimeSession } from "../runtime.js";
import type { TurnImage } from "../attachments.js";
import { codexIncompatible, redactProfile } from "../session-profile.js";
import { loomCarry } from "../claude/claude-runtime.js";
import type { Envelope, Input, Item, Notification, Requests, TurnError } from "./protocol.js";

export interface CodexAccount { name: string; home: string }
export interface CodexRuntimeOptions {
  accounts: CodexAccount[];
  defaultAccount: string;
  ledger?: SpawnLedger;
  command?: string;
  args?: string[];
  carry?: (threadId: string) => Promise<string | null>;
}
const CREDENTIAL_ENV = /^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_ORGANIZATION|OPENAI_PROJECT_ID|CODEX_HOME)$/;
export function codexAccountEnv(account: CodexAccount, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined && !CREDENTIAL_ENV.test(entry[0]))), CODEX_HOME: account.home };
}
const milliseconds = (value?: number | null) => value == null ? undefined : value < 1e12 ? value * 1000 : value;
function resetTime(value: unknown): number | undefined {
  if (typeof value === "string") { try { return resetTime(JSON.parse(value)); } catch { return undefined; } }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (/^resets?_?at$/i.test(key)) {
      const time = typeof entry === "number" ? milliseconds(entry) : typeof entry === "string" ? Date.parse(entry) : undefined;
      if (time && Number.isFinite(time)) return time;
    }
    const nested = resetTime(entry);
    if (nested) return nested;
  }
  return undefined;
}
export function codexFailure(error: TurnError, resetAt?: number): RuntimeFailure {
  const message = error.message ?? "Codex request failed";
  const detail = `${message} ${JSON.stringify(error)}`;
  const kind = /usage.?limit|rate.?limit|quota|429|sessionBudgetExceeded/i.test(detail) ? "usage_limit"
    : /unauthorized|authentication|invalid.?api.?key|401|403/i.test(detail) ? "auth"
    : /overload|internalServerError|httpStatusCode["\s:]+5\d\d|\b50[0234]\b/i.test(detail) ? "overloaded" : "other";
  const reset = resetTime(error) ?? resetAt;
  return { kind, message, ...(kind === "usage_limit" && reset ? { resetAt: reset } : {}) };
}
const inputs = (text: string, images?: TurnImage[]): Input[] => [
  { type: "text", text, text_elements: [] },
  ...(images ?? []).map(image => ({ type: "image" as const, url: `data:${image.mimeType};base64,${image.data}` })),
];

/** Pauses between resume attempts. Tests shorten them. */
export const RESUME_RETRIES = [500, 2000, 5000];
/** The whole open (handshake, resume retries, carry) finishes inside budgetMs: the host waits 15s for its socket. */
export const STARTUP_LIMITS = { budgetMs: 12_000 };


export class CodexRuntime implements Runtime {
  constructor(private readonly options: CodexRuntimeOptions) {}
  async open(open: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession> {
    const account = this.options.accounts.find(a => a.name === (open.account ?? this.options.defaultAccount));
    if (!account) throw new Error(`Unknown Codex account "${open.account ?? this.options.defaultAccount}"`);
    const incompatible = codexIncompatible(open.session);
    if (incompatible) throw new Error(incompatible);
    const session = new CodexSession(this.options, account, open, event => {
      // Profile credentials can be echoed by tool errors as well as by model text.
      if ("text" in event) event = { ...event, text: redactProfile(event.text, open.session) };
      if (event.type === "tool.updated") event = { ...event, input: event.input === undefined ? undefined : redactProfile(event.input, open.session), output: event.output === undefined ? undefined : redactProfile(event.output, open.session) };
      if ("failure" in event && event.failure) event = { ...event, failure: { ...event.failure, message: redactProfile(event.failure.message, open.session) } };
      emit(event);
    });
    try { await session.initialize(); return session; }
    catch (error) { await session.close(); throw new Error(redactProfile(error instanceof Error ? error.message : String(error), open.session)); }
  }
}

class CodexSession implements RuntimeSession {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private nativeId = "";
  private runId: string | null = null;
  private turnId: string | null = null;
  private turnReady: Promise<void> = Promise.resolve();
  private carry: string | null = null;
  private resetAt?: number;
  private ended = false;
  private promotionRequested = false;
  private readonly autoGuard: boolean;
  private readonly autoPromote: boolean;
  private closing = false;
  private readonly env: Record<string, string>;
  private stderr = "";
  private openBy = 0;
  private secrets?: string;
  /** Subagents this thread spawned that are still running, by their Codex thread id. */
  private readonly subagents = new Map<string, BackgroundTask>();
  /** Every subagent thread spawned under this one: a child's own spawns report on the child's thread. */
  private readonly descendants = new Set<string>();

  constructor(private readonly options: CodexRuntimeOptions, account: CodexAccount, private readonly open: OpenSessionOptions, private readonly emit: RuntimeEmit) {
    this.autoGuard = open.kind === "coding" && open.worktreeMode === "auto";
    this.autoPromote = this.autoGuard && process.env.LOOM_AUTO_PROMOTE !== "off";
    const profile = open.session;
    const base = profile?.loomTools === false
      ? Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"].map(k => [k, process.env[k]])) : process.env;
    this.env = codexAccountEnv(account, { ...base, ...Object.fromEntries(Object.entries(profile?.env ?? {}).filter(([key]) => key !== "HOME")) });
    delete this.env.LOOM_RUN_ID;
    delete this.env.TANGO_DESK_ITEM;
    if (profile?.loomTools !== false) this.env.TANGO_DESK_ITEM = `loom:${open.threadId}`;
    const source = import.meta.url.endsWith(".ts");
    const script = (name: string) => [...(source ? ["--import", "tsx"] : []), fileURLToPath(new URL(`./${name}.${source ? "ts" : "js"}`, import.meta.url))];
    // A server's env goes in a private file its wrapper reads, so secrets sit in neither argv nor the app-server's env.
    const servers: Record<string, unknown> = Object.fromEntries(Object.entries(profile?.mcpServers ?? {}).filter(([name]) => name !== "loom").map(([name, server], index) => {
      const { env, command, args = [], ...rest } = server as { env?: Record<string, string>; command: string; args?: string[] };
      if (!env || !Object.keys(env).length) return [name, { ...rest, command, args }];
      this.secrets ??= mkdtempSync(join(tmpdir(), "loom-mcp-"));
      const file = join(this.secrets, `${index}-${name.replace(/[^\w-]/g, "_")}.json`);
      writeFileSync(file, JSON.stringify(env), { mode: 0o600 });
      return [name, { ...rest, command: process.execPath, args: [...script("mcp-env"), file, command, ...args] }];
    }));
    if (profile?.loomTools !== false) {
      servers.loom = { command: process.execPath, args: script("loom-mcp"), env: { LOOM_THREAD_ID: open.threadId, ...Object.fromEntries(Object.entries(this.env).filter(([k]) => /^(LOOM_(HOME|PORT|ACCOUNTS)|TANGO_(HOME|PROFILE|PROFILE_DIR))$/.test(k))) } };
    }
    const args = [...(options.args ?? []), "app-server", "-c", `mcp_servers=${toml(servers)}`];
    const ledger = options.ledger ?? { recordSpawn() {}, forgetSpawn() {} };
    // MCP config may contain credentials: record process ownership without its CLI overrides.
    const safeLedger: SpawnLedger = { recordSpawn: (pid, threadId, _command, started) => ledger.recordSpawn(pid, threadId, `${options.command ?? "codex"} app-server`, started), forgetSpawn: pid => ledger.forgetSpawn(pid) };
    this.child = spawnGroup(safeLedger, open.threadId, options.command ?? "codex", args, { cwd: open.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout! }).on("line", line => {
      try { this.receive(JSON.parse(line) as Envelope); }
      catch (error) { console.warn("[loom] Invalid Codex app-server message", redactProfile(String(error), profile)); }
    });
    this.child.stderr!.on("data", chunk => { this.stderr = (this.stderr + redactProfile(String(chunk), profile)).slice(-4000); });
    this.child.once("error", error => this.end(error.message));
    this.child.once("exit", (code, signal) => this.end(`Codex exited (${signal ?? code})${this.stderr ? `: ${this.stderr}` : ""}`));
    this.child.stdin!.on("error", error => this.end(error.message));
  }

  private left(): number { return Math.max(1, this.openBy - Date.now()); }

  async initialize(): Promise<void> {
    this.openBy = Date.now() + STARTUP_LIMITS.budgetMs;
    await this.request("initialize", { clientInfo: { name: "loom", version: "1.0.0" }, capabilities: null }, this.left());
    this.write({ method: "initialized", params: {} });
    const profile = this.open.session;
    // A request's developer instructions replace the configured ones, so Loom's go after them rather than over them.
    const configured = profile?.projectDocs === false ? "" : await this.request("config/read", { cwd: this.open.cwd }, this.left()).then(r => r?.config?.developer_instructions ?? "", () => "");
    const instructions = [configured, profile?.loomTools === false ? "" : LOOM_GUIDANCE, profile?.loomTools === false ? "" : roleGuidance(this.open.role), profile?.system, this.autoGuard ? (this.autoPromote
      ? "This Auto thread is read-only until it moves into its own worktree. When the first required file mutation is needed, request command escalation or file-change approval. Loom denies it and moves this same thread into a worktree; the next session continues there. Do not bypass the sandbox or mutate checkout files through external tools."
      : "Auto promotion is disabled. This thread must remain read-only; do not mutate checkout files through external tools.") : ""].filter(Boolean).join("\n\n");
    const params = {
      cwd: this.open.cwd, approvalPolicy: this.autoPromote ? "on-request" as const : "never" as const, sandbox: this.autoGuard ? "read-only" as const : profile?.sandbox ?? "danger-full-access" as const,
      ...(instructions ? { developerInstructions: instructions } : {}),
      ...(profile?.model && /^(gpt-|o[1-9](?:-|$)|codex-)/.test(profile.model) ? { model: profile.model } : {}),
      config: { ...(profile?.effort ? { model_reasoning_effort: profile.effort === "max" ? "xhigh" : profile.effort } : {}), ...(profile?.projectDocs === false ? { project_doc_max_bytes: 0 } : {}) },
    };
    // Codex keeps a thread's history under its account's CODEX_HOME, so a thread moved to another account can't
    // resume there: it starts a new Codex thread, and the carried state below gives it the thread's place.
    const result = this.open.nativeSessionId
      ? await this.resume(params, this.open.nativeSessionId).catch((error) => {
        // Only a transcript this account doesn't have starts over; any other failure keeps the history (the run fails
        // only after the retries in resume()).
        if (!/no rollout found/i.test(error instanceof Error ? error.message : String(error))) throw error;
        console.warn(`[loom] ${this.open.threadId} could not resume Codex thread ${this.open.nativeSessionId}; starting a new one: ${error instanceof Error ? error.message : error}`);
        return this.request("thread/start", params, this.left());
      })
      : await this.request("thread/start", params, this.left());
    this.nativeId = result.thread.id;
    this.emit({ type: "session.native", nativeSessionId: this.nativeId });
    // The carry is a nicety: one that would outlast the open is dropped rather than failing the run.
    if (profile?.loomTools !== false) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.left()); });
      this.carry = await Promise.race([(this.options.carry ?? loomCarry(this.env))(this.open.threadId).catch(() => null), late]);
      clearTimeout(timer);
    }
  }

  /** A resume that fails for a passing reason (busy state, a timeout) is tried again before the open gives up. */
  private async resume(params: Requests["thread/start"]["params"], threadId: string): Promise<Requests["thread/resume"]["result"]> {
    const deadline = this.openBy;
    for (let attempt = 0; ; attempt++) {
      try { return await this.request("thread/resume", { ...params, threadId }, Math.max(1, deadline - Date.now())); }
      catch (error) {
        const delay = RESUME_RETRIES[attempt];
        if (delay === undefined || Date.now() + delay >= deadline || /no rollout found/i.test(error instanceof Error ? error.message : String(error)) || this.ended) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  startTurn(run: { runId: string; text: string; images?: TurnImage[] }): void {
    if (this.ended) throw new Error("Codex session ended");
    if (this.runId) throw new Error("Codex turn already running");
    this.runId = run.runId;
    const slashCommand = /^\/[^\s/]+(\s|$)/.test(run.text);
    const text = slashCommand ? run.text : [this.carry, this.open.session?.loomTools === false ? "" : resourceRunContext(run.runId), run.text].filter(Boolean).join("\n\n");
    if (!slashCommand) this.carry = null;
    this.turnReady = this.request("turn/start", { threadId: this.nativeId, input: inputs(text, run.images) }).then(result => {
      if (this.runId === run.runId) this.turnId = result.turn.id;
    }).catch(error => { if (this.runId === run.runId) this.fail(codexFailure(error, this.resetAt)); });
  }
  async inject(text: string, images?: TurnImage[]): Promise<void> {
    await this.turnReady;
    if (!this.turnId || !this.runId) throw new Error("No Codex turn to steer");
    await this.request("turn/steer", { threadId: this.nativeId, expectedTurnId: this.turnId, input: inputs(text, images) });
  }
  async interrupt(): Promise<void> {
    await this.turnReady;
    if (this.turnId && this.runId) await this.request("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
  }
  respond(): void { throw new Error("Codex approvals are always denied; no pending request"); }
  async close(): Promise<void> {
    this.closing = true;
    if (this.ended) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { if (this.child.pid) killGroup(this.child.pid); resolve(); }, 2000);
      timer.unref();
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (this.child.pid) killGroup(this.child.pid, "SIGTERM");
    });
  }

  private request<M extends keyof Requests>(method: M, params: Requests[M]["params"], timeoutMs = 60_000): Promise<Requests[M]["result"]> {
    if (this.ended) return Promise.reject(new Error("Codex session ended"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: result => resolve(result as Requests[M]["result"]), reject, timer });
      this.write({ id, method, params });
    });
  }
  private write(message: unknown): void { this.child.stdin!.write(JSON.stringify(message) + "\n"); }
  private receive(message: Envelope): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? "Codex request failed"), message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      console.warn(`[loom] Declining unexpected Codex request: ${message.method}`);
      const method = message.method;
      const result = /^(execCommandApproval|applyPatchApproval)$/.test(method) ? { decision: "denied" }
        : /item\/(commandExecution|fileChange)\/requestApproval/.test(method) ? { decision: "decline" }
        : method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
        // On-request approval (Auto threads) asks before every MCP call; Loom's own tools stay usable.
        : method === "mcpServer/elicitation/request" && message.params?.serverName === "loom" ? { action: "accept", content: {}, _meta: null }
        : method === "mcpServer/elicitation/request" ? { action: "decline", content: null, _meta: null } : null;
      this.write(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      // App-server has no general pre-edit callback. Its sandbox denies writes; an
      // escalation request is the nearest safe signal, and is declined before promotion.
      const promotionRequest = /^(item\/(commandExecution|fileChange)\/requestApproval|execCommandApproval|applyPatchApproval)$/.test(method);
      const ownTurn = (!message.params?.threadId || message.params.threadId === this.nativeId)
        && (!message.params?.turnId || !this.turnId || message.params.turnId === this.turnId);
      if (this.autoPromote && promotionRequest && ownTurn && this.runId && !this.promotionRequested) {
        this.promotionRequested = true;
        this.emit({ type: "message.completed", runId: this.runId, text: "Moving this thread into its own worktree; your next session continues there." });
        this.emit({ type: "worktree.promote", runId: this.runId });
      }
      return;
    }
    this.notification(message.method ?? "", message.params ?? {});
  }
  private notification(method: string, p: Notification): void {
    const activity = method === "item/started" && p.item?.type === "subAgentActivity" && p.item.agentThreadId ? p.item : null;
    if (activity && (!p.threadId || p.threadId === this.nativeId || this.descendants.has(p.threadId))) { this.subagent(activity); return; }
    if (p.threadId && p.threadId !== this.nativeId) return;
    if (method === "account/rateLimits/updated" && p.rateLimits) {
      const windows = [p.rateLimits.primary, p.rateLimits.secondary].filter(w => w != null);
      // Only a window that is actually full cools the account until its reset. A "reached" flag with no full window
      // (spent workspace credits, a spend cap) has no window reset, so it rejects with none and gets the default cooldown.
      const exhausted = windows.filter(w => w.usedPercent >= 100);
      this.resetAt = exhausted.reduce<number | undefined>((latest, w) => Math.max(latest ?? 0, milliseconds(w.resetsAt) ?? 0) || undefined, undefined);
      for (const window of windows) {
        const resetsAt = milliseconds(window.resetsAt);
        const label = window.windowDurationMins != null ? (window.windowDurationMins <= 300 ? "five_hour" : "seven_day") : window === p.rateLimits.primary ? "five_hour" : "seven_day";
        this.emit({ type: "usage.observed", utilization: window.usedPercent / 100, resetsAt, window: label, ...(exhausted.includes(window) ? { status: "rejected" } : {}) });
      }
      if (!windows.length && p.rateLimits.rateLimitReachedType) this.emit({ type: "usage.observed", status: "rejected" });
      return;
    }
    if (!this.runId || (this.turnId && p.turnId && p.turnId !== this.turnId)) return;
    const runId = this.runId;
    if (method === "turn/started" && p.turn) this.turnId = p.turn.id;
    if (method === "item/agentMessage/delta") this.emit({ type: "message.delta", runId, text: p.delta ?? "" });
    if ((method === "item/started" || method === "item/completed") && p.item) {
      const item = p.item;
      if (item.type === "agentMessage" && method === "item/completed") this.emit({ type: "message.completed", runId, text: item.text ?? "", ...(item.phase === "commentary" ? { phase: "note" as const } : item.phase === "final_answer" || item.phase === "partial_answer" ? { phase: "answer" as const } : {}) });
      else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
        this.emit({ type: "tool.updated", runId, itemId: item.id, name: item.type === "mcpToolCall" ? `${item.server}.${item.tool}` : item.type,
          input: item.command ?? item.query ?? JSON.stringify(item.arguments ?? item.changes),
          output: item.aggregatedOutput ?? (item.error ? JSON.stringify(item.error) : item.result ? JSON.stringify(item.result) : undefined),
          status: item.status === "failed" || item.status === "declined" || item.error || (item.exitCode != null && item.exitCode !== 0) ? "failed" : method === "item/started" ? "running" : "completed" });
      }
    }
    if (method === "thread/tokenUsage/updated" && p.tokenUsage) {
      const u = p.tokenUsage.last;
      this.emit({ type: "context.observed", runId, context: u.inputTokens, cacheRead: u.cachedInputTokens, cacheWrite: u.cacheWriteInputTokens ?? 0, output: u.outputTokens });
      this.emit({ type: "usage.observed" });
    }
    // The terminal turn carries the final error; retryable `error` notifications are advisory.
    if (method === "turn/completed" && p.turn) {
      if (p.turn.status === "failed") this.fail(codexFailure(p.turn.error ?? {}, this.resetAt));
      else if (p.turn.status === "interrupted") this.fail({ kind: "interrupted", message: "Interrupted" });
      else { this.runId = null; this.turnId = null; this.emit({ type: "turn.completed", runId }); }
    }
  }
  /**
   * The running subagents (grandchildren included) as Claude reports its own, so the desk shows them on this
   * thread's row. Each reports when it starts and ends, and can outlive the turn that spawned it.
   */
  private subagent(item: Item): void {
    // stdout can still hold lines after the exit that cleared them: a late start would stay on the row for good.
    if (this.ended) return;
    const id = item.agentThreadId!;
    // A message to an idle or finished child reads "interacted" without starting it, so only these two change liveness.
    if (item.kind !== "started" && item.kind !== "completed" && item.kind !== "interrupted") return;
    const running = item.kind === "started";
    if (running) this.descendants.add(id);
    if (running === this.subagents.has(id)) return;
    if (running) this.subagents.set(id, { id, kind: "local_agent", description: item.agentPath?.split("/").filter(Boolean).pop() ?? "subagent" });
    else this.subagents.delete(id);
    this.emit({ type: "background.changed", tasks: [...this.subagents.values()] });
  }
  private fail(failure: RuntimeFailure): void {
    const runId = this.runId; this.runId = null; this.turnId = null;
    if (runId) {
      if (failure.kind === "usage_limit") this.emit({ type: "usage.observed", status: "rejected", resetsAt: failure.resetAt });
      this.emit({ type: "turn.failed", runId, failure });
    }
  }
  private end(message: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.secrets) rmSync(this.secrets, { recursive: true, force: true });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
    if (!this.closing) this.fail({ kind: "crashed", message });
    // Subagents run inside the app-server, so they end with it.
    if (this.subagents.size) { this.subagents.clear(); this.emit({ type: "background.changed", tasks: [] }); }
    this.emit({ type: "session.ended", ...(!this.closing ? { failure: { kind: "crashed" as const, message } } : {}) });
  }
}

// CLI -c values are TOML, not JSON; quote keys so arbitrary MCP server/env names survive.
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
