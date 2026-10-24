import type { VoiceTurnReceiptRecord } from "@tango/core";
import { describe, expect, it, vi } from "vitest";
import { createReplyPresenter, DeliveryError } from "../src/reply-presentation.js";
import {
  buildVoiceTurnResultFromReceipt,
  createVoiceReplyProgress,
  deliverVoiceReplyWithRetry,
  registerVoiceThread,
  resolveVoiceDiscordDelivery,
  sendVoiceReply,
} from "../src/voice-discord-delivery.js";

describe("voice Discord delivery", () => {
  it.each([1, 3])("returns all %i bot message IDs in send order", async (count) => {
    const send = vi.fn(async () => ({ id: `message-${send.mock.calls.length}` }));
    const channel = { id: "channel", isSendable: () => true, send };
    const ids = await sendVoiceReply(createReplyPresenter({ systemDisplayName: "Tango" }), channel,
      "a".repeat(count === 1 ? 10 : 4000), {});
    expect(ids).toEqual(Array.from({ length: count }, (_, i) => `message-${i + 1}`));
    expect(send.mock.calls).toHaveLength(count);
  });

  it("returns webhook chunk IDs when the presenter falls back to the bot", async () => {
    const webhook = {
      id: "webhook", name: "Tango Replies", token: "test-token",
      send: vi.fn().mockResolvedValueOnce({ id: "webhook-message" }).mockRejectedValue(new Error("failed")),
    };
    const channel = {
      id: "channel", isSendable: () => true,
      send: vi.fn().mockResolvedValue({ id: "bot-message" }),
      fetchWebhooks: vi.fn().mockResolvedValue([webhook]),
      createWebhook: vi.fn().mockResolvedValue(webhook),
    };
    const ids = await sendVoiceReply(createReplyPresenter({ systemDisplayName: "Tango", logger: { warn: vi.fn() } }),
      channel, "a".repeat(2000), {});
    expect(ids).toEqual(["webhook-message", "bot-message"]);
  });

  it("does not report a partial reply as successful delivery", async () => {
    const channel = {
      id: "channel", isSendable: () => true,
      send: vi.fn().mockResolvedValueOnce({ id: "first" }).mockRejectedValue(new Error("offline")),
    };
    const reply = sendVoiceReply(createReplyPresenter({ systemDisplayName: "Tango", logger: { warn: vi.fn(), error: vi.fn() } }),
      channel, "a".repeat(2000), {});
    await expect(reply).rejects.toBeInstanceOf(DeliveryError);
    await expect(resolveVoiceDiscordDelivery("channel", Promise.resolve("transcript"), reply))
      .resolves.toEqual({ postedChannelId: "channel", transcriptMessageId: "transcript", responseMessageIds: [] });
  });

  it("resumes after the delivered chunks on retry instead of re-posting them", async () => {
    const channel = {
      id: "channel", isSendable: () => true,
      send: vi.fn().mockResolvedValueOnce({ id: "first-attempt" })
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ id: "retry-second" }),
    };
    const presenter = createReplyPresenter({ systemDisplayName: "Tango", logger: { warn: vi.fn(), error: vi.fn() } });
    const progress = createVoiceReplyProgress();
    await expect(sendVoiceReply(presenter, channel, "a".repeat(2000), {}, progress)).rejects.toBeInstanceOf(DeliveryError);
    expect(progress).toEqual({ messageIds: ["first-attempt"], deliveredChunks: 1 });
    await expect(sendVoiceReply(presenter, channel, "a".repeat(2000), {}, progress))
      .resolves.toEqual(["first-attempt", "retry-second"]);
    // Two chunks, three sends: the failed one and only the missing chunk on retry.
    expect(channel.send).toHaveBeenCalledTimes(3);
  });

  it("marks a replayed failed turn as failed", () => {
    const receipt = {
      status: "completed", responseText: "Sorry, I'm having trouble. Try again.", providerName: "test",
      metadata: { postedChannelId: "thread", responseMessageIds: ["r"], failed: true, failureReason: "timeout" },
    } as unknown as VoiceTurnReceiptRecord;
    expect(buildVoiceTurnResultFromReceipt("turn", receipt)).toMatchObject({ failed: true, failureReason: "timeout" });
    const ok = { ...receipt, metadata: { postedChannelId: "thread" } } as unknown as VoiceTurnReceiptRecord;
    expect(buildVoiceTurnResultFromReceipt("turn", ok)).not.toHaveProperty("failed");
  });

  it("deliverVoiceReplyWithRetry shares progress across attempts and reports only posted ids", async () => {
    const sent: string[] = [];
    const channel = {
      id: "channel", isSendable: () => true,
      send: vi.fn(async (payload: unknown) => {
        const n = channel.send.mock.calls.length;
        if (n === 3) throw new Error("offline");
        const id = `m-${n}`;
        sent.push(id);
        return { id, payload };
      }),
    };
    const presenter = createReplyPresenter({ systemDisplayName: "Tango", logger: { warn: vi.fn(), error: vi.fn() } });
    const wait = vi.fn(async () => {});
    const onRetry = vi.fn();
    const ids = await deliverVoiceReplyWithRetry({
      send: (progress) => sendVoiceReply(presenter, channel, "a".repeat(5000), {}, progress),
      wait,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(2_000);
    expect(ids).toEqual(sent);
    expect(ids).toEqual(["m-1", "m-2", "m-4"]);
  });

  it("deliverVoiceReplyWithRetry gives up after one retry", async () => {
    const send = vi.fn(async () => { throw new Error("down"); });
    await expect(deliverVoiceReplyWithRetry({ send, wait: async () => {} })).rejects.toThrow("down");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("waits for the transcript and returns null/empty IDs on failed delivery", async () => {
    await expect(resolveVoiceDiscordDelivery("channel", Promise.reject(new Error("offline")), Promise.reject(new Error("retry exhausted"))))
      .resolves.toEqual({ postedChannelId: "channel", transcriptMessageId: null, responseMessageIds: [] });
    let finish!: (id: string) => void;
    const transcript = new Promise<string>((resolve) => { finish = resolve; });
    const delivery = resolveVoiceDiscordDelivery("channel", transcript, Promise.resolve(["reply"]));
    finish("transcript");
    await expect(delivery).resolves.toEqual({ postedChannelId: "channel", transcriptMessageId: "transcript", responseMessageIds: ["reply"] });
  });

  it("restores Discord IDs on deduplicated turns and tolerates old receipts", () => {
    const receipt = {
      status: "completed", responseText: "hello", providerName: "test",
      metadata: { postedChannelId: "thread", transcriptMessageId: "transcript", responseMessageIds: ["first", "second"] },
    } as unknown as VoiceTurnReceiptRecord;
    expect(buildVoiceTurnResultFromReceipt("turn", receipt)).toMatchObject({ deduplicated: true, ...receipt.metadata });
    expect(buildVoiceTurnResultFromReceipt("turn", { ...receipt, metadata: null })).toMatchObject({
      postedChannelId: null, transcriptMessageId: null, responseMessageIds: [],
    });
  });
});

describe("voice thread registration", () => {
  function setup(existing?: { sessionId: string; agentId: string | null }) {
    const rows = new Map(existing ? [["thread", existing]] : []);
    return {
      getThreadSession: (id: string) => rows.get(id) ?? null,
      setThreadSession: vi.fn((id: string, sessionId: string, agentId?: string) => {
        rows.set(id, { sessionId, agentId: agentId ?? null });
      }),
    };
  }

  it("registers new threads with the turn session", () => {
    const storage = setup();
    registerVoiceThread(storage, { id: "thread", isThread: () => true }, "voice-session", "agent");
    expect(storage.getThreadSession("thread")).toEqual({ sessionId: "voice-session", agentId: "agent" });
    registerVoiceThread(storage, { id: "thread", isThread: () => true }, "other-session", "other-agent");
    expect(storage.setThreadSession).toHaveBeenCalledTimes(1);
  });

  it.each(["existing-agent", null])("preserves existing rows (agent=%s)", (agentId) => {
    const existing = { sessionId: "existing-session", agentId };
    const storage = setup(existing);
    registerVoiceThread(storage, { id: "thread", isThread: () => true }, "voice-session", "agent");
    expect(storage.getThreadSession("thread")).toEqual(existing);
    expect(storage.setThreadSession).not.toHaveBeenCalled();
  });

  it("does not register ordinary channels", () => {
    const storage = setup();
    registerVoiceThread(storage, { id: "channel", isThread: () => false }, "voice-session", "agent");
    expect(storage.setThreadSession).not.toHaveBeenCalled();
  });
});
