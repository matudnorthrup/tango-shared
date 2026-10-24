import { afterEach, expect, it, vi } from "vitest";
import { LoomStore } from "../src/store.js";
import { LoomHost, type Command } from "../src/host.js";
import { listAsks } from "../src/asks.js";
import { FakeRuntime } from "./fake-runtime.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.unstubAllEnvs(); });
const flush = () => new Promise(r => setTimeout(r, 0));
async function setup(kind = "do", resolves?: unknown) {
  vi.stubEnv("LOOM_ASK_LINT", "off");
  const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(store); const host = new LoomHost(store, { fake: runtime });
  closes.push(async () => { await host.closeAll(); store.close(); });
  let n = 0;
  const command = (c: Record<string, unknown>) => host.execute({ ...c, commandId: `c-${++n}` } as Command);
  const lead = store.createThread({ cwd: "/repo", kind: "coding", provider: "fake" });
  const worker = await command({ type: "submit", cwd: "/repo", provider: "fake", text: "build", parentThreadId: `loom:${lead.id}` });
  await command({ type: "handoff.record", threadId: worker.threadId, kind: "agent", who: `loom:${lead.id}`, text: "Review and ship the completed work", ask: { kind, ...(resolves ? { resolves } : {}) } });
  runtime.last.complete(); await flush();
  const report = () => command({ type: "submit", threadId: lead.id, text: `✉️ Reply from “Worker” [loom:${worker.threadId}] · m-report\n\nWork complete`, origin: { kind: "peer", from: `loom:${worker.threadId}`, mailId: "m-report" } });
  const reply = (from = `loom:${lead.id}`) => command({ type: "submit", threadId: worker.threadId, text: "Reviewed", origin: { kind: "peer", from, mailId: `m-${n}` } });
  return { store, host, runtime, command, lead, worker: worker.threadId!, report, reply, ask: () => listAsks(store)[0]! };
}
it.each(["do", "unclear", "pointer"])("settles %s only when the delivering run completes, and replay agrees", async kind => {
  const c = await setup(kind);
  expect(c.host.triggers.list(c.worker, "waiting")).toHaveLength(0);
  const delivery = await c.report();
  expect(c.ask().status).toBe("open");
  c.runtime.last.complete(); await flush();
  expect(c.ask()).toMatchObject({ status: "resolved", resolved_by: `delivered:${delivery.runId}` });
  expect(c.store.thread(c.worker)?.ask).toBeNull();
  c.host.rebuildAsks(); c.host.rebuildAsks();
  expect(c.ask().status).toBe("resolved");
  expect(c.store.thread(c.worker)?.ask).toBeNull();
});
it("keeps answer open until the addressee mails back, ignoring other senders", async () => {
  const c = await setup("answer"); await c.report(); c.runtime.last.complete(); await flush();
  expect(c.ask().status).toBe("open");
  await c.reply("loom:other"); expect(c.ask().status).toBe("open");
  await c.reply(); expect(c.ask()).toMatchObject({ status: "answered", resolved_by: `agent:loom:${c.lead.id}` });
  c.host.rebuildAsks(); expect(c.store.thread(c.worker)?.ask).toBeNull();
});
it("does not replace an explicit resolution trigger with delivery", async () => {
  const c = await setup("do", { kind: "file", ref: "/fixture/missing" });
  await c.report(); c.runtime.last.complete(); await flush();
  expect(c.ask().status).toBe("open");
  expect(c.host.triggers.list(c.worker, "waiting").some(t => t.ask_id === c.ask().id)).toBe(true);
});
it("backfills completed delivery and invalid automatic parent waits exactly once", async () => {
  const c = await setup(); const delivery = await c.report();
  c.store.updateRun(delivery.runId!, { status: "completed", ended_at: c.store.now() });
  c.host.triggers.create(c.worker, "worker", { threadId: c.lead.id }, "Armed by Loom from your hand-off to Lead: report");
  c.host.triggers.create(c.lead.id, "time", { afterMinutes: 60 }, "own work");
  expect(c.host.reconcileAgentHandoffs()).toEqual({ asks: 1, waits: 1 });
  expect(c.host.reconcileAgentHandoffs()).toEqual({ asks: 0, waits: 0 });
  expect(c.host.triggers.list(c.lead.id, "waiting")).toHaveLength(1);
  c.host.rebuildAsks(); expect(c.ask().status).toBe("resolved");
});

it("does not count the mail that started a handoff turn as its answer at the same timestamp", async () => {
  const c = await setup("answer");
  await c.reply();
  const now = c.store.now(); c.store.now = () => now;
  c.runtime.last.complete(); await flush();
  await c.reply();
  await c.command({ type: "handoff.record", threadId: c.worker, kind: "agent", who: `loom:${c.lead.id}`, text: "Send the next report", ask: { kind: "answer" } });
  c.runtime.last.complete(); await flush();
  expect(listAsks(c.store).at(-1)?.status).toBe("open");
  c.host.rebuildAsks(); expect(listAsks(c.store).at(-1)?.status).toBe("open");
});
it("native incoming mail closes the addressee ask and survives a fresh host", async () => {
  const c = await setup("answer");
  c.runtime.sessions[0]!.emit({ type: "peer.message", direction: "in", messageId: "native-reply", address: `loom:${c.lead.id}`, text: "Reviewed", name: "Lead" });
  expect(c.ask().status).toBe("answered");
  await c.host.closeAll();
  const restarted = new LoomHost(c.store, { fake: c.runtime });
  closes.push(() => restarted.closeAll());
  restarted.rebuildAsks();
  expect(c.store.thread(c.worker)?.ask).toBeNull();
  expect(c.ask().resolved_by).toBe(`agent:loom:${c.lead.id}`);
});
it("backfill answers historical mail and cancels only obsolete automatic waits", async () => {
  const c = await setup("answer");
  c.store.addMessage(c.worker, null, "user", "Reviewed", { kind: "peer", from: `loom:${c.lead.id}` });
  const peer = c.store.createThread({ cwd: "/repo", kind: "coding", provider: "fake" });
  const auto = c.host.triggers.create(c.worker, "worker", { threadId: peer.id }, "Armed by Loom from your hand-off to Peer: report");
  const explicit = c.host.triggers.create(c.worker, "worker", { threadId: c.lead.id }, "Explicitly requested wait");
  c.host.triggers.create(peer.id, "time", { afterMinutes: 60 }, "peer's timer");
  expect(c.host.reconcileAgentHandoffs()).toEqual({ asks: 1, waits: 1 });
  expect(c.host.triggers.list().find(t => t.id === auto)?.status).toBe("cancelled");
  expect(c.host.triggers.list().find(t => t.id === explicit)?.status).toBe("waiting");
  expect(c.ask().status).toBe("answered");
  expect(c.host.reconcileAgentHandoffs()).toEqual({ asks: 0, waits: 0 });
});

it.each(["do", "unclear", "pointer"])("settles %s after a fired worker wait is handled, including startup repair and replay", async kind => {
  const c = await setup(kind);
  const trigger = c.host.triggers.create(c.lead.id, "worker", { threadId: c.worker }, "receive work");
  const fired = c.store.now();
  c.store.db.prepare("UPDATE triggers SET status='fired', fired_at=? WHERE id=?").run(fired, trigger);
  const run = c.store.createRun(c.lead.id, "wake", "Worker finished");
  expect(c.host.reconcileAgentHandoffs().asks).toBe(0);
  c.store.updateRun(run.id, { status: "completed", ended_at: fired + 1 });
  expect(c.host.reconcileAgentHandoffs().asks).toBe(1);
  expect(c.ask()).toMatchObject({ status: "resolved", resolved_by: `delivered:${run.id}` });
  expect(c.store.thread(c.worker)?.ask).toBeNull();
  expect(c.host.reconcileAgentHandoffs().asks).toBe(0);
  c.host.rebuildAsks();
  expect(c.ask()).toMatchObject({ status: "resolved", resolved_by: `delivered:${run.id}` });
});
it.each(["before", "other-worker", "other-lead", "waiting", "cancelled", "failed-run", "answer", "resolves"])("does not treat %s as worker-trigger delivery", async scenario => {
  const c = await setup(scenario === "answer" ? "answer" : "do", scenario === "resolves" ? { kind: "file", ref: "/fixture/missing" } : undefined);
  const other = c.store.createThread({ cwd: "/repo", kind: "coding", provider: "fake" });
  const trigger = c.host.triggers.create(scenario === "other-lead" ? other.id : c.lead.id, "worker", { threadId: scenario === "other-worker" ? other.id : c.worker }, "receive work");
  const fired = scenario === "before" ? c.ask().created_at - 1 : c.store.now();
  c.store.db.prepare("UPDATE triggers SET status=?, fired_at=? WHERE id=?").run(["waiting", "cancelled"].includes(scenario) ? scenario : "fired", fired, trigger);
  const run = c.store.createRun(c.lead.id, "wake", "Worker finished");
  c.store.updateRun(run.id, { status: scenario === "failed-run" ? "failed" : "completed", ended_at: c.store.now() + 1 });
  expect(c.host.reconcileAgentHandoffs().asks).toBe(0);
  expect(c.ask().status).toBe("open");
});
it("reconciles worker-trigger delivery on live run completion", async () => {
  const c = await setup();
  const trigger = c.host.triggers.create(c.lead.id, "worker", { threadId: c.worker }, "receive work");
  await c.host.triggers.tick(); await flush();
  expect(c.host.triggers.list().find(t => t.id === trigger)?.status).toBe("fired");
  const run = c.store.activeRun(c.lead.id)!;
  expect(run.text).toContain("the trigger you set fired: waiting for worker");
  expect(c.ask().status).toBe("open");
  c.runtime.last.complete(); await flush();
  expect(c.ask()).toMatchObject({ status: "resolved", resolved_by: `delivered:${run.id}` });
});
it.each(["reply", "mail", "worker"])("backfill chooses the earliest closing event when %s is first", async first => {
  const c = await setup();
  const base = c.store.now() + 10;
  const times = { reply: base + 10, mail: base + 20, worker: base + 30, [first]: base };
  const trigger = c.host.triggers.create(c.lead.id, "worker", { threadId: c.worker }, "receive work");
  c.store.db.prepare("UPDATE triggers SET status='fired', fired_at=? WHERE id=?").run(base - 1, trigger);
  const workerRun = c.store.createRun(c.lead.id, "wake", "Worker finished");
  c.store.updateRun(workerRun.id, { status: "completed", ended_at: times.worker });
  const mailRun = c.store.createRun(c.lead.id, "user", "Report");
  c.store.addMessage(c.lead.id, mailRun.id, "user", "✉️ Reply from Worker", { kind: "peer", from: `loom:${c.worker}` });
  c.store.updateRun(mailRun.id, { status: "completed", ended_at: times.mail });
  c.store.now = () => times.reply;
  c.store.addMessage(c.worker, null, "user", "Reviewed", { kind: "peer", from: `loom:${c.lead.id}` });
  expect(c.host.reconcileAgentHandoffs().asks).toBe(1);
  expect(c.ask()).toMatchObject(first === "reply"
    ? { status: "answered", resolved_by: `agent:loom:${c.lead.id}` }
    : { status: "resolved", resolved_by: `delivered:${first === "mail" ? mailRun.id : workerRun.id}` });
});
