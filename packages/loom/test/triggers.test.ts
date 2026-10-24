import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomStore } from "../src/store.js";
import { checkCommand, CommandExit, TriggerService, codexReviewOf, normalize, samePr } from "../src/triggers.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";

function setup(path = ":memory:") {
  const store = new LoomStore(path);
  store.tx(() => store.createThread({ id: "a", kind: "coding", cwd: "/tmp", provider: "fake" }));
  return store;
}
describe("triggers", () => {
  it("validates and normalizes conditions", () => {
    expect(() => normalize("bogus", {}, "/tmp", 0)).toThrow();
    expect(() => normalize("command", { command: "true", intervalSeconds: 1 }, "/tmp", 0)).toThrow();
    expect(normalize("time", { afterMinutes: 2 }, "/tmp", 0)).toEqual({ at: "1970-01-01T00:02:00.000Z" });
  });
  it("polls shared conditions once and wakes each owner with its note", async () => {
    const store = setup(), kick = vi.fn(), command = vi.fn(async () => "");
    const svc = new TriggerService(store, kick, { command, fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => { for (const note of ["one", "two"]) svc.create("a", "command", { command: "true" }, note); });
    await svc.tick(); expect(command).toHaveBeenCalledTimes(1); expect(store.runs("a")).toHaveLength(2);
    expect(store.runs("a")[0]!.text).toContain("one");
    await svc.tick(); expect(store.runs("a")).toHaveLength(2); svc.close(); store.close();
  });
  it.each([
    ["url", { url: "https://example.test" }],
    ["file", { path: "ready", exists: true }],
    ["pr", { repo: "org/repo", number: 1, until: "approved" }],
    ["pr", { repo: "org/repo", number: 1, until: "merged" }],
    ["pr", { repo: "org/repo", number: 1, until: "closed" }],
    ["pr", { repo: "org/repo", number: 1, until: "checks_done" }],
    ["pr", { repo: "org/repo", number: 1, until: "commented" }],
  ])("fires %s with fake IO", async (kind, spec) => {
    const store = setup();
    const svc = new TriggerService(store, vi.fn(), {
      command: vi.fn(async () => JSON.stringify({ state: "MERGED", reviewDecision: "APPROVED", mergedAt: "now", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }], comments: [{ createdAt: new Date(Date.now() + 10000).toISOString() }] })),
      fetch: vi.fn(async () => new Response(null, { status: 200 })), stat: vi.fn(async () => ({} as Awaited<ReturnType<typeof import("node:fs/promises").stat>>)),
    });
    store.tx(() => svc.create("a", kind, spec, "resume")); await svc.tick();
    expect(svc.list()[0]!.status).toBe("fired");
    if (kind === "pr" && "until" in spec && spec.until === "checks_done") expect(svc.list()[0]!.detail).toContain("test");
    svc.close(); store.close();
  });
  it.each([
    ["merged since the wait began", { state: "MERGED", mergedAt: 1, closedAt: 1 }, true],
    ["closed since the wait began", { state: "CLOSED", closedAt: 1 }, true],
    ["changes requested since the wait began", { state: "OPEN", reviewDecision: "CHANGES_REQUESTED", reviews: [{ state: "CHANGES_REQUESTED", submittedAt: 1 }] }, true],
    ["merged before the wait began", { state: "MERGED", mergedAt: -1, closedAt: -1 }, true],
    ["changes requested before the wait began", { state: "OPEN", reviewDecision: "CHANGES_REQUESTED", reviews: [{ state: "CHANGES_REQUESTED", submittedAt: -1 }, { state: "COMMENTED", submittedAt: 1 }] }, true],
    ["open with only comments", { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", reviews: [{ state: "COMMENTED", submittedAt: 1 }] }, false],
  ])("wakes an approval wait when the PR was %s: %s", async (_label, pr, fires) => {
    const store = setup(); const start = Date.now(); store.now = () => start;
    const at = (v: unknown) => typeof v === "number" ? new Date(start + v * 60_000).toISOString() : v;
    const shown = { statusCheckRollup: [], comments: [], ...pr, mergedAt: at((pr as { mergedAt?: number }).mergedAt), closedAt: at((pr as { closedAt?: number }).closedAt),
      reviews: ((pr as { reviews?: { state: string; submittedAt: number }[] }).reviews ?? []).map((r) => ({ ...r, submittedAt: at(r.submittedAt) })) };
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => JSON.stringify(shown)), fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => svc.create("a", "pr", { repo: "org/repo", number: 1, until: "approved" }, "merge on approval"));
    await svc.tick();
    expect(svc.list()[0]!.status).toBe(fires ? "fired" : "waiting");
    svc.close(); store.close();
  });
  it("tells an approval wait once that changes were already requested, then lets a re-armed wait wait for the re-review", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    const shown = { state: "OPEN", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [], comments: [], reviews: [{ state: "CHANGES_REQUESTED", submittedAt: new Date(now - 60_000).toISOString() }] };
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => JSON.stringify(shown)), fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => svc.create("a", "pr", { repo: "org/repo", number: 1, until: "approved" }, "merge on approval"));
    await svc.tick();
    expect(svc.list()[0]).toMatchObject({ status: "fired" });
    expect(JSON.parse(svc.list()[0]!.detail!).note).toContain("already had changes requested");
    now += 61_000;
    store.tx(() => svc.create("a", "pr", { repo: "org/repo", number: 1, until: "approved" }, "re-review after fixes"));
    await svc.tick(); now += 61_000; await svc.tick();
    expect(svc.list()[1]!.status).toBe("waiting");
    shown.reviews.push({ state: "CHANGES_REQUESTED", submittedAt: new Date(now).toISOString() }); now += 61_000;
    await svc.tick();
    expect(svc.list()[1]!.status).toBe("fired");
    svc.close(); store.close();
  });
  it("still tells a re-armed approval wait about changes requested when the earlier wait ended on check errors", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    let fail = true;
    const shown = { state: "OPEN", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [], comments: [], reviews: [{ state: "CHANGES_REQUESTED", submittedAt: new Date(now - 60_000).toISOString() }] };
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => { if (fail) throw new Error("gh: not logged in"); return JSON.stringify(shown); }), fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => svc.create("a", "pr", { repo: "org/repo", number: 1, until: "approved" }, "merge on approval"));
    for (let i = 0; i < 3; i++) { await svc.tick(); now += 61_000; }
    expect(JSON.parse(svc.list()[0]!.detail!).error).toContain("not logged in");
    fail = false;
    store.tx(() => svc.create("a", "pr", { repo: "org/repo", number: 1, until: "approved" }, "merge on approval"));
    await svc.tick();
    expect(JSON.parse(svc.list()[1]!.detail!).note).toContain("already had changes requested");
    svc.close(); store.close();
  });
  it("tells the thread's readers when a check starts failing, at each further failure, and when it stops", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    let fail = true;
    const command = vi.fn(async () => { if (fail) throw new Error("gh: not logged in"); return JSON.stringify({ state: "OPEN", statusCheckRollup: [], comments: [] }); });
    const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => svc.create("a", "pr", { repo: "org/repo", number: 1, until: "approved" }, "merge"));
    let mark = store.highWater();
    await svc.tick(); expect(svc.list()[0]!.last_error).toContain("not logged in"); expect(store.highWater()).toBeGreaterThan(mark);
    mark = store.highWater(); now += 61_000;
    await svc.tick(); expect(svc.list()[0]!.consecutive_errors).toBe(2); expect(store.highWater()).toBeGreaterThan(mark); // failed 2 of 3: news
    mark = store.highWater(); fail = false; now += 61_000;
    await svc.tick(); expect(svc.list()[0]!.last_error).toBeNull(); expect(store.highWater()).toBeGreaterThan(mark);
    mark = store.highWater(); now += 61_000;
    await svc.tick(); expect(store.highWater()).toBe(mark); // still passing: no news
    svc.close(); store.close();
  });
  it("expires and wakes with the note", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    const svc = new TriggerService(store, vi.fn());
    store.tx(() => svc.create("a", "time", { afterMinutes: 10 }, "remember", 1)); now += 60001;
    await svc.tick(); expect(svc.list()[0]!.status).toBe("expired"); expect(store.runs("a")[0]!.text).toContain("timed out"); expect(store.runs("a")[0]!.text).toContain("remember"); svc.close(); store.close();
  });
  it("restores overdue time waits and fires once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-triggers-")), path = join(dir, "db");
    let store = setup(path), svc = new TriggerService(store, vi.fn());
    store.tx(() => svc.create("a", "time", { afterMinutes: 0 }, "late")); svc.close(); store.close();
    store = new LoomStore(path); svc = new TriggerService(store, vi.fn()); await svc.tick(); await svc.tick();
    expect(store.runs("a")).toHaveLength(1); svc.close(); store.close(); rmSync(dir, { recursive: true });
  });
  it("recovers a run_completed wait whose completion landed before a crash (Codex review on #683)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-trigger-crash-")), path = join(dir, "loom.sqlite");
    let store = setup(path);
    store.tx(() => store.createThread({ id: "b", kind: "coding", cwd: "/tmp", provider: "fake" }));
    let svc = new TriggerService(store, vi.fn());
    store.now = () => 1000;
    store.tx(() => svc.create("a", "thread", { threadId: "b", until: "run_completed" }, "b finished"));
    svc.close();
    // The watched run completes, then the coordinator dies before the in-memory notification.
    store.now = () => 2000;
    store.tx(() => { const run = store.createRun("b", "user", "work"); store.updateRun(run.id, { status: "completed", started_at: 1500, ended_at: 2000 }); });
    store.close();
    store = new LoomStore(path); svc = new TriggerService(store, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(svc.list("a")[0]?.status).toBe("fired");
    expect(store.runs("a").at(-1)?.text).toContain("b finished");
    svc.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  it("a run_completed wait fires when the watched run fails, so a lead never waits out a dead worker (owner, 10/20)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-trigger-failed-")), path = join(dir, "loom.sqlite");
    let store = setup(path);
    store.tx(() => store.createThread({ id: "b", kind: "coding", cwd: "/tmp", provider: "fake" }));
    let svc = new TriggerService(store, vi.fn());
    store.now = () => 1000;
    store.tx(() => svc.create("a", "thread", { threadId: "b", until: "run_completed" }, "b finished"));
    svc.close();
    store.now = () => 2000;
    store.tx(() => { const run = store.createRun("b", "user", "work"); store.updateRun(run.id, { status: "failed", started_at: 1500, ended_at: 2000 }); });
    store.close();
    store = new LoomStore(path); svc = new TriggerService(store, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(svc.list("a")[0]?.status).toBe("fired");
    svc.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  it("thread completion is event driven", () => {
    const store = setup(), svc = new TriggerService(store, vi.fn());
    store.tx(() => svc.create("a", "thread", { threadId: "a", until: "run_completed" }, "next"));
    svc.threadChanged("a", false); expect(store.runs("a")).toHaveLength(0);
    svc.threadChanged("a", true); expect(store.runs("a")).toHaveLength(1); svc.close(); store.close();
  });
  it("an idle wait holds while the thread has a run queued (mail's minute before its turn; 10/20)", () => {
    const store = setup(), svc = new TriggerService(store, vi.fn());
    store.tx(() => store.createThread({ id: "b", kind: "coding", cwd: "/tmp", provider: "fake" }));
    const run = store.tx(() => store.createRun("b", "user", "✉️ Mail from a lead"));
    store.tx(() => svc.create("a", "thread", { threadId: "b", until: "idle" }, "b is idle"));
    svc.threadChanged("b", false); expect(svc.list("a")[0]?.status).toBe("waiting");
    store.tx(() => store.updateRun(run.id, { status: "completed", started_at: 1, ended_at: 2 }));
    svc.threadChanged("b", true); expect(svc.list("a")[0]?.status).toBe("fired");
    svc.close(); store.close();
  });
  it.each(["stop", "delete"] as const)("%s cancels waits", async type => {
    const store = setup(), host = new LoomHost(store, { fake: new FakeRuntime() });
    await host.execute({ type: "trigger.create", commandId: "wait", threadId: "a", kind: "time", spec: { afterMinutes: 1 }, note: "next" });
    await host.execute({ type, commandId: type, threadId: "a" });
    expect(host.triggers.list()[0]!.status).toBe("cancelled"); await host.closeAll(); store.close();
  });
  it("queues a fire behind a running turn", async () => {
    const store = new LoomStore(":memory:"), runtime = new FakeRuntime(), host = new LoomHost(store, { fake: runtime });
    const { threadId } = await host.execute({ type: "submit", commandId: "start", cwd: "/tmp", provider: "fake", text: "work" });
    await host.execute({ type: "trigger.create", commandId: "wait", threadId: threadId!, kind: "time", spec: { afterMinutes: 0 }, note: "continue" });
    await host.triggers.tick(); expect(runtime.last.turns).toHaveLength(1);
    runtime.last.complete(); await host.kick(threadId!); expect(runtime.last.turns).toHaveLength(2);
    await host.closeAll(); store.close();
  });
});

it("submitting a disabled Loom profile cancels existing waits", async () => {
  const store = setup(), host = new LoomHost(store, { fake: new FakeRuntime() });
  try {
    await host.execute({ type: "trigger.create", commandId: "wait", threadId: "a", kind: "command", spec: { command: "true" }, note: "next" });
    await host.execute({ type: "submit", commandId: "disable", threadId: "a", text: "isolated", session: { loomTools: false } });
    expect(host.triggers.list("a")[0]!.status).toBe("cancelled");
  } finally { await host.closeAll(); store.close(); }
});

it.each(["tick", "threadChanged"] as const)("%s cancels disabled owners' persisted waits without commands or wakes", async path => {
  const store = setup(), kick = vi.fn(), command = vi.fn(async () => "");
  const svc = new TriggerService(store, kick, { command, fetch: vi.fn(), stat: vi.fn() });
  try {
    store.tx(() => {
      svc.create("a", "command", { command: "true" }, "command");
      svc.create("a", "time", { afterMinutes: 0 }, "time");
      svc.create("a", "thread", { threadId: "a", until: "run_completed" }, "thread");
      store.updateThread("a", { session_profile: JSON.stringify({ loomTools: false }) });
    });
    if (path === "threadChanged") svc.threadChanged("a", true);
    else await svc.tick();
    expect(command).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    expect(store.runs("a")).toHaveLength(0);
    expect(svc.list("a").map(t => t.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  } finally { svc.close(); store.close(); }
});

it.each(["CONFLICTING", "UNKNOWN"])("notices %s PR checks through the injected gh runner", async mergeable => {
  const store = setup(); let now = 1000; store.now = () => now;
  const command = vi.fn(async () => JSON.stringify({ mergeable, statusCheckRollup: [] }));
  const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
  try {
    svc.create("a", "pr", { repo: "org/repo", number: 42, until: "checks_done" }, "checks");
    await svc.tick();
    expect(command.mock.calls[0]).toBeDefined();
    if (mergeable === "UNKNOWN") {
      expect(svc.list()[0]!.status).toBe("waiting"); now += 599_999; await svc.tick();
      expect(svc.list()[0]!.status).toBe("waiting"); now += 60_001; await svc.tick();
    }
    expect(JSON.parse(svc.list()[0]!.detail!)).toMatchObject({ conflict: true });
    expect(store.runs("a")[0]!.text).toContain("PR #42 conflicts with its base, so its checks will never run; rebase it");
  } finally { svc.close(); store.close(); }
});

it("gives a later identical PR wait its own ten-minute no-checks window", async () => {
  const store = setup(); let now = 1000; store.now = () => now;
  const command = vi.fn(async () => JSON.stringify({ mergeable: "UNKNOWN", statusCheckRollup: [] }));
  const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
  try {
    svc.create("a", "pr", { repo: "org/repo", number: 7, until: "checks_done" }, "first");
    await svc.tick(); now += 600_001; await svc.tick();
    expect(svc.list()[0]!.status).toBe("fired");
    now += 60_001;
    svc.create("a", "pr", { repo: "org/repo", number: 7, until: "checks_done" }, "second");
    await svc.tick();
    expect(svc.list(undefined, "waiting")).toHaveLength(1);
  } finally { svc.close(); store.close(); }
});

it("keeps overlapping grouped PR observation windows independent", async () => {
  const store = setup(); let now = 1000; store.now = () => now;
  let mergeable = "UNKNOWN";
  const command = vi.fn(async () => JSON.stringify({ mergeable, statusCheckRollup: [] }));
  const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
  try {
    const spec = { repo: "org/repo", number: 7, until: "checks_done" };
    const first = svc.create("a", "pr", spec, "first");
    await svc.tick(); now += 300_000;
    const second = svc.create("a", "pr", spec, "second");
    await svc.tick(); now += 300_000; await svc.tick();
    expect(svc.list().find(t => t.id === first)?.status).toBe("fired");
    expect(svc.list().find(t => t.id === second)?.status).toBe("waiting");
    expect(command).toHaveBeenCalledTimes(3);
    now += 300_000; await svc.tick();
    expect(svc.list(undefined, "waiting")).toHaveLength(0);
    svc.create("a", "pr", spec, "conflict");
    mergeable = "CONFLICTING"; await svc.tick();
    expect(svc.list(undefined, "waiting")).toHaveLength(0);
  } finally { svc.close(); store.close(); }
});

it("kills an in-flight command process group when the profile disables Loom tools", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "loom-command-")), pidFile = join(dir, "pid");
  const store = setup(), host = new LoomHost(store, { fake: new FakeRuntime() });
  let pending: Promise<void> | undefined;
  try {
    host.triggers.create("a", "command", { command: `sleep 120 & echo $! > '${pidFile}'; wait`, timeoutSeconds: 120 }, "never");
    pending = host.triggers.tick();
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await host.execute({ type: "submit", commandId: "disable-running", threadId: "a", text: "isolated", session: { loomTools: false } });
    await pending;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    expect(host.triggers.list("a")[0]!.status).toBe("cancelled");
    expect(store.runs("a").filter(r => r.source === "wake")).toHaveLength(0);
  } finally { host.triggers.cancelThread("a"); await pending; await host.closeAll(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("cancels every concurrent evaluation owned by a thread without cancelling another owner", async () => {
  const store = setup(), signals: AbortSignal[] = [];
  store.tx(() => store.createThread({ id: "b", kind: "coding", cwd: "/tmp", provider: "fake" }));
  const command = vi.fn((_file: string, _args: string[], _cwd: string | undefined, _timeout: number, signal?: AbortSignal) => new Promise<string>(resolve => {
    signals.push(signal!); signal!.addEventListener("abort", () => resolve(""));
  }));
  const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
  try {
    svc.create("a", "command", { command: "one" }, "one");
    svc.create("a", "command", { command: "two" }, "two");
    svc.create("b", "command", { command: "one" }, "other");
    const tick = svc.tick();
    expect(signals).toHaveLength(3);
    svc.cancelThread("a");
    expect(signals.map(s => s.aborted)).toEqual([true, true, false]);
    svc.cancelThread("b"); await tick;
    expect(store.runs("a")).toHaveLength(0); expect(store.runs("b")).toHaveLength(0);
  } finally { svc.close(); store.close(); }
});

describe("Codex review cap", () => {
  it("knows a Codex review wait by Codex plus a PR, not a Codex implementation wait", () => {
    expect(codexReviewOf("command", JSON.stringify({ command: "gh api repos/o/r/issues/781/comments --jq '.[] | select(.user.login | test(\"codex\"))'" }), "Third pass")).toBe("o/r#781");
    expect(codexReviewOf("command", JSON.stringify({ command: "gh pr checks 772" }), "CI and Codex on it")).toBe("#772");
    expect(codexReviewOf("command", JSON.stringify({ command: "gh pr checks 772 --repo O/R" }), "Codex")).toBe("o/r#772");
    expect(codexReviewOf("pr", JSON.stringify({ repo: "o/r", number: 9, until: "commented" }), "Codex review")).toBe("o/r#9");
    expect(codexReviewOf("command", JSON.stringify({ command: "agentctl status tango rr-p3 | grep succeeded" }), "Codex finished rr-p3")).toBeNull();
    expect(codexReviewOf("pr", JSON.stringify({ repo: "o/r", number: 9, until: "checks_done" }), "CI")).toBeNull();
  });

  it("tells each pass where it stands, stops at the cap, and refuses another wait until the owner speaks", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => ""), fetch: vi.fn(), stat: vi.fn() }, 3);
    const wait = (n: number, pr = 781) => store.tx(() => svc.create("a", "command", { command: `gh api repos/o/r/issues/${pr}/comments | grep codex-review-state #${n}` }, `Codex pass ${n}`));
    for (let n = 1; n <= 3; n++) { wait(n); now += 61_000; await svc.tick(); }
    const texts = store.runs("a").map((r) => r.text);
    expect(texts[0]).toContain("Codex review pass 1 of at most 3 on PR o/r#781");
    expect(texts[2]).toContain("pass 3 on PR o/r#781 since the owner last spoke, the cap");
    expect(texts[2]).toContain("Apply merge-when-green");
    expect(texts[2]).not.toContain("loom.decision_request");
    expect(() => wait(4)).toThrow(/Codex review cap reached: 3 passes on PR o\/r#781/);
    expect(() => wait(1, 782)).not.toThrow(); // another PR has its own count
    // Mail doesn't reset the count; the owner's own words do.
    store.tx(() => store.addMessage("a", null, "user", "✉️ Reply from lead: keep going", null));
    expect(() => wait(5)).toThrow(/cap reached/);
    now += 1000; store.tx(() => store.addMessage("a", null, "user", "Keep going, two more passes", null));
    now += 1000; expect(() => wait(6)).not.toThrow();
    svc.close(); store.close();
  });

  it("counts waits not yet fired, so several made at once can't pass the cap together (Codex review on #810)", () => {
    const store = setup();
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(), fetch: vi.fn(), stat: vi.fn() }, 2);
    const wait = (n: number) => store.tx(() => svc.create("a", "command", { command: `gh api repos/o/r/pulls/5/reviews | grep codex #${n}` }, "Codex"));
    wait(1); wait(2);
    expect(() => wait(3)).toThrow(/cap reached/);
    svc.close(); store.close();
  });

  it("keeps PRs with one number in different repos apart, and matches a wait that doesn't name its repo (Codex review on #810)", () => {
    expect(samePr("o/a#9", "o/b#9")).toBe(false);
    expect(samePr("o/a#9", "#9")).toBe(true);
    expect(samePr("o/a#9", "o/a#10")).toBe(false);
  });

  it("resets the cap when the owner answers a prompt (Codex review on #810)", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => ""), fetch: vi.fn(), stat: vi.fn() }, 1);
    const wait = () => store.tx(() => svc.create("a", "command", { command: "gh api repos/o/r/pulls/5/reviews | grep codex" }, "Codex"));
    wait(); now += 61_000; await svc.tick();
    expect(() => wait()).toThrow(/cap reached/);
    now += 1000;
    store.tx(() => { const r = store.openRequest("a", null, "question", {}); store.resolveRequest(r.id, "answered", { ok: true }); });
    now += 1000; expect(() => wait()).not.toThrow();
    svc.close(); store.close();
  });

  it("does not count a Codex wait that timed out as a pass", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => { throw new Error("not yet"); }), fetch: vi.fn(), stat: vi.fn() }, 1);
    store.tx(() => svc.create("a", "command", { command: "gh pr view 5 --json comments | grep codex" }, "Codex review", 1));
    now += 61_000; await svc.tick();
    expect(svc.list("a")[0]!.status).toBe("expired");
    expect(store.runs("a")[0]!.text).not.toContain("Codex review pass");
    expect(() => store.tx(() => svc.create("a", "command", { command: "gh pr view 5 --json comments | grep codex" }, "Codex review"))).not.toThrow();
    svc.close(); store.close();
  });
});


it("3 consecutive errors wake the thread with the error, including across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-errors-")), path = join(dir, "db");
  let store = setup(path), now = 1000; store.now = () => now;
  const io = { command: vi.fn(async () => { throw new Error("gh auth failed"); }), fetch: vi.fn(), stat: vi.fn() };
  let svc = new TriggerService(store, vi.fn(), io);
  svc.create("a", "pr", { repo: "org/repo", number: 913, until: "approved" }, "review");
  await svc.tick(); now += 61_000; await svc.tick();
  svc.close(); store.close();
  store = new LoomStore(path); store.now = () => now += 61_000;
  svc = new TriggerService(store, vi.fn(), io);
  await svc.tick(); await svc.tick();
  expect(store.runs("a")).toHaveLength(1);
  expect(store.runs("a")[0]!.text).toContain("gh auth failed");
  expect(svc.list()[0]!.last_error).toContain("gh auth failed");
  svc.close(); store.close(); rmSync(dir, { recursive: true });
});

it("migrates existing trigger rows without losing their waits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-migrate-")), path = join(dir, "db");
  let store = setup(path);
  store.db.exec("ALTER TABLE triggers DROP COLUMN consecutive_errors; ALTER TABLE triggers DROP COLUMN error_since; ALTER TABLE decisions DROP COLUMN veto_errors; ALTER TABLE decisions DROP COLUMN veto_last_error");
  store.db.prepare("INSERT INTO triggers (id,thread_id,kind,spec,note,dedup_key,created_at,expires_at,status) VALUES ('old','a','time','{}','','old',1,2,'waiting')").run();
  store.close(); store = new LoomStore(path);
  expect(store.db.prepare("SELECT consecutive_errors,error_since,status FROM triggers").get()).toEqual({ consecutive_errors: 0, error_since: null, status: "waiting" });
  expect(store.db.prepare("PRAGMA table_info(decisions)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "veto_errors" }), expect.objectContaining({ name: "veto_last_error" })]));
  store.close(); rmSync(dir, { recursive: true });
});

it("command exit 1 means pending with no error", async () => {
  const store = setup(), svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => { throw new CommandExit(1, "not yet"); }), fetch: vi.fn(), stat: vi.fn() });
  svc.create("a", "command", { command: "false" }, "later"); await svc.tick();
  expect(svc.list()[0]).toMatchObject({ status: "waiting", last_error: null, consecutive_errors: 0 });
  svc.close(); store.close();
});

it("url 503 records last_error and a successful check clears it", async () => {
  const store = setup(); let now = 1000; store.now = () => now;
  let status = 503;
  const svc = new TriggerService(store, vi.fn(), { command: vi.fn(), fetch: vi.fn(async () => new Response(null, { status })), stat: vi.fn() });
  svc.create("a", "url", { url: "https://example.test" }, "ready"); await svc.tick();
  expect(svc.list()[0]!.last_error).toContain("503");
  status = 404; now += 61_000; await svc.tick();
  expect(svc.list()[0]).toMatchObject({ last_error: null, consecutive_errors: 0, error_since: null });
  svc.close(); store.close();
});

it("review posted fires a commented wait without an issue comment", async () => {
  const store = setup();
  const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => JSON.stringify({ reviews: [{ submittedAt: new Date(Date.now() + 10000).toISOString() }] })), fetch: vi.fn(), stat: vi.fn() });
  svc.create("a", "pr", { repo: "org/repo", number: 1, until: "commented" }, "review"); await svc.tick();
  expect(svc.list()[0]!.status).toBe("fired");
  svc.close(); store.close();
});

it("slow commands do not delay a due time wait on a later tick", async () => {
  const store = setup(); let now = 1000; store.now = () => now;
  let release!: (s: string) => void;
  const svc = new TriggerService(store, vi.fn(), { command: vi.fn(() => new Promise<string>(r => { release = r; })), fetch: vi.fn(), stat: vi.fn() });
  svc.create("a", "command", { command: "slow", timeoutSeconds: 10000 }, "slow");
  expect(JSON.parse(svc.list()[0]!.spec).timeoutSeconds).toBe(300);
  const slow = svc.tick();
  svc.create("a", "time", { afterMinutes: 1 }, "due"); now += 61_000;
  await svc.tick();
  expect(svc.list().find(t => t.kind === "time")!.status).toBe("fired");
  release(""); await slow; svc.close(); store.close();
});

it("expired-after-sleep wait gets one last check before timeout", async () => {
  const store = setup(); let now = 1000; store.now = () => now;
  const command = vi.fn(async () => "");
  const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
  svc.create("a", "command", { command: "ready" }, "ready", 1); now += 120_000;
  await svc.tick(); expect(command).toHaveBeenCalledTimes(1);
  expect(svc.list()[0]!.status).toBe("fired");
  svc.close(); store.close();
});

it("a real command exit 1 is pending while a timed-out command is an error", async () => {
  await expect(checkCommand("sh", ["-c", "exit 1"], undefined, 1000)).rejects.toBeInstanceOf(CommandExit);
  try {
    await checkCommand("sh", ["-c", "sleep 5"], undefined, 20);
    throw new Error("timeout did not reject");
  } catch (error) {
    expect(error).not.toBeInstanceOf(CommandExit);
    expect(String(error)).toContain("SIGKILL");
    // The checker's own deadline names itself, so the woken agent knows its check, not the condition, is at fault.
    expect(String(error)).toContain("timed out after 0.02s");
  }
});

it("a thread's detail carries each wait's consecutive errors and since when it has failed", async () => {
  const store = setup(), host = new LoomHost(store, { fake: new FakeRuntime() });
  try {
    const id = host.triggers.create("a", "url", { url: "https://example.test" }, "up");
    store.db.prepare("UPDATE triggers SET last_error=?,consecutive_errors=?,error_since=? WHERE id=?").run("HTTP 503", 2, 1234, id);
    expect(host.detail("a")!.waits[0]).toMatchObject({ last_error: "HTTP 503", consecutive_errors: 2, error_since: 1234 });
  } finally { host.triggers.cancelThread("a"); await host.closeAll(); store.close(); }
});

it("future time waits never use up external check capacity", async () => {
  const store = setup(); const now = 1000; store.now = () => now;
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  const svc = new TriggerService(store, vi.fn(), { command: vi.fn(), fetch, stat: vi.fn() });
  for (let i = 0; i < 5; i++) svc.create("a", "time", { at: new Date(10_000_000 + i).toISOString() }, `later ${i}`);
  svc.create("a", "url", { url: "https://example.test" }, "ready");
  await svc.tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  svc.close(); store.close();
});

it("a url wait for an explicit 5xx fires on it", async () => {
  const store = setup();
  const svc = new TriggerService(store, vi.fn(), { command: vi.fn(), fetch: vi.fn(async () => new Response(null, { status: 503 })), stat: vi.fn() });
  svc.create("a", "url", { url: "https://example.test", status: 503 }, "down");
  await svc.tick();
  expect(svc.list()[0]).toMatchObject({ status: "fired", last_error: null });
  svc.close(); store.close();
});

describe("worker waits", () => {
  it("polls agentctl until completion and retains errors until a successful check", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    let status = "running", broken = false;
    const command = vi.fn(async () => { if (broken) throw new Error("unreachable"); return JSON.stringify({ worker: { status } }); });
    const svc = new TriggerService(store, vi.fn(), { command, fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => svc.create("a", "worker", { project: "test", task: "build" }, "read result", 10));
    await svc.tick(); expect(svc.list()[0]!.status).toBe("waiting");
    expect(command).toHaveBeenCalledWith("agentctl", ["status", "test", "build", "--json"], undefined, 30_000);
    broken = true; now += 61_000; await svc.tick(); expect(svc.list()[0]!.last_error).toContain("unreachable");
    broken = false; status = "succeeded"; now += 61_000; await svc.tick();
    expect(svc.list()[0]).toMatchObject({ status: "fired", last_error: null });
    expect(store.runs("a")[0]!.text).toContain("read result"); svc.close(); store.close();
  });
  it("a Loom worker between turns with its own wait armed is still working", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    store.tx(() => store.createThread({ id: "w", kind: "coding", cwd: "/tmp", provider: "fake", parentThreadId: "loom:a" }));
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => { throw new CommandExit(1); }), fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => { svc.create("w", "command", { command: "false" }, "ci"); svc.create("a", "worker", { threadId: "w" }, "worker done", 10); });
    await svc.tick();
    expect(svc.list().find(t => t.thread_id === "a")!.status).toBe("waiting");
    store.tx(() => { for (const t of svc.list().filter(t => t.thread_id === "w")) svc.cancel(t.id); });
    now += 61_000; await svc.tick();
    expect(svc.list().find(t => t.thread_id === "a")!.status).toBe("fired");
    svc.close(); store.close();
  });
  it("times out a still running worker", async () => {
    const store = setup(); let now = Date.now(); store.now = () => now;
    const svc = new TriggerService(store, vi.fn(), { command: vi.fn(async () => JSON.stringify({ worker: { status: "running" } })), fetch: vi.fn(), stat: vi.fn() });
    store.tx(() => svc.create("a", "worker", { project: "test", task: "build" }, "timeout", 1));
    now += 60_001; await svc.tick(); expect(svc.list()[0]!.status).toBe("expired");
    expect(store.runs("a")[0]!.text).toContain("timed out"); svc.close(); store.close();
  });
});

describe("built-in Codex review waits", () => {
  const head = "a".repeat(40), old = "b".repeat(40);
  const spec = { repo: "org/repo", number: 42, until: "codex_reviewed" };
  const summary = (sha: string, status: string, updatedAt: number, findings = false) => ({
    user: { login: "chatgpt-codex-connector[bot]" }, updated_at: new Date(updatedAt).toISOString(),
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status, has_any_findings: findings, has_unresolved_findings: findings } })} -->`,
  });
  function ioFor(comments: () => unknown[][]) {
    return { command: vi.fn(async (_file: string, args: string[]) => args[0] === "api" ? JSON.stringify(comments()) : args[1] === "view" ? JSON.stringify({ headRefOid: head }) : ""), fetch: vi.fn(), stat: vi.fn() };
  }
  it.each([false, true])("fires for the completed head with findings=%s", async findings => {
    const store = setup(), io = ioFor(() => [[], [summary(head, "completed", 1000, findings)]]);
    const svc = new TriggerService(store, vi.fn(), io);
    try {
      svc.create("a", "pr", spec, "review"); await svc.tick();
      expect(JSON.parse(svc.list()[0]!.detail!)).toEqual({ codexSha: head, headSha: head, hasFindings: findings, hasUnresolvedFindings: findings });
      expect(store.runs("a")[0]!.text).toContain(`Codex review of aaaaaaa completed: ${findings ? "findings, read the review threads" : "clean"}`);
      expect(store.runs("a")[0]!.text).toContain("waiting for Codex to review PR org/repo#42's head");
      expect(codexReviewOf("pr", JSON.stringify(spec), "review")).toBe("org/repo#42");
      expect(io.command).toHaveBeenCalledWith("gh", ["api", "repos/org/repo/issues/42/comments", "--paginate", "--slurp"], undefined, 30_000);
    } finally { svc.close(); store.close(); }
  });
  it.each([[old, "completed"], [head, "running"]])("waits for head completion (%s, %s)", async (sha, status) => {
    const store = setup(); store.now = () => 1000;
    const svc = new TriggerService(store, vi.fn(), ioFor(() => [[summary(sha!, status!, 1000)]]));
    try { svc.create("a", "pr", spec, "review"); await svc.tick(); expect(svc.list()[0]!.status).toBe("waiting"); expect(store.runs("a")).toHaveLength(0); }
    finally { svc.close(); store.close(); }
  });
  it("ignores a summary marker posted by someone other than the connector", async () => {
    const store = setup(); store.now = () => 1000;
    const svc = new TriggerService(store, vi.fn(), ioFor(() => [[{ ...summary(head, "completed", 1000), user: { login: "someone" } }]]));
    try { svc.create("a", "pr", spec, "review"); await svc.tick(); expect(svc.list()[0]!.status).toBe("waiting"); }
    finally { svc.close(); store.close(); }
  });
  it("re-requests once across restart, then fires stalled and counts toward the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-codex-")), path = join(dir, "db");
    let store = setup(path), now = 1000, updatedAt = 1000; store.now = () => now;
    const io = ioFor(() => [[summary(head, "running", updatedAt)]]);
    let svc = new TriggerService(store, vi.fn(), io, 1, 120_000);
    try {
      svc.create("a", "pr", spec, "review"); await svc.tick();
      now += 60_000; updatedAt = now; await svc.tick();
      now += 60_000; await svc.tick(); // recent summary edit postpones the first window
      expect(io.command.mock.calls.filter(c => c[1][1] === "comment")).toHaveLength(0);
      now += 60_000; await svc.tick();
      const rerequestedAt = now;
      expect(JSON.parse(svc.list()[0]!.detail!)).toEqual({ rerequestedAt });
      svc.close(); store.close(); store = new LoomStore(path); store.now = () => now;
      svc = new TriggerService(store, vi.fn(), io, 1, 120_000);
      await svc.tick(); now += 60_000; updatedAt = now; await svc.tick();
      expect(svc.list()[0]!.status).toBe("waiting");
      now += 60_000; await svc.tick();
      expect(JSON.parse(svc.list()[0]!.detail!)).toEqual({ stalled: true, rerequestedAt, headSha: head });
      expect(io.command.mock.calls.filter(c => c[1][1] === "comment")).toEqual([["gh", ["pr", "comment", "42", "--repo", "org/repo", "--body", "@codex review"], undefined, 30_000]]);
      expect(store.runs("a")[0]!.text).toContain("Codex didn't answer after a re-request; don't request again; apply merge-when-green on the recorded facts");
      expect(() => svc.create("a", "pr", spec, "review")).toThrow(/cap reached/);
    } finally { svc.close(); store.close(); rmSync(dir, { recursive: true }); }
  });
  it("starts the stall clock at creation when no summary exists, and never repeats an ambiguous failed post", async () => {
    const store = setup(); let now = 1000; store.now = () => now;
    const io = ioFor(() => [[]]); const command = io.command.getMockImplementation()!;
    io.command.mockImplementation(async (file, args) => { if (args[1] === "comment") throw new Error("connection lost"); return command(file, args); });
    const svc = new TriggerService(store, vi.fn(), io, 5, 60_000);
    try {
      svc.create("a", "pr", spec, "review"); await svc.tick(); now += 60_000; await svc.tick();
      expect(svc.list()[0]!.last_error).toContain("connection lost");
      now += 60_000; await svc.tick(); expect(svc.list()[0]!.status).toBe("fired");
      expect(io.command.mock.calls.filter(c => c[1][1] === "comment")).toHaveLength(1);
    } finally { svc.close(); store.close(); }
  });
  it("includes P1-only guidance from pass three and refuses a sixth pass", async () => {
    const store = setup(); let now = 1000; store.now = () => now;
    const svc = new TriggerService(store, vi.fn(), ioFor(() => [[summary(head, "completed", now)]]));
    try {
      for (let i = 0; i < 5; i++) { svc.create("a", "pr", spec, "review"); now += 60_000; await svc.tick(); }
      const wakes = store.runs("a").map(r => r.text);
      expect(wakes[1]).not.toContain("only P1");
      expect(wakes[2]).toContain("From this pass, only P1 findings block");
      expect(wakes[4]).toContain("Don't ask Codex for another review");
      expect(wakes[4]).toContain("only P1 findings block");
      expect(() => svc.create("a", "pr", spec, "review")).toThrow(/only P1 findings block/);
    } finally { svc.close(); store.close(); }
  });
});
