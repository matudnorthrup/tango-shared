// Brief revisions (TGO-1079): a brief updated in place keeps its id, anyone in its chain can update it or mark it moot,
// an answer to an older revision is refused, and a material change restarts a level 3 veto window.
import { describe, expect, it } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import type { BriefChange } from "../src/decisions.js";
import { FakeRuntime } from "./fake-runtime.js";

const MIN = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

const brief = (over: Record<string, unknown> = {}) => ({
  default: "A", class: "product-choice-in-scope",
  ask: "Show the veto countdown in active time? Recommend: yes.",
  door: "two-way",
  blast: "private",
  about: "Desk countdown", standing: "The countdown pauses while the owner is idle.",
  background: "D-1 set the veto window to 4 hours of active time.",
  options: [
    { key: "A", label: "Active time left", consequence: "Honest about what the timer counts", recommended: true },
    { key: "B", label: "A clock time", consequence: "Wrong whenever the owner goes idle" },
  ],
  proposedRule: "Next time, for desk timer copy, use active time without asking",
  ...over,
});
const switched = [
  { key: "A", label: "Active time left", consequence: "Honest about what the timer counts" },
  { key: "B", label: "A clock time", consequence: "Right now that the desk pings every minute", recommended: true },
];

function setup() {
  const store = new LoomStore(":memory:");
  let now = 1_000_000;
  store.now = () => now;
  const runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime });
  const clock = (host as unknown as { vetoClock: { tick(): void } }).vetoClock;
  return { store, runtime, host, clock, advance: (ms: number) => { now += ms; } };
}

/** A lead raises D-4 and starts a worker under it; a stranger thread has nothing to do with either. */
async function chain() {
  const t = setup();
  const lead = (await t.host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
  await t.host.execute({ type: "decision.request", commandId: "c2", threadId: lead, brief: brief() });
  t.runtime.last.complete("Brief D-4 is up; a worker is checking the desk pings.");
  const worker = (await t.host.execute({ type: "submit", commandId: "c3", text: "check the pings", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
  t.runtime.last.complete("Checked.");
  const stranger = (await t.host.execute({ type: "submit", commandId: "c4", text: "other work", cwd: "/repo", provider: "fake" })).threadId!;
  t.runtime.last.complete("Done.");
  await flush();
  return { ...t, lead, worker, stranger };
}

describe("a brief updated in place", () => {
  it("a worker updates its lead's carried brief: same id, the next revision, the change logged, the lead told once", async () => {
    const { host, store, lead, worker } = await chain();
    const leadTurns = store.runs(lead).length;
    const updated = await host.execute({ type: "decision.update", commandId: "u1", threadId: worker, decisionId: "D-4", changes: { options: switched, ask: "Show the countdown as a clock time? Recommend: yes." }, why: "The desk pings every minute, so clock time is right" });
    expect(updated).toMatchObject({ decisionId: "D-4", revision: 2, material: true, told: [lead] });
    expect(updated.changed).toBe("recommendation A → B · options · default A → B · the ask");
    const row = store.decision("D-4")!;
    expect(row).toMatchObject({ id: "D-4", status: "open", revision: 2, ask: "Show the countdown as a clock time? Recommend: yes." });
    expect(JSON.parse(row.brief)).toMatchObject({ default: "B", options: [{ key: "A" }, { key: "B", recommended: true }] });
    const log = JSON.parse(row.changes!) as BriefChange[];
    expect(log).toEqual([{ revision: 2, at: expect.any(Number), by: worker, by_title: store.thread(worker)!.title, fields: ["recommendation", "options", "default", "ask"], what: updated.changed, why: "The desk pings every minute, so clock time is right", material: true, told: [lead] }]);
    // Still one open brief, the same id: no new one was raised.
    expect(store.openDecisions(lead).map((d) => d.id)).toEqual(["D-4"]);
    expect(store.runs(lead).length).toBe(leadTurns + 1);
    const fyi = store.messages(lead).at(-1)!;
    expect(fyi.text).toMatch(/your decision D-4 was updated by .*\(revision 2\): recommendation A → B.*Why: The desk pings every minute.*now asking: Show the countdown as a clock time\?.*Its veto window starts over.*don't raise a new brief/s);
    expect(JSON.parse(fyi.origin!)).toMatchObject({ kind: "peer", name: "Loom" });
    // The worker that made the change isn't told about its own change.
    expect(store.messages(worker).some((m) => m.text.includes("was updated by"))).toBe(false);
    // The thread payload carries the revision and its log.
    expect(host.snapshot().threads.find((t) => t.id === lead)!.decision).toMatchObject({ id: "D-4", revision: 2 });
  });

  it("a raising thread marked done still hears a material revision of its open brief", async () => {
    const { host, store, lead, worker } = await chain();
    await host.execute({ type: "settle", commandId: "s1", threadId: lead });
    expect(store.thread(lead)!.settled_at).not.toBeNull();
    const updated = await host.execute({ type: "decision.update", commandId: "u1", threadId: worker, decisionId: "D-4", changes: { options: switched }, why: "The desk pings every minute" });
    expect(updated.told).toEqual([lead]);
    expect(store.thread(lead)!.settled_at).toBeNull();
    expect(store.messages(lead).at(-1)!.text).toMatch(/your decision D-4 was updated by/);
  });

  it("a lead updates its worker's brief, and a thread that carries it by name can too; a stranger is refused", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a worker.");
    const worker = (await host.execute({ type: "submit", commandId: "c2", text: "build", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c3", threadId: worker, brief: brief() });
    runtime.last.complete("Brief D-4 is up.");
    const pointer = (await host.execute({ type: "submit", commandId: "c4", text: "status", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("**Next — you:** answer D-4 on your desk.");
    const stranger = (await host.execute({ type: "submit", commandId: "c5", text: "other", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("Done.");
    await flush();
    expect(await host.execute({ type: "decision.update", commandId: "u1", threadId: lead, decisionId: "D-4", changes: { standing: "The countdown pauses; the desk pings each minute." }, why: "Checked the desk" })).toMatchObject({ revision: 2, material: false });
    expect(await host.execute({ type: "decision.update", commandId: "u2", threadId: pointer, decisionId: "D-4", changes: { deadline: "Before Friday's release" }, why: "Release is Friday" })).toMatchObject({ revision: 3 });
    await expect(host.execute({ type: "decision.update", commandId: "u3", threadId: stranger, decisionId: "D-4", changes: { standing: "x" }, why: "y" })).rejects.toMatchObject({ code: "not_yours" });
    await expect(host.execute({ type: "decision.close", commandId: "u4", threadId: stranger, decisionId: "D-4", outcome: "moot", note: "n" })).rejects.toMatchObject({ code: "not_found" });
    expect(store.decision("D-4")).toMatchObject({ status: "open", revision: 3 });
  });

  it("a copy edit bumps the revision but tells no one; nothing changed, a new class, or no why is refused", async () => {
    const { host, store, lead, worker } = await chain();
    const before = store.runs(lead).length;
    expect(await host.execute({ type: "decision.update", commandId: "u1", threadId: lead, decisionId: "D-4", changes: { background: "D-1: four hours of active time." }, why: "Shorter" })).toMatchObject({ revision: 2, material: false, changed: "background" });
    expect(store.runs(lead).length).toBe(before);
    await expect(host.execute({ type: "decision.update", commandId: "u2", threadId: worker, decisionId: "D-4", changes: { background: "D-1: four hours of active time." }, why: "Again" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/nothing in them differs/) });
    await expect(host.execute({ type: "decision.update", commandId: "u3", threadId: worker, decisionId: "D-4", changes: { class: "plan-approval" }, why: "x" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/class can't change.*moot/) });
    await expect(host.execute({ type: "decision.update", commandId: "u4", threadId: worker, decisionId: "D-4", changes: { standing: "x" }, why: " " })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/why/) });
    await expect(host.execute({ type: "decision.update", commandId: "u5", threadId: worker, decisionId: "D-4", changes: { options: [switched[0]] }, why: "x" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/options/) });
    expect(store.decision("D-4")!.revision).toBe(2);
  });

  it("an answer to the revision the owner saw goes through; one to an older revision is refused and nothing reaches the thread", async () => {
    const { host, store, lead, worker } = await chain();
    await host.execute({ type: "decision.update", commandId: "u1", threadId: worker, decisionId: "D-4", changes: { options: switched }, why: "The desk pings every minute" });
    const before = store.runs(lead).length;
    await expect(host.execute({ type: "decision.answer", commandId: "a1", decisionId: "D-4", option: "A", rule: "always", revision: 1 })).rejects.toMatchObject({ code: "stale", message: expect.stringMatching(/updated since you looked \(revision 2: recommendation A → B/) });
    expect(store.decision("D-4")!.status).toBe("open");
    expect(store.runs(lead).length).toBe(before);
    // An answer that names no revision is from before revisions (an older client): refused once the brief has one.
    await expect(host.execute({ type: "decision.answer", commandId: "a1b", decisionId: "D-4", option: "B" })).rejects.toMatchObject({ code: "stale" });
    expect(store.runs(lead).length).toBe(before);
    const answered = await host.execute({ type: "decision.answer", commandId: "a2", decisionId: "D-4", option: "B", revision: 2 });
    expect(store.decision("D-4")).toMatchObject({ status: "answered", answer_option: "B", followed_recommendation: 1 });
    expect(store.messages(lead).at(-1)).toMatchObject({ run_id: answered.runId, text: expect.stringContaining("I chose B: A clock time.") });
  });

  it("marked moot from a worker: closed with the new information, and the thread that raised it hears it", async () => {
    const { host, store, lead, worker, stranger } = await chain();
    await expect(host.execute({ type: "decision.close", commandId: "m0", threadId: worker, decisionId: "D-4", outcome: "moot" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/new information/) });
    await expect(host.execute({ type: "decision.close", commandId: "m1", threadId: stranger, decisionId: "D-4", outcome: "moot", note: "x" })).rejects.toMatchObject({ code: "not_found" });
    // A thread outside its chain can't say the owner answered it in chat either.
    await expect(host.execute({ type: "decision.close", commandId: "m2", threadId: stranger, decisionId: "D-4", outcome: "answered-in-chat", option: "A" })).rejects.toMatchObject({ code: "not_found" });
    const closed = await host.execute({ type: "decision.close", commandId: "m3", threadId: worker, decisionId: "D-4", outcome: "moot", note: "The desk already shows active time; it shipped in #770" });
    expect(closed.told).toEqual([lead]);
    expect(store.decision("D-4")).toMatchObject({ status: "moot", decided_by: "agent", answer_text: "The desk already shows active time; it shipped in #770" });
    expect(store.messages(lead).at(-1)!.text).toMatch(/your decision D-4 .*was marked moot by .*: The desk already shows active time; it shipped in #770\. Nothing goes ahead from it/s);
    expect(host.snapshot().threads.find((t) => t.id === lead)!.decision).toBeNull();
    await expect(host.execute({ type: "decision.answer", commandId: "a1", decisionId: "D-4", option: "A", rule: "always" })).rejects.toMatchObject({ code: "not_open" });
  });
});

describe("a revised candidate brief and standing rules (phase 3)", () => {
  it("keeps its proposed rule and candidacy; approving the revised recommendation makes the revised rule", async () => {
    const { host, store, lead, worker } = await chain();
    expect(store.decision("D-4")!.candidate).toBe(1);
    await host.execute({ type: "decision.update", commandId: "u1", threadId: worker, decisionId: "D-4", changes: { options: switched, proposedRule: "Next time, for desk timer copy, use clock time without asking" }, why: "The desk pings every minute" });
    const row = store.decision("D-4")!;
    expect(row.candidate).toBe(1);
    expect(JSON.parse(row.brief).proposedRule).toBe("Next time, for desk timer copy, use clock time without asking");
    expect(host.snapshot().threads.find((t) => t.id === lead)!.decision).toMatchObject({ candidate: 1, revision: 2, brief: { proposedRule: expect.stringContaining("clock time") } });
    const answered = await host.execute({ type: "decision.answer", commandId: "a1", decisionId: "D-4", option: "B", revision: 2, rule: "always" });
    expect(answered).toMatchObject({ rule: "R-1" });
    expect(host.rules.rule("R-1")).toMatchObject({ scope: "desk timer copy", action: "use clock time", state: "active" });
  });

  it("a copy edit keeps a candidate a candidate; a scope the owner declined (before D-61) stops being one", async () => {
    const { host, store, lead, worker } = await chain();
    await host.execute({ type: "decision.update", commandId: "u1", threadId: worker, decisionId: "D-4", changes: { standing: "Still pausing while idle." }, why: "Copy" });
    expect(store.decision("D-4")!.candidate).toBe(1);
    // A scope declined before D-61 ("just this once" used to decline); moving this brief's rule onto it ends its candidacy.
    host.store.tx(() => host.rules.decline("plan-approval", "Next time, for label copy, ship it without asking", "D-1"));
    expect(host.rules.declined("plan-approval", "label copy")).toBe(true);
    await host.execute({ type: "decision.request", commandId: "r3", threadId: lead, brief: brief({ class: "plan-approval", ask: "Ship the copy pass? Recommend: yes.", proposedRule: "Next time, for copy passes, ship them without asking" }) });
    await host.execute({ type: "decision.update", commandId: "u2", threadId: lead, decisionId: "D-5", changes: { proposedRule: "Next time, for label copy, ship it without asking" }, why: "Same scope as the labels" });
    expect(store.decision("D-5")!.candidate).toBe(0);
  });
});

describe("a material change restarts the veto window", () => {
  it("options, the recommendation or the default start the level 3 window over; a copy edit leaves it running", async () => {
    const { host, store, clock, advance, lead, worker } = await chain();
    const left = () => host.snapshot().threads.find((t) => t.id === lead)!.decision!.veto!.left_ms;
    for (let m = 0; m < 3 * 60; m++) { advance(MIN); host.beat(); }   // three active hours
    expect(left()).toBe(60 * MIN);
    await host.execute({ type: "decision.update", commandId: "u1", threadId: worker, decisionId: "D-4", changes: { standing: "Still pausing while idle." }, why: "Copy" });
    expect(left()).toBe(60 * MIN);
    await host.execute({ type: "decision.update", commandId: "u2", threadId: worker, decisionId: "D-4", changes: { options: switched }, why: "The desk pings every minute" });
    expect(left()).toBe(240 * MIN);
    for (let m = 0; m < 3 * 60; m++) { advance(MIN); host.beat(); }   // three more: the old window would have run out
    clock.tick();
    expect(store.decision("D-4")!.status).toBe("open");
    for (let m = 0; m < 62; m++) { advance(MIN); host.beat(); }
    clock.tick();
    await flush();
    // The default that runs is the revised one.
    expect(store.decision("D-4")).toMatchObject({ status: "defaulted", answer_option: "B" });
  });

  it("an explicit default that differs from the recommendation stays put when the recommendation moves", async () => {
    const { host, store, lead } = await chain();
    await host.execute({ type: "decision.update", commandId: "u1", threadId: lead, decisionId: "D-4", changes: { default: "B" }, why: "Safer to run B unattended" });
    const r = await host.execute({ type: "decision.update", commandId: "u2", threadId: lead, decisionId: "D-4", changes: { options: [{ ...switched[0], recommended: true }, { ...switched[1], recommended: false }] }, why: "New consequence for B" });
    expect(r.changed).toBe("options");
    expect(JSON.parse(store.decision("D-4")!.brief).default).toBe("B");
  });
});

describe("answered in chat from elsewhere in the chain (TGO-1110)", () => {
  it("a worker's lead records the owner's answer given in the lead's thread: decided in that thread, the raiser told, asks cleared", async () => {
    const t = setup();
    const submit = async (id: string, text: string, extra: Record<string, unknown> = {}) => {
      const threadId = (await t.host.execute({ type: "submit", commandId: id, text, cwd: "/repo", provider: "fake", ...extra })).threadId!;
      t.runtime.last.complete("ok");
      await flush();
      return threadId;
    };
    const lead = await submit("c1", "run the space", { role: "default" });
    const worker = await submit("c2", "audit", { role: "worker", parentThreadId: `loom:${lead}` });
    await t.host.execute({ type: "decision.request", commandId: "c3", threadId: worker, brief: brief() });
    t.store.updateThread(lead, { ask: JSON.stringify({ text: "Decision D-4 is still open: active time or clock?", at: 1, messageId: "x", runId: "y" }) });
    const workerTurns = t.store.messages(worker).length;
    const closed = await t.host.execute({ type: "decision.close", commandId: "c4", threadId: lead, decisionId: "D-4", outcome: "answered-in-chat", option: "A", note: "Owner: go with active time" });
    expect(t.store.decision("D-4")).toMatchObject({ status: "answered", decided_by: "person-chat", decided_in: lead, answer_option: "A", answer_text: "Owner: go with active time" });
    expect(closed.told).toEqual([worker]);
    expect(t.store.thread(lead)!.ask).toBeNull();
    expect(t.store.messages(worker).length).toBe(workerTurns + 1);
    expect(t.store.messages(worker).at(-1)!.text).toMatch(/your decision D-4 .*was answered by the owner in .*A · Active time left — Owner: go with active time/s);
    await expect(t.host.execute({ type: "decision.close", commandId: "c5", threadId: lead, decisionId: "D-4", outcome: "answered-in-chat", option: "A" })).rejects.toMatchObject({ code: "not_open" });
  });

  it("a thread that named the id in its closing ask may record it; one that didn't may not", async () => {
    const { host, store, lead, stranger } = await chain();
    await expect(host.execute({ type: "decision.close", commandId: "n1", threadId: stranger, decisionId: "D-4", outcome: "answered-in-chat", option: "A" })).rejects.toMatchObject({ code: "not_found" });
    store.updateThread(stranger, { ask: JSON.stringify({ text: "Answer D-4 on your desk.", at: 1, messageId: "x", runId: "y" }) });
    const closed = await host.execute({ type: "decision.close", commandId: "n2", threadId: stranger, decisionId: "D-4", outcome: "answered-in-chat", option: "B", note: "Owner chose B here" });
    expect(store.decision("D-4")).toMatchObject({ status: "answered", decided_by: "person-chat", decided_in: stranger, answer_option: "B" });
    expect(closed.told).toEqual([lead]);
    expect(store.thread(stranger)!.ask).toBeNull();
  });

  it("a thread whose newest words merely mention the id can withdraw it but can't record the owner's answer", async () => {
    const { host, store, stranger } = await chain();
    store.addMessage(stranger, store.runs(stranger)[0]!.id, "assistant", "Side note: D-4 is still open.", null);
    await expect(host.execute({ type: "decision.close", commandId: "p1", threadId: stranger, decisionId: "D-4", outcome: "answered-in-chat", option: "A" })).rejects.toMatchObject({ code: "not_found" });
    await expect(host.execute({ type: "decision.close", commandId: "p2", threadId: stranger, decisionId: "D-4", outcome: "moot", note: "x" })).resolves.toMatchObject({ decisionId: "D-4" });
  });

  it("on its own thread it still records no other thread", async () => {
    const { host, store, lead } = await chain();
    await host.execute({ type: "decision.close", commandId: "o1", threadId: lead, decisionId: "D-4", outcome: "answered-in-chat", option: "A" });
    expect(store.decision("D-4")).toMatchObject({ decided_by: "person-chat", decided_in: lead });
  });
});
