import { randomBytes } from 'node:crypto';
import type { TangoStorage, RuntimeResponse } from '@tango/core';
import { recordConversationPost, settleConversationAttachments, type PostAttachment } from './conversation-posts.js';

export const CONVERSATION_KEY = /^(?:(?:thread|channel):[0-9]+|conv:[0-7][0-9A-HJKMNP-TV-Z]{25})$/;
/** ULID: 48-bit time followed by 80 random bits, Crockford base32. */
export function newConversationKey(now = Date.now()): string {
  let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let id = '';
  for (let i = 0; i < 26; i++) { id = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value & 31n)] + id; value >>= 5n; }
  return `conv:${id}`;
}
export interface ConversationTurnInput {
  conversationKey: string; agentId: string; sessionId: string;
  author: { kind: 'owner' | 'requester'; id?: string; name?: string };
  text: string; attachments?: PostAttachment[]; replyToMessageId?: number | null;
  origin: 'discord' | 'desk' | 'voice'; occurredAt?: string; title?: string;
  discordMessageId?: string; channelId?: string; threadId?: string;
  /** Adapter recovery can resume a previously recorded inbound post. */
  existingInboundMessageId?: number;
}
export interface ConversationTurnResult { response: RuntimeResponse; conversationKey: string; turnId: string; agentId: string; }
export interface ConversationTurnDeps {
  storage: TangoStorage; dataDir: string;
  route: (messageId: number) => Promise<ConversationTurnResult>;
  mirror?: (post: { id: number; text: string; author: 'owner' | 'agent'; response?: RuntimeResponse }) => Promise<void>;
  mirrorError?: (error: unknown) => void;
}
/** The store commits before runtime or mirror work. Mirror errors cannot lose an answer. */
export async function runConversationTurn(input: ConversationTurnInput, deps: ConversationTurnDeps) {
  if (!CONVERSATION_KEY.test(input.conversationKey)) throw new Error('Invalid conversation key');
  if (input.discordMessageId && !input.existingInboundMessageId && deps.storage.findConversationPostByDiscordId(input.discordMessageId)) return null;
  const common = { conversationKey: input.conversationKey, agentId: input.agentId, sessionId: input.sessionId,
    visibility: 'public' as const, origin: input.origin, title: input.title,
    discordChannelId: input.threadId ?? input.channelId, discordParentChannelId: input.channelId, discordThreadId: input.threadId };
  const messageId = recordConversationPost(deps.storage, deps.dataDir, { ...common,
    localMessageId: input.existingInboundMessageId, direction: 'inbound', source: input.origin,
    authorKind: input.author.kind, content: input.text, attachments: input.attachments,
    discordMessageId: input.discordMessageId, discordUserId: input.author.id, discordUsername: input.author.name,
    replyToMessageId: input.replyToMessageId, createdAt: input.occurredAt,
  });
  await settleConversationAttachments(deps.storage);
  const mirror = (post: Parameters<NonNullable<ConversationTurnDeps['mirror']>>[0]) => {
    // Never put network delivery on the runtime's critical path.
    void deps.mirror?.(post).catch(error => deps.mirrorError?.(error));
  };
  if (!input.discordMessageId) mirror({ id: messageId, text: input.text, author: 'owner' });
  const result = await deps.route(messageId);
  const existingResponse = deps.storage.getDatabase().prepare("SELECT id FROM messages WHERE conversation_key=? AND reply_to_message_id=? AND direction='outbound' AND author_kind='agent' LIMIT 1").get(input.conversationKey, messageId) as { id: number } | undefined;
  const responseMessageId = recordConversationPost(deps.storage, deps.dataDir, { ...common,
    localMessageId: existingResponse?.id, direction: 'outbound', source: 'tango', authorKind: 'agent', content: result.response.text,
    replyToMessageId: messageId, metadata: { runtimeMetadata: result.response.metadata ?? null },
  });
  mirror({ id: responseMessageId, text: result.response.text, author: 'agent', response: result.response });
  return { ...result, messageId, responseMessageId };
}

/** Per-conversation serialization also makes lazy thread creation single-flight. */
export class ConversationMirror {
  private pending = new Map<string, Promise<void>>();
  get size(): number { return this.pending.size; }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending.values());
  }
  enqueue(key: string, send: () => Promise<void>): Promise<void> {
    const run = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(send);
    this.pending.set(key, run);
    void run.finally(() => { if (this.pending.get(key) === run) this.pending.delete(key); }).catch(() => {});
    return run;
  }
}

export function canAcceptConversationInput(config: { isolated?: boolean } | undefined, enabled: boolean,
  agentId: string, conversationOwner?: string | null, starting = false): boolean {
  return !!config && !config.isolated && enabled && (starting || conversationOwner === agentId);
}
export function mirrorsPosts(mode: 'both' | 'outbound' | 'off' | undefined): boolean { return mode !== 'off'; }

/** Called inside the mirror queue. A failed creation leaves the conversation unmirrored and retryable. */
export async function ensureConversationMirror<T>(storage: TangoStorage, key: string,
  create: () => Promise<{ channelId: string; threadId: string; starter?: T }>): Promise<{ channelId: string; threadId?: string; starter?: T }> {
  const db = storage.getDatabase();
  const row = db.prepare('SELECT discord_channel_id,discord_thread_id FROM conversations WHERE conversation_key=?').get(key) as { discord_channel_id: string | null; discord_thread_id: string | null } | undefined;
  if (!row) throw new Error('Conversation unavailable');
  if (row.discord_channel_id) return { channelId: row.discord_channel_id, ...(row.discord_thread_id ? { threadId: row.discord_thread_id } : {}) };
  const created = await create();
  db.prepare('UPDATE conversations SET discord_channel_id=?,discord_thread_id=? WHERE conversation_key=?').run(created.channelId, created.threadId, key);
  return created;
}

export interface DiscordTurnMessage {
  id: string; content: string; channelId: string; createdAt: Date;
  author: { id: string; username: string };
  channel: { isThread(): boolean; parentId?: string | null };
  reference?: { messageId?: string } | null;
  attachments: { values(): Iterable<{ name: string; url: string; contentType: string | null; size: number }> };
}
/** The adapter supplies resolved routing/authorization; this mapping contains no network operations. */
export function discordMessageToTurn(message: DiscordTurnMessage, storage: TangoStorage,
  context: Pick<ConversationTurnInput, 'agentId' | 'sessionId'> & { conversationKey?: string }): ConversationTurnInput {
  const thread = message.channel.isThread();
  const channelId = thread ? message.channel.parentId ?? message.channelId : message.channelId;
  return { ...context, conversationKey: context.conversationKey ?? `${thread ? 'thread' : 'channel'}:${message.channelId}`,
    channelId, ...(thread ? { threadId: message.channelId } : {}), discordMessageId: message.id,
    occurredAt: message.createdAt.toISOString(), origin: 'discord', text: message.content,
    author: { kind: 'owner', id: message.author.id, name: message.author.username },
    replyToMessageId: message.reference?.messageId ? storage.findConversationPostByDiscordId(message.reference.messageId) : null,
    attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType, size: a.size })),
  };
}
