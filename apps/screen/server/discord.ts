// Discord REST, read side of the inbox plus reactions. Lifted from the voice
// operator's discord-threads.ts / discord-signals.ts so the screen service can
// own the inbox without depending on the voice app.

const API = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;

export function snowflakeTime(id: string | null | undefined): number {
  if (!id || !/^\d+$/.test(id)) return 0;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function snowflakeAfter(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(ms, Number(DISCORD_EPOCH))) - DISCORD_EPOCH) << 22n).toString();
}

export interface DiscordMessage {
  id: string;
  /** 0 = default, 19 = reply; others are system notices (thread created, pins, …). */
  type?: number;
  channel_id: string;
  content: string;
  webhook_id?: string;
  author: { id: string; bot?: boolean; username: string; global_name?: string | null };
  embeds?: Array<{ title?: string; description?: string }>;
  attachments?: Array<{ id?: string; filename: string; url: string; content_type?: string; size?: number }>;
  reactions?: Array<{ count: number; me: boolean; emoji: { id: string | null; name: string } }>;
}

export interface DiscordThread {
  id: string;
  name: string;
  parent_id: string;
  last_message_id?: string | null;
}

/** A non-OK Discord response; `code` is Discord's JSON error code (50083 = thread is archived). */
export class DiscordError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null) {
    super(message);
  }
}

export const THREAD_ARCHIVED = 50083;

export class DiscordRest {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${API}${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bot ${this.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
      if (response.status === 429 && attempt < 3) {
        const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((resolve) => setTimeout(resolve, Math.ceil((body.retry_after ?? 1) * 1000) + 100));
        continue;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
        const detail = typeof body.code === 'number' ? ` (${body.code}${body.message ? ` ${body.message}` : ''})` : '';
        throw new DiscordError(`Discord ${init.method ?? 'GET'} ${path.split('?')[0]} HTTP ${response.status}${detail}`, response.status, body.code ?? null);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  /** Posts a plain message (no mentions are pinged). */
  async send(channelId: string, content: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }) });
  }

  /** Oldest first. With `after`, only newer messages; with `before`, older ones; else the latest `limit`. */
  async messages(channelId: string, options: { after?: string; before?: string; limit?: number } = {}): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.after) params.set('after', options.after);
    if (options.before) params.set('before', options.before);
    const messages = await this.request<DiscordMessage[]>(`/channels/${channelId}/messages?${params}`);
    return messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async message(channelId: string, messageId: string): Promise<DiscordMessage> {
    return this.request(`/channels/${channelId}/messages/${messageId}`);
  }

  async channel(channelId: string): Promise<{ id: string; guild_id?: string; name?: string; last_message_id?: string | null }> {
    return this.request(`/channels/${channelId}`);
  }

  async activeThreads(guildId: string): Promise<DiscordThread[]> {
    const body = await this.request<{ threads?: DiscordThread[] }>(`/guilds/${guildId}/threads/active`);
    return body.threads ?? [];
  }

  async reactionUsers(channelId: string, messageId: string, emoji: { id: string | null; name: string }): Promise<string[]> {
    const key = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    const users = await this.request<Array<{ id: string }>>(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(key)}?limit=100`);
    return users.map((user) => user.id);
  }

  /** Messages newer than `sinceMs`, oldest first, paging back at most `max` messages. */
  async messagesSince(channelId: string, sinceMs: number, max = 300): Promise<DiscordMessage[]> {
    const collected: DiscordMessage[] = [];
    let before: string | undefined;
    while (collected.length < max) {
      const page = await this.messages(channelId, { limit: 100, ...(before ? { before } : {}) });
      if (page.length === 0) break;
      const recent = page.filter((message) => snowflakeTime(message.id) >= sinceMs);
      collected.unshift(...recent);
      if (recent.length < page.length || page.length < 100) break;
      before = page[0]!.id;
    }
    return collected;
  }

  /** Closes a thread (it reopens on the next message). */
  async archiveThread(threadId: string): Promise<void> {
    await this.request(`/channels/${threadId}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT' });
  }
}

/** Agent personas post through webhooks or the bot. Voice transcripts of the owner are webhook posts marked with a zero-width space. */
export function messageAuthor(message: DiscordMessage, ownerIds: string[]): 'agent' | 'owner' | 'other' {
  if (message.content.startsWith('\u200B')) return 'owner';
  if (message.webhook_id || message.author.bot) return 'agent';
  if (ownerIds.length === 0 || ownerIds.includes(message.author.id)) return 'owner';
  return 'other';
}

/** Bot bookkeeping posted alongside agent replies, never meant for the owner. */
export function isSystemNotice(text: string): boolean {
  return text.startsWith('⚙️ Background job');
}

/** A Discord attachment the desk shows as a picture (the rest stay `[filename]` in the text). */
export function isImageAttachment(attachment: { filename: string; content_type?: string }): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(attachment.content_type ?? '') || (!attachment.content_type && /\.(png|jpe?g|gif|webp)$/i.test(attachment.filename));
}

/** With `images: false`, image attachments are left out of the text (the caller shows them). */
export function messageText(message: DiscordMessage, options: { images?: boolean } = {}): string {
  // State-reconciler lines ("⟢ state: …") ride along with replies; drop them as the reconciler does.
  const voice = message.content.startsWith('\u200B');
  const content = (voice
    ? // Voice requests used to carry the operator's bracketed notes for the agent ("[A screen is live…]").
      message.content.slice(1).replace(/^(\s*\[[^\]]{0,800}\]\s*)+/, '')
    : message.content)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('⟢ state:'))
    .join('\n');
  const parts = [content];
  for (const embed of message.embeds ?? []) parts.push([embed.title, embed.description].filter(Boolean).join(': '));
  for (const attachment of message.attachments ?? []) if (options.images !== false || !isImageAttachment(attachment)) parts.push(`[${attachment.filename}]`);
  return parts.filter((part) => part.trim()).join('\n').trim();
}
