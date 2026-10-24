// Threads the operator can route to and create.
//
// Thread inventory comes straight from Discord (active threads under each
// agent's home channel). New replies are discovered by the Agent Desk, not here.

export interface ThreadInfo {
  id: string;
  title: string;
  agentId: string;
  /** Epoch ms of the last message, from the thread's last_message_id snowflake. */
  lastActiveAt: number;
}

export interface ThreadDirectory {
  list(): Promise<ThreadInfo[]>;
  create(agentId: string, title: string): Promise<ThreadInfo>;
}

const DISCORD_EPOCH = 1420070400000n;

/** The smallest snowflake at or after a time ("messages after this"). */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(Math.floor(ms), Number(DISCORD_EPOCH))) - DISCORD_EPOCH) << 22n).toString();
}

export function snowflakeTime(id: string | null | undefined): number {
  if (!id || !/^\d+$/.test(id)) return 0;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export interface DiscordThreadDirectoryOptions {
  token: string;
  guildId: string;
  /** Agent id -> the channel its threads live under. */
  homeChannels: Map<string, string>;
  /** Ignore threads quieter than this (default 7 days). */
  maxAgeMs?: number;
  now?: () => number;
}

export class DiscordThreadDirectory implements ThreadDirectory {
  private cache: { at: number; threads: ThreadInfo[] } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DiscordThreadDirectoryOptions) {
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<ThreadInfo[]> {
    if (this.cache && this.now() - this.cache.at < 30_000) return this.cache.threads;
    const response = await fetch(`https://discord.com/api/v10/guilds/${this.options.guildId}/threads/active`, {
      headers: { Authorization: `Bot ${this.options.token}` },
    });
    if (!response.ok) throw new Error(`Discord threads HTTP ${response.status}`);
    const body = (await response.json()) as { threads?: Array<{ id: string; name: string; parent_id: string; last_message_id?: string }> };
    const agentByChannel = new Map([...this.options.homeChannels].map(([agentId, channelId]) => [channelId, agentId]));
    const cutoff = this.now() - (this.options.maxAgeMs ?? 7 * 86_400_000);
    const threads = (body.threads ?? [])
      .filter((thread) => agentByChannel.has(thread.parent_id))
      .map((thread) => ({
        id: thread.id,
        title: thread.name,
        agentId: agentByChannel.get(thread.parent_id)!,
        lastActiveAt: snowflakeTime(thread.last_message_id) || snowflakeTime(thread.id),
      }))
      .filter((thread) => thread.lastActiveAt >= cutoff)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    this.cache = { at: this.now(), threads };
    return threads;
  }

  async create(agentId: string, title: string): Promise<ThreadInfo> {
    const parent = this.options.homeChannels.get(agentId);
    if (!parent) throw new Error(`No home channel for ${agentId}`);
    const response = await fetch(`https://discord.com/api/v10/channels/${parent}/threads`, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.options.token}`, 'Content-Type': 'application/json' },
      // 11 = public thread; archive after a week of quiet.
      body: JSON.stringify({ name: title.slice(0, 100), type: 11, auto_archive_duration: 10080 }),
    });
    if (!response.ok) throw new Error(`Discord create thread HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const thread = (await response.json()) as { id: string; name: string };
    const info: ThreadInfo = { id: thread.id, title: thread.name, agentId, lastActiveAt: this.now() };
    if (this.cache) this.cache.threads = [info, ...this.cache.threads];
    return info;
  }
}

/** Spoken-friendly age: "just now", "20 minutes ago", "3 hours ago", "2 days ago". */
export function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
