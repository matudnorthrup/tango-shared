import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDescriptor } from '../live/agent-backend.js';
import { resolveProfileAgents, type OperatorProfile } from '../live/operator-profile.js';

// Real Tango agents for operator tests: the -ollama clones, which run in their
// -test channels where post-turn memory extraction is off. They still have real
// tools, so test runs send a read-only guard with every request.

export const READ_ONLY_GUARD =
  '[Voice operator test. Read-only: look things up and answer, but do not send email, change calendars, ' +
  'log food or workouts, buy anything, print, create tasks, or save memories.]';

const CLONES: Array<{ base: string; name: string; role: string }> = [
  { base: 'watson', name: 'Watson', role: 'chief of staff and personal assistant: email, calendar, tasks, life admin' },
  { base: 'sierra', name: 'Sierra', role: 'research specialist: finding things, comparing options, travel, routes, fuel' },
  { base: 'juliet', name: 'Juliet', role: 'therapist educator: psychology, therapeutic frameworks, mental health' },
  { base: 'malibu', name: 'Malibu', role: 'wellness coach: workouts, food and nutrition logging, recovery' },
];

export interface RealTestAgents {
  agents: AgentDescriptor[];
  channelIdFor(agentId: string): string | undefined;
  /** The channel an agent's threads live under. */
  homeChannels: Map<string, string>;
  bridgeUrl: string;
  bridgeApiKey: string;
}

/** Resolves clone channels from the profile overlay and the bridge key from the live checkout's .env. */
export function resolveRealTestAgents(options: { profile?: string; liveEnvPath?: string } = {}): RealTestAgents {
  const profileDir = join(homedir(), '.tango', 'profiles', options.profile ?? 'default', 'config', 'v2', 'agents');
  const channels = new Map<string, string>();
  for (const clone of CLONES) {
    const yaml = readFileSync(join(profileDir, `${clone.base}-ollama.yaml`), 'utf8');
    const channel = /default_channel_id:\s*['"]?(\d+)/.exec(yaml)?.[1];
    if (!channel) throw new Error(`${clone.base}-ollama has no default_channel_id in the profile overlay`);
    channels.set(`${clone.base}-ollama`, channel);
  }
  const bridge = resolveVoiceBridge({ envPath: options.liveEnvPath ?? join(homedir(), 'GitHub', 'tango-worktrees', 'live', '.env') });
  return {
    agents: CLONES.map((clone) => ({ id: `${clone.base}-ollama`, name: clone.name, role: clone.role })),
    channelIdFor: (agentId) => channels.get(agentId),
    homeChannels: channels,
    ...bridge,
  };
}

/**
 * Where the bot's /voice/turn bridge listens and its key: the process
 * environment first (pass the bot's .env with --env-file), else the given
 * .env file, else ./.env.
 */
export function resolveVoiceBridge(options: { envPath?: string } = {}): { bridgeUrl: string; bridgeApiKey: string } {
  let file = '';
  for (const path of [options.envPath, join(process.cwd(), '.env')]) {
    if (path && existsSync(path)) {
      file = readFileSync(path, 'utf8');
      break;
    }
  }
  const read = (name: string) => process.env[name] || (new RegExp(`^${name}=["']?([^"'\\n]*)`, 'm').exec(file)?.[1] ?? '');
  const port = read('TANGO_VOICE_BRIDGE_PORT') || '8787';
  const path = read('TANGO_VOICE_BRIDGE_PATH') || '/voice/turn';
  return { bridgeUrl: `http://127.0.0.1:${port}${path}`, bridgeApiKey: read('TANGO_VOICE_BRIDGE_API_KEY') };
}

/**
 * The person's real agents from their voice operator profile, exactly as normal
 * voice reaches them: session agent:<id>:main and no channelId, so the bot uses
 * each agent's own channel. Turns share real context, memory, and tools. Not for
 * automated tests.
 */
export function resolveOperatorAgents(profile: OperatorProfile): RealTestAgents & { sessionIdFor(agentId: string): string } {
  const { agents, homeChannels } = resolveProfileAgents(profile);
  return {
    agents,
    channelIdFor: () => undefined,
    homeChannels,
    sessionIdFor: (agentId) => `agent:${agentId}:main`,
    ...resolveVoiceBridge(),
  };
}

