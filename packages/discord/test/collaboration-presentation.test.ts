import { describe, expect, it, vi } from "vitest";
import type {
  AgentCollaborationDeliveryInsertInput,
  AgentCollaborationDeliveryRecord,
  AgentCollaborationPresentationEvent,
  AgentCollaborationSessionRecord,
  AgentConfig,
} from "@tango/core";
import { createAgentCollaborationDiscordPresenter } from "../src/collaboration-presentation.js";

function createSession(
  overrides: Partial<AgentCollaborationSessionRecord> = {},
): AgentCollaborationSessionRecord {
  return {
    id: "collab-1",
    parentCollaborationId: null,
    requesterAgentId: "foxtrot",
    targetAgentId: "kilo",
    initiatorKind: "agent",
    initiatorRef: null,
    purpose: "spending-support",
    objective: "Sensitive objective that must not be shown.",
    normalizedObjective: "sensitive objective that must not be shown.",
    contextSummary: "Sensitive context that must not be shown.",
    deliverableContract: {},
    constraints: [],
    status: "running",
    visibilityMode: "summary",
    userSurface: { kind: "discord", channel_id: "channel-1" },
    budget: {},
    policyDecision: null,
    resultSummary: null,
    error: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function createEvent(
  kind: AgentCollaborationPresentationEvent["kind"],
  session: AgentCollaborationSessionRecord,
  answer?: string,
): AgentCollaborationPresentationEvent {
  return { kind, session, ...(answer ? { answer } : {}) };
}

function createDeliveryStore() {
  const deliveries: AgentCollaborationDeliveryRecord[] = [];
  return {
    deliveries,
    storage: {
      insertAgentCollaborationDelivery(input: AgentCollaborationDeliveryInsertInput): string {
        const id = `delivery-${deliveries.length + 1}`;
        deliveries.push({
          id,
          collaborationId: input.collaborationId,
          eventKind: input.eventKind,
          destinationChannelId: input.destinationChannelId ?? null,
          destinationThreadId: input.destinationThreadId ?? null,
          discordMessageId: input.discordMessageId ?? null,
          status: input.status,
          error: input.error ?? null,
          createdAt: "2026-07-31T12:00:00.000Z",
        });
        return id;
      },
      listAgentCollaborationDeliveries(collaborationId: string): AgentCollaborationDeliveryRecord[] {
        return deliveries.filter((delivery) => delivery.collaborationId === collaborationId);
      },
    },
  };
}

function createSpeaker(id: string): AgentConfig {
  return {
    id,
    type: "test",
    displayName: id === "foxtrot" ? "Foxtrot" : "Kilo",
    provider: { default: "stub" },
  };
}

function createSendableChannel(id: string) {
  return {
    id,
    isSendable: () => true,
    send: vi.fn(async () => ({ id: `${id}-message` })),
  };
}

describe("agent collaboration Discord presentation", () => {
  it("posts summary lifecycle events to the trusted origin and records delivery refs", async () => {
    const { storage, deliveries } = createDeliveryStore();
    const channel = createSendableChannel("channel-1");
    const sendReply = vi.fn(async () => ({ failed: false, lastMessageId: "message-1" }));
    const presenter = createAgentCollaborationDiscordPresenter({
      storage,
      fetchChannel: async () => channel,
      sendReply,
      resolveSpeaker: createSpeaker,
    });
    const session = createSession();

    await presenter(createEvent("started", session));
    await presenter(createEvent("completed", { ...session, status: "completed" }, "The request is complete."));

    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[1]).toBe("**Foxtrot -> Kilo** started a bounded collaboration request.");
    expect(sendReply.mock.calls[1]?.[1]).toContain("The request is complete.");
    expect(sendReply.mock.calls[1]?.[1]).not.toContain("Sensitive objective");
    expect(sendReply.mock.calls[1]?.[1]).not.toContain("Sensitive context");
    expect(deliveries).toEqual([
      expect.objectContaining({ eventKind: "started", status: "delivered", discordMessageId: "message-1" }),
      expect.objectContaining({ eventKind: "completed", status: "delivered", discordMessageId: "message-1" }),
    ]);
  });

  it("creates one generic collaboration thread and reuses it for later lifecycle events", async () => {
    const { storage, deliveries } = createDeliveryStore();
    const thread = createSendableChannel("thread-1");
    const parent = {
      ...createSendableChannel("channel-1"),
      threads: {
        create: vi.fn(async () => thread),
      },
    };
    const channels = new Map<string, unknown>([
      ["channel-1", parent],
      ["thread-1", thread],
    ]);
    const sendReply = vi.fn(async () => ({ failed: false, lastMessageId: "message-1" }));
    const presenter = createAgentCollaborationDiscordPresenter({
      storage,
      fetchChannel: async (id) => channels.get(id) ?? null,
      sendReply,
      resolveSpeaker: createSpeaker,
    });
    const session = createSession({ visibilityMode: "thread" });

    await presenter(createEvent("started", session));
    await presenter(createEvent("completed", { ...session, status: "completed" }, "Completed."));

    expect(parent.threads.create).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls.map(([target]) => target.id)).toEqual(["thread-1", "thread-1"]);
    expect(deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: "thread_opened", destinationThreadId: "thread-1", status: "delivered" }),
      expect.objectContaining({ eventKind: "started", destinationThreadId: "thread-1", status: "delivered" }),
      expect.objectContaining({ eventKind: "completed", destinationThreadId: "thread-1", status: "delivered" }),
    ]));
  });

  it("keeps transcript and silent modes truthful without exposing raw output", async () => {
    const { storage } = createDeliveryStore();
    const channel = createSendableChannel("channel-1");
    const sendReply = vi.fn(async () => ({ failed: false, lastMessageId: "message-1" }));
    const presenter = createAgentCollaborationDiscordPresenter({
      storage,
      fetchChannel: async () => channel,
      sendReply,
      resolveSpeaker: createSpeaker,
    });
    const transcript = createSession({ visibilityMode: "transcript", status: "completed" });
    const silent = createSession({ id: "collab-2", visibilityMode: "silent", status: "failed" });

    await presenter(createEvent("started", transcript));
    await presenter(createEvent("completed", transcript, "Raw result must stay in storage."));
    await presenter(createEvent("completed", silent, "Do not show."));
    await presenter({ kind: "failed", session: silent, error: "Timed out." });

    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[1]).toContain("Transcript reference: `collab-1`");
    expect(sendReply.mock.calls[0]?.[1]).not.toContain("Raw result");
    expect(sendReply.mock.calls[1]?.[1]).toContain("Timed out.");
  });

  it("records presentation delivery failures without throwing or changing the collaboration", async () => {
    const { storage, deliveries } = createDeliveryStore();
    const channel = createSendableChannel("channel-1");
    const presenter = createAgentCollaborationDiscordPresenter({
      storage,
      fetchChannel: async () => channel,
      sendReply: async () => {
        throw new Error("Discord unavailable");
      },
      resolveSpeaker: createSpeaker,
    });

    await expect(presenter(createEvent("completed", createSession({ status: "completed" }), "Done."))).resolves.toBeUndefined();
    expect(deliveries).toEqual([
      expect.objectContaining({ eventKind: "completed", status: "failed", error: "Discord unavailable" }),
    ]);
  });
});
