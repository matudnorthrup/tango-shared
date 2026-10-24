import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfigs } from "../src/config.js";
import {
  loadUnifiedAgentConfigs,
  v2ToLegacyAgentConfig,
} from "../src/v2-legacy-bridge.js";
import { loadAllV2AgentConfigs } from "../src/v2-config-loader.js";
import type { V2AgentConfig } from "../src/v2-config-loader.js";

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

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function baseV2Config(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
  return {
    id: "bridge-agent",
    displayName: "Bridge Agent",
    type: "test",
    avatarURL: "https://example.com/bridge.png",
    avatarPath: "agents/assistants/bridge/avatar.png",
    systemPromptFile: "prompts/bridge.md",
    mcpServers: [
      {
        name: "memory",
        command: "node",
      },
    ],
    runtime: {
      mode: "persistent",
      provider: "claude-code-v2",
      fallback: "codex",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
    },
    memory: {
      postTurnExtraction: "enabled",
      extractionModel: "claude-haiku-4-5",
      importanceThreshold: 0.4,
      scheduledReflection: "enabled",
    },
    voice: {
      callSigns: ["Bridge"],
      defaultPromptAgent: "dispatch",
      kokoroVoice: "am_adam",
      defaultChannelId: "111",
      smokeTestChannelId: "222",
    },
    discord: {
      defaultChannelId: "111",
      smokeTestChannelId: "222",
    },
    defaultTopic: "test/default",
    defaultProject: "test-project",
    responseMode: "concise",
    tools: {
      mode: "allowlist",
      allowlist: ["WebSearch", "WebFetch"],
      permissionMode: "bypass",
    },
    orchestration: {
      workerIds: ["test-worker"],
      writeConfirmation: "on-ambiguity",
    },
    deterministicRouting: {
      enabled: true,
      projectScope: "test",
      additionalDomains: ["notes"],
      confidenceThreshold: 0.75,
      provider: {
        default: "claude-oauth",
        model: "router-model",
        reasoningEffort: "low",
        fallback: ["codex"],
      },
    },
    access: {
      mode: "both",
      allowlistChannelIds: ["111", "222"],
      allowlistUserIds: ["user-1"],
    },
    ...overrides,
  };
}

function writeV2Agent(root: string, id: string, overrides: string[] = []): void {
  writeFile(
    path.join(root, "config", "v2", "agents", `${id}.yaml`),
    [
      `id: ${id}`,
      `display_name: ${id}`,
      "type: test",
      `system_prompt_file: prompts/${id}.md`,
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
      ...overrides,
    ].join("\n"),
  );
  writeFile(path.join(root, "prompts", `${id}.md`), `${id} prompt`);
}

describe("v2ToLegacyAgentConfig", () => {
  it("maps v2 registry fields into legacy AgentConfig", () => {
    const root = createTempDir("tango-v2-bridge-");
    writeFile(path.join(root, "prompts", "bridge.md"), "bridge prompt");

    const legacy = v2ToLegacyAgentConfig(baseV2Config(), { repoRoot: root });

    expect(legacy).toMatchObject({
      id: "bridge-agent",
      type: "test",
      displayName: "Bridge Agent",
      avatarURL: "https://example.com/bridge.png",
      avatarPath: "agents/assistants/bridge/avatar.png",
      provider: {
        default: "claude-oauth",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
        fallback: ["codex"],
      },
      prompt: "bridge prompt",
      promptFile: path.join(root, "prompts", "bridge.md"),
      defaultTopic: "test/default",
      defaultProject: "test-project",
      voice: {
        callSigns: ["Bridge"],
        defaultPromptAgent: "dispatch",
        kokoroVoice: "am_adam",
        defaultChannelId: "111",
        smokeTestChannelId: "222",
      },
      responseMode: "concise",
      access: {
        mode: "both",
        allowlistChannelIds: ["111", "222"],
        allowlistUserIds: ["user-1"],
      },
      tools: {
        mode: "allowlist",
        allowlist: ["WebSearch", "WebFetch"],
        permissionMode: "bypass",
      },
      orchestration: {
        workerIds: ["test-worker"],
        writeConfirmation: "on-ambiguity",
      },
      deterministicRouting: {
        enabled: true,
        projectScope: "test",
        additionalDomains: ["notes"],
        confidenceThreshold: 0.75,
        provider: {
          default: "claude-oauth",
          model: "router-model",
          reasoningEffort: "low",
          fallback: ["codex"],
        },
      },
    });
  });

  it("prefers explicit legacy provider over synthesized runtime provider", () => {
    const root = createTempDir("tango-v2-provider-");
    writeFile(path.join(root, "prompts", "bridge.md"), "bridge prompt");

    const legacy = v2ToLegacyAgentConfig(
      baseV2Config({
        legacyProvider: {
          default: "codex",
          model: "gpt-5",
          reasoningEffort: "medium",
          fallback: ["claude-oauth"],
        },
      }),
      { repoRoot: root },
    );

    expect(legacy.provider).toEqual({
      default: "codex",
      model: "gpt-5",
      reasoningEffort: "medium",
      fallback: ["claude-oauth"],
    });
  });

  it("synthesizes provider from v2 runtime and model when no explicit legacy provider exists", () => {
    const root = createTempDir("tango-v2-synth-provider-");
    writeFile(path.join(root, "prompts", "bridge.md"), "bridge prompt");

    const legacy = v2ToLegacyAgentConfig(
      baseV2Config({ legacyProvider: undefined }),
      { repoRoot: root },
    );

    expect(legacy.provider).toEqual({
      default: "claude-oauth",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      fallback: ["codex"],
    });
  });
});

describe("loadUnifiedAgentConfigs", () => {
  it("uses v2 configs when both legacy and v2 exist", () => {
    const root = createTempDir("tango-unified-v2-wins-");
    const defaultsDir = path.join(root, "config", "defaults");
    writeFile(
      path.join(defaultsDir, "agents", "alpha.yaml"),
      [
        "id: alpha",
        "type: legacy-type",
        "display_name: Legacy Alpha",
        "provider:",
        "  default: claude-oauth",
        "default_topic: legacy/topic",
      ].join("\n"),
    );
    writeV2Agent(root, "alpha", [
      "default_topic: v2/topic",
      "provider:",
      "  default: codex",
    ]);

    const alpha = loadUnifiedAgentConfigs(defaultsDir, { repoRoot: root }).find(
      (agent) => agent.id === "alpha",
    );

    expect(alpha).toMatchObject({
      id: "alpha",
      type: "test",
      displayName: "alpha",
      provider: {
        default: "codex",
      },
      defaultTopic: "v2/topic",
    });
  });

  it("excludes disabled v2 configs from the unified registry and does not fall back to legacy with the same id", () => {
    const root = createTempDir("tango-unified-v2-disabled-");
    const defaultsDir = path.join(root, "config", "defaults");
    writeFile(
      path.join(defaultsDir, "agents", "alpha.yaml"),
      [
        "id: alpha",
        "type: legacy-type",
        "display_name: Legacy Alpha",
        "provider:",
        "  default: claude-oauth",
      ].join("\n"),
    );
    writeFile(
      path.join(defaultsDir, "agents", "dispatch.yaml"),
      [
        "id: dispatch",
        "type: router",
        "provider:",
        "  default: claude-oauth",
      ].join("\n"),
    );
    writeV2Agent(root, "alpha", [
      "enabled: false",
    ]);

    const unifiedIds = loadUnifiedAgentConfigs(defaultsDir, { repoRoot: root })
      .map((agent) => agent.id)
      .sort();

    expect(unifiedIds).toEqual(["dispatch"]);
  });

  it("generates legacy configs for v2-only agents", () => {
    const root = createTempDir("tango-unified-v2-only-");
    const defaultsDir = path.join(root, "config", "defaults");
    writeFile(
      path.join(defaultsDir, "agents", "dispatch.yaml"),
      [
        "id: dispatch",
        "type: router",
        "provider:",
        "  default: claude-oauth",
      ].join("\n"),
    );
    writeV2Agent(root, "beta", [
      "default_topic: beta/topic",
      "default_project: beta-project",
      "response_mode: explain",
      "voice:",
      "  call_signs:",
      "    - Beta",
      "  kokoro_voice: am_adam",
      "  default_channel_id: \"123\"",
    ]);

    const beta = loadUnifiedAgentConfigs(defaultsDir, { repoRoot: root }).find(
      (agent) => agent.id === "beta",
    );

    expect(beta).toMatchObject({
      id: "beta",
      displayName: "beta",
      type: "test",
      defaultTopic: "beta/topic",
      defaultProject: "beta-project",
      responseMode: "explain",
      prompt: "beta prompt",
      promptFile: path.join(root, "prompts", "beta.md"),
      voice: {
        callSigns: ["Beta"],
        kokoroVoice: "am_adam",
        defaultChannelId: "123",
      },
      provider: {
        default: "claude-oauth",
        model: "claude-sonnet-4-6",
        reasoningEffort: "medium",
        fallback: ["codex"],
      },
    });
  });

  it("ships no dispatch agent in the current repo config", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");

    const v2Ids = [...loadAllV2AgentConfigs(path.join(repoRoot, "config", "v2", "agents")).keys()].sort();

    expect(fs.existsSync(path.join(defaultsDir, "agents", "dispatch.yaml"))).toBe(false);
    expect(v2Ids).not.toContain("dispatch");
  });

  it("loads bundled v2 configs including canonical and Ollama variants", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    const v2Dir = path.join(repoRoot, "config", "v2", "agents");
    process.env.TANGO_CONFIG_DIR = defaultsDir;

    const unifiedConfigs = loadUnifiedAgentConfigs(defaultsDir, { repoRoot });
    const v2Configs = loadAllV2AgentConfigs(v2Dir);
    const unifiedById = new Map(unifiedConfigs.map((agent) => [agent.id, agent]));

    expect([...v2Configs.keys()].sort()).toEqual(
      [
        "charlie",
        "charlie-ollama",
        "cod-e",
        "delta",
        "echo",
        "foxtrot",
        "foxtrot-ollama",
        "jules",
        "juliet",
        "juliet-ollama",
        "kilo",
        "malibu",
        "malibu-ollama",
        "mike",
        "ollama-test",
        "oscar",
        "piper",
        "sierra",
        "sierra-ollama",
        "victor",
        "victor-ollama",
        "watson",
        "watson-ollama",
      ],
    );
    const enabledV2Ids = [...v2Configs.values()]
      .filter((v2Config) => v2Config.enabled !== false)
      .map((v2Config) => v2Config.id)
      .sort();
    expect(enabledV2Ids).toEqual([
      "charlie-ollama",
      "cod-e",
      "foxtrot-ollama",
      "jules",
      "juliet-ollama",
      "malibu-ollama",
      "ollama-test",
      "piper",
      "sierra-ollama",
      "victor-ollama",
      "watson-ollama",
    ]);
    expect([...unifiedById.keys()].sort()).toEqual([
      "charlie-ollama",
      "cod-e",
      "foxtrot-ollama",
      "jules",
      "juliet-ollama",
      "malibu-ollama",
      "ollama-test",
      "piper",
      "sierra-ollama",
      "victor-ollama",
      "watson-ollama",
    ]);
  });
});
