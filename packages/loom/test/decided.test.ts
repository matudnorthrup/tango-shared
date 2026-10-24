import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintLog, loadBoard } from "../src/decisions.js";
import { LoomHost } from "../src/host.js";
import { createLoomServer } from "../src/http.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

// Level 4, act and tell (docs/specs/decisions-and-delegation.md, phase 2b): the agent logs what it decided, the
// owner sees it under "Decided for you" with level 3 defaults, and can undo it or say "I wouldn't have".

const MIN = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const store = new LoomStore(":memory:");
  let now = 1_000_000;
  store.now = () => now;
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  // A read covers up to the millisecond before it (a same-millisecond write comes in the next one): reads step the clock.
  const read = host.decided.bind(host);
  host.decided = (since: number, limit?: number) => { now += 1; return read(since, limit); };
  const clock = (host as unknown as { vetoClock: { tick(): void } }).vetoClock;
  return { store, runtime, host, clock, advance: (ms: number) => { now += ms; } };
}
const log = (threadId: string, over: Record<string, unknown> = {}) => ({
  type: "decision.log" as const, commandId: `log-${Math.random()}`, threadId,
  class: "merge-when-green", summary: "Merged #12 once CI was green and the threads were resolved", undo: "git revert the merge commit and push", ref: "https://github.com/example/repo/pull/12",
  ...over,
});
const brief = {
  default: "A", class: "product-choice-in-scope", ask: "Label the countdown in active time? Recommend: yes.", door: "two-way", blast: "private",
  about: "Desk countdown", standing: "Countdowns run.", background: "D-1.", proposedRule: "Next time, for countdown copy, use active time",
  options: [{ key: "A", label: "Active time", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong when idle" }],
};

describe("the level 4 log", () => {
  const board = loadBoard();

  it("takes a level 4 class only: level 5 needs no log, levels 1 to 3 need a brief", () => {
    expect(lintLog({ class: "merge-when-green", summary: "Merged #12" }, board)).toMatchObject({ errors: [], level: 4, log: { undo: null, ref: null } });
    expect(lintLog({ class: "continue-in-scope", summary: "Kept going" }, board).errors.join()).toMatch(/level 5.*nothing to log/);
    expect(lintLog({ class: "product-choice-in-scope", summary: "Picked blue" }, board).errors.join()).toMatch(/level 3.*decision_request/);
    expect(lintLog({ class: "nope", summary: "x" }, board).errors.join()).toMatch(/one of the board's classes/);
  });

  it("needs a one-line summary and a link the owner can open", () => {
    const errors = lintLog({ class: "merge-when-green", summary: "x".repeat(201), ref: "http://localhost:3000/pr" }, board).errors.join();
    expect(errors).toMatch(/201 characters/);
    expect(errors).toMatch(/only opens on this machine/);
    expect(lintLog({ class: "merge-when-green", summary: " " }, board).errors.join()).toMatch(/summary/);
  });

  it("records an acted row, decided by the agent, with nothing for the owner to answer", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "ship #12", cwd: "/repo", provider: "fake" });
    const logged = await host.execute(log(r.threadId!));
    expect(logged).toMatchObject({ decisionId: "D-4", level: 4 });
    expect(store.decision("D-4")).toMatchObject({ status: "acted", decided_by: "agent", class: "merge-when-green", level: 4, undo: "git revert the merge commit and push", reversed_at: null });
    expect(store.openDecisions(r.threadId!)).toEqual([]);
    expect(host.snapshot().threads.find((t) => t.id === r.threadId)!.decision).toBeNull();
    await expect(host.execute(log(r.threadId!, { class: "plan-approval" }))).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/bring a brief/) });
  });
});

describe("decided for you", () => {
  it("lists acted and defaulted decisions across threads, newest first, with the thread's title", async () => {
    const { host, clock, advance } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "ship #12", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "rename", commandId: "c1r", threadId: a.threadId!, title: "Ship the merge" });
    const b = await host.execute({ type: "submit", commandId: "c2", text: "countdown copy", cwd: "/repo", provider: "fake" });
    advance(MIN);
    await host.execute(log(a.threadId!));
    await host.execute({ type: "decision.request", commandId: "c3", threadId: b.threadId!, brief });
    await host.execute({ type: "decision.request", commandId: "c4", threadId: a.threadId!, brief: { ...brief, class: "plan-approval", ask: "Ship the desk countdown as planned? Recommend: yes." } });
    for (let m = 0; m < 241; m++) { advance(MIN); host.beat(); }
    clock.tick();
    await flush();
    const { decisions: decided, more } = host.decided(0);
    expect(more).toBe(false);
    expect(decided.map((d) => [d.id, d.status])).toEqual([["D-5", "defaulted"], ["D-4", "acted"]]); // the open level 2 brief is not listed
    expect(decided[0]).toMatchObject({ thread_id: b.threadId, summary: "Label the countdown in active time? Recommend: yes. → A · Active time", decided_by: "default", undo: null });
    expect(decided[1]).toMatchObject({ thread_title: "Ship the merge", ref: "https://github.com/example/repo/pull/12" });
    expect(host.decided(decided[0]!.at).decisions.map((d) => d.id)).toEqual(["D-5"]);
  });

  it("says which standing rule a decision was made under (the desk's catch-up treats it as routine)", async () => {
    const { host, store } = setup();
    const a = await host.execute({ type: "submit", commandId: "c1", text: "ship #12", cwd: "/repo", provider: "fake" });
    await flush();
    await host.execute(log(a.threadId!));
    store.logDecision({ id: "D-9", thread_id: a.threadId!, run_id: null, class: "product-choice-in-scope", level: 3, ask: "Merged #12 at the Codex cap", undo: null, ref: null, rule_id: "R-15" });
    expect(host.decided(0).decisions.map((d) => [d.id, d.rule])).toEqual([["D-9", "R-15"], ["D-4", null]]);
  });

  it("a backlog past the limit comes oldest first, so marking what was shown seen never skips the rest", async () => {
    const { host, advance } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    for (let i = 0; i < 5; i++) { advance(MIN); await host.execute(log(r.threadId!, { summary: `Merged #${i}` })); }
    const first = host.decided(0, 3);
    expect(first).toMatchObject({ more: true });
    expect(first.decisions.map((d) => d.summary)).toEqual(["Merged #2", "Merged #1", "Merged #0"]); // shown newest first
    const next = host.decided(first.decisions[0]!.at + 1, 3);
    expect(next).toMatchObject({ more: false });
    expect(next.decisions.map((d) => d.summary)).toEqual(["Merged #4", "Merged #3"]);
  });

  it("a batch never ends partway through one millisecond: rows tied at its edge all come in it", async () => {
    const { host, advance } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    advance(MIN);
    for (let i = 0; i < 4; i++) await host.execute(log(r.threadId!, { summary: `Tied #${i}` }));
    advance(MIN);
    await host.execute(log(r.threadId!, { summary: "Later" }));
    const first = host.decided(0, 2);
    expect(first.decisions.map((d) => d.summary).sort()).toEqual(["Tied #0", "Tied #1", "Tied #2", "Tied #3"]);
    expect(first.more).toBe(true);
    expect(host.decided(first.decisions[0]!.at + 1, 2)).toMatchObject({ more: false, decisions: [{ summary: "Later" }] });
    advance(MIN);
    expect(host.decided(0, 4)).toMatchObject({ more: true });                // exactly the tie, then more
  });

  it("\"I wouldn't have\" records the reversal and wakes no one; Undo wakes the thread with the owner's words", async () => {
    const { host, store, runtime } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "ship", cwd: "/repo", provider: "fake" });
    runtime.last.complete("Merged.");
    await flush();
    await host.execute(log(r.threadId!));
    await host.execute(log(r.threadId!, { summary: "Labelled the PR ready for review", class: "pr-housekeeping", undo: null }));
    const runs = store.runs(r.threadId!).length;

    await host.execute({ type: "decision.reverse", commandId: "c2", decisionId: "D-5", undo: false, note: "Leave labels to me" });
    expect(store.decision("D-5")).toMatchObject({ reversal: "disagree", reversal_note: "Leave labels to me", reversed_at: store.now() });
    expect(store.runs(r.threadId!)).toHaveLength(runs);

    const undone = await host.execute({ type: "decision.reverse", commandId: "c3", decisionId: "D-4", undo: true, note: "Wait for the second review" });
    await flush();
    expect(store.decision("D-4")).toMatchObject({ reversal: "undo", reversal_note: "Wait for the second review" });
    const words = store.messages(r.threadId!).at(-1)!;
    expect(words).toMatchObject({ role: "user", run_id: undone.runId });
    expect(words.text).toBe("Undo D-4: Merged #12 once CI was green and the threads were resolved. Wait for the second review\nHow you said to undo it: git revert the merge commit and push");
    expect(runtime.last.turns.at(-1)!.text).toContain("Undo D-4");
    const reversedAt = store.now();
    expect(host.decided(0).decisions.find((d) => d.id === "D-4")).toMatchObject({ reversal: "undo", reversed_at: reversedAt });

    await expect(host.execute({ type: "decision.reverse", commandId: "c4", decisionId: "D-4", undo: false })).rejects.toMatchObject({ code: "reversed" });
  });

  it("only what was decided for the owner can be reversed; a stopped thread can't undo", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief });
    await expect(host.execute({ type: "decision.reverse", commandId: "c3", decisionId: "D-4", undo: true })).rejects.toMatchObject({ code: "not_decided" });
    await expect(host.execute({ type: "decision.reverse", commandId: "c4", decisionId: "D-99", undo: true })).rejects.toMatchObject({ code: "not_found" });
    await host.execute(log(r.threadId!));
    await host.execute({ type: "stop", commandId: "c5", threadId: r.threadId! });
    await expect(host.execute({ type: "decision.reverse", commandId: "c6", decisionId: "D-5", undo: true })).rejects.toMatchObject({ code: "stopped" });
    await host.execute({ type: "decision.reverse", commandId: "c7", decisionId: "D-5", undo: false });
    expect(store.decision("D-5")!.reversal).toBe("disagree");
  });

  it("a read ends the millisecond before it, so a decision in that same millisecond comes in the next read", async () => {
    const store = new LoomStore(":memory:");
    let now = 1_000_000;
    store.now = () => now;
    const host = new LoomHost(store, { fake: new FakeRuntime(store) });
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute(log(r.threadId!));
    expect(host.decided(0).decisions).toEqual([]);
    now += 1;
    expect(host.decided(0).decisions.map((d) => d.id)).toEqual(["D-4"]);
  });

  it("GET /decisions?since lists them over HTTP", async () => {
    const { host, store } = setup();
    const server = createLoomServer(host, { token: "t" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
      await host.execute(log(r.threadId!));
      const url = (since: number) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/decisions?since=${since}`;
      const got = await (await fetch(url(store.now()), { headers: { Authorization: "Bearer t" } })).json() as { decisions: { id: string; status: string }[] };
      expect(got.decisions).toMatchObject([{ id: "D-4", status: "acted" }]);
      const later = await (await fetch(url(store.now() + 1), { headers: { Authorization: "Bearer t" } })).json() as { decisions: unknown[] };
      expect(later.decisions).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("the ledger from before phase 2b", () => {
  it("gains the log and reversal columns on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-decided-"));
    try {
      const file = join(dir, "loom.sqlite");
      const first = new LoomStore(file);
      for (const column of ["undo", "ref", "reversed_at", "reversal", "reversal_note"]) first.db.exec(`ALTER TABLE decisions DROP COLUMN ${column}`);
      first.close();
      const again = new LoomStore(file);
      const columns = (again.db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(["undo", "ref", "reversed_at", "reversal", "reversal_note"]));
      again.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe("Fine by me (catch-up)", () => {
  it("records a confirmation on what was decided for the owner, once; never on a reversal or an open brief", async () => {
    const { host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "ship #12", cwd: "/repo", provider: "fake" });
    await flush();
    const logged = await host.execute(log(r.threadId!));
    const ok = await host.execute({ type: "decision.confirm", commandId: "f1", decisionId: logged.decisionId! });
    expect(ok).toMatchObject({ decisionId: logged.decisionId });
    const at = store.decision(logged.decisionId!)!.confirmed_at;
    expect(at).not.toBeNull();
    await host.execute({ type: "decision.confirm", commandId: "f2", decisionId: logged.decisionId! });
    expect(store.decision(logged.decisionId!)!.confirmed_at).toBe(at);
    expect(host.decided(0).decisions[0]).toMatchObject({ id: logged.decisionId, confirmed_at: at });
    const asked = await host.execute({ type: "decision.request", commandId: "b1", threadId: r.threadId!, brief });
    await expect(host.execute({ type: "decision.confirm", commandId: "f3", decisionId: asked.decisionId! })).rejects.toMatchObject({ code: "not_decided" });
    const other = await host.execute(log(r.threadId!));
    await host.execute({ type: "decision.reverse", commandId: "r1", decisionId: other.decisionId!, undo: false });
    await expect(host.execute({ type: "decision.confirm", commandId: "f4", decisionId: other.decisionId! })).rejects.toMatchObject({ code: "reversed" });
  });
});
