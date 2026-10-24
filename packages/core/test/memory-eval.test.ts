import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicEmbeddingProvider } from "../src/embeddings.js";
import {
  auditPromptSnapshotsWithProvider,
  collectPromptSnapshotAuditSamples,
  loadMemoryEvalConfig,
  renderMemoryEvalDiscordSummary,
  renderMemoryEvalMarkdownReport,
  runMemoryEvalBenchmarks,
  type MemoryEvalConfig,
} from "../src/memory-eval.js";
import { TangoStorage } from "../src/storage.js";
import type { ChatProvider, ProviderResponse } from "../src/provider.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-memory-eval-"));
  tempDirs.push(dir);
  return dir;
}

function createStorage(dir: string): TangoStorage {
  return new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
}

describe("memory-eval", () => {
  it("loads config and runs benchmark cases", async () => {
    const dir = createTempDir();
    const configDir = path.join(dir, "config");
    fs.mkdirSync(path.join(configDir, "memory-evals"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "memory-evals", "default.yaml"),
      [
        "criteria:",
        "  - Prefer on-topic memories over archive noise.",
        "sample_audit:",
        "  sample_size: 1",
        "benchmarks:",
        "  - id: watson-weekly-review",
        "    agent_id: watson",
        "    query: What did we decide about weekly reviews and productivity cadence?",
        "    expected_terms:",
        "      - weekly",
        "      - productivity",
        "    forbidden_terms:",
        "      - yogurt",
      ].join("\n"),
      "utf8"
    );

    const config = loadMemoryEvalConfig(configDir);
    expect(config.criteria).toHaveLength(1);
    expect(config.benchmarks).toHaveLength(1);

    const storage = createStorage(dir);
    try {
      const embeddingProvider = createDeterministicEmbeddingProvider(8);
      const [weeklyEmbedding, yogurtEmbedding] = await embeddingProvider.embed([
        "Weekly productivity review happens on Mondays.",
        "Protein yogurt bowl with fruit.",
      ]);

      storage.insertMemory({
        agentId: "watson",
        source: "reflection",
        content: "Weekly productivity review happens on Mondays.",
        embeddingJson: JSON.stringify(weeklyEmbedding),
        embeddingModel: embeddingProvider.model,
      });
      storage.insertMemory({
        agentId: "malibu",
        source: "reflection",
        content: "Protein yogurt bowl with fruit.",
        embeddingJson: JSON.stringify(yogurtEmbedding),
        embeddingModel: embeddingProvider.model,
      });

      const run = await runMemoryEvalBenchmarks({
        storage,
        config,
        embeddingProvider,
      });

      expect(run.passedCount).toBe(1);
      expect(run.failedCount).toBe(0);
      expect(run.cases[0]?.matchedExpectedTerms).toEqual(expect.arrayContaining(["weekly", "productivity"]));
      expect(run.cases[0]?.matchedForbiddenTerms).toHaveLength(0);
    } finally {
      storage.close();
    }
  });

  it("collects snapshot samples, audits them with a provider, and renders reports", async () => {
    const dir = createTempDir();
    const storage = createStorage(dir);

    try {
      storage.bootstrapSessions([
        {
          id: "tango-default",
          type: "persistent",
          agent: "dispatch",
          channels: ["discord:default"],
        },
      ]);

      const requestMessageId = storage.insertMessage({
        sessionId: "tango-default",
        agentId: "watson",
        direction: "inbound",
        source: "discord",
        content: "Can you remind me what we decided about weekly reviews?",
      });
      const responseMessageId = storage.insertMessage({
        sessionId: "tango-default",
        agentId: "watson",
        providerName: "claude-oauth",
        direction: "outbound",
        source: "tango",
        content: "We decided to keep weekly reviews short and action-focused.",
      });
      const modelRunId = storage.insertModelRun({
        sessionId: "tango-default",
        agentId: "watson",
        providerName: "claude-oauth",
        conversationKey: "tango-default:watson",
        model: "claude-sonnet-4-6",
        requestMessageId,
        responseMessageId,
        responseMode: "concise",
      });

      storage.insertPromptSnapshot({
        modelRunId,
        sessionId: "tango-default",
        agentId: "watson",
        providerName: "claude-oauth",
        requestMessageId,
        responseMessageId,
        promptText: "Current user message:\nCan you remind me what we decided about weekly reviews?",
        systemPrompt: "You are Watson",
        warmStartPrompt: "retrieved_memories:\n- Weekly productivity review happens on Mondays.",
        metadata: {
          turnWarmStartUsed: true,
          requestWarmStartUsed: true,
          warmStartContext: {
            strategy: "session-memory-prompt",
            memoryPrompt: {
              trace: {
                pinnedFacts: [{ key: "timezone", value: "America/Los_Angeles", scope: "global" }],
                summaries: [{ summaryText: "Weekly review planning came up repeatedly.", coversThroughMessageId: 12 }],
                memories: [{ id: 7, source: "reflection", score: 3.2, content: "Weekly productivity review happens on Mondays." }],
                recentMessages: [{ direction: "inbound", content: "Can you remind me what we decided about weekly reviews?" }],
              },
            },
          },
        },
      });

      const config: MemoryEvalConfig = {
        criteria: [
          "Prefer on-topic memories over archive noise.",
          "Avoid obvious cross-domain bleed.",
        ],
        sampleAudit: {
          sampleSize: 1,
          lookbackHours: 24,
          includeFailed: false,
          candidateLimit: 10,
          maxMemoriesPerSample: 3,
          maxRecentMessagesPerSample: 2,
          maxSummariesPerSample: 2,
          maxPinnedFactsPerSample: 2,
        },
        benchmarks: [],
      };

      const samples = collectPromptSnapshotAuditSamples({
        storage,
        config,
        now: new Date("2026-03-11T18:00:00.000Z"),
      });
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({
        runId: modelRunId,
        requestText: "Can you remind me what we decided about weekly reviews?",
        responseText: "We decided to keep weekly reviews short and action-focused.",
        turnWarmStartUsed: true,
      });
      expect(samples[0]?.memories[0]?.content).toContain("Weekly productivity review");

      const provider: ChatProvider = {
        async generate(): Promise<ProviderResponse> {
          return {
            text: JSON.stringify({
              overall_health: "good",
              summary: "Memory injection looked relevant and concise.",
              wins: ["Retrieved memory matched the user prompt."],
              issues: [],
              audits: [
                {
                  run_id: modelRunId,
                  grade: "good",
                  summary: "Good retrieval quality for a weekly-review turn.",
                  wins: ["Top memory was on-topic."],
                  issues: [],
                },
              ],
            }),
          };
        },
      };

      const audit = await auditPromptSnapshotsWithProvider({
        provider,
        criteria: config.criteria,
        samples,
      });
      expect(audit.overallHealth).toBe("good");
      expect(audit.audits[0]?.runId).toBe(modelRunId);

      const markdown = renderMemoryEvalMarkdownReport({
        generatedAt: "2026-03-11T18:00:00.000Z",
        config,
        benchmarkRun: { cases: [], passedCount: 0, failedCount: 0 },
        snapshotSamples: samples,
        auditReview: audit,
        reportPath: "data/reports/memory-eval-2026-03-11.md",
      });
      expect(markdown).toContain("Memory System Daily Report");
      expect(markdown).toContain("Run " + modelRunId);

      const summary = renderMemoryEvalDiscordSummary({
        generatedAt: "2026-03-11T18:00:00.000Z",
        benchmarkRun: { cases: [], passedCount: 0, failedCount: 0 },
        snapshotSamples: samples,
        auditReview: audit,
        reportPath: "data/reports/memory-eval-2026-03-11.md",
      });
      expect(summary).toContain("audit_health=good");
      expect(summary).toContain("run " + modelRunId);
    } finally {
      storage.close();
    }
  });
});
