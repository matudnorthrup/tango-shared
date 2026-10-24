import type { AgentConfig } from "@tango/core";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_WEBHOOK_NAME = "Tango Replies";

interface ReplyWebhook {
  id: string;
  name?: string | null;
  token?: string | null;
  edit?(options: { name?: string; avatar?: string }): Promise<ReplyWebhook>;
  send(options: {
    content: string;
    username?: string;
    avatarURL?: string;
    threadId?: string;
  }): Promise<unknown>;
}

interface ReplyWebhookCollectionLike {
  values(): Iterable<ReplyWebhook>;
}

interface ReplyWebhookCapableChannel {
  id: string;
  fetchWebhooks(): Promise<ReplyWebhookCollectionLike | ReplyWebhook[]>;
  createWebhook(options: { name: string; avatar?: string }): Promise<ReplyWebhook>;
}

interface ReplyThreadLike {
  id: string;
  isThread(): boolean;
  parent?: unknown;
}

export interface ReplyChannelLike {
  id: string;
  guildId?: string;
  isSendable(): boolean;
  send?(content: string | { content: string; reply: { messageReference: string; failIfNotExists: boolean } }): Promise<unknown>;
  isThread?(): boolean;
  parent?: unknown;
  fetchWebhooks?(): Promise<ReplyWebhookCollectionLike | ReplyWebhook[]>;
  createWebhook?(options: { name: string }): Promise<ReplyWebhook>;
}

export interface PresentedReplyResult {
  sentChunks: number;
  delivery: "webhook" | "bot" | "mixed";
  intendedDisplayName: string;
  actualDisplayName: string;
  failed: boolean;
  messageIds?: string[];
  lastMessageId?: string;
}

export class DeliveryError extends Error {
  readonly channelId?: string;
  readonly result?: PresentedReplyResult;

  constructor(
    message: string,
    options?: {
      channelId?: string;
      result?: PresentedReplyResult;
    }
  ) {
    super(message);
    this.name = "DeliveryError";
    this.channelId = options?.channelId;
    this.result = options?.result;
  }
}

interface WebhookTarget {
  cacheKey: string;
  sourceChannel: ReplyWebhookCapableChannel;
  threadId?: string;
}

interface ReplyPresentationLogger {
  warn(message: string): void;
  error?(message: string): void;
}

export interface PresentedReplyOptions {
  speaker?: AgentConfig | null;
  botDisplayName?: string;
  avatarURL?: string;
  avatarPath?: string;
  replyToMessageId?: string;
}

export interface ReplyPresenter {
  sendChunked(
    channel: ReplyChannelLike | null | undefined,
    text: string,
    options?: PresentedReplyOptions
  ): Promise<PresentedReplyResult>;
}

function titleCaseAgentId(agentId: string): string {
  return agentId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveSpeakerAvatarURL(
  speaker: Pick<AgentConfig, "id" | "avatarURL" | "avatarPath"> | null | undefined,
  fallbackAvatarURL?: string
): string | undefined {
  if (speaker) {
    if (speaker.avatarURL) {
      return speaker.avatarURL;
    }
    if (speaker.avatarPath) {
      return undefined;
    }
  }
  return fallbackAvatarURL;
}

export function resolveSpeakerAvatarPath(
  speaker: Pick<AgentConfig, "id" | "avatarPath"> | null | undefined
): string | undefined {
  if (speaker?.avatarPath) {
    return speaker.avatarPath;
  }
  return undefined;
}

export function resolveSpeakerDisplayName(
  speaker: Pick<AgentConfig, "id" | "displayName"> | null | undefined,
  systemDisplayName = "Tango"
): string {
  if (!speaker) {
    return systemDisplayName;
  }

  const explicit = speaker.displayName?.trim();
  if (explicit) return explicit;
  return titleCaseAgentId(speaker.id);
}

export function splitForDiscord(text: string, maxLength = 1900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < 1200) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < 800) {
      splitIndex = maxLength;
    }

    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function isWebhookCapableChannel(channel: unknown): channel is ReplyWebhookCapableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "id" in channel &&
    typeof (channel as ReplyWebhookCapableChannel).fetchWebhooks === "function" &&
    typeof (channel as ReplyWebhookCapableChannel).createWebhook === "function"
  );
}

function isThreadLike(channel: unknown): channel is ReplyThreadLike {
  return (
    typeof channel === "object" &&
    channel !== null &&
    typeof (channel as ReplyThreadLike).isThread === "function" &&
    (channel as ReplyThreadLike).isThread()
  );
}

function listWebhooks(webhooks: ReplyWebhookCollectionLike | ReplyWebhook[]): ReplyWebhook[] {
  if (Array.isArray(webhooks)) return webhooks;
  return Array.from(webhooks.values());
}

function resolveWebhookTarget(channel: ReplyChannelLike): WebhookTarget | null {
  if (isThreadLike(channel)) {
    const parent = channel.parent;
    if (parent && isWebhookCapableChannel(parent)) {
      return {
        cacheKey: parent.id,
        sourceChannel: parent,
        threadId: channel.id
      };
    }
    return null;
  }

  if (isWebhookCapableChannel(channel)) {
    return {
      cacheKey: channel.id,
      sourceChannel: channel
    };
  }

  return null;
}

export function createReplyPresenter(options?: {
  onWebhook?: (id: string) => void;
  systemDisplayName?: string;
  webhookName?: string;
  logger?: ReplyPresentationLogger;
}): ReplyPresenter {
  const systemDisplayName = options?.systemDisplayName?.trim() || "Tango";
  const webhookName = options?.webhookName?.trim() || DEFAULT_WEBHOOK_NAME;
  const logger = options?.logger ?? {
    warn(message: string): void {
      console.warn(message);
    },
    error(message: string): void {
      console.error(message);
    }
  };
  const onWebhook = options?.onWebhook;
  const webhookCache = new Map<string, Promise<ReplyWebhook | null>>();
  const avatarDataCache = new Map<string, Promise<string | null>>();

  function resolveAvatarPath(avatarPath: string): string {
    return path.isAbsolute(avatarPath) ? avatarPath : path.resolve(process.cwd(), avatarPath);
  }

  function mimeTypeForAvatarPath(avatarPath: string): string {
    const ext = path.extname(avatarPath).toLowerCase();
    switch (ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".png":
      default:
        return "image/png";
    }
  }

  async function loadAvatarDataUri(avatarPath: string): Promise<string | null> {
    const resolvedPath = resolveAvatarPath(avatarPath);
    const cached = avatarDataCache.get(resolvedPath);
    if (cached) {
      return cached;
    }

    const loading = (async () => {
      try {
        const buffer = await fs.readFile(resolvedPath);
        return `data:${mimeTypeForAvatarPath(resolvedPath)};base64,${buffer.toString("base64")}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[tango-discord] agent avatar file unavailable path=${resolvedPath}: ${message}`);
        return null;
      }
    })();

    avatarDataCache.set(resolvedPath, loading);
    return loading;
  }

  function agentWebhookName(agentId: string | undefined, displayName: string): string {
    const stableName = agentId?.trim() || displayName.trim() || "agent";
    return `${webhookName} - ${stableName}`.slice(0, 80);
  }

  async function getOrCreateWebhook(
    target: WebhookTarget,
    options?: {
      webhookName?: string;
      avatarDataUri?: string | null;
    },
  ): Promise<ReplyWebhook | null> {
    const effectiveWebhookName = options?.webhookName?.trim() || webhookName;
    const cacheKey = `${target.cacheKey}:${effectiveWebhookName}`;
    const cached = webhookCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const loading = (async () => {
      try {
        const existing = listWebhooks(await target.sourceChannel.fetchWebhooks());
        const reusable = existing.find((webhook) => webhook.name === effectiveWebhookName && webhook.token);
        if (reusable) {
          if (options?.avatarDataUri && typeof reusable.edit === "function") {
            return await reusable.edit({
              name: effectiveWebhookName,
              avatar: options.avatarDataUri,
            });
          }
          return reusable;
        }

        return await target.sourceChannel.createWebhook({
          name: effectiveWebhookName,
          ...(options?.avatarDataUri ? { avatar: options.avatarDataUri } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[tango-discord] reply presentation falling back to bot send channel=${target.cacheKey}: ${message}`
        );
        return null;
      }
    })();

    webhookCache.set(cacheKey, loading);
    const resolved = await loading;
    if (resolved) onWebhook?.(resolved.id);
    if (!resolved) {
      webhookCache.delete(cacheKey);
    }
    return resolved;
  }

  function logBotSendFailure(channelId: string, chunkNumber: number, totalChunks: number, message: string): void {
    const formattedMessage =
      `[tango-discord] bot reply failed channel=${channelId} chunk=${chunkNumber}/${totalChunks}: ${message}`;
    if (typeof logger.error === "function") {
      logger.error(formattedMessage);
      return;
    }
    console.error(formattedMessage);
  }

  async function sendBotChunks(
    channel: ReplyChannelLike & { send(content: string | { content: string; reply: { messageReference: string; failIfNotExists: boolean } }): Promise<unknown> },
    chunks: string[],
    options: {
      startChunkNumber: number;
      totalChunks: number;
      replyToMessageId?: string;
    }
  ): Promise<{
    sentChunks: number;
    failed: boolean;
    lastMessageId?: string;
    messageIds: string[];
  }> {
    let sentChunks = 0;
    let failed = false;
    let lastMessageId: string | undefined;
    const messageIds: string[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const chunkNumber = options.startChunkNumber + index + 1;
      try {
        const sent = await channel.send(chunkNumber === 1 && options.replyToMessageId
          ? { content: chunk, reply: { messageReference: options.replyToMessageId, failIfNotExists: false } }
          : chunk);
        const sentObj = sent as { id?: string } | null | undefined;
        if (sentObj && typeof sentObj.id === "string") { lastMessageId = sentObj.id; messageIds.push(sentObj.id); }
        sentChunks += 1;
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        logBotSendFailure(channel.id, chunkNumber, options.totalChunks, message);
      }
    }

    return {
      sentChunks,
      failed,
      lastMessageId,
      messageIds
    };
  }

  return {
    async sendChunked(channel, text, replyOptions) {
      const speaker = replyOptions?.speaker ?? null;
      const intendedDisplayName = resolveSpeakerDisplayName(speaker, systemDisplayName);
      const botDisplayName = replyOptions?.botDisplayName?.trim() || systemDisplayName;
      if (!channel?.isSendable() || typeof channel.send !== "function") {
        const failedResult: PresentedReplyResult = {
          sentChunks: 0,
          delivery: "bot",
          intendedDisplayName,
          actualDisplayName: botDisplayName,
          failed: true
        };
        throw new DeliveryError(
          `[tango-discord] reply channel not sendable channel=${channel?.id ?? "unknown"}`,
          {
            channelId: channel?.id,
            result: failedResult
          }
        );
      }
      const sendableChannel = channel as ReplyChannelLike & {
        send(content: string | { content: string; reply: { messageReference: string; failIfNotExists: boolean } }): Promise<unknown>;
      };

      const normalized = text.trim().length > 0 ? text.trim() : "[empty response]";
      // Reserve room for the triggering-message link on the first webhook chunk.
      const chunks = splitForDiscord(normalized, replyOptions?.replyToMessageId ? 1800 : 1900);
      const target = resolveWebhookTarget(sendableChannel);
      if (target) {
        const avatarPath = replyOptions?.avatarPath?.trim();
        const avatarDataUri = avatarPath ? await loadAvatarDataUri(avatarPath) : null;
        const webhook = await getOrCreateWebhook(target, {
          webhookName: avatarDataUri ? agentWebhookName(speaker?.id, intendedDisplayName) : undefined,
          avatarDataUri,
        });
        if (webhook) {
          let sentViaWebhook = 0;
          let lastMsgId: string | undefined;
          const messageIds: string[] = [];
          for (const chunk of chunks) {
            try {
              const sent = await webhook.send({
                content: sentViaWebhook === 0 && replyOptions?.replyToMessageId
                  ? `[↪ Reply](https://discord.com/channels/${sendableChannel.guildId ?? "@me"}/${sendableChannel.id}/${replyOptions.replyToMessageId})\n${chunk}`
                  : chunk,
                username: intendedDisplayName,
                avatarURL: avatarDataUri ? undefined : replyOptions?.avatarURL,
                ...(target.threadId ? { threadId: target.threadId } : {})
              });
              const sentObj = sent as { id?: string } | null | undefined;
              if (sentObj && typeof sentObj.id === "string") { lastMsgId = sentObj.id; messageIds.push(sentObj.id); }
              sentViaWebhook += 1;
            } catch (error) {
              webhookCache.delete(target.cacheKey);
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(
                `[tango-discord] webhook reply failed channel=${target.cacheKey} speaker=${intendedDisplayName}: ${message}`
              );
              break;
            }
          }

          if (sentViaWebhook === chunks.length) {
            return {
              sentChunks: chunks.length,
              delivery: "webhook",
              intendedDisplayName,
              actualDisplayName: intendedDisplayName,
              failed: false,
              lastMessageId: lastMsgId,
              messageIds
            };
          }

          const botSendResult = await sendBotChunks(sendableChannel, chunks.slice(sentViaWebhook), {
            startChunkNumber: sentViaWebhook,
            totalChunks: chunks.length,
            replyToMessageId: replyOptions?.replyToMessageId
          });

          return {
            sentChunks: sentViaWebhook + botSendResult.sentChunks,
            delivery: sentViaWebhook > 0 ? "mixed" : "bot",
            intendedDisplayName,
            actualDisplayName: sentViaWebhook > 0 ? intendedDisplayName : botDisplayName,
            failed: botSendResult.failed,
            lastMessageId: botSendResult.lastMessageId ?? lastMsgId,
            messageIds: [...messageIds, ...botSendResult.messageIds]
          };
        }
      }

      const botSendResult = await sendBotChunks(sendableChannel, chunks, {
        startChunkNumber: 0,
        totalChunks: chunks.length,
            replyToMessageId: replyOptions?.replyToMessageId
      });

      return {
        sentChunks: botSendResult.sentChunks,
        delivery: "bot",
        intendedDisplayName,
        actualDisplayName: botDisplayName,
        failed: botSendResult.failed,
        lastMessageId: botSendResult.lastMessageId,
        messageIds: botSendResult.messageIds
      };
    }
  };
}
