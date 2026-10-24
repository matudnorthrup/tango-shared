import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { resolveConfigLayers } from "./config-layering.js";
import type { CurrentTurnMetadataConfig } from "./current-turn-metadata.js";
import { resolveConfiguredPath } from "./runtime-paths.js";
import type {
  AccessMode,
  ProviderReasoningEffort,
  ToolMode,
  WriteConfirmationMode,
} from "./types.js";

export type V2RuntimeMode = "persistent" | "fresh";
export type V2RuntimeProvider = "legacy" | "claude-code-v2";
export type V2FeatureToggle = "enabled" | "disabled";
export type V2CollaborationVisibilityMode = "summary" | "digest" | "thread" | "transcript" | "silent";

export interface V2AgentResponsibilityConfig {
  id: string;
  description: string;
  objectives?: string[];
  allowedInitiators?: {
    agents?: string[];
    schedules?: string[];
  };
  autonomy?: {
    default?: "manual" | "supervised" | "autonomous";
    writesRequireConfirmation?: boolean;
    purchaseOrPayment?: "never" | "confirm" | "allowed";
  };
  collaboration?: {
    canRequest?: Array<{
      agent: string;
      purposes: string[];
    }>;
    canFulfill?: Array<{
      purpose: string;
      maxTurns?: number;
      maxDurationSeconds?: number;
      maxToolCalls?: number;
      visibilityModes?: V2CollaborationVisibilityMode[];
    }>;
  };
}

export interface V2AgentConfig {
  id: string;
  enabled?: boolean;
  /**
   * Isolated agents serve someone other than the owner (e.g. a child). They get
   * no built-in Claude tools, no shared/global memory or state, strictly
   * self-scoped Atlas memory, and only the MCP tools in
   * ISOLATED_AGENT_SAFE_TOOL_IDS. See docs/guides/isolated-agents.md.
   */
  isolated?: boolean;
  discordMirror?: "both" | "outbound" | "off";
  displayName: string;
  type: string;
  avatarURL?: string;
  avatarPath?: string;
  systemPromptFile: string;
  mcpServers: Array<{
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  mcp?: {
    defaultServers?: string[];
    availableServers?: string[];
  };
  runtime: {
    backend?: "claude-code" | "loom";
    mode: V2RuntimeMode;
    provider: V2RuntimeProvider;
    fallback?: string;
    model: string;
    reasoningEffort: ProviderReasoningEffort;
    idleTimeoutHours: number;
    contextResetThreshold: number;
    timeoutSeconds?: number;
  };
  memory: {
    postTurnExtraction: V2FeatureToggle;
    canonicalAgentId?: string;
    aliasAgentIds?: string[];
    /** Optional provider name for post-turn extraction; defaults by agent backend. */
    extractionProvider?: string;
    extractionModel: string;
    importanceThreshold: number;
    scheduledReflection: V2FeatureToggle;
  };
  /**
   * Active-task continuation (capture unfinished commitments post-turn, surface
   * them in warm-start). Absent section = enabled with memory-extraction
   * defaults; set continuation: disabled for a per-agent kill switch.
   */
  activeTasks?: {
    continuation: V2FeatureToggle;
    extractionProvider?: string;
    extractionModel?: string;
  };
  /** Typed canonical state digest and per-turn reconciliation settings. */
  state?: {
    reconciliation: V2FeatureToggle;
    extractionProvider?: string;
    extractionModel?: string;
    alwaysOnTypes: string[];
    focusTtlDays: number;
  };
  voice?: {
    callSigns: string[];
    kokoroVoice?: string;
    liveVoice?: string;
    defaultChannelId: string;
    defaultPromptAgent?: string;
    smokeTestChannelId?: string;
  };
  discord: {
    defaultChannelId: string;
    smokeTestChannelId?: string;
    typingTokenEnv?: string;
    threadFollowers?: string[];
  };
  defaultTopic?: string;
  defaultProject?: string;
  responseMode?: "concise" | "explain";
  currentTurnMetadata?: CurrentTurnMetadataConfig;
  legacyProvider?: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
  tools?: {
    mode?: ToolMode;
    allowlist?: string[];
    permissionMode?: "bypass";
  };
  orchestration?: {
    workerIds?: string[];
    writeConfirmation?: WriteConfirmationMode;
  };
  deterministicRouting?: {
    enabled?: boolean;
    projectScope?: string;
    additionalDomains?: string[];
    confidenceThreshold?: number;
    provider?: {
      default: string;
      model?: string;
      reasoningEffort?: ProviderReasoningEffort;
      fallback?: string[];
    };
  };
  access?: {
    mode?: AccessMode;
    allowlistChannelIds?: string[];
    allowlistUserIds?: string[];
  };
  responsibilities?: V2AgentResponsibilityConfig[];
}

const providerReasoningEffortSchema = z.enum(["low", "medium", "high", "max", "xhigh"]);
const featureToggleSchema = z.enum(["enabled", "disabled"]);

const legacyProviderSchema = z.object({
  default: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoning_effort: providerReasoningEffortSchema.optional(),
  fallback: z.array(z.string().min(1)).optional(),
});

const collaborationVisibilityModeSchema = z.enum(["summary", "digest", "thread", "transcript", "silent"]);

const responsibilitySchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  objectives: z.array(z.string().min(1)).optional(),
  allowed_initiators: z.object({
    agents: z.array(z.string().min(1)).optional(),
    schedules: z.array(z.string().min(1)).optional(),
  }).optional(),
  autonomy: z.object({
    default: z.enum(["manual", "supervised", "autonomous"]).optional(),
    writes_require_confirmation: z.boolean().optional(),
    purchase_or_payment: z.enum(["never", "confirm", "allowed"]).optional(),
  }).optional(),
  collaboration: z.object({
    can_request: z.array(z.object({
      agent: z.string().min(1),
      purposes: z.array(z.string().min(1)).min(1),
    })).optional(),
    can_fulfill: z.array(z.object({
      purpose: z.string().min(1),
      max_turns: z.number().int().positive().optional(),
      max_duration_seconds: z.number().int().positive().optional(),
      max_tool_calls: z.number().int().positive().optional(),
      visibility_modes: z.array(collaborationVisibilityModeSchema).optional(),
    })).optional(),
  }).optional(),
});

const rawV2AgentConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  isolated: z.boolean().optional(),
  discordMirror: z.enum(["both", "outbound", "off"]).default("both"),
  display_name: z.string().min(1),
  type: z.string().min(1),
  avatar_url: z.string().url().optional(),
  avatar_path: z.string().min(1).optional(),
  system_prompt_file: z.string().min(1),
  mcp_servers: z.array(
    z.union([
      z.object({
        name: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
      }),
      z.object({
        name: z.string().min(1),
        url: z.string().url(),
        headers: z.record(z.string()).optional(),
      }),
    ]),
  ).min(1),
  mcp: z.object({
    default_servers: z.array(z.string().min(1)).optional(),
    available_servers: z.array(z.string().min(1)).optional(),
  }).optional(),
  runtime: z.object({
    backend: z.enum(["claude-code", "loom"]).optional(),
    mode: z.enum(["persistent", "fresh"]),
    provider: z.enum(["legacy", "claude-code-v2"]),
    fallback: z.string().min(1).optional(),
    model: z.string().min(1),
    reasoning_effort: providerReasoningEffortSchema,
    idle_timeout_hours: z.number().positive(),
    context_reset_threshold: z.number().min(0).max(1),
    // Zero explicitly disables the local runtime deadline. Omit the field to
    // retain the shared default timeout.
    timeout_seconds: z.number().int().nonnegative().optional(),
  }),
  memory: z.object({
    post_turn_extraction: featureToggleSchema,
    canonical_agent_id: z.string().min(1).optional(),
    alias_agent_ids: z.array(z.string().min(1)).optional(),
    extraction_provider: z.string().min(1).optional(),
    extraction_model: z.string().min(1),
    importance_threshold: z.number().min(0).max(1),
    scheduled_reflection: featureToggleSchema,
  }),
  active_tasks: z.object({
    continuation: featureToggleSchema,
    extraction_provider: z.string().min(1).optional(),
    extraction_model: z.string().min(1).optional(),
  }).optional(),
  state: z.object({
    reconciliation: featureToggleSchema.default("enabled"),
    extraction_provider: z.string().min(1).optional(),
    extraction_model: z.string().min(1).optional(),
    always_on_types: z.array(z.string().min(1)).default([]),
    focus_ttl_days: z.number().positive().default(7),
  }).optional(),
  voice: z.object({
    call_signs: z.array(z.string().min(1)).min(1),
    // Kokoro TTS voice for the retired legacy voice app (TGO-938). Unused; still
    // accepted so existing profile overlays keep loading.
    kokoro_voice: z.string().min(1).optional(),
    live_voice: z.string().min(1).optional(),
    default_channel_id: z.string().min(1),
    default_prompt_agent: z.string().min(1).optional(),
    smoke_test_channel_id: z.string().min(1).optional(),
  }).optional(),
  discord: z.object({
    default_channel_id: z.string().min(1),
    smoke_test_channel_id: z.string().min(1).optional(),
    typing_token_env: z.string().min(1).optional(),
    /** Discord users added to every new thread in this agent's channel, so it shows in their sidebar. */
    thread_followers: z.array(z.string().regex(/^\d+$/, "thread_followers must be Discord user ids")).optional(),
  }),
  default_topic: z.string().min(1).optional(),
  default_project: z.string().min(1).optional(),
  response_mode: z.enum(["concise", "explain"]).optional(),
  current_turn_metadata: z.object({
    timezone: z.string().min(1).optional(),
    locale: z.string().min(1).optional(),
    time_format: z.enum(["12h", "24h"]).optional(),
  }).optional(),
  provider: legacyProviderSchema.optional(),
  tools: z.object({
    mode: z.enum(["off", "default", "allowlist"]).optional(),
    allowlist: z.array(z.string().min(1)).optional(),
    permission_mode: z.enum(["bypass"]).optional(),
  }).optional(),
  orchestration: z.object({
    worker_ids: z.array(z.string().min(1)).optional(),
    write_confirmation: z.enum(["always", "on-ambiguity", "never"]).optional(),
  }).optional(),
  deterministic_routing: z.object({
    enabled: z.boolean().optional(),
    project_scope: z.string().min(1).optional(),
    additional_domains: z.array(z.string().min(1)).optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    provider: legacyProviderSchema.optional(),
  }).optional(),
  access: z.object({
    mode: z.enum(["off", "allowlist", "mention", "both"]).optional(),
    allowlist_channel_ids: z.array(z.string().min(1)).optional(),
    allowlist_user_ids: z.array(z.string().min(1)).optional(),
  }).optional(),
  responsibilities: z.array(responsibilitySchema).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function deepMergeValues(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) {
    return cloneValue(override);
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = Object.fromEntries(
      Object.entries(base).map(([key, value]) => [key, cloneValue(value)]),
    );

    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMergeValues(merged[key], value) : cloneValue(value);
    }

    return merged;
  }

  return cloneValue(override);
}

/**
 * The only MCP tools an isolated agent may mount through the mcp-proxy. Every
 * other tool reaches owner data (email, files, vault, attachments, other
 * agents) or acts as the owner. Widen deliberately, never by overlay.
 */
export const ISOLATED_AGENT_SAFE_TOOL_IDS: ReadonlySet<string> = new Set([
  "exa_search",
  "exa_answer",
  "youtube_transcript",
  "youtube_analyze",
  "kilo_ledger",
  "safety_alert",
  "training_log",
]);

const MCP_PROXY_SCRIPT = "packages/core/dist/mcp-proxy.js";
const ATLAS_MEMORY_SCRIPT = "packages/atlas-memory/dist/index.js";

function assertIsolatedAgentConfig(parsed: z.infer<typeof rawV2AgentConfigSchema>): void {
  const fail = (reason: string): never => {
    throw new Error(`Isolated V2 agent '${parsed.id}' ${reason}`);
  };

  for (const server of parsed.mcp_servers) {
    if (!("command" in server)) {
      fail(`may not mount remote MCP server '${server.name}'`);
      continue;
    }
    const args = "args" in server ? server.args ?? [] : [];
    if (args.includes(ATLAS_MEMORY_SCRIPT)) {
      continue;
    }
    if (!args.includes(MCP_PROXY_SCRIPT)) {
      fail(`may not mount MCP server '${server.name}' (only the mcp-proxy and Atlas memory are allowed)`);
    }
    const allowed = ("env" in server ? server.env?.ALLOWED_TOOL_IDS : undefined)
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ?? [];
    if (allowed.length === 0) {
      fail(`must set ALLOWED_TOOL_IDS on MCP server '${server.name}'`);
    }
    const unsafe = allowed.filter((toolId) => !ISOLATED_AGENT_SAFE_TOOL_IDS.has(toolId));
    if (unsafe.length > 0) {
      fail(`may not use tool(s) ${unsafe.join(", ")} on MCP server '${server.name}'`);
    }
  }

  // Codex degraded hops run a CLI with filesystem access; Ollama hops are
  // tool-free. Keep isolated agents off Codex entirely.
  if (parsed.runtime.fallback === "codex" || parsed.provider?.fallback?.includes("codex")) {
    fail("may not fall back to codex");
  }
  if (parsed.tools?.mode && parsed.tools.mode !== "off") {
    fail("must use tools.mode: off");
  }
  if (parsed.memory.alias_agent_ids?.length) {
    fail("may not alias another agent's memory");
  }
  // Deterministic routing and orchestration dispatch to owner worker agents.
  if (parsed.deterministic_routing?.enabled) {
    fail("may not enable deterministic_routing");
  }
  if (parsed.orchestration?.worker_ids?.length) {
    fail("may not orchestrate worker agents");
  }
}

function parseV2AgentConfig(rawConfig: unknown): V2AgentConfig {
  const parsed = rawV2AgentConfigSchema.parse(rawConfig);
  const serverNames = new Set(parsed.mcp_servers.map((server) => server.name));
  const validateMcpServerNames = (field: string, values: string[] | undefined): string[] | undefined => {
    if (!values) {
      return undefined;
    }
    const missing = values.filter((name) => !serverNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `V2 agent '${parsed.id}' ${field} references unknown MCP server(s): ${missing.join(", ")}`,
      );
    }
    return values;
  };

  if (parsed.isolated) {
    assertIsolatedAgentConfig(parsed);
  }

  return {
    id: parsed.id,
    enabled: parsed.enabled,
    ...(parsed.isolated ? { isolated: true } : {}),
    discordMirror: parsed.discordMirror,
    displayName: parsed.display_name,
    type: parsed.type,
    avatarURL: parsed.avatar_url,
    avatarPath: parsed.avatar_path,
    systemPromptFile: parsed.system_prompt_file,
    mcpServers: parsed.mcp_servers.map((server) => ({
      name: server.name,
      ...("command" in server ? { command: server.command } : {}),
      ...("args" in server ? { args: server.args } : {}),
      ...("env" in server ? { env: server.env } : {}),
      ...("url" in server ? { url: server.url } : {}),
      ...("headers" in server ? { headers: server.headers } : {}),
    })),
    mcp: parsed.mcp
      ? {
          defaultServers: validateMcpServerNames("mcp.default_servers", parsed.mcp.default_servers),
          availableServers: validateMcpServerNames("mcp.available_servers", parsed.mcp.available_servers),
        }
      : undefined,
    runtime: {
      backend: parsed.runtime.backend,
      mode: parsed.runtime.mode,
      provider: parsed.runtime.provider,
      fallback: parsed.runtime.fallback,
      model: parsed.runtime.model,
      reasoningEffort: parsed.runtime.reasoning_effort,
      idleTimeoutHours: parsed.runtime.idle_timeout_hours,
      contextResetThreshold: parsed.runtime.context_reset_threshold,
      timeoutSeconds: parsed.runtime.timeout_seconds,
    },
    memory: {
      postTurnExtraction: parsed.memory.post_turn_extraction,
      ...(parsed.memory.canonical_agent_id
        ? { canonicalAgentId: parsed.memory.canonical_agent_id }
        : {}),
      ...(parsed.memory.alias_agent_ids
        ? { aliasAgentIds: parsed.memory.alias_agent_ids }
        : {}),
      ...(parsed.memory.extraction_provider
        ? { extractionProvider: parsed.memory.extraction_provider }
        : {}),
      extractionModel: parsed.memory.extraction_model,
      importanceThreshold: parsed.memory.importance_threshold,
      scheduledReflection: parsed.memory.scheduled_reflection,
    },
    activeTasks: parsed.active_tasks
      ? {
          continuation: parsed.active_tasks.continuation,
          ...(parsed.active_tasks.extraction_provider
            ? { extractionProvider: parsed.active_tasks.extraction_provider }
            : {}),
          ...(parsed.active_tasks.extraction_model
            ? { extractionModel: parsed.active_tasks.extraction_model }
            : {}),
        }
      : undefined,
    state: parsed.state
      ? {
          reconciliation: parsed.state.reconciliation,
          ...(parsed.state.extraction_provider
            ? { extractionProvider: parsed.state.extraction_provider }
            : {}),
          ...(parsed.state.extraction_model
            ? { extractionModel: parsed.state.extraction_model }
            : {}),
          alwaysOnTypes: parsed.state.always_on_types,
          focusTtlDays: parsed.state.focus_ttl_days,
        }
      : {
          reconciliation: "enabled",
          alwaysOnTypes: parsed.type === "wellness"
            ? ["body-composition"]
            : parsed.type === "personal"
              ? ["project", "travel", "vehicle"]
              : [],
          focusTtlDays: 7,
        },
    voice: parsed.voice
      ? {
          callSigns: parsed.voice.call_signs,
          kokoroVoice: parsed.voice.kokoro_voice,
          liveVoice: parsed.voice.live_voice,
          defaultChannelId: parsed.voice.default_channel_id,
          defaultPromptAgent: parsed.voice.default_prompt_agent,
          smokeTestChannelId: parsed.voice.smoke_test_channel_id,
        }
      : undefined,
    discord: {
      defaultChannelId: parsed.discord.default_channel_id,
      smokeTestChannelId: parsed.discord.smoke_test_channel_id,
      typingTokenEnv: parsed.discord.typing_token_env,
      ...(parsed.discord.thread_followers?.length ? { threadFollowers: parsed.discord.thread_followers } : {}),
    },
    defaultTopic: parsed.default_topic,
    defaultProject: parsed.default_project,
    responseMode: parsed.response_mode,
    currentTurnMetadata: parsed.current_turn_metadata
      ? {
          ...(parsed.current_turn_metadata.timezone
            ? { timeZone: parsed.current_turn_metadata.timezone }
            : {}),
          ...(parsed.current_turn_metadata.locale
            ? { locale: parsed.current_turn_metadata.locale }
            : {}),
          ...(parsed.current_turn_metadata.time_format
            ? { timeFormat: parsed.current_turn_metadata.time_format }
            : {}),
        }
      : undefined,
    legacyProvider: parsed.provider
      ? {
          default: parsed.provider.default,
          model: parsed.provider.model,
          reasoningEffort: parsed.provider.reasoning_effort,
          fallback: parsed.provider.fallback,
        }
      : undefined,
    tools: parsed.tools
      ? {
          mode: parsed.tools.mode,
          allowlist: parsed.tools.allowlist,
          permissionMode: parsed.tools.permission_mode,
        }
      : undefined,
    orchestration: parsed.orchestration
      ? {
          workerIds: parsed.orchestration.worker_ids,
          writeConfirmation: parsed.orchestration.write_confirmation,
        }
      : undefined,
    deterministicRouting: parsed.deterministic_routing
      ? {
          enabled: parsed.deterministic_routing.enabled,
          projectScope: parsed.deterministic_routing.project_scope,
          additionalDomains: parsed.deterministic_routing.additional_domains,
          confidenceThreshold: parsed.deterministic_routing.confidence_threshold,
          provider: parsed.deterministic_routing.provider
            ? {
                default: parsed.deterministic_routing.provider.default,
                model: parsed.deterministic_routing.provider.model,
                reasoningEffort: parsed.deterministic_routing.provider.reasoning_effort,
                fallback: parsed.deterministic_routing.provider.fallback,
              }
            : undefined,
        }
      : undefined,
    access: parsed.access
      ? {
          mode: parsed.access.mode,
          allowlistChannelIds: parsed.access.allowlist_channel_ids,
          allowlistUserIds: parsed.access.allowlist_user_ids,
        }
      : undefined,
    responsibilities: parsed.responsibilities?.map((responsibility) => ({
      id: responsibility.id,
      description: responsibility.description,
      objectives: responsibility.objectives,
      allowedInitiators: responsibility.allowed_initiators
        ? {
            agents: responsibility.allowed_initiators.agents,
            schedules: responsibility.allowed_initiators.schedules,
          }
        : undefined,
      autonomy: responsibility.autonomy
        ? {
            default: responsibility.autonomy.default,
            writesRequireConfirmation: responsibility.autonomy.writes_require_confirmation,
            purchaseOrPayment: responsibility.autonomy.purchase_or_payment,
          }
        : undefined,
      collaboration: responsibility.collaboration
        ? {
            canRequest: responsibility.collaboration.can_request?.map((entry) => ({
              agent: entry.agent,
              purposes: entry.purposes,
            })),
            canFulfill: responsibility.collaboration.can_fulfill?.map((entry) => ({
              purpose: entry.purpose,
              maxTurns: entry.max_turns,
              maxDurationSeconds: entry.max_duration_seconds,
              maxToolCalls: entry.max_tool_calls,
              visibilityModes: entry.visibility_modes,
            })),
          }
        : undefined,
    })),
  };
}

export interface V2MemoryScope {
  canonicalAgentId: string;
  aliasAgentIds: string[];
}

function uniqueMemoryAgentIds(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const agentIds: string[] = [];

  for (const value of values) {
    const agentId = value?.trim();
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    agentIds.push(agentId);
  }

  return agentIds;
}

export function resolveV2MemoryScope(
  agentId: string,
  config?: Pick<V2AgentConfig, "id" | "memory"> | null,
): V2MemoryScope {
  const canonicalAgentId = config?.memory.canonicalAgentId?.trim() || agentId;
  const aliasAgentIds = uniqueMemoryAgentIds([
    canonicalAgentId,
    config?.id,
    agentId,
    ...(config?.memory.aliasAgentIds ?? []),
  ]);

  return {
    canonicalAgentId,
    aliasAgentIds: aliasAgentIds.length > 0 ? aliasAgentIds : [canonicalAgentId],
  };
}

export function loadV2AgentConfig(configPath: string): V2AgentConfig {
  const resolvedConfigPath = resolveConfiguredPath(configPath);
  const raw = fs.readFileSync(resolvedConfigPath, "utf8");
  return parseV2AgentConfig(yaml.load(raw));
}

export function loadAllV2AgentConfigs(configDir = "config/v2/agents"): Map<string, V2AgentConfig> {
  const resolvedConfigDir = resolveConfiguredPath(configDir);
  if (!fs.existsSync(resolvedConfigDir)) {
    return new Map();
  }
  const files = fs
    .readdirSync(resolvedConfigDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort((left, right) => left.localeCompare(right));
  const configs = new Map<string, V2AgentConfig>();

  for (const file of files) {
    const config = loadV2AgentConfig(`${resolvedConfigDir}/${file}`);
    configs.set(config.id, config);
  }

  return configs;
}

function findV2AgentConfigDir(baseDir: string): string | undefined {
  let current = resolveConfiguredPath(baseDir);

  while (true) {
    for (const candidate of [
      path.join(current, "v2", "agents"),
      path.join(current, "config", "v2", "agents"),
    ]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function loadLayeredV2AgentConfigs(configDir?: string): Map<string, V2AgentConfig> {
  const rawConfigs = new Map<string, Record<string, unknown>>();
  const seenV2Dirs = new Set<string>();

  for (const layer of resolveConfigLayers(configDir)) {
    const v2Dir = findV2AgentConfigDir(layer.dir);
    if (!v2Dir) {
      continue;
    }

    const resolvedV2Dir = fs.realpathSync(v2Dir);
    if (seenV2Dirs.has(resolvedV2Dir)) {
      continue;
    }
    seenV2Dirs.add(resolvedV2Dir);

    const files = fs
      .readdirSync(v2Dir)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .sort((left, right) => left.localeCompare(right));

    const seenIds = new Set<string>();
    for (const file of files) {
      const fullPath = path.join(v2Dir, file);
      const rawDocument = yaml.load(fs.readFileSync(fullPath, "utf8"));
      if (!isPlainObject(rawDocument)) {
        throw new Error(`V2 agent config file ${fullPath} must contain a YAML object.`);
      }
      const id = z.object({ id: z.string().min(1) }).passthrough().parse(rawDocument).id;
      if (seenIds.has(id)) {
        throw new Error(`Duplicate v2 agent config id '${id}' within ${v2Dir}.`);
      }
      seenIds.add(id);

      const existing = rawConfigs.get(id);
      rawConfigs.set(
        id,
        existing
          ? deepMergeValues(existing, rawDocument) as Record<string, unknown>
          : cloneValue(rawDocument),
      );
    }
  }

  const configs = new Map<string, V2AgentConfig>();
  for (const [id, rawConfig] of [...rawConfigs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const parsed = rawV2AgentConfigSchema.safeParse(rawConfig);
    if (!parsed.success && Object.keys(rawConfig).every((key) => key === "id" || isProfileOnlyV2AgentField(key))) {
      continue;
    }
    configs.set(id, parseV2AgentConfig(rawConfig));
  }

  return configs;
}

function isProfileOnlyV2AgentField(key: string): boolean {
  return key === "access"
    || key === "avatar_url"
    || key === "current_turn_metadata"
    || key === "discord"
    || key === "enabled"
    || key === "memory"
    || key === "orchestration"
    || key === "provider"
    || key === "runtime"
    || key === "tools"
    || key === "voice";
}

export function isV2RuntimeEnabled(config: V2AgentConfig): boolean {
  return isV2AgentEnabled(config) && config.runtime.provider === "claude-code-v2";
}

export function isV2AgentEnabled(config: V2AgentConfig): boolean {
  return config.enabled !== false;
}
