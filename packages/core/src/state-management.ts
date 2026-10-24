import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export type StateEventKind =
  | "status_change"
  | "update"
  | "observation"
  | "note"
  | "sync"
  | "archive"
  | "restore"
  | "revert"
  | "create"
  | "check_in";

export interface StateAccessContext {
  agentId?: string | null;
  agentType?: string | null;
  scopes?: readonly string[];
  includePrivate?: boolean;
}

export interface StateTypeDefinition {
  id: string;
  displayName: string;
  description: string | null;
  attributesSchema: Record<string, unknown>;
  statuses: StateStatusDefinition | null;
  stalenessPolicy: StateStalenessPolicy | null;
  digestTemplate: string | null;
  bodyFields: string[];
  visibility: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface StateStatusDefinition {
  values: string[];
  transitions?: Record<string, string[]>;
  initial?: string;
  /** Statuses that close work for deadline/overdue purposes. */
  terminal?: string[];
}

export interface StateStalenessPolicy {
  expected_update_days?: number;
  on_stale?: "nudge" | "expire" | "archive";
  archive_after_end_days?: number;
  check_in_days?: number;
  check_in_agent?: string;
  check_in_prompt?: string;
  [key: string]: unknown;
}

export interface StateEntity {
  id: string;
  typeId: string;
  slug: string;
  title: string;
  aliases: string[];
  status: string | null;
  attributes: Record<string, unknown>;
  summary: string | null;
  bodyPointer: string | null;
  bodyFieldsHash: string | null;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  projectEntityId: string | null;
  visibility: string | null;
  dueAt: string | null;
  nextCheckAt: string | null;
  expectedResponseAt: string | null;
  lastProgressAt: string | null;
  closedAt: string | null;
  source: string;
  lastEventAt: string | null;
  staleAfter: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  stale: boolean;
  overdue: boolean;
}

export interface StateEntityRelation {
  id: number;
  sourceEntityId: string;
  targetEntityId: string;
  kind: string;
  metadata: Record<string, unknown> | null;
  createdEventId: number;
  archivedEventId: number | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface StateEntityReference {
  id: number;
  entityId: string;
  role: string;
  ref: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
  supportsEventId: number | null;
  createdEventId: number;
  archivedEventId: number | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface StateRelationMutation {
  kind: string;
  targetEntityId: string;
  metadata?: Record<string, unknown> | null;
  remove?: boolean;
}

export interface StateReferenceMutation {
  role: string;
  ref: string;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
  supportsEventId?: number | null;
  remove?: boolean;
}

export interface StatePatchValue {
  from: unknown;
  to: unknown;
}

export interface StateEvent {
  id: number;
  entityId: string;
  kind: StateEventKind;
  patch: Record<string, StatePatchValue> | null;
  note: string | null;
  actor: string;
  sessionId: string | null;
  messageId: string | null;
  turnId: string | null;
  revertsEventId: number | null;
  occurredAt: string;
  recordedAt: string;
}

export interface StateMutationContext extends StateAccessContext {
  actor: string;
  source: string;
  sessionId?: string | null;
  messageId?: string | null;
  turnId?: string | null;
  occurredAt?: string | null;
}

export interface StateEntityMutation {
  entityId?: string;
  typeId?: string;
  title?: string;
  aliases?: string[];
  /** Use exact normalized names when a machine-owned projection has a stable key. */
  matchStrategy?: "plausible" | "exact" | "none";
  attributes?: Record<string, unknown>;
  status?: string | null;
  summary?: string | null;
  bodyPointer?: string | null;
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
  projectEntityId?: string | null;
  visibility?: string | null;
  dueAt?: string | null;
  nextCheckAt?: string | null;
  expectedResponseAt?: string | null;
  lastProgressAt?: string | null;
  markProgress?: boolean;
  relations?: StateRelationMutation[];
  references?: StateReferenceMutation[];
  kind?: StateEventKind;
  note?: string | null;
  archive?: boolean;
  restore?: boolean;
}

export interface StateMutationResult {
  applied: boolean;
  entity: StateEntity;
  event: StateEvent | null;
  created: boolean;
  reason?: string;
}

export interface StateQueryInput extends StateAccessContext {
  entityId?: string;
  type?: string;
  status?: string;
  stale?: boolean;
  overdue?: boolean;
  text?: string;
  projectEntityId?: string;
  ownerUserId?: string;
  ownerAgentId?: string;
  source?: string;
  dueBefore?: string;
  dueAfter?: string;
  nextCheckBefore?: string;
  nextCheckAfter?: string;
  expectedResponseBefore?: string;
  expectedResponseAfter?: string;
  lastProgressBefore?: string;
  lastProgressAfter?: string;
  progressOlderThanDays?: number;
  progressNewerThanDays?: number;
  relationKind?: string;
  relatedEntityId?: string;
  referenceRole?: string;
  includeRelations?: boolean;
  includeReferences?: boolean;
  includeArchived?: boolean;
  limit?: number;
  recentEvents?: number;
  trend?: {
    field: string;
    windowDays?: number;
    aggregation?: "raw" | "average" | "min" | "max" | "change";
  };
}

export interface StateQueryResult {
  entities: Array<StateEntity & {
    events?: StateEvent[];
    relations?: StateEntityRelation[];
    references?: StateEntityReference[];
  }>;
  trend?: {
    field: string;
    aggregation: string;
    points: Array<{ occurredAt: string; value: number }>;
    value: number | null;
  };
}

export interface StateDigestOptions extends StateAccessContext {
  conversationKey: string;
  alwaysOnTypes?: readonly string[];
  tokenBudget?: number;
  now?: Date;
}

export interface StateSweepReport {
  evaluated: number;
  stale: number;
  nudges: number;
  expired: number;
  archived: number;
  duplicates: number;
  reconcilerStalled: boolean;
}

export interface StateBoard {
  stale: StateEntity[];
  issues: StateIssue[];
  duplicates: StateIssue[];
  reconciler: {
    lastRunAt: string | null;
    recentFailures: number;
    stalled: boolean;
  };
  recentMemoryArchives: Array<{
    eventId: number;
    memoryId: string;
    entityId: string;
    verdict: string;
    archivedAt: string | null;
    unarchivedAt: string | null;
  }>;
}

export interface StateIssue {
  id: number;
  entityId: string | null;
  kind: string;
  detail: string;
  metadata: Record<string, unknown> | null;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface StateReconcilerRunInput {
  turnId: string;
  conversationKey: string;
  sessionId?: string | null;
  agentId: string;
  providerName: string;
  model: string;
}

export interface StateReconcilerRunFinish {
  status: "ok" | "error";
  proposalCount?: number;
  appliedCount?: number;
  rejectedCount?: number;
  claimedFacts?: string[];
  rejectionReasons?: string[];
  latencyMs?: number;
  error?: string | null;
}

export interface StateServiceOptions {
  now?: () => Date;
  visibilityResolver?: (visibility: string, context: StateAccessContext) => boolean;
}

type EntityChangeListener = (entity: StateEntity, event: StateEvent) => void | Promise<void>;

const DEFAULT_DIGEST_TOKEN_BUDGET = 400;
const DEFAULT_FOCUS_TTL_DAYS = 7;
const RECONCILER_STALL_MINUTES = 30;
const ABSENT_ATTRIBUTE = "__tango_state_absent__";
const RELATION_PATCH_PREFIX = "__relation__:";
const REFERENCE_PATCH_PREFIX = "__reference__:";

interface RelationPatchValue {
  kind: string;
  targetEntityId: string;
  metadata: Record<string, unknown> | null;
}

interface ReferencePatchValue {
  role: string;
  ref: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
  supportsEventId: number | null;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  formats: {
    date: /^\d{4}-\d{2}-\d{2}$/u,
    "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u,
  },
});

export class StateService {
  private readonly validators = new Map<string, { schema: string; validate: ValidateFunction }>();
  private readonly listeners = new Set<EntityChangeListener>();
  private readonly now: () => Date;
  private readonly visibilityResolver: (visibility: string, context: StateAccessContext) => boolean;

  constructor(
    private readonly db: DatabaseSync,
    options: StateServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.visibilityResolver = options.visibilityResolver ?? defaultVisibilityResolver;
  }

  onEntityChanged(listener: EntityChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listTypes(context: StateAccessContext = {}): StateTypeDefinition[] {
    const rows = this.db.prepare(`
      SELECT id, display_name AS displayName, description,
             attributes_schema AS attributesSchema, statuses,
             staleness_policy AS stalenessPolicy,
             digest_template AS digestTemplate, body_fields AS bodyFields,
             visibility, origin, created_at AS createdAt,
             updated_at AS updatedAt, archived_at AS archivedAt
      FROM state_entity_types
      WHERE archived_at IS NULL
      ORDER BY display_name, id
    `).all() as unknown as StateTypeRow[];
    return rows.map(mapStateType).filter((type) => this.canAccessType(type, context));
  }

  getType(typeId: string, context: StateAccessContext = {}): StateTypeDefinition | null {
    const row = this.db.prepare(`
      SELECT id, display_name AS displayName, description,
             attributes_schema AS attributesSchema, statuses,
             staleness_policy AS stalenessPolicy,
             digest_template AS digestTemplate, body_fields AS bodyFields,
             visibility, origin, created_at AS createdAt,
             updated_at AS updatedAt, archived_at AS archivedAt
      FROM state_entity_types WHERE id = ?
    `).get(normalizeTypeId(typeId)) as StateTypeRow | undefined;
    if (!row) return null;
    const type = mapStateType(row);
    return this.canAccessType(type, context) ? type : null;
  }

  defineType(input: {
    id: string;
    displayName: string;
    description?: string | null;
    attributesSchema: Record<string, unknown>;
    statuses?: StateStatusDefinition | null;
    stalenessPolicy?: StateStalenessPolicy | null;
    digestTemplate?: string | null;
    bodyFields?: string[];
    visibility?: string;
    origin?: string;
    confirm?: boolean;
  }, context: StateAccessContext = {}): { created: boolean; type: StateTypeDefinition } {
    if (input.origin === "conversation" && input.confirm !== true) {
      throw new Error("Creating a state type from conversation requires confirm=true after the user's one-line confirmation.");
    }

    const id = normalizeTypeId(input.id);
    const displayName = requireText(input.displayName, "displayName");
    validateTypeSchema(input.attributesSchema);
    validateStatusDefinition(input.statuses ?? null);
    validateBodyFields(input.bodyFields ?? [], input.attributesSchema);
    const existing = this.getTypeUnscoped(id);
    const now = toSqlTimestamp(this.now());

    if (existing) {
      if (!this.canAccessType(existing, context)) {
        throw new Error(`State type '${id}' is not visible to this agent.`);
      }
      assertAdditiveTypeEvolution(existing, input);
      const mergedSchema = mergeAdditiveSchema(existing.attributesSchema, input.attributesSchema);
      const mergedStatuses = mergeAdditiveStatuses(existing.statuses, input.statuses ?? null);
      const mergedBodyFields = [...new Set([...existing.bodyFields, ...(input.bodyFields ?? [])])];
      this.db.prepare(`
        UPDATE state_entity_types SET
          display_name = ?, description = ?, attributes_schema = ?, statuses = ?,
          staleness_policy = ?, digest_template = ?, body_fields = ?, visibility = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        displayName,
        input.description ?? existing.description,
        JSON.stringify(mergedSchema),
        jsonOrNull(mergedStatuses),
        jsonOrNull(input.stalenessPolicy ?? existing.stalenessPolicy),
        input.digestTemplate ?? existing.digestTemplate,
        JSON.stringify(mergedBodyFields),
        input.visibility ?? existing.visibility,
        now,
        id,
      );
      this.validators.delete(id);
      return { created: false, type: this.requireType(id, context) };
    }

    const visibility = input.visibility?.trim() || "shared";
    if (!this.visibilityResolver(visibility, context) && !context.includePrivate) {
      throw new Error(`Cannot define inaccessible state visibility '${visibility}'.`);
    }
    this.db.prepare(`
      INSERT INTO state_entity_types (
        id, display_name, description, attributes_schema, statuses,
        staleness_policy, digest_template, body_fields, visibility, origin,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      displayName,
      input.description ?? null,
      JSON.stringify(input.attributesSchema),
      jsonOrNull(input.statuses ?? null),
      jsonOrNull(input.stalenessPolicy ?? null),
      input.digestTemplate ?? null,
      JSON.stringify(input.bodyFields ?? []),
      visibility,
      input.origin?.trim() || "conversation",
      now,
      now,
    );
    return { created: true, type: this.requireType(id, context) };
  }

  mutate(input: StateEntityMutation, context: StateMutationContext): StateMutationResult {
    const existing = this.resolveEntity(input, context);
    if (!existing) {
      return this.createEntity(input, context);
    }
    return this.updateEntity(existing, input, context);
  }

  archiveEntity(entityId: string, context: StateMutationContext): StateMutationResult {
    return this.mutate({ entityId, archive: true, kind: "archive" }, context);
  }

  restoreEntity(entityId: string, context: StateMutationContext): StateMutationResult {
    return this.mutate({ entityId, restore: true, kind: "restore" }, context);
  }

  revertEvent(eventId: number, context: StateMutationContext): StateMutationResult {
    const original = this.getEvent(eventId);
    if (!original) throw new Error(`State event ${eventId} was not found.`);
    if (original.kind === "revert") throw new Error("A revert event cannot itself be reverted directly; revert its turn instead.");
    const alreadyReverted = this.db.prepare(
      "SELECT id FROM state_events WHERE reverts_event_id = ? LIMIT 1",
    ).get(eventId) as { id: number } | undefined;
    if (alreadyReverted) {
      const entity = this.requireEntity(original.entityId, context, true);
      return { applied: false, entity, event: null, created: false, reason: "already_reverted" };
    }

    const entity = this.requireEntity(original.entityId, context, true);
    const inverse = invertPatch(original.patch ?? {});
    const now = toSqlTimestamp(this.now());
    const occurredAt = normalizeTimestamp(context.occurredAt) ?? now;
    let updated: StateEntity | null = null;
    let event: StateEvent | null = null;

    this.transaction(() => {
      const mutable = cloneEntity(entity);
      applyPatchToEntity(mutable, inverse, { guardAgainst: original.patch ?? {}, now });
      const staleAfter = mutable.lastProgressAt
        ? this.computeStaleAfter(this.requireType(mutable.typeId, context), mutable.lastProgressAt)
        : null;
      this.writeEntityHead(mutable, {
        source: context.source,
        updatedAt: now,
        lastEventAt: occurredAt,
        staleAfter,
      });
      const id = this.insertEvent({
        entityId: mutable.id,
        kind: "revert",
        patch: inverse,
        note: context.actor === "dashboard" ? `Reverted event ${eventId} from dashboard` : `Reverted event ${eventId}`,
        context,
        occurredAt,
        revertsEventId: eventId,
      });
      this.applyLinkPatch(mutable.id, inverse, id, now, original.patch ?? {});
      updated = this.requireEntity(mutable.id, context, true);
      event = this.requireEvent(id);
    });

    this.emitChange(updated!, event!);
    return { applied: true, entity: updated!, event, created: false };
  }

  revertTurn(turnId: string, context: StateMutationContext): {
    applied: number;
    skipped: number;
    results: StateMutationResult[];
    revertedEventIds: number[];
  } {
    const normalized = requireText(turnId, "turnId");
    const events = this.listTurnEvents(normalized)
      .filter((event) => event.kind !== "revert")
      .sort((a, b) => b.id - a.id);
    if (events.length === 0) {
      throw new Error(`No state changes were recorded for turn '${normalized}'.`);
    }
    const results: StateMutationResult[] = [];
    const revertedEventIds: number[] = [];
    for (const event of events) {
      const result = this.revertEvent(event.id, { ...context, turnId: context.turnId ?? normalized });
      results.push(result);
      if (result.applied) revertedEventIds.push(event.id);
    }
    return {
      applied: results.filter((result) => result.applied).length,
      skipped: results.filter((result) => !result.applied).length,
      results,
      revertedEventIds,
    };
  }

  query(input: StateQueryInput = {}): StateQueryResult {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    const nowDate = this.now();
    const now = toSqlTimestamp(nowDate);
    if (!input.includeArchived) conditions.push("e.archived_at IS NULL");
    if (input.entityId) {
      conditions.push("e.id = ?");
      values.push(input.entityId.trim());
    }
    if (input.type) {
      conditions.push("e.type_id = ?");
      values.push(normalizeTypeId(input.type));
    }
    if (input.status) {
      conditions.push("e.status = ?");
      values.push(input.status.trim());
    }
    if (input.stale === true) {
      conditions.push("e.stale_after IS NOT NULL AND datetime(e.stale_after) <= datetime(?)");
      values.push(now);
    }
    if (input.stale === false) {
      conditions.push("(e.stale_after IS NULL OR datetime(e.stale_after) > datetime(?))");
      values.push(now);
    }
    if (input.overdue === true) {
      conditions.push("e.archived_at IS NULL AND e.due_at IS NOT NULL AND datetime(e.due_at) <= datetime(?) AND e.closed_at IS NULL");
      values.push(now);
    }
    if (input.overdue === false) {
      conditions.push("(e.archived_at IS NOT NULL OR e.due_at IS NULL OR datetime(e.due_at) > datetime(?) OR e.closed_at IS NOT NULL)");
      values.push(now);
    }
    addExactCondition(conditions, values, "e.project_entity_id", input.projectEntityId);
    addExactCondition(conditions, values, "e.owner_user_id", input.ownerUserId);
    addExactCondition(conditions, values, "e.owner_agent_id", input.ownerAgentId);
    addExactCondition(conditions, values, "e.source", input.source);
    addTimestampCondition(conditions, values, "e.due_at", "<=", input.dueBefore, "dueBefore");
    addTimestampCondition(conditions, values, "e.due_at", ">=", input.dueAfter, "dueAfter");
    addTimestampCondition(conditions, values, "e.next_check_at", "<=", input.nextCheckBefore, "nextCheckBefore");
    addTimestampCondition(conditions, values, "e.next_check_at", ">=", input.nextCheckAfter, "nextCheckAfter");
    addTimestampCondition(conditions, values, "e.expected_response_at", "<=", input.expectedResponseBefore, "expectedResponseBefore");
    addTimestampCondition(conditions, values, "e.expected_response_at", ">=", input.expectedResponseAfter, "expectedResponseAfter");
    addTimestampCondition(conditions, values, "e.last_progress_at", "<=", input.lastProgressBefore, "lastProgressBefore");
    addTimestampCondition(conditions, values, "e.last_progress_at", ">=", input.lastProgressAfter, "lastProgressAfter");
    if (input.progressOlderThanDays !== undefined) {
      const days = normalizeProgressDays(input.progressOlderThanDays, "progressOlderThanDays");
      conditions.push("e.last_progress_at IS NOT NULL AND datetime(e.last_progress_at) <= datetime(?)");
      values.push(toSqlTimestamp(new Date(nowDate.getTime() - days * 86_400_000)));
    }
    if (input.progressNewerThanDays !== undefined) {
      const days = normalizeProgressDays(input.progressNewerThanDays, "progressNewerThanDays");
      conditions.push("e.last_progress_at IS NOT NULL AND datetime(e.last_progress_at) >= datetime(?)");
      values.push(toSqlTimestamp(new Date(nowDate.getTime() - days * 86_400_000)));
    }
    if (input.text?.trim()) {
      conditions.push("(lower(e.title) LIKE ? OR lower(e.slug) LIKE ? OR lower(COALESCE(e.aliases, '')) LIKE ? OR lower(COALESCE(e.summary, '')) LIKE ?)");
      const term = `%${input.text.trim().toLowerCase()}%`;
      values.push(term, term, term, term);
    }
    const limit = clampInt(input.limit ?? 50, 1, 500);
    const needsRelationFilter = Boolean(input.relationKind?.trim() || input.relatedEntityId?.trim());
    const needsReferenceFilter = Boolean(input.referenceRole?.trim());
    const needsLinkFilter = needsRelationFilter || needsReferenceFilter;
    if (!needsLinkFilter) values.push(limit);
    const rows = this.db.prepare(`
      SELECT e.id, e.type_id AS typeId, e.slug, e.title, e.aliases,
             e.status, e.attributes, e.summary, e.body_pointer AS bodyPointer,
             e.body_fields_hash AS bodyFieldsHash, e.owner_user_id AS ownerUserId,
             e.owner_agent_id AS ownerAgentId,
             e.project_entity_id AS projectEntityId, e.visibility AS entityVisibility,
             e.due_at AS dueAt, e.next_check_at AS nextCheckAt,
             e.expected_response_at AS expectedResponseAt,
             e.last_progress_at AS lastProgressAt, e.closed_at AS closedAt, e.source,
             e.last_event_at AS lastEventAt, e.stale_after AS staleAfter,
             e.created_at AS createdAt, e.updated_at AS updatedAt,
             e.archived_at AS archivedAt, t.visibility AS typeVisibility,
             p.visibility AS projectEntityVisibility,
             pt.visibility AS projectTypeVisibility
      FROM state_entities e
      JOIN state_entity_types t ON t.id = e.type_id
      LEFT JOIN state_entities p ON p.id = e.project_entity_id
      LEFT JOIN state_entity_types pt ON pt.id = p.type_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY e.archived_at IS NOT NULL, datetime(e.updated_at) DESC, e.title
      ${needsLinkFilter ? "" : "LIMIT ?"}
    `).all(...values) as unknown as EntityRowWithVisibility[];

    const recentEvents = clampInt(input.recentEvents ?? (input.entityId ? 20 : 0), 0, 100);
    const entitiesWithLinks = rows
      .filter((row) => this.canAccessEntityRow(row, input))
      .map((row) => {
        const entity = mapStateEntity(row, nowDate);
        return {
          ...entity,
          ...(recentEvents > 0 ? { events: this.listEvents(entity.id, recentEvents) } : {}),
          ...(input.includeRelations || needsRelationFilter ? { relations: this.listRelations(entity.id, input) } : {}),
          ...(input.includeReferences || needsReferenceFilter ? { references: this.listReferences(entity.id, input) } : {}),
        };
      });
    const entities = entitiesWithLinks
      .filter((entity) => {
        if (needsRelationFilter && !(entity.relations ?? []).some((relation) => {
          return (!input.relationKind?.trim() || relation.kind === input.relationKind.trim())
            && (!input.relatedEntityId?.trim() || relation.targetEntityId === input.relatedEntityId.trim());
        })) return false;
        if (needsReferenceFilter && !(entity.references ?? []).some((reference) => reference.role === input.referenceRole!.trim())) {
          return false;
        }
        return true;
      })
      .slice(0, limit)
      .map((entity) => {
        if (!input.includeRelations) delete entity.relations;
        if (!input.includeReferences) delete entity.references;
        return entity;
      });

    const result: StateQueryResult = { entities };
    if (input.trend) {
      if (entities.length !== 1) {
        throw new Error("A trend query must resolve exactly one entity (provide entityId or narrower filters).");
      }
      result.trend = this.queryTrend(entities[0]!.id, input.trend);
    }
    return result;
  }

  getEntity(entityId: string, context: StateAccessContext = {}, includeArchived = false): StateEntity | null {
    try {
      return this.requireEntity(entityId, context, includeArchived);
    } catch {
      return null;
    }
  }

  listEvents(entityId: string, limit = 50): StateEvent[] {
    const rows = this.db.prepare(`
      SELECT id, entity_id AS entityId, kind, patch, note, actor,
             session_id AS sessionId, message_id AS messageId, turn_id AS turnId,
             reverts_event_id AS revertsEventId, occurred_at AS occurredAt,
             recorded_at AS recordedAt
      FROM state_events WHERE entity_id = ?
      ORDER BY datetime(occurred_at) DESC, id DESC LIMIT ?
    `).all(entityId, clampInt(limit, 1, 500)) as unknown as StateEventRow[];
    return rows.map(mapStateEvent);
  }

  listRelations(entityId: string, context: StateAccessContext = {}, includeArchived = false): StateEntityRelation[] {
    if (!this.getEntity(entityId, context, true)) return [];
    const rows = this.db.prepare(`
      SELECT id, source_entity_id AS sourceEntityId, target_entity_id AS targetEntityId,
             kind, metadata, created_event_id AS createdEventId,
             archived_event_id AS archivedEventId, created_at AS createdAt,
             archived_at AS archivedAt
      FROM state_entity_relations
      WHERE source_entity_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY archived_at IS NOT NULL, kind, target_entity_id, id
    `).all(entityId) as unknown as StateEntityRelationRow[];
    return rows
      .map(mapStateEntityRelation)
      .filter((relation) => Boolean(this.getEntity(relation.targetEntityId, context, true)));
  }

  listReferences(entityId: string, context: StateAccessContext = {}, includeArchived = false): StateEntityReference[] {
    if (!this.getEntity(entityId, context, true)) return [];
    const rows = this.db.prepare(`
      SELECT id, entity_id AS entityId, role, ref, label, metadata,
             supports_event_id AS supportsEventId, created_event_id AS createdEventId,
             archived_event_id AS archivedEventId, created_at AS createdAt,
             archived_at AS archivedAt
      FROM state_entity_references
      WHERE entity_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY archived_at IS NOT NULL, role, ref, id
    `).all(entityId) as unknown as StateEntityReferenceRow[];
    return rows.map(mapStateEntityReference).filter((reference) => {
      if (reference.supportsEventId === null) return true;
      const event = this.getEvent(reference.supportsEventId);
      return Boolean(event && this.getEntity(event.entityId, context, true));
    });
  }

  listTurnEvents(turnId: string): StateEvent[] {
    const rows = this.db.prepare(`
      SELECT id, entity_id AS entityId, kind, patch, note, actor,
             session_id AS sessionId, message_id AS messageId, turn_id AS turnId,
             reverts_event_id AS revertsEventId, occurred_at AS occurredAt,
             recorded_at AS recordedAt
      FROM state_events WHERE turn_id = ? ORDER BY id
    `).all(turnId) as unknown as StateEventRow[];
    return rows.map(mapStateEvent);
  }

  findLatestTurnId(sessionId: string, excludeTurnId?: string): string | null {
    const row = this.db.prepare(`
      SELECT turn_id AS turnId FROM state_events
      WHERE session_id = ? AND turn_id IS NOT NULL
        AND (? IS NULL OR turn_id != ?)
      ORDER BY datetime(recorded_at) DESC, id DESC LIMIT 1
    `).get(sessionId, excludeTurnId ?? null, excludeTurnId ?? null) as { turnId: string } | undefined;
    return row?.turnId ?? null;
  }

  renderTurnReceipt(turnId: string): string | null {
    const events = this.listTurnEvents(turnId);
    if (events.length === 0) return null;
    const prefix = "⟢ state: ";
    const pieces: string[] = [];
    let omitted = Math.max(0, events.length - MAX_TURN_RECEIPT_EVENTS);
    const appendPiece = (piece: string): void => {
      const separatorLength = pieces.length > 0 ? 3 : 0;
      const reservedOverflowLength = RECEIPT_OVERFLOW_RESERVE;
      if (
        pieces.length >= MAX_TURN_RECEIPT_PIECES
        || prefix.length + pieces.join(" · ").length + separatorLength + piece.length + reservedOverflowLength
          > MAX_TURN_RECEIPT_CHARS
      ) {
        omitted += 1;
        return;
      }
      pieces.push(piece);
    };
    for (const event of events.slice(0, MAX_TURN_RECEIPT_EVENTS)) {
      const entity = this.getEntityUnscoped(event.entityId, true);
      if (!entity) continue;
      if (event.kind === "create") {
        appendPiece(`NEW ${entity.typeId}/${entity.slug}${entity.status ? ` (${entity.status})` : ""}`);
        continue;
      }
      if (event.kind === "revert") {
        appendPiece(`${entity.typeId}/${entity.slug} reverted event ${event.revertsEventId ?? ""}`.trim());
        continue;
      }
      if (event.kind === "archive" || event.kind === "restore") {
        appendPiece(`${entity.typeId}/${entity.slug} ${event.kind}d`);
        continue;
      }
      for (const [field, change] of Object.entries(event.patch ?? {})) {
        if (field === "__created__") continue;
        appendPiece(renderReceiptPatch(entity, field, change));
      }
      if (Object.keys(event.patch ?? {}).length === 0 && event.note) {
        appendPiece(`${entity.typeId}/${entity.slug} note recorded`);
      }
    }
    if (pieces.length === 0) return null;
    const overflow = omitted > 0 ? ` · +${omitted} more` : "";
    return `⟢ state: ${pieces.join(" · ")}${overflow}`;
  }

  focusEntities(conversationKey: string, entityIds: readonly string[], ttlDays = DEFAULT_FOCUS_TTL_DAYS): number {
    const key = requireText(conversationKey, "conversationKey");
    const now = this.now();
    const updatedAt = toSqlTimestamp(now);
    const expiresAt = toSqlTimestamp(new Date(now.getTime() + Math.max(ttlDays, 1) * 86_400_000));
    let changed = 0;
    for (const entityId of [...new Set(entityIds.filter(Boolean))]) {
      const result = this.db.prepare(`
        INSERT INTO state_focus (conversation_key, entity_id, updated_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_key, entity_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `).run(key, entityId, updatedAt, expiresAt);
      changed += Number(result.changes);
    }
    this.db.prepare("DELETE FROM state_focus WHERE datetime(expires_at) <= datetime(?)").run(updatedAt);
    return changed;
  }

  buildDigest(options: StateDigestOptions): string | undefined {
    const budgetTokens = clampInt(options.tokenBudget ?? DEFAULT_DIGEST_TOKEN_BUDGET, 50, 2_000);
    const maxChars = budgetTokens * 4;
    const now = options.now ?? this.now();
    const types = new Map(this.listTypes(options).map((type) => [type.id, type]));
    const selected: StateEntity[] = [];
    const seen = new Set<string>();
    const focusedIds = new Set<string>();
    const addRows = (rows: StateEntity[]) => {
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          selected.push(row);
        }
      }
    };

    const focusedRows = this.db.prepare(`
      SELECT e.id, e.type_id AS typeId, e.slug, e.title, e.aliases,
             e.status, e.attributes, e.summary, e.body_pointer AS bodyPointer,
             e.body_fields_hash AS bodyFieldsHash, e.owner_user_id AS ownerUserId,
             e.owner_agent_id AS ownerAgentId,
             e.project_entity_id AS projectEntityId, e.visibility AS entityVisibility,
             e.due_at AS dueAt, e.next_check_at AS nextCheckAt,
             e.expected_response_at AS expectedResponseAt,
             e.last_progress_at AS lastProgressAt, e.closed_at AS closedAt, e.source,
             e.last_event_at AS lastEventAt, e.stale_after AS staleAfter,
             e.created_at AS createdAt, e.updated_at AS updatedAt,
             e.archived_at AS archivedAt, t.visibility AS typeVisibility,
             p.visibility AS projectEntityVisibility,
             pt.visibility AS projectTypeVisibility
      FROM state_focus f
      JOIN state_entities e ON e.id = f.entity_id
      JOIN state_entity_types t ON t.id = e.type_id
      LEFT JOIN state_entities p ON p.id = e.project_entity_id
      LEFT JOIN state_entity_types pt ON pt.id = p.type_id
      WHERE f.conversation_key = ? AND datetime(f.expires_at) > datetime(?)
        AND e.archived_at IS NULL
      ORDER BY datetime(f.updated_at) DESC
    `).all(options.conversationKey, toSqlTimestamp(now)) as unknown as EntityRowWithVisibility[];
    const visibleFocusedRows = this.mapVisibleEntities(focusedRows, options, now);
    for (const row of visibleFocusedRows) focusedIds.add(row.id);
    addRows(visibleFocusedRows);

    const alwaysOn = [...new Set(options.alwaysOnTypes ?? [])].filter((type) => types.has(type));
    if (alwaysOn.length > 0) {
      const placeholders = alwaysOn.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT e.id, e.type_id AS typeId, e.slug, e.title, e.aliases,
               e.status, e.attributes, e.summary, e.body_pointer AS bodyPointer,
               e.body_fields_hash AS bodyFieldsHash, e.owner_user_id AS ownerUserId,
               e.owner_agent_id AS ownerAgentId,
               e.project_entity_id AS projectEntityId, e.visibility AS entityVisibility,
               e.due_at AS dueAt, e.next_check_at AS nextCheckAt,
               e.expected_response_at AS expectedResponseAt,
               e.last_progress_at AS lastProgressAt, e.closed_at AS closedAt, e.source,
               e.last_event_at AS lastEventAt, e.stale_after AS staleAfter,
               e.created_at AS createdAt, e.updated_at AS updatedAt,
               e.archived_at AS archivedAt, t.visibility AS typeVisibility,
               p.visibility AS projectEntityVisibility,
               pt.visibility AS projectTypeVisibility
        FROM state_entities e JOIN state_entity_types t ON t.id = e.type_id
        LEFT JOIN state_entities p ON p.id = e.project_entity_id
        LEFT JOIN state_entity_types pt ON pt.id = p.type_id
        WHERE e.archived_at IS NULL AND e.type_id IN (${placeholders})
        ORDER BY datetime(e.updated_at) DESC
      `).all(...alwaysOn) as unknown as EntityRowWithVisibility[];
      addRows(this.mapVisibleEntities(rows, options, now));
    }

    const recentRows = this.db.prepare(`
      SELECT e.id, e.type_id AS typeId, e.slug, e.title, e.aliases,
             e.status, e.attributes, e.summary, e.body_pointer AS bodyPointer,
             e.body_fields_hash AS bodyFieldsHash, e.owner_user_id AS ownerUserId,
             e.owner_agent_id AS ownerAgentId,
             e.project_entity_id AS projectEntityId, e.visibility AS entityVisibility,
             e.due_at AS dueAt, e.next_check_at AS nextCheckAt,
             e.expected_response_at AS expectedResponseAt,
             e.last_progress_at AS lastProgressAt, e.closed_at AS closedAt, e.source,
             e.last_event_at AS lastEventAt, e.stale_after AS staleAfter,
             e.created_at AS createdAt, e.updated_at AS updatedAt,
             e.archived_at AS archivedAt, t.visibility AS typeVisibility,
             p.visibility AS projectEntityVisibility,
             pt.visibility AS projectTypeVisibility
      FROM state_entities e JOIN state_entity_types t ON t.id = e.type_id
      LEFT JOIN state_entities p ON p.id = e.project_entity_id
      LEFT JOIN state_entity_types pt ON pt.id = p.type_id
      WHERE e.archived_at IS NULL AND datetime(e.updated_at) >= datetime(?, '-24 hours')
      ORDER BY datetime(e.updated_at) DESC
    `).all(toSqlTimestamp(now)) as unknown as EntityRowWithVisibility[];
    addRows(this.mapVisibleEntities(recentRows, options, now));

    const staleRows = this.db.prepare(`
      SELECT e.id, e.type_id AS typeId, e.slug, e.title, e.aliases,
             e.status, e.attributes, e.summary, e.body_pointer AS bodyPointer,
             e.body_fields_hash AS bodyFieldsHash, e.owner_user_id AS ownerUserId,
             e.owner_agent_id AS ownerAgentId,
             e.project_entity_id AS projectEntityId, e.visibility AS entityVisibility,
             e.due_at AS dueAt, e.next_check_at AS nextCheckAt,
             e.expected_response_at AS expectedResponseAt,
             e.last_progress_at AS lastProgressAt, e.closed_at AS closedAt, e.source,
             e.last_event_at AS lastEventAt, e.stale_after AS staleAfter,
             e.created_at AS createdAt, e.updated_at AS updatedAt,
             e.archived_at AS archivedAt, t.visibility AS typeVisibility,
             p.visibility AS projectEntityVisibility,
             pt.visibility AS projectTypeVisibility
      FROM state_entities e JOIN state_entity_types t ON t.id = e.type_id
      LEFT JOIN state_entities p ON p.id = e.project_entity_id
      LEFT JOIN state_entity_types pt ON pt.id = p.type_id
      WHERE e.archived_at IS NULL AND e.stale_after IS NOT NULL
        AND datetime(e.stale_after) <= datetime(?)
      ORDER BY datetime(e.updated_at) DESC
    `).all(toSqlTimestamp(now)) as unknown as EntityRowWithVisibility[];
    addRows(this.mapVisibleEntities(staleRows, options, now));

    if (selected.length === 0) return undefined;
    const header = "state (canonical — overrides anything remembered):";
    const lines = [header];
    let used = header.length;
    let omitted = 0;
    for (const entity of selected) {
      const type = types.get(entity.typeId);
      if (!type) continue;
      const rendered = `- [${entity.typeId}] ${renderDigestTemplate(type, entity, now)}`;
      if (used + rendered.length + 1 > maxChars) {
        if (focusedIds.has(entity.id)) {
          const available = maxChars - used - 1;
          const compact = `- [${entity.typeId}] ${entity.title}`;
          if (available >= 12) {
            const focusedLine = truncateText(compact, available);
            lines.push(focusedLine);
            used += focusedLine.length + 1;
            continue;
          }
        }
        omitted += 1;
        continue;
      }
      lines.push(rendered);
      used += rendered.length + 1;
    }
    if (omitted > 0) {
      const summary = `- (${omitted} more: use state_query)`;
      if (used + summary.length + 1 <= maxChars) lines.push(summary);
    }
    return lines.join("\n");
  }

  buildNameIndex(context: StateAccessContext = {}): Array<{
    id: string;
    typeId: string;
    title: string;
    aliases: string[];
  }> {
    return this.query({ ...context, limit: 500 }).entities.map((entity) => ({
      id: entity.id,
      typeId: entity.typeId,
      title: entity.title,
      aliases: entity.aliases,
    }));
  }

  buildReconcilerSnapshot(context: StateAccessContext & {
    conversationKey: string;
    alwaysOnTypes?: readonly string[];
    recentEvents?: number;
  }): {
    nameIndex: ReturnType<StateService["buildNameIndex"]>;
    entities: Array<StateEntity & { events: StateEvent[] }>;
    types: StateTypeDefinition[];
  } {
    const types = this.listTypes(context);
    const focused = this.db.prepare(`
      SELECT entity_id AS entityId FROM state_focus
      WHERE conversation_key = ? AND datetime(expires_at) > datetime(?)
      ORDER BY datetime(updated_at) DESC
    `).all(context.conversationKey, toSqlTimestamp(this.now())) as Array<{ entityId: string }>;
    const ids = new Set(focused.map((row) => row.entityId));
    for (const entity of this.query({ ...context, limit: 200 }).entities) {
      if ((context.alwaysOnTypes ?? []).includes(entity.typeId)) ids.add(entity.id);
      if (entity.stale || withinHours(entity.updatedAt, this.now(), 24)) ids.add(entity.id);
    }
    const entities = [...ids].flatMap((id) => {
      const entity = this.getEntity(id, context);
      return entity ? [{ ...entity, events: this.listEvents(id, context.recentEvents ?? 5) }] : [];
    });
    return { nameIndex: this.buildNameIndex(context), entities, types };
  }

  startReconcilerRun(input: StateReconcilerRunInput): number {
    const result = this.db.prepare(`
      INSERT INTO state_reconciler_runs (
        turn_id, conversation_key, session_id, agent_id, provider_name,
        model, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        status = 'running', provider_name = excluded.provider_name,
        model = excluded.model, error = NULL, completed_at = NULL
      RETURNING id
    `).get(
      input.turnId,
      input.conversationKey,
      input.sessionId ?? null,
      input.agentId,
      input.providerName,
      input.model,
      toSqlTimestamp(this.now()),
    ) as { id: number | bigint };
    return Number(result.id);
  }

  finishReconcilerRun(turnId: string, input: StateReconcilerRunFinish): void {
    this.db.prepare(`
      UPDATE state_reconciler_runs SET
        status = ?, proposal_count = ?, applied_count = ?, rejected_count = ?,
        claimed_facts = ?, rejection_reasons = ?, latency_ms = ?, error = ?,
        completed_at = ?
      WHERE turn_id = ?
    `).run(
      input.status,
      input.proposalCount ?? 0,
      input.appliedCount ?? 0,
      input.rejectedCount ?? 0,
      jsonOrNull(input.claimedFacts ?? []),
      jsonOrNull(input.rejectionReasons ?? []),
      input.latencyMs ?? null,
      input.error ?? null,
      toSqlTimestamp(this.now()),
      turnId,
    );
  }

  sweep(): StateSweepReport {
    const now = this.now();
    const entities = this.query({ includePrivate: true, includeArchived: false, limit: 500 }).entities;
    let stale = 0;
    let nudges = 0;
    let expired = 0;
    let archived = 0;
    for (const entity of entities) {
      const type = this.getTypeUnscoped(entity.typeId);
      if (!type) continue;
      const policy = type.stalenessPolicy;
      const isStale = Boolean(entity.staleAfter && new Date(entity.staleAfter).getTime() <= now.getTime());
      if (isStale) {
        stale += 1;
        if (policy?.on_stale === "nudge") {
          if (this.openIssue(entity.id, "stale", `${entity.title} is stale since ${entity.staleAfter}.`, { staleAfter: entity.staleAfter })) {
            nudges += 1;
          }
        } else if (policy?.on_stale === "expire") {
          const expiredStatus = type.statuses?.values.includes("expired") ? "expired" : null;
          if (expiredStatus && entity.status !== expiredStatus) {
            this.mutate({ entityId: entity.id, status: expiredStatus, kind: "status_change", note: "Auto-expired by state sweep" }, sweepContext(now));
            expired += 1;
          } else if (!expiredStatus && !entity.archivedAt) {
            this.archiveEntity(entity.id, sweepContext(now));
            archived += 1;
          }
        } else if (policy?.on_stale === "archive" && !entity.archivedAt) {
          this.archiveEntity(entity.id, sweepContext(now));
          archived += 1;
        }
      } else {
        this.resolveIssues(entity.id, "stale");
      }

      const endDate = stringValue(entity.attributes.end_date);
      const archiveDelay = numericValue(policy?.archive_after_end_days);
      if (endDate && archiveDelay !== null) {
        const deadline = new Date(`${endDate}T23:59:59.999Z`).getTime() + archiveDelay * 86_400_000;
        if (Number.isFinite(deadline) && deadline <= now.getTime() && !entity.archivedAt) {
          this.archiveEntity(entity.id, { ...sweepContext(now), occurredAt: new Date(deadline).toISOString() });
          archived += 1;
        }
      }
    }

    const duplicates = this.detectDuplicateEntities(entities);
    const lastRun = this.getLastReconcilerRun();
    const reconcilerStalled = !lastRun || now.getTime() - new Date(lastRun.createdAt).getTime() > RECONCILER_STALL_MINUTES * 60_000;
    if (reconcilerStalled) {
      this.openIssue(null, "reconciler_stalled", "State Reconciler has not completed a recent run.", { lastRunAt: lastRun?.createdAt ?? null });
    } else {
      this.resolveIssues(null, "reconciler_stalled");
    }
    this.db.prepare("DELETE FROM state_focus WHERE datetime(expires_at) <= datetime(?)").run(toSqlTimestamp(now));
    return { evaluated: entities.length, stale, nudges, expired, archived, duplicates, reconcilerStalled };
  }

  getBoard(context: StateAccessContext = {}): StateBoard {
    const stale = this.query({ ...context, stale: true, limit: 200 }).entities;
    const issues = this.listIssues("open").filter((issue) => {
      if (!issue.entityId) return true;
      return Boolean(this.getEntity(issue.entityId, context, true));
    });
    const lastRun = this.getLastReconcilerRun();
    const recentFailuresRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM state_reconciler_runs
      WHERE status = 'error' AND datetime(created_at) >= datetime('now', '-24 hours')
    `).get() as { count: number | bigint };
    const stalled = !lastRun || this.now().getTime() - new Date(lastRun.createdAt).getTime() > RECONCILER_STALL_MINUTES * 60_000;
    const recentMemoryArchives = this.db.prepare(`
      SELECT event_id AS eventId, memory_id AS memoryId, entity_id AS entityId,
             verdict, archived_at AS archivedAt, unarchived_at AS unarchivedAt
      FROM state_memory_links
      WHERE archived_at IS NOT NULL
      ORDER BY datetime(archived_at) DESC LIMIT 50
    `).all() as StateBoard["recentMemoryArchives"];
    return {
      stale,
      issues,
      duplicates: issues.filter((issue) => issue.kind === "duplicate"),
      reconciler: {
        lastRunAt: lastRun?.createdAt ?? null,
        recentFailures: Number(recentFailuresRow.count),
        stalled,
      },
      recentMemoryArchives,
    };
  }

  openIssue(entityId: string | null, kind: string, detail: string, metadata?: Record<string, unknown>): boolean {
    const existing = this.db.prepare(`
      SELECT id FROM state_issues
      WHERE status = 'open' AND kind = ?
        AND ((entity_id = ?) OR (entity_id IS NULL AND ? IS NULL))
        AND detail = ? LIMIT 1
    `).get(kind, entityId, entityId, detail) as { id: number } | undefined;
    if (existing) return false;
    this.db.prepare(`
      INSERT INTO state_issues (entity_id, kind, detail, metadata, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(entityId, kind, detail, jsonOrNull(metadata ?? null), toSqlTimestamp(this.now()), toSqlTimestamp(this.now()));
    return true;
  }

  resolveIssues(entityId: string | null, kind: string): number {
    const now = toSqlTimestamp(this.now());
    const result = this.db.prepare(`
      UPDATE state_issues SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE status = 'open' AND kind = ?
        AND ((entity_id = ?) OR (entity_id IS NULL AND ? IS NULL))
    `).run(now, now, kind, entityId, entityId);
    return Number(result.changes);
  }

  listIssues(status?: "open" | "resolved"): StateIssue[] {
    const rows = this.db.prepare(`
      SELECT id, entity_id AS entityId, kind, detail, metadata, status,
             created_at AS createdAt, updated_at AS updatedAt,
             resolved_at AS resolvedAt
      FROM state_issues ${status ? "WHERE status = ?" : ""}
      ORDER BY status = 'open' DESC, datetime(created_at) DESC
    `).all(...(status ? [status] : [])) as unknown as StateIssueRow[];
    return rows.map((row) => ({ ...row, metadata: parseJsonObject(row.metadata) }));
  }

  setBodyFieldsHash(entityId: string, hash: string | null): void {
    this.db.prepare("UPDATE state_entities SET body_fields_hash = ? WHERE id = ?").run(hash, entityId);
  }

  static hashBodyFields(values: Record<string, unknown>): string {
    return createHash("sha256").update(stableStringify(values)).digest("hex");
  }

  listLinkedEntities(context: StateAccessContext = {}): Array<{ entity: StateEntity; type: StateTypeDefinition }> {
    return this.query({ ...context, includeArchived: false, limit: 500 }).entities.flatMap((entity) => {
      if (!entity.bodyPointer) return [];
      const type = this.getType(entity.typeId, context);
      return type && type.bodyFields.length > 0 ? [{ entity, type }] : [];
    });
  }

  getAdapterCursor(adapterId: string): { cursor: string | null; metadata: Record<string, unknown> | null } | null {
    const row = this.db.prepare(
      "SELECT cursor, metadata FROM state_adapter_cursors WHERE adapter_id = ?",
    ).get(adapterId) as { cursor: string | null; metadata: string | null } | undefined;
    return row ? { cursor: row.cursor, metadata: parseJsonObject(row.metadata) } : null;
  }

  setAdapterCursor(adapterId: string, cursor: string | null, metadata?: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO state_adapter_cursors (adapter_id, cursor, metadata, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET
        cursor = excluded.cursor, metadata = excluded.metadata, updated_at = excluded.updated_at
    `).run(adapterId, cursor, jsonOrNull(metadata ?? null), toSqlTimestamp(this.now()));
  }

  linkMemoryVerdict(input: {
    eventId: number;
    memoryId: string;
    entityId: string;
    verdict: string;
    archived?: boolean;
  }): void {
    this.db.prepare(`
      INSERT INTO state_memory_links (
        event_id, memory_id, entity_id, verdict, archived_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, memory_id) DO UPDATE SET
        verdict = excluded.verdict,
        archived_at = COALESCE(excluded.archived_at, state_memory_links.archived_at),
        unarchived_at = NULL
    `).run(
      input.eventId,
      input.memoryId,
      input.entityId,
      input.verdict,
      input.archived ? toSqlTimestamp(this.now()) : null,
      toSqlTimestamp(this.now()),
    );
  }

  hasMemoryVerdict(eventId: number, memoryId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM state_memory_links WHERE event_id = ? AND memory_id = ? LIMIT 1",
    ).get(eventId, memoryId));
  }

  getArchivedMemoryIdsForEvents(eventIds: readonly number[]): string[] {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT DISTINCT memory_id AS memoryId FROM state_memory_links
      WHERE event_id IN (${placeholders}) AND archived_at IS NOT NULL AND unarchived_at IS NULL
    `).all(...eventIds) as Array<{ memoryId: string }>;
    return rows.map((row) => row.memoryId);
  }

  markMemoriesUnarchived(memoryIds: readonly string[]): void {
    if (memoryIds.length === 0) return;
    const placeholders = memoryIds.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE state_memory_links SET unarchived_at = ?
      WHERE memory_id IN (${placeholders}) AND unarchived_at IS NULL
    `).run(toSqlTimestamp(this.now()), ...memoryIds);
  }

  listDueCheckIns(): Array<{
    entity: StateEntity;
    type: StateTypeDefinition;
    agentId: string;
    prompt: string;
  }> {
    const now = this.now();
    const output: Array<{ entity: StateEntity; type: StateTypeDefinition; agentId: string; prompt: string }> = [];
    for (const entity of this.query({ includePrivate: true, limit: 500 }).entities) {
      const type = this.getTypeUnscoped(entity.typeId);
      const days = numericValue(type?.stalenessPolicy?.check_in_days);
      if (!type || days === null || days <= 0) continue;
      const last = this.db.prepare(`
        SELECT occurred_at AS occurredAt FROM state_events
        WHERE entity_id = ? AND kind = 'check_in'
        ORDER BY datetime(occurred_at) DESC, id DESC LIMIT 1
      `).get(entity.id) as { occurredAt: string } | undefined;
      const reference = new Date(last?.occurredAt ?? entity.lastEventAt ?? entity.createdAt).getTime();
      if (reference + days * 86_400_000 > now.getTime()) continue;
      output.push({
        entity,
        type,
        agentId: stringValue(type.stalenessPolicy?.check_in_agent) ?? entity.ownerAgentId ?? "watson-ollama",
        prompt: stringValue(type.stalenessPolicy?.check_in_prompt)
          ?? `Ask the user for their scheduled ${type.displayName.toLowerCase()} check-in for ${entity.title}.`,
      });
    }
    return output;
  }

  markCheckInPrompted(entityId: string, context: StateMutationContext): StateMutationResult {
    return this.mutate({ entityId, kind: "check_in", note: "Scheduled check-in prompted" }, context);
  }

  private createEntity(input: StateEntityMutation, context: StateMutationContext): StateMutationResult {
    if (!input.typeId) throw new Error("typeId is required when creating a state entity.");
    if (!input.title) throw new Error("title is required when creating a state entity.");
    const type = this.requireType(input.typeId, context);
    const title = requireText(input.title, "title");
    const duplicate = this.findMatchingEntity(
      type.id,
      title,
      input.aliases ?? [],
      context,
      input.matchStrategy,
    );
    if (duplicate) {
      return this.updateEntity(duplicate, input, context);
    }
    const attributes = { ...(input.attributes ?? {}) };
    this.validateAttributes(type, attributes);
    const status = normalizeNewStatus(type, input.status);
    const slug = this.uniqueSlug(type.id, title);
    const id = `${type.id}:${slug}`;
    const aliases = normalizeAliases(input.aliases ?? []);
    const now = toSqlTimestamp(this.now());
    const occurredAt = normalizeTimestamp(context.occurredAt) ?? now;
    const projectEntityId = this.validateProjectAssociation(input.projectEntityId, context, id);
    const visibility = this.validateEntityVisibility(input.visibility, context);
    const dueAt = normalizeNullableTimestamp(input.dueAt, "dueAt");
    const nextCheckAt = normalizeNullableTimestamp(input.nextCheckAt, "nextCheckAt");
    const expectedResponseAt = normalizeNullableTimestamp(input.expectedResponseAt, "expectedResponseAt");
    const explicitProgressAt = normalizeNullableTimestamp(input.lastProgressAt, "lastProgressAt");
    const lastProgressAt = input.markProgress === false ? explicitProgressAt : explicitProgressAt ?? occurredAt;
    const closedAt = isTerminalStatus(type, status) ? occurredAt : null;
    const summary = normalizeNullableText(input.summary ?? null);
    const bodyPointer = normalizeNullableText(input.bodyPointer ?? null);
    const ownerUserId = normalizeNullableText(input.ownerUserId ?? null);
    const ownerAgentId = normalizeNullableText(input.ownerAgentId ?? context.agentId ?? null);
    const staleAfter = lastProgressAt ? this.computeStaleAfter(type, lastProgressAt) : null;
    const patch: Record<string, StatePatchValue> = {
      __created__: { from: false, to: true },
      title: { from: null, to: title },
      attributes: { from: null, to: attributes },
    };
    if (status !== null) patch.status = { from: null, to: status };
    if (aliases.length > 0) patch.aliases = { from: [], to: aliases };
    if (summary !== null) patch.summary = { from: null, to: summary };
    if (bodyPointer !== null) patch.bodyPointer = { from: null, to: bodyPointer };
    if (ownerUserId !== null) patch.ownerUserId = { from: null, to: ownerUserId };
    if (ownerAgentId !== null) patch.ownerAgentId = { from: null, to: ownerAgentId };
    if (projectEntityId !== null) patch.projectEntityId = { from: null, to: projectEntityId };
    if (visibility !== null) patch.visibility = { from: null, to: visibility };
    if (dueAt !== null) patch.dueAt = { from: null, to: dueAt };
    if (nextCheckAt !== null) patch.nextCheckAt = { from: null, to: nextCheckAt };
    if (expectedResponseAt !== null) patch.expectedResponseAt = { from: null, to: expectedResponseAt };
    if (lastProgressAt !== null) patch.lastProgressAt = { from: null, to: lastProgressAt };
    if (closedAt !== null) patch.closedAt = { from: null, to: closedAt };
    Object.assign(patch, this.buildLinkPatch(id, input.relations, input.references, context));
    let entity!: StateEntity;
    let event!: StateEvent;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO state_entities (
          id, type_id, slug, title, aliases, status, attributes, summary,
          body_pointer, owner_user_id, owner_agent_id, project_entity_id,
          visibility, due_at, next_check_at, expected_response_at,
          last_progress_at, closed_at, source, last_event_at, stale_after,
          created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        type.id,
        slug,
        title,
        JSON.stringify(aliases),
        status,
        JSON.stringify(attributes),
        summary,
        bodyPointer,
        ownerUserId,
        ownerAgentId,
        projectEntityId,
        visibility,
        dueAt,
        nextCheckAt,
        expectedResponseAt,
        lastProgressAt,
        closedAt,
        context.source,
        occurredAt,
        staleAfter,
        now,
        now,
        input.archive ? now : null,
      );
      const eventId = this.insertEvent({
        entityId: id,
        kind: "create",
        patch,
        note: input.note ?? null,
        context,
        occurredAt,
      });
      this.applyLinkPatch(id, patch, eventId, now);
      entity = this.requireEntity(id, context, true);
      event = this.requireEvent(eventId);
    });
    this.emitChange(entity, event);
    return { applied: true, entity, event, created: true };
  }

  private updateEntity(
    existing: StateEntity,
    input: StateEntityMutation,
    context: StateMutationContext,
  ): StateMutationResult {
    const type = this.requireType(existing.typeId, context);
    const next = cloneEntity(existing);
    const patch: Record<string, StatePatchValue> = {};
    const now = toSqlTimestamp(this.now());
    const occurredAt = normalizeTimestamp(context.occurredAt) ?? now;
    if (input.title !== undefined) assignPatch(next, "title", requireText(input.title, "title"), patch);
    if (input.aliases !== undefined) {
      const aliases = normalizeAliases([...next.aliases, ...input.aliases]);
      assignPatch(next, "aliases", aliases, patch);
    }
    if (input.summary !== undefined) assignPatch(next, "summary", normalizeNullableText(input.summary), patch);
    if (input.bodyPointer !== undefined) assignPatch(next, "bodyPointer", normalizeNullableText(input.bodyPointer), patch);
    if (input.ownerUserId !== undefined) assignPatch(next, "ownerUserId", normalizeNullableText(input.ownerUserId), patch);
    if (input.ownerAgentId !== undefined) assignPatch(next, "ownerAgentId", normalizeNullableText(input.ownerAgentId), patch);
    if (input.projectEntityId !== undefined) {
      assignPatch(next, "projectEntityId", this.validateProjectAssociation(input.projectEntityId, context, existing.id), patch);
    }
    if (input.visibility !== undefined) {
      assignPatch(next, "visibility", this.validateEntityVisibility(input.visibility, context), patch);
    }
    if (input.dueAt !== undefined) assignPatch(next, "dueAt", normalizeNullableTimestamp(input.dueAt, "dueAt"), patch);
    if (input.nextCheckAt !== undefined) assignPatch(next, "nextCheckAt", normalizeNullableTimestamp(input.nextCheckAt, "nextCheckAt"), patch);
    if (input.expectedResponseAt !== undefined) {
      assignPatch(next, "expectedResponseAt", normalizeNullableTimestamp(input.expectedResponseAt, "expectedResponseAt"), patch);
    }
    if (input.attributes) {
      const merged = { ...next.attributes };
      for (const [field, value] of Object.entries(input.attributes)) {
        if (deepEqual(merged[field], value)) continue;
        patch[`attributes.${field}`] = {
          from: Object.hasOwn(merged, field) ? merged[field] : ABSENT_ATTRIBUTE,
          to: value,
        };
        merged[field] = value;
      }
      this.validateAttributes(type, merged);
      next.attributes = merged;
    }
    if (input.status !== undefined) {
      const status = input.status === null ? null : requireText(input.status, "status");
      validateStatusTransition(type, next.status, status);
      if (!deepEqual(next.status, status)) {
        patch.status = { from: next.status, to: status };
        next.status = status;
        assignPatch(next, "closedAt", isTerminalStatus(type, status) ? occurredAt : null, patch);
      }
    }
    const defaultProgress = Object.keys(patch).some((field) => field === "status"
      || field.startsWith("attributes.")
      || ["dueAt", "nextCheckAt", "expectedResponseAt"].includes(field))
      || input.kind === "observation"
      || input.kind === "sync";
    if (input.lastProgressAt !== undefined) {
      assignPatch(next, "lastProgressAt", normalizeNullableTimestamp(input.lastProgressAt, "lastProgressAt"), patch);
    } else if (input.markProgress === true || (input.markProgress !== false && defaultProgress)) {
      assignPatch(next, "lastProgressAt", occurredAt, patch);
    }
    Object.assign(patch, this.buildLinkPatch(existing.id, input.relations, input.references, context));
    if (input.archive && !next.archivedAt) {
      patch.archived_at = { from: null, to: "__now__" };
    }
    if (input.restore && next.archivedAt) {
      patch.archived_at = { from: next.archivedAt, to: null };
    }
    const kind = input.kind ?? (input.status !== undefined ? "status_change" : "update");
    const hasMutation = Object.keys(patch).length > 0;
    const hasStandaloneEvent = Boolean(input.note?.trim()) || kind === "note" || kind === "check_in";
    if (!hasMutation && !hasStandaloneEvent) {
      return { applied: false, entity: existing, event: null, created: false, reason: "no_change" };
    }

    if (input.archive && !next.archivedAt) next.archivedAt = now;
    if (input.restore && next.archivedAt) next.archivedAt = null;
    const staleAfter = next.lastProgressAt !== existing.lastProgressAt
      ? (next.lastProgressAt ? this.computeStaleAfter(type, next.lastProgressAt) : null)
      : existing.staleAfter;
    let entity!: StateEntity;
    let event!: StateEvent;
    this.transaction(() => {
      this.writeEntityHead(next, {
        source: context.source,
        updatedAt: now,
        lastEventAt: occurredAt,
        staleAfter,
      });
      const eventId = this.insertEvent({
        entityId: next.id,
        kind,
        patch,
        note: input.note ?? null,
        context,
        occurredAt,
      });
      this.applyLinkPatch(next.id, patch, eventId, now);
      entity = this.requireEntity(next.id, context, true);
      event = this.requireEvent(eventId);
    });
    this.emitChange(entity, event);
    return { applied: true, entity, event, created: false };
  }

  private resolveEntity(input: StateEntityMutation, context: StateAccessContext): StateEntity | null {
    if (input.entityId?.trim()) return this.requireEntity(input.entityId.trim(), context, true);
    if (!input.typeId || !input.title) return null;
    return this.findMatchingEntity(
      normalizeTypeId(input.typeId),
      input.title,
      input.aliases ?? [],
      context,
      input.matchStrategy,
    );
  }

  private findMatchingEntity(
    typeId: string,
    title: string,
    aliases: readonly string[],
    context: StateAccessContext,
    strategy: StateEntityMutation["matchStrategy"] = "plausible",
  ): StateEntity | null {
    if (strategy === "none") return null;
    if (strategy !== "exact") return this.findPlausibleEntity(typeId, title, aliases, context);
    const names = new Set([title, ...aliases].map(normalizeName).filter(Boolean));
    return this.query({ ...context, type: typeId, includeArchived: false, limit: 500 }).entities
      .find((entity) => [entity.title, entity.slug, ...entity.aliases]
        .map(normalizeName)
        .some((name) => names.has(name))) ?? null;
  }

  private findPlausibleEntity(
    typeId: string,
    title: string,
    aliases: readonly string[],
    context: StateAccessContext,
  ): StateEntity | null {
    const candidates = this.query({ ...context, type: typeId, includeArchived: false, limit: 500 }).entities;
    const names = [title, ...aliases].map(normalizeName).filter(Boolean);
    for (const entity of candidates) {
      const entityNames = [entity.title, entity.slug, ...entity.aliases].map(normalizeName);
      if (names.some((name) => entityNames.some((candidate) => plausibleNameMatch(name, candidate)))) {
        return entity;
      }
    }
    return null;
  }

  private requireEntity(entityId: string, context: StateAccessContext, includeArchived: boolean): StateEntity {
    const row = this.db.prepare(`
      SELECT e.id, e.type_id AS typeId, e.slug, e.title, e.aliases,
             e.status, e.attributes, e.summary, e.body_pointer AS bodyPointer,
             e.body_fields_hash AS bodyFieldsHash, e.owner_user_id AS ownerUserId,
             e.owner_agent_id AS ownerAgentId,
             e.project_entity_id AS projectEntityId, e.visibility AS entityVisibility,
             e.due_at AS dueAt, e.next_check_at AS nextCheckAt,
             e.expected_response_at AS expectedResponseAt,
             e.last_progress_at AS lastProgressAt, e.closed_at AS closedAt, e.source,
             e.last_event_at AS lastEventAt, e.stale_after AS staleAfter,
             e.created_at AS createdAt, e.updated_at AS updatedAt,
             e.archived_at AS archivedAt, t.visibility AS typeVisibility,
             p.visibility AS projectEntityVisibility,
             pt.visibility AS projectTypeVisibility
      FROM state_entities e JOIN state_entity_types t ON t.id = e.type_id
      LEFT JOIN state_entities p ON p.id = e.project_entity_id
      LEFT JOIN state_entity_types pt ON pt.id = p.type_id
      WHERE e.id = ? ${includeArchived ? "" : "AND e.archived_at IS NULL"}
    `).get(entityId) as EntityRowWithVisibility | undefined;
    if (!row || !this.canAccessEntityRow(row, context)) {
      throw new Error(`State entity '${entityId}' was not found or is not visible to this agent.`);
    }
    return mapStateEntity(row, this.now());
  }

  private getEntityUnscoped(entityId: string, includeArchived: boolean): StateEntity | null {
    return this.getEntity(entityId, { includePrivate: true }, includeArchived);
  }

  private getTypeUnscoped(typeId: string): StateTypeDefinition | null {
    return this.getType(typeId, { includePrivate: true });
  }

  private requireType(typeId: string, context: StateAccessContext): StateTypeDefinition {
    const type = this.getType(typeId, context);
    if (!type || type.archivedAt) throw new Error(`State type '${typeId}' was not found or is not visible to this agent.`);
    return type;
  }

  private canAccessType(type: StateTypeDefinition, context: StateAccessContext): boolean {
    return this.visibilityResolver(type.visibility, context);
  }

  private validateAttributes(type: StateTypeDefinition, attributes: Record<string, unknown>): void {
    const schemaJson = stableStringify(type.attributesSchema);
    let cached = this.validators.get(type.id);
    if (!cached || cached.schema !== schemaJson) {
      cached = { schema: schemaJson, validate: ajv.compile(type.attributesSchema) };
      this.validators.set(type.id, cached);
    }
    if (!cached.validate(attributes)) {
      throw new Error(`Invalid ${type.displayName} attributes: ${formatAjvErrors(cached.validate.errors)}`);
    }
  }

  private validateProjectAssociation(
    value: string | null | undefined,
    context: StateAccessContext,
    entityId: string,
  ): string | null {
    if (value === null || value === undefined || !value.trim()) return null;
    const projectEntityId = value.trim();
    if (projectEntityId === entityId) throw new Error("A state entity cannot be its own project.");
    const project = this.requireEntity(projectEntityId, context, true);
    if (project.typeId !== "project") {
      throw new Error(`Project association '${projectEntityId}' must reference a project state entity.`);
    }
    const seen = new Set([entityId]);
    let cursor: string | null = projectEntityId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error("Project associations cannot form a cycle.");
      seen.add(cursor);
      const row = this.db.prepare(
        "SELECT project_entity_id AS projectEntityId FROM state_entities WHERE id = ?",
      ).get(cursor) as { projectEntityId: string | null } | undefined;
      cursor = row?.projectEntityId ?? null;
    }
    return projectEntityId;
  }

  private validateEntityVisibility(
    value: string | null | undefined,
    context: StateAccessContext,
  ): string | null {
    if (value === null || value === undefined || !value.trim()) return null;
    const visibility = value.trim();
    if (visibility !== "shared" && !/^private:[a-z0-9][a-z0-9_-]*$/iu.test(visibility)) {
      throw new Error("Entity visibility must be 'shared', 'private:<scope>', or null to inherit.");
    }
    if (!context.includePrivate && !this.visibilityResolver(visibility, context)) {
      throw new Error(`Cannot assign inaccessible state visibility '${visibility}'.`);
    }
    return visibility;
  }

  private buildLinkPatch(
    entityId: string,
    relationMutations: readonly StateRelationMutation[] | undefined,
    referenceMutations: readonly StateReferenceMutation[] | undefined,
    context: StateAccessContext,
  ): Record<string, StatePatchValue> {
    const patch: Record<string, StatePatchValue> = {};
    const seen = new Set<string>();
    for (const mutation of relationMutations ?? []) {
      const kind = requireText(mutation.kind, "relations.kind");
      const targetEntityId = requireText(mutation.targetEntityId, "relations.targetEntityId");
      if (targetEntityId === entityId) throw new Error("A state entity cannot relate to itself.");
      this.requireEntity(targetEntityId, context, true);
      const key = relationPatchKey(kind, targetEntityId);
      if (seen.has(key)) throw new Error(`Duplicate relation mutation '${kind}' → '${targetEntityId}'.`);
      seen.add(key);
      const current = this.getActiveRelationValue(entityId, kind, targetEntityId);
      const desired: RelationPatchValue | null = mutation.remove
        ? null
        : { kind, targetEntityId, metadata: normalizeMetadata(mutation.metadata) };
      if (!deepEqual(current, desired)) patch[key] = { from: current, to: desired };
    }
    for (const mutation of referenceMutations ?? []) {
      const role = requireText(mutation.role, "references.role");
      const ref = requireText(mutation.ref, "references.ref");
      const key = referencePatchKey(role, ref);
      if (seen.has(key)) throw new Error(`Duplicate reference mutation '${role}' → '${ref}'.`);
      seen.add(key);
      if (mutation.supportsEventId !== undefined && mutation.supportsEventId !== null) {
        const supportedEvent = this.getEvent(mutation.supportsEventId);
        if (!supportedEvent || !this.getEntity(supportedEvent.entityId, context, true)) {
          throw new Error(`Supported state event ${mutation.supportsEventId} was not found or is not visible.`);
        }
      }
      const current = this.getActiveReferenceValue(entityId, role, ref);
      const desired: ReferencePatchValue | null = mutation.remove
        ? null
        : {
            role,
            ref,
            label: normalizeNullableText(mutation.label ?? null),
            metadata: normalizeMetadata(mutation.metadata),
            supportsEventId: mutation.supportsEventId ?? null,
          };
      if (!deepEqual(current, desired)) patch[key] = { from: current, to: desired };
    }
    return patch;
  }

  private applyLinkPatch(
    entityId: string,
    patch: Record<string, StatePatchValue>,
    eventId: number,
    now: string,
    guardAgainst?: Record<string, StatePatchValue>,
  ): void {
    for (const [key, change] of Object.entries(patch)) {
      if (key.startsWith(RELATION_PATCH_PREFIX)) {
        const identity = parseRelationPatchKey(key);
        const current = this.getActiveRelationValue(entityId, identity.kind, identity.targetEntityId);
        const guard = guardAgainst?.[key];
        if (guard && !deepEqual(current, guard.to ?? null)) {
          throw new Error(`Cannot safely revert relation '${identity.kind}': current link no longer matches the event being reverted.`);
        }
        const desired = isRelationPatchValue(change.to) ? change.to : null;
        if (current) {
          this.db.prepare(`
            UPDATE state_entity_relations SET archived_event_id = ?, archived_at = ?
            WHERE source_entity_id = ? AND target_entity_id = ? AND kind = ? AND archived_at IS NULL
          `).run(eventId, now, entityId, identity.targetEntityId, identity.kind);
        }
        if (desired) {
          this.db.prepare(`
            INSERT INTO state_entity_relations (
              source_entity_id, target_entity_id, kind, metadata,
              created_event_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(entityId, desired.targetEntityId, desired.kind, jsonOrNull(desired.metadata), eventId, now);
        }
      } else if (key.startsWith(REFERENCE_PATCH_PREFIX)) {
        const identity = parseReferencePatchKey(key);
        const current = this.getActiveReferenceValue(entityId, identity.role, identity.ref);
        const guard = guardAgainst?.[key];
        if (guard && !deepEqual(current, guard.to ?? null)) {
          throw new Error(`Cannot safely revert reference '${identity.role}': current link no longer matches the event being reverted.`);
        }
        const desired = isReferencePatchValue(change.to) ? change.to : null;
        if (current) {
          this.db.prepare(`
            UPDATE state_entity_references SET archived_event_id = ?, archived_at = ?
            WHERE entity_id = ? AND role = ? AND ref = ? AND archived_at IS NULL
          `).run(eventId, now, entityId, identity.role, identity.ref);
        }
        if (desired) {
          this.db.prepare(`
            INSERT INTO state_entity_references (
              entity_id, role, ref, label, metadata, supports_event_id,
              created_event_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            entityId,
            desired.role,
            desired.ref,
            desired.label,
            jsonOrNull(desired.metadata),
            desired.supportsEventId,
            eventId,
            now,
          );
        }
      }
    }
  }

  private getActiveRelationValue(entityId: string, kind: string, targetEntityId: string): RelationPatchValue | null {
    const row = this.db.prepare(`
      SELECT kind, target_entity_id AS targetEntityId, metadata
      FROM state_entity_relations
      WHERE source_entity_id = ? AND kind = ? AND target_entity_id = ? AND archived_at IS NULL
      LIMIT 1
    `).get(entityId, kind, targetEntityId) as { kind: string; targetEntityId: string; metadata: string | null } | undefined;
    return row ? { kind: row.kind, targetEntityId: row.targetEntityId, metadata: parseJsonObject(row.metadata) } : null;
  }

  private getActiveReferenceValue(entityId: string, role: string, ref: string): ReferencePatchValue | null {
    const row = this.db.prepare(`
      SELECT role, ref, label, metadata, supports_event_id AS supportsEventId
      FROM state_entity_references
      WHERE entity_id = ? AND role = ? AND ref = ? AND archived_at IS NULL
      LIMIT 1
    `).get(entityId, role, ref) as {
      role: string;
      ref: string;
      label: string | null;
      metadata: string | null;
      supportsEventId: number | bigint | null;
    } | undefined;
    return row ? {
      role: row.role,
      ref: row.ref,
      label: row.label,
      metadata: parseJsonObject(row.metadata),
      supportsEventId: row.supportsEventId === null ? null : Number(row.supportsEventId),
    } : null;
  }

  private computeStaleAfter(type: StateTypeDefinition, fromTimestamp: string): string | null {
    const days = numericValue(type.stalenessPolicy?.expected_update_days);
    if (days === null || days <= 0) return null;
    const base = new Date(fromTimestamp);
    if (Number.isNaN(base.getTime())) return null;
    return toSqlTimestamp(new Date(base.getTime() + days * 86_400_000));
  }

  private uniqueSlug(typeId: string, title: string): string {
    const base = slugify(title);
    let slug = base;
    let index = 2;
    while (this.db.prepare("SELECT 1 FROM state_entities WHERE type_id = ? AND slug = ?").get(typeId, slug)) {
      slug = `${base}-${index}`;
      index += 1;
    }
    return slug;
  }

  private writeEntityHead(entity: StateEntity, meta: {
    source: string;
    updatedAt: string;
    lastEventAt: string;
    staleAfter: string | null;
  }): void {
    this.db.prepare(`
      UPDATE state_entities SET
        title = ?, aliases = ?, status = ?, attributes = ?, summary = ?,
        body_pointer = ?, owner_user_id = ?, owner_agent_id = ?,
        project_entity_id = ?, visibility = ?, due_at = ?, next_check_at = ?,
        expected_response_at = ?, last_progress_at = ?, closed_at = ?,
        source = ?, last_event_at = ?, stale_after = ?, updated_at = ?, archived_at = ?
      WHERE id = ?
    `).run(
      entity.title,
      JSON.stringify(entity.aliases),
      entity.status,
      JSON.stringify(entity.attributes),
      entity.summary,
      entity.bodyPointer,
      entity.ownerUserId,
      entity.ownerAgentId,
      entity.projectEntityId,
      entity.visibility,
      entity.dueAt,
      entity.nextCheckAt,
      entity.expectedResponseAt,
      entity.lastProgressAt,
      entity.closedAt,
      meta.source,
      meta.lastEventAt,
      meta.staleAfter,
      meta.updatedAt,
      entity.archivedAt,
      entity.id,
    );
  }

  private insertEvent(input: {
    entityId: string;
    kind: StateEventKind;
    patch: Record<string, StatePatchValue>;
    note: string | null;
    context: StateMutationContext;
    occurredAt: string;
    revertsEventId?: number | null;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO state_events (
        entity_id, kind, patch, note, actor, session_id, message_id,
        turn_id, reverts_event_id, occurred_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.entityId,
      input.kind,
      JSON.stringify(input.patch),
      input.note,
      input.context.actor,
      input.context.sessionId ?? null,
      input.context.messageId ?? null,
      input.context.turnId ?? null,
      input.revertsEventId ?? null,
      input.occurredAt,
      toSqlTimestamp(this.now()),
    );
    return Number(result.lastInsertRowid);
  }

  private getEvent(eventId: number): StateEvent | null {
    const row = this.db.prepare(`
      SELECT id, entity_id AS entityId, kind, patch, note, actor,
             session_id AS sessionId, message_id AS messageId, turn_id AS turnId,
             reverts_event_id AS revertsEventId, occurred_at AS occurredAt,
             recorded_at AS recordedAt
      FROM state_events WHERE id = ?
    `).get(eventId) as StateEventRow | undefined;
    return row ? mapStateEvent(row) : null;
  }

  private requireEvent(eventId: number): StateEvent {
    const event = this.getEvent(eventId);
    if (!event) throw new Error(`State event ${eventId} was not found.`);
    return event;
  }

  private queryTrend(entityId: string, trend: NonNullable<StateQueryInput["trend"]>): NonNullable<StateQueryResult["trend"]> {
    const field = requireText(trend.field, "trend.field");
    const windowDays = clampInt(trend.windowDays ?? 30, 1, 3650);
    const aggregation = trend.aggregation ?? "raw";
    const lowerBound = toSqlTimestamp(new Date(this.now().getTime() - windowDays * 86_400_000));
    const events = this.db.prepare(`
      SELECT patch, occurred_at AS occurredAt FROM state_events
      WHERE entity_id = ? AND datetime(occurred_at) >= datetime(?)
      ORDER BY datetime(occurred_at), id
    `).all(entityId, lowerBound) as Array<{ patch: string | null; occurredAt: string }>;
    const patchKey = field.startsWith("attributes.") ? field : `attributes.${field}`;
    const points = events.flatMap((row) => {
      const patch = parsePatch(row.patch);
      const directValue = numericValue(patch?.[patchKey]?.to);
      const createdAttributes = isRecord(patch?.attributes?.to) ? patch.attributes.to : null;
      const value = directValue ?? numericValue(createdAttributes?.[field.replace(/^attributes\./u, "")]);
      return value === null ? [] : [{ occurredAt: row.occurredAt, value }];
    });
    let value: number | null = null;
    if (points.length > 0 && aggregation !== "raw") {
      const values = points.map((point) => point.value);
      if (aggregation === "average") value = values.reduce((sum, item) => sum + item, 0) / values.length;
      if (aggregation === "min") value = Math.min(...values);
      if (aggregation === "max") value = Math.max(...values);
      if (aggregation === "change") value = values[values.length - 1]! - values[0]!;
    }
    return { field, aggregation, points, value };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private emitChange(entity: StateEntity, event: StateEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(entity, event);
        if (result && typeof result.then === "function") {
          void result.catch((error) => {
            this.openIssue(entity.id, "mirror_failed", `State body mirror failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      } catch (error) {
        this.openIssue(entity.id, "mirror_failed", `State body mirror failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private mapVisibleEntities(rows: EntityRowWithVisibility[], context: StateAccessContext, now: Date): StateEntity[] {
    return rows
      .filter((row) => this.canAccessEntityRow(row, context))
      .map((row) => mapStateEntity(row, now));
  }

  private canAccessEntityRow(row: EntityRowWithVisibility, context: StateAccessContext): boolean {
    if (![row.typeVisibility, row.entityVisibility]
      .filter((value): value is string => Boolean(value?.trim()))
      .every((visibility) => this.visibilityResolver(visibility, context))) return false;
    const visited = new Set<string>();
    let projectEntityId = row.projectEntityId;
    while (projectEntityId) {
      if (visited.has(projectEntityId)) return false;
      visited.add(projectEntityId);
      const parent = this.db.prepare(`
        SELECT e.project_entity_id AS projectEntityId,
               e.visibility AS entityVisibility,
               t.visibility AS typeVisibility
        FROM state_entities e
        JOIN state_entity_types t ON t.id = e.type_id
        WHERE e.id = ?
      `).get(projectEntityId) as {
        projectEntityId: string | null;
        entityVisibility: string | null;
        typeVisibility: string;
      } | undefined;
      if (!parent) return false;
      if (![parent.typeVisibility, parent.entityVisibility]
        .filter((value): value is string => Boolean(value?.trim()))
        .every((visibility) => this.visibilityResolver(visibility, context))) return false;
      projectEntityId = parent.projectEntityId;
    }
    return true;
  }

  private detectDuplicateEntities(entities: StateEntity[]): number {
    let found = 0;
    const byType = new Map<string, StateEntity[]>();
    for (const entity of entities) {
      byType.set(entity.typeId, [...(byType.get(entity.typeId) ?? []), entity]);
    }
    for (const group of byType.values()) {
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          const a = group[left]!;
          const b = group[right]!;
          const aNames = [a.title, ...a.aliases].map(normalizeName);
          const bNames = [b.title, ...b.aliases].map(normalizeName);
          if (!aNames.some((name) => bNames.some((candidate) => plausibleNameMatch(name, candidate)))) continue;
          const detail = `Possible duplicate: ${a.id} and ${b.id}. Merge by archiving one with a merged_into note.`;
          if (this.openIssue(a.id, "duplicate", detail, { duplicateEntityId: b.id })) found += 1;
        }
      }
    }
    return found;
  }

  private getLastReconcilerRun(): { createdAt: string; status: string } | null {
    const row = this.db.prepare(`
      SELECT created_at AS createdAt, status FROM state_reconciler_runs
      ORDER BY datetime(created_at) DESC, id DESC LIMIT 1
    `).get() as { createdAt: string; status: string } | undefined;
    return row ?? null;
  }
}

interface StateTypeRow {
  id: string;
  displayName: string;
  description: string | null;
  attributesSchema: string;
  statuses: string | null;
  stalenessPolicy: string | null;
  digestTemplate: string | null;
  bodyFields: string | null;
  visibility: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface StateEntityRow {
  id: string;
  typeId: string;
  slug: string;
  title: string;
  aliases: string | null;
  status: string | null;
  attributes: string;
  summary: string | null;
  bodyPointer: string | null;
  bodyFieldsHash: string | null;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  projectEntityId: string | null;
  entityVisibility: string | null;
  dueAt: string | null;
  nextCheckAt: string | null;
  expectedResponseAt: string | null;
  lastProgressAt: string | null;
  closedAt: string | null;
  source: string;
  lastEventAt: string | null;
  staleAfter: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

type EntityRowWithVisibility = StateEntityRow & {
  typeVisibility: string;
  projectEntityVisibility: string | null;
  projectTypeVisibility: string | null;
};

interface StateEntityRelationRow {
  id: number | bigint;
  sourceEntityId: string;
  targetEntityId: string;
  kind: string;
  metadata: string | null;
  createdEventId: number | bigint;
  archivedEventId: number | bigint | null;
  createdAt: string;
  archivedAt: string | null;
}

interface StateEntityReferenceRow {
  id: number | bigint;
  entityId: string;
  role: string;
  ref: string;
  label: string | null;
  metadata: string | null;
  supportsEventId: number | bigint | null;
  createdEventId: number | bigint;
  archivedEventId: number | bigint | null;
  createdAt: string;
  archivedAt: string | null;
}

interface StateEventRow {
  id: number | bigint;
  entityId: string;
  kind: StateEventKind;
  patch: string | null;
  note: string | null;
  actor: string;
  sessionId: string | null;
  messageId: string | null;
  turnId: string | null;
  revertsEventId: number | bigint | null;
  occurredAt: string;
  recordedAt: string;
}

interface StateIssueRow extends Omit<StateIssue, "metadata"> {
  metadata: string | null;
}

function mapStateType(row: StateTypeRow): StateTypeDefinition {
  return {
    ...row,
    attributesSchema: parseJsonObject(row.attributesSchema) ?? {},
    statuses: parseJsonObject(row.statuses) as StateStatusDefinition | null,
    stalenessPolicy: parseJsonObject(row.stalenessPolicy) as StateStalenessPolicy | null,
    bodyFields: parseJsonArray(row.bodyFields).filter((value): value is string => typeof value === "string"),
  };
}

function mapStateEntity(row: StateEntityRow, now: Date): StateEntity {
  const {
    entityVisibility,
    typeVisibility: _typeVisibility,
    projectEntityVisibility: _projectEntityVisibility,
    projectTypeVisibility: _projectTypeVisibility,
    ...rest
  } = row as EntityRowWithVisibility;
  return {
    ...rest,
    visibility: entityVisibility,
    aliases: parseJsonArray(row.aliases).filter((value): value is string => typeof value === "string"),
    attributes: parseJsonObject(row.attributes) ?? {},
    stale: Boolean(row.staleAfter && new Date(row.staleAfter).getTime() <= now.getTime()),
    overdue: Boolean(!row.archivedAt && row.dueAt && !row.closedAt && new Date(row.dueAt).getTime() <= now.getTime()),
  };
}

function mapStateEntityRelation(row: StateEntityRelationRow): StateEntityRelation {
  return {
    ...row,
    id: Number(row.id),
    metadata: parseJsonObject(row.metadata),
    createdEventId: Number(row.createdEventId),
    archivedEventId: row.archivedEventId === null ? null : Number(row.archivedEventId),
  };
}

function mapStateEntityReference(row: StateEntityReferenceRow): StateEntityReference {
  return {
    ...row,
    id: Number(row.id),
    metadata: parseJsonObject(row.metadata),
    supportsEventId: row.supportsEventId === null ? null : Number(row.supportsEventId),
    createdEventId: Number(row.createdEventId),
    archivedEventId: row.archivedEventId === null ? null : Number(row.archivedEventId),
  };
}

function mapStateEvent(row: StateEventRow): StateEvent {
  return {
    ...row,
    id: Number(row.id),
    revertsEventId: row.revertsEventId === null ? null : Number(row.revertsEventId),
    patch: parsePatch(row.patch),
  };
}

function parsePatch(value: string | null): Record<string, StatePatchValue> | null {
  return parseJsonObject(value) as Record<string, StatePatchValue> | null;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function defaultVisibilityResolver(visibility: string, context: StateAccessContext): boolean {
  if (context.includePrivate) return true;
  if (!visibility.startsWith("private:")) return true;
  const scope = visibility.slice("private:".length).trim().toLowerCase();
  const agentId = context.agentId?.toLowerCase() ?? "";
  const baseAgentId = agentId.replace(/-ollama$/u, "");
  const agentType = context.agentType?.toLowerCase() ?? "";
  const scopes = new Set((context.scopes ?? []).map((value) => value.toLowerCase()));
  return scope === agentId
    || scope === baseAgentId
    || scope === agentType
    || scopes.has(scope)
    || (scope === "wellness" && ["malibu", "malibu-ollama"].includes(agentId));
}

function validateTypeSchema(schema: Record<string, unknown>): void {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    throw new Error("attributesSchema must be a JSON Schema object with type='object' and properties.");
  }
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid attributesSchema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateStatusDefinition(statuses: StateStatusDefinition | null): void {
  if (!statuses) return;
  const values = normalizeStringArray(statuses.values);
  if (values.length === 0) throw new Error("statuses.values must contain at least one status.");
  if (statuses.initial && !values.includes(statuses.initial)) {
    throw new Error(`Initial status '${statuses.initial}' is not in statuses.values.`);
  }
  for (const terminal of normalizeStringArray(statuses.terminal)) {
    if (!values.includes(terminal)) throw new Error(`Terminal status '${terminal}' is not in statuses.values.`);
  }
  for (const [from, targets] of Object.entries(statuses.transitions ?? {})) {
    if (!values.includes(from)) throw new Error(`Transition source '${from}' is not an allowed status.`);
    for (const target of targets) {
      if (!values.includes(target)) throw new Error(`Transition target '${target}' is not an allowed status.`);
    }
  }
}

function validateBodyFields(fields: readonly string[], schema: Record<string, unknown>): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const field of fields) {
    if (field !== "status" && !(field in properties)) {
      throw new Error(`bodyFields contains '${field}', which is neither status nor a schema property.`);
    }
  }
}

function assertAdditiveTypeEvolution(
  existing: StateTypeDefinition,
  input: { attributesSchema: Record<string, unknown>; statuses?: StateStatusDefinition | null; bodyFields?: string[] },
): void {
  const oldProperties = isRecord(existing.attributesSchema.properties) ? existing.attributesSchema.properties : {};
  const nextProperties = isRecord(input.attributesSchema.properties) ? input.attributesSchema.properties : {};
  for (const [name, definition] of Object.entries(oldProperties)) {
    if (!(name in nextProperties)) throw new Error(`Type evolution is additive-only: existing field '${name}' cannot be removed.`);
    if (!deepEqual(definition, nextProperties[name])) {
      throw new Error(`Type evolution is additive-only: existing field '${name}' cannot be renamed or retyped.`);
    }
  }
  const oldRequired = normalizeStringArray(existing.attributesSchema.required);
  const nextRequired = normalizeStringArray(input.attributesSchema.required);
  for (const name of nextRequired) {
    if (!oldRequired.includes(name)) throw new Error(`Type evolution is additive-only: new field '${name}' must be optional.`);
  }
  if (existing.statuses && input.statuses) {
    for (const status of existing.statuses.values) {
      if (!input.statuses.values.includes(status)) throw new Error(`Type evolution is additive-only: status '${status}' cannot be removed.`);
    }
    for (const terminal of existing.statuses.terminal ?? []) {
      if (!(input.statuses.terminal ?? []).includes(terminal)) {
        throw new Error(`Type evolution is additive-only: terminal status '${terminal}' cannot be removed.`);
      }
    }
  }
  validateBodyFields(input.bodyFields ?? [], mergeAdditiveSchema(existing.attributesSchema, input.attributesSchema));
}

function mergeAdditiveSchema(existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return {
    ...existing,
    ...next,
    properties: {
      ...(isRecord(existing.properties) ? existing.properties : {}),
      ...(isRecord(next.properties) ? next.properties : {}),
    },
    required: normalizeStringArray(existing.required),
  };
}

function mergeAdditiveStatuses(
  existing: StateStatusDefinition | null,
  next: StateStatusDefinition | null,
): StateStatusDefinition | null {
  if (!existing) return next;
  if (!next) return existing;
  const transitions: Record<string, string[]> = {};
  for (const key of new Set([...Object.keys(existing.transitions ?? {}), ...Object.keys(next.transitions ?? {})])) {
    transitions[key] = [...new Set([...(existing.transitions?.[key] ?? []), ...(next.transitions?.[key] ?? [])])];
  }
  return {
    values: [...new Set([...existing.values, ...next.values])],
    transitions,
    initial: existing.initial ?? next.initial,
    terminal: [...new Set([...(existing.terminal ?? []), ...(next.terminal ?? [])])],
  };
}

function normalizeNewStatus(type: StateTypeDefinition, requested: string | null | undefined): string | null {
  if (!type.statuses) {
    if (requested !== undefined && requested !== null) throw new Error(`State type '${type.id}' is statusless.`);
    return null;
  }
  const status = requested ?? type.statuses.initial ?? type.statuses.values[0] ?? null;
  if (!status || !type.statuses.values.includes(status)) throw new Error(`Invalid initial status '${String(status)}' for type '${type.id}'.`);
  return status;
}

function validateStatusTransition(type: StateTypeDefinition, from: string | null, to: string | null): void {
  if (!type.statuses) {
    if (to !== null) throw new Error(`State type '${type.id}' is statusless.`);
    return;
  }
  if (to === null || !type.statuses.values.includes(to)) {
    throw new Error(`Status '${String(to)}' is not allowed for ${type.displayName}. Allowed: ${type.statuses.values.join(", ")}.`);
  }
  if (from === null || from === to) return;
  const allowed = type.statuses.transitions?.[from];
  if (allowed && !allowed.includes(to)) {
    throw new Error(`Illegal ${type.displayName} transition '${from}' → '${to}'. Allowed from '${from}': ${allowed.join(", ") || "none"}.`);
  }
}

function isTerminalStatus(type: StateTypeDefinition, status: string | null): boolean {
  return Boolean(status && type.statuses?.terminal?.includes(status));
}

function invertPatch(patch: Record<string, StatePatchValue>): Record<string, StatePatchValue> {
  return Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, { from: value.to, to: value.from }]));
}

function applyPatchToEntity(
  entity: StateEntity,
  inverse: Record<string, StatePatchValue>,
  options: { guardAgainst: Record<string, StatePatchValue>; now: string },
): void {
  if (inverse.__created__) {
    entity.archivedAt = options.now;
    return;
  }
  for (const [field, change] of Object.entries(inverse)) {
    if (field.startsWith(RELATION_PATCH_PREFIX) || field.startsWith(REFERENCE_PATCH_PREFIX)) continue;
    const original = options.guardAgainst[field];
    const current = readEntityPatchField(entity, field);
    if (original && !deepEqual(current, normalizeNowMarker(original.to, current))) {
      throw new Error(`Cannot safely revert '${field}': current head no longer matches the event being reverted.`);
    }
    writeEntityPatchField(entity, field, normalizeNowMarker(change.to, null));
  }
}

function readEntityPatchField(entity: StateEntity, field: string): unknown {
  if (field.startsWith("attributes.")) return entity.attributes[field.slice("attributes.".length)] ?? null;
  if (field === "archived_at") return entity.archivedAt;
  if (field === "body_pointer") return entity.bodyPointer;
  if (field === "owner_agent_id") return entity.ownerAgentId;
  if (field === "owner_user_id") return entity.ownerUserId;
  if (field === "project_entity_id") return entity.projectEntityId;
  if (field === "due_at") return entity.dueAt;
  if (field === "next_check_at") return entity.nextCheckAt;
  if (field === "expected_response_at") return entity.expectedResponseAt;
  if (field === "last_progress_at") return entity.lastProgressAt;
  if (field === "closed_at") return entity.closedAt;
  if (field in entity) return (entity as unknown as Record<string, unknown>)[field] ?? null;
  if (field === "bodyPointer") return entity.bodyPointer;
  if (field === "ownerAgentId") return entity.ownerAgentId;
  return null;
}

function writeEntityPatchField(entity: StateEntity, field: string, value: unknown): void {
  if (field.startsWith("attributes.")) {
    const key = field.slice("attributes.".length);
    if (value === undefined || value === ABSENT_ATTRIBUTE) delete entity.attributes[key];
    else entity.attributes[key] = value;
    return;
  }
  if (field === "archived_at") entity.archivedAt = typeof value === "string" ? value : null;
  else if (field === "title") entity.title = String(value ?? "");
  else if (field === "aliases") entity.aliases = Array.isArray(value) ? normalizeAliases(value.map(String)) : [];
  else if (field === "status") entity.status = typeof value === "string" ? value : null;
  else if (field === "summary") entity.summary = typeof value === "string" ? value : null;
  else if (field === "bodyPointer" || field === "body_pointer") entity.bodyPointer = typeof value === "string" ? value : null;
  else if (field === "ownerAgentId" || field === "owner_agent_id") entity.ownerAgentId = typeof value === "string" ? value : null;
  else if (field === "ownerUserId" || field === "owner_user_id") entity.ownerUserId = typeof value === "string" ? value : null;
  else if (field === "projectEntityId" || field === "project_entity_id") entity.projectEntityId = typeof value === "string" ? value : null;
  else if (field === "visibility") entity.visibility = typeof value === "string" ? value : null;
  else if (field === "dueAt" || field === "due_at") entity.dueAt = typeof value === "string" ? value : null;
  else if (field === "nextCheckAt" || field === "next_check_at") entity.nextCheckAt = typeof value === "string" ? value : null;
  else if (field === "expectedResponseAt" || field === "expected_response_at") entity.expectedResponseAt = typeof value === "string" ? value : null;
  else if (field === "lastProgressAt" || field === "last_progress_at") entity.lastProgressAt = typeof value === "string" ? value : null;
  else if (field === "closedAt" || field === "closed_at") entity.closedAt = typeof value === "string" ? value : null;
  else if (field === "attributes" && isRecord(value)) entity.attributes = { ...value };
}

function assignPatch<K extends
  | "title"
  | "aliases"
  | "summary"
  | "bodyPointer"
  | "ownerUserId"
  | "ownerAgentId"
  | "projectEntityId"
  | "visibility"
  | "dueAt"
  | "nextCheckAt"
  | "expectedResponseAt"
  | "lastProgressAt"
  | "closedAt"
>(
  entity: StateEntity,
  field: K,
  value: StateEntity[K],
  patch: Record<string, StatePatchValue>,
): void {
  if (deepEqual(entity[field], value)) return;
  patch[field] = { from: entity[field], to: value };
  entity[field] = value;
}

function renderDigestTemplate(type: StateTypeDefinition, entity: StateEntity, now: Date): string {
  const template = type.digestTemplate?.trim() || "{title} — {status} ({updated_age})";
  const values: Record<string, unknown> = {
    title: entity.title,
    status: entity.status ?? "",
    summary: entity.summary ?? "",
    updated_at: entity.updatedAt,
    last_event_at: entity.lastEventAt,
    due_at: entity.dueAt,
    next_check_at: entity.nextCheckAt,
    expected_response_at: entity.expectedResponseAt,
    last_progress_at: entity.lastProgressAt,
    closed_at: entity.closedAt,
    overdue: entity.overdue,
    updated_age: formatAge(entity.updatedAt, now),
    ...entity.attributes,
  };
  let rendered = template;
  rendered = rendered.replace(/age\(([^)]+)\)/gu, (_match, field: string) => {
    const value = values[field.trim()];
    return typeof value === "string" ? formatAge(value, now) : "unknown";
  });
  rendered = rendered.replace(/days_until\(([^)]+)\)/gu, (_match, field: string) => {
    const value = values[field.trim()];
    if (typeof value !== "string") return "unknown";
    const days = Math.ceil((new Date(value).getTime() - now.getTime()) / 86_400_000);
    return Number.isFinite(days) ? `${days}d` : "unknown";
  });
  rendered = rendered.replace(/day_of\(([^,]+),([^)]+)\)/gu, (_match, startField: string, endField: string) => {
    const start = values[startField.trim()];
    const end = values[endField.trim()];
    if (typeof start !== "string" || typeof end !== "string") return "day unknown";
    const startMs = new Date(`${start}T00:00:00Z`).getTime();
    const endMs = new Date(`${end}T00:00:00Z`).getTime();
    const day = Math.floor((now.getTime() - startMs) / 86_400_000) + 1;
    const total = Math.floor((endMs - startMs) / 86_400_000) + 1;
    return Number.isFinite(day) && Number.isFinite(total) ? `day ${Math.max(day, 1)} of ${Math.max(total, 1)}` : "day unknown";
  });
  rendered = rendered.replace(/\{([a-zA-Z0-9_.-]+)\}/gu, (_match, key: string) => displayValue(values[key]));
  rendered = rendered.replace(/\s+([,;])/gu, "$1").replace(/(?:;\s*){2,}/gu, "; ").replace(/\s{2,}/gu, " ").trim();
  if (entity.stale) rendered += " ⚠ stale";
  return rendered;
}

function formatAge(timestamp: string, now: Date): string {
  const deltaMs = Math.max(0, now.getTime() - new Date(timestamp).getTime());
  if (!Number.isFinite(deltaMs)) return "unknown";
  if (deltaMs < 3_600_000) return `${Math.max(1, Math.round(deltaMs / 60_000))}m ago`;
  if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
  return `${Math.round(deltaMs / 86_400_000)}d ago`;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") || "schema validation failed";
}

function normalizeTypeId(value: string): string {
  const input = requireText(value, "typeId").toLowerCase();
  let normalized = "";
  let pendingSeparator = false;
  for (const character of input) {
    const code = character.charCodeAt(0);
    const isAsciiLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAsciiLetter || isDigit) {
      if (pendingSeparator && normalized) normalized += "-";
      normalized += character;
      pendingSeparator = false;
    } else if (normalized) {
      pendingSeparator = true;
    }
  }
  if (!normalized) throw new Error("typeId must contain letters or numbers.");
  return normalized;
}

function slugify(value: string): string {
  return normalizeName(value).replace(/\s+/gu, "-").slice(0, 80) || "entity";
}

function normalizeName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, " ").trim();
}

function plausibleNameMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftNumbers = left.match(/\d+/gu) ?? [];
  const rightNumbers = right.match(/\d+/gu) ?? [];
  if (!deepEqual(leftNumbers, rightNumbers)) return false;
  if (Math.min(left.length, right.length) >= 5 && (left.includes(right) || right.includes(left))) return true;
  return Math.max(left.length, right.length) <= 24 && levenshtein(left, right) <= 2;
}

function levenshtein(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length]!;
}

function normalizeAliases(values: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = value.trim();
    const key = normalizeName(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))] : [];
}

function normalizeNullableText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeNullableTimestamp(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field} timestamp '${value}'.`);
  return toSqlTimestamp(date);
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp '${value}'.`);
  return toSqlTimestamp(date);
}

function normalizeMetadata(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("State link metadata must be an object or null.");
  return structuredClone(value);
}

function relationPatchKey(kind: string, targetEntityId: string): string {
  return `${RELATION_PATCH_PREFIX}${encodeURIComponent(kind)}:${encodeURIComponent(targetEntityId)}`;
}

function referencePatchKey(role: string, ref: string): string {
  return `${REFERENCE_PATCH_PREFIX}${encodeURIComponent(role)}:${encodeURIComponent(ref)}`;
}

function parseRelationPatchKey(value: string): { kind: string; targetEntityId: string } {
  const parts = value.slice(RELATION_PATCH_PREFIX.length).split(":");
  if (parts.length !== 2) throw new Error(`Invalid relation patch key '${value}'.`);
  return { kind: decodeURIComponent(parts[0]!), targetEntityId: decodeURIComponent(parts[1]!) };
}

function parseReferencePatchKey(value: string): { role: string; ref: string } {
  const parts = value.slice(REFERENCE_PATCH_PREFIX.length).split(":");
  if (parts.length !== 2) throw new Error(`Invalid reference patch key '${value}'.`);
  return { role: decodeURIComponent(parts[0]!), ref: decodeURIComponent(parts[1]!) };
}

function isRelationPatchValue(value: unknown): value is RelationPatchValue {
  return isRecord(value)
    && typeof value.kind === "string"
    && typeof value.targetEntityId === "string"
    && (value.metadata === null || isRecord(value.metadata));
}

function isReferencePatchValue(value: unknown): value is ReferencePatchValue {
  return isRecord(value)
    && typeof value.role === "string"
    && typeof value.ref === "string"
    && (value.label === null || typeof value.label === "string")
    && (value.metadata === null || isRecord(value.metadata))
    && (value.supportsEventId === null || typeof value.supportsEventId === "number");
}

function addExactCondition(
  conditions: string[],
  values: Array<string | number>,
  column: string,
  value: string | undefined,
): void {
  if (!value?.trim()) return;
  conditions.push(`${column} = ?`);
  values.push(value.trim());
}

function addTimestampCondition(
  conditions: string[],
  values: Array<string | number>,
  column: string,
  operator: "<=" | ">=",
  value: string | undefined,
  field: string,
): void {
  if (!value?.trim()) return;
  conditions.push(`${column} IS NOT NULL AND datetime(${column}) ${operator} datetime(?)`);
  values.push(normalizeNullableTimestamp(value, field)!);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}

function toSqlTimestamp(value: Date): string {
  return value.toISOString();
}

function requireText(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "" || value === ABSENT_ATTRIBUTE) return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const MAX_TURN_RECEIPT_EVENTS = 8;
const MAX_TURN_RECEIPT_PIECES = 6;
const MAX_TURN_RECEIPT_CHARS = 480;
const MAX_RECEIPT_VALUE_CHARS = 96;
const RECEIPT_OVERFLOW_RESERVE = 16;

function renderReceiptPatch(
  entity: Pick<StateEntity, "typeId" | "slug">,
  field: string,
  change: StatePatchValue,
): string {
  const subject = `${entity.typeId}/${entity.slug}`;
  if (isNarrativeReceiptField(field)) return `${subject} ${displayField(field)} updated`;
  if (field === "bodyPointer" || field === "bodyFieldsHash") return `${subject} source updated`;
  if (field === "lastProgressAt") return `${subject} progress recorded`;
  return `${subject} ${displayField(field)} ${displayReceiptValue(change.from)} → ${displayReceiptValue(change.to)}`;
}

function isNarrativeReceiptField(field: string): boolean {
  return field === "summary"
    || /^attributes\.(?:next_action|summary|description|details|notes?|plan|content)$/u.test(field);
}

function displayReceiptValue(value: unknown): string {
  const compact = displayValue(value).replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_RECEIPT_VALUE_CHARS) return compact;
  return `${compact.slice(0, MAX_RECEIPT_VALUE_CHARS - 3)}...`;
}

function displayField(value: string): string {
  return value.replace(/^attributes\./u, "").replace(/_/gu, " ");
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(value) ? value : min)));
}

function normalizeProgressDays(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 36_500) {
    throw new Error(`${field} must be a finite number from 0 through 36500.`);
  }
  return value;
}

function withinHours(timestamp: string, now: Date, hours: number): boolean {
  return now.getTime() - new Date(timestamp).getTime() <= hours * 3_600_000;
}

function cloneEntity(entity: StateEntity): StateEntity {
  return { ...entity, aliases: [...entity.aliases], attributes: structuredClone(entity.attributes) };
}

function normalizeNowMarker(value: unknown, fallback: unknown): unknown {
  return value === "__now__" ? fallback : value;
}

function sweepContext(now: Date): StateMutationContext {
  return { actor: "sweep", source: "sweep", occurredAt: now.toISOString(), includePrivate: true };
}
