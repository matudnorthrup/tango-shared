#!/usr/bin/env tsx

import {
  createVoyageEmbeddingProviderFromEnv,
  resolveDatabasePath,
  TangoStorage,
  type MemorySource,
} from "../packages/core/src/index.ts";
import { serializeEmbedding } from "../packages/core/src/embeddings.ts";

interface CliOptions {
  dbPath?: string;
  batchSize: number;
  limit?: number;
  source?: MemorySource | "all";
  includeArchived: boolean;
  reembedAll: boolean;
  dryRun: boolean;
  interBatchDelayMs: number;
  retryDelayMs: number;
  maxRetries: number;
  failureSampleLimit: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const embeddingProvider = createVoyageEmbeddingProviderFromEnv();
  if (!embeddingProvider) {
    throw new Error("VOYAGE_API_KEY is required for memory re-embedding");
  }

  const dbPath = resolveDatabasePath(options.dbPath);
  const storage = new TangoStorage(dbPath);

  try {
    const memories = storage.listMemories({
      source: options.source,
      includeArchived: options.includeArchived,
      limit: options.limit ?? 50_000,
    });

    const candidates = memories.filter((memory) => {
      if (options.reembedAll) return true;
      if (!memory.embeddingJson) return true;
      return memory.embeddingModel !== embeddingProvider.model;
    });

    const result = {
      dbPath,
      model: embeddingProvider.model,
      scannedCount: memories.length,
      candidateCount: candidates.length,
      updatedCount: 0,
      failedCount: 0,
      batches: 0,
      failures: [] as Array<{ memoryId: number; error: string }>,
      dryRun: options.dryRun,
    };

    if (options.dryRun || candidates.length === 0) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    for (let index = 0; index < candidates.length; index += options.batchSize) {
      const batch = candidates.slice(index, index + options.batchSize);
      result.batches += 1;

      try {
        const embeddings = await embedBatchWithRetry(
          embeddingProvider,
          batch.map((memory) => memory.content),
          options
        );

        for (let offset = 0; offset < batch.length; offset += 1) {
          const memory = batch[offset];
          const embedding = embeddings[offset];
          if (!memory || !embedding || embedding.length === 0) {
            result.failedCount += 1;
            if (memory) {
              recordFailure(result.failures, options.failureSampleLimit, {
                memoryId: memory.id,
                error: "missing_embedding",
              });
            }
            continue;
          }

          storage.updateMemoryEmbedding({
            memoryId: memory.id,
            embeddingJson: serializeEmbedding(embedding),
            embeddingModel: embeddingProvider.model,
          });
          result.updatedCount += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failedCount += batch.length;
        for (const memory of batch) {
          recordFailure(result.failures, options.failureSampleLimit, {
            memoryId: memory.id,
            error: message,
          });
        }
      }

      if (index + options.batchSize < candidates.length && options.interBatchDelayMs > 0) {
        await sleep(options.interBatchDelayMs);
      }
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    storage.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 16,
    dryRun: false,
    includeArchived: false,
    reembedAll: false,
    source: "all",
    interBatchDelayMs: 22_000,
    retryDelayMs: 30_000,
    maxRetries: 3,
    failureSampleLimit: 20,
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
      case "--batch-size":
        if (!next) throw new Error("--batch-size requires a value");
        options.batchSize = parseInteger(next, "--batch-size");
        index += 1;
        break;
      case "--limit":
        if (!next) throw new Error("--limit requires a value");
        options.limit = parseInteger(next, "--limit");
        index += 1;
        break;
      case "--inter-batch-delay-ms":
        if (!next) throw new Error("--inter-batch-delay-ms requires a value");
        options.interBatchDelayMs = parseInteger(next, "--inter-batch-delay-ms");
        index += 1;
        break;
      case "--retry-delay-ms":
        if (!next) throw new Error("--retry-delay-ms requires a value");
        options.retryDelayMs = parseInteger(next, "--retry-delay-ms");
        index += 1;
        break;
      case "--max-retries":
        if (!next) throw new Error("--max-retries requires a value");
        options.maxRetries = parseInteger(next, "--max-retries");
        index += 1;
        break;
      case "--failure-sample-limit":
        if (!next) throw new Error("--failure-sample-limit requires a value");
        options.failureSampleLimit = parseInteger(next, "--failure-sample-limit");
        index += 1;
        break;
      case "--source":
        if (!next || !isMemorySourceOption(next)) {
          throw new Error("--source must be one of: all, conversation, manual, reflection, backfill, obsidian");
        }
        options.source = next;
        index += 1;
        break;
      case "--include-archived":
        options.includeArchived = true;
        break;
      case "--all":
        options.reembedAll = true;
        break;
      case "--dry-run":
        options.dryRun = true;
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

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function isMemorySourceOption(value: string): value is MemorySource | "all" {
  return (
    value === "all" ||
    value === "conversation" ||
    value === "manual" ||
    value === "reflection" ||
    value === "backfill" ||
    value === "obsidian"
  );
}

async function embedBatchWithRetry(
  embeddingProvider: NonNullable<ReturnType<typeof createVoyageEmbeddingProviderFromEnv>>,
  texts: string[],
  options: Pick<CliOptions, "maxRetries" | "retryDelayMs">
): Promise<number[][]> {
  let attempt = 0;

  while (true) {
    try {
      return await embeddingProvider.embed(texts, "document");
    } catch (error) {
      attempt += 1;
      if (attempt > options.maxRetries || !isRateLimitError(error)) {
        throw error;
      }
      await sleep(options.retryDelayMs);
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || /rate limit/iu.test(message);
}

function recordFailure(
  failures: Array<{ memoryId: number; error: string }>,
  limit: number,
  failure: { memoryId: number; error: string }
): void {
  if (failures.length >= limit) return;
  failures.push(failure);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function printUsage(): void {
  console.log(`
Usage:
  node --env-file=.env --import tsx ./scripts/memory-reembed.ts [options]

Options:
  --db-path <path>         Override Tango SQLite path
  --batch-size <n>         Embedding batch size (default: 16)
  --limit <n>              Max memories to scan
  --source <kind>          all | conversation | manual | reflection | backfill | obsidian
  --inter-batch-delay-ms   Delay between batch requests (default: 22000)
  --retry-delay-ms         Delay before retrying 429s (default: 30000)
  --max-retries <n>        Retry attempts for 429s (default: 3)
  --failure-sample-limit   Max failures to print in the summary (default: 20)
  --include-archived       Include archived memories
  --all                    Re-embed even if an embedding already exists
  --dry-run                Show counts without updating rows
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
