import { agentColor } from './hub.js';
import type { InboxRules, RuleEffects } from './inbox-rules.js';
import { OPEN_STATES, type InboxItem, type InboxState, type InboxStore } from './inbox-store.js';
import type { Scene } from './store.js';

// How the inbox is listed: filters, the owner's rules applied on top, the
// sort orders, the link from an item to the scene its agent staged, and the
// spoken briefing for "catch me up".

/** `open` is the older name for `active`. */
export type InboxFilter = 'active' | 'open' | 'needs_you' | 'in_progress' | 'done' | 'later' | 'archive' | 'all';
export type InboxSort = 'smart' | 'recent' | 'agent';
export const INBOX_FILTERS: readonly InboxFilter[] = ['active', 'open', 'needs_you', 'in_progress', 'done', 'later', 'archive', 'all'];

/** An agent counts as still working on something for this long after the owner's last word. */
const WORKING_MS = 2 * 86_400_000;

/**
 * Active: in play right now. Waiting on the owner, new or seen updates, and agents
 * working on what the owner asked. Not parked (later), not finished (done,
 * reacted, dismissed). Replying marks an item read but keeps it active while the
 * agent works; Done or a reaction finishes it.
 */
export function isActive(item: Pick<InboxItem, 'state' | 'status' | 'note' | 'lastActivityAt'>, now: number): boolean {
  if (item.state === 'later' || item.state === 'dismissed') return false;
  if (item.state === 'queued' || item.state === 'heard') return true;
  const finished = item.note !== null && item.note !== 'replied';
  return item.status === 'in_progress' && !finished && now - item.lastActivityAt < WORKING_MS;
}

export interface InboxView extends InboxItem {
  color: string;
  quiet: boolean;
  hidden: boolean;
  labels: string[];
  rules: string[];
  score: number;
  sceneId: string | null;
}

const UNREAD: readonly InboxState[] = ['queued', 'heard'];

function inFilter(item: InboxView, filter: InboxFilter, now: number): boolean {
  const active = isActive(item, now) && !item.hidden;
  switch (filter) {
    case 'active':
    case 'open':
      return active;
    case 'needs_you':
      return active && item.status === 'needs_you' && !item.acked;
    case 'in_progress':
      return active && item.status === 'in_progress';
    case 'done':
      return active && item.status === 'done';
    case 'later':
      return item.state === 'later';
    case 'archive':
      return item.state !== 'later' && !isActive(item, now);
    case 'all':
      return true;
  }
}

/**
 * Smart order: rule priority first, then things waiting on the owner (unless a
 * rule says they're quiet today), then unread, then newest.
 */
function smartKey(item: InboxView): number {
  const urgent = item.status === 'needs_you' && !item.quiet && OPEN_STATES.includes(item.state) && item.state !== 'later' ? 50 : 0;
  const unread = UNREAD.includes(item.state) ? 5 : 0;
  const quiet = item.quiet ? -20 : 0;
  // 👍 seen: still open, but it sits below everything that hasn't been looked at.
  if (item.acked) return item.score - 30;
  return item.score + urgent + unread + quiet;
}

/** The scene an agent staged in this item's conversation. Home-channel scenes belong to the channel's latest item. */
export function sceneFor(item: InboxItem, scenes: Scene[], latestInChannel: (channelId: string) => string | null): string | null {
  if (!item.channelId) return null;
  const inThread = scenes.find((scene) => scene.origin.threadId === item.channelId);
  if (inThread) return inThread.id;
  if (item.kind === 'thread') return null;
  const inChannel = scenes.find((scene) => scene.origin.channelId === item.channelId && !scene.origin.threadId);
  return inChannel && latestInChannel(item.channelId) === item.id ? inChannel.id : null;
}

/**
 * The agent filter. Besides one agent's id (clones match their persona):
 *   @tango      every active Tango agent (excluding historical T3 records)
 */
export function matchesAgent(item: Pick<InboxItem, 'agentId' | 'place'>, key: string | undefined): boolean {
  if (!key) return true;
  const base = (id: string) => id.replace(/-ollama$/, '');
  if (key === '@tango') return item.agentId !== 't3';
  return base(item.agentId) === base(key);
}

/** Everything the agent filter can offer, from all items (not just those in view). */
export function inboxSources(store: InboxStore): { agents: Array<{ id: string; name: string; color: string }> } {
  const agents = new Map<string, { id: string; name: string; color: string }>();
  for (const item of store.list()) {
    const id = item.agentId.replace(/-ollama$/, '');
    if (!agents.has(id)) agents.set(id, { id, name: item.agentName, color: agentColor(item.agentId) });
  }
  return {
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function inboxView(
  store: InboxStore,
  rules: InboxRules,
  scenes: Scene[],
  options: { filter?: InboxFilter; sort?: InboxSort; agentId?: string; now?: number } = {},
): InboxView[] {
  const filter = options.filter ?? 'active';
  const now = options.now ?? Date.now();
  const latest = new Map<string, string | null>();
  const latestInChannel = (channelId: string) => {
    if (!latest.has(channelId)) latest.set(channelId, store.latestInChannel(channelId, ['topic', 'task'])?.id ?? null);
    return latest.get(channelId)!;
  };
  const views = store
    .list()
    .filter((item) => matchesAgent(item, options.agentId))
    .map((item): InboxView => {
      const effects: RuleEffects = rules.effects(item);
      return {
        ...item,
        color: agentColor(item.agentId),
        quiet: effects.quiet,
        hidden: effects.hidden,
        labels: effects.labels,
        rules: effects.rules,
        score: effects.score,
        sceneId: sceneFor(item, scenes, latestInChannel),
      };
    })
    .filter((item) => inFilter(item, filter, now));
  const sort = options.sort ?? 'smart';
  if (sort === 'smart') views.sort((a, b) => smartKey(b) - smartKey(a) || b.lastActivityAt - a.lastActivityAt);
  else if (sort === 'agent') views.sort((a, b) => a.agentName.localeCompare(b.agentName) || b.lastActivityAt - a.lastActivityAt);
  return views;
}

export function inboxCounts(store: InboxStore, rules: InboxRules, agentId?: string): Record<InboxFilter, number> {
  const all = inboxView(store, rules, [], { filter: 'all', agentId });
  const counts = Object.fromEntries(INBOX_FILTERS.map((filter) => [filter, 0])) as Record<InboxFilter, number>;
  const now = Date.now();
  for (const filter of INBOX_FILTERS) counts[filter] = all.filter((item) => inFilter(item, filter, now)).length;
  return counts;
}

function age(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Ranked open items per agent, plus a compact text the operator can read aloud. */
export function briefing(store: InboxStore, rules: InboxRules, now = Date.now()) {
  const open = inboxView(store, rules, [], { filter: 'active', sort: 'smart', now });
  const later = inboxView(store, rules, [], { filter: 'later', sort: 'smart', now });
  const byAgent = new Map<string, { agentId: string; agentName: string; items: InboxView[] }>();
  for (const item of open) {
    const entry = byAgent.get(item.agentId) ?? { agentId: item.agentId, agentName: item.agentName, items: [] };
    entry.items.push(item);
    byAgent.set(item.agentId, entry);
  }
  const agents = [...byAgent.values()].map((entry) => ({
    agentId: entry.agentId,
    agentName: entry.agentName,
    needsYou: entry.items.filter((item) => item.status === 'needs_you' && !item.quiet && !item.acked).length,
    items: entry.items.slice(0, 5).map((item) => ({
      id: item.id,
      summary: item.summary || item.lastText.slice(0, 120),
      status: item.status,
      state: item.state,
      place: item.place,
      quiet: item.quiet,
      seen: item.acked,
      age: age(now - item.lastActivityAt),
    })),
  }));
  const needsYou = open.filter((item) => item.status === 'needs_you' && !item.quiet && !item.acked);
  const line = (item: InboxView) => `${item.agentName}${item.place ? ` (${item.place})` : ''}: ${item.summary || item.lastText.slice(0, 120)}`;
  const parts: string[] = [];
  if (needsYou.length) parts.push(`Waiting on you: ${needsYou.slice(0, 5).map(line).join('; ')}.`);
  const updates = open.filter((item) => !needsYou.includes(item) && item.state === 'queued');
  if (updates.length) parts.push(`New updates: ${updates.slice(0, 5).map(line).join('; ')}.`);
  const seen = open.filter((item) => item.acked);
  if (seen.length) parts.push(`Seen and waiting for you to pick back up: ${seen.slice(0, 3).map(line).join('; ')}.`);
  const working = open.filter((item) => item.status === 'in_progress');
  if (working.length) parts.push(`Agents working on what you asked: ${working.slice(0, 3).map(line).join('; ')}.`);
  if (later.length) parts.push(`Parked for later: ${later.slice(0, 3).map(line).join('; ')}.`);
  return {
    text: parts.length ? parts.join(' ') : 'Nothing is waiting on you and there are no new updates.',
    counts: { open: open.length, needsYou: needsYou.length, later: later.length },
    agents,
  };
}
