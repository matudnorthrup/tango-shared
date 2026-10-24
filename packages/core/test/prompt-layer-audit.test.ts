import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoLayerPersonalPromptFindings } from "../src/prompt-layer-audit.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("findRepoLayerPersonalPromptFindings", () => {
  it("reports ignored repo-layer per-agent USER.md files without reading content", () => {
    const repoRoot = makeTempDir("tango-prompt-audit-repo-");
    const homeDir = makeTempDir("tango-prompt-audit-home-");
    const agentDir = path.join(repoRoot, "agents", "assistants", "cod-e");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "USER.md"), "private user content", "utf8");

    const findings = findRepoLayerPersonalPromptFindings({
      repoRoot,
      profilePathOptions: { homeDir, profile: "ops" },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "repo-agent-user",
      agentId: "cod-e",
      repoRelativePath: path.join("agents", "assistants", "cod-e", "USER.md"),
      pathKind: "file",
      profileTargetHint: path.join(
        homeDir,
        "profiles",
        "ops",
        "prompts",
        "agents",
        "cod-e",
        "user.md",
      ),
    });
    expect(JSON.stringify(findings)).not.toContain("private user content");
  });

  it("reports repo-layer symlinks and context directories", () => {
    const repoRoot = makeTempDir("tango-prompt-audit-repo-");
    const homeDir = makeTempDir("tango-prompt-audit-home-");
    const agentDir = path.join(repoRoot, "agents", "assistants", "wellness");
    const legacyProfileDir = path.join(homeDir, "profiles", "default", "config", "agents", "wellness");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(legacyProfileDir, { recursive: true });
    fs.writeFileSync(path.join(legacyProfileDir, "USER.md"), "legacy profile user", "utf8");
    fs.symlinkSync(path.join(legacyProfileDir, "USER.md"), path.join(agentDir, "USER.md"));
    fs.mkdirSync(path.join(agentDir, "context"));

    const findings = findRepoLayerPersonalPromptFindings({
      repoRoot,
      profilePathOptions: { homeDir, profile: "default" },
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "repo-agent-user",
      "repo-agent-context",
    ]);
    expect(findings[0]).toMatchObject({
      pathKind: "symlink",
      linkTarget: path.join(legacyProfileDir, "USER.md"),
    });
    expect(findings[1]).toMatchObject({
      pathKind: "directory",
      profileTargetHint: path.join(
        homeDir,
        "profiles",
        "default",
        "private",
        "agents",
        "wellness",
        "context",
      ),
    });
  });
});
