import { describe, expect, it } from "vitest";
import { durationMs, Presence, VetoClock } from "../src/presence.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const MIN = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("active time", () => {
  it("parses board durations", () => {
    expect(durationMs("4h active", 0)).toBe(240 * MIN);
    expect(durationMs("10m", 0)).toBe(10 * MIN);
    expect(durationMs("soon", 7)).toBe(7);
  });

  it("beats close together are one interval; a gap past idle starts another; idle time never counts", () => {
    const store = new LoomStore(":memory:");
    const presence = new Presence(store, () => 10 * MIN);
    for (const m of [0, 1, 5, 14]) presence.beat(m * MIN);       // 0..14: active
    for (const m of [60, 62]) presence.beat(m * MIN);            // 46 idle minutes, then 60..62
    expect(presence.activeSince(0, 100 * MIN)).toBe(16 * MIN);
    expect(presence.activeSince(10 * MIN, 61 * MIN)).toBe(5 * MIN);
    presence.beat(30 * MIN);                                      // a late beat for an older time is ignored
    expect(presence.activeSince(0, 100 * MIN)).toBe(16 * MIN);
  });
});

describe("the veto clock", () => {
  const brief = {
    default: "A", class: "product-choice-in-scope", ask: "Label the countdown in active time? Recommend: yes.", door: "two-way", blast: "private",
    about: "Desk countdown", standing: "Countdowns run.", background: "D-1.", proposedRule: "Next time, for countdown copy, use active time",
    options: [{ key: "A", label: "Active time", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong when idle" }],
  };
  function setup(cooperative = false) {
    const store = new LoomStore(":memory:");
    let now = 1_000_000;
    store.now = () => now;
    const runtime = new FakeRuntime(cooperative ? store : undefined);
    const host = new LoomHost(store, { fake: runtime });
    const clock = (host as unknown as { vetoClock: { tick(): void } }).vetoClock;
    return { store, runtime, host, clock, advance: (ms: number) => { now += ms; } };
  }

  it("discussion blocks a default and seeing the kept reply restarts the full active-time window", async () => {
    const { store, host, runtime, clock, advance } = setup(true);
    const r = await host.execute({ type: "submit", commandId: "start", text: "build", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "brief", threadId: r.threadId!, brief });
    runtime.last.complete("Brief is up");
    await new Promise(resolve => setTimeout(resolve, 0));
    await host.execute({ type: "submit", commandId: "reply", threadId: r.threadId!, text: "Explain it" });
    for (let i = 0; i < 250; i++) { advance(MIN); host.beat(store.now()); clock.tick(); }
    expect(store.decision("D-4")).toMatchObject({ status: "open", discussed: 1 });
    await host.execute({ type: "decision.keep", commandId: "keep", threadId: r.threadId!, decisionId: "D-4", why: "Different topic" });
    runtime.last.complete("Here are the links");
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let i = 0; i < 20; i++) { advance(MIN); host.beat(store.now()); clock.tick(); }
    expect(store.decision("D-4")!.status).toBe("open");
    expect(store.decision("D-4")!.window_from).toBeNull();
    await host.execute({ type: "thread.seen", commandId: "seen", threadId: r.threadId!, at: store.now() });
    clock.tick();
    expect(store.decision("D-4")!.window_from).toBe(store.now());
    expect(store.decision("D-4")!.status).toBe("open");
    for (let i = 0; i < 240; i++) { advance(MIN); host.beat(store.now()); clock.tick(); }
    expect(store.decision("D-4")!.status).toBe("defaulted");
    await host.closeAll(); store.close();
  });

  it("returns an unseen kept brief after 30 active minutes after run end, preserving progress across idle gaps", async () => {
    const { store, host, runtime, clock, advance } = setup(true);
    const r = await host.execute({ type: "submit", commandId: "start", text: "build", cwd: "/repo", provider: "fake" });
    const d = await host.execute({ type: "decision.request", commandId: "brief", threadId: r.threadId!, brief });
    runtime.last.complete("Brief is up"); await flush();
    await host.execute({ type: "submit", commandId: "reply", threadId: r.threadId!, text: "Explain it" });
    await host.execute({ type: "decision.keep", commandId: "keep", threadId: r.threadId!, decisionId: d.decisionId!, why: "Different topic" });
    for (let i = 0; i < 40; i++) { advance(MIN); host.beat(); clock.tick(); }
    expect(store.decision(d.decisionId!)!.discussing_run).toBeTruthy();
    runtime.last.complete("Here are the links"); await flush();
    for (let i = 0; i < 15; i++) { advance(MIN); host.beat(); clock.tick(); }
    advance(40 * 24 * 60 * MIN); host.beat(); clock.tick();
    for (let i = 0; i < 14; i++) { advance(MIN); host.beat(); clock.tick(); }
    expect(store.decision(d.decisionId!)!.discussing_run).toBeTruthy();
    advance(MIN); host.beat(); clock.tick();
    expect(store.decision(d.decisionId!)).toMatchObject({ status: "open", discussing_run: null, kept_at: null, unaddressed_at: null, window_from: store.now() });
    for (let i = 0; i < 239; i++) { advance(MIN); host.beat(); clock.tick(); }
    expect(store.decision(d.decisionId!)!.status).toBe("open");
    advance(MIN); host.beat(); clock.tick();
    expect(store.decision(d.decisionId!)!.status).toBe("defaulted");
    await host.closeAll(); store.close();
  });

  it("level 3 brief without a default gets its recommendation as the default, so the veto clock can always fire", async () => {
    const { store, host } = setup();
    const r = await host.execute({ type: "submit", commandId: "missing-start", text: "build", cwd: "/repo", provider: "fake" });
    const d = await host.execute({ type: "decision.request", commandId: "missing-default", threadId: r.threadId!, brief: { ...brief, default: undefined } });
    const row = store.db.prepare("SELECT brief FROM decisions WHERE id = ?").get(d.decisionId!) as { brief: string };
    expect(JSON.parse(row.brief).default).toBe(brief.options.find((o: { recommended?: boolean }) => o.recommended)!.key);
    await host.closeAll(); store.close();
  });

  it("3 veto check errors wake the thread with the error once", async () => {
    const { store, host, clock } = setup();
    const r = await host.execute({ type: "submit", commandId: "bad-start", text: "build", cwd: "/repo", provider: "fake" });
    const d = await host.execute({ type: "decision.request", commandId: "bad-request", threadId: r.threadId!, brief });
    store.db.prepare("UPDATE decisions SET brief = '{' WHERE id = ?").run(d.decisionId!);
    clock.tick(); clock.tick();
    expect(store.runs(r.threadId!).filter(r => r.source === "wake")).toHaveLength(0);
    clock.tick(); clock.tick();
    const wakes = store.runs(r.threadId!).filter(r => r.source === "wake");
    expect(wakes).toHaveLength(1); expect(wakes[0]!.text).toContain("cannot be checked");
    await host.closeAll(); store.close();
  });

  it("a second error episode after a recovered check wakes again", async () => {
    const { store, host, clock } = setup();
    const r = await host.execute({ type: "submit", commandId: "again-start", text: "build", cwd: "/repo", provider: "fake" });
    const d = await host.execute({ type: "decision.request", commandId: "again-request", threadId: r.threadId!, brief });
    const good = (store.db.prepare("SELECT brief FROM decisions WHERE id = ?").get(d.decisionId!) as { brief: string }).brief;
    store.db.prepare("UPDATE decisions SET brief = '{' WHERE id = ?").run(d.decisionId!);
    clock.tick(); clock.tick(); clock.tick();
    for (const run of store.runs(r.threadId!)) store.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(run.id);
    store.db.prepare("UPDATE decisions SET brief = ? WHERE id = ?").run(good, d.decisionId!);
    clock.tick();
    store.db.prepare("UPDATE decisions SET brief = '{' WHERE id = ?").run(d.decisionId!);
    clock.tick(); clock.tick(); clock.tick();
    expect(store.runs(r.threadId!).filter(r => r.source === "wake" && r.text.includes("cannot be checked"))).toHaveLength(2);
    await host.closeAll(); store.close();
  });

  it("runs the default after 4 hours of the owner's active time, not 4 hours of clock", async () => {
    const { store, host, clock, advance } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "build", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief });
    advance(8 * 60 * MIN);                       // a night asleep: nothing counts
    clock.tick();
    expect(store.decision("D-4")!.status).toBe("open");
    for (let m = 0; m < 3 * 60; m++) { advance(MIN); host.beat(); }   // three active hours
    clock.tick();
    const payload = host.snapshot().threads.find((t) => t.id === r.threadId)!.decision!;
    expect(payload.veto).toMatchObject({ window_ms: 240 * MIN });
    expect(payload.veto!.left_ms).toBeGreaterThan(55 * MIN);
    for (let m = 0; m < 62; m++) { advance(MIN); host.beat(); }       // past four
    clock.tick();
    await flush();
    expect(store.decision("D-4")).toMatchObject({ status: "defaulted", decided_by: "default", answer_option: "A", followed_recommendation: 1 });
    const wake = store.runs(r.threadId!).at(-1)!;
    expect(wake.source).toBe("wake");
    expect(wake.text).toContain("default goes ahead: A · Active time");
  });

  it("the owner's own messages count as active time; an answered brief never defaults", async () => {
    const { store, host, clock, advance } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "build", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief });
    advance(MIN);
    await host.execute({ type: "submit", commandId: "c3", threadId: r.threadId!, text: "still thinking" });
    expect(host.presence.lastBeat()).toBe(store.now());
    await host.execute({ type: "decision.answer", commandId: "c4", decisionId: "D-4", option: "B" });
    for (let m = 0; m < 300; m++) { advance(MIN); host.beat(); }
    clock.tick();
    expect(store.decision("D-4")!.status).toBe("answered");
  });
});

describe("presence pruning", () => {
  it("keeps the intervals an open level 3 brief still needs, past 30 days", async () => {
    const store = new LoomStore(":memory:");
    let now = 1_000_000; store.now = () => now;
    const host = new LoomHost(store, { fake: new FakeRuntime() });
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/repo", provider: "fake" });
    await host.execute({ type: "decision.request", commandId: "c2", threadId: r.threadId!, brief: {
      default: "A", class: "delete-verified-copy", ask: "Delete the old archive copies? Recommend: yes.", door: "two-way", blast: "private",
      about: "Backup cleanup", standing: "Copies verified.", background: "Backups checked.", proposedRule: "Next time, for verified copies, delete without asking",
      options: [{ key: "A", label: "Delete", consequence: "Frees space", recommended: true }, { key: "B", label: "Keep", consequence: "Uses space" }] } });
    now += MIN; host.beat();
    now += 40 * 24 * 60 * MIN; host.beat();
    expect(host.presence.activeSince(0, now)).toBe(MIN); // the submit and the next beat, 40 days ago, still count
    now += MIN; host.beat();
    const rows = store.db.prepare("SELECT COUNT(*) AS n FROM presence").get() as { n: number };
    expect(rows.n).toBe(2);
  });
});

it("a throwing veto row does not block the next default", () => {
  const store = new LoomStore(":memory:"), presence = new Presence(store);
  const clock = new VetoClock(store, presence, () => {}, () => {});
  const rows = [{ id: "bad", brief: "{" }, { id: "good", brief: '{"default":"A"}' }];
  const original = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string) => sql.includes("status = 'open' AND level = 3") ? { all: () => rows } : original(sql)) as typeof store.db.prepare;
  clock.state = () => ({ window_ms: 0, active_ms: 0, left_ms: 0 });
  const seen: string[] = [];
  const other = new VetoClock(store, presence, r => { seen.push(r.id); }, () => {});
  other.state = clock.state;
  other.tick(); expect(seen).toEqual(["good"]);
  clock.close(); other.close(); store.close();
});

it("veto check failures survive a clock restart and clear only after success", () => {
  const store = new LoomStore(":memory:"), presence = new Presence(store);
  store.tx(() => {
    store.createThread({ id: "a", kind: "coding", cwd: "/tmp", provider: "fake" });
    store.addDecision({ id: "D-4", thread_id: "a", run_id: null, class: "product-choice-in-scope", level: 3, candidate: 0, ask: "Choose", brief: '{"default":"A"}', supersedes: null });
  });
  let fail = true, wakes = 0;
  const make = () => {
    const clock = new VetoClock(store, presence, () => { if (fail) throw new Error("default failed"); }, () => {}, 30_000, () => { wakes++; });
    clock.state = () => ({ window_ms: 0, active_ms: 0, left_ms: 0 });
    return clock;
  };
  let clock = make(); clock.tick(); clock.tick(); clock.close();
  expect(store.decision("D-4")?.veto_last_error).toContain("default failed");
  clock = make(); clock.tick(); expect(wakes).toBe(1);
  fail = false; clock.tick();
  expect(store.decision("D-4")).toMatchObject({ veto_errors: 0, veto_last_error: null });
  clock.close(); store.close();
});
