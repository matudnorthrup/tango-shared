import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DiscordError, snowflakeAt, type DiscordMessage, type DiscordThread } from '../server/discord.js';
import { DeskCore, type DeskCoreOptions } from '../server/desk/core.js';
import { DeskDiscordSource, type DeskDiscordOptions, type DiscordApi } from '../server/desk/source-discord.js';
import { DeskStore } from '../server/desk/store.js';
import { fallbackSummary, type DeskSummarizer } from '../server/desk/summarize.js';

// Fakes and a clock for desk tests. Synthetic ids and names only.

export const OWNER = '111';
export const AGENT = { id: 'sierra', name: 'Sierra', homeChannelId: '5000' };
export const NOW = 1_790_000_000_000;

export class FakeDiscord {
  channels = new Map<string, DiscordMessage[]>();
  threads: DiscordThread[] = [];
  reactionUsersBy = new Map<string, string[]>();
  reacted: string[] = [];
  archived: string[] = [];
  failArchive = false;
  /** Threads the owner closed in Discord: reactions there fail like the real API. */
  archivedThreads = new Set<string>();
  async channel(id: string) {
    return { id, ...this.threads.find((thread) => thread.id === id), guild_id: 'g', last_message_id: this.channels.get(id)?.at(-1)?.id ?? null };
  }
  async activeThreads() {
    return this.threads;
  }
  async messages(channelId: string, options: { after?: string } = {}) {
    return (this.channels.get(channelId) ?? []).filter((message) => !options.after || BigInt(message.id) > BigInt(options.after));
  }
  async messagesSince(channelId: string, sinceMs: number) {
    return (this.channels.get(channelId) ?? []).filter((message) => Number((BigInt(message.id) >> 22n) + 1420070400000n) >= sinceMs);
  }
  async message(channelId: string, messageId: string) {
    const found = (this.channels.get(channelId) ?? []).find((message) => message.id === messageId);
    if (!found) throw new Error('Discord GET HTTP 404');
    return found;
  }
  async reactionUsers(_channel: string, messageId: string) {
    return this.reactionUsersBy.get(messageId) ?? [];
  }
  async react(channelId: string, messageId: string, emoji: string) {
    if (this.archivedThreads.has(channelId)) throw new DiscordError('Discord PUT /channels HTTP 400 (50083 Thread is archived)', 400, 50083);
    this.reacted.push(`${channelId}/${messageId}/${emoji}`);
  }
  async archiveThread(threadId: string) {
    if (this.failArchive) throw new Error('Discord PATCH /channels HTTP 403');
    this.archived.push(threadId);
  }
  push(channelId: string, message: DiscordMessage) {
    const list = this.channels.get(channelId) ?? [];
    list.push(message);
    list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    this.channels.set(channelId, list);
  }
}

let seq = 0;
/** A message `minutesFromNow` (negative = in the past) relative to NOW. */
export function msg(minutesFromNow: number, author: 'agent' | 'owner', content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  seq += 1;
  // Distinct ids for messages in the same millisecond.
  const id = (BigInt(snowflakeAt(NOW + minutesFromNow * 60_000)) + BigInt(seq)).toString();
  return {
    id,
    type: 0,
    channel_id: 'x',
    content,
    author: author === 'owner' ? { id: OWNER, username: 'owner' } : { id: '999', bot: true, username: 'Sierra' },
    ...(author === 'agent' ? { webhook_id: 'w' } : {}),
    ...extra,
  };
}

export interface Harness {
  dir: string;
  db: DatabaseSync;
  clock: { now: number };
  core: DeskCore;
  discord: FakeDiscord;
  source: DeskDiscordSource;
  posted: Array<Record<string, unknown>>;
  botResult: { value: string };
  summarizer: { impl: DeskSummarizer };
  close(): void;
}

export function makeHarness(options: Partial<DeskCoreOptions> = {}, sourceOptions: Partial<DeskDiscordOptions> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const db = new DatabaseSync(path.join(dir, 'screen.db'));
  const clock = { now: NOW };
  const summarizer = { impl: (async (input) => fallbackSummary(input)) as DeskSummarizer };
  const posted: Array<Record<string, unknown>> = [];
  const botResult = { value: 'agent' };
  const discord = new FakeDiscord();
  const adapters: NonNullable<DeskCoreOptions['adapters']> = [];
  const core = new DeskCore({
    store: new DeskStore(db, () => clock.now),
    summarize: (input) => summarizer.impl(input),
    adapters,
    refreshConversation: (channelId): Promise<number> => source.refresh(channelId),
    now: () => clock.now,
    summaryDelayMs: 60_000,
    formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
    ...options,
  });
  const source = new DeskDiscordSource({
    core,
    discord: discord as unknown as DiscordApi,
    agents: [AGENT],
    ownerIds: [OWNER],
    postToBot: async (body) => {
      posted.push(body);
      return botResult.value;
    },
    now: () => clock.now,
    ...sourceOptions,
  });
  adapters.push(source);
  return {
    dir,
    db,
    clock,
    core,
    discord,
    source,
    posted,
    botResult,
    summarizer,
    close() {
      core.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let commandSeq = 0;
export function cid(): string {
  commandSeq += 1;
  return `cmd-${commandSeq}`;
}

/** Fake bot store API; records cursor requests, never contacts a running bot. */
export class FakeConversationApi {
  conversations: import('../server/desk/source-tango.js').StoreConversation[] = [];
  posts: import('../server/desk/source-tango.js').StorePost[] = [];
  revision = 1;
  requests: string[] = [];
  fail = false;
  posted: Record<string, unknown>[] = [];
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.requests.push(url.pathname + url.search);
    if (this.fail) return new Response('unavailable', { status: 503 });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); this.posted.push(body);
      const key = body.conversationKey ?? 'conv:00000000000000000000000001';
      const id = this.posts.length + 1; this.revision++;
      let conversation = this.conversations.find(c => c.conversation_key === key);
      if (!conversation) { conversation = { conversation_key: key, agent_id: body.agentId, kind: 'thread', title: body.data.title ?? 'Native', discord_channel_id: null, discord_thread_id: null, revision: this.revision, changed_message_ids: '[]' }; this.conversations.push(conversation); }
      conversation.revision = this.revision; conversation.changed_message_ids = JSON.stringify([id]);
      this.posts.push({ id, conversation_key: key, author_kind: 'owner', content: body.data.text, created_at: new Date().toISOString(), discord_message_ids: '[]', reply_to_message_id: null, attachments: '[]' });
      return Response.json({ delivered: true, conversationKey: key });
    }
    if (url.pathname === '/conversations') return Response.json({ cursor: this.revision,
      conversations: this.conversations.filter(c => c.revision > Number(url.searchParams.get('updatedAfter') ?? 0)) });
    const key = decodeURIComponent(url.pathname.split('/')[2]!);
    return Response.json({ messages: this.posts.filter(p => p.conversation_key === key && p.id > Number(url.searchParams.get('after') ?? 0)).sort((a,b) => a.id-b.id).slice(0, Number(url.searchParams.get('limit') ?? 100)) });
  };
}
