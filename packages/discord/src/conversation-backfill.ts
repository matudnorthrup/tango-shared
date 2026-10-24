import type { ConversationPostInput, TangoStorage, StoredMessageDirection, StoredMessageSource } from "@tango/core";
import { recordConversationPost, settleConversationAttachments, type PostAttachment } from "./conversation-posts.js";
import { splitForDiscord } from "./reply-presentation.js";

export interface DiscordHistoryPost {
  id: string;
  type?: number;
  content: string;
  timestamp: string;
  author: { id: string; username: string; bot?: boolean };
  webhook_id?: string;
  message_reference?: { message_id?: string };
  attachments: Array<{ filename: string; url: string; content_type?: string | null; size: number }>;
}
export interface ExistingHistoryPost {
  id: number;
  session_id: string;
  agent_id: string | null;
  discord_message_id: string | null;
  discord_message_ids?: string;
  content: string;
  conversation_key?: string | null;
  attachments?: string;
  metadata_json?: string | null;
  direction?: StoredMessageDirection;
  source?: StoredMessageSource;
  author_kind?: ConversationPostInput["authorKind"] | null;
  created_at?: string;
}
export interface BackfillContext {
  conversationKey: string;
  channelId: string;
  parentChannelId?: string;
  title?: string;
  sessionId: string;
  agentId: string;
  ownerIds: string[];
  since?: number;
}
export interface BackfillPlan {
  posts: Array<ConversationPostInput & { attachments?: PostAttachment[]; replyToDiscordId?: string }>;
  counts: { fetched: number; insert: number; enrich: number; unchanged: number; attachments: number; ambiguousChunks: number };
}
const visibleText = (text: string) => text.replace(/^\[↪ Reply\]\(https:\/\/discord\.com\/channels\/[^)]+\)\n/, "").trim();

/** Pure planning: safe with a read-only pre-migration database. Never guesses chunk grouping. */
export function planConversationBackfill(history: DiscordHistoryPost[], existing: ExistingHistoryPost[], context: BackfillContext): BackfillPlan {
  const ordered = history.filter(post => post.type === undefined || post.type === 0 || post.type === 19).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const byDiscord = new Map<string, ExistingHistoryPost>();
  for (const row of existing) {
    for (const id of [...JSON.parse(row.discord_message_ids ?? "[]"), row.discord_message_id].filter(Boolean)) byDiscord.set(id, row);
  }
  const groups = new Map<string, DiscordHistoryPost[]>();
  const claimed = new Set<string>();
  const counts = { fetched: history.length, insert: 0, enrich: 0, unchanged: 0, attachments: 0, ambiguousChunks: 0 };
  for (let i = ordered.length - 1; i >= 0; i--) {
    const last = ordered[i]!;
    const row = byDiscord.get(last.id);
    if (!row || claimed.has(last.id)) continue;
    let group = [last];
    // Old outbound rows retained only the last chunk. Verify every contiguous chunk before grouping.
    for (const limit of [1900, 1800]) {
      const chunks = splitForDiscord(row.content.trim(), limit);
      const candidates = ordered.slice(Math.max(0, i - chunks.length + 1), i + 1);
      if (candidates.length === chunks.length && candidates.every((post, index) =>
        !claimed.has(post.id) && post.author.id === last.author.id && post.webhook_id === last.webhook_id
        && visibleText(post.content) === chunks[index]
        && (!byDiscord.has(post.id) || byDiscord.get(post.id)?.id === row.id))) {
        group = candidates; break;
      }
    }
    if (group.length === 1 && splitForDiscord(row.content.trim()).length > 1) counts.ambiguousChunks++;
    groups.set(group[0]!.id, group);
    for (const post of group) claimed.add(post.id);
  }
  const posts: BackfillPlan["posts"] = [];
  for (const post of ordered) {
    if (claimed.has(post.id) && !groups.has(post.id)) continue;
    const group = groups.get(post.id) ?? [post];
    const row = byDiscord.get(group.at(-1)!.id);
    const ids = group.map(item => item.id);
    const savedAttachments: PostAttachment[] = JSON.parse(row?.attachments ?? "[]");
    const attachments = group.flatMap(item => item.attachments.map(attachment => ({
      name: attachment.filename, url: attachment.url, contentType: attachment.content_type, size: attachment.size,
    })));
    if (row?.conversation_key === context.conversationKey && ids.every(id => JSON.parse(row.discord_message_ids ?? "[]").includes(id))
      && (attachments.length === 0 || savedAttachments.length === attachments.length && savedAttachments.every(a => a.localPath && !a.error))) {
      counts.unchanged++; continue;
    }
    // Bot/webhook posts the store already holds as inbound (desk picks and replies, test harness)
    // stand in for the owner. The desk marker may arrive without its emoji variation selector.
    const owner = context.ownerIds.includes(post.author.id) || Boolean(post.webhook_id && /^(?:\u{1F5A5}|\u200B)/u.test(post.content))
      || Boolean(row?.direction === "inbound" && (post.author.bot || post.webhook_id));
    const agent = !owner && Boolean(post.author.bot || post.webhook_id);
    posts.push({
      localMessageId: row?.id, sessionId: row?.session_id ?? context.sessionId, agentId: row?.agent_id ?? context.agentId,
      conversationKey: context.conversationKey, conversationAgentId: context.agentId, title: context.title, discordChannelId: context.channelId, discordParentChannelId: context.parentChannelId,
      discordMessageId: group.at(-1)!.id, discordMessageIds: ids,
      direction: row?.direction ?? (owner || !agent ? "inbound" : "outbound"),
      authorKind: row?.author_kind ?? (row?.direction === "system" || row?.direction === "error" ? "system" : owner ? "owner" : agent ? "agent" : "requester"),
      source: row?.source ?? "discord", content: row?.content ?? post.content,
      createdAt: post.timestamp, discordUserId: post.author.id, discordUsername: post.author.username,
      attachments: attachments.length ? attachments : undefined,
      replyToDiscordId: post.message_reference?.message_id,
      metadata: { ...JSON.parse(row?.metadata_json ?? "{}"), backfilled: true },
    });
    row ? counts.enrich++ : counts.insert++;
    counts.attachments += attachments.length;
  }
  // Rows without a Discord anchor (including old voice/error posts) still need their conversation.
  const planned = new Set(posts.map(post => post.localMessageId));
  for (const row of existing) {
    if (row.conversation_key || planned.has(row.id) || row.discord_message_id
      || (context.since && Date.parse(row.created_at?.includes("T") ? row.created_at : `${row.created_at?.replace(" ", "T")}Z`) < context.since)) continue;
    const metadata = JSON.parse(row.metadata_json ?? "{}");
    posts.push({ localMessageId: row.id, sessionId: row.session_id, agentId: row.agent_id ?? context.agentId,
      conversationKey: context.conversationKey, conversationAgentId: context.agentId, title: context.title, discordChannelId: context.channelId, discordParentChannelId: context.parentChannelId,
      direction: row.direction ?? "system", source: row.source ?? "tango",
      authorKind: row.author_kind ?? (row.direction === "inbound" ? "owner" : row.direction === "outbound" ? "agent" : "system"),
      content: row.content, metadata, attachments: Array.isArray(metadata.attachments) ? metadata.attachments : undefined,
    });
    counts.enrich++;
  }
  return { posts, counts };
}

export async function applyConversationBackfill(storage: TangoStorage, dataDir: string, plan: BackfillPlan, dryRun = true) {
  if (dryRun) return { ...plan.counts, attachmentFailures: 0 };
  let attachmentFailures = 0;
  for (const post of plan.posts) {
    const id = await recordConversationPost(storage, dataDir, { ...post,
      replyToMessageId: post.replyToDiscordId ? storage.findConversationPostByDiscordId(post.replyToDiscordId) : undefined,
    });
    await settleConversationAttachments(storage);
    const row = storage.getDatabase().prepare("SELECT attachments FROM messages WHERE id = ?").get(id) as { attachments: string };
    attachmentFailures += (JSON.parse(row.attachments) as PostAttachment[]).filter(a => a.error).length;
  }
  return { ...plan.counts, attachmentFailures };
}
