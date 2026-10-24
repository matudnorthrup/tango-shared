import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GovernanceChecker } from "../../core/src/governance.js";
import { GOVERNANCE_DDL } from "../../core/src/governance-schema.js";
import { createTodoistTools, todoistOperationLooksReadOnly } from "../src/todoist-agent-tools.js";
import { buildMcpListedTool } from "../src/mcp-tool-metadata.js";
import { getListedToolAccessLevel } from "../src/mcp-tool-visibility.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const grantScript = join(root, "scripts/grant-todoist.mjs");
const taskPrincipals = [
  "worker:personal-assistant", "worker:watson-ollama",
];
let fixtureDir: string;
let dbFile: string;
let db: DatabaseSync;

function addPrincipal(id: string, parent: string | null = null) {
  db.prepare("INSERT INTO principals (id, type, parent_id) VALUES (?, ?, ?)").run(id, id.split(":")[0]!, parent);
}

function applyGrants(workers?: string, withPlanning = false) {
  const args = [grantScript, "--db", dbFile, ...(workers === undefined ? [] : ["--workers", workers]), ...(withPlanning ? ["--with-planning"] : [])];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", cwd: root }));
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "todoist-wiring-"));
  dbFile = join(fixtureDir, "governance.sqlite");
  db = new DatabaseSync(dbFile);
  db.exec(GOVERNANCE_DDL);
});

afterEach(() => {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("Todoist grant installation", () => {
  it("grants known existing task principals and leaves unrelated principals and tools alone", () => {
    for (const id of [...taskPrincipals, "agent:watson", "agent:watson-ollama", "agent:piper", "agent:unrelated", "worker:unrelated", "worker:piper", "worker:task-keeper", "worker:kilo", "worker:jules", "worker:cod-e", "worker:ollama-test", "user:example"]) addPrincipal(id);
    db.prepare("INSERT INTO governance_tools (id, access_type) VALUES ('existing-tool', 'read')").run();
    db.prepare("INSERT INTO permissions (principal_id, tool_id, access_level, reason) VALUES ('agent:unrelated', 'existing-tool', 'read', 'original')").run();
    const originalPrincipals = db.prepare("SELECT * FROM principals ORDER BY id").all();
    const originalPermission = db.prepare("SELECT * FROM permissions WHERE tool_id = 'existing-tool'").all();

    const granted = applyGrants() as Array<{ principal_id: string; access_level: string }>;
    expect(granted.map(row => row.principal_id).sort()).toEqual([...taskPrincipals].sort());
    expect(granted.every(row => row.access_level === "write")).toBe(true);
    expect(db.prepare("SELECT * FROM principals ORDER BY id").all()).toEqual(originalPrincipals);
    expect(db.prepare("SELECT * FROM permissions WHERE tool_id = 'existing-tool'").all()).toEqual(originalPermission);
    expect(db.prepare("SELECT id, access_type FROM governance_tools WHERE id = 'todoist'").get()).toEqual({ id: "todoist", access_type: "write" });

    const governance = new GovernanceChecker(db);
    expect(governance.hasPermission("worker:personal-assistant", "todoist", "write")).toBe(true);
    expect(governance.hasPermission("agent:unrelated", "todoist", "read")).toBe(false);
    expect(governance.hasPermission("user:example", "todoist", "read")).toBe(false);
    for (const id of ["worker:piper", "worker:task-keeper", "worker:kilo", "worker:jules", "worker:cod-e", "worker:ollama-test"]) {
      expect(governance.hasPermission(id, "todoist", "read")).toBe(false);
    }
  });

  it("does not fabricate missing principals or grant similarly named principals", () => {
    for (const id of ["worker:watson-ollama", "agent:watson-ollama", "agent:watson-ollama-test", "worker:personal-assistant-test", "agent:watson-other"]) addPrincipal(id);
    const before = db.prepare("SELECT * FROM principals ORDER BY id").all();
    expect(applyGrants()).toEqual([{ principal_id: "worker:watson-ollama", access_level: "write" }]);
    expect(db.prepare("SELECT * FROM principals ORDER BY id").all()).toEqual(before);
  });

  it("preserves worker read-only and deny grants without adding parent grants that bypass them", () => {
    addPrincipal("agent:watson");
    addPrincipal("worker:personal-assistant", "agent:watson");
    addPrincipal("agent:piper");
    addPrincipal("worker:task-keeper", "agent:piper");
    db.prepare("INSERT INTO governance_tools (id, access_type) VALUES ('todoist', 'write')").run();
    const insert = db.prepare("INSERT INTO permissions (principal_id, tool_id, access_level, reason) VALUES (?, 'todoist', ?, 'operator policy')");
    insert.run("worker:personal-assistant", "none");
    insert.run("worker:task-keeper", "read");
    const original = db.prepare("SELECT * FROM permissions ORDER BY id").all();

    applyGrants("worker:personal-assistant,worker:task-keeper");
    expect(db.prepare("SELECT * FROM permissions WHERE reason = 'operator policy' ORDER BY id").all()).toEqual(original);
    const governance = new GovernanceChecker(db);
    expect(governance.hasPermission("agent:watson", "todoist", "write")).toBe(false);
    expect(governance.hasPermission("agent:piper", "todoist", "write")).toBe(false);
    expect(governance.hasPermission("worker:personal-assistant", "todoist", "read")).toBe(false);
    expect(governance.hasPermission("worker:task-keeper", "todoist", "read")).toBe(true);
    expect(governance.hasPermission("worker:task-keeper", "todoist", "write")).toBe(false);
    expect(getListedToolAccessLevel(governance, "worker:personal-assistant", "todoist")).toBeNull();
    expect(getListedToolAccessLevel(governance, "worker:task-keeper", "todoist")).toBe("read");
    for (const operation of ["list_tasks", "get_task", "create_task", "complete_task", "unknown"]) {
      const access = todoistOperationLooksReadOnly(operation) ? "read" : "write";
      expect(governance.hasPermission("worker:task-keeper", "todoist", access)).toBe(["list_tasks", "get_task"].includes(operation));
    }
  });

  it("is idempotent without replacing permission IDs or metadata", () => {
    for (const id of taskPrincipals) addPrincipal(id);
    applyGrants();
    const permissions = db.prepare("SELECT * FROM permissions ORDER BY id").all();
    const tools = db.prepare("SELECT * FROM governance_tools ORDER BY id").all();
    applyGrants();
    expect(db.prepare("SELECT * FROM permissions ORDER BY id").all()).toEqual(permissions);
    expect(db.prepare("SELECT * FROM governance_tools ORDER BY id").all()).toEqual(tools);
  });

  it("requires an explicit existing database instead of creating an accidental database", () => {
    const missingFile = join(fixtureDir, "missing.sqlite");
    const missingArg = spawnSync(process.execPath, [grantScript], { cwd: fixtureDir, encoding: "utf8" });
    expect(missingArg.status).not.toBe(0);
    expect(missingArg.stderr).toContain("--db");
    const missingDb = spawnSync(process.execPath, [grantScript, "--db", missingFile], { cwd: fixtureDir, encoding: "utf8" });
    expect(missingDb.status).not.toBe(0);
    expect(existsSync(missingFile)).toBe(false);
  });

  it("grants only explicitly selected workers, without expanding to default workers or parent agents", () => {
    for (const id of ["agent:specialist", "worker:specialist", "worker:specialist-test", ...taskPrincipals]) addPrincipal(id);
    const before = db.prepare("SELECT * FROM principals ORDER BY id").all();
    expect(applyGrants("worker:specialist,worker:specialist-test")).toEqual([
      { principal_id: "worker:specialist", access_level: "write" },
      { principal_id: "worker:specialist-test", access_level: "write" },
    ]);
    expect(db.prepare("SELECT * FROM principals ORDER BY id").all()).toEqual(before);
    const governance = new GovernanceChecker(db);
    expect(governance.hasPermission("agent:specialist", "todoist", "read")).toBe(false);
    expect(governance.hasPermission("worker:personal-assistant", "todoist", "read")).toBe(false);
  });

  it("keeps explicitly selected worker denials and read grants intact on repeated installation", () => {
    for (const id of ["worker:limited", "worker:denied", "worker:specialist"]) addPrincipal(id);
    db.prepare("INSERT INTO governance_tools (id, access_type) VALUES ('todoist', 'write')").run();
    const insert = db.prepare("INSERT INTO permissions (principal_id, tool_id, access_level, reason) VALUES (?, 'todoist', ?, 'operator policy')");
    insert.run("worker:limited", "read");
    insert.run("worker:denied", "none");
    const original = db.prepare("SELECT * FROM permissions ORDER BY id").all();
    const workers = "worker:limited,worker:denied,worker:specialist";
    applyGrants(workers);
    const installed = db.prepare("SELECT * FROM permissions ORDER BY id").all();
    applyGrants(workers);
    expect(db.prepare("SELECT * FROM permissions ORDER BY id").all()).toEqual(installed);
    expect(db.prepare("SELECT * FROM permissions WHERE reason = 'operator policy' ORDER BY id").all()).toEqual(original);
    const governance = new GovernanceChecker(db);
    expect(governance.hasPermission("worker:limited", "todoist", "read")).toBe(true);
    expect(governance.hasPermission("worker:limited", "todoist", "write")).toBe(false);
    expect(governance.hasPermission("worker:denied", "todoist", "read")).toBe(false);
    expect(governance.hasPermission("worker:specialist", "todoist", "write")).toBe(true);
  });

  it("preflights the whole explicit selection before installing any grants or tool metadata", () => {
    addPrincipal("worker:specialist");
    const result = spawnSync(process.execPath, [grantScript, "--db", dbFile, "--workers", "worker:specialist,worker:missing"], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("worker:missing");
    expect(db.prepare("SELECT * FROM permissions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM governance_tools").all()).toEqual([]);
  });

  it.each(["*", "worker:*", "agent:specialist", "user:example", "specialist", "worker:specialist,agent:specialist", ""])("rejects unsafe explicit worker selection %j without writes", (workers) => {
    for (const id of ["worker:specialist", "agent:specialist", "user:example"]) addPrincipal(id);
    const result = spawnSync(process.execPath, [grantScript, "--db", dbFile, "--workers", workers], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(db.prepare("SELECT * FROM permissions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM governance_tools").all()).toEqual([]);
  });

  it("grants planning only to explicitly selected workers and preserves existing restrictions", () => {
    for (const id of ["agent:specialist", "worker:specialist", "worker:limited", "worker:denied", "worker:unselected", ...taskPrincipals]) addPrincipal(id);
    db.prepare("INSERT INTO governance_tools (id, access_type) VALUES ('collaborate_with_agent', 'write')").run();
    const insert = db.prepare("INSERT INTO permissions (principal_id, tool_id, access_level, reason) VALUES (?, 'collaborate_with_agent', ?, 'operator policy')");
    insert.run("worker:limited", "read");
    insert.run("worker:denied", "none");
    const before = db.prepare("SELECT * FROM permissions ORDER BY id").all();
    const selected = "worker:specialist,worker:limited,worker:denied";
    applyGrants(selected, true);
    const installed = db.prepare("SELECT * FROM permissions ORDER BY id").all();
    applyGrants(selected, true);
    expect(db.prepare("SELECT * FROM permissions ORDER BY id").all()).toEqual(installed);
    expect(db.prepare("SELECT * FROM permissions WHERE reason = 'operator policy' ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT principal_id, access_level FROM permissions WHERE tool_id = 'collaborate_with_agent' ORDER BY principal_id").all()).toEqual([
      { principal_id: "worker:denied", access_level: "none" },
      { principal_id: "worker:limited", access_level: "read" },
      { principal_id: "worker:specialist", access_level: "write" },
    ]);
  });

  it("adds no collaboration grants unless planning is explicitly requested", () => {
    for (const id of [...taskPrincipals, "worker:specialist"]) addPrincipal(id);
    db.prepare("INSERT INTO governance_tools (id, access_type) VALUES ('collaborate_with_agent', 'write')").run();
    applyGrants();
    applyGrants("worker:specialist");
    expect(db.prepare("SELECT * FROM permissions WHERE tool_id = 'collaborate_with_agent'").all()).toEqual([]);
  });

  it("rejects planning without an explicit worker list before installing any permissions", () => {
    for (const id of taskPrincipals) addPrincipal(id);
    db.prepare("INSERT INTO governance_tools (id, access_type) VALUES ('collaborate_with_agent', 'write')").run();
    const before = db.prepare("SELECT * FROM governance_tools").all();
    const result = spawnSync(process.execPath, [grantScript, "--db", dbFile, "--with-planning"], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--workers");
    expect(db.prepare("SELECT * FROM permissions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM governance_tools").all()).toEqual(before);
  });

  it("preflights collaboration tool registration before installing Todoist or planning grants", () => {
    addPrincipal("worker:specialist");
    const result = spawnSync(process.execPath, [grantScript, "--db", dbFile, "--workers", "worker:specialist", "--with-planning"], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("collaborate_with_agent");
    expect(db.prepare("SELECT * FROM permissions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM governance_tools").all()).toEqual([]);
  });
});

describe("Todoist agent exposure", () => {
  it.each(["watson", "watson-ollama"])("exposes only the Todoist tools through the %s Todoist server", (agent) => {
    const config = load(readFileSync(join(root, "config/v2/agents", `${agent}.yaml`), "utf8")) as {
      mcp_servers: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>;
    };
    const servers = config.mcp_servers.filter(server => server.name === "todoist");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      command: "node", args: ["packages/core/dist/mcp-proxy.js", "todoist"],
      env: { ALLOWED_TOOL_IDS: "todoist,todoist_manage" },
    });
    expect(servers[0]!.env).not.toHaveProperty("TODOIST_API_TOKEN");
  });

  it.each(["piper", "kilo", "jules", "cod-e", "ollama-test"])("does not expose personal Todoist in the %s template", (agent) => {
    const config = load(readFileSync(join(root, "config/v2/agents", `${agent}.yaml`), "utf8")) as {
      mcp_servers: Array<{ name: string; args?: string[]; env?: Record<string, string> }>;
      tools?: { allowlist?: string[] };
    };
    expect(config.mcp_servers.some(server => server.name === "todoist" || server.args?.includes("todoist") || server.env?.ALLOWED_TOOL_IDS?.split(",").includes("todoist"))).toBe(false);
    expect(config.tools?.allowlist ?? []).not.toContain("mcp__todoist__todoist");
  });

  it("advertises Todoist as an external mutable tool, with read-only annotations for read grants", () => {
    const tool = createTodoistTools()[0]!;
    expect(buildMcpListedTool(tool, null, "write").annotations).toMatchObject({
      openWorldHint: true, readOnlyHint: false, destructiveHint: false, idempotentHint: false,
    });
    expect(buildMcpListedTool(tool, null, "read").annotations).toMatchObject({
      openWorldHint: true, readOnlyHint: true, destructiveHint: false,
    });
  });
});
