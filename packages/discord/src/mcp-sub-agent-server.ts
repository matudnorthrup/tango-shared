#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TangoStorage,
  createBuiltInProviderRegistry,
  createSubAgentBatchBudgetState,
  resolveDatabasePath,
  runSubAgentBatch,
  type ProviderToolCall,
  type SpawnSubAgentsInput,
  type SpawnSubAgentsQualityGate,
  type SubAgentResult,
  type SubTaskSpec,
} from "@tango/core";
import { getMcpToolAnnotations } from "./mcp-tool-metadata.js";
import {
  generateWithFailover,
  type ProviderFailoverError,
} from "./provider-failover.js";
import {
  SPAWN_SUB_AGENTS_TOOL_NAME,
  SUB_AGENT_MCP_SERVER_NAME,
} from "./sub-agent-tool.js";
import { buildWorkerProviderTools } from "./worker-provider-tools.js";

const debug = (...args: unknown[]): void => {
  console.error("[mcp-subagents]", ...args);
};

const DEFAULT_CLAUDE_SUB_AGENT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_CODEX_SUB_AGENT_MODEL = "gpt-5.4-mini";
const DEFAULT_SUB_AGENT_RETRY_LIMIT = 1;
const WEB_SEARCH_TOOL_ALIASES = new Set([
  "web",
  "web.run",
  "web_search",
  "websearch",
]);
const WEB_FETCH_TOOL_ALIASES = new Set([
  "web.fetch",
  "web_fetch",
  "webfetch",
]);

const stringListSchema = z.array(z.string().min(1)).min(1);
const qualityGateSchema = z.object({
  task_class: z.string().min(1).optional(),
  constraints: stringListSchema.optional(),
  success_criteria: stringListSchema.optional(),
  must_answer: stringListSchema.optional(),
  comparison_axes: stringListSchema.optional(),
  required_fields: stringListSchema.optional(),
  min_source_count: z.number().int().min(0).max(100).optional(),
  require_structured_output: z.boolean().optional(),
}).strict();

const subTaskSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "max", "xhigh"]).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  output_schema: z.enum(["text", "research_evidence_v1"]).optional(),
  constraints: stringListSchema.optional(),
  success_criteria: stringListSchema.optional(),
  must_answer: stringListSchema.optional(),
  comparison_axes: stringListSchema.optional(),
  required_fields: stringListSchema.optional(),
}).strict();

const inputSchema = z.object({
  sub_tasks: z.array(subTaskSchema).min(1).max(12),
  concurrency: z.number().int().min(1).max(5).optional(),
  timeout_seconds: z.number().int().min(10).max(300).optional(),
  max_rounds: z.number().int().min(1).max(2).optional(),
  quality_gate: qualityGateSchema.optional(),
}).strict();

const budget = createSubAgentBatchBudgetState();
const storage = new TangoStorage(resolveDatabasePath(process.env.TANGO_DB_PATH));

function normalizeEnvString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeCsvEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const normalized = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeIntegerEnv(name: string, fallback: number): number {
  const value = normalizeEnvString(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createProviderRegistry(timeoutMs: number) {
  return createBuiltInProviderRegistry({
    claudeOauth: {
      command: normalizeEnvString("CLAUDE_CLI_COMMAND") ?? "claude",
      defaultModel: normalizeEnvString("CLAUDE_MODEL"),
      defaultReasoningEffort: (normalizeEnvString("CLAUDE_EFFORT") as SpawnSubAgentsInput["sub_tasks"][number]["reasoning_effort"]) ?? "medium",
      timeoutMs,
    },
    ...(normalizeEnvString("CLAUDE_SECONDARY_CLI_COMMAND")
      ? {
          claudeOauthSecondary: {
            command: normalizeEnvString("CLAUDE_SECONDARY_CLI_COMMAND")!,
            defaultModel: normalizeEnvString("CLAUDE_SECONDARY_MODEL") ?? normalizeEnvString("CLAUDE_MODEL"),
            defaultReasoningEffort:
              (normalizeEnvString("CLAUDE_SECONDARY_EFFORT") as SpawnSubAgentsInput["sub_tasks"][number]["reasoning_effort"])
              ?? (normalizeEnvString("CLAUDE_EFFORT") as SpawnSubAgentsInput["sub_tasks"][number]["reasoning_effort"])
              ?? "medium",
            timeoutMs,
          }
        }
      : {}),
    claudeHarness: {
      command: normalizeEnvString("CLAUDE_HARNESS_COMMAND") ?? normalizeEnvString("CLAUDE_CLI_COMMAND") ?? "claude",
      defaultModel: normalizeEnvString("CLAUDE_HARNESS_MODEL") ?? normalizeEnvString("CLAUDE_MODEL"),
      defaultReasoningEffort:
        (normalizeEnvString("CLAUDE_HARNESS_EFFORT") as SpawnSubAgentsInput["sub_tasks"][number]["reasoning_effort"])
        ?? (normalizeEnvString("CLAUDE_EFFORT") as SpawnSubAgentsInput["sub_tasks"][number]["reasoning_effort"])
        ?? "medium",
      timeoutMs,
    },
    codex: {
      command: normalizeEnvString("CODEX_CLI_COMMAND") ?? "codex",
      defaultModel: normalizeEnvString("CODEX_MODEL"),
      defaultReasoningEffort:
        (normalizeEnvString("CODEX_REASONING_EFFORT") as SpawnSubAgentsInput["sub_tasks"][number]["reasoning_effort"])
        ?? "medium",
      timeoutMs,
      sandbox: (normalizeEnvString("CODEX_SANDBOX") as "read-only" | "workspace-write" | "danger-full-access") ?? "read-only",
      approvalPolicy: (normalizeEnvString("CODEX_APPROVAL_POLICY") as "untrusted" | "on-failure" | "on-request" | "never") ?? "never",
      skipGitRepoCheck: true,
    },
  });
}

function normalizeProviderAlias(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude") return "claude-oauth";
  if (normalized === "claude-secondary") return "claude-oauth-secondary";
  if (normalized === "openai") return "codex";
  return normalized;
}

function resolveDefaultSubAgentProviders(): string[] {
  return normalizeCsvEnv("TANGO_SUB_AGENT_DEFAULT_PROVIDERS", ["claude-oauth", "claude-oauth-secondary", "codex"])
    .map((providerName) => normalizeProviderAlias(providerName));
}

function expandPreferredProviderChain(preferredProvider: string | undefined): string[] {
  const deduped = new Set<string>();
  const normalizedPreferred = preferredProvider ? normalizeProviderAlias(preferredProvider) : null;
  if (normalizedPreferred) {
    deduped.add(normalizedPreferred);
  }
  const defaultProviders = resolveDefaultSubAgentProviders();
  for (const providerName of defaultProviders) {
    deduped.add(providerName);
  }
  return [...deduped];
}

export function resolveSubTaskProviderNames(spec: SubTaskSpec): string[] {
  if (spec.provider?.trim()) {
    return expandPreferredProviderChain(spec.provider);
  }

  if (spec.model?.trim()) {
    return expandPreferredProviderChain(
      normalizeEnvString("TANGO_SUB_AGENT_DEFAULT_PROVIDER") ?? "claude-oauth",
    );
  }

  return resolveDefaultSubAgentProviders();
}

function inferDefaultModel(providerName: string): string | undefined {
  if (providerName.startsWith("claude")) {
    return normalizeEnvString("TANGO_SUB_AGENT_CLAUDE_MODEL") ?? DEFAULT_CLAUDE_SUB_AGENT_MODEL;
  }
  if (providerName === "codex") {
    return normalizeEnvString("TANGO_SUB_AGENT_CODEX_MODEL") ?? DEFAULT_CODEX_SUB_AGENT_MODEL;
  }
  return undefined;
}

function summarizeToolCalls(toolCalls: ProviderToolCall[] | undefined) {
  return (toolCalls ?? []).map((toolCall) => ({
    name: toolCall.name,
    ...(toolCall.serverName ? { server_name: toolCall.serverName } : {}),
    ...(toolCall.toolName ? { tool_name: toolCall.toolName } : {}),
  }));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = normalizeString(value);
    return single ? [single] : [];
  }

  const items: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item);
    if (!normalized || items.includes(normalized)) {
      continue;
    }
    items.push(normalized);
  }
  return items;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toCoverageKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function mergeStringLists(...lists: Array<readonly string[] | undefined>): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const normalized = normalizeString(item);
      if (!normalized || merged.includes(normalized)) {
        continue;
      }
      merged.push(normalized);
    }
  }
  return merged;
}

function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

interface StructuredResearchEvidence {
  summary?: string;
  answered_questions?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  comparisons?: Array<Record<string, unknown>>;
  constraint_assessments?: Array<Record<string, unknown>>;
  success_criteria_checks?: Array<Record<string, unknown>>;
  required_field_values?: Record<string, unknown>;
  contradictions?: string[];
  unresolved?: string[];
  source_urls?: string[];
}

export interface StructuredResearchEvidenceSummary {
  parsed: boolean;
  outputSchema: string | null;
  sourceUrls: string[];
  answeredQuestions: string[];
  coveredConstraints: string[];
  coveredSuccessCriteria: string[];
  valueKeys: string[];
  findingsCount: number;
  contradictionCount: number;
  unresolvedCount: number;
  warnings: string[];
}

export interface SpawnSubAgentsBatchEvaluation {
  enabled: boolean;
  task_class: string | null;
  passed: boolean;
  require_structured_output: boolean;
  completed_count: number;
  failed_count: number;
  timeout_count: number;
  structured_completed_count: number;
  unique_source_count: number;
  covered_required_fields: string[];
  missing_required_fields: string[];
  covered_comparison_axes: string[];
  missing_comparison_axes: string[];
  covered_constraints: string[];
  missing_constraints: string[];
  covered_success_criteria: string[];
  missing_success_criteria: string[];
  answered_questions: string[];
  unanswered_questions: string[];
  contradiction_count: number;
  unresolved_count: number;
  warnings: string[];
  follow_up_recommendations: Array<{
    id_hint: string;
    instruction: string;
    required_fields: string[];
    must_answer: string[];
    comparison_axes: string[];
    constraints: string[];
    success_criteria: string[];
  }>;
}

function normalizeStructuredEvidenceArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function collectStructuredValueKeys(record: Record<string, unknown> | null | undefined): string[] {
  if (!record) {
    return [];
  }
  return Object.keys(record)
    .map((key) => toCoverageKey(key))
    .filter((key, index, values) => key.length > 0 && values.indexOf(key) === index);
}

function collectStructuredSourceUrls(evidence: StructuredResearchEvidence): string[] {
  const urls = mergeStringLists(evidence.source_urls);
  for (const section of [...normalizeStructuredEvidenceArray(evidence.findings), ...normalizeStructuredEvidenceArray(evidence.comparisons)]) {
    for (const url of normalizeStringList(section.source_urls)) {
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
  }
  return urls;
}

export function parseStructuredResearchOutput(text: string): StructuredResearchEvidence | null {
  const jsonBlock = extractJsonBlock(text);
  if (!jsonBlock) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonBlock);
    const record = normalizeRecord(parsed);
    if (!record) {
      return null;
    }

    return {
      summary: normalizeString(record.summary) || undefined,
      answered_questions: normalizeStructuredEvidenceArray(record.answered_questions),
      findings: normalizeStructuredEvidenceArray(record.findings),
      comparisons: normalizeStructuredEvidenceArray(record.comparisons),
      constraint_assessments: normalizeStructuredEvidenceArray(record.constraint_assessments),
      success_criteria_checks: normalizeStructuredEvidenceArray(record.success_criteria_checks),
      required_field_values: normalizeRecord(record.required_field_values) ?? undefined,
      contradictions: normalizeStringList(record.contradictions),
      unresolved: normalizeStringList(record.unresolved),
      source_urls: normalizeStringList(record.source_urls),
    };
  } catch {
    return null;
  }
}

function shouldRequireStructuredOutput(task: SubTaskSpec): boolean {
  return task.output_schema === "research_evidence_v1"
    || (task.constraints?.length ?? 0) > 0
    || (task.success_criteria?.length ?? 0) > 0
    || (task.must_answer?.length ?? 0) > 0
    || (task.comparison_axes?.length ?? 0) > 0
    || (task.required_fields?.length ?? 0) > 0;
}

export function summarizeSubAgentResearchQuality(task: SubTaskSpec, outputText: string): StructuredResearchEvidenceSummary {
  const warnings: string[] = [];
  const parsed = parseStructuredResearchOutput(outputText);

  if (!parsed) {
    if (shouldRequireStructuredOutput(task)) {
      warnings.push("Structured research output missing or invalid JSON.");
    }
    return {
      parsed: false,
      outputSchema: task.output_schema ?? null,
      sourceUrls: [],
      answeredQuestions: [],
      coveredConstraints: [],
      coveredSuccessCriteria: [],
      valueKeys: [],
      findingsCount: 0,
      contradictionCount: 0,
      unresolvedCount: 0,
      warnings,
    };
  }

  const answeredQuestions = normalizeStructuredEvidenceArray(parsed.answered_questions)
    .map((item) => normalizeString(item.question))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
  const coveredConstraints = normalizeStructuredEvidenceArray(parsed.constraint_assessments)
    .map((item) => normalizeString(item.constraint))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
  const coveredSuccessCriteria = normalizeStructuredEvidenceArray(parsed.success_criteria_checks)
    .filter((item) => normalizeBoolean(item.met) !== false)
    .map((item) => normalizeString(item.criterion))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
  const valueKeys = mergeStringLists(
    collectStructuredValueKeys(parsed.required_field_values),
    ...normalizeStructuredEvidenceArray(parsed.findings).map((item) => collectStructuredValueKeys(normalizeRecord(item.values))),
    ...normalizeStructuredEvidenceArray(parsed.comparisons).map((item) => collectStructuredValueKeys(normalizeRecord(item.values))),
  );
  const sourceUrls = collectStructuredSourceUrls(parsed);
  const findingsCount =
    normalizeStructuredEvidenceArray(parsed.findings).length +
    normalizeStructuredEvidenceArray(parsed.comparisons).length;

  if (shouldRequireStructuredOutput(task) && sourceUrls.length === 0) {
    warnings.push("Structured evidence returned no source URLs.");
  }

  return {
    parsed: true,
    outputSchema: task.output_schema ?? null,
    sourceUrls,
    answeredQuestions,
    coveredConstraints,
    coveredSuccessCriteria,
    valueKeys,
    findingsCount,
    contradictionCount: normalizeStringList(parsed.contradictions).length,
    unresolvedCount: normalizeStringList(parsed.unresolved).length,
    warnings,
  };
}

function mergeQualityGateIntoTask(
  task: z.infer<typeof subTaskSchema>,
  qualityGate: z.infer<typeof qualityGateSchema> | undefined,
): z.infer<typeof subTaskSchema> {
  const merged = {
    ...task,
    constraints: mergeStringLists(task.constraints, qualityGate?.constraints),
    success_criteria: mergeStringLists(task.success_criteria, qualityGate?.success_criteria),
    must_answer: mergeStringLists(task.must_answer, qualityGate?.must_answer),
    comparison_axes: mergeStringLists(task.comparison_axes, qualityGate?.comparison_axes),
    required_fields: mergeStringLists(task.required_fields, qualityGate?.required_fields),
  };

  return {
    ...merged,
    output_schema:
      task.output_schema
      ?? (
        qualityGate?.require_structured_output
        || merged.constraints.length > 0
        || merged.success_criteria.length > 0
        || merged.must_answer.length > 0
        || merged.comparison_axes.length > 0
        || merged.required_fields.length > 0
          ? "research_evidence_v1"
          : undefined
      ),
  };
}

function buildEffectiveQualityGate(input: SpawnSubAgentsInput): SpawnSubAgentsQualityGate | null {
  const mergedGate: SpawnSubAgentsQualityGate = {
    task_class: normalizeString(input.quality_gate?.task_class) || undefined,
    constraints: mergeStringLists(
      input.quality_gate?.constraints,
      ...input.sub_tasks.map((task) => task.constraints),
    ),
    success_criteria: mergeStringLists(
      input.quality_gate?.success_criteria,
      ...input.sub_tasks.map((task) => task.success_criteria),
    ),
    must_answer: mergeStringLists(
      input.quality_gate?.must_answer,
      ...input.sub_tasks.map((task) => task.must_answer),
    ),
    comparison_axes: mergeStringLists(
      input.quality_gate?.comparison_axes,
      ...input.sub_tasks.map((task) => task.comparison_axes),
    ),
    required_fields: mergeStringLists(
      input.quality_gate?.required_fields,
      ...input.sub_tasks.map((task) => task.required_fields),
    ),
    min_source_count: input.quality_gate?.min_source_count,
    require_structured_output:
      input.quality_gate?.require_structured_output
      ?? input.sub_tasks.some((task) => shouldRequireStructuredOutput(task)),
  };

  if (
    !mergedGate.task_class
    && (mergedGate.constraints?.length ?? 0) === 0
    && (mergedGate.success_criteria?.length ?? 0) === 0
    && (mergedGate.must_answer?.length ?? 0) === 0
    && (mergedGate.comparison_axes?.length ?? 0) === 0
    && (mergedGate.required_fields?.length ?? 0) === 0
    && !mergedGate.require_structured_output
    && mergedGate.min_source_count === undefined
  ) {
    return null;
  }

  return mergedGate;
}

function resolveCoverage(values: readonly string[], seen: ReadonlySet<string>): { covered: string[]; missing: string[] } {
  const covered: string[] = [];
  const missing: string[] = [];

  for (const value of values) {
    if (seen.has(toCoverageKey(value))) {
      covered.push(value);
    } else {
      missing.push(value);
    }
  }

  return { covered, missing };
}

export function evaluateSubAgentBatchQuality(input: {
  tasks: readonly SubTaskSpec[];
  results: readonly SubAgentResult[];
  qualityGate?: SpawnSubAgentsQualityGate | null;
}): SpawnSubAgentsBatchEvaluation {
  const qualityGate = input.qualityGate ?? null;
  const completed = input.results.filter((result) => result.status === "completed");
  const failedCount = input.results.filter((result) => result.status === "failed").length;
  const timeoutCount = input.results.filter((result) => result.status === "timeout").length;
  const taskById = new Map(input.tasks.map((task) => [task.id, task] as const));
  const summaries = completed.map((result) => summarizeSubAgentResearchQuality(taskById.get(result.id) ?? {
    id: result.id,
    task: "",
    tools: [],
  }, result.output));

  const uniqueSourceUrls = new Set(summaries.flatMap((summary) => summary.sourceUrls));
  const answeredQuestionKeys = new Set(
    summaries.flatMap((summary) => summary.answeredQuestions.map((item) => toCoverageKey(item))),
  );
  const coveredConstraintKeys = new Set(
    summaries.flatMap((summary) => summary.coveredConstraints.map((item) => toCoverageKey(item))),
  );
  const coveredSuccessCriteriaKeys = new Set(
    summaries.flatMap((summary) => summary.coveredSuccessCriteria.map((item) => toCoverageKey(item))),
  );
  const valueKeys = new Set(
    summaries.flatMap((summary) => summary.valueKeys.map((item) => toCoverageKey(item))),
  );

  const requiredFields = resolveCoverage(qualityGate?.required_fields ?? [], valueKeys);
  const comparisonAxes = resolveCoverage(qualityGate?.comparison_axes ?? [], valueKeys);
  const constraints = resolveCoverage(qualityGate?.constraints ?? [], coveredConstraintKeys);
  const successCriteria = resolveCoverage(qualityGate?.success_criteria ?? [], coveredSuccessCriteriaKeys);
  const mustAnswer = resolveCoverage(qualityGate?.must_answer ?? [], answeredQuestionKeys);
  const contradictionCount = summaries.reduce((total, summary) => total + summary.contradictionCount, 0);
  const unresolvedCount = summaries.reduce((total, summary) => total + summary.unresolvedCount, 0);
  const warnings = mergeStringLists(
    ...summaries.map((summary) => summary.warnings),
  );
  const blockingWarnings: string[] = [];

  if (completed.length === 0) {
    blockingWarnings.push("No sub-agents completed successfully.");
  }
  if ((qualityGate?.require_structured_output ?? false) && summaries.some((summary) => !summary.parsed)) {
    blockingWarnings.push("One or more completed sub-agents did not return structured evidence.");
  }
  if (requiredFields.missing.length > 0) {
    blockingWarnings.push(`Missing required evidence fields: ${requiredFields.missing.join(", ")}.`);
  }
  if (comparisonAxes.missing.length > 0) {
    blockingWarnings.push(`Missing comparison axes: ${comparisonAxes.missing.join(", ")}.`);
  }
  if (constraints.missing.length > 0) {
    blockingWarnings.push(`Missing constraint coverage: ${constraints.missing.join(", ")}.`);
  }
  if (successCriteria.missing.length > 0) {
    blockingWarnings.push(`Missing success-criteria coverage: ${successCriteria.missing.join(", ")}.`);
  }
  if (mustAnswer.missing.length > 0) {
    blockingWarnings.push(`Unanswered required questions: ${mustAnswer.missing.join(" | ")}.`);
  }
  if ((qualityGate?.min_source_count ?? 0) > uniqueSourceUrls.size) {
    blockingWarnings.push(
      `Only ${uniqueSourceUrls.size} unique sources collected; need at least ${qualityGate?.min_source_count}.`,
    );
  }
  if (contradictionCount > 0) {
    blockingWarnings.push(`Sub-agents reported ${contradictionCount} unresolved contradictions.`);
  }

  if (failedCount > 0) {
    warnings.push(`${failedCount} sub-agent(s) failed.`);
  }
  if (timeoutCount > 0) {
    warnings.push(`${timeoutCount} sub-agent(s) timed out.`);
  }
  if (unresolvedCount > 0) {
    warnings.push(`${unresolvedCount} unresolved gap(s) were reported by sub-agents.`);
  }

  const allWarnings = mergeStringLists(warnings, blockingWarnings);
  const followUpNeeded = blockingWarnings.length > 0;
  const followUpRecommendations =
    followUpNeeded
      ? [{
          id_hint: "coverage-follow-up",
          instruction: [
            "Run a targeted follow-up round that resolves the missing coverage before giving the final answer.",
            mustAnswer.missing.length > 0 ? `Answer these exact questions: ${mustAnswer.missing.join(" | ")}.` : "",
            requiredFields.missing.length > 0 ? `Fill these exact evidence fields: ${requiredFields.missing.join(", ")}.` : "",
            comparisonAxes.missing.length > 0 ? `Compare these axes explicitly: ${comparisonAxes.missing.join(", ")}.` : "",
            constraints.missing.length > 0 ? `Assess these constraints explicitly: ${constraints.missing.join(" | ")}.` : "",
            successCriteria.missing.length > 0 ? `Show how these success criteria are satisfied: ${successCriteria.missing.join(" | ")}.` : "",
            contradictionCount > 0 ? "Resolve the contradictory evidence or explain why it remains unresolved." : "",
          ].filter((line) => line.length > 0).join(" "),
          required_fields: requiredFields.missing,
          must_answer: mustAnswer.missing,
          comparison_axes: comparisonAxes.missing,
          constraints: constraints.missing,
          success_criteria: successCriteria.missing,
        }]
      : [];

  return {
    enabled: qualityGate !== null,
    task_class: qualityGate?.task_class ?? null,
    passed: blockingWarnings.length === 0,
    require_structured_output: qualityGate?.require_structured_output ?? false,
    completed_count: completed.length,
    failed_count: failedCount,
    timeout_count: timeoutCount,
    structured_completed_count: summaries.filter((summary) => summary.parsed).length,
    unique_source_count: uniqueSourceUrls.size,
    covered_required_fields: requiredFields.covered,
    missing_required_fields: requiredFields.missing,
    covered_comparison_axes: comparisonAxes.covered,
    missing_comparison_axes: comparisonAxes.missing,
    covered_constraints: constraints.covered,
    missing_constraints: constraints.missing,
    covered_success_criteria: successCriteria.covered,
    missing_success_criteria: successCriteria.missing,
    answered_questions: mustAnswer.covered,
    unanswered_questions: mustAnswer.missing,
    contradiction_count: contradictionCount,
    unresolved_count: unresolvedCount,
    warnings: allWarnings,
    follow_up_recommendations: followUpRecommendations,
  };
}

function buildSystemPrompt(task: SubTaskSpec): string {
  const structuredOutputRequired = shouldRequireStructuredOutput(task);
  const lines = [
    "You are a sub-agent executing a focused task. Complete the task using the available tools.",
    "",
    "Rules:",
    "- Execute the task directly. Do not ask questions or request clarification.",
    "- Use the provided tools to gather information or perform actions.",
    structuredOutputRequired
      ? "- Return strict JSON only. No prose before or after the JSON."
      : "- Return concise structured text with findings, evidence, and caveats.",
    "- If a tool call fails, note the failure and continue with the available information.",
    "- Do not speculate beyond what the tools return.",
    "",
    `Available tools: ${task.tools.join(", ")}`,
  ];

  if (structuredOutputRequired) {
    lines.push(
      "",
      "Return this JSON shape exactly:",
      "{\"summary\":\"...\",\"answered_questions\":[{\"question\":\"...\",\"answer\":\"...\",\"confidence\":\"low|medium|high\"}],\"findings\":[{\"claim\":\"...\",\"values\":{\"field\":\"value\"},\"fit_notes\":\"...\",\"source_urls\":[\"...\"]}],\"comparisons\":[{\"subject\":\"...\",\"values\":{\"field\":\"value\"},\"fit_notes\":\"...\",\"source_urls\":[\"...\"]}],\"constraint_assessments\":[{\"constraint\":\"...\",\"assessment\":\"...\"}],\"success_criteria_checks\":[{\"criterion\":\"...\",\"met\":true,\"evidence\":\"...\"}],\"required_field_values\":{\"field\":\"value\"},\"contradictions\":[],\"unresolved\":[],\"source_urls\":[\"...\"]}",
      "Use the exact provided strings for question, constraint, and criterion keys when they are supplied.",
      "Put concrete comparable measurements in `values` and `required_field_values` whenever possible.",
    );

    if ((task.constraints?.length ?? 0) > 0) {
      lines.push(`Constraints to assess exactly: ${task.constraints?.join(" | ")}`);
    }
    if ((task.success_criteria?.length ?? 0) > 0) {
      lines.push(`Success criteria to check exactly: ${task.success_criteria?.join(" | ")}`);
    }
    if ((task.must_answer?.length ?? 0) > 0) {
      lines.push(`Questions to answer exactly: ${task.must_answer?.join(" | ")}`);
    }
    if ((task.comparison_axes?.length ?? 0) > 0) {
      lines.push(`Comparison axes to fill in values: ${task.comparison_axes?.join(", ")}`);
    }
    if ((task.required_fields?.length ?? 0) > 0) {
      lines.push(`Required evidence fields to populate exactly: ${task.required_fields?.join(", ")}`);
    }
  }

  return lines.join("\n");
}

export function resolveSubTaskToolConfig(toolNames: readonly string[]): {
  concreteToolIds: string[];
  providerAllowlist: string[];
} {
  const concreteToolIds: string[] = [];
  const providerAllowlist = new Set<string>();

  for (const rawToolName of toolNames) {
    const toolName = rawToolName.trim();
    if (!toolName) {
      continue;
    }

    const normalized = toolName.toLowerCase();
    if (WEB_SEARCH_TOOL_ALIASES.has(normalized)) {
      providerAllowlist.add("WebSearch");
      continue;
    }
    if (WEB_FETCH_TOOL_ALIASES.has(normalized)) {
      providerAllowlist.add("WebFetch");
      continue;
    }

    concreteToolIds.push(toolName);
  }

  return {
    concreteToolIds,
    providerAllowlist: [...providerAllowlist],
  };
}

async function executeSubTaskViaProviders(input: {
  task: SubTaskSpec;
  timeoutSeconds: number;
  mcpServerScript: string;
  mcpServerName: string;
  persistentMcpPort?: number;
  coordinatorWorkerId: string;
}): Promise<{
  result: SubAgentResult;
  attemptedProviders: string[];
  reasoningEffort: string;
}> {
  const registry = createProviderRegistry(input.timeoutSeconds * 1000);
  const attemptedProviders: string[] = [];
  const failures: string[] = [];
  const providerNames = resolveSubTaskProviderNames(input.task);
  const reasoningEffort = input.task.reasoning_effort ?? "low";
  const resolvedToolConfig = resolveSubTaskToolConfig(input.task.tools);
  const tools = buildWorkerProviderTools({
    workerId: input.coordinatorWorkerId,
    mcpServerScript: input.mcpServerScript,
    mcpServerName: input.mcpServerName,
    persistentMcpPort: input.persistentMcpPort,
    toolIds: resolvedToolConfig.concreteToolIds,
    additionalAllowedToolNames: resolvedToolConfig.providerAllowlist,
  });
  const prompt = input.task.task.trim();
  const systemPrompt = buildSystemPrompt(input.task);
  const providerChain = providerNames.flatMap((providerName) => {
    const provider = registry.get(providerName);
    if (!provider) {
      failures.push(`Unsupported provider '${providerName}'.`);
      return [];
    }
    return [{ providerName, provider }];
  });

  if (providerChain.length === 0) {
    return {
      result: {
        id: input.task.id,
        status: "failed",
        output: "",
        tool_calls: [],
        duration_ms: 0,
        error: failures.join(" | ") || "No supported providers configured for sub-agent task.",
      },
      attemptedProviders,
      reasoningEffort,
    };
  }

  const requestedModel = input.task.model?.trim() || inferDefaultModel(providerChain[0]!.providerName);
  const retryLimit = normalizeIntegerEnv("TANGO_PROVIDER_RETRY_LIMIT", DEFAULT_SUB_AGENT_RETRY_LIMIT);
  const startedAt = Date.now();

  try {
    const failover = await generateWithFailover(
      providerChain,
      {
        prompt,
        systemPrompt,
        tools,
        reasoningEffort,
        ...(requestedModel ? { model: requestedModel } : {}),
      },
      retryLimit,
    );

    attemptedProviders.push(
      ...new Set([
        ...failover.failures.map((failure) => failure.providerName),
        failover.providerName,
      ]),
    );

    return {
      result: {
        id: input.task.id,
        status: "completed",
        output: failover.retryResult.response.text.trim(),
        tool_calls: summarizeToolCalls(failover.retryResult.response.toolCalls),
        duration_ms: Date.now() - startedAt,
        provider_name: failover.providerName,
        model: failover.retryResult.response.metadata?.model ?? requestedModel,
        cost_estimate_usd: failover.retryResult.response.metadata?.totalCostUsd,
      },
      attemptedProviders,
      reasoningEffort,
    };
  } catch (error) {
    const failoverError = error as ProviderFailoverError | null;
    if (failoverError && typeof failoverError === "object" && "failures" in failoverError) {
      attemptedProviders.push(...new Set(failoverError.failures.map((failure) => failure.providerName)));
      failures.push(...failoverError.failures.map((failure) => `${failure.providerName}: ${failure.lastError}`));
    } else {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
    }
  }

  return {
    result: {
      id: input.task.id,
      status: failures.some((failure) => /timedOut=true|timed?\s*out|timeout/iu.test(failure))
        ? "timeout"
        : "failed",
      output: "",
      tool_calls: [],
      duration_ms: 0,
      error: failures.join(" | ") || "Sub-agent failed before producing a result.",
    },
    attemptedProviders,
    reasoningEffort,
  };
}

function encodeResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function resolvePersistentMcpPort(): number | undefined {
  const raw = normalizeEnvString("TANGO_PERSISTENT_MCP_PORT");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildSpawnSubAgentsToolDefinition(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ReturnType<typeof getMcpToolAnnotations>;
} {
  return {
    name: SPAWN_SUB_AGENTS_TOOL_NAME,
    description: [
      "Spawn focused sub-agents for parallel research or analysis work.",
      "Each sub-agent is single-turn, tool-scoped, and returns a structured result.",
      "Use `quality_gate` plus per-task evidence fields when you need decision-grade output rather than a loose fact dump.",
      "Use provider names `claude-oauth`, `claude-oauth-secondary`, `claude-harness`, or `codex` when you need to override the default provider.",
      "You may call this tool a second time for a targeted follow-up round, but the runtime caps execution at 2 rounds and 12 total sub-agents.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        sub_tasks: {
          type: "array",
          description: "Sub-tasks to execute. Each needs id, task, and tools.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              task: { type: "string" },
              tools: {
                type: "array",
                items: { type: "string" },
              },
              provider: { type: "string" },
              model: { type: "string" },
              reasoning_effort: {
                type: "string",
                enum: ["low", "medium", "high", "max", "xhigh"],
              },
              depends_on: {
                type: "array",
                items: { type: "string" },
              },
              output_schema: {
                type: "string",
                enum: ["text", "research_evidence_v1"],
              },
              constraints: {
                type: "array",
                items: { type: "string" },
              },
              success_criteria: {
                type: "array",
                items: { type: "string" },
              },
              must_answer: {
                type: "array",
                items: { type: "string" },
              },
              comparison_axes: {
                type: "array",
                items: { type: "string" },
              },
              required_fields: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["id", "task", "tools"],
            additionalProperties: false,
          },
        },
        concurrency: { type: "number" },
        timeout_seconds: { type: "number" },
        max_rounds: { type: "number" },
        quality_gate: {
          type: "object",
          properties: {
            task_class: { type: "string" },
            constraints: {
              type: "array",
              items: { type: "string" },
            },
            success_criteria: {
              type: "array",
              items: { type: "string" },
            },
            must_answer: {
              type: "array",
              items: { type: "string" },
            },
            comparison_axes: {
              type: "array",
              items: { type: "string" },
            },
            required_fields: {
              type: "array",
              items: { type: "string" },
            },
            min_source_count: { type: "number" },
            require_structured_output: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["sub_tasks"],
      additionalProperties: false,
    },
    annotations: {
      ...getMcpToolAnnotations(SPAWN_SUB_AGENTS_TOOL_NAME, "read"),
      idempotentHint: false,
    },
  };
}

async function handleSpawnSubAgents(rawInput: Record<string, unknown>) {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return encodeResult({
      error: `Invalid spawn_sub_agents input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    }, true);
  }

  const effectiveInput: SpawnSubAgentsInput = {
    ...parsed.data,
    sub_tasks: parsed.data.sub_tasks.map((task) => mergeQualityGateIntoTask(task, parsed.data.quality_gate)),
  };
  const effectiveQualityGate = buildEffectiveQualityGate(effectiveInput);

  const batchId = randomUUID();
  const mcpServerScript =
    normalizeEnvString("TANGO_MCP_SERVER_SCRIPT")
    ?? process.env["TANGO_MCP_SERVER_SCRIPT"]
    ?? "packages/discord/dist/mcp-wellness-server.js";
  const mcpServerName = normalizeEnvString("TANGO_MCP_SERVER_NAME") ?? "wellness";
  const persistentMcpPort = resolvePersistentMcpPort();
  const coordinatorWorkerId =
    normalizeEnvString("TANGO_COORDINATOR_WORKER_ID")
    ?? normalizeEnvString("WORKER_ID")
    ?? "research-coordinator";
  const parentSessionId = normalizeEnvString("TANGO_PARENT_SESSION_ID") ?? null;
  const parentAgentId = normalizeEnvString("TANGO_PARENT_AGENT_ID") ?? null;
  const conversationKey = normalizeEnvString("TANGO_PARENT_CONVERSATION_KEY") ?? null;

  const result = await runSubAgentBatch(effectiveInput, {
    budget,
    maxRounds: 2,
    maxTotalSubAgents: 12,
    // Keep the batch inside the provider tool-call budget. Deeper follow-up
    // rounds are still possible, but each individual spawn should finish fast.
    defaultConcurrency: 2,
    concurrencyMax: 3,
    defaultTimeoutSeconds: 60,
    timeoutSecondsMax: 75,
    executeSubTask: async (task, context) => {
      const execution = await executeSubTaskViaProviders({
        task,
        timeoutSeconds: context.timeoutSeconds,
        mcpServerScript,
        mcpServerName,
        persistentMcpPort,
        coordinatorWorkerId,
      });
      const qualitySummary = summarizeSubAgentResearchQuality(task, execution.result.output);

      storage.insertSubAgentRun({
        batchId,
        parentSessionId,
        parentAgentId,
        conversationKey,
        coordinatorWorkerId,
        roundIndex: context.round,
        subTaskId: task.id,
        providerName: execution.result.provider_name ?? null,
        model: execution.result.model ?? null,
        reasoningEffort: execution.reasoningEffort,
        toolIds: task.tools,
        dependencyIds: task.depends_on ?? [],
        status: execution.result.status,
        durationMs: execution.result.duration_ms,
        costEstimateUsd: execution.result.cost_estimate_usd ?? null,
        error: execution.result.error ?? null,
        outputText: execution.result.output,
        toolCallsJson: execution.result.tool_calls,
        metadata: {
          attemptedProviders: execution.attemptedProviders,
          outputSchema: task.output_schema ?? null,
          quality: {
            parsedStructuredOutput: qualitySummary.parsed,
            sourceUrlCount: qualitySummary.sourceUrls.length,
            findingsCount: qualitySummary.findingsCount,
            contradictionCount: qualitySummary.contradictionCount,
            unresolvedCount: qualitySummary.unresolvedCount,
            coveredConstraints: qualitySummary.coveredConstraints,
            coveredSuccessCriteria: qualitySummary.coveredSuccessCriteria,
            answeredQuestions: qualitySummary.answeredQuestions,
            valueKeys: qualitySummary.valueKeys,
            warnings: qualitySummary.warnings,
          },
        },
      });

      return execution.result;
    },
  });
  const evaluation = evaluateSubAgentBatchQuality({
    tasks: effectiveInput.sub_tasks,
    results: result.results,
    qualityGate: effectiveQualityGate,
  });

  debug(
    `spawn_sub_agents batch=${batchId} round=${budget.roundsUsed} ` +
    `tasks=${parsed.data.sub_tasks.length} results=${result.results.length} ` +
    `cost=${result.cost_estimate_usd.toFixed(4)}`,
  );

  return encodeResult({
    batch_id: batchId,
    round_index: budget.roundsUsed,
    quality_gate: effectiveQualityGate,
    evaluation,
    ...result,
  });
}

export async function startSubAgentMcpServer(): Promise<void> {
  const tool = buildSpawnSubAgentsToolDefinition();
  const server = new Server(
    { name: SUB_AGENT_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [tool],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    debug(`tools/call ${name}`);

    if (name !== SPAWN_SUB_AGENTS_TOOL_NAME) {
      return encodeResult({ error: `Unknown tool: ${name}` }, true);
    }

    return handleSpawnSubAgents((args ?? {}) as Record<string, unknown>);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("MCP sub-agent server connected");
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  await startSubAgentMcpServer();
}
