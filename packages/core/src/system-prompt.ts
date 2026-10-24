/**
 * System Prompt — Convention-based multi-file prompt loading.
 *
 * Assembles a full system prompt by reading conventional files from the
 * agent's directory and shared root files.
 *
 * File loading order:
 *   1. <agentDir>/soul.md      (identity — who you are)
 *   2. RULES.md                (profile shared → repo shared, then per-agent additions)
 *   3. USER.md                 (per-agent override → profile shared → repo shared)
 *   4. <agentDir>/knowledge.md (domain knowledge)
 *   5. prompts/<kind>/<id>/*   (optional profile-owned prompt overlays)
 *
 * Missing files are silently skipped. If no files are found at all,
 * returns a minimal fallback prompt. Legacy AGENTS.md and workers.md files
 * are intentionally excluded so V2 runtimes do not inherit dispatch
 * instructions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  expandHomePath,
  resolveTangoProfileSharedPromptLookupDirs,
} from "./runtime-paths.js";

/**
 * Assemble the full prompt for an agent by reading conventional files.
 *
 * @param agentDir  Absolute path to the agent's directory
 * @param options   Optional agents root override and prompt overlay directory
 * @returns         Concatenated prompt text
 */
export interface PromptAssemblyOptions {
  agentsRootDir?: string;
  overlayDir?: string;
  overlayDirs?: string[];
  /** Override profile shared lookup dirs (for tests). */
  profileSharedDirs?: string[];
}

export interface SoulPromptConfig {
  systemPromptFile: string;
}

export interface SoulPromptAssemblyOptions {
  repoRoot?: string;
  overlayDir?: string;
  overlayDirs?: string[];
}

export type PromptSectionKind =
  | "fallback"
  | "overlay"
  | "shared"
  | "base";

export interface PromptSectionTrace {
  kind: PromptSectionKind;
  label: string;
  sourcePath: string;
  content: string;
}

export interface PromptTrace {
  text: string;
  sections: PromptSectionTrace[];
}

export function assembleAgentPrompt(
  agentDir: string,
  options: PromptAssemblyOptions = {},
): string {
  return traceAgentPrompt(agentDir, options).text;
}

export function assembleSoulPrompt(
  config: SoulPromptConfig,
  options: SoulPromptAssemblyOptions = {},
): string {
  const promptFile = resolveSystemPromptFile(config.systemPromptFile, options.repoRoot);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`System prompt file not found: ${promptFile}`);
  }

  if (path.basename(promptFile) !== "soul.md") {
    const prompt = readIfExists(promptFile);
    if (!prompt) {
      throw new Error(`System prompt file is empty: ${promptFile}`);
    }
    return prompt;
  }

  return assembleAgentPrompt(path.dirname(promptFile), {
    overlayDir: options.overlayDir,
    overlayDirs: options.overlayDirs,
  });
}

export function assembleV2SystemPrompt(
  config: SoulPromptConfig,
  options: SoulPromptAssemblyOptions = {},
): string {
  return assembleSoulPrompt(config, options);
}

export function traceAgentPrompt(
  agentDir: string,
  options: PromptAssemblyOptions = {},
): PromptTrace {
  const agentsRootDir = options.agentsRootDir ?? findAgentsRoot(agentDir);
  const sharedDir = fs.existsSync(path.join(agentsRootDir, "shared"))
    ? path.join(agentsRootDir, "shared")
    : agentsRootDir;
  const sections: PromptSectionTrace[] = [];

  // ── Identity first (soul) ───────────────────────────────────────
  appendFileSection({
    filePath: path.join(agentDir, "soul.md"),
    kind: "base",
    label: "soul.md",
    sections,
  });

  const profileSharedDirs =
    options.profileSharedDirs ?? resolveTangoProfileSharedPromptLookupDirs();

  // ── RULES: shared baseline, then optional per-agent additions ───
  const sharedRules = resolveSharedBaselinePromptFile(
    "RULES.md",
    sharedDir,
    profileSharedDirs,
  );
  appendFileSection({
    filePath: sharedRules.filePath,
    kind: sharedRules.kind,
    label: "RULES.md",
    sections,
  });
  appendFileSection({
    filePath: path.join(agentDir, "RULES.md"),
    kind: "base",
    label: "agent RULES.md",
    sections,
  });

  // ── USER: per-agent override → profile shared → repo shared ───
  const sharedUser = resolveSharedPromptFile(
    "USER.md",
    agentDir,
    sharedDir,
    profileSharedDirs,
  );
  appendFileSection({
    filePath: sharedUser.filePath,
    kind: sharedUser.kind,
    label: "USER.md",
    sections,
  });

  // ── Optional per-agent files ────────────────────────────────────
  const agentFiles = ["knowledge.md"];
  for (const filename of agentFiles) {
    appendFileSection({
      filePath: path.join(agentDir, filename),
      kind: "base",
      label: filename,
      sections,
    });
  }

  const overlayDirs = options.overlayDirs ?? (options.overlayDir ? [options.overlayDir] : []);
  for (const overlayDir of overlayDirs) {
    appendOverlayDir(overlayDir, sections);
  }

  if (sections.length === 0) {
    const agentId = path.basename(agentDir);
    const fallback = `You are the ${agentId} agent. Execute the task using your available tools.`;
    return {
      text: fallback,
      sections: [
        {
          kind: "fallback",
          label: "fallback",
          sourcePath: `generated:${agentId}`,
          content: fallback,
        },
      ],
    };
  }

  return {
    text: sections.map((section) => section.content).join("\n\n"),
    sections,
  };
}

function resolveSharedBaselinePromptFile(
  filename: string,
  sharedDir: string,
  profileSharedDirs: string[],
): { filePath: string; kind: PromptSectionKind } {
  for (const profileDir of profileSharedDirs) {
    const profileFile = path.join(profileDir, filename);
    if (fs.existsSync(profileFile)) {
      return { filePath: profileFile, kind: "shared" };
    }
  }

  return { filePath: path.join(sharedDir, filename), kind: "shared" };
}

function resolveSharedPromptFile(
  filename: string,
  agentDir: string,
  sharedDir: string,
  profileSharedDirs: string[],
): { filePath: string; kind: PromptSectionKind } {
  const agentOverride = path.join(agentDir, filename);
  if (fs.existsSync(agentOverride)) {
    return { filePath: agentOverride, kind: "base" };
  }

  return resolveSharedBaselinePromptFile(filename, sharedDir, profileSharedDirs);
}

function appendOverlayDir(
  dir: string,
  sections: PromptSectionTrace[],
): void {
  let filenames: string[];
  try {
    filenames = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => f !== "workers.md")
      .sort();
  } catch {
    return;
  }

  for (const filename of filenames) {
    appendFileSection({
      filePath: path.join(dir, filename),
      kind: "overlay",
      label: filename,
      sections,
    });
  }
}

function appendFileSection(input: {
  filePath: string;
  kind: PromptSectionKind;
  label: string;
  sections: PromptSectionTrace[];
}): void {
  const content = readIfExists(input.filePath);
  if (!content) {
    return;
  }

  input.sections.push({
    kind: input.kind,
    label: input.label,
    sourcePath: input.filePath,
    content,
  });
}

function findAgentsRoot(agentDir: string): string {
  let current = path.resolve(agentDir);

  while (true) {
    if (path.basename(current) === "agents" || looksLikeAgentsRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.dirname(path.resolve(agentDir));
    current = parent;
  }
}

function looksLikeAgentsRoot(dir: string): boolean {
  const sharedDir = path.join(dir, "shared");
  if (fs.existsSync(sharedDir)) {
    return true;
  }

  return ["RULES.md", "USER.md"].some((filename) =>
    fs.existsSync(path.join(dir, filename)),
  );
}

function resolveSystemPromptFile(systemPromptFile: string, repoRoot?: string): string {
  const trimmed = systemPromptFile.trim();
  if (!trimmed) {
    throw new Error("systemPromptFile must be a non-empty path.");
  }

  const expanded = expandHomePath(trimmed);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(repoRoot ?? process.cwd(), expanded);
}

function readIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
