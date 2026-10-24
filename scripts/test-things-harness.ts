/** End-to-end agent test using the repository's real Discord test harness. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createThingsTools } from "../packages/discord/src/things-agent-tools.js";
import {
  createHarnessContext, closeHarnessContext, resolveAgentHarnessTarget, runHarnessTurn,
} from "./testing/discord-test-harness-lib.js";

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node --import tsx scripts/test-things-harness.ts --agent AGENT_ID --report PRIVATE_REPORT_PATH");
    return;
  }
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const agent = arg("--agent") ?? "watson-ollama";
  const prefix = `Tango Things harness ${Date.now()}`;
  const [read, write] = createThingsTools();
  const context = await createHarnessContext();
  const evidence: unknown[] = [];
  let failure: unknown;
  let projectId: string | undefined;
  let taskId: string | undefined;
  const search = async () => (await read!.handler({ operation: "search", query: prefix, limit: 100 })) as { items: Record<string, any>[] };
  const get = async (id: string) => await read!.handler({ operation: "get", id }) as Record<string, any>;
  try {
    const target = await resolveAgentHarnessTarget(context.client, { agentId: agent, explicitThreadName: prefix });
    assert.match(target.parentChannelName, /test|smoke/i, "Refuse to test in a regular user channel");
    const turn = async (content: string, verify: () => Promise<boolean>) => {
      const result = await runHarnessTurn({ context, target, content, waitForResponse: true, timeoutMs: 180_000 });
      evidence.push(result);
      assert.equal(result.receivedResponse, true, "No agent response");
      assert.equal(result.responseAgentId, agent, "Wrong agent handled harness turn");
      // A conversational acknowledgement alone is not evidence of a write.
      const until = Date.now() + 90_000;
      while (!await verify()) { if (Date.now() > until) throw new Error("Agent reply did not produce expected Things state"); await delay(1000); }
      console.log("Verified Things state after harness turn", evidence.length);
    };
    await turn(`Use the Things tools to create a disposable project named "${prefix} project" and one task named "${prefix} task" inside it. This is an authorized live test; do it now and report the IDs after verifying. Do not modify any other items.`, async () => {
      const { items } = await search();
      const project = items.find((x) => x.kind === "project" && x.title === `${prefix} project`);
      const task = items.find((x) => x.kind === "todo" && x.title === `${prefix} task`);
      projectId = project?.id; taskId = task?.id;
      return Boolean(project && task && task.project_id === project.id);
    });
    await turn(`In Things, update test task ${taskId}: rename it "${prefix} updated", set notes to "Verified by Tango harness", and schedule it for Today. I authorize this change. Read it back to confirm.`, async () => {
      const task = await get(taskId!);
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
      return task.title === `${prefix} updated` && task.notes === "Verified by Tango harness" && task.start_date === today;
    });
    await turn(`In Things, mark test task ${taskId} completed now and verify its status. This change is authorized.`, async () => (await get(taskId!)).status === "completed");
    await turn(`Clean up this authorized Things test: move only project ${projectId} and its contained test task to Trash. Do not empty Trash or touch other projects. Verify the project is trashed.`, async () => (await get(projectId!)).trashed === true);
  } catch (error) { failure = error; }
  finally {
    try {
      // Exact per-run marker prevents cleanup from touching pre-existing items.
      const { items } = await search();
      for (const item of items.filter((x) => x.kind === "project" && x.title === `${prefix} project`)) {
        const result = await write!.handler({ operation: "trash", kind: "project", id: item.id }) as { outcome: string };
        assert.equal(result.outcome, "verified", "Fallback cleanup failed");
      }
      for (const item of (await search()).items.filter((x) => x.kind === "todo" && [ `${prefix} task`, `${prefix} updated` ].includes(x.title))) {
        const result = await write!.handler({ operation: "trash", kind: "todo", id: item.id }) as { outcome: string };
        assert.equal(result.outcome, "verified", "Fallback task cleanup failed");
      }
    } catch (error) { failure ??= error; }
    await closeHarnessContext(context);
  }
  const report = { passed: !failure, agent, prefix, projectId, taskId, evidence,
    error: failure instanceof Error ? failure.message : failure ? String(failure) : null };
  if (arg("--report")) await writeFile(arg("--report")!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
