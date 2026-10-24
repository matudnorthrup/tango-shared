import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExpiredClaudeArtifacts, resolveClaudeProjectDirForCwd } from "../src/provider-artifacts.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): { storage: TangoStorage; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-provider-artifacts-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  storage.bootstrapSessions([
    {
      id: "tango-default",
      type: "persistent",
      agent: "dispatch",
      channels: ["discord:default"],
    },
  ]);
  return { storage, dir };
}

describe("provider-artifacts", () => {
  it("derives the Claude project directory from the cwd", () => {
    expect(resolveClaudeProjectDirForCwd("/Volumes/Data/GitHub/tango", "/Users/tester")).toBe(
      "/Users/tester/.claude/projects/-Volumes-Data-GitHub-tango"
    );
  });

  it("deletes expired Tango-owned stateless Claude artifacts", () => {
    const { storage, dir } = createStorage();
    const projectDir = path.join(dir, ".claude", "projects", "-tmp-tango");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "expired-session.jsonl"), "hello");
    fs.mkdirSync(path.join(projectDir, "expired-session", "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "expired-session", "subagents", "agent-1.jsonl"),
      "subagent"
    );
    fs.writeFileSync(path.join(projectDir, "recent-session.jsonl"), "keep");

    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "expired-session",
      responseMode: "concise",
      metadata: { orchestratorContinuityMode: "stateless" },
    });
    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "recent-session",
      responseMode: "concise",
      metadata: { orchestratorContinuityMode: "stateless" },
    });
    storage.getDatabase().prepare(
      `
        UPDATE model_runs
        SET created_at = CASE provider_session_id
          WHEN 'expired-session' THEN '2026-03-05T10:00:00.000Z'
          WHEN 'recent-session' THEN '2026-03-11T10:00:00.000Z'
          ELSE created_at
        END
      `
    ).run();

    const result = cleanupExpiredClaudeArtifacts({
      storage,
      now: new Date("2026-03-12T10:00:00.000Z"),
      retentionHours: 72,
      projectDir,
    });

    expect(result.candidateCount).toBe(1);
    expect(result.deletedSessionCount).toBe(1);
    expect(result.deletedJsonlCount).toBe(1);
    expect(result.deletedDirectoryCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, "expired-session.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "expired-session"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "recent-session.jsonl"))).toBe(true);

    storage.close();
  });
});
