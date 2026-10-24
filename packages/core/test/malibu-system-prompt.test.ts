import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assembleSoulPrompt, assembleV2SystemPrompt } from "../src/system-prompt.js";
import { loadV2AgentConfig } from "../src/v2-config-loader.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
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

function isolateProfileHome(): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-home-"));
  tempDirs.push(homeDir);
  process.env.TANGO_HOME = homeDir;
  process.env.TANGO_PROFILE = "default";
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8").trim();
}

function firstNonEmptyLine(content: string): string {
  return content.split("\n").find((line) => line.trim().length > 0) ?? "";
}

describe("assembleSoulPrompt", () => {
  it("assembles Malibu's system prompt from soul, shared files, and knowledge without workers or tool docs", () => {
    isolateProfileHome();
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "malibu.yaml"));
    const soul = readRepoFile("agents/assistants/malibu/soul.md");
    const rules = readRepoFile("agents/shared/RULES.md");
    const user = readRepoFile("agents/shared/USER.md");
    const knowledge = readRepoFile("agents/assistants/malibu/knowledge.md");
    const fatsecretTool = readRepoFile("agents/tools/fatsecret.md");
    const wellnessDbTool = readRepoFile("agents/tools/wellnessdb.md");

    const prompt = assembleSoulPrompt(config, { repoRoot });
    const v2Prompt = assembleV2SystemPrompt(config, { repoRoot });

    expect(typeof prompt).toBe("string");
    expect(prompt).toBe([soul, rules, user, knowledge].join("\n\n"));
    expect(v2Prompt).toBe(prompt);
    expect(prompt).toContain(soul);
    expect(prompt).toContain(rules);
    expect(prompt).toContain("Tango can process uploaded images");
    expect(prompt).toContain("attachment_search");
    expect(prompt).toContain("Never expose absolute local filesystem storage paths");
    expect(prompt).toContain(user);
    expect(prompt).toContain(knowledge);
    for (const toolId of [
      "wellnessdb_add_recipe_ingredient",
      "wellnessdb_update_recipe_ingredient",
      "wellnessdb_remove_recipe_ingredient",
      "wellnessdb_archive_recipe",
      "wellnessdb_duplicate_recipe",
      "wellnessdb_add_product",
      "wellnessdb_update_product",
    ]) {
      expect(prompt).toContain(toolId);
      expect(wellnessDbTool).toContain(toolId);
    }
    expect(prompt).toContain("ALWAYS call `wellnessdb_get_recipe_detail`");
    expect(prompt).toContain("base_quantity_g");
    expect(prompt).toContain("Never replace a whole ingredient list when a single-row tool will do");
    expect(prompt).not.toContain("dispatch_worker");
    expect(prompt).not.toContain("<worker-dispatch");
    expect(prompt).not.toContain(firstNonEmptyLine(fatsecretTool));
    expect(prompt).not.toContain(firstNonEmptyLine(wellnessDbTool));
  });
});
