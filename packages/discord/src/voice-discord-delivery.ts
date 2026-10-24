import type { TangoStorage } from "@tango/core";
import type { VoiceTurnResult } from "@tango/voice";
import {
  DeliveryError,
  splitForDiscord,
  type ReplyPresenter,
  type ReplyChannelLike,
  type PresentedReplyOptions,
} from "./reply-presentation.js";
import { buildVoiceTurnResultFromReceipt as buildReceiptResult } from "./voice-turn-receipts.js";

export function registerVoiceThread(
  storage: Pick<TangoStorage, "getThreadSession" | "setThreadSession">,
  channel: { id: string; isThread(): boolean },
  sessionId: string,
  agentId: string,
): void {
  // Keep lookup and insert synchronous: concurrent turns must not replace a route.
  if (channel.isThread() && !storage.getThreadSession(channel.id)) {
    storage.setThreadSession(channel.id, sessionId, agentId);
  }
}

/**
 * What a voice reply has delivered so far. Shared across attempts so a retry
 * resumes after the last delivered chunk instead of posting the reply twice.
 */
export interface VoiceReplyProgress {
  /** Ids of the messages actually posted, in order. */
  messageIds: string[];
  /** Chunks delivered (a chunk can succeed without reporting an id). */
  deliveredChunks: number;
}

export function createVoiceReplyProgress(): VoiceReplyProgress {
  return { messageIds: [], deliveredChunks: 0 };
}

export async function sendVoiceReply(
  presenter: ReplyPresenter,
  channel: ReplyChannelLike,
  text: string,
  options: PresentedReplyOptions,
  progress: VoiceReplyProgress = createVoiceReplyProgress(),
): Promise<string[]> {
  // The presenter exposes only the last ID. Present one standard Discord chunk
  // at a time so every ID is retained without changing other reply paths.
  const chunks = splitForDiscord(text.trim() || "[empty response]");
  for (let index = progress.deliveredChunks; index < chunks.length; index += 1) {
    const result = await presenter.sendChunked(channel, chunks[index]!, options);
    if (result.failed) {
      throw new DeliveryError(`Voice reply delivery incomplete channel=${channel.id}`, {
        channelId: channel.id,
        result,
      });
    }
    if (result.lastMessageId) progress.messageIds.push(result.lastMessageId);
    progress.deliveredChunks = index + 1;
  }
  return progress.messageIds;
}

/**
 * Deliver a voice reply, retrying once after `retryDelayMs`. Both attempts
 * share one progress record: the retry sends only the chunks the first attempt
 * did not deliver, and the returned ids are exactly the messages posted.
 */
export async function deliverVoiceReplyWithRetry(input: {
  send: (progress: VoiceReplyProgress) => Promise<string[]>;
  wait: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  onRetry?: (error: unknown) => void;
}): Promise<string[]> {
  const progress = createVoiceReplyProgress();
  try {
    return await input.send(progress);
  } catch (error) {
    input.onRetry?.(error);
    await input.wait(input.retryDelayMs ?? 2_000);
    return await input.send(progress);
  }
}

export async function resolveVoiceDiscordDelivery(
  postedChannelId: string | null,
  transcript: Promise<string | null>,
  reply: Promise<string[]>,
): Promise<Required<Pick<VoiceTurnResult,
  "postedChannelId" | "transcriptMessageId" | "responseMessageIds"
>>> {
  const [transcriptMessageId, responseMessageIds] = await Promise.all([
    transcript.catch(() => null),
    reply.catch(() => [] as string[]),
  ]);
  return { postedChannelId, transcriptMessageId, responseMessageIds };
}

export function buildVoiceTurnResultFromReceipt(
  ...args: Parameters<typeof buildReceiptResult>
): VoiceTurnResult | null {
  const result = buildReceiptResult(...args);
  if (!result) return null;
  const metadata = args[1].metadata;
  return {
    ...result,
    postedChannelId: typeof metadata?.postedChannelId === "string" ? metadata.postedChannelId : null,
    transcriptMessageId: typeof metadata?.transcriptMessageId === "string" ? metadata.transcriptMessageId : null,
    responseMessageIds: Array.isArray(metadata?.responseMessageIds)
      ? metadata.responseMessageIds.filter((id): id is string => typeof id === "string")
      : [],
    ...(metadata?.failed === true
      ? { failed: true, failureReason: typeof metadata.failureReason === "string" ? metadata.failureReason : "error" }
      : {}),
  };
}
