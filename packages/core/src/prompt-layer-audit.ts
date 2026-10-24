import fs from "node:fs";
import path from "node:path";
import {
  resolveTangoProfileAgentPromptDir,
  resolveTangoProfileDir,
  type TangoProfilePathOptions,
} from "./runtime-paths.js";

export type PromptLayerFindingCode =
  | "repo-agent-user"
  | "repo-agent-context";

export interface PromptLayerAuditFinding {
  code: PromptLayerFindingCode;
  severity: "warning";
  agentId: string;
  repoPath: string;
  repoRelativePath: string;
  pathKind: "file" | "directory" | "symlink";
  linkTarget?: string;
  profileTargetHint: string;
  summary: string;
  remediation: string;
}

export interface PromptLayerAuditOptions {
  repoRoot?: string;
  profilePathOptions?: TangoProfilePathOptions;
}

function lstatIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function describePathKind(stats: fs.Stats): "file" | "directory" | "symlink" {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return "file";
}

function readSymlinkTarget(filePath: string, stats: fs.Stats): string | undefined {
  if (!stats.isSymbolicLink()) return undefined;
  try {
    return fs.readlinkSync(filePath);
  } catch {
    return undefined;
  }
}

function listAgentIds(assistantsDir: string): string[] {
  try {
    return fs
      .readdirSync(assistantsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function buildUserFinding(input: {
  agentId: string;
  repoRoot: string;
  repoPath: string;
  stats: fs.Stats;
  profilePathOptions?: TangoProfilePathOptions;
}): PromptLayerAuditFinding {
  const repoRelativePath = path.relative(input.repoRoot, input.repoPath);
  const linkTarget = readSymlinkTarget(input.repoPath, input.stats);
  const profileTargetHint = path.join(
    resolveTangoProfileAgentPromptDir(input.agentId, input.profilePathOptions),
    "user.md",
  );

  return {
    code: "repo-agent-user",
    severity: "warning",
    agentId: input.agentId,
    repoPath: input.repoPath,
    repoRelativePath,
    pathKind: describePathKind(input.stats),
    ...(linkTarget ? { linkTarget } : {}),
    profileTargetHint,
    summary:
      "Per-agent USER.md is present under agents/assistants. It is ignored by git, but prompt assembly still treats that repo path as a per-agent user override.",
    remediation:
      `Move the content to ${profileTargetHint}, remove the repo-path file or symlink, then restart Tango.`,
  };
}

function buildContextFinding(input: {
  agentId: string;
  repoRoot: string;
  repoPath: string;
  stats: fs.Stats;
  profilePathOptions?: TangoProfilePathOptions;
}): PromptLayerAuditFinding {
  const repoRelativePath = path.relative(input.repoRoot, input.repoPath);
  const linkTarget = readSymlinkTarget(input.repoPath, input.stats);
  const profileTargetHint = path.join(
    resolveTangoProfileDir(input.profilePathOptions),
    "private",
    "agents",
    input.agentId,
    "context",
  );

  return {
    code: "repo-agent-context",
    severity: "warning",
    agentId: input.agentId,
    repoPath: input.repoPath,
    repoRelativePath,
    pathKind: describePathKind(input.stats),
    ...(linkTarget ? { linkTarget } : {}),
    profileTargetHint,
    summary:
      "Agent context is present under agents/assistants. Context files are personal by default and should not live in the repo checkout.",
    remediation:
      `Move the context to a profile-owned path such as ${profileTargetHint}, then update any prompt references.`,
  };
}

export function findRepoLayerPersonalPromptFindings(
  options: PromptLayerAuditOptions = {},
): PromptLayerAuditFinding[] {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const assistantsDir = path.join(repoRoot, "agents", "assistants");
  const findings: PromptLayerAuditFinding[] = [];

  for (const agentId of listAgentIds(assistantsDir)) {
    const agentDir = path.join(assistantsDir, agentId);

    const userPath = path.join(agentDir, "USER.md");
    const userStats = lstatIfExists(userPath);
    if (userStats) {
      findings.push(
        buildUserFinding({
          agentId,
          repoRoot,
          repoPath: userPath,
          stats: userStats,
          profilePathOptions: options.profilePathOptions,
        }),
      );
    }

    const contextPath = path.join(agentDir, "context");
    const contextStats = lstatIfExists(contextPath);
    if (contextStats) {
      findings.push(
        buildContextFinding({
          agentId,
          repoRoot,
          repoPath: contextPath,
          stats: contextStats,
          profilePathOptions: options.profilePathOptions,
        }),
      );
    }
  }

  return findings;
}
