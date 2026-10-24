import type {
  ChatProvider,
  ProviderToolCall,
  StateAccessContext,
  StateEventKind,
  StateMutationContext,
  StateReferenceMutation,
  StateRelationMutation,
  StateService,
  V2AgentConfig,
} from "@tango/core";
import { resolveExtractionProvider } from "./extraction-provider.js";

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;
const MAX_TOOL_RESULT_CHARS = 1_200;
const MAX_TOOL_CONTEXT_CHARS = 5_000;

export interface StateReconcilerSettings {
  providerName: string;
  model: string;
  focusTtlDays: number;
}

export interface StateReconcilerTurn {
  turnId: string;
  conversationKey: string;
  sessionId: string;
  agentId: string;
  userMessage: string;
  agentResponse: string;
  toolCalls?: readonly ProviderToolCall[];
  requestMessageId?: string | number | null;
  responseMessageId?: string | number | null;
  occurredAt?: string;
}

export interface StateProposal {
  action: "observation" | "update" | "transition" | "new_entity" | "revert" | "no_op";
  entityId?: string;
  typeId?: string;
  title?: string;
  aliases?: string[];
  attributes?: Record<string, unknown>;
  status?: string | null;
  summary?: string | null;
  bodyPointer?: string | null;
  projectEntityId?: string | null;
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
  visibility?: string | null;
  dueAt?: string | null;
  nextCheckAt?: string | null;
  expectedResponseAt?: string | null;
  lastProgressAt?: string | null;
  markProgress?: boolean;
  relations?: StateRelationMutation[];
  references?: StateReferenceMutation[];
  note?: string;
  occurredAt?: string;
  targetTurnId?: string;
  evidence: string;
}

export interface StateChangeset {
  changes: StateProposal[];
  engagedEntityIds: string[];
}

export interface StateReconcilerOutcome {
  status: "ok" | "error" | "disabled";
  claimedFacts: string[];
  appliedEventIds: number[];
  revertedEventIds: number[];
  engagedEntityIds: string[];
  rejected: string[];
  proposals: number;
  latencyMs: number;
  providerName?: string;
  model?: string;
  error?: string;
}

export interface RunStateReconcilerInput {
  service: StateService;
  v2Config: V2AgentConfig | null | undefined;
  resolveProvider: (name: string) => ChatProvider | undefined;
  turn: StateReconcilerTurn;
  onPersistentFailure?: (input: {
    providerName: string;
    model: string;
    prompt: string;
    error: string;
  }) => void;
  unarchiveMemories?: (eventIds: readonly number[]) => Promise<void>;
}

export function resolveStateReconcilerSettings(
  config: V2AgentConfig | null | undefined,
): StateReconcilerSettings | null {
  if (!config || config.state?.reconciliation === "disabled") return null;
  const model = config.state?.extractionModel ?? config.memory.extractionModel;
  const providerName = resolveExtractionProvider(
    config,
    config.state?.extractionProvider ?? config.memory.extractionProvider,
    model,
  );
  return {
    providerName,
    model,
    focusTtlDays: config.state?.focusTtlDays ?? 7,
  };
}

export function buildStateReconcilerPrompt(input: {
  turn: StateReconcilerTurn;
  snapshot: ReturnType<StateService["buildReconcilerSnapshot"]>;
}): string {
  const toolContext = formatToolCalls(input.turn.toolCalls ?? []);
  const turnText = [
    `User: ${stripPriorReceipts(input.turn.userMessage)}`,
    `Assistant: ${stripPriorReceipts(input.turn.agentResponse)}`,
    toolContext ? `Tool calls/results:\n${toolContext}` : "Tool calls/results: none",
  ].join("\n");
  return [
    "You are Tango's State Reconciler. You do bookkeeping only; never answer the user.",
    "Inspect every completed turn and propose only grounded changes to canonical typed state.",
    "Return ONLY one JSON object with this shape:",
    '{"changes":[{"action":"observation|update|transition|new_entity|revert|no_op","entity_id":"...","type_id":"...","title":"...","aliases":["..."],"attributes":{},"status":"...","summary":"...","body_pointer":"...","project_entity_id":"...","owner_user_id":"...","owner_agent_id":"...","visibility":"...","due_at":"ISO timestamp","next_check_at":"ISO timestamp","expected_response_at":"ISO timestamp","last_progress_at":"ISO timestamp","mark_progress":true,"relations":[{"kind":"depends_on","target_entity_id":"...","metadata":{}}],"references":[{"role":"evidence","ref":"obsidian:path-or-log-ref","label":"..."}],"note":"...","occurred_at":"ISO timestamp","target_turn_id":"...","evidence":"exact quote from turn"}],"engaged_entity_ids":["..."]}',
    "",
    "Rules:",
    "- Every non-no_op proposal MUST include an exact evidence quote present in the user message, assistant reply, or shown tool result.",
    "- Never invent a value. Never emit a value equal to the current snapshot.",
    "- The supplied type catalog is authoritative. Never conclude that a listed type is missing because the serving assistant or a tool result says otherwise.",
    "- A user's explicit request to track a new entity under an existing catalog type is sufficient evidence for new_entity. Only creation of a NEW TYPE needs confirmation.",
    "- When the serving assistant is confused, refuses bookkeeping, or asks an unnecessary confirmation, still apply the user's grounded state instruction.",
    "- Resolve mentions against the FULL entity name index. Prefer an existing entity. New entity only when nothing plausibly matches.",
    "- If a known entity is called a new name, update aliases on that same entity.",
    "- 'undo that' means revert the previous state-changing turn. Corrections are updates with the corrected value.",
    "- State-shaped current facts belong here; preferences, biography, feelings, and narrative do not.",
    "- Project association, owners, temporal fields, relations, and references are generic bookkeeping fields available to every entity type; do not invent any of them.",
    "- mark_progress=true only for meaningful forward movement explicitly established by the turn. Routine touches, notes, reformatting, and status checks are not progress.",
    "- NEVER infer completion from narrative, plans, summaries, document existence, or optimistic assistant prose. A terminal status requires an explicit completion statement or deterministic tool result, and any cited log/document should be captured as a reference.",
    "- Use occurred_at only when the turn explicitly establishes when the fact was true.",
    '- Example: "Track a project named X as active at 10 percent" with project in the catalog becomes {"action":"new_entity","type_id":"project","title":"X","status":"active","attributes":{"progress_pct":10},"evidence":"exact user quote"}.',
    "- If nothing changed, return {\"changes\":[],\"engaged_entity_ids\":[]}.",
    "",
    `Turn timestamp: ${input.turn.occurredAt ?? new Date().toISOString()}`,
    `Agent: ${input.turn.agentId}`,
    `Entity name index: ${JSON.stringify(input.snapshot.nameIndex)}`,
    `Scoped current state: ${JSON.stringify(input.snapshot.entities)}`,
    `Type catalog: ${JSON.stringify(input.snapshot.types)}`,
    "",
    "Completed turn:",
    turnText,
  ].join("\n");
}

export function parseStateChangeset(text: string): StateChangeset {
  for (const candidate of jsonObjectCandidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const rawChanges = Array.isArray(value.changes) ? value.changes : [];
    const changes = rawChanges.flatMap(normalizeProposal);
    if (rawChanges.length > 0 && changes.length === 0) {
      throw new Error("State Reconciler changes did not match the required action schema.");
    }
    const engagedEntityIds = normalizeStringArray(value.engaged_entity_ids ?? value.engagedEntityIds);
    return { changes, engagedEntityIds };
  }
  throw new Error("State Reconciler did not return a valid JSON changeset.");
}

export async function runStateReconciler(input: RunStateReconcilerInput): Promise<StateReconcilerOutcome> {
  const startedAt = Date.now();
  const settings = resolveStateReconcilerSettings(input.v2Config);
  if (!settings) {
    return emptyOutcome("disabled", Date.now() - startedAt);
  }
  const provider = input.resolveProvider(settings.providerName);
  if (!provider) {
    const error = `No provider '${settings.providerName}' registered for State Reconciler.`;
    return { ...emptyOutcome("error", Date.now() - startedAt), error, providerName: settings.providerName, model: settings.model };
  }
  const access = stateAccess(input.turn.agentId, input.v2Config);
  const snapshot = input.service.buildReconcilerSnapshot({
    ...access,
    conversationKey: input.turn.conversationKey,
    alwaysOnTypes: input.v2Config?.state?.alwaysOnTypes ?? [],
    recentEvents: 5,
  });
  const prompt = buildStateReconcilerPrompt({ turn: input.turn, snapshot });
  input.service.startReconcilerRun({
    turnId: input.turn.turnId,
    conversationKey: input.turn.conversationKey,
    sessionId: input.turn.sessionId,
    agentId: input.turn.agentId,
    providerName: settings.providerName,
    model: settings.model,
  });

  try {
    const changeset = await extractWithRetry(provider, settings, prompt, (candidate) => {
      for (const proposal of candidate.changes) {
        if (
          proposal.entityId
          && proposal.action !== "new_entity"
          && proposal.action !== "revert"
          && proposal.action !== "no_op"
          && !input.service.getEntity(proposal.entityId, access)
        ) {
          throw new Error(
            `proposal action '${proposal.action}' references missing entity '${proposal.entityId}'; use new_entity when the name index has no match`,
          );
        }
      }
    });
    const evidenceCorpus = normalizeEvidence([
      input.turn.userMessage,
      input.turn.agentResponse,
      formatToolCalls(input.turn.toolCalls ?? []),
    ].join("\n"));
    const rejected: string[] = [];
    const appliedEventIds: number[] = [];
    const revertedEventIds: number[] = [];
    const engaged = new Set<string>();
    const claimedFacts: string[] = [];
    for (const [index, proposal] of changeset.changes.entries()) {
      if (proposal.action === "no_op") continue;
      if (!proposal.evidence || !evidenceCorpus.includes(normalizeEvidence(proposal.evidence))) {
        rejected.push(`change ${index + 1}: evidence quote was not present in the turn`);
        continue;
      }
      try {
        const outcome = await applyProposal(input, proposal, access);
        for (const eventId of outcome.eventIds) appliedEventIds.push(eventId);
        for (const eventId of outcome.revertedEventIds) revertedEventIds.push(eventId);
        for (const entityId of outcome.entityIds) engaged.add(entityId);
        if (outcome.applied) claimedFacts.push(proposal.evidence);
      } catch (error) {
        rejected.push(`change ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Validate model-proposed focus after mutations so a correctly predicted ID
    // for a just-created entity resolves without a false rejection or FK error.
    for (const entityId of changeset.engagedEntityIds) {
      if (input.service.getEntity(entityId, access)) {
        engaged.add(entityId);
      } else {
        rejected.push(`engaged entity '${entityId}' does not exist or is not visible`);
      }
    }
    if (engaged.size > 0) {
      input.service.focusEntities(input.turn.conversationKey, [...engaged], settings.focusTtlDays);
    }
    if (revertedEventIds.length > 0) {
      await input.unarchiveMemories?.(revertedEventIds);
    }
    const latencyMs = Date.now() - startedAt;
    input.service.finishReconcilerRun(input.turn.turnId, {
      status: "ok",
      proposalCount: changeset.changes.length,
      appliedCount: appliedEventIds.length,
      rejectedCount: rejected.length,
      claimedFacts,
      rejectionReasons: rejected,
      latencyMs,
    });
    return {
      status: "ok",
      claimedFacts: [...new Set(claimedFacts)],
      appliedEventIds,
      revertedEventIds,
      engagedEntityIds: [...engaged],
      rejected,
      proposals: changeset.changes.length,
      latencyMs,
      providerName: settings.providerName,
      model: settings.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latencyMs = Date.now() - startedAt;
    input.service.finishReconcilerRun(input.turn.turnId, { status: "error", latencyMs, error: message });
    input.onPersistentFailure?.({
      providerName: settings.providerName,
      model: settings.model,
      prompt,
      error: message,
    });
    return {
      ...emptyOutcome("error", latencyMs),
      providerName: settings.providerName,
      model: settings.model,
      error: message,
    };
  }
}

async function applyProposal(
  input: RunStateReconcilerInput,
  proposal: StateProposal,
  access: StateAccessContext,
): Promise<{ applied: boolean; eventIds: number[]; revertedEventIds: number[]; entityIds: string[] }> {
  const context: StateMutationContext = {
    ...access,
    actor: "reconciler",
    source: "reconciler",
    sessionId: input.turn.sessionId,
    messageId: input.turn.responseMessageId === null || input.turn.responseMessageId === undefined
      ? null
      : String(input.turn.responseMessageId),
    turnId: input.turn.turnId,
    occurredAt: proposal.occurredAt ?? input.turn.occurredAt,
  };
  if (proposal.action === "revert") {
    const target = proposal.targetTurnId
      ?? input.service.findLatestTurnId(input.turn.sessionId, input.turn.turnId);
    if (!target) throw new Error("No previous state-changing turn was available to revert.");
    const result = input.service.revertTurn(target, context);
    return {
      applied: result.applied > 0,
      eventIds: result.results.flatMap((item) => item.event ? [item.event.id] : []),
      revertedEventIds: result.revertedEventIds,
      entityIds: result.results.map((item) => item.entity.id),
    };
  }
  const kind: StateEventKind = proposal.action === "observation"
    ? "observation"
    : proposal.action === "transition"
      ? "status_change"
      : "update";
  const result = input.service.mutate({
    ...(proposal.entityId && proposal.action !== "new_entity" ? { entityId: proposal.entityId } : {}),
    ...(proposal.typeId ? { typeId: proposal.typeId } : {}),
    ...(proposal.title ? { title: proposal.title } : {}),
    ...(proposal.aliases ? { aliases: proposal.aliases } : {}),
    ...(proposal.attributes ? { attributes: proposal.attributes } : {}),
    ...(proposal.status !== undefined ? { status: proposal.status } : {}),
    ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
    ...(proposal.bodyPointer !== undefined ? { bodyPointer: proposal.bodyPointer } : {}),
    ...(proposal.projectEntityId !== undefined ? { projectEntityId: proposal.projectEntityId } : {}),
    ...(proposal.ownerUserId !== undefined ? { ownerUserId: proposal.ownerUserId } : {}),
    ...(proposal.ownerAgentId !== undefined ? { ownerAgentId: proposal.ownerAgentId } : {}),
    ...(proposal.visibility !== undefined ? { visibility: proposal.visibility } : {}),
    ...(proposal.dueAt !== undefined ? { dueAt: proposal.dueAt } : {}),
    ...(proposal.nextCheckAt !== undefined ? { nextCheckAt: proposal.nextCheckAt } : {}),
    ...(proposal.expectedResponseAt !== undefined ? { expectedResponseAt: proposal.expectedResponseAt } : {}),
    ...(proposal.lastProgressAt !== undefined ? { lastProgressAt: proposal.lastProgressAt } : {}),
    ...(proposal.markProgress !== undefined ? { markProgress: proposal.markProgress } : {}),
    ...(proposal.relations ? { relations: proposal.relations } : {}),
    ...(proposal.references ? { references: proposal.references } : {}),
    ...(proposal.note ? { note: proposal.note } : {}),
    kind,
  }, context);
  return {
    applied: result.applied,
    eventIds: result.event ? [result.event.id] : [],
    revertedEventIds: [],
    entityIds: [result.entity.id],
  };
}

async function extractWithRetry(
  provider: ChatProvider,
  settings: StateReconcilerSettings,
  prompt: string,
  validate?: (changeset: StateChangeset) => void,
): Promise<StateChangeset> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await provider.generate({
        prompt: attempt === 1
          ? prompt
          : `${prompt}\n\nCORRECTION REQUIRED: Your previous changeset was invalid: ${lastError instanceof Error ? lastError.message : String(lastError)}. Return a corrected object in the exact required schema.`,
        model: settings.model,
        reasoningEffort: "low",
      });
      const changeset = parseStateChangeset(response.text);
      validate?.(changeset);
      return changeset;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function normalizeProposal(value: unknown): StateProposal[] {
  if (!isRecord(value)) return [];
  const actionRaw = stringValue(value.action)?.toLowerCase().replace(/[- ]/gu, "_");
  const allowed = new Set(StateProposalActions);
  if (!actionRaw || !allowed.has(actionRaw as StateProposal["action"])) return [];
  const evidence = stringValue(value.evidence) ?? "";
  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  const relations = normalizeRelations(value.relations);
  const references = normalizeReferences(value.references);
  return [{
    action: actionRaw as StateProposal["action"],
    ...(stringValue(value.entity_id ?? value.entityId) ? { entityId: stringValue(value.entity_id ?? value.entityId)! } : {}),
    ...(stringValue(value.type_id ?? value.typeId) ? { typeId: stringValue(value.type_id ?? value.typeId)! } : {}),
    ...(stringValue(value.title) ? { title: stringValue(value.title)! } : {}),
    ...(normalizeStringArray(value.aliases).length > 0 ? { aliases: normalizeStringArray(value.aliases) } : {}),
    ...(attributes ? { attributes } : {}),
    ...(value.status === null || typeof value.status === "string" ? { status: value.status as string | null } : {}),
    ...(value.summary === null || typeof value.summary === "string" ? { summary: value.summary as string | null } : {}),
    ...(value.body_pointer === null || typeof value.body_pointer === "string"
      ? { bodyPointer: value.body_pointer as string | null }
      : value.bodyPointer === null || typeof value.bodyPointer === "string"
        ? { bodyPointer: value.bodyPointer as string | null }
        : {}),
    ...nullableStringProposal(value, "project_entity_id", "projectEntityId"),
    ...nullableStringProposal(value, "owner_user_id", "ownerUserId"),
    ...nullableStringProposal(value, "owner_agent_id", "ownerAgentId"),
    ...nullableStringProposal(value, "visibility", "visibility"),
    ...nullableStringProposal(value, "due_at", "dueAt"),
    ...nullableStringProposal(value, "next_check_at", "nextCheckAt"),
    ...nullableStringProposal(value, "expected_response_at", "expectedResponseAt"),
    ...nullableStringProposal(value, "last_progress_at", "lastProgressAt"),
    ...(typeof value.mark_progress === "boolean"
      ? { markProgress: value.mark_progress }
      : typeof value.markProgress === "boolean"
        ? { markProgress: value.markProgress }
        : {}),
    ...(relations ? { relations } : {}),
    ...(references ? { references } : {}),
    ...(stringValue(value.note) ? { note: stringValue(value.note)! } : {}),
    ...(stringValue(value.occurred_at ?? value.occurredAt) ? { occurredAt: stringValue(value.occurred_at ?? value.occurredAt)! } : {}),
    ...(stringValue(value.target_turn_id ?? value.targetTurnId) ? { targetTurnId: stringValue(value.target_turn_id ?? value.targetTurnId)! } : {}),
    evidence,
  }];
}

function nullableStringProposal(
  value: Record<string, unknown>,
  snakeKey: string,
  camelKey: keyof Pick<StateProposal,
    | "projectEntityId"
    | "ownerUserId"
    | "ownerAgentId"
    | "visibility"
    | "dueAt"
    | "nextCheckAt"
    | "expectedResponseAt"
    | "lastProgressAt">,
): Partial<StateProposal> {
  const raw = value[snakeKey] !== undefined ? value[snakeKey] : value[camelKey];
  return raw === null || typeof raw === "string" ? { [camelKey]: raw } : {};
}

function normalizeRelations(value: unknown): StateRelationMutation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("State Reconciler relations must be an array.");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`State Reconciler relations[${index}] must be an object.`);
    const kind = stringValue(item.kind);
    const targetEntityId = stringValue(item.target_entity_id ?? item.targetEntityId);
    if (!kind || !targetEntityId) throw new Error(`State Reconciler relations[${index}] requires kind and target_entity_id.`);
    return {
      kind,
      targetEntityId,
      ...(item.metadata === null || isRecord(item.metadata) ? { metadata: item.metadata } : {}),
      ...(typeof item.remove === "boolean" ? { remove: item.remove } : {}),
    };
  });
}

function normalizeReferences(value: unknown): StateReferenceMutation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("State Reconciler references must be an array.");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`State Reconciler references[${index}] must be an object.`);
    const role = stringValue(item.role);
    const ref = stringValue(item.ref);
    if (!role || !ref) throw new Error(`State Reconciler references[${index}] requires role and ref.`);
    const supportsEventId = item.supports_event_id ?? item.supportsEventId;
    return {
      role,
      ref,
      ...(item.label === null || typeof item.label === "string" ? { label: item.label } : {}),
      ...(item.metadata === null || isRecord(item.metadata) ? { metadata: item.metadata } : {}),
      ...(supportsEventId === null || (typeof supportsEventId === "number" && Number.isInteger(supportsEventId) && supportsEventId > 0)
        ? { supportsEventId }
        : {}),
      ...(typeof item.remove === "boolean" ? { remove: item.remove } : {}),
    };
  });
}

const StateProposalActions: readonly StateProposal["action"][] = [
  "observation",
  "update",
  "transition",
  "new_entity",
  "revert",
  "no_op",
];

function stateAccess(agentId: string, config: V2AgentConfig | null | undefined): StateAccessContext {
  return { agentId, agentType: config?.type ?? null, scopes: [config?.type ?? "", agentId.replace(/-ollama$/u, "")] };
}

function formatToolCalls(calls: readonly ProviderToolCall[]): string {
  let used = 0;
  const lines: string[] = [];
  for (const call of calls) {
    const result = truncate(typeof call.output === "string" ? call.output : JSON.stringify(call.output ?? null), MAX_TOOL_RESULT_CHARS);
    const line = `${call.name} input=${truncate(JSON.stringify(call.input), 600)} result=${result}`;
    if (used + line.length > MAX_TOOL_CONTEXT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

function stripPriorReceipts(text: string): string {
  return text.split(/\r?\n/u).filter((line) => !line.trim().startsWith("⟢ state:")).join("\n").trim();
}

function normalizeEvidence(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function jsonObjectCandidates(text: string): string[] {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  return [...new Set(candidates.filter(Boolean))];
}

function emptyOutcome(status: StateReconcilerOutcome["status"], latencyMs: number): StateReconcilerOutcome {
  return {
    status,
    claimedFacts: [],
    appliedEventIds: [],
    revertedEventIds: [],
    engagedEntityIds: [],
    rejected: [],
    proposals: 0,
    latencyMs,
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
