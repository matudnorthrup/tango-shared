import type { SystemContext } from "./context.js";
import { markNotified, pendingNotifications, scheduleReminders, type PendingNotification } from "./incidents.js";
import { tx } from "./ledger.js";
import { readEnvFileValue } from "./paths.js";
import type { Ledger } from "./types.js";

const LABEL: Record<string, string> = {
  opened: "New problem",
  escalated: "Got worse",
  regressed: "Back again",
  reminder: "Still open",
  resolved: "Resolved",
};

const short = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z");

export function formatCriticalMessage(p: PendingNotification, detail?: string | null): string {
  const i = p.incident;
  const head = `🛰️ **${LABEL[p.transition] ?? p.transition}**: ${i.title}`;
  const meta = `${i.count}× · first ${short(i.firstSeen)} · last ${short(i.lastSeen)}${i.jobId ? ` · \`${i.jobId}\`` : ""}${i.flapping ? " · flapping" : ""}`;
  return `${head}\n${meta}${detail ? `\n${detail}` : ""}`.slice(0, 1900);
}

/** The incident's latest event detail, when that event asked to be posted with it (`data.notifyDetail`). */
export function notifyDetail(l: Ledger, incidentId: number): string | null {
  const row = l.db.prepare("SELECT detail, data FROM events WHERE incident_id = ? ORDER BY id DESC LIMIT 1").get(incidentId) as { detail: string | null; data: string | null } | undefined;
  if (!row?.detail || !row.data) return null;
  try {
    return (JSON.parse(row.data) as { notifyDetail?: unknown }).notifyDetail === true ? row.detail : null;
  } catch {
    return null;
  }
}

export interface DiscordTarget {
  token: string;
  channelId: string;
}

export function discordTarget(): DiscordTarget | null {
  const token = readEnvFileValue("DISCORD_TOKEN");
  const channelId = readEnvFileValue("TANGO_SCHEDULER_ALERTS_CHANNEL_ID");
  return token && channelId ? { token, channelId } : null;
}

/**
 * Sends critical-route transitions to Discord, one post each. A post Discord
 * did not take stays pending for the next tick. Returns how many were sent.
 */
export async function notifyCritical(
  l: Ledger,
  ctx: SystemContext,
  opts: { target?: DiscordTarget | null; dryRun?: boolean } = {},
): Promise<{ sent: number; pending: number; failed: number }> {
  scheduleReminders(l, ctx.now().toISOString());
  const pending = tx(l, () => pendingNotifications(l, "critical", ctx.now().toISOString()));
  if (opts.dryRun) return { sent: 0, pending: pending.length, failed: 0 };
  const target = opts.target === undefined ? discordTarget() : opts.target;
  if (!target) {
    if (pending.length) ctx.warn("notify: no DISCORD_TOKEN / TANGO_SCHEDULER_ALERTS_CHANNEL_ID; critical transitions stay pending");
    return { sent: 0, pending: pending.length, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const p of pending) {
    const res = await ctx.fetch(`https://discord.com/api/v10/channels/${target.channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${target.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: formatCriticalMessage(p, notifyDetail(l, p.incident.id)), allowed_mentions: { parse: [] } }),
      timeoutMs: 10_000,
    });
    if (!("error" in res) && res.status >= 200 && res.status < 300) {
      markNotified(l, p.incident.id, ctx.now().toISOString());
      sent += 1;
    } else {
      failed += 1;
      ctx.warn(`notify: Discord post failed for incident ${p.incident.id}: ${"error" in res ? res.error : `HTTP ${res.status}`}`);
    }
  }
  return { sent, pending: pending.length - sent, failed };
}
