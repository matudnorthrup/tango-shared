import { DatabaseSync } from 'node:sqlite';
import type { Log } from './types.js';

// A Discord conversation's agent runs in a Loom `tango-agent` thread. The bot records which one in its own
// database (tango.sqlite provider_sessions: conversation ["<agent>","thread:<id>"|"channel:<id>"] → Loom thread),
// so the desk can show that thread's records (briefs, questions, asks) on the Discord row the owner reads.

/** Where a Loom thread talks to the owner: a Discord thread or an agent's home (or intake) channel. */
export interface DiscordLoomLink {
  agentId: string;
  /** The Discord row's conversation key: `thread:<channelId>` or `channel:<channelId>`. */
  conversation: string;
}

export interface DiscordLoomLinkReader {
  /** The thread's conversation; null when the bot maps it nowhere; undefined when the lookup failed (try again). */
  linkOf(loomThreadId: string): DiscordLoomLink | null | undefined;
}

/** Parses the bot's conversation key (`["sierra","thread:155…"]`); anything else is not a Discord conversation. */
export function parseConversationKey(raw: string): DiscordLoomLink | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
  return /^(?:(?:thread|channel):\d+|conv:[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(parsed[1]) ? { agentId: parsed[0], conversation: parsed[1] } : null;
}

/** Read-only, opened on first use and again after a failure (the bot may not have made its database yet). */
export class DiscordLoomLinks implements DiscordLoomLinkReader {
  private db: DatabaseSync | null = null;

  constructor(private readonly options: { dbPath: string; log?: Log }) {}

  linkOf(loomThreadId: string): DiscordLoomLink | null | undefined {
    try {
      this.db ??= new DatabaseSync(this.options.dbPath, { readOnly: true });
      const row = this.db
        .prepare("SELECT conversation_key FROM provider_sessions WHERE provider_name = 'loom' AND provider_session_id = ? ORDER BY updated_at DESC LIMIT 1")
        .get(loomThreadId) as { conversation_key: string } | undefined;
      return row ? parseConversationKey(row.conversation_key) : null;
    } catch (err) {
      this.options.log?.('desk.discord_links.error', { message: (err as Error).message });
      try { this.db?.close(); } catch { /* already closed */ }
      this.db = null;
      return undefined;
    }
  }
}
