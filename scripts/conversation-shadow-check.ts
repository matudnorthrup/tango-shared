#!/usr/bin/env tsx
/** Offline comparator against explicit, read-only bot and desk snapshots. */
import { DatabaseSync } from 'node:sqlite';
import { compareConversationPosts, type StorePost } from '../apps/screen/server/desk/source-tango.js';
import { storeTime } from '../apps/screen/server/desk/chapters.js';
import { snowflakeTime, type DiscordMessage } from '../apps/screen/server/discord.js';
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const botFile = option('--db'); const deskFile = option('--desk-db');
if (!botFile || !deskFile) throw new Error('Explicit --db and --desk-db snapshots required');
const bot = new DatabaseSync(botFile, { readOnly: true });
const desk = new DatabaseSync(deskFile, { readOnly: true });
try {
  const count = (items: Array<{ kind: string }>) => items.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1; return counts;
  }, {} as Record<string, number>);
  const before = count((desk.prepare('SELECT differences FROM desk_tango_diffs').all() as { differences: string }[]).flatMap(row => JSON.parse(row.differences)));
  const reports = (desk.prepare("SELECT key,value FROM desk_markers WHERE key LIKE 'tango:shadow-since:%'").all() as { key: string; value: string }[]).map(row => {
    const key = row.key.slice('tango:shadow-since:'.length);
    const posts = (bot.prepare(`SELECT *, json_extract(metadata_json,'$.discordMessageType') AS discord_message_type,
      json_extract(metadata_json,'$.inputSource') AS input_source FROM messages WHERE conversation_key=? AND visibility='public'`).all(key) as unknown as StorePost[])
      .filter(post => storeTime(post.created_at) >= Number(row.value));
    const discord = (desk.prepare('SELECT body FROM desk_discord_shadow WHERE conversation_key=?').all(key) as { body: string }[])
      .map(p => JSON.parse(p.body) as DiscordMessage).filter(post => snowflakeTime(post.id) >= Number(row.value));
    return { key, ...compareConversationPosts(posts, discord) };
  });
  console.log(JSON.stringify({ conversations: reports.length, before, after: count(reports.flatMap(r => r.differences)),
    exclusions: count(reports.flatMap(r => r.exclusions.map(e => ({ kind: e.reason })))), reports }, null, 2));
} finally { bot.close(); desk.close(); }
