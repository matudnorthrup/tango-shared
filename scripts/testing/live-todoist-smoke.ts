/** Live task lifecycle through the real handler, optionally through MCP stdio proxy.
 * Creates only its own nonrecurring task; leaves it completed, never deletes data.
 * Output contains assertions and no personal task content or credentials.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTodoistTools } from "../../packages/discord/src/todoist-agent-tools.js";

dotenv.config({ quiet: true });
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const mcp = process.argv.includes("--mcp");
let client: Client | undefined;
let taskId: string | undefined;
let completed = false;
const title = `Tango Todoist smoke ${randomUUID()}`;
const handler = createTodoistTools()[0]!.handler;
type Result = Record<string, unknown>;
async function call(input: Record<string, unknown>): Promise<Result> {
  if (!client) return await handler(input) as Result;
  const response = await client.callTool({ name: "todoist", arguments: input });
  if (response.isError) throw new Error("MCP rejected Todoist call.");
  const content = response.content as { type: string; text?: string }[];
  return JSON.parse(content.find(c => c.type === "text")?.text ?? "null") as Result;
}
async function ok(name: string, input: Record<string, unknown>): Promise<Result> {
  const result = await call(input);
  assert(result && !result.error, typeof result?.error === "string" ? result.error : "Missing response");
  checks.push({ name, ok: true });
  return result;
}
async function main() {
  try {
    if (mcp) {
      assert(process.env.WORKER_ID, "--mcp requires an explicitly authorized WORKER_ID");
      client = new Client({ name: "todoist-live-smoke", version: "1.0.0" });
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ["packages/core/dist/mcp-proxy.js", "todoist"], env: { ...env, ALLOWED_TOOL_IDS: "todoist" }, stderr: "ignore" }));
      const visible = await client.listTools();
      assert.deepEqual(visible.tools.map(t => t.name), ["todoist"]);
      checks.push({ name: "MCP proxy exposes only Todoist to authorized worker", ok: true });
    }
    const projects = await ok("authenticate and list projects", { operation: "list_projects", limit: 1 });
    assert(Array.isArray(projects.results));
    if (projects.next_cursor) await ok("follow project cursor", { operation: "list_projects", limit: 1, cursor: projects.next_cursor });
    const task = await ok("create isolated task", { operation: "create_task", content: title, description: "Disposable integration verification", due_string: "tomorrow", priority: 2 });
    assert.equal(typeof task.id, "string"); taskId = task.id as string;
    assert.equal(task.content, title);
    const fetched = await ok("read created task", { operation: "get_task", task_id: taskId });
    assert.equal(fetched.content, title); assert.equal(fetched.priority, 2); assert(fetched.due);
    await ok("update task", { operation: "update_task", task_id: taskId, content: `${title} updated`, priority: 3, description: "", due_string: "no date" });
    const updated = await ok("read back update", { operation: "get_task", task_id: taskId });
    assert.equal(updated.content, `${title} updated`); assert.equal(updated.priority, 3); assert.equal(updated.description, ""); assert.equal(updated.due, null);
    const found = await ok("filter finds created task", { operation: "list_tasks", filter: `search: ${title}` });
    assert((found.results as Result[]).some(t => t.id === taskId));
    await ok("complete task", { operation: "complete_task", task_id: taskId }); completed = true;
    const closed = await ok("verify completed state", { operation: "get_task", task_id: taskId }); assert.equal(closed.checked, true);
    await ok("reopen task", { operation: "reopen_task", task_id: taskId }); completed = false;
    const reopened = await ok("verify reopened state", { operation: "get_task", task_id: taskId }); assert.equal(reopened.checked, false);
  } catch (error) {
    checks.push({ name: "live lifecycle", ok: false, detail: error instanceof Error ? error.message : "Unexpected failure" });
    process.exitCode = 1;
  } finally {
    if (taskId && !completed) {
      try {
        await ok("cleanup: complete scratch task", { operation: "complete_task", task_id: taskId });
        const result = await ok("verify cleanup", { operation: "get_task", task_id: taskId }); assert.equal(result.checked, true);
        completed = true;
      } catch { checks.push({ name: "cleanup incomplete; scratch task may remain active", ok: false }); process.exitCode = 1; }
    }
    if (client) await client.close();
    console.log(JSON.stringify({ mode: mcp ? "mcp-proxy" : "handler", passed: process.exitCode !== 1, scratchTaskCreated: !!taskId, scratchTaskCompleted: completed, checks }, null, 2));
  }
}
void main();
