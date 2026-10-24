import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

/** Immutable caller identity travels with each invocation. Never look up the active
 * run from a thread: a delayed shell from yesterday must not borrow today's run. */
export function resourceCaller(env: NodeJS.ProcessEnv): { threadId: string; runId: string } {
  const threadId = env.TANGO_DESK_ITEM?.match(/^loom:([a-f0-9-]{36})$/)?.[1];
  const runId = env.LOOM_RUN_ID;
  if (!threadId || !runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Set LOOM_RUN_ID to this turn's supplied ID before launching a managed resource; do not look up a newer run");
  return { threadId, runId };
}
export function resourceRunContext(runId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(runId)) return "";
  return `Loom resource identity for this turn: LOOM_RUN_ID=${runId}. Prefix each managed resource or tshare port shell invocation with this assignment. Use loom resource dev-server -- <foreground command> or loom resource port <localport> or loom resource browser -- open <url> (browser action only; omit agent-browser, yarn and --session). Stop a resource early with loom resource release <lease-id>. Never discover a newer run ID or fall back to an unleased launch after an error.`;
}
export async function resourceCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const { threadId, runId } = resourceCaller(env);
  let input: Record<string, unknown>;
  let endpoint = `/threads/${threadId}/resources`;
  if (args[0] === "port" && args.length === 2 && /^\d+$/.test(args[1]!)) {
    const localPort = Number(args[1]); const httpsPort = 10000 + localPort;
    if (localPort < 1 || httpsPort > 65535) throw new Error("Choose a local port between 1 and 55535 for its dedicated HTTPS port");
    input = { kind: "mapping", localPort, httpsPort };
  } else if (args[0] === "dev-server" && args[1] === "--" && args[2]) {
    input = { kind: "dev_server", command: args[2], args: args.slice(3), cwd: process.cwd() };
  } else if (args[0] === "release" && args.length === 2 && /^[a-f0-9-]{36}$/.test(args[1]!)) {
    endpoint += `/${args[1]}/release`;
    input = {};
  } else if (args[0] === "browser" && args[1] === "--" && args[2]) {
    validateBrowserArgs(args.slice(2));
    input = { kind: "browser", managed: true };
  } else throw new Error("Usage: loom resource release <lease-id> | loom resource port <localport> | loom resource dev-server -- <foreground command> [args...] | loom resource browser -- <action> [args...] (for example: loom resource browser -- open <url>; omit agent-browser, yarn and --session)");
  const config = loadConfig(env);
  let token: string;
  try { token = readFileSync(config.tokenPath, "utf8").trim(); }
  catch { throw new Error("Loom token unavailable; check LOOM_HOME and retry from an active Loom turn"); }
  const response = await fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...input, runId }), signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error("Loom request failed or its outcome is unknown; inspect resources and coordinator health before retrying"); });
  const result = await response.json().catch(() => { throw new Error("Invalid Loom response; inspect resources before retrying"); }) as { message?: string; lease?: { identity: string }; log?: string; browser?: { port: number; session: string } };
  if (!response.ok) throw new Error(`Loom ${response.status}: ${result.message ?? "resource launch rejected; inspect the lease before retrying"}`);
  if (input.kind === "mapping") {
    if (!result.lease) throw new Error("Loom omitted the mapping lease; inspect resources before retrying");
    const identity = JSON.parse(result.lease.identity);
    const endpoint = Object.keys(identity.config.Web)[0];
    return `https://${endpoint}`;
  }
  if (input.kind === "browser") {
    if (!result.lease || !result.browser || !Number.isInteger(result.browser.port) || result.browser.port < 1 || result.browser.port > 65535 || !/^loom-[a-f0-9-]{36}$/.test(result.browser.session)) throw new Error("Loom omitted the browser identity; inspect resources before retrying");
    return runBrowserClient(result.browser, args.slice(2), env);
  }
  return result;
}

/** Keep connection selection in the wrapper; never adopt a profile/session or
 * permit a nested command to launch an unleased browser. This is a supported
 * CLI adapter, not a protocol client for agent-browser's private daemon socket. */
export function validateBrowserArgs(args: string[]): void {
  if (args[0] === "agent-browser" || args[0] === "yarn") throw new Error("Pass only the browser action: loom resource browser -- open <url>. Omit agent-browser, yarn and --session; Loom supplies the executable and session.");
  const commands = new Set(["open", "snapshot", "screenshot", "pdf", "click", "dblclick", "fill", "type", "press", "hover", "check", "uncheck", "select", "scroll", "scrollintoview", "wait", "get", "is", "find", "eval", "back", "forward", "reload", "tab", "cookies", "storage", "console", "errors", "close"]);
  const flags = new Set(["-i", "-c", "-d", "-s", "--interactive", "--compact", "--depth", "--selector", "--json", "--full", "--annotate", "--name", "--exact", "--url"]);
  if (!commands.has(args[0] ?? "") || args.some(arg => arg.startsWith("-") && !flags.has(arg.split("=")[0]!))) throw new Error("Use a supported browser action and output options; connection, profile, provider and session options belong to Loom");
}

export async function runBrowserClient(browser: { port: number; session: string }, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  validateBrowserArgs(args);
  const directory = mkdtempSync(join(tmpdir(), "loom-browser-client-"));
  const config = join(directory, "config.json"); writeFileSync(config, "{}", { mode: 0o600 });
  const clientEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AGENT_BROWSER_")));
  try {
    const { stdout } = await promisify(execFile)("agent-browser", ["--config", config, "--cdp", String(browser.port), "--session", browser.session, ...args], { env: clientEnv, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (error) {
    throw new Error(`Managed browser client failed; no unleased fallback. Inspect resources and client session ${browser.session}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
