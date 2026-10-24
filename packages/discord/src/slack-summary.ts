/**
 * Slack Channel Summary — deterministic scheduler handlers.
 *
 * Fetches recent messages from Slack channels the Watson bot is in,
 * filters for signal (replies, reactions, production issues), and
 * generates a digest. Based on an earlier internal slack-digest skill.
 *
 * Exports two handlers:
 * - slackSummaryHandler: all channels, general digest
 * - slackAiBriefingHandler: AI-related channels only
 *
 * Token is fetched from 1Password at runtime (Watson vault, "Watson Slack Bot Token").
 */

import type { DeterministicHandler } from "@tango/core";
import { readProfileConfigStringList } from "@tango/core";
import { getSecret } from "./op-secret.js";

const SLACK_API = "https://slack.com/api";
const DEFAULT_LOOKBACK_MS = 24 * 3600_000;

// AI-related channel names for the AI briefing filter. The generic starter set
// ships in config/defaults/slack/ai-channels.txt; an installation's real channel
// names are added via the profile overlay (config/slack/ai-channels.txt) or the
// TANGO_SLACK_AI_CHANNELS env var — keeping personal channel names out of the repo.
const AI_CHANNELS_CONFIG_PATH = "slack/ai-channels.txt";

function loadAiChannelNames(): Set<string> {
  return new Set(
    readProfileConfigStringList({
      relativePath: AI_CHANNELS_CONFIG_PATH,
      envPathVar: "TANGO_SLACK_AI_CHANNELS_FILE",
      envValueVar: "TANGO_SLACK_AI_CHANNELS",
      lowercase: true,
    }).map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
}

// In-memory: last successful run timestamps (epoch seconds), keyed by handler
const lastRunTimestamps = new Map<string, number>();

// ---------------------------------------------------------------------------
// Slack API helpers
// ---------------------------------------------------------------------------

async function slackGet(
  method: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Slack API ${method} HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (!body.ok) throw new Error(`Slack API ${method}: ${body.error}`);
  return body;
}

interface SlackChannel {
  id: string;
  name: string;
}

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
  reply_count?: number;
  reactions?: Array<{ count: number }>;
}

async function listBotChannels(token: string): Promise<SlackChannel[]> {
  const body = await slackGet("users.conversations", token, {
    types: "public_channel,private_channel",
    limit: "200",
  });
  return (body.channels as SlackChannel[]) ?? [];
}

async function getChannelHistory(
  token: string,
  channelId: string,
  oldest: string,
  limit = 200,
): Promise<SlackMessage[]> {
  const body = await slackGet("conversations.history", token, {
    channel: channelId,
    oldest,
    limit: String(limit),
  });
  return (body.messages as SlackMessage[]) ?? [];
}

// Cache user display names for the duration of one run
let userNameCache = new Map<string, string>();

async function resolveUserName(token: string, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const body = await slackGet("users.info", token, { user: userId });
    const user = body.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, string> | undefined;
    const name = profile?.display_name || profile?.real_name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ---------------------------------------------------------------------------
// Signal detection inspired by an earlier internal slack-digest skill
// ---------------------------------------------------------------------------

function reactionCount(msg: SlackMessage): number {
  return (msg.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
}

function isSignal(msg: SlackMessage): boolean {
  // Multi-person threads
  if ((msg.reply_count ?? 0) >= 2) return true;
  // Engaged messages
  if (reactionCount(msg) >= 2) return true;
  // Production/incident keywords
  const text = (msg.text ?? "").toLowerCase();
  if (/\b(outage|down|incident|broke|broken|alert|deploy|rollback|hotfix|p[01])\b/.test(text)) return true;
  // Decision keywords
  if (/\b(decided|decision|approved|shipped|launched|released|merged)\b/.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Digest builder
// ---------------------------------------------------------------------------

interface ChannelDigest {
  name: string;
  totalMessages: number;
  signalMessages: number;
  participants: string[];
  highlights: string[];
}

async function buildChannelDigest(
  token: string,
  channel: SlackChannel,
  oldest: string,
): Promise<ChannelDigest | null> {
  let messages: SlackMessage[];
  try {
    messages = await getChannelHistory(token, channel.id, oldest);
  } catch {
    return null;
  }

  // Filter out join/leave/bot noise
  const humanMessages = messages.filter(
    (m) => !m.subtype && m.user && !m.bot_id && m.text,
  );

  if (humanMessages.length === 0) return null;

  // Separate signal from noise
  const signalMsgs = humanMessages.filter(isSignal);

  // Resolve participant names
  const userIds = [...new Set(humanMessages.map((m) => m.user!))];
  const names = await Promise.all(userIds.map((id) => resolveUserName(token, id)));

  // Pick highlights: prefer signal messages, fall back to most-reacted
  const ranked = [...humanMessages].sort((a, b) => {
    const aScore = (a.reply_count ?? 0) * 2 + reactionCount(a);
    const bScore = (b.reply_count ?? 0) * 2 + reactionCount(b);
    return bScore - aScore;
  });

  const highlights: string[] = [];
  for (const msg of ranked) {
    if (highlights.length >= 3) break;
    const name = await resolveUserName(token, msg.user!);
    const text = (msg.text ?? "").slice(0, 200).replace(/\n/g, " ");
    const replies = msg.reply_count ?? 0;
    const reactions = reactionCount(msg);
    const meta = [
      replies > 0 ? `${replies} replies` : "",
      reactions > 0 ? `${reactions} reactions` : "",
    ].filter(Boolean).join(", ");
    highlights.push(`**${name}**: ${text}${meta ? ` _(${meta})_` : ""}`);
  }

  return {
    name: channel.name,
    totalMessages: humanMessages.length,
    signalMessages: signalMsgs.length,
    participants: names.filter(Boolean),
    highlights,
  };
}

function formatSummary(
  digests: ChannelDigest[],
  sinceStr: string,
  title = "Slack Summary",
): string {
  if (digests.length === 0) {
    return `No new activity since ${sinceStr}.`;
  }

  // Sort by signal count first, then total messages
  digests.sort((a, b) => b.signalMessages - a.signalMessages || b.totalMessages - a.totalMessages);

  const totalMessages = digests.reduce((sum, d) => sum + d.totalMessages, 0);
  const totalSignal = digests.reduce((sum, d) => sum + d.signalMessages, 0);
  const lines: string[] = [
    `**${title}** (${totalMessages} messages, ${totalSignal} notable — ${digests.length} active channels since ${sinceStr})`,
    "",
  ];

  for (const d of digests) {
    const signalTag = d.signalMessages > 0 ? ` — ${d.signalMessages} notable` : "";
    lines.push(`**#${d.name}** (${d.totalMessages} msgs${signalTag}) — ${d.participants.join(", ")}`);
    for (const h of d.highlights) {
      lines.push(`> ${h}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Core fetch + digest logic (shared by both handlers)
// ---------------------------------------------------------------------------

interface SummaryOptions {
  handlerId: string;
  channelFilter?: (ch: SlackChannel) => boolean;
  title?: string;
}

async function runSlackSummary(opts: SummaryOptions): Promise<{
  status: "ok" | "skipped" | "error";
  summary: string;
}> {
  const token = await getSecret("Watson", "Watson Slack Bot Token");
  if (!token) {
    return { status: "error", summary: "Could not resolve Slack bot token from 1Password" };
  }

  const now = Date.now();
  const lastTs = lastRunTimestamps.get(opts.handlerId);
  const sinceEpoch = lastTs ?? (now - DEFAULT_LOOKBACK_MS) / 1000;
  const oldest = String(sinceEpoch);
  const sinceStr = new Date(sinceEpoch * 1000).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let channels = await listBotChannels(token);
  if (opts.channelFilter) {
    channels = channels.filter(opts.channelFilter);
  }

  if (channels.length === 0) {
    lastRunTimestamps.set(opts.handlerId, now / 1000);
    return { status: "skipped", summary: "No matching channels" };
  }

  const BATCH_SIZE = 5;
  const digests: ChannelDigest[] = [];

  for (let i = 0; i < channels.length; i += BATCH_SIZE) {
    const batch = channels.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((ch) => buildChannelDigest(token, ch, oldest)),
    );
    for (const d of results) {
      if (d) digests.push(d);
    }
  }

  lastRunTimestamps.set(opts.handlerId, now / 1000);
  userNameCache = new Map();

  if (digests.length === 0) {
    return { status: "skipped", summary: "No new activity" };
  }

  return { status: "ok", summary: formatSummary(digests, sinceStr, opts.title) };
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

/** All channels — general Slack digest. */
export const slackSummaryHandler: DeterministicHandler = async (_ctx) => {
  return await runSlackSummary({
    handlerId: "slack-summary",
    title: "Slack Summary",
  });
};

/** AI-related channels only — for the AI intelligence briefing. */
export const slackAiBriefingHandler: DeterministicHandler = async (_ctx) => {
  const aiChannelNames = loadAiChannelNames();
  return await runSlackSummary({
    handlerId: "slack-ai-briefing",
    channelFilter: (ch) => aiChannelNames.has(ch.name.toLowerCase()),
    title: "AI & Agents Briefing",
  });
};
