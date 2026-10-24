import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

// These tests are about recording the open ask; the ask lint (ask-lint.test.ts) would queue extra wake runs.
beforeAll(() => { process.env.LOOM_ASK_LINT = "off"; process.env.TANGO_OWNER_NAME = "fixture-owner"; });
afterAll(() => { delete process.env.LOOM_ASK_LINT; delete process.env.TANGO_OWNER_NAME; });
import { closingHandoff, type NextKind } from "../src/handoff.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomHost } from "../src/host.js";
import { PEER_WAKE_TEXT } from "../src/runtime.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

function setup() {
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  return { store, runtime, host };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const askOf = (store: LoomStore, id: string) => {
  const raw = store.thread(id)!.ask;
  return raw ? JSON.parse(raw) : null;
};
const mail = { kind: "peer" as const, name: "tango · Other", from: "loom:other", mailId: "m-1" };
/** The agent's loom.handoff call, during the thread's active run. */
const next = (host: LoomHost, store: LoomStore, threadId: string, kind: NextKind, who: string | null, text: string) =>
  host.execute({ type: "handoff.record", commandId: `h-${Math.random()}`, threadId, kind, who, text, ask: { kind: "do" }, runId: store.activeRun(threadId)!.id });
/** The older form (owner you/agent), from sessions started before kind and who. */
const label = (host: LoomHost, store: LoomStore, threadId: string, owner: "you" | "agent", text: string, to?: string) =>
  host.execute({ type: "handoff.record", commandId: `h-${Math.random()}`, threadId, owner, text, ask: { kind: "do" }, ...(to ? { to } : {}), runId: store.activeRun(threadId)!.id });

describe("the open ask", () => {
  it("Clear survives ask recovery; Undo replays without overwriting newer handoffs", async () => {
    const { host, runtime, store } = setup();
    let clock = 1000;
    store.now = () => clock;
    const r = await host.execute({ type: "submit", commandId: "start", text: "go", cwd: "/repo", provider: "fake", role: "default" });
    runtime.last.complete("**Next — you:** buy the headlight.");
    await flush();
    const original = store.thread(r.threadId!)!.ask;
    expect(original).not.toBeNull();
    clock++;
    await host.execute({ type: "clear", commandId: "clear", threadId: r.threadId!, clearedAt: 1001 });
    expect(store.thread(r.threadId!)!.ask).toBeNull();
    expect(store.thread(r.threadId!)!.settled_at).toBeNull();
    host.rebuildAsks();
    expect(store.thread(r.threadId!)!.ask).toBeNull();
    await host.execute({ type: "clear.undo", commandId: "undo", threadId: r.threadId!, clearedAt: 1001 });
    expect(store.thread(r.threadId!)!.ask).toBe(original);
    await host.execute({ type: "clear", commandId: "clear2", threadId: r.threadId!, clearedAt: 1001 });
    clock++;
    await host.execute({ type: "submit", commandId: "new", threadId: r.threadId!, text: "next" });
    runtime.last.complete("**Next — you:** buy the tire.");
    await flush();
    const latest = store.thread(r.threadId!)!.ask;
    await host.execute({ type: "clear.undo", commandId: "undo2", threadId: r.threadId!, clearedAt: 1001 });
    expect(store.thread(r.threadId!)!.ask).toBe(latest);
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "buy the tire." });
  });

  it("a delayed Clear preserves newer handoffs live, after recovery and after Undo", async () => {
    const { host, runtime, store } = setup();
    let clock = 1000;
    store.now = () => clock;
    const r = await host.execute({ type: "submit", commandId: "start", text: "go", cwd: "/repo", provider: "fake", role: "default" });
    await next(host, store, r.threadId!, "human", "fixture-owner", "Review the first result.");
    runtime.last.complete("First result.");
    await flush();
    const cutoff = ++clock;
    clock++;
    await host.execute({ type: "submit", commandId: "new", threadId: r.threadId!, text: "next" });
    await next(host, store, r.threadId!, "human", "fixture-owner", "Review the new result.");
    runtime.last.complete("New result.");
    await flush();
    const latest = store.thread(r.threadId!)!.ask;
    expect(latest).not.toBeNull();
    clock++;
    await host.execute({ type: "clear", commandId: "delayed", threadId: r.threadId!, clearedAt: cutoff });
    expect(store.thread(r.threadId!)!.ask).toBe(latest);
    store.updateThread(r.threadId!, { ask: null });
    host.rebuildAsks();
    expect(store.thread(r.threadId!)!.ask).toBe(latest);
    await host.execute({ type: "clear.undo", commandId: "undo-delayed", threadId: r.threadId!, clearedAt: cutoff });
    expect(store.thread(r.threadId!)!.ask).toBe(latest);
  });

  it("unsettle restores a legacy default without starting a turn or answering a question", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "start", text: "go", cwd: "/repo", provider: "fake", role: "default" });
    runtime.last.emit({ type: "request.opened", runId: r.runId!, requestId: "q", kind: "question", payload: { question: "Which?" } });
    await host.execute({ type: "settle", commandId: "old", threadId: r.threadId! });
    await host.execute({ type: "unsettle", commandId: "restore", threadId: r.threadId! });
    await host.execute({ type: "clear", commandId: "clear", threadId: r.threadId!, clearedAt: 1 });
    expect(store.thread(r.threadId!)!.settled_at).toBeNull();
    expect(store.openRequests(r.threadId!)).toHaveLength(1);
    expect(store.runs(r.threadId!)).toHaveLength(1);
  });

  it("opens from the tool hand-off, and survives another agent's mail", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "draft it", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Three layouts are up.\n\n**Next — you:** pick a layout.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick a layout.", runId: r.runId });
    // Mail from another agent runs a turn; its unrelated completion leaves the owner question standing.
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "✉️ Mail from …\n\nNo cost.", origin: mail });
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick a layout." });
    runtime.last.complete("Noted.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick a layout." });
  });

  it("closes when the owner writes, and a later hand-off replaces or retires it", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    // Errands, so the ask lint (#779) queues no corrective wake between these scripted turns.
    runtime.last.complete("**Next — you:** buy the headlight.");
    await flush();
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "B" });
    expect(askOf(store, r.threadId!)).toBeNull();
    runtime.last.complete("Fitted it.\n\n**Next — you:** order the retainers.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "order the retainers." });
    // Mail starts a turn that ends handing off about the mail: the owner's ask still stands (10/19).
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "✉️ Mail", origin: mail });
    runtime.last.complete("**Next — waiting on CI for PR #744:** then I merge it.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "order the retainers." });
    // A turn the owner started that hands off elsewhere: the agent took it back.
    await host.execute({ type: "submit", commandId: "c4", threadId: r.threadId!, text: "never mind, I'll order them later" });
    runtime.last.complete("**Next — me:** merge once CI is green.");
    await flush();
    expect(askOf(store, r.threadId!)).toBeNull();
  });

  it("an interrupted or failed turn leaves it alone", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** pick.");
    await flush();
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "✉️ Mail", origin: mail });
    runtime.last.emit({ type: "turn.failed", runId: runtime.last.currentRun, failure: { kind: "other", message: "boom" } });
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick." });
  });

  it("rebuilds from history what the live path would hold", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** pick a layout.");
    await flush();
    await host.execute({ type: "submit", commandId: "c2", threadId: a.threadId!, text: "✉️ Mail", origin: mail });
    runtime.last.complete("Noted.");
    await flush();
    const b = await host.execute({ type: "submit", commandId: "c3", text: "go", cwd: "/repo2", provider: "fake" });
    runtime.last.complete("**Next — you:** say go.");
    await flush();
    await host.execute({ type: "submit", commandId: "c4", threadId: b.threadId!, text: "go" });
    runtime.last.complete("**Next — me:** building it.");
    await flush();
    const live = [askOf(store, a.threadId!), askOf(store, b.threadId!)];
    // As if the record had never been kept (threads from before it existed).
    store.updateThread(a.threadId!, { ask: null });
    store.updateThread(b.threadId!, { ask: JSON.stringify({ text: "stale", at: 1, messageId: "x", runId: "y" }) });
    expect(host.rebuildAsks()).toBe(2);
    expect([askOf(store, a.threadId!), askOf(store, b.threadId!)]).toEqual(live);
    expect(live[0]).toMatchObject({ text: "pick a layout." });
    expect(live[1]).toBeNull();
    expect(host.rebuildAsks()).toBe(0);
  });

  it("replays in the live order: a hand-off at its turn's end, a late-recovered answer before it", async () => {
    const { host, runtime, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** pick.");
    await flush();
    const live = askOf(store, a.threadId!);
    const run = store.runs(a.threadId!).at(-1)!;
    // The turn completed a moment after its message; an owner word in that gap came first on the live path.
    store.updateRun(run.id, { ended_at: run.ended_at! + 5_000 });
    // An answered prompt from that turn whose resolve was committed at a restart, long after.
    const req = store.openRequest(a.threadId!, run.id, "question", {}, "r1");
    store.resolveRequest(req.id, "answered", {});
    store.db.prepare("UPDATE requests SET resolved_at = ? WHERE id = ?").run(run.ended_at! + 999_999, req.id);
    store.updateThread(a.threadId!, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, a.threadId!)).toEqual(live);
  });

  it("a hand-off labeled for another agent opens its ask for that agent, and never displaces the owner's ask", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Verified.");
    await flush();
    // The cutover lead mails a continuity check; the thread answers with a request for the lead (7cf32291, 10/20).
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "✉️ Verify your state", origin: { ...mail, name: "T3 cutover handoff" } });
    await next(host, store, r.threadId!, "agent", "loom:other", "dispatch reconciliation of the watcher.");
    runtime.last.complete("GitHub could not resolve the repo.\n\nNext — you (studio lead): dispatch reconciliation of the watcher.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "dispatch reconciliation of the watcher.", to: "T3 cutover handoff", toAddress: "loom:other" });
    // The owner's own ask stands when a later mail turn hands the sender something.
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "do it" });
    runtime.last.complete("**Next — you:** pick a layout.");
    await flush();
    await host.execute({ type: "submit", commandId: "c4", threadId: r.threadId!, text: "✉️ Mail", origin: { ...mail, mailId: "m-2" } });
    await next(host, store, r.threadId!, "agent", "loom:other", "send me the logs.");
    runtime.last.complete("**Next — you:** send me the logs.");
    await flush();
    expect(askOf(store, r.threadId!)).toEqual(expect.objectContaining({ text: "pick a layout." }));
    expect(askOf(store, r.threadId!).to).toBeUndefined();
    // The rebuild reads the labels recorded with the turns, so it agrees.
    const live = askOf(store, r.threadId!);
    store.updateThread(r.threadId!, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, r.threadId!)).toEqual(live);
  });

  it("an unlabeled Next — you opens no owner ask, whoever started the turn (D-353 replaces D-244 fallback)", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Verified.");
    await flush();
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "✉️ Verify your state", origin: { ...mail, name: "T3 cutover handoff" } });
    runtime.last.completeWithoutHandoff("State is intact.\n\nNext — you: send me the run id.");
    await flush();
    expect(askOf(store, r.threadId!)).toBeNull();
    // Finish the single corrective wake before the next mail.
    runtime.last.complete("Recorded.");
    await flush();
    // Only the tool naming the person opens an owner ask.
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "✉️ And?", origin: { ...mail, mailId: "m-2" } });
    await next(host, store, r.threadId!, "human", "fixture-owner", "send the vendor the signed contract.");
    runtime.last.complete("Done.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "send the vendor the signed contract." });
    expect(askOf(store, r.threadId!).to).toBeUndefined();
  });

  it("refuses an agent hand-off without an address Loom knows", async () => {
    const { host, runtime, store } = setup();
    const other = (await host.execute({ type: "submit", commandId: "c0", text: "other", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("Up.");
    await flush();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await expect(label(host, store, r.threadId!, "agent", "do it")).rejects.toThrow(/needs `to`/);
    await expect(label(host, store, r.threadId!, "agent", "do it", "the cutover lead")).rejects.toThrow(/needs `to`/);
    await expect(label(host, store, r.threadId!, "agent", "do it", `loom:${r.threadId}`)).rejects.toThrow(/needs `to`/);
    await expect(label(host, store, r.threadId!, "you", "do it", `loom:${other}`)).rejects.toThrow(/owner "agent" only/);
    // Another Loom thread by id is known without mail from it.
    await label(host, store, r.threadId!, "agent", "review the diff.", `loom:${other}`);
    runtime.last.complete("Up.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "review the diff.", toAddress: `loom:${other}` });
  });

  it("names who acts next by kind and id: the desk's person, another person, a system, this thread, nobody (D-244)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-people-"));
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "owner.yaml"), "display_name: Avery\n");
    const was = process.env.TANGO_PROFILE_DIR;
    process.env.TANGO_PROFILE_DIR = dir;
    onTestFinished(() => { if (was === undefined) delete process.env.TANGO_PROFILE_DIR; else process.env.TANGO_PROFILE_DIR = was; rmSync(dir, { recursive: true, force: true }); });
    const { host, runtime, store } = setup();
    const r = (await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    const turn = async (kind: NextKind, who: string | null, text: string) => {
      await next(host, store, r, kind, who, text);
      runtime.last.complete("Done.");
      await flush();
      const record = host.detail(r)!.thread.closingHandoff!;
      await host.execute({ type: "submit", commandId: `t-${Math.random()}`, threadId: r, text: "go on" });
      return record;
    };
    // The desk's person by name, any case, or by id: their ask.
    expect(await turn("human", "avery", "pick the preferred layout.")).toMatchObject({ owner: "you", next: { kind: "human", who: "avery" } });
    // The owner answered (the "go on"); another person is someone the thread waits on, not the desk's ask.
    expect(await turn("human", "Morgan", "review the finished PR.")).toMatchObject({ owner: "waiting", waitingOn: "Morgan" });
    expect(askOf(store, r)).toBeNull();
    expect(await turn("system", "CI on PR 12", "the build.")).toMatchObject({ owner: "waiting", waitingOn: "CI on PR 12" });
    expect(await turn("agent", `loom:${r}`, "merge once green.")).toMatchObject({ owner: "me" });
    expect(await turn("nobody", null, "done.")).toMatchObject({ owner: "none" });
    await expect(next(host, store, r, "human", "", "x")).rejects.toThrow(/needs `who`/);
    await expect(next(host, store, r, "agent", "the cutover lead", "x")).rejects.toThrow(/doesn't know the agent/);
    await expect(next(host, store, r, "you" as NextKind, "avery", "x")).rejects.toThrow(/kind is one of/);
  });

  it("a native message from another session that wakes the thread is that turn's mail (Codex review on #931)", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** pick a layout.");
    await flush();
    // The harness files the message, then starts the wake turn it caused.
    runtime.last.emit({ type: "peer.message", direction: "in", text: "Verify your state", name: "T3 cutover handoff", address: "loom:other", messageId: "native-1", inline: false });
    let woke = "";
    runtime.last.emit({ type: "wake.started", text: PEER_WAKE_TEXT, bind: (id) => (woke = id) });
    runtime.last.emit({ type: "message.completed", runId: woke, text: "Waiting on CI.\n\nNext — waiting on CI: the build, then I report back." });
    runtime.last.emit({ type: "turn.completed", runId: woke });
    await flush();
    // A hand-off about the mail leaves the owner's ask open, as a mail-started user turn does.
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick a layout." });
    runtime.last.emit({ type: "peer.message", direction: "in", text: "And the logs?", name: "T3 cutover handoff", address: "loom:other", messageId: "native-2", inline: false });
    runtime.last.emit({ type: "wake.started", text: PEER_WAKE_TEXT, bind: (id) => (woke = id) });
    // The sender's address is one the thread has heard from, so the label resolves to it.
    await label(host, store, r.threadId!, "agent", "send me the run id.", "loom:other");
    runtime.last.emit({ type: "message.completed", runId: woke, text: "**Next — you:** send me the run id." });
    runtime.last.emit({ type: "turn.completed", runId: woke });
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick a layout." });
    expect(askOf(store, r.threadId!).to).toBeUndefined();
  });

  it("a native message filed before a restart still names the wake it started", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("**Next — you:** pick a layout.");
    await flush();
    // Filed by a host that then restarted: only the store has it.
    store.addMessage(r.threadId!, null, "user", "Status?", { kind: "peer", mailId: "native-9", inline: false, name: "T3 cutover handoff", from: "loom:other" });
    // A run queued after it (held, not started) doesn't hide it from the wake.
    store.createRun(r.threadId!, "user", "later");
    let woke = "";
    runtime.last.emit({ type: "wake.started", text: PEER_WAKE_TEXT, bind: (id) => (woke = id) });
    runtime.last.emit({ type: "message.completed", runId: woke, text: "**Next — waiting on CI:** then I report back." });
    runtime.last.emit({ type: "turn.completed", runId: woke });
    await flush();
    // The wake is the mail's turn, so its hand-off about the mail leaves the owner's ask open.
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "pick a layout." });
  });

  it("a pointer at a brief is the owner's whoever started the turn, and one at a closed decision closes after a restart too", async () => {
    process.env.LOOM_ASK_LINT = "on";
    onTestFinished(() => { process.env.LOOM_ASK_LINT = "off"; });
    const { host, runtime, store } = setup();
    const raised = (await host.execute({ type: "submit", commandId: "c1", text: "filter work", cwd: "/repo", provider: "fake" })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c2", threadId: raised, brief: {
      default: "A", class: "product-choice-in-scope", about: "Countdown timer", ask: "Active time? Recommend: yes.", door: "two-way", blast: "private", standing: "s", background: "b",
      options: [{ key: "A", label: "Active", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong" }],
      proposedRule: "Next time, for timer copy, use active time without asking",
    } });
    runtime.last.complete("Brief D-4 is up.");
    await flush();
    await host.execute({ type: "decision.close", commandId: "c3", threadId: raised, decisionId: "D-4", outcome: "withdrawn", note: "not needed" });
    const r = (await host.execute({ type: "submit", commandId: "c4", text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("Up.");
    await flush();
    await host.execute({ type: "submit", commandId: "c5", threadId: r, text: "✉️ Status?", origin: { ...mail, name: "T3 cutover handoff" } });
    runtime.last.complete("**Next — you:** answer D-4 on your desk.");
    await flush();
    // Unlabeled, it's the owner's ask, so the lint reads the pointer and finds D-4 already closed.
    expect(store.thread(r)!.ask).toBeNull();
    host.rebuildAsks();
    expect(store.thread(r)!.ask).toBeNull();
  });

  it("a restart keeps an agent's ask cleared when a decision it names closed after it was made", async () => {
    const { host, runtime, store } = setup();
    const raised = (await host.execute({ type: "submit", commandId: "c1", text: "filter work", cwd: "/repo", provider: "fake" })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c2", threadId: raised, brief: {
      default: "A", class: "product-choice-in-scope", about: "Countdown timer", ask: "Active time? Recommend: yes.", door: "two-way", blast: "private", standing: "s", background: "b",
      options: [{ key: "A", label: "Active", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong" }],
      proposedRule: "Next time, for timer copy, use active time without asking",
    } });
    runtime.last.complete("Brief D-4 is up.");
    await flush();
    const r = (await host.execute({ type: "submit", commandId: "c4", text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("Up.");
    await flush();
    await host.execute({ type: "submit", commandId: "c5", threadId: r, text: "✉️ Status?", origin: mail });
    await next(host, store, r, "agent", "loom:other", "answer D-4 on your desk.");
    runtime.last.complete("Asked.");
    await flush();
    expect(askOf(store, r)).toMatchObject({ text: "answer D-4 on your desk.", toAddress: "loom:other" });
    await host.execute({ type: "decision.close", commandId: "c6", threadId: raised, decisionId: "D-4", outcome: "withdrawn", note: "not needed" });
    await flush();
    expect(store.thread(r)!.ask).toBeNull();
    host.rebuildAsks();
    expect(store.thread(r)!.ask).toBeNull();
  });

  it("a restart keeps a later agent ask after a decision the owner ask named settled", async () => {
    const { host, runtime, store } = setup();
    const raised = (await host.execute({ type: "submit", commandId: "c1", text: "filter work", cwd: "/repo", provider: "fake" })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c2", threadId: raised, brief: {
      default: "A", class: "product-choice-in-scope", about: "Countdown timer", ask: "Active time? Recommend: yes.", door: "two-way", blast: "private", standing: "s", background: "b",
      options: [{ key: "A", label: "Active", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong" }],
      proposedRule: "Next time, for timer copy, use active time without asking",
    } });
    runtime.last.complete("Brief D-4 is up.");
    await flush();
    const r = (await host.execute({ type: "submit", commandId: "c4", text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("**Next — you:** answer D-4 on your desk.");
    await flush();
    expect(askOf(store, r)).toMatchObject({ text: "answer D-4 on your desk." });
    await host.execute({ type: "decision.close", commandId: "c6", threadId: raised, decisionId: "D-4", outcome: "withdrawn", note: "not needed" });
    await flush();
    expect(store.thread(r)!.ask).toBeNull();
    await host.execute({ type: "submit", commandId: "c7", threadId: r, text: "✉️ Status?", origin: mail });
    await next(host, store, r, "agent", "loom:other", "send me the logs.");
    runtime.last.complete("Asked.");
    await flush();
    const live = askOf(store, r);
    expect(live).toMatchObject({ text: "send me the logs.", toAddress: "loom:other" });
    store.updateThread(r, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, r)).toEqual(live);
  });

  it("a restart keeps an agent ask whose decision settled during its own turn, before it opened", async () => {
    const { host, runtime, store } = setup();
    const raised = (await host.execute({ type: "submit", commandId: "c1", text: "filter work", cwd: "/repo", provider: "fake" })).threadId!;
    await host.execute({ type: "decision.request", commandId: "c2", threadId: raised, brief: {
      default: "A", class: "product-choice-in-scope", about: "Countdown timer", ask: "Active time? Recommend: yes.", door: "two-way", blast: "private", standing: "s", background: "b",
      options: [{ key: "A", label: "Active", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong" }],
      proposedRule: "Next time, for timer copy, use active time without asking",
    } });
    runtime.last.complete("Brief D-4 is up.");
    await flush();
    const r = (await host.execute({ type: "submit", commandId: "c4", text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    runtime.last.complete("Up.");
    await flush();
    await host.execute({ type: "submit", commandId: "c5", threadId: r, text: "✉️ Status?", origin: mail });
    await next(host, store, r, "agent", "loom:other", "carry out D-4's outcome and tell me.");
    await new Promise((done) => setTimeout(done, 2));
    await host.execute({ type: "decision.close", commandId: "c6", threadId: raised, decisionId: "D-4", outcome: "withdrawn", note: "not needed" });
    await new Promise((done) => setTimeout(done, 2));
    runtime.sessions.find((s) => s.options.threadId === r)!.complete("Asked.");
    await flush();
    const live = askOf(store, r);
    expect(live).toMatchObject({ toAddress: "loom:other" });
    store.updateThread(r, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, r)).toEqual(live);
  });

  it("a worker's failure report starts the lead's turn as mail does: the lead's own next step keeps the owner's ask", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a worker.");
    await flush();
    const worker = (await host.execute({ type: "submit", commandId: "c2", text: "build it", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    const leadSession = () => runtime.sessions.find((s) => s.options.threadId === lead)!;
    await host.execute({ type: "submit", commandId: "c3", threadId: lead, text: "status?" });
    leadSession().complete("The worker is running; setup still needs your sign-in.\n\n**Next — you:** sign in to the console.");
    await flush();
    expect(askOf(store, lead)).toMatchObject({ text: "sign in to the console." });
    const workerSession = runtime.sessions.find((s) => s.options.threadId === worker)!;
    workerSession.emit({ type: "turn.failed", runId: workerSession.currentRun, failure: { kind: "other", message: "boom" } });
    await flush();
    expect(store.activeRun(lead)?.source).toBe("wake");
    await next(host, store, lead, "agent", `loom:${lead}`, "investigate the worker failure.");
    leadSession().complete("Looking.");
    await flush();
    expect(askOf(store, lead)).toMatchObject({ text: "sign in to the console." });
    store.updateThread(lead, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, lead)).toMatchObject({ text: "sign in to the console." });
  });

  it("a restart keeps a worker's ask cleared when its lead marks the worker's own brief moot (D-309)", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a worker.");
    await flush();
    const worker = (await host.execute({ type: "submit", commandId: "c2", text: "build it", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    const workerSession = () => runtime.sessions.find((s) => s.options.threadId === worker)!;
    const { decisionId: id } = await host.execute({ type: "decision.request", commandId: "c3", threadId: worker, brief: {
      default: "A", class: "plan-approval", about: "Merge", ask: "Merge #956? Recommend: yes.", door: "two-way", blast: "private", standing: "s", background: "b",
      options: [{ key: "A", label: "Merge", consequence: "Ships", recommended: true }, { key: "B", label: "Hold", consequence: "Waits" }],
      proposedRule: "Next time, for green PRs, merge without asking",
    } });
    // Long enough not to read as a bare pointer, as D-309's was: only the decision closing retires it.
    workerSession().complete(`**Next — you:** Resolve ${id}, raised under the review-cap instruction. Latest review is clean and CI is green; recommend merge and deploy.`);
    await flush();
    expect(askOf(store, worker)).toMatchObject({ text: expect.stringMatching(new RegExp(`^Resolve ${id},`)) });
    await host.execute({ type: "decision.close", commandId: "c4", threadId: lead, decisionId: id!, outcome: "moot", note: "merge-when-green covers it" });
    expect(store.thread(worker)!.ask).toBeNull();
    // Told so, the worker carries on and hands its report to the lead.
    await next(host, store, worker, "agent", `loom:${lead}`, "merged and deployed; review and report to the owner.");
    workerSession().complete("Merged.");
    await flush();
    expect(askOf(store, worker)).toMatchObject({ toAddress: `loom:${lead}` });
    const live = askOf(store, worker);
    host.rebuildAsks();
    expect(askOf(store, worker)).toEqual(live);
  });

  it("the thread's own later hand-off closes an ask another agent's mail opened, whoever started either turn", async () => {
    const { host, runtime, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Up.");
    await flush();
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId!, text: "✉️ Verify", origin: { ...mail, name: "T3 cutover handoff" } });
    await label(host, store, r.threadId!, "agent", "dispatch the reconciliation.", "loom:other");
    runtime.last.complete("**Next — you:** dispatch the reconciliation.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ to: "T3 cutover handoff" });
    // A different agent's mail; the thread's closing word says nothing is left (7cf32291's 13:16 "Next — none").
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "✉️ Archived", origin: { kind: "peer", name: "Cutover reconciliation", mailId: "m-3" } });
    runtime.last.complete("The concern is resolved.\n\nNext — none: read-only continuity verification done.");
    await flush();
    expect(askOf(store, r.threadId!)).toBeNull();
    // A wake is the thread's own work: its hand-off retires an owner's ask too.
    await host.execute({ type: "submit", commandId: "c4", threadId: r.threadId!, text: "go on" });
    runtime.last.complete("**Next — you:** approve the merge.");
    await flush();
    expect(askOf(store, r.threadId!)).toMatchObject({ text: "approve the merge." });
    store.tx(() => { store.createRun(r.threadId!, "wake", "Loom: the trigger you set fired: CI"); });
    await host.kick(r.threadId!);
    runtime.last.complete("Merged under the board.\n\n**Next — none:** done.");
    await flush();
    expect(askOf(store, r.threadId!)).toBeNull();
    // The rebuild arrives at the same place.
    store.updateThread(r.threadId!, { ask: JSON.stringify({ text: "stale", at: 1, messageId: "x", runId: "y" }) });
    host.rebuildAsks();
    expect(askOf(store, r.threadId!)).toBeNull();
  });

  it("a rebuild keeps the audience the turn recorded: deleting the agent it named doesn't move the ask", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a worker.");
    const worker = (await host.execute({ type: "submit", commandId: "c2", text: "build it", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    runtime.sessions.find((s) => s.options.threadId === worker)!.complete("Built.");
    await flush();
    await host.execute({ type: "submit", commandId: "c3", threadId: lead, text: "✉️ Worker report", origin: { kind: "peer", name: "build it", from: `loom:${worker}`, mailId: "w-1" } });
    await next(host, store, lead, "agent", `loom:${worker}`, "rerun the build with the cache off.");
    runtime.sessions.find((s) => s.options.threadId === lead)!.complete("**Next — you:** rerun the build with the cache off.");
    await flush();
    const live = askOf(store, lead);
    expect(live).toMatchObject({ to: "build it", toAddress: `loom:${worker}` });
    await host.execute({ type: "delete", commandId: "c4", threadId: worker });
    store.updateThread(lead, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, lead)).toEqual(live);
  });

  it("an ask answering the thread's own worker, or Loom's own word, stays the owner's", async () => {
    const { host, runtime, store } = setup();
    const lead = (await host.execute({ type: "submit", commandId: "c1", text: "run the space", cwd: "/repo", provider: "fake", role: "default" })).threadId!;
    runtime.last.complete("Started a worker.");
    const worker = (await host.execute({ type: "submit", commandId: "c2", text: "build it", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` })).threadId!;
    runtime.sessions.find((s) => s.options.threadId === worker)!.complete("Built.");
    await flush();
    const leadSession = () => runtime.sessions.find((s) => s.options.threadId === lead)!;
    await host.execute({ type: "submit", commandId: "c3", threadId: lead, text: "✉️ Worker report", origin: { kind: "peer", name: "build it", from: `loom:${worker}`, mailId: "w-1" } });
    leadSession().complete("The worker needs a sign-in.\n\n**Next — you:** sign in to the console.");
    await flush();
    expect(askOf(store, lead)).toMatchObject({ text: "sign in to the console." });
    expect(askOf(store, lead).to).toBeUndefined();
    await host.execute({ type: "submit", commandId: "c4", threadId: lead, text: "done" });
    leadSession().complete("Thanks.");
    await flush();
    store.tx(() => {
      const run = store.createRun(lead, "user", "Loom: decision D-9 is settled");
      store.addMessage(lead, run.id, "user", "Loom: decision D-9 is settled", { kind: "peer", name: "Loom", from: `loom:${worker}` });
    });
    await host.kick(lead);
    leadSession().complete("**Next — you:** review the result.");
    await flush();
    expect(askOf(store, lead)).toMatchObject({ text: "review the result." });
    expect(askOf(store, lead).to).toBeUndefined();
    // The rebuild agrees.
    const live = askOf(store, lead);
    store.updateThread(lead, { ask: null });
    host.rebuildAsks();
    expect(askOf(store, lead)).toEqual(live);
  });

  it("reads only a closing hand-off", () => {
    expect(closingHandoff("Done.\n\n**Next — you:** merge #12")).toEqual({ owner: "you", text: "merge #12" });
    expect(closingHandoff("I said **Next — you:** earlier.\n\nMore words.\n1\n2\n3\n4\n5\n6\n7\n8\n9")).toBeNull();
    expect(closingHandoff("**Next — waiting on Ryan:** review")).toMatchObject({ owner: "waiting" });
  });
});

it("waiting on the owner is an owner handoff", () => {
  for (const who of ["you", "the owner", "owner", "user", "the user"]) {
    expect(closingHandoff(`Next — waiting on ${who}: sign in`)).toEqual({ owner: "you", text: "sign in" });
  }
  const previous = process.env.TANGO_OWNER_NAME;
  try {
    process.env.TANGO_OWNER_NAME = "Avery";
    expect(closingHandoff("Next — waiting on Avery: sign in")).toEqual({ owner: "you", text: "sign in" });
    expect(closingHandoff("Next — waiting on Ana: review")).toEqual({ owner: "waiting", text: "review" });
  } finally {
    if (previous === undefined) delete process.env.TANGO_OWNER_NAME;
    else process.env.TANGO_OWNER_NAME = previous;
  }
});
