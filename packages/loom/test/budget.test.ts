import { describe, expect, it } from "vitest";
import { budgetDefaults, budgetState, nextMidnight } from "../src/budget.js";
import { HANDOFF_PROMPT, type FreshPolicy } from "../src/fresh.js";
import { LoomHost } from "../src/host.js";
import { AccountPool } from "../src/pool.js";
import { LoomStore } from "../src/store.js";
import { dayStart } from "../src/usage.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function setup(mode: FreshPolicy["mode"] = "on", extra: { pool?: AccountPool } = {}) {
  const store = new LoomStore(":memory:");
  // 10:00 local, so a day has room on both sides.
  let now = new Date(2027, 2, 10, 10, 0, 0).getTime();
  store.now = () => now;
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime }, { fresh: { mode, soft: 150_000, idleMs: 3_600_000, idleMin: 80_000 }, budgets: { interactive: 1_000_000 }, claudeProjectsDir: "/loom/claude-projects", backgroundSettleMs: 0, ...extra });
  return { store, runtime, host, advance: (ms: number) => { now += ms; } };
}

/** One turn on the live session that sends `context` tokens. */
function answer(runtime: FakeRuntime, context: number) {
  const session = runtime.last;
  session.emit({ type: "context.observed", runId: session.currentRun, context, cacheRead: context, cacheWrite: 0, output: 10 });
  session.complete("done");
}

async function started(c: ReturnType<typeof setup>, context: number) {
  const r = await c.host.execute({ type: "submit", commandId: "c1", text: "build it", cwd: "/repo", provider: "fake" });
  c.runtime.last.emit({ type: "session.native", nativeSessionId: "native-1" });
  answer(c.runtime, context);
  await flush();
  return r.threadId!;
}
let n = 0;
async function owner(c: ReturnType<typeof setup>, id: string, text = "next") {
  const r = await c.host.execute({ type: "submit", commandId: `o${++n}`, threadId: id, text });
  await flush();
  return r.runId!;
}
function wake(c: ReturnType<typeof setup>, id: string, text = "wake up") {
  const run = c.store.tx(() => c.store.createRun(id, "wake", text));
  return run.id;
}

describe("per-thread daily budget", () => {
  it("role defaults, env overrides and the budget day", () => {
    expect(budgetDefaults({})).toEqual({ interactive: 100_000_000, worker: 100_000_000, default: 150_000_000, ops: 30_000_000 });
    expect(budgetDefaults({ LOOM_BUDGET_OPS: "5000000", LOOM_BUDGET_WORKER: "nope" })).toMatchObject({ ops: 5_000_000, worker: 100_000_000 });
    const now = new Date(2027, 2, 10, 23, 30).getTime();
    expect(nextMidnight(now)).toBe(new Date(2027, 2, 11).getTime());
    const defaults = budgetDefaults({});
    expect(budgetState({ role: "default", budget: null, budget_raise: null }, 75_000_000, now, defaults)).toMatchObject({ limit: 150_000_000, share: 0.5 });
    // Yesterday's raise is spent.
    expect(budgetState({ role: "worker", budget: 10, budget_raise: JSON.stringify({ day: dayStart(now) - 86_400_000, extra: 5 }) }, 0, now, defaults)).toMatchObject({ limit: 10, raised: 0 });
    expect(budgetState({ role: "worker", budget: 0, budget_raise: null }, 99, now, defaults)).toMatchObject({ limit: 0, share: 0 });
  });

  it("crossing 80% starts the thread fresh at its next turn, once a budget day", async () => {
    const c = setup("on");
    const id = await started(c, 100_000);
    await owner(c, id); answer(c.runtime, 100_000); await flush();
    expect(c.store.thread(id)!.fresh ?? null).toBeNull();
    // 800k today: 80% of 1M.
    for (let i = 0; i < 6; i++) { await owner(c, id); answer(c.runtime, 100_000); await flush(); }
    expect(JSON.parse(c.store.thread(id)!.fresh!)).toMatchObject({ reason: "budget", previousSession: "native-1" });
    await owner(c, id, "after the crossing");
    expect(c.runtime.sessions).toHaveLength(2);
    expect(c.runtime.last.turns[0]!.text).toContain("this is a fresh session");
    c.runtime.last.emit({ type: "session.native", nativeSessionId: "native-2" });
    answer(c.runtime, 10_000); await flush();
    // Still past 80% later that day: no second reset.
    expect(c.store.thread(id)!.fresh ?? null).toBeNull();
    expect(c.host.ledger.timeline(id).some((e: any) => e.kind === "fresh" && /daily budget/.test(e.summary))).toBe(true);
  });

  it("shadow mode only logs the budget reset, once", async () => {
    const c = setup("shadow");
    const id = await started(c, 850_000);
    await owner(c, id); answer(c.runtime, 1_000); await flush();
    expect(c.store.thread(id)!.fresh ?? null).toBeNull();
    expect(c.host.ledger.timeline(id).filter((e: any) => e.kind === "fresh-shadow" && /budget/.test(e.summary))).toHaveLength(1);
  });

  it("a kept session is never reset for its budget", async () => {
    const c = setup("on");
    const id = await started(c, 100_000);
    await c.host.keepSession(id, true);
    await owner(c, id); answer(c.runtime, 800_000); await flush();
    expect(c.store.thread(id)!.fresh ?? null).toBeNull();
  });

  it("past 100%, automatic turns wait for midnight; the owner's turn goes first and runs", async () => {
    const c = setup("off");
    const id = await started(c, 1_000_000);
    const held = wake(c, id);
    await c.host.kick(id);
    expect(c.store.run(held)!.status).toBe("queued");
    const thread = c.host.detail(id)!.thread as any;
    expect(thread.admission).toBe("budget");
    expect(thread.admission_until).toBe(nextMidnight(c.store.now()));
    expect(thread.budget).toMatchObject({ limit: 1_000_000, today: 1_000_000 });
    // The owner's message jumps the held wake and runs.
    const mine = await owner(c, id, "do it anyway");
    expect(c.store.run(mine)!.status).toBe("running");
    expect(c.store.run(held)!.status).toBe("queued");
    answer(c.runtime, 1_000); await flush();
    expect(c.store.run(held)!.status).toBe("queued");
    expect(c.store.thread(id)!.admission).toBe("budget");
    // Midnight: a new budget day, and the wake runs.
    c.advance(nextMidnight(c.store.now()) - c.store.now() + 1_000);
    await c.host.kick(id);
    expect(c.store.run(held)!.status).toBe("running");
    expect(c.store.thread(id)!.admission ?? null).toBeNull();
  });

  it("the owner's turn goes ahead even of an automatic run that already started once (Codex review on #846)", async () => {
    const c = setup("off");
    const id = await started(c, 1_000_000);
    const requeued = wake(c, id);
    // As moveOffLimit leaves it: an attempt on record, queued again.
    c.store.tx(() => { c.store.createAttempt(c.store.run(requeued)!, null, "native-1"); c.store.endAttempts(requeued, "failed", null); });
    const mine = await owner(c, id, "mine first");
    expect(c.store.run(mine)!.status).toBe("running");
    expect(c.store.run(requeued)!.status).toBe("queued");
  });

  it("Raise adds half the budget for today and lets a held thread go", async () => {
    const c = setup("off");
    const id = await started(c, 1_000_000);
    const held = wake(c, id);
    await c.host.kick(id);
    expect(c.store.run(held)!.status).toBe("queued");
    expect(c.host.raiseBudget(id)).toMatchObject({ ok: true, budget: { limit: 1_500_000, raised: 500_000 } });
    await flush();
    expect(c.store.run(held)!.status).toBe("running");
    expect(c.host.raiseBudget("missing")).toEqual({ ok: false, code: "not_found" });
    // Next day the raise is gone.
    c.advance(86_400_000);
    expect(c.host.budgetOf(c.store.thread(id)!)).toMatchObject({ limit: 1_000_000, raised: 0 });
  });

  it("a thread's own budget overrides its role's, and 0 turns it off", async () => {
    const c = setup("off");
    const id = await started(c, 1_000_000);
    expect(c.host.setBudget(id, 0)).toMatchObject({ ok: true, budget: { limit: 0 } });
    const free = wake(c, id);
    await c.host.kick(id);
    expect(c.store.run(free)!.status).toBe("running");
    answer(c.runtime, 1_000); await flush();
    expect(c.host.setBudget(id, 2_000_000)).toMatchObject({ ok: true, budget: { limit: 2_000_000, base: 2_000_000 } });
    expect(c.host.setBudget(id, null)).toMatchObject({ ok: true, budget: { limit: 1_000_000 } });
  });

  it("an account under a quarter of its weekly quota halves the soft threshold", async () => {
    const pool = new AccountPool([{ provider: "fake", name: "a", usageName: "a" }]);
    pool.applyUsage([{ provider: "fake", account: "a", windows: [{ kind: "seven_day", remainingPercent: 20 }] }]);
    const c = setup("on", { pool });
    await started(c, 100_000);
    // 100k is under the soft threshold (150k) but over half of it.
    expect(c.runtime.last.turns.at(-1)!.text).toBe(HANDOFF_PROMPT);
    const roomy = new AccountPool([{ provider: "fake", name: "a", usageName: "a" }]);
    roomy.applyUsage([{ provider: "fake", account: "a", windows: [{ kind: "seven_day", remainingPercent: 60 }] }]);
    const d = setup("on", { pool: roomy });
    await started(d, 100_000);
    expect(d.runtime.last.turns.at(-1)!.text).toBe("build it");
  });
});
