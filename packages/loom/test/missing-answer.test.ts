import { afterEach, describe, expect, it } from "vitest";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { MISSING_ANSWER_WAKE_PREFIX } from "../src/handoff.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function setup() {
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  cleanups.push(async () => { await host.closeAll(); store.close(); });
  return { store, runtime, host };
}
const start = (host: LoomHost, text = "Is this the new bridge or the old bridge?", extra = {}) => host.execute({ type: "submit", commandId: crypto.randomUUID(), cwd: "/repo", provider: "fake", text, ...extra });

describe("missing written answer", () => {
  it.each(["", "**Next — you:** build the Shortcut and report back.", "Next — none: done."])("wakes exactly once for %j despite a recorded handoff", async text => {
    const { store, host, runtime } = setup();
    const result = await start(host);
    const session = runtime.last;
    session.complete(text); await flush();
    const wake = store.runs(result.threadId!).at(-1)!;
    expect(wake).toMatchObject({ source: "wake", wake_cause: "corrective" });
    expect(wake.text).toContain(MISSING_ANSWER_WAKE_PREFIX);
    expect(host.detail(result.threadId!)!.runs.at(-1)).toMatchObject({ answers_run_id: result.runId });
    expect(wake.text).toContain("Is this the new bridge or the old bridge?");
    session.emit({ type: "turn.completed", runId: result.runId! }); await flush();
    expect(store.runs(result.threadId!)).toHaveLength(2);
    session.complete(text); await flush();
    expect(store.runs(result.threadId!)).toHaveLength(2);
  });

  it("re-recording the same ask and arming a wait do not replace the answer", async () => {
    const { store, host, runtime } = setup();
    const first = await start(host, "Set up the test.");
    runtime.last.complete("**Next — you:** build the Shortcut and report back."); await flush();
    const next = await host.execute({ type: "submit", commandId: "question", threadId: first.threadId!, text: "Is that the new bridge?" });
    await host.execute({ type: "trigger.create", commandId: "wait", threadId: first.threadId!, kind: "time", spec: { afterMinutes: 60 }, note: "scheduled check" });
    runtime.last.complete("**Next — you:** build the Shortcut and report back."); await flush();
    expect(store.runs(first.threadId!).at(-1)!.text).toContain(MISSING_ANSWER_WAKE_PREFIX);
    expect(store.runs(first.threadId!).filter(run => run.text.startsWith(MISSING_ANSWER_WAKE_PREFIX))).toHaveLength(1);
    expect(store.run(next.runId!)!.status).toBe("completed");
  });

  it.each(["same message", "separate message"])("accepts a written answer in the %s as the closing line", async mode => {
    const { store, host, runtime } = setup();
    const result = await start(host);
    const answer = "It is the same bridge, with the new wording deployed.";
    if (mode === "separate message") runtime.last.emit({ type: "message.completed", runId: result.runId!, text: answer });
    runtime.last.complete(`${mode === "same message" ? answer + "\n\n" : ""}**Next — you:** build the Shortcut and report back.`);
    await flush();
    expect(store.runs(result.threadId!)).toHaveLength(1);
  });

  it.each(["statement", "peer", "wake", "reset", "opt-out", "failed", "stopped"])("does not correct %s", async mode => {
    const { store, host, runtime } = setup();
    const result = await start(host, mode === "statement" ? "Thanks, continue." : undefined, mode === "opt-out" ? { session: { loomTools: false } } : {});
    if (mode === "peer") store.db.prepare("UPDATE messages SET origin=? WHERE run_id=? AND role='user'").run(JSON.stringify({ kind: "peer", from: "loom:other" }), result.runId!);
    if (mode === "wake" || mode === "reset") store.db.prepare("UPDATE runs SET source=? WHERE id=?").run(mode, result.runId!);
    if (mode === "failed") runtime.last.emit({ type: "turn.failed", runId: result.runId!, failure: { kind: "interrupted", message: "cancelled" } });
    else if (mode === "stopped") await host.execute({ type: "stop", commandId: "stop", threadId: result.threadId! });
    else runtime.last.complete("**Next — none:** done.");
    await flush();
    expect(store.runs(result.threadId!).some(run => run.text.startsWith(MISSING_ANSWER_WAKE_PREFIX))).toBe(false);
  });

  it("does not count an earlier answer before an owner steers in a new question", async () => {
    const { store, host, runtime } = setup();
    const result = await start(host);
    runtime.last.emit({ type: "message.completed", runId: result.runId!, text: "It is the same bridge." });
    await host.execute({ type: "submit", commandId: "steer", threadId: result.threadId!, text: "Does it go through the operator?", steer: true });
    runtime.last.complete("**Next — none:** done."); await flush();
    expect(store.runs(result.threadId!).at(-1)!.text).toContain("Does it go through the operator?");
  });
});
