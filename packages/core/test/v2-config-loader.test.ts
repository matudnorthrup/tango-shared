import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isV2AgentEnabled,
  isV2RuntimeEnabled,
  loadAllV2AgentConfigs,
  loadLayeredV2AgentConfigs,
  loadV2AgentConfig,
  resolveV2MemoryScope,
} from "../src/v2-config-loader.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("loadV2AgentConfig", () => {
  it("loads an optional GPT-Live voice from an agent config", () => {
    const dir = createTempDir("tango-live-voice-");
    const file = path.join(dir, "agent.yaml");
    const source = fs.readFileSync(path.join(repoRoot, "config/v2/agents/malibu.yaml"), "utf8");
    fs.writeFileSync(file, source.replace(/^voice:$/m, "voice:\n  live_voice: breeze"));
    expect(loadV2AgentConfig(file).voice?.liveVoice).toBe("breeze");
  });

  it("loads the Malibu v2 YAML and maps required fields", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "malibu.yaml"));

    expect(config).toMatchObject({
      id: "malibu",
      enabled: false,
      displayName: "Malibu",
      type: "wellness",
      systemPromptFile: "agents/assistants/malibu/soul.md",
      runtime: {
        mode: "persistent",
        provider: "claude-code-v2",
        fallback: "codex",
        model: "claude-opus-5-5",
        reasoningEffort: "medium",
        idleTimeoutHours: 24,
        contextResetThreshold: 0.8,
      },
      memory: {
        postTurnExtraction: "enabled",
        extractionModel: "role:memory-extraction",
        importanceThreshold: 0.4,
        scheduledReflection: "enabled",
      },
      voice: {
        callSigns: ["Malibu", "Mali", "Coach Malibu"],
        defaultChannelId: "100000000000000002",
        smokeTestChannelId: "100000000000001002",
      },
      discord: {
        defaultChannelId: "100000000000000002",
        smokeTestChannelId: "100000000000001002",
      },
    });
    expect(config.mcpServers.length).toBeGreaterThanOrEqual(5);
    expect(config.mcpServers[0]).toEqual({
      name: "memory",
      command: "node",
      args: ["packages/atlas-memory/dist/index.js"],
    });
    expect(config.mcp).toEqual({
      defaultServers: ["memory", "wellness", "wellness-db", "fatsecret"],
      availableServers: undefined,
    });
  });

  it.each(["malibu", "malibu-ollama"])("exposes exactly the wellness DB tools to %s", (agent) => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", `${agent}.yaml`));
    const server = config.mcpServers.find((entry) => entry.name === "wellness-db");
    expect(server).toMatchObject({ command: "node", args: ["packages/core/dist/mcp-proxy.js", "wellness-db"] });
    expect(server?.env?.ALLOWED_TOOL_IDS.split(",").sort()).toEqual([
      "wellnessdb_active_products", "wellnessdb_add_recipe", "wellnessdb_day_range", "wellnessdb_day_summary",
      "wellnessdb_get_recipe_detail", "wellnessdb_recent_meals", "wellnessdb_search_product",
      "wellnessdb_search_recipe", "wellnessdb_update_recipe",
      "wellnessdb_add_recipe_ingredient", "wellnessdb_update_recipe_ingredient", "wellnessdb_remove_recipe_ingredient", "wellnessdb_archive_recipe", "wellnessdb_duplicate_recipe", "wellnessdb_add_product", "wellnessdb_update_product",
    ].sort());
    expect(config.mcp?.defaultServers).toContain("wellness-db");
    expect(config.mcpServers.map((entry) => entry.name)).toEqual(expect.arrayContaining(["wellness", "fatsecret"]));
    expect(config.mcpServers.map((entry) => entry.name)).not.toContain("atlas");
    const allowedTools = config.mcpServers.flatMap((entry) => entry.env?.ALLOWED_TOOL_IDS?.split(",") ?? []);
    expect(allowedTools).not.toEqual(expect.arrayContaining(["atlas_sql"]));
    for (const retired of ["recipe_list", "recipe_read", "recipe_write"]) expect(allowedTools).not.toContain(retired);
  });

  it("exposes the recipe admin tools through Jules for the recipe librarian", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "jules.yaml"));
    const server = config.mcpServers.find((entry) => entry.name === "wellness-db");
    expect(server?.env?.ALLOWED_TOOL_IDS.split(",")).toEqual(expect.arrayContaining([
      "wellnessdb_add_recipe_ingredient", "wellnessdb_update_recipe_ingredient", "wellnessdb_remove_recipe_ingredient", "wellnessdb_archive_recipe", "wellnessdb_duplicate_recipe",
    ]));
  });

  it("loads Victor as an operations agent with Linear and Obsidian access but no dev MCP surface", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "victor.yaml"));

    expect(config).toMatchObject({
      id: "victor",
      type: "operations",
      defaultProject: "operations",
      tools: {
        mode: "off",
      },
    });
    expect(config.orchestration).toBeUndefined();

    const serverNames = config.mcpServers.map((server) => server.name);
    expect(serverNames).toEqual(expect.arrayContaining(["memory", "linear", "obsidian"]));
    expect(serverNames).not.toEqual(expect.arrayContaining(["tango-dev", "discord-manage", "agent-docs"]));

    const linearServer = config.mcpServers.find((server) => server.name === "linear");
    expect(linearServer).toMatchObject({
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "linear"],
      env: {
        ALLOWED_TOOL_IDS: "linear",
      },
    });
  });

  it("loads current turn metadata settings from cod-e", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "cod-e.yaml"));
    expect(config.currentTurnMetadata).toEqual({
      timeZone: "America/Los_Angeles",
      timeFormat: "12h",
    });
  });

  it("rejects dynamic MCP mount policies that name unknown servers", () => {
    const dir = createTempDir("tango-v2-bad-mcp-");
    const configPath = path.join(dir, "alpha.yaml");
    fs.writeFileSync(
      configPath,
      [
        "id: alpha",
        "display_name: Alpha",
        "type: test",
        "system_prompt_file: agents/assistants/watson/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "    args: [memory.js]",
        "mcp:",
        "  default_servers: [memory, missing]",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: '123'",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadV2AgentConfig(configPath)).toThrow(
      "mcp.default_servers references unknown MCP server(s): missing",
    );
  });

  it("loads configured shared memory scopes for Ollama clones", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "sierra-ollama.yaml"));

    expect(config.memory).toMatchObject({
      canonicalAgentId: "sierra",
      aliasAgentIds: ["sierra", "sierra-ollama"],
    });
    expect(resolveV2MemoryScope("sierra-ollama", config)).toEqual({
      canonicalAgentId: "sierra",
      aliasAgentIds: ["sierra", "sierra-ollama"],
    });
  });

  it("loads generic responsibility and collaboration policy config", () => {
    const victor = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "victor.yaml"));
    const sierra = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "sierra.yaml"));
    const foxtrot = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "foxtrot.yaml"));
    const foxtrotOllama = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "foxtrot-ollama.yaml"));
    const kilo = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "kilo.yaml"));

    expect(victor.responsibilities?.[0]).toMatchObject({
      id: "operations_coordination",
      autonomy: {
        default: "supervised",
        writesRequireConfirmation: true,
        purchaseOrPayment: "never",
      },
      collaboration: {
        canRequest: [
          {
            agent: "sierra",
            purposes: ["source-check", "vendor-comparison", "local-business-research"],
          },
        ],
      },
    });

    expect(sierra.responsibilities?.[0]?.collaboration?.canFulfill?.[0]).toMatchObject({
      purpose: "source-check",
      maxTurns: 1,
      maxDurationSeconds: 180,
      maxToolCalls: 6,
      visibilityModes: ["summary", "digest", "thread", "transcript", "silent"],
    });

    for (const config of [foxtrot, foxtrotOllama]) {
      expect(config.mcpServers.find((server) => server.name === "collaboration")).toMatchObject({
        args: ["packages/core/dist/mcp-proxy.js", "collaboration"],
        env: { ALLOWED_TOOL_IDS: "collaborate_with_agent" },
      });
      expect(config.responsibilities?.[0]?.collaboration?.canRequest).toEqual([
        { agent: "kilo", purposes: ["kilo-spending-support"] },
      ]);
    }

    expect(kilo.responsibilities?.[0]).toMatchObject({
      id: "kid_spending_support",
      collaboration: {
        canFulfill: [{
          purpose: "kilo-spending-support",
          maxTurns: 1,
          maxDurationSeconds: 180,
          maxToolCalls: 4,
        }],
      },
    });
  });

  it("keeps base agents and their Ollama clones on shared memory scopes", () => {
    const configs = loadAllV2AgentConfigs(path.join(repoRoot, "config", "v2", "agents"));
    const pairs = [
      ["charlie", "charlie-ollama"],
      ["foxtrot", "foxtrot-ollama"],
      ["juliet", "juliet-ollama"],
      ["malibu", "malibu-ollama"],
      ["sierra", "sierra-ollama"],
      ["victor", "victor-ollama"],
      ["watson", "watson-ollama"],
    ] as const;

    for (const [baseAgentId, cloneAgentId] of pairs) {
      const expectedScope = {
        canonicalAgentId: baseAgentId,
        aliasAgentIds: [baseAgentId, cloneAgentId],
      };

      expect(resolveV2MemoryScope(baseAgentId, configs.get(baseAgentId))).toEqual(expectedScope);
      expect(resolveV2MemoryScope(cloneAgentId, configs.get(cloneAgentId))).toEqual(expectedScope);
    }
  });

  it("gives Charlie read-only current-location narration without route or fuel tools", () => {
    const configs = loadAllV2AgentConfigs(path.join(repoRoot, "config", "v2", "agents"));

    for (const agentId of ["charlie", "charlie-ollama"]) {
      const config = configs.get(agentId);
      const locationServer = config?.mcpServers.find((server) => server.name === "location");
      const memoryServer = config?.mcpServers.find((server) => server.name === "memory");

      expect(locationServer).toMatchObject({
        args: ["packages/core/dist/mcp-proxy.js", "location"],
        env: { ALLOWED_TOOL_IDS: "location_read" },
      });
      expect(memoryServer?.env).toMatchObject({ ALLOWED_TOOL_IDS: "memory_search" });
      expect(locationServer?.env?.ALLOWED_TOOL_IDS).not.toContain("driving_route");
      expect(locationServer?.env?.ALLOWED_TOOL_IDS).not.toContain("walking_route");
      expect(locationServer?.env?.ALLOWED_TOOL_IDS).not.toContain("find_diesel");
    }
  });

  it("allows voice configs to use the app-level Kokoro default", () => {
    const tempDir = createTempDir("tango-v2-default-voice-");
    const configPath = path.join(tempDir, "default-voice.yaml");
    fs.writeFileSync(
      configPath,
      [
        "id: default-voice",
        "display_name: Default Voice",
        "type: test",
        "system_prompt_file: agents/assistants/default-voice/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
        "voice:",
        "  call_signs:",
        "    - Default Voice",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );

    const config = loadV2AgentConfig(configPath);

    expect(config.voice).toMatchObject({
      callSigns: ["Default Voice"],
      defaultChannelId: "123",
    });
    expect(config.voice?.kokoroVoice).toBeUndefined();
  });

  it("maps optional current-turn metadata preferences", () => {
    const tempDir = createTempDir("tango-v2-current-turn-");
    const configPath = path.join(tempDir, "time-aware.yaml");
    fs.writeFileSync(
      configPath,
      [
        "id: time-aware",
        "display_name: Time Aware",
        "type: test",
        "system_prompt_file: agents/assistants/time-aware/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
        "current_turn_metadata:",
        "  timezone: America/Los_Angeles",
        "  locale: en-US",
        "  time_format: 24h",
      ].join("\n"),
    );

    const config = loadV2AgentConfig(configPath);

    expect(config.currentTurnMetadata).toEqual({
      timeZone: "America/Los_Angeles",
      locale: "en-US",
      timeFormat: "24h",
    });
  });
});

describe("isV2RuntimeEnabled", () => {
  it("returns false for legacy or disabled configs and true for enabled claude-code-v2 configs", () => {
    const tempDir = createTempDir("tango-v2-config-");

    const legacyPath = path.join(tempDir, "legacy-agent.yaml");
    fs.writeFileSync(
      legacyPath,
      [
        "id: legacy-agent",
        "display_name: Legacy Agent",
        "type: test",
        "system_prompt_file: agents/assistants/test-agent/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: legacy",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );
    expect(isV2RuntimeEnabled(loadV2AgentConfig(legacyPath))).toBe(false);

    const v2Path = path.join(tempDir, "v2-agent.yaml");
    fs.writeFileSync(
      v2Path,
      [
        "id: v2-agent",
        "display_name: V2 Agent",
        "type: test",
        "system_prompt_file: agents/assistants/test-agent/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  fallback: codex",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );
    expect(isV2RuntimeEnabled(loadV2AgentConfig(v2Path))).toBe(true);

    const disabledPath = path.join(tempDir, "disabled-agent.yaml");
    fs.writeFileSync(
      disabledPath,
      [
        "id: disabled-agent",
        "enabled: false",
        "display_name: Disabled Agent",
        "type: test",
        "system_prompt_file: agents/assistants/test-agent/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  fallback: codex",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );
    const disabledConfig = loadV2AgentConfig(disabledPath);
    expect(isV2AgentEnabled(disabledConfig)).toBe(false);
    expect(isV2RuntimeEnabled(disabledConfig)).toBe(false);
  });
});

describe("loadAllV2AgentConfigs", () => {
  it("loads every YAML config in the target directory and keys them by agent id", () => {
    const tempDir = createTempDir("tango-v2-config-dir-");

    fs.writeFileSync(
      path.join(tempDir, "bravo.yaml"),
      [
        "id: bravo",
        "display_name: Bravo",
        "type: test",
        "system_prompt_file: agents/assistants/bravo/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: legacy",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tempDir, "alpha.yaml"),
      [
        "id: alpha",
        "display_name: Alpha",
        "type: test",
        "system_prompt_file: agents/assistants/alpha/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: high",
        "  idle_timeout_hours: 12",
        "  context_reset_threshold: 0.7",
        "memory:",
        "  post_turn_extraction: disabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.5",
        "  scheduled_reflection: disabled",
        "discord:",
        "  default_channel_id: \"456\"",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(tempDir, "README.md"), "ignored");

    const configs = loadAllV2AgentConfigs(tempDir);

    expect([...configs.keys()]).toEqual(["alpha", "bravo"]);
    expect(configs.get("alpha")).toMatchObject({
      id: "alpha",
      runtime: {
        provider: "claude-code-v2",
      },
    });
    expect(configs.get("bravo")).toMatchObject({
      id: "bravo",
      runtime: {
        provider: "legacy",
      },
    });
  });

  it("exposes read-only attachment tools to every general repo v2 agent", () => {
    const configs = loadAllV2AgentConfigs(path.join(repoRoot, "config", "v2", "agents"));
    expect(configs.size).toBeGreaterThan(0);

    for (const config of configs.values()) {
      if (config.type === "kid-finance") {
        expect(config.mcpServers.map((server) => server.name)).toEqual(["kilo-ledger"]);
        continue;
      }
      if (config.tools?.mode === "off") {
        continue;
      }
      const attachmentServer = config.mcpServers.find((server) => server.name === "attachments");
      expect(attachmentServer).toMatchObject({
        command: "node",
        args: ["packages/core/dist/mcp-proxy.js", "attachments"],
        env: {
          ALLOWED_TOOL_IDS: "attachment_search,attachment_read,attachment_status",
        },
      });
    }
  });
});

describe("loadLayeredV2AgentConfigs", () => {
  it("merges repo v2 configs with profile v2 overrides", () => {
    const repoRoot = createTempDir("tango-v2-layered-repo-");
    const homeDir = createTempDir("tango-v2-layered-home-");
    const originalCwd = process.cwd();
    const originalEnv = { ...process.env };
    process.chdir(repoRoot);
    const resolvedRepoRoot = process.cwd();
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    try {
      fs.mkdirSync(path.join(resolvedRepoRoot, "config", "defaults"), { recursive: true });
      fs.mkdirSync(path.join(resolvedRepoRoot, "config", "v2", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(resolvedRepoRoot, "config", "v2", "agents", "alpha.yaml"),
        [
          "id: alpha",
          "enabled: false",
          "display_name: Alpha",
          "type: test",
          "system_prompt_file: agents/assistants/alpha/soul.md",
          "mcp_servers:",
          "  - name: memory",
          "    command: node",
          "runtime:",
          "  mode: persistent",
          "  provider: claude-code-v2",
          "  fallback: codex",
          "  model: claude-sonnet-4-6",
          "  reasoning_effort: medium",
          "  idle_timeout_hours: 24",
          "  context_reset_threshold: 0.8",
          "  timeout_seconds: 0",
          "memory:",
          "  post_turn_extraction: enabled",
          "  extraction_model: claude-haiku-4-5",
          "  importance_threshold: 0.4",
          "  scheduled_reflection: enabled",
          "discord:",
          "  default_channel_id: \"repo-channel\"",
          "voice:",
          "  call_signs:",
          "    - Alpha",
          "  kokoro_voice: am_adam",
          "  default_channel_id: \"repo-channel\"",
        ].join("\n"),
      );
      const profileV2Dir = path.join(
        homeDir,
        "profiles",
        "default",
        "config",
        "v2",
        "agents",
      );
      fs.mkdirSync(profileV2Dir, { recursive: true });
      fs.writeFileSync(
        path.join(profileV2Dir, "alpha.yaml"),
        [
          "id: alpha",
          "enabled: true",
          "voice:",
          "  default_channel_id: \"profile-channel\"",
          "  smoke_test_channel_id: \"profile-smoke\"",
          "discord:",
          "  default_channel_id: \"profile-channel\"",
          "  smoke_test_channel_id: \"profile-smoke\"",
        ].join("\n"),
      );

      const configs = loadLayeredV2AgentConfigs(path.join(resolvedRepoRoot, "config", "defaults"));

      expect(configs.get("alpha")).toMatchObject({
        id: "alpha",
        enabled: true,
        displayName: "Alpha",
        runtime: {
          provider: "claude-code-v2",
          timeoutSeconds: 0,
        },
        voice: {
          callSigns: ["Alpha"],
          defaultChannelId: "profile-channel",
          smokeTestChannelId: "profile-smoke",
        },
        discord: {
          defaultChannelId: "profile-channel",
          smokeTestChannelId: "profile-smoke",
        },
      });
    } finally {
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
    }
  });
});
