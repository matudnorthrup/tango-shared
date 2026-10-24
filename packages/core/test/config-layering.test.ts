import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAgentConfigs,
  loadWorkerConfigs,
  resolveConfigDir,
  traceConfigCategory,
} from "../src/config.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);

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

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("layered config loading", () => {
  it("merges repo defaults with profile overrides and preserves source traces", () => {
    const repoRoot = createTempDir("tango-layered-repo-");
    const homeDir = createTempDir("tango-layered-home-");
    process.chdir(repoRoot);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    const defaultsFile = path.join(repoRoot, "config", "defaults", "agents", "watson.yaml");
    const profileFile = path.join(
      homeDir,
      "profiles",
      "default",
      "config",
      "agents",
      "watson.yaml",
    );

    writeFile(
      defaultsFile,
      [
        "id: watson",
        "type: personal",
        "display_name: Watson",
        "avatar_url: https://example.com/default-watson.webp",
        "provider:",
        "  default: claude-oauth",
        "voice:",
        "  call_signs:",
        "    - watson",
        "tools:",
        "  mode: allowlist",
        "  allowlist:",
        "    - wellnessdb_search_product",
        "    - memory_search",
      ].join("\n"),
    );
    writeFile(
      profileFile,
      [
        "id: watson",
        "display_name: My Watson",
        "avatar_url: https://example.com/profile-watson.webp",
        "voice:",
        "  call_signs:",
        "    - doc",
        "tools:",
        "  allowlist:",
        "    - memory_search",
      ].join("\n"),
    );

    expect(fs.realpathSync(resolveConfigDir())).toBe(
      fs.realpathSync(path.join(repoRoot, "config", "defaults")),
    );

    const [agent] = loadAgentConfigs(resolveConfigDir());
    expect(agent).toMatchObject({
      id: "watson",
      displayName: "My Watson",
      avatarURL: "https://example.com/profile-watson.webp",
      provider: {
        default: "claude-oauth",
      },
      voice: {
        callSigns: ["doc"],
      },
      tools: {
        mode: "allowlist",
        allowlist: ["memory_search"],
      },
    });

    const [trace] = traceConfigCategory({
      category: "agents",
      configDir: resolveConfigDir(),
      id: "watson",
    });
    expect(trace.sourceFiles.map((source) => fs.realpathSync(source.filePath))).toEqual([
      fs.realpathSync(defaultsFile),
      fs.realpathSync(profileFile),
    ]);
    expect(fs.realpathSync(trace.fieldSources.display_name)).toBe(
      fs.realpathSync(profileFile),
    );
    expect(fs.realpathSync(trace.fieldSources.avatar_url)).toBe(
      fs.realpathSync(profileFile),
    );
    expect(fs.realpathSync(trace.fieldSources.provider)).toBe(
      fs.realpathSync(defaultsFile),
    );
  });

  it("treats an explicit config directory as a single layer", () => {
    const repoRoot = createTempDir("tango-explicit-repo-");
    const homeDir = createTempDir("tango-explicit-home-");
    const explicitDir = createTempDir("tango-explicit-config-");
    process.chdir(repoRoot);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    writeFile(
      path.join(repoRoot, "config", "defaults", "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "display_name: Repo Watson",
        "provider:",
        "  default: claude-oauth",
      ].join("\n"),
    );
    writeFile(
      path.join(homeDir, "profiles", "default", "config", "agents", "watson.yaml"),
      [
        "id: watson",
        "display_name: Profile Watson",
      ].join("\n"),
    );
    const explicitFile = path.join(explicitDir, "agents", "watson.yaml");
    writeFile(
      explicitFile,
      [
        "id: watson",
        "type: personal",
        "display_name: Explicit Watson",
        "provider:",
        "  default: codex",
      ].join("\n"),
    );

    const [agent] = loadAgentConfigs(explicitDir);
    expect(agent).toMatchObject({
      displayName: "Explicit Watson",
      provider: {
        default: "codex",
      },
    });

    const [trace] = traceConfigCategory({
      category: "agents",
      configDir: explicitDir,
      id: "watson",
    });
    expect(trace.sourceFiles).toHaveLength(1);
    expect(trace.sourceFiles[0]?.filePath).toBe(explicitFile);
  });

  it("resolves prompt_file relative to the override file that set it", () => {
    const repoRoot = createTempDir("tango-prompt-layered-repo-");
    const homeDir = createTempDir("tango-prompt-layered-home-");
    process.chdir(repoRoot);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    writeFile(
      path.join(repoRoot, "config", "defaults", "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
      ].join("\n"),
    );

    const promptFile = path.join(
      homeDir,
      "profiles",
      "default",
      "config",
      "prompts",
      "watson-profile.md",
    );
    writeFile(promptFile, "profile prompt override");
    writeFile(
      path.join(homeDir, "profiles", "default", "config", "agents", "watson.yaml"),
      [
        "id: watson",
        "prompt_file: ../prompts/watson-profile.md",
      ].join("\n"),
    );

    const [agent] = loadAgentConfigs(resolveConfigDir());
    expect(agent.prompt).toBe("profile prompt override");
    expect(agent.promptFile).toBe(promptFile);
  });

  it("appends profile-owned prompt overlays when the base prompt uses soul.md assembly", () => {
    const repoRoot = createTempDir("tango-overlay-repo-");
    const homeDir = createTempDir("tango-overlay-home-");
    process.chdir(repoRoot);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    writeFile(
      path.join(repoRoot, "config", "defaults", "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "provider:",
        "  default: claude-oauth",
        "prompt_file: ../../../agents/assistants/watson/soul.md",
      ].join("\n"),
    );
    writeFile(path.join(repoRoot, "agents", "shared", "AGENTS.md"), "shared agents");
    writeFile(path.join(repoRoot, "agents", "shared", "RULES.md"), "shared rules");
    writeFile(path.join(repoRoot, "agents", "shared", "USER.md"), "shared user");
    writeFile(path.join(repoRoot, "agents", "assistants", "watson", "soul.md"), "base soul");
    writeFile(
      path.join(homeDir, "profiles", "default", "prompts", "agents", "watson", "persona.md"),
      "profile persona",
    );
    writeFile(
      path.join(homeDir, "profiles", "default", "prompts", "agents", "watson", "knowledge.md"),
      "profile knowledge",
    );

    const [agent] = loadAgentConfigs(resolveConfigDir());
    expect(agent.prompt).toContain("base soul");
    expect(agent.prompt).toContain("shared rules");
    expect(agent.prompt).toContain("shared user");
    expect(agent.prompt).not.toContain("shared agents");
    expect(agent.prompt).toContain("profile persona");
    expect(agent.prompt).toContain("profile knowledge");
  });

  it("applies profile-owned prompt overlays when assembling worker prompts", () => {
    const repoRoot = createTempDir("tango-worker-overlay-repo-");
    const homeDir = createTempDir("tango-worker-overlay-home-");
    process.chdir(repoRoot);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    writeFile(
      path.join(repoRoot, "config", "defaults", "workers", "research-assistant.yaml"),
      [
        "id: research-assistant",
        "type: researcher",
        "owner_agent: sierra",
        "provider:",
        "  default: claude-oauth",
        "tool_contract_ids:",
        "  - exa_search",
        "skill_doc_ids:",
        "  - deep_research",
        "prompt_file: ../../../agents/workers/research-assistant/soul.md",
      ].join("\n"),
    );
    writeFile(path.join(repoRoot, "agents", "shared", "AGENTS.md"), "shared agents");
    writeFile(path.join(repoRoot, "agents", "shared", "RULES.md"), "shared rules");
    writeFile(path.join(repoRoot, "agents", "shared", "USER.md"), "shared user");
    writeFile(path.join(repoRoot, "agents", "workers", "research-assistant", "soul.md"), "worker soul");
    writeFile(
      path.join(repoRoot, "agents", "workers", "research-assistant", "knowledge.md"),
      "worker knowledge",
    );
    writeFile(path.join(repoRoot, "agents", "tools", "exa.md"), "base exa tool");
    writeFile(path.join(repoRoot, "agents", "skills", "deep-research.md"), "base deep research");
    writeFile(
      path.join(homeDir, "profiles", "default", "prompts", "tools", "exa.md"),
      "profile exa overlay",
    );
    writeFile(
      path.join(homeDir, "profiles", "default", "prompts", "skills", "deep-research.md"),
      "profile deep research overlay",
    );
    writeFile(
      path.join(homeDir, "profiles", "default", "prompts", "workers", "research-assistant", "knowledge.md"),
      "worker profile knowledge",
    );

    const [worker] = loadWorkerConfigs(resolveConfigDir());
    expect(worker.prompt).toContain("worker soul");
    expect(worker.prompt).toContain("shared rules");
    expect(worker.prompt).toContain("shared user");
    expect(worker.prompt).toContain("worker knowledge");
    expect(worker.prompt).toContain("worker profile knowledge");
    expect(worker.prompt).not.toContain("shared agents");
    expect(worker.prompt).not.toContain("base exa tool");
    expect(worker.prompt).not.toContain("profile exa overlay");
    expect(worker.prompt).not.toContain("base deep research");
    expect(worker.prompt).not.toContain("profile deep research overlay");
  });
});
