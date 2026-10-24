import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { ChatProvider } from "./provider.js";
import { resolveConfigDir } from "./config.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { searchMemories, type RetrievedMemoryRecord } from "./memory-system.js";
import type {
  PromptSnapshotRecord,
  StoredMemoryRecord,
  TangoStorage,
} from "./storage.js";
import type { MemorySource } from "./types.js";

const DEFAULT_MEMORY_EVAL_CONFIG_PATH = path.join("memory-evals", "default.yaml");

const benchmarkCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  source: z.enum(["conversation", "obsidian", "reflection", "manual", "backfill", "all"]).optional(),
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  pool_limit: z.number().int().positive().optional(),
  expected_terms: z.array(z.string().min(1)).optional(),
  forbidden_terms: z.array(z.string().min(1)).optional(),
  expected_sources: z.array(z.enum(["conversation", "obsidian", "reflection", "manual", "backfill"])).optional(),
  forbidden_sources: z.array(z.enum(["conversation", "obsidian", "reflection", "manual", "backfill"])).optional(),
  min_expected_term_hits: z.number().int().nonnegative().optional(),
});

const memoryEvalConfigSchema = z.object({
  criteria: z.array(z.string().min(1)).default([]),
  sample_audit: z.object({
    sample_size: z.number().int().positive().default(3),
    lookback_hours: z.number().positive().default(24),
    include_failed: z.boolean().default(false),
    candidate_limit: z.number().int().positive().default(60),
    max_memories_per_sample: z.number().int().positive().default(5),
    max_recent_messages_per_sample: z.number().int().positive().default(4),
    max_summaries_per_sample: z.number().int().positive().default(2),
    max_pinned_facts_per_sample: z.number().int().positive().default(5),
  }).default({}),
  benchmarks: z.array(benchmarkCaseSchema).default([]),
});

const llmAuditSchema = z.object({
  overall_health: z.enum(["good", "mixed", "poor"]),
  summary: z.string().min(1),
  wins: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  audits: z.array(z.object({
    run_id: z.number().int().positive(),
    grade: z.enum(["good", "mixed", "poor"]),
    summary: z.string().min(1),
    wins: z.array(z.string()).default([]),
    issues: z.array(z.string()).default([]),
  })).default([]),
});

export interface MemoryEvalBenchmarkCase {
  id: string;
  description?: string;
  agentId?: string;
  sessionId?: string;
  source?: MemorySource | "all";
  query: string;
  limit?: number;
  poolLimit?: number;
  expectedTerms: string[];
  forbiddenTerms: string[];
  expectedSources: MemorySource[];
  forbiddenSources: MemorySource[];
  minExpectedTermHits?: number;
}

export interface MemoryEvalConfig {
  criteria: string[];
  sampleAudit: {
    sampleSize: number;
    lookbackHours: number;
    includeFailed: boolean;
    candidateLimit: number;
    maxMemoriesPerSample: number;
    maxRecentMessagesPerSample: number;
    maxSummariesPerSample: number;
    maxPinnedFactsPerSample: number;
  };
  benchmarks: MemoryEvalBenchmarkCase[];
}

export interface MemoryEvalBenchmarkCaseResult {
  caseId: string;
  query: string;
  agentId?: string;
  sessionId?: string;
  passed: boolean;
  matchedExpectedTerms: string[];
  matchedForbiddenTerms: string[];
  matchedExpectedSources: MemorySource[];
  matchedForbiddenSources: MemorySource[];
  results: RetrievedMemoryRecord[];
  failureReasons: string[];
}

export interface MemoryEvalBenchmarkRun {
  cases: MemoryEvalBenchmarkCaseResult[];
  passedCount: number;
  failedCount: number;
}

export interface PromptSnapshotAuditSample {
  runId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  model: string | null;
  createdAt: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
  requestText: string | null;
  responseText: string | null;
  promptText: string;
  systemPrompt: string | null;
  warmStartPrompt: string | null;
  strategy: string;
  turnWarmStartUsed: boolean;
  requestWarmStartUsed: boolean;
  usedWorkerSynthesis: boolean;
  failed: boolean;
  pinnedFacts: Array<{ key: string; value: string; scope: string }>;
  summaries: Array<{ summaryText: string; coversThroughMessageId: number | null }>;
  memories: Array<{ id: number; source: string; score: number; content: string }>;
  recentMessages: Array<{ direction: string; content: string }>;
}

export interface PromptSnapshotAuditReview {
  overallHealth: "good" | "mixed" | "poor";
  summary: string;
  wins: string[];
  issues: string[];
  audits: Array<{
    runId: number;
    grade: "good" | "mixed" | "poor";
    summary: string;
    wins: string[];
    issues: string[];
  }>;
}

export function loadMemoryEvalConfig(configDir?: string, relativePath = DEFAULT_MEMORY_EVAL_CONFIG_PATH): MemoryEvalConfig {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const fullPath = path.join(resolvedConfigDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Memory eval config not found: ${fullPath}`);
  }

  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = memoryEvalConfigSchema.parse(yaml.load(raw));

  return {
    criteria: parsed.criteria,
    sampleAudit: {
      sampleSize: parsed.sample_audit.sample_size,
      lookbackHours: parsed.sample_audit.lookback_hours,
      includeFailed: parsed.sample_audit.include_failed,
      candidateLimit: parsed.sample_audit.candidate_limit,
      maxMemoriesPerSample: parsed.sample_audit.max_memories_per_sample,
      maxRecentMessagesPerSample: parsed.sample_audit.max_recent_messages_per_sample,
      maxSummariesPerSample: parsed.sample_audit.max_summaries_per_sample,
      maxPinnedFactsPerSample: parsed.sample_audit.max_pinned_facts_per_sample,
    },
    benchmarks: parsed.benchmarks.map((benchmark) => ({
      id: benchmark.id,
      description: benchmark.description,
      agentId: benchmark.agent_id,
      sessionId: benchmark.session_id,
      source: benchmark.source,
      query: benchmark.query,
      limit: benchmark.limit,
      poolLimit: benchmark.pool_limit,
      expectedTerms: benchmark.expected_terms ?? [],
      forbiddenTerms: benchmark.forbidden_terms ?? [],
      expectedSources: benchmark.expected_sources ?? [],
      forbiddenSources: benchmark.forbidden_sources ?? [],
      minExpectedTermHits: benchmark.min_expected_term_hits,
    })),
  };
}

export async function runMemoryEvalBenchmarks(input: {
  storage: TangoStorage;
  config: MemoryEvalConfig;
  embeddingProvider?: EmbeddingProvider | null;
  /**
   * Candidate-pool override so benchmarks measure the substrate the live
   * read path uses (e.g. the Atlas store) instead of core storage (TGO-698).
   */
  listCandidates?: (filter: {
    sessionId?: string;
    agentId?: string;
    source?: MemorySource | "all";
    limit: number;
  }) => StoredMemoryRecord[];
  now?: Date;
}): Promise<MemoryEvalBenchmarkRun> {
  const results: MemoryEvalBenchmarkCaseResult[] = [];

  for (const benchmark of input.config.benchmarks) {
    const poolFilter = {
      sessionId: benchmark.sessionId,
      agentId: benchmark.agentId,
      source: benchmark.source,
      limit: benchmark.poolLimit ?? 4000,
    };
    const candidateMemories = input.listCandidates
      ? input.listCandidates(poolFilter)
      : input.storage.listMemories(poolFilter);
    const ranked = await searchMemories({
      query: benchmark.query,
      memories: candidateMemories,
      embeddingProvider: input.embeddingProvider ?? null,
      sessionId: benchmark.sessionId,
      agentId: benchmark.agentId,
      source: benchmark.source,
      limit: benchmark.limit ?? 5,
      now: input.now,
    });

    const matchedExpectedTerms = matchTerms(ranked, benchmark.expectedTerms);
    const matchedForbiddenTerms = matchTerms(ranked, benchmark.forbiddenTerms);
    const matchedExpectedSources = matchSources(ranked, benchmark.expectedSources);
    const matchedForbiddenSources = matchSources(ranked, benchmark.forbiddenSources);
    const minExpectedTermHits =
      benchmark.minExpectedTermHits
      ?? (benchmark.expectedTerms.length > 0 ? 1 : 0);

    const failureReasons: string[] = [];
    if (matchedExpectedTerms.length < minExpectedTermHits) {
      failureReasons.push(
        `expected_terms=${benchmark.expectedTerms.join(", ") || "-"} matched=${matchedExpectedTerms.join(", ") || "-"}`
      );
    }
    if (benchmark.expectedSources.length > 0 && matchedExpectedSources.length === 0) {
      failureReasons.push(
        `expected_sources=${benchmark.expectedSources.join(", ")} matched=none`
      );
    }
    if (matchedForbiddenTerms.length > 0) {
      failureReasons.push(`forbidden_terms=${matchedForbiddenTerms.join(", ")}`);
    }
    if (matchedForbiddenSources.length > 0) {
      failureReasons.push(`forbidden_sources=${matchedForbiddenSources.join(", ")}`);
    }

    results.push({
      caseId: benchmark.id,
      query: benchmark.query,
      agentId: benchmark.agentId,
      sessionId: benchmark.sessionId,
      passed: failureReasons.length === 0,
      matchedExpectedTerms,
      matchedForbiddenTerms,
      matchedExpectedSources,
      matchedForbiddenSources,
      results: ranked,
      failureReasons,
    });
  }

  return {
    cases: results,
    passedCount: results.filter((result) => result.passed).length,
    failedCount: results.filter((result) => !result.passed).length,
  };
}

export function collectPromptSnapshotAuditSamples(input: {
  storage: TangoStorage;
  config: MemoryEvalConfig;
  now?: Date;
}): PromptSnapshotAuditSample[] {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.config.sampleAudit.lookbackHours * 60 * 60 * 1000).toISOString();
  const candidates = input.storage.listRecentPromptSnapshots({
    since,
    limit: input.config.sampleAudit.candidateLimit,
  });

  const hydrated = candidates
    .map((snapshot) => hydratePromptSnapshotSample(input.storage, snapshot, input.config))
    .filter((sample): sample is PromptSnapshotAuditSample => sample !== null)
    .filter((sample) => input.config.sampleAudit.includeFailed || !sample.failed);

  const withMemoryContext = hydrated.filter((sample) =>
    sample.turnWarmStartUsed
    || sample.requestWarmStartUsed
    || sample.memories.length > 0
    || sample.summaries.length > 0
    || sample.pinnedFacts.length > 0
  );
  const withoutMemoryContext = hydrated.filter((sample) => !withMemoryContext.some((candidate) => candidate.runId === sample.runId));
  const selected = [
    ...deterministicSample(withMemoryContext, input.config.sampleAudit.sampleSize, now),
    ...deterministicSample(
      withoutMemoryContext,
      Math.max(input.config.sampleAudit.sampleSize - withMemoryContext.length, 0),
      now,
      "fallback"
    ),
  ];

  return selected.slice(0, input.config.sampleAudit.sampleSize);
}

export async function auditPromptSnapshotsWithProvider(input: {
  provider: ChatProvider;
  criteria: string[];
  samples: PromptSnapshotAuditSample[];
}): Promise<PromptSnapshotAuditReview> {
  if (input.samples.length === 0) {
    return {
      overallHealth: "mixed",
      summary: "No prompt snapshots were available for audit.",
      wins: [],
      issues: ["No recent prompt snapshots matched the audit window."],
      audits: [],
    };
  }

  const response = await input.provider.generate({
    systemPrompt:
      "You audit conversational memory systems. Be concise, skeptical, and specific. Return JSON only with no markdown fences.",
    prompt: buildSnapshotAuditPrompt(input.criteria, input.samples),
  });

  const parsed = llmAuditSchema.parse(extractJsonObject(response.text));
  return {
    overallHealth: parsed.overall_health,
    summary: parsed.summary,
    wins: parsed.wins,
    issues: parsed.issues,
    audits: parsed.audits.map((audit) => ({
      runId: audit.run_id,
      grade: audit.grade,
      summary: audit.summary,
      wins: audit.wins,
      issues: audit.issues,
    })),
  };
}

export function renderMemoryEvalMarkdownReport(input: {
  generatedAt?: string;
  config: MemoryEvalConfig;
  benchmarkRun: MemoryEvalBenchmarkRun;
  snapshotSamples: PromptSnapshotAuditSample[];
  auditReview?: PromptSnapshotAuditReview | null;
  reportPath?: string;
}): string {
  const lines: string[] = [
    "# Memory System Daily Report",
    "",
    `- Generated: ${input.generatedAt ?? new Date().toISOString()}`,
    `- Benchmarks: ${input.benchmarkRun.passedCount}/${input.benchmarkRun.cases.length} passed`,
    `- Snapshot samples: ${input.snapshotSamples.length}`,
    `- Criteria: ${input.config.criteria.length}`,
  ];

  if (input.reportPath) {
    lines.push(`- Saved report: ${input.reportPath}`);
  }

  lines.push("", "## Benchmark Results", "");
  if (input.benchmarkRun.cases.length === 0) {
    lines.push("- No benchmark cases configured.", "");
  } else {
    for (const result of input.benchmarkRun.cases) {
      const prefix = result.passed ? "PASS" : "FAIL";
      const topSources = uniqueStrings(result.results.map((memory) => memory.source)).slice(0, 3).join(", ") || "-";
      lines.push(`- [${prefix}] ${result.caseId} — top_sources=${topSources}`);
      if (!result.passed) {
        for (const reason of result.failureReasons) {
          lines.push(`  reason: ${reason}`);
        }
      }
    }
    lines.push("");
  }

  lines.push("## Snapshot Audit", "");
  if (input.auditReview) {
    lines.push(`- Overall health: ${input.auditReview.overallHealth}`);
    lines.push(`- Summary: ${input.auditReview.summary}`);
    for (const issue of input.auditReview.issues) {
      lines.push(`- Issue: ${issue}`);
    }
    for (const win of input.auditReview.wins) {
      lines.push(`- Win: ${win}`);
    }
    lines.push("");
  } else {
    lines.push("- No LLM audit review was produced.", "");
  }

  for (const sample of input.snapshotSamples) {
    const audit = input.auditReview?.audits.find((entry) => entry.runId === sample.runId);
    lines.push(`### Run ${sample.runId}`);
    lines.push(`- Agent/session: ${sample.agentId} / ${sample.sessionId}`);
    lines.push(`- Created: ${sample.createdAt}`);
    lines.push(`- Warm start: turn=${sample.turnWarmStartUsed ? "yes" : "no"} request=${sample.requestWarmStartUsed ? "yes" : "no"} strategy=${sample.strategy}`);
    lines.push(`- Request: ${truncateText(sample.requestText ?? sample.promptText, 240)}`);
    if (sample.responseText) {
      lines.push(`- Response: ${truncateText(sample.responseText, 240)}`);
    }
    if (sample.memories.length > 0) {
      lines.push(`- Top memories: ${sample.memories.map((memory) => `[${memory.source}] ${truncateText(memory.content, 80)}`).join(" | ")}`);
    }
    if (audit) {
      lines.push(`- Audit: ${audit.grade} — ${audit.summary}`);
      for (const issue of audit.issues) {
        lines.push(`  issue: ${issue}`);
      }
      for (const win of audit.wins) {
        lines.push(`  win: ${win}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function renderMemoryEvalDiscordSummary(input: {
  generatedAt?: string;
  benchmarkRun: MemoryEvalBenchmarkRun;
  snapshotSamples: PromptSnapshotAuditSample[];
  auditReview?: PromptSnapshotAuditReview | null;
  reportPath?: string;
}): string {
  const failedBenchmarks = input.benchmarkRun.cases.filter((result) => !result.passed).slice(0, 5);
  const auditIssues = input.auditReview?.issues ?? [];
  const auditEntries = input.auditReview?.audits ?? [];

  const lines = [
    "**Memory System Daily Report**",
    `generated=${input.generatedAt ?? new Date().toISOString()}`,
    `benchmarks=${input.benchmarkRun.passedCount}/${input.benchmarkRun.cases.length} passed`,
    `snapshot_samples=${input.snapshotSamples.length}`,
    `audit_health=${input.auditReview?.overallHealth ?? "not-run"}`,
  ];

  if (input.reportPath) {
    lines.push(`report=${input.reportPath}`);
  }

  if (failedBenchmarks.length > 0) {
    lines.push("", "**Benchmark misses**");
    for (const result of failedBenchmarks) {
      lines.push(`- ${result.caseId}: ${result.failureReasons.join("; ")}`);
    }
  }

  if (auditIssues.length > 0) {
    lines.push("", "**Audit issues**");
    for (const issue of auditIssues.slice(0, 5)) {
      lines.push(`- ${issue}`);
    }
  }

  if (auditEntries.length > 0) {
    lines.push("", "**Sample reviews**");
    for (const audit of auditEntries.slice(0, 5)) {
      lines.push(`- run ${audit.runId}: ${audit.grade} — ${audit.summary}`);
    }
  }

  return lines.join("\n");
}

function hydratePromptSnapshotSample(
  storage: TangoStorage,
  snapshot: PromptSnapshotRecord,
  config: MemoryEvalConfig
): PromptSnapshotAuditSample | null {
  const modelRun = storage.getModelRun(snapshot.modelRunId);
  if (!modelRun) return null;

  const requestMessage = snapshot.requestMessageId ? storage.getMessage(snapshot.requestMessageId) : null;
  const responseMessage = snapshot.responseMessageId ? storage.getMessage(snapshot.responseMessageId) : null;
  const warmStartContext = asRecord(snapshot.metadata?.warmStartContext);
  const memoryPrompt = asRecord(warmStartContext?.memoryPrompt);
  const trace = asRecord(memoryPrompt?.trace);

  return {
    runId: snapshot.modelRunId,
    sessionId: snapshot.sessionId,
    agentId: snapshot.agentId,
    providerName: snapshot.providerName,
    model: modelRun.model,
    createdAt: snapshot.createdAt,
    requestMessageId: snapshot.requestMessageId,
    responseMessageId: snapshot.responseMessageId,
    requestText: requestMessage?.content ?? null,
    responseText: responseMessage?.content ?? null,
    promptText: snapshot.promptText,
    systemPrompt: snapshot.systemPrompt,
    warmStartPrompt: snapshot.warmStartPrompt,
    strategy: metadataString(warmStartContext, "strategy") ?? "none",
    turnWarmStartUsed: metadataBoolean(snapshot.metadata, "turnWarmStartUsed"),
    requestWarmStartUsed: metadataBoolean(snapshot.metadata, "requestWarmStartUsed"),
    usedWorkerSynthesis: metadataBoolean(snapshot.metadata, "usedWorkerSynthesis"),
    failed: metadataBoolean(snapshot.metadata, "failed") || modelRun.isError === 1,
    pinnedFacts: asRecordArray(trace?.pinnedFacts)
      .slice(0, config.sampleAudit.maxPinnedFactsPerSample)
      .map((fact) => ({
        key: metadataString(fact, "key") ?? "?",
        value: metadataString(fact, "value") ?? "",
        scope: metadataString(fact, "scope") ?? "-",
      })),
    summaries: asRecordArray(trace?.summaries)
      .slice(0, config.sampleAudit.maxSummariesPerSample)
      .map((summary) => ({
        summaryText: metadataString(summary, "summaryText") ?? "",
        coversThroughMessageId: metadataNumber(summary, "coversThroughMessageId") ?? null,
      })),
    memories: asRecordArray(trace?.memories)
      .slice(0, config.sampleAudit.maxMemoriesPerSample)
      .map((memory) => ({
        id: metadataNumber(memory, "id") ?? 0,
        source: metadataString(memory, "source") ?? "-",
        score: metadataFloat(memory, "score") ?? 0,
        content: metadataString(memory, "content") ?? "",
      })),
    recentMessages: asRecordArray(trace?.recentMessages)
      .slice(-config.sampleAudit.maxRecentMessagesPerSample)
      .map((message) => ({
        direction: metadataString(message, "direction") ?? "-",
        content: metadataString(message, "content") ?? "",
      })),
  };
}

function deterministicSample<T extends { runId: number }>(
  values: T[],
  limit: number,
  now: Date,
  salt = "primary"
): T[] {
  if (limit < 1 || values.length === 0) return [];
  const dayKey = now.toISOString().slice(0, 10);
  return [...values]
    .sort((a, b) => {
      const hashDelta = seededHash(`${dayKey}:${salt}:${a.runId}`) - seededHash(`${dayKey}:${salt}:${b.runId}`);
      if (hashDelta !== 0) return hashDelta;
      return b.runId - a.runId;
    })
    .slice(0, limit);
}

function buildSnapshotAuditPrompt(criteria: string[], samples: PromptSnapshotAuditSample[]): string {
  return [
    "Audit these Tango memory-system prompt snapshots.",
    "",
    "Criteria:",
    ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "Return JSON only with this shape:",
    '{"overall_health":"good|mixed|poor","summary":"...","wins":["..."],"issues":["..."],"audits":[{"run_id":123,"grade":"good|mixed|poor","summary":"...","wins":["..."],"issues":["..."]}]}',
    "",
    "Prompt snapshots:",
    JSON.stringify(samples, null, 2),
  ].join("\n");
}

function extractJsonObject(input: string): unknown {
  const trimmed = input.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("LLM audit response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function matchTerms(results: RetrievedMemoryRecord[], terms: string[]): string[] {
  if (terms.length === 0) return [];
  const haystacks = results.map((memory) => memory.content.toLowerCase());
  return terms.filter((term) => {
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) return false;
    return haystacks.some((haystack) => haystack.includes(needle));
  });
}

function matchSources(results: RetrievedMemoryRecord[], sources: MemorySource[]): MemorySource[] {
  if (sources.length === 0) return [];
  const seen = new Set(results.map((memory) => memory.source));
  return sources.filter((source) => seen.has(source));
}

function seededHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function truncateText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataFloat(metadata: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataBoolean(metadata: Record<string, unknown> | null | undefined, key: string): boolean {
  return metadata?.[key] === true;
}
