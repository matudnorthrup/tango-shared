#!/usr/bin/env node
/**
 * MCP Wellness Tool Server — Standalone server for Claude CLI.
 *
 * Exposes wellness tools (nutrition, health, workout) as MCP tools.
 *
 * Two transport modes:
 *
 * 1. **stdio** (default): Spawned by the Claude CLI via --mcp-config.
 *    Each CLI invocation spawns a new process (60-90s cold start).
 *    Usage: node mcp-wellness-server.js
 *
 * 2. **http** (persistent): Started once on tango boot, serves all workers.
 *    Workers connect via the thin mcp-proxy.ts bridge (~100ms startup).
 *    Usage: node mcp-wellness-server.js --http [--port 9100]
 *
 * In HTTP mode, the worker identity comes from the X-Worker-ID request header
 * (set by the proxy). Governance filtering is done per-request.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  createNutritionTools,
  createHealthTools,
  createWorkoutTools,
  createJulesFilesTools,
} from "./wellness-agent-tools.js";
import { createAllPersonalTools } from "./personal-agent-tools.js";
import { createAllResearchTools } from "./research-agent-tools.js";
import { createBrowserTools } from "./browser-agent-tools.js";
import { createStudyLibraryTools, studyLibraryActionLooksMutating } from "./study-library-agent-tools.js";
import { createTangoTools } from "./tango-agent-tools.js";
import { createDevTools } from "./tango-dev-tools.js";
import { createDiscordManageTools } from "./discord-manage-tools.js";
import { createDiscordSendImageTools } from "./discord-send-image-tools.js";
import { createBackgroundJobTools } from "./background-job-tools.js";
import { createScreenTools } from "./screen-tools.js";
import { createDeskMailTools } from "./desk-mail-tools.js";
import { createAgentInboxTools } from "./agent-inbox-tools.js";
import { createOnePasswordTools } from "./onepassword-agent-tools.js";
import { createMemoryTools } from "./memory-agent-tools.js";
import { applyMemoryScopeToToolArgs } from "./memory-tool-scope.js";
import { createAttachmentTools } from "./attachment-agent-tools.js";
import { createTodoistTools, todoistOperationLooksReadOnly } from "./todoist-agent-tools.js";
import { createTodoistManagementTools, todoistManagementOperationLooksReadOnly } from "./todoist-management-tools.js";
import { createLinearTools } from "./linear-agent-tools.js";
import { createSlackTools, slackActionLooksReadOnly } from "./slack-tools.js";
import { createYouTubeTools } from "./youtube-agent-tools.js";
import { createWellnessDbTools, wellnessDbToolLooksReadOnly } from "./wellness-db-tools.js";
import { createEmailAgentTools, emailAgentToolLooksReadOnly } from "./email-agent-tools.js";
import { createKiloLedgerTools, kiloLedgerToolLooksReadOnly } from "./kilo-ledger-tools.js";
import { bankTransferActionLooksReadOnly, createBankTransferTools } from "./bank-transfer-tools.js";
import { createSafetyAlertTools } from "./safety-alert-tools.js";
import { createTrainingLogTools, trainingLogToolLooksReadOnly } from "./training-log-tools.js";
import { createNotionTools, notionOperationLooksReadOnly } from "./notion-agent-tools.js";
import { createThingsTools } from "./things-agent-tools.js";
import { createDayOneTools } from "./dayone-agent-tools.js";
import { createClaudeSessionTools } from "./claude-session-tools.js";
import { createOrientationNudgeTools, orientationNudgeToolLooksReadOnly } from "./orientation-nudge.js";
import { buildCollaborationToolPresentation, createCollaborationTools } from "./collaboration-agent-tools.js";
import { createStateTools } from "./state-agent-tools.js";
import { createOffroadTools } from "./offroad-agent-tools.js";
import { isReadOnlyGogDocsCommand } from "./gog-docs-access.js";
import { isReadOnlyGogEmailCommand } from "./gog-email-access.js";
import { buildMcpListedTool } from "./mcp-tool-metadata.js";
import { getListedToolAccessLevel } from "./mcp-tool-visibility.js";
import {
  GovernanceChecker,
  loadLayeredV2AgentConfigs,
  resolveConfigDir,
  resolveDatabasePath,
  resolveV2MemoryScope,
} from "@tango/core";
import type { AgentTool, AccessLevel, V2AgentConfig, V2MemoryScope } from "@tango/core";

// Debug logging via stderr (safe — MCP protocol uses stdout only)
const debug = (...args: unknown[]) => {
  console.error("[mcp-wellness]", ...args);
};

const EMPTY_ALLOWED_TOOL_IDS = "__none__";

let memoryScopeByWorkerId: Map<string, V2MemoryScope> | null = null;
let v2Configs: ReadonlyMap<string, V2AgentConfig> | null = null;

function getV2Configs(): ReadonlyMap<string, V2AgentConfig> {
  if (v2Configs) {
    return v2Configs;
  }

  try {
    const configDir = resolveConfigDir(process.env.TANGO_CONFIG_DIR);
    v2Configs = loadLayeredV2AgentConfigs(configDir);
  } catch (error) {
    debug("V2 configuration loading failed:", error instanceof Error ? error.message : String(error));
    v2Configs = new Map();
  }

  return v2Configs;
}

function getMemoryScopeByWorkerId(): Map<string, V2MemoryScope> {
  if (memoryScopeByWorkerId) {
    return memoryScopeByWorkerId;
  }

  try {
    const configs = getV2Configs();
    memoryScopeByWorkerId = new Map(
      [...configs.entries()].map(([agentId, config]) => [
        agentId,
        resolveV2MemoryScope(agentId, config),
      ]),
    );
  } catch (error) {
    debug("V2 memory scope loading failed:", error instanceof Error ? error.message : String(error));
    memoryScopeByWorkerId = new Map();
  }

  return memoryScopeByWorkerId;
}

function resolveWorkerId(principalId: string | null): string | null {
  const prefix = "worker:";
  if (!principalId?.startsWith(prefix)) {
    return null;
  }
  const workerId = principalId.slice(prefix.length).trim();
  return workerId || null;
}

function resolveWorkerMemoryScope(principalId: string | null): {
  workerId: string;
  memoryScope: V2MemoryScope | null;
} | null {
  const prefix = "worker:";
  if (!principalId?.startsWith(prefix)) {
    return null;
  }
  const workerId = principalId.slice(prefix.length).trim();
  if (!workerId) {
    return null;
  }
  return {
    workerId,
    memoryScope: getMemoryScopeByWorkerId().get(workerId) ?? null,
  };
}

/**
 * Runtime context the SERVER supplies to a handler. These are never accepted
 * from the caller: they carry identity and provenance, so a model that could
 * set them itself could impersonate another agent.
 */
const RUNTIME_CONTEXT_KEYS = new Set([
  "_requester_agent_id",
  "_conversation_key",
  "_turn_id",
  "_message_id",
  "_channel_id",
  "_thread_id",
]);

function stripRuntimeContextKeys(args: Record<string, unknown>): Record<string, unknown> {
  let found = false;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (RUNTIME_CONTEXT_KEYS.has(key)) {
      found = true;
      continue;
    }
    clean[key] = value;
  }
  if (found) debug("dropped caller-supplied runtime-context keys from tool args");
  return clean;
}

// ---------------------------------------------------------------------------
// Thread session storage (reuses the same DB path as governance)
// ---------------------------------------------------------------------------

function createThreadSessionStorage(): { setThreadSession(threadId: string, sessionId: string, agentId: string): void } | undefined {
  try {
    const dbPath = resolveDatabasePath(process.env.TANGO_DB_PATH);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    debug("Thread session storage initialized");
    return {
      setThreadSession(threadId: string, sessionId: string, agentId: string): void {
        db.prepare(
          `INSERT INTO discord_thread_sessions (thread_id, session_id, agent_id)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             session_id = excluded.session_id,
             agent_id = excluded.agent_id`
        ).run(threadId, sessionId, agentId);
      },
    };
  } catch (err) {
    debug("Thread session storage init failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

const threadSessionStorage = createThreadSessionStorage();

// ---------------------------------------------------------------------------
// Tool initialization (shared by both modes)
// ---------------------------------------------------------------------------

const allTools: AgentTool[] = [
  ...createNutritionTools(),
  ...createHealthTools(),
  ...createWorkoutTools(),
  ...createJulesFilesTools(),
  ...createAllPersonalTools(),
  ...createAllResearchTools(),
  ...createBrowserTools(),
  ...createStudyLibraryTools(),
  ...createTangoTools(),
  ...createDevTools(),
  ...createDiscordManageTools({ storage: threadSessionStorage }),
  ...createDiscordSendImageTools(),
  ...createBackgroundJobTools(),
  ...createScreenTools(),
  ...createDeskMailTools(),
  ...createAgentInboxTools(),
  ...createOnePasswordTools(),
  ...createMemoryTools(),
  ...createAttachmentTools(),
  ...createLinearTools(),
  ...createSlackTools(),
  ...createYouTubeTools(),
  ...createWellnessDbTools(),
  ...createEmailAgentTools(),
  ...createKiloLedgerTools(),
  ...createBankTransferTools(),
  ...createSafetyAlertTools(),
  ...createTrainingLogTools(),
  ...createNotionTools(),
  ...createTodoistTools(),
  ...createTodoistManagementTools(),
  ...createThingsTools(),
  ...createDayOneTools(),
  ...createClaudeSessionTools(),
  ...createOrientationNudgeTools(),
  ...createCollaborationTools(),
  ...createStateTools(),
  ...createOffroadTools(),
];

debug(`Loaded ${allTools.length} tools:`, allTools.map((t) => t.name).join(", "));

const handlerMap = new Map(allTools.map((t) => [t.name, t.handler]));
const FATSECRET_WRITE_METHODS = new Set([
  "food_entry_create",
  "food_entry_edit",
  "food_entry_delete",
]);
const READ_ONLY_TANGO_FILE_OPERATIONS = new Set([
  "read",
  "stat",
  "list",
  "glob",
  "find",
  "search",
  "exists",
]);
const READ_ONLY_PRINTER_ACTIONS = new Set([
  "status",
  "get_status",
  "job_status",
  "state",
  "info",
  "get_info",
  "list",
]);

function getCommandHead(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value.trim().toLowerCase().split(/\s+/u).filter((part) => part.length > 0);
}

function looksLikeLinearReadQuery(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  return !/^\s*mutation\b/iu.test(value);
}

function isReadOnlyGogCalendarCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return head[0] === "calendar" && head[1] === "events";
}

function isReadOnlyObsidianCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  if (head[0] === "print" || head[0] === "search-content") {
    return true;
  }
  return head[0] === "frontmatter" && head.includes("--print");
}

function isReadOnlyIMessageCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return head[0] === "chats" || head[0] === "history";
}

function sanitizeToolArgsForLog(name: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sensitiveKeyPattern = /password|secret|token|credential|authorization|otp|one[-_]?time|passcode/iu;
  const sanitize = (value: unknown, key = ""): unknown => {
    if (name.startsWith("things_") && ["title", "notes", "query", "tags"].includes(key)) return "[redacted]";
    if (sensitiveKeyPattern.test(key)) {
      return "[redacted]";
    }
    if (name === "browser" && ["value", "text"].includes(key)) {
      return "[redacted]";
    }
    if (name === "slack" && key === "query") {
      return "[redacted]";
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item));
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        output[childKey] = sanitize(childValue, childKey);
      }
      return output;
    }
    return value;
  };

  return sanitize(args ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Governance initialization
// ---------------------------------------------------------------------------

function createGovernance(): GovernanceChecker | null {
  try {
    const dbPath = resolveDatabasePath(process.env.TANGO_DB_PATH);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    const gov = new GovernanceChecker(db);
    debug("Governance checker initialized");
    return gov;
  } catch (err) {
    debug(`Governance init failed, allowing all tools:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function parseAllowedToolIds(value: string | undefined): Set<string> | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized === EMPTY_ALLOWED_TOOL_IDS) {
    return new Set<string>();
  }

  return new Set(
    normalized
      .split(",")
      .map((toolId) => toolId.trim())
      .filter((toolId) => toolId.length > 0),
  );
}

function getToolsForWorker(
  governance: GovernanceChecker | null,
  principalId: string | null,
  allowedToolIds: Set<string> | null,
): AgentTool[] {
  const governanceTools = (!principalId || !governance)
    ? allTools
    : allTools.filter((tool) => {
      return getListedToolAccessLevel(governance, principalId, tool.name) !== null;
    });

  if (!allowedToolIds) {
    return governanceTools;
  }

  return governanceTools.filter((tool) => allowedToolIds.has(tool.name));
}

function buildListedToolForWorker(
  tool: AgentTool,
  governance: GovernanceChecker | null,
  accessOverride: "read" | "write" | null | undefined,
  principalId: string | null,
): ReturnType<typeof buildMcpListedTool> {
  const listed = buildMcpListedTool(tool, governance, accessOverride);
  if (tool.name !== "collaborate_with_agent") {
    return listed;
  }

  return {
    ...listed,
    ...buildCollaborationToolPresentation(listed, resolveWorkerId(principalId), getV2Configs()),
  };
}

function isToolExplicitlyAllowed(name: string, allowedToolIds: Set<string> | null): boolean {
  return !allowedToolIds || allowedToolIds.has(name);
}

function isReadOnlySql(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  if (/^with\b/i.test(normalized)) {
    return !/\b(?:insert|update|delete)\b/i.test(normalized);
  }
  return /^(select|pragma|explain)\b/i.test(normalized);
}

function inferRequestedAccessLevel(
  name: string,
  args: Record<string, unknown>,
  governance: GovernanceChecker | null,
): AccessLevel {
  switch (name) {
    case "fatsecret_api": {
      const method = typeof args.method === "string" ? args.method.trim() : "";
      return FATSECRET_WRITE_METHODS.has(method) ? "write" : "read";
    }
    case "workout_sql":
      return isReadOnlySql(args.sql) ? "read" : "write";
    case "discord_manage":
    case "spawn_claude_session":
    case "discord_send_image":
    case "background_job":
    case "screen":
    case "things_write":
    case "dayone_write":
    case "collaborate_with_agent":
      return "write";
    case "things_read":
    case "dayone_read":
      return "read";
    case "agent_inbox":
      return args.action === "mark" ? "write" : "read";
    case "tango_file": {
      const operation = typeof args.operation === "string" ? args.operation.trim().toLowerCase() : "";
      return READ_ONLY_TANGO_FILE_OPERATIONS.has(operation) ? "read" : "write";
    }
    case "printer_command": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return READ_ONLY_PRINTER_ACTIONS.has(action) ? "read" : "write";
    }
    case "paper_print": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      if (action === "list_printers" || action === "preview" || args.dry_run !== false) {
        return "read";
      }
      return "write";
    }
    case "lunch_money": {
      const method = typeof args.method === "string" ? args.method.trim().toUpperCase() : "GET";
      return method === "GET" ? "read" : "write";
    }
    case "gog_email":
      return isReadOnlyGogEmailCommand(args.command) ? "read" : "write";
    case "gog_calendar":
      return isReadOnlyGogCalendarCommand(args.command) ? "read" : "write";
    case "gog_docs":
      return isReadOnlyGogDocsCommand(args.command) ? "read" : "write";
    case "obsidian":
      return isReadOnlyObsidianCommand(args.command) ? "read" : "write";
    case "imessage":
      return isReadOnlyIMessageCommand(args.command) ? "read" : "write";
    case "linear":
      return looksLikeLinearReadQuery(args.query) ? "read" : "write";
    case "slack":
      return slackActionLooksReadOnly(args.action) ? "read" : "write";
    case "todoist_manage":
      return todoistManagementOperationLooksReadOnly(args.operation) ? "read" : "write";
    case "todoist":
      return todoistOperationLooksReadOnly(args.operation) ? "read" : "write";
    case "notion":
      return notionOperationLooksReadOnly(args.operation) ? "read" : "write";
    case "orientation_nudge":
      return orientationNudgeToolLooksReadOnly(args.operation) ? "read" : "write";
    case "kilo_ledger":
      return kiloLedgerToolLooksReadOnly(args.operation) ? "read" : "write";
    case "training_log":
      return trainingLogToolLooksReadOnly(args.operation) ? "read" : "write";
    case "bank_transfer":
      return bankTransferActionLooksReadOnly(args.action) ? "read" : "write";
    case "attachment_reprocess":
      return "write";
    case "walmart": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return action.startsWith("history_") || action === "queue_list" ? "read" : "write";
    }
    case "file_ops": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return action === "list" || action === "read" ? "read" : "write";
    }
    case "jules_files": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return action === "list" || action === "read" ? "read" : "write";
    }
    case "browser": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return ["status", "open", "snapshot", "screenshot", "wait", "eval", "connect", "launch", "close", "scroll"].includes(action)
        ? "read"
        : "write";
    }
    case "study_library": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return studyLibraryActionLooksMutating(action) ? "write" : "read";
    }
    default:
      if (name.startsWith("wellnessdb_")) {
        return wellnessDbToolLooksReadOnly(name) ? "read" : "write";
      }
      if (name.startsWith("email_")) {
        return emailAgentToolLooksReadOnly(name) ? "read" : "write";
      }
      return (governance?.getToolAccessType(name) ?? "read") as AccessLevel;
  }
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  governance: GovernanceChecker | null,
  principalId: string | null,
  readOnlyStep: boolean,
  allowedToolIds: Set<string> | null,
  turnProvenance: {
    conversationKey?: string;
    turnId?: string;
    messageId?: string;
    channelId?: string;
    threadId?: string;
  } = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = handlerMap.get(name);

  if (!handler) {
    debug(`tools/call: unknown tool "${name}"`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  if (!isToolExplicitlyAllowed(name, allowedToolIds)) {
    debug(`tools/call: DENIED ${name} for ${principalId || "unknown"} (not allowlisted)`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Tool not allowlisted for this run: ${name}` }) }],
      isError: true,
    };
  }

  // Governance: check permission before executing
  const requestedLevel = inferRequestedAccessLevel(name, args, governance);
  if (readOnlyStep && requestedLevel === "write") {
    debug(`tools/call: DENIED ${name} for ${principalId || "unknown"} (read-only step)`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Read-only step cannot call write tool: ${name}` }) }],
      isError: true,
    };
  }

  if (governance && principalId) {
    const check = governance.checkPermission(principalId, name, requestedLevel);
    if (!check.granted) {
      debug(`tools/call: DENIED ${name} for ${principalId} (${check.resolvedVia})`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Permission denied: ${name} (${check.resolvedVia})` }) }],
        isError: true,
      };
    }
  }

  try {
    const startMs = Date.now();
    const workerScope = resolveWorkerMemoryScope(principalId);
    const scopedArgs = workerScope
      ? applyMemoryScopeToToolArgs(name, args, workerScope.workerId, workerScope.memoryScope)
      : args;
    // `notion` needs the caller's identity to pick that agent's Notion
    // workspace — the routing is a privacy boundary, so it must come from the
    // authenticated worker id, never from a model-supplied argument.
    // `background_job` needs it to report back to the conversation that
    // started the job, and to keep each agent to its own jobs. `screen` uses it
    // so scenes belong to the calling agent and taps return to this conversation.
    // `bank_transfer` checks owner approval against the message that started
    // this turn, so that message id must come from here, never from the model.
    const needsRuntimeContext =
      name === "collaborate_with_agent"
      || name === "bank_transfer"
      || name === "notion"
      || name === "background_job"
      || name === "screen"
      || name === "desk_mail"
      || name === "safety_alert"
      || name === "training_log"
      || name.startsWith("state_");
    const effectiveArgs = needsRuntimeContext
      ? {
          // Drop any caller-supplied runtime-context keys first. Without this a
          // model could pass `_requester_agent_id` itself and, whenever the
          // worker scope is absent, impersonate another agent — which for
          // `notion` would mean selecting a workspace it may not use.
          ...stripRuntimeContextKeys(scopedArgs),
          ...(workerScope ? { _requester_agent_id: workerScope.workerId } : {}),
          ...(turnProvenance.conversationKey ? { _conversation_key: turnProvenance.conversationKey } : {}),
          ...(turnProvenance.turnId ? { _turn_id: turnProvenance.turnId } : {}),
          ...(turnProvenance.messageId ? { _message_id: turnProvenance.messageId } : {}),
          ...(turnProvenance.channelId ? { _channel_id: turnProvenance.channelId } : {}),
          ...(turnProvenance.threadId ? { _thread_id: turnProvenance.threadId } : {}),
        }
      : scopedArgs;
    const result = await handler(effectiveArgs);
    const text = JSON.stringify(result);
    debug(`tools/call: ${name} completed in ${Date.now() - startMs}ms (${text.length} chars)`);
    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    debug(`tools/call: ${name} error:`, error instanceof Error ? error.message : String(error));
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Mode selection: --http or stdio (default)
// ---------------------------------------------------------------------------

const isHttpMode = process.argv.includes("--http");

if (isHttpMode) {
  // ==========================================================================
  // HTTP MODE — Persistent server, handles JSON-RPC over HTTP
  // ==========================================================================

  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1]!, 10) : parseInt(process.env.MCP_SERVER_PORT || "9100", 10);

  const governance = createGovernance();

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check endpoint
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tools: allTools.length }));
      return;
    }

    // MCP endpoint — JSON-RPC over POST
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const workerIdHeader = req.headers["x-worker-id"] as string | undefined;
    const principalId = workerIdHeader ? `worker:${workerIdHeader}` : null;
    const readOnlyStep = req.headers["x-read-only-step"] === "1";
    const allowedToolIds = parseAllowedToolIds(req.headers["x-allowed-tool-ids"] as string | undefined);
    const turnProvenance = {
      conversationKey: req.headers["x-tango-conversation-key"] as string | undefined,
      turnId: req.headers["x-tango-turn-id"] as string | undefined,
      messageId: req.headers["x-tango-message-id"] as string | undefined,
      channelId: req.headers["x-tango-channel-id"] as string | undefined,
      threadId: req.headers["x-tango-thread-id"] as string | undefined,
    };

    try {
      const body = await readBody(req);
      const message = JSON.parse(body) as {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };

      let response: Record<string, unknown> | null = null;

      switch (message.method) {
        case "initialize":
          debug(`HTTP initialize (worker=${workerIdHeader || "none"})`);
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: (message.params as Record<string, unknown>)?.protocolVersion || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "wellness", version: "1.0.0" },
            },
          };
          break;

        case "notifications/initialized":
          debug(`HTTP initialized notification (worker=${workerIdHeader || "none"})`);
          res.writeHead(204);
          res.end();
          return;

        case "tools/list": {
          const tools = getToolsForWorker(governance, principalId, allowedToolIds);
          debug(
            `HTTP tools/list: ${tools.length} tools for ${principalId || "all"} ` +
            `readOnly=${readOnlyStep ? "yes" : "no"} ` +
            `allowedTools=${allowedToolIds ? [...allowedToolIds].join(",") || "(none)" : "all"}`,
          );
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: tools.map((t) => buildListedToolForWorker(
                t,
                governance,
                readOnlyStep ? "read" : getListedToolAccessLevel(governance, principalId, t.name),
                principalId,
              )),
            },
          };
          break;
        }

        case "tools/call": {
          const params = message.params as { name: string; arguments?: Record<string, unknown> };
          const argsStr = JSON.stringify(sanitizeToolArgsForLog(params.name, params.arguments));
          debug(
            `HTTP tools/call: ${params.name} (worker=${workerIdHeader || "none"} ` +
            `readOnly=${readOnlyStep ? "yes" : "no"} ` +
            `allowedTools=${allowedToolIds ? [...allowedToolIds].join(",") || "(none)" : "all"}) ` +
            `args=${argsStr.length > 200 ? argsStr.slice(0, 200) + "…" : argsStr}`,
          );
          const toolResult = await executeToolCall(
            params.name,
            params.arguments || {},
            governance,
            principalId,
            readOnlyStep,
            allowedToolIds,
            turnProvenance,
          );
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: toolResult,
          };
          break;
        }

        case "ping":
          response = { jsonrpc: "2.0", id: message.id, result: {} };
          break;

        default:
          if (message.id !== undefined) {
            // Unknown request method — return error
            debug(`HTTP unknown method: ${message.method}`);
            response = {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` },
            };
          } else {
            // Unknown notification — ignore
            res.writeHead(204);
            res.end();
            return;
          }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      debug("HTTP request error:", err instanceof Error ? err.message : String(err));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }));
    }
  });

  httpServer.listen(port, "127.0.0.1", () => {
    debug(`HTTP MCP server listening on http://127.0.0.1:${port}/mcp`);
    // Signal readiness to parent process
    if (process.send) {
      process.send({ type: "ready", port });
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    debug("Shutting down HTTP MCP server...");
    httpServer.close(() => {
      debug("HTTP MCP server closed");
      process.exit(0);
    });
    // Force exit after 5s if close doesn't complete
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

} else {
  // ==========================================================================
  // STDIO MODE — Original behavior, spawned per worker invocation
  // ==========================================================================

  const workerId = process.env.WORKER_ID;
  const principalId = workerId ? `worker:${workerId}` : null;
  const readOnlyStep = process.env.READ_ONLY_STEP === "1";
  const allowedToolIds = parseAllowedToolIds(process.env.ALLOWED_TOOL_IDS);
  const turnProvenance = {
    conversationKey: process.env.TANGO_CONVERSATION_KEY,
    turnId: process.env.TANGO_TURN_ID,
    messageId: process.env.TANGO_MESSAGE_ID,
    channelId: process.env.TANGO_DISCORD_CHANNEL_ID,
    threadId: process.env.TANGO_DISCORD_THREAD_ID,
  };
  const governance = createGovernance();
  const visibleTools = getToolsForWorker(governance, principalId, allowedToolIds);

  if (principalId) {
    debug(
      `Governance: worker=${workerId}, readOnly=${readOnlyStep ? "yes" : "no"}, ` +
      `allowedTools=${allowedToolIds ? [...allowedToolIds].join(",") || "(none)" : "all"}, ` +
      `${visibleTools.length}/${allTools.length} tools permitted: ${visibleTools.map((t) => t.name).join(", ")}`,
    );
  }

  const server = new Server(
    { name: "wellness", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    debug(`tools/list requested — returning ${visibleTools.length} tools (readOnly=${readOnlyStep ? "yes" : "no"})`);
    return {
      tools: visibleTools.map((t) => buildListedToolForWorker(
        t,
        governance,
        readOnlyStep ? "read" : getListedToolAccessLevel(governance, principalId, t.name),
        principalId,
      )),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    debug(`tools/call: ${name} readOnly=${readOnlyStep ? "yes" : "no"}`, JSON.stringify(sanitizeToolArgsForLog(name, (args ?? {}) as Record<string, unknown>)));
    return executeToolCall(
      name,
      (args ?? {}) as Record<string, unknown>,
      governance,
      principalId,
      readOnlyStep,
      allowedToolIds,
      turnProvenance,
    );
  });

  debug("Starting MCP wellness server via stdio transport");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("MCP wellness server connected");
}
