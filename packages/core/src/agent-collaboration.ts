import { z } from "zod";
import type { RuntimeResponse, SendOptions } from "./agent-runtime.js";
import type {
  AgentCollaborationSessionRecord,
  AgentCollaborationStatus,
  AgentCollaborationTurnType,
  AgentCollaborationVisibilityMode,
  TangoStorage,
} from "./storage.js";
import type { V2AgentConfig, V2AgentResponsibilityConfig } from "./v2-config-loader.js";
import { isV2RuntimeEnabled } from "./v2-config-loader.js";

const DEFAULT_MAX_TURNS = 1;
const DEFAULT_MAX_DURATION_SECONDS = 120;
const DEFAULT_MAX_TOOL_CALLS = 5;
const DEFAULT_MAX_DEPTH = 1;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

export interface AgentCollaborationBudget {
  maxTurns: number;
  maxDurationSeconds: number;
  maxToolCalls: number;
}

export interface AgentCollaborationDeliverableContract {
  format?: string;
  requiredFields?: string[];
  maxWords?: number;
}

export interface AgentCollaborationRequest {
  requesterAgentId: string;
  targetAgentId: string;
  purpose: string;
  objective: string;
  contextSummary?: string;
  deliverable?: AgentCollaborationDeliverableContract;
  constraints?: string[];
  visibility?: AgentCollaborationVisibilityMode;
  budget?: Partial<AgentCollaborationBudget>;
  initiatorKind?: "user" | "agent" | "schedule" | "system";
  initiatorRef?: string;
  parentCollaborationId?: string;
  parentDepth?: number;
  userSurface?: Record<string, unknown>;
}

export interface AgentCollaborationPolicyDecision {
  granted: boolean;
  reason: string;
  effectiveBudget: AgentCollaborationBudget;
  visibilityMode: AgentCollaborationVisibilityMode;
  requesterResponsibilityId?: string;
  targetResponsibilityId?: string;
}

/** A concrete outbound collaboration route declared by an agent. */
export interface AgentCollaborationRoute {
  targetAgentId: string;
  purposes: string[];
}

export interface AgentCollaborationTargetInvocation {
  collaborationId: string;
  requesterAgentId: string;
  targetAgentId: string;
  purpose: string;
  objective: string;
  message: string;
  conversationKey: string;
  timeoutMs: number;
  sendOptions?: SendOptions;
}

export type AgentCollaborationTargetInvoker =
  (input: AgentCollaborationTargetInvocation) => Promise<RuntimeResponse>;

export type AgentCollaborationPresentationEventKind =
  | "started"
  | "completed"
  | "waiting_on_user"
  | "failed";

/**
 * A runtime-specific observer for collaboration lifecycle presentation. Core
 * owns the durable collaboration record; a surface adapter may publish a
 * bounded, user-visible trace without coupling this service to Discord.
 */
export interface AgentCollaborationPresentationEvent {
  kind: AgentCollaborationPresentationEventKind;
  session: AgentCollaborationSessionRecord;
  answer?: string;
  error?: string;
}

export type AgentCollaborationPresentationObserver =
  (event: AgentCollaborationPresentationEvent) => Promise<void> | void;

export interface AgentCollaborationServiceOptions {
  storage: Pick<
    TangoStorage,
    | "insertAgentCollaborationSession"
    | "updateAgentCollaborationSession"
    | "getAgentCollaborationSession"
    | "findRecentAgentCollaborationSession"
    | "findActiveInboundAgentCollaborationSession"
    | "insertAgentCollaborationTurn"
  >;
  v2Configs: ReadonlyMap<string, V2AgentConfig>;
  invokeTarget?: AgentCollaborationTargetInvoker;
  presentationObserver?: AgentCollaborationPresentationObserver;
  now?: () => Date;
}

export interface AgentCollaborationResult {
  collaborationId: string;
  status: AgentCollaborationStatus;
  duplicateOf?: string;
  answer?: string;
  evidence?: unknown[];
  actionsTaken?: string[];
  actionsNotTaken?: string[];
  needsUser?: boolean;
  error?: string;
  /** Concrete routes the requester may use when a request is denied. */
  availableRoutes?: AgentCollaborationRoute[];
  policyDecision: AgentCollaborationPolicyDecision;
}

const deliverableSchema = z.object({
  format: z.string().min(1).optional(),
  required_fields: z.array(z.string().min(1)).optional(),
  requiredFields: z.array(z.string().min(1)).optional(),
  max_words: z.number().int().positive().optional(),
  maxWords: z.number().int().positive().optional(),
}).passthrough();

const budgetSchema = z.object({
  max_turns: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  max_duration_seconds: z.number().int().positive().optional(),
  maxDurationSeconds: z.number().int().positive().optional(),
  max_tool_calls: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
}).passthrough();

const requestSchema = z.object({
  requester_agent_id: z.string().min(1).optional(),
  requesterAgentId: z.string().min(1).optional(),
  target_agent_id: z.string().min(1).optional(),
  targetAgentId: z.string().min(1).optional(),
  purpose: z.string().min(1),
  objective: z.string().min(1),
  context_summary: z.string().optional(),
  contextSummary: z.string().optional(),
  deliverable: deliverableSchema.optional(),
  constraints: z.array(z.string().min(1)).optional(),
  visibility: z.enum(["summary", "digest", "thread", "transcript", "silent"]).optional(),
  budget: budgetSchema.optional(),
  initiator_kind: z.enum(["user", "agent", "schedule", "system"]).optional(),
  initiatorKind: z.enum(["user", "agent", "schedule", "system"]).optional(),
  initiator_ref: z.string().optional(),
  initiatorRef: z.string().optional(),
  parent_collaboration_id: z.string().optional(),
  parentCollaborationId: z.string().optional(),
  parent_depth: z.number().int().min(0).optional(),
  parentDepth: z.number().int().min(0).optional(),
  user_surface: z.record(z.unknown()).optional(),
  userSurface: z.record(z.unknown()).optional(),
}).passthrough();

type CollaborationRequestGrant = {
  agent: string;
  purposes: string[];
};

type CollaborationFulfillmentGrant = {
  purpose: string;
  maxTurns?: number;
  maxDurationSeconds?: number;
  maxToolCalls?: number;
  visibilityModes?: AgentCollaborationVisibilityMode[];
};

function normalizeIdentifier(value: string): string {
  return value.trim();
}

export function normalizeCollaborationObjective(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ").slice(0, 500);
}

function matchesConfiguredValue(candidate: string, configured: string): boolean {
  return configured === "*" || configured.trim() === candidate;
}

function includesPurpose(purposes: readonly string[] | undefined, purpose: string): boolean {
  return (purposes ?? []).some((candidate) => matchesConfiguredValue(purpose, candidate));
}

function findRequestGrant(
  requesterConfig: V2AgentConfig | undefined,
  targetAgentId: string,
  purpose: string,
): { responsibility: V2AgentResponsibilityConfig; grant: CollaborationRequestGrant } | null {
  for (const responsibility of requesterConfig?.responsibilities ?? []) {
    for (const grant of responsibility.collaboration?.canRequest ?? []) {
      if (matchesConfiguredValue(targetAgentId, grant.agent) && includesPurpose(grant.purposes, purpose)) {
        return { responsibility, grant };
      }
    }
  }
  return null;
}

function findFulfillmentGrant(
  targetConfig: V2AgentConfig | undefined,
  purpose: string,
): { responsibility: V2AgentResponsibilityConfig; grant: CollaborationFulfillmentGrant } | null {
  for (const responsibility of targetConfig?.responsibilities ?? []) {
    for (const grant of responsibility.collaboration?.canFulfill ?? []) {
      if (matchesConfiguredValue(purpose, grant.purpose)) {
        return { responsibility, grant };
      }
    }
  }
  return null;
}

/**
 * Return the requester's concrete configured destinations and purposes. This
 * is intentionally a view of the configuration, not an authorization result:
 * the collaboration service remains the final policy gate for every request.
 */
export function listAgentCollaborationRoutes(
  requesterAgentId: string,
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
): AgentCollaborationRoute[] {
  const requesterConfig = v2Configs.get(normalizeIdentifier(requesterAgentId));
  if (!requesterConfig || requesterConfig.enabled === false) {
    return [];
  }

  const purposesByTarget = new Map<string, Set<string>>();
  for (const responsibility of requesterConfig.responsibilities ?? []) {
    for (const grant of responsibility.collaboration?.canRequest ?? []) {
      const targetAgentId = normalizeIdentifier(grant.agent);
      const purposes = (grant.purposes ?? [])
        .map(normalizeIdentifier)
        .filter((purpose) => purpose.length > 0);
      if (!targetAgentId || targetAgentId === "*" || purposes.length === 0) {
        continue;
      }

      const targetPurposes = purposesByTarget.get(targetAgentId) ?? new Set<string>();
      for (const purpose of purposes) {
        if (purpose !== "*") {
          targetPurposes.add(purpose);
        }
      }
      if (targetPurposes.size > 0) {
        purposesByTarget.set(targetAgentId, targetPurposes);
      }
    }
  }

  return [...purposesByTarget.entries()]
    .map(([targetAgentId, purposes]) => ({
      targetAgentId,
      purposes: [...purposes].sort(),
    }))
    .sort((left, right) => left.targetAgentId.localeCompare(right.targetAgentId));
}

function resolveBudget(
  requested: Partial<AgentCollaborationBudget> | undefined,
  fulfillment: CollaborationFulfillmentGrant,
): { budget: AgentCollaborationBudget; exceeded: string[] } {
  const caps: AgentCollaborationBudget = {
    maxTurns: fulfillment.maxTurns ?? DEFAULT_MAX_TURNS,
    maxDurationSeconds: fulfillment.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
    maxToolCalls: fulfillment.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
  };
  const requestedBudget: AgentCollaborationBudget = {
    maxTurns: requested?.maxTurns ?? caps.maxTurns,
    maxDurationSeconds: requested?.maxDurationSeconds ?? caps.maxDurationSeconds,
    maxToolCalls: requested?.maxToolCalls ?? caps.maxToolCalls,
  };

  const exceeded: string[] = [];
  if (requestedBudget.maxTurns > caps.maxTurns) exceeded.push("maxTurns");
  if (requestedBudget.maxDurationSeconds > caps.maxDurationSeconds) exceeded.push("maxDurationSeconds");
  if (requestedBudget.maxToolCalls > caps.maxToolCalls) exceeded.push("maxToolCalls");

  return {
    budget: requestedBudget,
    exceeded,
  };
}

export function evaluateAgentCollaborationPolicy(
  request: AgentCollaborationRequest,
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
): AgentCollaborationPolicyDecision {
  const requesterAgentId = normalizeIdentifier(request.requesterAgentId);
  const targetAgentId = normalizeIdentifier(request.targetAgentId);
  const purpose = normalizeIdentifier(request.purpose);
  const visibilityMode = request.visibility ?? "summary";

  const baseBudget: AgentCollaborationBudget = {
    maxTurns: request.budget?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxDurationSeconds: request.budget?.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
    maxToolCalls: request.budget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
  };

  if (requesterAgentId === targetAgentId) {
    return { granted: false, reason: "self_collaboration_denied", effectiveBudget: baseBudget, visibilityMode };
  }
  if ((request.parentDepth ?? 0) > DEFAULT_MAX_DEPTH) {
    return { granted: false, reason: "collaboration_depth_exceeded", effectiveBudget: baseBudget, visibilityMode };
  }

  const requesterConfig = v2Configs.get(requesterAgentId);
  const targetConfig = v2Configs.get(targetAgentId);
  if (!requesterConfig || requesterConfig.enabled === false) {
    return { granted: false, reason: "requester_not_configured", effectiveBudget: baseBudget, visibilityMode };
  }
  if (!targetConfig || targetConfig.enabled === false) {
    return { granted: false, reason: "target_not_configured", effectiveBudget: baseBudget, visibilityMode };
  }
  if (!isV2RuntimeEnabled(targetConfig)) {
    return { granted: false, reason: "target_runtime_not_enabled", effectiveBudget: baseBudget, visibilityMode };
  }

  const requestGrant = findRequestGrant(requesterConfig, targetAgentId, purpose);
  if (!requestGrant) {
    return { granted: false, reason: "requester_not_allowed", effectiveBudget: baseBudget, visibilityMode };
  }

  const fulfillmentGrant = findFulfillmentGrant(targetConfig, purpose);
  if (!fulfillmentGrant) {
    return { granted: false, reason: "target_purpose_not_allowed", effectiveBudget: baseBudget, visibilityMode };
  }

  const allowedVisibilityModes = fulfillmentGrant.grant.visibilityModes;
  if (allowedVisibilityModes && !allowedVisibilityModes.includes(visibilityMode)) {
    return { granted: false, reason: "visibility_mode_not_allowed", effectiveBudget: baseBudget, visibilityMode };
  }

  const { budget, exceeded } = resolveBudget(request.budget, fulfillmentGrant.grant);
  if (exceeded.length > 0) {
    return {
      granted: false,
      reason: `budget_exceeded:${exceeded.join(",")}`,
      effectiveBudget: budget,
      visibilityMode,
      requesterResponsibilityId: requestGrant.responsibility.id,
      targetResponsibilityId: fulfillmentGrant.responsibility.id,
    };
  }

  return {
    granted: true,
    reason: "granted",
    effectiveBudget: budget,
    visibilityMode,
    requesterResponsibilityId: requestGrant.responsibility.id,
    targetResponsibilityId: fulfillmentGrant.responsibility.id,
  };
}

export function parseAgentCollaborationRequest(input: Record<string, unknown>): AgentCollaborationRequest {
  const parsed = requestSchema.parse(input);
  const requesterAgentId = parsed.requester_agent_id ?? parsed.requesterAgentId;
  const targetAgentId = parsed.target_agent_id ?? parsed.targetAgentId;
  if (!requesterAgentId) {
    throw new Error("requester_agent_id is required");
  }
  if (!targetAgentId) {
    throw new Error("target_agent_id is required");
  }

  return {
    requesterAgentId,
    targetAgentId,
    purpose: parsed.purpose,
    objective: parsed.objective,
    contextSummary: parsed.context_summary ?? parsed.contextSummary,
    deliverable: parsed.deliverable
      ? {
          format: parsed.deliverable.format,
          requiredFields: parsed.deliverable.required_fields ?? parsed.deliverable.requiredFields,
          maxWords: parsed.deliverable.max_words ?? parsed.deliverable.maxWords,
        }
      : undefined,
    constraints: parsed.constraints,
    visibility: parsed.visibility,
    budget: parsed.budget
      ? {
          maxTurns: parsed.budget.max_turns ?? parsed.budget.maxTurns,
          maxDurationSeconds: parsed.budget.max_duration_seconds ?? parsed.budget.maxDurationSeconds,
          maxToolCalls: parsed.budget.max_tool_calls ?? parsed.budget.maxToolCalls,
        }
      : undefined,
    initiatorKind: parsed.initiator_kind ?? parsed.initiatorKind,
    initiatorRef: parsed.initiator_ref ?? parsed.initiatorRef,
    parentCollaborationId: parsed.parent_collaboration_id ?? parsed.parentCollaborationId,
    parentDepth: parsed.parent_depth ?? parsed.parentDepth,
    userSurface: parsed.user_surface ?? parsed.userSurface,
  };
}

export function renderAgentCollaborationTargetPrompt(request: AgentCollaborationRequest): string {
  const lines: string[] = [
    `Collaboration request from agent:${request.requesterAgentId}.`,
    "",
    `Objective: ${request.objective}`,
  ];
  if (request.contextSummary?.trim()) {
    lines.push("", `Context summary: ${request.contextSummary.trim()}`);
  }

  const deliverableParts: string[] = [];
  if (request.deliverable?.format) {
    deliverableParts.push(`format=${request.deliverable.format}`);
  }
  if (request.deliverable?.requiredFields?.length) {
    deliverableParts.push(`required_fields=${request.deliverable.requiredFields.join(",")}`);
  }
  if (request.deliverable?.maxWords) {
    deliverableParts.push(`max_words=${request.deliverable.maxWords}`);
  }
  if (deliverableParts.length > 0) {
    lines.push("", `Deliverable: ${deliverableParts.join("; ")}.`);
  }

  if (request.constraints?.length) {
    lines.push("", "Constraints:");
    for (const constraint of request.constraints) {
      lines.push(`- ${constraint}`);
    }
  }

  lines.push(
    "",
    "Return one compact JSON object with status, answer, evidence, actions_taken, actions_not_taken, and needs_user.",
    "This is a bounded collaboration turn. Answer the objective, request one clarification if blocked, or return failed with the reason. Do not continue the conversation unless the requester asks a follow-up inside the same collaboration session.",
  );

  return lines.join("\n");
}

function normalizeTargetResult(response: RuntimeResponse): {
  status: AgentCollaborationStatus;
  answer: string;
  evidence: unknown[];
  actionsTaken: string[];
  actionsNotTaken: string[];
  needsUser: boolean;
} {
  const text = response.text.trim();
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(text) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  const statusValue = typeof parsed?.status === "string" ? parsed.status.trim().toLowerCase() : "completed";
  const needsUser = parsed?.needs_user === true || parsed?.needsUser === true || statusValue === "clarification";
  const status: AgentCollaborationStatus =
    statusValue === "failed"
      ? "failed"
      : needsUser || statusValue === "blocked"
        ? "waiting_on_user"
        : "completed";
  const answer = typeof parsed?.answer === "string" && parsed.answer.trim()
    ? parsed.answer.trim()
    : text;
  const evidence = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
  const actionsTakenRaw = parsed?.actions_taken ?? parsed?.actionsTaken;
  const actionsNotTakenRaw = parsed?.actions_not_taken ?? parsed?.actionsNotTaken;

  return {
    status,
    answer,
    evidence,
    actionsTaken: Array.isArray(actionsTakenRaw)
      ? actionsTakenRaw.filter((value): value is string => typeof value === "string")
      : [],
    actionsNotTaken: Array.isArray(actionsNotTakenRaw)
      ? actionsNotTakenRaw.filter((value): value is string => typeof value === "string")
      : [],
    needsUser,
  };
}

function buildDeniedPolicyDecision(
  request: AgentCollaborationRequest,
  reason: string,
): AgentCollaborationPolicyDecision {
  return {
    granted: false,
    reason,
    effectiveBudget: {
      maxTurns: request.budget?.maxTurns ?? DEFAULT_MAX_TURNS,
      maxDurationSeconds: request.budget?.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
      maxToolCalls: request.budget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    },
    visibilityMode: request.visibility ?? "summary",
  };
}

export class AgentCollaborationService {
  private readonly storage: AgentCollaborationServiceOptions["storage"];
  private readonly v2Configs: ReadonlyMap<string, V2AgentConfig>;
  private readonly invokeTarget?: AgentCollaborationTargetInvoker;
  private readonly presentationObserver?: AgentCollaborationPresentationObserver;
  private readonly now: () => Date;

  constructor(options: AgentCollaborationServiceOptions) {
    this.storage = options.storage;
    this.v2Configs = options.v2Configs;
    this.invokeTarget = options.invokeTarget;
    this.presentationObserver = options.presentationObserver;
    this.now = options.now ?? (() => new Date());
  }

  async collaborate(rawRequest: AgentCollaborationRequest | Record<string, unknown>): Promise<AgentCollaborationResult> {
    let request = "requesterAgentId" in rawRequest
      ? rawRequest as AgentCollaborationRequest
      : parseAgentCollaborationRequest(rawRequest as Record<string, unknown>);

    if (request.parentCollaborationId && request.parentDepth === undefined) {
      const parentDepth = this.resolveParentDepth(request.parentCollaborationId);
      if (parentDepth === null) {
        const normalizedObjective = normalizeCollaborationObjective(request.objective);
        return this.recordDeniedCollaboration(
          request,
          normalizedObjective,
          buildDeniedPolicyDecision(request, "parent_collaboration_not_found"),
        );
      }
      request = { ...request, parentDepth };
    }

    const normalizedObjective = normalizeCollaborationObjective(request.objective);
    let policyDecision = evaluateAgentCollaborationPolicy(request, this.v2Configs);
    if (policyDecision.granted) {
      policyDecision = this.applyLoopGuard(request, policyDecision);
    }

    if (!policyDecision.granted) {
      return this.recordDeniedCollaboration(request, normalizedObjective, policyDecision);
    }

    const duplicate = this.storage.findRecentAgentCollaborationSession({
      requesterAgentId: request.requesterAgentId,
      targetAgentId: request.targetAgentId,
      purpose: request.purpose,
      normalizedObjective,
      sinceUtc: new Date(this.now().getTime() - DUPLICATE_WINDOW_MS).toISOString(),
    });
    if (duplicate && ["running", "completed", "waiting_on_user"].includes(duplicate.status)) {
      return {
        collaborationId: duplicate.id,
        status: duplicate.status,
        duplicateOf: duplicate.id,
        answer: duplicate.resultSummary ?? undefined,
        error: duplicate.error ?? undefined,
        policyDecision,
      };
    }

    const collaborationId = this.storage.insertAgentCollaborationSession({
      parentCollaborationId: request.parentCollaborationId,
      requesterAgentId: request.requesterAgentId,
      targetAgentId: request.targetAgentId,
      initiatorKind: request.initiatorKind ?? "agent",
      initiatorRef: request.initiatorRef,
      purpose: request.purpose,
      objective: request.objective,
      normalizedObjective,
      contextSummary: request.contextSummary,
      deliverableContract: { ...(request.deliverable ?? {}) },
      constraints: request.constraints ?? [],
      status: "running",
      visibilityMode: policyDecision.visibilityMode,
      userSurface: request.userSurface,
      budget: { ...policyDecision.effectiveBudget },
      policyDecision: { ...policyDecision },
      expiresAt: new Date(this.now().getTime() + policyDecision.effectiveBudget.maxDurationSeconds * 1000).toISOString(),
    });

    const targetPrompt = renderAgentCollaborationTargetPrompt(request);
    this.storage.insertAgentCollaborationTurn({
      collaborationId,
      turnIndex: 1,
      senderAgentId: request.requesterAgentId,
      recipientAgentId: request.targetAgentId,
      turnType: "request",
      content: targetPrompt,
      structured: {
        purpose: request.purpose,
        objective: request.objective,
        deliverable: request.deliverable ?? null,
        constraints: request.constraints ?? [],
      },
    });
    await this.notifyPresentation({
      kind: "started",
      session: this.requireSession(collaborationId),
    });

    if (!this.invokeTarget) {
      const error = "collaboration_target_invoker_unavailable";
      this.storage.updateAgentCollaborationSession(collaborationId, {
        status: "failed",
        error,
      });
      await this.notifyPresentation({
        kind: "failed",
        session: this.requireSession(collaborationId),
        error,
      });
      return {
        collaborationId,
        status: "failed",
        error,
        policyDecision,
      };
    }

    const conversationKey = buildAgentCollaborationConversationKey(collaborationId, request.targetAgentId);
    try {
      const response = await this.invokeTarget({
        collaborationId,
        requesterAgentId: request.requesterAgentId,
        targetAgentId: request.targetAgentId,
        purpose: request.purpose,
        objective: request.objective,
        message: targetPrompt,
        conversationKey,
        timeoutMs: policyDecision.effectiveBudget.maxDurationSeconds * 1000,
      });
      const normalized = normalizeTargetResult(response);
      const resultTurnType: AgentCollaborationTurnType =
        normalized.status === "waiting_on_user" ? "clarification" : normalized.status === "failed" ? "error" : "result";

      this.storage.insertAgentCollaborationTurn({
        collaborationId,
        turnIndex: 2,
        senderAgentId: request.targetAgentId,
        recipientAgentId: request.requesterAgentId,
        turnType: resultTurnType,
        content: response.text,
        structured: {
          answer: normalized.answer,
          evidence: normalized.evidence,
          actionsTaken: normalized.actionsTaken,
          actionsNotTaken: normalized.actionsNotTaken,
          needsUser: normalized.needsUser,
          model: response.model ?? null,
          toolsUsed: response.toolsUsed ?? [],
          metadata: response.metadata ?? null,
        },
      });
      this.storage.updateAgentCollaborationSession(collaborationId, {
        status: normalized.status,
        resultSummary: normalized.answer,
        error: normalized.status === "failed" ? normalized.answer : null,
      });
      await this.notifyPresentation({
        kind: normalized.status === "waiting_on_user"
          ? "waiting_on_user"
          : normalized.status === "failed"
            ? "failed"
            : "completed",
        session: this.requireSession(collaborationId),
        answer: normalized.answer,
        ...(normalized.status === "failed" ? { error: normalized.answer } : {}),
      });

      return {
        collaborationId,
        status: normalized.status,
        answer: normalized.answer,
        evidence: normalized.evidence,
        actionsTaken: normalized.actionsTaken,
        actionsNotTaken: normalized.actionsNotTaken,
        needsUser: normalized.needsUser,
        policyDecision,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.storage.insertAgentCollaborationTurn({
        collaborationId,
        turnIndex: 2,
        senderAgentId: request.targetAgentId,
        recipientAgentId: request.requesterAgentId,
        turnType: "error",
        content: message,
      });
      this.storage.updateAgentCollaborationSession(collaborationId, {
        status: "failed",
        error: message,
      });
      await this.notifyPresentation({
        kind: "failed",
        session: this.requireSession(collaborationId),
        error: message,
      });
      return {
        collaborationId,
        status: "failed",
        error: message,
        policyDecision,
      };
    }
  }

  getSession(id: string): AgentCollaborationSessionRecord | null {
    return this.storage.getAgentCollaborationSession(id);
  }

  private requireSession(id: string): AgentCollaborationSessionRecord {
    const session = this.storage.getAgentCollaborationSession(id);
    if (!session) {
      throw new Error(`collaboration session disappeared: ${id}`);
    }
    return session;
  }

  private async notifyPresentation(event: AgentCollaborationPresentationEvent): Promise<void> {
    if (!this.presentationObserver) return;
    try {
      await this.presentationObserver(event);
    } catch (error) {
      // Presentation is a best-effort projection. A Discord failure must never
      // alter the durable collaboration result or cause the requester to retry.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent-collaboration] presentation observer failed: ${message}`);
    }
  }

  private resolveParentDepth(parentCollaborationId: string): number | null {
    let parent = this.storage.getAgentCollaborationSession(parentCollaborationId);
    if (!parent) {
      return null;
    }

    let depth = 1;
    const visited = new Set<string>([parentCollaborationId]);
    while (parent.parentCollaborationId) {
      if (visited.has(parent.parentCollaborationId)) {
        return DEFAULT_MAX_DEPTH + 1;
      }
      visited.add(parent.parentCollaborationId);
      parent = this.storage.getAgentCollaborationSession(parent.parentCollaborationId);
      if (!parent) {
        return null;
      }
      depth += 1;
      if (depth > DEFAULT_MAX_DEPTH + 1) {
        return depth;
      }
    }

    return depth;
  }

  private applyLoopGuard(
    request: AgentCollaborationRequest,
    policyDecision: AgentCollaborationPolicyDecision,
  ): AgentCollaborationPolicyDecision {
    const activeInbound = this.storage.findActiveInboundAgentCollaborationSession({
      targetAgentId: request.requesterAgentId,
      nowUtc: this.now().toISOString(),
    });
    if (activeInbound && request.parentCollaborationId !== activeInbound.id) {
      return {
        ...policyDecision,
        granted: false,
        reason: "nested_collaboration_context_missing",
      };
    }
    return policyDecision;
  }

  private recordDeniedCollaboration(
    request: AgentCollaborationRequest,
    normalizedObjective: string,
    policyDecision: AgentCollaborationPolicyDecision,
  ): AgentCollaborationResult {
    const collaborationId = this.storage.insertAgentCollaborationSession({
      parentCollaborationId: request.parentCollaborationId,
      requesterAgentId: request.requesterAgentId,
      targetAgentId: request.targetAgentId,
      initiatorKind: request.initiatorKind ?? "agent",
      initiatorRef: request.initiatorRef,
      purpose: request.purpose,
      objective: request.objective,
      normalizedObjective,
      contextSummary: request.contextSummary,
      deliverableContract: { ...(request.deliverable ?? {}) },
      constraints: request.constraints ?? [],
      status: "denied",
      visibilityMode: policyDecision.visibilityMode,
      userSurface: request.userSurface,
      budget: { ...policyDecision.effectiveBudget },
      policyDecision: { ...policyDecision },
      expiresAt: new Date(this.now().getTime() + policyDecision.effectiveBudget.maxDurationSeconds * 1000).toISOString(),
    });
    this.storage.updateAgentCollaborationSession(collaborationId, {
      status: "denied",
      error: policyDecision.reason,
    });
    return {
      collaborationId,
      status: "denied",
      error: policyDecision.reason,
      availableRoutes: listAgentCollaborationRoutes(request.requesterAgentId, this.v2Configs),
      policyDecision,
    };
  }
}

export function buildAgentCollaborationConversationKey(
  collaborationId: string,
  targetAgentId: string,
): string {
  return `collab:${collaborationId}:${targetAgentId}`;
}
