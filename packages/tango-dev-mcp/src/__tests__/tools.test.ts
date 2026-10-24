import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevTools } from "../tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-dev-mcp-"));
  tempDirs.push(dir);
  return dir;
}

function getTool(name: "tango_shell" | "tango_file") {
  const repoDir = createTempRepo();
  const tools = createDevTools({ repoDir });
  const tool = tools.find((candidate) => candidate.name === name);

  expect(tool).toBeDefined();
  return { repoDir, tool: tool! };
}

describe("tango_shell", () => {
  it("executes a simple command and returns stdout", async () => {
    const { tool } = getTool("tango_shell");

    const result = await tool.handler({ command: "echo hello" }) as {
      code: number | null;
      stdout?: string;
    };

    expect(result).toEqual({
      code: 0,
      stdout: "hello",
    });
  });

  it("handles command failure", async () => {
    const { tool } = getTool("tango_shell");

    const result = await tool.handler({
      command: "echo failed >&2; exit 7",
    }) as {
      code: number | null;
      stderr?: string;
    };

    expect(result.code).toBe(7);
    expect(result.stderr).toBe("failed");
  });
});

describe("tango_file", () => {
  it("reads an existing file", async () => {
    const { repoDir, tool } = getTool("tango_file");
    fs.writeFileSync(path.join(repoDir, "hello.txt"), "hello world", "utf8");

    const result = await tool.handler({
      operation: "read",
      path: "hello.txt",
    }) as { content: string };

    expect(result).toEqual({ content: "hello world" });
  });

  it("writes a file and reads it back", async () => {
    const { tool } = getTool("tango_file");

    await tool.handler({
      operation: "write",
      path: "nested/example.txt",
      content: "written content",
    });

    const result = await tool.handler({
      operation: "read",
      path: "nested/example.txt",
    }) as { content: string };

    expect(result.content).toBe("written content");
  });

  it("patches text in a file", async () => {
    const { repoDir, tool } = getTool("tango_file");
    fs.writeFileSync(path.join(repoDir, "patch.txt"), "before old after", "utf8");

    const result = await tool.handler({
      operation: "patch",
      path: "patch.txt",
      old: "old",
      new: "new",
    }) as { success: boolean; path: string };

    expect(result).toEqual({ success: true, path: "patch.txt" });
    expect(fs.readFileSync(path.join(repoDir, "patch.txt"), "utf8")).toBe("before new after");
  });

  it("lists directory contents", async () => {
    const { repoDir, tool } = getTool("tango_file");
    fs.mkdirSync(path.join(repoDir, "subdir"));
    fs.writeFileSync(path.join(repoDir, "a.txt"), "a", "utf8");
    fs.writeFileSync(path.join(repoDir, "b.txt"), "b", "utf8");

    const result = await tool.handler({
      operation: "list",
      path: ".",
    }) as { files: string[]; directories: string[] };

    expect(result).toEqual({
      files: ["a.txt", "b.txt"],
      directories: ["subdir"],
    });
  });

  it("rejects path traversal", async () => {
    const { tool } = getTool("tango_file");

    await expect(
      tool.handler({
        operation: "read",
        path: "../../etc/passwd",
      }),
    ).rejects.toThrow("Path escapes the tango repo directory");
  });
});
