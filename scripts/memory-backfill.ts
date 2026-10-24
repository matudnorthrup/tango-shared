#!/usr/bin/env tsx

import {
  backfillImportPaths,
  backfillMarkdownFiles,
  backfillMessages,
  createVoyageEmbeddingProviderFromEnv,
  loadSessionConfigs,
  resolveConfigDir,
  resolveDatabasePath,
  TangoStorage,
} from "../packages/core/src/index.ts";

type SourceKind = "messages" | "obsidian" | "import";

interface CliOptions {
  source: SourceKind;
  dbPath?: string;
  configDir?: string;
  paths: string[];
  sessionId?: string;
  agentId?: string;
  windowSize?: number;
  chunkChars?: number;
  dryRun: boolean;
  useEmbeddings: boolean;
  memorySource?: "backfill" | "obsidian" | "manual";
  refresh: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDatabasePath(options.dbPath);
  const configDir = resolveConfigDir(options.configDir);
  const storage = new TangoStorage(dbPath);
  const embeddingProvider = options.useEmbeddings ? createVoyageEmbeddingProviderFromEnv() : null;

  try {
    let result;

    if (options.source === "messages") {
      result = await backfillMessages({
        storage,
        sessionConfigs: loadSessionConfigs(configDir),
        sessionId: options.sessionId,
        agentId: options.agentId,
        windowSize: options.windowSize,
        dryRun: options.dryRun,
        embeddingProvider,
        refresh: options.refresh,
      });
    } else if (options.source === "obsidian") {
      if (options.paths.length === 0) {
        throw new Error("--path is required for source=obsidian");
      }
      result = await backfillMarkdownFiles({
        storage,
        paths: options.paths,
        memorySource: options.memorySource ?? "obsidian",
        sessionId: options.sessionId,
        agentId: options.agentId,
        chunkChars: options.chunkChars,
        dryRun: options.dryRun,
        embeddingProvider,
      });
    } else {
      if (options.paths.length === 0) {
        throw new Error("--path is required for source=import");
      }
      result = await backfillImportPaths({
        storage,
        paths: options.paths,
        memorySource: options.memorySource ?? "backfill",
        sessionId: options.sessionId,
        agentId: options.agentId,
        chunkChars: options.chunkChars,
        dryRun: options.dryRun,
        embeddingProvider,
      });
    }

    console.log(JSON.stringify({
      source: options.source,
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
    source: "messages",
    paths: [],
    dryRun: false,
    useEmbeddings: false,
    refresh: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--source":
        if (!next || !isSourceKind(next)) {
          throw new Error("--source must be one of: messages, obsidian, import");
        }
        options.source = next;
        index += 1;
        break;
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
      case "--path":
        if (!next) throw new Error("--path requires a value");
        options.paths.push(next);
        index += 1;
        break;
      case "--session-id":
        if (!next) throw new Error("--session-id requires a value");
        options.sessionId = next;
        index += 1;
        break;
      case "--agent-id":
        if (!next) throw new Error("--agent-id requires a value");
        options.agentId = next;
        index += 1;
        break;
      case "--window-size":
        if (!next) throw new Error("--window-size requires a value");
        options.windowSize = parseInteger(next, "--window-size");
        index += 1;
        break;
      case "--chunk-chars":
        if (!next) throw new Error("--chunk-chars requires a value");
        options.chunkChars = parseInteger(next, "--chunk-chars");
        index += 1;
        break;
      case "--memory-source":
        if (!next || !isMemorySource(next)) {
          throw new Error("--memory-source must be one of: backfill, obsidian, manual");
        }
        options.memorySource = next;
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--refresh":
        options.refresh = true;
        break;
      case "--embed":
        options.useEmbeddings = true;
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

function isSourceKind(value: string): value is SourceKind {
  return value === "messages" || value === "obsidian" || value === "import";
}

function isMemorySource(value: string): value is "backfill" | "obsidian" | "manual" {
  return value === "backfill" || value === "obsidian" || value === "manual";
}

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/memory-backfill.ts --source messages [options]
  node --import tsx ./scripts/memory-backfill.ts --source obsidian --path <dir-or-file> [options]
  node --import tsx ./scripts/memory-backfill.ts --source import --path <file-or-dir> [options]

Options:
  --db-path <path>         Override Tango SQLite path
  --config-dir <path>      Override config directory
  --session-id <id>        Scope imported memories to a session
  --agent-id <id>          Scope imported memories to an agent
  --window-size <n>        Message window size for source=messages
  --chunk-chars <n>        Max chars per markdown/text chunk
  --memory-source <kind>   backfill | obsidian | manual
  --dry-run                Compute candidates without inserting
  --refresh                Archive existing conversation/backfill memories and re-extract
  --embed                  Try to embed imported memories with Voyage
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
