/** Synthetic scheduled-review replay through the scheduler and existing model harness.
 * Usage: node --import tsx scripts/scheduled-review-eval.mts --output <directory> [--runs 2]
 * No production data, Discord delivery, or tools are available to the candidate.
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { assembleSessionMemoryPrompt, type ScheduleConfig, type StoredMessageRecord } from "../packages/core/src/index.js";
import { executeSchedule } from "../packages/core/src/scheduler/executor.js";
import { buildScheduledReviewContext, SCHEDULED_REVIEW_GUIDANCE, selectScheduledAgent } from "../packages/discord/src/scheduled-review-context.js";
import { selectWarmStartMessages } from "../packages/discord/src/channel-surface-context.js";
import { runClaudeOnce } from "./lib/bakeoff/runners.mjs";
import { normalizeFixture } from "./lib/bakeoff/fixtures.mjs";
import { evaluateGates } from "./lib/bakeoff/gates.mjs";

const cases = [
  { id: "matched-refund", agent: "foxtrot", history: "Confirmed purchase order R12 from Trail Supply is Motorcycle Gear, correcting the earlier Sports category. It was 80 dollars. The full refund links to order R12.", task: "Review refund F12, -80 dollars, Trail Supply, linked order R12. Original purchase is confirmed, current live categories include Motorcycle Gear and Sports.", decision: "classify", category: "Motorcycle Gear" },
  { id: "pending-receipt", agent: "foxtrot", history: "Amazon itemization is owned by receipt cataloging. Do not ask me to identify orders while that workflow is pending.", task: "Review A12: Amazon, 32 dollars. Receipt lookup returned no match. Cataloging has started and is within its expected runtime. The purchase is uncleared.", dependency: "running", decision: "defer" },
  { id: "paid-reimbursement", agent: "foxtrot", history: "Charge M12 was reimbursed from the HSA; we linked reimbursement H12 and closed the question.", task: "Review M12. Current records verify H12 was paid, explicitly linked to M12, covering the full charge. No new discrepancy is present.", decision: "resolved" },
  { id: "non-finance-prior-answer", agent: "watson", history: "Meeting T12 is optional. I already declined it. Stop asking whether to attend.", task: "Review meeting invitation T12. Calendar confirms it is declined. There has been no change to its details.", decision: "resolved" },
  { id: "failed-receipt-job", agent: "foxtrot", history: "Receipt cataloging owns itemization of Amazon transactions.", task: "Review A13: Amazon, 28 dollars, no matching receipt. Receipt cataloging failed due to expired retailer login and is overdue. This is a new failure. Do not invent item categories.", dependency: "error", decision: "block" },
  { id: "ambiguous-partial-refund", agent: "foxtrot", history: "Order R13 contains 100 dollars Motorcycle Gear and 60 dollars Home. No return details or clarification exist.", task: "Review F13: a 35 dollar partial refund of R13. All available receipt and transaction records lack returned item details; no workflow can retrieve them. Do not assign a category based on merchant alone.", decision: "ask" },
  { id: "context-unavailable", agent: "foxtrot", history: "", unavailable: true, task: "Review a charge whose classification depends on a prior decision. Current records have no category. Context and memory retrieval are unavailable and cannot be retried during this run.", decision: "unverified" },
  { id: "planned-not-paid", agent: "foxtrot", history: "I plan to reimburse charge M13 from the HSA next week. We have not submitted it yet.", task: "Review M13. The live reimbursement record is planned, not submitted or paid. The expected submission date is still in the future and the item is tracked for that date.", decision: "defer" },
] as const;

function arg(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const output = arg("output");
if (!output) throw new Error("Pass --output with the evidence directory.");
const runs = Number(arg("runs", "2"));
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be 1 to 10");
fs.mkdirSync(output, { recursive: true });
const financeSkill = fs.readFileSync(new URL("../agents/skills/transaction-categorization.md", import.meta.url), "utf8");
// Match model-bakeoff.mjs authentication without depending on an interactive login.
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && fs.existsSync(".env")) {
  const token = parseEnv(fs.readFileSync(".env", "utf8")).CLAUDE_CODE_OAUTH_TOKEN;
  if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
}
const results: Record<string, unknown>[] = [];
for (const scenario of cases) {
  for (let run = 1; run <= runs; run++) {
    const config: ScheduleConfig = {
      id: `eval-${scenario.id}`, description: "Synthetic review", enabled: false, runtime: "v2",
      schedule: { cron: "0 23 * * *", timezone: "UTC" },
      execution: { mode: "agent", workerId: scenario.agent, task: scenario.task, timeoutSeconds: 120, contextDependencies: "dependency" in scenario ? ["receipts"] : [] },
      provider: { model: arg("model", "claude-sonnet-5"), reasoningEffort: "high" },
      delivery: { agentId: scenario.agent, channelId: "fixture-thread", mode: "none" },
    };
    let candidate: any;
    let contextDiagnostics: unknown;
    const result = await executeSchedule(config, {
      store: { getState: () => null } as never,
      db: {} as never,
      executeV2Turn: async ({ task, agentId }) => {
        const selectedAgent = selectScheduledAgent({ agentId, config, useOllama: true, excluded: false, cloneExists: true });
        if (selectedAgent !== scenario.agent) throw new Error("Explicit reasoning model was overridden");
        const aliases = [agentId, `${agentId}-ollama`];
        const context = await buildScheduledReviewContext({ config, agentId, agentIds: aliases, task }, {
          resolveConversation: async () => ({ sessionId: "fixture-session", agentId, channelId: "fixture-parent", threadId: "fixture-thread" }),
          buildWarmStart: async (input) => {
            if ("unavailable" in scenario) return { diagnostics: { error: "Synthetic outage" } };
            const row: StoredMessageRecord = {
              id: 1, sessionId: "earlier-session", agentId: `${agentId}-ollama`,
              direction: "inbound", source: "discord", visibility: "public", content: scenario.history,
              createdAt: "2026-01-01T12:00:00Z", discordChannelId: "fixture-thread",
              providerName: null, discordMessageId: null, discordUserId: null, discordUsername: null, metadata: null,
            };
            const selected = selectWarmStartMessages({ sessionMessages: [], recentChannelMessages: [row], channelId: input.discordThreadId, agentId, scheduledAgentIds: aliases });
            const memory = assembleSessionMemoryPrompt({ sessionId: input.sessionId, agentId, messageAgentIds: aliases, currentUserPrompt: task, allowFullHistoryBypass: false, messages: selected.messages, summaries: [], memories: [], pinnedFacts: [] });
            if (scenario.history && !memory.prompt.includes(scenario.history)) throw new Error("Prior decision did not reach the assembled context");
            return { prompt: memory.prompt, diagnostics: {} };
          },
          getDependency: () => ({ config: { ...config, id: "receipts", enabled: true }, latestRun: { id: 1, status: "dependency" in scenario ? scenario.dependency : "ok", startedAt: "2026-01-02T22:00:00Z", finishedAt: "dependency" in scenario && scenario.dependency === "running" ? null : "2026-01-02T22:01:00Z" } }),
        });
        contextDiagnostics = context.diagnostics;
        const fixture = normalizeFixture({
          id: scenario.id, tools: false, reasoningEffort: "high", timeoutMs: 110_000,
          system: `${SCHEDULED_REVIEW_GUIDANCE}\n${agentId === "foxtrot" ? financeSkill : ""}\nThis is a synthetic read-only evaluation. All available evidence is supplied. Do not perform writes or claim to have changed records. Return only JSON: {"decision":"classify|defer|resolved|block|ask|unverified","category":null,"question":null,"evidence":"brief factual basis","nextCheck":null}. Use a category string only for a verified classification; question is a string only when asking the user. Supply a concrete nextCheck for deferred items.`,
          prompt: `Current review time: 2026-01-02T23:00:00Z\n${context.prompt}\n\nCurrent task:\n${task}`,
          outputAssertions: [{ type: "matches", value: `"decision"\\s*:\\s*"${scenario.decision}"` }],
        });
        candidate = await runClaudeOnce({ model: config.provider!.model!, fixture, timeoutMs: 110_000 });
        const gates = evaluateGates(fixture, candidate);
        if (!gates.pass) throw new Error(JSON.stringify(gates.failures));
        const parsed = JSON.parse(candidate.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        if (candidate.toolCalls.length) throw new Error("Read-only no-tools scenario used a tool");
        if (scenario.decision !== "ask" && parsed.question !== null) throw new Error("Unnecessary user question");
        if (scenario.decision === "ask" && !parsed.question) throw new Error("Missing necessary clarification");
        if (scenario.decision === "defer" && !parsed.nextCheck) throw new Error("Deferred without a next check");
        if ("category" in scenario && parsed.category !== scenario.category) throw new Error("Wrong category");
        if (scenario.decision !== "classify" && parsed.category !== null) throw new Error("Guessed category");
        if (!parsed.evidence) throw new Error("Missing evidence basis");
        return { text: candidate.text, durationMs: candidate.seconds * 1000, model: config.provider!.model };
      },
    });
    results.push({ id: scenario.id, run, status: result.status, error: result.error, contextDiagnostics, candidate });
    fs.writeFileSync(path.join(output, "behavioral-replay.json"), JSON.stringify(results, null, 2));
    console.log(`${scenario.id} run ${run}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
  }
}
const passed = results.filter((row) => row.status === "ok").length;
console.log(`Scheduled review replay: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
