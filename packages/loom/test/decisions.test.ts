import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintBrief, loadBoard, reviseBrief } from "../src/decisions.js";
import { parseRulesFile } from "../src/rules.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

let profile: string;
beforeAll(() => {
  profile = mkdtempSync(join(tmpdir(), "loom-decisions-"));
  mkdirSync(join(profile, "decisions"));
  writeFileSync(join(profile, "decisions", "rules.md"), [
    "# Standing decision rules", "",
    "## R-1 · policy · active", "- Scope: every repo", "",
    "## R-2 · product-choice-in-scope · active", "- Scope: desk sounds", "",
    "## R-3 · product-choice-in-scope · suspended", "- Scope: desk colors", "",
  ].join("\n"));
  process.env.TANGO_PROFILE_DIR = profile;
});
afterAll(() => { delete process.env.TANGO_PROFILE_DIR; rmSync(profile, { recursive: true }); });

function setup() {
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  // Each host gets its own copy of the profile's rules file: Loom imports it and writes it back as its mirror.
  const rulesFile = join(mkdtempSync(join(tmpdir(), "loom-rules-")), "rules.md");
  copyFileSync(join(profile, "decisions", "rules.md"), rulesFile);
  const host = new LoomHost(store, { fake: runtime }, { rulesFile });
  return { store, runtime, host, rulesFile };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const brief = (over: Record<string, unknown> = {}) => ({
  about: "Desk countdown", default: "A", class: "product-choice-in-scope",
  ask: "Show the veto countdown in active time? Recommend: yes.",
  door: "two-way",
  blast: "private",
  standing: "The countdown pauses while the owner is idle.",
  background: "D-4 set the veto window to 4 hours of active time.",
  options: [
    { key: "A", label: "Active time left", consequence: "Honest about what the timer counts", recommended: true },
    { key: "B", label: "A clock time", consequence: "Wrong whenever the owner goes idle" },
  ],
  proposedRule: "Next time, for desk timer copy, use active time without asking",
  ...over,
});

describe("the brief lint", () => {
  const board = loadBoard();

  it("refuses unnamed projects, unexplained pronouns, internal labels and hashes", () => {
    expect(lintBrief(brief({ about: undefined }), board).errors.join()).toMatch(/about: name/);
    expect(lintBrief(brief({ options: [{ key: "A", label: "Approve v6, build in step with v2", recommended: true }, { key: "B", label: "Wait" }] }), board).errors.join()).toMatch(/option label: replace v6, v2/);
    expect(lintBrief(brief({ ask: "Upload it" }), board).errors.join()).toMatch(/name the thing/);
    expect(lintBrief(brief({ standing: "Worktrees clean at 97530d0" }), board).errors.join()).toMatch(/standing: replace 97530d0/);
    expect(lintBrief(brief({ about: "Ridge Loop ride video", ask: "Publish the Ridge Loop video in HD?" }), board).errors).toEqual([]);
    expect(lintBrief(brief({ ask: "This needs approval" }), board).errors.join()).toMatch(/name the thing/);
    expect(lintBrief(brief({ standing: "Release 1.2.3 uses GPT-4." }), board).errors).toEqual([]);
  });

  it("lets an existing brief revise what it is about", () => {
    const result = reviseBrief(brief(), 3, { about: "Desk veto countdown" }, board);
    expect(result.errors).toEqual([]);
    expect(result.brief.about).toBe("Desk veto countdown");
    expect(result.what).toBe("the project or feature");
    expect(result.material).toBe(false);
  });

  it("takes a complete brief, with its level from the board, and marks a two-way private door a candidate", () => {
    const result = lintBrief(brief(), board);
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ level: 3, candidate: true });
    expect(result.brief.default).toBe("A");
  });

  it("refuses what isn't a decision: a level 4-5 class, a verification ask, a missing recommendation", () => {
    expect(lintBrief(brief({ class: "merge-when-green" }), board).errors.join()).toMatch(/decide it yourself and say so/);
    expect(lintBrief(brief({ ask: "Refresh the desk and tell me if it works" }), board).errors.join()).toMatch(/not a decision/);
    const options = [{ key: "A", label: "x", consequence: "y" }, { key: "B", label: "z", consequence: "w" }];
    expect(lintBrief(brief({ options }), board).errors.join()).toMatch(/mark your recommended option/);
  });

  it("refuses a brief that can't be answered cold or opened elsewhere", () => {
    const errors = lintBrief(brief({ standing: "", ask: "x".repeat(141), assets: [{ kind: "preview", title: "Desk", url: "http://localhost:3101" }] }), board).errors.join();
    expect(errors).toMatch(/standing/);
    expect(errors).toMatch(/141 characters/);
    expect(errors).toMatch(/only opens on this machine/);
  });

  it("asks a candidate for the rule it could become; a tripwire makes it the owner's call and no candidate", () => {
    expect(lintBrief(brief({ proposedRule: undefined }), board).errors.join()).toMatch(/proposedRule/);
    const result = lintBrief(brief({ tripwire: "money", proposedRule: undefined }), board);
    expect(result).toMatchObject({ level: 1, candidate: false, errors: [] });
  });

  it("reads the rules file's sections: id, class, state and the scope", () => {
    expect(parseRulesFile("## R-1 · policy · active\n- Scope: every repo\n\n## R-3 · product-choice-in-scope · suspended\n- Scope: desk colors\n- Do: use the palette\n- Level: 4\n").map((r) => [r.id, r.class, r.state, r.scope, r.action, r.level]))
      .toEqual([["R-1", "policy", "active", "every repo", "every repo", 4], ["R-3", "product-choice-in-scope", "suspended", "desk colors", "use the palette", 4]]);
  });
});

describe("decisions on a thread", () => {
  it("queues agent decision replies atomically and retains their explicit wait follow-ups", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "agent-start", text: "choose", cwd: "/repo", provider: "fake", kind: "tango-agent" });
    const asked = await host.execute({ type: "decision.request", commandId: "agent-brief", threadId: r.threadId!, brief: brief() });
    runtime.last.complete("Waiting for a choice.");
    await flush();
    expect(store.pendingDecisionDeliveries()).toEqual([]);
    const command = { type: "decision.answer" as const, commandId: "agent-answer", decisionId: asked.decisionId!, option: "A" };
    const answered = await host.execute(command);
    await host.execute(command);
    expect(store.pendingDecisionDeliveries()).toEqual([expect.objectContaining({ runId: answered.runId, loomThreadId: r.threadId, prompt: expect.stringContaining("I chose A:") })]);
    store.acknowledgeDecisionDelivery(answered.runId!);
    store.acknowledgeDecisionDelivery(answered.runId!);
    store.createRun(r.threadId!, "wake", 'Loom: Your closing "Next — you" (an internal correction)');
    store.createRun(r.threadId!, "reset", "save handoff");
    expect(store.pendingDecisionDeliveries()).toEqual([]);
    const followup = store.createRun(r.threadId!, "wake", "Loom: the trigger you set fired: order completed");
    expect(store.pendingDecisionDeliveries()).toEqual([expect.objectContaining({ runId: followup.id })]);
    await host.closeAll(); store.close();
  });

  it("does not fold registered follow-ups away from the bot's durable run ids", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "start", text: "work", cwd: "/repo", provider: "fake", kind: "tango-agent" });
    store.queueDecisionDelivery(r.runId!);
    const first = store.createRun(r.threadId!, "wake", "Loom: the trigger you set fired: first receipt");
    const second = store.createRun(r.threadId!, "wake", "Loom: the wait timed out: second receipt");
    runtime.last.complete("Original answer"); await host.kick(r.threadId!);
    expect(store.run(first.id)?.status).toBe("running");
    expect(store.run(second.id)?.status).toBe("queued");
    runtime.last.complete("First receipt"); await host.kick(r.threadId!);
    expect(store.run(second.id)?.status).toBe("running");
    await host.closeAll(); store.close();
  });

  it("still reads a stored brief from before about was required", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "legacy", text: "Read the old brief", cwd: "/repo", provider: "fake" });
    const old = brief();
    const { about, ...legacy } = old;
    store.addDecision({ id: "D-99", thread_id: r.threadId!, run_id: null, class: legacy.class, level: 3, candidate: 1,
      ask: legacy.ask, brief: JSON.stringify(legacy), supersedes: null });
    expect(JSON.parse(store.decision("D-99")!.brief).about).toBeUndefined();
    const shown = host.snapshot().threads.find(t => t.id === r.threadId)!.decision!;
    expect(shown.ask).toBe(legacy.ask);
    expect(shown.brief.standing).toBe(legacy.standing);
  });

  it("a brief is the thread's open decision until the owner answers; the answer wakes the thread with their words", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "build the countdown", cwd: "/repo", provider: "fake" });
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief() });
    expect(asked).toMatchObject({ decisionId: "D-4", level: 3, candidate: true, superseded: null });
    runtime.last.complete("Brief D-4 is up.\n\n**Next — you:** decision D-4.");
    await flush();
    const payload = host.snapshot().threads.find((t) => t.id === r.threadId)!;
    expect(payload.decision).toMatchObject({ id: "D-4", status: "open", ask: brief().ask, open: 1 });
    expect(payload.decision!.brief.options).toHaveLength(2);

    // The owner's own words in the conversation don't close it: only an answer (or the agent) does.
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "what does active time mean?" });
    runtime.last.complete("Time you're using Tango.");
    await flush();
    expect(store.openDecisions(r.threadId!)).toHaveLength(1);

    const answered = await host.execute({ type: "decision.answer", commandId: "c4", decisionId: "D-4", option: "A", rule: "always" });
    await flush();
    expect(store.pendingDecisionDeliveries()).toEqual([]);
    const row = store.decision("D-4")!;
    expect(row).toMatchObject({ status: "answered", decided_by: "person", answer_option: "A", followed_recommendation: 1, rule_choice: "always" });
    const words = store.messages(r.threadId!).at(-1)!;
    expect(words).toMatchObject({ role: "user", run_id: answered.runId });
    expect(words.text).toContain("I chose A: Active time left.");
    expect(words.text).toContain("That is now standing rule R-4: for desk timer copy, use active time.");
    expect(store.thread(r.threadId!)!.ask).toBeNull();
    expect(host.snapshot().threads.find((t) => t.id === r.threadId)!.decision).toBeNull();
    await expect(host.execute({ type: "decision.answer", commandId: "c5", decisionId: "D-4", option: "B" })).rejects.toMatchObject({ code: "not_open" });
  });

  it("asks once: a new brief of the same class replaces the open one", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief() });
    const again = await host.execute({ type: "decision.request", commandId: "c3", threadId: r.threadId!, brief: brief({ ask: "Use active time on the countdown? Recommend: yes." }) });
    expect(again).toMatchObject({ decisionId: "D-5", superseded: "D-4" });
    expect(store.decision("D-4")!.status).toBe("superseded");
    expect(store.openDecisions(r.threadId!).map((d) => d.id)).toEqual(["D-5"]);
  });

  it("takes the thread's name as what a brief is about when an older tool leaves it out", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    store.updateThread(r.threadId!, { title: "Catch me up page on the desk" });
    const { about, ...older } = brief();
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: older }) as { decisionId: string };
    expect(JSON.parse(store.decision(asked.decisionId)!.brief).about).toBe("Catch me up page on the desk");
  });

  it("refuses a brief that needs work, saying what", async () => {
    const { host } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await expect(host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief({ background: "" }) })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/background/) });
  });

  it("an answer in the owner's own words, against the recommendation, is no rule; the agent can close a brief itself", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: "c3", decisionId: "D-4", option: "B", text: "Clock time, but say it pauses", reason: "I read clocks" });
    expect(store.decision("D-4")).toMatchObject({ followed_recommendation: 0, rule_choice: null, answer_reason: "I read clocks" });
    await host.execute({ type: "decision.request", commandId: "c4", threadId: r.threadId!, brief: brief({ class: "plan-approval", ask: "Ship the desk countdown as planned? Recommend: yes." }) });
    await host.execute({ type: "decision.close", commandId: "c5", threadId: r.threadId!, decisionId: "D-5", outcome: "answered-in-chat", option: "A", rule: "always" });
    expect(store.decision("D-5")).toMatchObject({ status: "answered", decided_by: "person-chat", followed_recommendation: 1 });
  });

  it("decision_check says what a class allows, its standing rules and the open briefs", async () => {
    const { host } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    expect(host.decisionCheck(r.threadId!, "merge-when-green")).toMatchObject({ level: 4, what: expect.stringMatching(/yourself, then say.*decision_log/) });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief() });
    const check = host.decisionCheck(r.threadId!, "product-choice-in-scope") as { rules: { id: string }[]; open: { id: string }[]; veto_window: string };
    expect(check.rules.map((x) => x.id)).toEqual(["R-1", "R-2"]);
    expect(check.open.map((x) => x.id)).toEqual(["D-4"]);
    expect(check.veto_window).toBe("4h active");
  });
});

describe("decisions when things change", () => {
  it("stopping a thread withdraws its briefs; ids are never reused", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief() });
    await host.execute({ type: "stop", commandId: "c3", threadId: r.threadId! });
    expect(store.decision("D-4")).toMatchObject({ status: "withdrawn", decided_by: "stopped" });
    await expect(host.execute({ type: "decision.request", commandId: "c3b", threadId: r.threadId!, brief: brief() })).rejects.toMatchObject({ code: "stopped" });
    await host.execute({ type: "delete", commandId: "c4", threadId: r.threadId! });
    const s = await host.execute({ type: "submit", commandId: "c5", text: "again", cwd: "/repo", provider: "fake" });
    expect(await host.execute({ type: "decision.request", commandId: "c6", threadId: s.threadId!, brief: brief() })).toMatchObject({ decisionId: "D-5" });
  });

  it("answered-in-chat needs what the owner decided", async () => {
    const { host } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: brief() });
    await expect(host.execute({ type: "decision.close", commandId: "c3", threadId: r.threadId!, decisionId: "D-4", outcome: "answered-in-chat" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("a decision resolved clears the asks that point at it (TGO-1075)", () => {
  async function pointers() {
    const { host, runtime, store } = setup();
    const raised = (await host.execute({ type: "submit", commandId: "c1", text: "filter work", cwd: "/repo", provider: "fake" })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c2", threadId: raised, brief: brief() });
    runtime.last.complete("Brief D-4 is up.");
    const lead = (await host.execute({ type: "submit", commandId: "c3", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("**Next — you:** answer D-4 on your desk: active time or a clock.");
    const other = (await host.execute({ type: "submit", commandId: "c4", text: "other", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("**Next — you:** answer D-40 on your desk.");
    await flush();
    expect(store.thread(lead)!.ask).toContain("D-4");
    return { host, runtime, store, raised, lead, other };
  }

  it("a default that ran clears the lead's ask naming it, and tells the lead how it went; D-40 is another decision", async () => {
    const { host, store, lead, other } = await pointers();
    (host as unknown as { runDefault(row: unknown, option: string): void }).runDefault(store.decision("D-4"), "A");
    await flush();
    expect(store.thread(lead)!.ask).toBeNull();
    const told = store.messages(lead).at(-1)!;
    expect(told.text).toMatch(/decision D-4 .*is settled: no veto, so its default went ahead: A · Active time left/);
    expect(JSON.parse(told.origin!)).toMatchObject({ kind: "peer", name: "Loom" });
    expect(store.thread(other)!.ask).toContain("D-40");
  });

  it("a default that finds its thread stopped withdraws the brief and still clears the asks pointing at it", async () => {
    const { host, store, raised, lead } = await pointers();
    store.updateThread(raised, { status: "stopped" });
    (host as unknown as { runDefault(row: unknown, option: string): void }).runDefault(store.decision("D-4"), "A");
    await flush();
    expect(store.decision("D-4")).toMatchObject({ status: "withdrawn", decided_by: "stopped" });
    expect(store.thread(lead)!.ask).toBeNull();
    expect(store.messages(lead).at(-1)!.text).toContain("was stopped, so it is withdrawn");
  });

  it("a withdrawn brief clears it too; an answer reports what the owner chose", async () => {
    const { host, store, raised, lead } = await pointers();
    const closed = await host.execute({ type: "decision.close", commandId: "c9", threadId: raised, decisionId: "D-4", outcome: "withdrawn" });
    expect(closed.told).toEqual([lead]);
    expect(store.thread(lead)!.ask).toBeNull();
    expect(store.messages(lead).at(-1)!.text).toContain("the thread that raised it withdrew it. Nothing goes ahead from it.");
  });

  it("a thread whose newest words name the decision, with no recorded ask, hears how it went too", async () => {
    const { host, runtime, store } = setup();
    const raised = (await host.execute({ type: "submit", commandId: "c1", text: "filter work", cwd: "/repo", provider: "fake" })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c2", threadId: raised, brief: brief() });
    runtime.last.complete("Brief D-4 is up.");
    const lead = (await host.execute({ type: "submit", commandId: "c3", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("The filter worker is waiting on D-4; I'll carry on with the rest.");
    const quiet = (await host.execute({ type: "submit", commandId: "c4", text: "other", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("D-4 is up on the filter thread.");
    await host.execute({ type: "submit", commandId: "c5", threadId: quiet, text: "next" });
    await flush();
    runtime.sessions.find((x) => x.options.threadId === quiet)!.complete("Moved on to the mutes.");
    await flush();
    expect(store.thread(lead)!.ask).toBeNull();
    const answered = await host.execute({ type: "decision.answer", commandId: "c6", decisionId: "D-4", option: "A", rule: "always" });
    // The lead's newest words name D-4; the quiet thread named it once but has said other things since.
    expect(answered.told).toEqual([lead]);
    expect(store.messages(lead).at(-1)!.text).toContain("is settled: the owner chose A");
    expect(store.messages(lead).at(-1)!.text).toContain("That thread carries it out.");
  });

  it("a brief replaced by a new one, or withdrawn by a stop or a delete, clears the asks that point at it", async () => {
    const replaced = await pointers();
    const again = await replaced.host.execute({ type: "decision.request", commandId: "c9", threadId: replaced.raised, brief: brief({ ask: "Use active time on the countdown? Recommend: yes." }) });
    expect(again).toMatchObject({ decisionId: "D-5", superseded: "D-4", told: [replaced.lead] });
    expect(replaced.store.thread(replaced.lead)!.ask).toBeNull();
    expect(replaced.store.messages(replaced.lead).at(-1)!.text).toContain("it was replaced by decision D-5");

    const stopped = await pointers();
    expect(await stopped.host.execute({ type: "stop", commandId: "c9", threadId: stopped.raised })).toMatchObject({ told: [stopped.lead] });
    expect(stopped.store.thread(stopped.lead)!.ask).toBeNull();
    expect(stopped.store.messages(stopped.lead).at(-1)!.text).toContain("was stopped, so it is withdrawn");

    const deleted = await pointers();
    expect(await deleted.host.execute({ type: "delete", commandId: "c9", threadId: deleted.raised })).toMatchObject({ told: [deleted.lead] });
    expect(deleted.store.thread(deleted.lead)!.ask).toBeNull();
    expect(deleted.store.thread(deleted.other)!.ask).toContain("D-40");
  });

  it("a nested worker's decision is told to the lead it went up to, past a worker that started it (stopped or not)", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a planner.");
    const mid = (await host.execute({ type: "submit", commandId: "c2", text: "plan", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    const leaf = (await host.execute({ type: "submit", commandId: "c3", text: "build", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${mid}` })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c4", threadId: leaf, brief: brief() });
    await host.execute({ type: "stop", commandId: "c5", threadId: mid });
    const closed = await host.execute({ type: "decision.close", commandId: "c6", threadId: leaf, decisionId: "D-4", outcome: "withdrawn" });
    expect(closed.told).toEqual([lead]);
    expect(store.messages(lead).at(-1)!.text).toContain("decision D-4");
    expect(store.messages(mid).some((m) => m.text.includes("decision D-4"))).toBe(false);
  });

  it("the owner answering a worker's brief: its lead's ask clears and Loom tells the lead, mail or no mail", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a worker.");
    const worker = (await host.execute({ type: "submit", commandId: "c2", text: "filter work", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c3", threadId: worker, brief: brief() });
    runtime.last.complete("Brief D-4 is up.");
    await host.execute({ type: "submit", commandId: "c4", threadId: lead, text: "status?" });
    await flush();
    runtime.sessions.find((x) => x.options.threadId === lead)!.complete("**Next — you:** answer D-4 on your desk.");
    await flush();
    const answered = await host.execute({ type: "decision.answer", commandId: "c5", decisionId: "D-4", option: "A", rule: "always" });
    expect(answered.told).toEqual([lead]);
    expect(store.thread(lead)!.ask).toBeNull();
    expect(store.messages(lead).at(-1)!.text).toContain("is settled: the owner chose A · Active time left");
    // A replaced brief is the worker's own business: its lead isn't woken for it unless it pointed at the old id.
    // (Another scope: the approval above made "desk timer copy" a standing rule, which a brief can't ask again.)
    const next = { proposedRule: "Next time, for badge copy, use active time without asking" };
    await host.execute({ type: "decision.request", commandId: "c6", threadId: worker, brief: brief(next) });
    const replaced = await host.execute({ type: "decision.request", commandId: "c7", threadId: worker, brief: brief({ ...next, ask: "Use active time on the countdown? Recommend: yes." }) });
    expect(replaced.told).toBeUndefined();
  });
});


describe("briefs in discussion", () => {
  async function ready() {
    const h = setup();
    let now = 1_000_000;
    h.store.now = () => now;
    const started = await h.host.execute({ type: "submit", commandId: "start", text: "build", cwd: "/repo", provider: "fake" });
    const threadId = started.threadId!;
    await h.host.execute({ type: "decision.request", commandId: "brief", threadId, brief: brief() });
    h.runtime.last.complete("Brief D-4 is up.");
    await flush();
    return { ...h, threadId, advance: () => { now += 1000; }, shown: () => h.host.snapshot().threads.find(t => t.id === threadId)! };
  }

  it("owner replies remove the brief from openBrief, tell the turn, and return it once if unaddressed", async () => {
    const h = await ready(); h.advance();
    await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Explain the options" });
    expect(h.shown().decision).toBeNull();
    expect(h.shown().discussing).toMatchObject([{ id: "D-4" }]);
    expect(h.runtime.last.turns.at(-1)!.text).toContain("put it back with decision_keep");
    expect(h.store.decision("D-4")).toMatchObject({ status: "open", discussed: 1 });
    h.advance(); h.runtime.last.complete("Here is an explanation"); await flush();
    expect(h.shown().decision).toMatchObject({ id: "D-4", unaddressed_at: h.store.now(), window_from: h.store.now() });
    expect(h.shown().discussing).toEqual([]);
    expect(h.store.decision("D-4")!.discussed).toBe(1);
    await h.host.closeAll(); h.store.close();
  });

  it("returns discussion when the responsible run fails before its session opens", async () => {
    const h = await ready(); h.advance();
    h.runtime.failOpen = new Error("session unavailable");
    const reply = await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Explain the options", session: { model: "replacement" } });
    expect(h.store.run(reply.runId!)!.status).toBe("failed");
    expect(h.store.attempts(reply.runId!)).toEqual([]);
    expect(h.store.decision("D-4")).toMatchObject({ status: "open", discussing_since: null, discussing_run: null, unaddressed_at: h.store.now(), window_from: h.store.now() });
    expect(h.shown().decision?.id).toBe("D-4");
    expect(h.shown().discussing).toEqual([]);
    await h.host.closeAll(); h.store.close();
  });

  it.each(["close", "answer"])("%s clears a kept discussion without the safety-net marker", async (action) => {
    const h = await ready(); h.advance();
    await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Explain" });
    h.advance();
    const base = { commandId: "resolve", decisionId: "D-4", threadId: h.threadId };
    await h.host.execute({ ...base, commandId: "keep-first", type: "decision.keep", why: "Different topic initially" });
    if (action === "close") await h.host.execute({ ...base, type: "decision.close", outcome: "moot", note: "No countdown needed" });
    if (action === "answer") await h.host.execute({ ...base, type: "decision.answer", option: "A" });
    expect(h.store.decision("D-4")).toMatchObject({ discussing_since: null, unaddressed_at: null });
    h.runtime.last.complete("Addressed"); await flush();
    expect(h.store.decision("D-4")!.unaddressed_at).toBeNull();
    await h.host.closeAll(); h.store.close();
  });

  it.each(["keep", "update"] as const)("%s waits for turn end and a fresh seen marker, restarting the window only on return", async (action) => {
    const h = await ready(); h.advance();
    await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Fix the links" });
    const window = h.store.decision("D-4")!.window_from;
    const before = h.store.decision("D-4")!;
    await h.host.execute({ type: action === "keep" ? "decision.keep" : "decision.update", commandId: "keep", threadId: h.threadId, decisionId: "D-4", why: "The owner asked about links", ...(action === "update" ? { changes: { standing: "The links now show both options." } } : {}) });
    expect(h.store.decision("D-4")).toMatchObject({ discussing_since: before.discussing_since, discussing_run: before.discussing_run, kept_at: h.store.now(), unaddressed_at: null });
    const early = h.store.now();
    await h.host.execute({ type: "thread.seen", commandId: "early", threadId: h.threadId, at: early });
    expect(h.shown().decision).toBeNull();
    expect(h.store.decision("D-4")!.window_from).toBe(window);
    h.advance(); h.runtime.last.complete("Fixed links"); await flush();
    expect(h.shown().discussing).toMatchObject([{ id: "D-4" }]);
    expect(h.store.decision("D-4")!.unaddressed_at).toBeNull();
    await h.host.execute({ type: "thread.seen", commandId: "stale", threadId: h.threadId, at: early });
    expect(h.shown().decision).toBeNull();
    h.advance();
    await h.host.execute({ type: "thread.seen", commandId: "seen", threadId: h.threadId, at: h.store.now() });
    expect(h.shown().decision).toMatchObject({ id: "D-4", window_from: h.store.now(), unaddressed_at: null });
    await h.host.closeAll(); h.store.close();
  });

  it("an update outside discussion remains immediately available", async () => {
    const h = await ready(); h.advance();
    await h.host.execute({ type: "decision.update", commandId: "update", threadId: h.threadId, decisionId: "D-4", changes: { standing: "Both options now have working links." }, why: "Fixed links" });
    expect(h.store.decision("D-4")).toMatchObject({ discussing_since: null, discussing_run: null, kept_at: null, unaddressed_at: null, revision: 2 });
    expect(h.shown().decision?.id).toBe("D-4");
    expect(h.shown().discussing).toEqual([]);
    await h.host.closeAll(); h.store.close();
  });

  it("a new owner message gives a kept brief a fresh discussion obligation", async () => {
    const h = await ready();
    await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Fix links" });
    await h.host.execute({ type: "decision.keep", commandId: "keep", threadId: h.threadId, decisionId: "D-4", why: "Links are separate" });
    h.runtime.last.complete("Fixed"); await flush(); h.advance();
    await h.host.execute({ type: "submit", commandId: "again", threadId: h.threadId, text: "Explain the brief now" });
    expect(h.store.decision("D-4")).toMatchObject({ kept_at: null, discussed: 2 });
    h.runtime.last.complete("Missed the brief"); await flush();
    expect(h.shown().decision?.unaddressed_at).toBe(h.store.now());
    await h.host.closeAll(); h.store.close();
  });

  it("peer mail never starts discussion, but a steered owner message does", async () => {
    const h = await ready();
    await h.host.execute({ type: "submit", commandId: "mail", threadId: h.threadId, text: "An update", origin: { kind: "peer", from: "loom:other" } });
    expect(h.shown().decision?.id).toBe("D-4");
    const reply = await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Explain", steer: true });
    expect(reply.steered).toBe(true);
    expect(h.runtime.last.injected.at(-1)).toContain("in discussion");
    expect(h.store.decision("D-4")!.discussing_run).toBe(reply.runId);
    h.runtime.last.complete("Missed it"); await flush();
    expect(h.shown().decision?.unaddressed_at).not.toBeNull();
    await h.host.closeAll(); h.store.close();
  });

  it("only the responsible queued turn returns the brief, and stop withdraws it", async () => {
    const h = await ready();
    await h.host.execute({ type: "submit", commandId: "mail", threadId: h.threadId, text: "An update", origin: { kind: "peer", from: "loom:other" } });
    const oldRun = h.runtime.last.currentRun;
    const reply = await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "Explain" });
    expect(reply.runId).not.toBe(oldRun);
    h.runtime.last.complete("Mail handled"); await flush();
    expect(h.shown().decision).toBeNull();
    expect(h.store.decision("D-4")!.discussing_run).toBe(reply.runId);
    await h.host.execute({ type: "stop", commandId: "stop", threadId: h.threadId });
    expect(h.store.decision("D-4")).toMatchObject({ status: "withdrawn", discussing_since: null, unaddressed_at: null });
    await h.host.closeAll(); h.store.close();
  });

  it("transfers discussion responsibility when queued messages fold into one run", async () => {
    const h = await ready();
    await h.host.execute({ type: "submit", commandId: "active", threadId: h.threadId, text: "An update", origin: { kind: "peer", from: "loom:other" } });
    const first = await h.host.execute({ type: "submit", commandId: "queued", threadId: h.threadId, text: "✉️ More context", origin: { kind: "peer", from: "loom:other" } });
    const reply = await h.host.execute({ type: "submit", commandId: "reply", threadId: h.threadId, text: "✉️ Explain this message" });
    expect(h.store.decision("D-4")!.discussing_run).toBe(reply.runId);
    h.runtime.last.complete("Update handled"); await flush();
    expect(h.store.run(reply.runId!)!.status).toBe("canceled");
    expect(h.store.decision("D-4")!.discussing_run).toBe(first.runId);
    expect(h.runtime.last.turns.at(-1)!.text).toContain("put it back with decision_keep");
    h.advance(); h.runtime.last.complete("Explanation"); await flush();
    expect(h.shown().decision).toMatchObject({ id: "D-4", unaddressed_at: h.store.now() });
    await h.host.closeAll(); h.store.close();
  });

  it.each(["stop", "delete"] as const)("returns the worker brief when %s removes its carrier's queued reply", async (type) => {
    const h = await ready();
    const carrier = (await h.host.execute({ type: "submit", commandId: "carrier", text: "Relay", cwd: "/repo", provider: "fake" })).threadId!;
    h.runtime.last.complete("Decision D-4 is open."); await flush();
    await h.host.execute({ type: "submit", commandId: "mail", threadId: carrier, text: "An update", origin: { kind: "peer", from: "loom:other" } });
    const reply = await h.host.execute({ type: "submit", commandId: "reply", threadId: carrier, text: "Explain" });
    expect(h.store.run(reply.runId!)!.status).toBe("queued");
    expect(h.store.decision("D-4")!.discussing_run).toBe(reply.runId);
    h.advance();
    await h.host.execute({ type, commandId: "remove", threadId: carrier });
    expect(h.store.decision("D-4")).toMatchObject({ status: "open", discussing_run: null, discussing_since: null, unaddressed_at: h.store.now(), window_from: h.store.now() });
    expect(h.shown().decision?.id).toBe("D-4");
    await h.host.closeAll(); h.store.close();
  });

  it("a lead only discusses its worker's brief once its newest words name it", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "lead", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    const leadSession = runtime.last;
    leadSession.complete("Started a worker."); await flush();
    const worker = (await host.execute({ type: "submit", commandId: "worker", text: "build", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    await host.execute({ type: "decision.request", commandId: "brief", threadId: worker, brief: brief() });
    runtime.last.complete("Brief D-4 is up."); await flush();

    await host.execute({ type: "submit", commandId: "unrelated", threadId: lead, text: "Work on another task" });
    expect(store.decision("D-4")).toMatchObject({ status: "open", discussing_since: null, discussed: 0 });
    expect(leadSession.turns.at(-1)!.text).not.toContain("put it back with decision_keep");
    leadSession.complete("Decision D-4 is open."); await flush();
    expect(store.decision("D-4")!.unaddressed_at).toBeNull();

    await host.execute({ type: "submit", commandId: "discuss", threadId: lead, text: "Explain the options" });
    expect(store.decision("D-4")).toMatchObject({ status: "open", discussing_run: leadSession.currentRun, discussed: 1 });
    expect(host.snapshot().threads.find(t => t.id === lead)!.discussing).toMatchObject([{ id: "D-4" }]);
    expect(leadSession.turns.at(-1)!.text).toContain("put it back with decision_keep");
    await host.closeAll(); store.close();
  });

  it("a carrier's reply starts discussion and the carrier can keep it", async () => {
    const h = await ready();
    const carrier = (await h.host.execute({ type: "submit", commandId: "carrier", text: "Relay", cwd: "/repo", provider: "fake" })).threadId!;
    h.runtime.last.complete("Decision D-4 is open.\n\n**Next — you:** decision D-4."); await flush();
    await h.host.execute({ type: "submit", commandId: "reply", threadId: carrier, text: "What does that mean?" });
    expect(h.shown().decision).toBeNull();
    expect(h.host.snapshot().threads.find(t => t.id === carrier)!.discussing).toMatchObject([{ id: "D-4" }]);
    await h.host.execute({ type: "decision.keep", commandId: "keep", threadId: carrier, decisionId: "D-4", why: "The owner clarified a different task" });
    expect(h.shown().decision).toBeNull();
    h.runtime.last.complete("Here are the fixed links."); await flush();
    h.advance();
    await h.host.execute({ type: "thread.seen", commandId: "wrong-thread", threadId: h.threadId, at: h.store.now() });
    expect(h.shown().decision).toBeNull();
    await h.host.execute({ type: "thread.seen", commandId: "seen", threadId: carrier, at: h.store.now() });
    expect(h.shown().decision?.id).toBe("D-4");
    await h.host.closeAll(); h.store.close();
  });
});
