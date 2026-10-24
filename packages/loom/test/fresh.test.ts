import { describe, expect, it } from "vitest";
import { freshPolicy, HANDOFF_PROMPT, type FreshPolicy } from "../src/fresh.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(mode: FreshPolicy["mode"]) {
  const store = new LoomStore(":memory:");
  let now = 1_800_000_000_000;
  store.now = () => now;
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime }, { fresh: { mode, soft: 150_000, idleMs: 3_600_000, idleMin: 80_000 }, claudeProjectsDir: "/loom/claude-projects", backgroundSettleMs: 0 });
  const advance = (ms: number) => { now += ms; };
  return { store, runtime, host, advance };
}

/** One turn on the live session that reports a context size. */
function answer(runtime: FakeRuntime, context: number, text = "done") {
  const session = runtime.last;
  session.emit({ type: "context.observed", runId: session.currentRun, context, cacheRead: context, cacheWrite: 0, output: 10 });
  session.complete(text);
}

async function started(host: LoomHost, runtime: FakeRuntime, context: number) {
  const r = await host.execute({ type: "submit", commandId: "c1", text: "build it", cwd: "/repo", provider: "fake" });
  runtime.last.emit({ type: "session.native", nativeSessionId: "native-1" });
  answer(runtime, context);
  await flush();
  return r.threadId!;
}

describe("fresh sessions", () => {
  it("past the soft threshold: one handoff turn, then the next run opens a new session from the packet", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 212_000);
    // The handoff turn runs on the old session.
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.last.turns.at(-1)!.text).toBe(HANDOFF_PROMPT);
    expect(host.saveHandoff(id, { summary: "Phase 3 is half built", next: "write the tests" })).toMatchObject({ ok: true });
    answer(runtime, 213_000, "Saved.");
    await flush();
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "soft-threshold", previousSession: "native-1" });

    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "carry on" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.sessions[0]!.closed).toBe(true);
    expect(runtime.last.options.nativeSessionId).toBeNull();
    const first = runtime.last.turns[0]!.text;
    for (const piece of ["this is a fresh session", "# Loom: this thread's state", "Phase 3 is half built", "write the tests", "/loom/claude-projects/-repo/native-1.jsonl", "carry on"]) expect(first).toContain(piece);
    // The mark is spent only once the new session reports in.
    expect(store.thread(id)!.fresh).not.toBeNull();
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-2" });
    expect(store.thread(id)!.fresh).toBeNull();
    expect(host.ledger.timeline(id).some((e: any) => e.kind === "fresh" && e.summary.includes("213k"))).toBe(true);
    // The fresh session's next turn is ordinary.
    answer(runtime, 50_000);
    await flush();
    await host.execute({ type: "submit", commandId: "c3", threadId: id, text: "next" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns.at(-1)!.text).toBe("next");
  });

  it("a handoff turn that compacted the session keeps it: nothing left to save", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 212_000);
    expect(runtime.last.turns.at(-1)!.text).toBe(HANDOFF_PROMPT);
    answer(runtime, 33_000, "Saved.");
    await flush();
    expect(store.thread(id)!.fresh).toBeNull();
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "carry on" });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.last.turns.at(-1)!.text).toBe("carry on");
  });

  it("queues mail that arrives during the handoff turn for the fresh session", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 212_000);
    expect(runtime.last.turns.at(-1)!.text).toBe(HANDOFF_PROMPT);
    const mail = await host.execute({ type: "submit", commandId: "m1", threadId: id, text: "✉️ Mail: please also check CI", steer: true });
    expect(mail.steered).toBeFalsy();
    expect(runtime.last.injected).toEqual([]);
    answer(runtime, 213_000, "Saved.");
    // The reset's close and the fresh open take more than one tick under load.
    for (let i = 0; i < 50 && runtime.sessions.length < 2; i++) await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns[0]!.text).toContain("please also check CI");
    expect(store.thread(id)!.fresh).not.toBeNull();
  });

  it("workers mode resets workers and only logs for every other role", async () => {
    const { store, runtime, host } = setup("workers");
    const r = await host.execute({ type: "submit", commandId: "w1", text: "build it", cwd: "/repo", provider: "fake", role: "worker" } as never);
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-w" });
    answer(runtime, 212_000);
    await flush();
    expect(store.thread(r.threadId!)!.role).toBe("worker");
    expect(runtime.last.turns.at(-1)!.text).toBe(HANDOFF_PROMPT);
    const other = setup("workers");
    const id = await started(other.host, other.runtime, 212_000);
    expect(other.runtime.last.turns.map((t) => t.text)).toEqual(["build it"]);
    expect(other.host.ledger.timeline(id).some((e: any) => e.kind === "fresh-shadow")).toBe(true);
    expect(freshPolicy({ LOOM_FRESH_SESSIONS: "workers" }).mode).toBe("workers");
  });

  it("workers mode drops a worker's automatic mark once it is no longer a worker", async () => {
    const { store, runtime, host } = setup("workers");
    const r = await host.execute({ type: "submit", commandId: "w1", text: "build it", cwd: "/repo", provider: "fake", role: "worker" } as never);
    const id = r.threadId!;
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-w" });
    answer(runtime, 50_000);
    await flush();
    store.updateThread(id, { fresh: JSON.stringify({ reason: "task-done", context: 50_000, at: store.now(), previousSession: "native-w" }) });
    await host.execute({ type: "role", commandId: "r1", threadId: id, role: "interactive" });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "keep going" });
    await flush();
    // The role overlay changes, so reopen the host but resume the native conversation.
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options.nativeSessionId).toBe("native-w");
    expect(runtime.last.turns.at(-1)!.text).toBe("keep going");
    expect(store.thread(id)!.fresh).toBeNull();
  });

  it("shadow mode only says what it would do, once per session", async () => {
    const { store, runtime, host } = setup("shadow");
    const id = await started(host, runtime, 400_000);
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "more" });
    await flush();
    answer(runtime, 410_000);
    await flush();
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["build it", "more"]);
    expect(store.thread(id)!.fresh ?? null).toBeNull();
    expect(host.ledger.timeline(id).filter((e: any) => e.kind === "fresh-shadow").map((e: any) => e.summary)).toEqual(["Would start a fresh session (soft-threshold, context 400k)"]);
  });

  it("a cold cache past the idle minimum starts fresh without a handoff turn", async () => {
    const { runtime, host, advance } = setup("on");
    const id = await started(host, runtime, 100_000);
    expect(runtime.last.turns).toHaveLength(1);
    advance(2 * 3_600_000);
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "back again" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns[0]!.text).toContain("No handoff was saved");
    // The previous session's last reply stands in for it.
    expect(runtime.last.turns[0]!.text).toContain("done");
    expect(runtime.last.turns[0]!.text).toContain("back again");
  });

  it("a lead's idle reset with no handoff asks the fresh session to write one; a thread without workers isn't asked", async () => {
    for (const lead of [true, false]) {
      const { store, runtime, host, advance } = setup("on");
      const id = await started(host, runtime, 100_000);
      if (lead) {
        const w = await host.execute({ type: "submit", commandId: "w1", text: "sub task", cwd: "/repo", provider: "fake", role: "worker" } as never);
        store.updateThread(w.threadId!, { parent_thread_id: `loom:${id}` });
        answer(runtime, 10_000);
        await flush();
      }
      advance(2 * 3_600_000);
      await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "back again" });
      await flush();
      const packet = runtime.sessions.at(-1)!.turns[0]!.text;
      expect(packet).toContain("No handoff was saved");
      expect(packet.includes("call `loom.save_handoff` once")).toBe(lead);
      if (!lead) {
        // Not asked for, a save in the fresh session's first run is a task's end as usual.
        runtime.last.emit({ type: "session.native", nativeSessionId: "native-2" });
        expect(host.saveHandoff(id, { summary: "Task done" })).toMatchObject({ ok: true });
        expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done" });
        continue;
      }
      // The save it asks for is not a task's end: the session it was just opened in carries on.
      runtime.last.emit({ type: "session.native", nativeSessionId: "native-3" });
      expect(host.saveHandoff(id, { summary: "Lead: the build is on track" })).toMatchObject({ ok: true });
      answer(runtime, 40_000);
      await flush();
      expect(store.thread(id)!.fresh).toBeNull();
      const opened = runtime.sessions.length;
      await host.execute({ type: "submit", commandId: "c3", threadId: id, text: "and next" });
      await flush();
      expect(runtime.sessions).toHaveLength(opened);
      // A second save is a task's end again: the next task starts fresh.
      expect(host.saveHandoff(id, { summary: "Lead: phase done" })).toMatchObject({ ok: true });
      expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done" });
    }
  });

  it("a lead's asked-for handoff lapses with the packet's run: a later save is a task's end", async () => {
    const { store, runtime, host, advance } = setup("on");
    const id = await started(host, runtime, 100_000);
    const w = await host.execute({ type: "submit", commandId: "w1", text: "sub task", cwd: "/repo", provider: "fake", role: "worker" } as never);
    store.updateThread(w.threadId!, { parent_thread_id: `loom:${id}` });
    answer(runtime, 10_000);
    await flush();
    advance(2 * 3_600_000);
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "back again" });
    await flush();
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-3" });
    // The packet's run ends without the save it asked for.
    answer(runtime, 40_000);
    await flush();
    await host.execute({ type: "submit", commandId: "c3", threadId: id, text: "next task" });
    await flush();
    expect(host.saveHandoff(id, { summary: "Next task done" })).toMatchObject({ ok: true });
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done" });
  });

  it("never resets under the threshold, with background work running, or when off", async () => {
    for (const [mode, context, background] of [["on", 120_000, false], ["on", 300_000, true], ["off", 900_000, false]] as const) {
      const { store, runtime, host, advance } = setup(mode);
      const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
      runtime.last.emit({ type: "session.native", nativeSessionId: "native-1" });
      if (background) runtime.last.emit({ type: "background.changed", tasks: [{ id: "t1", kind: "local_bash", description: "npm test" }] });
      answer(runtime, context);
      await flush();
      advance(30 * 60_000);
      await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "again" });
      await flush();
      expect(runtime.sessions).toHaveLength(1);
      expect(runtime.last.turns.map((t) => t.text)).toEqual(["go", "again"]);
      expect(store.thread(r.threadId!)!.fresh ?? null).toBeNull();
    }
  });

  it("checks a pending reset again: work started since defers it, an opted-out profile cancels it", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 212_000);
    answer(runtime, 213_000, "Saved.");
    await flush();
    expect(store.thread(id)!.fresh).not.toBeNull();
    runtime.last.emit({ type: "background.changed", tasks: [{ id: "t1", kind: "local_bash", description: "npm test" }] });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "while it runs" });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.sessions[0]!.closed).toBe(false);
    expect(store.thread(id)!.fresh).not.toBeNull();
    // The task ends and the profile opts out: the mark is dropped and the session resumes, not starts fresh.
    runtime.last.emit({ type: "background.changed", tasks: [] });
    answer(runtime, 214_000);
    await flush();
    store.updateThread(id, { session_profile: JSON.stringify({ loomTools: false }) });
    await host.execute({ type: "submit", commandId: "c3", threadId: id, text: "isolated now" });
    await flush();
    expect(store.thread(id)!.fresh).toBeNull();
    expect(runtime.last.options.nativeSessionId).toBe("native-1");
    expect(runtime.last.turns.at(-1)!.text).toBe("isolated now");
  });

  it("carries replies the handoff doesn't cover, and drops a pending mark once switched off", async () => {
    const { runtime, host, advance } = setup("on");
    const id = await started(host, runtime, 212_000);
    host.saveHandoff(id, { summary: "handed off" });
    advance(1_000);
    answer(runtime, 213_000, "Saved.");
    await flush();
    // A deferred reset lets a turn run on the old session after the handoff.
    runtime.last.emit({ type: "background.changed", tasks: [{ id: "t1", kind: "local_bash", description: "npm test" }] });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "meanwhile" });
    await flush();
    advance(1_000);
    runtime.last.emit({ type: "background.changed", tasks: [] });
    answer(runtime, 214_000, "Decided to keep the 150k threshold.");
    await flush();
    await host.execute({ type: "submit", commandId: "c3", threadId: id, text: "fresh now" });
    await flush();
    const first = runtime.last.turns[0]!.text;
    expect(first).toContain("handed off");
    expect(first).toContain("Decided to keep the 150k threshold.");

    const off = setup("off");
    const offId = await started(off.host, off.runtime, 10_000);
    off.store.updateThread(offId, { fresh: JSON.stringify({ reason: "soft-threshold", context: 1, at: 0, previousSession: "native-1" }) });
    await off.host.execute({ type: "submit", commandId: "c2", threadId: offId, text: "again" });
    await flush();
    expect(off.store.thread(offId)!.fresh).toBeNull();
    expect(off.runtime.sessions).toHaveLength(1);
  });

  it("a handoff saved at a task's end starts the next run fresh", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 40_000);
    expect(host.saveHandoff(id, { summary: "Task A done; B is separate" })).toMatchObject({ ok: true });
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done", previousSession: "native-1" });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "start B" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns[0]!.text).toContain("Task A done; B is separate");
  });

  it("switched off, a queued handoff turn is canceled instead of sent", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime }, { fresh: { mode: "off", soft: 150_000, idleMs: 3_600_000, idleMin: 80_000 }, backgroundSettleMs: 0 });
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    runtime.last.complete();
    await flush();
    const reset = store.createRun(r.threadId!, "reset", HANDOFF_PROMPT);
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "next" });
    await flush();
    expect(store.run(reset.id)!.status).toBe("canceled");
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["go", "next"]);
  });

  it("a queued handoff turn is canceled once the profile opts out", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 212_000);
    // The handoff turn is running; queue another one as a restart would find it, then opt the profile out.
    answer(runtime, 213_000, "Saved.");
    await flush();
    store.updateThread(id, { fresh: null, session_profile: JSON.stringify({ loomTools: false }) });
    const reset = store.createRun(id, "reset", HANDOFF_PROMPT);
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "isolated" });
    await flush();
    expect(store.run(reset.id)!.status).toBe("canceled");
    expect(runtime.last.turns.at(-1)!.text).toBe("isolated");
  });

  it("refuses a handoff without a summary or for a missing thread", async () => {
    const { runtime, host } = setup("on");
    const id = await started(host, runtime, 10_000);
    expect(host.saveHandoff(id, { next: "x" })).toEqual({ ok: false, code: "summary_required" });
    expect(host.saveHandoff("missing", { summary: "x" })).toEqual({ ok: false, code: "not_found" });
  });

  it("a kept session is never reset automatically, and keeping it drops a pending mark (TGO-1108)", async () => {
    const { store, runtime, host, advance } = setup("on");
    const id = await started(host, runtime, 40_000);
    host.saveHandoff(id, { summary: "Task A done" });
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done" });
    expect(await host.keepSession(id, true)).toEqual({ ok: true, keep: true });
    const held = store.createRun(id, "reset", HANDOFF_PROMPT);
    await host.keepSession(id, true);
    expect(store.run(held.id)!.status).toBe("canceled");
    expect(store.thread(id)!.fresh ?? null).toBeNull();
    // Past the soft threshold: no handoff turn.
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "big" });
    await flush();
    answer(runtime, 300_000);
    await flush();
    expect(runtime.last.turns.map((t) => t.text)).toEqual(["build it", "big"]);
    // A cold cache: the session resumes.
    advance(2 * 3_600_000);
    await host.execute({ type: "submit", commandId: "c3", threadId: id, text: "back" });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.last.turns.at(-1)!.text).toBe("back");
    // A queued handoff turn from before is canceled.
    answer(runtime, 300_000);
    await flush();
    const reset = store.createRun(id, "reset", HANDOFF_PROMPT);
    await host.execute({ type: "submit", commandId: "c4", threadId: id, text: "again" });
    await flush();
    expect(store.run(reset.id)!.status).toBe("canceled");
    expect(host.ledger.timeline(id).some((e: any) => e.kind === "fresh-keep")).toBe(true);
    // Switched back, the policy applies again.
    answer(runtime, 300_000);
    await flush();
    await host.keepSession(id, false);
    expect(store.thread(id)!.fresh_opt_out ?? null).toBeNull();
  });

  it("the owner's Fresh start opens a new session next turn, kept or not, and in shadow mode too", async () => {
    const { store, runtime, host } = setup("shadow");
    const id = await started(host, runtime, 60_000);
    await host.keepSession(id, true);
    expect(await host.freshStart(id)).toMatchObject({ ok: true });
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "owner", previousSession: "native-1" });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "start over" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options.nativeSessionId).toBeNull();
    expect(runtime.last.turns[0]!.text).toContain("this is a fresh session");
    expect(runtime.last.turns[0]!.text).toContain("start over");
    expect(await host.freshStart("missing")).toEqual({ ok: false, code: "not_found" });
  });

  it("Fresh start cancels a handoff turn already queued, so the owner's turn opens the new session directly", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 60_000);
    const reset = store.createRun(id, "reset", HANDOFF_PROMPT);
    expect(await host.freshStart(id)).toMatchObject({ ok: true });
    expect(store.run(reset.id)!.status).toBe("canceled");
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "over" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns.map((t) => t.text).some((t) => t === HANDOFF_PROMPT)).toBe(false);
  });

  it("canceling the only queued handoff turn clears a hold waiting for room (Codex review on #840)", async () => {
    for (const act of ["keep", "fresh"] as const) {
      const { store, runtime, host } = setup("on");
      const id = await started(host, runtime, 60_000);
      const reset = store.createRun(id, "reset", HANDOFF_PROMPT);
      store.updateThread(id, { admission: "account_limit", admission_until: store.now() + 3_600_000 });
      expect(act === "keep" ? await host.keepSession(id, true) : await host.freshStart(id)).toMatchObject({ ok: true });
      expect(store.run(reset.id)!.status).toBe("canceled");
      expect(store.thread(id)!.admission ?? null).toBeNull();
      expect(store.thread(id)!.admission_until ?? null).toBeNull();
      // Other queued work keeps the hold.
      const other = setup("on");
      const id2 = await started(other.host, other.runtime, 60_000);
      other.store.createRun(id2, "reset", HANDOFF_PROMPT);
      other.store.createRun(id2, "wake", "later");
      other.store.updateThread(id2, { admission: "account_limit" });
      await (act === "keep" ? other.host.keepSession(id2, true) : other.host.freshStart(id2));
      expect(other.store.thread(id2)!.admission).toBe("account_limit");
    }
  });

  it("Fresh start is refused while background work or a question would be cut off", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 60_000);
    store.updateThread(id, { background: JSON.stringify([{ id: "bg1", kind: "local_bash", description: "npm test" }]) });
    expect(await host.freshStart(id)).toMatchObject({ ok: false, code: "busy" });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
  });

  it("Fresh start is refused while a turn is running", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 60_000);
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "long one" });
    await flush();
    expect(await host.freshStart(id)).toMatchObject({ ok: false, code: "busy" });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
  });

  it("Fresh start waits behind a dispatch already under way, so it never lands between its steps", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 60_000);
    // Queued and dispatching, not yet running: Fresh start sees it running once its turn in the mailbox comes.
    const submitted = host.execute({ type: "submit", commandId: "c2", threadId: id, text: "in flight" });
    const asked = host.freshStart(id);
    await submitted;
    expect(await asked).toMatchObject({ ok: false, code: "busy" });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
  });

  it("a worker that settles has finished its task: the parent's follow-up opens a fresh session", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 40_000);
    store.updateThread(id, { role: "worker" });
    host.saveHandoff(id, { summary: "Built the importer; PR #12" });
    store.updateThread(id, { fresh: null });
    await host.execute({ type: "settle", commandId: "s1", threadId: id });
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done", previousSession: "native-1" });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "one more fix" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns[0]!.text).toContain("Built the importer");
  });

  it("a worker whose PR merged has finished its task: its next turn opens a fresh session", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 40_000);
    store.updateThread(id, { role: "worker" });
    host.saveHandoff(id, { summary: "Built the importer; PR #12" });
    store.updateThread(id, { fresh: null });
    expect(await host.taskEnded(id, "PR #12 merged")).toEqual({ ok: true, marked: true });
    expect(JSON.parse(store.thread(id)!.fresh!)).toMatchObject({ reason: "task-done", previousSession: "native-1" });
    expect(host.ledger.timeline(id).some((e: any) => e.kind === "fresh-task-ended" && e.summary.includes("PR #12 merged"))).toBe(true);
    // A second sighting changes nothing.
    expect(await host.taskEnded(id, "PR #12 merged")).toEqual({ ok: true, marked: false });
    await host.execute({ type: "submit", commandId: "c2", threadId: id, text: "one more fix" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.turns[0]!.text).toContain("Built the importer");
  });

  it("a merged PR leaves interactive threads, kept workers and shadow mode alone", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 40_000);
    expect(await host.taskEnded(id, "PR #12 merged")).toEqual({ ok: true, marked: false });
    store.updateThread(id, { role: "worker", fresh_opt_out: 1 });
    expect(await host.taskEnded(id, "PR #12 merged")).toEqual({ ok: true, marked: false });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
    expect(await host.taskEnded("missing", "PR #12 merged")).toEqual({ ok: false, code: "not_found" });
    const shadow = setup("shadow");
    const id2 = await started(shadow.host, shadow.runtime, 40_000);
    shadow.store.updateThread(id2, { role: "worker" });
    expect(await shadow.host.taskEnded(id2, "PR #12 merged")).toEqual({ ok: true, marked: false });
    expect(shadow.host.ledger.timeline(id2).some((e: any) => e.kind === "fresh-shadow" && e.summary.includes("task-done"))).toBe(true);
  });

  it("settling an interactive thread or a kept worker doesn't reset it", async () => {
    const { store, runtime, host } = setup("on");
    const id = await started(host, runtime, 40_000);
    await host.execute({ type: "settle", commandId: "s1", threadId: id });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
    store.updateThread(id, { role: "worker", fresh_opt_out: 1 });
    await host.execute({ type: "settle", commandId: "s2", threadId: id });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
  });

  it("a worker settling in shadow mode only says so", async () => {
    const { store, runtime, host } = setup("shadow");
    const id = await started(host, runtime, 40_000);
    store.updateThread(id, { role: "worker" });
    await host.execute({ type: "settle", commandId: "s1", threadId: id });
    expect(store.thread(id)!.fresh ?? null).toBeNull();
    expect(host.ledger.timeline(id).some((e: any) => e.kind === "fresh-shadow" && e.summary.includes("task-done"))).toBe(true);
  });

  it("Fresh start is refused when fresh sessions are off", async () => {
    const { runtime, host } = setup("off");
    const id = await started(host, runtime, 60_000);
    expect(await host.freshStart(id)).toMatchObject({ ok: false, code: "fresh_off" });
  });
});
