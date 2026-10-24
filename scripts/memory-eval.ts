#!/usr/bin/env tsx

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import {
  auditPromptSnapshotsWithProvider,
  collectPromptSnapshotAuditSamples,
  createBuiltInProviderRegistry,
  createVoyageEmbeddingProviderFromEnv,
  loadMemoryEvalConfig,
  renderMemoryEvalDiscordSummary,
  renderMemoryEvalMarkdownReport,
  resolveDatabasePath,
  runMemoryEvalBenchmarks,
  selectProviderByName,
  TangoStorage,
} from "../packages/core/src/index.ts";
import { listAtlasMemoriesForContext } from "../packages/atlas-memory/src/context-read.ts";
import { openAtlasMemoryDatabase } from "../packages/atlas-memory/src/schema.ts";
import {
  mapAtlasContextRows,
  resolveWarmStartMemorySubstrate,
} from "../packages/discord/src/warm-start-memory-source.ts";

dotenv.config();

interface CliOptions {
  dbPath?: string;
  configDir?: string;
  configPath?: string;
  auditWithLlm: boolean;
  providerName: string;
  reportFile?: string;
  substrate: "atlas" | "core";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDatabasePath(options.dbPath);
  const storage = new TangoStorage(dbPath);
  const embeddingProvider = createVoyageEmbeddingProviderFromEnv();
  // Benchmarks run against the same substrate live warm-start reads (TGO-698).
  const atlasDb = options.substrate === "atlas" ? openAtlasMemoryDatabase({}).db : null;
  console.log(`[memory-eval] benchmark substrate=${options.substrate}`);

  try {
    const config = loadMemoryEvalConfig(
      options.configDir,
      options.configPath ?? path.join("memory-evals", "default.yaml")
    );
    const benchmarkRun = await runMemoryEvalBenchmarks({
      storage,
      config,
      embeddingProvider,
      listCandidates: atlasDb
        ? (filter) =>
            mapAtlasContextRows(
              listAtlasMemoriesForContext(atlasDb, {
                agentId: filter.agentId ?? null,
                limit: filter.limit,
              }),
            ).memories
        : undefined,
    });
    const snapshotSamples = collectPromptSnapshotAuditSamples({
      storage,
      config,
    });

    let auditReview = null;
    if (options.auditWithLlm) {
      const providers = createBuiltInProviderRegistry({
        claudeOauth: {
          command: process.env.CLAUDE_CLI_COMMAND ?? "claude",
          defaultModel: process.env.CLAUDE_MODEL,
          timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 180000),
        },
        claudeHarness: {
          command: process.env.CLAUDE_HARNESS_COMMAND ?? process.env.CLAUDE_CLI_COMMAND ?? "claude",
          defaultModel: process.env.CLAUDE_HARNESS_MODEL ?? process.env.CLAUDE_MODEL,
          timeoutMs: Number(process.env.CLAUDE_HARNESS_TIMEOUT_MS ?? process.env.CLAUDE_TIMEOUT_MS ?? 180000),
        },
        codex: {
          command: process.env.CODEX_CLI_COMMAND ?? "codex",
          defaultModel: process.env.CODEX_MODEL,
          timeoutMs: Number(process.env.CODEX_TIMEOUT_MS ?? 180000),
          sandbox: process.env.CODEX_SANDBOX as "read-only" | "workspace-write" | "danger-full-access" | undefined,
          approvalPolicy: process.env.CODEX_APPROVAL_POLICY as "untrusted" | "on-failure" | "on-request" | "never" | undefined,
          skipGitRepoCheck: true,
        },
      });
      const provider = selectProviderByName(options.providerName, providers);
      auditReview = await auditPromptSnapshotsWithProvider({
        provider,
        criteria: config.criteria,
        samples: snapshotSamples,
      });
    }

    const report = renderMemoryEvalMarkdownReport({
      config,
      benchmarkRun,
      snapshotSamples,
      auditReview,
      reportPath: options.reportFile,
    });

    if (options.reportFile) {
      fs.mkdirSync(path.dirname(options.reportFile), { recursive: true });
      fs.writeFileSync(options.reportFile, report, "utf8");
    }

    console.log(report);
    console.log("\n---\n");
    console.log(renderMemoryEvalDiscordSummary({
      benchmarkRun,
      snapshotSamples,
      auditReview,
      reportPath: options.reportFile,
    }));
  } finally {
    atlasDb?.close();
    storage.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    auditWithLlm: false,
    providerName: "claude-oauth",
    substrate: resolveWarmStartMemorySubstrate(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--db":
      case "--db-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.dbPath = next;
        index += 1;
        break;
      case "--config-dir":
        if (!next) throw new Error("--config-dir requires a value");
        options.configDir = next;
        index += 1;
        break;
      case "--config":
      case "--config-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.configPath = next;
        index += 1;
        break;
      case "--audit-with-llm":
        options.auditWithLlm = true;
        break;
      case "--substrate":
        if (next !== "atlas" && next !== "core") throw new Error("--substrate must be atlas or core");
        options.substrate = next;
        index += 1;
        break;
      case "--provider":
        if (!next) throw new Error("--provider requires a value");
        options.providerName = next;
        index += 1;
        break;
      case "--report-file":
        if (!next) throw new Error("--report-file requires a value");
        options.reportFile = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/memory-eval.ts [options]

Options:
  --db-path <path>              Override Tango SQLite path
  --config-dir <path>           Override config directory root
  --config-path <relative>      Override memory-eval config relative path
  --audit-with-llm              Audit sampled snapshots with a provider
  --provider <name>             Provider for LLM audit (default: claude-oauth)
  --report-file <path>          Write the markdown report to disk
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
