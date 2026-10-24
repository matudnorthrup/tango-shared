import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomHost, ROLE_MODELS } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { AccountPool } from "../src/pool.js";
import { extractResult } from "../src/fan-outs.js";
import { FakeRuntime } from "./fake-runtime.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "loom-fan-test-")), store = new LoomStore(":memory:");
  const codex = new FakeRuntime(), claude = new FakeRuntime();
  const pool = new AccountPool([{ provider: "codex", name: "one" }, { provider: "codex", name: "two" }, { provider: "claude", name: "fallback" }]);
  const titler = vi.fn(async () => "Unwanted title");
  const host = new LoomHost(store, { codex, claude }, { loomHome: home, fanOutArtifacts: join(home, "artifacts"), titler, pool, roleModels: ROLE_MODELS });
  cleanups.push(async () => { await host.closeAll(); store.close(); rmSync(home, { recursive: true, force: true }); });
  const parent = store.tx(() => store.createThread({ cwd: home, provider: "claude", kind: "coding" }));
  const start = (input = {}) => host.execute({ type: "fan_out.create", commandId: crypto.randomUUID(), threadId: parent.id, input: { items: [{ label: "first", prompt: "read" }, { label: "second", prompt: "read" }], ...input } });
  const flush = async () => { for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 5)); await host.fanOuts.tick(); } };
  return { home, titler, store, codex, claude, pool, host, parent, start, flush };
}
describe("fan-out core", () => {
  it("extracts a fenced object with braces in strings and trailing Next prose", () => {
    expect(extractResult('```json\n{"answer":"a } and \\\"quote\\\""}\n```\nNext — none: done.')).toEqual({ answer: 'a } and "quote"' });
  });
  it.each(["codex", "claude"])("runs %s probes with one wake, isolated profiles, usage tags and closed hosts", async provider => {
    const s = await setup(), batch = await s.start({ provider }); await s.flush();
    const runtime = provider === "codex" ? s.codex : s.claude;
    const sessions = [...runtime.sessions]; expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.options.session).toMatchObject({ loomTools: false, settingSources: [], sandbox: "read-only", projectDocs: false, disallowedTools: ["Edit", "Write", "NotebookEdit", "MultiEdit"] });
      session.emit({ type: "context.observed", runId: session.currentRun, context: 100, cacheRead: 0, cacheWrite: 0, output: 10 });
      session.complete('{"answer":"yes"}\nNext — none: done.');
    }
    await s.flush();
    expect(sessions.every(x => x.closed)).toBe(true);
    expect(s.store.runs(s.parent.id).filter(r => r.source === "wake")).toHaveLength(1);
    expect(s.host.fanOuts.status(s.parent.id, batch.fanOutId!).probes.every(p => p.status === "done")).toBe(true);
    const results = JSON.parse(readFileSync(join(s.home, "fan-outs", batch.fanOutId!, "results.json"), "utf8"));
    expect(results.probes[0].result).toEqual({ answer: "yes" });
    expect(s.store.db.prepare("SELECT fan_out_id,parent_thread_id FROM usage LIMIT 1").get()).toMatchObject({ fan_out_id: batch.fanOutId, parent_thread_id: `loom:${s.parent.id}` });
    await s.host.fanOuts.tick(); expect(s.store.runs(s.parent.id)).toHaveLength(1);
  });
  it("spreads placements and respects concurrency", async () => {
    const s = await setup(), b = await s.start({ concurrency: 1 }); await s.flush();
    expect(b.probes!.map(p => s.store.thread(p.threadId)!.account)).toEqual(["one", "two"]);
    expect(s.codex.sessions).toHaveLength(1);
    s.codex.last.complete('{"answer":"ok"}'); await s.flush();
    expect(s.codex.sessions).toHaveLength(2); expect(s.codex.sessions[0]!.closed).toBe(true);
  });
  it.each(["queued", "running"])("continues the batch and unrelated deadlines after deleting a %s probe", async state => {
    const s = await setup(), b = await s.start({ concurrency: 1, items: [
      { label: "first", prompt: "read" }, { label: "second", prompt: "read" }, { label: "third", prompt: "read" },
    ] }); await s.flush();
    const deleted = b.probes![state === "queued" ? 1 : 0]!.threadId;
    await s.host.execute({ type: "delete", commandId: crypto.randomUUID(), threadId: deleted });
    if (state === "queued") s.codex.sessions[0]!.complete('{"answer":"ok"}');
    const other = await s.start({ items: [{ label: "unrelated", prompt: "read" }] });
    s.store.db.prepare("UPDATE fan_outs SET deadline=0 WHERE id=?").run(other.fanOutId!);
    await s.flush();
    expect(s.host.fanOuts.status(s.parent.id, other.fanOutId!).finished).toBe(true);
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes.find(p => p.threadId === deleted)).toMatchObject({ status: "failed", failure: "probe deleted" });
    for (let round = 0; round < 2; round++) {
      for (const session of s.codex.sessions.filter(session => !session.closed)) session.complete('{"answer":"ok"}');
      await s.flush();
    }
    const result = s.host.fanOuts.status(s.parent.id, b.fanOutId!);
    expect(result.finished).toBe(true);
    expect(result.probes.filter(p => p.threadId !== deleted).every(p => p.status === "done")).toBe(true);
    expect(s.store.runs(deleted)).toHaveLength(0);
    expect(s.store.runs(s.parent.id).filter(r => r.source === "wake")).toHaveLength(2);
  });
  it("fails an individually stopped queued probe and gives its slot to the next", async () => {
    const s = await setup(), b = await s.start({ concurrency: 1, items: [
      { label: "first", prompt: "read" }, { label: "second", prompt: "read" }, { label: "third", prompt: "read" },
    ] }); await s.flush();
    const stopped = b.probes![1]!.threadId;
    await s.host.execute({ type: "stop", commandId: crypto.randomUUID(), threadId: stopped });
    s.codex.sessions[0]!.complete('{"answer":"ok"}'); await s.flush();
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes.find(p => p.threadId === stopped)).toMatchObject({ status: "failed", failure: "probe stopped" });
    expect(s.store.runs(stopped)).toHaveLength(0);
    for (const session of s.codex.sessions.filter(session => !session.closed)) session.complete('{"answer":"ok"}');
    await s.flush();
    const result = s.host.fanOuts.status(s.parent.id, b.fanOutId!);
    expect(result.finished).toBe(true);
    expect(result.probes.map(p => p.status)).toEqual(["done", "failed", "done"]);
    expect(s.store.runs(s.parent.id).filter(r => r.source === "wake")).toHaveLength(1);
  });
  it("repairs once, then marks invalid without an extra parent wake", async () => {
    const s = await setup(), b = await s.start({ items: [{ label: "bad", prompt: "read" }] }); await s.flush();
    s.codex.last.complete('{"answer":12}'); await s.flush();
    expect(s.codex.last.turns).toHaveLength(2); expect(s.codex.last.turns[1]!.text).toContain("corrected JSON");
    s.codex.last.complete("still invalid"); await s.flush();
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes[0]!.status).toBe("invalid");
    expect(s.store.runs(s.parent.id)).toHaveLength(1);
  });
  it("times out both active and queued probes and closes the host", async () => {
    const s = await setup(), b = await s.start({ concurrency: 1 }); await s.flush();
    s.store.db.prepare("UPDATE fan_outs SET deadline=0").run(); await s.flush();
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes.map(p => p.status)).toEqual(["timed_out", "timed_out"]);
    expect(s.codex.last.closed).toBe(true); expect(s.codex.sessions).toHaveLength(1);
    expect(s.store.runs(s.parent.id)).toHaveLength(1);
  });
  it.each(["stop", "delete", "cancel_wait"])("cancels unfinished probes on %s without waking parent", async action => {
    const s = await setup(), b = await s.start({ concurrency: 1 }); await s.flush();
    await s.host.execute(action === "cancel_wait" ? { type: "trigger.cancel", commandId: crypto.randomUUID(), triggerId: b.triggerId! } : { type: action as "stop" | "delete", commandId: crypto.randomUUID(), threadId: s.parent.id });
    await s.flush();
    expect(s.codex.last.closed).toBe(true); expect(s.codex.sessions).toHaveLength(1);
    expect(s.store.runs(s.parent.id)).toHaveLength(0);
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes.every(p => p.status === "failed")).toBe(true);
  });
  it("rejects limits and schemas before creating threads", async () => {
    const s = await setup();
    for (const input of [{ concurrency: 9 }, { deadlineMinutes: 121 }, { items: [] }, { schema: { type: "nonsense" } }]) await expect(s.start(input)).rejects.toThrow();
    expect(s.store.threads()).toHaveLength(1);
  });
  it("uses only allowed accounts and waits for an explicit exhausted provider", async () => {
    const s = await setup(); s.pool.coolDown("codex", "one"); s.pool.coolDown("codex", "two");
    const b = await s.start({ provider: "codex", accounts: ["two"] }); await s.flush();
    expect(b.probes!.every(p => s.store.thread(p.threadId)!.provider === "codex")).toBe(true);
    expect(s.codex.sessions).toHaveLength(0); expect(s.claude.sessions).toHaveLength(0);
  });
  it("falls back to Sonnet only for automatic placement", async () => {
    const s = await setup(); s.pool.coolDown("codex", "one"); s.pool.coolDown("codex", "two");
    await s.start(); await s.flush();
    expect(s.claude.sessions).toHaveLength(2);
    expect(s.claude.last.options.session?.model).toBe("sonnet");
  });
  it.each(["other", "overloaded", "auth"] as const)("records a %s harness failure and wakes only once", async kind => {
    const s = await setup(), b = await s.start({ items: [{ label: "broken", prompt: "read" }] }); await s.flush();
    s.codex.last.emit({ type: "turn.failed", runId: s.codex.last.currentRun, failure: { kind, message: "failure" } }); await s.flush();
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes[0]!.status).toBe("failed");
    expect(s.store.runs(s.parent.id)).toHaveLength(1); expect(s.codex.last.closed).toBe(true);
  });
  it("refuses recursive fan-out and direct probe submissions", async () => {
    const s = await setup(), b = await s.start();
    await expect(s.host.execute({ type: "fan_out.create", commandId: crypto.randomUUID(), threadId: b.probes![0]!.threadId, input: { items: [{ label: "nested", prompt: "read" }] } })).rejects.toThrow();
    await expect(s.host.execute({ type: "submit", commandId: crypto.randomUUID(), cwd: s.home, provider: "codex", kind: "probe", text: "write" })).rejects.toThrow();
  });

  it("finishes a persisted batch after coordinator replacement without a second wake", async () => {
    const s = await setup(), b = await s.start(); await s.flush();
    s.host.fanOuts.close();
    for (const session of s.codex.sessions) session.complete('{"answer":"persisted"}');
    await s.host.closeAll();
    const replacement = new LoomHost(s.store, { codex: s.codex, claude: s.claude }, { loomHome: s.home });
    try {
      await replacement.fanOuts.tick(); await replacement.fanOuts.tick();
      expect(replacement.fanOuts.status(s.parent.id, b.fanOutId!).finished).toBe(true);
      expect(s.store.runs(s.parent.id)).toHaveLength(1);
    } finally { await replacement.closeAll(); }
  });
  it("keeps streamed partial text when the deadline interrupts a probe", async () => {
    const s = await setup(), b = await s.start({ items: [{ label: "partial", prompt: "read" }] }); await s.flush();
    s.codex.last.emit({ type: "message.delta", runId: s.codex.last.currentRun, text: 'partial answer' });
    s.store.db.prepare("UPDATE fan_outs SET deadline=0").run(); await s.flush();
    expect(s.host.fanOuts.status(s.parent.id, b.fanOutId!).probes[0]!.raw).toBe('partial answer');
  });
  it("caps wake text while preserving full validated results", async () => {
    const s = await setup(), b = await s.start({ concurrency: 8, items: Array.from({length:20}, (_,i) => ({label:`item ${i}`,prompt:'read'})) });
    let count=0;
    for (let round=0;round<4;round++) {
      await s.flush();
      for (const session of s.codex.sessions.slice(count)) session.complete(JSON.stringify({answer:'x'.repeat(6000)}));
      count=s.codex.sessions.length;
    }
    await s.flush();
    expect(s.store.runs(s.parent.id)[0]!.text.length).toBeLessThanOrEqual(40000);
    const result=JSON.parse(readFileSync(join(s.home,'fan-outs',b.fanOutId!,'results.json'),'utf8'));
    expect(result.probes).toHaveLength(20);expect(result.probes[19].result.answer).toHaveLength(6000);
  });

  it("closes a host that finishes opening after its parent cancels", async () => {
    const s = await setup();
    const open = s.codex.open.bind(s.codex);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release=resolve; });
    s.codex.open = async (...args) => { await gate; return open(...args); };
    const b = await s.start({ items: [{label:'slow open',prompt:'read'}] });
    await new Promise(r=>setTimeout(r,10));
    await s.host.execute({type:'trigger.cancel',commandId:crypto.randomUUID(),triggerId:b.triggerId!});
    release(); await s.flush();
    expect(s.codex.last.turns).toHaveLength(0);expect(s.codex.last.closed).toBe(true);
    expect(s.host.hasSession(b.probes![0]!.threadId)).toBe(false);
  });

});

it("projects fan-out progress onto the parent and skips probe titles and catch-up", async () => {
  const s = await setup(), b = await s.start(); await s.flush();
  expect(s.host.detail(s.parent.id)?.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "fan_out", description: "2 probes · 0 done · one, two", url: `/artifacts/loom-fan-out-${b.fanOutId}/results.json` })]));
  expect(s.host.fanOuts.background(s.parent.id)[0]?.ambient).toBe(true);
  expect(s.host.fanOuts.list(s.parent.id)).toHaveLength(1);
  const probeId = b.probes![0]!.threadId;
  s.store.tx(() => s.store.updateThread(probeId, { title_source: "draft" }));
  (s.host as unknown as { nameThread(id: string, text: string): void }).nameThread(probeId, "Research");
  expect(s.titler).not.toHaveBeenCalled();
  for (const type of ["update.post", "chapter.note"] as const) {
    await expect(s.host.execute({ type, commandId: crypto.randomUUID(), threadId: b.probes![0]!.threadId, kind: "fyi", text: "Probe news." } as never)).rejects.toThrow(/disabled|Probes/);
  }
  s.codex.sessions.forEach(session => session.complete('{"answer":"yes"}')); await s.flush();
  expect(s.host.fanOuts.background(s.parent.id)[0]?.description).toBe("2 probes · 2 done · one, two");
  expect(s.host.fanOuts.background(s.parent.id)[0]).toMatchObject({ ambient: false, url: `/artifacts/loom-fan-out-${b.fanOutId}/results.json` });
  expect(JSON.parse(readFileSync(join(s.home, "artifacts", `loom-fan-out-${b.fanOutId}`, "results.json"), "utf8")).finished).toBe(true);
});

it("allows managed resources after borrowers settle, but active probes block", async () => {
  const s = await setup();
  const cwd = join(s.home, "worktrees", "parent"); mkdirSync(cwd, { recursive: true });
  s.store.db.prepare("UPDATE threads SET cwd=? WHERE id=?").run(cwd, s.parent.id);
  s.store.tx(() => { const run = s.store.createRun(s.parent.id, "user", "work"); s.store.updateRun(run.id, { status: "running" }); });
  const b = await s.start(); await s.flush();
  const input = { runId: s.store.activeRun(s.parent.id)!.id, kind: "build" as const, command: process.execPath, args: ["-e", "process.exit(0)"] };
  await expect(s.host.createResource(s.parent.id, input)).rejects.toThrow(/owned worktree/);
  s.codex.sessions.forEach(session => session.complete('{"answer":"yes"}')); await s.flush();
  const resource = await s.host.createResource(s.parent.id, input);
  expect(resource.lease.thread_id).toBe(s.parent.id);
  expect(b.probes!.every(p => s.store.thread(p.threadId)?.settled_at)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 100));
});

it("publishes completed pre-existing results after a restart without another wake", async () => {
  const s = await setup(), b = await s.start(); await s.flush();
  s.codex.sessions.forEach(session => session.complete('{"answer":"retained"}')); await s.flush();
  await s.host.closeAll();
  const original = readFileSync(join(s.home, "fan-outs", b.fanOutId!, "results.json"), "utf8");
  const artifacts = join(s.home, "new-artifacts");
  const replacement = new LoomHost(s.store, { codex: s.codex, claude: s.claude }, { loomHome: s.home, fanOutArtifacts: artifacts });
  const wakes = s.store.runs(s.parent.id).length;
  try {
    await replacement.fanOuts.tick();
    expect(readFileSync(join(artifacts, `loom-fan-out-${b.fanOutId}`, "results.json"), "utf8")).toBe(original);
    expect(s.store.runs(s.parent.id)).toHaveLength(wakes);
  } finally { await replacement.closeAll(); }
});
