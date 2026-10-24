import { afterEach, describe, expect, it } from "vitest";
import { addAskLint, askLintOn, askLints, classifyAsk } from "../src/ask-lint.js";
import { closingHandoff } from "../src/handoff.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const kind = (text: string, previous?: string) => classifyAsk(text, previous).kind;
/** As Loom reads it: the closing hand-off's text (lists joined by "; "). */
const closing = (message: string) => closingHandoff(message)!.text;

describe("classifyAsk", () => {
  it("reads a decision laid out in prose", () => {
    expect(kind("stage cropping: A (crop to the subject, my pick) or B (keep the full frame)")).toBe("decision");
    expect(kind("should the new limit apply only to background jobs (my lean), or stay as it is?")).toBe("decision");
    expect(kind("which layout do you want for the header?")).toBe("decision");
    expect(kind("approve the plan in the doc so I can start")).toBe("decision");
  });

  it("reads a request to verify the agent's own work", () => {
    expect(kind("look at 00:00:02 in the new cut and tell me whether the color matches the reference")).toBe("verification");
    expect(kind("refresh the page and let me know if it works")).toBe("verification");
    expect(kind("does it look right on your phone?")).toBe("verification");
  });

  it("passes real to-dos for the owner's hands", () => {
    expect(kind("Export the project to the NAS")).toBe("todo");
    expect(kind("Sign in to System Settings so the grant can land")).toBe("todo");
    expect(kind("move the cable to the second port")).toBe("todo");
    expect(kind("whenever you're ready, publish the video from the editor")).toBe("todo");
  });

  it("does not label routine merge/restart asks as owner chores", () => {
    for (const text of ["Merge the PR", "Approve the PR", "Approve my review", "Review and merge the pull request", "Review the PR", "Restart the desk"]) expect(kind(text)).toBe("unclear");
    expect(kind("Reboot the device")).toBe("todo");
    expect(kind("Power the device off")).toBe("todo");
  });

  it("passes a pointer at a brief", () => {
    expect(kind("answer D-6 on your desk")).toBe("pointer");
    expect(kind("decision D-12 still open")).toBe("pointer");
  });

  it("calls a list that mixes a to-do and a decision a decision", () => {
    const text = closing("Done.\n\n**Next — you:**\n1. Export the project to the NAS\n2. Pick the intro: A (short, my pick) or B (long)");
    expect(kind(text)).toBe("decision");
    // Options as separate bullets are one choice (Codex review on #779).
    expect(kind(closing("**Next — you:**\n- A — crop to the subject (my pick)\n- B — keep the full frame"))).toBe("decision");
    expect(kind(closing("**Next — you:**\n- A: ship the short cut\n- B: ship the long cut"))).toBe("decision");
  });

  it("reads the same open ask again as a repeat, but lets a pointer repeat", () => {
    const list = "Export the project to the NAS; sign in to the photo app";
    expect(kind(list, list)).toBe("repeat");
    expect(kind("**Export** the project to the NAS;  sign in to the photo app!", list)).toBe("repeat");
    expect(kind("answer D-6 on your desk", "answer D-6 on your desk")).toBe("pointer");
    expect(kind(list, "something else")).toBe("todo");
    expect(kind("Export the project to https://nas.test/v2", "Export the project to https://nas.test/v1")).not.toBe("repeat");
  });

  it("reads alternatives laid out as an instruction as a decision (live miss, 10/19)", () => {
    expect(kind('say keep the week as written, reword it to "calibration check," or drop it, and I\'ll route the page change.')).toBe("decision");
    expect(kind("tell me which: A, B, or C")).toBe("decision");
    expect(kind("Reply to the vendor, who can be reached by email or text")).toBe("todo");
    expect(kind("Pick up the parcel, which is beside the red or blue bin")).toBe("todo");
    expect(kind("Email the vendor to say the order is ready, since they accept email or text updates")).toBe("todo");
    expect(kind("Connect the camera to the front port, then tell me so I can confirm 1080p.")).toBe("todo");
  });

  it("leaves what no rule reads as unclear", () => {
    expect(kind("the numbers are in the sheet")).toBe("unclear");
  });
});

describe("the switch", () => {
  it("is on unless the board or the environment turns it off", () => {
    expect(askLintOn({ defaults: {} }, {})).toBe(true);
    expect(askLintOn({ defaults: { ask_lint: "on" } }, {})).toBe(true);
    expect(askLintOn({ defaults: { ask_lint: "off" } }, {})).toBe(false);
    expect(askLintOn({ defaults: { ask_lint: false } }, {})).toBe(false);
    expect(askLintOn({ defaults: { ask_lint: "on" } }, { LOOM_ASK_LINT: "off" })).toBe(false);
    expect(askLintOn({ defaults: { ask_lint: "off" } }, { LOOM_ASK_LINT: "on" })).toBe(true);
  });
});

describe("the ask lint on a Loom thread", () => {
  afterEach(() => { delete process.env.LOOM_ASK_LINT; });
  function setup() {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime });
    return { store, runtime, host };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const wakes = (store: LoomStore, id: string) => store.runs(id).filter((run) => run.source === "wake");
  const DECISION = "Two crops are ready.\n\n**Next — you:** stage cropping: A (tight, my pick) or B (full frame)";

  it("a decision-shaped close queues one wake; the same close again doesn't; a to-do queues none", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "crop it", cwd: "/repo", provider: "fake" });
    runtime.last.complete(DECISION);
    await flush();
    const first = wakes(store, r.threadId!);
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toMatch(/is a decision.*decision_check.*decision_request/);
    // The ask still opens as it always did.
    expect(JSON.parse(store.thread(r.threadId!)!.ask!).text).toMatch(/^stage cropping/);
    // The wake runs; the agent closes the same way again: no second wake.
    runtime.last.complete(DECISION);
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(1);
    // The owner answers, the agent asks the same again on a later turn: once per ask per thread.
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "A" });
    runtime.last.complete(DECISION);
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(1);
    // A to-do passes.
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "ok" });
    runtime.last.complete("Rendered.\n\n**Next — you:** Export the project to the NAS");
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(1);
    expect(askLints(store.db, r.threadId!).map((row) => [row.kind, row.woke])).toEqual([["decision", 1], ["repeat", 0], ["decision", 0], ["pass", 0]]);
  });

  it("a pointer to a decision already settled elsewhere clears the ask and wakes the thread with the outcome (live miss, D-35)", async () => {
    const { host, runtime, store } = setup();
    const raiser = await host.execute({ type: "submit", commandId: "c1", text: "design it", cwd: "/repo", provider: "fake" });
    const brief = { about: "Video crop plan", class: "plan-approval", ask: "Ship the video crop design? Recommend: yes.", door: "two-way", blast: "private", standing: "Ready.", background: "Three options.", proposedRule: "Next time, for design picks, go ahead",
      options: [{ key: "A", label: "Ship the video crop design", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] };
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: raiser.threadId!, brief });
    await host.execute({ type: "decision.close", commandId: "c3", threadId: raiser.threadId!, decisionId: asked.decisionId!, outcome: "answered-in-chat", option: "A", note: "v5 with the dot sidebar" });
    runtime.last.complete("Done.");
    await flush();
    const lead = await host.execute({ type: "submit", commandId: "c4", text: "relay it", cwd: "/repo", provider: "fake" });
    runtime.last.complete(`Report is in.\n\n**Next — you:** answer ${asked.decisionId} on your desk.`);
    await flush();
    expect(store.thread(lead.threadId!)!.ask).toBeNull();
    const wake = wakes(store, lead.threadId!).at(-1)!;
    expect(wake.text).toContain(`${asked.decisionId} is settled: the owner answered it in chat on its own thread (chose A: Ship the video crop design)`);
    expect(wake.text).toContain("v5 with the dot sidebar");
  });

  it("a restart doesn't bring back a pointer at a closed decision (Codex review on #826)", async () => {
    const { host, runtime, store } = setup();
    const raiser = await host.execute({ type: "submit", commandId: "c1", text: "design it", cwd: "/repo", provider: "fake" });
    const brief = { about: "Video crop plan", class: "plan-approval", ask: "Ship the video crop design? Recommend: yes.", door: "two-way", blast: "private", standing: "Ready.", background: "Three options.", proposedRule: "Next time, for design picks, go ahead",
      options: [{ key: "A", label: "Ship the video crop design", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] };
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: raiser.threadId!, brief });
    await host.execute({ type: "decision.close", commandId: "c3", threadId: raiser.threadId!, decisionId: asked.decisionId!, outcome: "answered-in-chat", option: "A" });
    runtime.last.complete("Done.");
    await flush();
    const lead = await host.execute({ type: "submit", commandId: "c4", text: "relay it", cwd: "/repo", provider: "fake" });
    runtime.last.complete(`**Next — you:** answer ${asked.decisionId} on your desk.`);
    await flush();
    store.updateThread(lead.threadId!, { ask: "stale" });
    host.rebuildAsks();
    expect(store.thread(lead.threadId!)!.ask).toBeNull();
  });

  it("a pointer at a brief replaced twice names the open one at the end of the chain (Codex review on #826)", async () => {
    const { host, runtime, store } = setup();
    const t = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    const brief = (ask: string) => ({ about: "Video crop plan", class: "plan-approval", ask, door: "two-way", blast: "private", standing: "Ready.", background: "Options.", proposedRule: "Next time, for picks, go ahead",
      options: [{ key: "A", label: "Ship", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] });
    const first = await host.execute({ type: "decision.request", commandId: "c2", threadId: t.threadId!, brief: brief("Ship the video crop? Recommend: yes.") });
    await host.execute({ type: "decision.request", commandId: "c3", threadId: t.threadId!, brief: brief("Ship the video crop now? Recommend: yes.") });
    const third = await host.execute({ type: "decision.request", commandId: "c4", threadId: t.threadId!, brief: brief("Ship the video crop today? Recommend: yes.") });
    runtime.last.complete("Done.");
    await flush();
    const lead = await host.execute({ type: "submit", commandId: "c5", text: "relay", cwd: "/repo", provider: "fake" });
    runtime.last.complete(`**Next — you:** answer ${first.decisionId} on your desk.`);
    await flush();
    expect(wakes(store, lead.threadId!).at(-1)!.text).toContain(`the open decision is now ${third.decisionId}`);
  });

  it("a settled-pointer correction still goes out when the stale pointer came from a lint wake's own turn (Codex review on #826)", async () => {
    const { host, runtime, store } = setup();
    const raiser = await host.execute({ type: "submit", commandId: "c1", text: "design it", cwd: "/repo", provider: "fake" });
    const brief = { about: "Video crop plan", class: "plan-approval", ask: "Ship the video crop design? Recommend: yes.", door: "two-way", blast: "private", standing: "Ready.", background: "Three options.", proposedRule: "Next time, for design picks, go ahead",
      options: [{ key: "A", label: "Ship the video crop design", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] };
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: raiser.threadId!, brief });
    await host.execute({ type: "decision.close", commandId: "c3", threadId: raiser.threadId!, decisionId: asked.decisionId!, outcome: "answered-in-chat", option: "A" });
    runtime.last.complete("Done.");
    await flush();
    const lead = await host.execute({ type: "submit", commandId: "c4", text: "relay it", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** stage cropping: A (my pick) or B?");
    await flush();
    expect(wakes(store, lead.threadId!)).toHaveLength(1);
    // The lint wake's own turn ends pointing at the settled decision: the correction goes out anyway, once.
    runtime.last.complete(`**Next — you:** answer ${asked.decisionId} on your desk.`);
    await flush();
    expect(wakes(store, lead.threadId!)).toHaveLength(2);
    expect(wakes(store, lead.threadId!).at(-1)!.text).toContain("chose A: Ship the video crop design");
  });

  it("lowercase ids settle too; with the lint off the ask stays open (Codex review on #826)", async () => {
    const { host, runtime, store } = setup();
    const raiser = await host.execute({ type: "submit", commandId: "c1", text: "design it", cwd: "/repo", provider: "fake" });
    const brief = { about: "Video crop plan", class: "plan-approval", ask: "Ship the video crop design? Recommend: yes.", door: "two-way", blast: "private", standing: "Ready.", background: "Three options.", proposedRule: "Next time, for design picks, go ahead",
      options: [{ key: "A", label: "Ship the video crop design", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] };
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: raiser.threadId!, brief });
    await host.execute({ type: "decision.close", commandId: "c3", threadId: raiser.threadId!, decisionId: asked.decisionId!, outcome: "answered-in-chat", option: "A" });
    runtime.last.complete("Done.");
    await flush();
    const lead = await host.execute({ type: "submit", commandId: "c4", text: "relay it", cwd: "/repo", provider: "fake" });
    runtime.last.complete(`**Next — you:** answer ${asked.decisionId!.toLowerCase()} on your desk.`);
    await flush();
    expect(store.thread(lead.threadId!)!.ask).toBeNull();
    process.env.LOOM_ASK_LINT = "off";
    try {
      const other = await host.execute({ type: "submit", commandId: "c5", text: "relay again", cwd: "/repo", provider: "fake" });
      runtime.last.complete(`**Next — you:** answer ${asked.decisionId} on your desk, please.`);
      await flush();
      expect(store.thread(other.threadId!)!.ask).not.toBeNull();
    } finally { delete process.env.LOOM_ASK_LINT; }
  });

  it("a pointer to an open decision still passes silently", async () => {
    const { host, runtime, store } = setup();
    const raiser = await host.execute({ type: "submit", commandId: "c1", text: "design it", cwd: "/repo", provider: "fake" });
    const brief = { about: "Video crop plan", class: "plan-approval", ask: "Ship the video crop design? Recommend: yes.", door: "two-way", blast: "private", standing: "Ready.", background: "Three options.", proposedRule: "Next time, for design picks, go ahead",
      options: [{ key: "A", label: "Ship the video crop design", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] };
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: raiser.threadId!, brief });
    runtime.last.complete(`**Next — you:** answer ${asked.decisionId} on your desk.`);
    await flush();
    expect(wakes(store, raiser.threadId!)).toHaveLength(0);
    expect(store.thread(raiser.threadId!)!.ask).not.toBeNull();
  });

  it("the owner's reply cancels a correction that hasn't started: it would correct an ask already answered", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "crop it", cwd: "/repo", provider: "fake" });
    // A correction queued behind the running turn, as lintAsk leaves it.
    const wake = store.createRun(r.threadId!, "wake", "Loom: that ask is a decision…");
    addAskLint(store.db, { thread_id: r.threadId!, run_id: r.runId!, message_id: null, kind: "decision", reason: "states a lean", ask: "A or B", norm: "a or b", woke: 1, wake_run_id: wake.id, created_at: store.now() });
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "A" });
    expect(store.run(wake.id)!.status).toBe("canceled");
  });

  it("answering a brief cancels a queued correction too", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "crop it", cwd: "/repo", provider: "fake" });
    const brief = { about: "Video crop plan", class: "plan-approval", ask: "Ship the crop plan? Recommend: yes.", door: "two-way", blast: "private", standing: "Ready.", background: "Two crops.", proposedRule: "Next time, for crop plans, go ahead",
      options: [{ key: "A", label: "Ship", consequence: "Goes out", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }] };
    const asked = await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief });
    const wake = store.createRun(r.threadId!, "wake", "Loom: that ask is a decision…");
    addAskLint(store.db, { thread_id: r.threadId!, run_id: r.runId!, message_id: null, kind: "decision", reason: "states a lean", ask: "ship?", norm: "ship", woke: 1, wake_run_id: wake.id, created_at: store.now() });
    await host.execute({ type: "decision.answer", commandId: "c3", decisionId: asked.decisionId!, option: "A" });
    expect(store.run(wake.id)!.status).toBe("canceled");
  });

  it("a to-do and its repeat queue nothing and preserve the original ask", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** Sign in to System Settings");
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(0);
    const original = store.thread(r.threadId!)!.ask;
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "✉️ Mail", origin: { kind: "peer", name: "Other", from: "loom:other", mailId: "m-1" } });
    runtime.last.complete("Noted.\n\n**Next — you:** Sign in to System Settings");
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(0);
    expect(store.thread(r.threadId!)!.ask).toBe(original);
    expect(askLints(store.db, r.threadId!).at(-1)).toMatchObject({ kind: "repeat", woke: 0 });
  });

  it("sends no wake when switched off, and still records the ask", async () => {
    process.env.LOOM_ASK_LINT = "off";
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete(DECISION);
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(0);
    expect(askLints(store.db, r.threadId!).map((row) => [row.kind, row.woke])).toEqual([["decision", 0]]);
  });

  it("leaves threads without Loom's tools alone", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake", session: { loomTools: false } });
    runtime.last.complete(DECISION);
    await flush();
    expect(wakes(store, r.threadId!)).toHaveLength(0);
    expect(askLints(store.db, r.threadId!)).toEqual([]);
  });
});

it("lints declared kinds without guessing pointer, todo or unclear from their words", async () => {
  const { classifyDeclaredAsk } = await import("../src/ask-lint.js");
  for (const kind of ["do", "answer"] as const) {
    expect(classifyDeclaredAsk("Choose between A or B", kind).kind).toBe("decision");
    expect(classifyDeclaredAsk("Watch the cut and tell me if it works", kind).kind).toBe("verification");
    expect(classifyDeclaredAsk("D-999 sign in to the console", kind).kind).toBe("pass");
    expect(classifyDeclaredAsk("The cable is blue", kind).kind).toBe("pass");
    expect(classifyDeclaredAsk("Choose between A or B", kind, true).kind).toBe("repeat");
  }
  expect(classifyDeclaredAsk("Choose between A or B", "unclear").kind).toBe("unclear");
  expect(classifyDeclaredAsk("Watch the cut or choose A", "pointer").kind).toBe("pass");
});
