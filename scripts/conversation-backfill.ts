#!/usr/bin/env tsx
/** Offline-safe default: reads Discord and a read-only DB; only --apply writes. */
import { DatabaseSync } from "node:sqlite";
import { TangoStorage, loadLayeredV2AgentConfigs, loadSessionConfigs, resolveConfigDir } from "@tango/core";
import { planConversationBackfill, applyConversationBackfill, type DiscordHistoryPost, type ExistingHistoryPost } from "../packages/discord/src/conversation-backfill.ts";
import path from "node:path";

// Discord announcement, public and private thread channel types.
const THREAD_TYPES = new Set([10, 11, 12]);

async function main() {
const args = process.argv.slice(2);
function option(name: string): string | undefined { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
if (args.includes("--help")) {
  console.log("DISCORD_TOKEN=... node --import tsx scripts/conversation-backfill.ts --db <snapshot.sqlite> --data-dir <profile/data> [--config-dir <config>] [--skip-agent <id>]... [--dry-run | --apply]\nDefaults to dry-run. Reads the last 30 days in configured home channels and active/recent archived threads. No Discord writes.");
  process.exit(0);
}
const dbPath = option("--db");
const dataDir = option("--data-dir");
if (!dbPath || !dataDir) throw new Error("Explicit --db and --data-dir required; no live-profile defaults");
if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("Choose --apply or --dry-run");
const dryRun = !args.includes("--apply");
const token = process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN required");
const ownerIds = (process.env.DISCORD_OWNER_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean);
if (!ownerIds.length || ownerIds.some(id => !/^\d+$/.test(id))) throw new Error("DISCORD_OWNER_IDS must contain owner account IDs for reliable author classification");
const configDir = resolveConfigDir(option("--config-dir"));
const agents = loadLayeredV2AgentConfigs(configDir);
// Named agents are skipped on purpose (for example a home channel this bot can't read).
const skipAgents = new Set(args.flatMap((arg, i) => arg === "--skip-agent" && args[i + 1] ? [args[i + 1]!] : []));
const unknownSkips = [...skipAgents].filter(id => !agents.has(id));
if (unknownSkips.length) throw new Error(`Unknown --skip-agent: ${unknownSkips.join(", ")}`);
const sessions = loadSessionConfigs(configDir);
const cutoff = Date.now() - 30 * 86_400_000;
async function get<T>(route: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`https://discord.com/api/v10${route}`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 429) {
      const delay = await response.json() as { retry_after: number };
      await new Promise(resolve => setTimeout(resolve, Math.min(delay.retry_after * 1000, 30_000))); continue;
    }
    if (!response.ok) throw new Error(`Discord ${route.split("?")[0]}: HTTP ${response.status}`);
    return await response.json() as T;
  }
  throw new Error("Discord rate limit retries exhausted");
}
const readonly = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const plans: ReturnType<typeof planConversationBackfill>[] = [];
let storage: TangoStorage | undefined;
try {
  const visited = new Set<string>();
  for (const agent of agents.values()) {
    if (skipAgents.has(agent.id)) { console.log(JSON.stringify({ skippedAgent: agent.id })); continue; }
    const home = agent.discord?.defaultChannelId;
    if (!home || !/^\d+$/.test(home) || visited.has(home)) continue;
    const session = sessions.find(s => s.channels.includes(`discord:${home}`)) ?? sessions.find(s => s.channels.includes("discord:default"));
    if (!session) throw new Error(`No configured session for agent ${agent.id}`);
    type Channel = { id: string; name?: string; type: number; guild_id?: string; parent_id?: string; last_message_id?: string };
    const channel = await get<Channel>(`/channels/${home}`);
    const channels: Channel[] = channel.type === 15 ? [] : [channel];
    if (channel.guild_id) {
      const active = await get<{ threads: Channel[] }>(`/guilds/${channel.guild_id}/threads/active`);
      channels.push(...active.threads.filter(t => t.parent_id === home));
    }
    for (const kind of ["public", "private"]) {
      // Forum channels have no private threads.
      if (kind === "private" && channel.type === 15) continue;
      let before = "";
      for (;;) {
        const archived = await get<{ threads: Array<Channel & { thread_metadata: { archive_timestamp: string } }>; has_more: boolean }>(`/channels/${home}/threads/archived/${kind}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        channels.push(...archived.threads.filter(t => Date.parse(t.thread_metadata.archive_timestamp) >= cutoff));
        const last = archived.threads.at(-1);
        if (!archived.has_more || !last || Date.parse(last.thread_metadata.archive_timestamp) < cutoff) break;
        before = last.thread_metadata.archive_timestamp;
      }
    }
    for (const target of channels) {
      if (visited.has(target.id)) continue;
      visited.add(target.id);
      const history: DiscordHistoryPost[] = [];
      let before = "";
      for (;;) {
        const page = await get<DiscordHistoryPost[]>(`/channels/${target.id}/messages?limit=100${before ? `&before=${before}` : ""}`);
        history.push(...page.filter(p => Date.parse(p.timestamp) >= cutoff));
        if (page.length < 100 || Date.parse(page.at(-1)!.timestamp) < cutoff) break;
        before = page.at(-1)!.id;
      }
      if (!history.length) continue;
      const existing = readonly.prepare("SELECT * FROM messages WHERE discord_channel_id = ? AND visibility = 'public'").all(target.id) as unknown as ExistingHistoryPost[];
      // A text channel inside a category also has parent_id; only thread types are threads.
      const isThread = THREAD_TYPES.has(target.type);
      const conversationKey = `${isThread ? "thread" : "channel"}:${target.id}`;
      const threadSession = readonly.prepare("SELECT session_id FROM discord_thread_sessions WHERE thread_id = ?").get(target.id) as { session_id: string } | undefined;
      const plan = planConversationBackfill(history, existing, {
        conversationKey, channelId: target.id,
        title: target.name, since: cutoff, parentChannelId: isThread ? target.parent_id : undefined, sessionId: threadSession?.session_id ?? session.id, agentId: agent.id,
        ownerIds,
      });
      plans.push(plan);
      console.log(JSON.stringify({ conversationKey, ...plan.counts }));
    }
  }
  readonly.close();
  if (!dryRun) {
    storage = new TangoStorage(dbPath);
    storage.bootstrapSessions(sessions);
    for (const plan of plans) {
      const result = await applyConversationBackfill(storage, dataDir, plan, false);
      console.log(JSON.stringify({ applied: true, ...result }));
      if (result.attachmentFailures) process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({ dryRun, conversations: plans.length, counts: plans.reduce((sum, plan) => {
    for (const [key, value] of Object.entries(plan.counts)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  }, {} as Record<string, number>) }));
} finally { if (readonly.isOpen) readonly.close(); storage?.close(); }

}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
