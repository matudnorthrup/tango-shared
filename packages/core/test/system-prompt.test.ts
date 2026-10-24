import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleAgentPrompt } from "../src/system-prompt.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-system-prompt-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  return dir;
}

function isolateProfileHome(): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-home-"));
  tempDirs.push(homeDir);
  process.env.TANGO_HOME = homeDir;
  process.env.TANGO_PROFILE = "default";
}

describe("assembleAgentPrompt", () => {
  it("assembles soul, shared rules/user, and knowledge into one string", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "AGENTS.md"), "shared agents");
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "watson soul");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "watson knowledge");
    fs.writeFileSync(path.join(agentDir, "workers.md"), "watson workers");
    fs.mkdirSync(path.join(agentsDir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "tools", "wellnessdb.md"), "atlas tool doc");
    fs.writeFileSync(path.join(agentsDir, "tools", "fatsecret.md"), "fatsecret tool doc");
    fs.writeFileSync(path.join(agentsDir, "skills", "recipe-management.md"), "recipe format skill");
    fs.writeFileSync(path.join(agentsDir, "skills", "health-baselines.md"), "health baselines skill");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
    });

    expect(typeof prompt).toBe("string");
    expect(prompt).toBe(
      "watson soul\n\nshared rules\n\nshared user\n\nwatson knowledge",
    );
    expect(prompt).toContain("watson soul");
    expect(prompt).not.toContain("shared agents");
    expect(prompt).toContain("shared rules");
    expect(prompt).toContain("shared user");
    expect(prompt).toContain("watson knowledge");
    expect(prompt).not.toContain("watson workers");
    expect(prompt).not.toContain("atlas tool doc");
    expect(prompt).not.toContain("fatsecret tool doc");
    expect(prompt).not.toContain("recipe format skill");
    expect(prompt).not.toContain("health baselines skill");
  });

  it("falls back to a minimal prompt when no prompt files exist", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "workers", "missing-agent");
    fs.mkdirSync(agentDir, { recursive: true });

    expect(assembleAgentPrompt(agentDir)).toBe(
      "You are the missing-agent agent. Execute the task using your available tools.",
    );
  });

  it("finds the agents root for nested system agents without an override", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "system", "dispatch");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "AGENTS.md"), "shared agents");
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "dispatch soul");

    const prompt = assembleAgentPrompt(agentDir);

    expect(prompt).toContain("dispatch soul");
    expect(prompt).toContain("shared rules");
    expect(prompt).not.toContain("shared agents");
  });

  it("uses per-agent USER.md when present instead of shared USER.md", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "cod-e");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "cod-e soul");
    fs.writeFileSync(path.join(agentDir, "USER.md"), "cod-e user profile");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "cod-e knowledge");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
    });

    expect(prompt).toContain("cod-e soul");
    expect(prompt).toContain("shared rules");
    expect(prompt).toContain("cod-e user profile");
    expect(prompt).not.toContain("shared user");
    expect(prompt).toContain("cod-e knowledge");
  });

  it("stacks shared RULES.md and per-agent RULES.md when both exist", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "strict-agent");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "strict soul");
    fs.writeFileSync(path.join(agentDir, "RULES.md"), "agent-specific rules");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
    });

    expect(prompt).toContain("shared rules");
    expect(prompt).toContain("agent-specific rules");
    expect(prompt.indexOf("shared rules")).toBeLessThan(prompt.indexOf("agent-specific rules"));
    expect(prompt).toContain("shared user");
  });

  it("loads only per-agent RULES.md when shared RULES.md is missing", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "agent-only-rules");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "agent soul");
    fs.writeFileSync(path.join(agentDir, "RULES.md"), "agent-only rules");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
    });

    expect(prompt).toContain("agent-only rules");
    expect(prompt).toContain("shared user");
  });

  it("uses profile shared RULES and USER before repo shared defaults", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    const profileSharedDir = path.join(agentsDir, "profile", "prompts", "shared");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(profileSharedDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "repo rules");
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "repo user");
    fs.writeFileSync(path.join(profileSharedDir, "RULES.md"), "profile rules");
    fs.writeFileSync(path.join(profileSharedDir, "USER.md"), "profile user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "watson soul");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
      profileSharedDirs: [profileSharedDir],
    });

    expect(prompt).toContain("watson soul");
    expect(prompt).toContain("profile rules");
    expect(prompt).toContain("profile user");
    expect(prompt).not.toContain("repo rules");
    expect(prompt).not.toContain("repo user");
  });

  it("appends profile overlay prompt sections after the base prompt", () => {
    isolateProfileHome();
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    const overlayDir = path.join(agentsDir, "profile-overrides", "agents", "watson");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(overlayDir, { recursive: true });

    fs.writeFileSync(path.join(agentDir, "soul.md"), "base soul");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "base knowledge");
    fs.writeFileSync(path.join(overlayDir, "persona.md"), "profile persona");
    fs.writeFileSync(path.join(overlayDir, "knowledge.md"), "profile knowledge");
    fs.writeFileSync(path.join(overlayDir, "workers.md"), "profile worker overlay");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
      overlayDir,
    });

    expect(prompt).toContain("base soul");
    expect(prompt).toContain("base knowledge");
    expect(prompt).toContain("profile persona");
    expect(prompt).toContain("profile knowledge");
    expect(prompt).not.toContain("profile worker overlay");
    expect(prompt.indexOf("profile knowledge")).toBeGreaterThan(prompt.indexOf("base knowledge"));
    expect(prompt.indexOf("profile persona")).toBeGreaterThan(prompt.indexOf("profile knowledge"));
  });
});
