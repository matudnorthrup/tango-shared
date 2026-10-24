/**
 * Tango Dev Tools — Shell and file access for the developer agent.
 *
 * Tools:
 *   - tango_shell: Execute shell commands in the tango repo
 *   - tango_file: Read/write files in the tango repo
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentTool } from "@tango/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface DevToolPaths {
  repoDir?: string;
}

function resolvePaths(overrides?: DevToolPaths) {
  return {
    repoDir: overrides?.repoDir ?? path.resolve("."),
  };
}

// ---------------------------------------------------------------------------
// Shell command runner
// ---------------------------------------------------------------------------

function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: "" },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createDevTools(overrides?: DevToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "tango_shell",
      description: [
        "Execute a shell command in the Tango repo directory.",
        "",
        "Common operations:",
        "  npm run build                    — Build all packages",
        "  git status / git diff / git log  — Check repo state",
        "  git add <file> && git commit     — Commit changes",
        "  tail -100 /tmp/tango-discord.log — Read recent logs",
        "  pkill -f 'packages/discord/dist/main.js' — Stop tango",
        "  env -u CLAUDECODE node packages/discord/dist/main.js > /tmp/tango-discord.log 2>&1 & — Start tango",
        "  sqlite3 data/tango.sqlite '<sql>' — Query/modify governance DB",
        "",
        "Environment: CLAUDECODE is unset automatically. Working directory is the repo root.",
        "Timeout: 120 seconds by default. Use timeout_ms for longer operations.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (default: 120000)",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const command = String(input.command);
        const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;

        const result = await execShell(command, paths.repoDir, timeoutMs);

        const output: Record<string, unknown> = { code: result.code };
        if (result.stdout.trim()) output.stdout = result.stdout.trim();
        if (result.stderr.trim()) output.stderr = result.stderr.trim();
        return output;
      },
    },
    {
      name: "tango_file",
      description: [
        "Read or write files in the Tango repo.",
        "",
        "Operations:",
        "  read  — Read a file. Path relative to repo root.",
        "    { \"operation\": \"read\", \"path\": \"packages/discord/src/main.ts\" }",
        "",
        "  write — Write/overwrite a file.",
        "    { \"operation\": \"write\", \"path\": \"config/agents/victor.yaml\", \"content\": \"...\" }",
        "",
        "  patch — Find and replace text in a file.",
        "    { \"operation\": \"patch\", \"path\": \"packages/discord/src/main.ts\", \"old\": \"old code\", \"new\": \"new code\" }",
        "",
        "  list  — List files in a directory.",
        "    { \"operation\": \"list\", \"path\": \"config/agents\" }",
        "",
        "Paths are relative to the repo root. Absolute paths within the repo also work.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["read", "write", "patch", "list"],
            description: "Operation to perform",
          },
          path: {
            type: "string",
            description: "File path relative to repo root",
          },
          content: {
            type: "string",
            description: "File content for write operation",
          },
          old: {
            type: "string",
            description: "Text to find for patch operation",
          },
          new: {
            type: "string",
            description: "Replacement text for patch operation",
          },
        },
        required: ["operation", "path"],
      },
      handler: async (input) => {
        const operation = String(input.operation);
        const relPath = String(input.path ?? "");
        const repoDir = paths.repoDir;

        // Resolve path — allow both relative and absolute within repo
        const resolved = path.isAbsolute(relPath)
          ? relPath
          : path.resolve(repoDir, relPath);

        // Safety: must be within the repo
        if (!resolved.startsWith(path.resolve(repoDir))) {
          return { error: "Path escapes the tango repo directory" };
        }

        if (operation === "list") {
          if (!fs.existsSync(resolved)) {
            return { error: `Directory not found: ${relPath}` };
          }
          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          return {
            files: entries.filter((e) => e.isFile()).map((e) => e.name),
            directories: entries.filter((e) => e.isDirectory()).map((e) => e.name),
          };
        }

        if (operation === "read") {
          if (!fs.existsSync(resolved)) {
            return { error: `File not found: ${relPath}` };
          }
          const content = fs.readFileSync(resolved, "utf8");
          // Truncate very large files
          if (content.length > 50_000) {
            return {
              content: content.slice(0, 50_000),
              truncated: true,
              totalLength: content.length,
            };
          }
          return { content };
        }

        if (operation === "write") {
          const content = String(input.content ?? "");
          const dir = path.dirname(resolved);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(resolved, content, "utf8");
          return { success: true, path: relPath };
        }

        if (operation === "patch") {
          const oldText = String(input.old ?? "");
          const newText = String(input.new ?? "");
          if (!fs.existsSync(resolved)) {
            return { error: `File not found: ${relPath}` };
          }
          const current = fs.readFileSync(resolved, "utf8");
          if (!current.includes(oldText)) {
            return { error: "Old text not found in file" };
          }
          const updated = current.replace(oldText, newText);
          fs.writeFileSync(resolved, updated, "utf8");
          return { success: true, path: relPath };
        }

        return { error: `Unknown operation: ${operation}` };
      },
    },
  ];
}
