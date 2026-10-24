// Starts a profile MCP server with the env Loom wrote to a private file, so its secrets reach that server alone:
// not Codex's argv, and not the app-server's environment that its shell tools inherit.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";

const [file, command, ...args] = process.argv.slice(2);
const env = JSON.parse(readFileSync(file!, "utf8")) as Record<string, string>;
const child = spawn(command!, args, { stdio: "inherit", env: { ...process.env, ...env } });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(`[loom] MCP server ${command}: ${error.message}`); process.exit(127); });
child.on("exit", (code, signal) => process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1));
