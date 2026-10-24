import { joinsChapter } from './chapters.js';
import { isImageAttachment, isSystemNotice, messageAuthor, messageText, snowflakeTime, THREAD_ARCHIVED, type DiscordError, type DiscordMessage, type DiscordRest, type DiscordThread } from '../discord.js';
import type { InboxAgent } from '../inbox.js';
import type { MessageAttachment, StartAttachment } from './attachments.js';
import type { DeskCore, DeskSourceAdapter } from './core.js';
import type { Author, DeskItemRow, Log } from './types.js';
import { parseMailHeader } from './mail.js';

// Discord as a desk source. Reads every owner agent's home channel and the
// active threads under it:
//
//   thread  one item per thread (discord:thread:<id>, conversation thread:<id>)
//   chapter in a home channel, one item per burst of messages, split at
//           30-minute gaps (discord:chapter:<channelId>:<firstMessageId>)
//
//   request in an intake channel (a website form's webhook posts there for an agent), one thread
//           item per request, split like chapters (discord:intake:<channelId>:<firstMessageId>)
//
// No topic model: time alone splits chapters. Owner reactions on an agent's
// latest message are read as 👀/👍 seen, ✅ done, 💤 park, and Done writes ✅
// back (plus archive for a thread).

/** The subset of DiscordRest the source uses (tests pass a fake). */
export type DiscordApi = Pick<DiscordRest, 'messages' | 'messagesSince' | 'message' | 'channel' | 'activeThreads' | 'reactionUsers' | 'react' | 'archiveThread'>;

export interface DeskDiscordOptions {
  core: DeskCore;
  /** Store-driven mode leaves only intake reads here; writebacks and reactions stay. */
  intakeOnly?: boolean;
  onRead?: (key: string, messages: DiscordMessage[], since: number) => void;
  needsSnapshot?: (key: string) => boolean;
  discord: DiscordApi;
  agents: InboxAgent[];
  /** The owner's Discord accounts; empty means anyone who isn't a bot. */
  ownerIds: string[];
  /** Posts owner input through the bot's /screen/input, which wakes the agent. */
  postToBot: (body: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<string>;
  /** Screen relays the owner's taps and replies through the bot; those posts are the owner's words. */
  ownerRelayPrefix?: string;
  now?: () => number;
  log?: Log;
  /** On first sight of a home channel, look back this far (default 7 days). */
  backfillMs?: number;
  /** Threads quieter than this are not read (default 30 days). */
  threadMaxAgeMs?: number;
  /** Intake channels (the profile's intake-webhooks.yaml): each request there is a thread of its agent. */
  intake?: IntakeChannel[];
}

/** A channel a form's webhook posts requests into for an agent; the people there speak for the requester. */
export interface IntakeChannel {
  channelId: string;
  agentId: string;
  /** What the channel is, for an item with no words yet ("form-intake"). */
  label: string;
  /** The webhooks whose posts are requests (the agent's own reply webhook is not one). */
  webhookIds: string[];
}

interface Conversation {
  channelId: string;
  agent: InboxAgent;
  /** Thread title; null for the agent's home channel or an intake channel. */
  thread: string | null;
  intake?: IntakeChannel;
}

const REACTION_ACTIONS: Record<string, 'seen' | 'done' | 'park'> = { '👀': 'seen', '👍': 'seen', '✅': 'done', '☑️': 'done', '✔️': 'done', '💤': 'park' };

function reactionAction(emoji: string): 'seen' | 'done' | 'park' | null {
  // Skin tones ride along on 👍.
  if (emoji.startsWith('👍')) return 'seen';
  return REACTION_ACTIONS[emoji] ?? null;
}

export class DeskDiscordSource implements DeskSourceAdapter {
  private guildId: string | null = null;
  private inFlight: Promise<{ conversations: number; messages: number; errors?: number }> | null = null;
  private readonly reads = new Map<string, Promise<number>>();
  private readonly refreshes = new Map<string, { run: Promise<number>; reading: boolean; again: boolean }>();
  private readonly catchUps = new Map<string, Promise<number>>();
  private readonly now: () => number;
  private readonly log: Log;

  constructor(private readonly options: DeskDiscordOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  private get core(): DeskCore {
    return this.options.core;
  }


  owns(item: DeskItemRow): boolean {
    return item.source === 'discord';
  }

  // ── polling ────────────────────────────────────────────────────────────

  private async conversations(): Promise<Conversation[]> {
    const { discord, agents } = this.options;
    const list: Conversation[] = (this.options.intakeOnly ? [] : agents).map((agent) => ({ channelId: agent.homeChannelId, agent, thread: null }));
    for (const intake of this.options.intake ?? []) {
      const agent = agents.find((entry) => entry.id === intake.agentId);
      if (agent) list.push({ channelId: intake.channelId, agent, thread: null, intake });
    }
    if (agents.length === 0 || this.options.intakeOnly) return list;
    let threads: DiscordThread[];
    try {
      if (!this.guildId) this.guildId = (await discord.channel(agents[0]!.homeChannelId)).guild_id ?? null;
      if (!this.guildId) return list;
      threads = await discord.activeThreads(this.guildId);
    } catch (err) {
      // The thread list failing must not stop the home channels from being read.
      this.log('desk.discord.threads.error', { message: (err as Error).message });
      return list;
    }
    const byChannel = new Map(agents.map((agent) => [agent.homeChannelId, agent]));
    const cutoff = this.now() - (this.options.threadMaxAgeMs ?? 30 * 86_400_000);
    for (const thread of threads) {
      const agent = byChannel.get(thread.parent_id);
      if (!agent) continue;
      if ((snowflakeTime(thread.last_message_id) || snowflakeTime(thread.id)) < cutoff) continue;
      const marker = this.core.store.marker(`discord:${thread.id}`);
      if (marker && thread.last_message_id && BigInt(thread.last_message_id) <= BigInt(marker) && !this.options.needsSnapshot?.(`thread:${thread.id}`)) {
        // Nothing new; still keep the title current.
        const item = this.core.store.item(`discord:thread:${thread.id}`);
        if (item && item.place !== thread.name) this.core.setFacts(item.id, {}, { place: thread.name });
        continue;
      }
      list.push({ channelId: thread.id, agent, thread: thread.name });
    }
    return list;
  }

  /** One pass over every conversation. A call during a pass waits for that pass. */
  poll(): Promise<{ conversations: number; messages: number; errors?: number }> {
    if (!this.inFlight) this.inFlight = this.pollOnce().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async pollOnce(): Promise<{ conversations: number; messages: number; errors: number }> {
    let total = 0;
    let errors = 0;
    const conversations = await this.conversations().catch((err) => {
      this.log('desk.discord.poll.error', { message: (err as Error).message });
      errors += 1;
      return [] as Conversation[];
    });
    for (const conversation of conversations) {
      try {
        total += await this.pollConversation(conversation);
      } catch (err) {
        errors += 1;
        this.log('desk.discord.poll.error', { channelId: conversation.channelId, message: (err as Error).message });
      }
    }
    this.core.flush();
    return { conversations: conversations.length, messages: total, errors };
  }

  /** A terminal event needs a fetch begun after it, even if an older read is still ingesting. */
  refresh(channelId: string): Promise<number> {
    const pending = this.refreshes.get(channelId);
    if (pending) {
      if (pending.reading) pending.again = true;
      return pending.run;
    }
    const earlier = this.catchUps.get(channelId) ?? this.reads.get(channelId);
    const state = { run: Promise.resolve(0), reading: false, again: false };
    state.run = (async () => {
      // Queue same-tick bursts before starting. While waiting for an older read, all events share
      // one trailing fetch. Events during that fetch request one more, so none join stale results.
      await Promise.resolve();
      if (earlier) await earlier.catch(() => undefined);
      let messages = 0;
      do {
        state.again = false;
        state.reading = true;
        messages += await this.catchUp(channelId);
        state.reading = false;
      } while (state.again);
      return messages;
    })().finally(() => this.refreshes.delete(channelId));
    this.refreshes.set(channelId, state);
    return state.run;
  }

  /** Reads only this conversation; concurrent requests share discovery and the read. */
  catchUp(channelId: string): Promise<number> {
    const pending = this.catchUps.get(channelId);
    if (pending) return pending;
    const run = this.catchUpOnce(channelId).finally(() => this.catchUps.delete(channelId));
    this.catchUps.set(channelId, run);
    return run;
  }

  private async catchUpOnce(channelId: string): Promise<number> {
    if (this.options.intakeOnly && !this.options.intake?.some(entry => entry.channelId === channelId)) return 0;
    const home = this.options.agents.find((agent) => agent.homeChannelId === channelId);
    const intake = this.options.intake?.find((entry) => entry.channelId === channelId);
    const intakeAgent = intake ? this.options.agents.find((agent) => agent.id === intake.agentId) : undefined;
    let conversation: Conversation | null = home ? { channelId, agent: home, thread: null } : intake && intakeAgent ? { channelId, agent: intakeAgent, thread: null, intake } : null;
    if (!conversation) {
      const channel = (await this.options.discord.channel(channelId)) as { parent_id?: string; name?: string };
      const parent = this.options.agents.find((agent) => agent.homeChannelId === channel.parent_id);
      if (!parent) return 0;
      conversation = { channelId, agent: parent, thread: channel.name ?? 'thread' };
    }
    return this.pollConversation(conversation).finally(() => this.core.flush());
  }

  private pollConversation(conversation: Conversation): Promise<number> {
    const pending = this.reads.get(conversation.channelId);
    if (pending) return pending;
    const run = this.readConversation(conversation).finally(() => this.reads.delete(conversation.channelId));
    this.reads.set(conversation.channelId, run);
    return run;
  }

  private async readConversation(conversation: Conversation): Promise<number> {
    const { discord } = this.options;
    const markerKey = `discord:${conversation.channelId}`;
    const marker = this.core.store.marker(markerKey);
    let messages: DiscordMessage[];
    const conversationKey = `${conversation.thread === null ? 'channel' : 'thread'}:${conversation.channelId}`;
    if (marker && (conversation.intake || !this.options.needsSnapshot?.(conversationKey))) {
      messages = await discord.messages(conversation.channelId, { after: marker });
    } else {
      // Home channels go back a week; a thread is read back as far as it is still listed.
      const lookBack = conversation.thread !== null ? (this.options.threadMaxAgeMs ?? 30 * 86_400_000) : (this.options.backfillMs ?? 7 * 86_400_000);
      messages = await discord.messagesSince(conversation.channelId, this.now() - lookBack);
    }
    if (!conversation.intake) this.options.onRead?.(`${conversation.thread === null ? 'channel' : 'thread'}:${conversation.channelId}`, messages,
      this.now() - (conversation.thread !== null ? (this.options.threadMaxAgeMs ?? 30 * 86_400_000) : (this.options.backfillMs ?? 7 * 86_400_000)));
    for (const message of messages) this.ingest(conversation, message);
    await this.readOwnerReactions(conversation.channelId, messages);
    const last = messages.at(-1)?.id;
    if (last) this.core.store.setMarker(markerKey, last);
    else if (!marker) this.core.store.setMarker(markerKey, (await discord.channel(conversation.channelId)).last_message_id ?? '0');
    return messages.length;
  }

  authorOf(message: DiscordMessage, intake?: IntakeChannel): Author {
    const prefix = this.options.ownerRelayPrefix ?? '🖥️';
    // The bot's echo of a screen reply or tap is the owner speaking.
    if ((message.webhook_id || message.author.bot) && message.content.startsWith(prefix)) return 'owner';
    // In an intake channel the form's posts and every person there ask on the owner's side; the agent answers.
    if (intake && (intake.webhookIds.includes(message.webhook_id ?? '') || (!message.webhook_id && !message.author.bot))) return 'owner';
    return messageAuthor(message, this.options.ownerIds);
  }

  /** Who asked, when it wasn't the owner: the form (its webhook's name) or another person in the channel. */
  private requester(message: DiscordMessage, intake?: IntakeChannel): string | null {
    if (!intake || message.content.startsWith(this.options.ownerRelayPrefix ?? '🖥️')) return null;
    if (message.webhook_id) return formSender(message.content) ?? (message.author.username || intake.label);
    if (this.options.ownerIds.includes(message.author.id)) return null;
    return (message.author as { global_name?: string | null }).global_name || message.author.username || null;
  }

  /** Files one message. Exposed for tests. */
  ingest(conversation: Conversation, message: DiscordMessage): string | null {
    // System notices ("thread created", pins) carry the thread name, not anyone's words.
    if (message.type !== undefined && message.type !== 0 && message.type !== 19) return null;
    const author = this.authorOf(message, conversation.intake);
    if (author === 'other') return null;
    const prefix = this.options.ownerRelayPrefix ?? '🖥️';
    let text = messageText(message, { images: false });
    if (author === 'owner' && text.startsWith(prefix)) text = text.slice(prefix.length).trim().replace(LEGACY_REPLY_WRAPPER, '');
    const requester = author === 'owner' ? this.requester(message, conversation.intake) : null;
    if (requester && text) text = `**${requester}:** ${text}`;
    const attachments = discordImages(message);
    if (author === 'agent' && ((!text && !attachments.length) || isSystemNotice(text))) return null;
    if (this.core.store.hasMessage(message.id)) return null;
    const at = snowflakeTime(message.id);
    const { agent } = conversation;
    const base = { source: 'discord' as const, agentId: agent.id, agentName: agent.name, channelId: agent.homeChannelId, createdAt: at };
    let itemId: string;
    if (conversation.thread !== null) {
      itemId = `discord:thread:${conversation.channelId}`;
      this.core.ensureItem({ ...base, id: itemId, kind: 'thread', conversationKey: `thread:${conversation.channelId}`, threadId: conversation.channelId, place: conversation.thread }, author);
    } else {
      const conversationKey = `channel:${conversation.channelId}`;
      const relay = author === 'owner' ? this.core.relayTarget(conversationKey) : null;
      let latest = relay ? null : this.core.store.latestInConversation(conversationKey);
      // In an intake channel every form post is a new request, and nothing joins a request that is done.
      if (latest && conversation.intake && (conversation.intake.webhookIds.includes(message.webhook_id ?? '') || this.core.attention(latest.id).disposition === 'done')) latest = null;
      const formPost = !!conversation.intake && conversation.intake.webhookIds.includes(message.webhook_id ?? '');
      if (relay) itemId = relay;
      else if (latest && joinsChapter(latest, author, at, this.core.attention(latest.id), this.core.chapterGapMs)) itemId = latest.id;
      // In an intake channel only a form post starts a request: anything else is about the open one, however long
      // after (a follow-up past the chapter gap used to start its own request, titled with the follow-up's words).
      else if (latest && conversation.intake && !formPost) itemId = latest.id;
      else if (conversation.intake) {
        // A request: a thread of its agent, named for what was asked. One a follow-up started (the last request was
        // done) has no form line to name it: the summary does (threadTitle), not the follow-up's words.
        itemId = `discord:intake:${conversation.channelId}:${message.id}`;
        const place = formPost ? (requestTitle(messageText(message, { images: false })) || conversation.intake.label).slice(0, 90) : null;
        this.core.ensureItem({ ...base, channelId: conversation.channelId, id: itemId, kind: 'thread', conversationKey, place }, author);
      } else {
        itemId = `discord:chapter:${conversation.channelId}:${message.id}`;
        this.core.ensureItem({ ...base, id: itemId, kind: 'chapter', conversationKey, place: null }, author);
      }
    }
    if (!this.core.recordMessage(itemId, { messageId: message.id, author, at, text, ...(attachments.length ? { attachments } : {}) })) return itemId;
    // Another agent's mail (the bot posts it like a desk reply) isn't the owner engaging.
    if (author === 'owner' && !parseMailHeader(text)) this.core.settle(itemId, { ownerPostedAt: at });
    else this.core.settle(itemId, { activity: { what: 'message', at, text, attachments: attachments.length } });
    return itemId;
  }

  // ── reactions ──────────────────────────────────────────────────────────

  private async ownerEmojis(channelId: string, messageId: string, reactions: NonNullable<DiscordMessage['reactions']>): Promise<string[]> {
    const emojis: string[] = [];
    for (const reaction of reactions) {
      // The bot's own reactions (the desk mirroring a decision) don't count.
      if (reaction.count <= (reaction.me ? 1 : 0)) continue;
      if (!reactionAction(reaction.emoji.name)) continue;
      try {
        const users = await this.options.discord.reactionUsers(channelId, messageId, reaction.emoji);
        if (users.some((user) => this.options.ownerIds.length === 0 || this.options.ownerIds.includes(user))) emojis.push(reaction.emoji.name);
      } catch (err) {
        this.log('desk.discord.reactions.error', { messageId, message: (err as Error).message });
      }
    }
    return emojis;
  }

  /** Applies owner reactions on an item's latest agent message; each (message, emoji) acts once. */
  private applyReactions(itemId: string, messageId: string, emojis: string[]): void {
    for (const emoji of emojis) {
      const key = `reaction:${messageId}:${emoji}`;
      if (this.core.store.marker(key)) continue;
      this.core.store.setMarker(key, String(this.now()));
      const action = reactionAction(emoji);
      const command = action === 'done' ? 'done' : action === 'park' ? 'park' : 'seen';
      // Through the command path so it lands in the log like any decision. Already in Discord: nothing to write back or mirror.
      void this.core.command({ commandId: `discord-reaction:${messageId}:${emoji}`, type: command, itemId, actor: 'owner', args: { fromSource: true, ...(command === 'done' ? { stopJob: false } : {}) } });
    }
  }

  private async readOwnerReactions(channelId: string, messages: DiscordMessage[]): Promise<void> {
    for (const message of messages) {
      const reactions = (message.reactions ?? []).filter((reaction) => reaction.count > (reaction.me ? 1 : 0));
      if (reactions.length === 0) continue;
      const itemId = this.core.store.itemForMessage(message.id);
      const item = itemId ? this.core.store.item(itemId) : null;
      if (!item || item.lastAgentMessageId !== message.id) continue;
      this.applyReactions(item.id, message.id, await this.ownerEmojis(channelId, message.id, reactions));
    }
  }

  /** Re-reads reactions on the latest agent message of items still in play (reactions don't move the cursor). */
  async checkReactions(limit = 25): Promise<void> {
    const open = this.core
      .items()
      .filter((item) => item.source === 'discord' && item.disposition !== 'done' && item.lastAgentMessageId && this.now() - item.lastActivityAt < 3 * 86_400_000)
      .slice(0, limit);
    for (const item of open) {
      const channelId = item.threadId ?? item.channelId!;
      try {
        const message = await this.options.discord.message(channelId, item.lastAgentMessageId!);
        this.applyReactions(item.id, message.id, await this.ownerEmojis(channelId, message.id, message.reactions ?? []));
      } catch (err) {
        this.log('desk.discord.reactions.error', { itemId: item.id, message: (err as Error).message });
      }
    }
  }

  // ── write side ─────────────────────────────────────────────────────────

  async clear(item: DeskItemRow): Promise<{ outcome: 'ok' | 'failed' | 'n/a'; error?: string; steps?: string[] }> {
    return this.done({ ...item, kind: 'chapter' });
  }

  async done(item: DeskItemRow): Promise<{ outcome: 'ok' | 'failed' | 'n/a'; error?: string; steps?: string[] }> {
    const channelId = item.threadId ?? item.channelId;
    const steps: string[] = [];
    const errors: string[] = [];
    if (channelId && item.lastAgentMessageId) {
      try {
        await this.options.discord.react(channelId, item.lastAgentMessageId, '✅');
        this.core.store.setMarker(`reaction:${item.lastAgentMessageId}:✅`, String(this.now()));
        steps.push('reacted');
      } catch (err) {
        // Closed in Discord already: Discord refuses the ✅, and the thread is where Done would leave it.
        if ((err as DiscordError).code === THREAD_ARCHIVED && item.kind === 'thread') return { outcome: 'ok', steps: ['already closed'] };
        errors.push(`react: ${(err as Error).message}`);
      }
    }
    // A thread closes (it reopens on the next message); a chapter only gets the ✅.
    if (item.kind === 'thread' && item.threadId) {
      try {
        await this.options.discord.archiveThread(item.threadId);
        steps.push('archived');
      } catch (err) {
        errors.push(`archive: ${(err as Error).message}`);
      }
    }
    if (errors.length) return { outcome: 'failed', error: errors.join('; '), steps };
    return { outcome: steps.length ? 'ok' : 'n/a', steps };
  }

  async react(item: DeskItemRow, emoji: string): Promise<void> {
    const channelId = item.threadId ?? item.channelId;
    if (!channelId || !item.lastAgentMessageId) return;
    await this.options.discord.react(channelId, item.lastAgentMessageId, emoji);
    this.core.store.setMarker(`reaction:${item.lastAgentMessageId}:${emoji}`, String(this.now()));
  }

  async reply(item: DeskItemRow, text: string, context: { commandId?: string; attachments?: StartAttachment[] } = {}): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }> {
    const channelId = item.threadId ?? item.channelId;
    if (!channelId) return { ok: false, error: 'no conversation to reply in' };
    // The bot posts it as "🖥️ <words>" (as the owner, in a channel only they see) and wakes the agent.
    // commandId rides along so the bot drops a repeat of the same command.
    const attachments = context.attachments ?? [];
    // Images ride along as data URLs; the bot posts them as files on its 🖥️ message, so the agent
    // gets them the way it gets any image the owner drops in Discord.
    const routed = await this.options.postToBot(
      {
        agentId: item.agentId,
        channelId,
        sceneTitle: this.core.title(item),
        type: 'reply',
        // The bot answers this message (a reply reference when it posts as itself).
        ...(item.lastAgentMessageId ? { replyToMessageId: item.lastAgentMessageId } : {}),
        data: { text, ...(attachments.length ? { attachments: attachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl })) } : {}) },
        ...(context.commandId ? { commandId: context.commandId } : {}),
      },
      // Uploading megabytes to Discord takes longer than posting words.
      attachments.length ? { timeoutMs: 60_000 } : undefined,
    );
    if (routed === 'agent') return { ok: true };
    // `unknown:` = the bot didn't answer in time: the post may have gone out.
    if (routed.startsWith('unknown:')) return { ok: false, error: routed.slice('unknown:'.length), unknown: true };
    return { ok: false, error: routed.replace(/^failed:/, '') };
  }
}

/**
 * The bot's old relay wrapper, nested once per re-send. It's gone from new posts; older ones still carry it,
 * and a retry re-sends what was read here, so the owner's words are read without it.
 */
const LEGACY_REPLY_WRAPPER = /^(?:The owner replied from the screen \(re: "[^\n]*"\):[ \t]*\n?)+/u;

/** A form post's header lines ("📥 New request — program", "From: …"); the request is what follows. */
const FORM_HEADER = /^(\p{Extended_Pictographic}|from:)/iu;

/** A request's title: its first line of substance, past any form header. */
export function requestTitle(text: string): string {
  const lines = text.split('\n').map((line) => line.replace(/^[*_#>\s]+/, '').trim()).filter(Boolean);
  const body = lines.find((line) => !FORM_HEADER.test(line));
  return body ?? lines[0] ?? '';
}

/** Who a form post is from: its "From:" line, if it has one. */
function formSender(text: string): string | null {
  return /^from:\s*(.+)$/im.exec(text)?.[1]?.trim().slice(0, 60) || null;
}

/** A Discord message's images, served by the desk (it fetches a fresh CDN link each time: Discord's expire). */
export function discordImages(message: DiscordMessage): MessageAttachment[] {
  return (message.attachments ?? []).flatMap((attachment, index) =>
    isImageAttachment(attachment)
      ? [{
          name: attachment.filename,
          mimeType: attachment.content_type ?? 'image/png',
          url: `api/desk/attachments/discord/${message.channel_id}/${message.id}/${index}`,
          ...(typeof attachment.size === 'number' ? { sizeBytes: attachment.size } : {}),
        }]
      : [],
  );
}
