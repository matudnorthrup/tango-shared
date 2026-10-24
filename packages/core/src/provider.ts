import { refreshOllamaCatalogInBackground, resolveOllamaModelName } from "./model-roles.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderReasoningEffort } from "./types.js";
import type { McpHttpToolClient, McpToolTurnContext, OpenAIToolDefinition } from "./mcp-http-tool-client.js";

export interface ProviderImageInput {
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataBase64: string;
  /** MIME type, e.g. "image/png" or "image/jpeg". */
  mediaType: string;
}

export interface ProviderRequest {
  prompt: string;
  providerSessionId?: string;
  systemPrompt?: string;
  tools?: ProviderToolsConfig;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
  /**
   * Inline images for multimodal/vision requests. Consumed by the Ollama provider
   * (emitted as OpenAI `image_url` content parts); CLI providers ignore them.
   */
  images?: ProviderImageInput[];
  /**
   * Governance principal for the HTTP MCP tool loop (Ollama only). Sent as the
   * `X-Worker-ID` header so the persistent MCP server resolves the agent's tool
   * permissions. Ignored by CLI providers.
   */
  workerId?: string;
  /** Per-turn provenance forwarded to MCP write tools (state receipts/undo). */
  toolTurnContext?: McpToolTurnContext;
  /**
   * Called once per tool call in the Ollama tool loop, just before it runs
   * (live turn activity). Best-effort: anything it throws is swallowed.
   * Ignored by CLI providers.
   */
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
}

export interface ProviderResponse {
  text: string;
  providerSessionId?: string;
  metadata?: ProviderResponseMetadata;
  toolCalls?: ProviderToolCall[];
  raw?: unknown;
}

export interface ProviderToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  serverName?: string;
  toolName?: string;
}

export interface ProviderUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ProviderResponseMetadata {
  model?: string;
  stopReason?: string | null;
  durationMs?: number;
  durationApiMs?: number;
  totalCostUsd?: number;
  usage?: ProviderUsageMetrics;
  /**
   * Peak single-call prompt size across the turn's internal model calls
   * (max over assistant messages of input + cache_read + cache_creation tokens).
   * Unlike `modelUsage`, which SUMS token counts across every internal call
   * (and so balloons far past the window on tool-heavy turns), this reflects the
   * true high-water context-window occupancy — bounded by the window.
   */
  contextOccupancyTokens?: number;
  /** Model context window size in tokens (from modelUsage.contextWindow). */
  contextWindowTokens?: number;
}

export type ProviderToolMode = "off" | "default" | "allowlist";

export interface ProviderMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProviderToolsConfig {
  mode?: ProviderToolMode;
  allowlist?: string[];
  permissionMode?: "bypass";
  mcpServers?: Record<string, ProviderMcpServerConfig>;
}

export interface ChatProvider {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ClaudeCliProviderOptions {
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export interface CodexExecProviderOptions {
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  skipGitRepoCheck?: boolean;
}

export interface OllamaProviderOptions {
  /** OpenAI-compatible base URL, e.g. https://ollama.com/v1 */
  baseUrl?: string;
  /**
   * API key, or a lazy async resolver so the key can be fetched from 1Password
   * at the call site without a top-level await. Resolved once, then cached.
   */
  apiKey?: string | (() => Promise<string | undefined>);
  defaultModel?: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  timeoutMs?: number;
  /**
   * Number of retry attempts for a rate-limited chat-completions request. Defaults
   * to TANGO_PROVIDER_RETRY_LIMIT (or one retry when unset).
   */
  retryLimit?: number;
  /** Base delay, in milliseconds, for rate-limit retries. Primarily testable. */
  retryDelayMs?: number;
  /**
   * Optional HTTP MCP tool client (Phase 2). When present AND the request enables
   * tools, `generate()` runs a bounded agentic tool loop against the persistent
   * MCP server. When absent, `generate()` is the Phase 0 single-shot text path.
   */
  toolClient?: McpHttpToolClient;
}

export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/v1";
export const DEFAULT_OLLAMA_MODEL = "deepseek-v4-pro:cloud";
const DEFAULT_OLLAMA_RETRY_LIMIT = 1;
const DEFAULT_OLLAMA_RETRY_DELAY_MS = 1_500;
const MAX_OLLAMA_RETRY_DELAY_MS = 5_000;

function resolveOllamaRetryLimit(configuredLimit: number | undefined): number {
  const configured = configuredLimit ?? Number.parseInt(process.env.TANGO_PROVIDER_RETRY_LIMIT ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_OLLAMA_RETRY_LIMIT;
  return Math.max(0, Math.min(Math.trunc(configured), 3));
}

function resolveOllamaRetryDelayMs(
  retryAfter: string | null,
  attempt: number,
  configuredBaseDelayMs: number | undefined,
): number {
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number.parseFloat(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(Math.round(retryAfterSeconds * 1_000), MAX_OLLAMA_RETRY_DELAY_MS);
  }

  const baseDelayMs = configuredBaseDelayMs ?? DEFAULT_OLLAMA_RETRY_DELAY_MS;
  const normalizedBaseDelayMs = Number.isFinite(baseDelayMs)
    ? Math.max(0, Math.min(Math.round(baseDelayMs), MAX_OLLAMA_RETRY_DELAY_MS))
    : DEFAULT_OLLAMA_RETRY_DELAY_MS;
  return Math.min(normalizedBaseDelayMs * 2 ** attempt, MAX_OLLAMA_RETRY_DELAY_MS);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
/**
 * Conservative effective context window for the Ollama backend (DeepSeek's true
 * window is ~1M tokens). Stamped onto each Ollama RuntimeResponse as
 * `contextWindowTokens` so SessionLifecycleManager's context-reset (0.80
 * threshold) + compaction fire with headroom before the real window is hit.
 */
export const OLLAMA_CONTEXT_WINDOW_TOKENS = 800_000;

/**
 * Hard cap on the number of /v1/chat/completions round-trips inside the Ollama
 * tool loop. Each iteration that returns at least one `tool_calls` entry consumes
 * one slot; when the cap is hit the loop returns the model's last text — or, if
 * the cap was reached with no final text, {@link TOOL_LOOP_CAP_FALLBACK_TEXT} and
 * `stopReason:"max_tool_iters"` — so a misbehaving model can never spin forever.
 */
// 40 (was 25): browser-heavy ordering flows legitimately need more steps — e.g.
// building a Chipotle order from scratch (store select + per-ingredient clicks) hit
// the 25 cap mid-customization. Still a bounded runaway-loop backstop. Override via
// TANGO_MAX_TOOL_ITERS.
export const MAX_TOOL_ITERS = Number(process.env.TANGO_MAX_TOOL_ITERS) || 40;

/**
 * Deterministic reply substituted when the tool loop hits {@link MAX_TOOL_ITERS}
 * without the model producing any final text, so the discord layer never sends a
 * blank message.
 */
export const TOOL_LOOP_CAP_FALLBACK_TEXT =
  "(tool loop reached the step limit without a final answer)";

/**
 * Appended when the tool loop hits {@link MAX_TOOL_ITERS} while the model's last
 * text was interim narration (e.g. "Let me navigate to…"). Without this the user
 * hears a dangling statement of intent and then silence — indistinguishable from
 * the agent doing nothing. Plain spoken language so it reads naturally over TTS.
 */
export const TOOL_LOOP_CAP_TRUNCATION_NOTICE =
  "I hit my step limit before finishing that — the message above is as far as I got. " +
  "Ask me to continue, or give me a smaller piece of the task.";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

const claudeResultSchema = z
  .object({
    type: z.string(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    session_id: z.string().optional()
  })
  .passthrough();

type ExecFailure = Error & {
  code?: number | string;
  signal?: NodeJS.Signals;
  stderr?: string;
  stdout?: string;
  killed?: boolean;
};

function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error;
}

function describeExecFailure(error: ExecFailure): string {
  const parts: string[] = [error.message];
  if (error.code !== undefined) {
    parts.push(`code=${String(error.code)}`);
  }
  if (error.signal) {
    parts.push(`signal=${error.signal}`);
  }
  if (error.killed) {
    parts.push("killed=true");
  }

  const stderr = error.stderr?.trim();
  if (stderr) {
    parts.push(`stderr=${stderr.slice(0, 500)}`);
  }

  return parts.join(" | ");
}

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  bufferOverflow: boolean;
}

interface CommandRunOptions {
  cwd?: string;
  timeoutMs: number;
  maxBufferBytes: number;
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandRunOptions
): Promise<CommandExecutionResult> {
  return await new Promise<CommandExecutionResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let bufferOverflow = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const finish = (result: CommandExecutionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, options.timeoutMs);
    timeoutHandle.unref();

    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const bytes = Buffer.byteLength(text, "utf8");
      if (target === "stdout") {
        stdoutBytes += bytes;
        stdout += text;
      } else {
        stderrBytes += bytes;
        stderr += text;
      }

      if (stdoutBytes + stderrBytes > options.maxBufferBytes) {
        bufferOverflow = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => {
      appendChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendChunk("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      fail(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      finish({
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        bufferOverflow
      });
    });

    child.stdin.end();
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseToolInputValue(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) return record;

  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    return null;
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeProviderToolName(input: { serverName?: string; toolName?: string; name?: string }): string | undefined {
  const serverName = input.serverName?.trim();
  const toolName = input.toolName?.trim();
  if (serverName && toolName) {
    return `mcp__${serverName}__${toolName}`;
  }

  const name = input.name?.trim();
  return name && name.length > 0 ? name : undefined;
}

function extractToolCallFromRecord(record: Record<string, unknown>): ProviderToolCall | null {
  const serverName = typeof record.server === "string" ? record.server : undefined;
  const toolName = typeof record.tool === "string" ? record.tool : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  const error = record.error;

  if (serverName && toolName) {
    if (status && !["completed", "failed"].includes(status)) {
      return null;
    }

    const input = parseToolInputValue(
      record.arguments ?? record.input ?? record.args ?? record.parameters,
    );
    if (!input) return null;

    return {
      name: normalizeProviderToolName({ serverName, toolName })!,
      input,
      output: record.result ?? record.output ?? record.error,
      serverName,
      toolName,
    };
  }

  const rawName =
    typeof record.name === "string"
      ? record.name
      : typeof record.tool_name === "string"
        ? record.tool_name
        : typeof record.tool === "string"
          ? record.tool
        : undefined;
  if (!rawName) {
    return null;
  }

  // Require affirmative evidence of a tool invocation. The stream also carries
  // config/status records with a bare `name` (the init event's mcp_servers
  // list, server config echoes), and parseToolInputValue(undefined) returns {}
  // — without this guard every named record in the stream counts as a "call".
  const isToolUseBlock = record.type === "tool_use";
  const hasExplicitToolKey =
    typeof record.tool_name === "string" || typeof record.tool === "string";
  const hasExplicitInput =
    "input" in record || "arguments" in record || "args" in record || "parameters" in record;
  if (typeof record.command === "string" && !isToolUseBlock) {
    return null;
  }
  if (!isToolUseBlock && !hasExplicitToolKey && !hasExplicitInput) {
    return null;
  }

  const input = parseToolInputValue(
    record.input ?? record.arguments ?? record.args ?? record.parameters,
  );
  if (!input) {
    return null;
  }

  const name = normalizeProviderToolName({ name: rawName });
  if (!name) {
    return null;
  }

  return {
    name,
    input,
    output: record.output ?? record.result ?? record.error,
    serverName: typeof record.server === "string" ? record.server : undefined,
    toolName: rawName,
  };
}

function extractProviderToolCalls(raw: unknown): ProviderToolCall[] {
  const toolCalls: ProviderToolCall[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = asRecord(value);
    if (!record) {
      return;
    }

    const toolCall = extractToolCallFromRecord(record);
    if (toolCall) {
      toolCalls.push(toolCall);
    }

    for (const nestedValue of Object.values(record)) {
      visit(nestedValue);
    }
  };

  visit(raw);
  return toolCalls;
}

function normalizeMcpServers(
  servers: Record<string, ProviderMcpServerConfig> | undefined,
): Record<string, ProviderMcpServerConfig> | undefined {
  if (!servers) return undefined;

  const entries = Object.entries(servers)
    .map(([name, server]) => [name.trim(), server] as const)
    .filter(([name, server]) => name.length > 0 && !!server?.command?.trim());

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(([name, server]) => [
    name,
    {
      command: server.command.trim(),
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    },
  ]));
}

function writeClaudeMcpConfig(
  servers: Record<string, ProviderMcpServerConfig> | undefined,
): string | undefined {
  const mcpServers = normalizeMcpServers(servers);
  if (!mcpServers) {
    return undefined;
  }

  const configPath = path.join(
    os.tmpdir(),
    `tango-provider-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mcpServers }),
    "utf8",
  );
  return configPath;
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function formatTomlInlineStringTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

function formatTomlPathSegment(value: string): string {
  return /^[A-Za-z0-9_]+$/u.test(value) ? value : JSON.stringify(value);
}

/**
 * The user-visible reply for a multi-step turn. Both adapters used to keep only
 * the LAST assistant text block, so a model that wrote its full answer, then
 * called a tool (memory_add, a log write), then signed off with "Saved." delivered
 * just "Saved." to Discord — found 2026-09-24 in the fleet bake-off and confirmed
 * in production (Juliet, 2026-09-17: the user had to ask "what did I miss?").
 *
 * Rule: keep the final block; when it is short and an EARLIER block carried
 * substantive content (≥ SUBSTANTIVE_REPLY_CHARS and longer than the final),
 * prepend those substantive blocks. Short preambles ("Let me check…") are still
 * dropped, so ordinary tool turns read exactly as before.
 */
const SUBSTANTIVE_REPLY_CHARS = 200;
const SHORT_FINAL_REPLY_CHARS = 400;
export function composeVisibleReply(textParts: readonly string[]): string {
  const parts = textParts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  const final = parts[parts.length - 1]!;
  if (parts.length === 1 || final.length >= SHORT_FINAL_REPLY_CHARS) return final;
  const earlier = parts
    .slice(0, -1)
    .filter((part) => part.length >= SUBSTANTIVE_REPLY_CHARS && part.length > final.length);
  return earlier.length === 0 ? final : [...earlier, final].join("\n\n");
}

export function parseClaudePrintJson(stdout: string): ProviderResponse {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: unknown[] = [];
  let providerSessionId: string | undefined;
  let responseText: string | undefined;
  let resultPayload: z.infer<typeof claudeResultSchema> | undefined;
  const assistantTextParts: string[] = [];
  // Context-window occupancy is the PEAK single-call prompt size across the
  // turn's internal model calls — not the cross-call sum in modelUsage.
  let peakOccupancyTokens = 0;
  let contextWindowTokens: number | undefined;
  const numField = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    events.push(parsed);
    const record = asRecord(parsed);
    if (record) {
      const eventType = typeof record.type === "string" ? record.type : undefined;
      if (typeof record.session_id === "string" && record.session_id.trim().length > 0) {
        providerSessionId = record.session_id;
      }

      if (eventType === "assistant") {
        const message = asRecord(record.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const item of content) {
          const part = asRecord(item);
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
            responseText = part.text.trim();
            assistantTextParts.push(responseText);
          }
        }
        // Per-call prompt size = input + cache_read + cache_creation. Track the
        // peak across internal calls as the true window-occupancy high-water mark.
        const usage = asRecord(message?.usage);
        if (usage) {
          const occupancy =
            numField(usage.input_tokens)
            + numField(usage.inputTokens)
            + numField(usage.cache_read_input_tokens)
            + numField(usage.cacheReadInputTokens)
            + numField(usage.cache_creation_input_tokens)
            + numField(usage.cacheCreationInputTokens);
          if (occupancy > peakOccupancyTokens) peakOccupancyTokens = occupancy;
        }
      }

      if (eventType === "result") {
        const modelUsage = asRecord(record.modelUsage);
        if (modelUsage) {
          // Primary entry, never first-listed — see selectPrimaryModelUsageEntry.
          const cw = selectPrimaryModelUsageEntry(modelUsage)?.entry?.contextWindow;
          if (typeof cw === "number" && cw > 0) contextWindowTokens = cw;
        }
      }
    }

    const result = claudeResultSchema.safeParse(parsed);
    if (result.success) {
      if (result.data.is_error) {
        // Preserve the CLI's own failure text ("Claude AI usage limit
        // reached…", auth errors, …) — downstream retry/failover decisions
        // classify on it (TGO-846).
        const errorText = (result.data.result ?? "").trim();
        throw new Error(
          errorText.length > 0
            ? `Claude CLI returned an error result: ${errorText.slice(0, 500)}`
            : "Claude CLI returned an error result",
        );
      }

      resultPayload = result.data;
      const text = (result.data.result ?? "").trim();
      if (text.length > 0) {
        // `result` repeats the final assistant text block; compose it with any
        // substantive earlier blocks so a post-tool sign-off can't eat the answer.
        const parts = assistantTextParts.length > 0 && assistantTextParts[assistantTextParts.length - 1] === text
          ? assistantTextParts
          : [...assistantTextParts, text];
        responseText = composeVisibleReply(parts);
      }
      if (result.data.session_id?.trim()) {
        providerSessionId = result.data.session_id.trim();
      }
    }
  }

  if (events.length === 0) {
    throw new Error("Failed to parse Claude CLI JSON output");
  }

  if (!responseText) {
    throw new Error("Claude CLI returned an empty response");
  }

  const baseMetadata = resultPayload ? extractClaudeMetadata(resultPayload) : undefined;
  const occupancyMetadata =
    peakOccupancyTokens > 0 || contextWindowTokens !== undefined
      ? {
          ...(peakOccupancyTokens > 0 ? { contextOccupancyTokens: peakOccupancyTokens } : {}),
          ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        }
      : undefined;
  const metadata: ProviderResponseMetadata | undefined =
    baseMetadata || occupancyMetadata
      ? { ...(baseMetadata ?? {}), ...(occupancyMetadata ?? {}) }
      : undefined;

  return {
    text: responseText,
    providerSessionId,
    metadata,
    toolCalls: extractProviderToolCalls({ events }),
    raw: resultPayload ?? { events }
  };
}

function extractCodexMetadata(usagePayload: Record<string, unknown> | undefined): ProviderResponseMetadata | undefined {
  if (!usagePayload) return undefined;

  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    usage: {
      inputTokens: asNumber(usagePayload.input_tokens),
      outputTokens: asNumber(usagePayload.output_tokens),
      cacheReadInputTokens: asNumber(usagePayload.cached_input_tokens)
    }
  };
}

export function parseCodexExecJson(stdout: string): ProviderResponse {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: unknown[] = [];
  let providerSessionId: string | undefined;
  let responseText: string | undefined;
  let usagePayload: Record<string, unknown> | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    events.push(parsed);
    if (!parsed || typeof parsed !== "object") continue;

    const payload = parsed as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : undefined;
    if (!type) continue;

    if (type === "thread.started") {
      if (typeof payload.thread_id === "string" && payload.thread_id.trim().length > 0) {
        providerSessionId = payload.thread_id;
      }
      continue;
    }

    if (type === "item.completed") {
      const item = payload.item;
      if (!item || typeof item !== "object") continue;
      const itemPayload = item as Record<string, unknown>;
      const itemType = typeof itemPayload.type === "string" ? itemPayload.type : undefined;
      const itemText = typeof itemPayload.text === "string" ? itemPayload.text.trim() : "";
      if (itemType === "agent_message" && itemText.length > 0) {
        responseText = itemText;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usage = payload.usage;
      if (usage && typeof usage === "object") {
        usagePayload = usage as Record<string, unknown>;
      }
      continue;
    }

    if (type === "error") {
      const message = typeof payload.message === "string" ? payload.message : "unknown codex error";
      throw new Error(`Codex CLI returned an error event: ${message}`);
    }
  }

  if (!responseText || responseText.length === 0) {
    throw new Error("Codex CLI returned an empty response");
  }

  return {
    text: responseText,
    providerSessionId,
    metadata: extractCodexMetadata(usagePayload),
    toolCalls: extractProviderToolCalls({ events }),
    raw: { events }
  };
}

function extractClaudeMetadata(payload: Record<string, unknown>): ProviderResponseMetadata {
  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const asStringOrNull = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    return typeof value === "string" ? value : undefined;
  };

  const usage = payload.usage as Record<string, unknown> | undefined;
  const modelUsage = payload.modelUsage as Record<string, unknown> | undefined;
  // Derive the primary model from observed usage (highest costUSD, tie-broken
  // by output tokens) rather than key order: modelUsage lists every model the
  // CLI touched this turn, internal helper models included, in arbitrary
  // order, and an internal helper model can easily land first.
  const model = modelUsage ? selectPrimaryModelUsageEntry(modelUsage)?.name : undefined;

  return {
    model,
    stopReason: asStringOrNull(payload.stop_reason),
    durationMs: asNumber(payload.duration_ms),
    durationApiMs: asNumber(payload.duration_api_ms),
    totalCostUsd: asNumber(payload.total_cost_usd),
    usage: usage
      ? {
          inputTokens: asNumber(usage.input_tokens),
          outputTokens: asNumber(usage.output_tokens),
          cacheReadInputTokens: asNumber(usage.cache_read_input_tokens),
          cacheCreationInputTokens: asNumber(usage.cache_creation_input_tokens)
        }
      : undefined
  };
}

/**
 * modelUsage lists every model the CLI touched this turn — internal helper
 * models included — in arbitrary order. Records should show which model
 * actually did the work, not whichever key the CLI lists first: observed
 * order is not a meaningful signal, and an internal helper model can easily
 * come first. The primary is the entry that did the work: highest costUSD,
 * tie-broken by output tokens. One selector for every consumer, so metadata
 * fields can never disagree about which model was primary.
 */
export function selectPrimaryModelUsageEntry(
  modelUsage: Record<string, unknown>,
): { name: string; entry: Record<string, unknown> | undefined } | undefined {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  let best: { name: string; entry: Record<string, unknown> | undefined } | undefined;
  let bestCost = -1;
  let bestOutput = -1;
  for (const [name, value] of Object.entries(modelUsage)) {
    const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    const cost = num(entry?.costUSD);
    const output = num(entry?.outputTokens);
    // True two-level comparison: cost decides outright; output tokens break
    // exact cost ties only. A weighted sum here is a trap — token counts are
    // large enough to outweigh realistic cost gaps and flip the winner.
    if (cost > bestCost || (cost === bestCost && output > bestOutput)) {
      bestCost = cost;
      bestOutput = output;
      best = { name, entry };
    }
  }
  return best;
}

function normalizeToolMode(mode: ProviderToolMode | undefined): ProviderToolMode {
  if (mode === "default" || mode === "allowlist") return mode;
  return "off";
}

function normalizeToolAllowlist(value: string[] | undefined): string[] {
  if (!value) return [];
  const deduped = new Set<string>();
  for (const item of value) {
    const normalized = item.trim();
    if (normalized.length === 0) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

function shouldEnableCodexSearch(tools: ProviderToolsConfig | undefined): boolean {
  const mode = normalizeToolMode(tools?.mode);
  if (mode === "off") {
    return false;
  }

  if (mode === "default") {
    return true;
  }

  const allowlist = normalizeToolAllowlist(tools?.allowlist)
    .map((item) => item.toLowerCase())
    .map((item) => item.replace(/[^a-z0-9_]/gu, ""));

  return allowlist.includes("websearch") || allowlist.includes("webfetch") || allowlist.includes("web_search");
}

function appendClaudeToolArgs(args: string[], tools: ProviderToolsConfig | undefined): void {
  const mode = normalizeToolMode(tools?.mode);
  if (mode === "off") {
    args.push("--tools", "");
    return;
  }

  if (mode === "default") {
    args.push("--tools", "default");
    return;
  }

  const allowlist = normalizeToolAllowlist(tools?.allowlist);
  if (allowlist.length === 0) {
    throw new Error("Claude tool mode 'allowlist' requires at least one tool in tools.allowlist");
  }

  args.push("--tools", "default");
  args.push("--allowedTools", ...allowlist);
}

function appendCodexMcpArgs(args: string[], tools: ProviderToolsConfig | undefined): void {
  const mcpServers = normalizeMcpServers(tools?.mcpServers);
  if (!mcpServers) {
    return;
  }

  for (const [serverName, server] of Object.entries(mcpServers)) {
    const pathSegment = formatTomlPathSegment(serverName);
    args.push("-c", `mcp_servers.${pathSegment}.command=${formatTomlString(server.command)}`);
    args.push("-c", `mcp_servers.${pathSegment}.args=${formatTomlStringArray(server.args ?? [])}`);
    if (server.env && Object.keys(server.env).length > 0) {
      args.push("-c", `mcp_servers.${pathSegment}.env=${formatTomlInlineStringTable(server.env)}`);
    }
  }
}

function normalizeClaudeReasoningEffort(
  value: ProviderReasoningEffort | undefined
): "low" | "medium" | "high" | "max" | undefined {
  if (!value) return undefined;
  if (value === "xhigh") return "max";
  return value;
}

function normalizeCodexReasoningEffort(
  value: ProviderReasoningEffort | undefined
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (value === "max") return "xhigh";
  return value;
}

export function buildClaudeCliArgs(
  request: ProviderRequest,
  options: Pick<ClaudeCliProviderOptions, "defaultModel" | "defaultReasoningEffort"> & { mcpConfigPath?: string },
): string[] {
  const args = ["-p", "--verbose", "--output-format", "stream-json"];

  appendClaudeToolArgs(args, request.tools);

  if (request.tools?.permissionMode === "bypass") {
    args.push("--permission-mode", "bypassPermissions");
  }

  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  if (request.providerSessionId) {
    args.push("--resume", request.providerSessionId);
  }

  if (request.systemPrompt && request.systemPrompt.trim().length > 0) {
    args.push("--system-prompt", request.systemPrompt);
  }

  const model = request.model?.trim() || options.defaultModel;
  if (model && model.trim().length > 0) {
    args.push("--model", model);
  }

  const reasoningEffort = normalizeClaudeReasoningEffort(
    request.reasoningEffort ?? options.defaultReasoningEffort
  );
  if (reasoningEffort) {
    args.push("--effort", reasoningEffort);
  }

  args.push(request.prompt);
  return args;
}

function buildCodexPrompt(request: ProviderRequest): string {
  const systemPrompt = request.systemPrompt?.trim();
  if (!systemPrompt) {
    return request.prompt;
  }

  const userPrompt = request.prompt.trim();
  if (userPrompt.length === 0) {
    return `System instructions:\n${systemPrompt}`;
  }

  return `System instructions:\n${systemPrompt}\n\nUser request:\n${request.prompt}`;
}

export function buildCodexExecArgs(
  request: ProviderRequest,
  options: Pick<
    CodexExecProviderOptions,
    "defaultModel" | "defaultReasoningEffort" | "sandbox" | "approvalPolicy" | "skipGitRepoCheck"
  >
): string[] {
  const args: string[] = [];
  const approvalPolicy = options.approvalPolicy?.trim();
  if (approvalPolicy && approvalPolicy.length > 0) {
    args.push("-a", approvalPolicy);
  }

  const sandbox = options.sandbox?.trim();
  if (sandbox && sandbox.length > 0) {
    args.push("--sandbox", sandbox);
  }

  if (shouldEnableCodexSearch(request.tools)) {
    args.push("--search");
  }

  appendCodexMcpArgs(args, request.tools);

  const reasoningEffort = normalizeCodexReasoningEffort(
    request.reasoningEffort ?? options.defaultReasoningEffort
  );
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${formatTomlString(reasoningEffort)}`);
  }

  args.push("exec");
  if (request.providerSessionId) {
    args.push("resume");
  }

  args.push("--json");

  if (options.skipGitRepoCheck !== false) {
    args.push("--skip-git-repo-check");
  }

  const model = request.model?.trim() || options.defaultModel?.trim();
  if (model && model.length > 0) {
    args.push("--model", model);
  }

  if (request.providerSessionId) {
    args.push(request.providerSessionId);
  }

  args.push(buildCodexPrompt(request));
  return args;
}

/**
 * Distill a failed Claude CLI run's stdout (JSON lines) down to its
 * human-readable failure text, e.g. "Claude AI usage limit reached|<ts>".
 */
export function summarizeClaudeCliFailureStdout(stdout: string): string | undefined {
  const fragments: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      fragments.push(trimmed);
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;
    for (const key of ["result", "error", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        fragments.push(value.trim());
      }
    }
  }

  const summary = fragments
    .filter((fragment, index, all) => all.indexOf(fragment) === index)
    .join(" | ")
    .trim();
  return summary.length > 0 ? summary.slice(0, 500) : undefined;
}

export class ClaudeCliProvider implements ChatProvider {
  constructor(private readonly options: ClaudeCliProviderOptions = {}) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const command = this.options.command ?? "claude";
    const mcpConfigPath = writeClaudeMcpConfig(request.tools?.mcpServers);
    const args = buildClaudeCliArgs(request, {
      defaultModel: this.options.defaultModel,
      defaultReasoningEffort: this.options.defaultReasoningEffort,
      mcpConfigPath,
    });
    try {
      const result = await runCommand(command, args, {
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        maxBufferBytes: this.options.maxBufferBytes ?? 4 * 1024 * 1024
      });

      if (result.code !== 0 || result.timedOut || result.bufferOverflow) {
        const details: string[] = [];
        if (result.timedOut) {
          details.push("timedOut=true");
        }
        if (result.bufferOverflow) {
          details.push("bufferOverflow=true");
        }
        details.push(`code=${String(result.code)}`);
        if (result.signal) {
          details.push(`signal=${result.signal}`);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          details.push(`stderr=${stderr.slice(0, 500)}`);
        }
        // The CLI prints usage-limit / auth failures to STDOUT in -p mode, so a
        // stderr-only message reads as an opaque `code=1` (TGO-846).
        const stdoutSummary = summarizeClaudeCliFailureStdout(result.stdout);
        if (stdoutSummary) {
          details.push(`stdout=${stdoutSummary}`);
        }
        throw new Error(details.join(" | "));
      }

      return parseClaudePrintJson(result.stdout);
    } catch (error) {
      const message = isExecFailure(error) ? describeExecFailure(error) : String(error);
      throw new Error(`Claude CLI request failed: ${message}`);
    } finally {
      if (mcpConfigPath) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }
}

export class CodexExecProvider implements ChatProvider {
  constructor(private readonly options: CodexExecProviderOptions = {}) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const command = this.options.command ?? "codex";
    const args = buildCodexExecArgs(request, {
      defaultModel: this.options.defaultModel,
      defaultReasoningEffort: this.options.defaultReasoningEffort,
      sandbox: this.options.sandbox ?? "read-only",
      approvalPolicy: this.options.approvalPolicy ?? "never",
      skipGitRepoCheck: this.options.skipGitRepoCheck ?? true
    });

    try {
      const result = await runCommand(command, args, {
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        maxBufferBytes: this.options.maxBufferBytes ?? 4 * 1024 * 1024
      });

      if (result.code !== 0 || result.timedOut || result.bufferOverflow) {
        const details: string[] = [];
        if (result.timedOut) {
          details.push("timedOut=true");
        }
        if (result.bufferOverflow) {
          details.push("bufferOverflow=true");
        }
        details.push(`code=${String(result.code)}`);
        if (result.signal) {
          details.push(`signal=${result.signal}`);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          details.push(`stderr=${stderr.slice(0, 500)}`);
        }
        throw new Error(details.join(" | "));
      }

      return parseCodexExecJson(result.stdout);
    } catch (error) {
      const message = isExecFailure(error) ? describeExecFailure(error) : String(error);
      throw new Error(`Codex CLI request failed: ${message}`);
    }
  }
}

export class EchoProvider implements ChatProvider {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    return {
      text: `Echo: ${request.prompt}`,
      providerSessionId: request.providerSessionId
    };
  }
}

// --- Ollama (OpenAI-compatible HTTP) provider -------------------------------

/** OpenAI-compatible tool_call as emitted/echoed in chat messages. */
export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One OpenAI-compatible chat message. Beyond the Phase 0 system/user/assistant
 * text turns, the tool loop appends assistant messages carrying `tool_calls` and
 * `role:"tool"` results keyed by `tool_call_id`.
 */
export type OllamaContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type OllamaChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OllamaContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OllamaChatBody {
  model: string;
  messages: OllamaChatMessage[];
  stream: false;
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto" | "none";
}

/** Build the OpenAI-compatible chat-completions request body. Pure + testable. */
export function buildOllamaChatBody(
  request: ProviderRequest,
  options: Pick<OllamaProviderOptions, "defaultModel"> & {
    messages?: OllamaChatMessage[];
    tools?: OpenAIToolDefinition[];
  } = {}
): OllamaChatBody {
  // `role:<name>` resolves to the first bake-off-tested model still in the
  // Ollama catalog (config/model-roles.yaml); plain ids pass through.
  const model = resolveOllamaModelName(
    request.model?.trim() || options.defaultModel?.trim() || DEFAULT_OLLAMA_MODEL,
  );
  // When the tool loop supplies an explicit message array (system + user + the
  // running assistant/tool transcript), use it verbatim. Otherwise assemble the
  // Phase 0 single-shot system + user pair.
  let messages: OllamaChatMessage[];
  if (options.messages) {
    messages = options.messages;
  } else {
    messages = [];
    const systemPrompt = request.systemPrompt?.trim();
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    const images = request.images ?? [];
    if (images.length > 0) {
      // Multimodal: OpenAI-compatible content-parts array (text + image_url data URIs).
      const parts: OllamaContentPart[] = [{ type: "text", text: request.prompt }];
      for (const image of images) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
        });
      }
      messages.push({ role: "user", content: parts });
    } else {
      messages.push({ role: "user", content: request.prompt });
    }
  }
  const body: OllamaChatBody = { model, messages, stream: false };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
  return body;
}

function parseOpenAiToolCalls(message: Record<string, unknown> | null): OpenAiToolCall[] {
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const calls: OpenAiToolCall[] = [];
  let syntheticId = 0;
  for (const entry of raw) {
    const record = asRecord(entry);
    const fn = asRecord(record?.function);
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    if (!name) continue;
    // Synthetic ids use an `auto_` prefix + monotonic counter so they can never
    // collide with a model-supplied id like `call_0` (the result is keyed by id
    // back to the tool message).
    const id = typeof record?.id === "string" && record.id.length > 0
      ? record.id
      : `auto_${syntheticId++}`;
    const args = typeof fn?.arguments === "string" ? fn.arguments : "";
    calls.push({ id, type: "function", function: { name, arguments: args } });
  }
  return calls;
}

/**
 * Decode one /v1/chat/completions response into the fields the tool loop needs:
 * the assistant text, OpenAI tool_calls, finish_reason, prompt/completion token
 * counts, and model. Pure + testable. Unlike {@link parseOllamaChatResponse} this
 * does NOT throw on empty content (a `tool_calls` turn has none).
 */
export function parseOllamaChatTurn(payload: unknown): {
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
} {
  const root = asRecord(payload);
  if (!root) {
    throw new Error("Ollama returned a non-object response");
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const toolCalls = parseOpenAiToolCalls(message);

  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const usage = asRecord(root.usage);

  return {
    content,
    toolCalls,
    finishReason:
      typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined,
    promptTokens: asNumber(usage?.prompt_tokens),
    completionTokens: asNumber(usage?.completion_tokens),
    model: typeof root.model === "string" ? root.model : undefined,
  };
}

/**
 * Map an OpenAI-compatible chat-completions response into a ProviderResponse.
 * Pure + testable. DeepSeek reasoning (choices[].message.reasoning) is kept only
 * in `raw`; it is NOT merged into `text`. Any `choices[0].message.tool_calls`
 * are surfaced on `ProviderResponse.toolCalls`.
 *
 * Throws on empty content UNLESS the turn carries tool_calls (a tool-request turn
 * legitimately has no assistant text).
 */
export function parseOllamaChatResponse(payload: unknown): ProviderResponse {
  const turn = parseOllamaChatTurn(payload);
  if (turn.content.length === 0 && turn.toolCalls.length === 0) {
    throw new Error("Ollama returned an empty response");
  }

  const metadata: ProviderResponseMetadata = {
    model: turn.model,
    stopReason: turn.finishReason ?? undefined,
    usage:
      turn.promptTokens !== undefined || turn.completionTokens !== undefined
        ? {
            inputTokens: turn.promptTokens,
            outputTokens: turn.completionTokens,
          }
        : undefined,
  };

  const toolCalls: ProviderToolCall[] = turn.toolCalls.map((call) => ({
    name: call.function.name,
    input: safeParseToolArgs(call.function.arguments),
  }));

  return {
    text: turn.content,
    metadata,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw: payload,
  };
}

/**
 * Parse an OpenAI function-call `arguments` JSON string into an object. Never
 * throws: on malformed JSON it returns an empty object so the loop can still feed
 * a tool result back to the model instead of crashing the turn.
 */
function safeParseToolArgs(argsJson: string): Record<string, unknown> {
  const trimmed = argsJson.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

/** Whether the request's tool policy enables MCP tools at all. */
function ollamaToolsEnabled(tools: ProviderToolsConfig | undefined): boolean {
  return normalizeToolMode(tools?.mode) !== "off";
}

export class OllamaProvider implements ChatProvider {
  private resolvedKey?: string;

  constructor(private readonly options: OllamaProviderOptions = {}) {}

  private async resolveApiKey(): Promise<string | undefined> {
    const { apiKey } = this.options;
    if (typeof apiKey === "function") {
      if (this.resolvedKey === undefined) {
        this.resolvedKey = (await apiKey()) ?? undefined;
      }
      return this.resolvedKey;
    }
    return apiKey;
  }

  /** POST one chat-completions body and return the parsed JSON payload. */
  private async postChat(body: OllamaChatBody, apiKey: string): Promise<unknown> {
    const baseUrl = (this.options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/u, "");
    refreshOllamaCatalogInBackground(apiKey, baseUrl);
    const url = `${baseUrl}/chat/completions`;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const retryLimit = resolveOllamaRetryLimit(this.options.retryLimit);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Ollama request failed: ${message}`);
      }

      const rawText = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(rawText);
        } catch {
          throw new Error("Ollama returned invalid JSON");
        }
      }

      if (res.status === 429 && attempt < retryLimit) {
        await sleep(resolveOllamaRetryDelayMs(res.headers.get("retry-after"), attempt, this.options.retryDelayMs));
        continue;
      }

      throw new Error(`Ollama request failed: status=${res.status} body=${rawText.slice(0, 500)}`);
    }
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw new Error("Ollama provider is missing an API key");
    }

    const toolClient = this.options.toolClient;
    const useToolLoop = !!toolClient && ollamaToolsEnabled(request.tools);

    // --- Phase 0 text-only path (no tool client / tools disabled) ------------
    // PRESERVED EXACTLY: a single shot returning the assistant text. Because we
    // return NO providerSessionId, the discord failover layer re-injects
    // warm-start history into request.prompt each turn.
    if (!useToolLoop) {
      const startedAt = Date.now();
      const body = buildOllamaChatBody(request, { defaultModel: this.options.defaultModel });
      const payload = await this.postChat(body, apiKey);
      const response = parseOllamaChatResponse(payload);
      const durationMs = Date.now() - startedAt;
      return { ...response, metadata: { ...response.metadata, durationMs } };
    }

    // --- Phase 2 bounded agentic tool loop -----------------------------------
    // Inline vision: the tool loop is text-only and DeepSeek-class models can't see
    // images. If the turn carries images, synchronously describe them with the
    // configured vision model (gemma4:31b) and fold that text into the prompt so the
    // tool-using model can reason over the image content while still calling tools.
    let effectiveRequest = request;
    if (request.images && request.images.length > 0) {
      const description = await this.describeImages(request.images, apiKey);
      if (description) {
        effectiveRequest = {
          ...request,
          prompt:
            `${request.prompt}\n\n[Vision] This turn includes ${request.images.length} image(s); a vision ` +
            `model describes them as follows. Treat this as the image content:\n${description}`,
          images: undefined,
        };
      }
    }
    return this.runToolLoop(effectiveRequest, apiKey, toolClient);
  }

  /**
   * Synchronously describe inline images using the configured vision model
   * (TANGO_VISION_MODEL, default gemma4:31b — qwen3-vl was retired by Ollama 2026-06-16) so a text-only tool-using model can act on
   * image content. Best-effort: returns "" on failure and the caller proceeds without.
   */
  private async describeImages(images: ProviderImageInput[], apiKey: string): Promise<string> {
    const visionModel = process.env.TANGO_VISION_MODEL?.trim() || "role:vision";
    const body = buildOllamaChatBody(
      {
        prompt:
          "Describe the image(s) in thorough, precise detail for an assistant that will act on them: " +
          "transcribe ALL visible text verbatim (numbers, dates, names, amounts, labels) and note layout, " +
          "items, and anything actionable. Do not omit text.",
        images,
        model: visionModel,
      },
      { defaultModel: this.options.defaultModel },
    );
    try {
      const payload = await this.postChat(body, apiKey);
      return parseOllamaChatResponse(payload).text.trim();
    } catch {
      return "";
    }
  }

  private async runToolLoop(
    request: ProviderRequest,
    apiKey: string,
    toolClient: McpHttpToolClient,
  ): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const workerId = request.workerId ?? "ollama";
    const allowlist =
      normalizeToolMode(request.tools?.mode) === "allowlist"
        ? normalizeToolAllowlist(request.tools?.allowlist)
        : undefined;

    // Fetch the tool catalogue once for the whole turn.
    const tools = await toolClient.listOpenAITools(workerId, allowlist);

    // Seed the running transcript with system + user.
    const messages: OllamaChatMessage[] = [];
    const systemPrompt = request.systemPrompt?.trim();
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const executedToolCalls: ProviderToolCall[] = [];
    // contextOccupancyTokens has HIGH-WATER semantics: report the PEAK single-call
    // prompt_tokens across iterations, NOT the sum (summing tool-heavy turns would
    // inflate Phase 1's compaction trigger). Completion tokens, by contrast, are a
    // genuine cost and ARE summed.
    let peakPromptTokens = 0;
    let totalCompletionTokens = 0;
    let lastModel: string | undefined;
    let lastFinishReason: string | undefined;
    let lastContent = "";
    const contentParts: string[] = [];
    let lastPayload: unknown;
    // Stays true if every iteration requested tools and the loop fell out at the
    // cap; cleared the moment the model emits a tool-free terminal turn.
    let hitCap = true;

    for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
      const body = buildOllamaChatBody(request, {
        defaultModel: this.options.defaultModel,
        messages,
        tools,
      });
      const payload = await this.postChat(body, apiKey);
      lastPayload = payload;
      const turn = parseOllamaChatTurn(payload);

      if (turn.promptTokens !== undefined && turn.promptTokens > peakPromptTokens) {
        peakPromptTokens = turn.promptTokens;
      }
      if (turn.completionTokens !== undefined) {
        totalCompletionTokens += turn.completionTokens;
      }
      if (turn.model) lastModel = turn.model;
      lastFinishReason = turn.finishReason;
      if (turn.content.length > 0) {
        lastContent = turn.content;
        contentParts.push(turn.content);
      }

      // Terminal turn: model stopped requesting tools. Gate on tool_calls
      // PRESENCE, not finish_reason — some models emit finish_reason:"stop" while
      // still attaching tool_calls, and those tools must still run. MAX_TOOL_ITERS
      // remains the only hard stop.
      if (turn.toolCalls.length === 0) {
        hitCap = false;
        break;
      }

      // Append the assistant message that carries the tool_calls, then execute
      // every requested call in parallel and append each {role:"tool"} result.
      messages.push({
        role: "assistant",
        content: turn.content.length > 0 ? turn.content : null,
        tool_calls: turn.toolCalls,
      });

      const results = await Promise.all(
        turn.toolCalls.map(async (call) => {
          const args = safeParseToolArgs(call.function.arguments);
          const executed = { name: call.function.name, input: args } as ProviderToolCall;
          executedToolCalls.push(executed);
          try {
            request.onToolUse?.(call.function.name, args);
          } catch {
            // Activity observers must never break the tool loop.
          }
          let output: string;
          try {
            output = await toolClient.callTool(
              call.function.name,
              args,
              workerId,
              allowlist,
              false,
              request.toolTurnContext,
            );
          } catch (error) {
            // callTool already swallows MCP errors, but guard defensively: a tool
            // failure must NEVER throw out of the loop.
            output = JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            });
          }
          executed.output = output;
          return { id: call.id, output };
        }),
      );

      for (const { id, output } of results) {
        messages.push({ role: "tool", tool_call_id: id, content: output });
      }
      // Loop: re-request with the tool results appended.
    }

    // Cap-hit turns must never masquerade as finished answers. With no usable
    // text, substitute the deterministic fallback; with interim narration,
    // append an explicit truncation notice (a dangling "Let me navigate to…"
    // followed by silence reads as the agent doing nothing — live failure on
    // a 228s Marriott browse, TGO-740). Either way stopReason flags the cut.
    const text = hitCap
      ? (lastContent.length === 0
          ? TOOL_LOOP_CAP_FALLBACK_TEXT
          : `${lastContent}\n\n${TOOL_LOOP_CAP_TRUNCATION_NOTICE}`)
      : composeVisibleReply(contentParts);
    const stopReason = hitCap
      ? "max_tool_iters"
      : (lastFinishReason ?? undefined);

    const durationMs = Date.now() - startedAt;
    const metadata: ProviderResponseMetadata = {
      model: lastModel,
      stopReason,
      durationMs,
      usage: {
        // high-water prompt occupancy, summed completion cost.
        inputTokens: peakPromptTokens > 0 ? peakPromptTokens : undefined,
        outputTokens: totalCompletionTokens > 0 ? totalCompletionTokens : undefined,
      },
    };

    return {
      text,
      metadata,
      ...(executedToolCalls.length > 0 ? { toolCalls: executedToolCalls } : {}),
      raw: lastPayload,
    };
  }
}
