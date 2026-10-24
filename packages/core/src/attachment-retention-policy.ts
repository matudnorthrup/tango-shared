import { z } from "zod";
import { loadLayeredConfigCategory } from "./config-layering.js";
import type {
  AttachmentFileRecord,
  AttachmentRecord,
  AttachmentRetentionDecision,
  AttachmentRetentionDecisionInput,
} from "./attachments-store.js";

export type AttachmentRetentionScopeType =
  | "global"
  | "user"
  | "project"
  | "agent"
  | "channel"
  | "thread"
  | "attachment";

export type AttachmentRetentionArtifact =
  | "original"
  | "derived"
  | "extracted_text"
  | "chunks"
  | "embeddings"
  | "directories"
  | "sidecars";

export interface AttachmentRetentionScope {
  type: AttachmentRetentionScopeType;
  id?: string;
}

export interface AttachmentRetentionMatchCriteria {
  statuses?: string[];
  contentTypes?: string[];
  contentTypePrefixes?: string[];
  filenameExtensions?: string[];
  projectIds?: string[];
  agentIds?: string[];
  channelIds?: string[];
  threadIds?: string[];
  userIds?: string[];
  minAgeDays?: number;
  maxAgeDays?: number;
  tags?: string[];
  sensitivity?: string[];
  sourceKinds?: string[];
  metadata?: Record<string, string | number | boolean | Array<string | number | boolean>>;
}

export interface AttachmentRetentionAction {
  decision: AttachmentRetentionDecision;
  reason?: string;
  afterDays?: number;
  reviewAfterDays?: number;
}

export interface AttachmentRetentionRule {
  id: string;
  schemaVersion: number;
  description?: string;
  enabled: boolean;
  priority: number;
  scope: AttachmentRetentionScope;
  match?: AttachmentRetentionMatchCriteria;
  actions: Partial<Record<AttachmentRetentionArtifact | "all", AttachmentRetentionAction>>;
  sourcePath?: string;
}

export interface AttachmentRetentionPolicy {
  version: string;
  rules: AttachmentRetentionRule[];
}

export interface AttachmentRetentionRuleTrace {
  ruleId: string;
  scope: AttachmentRetentionScope;
  priority: number;
  sourcePath?: string;
  reason?: string;
}

export interface AttachmentArtifactRetentionDecision {
  artifact: AttachmentRetentionArtifact;
  decision: AttachmentRetentionDecision;
  ruleId: string | null;
  policyVersion: string;
  reason: string;
  effectiveAt: string | null;
  reviewAfter: string | null;
  destructive: boolean;
}

export interface AttachmentRetentionEvaluation {
  attachmentId: number;
  policyVersion: string;
  evaluatedAt: string;
  overallDecision: AttachmentRetentionDecision;
  requiresReview: boolean;
  destructive: boolean;
  artifactDecisions: Record<AttachmentRetentionArtifact, AttachmentArtifactRetentionDecision>;
  matchedRules: AttachmentRetentionRuleTrace[];
  summary: string;
}

export interface EvaluateAttachmentRetentionInput {
  attachment: AttachmentRecord;
  sourceFile?: AttachmentFileRecord | null;
  policy: AttachmentRetentionPolicy;
  now?: Date;
}

const RETENTION_ARTIFACTS: AttachmentRetentionArtifact[] = [
  "original",
  "derived",
  "extracted_text",
  "chunks",
  "embeddings",
  "directories",
  "sidecars",
];

const retentionDecisionSchema = z.enum(["keep", "delete", "review", "retire"]);

const retentionActionSchema = z.object({
  decision: retentionDecisionSchema,
  reason: z.string().min(1).optional(),
  after_days: z.number().int().nonnegative().optional(),
  review_after_days: z.number().int().nonnegative().optional(),
});

const retentionScopeSchema = z.object({
  type: z.enum(["global", "user", "project", "agent", "channel", "thread", "attachment"]),
  id: z.string().min(1).optional(),
});

const scalarOrArraySchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

const retentionMatchSchema = z.object({
  statuses: z.array(z.string().min(1)).optional(),
  content_types: z.array(z.string().min(1)).optional(),
  content_type_prefixes: z.array(z.string().min(1)).optional(),
  filename_extensions: z.array(z.string().min(1)).optional(),
  project_ids: z.array(z.string().min(1)).optional(),
  agent_ids: z.array(z.string().min(1)).optional(),
  channel_ids: z.array(z.string().min(1)).optional(),
  thread_ids: z.array(z.string().min(1)).optional(),
  user_ids: z.array(z.string().min(1)).optional(),
  min_age_days: z.number().int().nonnegative().optional(),
  max_age_days: z.number().int().nonnegative().optional(),
  tags: z.array(z.string().min(1)).optional(),
  sensitivity: z.array(z.string().min(1)).optional(),
  source_kinds: z.array(z.string().min(1)).optional(),
  metadata: z.record(scalarOrArraySchema).optional(),
});

const retentionRuleSchema = z.object({
  id: z.string().min(1),
  schema_version: z.number().int().positive().default(1),
  description: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  scope: retentionScopeSchema,
  match: retentionMatchSchema.optional(),
  actions: z.object({
    all: retentionActionSchema.optional(),
    original: retentionActionSchema.optional(),
    derived: retentionActionSchema.optional(),
    extracted_text: retentionActionSchema.optional(),
    chunks: retentionActionSchema.optional(),
    embeddings: retentionActionSchema.optional(),
    directories: retentionActionSchema.optional(),
    sidecars: retentionActionSchema.optional(),
  }).refine(
    (actions) => Object.values(actions).some(Boolean),
    "At least one retention action is required.",
  ),
});

type ParsedAttachmentRetentionRule = z.input<typeof retentionRuleSchema>;

export function loadAttachmentRetentionPolicy(configDir?: string): AttachmentRetentionPolicy {
  const rules = loadLayeredConfigCategory({
    category: "attachment-retention-rules",
    configDir,
    required: false,
    schema: retentionRuleSchema,
    map: (parsed, trace) => mapRetentionRule(parsed, trace.sourceFiles.at(-1)?.filePath),
  });

  return createAttachmentRetentionPolicy(rules);
}

export function createAttachmentRetentionPolicy(
  rules: AttachmentRetentionRule[],
): AttachmentRetentionPolicy {
  const enabledRules = rules.filter((rule) => rule.enabled);
  return {
    version: createPolicyVersion(enabledRules),
    rules: enabledRules,
  };
}

export function evaluateAttachmentRetention(
  input: EvaluateAttachmentRetentionInput,
): AttachmentRetentionEvaluation {
  const now = input.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const matchedRules = input.policy.rules
    .filter((rule) => scopeMatches(rule.scope, input.attachment))
    .filter((rule) => matchCriteria(rule.match, input, now))
    .sort(compareRetentionRules);
  const artifactDecisions = Object.fromEntries(
    RETENTION_ARTIFACTS.map((artifact) => {
      const decision = evaluateArtifact(artifact, matchedRules, input.policy.version, input.attachment, now);
      return [artifact, decision];
    }),
  ) as Record<AttachmentRetentionArtifact, AttachmentArtifactRetentionDecision>;

  const overallDecision = summarizeDecision(Object.values(artifactDecisions).map((decision) => decision.decision));
  const destructive = Object.values(artifactDecisions).some((decision) => decision.destructive);
  const requiresReview = destructive || overallDecision === "review";
  const matchedTrace = matchedRules.map((rule): AttachmentRetentionRuleTrace => ({
    ruleId: rule.id,
    scope: rule.scope,
    priority: rule.priority,
    sourcePath: rule.sourcePath,
    reason: rule.description,
  }));

  return {
    attachmentId: input.attachment.id,
    policyVersion: input.policy.version,
    evaluatedAt,
    overallDecision,
    requiresReview,
    destructive,
    artifactDecisions,
    matchedRules: matchedTrace,
    summary: buildEvaluationSummary(overallDecision, matchedTrace, destructive),
  };
}

export function retentionDecisionInputFromEvaluation(
  evaluation: AttachmentRetentionEvaluation,
  options: {
    decidedBy?: string | null;
    status?: AttachmentRetentionDecisionInput["status"];
  } = {},
): Omit<AttachmentRetentionDecisionInput, "attachmentId"> {
  return {
    retentionPolicyId: evaluation.policyVersion,
    decision: evaluation.overallDecision,
    status: options.status ?? "proposed",
    decidedBy: options.decidedBy ?? null,
    reason: evaluation.summary,
    effectiveAt: earliestDate(
      Object.values(evaluation.artifactDecisions).map((decision) => decision.effectiveAt),
    ),
    reviewAfter: earliestDate(
      Object.values(evaluation.artifactDecisions).map((decision) => decision.reviewAfter),
    ),
    metadata: {
      evaluation,
      destructiveActionsApplied: false,
    },
  };
}

function mapRetentionRule(
  parsed: ParsedAttachmentRetentionRule,
  sourcePath: string | undefined,
): AttachmentRetentionRule {
  return {
    id: parsed.id,
    schemaVersion: parsed.schema_version ?? 1,
    description: parsed.description,
    enabled: parsed.enabled ?? true,
    priority: parsed.priority ?? 0,
    scope: parsed.scope,
    match: parsed.match
      ? {
          statuses: parsed.match.statuses,
          contentTypes: parsed.match.content_types,
          contentTypePrefixes: parsed.match.content_type_prefixes,
          filenameExtensions: parsed.match.filename_extensions,
          projectIds: parsed.match.project_ids,
          agentIds: parsed.match.agent_ids,
          channelIds: parsed.match.channel_ids,
          threadIds: parsed.match.thread_ids,
          userIds: parsed.match.user_ids,
          minAgeDays: parsed.match.min_age_days,
          maxAgeDays: parsed.match.max_age_days,
          tags: parsed.match.tags,
          sensitivity: parsed.match.sensitivity,
          sourceKinds: parsed.match.source_kinds,
          metadata: parsed.match.metadata,
        }
      : undefined,
    actions: Object.fromEntries(
      Object.entries(parsed.actions).map(([artifact, action]) => [
        artifact,
        action
          ? {
              decision: action.decision,
              reason: action.reason,
              afterDays: action.after_days,
              reviewAfterDays: action.review_after_days,
            }
          : undefined,
      ]),
    ) as AttachmentRetentionRule["actions"],
    sourcePath,
  };
}

function evaluateArtifact(
  artifact: AttachmentRetentionArtifact,
  matchedRules: AttachmentRetentionRule[],
  policyVersion: string,
  attachment: AttachmentRecord,
  now: Date,
): AttachmentArtifactRetentionDecision {
  let appliedRule: AttachmentRetentionRule | null = null;
  let appliedAction: AttachmentRetentionAction | null = null;

  for (const rule of matchedRules) {
    const action = rule.actions[artifact] ?? rule.actions.all;
    if (!action) continue;
    appliedRule = rule;
    appliedAction = action;
  }

  if (!appliedAction) {
    return {
      artifact,
      decision: "keep",
      ruleId: null,
      policyVersion,
      reason: "No matching retention rule changed this artifact; defaulting to keep.",
      effectiveAt: null,
      reviewAfter: null,
      destructive: false,
    };
  }

  return {
    artifact,
    decision: appliedAction.decision,
    ruleId: appliedRule?.id ?? null,
    policyVersion,
    reason: appliedAction.reason ?? appliedRule?.description ?? `Matched retention rule ${appliedRule?.id ?? "unknown"}.`,
    effectiveAt: appliedAction.afterDays !== undefined
      ? addDays(new Date(attachment.createdAt), appliedAction.afterDays).toISOString()
      : null,
    reviewAfter: appliedAction.reviewAfterDays !== undefined
      ? addDays(now, appliedAction.reviewAfterDays).toISOString()
      : null,
    destructive: isDestructiveDecision(appliedAction.decision),
  };
}

function scopeMatches(scope: AttachmentRetentionScope, attachment: AttachmentRecord): boolean {
  if (scope.type === "global") return true;
  const target = scope.id;
  if (!target) return false;
  switch (scope.type) {
    case "user":
      return attachment.userId === target;
    case "project":
      return attachment.projectId === target;
    case "agent":
      return attachment.agentId === target;
    case "channel":
      return attachment.channelId === target;
    case "thread":
      return attachment.threadId === target;
    case "attachment":
      return String(attachment.id) === target || attachment.discordAttachmentId === target;
    default:
      return false;
  }
}

function matchCriteria(
  criteria: AttachmentRetentionMatchCriteria | undefined,
  input: EvaluateAttachmentRetentionInput,
  now: Date,
): boolean {
  if (!criteria) return true;
  const attachment = input.attachment;
  const metadata = attachment.metadata ?? {};

  if (!matchesOneOf(attachment.status, criteria.statuses)) return false;
  if (!matchesOneOf(attachment.contentType, criteria.contentTypes)) return false;
  if (!matchesPrefix(attachment.contentType, criteria.contentTypePrefixes)) return false;
  if (!matchesExtension(attachment.originalFilename ?? attachment.title, criteria.filenameExtensions)) return false;
  if (!matchesOneOf(attachment.projectId, criteria.projectIds)) return false;
  if (!matchesOneOf(attachment.agentId, criteria.agentIds)) return false;
  if (!matchesOneOf(attachment.channelId, criteria.channelIds)) return false;
  if (!matchesOneOf(attachment.threadId, criteria.threadIds)) return false;
  if (!matchesOneOf(attachment.userId, criteria.userIds)) return false;
  if (!matchesTags(metadata, criteria.tags)) return false;
  if (!matchesMetadataField(metadata, "sensitivity", criteria.sensitivity)) return false;
  if (!matchesMetadataField(metadata, "source_kind", criteria.sourceKinds)
    && !matchesMetadataField(metadata, "source", criteria.sourceKinds)) return false;
  if (!matchesMetadata(criteria.metadata, metadata)) return false;

  const ageDays = (now.getTime() - new Date(attachment.createdAt).getTime()) / (24 * 60 * 60 * 1000);
  if (criteria.minAgeDays !== undefined && ageDays < criteria.minAgeDays) return false;
  if (criteria.maxAgeDays !== undefined && ageDays > criteria.maxAgeDays) return false;
  return true;
}

function compareRetentionRules(left: AttachmentRetentionRule, right: AttachmentRetentionRule): number {
  return scopeSpecificity(left.scope) - scopeSpecificity(right.scope)
    || left.priority - right.priority
    || left.id.localeCompare(right.id);
}

function scopeSpecificity(scope: AttachmentRetentionScope): number {
  switch (scope.type) {
    case "global":
      return 0;
    case "user":
      return 10;
    case "project":
      return 20;
    case "agent":
      return 30;
    case "channel":
      return 40;
    case "thread":
      return 50;
    case "attachment":
      return 60;
    default:
      return 0;
  }
}

function summarizeDecision(decisions: AttachmentRetentionDecision[]): AttachmentRetentionDecision {
  if (decisions.includes("delete")) return "delete";
  if (decisions.includes("retire")) return "retire";
  if (decisions.includes("review")) return "review";
  return "keep";
}

function buildEvaluationSummary(
  overallDecision: AttachmentRetentionDecision,
  matchedRules: AttachmentRetentionRuleTrace[],
  destructive: boolean,
): string {
  const ruleList = matchedRules.length > 0
    ? matchedRules.map((rule) => rule.ruleId).join(", ")
    : "none";
  const reviewNote = destructive
    ? " Destructive artifact decisions require review; no deletion is applied by evaluation."
    : "";
  return `Attachment retention evaluation decision=${overallDecision}; matched rules=${ruleList}.${reviewNote}`;
}

function isDestructiveDecision(decision: AttachmentRetentionDecision): boolean {
  return decision === "delete" || decision === "retire";
}

function matchesOneOf(value: string | null | undefined, expected: string[] | undefined): boolean {
  if (!expected || expected.length === 0) return true;
  return Boolean(value && expected.includes(value));
}

function matchesPrefix(value: string | null | undefined, prefixes: string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  return Boolean(value && prefixes.some((prefix) => value.startsWith(prefix)));
}

function matchesExtension(filename: string | null | undefined, extensions: string[] | undefined): boolean {
  if (!extensions || extensions.length === 0) return true;
  if (!filename) return false;
  const normalized = filename.toLowerCase();
  return extensions
    .map((extension) => extension.toLowerCase().replace(/^\./u, ""))
    .some((extension) => normalized.endsWith(`.${extension}`));
}

function matchesTags(metadata: Record<string, unknown>, expectedTags: string[] | undefined): boolean {
  if (!expectedTags || expectedTags.length === 0) return true;
  const tags = [
    ...metadataStringArray(metadata.tags),
    ...metadataStringArray(metadata.labels),
    ...metadataStringArray(metadata.project_tags),
  ];
  return expectedTags.every((tag) => tags.includes(tag));
}

function matchesMetadataField(
  metadata: Record<string, unknown>,
  key: string,
  expectedValues: string[] | undefined,
): boolean {
  if (!expectedValues || expectedValues.length === 0) return true;
  const value = metadata[key];
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && expectedValues.includes(item));
  }
  return typeof value === "string" && expectedValues.includes(value);
}

function matchesMetadata(
  expected: AttachmentRetentionMatchCriteria["metadata"],
  metadata: Record<string, unknown>,
): boolean {
  if (!expected) return true;
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = metadata[key];
    const expectedValues = Array.isArray(expectedValue) ? expectedValue : [expectedValue];
    if (!expectedValues.some((value) => metadataValueEquals(actual, value))) {
      return false;
    }
  }
  return true;
}

function metadataValueEquals(actual: unknown, expected: string | number | boolean): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => metadataValueEquals(item, expected));
  }
  return actual === expected;
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function earliestDate(values: Array<string | null>): string | null {
  const dates = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return dates[0] ?? null;
}

function createPolicyVersion(rules: AttachmentRetentionRule[]): string {
  if (rules.length === 0) return "attachment-retention:none";
  const fingerprint = rules
    .map((rule) => `${rule.id}@${rule.schemaVersion}`)
    .sort()
    .join(",");
  return `attachment-retention:${fingerprint}`;
}
