import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TangoStorage } from "@tango/core";
import { recordConversationPost, settleConversationAttachments, isOwnConversationPost, resolveConversationChannel } from "../src/conversation-posts.js";
import { planConversationBackfill, applyConversationBackfill, type DiscordHistoryPost, type ExistingHistoryPost } from "../src/conversation-backfill.js";
import { createReplyPresenter, splitForDiscord } from "../src/reply-presentation.js";
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-posts-")); dirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "db.sqlite"));
  storage.upsertSession({ id: "session", agent: "test", type: "persistent", channels: [] });
  return { storage, dir };
}
const base = { sessionId: "session", agentId: "test", conversationKey: "thread:123", direction: "outbound" as const,
  source: "tango" as const, authorKind: "agent" as const, discordChannelId: "123" };
it("copies inbound CDN and outbound local attachments to durable message directories", async () => {
  const { storage, dir } = await setup();
  const source = path.join(dir, "source.txt"); await fs.writeFile(source, "outbound bytes");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("inbound bytes")));
  const first = await recordConversationPost(storage, dir, { ...base, content: "file", discordMessageId: "100",
    attachments: [{ name: "../../safe.txt", filePath: source }] });
  const second = await recordConversationPost(storage, dir, { ...base, direction: "inbound", authorKind: "owner",
    content: "image", discordMessageId: "101", attachments: [{ name: "image.png", url: "https://cdn.discordapp.com/attachments/test/image.png" }] });
  await settleConversationAttachments(storage);
  await fs.unlink(source);
  for (const [id, bytes] of [[first, "outbound bytes"], [second, "inbound bytes"]] as const) {
    const row = storage.getDatabase().prepare("SELECT attachments FROM messages WHERE id=?").get(id) as { attachments: string };
    const attachment = JSON.parse(row.attachments)[0];
    expect(attachment.localPath).toMatch(new RegExp(`^attachments/thread:123/${id}/`));
    expect(await fs.readFile(path.join(dir, attachment.localPath), "utf8")).toBe(bytes);
  }
  storage.close();
});
it("retains text and explicit attachment failures, rejecting non-CDN requests", async () => {
  const { storage, dir } = await setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const id = await recordConversationPost(storage, dir, { ...base, content: "keep me", attachments: [{ name: "x", url: "http://127.0.0.1/private" }] });
  await settleConversationAttachments(storage);
  expect(fetch).not.toHaveBeenCalled();
  expect(storage.getMessage(id)?.content).toBe("keep me");
  const row = storage.getDatabase().prepare("SELECT attachments FROM messages WHERE id=?").get(id) as { attachments: string };
  expect(JSON.parse(row.attachments)[0].error).toBe("Unsupported attachment URL"); storage.close();
});
it("backfills a full legacy reply, missing notices and reply links idempotently; dry-run changes nothing", async () => {
  const { storage, dir } = await setup();
  const text = "a long answer ".repeat(400);
  const chunks = splitForDiscord(text.trim());
  const history: DiscordHistoryPost[] = chunks.map((content, index) => ({ id: String(100 + index), content,
    timestamp: "2026-10-01T12:00:00Z", author: { id: "bot", username: "Test", bot: true }, attachments: [] }));
  history.push({ id: "200", content: "rotation notice", timestamp: "2026-10-01T12:01:00Z", author: { id: "bot", username: "Test", bot: true },
    attachments: [], message_reference: { message_id: "100" } });
  const oldId = storage.insertMessage({ ...base, content: text, discordMessageId: history.at(-2)!.id });
  const context = { conversationKey: "thread:123", channelId: "123", sessionId: "session", agentId: "test", ownerIds: [] };
  const rows = () => storage.getDatabase().prepare("SELECT * FROM messages").all() as unknown as ExistingHistoryPost[];
  const plan = planConversationBackfill(history, rows(), context);
  expect(plan.counts).toMatchObject({ insert: 1, enrich: 1, ambiguousChunks: 0 });
  const before = JSON.stringify(rows());
  await applyConversationBackfill(storage, dir, plan);
  expect(JSON.stringify(rows())).toBe(before);
  await applyConversationBackfill(storage, dir, plan, false);
  expect(storage.findConversationPostByDiscordId("100")).toBe(oldId);
  expect(rows()).toHaveLength(2);
  const second = planConversationBackfill(history, rows(), context);
  expect(second.counts).toMatchObject({ insert: 0, enrich: 0, unchanged: 2 });
  await applyConversationBackfill(storage, dir, second, false);
  expect(rows()).toHaveLength(2);
  expect(storage.getDatabase().prepare("SELECT reply_to_message_id FROM messages WHERE discord_message_id='200'").get()).toEqual({ reply_to_message_id: oldId });
  storage.close();
});
it("returns every id across webhook failure and bot fallback, including partial delivery", async () => {
  let calls = 0;
  const registered = new Set<string>();
  const webhook = { name: "Tango Replies", token: "test", id: "webhook", send: vi.fn(async () => {
    expect(registered.has("webhook")).toBe(true);
    if (calls++) throw new Error("webhook unavailable"); return { id: "first" };
  }) };
  const presenter = createReplyPresenter({ onWebhook: id => { registered.add(id); }, logger: { warn() {}, error() {} } });
  let botCalls = 0;
  const result = await presenter.sendChunked({ id: "123", isSendable: () => true,
    fetchWebhooks: async () => [webhook], createWebhook: async () => webhook,
    send: async () => { if (botCalls++) throw new Error("bot unavailable"); return { id: "second" }; },
  }, "word ".repeat(1000));
  expect(result.messageIds).toEqual(["first", "second"]);
  expect(result.lastMessageId).toBe("second"); expect(result.failed).toBe(true);
});

it("gateway fallback waits for a multi-chunk writer, including failed sends, without losing tool posts", async () => {
  const { ConversationDeliveryTracker } = await import("../src/conversation-posts.js");
  const { storage, dir } = await setup();
  const tracker = new ConversationDeliveryTracker();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = tracker.run("123", async () => {
    await gate;
    await recordConversationPost(storage, dir, { ...base, content: "full reply", discordMessageIds: ["100", "101"] });
  });
  const capture = async (id: string) => {
    await tracker.settled("123");
    if (!storage.findConversationPostByDiscordId(id)) await recordConversationPost(storage, dir, { ...base, content: "tool post", discordMessageId: id });
  };
  const arrivals = Promise.all([capture("100"), capture("101"), capture("102")]);
  release(); await send; await arrivals;
  expect(storage.getDatabase().prepare("SELECT content FROM messages ORDER BY id").all()).toEqual([{ content: "full reply" }, { content: "tool post" }]);
  await expect(tracker.run("123", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  await tracker.settled("123"); storage.close();
});

it("returns the reserved id before a slow download finishes and drains failures", async () => {
  const { storage, dir } = await setup();
  let release!: (response: Response) => void;
  let started!: () => void;
  const downloading = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => { started(); return response; }));
  const id = recordConversationPost(storage, dir, { ...base, content: "ready for turn",
    attachments: [{ name: "slow.png", url: "https://cdn.discordapp.com/attachments/test/slow.png" }] });
  expect(typeof id).toBe("number");
  expect(storage.getMessage(id)?.content).toBe("ready for turn");
  await downloading;
  let drained = false;
  const drain = settleConversationAttachments(storage).then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  release(new Response("unavailable", { status: 503 }));
  await drain;
  const row = storage.getDatabase().prepare("SELECT attachments FROM messages WHERE id=?").get(id) as { attachments: string };
  expect(JSON.parse(row.attachments)[0].error).toBe("Attachment HTTP 503");
  storage.close();
});

it("ignores foreign bots and webhooks while accepting our bot and registered webhooks", () => {
  const webhooks = new Set(["agent-hook", "desk-hook"]);
  expect(isOwnConversationPost({ author: { id: "foreign-bot" } }, "our-bot", webhooks)).toBe(false);
  expect(isOwnConversationPost({ author: { id: "foreign-hook" }, webhookId: "foreign-hook" }, "our-bot", webhooks)).toBe(false);
  expect(isOwnConversationPost({ author: { id: "our-bot" } }, "our-bot", webhooks)).toBe(true);
  for (const webhookId of webhooks) expect(isOwnConversationPost({ author: { id: webhookId }, webhookId }, "our-bot", webhooks)).toBe(true);
});

it("fetches an uncached thread without a session before assigning its conversation key", async () => {
  const thread = { isThread: () => true };
  const fetch = vi.fn(async () => thread);
  const channels = { cache: new Map<string, typeof thread>(), fetch };
  expect(await resolveConversationChannel(channels, "123", () => false)).toEqual({ channel: thread, thread: true, conversationKey: "thread:123" });
  expect(fetch).toHaveBeenCalledWith("123");
  channels.cache.set("123", thread); fetch.mockClear();
  await resolveConversationChannel(channels, "123", () => false);
  expect(fetch).not.toHaveBeenCalled();
  channels.cache.clear(); fetch.mockRejectedValue(new Error("unavailable"));
  expect((await resolveConversationChannel(channels, "123", () => true)).conversationKey).toBe("thread:123");
  expect((await resolveConversationChannel(channels, "123", () => false)).conversationKey).toBe("channel:123");
});

it("backfill waits for attachment copies before counting failures", async () => {
  const { storage, dir } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
  const plan = planConversationBackfill([{ id: "100", content: "image", timestamp: "2026-10-01T12:00:00Z",
    author: { id: "bot", username: "Test", bot: true },
    attachments: [{ filename: "missing.png", size: 0, url: "https://cdn.discordapp.com/attachments/test/missing.png" }] }], [],
    { conversationKey: "thread:123", channelId: "123", sessionId: "session", agentId: "test", ownerIds: [] });
  expect((await applyConversationBackfill(storage, dir, plan, false)).attachmentFailures).toBe(1);
  storage.close();
});

it("backfill keeps stored inbound bot and webhook posts as the owner's, not the agent's", async () => {
  const { storage } = await setup();
  const history: DiscordHistoryPost[] = [
    { id: "300", content: "\u{1F5A5} On the screen, the owner picked A", timestamp: "2026-10-01T12:00:00Z",
      author: { id: "hook", username: "screen-input", bot: true }, webhook_id: "hook", attachments: [] },
    { id: "301", content: "Quick check: who are you?", timestamp: "2026-10-01T12:01:00Z",
      author: { id: "harness", username: "Harness", bot: true }, attachments: [] },
    { id: "302", content: "I am Test.", timestamp: "2026-10-01T12:02:00Z", author: { id: "bot", username: "Test", bot: true }, attachments: [] },
  ];
  storage.insertMessage({ ...base, direction: "inbound", content: "Quick check: who are you?", discordMessageId: "301" });
  const rows = storage.getDatabase().prepare("SELECT * FROM messages").all() as unknown as ExistingHistoryPost[];
  const plan = planConversationBackfill(history, rows, { conversationKey: "thread:123", channelId: "123", sessionId: "session", agentId: "test", ownerIds: [] });
  expect(plan.posts.map(post => [post.discordMessageId, post.direction, post.authorKind])).toEqual([
    ["300", "inbound", "owner"], ["301", "inbound", "owner"], ["302", "outbound", "agent"]]);
  storage.close();
});

it("backfill excludes Discord structural events and distinguishes the host from a guest author", () => {
  const context = { conversationKey: "thread:123", channelId: "123", sessionId: "session", agentId: "host", ownerIds: [] };
  const event = { id: "100", content: "thread name", timestamp: "2026-10-01T12:00:00Z", author: { id: "bot", username: "Fixture", bot: true }, attachments: [] };
  const plan = planConversationBackfill([{ ...event, type: 18 }, { ...event, id: "101", type: 1 }, { ...event, id: "102", type: 0 }],
    [{ id: 1, session_id: "session", agent_id: "guest", discord_message_id: "102", content: "thread name" }], context);
  expect(plan.posts).toHaveLength(1);
  expect(plan.posts[0]).toMatchObject({ agentId: "guest", conversationAgentId: "host", discordMessageIds: ["102"] });
});
