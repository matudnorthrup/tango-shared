import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadLayeredV2AgentConfigs, resolveTangoProfileConfigDir, resolveTangoProfileDataDir } from '@tango/core';
import type { AgentDescriptor } from './agent-backend.js';
import type { KnownPerson } from './known-names.js';

// Who a voice operator serves, read from the profile layer
// (<profile>/config/voice-operator.yaml) so each install configures its own
// people, channel, and agents without code changes. See docs/guides/voice-operator.md.

export interface OperatorProfile {
  id: string;
  /** Discord voice channel; someone listed in ownerUserIds joining it starts the operator. */
  voiceChannelId: string;
  /** Only these Discord accounts are heard, and only their replies and reactions mark items read. */
  ownerUserIds: string[];
  /** Agents the operator may delegate to, with optional spoken role hints. */
  agents: Array<{ id: string; role?: string }>;
  /** api | codex | codex:<CODEX_HOME>; who pays for the voice and the routing calls. */
  auth: string;
  voice?: string;
  idleMinutes: number;
  /** Screen service to direct (apps/screen), if this person uses one. */
  screenUrl?: string;
  guildId?: string;
  /** People the owner talks about, so speech-to-text spellings of their names are corrected before agents see them. */
  people?: KnownPerson[];
  /** Session logs. (Older installs also kept attention.json and touched-threads.json here; both are unused now.) */
  stateDir: string;
}

export function operatorConfigPath(): string {
  return process.env.TANGO_VOICE_OPERATOR_CONFIG ?? join(resolveTangoProfileConfigDir(), 'voice-operator.yaml');
}

type RawProfile = Record<string, unknown>;

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function ids(value: unknown, field: string, profileId: string): string[] {
  if (!Array.isArray(value)) throw new Error(`voice operator "${profileId}": ${field} must be a list`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function parseOperatorProfiles(text: string, source = 'voice-operator.yaml'): OperatorProfile[] {
  const doc = yaml.load(text) as { operators?: RawProfile[] } | undefined;
  const raw = doc?.operators;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${source}: expected a non-empty "operators" list`);
  const seen = new Set<string>();
  return raw.map((entry) => {
    const id = String(entry.id ?? '').trim();
    if (!id) throw new Error(`${source}: every operator needs an id`);
    if (seen.has(id)) throw new Error(`${source}: duplicate operator id "${id}"`);
    seen.add(id);
    const voiceChannelId = String(entry.voice_channel_id ?? '').trim();
    if (!voiceChannelId) throw new Error(`voice operator "${id}": voice_channel_id is required`);
    const ownerUserIds = ids(entry.owner_user_ids, 'owner_user_ids', id);
    // Without owners anyone who can join the channel would drive these agents.
    if (ownerUserIds.length === 0) throw new Error(`voice operator "${id}": owner_user_ids must list at least one Discord user`);
    if (!Array.isArray(entry.agents) || entry.agents.length === 0) throw new Error(`voice operator "${id}": agents must list at least one agent id`);
    const agents = (entry.agents as unknown[]).map((agent) => {
      if (typeof agent === 'string') return { id: agent };
      const item = agent as { id?: unknown; role?: unknown };
      if (!item?.id) throw new Error(`voice operator "${id}": each agent needs an id`);
      return { id: String(item.id), ...(item.role ? { role: String(item.role) } : {}) };
    });
    const people = Array.isArray(entry.people)
      ? (entry.people as unknown[]).map((person) => {
          const item = (typeof person === 'string' ? { name: person } : person) as { name?: unknown; note?: unknown; heard_as?: unknown };
          if (!item?.name) throw new Error(`voice operator "${id}": each person needs a name`);
          return {
            name: String(item.name).trim(),
            ...(item.note ? { note: String(item.note) } : {}),
            ...(item.heard_as ? { heardAs: ids(item.heard_as, 'people[].heard_as', id) } : {}),
          };
        })
      : [];
    return {
      id,
      voiceChannelId,
      ownerUserIds,
      agents,
      auth: String(entry.auth ?? 'codex'),
      ...(entry.voice ? { voice: String(entry.voice) } : {}),
      idleMinutes: Number(entry.idle_minutes ?? 10),
      ...(entry.screen_url ? { screenUrl: String(entry.screen_url) } : {}),
      ...(entry.guild_id ? { guildId: String(entry.guild_id) } : {}),
      ...(people.length ? { people } : {}),
      stateDir: entry.state_dir ? expandHome(String(entry.state_dir)) : join(resolveTangoProfileDataDir(), 'voice-operator', id),
    };
  });
}

export function loadOperatorProfiles(path = operatorConfigPath()): OperatorProfile[] {
  if (!existsSync(path)) throw new Error(`No voice operator config at ${path}. See docs/guides/voice-operator.md.`);
  return parseOperatorProfiles(readFileSync(path, 'utf8'), path);
}

/** Picks one profile: the named one, or the only one. */
export function selectOperatorProfile(profiles: OperatorProfile[], id?: string): OperatorProfile {
  if (id) {
    const found = profiles.find((profile) => profile.id === id);
    if (!found) throw new Error(`No voice operator "${id}" (have: ${profiles.map((profile) => profile.id).join(', ')})`);
    return found;
  }
  if (profiles.length !== 1) throw new Error(`Several voice operators are configured; pick one with --operator (${profiles.map((profile) => profile.id).join(', ')})`);
  return profiles[0];
}

export interface AgentConfigLike {
  id: string;
  enabled?: boolean;
  displayName: string;
  type: string;
  voice?: { callSigns?: string[] };
  discord?: { defaultChannelId?: string };
  responsibilities?: Array<{ description: string }>;
}

export interface ProfileAgents {
  agents: AgentDescriptor[];
  /** Home channel per agent; its threads are what the operator can route into. */
  homeChannels: Map<string, string>;
}

/** Builds the operator's roster from the install's own agent configs (repo defaults plus profile overlays). */
export function resolveProfileAgents(
  profile: OperatorProfile,
  configs: Map<string, AgentConfigLike> = loadLayeredV2AgentConfigs() as unknown as Map<string, AgentConfigLike>,
): ProfileAgents {
  const homeChannels = new Map<string, string>();
  const agents = profile.agents.map(({ id, role }) => {
    const config = configs.get(id);
    if (!config) throw new Error(`voice operator "${profile.id}": no agent config for "${id}"`);
    if (config.enabled === false) throw new Error(`voice operator "${profile.id}": agent "${id}" is disabled on this install`);
    const channel = config.discord?.defaultChannelId;
    if (channel) homeChannels.set(id, channel);
    const name = config.displayName;
    const aliases = (config.voice?.callSigns ?? []).filter((sign) => sign.toLowerCase() !== name.toLowerCase());
    return {
      id,
      name,
      ...(aliases.length ? { aliases } : {}),
      role: role ?? config.responsibilities?.[0]?.description ?? `${config.type} agent`,
    };
  });
  return { agents, homeChannels };
}
