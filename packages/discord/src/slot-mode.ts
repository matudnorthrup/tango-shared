import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Client,
} from "discord.js";

export interface SlotModeAgentTestChannel {
  agentId: string;
  channelId: string;
}

export interface InitializeSlotModeInput {
  client: Client;
  slot: string;
  agentTestChannels: SlotModeAgentTestChannel[];
  now?: Date;
  logger?: (line: string) => void;
  recordPost?: (input: { channelId: string; agentId: string; content: string; messageId?: string }) => Promise<void>;
}

export interface SlotModeCreatedThread {
  agentId: string;
  threadId: string;
  url: string;
}

export interface SlotModeFailure {
  agentId: string;
  reason: string;
}

export interface SlotModeResult {
  threadIds: Set<string>;
  created: SlotModeCreatedThread[];
  failures: SlotModeFailure[];
}

export interface ApplySlotNicknameInput {
  client: Client;
  slot: string;
  guildId?: string | null;
  logger?: (line: string) => void;
}

export interface ResetBotNicknameInput {
  client: Client;
  nickname?: string | null;
  guildId?: string | null;
  logger?: (line: string) => void;
}

export interface NicknameResult {
  ok: boolean;
  nickname: string | null;
  reason?: string;
}

interface ThreadLike {
  id: string;
  url: string;
  send: (content: string) => Promise<unknown>;
}

interface GuildMemberLike {
  setNickname: (nickname: string | null) => Promise<unknown>;
}

interface GuildLike {
  id: string;
  members?: {
    me?: GuildMemberLike | null;
  };
}

interface GuildCacheLike {
  get?: (guildId: string) => GuildLike | undefined;
  values: () => IterableIterator<GuildLike>;
}

interface ThreadStarterChannelLike {
  threads: {
    create: (input: {
      name: string;
      autoArchiveDuration: ThreadAutoArchiveDuration;
      type: ChannelType.PublicThread;
      reason: string;
    }) => Promise<ThreadLike>;
  };
}

export function isSlotModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const slot = env.TANGO_SLOT?.trim();
  return Boolean(slot && slot.length > 0);
}

export function shouldInitializeSlotMode(
  env: NodeJS.ProcessEnv = process.env,
  allowlist: Set<string> | null,
): boolean {
  return isSlotModeActive(env) && allowlist === null;
}

/**
 * Whether this bot instance should run the automatic scheduler tick loop.
 *
 * Only the canonical production bot schedules jobs. Slot / worktree-dev
 * instances (TANGO_SLOT set) must NOT auto-run schedules: they would
 * double-execute jobs and fire real external side effects (email, Lunch Money,
 * receipts, Discord posts) alongside production. Set TANGO_SCHEDULER_IN_SLOT=true
 * to force ticks on in a slot for deliberate testing.
 */
export function shouldRunSchedulerTickLoop(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isSlotModeActive(env)) return true;
  return (env.TANGO_SCHEDULER_IN_SLOT ?? "").trim() === "true";
}

export function buildThreadName(slot: string, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  return `[wt-${slot}] ${year}-${month}-${day} ${hour}${minute}`;
}

function formatCreatedAt(now: Date): string {
  return now.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function resolveBranchLabel(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TANGO_GIT_BRANCH?.trim()
    || env.GIT_BRANCH?.trim()
    || env.GITHUB_REF_NAME?.trim()
    || env.BRANCH_NAME?.trim()
    || "current-worktree"
  );
}

/**
 * Repository defaults use placeholder snowflakes such as 100000000000000003: a
 * leading digit followed by a long zero run (the same convention
 * scripts/privacy-scan.sh relies on). Real snowflakes never carry a run of ten
 * zeros, while a real id may legitimately start with "1000000".
 */
const PLACEHOLDER_SNOWFLAKE_ZERO_RUN = /0{10,}/;

export function isConfiguredDiscordChannelId(channelId: string): boolean {
  const normalized = channelId.trim();
  return normalized.length > 0 && !PLACEHOLDER_SNOWFLAKE_ZERO_RUN.test(normalized);
}

function isThreadStarterChannel(channel: unknown): channel is ThreadStarterChannelLike {
  return Boolean(
    channel
      && typeof channel === "object"
      && "threads" in channel
      && typeof (channel as { threads?: { create?: unknown } }).threads?.create === "function",
  );
}

function buildCharterMessage(slot: string, agentId: string, now: Date): string {
  return [
    `This is slot wt-${slot}'s smoke-test thread for agent ${agentId}.`,
    `Branch: ${resolveBranchLabel()}.`,
    `Created: ${formatCreatedAt(now)}.`,
    "Messages here route through this slot's dev code.",
  ].join(" ");
}

function resolveTargetGuild(
  client: Client,
  explicitGuildId?: string | null,
): GuildLike | null {
  const configuredGuildId = explicitGuildId?.trim() || process.env.DISCORD_GUILD_ID?.trim() || "";
  const guildCache = client.guilds.cache as unknown as GuildCacheLike;

  if (configuredGuildId.length > 0 && typeof guildCache.get === "function") {
    return guildCache.get(configuredGuildId) ?? null;
  }

  for (const guild of guildCache.values()) {
    return guild;
  }

  return null;
}

async function setBotNickname(
  client: Client,
  nickname: string | null,
  explicitGuildId: string | null | undefined,
  logger: (line: string) => void,
  successLine: string,
): Promise<NicknameResult> {
  try {
    const guild = resolveTargetGuild(client, explicitGuildId);
    if (!guild) {
      const reason = "guild not found";
      logger(`nickname skipped reason=${reason}`);
      return { ok: false, nickname, reason };
    }

    const member = guild.members?.me ?? null;
    if (!member) {
      const reason = `bot member missing in guild ${guild.id}`;
      logger(`nickname skipped reason=${reason}`);
      return { ok: false, nickname, reason };
    }

    await member.setNickname(nickname);
    logger(successLine);
    return { ok: true, nickname };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger(`nickname failed reason=${reason}`);
    return { ok: false, nickname, reason };
  }
}

export async function applySlotNickname(
  input: ApplySlotNicknameInput,
): Promise<NicknameResult> {
  const logger = input.logger ?? (() => undefined);
  const nickname = `Tango [wt-${input.slot}]`;
  return setBotNickname(input.client, nickname, input.guildId, logger, `nickname set=${nickname}`);
}

export async function resetBotNickname(
  input: ResetBotNicknameInput,
): Promise<NicknameResult> {
  const logger = input.logger ?? (() => undefined);
  const nickname = input.nickname?.trim() || null;
  const successLine = nickname ? `nickname reset=${nickname}` : "nickname reset";
  return setBotNickname(input.client, nickname, input.guildId, logger, successLine);
}

export async function initializeSlotMode(
  input: InitializeSlotModeInput,
): Promise<SlotModeResult> {
  const now = input.now ?? new Date();
  const logger = input.logger ?? (() => undefined);
  const result: SlotModeResult = {
    threadIds: new Set<string>(),
    created: [],
    failures: [],
  };

  for (const agentChannel of input.agentTestChannels) {
    const channelId = agentChannel.channelId.trim();
    if (!isConfiguredDiscordChannelId(channelId)) {
      const reason = "not configured";
      logger(`skip agent=${agentChannel.agentId} reason=${reason}`);
      result.failures.push({ agentId: agentChannel.agentId, reason });
      continue;
    }

    try {
      const channel = await input.client.channels.fetch(channelId);
      if (!channel) {
        const reason = `channel not found: ${channelId}`;
        logger(`failed agent=${agentChannel.agentId} reason=${reason}`);
        result.failures.push({ agentId: agentChannel.agentId, reason });
        continue;
      }

      if (!isThreadStarterChannel(channel)) {
        const reason = `channel does not support public threads: ${channelId}`;
        logger(`failed agent=${agentChannel.agentId} reason=${reason}`);
        result.failures.push({ agentId: agentChannel.agentId, reason });
        continue;
      }

      const thread = await channel.threads.create({
        name: buildThreadName(input.slot, now),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        type: ChannelType.PublicThread,
        reason: `Tango slot wt-${input.slot} smoke-test thread for ${agentChannel.agentId}`,
      });

      result.threadIds.add(thread.id);
      result.created.push({
        agentId: agentChannel.agentId,
        threadId: thread.id,
        url: thread.url,
      });

      logger(`created agent=${agentChannel.agentId} threadId=${thread.id} url=${thread.url}`);

      try {
        const content = buildCharterMessage(input.slot, agentChannel.agentId, now);
        const sent = await thread.send(content) as { id?: string } | undefined;
        await input.recordPost?.({ channelId: thread.id, agentId: agentChannel.agentId, content, messageId: sent?.id });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger(`charter failed agent=${agentChannel.agentId} reason=${reason}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger(`failed agent=${agentChannel.agentId} reason=${reason}`);
      result.failures.push({ agentId: agentChannel.agentId, reason });
    }
  }

  return result;
}
