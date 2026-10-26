import { writeFileSync } from "node:fs";
import { LoomHost } from "../../loom/src/host.js";
import { LoomStore } from "../../loom/src/store.js";
import { FakeRuntime } from "../../loom/test/fake-runtime.js";
import { createLoomServer } from "../../loom/src/http.js";
import { LoomRuntimeAdapter } from "@tango/core";
import type { AgentConfig } from "@tango/core";
import { buildDefaultAccessPolicy } from "../src/access-control.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TangoStorage, liveLoomDeliveries, type LoomDelivery, type LoomThreadDetail } from "@tango/core";
import { registerDecisionDeliveries, recoverLoomReplies, recoveredLoomModelRun, LOOM_FAILURE_NOTICE, LOOM_PENDING_NOTICE, pendingLoomRetry, sendPendingLoomRetryNotice } from "../src/loom-reply-recovery.js";
import { createReplyPresenter } from "../src/reply-presentation.js";
let dir: string, store: TangoStorage;
const record: LoomDelivery = { runId: "run", loomThreadId: "loom-thread", agentId: "test", conversationKey: "chat",
  channelId: "channel", threadId: "thread", messageId: "message", createdAt: new Date().toISOString(),
  context: { sessionId: "session", prompt: "hello", occurredAt: new Date().toISOString() } };
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "loom-delivery-")); store = new TangoStorage(path.join(dir, "db")); store.insertLoomDelivery(record); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); liveLoomDeliveries.clear(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function harness(status = "completed") {
  const detail: LoomThreadDetail = { runs: [{ id: "run", status }], messages: [
    { run_id: "old", role: "assistant", text: "old" }, { run_id: "run", role: "assistant", text: "answer" }], items: [] };
  const readThread = vi.fn(async () => detail);
  const send = vi.fn(async (_content: unknown) => ({ id: "reply" }));
  const presenter = createReplyPresenter();
  const hook = vi.fn();
  const deliver = vi.fn(async (delivery, response) => {
    await presenter.sendChunked({ id: delivery.threadId, isSendable: () => true, send }, response.text,
      { speaker: { id: "test", type: "personal", displayName: "Test", provider: { default: "claude" } }, replyToMessageId: delivery.messageId });
    hook(response);
  });
  return { store, readThread, deliver, send, hook, detail };
}
it("delivers a completed detached run exactly once, including concurrent passes and after reopening SQLite", async () => {
  store.close(); store = new TangoStorage(path.join(dir, "db"));
  const h = harness();
  await Promise.all([recoverLoomReplies(h), recoverLoomReplies(h)]);
  await recoverLoomReplies(h);
  expect(h.send).toHaveBeenCalledExactlyOnceWith({ content: "answer", reply: { messageReference: "message", failIfNotExists: false } });
  expect(h.hook).toHaveBeenCalledTimes(1); expect(store.listPendingLoomDeliveries()).toEqual([]);
});
it("skips live ownership until presentation finishes", async () => {
  const h = harness(); liveLoomDeliveries.add("run");
  await recoverLoomReplies(h); expect(h.readThread).not.toHaveBeenCalled();
  expect(store.claimLoomDelivery("run")).toBe(true);
  await h.deliver(record, { text: "live", durationMs: 1 });
  store.finishLoomDelivery("run", "delivered"); liveLoomDeliveries.delete("run");
  await recoverLoomReplies(h); expect(h.send).toHaveBeenCalledTimes(1);
});
it("rechecks ownership acquired while fetching Loom", async () => {
  const h = harness(); h.readThread.mockImplementation(async () => { liveLoomDeliveries.add("run"); return h.detail; });
  await recoverLoomReplies(h); expect(h.deliver).not.toHaveBeenCalled();
});
it.each(["failed", "interrupted"])("posts the live failure notice for %s", async status => {
  const h = harness(status); await recoverLoomReplies(h); await recoverLoomReplies(h);
  expect(h.send).toHaveBeenCalledExactlyOnceWith({ content: LOOM_FAILURE_NOTICE, reply: { messageReference: "message", failIfNotExists: false } });
});
it("leaves running runs pending, then delivers on a later pass", async () => {
  const h = harness("running"); await recoverLoomReplies(h); expect(h.send).not.toHaveBeenCalled();
  h.detail.runs[0]!.status = "completed"; await recoverLoomReplies(h); expect(h.send).toHaveBeenCalledTimes(1);
});
it("abandons missing runs after 24 hours and logs it", async () => {
  const h = harness("running"), log = vi.fn();
  h.detail.runs = [];
  await recoverLoomReplies({ ...h, now: Date.parse(record.createdAt) + 86_400_001, log });
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Abandoned"));
  expect(store.listPendingLoomDeliveries()).toEqual([]); expect(h.send).not.toHaveBeenCalled();
});
it("honors the recovery kill switch", async () => {
  vi.stubEnv("TANGO_LOOM_RECOVER_REPLIES", "off"); const h = harness();
  await recoverLoomReplies(h); expect(h.readThread).not.toHaveBeenCalled(); expect(store.listPendingLoomDeliveries()).toHaveLength(1);
});
it("does not replay an uncertain send after a claim", async () => {
  const h = harness(); h.deliver.mockRejectedValue(new Error("Discord disconnected"));
  await recoverLoomReplies(h); await recoverLoomReplies(h); expect(h.deliver).toHaveBeenCalledTimes(1);
});

it("preserves webhook persona and chunking with a reference to the triggering message", async () => {
  const h = harness(); h.detail.messages[1]!.text = "A".repeat(4000);
  const send = vi.fn(async (_content: unknown) => ({ id: "webhook-reply" }));
  const presenter = createReplyPresenter();
  await recoverLoomReplies({ ...h, deliver: async (delivery, response) => {
    await presenter.sendChunked({ id: "thread", guildId: "guild", isSendable: () => true, send: vi.fn(),
      isThread: () => true, parent: { id: "channel", fetchWebhooks: async () => [{ id: "hook", name: "Tango Replies", token: "fake", send }],
        createWebhook: vi.fn() } }, response.text,
      { speaker: { id: "test", type: "personal", displayName: "Test", provider: { default: "claude" } }, replyToMessageId: delivery.messageId });
  } });
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[0]![0]).toMatchObject({ username: "Test", threadId: "thread", content: expect.stringContaining("https://discord.com/channels/guild/thread/message") });
});

it.each(["completed", "failed"])("records one primary model run for recovered %s turns", async status => {
  const h = harness(status);
  h.detail.runs[0] = { id: "run", status, started_at: 1000, ended_at: 2500 };
  const delivery = { ...record, context: { ...record.context, model: "test-model" } };
  store.close(); store = new TangoStorage(path.join(dir, "telemetry-db"));
  store.upsertSession({ id: "session", type: "persistent", agent: "test", channels: [] });
  store.insertLoomDelivery(delivery);
  const write = vi.fn((record, response) => store.insertModelRun(recoveredLoomModelRun(record, response, null)));
  const options = { ...h, store, deliver: async (record, response) => { write(record, response); } };
  await Promise.all([recoverLoomReplies(options), recoverLoomReplies(options)]);
  await recoverLoomReplies(options);
  expect(write).toHaveBeenCalledTimes(1);
  expect(store.listModelRunsForSession("session")).toMatchObject([
    { model: "test-model", providerName: "loom", latencyMs: 1500, isError: status === "failed" ? 1 : 0 },
  ]);
});

it("registers a decision wake before ack and recovers exactly once after a bot restart", async () => {
  store.finishLoomDelivery(record.runId, "delivered");
  const wake = { runId: "decision-run", loomThreadId: record.loomThreadId, prompt: "Decision D-1: I chose A", createdAt: Date.now() };
  const read = vi.fn(async () => [wake]);
  const acknowledge = vi.fn(async () => { throw new Error("connection lost after persistence"); });
  await registerDecisionDeliveries({ store, read, acknowledge });
  expect(store.listPendingLoomDeliveries()).toEqual([expect.objectContaining({ runId: wake.runId, messageId: "",
    context: expect.objectContaining({ prompt: wake.prompt, requestMessageId: null }) })]);
  store.close(); store = new TangoStorage(path.join(dir, "db"));
  await registerDecisionDeliveries({ store, read, acknowledge: async () => {} });
  const h = harness();
  h.detail.runs[0]!.id = wake.runId;
  h.detail.messages[1]!.run_id = wake.runId;
  await recoverLoomReplies(h);
  // A lost ack/repeated outbox read must not reset the terminal delivery claim.
  await registerDecisionDeliveries({ store, read, acknowledge: async () => {} });
  await recoverLoomReplies(h);
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.send).toHaveBeenCalledWith("answer");
});

it("retains an unroutable wake and retries when its original delivery route arrives", async () => {
  const wake = { runId: "new-run", loomThreadId: "new-thread", prompt: "answer", createdAt: Date.now() };
  const acknowledge = vi.fn(async () => {});
  const options = { store, read: async () => [wake], acknowledge };
  await registerDecisionDeliveries(options);
  expect(acknowledge).not.toHaveBeenCalled();
  store.insertLoomDelivery({ ...record, runId: "new-original", loomThreadId: wake.loomThreadId,
    context: { ...record.context, transport: "conversation", requestMessageId: 42 } });
  await registerDecisionDeliveries(options);
  expect(acknowledge).toHaveBeenCalledWith(wake.runId);
  expect(store.latestLoomDelivery(wake.loomThreadId)).toMatchObject({ runId: wake.runId,
    context: { transport: "conversation", requestMessageId: null } });
});


it.each(["queued", "running"])("retains a known %s run past 24h and delivers its eventual answer once", async status => {
  const h = harness(status);
  await recoverLoomReplies({ ...h, now: Date.parse(record.createdAt) + 86_400_001 });
  expect(store.listPendingLoomDeliveries()).toHaveLength(1);
  expect(h.send).not.toHaveBeenCalled();
  h.detail.runs[0]!.status = "completed";
  await recoverLoomReplies(h); await recoverLoomReplies(h);
  expect(h.send).toHaveBeenCalledTimes(1);
});
it("suppresses continue and exact retries only in the pending conversation", () => {
  const pending = { ...record, context: { ...record.context, retryText: "What happened?" } };
  for (const text of ["continue", "Please try again!", "retry", "What happened?"]) {
    expect(pendingLoomRetry([pending], "thread", text)).toBe(pending);
    expect(pendingLoomRetry([pending], "other-thread", text)).toBeUndefined();
  }
  expect(pendingLoomRetry([pending], "thread", "continue with a different topic")).toBeUndefined();
  expect(pendingLoomRetry([], "thread", "continue")).toBeUndefined();
  expect(pendingLoomRetry([pending], { conversationKey: "chat" }, "continue")).toBe(pending);
  expect(pendingLoomRetry([pending], { conversationKey: "other" }, "continue")).toBeUndefined();
});

it.each([[false, false], [true, false], [false, true]])("recovers a late outcome across real Loom HTTP (slow open=%s, stop=%s)", async (slowOpen, stop) => {
  const loom = new LoomStore(":memory:");
  const runtime = new FakeRuntime(loom);
  let releaseOpen = () => {};
  const opening = new Promise<void>(resolve => { releaseOpen = resolve; });
  const admissionTimeout = new AbortController();
  const timeoutSignal = slowOpen
    ? vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => admissionTimeout.signal)
    : null;
  if (slowOpen) {
    const open = runtime.open.bind(runtime);
    vi.spyOn(runtime, "open").mockImplementation(async (...args) => {
      // The receipt is committed at this point; expire only the first real HTTP
      // request, while keeping the host blocked until recovery owns the run.
      admissionTimeout.abort(new DOMException("Test observer deadline", "TimeoutError"));
      await opening;
      return open(...args);
    });
  }
  const health = path.join(dir, "health.json");
  writeFileSync(health, JSON.stringify({ at: Date.now() / 1000, ok: false, alerts: ["destination_low_space"] }));
  const host = new LoomHost(loom, { claude: runtime }, { recoveryHealthFile: health });
  const server = createLoomServer(host, { token: "test" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const tokenFile = path.join(dir, "token"); writeFileSync(tokenFile, "test");
  const adapter = new LoomRuntimeAdapter({ conversationKey: "http-chat", store, tokenFile,
    port: (server.address() as import("node:net").AddressInfo).port, pollMs: 5 });
  store.finishLoomDelivery(record.runId, "abandoned");
  // Advance observer time only after HTTP admission and durable registration.
  // A 150ms wall-clock deadline raced cold imports, SQLite and runner load.
  let observerNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => observerNow);
  try {
    await adapter.initialize({ agentId: "test", systemPrompt: "test", runtimePreferences: {}, mcpServers: [] });
    await expect(adapter.send("question", { timeout: 30_000, onLoomSubmitted: () => { observerNow += 30_001; }, discordDelivery: {
      channelId: "channel", threadId: "thread", messageId: "http-message", context: {
        sessionId: "session", prompt: "question", retryText: "question", occurredAt: new Date().toISOString(),
      },
    } })).rejects.toMatchObject({ name: "LoomPendingError" });
    const pending = store.listPendingLoomDeliveries()[0]!;
    releaseOpen();
    await host.kick(pending.loomThreadId);
    expect(loom.run(pending.runId)?.status).toBe("running");
    expect(runtime.last.interrupted).toBe(0);
    expect(pendingLoomRetry(store.listPendingLoomDeliveries(), "thread", "continue")).toEqual(pending);
    expect(loom.runs(pending.loomThreadId)).toHaveLength(1);
    // Release the live presenter, then simulate the independent recovery loop after a restart.
    liveLoomDeliveries.delete(pending.runId);
    const deliver = vi.fn();
    const recovery = { store, readThread: (id: string) => adapter.readThread(id), deliver };
    await recoverLoomReplies(recovery); expect(deliver).not.toHaveBeenCalled();
    if (stop) {
      expect(adapter.abortActiveRun()).toBe(true);
      await vi.waitFor(() => expect(runtime.last.interrupted).toBe(1));
    } else {
      runtime.last.complete("late answer");
    }
    await host.kick(pending.loomThreadId);
    await recoverLoomReplies(recovery); await recoverLoomReplies(recovery);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: pending.runId }), expect.objectContaining({ text: stop ? LOOM_FAILURE_NOTICE : "late answer" }));
  } finally {
    releaseOpen();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await host.closeAll(); loom.close(); clock.mockRestore(); timeoutSignal?.mockRestore();
  }
});

it.each([
  ["non-allowlisted user", "outsider", true, "thread", false],
  ["missing mention", "allowed", false, "thread", false],
  ["wrong channel", "allowed", true, "other", false],
  ["allowed thread and mention", "allowed", true, "thread", true],
] as const)("pending retry notice applies agent policy: %s", async (_label, userId, mentioned, threadChannelId, allowed) => {
  const send = vi.fn(async () => undefined);
  await sendPendingLoomRetryNotice({
    agent: { id: "test", access: { mode: "both", allowlistUserIds: ["allowed"], allowlistChannelIds: ["thread"] } } as AgentConfig,
    defaults: buildDefaultAccessPolicy({ mode: "off", allowlistChannelIds: [], allowlistUserIds: [] }),
    access: { channelId: "parent", threadChannelId, userId, mentioned }, send,
  });
  if (allowed) expect(send).toHaveBeenCalledExactlyOnceWith(LOOM_PENDING_NOTICE);
  else expect(send).not.toHaveBeenCalled();
});

it("does not reveal a pending run when its agent config is unavailable", async () => {
  const send = vi.fn(async () => undefined);
  await sendPendingLoomRetryNotice({ agent: undefined,
    defaults: buildDefaultAccessPolicy({ mode: "off", allowlistChannelIds: [], allowlistUserIds: [] }),
    access: { channelId: "thread", userId: "allowed", mentioned: true }, send });
  expect(send).not.toHaveBeenCalled();
});
