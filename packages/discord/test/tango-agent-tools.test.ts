import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTangoTools } from "../src/tango-agent-tools.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-agent-docs-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  return dir;
}

function createProfileSharedDir(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-home-"));
  tempDirs.push(homeDir);
  const sharedDir = path.join(homeDir, "profiles", "default", "agents", "shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  return sharedDir;
}

function createOverlayDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-overlay-"));
  tempDirs.push(dir);
  return dir;
}

function createProfileRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-state-"));
  tempDirs.push(dir);
  return dir;
}

describe("agent_docs tool", () => {
  it("lists nested assistant directories by explicit path", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "soul.md"), "watson soul");
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "watson knowledge");

    // Hermetic: always pass an explicit profileAgentsDir so the test never
    // reads the developer's real ~/.tango profile overlays.
    const tool = createTangoTools({ agentsDir, profileAgentsDir: createOverlayDir() })
      .find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({
      operation: "list",
      path: "assistants/watson",
    });

    expect(result).toMatchObject({
      files: expect.arrayContaining(["soul.md", "knowledge.md"]),
    });
  });

  it("resolves nested agent directories by agent id", async () => {
    const agentsDir = createAgentsDir();
    const workerDir = path.join(agentsDir, "workers", "research-assistant");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, "soul.md"), "research assistant soul");

    const tool = createTangoTools({ agentsDir, profileAgentsDir: createOverlayDir() })
      .find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({
      operation: "list",
      agent: "research-assistant",
    });

    expect(result).toMatchObject({
      files: ["soul.md"],
    });
  });

  // Regression coverage for the per-file-overlay union (#177): a profile dir
  // that only overrides knowledge.md must not hide soul.md from the repo
  // fallback — via BOTH list entry points. The agent: branch previously
  // substituted the profile directory wholesale and dropped repo-only files.
  it("unions profile and repo entries when listing by explicit path", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "soul.md"), "repo soul");
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "repo knowledge");

    const profileAgentsDir = createOverlayDir();
    const profileAssistantDir = path.join(profileAgentsDir, "assistants", "watson");
    fs.mkdirSync(profileAssistantDir, { recursive: true });
    fs.writeFileSync(path.join(profileAssistantDir, "knowledge.md"), "profile knowledge");
    fs.writeFileSync(path.join(profileAssistantDir, "private-notes.md"), "profile only");

    const tool = createTangoTools({ agentsDir, profileAgentsDir })
      .find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({ operation: "list", path: "assistants/watson" }) as {
      files: string[];
    };

    expect([...result.files].sort()).toEqual(["knowledge.md", "private-notes.md", "soul.md"]);
  });

  it("unions profile and repo entries when listing by agent id", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "soul.md"), "repo soul");
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "repo knowledge");

    const profileAgentsDir = createOverlayDir();
    const profileAssistantDir = path.join(profileAgentsDir, "assistants", "watson");
    fs.mkdirSync(profileAssistantDir, { recursive: true });
    fs.writeFileSync(path.join(profileAssistantDir, "knowledge.md"), "profile knowledge");
    fs.writeFileSync(path.join(profileAssistantDir, "private-notes.md"), "profile only");

    const tool = createTangoTools({ agentsDir, profileAgentsDir })
      .find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({ operation: "list", agent: "watson" }) as {
      files: string[];
    };

    expect([...result.files].sort()).toEqual(["knowledge.md", "private-notes.md", "soul.md"]);
  });

  it("keeps profile and repo candidates on the same agent subtree when unioning", async () => {
    const agentsDir = createAgentsDir();
    // Repo knows "scout" only as a WORKER; the profile overlays an ASSISTANT
    // dir of the same name. The union must not merge the two different trees:
    // assistants/ wins (first candidate present in either root) and the repo
    // workers/scout files must not leak into the listing.
    const workerDir = path.join(agentsDir, "workers", "scout");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, "soul.md"), "worker soul");

    const profileAgentsDir = createOverlayDir();
    const profileAssistantDir = path.join(profileAgentsDir, "assistants", "scout");
    fs.mkdirSync(profileAssistantDir, { recursive: true });
    fs.writeFileSync(path.join(profileAssistantDir, "knowledge.md"), "assistant knowledge");

    const tool = createTangoTools({ agentsDir, profileAgentsDir })
      .find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({ operation: "list", agent: "scout" }) as {
      files: string[];
    };

    expect(result.files).toEqual(["knowledge.md"]);
  });

  it("reads shared USER.md from profile when profile override exists", async () => {
    const agentsDir = createAgentsDir();
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "repo template user");
    const profileSharedDir = createProfileSharedDir();
    fs.writeFileSync(path.join(profileSharedDir, "USER.md"), "profile user");

    const tool = createTangoTools({
      agentsDir,
      profileAgentsDir: createOverlayDir(),
      profileSharedDirs: [profileSharedDir],
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "read",
      path: "shared/USER.md",
    });

    expect(result).toMatchObject({
      content: "profile user",
      source: "profile",
    });
    expect(result).not.toMatchObject({ content: "repo template user" });
  });

  it("writes shared RULES.md to profile, not repo", async () => {
    const agentsDir = createAgentsDir();
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "repo template rules");
    const profileSharedDir = createProfileSharedDir();

    const tool = createTangoTools({
      agentsDir,
      profileAgentsDir: createOverlayDir(),
      profileSharedDirs: [profileSharedDir],
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "write",
      path: "shared/RULES.md",
      content: "profile rules",
    });

    expect(result).toMatchObject({
      success: true,
      written_to: "profile",
    });
    expect(fs.readFileSync(path.join(profileSharedDir, "RULES.md"), "utf8")).toBe("profile rules");
    expect(fs.readFileSync(path.join(agentsDir, "shared", "RULES.md"), "utf8")).toBe(
      "repo template rules",
    );
  });

  it("reads assistants knowledge from profile when profile override exists", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "cod-e");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "repo knowledge");

    const profileAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-agents-"));
    tempDirs.push(profileAgentsDir);
    const profileAssistantDir = path.join(profileAgentsDir, "assistants", "cod-e");
    fs.mkdirSync(profileAssistantDir, { recursive: true });
    fs.writeFileSync(path.join(profileAssistantDir, "knowledge.md"), "profile knowledge");

    const tool = createTangoTools({
      agentsDir,
      profileAgentsDir,
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "read",
      path: "assistants/cod-e/knowledge.md",
    });

    expect(result).toMatchObject({
      content: "profile knowledge",
      source: "profile",
    });
  });

  it("writes assistants knowledge to profile, not repo", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "miles");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "repo knowledge");

    const profileAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-agents-"));
    tempDirs.push(profileAgentsDir);

    const tool = createTangoTools({
      agentsDir,
      profileAgentsDir,
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "write",
      path: "assistants/miles/knowledge.md",
      content: "profile knowledge",
    });

    expect(result).toMatchObject({
      success: true,
      written_to: "profile",
    });
    expect(
      fs.readFileSync(path.join(profileAgentsDir, "assistants", "miles", "knowledge.md"), "utf8"),
    ).toBe("profile knowledge");
    expect(fs.readFileSync(path.join(assistantDir, "knowledge.md"), "utf8")).toBe("repo knowledge");
  });

  it("appends the profile overlay when reading a shared skill doc", async () => {
    const agentsDir = createAgentsDir();
    const profileSkillsDir = createOverlayDir();
    const skillsDir = path.join(agentsDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "finance-review.md"),
      "# Finance Review\n\nGeneric workflow.\n",
    );
    fs.writeFileSync(
      path.join(profileSkillsDir, "finance-review.md"),
      "Sinking funds: Fund A, Fund B.",
    );

    const tool = createTangoTools({ agentsDir, profileSkillsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "read",
      path: "skills/finance-review.md",
    })) as { content?: string };

    expect(result.content).toContain("Generic workflow.");
    expect(result.content).toContain("profile overlay: finance-review.md");
    expect(result.content).toContain("Sinking funds: Fund A, Fund B.");
  });

  it("returns only the repo base when no overlay is present", async () => {
    const agentsDir = createAgentsDir();
    const profileToolsDir = createOverlayDir();
    const toolsDir = path.join(agentsDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "wellnessdb.md"), "# Wellness DB\n\nGeneric.\n");

    const tool = createTangoTools({ agentsDir, profileToolsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "read",
      path: "tools/wellnessdb.md",
    })) as { content?: string };

    expect(result.content).toBe("# Wellness DB\n\nGeneric.\n");
    expect(result.content).not.toContain("profile overlay");
  });

  it("serves an overlay-only skill doc when the repo base is absent", async () => {
    const agentsDir = createAgentsDir();
    const profileSkillsDir = createOverlayDir();
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(profileSkillsDir, "private-workflow.md"),
      "Installation-only skill.",
    );

    const tool = createTangoTools({ agentsDir, profileSkillsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "read",
      path: "skills/private-workflow.md",
    })) as { content?: string; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Installation-only skill.");
  });

  it("merges overlay-only docs into a skills listing", async () => {
    const agentsDir = createAgentsDir();
    const profileSkillsDir = createOverlayDir();
    const skillsDir = path.join(agentsDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "deep-research.md"), "generic");
    fs.writeFileSync(path.join(profileSkillsDir, "my-private-skill.md"), "personal");

    const tool = createTangoTools({ agentsDir, profileSkillsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "list",
      path: "skills",
    })) as { files?: string[] };

    expect(result.files).toEqual(
      expect.arrayContaining(["deep-research.md", "my-private-skill.md"]),
    );
  });

  it("reads, lists, writes, and patches scoped profile state docs", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    fs.mkdirSync(path.join(profileStateRoot, "threads"), { recursive: true });
    fs.writeFileSync(path.join(profileStateRoot, "threads", "launch.md"), "old quick read");

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );

    const listed = (await tool?.handler({
      operation: "state_list",
      path: "threads",
    })) as { files?: string[]; path?: string };
    expect(listed.path).toBe("profile:threads");
    expect(listed.files).toEqual(["launch.md"]);

    const read = (await tool?.handler({
      operation: "state_read",
      path: "threads/launch.md",
    })) as { content?: string; path?: string; layer?: string };
    expect(read).toMatchObject({
      content: "old quick read",
      path: "profile:threads/launch.md",
      layer: "profile",
    });

    await tool?.handler({
      operation: "state_write",
      path: "collab/handoff.md",
      content: "handoff body",
    });
    expect(fs.readFileSync(path.join(profileStateRoot, "collab", "handoff.md"), "utf8"))
      .toBe("handoff body");

    const patched = await tool?.handler({
      operation: "state_patch",
      path: "collab/handoff.md",
      old: "handoff",
      new: "updated",
    });
    expect(patched).toMatchObject({
      success: true,
      path: "profile:collab/handoff.md",
      layer: "profile",
    });
    expect(fs.readFileSync(path.join(profileStateRoot, "collab", "handoff.md"), "utf8"))
      .toBe("updated body");
  });

  it("blocks unsafe profile state paths and source-kind mutations", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    fs.mkdirSync(path.join(profileStateRoot, "reference"), { recursive: true });
    fs.writeFileSync(
      path.join(profileStateRoot, "reference", "source.md"),
      "---\nsource_kind: source\n---\n\nProtected",
    );

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );

    const traversal = await tool?.handler({
      operation: "state_read",
      path: "../reference/source.md",
    });
    expect(traversal).toMatchObject({ error: expect.stringMatching(/traverse/i) });

    const blocked = await tool?.handler({
      operation: "state_patch",
      path: "reference/source.md",
      old: "Protected",
      new: "changed",
    });
    expect(blocked).toMatchObject({ error: expect.stringMatching(/source_kind: source/i) });

    const forced = await tool?.handler({
      operation: "state_patch",
      path: "reference/source.md",
      old: "Protected",
      new: "changed",
      force: true,
    });
    expect(forced).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(profileStateRoot, "reference", "source.md"), "utf8"))
      .toContain("changed");
  });

  it("blocks profile state writes through a symlinked subdirectory", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    const outsideRoot = createProfileRoot();
    fs.mkdirSync(path.join(profileStateRoot, "threads"), { recursive: true });
    fs.symlinkSync(outsideRoot, path.join(profileStateRoot, "threads", "outside"));

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = await tool?.handler({
      operation: "state_write",
      path: "threads/outside/new.md",
      content: "should not write outside",
    });

    expect(result).toMatchObject({ error: expect.stringMatching(/escapes/i) });
    expect(fs.existsSync(path.join(outsideRoot, "new.md"))).toBe(false);
  });

  it("blocks full overwrite on existing profile thread files", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    const threadPath = path.join(profileStateRoot, "threads", "canary.md");
    fs.mkdirSync(path.dirname(threadPath), { recursive: true });
    fs.writeFileSync(
      threadPath,
      [
        "---",
        "state_managed: true",
        "---",
        "",
        "# Canary",
        "",
        "## Quick Read",
        "",
        "status",
        "",
        "## Open Items",
        "",
        "- [ ] A8",
        "",
      ].join("\n"),
      "utf8",
    );

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );

    const blocked = await tool?.handler({
      operation: "state_write",
      path: "threads/canary.md",
      content: "This is a full overwrite test. All original content should be gone.",
    });

    expect(blocked).toMatchObject({ error: expect.stringMatching(/full-file write on an existing/i) });
    expect(fs.readFileSync(threadPath, "utf8")).toContain("## Quick Read");
  });
});
