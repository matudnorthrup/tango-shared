import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  ISOLATED_AGENT_SAFE_TOOL_IDS,
  loadV2AgentConfig,
} from "../src/v2-config-loader.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function loadRepoAgentRaw(agentId: string): Record<string, unknown> {
  return yaml.load(
    fs.readFileSync(path.join(repoRoot, "config", "v2", "agents", `${agentId}.yaml`), "utf8"),
  ) as Record<string, unknown>;
}

function loadVariant(raw: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-isolated-"));
  tempDirs.push(dir);
  const file = path.join(dir, "agent.yaml");
  fs.writeFileSync(file, yaml.dump(raw));
  return loadV2AgentConfig(file);
}

describe("isolated agents", () => {
  it.each(["echo", "delta", "oscar", "mike", "kilo"])("ships %s as isolated with only safe tools", (agentId) => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", `${agentId}.yaml`));
    expect(config.isolated).toBe(true);
    expect(config.runtime.fallback).not.toBe("codex");
    expect(config.legacyProvider?.fallback ?? []).not.toContain("codex");
    const toolIds = config.mcpServers.flatMap((server) => server.env?.ALLOWED_TOOL_IDS?.split(",") ?? []);
    for (const toolId of toolIds) {
      expect(ISOLATED_AGENT_SAFE_TOOL_IDS.has(toolId.trim())).toBe(true);
    }
  });

  it("gives every youth assistant the safety alert tool and the youth rules", () => {
    for (const agentId of ["echo", "delta", "oscar", "mike"]) {
      const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", `${agentId}.yaml`));
      const toolIds = config.mcpServers.flatMap((server) => server.env?.ALLOWED_TOOL_IDS?.split(",") ?? []);
      expect(toolIds).toContain("safety_alert");
      const rules = fs.readFileSync(path.join(repoRoot, "agents", "assistants", agentId, "RULES.md"), "utf8");
      expect(rules).toContain("safety_alert");
      expect(rules).toContain("You do not have the owner's world");
    }
  });

  it("does not change non-isolated agents", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "sierra.yaml"));
    expect(config.isolated).toBeUndefined();
  });

  it("rejects an owner tool on an isolated agent", () => {
    const raw = loadRepoAgentRaw("echo");
    raw.mcp_servers = [
      {
        name: "google",
        command: "node",
        args: ["packages/core/dist/mcp-proxy.js", "google"],
        env: { ALLOWED_TOOL_IDS: "gog_email" },
      },
    ];
    expect(() => loadVariant(raw)).toThrow(/may not use tool\(s\) gog_email/u);
  });

  it("rejects a proxy server without an explicit tool allowlist", () => {
    const raw = loadRepoAgentRaw("echo");
    raw.mcp_servers = [{ name: "everything", command: "node", args: ["packages/core/dist/mcp-proxy.js", "x"] }];
    expect(() => loadVariant(raw)).toThrow(/must set ALLOWED_TOOL_IDS/u);
  });

  it("rejects arbitrary command and remote MCP servers", () => {
    const raw = loadRepoAgentRaw("echo");
    raw.mcp_servers = [{ name: "shell", command: "bash", args: ["-c", "cat ~/.env"] }];
    expect(() => loadVariant(raw)).toThrow(/may not mount MCP server 'shell'/u);

    raw.mcp_servers = [{ name: "remote", url: "https://example.com/mcp" }];
    expect(() => loadVariant(raw)).toThrow(/may not mount remote MCP server/u);
  });

  it("rejects codex fallback, built-in tools, memory aliases, and owner routing", () => {
    const base = loadRepoAgentRaw("oscar");

    expect(() => loadVariant({ ...base, runtime: { ...(base.runtime as object), fallback: "codex" } }))
      .toThrow(/may not fall back to codex/u);
    expect(() => loadVariant({ ...base, provider: { default: "claude-oauth", fallback: ["codex"] } }))
      .toThrow(/may not fall back to codex/u);
    expect(() => loadVariant({ ...base, tools: { mode: "default" } }))
      .toThrow(/must use tools.mode: off/u);
    expect(() => loadVariant({ ...base, memory: { ...(base.memory as object), alias_agent_ids: ["juliet"] } }))
      .toThrow(/may not alias/u);
    expect(() => loadVariant({ ...base, deterministic_routing: { enabled: true } }))
      .toThrow(/deterministic_routing/u);
    expect(() => loadVariant({ ...base, orchestration: { worker_ids: ["nutrition-logger"] } }))
      .toThrow(/orchestrate/u);
  });
});
