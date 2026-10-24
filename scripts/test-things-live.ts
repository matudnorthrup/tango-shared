/** Explicitly invoked live test. Only mutates items created by this run. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GOVERNANCE_DDL, GOVERNANCE_SEED } from "../packages/core/src/governance-schema.js";
import { runThingsBridge } from "../packages/discord/src/things-bridge.js";
import { createThingsTools } from "../packages/discord/src/things-agent-tools.js";

async function main() {
const dir = await mkdtemp(join(tmpdir(), "tango-things-live-"));
const govPath = join(dir, "governance.sqlite");
const db = new DatabaseSync(govPath);
db.exec(GOVERNANCE_DDL + GOVERNANCE_SEED);
db.exec(`INSERT INTO principals(id,type,parent_id,display_name) VALUES('worker:things-smoke','worker','user:owner','Things test');
  INSERT INTO permissions(principal_id,tool_id,access_level,reason) VALUES
  ('worker:things-smoke','things_read','read','isolated test'),('worker:things-smoke','things_write','write','isolated test');`);
db.close();

async function connect(readOnly = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("packages/discord/dist/mcp-wellness-server.js")],
    env: { ...env, TANGO_DB_PATH: govPath, WORKER_ID: "things-smoke", ALLOWED_TOOL_IDS: "things_read,things_write", READ_ONLY_STEP: readOnly ? "1" : "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "things-live-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const evidence: { check: string; result: string }[] = [];
const owned: { kind: string; id: string }[] = [];
const prefix = `Tango Things test ${Date.now()}`;
let connection: Awaited<ReturnType<typeof connect>> | undefined;
let failure: unknown;
try {
  connection = await connect();
  const { client } = connection;
  const toolList = await client.listTools();
  assert.deepEqual(toolList.tools.map((t) => t.name).sort(), ["things_read", "things_write"]);
  assert.equal(toolList.tools.find((t) => t.name === "things_write")!.annotations!.readOnlyHint, false);
  evidence.push({ check: "MCP discovery and separate read/write permissions", result: "passed" });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `MCP ${name} failed`);
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text) as Record<string, any>;
  }
  const read = (args: Record<string, unknown>) => call("things_read", args);
  async function write(args: Record<string, unknown>, check: string) {
    const result = await call("things_write", args);
    if (args.operation === "create" && result.id) owned.push({ kind: String(args.kind), id: result.id });
    assert.equal(result.outcome, "verified", `${check}: ${result.outcome}`);
    evidence.push({ check, result: "passed" });
    return result;
  }
  const doctor = await read({ operation: "doctor" });
  assert.equal(doctor.automation, true);
  evidence.push({ check: `Things ${doctor.version} database and automation`, result: "passed" });
  const area = await write({ operation: "create", kind: "area", title: `${prefix} area` }, "Create area");
  const tag = await write({ operation: "create", kind: "tag", title: `${prefix} tag` }, "Create tag");
  await write({ operation: "update", kind: "area", id: area.id, tags: [`${prefix} tag`] }, "Tag area");
  await write({ operation: "update", kind: "area", id: area.id, title: `${prefix} renamed area` }, "Rename area");
  const project = await write({ operation: "create", kind: "project", title: `${prefix} project`, area_id: area.id }, "Create project in area");
  const taskTitle = `${prefix} "quotes" \\ slash\nUnicode ✓ $(literal) & value`;
  const task = await write({ operation: "create", kind: "todo", title: taskTitle, notes: "Test notes\nSecond line", project_id: project.id,
    tags: [`${prefix} tag`] }, "Create task with literal text, notes and tags");
  assert.equal((await read({ operation: "get", id: task.id })).title, taskTitle);
  const contents = await read({ operation: "list", project_id: project.id });
  assert.ok(contents.items.some((t: any) => t.id === task.id));
  for (const [patch, check] of [
    [{ when: "2026-12-20", deadline: "2026-12-22" }, "Schedule and set deadline"],
    [{ when: "today" }, "Move to Today"],
    [{ when: "someday", deadline: null }, "Move to Someday and clear deadline"],
    [{ when: "anytime", notes: "", tags: [] }, "Move to Anytime and clear notes/tags"],
    [{ area_id: area.id }, "Move task from project to area"],
    [{ project_id: project.id }, "Move task back into project"],
    [{ status: "completed" }, "Complete task"],
    [{ status: "open" }, "Reopen task"],
    [{ status: "canceled" }, "Cancel task"],
    [{ status: "open" }, "Reopen canceled task"],
  ] as const) await write({ operation: "update", kind: "todo", id: task.id, ...patch }, check);
  for (const list of ["Inbox", "Today", "Anytime", "Upcoming", "Someday", "Logbook", "Trash"]) {
    assert.ok(Array.isArray((await read({ operation: "list", list, limit: 1 })).items));
  }
  evidence.push({ check: "All seven built-in lists through MCP", result: "passed" });
  const readOnly = await connect(true);
  try {
    const denied = await readOnly.client.callTool({ name: "things_write", arguments: { operation: "update", kind: "todo", id: task.id, title: "Must never apply" } });
    assert.equal(denied.isError, true);
    assert.equal((await read({ operation: "get", id: task.id })).title, taskTitle);
    evidence.push({ check: "Read-only MCP step cannot mutate Things", result: "passed" });
  } finally { await readOnly.client.close(); }
  await write({ operation: "trash", kind: "project", id: project.id }, "Trash project and children");
  assert.equal((await read({ operation: "get", id: task.id })).trashed, true);
  evidence.push({ check: "Trashed children excluded from active search", result: "passed" });
  assert.equal((await read({ operation: "search", query: taskTitle })).total, 0);
} catch (error) { failure = error; }
finally {
  // Area/tag removal is only used here for our own test fixtures. Public tools
  // intentionally do not expose those permanent deletion operations.
  for (const item of [...owned].reverse()) {
    try {
      if (["todo", "project"].includes(item.kind)) {
        const current = await createThingsTools()[0]!.handler({ operation: "get", id: item.id }) as { trashed: boolean };
        if (current.trashed) continue;
      }
      const r = await runThingsBridge({ operation: "trash", kind: item.kind, id: item.id });
      if (r.error) throw Error("Cleanup rejected");
    } catch (error) { failure ??= error; evidence.push({ check: `Cleanup ${item.kind} ${item.id}`, result: "failed" }); }
  }
  await connection?.client.close();
  await rm(dir, { recursive: true, force: true });
}
const report = { passed: !failure, evidence, cloud_sync: "Not verified; requires observation on a second device", cleanup: "Test tasks/projects moved to Trash; test areas/tags removed", error: failure instanceof Error ? failure.message : failure ? "Test failed" : null };
const output = process.argv.indexOf("--report");
if (output !== -1) await writeFile(process.argv[output + 1]!, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failure) process.exitCode = 1;

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
