import { SerializedAgentBackend, TangoVoiceTurnBackend, type AgentBackend, type AgentDescriptor } from '../live/agent-backend.js';
import { resolveLiveRoute, type LiveRoute } from '../live/create-live-client.js';
import { resolveResponsesCaller, type ResponsesCaller } from '../live/responses-caller.js';
import { createScreenPicker, createTaskExtractor, createVoiceSummarizer, type ScreenPicker, type TaskExtractor } from '../live/task-extractor.js';
import { DiscordThreadDirectory, type ThreadDirectory } from '../live/discord-threads.js';
import { HttpDeskClient, type DeskClient } from '../live/desk-client.js';
import { READ_ONLY_GUARD, resolveOperatorAgents, resolveRealTestAgents } from './real-test-agents.js';
import { loadOperatorProfiles, selectOperatorProfile, type OperatorProfile } from '../live/operator-profile.js';
import { SimulatedLlmAgentBackend } from './simulated-llm-agents.js';
import { HttpScreenDirector, SCREEN_HINT, type ScreenDirector } from '../live/screen-director.js';
import { chiefOfStaff } from '../live/live-operator.js';

// Shared wiring for the browser playground and the Discord operator.
//   --operator [id]                      a person's real agents, owners, channel and state from
//                                        <profile>/config/voice-operator.yaml (docs/guides/voice-operator.md)
//   --auth api | codex[:CODEX_HOME]     who pays for voice and model calls (default: the profile's, else codex)
//   --agents sim | test | main           role-played, -ollama clones, or the real agents (main = --operator)
//   --read-only off                      drop the guard for test clones
//   --screen <url>                       direct the screen service (apps/screen), e.g. http://127.0.0.1:9410;
//                                        its Agent Desk is what the operator reads and marks
//   (--attention / --state are accepted and ignored: attention lives on the desk now)

const SIMULATED_AGENTS: AgentDescriptor[] = [
  { id: 'watson', name: 'Watson', role: 'personal assistant: email, calendar, finances, code reviews and PRs' },
  { id: 'sierra', name: 'Sierra', role: 'research and travel: routes, fuel, places, product comparisons' },
  { id: 'juliet', name: 'Juliet', role: 'therapist educator: psychology, therapeutic frameworks, mental health' },
  { id: 'malibu', name: 'Malibu', role: 'fitness and nutrition coach: workouts, meals, recovery' },
];

export interface OperatorSetup {
  /** The person this operator serves, when run with --operator. */
  profile: OperatorProfile | null;
  route: LiveRoute;
  voice: string;
  models: ResponsesCaller;
  agents: AgentDescriptor[];
  extractor: TaskExtractor;
  /** HTML-safe one-liner describing which agents are behind the operator. */
  modeLabel: string;
  createBackend(sessionTag: string, log?: (event: string, data?: Record<string, unknown>) => void): AgentBackend;
  /** Thread routing, the screen and its desk, and read-back support, when available. */
  operatorExtras: {
    threads?: ThreadDirectory;
    summarize?: (agentId: string, text: string) => Promise<string>;
    /** Screen vs conversation when a conversation opens (relevance over recency). */
    pickScreen?: ScreenPicker;
    homeChannelFor?: (agentId: string) => string | undefined;
    screen?: ScreenDirector;
    /** The Agent Desk on the same screen service: discovery, attention, commands. */
    desk?: DeskClient;
    /** The chief of staff (Watson): unclear requests and judgment calls go here. */
    defaultAgentId?: string;
  };
}

/** The profile named by --operator [id] (or implied by --agents main), else null. */
export function resolveProfileArg(args: Map<string, string>): OperatorProfile | null {
  const operatorArg = args.get('operator');
  if (operatorArg === undefined && args.get('agents') !== 'main') return null;
  return selectOperatorProfile(loadOperatorProfiles(), operatorArg && operatorArg !== 'true' ? operatorArg : undefined);
}

export function resolveOperatorSetup(args: Map<string, string>, apiKey: string, profile = resolveProfileArg(args)): OperatorSetup {
  const auth = args.get('auth') ?? profile?.auth ?? 'codex';
  const route = resolveLiveRoute(auth, apiKey);
  // Routing, summaries, and simulated agents bill the same account as the voice.
  const models = resolveResponsesCaller(auth, apiKey);
  const agentMode = profile ? 'main' : args.get('agents') === 'real' ? 'test' : (args.get('agents') ?? 'sim');
  // Test clones get a read-only guard unless --read-only off. Main agents never do: that's the point.
  const readOnly = agentMode === 'test' && args.get('read-only') !== 'off';
  const main = profile ? resolveOperatorAgents(profile) : null;
  if (main && !main.bridgeApiKey) {
    console.warn(`[operator] no TANGO_VOICE_BRIDGE_API_KEY in the environment; agent turns to ${main.bridgeUrl} will fail if the bot requires one (pass the bot's .env with --env-file)`);
  }
  const test = agentMode === 'test' ? resolveRealTestAgents() : null;
  const real = main ?? test;
  const agents = real?.agents ?? SIMULATED_AGENTS;
  const modeLabel = main
    ? `your <b>real agents</b> (${agents.map((agent) => agent.name).join(', ')}) in their normal voice sessions and channels. Their memory, tools, and actions are real.`
    : test
      ? `<b>real</b> Tango test agents (the -ollama clones, posting in their -test channels). ${readOnly ? 'They have real tools; a read-only guard is sent with every request.' : '<b>Read-only guard is OFF: their tools act for real.</b>'}`
      : `<b>simulated</b> agents behind it. Agent answers are made up.`;
  const token = process.env.DISCORD_TOKEN ?? '';
  const guildId = process.env.DISCORD_GUILD_ID || profile?.guildId || '';
  const summarize = createVoiceSummarizer(models);
  const operatorExtras: OperatorSetup['operatorExtras'] = { summarize, pickScreen: createScreenPicker(models) };
  // The chief of staff for unclear requests; a roster without one (another person's agents) asks instead.
  const chief = chiefOfStaff(agents);
  if (chief) operatorExtras.defaultAgentId = chief.id;
  const screenUrl = args.get('screen') ?? profile?.screenUrl;
  if (screenUrl && screenUrl !== 'off') {
    const base = screenUrl.replace(/\/$/, '');
    const log = (event: string, data?: Record<string, unknown>) => console.log(`[operator] ${event} ${JSON.stringify(data ?? {})}`);
    operatorExtras.screen = new HttpScreenDirector(base, log);
    operatorExtras.desk = new HttpDeskClient(base, { log });
  }
  const screen = operatorExtras.screen;
  if (real) {
    if (token && guildId) operatorExtras.threads = new DiscordThreadDirectory({ token, guildId, homeChannels: real.homeChannels });
    operatorExtras.homeChannelFor = (agentId) => real.homeChannels.get(agentId);
  }
  return {
    profile,
    operatorExtras,
    route,
    voice: args.get('voice') ?? profile?.voice ?? route.defaultVoice,
    models,
    agents,
    extractor: createTaskExtractor(models, { people: profile?.people }),
    modeLabel,
    createBackend(sessionTag, log) {
      if (!real) return new SimulatedLlmAgentBackend({ call: models, agents });
      return new SerializedAgentBackend(new TangoVoiceTurnBackend({
        endpoint: real.bridgeUrl,
        apiKey: real.bridgeApiKey,
        sessionIdFor: main ? main.sessionIdFor : (agentId) => `live-operator-${agentId}-${sessionTag}`,
        channelIdFor: (agentId) => real.channelIdFor(agentId),
        preface: readOnly ? READ_ONLY_GUARD : undefined,
        hint: () => (screen && screen.screensConnected() > 0 ? SCREEN_HINT : undefined),
        summarize,
      }), log, 2000, {
        // A timed-out voice turn is still running until the bot no longer lists its conversation
        // ("agentId|channelId"). An error answer is no answer: the hold goes on (it throws).
        stillRunning: async (conversation) => {
          const response = await fetch(process.env.TANGO_BOT_STATUS_URL ?? 'http://127.0.0.1:9200/status/work', { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error(`status HTTP ${response.status}`);
          const body = (await response.json()) as { voiceTurns?: number; voiceConversations?: string[] };
          if (!body.voiceConversations) return (body.voiceTurns ?? 0) > 0;
          // A home-channel request may be sent with the agent's channel filled in (test clones).
          const [agentId, channelId] = conversation.split('|');
          const resolved = channelId ? null : `${agentId}|${real.channelIdFor(agentId) ?? ''}`;
          return body.voiceConversations.includes(conversation) || (resolved !== null && body.voiceConversations.includes(resolved));
        },
      });
    },
  };
}

export function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(key, 'true');
    else {
      args.set(key, next);
      i += 1;
    }
  }
  return args;
}
