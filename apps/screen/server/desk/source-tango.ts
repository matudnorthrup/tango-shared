import type { DeskItemRow } from './types.js';
import type { StartAttachment } from './attachments.js';
import type { InboxAgent } from '../inbox.js';
import { isSystemNotice, snowflakeTime, type DiscordMessage } from '../discord.js';
import type { DeskCore, DeskSourceAdapter } from './core.js';
import { joinsChapter, storeTime } from './chapters.js';
import { parseMailHeader } from './mail.js';
import type { Tracer } from './trace.js';

export interface StorePost {
  id: number; conversation_key: string; author_kind: 'owner' | 'agent' | 'system' | 'requester';
  content: string; created_at: string; discord_message_ids: string; reply_to_message_id: number | null;
  attachments: string; discord_message_type?: number | null; input_source?: string | null;
}
export interface StoreConversation {
  conversation_key: string; agent_id: string; kind: 'thread' | 'home'; title: string;
  discord_channel_id: string | null; discord_thread_id: string | null;
  revision: number; changed_message_ids: string;
}
export interface ShadowPost { id: string; text: string; }
export interface ShadowDifference { kind: 'missing-tango' | 'missing-discord' | 'text' | 'order'; id: string; }
export function shadowDiff(tango: ShadowPost[], discord: ShadowPost[]): ShadowDifference[] {
  const a = new Map(tango.map(p => [p.id, p.text])); const b = new Map(discord.map(p => [p.id, p.text]));
  const result: ShadowDifference[] = [];
  for (const [id, text] of a) {
    if (!b.has(id)) result.push({ kind: 'missing-discord', id });
    else if (text !== b.get(id)) result.push({ kind: 'text', id });
  }
  for (const id of b.keys()) if (!a.has(id)) result.push({ kind: 'missing-tango', id });
  const commonA = [...a.keys()].filter(id => b.has(id));
  const commonB = [...b.keys()].filter(id => a.has(id));
  for (let i = 0; i < commonA.length; i++) if (commonA[i] !== commonB[i]) result.push({ kind: 'order', id: commonA[i]! });
  return result;
}
export function parseStoreKey(key: string): { kind: 'thread' | 'channel' | 'conv'; id: string } | null {
  const m = /^(?:(thread|channel):(\d+)|(conv):([0-7][0-9A-HJKMNP-TV-Z]{25}))$/.exec(key);
  return m ? { kind: (m[1] ?? m[3]) as 'thread' | 'channel' | 'conv', id: (m[2] ?? m[4])! } : null;
}
const normalize = (text: string) => text.replace(/^\[↪ Reply\]\(https:\/\/discord\.com\/channels\/[^)]+\)\n/, '').replace(/^🖥️\s*/, '').trim();


export interface ShadowExclusion { id: string; reason: 'discord-system-event' | 'unmirrored-voice'; }
const mirrorIds = (post: StorePost): string[] => (JSON.parse(post.discord_message_ids) as string[])
  .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/** Compare chronological logical posts, not backfill insertion order. Keep exclusions auditable. */
export function compareConversationPosts(posts: StorePost[], discord: DiscordMessage[]) {
  const exclusions: ShadowExclusion[] = [];
  const ordered = posts.filter(post => {
    const reason = post.discord_message_type != null && ![0, 19].includes(post.discord_message_type)
      ? 'discord-system-event' : !mirrorIds(post).length && post.input_source === 'voice-bridge' ? 'unmirrored-voice' : null;
    if (reason) exclusions.push({ id: mirrorIds(post)[0] ?? `local:${post.id}`, reason });
    return !reason;
  }).sort((a, b) => {
    const at = mirrorIds(a)[0]; const bt = mirrorIds(b)[0];
    return (at ? snowflakeTime(at) : storeTime(a.created_at)) - (bt ? snowflakeTime(bt) : storeTime(b.created_at)) || a.id - b.id;
  });
  const byId = new Map(discord.map(p => [p.id, p]));
  const consumed = new Set<string>();
  const tango: ShadowPost[] = []; const mirror: ShadowPost[] = [];
  const missingChunks: ShadowDifference[] = [];
  // Collapse the mirror's chunks into the same logical post. Missing individual chunks stay visible.
  for (const post of ordered) {
    const ids = mirrorIds(post);
    const id = ids[0] ?? `local:${post.id}`;
    tango.push({ id, text: normalize(post.content) });
    if (ids.some(chunk => byId.has(chunk))) {
      for (const chunk of ids) if (!byId.has(chunk)) missingChunks.push({ kind: 'missing-discord', id: chunk });
      const chunks = ids.map(chunk => normalize(byId.get(chunk)?.content ?? ''));
      let remaining = normalize(post.content);
      const exact = ids.every(chunk => byId.has(chunk)) && chunks.every(chunk => {
        if (!remaining.startsWith(chunk)) return false;
        remaining = remaining.slice(chunk.length).trimStart(); return true;
      }) && !remaining;
      mirror.push({ id, text: exact ? normalize(post.content) : chunks.join('\n') });
      ids.forEach(chunk => consumed.add(chunk));
    }
  }
  for (const post of discord) if (!consumed.has(post.id)) mirror.push({ id: post.id, text: normalize(post.content) });
  mirror.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  return { differences: [...shadowDiff(tango, mirror), ...missingChunks], exclusions };
}

export interface TangoSourceOptions {
  core: DeskCore; agents: InboxAgent[]; url: string; token?: string;
  mode?: 'shadow' | 'tango'; mirror?: DeskSourceAdapter | null; fetchImpl?: typeof fetch; trace?: Tracer; now?: () => number;
}

/** The store's ids are the read cursor. Discord ids are only mirror/writeback identities. */
export class DeskTangoSource implements DeskSourceAdapter {
  private readonly pending = new Map<string, { run: Promise<void>; again: boolean; ids: Set<number> }>();
  private pollRun: Promise<void> | null = null;
  private replayed = false;
  constructor(private readonly options: TangoSourceOptions) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS desk_tango_posts (id INTEGER PRIMARY KEY, conversation_key TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desk_tango_posts_key ON desk_tango_posts(conversation_key,id);
      CREATE TABLE IF NOT EXISTS desk_tango_conversations (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_discord_shadow (id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desk_discord_shadow_key ON desk_discord_shadow(conversation_key,id);
      CREATE TABLE IF NOT EXISTS desk_tango_exclusions (key TEXT PRIMARY KEY, reasons TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_tango_diffs (key TEXT PRIMARY KEY, at INTEGER NOT NULL, differences TEXT NOT NULL);`);
    // Added comparison metadata requires a one-time replay of the read-only cache.
    if (this.core.store.marker('tango:cache-format') !== '2') {
      this.db.prepare("DELETE FROM desk_markers WHERE key LIKE 'tango:messages:%'").run();
      if (this.core.store.marker('tango:changes') !== null) this.core.store.setMarker('tango:changes', '0');
      this.core.store.setMarker('tango:cache-format', '2');
    }
  }
  setMirror(mirror: DeskSourceAdapter | null): void { this.options.mirror = mirror; }
  owns(item: DeskItemRow): boolean {
    if (this.options.mode !== 'tango' || !item.conversationKey) return false;
    const row = this.db.prepare('SELECT body FROM desk_tango_conversations WHERE key=?').get(item.conversationKey) as { body: string } | undefined;
    return !!row && this.allowed(JSON.parse(row.body));
  }
  private mirrorItem(item: DeskItemRow): DeskItemRow | null {
    const row = this.db.prepare('SELECT body FROM desk_tango_conversations WHERE key=?').get(item.conversationKey!) as { body: string } | undefined;
    if (!row) return null;
    const c = JSON.parse(row.body) as StoreConversation;
    if (!c.discord_channel_id) return null;
    const post = item.lastAgentMessageId?.startsWith('tango:')
      ? this.db.prepare('SELECT body FROM desk_tango_posts WHERE id=?').get(Number(item.lastAgentMessageId.slice(6))) as { body: string } | undefined : undefined;
    return { ...item, channelId: c.discord_channel_id, threadId: c.discord_thread_id,
      lastAgentMessageId: post ? mirrorIds(JSON.parse(post.body)).at(-1) ?? null : item.lastAgentMessageId };
  }
  async done(item: DeskItemRow) {
    const mirror = this.mirrorItem(item);
    return mirror && this.options.mirror ? this.options.mirror.done(mirror) : { outcome: 'n/a' as const, steps: [] };
  }
  async react(item: DeskItemRow, emoji: string): Promise<void> {
    const mirror = this.mirrorItem(item);
    if (mirror) await this.options.mirror?.react?.(mirror, emoji);
  }
  async post(body: Record<string, unknown>): Promise<{ delivered: boolean; conversationKey?: string; reason?: string }> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.url.replace(/\/$/, '')}/conversations/${body.type === 'start' ? 'start' : 'turn'}`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', ...(this.options.token ? { 'X-Tango-Collaboration-Token': this.options.token } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Conversation API HTTP ${response.status}`);
    return response.json();
  }
  async start(body: Record<string, unknown>): Promise<{ ok: true; threadId: string; conversationKey: string } | { ok: false; error: string }> {
    try {
      const result = await this.post({ ...body, type: 'start' });
      return result.delivered && result.conversationKey ? { ok: true, threadId: result.conversationKey, conversationKey: result.conversationKey }
        : { ok: false, error: result.reason ?? 'Conversation not started' };
    } catch (error) { return { ok: false, error: String(error) }; }
  }
  async reply(item: DeskItemRow, text: string, context: { commandId?: string; attachments?: StartAttachment[] } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await this.post({ agentId: item.agentId, conversationKey: item.conversationKey, type: 'reply',
        commandId: context.commandId, replyToMessageId: item.lastAgentMessageId, data: { text, attachments: context.attachments } });
      return result.delivered ? { ok: true } : { ok: false, error: result.reason ?? 'Reply not accepted' };
    } catch (error) { return { ok: false, error: String(error) }; }
  }
  private allowed(conversation: StoreConversation): boolean {
    const agent = this.options.agents.find(a => a.id === conversation.agent_id);
    const key = parseStoreKey(conversation.conversation_key);
    return !!agent && !!key && (key.kind === 'conv' || (key.kind === 'channel' ? key.id === agent.homeChannelId : conversation.discord_channel_id === agent.homeChannelId));
  }
  private get core() { return this.options.core; }
  private get db() { return this.core.store.db; }
  async request<T>(pathname: string): Promise<T> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.url.replace(/\/$/, '')}${pathname}`, {
      signal: AbortSignal.timeout(10_000), headers: this.options.token ? { 'X-Tango-Collaboration-Token': this.options.token } : {},
    });
    if (!response.ok) throw new Error(`Conversation API HTTP ${response.status}`);
    return await response.json() as T;
  }
  poll(): Promise<void> {
    if (!this.pollRun) this.pollRun = this.pollOnce().finally(() => { this.pollRun = null; });
    return this.pollRun;
  }
  private async pollOnce(): Promise<void> {
    if (!this.replayed && this.options.mode === 'tango') {
      for (const row of this.db.prepare('SELECT p.body AS post,c.body AS conversation FROM desk_tango_posts p JOIN desk_tango_conversations c ON c.key=p.conversation_key ORDER BY p.id').all() as { post: string; conversation: string }[]) {
        const conversation = JSON.parse(row.conversation) as StoreConversation;
        // Backfill includes archived threads. Only conversations actually seen by the old source
        // are replayed on cutover; subsequent new posts are read normally and can reopen one.
        if (this.core.store.marker(`tango:shadow-since:${conversation.conversation_key}`) !== null || this.core.itemForConversation(conversation.conversation_key)) {
          this.ingest(conversation, JSON.parse(row.post) as StorePost);
        }
      }
      this.replayed = true;
      this.core.flush();
    }
    const cursor = this.core.store.marker('tango:changes') ?? '0';
    const result = await this.request<{ conversations: StoreConversation[]; cursor: number }>(`/conversations?updatedAfter=${cursor}`);
    for (const conversation of result.conversations) {
      if (!this.allowed(conversation)) continue;
      this.db.prepare('INSERT OR REPLACE INTO desk_tango_conversations VALUES (?,?)').run(conversation.conversation_key, JSON.stringify(conversation));
      await this.refresh(conversation.conversation_key, JSON.parse(conversation.changed_message_ids) as number[]);
    }
    // A failed conversation keeps the global cursor: the next backstop retries it.
    this.core.store.setMarker('tango:changes', String(result.cursor));
    for (const row of this.db.prepare('SELECT DISTINCT conversation_key FROM desk_discord_shadow').all() as { conversation_key: string }[]) this.compare(row.conversation_key);
  }
  async push(key: string, messageId: number): Promise<void> {
    if (!parseStoreKey(key)) return;
    if (!this.db.prepare('SELECT 1 FROM desk_tango_conversations WHERE key=?').get(key)) await this.poll();
    await this.refresh(key, [messageId]);
  }
  refresh(key: string, changed: number[] = []): Promise<void> {
    const pending = this.pending.get(key);
    if (pending) { pending.again = true; changed.forEach(id => pending.ids.add(id)); return pending.run; }
    const state = { run: Promise.resolve(), again: false, ids: new Set(changed) };
    state.run = (async () => {
      await Promise.resolve();
      do {
        state.again = false;
        const ids = [...state.ids]; state.ids.clear();
        await this.read(key, ids);
      } while (state.again);
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, state); return state.run;
  }
  private async read(key: string, changed: number[]): Promise<void> {
    const row = this.db.prepare('SELECT body FROM desk_tango_conversations WHERE key=?').get(key) as { body: string } | undefined;
    if (!row) return;
    const conversation = JSON.parse(row.body) as StoreConversation;
    if (!this.allowed(conversation)) return;
    const markerKey = `tango:messages:${key}`;
    let cursor = Number(this.core.store.marker(markerKey) ?? 0);
    const before = cursor;
    const save = (post: StorePost) => {
      this.db.prepare('INSERT OR REPLACE INTO desk_tango_posts VALUES (?,?,?)').run(post.id, key, JSON.stringify(post));
      if (this.options.mode === 'tango') this.ingest(conversation, post);
    };
    while (true) {
      const { messages } = await this.request<{ messages: StorePost[] }>(`/conversations/${encodeURIComponent(key)}/messages?after=${cursor}&limit=500`);
      for (const post of messages) { if (post.id <= cursor || post.conversation_key !== key) throw new Error('Invalid store cursor page'); save(post); cursor = post.id; }
      // Cache and materialization precede the cursor, so retries are safe.
      this.core.store.setMarker(markerKey, String(cursor));
      if (messages.length < 500) break;
    }
    for (const id of new Set(changed.filter(id => id <= before))) {
      const { messages } = await this.request<{ messages: StorePost[] }>(`/conversations/${encodeURIComponent(key)}/messages?after=${id - 1}&limit=1`);
      if (messages[0]?.id === id) save(messages[0]);
    }
    this.compare(key);
    this.core.flush();
  }
  hasDiscordSnapshot(key: string): boolean { return this.core.store.marker(`tango:shadow-since:${key}`) !== null; }
  observeDiscord(key: string, messages: DiscordMessage[], since: number): void {
    for (const post of messages) {
      if (post.type !== undefined && post.type !== 0 && post.type !== 19) continue;
      this.db.prepare('INSERT OR REPLACE INTO desk_discord_shadow VALUES (?,?,?)').run(post.id, key, JSON.stringify(post));
    }
    this.core.store.setMarker(`tango:shadow-since:${key}`, String(since));
    this.compare(key);
  }
  private compare(key: string): void {
    const since = this.core.store.marker(`tango:shadow-since:${key}`);
    if (since === null || (this.core.store.marker('tango:changes') === null && this.core.store.marker(`tango:messages:${key}`) === null)) return;
    const posts = (this.db.prepare('SELECT body FROM desk_tango_posts WHERE conversation_key=? ORDER BY id').all(key) as { body: string }[]).map(r => JSON.parse(r.body) as StorePost).filter(p => storeTime(p.created_at) >= Number(since));
    const discord = (this.db.prepare('SELECT body FROM desk_discord_shadow WHERE conversation_key=? ORDER BY length(id),id').all(key) as { body: string }[]).map(r => JSON.parse(r.body) as DiscordMessage).filter(p => snowflakeTime(p.id) >= Number(since));
    const { differences, exclusions } = compareConversationPosts(posts, discord);
    this.db.prepare('INSERT OR REPLACE INTO desk_tango_exclusions VALUES (?,?)').run(key, JSON.stringify(exclusions));
    const encoded = JSON.stringify(differences);
    const previous = this.db.prepare('SELECT differences FROM desk_tango_diffs WHERE key=?').get(key) as { differences: string } | undefined;
    this.db.prepare('INSERT OR REPLACE INTO desk_tango_diffs VALUES (?,?,?)').run(key, Date.now(), encoded);
    if (previous?.differences !== encoded) {
      for (const difference of differences) this.options.trace?.({ source: 'desk', kind: 'tango.shadow.diff', summary: `${key}: ${difference.kind} ${difference.id}`, data: { conversationKey: key, ...difference } });
      if (!differences.length) this.options.trace?.({ source: 'desk', kind: 'tango.shadow.clean', summary: `${key}: sources agree`, data: { conversationKey: key } });
    }
  }
  report() {
    return (this.db.prepare('SELECT * FROM desk_tango_diffs ORDER BY key').all() as { key: string; at: number; differences: string }[]).map(r => ({ ...r, differences: JSON.parse(r.differences) as ShadowDifference[], exclusions: JSON.parse((this.db.prepare('SELECT reasons FROM desk_tango_exclusions WHERE key=?').get(r.key) as { reasons: string } | undefined)?.reasons ?? '[]') as ShadowExclusion[] }));
  }
  private ingest(conversation: StoreConversation, post: StorePost): void {
    const agent = this.options.agents.find(a => a.id === conversation.agent_id);
    const key = parseStoreKey(conversation.conversation_key);
    if (post.discord_message_type != null && ![0, 19].includes(post.discord_message_type)) return;
    if (!agent || !key || !this.allowed(conversation) || post.author_kind === 'requester') return;
    const author = post.author_kind === 'owner' ? 'owner' : 'agent';
    const text = author === 'owner' ? normalize(post.content) : post.content.trim();
    if (author === 'agent' && isSystemNotice(text)) return;
    const at = storeTime(post.created_at);
    const maxAge = (key.kind === 'channel' ? 7 : 30) * 86_400_000;
    if ((this.options.now ?? Date.now)() - at > maxAge) return;
    const ids = mirrorIds(post);
    const messageId = key.kind === 'conv' ? `tango:${post.id}` : ids.at(-1) ?? `tango:${post.id}`;
    const attachments = (JSON.parse(post.attachments) as { name: string; contentType?: string; localPath?: string; size?: number }[])
      .flatMap((a, index) => a.localPath && a.contentType?.startsWith('image/') ? [{ name: a.name, mimeType: a.contentType, sizeBytes: a.size, url: `/api/desk/tango-attachments/${post.id}/${index}` }] : []);
    const existing = ids.map(id => this.core.store.itemForMessage(id)).find(Boolean) ?? this.core.store.itemForMessage(messageId);
    if (existing) {
      // Preserve historical chunk layout and all attention identities through cutover.
      const old = this.db.prepare('SELECT text,attachments FROM desk_messages WHERE message_id=?').get(messageId) as { text: string; attachments: string | null } | undefined;
      const nextAttachments = attachments.length ? JSON.stringify(attachments) : old?.attachments ?? null;
      // Old multi-chunk desk history stays in its existing layout; single posts can be enriched.
      const nextText = ids.length > 1 ? old?.text ?? text : text;
      const changed = this.db.prepare('UPDATE desk_messages SET text=?,attachments=? WHERE message_id=? AND (text IS NOT ? OR attachments IS NOT ?)').run(nextText, nextAttachments, messageId, nextText, nextAttachments);
      if (changed.changes) {
        const item = this.core.store.item(existing)!;
        this.core.setFacts(existing, {
          ...(item.lastAgentMessageId === messageId && item.facts.lastAgentWords ? { lastAgentWords: { ...item.facts.lastAgentWords, text: nextText.slice(0, 600) } } : {}),
          ...(author === 'owner' && item.facts.lastOwnerRequest?.at === at ? { lastOwnerRequest: { ...item.facts.lastOwnerRequest, text: nextText } } : {}),
          contentKey: `tango:${post.id}:${Date.now()}`,
        });
      }
      return;
    }
    const base = { source: 'discord' as const, agentId: agent.id, agentName: agent.name, channelId: agent.homeChannelId, createdAt: at, conversationKey: conversation.conversation_key };
    let itemId: string;
    if (key.kind === 'thread' || key.kind === 'conv') {
      itemId = key.kind === 'conv' ? `tango:${conversation.conversation_key}` : `discord:thread:${key.id}`;
      this.core.ensureItem({ ...base, id: itemId, kind: 'thread', threadId: key.kind === 'conv' ? undefined : key.id, place: conversation.title || this.core.store.item(itemId)?.place || 'thread' }, author);
    } else {
      const relay = author === 'owner' ? this.core.relayTarget(conversation.conversation_key) : null;
      const latest = this.core.store.latestInConversation(conversation.conversation_key);
      itemId = relay ?? (latest && joinsChapter(latest, author, at, this.core.attention(latest.id), this.core.chapterGapMs) ? latest.id : `discord:chapter:${key.id}:${ids[0] ?? `tango-${post.id}`}`);
      this.core.ensureItem({ ...base, id: itemId, kind: 'chapter', place: null }, author);
    }
    if (!this.core.recordMessage(itemId, { messageId, author, at, text, attachments })) return;
    if (author === 'owner' && !parseMailHeader(text)) this.core.settle(itemId, { ownerPostedAt: at });
    else this.core.settle(itemId, { activity: { what: 'message', at, text, attachments: attachments.length } });
  }
}
