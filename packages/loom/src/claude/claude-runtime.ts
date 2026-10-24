import { resourceRunContext } from "../resource-client.js";
import { LOOM_GUIDANCE, roleGuidance } from "../instructions.js";
import { redactProfile } from "../session-profile.js";
import { createLoomTools, loomRequester } from "./loom-tools.js";
import { COMPACT_GUIDANCE } from "../carry.js";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { PEER_WAKE_TEXT, type OpenSessionOptions, type Runtime, type RuntimeEvent, type RuntimeFailure, type RuntimeSession } from "../runtime.js";
import type { TurnImage } from "../attachments.js";
import { spawnGroup, type SpawnLedger } from "../proc.js";
import { classifyResult } from "./failures.js";
import { ensureProjects, isLegacyProject, linkSession, linkProjectSlug, linkTranscript, projectSlug } from "./project-store.js";
import { peerEntryOf, TranscriptTail } from "./peer-transcript.js";

/** Resolve existing ancestors too, so new files and symlinked directories obey the same boundary. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(canonical(parent), relative(parent, path));
  }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
export function localEditGuard(cwd: string, loomHome: string, flag = process.env.LOOM_LOCAL_EDIT_GUARD) {
  let checkout: string | null = null;
  if (flag !== "off" && !inside(canonical(join(loomHome, "worktrees")), canonical(cwd))) {
    try {
      checkout = canonical(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim());
    } catch { /* Non-repo threads have no checkout to protect. */ }
  }
  return (tool: string, input: Record<string, unknown>): string | null => {
    if (!checkout || !["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) return null;
    const path = input.file_path ?? input.notebook_path;
    if (typeof path !== "string" || !inside(checkout, canonical(resolve(cwd, path)))) return null;
    return "This thread has no worktree. Open a worker (tango-screen start ... --role worker), hand the build to Codex via agentctl, or ask the owner. Edits inside this checkout are denied.";
  };
}

export interface ClaudeAccount {
  name: string;
  /** Omit for the default account (~/.claude, with CLAUDE_CONFIG_DIR unset). */
  configDir?: string;
}

export interface ClaudeRuntimeOptions {
  accounts: ClaudeAccount[];
  /** Used when a thread has no account yet. */
  defaultAccount: string;
  /** Where Loom keeps the shared copy of each Claude project folder. */
  sharedProjectsDir: string;
  loomHome?: string;
  /** Records harness processes in the orphan ledger and spawns them as process groups. */
  ledger?: SpawnLedger;
  store?: SpawnLedger;
  model?: string;
  /**
   * Claude Code compacts a session once its context passes this many tokens (CLAUDE_CODE_AUTO_COMPACT_WINDOW).
   * Default 250k instead of the model's ~1M window: every call re-sends the whole context. 0 leaves Claude's own.
   */
  compactWindow?: number;
  /** Fetches the thread's carried state for the SessionStart hook (default: Loom's own API). Replaceable for tests. */
  carry?: (threadId: string) => Promise<string | null>;
  pathToClaudeCodeExecutable?: string;
  /** Replaceable for tests. */
  query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
}

/** Variables that would make the harness use a credential other than the account's. */
const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"];

/**
 * Variables that route model calls through another provider or endpoint (Bedrock, Vertex,
 * Foundry, a proxy). Without a selector the harness can't use the service's cloud identity for
 * the model, so AWS and Google credentials themselves stay: agents' own tools may need them.
 */
const PROVIDER_ENV = /^(CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_SKIP_(BEDROCK|VERTEX|FOUNDRY)_AUTH|ANTHROPIC_(BASE_URL|BEDROCK_BASE_URL|VERTEX_BASE_URL|VERTEX_PROJECT_ID|FOUNDRY_[A-Z_]+))$/;

/** Session variables inherited when Loom itself runs under Claude Code. */
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH)|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID|CLAUDE_EFFORT)$/;

export function accountEnv(account: ClaudeAccount, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || CREDENTIAL_ENV.includes(k) || PROVIDER_ENV.test(k) || PARENT_SESSION_ENV.test(k) || k === "CLAUDE_CONFIG_DIR" || k === "LOOM_RUN_ID" || k === "TANGO_DESK_ITEM") continue;
    env[k] = v;
  }
  // HOME is never changed: macOS finds the account's Keychain entry through it.
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

export function configDirOf(account: ClaudeAccount): string {
  return account.configDir ?? join(homedir(), ".claude");
}

/** One long-lived Agent SDK query per thread. */
export class ClaudeRuntime implements Runtime {
  constructor(private readonly options: ClaudeRuntimeOptions) {
    for (const account of options.accounts) {
      const projects = join(configDirOf(account), "projects");
      ensureProjects(configDirOf(account));
      if (!existsSync(projects)) continue;
      for (const entry of readdirSync(projects, { withFileTypes: true })) {
        if (!entry.name.includes(".loom-backup-") && entry.isSymbolicLink() && isLegacyProject(join(projects, entry.name), options.sharedProjectsDir)) linkProjectSlug(configDirOf(account), options.sharedProjectsDir, entry.name);
      }
    }
  }

  account(name: string | null): ClaudeAccount {
    const wanted = name ?? this.options.defaultAccount;
    const found = this.options.accounts.find((a) => a.name === wanted);
    if (!found) throw new Error(`Unknown Claude account "${wanted}"`);
    return found;
  }

  async open(options: OpenSessionOptions, emit: (event: RuntimeEvent) => void): Promise<RuntimeSession> {
    const account = this.account(options.account);
    if (linkSession(configDirOf(account), this.options.sharedProjectsDir, options.cwd, options.nativeSessionId, this.options.accounts.map(configDirOf)) === "unsupported") {
      // Claude Code hashes very long folder names, so Loom can't share this one's history across accounts.
      throw new Error(`The project path is too long to share its history across accounts: ${options.cwd}`);
    }
    try {
      return new ClaudeSession(this.options, account, options, emit);
    } catch (error) {
      throw new Error(redactProfile(error instanceof Error ? error.message : String(error), options.session));
    }
  }
}

class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(message: SDKUserMessage): void {
    this.queue.push(message);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface Pending {
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
}

export const WAKE_TEXT = "A background task finished.";
/** A turn another Claude session's message started (native cross-session messaging). */
export { PEER_WAKE_TEXT };

class ClaudeSession implements RuntimeSession {
  private readonly transcriptDir: string;
  private readonly editGuard: ReturnType<typeof localEditGuard>;
  private nativeId: string | null = null;
  private readonly syncTranscript: (id: string) => void;
  private readonly inbox = new Inbox();
  private readonly query: Query;
  private readonly pending = new Map<string, Pending>();
  private runId: string | null = null;
  private resourceIdentityEnabled = true;
  private wroteMessage = false;
  /** The SDK sends one assistant message per content block, each with the call's usage: count each call once. */
  private lastCallId: string | null = null;
  private partial = "";
  private lastRateLimit: { status: string; resetsAt?: number } | undefined;
  private stderrTail: string[] = [];
  private pumping = false;
  /** The session's transcript, read for messages from other sessions (opened once its id is known). */
  private transcript: TranscriptTail | null = null;
  private wakeText = WAKE_TEXT;
  /** SendMessage calls waiting for their result: filed as sent only when it says they went. */
  private readonly sends = new Map<string, { to: string; body: string }>();

  constructor(
    options: ClaudeRuntimeOptions,
    account: ClaudeAccount,
    session: OpenSessionOptions,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {
    // Tango agents and jobs work in their own checkout on purpose; only coding threads are guarded.
    const localGuard = ["coding", "probe"].includes(session.kind ?? "") ? localEditGuard(session.cwd, options.loomHome ?? dirname(options.sharedProjectsDir)) : () => null;
    let promotionSent = false;
    this.editGuard = (name, input) => {
      if (session.session?.disallowedTools?.includes(name)) return `Tool ${name} is disabled for this session`;
      const denied = localGuard(name, input);
      if (!denied || session.worktreeMode !== "auto" || process.env.LOOM_AUTO_PROMOTE === "off") return denied;
      if (!promotionSent && this.runId) {
        promotionSent = true;
        this.emit({ type: "worktree.promote", runId: this.runId });
      }
      return "Moving this thread into its own worktree; your next session continues there.";
    };
    this.transcriptDir = join(options.sharedProjectsDir, projectSlug(session.cwd));
    const local = join(configDirOf(account), "projects", projectSlug(session.cwd));
    this.nativeId = session.nativeSessionId;
    this.syncTranscript = id => linkTranscript(join(local, `${id}.jsonl`), join(this.transcriptDir, `${id}.jsonl`));
    // A resumed session is read from its start: one that came in just before a restart isn't lost, and
    // Loom files each native message once, at its own time (Codex review on #575).
    if (session.nativeSessionId) this.transcript = new TranscriptTail(join(this.transcriptDir, `${session.nativeSessionId}.jsonl`), false);
    const queryFn = options.query ?? sdkQuery;
    const store = options.ledger ?? options.store;
    const profile = session.session;
    this.resourceIdentityEnabled = profile?.loomTools !== false;
    const base: NodeJS.ProcessEnv = profile?.loomTools === false
      ? Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
      : process.env;
    const env = accountEnv(account, base);
    for (const [key, value] of Object.entries(profile?.env ?? {})) {
      if (key !== "LOOM_RUN_ID" && key !== "TANGO_DESK_ITEM" && key !== "CLAUDE_CONFIG_DIR" && !CREDENTIAL_ENV.includes(key) && !PROVIDER_ENV.test(key) && !PARENT_SESSION_ENV.test(key)) env[key] = value;
    }
    const safeEmit = this.emit;
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return redactProfile(value, profile);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
      return value;
    };
    this.emit = event => {
      // Preserve protocol discriminants, identifiers and wake callbacks, even when a secret is short.
      const sanitized = { ...event } as RuntimeEvent;
      for (const key of ["text", "input", "output", "payload", "tasks"] as const) {
        if (key in sanitized) (sanitized as unknown as Record<string, unknown>)[key] = redact((sanitized as unknown as Record<string, unknown>)[key]);
      }
      if ("failure" in sanitized && sanitized.failure) sanitized.failure = { ...sanitized.failure, message: redactProfile(sanitized.failure.message, profile) };
      safeEmit(sanitized);
    };
    this.query = queryFn({
      prompt: this.inbox,
      options: {
        cwd: session.cwd,
        // The session's own desk item (`tango-screen` reads it to know which conversation it is: desk mail's sender).
        // Coding threads compact at Loom's window; an isolated agent profile (loomTools false) keeps its own lifecycle.
        env: { ...env, ...(profile?.loomTools === false ? {} : { ...compactEnv(env, options.compactWindow), TANGO_DESK_ITEM: `loom:${session.threadId}` }) },
        hooks: {
          ...(profile?.loomTools === false ? {} : carryHooks(session.threadId, options.carry ?? loomCarry(env))),
          // Permission bypass can skip canUseTool; PreToolUse enforces the same boundary.
          PreToolUse: [{ matcher: "Edit|Write|NotebookEdit|MultiEdit", hooks: [async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const message = this.editGuard(input.tool_name, input.tool_input as Record<string, unknown>);
            return message ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: message } } : {};
          }] }],
        },
        ...(session.nativeSessionId ? { resume: session.nativeSessionId } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        disallowedTools: profile?.disallowedTools,
        settingSources: profile?.settingSources ?? ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", append: [profile?.loomTools === false ? "" : LOOM_GUIDANCE, profile?.loomTools === false ? "" : roleGuidance(session.role), profile?.system].filter(Boolean).join("\n\n") },
        mcpServers: profile?.loomTools === false
          ? Object.fromEntries(Object.entries(profile.mcpServers ?? {}).filter(([name]) => name !== "loom"))
          : { ...profile?.mcpServers, loom: createLoomTools(session.threadId) },
        ...(profile?.loomTools === false ? { strictMcpConfig: true } : {}),
        canUseTool: this.canUseTool,
        ...((profile?.model ?? options.model) ? { model: profile?.model ?? options.model } : {}),
        ...(profile?.effort ? { effort: profile.effort } : {}),
        ...(profile?.tools === "none" ? { tools: [] } : {}),
        ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {}),
        stderr: (data: string) => {
          this.stderrTail.push(redactProfile(data, profile));
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        },
        ...(store
          ? {
              spawnClaudeCodeProcess: (spawnOptions): SpawnedProcess => {
                const child = spawnGroup(store, session.threadId, spawnOptions.command, spawnOptions.args, {
                  cwd: spawnOptions.cwd,
                  env: spawnOptions.env as NodeJS.ProcessEnv,
                  stdio: ["pipe", "pipe", "pipe"],
                });
                spawnOptions.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
                // The SDK reads stderr only from a process it spawns itself: without this, why the CLI exited
                // (an account that must accept new terms, say) is lost behind "exited with code 1".
                child.stderr?.setEncoding("utf8");
                child.stderr?.on("data", (data: string) => {
                  this.stderrTail.push(redactProfile(data, profile));
                  if (this.stderrTail.length > 20) this.stderrTail.shift();
                });
                return child as unknown as SpawnedProcess;
              },
            }
          : {}),
      },
    });
  }

  startTurn(run: { runId: string; text: string; images?: TurnImage[] }): void {
    // The pump starts with the first turn, once the host owns this session: a harness that dies
    // at startup then fails that turn instead of ending a session the host hasn't installed yet.
    if (!this.pumping) {
      this.pumping = true;
      void this.pump();
    }
    this.runId = run.runId;
    this.wroteMessage = false;
    this.partial = "";
    this.lastRateLimit = undefined;
    this.inbox.push({
      type: "user",
      message: { role: "user", content: userContent([this.resourceIdentityEnabled && !/^\/[^\s/]+(\s|$)/.test(run.text) ? resourceRunContext(run.runId) : "", run.text].filter(Boolean).join("\n\n"), run.images) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    } as SDKUserMessage);
  }

  /** Into the turn in progress: Claude reads it as soon as its current tool call finishes. */
  inject(text: string, images?: TurnImage[]): void {
    this.inbox.push({
      type: "user",
      message: { role: "user", content: userContent(text, images) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      priority: "next",
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  /** Messages from other sessions the transcript gained since the last look. */
  private readPeers(): void {
    if (this.nativeId) this.syncTranscript(this.nativeId);
    if (!this.transcript) return;
    for (const line of this.transcript.lines()) {
      const peer = peerEntryOf(line);
      if (!peer) continue;
      if (!peer.inline) this.wakeText = PEER_WAKE_TEXT;
      this.emit({ type: "peer.message", direction: "in", text: peer.text, messageId: peer.messageId, inline: peer.inline, ...(peer.name ? { name: peer.name } : {}), ...(peer.address ? { address: peer.address } : {}), ...(peer.at ? { at: peer.at } : {}) });
    }
  }

  respond(requestId: string, answer: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`No pending request ${requestId}`);
    this.pending.delete(requestId);
    pending.resolve(answer);
  }

  async close(): Promise<void> {
    this.inbox.close();
    this.query.close();
    if (this.nativeId) this.syncTranscript(this.nativeId);
  }

  /** The run the harness is working on. Output with no run is a wake turn the harness started itself. */
  private currentRun(): string {
    if (this.runId) return this.runId;
    // What started this turn may only now be in the transcript (a resumed session a peer woke): read it
    // before binding the wake, so the message files ahead of the reply and names the wake (Codex review on #575).
    this.readPeers();
    // Label output locally while a remote coordinator allocates the durable wake run.
    const wakeId = randomUUID();
    this.runId = wakeId;
    this.emit({ type: "wake.started", text: this.wakeText, wakeId, bind: (id) => { if (this.runId === wakeId) this.runId = id; } });
    this.wakeText = WAKE_TEXT;
    this.wroteMessage = false;
    this.partial = "";
    this.lastRateLimit = undefined;
    return this.runId!;
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
    const denied = this.editGuard(toolName, input);
    if (denied) return { behavior: "deny", message: denied };
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") return { behavior: "allow", updatedInput: input };
    const requestId = toolUseID ?? randomUUID();
    const kind = toolName === "AskUserQuestion" ? "question" : "plan";
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      signal.addEventListener("abort", () => {
        this.pending.delete(requestId);
        reject(new Error("aborted"));
      }, { once: true });
    });
    this.emit({ type: "request.opened", runId: this.currentRun(), requestId, kind, payload: input });
    let reply: unknown;
    try {
      reply = await answer;
    } catch {
      return { behavior: "deny", message: "The question was withdrawn." };
    }
    if (kind === "question") {
      const answers = (reply as { answers?: unknown })?.answers ?? reply;
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    const plan = (reply ?? {}) as { approve?: boolean; feedback?: string };
    return plan.approve
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: plan.feedback || "The user wants changes to the plan before you start." };
  };

  private async pump(): Promise<void> {
    let failure: RuntimeFailure | undefined;
    try {
      for await (const message of this.query) this.handle(message);
    } catch (error) {
      const text = [error instanceof Error ? error.message : String(error), ...this.stderrTail].join("\n");
      failure = classifyResult({ subtype: "error", is_error: true, result: text }) ?? { kind: "crashed", message: text };
    }
    for (const pending of this.pending.values()) pending.reject(new Error("session ended"));
    this.pending.clear();
    this.emit({ type: "session.ended", ...(failure ? { failure } : {}) });
  }

  private handle(message: SDKMessage): void {
    if (this.nativeId) this.syncTranscript(this.nativeId);
    const m = message as SDKMessage & Record<string, any>;
    switch (m.type) {
      case "system":
        // SDK 0.3.300 exposes rule attribution here, but not in permission_denials or the denial hook.
        // Never infer attribution from the human-readable reason or the tool result.
        if (m.subtype === "permission_denied" && m.decision_reason_type === "rule" && this.runId && typeof m.tool_use_id === "string" && typeof m.tool_name === "string") {
          this.emit({ type: "tool.denied", runId: this.runId, itemId: m.tool_use_id, name: m.tool_name });
        }

        if (m.subtype === "init" && m.session_id) {
          this.nativeId = m.session_id;
          this.syncTranscript(m.session_id);
          this.emit({ type: "session.native", nativeSessionId: m.session_id });
          // A new session's transcript is read from its start (it has no history yet).
          if (!this.transcript) this.transcript = new TranscriptTail(join(this.transcriptDir, `${m.session_id}.jsonl`), false);
          // A turn starts: a message from another session may be what started it.
          this.readPeers();
        }
        // A level signal (the whole set each time). Ambient tasks are watchers, not work: kept, marked, so the desk
        // knows the agent will be woken (not done) while upgrades still don't wait on them.
        if (m.subtype === "compact_boundary" && m.compact_metadata) {
          const meta = m.compact_metadata;
          this.emit({ type: "context.compacted", trigger: String(meta.trigger ?? "auto"), preTokens: Number(meta.pre_tokens ?? 0), ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}) });
        }
        if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
          const tasks = (m.tasks as any[]).map((t) => ({ id: String(t.task_id), kind: String(t.task_type ?? ""), description: String(t.description ?? ""), ...(t?.ambient ? { ambient: true } : {}) }));
          this.emit({ type: "background.changed", tasks });
        }
        return;
      case "rate_limit_event": {
        const info = m.rate_limit_info ?? {};
        this.lastRateLimit = info;
        const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : undefined;
        this.emit({ type: "usage.observed", status: info.status, utilization: info.utilization, ...(resetsAt ? { resetsAt } : {}), ...(typeof info.rateLimitType === "string" ? { window: info.rateLimitType } : {}) });
        return;
      }
      case "stream_event": {
        if (m.parent_tool_use_id) return;
        const event = m.event;
        if (event?.type === "content_block_start") this.partial = "";
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          this.partial += event.delta.text;
          this.emit({ type: "message.delta", runId: this.currentRun(), text: this.partial });
        }
        return;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        const runId = this.currentRun();
        const usage = m.message?.usage;
        const callId = typeof m.message?.id === "string" ? m.message.id : null;
        if (usage && (!callId || callId !== this.lastCallId)) {
          this.lastCallId = callId;
          const cacheRead = Number(usage.cache_read_input_tokens ?? 0), cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
          this.emit({ type: "context.observed", runId, context: Number(usage.input_tokens ?? 0) + cacheRead + cacheWrite, cacheRead, cacheWrite, output: Number(usage.output_tokens ?? 0), ...(typeof m.message?.model === "string" ? { model: m.message.model } : {}) });
        }
        const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text.trim()) {
          this.emit({ type: "message.completed", runId, text });
          this.wroteMessage = true;
        }
        for (const b of blocks) {
          if (b.type === "tool_use") {
            this.emit({ type: "tool.updated", runId, itemId: b.id, name: b.name, input: JSON.stringify(b.input ?? {}), status: "running" });
            // A message this session sends another (native cross-session messaging): a note of what it sent.
            // Filed once its tool result says it went (a refused send never shows as sent; Codex review on #575).
            if (b.name === "SendMessage") {
              const to = typeof b.input?.to === "string" ? b.input.to : typeof b.input?.recipient === "string" ? b.input.recipient : "";
              const body = typeof b.input?.message === "string" ? b.input.message : typeof b.input?.content === "string" ? b.input.content : "";
              if (to && body.trim()) this.sends.set(b.id, { to, body: body.trim() });
            }
          }
        }
        this.readPeers();
        return;
      }
      case "user": {
        if (m.parent_tool_use_id || !this.runId) return;
        const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (b.type !== "tool_result") continue;
          const send = this.sends.get(b.tool_use_id);
          if (send) {
            this.sends.delete(b.tool_use_id);
            if (!b.is_error && sendSucceeded(b.content)) this.emit({ type: "peer.message", direction: "out", text: send.body, name: send.to, address: send.to, messageId: b.tool_use_id, inline: true });
          }
          this.emit({
            type: "tool.updated",
            runId: this.runId,
            itemId: b.tool_use_id,
            name: "",
            output: toolOutput(b.content),
            status: b.is_error ? "failed" : "completed",
          });
        }
        return;
      }
      case "result": {
        this.readPeers();
        const runId = this.currentRun();
        const failure = classifyResult(m as any, this.lastRateLimit);
        if (failure) {
          this.emit({ type: "turn.failed", runId, failure });
        } else {
          if (!this.wroteMessage && typeof m.result === "string" && m.result.trim()) {
            this.emit({ type: "message.completed", runId, text: m.result });
          }
          this.emit({ type: "turn.completed", runId });
        }
        this.runId = null;
        this.wroteMessage = false;
        this.partial = "";
        // A peer that started this turn never names the next wake.
        this.wakeText = WAKE_TEXT;
        return;
      }
    }
  }
}

export const DEFAULT_COMPACT_WINDOW = 250_000;

/** The compaction window for a session, unless its profile or Loom's own environment already set one. */
export function compactEnv(env: Record<string, string>, window = Number(process.env.LOOM_COMPACT_WINDOW ?? DEFAULT_COMPACT_WINDOW)): Record<string, string> {
  if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined || !Number.isFinite(window) || window <= 0) return {};
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.round(window)) };
}

export function loomCarry(env: Record<string, string>): (threadId: string) => Promise<string | null> {
  const request = loomRequester(env);
  return async (threadId) => ((await request(`/threads/${encodeURIComponent(threadId)}/carry`, undefined, 5_000)) as { text?: string }).text ?? null;
}

/**
 * Compaction keeps what the thread needs (PreCompact), and Loom's state comes back right after it (SessionStart
 * with source "compact"), so a summary that drops a wait or a brief loses nothing. A failed fetch never blocks the
 * session: it continues without the block.
 */
export function carryHooks(threadId: string, carry: (threadId: string) => Promise<string | null>): Options["hooks"] {
  return {
    // The SDK appends a PreCompact callback's systemMessage to the compaction instructions, automatic compaction
    // included (checked live against the bundled harness, 2026-10-19).
    PreCompact: [{ hooks: [async () => ({ systemMessage: COMPACT_GUIDANCE })] }],
    SessionStart: [{ hooks: [async (input) => {
      if ((input as { source?: string }).source !== "compact") return {};
      const text = await carry(threadId).catch(() => null);
      return text ? { hookSpecificOutput: { hookEventName: "SessionStart" as const, additionalContext: text } } : {};
    }] }],
  };
}

function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** A SendMessage tool result that says the message went (`"success": true`), as opposed to a refusal. */
export function sendSucceeded(content: unknown): boolean {
  const text = toolOutput(content);
  try {
    return JSON.parse(text)?.success === true;
  } catch {
    return /"success"\s*:\s*true/.test(text);
  }
}

/** A user message's content: the images first, then the words (plain text when there are no images). */
export function userContent(text: string, images?: TurnImage[]): string | unknown[] {
  if (!images?.length) return text;
  return [
    ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
    ...(text.trim() ? [{ type: "text", text }] : []),
  ];
}
