import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;
const READ_LIMIT = 50_000;

export interface DevToolPaths {
  repoDir?: string;
}

export interface DevToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function detectRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolveRepoDir(overrides?: DevToolPaths): string {
  const envRepoDir = process.env.TANGO_REPO_DIR?.trim();
  return path.resolve(overrides?.repoDir ?? envRepoDir ?? detectRepoRoot() ?? process.cwd());
}

function resolveRepoPath(repoDir: string, inputPath: unknown): string {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }

  const repoRoot = path.resolve(repoDir);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(repoRoot, inputPath);

  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error("Path escapes the tango repo directory");
  }

  return resolved;
}

function toRepoRelativePath(repoDir: string, resolvedPath: string): string {
  const relativePath = path.relative(repoDir, resolvedPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function readTimeoutMs(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("timeout_ms must be a positive number");
  }

  return value;
}

function readStringField(
  value: unknown,
  fieldName: string,
  options?: { allowEmpty?: boolean },
): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  if (!options?.allowEmpty && value.length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }

  return value;
}

function execShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env, CLAUDECODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 3_000);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (timedOut) {
        const timeoutMessage = `Command timed out after ${timeoutMs}ms`;
        stderr = stderr.trim().length > 0 ? `${stderr.trim()}\n${timeoutMessage}` : timeoutMessage;
      }

      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

export function createDevTools(overrides?: DevToolPaths): DevToolDefinition[] {
  const repoDir = resolveRepoDir(overrides);

  return [
    {
      name: "tango_shell",
      description: "Execute a shell command in the Tango repo directory.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (default: 120000)",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const command = readStringField(input.command, "command");
        const timeoutMs = readTimeoutMs(input.timeout_ms);
        const result = await execShell(command, repoDir, timeoutMs);

        return {
          code: result.code,
          ...(result.stdout.trim().length > 0 ? { stdout: result.stdout.trim() } : {}),
          ...(result.stderr.trim().length > 0 ? { stderr: result.stderr.trim() } : {}),
        };
      },
    },
    {
      name: "tango_file",
      description: "Read, write, patch, or list files in the Tango repo.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["read", "write", "patch", "list"] },
          path: { type: "string", description: "File path relative to repo root" },
          content: { type: "string", description: "File content for write" },
          old: { type: "string", description: "Text to find for patch" },
          new: { type: "string", description: "Replacement text for patch" },
        },
        required: ["operation", "path"],
      },
      handler: async (input) => {
        const operation = readStringField(input.operation, "operation");
        const resolvedPath = resolveRepoPath(repoDir, input.path);
        const relativePath = toRepoRelativePath(repoDir, resolvedPath);

        if (operation === "list") {
          const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
          return {
            files: entries
              .filter((entry) => entry.isFile())
              .map((entry) => entry.name)
              .sort(),
            directories: entries
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort(),
          };
        }

        if (operation === "read") {
          const content = await fs.readFile(resolvedPath, "utf8");
          if (content.length > READ_LIMIT) {
            return {
              content: content.slice(0, READ_LIMIT),
              truncated: true,
              totalLength: content.length,
            };
          }
          return { content };
        }

        if (operation === "write") {
          const content = readStringField(input.content, "content", { allowEmpty: true });
          await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
          await fs.writeFile(resolvedPath, content, "utf8");
          return { success: true, path: relativePath };
        }

        if (operation === "patch") {
          const oldText = readStringField(input.old, "old");
          const newText = readStringField(input.new, "new", { allowEmpty: true });
          const current = await fs.readFile(resolvedPath, "utf8");

          if (!current.includes(oldText)) {
            throw new Error("old text not found in file");
          }

          await fs.writeFile(resolvedPath, current.replace(oldText, newText), "utf8");
          return { success: true, path: relativePath };
        }

        throw new Error(`Unknown operation: ${operation}`);
      },
    },
  ];
}
