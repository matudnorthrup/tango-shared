import { isModelRole, tryResolveOllamaModelName } from "./model-roles.js";
import { getDecisionShadow, type DecisionPrompt } from "./decision-model.js";
import { randomUUID } from "node:crypto";
import {
  OLLAMA_CONTEXT_WINDOW_TOKENS,
  type ChatProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderToolsConfig,
} from "./provider.js";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  McpServerConfig,
  RuntimeResponse,
  RuntimeState,
  SendOptions,
} from "./agent-runtime.js";
import { describeToolUse, emitRuntimeTurnEvent } from "./runtime-activity.js";

// Appended to every Ollama-backed agent's system prompt. DeepSeek tends to fan out
// search/list tools serially (validation saw a one-day Slack digest fire the slack tool
// 20× and a notes lookup hit obsidian 8×), which is slow though not wrong. This nudges it
// toward broad-query-then-drill and batching, cutting latency/iteration use. Ollama-only:
// the adapter is only constructed for clones, so the Claude originals' souls are untouched.
const OLLAMA_TOOL_EFFICIENCY_GUIDANCE =
  "\n\nTool efficiency: when you search or list (Slack, Obsidian, email, web, transactions), " +
  "run ONE broad query first and then drill into only the results that matter — do not loop a " +
  "tool one item, channel, or note at a time. Use batch/multi-target options when a tool offers " +
  "them, and finish in as few tool calls as you can." +
  "\n\nNotion: for ANYTHING in Notion — a notion.so / notion.com / app.notion.com link, a Notion " +
  "page, database, or the user's Notion workspace — ALWAYS use the `notion` tool (operation: " +
  "\"search\" to find a page, then \"get_page\" with its page_id to read the full content; " +
  "\"create_page\"/\"append\"/\"update_page\" to write). NEVER open or read Notion through the " +
  "`browser` tool — Notion's web UI requires interactive login and renders blank to tools, so the " +
  "browser will always fail. A blank Notion page in the browser means \"use the notion tool\", " +
  "NOT \"ask the user to share to web.\"" +
  "\n\nSharing images: a screenshot or image file on disk is INVISIBLE to the user until you send " +
  "it. When the user asks to see a screenshot, picture, or any visual, you MUST call " +
  "`discord_send_image` (source = the file path or https URL, channel_id = discord_thread_id from " +
  "the current message metadata if present, else discord_channel_id, agent_id = your id) and it " +
  "must return a message_id. NEVER say you sent, shared, or are showing an image unless that call " +
  "succeeded this turn — if it failed or you could not call it, say so plainly instead." +
  "\n\nFinishing turns: NEVER end your reply with a statement of what you are about to do ('Let me " +
  "navigate to…', 'I'll pull that up…'). Your reply ends the turn — nothing happens after it. " +
  "Either keep calling tools until the action is DONE, or stop and report exactly what you " +
  "completed, what remains, and what you need. If a multi-step task is taking long, finish the " +
  "single most useful step (for a screenshot request: capture and SEND one screenshot) before " +
  "wrapping up.";

const KNOWN_MCP_SERVER_TOOLS: Record<string, string[]> = {
  memory: ["memory_search", "memory_add", "memory_reflect"],
};

// Per-task model routing (the owner: "per task with a per-agent fallback"). A cheap classifier
// labels the incoming task; clearly-judgment tasks route to a thinking model and
// clearly-data-analysis tasks to a thorough model, while everything else falls back to the
// agent's own configured runtime.model. Defaults are bake-off-backed; all env-overridable.
// The classifier is one fast (gemma4) call and returns the fallback on any failure, so
// routing can never break or block a turn.
const PER_TASK_ROUTING = (process.env.TANGO_PER_TASK_MODEL_ROUTING ?? "true") !== "false";
// role:task-router (gemma4:31b) since 2026-09-24: ministral-3:3b was retired 2026-07-15 (every
// classify call 4xx'd → silent OTHER). Router bake-off: 70/72 correct, 0 misclassified
// (2 timeouts fail safe), p50 ~0.5s. Must be a NON-thinking model — thinking models
// spend the 4-token budget on reasoning and return empty content.
const TASK_ROUTER_MODEL = process.env.TANGO_TASK_ROUTER_MODEL?.trim() || "role:task-router";
const TASK_ROUTER_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "https://ollama.com/v1";
const MODEL_FOR_JUDGMENT = process.env.TANGO_MODEL_JUDGMENT?.trim() || "role:judgment";
const MODEL_FOR_DATA = process.env.TANGO_MODEL_DATA?.trim() || "deepseek-v4-pro:cloud";

async function classifyTaskShape(task: string, apiKey: string): Promise<"JUDGMENT" | "DATA" | "OTHER"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${TASK_ROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: tryResolveOllamaModelName(TASK_ROUTER_MODEL),
        max_tokens: 4,
        messages: [
          {
            role: "system",
            content:
              "Classify the user's task into exactly one word: JUDGMENT, DATA, or OTHER.\n" +
              "JUDGMENT = the answer needs open-ended reasoning, interpretation, or composition. " +
              "Examples: planning a trip or itinerary, weighing options or deciding, giving advice or recommendations, " +
              "prioritizing, teaching or explaining a concept in depth, drafting or writing a thoughtful message.\n" +
              "DATA = analyzing the user's own structured records to find patterns or insights " +
              "(finances, transactions, health metrics, workout or nutrition logs, sleep data).\n" +
              "OTHER = a single obvious action with one correct result: factual lookups, retrieval, browsing, " +
              "placing an order, logging an entry, adding to a list, short factual answers.\n" +
              "Reply with ONLY one word: JUDGMENT, DATA, or OTHER.",
          },
          { role: "user", content: task.slice(0, 2000) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return "OTHER";
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = (json.choices?.[0]?.message?.content ?? "").toUpperCase();
    if (out.includes("JUDGMENT")) return "JUDGMENT";
    if (out.includes("DATA")) return "DATA";
    return "OTHER";
  } catch {
    return "OTHER";
  } finally {
    clearTimeout(timer);
  }
}

/** The task-router question for the shadow decision model; same labels as the LLM router. */
export function taskShapeDecisionPrompt(task: string): DecisionPrompt {
  return {
    state: { task: task.slice(0, 2000) },
    questions: {
      shape: {
        type: "choice",
        instructions: "What shape of work does this task need from the assistant?",
        criteria: {
          JUDGMENT:
            "Open-ended reasoning, interpretation or composition: planning a trip, weighing options, advice, prioritizing, explaining a concept in depth, drafting a thoughtful message",
          DATA:
            "Analyzing the user's own structured records for patterns or insights: finances, transactions, health metrics, workout or nutrition logs, sleep data",
          OTHER:
            "A single obvious action with one correct result: a factual lookup, retrieval, browsing, placing an order, logging an entry, adding to a list, a short factual answer",
        },
      },
    },
  };
}

// Models already strong enough at a shape that the router must NOT downgrade them. A bake-off
// showed deepseek-v4-pro is the BEST model for emotional-judgment (juliet) and teaching
// (papa) — so a blanket "JUDGMENT -> glm-5.2" would replace their deliberately-assigned strong
// model with a worse one. So the router only OVERRIDES to upgrade a weak/fast fallback for its
// weak shape; an agent already on a strong model for that shape keeps it.
// Sept 2026 fleet bake-off added glm-5.3 / kimi-k3 (judgment) and deepseek-v4.1-flash (data);
// deepseek-v4-flash is retired.
const STRONG_JUDGMENT_MODELS = new Set([
  "glm-5.3", "glm-5.2", "deepseek-v4-pro:cloud", "deepseek-v4-pro", "kimi-k3", "kimi-k2.6",
]);
const STRONG_DATA_MODELS = new Set([
  "deepseek-v4-pro:cloud", "deepseek-v4-pro", "deepseek-v4.1-flash",
]);

// Resolve the model for a turn: a per-task UPGRADE for JUDGMENT/DATA when the agent's
// configured (fallback) model is weak at that shape, else the agent's own model. Returns the
// fallback if routing is off, no key, or on error — so it can never break or block a turn.
export async function resolveModelForTask(
  task: string,
  fallbackModel: string | undefined,
): Promise<string | undefined> {
  if (!PER_TASK_ROUTING) return fallbackModel;
  // A `role:` assignment is bake-off evidence for THIS task/agent (e.g. job-digest
  // on deepseek-v4.1-flash beat glm-5.3 on the Slack digest). The router's
  // "upgrade a weak fallback" heuristic must not override it.
  if (fallbackModel && isModelRole(fallbackModel)) return fallbackModel;
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  if (!apiKey || !task.trim()) return fallbackModel;
  const shape = await classifyTaskShape(task, apiKey);
  getDecisionShadow().run({
    site: "runtime.task_shape",
    prompt: taskShapeDecisionPrompt(task),
    incumbent: { shape },
    excerpt: task,
  });
  // Judge strength on the CONCRETE model a role resolves to.
  const concrete = fallbackModel ? tryResolveOllamaModelName(fallbackModel) : undefined;
  if (shape === "JUDGMENT" && !(concrete && STRONG_JUDGMENT_MODELS.has(concrete))) {
    return MODEL_FOR_JUDGMENT;
  }
  if (shape === "DATA" && !(concrete && STRONG_DATA_MODELS.has(concrete))) {
    return MODEL_FOR_DATA;
  }
  return fallbackModel;
}

/**
 * Runs a v2 agent turn through a stateless {@link ChatProvider} (the
 * OllamaProvider) instead of the Claude Code CLI. Mirrors
 * ClaudeCodeAdapter.send()'s prompt assembly (cold-start / context / metadata /
 * briefing / message) and response mapping so the Discord v2 path records the
 * model and token usage the same way.
 *
 * Phase 2 adds a provider-agnostic agentic tool loop: when the provider holds an
 * HTTP MCP tool client, send() passes the agent's tool policy + worker id on the
 * ProviderRequest, and OllamaProvider.generate() runs the bounded tool loop
 * against the persistent MCP server. The provider uses a single shared
 * fixed-port (9100) tool client injected in main.ts — the port is not passed per
 * request. toolsUsed is derived from the resulting tool calls (mirroring
 * ClaudeCodeAdapter).
 *
 * The provider remains stateless and returns no providerSessionId, so
 * getSessionId() is always undefined — the discord warm-start layer re-injects
 * history each turn via SendOptions.context.
 */
export class OllamaRuntimeAdapter implements AgentRuntime {
  public readonly id = randomUUID();
  public readonly type = "ollama" as const;

  private config: AgentRuntimeConfig;
  private stateValue: RuntimeState = "idle";

  constructor(
    private readonly provider: ChatProvider,
    config: AgentRuntimeConfig,
  ) {
    this.config = config;
  }

  get active(): boolean {
    return this.stateValue === "spawning" || this.stateValue === "active" || this.stateValue === "idle";
  }

  get state(): RuntimeState {
    return this.stateValue;
  }

  /** Stateless provider: there is no resumable provider session to track. */
  getSessionId(): string | undefined {
    return undefined;
  }

  async initialize(config: AgentRuntimeConfig): Promise<void> {
    this.config = config;
    this.stateValue = "idle";
  }

  async send(message: string, options: SendOptions = {}): Promise<RuntimeResponse> {
    const startedAt = Date.now();
    const prompt = this.buildPrompt(message, options);

    const tools = this.resolveTools();
    // Per-task routing: clearly-judgment tasks -> a thinking model, clearly-data tasks
    // -> a thorough model, everything else -> this agent's configured model (the
    // fallback). On any failure the classifier returns the fallback, so it can never
    // break a turn.
    const routedModel = await resolveModelForTask(message, this.config.runtimePreferences.model);
    const request: ProviderRequest = {
      prompt,
      ...(this.config.systemPrompt.trim()
        ? { systemPrompt: this.config.systemPrompt + OLLAMA_TOOL_EFFICIENCY_GUIDANCE }
        : { systemPrompt: OLLAMA_TOOL_EFFICIENCY_GUIDANCE.trim() }),
      ...(routedModel ? { model: routedModel } : {}),
      ...(tools ? { tools } : {}),
      // Inbound image bytes for same-turn vision. OllamaProvider folds these
      // through a vision model (qwen3-vl) and strips them before the tool loop,
      // so DeepSeek can reason over image content on the turn it arrives.
      ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
      // Governance principal for the HTTP MCP tool loop. The persistent server
      // resolves this agent's tool permissions from X-Worker-ID. The provider's
      // shared fixed-port tool client targets the server; no port is passed here.
      workerId: this.config.agentId,
      ...(resolveToolTurnContext(this.config.mcpServers)
        ? { toolTurnContext: resolveToolTurnContext(this.config.mcpServers) }
        : {}),
      ...(options.onEvent
        ? {
            onToolUse: (name: string, input: Record<string, unknown>) =>
              emitRuntimeTurnEvent(options.onEvent, {
                type: "tool_use",
                name,
                activity: describeToolUse(name, input),
                at: Date.now(),
              }),
          }
        : {}),
    };

    this.stateValue = "active";

    let response: ProviderResponse;
    try {
      response = await this.provider.generate(request);
    } catch (error) {
      this.stateValue = "error";
      throw error;
    }

    this.stateValue = "idle";

    const durationMs = Date.now() - startedAt;
    const providerMetadata = response.metadata;
    const model = providerMetadata?.model ?? this.config.runtimePreferences.model;

    // Context-window occupancy stamping. The stateless provider never reports
    // window occupancy, so SessionLifecycleManager's context-reset (0.80
    // threshold) + compaction would never fire and Ollama conversations would
    // grow unbounded. Stamp the peak prompt occupancy + a conservative window so
    // extractOccupancyUsage() (context-usage.ts) computes a fraction the
    // lifecycle can act on. occupancy = peak PROMPT tokens only (matching the
    // Claude provider's prompt-only semantics); completion tokens stay in `usage`
    // for cost accounting but are excluded from the compaction trigger. Because
    // warm-start re-injects the FULL transcript every turn, inputTokens tracks the
    // growing history and the fraction climbs as the conversation does.
    const usage = providerMetadata?.usage;
    const contextOccupancyTokens = usage?.inputTokens ?? 0;

    if (options.onChunk && response.text.length > 0) {
      options.onChunk(response.text);
    }

    // Mirror ClaudeCodeAdapter:417 — deduped tool names drive the model_runs
    // toolsUsed column.
    const toolsUsed = [...new Set((response.toolCalls ?? []).map((tool) => tool.name))];

    return {
      text: response.text,
      durationMs,
      ...(model ? { model } : {}),
      ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
      ...(response.toolCalls && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      metadata: {
        backend: "ollama",
        // Mirror ClaudeCodeAdapter: the discord v2 path reads model / stopReason
        // / durationMs / usage off metadata.providerMetadata to populate the
        // model_runs row (see main.ts v2 turn handler).
        providerMetadata,
        // Occupancy fields read by extractOccupancyUsage() → the lifecycle
        // context-reset. findNumericField() recurses into metadata, so these are
        // discovered here at the top level.
        ...(contextOccupancyTokens > 0
          ? {
              contextOccupancyTokens,
              contextWindowTokens: OLLAMA_CONTEXT_WINDOW_TOKENS,
            }
          : {}),
        ...(response.raw !== undefined ? { raw: response.raw } : {}),
      },
    };
  }

  async teardown(): Promise<void> {
    this.stateValue = "closed";
  }

  async healthCheck(): Promise<boolean> {
    return this.stateValue !== "closed" && this.stateValue !== "error";
  }

  /**
   * The agent's tool policy for the provider tool loop. Enabled whenever the
   * agent is configured with at least one MCP server (the persistent HTTP
   * wellness server). The provider only runs the loop when it also holds a tool
   * client, so this is a no-op for tool-client-less providers.
   */
  private resolveTools(): ProviderToolsConfig | undefined {
    if (this.config.mcpServers.length === 0) {
      return undefined;
    }
    const allowlist = resolveMcpToolAllowlist(this.config.mcpServers);
    return allowlist ? { mode: "allowlist", allowlist } : { mode: "default" };
  }

  private buildPrompt(message: string, options: SendOptions): string {
    const sections: string[] = [];
    if (this.config.coldStartContext?.trim()) {
      sections.push(`Cold start context:\n${this.config.coldStartContext.trim()}`);
    }
    if (options.context?.trim()) {
      sections.push(`Context:\n${options.context.trim()}`);
    }
    if (options.currentTurnMetadataPrompt?.trim()) {
      sections.push(options.currentTurnMetadataPrompt.trim());
    }
    if (options.turnBriefingPrompt?.trim()) {
      sections.push(options.turnBriefingPrompt.trim());
    }
    sections.push(message);
    return sections.join("\n\n");
  }
}

function resolveToolTurnContext(servers: readonly McpServerConfig[]): ProviderRequest["toolTurnContext"] {
  for (const server of servers) {
    const env = server.env;
    if (!env?.TANGO_TURN_ID && !env?.TANGO_CONVERSATION_KEY) continue;
    return {
      conversationKey: env.TANGO_CONVERSATION_KEY,
      turnId: env.TANGO_TURN_ID,
      messageId: env.TANGO_MESSAGE_ID,
      channelId: env.TANGO_DISCORD_CHANNEL_ID,
      threadId: env.TANGO_DISCORD_THREAD_ID,
    };
  }
  return undefined;
}

function resolveMcpToolAllowlist(servers: McpServerConfig[]): string[] | undefined {
  const allowlist: string[] = [];
  for (const server of servers) {
    const explicit = parseAllowedToolIds(server.env?.ALLOWED_TOOL_IDS);
    if (explicit.length > 0) {
      allowlist.push(...explicit);
      continue;
    }

    const known = KNOWN_MCP_SERVER_TOOLS[server.name];
    if (known) {
      allowlist.push(...known);
      continue;
    }

    return undefined;
  }
  return [...new Set(allowlist)];
}

function parseAllowedToolIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
