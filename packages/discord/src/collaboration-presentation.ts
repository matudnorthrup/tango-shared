import {
  ChannelType,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type {
  AgentCollaborationDeliveryInsertInput,
  AgentCollaborationDeliveryRecord,
  AgentCollaborationPresentationEvent,
  AgentCollaborationPresentationObserver,
  AgentCollaborationSessionRecord,
  AgentConfig,
  TangoStorage,
} from "@tango/core";

interface SendableChannel {
  id: string;
  isSendable(): boolean;
  isThread?(): boolean;
  send?(content: string): Promise<unknown>;
}

interface ThreadStarterChannel extends SendableChannel {
  threads: {
    create(input: {
      name: string;
      autoArchiveDuration: ThreadAutoArchiveDuration;
      type: ChannelType.PublicThread;
      reason: string;
    }): Promise<SendableChannel>;
  };
}

interface PresentedDeliveryResult {
  failed: boolean;
  lastMessageId?: string;
}

interface CollaborationSurface {
  channelId: string;
  threadId: string | null;
}

interface PresentationDestination {
  channel: SendableChannel;
  channelId: string;
  threadId: string | null;
}

type CollaborationDeliveryStorage = Pick<
  TangoStorage,
  "insertAgentCollaborationDelivery" | "listAgentCollaborationDeliveries"
>;

export interface AgentCollaborationDiscordPresenterOptions {
  storage: CollaborationDeliveryStorage;
  fetchChannel(channelId: string): Promise<unknown | null>;
  sendReply(
    channel: SendableChannel,
    text: string,
    speaker: AgentConfig | null,
  ): Promise<PresentedDeliveryResult>;
  resolveSpeaker(agentId: string): AgentConfig | null;
  logger?: Pick<Console, "warn">;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveSurface(session: AgentCollaborationSessionRecord): CollaborationSurface | null {
  const surface = asRecord(session.userSurface);
  if (readString(surface, "kind") !== "discord") return null;
  const channelId = readString(surface, "channel_id") ?? readString(surface, "channelId");
  if (!channelId) return null;
  return {
    channelId,
    threadId: readString(surface, "thread_id") ?? readString(surface, "threadId"),
  };
}

function isSendableChannel(value: unknown): value is SendableChannel {
  return Boolean(
    value
      && typeof value === "object"
      && "id" in value
      && typeof (value as SendableChannel).id === "string"
      && typeof (value as SendableChannel).isSendable === "function"
      && (value as SendableChannel).isSendable()
      && typeof (value as SendableChannel).send === "function",
  );
}

function isThreadStarterChannel(value: unknown): value is ThreadStarterChannel {
  return isSendableChannel(value)
    && "threads" in value
    && typeof (value as ThreadStarterChannel).threads?.create === "function";
}

function isThreadChannel(value: SendableChannel): boolean {
  return typeof value.isThread === "function" && value.isThread();
}

function displayAgent(agentId: string, resolveSpeaker: (agentId: string) => AgentConfig | null): string {
  return resolveSpeaker(agentId)?.displayName?.trim()
    || agentId.replace(/[-_]+/gu, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function trimVisibleText(value: string | undefined, maxLength: number): string {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  const truncated = normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
    : normalized;
  return truncated.replace(/@/gu, "@\u200B");
}

function shouldPresent(event: AgentCollaborationPresentationEvent): boolean {
  switch (event.session.visibilityMode) {
    case "summary":
    case "thread":
      return true;
    case "digest":
    case "transcript":
      return event.kind !== "started";
    case "silent":
      return event.kind === "failed";
  }
}

function renderLifecycleMessage(
  event: AgentCollaborationPresentationEvent,
  resolveSpeaker: (agentId: string) => AgentConfig | null,
): string {
  const requester = displayAgent(event.session.requesterAgentId, resolveSpeaker);
  const target = displayAgent(event.session.targetAgentId, resolveSpeaker);
  const pair = `**${requester} -> ${target}**`;

  if (event.session.visibilityMode === "transcript" && event.kind !== "started") {
    const state = event.kind === "failed"
      ? "did not complete"
      : event.kind === "waiting_on_user"
        ? "needs clarification"
        : "completed";
    return `${pair} ${state}. Transcript reference: \`${event.session.id}\`.`;
  }

  switch (event.kind) {
    case "started":
      return `${pair} started a bounded collaboration request.`;
    case "completed": {
      const answer = trimVisibleText(event.answer, 1_200);
      return answer ? `${pair} completed.\n${answer}` : `${pair} completed.`;
    }
    case "waiting_on_user": {
      const answer = trimVisibleText(event.answer, 1_200);
      return answer ? `${pair} needs clarification.\n${answer}` : `${pair} needs clarification.`;
    }
    case "failed": {
      const error = trimVisibleText(event.error, 500);
      return error ? `${pair} could not complete.\n${error}` : `${pair} could not complete.`;
    }
  }
}

function selectExistingThread(deliveries: AgentCollaborationDeliveryRecord[]): string | null {
  for (const delivery of [...deliveries].reverse()) {
    if (delivery.status === "delivered" && delivery.destinationThreadId) {
      return delivery.destinationThreadId;
    }
  }
  return null;
}

export function createAgentCollaborationDiscordPresenter(
  options: AgentCollaborationDiscordPresenterOptions,
): AgentCollaborationPresentationObserver {
  const logger = options.logger ?? console;

  function record(input: AgentCollaborationDeliveryInsertInput): void {
    try {
      options.storage.insertAgentCollaborationDelivery(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[agent-collaboration] could not record presentation delivery: ${message}`);
    }
  }

  async function fetchSendable(channelId: string): Promise<SendableChannel | null> {
    try {
      const channel = await options.fetchChannel(channelId);
      return isSendableChannel(channel) ? channel : null;
    } catch {
      return null;
    }
  }

  async function resolveDestination(
    session: AgentCollaborationSessionRecord,
    surface: CollaborationSurface,
  ): Promise<PresentationDestination | null> {
    if (session.visibilityMode !== "thread") {
      const preferred = surface.threadId ? await fetchSendable(surface.threadId) : null;
      const channel = preferred ?? await fetchSendable(surface.channelId);
      return channel
        ? { channel, channelId: surface.channelId, threadId: preferred ? preferred.id : null }
        : null;
    }

    const existingThreadId = selectExistingThread(
      options.storage.listAgentCollaborationDeliveries(session.id),
    );
    const threadId = existingThreadId ?? surface.threadId;
    if (threadId) {
      const thread = await fetchSendable(threadId);
      if (thread) return { channel: thread, channelId: surface.channelId, threadId: thread.id };
    }

    const sourceChannel = await fetchSendable(surface.channelId);
    if (!sourceChannel) return null;
    if (isThreadChannel(sourceChannel)) {
      return { channel: sourceChannel, channelId: surface.channelId, threadId: sourceChannel.id };
    }
    if (!isThreadStarterChannel(sourceChannel)) {
      return { channel: sourceChannel, channelId: surface.channelId, threadId: null };
    }

    try {
      const thread = await sourceChannel.threads.create({
        name: "Tango collaboration",
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        type: ChannelType.PublicThread,
        reason: "Tango agent collaboration",
      });
      if (!isSendableChannel(thread)) {
        throw new Error("created thread is not sendable");
      }
      record({
        collaborationId: session.id,
        eventKind: "thread_opened",
        destinationChannelId: surface.channelId,
        destinationThreadId: thread.id,
        status: "delivered",
      });
      return { channel: thread, channelId: surface.channelId, threadId: thread.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({
        collaborationId: session.id,
        eventKind: "thread_opened",
        destinationChannelId: surface.channelId,
        status: "failed",
        error: message,
      });
      return { channel: sourceChannel, channelId: surface.channelId, threadId: null };
    }
  }

  return async (event) => {
    if (!shouldPresent(event)) return;

    const surface = resolveSurface(event.session);
    if (!surface) {
      record({
        collaborationId: event.session.id,
        eventKind: event.kind,
        status: "failed",
        error: "origin_discord_surface_unavailable",
      });
      return;
    }

    const destination = await resolveDestination(event.session, surface);
    if (!destination) {
      record({
        collaborationId: event.session.id,
        eventKind: event.kind,
        destinationChannelId: surface.channelId,
        destinationThreadId: surface.threadId,
        status: "failed",
        error: "origin_discord_destination_unavailable",
      });
      return;
    }

    try {
      const result = await options.sendReply(
        destination.channel,
        renderLifecycleMessage(event, options.resolveSpeaker),
        options.resolveSpeaker(
          event.kind === "started" ? event.session.requesterAgentId : event.session.targetAgentId,
        ),
      );
      record({
        collaborationId: event.session.id,
        eventKind: event.kind,
        destinationChannelId: destination.channelId,
        destinationThreadId: destination.threadId,
        discordMessageId: result.lastMessageId ?? null,
        status: result.failed ? "failed" : "delivered",
        ...(result.failed ? { error: "discord_reply_delivery_incomplete" } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({
        collaborationId: event.session.id,
        eventKind: event.kind,
        destinationChannelId: destination.channelId,
        destinationThreadId: destination.threadId,
        status: "failed",
        error: message,
      });
    }
  };
}
