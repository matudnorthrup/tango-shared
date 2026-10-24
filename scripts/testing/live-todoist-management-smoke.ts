/** Live management lifecycle using only random, harness-owned Todoist fixtures.
 * Requires explicit scratch-delete authorization. Never changes existing filters,
 * view preferences, projects, labels, comments, or tasks. Evidence omits resource
 * payloads, account data, credentials, and resource identifiers.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTodoistTools } from "../../packages/discord/src/todoist-agent-tools.js";

dotenv.config({ quiet: true });
type Result = Record<string, unknown>;
type ToolName = "todoist" | "todoist_manage";
type Kind = "destination_project" | "filter" | "project" | "section" | "label" | "task" | "comment";
type Fixture = { id: string; field: "name" | "content"; marker: string; deleted: boolean };
const checks: { name: string; ok: boolean }[] = [];
const fixtures = new Map<Kind, Fixture>();
const handlers = new Map<ToolName, (input: Result) => Promise<unknown>>();
const mcp = process.argv.includes("--mcp");
const marker = `Tango management smoke ${randomUUID()}`;
let client: Client | undefined;
let stage = "require --allow-scratch-delete before live access";
let failed = false;
let viewMayExist = false;
let projectMayBeArchived = false;
let unverifiedCreateOutcome = false;

async function call(tool: ToolName, input: Result): Promise<Result> {
  let value: unknown;
  if (client) {
    const response = await client.callTool({ name: tool, arguments: input });
    assert(!response.isError, "MCP rejected call");
    const content = response.content as { type: string; text?: string }[];
    value = JSON.parse(content.find(c => c.type === "text")?.text ?? "null");
  } else {
    const handler = handlers.get(tool);
    assert(handler, "Missing handler");
    value = await handler(input);
  }
  assert(value && typeof value === "object" && !Array.isArray(value), "Missing response");
  return value as Result;
}
async function invoke(input: Result, tool: ToolName = "todoist_manage"): Promise<Result> {
  if (typeof input.operation === "string" && input.operation.startsWith("create_")) unverifiedCreateOutcome = true;
  const result = await call(tool, input);
  assert(!result.error, "Operation failed");
  return result;
}
async function check(name: string, action: () => Promise<void>): Promise<void> {
  stage = name;
  await action();
  checks.push({ name, ok: true });
}
function rows(result: Result): Result[] {
  assert(Array.isArray(result.results), "Missing result list");
  return result.results as Result[];
}
function own(kind: Kind): Fixture {
  const fixture = fixtures.get(kind);
  assert(fixture && !fixture.deleted, "Missing owned fixture");
  return fixture;
}
function remember(kind: Kind, result: Result, field: "name" | "content", expected: string): void {
  assert.equal(typeof result.id, "string");
  assert.equal(result[field], expected);
  fixtures.set(kind, { id: result.id as string, field, marker: expected, deleted: false });
  unverifiedCreateOutcome = false;
}
function isOwned(fixture: Fixture, result: Result): void {
  assert.equal(result.id, fixture.id);
  assert(typeof result[fixture.field] === "string" && (result[fixture.field] as string).startsWith(fixture.marker), "Ownership mismatch");
}
function apiKind(kind: Kind): string { return kind === "destination_project" ? "project" : kind; }
async function readOwned(kind: Kind): Promise<Result> {
  const fixture = own(kind);
  const result = await invoke({ operation: `get_${apiKind(kind)}`, [`${apiKind(kind)}_id`]: fixture.id }, kind === "task" ? "todoist" : "todoist_manage");
  isOwned(fixture, result);
  return result;
}
async function deleteOwned(kind: Kind): Promise<void> {
  const fixture = own(kind);
  const current = await readOwned(kind);
  if (kind === "project" || kind === "destination_project" || kind === "section") {
    // Deleting containers can cascade. Refuse if anything remains in the scratch
    // project; successful task/comment cleanup happens before container cleanup.
    const result = await invoke({ operation: "list_tasks", project_id: kind === "section" ? current.project_id : fixture.id }, "todoist");
    assert.equal(rows(result).length, 0, "Scratch project is not empty");
    assert.equal(result.next_cursor, null, "Scratch project has more tasks");
  }
  const result = await invoke({ operation: `delete_${apiKind(kind)}`, [`${apiKind(kind)}_id`]: fixture.id });
  assert.equal(result.success, true);
  if (kind === "filter") {
    const listed = rows(await invoke({ operation: "list_filters" }));
    assert(!listed.some(item => item.id === fixture.id), "Deleted filter remains listed");
  } else {
    const missing = await call(kind === "task" ? "todoist" : "todoist_manage", { operation: `get_${apiKind(kind)}`, [`${apiKind(kind)}_id`]: fixture.id });
    // Todoist retains deleted task, comment, and section tombstones. A matching
    // tombstone proves deletion; an active object or generic failure does not.
    const absent = !!missing.error && (missing.status === 404 || missing.status === 410);
    const tombstone = !missing.error && missing.id === fixture.id && missing.is_deleted === true;
    assert(absent || tombstone, "Deletion not verified");
  }
  fixture.deleted = true;
}
async function resetOwnedView(): Promise<void> {
  await readOwned("filter");
  const filterId = own("filter").id;
  assert.equal((await invoke({ operation: "reset_view_options", view_type: "filter", object_id: filterId })).success, true);
  assert.equal(rows(await invoke({ operation: "list_view_options", view_type: "filter", object_id: filterId })).length, 0);
  viewMayExist = false;
}

async function main(): Promise<void> {
  try {
    assert(process.argv.includes("--allow-scratch-delete"), "Live management smoke requires --allow-scratch-delete");
    checks.push({ name: stage, ok: true });
    if (mcp) {
      await check("MCP exposes only task and management tools to explicit worker", async () => {
        assert(process.env.WORKER_ID?.trim(), "--mcp requires explicit WORKER_ID");
        client = new Client({ name: "todoist-management-live-smoke", version: "1.0.0" });
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        await client.connect(new StdioClientTransport({ command: process.execPath, args: ["packages/core/dist/mcp-proxy.js", "todoist_manage"], env: { ...env, ALLOWED_TOOL_IDS: "todoist,todoist_manage" }, stderr: "ignore" }));
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["todoist", "todoist_manage"]);
      });
    } else {
      stage = "initialize management and task handlers";
      const { createTodoistManagementTools } = await import("../../packages/discord/src/todoist-management-tools.js");
      handlers.set("todoist", createTodoistTools()[0]!.handler);
      handlers.set("todoist_manage", createTodoistManagementTools()[0]!.handler);
    }
    await check("create owned scratch filter", async () => {
      const name = `${marker} filter`;
      remember("filter", await invoke({ operation: "create_filter", name, query: `search: ${marker}`, is_favorite: false }), "name", name);
    });
    await check("read and list scratch filter", async () => {
      assert.equal((await readOwned("filter")).query, `search: ${marker}`);
      assert(rows(await invoke({ operation: "list_filters" })).some(filter => filter.id === own("filter").id));
    });
    await check("update scratch filter and verify combined due query", async () => {
      const query = `(search: ${marker}) & due before: tomorrow`;
      await invoke({ operation: "update_filter", filter_id: own("filter").id, name: `${own("filter").marker} updated`, query });
      const updated = await readOwned("filter");
      assert.equal(updated.query, query);
      assert.equal(updated.name, `${own("filter").marker} updated`);
    });
    await check("set grouping on scratch filter only", async () => {
      viewMayExist = true;
      const result = await invoke({ operation: "set_view_options", view_type: "filter", object_id: own("filter").id, grouped_by: "due_date" });
      assert.equal(result.grouped_by, "due_date");
      const listed = rows(await invoke({ operation: "list_view_options", view_type: "filter", object_id: own("filter").id }));
      assert.equal(listed.length, 1); assert.equal(listed[0]!.grouped_by, "due_date");
    });
    await check("clear grouping while retaining scratch filter", async () => {
      const result = await invoke({ operation: "set_view_options", view_type: "filter", object_id: own("filter").id, grouped_by: null });
      assert.equal(result.grouped_by, null);
      const listed = rows(await invoke({ operation: "list_view_options", view_type: "filter", object_id: own("filter").id }));
      assert.equal(listed.length, 1); assert.equal(listed[0]!.grouped_by, null);
    });
    await check("reset scratch view preferences and verify absence", resetOwnedView);
    await check("create owned scratch project", async () => {
      const name = `${marker} project`;
      remember("project", await invoke({ operation: "create_project", name }), "name", name);
    });
    await check("update scratch project and verify", async () => {
      await invoke({ operation: "update_project", project_id: own("project").id, name: `${own("project").marker} updated` });
      assert.equal((await readOwned("project")).name, `${own("project").marker} updated`);
    });
    await check("create owned scratch section", async () => {
      const name = `${marker} section`;
      remember("section", await invoke({ operation: "create_section", project_id: own("project").id, name }), "name", name);
    });
    await check("update scratch section and verify", async () => {
      await invoke({ operation: "update_section", section_id: own("section").id, name: `${own("section").marker} updated` });
      const section = await readOwned("section");
      assert.equal(section.name, `${own("section").marker} updated`); assert.equal(section.project_id, own("project").id);
    });
    await check("create owned scratch label", async () => {
      const name = `tango_smoke_${randomUUID().replaceAll("-", "")}`;
      remember("label", await invoke({ operation: "create_label", name }), "name", name);
    });
    await check("update scratch label and verify", async () => {
      await invoke({ operation: "update_label", label_id: own("label").id, name: `${own("label").marker}_updated` });
      assert.equal((await readOwned("label")).name, `${own("label").marker}_updated`);
    });
    await check("create owned scratch task in scratch project", async () => {
      const content = `${marker} task`;
      remember("task", await invoke({ operation: "create_task", content, project_id: own("project").id, labels: [`${own("label").marker}_updated`] }, "todoist"), "content", content);
      assert.equal((await readOwned("task")).project_id, own("project").id);
    });
    await check("move scratch task into scratch section and verify", async () => {
      await invoke({ operation: "move_task", task_id: own("task").id, section_id: own("section").id });
      const task = await readOwned("task");
      assert.equal(task.section_id, own("section").id); assert.equal(task.project_id, own("project").id);
    });
    await check("create owned scratch task comment", async () => {
      const content = `${marker} comment`;
      remember("comment", await invoke({ operation: "create_comment", task_id: own("task").id, content }), "content", content);
    });
    await check("update and list scratch comment", async () => {
      await invoke({ operation: "update_comment", comment_id: own("comment").id, content: `${own("comment").marker} updated` });
      assert.equal((await readOwned("comment")).content, `${own("comment").marker} updated`);
      assert(rows(await invoke({ operation: "list_comments", task_id: own("task").id })).some(comment => comment.id === own("comment").id));
    });
    await check("create owned section destination project", async () => {
      const name = `${marker} destination project`;
      remember("destination_project", await invoke({ operation: "create_project", name }), "name", name);
    });
    await check("move scratch section between owned projects and verify", async () => {
      for (const destination of [own("destination_project").id, own("project").id]) {
        const section = await invoke({ operation: "move_section", section_id: own("section").id, project_id: destination });
        assert.equal(section.project_id, destination);
        assert.equal((await readOwned("section")).project_id, destination);
        assert.equal((await readOwned("task")).project_id, destination);
      }
    });
    await check("archive scratch project and verify", async () => {
      projectMayBeArchived = true;
      assert.equal((await invoke({ operation: "archive_project", project_id: own("project").id })).id, own("project").id);
      assert.equal((await readOwned("project")).is_archived, true);
    });
    await check("unarchive scratch project and verify", async () => {
      assert.equal((await invoke({ operation: "unarchive_project", project_id: own("project").id })).id, own("project").id);
      assert.equal((await readOwned("project")).is_archived, false);
      projectMayBeArchived = false;
    });
  } catch {
    checks.push({ name: stage, ok: false });
    failed = true;
  } finally {
    if (projectMayBeArchived && fixtures.has("project")) {
      try {
        await check("cleanup: ensure owned project is unarchived", async () => {
          await readOwned("project");
          assert.equal((await invoke({ operation: "unarchive_project", project_id: own("project").id })).id, own("project").id);
          assert.equal((await readOwned("project")).is_archived, false);
          projectMayBeArchived = false;
        });
      } catch { checks.push({ name: stage, ok: false }); failed = true; }
    }
    if (viewMayExist && fixtures.has("filter")) {
      try { await check("cleanup: reset owned scratch view", resetOwnedView); }
      catch { checks.push({ name: stage, ok: false }); failed = true; }
    }
    for (const kind of ["comment", "task", "section", "label", "filter", "project", "destination_project"] as const) {
      if (!fixtures.has(kind) || fixtures.get(kind)!.deleted) continue;
      try { await check(`cleanup: delete owned ${kind} and verify absence`, () => deleteOwned(kind)); }
      catch { checks.push({ name: stage, ok: false }); failed = true; }
    }
    if (client) {
      try { await client.close(); }
      catch { checks.push({ name: "close MCP client", ok: false }); failed = true; }
    }
    if (failed) process.exitCode = 1;
    console.log(JSON.stringify({
      mode: mcp ? "mcp-proxy" : "handler", passed: !failed,
      scratchResourcesCreated: fixtures.size,
      scratchResourcesDeleted: [...fixtures.values()].filter(fixture => fixture.deleted).length,
      unverifiedCreateOutcome,
      cleanupComplete: [...fixtures.values()].every(fixture => fixture.deleted) && !viewMayExist && !unverifiedCreateOutcome,
      checks,
    }, null, 2));
  }
}
void main();
