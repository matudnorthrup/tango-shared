import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { loadV2AgentConfig, type V2AgentConfig } from "../../core/src/v2-config-loader.js";
import { evaluateAgentCollaborationPolicy } from "../../core/src/agent-collaboration.js";
import { selectMcpServersForTurn } from "../../core/src/mcp-mounting.js";
import { buildV2RuntimeConfigs } from "../src/v2-runtime.js";
import { configureTodoistAgent } from "../../../scripts/lib/todoist-agent-config.mjs";

const options = { coordinator: "coordinator", isCoordinator: false };
const existingServer = { name: "research", command: "node", args: ["research.mjs"], env: { ALLOWED_TOOL_IDS: "search" } };
const existingResponsibility = {
  id: "research_support", description: "Check sources",
  collaboration: { can_request: [{ agent: "reviewer", purposes: ["source-check"] }] },
};

describe("shared Todoist agent configuration", () => {
  it("retains inherited capabilities while exposing only the two intended proxy tools", () => {
    const result = configureTodoistAgent({
      mcp_servers: [existingServer], responsibilities: [existingResponsibility],
      tools: { mode: "allowlist", allowlist: ["WebSearch"] },
    }, { runtime: { model: "example-model" } }, options);

    expect(result.runtime).toEqual({ model: "example-model" });
    expect(result.mcp_servers).toHaveLength(3);
    expect(result.mcp_servers[0]).toEqual(existingServer);
    for (const [name, tool] of [["todoist", "todoist"], ["collaboration", "collaborate_with_agent"]]) {
      expect(result.mcp_servers.find((server: { name: string }) => server.name === name)).toMatchObject({
        command: "node", args: ["packages/core/dist/mcp-proxy.js", name], env: { ALLOWED_TOOL_IDS: tool },
      });
    }
    expect(result.responsibilities[0]).toEqual(existingResponsibility);
    expect(result.tools).toEqual({ mode: "allowlist", allowlist: ["WebSearch", "mcp__todoist__todoist", "mcp__collaboration__collaborate_with_agent"] });
  });

  it("honors explicit overlay lists, including empty lists, instead of resurrecting removed base capabilities", () => {
    const result = configureTodoistAgent({
      mcp_servers: [existingServer], responsibilities: [existingResponsibility],
      tools: { mode: "allowlist", allowlist: ["WebSearch"] },
    }, { mcp_servers: [], responsibilities: [], tools: { allowlist: [] } }, options);
    expect(result.mcp_servers.map((server: { name: string }) => server.name)).toEqual(["todoist", "collaboration"]);
    expect(result.responsibilities.map((responsibility: { id: string }) => responsibility.id)).toEqual(["todoist_tasks"]);
    expect(result.tools.allowlist).toEqual(["mcp__todoist__todoist", "mcp__collaboration__collaborate_with_agent"]);
  });

  it("routes specialist planning to the selected coordinator without enabling fulfillment", () => {
    const result = configureTodoistAgent({}, {}, options);
    const responsibility = result.responsibilities.find((entry: { id: string }) => entry.id === "todoist_tasks");
    expect(responsibility.description).toEqual(expect.any(String));
    expect(responsibility.collaboration.can_request).toEqual([{ agent: "coordinator", purposes: ["task-planning"] }]);
    expect(responsibility.collaboration.can_fulfill ?? []).toEqual([]);
  });

  it("gives the coordinator bounded planning fulfillment without a self-request route", () => {
    const result = configureTodoistAgent({}, {}, { ...options, isCoordinator: true });
    const responsibility = result.responsibilities.find((entry: { id: string }) => entry.id === "todoist_tasks");
    expect(responsibility.collaboration.can_request ?? []).toEqual([]);
    expect(responsibility.collaboration.can_fulfill).toEqual([{
      purpose: "task-planning", max_turns: 1, max_duration_seconds: 120, max_tool_calls: 6,
      visibility_modes: ["summary", "digest", "silent"],
    }]);
  });

  it.each(["default", "off"])("preserves effective tools mode %s", (mode) => {
    const tools = { mode, allowlist: ["ExistingTool"] };
    expect(configureTodoistAgent({ tools }, {}, options).tools ?? tools).toEqual(tools);
    expect(configureTodoistAgent({ tools: { mode: "allowlist" } }, { tools }, options).tools).toEqual(tools);
  });

  it("does not mutate either input and can be safely reapplied", () => {
    const base = { mcp_servers: [existingServer], responsibilities: [existingResponsibility], tools: { mode: "allowlist", allowlist: ["WebSearch"] } };
    const override = { runtime: { timeout_seconds: 180 }, tools: { allowlist: ["WebFetch"] } };
    const before = structuredClone({ base, override });
    const result = configureTodoistAgent(base, override, options);
    expect({ base, override }).toEqual(before);
    expect(result).not.toBe(override);
    expect(configureTodoistAgent(base, result, options)).toEqual(result);
  });

  it("preserves existing server settings and avoids duplicating preconfigured tools", () => {
    const server = { name: "todoist", command: "node", args: ["custom-proxy.mjs"], env: { ALLOWED_TOOL_IDS: "todoist", WORKER_ID: "specialist" } };
    const result = configureTodoistAgent({}, {
      mcp_servers: [server],
      tools: { mode: "allowlist", allowlist: ["mcp__todoist__todoist", "WebSearch", "mcp__collaboration__collaborate_with_agent"] },
    }, options);
    expect(result.mcp_servers.filter((entry: { name: string }) => entry.name === "todoist")).toEqual([server]);
    expect(result.tools.allowlist).toEqual(["mcp__todoist__todoist", "WebSearch", "mcp__collaboration__collaborate_with_agent"]);
  });

  it.each(["todoist", "collaboration"])("refuses to widen an existing restrictive %s server", (name) => {
    const override = { mcp_servers: [{ name, command: "node", args: ["custom-proxy.mjs"], env: { ALLOWED_TOOL_IDS: "other_tool" } }] };
    const before = structuredClone(override);
    expect(() => configureTodoistAgent({}, override, options)).toThrow(/excludes/);
    expect(override).toEqual(before);
  });

  it("refuses to replace an operator-defined responsibility with the same ID", () => {
    const override = { responsibilities: [{ id: "todoist_tasks", description: "Read-only task support", autonomy: { default: "manual" } }] };
    const before = structuredClone(override);
    expect(() => configureTodoistAgent({}, override, options)).toThrow(/responsibility differs/);
    expect(override).toEqual(before);
  });

  it.each(["", "*", "agent:coordinator", "coordinator,other"])("rejects nonconcrete coordinator %j", (coordinator) => {
    expect(() => configureTodoistAgent({}, {}, { coordinator })).toThrow(/coordinator/);
  });

  it("preserves selective mount policy while making task tools available on ordinary turns", () => {
    const base = { mcp: { default_servers: ["memory", "todoist"], available_servers: ["research", "collaboration"] } };
    const before = structuredClone(base);
    const result = configureTodoistAgent(base, {}, options);
    expect(result.mcp).toEqual({ default_servers: ["memory", "todoist", "collaboration"], available_servers: ["research", "collaboration"] });
    expect(base).toEqual(before);
    expect(configureTodoistAgent(base, result, options)).toEqual(result);
  });

  it("merges each overlay mount field over the base, including explicit empty defaults", () => {
    const base = { mcp: { default_servers: ["memory"], available_servers: ["research"] } };
    expect(configureTodoistAgent(base, { mcp: { default_servers: [] } }, options).mcp).toEqual({
      default_servers: ["todoist", "collaboration"], available_servers: ["research"],
    });
    expect(configureTodoistAgent(base, { mcp: { available_servers: ["attachments"] } }, options).mcp).toEqual({
      default_servers: ["memory", "todoist", "collaboration"], available_servers: ["attachments"],
    });
  });

  it("adds task defaults to an available-only mount policy", () => {
    expect(configureTodoistAgent({ mcp: { available_servers: ["research"] } }, {}, options).mcp).toEqual({
      default_servers: ["todoist", "collaboration"], available_servers: ["research"],
    });
  });

  it("does not introduce selective mounting when all configured servers already load", () => {
    const result = configureTodoistAgent({ mcp_servers: [existingServer] }, {}, options);
    expect(result).not.toHaveProperty("mcp");
    const emptyPolicy = configureTodoistAgent({ mcp_servers: [existingServer] }, { mcp: {} }, options);
    expect(emptyPolicy.mcp).toEqual({});
  });
});

describe("shared Todoist routes through the runtime configuration and policy", () => {
  let configs: Map<string, V2AgentConfig>;
  const request = { requesterAgentId: "specialist", targetAgentId: "coordinator", purpose: "task-planning", objective: "Plan the requested task across domains." };

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "todoist-collaboration-"));
    try {
      configs = new Map(["specialist", "coordinator", "unrelated"].map((id) => {
        const base = {
          id, enabled: true, display_name: id, type: "test", system_prompt_file: "test/soul.md",
          mcp_servers: [existingServer],
          runtime: { mode: "persistent", provider: "claude-code-v2", model: "test-model", reasoning_effort: "medium", idle_timeout_hours: 24, context_reset_threshold: 0.8 },
          memory: { post_turn_extraction: "disabled", extraction_model: "test-model", importance_threshold: 0.4, scheduled_reflection: "disabled" },
          discord: { default_channel_id: "100000000000000000" },
          tools: { mode: "allowlist", allowlist: ["WebSearch"] },
          ...(id === "specialist" ? { mcp: { default_servers: ["research"], available_servers: ["todoist", "collaboration"] } } : {}),
        };
        const overlay = id === "unrelated" ? {} : configureTodoistAgent(base, {}, { ...options, isCoordinator: id === "coordinator" });
        const configFile = join(dir, `${id}.yaml`);
        writeFileSync(configFile, dump({ ...base, ...overlay }));
        return [id, loadV2AgentConfig(configFile)];
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["summary", "digest", "silent"] as const)("allows configured planning with %s visibility and bounded defaults", (visibility) => {
    expect(evaluateAgentCollaborationPolicy({ ...request, visibility }, configs)).toMatchObject({
      granted: true, reason: "granted", visibilityMode: visibility,
      requesterResponsibilityId: "todoist_tasks", targetResponsibilityId: "todoist_tasks",
      effectiveBudget: { maxTurns: 1, maxDurationSeconds: 120, maxToolCalls: 6 },
    });
  });

  it("denies a configured agent that was not given the request route", () => {
    expect(evaluateAgentCollaborationPolicy({ ...request, requesterAgentId: "unrelated" }, configs)).toMatchObject({ granted: false, reason: "requester_not_allowed" });
  });

  it("denies an unconfigured requester and an unexpected collaboration purpose", () => {
    expect(evaluateAgentCollaborationPolicy({ ...request, requesterAgentId: "missing" }, configs)).toMatchObject({ granted: false, reason: "requester_not_configured" });
    expect(evaluateAgentCollaborationPolicy({ ...request, purpose: "account-administration" }, configs)).toMatchObject({ granted: false, reason: "requester_not_allowed" });
  });

  it.each([{ maxTurns: 2 }, { maxDurationSeconds: 121 }, { maxToolCalls: 7 }])("denies budget escalation %j", (budget) => {
    expect(evaluateAgentCollaborationPolicy({ ...request, budget }, configs)).toMatchObject({ granted: false, reason: expect.stringContaining("budget_exceeded:") });
  });

  it.each(["thread", "transcript"] as const)("denies unconfigured %s visibility", (visibility) => {
    expect(evaluateAgentCollaborationPolicy({ ...request, visibility }, configs)).toMatchObject({ granted: false, reason: "visibility_mode_not_allowed" });
  });

  it.each(["specialist", "coordinator"])("mounts direct task and planning tools on ordinary %s turns without narrowing existing defaults", (agentId) => {
    const dir = mkdtempSync(join(tmpdir(), "todoist-runtime-"));
    try {
      const soulFile = join(dir, "soul.md");
      writeFileSync(soulFile, "You are a test agent.");
      const config = { ...configs.get(agentId)!, systemPromptFile: soulFile };
      const runtime = buildV2RuntimeConfigs(new Map([[agentId, config]]), { repoRoot: dir }).get(agentId)!;
      const selected = selectMcpServersForTurn(runtime, { message: "Help me decide what to do next" });
      expect(selected.config.mcpServers.map(server => server.name)).toEqual(expect.arrayContaining(["research", "todoist", "collaboration"]));
      expect(selected.selection.defaultServerNames).toEqual(expect.arrayContaining(["research", "todoist", "collaboration"]));
      expect(selected.selection.activatedServerNames).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
