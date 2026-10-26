import { splitForDiscord } from "./reply-presentation.js";
import os from "node:os";
import { runConversationTurn, newConversationKey, CONVERSATION_KEY, ConversationMirror, ensureConversationMirror, canAcceptConversationInput, mirrorsPosts, discordMessageToTurn } from "./conversation-turn.js";
import { conversationWrite } from "./conversation-write.js";
import { conversationRead } from "./conversation-read.js";
import { setConversationEvents, recordConversationPost, settleConversationAttachments, isOwnConversationPost, resolveConversationChannel, ConversationDeliveryTracker, type PostAttachment } from "./conversation-posts.js";
import { createScheduledRuntime } from "./scheduled-runtime.js";
import { registerDecisionDeliveries, recoverLoomReplies, recoveredLoomModelRun, LOOM_FAILURE_NOTICE, LOOM_PENDING_NOTICE, pendingLoomRetry, sendPendingLoomRetryNotice } from "./loom-reply-recovery.js";
import { LoomRuntimeAdapter, LoomPendingError, liveLoomDeliveries, type LoomDelivery, type RuntimeResponse } from "@tango/core";
import {
  AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageReferenceType,
  MessageType,
  ThreadAutoArchiveDuration,
  type ForumChannel,
  type GuildMember,
  type Message,
  type NewsChannel,
  type SendableChannels,
  type TextChannel,
  type Webhook,
  type RESTPostAPIApplicationCommandsJSONBody
} from "discord.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fork, execFile, execFileSync, execSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { randomUUID } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { openLedger as openSystemLedger, recordEvent as recordLedgerEvent, type Ledger as SystemLedger } from "@tango/system";
import { memoryEvalRecoveryEvent } from "./memory-eval-event.js";
import {
  AgentRegistry,
  AttachmentJobWorker,
  AttachmentStore,
  type AgentRuntimeConfig,
  assembleSessionMemoryPrompt,
  memoryHasEmbedding,
  buildAttachmentDirectoryContext,
  buildDeterministicConversationMemory,
  buildDeterministicConversationSummary,
  auditPromptSnapshotsWithProvider,
  collectPromptSnapshotAuditSamples,
  cleanupExpiredClaudeArtifacts,
  createVoyageEmbeddingProviderFromEnv,
  emptyToolTelemetry,
  type AgentConfig,
  type AttachmentDirectoryContextTrace,
  type AttachmentLlmFallbackRunner,
  LLM_VISION_FALLBACK_PROMPT_VERSION,
  buildContextPacket,
  buildAttachmentLlmFallbackPrompt,
  buildAttachmentLlmFallbackResultFromProviderOutput,
  type ContextPacket,
  type ChatProvider,
  type EmbeddingProvider,
  type DeadLetterInsertInput,
  estimateConversationImportance,
  estimateTokenCount,
  extractExecutionTrace,
  extractMemoryKeywords,
  extractToolTelemetry,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  formatExecutionTraceForLog,
  indexObsidianVault,
  backfillMissingMemoryEmbeddings,
  resolveTangoProfileDir,
  type ModelRunRecord,
  type MessageInsertInput,
  type ModelRunInsertInput,
  type OrchestratorContinuityMode,
  type PromptSnapshotInsertInput,
  type ProviderReasoningEffort,
  type ProviderSessionRecord,
  resolveSessionMemoryConfig,
  type SessionMemoryPromptTrace,
  type TopicRecord,
  formatAttachmentBacklogWatchdogSummary,
  formatAttachmentRetentionSweepSummary,
  loadAttachmentRetentionPolicy,
  runAttachmentBacklogWatchdog,
  runAttachmentRetentionSweep,
  createBuiltInProviderRegistry,
  OllamaProvider,
  McpHttpToolClient,
  DEFAULT_MCP_HTTP_PORT,
  createAttachmentProcessingHandlers,
  resolveProviderCandidates,
  resolveAgentToolPolicy,
  serializeEmbedding,
  selectProviderByName,
  resolveProviderToolsForAgent,
  selectMemoriesToArchive,
  type SessionConfig,
  loadUnifiedAgentConfigs,
  loadMemoryEvalConfig,
  loadSessionConfigs,
  loadScheduleConfigs,
  loadStateTypePackConfigs,
  loadStateViewConfigs,
  renderMemoryEvalDiscordSummary,
  renderMemoryEvalMarkdownReport,
  buildRuntimePathEnv,
  buildCurrentTurnMetadataPrompt,
  buildTurnBriefingPrompt,
  resolveConfigDir,
  resolveConfiguredPath,
  resolveDatabasePath,
  resolveTangoDataDir,
  loadLayeredV2AgentConfigs,
  renderContextPacket,
  planSessionCompaction,
  SessionManager,
  TangoStorage,
  SchedulerService,
  type ScheduleConfig,
  type V2ScheduledTurnExecuteFn,
  registerDeterministicHandler,
  registerPreCheckHandler,
  runMemoryEvalBenchmarks,
  assembleV2SystemPrompt,
  resolveTangoProfileAgentPromptDirs,
  resolveV2MemoryScope,
  contactsSyncHandler,
  isRuntimeAbortedError,
  isV2RuntimeEnabled,
  shouldSendContextPressureAlert,
  extractResponderContextUsage,
  type LastContextUsageSnapshot,
  type V2AgentConfig,
  type ProviderImageInput,
  findRepoLayerPersonalPromptFindings,
  type PromptLayerAuditFinding,
  AgentCollaborationService,
  StateService,
  describeModelRoles,
  fetchOllamaCatalog,
  tryResolveOllamaModelName,
  resolveTangoProfileDataDir,
  loadSystemIdentity,
} from "@tango/core";
import { runAtlasScheduledReflections } from "./atlas-memory-reflection.js";
import { printerMonitorHandler } from "./printer-monitor.js";
import { runSiteSessionKeepalive } from "./site-session.js";
import {
  createDailyNoteBootstrapHandler,
  createMorningFlowSentinelHandler,
} from "./morning-flow.js";
import { createDailyBriefAggregationHandler } from "./daily-brief-aggregator.js";
import { createKiloLedgerMonitorHandler } from "./kilo-ledger-monitor.js";
import { isChannelAllowed, parseAllowedChannels } from "./allowed-channels.js";
import { createActiveThreadsTracker } from "./active-threads-tracker.js";
import {
  createOrientationNudgeHandler,
  handleOrientationNudgeInteraction,
  OrientationNudgeStore,
  resolveOrientationNudgeConfig,
} from "./orientation-nudge.js";
import {
  appendInterstitialLogEntry,
  parseInterstitialStatusCapture,
} from "./interstitial-log-capture.js";
import { coerceWorkerReplyForDisplay } from "./worker-text-sanitizer.js";
import { createV2RuntimeFailureRecovery } from "./v2-runtime-recovery.js";
import { resolveExtractionProvider } from "./extraction-provider.js";
import { z } from "zod";
import {
  buildDefaultAccessPolicy,
  evaluateAccess,
  extractConfiguredDiscordChannelIds,
  parseCsvIds,
  resolveAccessPolicy
} from "./access-control.js";
import {
  type ProviderRequestAttempt,
  type ProviderContinuityMap,
  type ProviderFailoverFailure,
  ProviderFailoverError,
  generateWithFailover
} from "./provider-failover.js";
import { applySessionProviderCommand, mergeProviderOrder } from "./session-provider-command.js";
import { applyThreadSessionRoute } from "./thread-route.js";
import {
  HttpVoiceBridge,
  ProjectDirectory,
  buildDefaultSessionKey,
  extractChannelIdFromSessionKey,
  buildProjectSessionId,
  parseProjectSessionId,
  buildTopicSessionId,
  formatCurrentTopicMessage,
  formatOpenedTopicMessage,
  normalizeTopicSlug,
  VoiceTargetDirectory,
  type VoiceTurnInput,
  type VoiceTurnResult
} from "@tango/voice";
import {
  buildVoiceTurnResultFromReceipt,
  createVoiceReplyProgress,
  deliverVoiceReplyWithRetry,
  registerVoiceThread,
  sendVoiceReply,
  resolveVoiceDiscordDelivery,
  type VoiceReplyProgress,
} from "./voice-discord-delivery.js";
import { canonicalVoiceConversation } from "./conversation-identity.js";
import {
  createDeskEventsClient,
  NOOP_DESK_TURN,
  runtimeErrorResponseFailure,
  type DeskTurnIdentity,
  type DeskTurnTracker,
} from "./desk-events.js";
import { getSecret } from "./op-secret.js";
import {
  waitForVoiceTurnReceiptResolution
} from "./voice-turn-receipts.js";
import {
  createReplyPresenter,
  DeliveryError,
  resolveSpeakerAvatarPath,
  resolveSpeakerAvatarURL,
  resolveSpeakerDisplayName,
  type PresentedReplyResult,
} from "./reply-presentation.js";
import { createAgentCollaborationDiscordPresenter } from "./collaboration-presentation.js";
import {
  createAgentTypingPresenter,
  resolveAgentTypingToken,
} from "./agent-typing-presenter.js";
import { IMessageListener, type IMessageInboundMessage } from "./imessage-listener.js";
import {
  parseNaturalTextRoute,
  type NaturalTextRoute,
  type NaturalTextSystemCommand,
} from "./natural-routing.js";
import { resolveTargetAgent } from "./target-agent.js";
import { processAttachments, cleanupAttachments } from "./attachment-processor.js";
import { resolveWarmStartContinuityMode } from "./orchestrator-continuity.js";
import {
  buildPromptWithReferent,
  buildReferentSystemMessage,
  shouldPreferReferentSession,
  type MessageReferent,
} from "./message-referents.js";
import { buildScheduledReviewContext, isOpenScheduleModel, selectScheduledActiveTasks, selectScheduledAgent, SCHEDULED_REVIEW_GUIDANCE } from "./scheduled-review-context.js";
import { selectWarmStartMessages } from "./channel-surface-context.js";
import {
  buildReceiptCatalogDateWindow,
  buildReimbursementGapCandidates,
  buildMissingReceiptCandidates,
  collectReceiptLinkIndex,
  formatReimbursementGapCandidateDetails,
  formatReceiptCatalogCandidateDetails,
  RECEIPT_CATALOG_UNCLEARED_LOOKBACK_DAYS,
} from "./receipt-catalog-precheck.js";
import { resolveDefaultReceiptRoot } from "./receipt-paths.js";
import {
  fetchLunchMoneyCategoryNames,
  findInvalidSuggestedCategories,
  formatInvalidCategoryDetails,
  formatValidCategories,
} from "./receipt-categories.js";
import {
  findBudgetNeutralInternalTransfers,
  formatBudgetNeutralTransferDetails,
  readFinanceCategorizationRules,
} from "./finance-automation.js";
import {
  applySlotNickname,
  initializeSlotMode,
  isSlotModeActive,
  resetBotNickname,
  shouldInitializeSlotMode,
  shouldRunSchedulerTickLoop,
} from "./slot-mode.js";
import {
  buildSavePassEphemeralReply,
  matchesPendingSessionSave,
  buildSendContextWithOptionalSavePass,
  buildV2ConversationKey,
  mergeSendContext,
} from "./session-ops.js";
import {
  buildContextPressureInThreadAlert,
  buildContextRotationInThreadAlert,
  buildContextSlashReply,
} from "./context-visibility.js";
import {
  parseSnapshotTimestamp,
  resolvePersistedContextReadings,
  toLastContextUsageSnapshot,
} from "./context-snapshots.js";
import { isSmokeTestThreadWebhookMessage, loadReplyWebhookIds } from "./smoke-test-webhook.js";
import { deskReplyContent, deskReplyText, isOwnerOnlyChannel, loadOwnerPersona, refreshGuildMembers } from "./desk-reply.js";
import {
  intakeSenderId,
  loadIntakeWebhookEntries,
  resolveIntakeWebhookMessage,
  type IntakeWebhookEntry,
} from "./intake-webhook.js";
import {
  BackgroundJobManager,
  formatBackgroundJobCompletion,
  handleBackgroundJobRequest,
  type BackgroundJob,
} from "./background-jobs.js";
import { buildModelScorecard, loadEvaluatedModels } from "./model-scorecard.js";
import { runModelIntake, spawnScreenFixture } from "./model-intake.js";
import { AtlasMemoryClient } from "./atlas-memory-client.js";
import { TangoRouter } from "./tango-router.js";
import { createStateHttpServer } from "./state-http-server.js";
import { StateObsidianAdapter } from "./state-obsidian-adapter.js";
import { StateHealthAutoExportAdapter } from "./state-health-adapter.js";
import { runStateMemorySupersession } from "./state-memory-supersession.js";
import { StateLifecycleRunner } from "./state-lifecycle.js";
import { StateSchedulerAdapter } from "./state-scheduler-adapter.js";
import { StateProjectionRunner } from "./state-projection.js";
import { installStateTypePacks } from "./state-type-packs.js";
import { ensureWellnessDb } from "./wellness-db-migrations.js";
import {
  buildV2EnabledAgentSet,
  buildV2RuntimeConfigs,
  buildStateMcpServerConfig,
  createAtlasColdStartContextBuilder,
  createV2PostTurnHook,
  agentMcpIdentityEnv,
  isOllamaBackedAgent,
  resolveV2RuntimeTimeoutMs,
  routeV2MessageIfEnabled,
  shutdownV2Runtime,
  type FeatureFlaggedRouteRequest,
  type FeatureFlaggedRouteResult,
} from "./v2-runtime.js";
import {
  buildStateFilePointer,
  conversationKeyFor,
  refreshProjectHeadOnTurn,
  renderProjectStateBlock,
  resolveStateProfileRoot,
  resolveStateVaultRoot,
} from "./project-state.js";
import {
  renderActiveTasksWarmStartBlock,
  scheduleActiveTaskPostTurn,
} from "./active-task-continuation.js";
import {
  buildVoiceRouterErrorResult,
  buildVoiceRouterResult,
  classifyVoiceRouterFailure,
  dispatchVoiceTurnByRuntime,
  voiceTurnFailureMetadata,
  VOICE_RESPONSE_FORMATTING_SYSTEM_PROMPT,
  VOICE_V2_TTS_ERROR_MESSAGE,
} from "./voice-turn-runtime-routing.js";
import {
  isVictorManualConsoleBridgeActive,
  sendToVictorInbox,
  waitForVictorResponse,
  type VictorBridgeMessage,
} from "./victor-bridge.js";
import { installFileLogMirror } from "./file-logger.js";
import { chooseMcpPort, mcpServerPids, staleMcpServerPids } from "./port-listeners.js";
import { ThreadFollowers, threadFollowersByChannel } from "./thread-followers.js";
import {
  loadAtlasWarmStartMemory,
  loadCoreWarmStartMemory,
  mapAtlasContextRows,
  resolveWarmStartMemorySubstrate,
  type WarmStartMemoryBundle,
} from "./warm-start-memory-source.js";

export * from "./tango-router.js";

dotenv.config();

installFileLogMirror({ dir: path.join(resolveTangoProfileDir(), "logs") });

// Set when the scheduler wires its Discord alert sink; lets deterministic
// handlers (e.g. memory-eval-report) raise alerts beyond job-crash cases.
let schedulerAlert: ((channelId: string, content: string) => Promise<void>) | undefined;

// Store consolidation: which substrate backs warm-start distilled memory.
const warmStartMemorySubstrate = resolveWarmStartMemorySubstrate();
console.log(`[tango-memory] warm-start memory substrate=${warmStartMemorySubstrate}`);

const slotModeActive = isSlotModeActive(process.env);
let allowedChannels = parseAllowedChannels(process.env.DISCORD_ALLOWED_CHANNELS);
const shouldProvisionSlotMode = shouldInitializeSlotMode(process.env, allowedChannels);
if (shouldProvisionSlotMode) {
  allowedChannels = new Set();
}

type ResponseMode = "concise" | "explain";

interface WarmStartContextDiagnostics {
  strategy: "session-memory-prompt" | "context-packet" | "attachment-directory-context" | "none";
  orchestratorContinuityMode: OrchestratorContinuityMode;
  /** Which store backed the distilled-memory zones for this turn. */
  memorySubstrate?: "atlas" | "core";
  channelSurfaceSupplementalMessages?: number;
  error?: string;
  memoryPrompt?: {
    estimatedTokens: number;
    usedFullHistory: boolean;
    trace: SessionMemoryPromptTrace;
  };
  contextPacket?: ContextPacket;
  attachmentDirectoryContext?: {
    trace: AttachmentDirectoryContextTrace;
    promptChars: number;
  };
  activeTasks?: {
    openCount: number;
    promptChars: number;
  };
}

interface WarmStartContextResult {
  prompt?: string;
  diagnostics: WarmStartContextDiagnostics;
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_TEST_GUILD_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  DISCORD_COMMAND_GUILD_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  DISCORD_LISTEN_ONLY: z.string().default("true"),
  DISCORD_ENABLE_MESSAGE_CONTENT: z.string().default("false"),
  CLAUDE_CLI_COMMAND: z.string().default("claude"),
  CLAUDE_SECONDARY_CLI_COMMAND: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  CLAUDE_HARNESS_COMMAND: z.string().default("claude"),
  CODEX_CLI_COMMAND: z.string().default("codex"),
  CLAUDE_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : "claude-sonnet-5";
    }),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).default("medium"),
  CLAUDE_SECONDARY_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  CLAUDE_SECONDARY_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).optional(),
  CLAUDE_HARNESS_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  CLAUDE_HARNESS_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).optional(),
  CODEX_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : "gpt-6-astra";
    }),
  CODEX_REASONING_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).default("medium"),
  TANGO_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_SECONDARY_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_HARNESS_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CODEX_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("read-only"),
  CODEX_APPROVAL_POLICY: z
    .enum(["untrusted", "on-failure", "on-request", "never"])
    .default("never"),
  OLLAMA_BASE_URL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : "https://ollama.com/v1";
    }),
  OLLAMA_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : "deepseek-v4-pro:cloud";
    }),
  OLLAMA_API_KEY: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_DB_PATH: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_CAPTURE_PROVIDER_RAW: z.string().default("false"),
  TANGO_PROVIDER_RETRY_LIMIT: z.coerce.number().int().min(0).max(3).default(1),
  TANGO_MEMORY_COMPACTION_TRIGGER_TURNS: z.coerce.number().int().min(8).max(200).default(24),
  TANGO_MEMORY_COMPACTION_RETAIN_RECENT_TURNS: z.coerce.number().int().min(2).max(100).default(8),
  TANGO_MEMORY_COMPACTION_SUMMARY_MAX_CHARS: z.coerce.number().int().min(400).max(4000).default(1800),
  TANGO_ACCESS_MODE: z.enum(["off", "allowlist", "mention", "both"]).default("allowlist"),
  TANGO_ALLOWLIST_CHANNEL_IDS: z.string().default(""),
  TANGO_ALLOWLIST_USER_IDS: z.string().default(""),
  TANGO_VOICE_BRIDGE_ENABLED: z.string().default("false"),
  TANGO_VOICE_BRIDGE_HOST: z.string().default("127.0.0.1"),
  TANGO_VOICE_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  TANGO_VOICE_BRIDGE_PATH: z.string().default("/voice/turn"),
  TANGO_MOBILE_VOICE_DISPATCH_PATH: z.string().default("/mobile/voice-dispatch"),
  TANGO_VOICE_BRIDGE_API_KEY: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_VOICE_DEFAULT_SESSION_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_VOICE_DEFAULT_AGENT_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_SCHEDULER_ALERTS_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  /** "ledger": system alerts go to the system ledger (docs/specs/system-visibility.md). */
  TANGO_SYSTEM_ALERTS: z.string().optional(),
  TANGO_SCHEDULER_LOG_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  IMESSAGE_ENABLED: z.string().default("false"),
  IMESSAGE_CLI_PATH: z.string().default("/opt/homebrew/bin/imsg"),
  IMESSAGE_CONTACTS_PATH: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  IMESSAGE_DEFAULT_AGENT: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  IMESSAGE_ALLOW_FROM: z.string().default(""),
  IMESSAGE_GROUP_POLICY: z.enum(["mention", "open", "disabled"]).default("mention"),
  IMESSAGE_TEXT_CHUNK_LIMIT: z.coerce.number().int().min(200).max(16000).default(4000),
  IMESSAGE_DISCORD_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    })
});

const env = envSchema.parse(process.env);
const listenOnly = env.DISCORD_LISTEN_ONLY !== "false";
const enableMessageContent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
const captureProviderRaw = env.TANGO_CAPTURE_PROVIDER_RAW === "true";
const providerRetryLimit = env.TANGO_PROVIDER_RETRY_LIMIT;
const providerTimeoutMs = env.TANGO_PROVIDER_TIMEOUT_MS ?? DEFAULT_PROVIDER_TIMEOUT_MS;
const claudeTimeoutMs = env.CLAUDE_TIMEOUT_MS ?? providerTimeoutMs;
// Run agent-mode scheduled/proactive turns on the Ollama clone (DeepSeek) instead of
// the Claude base agent, so background traffic gets the same off-Anthropic treatment
// as interactive turns. Default on; set TANGO_SCHEDULER_USE_OLLAMA=false to revert.
const SCHEDULER_USE_OLLAMA = (process.env.TANGO_SCHEDULER_USE_OLLAMA ?? "true") !== "false";
// Schedules too heavy for DeepSeek to finish inside the scheduler timeout stay on the
// Claude base agent even when SCHEDULER_USE_OLLAMA is on. The weekly/month-end finance
// reviews are the known offenders: Claude completes the multi-account Plaid+reconcile flow
// in ~280s, but DeepSeek timed out at 600s. These run weekly/monthly so the metering cost
// of keeping them on Claude is negligible, and finance accuracy favors the proven path.
// Comma-separated schedule ids; the "manual-test-" prefix is matched too. Override via env.
const SCHEDULER_OLLAMA_EXCLUDE = new Set(
  (process.env.TANGO_SCHEDULER_OLLAMA_EXCLUDE
    ?? "weekly-finance-review,sinking-fund-reconciliation,sinking-fund-reconciliation-month-end,nightly-email-unsubscribe-review,manual-test-nightly-email-unsubscribe-review")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
// Give Ollama clones same-turn vision: pass inbound image attachment bytes to the
// runtime so the provider folds them through a vision model (gemma4:31b) on the arrival
// turn, instead of relying on async OCR text only (which misses visual/spatial images
// like maps and diagrams). Default on; set TANGO_CLONE_INLINE_VISION=false to revert.
// Caps below bound the base64 payload sent to the vision model.
const CLONE_INLINE_VISION = (process.env.TANGO_CLONE_INLINE_VISION ?? "true") !== "false";
const CLONE_INLINE_VISION_MAX_IMAGES = Number(process.env.TANGO_CLONE_INLINE_VISION_MAX_IMAGES) || 4;
const CLONE_INLINE_VISION_MAX_BYTES = Number(process.env.TANGO_CLONE_INLINE_VISION_MAX_BYTES) || 12_000_000;

// Read inbound image attachments off disk as base64 for same-turn clone vision.
// Skips non-images, empty/oversized files, and unreadable temp files (those still reach
// the clone via the async OCR/attachment_read path). Bounded by the caps above.
function buildCloneInlineImages(
  processed: ReadonlyArray<{ localPath: string; contentType: string | null; type: "image" | "file" }>,
): ProviderImageInput[] {
  const images: ProviderImageInput[] = [];
  for (const att of processed) {
    if (images.length >= CLONE_INLINE_VISION_MAX_IMAGES) break;
    if (att.type !== "image") continue;
    const mediaType = att.contentType && att.contentType.startsWith("image/") ? att.contentType : "image/png";
    try {
      const bytes = fs.readFileSync(att.localPath);
      if (bytes.length === 0 || bytes.length > CLONE_INLINE_VISION_MAX_BYTES) continue;
      images.push({ dataBase64: bytes.toString("base64"), mediaType });
    } catch {
      // Unreadable temp file — skip; the OCR/attachment_read path still applies.
    }
  }
  return images;
}

const claudeSecondaryTimeoutMs = env.CLAUDE_SECONDARY_TIMEOUT_MS ?? claudeTimeoutMs;
const claudeHarnessTimeoutMs = env.CLAUDE_HARNESS_TIMEOUT_MS ?? claudeTimeoutMs;
const codexTimeoutMs = env.CODEX_TIMEOUT_MS ?? providerTimeoutMs;
const claudeSecondaryEffort = env.CLAUDE_SECONDARY_EFFORT ?? env.CLAUDE_EFFORT;
const claudeHarnessEffort = env.CLAUDE_HARNESS_EFFORT ?? env.CLAUDE_EFFORT;
const maxProviderTimeoutMs = Math.max(
  claudeTimeoutMs,
  claudeSecondaryTimeoutMs,
  claudeHarnessTimeoutMs,
  codexTimeoutMs
);
const memoryCompactionTriggerTurns = env.TANGO_MEMORY_COMPACTION_TRIGGER_TURNS;
const memoryCompactionRetainRecentTurns = Math.min(
  env.TANGO_MEMORY_COMPACTION_RETAIN_RECENT_TURNS,
  Math.max(memoryCompactionTriggerTurns - 1, 1)
);
const memoryCompactionSummaryMaxChars = env.TANGO_MEMORY_COMPACTION_SUMMARY_MAX_CHARS;
const commandGuildId = env.DISCORD_COMMAND_GUILD_ID ?? env.DISCORD_TEST_GUILD_ID;
const defaultAccessMode = env.TANGO_ACCESS_MODE;
const voiceBridgeEnabled = env.TANGO_VOICE_BRIDGE_ENABLED === "true";
const voiceBridgeHost = env.TANGO_VOICE_BRIDGE_HOST;
const voiceBridgePort = env.TANGO_VOICE_BRIDGE_PORT;
const voiceBridgePath = env.TANGO_VOICE_BRIDGE_PATH;
const mobileVoiceDispatchPath = env.TANGO_MOBILE_VOICE_DISPATCH_PATH;
const voiceBridgeApiKey = env.TANGO_VOICE_BRIDGE_API_KEY;
const voiceDefaultSessionId = env.TANGO_VOICE_DEFAULT_SESSION_ID;
const voiceDefaultAgentId = env.TANGO_VOICE_DEFAULT_AGENT_ID;
const imessageEnabled = env.IMESSAGE_ENABLED === "true";
const imessageCliPath = env.IMESSAGE_CLI_PATH;
const imessageContactsPath = env.IMESSAGE_CONTACTS_PATH;
const imessageDefaultAgent = env.IMESSAGE_DEFAULT_AGENT;
const imessageAllowFrom = parseCsvIds(env.IMESSAGE_ALLOW_FROM);
const imessageGroupPolicy = env.IMESSAGE_GROUP_POLICY;
const imessageTextChunkLimit = env.IMESSAGE_TEXT_CHUNK_LIMIT;
const imessageDiscordChannelId = env.IMESSAGE_DISCORD_CHANNEL_ID;

const configDir = resolveConfigDir();
const sessionConfigs = loadSessionConfigs(configDir);
const intakeWebhookEntries = loadIntakeWebhookEntries();
const ownerPersona = (() => {
  try {
    return loadOwnerPersona();
  } catch (error) {
    console.error(`[tango-discord] owner.yaml unreadable; desk replies post as the bot: ${error instanceof Error ? error.message : error}`);
    return null;
  }
})();
const configuredDiscordChannelIds = extractConfiguredDiscordChannelIds(sessionConfigs);
const envAllowlistChannels = parseCsvIds(env.TANGO_ALLOWLIST_CHANNEL_IDS);
const envAllowlistUsers = parseCsvIds(env.TANGO_ALLOWLIST_USER_IDS);
const defaultAccessPolicy = buildDefaultAccessPolicy({
  mode: defaultAccessMode,
  allowlistChannelIds:
    envAllowlistChannels.length > 0 ? envAllowlistChannels : configuredDiscordChannelIds,
  allowlistUserIds: envAllowlistUsers
});
const sessionManager = new SessionManager(sessionConfigs);
const sessionConfigById = new Map(sessionConfigs.map((session) => [session.id, session]));
const agentConfigs = loadUnifiedAgentConfigs(configDir);
const dbPath = resolveDatabasePath(env.TANGO_DB_PATH);
// Single OllamaProvider instance shared by the voice + text v2 runtimes
// (OllamaRuntimeAdapter via TangoRouter -> RuntimePool) and the legacy provider
// registry below. Built BEFORE the voice router so voice turns to -ollama agents
// resolve the ollama backend instead of throwing "no ollamaProvider supplied".
// The 1Password apiKey resolver caches its first result, so sharing one instance
// avoids resolving twice. The Ollama tool loop talks to the persistent HTTP MCP
// server (:9100 unless MCP_SERVER_PORT says otherwise, same as the Claude CLI
// path). If another running bot already owns that port, this bot takes the next
// free one, and MCP_SERVER_PORT is set so every mcp-proxy it spawns follows.
const MCP_HTTP_PORT = chooseMcpPort(Number.parseInt(process.env.MCP_SERVER_PORT ?? "", 10) || DEFAULT_MCP_HTTP_PORT);
process.env.MCP_SERVER_PORT = String(MCP_HTTP_PORT);
const ollamaToolClient = new McpHttpToolClient({
  port: MCP_HTTP_PORT,
  timeoutMs: claudeTimeoutMs,
});
const ollamaProviderOptions = {
  baseUrl: env.OLLAMA_BASE_URL,
  defaultModel: env.OLLAMA_MODEL,
  apiKey:
    env.OLLAMA_API_KEY ??
    (async () => (await getSecret("<vault>", "<item>")) ?? undefined),
  timeoutMs: claudeTimeoutMs,
  toolClient: ollamaToolClient,
};
const ollamaProvider = new OllamaProvider(ollamaProviderOptions);
const voiceV2AgentRuntimeConfigs = loadEnabledVoiceV2AgentRuntimeConfigs({
  dbPath,
  configDir,
  timeoutMs: maxProviderTimeoutMs,
});

// T-I-035: persist every context-usage reading at the core write point, for
// every session type on every router. RAM maps die on restart/rotation; this
// row is what /tango context and the voice whisper fall back to. `storage` is
// declared below — callbacks run at turn time, long after module init.
function recordContextUsageSnapshot(
  conversationKey: string,
  agentId: string,
  usage: LastContextUsageSnapshot,
): void {
  try {
    storage.upsertContextUsageSnapshot({
      conversationKey,
      agentId,
      fraction: usage.fraction,
      usedTokens: usage.totalTokens,
      contextWindow: usage.contextWindow,
      recordedAt: usage.recordedAt.toISOString(),
    });
  } catch (error) {
    console.warn(
      `[context] snapshot persist failed conversation=${conversationKey} agent=${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// T-I-035: core-lifecycle 70% pressure hook, shared by all three routers.
// Typed keys return immediately — the existing post-turn text path
// (maybePostContextPressureAlert) keeps its once-per-band delivery unchanged.
// Anything else (voice, schedule, collaboration) has no in-thread delivery
// surface here: log loudly, never silently, and mark sent so the log is once
// per band. (Our fork consumes this hook to speak the warning in voice
// sessions — that consumer is stack-specific and intentionally not included.)
function handleCoreContextPressure(
  router: TangoRouter | null,
  conversationKey: string,
  agentId: string,
  usage: LastContextUsageSnapshot,
): void {
  if (conversationKey.startsWith("thread:") || conversationKey.startsWith("channel:")) {
    return;
  }

  const percent = Math.round(usage.fraction * 100);
  console.warn(
    `[context] pressure at ${percent}% for agent=${agentId} conversation=${conversationKey} — no in-thread delivery surface for this session type (session will still auto-rotate at 80%)`,
  );
  router?.markContextPressureAlertSentByKey(conversationKey);
}

const voiceTangoRouter = voiceV2AgentRuntimeConfigs.size > 0
  ? new TangoRouter({
      loomSessionStore: () => storage,
      agentConfigs: new Map(
        [...voiceV2AgentRuntimeConfigs.entries()].map(([agentId, entry]) => [
          agentId,
          entry.runtimeConfig,
        ]),
      ),
      // T-I-035: voice turns were the invisible family — separate router,
      // agent:-shaped keys, no persistence. Same hooks as the text router.
      lifecycleConfig: {
        onContextUsageRecorded: recordContextUsageSnapshot,
        onContextPressure: (conversationKey, agentId, usage) =>
          handleCoreContextPressure(voiceTangoRouter, conversationKey, agentId, usage),
      },
      ollamaProvider,
    })
  : null;
const scheduleConfigs = loadScheduleConfigs(configDir);
const stateTypePackConfigs = loadStateTypePackConfigs(configDir);
const stateViewConfigs = loadStateViewConfigs(configDir);
const memoryEvalConfig = loadMemoryEvalConfig(configDir);
const agentRegistry = new AgentRegistry(agentConfigs);
const agentTypingPresenter = createAgentTypingPresenter({
  resolveAgentTypingToken(agentId) {
    return resolveAgentTypingToken(agentRegistry.get(agentId));
  },
  defaultToken: process.env.DISCORD_TOKEN,
  logger: {
    warn(message: string): void {
      console.warn(message);
    },
  },
});
const voiceTargets = new VoiceTargetDirectory(configDir);
const projectDirectory = new ProjectDirectory(configDir);
// The system identity (system.yaml) is not an agent: a null speaker posts
// under its display name with the bot's own avatar.
const systemIdentity = loadSystemIdentity(configDir);
const systemDisplayName = systemIdentity.displayName;
const systemSpeaker: AgentConfig | null = null;
const smokeTestChannelIds = new Set(
  agentConfigs
    .map((agent) => agent.voice?.smokeTestChannelId?.trim())
    .filter((channelId): channelId is string => Boolean(channelId))
);
const slotModeAgentTestChannels = agentConfigs
  .filter((agent) => agent.voice?.smokeTestChannelId)
  .map((agent) => ({
    agentId: agent.id,
    channelId: agent.voice?.smokeTestChannelId ?? "",
  }));
const agentAccessOverrideCount = agentConfigs.filter((agent) => agent.access !== undefined).length;
const storage = new TangoStorage(dbPath);
const stateService = new StateService(storage.getDatabase());
const stateTypePackReport = installStateTypePacks({
  service: stateService,
  db: storage.getDatabase(),
  packs: stateTypePackConfigs,
});
if (stateTypePackConfigs.length > 0) {
  console.log(
    `[tango-state] type-packs installed=${stateTypePackReport.installed} skipped=${stateTypePackReport.skipped} failed=${stateTypePackReport.failed} created=${stateTypePackReport.typesCreated} updated=${stateTypePackReport.typesUpdated}`,
  );
  for (const failed of stateTypePackReport.packs.filter((pack) => pack.status === "failed")) {
    console.warn(`[tango-state] type-pack '${failed.packId}' failed atomically: ${failed.error}`);
  }
}
try {
  const wellnessReport = ensureWellnessDb();
  if (wellnessReport.created || wellnessReport.fromVersion !== wellnessReport.toVersion) {
    console.log(
      `[wellness-db] ${wellnessReport.created ? "materialized" : "migrated"} ${wellnessReport.path} (v${wellnessReport.fromVersion} → v${wellnessReport.toVersion})`,
    );
  }
} catch (error) {
  console.warn(`[wellness-db] ensure failed (wellnessdb tools may be unavailable): ${String(error)}`);
}
const attachmentStore = new AttachmentStore(storage.getDatabase());
const attachmentDataDir = resolveTangoDataDir();
// Manual enablement: flip config/v2/agents/<agent>.yaml runtime.provider to
// "claude-code-v2" and restart the bot. Keep committed configs on "legacy".
const v2Configs = loadLayeredV2AgentConfigs(configDir);
const v2EnabledAgents = buildV2EnabledAgentSet(v2Configs);
const v2RuntimeConfigs = buildV2RuntimeConfigs(v2Configs);
// The owner's accounts join every new thread in their agents' channels, so threads show in their sidebar.
const threadFollowers = new ThreadFollowers(
  threadFollowersByChannel([...v2Configs.values()].filter((agent) => agent.enabled !== false))
);
const atlasMemoryClient = new AtlasMemoryClient();
const v2LifecycleConfig = {
  idleTimeoutHours: 24,
  contextResetThreshold: 0.80,
};
// The -test smoke channels are memory-inert: turns there never write Atlas
// memories, keeping test chatter out of the agents' real retrieval scope.
// Derived from the smoke-testing-* session bindings so the set tracks the
// channel→clone routing config. Active-task extraction is NOT gated here
// (scheduleActiveTaskPostTurn runs independently; see TGO-743).
const memoryInertChannelIds = new Set(
  sessionConfigs
    .filter((session) => session.id.startsWith("smoke-testing-"))
    .flatMap((session) => session.channels ?? [])
    .filter((channel) => channel.startsWith("discord:"))
    .map((channel) => channel.slice("discord:".length).trim())
    .filter((channelId) => /^\d+$/.test(channelId)),
);
const tangoRouter = new TangoRouter({
  loomSessionStore: () => storage,
  agentConfigs: v2RuntimeConfigs,
  // T-I-035: persist usage + core pressure decision (typed keys still deliver
  // through the existing post-turn alert path; the hook skips them).
  lifecycleConfig: {
    ...v2LifecycleConfig,
    onContextUsageRecorded: recordContextUsageSnapshot,
    onContextPressure: (conversationKey, agentId, usage) =>
      handleCoreContextPressure(tangoRouter, conversationKey, agentId, usage),
  },
  buildColdStartContext: createAtlasColdStartContextBuilder(atlasMemoryClient, {
    projectStateProvider: (conversationKey) =>
      renderProjectStateBlock(storage, conversationKey, {
        vaultRoot: resolveStateVaultRoot(),
        profileRoot: resolveStateProfileRoot(),
      }),
    attachmentStore,
    v2Configs,
    stateDigestProvider: (conversationKey, agentId) => buildStateDigest(conversationKey, agentId),
  }),
  ollamaProvider,
});
const collaborationRouter = new TangoRouter({
  loomSessionStore: () => storage,
  agentConfigs: buildV2RuntimeConfigs(v2Configs),
  // T-I-035: collaboration sessions persist their readings too (pressure has
  // no in-thread surface here; the hook logs it loudly instead).
  lifecycleConfig: {
    ...v2LifecycleConfig,
    onContextUsageRecorded: recordContextUsageSnapshot,
    onContextPressure: (conversationKey, agentId, usage) =>
      handleCoreContextPressure(collaborationRouter, conversationKey, agentId, usage),
  },
  buildColdStartContext: createAtlasColdStartContextBuilder(atlasMemoryClient, {
    projectStateProvider: (conversationKey) =>
      renderProjectStateBlock(storage, conversationKey, { vaultRoot: resolveStateVaultRoot() }),
    attachmentStore,
    v2Configs,
    stateDigestProvider: (conversationKey, agentId) => buildStateDigest(conversationKey, agentId),
  }),
  ollamaProvider,
});
const agentCollaborationService = new AgentCollaborationService({
  storage,
  v2Configs,
  presentationObserver: createAgentCollaborationDiscordPresenter({
    storage,
    fetchChannel: (channelId) => client.channels.fetch(channelId),
    sendReply: (channel, text, speaker) => sendPresentedReply(
      channel as Message["channel"],
      text,
      speaker,
    ),
    resolveSpeaker: (agentId) => agentRegistry.get(agentId) ?? null,
  }),
  invokeTarget: async (input) => {
    const routeResult = await collaborationRouter.routeMessage({
      message: input.message,
      channelId: "agent-collaboration",
      conversationKey: input.conversationKey,
      agentId: input.targetAgentId,
      sendOptions: {
        timeout: input.timeoutMs,
      },
    });
    return routeResult.response;
  },
});
let embeddingProvider: EmbeddingProvider | null | undefined;

function getEmbeddingProvider(): EmbeddingProvider | null {
  if (embeddingProvider !== undefined) {
    return embeddingProvider;
  }

  embeddingProvider = createVoyageEmbeddingProviderFromEnv();
  return embeddingProvider;
}
storage.bootstrapSessions(sessionConfigs);

const providers = createBuiltInProviderRegistry({
  claudeOauth: {
    command: env.CLAUDE_CLI_COMMAND,
    defaultModel: env.CLAUDE_MODEL,
    defaultReasoningEffort: env.CLAUDE_EFFORT,
    timeoutMs: claudeTimeoutMs
  },
  ...(env.CLAUDE_SECONDARY_CLI_COMMAND
    ? {
        claudeOauthSecondary: {
          command: env.CLAUDE_SECONDARY_CLI_COMMAND,
          defaultModel: env.CLAUDE_SECONDARY_MODEL ?? env.CLAUDE_MODEL,
          defaultReasoningEffort: claudeSecondaryEffort,
          timeoutMs: claudeSecondaryTimeoutMs
        }
      }
    : {}),
  claudeHarness: {
    command: env.CLAUDE_HARNESS_COMMAND,
    defaultModel: env.CLAUDE_HARNESS_MODEL ?? env.CLAUDE_MODEL,
    defaultReasoningEffort: claudeHarnessEffort,
    timeoutMs: claudeHarnessTimeoutMs
  },
  codex: {
    command: env.CODEX_CLI_COMMAND,
    defaultModel: env.CODEX_MODEL,
    defaultReasoningEffort: env.CODEX_REASONING_EFFORT,
    timeoutMs: codexTimeoutMs,
    sandbox: env.CODEX_SANDBOX,
    approvalPolicy: env.CODEX_APPROVAL_POLICY,
    skipGitRepoCheck: true
  },
  ollama: ollamaProviderOptions
});
// Reuse the single OllamaProvider instance built above so the legacy registry
// and the v2 runtime share one provider (and one cached 1Password key lookup).
providers.set("ollama", ollamaProvider);
const stateHttpServer = createStateHttpServer({
  service: stateService,
  v2Configs,
  unarchiveMemories: async (eventIds) => {
    const memoryIds = stateService.getArchivedMemoryIdsForEvents(eventIds);
    if (memoryIds.length === 0) return;
    await atlasMemoryClient.memoryAdmin({
      operation: "unarchive",
      filter: { ids: memoryIds, include_archived: true },
    });
    stateService.markMemoriesUnarchived(memoryIds);
  },
});
void stateHttpServer.start().then(() => {
  console.log(`[tango-state] dashboard and tool bridge listening at ${stateHttpServer.url}`);
}).catch((error) => {
  console.error("[tango-state] failed to start state HTTP server", error);
  process.exit(1);
});

const statePostTurnHook = createV2PostTurnHook({
  v2Configs,
  atlasMemoryClient,
  resolveProvider: (name) => providers.get(name),
  extractionSuppressedChannelIds: memoryInertChannelIds,
  stateService,
  storage,
  publishStateReceipt: async (context, receipt) => {
    if (!client.isReady()) return;
    const channel = await client.channels.fetch(context.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await sendPresentedReply(
      channel as Message["channel"],
      receipt,
      agentRegistry.get(context.agentId) ?? systemSpeaker,
    );
  },
});
const stateObsidianAdapter = new StateObsidianAdapter({
  service: stateService,
  vaultRoot: resolveStateVaultRoot(),
});
void stateObsidianAdapter.start().then((report) => {
  console.log(`[tango-state] Obsidian adapter linked=${report.linked} unavailable=${report.unavailable} invalid=${report.invalid}`);
}).catch((error) => {
  console.warn("[tango-state] Obsidian adapter startup scan failed", error);
});
const stateHealthAdapter = new StateHealthAutoExportAdapter(stateService);
const stateSchedulerAdapter = new StateSchedulerAdapter({
  service: stateService,
  db: storage.getDatabase(),
  vaultRoot: resolveStateVaultRoot(),
});
const stateProjectionOutputRoot = process.env.TANGO_STATE_PROJECTION_ROOT?.trim() || null;
const enabledStateViewCount = stateViewConfigs.filter((view) => view.enabled).length;
const stateProjectionRunner = stateProjectionOutputRoot && enabledStateViewCount > 0
  ? new StateProjectionRunner({
      service: stateService,
      views: stateViewConfigs,
      outputRoot: stateProjectionOutputRoot,
      atlasRecords: (root) => atlasMemoryClient.listMemoriesForStateProjection({
        projectEntityId: root.projectEntityId ?? root.id,
        stateEntityId: root.id,
      }).map((memory) => ({
        id: memory.id,
        content: memory.content,
        source: memory.source,
        agentId: memory.agentId,
        importance: memory.importance,
        tags: memory.tags,
        createdAt: memory.createdAt,
        metadata: memory.metadata,
      })),
    })
  : undefined;
if (enabledStateViewCount > 0 && !stateProjectionOutputRoot) {
  console.warn("[tango-state] enabled state views are idle: TANGO_STATE_PROJECTION_ROOT is not configured");
}
if (stateProjectionRunner) {
  const projectionReport = stateProjectionRunner.run();
  console.log(
    `[tango-state] projections startup written=${projectionReport.written} unchanged=${projectionReport.unchanged} removed=${projectionReport.removed} errors=${projectionReport.errors.length}`,
  );
}
const stateLifecycleRunner = new StateLifecycleRunner({
  service: stateService,
  obsidian: stateObsidianAdapter,
  health: stateHealthAdapter,
  projections: stateProjectionRunner,
  runSupersession: async () => {
    const config = v2Configs.get("watson-ollama") ?? v2Configs.get("watson") ?? [...v2Configs.values()][0];
    const model = config?.state?.extractionModel ?? config?.memory.extractionModel;
    const providerName = resolveExtractionProvider(
      config,
      config?.state?.extractionProvider ?? config?.memory.extractionProvider,
      model,
    );
    const provider = providerName ? providers.get(providerName) : undefined;
    if (!provider || !model) return { candidates: 0, archived: 0, tagged: 0, unsure: 0, rejected: 0 };
    return runStateMemorySupersession({ service: stateService, atlas: atlasMemoryClient, provider, model });
  },
  promptCheckIn: async (request) => {
    const config = v2Configs.get(request.agentId);
    if (!config || !v2EnabledAgents.has(request.agentId)) throw new Error(`Check-in agent '${request.agentId}' is not enabled.`);
    const channelId = config.discord.defaultChannelId;
    const result = await tangoRouter.routeMessage({
      message: request.prompt,
      channelId,
      conversationKey: `state-check-in:${request.entityId}`,
      agentId: request.agentId,
    });
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) throw new Error(`Check-in channel '${channelId}' is unavailable.`);
    await sendPresentedReply(channel as Message["channel"], result.response.text, agentRegistry.get(request.agentId) ?? systemSpeaker, undefined, "check-in");
  },
});

function buildStateDigest(conversationKey: string, agentId: string): string | undefined {
  const config = v2Configs.get(agentId);
  if (config?.isolated) return undefined;
  return stateService.buildDigest({
    conversationKey,
    agentId,
    agentType: config?.type ?? null,
    scopes: [config?.type ?? "", agentId.replace(/-ollama$/u, "")].filter(Boolean),
    alwaysOnTypes: config?.state?.alwaysOnTypes ?? [],
  });
}

function scheduleStatePostTurn(context: Parameters<typeof statePostTurnHook>[0]): void {
  setImmediate(() => {
    void statePostTurnHook(context).catch((error) => {
      console.error(
        `[tango-state] post-turn pipeline failed turn=${context.turnId} agent=${context.agentId}`,
        error,
      );
    });
  });
}
const attachmentWorker = new AttachmentJobWorker(
  attachmentStore,
  `discord-${process.pid}`,
  createAttachmentProcessingHandlers({
    runLlmFallback: createProviderAttachmentLlmFallbackRunner(),
  }),
);

const providerSessionByConversation = new Map<string, string>();
const channelQueues = new Map<string, Promise<void>>();
const backgroundJobManager = new BackgroundJobManager({
  rootDir: path.join(resolveTangoProfileDataDir(), "background-jobs"),
  onFinished: deliverBackgroundJobCompletion,
  log: (message) => console.log(message),
});
const focusedTextAgentByChannel = new Map<string, string>();
// Agent Desk turn lifecycle (turn.started/activity/finished/failed). Isolated
// agents serve someone other than the owner, so the owner's desk never sees them.
const deskEvents = createDeskEventsClient();
setConversationEvents(storage, event => { if (!v2Configs.get(event.agentId)?.isolated) deskEvents.post(event); });
function startDeskTurn(identity: DeskTurnIdentity): DeskTurnTracker {
  if (v2Configs.get(identity.agentId)?.isolated) return NOOP_DESK_TURN;
  return deskEvents.startTurn(identity);
}

function resolveMemoryEvalAuditProvider(): ChatProvider {
  for (const providerName of ["claude-oauth", "claude-oauth-secondary", "claude-harness"]) {
    const provider = providers.get(providerName);
    if (provider) return provider;
  }

  const fallback = providers.values().next().value;
  if (fallback) return fallback;
  throw new Error("No provider available for memory-eval audit.");
}

// Model-agnostic image vision. For image attachments the fallback worker sends the
// actual image bytes to a configurable vision model (default gemma4:31b on Ollama; qwen3-vl was
// retired 2026-06-16 and gemma4 won the Sept 2026 receipt-vision bake-off)
// instead of the Claude-CLI "Read the local file path" trick. deepseek-v4-pro is NOT
// vision-capable, so the vision model is a separate knob (TANGO_VISION_MODEL).
const ATTACHMENT_VISION_MODEL = process.env.TANGO_VISION_MODEL?.trim() || "role:vision";
const ATTACHMENT_VISION_SYSTEM_PROMPT = [
  "You are Tango's fresh-context attachment vision worker.",
  "Analyze the provided image together with the attachment metadata.",
  "Return exactly one compact JSON object matching the requested schema.",
  "Do not include local filesystem paths in the returned JSON.",
].join("\n");

function createProviderAttachmentLlmFallbackRunner(): AttachmentLlmFallbackRunner {
  return async (input) => {
    const fallbackAgent = resolveAttachmentFallbackAgent(input.attachment.agentId);
    const sessionId =
      input.attachment.sessionId?.trim()
      || buildDefaultSessionKey(fallbackAgent.id);
    const providerSelection = resolveProviderNamesForTurn({
      sessionId,
      agent: fallbackAgent,
    });
    const providerNames = appendDefaultVisionFallbackProviders(providerSelection.providerNames);
    const providerChain = resolveProviderChain(providerNames);
    const prompt = buildAttachmentLlmFallbackPrompt(input);
    const startedAt = Date.now();

    // Model-agnostic vision: for image attachments, send the actual image bytes to
    // the configured Ollama vision model (gemma4:31b) first — no Claude dependency on
    // the common path. Only falls through to the provider chain below on failure.
    const visionContentType = (input.attachment.contentType ?? input.file.contentType ?? "").toLowerCase();
    if (ATTACHMENT_VISION_MODEL && visionContentType.startsWith("image/")) {
      try {
        const imageBytes = await fs.promises.readFile(input.filePath);
        const visionResponse = await ollamaProvider.generate({
          prompt,
          systemPrompt: ATTACHMENT_VISION_SYSTEM_PROMPT,
          images: [{ dataBase64: imageBytes.toString("base64"), mediaType: visionContentType }],
          model: ATTACHMENT_VISION_MODEL,
        });
        if (visionResponse.text.trim().length > 0) {
          return buildAttachmentLlmFallbackResultFromProviderOutput(visionResponse.text, {
            metadata: compactAttachmentFallbackMetadata({
              promptVersion: LLM_VISION_FALLBACK_PROMPT_VERSION,
              providerName: "ollama",
              model: visionResponse.metadata?.model ?? ATTACHMENT_VISION_MODEL,
              providerSessionId: visionResponse.providerSessionId ?? null,
              attempts: 1,
              attemptErrors: [],
              failures: [],
              usedFailover: false,
              warmStartUsed: false,
              durationMs: Date.now() - startedAt,
              providerMetadata: visionResponse.metadata ?? null,
              toolCalls: [],
              promptChars: prompt.length,
              source: {
                attachmentId: input.attachment.id,
                fileId: input.file.id,
                sha256: input.file.sha256,
                contentType: input.attachment.contentType ?? input.file.contentType,
                bytes: input.attachment.bytes ?? input.file.bytes,
              },
              previousExtractionId: input.previousExtraction?.id ?? null,
              fallbackReason: input.reason,
            }),
          });
        }
      } catch (error) {
        console.warn(
          `[attachment-vision] ${ATTACHMENT_VISION_MODEL} vision failed for attachment ${input.attachment.id}, falling back to provider chain: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const result = await generateWithFailover(
      providerChain,
      {
        prompt,
        systemPrompt: [
          "You are Tango's fresh-context attachment vision fallback worker.",
          "Use only the provided local file path and attachment metadata.",
          "Return exactly one compact JSON object matching the requested schema.",
          "Do not include local filesystem paths in the returned JSON.",
        ].join("\n"),
        tools: {
          mode: "allowlist",
          allowlist: ["Read"],
        },
        model: providerSelection.model,
        reasoningEffort: providerSelection.reasoningEffort ?? "low",
      },
      providerRetryLimit,
    );
    const response = result.retryResult.response;

    return buildAttachmentLlmFallbackResultFromProviderOutput(response.text, {
      metadata: compactAttachmentFallbackMetadata({
        promptVersion: LLM_VISION_FALLBACK_PROMPT_VERSION,
        providerName: result.providerName,
        model: response.metadata?.model ?? providerSelection.model ?? null,
        providerSessionId: response.providerSessionId ?? null,
        attempts: result.retryResult.attempts,
        attemptErrors: result.retryResult.attemptErrors,
        failures: result.failures,
        usedFailover: result.usedFailover,
        warmStartUsed: result.warmStartUsed,
        durationMs: Date.now() - startedAt,
        providerMetadata: response.metadata ?? null,
        toolCalls: response.toolCalls?.map((toolCall) => ({
          name: toolCall.name,
          serverName: toolCall.serverName,
          toolName: toolCall.toolName,
        })) ?? [],
        promptChars: prompt.length,
        source: {
          attachmentId: input.attachment.id,
          fileId: input.file.id,
          sha256: input.file.sha256,
          contentType: input.attachment.contentType ?? input.file.contentType,
          bytes: input.attachment.bytes ?? input.file.bytes,
        },
        previousExtractionId: input.previousExtraction?.id ?? null,
        fallbackReason: input.reason,
      }),
    });
  };
}

function resolveAttachmentFallbackAgent(agentId: string | null): AgentConfig {
  const requested = agentId ? agentRegistry.get(agentId) : null;
  const fallback = requested ?? agentRegistry.get(systemIdentity.defaultPromptAgent) ?? agentConfigs[0];
  if (!fallback) {
    throw new Error("No agent is configured for attachment LLM fallback.");
  }
  return fallback;
}

function appendDefaultVisionFallbackProviders(providerNames: string[]): string[] {
  // De-hardcoded: TANGO_VISION_FALLBACK_PROVIDERS (comma-separated) overrides the
  // default chain, so Claude can be removed from the vision fallback entirely. This
  // chain is now only the text/path-based backstop; primary image vision goes
  // through ATTACHMENT_VISION_MODEL (gemma4:31b) above.
  const configured = process.env.TANGO_VISION_FALLBACK_PROVIDERS?.trim();
  const defaults = configured
    ? configured.split(",").map((name) => name.trim()).filter(Boolean)
    : ["claude-oauth", "claude-oauth-secondary", "claude-harness", "codex"];
  return [...new Set([...providerNames, ...defaults])];
}

function compactAttachmentFallbackMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function writeMemoryEvalReport(markdown: string, now: Date = new Date()): string {
  const reportsDir = path.resolve("data", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `memory-eval-${now.toISOString().slice(0, 10)}.md`;
  const fullPath = path.join(reportsDir, filename);
  fs.writeFileSync(fullPath, markdown, "utf8");
  return path.relative(process.cwd(), fullPath);
}

function normalizeRuntimeReasoningEffort(
  value: ProviderReasoningEffort,
): AgentRuntimeConfig["runtimePreferences"]["reasoningEffort"] {
  return value === "xhigh" ? "max" : value;
}

function loadEnabledVoiceV2AgentRuntimeConfigs(input: {
  dbPath: string;
  configDir: string;
  timeoutMs: number;
}): Map<string, { config: V2AgentConfig; runtimeConfig: AgentRuntimeConfig }> {
  const configs = new Map<string, { config: V2AgentConfig; runtimeConfig: AgentRuntimeConfig }>();
  for (const config of loadLayeredV2AgentConfigs(input.configDir).values()) {
    try {
      if (!isV2RuntimeEnabled(config)) {
        continue;
      }

      const systemPrompt = assembleV2SystemPrompt(config, {
        repoRoot: process.cwd(),
        overlayDirs: resolveTangoProfileAgentPromptDirs(config.id),
      }).trim();
      if (systemPrompt.length === 0) {
        throw new Error(`System prompt for agent '${config.id}' is empty.`);
      }

      configs.set(config.id, {
        config,
        runtimeConfig: {
          agentId: config.id,
          backend: isOllamaBackedAgent(config) ? "ollama" : "claude-code",
          ...(config.isolated === true ? { isolated: true } : {}),
          systemPrompt,
          mcpServers: [
            ...config.mcpServers,
            ...(config.mcpServers.some((server) => server.name === "state") ? [] : [buildStateMcpServerConfig()]),
          ].map((server) => ({
            name: server.name,
            command: server.command,
            ...(server.args ? { args: [...server.args] } : {}),
            env: {
              ...buildRuntimePathEnv({
                dbPath: input.dbPath,
                configDir: input.configDir,
              }),
              ...(server.env ?? {}),
              // Without this, voice turns' tools ran with no caller identity:
              // screen refused to stage, and identity-scoped tools fell back.
              ...agentMcpIdentityEnv(config.id, config),
            },
          })),
          runtimePreferences: {
            model: config.runtime.model,
            reasoningEffort: normalizeRuntimeReasoningEffort(config.runtime.reasoningEffort),
            timeout: resolveV2RuntimeTimeoutMs(config, input.timeoutMs),
          },
        },
      });
    } catch (error) {
      console.warn(
        `[tango-voice] failed to load v2 agent runtime config for ${config.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Deterministic scheduler handlers — registered before scheduler starts
// ---------------------------------------------------------------------------

let scheduler: SchedulerService | null = null;

registerDeterministicHandler("contacts-sync", contactsSyncHandler);
registerDeterministicHandler("state-sweep", async () => {
  const report = await stateLifecycleRunner.run();
  const schedulerBackfill = scheduler
    ? await stateSchedulerAdapter.backfillLatest(scheduleConfigs, scheduler.getStore())
    : { considered: 0, applied: 0, skipped: 0, failed: 0 };
  const scheduledState = scheduler
    ? await stateSchedulerAdapter.reconcileExpectedRuns(scheduleConfigs, scheduler.getStore())
    : { considered: 0, overdue: 0, applied: 0, failed: 0 };
  return {
    status: report.health?.status === "unavailable" ? "skipped" : "ok",
    summary: `state=${report.sweep.evaluated} stale=${report.sweep.stale} obsidian=${report.obsidian?.linked ?? 0} health=${report.health?.applied ?? 0} superseded=${report.supersession?.archived ?? 0} checkins=${report.checkIns.prompted} scheduler_backfill=${schedulerBackfill.applied} overdue_jobs=${scheduledState.overdue}`,
    data: { ...report, schedulerBackfill, scheduledState },
  };
});
registerDeterministicHandler("printer-monitor", printerMonitorHandler);
registerDeterministicHandler("browser-session-keepalive", async () => {
  // Identity-provider sessions idle out server-side, and the cookies that carry
  // them die with the browser unless given a real expiry. Touching every
  // configured site on a schedule is what keeps authenticated work from
  // starting with a sign-in.
  const report = await runSiteSessionKeepalive();
  if (report.length === 0) {
    return { status: "skipped", summary: "No browser-session descriptors have keepalive enabled." };
  }

  const all = report.flatMap((entry) => entry.results);
  const blocked = all.filter((result) => !result.authenticated);
  const persisted = report.reduce((sum, entry) => sum + entry.persisted.converted.length, 0);

  const failureDetail = blocked
    .map((result) => `${result.site}/${result.scope} — ${result.message}`)
    .join(" | ");

  return {
    status: blocked.length === 0 ? "ok" : "error",
    // The scheduler logs `error`; leaving it unset prints error="undefined" and
    // hides the one line that says what actually went wrong.
    ...(blocked.length === 0 ? {} : { error: failureDetail }),
    summary:
      blocked.length === 0
        ? `Sessions live for ${all.map((r) => `${r.site}/${r.scope}`).join(", ")}; ${persisted} session cookie(s) hardened.`
        : `Sessions needing attention: ${failureDetail}`,
    data: {
      sessions: all.map((r) => ({ site: r.site, scope: r.scope, authenticated: r.authenticated, path: r.path })),
      persistedCookies: persisted,
      needsSecondFactor: all.some((r) => r.needsSecondFactor === true),
    },
  };
});
registerDeterministicHandler("daily-brief-aggregate", createDailyBriefAggregationHandler());
registerDeterministicHandler("daily-note-bootstrap", createDailyNoteBootstrapHandler());
registerDeterministicHandler("morning-flow-sentinel", createMorningFlowSentinelHandler());
registerDeterministicHandler("kilo-ledger-monitor", createKiloLedgerMonitorHandler({
  getLunchMoneyAccessToken: getLunchMoneyApiKey,
}));
registerDeterministicHandler("attachment-retention-sweep", async (ctx) => {
  const store = new AttachmentStore(ctx.db);
  const report = runAttachmentRetentionSweep(store, {
    policy: loadAttachmentRetentionPolicy(configDir),
    dryRun: false,
    writeReviewDecisions: true,
    decidedBy: "schedule:attachment-retention-sweep",
  });

  return {
    status: report.evaluated === 0 ? "skipped" : "ok",
    summary: formatAttachmentRetentionSweepSummary(report),
    data: { ...report, evaluations: report.evaluations.slice(0, 10) },
  };
});
registerDeterministicHandler("attachment-backlog-watchdog", async (ctx) => {
  const store = new AttachmentStore(ctx.db);
  const report = runAttachmentBacklogWatchdog(store, {
    writeReviewDecisions: true,
    decidedBy: "schedule:attachment-backlog-watchdog",
  });

  return {
    status:
      report.recoveredStaleLocks === 0
        && report.failedJobs === 0
        && report.stuckAttachments.length === 0
        ? "skipped"
        : "ok",
    summary: formatAttachmentBacklogWatchdogSummary(report),
    data: { ...report },
  };
});

let cachedLunchMoneyApiKey: string | null = null;
const RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN = 3;

async function getLunchMoneyApiKey(): Promise<string> {
  if (!cachedLunchMoneyApiKey) {
    const envKey = process.env.LUNCH_MONEY_ACCESS_TOKEN;
    if (envKey) {
      cachedLunchMoneyApiKey = envKey;
    } else {
      const opKey = await getSecret("Watson", "Lunch Money API Key");
      if (!opKey) {
        throw new Error(
          "Lunch Money API key not found. Set LUNCH_MONEY_ACCESS_TOKEN in .env or add 'Lunch Money API Key' to Watson vault in 1Password.",
        );
      }
      cachedLunchMoneyApiKey = opKey;
    }
  }
  return cachedLunchMoneyApiKey;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

registerPreCheckHandler("foxtrot-unreviewed-transactions", async () => {
  const timeZone = "America/Los_Angeles";
  const endDate = formatDateInTimeZone(new Date(), timeZone);
  const startDate = formatDateInTimeZone(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), timeZone);
  const response = await fetch(
    `https://dev.lunchmoney.app/v1/transactions?status=uncleared&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await getLunchMoneyApiKey()}`,
        "Content-Type": "application/json",
      },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Lunch Money pre-check failed: HTTP ${response.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as { transactions?: Array<Record<string, unknown>> };
  const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const unreviewedCount = transactions.filter(
    (transaction) => String(transaction.status ?? "") === "uncleared",
  ).length;
  if (unreviewedCount === 0) {
    return {
      action: "skip" as const,
      reason: "No uncleared transactions in the last 48 hours.",
    };
  }
  const categorizationRules = readFinanceCategorizationRules();
  const budgetNeutralTransfers = findBudgetNeutralInternalTransfers(transactions);
  return {
    action: "proceed" as const,
    context: {
      startDate,
      endDate,
      unreviewedCount,
      categorizationRulesPath: categorizationRules.relativePath,
      categorizationRules: categorizationRules.content,
      budgetNeutralTransferCount: budgetNeutralTransfers.length,
      budgetNeutralTransferDetails: formatBudgetNeutralTransferDetails(budgetNeutralTransfers),
    },
  };
});

registerPreCheckHandler("foxtrot-receipt-catalog-candidates", async () => {
  const timeZone = "America/Los_Angeles";
  const now = new Date();
  const { startDate, endDate, lookbackDays } = buildReceiptCatalogDateWindow(now, timeZone);
  // Fetch further back so uncleared charges that outlived the recovery window
  // (e.g. a pending->posted ID change dropped the receipt link) still surface.
  const { startDate: unclearedSinceDate } = buildReceiptCatalogDateWindow(
    now,
    timeZone,
    RECEIPT_CATALOG_UNCLEARED_LOOKBACK_DAYS,
  );
  const receiptsRoot = resolveDefaultReceiptRoot();
  // Started first and in parallel: the optional category lookup's own timeout runs inside the
  // pre-check deadline instead of after a slow transaction fetch.
  const categoryNamesPromise = getLunchMoneyApiKey()
    .then((apiKey) => fetchLunchMoneyCategoryNames(apiKey))
    .catch((error: unknown) => {
      console.warn(`[receipt-cataloger] Lunch Money categories unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [] as string[];
    });
  const response = await fetch(
    `https://dev.lunchmoney.app/v1/transactions?start_date=${encodeURIComponent(unclearedSinceDate)}&end_date=${encodeURIComponent(endDate)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await getLunchMoneyApiKey()}`,
        "Content-Type": "application/json",
      },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Lunch Money receipt pre-check failed: HTTP ${response.status}: ${text}`);
  }

  const parsed = JSON.parse(text) as { transactions?: Array<Record<string, unknown>> };
  const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const receiptLinks = collectReceiptLinkIndex(receiptsRoot);
  const retailerCandidates = buildMissingReceiptCandidates(transactions, receiptLinks.linked, {
    recentSince: startDate,
    pendingNotes: receiptLinks.pending,
  });
  const reimbursementGapCandidates = buildReimbursementGapCandidates({
    receiptsRoot,
    since: startDate,
    until: endDate,
  });

  // The live category list: suggestions must be bookable as written. A Lunch Money hiccup here
  // must not stop cataloging, so a failed fetch only skips the category check.
  const validCategoryNames = await categoryNamesPromise;
  const invalidCategoryNotes = validCategoryNames.length
    ? findInvalidSuggestedCategories({ receiptsRoot, validNames: validCategoryNames, since: startDate, until: endDate })
    : [];

  if (retailerCandidates.length === 0 && reimbursementGapCandidates.length === 0 && invalidCategoryNotes.length === 0) {
    return {
      action: "skip" as const,
      reason:
        `No recent receipt candidates, reimbursement tracking gaps or invalid suggested categories for configured retailers in the last ${lookbackDays} days.`,
    };
  }
  const categorizationRules = readFinanceCategorizationRules();

  return {
    action: "proceed" as const,
    context: {
      startDate,
      endDate,
      lookbackDays,
      unclearedSinceDate,
      retailerCandidateCount: Math.min(
        retailerCandidates.length,
        RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN,
      ),
      totalRetailerCandidateCount: retailerCandidates.length,
      remainingRetailerCandidateCount: Math.max(
        retailerCandidates.length - RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN,
        0,
      ),
      candidateDetails: formatReceiptCatalogCandidateDetails(
        retailerCandidates.slice(0, RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN),
      ),
      reimbursementGapCandidateCount: reimbursementGapCandidates.length,
      reimbursementGapDetails: formatReimbursementGapCandidateDetails(
        reimbursementGapCandidates,
      ),
      categorizationRulesPath: categorizationRules.relativePath,
      categorizationRules: categorizationRules.content,
      validCategories: formatValidCategories(validCategoryNames),
      invalidCategoryNoteCount: invalidCategoryNotes.length,
      invalidCategoryDetails: formatInvalidCategoryDetails(invalidCategoryNotes),
    },
  };
});

registerPreCheckHandler("foxtrot-sinking-fund-reconciliation-context", async (ctx) => {
  const timeZone = "America/Los_Angeles";
  const runDate = formatDateInTimeZone(new Date(), timeZone);
  const cadence =
    ctx.scheduleId === "sinking-fund-reconciliation-month-end"
      ? "month-end pre-close"
      : "weekly checkpoint";

  return {
    action: "proceed" as const,
    context: {
      runDate,
      cadence,
    },
  };
});

// ---------------------------------------------------------------------------
// Persistent MCP server — eliminates 60-90s cold start per worker task
// ---------------------------------------------------------------------------

let persistentMcpPort: number | undefined;
let persistentMcpProcess: ChildProcess | null = null;
// When the server exits on its own, it is forked again after these delays (the
// last repeats); a server that stayed up 10 minutes starts the ladder over.
const MCP_RESTART_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const MCP_STABLE_MS = 10 * 60_000;
let mcpRestartAttempt = 0;
let mcpRestartTimer: NodeJS.Timeout | undefined;
let mcpShuttingDown = false;

// With TANGO_SYSTEM_ALERTS=ledger, system alerts go to the system ledger, which
// groups them into incidents and is the one sender to Discord
// (docs/specs/system-visibility.md). Otherwise they post straight to Discord.
const systemAlertsViaLedger = env.TANGO_SYSTEM_ALERTS === "ledger";
let systemLedger: SystemLedger | null | undefined;
function recordSystemEvent(event: Parameters<typeof recordLedgerEvent>[1]): boolean {
  if (!systemAlertsViaLedger) return false;
  try {
    if (systemLedger === undefined) systemLedger = openSystemLedger();
    if (!systemLedger) return false;
    recordLedgerEvent(systemLedger, event);
    return true;
  } catch (error) {
    console.warn(`[tango-discord] system ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Post a system alert to the configured alerts channel (best-effort, no-throw). */
async function postSystemAlert(message: string, event?: Parameters<typeof recordLedgerEvent>[1]): Promise<void> {
  if (event && recordSystemEvent(event)) return;
  const channelId = env.TANGO_SCHEDULER_ALERTS_CHANNEL_ID;
  if (!channelId || !client.isReady()) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await sendPresentedReply(channel as Message["channel"], message, systemSpeaker);
  } catch { /* best-effort */ }
}

function checkMcpServerHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/health", method: "GET" },
      (res) => {
        clearTimeout(timer);
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            const body = JSON.parse(data);
            resolve(body.status === "ok");
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => { clearTimeout(timer); resolve(false); });
    req.end();
  });
}

function killStaleMcpServer(port: number): void {
  const stale = staleMcpServerPids(port);
  for (const pid of stale) {
    try {
      console.error(`[tango] Killing stale MCP server on port ${port} (pid=${pid})`);
      process.kill(pid, "SIGTERM");
    } catch { /* process already gone */ }
  }
  // A server another running bot owns is never killed (chooseMcpPort moved this
  // bot off its port at startup); if one still holds it, the fork fails and retries.
  const foreign = mcpServerPids(port).filter((pid) => !stale.includes(pid));
  if (foreign.length > 0) {
    console.error(`[tango] MCP port ${port} belongs to another running bot (pid=${foreign.join(",")}); not killing it.`);
  }
}

/**
 * A startup-failure alert. The ledger gets it now, so a restart's recovery can
 * never land before it; only a direct Discord post waits for the client to be
 * ready (startup failures happen before it is).
 */
function alertWhenReady(message: string, event: Parameters<typeof recordLedgerEvent>[1]): void {
  if (recordSystemEvent(event)) return;
  if (client.isReady()) void postSystemAlert(message);
  else client.once("clientReady" as any, () => { void postSystemAlert(message); });
}

/** Fork the MCP server again after it went away, backing off while it keeps failing. */
function scheduleMcpRestart(): void {
  if (mcpShuttingDown || mcpRestartTimer) return;
  const delay = MCP_RESTART_DELAYS_MS[Math.min(mcpRestartAttempt, MCP_RESTART_DELAYS_MS.length - 1)]!;
  mcpRestartAttempt++;
  console.error(`[tango] Restarting persistent MCP server in ${delay / 1000}s (attempt ${mcpRestartAttempt})`);
  mcpRestartTimer = setTimeout(() => {
    mcpRestartTimer = undefined;
    if (mcpShuttingDown) return;
    void startPersistentMcpServer().then((port) => {
      persistentMcpPort = port;
      if (!port) {
        scheduleMcpRestart();
        return;
      }
      console.error(`[tango] Persistent MCP server restarted on port ${port}`);
      // The tick only marks a service back after its own probes saw it down
      // (about two minutes), so an outage this short would stay open: say so here.
      recordSystemEvent({
        source: "bot", kind: "service.up", severity: "recovery", jobId: "service:mcp",
        title: "MCP server is back", detail: `restarted on port ${port}`,
      });
    });
  }, delay);
  mcpRestartTimer.unref();
}

async function startPersistentMcpServer(): Promise<number | undefined> {
  killStaleMcpServer(MCP_HTTP_PORT);
  const mcpServerScript = path.resolve("packages/discord/dist/mcp-wellness-server.js");
  try {
    const child = fork(mcpServerScript, ["--http", `--port=${MCP_HTTP_PORT}`], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, CLAUDECODE: "", TANGO_DB_PATH: dbPath },
      // Detach so it doesn't block tango shutdown
      detached: false,
    });

    persistentMcpProcess = child;

    // Forward stderr to console for debugging
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Wait for the server to signal readiness (via IPC) or timeout
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.error("[tango] Persistent MCP server startup timed out (10s), falling back to per-worker spawn");
        resolve(false);
      }, 10_000);
      timer.unref();

      child.on("message", (msg: unknown) => {
        if (msg && typeof msg === "object" && (msg as Record<string, unknown>).type === "ready") {
          clearTimeout(timer);
          resolve(true);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        console.error("[tango] Persistent MCP server failed to start:", err.message);
        resolve(false);
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`[tango] Persistent MCP server exited with code ${code}`);
          resolve(false);
        }
      });
    });

    if (ready) {
      // Verify with a health check
      const healthy = await checkMcpServerHealth(MCP_HTTP_PORT);
      if (healthy) {
        console.error(`[tango] Persistent MCP server ready on port ${MCP_HTTP_PORT}`);

        // An exit this bot didn't ask for: workers fall back to direct spawn
        // until the server is forked again. Exit code 0 is the server's own
        // SIGTERM/SIGINT handler, so something stopped it; it didn't crash.
        const readyAt = Date.now();
        child.on("exit", (code, signal) => {
          if (persistentMcpProcess !== child) return; // stopped on purpose (shutdown)
          persistentMcpPort = undefined;
          persistentMcpProcess = null;
          if (Date.now() - readyAt >= MCP_STABLE_MS) mcpRestartAttempt = 0;
          const how = signal ? `signal ${signal}` : `exit code ${code}`;
          const stopped = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
          console.error(`[tango] Persistent MCP server exited unexpectedly (${how}), workers will fall back to direct spawn`);
          postSystemAlert(
            stopped
              ? `**MCP server was stopped** by another process (${how}). Restarting it.`
              : `**MCP server crashed** (${how}). Restarting it.`,
            {
              source: "bot", kind: "service.down", severity: "critical", jobId: "service:mcp",
              title: stopped
                ? "MCP server was stopped by another process; restarting it"
                : "MCP server crashed; restarting it",
              detail: how,
            },
          );
          scheduleMcpRestart();
        });

        return MCP_HTTP_PORT;
      }
      console.error("[tango] Persistent MCP server health check failed, falling back to per-worker spawn");
    }

    // Cleanup failed process
    persistentMcpProcess = null;
    child.kill();
    alertWhenReady("**MCP server failed to start.** Worker tools may be slow or unavailable (falling back to per-worker spawn).", {
      source: "bot", kind: "service.down", severity: "error", jobId: "service:mcp",
      title: "MCP server failed to start; workers spawn their own",
    });
    return undefined;
  } catch (err) {
    console.error("[tango] Failed to start persistent MCP server:", err instanceof Error ? err.message : String(err));
    alertWhenReady(`**MCP server failed to start:** ${err instanceof Error ? err.message : String(err)}`, {
      source: "bot", kind: "service.down", severity: "error", jobId: "service:mcp",
      title: "MCP server failed to start; workers spawn their own",
      detail: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scheduler handler registrations
// ---------------------------------------------------------------------------

registerDeterministicHandler("health-daily-reset", async (_ctx) => {
  // Lightweight daily reset: ensures the health data pipeline date boundary
  // is clean. Future: could clear cached aggregates, reset daily counters, etc.
  return { status: "ok", summary: "Health daily reset completed" };
});

registerDeterministicHandler("memory-reflect", async (_ctx) => {
  const result = await runAtlasScheduledReflections({
    lookbackHours: 48,
  });

  if (result.discoveredTargets === 0) {
    return {
      status: "skipped",
      summary: result.enabledAgentIds.length > 0
        ? `No Atlas reflection targets needed updates for ${result.enabledAgentIds.length} configured agent(s)`
        : "No Atlas reflection targets found",
      data: {
        enabledAgents: result.enabledAgentIds,
      },
    };
  }

  const errorNote =
    result.errors.length > 0 ? `, ${result.errors.length} target(s) failed` : "";

  if (result.totalMemoriesCreated === 0 && result.errors.length === 0) {
    return {
      status: "skipped",
      summary: `Atlas reflections were already up to date across ${result.processedTargets} session(s)`,
      data: {
        enabledAgents: result.enabledAgentIds,
        processed: result.processed,
      },
    };
  }

  return {
    status: result.totalMemoriesCreated > 0 ? "ok" : "error",
    summary: `Created ${result.totalMemoriesCreated} Atlas reflection memories across ${result.processedTargets} session(s)${errorNote}`,
    data: {
      enabledAgents: result.enabledAgentIds,
      processed: result.processed,
      errors: result.errors,
    },
  };
});

registerDeterministicHandler("memory-index-obsidian", async (_ctx) => {
  const result = await indexObsidianVault({
    storage,
    embeddingProvider: getEmbeddingProvider(),
    // Mirror indexed chunks (embeddings included) into Atlas so agent
    // memory_search sees fresh vault content (TGO-691).
    secondarySink: {
      prune: (sourceRefPrefix) => atlasMemoryClient.obsidianPrune(sourceRefPrefix),
      addChunks: (chunks) => atlasMemoryClient.obsidianAddChunks(chunks),
    },
  });

  // Drain memories left without embeddings by historical silent batch failures
  // (TGO-692) — and any rows the run above failed to embed after retries.
  const missingEmbeddings = await backfillMissingMemoryEmbeddings({
    storage,
    embeddingProvider: getEmbeddingProvider(),
    source: "obsidian",
  });
  const embedSummary =
    `; embeddings: ${result.embeddedMemoryCount}/${result.insertedMemoryCount} new` +
    (missingEmbeddings.scannedCount > 0
      ? `, backfilled ${missingEmbeddings.embeddedCount}/${missingEmbeddings.scannedCount} missing`
      : "") +
    (result.embedFailedCount + missingEmbeddings.failedCount > 0
      ? `, ${result.embedFailedCount + missingEmbeddings.failedCount} FAILED (${[...result.embedErrors, ...missingEmbeddings.embedErrors].slice(0, 2).join("; ") || "unknown"})`
      : "") +
    `; atlas sync: ${result.sinkSyncedCount} chunks` +
    (result.sinkErrorCount > 0 ? `, ${result.sinkErrorCount} sync ERRORS` : "");

  if (
    result.indexedFileCount === 0 &&
    result.removedFileCount === 0 &&
    missingEmbeddings.scannedCount === 0
  ) {
    return {
      status: "skipped",
      summary: `No Obsidian memory index changes across ${result.scannedFileCount} scanned files`,
    };
  }

  return {
    status: "ok",
    summary:
      `Indexed ${result.indexedFileCount} Obsidian files, removed ${result.removedFileCount}, ` +
      `left ${result.unchangedFileCount} unchanged${embedSummary}`,
    data: {
      scannedFileCount: result.scannedFileCount,
      indexedFileCount: result.indexedFileCount,
      unchangedFileCount: result.unchangedFileCount,
      removedFileCount: result.removedFileCount,
      insertedMemoryCount: result.insertedMemoryCount,
      deletedMemoryCount: result.deletedMemoryCount,
      embeddedMemoryCount: result.embeddedMemoryCount,
      embedFailedCount: result.embedFailedCount,
      missingEmbeddingsScanned: missingEmbeddings.scannedCount,
      missingEmbeddingsBackfilled: missingEmbeddings.embeddedCount,
      missingEmbeddingsFailed: missingEmbeddings.failedCount,
      atlasSyncedCount: result.sinkSyncedCount,
      atlasSyncErrorCount: result.sinkErrorCount,
    },
  };
});

registerDeterministicHandler("vault-daily-check", async (_ctx) => {
  // Async with a timeout: a synchronous child here froze the whole bot for its duration.
  const rawResult = (
    await execFileAsync("npm", ["run", "-s", "vault:daily-check", "--", "--db-path", dbPath, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TANGO_DB_PATH: dbPath },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60_000,
      killSignal: "SIGKILL",
    })
  ).stdout.trim();
  const result = JSON.parse(rawResult) as {
    summary?: string;
    reportPath?: string | null;
    cleanupPlanPath?: string | null;
    logPath?: string | null;
    firstRun?: boolean;
    counts?: Record<string, unknown>;
    cleanup?: Record<string, unknown> | null;
  };

  return {
    status: "ok",
    summary: result.summary ?? "Vault daily check completed",
    data: {
      reportPath: result.reportPath,
      cleanupPlanPath: result.cleanupPlanPath,
      logPath: result.logPath,
      firstRun: result.firstRun,
      counts: result.counts,
      cleanup: result.cleanup,
    },
  };
});

registerDeterministicHandler("memory-archive-stale", async (_ctx) => {
  const KEEP_LIMIT = 800;
  const sources = ["conversation", "obsidian", "backfill", "reflection"] as const;
  let totalArchived = 0;

  for (const source of sources) {
    const memories = storage.listMemories({ source, limit: KEEP_LIMIT * 4 });
    const archiveIds = selectMemoriesToArchive(memories, KEEP_LIMIT);
    for (const memoryId of archiveIds) {
      storage.archiveMemory(memoryId);
    }
    totalArchived += archiveIds.length;
  }

  if (totalArchived === 0) {
    return {
      status: "skipped",
      summary: "No stale memories to archive",
    };
  }

  return {
    status: "ok",
    summary: `Archived ${totalArchived} low-retention memories`,
    data: { archivedCount: totalArchived },
  };
});

registerDeterministicHandler("memory-eval-report", async (_ctx) => {
  const now = new Date();
  const benchmarkRun = await runMemoryEvalBenchmarks({
    storage,
    config: memoryEvalConfig,
    embeddingProvider: getEmbeddingProvider(),
    // Benchmarks measure the same substrate the live warm-start reads (TGO-698).
    listCandidates:
      warmStartMemorySubstrate === "atlas"
        ? (filter) =>
            mapAtlasContextRows(
              atlasMemoryClient.listMemoriesForContext({
                agentId: filter.agentId ?? null,
                limit: filter.limit,
              }),
            ).memories
        : undefined,
    now,
  });

  // Benchmark regressions previously sat red for days because the scheduler
  // only alerts when the job itself crashes (TGO-696). Alert on failed cases.
  if (benchmarkRun.failedCount > 0) {
    const failedLines = benchmarkRun.cases
      .filter((caseResult) => !caseResult.passed)
      .map((caseResult) => `- ${caseResult.caseId}: ${caseResult.failureReasons.join("; ") || "failed"}`)
      .join("\n");
    const alertMessage =
      `**Memory Eval Alert**\n${benchmarkRun.failedCount}/${benchmarkRun.cases.length} retrieval benchmarks failing:\n${failedLines}`;
    try {
      const recorded = recordSystemEvent({
        source: "scheduler", kind: "custom", severity: "warning", jobId: "schedule:memory-eval-report",
        title: "Memory eval: retrieval benchmarks failing", detail: failedLines,
        data: { failed: benchmarkRun.failedCount, total: benchmarkRun.cases.length },
      });
      if (!recorded) await schedulerAlert?.("", alertMessage);
    } catch (error) {
      console.warn(
        `[tango-discord] memory-eval benchmark alert failed to send: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const recovery = memoryEvalRecoveryEvent(benchmarkRun);
  if (recovery) recordSystemEvent(recovery);

  const snapshotSamples = collectPromptSnapshotAuditSamples({
    storage,
    config: memoryEvalConfig,
    now,
  });

  let auditReview = null;
  try {
    if (snapshotSamples.length > 0) {
      auditReview = await auditPromptSnapshotsWithProvider({
        provider: resolveMemoryEvalAuditProvider(),
        criteria: memoryEvalConfig.criteria,
        samples: snapshotSamples,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auditReview = {
      overallHealth: "mixed" as const,
      summary: "LLM snapshot audit failed; benchmark results are still valid.",
      wins: [],
      issues: [`LLM audit error: ${message}`],
      audits: [],
    };
  }

  const markdown = renderMemoryEvalMarkdownReport({
    generatedAt: now.toISOString(),
    config: memoryEvalConfig,
    benchmarkRun,
    snapshotSamples,
    auditReview,
  });
  const reportPath = writeMemoryEvalReport(markdown, now);

  return {
    status: "ok",
    summary: renderMemoryEvalDiscordSummary({
      generatedAt: now.toISOString(),
      benchmarkRun,
      snapshotSamples,
      auditReview,
      reportPath,
    }),
    data: {
      benchmarkPassedCount: benchmarkRun.passedCount,
      benchmarkFailedCount: benchmarkRun.failedCount,
      snapshotSampleCount: snapshotSamples.length,
      auditHealth: auditReview?.overallHealth ?? null,
      reportPath,
    },
  };
});

registerDeterministicHandler("claude-artifact-cleanup", async (_ctx) => {
  const result = cleanupExpiredClaudeArtifacts({
    storage,
    retentionHours: 72,
  });

  if (result.candidateCount === 0) {
    return {
      status: "skipped",
      summary: `No expired Tango-owned Claude artifacts found in ${result.projectDir}`,
      data: { ...result },
    };
  }

  const status = result.errors.length > 0 ? "error" : "ok";
  return {
    status,
    summary:
      `Processed ${result.candidateCount} expired Claude session artifact(s): ` +
      `deleted ${result.deletedSessionCount} sessions ` +
      `(${result.deletedJsonlCount} transcripts, ${result.deletedDirectoryCount} directories)` +
      (result.errors.length > 0 ? `, errors=${result.errors.length}` : ""),
    data: { ...result },
  };
});

registerDeterministicHandler("model-scorecard", async (_ctx) => {
  const now = new Date();
  const windowDays = 7;
  const utcBoundary = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const currentSince = utcBoundary(windowDays);
  const recentSince = utcBoundary(1);
  const allSince = storage.listModelRunStats(utcBoundary(windowDays * 2));
  const current = allSince.filter((row) => row.createdAt >= currentSince);
  const previous = allSince.filter((row) => row.createdAt < currentSince);
  // Retirement + role health: every configured open model vs the live catalog.
  const isOpen = (model: string | undefined): model is string => isOpenScheduleModel(model);
  const configuredOllamaModels: Array<{ where: string; model: string }> = [];
  const addConfigured = (where: string, model: string | undefined) => {
    if (!isOpen(model)) return;
    const concrete = tryResolveOllamaModelName(model);
    configuredOllamaModels.push({ where, model: concrete });
  };
  for (const [agentId, config] of v2Configs) {
    if (isOllamaBackedAgent(config)) addConfigured(`${agentId}.runtime.model`, config.runtime.model);
    addConfigured(`${agentId}.memory.extraction_model`, config.memory?.extractionModel);
    addConfigured(`${agentId}.active_tasks.extraction_model`, config.activeTasks?.extractionModel);
    addConfigured(`${agentId}.state.extraction_model`, config.state?.extractionModel);
  }
  for (const schedule of scheduleConfigs) {
    if (schedule.enabled) addConfigured(`schedule:${schedule.id}`, schedule.provider?.model);
  }
  let ollamaCatalog: string[] | undefined;
  const ollamaKey = process.env.OLLAMA_API_KEY?.trim();
  if (ollamaKey) {
    try {
      ollamaCatalog = await fetchOllamaCatalog(ollamaKey);
    } catch {
      ollamaCatalog = undefined;
    }
  }
  const scorecard = buildModelScorecard({
    current,
    previous,
    recent: current.filter((row) => row.createdAt >= recentSince),
    evaluatedModels: loadEvaluatedModels(process.cwd()),
    windowDays,
    now,
    ...(ollamaCatalog ? { ollamaCatalog, configuredOllamaModels, roles: describeModelRoles(ollamaCatalog) } : {}),
  });
  return {
    status: "ok",
    summary: scorecard.summary,
    data: {
      pairs: scorecard.pairs.length,
      totalRuns: current.length,
      flags: scorecard.flags,
    },
  };
});

// Nightly model intake: screen newly released Ollama/Anthropic models against
// production incumbents and report when one is worth a full bake-off
// (packages/discord/src/model-intake.ts). Silent on nights with nothing new.
registerDeterministicHandler("model-intake", async (_ctx) => {
  const ollamaKey = process.env.OLLAMA_API_KEY?.trim();
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return runModelIntake({
    repoRoot: process.cwd(),
    statePath: path.join(resolveTangoProfileDataDir(), "model-intake.json"),
    fetchOllamaCatalog: async () => (ollamaKey ? fetchOllamaCatalog(ollamaKey) : []),
    fetchAnthropicModels: async () => {
      if (!claudeToken) return [];
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { Authorization: `Bearer ${claudeToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    },
    ollamaSessionUsage: async () => {
      if (!ollamaKey) return 1;
      const res = await fetch("https://ollama.com/api/usage", { headers: { Authorization: `Bearer ${ollamaKey}` }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { limits?: { session?: { usage?: number } } };
      return body.limits?.session?.usage ?? 1;
    },
    runScreenFixture: spawnScreenFixture(process.cwd()),
  });
});

// Start the persistent server, then initialize the scheduler

startPersistentMcpServer().then(async (port) => {
  persistentMcpPort = port;
  if (!port) scheduleMcpRestart();

  // Initialize and start the scheduler once MCP is ready
  if (scheduleConfigs.length > 0) {
    const executeV2TurnForScheduler: V2ScheduledTurnExecuteFn = async (input) => {
      const baseScheduleId = input.config.id.replace(/^manual-test-/, "");
      const scheduledAgentId = selectScheduledAgent({
        agentId: input.agentId,
        config: input.config,
        useOllama: SCHEDULER_USE_OLLAMA,
        excluded: SCHEDULER_OLLAMA_EXCLUDE.has(input.config.id) || SCHEDULER_OLLAMA_EXCLUDE.has(baseScheduleId),
        cloneExists: v2Configs.has(`${input.agentId}-ollama`),
      });
      const v2Entry = v2Configs.get(scheduledAgentId);
      if (!v2Entry) {
        throw new Error(
          `Schedule '${input.config.id}' requests v2 runtime but agent '${scheduledAgentId}' has no v2 config.`,
        );
      }

      const systemPrompt = assembleV2SystemPrompt(v2Entry, {
        repoRoot: process.cwd(),
        overlayDirs: resolveTangoProfileAgentPromptDirs(scheduledAgentId),
      }).trim();
      if (systemPrompt.length === 0) {
        throw new Error(`System prompt file for agent '${scheduledAgentId}' is empty.`);
      }

      const scheduledMemoryScope = resolveV2MemoryScope(scheduledAgentId, v2Entry);
      const runtimeConfig: AgentRuntimeConfig = {
        agentId: scheduledAgentId,
        backend: isOllamaBackedAgent(v2Entry) ? "ollama" : v2Entry.runtime.backend ?? "claude-code",
        isolated: v2Entry.isolated,
        systemPrompt: `${systemPrompt}\n\n${SCHEDULED_REVIEW_GUIDANCE}`,
        mcpServers: [
          ...v2Entry.mcpServers,
          ...(v2Entry.mcpServers.some((server) => server.name === "state") ? [] : [buildStateMcpServerConfig()]),
        ].map((server) => ({
          name: server.name,
          command: server.command,
          ...(server.args ? { args: [...server.args] } : {}),
          env: {
            ...buildRuntimePathEnv({ dbPath, configDir }),
            ...(server.env ?? {}),
            WORKER_ID: scheduledAgentId,
            TANGO_MEMORY_CANONICAL_AGENT_ID: scheduledMemoryScope.canonicalAgentId,
            TANGO_MEMORY_ALIAS_AGENT_IDS: scheduledMemoryScope.aliasAgentIds.join(","),
          },
        })),
        runtimePreferences: {
          // Ollama-backed clones ignore the schedule's hardcoded Claude model
          // (e.g. claude-sonnet-4-6) and use their own model, or it would be sent to
          // the DeepSeek endpoint and hard-fail.
          // …unless the schedule names an open model itself (per-job role).
          model: isOllamaBackedAgent(v2Entry)
            ? (isOpenScheduleModel(input.config.provider?.model) ? input.config.provider!.model! : v2Entry.runtime.model)
            // An open-model schedule whose agent has no Ollama clone can't run on
            // the Claude CLI: keep the agent's own model rather than hard-fail.
            : isOpenScheduleModel(input.config.provider?.model)
              ? (console.warn(`[scheduler] ${input.config.id}: open model ${input.config.provider?.model} but '${scheduledAgentId}' has no Ollama clone; using ${v2Entry.runtime.model}`), v2Entry.runtime.model)
              : input.config.provider?.model ?? v2Entry.runtime.model,
          reasoningEffort: normalizeRuntimeReasoningEffort(
            input.config.provider?.reasoningEffort ?? v2Entry.runtime.reasoningEffort,
          ),
          timeout: (input.config.execution.timeoutSeconds ?? 300) * 1000,
        },
      };

      const reviewContext = await buildScheduledReviewContext({
        config: input.config,
        agentId: scheduledMemoryScope.canonicalAgentId,
        agentIds: scheduledMemoryScope.aliasAgentIds,
        task: input.task,
      }, {
        resolveConversation: async (channelId) => {
          const channel = await client.channels.fetch(channelId);
          if (!channel) return undefined;
          const thread = channel.isThread() ? channel : undefined;
          const routingChannelId = thread?.parentId ?? channelId;
          const route = sessionManager.route(`discord:${routingChannelId}`);
          const threadSession = thread ? storage.getThreadSession(channelId) : null;
          if (!route && !threadSession?.agentId) return undefined;
          return {
            sessionId: thread
              ? threadSession?.sessionId ?? `scheduled-thread:${channelId}`
              : route!.sessionId,
            agentId: threadSession?.agentId ?? route!.agentId,
            channelId: routingChannelId,
            ...(thread ? { threadId: channelId } : {}),
          };
        },
        buildWarmStart: buildWarmStartContext,
        getDependency: (id) => {
          const config = scheduleConfigs.find((candidate) => candidate.id === id);
          if (!config) return undefined;
          const run = scheduler?.getStore().getRecentRuns(id, 1)[0];
          return {
            config,
            latestRun: run ? { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt } : undefined,
          };
        },
      });
      runtimeConfig.coldStartContext = reviewContext.prompt;

      const adapter = createScheduledRuntime(runtimeConfig, ollamaProvider, input.config);
      await adapter.initialize(runtimeConfig);

      try {
        const currentTurnMetadataPrompt = buildCurrentTurnMetadataPrompt({
          timestamp: new Date(),
          timestampSource: `scheduler:${input.config.id}`,
          config: v2Entry.currentTurnMetadata,
        });
        const response = await adapter.send(input.task, {
          currentTurnMetadataPrompt,
        });
        const runtimeMetadata = asRecord(response.metadata);
        const providerMetadata = asRecord(runtimeMetadata?.providerMetadata);
        const providerUsage = asRecord(providerMetadata?.usage);
        const providerSessionId = metadataString(runtimeMetadata, "sessionId") ?? null;
        const runtimeModel =
          response.model
          ?? metadataString(providerMetadata, "model")
          ?? runtimeConfig.runtimePreferences.model
          ?? "unknown";
        const toolsUsed = response.toolsUsed ?? [];
        const runtimeError = metadataBoolean(runtimeMetadata, "error") ?? false;
        const rawRuntimeResponse = asRecord(runtimeMetadata?.raw);
        const sessionId = buildScheduleExecutionSessionId(input.config.id, input.agentId);
        const conversationKey = `schedule-v2:${input.config.id}`;

        upsertSessionForRoute({ sessionId, agentId: input.agentId }, conversationKey);

        writeModelRun({
          sessionId,
          agentId: input.agentId,
          providerName: isOllamaBackedAgent(v2Entry) ? "ollama" : "claude-code-v2",
          conversationKey,
          providerSessionId,
          model: runtimeModel,
          stopReason: metadataString(providerMetadata, "stopReason") ?? null,
          responseMode: "scheduled-v2",
          latencyMs: response.durationMs,
          providerDurationMs: metadataNumber(providerMetadata, "durationMs") ?? response.durationMs,
          providerApiDurationMs: metadataNumber(providerMetadata, "durationApiMs") ?? null,
          inputTokens: metadataNumber(providerUsage, "inputTokens") ?? null,
          outputTokens: metadataNumber(providerUsage, "outputTokens") ?? null,
          cacheReadInputTokens: metadataNumber(providerUsage, "cacheReadInputTokens") ?? null,
          cacheCreationInputTokens: metadataNumber(providerUsage, "cacheCreationInputTokens") ?? null,
          totalCostUsd: metadataNumber(providerMetadata, "totalCostUsd") ?? null,
          isError: runtimeError,
          errorMessage:
            runtimeError
              ? metadataString(runtimeMetadata, "stderr") ?? "Claude Code runtime returned an error response."
              : null,
          metadata: {
            phase: "scheduled-v2",
            scheduleId: input.config.id,
            runtime: "v2",
            runtimeMode: "fresh",
            toolsUsed,
            runtimeExitCode: metadataNumber(runtimeMetadata, "exitCode") ?? null,
            runtimeSignal: metadataString(runtimeMetadata, "signal") ?? null,
            runtimeStderr: metadataString(runtimeMetadata, "stderr") ?? null,
            coldStartContextChars: runtimeConfig.coldStartContext?.length ?? 0,
            reviewContext: reviewContext.diagnostics,
            reasoningEffort: runtimeConfig.runtimePreferences.reasoningEffort ?? null,
          },
          rawResponse:
            captureProviderRaw && rawRuntimeResponse
              ? rawRuntimeResponse
              : null,
        });

        return {
          text: response.text,
          durationMs: response.durationMs,
          model: runtimeModel,
          metadata: {
            ...(response.metadata ?? {}),
            runtime: "v2",
            sessionId: providerSessionId,
            reviewContext: reviewContext.diagnostics,
          },
        };
      } finally {
        await adapter.teardown();
      }
    };

    // --- Scheduler delivery: post job output to agent channels ---
    // Also writes to the session DB so the agent has conversation history when
    // the user replies (e.g., correcting a transaction categorization).
    // Throws when the report can't be posted, so the scheduler records the
    // delivery as failed and alerts instead of marking it delivered.
    const deliverToChannel = async (channelId: string, agentId: string, content: string) => {
      if (!client.isReady()) throw new Error("Discord client is not ready");
      const fetchError: { message?: string } = {};
      const channel = await client.channels.fetch(channelId).catch((error: unknown) => {
        fetchError.message = error instanceof Error ? error.message : String(error);
        return null;
      });
      if (!channel) {
        throw new Error(`channel ${channelId} could not be fetched${fetchError.message ? `: ${fetchError.message}` : ""}`);
      }
      if (!channel.isTextBased()) throw new Error(`channel ${channelId} is not a text channel`);
      const speaker = agentRegistry.get(agentId);
      if (!speaker) throw new Error(`delivery agent '${agentId}' is not configured`);
      const delivery = await sendPresentedReply(channel as Message["channel"], content, speaker, undefined, "schedule");
      ensureReplyDeliverySucceeded(delivery, channelId);

      // Resolve session for this channel/thread and persist the message.
      // When the delivery target is a thread with a registered session, write
      // to that session so the message appears in the thread's warm-start
      // context when the user replies (thread sessions override the parent
      // channel session in handleMessage).
      let routingChannelId = channelId;
      const isThread = "isThread" in channel && typeof channel.isThread === "function" && (channel as { isThread: () => boolean }).isThread();
      if (isThread) {
        const parentId = (channel as { parentId?: string | null }).parentId;
        if (parentId) routingChannelId = parentId;
      }
      const channelKey = `discord:${routingChannelId}`;
      const route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
      if (route) {
        let effectiveSessionId = route.sessionId;
        if (isThread && channelId !== routingChannelId) {
          const threadSession = storage.getThreadSession(channelId);
          if (threadSession) {
            effectiveSessionId = threadSession.sessionId;
          }
        }
        await writeMessage({
          sessionId: effectiveSessionId,
          agentId,
          direction: "outbound",
          source: "tango",
          visibility: "public",
          discordMessageIds: delivery.messageIds,
          discordMessageId: delivery.lastMessageId ?? null,
          discordChannelId: channelId,
          content,
          metadata: { scheduledDelivery: true },
        });
      }
    };

    // --- Scheduler alerts: post failure alerts to #system-alerts ---
    const defaultAlertsChannelId = env.TANGO_SCHEDULER_ALERTS_CHANNEL_ID;
    const sendAlert = defaultAlertsChannelId
      ? async (channelId: string, content: string) => {
          if (!client.isReady()) throw new Error("Discord client is not ready");
          // Use the per-schedule alert channel when it resolves; otherwise (unset,
          // or a starter placeholder no profile overrode) use the default channel
          // so the alert is never dropped.
          const fetchTextChannel = async (id: string) => {
            const fetched = await client.channels.fetch(id).catch(() => null);
            return fetched?.isTextBased() ? fetched : null;
          };
          let channel = channelId ? await fetchTextChannel(channelId) : null;
          if (!channel) {
            if (channelId && channelId !== defaultAlertsChannelId) {
              console.warn(`[scheduler] alert channel ${channelId} unavailable; using default alerts channel`);
            }
            channel = await fetchTextChannel(defaultAlertsChannelId);
          }
          if (!channel) throw new Error(`default alerts channel ${defaultAlertsChannelId} is unavailable`);
          const delivery = await sendPresentedReply(channel as Message["channel"], content, systemSpeaker);
          ensureReplyDeliverySucceeded(delivery, channel.id);
        }
      : undefined;
    schedulerAlert = sendAlert;

    // The #system-log channel is retired: run history lives in schedule_runs
    // and the system ledger, shown on the desk's System page.

    scheduler = new SchedulerService(scheduleConfigs, {
      db: storage.getDatabase(),
      executeV2Turn: executeV2TurnForScheduler,
      deliver: deliverToChannel,
      // With the ledger on, the system tick turns failed runs and deliveries
      // in schedule_runs into incidents, so the engine sends nothing itself.
      alert: systemAlertsViaLedger ? undefined : sendAlert,
      onRunStarted: async ({ config, run }) => {
        await stateSchedulerAdapter.recordStarted(config, run);
      },
      onRunFinished: async ({ config, run }) => {
        await stateSchedulerAdapter.recordFinished(config, run);
      },
    });
    const stateBackfill = await stateSchedulerAdapter.backfillLatest(
      scheduleConfigs,
      scheduler.getStore(),
    );
    console.log(
      `[tango-state] scheduler backfill considered=${stateBackfill.considered} applied=${stateBackfill.applied} skipped=${stateBackfill.skipped} failed=${stateBackfill.failed}`,
    );
    // Only the canonical production bot runs the automatic scheduler tick loop.
    // Slot / worktree-dev instances (TANGO_SLOT set) skip it so they never
    // double-run scheduled jobs or fire real external side effects (email,
    // Lunch Money, receipts, Discord posts) alongside production. The scheduler
    // object is still constructed, so the manual GET /trigger/<id> endpoint
    // stays available for dev testing.
    if (shouldRunSchedulerTickLoop(process.env)) {
      scheduler.start();
    } else {
      console.log(
        "[scheduler] slot mode active (TANGO_SLOT set) — automatic tick loop disabled; " +
          "use GET /trigger/<id> to run a job manually, or set TANGO_SCHEDULER_IN_SLOT=true to enable ticks",
      );
    }

    backgroundJobManager.start();

    // Lightweight HTTP trigger endpoint for scheduler jobs
    // Usage: curl http://localhost:9200/trigger/slack-summary
    const triggerServer = createHttpServer(async (req, res) => {
      // What a restart would cut off: Discord channels with turns queued or running, and
      // voice turns in flight. scripts/tmux/wait-bot-idle.sh waits for both to be zero.
      if (req.url === "/status/work" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channelTurns: channelQueues.size + nativeMirror.size, voiceTurns: voiceTurnsInFlight, voiceConversations: [...voiceConversationsInFlight.keys()] }));
        return;
      }

      if (req.url === "/background-jobs" && req.method === "POST") {
        const bridgeToken = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim();
        if (bridgeToken && req.headers["x-tango-collaboration-token"] !== bridgeToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const input = JSON.parse(body || "{}") as Record<string, unknown>;
            const result = handleBackgroundJobRequest(backgroundJobManager, input);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }

      if (await conversationWrite(req, res, deliverConversationInput)) return;
      if (await conversationRead(req, res, storage, attachmentDataDir)) return;

      if (req.url === "/screen/input" && req.method === "POST") {
        const bridgeToken = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim();
        if (bridgeToken && req.headers["x-tango-collaboration-token"] !== bridgeToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          void (async () => {
            try {
              const result = await deliverScreenInput(JSON.parse(body || "{}") as Record<string, unknown>);
              res.writeHead(result.delivered ? 200 : 422, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          })();
        });
        return;
      }

      if (req.url === "/collaboration/request" && req.method === "POST") {
        const bridgeToken = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim();
        if (bridgeToken && req.headers["x-tango-collaboration-token"] !== bridgeToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          void (async () => {
            try {
              const input = JSON.parse(body || "{}") as Record<string, unknown>;
              const result = await agentCollaborationService.collaborate(input);
              res.writeHead(result.status === "denied" ? 403 : 200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          })();
        });
        req.on("error", (err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
        return;
      }

      // The Agent Desk's job buttons: Run now starts a run without waiting for it; Pause and Resume hold its timed runs.
      // Any schedule id the config accepts, URL-encoded by the desk (Codex review on #704).
      const action = req.url?.match(/^\/schedules\/([^/?]+)\/(run|pause|resume)$/);
      if (action && req.method === "POST") {
        let scheduleId: string;
        try {
          scheduleId = decodeURIComponent(action[1]!);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad schedule id" }));
          return;
        }
        const verb = action[2] as "run" | "pause" | "resume";
        console.error(`[scheduler] HTTP ${verb}: ${scheduleId}`);
        const send = (status: number, body: Record<string, unknown>) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (verb === "run") {
          const outcome = scheduler!.runNow(scheduleId);
          if (outcome === "missing") return send(404, { error: "schedule not found" });
          return send(outcome === "started" ? 202 : 409, outcome === "started" ? { ok: true, started: true } : { error: "a run is already in progress" });
        }
        if (!scheduler!.setPaused(scheduleId, verb === "pause")) return send(404, { error: "schedule not found" });
        return send(200, { ok: true, paused: verb === "pause" });
      }

      const match = req.url?.match(/^\/trigger\/([a-z0-9_-]+)$/);
      if (!match || req.method !== "GET") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Use GET /trigger/<schedule-id> or POST /collaboration/request" }));
        return;
      }
      const scheduleId = match[1]!;
      console.error(`[scheduler] HTTP trigger: ${scheduleId}`);
      try {
        const result = await scheduler!.trigger(scheduleId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result ?? { error: "schedule not found" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    triggerServer.on("error", (err) => {
      if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        console.error("[scheduler] trigger endpoint disabled: port 9200 already in use");
        return;
      }
      console.error("[scheduler] trigger endpoint error", err);
    });
    triggerServer.listen(9200, "127.0.0.1", () => {
      console.error("[scheduler] trigger endpoint listening on http://127.0.0.1:9200/trigger/<id>");
      console.error("[collaboration] bridge endpoint listening on http://127.0.0.1:9200/collaboration/request");
    });
  }
}).catch((err) => {
  console.error("[tango] Persistent MCP server startup error:", err);
});

// Clean up MCP server on exit or signal
function cleanupMcpServer() {
  mcpShuttingDown = true;
  if (mcpRestartTimer) clearTimeout(mcpRestartTimer);
  if (persistentMcpProcess && !persistentMcpProcess.killed) {
    persistentMcpProcess.kill();
    persistentMcpProcess = null;
  }
}
process.on("exit", cleanupMcpServer);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanupMcpServer();
    process.exit(0);
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    ...(enableMessageContent ? [GatewayIntentBits.MessageContent] : [])
  ],
  partials: [Partials.Reaction]
});

registerDeterministicHandler("active-threads-tracker", createActiveThreadsTracker(client));
const orientationNudgeChannelId =
  process.env.ORIENTATION_NUDGE_CHANNEL_ID
  ?? process.env.TANGO_ORIENTATION_NUDGE_CHANNEL_ID
  // 2026-07-18 claude-primary flip (TGO-809): watson owns the primary dogfood
  // channel again, so prefer its voice channel before the Ollama clone's.
  ?? agentRegistry.get("watson")?.voice?.defaultChannelId
  ?? agentRegistry.get("watson-ollama")?.voice?.defaultChannelId
  ?? null;
registerDeterministicHandler("orientation-nudge", createOrientationNudgeHandler(client, {
  channelId: orientationNudgeChannelId,
  async recordNudgeMessage(input) {
    const route = sessionManager.route(`discord:${input.channelId}`)
      ?? sessionManager.route("discord:default");
    if (!route) return;
    await writeMessage({
      sessionId: route.sessionId,
      agentId: "watson",
      direction: "outbound",
      source: "tango",
      visibility: "public",
      discordMessageId: input.messageId,
      discordChannelId: input.channelId,
      content: input.content,
      metadata: {
        orientationNudge: true,
        nudgeId: input.nudgeId,
        task: input.task,
      },
    });
  },
}));

const conversationDeliveries = new ConversationDeliveryTracker();
const conversationWebhookIds = new Set<string>();
const replyPresenter = createReplyPresenter({
  onWebhook: id => { conversationWebhookIds.add(id); },
  systemDisplayName,
  logger: {
    warn(message: string): void {
      console.warn(message);
    }
  }
});

/**
 * Resolve the effective channel ID for routing and access control.
 * For forum/thread messages, Discord sets message.channelId to the thread ID,
 * but our session configs and allowlists reference the parent forum/text channel ID.
 * This helper resolves through to the parent when the message is in a thread.
 */
function resolveRoutingChannelId(message: Message): string {
  const channel = message.channel;
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    const parentId = (channel as { parentId?: string | null }).parentId;
    if (parentId) return parentId;
  }
  return message.channelId;
}

async function backfillThreadSessionAgents(): Promise<void> {
  const missing = storage.listThreadSessionsMissingAgent();
  if (missing.length === 0) {
    console.log("[tango-discord] thread-agent-backfill missing=0 updated=0 unresolved=0");
    return;
  }

  let updated = 0;
  let unresolved = 0;

  for (const thread of missing) {
    try {
      const channel = await client.channels.fetch(thread.threadId).catch(() => null);
      let agentId: string | null = null;

      if (channel?.isThread()) {
        const parentId = channel.parentId?.trim();
        if (parentId) {
          const route = sessionManager.route(`discord:${parentId}`) ?? sessionManager.route("discord:default");
          agentId = route?.agentId?.trim() ?? null;
        }
      }

      if (!agentId) {
        agentId = storage.getSessionDefaultAgentId(thread.sessionId)?.trim() ?? null;
      }

      if (!agentId) {
        unresolved++;
        continue;
      }

      storage.setThreadSession(thread.threadId, thread.sessionId, agentId);
      updated++;
    } catch {
      unresolved++;
    }
  }

  console.log(`[tango-discord] thread-agent-backfill missing=${missing.length} updated=${updated} unresolved=${unresolved}`);
}

function toChannelKey(message: Message): string {
  const channelId = resolveRoutingChannelId(message);
  return `discord:${channelId}`;
}

function getFocusedTextAgentId(channelKey: string): string | null {
  const focusedAgentId = focusedTextAgentByChannel.get(channelKey)?.trim();
  if (!focusedAgentId) return null;
  if (!agentRegistry.get(focusedAgentId)) {
    focusedTextAgentByChannel.delete(channelKey);
    return null;
  }
  return focusedAgentId;
}

function setFocusedTextAgentId(channelKey: string, agentId: string | null): void {
  const normalized = agentId?.trim();
  if (!normalized) {
    focusedTextAgentByChannel.delete(channelKey);
    return;
  }
  focusedTextAgentByChannel.set(channelKey, normalized);
}

function getFocusedTextTopic(channelKey: string): TopicRecord | null {
  try {
    return storage.getFocusedTopicForChannel(channelKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve focused topic", message);
    return null;
  }
}

function getActiveTextTopic(
  channelKey: string,
  route?: { sessionId: string } | null,
): TopicRecord | null {
  const routedTopic = route?.sessionId
    ? resolveTopicRecordForSession(route.sessionId)
    : null;
  return routedTopic ?? getFocusedTextTopic(channelKey);
}

function setFocusedTextTopicId(channelKey: string, topicId: string | null): void {
  try {
    storage.setFocusedTopicForChannel(channelKey, topicId?.trim() || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to persist focused topic", message);
  }
}

function getFocusedTextProjectId(channelKey: string): string | null {
  try {
    const projectId = storage.getFocusedProjectIdForChannel(channelKey)?.trim() || null;
    if (!projectId) return null;
    if (!projectDirectory.getProject(projectId)) {
      storage.setFocusedProjectForChannel(channelKey, null);
      return null;
    }
    return projectId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve focused project", message);
    return null;
  }
}

function setFocusedTextProjectId(channelKey: string, projectId: string | null): void {
  try {
    storage.setFocusedProjectForChannel(channelKey, projectId?.trim() || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to persist focused project", message);
  }
}

function getFocusedTextProject(channelKey: string): ReturnType<ProjectDirectory["getProject"]> {
  return projectDirectory.getProject(getFocusedTextProjectId(channelKey));
}

function resolveProjectForRoute(
  route: { sessionId: string } | null | undefined
): ReturnType<ProjectDirectory["getProject"]> {
  return projectDirectory.getProject(parseProjectSessionId(route?.sessionId));
}

function resolveProjectForTopic(topic: TopicRecord | null): ReturnType<ProjectDirectory["getProject"]> {
  return projectDirectory.getProject(topic?.projectId);
}

function resolveActiveProject(
  channelKey: string,
  topic: TopicRecord | null,
  route?: { sessionId: string } | null
): ReturnType<ProjectDirectory["getProject"]> {
  if (topic) {
    return resolveProjectForTopic(topic);
  }
  return getFocusedTextProject(channelKey) ?? resolveProjectForRoute(route);
}

function resolveDefaultTopicLeadAgent(
  routeAgentId: string,
  channelKey: string,
  options?: { allowFocusedProject?: boolean }
): AgentConfig | null {
  const focusedAgentId = getFocusedTextAgentId(channelKey);
  if (focusedAgentId) {
    const focusedAgent = agentRegistry.get(focusedAgentId);
    if (focusedAgent) return focusedAgent;
  }

  const activeProject =
    options?.allowFocusedProject === false
      ? null
      : resolveActiveProject(channelKey, getFocusedTextTopic(channelKey));
  const projectDefaultAgentId = activeProject?.defaultAgentId?.trim();
  if (projectDefaultAgentId) {
    const projectDefaultAgent = agentRegistry.get(projectDefaultAgentId);
    if (projectDefaultAgent) return projectDefaultAgent;
  }

  const defaultPromptAgent = voiceTargets.resolveDefaultPromptAgent(routeAgentId);
  if (defaultPromptAgent) {
    const configuredAgent = agentRegistry.get(defaultPromptAgent.id);
    if (configuredAgent) return configuredAgent;
  }

  return agentRegistry.get(routeAgentId) ?? null;
}

function resolveContextualTargetAgent(input: {
  channelKey: string;
  routeSessionId: string;
  routeAgentId: string;
  explicitAgentId: string | null;
}): AgentConfig | null {
  const activeTopic = getActiveTextTopic(input.channelKey, {
    sessionId: input.routeSessionId,
  });
  const activeProject = resolveActiveProject(input.channelKey, activeTopic, {
    sessionId: input.routeSessionId
  });
  const topicLeadAgentId = activeTopic?.leadAgentId?.trim() || null;
  const projectDefaultAgentId = activeProject?.defaultAgentId?.trim() || null;

  const resolved = resolveTargetAgent(
    agentRegistry,
    input.routeAgentId,
    input.explicitAgentId ?? topicLeadAgentId ?? projectDefaultAgentId
  );

  // The -ollama channels exist to run the Ollama clones. If this is such a
  // channel (its route agent/session is an -ollama clone) but a name-address,
  // topic lead, or reply-referent resolved to a base (Claude) agent, redirect
  // to that agent's -ollama clone when one exists — so addressing "Sierra" in
  // the sierra-ollama channel never silently falls back to the metered Claude
  // agent. (The bare-name call-signs still reach the Claude agents in their own
  // channels.)
  const isOllamaChannel =
    input.routeAgentId.endsWith("-ollama") || input.routeSessionId.endsWith("-ollama");
  if (resolved && isOllamaChannel && !resolved.id.endsWith("-ollama")) {
    const clone = agentRegistry.get(`${resolved.id}-ollama`);
    if (clone) return clone;
  }

  return resolved;
}

function upsertChannelTopic(
  channelKey: string,
  topicName: string,
  leadAgent: AgentConfig | null,
  projectId: string | null,
  preserveProjectId = true
): TopicRecord {
  const title = topicName.trim().replace(/\s+/g, " ");
  const slug = normalizeTopicSlug(title);
  if (!slug) {
    throw new Error("Topic name must include letters or numbers.");
  }

  return storage.upsertTopic({
    channelKey,
    slug,
    title,
    leadAgentId: leadAgent?.id ?? null,
    projectId: projectId ?? null,
    preserveProjectId
  });
}

function getChannelTopicByName(channelKey: string, topicName: string): TopicRecord | null {
  const slug = normalizeTopicSlug(topicName);
  if (!slug) return null;
  return storage.getTopicByChannelAndSlug(channelKey, slug);
}

// Inline "on X:"/"in X," prefixes count as topic references only when they name
// an existing topic for the channel or use the explicit "topic" keyword.
// Without this, ordinary prose like "On the return, there are a couple of
// ways..." spawns a junk topic and strands the turn in a fresh session
// (TGO-690, Playa Azul incident).
function applyInlineTopicGuard(
  naturalRoute: NaturalTextRoute | null,
  channelKey: string,
): NaturalTextRoute | null {
  if (!naturalRoute?.topicName) return naturalRoute;
  if (naturalRoute.topicExplicit) return naturalRoute;
  if (getChannelTopicByName(channelKey, naturalRoute.topicName)) return naturalRoute;
  console.log(
    `[tango-discord] inline topic ignored (no existing topic, no "topic" keyword): "${naturalRoute.topicName.slice(0, 80)}"`,
  );
  return {
    ...naturalRoute,
    topicName: null,
    promptText: naturalRoute.promptTextBeforeTopicStrip,
  };
}

function resolveActiveTextRoute(
  route: { sessionId: string; agentId: string },
  channelKey: string
): {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
  project: ReturnType<ProjectDirectory["getProject"]>;
} {
  const topic = getActiveTextTopic(channelKey, route);
  const project = resolveActiveProject(channelKey, topic, route);
  if (topic) {
    return {
      sessionId: buildTopicSessionId(topic.id),
      agentId: topic.leadAgentId ?? route.agentId,
      topic,
      project
    };
  }

  if (project) {
    return {
      sessionId: buildProjectSessionId(project.id),
      agentId: project.defaultAgentId ?? route.agentId,
      topic: null,
      project
    };
  }

  return {
    sessionId: route.sessionId,
    agentId: route.agentId,
    topic: null,
    project: null
  };
}

function resolvePromptTextRoute(input: {
  route: { sessionId: string; agentId: string };
  channelKey: string;
  targetAgent: AgentConfig;
  naturalRoute: ReturnType<typeof parseNaturalTextRoute> | null;
}): {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
  project: ReturnType<ProjectDirectory["getProject"]>;
} {
  const topicName = input.naturalRoute?.topicName?.trim();
  if (!topicName) {
    return resolveActiveTextRoute(input.route, input.channelKey);
  }

  const topic = upsertChannelTopic(
    input.channelKey,
    topicName,
    input.targetAgent,
    null,
    true
  );
  setFocusedTextTopicId(input.channelKey, topic.id);
  return {
    sessionId: buildTopicSessionId(topic.id),
    agentId: topic.leadAgentId ?? input.targetAgent.id,
    topic,
    project: resolveProjectForTopic(topic)
  };
}

function canRunAdminTextCommand(message: Message): boolean {
  return (
    message.member?.permissions.has(PermissionFlagsBits.Administrator) === true ||
    message.member?.permissions.has(PermissionFlagsBits.ManageGuild) === true
  );
}

async function handleNaturalTextSystemCommand(input: {
  message: Message;
  channelKey: string;
  route: { sessionId: string; agentId: string };
  command: NaturalTextSystemCommand;
}): Promise<void> {
  const { message, channelKey, route, command } = input;

  async function persistSystemReply(
    text: string,
    options?: {
      sessionId?: string;
      topic?: TopicRecord | null;
      project?: ReturnType<ProjectDirectory["getProject"]>;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const resolvedSessionId = options?.sessionId ?? resolveActiveTextRoute(route, channelKey).sessionId;
    await writeMessage({
      sessionId: resolvedSessionId,
      agentId: route.agentId,
      direction: "inbound",
      source: "discord",
      visibility: "public",
      discordMessageId: message.id,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      content: message.content,
      metadata: {
        channelKey,
        attachments: attachmentsForMetadata(message),
        localSystemCommand: true,
        commandType: command.type,
        topicId: options?.topic?.id ?? null,
        topicSlug: options?.topic?.slug ?? null,
        topicTitle: options?.topic?.title ?? null,
        projectId: options?.project?.id ?? null,
        projectTitle: options?.project?.displayName ?? null,
        ...options?.metadata
      }
    });

    const replyDelivery = await sendPresentedReply(message.channel, text, systemSpeaker);
    await writeMessage({
      sessionId: resolvedSessionId,
      agentId: route.agentId,
      direction: "system",
      source: "tango",
      visibility: "public",
      discordMessageIds: replyDelivery.messageIds,
      discordMessageId: replyDelivery.lastMessageId ?? null,
      discordChannelId: message.channelId,
      discordUserId: replyDelivery.delivery === "bot" ? client.user?.id ?? null : null,
      discordUsername: replyDelivery.actualDisplayName,
      content: text,
      metadata: {
        replyToDiscordMessageId: message.id,
        localSystemCommand: true,
        commandType: command.type,
        channelKey,
        topicId: options?.topic?.id ?? null,
        topicSlug: options?.topic?.slug ?? null,
        topicTitle: options?.topic?.title ?? null,
        projectId: options?.project?.id ?? null,
        projectTitle: options?.project?.displayName ?? null,
        senderIdentity: {
          intendedDisplayName: replyDelivery.intendedDisplayName,
          actualDisplayName: replyDelivery.actualDisplayName,
          delivery: replyDelivery.delivery
        },
        ...options?.metadata
      }
    });
  }

  switch (command.type) {
    case "status":
      if (!canRunAdminTextCommand(message)) {
        await persistSystemReply(
          "This command requires `Administrator` or `Manage Server` permission."
        );
        return;
      }
      await persistSystemReply(formatHealthStatus());
      return;
    case "focus-agent": {
      const agent = voiceTargets.resolveAgentQuery(command.agentQuery);
      if (!agent) {
        await persistSystemReply(`I couldn't find an agent named ${command.agentQuery}.`);
        return;
      }

      setFocusedTextAgentId(channelKey, agent.id);
      await persistSystemReply(`Focused on ${agent.displayName}. You can keep talking.`, {
        metadata: {
          focusedAgentId: agent.id
        }
      });
      return;
    }
    case "clear-focus": {
      const focusedAgent = voiceTargets.getAgent(getFocusedTextAgentId(channelKey));
      if (!focusedAgent) {
        await persistSystemReply("No agent focus is active right now.");
        return;
      }

      setFocusedTextAgentId(channelKey, null);
      await persistSystemReply(`Back to ${systemDisplayName}.`);
      return;
    }
    case "current-agent": {
      const focusedAgent = voiceTargets.getAgent(getFocusedTextAgentId(channelKey));
      if (focusedAgent) {
        await persistSystemReply(`You are focused on ${focusedAgent.displayName}.`, {
          metadata: {
            focusedAgentId: focusedAgent.id
          }
        });
      } else {
        await persistSystemReply(`No focused agent. Say ${systemDisplayName}, talk to an agent name.`);
      }
      return;
    }
    case "open-topic": {
      let topicProject: ReturnType<ProjectDirectory["getProject"]> = null;
      if (command.projectName) {
        topicProject = projectDirectory.resolveProjectQuery(command.projectName);
        if (!topicProject) {
          await persistSystemReply(`I couldn't find a project named ${command.projectName}.`);
          return;
        }
        setFocusedTextProjectId(channelKey, topicProject.id);
      }
      const leadAgent = topicProject?.defaultAgentId
        ? agentRegistry.get(topicProject.defaultAgentId) ?? resolveDefaultTopicLeadAgent(route.agentId, channelKey)
        : resolveDefaultTopicLeadAgent(route.agentId, channelKey, { allowFocusedProject: false });
      const topic = upsertChannelTopic(
        channelKey,
        command.topicName,
        leadAgent,
        topicProject?.id ?? null,
        false
      );
      setFocusedTextTopicId(channelKey, topic.id);
      const topicRoute = {
        sessionId: buildTopicSessionId(topic.id),
        agentId: topic.leadAgentId ?? route.agentId
      };
      upsertSessionForRoute(topicRoute, channelKey);
      const project = resolveProjectForTopic(topic);
      await persistSystemReply(formatOpenedTopicMessage(topic.title, project?.displayName), {
        sessionId: topicRoute.sessionId,
        topic,
        project,
        metadata: {
          leadAgentId: topic.leadAgentId,
          topicStandalone: project === null
        }
      });
      return;
    }
    case "move-topic-to-project": {
      const project = projectDirectory.resolveProjectQuery(command.projectName);
      if (!project) {
        await persistSystemReply(`I couldn't find a project named ${command.projectName}.`);
        return;
      }

      const existingTopic = command.topicName
        ? getChannelTopicByName(channelKey, command.topicName)
        : getFocusedTextTopic(channelKey);
      if (!existingTopic) {
        await persistSystemReply(
          command.topicName
            ? `I couldn't find a topic named ${command.topicName}.`
            : "No topic is active right now."
        );
        return;
      }

      setFocusedTextProjectId(channelKey, project.id);
      const leadAgent = existingTopic.leadAgentId
        ? agentRegistry.get(existingTopic.leadAgentId)
        : null;
      const resolvedLeadAgent = leadAgent
        ?? (project.defaultAgentId ? agentRegistry.get(project.defaultAgentId) : null)
        ?? resolveDefaultTopicLeadAgent(route.agentId, channelKey);
      const movedTopic = upsertChannelTopic(
        channelKey,
        existingTopic.title,
        resolvedLeadAgent,
        project.id,
        false
      );
      setFocusedTextTopicId(channelKey, movedTopic.id);
      const topicRoute = {
        sessionId: buildTopicSessionId(movedTopic.id),
        agentId: movedTopic.leadAgentId ?? route.agentId
      };
      upsertSessionForRoute(topicRoute, channelKey);
      await persistSystemReply(`Moved topic ${movedTopic.title} to project ${project.displayName}.`, {
        sessionId: topicRoute.sessionId,
        topic: movedTopic,
        project,
        metadata: {
          leadAgentId: movedTopic.leadAgentId,
          movedTopicId: movedTopic.id
        }
      });
      return;
    }
    case "detach-topic-from-project": {
      const existingTopic = command.topicName
        ? getChannelTopicByName(channelKey, command.topicName)
        : getFocusedTextTopic(channelKey);
      if (!existingTopic) {
        await persistSystemReply(
          command.topicName
            ? `I couldn't find a topic named ${command.topicName}.`
            : "No topic is active right now."
        );
        return;
      }

      const previousProject = resolveProjectForTopic(existingTopic);
      if (!previousProject && !existingTopic.projectId) {
        setFocusedTextTopicId(channelKey, existingTopic.id);
        await persistSystemReply(`Topic ${existingTopic.title} is already standalone.`, {
          sessionId: buildTopicSessionId(existingTopic.id),
          topic: existingTopic
        });
        return;
      }

      if (existingTopic.projectId) {
        setFocusedTextProjectId(channelKey, existingTopic.projectId);
      }
      const leadAgent = existingTopic.leadAgentId
        ? agentRegistry.get(existingTopic.leadAgentId)
        : null;
      const detachedTopic = upsertChannelTopic(
        channelKey,
        existingTopic.title,
        leadAgent ?? resolveDefaultTopicLeadAgent(route.agentId, channelKey, { allowFocusedProject: false }),
        null,
        false
      );
      setFocusedTextTopicId(channelKey, detachedTopic.id);
      const topicRoute = {
        sessionId: buildTopicSessionId(detachedTopic.id),
        agentId: detachedTopic.leadAgentId ?? route.agentId
      };
      upsertSessionForRoute(topicRoute, channelKey);
      await persistSystemReply(
        `Detached topic ${detachedTopic.title} from project ${previousProject?.displayName ?? existingTopic.projectId}. It is now standalone.`,
        {
          sessionId: topicRoute.sessionId,
          topic: detachedTopic,
          metadata: {
            detachedTopicId: detachedTopic.id,
            previousProjectId: existingTopic.projectId,
            previousProjectTitle: previousProject?.displayName ?? null
          }
        }
      );
      return;
    }
    case "current-topic": {
      const topic = getFocusedTextTopic(channelKey);
      if (topic) {
        await persistSystemReply(formatCurrentTopicMessage(topic.title, resolveProjectForTopic(topic)?.displayName), {
          sessionId: buildTopicSessionId(topic.id),
          topic,
          project: resolveProjectForTopic(topic)
        });
      } else {
        await persistSystemReply("No topic is active right now.");
      }
      return;
    }
    case "clear-topic": {
      const topic = getFocusedTextTopic(channelKey);
      if (!topic) {
        await persistSystemReply("No topic is active right now.");
        return;
      }

      setFocusedTextTopicId(channelKey, null);
      const project = resolveProjectForTopic(topic);
      const resumeProject = getFocusedTextProject(channelKey) ?? resolveProjectForRoute(route);
      const reply = resumeProject
        ? `Left ${project ? `topic ${topic.title}` : `standalone topic ${topic.title}`}. Project ${resumeProject.displayName} is still active.`
        : `Left ${project ? `topic ${topic.title}` : `standalone topic ${topic.title}`}.`;
      await persistSystemReply(reply, {
        sessionId: buildTopicSessionId(topic.id),
        topic,
        project
      });
      return;
    }
    case "open-project": {
      const project = projectDirectory.resolveProjectQuery(command.projectName);
      if (!project) {
        await persistSystemReply(`I couldn't find a project named ${command.projectName}.`);
        return;
      }

      const clearedTopic = getFocusedTextTopic(channelKey);
      setFocusedTextTopicId(channelKey, null);
      setFocusedTextProjectId(channelKey, project.id);
      const projectRoute = {
        sessionId: buildProjectSessionId(project.id),
        agentId: project.defaultAgentId ?? route.agentId
      };
      upsertSessionForRoute(projectRoute, channelKey);
      await persistSystemReply(
        clearedTopic
          ? `Opened project ${project.displayName}. Cleared topic ${clearedTopic.title}.`
          : `Opened project ${project.displayName}. You can keep talking.`,
        {
          sessionId: projectRoute.sessionId,
          project,
          metadata: {
            clearedTopicId: clearedTopic?.id ?? null,
            clearedTopicTitle: clearedTopic?.title ?? null
          }
        }
      );
      return;
    }
    case "current-project": {
      const topic = getFocusedTextTopic(channelKey);
      const topicProject = resolveProjectForTopic(topic);
      const focusedProject = getFocusedTextProject(channelKey);
      const routedProject = resolveProjectForRoute(route);
      const resumeProject = focusedProject ?? routedProject;
      const project = topic ? topicProject : resumeProject;
      if (!project) {
        if (topic && resumeProject) {
          await persistSystemReply(
            focusedProject
              ? `Current topic ${topic.title} is standalone. Focused project ${resumeProject.displayName} will resume when you leave this topic.`
              : `Current topic ${topic.title} is standalone. Project ${resumeProject.displayName} will resume when you leave this topic.`,
            {
              sessionId: buildTopicSessionId(topic.id),
              topic
            }
          );
        } else {
          await persistSystemReply("No project is active right now.");
        }
        return;
      }

      await persistSystemReply(`You are in project ${project.displayName}.`, {
        sessionId: topic ? buildTopicSessionId(topic.id) : buildProjectSessionId(project.id),
        topic,
        project
      });
      return;
    }
    case "clear-project": {
      const topic = getFocusedTextTopic(channelKey);
      const focusedProject = getFocusedTextProject(channelKey);
      const routedProject = resolveProjectForRoute(route);
      const topicProject = resolveProjectForTopic(topic);
      const activeProject = topicProject ?? focusedProject ?? routedProject;
      if (!activeProject) {
        await persistSystemReply("No project is active right now.");
        return;
      }

      if (!focusedProject && routedProject?.id === activeProject.id) {
        await persistSystemReply(
          topic
            ? `Channel is routed to project ${routedProject.displayName}. Clear the topic separately or open another project to override it.`
            : `Channel is routed to project ${routedProject.displayName}. Open another project to override it.`,
          {
            sessionId: topic ? buildTopicSessionId(topic.id) : buildProjectSessionId(routedProject.id),
            topic,
            project: routedProject
          }
        );
        return;
      }

      setFocusedTextProjectId(channelKey, null);
      let clearedTopic: TopicRecord | null = null;
      if (topic && topic.projectId === activeProject.id) {
        clearedTopic = topic;
        setFocusedTextTopicId(channelKey, null);
      }

      const resumedProject = routedProject && routedProject.id !== activeProject.id ? routedProject : null;
      await persistSystemReply(
        clearedTopic
          ? resumedProject
            ? `Left project ${activeProject.displayName}. Cleared topic ${clearedTopic.title}. Channel returned to project ${resumedProject.displayName}.`
            : `Left project ${activeProject.displayName}. Cleared topic ${clearedTopic.title}.`
          : topic
            ? resumedProject
              ? `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? "attached to that project until you move it" : "standalone"}. Channel returned to project ${resumedProject.displayName}.`
              : `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? "attached to that project until you move it" : "standalone"}.`
            : resumedProject
              ? `Left project ${activeProject.displayName}. Channel returned to project ${resumedProject.displayName}.`
              : `Left project ${activeProject.displayName}.`,
        {
          sessionId: clearedTopic ? buildTopicSessionId(clearedTopic.id) : buildProjectSessionId((resumedProject ?? activeProject).id),
          topic: clearedTopic,
          project: resumedProject ?? activeProject
        }
      );
      return;
    }
  }
}

function parseLeadingCommands(messageContent: string): {
  promptText: string;
  agentOverride: string | null;
  responseModeOverride: ResponseMode | null;
} {
  let remaining = messageContent.trim();
  let agentOverride: string | null = null;
  let responseModeOverride: ResponseMode | null = null;

  for (let i = 0; i < 6; i += 1) {
    const agentMatch = remaining.match(/^\/agent\s+([a-z0-9-]+)\s*/iu);
    if (agentMatch?.[0] && agentMatch[1]) {
      agentOverride = agentMatch[1];
      remaining = remaining.slice(agentMatch[0].length).trimStart();
      continue;
    }

    const modeMatch = remaining.match(/^\/(concise|explain)\s*/iu);
    if (modeMatch?.[0] && modeMatch[1]) {
      responseModeOverride = modeMatch[1].toLowerCase() as ResponseMode;
      remaining = remaining.slice(modeMatch[0].length).trimStart();
      continue;
    }

    break;
  }

  return {
    promptText: remaining,
    agentOverride,
    responseModeOverride
  };
}

/**
 * Extract forwarded message text from Discord message snapshots.
 * Forwarded messages have empty content — the original text lives in messageSnapshots.
 */
function extractForwardedContent(message: Message): string | null {
  if (message.reference?.type !== MessageReferenceType.Forward) return null;
  const snapshots = (message as unknown as { messageSnapshots?: Map<string, Message> }).messageSnapshots;
  if (!snapshots || typeof snapshots.values !== "function") return null;
  const parts: string[] = [];
  for (const snapshot of snapshots.values()) {
    if (snapshot.content?.trim()) {
      parts.push(snapshot.content.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Download text content from .txt file attachments (e.g. Discord's auto-converted long pastes).
 * Returns the inlined text, or null if no text attachments exist.
 */
async function downloadTextAttachments(message: Message): Promise<string | null> {
  const textAttachments = [...message.attachments.values()].filter(
    (a) => a.name?.endsWith(".txt") && a.size < 100_000
  );
  if (textAttachments.length === 0) return null;

  const results: string[] = [];
  for (const attachment of textAttachments) {
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const text = await response.text();
      if (text.trim()) results.push(text.trim());
    } catch (err) {
      console.warn(`[tango-discord] failed to download text attachment ${attachment.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return results.length > 0 ? results.join("\n\n") : null;
}

/**
 * Resolve the effective text content of a Discord message, handling:
 * 1. Forwarded messages (content in messageSnapshots)
 * 2. Long pastes auto-converted to message.txt attachments
 * Falls back to message.content if neither edge case applies.
 */
async function resolveEffectiveContent(message: Message): Promise<string> {
  // Forwarded messages: content is in snapshots, not message.content
  const forwarded = extractForwardedContent(message);
  if (forwarded) {
    const prefix = message.content.trim();
    return prefix ? `${prefix}\n\n[Forwarded message]\n${forwarded}` : `[Forwarded message]\n${forwarded}`;
  }

  // Long paste → message.txt: Discord converts long text into a .txt attachment
  if (!message.content.trim() && message.attachments.size > 0) {
    const inlinedText = await downloadTextAttachments(message);
    if (inlinedText) return inlinedText;
  }

  return message.content;
}

function buildPrompt(text: string, message: Message): string {
  const normalized = text.trim();
  if (normalized.length > 0) return normalized;

  if (message.attachments.size === 0) return "";

  const attachmentList = [...message.attachments.values()]
    .map((attachment) => attachment.name ?? attachment.url)
    .join(", ");
  return `User sent ${message.attachments.size} attachment(s): ${attachmentList}`;
}

function normalizeMessageReferentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageReferentContentMatches(candidateContent: string, targetContent: string): boolean {
  const normalizedCandidate = normalizeMessageReferentText(candidateContent);
  const normalizedTarget = normalizeMessageReferentText(targetContent);
  if (!normalizedCandidate || !normalizedTarget) return false;
  return (
    normalizedCandidate === normalizedTarget ||
    normalizedCandidate.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedCandidate)
  );
}

function findStoredMessageForDiscordTarget(input: {
  discordMessageId?: string | null;
  discordChannelId: string;
  fallbackContent?: string | null;
}) {
  const discordMessageId = input.discordMessageId?.trim() || null;
  if (discordMessageId) {
    const exact = storage.getMessageByDiscordMessageId(discordMessageId, {
      channelId: input.discordChannelId,
    });
    if (exact) return exact;
  }

  const fallbackContent = input.fallbackContent?.trim() || null;
  if (!fallbackContent) return null;

  const candidates = storage.listRecentMessagesForDiscordChannel(input.discordChannelId, 30);
  return (
    candidates.find(
      (candidate) =>
        candidate.visibility === "public" &&
        candidate.source === "tango" &&
        messageReferentContentMatches(candidate.content, fallbackContent)
    ) ?? null
  );
}

function resolveReplyReferent(message: Message): MessageReferent | null {
  const referencedMessageId = message.reference?.messageId?.trim();
  if (!referencedMessageId) return null;

  const stored = findStoredMessageForDiscordTarget({
    discordMessageId: referencedMessageId,
    discordChannelId: message.channelId,
  });
  if (!stored) return null;

  return {
    kind: "reply",
    targetMessageId: referencedMessageId,
    targetSessionId: stored.sessionId,
    targetAgentId: stored.agentId,
    targetContent: stored.content,
    metadata: {
      source: "stored-message",
      storedMessageId: stored.id,
    },
  };
}

function takeReactionReferent(message: Message): MessageReferent | null {
  const storedReferent = storage.getChannelReferent(message.channelId, message.author.id);
  if (!storedReferent) return null;
  storage.clearChannelReferent(message.channelId, message.author.id);
  return {
    kind: "reaction",
    targetMessageId: storedReferent.targetMessageId,
    targetSessionId: storedReferent.targetSessionId,
    targetAgentId: storedReferent.targetAgentId,
    targetContent: storedReferent.targetContent,
    metadata: storedReferent.metadata,
  };
}

function resolveSessionRouteFromSessionId(sessionId: string, agentId: string): {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
  project: ReturnType<ProjectDirectory["getProject"]>;
} {
  const topic = resolveTopicRecordForSession(sessionId);
  return {
    sessionId,
    agentId,
    topic,
    project: resolveProjectForSession(sessionId),
  };
}

function resolveResponseMode(
  agent: AgentConfig,
  responseModeOverride: ResponseMode | null
): ResponseMode {
  if (responseModeOverride) return responseModeOverride;
  if (agent.responseMode === "explain") return "explain";
  return "concise";
}

function resolveTopicRecordForSession(sessionId: string): TopicRecord | null {
  const normalized = sessionId.trim();
  if (!normalized.startsWith("topic:")) return null;

  const topicId = normalized.slice("topic:".length).trim();
  if (!topicId) return null;

  try {
    return storage.getTopicById(topicId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve topic for session", message);
    return null;
  }
}

function resolveProjectForSession(sessionId: string): ReturnType<ProjectDirectory["getProject"]> {
  const normalized = sessionId.trim();
  const projectId = parseProjectSessionId(normalized);
  if (projectId) {
    return projectDirectory.getProject(projectId);
  }

  const topic = resolveTopicRecordForSession(normalized);
  return resolveProjectForTopic(topic);
}

function resolveEffectiveSessionConfig(sessionId: string): SessionConfig | undefined {
  const direct = sessionConfigById.get(sessionId);
  if (direct) return direct;

  const project = resolveProjectForSession(sessionId);
  if (project) {
    const projectConfig = sessionConfigById.get(buildProjectSessionId(project.id));
    if (projectConfig) return projectConfig;
  }

  return sessionConfigById.get("tango-default");
}

function resolveOrchestratorContinuityMode(sessionId: string): OrchestratorContinuityMode {
  return resolveEffectiveSessionConfig(sessionId)?.orchestratorContinuity ?? "provider";
}

/**
 * Per-agent continuity resolution for the warm-start producer. Ollama-backed
 * agents are forced to "stateless"; Claude-backed agents honor the effective
 * session YAML so operators can opt individual sessions into bounded warm-start.
 */
function resolveOrchestratorContinuityModeForAgent(
  agentId: string,
  sessionId: string,
): OrchestratorContinuityMode {
  return resolveWarmStartContinuityMode({
    isOllamaBacked: isOllamaBackedAgent(v2Configs.get(agentId)),
    sessionMode: resolveOrchestratorContinuityMode(sessionId),
  });
}

function getConversationKey(sessionId: string, agentId: string, threadChannelId?: string | null): string {
  if (threadChannelId) {
    return `${sessionId}:${agentId}:${threadChannelId}`;
  }
  return `${sessionId}:${agentId}`;
}

async function sendPresentedReply(
  channel: Message["channel"] | ChatInputCommandInteraction["channel"] | null,
  text: string,
  speaker: AgentConfig | null,
  replyToMessageId?: string,
  origin?: "check-in" | "schedule",
  /** The store row this delivery mirrors: enrich it rather than inserting a second copy. */
  localMessageId?: number,
) {
  return conversationDeliveries.run(channel?.id ?? "unknown", async () => {
    const delivery = await replyPresenter.sendChunked(channel, text, {
      speaker,
      replyToMessageId,
      botDisplayName: client.user?.username ?? systemDisplayName,
      avatarURL: resolveSpeakerAvatarURL(speaker, client.user?.displayAvatarURL()),
      avatarPath: resolveSpeakerAvatarPath(speaker)
    });
    if (channel && delivery.sentChunks > 0) {
      const routingId = channel.isThread() ? channel.parentId ?? channel.id : channel.id;
      const route = sessionManager.route(`discord:${routingId}`) ?? sessionManager.route("discord:default");
      if (!route) console.error(`[tango-storage] No storage session for channel ${channel.id}`);
      else await writeMessage({
        ...(localMessageId ? { localMessageId } : {}),
        sessionId: storage.getThreadSession(channel.id)?.sessionId ?? route.sessionId,
        agentId: speaker === systemSpeaker ? route.agentId : speaker?.id ?? route.agentId, direction: speaker === systemSpeaker ? "system" : "outbound",
        source: "tango", discordChannelId: channel.id, discordMessageId: delivery.lastMessageId,
        discordMessageIds: delivery.messageIds, discordUsername: delivery.actualDisplayName,
        content: text, metadata: { replyToDiscordMessageId: replyToMessageId, deliveryFailed: delivery.failed, postOrigin: origin },
      });
    }
    return delivery;
  });
}

function buildFailedReplyDeliveryResult(speaker: AgentConfig | null): PresentedReplyResult {
  const intendedDisplayName = resolveSpeakerDisplayName(speaker, systemDisplayName);
  return {
    sentChunks: 0,
    delivery: "bot",
    intendedDisplayName,
    actualDisplayName: client.user?.username ?? systemDisplayName,
    failed: true
  };
}

function ensureReplyDeliverySucceeded(
  result: PresentedReplyResult,
  channelId: string | null | undefined
): void {
  if (!result.failed) {
    return;
  }

  throw new DeliveryError(
    `[tango-discord] reply delivery incomplete channel=${channelId ?? "unknown"} sentChunks=${result.sentChunks}`,
    {
      channelId: channelId ?? undefined,
      result
    }
  );
}

const promptLayerWarningKeys = new Set<string>();

function formatPromptLayerWarning(finding: PromptLayerAuditFinding): string {
  return [
    `Tango profile warning for ${finding.agentId}: ${finding.summary}`,
    "",
    `Repo path: ${finding.repoRelativePath}`,
    `Profile target: ${finding.profileTargetHint}`,
    "",
    "This warning is shown only in Discord and is not added to the agent prompt.",
    "Inspect with `npm run cli -- prompt audit`; migrate with `bash scripts/migrate-personal-context-to-profile.sh --dry-run`.",
  ].join("\n");
}

async function sendPromptLayerWarningsIfNeeded(
  message: Message,
  agentId: string,
): Promise<void> {
  if (process.env.TANGO_PROMPT_LAYER_WARNINGS === "0") {
    return;
  }

  const findings = findRepoLayerPersonalPromptFindings()
    .filter((finding) => finding.agentId === agentId);

  for (const finding of findings) {
    const key = `${message.channelId}:${agentId}:${finding.repoRelativePath}`;
    if (promptLayerWarningKeys.has(key)) {
      continue;
    }
    promptLayerWarningKeys.add(key);

    try {
      const delivery = await sendPresentedReply(
        message.channel,
        formatPromptLayerWarning(finding),
        systemSpeaker,
      );
      ensureReplyDeliverySucceeded(delivery, message.channelId);
    } catch (error) {
      console.warn(
        `[tango-discord] prompt-layer warning failed agent=${agentId} path=${finding.repoRelativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveIMessageRoute(
  channelKey: string
): {
  sessionId: string;
  agentId: string;
} | null {
  const configured = sessionManager.route(channelKey);
  if (configured) return configured;

  const fallback = sessionManager.route("imessage:default");
  if (fallback) {
    return {
      sessionId: channelKey,
      agentId: imessageDefaultAgent ?? fallback.agentId
    };
  }

  if (!imessageDefaultAgent) {
    return null;
  }

  return {
    sessionId: channelKey,
    agentId: imessageDefaultAgent
  };
}

function buildIMessageMetadata(
  message: IMessageInboundMessage,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    channelKey: message.channelKey,
    imessage: {
      chatId: message.chatId,
      sender: message.sender,
      chatIdentifier: message.chatIdentifier,
      isGroup: message.isGroup,
      createdAt: message.createdAt,
      messageId: message.messageId
    },
    ...extra
  };
}

function resolveProviderByName(providerName: string): ChatProvider {
  return selectProviderByName(providerName, providers);
}

function resolveSessionProviderOverride(sessionId: string, agentId: string): string | undefined {
  try {
    const override = storage.getSessionProviderOverride(sessionId, agentId);
    return override?.providerName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve session provider override", message);
    return undefined;
  }
}

function normalizeConfiguredModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredReasoningEffort(
  input: {
    project?: { provider?: { reasoningEffort?: ProviderReasoningEffort } } | null;
    agent?: { provider: { reasoningEffort?: ProviderReasoningEffort } };
    worker?: { provider: { reasoningEffort?: ProviderReasoningEffort } };
  }
): ProviderReasoningEffort | undefined {
  return input.project?.provider?.reasoningEffort
    ?? input.worker?.provider.reasoningEffort
    ?? input.agent?.provider.reasoningEffort;
}

function resolveProviderNamesForTurn(input: { sessionId: string; agent: AgentConfig }): {
  providerNames: string[];
  configuredProviderNames: string[];
  project: ReturnType<ProjectDirectory["getProject"]>;
  overrideProviderName?: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
} {
  const project = resolveProjectForSession(input.sessionId);
  const configuredProviderNames = [
    ...resolveProviderCandidates(project ?? {}),
    ...resolveProviderCandidates(input.agent)
  ].filter((value, index, all) => all.indexOf(value) === index);
  const overrideProviderName = resolveSessionProviderOverride(input.sessionId, input.agent.id);
  const configuredModel =
    normalizeConfiguredModel(project?.provider?.model)
    ?? normalizeConfiguredModel(input.agent.provider.model);
  return {
    providerNames: mergeProviderOrder(configuredProviderNames, overrideProviderName),
    configuredProviderNames,
    project,
    overrideProviderName,
    model: overrideProviderName ? undefined : configuredModel,
    reasoningEffort: resolveConfiguredReasoningEffort({ project, agent: input.agent }),
  };
}

function buildScheduleExecutionSessionId(scheduleId: string, agentId: string): string {
  return `schedule:${agentId}:${scheduleId}`;
}

function resolveProviderChain(providerNames: string[]): Array<{ providerName: string; provider: ChatProvider }> {
  const chain: Array<{ providerName: string; provider: ChatProvider }> = [];
  for (const providerName of providerNames) {
    try {
      const provider = resolveProviderByName(providerName);
      chain.push({ providerName, provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tango-discord] skipping unsupported provider '${providerName}': ${message}`);
    }
  }

  if (chain.length === 0) {
    throw new Error("No supported providers available for this turn.");
  }

  return chain;
}

async function linkVoicePost(id: number, messageIds: string[]): Promise<void> {
  const row = storage.getMessage(id);
  if (!row) return;
  await writeMessage({ ...row, localMessageId: id, discordMessageIds: messageIds,
    discordMessageId: messageIds.at(-1), source: "voice" });
}

async function syncVoiceUserMessageToDiscord(
  channelId: string | null | undefined,
  transcript: string,
  discordUserId: string | null | undefined,
  localMessageId?: number | null,
): Promise<string | null> {
  if (!channelId) return null;
  return conversationDeliveries.run(channelId, async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return null;

      // Resolve user display name and avatar
      let userDisplayName = "You";
      let userAvatarURL: string | undefined;
      if (discordUserId) {
        try {
          const user = await client.users.fetch(discordUserId);
          userDisplayName = user.globalName ?? user.username;
          userAvatarURL = user.displayAvatarURL();
        } catch {
          // Non-fatal — fall back to defaults
        }
      }

      // Post user transcript with user avatar and (voice) label.
      // Prefix with zero-width space so getInbox can reliably filter out voice-user
      // messages (they should not appear as unread agent responses in the inbox).
      const userVoiceLabel = `${userDisplayName} (voice)`;
      // The voice operator prefixes requests with bracketed notes for the agent ("[A screen
      // is live…]", test guards). The agent gets them; the owner's channel shows what they said.
      const spoken = transcript.replace(/^(\s*\[[^\]]{0,800}\]\s*)+/u, "").trim() || transcript;
      const markedTranscript = `\u200B${spoken}`;
      const progress = createVoiceReplyProgress();
      let messageIds: string[];
      try {
        messageIds = await sendVoiceReply(replyPresenter, channel, markedTranscript, {
          speaker: { id: "voice-user", displayName: userVoiceLabel } as AgentConfig,
          botDisplayName: userVoiceLabel,
          avatarURL: userAvatarURL,
        }, progress);
      } finally {
        if (localMessageId && progress.messageIds.length) await linkVoicePost(localMessageId, progress.messageIds);
      }
      console.log(
        `[tango-voice] voice-discord-sync user-msg channel=${channelId} messages=${messageIds.length} displayName=${userVoiceLabel} avatarURL=${userAvatarURL ?? "none"} resolvedUser=${userDisplayName}`
      );
      return messageIds[0] ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tango-voice] voice-discord-sync user-msg failed channel=${channelId}: ${message}`);
      return null;
    }
  });
}

async function syncVoiceAgentResponseToDiscord(
  channelId: string | null | undefined,
  responseText: string,
  speaker: AgentConfig,
  progress: VoiceReplyProgress = createVoiceReplyProgress(),
  localMessageId?: number | null,
): Promise<string[]> {
  if (!channelId) return [];
  return conversationDeliveries.run(channelId, async () => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${channelId} unavailable for voice sync.`);
    }

    // Post agent response with agent avatar and (voice) label
    const agentDisplayName = speaker.displayName?.trim() || speaker.id;
    const agentVoiceLabel = `${agentDisplayName} (voice)`;
    let messageIds: string[];
    try {
      messageIds = await sendVoiceReply(replyPresenter, channel, responseText, {
        speaker: { ...speaker, displayName: agentVoiceLabel },
        botDisplayName: agentVoiceLabel,
        avatarURL: resolveSpeakerAvatarURL(speaker, client.user?.displayAvatarURL()),
        avatarPath: resolveSpeakerAvatarPath(speaker),
      }, progress);
    } finally {
      if (localMessageId && progress.messageIds.length) await linkVoicePost(localMessageId, progress.messageIds);
    }
    console.log(
      `[tango-voice] voice-discord-sync agent-msg channel=${channelId} messages=${messageIds.length} displayName=${agentVoiceLabel}`
    );
    return messageIds;
  });
}

async function syncVoiceAgentResponseToDiscordWithRetry(
  channelId: string | null | undefined,
  responseText: string,
  speaker: AgentConfig,
  localMessageId?: number | null,
): Promise<string[]> {
  if (!channelId) return [];

  // One progress record across both attempts: the retry sends only the chunks
  // the first attempt did not deliver, and the ids are exactly what was posted.
  try {
    return await deliverVoiceReplyWithRetry({
      send: (progress) => syncVoiceAgentResponseToDiscord(channelId, responseText, speaker, progress, localMessageId),
      wait: waitMs,
      onRetry: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[tango-voice] voice-discord-sync retrying channel=${channelId} agent=${speaker.id} error=${message}`
        );
      },
    });
  } catch (retryError) {
    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
    console.error(
      `[tango-voice] voice-discord-sync FAILED after retry channel=${channelId} agent=${speaker.id} error=${retryMessage}`
    );
    throw retryError;
  }
}

/**
 * T-I-035: whisper fallback — the voice session's own persisted reading, by
 * its exact conversation key. Degrades to undefined on any storage failure
 * (honest no-reading, never a crash mid-turn).
 */
function resolvePersistedVoiceWhisperContextUsage(
  conversationKey: string,
  agentId: string,
): LastContextUsageSnapshot | undefined {
  try {
    const row = storage.getContextUsageSnapshot(conversationKey, agentId);
    if (!row) {
      return undefined;
    }

    return toLastContextUsageSnapshot({
      fraction: row.fraction,
      usedTokens: row.usedTokens,
      contextWindow: row.contextWindow,
      recordedAt: parseSnapshotTimestamp(row.recordedAt),
    });
  } catch (error) {
    console.warn(
      `[context] voice whisper snapshot read failed conversation=${conversationKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

async function executeVoiceTurn(turnInput: VoiceTurnInput): Promise<VoiceTurnResult> {
  const targetAgent = agentRegistry.get(turnInput.agentId);
  if (!targetAgent) {
    throw new Error(`Agent '${turnInput.agentId}' not found in config.`);
  }
  turnInput = {
    ...turnInput,
    messageTimestamp: turnInput.messageTimestamp?.trim() || new Date().toISOString(),
    messageTimestampSource: turnInput.messageTimestampSource ?? "voice-finalized",
  };

  const resolvedVoiceSyncChannelId =
    turnInput.channelId?.trim() ||
    extractChannelIdFromSessionKey(turnInput.sessionId) ||
    targetAgent.voice?.defaultChannelId?.trim() ||
    null;

  upsertSessionForRoute(
    {
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id
    },
    `voice:${resolvedVoiceSyncChannelId ?? "default"}`
  );

  let turnId: string | undefined;
  if (turnInput.utteranceId && turnInput.utteranceId.trim().length > 0) {
    const utteranceId = turnInput.utteranceId.trim();
    const claim = storage.claimVoiceTurnReceipt({
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id,
      utteranceId,
      metadata: {
        inputSource: "voice-bridge",
        guildId: turnInput.guildId ?? null,
        voiceChannelId: turnInput.voiceChannelId ?? null,
        channelId: resolvedVoiceSyncChannelId,
        discordUserId: turnInput.discordUserId ?? null
      }
    });
    turnId = claim.receipt.turnId;

    if (!claim.created) {
      const completedResult = buildVoiceTurnResultFromReceipt(turnId, claim.receipt);
      if (completedResult) {
        console.log(
          `[tango-voice] duplicate turn reused session=${turnInput.sessionId} utterance=${utteranceId} turn=${turnId}`
        );
        return completedResult;
      }

      if (claim.receipt.status === "processing") {
        console.log(
          `[tango-voice] duplicate turn awaiting completion session=${turnInput.sessionId} utterance=${utteranceId} turn=${turnId}`
        );
        const resolvedReceipt = await waitForVoiceTurnReceiptResolution({
          sessionId: turnInput.sessionId,
          utteranceId,
          lookupReceipt: (sessionId, currentUtteranceId) =>
            storage.getVoiceTurnReceipt(sessionId, currentUtteranceId)
        });
        if (resolvedReceipt) {
          const resolvedResult = buildVoiceTurnResultFromReceipt(turnId, resolvedReceipt);
          if (resolvedResult) {
            console.log(
              `[tango-voice] duplicate turn completed while waiting session=${turnInput.sessionId} utterance=${utteranceId} turn=${turnId}`
            );
            return resolvedResult;
          }

          if (resolvedReceipt.status === "failed") {
            throw new Error(
              `Voice turn '${utteranceId}' previously failed (turnId=${turnId}): ${resolvedReceipt.errorMessage ?? "unknown error"}`
            );
          }
        }

        throw new Error(
          `Voice turn '${utteranceId}' is already processing (turnId=${turnId}).`
        );
      }

      throw new Error(
        `Voice turn '${utteranceId}' previously failed (turnId=${turnId}): ${claim.receipt.errorMessage ?? "unknown error"}`
      );
    }
  }

  let voiceSyncChannelShape: { isThread: boolean; parentId?: string | null } | undefined;
  if (resolvedVoiceSyncChannelId) {
    try {
      const channel = await client.channels.fetch(resolvedVoiceSyncChannelId);
      if (channel) {
        voiceSyncChannelShape = {
          isThread: channel.isThread(),
          parentId: "parentId" in channel ? channel.parentId : null,
        };
        registerVoiceThread(storage, channel, turnInput.sessionId, targetAgent.id);
      }
    } catch (error) {
      console.warn(`[tango-voice] thread registration failed channel=${resolvedVoiceSyncChannelId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const responseMode = resolveResponseMode(targetAgent, null);
  const v2AgentConfig = voiceV2AgentRuntimeConfigs.get(targetAgent.id)?.config ?? null;
  const voiceDefaultChannelId = targetAgent.voice?.defaultChannelId?.trim() || null;
  const isVoiceThread =
    turnInput.channelId &&
    voiceDefaultChannelId &&
    turnInput.channelId !== voiceDefaultChannelId;
  const conversationKey = getConversationKey(
    turnInput.sessionId,
    targetAgent.id,
    isVoiceThread ? turnInput.channelId : null,
  );
  const voiceRouterChannelId = isVoiceThread
    ? (voiceDefaultChannelId ?? resolvedVoiceSyncChannelId ?? `voice:${turnInput.sessionId}`)
    : (resolvedVoiceSyncChannelId ?? voiceDefaultChannelId ?? `voice:${turnInput.sessionId}`);
  const voiceRouterThreadId = isVoiceThread ? turnInput.channelId ?? undefined : undefined;
  // Tools, memory and the desk see the canonical thread:/channel: key; the
  // session key above stays voice-shaped so resumption is unchanged.
  const voiceCanonical = canonicalVoiceConversation({
    postedChannelId: resolvedVoiceSyncChannelId,
    ...(voiceSyncChannelShape ? { postedChannel: voiceSyncChannelShape } : {}),
    routerChannelId: voiceRouterChannelId,
    ...(voiceRouterThreadId ? { routerThreadId: voiceRouterThreadId } : {}),
  });

  const inboundMessageId = await writeMessage({
    sessionId: turnInput.sessionId,
    agentId: targetAgent.id,
    direction: "inbound",
    source: "tango",
    visibility: "public",
    discordChannelId: resolvedVoiceSyncChannelId,
    discordUserId: turnInput.discordUserId ?? null,
    content: turnInput.transcript,
    metadata: {
      inputSource: "voice-bridge",
      turnId: turnId ?? null,
      utteranceId: turnInput.utteranceId ?? null,
      messageTimestamp: turnInput.messageTimestamp ?? null,
      messageTimestampSource: turnInput.messageTimestampSource ?? null,
      guildId: turnInput.guildId ?? null,
      voiceChannelId: turnInput.voiceChannelId ?? null,
      responseMode,
      runtime: v2AgentConfig ? "v2" : "legacy",
      conversationKey,
    }
  });

  const startedAt = Date.now();

  // Post user transcript to Discord immediately (before LLM processing).
  // Prefer the turn's explicit channelId, then any discord channel encoded in
  // the session key, before falling back to the agent's default voice channel.
  const transcriptMessagePromise = syncVoiceUserMessageToDiscord(
    resolvedVoiceSyncChannelId,
    turnInput.transcript,
    turnInput.discordUserId,
    inboundMessageId,
  );

  // Show "typing..." in the Discord text channel while the voice turn processes.
  // Discord's indicator lasts ~10s, so we repeat every 8s via per-agent REST typing.
  const voiceTypingSession = resolvedVoiceSyncChannelId
    ? agentTypingPresenter.start(targetAgent.id, resolvedVoiceSyncChannelId)
    : null;

  const clearVoiceTyping = (): void => {
    voiceTypingSession?.stop();
  };

  const syncVoiceAgentResponse = async (responseText: string, localMessageId?: number | null) => {
    console.log(
      `[tango-voice] voice-discord-sync agent-response channel=${resolvedVoiceSyncChannelId} agent=${targetAgent.id}`
    );
    const syncPromise = syncVoiceAgentResponseToDiscordWithRetry(
      resolvedVoiceSyncChannelId,
      responseText,
      targetAgent,
      localMessageId,
    );
    const responseMessagePromise = syncPromise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[tango-voice] voice-discord-sync PERMANENTLY FAILED channel=${resolvedVoiceSyncChannelId} agent=${targetAgent.id}: ${message}`
      );
      return [] as string[];
    });
    return resolveVoiceDiscordDelivery(resolvedVoiceSyncChannelId, transcriptMessagePromise, responseMessagePromise);
  };

  // Victor manual-console bridge: route voice to VICTOR-COS only when explicitly enabled.
  if (targetAgent.id === "victor" && isVictorManualConsoleBridgeActive()) {
    try {
      const bridgeMessage: VictorBridgeMessage = {
        id: randomUUID(),
        timestamp: turnInput.messageTimestamp ?? new Date().toISOString(),
        source: "discord-voice",
        user: turnInput.discordUserId
          ? { id: turnInput.discordUserId, username: "voice-user" }
          : null,
        channel: { id: resolvedVoiceSyncChannelId ?? `voice:${turnInput.sessionId}` },
        content: turnInput.transcript,
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
      };

      const requestId = await sendToVictorInbox(bridgeMessage);
      clearVoiceTyping();
      const bridgeResponse = await waitForVictorResponse(requestId, 120_000);

      const outboundMessageId = await writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: "victor-bridge",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: resolvedVoiceSyncChannelId,
        content: bridgeResponse.text,
        metadata: {
          inputSource: "voice-bridge",
          runtimePath: "victor-bridge",
          bridgeRequestId: requestId,
          turnId: turnId ?? null,
        },
      });

      const delivery = await syncVoiceAgentResponse(bridgeResponse.text, outboundMessageId);

      return {
        deduplicated: false,
        ...delivery,
        responseText: bridgeResponse.text,
        providerName: "victor-bridge",
        providerUsedFailover: false,
        ...(turnId ? { turnId } : {}),
      };
    } catch (error) {
      console.error(
        `[tango-discord] victor-bridge voice failed, falling back to ephemeral:`,
        error instanceof Error ? error.message : error,
      );
      // Fall through to normal dispatch
    }
  }

  if (!v2AgentConfig || !isV2RuntimeEnabled(v2AgentConfig)) {
    clearVoiceTyping();
    const messageText = `Agent '${targetAgent.id}' is not configured for the v2 voice runtime.`;
    const errorMessageId = await writeMessage({
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id,
      providerName: "claude-code-v2",
      direction: "error",
      source: "tango",
      visibility: "debug",
      discordChannelId: resolvedVoiceSyncChannelId,
      discordUserId: null,
      discordUsername: "Tango Voice",
      content: messageText,
      metadata: {
        inputSource: "voice-bridge",
        turnId: turnId ?? null,
        utteranceId: turnInput.utteranceId ?? null,
        guildId: turnInput.guildId ?? null,
        voiceChannelId: turnInput.voiceChannelId ?? null,
        responseMode,
        runtime: "v2-required",
      },
    });

    if (turnId) {
      storage.failVoiceTurnReceipt({
        turnId,
        errorMessage: messageText,
        requestMessageId: inboundMessageId,
        responseMessageId: errorMessageId,
        modelRunId: null,
        metadata: {
          inputSource: "voice-bridge",
          utteranceId: turnInput.utteranceId ?? null,
          runtime: "v2-required",
        },
      });
    }

    throw new Error(messageText);
  }

  const voiceWarmStartPrompt =
    await buildWarmStartContextPrompt({
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id,
      currentUserPrompt: turnInput.transcript,
      orchestratorContinuityMode: resolveOrchestratorContinuityModeForAgent(
        targetAgent.id,
        turnInput.sessionId,
      ),
      discordChannelId: voiceRouterChannelId,
      discordThreadId: voiceRouterThreadId,
    });
  // T-I-035: this read was blind against itself — it looked up a
  // thread:/channel: key that voice turns never write (voice sessions key by
  // `agent:…`, passed explicitly to routeMessage). Read the voice session's
  // OWN key in RAM first, then its persisted snapshot (restart survival).
  const voiceLastContextUsage =
    voiceTangoRouter?.getSessionByKey(conversationKey)?.lastContextUsage
    ?? resolvePersistedVoiceWhisperContextUsage(conversationKey, targetAgent.id);
  const currentTurnMetadataPrompt = buildCurrentTurnMetadataPrompt({
    timestamp: turnInput.messageTimestamp,
    timestampSource: turnInput.messageTimestampSource,
    config: v2AgentConfig.currentTurnMetadata,
    discord: {
      channelId: voiceRouterChannelId,
      ...(voiceRouterThreadId ? { threadId: voiceRouterThreadId } : {}),
    },
    ...(voiceLastContextUsage ? { contextUsage: voiceLastContextUsage } : {}),
  });
  // The same canonical key the turn's tools see (a non-default channel is a channel, not a thread),
  // so the state briefing, the tools and post-turn state all use one conversation.
  const voiceConversationKey = voiceCanonical.conversationKey;
  const voiceStateFilePointer = buildStateFilePointer(storage, voiceConversationKey, {
    vaultRoot: resolveStateVaultRoot(),
    profileRoot: resolveStateProfileRoot(),
  });
  const voiceSessionContextUsage = voiceLastContextUsage?.fraction;
  const voiceTurnBriefingPrompt = buildTurnBriefingPrompt({
    ...(voiceStateFilePointer ? { stateFile: voiceStateFilePointer } : {}),
    searchFirst: Boolean(voiceStateFilePointer) || process.env.TANGO_TURN_BRIEFING_SEARCH_FIRST === "1",
    ...(typeof voiceSessionContextUsage === "number" && Number.isFinite(voiceSessionContextUsage)
      ? { contextUsageFraction: voiceSessionContextUsage }
      : {}),
    stateDigest: buildStateDigest(voiceConversationKey, targetAgent.id),
  });
  const voiceContext = mergeSendContext(
    voiceWarmStartPrompt,
    VOICE_RESPONSE_FORMATTING_SYSTEM_PROMPT,
  );

  const voiceDeskTurn = startDeskTurn({ agentId: targetAgent.id, ...voiceCanonical });

  return dispatchVoiceTurnByRuntime({
    transcript: turnInput.transcript,
    agentId: targetAgent.id,
    channelId: voiceRouterChannelId,
    ...(voiceRouterThreadId ? { threadId: voiceRouterThreadId } : {}),
    conversationKey,
    provenanceConversationKey: voiceCanonical.conversationKey,
    // Tools see where the reply actually goes (a non-default channel is a channel, not a thread).
    provenanceChannel: { channelId: voiceCanonical.channelId, ...(voiceCanonical.threadId ? { threadId: voiceCanonical.threadId } : {}) },
    v2AgentConfig,
    tangoRouter: voiceTangoRouter,
    sendOptions: {
      context: voiceContext || undefined,
      currentTurnMetadataPrompt,
      ...(voiceTurnBriefingPrompt ? { turnBriefingPrompt: voiceTurnBriefingPrompt } : {}),
      onEvent: voiceDeskTurn.onEvent,
    },
    mapRouterResult: async (routeResult): Promise<VoiceTurnResult> => {
      const baseTurnResult = buildVoiceRouterResult({
        routeResult,
        v2AgentConfig: v2AgentConfig!,
        turnId,
      });
      // A runtime that exits non-zero with parseable output returns text with
      // metadata.error instead of throwing; that is still a failed turn.
      const voiceRuntimeFailure = runtimeErrorResponseFailure(routeResult.response);
      const turnResult: VoiceTurnResult = baseTurnResult.responseText.trim().length > 0
        ? (voiceRuntimeFailure ? { ...baseTurnResult, failed: true, failureReason: voiceRuntimeFailure.reason } : baseTurnResult)
        : buildVoiceRouterErrorResult({
            v2AgentConfig: v2AgentConfig!,
            turnId,
            responseText: VOICE_V2_TTS_ERROR_MESSAGE,
            failureReason: "empty-reply",
          });


      const latencyMs = Date.now() - startedAt;
      const response = routeResult.response;
      const runtimeMetadata = asRecord(response.metadata);

      const outboundMessageId = await writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: resolvedVoiceSyncChannelId,
        discordUserId: null,
        discordUsername: "Tango Voice",
        content: turnResult.responseText,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          latencyMs,
          providerSessionId: turnResult.providerSessionId ?? null,
          providerUsedFailover: false,
          conversationKey: routeResult.conversationKey,
          toolsUsed: response.toolsUsed ?? [],
          runtimeMetadata: response.metadata ?? null,
        }
      });

      const modelRunId = writeModelRun({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        conversationKey: routeResult.conversationKey,
        providerSessionId: turnResult.providerSessionId ?? null,
        model: response.model,
        responseMode,
        latencyMs,
        providerDurationMs: response.durationMs,
        requestMessageId: inboundMessageId,
        responseMessageId: outboundMessageId,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          toolsUsed: response.toolsUsed ?? [],
          runtimeExitCode: metadataNumber(runtimeMetadata, "exitCode") ?? null,
          runtimeSignal: metadataString(runtimeMetadata, "signal") ?? null,
          runtimeStderr: metadataString(runtimeMetadata, "stderr") ?? null,
          currentTurnMetadataIncluded: metadataBoolean(runtimeMetadata, "currentTurnMetadataIncluded") ?? false,
          currentTurnMetadataChars: metadataNumber(runtimeMetadata, "currentTurnMetadataChars") ?? null,
        },
        rawResponse: null,
      });

      const delivery = await syncVoiceAgentResponse(turnResult.responseText, outboundMessageId);

      if (turnId) {
        storage.completeVoiceTurnReceipt({
          turnId,
          providerName: turnResult.providerName,
          providerSessionId: turnResult.providerSessionId ?? null,
          responseText: turnResult.responseText,
          providerUsedFailover: false,
          requestMessageId: inboundMessageId,
          responseMessageId: outboundMessageId,
          modelRunId,
          metadata: {
            ...delivery,
            inputSource: "voice-bridge",
            utteranceId: turnInput.utteranceId ?? null,
            runtime: "v2",
            ...voiceTurnFailureMetadata(turnResult),
          }
        });
      }

      if (voiceRuntimeFailure) {
        voiceDeskTurn.failWith(voiceRuntimeFailure);
      } else if (turnResult.failed) {
        voiceDeskTurn.failWith({ reason: "error", message: "The agent returned an empty reply." });
      } else {
        voiceDeskTurn.finish();
      }

      maybeCompactSessionMemory({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id
      });

      // Skip capture when the runtime produced no text (turnResult fell back
      // to the TTS error message, which is not a real exchange).
      if (turnResult === baseTurnResult && !voiceRuntimeFailure) {
        scheduleStatePostTurn({
          turnId: routeResult.turnId,
          // Same canonical key the turn's state/memory tools saw (not the voice session key).
          conversationKey: voiceCanonical.conversationKey,
          sessionId: turnInput.sessionId,
          agentId: targetAgent.id,
          userMessage: turnInput.transcript,
          response: { ...response, text: turnResult.responseText },
          channelId: resolvedVoiceSyncChannelId ?? voiceRouterChannelId,
          requestMessageId: inboundMessageId,
          responseMessageId: outboundMessageId,
          discordResponseMessageId: null,
          occurredAt: turnInput.messageTimestamp ?? new Date().toISOString(),
        });
      }

      console.log(
        `[tango-voice] reply session=${turnInput.sessionId} agent=${targetAgent.id} provider=${turnResult.providerName} runtime=v2 ms=${latencyMs} conversation=${routeResult.conversationKey}`
      );

      clearVoiceTyping();

      return { ...turnResult, ...delivery };
    },
    onRouterError: async (error): Promise<VoiceTurnResult> => {
      const messageText = error instanceof Error ? error.message : String(error);
      const turnResult = buildVoiceRouterErrorResult({
        v2AgentConfig: v2AgentConfig!,
        turnId,
        failureReason: classifyVoiceRouterFailure(error),
      });
      voiceDeskTurn.fail(error);
      const latencyMs = Date.now() - startedAt;

      const errorMessageId = await writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        direction: "error",
        source: "tango",
        visibility: "debug",
        discordChannelId: resolvedVoiceSyncChannelId,
        discordUserId: null,
        discordUsername: "Tango Voice",
        content: messageText,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
        }
      });

      const outboundMessageId = await writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: resolvedVoiceSyncChannelId,
        discordUserId: null,
        discordUsername: "Tango Voice",
        content: turnResult.responseText,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          latencyMs,
          failed: true,
        }
      });

      const errorModelRunId = writeModelRun({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        conversationKey,
        responseMode,
        latencyMs,
        isError: true,
        errorMessage: messageText,
        requestMessageId: inboundMessageId,
        responseMessageId: errorMessageId,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          toolTelemetry: emptyToolTelemetry(),
        },
        rawResponse: null
      });

      const delivery = await syncVoiceAgentResponse(turnResult.responseText, outboundMessageId);

      if (turnId) {
        storage.completeVoiceTurnReceipt({
          turnId,
          providerName: turnResult.providerName,
          responseText: turnResult.responseText,
          requestMessageId: inboundMessageId,
          responseMessageId: outboundMessageId,
          modelRunId: errorModelRunId,
          metadata: {
            ...delivery,
            inputSource: "voice-bridge",
            utteranceId: turnInput.utteranceId ?? null,
            runtime: "v2",
            errorMessage: messageText,
            ...voiceTurnFailureMetadata(turnResult),
          }
        });
      }

      console.error(
        `[tango-voice] v2 turn failed session=${turnInput.sessionId} agent=${targetAgent.id} error=${messageText}`
      );

      clearVoiceTyping();

      return { ...turnResult, ...delivery };
    },
  });
}

/** Voice turns running now; with the channel queues, what a restart would cut off. */
let voiceTurnsInFlight = 0;
/** The same, per conversation ("agentId|channelId", channel empty for the agent's home): the
 * voice operator holds a conversation it stopped waiting on until its turn here is done. */
const voiceConversationsInFlight = new Map<string, number>();

const voiceBridge = voiceBridgeEnabled
  ? new HttpVoiceBridge(
      {
        executeTurn: async (turnInput: VoiceTurnInput) => {
          // Only Discord channels: another system's id (a coding thread id) once ran agents
          // in a phantom session for many minutes, posting nowhere.
          if (turnInput.channelId && !/^\d+$/.test(turnInput.channelId)) {
            throw new Error(`channelId "${turnInput.channelId}" is not a Discord channel`);
          }
          const conversation = `${turnInput.agentId ?? ""}|${turnInput.channelId ?? ""}`;
          voiceTurnsInFlight += 1;
          voiceConversationsInFlight.set(conversation, (voiceConversationsInFlight.get(conversation) ?? 0) + 1);
          try {
            return await executeVoiceTurn(turnInput);
          } finally {
            voiceTurnsInFlight -= 1;
            const left = (voiceConversationsInFlight.get(conversation) ?? 1) - 1;
            if (left > 0) voiceConversationsInFlight.set(conversation, left);
            else voiceConversationsInFlight.delete(conversation);
          }
        }
      },
      {
        host: voiceBridgeHost,
        port: voiceBridgePort,
        path: voiceBridgePath,
        mobileDispatchPath: mobileVoiceDispatchPath,
        apiKey: voiceBridgeApiKey,
        defaultSessionId: voiceDefaultSessionId,
        defaultAgentId: voiceDefaultAgentId
      }
    )
  : null;

const imessageMentionNames = [...new Set([systemDisplayName, ...voiceTargets.getAllCallSigns()])];
const imessageListener = imessageEnabled
  ? new IMessageListener({
      cliPath: imessageCliPath,
      contactsPath: imessageContactsPath,
      allowFrom: imessageAllowFrom,
      groupPolicy: imessageGroupPolicy,
      mentionNames: imessageMentionNames,
      textChunkLimit: imessageTextChunkLimit,
      logger: {
        info(message: string): void {
          console.log(message);
        },
        warn(message: string): void {
          console.warn(message);
        },
        error(message: string): void {
          console.error(message);
        }
      },
      onMessage: async (message) => {
        enqueueChannelWork(message.channelKey, "tango-imessage", async () => {
          await handleIMessageMessage(imessageListener!, message);
        });
      }
    })
  : null;

function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength - 3)}...`;
}

function formatHealthStatus(): string {
  const health = storage.getHealthSnapshot();
  const lines = [
    `status=${health.status}`,
    `db_version=${health.dbUserVersion}`,
    `sessions=${health.sessions}`,
    `messages=${health.messages}`,
    `model_runs=${health.modelRuns}`,
    `provider_sessions=${health.providerSessions}`,
    `dead_letters_pending=${health.deadLettersPending}`,
    `dead_letters_total=${health.deadLettersTotal}`,
    `last_message_at=${health.lastMessageAt ?? "-"}`,
    `listen_only=${listenOnly}`,
    `provider_retry_limit=${providerRetryLimit}`,
    `memory_compaction_trigger_turns=${memoryCompactionTriggerTurns}`,
    `memory_compaction_retain_recent_turns=${memoryCompactionRetainRecentTurns}`,
    `memory_compaction_summary_max_chars=${memoryCompactionSummaryMaxChars}`,
    `access_default_mode=${defaultAccessMode}`,
    `default_allowlist_channels=${defaultAccessPolicy.allowlistChannelIds.size}`,
    `default_allowlist_users=${defaultAccessPolicy.allowlistUserIds.size}`,
    `agent_access_overrides=${agentAccessOverrideCount}`,
  ];
  return ["Tango status", "```", ...lines, "```"].join("\n");
}

function formatDeadLettersList(input: {
  status: "pending" | "resolved" | "all";
  sessionId?: string;
  limit: number;
}): string {
  const entries = storage.listDeadLetters({
    status: input.status,
    sessionId: input.sessionId,
    limit: input.limit
  });

  if (entries.length === 0) {
    return "No dead-letter entries found.";
  }

  const header = [
    "Dead letters",
    `status=${input.status}`,
    `count=${entries.length}`,
    input.sessionId ? `session=${input.sessionId}` : null
  ]
    .filter((item): item is string => item !== null)
    .join(" ");

  const lines = entries.map((entry) =>
    [
      `id=${entry.id}`,
      `status=${entry.status}`,
      `session=${entry.sessionId}`,
      `agent=${entry.agentId}`,
      `fail=${entry.failureCount}`,
      `replay=${entry.replayCount}`,
      `error=${JSON.stringify(truncate(entry.lastErrorMessage, 80))}`
    ].join(" ")
  );

  const visibleLines: string[] = [];
  for (const line of lines) {
    const candidate = [header, "```", ...visibleLines, line, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleLines.push(line);
  }

  const truncatedCount = lines.length - visibleLines.length;
  if (truncatedCount > 0) {
    visibleLines.push(`... truncated=${truncatedCount}`);
  }

  return [header, "```", ...visibleLines, "```"].join("\n");
}

function formatAccessPolicyReport(input: {
  channelId: string;
  userId: string;
  mentioned: boolean;
  agentFilter?: string;
}): string {
  const channelKey = `discord:${input.channelId}`;
  const route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
  const routedTargetAgent = route ? resolveTargetAgent(agentRegistry, route.agentId, null) : null;

  const normalizedFilter = input.agentFilter?.trim().toLowerCase();
  const selectedAgents = normalizedFilter
    ? agentConfigs.filter((agent) => agent.id.toLowerCase() === normalizedFilter)
    : [...agentConfigs];
  selectedAgents.sort((a, b) => a.id.localeCompare(b.id));

  if (selectedAgents.length === 0) {
    return `No agent config found for filter '${input.agentFilter}'.`;
  }

  const headerLines = [
    "Access policy report",
    `channel=${input.channelId}`,
    `user=${input.userId}`,
    `mentioned=${input.mentioned ? "yes" : "no"}`,
    `route_session=${route?.sessionId ?? "-"}`,
    `route_agent=${route?.agentId ?? "-"}`,
    `route_target=${routedTargetAgent?.id ?? "-"}`
  ];

  const lines = selectedAgents.map((agent) => {
    const policy = resolveAccessPolicy(agent, defaultAccessPolicy);
    const evaluation = evaluateAccess(
      {
        channelId: input.channelId,
        userId: input.userId,
        mentioned: input.mentioned
      },
      policy
    );

    const modeSource = agent.access?.mode !== undefined ? "agent" : "default";
    const channelSource = agent.access?.allowlistChannelIds !== undefined ? "agent" : "default";
    const userSource = agent.access?.allowlistUserIds !== undefined ? "agent" : "default";

    return [
      `agent=${agent.id}`,
      `mode=${policy.mode}`,
      `mode_src=${modeSource}`,
      `channel_src=${channelSource}`,
      `user_src=${userSource}`,
      `channels=${policy.allowlistChannelIds.size}`,
      `users=${policy.allowlistUserIds.size}`,
      `mention_req=${evaluation.mentionRequired ? "yes" : "no"}`,
      `channel_ok=${evaluation.channelAllowed ? "yes" : "no"}`,
      `user_ok=${evaluation.userAllowed ? "yes" : "no"}`,
      `allowed=${evaluation.allowed ? "yes" : "no"}`,
      `reason=${evaluation.reason}`
    ].join(" ");
  });

  const visibleLines: string[] = [];
  for (const line of lines) {
    const candidate = [...headerLines, "```", ...visibleLines, line, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleLines.push(line);
  }

  const truncatedCount = lines.length - visibleLines.length;
  if (truncatedCount > 0) {
    visibleLines.push(`... truncated=${truncatedCount}`);
  }

  return [...headerLines, "```", ...visibleLines, "```"].join("\n");
}

function formatCapabilitiesReport(input: {
  channelId: string;
  userId: string;
  mentioned: boolean;
  agentFilter?: string;
}): string {
  const channelKey = `discord:${input.channelId}`;
  const route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
  const routedTargetAgent = route ? resolveTargetAgent(agentRegistry, route.agentId, null) : null;

  const normalizedFilter = input.agentFilter?.trim().toLowerCase();
  const selectedAgents = normalizedFilter
    ? agentConfigs.filter((agent) => agent.id.toLowerCase() === normalizedFilter)
    : [...agentConfigs];
  selectedAgents.sort((a, b) => a.id.localeCompare(b.id));

  if (selectedAgents.length === 0) {
    return `No agent config found for filter '${input.agentFilter}'.`;
  }

  const headerLines = [
    "Capabilities report",
    `channel=${input.channelId}`,
    `user=${input.userId}`,
    `mentioned=${input.mentioned ? "yes" : "no"}`,
    `route_session=${route?.sessionId ?? "-"}`,
    `route_agent=${route?.agentId ?? "-"}`,
    `route_target=${routedTargetAgent?.id ?? "-"}`
  ];

  const lines = selectedAgents.map((agent) => {
    const policy = resolveAccessPolicy(agent, defaultAccessPolicy);
    const evaluation = evaluateAccess(
      {
        channelId: input.channelId,
        userId: input.userId,
        mentioned: input.mentioned
      },
      policy
    );
    const tools = resolveAgentToolPolicy(agent);
    const providerCandidates = resolveProviderCandidates(agent);
    const resolvedProviders = route
      ? resolveProviderNamesForTurn({
          sessionId: route.sessionId,
          agent
        })
      : {
          providerNames: providerCandidates,
          configuredProviderNames: providerCandidates,
          overrideProviderName: undefined
        };
    const toolsPreview =
      tools.mode === "allowlist"
        ? tools.allowlist.join("|")
        : tools.mode === "default"
          ? "default"
          : "(none)";

    return [
      `agent=${agent.id}`,
      `route_target=${routedTargetAgent?.id === agent.id ? "yes" : "no"}`,
      `provider_default=${agent.provider.default}`,
      `provider_candidates=${providerCandidates.join("|")}`,
      `provider_override=${resolvedProviders.overrideProviderName ?? "-"}`,
      `provider_effective=${resolvedProviders.providerNames.join("|")}`,
      `access_mode=${policy.mode}`,
      `allowed=${evaluation.allowed ? "yes" : "no"}`,
      `access_reason=${evaluation.reason}`,
      `tools_mode=${tools.mode}`,
      `tools_count=${tools.allowlist.length}`,
      `tools=${toolsPreview || "(none)"}`
    ].join(" ");
  });

  const visibleLines: string[] = [];
  for (const line of lines) {
    const candidate = [...headerLines, "```", ...visibleLines, line, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleLines.push(line);
  }

  const truncatedCount = lines.length - visibleLines.length;
  if (truncatedCount > 0) {
    visibleLines.push(`... truncated=${truncatedCount}`);
  }

  return [...headerLines, "```", ...visibleLines, "```"].join("\n");
}

function formatSessionProviderReport(input: {
  sessionId: string;
  agentId: string;
  configuredProviders: string[];
  effectiveProviders: string[];
  overrideProvider?: string;
}): string {
  const supportedProviders = input.effectiveProviders.filter((providerName) => {
    try {
      resolveProviderByName(providerName);
      return true;
    } catch {
      return false;
    }
  });

  return [
    "Session provider override",
    "```",
    `session=${input.sessionId}`,
    `agent=${input.agentId}`,
    `override=${input.overrideProvider ?? "-"}`,
    `configured=${input.configuredProviders.length > 0 ? input.configuredProviders.join("|") : "-"}`,
    `effective=${input.effectiveProviders.length > 0 ? input.effectiveProviders.join("|") : "-"}`,
    `supported=${supportedProviders.length > 0 ? supportedProviders.join("|") : "-"}`,
    "```"
  ].join("\n");
}

function metadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Degraded-mode recovery for v2 Claude turns (TGO-846): classifies the failure
// (timeout / usage-limit / overloaded / auth) and walks the agent's configured
// fallback chain — Codex, then Ollama. See v2-runtime-recovery.ts.
const recoverV2RuntimeFailure = createV2RuntimeFailureRecovery({
  v2Configs,
  v2RuntimeConfigs,
  resolveProvider: (name) => providers.get(name),
  buildConversationKey: buildV2ConversationKey,
  log: (message) => console.warn(message),
});

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function yesNo(value: boolean | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "-";
}

function truncateDiagnosticText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function formatPromptSnapshotSummary(snapshot: {
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
  promptText: string;
  systemPrompt: string | null;
  warmStartPrompt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
}, modelRun: ModelRunRecord | null): string {
  const warmStartContext = asRecord(snapshot.metadata?.warmStartContext);
  const memoryPrompt = asRecord(warmStartContext?.memoryPrompt);
  const memoryTrace = asRecord(memoryPrompt?.trace);
  const traceMemories = asRecordArray(memoryTrace?.memories);
  const traceSummaries = asRecordArray(memoryTrace?.summaries);
  const tracePinnedFacts = asRecordArray(memoryTrace?.pinnedFacts);
  const traceRecentMessages = asRecordArray(memoryTrace?.recentMessages);
  const attemptedRequests = asRecordArray(snapshot.metadata?.attemptedRequests);
  const strategy = metadataString(warmStartContext, "strategy") ?? "none";
  const orchestratorContinuityMode =
    metadataString(snapshot.metadata, "orchestratorContinuityMode") ??
    metadataString(warmStartContext, "orchestratorContinuityMode") ??
    "-";
  const promptPreview = truncateDiagnosticText(snapshot.promptText, 480);
  const memoryLines = traceMemories.slice(0, 3).map((memory) => {
    const score = typeof memory.score === "number" ? memory.score.toFixed(3) : "-";
    const source = typeof memory.source === "string" ? memory.source : "-";
    const content = typeof memory.content === "string" ? truncateDiagnosticText(memory.content, 96) : "";
    return `  - [${source}] score=${score} ${content}`;
  });

  return [
    "Prompt snapshot",
    "```",
    `run=${snapshot.modelRunId}`,
    `session=${snapshot.sessionId}`,
    `agent=${snapshot.agentId}`,
    `provider=${snapshot.providerName}`,
    `model=${modelRun?.model ?? "-"}`,
    `request_message=${snapshot.requestMessageId ?? "-"}`,
    `response_message=${snapshot.responseMessageId ?? "-"}`,
    `created=${snapshot.createdAt}`,
    `expires=${snapshot.expiresAt}`,
    `prompt_chars=${snapshot.promptText.length}`,
    `system_chars=${snapshot.systemPrompt?.length ?? 0}`,
    `warm_start_chars=${snapshot.warmStartPrompt?.length ?? 0}`,
    `continuity_mode=${orchestratorContinuityMode}`,
    `strategy=${strategy}`,
    `turn_warm_start=${yesNo(metadataBoolean(snapshot.metadata, "turnWarmStartUsed"))}`,
    `request_warm_start=${yesNo(metadataBoolean(snapshot.metadata, "requestWarmStartUsed"))}`,
    `worker_synthesis=${yesNo(metadataBoolean(snapshot.metadata, "usedWorkerSynthesis"))}`,
    `attempted_requests=${attemptedRequests.length}`,
    `memory_trace=pinned:${tracePinnedFacts.length} summaries:${traceSummaries.length} memories:${traceMemories.length} recent:${traceRecentMessages.length}`,
    ...(memoryLines.length > 0 ? ["top_memories:", ...memoryLines] : []),
    "prompt_preview:",
    promptPreview,
    "```",
  ].join("\n");
}

function renderPromptSnapshotMarkdown(snapshot: {
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
  promptText: string;
  systemPrompt: string | null;
  warmStartPrompt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
}, modelRun: ModelRunRecord | null): string {
  const warmStartContext = asRecord(snapshot.metadata?.warmStartContext);
  const memoryPrompt = asRecord(warmStartContext?.memoryPrompt);
  const memoryTrace = asRecord(memoryPrompt?.trace);
  const traceMemories = asRecordArray(memoryTrace?.memories);
  const traceSummaries = asRecordArray(memoryTrace?.summaries);
  const tracePinnedFacts = asRecordArray(memoryTrace?.pinnedFacts);
  const traceRecentMessages = asRecordArray(memoryTrace?.recentMessages);
  const contextPacket = asRecord(warmStartContext?.contextPacket);
  const attemptedRequests = asRecordArray(snapshot.metadata?.attemptedRequests);
  const initialRequestPrompt = metadataString(snapshot.metadata, "initialRequestPrompt");
  const orchestratorContinuityMode =
    metadataString(snapshot.metadata, "orchestratorContinuityMode") ??
    metadataString(warmStartContext, "orchestratorContinuityMode") ??
    "-";
  const lines = [
    "# Prompt Snapshot",
    "",
    "## Run",
    `- run_id: ${snapshot.modelRunId}`,
    `- session_id: ${snapshot.sessionId}`,
    `- agent_id: ${snapshot.agentId}`,
    `- provider_name: ${snapshot.providerName}`,
    `- model: ${modelRun?.model ?? "-"}`,
    `- request_message_id: ${snapshot.requestMessageId ?? "-"}`,
    `- response_message_id: ${snapshot.responseMessageId ?? "-"}`,
    `- created_at: ${snapshot.createdAt}`,
    `- expires_at: ${snapshot.expiresAt}`,
    `- orchestrator_continuity_mode: ${orchestratorContinuityMode}`,
    `- turn_warm_start_used: ${yesNo(metadataBoolean(snapshot.metadata, "turnWarmStartUsed"))}`,
    `- request_warm_start_used: ${yesNo(metadataBoolean(snapshot.metadata, "requestWarmStartUsed"))}`,
    `- used_worker_synthesis: ${yesNo(metadataBoolean(snapshot.metadata, "usedWorkerSynthesis"))}`,
    "",
  ];

  if (snapshot.systemPrompt) {
    lines.push("## System Prompt", "", "```text", snapshot.systemPrompt, "```", "");
  }

  if (snapshot.warmStartPrompt) {
    lines.push("## Warm Start Prompt", "", "```text", snapshot.warmStartPrompt, "```", "");
  }

  if (initialRequestPrompt && initialRequestPrompt !== snapshot.promptText) {
    lines.push("## Initial Request Prompt", "", "```text", initialRequestPrompt, "```", "");
  }

  lines.push("## Final Request Prompt", "", "```text", snapshot.promptText, "```", "");

  if (memoryPrompt) {
    lines.push(
      "## Memory Prompt Diagnostics",
      "",
      `- estimated_tokens: ${typeof memoryPrompt.estimatedTokens === "number" ? memoryPrompt.estimatedTokens : "-"}`,
      `- used_full_history: ${yesNo(typeof memoryPrompt.usedFullHistory === "boolean" ? memoryPrompt.usedFullHistory : undefined)}`,
      ""
    );
  } else if (contextPacket) {
    lines.push("## Context Packet Diagnostics", "", "```json", JSON.stringify(contextPacket, null, 2), "```", "");
  }

  if (tracePinnedFacts.length > 0) {
    lines.push("## Pinned Facts", "");
    for (const fact of tracePinnedFacts) {
      const key = typeof fact.key === "string" ? fact.key : "?";
      const value = typeof fact.value === "string" ? fact.value : "";
      const scope = typeof fact.scope === "string" ? fact.scope : "-";
      lines.push(`- [${scope}] ${key}: ${value}`);
    }
    lines.push("");
  }

  if (traceSummaries.length > 0) {
    lines.push("## Summaries", "");
    for (const summary of traceSummaries) {
      const through = typeof summary.coversThroughMessageId === "number" ? summary.coversThroughMessageId : "?";
      const text = typeof summary.summaryText === "string" ? summary.summaryText : "";
      lines.push(`- [through ${through}] ${text}`);
    }
    lines.push("");
  }

  if (traceMemories.length > 0) {
    lines.push("## Retrieved Memories", "");
    for (const memory of traceMemories) {
      const source = typeof memory.source === "string" ? memory.source : "-";
      const score = typeof memory.score === "number" ? memory.score.toFixed(3) : "-";
      const content = typeof memory.content === "string" ? memory.content : "";
      lines.push(`- [${source}] score=${score} ${content}`);
    }
    lines.push("");
  }

  if (traceRecentMessages.length > 0) {
    lines.push("## Recent Messages", "");
    for (const message of traceRecentMessages) {
      const direction = typeof message.direction === "string" ? message.direction : "-";
      const content = typeof message.content === "string" ? message.content : "";
      lines.push(`- [${direction}] ${content}`);
    }
    lines.push("");
  }

  if (attemptedRequests.length > 0) {
    lines.push("## Attempted Requests", "");
    for (const attempt of attemptedRequests) {
      const providerName = typeof attempt.providerName === "string" ? attempt.providerName : "-";
      const providerSessionId =
        typeof attempt.providerSessionId === "string" && attempt.providerSessionId.length > 0
          ? attempt.providerSessionId
          : "-";
      const promptText = typeof attempt.promptText === "string" ? attempt.promptText : "";
      lines.push(
        `### ${providerName}`,
        "",
        `- provider_session_id: ${providerSessionId}`,
        `- warm_start_used: ${yesNo(typeof attempt.warmStartUsed === "boolean" ? attempt.warmStartUsed : undefined)}`,
        "",
        "```text",
        promptText,
        "```",
        ""
      );
    }
  }

  return lines.join("\n").trim();
}

function formatSessionContinuityReport(input: {
  sessionId: string;
  agentId: string;
  conversationKey: string;
  configuredProviders: string[];
  effectiveProviders: string[];
  overrideProvider?: string;
  providerSessions: ProviderSessionRecord[];
  recentRuns: ModelRunRecord[];
  compactSummary?: string;
}): string {
  const providerSessionByName = new Map<string, ProviderSessionRecord>();
  for (const row of input.providerSessions) {
    if (!providerSessionByName.has(row.providerName)) {
      providerSessionByName.set(row.providerName, row);
    }
  }

  const continuityLines = input.effectiveProviders.map((providerName) => {
    const row = providerSessionByName.get(providerName);
    return [
      `provider=${providerName}`,
      `continuity=${row?.providerSessionId ?? "-"}`,
      `updated=${row?.updatedAt ?? "-"}`
    ].join(" ");
  });

  const extraRows = input.providerSessions.filter(
    (row) => !input.effectiveProviders.includes(row.providerName)
  );
  for (const row of extraRows) {
    continuityLines.push(
      [
        `provider=${row.providerName}`,
        `continuity=${row.providerSessionId}`,
        `updated=${row.updatedAt}`,
        "extra=yes"
      ].join(" ")
    );
  }

  if (continuityLines.length === 0) {
    continuityLines.push("provider=- continuity=- updated=-");
  }

  const runLines =
    input.recentRuns.length > 0
      ? input.recentRuns.map((run) => {
          const warmStartUsed = metadataBoolean(run.metadata, "warmStartUsed");
          const warmStartContextChars = metadataNumber(run.metadata, "warmStartContextChars");
          return [
            `run=${run.id}`,
            `provider=${run.providerName}`,
            `error=${run.isError ? "yes" : "no"}`,
            `warm_start=${warmStartUsed === true ? "yes" : warmStartUsed === false ? "no" : "-"}`,
            `context_chars=${warmStartContextChars ?? "-"}`,
            `at=${run.createdAt}`
          ].join(" ");
        })
      : ["(no recent model runs)"];
  const headerLines = [
    "Session continuity",
    `session=${input.sessionId}`,
    `agent=${input.agentId}`,
    `conversation=${input.conversationKey}`,
    `override=${input.overrideProvider ?? "-"}`,
    `configured=${input.configuredProviders.length > 0 ? input.configuredProviders.join("|") : "-"}`,
    `effective=${input.effectiveProviders.length > 0 ? input.effectiveProviders.join("|") : "-"}`,
    `compaction_summary_chars=${input.compactSummary?.length ?? 0}`,
    "continuity:",
    ...continuityLines.map((line) => `  ${line}`),
    "recent_runs:"
  ];

  const visibleRunLines: string[] = [];
  for (const line of runLines) {
    const candidate = ["Session continuity", "```", ...headerLines, ...visibleRunLines, `  ${line}`, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleRunLines.push(`  ${line}`);
  }
  const truncatedRuns = runLines.length - visibleRunLines.length;
  if (truncatedRuns > 0) {
    visibleRunLines.push(`  ... truncated_runs=${truncatedRuns}`);
  }

  return ["Session continuity", "```", ...headerLines, ...visibleRunLines, "```"].join("\n");
}

function canRunAdminCommand(interaction: ChatInputCommandInteraction): boolean {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true
  );
}

function resetOptionsFromMode(mode: "continuity" | "diagnostics" | "hard"): {
  clearHistory: boolean;
  clearDiagnostics: boolean;
} {
  if (mode === "hard") {
    return { clearHistory: true, clearDiagnostics: true };
  }
  if (mode === "diagnostics") {
    return { clearHistory: false, clearDiagnostics: true };
  }
  return { clearHistory: false, clearDiagnostics: false };
}

function hasMentionForBot(message: Message): boolean {
  const botId = client.user?.id;
  if (!botId) return false;
  return message.mentions.users.has(botId);
}

async function writeMessage(input: MessageInsertInput & { discordMessageIds?: string[]; localMessageId?: number }): Promise<number | null> {
  try {
    const { channel, thread, conversationKey: discordKey } = await resolveConversationChannel(
      client.channels, input.discordChannelId, id => Boolean(storage.getThreadSession(id)));
    const mirror = input.discordChannelId ? storage.getDatabase().prepare("SELECT conversation_key FROM conversations WHERE discord_thread_id=? AND conversation_key LIKE 'conv:%'").get(input.discordChannelId) as { conversation_key: string } | undefined : undefined;
    const conversationKey = mirror?.conversation_key ?? discordKey;
    // Internal diagnostics and voice turns with no Discord surface retain their existing history.
    if (!conversationKey || input.visibility === "debug" || input.visibility === "internal") return storage.insertMessage(input);
    const replyId = input.metadata?.replyToDiscordMessageId ?? input.metadata?.discordReplyToMessageId;
    const attachments = Array.isArray(input.metadata?.attachments) ? input.metadata.attachments as PostAttachment[] : undefined;
    return await recordConversationPost(storage, attachmentDataDir, {
      ...input, conversationKey,
      conversationAgentId: [...v2Configs.values()].find(agent => agent.discord?.defaultChannelId ===
        (channel?.isThread() ? channel.parentId : input.discordChannelId))?.id,
      discordParentChannelId: channel?.isThread() ? channel.parentId : thread ? undefined : input.discordChannelId,
      title: channel && "name" in channel ? channel.name ?? "" : "",
      authorKind: input.direction === "inbound" ? (input.metadata?.intakeWebhook && input.metadata?.source !== "desk" ? "requester" : "owner")
        : input.direction === "outbound" ? "agent" : "system",
      origin: input.metadata?.postOrigin === "check-in" ? "check-in" : input.metadata?.postOrigin === "schedule" ? "schedule" : input.metadata?.source === "desk" ? "desk" : input.metadata?.inputSource === "voice-bridge" ? "voice"
        : input.metadata?.scheduledDelivery ? "schedule" : "discord",
      replyToMessageId: typeof replyId === "string" ? storage.findConversationPostByDiscordId(replyId) : null,
      attachments,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write message", message);
    return null;
  }
}

function isWatsonInterstitialCaptureAgent(agentId: string): boolean {
  return agentId === "watson" || agentId === "watson-ollama";
}

async function maybeHandleWatsonInterstitialStatusCapture(input: {
  message: Message;
  promptText: string;
  targetAgent: AgentConfig;
  promptRoute: ReturnType<typeof resolvePromptTextRoute>;
  inboundMessageId: number | null;
}): Promise<boolean> {
  if (!isWatsonInterstitialCaptureAgent(input.targetAgent.id)) {
    return false;
  }

  const config = resolveOrientationNudgeConfig();
  const capture = parseInterstitialStatusCapture({
    message: input.promptText,
    messageTimestamp: input.message.createdAt,
    timeZone: config.timeZone,
    hasAttachments: input.message.attachments.size > 0,
  });
  if (!capture) {
    return false;
  }

  try {
    const appendResult = appendInterstitialLogEntry(
      config.vaultRoot,
      capture.timestamp,
      config.timeZone,
      capture.task,
    );
    const store = new OrientationNudgeStore(storage.getDatabase());
    store.recordInterstitialActivity(config.userId, capture.timestamp, capture.task);

    const replyText = "Captured.";
    const replyDelivery = await sendPresentedReply(input.message.channel, replyText, input.targetAgent);
    ensureReplyDeliverySucceeded(replyDelivery, input.message.channelId);
    await writeMessage({
      sessionId: input.promptRoute.sessionId,
      agentId: input.targetAgent.id,
      providerName: "interstitial-log-capture",
      direction: "outbound",
      source: "tango",
      visibility: "public",
      discordMessageIds: replyDelivery.messageIds,
      discordMessageId: replyDelivery.lastMessageId ?? null,
      discordChannelId: input.message.channelId,
      discordUserId: replyDelivery.delivery === "bot" ? client.user?.id ?? null : null,
      discordUsername: replyDelivery.actualDisplayName,
      content: replyText,
      metadata: {
        replyToDiscordMessageId: input.message.id,
        sentChunks: replyDelivery.sentChunks,
        senderIdentity: {
          intendedDisplayName: replyDelivery.intendedDisplayName,
          actualDisplayName: replyDelivery.actualDisplayName,
          delivery: replyDelivery.delivery,
        },
        runtimePath: "interstitial-log-capture",
        requestMessageId: input.inboundMessageId,
        task: capture.task,
        timestampUtc: capture.timestamp.toISOString(),
        timestampSource: capture.timestampSource,
        localDate: capture.localDate,
        localTime: capture.localTime,
        notePath: appendResult.notePath,
        noteLine: appendResult.line,
      },
    });
    console.log(
      `[interstitial-log-capture] captured agent=${input.targetAgent.id} channel=${input.message.channelId} timestamp=${capture.timestamp.toISOString()} source=${capture.timestampSource}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[interstitial-log-capture] failed to capture status update: ${message}`);
    const replyText = "I couldn't write that to the Interstitial Log.";
    const replyDelivery = await sendPresentedReply(input.message.channel, replyText, input.targetAgent);
    ensureReplyDeliverySucceeded(replyDelivery, input.message.channelId);
    await writeMessage({
      sessionId: input.promptRoute.sessionId,
      agentId: input.targetAgent.id,
      providerName: "interstitial-log-capture",
      direction: "error",
      source: "tango",
      visibility: "public",
      discordMessageIds: replyDelivery.messageIds,
      discordMessageId: replyDelivery.lastMessageId ?? null,
      discordChannelId: input.message.channelId,
      discordUserId: replyDelivery.delivery === "bot" ? client.user?.id ?? null : null,
      discordUsername: replyDelivery.actualDisplayName,
      content: replyText,
      metadata: {
        replyToDiscordMessageId: input.message.id,
        requestMessageId: input.inboundMessageId,
        runtimePath: "interstitial-log-capture",
        error: message,
      },
    });
    return true;
  }
}

function isSmokeTestChannelId(channelId: string | null | undefined): boolean {
  const normalized = channelId?.trim();
  return normalized ? smokeTestChannelIds.has(normalized) : false;
}

function writeModelRun(input: ModelRunInsertInput): number | null {
  try {
    return storage.insertModelRun(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write model run", message);
    return null;
  }
}

function writePromptSnapshot(input: PromptSnapshotInsertInput): number | null {
  try {
    return storage.insertPromptSnapshot(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write prompt snapshot", message);
    return null;
  }
}

function writeDeadLetter(input: DeadLetterInsertInput): number | null {
  try {
    return storage.insertDeadLetter(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write dead letter", message);
    return null;
  }
}

function recordUnhandledDiscordTurnFailure(message: Message, errorText: string): number | null {
  const storedMessage = storage.getMessageByDiscordMessageId(message.id, {
    channelId: message.channelId,
  });
  if (
    !storedMessage
    || storedMessage.source !== "discord"
    || storedMessage.direction !== "inbound"
    || storedMessage.visibility !== "public"
    || !storedMessage.agentId
  ) {
    return null;
  }

  const routingChannelId = resolveRoutingChannelId(message);
  const threadId = message.channelId !== routingChannelId ? message.channelId : undefined;
  const conversationKey = threadId ? `thread:${threadId}` : `channel:${routingChannelId}`;
  const providerName =
    storedMessage.providerName
    ?? agentRegistry.get(storedMessage.agentId)?.provider.default
    ?? "unknown";

  return writeDeadLetter({
    sessionId: storedMessage.sessionId,
    agentId: storedMessage.agentId,
    providerName,
    conversationKey,
    requestMessageId: storedMessage.id,
    discordChannelId: storedMessage.discordChannelId ?? message.channelId,
    discordUserId: storedMessage.discordUserId ?? message.author.id,
    discordUsername: storedMessage.discordUsername ?? message.author.username,
    promptText: storedMessage.content,
    lastErrorMessage: errorText,
    metadata: {
      recoverySource: "unhandled-discord-turn-failure",
      originalCreatedAt: storedMessage.createdAt,
      discordMessageId: message.id,
    },
  });
}

function upsertSessionForRoute(
  route: { sessionId: string; agentId: string },
  fallbackChannel = "discord:default"
): void {
  const sessionConfig: SessionConfig =
    sessionConfigById.get(route.sessionId) ?? {
      id: route.sessionId,
      type: route.sessionId.startsWith("project:") ? "project" : "persistent",
      agent: route.agentId,
      channels: [fallbackChannel]
    };

  try {
    storage.upsertSession(sessionConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to upsert session", message);
  }
}

function providerContinuityKey(conversationKey: string, providerName: string): string {
  return `${conversationKey}::${providerName}`;
}

function loadPersistedProviderSession(
  conversationKey: string,
  providerName: string
): string | undefined {
  const normalizedProviderName = providerName.trim();
  const cacheKey = providerContinuityKey(conversationKey, normalizedProviderName);
  const cached = providerSessionByConversation.get(cacheKey);
  if (cached) return cached;

  try {
    const providerSession = storage.getProviderSession(conversationKey, normalizedProviderName);
    if (!providerSession) return undefined;
    providerSessionByConversation.set(cacheKey, providerSession.providerSessionId);
    return providerSession.providerSessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to load provider session", message);
    return undefined;
  }
}

function loadProviderContinuityMap(
  conversationKey: string,
  providerNames: string[]
): ProviderContinuityMap {
  const continuity: ProviderContinuityMap = {};
  for (const providerName of providerNames) {
    const providerSessionId = loadPersistedProviderSession(conversationKey, providerName);
    if (providerSessionId) {
      continuity[providerName] = providerSessionId;
    }
  }
  return continuity;
}

function clearProviderContinuityCacheForSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of providerSessionByConversation.keys()) {
    if (key.startsWith(prefix)) {
      providerSessionByConversation.delete(key);
    }
  }
}

function savePersistedProviderSession(input: {
  conversationKey: string;
  sessionId: string;
  agentId: string;
  providerName: string;
  providerSessionId: string;
}): void {
  const cacheKey = providerContinuityKey(input.conversationKey, input.providerName);
  providerSessionByConversation.set(cacheKey, input.providerSessionId);
  try {
    storage.upsertProviderSession(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to save provider session", message);
  }
}

async function buildWarmStartContext(input: {
  conversationKey?: string;
  scheduledReview?: boolean;
  scheduledAgentIds?: string[];
  sessionId: string;
  agentId: string;
  currentUserPrompt?: string;
  excludeMessageIds?: number[];
  orchestratorContinuityMode?: OrchestratorContinuityMode;
  discordChannelId?: string | null;
  discordThreadId?: string | null;
}): Promise<WarmStartContextResult> {
  try {
    const memoryScope = input.scheduledReview && input.scheduledAgentIds
      ? { canonicalAgentId: input.agentId, aliasAgentIds: input.scheduledAgentIds }
      : resolveV2MemoryScope(input.agentId, v2Configs.get(input.agentId));
    const allMessages = storage.listMessagesForSession(input.sessionId, 5000);
    // Messages persist with discord_channel_id = the surface they arrived on
    // (the thread id for thread/forum-post messages), while discordChannelId
    // here is the routing id (the parent channel for threads). Select recent
    // surface messages by the thread id when present, or session messages get
    // filtered out and the supplement reads the wrong surface (TGO-688).
    const messageSurfaceChannelId =
      input.discordThreadId?.trim() || input.discordChannelId?.trim() || null;
    const recentChannelMessages =
      messageSurfaceChannelId
        ? storage.listRecentMessagesForDiscordChannel(messageSurfaceChannelId, 80)
        : [];
    const {
      messages,
      supplementalMessageCount,
    } = selectWarmStartMessages({
      sessionMessages: allMessages,
      recentChannelMessages,
      channelId: messageSurfaceChannelId,
      agentId: input.agentId,
      ...(input.scheduledReview ? {
        scheduledAgentIds: memoryScope.aliasAgentIds,
      } : {}),
    });
    const attachmentContext = buildAttachmentDirectoryContext({
      store: attachmentStore,
      conversationKey: input.conversationKey ?? (input.discordThreadId
        ? `thread:${input.discordThreadId}`
        : input.discordChannelId
          ? `channel:${input.discordChannelId}`
          : undefined),
      discordChannelId: input.discordChannelId,
      agentId: input.agentId,
      currentUserPrompt: input.currentUserPrompt,
      recentMessages: messages,
    });
    const attachmentPrompt = attachmentContext.prompt.trim();
    const attachmentDirectoryContext = {
      trace: attachmentContext.trace,
      promptChars: attachmentPrompt.length,
    };
    // Continuation: surface this session's open active tasks so the turn can
    // resume work captured by the post-turn extractor (TGO-743).
    let activeTasksBlock: string | undefined;
    let activeTasksOpenCount = 0;
    try {
      const taskAgentIds = input.scheduledReview
        ? memoryScope.aliasAgentIds
        : [input.agentId];
      const sessionTasks = taskAgentIds.flatMap((agentId) => storage.listActiveTasks({
        sessionId: input.sessionId,
        agentId,
        ...(input.scheduledReview && messageSurfaceChannelId
          ? { sourceChannelId: messageSurfaceChannelId }
          : {}),
      }));
      const openActiveTasks = input.scheduledReview
        ? selectScheduledActiveTasks(sessionTasks, messageSurfaceChannelId, (id) => storage.getMessage(id))
        : sessionTasks;
      activeTasksOpenCount = openActiveTasks.length;
      activeTasksBlock = renderActiveTasksWarmStartBlock(openActiveTasks);
    } catch (error) {
      console.warn(
        `[active-task] warm-start task lookup failed session=${input.sessionId} agent=${input.agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const activeTasksDiagnostics = {
      openCount: activeTasksOpenCount,
      promptChars: activeTasksBlock?.length ?? 0,
    };
    const sessionConfig = resolveEffectiveSessionConfig(input.sessionId);
    const memoryConfig = resolveSessionMemoryConfig(sessionConfig?.memory);
    const orchestratorContinuityMode = input.orchestratorContinuityMode ?? "provider";
    // Store consolidation: distilled memory (memories/pinned/summaries) reads
    // the Atlas substrate — where extraction, reflections, and the obsidian
    // mirror all write — with per-call fallback to the legacy core tables.
    // TANGO_WARM_START_MEMORY_SOURCE=core flips back without a deploy.
    const memoryQuery = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      memoryAgentId: memoryScope.canonicalAgentId,
      memoryAgentIds: memoryScope.aliasAgentIds,
      conversationKey: input.conversationKey ?? (input.discordThreadId
        ? `thread:${input.discordThreadId}`
        : input.discordChannelId
          ? `channel:${input.discordChannelId}`
          : null),
      memoryPoolLimit: Math.max(memoryConfig.memoryLimit * 25, 5000),
      isolated: v2Configs.get(input.agentId)?.isolated === true,
    };
    let memoryBundle: WarmStartMemoryBundle;
    if (warmStartMemorySubstrate === "atlas") {
      try {
        memoryBundle = loadAtlasWarmStartMemory(atlasMemoryClient, memoryQuery);
      } catch (error) {
        console.warn(
          `[tango-memory] atlas warm-start source failed; falling back to core: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        memoryBundle = loadCoreWarmStartMemory(storage, memoryQuery);
      }
    } else {
      memoryBundle = loadCoreWarmStartMemory(storage, memoryQuery);
    }
    const memories = memoryBundle.memories;
    const queryEmbedding =
      input.currentUserPrompt && memories.some(memoryHasEmbedding)
        ? await maybeEmbedText(input.currentUserPrompt, "query", "warm-start query")
        : null;
    const memoryPrompt = assembleSessionMemoryPrompt({
      messageAgentIds: input.scheduledReview ? memoryScope.aliasAgentIds : undefined,
      sessionId: input.sessionId,
      agentId: input.agentId,
      memoryAgentId: memoryScope.aliasAgentIds.length === 1 ? memoryScope.canonicalAgentId : null,
      currentUserPrompt: input.currentUserPrompt,
      queryEmbedding,
      allowFullHistoryBypass: orchestratorContinuityMode !== "stateless",
      memoryConfig,
      messages,
      // Legacy summaries and session pins carry no surface provenance. Scheduled
      // reviews must not borrow another channel's context during Atlas fallback.
      summaries: input.scheduledReview && memoryBundle.substrate === "core" ? [] : memoryBundle.summaries,
      memories,
      pinnedFacts: input.scheduledReview && memoryBundle.substrate === "core"
        ? memoryBundle.pinnedFacts.filter((fact) => fact.scope !== "session")
        : memoryBundle.pinnedFacts,
      excludeMessageIds: input.excludeMessageIds,
    });

    if (memoryPrompt.accessedMemoryIds.length > 0) {
      try {
        memoryBundle.touch(memoryPrompt.accessedMemoryIds);
      } catch (error) {
        console.warn(
          `[tango-memory] memory access touch failed (${memoryBundle.substrate}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const memoryPromptText = memoryPrompt.prompt.trim();
    const prompt = joinContextPrompts(memoryPromptText, activeTasksBlock, attachmentPrompt);
    if (memoryPromptText.length > 0) {
      return {
        prompt,
        diagnostics: {
          strategy: "session-memory-prompt",
          orchestratorContinuityMode,
          memorySubstrate: memoryBundle.substrate,
          channelSurfaceSupplementalMessages: supplementalMessageCount,
          attachmentDirectoryContext,
          activeTasks: activeTasksDiagnostics,
          memoryPrompt: {
            estimatedTokens: memoryPrompt.estimatedTokens,
            usedFullHistory: memoryPrompt.usedFullHistory,
            trace: memoryPrompt.trace,
          },
        },
      };
    }

    if (input.scheduledReview) {
      // Session-level tool outcomes/compactions do not carry channel provenance.
      return { prompt, diagnostics: { strategy: "none", orchestratorContinuityMode, activeTasks: activeTasksDiagnostics } };
    }

    const modelRuns = storage.listModelRunsForSession(input.sessionId, 5000);
    const compaction = storage.getSessionCompaction(input.sessionId, input.agentId);
    const packet = buildContextPacket({
      sessionId: input.sessionId,
      agentId: input.agentId,
      messages,
      modelRuns,
      compactSummary: compaction?.summaryText,
      excludeMessageIds: input.excludeMessageIds,
      maxTurns: compaction ? 6 : 8,
      maxToolOutcomes: 3,
      maxContentCharsPerTurn: 280
    });
    const fallbackPromptText = renderContextPacket(packet, { maxChars: 2400 }).trim();
    const fallbackPrompt = joinContextPrompts(fallbackPromptText, activeTasksBlock, attachmentPrompt);
    return fallbackPrompt.length > 0
        ? {
            prompt: fallbackPrompt,
            diagnostics: {
              strategy: fallbackPromptText.length > 0 ? "context-packet" : "attachment-directory-context",
              orchestratorContinuityMode,
              channelSurfaceSupplementalMessages: supplementalMessageCount,
              attachmentDirectoryContext,
              activeTasks: activeTasksDiagnostics,
              contextPacket: packet,
            },
          }
        : {
            diagnostics: {
              strategy: "none",
              orchestratorContinuityMode,
              channelSurfaceSupplementalMessages: supplementalMessageCount,
              attachmentDirectoryContext,
              activeTasks: activeTasksDiagnostics,
            },
          };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-discord] failed to build warm-start context packet", message);
    return {
      diagnostics: {
        strategy: "none",
        orchestratorContinuityMode: input.orchestratorContinuityMode ?? "provider",
        error: message,
      },
    };
  }
}

async function buildWarmStartContextPrompt(input: {
  sessionId: string;
  agentId: string;
  currentUserPrompt?: string;
  excludeMessageIds?: number[];
  orchestratorContinuityMode?: OrchestratorContinuityMode;
  discordChannelId?: string | null;
  discordThreadId?: string | null;
}): Promise<string | undefined> {
  const result = await buildWarmStartContext(input);
  return result.prompt;
}

function joinContextPrompts(...prompts: Array<string | undefined>): string {
  return prompts
    .map((prompt) => prompt?.trim() ?? "")
    .filter((prompt) => prompt.length > 0)
    .join("\n\n");
}

async function maybeEmbedText(
  text: string,
  inputType: "query" | "document",
  context: string,
): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  const normalized = text.trim();
  if (normalized.length === 0) return null;

  try {
    const [embedding] = await provider.embed([normalized], inputType);
    return embedding && embedding.length > 0 ? embedding : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tango-memory] failed to embed ${context}: ${message}`);
    return null;
  }
}

function embedMemoryInBackground(input: { memoryId: number; content: string }): void {
  const provider = getEmbeddingProvider();
  if (!provider) return;

  void maybeEmbedText(input.content, "document", `memory ${input.memoryId}`).then((embedding) => {
    if (!embedding) return;

    try {
      storage.updateMemoryEmbedding({
        memoryId: input.memoryId,
        embeddingJson: serializeEmbedding(embedding),
        embeddingModel: provider.model,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tango-memory] failed to persist embedding for memory ${input.memoryId}: ${message}`);
    }
  });
}

function maybeCompactSessionMemory(input: { sessionId: string; agentId: string }): void {
  try {
    maybePersistConversationMemory(input);

    const messages = storage.listMessagesForSession(input.sessionId, 5000);
    const plan = planSessionCompaction({
      sessionId: input.sessionId,
      agentId: input.agentId,
      messages,
      triggerTurns: memoryCompactionTriggerTurns,
      retainRecentTurns: memoryCompactionRetainRecentTurns,
      maxSummaryTurns: 16,
      maxTurnChars: 180,
      maxSummaryChars: memoryCompactionSummaryMaxChars
    });

    if (!plan.shouldCompact || !plan.summaryText) return;

    const existing = storage.getSessionCompaction(input.sessionId, input.agentId);
    if (
      existing &&
      existing.summaryText === plan.summaryText &&
      existing.compactedTurns === plan.compactedTurns
    ) {
      return;
    }

    storage.upsertSessionCompaction({
      sessionId: input.sessionId,
      agentId: input.agentId,
      summaryText: plan.summaryText,
      compactedTurns: plan.compactedTurns
    });
    console.log(
      `[tango-discord] memory compacted session=${input.sessionId} agent=${input.agentId} compacted_turns=${plan.compactedTurns} total_turns=${plan.totalTurns}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-discord] failed to compact session memory", message);
  }
}

function maybePersistConversationMemory(input: { sessionId: string; agentId: string }): void {
  const sessionConfig = resolveEffectiveSessionConfig(input.sessionId);
  const memoryConfig = resolveSessionMemoryConfig(sessionConfig?.memory);
  const messages = storage
    .listMessagesForSession(input.sessionId, 5000)
    .filter((message) => message.agentId === input.agentId)
    .filter((message) => message.direction === "inbound" || message.direction === "outbound");

  const latestSummary = storage.getLatestSessionMemorySummary(input.sessionId, input.agentId);
  const lastCoveredMessageId = latestSummary?.coversThroughMessageId ?? 0;
  const pendingMessages = messages.filter((message) => message.id > lastCoveredMessageId);

  if (pendingMessages.length < memoryConfig.summarizeWindow) {
    return;
  }

  const batch = pendingMessages.slice(0, memoryConfig.summarizeWindow);
  const coversThroughMessageId = batch.at(-1)?.id;
  if (!coversThroughMessageId) return;

  const summaryText = buildDeterministicConversationSummary(batch);
  if (summaryText.trim().length > 0) {
    storage.upsertSessionMemorySummary({
      sessionId: input.sessionId,
      agentId: input.agentId,
      summaryText,
      tokenCount: estimateTokenCount(summaryText),
      coversThroughMessageId,
    });
  }

  const memoryText = buildDeterministicConversationMemory(batch);
  const importance = estimateConversationImportance(batch);
  if (memoryText.trim().length > 0 && importance >= memoryConfig.importanceThreshold) {
    const memoryId = storage.insertMemory({
      sessionId: input.sessionId,
      agentId: input.agentId,
      source: "conversation",
      content: memoryText,
      importance,
      sourceRef: `message:${batch[0]?.id ?? "?"}-${coversThroughMessageId}`,
      metadata: {
        messageIds: batch.map((message) => message.id),
        keywords: extractMemoryKeywords(memoryText),
        summaryText,
      }
    });
    embedMemoryInBackground({ memoryId, content: memoryText });

    const sessionMemories = storage.listMemories({
      sessionId: input.sessionId,
      agentId: input.agentId,
      source: "conversation",
      limit: Math.max(memoryConfig.memoryLimit * 4, memoryConfig.memoryLimit + 20),
    });
    const archiveIds = selectMemoriesToArchive(sessionMemories, memoryConfig.memoryLimit);
    for (const memoryId of archiveIds) {
      storage.archiveMemory(memoryId);
    }
  }
}

function attachmentsForMetadata(message: Message): Array<Record<string, unknown>> {
  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size
  }));
}

function tangoCommandPayload(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("tango")
    .setDescription("Tango operational commands")
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Show Tango status"))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("deadletters")
        .setDescription("List dead-letter entries")
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Entry status filter")
            .setRequired(false)
            .addChoices(
              { name: "pending", value: "pending" },
              { name: "resolved", value: "resolved" },
              { name: "all", value: "all" }
            )
        )
        .addStringOption((option) =>
          option.setName("session").setDescription("Filter by session ID").setRequired(false)
        )
        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription("Maximum entries (1-25)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(25)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("access")
        .setDescription("Show effective access policy for agents in this channel")
        .addStringOption((option) =>
          option
            .setName("agent")
            .setDescription("Optional agent ID filter")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("user")
            .setDescription("Discord user ID to evaluate (defaults to invoking user)")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("mentioned")
            .setDescription("Evaluate as if bot was mentioned")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("capabilities")
        .setDescription("Show effective access + tool capabilities for agents in this channel")
        .addStringOption((option) =>
          option
            .setName("agent")
            .setDescription("Optional agent ID filter")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("user")
            .setDescription("Discord user ID to evaluate access against (defaults to invoking user)")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("mentioned")
            .setDescription("Evaluate access as if bot was mentioned")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("new")
        .setDescription("Start a fresh session in this channel (clears provider continuity)")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stop")
        .setDescription("Stop the active generation in this channel")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("save")
        .setDescription("Request a save pass on the next message in this channel")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("context")
        .setDescription("Show context usage for this conversation")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("replay")
        .setDescription("Replay a dead-letter entry")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("Dead-letter ID").setRequired(true).setMinValue(1)
        )
        .addBooleanOption((option) =>
          option
            .setName("force")
            .setDescription("Replay even if the entry is already resolved")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("post")
            .setDescription("Post the replayed response in this channel")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("trigger")
        .setDescription("Manually trigger a scheduled job")
        .addStringOption((option) =>
          option.setName("schedule").setDescription("Schedule ID to trigger").setRequired(true)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("session")
        .setDescription("Session operations")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("reset")
            .setDescription("Reset session continuity and/or diagnostics")
            .addStringOption((option) =>
              option.setName("id").setDescription("Session ID").setRequired(true)
            )
            .addBooleanOption((option) =>
              option
                .setName("confirm")
                .setDescription("Set true to confirm reset")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("mode")
                .setDescription("Reset mode")
                .setRequired(false)
                .addChoices(
                  { name: "continuity", value: "continuity" },
                  { name: "diagnostics", value: "diagnostics" },
                  { name: "hard", value: "hard" }
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("provider")
            .setDescription("Show or set session-level provider override")
            .addStringOption((option) =>
              option.setName("id").setDescription("Session ID").setRequired(true)
            )
            .addStringOption((option) =>
              option.setName("agent").setDescription("Agent ID").setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("provider")
                .setDescription("Provider name to set as override")
                .setRequired(false)
            )
            .addBooleanOption((option) =>
              option
                .setName("clear")
                .setDescription("Clear existing override")
                .setRequired(false)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("continuity")
            .setDescription("Show provider continuity and warm-start diagnostics")
            .addStringOption((option) =>
              option.setName("id").setDescription("Session ID").setRequired(true)
            )
            .addStringOption((option) =>
              option.setName("agent").setDescription("Agent ID").setRequired(true)
            )
            .addIntegerOption((option) =>
              option
                .setName("runs")
                .setDescription("Recent model runs to include (1-20)")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("snapshot")
            .setDescription("Inspect a stored prompt snapshot by run or message id")
            .addIntegerOption((option) =>
              option
                .setName("run")
                .setDescription("Model run ID")
                .setRequired(false)
                .setMinValue(1)
            )
            .addIntegerOption((option) =>
              option
                .setName("request_message")
                .setDescription("Inbound request message ID")
                .setRequired(false)
                .setMinValue(1)
            )
            .addIntegerOption((option) =>
              option
                .setName("response_message")
                .setDescription("Outbound response message ID")
                .setRequired(false)
                .setMinValue(1)
            )
            .addBooleanOption((option) =>
              option
                .setName("full")
                .setDescription("Attach the full snapshot as markdown")
                .setRequired(false)
            )
        )
    )
    .toJSON();
}

async function registerSlashCommands(): Promise<void> {
  if (!client.application) {
    return;
  }

  const commands = [tangoCommandPayload()];
  if (commandGuildId) {
    await client.application.commands.set(commands, commandGuildId);
    console.log(`[tango-discord] registered slash commands in guild=${commandGuildId}`);
    return;
  }

  await client.application.commands.set(commands);
  console.log("[tango-discord] registered global slash commands");
}

async function handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: formatHealthStatus(),
    ephemeral: true
  });
}

async function handleDeadLettersCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const status = (interaction.options.getString("status") ?? "pending") as
    | "pending"
    | "resolved"
    | "all";
  const sessionId = interaction.options.getString("session") ?? undefined;
  const limit = interaction.options.getInteger("limit") ?? 10;

  await interaction.reply({
    content: formatDeadLettersList({ status, sessionId, limit }),
    ephemeral: true
  });
}

async function handleAccessCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentFilter = interaction.options.getString("agent") ?? undefined;
  const userId = interaction.options.getString("user")?.trim() || interaction.user.id;
  const mentioned = interaction.options.getBoolean("mentioned") === true;

  await interaction.reply({
    content: formatAccessPolicyReport({
      channelId: interaction.channelId,
      userId,
      mentioned,
      agentFilter
    }),
    ephemeral: true
  });
}

async function handleCapabilitiesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentFilter = interaction.options.getString("agent") ?? undefined;
  const userId = interaction.options.getString("user")?.trim() || interaction.user.id;
  const mentioned = interaction.options.getBoolean("mentioned") === true;

  await interaction.reply({
    content: formatCapabilitiesReport({
      channelId: interaction.channelId,
      userId,
      mentioned,
      agentFilter
    }),
    ephemeral: true
  });
}

async function handleSessionProviderCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessionId = interaction.options.getString("id", true).trim();
  const agentId = interaction.options.getString("agent", true).trim();
  const clearOverride = interaction.options.getBoolean("clear") === true;
  const providerOverride = interaction.options.getString("provider")?.trim();

  const summary = storage.getSessionSummary(sessionId);
  if (!summary) {
    await interaction.reply({
      content: `Session '${sessionId}' not found in persistence store.`,
      ephemeral: true
    });
    return;
  }

  const agent = agentRegistry.get(agentId);
  if (!agent) {
    await interaction.reply({
      content: `Agent '${agentId}' not found in config.`,
      ephemeral: true
    });
    return;
  }

  let result;
  try {
    result = applySessionProviderCommand({
      sessionId,
      agent,
      clearOverride,
      providerOverride,
      isSupportedProvider: (providerName) => {
        try {
          resolveProviderByName(providerName);
          return true;
        } catch {
          return false;
        }
      },
      store: {
        getOverride: (targetSessionId, targetAgentId) =>
          storage.getSessionProviderOverride(targetSessionId, targetAgentId)?.providerName,
        setOverride: (input) => {
          storage.upsertSessionProviderOverride(input);
        },
        clearOverride: (targetSessionId, targetAgentId) =>
          storage.clearSessionProviderOverride(targetSessionId, targetAgentId)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.reply({
      content: message,
      ephemeral: true
    });
    return;
  }

  const report = formatSessionProviderReport({
    sessionId: result.sessionId,
    agentId: result.agentId,
    configuredProviders: result.configuredProviders,
    effectiveProviders: result.effectiveProviders,
    overrideProvider: result.overrideProviderName
  });

  if (result.status === "set") {
    await interaction.reply({
      content: [`Set session provider override to '${result.overrideProviderName}'.`, report].join("\n"),
      ephemeral: true
    });
    return;
  }

  if (result.status === "cleared" || result.status === "no-override") {
    await interaction.reply({
      content: [
        result.status === "cleared"
          ? "Cleared session provider override."
          : "No session provider override was set.",
        report
      ].join("\n"),
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: report,
    ephemeral: true
  });
}

async function handleSessionContinuityCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sessionId = interaction.options.getString("id", true).trim();
  const agentId = interaction.options.getString("agent", true).trim();
  const runLimit = interaction.options.getInteger("runs") ?? 8;

  const summary = storage.getSessionSummary(sessionId);
  if (!summary) {
    await interaction.reply({
      content: `Session '${sessionId}' not found in persistence store.`,
      ephemeral: true
    });
    return;
  }

  const agent = agentRegistry.get(agentId);
  if (!agent) {
    await interaction.reply({
      content: `Agent '${agentId}' not found in config.`,
      ephemeral: true
    });
    return;
  }

  const providerSelection = resolveProviderNamesForTurn({
    sessionId,
    agent
  });
  const conversationKey = getConversationKey(sessionId, agent.id);
  const providerSessions = storage.listProviderSessionsForConversation(conversationKey, 40);
  const recentRuns = storage.listModelRunsForConversation(
    conversationKey,
    Number.isFinite(runLimit) ? Math.max(runLimit, 1) : 8
  );
  const compaction = storage.getSessionCompaction(sessionId, agent.id);

  await interaction.reply({
    content: formatSessionContinuityReport({
      sessionId,
      agentId: agent.id,
      conversationKey,
      configuredProviders: providerSelection.configuredProviderNames,
      effectiveProviders: providerSelection.providerNames,
      overrideProvider: providerSelection.overrideProviderName,
      providerSessions,
      recentRuns,
      compactSummary: compaction?.summaryText
    }),
    ephemeral: true
  });
}

async function handleSessionSnapshotCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const runId = interaction.options.getInteger("run");
  const requestMessageId = interaction.options.getInteger("request_message");
  const responseMessageId = interaction.options.getInteger("response_message");
  const full = interaction.options.getBoolean("full") === true;
  const providedLookups = [runId, requestMessageId, responseMessageId].filter((value) => value !== null);

  if (providedLookups.length !== 1) {
    await interaction.reply({
      content: "Provide exactly one of `run`, `request_message`, or `response_message`.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const snapshot =
    runId !== null
      ? storage.getPromptSnapshotByModelRunId(runId)
      : requestMessageId !== null
        ? storage.findPromptSnapshotByRequestMessageId(requestMessageId)
        : storage.findPromptSnapshotByResponseMessageId(responseMessageId as number);

  if (!snapshot) {
    const lookupLabel =
      runId !== null
        ? `run '${runId}'`
        : requestMessageId !== null
          ? `request message '${requestMessageId}'`
          : `response message '${responseMessageId}'`;
    await interaction.editReply(`Prompt snapshot for ${lookupLabel} was not found or has expired.`);
    return;
  }

  const modelRun = storage.getModelRun(snapshot.modelRunId);
  const summary = formatPromptSnapshotSummary(snapshot, modelRun);

  if (!full) {
    await interaction.editReply(summary);
    return;
  }

  const markdown = renderPromptSnapshotMarkdown(snapshot, modelRun);
  const attachment = new AttachmentBuilder(Buffer.from(markdown, "utf8"), {
    name: `prompt-snapshot-run-${snapshot.modelRunId}.md`,
  });

  await interaction.editReply({
    content: summary,
    files: [attachment]
  });
}

async function handleReplayCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const deadLetterId = interaction.options.getInteger("id", true);
  const forceReplay = interaction.options.getBoolean("force") === true;
  const postToChannel = interaction.options.getBoolean("post") === true;

  await interaction.deferReply({ ephemeral: true });

  const deadLetter = storage.getDeadLetter(deadLetterId);
  if (!deadLetter) {
    await interaction.editReply(`Dead-letter entry '${deadLetterId}' not found.`);
    return;
  }

  if (deadLetter.status === "resolved" && !forceReplay) {
    await interaction.editReply(
      `Dead-letter entry '${deadLetterId}' is already resolved. Set \`force=true\` to replay again.`
    );
    return;
  }

  const configuredAgent = agentRegistry.get(deadLetter.agentId);
  const providerTools = resolveProviderToolsForAgent(configuredAgent);
  const providerSelection = configuredAgent
    ? resolveProviderNamesForTurn({
        sessionId: deadLetter.sessionId,
        agent: configuredAgent
      })
    : undefined;
  const configuredProviderNames = providerSelection?.providerNames ?? [];
  const replayProviderNames = [
    deadLetter.providerName,
    ...configuredProviderNames.filter((name) => name !== deadLetter.providerName)
  ];

  let providerChain: Array<{ providerName: string; provider: ChatProvider }>;
  try {
    providerChain = resolveProviderChain(replayProviderNames);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await interaction.editReply(messageText);
    return;
  }

  const continuityByProvider = loadProviderContinuityMap(deadLetter.conversationKey, replayProviderNames);
  if (deadLetter.providerSessionId && deadLetter.providerSessionId.length > 0) {
    continuityByProvider[deadLetter.providerName] = deadLetter.providerSessionId;
  }
  const warmStartContext = await buildWarmStartContext({
    sessionId: deadLetter.sessionId,
    agentId: deadLetter.agentId,
    currentUserPrompt: deadLetter.promptText,
    excludeMessageIds: deadLetter.requestMessageId !== null ? [deadLetter.requestMessageId] : undefined,
    orchestratorContinuityMode: resolveOrchestratorContinuityModeForAgent(
      deadLetter.agentId,
      deadLetter.sessionId,
    ),
    discordChannelId: deadLetter.discordChannelId,
  });
  const warmStartPrompt = warmStartContext.prompt;
  const warmStartContextChars = warmStartPrompt?.length ?? 0;
  const deadLetterV2Config = v2Configs.get(deadLetter.agentId);
  const currentTurnMetadataPrompt = buildCurrentTurnMetadataPrompt({
    config: deadLetterV2Config?.currentTurnMetadata,
    ...(deadLetter.discordChannelId
      ? { discord: { channelId: deadLetter.discordChannelId } }
      : {}),
  });

  let selectedProviderName = providerChain[0]?.providerName ?? deadLetter.providerName;
  let providerResolution = "dead-letter";
  let providerSessionId: string | undefined =
    continuityByProvider[selectedProviderName] ?? deadLetter.providerSessionId ?? undefined;
  let failoverFailures: ProviderFailoverFailure[] = [];

  try {
    const failoverResult = await generateWithFailover(
      providerChain,
      {
        prompt: deadLetter.promptText,
        systemPrompt: deadLetter.systemPrompt ?? undefined,
        tools: providerTools,
        model: providerSelection?.model,
        reasoningEffort: providerSelection?.reasoningEffort,
      },
      providerRetryLimit,
      continuityByProvider,
      { warmStartPrompt, currentTurnMetadataPrompt }
    );
    const { providerName, failures, retryResult, requestPrompt, warmStartUsed } = failoverResult;
    selectedProviderName = providerName;
    failoverFailures = failures;
    const response = retryResult.response;
    const toolTelemetry = extractToolTelemetry(response.raw);

    if (warmStartUsed) {
      console.log(
        `[tango-discord] replay warm-start applied session=${deadLetter.sessionId} agent=${deadLetter.agentId} provider=${providerName}`
      );
    }

    if (selectedProviderName !== deadLetter.providerName) {
      if (configuredProviderNames[0] === selectedProviderName) {
        providerResolution = "agent-default";
      } else {
        providerResolution = "agent-fallback";
      }
    }

    providerSessionId = response.providerSessionId ?? continuityByProvider[selectedProviderName];
    if (response.providerSessionId) {
      savePersistedProviderSession({
        conversationKey: deadLetter.conversationKey,
        sessionId: deadLetter.sessionId,
        agentId: deadLetter.agentId,
        providerName: selectedProviderName,
        providerSessionId: response.providerSessionId
      });
    }

    let postedChunks = 0;
    let postedDiscordMessageId: string | null = null;
    if (postToChannel && interaction.channel?.isSendable()) {
      const replaySpeaker = agentRegistry.get(deadLetter.agentId) ?? systemSpeaker;
      const delivery = await sendPresentedReply(interaction.channel, response.text, replaySpeaker);
      postedChunks = delivery.sentChunks;
      postedDiscordMessageId = delivery.lastMessageId ?? null;
    }

    const replaySpeaker = agentRegistry.get(deadLetter.agentId) ?? systemSpeaker;
    const replaySpeakerDisplayName = resolveSpeakerDisplayName(replaySpeaker, systemDisplayName);
    const responseMessageId = await writeMessage({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId,
      providerName: selectedProviderName,
      direction: "outbound",
      source: "tango",
      visibility: "internal",
      discordMessageId: postedDiscordMessageId,
      discordChannelId: deadLetter.discordChannelId,
      discordUserId: postToChannel ? null : client.user?.id ?? null,
      discordUsername: replaySpeakerDisplayName,
      content: response.text,
      metadata: {
        replaySource: "discord-command",
        deadLetterId: deadLetter.id,
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartUsed,
        warmStartContextChars,
        postedChunks,
        presentedAs: replaySpeakerDisplayName,
        attemptCount: retryResult.attempts,
        attemptErrors: retryResult.attemptErrors
      }
    });

    const modelRunId = writeModelRun({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId,
      providerName: selectedProviderName,
      conversationKey: deadLetter.conversationKey,
      providerSessionId: providerSessionId ?? null,
      model: response.metadata?.model,
      stopReason: response.metadata?.stopReason,
      responseMode: deadLetter.responseMode,
      providerDurationMs: response.metadata?.durationMs,
      providerApiDurationMs: response.metadata?.durationApiMs,
      inputTokens: response.metadata?.usage?.inputTokens,
      outputTokens: response.metadata?.usage?.outputTokens,
      cacheReadInputTokens: response.metadata?.usage?.cacheReadInputTokens,
      cacheCreationInputTokens: response.metadata?.usage?.cacheCreationInputTokens,
      totalCostUsd: response.metadata?.totalCostUsd,
      isError: false,
      requestMessageId: deadLetter.requestMessageId,
      responseMessageId,
      metadata: {
        replaySource: "discord-command",
        deadLetterId: deadLetter.id,
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartUsed,
        warmStartContextChars,
        postedChunks,
        attemptCount: retryResult.attempts,
        attemptErrors: retryResult.attemptErrors,
        toolTelemetry
      },
      rawResponse:
        captureProviderRaw && response.raw && typeof response.raw === "object"
          ? (response.raw as Record<string, unknown>)
          : null
    });
    if (modelRunId !== null) {
      writePromptSnapshot({
        modelRunId,
        sessionId: deadLetter.sessionId,
        agentId: deadLetter.agentId,
        providerName: selectedProviderName,
        requestMessageId: deadLetter.requestMessageId,
        responseMessageId,
        promptText: requestPrompt,
        systemPrompt: deadLetter.systemPrompt ?? null,
        warmStartPrompt: warmStartPrompt ?? null,
        metadata: {
          inputSource: "discord-replay",
          responseMode: deadLetter.responseMode,
          promptChars: requestPrompt.length,
          systemPromptChars: deadLetter.systemPrompt?.length ?? 0,
          warmStartPromptChars: warmStartPrompt?.length ?? 0,
          replaySource: "discord-command",
          deadLetterId: deadLetter.id,
          forceReplay,
          postToChannel,
          providerResolution,
          selectedProvider: selectedProviderName,
          providerFailures: failoverFailures,
          turnWarmStartUsed: warmStartUsed,
          requestWarmStartUsed: warmStartUsed,
          attemptedRequests: [
            {
              providerName: selectedProviderName,
              providerSessionId: providerSessionId ?? null,
              warmStartUsed,
              promptText: requestPrompt,
            },
          ],
          warmStartContext: warmStartContext.diagnostics,
        },
      });
    }

    storage.resolveDeadLetter({
      id: deadLetter.id,
      resolvedMessageId: responseMessageId,
      resolvedModelRunId: modelRunId,
      incrementReplayCount: true,
      metadata: {
        replaySource: "discord-command",
        forceReplay,
        postToChannel,
        warmStartUsed,
        warmStartContextChars
      }
    });
    maybeCompactSessionMemory({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId
    });

    const preview = truncate(response.text.replace(/\s+/gu, " ").trim(), 240);
    await interaction.editReply(
      [
        `Replayed dead-letter \`${deadLetter.id}\` successfully.`,
        `provider=${selectedProviderName} resolution=${providerResolution} attempts=${retryResult.attempts} posted_chunks=${postedChunks} warm_start=${warmStartUsed ? "yes" : "no"}`,
        `preview=${JSON.stringify(preview)}`
      ].join("\n")
    );
  } catch (error) {
    const failoverError = error instanceof ProviderFailoverError ? error : null;
    failoverFailures = failoverError?.failures ?? failoverFailures;
    const attemptedRequests = failoverError?.attemptedRequests ?? [];
    const finalAttempt = attemptedRequests.at(-1);
    const messageText = error instanceof Error ? error.message : String(error);
    storage.recordDeadLetterReplayFailure({
      id: deadLetter.id,
      errorMessage: messageText,
      metadata: {
        replaySource: "discord-command",
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartContextChars
      }
    });

    const errorModelRunId = writeModelRun({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId,
      providerName: selectedProviderName,
      conversationKey: deadLetter.conversationKey,
      providerSessionId: providerSessionId ?? null,
      responseMode: deadLetter.responseMode,
      isError: true,
      errorMessage: messageText,
      requestMessageId: deadLetter.requestMessageId,
      metadata: {
        replaySource: "discord-command",
        deadLetterId: deadLetter.id,
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartContextChars,
        toolTelemetry: emptyToolTelemetry()
      },
      rawResponse: null
    });
    if (errorModelRunId !== null) {
      writePromptSnapshot({
        modelRunId: errorModelRunId,
        sessionId: deadLetter.sessionId,
        agentId: deadLetter.agentId,
        providerName: selectedProviderName,
        requestMessageId: deadLetter.requestMessageId,
        responseMessageId: null,
        promptText: finalAttempt?.promptText ?? deadLetter.promptText,
        systemPrompt: deadLetter.systemPrompt ?? null,
        warmStartPrompt: warmStartPrompt ?? null,
        metadata: {
          inputSource: "discord-replay",
          responseMode: deadLetter.responseMode,
          promptChars: finalAttempt?.promptText.length ?? deadLetter.promptText.length,
          systemPromptChars: deadLetter.systemPrompt?.length ?? 0,
          warmStartPromptChars: warmStartPrompt?.length ?? 0,
          replaySource: "discord-command",
          deadLetterId: deadLetter.id,
          forceReplay,
          postToChannel,
          providerResolution,
          selectedProvider: selectedProviderName,
          providerFailures: failoverFailures,
          failed: true,
          turnWarmStartUsed: attemptedRequests.some((attempt) => attempt.warmStartUsed),
          requestWarmStartUsed: finalAttempt?.warmStartUsed ?? false,
          attemptedRequests,
          warmStartContext: warmStartContext.diagnostics,
        },
      });
    }

    await interaction.editReply(`Replay failed for dead-letter '${deadLetter.id}': ${messageText}`);
  }
}

async function handleNewCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const { routingChannelId, threadId, route } = resolveSlashCommandContext(interaction);

  if (!route) {
    await interaction.reply({ content: "No session found for this channel.", ephemeral: true });
    return;
  }

  storage.resetSession(route.sessionId, resetOptionsFromMode("continuity"));
  clearProviderContinuityCacheForSession(route.sessionId);

  if (route.agentId && v2EnabledAgents.has(route.agentId)) {
    await tangoRouter.resetConversation(routingChannelId, threadId);
  }

  const scopeLabel = threadId
    ? `thread \`${threadId}\``
    : `channel \`${routingChannelId}\``;

  await interaction.reply({
    content: [
      `Fresh context started for ${scopeLabel}.`,
      "Next message uses a new Claude session.",
      "Tango message history remains available for warm-start.",
    ].join(" "),
    ephemeral: true,
  });
}

async function handleStopCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const { routingChannelId, threadId } = resolveSlashCommandContext(interaction);

  try {
    const aborted = await tangoRouter.abortConversation(routingChannelId, threadId);
    await interaction.reply({
      content: aborted
        ? "Stopped. The active generation was cancelled; your session is unchanged."
        : "Nothing was running to stop.",
      ephemeral: true,
    });
  } catch (err) {
    await interaction.reply({
      content: `Stop failed: ${err instanceof Error ? err.message : String(err)}`,
      ephemeral: true,
    });
  }
}

async function deliverInThreadContextAlert(channelId: string, message: string): Promise<boolean> {
  try {
    if (!client.isReady()) {
      return false;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return false;
    }

    const textChannel = channel as { send?: (content: string) => Promise<unknown> };
    if (typeof textChannel.send === "function") {
      await conversationDeliveries.run(channelId, async () => {
        const sent = await textChannel.send!(message) as { id?: string } | undefined;
        const routingId = channel.isThread() ? channel.parentId ?? channelId : channelId;
        const route = sessionManager.route(`discord:${routingId}`) ?? sessionManager.route("discord:default");
        if (route) await writeMessage({
          sessionId: storage.getThreadSession(channelId)?.sessionId ?? route.sessionId,
          agentId: route.agentId, direction: "system", source: "tango", content: message,
          discordChannelId: channelId, discordMessageId: sent?.id,
        });
      });
      return true;
    }

    return false;
  } catch (error) {
    console.warn(
      `[tango-discord] context alert delivery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

type ContextAlertUsage = {
  fraction: number;
  totalTokens: number;
  contextWindow: number;
};

function extractTurnContextUsage(metadata: unknown): ContextAlertUsage | undefined {
  const usage = extractResponderContextUsage(asRecord(metadata) ?? undefined);
  if (!usage) {
    return undefined;
  }

  return {
    fraction: usage.fraction,
    totalTokens: usage.totalTokens,
    contextWindow: usage.contextWindow,
  };
}

async function maybePostContextPressureAlert(input: {
  channelId: string;
  routingChannelId: string;
  threadId?: string;
  agentId: string;
  turnUsage?: ContextAlertUsage;
  router?: TangoRouter;
}): Promise<void> {
  const router = input.router ?? tangoRouter;
  const session = router.getSession(input.routingChannelId, input.threadId);
  const usage = input.turnUsage ?? session?.lastContextUsage;
  if (
    !usage
    || !shouldSendContextPressureAlert(
      usage,
      session?.contextPressureAlertSent === true,
    )
  ) {
    return;
  }

  const alertMessage = buildContextPressureInThreadAlert(input.agentId, usage);
  console.log(
    `[tango-discord] context pressure alert agent=${input.agentId} channel=${input.channelId} usage=${Math.round(usage.fraction * 100)}%`,
  );
  const delivered = await deliverInThreadContextAlert(input.channelId, alertMessage);
  if (delivered) {
    router.markContextPressureAlertSent(input.routingChannelId, input.threadId);
  }
}

async function maybePostContextRotationNotice(input: {
  channelId: string;
  routingChannelId: string;
  threadId?: string;
  agentId: string;
  router?: TangoRouter;
}): Promise<void> {
  const router = input.router ?? tangoRouter;
  const notice = router.consumeContextAutoResetNotice(input.routingChannelId, input.threadId);
  if (!notice) {
    return;
  }

  const alertMessage = buildContextRotationInThreadAlert(input.agentId);
  console.log(
    `[tango-discord] context rotation alert agent=${input.agentId} channel=${input.channelId} usage=${Math.round(notice.fraction * 100)}%`,
  );
  const delivered = await deliverInThreadContextAlert(input.channelId, alertMessage);
  if (!delivered) {
    router.restoreContextAutoResetNotice(input.routingChannelId, input.threadId, notice);
  }
}

async function handleContextCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const { routingChannelId, threadId, route } = resolveSlashCommandContext(interaction);

  if (!route) {
    await interaction.reply({ content: "No session found for this channel.", ephemeral: true });
    return;
  }

  const conversationKey = buildV2ConversationKey(routingChannelId, threadId);
  const session = tangoRouter.getSession(routingChannelId, threadId);
  const agentConfig = v2Configs.get(route.agentId);

  // T-I-035: RAM is one router's private map and dies on restart/rotation.
  // Fall back to the persisted snapshots for THIS post — typed keys exactly,
  // voice-shaped keys by embedded channel id — filtered to the routed agent,
  // and show each live session type with its age instead of "unknown".
  const persisted = resolvePersistedContextReadings({
    query: (queryInput) => storage.queryContextUsageSnapshots(queryInput),
    agentId: route.agentId,
    routingChannelId,
    ...(threadId ? { threadId } : {}),
  });

  await interaction.reply({
    content: buildContextSlashReply({
      agentId: route.agentId,
      conversationKey,
      usage: session?.lastContextUsage,
      contextPressureAlertSent: session?.contextPressureAlertSent,
      idleTimeoutHours: agentConfig?.runtime.idleTimeoutHours ?? v2LifecycleConfig.idleTimeoutHours,
      lifecycleIdleTimeoutHours: v2LifecycleConfig.idleTimeoutHours,
      ...(persisted.typed ? { persistedTyped: persisted.typed } : {}),
      ...(persisted.voice ? { persistedVoice: persisted.voice } : {}),
      persistedUnavailable: persisted.unavailable,
      ...(session?.createdAt ? { sessionCreatedAt: session.createdAt } : {}),
    }),
    ephemeral: true,
  });
}

async function handleSaveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const { routingChannelId, threadId, channelKey, route } = resolveSlashCommandContext(interaction);

  if (!route) {
    await interaction.reply({ content: "No session found for this channel.", ephemeral: true });
    return;
  }

  const conversationKey = buildV2ConversationKey(routingChannelId, threadId);
  const activeRoute = resolveActiveTextRoute(route, channelKey);
  storage.upsertPendingSessionSave({
    conversationKey,
    sessionId: activeRoute.sessionId,
    agentId: route.agentId,
    requestedByUserId: interaction.user.id,
    trigger: "slash_command",
  });

  const scopeLabel = threadId
    ? `thread \`${threadId}\``
    : `channel \`${routingChannelId}\``;

  console.log(
    `[tango-discord] pending session save upsert conversation=${conversationKey} session=${activeRoute.sessionId} agent=${route.agentId} user=${interaction.user.id}`,
  );

  await interaction.reply({
    content: buildSavePassEphemeralReply(scopeLabel),
    ephemeral: true,
  });
}

function resolveSlashCommandContext(interaction: ChatInputCommandInteraction): {
  routingChannelId: string;
  threadId?: string;
  channelKey: string;
  route: ReturnType<SessionManager["route"]>;
} {
  const channelId = interaction.channelId;
  const channel = interaction.channel;
  const isThread = channel && "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
  const routingChannelId = isThread
    ? ((channel as { parentId?: string | null }).parentId ?? channelId)
    : channelId;
  const threadId = isThread ? channelId : undefined;
  const channelKey = `discord:${routingChannelId}`;
  let route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");

  if (route && threadId) {
    try {
      const threadSession = storage.getThreadSession(threadId);
      if (threadSession) {
        route = applyThreadSessionRoute(route, threadSession);
      }
    } catch (error) {
      console.error(
        "[tango-discord] Failed to resolve thread session for slash command:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return {
    routingChannelId,
    ...(threadId ? { threadId } : {}),
    channelKey,
    route,
  };
}

async function handleSessionResetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessionId = interaction.options.getString("id", true).trim();
  const mode = (interaction.options.getString("mode") ?? "continuity") as
    | "continuity"
    | "diagnostics"
    | "hard";
  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content: "Reset cancelled. Set `confirm=true` to execute reset.",
      ephemeral: true
    });
    return;
  }

  const summary = storage.getSessionSummary(sessionId);
  if (!summary) {
    await interaction.reply({
      content: `Session '${sessionId}' not found in persistence store.`,
      ephemeral: true
    });
    return;
  }

  const result = storage.resetSession(sessionId, resetOptionsFromMode(mode));
  clearProviderContinuityCacheForSession(sessionId);
  await interaction.reply({
    content: [
      `Reset complete for session \`${sessionId}\` mode=\`${mode}\``,
      "```",
      `deleted_provider_sessions=${result.deletedProviderSessions}`,
      `deleted_messages=${result.deletedMessages}`,
      `deleted_model_runs=${result.deletedModelRuns}`,
      `deleted_dead_letters=${result.deletedDeadLetters}`,
      `deleted_prompt_snapshots=${result.deletedPromptSnapshots}`,
      "```"
    ].join("\n"),
    ephemeral: true
  });
}

async function deliverIMessageToDiscord(
  message: IMessageInboundMessage,
  channelId: string
): Promise<void> {
  if (!client.isReady()) {
    console.warn("[tango-imessage] Discord client not ready, skipping delivery");
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[tango-imessage] Discord channel ${channelId} not found or not text-based`);
    return;
  }

  const sender = message.displayName !== message.sender
    ? `**${message.displayName}** (${message.sender})`
    : `**${message.sender}**`;
  const groupLabel = message.isGroup ? ` in group chat ${message.chatId}` : "";
  const header = `iMessage from ${sender}${groupLabel}:`;
  const body = `${header}\n>>> ${message.content}`;

  await sendPresentedReply(channel as Message["channel"], body, systemSpeaker);
}

async function handleIMessageMessage(
  _listener: IMessageListener,
  message: IMessageInboundMessage
): Promise<void> {
  const route = resolveIMessageRoute(message.channelKey);

  console.log(
    `[tango-imessage] msg channel=${message.channelKey} user=${message.displayName} routed=${route?.sessionId ?? "none"}`
  );

  if (!route) {
    return;
  }

  upsertSessionForRoute(route, message.channelKey);

  const targetAgent = agentRegistry.get(route.agentId) ?? null;

  // Persist the inbound message
  await writeMessage({
    sessionId: route.sessionId,
    agentId: route.agentId,
    direction: "inbound",
    source: "imessage",
    visibility: "public",
    content: message.content,
    metadata: buildIMessageMetadata(message, {
      routedAgentId: route.agentId,
      resolvedSessionId: route.sessionId,
      targetAgentId: targetAgent?.id ?? route.agentId,
      displayName: message.displayName
    })
  });

  // Deliver to Discord (observe mode — never reply via iMessage)
  const deliveryChannelId = imessageDiscordChannelId;
  if (deliveryChannelId) {
    try {
      await deliverIMessageToDiscord(message, deliveryChannelId);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      console.error(`[tango-imessage] Discord delivery failed: ${errorText}`);
    }
  }

  console.log(
    `[tango-imessage] observed session=${route.sessionId} agent=${route.agentId} from=${message.displayName} len=${message.content.length}${deliveryChannelId ? ` delivered=discord:${deliveryChannelId}` : " delivered=none"}`
  );
}

async function handleTangoCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canRunAdminCommand(interaction)) {
    await interaction.reply({
      content: "This command requires `Administrator` or `Manage Server` permission.",
      ephemeral: true
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  if (group === "session" && subcommand === "reset") {
    await handleSessionResetCommand(interaction);
    return;
  }

  if (group === "session" && subcommand === "provider") {
    await handleSessionProviderCommand(interaction);
    return;
  }

  if (group === "session" && subcommand === "continuity") {
    await handleSessionContinuityCommand(interaction);
    return;
  }

  if (group === "session" && subcommand === "snapshot") {
    await handleSessionSnapshotCommand(interaction);
    return;
  }

  if (subcommand === "new") {
    await handleNewCommand(interaction);
    return;
  }

  if (subcommand === "stop") {
    await handleStopCommand(interaction);
    return;
  }

  if (subcommand === "save") {
    await handleSaveCommand(interaction);
    return;
  }

  if (subcommand === "context") {
    await handleContextCommand(interaction);
    return;
  }

  if (subcommand === "status") {
    await handleStatusCommand(interaction);
    return;
  }

  if (subcommand === "deadletters") {
    await handleDeadLettersCommand(interaction);
    return;
  }

  if (subcommand === "access") {
    await handleAccessCommand(interaction);
    return;
  }

  if (subcommand === "capabilities") {
    await handleCapabilitiesCommand(interaction);
    return;
  }

  if (subcommand === "replay") {
    await handleReplayCommand(interaction);
    return;
  }

  if (subcommand === "trigger") {
    const scheduleId = interaction.options.getString("schedule", true);
    if (!scheduler) {
      await interaction.reply({ content: "Scheduler not initialized.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await scheduler.trigger(scheduleId);
      if (!result) {
        await interaction.editReply(`Schedule \`${scheduleId}\` not found.`);
      } else {
        const errDetail = result.error ? `\n${result.error.slice(0, 300)}` : "";
        await interaction.editReply(`Triggered \`${scheduleId}\` — status: ${result.status}, duration: ${Math.round((result.durationMs ?? 0) / 1000)}s${errDetail}`);
      }
    } catch (err) {
      await interaction.editReply(`Trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  await interaction.reply({
    content: "Unsupported Tango command.",
    ephemeral: true
  });
}

async function handleMessage(
  message: Message,
  options?: {
    existingInboundMessageId?: number | null;
    recoverySource?: "startup-orphan-check";
    intakeWebhook?: IntakeWebhookEntry | null;
    /** The owner's reply from the desk: recorded as the owner's own message, words only. */
    deskReply?: { ownerId: string | null; ownerName: string | null; answersMessageId: string | null; text: string } | null;
  }
): Promise<void> {
  if (!options?.intakeWebhook && !options?.deskReply && !options?.existingInboundMessageId) {
    if (isOwnConversationPost(message, client.user?.id, conversationWebhookIds) || storage.findConversationPostByDiscordId(message.id)) return;
  }
  const intakeWebhook = options?.intakeWebhook ?? null;
  const deskReply = options?.deskReply ?? null;
  const senderId = deskReply?.ownerId ?? (intakeWebhook ? intakeSenderId(intakeWebhook) : message.author.id);
  const senderUsername = deskReply?.ownerName ?? intakeWebhook?.label ?? message.author.username;
  const channelKey = toChannelKey(message);
  let route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
  if (route && intakeWebhook) {
    route = { ...route, agentId: intakeWebhook.agentId };
  }

  // If this message came from a Discord thread, check for a registered session override.
  // When an agent creates a thread from session X, replies route to the parent channel's
  // session by default — not X. The mapping lets us resume the originating session.
  // For forum threads with no registered mapping, auto-create a topic session so each
  // thread gets its own isolated conversation context.
  if (route && `discord:${message.channelId}` !== channelKey) {
    try {
      const threadSession = storage.getThreadSession(message.channelId);
      if (threadSession) {
        route = applyThreadSessionRoute(route, threadSession);
        // Backfill agent_id for threads created before agent tracking was added
        if (!threadSession.agentId && route.agentId) {
          storage.setThreadSession(message.channelId, threadSession.sessionId, route.agentId);
        }
      } else {
        // Auto-register forum/thread sessions: create a topic from the thread name
        // so each Discord thread gets its own Claude session instead of sharing the parent's.
        const threadChannel = message.channel;
        const threadName =
          "name" in threadChannel && typeof threadChannel.name === "string"
            ? threadChannel.name.trim()
            : null;
        if (threadName) {
          // Inherit the parent channel's project so the topic stays in context.
          const parentProjectId = parseProjectSessionId(route.sessionId) ?? null;
          const topic = upsertChannelTopic(channelKey, threadName, null, parentProjectId, true);
          const topicSessionId = buildTopicSessionId(topic.id);
          storage.setThreadSession(message.channelId, topicSessionId, route.agentId);
          route = { ...route, sessionId: topicSessionId };
          console.log(
            `[tango-discord] auto-registered thread session thread=${message.channelId} topic="${topic.title}" session=${topicSessionId} agent=${route.agentId}`
          );
        }
      }
    } catch (e: unknown) {
      console.error("[tango-discord] Failed to resolve thread session mapping:", e instanceof Error ? e.message : e);
    }
  }

  console.log(
    `[tango-discord] msg channel=${channelKey} user=${senderUsername} routed=${route?.sessionId ?? "none"}`
  );

  if (!route) {
    return;
  }

  upsertSessionForRoute(route);

  const resolvedContent = await resolveEffectiveContent(message);
  // A desk reply: the agent and its memory get the owner's words, not the channel's 🖥️ post.
  const effectiveContent = deskReply ? deskReply.text : resolvedContent;
  if (!deskReply && effectiveContent !== message.content) {
    console.log(
      `[tango-discord] resolved edge-case content: originalLen=${message.content.length} effectiveLen=${effectiveContent.length} forwarded=${message.reference?.type === MessageReferenceType.Forward} txtAttachments=${[...message.attachments.values()].filter(a => a.name?.endsWith(".txt")).length}`
    );
  }
  const commandParse = parseLeadingCommands(effectiveContent);
  const naturalRoute = intakeWebhook ? null : applyInlineTopicGuard(
    commandParse.agentOverride === null
      ? parseNaturalTextRoute({
          text: commandParse.promptText,
          voiceTargets,
          focusedAgentId: getFocusedTextAgentId(channelKey)
        })
      : null,
    channelKey
  );
  const replyReferent = resolveReplyReferent(message);
  const reactionReferent = takeReactionReferent(message);
  const messageReferent = replyReferent ?? reactionReferent;

  const resolvedTargetAgent = resolveContextualTargetAgent({
    channelKey,
    routeSessionId: route.sessionId,
    routeAgentId: route.agentId,
    explicitAgentId:
      intakeWebhook?.agentId ??
      commandParse.agentOverride ??
      naturalRoute?.addressedAgentId ??
      messageReferent?.targetAgentId ??
      null
  });
  if (!resolvedTargetAgent) {
    await sendPresentedReply(message.channel, `No agent config found for '${route.agentId}'.`, systemSpeaker);
    return;
  }
  const targetAgent = resolvedTargetAgent;

  // System commands ("Tango, status") use the default policy, not the focused
  // agent's narrower override.
  const accessPolicy = naturalRoute?.systemCommand
    ? defaultAccessPolicy
    : resolveAccessPolicy(targetAgent, defaultAccessPolicy);
  const routingChannelId = resolveRoutingChannelId(message);
  const threadChannelId = message.channelId !== routingChannelId ? message.channelId : undefined;
  const access = intakeWebhook ? {
    allowed: true,
    mode: accessPolicy.mode,
    mentionRequired: false,
    mentioned: false,
    channelAllowed: true,
    userAllowed: true,
    reason: "configured-intake-webhook",
  } : evaluateAccess(
    {
      channelId: routingChannelId,
      threadChannelId,
      userId: senderId,
      mentioned: hasMentionForBot(message)
    },
    accessPolicy
  );
  if (!access.allowed) {
    await writeMessage({
      sessionId: route.sessionId,
      agentId: targetAgent.id,
      direction: "system",
      source: "tango",
      visibility: "debug",
      discordMessageId: message.id,
      discordChannelId: message.channelId,
      discordUserId: senderId,
      discordUsername: senderUsername,
      content: "message blocked by access control",
      metadata: {
        accessMode: access.mode,
        targetAgentId: targetAgent.id,
        reason: access.reason,
        mentionRequired: access.mentionRequired,
        mentioned: access.mentioned,
        channelAllowed: access.channelAllowed,
        userAllowed: access.userAllowed,
        allowlistChannelCount: accessPolicy.allowlistChannelIds.size,
        allowlistUserCount: accessPolicy.allowlistUserIds.size
      }
    });

    console.log(
      `[tango-discord] blocked mode=${access.mode} agent=${targetAgent.id} reason=${access.reason} channel=${message.channelId} user=${message.author.username}`
    );
    return;
  }

  const mirrored = storage.getDatabase().prepare("SELECT conversation_key FROM conversations WHERE discord_thread_id=? AND conversation_key LIKE 'conv:%'").get(message.channelId) as { conversation_key: string } | undefined;
  if (mirrored) {
    if (listenOnly || (v2Configs.get(targetAgent.id)?.discordMirror ?? 'both') !== 'both') return;
    await deliverConversationInput({ agentId: targetAgent.id, conversationKey: mirrored.conversation_key,
      data: { text: effectiveContent }, replyToMessageId: message.reference?.messageId }, message);
    return;
  }

  if (naturalRoute?.systemCommand) {
    await handleNaturalTextSystemCommand({
      message,
      channelKey,
      route,
      command: naturalRoute.systemCommand
    });
    return;
  }

  let promptRoute = resolvePromptTextRoute({
    route,
    channelKey,
    targetAgent,
    naturalRoute
  });
  if (
    shouldPreferReferentSession({
      promptText: naturalRoute?.promptText ?? commandParse.promptText,
      referent: messageReferent,
      explicitTopicName: naturalRoute?.topicName ?? null,
      activeSessionId: promptRoute.sessionId,
    }) &&
    messageReferent?.targetSessionId
  ) {
    promptRoute = resolveSessionRouteFromSessionId(
      messageReferent.targetSessionId,
      messageReferent.targetAgentId ?? targetAgent.id
    );
  }
  upsertSessionForRoute(promptRoute, channelKey);

  const referentMessageId =
    messageReferent && messageReferent.targetContent.trim().length > 0
      ? await writeMessage({
          sessionId: promptRoute.sessionId,
          agentId: targetAgent.id,
          direction: "system",
          source: "tango",
          visibility: "internal",
          discordChannelId: message.channelId,
          content: buildReferentSystemMessage(messageReferent),
          metadata: {
            kind: messageReferent.kind,
            targetMessageId: messageReferent.targetMessageId,
            targetSessionId: messageReferent.targetSessionId,
            targetAgentId: messageReferent.targetAgentId,
            ...messageReferent.metadata,
          },
        })
      : null;

  const inboundMessageId = options?.existingInboundMessageId ?? await writeMessage({
    sessionId: promptRoute.sessionId,
    agentId: targetAgent.id,
    direction: "inbound",
    source: "discord",
    visibility: "public",
    discordMessageId: message.id,
    discordChannelId: message.channelId,
    discordUserId: senderId,
    discordUsername: senderUsername,
    content: effectiveContent,
    metadata: {
      channelKey,
      routedAgentId: route.agentId,
      resolvedSessionId: promptRoute.sessionId,
      targetAgentId: targetAgent.id,
      topicId: promptRoute.topic?.id ?? null,
      topicSlug: promptRoute.topic?.slug ?? null,
      topicTitle: promptRoute.topic?.title ?? null,
      projectId: promptRoute.project?.id ?? null,
      projectTitle: promptRoute.project?.displayName ?? null,
      listenOnly,
      commandParse,
      naturalRoute,
      messageTimestamp: message.createdAt.toISOString(),
      messageTimestampSource: "discord-sent",
      discordReplyToMessageId: message.reference?.messageId?.trim() || deskReply?.answersMessageId || null,
      ...(deskReply ? { source: "desk" } : {}),
      messageReferent,
      referentSystemMessageId: referentMessageId,
      recoverySource: options?.recoverySource ?? null,
      intakeWebhook: intakeWebhook ? {
        webhookId: intakeWebhook.webhookId,
        channelId: intakeWebhook.channelId,
        label: intakeWebhook.label,
      } : null,
      attachments: attachmentsForMetadata(message)
    }
  });

  if (listenOnly) {
    return;
  }

  const promptText = intakeWebhook
    ? effectiveContent
    : naturalRoute?.promptText ?? commandParse.promptText;
  if (await maybeHandleWatsonInterstitialStatusCapture({
    message,
    promptText,
    targetAgent,
    promptRoute,
    inboundMessageId,
  })) {
    return;
  }

  const responseMode = resolveResponseMode(targetAgent, commandParse.responseModeOverride);
  // Ollama-backed clones run the stateless OpenAI-compatible loop with no Claude-CLI
  // Read tool, so they can't open a file by path. But they DO hold attachment_* tool
  // grants (extracted text / OCR) and, when inline vision is on, are handed image
  // bytes folded through the vision model this turn. Pass access that reflects both so the
  // suffix points them at attachment_read for files and states that image content is
  // provided, instead of the stale "you cannot view/read it" wording.
  const targetAgentIsOllama = isOllamaBackedAgent(v2Configs.get(targetAgent.id));
  const attachmentResult = await processAttachments(message.attachments, promptRoute.sessionId, {
    attachmentStore,
    dataDir: attachmentDataDir,
    agentAttachmentAccess: {
      canReadLocalFiles: !targetAgentIsOllama,
      canUseAttachmentTools: true,
      canViewImagesInline: targetAgentIsOllama && CLONE_INLINE_VISION,
    },
    sourceRefs: {
      agentId: targetAgent.id,
      localMessageId: inboundMessageId,
      discordMessageId: message.id,
      channelId: routingChannelId,
      threadId: message.channelId !== routingChannelId ? message.channelId : null,
      userId: message.author.id,
      projectId: promptRoute.project?.id ?? null,
      metadata: {
        channelKey,
        discordUsername: message.author.username,
        messageTimestamp: message.createdAt.toISOString(),
      },
    },
  });
  const prompt = buildPromptWithReferent(
    buildPrompt(
      intakeWebhook ? effectiveContent : naturalRoute?.promptText ?? commandParse.promptText,
      message,
    ) + attachmentResult.promptSuffix,
    messageReferent
  );
  if (prompt.length === 0) {
    // Diagnostic: capture what we actually saw so we can tell whether raw content
    // was empty (Discord Message Content Intent cold-start, thread membership
    // timing, etc.) or whether the parser stripped real content. Kept as a warn
    // log so it shows up in normal tmux captures.
    const rawContent = typeof message.content === "string" ? message.content : "";
    const rawTrimmed = rawContent.trim();
    console.warn(
      `[tango-discord] empty-prompt rawLen=${rawContent.length} rawTrimmedLen=${rawTrimmed.length} commandParseLen=${commandParse.promptText.length} naturalRouteLen=${naturalRoute?.promptText?.length ?? -1} hasAttachments=${message.attachments.size} agentOverride=${commandParse.agentOverride ?? "-"} author=${message.author.username} channel=${message.channelId}`
    );
    await sendPresentedReply(
      message.channel,
      "I received an empty message. Send text, or include `/agent <id> your message`.",
      systemSpeaker
    );
    return;
  }

  // Victor manual-console bridge: route to VICTOR-COS only when explicitly enabled.
  if (targetAgent.id === "victor" && isVictorManualConsoleBridgeActive()) {
    const threadId = message.channelId !== routingChannelId ? message.channelId : undefined;
    const typingSession = agentTypingPresenter.start(targetAgent.id, message.channelId);

    try {
      const bridgeMessage: VictorBridgeMessage = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: "discord-text",
        user: { id: message.author.id, username: message.author.username },
        channel: { id: routingChannelId, ...(threadId ? { threadId } : {}) },
        content: prompt,
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
      };

      const requestId = await sendToVictorInbox(bridgeMessage);
      const bridgeResponse = await waitForVictorResponse(requestId, 120_000);

      const replyDelivery = await sendPresentedReply(message.channel, bridgeResponse.text, targetAgent);
      ensureReplyDeliverySucceeded(replyDelivery, message.channelId);

      await writeMessage({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        providerName: "victor-bridge",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordMessageIds: replyDelivery.messageIds,
        discordMessageId: replyDelivery.lastMessageId ?? null,
        discordChannelId: message.channelId,
        discordUserId: null,
        discordUsername: replyDelivery.actualDisplayName,
        content: bridgeResponse.text,
        metadata: {
          replyToDiscordMessageId: message.id,
          sentChunks: replyDelivery.sentChunks,
          runtimePath: "victor-bridge",
          bridgeRequestId: requestId,
        },
      });

      console.log(
        `[tango-discord] victor-bridge reply session=${promptRoute.sessionId} delivery=${replyDelivery.delivery} chunks=${replyDelivery.sentChunks}`,
      );
      cleanupAttachments(attachmentResult.tempDir);
      return;
    } catch (error) {
      console.error(
        `[tango-discord] victor-bridge failed, falling back to ephemeral v2:`,
        error instanceof Error ? error.message : error,
      );
      // Fall through to normal v2 path
    } finally {
      typingSession.stop();
    }
  }

  if (v2EnabledAgents.has(targetAgent.id)) {
    const threadId = message.channelId !== routingChannelId ? message.channelId : undefined;
    const v2AgentConfig = v2Configs.get(targetAgent.id);
    const typingSession = agentTypingPresenter.start(targetAgent.id, message.channelId);
    let ownedLoomRunId: string | undefined;
    const deskTurn = startDeskTurn({
      agentId: targetAgent.id,
      conversationKey: conversationKeyFor(routingChannelId, threadId),
      channelId: routingChannelId,
      ...(threadId ? { threadId } : {}),
    });

    try {
      const conversationKey = buildV2ConversationKey(routingChannelId, threadId);
      const discordContextLabel = "name" in message.channel && typeof message.channel.name === "string"
        ? message.channel.name.trim()
        : "";
      const memoryContextLabel =
        promptRoute.topic?.title?.trim()
        || promptRoute.project?.displayName?.trim()
        || discordContextLabel
        || channelKey;
      const memoryContextRef = promptRoute.topic?.id
        ? `topic:${promptRoute.topic.id}`
        : promptRoute.project?.id
          ? `project:${promptRoute.project.id}`
          : conversationKey;
      const pendingSave = storage.getPendingSessionSave(conversationKey);
      const hasPendingSavePass = matchesPendingSessionSave(pendingSave, {
        agentId: targetAgent.id,
      });

      if (hasPendingSavePass) {
        console.log(
          `[tango-discord] injecting pending session save pass conversation=${conversationKey} session=${promptRoute.sessionId} agent=${targetAgent.id}`,
        );
      }

      const warmStartContext = await buildWarmStartContext({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        currentUserPrompt: prompt,
        orchestratorContinuityMode: resolveOrchestratorContinuityModeForAgent(
          targetAgent.id,
          promptRoute.sessionId,
        ),
        discordChannelId: routingChannelId,
        discordThreadId: threadId,
      });
      const warmStartPrompt = warmStartContext.prompt;
      const lastContextUsage = tangoRouter.getSession(routingChannelId, threadId)?.lastContextUsage;
      const currentTurnMetadataPrompt = buildCurrentTurnMetadataPrompt({
        timestamp: message.createdAt,
        timestampSource: "discord-sent",
        config: v2AgentConfig?.currentTurnMetadata,
        discord: {
          channelId: routingChannelId,
          ...(threadId ? { threadId } : {}),
        },
        ...(lastContextUsage ? { contextUsage: lastContextUsage } : {}),
      });
      // Per-turn briefing ("whisper") survives provider-session resume. It emits
      // the project state-file pointer when this conversation is bound to a
      // project arc; otherwise it stays silent unless search-first is flag-on,
      // so non-project conversations are behavior-unchanged.
      const briefingConversationKey = conversationKeyFor(routingChannelId, threadId);
      const stateFilePointer = buildStateFilePointer(storage, briefingConversationKey, {
        vaultRoot: resolveStateVaultRoot(),
        profileRoot: resolveStateProfileRoot(),
      });
      const sessionContextUsage = lastContextUsage?.fraction;
      const turnBriefingPrompt = buildTurnBriefingPrompt({
        ...(stateFilePointer ? { stateFile: stateFilePointer } : {}),
        searchFirst: Boolean(stateFilePointer) || process.env.TANGO_TURN_BRIEFING_SEARCH_FIRST === "1",
        ...(typeof sessionContextUsage === "number" && Number.isFinite(sessionContextUsage)
          ? { contextUsageFraction: sessionContextUsage }
          : {}),
        ...(hasPendingSavePass
          ? {
              extraLines: [
                "Save pass active this turn (/tango save): review the conversation and route saves to thread file, daily log, and Atlas per session-save.md; confirm what you saved.",
              ],
            }
          : {}),
        stateDigest: buildStateDigest(briefingConversationKey, targetAgent.id),
      });
      const sendContext = buildSendContextWithOptionalSavePass(warmStartPrompt, hasPendingSavePass);
      // Clone same-turn vision: hand inbound image bytes to the Ollama runtime so the
      // provider folds them through a vision model on the arrival turn (Claude agents
      // open files via their own Read tool, so this is clone-only).
      const inlineImages =
        targetAgentIsOllama && CLONE_INLINE_VISION
          ? buildCloneInlineImages(attachmentResult.processed)
          : [];
      await sendPromptLayerWarningsIfNeeded(message, targetAgent.id);
      const mappedTurn = discordMessageToTurn(message, storage, { conversationKey, agentId: targetAgent.id, sessionId: promptRoute.sessionId });
      const storedTurn = await runConversationTurn({
        ...mappedTurn,
        // Attachment processing already copied and enriched this inbound row.
        attachments: undefined,
        author: { kind: intakeWebhook && !deskReply ? "requester" : "owner", id: senderId, name: senderUsername },
        text: effectiveContent, origin: deskReply ? "desk" : "discord", discordMessageId: message.id,
        channelId: routingChannelId, threadId, existingInboundMessageId: inboundMessageId ?? undefined,
      }, { storage, dataDir: attachmentDataDir, route: async (localMessageId) => {
        const result = await routeV2MessageIfEnabled(
        {
          message: prompt,
          channelId: routingChannelId,
          ...(threadId ? { threadId } : {}),
          messageId: String(localMessageId),
          occurredAt: message.createdAt.toISOString(),
          contextRef: memoryContextRef,
          contextLabel: memoryContextLabel,
          agentId: targetAgent.id,
          sendOptions: {
            onLoomSubmitted: (runId) => { ownedLoomRunId = runId; },
            discordDelivery: { channelId: routingChannelId, threadId, messageId: message.id,
              context: { sessionId: promptRoute.sessionId, prompt, retryText: message.content, requestMessageId: inboundMessageId,
                occurredAt: message.createdAt.toISOString(), contextRef: memoryContextRef, contextLabel: memoryContextLabel } },
            ...(sendContext ? { context: sendContext } : {}),
            currentTurnMetadataPrompt,
            ...(turnBriefingPrompt ? { turnBriefingPrompt } : {}),
            ...(inlineImages.length > 0 ? { images: inlineImages } : {}),
            onEvent: deskTurn.onEvent,
          },
        },
        {
          v2EnabledAgents,
          tangoRouter,
          recoverFromRuntimeFailure: recoverV2RuntimeFailure,
        },
      );
        if (!result) throw new Error(`Expected v2 routing for '${targetAgent.id}'`);
        if (targetAgentIsOllama || asRecord(result.response.metadata)?.backend === 'ollama-fallback') {
          result.response = { ...result.response, text: coerceWorkerReplyForDisplay(result.response.text) };
        }
        return result;
      } });
      if (!storedTurn) return;
      const v2Result = storedTurn;

      const runtimeMetadata = asRecord(v2Result.response.metadata);
      const providerMetadata = asRecord(runtimeMetadata?.providerMetadata);
      const providerUsage = asRecord(providerMetadata?.usage);
      const providerSessionId = metadataString(runtimeMetadata, "sessionId") ?? null;
      // Save bookkeeping: keep the project head's session chain current (no-op
      // unless this conversation is bound to a project arc).
      refreshProjectHeadOnTurn(storage, briefingConversationKey, providerSessionId);
      const runtimeModel =
        v2Result.response.model
        ?? metadataString(providerMetadata, "model")
        ?? null;
      const toolsUsed = v2Result.response.toolsUsed ?? [];
      const runtimeError = metadataBoolean(runtimeMetadata, "error") ?? false;
      const rawRuntimeResponse = asRecord(runtimeMetadata?.raw);
      // Ollama clones run a stateless OpenAI-compatible loop and occasionally wrap
      // output in JSON / fenced structured blocks. Coerce to clean display text so
      // raw JSON never leaks to the channel, and store the cleaned text so it does
      // not pollute the next turn's warm-start. Claude replies pass through unchanged.
      const v2Backend = metadataString(runtimeMetadata, "backend");
      const replyText = targetAgentIsOllama || v2Backend === "ollama-fallback"
        ? coerceWorkerReplyForDisplay(v2Result.response.text)
        : v2Result.response.text;
      // Label the turn by backend so Ollama clone turns are not miscounted as the
      // Claude path. provider_name was hardcoded "claude-code-v2" for every v2 turn,
      // which made the cost A/B (the reason this project exists) unmeasurable.
      // Degraded-mode recovery turns (TGO-846) are labeled by the provider that
      // actually served them.
      const v2ProviderName = v2Backend === "codex-fallback"
        ? "codex"
        : v2Backend === "ollama-fallback"
          ? "ollama"
          : v2Backend === "loom" ? "loom" : targetAgentIsOllama ? "ollama" : "claude-code-v2";
      const loomRunId = metadataString(runtimeMetadata, "loomRunId") ?? ownedLoomRunId;
      if (loomRunId && !storage.claimLoomDelivery(loomRunId)) {
        deskTurn.finish();
        return;
      }
      const replyDelivery = await presentRuntimeReply(message.channel, { ...v2Result.response, text: replyText }, targetAgent, undefined, storedTurn.responseMessageId).catch(error => {
        console.warn('[conversation-mirror] stored answer could not be mirrored', error);
        return { sentChunks: 0, delivery: "bot" as const, intendedDisplayName: targetAgent.displayName ?? targetAgent.id,
          actualDisplayName: "", failed: true, messageIds: [] as string[], lastMessageId: undefined };
      });
      if (loomRunId) storage.finishLoomDelivery(loomRunId, "delivered");
      const runtimeFailure = runtimeError ? runtimeErrorResponseFailure(v2Result.response) : null;
      if (runtimeFailure) {
        deskTurn.failWith(runtimeFailure);
      } else {
        deskTurn.finish();
      }

      const outboundMessageId = await writeMessage({
        localMessageId: storedTurn.responseMessageId,
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        providerName: v2ProviderName,
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordMessageIds: replyDelivery.messageIds,
        discordMessageId: replyDelivery.lastMessageId ?? null,
        discordChannelId: message.channelId,
        discordUserId: replyDelivery.delivery === "bot" ? client.user?.id ?? null : null,
        discordUsername: replyDelivery.actualDisplayName,
        content: replyText,
        metadata: {
          replyToDiscordMessageId: message.id,
          sentChunks: replyDelivery.sentChunks,
          senderIdentity: {
            intendedDisplayName: replyDelivery.intendedDisplayName,
            actualDisplayName: replyDelivery.actualDisplayName,
            delivery: replyDelivery.delivery,
          },
          runtimePath: "v2",
          conversationKey: v2Result.conversationKey,
          runtimeDurationMs: v2Result.response.durationMs,
          runtimeModel,
          runtimeToolsUsed: toolsUsed,
          runtimeMetadata: v2Result.response.metadata ?? null,
        },
      });

      writeModelRun({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        providerName: v2ProviderName,
        conversationKey: v2Result.conversationKey,
        providerSessionId,
        model: runtimeModel,
        stopReason: metadataString(providerMetadata, "stopReason") ?? null,
        responseMode,
        latencyMs: v2Result.response.durationMs,
        providerDurationMs: metadataNumber(providerMetadata, "durationMs") ?? null,
        providerApiDurationMs: metadataNumber(providerMetadata, "durationApiMs") ?? null,
        inputTokens: metadataNumber(providerUsage, "inputTokens") ?? null,
        outputTokens: metadataNumber(providerUsage, "outputTokens") ?? null,
        cacheReadInputTokens: metadataNumber(providerUsage, "cacheReadInputTokens") ?? null,
        cacheCreationInputTokens: metadataNumber(providerUsage, "cacheCreationInputTokens") ?? null,
        totalCostUsd: metadataNumber(providerMetadata, "totalCostUsd") ?? null,
        isError: runtimeError,
        errorMessage:
          runtimeError
            ? metadataString(runtimeMetadata, "stderr")
              ?? `${targetAgentIsOllama ? "Ollama" : "Claude Code"} runtime returned an error response.`
            : null,
        requestMessageId: inboundMessageId,
        responseMessageId: outboundMessageId,
        metadata: {
          replyToDiscordMessageId: message.id,
          sentChunks: replyDelivery.sentChunks,
          senderIdentity: {
            intendedDisplayName: replyDelivery.intendedDisplayName,
            actualDisplayName: replyDelivery.actualDisplayName,
            delivery: replyDelivery.delivery,
          },
          responseMode,
          runtimePath: "v2",
          toolsUsed,
          warmStartPromptChars: warmStartPrompt?.length ?? 0,
          turnWarmStartUsed: Boolean(warmStartPrompt),
          requestWarmStartUsed: Boolean(warmStartPrompt),
          warmStartContext: warmStartContext.diagnostics,
          runtimeExitCode: metadataNumber(runtimeMetadata, "exitCode") ?? null,
          runtimeSignal: metadataString(runtimeMetadata, "signal") ?? null,
          runtimeStderr: metadataString(runtimeMetadata, "stderr") ?? null,
        },
        rawResponse:
          captureProviderRaw && rawRuntimeResponse
            ? rawRuntimeResponse
            : null,
      });

      console.log(
        `[tango-discord] v2 reply session=${promptRoute.sessionId} agent=${targetAgent.id} conversation=${v2Result.conversationKey} ms=${v2Result.response.durationMs} delivery=${replyDelivery.delivery} chunks=${replyDelivery.sentChunks}`,
      );

      if (!runtimeError) {
        scheduleStatePostTurn({
          turnId: v2Result.turnId,
          conversationKey: v2Result.conversationKey,
          sessionId: promptRoute.sessionId,
          agentId: targetAgent.id,
          userMessage: prompt,
          response: { ...v2Result.response, text: replyText },
          channelId: message.channelId,
          ...(threadId ? { threadId } : {}),
          requestMessageId: inboundMessageId,
          responseMessageId: outboundMessageId,
          discordRequestMessageId: message.id,
          discordResponseMessageId: replyDelivery.lastMessageId,
          occurredAt: message.createdAt.toISOString(),
          contextRef: memoryContextRef,
          contextLabel: memoryContextLabel,
        });
      }

      if (hasPendingSavePass && !runtimeError) {
        const cleared = storage.deletePendingSessionSave(conversationKey);
        console.log(
          `[tango-discord] fulfilled pending session save conversation=${conversationKey} cleared=${cleared}`,
        );
      }

      const turnContextUsage = extractTurnContextUsage(v2Result.response.metadata);

      await maybePostContextRotationNotice({
        channelId: message.channelId,
        routingChannelId,
        ...(threadId ? { threadId } : {}),
        agentId: targetAgent.id,
      });

      await maybePostContextPressureAlert({
        channelId: message.channelId,
        routingChannelId,
        ...(threadId ? { threadId } : {}),
        agentId: targetAgent.id,
        ...(turnContextUsage ? { turnUsage: turnContextUsage } : {}),
      });

      return;
    } catch (error) {
      // An owner stop is not a failure: retire the delivery quietly instead of posting the error notice.
      if (isRuntimeAbortedError(error) && ownedLoomRunId) {
        if (storage.claimLoomDelivery(ownedLoomRunId)) storage.finishLoomDelivery(ownedLoomRunId, "abandoned");
        deskTurn.finish();
        throw error;
      }
      const pendingLoom = storage.listPendingLoomDeliveries().find(record => record.messageId === message.id && liveLoomDeliveries.has(record.runId));
      if (pendingLoom) {
        // Leave the durable row unclaimed. Recovery observes the terminal state and delivers once.
        if (error instanceof LoomPendingError && error.status === "failed") {
          liveLoomDeliveries.delete(pendingLoom.runId);
          await recoverPendingLoomReplies();
        } else {
          await sendPresentedReply(message.channel, LOOM_PENDING_NOTICE, systemSpeaker)
            .catch(error => console.warn("[tango-discord] pending notice failed", error));
        }
        deskTurn.finish();
        return;
      }
      if (ownedLoomRunId) {
        // A claimed send may already have reached Discord. Do not post another notice.
        console.error(`[tango-discord] claimed Loom delivery run=${ownedLoomRunId} failed`, error);
        deskTurn.fail(error);
        return;
      }
      // A thrown turn becomes a dead letter upstream; an owner abort is not a failure.
      if (isRuntimeAbortedError(error)) {
        deskTurn.finish();
      } else {
        deskTurn.fail(error);
      }
      throw error;
    } finally {
      if (ownedLoomRunId) liveLoomDeliveries.delete(ownedLoomRunId);
      typingSession.stop();
      cleanupAttachments(attachmentResult.tempDir);
    }
  }

  const retiredRuntimeMessage = `Agent '${targetAgent.id}' is not configured for the v2 runtime. Legacy Discord turn execution has been retired.`;
  console.error(`[tango-discord] ${retiredRuntimeMessage}`);
  await writeMessage({
    sessionId: promptRoute.sessionId,
    agentId: targetAgent.id,
    providerName: "claude-code-v2",
    direction: "error",
    source: "tango",
    visibility: "debug",
    discordChannelId: message.channelId,
    discordUserId: client.user?.id ?? null,
    discordUsername: systemDisplayName,
    content: retiredRuntimeMessage,
    metadata: {
      replyToDiscordMessageId: message.id,
      responseMode,
      runtimePath: "v2-required",
    },
  });
  await sendPresentedReply(
    message.channel,
    "That agent has not been migrated to the v2 runtime yet, so I can't safely run it.",
    systemSpeaker,
  );
  cleanupAttachments(attachmentResult.tempDir);
  return;
}


function rememberProcessedMessageId(messageId: string): void {
  if (recentlyProcessedMessageIds.has(messageId)) {
    return;
  }
  recentlyProcessedMessageIds.add(messageId);
  if (recentlyProcessedMessageIds.size > MESSAGE_DEDUP_MAX_SIZE) {
    const oldest = recentlyProcessedMessageIds.values().next().value;
    if (oldest) recentlyProcessedMessageIds.delete(oldest);
  }
}

/** Shared live/recovered RuntimeResponse presentation (persona, chunking and delivery checks). */
async function presentRuntimeReply(channel: Message["channel"], response: RuntimeResponse, speaker: AgentConfig, messageId?: string, localMessageId?: number) {
  const delivery = await sendPresentedReply(channel, response.text, speaker, messageId, undefined, localMessageId);
  ensureReplyDeliverySucceeded(delivery, channel.id);
  return delivery;
}

async function deliverRecoveredLoomReply(record: LoomDelivery, response: RuntimeResponse): Promise<void> {
  if (record.context.transport === "conversation") {
    const existing = storage.getDatabase().prepare("SELECT id FROM messages WHERE conversation_key=? AND reply_to_message_id=? AND direction='outbound' AND author_kind='agent' LIMIT 1").get(record.conversationKey, record.context.requestMessageId ?? null) as { id: number } | undefined;
    const id = recordConversationPost(storage, attachmentDataDir, { localMessageId: existing?.id,
      conversationKey: record.conversationKey, sessionId: record.context.sessionId, agentId: record.agentId,
      source: 'tango', direction: 'outbound', authorKind: 'agent', content: response.text, replyToMessageId: record.context.requestMessageId });
    void nativeMirror.enqueue(record.conversationKey, () => mirrorConversationPost(record.conversationKey, record.agentId, { id, text: response.text, author: 'agent', response })).catch(error => console.warn('[conversation-mirror]', error));
    writeModelRun(recoveredLoomModelRun(record, response, id));
    if (!response.metadata?.error) scheduleStatePostTurn({ ...record.context, turnId: `loom:${record.runId}`, conversationKey: record.conversationKey,
      agentId: record.agentId, userMessage: record.context.prompt, response, channelId: record.channelId, threadId: record.threadId, responseMessageId: id });
    return;
  }
  const channel = await client.channels.fetch(record.threadId ?? record.channelId);
  if (!channel?.isTextBased()) throw new Error("Loom reply channel unavailable");
  const speaker = agentRegistry.get(record.agentId);
  if (!speaker) throw new Error(`Loom reply agent unavailable: ${record.agentId}`);
  const delivery = await presentRuntimeReply(channel as Message["channel"], response, speaker, record.messageId || undefined);
  const responseMessageId = await writeMessage({ sessionId: record.context.sessionId, agentId: record.agentId,
    providerName: "loom", direction: "outbound", source: "tango", visibility: "public",
    discordMessageIds: delivery.messageIds,
    discordMessageId: delivery.lastMessageId ?? null, discordChannelId: channel.id,
    discordUsername: delivery.actualDisplayName, content: response.text,
    metadata: { replyToDiscordMessageId: record.messageId, loomRunId: record.runId } });
  writeModelRun(recoveredLoomModelRun(record, { ...response, model: response.model ?? v2Configs.get(record.agentId)?.runtime.model }, responseMessageId));
  if (!response.metadata?.error) scheduleStatePostTurn({
    ...record.context, turnId: `loom:${record.runId}`, conversationKey: record.conversationKey,
    agentId: record.agentId, userMessage: record.context.prompt, response, channelId: channel.id,
    threadId: record.threadId, responseMessageId, discordRequestMessageId: record.messageId,
    discordResponseMessageId: delivery.lastMessageId,
  });
}

async function recoverPendingLoomReplies(): Promise<void> {
  const reader = new LoomRuntimeAdapter({ conversationKey: "recovery", store: storage });
  // A rolling deployment may still have an older Loom; normal recovery must keep working.
  try {
    await registerDecisionDeliveries({ store: storage, read: () => reader.readDecisionDeliveries(),
      acknowledge: runId => reader.acknowledgeDecisionDelivery(runId), log: message => console.warn(`[tango-discord] ${message}`) });
  } catch (error) { console.warn("[tango-discord] decision delivery registration failed", error); }
  await recoverLoomReplies({ store: storage, readThread: id => reader.readThread(id),
    deliver: deliverRecoveredLoomReply, log: message => console.warn(`[tango-discord] ${message}`) });
}

async function detectOrphanedDiscordMessagesAfterStartup(): Promise<void> {
  const candidates = storage.listRecoverableDiscordInboundMessages({
    maxAgeMinutes: 240,
    limit: 25,
  });
  if (candidates.length === 0) {
    return;
  }

  let flagged = 0;
  let notified = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.discordMessageId && storage.hasLoomDeliveryForMessage(candidate.discordMessageId)) continue;
    const metadata = candidate.metadata && typeof candidate.metadata === "object"
      ? candidate.metadata as Record<string, unknown>
      : null;
    if (metadata?.["listenOnly"] === true) {
      skipped += 1;
      continue;
    }
    if (!candidate.agentId || !candidate.discordChannelId || !candidate.discordMessageId) {
      skipped += 1;
      continue;
    }

    const conversationKey = getConversationKey(candidate.sessionId, candidate.agentId);
    const providerName =
      agentRegistry.get(candidate.agentId)?.provider.default ??
      "codex";
    const deadLetterId = writeDeadLetter({
      sessionId: candidate.sessionId,
      agentId: candidate.agentId,
      providerName,
      conversationKey,
      requestMessageId: candidate.id,
      discordChannelId: candidate.discordChannelId,
      discordUserId: candidate.discordUserId,
      discordUsername: candidate.discordUsername,
      promptText: candidate.content,
      lastErrorMessage: "Message was interrupted by a bot restart before execution began.",
      metadata: {
        recoverySource: "startup-orphan-check",
        originalCreatedAt: candidate.createdAt,
      },
    });
    flagged += 1;

    if (isSmokeTestChannelId(candidate.discordChannelId)) {
      continue;
    }

    const channel = await client.channels.fetch(candidate.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      continue;
    }

    const delivery = await sendPresentedReply(
      channel,
      "I restarted before I could finish your last message. Please send it again.",
      systemSpeaker
    ).catch(() => null);
    if (!delivery) {
      continue;
    }

    await writeMessage({
      sessionId: candidate.sessionId,
      agentId: candidate.agentId,
      providerName,
      direction: "error",
      source: "tango",
      visibility: "public",
      discordMessageIds: delivery.messageIds,
      discordMessageId: delivery.lastMessageId ?? null,
      discordChannelId: candidate.discordChannelId,
      discordUserId: client.user?.id ?? null,
      discordUsername: delivery.actualDisplayName,
      content: "I restarted before I could finish your last message. Please send it again.",
      metadata: {
        replyToDiscordMessageId: candidate.discordMessageId,
        recoverySource: "startup-orphan-check",
        deadLetterId,
      },
    });
    notified += 1;
  }

  console.warn(
    `[tango-discord] startup orphan scan flagged=${flagged} notified=${notified} skipped=${skipped}`
  );
}

client.once("clientReady", async () => {
  if (threadFollowers.enabled && !listenOnly) {
    // Threads started while the bot was down.
    void (async () => {
      for (const guild of client.guilds.cache.values()) {
        const { threads } = await guild.channels.fetchActiveThreads();
        await threadFollowers.catchUp(threads.values());
      }
    })().catch((error) => console.warn(`[thread-followers] catch-up failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  // Desk replies post as the owner only while the guild's members are known: find them in the background.
  if (ownerPersona) {
    const sweepMembers = () => { for (const guild of client.guilds.cache.values()) void refreshGuildMembers(guild); };
    sweepMembers();
    // Every five minutes, so the ten-minute list is always current and a reply never waits for a sweep.
    setInterval(sweepMembers, 5 * 60_000).unref();
  }
  const cwdRelativeConfigDir = path.relative(process.cwd(), configDir) || ".";
  console.log(`[tango-discord] connected as ${client.user?.tag}`);
  console.log(`[tango-discord] listen-only=${listenOnly}`);
  console.log(`[tango-discord] message-content-intent=${enableMessageContent}`);
  console.log(`[tango-discord] claude-command=${env.CLAUDE_CLI_COMMAND}`);
  console.log(`[tango-discord] claude-secondary-command=${env.CLAUDE_SECONDARY_CLI_COMMAND ?? "(unset)"}`);
  console.log(`[tango-discord] claude-harness-command=${env.CLAUDE_HARNESS_COMMAND}`);
  console.log(`[tango-discord] codex-command=${env.CODEX_CLI_COMMAND}`);
  console.log(`[tango-discord] codex-sandbox=${env.CODEX_SANDBOX}`);
  console.log(`[tango-discord] codex-approval-policy=${env.CODEX_APPROVAL_POLICY}`);
  console.log(`[tango-discord] capture-provider-raw=${captureProviderRaw}`);
  console.log(`[tango-discord] provider-timeout-default-ms=${providerTimeoutMs}`);
  console.log(
    `[tango-discord] provider-timeouts-ms=claude:${claudeTimeoutMs},claude-secondary:${claudeSecondaryTimeoutMs},claude-harness:${claudeHarnessTimeoutMs},codex:${codexTimeoutMs}`
  );
  console.log(
    `[tango-discord] provider-default-models=claude:${env.CLAUDE_MODEL},claude-secondary:${env.CLAUDE_SECONDARY_MODEL ?? env.CLAUDE_MODEL},claude-harness:${env.CLAUDE_HARNESS_MODEL ?? env.CLAUDE_MODEL},codex:${env.CODEX_MODEL}`
  );
  console.log(
    `[tango-discord] provider-reasoning-efforts=claude:${env.CLAUDE_EFFORT},claude-secondary:${claudeSecondaryEffort},claude-harness:${claudeHarnessEffort},codex:${env.CODEX_REASONING_EFFORT}`
  );
  console.log(`[tango-discord] provider-retry-limit=${providerRetryLimit}`);
  console.log(`[tango-discord] memory-compaction-trigger-turns=${memoryCompactionTriggerTurns}`);
  console.log(`[tango-discord] memory-compaction-retain-recent-turns=${memoryCompactionRetainRecentTurns}`);
  console.log(`[tango-discord] memory-compaction-summary-max-chars=${memoryCompactionSummaryMaxChars}`);
  console.log(`[tango-discord] providers=${[...providers.keys()].sort().join(",")}`);
  console.log(`[tango-discord] access-default-mode=${defaultAccessMode}`);
  console.log(`[tango-discord] reply-presentation=webhook-preferred system=${systemDisplayName}`);
  console.log(
    `[tango-discord] default-allowlist-channels=${
      defaultAccessPolicy.allowlistChannelIds.size > 0
        ? [...defaultAccessPolicy.allowlistChannelIds].join(",")
        : "(none)"
    }`
  );
  console.log(
    `[tango-discord] default-allowlist-users=${
      defaultAccessPolicy.allowlistUserIds.size > 0
        ? [...defaultAccessPolicy.allowlistUserIds].join(",")
        : "(none)"
    }`
  );
  console.log(`[tango-discord] agent-access-overrides=${agentAccessOverrideCount}`);
  for (const agent of agentConfigs) {
    if (!agent.access) continue;
    const mode = agent.access.mode ?? defaultAccessPolicy.mode;
    const channels =
      agent.access.allowlistChannelIds !== undefined
        ? agent.access.allowlistChannelIds.length
        : defaultAccessPolicy.allowlistChannelIds.size;
    const users =
      agent.access.allowlistUserIds !== undefined
        ? agent.access.allowlistUserIds.length
        : defaultAccessPolicy.allowlistUserIds.size;
    console.log(
      `[tango-discord] agent-access agent=${agent.id} mode=${mode} channels=${channels} users=${users}`
    );
  }
  for (const agent of agentConfigs) {
    const tools = resolveAgentToolPolicy(agent);
    const toolsMode = tools.mode;
    const allowlistCount = tools.allowlist.length;
    console.log(
      `[tango-discord] agent-tools agent=${agent.id} mode=${toolsMode} allowlist=${allowlistCount}`
    );
  }
  const providerOverrides = storage.listSessionProviderOverrides(undefined, 200);
  console.log(`[tango-discord] session-provider-overrides=${providerOverrides.length}`);
  for (const override of providerOverrides) {
    console.log(
      `[tango-discord] session-provider-override session=${override.sessionId} agent=${override.agentId} provider=${override.providerName}`
    );
  }
  console.log(`[tango-discord] command-guild-id=${commandGuildId ?? "global"}`);
  console.log(`[tango-discord] db-path=${dbPath}`);
  console.log(`[tango-discord] config=${cwdRelativeConfigDir}`);
  const recoveredAttachmentJobs = attachmentWorker.recoverStaleLocks();
  attachmentWorker.start();
  console.log(
    `[attachment-worker] started worker=${attachmentWorker.workerId} recovered_stale_jobs=${recoveredAttachmentJobs}`,
  );
  console.log(`[tango-voice] bridge-enabled=${voiceBridgeEnabled}`);
  console.log(
    `[tango-voice] v2-router-agents=${
      voiceV2AgentRuntimeConfigs.size > 0
        ? [...voiceV2AgentRuntimeConfigs.keys()].sort().join(",")
        : "(none)"
    }`
  );
  if (voiceBridgeEnabled) {
    console.log(`[tango-voice] bridge-host=${voiceBridgeHost}`);
    console.log(`[tango-voice] bridge-port=${voiceBridgePort}`);
    console.log(`[tango-voice] bridge-path=${voiceBridgePath}`);
    console.log(`[tango-voice] default-session=${voiceDefaultSessionId ?? "-"}`);
    console.log(`[tango-voice] default-agent=${voiceDefaultAgentId ?? "-"}`);
    console.log(`[tango-voice] api-key=${voiceBridgeApiKey ? "set" : "not-set"}`);
  }
  console.log(`[tango-imessage] enabled=${imessageEnabled}`);
  if (imessageEnabled) {
    console.log(`[tango-imessage] mode=observe (output to Discord, no iMessage replies)`);
    console.log(`[tango-imessage] cli-path=${imessageCliPath}`);
    console.log(`[tango-imessage] contacts-path=${imessageContactsPath ?? "-"}`);
    console.log(`[tango-imessage] discord-channel=${imessageDiscordChannelId ?? "(none — messages logged only)"}`);
    console.log(`[tango-imessage] allow-from=${imessageAllowFrom.length > 0 ? imessageAllowFrom.join(",") : "(all)"}`);
    console.log(`[tango-imessage] group-policy=${imessageGroupPolicy}`);
  }

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("[tango-discord] failed to register slash commands", error);
  }

  if (shouldProvisionSlotMode) {
    const slot = process.env.TANGO_SLOT!;
    const result = await initializeSlotMode({
      client,
      slot,
      agentTestChannels: slotModeAgentTestChannels,
      recordPost: async (post) => {
        const route = sessionManager.route("discord:default");
        if (route) await recordConversationPost(storage, attachmentDataDir, {
          sessionId: route.sessionId, agentId: post.agentId, conversationKey: `thread:${post.channelId}`,
          direction: "system", authorKind: "system", source: "tango", content: post.content,
          discordChannelId: post.channelId, discordMessageId: post.messageId,
        });
      },
      logger: (line) => console.log(`[slot-mode] ${line}`),
    });
    allowedChannels = result.threadIds;
    for (const createdThread of result.created) {
      // Set the focused agent for each test thread so messages route to the
      // correct agent (e.g., Malibu's thread → Malibu, not Watson).
      const threadChannelKey = `discord:${createdThread.threadId}`;
      focusedTextAgentByChannel.set(threadChannelKey, createdThread.agentId);
      // Pre-register the thread session with the correct agent BEFORE any
      // messages arrive. Without this, the first message triggers auto-registration
      // with the default session's agent, which overrides the focused agent and routes to
      // Watson/personal-assistant instead of the intended agent's worker.
      const slotSessionId = `slot-test-${slot}-${createdThread.agentId}`;
      try {
        storage.setThreadSession(createdThread.threadId, slotSessionId, createdThread.agentId);
      } catch (err) {
        console.warn(`[slot-mode] failed to pre-register thread session for ${createdThread.agentId}: ${err instanceof Error ? err.message : err}`);
      }
      console.log(
        `[slot-mode] thread ready: agent=${createdThread.agentId} threadId=${createdThread.threadId} url=${createdThread.url}`,
      );
    }
    for (const failure of result.failures) {
      console.warn(`[slot-mode] failed for agent=${failure.agentId}: ${failure.reason}`);
    }
    console.log(
      `[slot-mode] initialization complete created=${result.created.length} failures=${result.failures.length}`,
    );
    if (result.threadIds.size === 0) {
      console.error("[slot-mode] FATAL: no test threads were created; bot would accept nothing. Shutting down.");
      process.exit(1);
    }
    // Grant per-agent access control access to the smoke-test parent channels so
    // thread-resolved routing (resolveRoutingChannelId returns the parent) passes
    // the default allowlist check. Agents without access overrides share this Set
    // by reference via resolveAccessPolicy, so the mutation propagates immediately.
    for (const agentChannel of slotModeAgentTestChannels) {
      defaultAccessPolicy.allowlistChannelIds.add(agentChannel.channelId);
    }
    console.log(
      `[slot-mode] granted default access allowlist to ${slotModeAgentTestChannels.length} smoke-test parent channels`,
    );
    if (agentAccessOverrideCount > 0) {
      console.warn(
        `[slot-mode] WARNING: ${agentAccessOverrideCount} agents have explicit access overrides; their allowlists will NOT auto-include slot-mode thread parents and may block messages`,
      );
    }
  }

  if (slotModeActive) {
    await applySlotNickname({
      client,
      slot: process.env.TANGO_SLOT!,
      logger: (line) => console.log(`[slot-mode] ${line}`),
    });
  } else {
    await resetBotNickname({
      client,
      nickname: process.env.TANGO_BOT_NICKNAME?.trim() || null,
      logger: (line) => console.log(`[tango-discord] ${line}`),
    });
  }

  // Voice first: rejoining threads (~50 s for a couple hundred), the agent backfill and the
  // orphan scan don't affect voice turns, and every restart kept voice down for their length.
  if (voiceBridge) {
    try {
      await voiceBridge.start();
      console.log(
        `[tango-voice] bridge listening http://${voiceBridgeHost}:${voiceBridgePort}${voiceBridgePath}`
      );
    } catch (error) {
      console.error("[tango-voice] failed to start bridge", error);
    }
  }

  // Join active threads so the bot receives messageCreate events for them.
  // Discord.js only caches threads the bot is a member of; after a restart
  // the bot loses thread membership and silently drops thread messages.
  //
  // Two sources of threads to rejoin:
  // 1. Guild active threads (from Discord API — only recently active threads)
  // 2. Registered thread sessions (from our DB — includes threads that may
  //    have gone idle but still have open conversations)
  try {
    let joinedThreads = 0;
    let alreadyJoined = 0;
    let totalThreads = 0;
    const joinedIds = new Set<string>();

    // Phase 1: Guild active threads
    for (const guild of client.guilds.cache.values()) {
      const activeThreads = await guild.channels.fetchActiveThreads();
      totalThreads += activeThreads.threads.size;
      for (const thread of activeThreads.threads.values()) {
        joinedIds.add(thread.id);
        if (thread.joined) {
          alreadyJoined++;
          continue;
        }
        try {
          await thread.join();
          joinedThreads++;
        } catch (threadError) {
          console.warn(`[tango-discord] failed to join thread ${thread.id}: ${threadError instanceof Error ? threadError.message : threadError}`);
        }
      }
    }

    // Phase 2: DB-registered thread sessions (covers idle/inactive threads)
    const registeredThreadIds = storage.listDiscordThreadSessionIds();
    let dbThreadsJoined = 0;
    for (const threadId of registeredThreadIds) {
      if (joinedIds.has(threadId)) continue;
      try {
        const channel = await client.channels.fetch(threadId).catch(() => null);
        if (channel?.isThread() && !channel.joined) {
          await channel.join();
          dbThreadsJoined++;
        }
      } catch {
        // Thread may be archived or deleted — skip silently
      }
    }

    console.log(
      `[tango-discord] thread-rejoin active=${totalThreads} joined=${joinedThreads} alreadyJoined=${alreadyJoined} dbThreads=${registeredThreadIds.length} dbJoined=${dbThreadsJoined}`
    );
  } catch (error) {
    console.error("[tango-discord] failed to rejoin active threads", error instanceof Error ? error.message : error);
  }

  try {
    await backfillThreadSessionAgents();
  } catch (error) {
    console.error("[tango-discord] thread-agent-backfill failed", error instanceof Error ? error.message : error);
  }

  try {
    setInterval(() => {
      void recoverPendingLoomReplies().catch(error => console.error("[tango-discord] Loom recovery failed", error));
    }, 60_000).unref();
    await recoverPendingLoomReplies();
    await detectOrphanedDiscordMessagesAfterStartup();
  } catch (error) {
    console.error("[tango-discord] startup orphan scan failed", error instanceof Error ? error.message : error);
  }

  if (imessageListener) {
    try {
      await imessageListener.start();
    } catch (error) {
      console.error("[tango-imessage] failed to start listener", error);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (await handleOrientationNudgeInteraction(interaction, {
      db: storage.getDatabase(),
    })) {
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "tango") return;

    await handleTangoCommand(interaction);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error("[tango-discord] interaction failed", messageText);

    if (!interaction.isRepliable()) return;

    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply("I hit an error while executing that command.")
        .catch(() => undefined);
      return;
    }

    await interaction
      .reply({
        content: "I hit an error while executing that command.",
        ephemeral: true
      })
      .catch(() => undefined);
  }
});

/**
 * A background job ended: post its completion notice into the conversation that
 * started it, then run that notice through the normal inbound path as a turn
 * for the owning agent (the intake-webhook route forces the agent and skips
 * user access checks). Queued per channel, so it waits behind a user turn.
 */
async function deliverBackgroundJobCompletion(job: BackgroundJob): Promise<boolean> {
  const targetChannelId = job.threadId ?? job.channelId;
  let channel: Awaited<ReturnType<typeof client.channels.fetch>>;
  try {
    channel = await client.channels.fetch(targetChannelId);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    // 10003 Unknown Channel: the thread is gone, so there is nowhere to report.
    if (code === 10003) {
      console.error(`[background-job] dropping completion id=${job.id}: channel ${targetChannelId} no longer exists`);
      return true;
    }
    throw error;
  }
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.error(`[background-job] dropping completion id=${job.id}: channel ${targetChannelId} is not a text channel`);
    return true;
  }
  const notice = await channel.send({
    content: formatBackgroundJobCompletion(job, Date.now()),
    allowedMentions: { parse: [] },
  });
  const intakeWebhook: IntakeWebhookEntry = {
    webhookId: `background-job:${job.id}`,
    channelId: notice.channelId,
    agentId: job.agentId,
    label: "background-job",
  };
  enqueueChannelWork(`discord:${notice.channelId}`, "background-job", async () => {
    await handleMessage(notice, { intakeWebhook });
  });
  return true;
}

const SCREEN_INPUT_IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A desk reply's images (`{ name, mimeType, dataUrl }`, checked by the desk) as Discord files; anything else is dropped. */
function screenInputFiles(value: unknown): AttachmentBuilder[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry, index) => {
    const { name, mimeType, dataUrl } = (entry ?? {}) as Record<string, unknown>;
    const extension = typeof mimeType === "string" ? SCREEN_INPUT_IMAGE_TYPES[mimeType] : undefined;
    const match = typeof dataUrl === "string" ? /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl) : null;
    if (!extension || !match || match[1] !== mimeType) return [];
    // Discord shows the file name; keep the owner's, minus anything a path or markdown would trip on.
    const base = (typeof name === "string" ? name : "").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `image-${index + 1}`;
    return [new AttachmentBuilder(Buffer.from(match[2]!.replace(/\s/g, ""), "base64"), { name: `${base}.${extension}` })];
  });
}

/**
 * Input on a screen scene (apps/screen) while no voice operator session is live:
 * post it in the conversation that staged the scene and wake that agent, the
 * same way a finished background job does.
 */
/**
 * A new thread with an agent, started from the desk's Start work sheet: a thread in the agent's home
 * channel (a forum post when it's a forum), the owner's words as its first message, and the agent woken
 * to answer there.
 */
/**
 * Desk command id → the thread a start made, and whether its first message went out. A retry with the same
 * id (the desk's answer was lost, or the first message failed) finishes that thread instead of opening another.
 */
const screenStarts = new Map<string, { threadId: string; posted: boolean }>();

async function startScreenThread(input: Record<string, unknown>, agentId: string, channelId: string): Promise<{ delivered: boolean; reason?: string; threadId?: string }> {
  const commandId = typeof input.commandId === "string" ? input.commandId.trim() : "";
  const prior = commandId ? screenStarts.get(commandId) : undefined;
  if (prior?.posted) return { delivered: true, threadId: prior.threadId };
  const remember = (threadId: string, posted: boolean) => {
    if (!commandId) return;
    screenStarts.set(commandId, { threadId, posted });
    if (screenStarts.size > 200) screenStarts.delete(screenStarts.keys().next().value!);
  };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement && channel.type !== ChannelType.GuildForum)) {
    return { delivered: false, reason: `channel ${channelId} can't hold threads` };
  }
  const data = (input.data ?? {}) as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const files = screenInputFiles(data.attachments);
  if (!text && !files.length) return { delivered: false, reason: "say what the thread should work on" };
  const given = typeof data.title === "string" ? data.title.trim() : "";
  const name = (given || text.split("\n")[0] || "New thread").slice(0, 95);
  // Like a desk reply: "🖥️ <words>", as the owner where only they can see it, and the owner's turn.
  const content = deskReplyContent(text.length > 1990 ? `${text.slice(0, 1989)}…` : text);
  let notice: Message;
  let threadId: string;
  if (prior) {
    // Made before, its first message never went out: send it there now.
    const thread = await client.channels.fetch(prior.threadId).catch(() => null);
    if (!thread || !thread.isThread()) return { delivered: false, reason: `thread ${prior.threadId} is gone` };
    notice = (await sendDeskReplyAsOwner(thread, content, files)) ?? await thread.send({ content, allowedMentions: { parse: [] }, ...(files.length ? { files } : {}) });
    threadId = thread.id;
  } else if (channel.type === ChannelType.GuildForum) {
    // A forum post's first message comes with the post, so the bot posts it.
    const post = await channel.threads.create({ name, message: { content, allowedMentions: { parse: [] }, ...(files.length ? { files } : {}) }, reason: "Started from the Tango desk" });
    const starter = await post.fetchStarterMessage();
    if (!starter) return { delivered: false, reason: "the forum post has no first message" };
    notice = starter;
    threadId = post.id;
  } else {
    const thread = await channel.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason: "Started from the Tango desk" });
    remember(thread.id, false);
    notice = (await sendDeskReplyAsOwner(thread, content, files)) ?? await thread.send({ content, allowedMentions: { parse: [] }, ...(files.length ? { files } : {}) });
    threadId = thread.id;
  }
  remember(threadId, true);
  const intakeWebhook: IntakeWebhookEntry = { webhookId: `screen-start:${threadId}`, channelId: threadId, agentId, label: "screen-input" };
  const deskReply = { ownerId: ownerPersona?.discordUserId ?? null, ownerName: ownerPersona?.displayName ?? null, answersMessageId: null, text };
  enqueueChannelWork(`discord:${threadId}`, "screen-input", async () => {
    await handleMessage(notice, { intakeWebhook, deskReply });
  });
  return { delivered: true, threadId };
}

const nativeMirror = new ConversationMirror();
const nativeCommands = new Map<string, { conversationKey: string; delivered: boolean }>();

/** The bridge resolves identity from configuration and persisted ownership, never from client author fields. */
async function deliverConversationInput(input: Record<string, unknown>, discordMessage?: Message): Promise<{ delivered: boolean; reason?: string; conversationKey?: string }> {
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  const config = v2Configs.get(agentId);
  if (!canAcceptConversationInput(config, v2EnabledAgents.has(agentId), agentId, null, true) || !config) return { delivered: false, reason: "agent unavailable" };
  if (discordMessage && storage.findConversationPostByDiscordId(discordMessage.id)) return { delivered: true };
  const data = asRecord(input.data) ?? input;
  const text = input.type === "choice" && typeof input.label === "string"
    ? `On the screen, the owner picked ${input.label}.`
    : typeof data.text === "string" ? deskReplyText(data.text) : "";
  const files = screenInputFiles(data.attachments);
  if (!text && !files.length && !discordMessage?.attachments.size) return { delivered: false, reason: "say something or attach an image" };
  const commandId = typeof input.commandId === "string" ? `${agentId}:${input.commandId}` : "";
  const prior = commandId ? nativeCommands.get(commandId) : undefined;
  if (prior) return prior;
  const db = storage.getDatabase();
  let key = typeof input.conversationKey === "string" ? input.conversationKey : "";
  if (input.type === "start") key = newConversationKey();
  else if (!key && typeof input.channelId === "string") {
    const found = db.prepare('SELECT conversation_key FROM conversations WHERE agent_id=? AND (discord_thread_id=? OR (discord_thread_id IS NULL AND discord_channel_id=?))').get(agentId, input.channelId, input.channelId) as { conversation_key: string } | undefined;
    key = found?.conversation_key ?? "";
  }
  if (!CONVERSATION_KEY.test(key)) return { delivered: false, reason: "invalid conversation" };
  const conversation = db.prepare('SELECT * FROM conversations WHERE conversation_key=?').get(key) as { agent_id: string; discord_channel_id: string | null; discord_thread_id: string | null; title: string } | undefined;
  if (!canAcceptConversationInput(config, v2EnabledAgents.has(agentId), agentId, conversation?.agent_id, input.type === "start")) return { delivered: false, reason: "conversation unavailable" };
  const answer = typeof input.replyToMessageId === "string" ? input.replyToMessageId : "";
  const localAnswer = typeof input.replyToMessageId === "number" && Number.isSafeInteger(input.replyToMessageId) && input.replyToMessageId > 0
    ? input.replyToMessageId : /^tango:\d+$/.test(answer) ? Number(answer.slice(6)) : storage.findConversationPostByDiscordId(answer);
  if (localAnswer && !db.prepare('SELECT 1 FROM messages WHERE id=? AND conversation_key=?').get(localAnswer, key)) return { delivered: false, reason: "reply belongs to another conversation" };
  const sessionId = key.startsWith('conv:') ? key : conversation?.discord_thread_id ? storage.getThreadSession(conversation.discord_thread_id)?.sessionId ?? key
    : key.startsWith('channel:') ? sessionManager.route(`discord:${key.slice(8)}`)?.sessionId ?? key : key;
  upsertSessionForRoute({ sessionId, agentId }, key);
  const title = typeof data.title === "string" ? data.title.slice(0, 95) : text.split('\n')[0]!.slice(0, 95);
  // Reserve before acknowledging. The queue records the inbound post before executing the runtime.
  db.prepare(`INSERT OR IGNORE INTO conversations (conversation_key,agent_id,kind,title,origin,created_at) VALUES (?,?,'thread',?,?,datetime('now'))`).run(key, agentId, title, input.origin === 'voice' ? 'voice' : 'desk');
  const result = { delivered: true, conversationKey: key };
  if (commandId) { nativeCommands.set(commandId, result); if (nativeCommands.size > 500) nativeCommands.delete(nativeCommands.keys().next().value!); }
  if (!files.length && !discordMessage?.attachments.size
    && pendingLoomRetry(storage.listPendingLoomDeliveries(), { conversationKey: key }, text)) {
    recordConversationPost(storage, attachmentDataDir, { conversationKey: key, sessionId, agentId,
      direction: 'outbound', source: 'tango', authorKind: 'system', content: LOOM_PENDING_NOTICE });
    return result;
  }
  const queueKey = key.startsWith('conv:') ? key : `discord:${key.split(':')[1]}`;
  enqueueChannelWork(queueKey, 'conversation-turn', async () => {
    const attachments: PostAttachment[] = discordMessage ? [...discordMessage.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType, size: a.size })) : [];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-conversation-'));
    try {
      for (const [index, file] of files.entries()) {
        const filePath = path.join(directory, String(index));
        fs.writeFileSync(filePath, file.attachment as Buffer, { mode: 0o600 });
        attachments.push({ name: file.name ?? `image-${index}`, filePath, contentType: (data.attachments as { mimeType: string }[])[index]?.mimeType });
      }
      const channelId = conversation?.discord_channel_id ?? '';
      const threadId = conversation?.discord_thread_id ?? undefined;
      const turn = startDeskTurn({ agentId, conversationKey: key, channelId, threadId });
      let inbound: number | undefined;
      let ownedRun: string | undefined;
      try {
        const completed = await runConversationTurn({ conversationKey: key, agentId, sessionId, text, attachments,
          author: { kind: text.startsWith('✉️ ') ? 'requester' : 'owner', id: discordMessage?.author.id, name: discordMessage?.author.username }, origin: discordMessage ? 'discord' : input.origin === 'voice' ? 'voice' : 'desk', title,
          discordMessageId: discordMessage?.id,
          channelId: channelId || undefined, threadId, replyToMessageId: localAnswer,
        }, { storage, dataDir: attachmentDataDir,
          route: async (messageId) => {
            inbound = messageId;
            const row = db.prepare('SELECT attachments FROM messages WHERE id=?').get(messageId) as { attachments: string };
            const local = JSON.parse(row.attachments) as PostAttachment[];
            const prompt = [text, ...local.filter(a => a.localPath).map(a => `Attached ${a.name}: ${path.join(attachmentDataDir, a.localPath!)}`)].join('\n');
            const warm = await buildWarmStartContext({ sessionId, agentId, conversationKey: key, currentUserPrompt: prompt,
              orchestratorContinuityMode: resolveOrchestratorContinuityModeForAgent(agentId, sessionId),
              discordChannelId: channelId, discordThreadId: threadId });
            const pointer = buildStateFilePointer(storage, key, { vaultRoot: resolveStateVaultRoot(), profileRoot: resolveStateProfileRoot() });
            const pendingSave = matchesPendingSessionSave(storage.getPendingSessionSave(key), { agentId });
            const context = buildSendContextWithOptionalSavePass(warm.prompt, pendingSave);
            const routed = await routeV2MessageIfEnabled({ message: prompt, channelId, threadId, conversationKey: key,
              messageId: String(messageId), occurredAt: new Date().toISOString(), agentId,
              sendOptions: { onEvent: turn.onEvent, ...(context ? { context } : {}),
                turnBriefingPrompt: buildTurnBriefingPrompt({ ...(pointer ? { stateFile: pointer } : {}), stateDigest: buildStateDigest(key, agentId) }),
                currentTurnMetadataPrompt: buildCurrentTurnMetadataPrompt({ timestamp: new Date(), timestampSource: "runtime-received", config: config.currentTurnMetadata }),
                onLoomSubmitted: runId => { ownedRun = runId; },
                discordDelivery: { channelId, threadId, messageId: `local:${messageId}`, context: {
                  transport: 'conversation', sessionId, prompt, retryText: text, requestMessageId: messageId, occurredAt: new Date().toISOString() } },
                images: isOllamaBackedAgent(config) ? local.filter(a => a.localPath && a.contentType?.startsWith('image/')).map(a => ({
                  dataBase64: fs.readFileSync(path.join(attachmentDataDir, a.localPath!)).toString('base64'), mediaType: a.contentType! })) : undefined,
              },
            }, { v2EnabledAgents, tangoRouter, recoverFromRuntimeFailure: recoverV2RuntimeFailure });
            if (!routed) throw new Error('Agent runtime unavailable');
            if (pendingSave && !routed.response.metadata?.error) storage.deletePendingSessionSave(key);
            if (isOllamaBackedAgent(config)) routed.response = { ...routed.response, text: coerceWorkerReplyForDisplay(routed.response.text) };
            return routed;
          },
          mirror: post => nativeMirror.enqueue(key, () => mirrorConversationPost(key, agentId, post)),
          mirrorError: error => console.warn('[conversation-mirror]', error),
        });
        if (ownedRun && storage.claimLoomDelivery(ownedRun)) storage.finishLoomDelivery(ownedRun, 'delivered');
        if (completed) scheduleStatePostTurn({ ...completed, sessionId, userMessage: text, channelId, threadId,
          requestMessageId: completed.messageId, responseMessageId: completed.responseMessageId });
        turn.finish();
      } catch (error) {
        if (ownedRun && isRuntimeAbortedError(error)) {
          if (storage.claimLoomDelivery(ownedRun)) storage.finishLoomDelivery(ownedRun, 'abandoned');
          turn.finish(); return;
        }
        if (ownedRun && error instanceof LoomPendingError) {
          recordConversationPost(storage, attachmentDataDir, { conversationKey: key, sessionId, agentId,
            direction: 'outbound', source: 'tango', authorKind: 'system', content: LOOM_PENDING_NOTICE, replyToMessageId: inbound });
          turn.finish(); return;
        }
        turn.fail(error);
        writeDeadLetter({ sessionId, agentId, providerName: agentRegistry.get(agentId)?.provider.default ?? 'codex',
          conversationKey: key, requestMessageId: inbound, promptText: text, lastErrorMessage: String(error) });
        recordConversationPost(storage, attachmentDataDir, { conversationKey: key, sessionId, agentId,
          direction: 'outbound', source: 'tango', authorKind: 'system', content: LOOM_FAILURE_NOTICE, replyToMessageId: inbound });
      } finally { if (ownedRun) liveLoomDeliveries.delete(ownedRun); }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  return result;
}

async function mirrorConversationPost(key: string, agentId: string, post: { id: number; text: string; author: 'owner' | 'agent'; response?: RuntimeResponse }): Promise<void> {
  const config = v2Configs.get(agentId)!;
  if (!mirrorsPosts(config.discordMirror)) return;
  const db = storage.getDatabase();
  const conversation = db.prepare('SELECT * FROM conversations WHERE conversation_key=?').get(key) as { title: string; discord_channel_id: string | null; discord_thread_id: string | null };

  const chunks = splitForDiscord(post.author === 'owner' ? deskReplyContent(post.text) : post.text);
  const stored = db.prepare('SELECT attachments FROM messages WHERE id=?').get(post.id) as { attachments: string };
  const files = (JSON.parse(stored.attachments) as PostAttachment[]).filter(a => a.localPath).map(a => new AttachmentBuilder(path.join(attachmentDataDir, a.localPath!), { name: a.name }));
  const destination = await ensureConversationMirror(storage, key, async () => {
    const home = await client.channels.fetch(config.discord.defaultChannelId);
    if (!home || !('threads' in home)) throw new Error('Mirror home unavailable');
    const name = conversation.title || 'Conversation';
    const thread = home.type === ChannelType.GuildForum
      ? await home.threads.create({ name, message: { content: chunks[0] || 'Attachment', files, allowedMentions: { parse: [] } } })
      : await (home as TextChannel).threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    return { channelId: home.id, threadId: thread.id, starter: home.type === ChannelType.GuildForum ? await thread.fetchStarterMessage() : null };
  });
  const channelId = destination.threadId ?? destination.channelId;
  const starter = destination.starter;
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !('send' in channel)) throw new Error('Mirror channel unavailable');
  await conversationDeliveries.run(channelId, async () => {
    const ids: string[] = starter ? [starter.id] : [];
    if (post.author === 'agent' && !starter) {
      ids.push(...((await presentRuntimeReply(channel, post.response ?? { text: post.text, durationMs: 0 }, agentRegistry.get(agentId) ?? systemSpeaker!, undefined, post.id)).messageIds ?? []));
    } else {
      for (const [index, content] of chunks.entries()) {
        if (starter && index === 0) continue;
        ids.push((await channel.send({ content, ...(index === 0 ? { files } : {}), allowedMentions: { parse: [] } })).id);
      }
    }
    const row = db.prepare('SELECT discord_message_ids FROM messages WHERE id=?').get(post.id) as { discord_message_ids: string };
    db.prepare('UPDATE messages SET discord_message_ids=?,discord_message_id=? WHERE id=?').run(JSON.stringify([...new Set([...JSON.parse(row.discord_message_ids), ...ids])]), ids.at(-1) ?? null, post.id);
    for (const id of ids) db.prepare('INSERT OR IGNORE INTO conversation_discord_messages VALUES (?,?)').run(id, post.id);
  });
}

async function deliverScreenInput(input: Record<string, unknown>): Promise<{ delivered: boolean; reason?: string; threadId?: string; conversationKey?: string }> {
  if (process.env.TANGO_CONVERSATION_SOURCE === "tango") return deliverConversationInput(input);
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  const channelId = typeof input.channelId === "string" ? input.channelId.trim() : "";
  if (!agentId || !channelId) return { delivered: false, reason: "agentId and channelId are required" };
  if (input.type === "start") return startScreenThread(input, agentId, channelId);
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    return { delivered: false, reason: `channel ${channelId} is not available` };
  }
  const title = typeof input.sceneTitle === "string" && input.sceneTitle.trim() ? input.sceneTitle.trim() : "your scene";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const type = typeof input.type === "string" ? input.type : "input";
  const data = (input.data ?? {}) as Record<string, unknown>;
  const replyText = type === "reply" && typeof data.text === "string" ? data.text.trim() : "";
  if (type === "reply" && !replyText.startsWith("✉️ ")) return deliverDeskReply(input, agentId, channel, data);
  // A desk reply's images: posted as files on the notice, so handleMessage picks them up like any image the owner drops in.
  const files = type === "reply" ? screenInputFiles(data.attachments) : [];
  // Every relayed post starts with 🖥️: the screen's inbox reads these as the owner's own words.
  const content = type === "choice" && label
    ? `🖥️ On the screen, the owner picked **${label}** on "${title}".`
    : replyText.startsWith("✉️ ")
      // Desk mail from another agent's conversation: its own header says who sent it, so no "the owner replied" wrapper.
      ? `🖥️ ${replyText.slice(0, 1800)}`
      : `🖥️ Screen input on "${title}": \`${type}\` ${JSON.stringify(data).slice(0, 800)}`;
  const notice = await channel.send({ content, allowedMentions: { parse: [] }, ...(files.length ? { files } : {}) });
  const intakeWebhook: IntakeWebhookEntry = {
    webhookId: `screen-input:${String(input.sceneId ?? "scene")}`,
    channelId: notice.channelId,
    agentId,
    label: "screen-input",
  };
  enqueueChannelWork(`discord:${notice.channelId}`, "screen-input", async () => {
    await handleMessage(notice, { intakeWebhook });
  });
  return { delivered: true };
}

/** Desk command id → its delivery: a repeat of the same command (its answer was lost) gets that, not a second post. */
const deskReplies = new Map<string, Promise<{ delivered: boolean; reason?: string }>>();
const ownerAccountIds = new Set(ownerPersona ? [ownerPersona.discordUserId, ...ownerPersona.otherDiscordUserIds] : []);
/** Channel id → the "Tango Desk" webhook desk replies post through. */
const deskWebhooks = new Map<string, Promise<Webhook | null>>();
const DESK_WEBHOOK_NAME = "Tango Desk";
const DISCORD_ID = /^\d{5,25}$/;

async function deskWebhook(base: TextChannel | NewsChannel | ForumChannel): Promise<Webhook | null> {
  let found = deskWebhooks.get(base.id);
  if (!found) {
    found = (async () => {
      const existing = (await base.fetchWebhooks()).find((hook) => hook.name === DESK_WEBHOOK_NAME && Boolean(hook.token));
      const webhook = existing ?? (await base.createWebhook({ name: DESK_WEBHOOK_NAME, reason: "Desk replies post as the owner" }));
      conversationWebhookIds.add(webhook.id);
      return webhook;
    })().catch((error) => {
      deskWebhooks.delete(base.id);
      console.warn(`[screen-input] desk webhook unavailable channel=${base.id}: ${error instanceof Error ? error.message : error}`);
      return null;
    });
    deskWebhooks.set(base.id, found);
  }
  return found;
}

/**
 * Posts a desk reply under the owner's name and picture: only with an owner.yaml, and only in a channel
 * nobody but the owner can see. Null means post it as the bot instead.
 */
async function sendDeskReplyAsOwner(channel: SendableChannels, content: string, files: AttachmentBuilder[]): Promise<Message | null> {
  if (!ownerPersona) return null;
  const thread = channel.isThread() ? channel : null;
  const base = thread ? thread.parent : channel;
  if (!base || (base.type !== ChannelType.GuildText && base.type !== ChannelType.GuildAnnouncement && base.type !== ChannelType.GuildForum)) return null;
  try {
    // The count as of now (one cheap call): a member list that no longer adds up isn't trusted.
    const memberCount = (await client.guilds.fetch({ guild: base.guildId, withCounts: true, force: true })).approximateMemberCount;
    if (memberCount === null || !(await isOwnerOnlyChannel<GuildMember>(base, ownerAccountIds, memberCount))) return null;
    const webhook = await deskWebhook(base);
    if (!webhook) return null;
    const avatarURL = ownerPersona.avatarUrl ?? (await client.users.fetch(ownerPersona.discordUserId)).displayAvatarURL();
    return await webhook.send({
      content,
      username: ownerPersona.displayName,
      avatarURL,
      allowedMentions: { parse: [] },
      ...(thread ? { threadId: thread.id } : {}),
      ...(files.length ? { files } : {}),
    });
  } catch (error) {
    deskWebhooks.delete(base.id);
    console.warn(`[screen-input] desk reply as the owner failed channel=${channel.id}; posting as the bot: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * The owner's reply from the desk: "🖥️ <their words>" in the channel (as them where that's private),
 * answering the agent's message when the desk says which, and a turn for the agent recorded as theirs.
 */
function deliverDeskReply(
  input: Record<string, unknown>,
  agentId: string,
  channel: SendableChannels,
  data: Record<string, unknown>,
): Promise<{ delivered: boolean; reason?: string }> {
  const commandId = typeof input.commandId === "string" ? input.commandId.trim() : "";
  if (!commandId) return postDeskReply(input, agentId, channel, data);
  const prior = deskReplies.get(commandId);
  if (prior) return prior;
  const delivery = postDeskReply(input, agentId, channel, data);
  deskReplies.set(commandId, delivery);
  if (deskReplies.size > 500) deskReplies.delete(deskReplies.keys().next().value!);
  // Not posted (or it threw): a repeat may try again.
  delivery.then((result) => { if (!result.delivered) deskReplies.delete(commandId); }, () => deskReplies.delete(commandId));
  return delivery;
}

async function postDeskReply(
  input: Record<string, unknown>,
  agentId: string,
  channel: SendableChannels,
  data: Record<string, unknown>,
): Promise<{ delivered: boolean; reason?: string }> {
  // Words only: a re-send of text read back from Discord may still carry the old wrapper.
  const text = deskReplyText(typeof data.text === "string" ? data.text : "");
  const files = screenInputFiles(data.attachments);
  if (!text && !files.length) return { delivered: false, reason: "say something or attach an image" };
  const answers = typeof input.replyToMessageId === "string" && DISCORD_ID.test(input.replyToMessageId.trim()) ? input.replyToMessageId.trim() : null;
  const content = deskReplyContent(text.length > 1990 ? `${text.slice(0, 1989)}…` : text);
  const notice = (await sendDeskReplyAsOwner(channel, content, files))
    ?? (await channel.send({
      content,
      allowedMentions: { parse: [] },
      ...(answers ? { reply: { messageReference: answers, failIfNotExists: false } } : {}),
      ...(files.length ? { files } : {}),
    }));
  const intakeWebhook: IntakeWebhookEntry = {
    webhookId: `screen-input:${String(input.sceneId ?? "scene")}`,
    channelId: notice.channelId,
    agentId,
    label: "screen-input",
  };
  const deskReply = { ownerId: ownerPersona?.discordUserId ?? null, ownerName: ownerPersona?.displayName ?? null, answersMessageId: answers, text };
  enqueueChannelWork(`discord:${notice.channelId}`, "screen-input", async () => {
    await handleMessage(notice, { intakeWebhook, deskReply });
  });
  return { delivered: true };
}

function enqueueChannelWork(
  channelKey: string,
  logPrefix: string,
  work: () => Promise<void>,
): void {
  const queuedWork = channelQueues.get(channelKey) ?? Promise.resolve();
  const nextWork = queuedWork
    .then(async () => {
      await work();
    })
    .catch((error) => {
      console.error(`[${logPrefix}] unhandled channel work error`, error);
    })
    .finally(() => {
      if (channelQueues.get(channelKey) === nextWork) {
        channelQueues.delete(channelKey);
      }
    });
  channelQueues.set(channelKey, nextWork);
}

// Guard against duplicate messageCreate events for the same Discord message.
// Discord.js can fire the event twice (~3-4% of messages), causing double processing
// that corrupts --resume sessions and leaks raw <worker-dispatch> tags to Discord.
const recentlyProcessedMessageIds = new Set<string>();
const MESSAGE_DEDUP_MAX_SIZE = 200;

client.on("messageCreate", async (message) => {
  const intakeWebhook = resolveIntakeWebhookMessage(
    message,
    intakeWebhookEntries,
    loadReplyWebhookIds(),
  );
  if (!intakeWebhook && !isChannelAllowed(message.channelId, allowedChannels)) return;

  // Voice-synced user messages are posted via webhook (bot=true) but prefixed with ZWS.
  const isVoiceUserSync = (message.author.bot || !!message.webhookId) && message.content.startsWith('\u200B');
  if (isVoiceUserSync) {
    return; // Voice-user-synced transcripts don't need further processing
  }

  const isSmokeTestWebhookInput = isSmokeTestThreadWebhookMessage(message, smokeTestChannelIds);
  if ((message.author.bot || message.webhookId) && !isSmokeTestWebhookInput && !intakeWebhook) {
    if (!isOwnConversationPost(message, client.user?.id, conversationWebhookIds)) return;
    // Tool posts bypass reply presentation. Wait for an in-flight full-text writer before fallback capture.
    await nativeMirror.settled();
    await conversationDeliveries.settled(message.channelId);
    if ((message.type === MessageType.Default || message.type === MessageType.Reply)
      && !storage.findConversationPostByDiscordId(message.id)) {
      const routingId = message.channel.isThread() ? message.channel.parentId ?? message.channelId : message.channelId;
      const route = sessionManager.route(`discord:${routingId}`);
      if (route) await writeMessage({ sessionId: storage.getThreadSession(message.channelId)?.sessionId ?? route.sessionId,
        agentId: route.agentId, direction: "outbound", source: "tango", content: message.content,
        discordChannelId: message.channelId, discordMessageId: message.id,
        discordUserId: message.author.id, discordUsername: message.author.username,
        metadata: { attachments: attachmentsForMetadata(message) },
      });
    }
    return;
  }
  // Ignore system messages (thread created, pin, member join, etc.)
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;

  if (recentlyProcessedMessageIds.has(message.id)) {
    console.warn(`[tango-discord] duplicate messageCreate suppressed id=${message.id}`);
    return;
  }
  rememberProcessedMessageId(message.id);

  const pendingRetry = message.attachments.size === 0
    ? pendingLoomRetry(storage.listPendingLoomDeliveries(), message.channelId, message.content) : undefined;
  if (pendingRetry) {
    const routingChannelId = resolveRoutingChannelId(message);
    await sendPendingLoomRetryNotice({
      agent: agentRegistry.get(pendingRetry.agentId),
      defaults: defaultAccessPolicy,
      access: {
        channelId: routingChannelId,
        threadChannelId: message.channelId !== routingChannelId ? message.channelId : undefined,
        userId: message.author.id,
        mentioned: hasMentionForBot(message),
      },
      send: text => sendPresentedReply(message.channel, text, systemSpeaker),
    }).catch(error => console.warn("[tango-discord] pending retry notice failed", error));
    return;
  }

  // Use message.channelId (thread ID for threads) as queue key so forum threads
  // process concurrently. handleMessage computes its own routing channelKey internally.
  const queueKey = `discord:${message.channelId}`;
  enqueueChannelWork(queueKey, "tango-discord", async () => {
    try {
      await handleMessage(message, { intakeWebhook });
    } catch (error) {
      if (isRuntimeAbortedError(error)) {
        return;
      }
      const errorText = error instanceof Error ? error.message : String(error);
      const deadLetterId = recordUnhandledDiscordTurnFailure(message, errorText);
      console.error(
        `[tango-discord] handleMessage failed for ${message.author.username} in ${message.channelId}: ${errorText}`
        + (deadLetterId ? ` dead_letter_id=${deadLetterId}` : "")
      );
      try {
        await sendPresentedReply(message.channel, LOOM_FAILURE_NOTICE, systemSpeaker);
      } catch (replyError) {
        console.error(`[tango-discord] failed to send error reply:`, replyError instanceof Error ? replyError.message : replyError);
      }
    }
  });
});

client.on("threadCreate", async (thread, newlyCreated) => {
  if (!newlyCreated || listenOnly || !threadFollowers.enabled) return;
  await threadFollowers.onCreated(thread);
});

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    // Ensure reaction is fully fetched (partials)
    if (reaction.partial) await reaction.fetch();

    const channelId = reaction.message.channelId;
    const messageId = reaction.message.id;

    const storedTarget = findStoredMessageForDiscordTarget({
      discordMessageId: messageId,
      discordChannelId: channelId,
      fallbackContent: reaction.message.content ?? "",
    });
    const isTangoAuthoredMessage =
      Boolean(reaction.message.webhookId) ||
      reaction.message.author?.id === client.user?.id ||
      storedTarget?.source === "tango";
    const referentContent = storedTarget?.content?.trim() || (reaction.message.content ?? "").trim();
    if (isTangoAuthoredMessage && referentContent.length > 0) {
      storage.upsertChannelReferent({
        channelId,
        discordUserId: user.id,
        kind: "reaction",
        targetMessageId: messageId,
        targetSessionId: storedTarget?.sessionId ?? null,
        targetAgentId: storedTarget?.agentId ?? null,
        targetDirection: storedTarget?.direction ?? null,
        targetSource: storedTarget?.source ?? "tango",
        targetContent: referentContent,
        metadata: {
          emoji: reaction.emoji.name ?? null,
          storedMessageId: storedTarget?.id ?? null,
          webhookId: reaction.message.webhookId ?? null,
        },
      });
    }
  } catch (error) {
    console.warn(`[tango-discord] reaction referent failed: ${error instanceof Error ? error.message : error}`);
  }
});

client.login(env.DISCORD_TOKEN).catch((error) => {
  console.error("[tango-discord] login failed", error);
  process.exit(1);
});

let isShuttingDown = false;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[tango] shutting down signal=${signal}`);
  void (async () => {
    try {
      if (scheduler) {
        scheduler.stop();
      }
    } catch (error) {
      console.error("[tango] scheduler shutdown failed", error);
    }
    try {
      await attachmentWorker.stop();
    } catch (error) {
      console.error("[attachment-worker] shutdown failed", error);
    }
    try {
      if (voiceBridge) {
        await voiceBridge.stop();
      }
    } catch (error) {
      console.error("[tango-voice] bridge shutdown failed", error);
    }
    try {
      if (voiceTangoRouter) {
        await voiceTangoRouter.shutdown();
      }
    } catch (error) {
      console.error("[tango-voice] router shutdown failed", error);
    }
    try {
      if (imessageListener) {
        await imessageListener.stop();
      }
    } catch (error) {
      console.error("[tango-imessage] listener shutdown failed", error);
    }
    try {
      stateObsidianAdapter.stop();
      await stateHealthAdapter.close();
    } catch (error) {
      console.error("[tango-state] adapter shutdown failed", error);
    }
    try {
      await stateHttpServer.stop();
    } catch (error) {
      console.error("[tango-state] HTTP server shutdown failed", error);
    }
    try {
      await shutdownV2Runtime({
        tangoRouter,
        atlasMemoryClient,
      });
    } catch (error) {
      console.error("[tango] v2 runtime shutdown failed", error);
    } finally {
      await settleConversationAttachments(storage);
      storage.close();
      process.exit(0);
    }
  })();
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
