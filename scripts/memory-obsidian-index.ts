#!/usr/bin/env tsx

import {
  createVoyageEmbeddingProviderFromEnv,
  indexObsidianVault,
  resolveDatabasePath,
  TangoStorage,
} from "../packages/core/src/index.ts";

interface CliOptions {
  dbPath?: string;
  paths: string[];
  chunkChars?: number;
  dryRun: boolean;
  useEmbeddings: boolean;
  includeClippings: boolean;
  includeAiTranscripts: boolean;
  excludePrefixes: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDatabasePath(options.dbPath);
  const storage = new TangoStorage(dbPath);
  const embeddingProvider = options.useEmbeddings ? createVoyageEmbeddingProviderFromEnv() : null;

  try {
    const result = await indexObsidianVault({
      storage,
      paths: options.paths.length > 0 ? options.paths : undefined,
      chunkChars: options.chunkChars,
      dryRun: options.dryRun,
      includeClippings: options.includeClippings,
      includeAiTranscripts: options.includeAiTranscripts,
      excludePrefixes: options.excludePrefixes,
      embeddingProvider,
    });

    console.log(JSON.stringify({
      dryRun: options.dryRun,
      dbPath,
      result,
    }, null, 2));
  } finally {
    storage.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    paths: [],
    dryRun: false,
    useEmbeddings: false,
    includeClippings: false,
    includeAiTranscripts: false,
    excludePrefixes: [],
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
      case "--path":
        if (!next) throw new Error("--path requires a value");
        options.paths.push(next);
        index += 1;
        break;
      case "--chunk-chars":
        if (!next) throw new Error("--chunk-chars requires a value");
        options.chunkChars = parseInteger(next, "--chunk-chars");
        index += 1;
        break;
      case "--exclude-prefix":
        if (!next) throw new Error("--exclude-prefix requires a value");
        options.excludePrefixes.push(next);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--embed":
        options.useEmbeddings = true;
        break;
      case "--include-clippings":
        options.includeClippings = true;
        break;
      case "--include-ai-transcripts":
        options.includeAiTranscripts = true;
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

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/memory-obsidian-index.ts [options]

Options:
  --db-path <path>              Override Tango SQLite path
  --path <dir-or-file>          Vault root or specific markdown file (repeatable)
  --chunk-chars <n>             Max chars per stored markdown chunk
  --exclude-prefix <prefix>     Additional relative path prefix to exclude (repeatable)
  --include-clippings           Include Clippings/ in the curated index
  --include-ai-transcripts      Include AI transcript folders in the curated index
  --dry-run                     Show what would change without writing
  --embed                       Try to embed indexed memories with Voyage
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
