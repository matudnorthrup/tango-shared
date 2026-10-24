import { isSystemNotice, messageAuthor, messageText, snowflakeTime, type DiscordMessage, type DiscordRest } from './discord.js';
import type { InboxRules } from './inbox-rules.js';
import { OPEN_STATES, type InboxItem, type InboxState, type InboxStore } from './inbox-store.js';
import { asksOwner, textSummary, type Summarizer } from './inbox-summarize.js';
import { fallbackTopic, type TopicAssigner, type TopicCandidate } from './inbox-topics.js';

// The inbox engine: reads every owner agent's home channel (its chat) and the
// active threads under it, and keeps one inbox item per TOPIC.
//
//   thread  a thread is a topic: a project that runs until the owner closes it
//   topic   in a chat, a run of back-and-forth about one subject ("Food
//           tracking", "Bike turn signal"). An agent's answer goes to the
//           topic the owner asked in; "thanks" goes to what it thanks; anything
//           else is filed by the topic assigner (continue an open topic, or
//           start a new one). Chat topics settle on their own once they go quiet
//           past the end of their day; threads never do.
//   task    an item the voice operator filed before Discord had the message
//
// Done closes a topic (✅ on the agent's last message; a thread is archived).

export interface InboxAgent {
  id: string;
  name: string;
  homeChannelId: string;
  /** The agent's picture, as Discord shows it (desk/agents.ts). */
  avatar?: { url?: string | null; file?: string | null } | null;
}

export interface InboxEngineOptions {
  store: InboxStore;
  discord: DiscordRest | null;
  agents: InboxAgent[];
  ownerIds: string[];
  rules: InboxRules;
  summarize: Summarizer;
  /** Files chat messages into topics (default: continue the last topic if recent, else new). */
  assignTopic?: TopicAssigner;
  /** How long filing an operator answer waits to read its conversation first (default 3 s). */
  catchUpBudgetMs?: number;
  /** Called with the ids of items that changed. */
  onChange?: (ids: string[]) => void;
  /** Screen relays the owner's taps and replies through the bot; those posts are the owner's words. */
  ownerRelayPrefix?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** On first sight of a conversation, look back this far (default 7 days). */
  backfillMs?: number;
  /** Threads quieter than this are not read (default 30 days). */
  threadMaxAgeMs?: number;
  /** Let messages settle this long before summarizing (default 8 s). */
  summaryDelayMs?: number;
  /** Items from another source (T3 threads): Done goes to it instead of Discord. */
  external?: ExternalSource[];
}

export interface ExternalSource {
  owns(item: Pick<InboxItem, 'id'>): boolean;
  /** Closes the item at its source; true when it did. */
  done(item: InboxItem): Promise<boolean>;
}

export interface Conversation {
  channelId: string;
  agent: InboxAgent;
  /** Thread title; null for the agent's home channel. */
  thread: string | null;
}

const ACK_WORDS = new Set(
  'thanks thank you thx ty tysm much so very sounds good great perfect awesome excellent amazing nice cool sweet got it ok okay k kk will do appreciate appreciated it love that this works noted roger cheers 👍 ✅ 🙏 ❤️ 🙌 lol haha'.split(' '),
);
const LATER_HINT = /\b(later|look (at it|into it|it over)|think (about it|it over)|get back|come back|circle back|review it)\b/i;

/**
 * A short owner reply that only acknowledges an update ("thanks", "sounds good",
 * "perfect, thank you!"): done. With a "later" hint ("thanks, I'll look later"):
 * seen. Anything with real content, or a question, is a reply. Exposed for tests.
 */
export function acknowledgment(text: string): 'done' | 'seen' | null {
  const clean = text.trim();
  if (!clean || clean.length > 80 || clean.includes('?')) return null;
  const words = clean.toLowerCase().replace(/[.,!:;~*_"']+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const known = words.filter((word) => ACK_WORDS.has(word)).length;
  if (known === words.length) return 'done';
  // "thanks, I'll look at it later": an acknowledgment plus a promise to come back.
  if (known >= 1 && LATER_HINT.test(clean) && words.length <= 12) return 'seen';
  return null;
}

/** An agent's short sign-off after the owner wrapped up ("Anytime!") doesn't reopen the item. */
function isSignOff(text: string): boolean {
  return text.length <= 300 && !asksOwner(text);
}

export function isThumbsUp(emoji: string): boolean {
  return emoji.startsWith('👍');
}

/** A chat topic's day ends at 4 am local: late-night food logs still belong to that day. */
export function topicDay(ms: number): string {
  const shifted = new Date(ms - 4 * 3_600_000);
  return `${shifted.getFullYear()}-${shifted.getMonth() + 1}-${shifted.getDate()}`;
}

/** What a real wrap-up sounds like; the model's wraps_up flag also needs these words. */
const WRAP_UP = /\b(that'?s (all|everything|it)( for (now|today))?|all set|done for (today|now|the day)|we'?re (good|done|set)|nothing else|all good)\b/i;

/** Topics that wait on the owner stay this long before settling on their own. */
const WAITING_SETTLE_MS = 3 * 86_400_000;
/** Open chat topics the assigner chooses among: active within this window, at most a handful. */
const CANDIDATE_WINDOW_MS = 3 * 86_400_000;

export class InboxEngine {
  private guildId: string | null = null;
  private inFlight: Promise<{ conversations: number; messages: number }> | null = null;
  /** Placeholder ids folded into another item → that item (the voice side may still use the old id). */
  private readonly folded = new Map<string, string>();

  /** An item id as the caller knows it, following folds. */
  resolveId(id: string): string {
    let current = id;
    for (let hops = 0; hops < 5 && this.folded.has(current) && !this.store.get(current); hops++) current = this.folded.get(current)!;
    return current;
  }
  private readonly pendingSummaries = new Map<string, NodeJS.Timeout>();
  /** Summaries run two at a time: a backfill shouldn't hit the model with fifty at once. */
  private summaryRunning = 0;
  private readonly summaryWaiters: Array<() => void> = [];
  private readonly summaryRetried = new Set<string>();
  /** A reply sent from the screen: the bot's copy of it belongs to the item replied to. */
  private readonly relayTargets = new Map<string, { itemId: string; until: number }>();
  private readonly changed = new Set<string>();
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(private readonly options: InboxEngineOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  get store(): InboxStore {
    return this.options.store;
  }

  agentName(agentId: string): string {
    const base = agentId.replace(/-ollama$/, '');
    return this.options.agents.find((agent) => agent.id === agentId || agent.id === base)?.name ?? base.charAt(0).toUpperCase() + base.slice(1);
  }

  // ── polling ────────────────────────────────────────────────────────────

  async conversations(): Promise<Conversation[]> {
    const { discord, agents } = this.options;
    const list: Conversation[] = agents.map((agent) => ({ channelId: agent.homeChannelId, agent, thread: null }));
    if (!discord || agents.length === 0) return list;
    // The thread list failing (a Discord 503) must not stop the home channels from being read.
    let threads: Awaited<ReturnType<NonNullable<InboxEngineOptions['discord']>['activeThreads']>>;
    try {
      if (!this.guildId) this.guildId = (await discord.channel(agents[0]!.homeChannelId)).guild_id ?? null;
      if (!this.guildId) return list;
      threads = await discord.activeThreads(this.guildId);
    } catch (err) {
      this.log('inbox.threads.error', { message: (err as Error).message });
      return list;
    }
    const byChannel = new Map(agents.map((agent) => [agent.homeChannelId, agent]));
    const cutoff = this.now() - (this.options.threadMaxAgeMs ?? 30 * 86_400_000);
    for (const thread of threads) {
      const agent = byChannel.get(thread.parent_id);
      if (!agent) continue;
      if ((snowflakeTime(thread.last_message_id) || snowflakeTime(thread.id)) < cutoff) continue;
      // Nothing new since we last looked: skip the request.
      const marker = this.store.marker(thread.id);
      if (marker && thread.last_message_id && BigInt(thread.last_message_id) <= BigInt(marker)) continue;
      list.push({ channelId: thread.id, agent, thread: thread.name });
    }
    return list;
  }

  /** One pass over every conversation. Safe to call on a timer; a call during a pass waits for that pass. */
  poll(): Promise<{ conversations: number; messages: number }> {
    if (!this.options.discord) return Promise.resolve({ conversations: 0, messages: 0 });
    if (!this.inFlight) this.inFlight = this.pollOnce().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async pollOnce(): Promise<{ conversations: number; messages: number }> {
    let total = 0;
    let conversations: Conversation[] = [];
    try {
      conversations = await this.conversations();
      for (const conversation of conversations) {
        try {
          total += await this.pollConversation(conversation);
        } catch (err) {
          this.log('inbox.poll.error', { channelId: conversation.channelId, message: (err as Error).message });
        }
      }
    } catch (err) {
      this.log('inbox.poll.error', { message: (err as Error).message });
    } finally {
      this.flush();
    }
    return { conversations: conversations.length, messages: total };
  }

  private async pollConversation(conversation: Conversation): Promise<number> {
    const discord = this.options.discord!;
    const marker = this.store.marker(conversation.channelId);
    let messages: DiscordMessage[];
    if (marker) {
      messages = await discord.messages(conversation.channelId, { after: marker });
    } else {
      // Home channels go back a week; a thread is read back as far as it is still listed.
      const lookBack = conversation.thread !== null ? (this.options.threadMaxAgeMs ?? 30 * 86_400_000) : (this.options.backfillMs ?? 7 * 86_400_000);
      messages = await discord.messagesSince(conversation.channelId, this.now() - lookBack);
    }
    for (const message of messages) await this.ingest(conversation, message);
    await this.readOwnerReactions(conversation.channelId, messages);
    const last = messages.at(-1)?.id;
    if (last) this.store.setMarker(conversation.channelId, last);
    else if (!marker) this.store.setMarker(conversation.channelId, (await discord.channel(conversation.channelId)).last_message_id ?? '0');
    return messages.length;
  }

  // ── grouping ───────────────────────────────────────────────────────────

  authorOf(message: DiscordMessage): 'agent' | 'owner' | 'other' {
    const prefix = this.options.ownerRelayPrefix ?? '🖥️';
    if ((message.webhook_id || message.author.bot) && message.content.startsWith(prefix)) return 'owner';
    return messageAuthor(message, this.options.ownerIds);
  }

  /** Files one Discord message into the inbox. Exposed for tests. */
  async ingest(conversation: Conversation, message: DiscordMessage): Promise<void> {
    // System notices ("thread created", pins) carry the thread name, not anyone's words.
    if (message.type !== undefined && message.type !== 0 && message.type !== 19) return;
    const author = this.authorOf(message);
    if (author === 'other') return;
    const text = messageText(message);
    if (author === 'agent' && (!text || isSystemNotice(text))) return;
    const at = snowflakeTime(message.id);
    const known = this.store.itemForMessage(message.id);
    // Seen before (a rebuild or an overlapping page): nothing new to file.
    if (known && this.store.hasMessageText(message.id)) return;
    let itemId: string;
    let wrapsUp = false;

    const placeholder = known ? this.store.get(known) : null;
    const isPlaceholder =
      known !== null &&
      placeholder?.kind === 'task' &&
      !this.store.messages(known, 50).some((row) => row.author === 'owner' || (row.text !== '' && row.messageId !== message.id));
    // The operator filed this answer before Discord's copy arrived, in a placeholder of its own,
    // while the owner's ask it answers was filed elsewhere: the answer joins its conversation (a
    // thread) or its ask (a chat topic), and the placeholder folds in. What the owner already did
    // with the placeholder (heard it by voice) carries over.
    const foldInto =
      isPlaceholder && conversation.thread !== null && this.store.get(`thread:${conversation.channelId}`)
        ? this.store.get(`thread:${conversation.channelId}`)
        : isPlaceholder && conversation.thread === null
          ? this.askAwaitingAnswer(conversation.channelId, known!, at)
          : null;
    let carry: { state: InboxState; note: string | null; acked: boolean } | null = null;
    if (known && foldInto) {
      this.store.removeMessage(message.id);
      itemId = foldInto.id;
      if (placeholder!.taskId) this.store.update(itemId, { taskId: placeholder!.taskId });
      if (placeholder!.state !== 'queued' || placeholder!.acked) carry = { state: placeholder!.state, note: placeholder!.note ?? null, acked: placeholder!.acked };
      this.store.mergeInto(known, itemId);
      // The voice side may still act on the placeholder's id (mark it heard): it now means this item.
      this.folded.set(known, itemId);
      this.changed.add(known);
    } else if (known) {
      itemId = known;
      this.store.fillMessageText(message.id, text);
    } else if (conversation.thread !== null) {
      itemId = `thread:${conversation.channelId}`;
      if (!this.store.get(itemId)) {
        this.store.create({
          id: itemId,
          kind: 'thread',
          agentId: conversation.agent.id,
          agentName: conversation.agent.name,
          channelId: conversation.channelId,
          place: conversation.thread,
          state: author === 'owner' ? 'read' : 'queued',
          ...(author === 'owner' ? { note: 'replied' } : {}),
          createdAt: at,
          lastActivityAt: at,
          status: author === 'owner' ? 'in_progress' : 'done',
        });
      } else {
        this.store.update(itemId, { place: conversation.thread });
      }
    } else {
      const filed = await this.chatTopicFor(conversation, author, text, at, message.id);
      itemId = filed.itemId;
      wrapsUp = filed.wrapsUp;
    }

    this.store.addMessage({ messageId: message.id, itemId, channelId: conversation.channelId, author, at, text });
    if (author === 'owner') {
      const item = this.store.get(itemId)!;
      // "Thanks" / "sounds good" on an update wraps it up. On a question it is the answer.
      const ack = item.status !== 'needs_you' && item.lastAgentMessageId ? (acknowledgment(text) ?? (wrapsUp && WRAP_UP.test(text) ? 'done' : null)) : null;
      if (ack === 'done') {
        if (item.state !== 'later') this.store.mark(itemId, 'read', 'acknowledged');
        this.store.update(itemId, { lastActivityAt: Math.max(item.lastActivityAt, at) });
      } else if (ack === 'seen') {
        this.store.ack(itemId);
        this.store.update(itemId, { lastActivityAt: Math.max(item.lastActivityAt, at) });
      } else {
        if (OPEN_STATES.includes(item.state) && item.state !== 'later') this.store.mark(itemId, 'read', 'replied');
        // While the agent works, the line is what the owner asked; the agent's answer replaces it.
        this.store.update(itemId, {
          status: 'in_progress',
          lastActivityAt: Math.max(item.lastActivityAt, at),
          ...(text ? { summary: textSummary(text, 140), summarySource: 'request' as const } : {}),
        });
      }
    } else {
      const item = this.store.get(itemId)!;
      // Only right after the owner's own "thanks": the message before this one is theirs.
      const previous = this.store.messages(itemId, 2)[0];
      const justThanked = previous?.author === 'owner' && previous.messageId !== message.id && acknowledgment(previous.text) !== null;
      const wrappedUp = (item.state === 'read' && item.note === 'acknowledged') || (item.acked && item.note === 'seen');
      if (wrappedUp && justThanked && isSignOff(text)) {
        // The owner said thanks and the agent said "anytime": nothing new to look at.
        this.changed.add(itemId);
        return;
      }
      this.store.update(itemId, {
        lastText: text,
        lastAgentMessageId: message.id,
        lastActivityAt: at,
        status: asksOwner(text) ? 'needs_you' : 'done',
      });
      // A message posted before the owner closed the item (done or dismissed: the poll reads
      // Discord a little behind) is one they'd already seen when they decided; only a newer one
      // reopens it. (Marks made while filing, like "replied" or "thanks", carry the filing time,
      // not the message's, so they don't count; "later" is kept by reopen anyway.)
      const decidedAfter = (item.state === 'dismissed' || (item.state === 'read' && (item.note ?? '').startsWith('done'))) && at <= item.stateAt;
      if (!decidedAfter) this.store.reopen(itemId);
      if (carry) {
        if (carry.state !== 'queued') this.store.mark(itemId, carry.state, carry.note ?? undefined);
        if (carry.acked) this.store.ack(itemId);
      }
      this.scheduleSummary(itemId);
    }
    this.changed.add(itemId);
  }

  /** Which chat topic a message belongs to; creates one if it starts something new. */
  private async chatTopicFor(
    conversation: Conversation,
    author: 'agent' | 'owner',
    text: string,
    at: number,
    messageId: string,
  ): Promise<{ itemId: string; wrapsUp: boolean }> {
    const { agent, channelId } = conversation;
    const relay = this.relayTargets.get(channelId);
    if (author === 'owner' && relay && relay.until > this.now() && this.store.get(relay.itemId)) {
      this.relayTargets.delete(channelId);
      return { itemId: relay.itemId, wrapsUp: false };
    }
    const latest = this.store.latestInChannel(channelId, ['topic', 'task']);
    const latestAuthor = latest ? this.store.messages(latest.id, 1)[0]?.author : undefined;
    if (latest) {
      // The agent answers what the owner just asked.
      if (author === 'agent' && latestAuthor === 'owner') return { itemId: latest.id, wrapsUp: false };
      // A long reply arrives as several messages seconds apart: the rest of it goes where it started.
      // (Separate updates, like a scheduled report and then a question, come further apart than this.)
      if (author === 'agent' && latestAuthor === 'agent' && at - latest.lastActivityAt < 15_000) return { itemId: latest.id, wrapsUp: false };
      // The owner still typing (a burst of messages) is one ask.
      if (author === 'owner' && latestAuthor === 'owner' && at - latest.lastActivityAt < 10 * 60_000) return { itemId: latest.id, wrapsUp: false };
      // "Thanks" belongs to what it thanks.
      if (author === 'owner' && latestAuthor === 'agent' && acknowledgment(text)) return { itemId: latest.id, wrapsUp: false };
    }
    const candidates = this.chatCandidates(channelId, at);
    // Always ask: even with nothing to continue, a new topic needs a real title.
    const decision = await (this.options.assignTopic ?? (async (input) => fallbackTopic(input)))({ agentName: agent.name, message: { author, text, at }, candidates });
    this.log('inbox.file', { agent: agent.id, author, candidates: candidates.map((candidate) => candidate.title), topic: decision.topicId, title: decision.title, wrapsUp: decision.wrapsUp, source: decision.source });
    if (decision.topicId) return { itemId: decision.topicId, wrapsUp: decision.wrapsUp };
    const id = `topic:${channelId}:${messageId}`;
    this.store.create({
      id,
      kind: 'topic',
      agentId: agent.id,
      agentName: agent.name,
      channelId,
      place: decision.title,
      state: author === 'owner' ? 'read' : 'queued',
      ...(author === 'owner' ? { note: 'replied' } : {}),
      status: author === 'owner' ? 'in_progress' : 'done',
      createdAt: at,
      lastActivityAt: at,
    });
    this.log('inbox.topic', { id, agent: agent.id, title: decision.title, source: decision.source });
    return { itemId: id, wrapsUp: false };
  }

  /**
   * The agent's chat topics a message could continue, most recent first: those in
   * play, plus ones closed in the last few hours (a follow-up reopens them).
   * Settled and dismissed topics are left alone.
   */
  private chatCandidates(channelId: string, at: number): TopicCandidate[] {
    return this.store
      .list({ sinceMs: at - CANDIDATE_WINDOW_MS })
      .filter((item) => item.channelId === channelId && (item.kind === 'topic' || item.kind === 'task'))
      // A topic whose day ended before this message would have settled (same rule as settleQuiet,
      // judged at the message's time so a rebuild replays history the way it happened live).
      .filter((item) => topicDay(item.lastActivityAt) === topicDay(at) || (item.status === 'needs_you' && !item.acked && at - item.lastActivityAt < WAITING_SETTLE_MS))
      .filter(
        (item) =>
          item.state === 'queued' ||
          item.state === 'heard' ||
          item.state === 'later' ||
          (item.state === 'read' && item.note !== 'settled' && (item.note === 'replied' || item.note === null || at - item.lastActivityAt < 6 * 3_600_000)),
      )
      .slice(0, 10)
      .map((item) => ({
        id: item.id,
        title: item.place ?? item.summary,
        standing: item.summary,
        lastActivityAt: item.lastActivityAt,
        recent: this.store.messages(item.id, 2).map((message) => ({ author: message.author, text: message.text })),
      }));
  }

  // ── settling ───────────────────────────────────────────────────────────

  /**
   * Chat topics settle on their own: once their last activity is from a previous
   * day (and nothing waits on the owner), or after three quiet days when
   * something does. Threads are projects and never settle on their own.
   */
  settleQuiet(): string[] {
    const now = this.now();
    const today = topicDay(now);
    const settled: string[] = [];
    for (const item of this.store.list({ states: ['queued', 'heard', 'read'] })) {
      if (item.kind !== 'topic' && item.kind !== 'task') continue;
      if (item.state === 'read' && item.note !== 'replied' && item.note !== null) continue; // already finished
      const waiting = item.status === 'needs_you' && !item.acked;
      const quietEnough = waiting ? now - item.lastActivityAt >= WAITING_SETTLE_MS : topicDay(item.lastActivityAt) !== today;
      if (!quietEnough) continue;
      this.store.mark(item.id, 'read', 'settled');
      this.changed.add(item.id);
      settled.push(item.id);
    }
    if (settled.length) this.log('inbox.settled', { count: settled.length });
    this.flush();
    return settled;
  }

  // ── corrections ────────────────────────────────────────────────────────

  /** Moves one topic's messages into another of the same agent's ("these are the same thing"). */
  merge(fromId: string, intoId: string): InboxItem | null {
    const from = this.store.get(fromId);
    const into = this.store.get(intoId);
    if (!from || !into || from.agentId !== into.agentId || fromId === intoId) return null;
    this.store.mergeInto(fromId, intoId);
    this.changed.add(fromId);
    this.changed.add(intoId);
    this.scheduleSummary(intoId);
    this.flush();
    return this.store.get(intoId);
  }

  /** Starts a new topic at a message ("this part is something else"): it and everything after move over. */
  split(itemId: string, messageId: string): InboxItem | null {
    const item = this.store.get(itemId);
    if (!item || item.kind === 'thread') return null;
    const first = this.store.messages(itemId, 500).find((message) => message.messageId === messageId);
    if (!first) return null;
    const newId = `topic:${item.channelId}:${messageId}`;
    this.store.create({
      id: newId,
      kind: 'topic',
      agentId: item.agentId,
      agentName: item.agentName,
      channelId: item.channelId,
      place: textSummary(first.text, 48),
      createdAt: first.at,
      lastActivityAt: first.at,
    });
    this.store.moveMessagesFrom(itemId, newId, first.at);
    for (const id of [itemId, newId]) {
      const messages = this.store.messages(id, 500);
      const lastAgent = [...messages].reverse().find((message) => message.author === 'agent');
      const last = messages.at(-1);
      this.store.update(id, {
        lastText: lastAgent?.text ?? '',
        lastAgentMessageId: lastAgent?.messageId ?? null,
        lastActivityAt: last?.at ?? item.lastActivityAt,
        status: last?.author === 'owner' ? 'in_progress' : lastAgent && asksOwner(lastAgent.text) ? 'needs_you' : 'done',
      });
      this.scheduleSummary(id);
      this.changed.add(id);
    }
    this.flush();
    return this.store.get(newId);
  }

  // ── summaries ──────────────────────────────────────────────────────────

  private scheduleSummary(itemId: string): void {
    const existing = this.pendingSummaries.get(itemId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingSummaries.delete(itemId);
      void this.summarizeNow(itemId);
    }, this.options.summaryDelayMs ?? 8000);
    timer.unref?.();
    this.pendingSummaries.set(itemId, timer);
  }

  private async withSummarySlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.summaryRunning >= 2) await new Promise<void>((resolve) => this.summaryWaiters.push(resolve));
    this.summaryRunning += 1;
    try {
      return await work();
    } finally {
      this.summaryRunning -= 1;
      this.summaryWaiters.shift()?.();
    }
  }

  /** Writes the topic's line: where it stands now. */
  async summarizeNow(itemId: string): Promise<void> {
    await this.withSummarySlot(() => this.summarize(itemId));
  }

  private async summarize(itemId: string): Promise<void> {
    const item = this.store.get(itemId);
    if (!item) return;
    const messages = this.store.messages(itemId, 6).filter((message) => message.text);
    if (messages.length === 0 && !item.lastText) return;
    const result = await this.options.summarize({
      agentName: item.agentName,
      place: item.place,
      messages: messages.length ? messages : [{ author: 'agent', text: item.lastText }],
    });
    // The model call took a while: if anything happened meanwhile (the owner replied, the agent
    // answered), this summary is stale and its status guess must not overwrite theirs; the new
    // activity scheduled a summary of its own.
    const fresh = this.store.get(itemId);
    if (!fresh || fresh.lastActivityAt !== item.lastActivityAt || fresh.status !== item.status) {
      this.changed.add(itemId);
      return;
    }
    const status = item.status === 'in_progress' ? 'in_progress' : result.needsYou ? 'needs_you' : 'done';
    this.store.update(itemId, { summary: result.summary, summarySource: result.source, status });
    // The model was busy or down: try once more in a minute.
    if (result.source === 'text' && !this.summaryRetried.has(itemId)) {
      this.summaryRetried.add(itemId);
      const timer = setTimeout(() => void this.summarizeNow(itemId), 60_000);
      timer.unref?.();
      this.pendingSummaries.set(itemId, timer);
    } else if (result.source === 'model') {
      this.summaryRetried.delete(itemId);
    }
    this.changed.add(itemId);
    this.flush();
  }

  // ── read signals ───────────────────────────────────────────────────────

  /**
   * The owner's own reaction in Discord: 👍 means "seen, I'll come back to it";
   * anything else (✅, ❤️, …) means it's handled.
   */
  private applyOwnerReaction(item: InboxItem, emojis: string[]): void {
    if (emojis.some((emoji) => !isThumbsUp(emoji))) {
      this.store.mark(item.id, 'read', 'reacted');
      this.changed.add(item.id);
    } else if (emojis.length && !item.acked) {
      this.store.ack(item.id);
      this.changed.add(item.id);
    }
  }

  /** Reactions the owner already left in Discord, seen while reading messages, mark their items read. */
  private async readOwnerReactions(channelId: string, messages: DiscordMessage[]): Promise<void> {
    const discord = this.options.discord;
    if (!discord) return;
    for (const message of messages) {
      const reactions = (message.reactions ?? []).filter((reaction) => reaction.count > (reaction.me ? 1 : 0));
      if (reactions.length === 0) continue;
      const itemId = this.store.itemForMessage(message.id);
      const item = itemId ? this.store.get(itemId) : null;
      if (!item || item.lastAgentMessageId !== message.id || !OPEN_STATES.includes(item.state) || item.state === 'later') continue;
      this.applyOwnerReaction(item, await this.ownerEmojis(channelId, message.id, reactions, item.id));
    }
  }

  private async ownerEmojis(channelId: string, messageId: string, reactions: NonNullable<DiscordMessage['reactions']>, itemId: string): Promise<string[]> {
    const emojis: string[] = [];
    for (const reaction of reactions) {
      if (reaction.count <= (reaction.me ? 1 : 0)) continue;
      try {
        const users = await this.options.discord!.reactionUsers(channelId, messageId, reaction.emoji);
        if (users.some((user) => this.options.ownerIds.length === 0 || this.options.ownerIds.includes(user))) emojis.push(reaction.emoji.name);
      } catch (err) {
        this.log('inbox.reactions.error', { itemId, message: (err as Error).message });
      }
    }
    return emojis;
  }

  /** Owner reactions on the latest agent message of open items mark them read. */
  async checkReactions(limit = 25): Promise<void> {
    const discord = this.options.discord;
    if (!discord) return;
    const open = this.store
      .list({ states: ['queued', 'heard', 'later'], sinceMs: this.now() - 3 * 86_400_000 })
      .filter((item) => item.channelId && item.lastAgentMessageId && !this.externalFor(item))
      .slice(0, limit);
    for (const item of open) {
      try {
        const message = await discord.message(item.channelId!, item.lastAgentMessageId!);
        this.applyOwnerReaction(item, await this.ownerEmojis(item.channelId!, message.id, message.reactions ?? [], item.id));
      } catch (err) {
        this.log('inbox.reactions.error', { itemId: item.id, message: (err as Error).message });
      }
    }
    this.flush();
  }

  // ── operator and screen actions ────────────────────────────────────────

  /** An item the voice operator produced (a relayed result), merged with Discord's copy when the message ids match. */
  addFromOperator(input: {
    agentId: string;
    agentName?: string;
    channelId?: string;
    messageIds?: string[];
    taskId?: string;
    summary: string;
    fullText?: string;
    kind?: 'result' | 'question' | 'notice';
  }): InboxItem {
    const messageIds = input.messageIds ?? [];
    const existing = messageIds.map((id) => this.store.itemForMessage(id)).find((id): id is string => Boolean(id));
    const status = input.kind === 'question' || asksOwner(input.fullText ?? input.summary) ? 'needs_you' : 'done';
    let itemId: string;
    if (existing) {
      itemId = existing;
      this.store.update(itemId, { taskId: input.taskId ?? null });
    } else {
      // Discord's copy hasn't arrived yet: it answers the conversation the owner asked in.
      const asked = input.channelId ? this.awaitingAnswer(input.channelId) : null;
      itemId = asked?.id ?? (input.taskId ? `task:${input.taskId}` : `task:${input.agentId}:${this.now()}`);
      if (asked) {
        this.store.update(itemId, { lastText: input.fullText ?? input.summary, status, lastActivityAt: this.now() });
        this.store.reopen(itemId);
      } else if (!this.store.get(itemId)) {
        this.store.create({
          id: itemId,
          kind: 'task',
          agentId: input.agentId,
          agentName: input.agentName ?? this.agentName(input.agentId),
          channelId: input.channelId ?? null,
          taskId: input.taskId ?? null,
          summary: textSummary(input.summary),
          lastText: input.fullText ?? input.summary,
          status,
        });
      } else {
        this.store.update(itemId, { lastText: input.fullText ?? input.summary, status, lastActivityAt: this.now() });
        this.store.reopen(itemId);
      }
      for (const messageId of messageIds) {
        this.store.addMessage({ messageId, itemId, channelId: input.channelId ?? '', author: 'agent', at: snowflakeTime(messageId) || this.now(), text: '' });
      }
      if (messageIds.length) this.store.update(itemId, { lastAgentMessageId: messageIds.at(-1)! });
      this.scheduleSummary(itemId);
    }
    this.changed.add(itemId);
    this.flush();
    return this.store.get(itemId)!;
  }

  /**
   * The operator relays an answer it got by voice. Discord's copy (and the user's message before
   * it) usually hasn't been read yet: read that conversation first, so both are filed in order and
   * the answer lands with its ask instead of in a placeholder of its own.
   */
  async addFromOperatorInOrder(input: Parameters<InboxEngine['addFromOperator']>[0]): Promise<InboxItem> {
    const ids = input.messageIds ?? [];
    if (ids.length && input.channelId && this.options.discord && !ids.some((id) => this.store.itemForMessage(id))) {
      // Bounded: the operator's request times out after a few seconds. A slower catch-up keeps
      // going in the background, and a placeholder that wins meanwhile is folded in on ingest.
      const caughtUp = this.catchUp(input.channelId).catch((err) => this.log('inbox.catchup.error', { channelId: input.channelId, message: (err as Error).message }));
      await Promise.race([caughtUp, new Promise((resolve) => setTimeout(resolve, this.options.catchUpBudgetMs ?? 3000).unref?.())]);
    }
    return this.addFromOperator(input);
  }

  /**
   * Self-check and repair, run at startup and every few minutes. Fixes what earlier races left
   * behind, so the inbox converges on Discord instead of carrying mistakes forever:
   * - agent messages stored without text get it from Discord (or go, if deleted there);
   * - a placeholder task holding an answer folds into the ask it answers;
   * - an item "in progress" whose agent already answered shows that answer.
   */
  async repair(options: { sinceMs?: number } = {}): Promise<{ filled: number; removed: number; folded: number; settled: number }> {
    const counts = { filled: 0, removed: 0, folded: 0, settled: 0 };
    const discord = this.options.discord;
    if (discord) {
      for (const row of this.store.emptyAgentMessages(100)) {
        if (row.channelId.startsWith('t3:')) continue;
        try {
          const text = messageText(await discord.message(row.channelId, row.messageId));
          if (text) {
            this.store.fillMessageText(row.messageId, text);
            this.changed.add(row.itemId);
            counts.filled += 1;
          }
        } catch (err) {
          if (/HTTP 404/.test((err as Error).message)) {
            this.store.removeMessage(row.messageId);
            this.changed.add(row.itemId);
            counts.removed += 1;
          }
        }
      }
    }
    const recent = this.store.list({ sinceMs: options.sinceMs ?? this.now() - 2 * 86_400_000 });
    for (const item of recent) {
      if (item.kind !== 'task' || !item.channelId || item.channelId.startsWith('t3:') || !this.store.get(item.id)) continue;
      const rows = this.store.messages(item.id, 50);
      // Not while any of its answer is still unread from Discord: folding would settle on a fragment.
      if (rows.length === 0 || rows.some((row) => row.author === 'owner' || row.text === '')) continue;
      const asked = this.askAwaitingAnswer(item.channelId, item.id, rows[0]!.at);
      if (!asked) continue;
      if (item.taskId) this.store.update(asked.id, { taskId: item.taskId });
      this.store.mergeInto(item.id, asked.id);
      this.folded.set(item.id, asked.id);
      this.settleFromMessages(asked.id);
      // The placeholder stands for the answer: whatever the owner already did with it (heard it by
      // voice, 👍, later) still holds, so folding doesn't re-announce it. The ask's own state (read
      // because the owner wrote it) doesn't: the answer is news to them.
      if (item.state !== 'queued') this.store.mark(asked.id, item.state, item.note ?? undefined);
      if (item.acked) this.store.ack(asked.id);
      this.changed.add(item.id);
      counts.folded += 1;
    }
    for (const item of this.store.list({ sinceMs: options.sinceMs ?? this.now() - 2 * 86_400_000 })) {
      if (item.status !== 'in_progress' || item.kind === 'thread' && item.id.startsWith('t3:')) continue;
      if (this.settleFromMessages(item.id)) counts.settled += 1;
    }
    if (counts.filled || counts.removed || counts.folded || counts.settled) this.log('inbox.repair', counts);
    this.flush();
    return counts;
  }

  /** When an item's last real message is the agent's, its status and line come from that answer. */
  private settleFromMessages(itemId: string): boolean {
    const item = this.store.get(itemId);
    const last = item ? this.store.messages(itemId, 50).filter((row) => row.text !== '').at(-1) : undefined;
    if (!item || last?.author !== 'agent') return false;
    this.store.update(itemId, {
      status: asksOwner(last.text) ? 'needs_you' : 'done',
      lastText: last.text,
      lastAgentMessageId: last.messageId,
      lastActivityAt: Math.max(item.lastActivityAt, last.at),
    });
    // A recovered answer is news: back in Active (reopen keeps a deliberate "later" parked).
    this.store.reopen(itemId);
    this.scheduleSummary(itemId);
    this.changed.add(itemId);
    return true;
  }

  /** Reads one conversation now, in turn with the regular poll. */
  private async catchUp(channelId: string): Promise<void> {
    const home = this.options.agents.find((agent) => agent.homeChannelId === channelId);
    let conversation: Conversation | null = home ? { channelId, agent: home, thread: null } : null;
    if (!conversation) {
      const channel = (await this.options.discord!.channel(channelId)) as { parent_id?: string; name?: string };
      const parent = this.options.agents.find((agent) => agent.homeChannelId === channel.parent_id);
      if (!parent) return;
      conversation = { channelId, agent: parent, thread: channel.name ?? 'thread' };
    }
    // After every await above: a poll may have started meanwhile. Nothing yields between this
    // check and taking the lock.
    while (this.inFlight) await this.inFlight.catch(() => undefined);
    // Never rejects: a scheduled poll that waits on this promise must not inherit a catch-up's error.
    const run = (async () => {
      try {
        return { conversations: 1, messages: await this.pollConversation(conversation) };
      } catch (err) {
        this.log('inbox.catchup.error', { channelId, message: (err as Error).message });
        return { conversations: 1, messages: 0 };
      } finally {
        this.flush();
      }
    })();
    this.inFlight = run.finally(() => (this.inFlight = null));
    await this.inFlight;
  }

  /** The newest chat topic or task (other than `except`) whose last word, before `before`, is the owner's. */
  private askAwaitingAnswer(channelId: string, except: string, before: number): InboxItem | null {
    // Ordered by their last real message before `before`: other placeholders (operator copies
    // with no text, stamped with wall-clock time) neither count nor qualify.
    const candidates = this.store
      .list({ sinceMs: before - 6 * 3_600_000 })
      .filter((item) => item.id !== except && item.channelId === channelId && (item.kind === 'topic' || item.kind === 'task'))
      .map((item) => ({ item, last: this.store.messages(item.id, 50).filter((row) => row.at <= before && row.text !== '').at(-1) }))
      .filter((entry) => entry.last !== undefined)
      .sort((a, b) => b.last!.at - a.last!.at);
    const latest = candidates[0];
    return latest?.last?.author === 'owner' ? latest.item : null;
  }

  /** The thread, or the chat topic whose last word is the owner's, that an answer in this channel belongs to. */
  private awaitingAnswer(channelId: string): InboxItem | null {
    const thread = this.store.get(`thread:${channelId}`);
    if (thread) return thread;
    const topic = this.store.latestInChannel(channelId, ['topic', 'task']);
    return topic && this.store.messages(topic.id, 1)[0]?.author === 'owner' ? topic : null;
  }

  /** 👍 from the screen or voice: seen, and the owner will come back to it. */
  ack(itemId: string): InboxItem | null {
    const item = this.store.ack(itemId);
    if (item) {
      this.changed.add(itemId);
      this.flush();
    }
    return item;
  }

  mark(itemId: string, state: InboxState, note?: string): InboxItem | null {
    const item = this.store.mark(itemId, state, note);
    if (item) {
      this.changed.add(itemId);
      this.flush();
    }
    return item;
  }

  /**
   * Done: the owner has dealt with it. Discord gets a ✅ on the agent's latest
   * message, and a thread is archived so it leaves the sidebar (it reopens on the
   * next message), so Discord shows where things stand.
   */
  async done(itemId: string, options: { archive?: boolean } = {}): Promise<{ item: InboxItem | null; reacted: boolean; archived: boolean }> {
    const item = this.store.get(itemId);
    if (!item) return { item: null, reacted: false, archived: false };
    const external = this.externalFor(item);
    if (external) {
      const closed = await external.done(item);
      this.store.mark(itemId, 'read', closed ? 'done, thread closed' : 'done');
      this.changed.add(itemId);
      this.flush();
      return { item: this.store.get(itemId), reacted: false, archived: closed };
    }
    const discord = this.options.discord;
    let reacted = false;
    let archived = false;
    if (discord && item.channelId && item.lastAgentMessageId) {
      try {
        await discord.react(item.channelId, item.lastAgentMessageId, '✅');
        reacted = true;
      } catch (err) {
        this.log('inbox.done.react.error', { itemId, message: (err as Error).message });
      }
    }
    if (discord && item.kind === 'thread' && item.channelId && options.archive !== false) {
      try {
        await discord.archiveThread(item.channelId);
        archived = true;
      } catch (err) {
        this.log('inbox.done.archive.error', { itemId, message: (err as Error).message });
      }
    }
    this.store.mark(itemId, 'read', archived ? 'done, thread closed' : 'done');
    this.changed.add(itemId);
    this.flush();
    return { item: this.store.get(itemId), reacted, archived };
  }

  /**
   * Starts over: forget every item and marker, then read Discord again from scratch.
   * The owner's decisions (later, done, dismissed, seen) carry over to whichever new
   * item holds the same agent message, unless that item has moved on since.
   */
  async rebuild(): Promise<{ conversations: number; messages: number; kept: number }> {
    await this.inFlight?.catch(() => undefined);
    this.close();
    const decisions = this.store
      .list()
      .filter((item) => item.lastAgentMessageId && (item.state === 'later' || item.state === 'dismissed' || item.acked || (item.state === 'read' && item.note !== 'replied' && item.note !== 'settled')))
      .map((item) => ({ messageId: item.lastAgentMessageId!, state: item.state, note: item.note, acked: item.acked }));
    this.store.clear();
    this.options.onChange?.([]);
    const result = await this.poll();
    let kept = 0;
    for (const decision of decisions) {
      const itemId = this.store.itemForMessage(decision.messageId);
      const item = itemId ? this.store.get(itemId) : null;
      if (!item || item.lastAgentMessageId !== decision.messageId) continue;
      if (decision.acked) this.store.ack(item.id);
      else this.store.mark(item.id, decision.state, decision.note ?? undefined);
      kept += 1;
    }
    this.settleQuiet();
    this.options.onChange?.([]);
    return { ...result, kept };
  }

  /** The owner answered from the screen: the item is read and the agent is working again. */
  replied(itemId: string): void {
    const item = this.store.get(itemId);
    if (item?.channelId) this.relayTargets.set(item.channelId, { itemId, until: this.now() + 10 * 60_000 });
    this.store.mark(itemId, 'read', 'replied');
    this.store.update(itemId, { status: 'in_progress', lastActivityAt: this.now() });
    this.changed.add(itemId);
    this.flush();
  }

  private externalFor(item: Pick<InboxItem, 'id'>): ExternalSource | null {
    return this.options.external?.find((source) => source.owns(item)) ?? null;
  }

  /** Drops pending summary work (shutdown, tests). */
  close(): void {
    for (const timer of this.pendingSummaries.values()) clearTimeout(timer);
    this.pendingSummaries.clear();
  }

  private flush(): void {
    if (this.changed.size === 0) return;
    const ids = [...this.changed];
    this.changed.clear();
    this.options.onChange?.(ids);
  }
}
