#!/usr/bin/env tsx

import { runAtlasScheduledReflections } from "../packages/discord/src/atlas-memory-reflection.ts";

interface CliOptions {
  dbPath?: string;
  lookbackHours?: number;
  sessionId?: string;
  agentId?: string;
  ignoredOptions: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.ignoredOptions.length > 0) {
    console.warn(
      `[memory-reflect] ignored legacy Atlas-incompatible options: ${options.ignoredOptions.join(", ")}`,
    );
  }

  const result = await runAtlasScheduledReflections({
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    ...(options.lookbackHours ? { lookbackHours: options.lookbackHours } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length > 0 && result.totalMemoriesCreated === 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    ignoredOptions: [],
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
      case "--lookback-hours":
        if (!next) throw new Error("--lookback-hours requires a value");
        options.lookbackHours = parseNumber(next, "--lookback-hours");
        index += 1;
        break;
      case "--max-reflections":
        if (!next) throw new Error("--max-reflections requires a value");
        options.ignoredOptions.push("--max-reflections");
        index += 1;
        break;
      case "--minimum-importance":
        if (!next) throw new Error("--minimum-importance requires a value");
        options.ignoredOptions.push("--minimum-importance");
        index += 1;
        break;
      case "--scan-limit":
        if (!next) throw new Error("--scan-limit requires a value");
        options.ignoredOptions.push("--scan-limit");
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
      case "--embed":
        options.ignoredOptions.push("--embed");
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

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/memory-reflect.ts [options]

Options:
  --db-path <path>              Override Atlas memory SQLite path
  --lookback-hours <n>          Restrict reflections to sessions active in the window
  --session-id <id>             Restrict reflections to one session
  --agent-id <id>               Restrict reflections to one agent

Legacy options are accepted for compatibility but ignored:
  --max-reflections <n>
  --minimum-importance <n>
  --scan-limit <n>
  --embed
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
