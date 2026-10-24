import { fanOutInput } from "../fan-outs.js";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { NEXT_KINDS, WHO_HELP } from "../handoff.js";
import { deskPerson } from "../people.js";

export { LOOM_GUIDANCE, DEFAULT_ROLE_GUIDANCE } from "../instructions.js";

/** A call to Loom's own API from inside a session (its tools and hooks). */
export function loomRequester(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  return async (path: string, body?: unknown, timeoutMs = 30_000) => {
    const token = (await readFile(config.tokenPath, "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
}

function tool<S extends z.ZodRawShape>(name: string, description: string, schema: S, handler: (input: z.infer<z.ZodObject<S>>) => Promise<{ content: { type: "text"; text: string }[] }>) {
  return { name, description, schema: schema as z.ZodRawShape, handler: (input: unknown) => handler(input as z.infer<z.ZodObject<S>>) };
}

export function loomToolDefinitions(threadId: string, env: NodeJS.ProcessEnv = process.env) {
  const request = loomRequester(env);
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
  const person = deskPerson(env);
  return [
    tool("fan_out", "Start bounded read-only research probes. End your turn; one wake delivers the whole set.", fanOutInput.shape, async input => text(await request("/commands", { type: "fan_out.create", commandId: randomUUID(), threadId, input }))),
    tool("fan_out_status", "Read progress and results for one of this thread’s fan-outs.", { fanOutId: z.string() }, async input => text(await request(`/threads/${encodeURIComponent(threadId)}/fan-outs/${encodeURIComponent(input.fanOutId)}`))),
    tool("handoff", `Record who acts next for this turn, by kind and id, never a pronoun. ${person ? `The desk's person is ${person.name} (id ${person.id}). ` : ""}This thread is loom:${threadId}: use that for work you continue yourself. Only this tool opens a hand-off ask to the desk person; a closing Next line never does. Always write the answer to an owner question in your visible reply; this tool and a Next line do not answer it. Re-recording an unchanged ask suppresses only repeated nudges, never that answer.`, {
      kind: z.enum(NEXT_KINDS).describe("human: a person acts next. agent: an agent does (this thread, or another). system: waiting on a system (CI, a deploy, a review bot). nobody: done."),
      who: z.string().nullable().optional().describe(`Who, by id: ${WHO_HELP}. Leave out for nobody.`),
      ask: z.object({
        kind: z.enum(["do", "answer", "pointer"]).describe("do: an errand only the owner's hands can do; answer: a fact or preference only they know (choices between options need decision_request); pointer: name an existing decision D-n or pending request, answered on its own card."),
        steps: z.array(z.string()).min(2).max(5).optional().describe("Two to five distinct steps of one errand, each independently completable."),
        resolves: z.object({ kind: z.enum(["pr", "url", "file", "thread"]), ref: z.string() }).optional().describe("Record that resolves the ask: GitHub PR URL or owner/repo#N (merged or closed), Loom thread id (run completed), URL (HTTP 200), or file path (exists)."),
        due: z.string().optional().describe("ISO deadline: expires and wakes this thread, except tripwire classes never expire."),
        class: z.string().optional().describe("Board class when this ask is a tripwire, such as identity or security-privacy."),
      }).optional().describe("Declare the ask on a human handoff. Omission records unclear and queues one corrective wake. Re-record the same words to revise its kind or fields."),
      assets: z.array(z.object({ kind: z.string(), title: z.string(), url: z.string() })).optional().describe("Structured assets, including kind pr for merge checks"),
      requestedAction: z.literal("merge").optional().describe("Set when the requested owner action is merging a PR; omit for other decisions"),
      buildInstruction: z.string().optional().describe("Message id of the owner's build instruction on this thread"),
      text: z.string().describe("What they do next. Human handoffs require at least four normalized words naming the action; pointers to decision briefs are exempt. Re-record an unchanged handoff verbatim: it preserves the original ask and queues no wake."), waitingOn: z.string().nullable().optional(),
      messageId: z.string().nullable().optional(), runId: z.string().nullable().optional(), at: z.number().optional(), source: z.literal("tool").optional(),
    }, async input => text(await request("/commands", { ...input, type: "handoff.record", commandId: randomUUID(), threadId }))),
    tool("wait_for", "Register a durable wait, then end your turn. For worker use spec {project, task} for agentctl, or {threadId} for a Loom worker. For a Codex review, request the review then use kind pr with spec {repo, number, until: \"codex_reviewed\"}; Loom waits for the head review and re-requests once if stalled. A timeout always wakes this thread.", {
      kind: z.enum(["time", "pr", "command", "url", "thread", "file", "worker"]), spec: z.record(z.string(), z.unknown()), note: z.string(), timeoutMinutes: z.number().positive().max(10080).optional(),
    }, async (input) => text({ ...await request("/commands", { ...input, type: "trigger.create", commandId: randomUUID(), threadId }), message: "Registered. End your turn now; Loom wakes this thread when it fires." })),
    tool("decision_check", "Before asking the owner anything: the decision class's level on the delegation board (5 act, 4 act and tell, 3 act unless vetoed, 2 recommend, 1 the owner's call; lower when the owner's reversals demoted it), the tripwires, the standing rules for it (a rule whose scope covers your case is the authority: act and cite it with decision_log), the owner's precedents in the class (earlier approvals that made no rule: cite a matching one in your brief), any precedent conflict, and this thread's open briefs. Without a class: the whole board.", {
      class: z.string().optional(),
    }, async (input) => text(await request(`/threads/${encodeURIComponent(threadId)}/decisions${input.class ? `?class=${encodeURIComponent(input.class)}` : ""}`))),
    tool("decision_request", "Bring one decision to the owner as a brief they can answer without reading this thread. Loom checks it and refuses a brief that needs work (it says what). A new brief of the same class replaces the open one. Their answer comes back as a new turn.", {
      requestedAction: z.literal("merge").optional().describe("Set when the requested owner action is merging a PR; omit for other decisions"),
      buildInstruction: z.string().optional().describe("Message id of the owner's build instruction on this thread"),
      class: z.string().describe("A board class (decision_check lists them)"),
      about: z.string().describe("The project or feature this is about, in plain words the owner would recognize cold (at most 8 words), e.g. Catch me up page on the desk, Ridge Loop ride video"),
      ask: z.string().describe("The decision and your recommendation, one line, at most 140 characters; name the thing being decided; never open with it or this"),
      door: z.enum(["one-way", "two-way"]).describe("one-way: hard to undo"),
      blast: z.enum(["private", "team", "public"]).describe("Who it affects"),
      standing: z.string().describe("Where things stand, up to 3 lines; first sentence: the problem or goal in plain words"),
      background: z.string().describe("What the owner needs if they never read this thread, up to 6 lines; link the rest"),
      options: z.array(z.object({ key: z.string().describe("A, B, C"), label: z.string().describe("Plain words, no version labels"), consequence: z.string().describe("What happens, what it costs, how reversible"), recommended: z.boolean().optional(), action: z.string().optional().describe("What runs if this is chosen"), rule: z.string().optional().describe("tripwire precedent-conflict: the standing rule this option keeps") })).describe("2 or 3 real options, plus do nothing when that is real"),
      assets: z.array(z.object({ kind: z.string().describe("pr, preview, prototype, screenshot, doc, diff"), title: z.string(), url: z.string().describe("A link the owner can open: tailnet or team URL, never localhost") })).optional(),
      deadline: z.string().optional().describe("When waiting starts to cost something, and what"),
      default: z.string().optional().describe("Level 3: the option key that runs if they don't veto (default: your recommendation)"),
      confidence: z.enum(["low", "medium", "high"]).optional(),
      changeMyMind: z.string().optional().describe("What would change your recommendation"),
      precedents: z.array(z.string()).optional().describe("Rules and precedents (D-n, from decision_check) you checked: name a matching precedent, or say why none applies"),
      proposedRule: z.string().optional().describe('Required for a two-way door that is private or team: "Next time, for <scope>, do <X> without asking"'),
      blocks: z.array(z.string()).optional().describe("What waits on this; everything else carries on"),
      tripwire: z.string().optional().describe("A board tripwire that applies, which makes it the owner's call"),
    }, async (brief) => text({ ...await request("/commands", { type: "decision.request", commandId: randomUUID(), threadId, brief }) as object, message: "Recorded. The owner sees it on the desk; don't ask it again in your reply. Their answer arrives as a new turn." })),
    tool("decision_update", "Revise an open brief in place when you learn something that changes it: the same D-n, the next revision, and the owner sees what changed. Works on this thread's briefs, its workers' and its lead's (or one it carries). A change to the options, the recommendation or the default restarts a level 3 veto window and tells the threads carrying it; copy edits don't. Don't raise a new brief instead.", {
      decisionId: z.string(),
      changes: z.record(z.string(), z.unknown()).describe("Only the brief fields that change (as in decision_request: about, ask, standing, background, options, default, assets, ...); options replace the whole list. The class can't change."),
      why: z.string().describe("The new information that changes it, one line"),
    }, async (input) => text({ ...await request("/commands", { ...input, type: "decision.update", commandId: randomUUID(), threadId }) as object, message: "Updated in place. The owner sees the new revision; an answer to the old one is refused." })),
    tool("decision_keep", "Keep an in-discussion brief unchanged when the owner's message was about something else. Say why. It stays in discussion until the turn ends and the owner sees the reply or acts again, with a fallback after 30 minutes of owner active time following turn end; the veto window restarts on return. Same authority as decision_update.", {
      decisionId: z.string(), why: z.string(),
    }, async (input) => text(await request("/commands", { ...input, type: "decision.keep", commandId: randomUUID(), threadId }))),
    tool("decision_close", "Close an open brief: withdrawn (no longer needed), moot (new information settled it, with that information in note; works on this thread's, its workers' or its lead's briefs), or answered-in-chat (the owner answered the brief in the conversation: this thread's, or one you relayed or named in your closing ask, from any thread in its chain). Answered in chat with the recommended option, a candidate's proposed rule becomes a standing rule unless you pass rule next-time or once (what the owner said).", {
      decisionId: z.string(), outcome: z.enum(["withdrawn", "moot", "answered-in-chat"]), option: z.string().optional(), note: z.string().optional().describe("moot: the new information; answered-in-chat: what the owner said"),
      rule: z.enum(["always", "next-time", "once"]).optional().describe("Answered in chat: whether the owner wants it as a standing rule (always), asked again (next-time), or just this once"),
      reason: z.string().optional().describe("Answered in chat: the owner's reason, in their words (a rule keeps it; agents generalize from it)"),
    }, async (input) => text(await request("/commands", { ...input, type: "decision.close", commandId: randomUUID(), threadId }))),
    tool("decision_log", "After you decide and act on a level 4 (act and tell) class, or under a standing rule: log it in one line for the owner's Decided for you, with how to undo it when that's possible. Loom refuses other levels unless you cite the rule that covers it (level 5 needs no log; 1 to 3 need a brief). If the owner asks for Undo, a new turn says so; an Undo also suspends the rule you cited.", {
      class: z.string().describe("A level 4 board class, or the class of the rule you cite (decision_check lists them)"),
      rule: z.string().optional().describe("The standing rule you acted under (R-n), when one covers this case"),
      scope: z.string().optional().describe("With rule: your case's scope. It must fall inside the rule's scope: the same words, or a narrower case that contains them (a different subject is a near miss and asks)"),
      dissent: z.string().optional().describe("With rule: you followed it but think it is wrong, and why (disagree and commit; it comes up in the weekly review)"),
      summary: z.string().describe("What you decided and did, one line, at most 200 characters"),
      undo: z.string().optional().describe("How to undo it, if it can be undone: what you would run or change"),
      ref: z.string().optional().describe("A link to what you did (PR, page): tailnet or team URL, never localhost"),
    }, async (input) => text({ ...await request("/commands", { ...input, type: "decision.log", commandId: randomUUID(), threadId }) as object, message: "Logged. It shows in the owner's Decided for you; say so in your report too." })),
    tool("desk_update", "News for the owner's catch-up, instead of retelling it in chat: one typed line in this space's chapter on the desk. Say what happened as a finished sentence, from the owner's side. A newer line on the same thing supersedes the old one (pass its U-<n>), so the owner sees the latest state, not its history. Briefs and decisions you log reach the catch-up on their own; don't repeat them here. Don't restate a worker's ask or another thread's brief. Your row carries it.", {
      kind: z.enum(["shipped", "failed", "decided", "needs", "fyi"]).describe("shipped: done and live; failed: broke, or cost something; decided: a call you made; needs: something only the owner can do that isn't a brief; fyi: worth knowing"),
      title: z.string().describe("One finished sentence, at most 14 words or so"),
      detail: z.string().optional().describe("One or two sentences more, if needed"),
      moment: z.boolean().optional().describe("true: its own card (a milestone the owner will notice, a failure still broken or costly); otherwise a short line"),
      refs: z.array(z.object({ label: z.string(), url: z.string().describe("A link the owner can open: tailnet or team URL, never localhost") })).optional().describe("PR, preview, brief, page"),
      shot: z.string().optional().describe("An image URL of what shipped (tailnet or team URL)"),
      supersedes: z.string().optional().describe("The U-<n> of an earlier update on the same thing that this replaces"),
    }, async (input) => text({ ...await request("/commands", { ...input, type: "update.post", commandId: randomUUID(), threadId }) as object, message: "In the catch-up. Don't retell it in chat; at most one line pointing to it." })),
    tool("chapter_note", "Set this space's chapter headline (what happened, from the owner's side, one or two sentences) and/or status (where it stands now, then Next:). Metadata on the chapter, never a line of news.", {
      headline: z.string().optional(),
      status: z.string().optional(),
    }, async (input) => text({ ...await request("/commands", { ...input, type: "chapter.note", commandId: randomUUID(), threadId }) as object, message: "Noted on the chapter." })),
    tool("save_handoff", "Save this thread's handoff for its next session: Loom starts a fresh session when the context grows large (it asks you to call this first) or when a task ends. The next session starts from it plus Loom's own record (waits, briefs, open ask, background tasks, worktree), so leave those out. Call it when Loom asks, or when you finish a piece of work and the next part is separate.", {
      summary: z.string().min(1).describe("What this thread is for and where it stands now"),
      decisions: z.string().optional().describe("Decisions made and why, so the next session doesn't re-litigate them"),
      next: z.string().optional().describe("The next concrete step, and who owns it"),
      files: z.string().optional().describe("The files, PRs, docs and links that matter, by path or URL"),
    }, async (input) => text(await request(`/threads/${encodeURIComponent(threadId)}/handoff`, input))),
    tool("list_waits", "List this thread's waits.", {}, async () => text(await request(`/threads/${encodeURIComponent(threadId)}/triggers`))),
    tool("cancel_wait", "Cancel a wait.", { triggerId: z.string() }, async ({ triggerId }) => {
      const waits = await request(`/threads/${encodeURIComponent(threadId)}/triggers`) as { id: string }[];
      if (!waits.some(t => t.id === triggerId)) throw new Error("This wait belongs to another thread");
      return text(await request("/commands", { type: "trigger.cancel", commandId: randomUUID(), triggerId }));
    }),
  ];
}

export function createLoomTools(threadId: string, env: NodeJS.ProcessEnv = process.env) {
  return createSdkMcpServer({ name: "loom", version: "1.0.0", tools: loomToolDefinitions(threadId, env).map(t => sdkTool(t.name, t.description, t.schema, t.handler)) });
}
