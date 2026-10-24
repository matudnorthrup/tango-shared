import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveTangoProfileDir } from "./runtime-paths.js";

export const PROFILE_STATE_FROZEN_HEADINGS = ["Quick Read", "Open Items"] as const;

export type ProfileStateMutationOperation = "write" | "patch";

export interface ProfileStateGuardInput {
  filePath: string;
  existingContent?: string;
  nextContent: string;
  operation: ProfileStateMutationOperation;
  profileRoot?: string;
  force?: boolean;
}

export interface ProfileStateGuardResult {
  allowed: boolean;
  reason?: string;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return {};
  try {
    const parsed = yaml.load(match[1] ?? "");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isTruthy(value: unknown): boolean {
  return value === true || value === "true";
}

export function isStateManagedContent(content: string): boolean {
  const data = parseFrontmatter(content);
  return isTruthy(data.state_managed);
}

function hasFrozenHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "imu");
  return pattern.test(content);
}

export function missingFrozenHeadings(content: string): string[] {
  return PROFILE_STATE_FROZEN_HEADINGS.filter((heading) => !hasFrozenHeading(content, heading));
}

export function isProfileThreadsStateFile(filePath: string, profileRoot = resolveTangoProfileDir()): boolean {
  const resolved = path.resolve(filePath);
  const threadsRoot = path.resolve(profileRoot, "threads");
  if (!resolved.startsWith(threadsRoot + path.sep) && resolved !== threadsRoot) {
    return false;
  }
  return resolved.endsWith(".md");
}

export function validateProfileStateFileMutation(input: ProfileStateGuardInput): ProfileStateGuardResult {
  if (input.force) {
    return { allowed: true };
  }

  const profileRoot = input.profileRoot ?? resolveTangoProfileDir();
  if (!isProfileThreadsStateFile(input.filePath, profileRoot)) {
    return { allowed: true };
  }

  const existing = input.existingContent;
  const next = input.nextContent;
  const nextTrimmed = next.trim();

  if (existing !== undefined && nextTrimmed.length === 0) {
    return {
      allowed: false,
      reason:
        "Refusing to empty a profile thread file. Delete/empty is blocked for state-managed threads.",
    };
  }

  // OpenClaw soft-denylist pattern: block full-file write on existing thread files.
  // Agents and subagents must use patch/Edit; create-on-missing only for new paths.
  if (existing !== undefined && input.operation === "write") {
    return {
      allowed: false,
      reason:
        "Refusing full-file write on an existing profile thread file. "
        + "The write operation replaces the entire file — use state_patch or Edit for targeted updates. "
        + "To start a new thread, write only when the path does not exist yet.",
    };
  }

  const governed = existing !== undefined
    ? (isStateManagedContent(existing) || PROFILE_STATE_FROZEN_HEADINGS.some((h) => hasFrozenHeading(existing, h)))
    : true;

  if (!governed) {
    return { allowed: true };
  }

  if (nextTrimmed.length === 0) {
    return {
      allowed: false,
      reason: "Refusing to write empty content to a profile thread file.",
    };
  }

  const missing = missingFrozenHeadings(next);
  if (missing.length > 0) {
    return {
      allowed: false,
      reason:
        `Refusing ${input.operation} on profile thread file: missing frozen heading(s): `
        + missing.map((heading) => `## ${heading}`).join(", ")
        + ". Patch the section in place; do not remove contract anchors.",
    };
  }

  return { allowed: true };
}

export function readExistingFileContent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function applyEditPatch(
  existingContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string | null {
  if (oldString.length === 0 || !existingContent.includes(oldString)) {
    return null;
  }
  if (replaceAll) {
    return existingContent.split(oldString).join(newString);
  }
  return existingContent.replace(oldString, newString);
}
