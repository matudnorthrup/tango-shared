import { type DeskConversationEvent } from "./desk-events.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TangoStorage, ConversationPostInput, ConversationAttachment } from "@tango/core";

export interface PostAttachment extends ConversationAttachment { filePath?: string; }

const eventClients = new WeakMap<TangoStorage, (event: DeskConversationEvent) => void>();
/** Registered by the bot only: backfills/tests never send events to the live desk. */
export function setConversationEvents(storage: TangoStorage, post: (event: DeskConversationEvent) => void): void {
  eventClients.set(storage, post);
}
function report(storage: TangoStorage, conversationKey: string, messageId: number, type: DeskConversationEvent['type']): void {
  const post = eventClients.get(storage);
  if (!post) return;
  const row = storage.getDatabase().prepare('SELECT agent_id FROM conversations WHERE conversation_key=?').get(conversationKey) as { agent_id: string } | undefined;
  if (row?.agent_id) { try { post({ type, agentId: row.agent_id, conversationKey, messageId, at: Date.now() }); } catch {} }
}

/** All conversation writers use this path; download failures remain visible and retryable. */
export function recordConversationPost(
  storage: TangoStorage,
  dataDir: string,
  input: Omit<ConversationPostInput, "attachments"> & { attachments?: PostAttachment[] },
): number {
  // Reserve the row before async I/O so repeated delivery cannot create duplicates.
  const id = storage.recordConversationPost({ ...input, attachments: input.attachments?.map(({ filePath, ...metadata }) => metadata) });
  report(storage, input.conversationKey, id, "message.created");
  report(storage, input.conversationKey, id, "conversation.updated");
  if (!input.attachments?.length) return id;
  const previous = pendingCopies.get(storage)?.get(id) ?? Promise.resolve();
  const copies = pendingCopies.get(storage) ?? new Map<number, Promise<void>>();
  pendingCopies.set(storage, copies);
  const copy = previous.then(() => copyAttachments(storage, dataDir, input.conversationKey, id, input.attachments!))
    .catch(error => { console.error("[conversation-posts] attachment metadata update failed", error); })
    .finally(() => { if (copies.get(id) === copy) copies.delete(id); });
  copies.set(id, copy);
  return id;
}

const pendingCopies = new WeakMap<TangoStorage, Map<number, Promise<void>>>();

/** Drain before closing storage, or when a caller needs durable attachment files. */
export async function settleConversationAttachments(storage: TangoStorage): Promise<void> {
  const copies = pendingCopies.get(storage);
  while (copies?.size) await Promise.all(copies.values());
}

async function copyAttachments(storage: TangoStorage, dataDir: string, conversationKey: string,
  id: number, inputs: PostAttachment[]): Promise<void> {
  const directory = path.join(dataDir, "attachments", conversationKey, String(id));
  const attachments: ConversationAttachment[] = [];
  for (const [index, attachment] of inputs.entries()) {
    const name = path.basename(attachment.name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
    const destination = path.join(directory, `${index}-${name}`);
    const { filePath, ...metadata } = attachment;
    const temporary = `${destination}.${randomUUID()}.partial`;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (filePath) {
        await fs.copyFile(filePath, destination);
        await fs.chmod(destination, 0o600);
      }
      else {
        const url = new URL(attachment.url ?? "");
        // Only Discord's attachment CDN is accepted; no arbitrary network fetches.
        if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
          throw new Error("Unsupported attachment URL");
        }
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
        if (!response.ok) throw new Error(`Attachment HTTP ${response.status}`);
        if (!response.body) throw new Error("Empty attachment body");
        const file = await fs.open(temporary, "w", 0o600);
        try {
          for await (const chunk of response.body) await file.write(chunk);
        } finally { await file.close(); }
        await fs.rename(temporary, destination);
      }
      attachments.push({ ...metadata, localPath: path.relative(dataDir, destination), error: undefined });
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      attachments.push({ ...metadata, localPath: undefined, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Only update attachment metadata: another writer may have enriched the row during I/O.
  storage.getDatabase().prepare("UPDATE messages SET attachments = ? WHERE id = ?").run(JSON.stringify(attachments), id);
  report(storage, conversationKey, id, "conversation.updated");
}

/** Gateway events may arrive before send() returns. Wait for the full-text writer first. */
export class ConversationDeliveryTracker {
  private readonly pending = new Map<string, Set<Promise<void>>>();

  async run<T>(channelId: string, send: () => Promise<T>): Promise<T> {
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const pending = this.pending.get(channelId) ?? new Set<Promise<void>>();
    pending.add(completion);
    this.pending.set(channelId, pending);
    try { return await send(); }
    finally {
      pending.delete(completion);
      if (!pending.size) this.pending.delete(channelId);
      finish();
    }
  }

  async settled(channelId: string): Promise<void> {
    while (this.pending.has(channelId)) await Promise.all(this.pending.get(channelId)!);
  }
}

/** Only our bot and webhooks selected by our writers are outbound agent posts. */
export function isOwnConversationPost(message: { author: { id: string }; webhookId?: string | null },
  botId: string | undefined, webhookIds: ReadonlySet<string>): boolean {
  return message.author.id === botId || Boolean(message.webhookId && webhookIds.has(message.webhookId));
}

/** Resolve cold-cache threads before assigning the durable conversation key. */
export async function resolveConversationChannel<T extends { isThread(): boolean }>(
  channels: { cache: { get(id: string): T | undefined }; fetch(id: string): Promise<T | null> },
  channelId: string | null | undefined, hasThreadSession: (id: string) => boolean,
): Promise<{ channel: T | null; thread: boolean; conversationKey: string | null }> {
  const channel = channelId
    ? channels.cache.get(channelId) ?? await channels.fetch(channelId).catch(() => null) : null;
  const thread = Boolean(channel?.isThread() || (channelId && hasThreadSession(channelId)));
  return { channel, thread, conversationKey: channelId ? `${thread ? "thread" : "channel"}:${channelId}` : null };
}
