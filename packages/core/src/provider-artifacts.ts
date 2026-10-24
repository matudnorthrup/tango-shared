import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TangoStorage } from "./storage.js";

export interface CleanupClaudeArtifactsInput {
  storage: TangoStorage;
  now?: Date;
  retentionHours?: number;
  limit?: number;
  projectDir?: string;
}

export interface CleanupClaudeArtifactsResult {
  projectDir: string;
  retentionHours: number;
  candidateCount: number;
  deletedSessionCount: number;
  deletedJsonlCount: number;
  deletedDirectoryCount: number;
  missingPathCount: number;
  errors: string[];
}

export function resolveClaudeProjectDirForCwd(
  cwd: string = process.cwd(),
  homeDir: string = os.homedir()
): string {
  const slug = cwd
    .trim()
    .replace(/[\\/]/gu, "-")
    .replace(/[^A-Za-z0-9._-]/gu, "-");
  return path.join(homeDir, ".claude", "projects", slug);
}

export function cleanupExpiredClaudeArtifacts(
  input: CleanupClaudeArtifactsInput
): CleanupClaudeArtifactsResult {
  const retentionHours =
    Number.isFinite(input.retentionHours) ? Math.max(1, Math.trunc(input.retentionHours ?? 72)) : 72;
  const now = input.now ?? new Date();
  const projectDir = input.projectDir ?? resolveClaudeProjectDirForCwd();
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000).toISOString();
  const candidates = input.storage.listProviderArtifactCleanupCandidates({
    olderThan: cutoff,
    providerNamePrefixes: ["claude"],
    continuityMode: "stateless",
    limit: input.limit ?? 1000,
  });

  let deletedSessionCount = 0;
  let deletedJsonlCount = 0;
  let deletedDirectoryCount = 0;
  let missingPathCount = 0;
  const errors: string[] = [];

  for (const candidate of candidates) {
    const jsonlPath = path.join(projectDir, `${candidate.providerSessionId}.jsonl`);
    const sessionDir = path.join(projectDir, candidate.providerSessionId);
    let touchedSession = false;

    try {
      if (fs.existsSync(jsonlPath)) {
        fs.rmSync(jsonlPath, { force: true });
        deletedJsonlCount += 1;
        touchedSession = true;
      } else {
        missingPathCount += 1;
      }

      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        deletedDirectoryCount += 1;
        touchedSession = true;
      } else {
        missingPathCount += 1;
      }

      if (touchedSession) {
        deletedSessionCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate.providerSessionId}: ${message}`);
    }
  }

  return {
    projectDir,
    retentionHours,
    candidateCount: candidates.length,
    deletedSessionCount,
    deletedJsonlCount,
    deletedDirectoryCount,
    missingPathCount,
    errors,
  };
}
