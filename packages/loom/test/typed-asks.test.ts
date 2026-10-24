import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LoomStore } from "../src/store.js";
import { LoomHost, type Command } from "../src/host.js";
import { askRow, listAsks, type AskSpec, validateAsk } from "../src/asks.js";
import { UNCLEAR_ASK_WAKE_TEXT } from "../src/handoff.js";
import { createLoomServer } from "../src/http.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = () => new Promise(r => setTimeout(r, 0));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
async function setup() {
  vi.stubEnv("LOOM_ASK_LINT", "off");
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  let seq = 0;
  const command = (input: Omit<Command, "commandId"> | Record<string, unknown>) => host.execute({ ...input, commandId: `typed-${++seq}` } as Command);
  const start = await command({ type: "submit", text: "Build it", cwd: "/repo", provider: "fake" });
  const thread = start.threadId!;
  cleanups.push(async () => { await host.closeAll(); store.close(); });
  const handoff = async (ask: AskSpec | undefined = { kind: "do" }, text = "Plug in the test cable") => {
    await command({ type: "handoff.record", threadId: thread, owner: "you", text, ...(ask ? { ask } : {}) });
    runtime.last.complete("Handed off."); await flush();
    return listAsks(store).at(-1)!;
  };
  const mail = async () => { await command({ type: "submit", threadId: thread, text: "Review progress", origin: { kind: "peer", from: "loom:fixture-lead", name: "Lead", mailId: `m-${seq}` } }); };
  return { store, host, runtime, command, thread, handoff, mail };
}

it.each(["do", "answer", "pointer"] as const)("records declared %s and exposes the rich record", async kind => {
  const { handoff, host, thread } = await setup();
  const row = await handoff({ kind }, kind === "pointer" ? "Answer D-999 on its card" : undefined);
  expect(row).toMatchObject({ id: "A-1", kind, status: "open", revision: 1 });
  const payload = host.snapshot().threads.find(t => t.id === thread)!;
  expect(payload.ask_record).toMatchObject({ id: row.id, kind, status: "open" });
  if (kind === "pointer") { expect(row.points_to).toBe("D-999"); expect(payload.ask).toBeNull(); }
  else expect(JSON.parse(payload.ask!)).toMatchObject({ id: row.id, kind, status: "open" });
});
it("missing kind wakes once, and the correction revises the same row", async () => {
  const { store, runtime, command, thread } = await setup();
  await command({ type: "handoff.record", threadId: thread, owner: "you", text: "Install the replacement test cable" });
  runtime.last.complete("Handed off."); await flush();
  const unclear = listAsks(store).at(-1)!;
  expect(unclear.kind).toBe("unclear");
  expect(store.runs(thread).filter(r => r.text === UNCLEAR_ASK_WAKE_TEXT)).toHaveLength(1);
  await command({ type: "handoff.record", threadId: thread, owner: "you", text: unclear.text, ask: { kind: "do" } });
  runtime.last.complete("Kind declared."); await flush();
  expect(askRow(store, unclear.id)).toMatchObject({ kind: "do", revision: 2, created_at: unclear.created_at });
  expect(store.runs(thread).filter(r => r.text === UNCLEAR_ASK_WAKE_TEXT)).toHaveLength(1);
});
it("invalid kind becomes unclear; malformed optional fields are refused", async () => {
  expect(validateAsk({ kind: "bogus" }).kind).toBe("unclear");
  const { command, thread } = await setup();
  for (const ask of [{ kind: "do", steps: ["only"] }, { kind: "do", due: "tomorrow" }, { kind: "do", resolves: { kind: "pr", ref: "junk" } }]) {
    await expect(command({ type: "handoff.record", threadId: thread, owner: "you", text: "Plug in the test cable", ask })).rejects.toThrow();
  }
});
it("unchanged words preserve id and creation time; typed changes revise and new words supersede", async () => {
  const { handoff, mail, store, thread, host } = await setup();
  const original = await handoff({ kind: "do", steps: ["Connect", "Power on"] });
  await mail(); await handoff({ kind: "do", steps: ["Connect", "Power on"] });
  expect(listAsks(store)).toHaveLength(1);
  expect(askRow(store, original.id)?.revision).toBe(1);
  await mail(); await handoff({ kind: "answer", due: "2099-01-01T00:00:00Z" });
  expect(askRow(store, original.id)).toMatchObject({ revision: 2, created_at: original.created_at, kind: "answer" });
  expect(store.db.prepare("SELECT * FROM ask_revisions").all()).toHaveLength(1);
  host.rebuildAsks();
  expect(JSON.parse(store.thread(thread)!.ask!).revision).toBe(2);
  await mail(); const newer = await handoff({ kind: "do" }, "Install the spare test adapter");
  expect(newer.id).toBe("A-2");
  expect(askRow(store, original.id)).toMatchObject({ status: "superseded", resolved_by: "agent" });
});
it("corrective turns cannot replace the ask with different words", async () => {
  const { command, runtime, thread, store } = await setup();
  await command({ type: "handoff.record", threadId: thread, owner: "you", text: "Plug in the test cable" });
  runtime.last.complete(); await flush();
  await command({ type: "handoff.record", threadId: thread, owner: "you", text: "Buy a different test adapter", ask: { kind: "do" } });
  runtime.last.complete(); await flush();
  expect(listAsks(store)).toHaveLength(1);
  expect(listAsks(store)[0]?.text).toBe("Plug in the test cable");
  expect(store.runs(thread).filter(r => r.text === UNCLEAR_ASK_WAKE_TEXT)).toHaveLength(1);
});
it("step resolution persists progress, resolves once, wakes with note, and survives replay", async () => {
  const { handoff, command, store, thread, host } = await setup();
  const row = await handoff({ kind: "do", steps: ["Connect cable", "Turn on power"] });
  await command({ type: "ask.resolve", askId: row.id, outcome: "done", step: "1", by: "person" });
  expect(askRow(store, row.id)?.status).toBe("open");
  expect(JSON.parse(askRow(store, row.id)!.steps!)[0]).toMatchObject({ text: "Connect cable", by: "person", done_at: expect.any(Number) });
  expect(store.runs(thread).filter(r => r.source === "wake")).toHaveLength(0);
  await command({ type: "ask.resolve", askId: row.id, outcome: "done", step: "Turn on power", by: "desk", note: "Both lights are on" });
  expect(askRow(store, row.id)).toMatchObject({ status: "done", resolved_by: "desk", resolution_note: "Both lights are on" });
  const wakes = store.runs(thread).filter(r => r.source === "wake");
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.text).toContain(`Ask ${row.id} done: ${row.text}. Marked by desk on the desk at`);
  expect(wakes[0]!.text).toContain("Both lights are on");
  await expect(command({ type: "ask.resolve", askId: row.id, outcome: "done", by: "person" })).rejects.toMatchObject({ code: "not_open" });
  host.rebuildAsks();
  expect(store.thread(thread)!.ask).toBeNull();
  expect(listAsks(store)).toHaveLength(1);
  expect(store.runs(thread).filter(r => r.source === "wake")).toHaveLength(1);
});
it.each(["done", "withdrawn"] as const)("whole ask %s records cause and appropriate wake", async outcome => {
  const { handoff, command, store, thread, host } = await setup();
  const row = await handoff();
  await command({ type: "ask.resolve", askId: row.id, outcome, by: "person" });
  expect(askRow(store, row.id)).toMatchObject({ status: outcome, resolved_by: outcome === "done" ? "person" : "agent" });
  expect(store.thread(thread)!.ask).toBeNull();
  host.rebuildAsks(); expect(store.thread(thread)!.ask).toBeNull();
  expect(store.runs(thread).filter(r => r.source === "wake")).toHaveLength(outcome === "done" ? 1 : 0);
});
it("owner chat closes as answered; normal handoffs retire as withdrawn", async () => {
  const { handoff, command, store, thread, runtime, host } = await setup();
  const row = await handoff();
  await command({ type: "submit", threadId: thread, text: "Installed" });
  expect(askRow(store, row.id)).toMatchObject({ status: "answered", resolved_by: "person-chat" });
  const next = await handoff();
  store.tx(() => store.createRun(thread, "wake", "Loom: continue")); await host.kick(thread);
  await command({ type: "handoff.record", threadId: thread, kind: "nobody", text: "done" });
  runtime.last.complete(); await flush();
  expect(askRow(store, next.id)).toMatchObject({ status: "withdrawn", resolved_by: "agent" });
});
it("desk Clear records closed-by-done; Undo restores the original row", async () => {
  const { handoff, command, store, thread, host } = await setup();
  const row = await handoff();
  const cutoff = store.now() + 1;
  await command({ type: "clear", threadId: thread, clearedAt: cutoff });
  expect(askRow(store, row.id)).toMatchObject({ status: "closed-by-done", resolved_by: "desk" });
  host.rebuildAsks(); expect(store.thread(thread)!.ask).toBeNull();
  await command({ type: "clear.undo", threadId: thread, clearedAt: cutoff });
  expect(askRow(store, row.id)?.status).toBe("open");
  expect(JSON.parse(store.thread(thread)!.ask!).id).toBe(row.id);
});
it.each(["MERGED", "CLOSED"])("PR %s resolves its ask, while another close cancels the trigger", async state => {
  const { handoff, store, host, thread, command, runtime } = await setup();
  const row = await handoff({ kind: "do", resolves: { kind: "pr", ref: "https://github.com/example/repo/pull/12" } });
  const trigger = host.triggers.list(thread)[0]!;
  expect(trigger.ask_id).toBe(row.id);
  expect(host.detail(thread)!.waits).toEqual([]);
  expect(host.snapshot().threads.find(t => t.id === thread)!.waiting_on).toEqual([]);
  const io = (host.triggers as unknown as { io: { command: (...args: unknown[]) => Promise<string> } }).io;
  vi.spyOn(io, "command").mockResolvedValue(JSON.stringify({ state, ...(state === "MERGED" ? { mergedAt: new Date().toISOString() } : { closedAt: new Date().toISOString() }) }));
  await host.triggers.tick(); await flush();
  expect(askRow(store, row.id)).toMatchObject({ status: "resolved", resolved_by: `record:${trigger.id}` });
  expect(store.runs(thread).some(r => r.text.includes(`Ask ${row.id} resolved`))).toBe(true);
  await command({ type: "handoff.record", threadId: thread, owner: "you", text: "Plug in another test cable", ask: { kind: "do", resolves: { kind: "file", ref: "/fixture/not-there" } } });
  // Complete the trigger wake, opening a different ask.
  runtime.last.complete(); await flush();
  const other = listAsks(store).at(-1)!;
  const nextTrigger = host.triggers.list(thread).find(t => t.ask_id === other.id)!;
  await command({ type: "ask.resolve", askId: other.id, outcome: "withdrawn", by: "agent" });
  expect(host.triggers.list(thread).find(t => t.id === nextTrigger.id)?.status).toBe("cancelled");
});
it("past due expires once; tripwire asks never expire", async () => {
  const { handoff, host, store, thread } = await setup();
  const row = await handoff({ kind: "do", due: "2000-01-01T00:00:00Z" });
  host.askClock.tick(); host.askClock.tick();
  expect(askRow(store, row.id)?.status).toBe("expired");
  expect(store.thread(thread)!.ask).toBeNull();
  expect(store.runs(thread).filter(r => r.text.includes(`Ask ${row.id} expired`))).toHaveLength(1);
  host.rebuildAsks(); expect(store.thread(thread)!.ask).toBeNull();
});
it.each(["identity", "credentials-identity", "security-privacy"])("tripwire %s prevents expiry", async cls => {
  const { handoff, host, store } = await setup();
  const row = await handoff({ kind: "do", class: cls, due: "2000-01-01T00:00:00Z" });
  host.askClock.tick(); expect(askRow(store, row.id)?.status).toBe("open");
});
it("migrates a legacy pointer once without a wake and preserves its provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "typed-ask-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.sqlite");
  let store = new LoomStore(path);
  const thread = store.createThread({ kind: "coding", cwd: "/repo", provider: "fake" });
  store.updateThread(thread.id, { ask: JSON.stringify({ text: "Plug in the test cable", at: 1234, messageId: "legacy-message", runId: "legacy-run" }) });
  store.close(); store = new LoomStore(path);
  expect(listAsks(store)).toHaveLength(1);
  expect(listAsks(store)[0]).toMatchObject({ id: "A-1", kind: "unclear", legacy: 1, created_at: 1234, message_id: "legacy-message", run_id: "legacy-run" });
  expect(JSON.parse(store.thread(thread.id)!.ask!)).toMatchObject({ id: "A-1", kind: "unclear" });
  expect(store.runs(thread.id)).toEqual([]);
  store.close(); store = new LoomStore(path);
  expect(listAsks(store)).toHaveLength(1); store.close();
});
it("HTTP lists, reads and resolves asks; thread and snapshot include the record", async () => {
  const { host, handoff, thread, store } = await setup();
  const row = await handoff({ kind: "do", steps: ["Connect", "Power"] });
  const server = createLoomServer(host, { token: "fixture-token" });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: "Bearer fixture-token", "content-type": "application/json" } });
  expect((await fetch(base + "/asks")).status).toBe(401);
  expect(await (await call("/asks?status=open")).json()).toMatchObject([{ id: row.id, steps: [{ text: "Connect" }, { text: "Power" }] }]);
  expect(await (await call(`/asks/${row.id}`)).json()).toMatchObject({ id: row.id, revision: 1 });
  expect((await call("/asks/A-9999")).status).toBe(404);
  const detail = await (await call(`/threads/${thread}`)).json();
  expect(detail.thread.ask_record.id).toBe(row.id);
  const snap = await (await call("/snapshot")).json();
  expect(snap.threads[0].ask_record.id).toBe(row.id);
  const done = await call("/commands", { method: "POST", body: JSON.stringify({ type: "ask.resolve", commandId: "http-done", askId: row.id, outcome: "done", by: "desk" }) });
  expect(done.status).toBe(200);
  expect(askRow(store, row.id)?.status).toBe("done");
  expect(await (await call("/asks?status=open")).json()).toEqual([]);
});

it("request answer closes an ordinary ask with person-chat", async () => {
  const { host, store, command, thread, handoff } = await setup();
  const row = await handoff({ kind: "answer" }, "Tell me the port number");
  store.tx(() => store.openRequest(thread, null, "question", { question: "Which port?" }, "request-fixture"));
  await command({ type: "answer", requestId: "request-fixture", answer: { text: "port 2" } });
  expect(askRow(store, row.id)).toMatchObject({ status: "answered", resolved_by: "person-chat" });
  host.rebuildAsks(); expect(store.thread(thread)!.ask).toBeNull();
});
const decisionBrief = {
  about: "Fixture cable test", class: "plan-approval", ask: "Run the cable test? Recommend the bench test.", door: "two-way", blast: "private",
  standing: "The cable test is ready to run.", background: "The bench test checks the replacement cable before installation.",
  options: [{ key: "A", label: "Bench test", consequence: "Checks continuity", recommended: true }, { key: "B", label: "Wait", consequence: "Leaves the cable untested" }],
  proposedRule: "Next time, for fixture cable tests, run the bench test without asking",
};
it.each(["answer", "close"] as const)("decision %s resolves its pointer and recovery retains the outcome", async action => {
  const { command, thread, handoff, store, host } = await setup();
  const decision = await command({ type: "decision.request", threadId: thread, brief: decisionBrief });
  const row = await handoff({ kind: "pointer" }, `Answer ${decision.decisionId} on its card`);
  await command(action === "answer" ? { type: "decision.answer", decisionId: decision.decisionId, option: "A", rule: "once" } : { type: "decision.close", threadId: thread, decisionId: decision.decisionId, outcome: "moot", note: "Cable was replaced already" });
  expect(askRow(store, row.id)).toMatchObject({ status: "resolved", resolved_by: `record:${decision.decisionId}` });
  host.rebuildAsks(); expect(store.thread(thread)!.ask).toBeNull();
});
it("revising steps preserves completed steps when unchanged and replaces only the ask's own trigger", async () => {
  const { handoff, command, mail, store, host, thread } = await setup();
  const row = await handoff({ kind: "do", steps: ["Connect", "Power"], resolves: { kind: "file", ref: "/fixture/old" } });
  const old = host.triggers.list(thread)[0]!;
  const own = host.triggers.create(thread, "time", { afterMinutes: 60 }, "Thread's own wait");
  await command({ type: "ask.resolve", askId: row.id, outcome: "done", step: "1", by: "person" });
  await mail(); await handoff({ kind: "do", steps: ["Connect", "Power"], resolves: { kind: "file", ref: "/fixture/new" } });
  expect(askRow(store, row.id)?.revision).toBe(2);
  expect(JSON.parse(askRow(store, row.id)!.steps!)[0].done_at).toBeTypeOf("number");
  expect(host.triggers.list(thread).find(t => t.id === old.id)?.status).toBe("cancelled");
  expect(host.triggers.list(thread).find(t => t.id === own)?.status).toBe("waiting");
  expect(host.triggers.list(thread, "waiting").filter(t => t.ask_id === row.id)).toHaveLength(1);
});
it("a failing ask trigger leaves the ask open rather than falsely recording resolution", async () => {
  const { handoff, host, store, thread } = await setup();
  const row = await handoff({ kind: "do", resolves: { kind: "pr", ref: "example/repo#12" } });
  const trigger = host.triggers.list(thread)[0]!;
  store.db.prepare("UPDATE triggers SET expires_at=0 WHERE id=?").run(trigger.id);
  await host.triggers.tick();
  expect(askRow(store, row.id)?.status).toBe("open");
  expect(store.runs(thread).some(r => r.text.includes(`resolution check for ask ${row.id} failed`))).toBe(true);
});
it.each(["answered", "expired"] as const)("a request %s on another thread resolves the pointer once", async outcome => {
  const { store, host, runtime, command, thread } = await setup();
  const pointingSession = runtime.last;
  const target = await command({ type: "submit", text: "Ask a question", cwd: "/repo", provider: "fake" });
  runtime.last.emit({ type: "request.opened", runId: target.runId!, requestId: "cross-request", kind: "question", payload: { question: "Which cable?" } });
  await command({ type: "handoff.record", threadId: thread, owner: "you", text: "Answer cross-request on its card", ask: { kind: "pointer" } });
  pointingSession.complete(); await flush();
  const row = listAsks(store).find(r => r.thread === thread)!;
  expect(row.points_to).toBe("cross-request");
  if (outcome === "answered") await command({ type: "answer", requestId: "cross-request", answer: { text: "blue" } });
  else { runtime.last.complete(); await flush(); }
  expect(askRow(store, row.id)).toMatchObject({ status: "resolved", resolved_by: "record:cross-request" });
  host.rebuildAsks(); expect(store.thread(thread)!.ask).toBeNull();
  expect(store.runs(thread).filter(r => r.text.includes(`Ask ${row.id} resolved`))).toHaveLength(1);
});
it("recovery records a missed owner-chat close as answered, not withdrawn", async () => {
  const { handoff, store, host, thread } = await setup();
  const row = await handoff();
  store.now = () => row.created_at + 1000;
  store.tx(() => store.addMessage(thread, null, "user", "I connected it"));
  host.rebuildAsks();
  expect(askRow(store, row.id)).toMatchObject({ status: "answered", resolved_by: "person-chat" });
  expect(store.thread(thread)!.ask).toBeNull();
});
it.each(["done", "expired"] as const)("replay keeps the ask renewed after a %s closure (Codex review on #1031)", async how => {
  const { handoff, command, store, thread, host } = await setup();
  const first = await handoff(how === "expired" ? { kind: "do", due: "2000-01-01T00:00:00Z" } : { kind: "do" });
  if (how === "done") await command({ type: "ask.resolve", askId: first.id, outcome: "done", by: "person" });
  else host.askClock.tick();
  expect(askRow(store, first.id)?.status).toBe(how);
  await host.kick(thread); await flush();
  // The wake that reported the closure hands off the same words: live, that is a new open ask.
  const renewed = await handoff({ kind: "do" });
  expect(renewed).toMatchObject({ id: "A-2", status: "open" });
  host.rebuildAsks();
  expect(askRow(store, first.id)?.status).toBe(how);
  expect(askRow(store, renewed.id)?.status).toBe("open");
  expect(JSON.parse(store.thread(thread)!.ask!).id).toBe(renewed.id);
  const cutoff = store.now() + 1;
  await command({ type: "clear", threadId: thread, clearedAt: cutoff });
  expect(askRow(store, renewed.id)).toMatchObject({ status: "closed-by-done", resolved_by: "desk" });
  await command({ type: "clear.undo", threadId: thread, clearedAt: cutoff });
  expect(askRow(store, renewed.id)?.status).toBe("open");
  expect(JSON.parse(store.thread(thread)!.ask!).id).toBe(renewed.id);
});
it("Undo of a desk Clear arms a fresh resolution trigger (Codex review on #1031)", async () => {
  const { handoff, command, store, thread, host } = await setup();
  const row = await handoff({ kind: "do", resolves: { kind: "pr", ref: "https://github.com/example/repo/pull/12" } });
  const trigger = host.triggers.list(thread)[0]!;
  expect(trigger.ask_id).toBe(row.id);
  const cutoff = store.now() + 1;
  await command({ type: "clear", threadId: thread, clearedAt: cutoff });
  expect(host.triggers.list(thread).find(t => t.id === trigger.id)?.status).toBe("cancelled");
  await command({ type: "clear.undo", threadId: thread, clearedAt: cutoff });
  expect(askRow(store, row.id)?.status).toBe("open");
  const armed = host.triggers.list(thread, "waiting");
  expect(armed).toHaveLength(1);
  expect(armed[0]).toMatchObject({ ask_id: row.id, kind: "pr" });
  expect(armed[0]!.id).not.toBe(trigger.id);
  expect(JSON.parse(askRow(store, row.id)!.resolves!).trigger_id).toBe(armed[0]!.id);
  const io = (host.triggers as unknown as { io: { command: (...args: unknown[]) => Promise<string> } }).io;
  vi.spyOn(io, "command").mockResolvedValue(JSON.stringify({ state: "MERGED", mergedAt: new Date().toISOString() }));
  await host.triggers.tick(); await flush();
  expect(askRow(store, row.id)).toMatchObject({ status: "resolved", resolved_by: `record:${armed[0]!.id}` });
  expect(store.thread(thread)!.ask).toBeNull();
});

it("guards both full and step completions and preserves command replay", async () => {
  const { handoff, mail, command, host, store } = await setup();
  const row = await handoff({ kind: "do", steps: ["Connect", "Unlock"] });
  await mail(); await handoff({ kind: "do", steps: ["Reconnect", "Unlock"] });
  for (const step of [undefined, "1"]) {
    for (const revision of [undefined, 1]) {
      await expect(command({ type: "ask.resolve", askId: row.id, outcome: "done", by: "person", step, revision })).rejects.toMatchObject({ code: "stale" });
    }
  }
  expect(JSON.parse(askRow(store, row.id)!.steps!)).toEqual([{ text: "Reconnect" }, { text: "Unlock" }]);
  const done = { type: "ask.resolve", commandId: "stable-done", askId: row.id, outcome: "done", by: "person", revision: 2 } as const;
  const receipt = await host.execute(done);
  expect(await host.execute(done)).toEqual(receipt);
  await expect(command({ ...done, commandId: "new-done" })).rejects.toMatchObject({ code: "not_open" });
});
it("ordinary Done closes its ask; its explicit Undo reopens it, but never after a new owner message", async () => {
  const { handoff, command, host, store, thread } = await setup();
  const row = await handoff();
  await command({ type: "settle", threadId: thread, settledAt: 123 });
  expect(askRow(store, row.id)).toMatchObject({ status: "closed-by-done", resolved_by: "desk" });
  expect(store.thread(thread)!.ask).toBeNull();
  host.rebuildAsks();
  expect(store.thread(thread)!.ask).toBeNull();
  await command({ type: "settle.undo", threadId: thread, settledAt: 122 });
  expect(askRow(store, row.id)?.status).toBe("closed-by-done");
  await command({ type: "settle.undo", threadId: thread, settledAt: 123 });
  expect(askRow(store, row.id)?.status).toBe("open");
  expect(JSON.parse(store.thread(thread)!.ask!).id).toBe(row.id);
  await command({ type: "settle", threadId: thread, settledAt: 124 });
  await command({ type: "submit", threadId: thread, text: "A new request" });
  await command({ type: "settle.undo", threadId: thread, settledAt: 124 });
  expect(askRow(store, row.id)?.status).toBe("closed-by-done");
});
it("declaring a migrated ask clears legacy even if its kind was already set", async () => {
  const { handoff, mail, store } = await setup();
  const row = await handoff();
  store.db.prepare("UPDATE asks SET legacy=1 WHERE id=?").run(row.id);
  await mail(); await handoff();
  expect(askRow(store, row.id)).toMatchObject({ kind: "do", legacy: 0, revision: 2 });
});
it("lint records declared kinds, distinguishes thread asks, and does not call revisions repeats", async () => {
  const { store, command, handoff, runtime, thread } = await setup();
  vi.stubEnv("LOOM_ASK_LINT", "on");
  const text = "Choose between the two drive layouts";
  const row = await handoff({ kind: "answer" }, text);
  const otherThread = (await command({ type: "submit", text: "Another task", cwd: "/repo", provider: "fake" })).threadId!;
  await command({ type: "handoff.record", threadId: otherThread, owner: "you", text, ask: { kind: "answer" } });
  runtime.last.complete("Handed off."); await flush();
  const other = listAsks(store).find(r => r.thread === otherThread)!;
  expect(other.id).not.toBe(row.id);
  for (const ask of [row, other]) {
    expect(store.db.prepare("SELECT kind,declared_kind,ask_id,woke FROM ask_lints WHERE thread_id=?").all(ask.thread)).toEqual([{ kind: "decision", declared_kind: "answer", ask_id: ask.id, woke: 1 }]);
  }
  // Revise the first ask during its corrective turn; its one wake remains the only one.
  await command({ type: "handoff.record", threadId: thread, owner: "you", text, ask: { kind: "do" } });
  runtime.sessions.find(s => s.options.threadId === thread)!.complete("Kind corrected."); await flush();
  expect(store.db.prepare("SELECT kind,declared_kind,ask_id,woke FROM ask_lints WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(thread)).toEqual({ kind: "decision", declared_kind: "do", ask_id: row.id, woke: 0 });
});
it("migrates old lint tables without losing their classifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-lint-migration-"));
  const path = join(dir, "test.sqlite");
  const original = new LoomStore(path);
  const thread = original.createThread({ kind: "coding", cwd: "/repo", provider: "fake" });
  original.db.prepare("INSERT INTO ask_lints (id,thread_id,kind,reason,ask,norm,created_at) VALUES (?,?,?,?,?,?,?)").run("old-lint", thread.id, "todo", "legacy classification", "Connect the drive", "connect the drive", 1);
  original.db.exec("ALTER TABLE ask_lints DROP COLUMN declared_kind; ALTER TABLE ask_lints DROP COLUMN ask_id");
  original.close();
  const upgraded = new LoomStore(path);
  try {
    const columns = upgraded.db.prepare("PRAGMA table_info(ask_lints)").all().map(c => c.name);
    expect(columns).toContain("declared_kind");
    expect(columns).toContain("ask_id");
    expect(upgraded.db.prepare("SELECT kind,declared_kind,ask_id FROM ask_lints WHERE id='old-lint'").get()).toMatchObject({ kind: "todo", declared_kind: null, ask_id: null });
  } finally { upgraded.close(); rmSync(dir, { recursive: true, force: true }); }
});
it("Undo of a later Done without an ask cannot resurrect an earlier closed ask", async () => {
  const { handoff, command, store, thread } = await setup();
  const row = await handoff();
  await command({ type: "settle", threadId: thread, settledAt: 100 });
  await command({ type: "unsettle", threadId: thread });
  await command({ type: "settle", threadId: thread, settledAt: 200 });
  await command({ type: "settle.undo", threadId: thread, settledAt: 200 });
  expect(askRow(store, row.id)?.status).toBe("closed-by-done");
  expect(store.thread(thread)!.ask).toBeNull();
});
