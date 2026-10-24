#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook - guard Write/Edit/MultiEdit on profile thread files.
 *
 * Exit 0 = allow. Exit 2 = block (stderr shown to Claude).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEditPatch,
  readExistingFileContent,
  validateProfileStateFileMutation,
} from "../../packages/core/dist/profile-state-write-guard.js";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function resolveRepoRoot() {
  if (process.env.TANGO_REPO_DIR?.trim()) {
    return path.resolve(process.env.TANGO_REPO_DIR.trim());
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name ?? payload.toolName;
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") {
    process.exit(0);
  }

  const toolInput = payload.tool_input ?? payload.toolInput ?? {};
  const filePath = toolInput.file_path ?? toolInput.filePath;
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    process.exit(0);
  }

  process.env.TANGO_REPO_DIR ??= resolveRepoRoot();

  const resolvedPath = path.resolve(filePath);
  const existingContent = readExistingFileContent(resolvedPath);

  let nextContent;
  let operation;
  if (toolName === "Write") {
    nextContent = typeof toolInput.content === "string" ? toolInput.content : "";
    operation = "write";
  } else {
    if (existingContent === undefined) {
      process.exit(0);
    }
    const edits = toolName === "MultiEdit"
      ? Array.isArray(toolInput.edits) ? toolInput.edits : []
      : [toolInput];
    let patched = existingContent;
    for (const edit of edits) {
      const oldString = typeof edit?.old_string === "string" ? edit.old_string : "";
      const newString = typeof edit?.new_string === "string" ? edit.new_string : "";
      const nextPatched = applyEditPatch(patched, oldString, newString, edit?.replace_all === true);
      if (nextPatched === null) {
        process.exit(0);
      }
      patched = nextPatched;
    }
    if (patched === null) {
      process.exit(0);
    }
    nextContent = patched;
    operation = "patch";
  }

  const result = validateProfileStateFileMutation({
    filePath: resolvedPath,
    existingContent,
    nextContent,
    operation,
  });

  if (!result.allowed) {
    process.stderr.write(result.reason ?? "Profile thread write blocked by guard.\n");
    process.exit(2);
  }

  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
