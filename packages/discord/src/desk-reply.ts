/**
 * Desk replies: the owner's words typed on the Agent Desk, posted into an agent's Discord channel.
 *
 * In a channel only the owner (and bots) can see, the reply goes out through a channel webhook
 * named and pictured as the owner, so it reads as theirs. The 🖥️ marker stays at the front: it says
 * the words came from the desk, and the desk reads 🖥️-prefixed bot/webhook posts as the owner's.
 * The agent gets the plain words, recorded as the owner's message.
 *
 * Who the owner is (Discord id, name, picture) lives in the profile's `owner.yaml`; the repo is public.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { resolveTangoProfileConfigDir } from "@tango/core";

export const DESK_MARKER = "🖥️";

export interface OwnerPersona {
  discordUserId: string;
  /** The owner's other Discord accounts: they don't make a channel shared. */
  otherDiscordUserIds: string[];
  displayName: string;
  /** Optional; without it the owner's own Discord avatar is used. */
  avatarUrl?: string;
}

const ownerConfigSchema = z.object({
  discord_user_id: z.string().min(1),
  display_name: z.string().min(1),
  other_discord_user_ids: z.array(z.string().min(1)).default([]),
  avatar_url: z.string().url().optional(),
});

export function loadOwnerPersona(profileConfigDir = resolveTangoProfileConfigDir()): OwnerPersona | null {
  const filePath = path.join(profileConfigDir, "owner.yaml");
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = ownerConfigSchema.parse(yaml.load(raw));
  return {
    discordUserId: parsed.discord_user_id.trim(),
    otherDiscordUserIds: parsed.other_discord_user_ids.map((id) => id.trim()),
    displayName: parsed.display_name.trim(),
    ...(parsed.avatar_url ? { avatarUrl: parsed.avatar_url } : {}),
  };
}

// The old relay wrapper. A desk retry re-sent the text it had read back from Discord, wrapper
// included, so it nested ("…(re: "B"):\nThe owner replied from the screen (re: "A"):\n…").
const LEGACY_WRAPPER = /^The owner replied from the screen \(re: "[^\n]*"\):[ \t]*\n?/u;

/** The owner's own words: any 🖥️ marker and old relay wrappers taken off the front. */
export function deskReplyText(text: string): string {
  let rest = text.trim();
  for (;;) {
    const next = rest.startsWith(DESK_MARKER)
      ? rest.slice(DESK_MARKER.length).trimStart()
      : rest.replace(LEGACY_WRAPPER, "").trimStart();
    if (next === rest) return rest;
    rest = next;
  }
}

/** What the desk reply says in the channel: the marker, then the owner's words. */
export function deskReplyContent(text: string): string {
  return text ? `${DESK_MARKER} ${text}` : DESK_MARKER;
}

interface MemberLike {
  id: string;
  user: { bot: boolean };
}

export interface PersonaGuildLike<M extends MemberLike = MemberLike> {
  id: string;
  members: {
    search(options: { query: string; limit: number }): Promise<{ values(): Iterable<M> }>;
    /** One member as of now (current roles), not from cache. */
    fetch(options: { user: string; force: true }): Promise<M>;
  };
}

interface PermissionsLike {
  has(permission: bigint): boolean;
}

export interface PersonaChannelLike<M extends MemberLike = MemberLike> {
  guild: PersonaGuildLike<M>;
  permissionsFor(member: M): PermissionsLike | null;
}

const VIEW_CHANNEL = 1n << 10n;
// Usernames are lowercase letters, digits, "_" and "."; a prefix search on every one of them finds everyone
// without the privileged members intent. Discord rate-limits the search hard, so the sweep runs in the background.
const USERNAME_FIRST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_.";
// Who is in the guild is trusted for ten minutes, and only while the member count (fetched fresh on every
// reply) still matches: a join turns it off at once. Roles aren't trusted at all: each reply fetches every
// other person fresh, since a role change moves no count and the bot gets no member events without the intent.
const MEMBER_LIST_MAX_AGE_MS = 10 * 60_000;

const memberLists = new Map<string, { at: number; count: number; people: string[] }>();
const memberSweeps = new Map<string, Promise<void>>();

/** Sweeps every username prefix for the guild's members (one sweep at a time) and keeps who isn't a bot. */
export function refreshGuildMembers<M extends MemberLike>(guild: PersonaGuildLike<M>, now = Date.now()): Promise<void> {
  const running = memberSweeps.get(guild.id);
  if (running) return running;
  const sweep = (async () => {
    const found = new Map<string, M>();
    try {
      for (const query of USERNAME_FIRST_CHARS) {
        for (const member of (await guild.members.search({ query, limit: 1000 })).values()) found.set(member.id, member);
      }
    } catch {
      memberLists.delete(guild.id);
      return;
    }
    const people = [...found.values()].filter((member) => !member.user.bot).map((member) => member.id);
    memberLists.set(guild.id, { at: now, count: found.size, people });
  })().finally(() => memberSweeps.delete(guild.id));
  memberSweeps.set(guild.id, sweep);
  return sweep;
}

/**
 * True only when no person but the owner (any of their accounts) can see the channel (for a thread, its parent).
 * Without a current member list it answers false and starts a sweep: unknown counts as shared.
 * `memberCount` is the guild's count right now.
 */
export async function isOwnerOnlyChannel<M extends MemberLike>(
  channel: PersonaChannelLike<M>,
  ownerIds: ReadonlySet<string>,
  memberCount: number,
  now = Date.now(),
): Promise<boolean> {
  const list = memberLists.get(channel.guild.id);
  if (!list || list.count !== memberCount || now - list.at >= MEMBER_LIST_MAX_AGE_MS) {
    void refreshGuildMembers(channel.guild, now);
    return false;
  }
  if (!list.people.some((id) => ownerIds.has(id))) return false;
  for (const id of list.people) {
    if (ownerIds.has(id)) continue;
    let member: M;
    try {
      member = await channel.guild.members.fetch({ user: id, force: true });
    } catch {
      // Gone, or the lookup failed: either way the list is stale.
      memberLists.delete(channel.guild.id);
      return false;
    }
    const permissions = channel.permissionsFor(member);
    if (!permissions || permissions.has(VIEW_CHANNEL)) return false;
  }
  return true;
}

export function resetDeskReplyCaches(): void {
  memberLists.clear();
  memberSweeps.clear();
}
