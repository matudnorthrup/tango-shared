#!/usr/bin/env node
import { resourceCommand } from "./resource-client.js";
import { randomUUID } from "node:crypto";
import { releaseId } from "./release-info.js";
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { acquireOwnership, LoomAlreadyRunningError } from "./ownership.js";
import { ensureToken, loadAccounts, loadConfig } from "./config.js";
import { RemoteRuntime } from "./remote-runtime.js";
import { ClaudeRuntime } from "./claude/claude-runtime.js";
import { createClaudeTitler, createRuleWriter } from "./claude/titler.js";
import { AccountPool, startUsageFeed, type PoolAccount } from "./pool.js";
import { createWorktree } from "./git.js";
import { AttachmentFiles } from "./attachments.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { hydratePath } from "./env.js";
import { AUTOMATIC_SETTLE_MS, LoomHost, ROLE_MODELS } from "./host.js";
import { createLoomServer } from "./http.js";
import { processStart, reapOrphans } from "./proc.js";
import { QuotaHistory } from "./forecast.js";
import { LoomStore } from "./store.js";
import { rulesFilePath } from "./rules.js";
import { deskSeenBrief } from "./catchup.js";
import type { Runtime } from "./runtime.js";

/** Distinct exit code so a supervisor stops restarting when another Loom owns the state. */
const EXIT_ALREADY_RUNNING = 75;
const COMPACT_EVERY_MS = 6 * 3600 * 1000;

async function main(): Promise<void> {
  process.env.LOOM_RELEASE = releaseId();
  if (process.argv.includes("--version")) {
    console.log(process.env.LOOM_RELEASE);
    return;
  }
  if (process.argv[2] === "resource") {
    try {
      const result = await resourceCommand(process.argv.slice(3));
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    } catch (error) {
      console.error(`loom resource: ${String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ")}`);
      process.exitCode = 1;
    }
    return;
  }
  const config = loadConfig();
  if (process.argv[2] === "asks") {
    const args = process.argv.slice(3);
    if (args[0] === "resolve") {
      const askId = args[1];
      if (!askId || !/^A-\d+$/.test(askId)) throw new Error("Usage: loom asks resolve <A-n> [--step N] [--note text] [--withdrawn]");
      const command: Record<string, unknown> = { type: "ask.resolve", commandId: randomUUID(), askId, outcome: "done", by: "person" };
      for (let i = 2; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--withdrawn") command.outcome = "withdrawn";
        else if ((flag === "--step" || flag === "--note") && args[i + 1] !== undefined) command[flag.slice(2)] = args[++i];
        else throw new Error(`Unknown or incomplete asks resolve argument: ${flag}`);
      }
      const response = await fetch(`http://127.0.0.1:${config.port}/commands`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${readFileSync(config.tokenPath, "utf8").trim()}` }, body: JSON.stringify(command) });
      const body = await response.json() as { ok?: boolean; result?: unknown; message?: string };
      if (!response.ok || !body.ok) throw new Error(body.message ?? `Loom returned ${response.status}`);
      console.log(JSON.stringify(body.result, null, 2));
      return;
    }
    if (args[0] !== "rerecord" || args.slice(1).some(arg => arg !== "--dry-run")) throw new Error("Usage: loom asks rerecord [--dry-run]");
    const response = await fetch(`http://127.0.0.1:${config.port}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readFileSync(config.tokenPath, "utf8").trim()}` },
      body: JSON.stringify({ type: "asks.rerecord", commandId: randomUUID(), dryRun: args.includes("--dry-run") }),
    });
    const body = await response.json() as { ok?: boolean; result?: unknown; message?: string };
    if (!response.ok || !body.ok) throw new Error(body.message ?? `Loom returned ${response.status}`);
    console.log(JSON.stringify(body.result, null, 2));
    return;
  }
  mkdirSync(config.home, { recursive: true, mode: 0o700 });

  let owner: { release(): void };
  try {
    owner = acquireOwnership(config.ownerPath);
  } catch (error) {
    if (error instanceof LoomAlreadyRunningError) {
      console.error(`[loom] ${error.message}`);
      process.exit(EXIT_ALREADY_RUNNING);
    }
    throw error;
  }
  // The release this coordinator runs from, so a release prune never deletes it before a restart.
  const coordinatorFile = join(config.home, "coordinator.json");
  writeFileSync(`${coordinatorFile}.tmp`, JSON.stringify({ pid: process.pid, started: processStart(process.pid) ?? "", release: process.env.LOOM_RELEASE }));
  renameSync(`${coordinatorFile}.tmp`, coordinatorFile);

  if (process.env.LOOM_FAKE_RUNTIME !== "1") await hydratePath();
  const token = ensureToken(config);
  const store = new LoomStore(config.dbPath);
  const reaped = reapOrphans(store, join(config.home, "hosts"));

  // Harness adapters run behind the same durable session host.
  const accounts = loadAccounts(config);
  const runtimes: Record<string, Runtime> = {};
  let claude: ClaudeRuntime | null = null;
  if (accounts.claude) {
    const adapterOptions = {
      accounts: accounts.claude.accounts,
      defaultAccount: accounts.claude.default,
      sharedProjectsDir: config.claudeProjectsDir,
      loomHome: config.home,
    };
    claude = new ClaudeRuntime(adapterOptions);
    runtimes.claude = new RemoteRuntime({ loomHome: config.home, claude: adapterOptions });
  }
  if (accounts.codex) runtimes.codex = new RemoteRuntime({ loomHome: config.home, provider: "codex", codex: { accounts: accounts.codex.accounts, defaultAccount: accounts.codex.default } });
  const poolAccounts: PoolAccount[] = (accounts.claude?.accounts ?? []).map((a) => ({
    provider: "claude",
    name: a.name,
    ...(a.usageName ? { usageName: a.usageName } : {}),
    ...(a.aliases?.length ? { aliases: a.aliases } : {}),
  }));
  poolAccounts.push(...(accounts.codex?.accounts ?? []).map(a => ({ provider: "codex", name: a.name, usageName: a.usageName, aliases: a.aliases })));
  const pool = new AccountPool(poolAccounts, process.env.LOOM_BALANCE ? JSON.parse(process.env.LOOM_BALANCE) : {});
  const quotaHistory = new QuotaHistory(store);
  pool.onReading = (provider, name) => quotaHistory.record(provider, name, pool.capacityWindows(provider, name));
  const usage = config.usageUrl ? startUsageFeed(pool, config.usageUrl, 60_000, (msg) => console.warn(`[loom] ${msg}`)) : null;
  // Recovery and the first requests pick accounts, so they wait for one real usage reading.
  await usage?.ready;
  const stopUsage = usage?.stop ?? (() => {});
  const worktreesDir = join(config.home, "worktrees");
  const host = new LoomHost(store, runtimes, {
    pool,
    quotaHistory,
    automaticSettleMs: Number(process.env.LOOM_AUTOMATIC_SETTLE_MS ?? AUTOMATIC_SETTLE_MS),
    // LOOM_ROLE_MODELS='{}' turns tiering off; '{"worker":"opus"}' selects that role; '{"qa":"sonnet"}' keeps QA on Claude.
    roleModels: process.env.LOOM_ROLE_MODELS ? JSON.parse(process.env.LOOM_ROLE_MODELS) : ROLE_MODELS,
    loomHome: config.home,
    fanOutArtifactUrl: process.env.LOOM_FAN_OUT_ARTIFACTS_URL,
    fanOutArtifacts: process.env.LOOM_FAN_OUT_ARTIFACTS || join(homedir(), ".agentic-workflow", "artifacts"),
    claudeProjectsDir: config.claudeProjectsDir,
    createWorktree: (repoPath, threadId, options) => createWorktree(repoPath, { id: threadId, worktreesDir, ...options }),
    attachments: new AttachmentFiles(join(config.home, "attachments")),
    // The profile's standing rules: imported once, then kept as the mirror of Loom's rules table.
    rulesFile: process.env.LOOM_RULES_FILE ?? rulesFilePath(),
    // A lead's turn starts with what the owner has seen in its space (the desk keeps the seen marks); LOOM_DESK_URL=off: none.
    ...(process.env.LOOM_DESK_URL === "off" ? {} : { seenBrief: deskSeenBrief(process.env.LOOM_DESK_URL || "http://127.0.0.1:9410") }),
    ...(claude && process.env.LOOM_FAKE_RUNTIME !== "1" ? { titler: createClaudeTitler({ account: (name) => claude!.account(name) }), ruleWriter: createRuleWriter({ account: (name) => claude!.account(name) }) } : {}),
  });
  const agentHandoffs = host.reconcileAgentHandoffs();
  const recovered = await host.recover();
  // Each thread's open ask, rebuilt from history: threads from before the record get theirs, a missed update heals.
  const asks = host.rebuildAsks();
  console.log(`[loom] agent hand-off repair: asks=${agentHandoffs.asks} waits=${agentHandoffs.waits}`);

  const server = createLoomServer(host, { token });
  server.listen(config.port, "127.0.0.1", () => {
    console.log(
      `[loom] release=${process.env.LOOM_RELEASE} listening on 127.0.0.1:${config.port} state=${config.home} providers=${Object.keys(runtimes).join(",") || "none"} reaped=${reaped} ` +
        `interrupted=${recovered.interrupted} continued=${recovered.continued} asks=${asks}`,
    );
  });

  const compactTimer = setInterval(() => store.compact(), COMPACT_EVERY_MS);
  const shutdown = async (signal: string) => {
    console.log(`[loom] ${signal}: shutting down`);
    clearInterval(compactTimer);
    stopUsage();
    server.close();
    await host.detachAll();
    store.close();
    owner.release();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[loom] fatal", error);
  process.exit(1);
});
