/**
 * Discord voice front end for the live operator: when an owner joins the
 * operator voice channel, the bot joins and bridges the channel to GPT-Live;
 * when the owners leave, it hangs up. Only owners are heard.
 *
 *   node --env-file=.env --import tsx apps/tango-voice/src/testing/live-operator-discord.ts \
 *     --operator <id> [--join-now]
 *
 * --operator reads channel, owners, agents, auth and state from the profile's
 * voice-operator.yaml (docs/guides/voice-operator.md). --channel, --owners,
 * --auth, --logs and --idle-minutes override it.
 *
 * Runs beside the regular voice app on the same bot account. A bot can be in one
 * voice channel per server, so this waits while the bot is in another channel.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType, Client, GatewayIntentBits, type VoiceBasedChannel } from 'discord.js';
import { DiscordAudioBridge } from '../live/discord-audio-bridge.js';
import { createDraftCompiler, createDraftEndJudge, DraftSession } from '../live/draft-mode.js';
import { PAUSE_RECONNECT_NOTE, PauseSession } from '../live/pause-mode.js';
import { DestinationAsk } from '../live/destination-ask.js';
import { AddresseeAsk, FillerGate } from '../live/addressee.js';
import type { LiveSessionClient, LiveTranscriptDelta } from '../live/gpt-live-client.js';
import { LivePlaybackClock, pcmRms, SpeechActivity } from '../live/live-audio.js';
import { buildOperatorInstructions, LiveOperator, parseUrgentLane } from '../live/live-operator.js';
import { clearSessionAnchor, VoiceSessionMemory } from '../live/session-anchor.js';
import { OperatorSessionOwner } from '../live/operator-session.js';
import { parseArgs, resolveOperatorSetup, resolveProfileArg } from './live-operator-setup.js';

const args = parseArgs(process.argv);
const token = process.env.DISCORD_TOKEN ?? '';
const profile = resolveProfileArg(args);
const channelId = args.get('channel') ?? profile?.voiceChannelId ?? '';
if (!token || !channelId) throw new Error('DISCORD_TOKEN and a voice channel (--operator or --channel) are required');
// Only these accounts are heard and can start the operator. Empty (bare --channel
// without --owners) means anyone in the channel, for local experiments only.
const owners = new Set(profile?.ownerUserIds ?? (args.get('owners') ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const isOwner = (userId: string) => owners.size === 0 || owners.has(userId);
const logDir = args.get('logs') ?? (profile ? join(profile.stateDir, 'logs') : join(process.cwd(), 'live-operator-discord-logs'));
mkdirSync(logDir, { recursive: true });
// When the owner joined: a voice session starts clear, and an operator restart mid-call keeps it (TGO-1050).
const anchorFile = join(logDir, 'session-anchor.json');
// The urgent lane, the only unprompted speech: empty unless TANGO_OPERATOR_URGENT names classes (deadline, scene).
const urgentLane = parseUrgentLane(process.env.TANGO_OPERATOR_URGENT);
// Thread routing needs the server id; take it from the voice channel when not configured.
if (!process.env.DISCORD_GUILD_ID && !profile?.guildId) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers: { Authorization: `Bot ${token}` } });
  if (response.ok) process.env.DISCORD_GUILD_ID = ((await response.json()) as { guild_id?: string }).guild_id ?? '';
}
const setup = resolveOperatorSetup(args, process.env.OPENAI_API_KEY ?? '', profile);
const LEAVE_AFTER_MS = 15_000;
// Hang up the GPT-Live side after this long without speech (it wakes on the next words).
const IDLE_MS = Number(args.get('idle-minutes') ?? profile?.idleMinutes ?? 10) * 60_000;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

interface ActiveSession {
  connection: VoiceConnection;
  bridge: DiscordAudioBridge;
  stop(reason: string): Promise<void>;
}

let session: ActiveSession | null = null;
let starting = false;
let leaveTimer: NodeJS.Timeout | null = null;

function console_(message: string): void {
  console.log(`[operator ${new Date().toISOString()}] ${message}`);
}

/** Owners present in the channel; other people there neither start nor keep the operator. */
function humansIn(channel: VoiceBasedChannel): number {
  return channel.members.filter((member) => !member.user.bot && isOwner(member.id)).size;
}

async function operatorChannel(): Promise<VoiceBasedChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
    throw new Error(`${channelId} is not a voice channel`);
  }
  return channel;
}

/**
 * Same workaround as the voice app: some clients send unencrypted audio under
 * DAVE ("UnencryptedWhenPassthroughDisabled"). The DAVE session is recreated on
 * internal networking transitions, so re-apply on those, before subscribing, and
 * on a timer. Returns a function that re-applies immediately.
 */
function enableDavePassthrough(connection: VoiceConnection, log: (kind: string, data?: Record<string, unknown>) => void): () => void {
  type Dave = { session?: { setPassthroughMode(on: boolean, seconds: number): void } };
  type Networking = { state?: { dave?: Dave }; on?(event: string, fn: () => void): void };
  let lastSession: unknown = null;
  let hookedNetworking: unknown = null;
  const apply = () => {
    const networking = (connection.state as { networking?: Networking }).networking;
    if (networking && networking !== hookedNetworking && networking.on) {
      hookedNetworking = networking;
      networking.on('stateChange', apply);
    }
    const session = networking?.state?.dave?.session;
    if (!session) return;
    try {
      session.setPassthroughMode(true, 86_400);
      if (session !== lastSession) log('dave.passthrough', { applied: true });
      lastSession = session;
    } catch (err) {
      log('dave.passthrough', { applied: false, message: (err as Error).message });
    }
  };
  connection.on('stateChange', apply);
  const timer = setInterval(apply, 5000);
  connection.once(VoiceConnectionStatus.Destroyed, () => clearInterval(timer));
  apply();
  return apply;
}

async function startSession(reason: string): Promise<void> {
  if (session || starting) return;
  starting = true;
  try {
    const channel = await operatorChannel();
    // Don't yank the bot out of the regular voice channel; it leaves 30 s after people do.
    for (let waited = 0; ; waited += 5000) {
      const botChannel = channel.guild.members.me?.voice.channelId;
      if (!botChannel || botChannel === channelId) break;
      if (waited === 0) console_(`bot is in another voice channel (${botChannel}); waiting for it to free up`);
      if (waited >= 90_000) throw new Error('bot is busy in another voice channel');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const started = Date.now();
    const memory = new VoiceSessionMemory(anchorFile, { fresh: reason.endsWith(' joined'), now: started });
    const sessionStartedAt = memory.startedAt;
    const logFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const log = (kind: string, data: Record<string, unknown> = {}) => {
      appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - started, kind, ...data })}\n`);
      if (!['said', 'heard'].includes(kind)) console_(`${kind} ${JSON.stringify(data).slice(0, 220)}`);
    };
    log('session.starting', { reason, route: setup.route.label, agents: setup.agents.map((agent) => agent.id), sessionStartedAt, urgentLane });
    // The desk's session trace: one id for the whole voice session (every brain in it), and its lifecycle.
    const traceSessionId = `voice-${new Date(started).toISOString()}`;
    const sessionTrace = (kind: string, summary: string, data: Record<string, unknown> = {}) => {
      try {
        setup.operatorExtras.desk?.trace?.({ kind, summary, data, sessionId: traceSessionId });
      } catch {
        /* tracing never affects the session */
      }
    };
    sessionTrace('session.start', `voice session started (${reason})`, { reason, route: setup.route.label, agents: setup.agents.map((agent) => agent.id) });

    const connection = joinVoiceChannel({
      channelId,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on('error', (err) => log('voice.error', { message: err.message }));
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    const reapplyPassthrough = enableDavePassthrough(connection, log);

    const bridge = new DiscordAudioBridge();
    await bridge.init();
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on('error', (err) => log('player.error', { message: err.message }));
    player.play(createAudioResource(bridge.output, { inputType: StreamType.Opus }));
    connection.subscribe(player);

    // The GPT-Live side ("brain") can sleep while the bot stays in the channel: after
    // IDLE_MS with no speech and nothing pending it hangs up, and the next words wake it.
    // Frames heard while waking are buffered so the first sentence isn't lost.
    interface Brain {
      live: LiveSessionClient;
      operator: LiveOperator;
      userActivity: SpeechActivity;
      playback: LivePlaybackClock;
      closing: boolean;
    }
    // Every brain this session starts goes through the owner, and every exit (drop, sleep,
    // superseded, session end) through owner.retire(): no operator outlives its connection.
    const owner = new OperatorSessionOwner<Brain>(log);
    // Draft mode lives at the session level: a draft survives the brain being replaced.
    const draft = new DraftSession({ compile: createDraftCompiler(setup.models, { people: setup.profile?.people }), judgeEnd: createDraftEndJudge(setup.models), log });
    // Pause mode too ("Tango, pause"): a pause survives the brain being replaced or sleeping.
    // Starting one cuts whatever the operator is saying.
    const pause = new PauseSession({ log, cutAudio: () => bridge.clearOutput() });
    // And a pending "main chat, or the … thread?": the answer may reach the next brain.
    const destination = new DestinationAsk({ now: () => Date.now() });
    // A filler-only "mm" or sniff never draws a reply (addressee.ts); the backend's appends reopen it.
    // Closing it drops audio already queued, and the playback clock with it (Codex review on #481).
    const fillerGate = new FillerGate({
      log,
      onClose: () => {
        bridge.clearOutput();
        owner.current?.playback.cut();
      },
    });
    // And a pending "For me?": the yes may reach the next brain.
    const addressee = new AddresseeAsk({ now: () => Date.now() });
    // The quiet before the owner's speech, and since he last got something done through the operator:
    // both count from the join until he first speaks (Codex review on #481).
    const ownerSpeech: { lastAt: number | null; addressedAt: number | null } = { lastAt: Date.now(), addressedAt: Date.now() };
    let waking: Buffer[] | null = null;
    let stopped = false;
    const presence = new SpeechActivity();
    let lastVoiceAt = Date.now();
    const backend = setup.createBackend(new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''), log);

    const startBrain = async (greeting: string | null): Promise<Brain> => {
      const live = setup.route.create();
      const userActivity = new SpeechActivity();
      const playback = new LivePlaybackClock();
      live.on('audio', (pcm: Buffer) => {
        // Pause mode hook: after the "Paused." confirmation nothing GPT-Live says is played.
        const voiced = pcmRms(pcm) >= 350;
        if (!pause.admitAudio(voiced)) return;
        if (!fillerGate.admitAudio(voiced)) return;
        playback.enqueue(pcm);
        bridge.pushOutput(pcm);
      });
      // Pause mode hook: room talk while paused isn't written to the session log either.
      live.on('inputTranscript', (delta: LiveTranscriptDelta) => {
        if (!pause.active) {
          log('heard', { delta: delta.delta });
          fillerGate.heard(delta.delta);
        }
      });
      live.on('outputTranscript', (delta: LiveTranscriptDelta) => log('said', { delta: delta.delta }));
      const operator = new LiveOperator({
        client: live,
        agents: setup.agents,
        backend,
        extractor: setup.extractor,
        userActivity,
        playback,
        policy: 'floor',
        ...setup.operatorExtras,
        // Results for a brain that is gone (dropped, slept) are relayed by the current one.
        onLateUpdate: (late) => owner.deliverLate(late),
        sessionStartedAt,
        answeredTurns: memory,
        asleepAt: (at) => memory.asleepAt(at),
        urgentLane,
        draft,
        pause,
        destination,
        addressee,
        ownerSpeech,
        fillerGate,
        addresseeCheck: process.env.TANGO_OPERATOR_FOR_ME !== 'off',
        log,
        traceSessionId,
      });
      await live.start({ instructions: buildOperatorInstructions(setup.agents), voice: setup.voice });
      operator.start();
      const created: Brain = { live, operator, userActivity, playback, closing: false };
      live.on('closed', ({ reason: why }: { reason: string }) => {
        if (created.closing || stopped) return;
        log('live.dropped', { reason: why });
        sessionTrace('session.reconnect', `the voice model hung up (${why}): reconnecting if the owner is still here`, { reason: why });
        // The model hung up on its own (expiry, error): retire this brain (its operator's timers,
        // screen handlers and in-flight work), then reconnect if people are still here.
        void owner.retire(created);
        void operatorChannel().then((current) => {
          if (current && humansIn(current) > 0) wake('[The voice connection dropped and you just reconnected. Carry on; do not greet the user.]');
        });
      });
      log('session.start', { sessionId: live.sessionId });
      if (greeting) await live.appendContext('commentary', greeting, null);
      return created;
    };

    const sleepBrain = async () => {
      const current = owner.current;
      if (!current) return;
      // Before the (slow) close: speech meanwhile wakes a new brain, and its wake has to close this span.
      memory.sleep();
      const usage = await owner.retire(current);
      log('sleep', { idleMs: Date.now() - lastVoiceAt, usage });
      sessionTrace('session.sleep', `voice model asleep after ${Math.round((Date.now() - lastVoiceAt) / 1000)} s without speech`, { idleMs: Date.now() - lastVoiceAt });
    };

    // True while any brain is being started (join, wake, or reconnect). Two live
    // sessions at once both play into the channel and sound doubled and robotic.
    let wakeInFlight = false;
    /** Start a new brain; frames arriving meanwhile collect in `waking` and are replayed. */
    const wake = (
      note = '[You just reconnected after the user was quiet for a while, and they started talking while you reconnected; their first words may be cut off. If what you heard sounds incomplete, ask them to repeat it. Do not greet them.]',
    ) => {
      if (owner.current || wakeInFlight || stopped) return;
      wakeInFlight = true;
      waking ??= [];
      log('wake', {});
      sessionTrace('session.wake', 'speech heard: waking the voice model', {});
      void startBrain(null)
        .then((next) => {
          // Refused (and retired) if the session ended or another brain got there first.
          if (stopped || !owner.install(next)) {
            void owner.retire(next);
            return;
          }
          // Awake once the new brain is in (a failed start leaves voice asleep).
          memory.wake();
          // Replay what was said while reconnecting. The subscription route keeps at most
          // ~0.5 s of queued input (to stay low-latency), so the start of a long first
          // sentence can still be lost; let the model know to ask rather than guess.
          for (const frame of waking ?? []) {
            next.userActivity.observe(frame);
            next.live.appendAudio(frame);
          }
          // Pause mode hook: still paused, so not "ask them to repeat it" (the pause re-arms itself on attach).
          void next.live.appendContext('instructions', pause.active ? PAUSE_RECONNECT_NOTE : note, null);
        })
        .catch((err) => log('wake.error', { message: (err as Error).message }))
        .finally(() => {
          waking = null;
          wakeInFlight = false;
        });
    };

    bridge.on('frame', (pcm: Buffer) => {
      presence.observe(pcm);
      if (presence.isActive()) lastVoiceAt = Date.now();
      const brain = owner.current;
      if (brain) {
        brain.userActivity.observe(pcm);
        brain.live.appendAudio(pcm);
      } else if (waking) {
        waking.push(pcm);
        if (waking.length > 400) waking.shift(); // keep the last ~8 s
      } else if (presence.isActive()) {
        waking = [pcm];
        wake();
      }
    });

    const idleTimer = setInterval(() => {
      const brain = owner.current;
      // isIdle() keeps a paused session awake for an hour; after that it may sleep, still paused.
      if (brain && Date.now() - lastVoiceAt > IDLE_MS && brain.operator.isIdle()) void sleepBrain();
    }, 30_000);

    // Every person in the channel is mixed into one stream (GPT-Live is one conversation).
    const subscribed = new Set<string>();
    const botId = client.user?.id;
    const lastResubscribe = new Map<string, number>();
    const listen = (userId: string) => {
      reapplyPassthrough();
      subscribed.add(userId);
      const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      stream.on('data', (packet: Buffer) => void bridge.pushOpus(userId, packet));
      stream.on('error', (err) => log('receive.error', { userId, message: err.message }));
      // A decrypt failure destroys the subscription. Re-subscribe right away (throttled),
      // otherwise the user is unheard until they pause and speaking 'start' fires again.
      stream.on('close', () => {
        subscribed.delete(userId);
        if (stopped || connection.state.status === VoiceConnectionStatus.Destroyed) return;
        const wait = Math.max(0, (lastResubscribe.get(userId) ?? 0) + 500 - Date.now());
        setTimeout(() => {
          if (stopped || subscribed.has(userId)) return;
          lastResubscribe.set(userId, Date.now());
          listen(userId);
        }, wait);
      });
      if (!lastResubscribe.has(userId)) log('speaker', { userId });
    };
    connection.receiver.speaking.on('start', (userId) => {
      if (userId === botId || !isOwner(userId)) return;
      // Discord's own "started speaking" signal: wake a sleeping brain even before audio decodes.
      if (!owner.current && !stopped) wake();
      if (subscribed.has(userId)) return;
      listen(userId);
    });

    wakeInFlight = true;
    try {
      // A restart while voice slept: awake again once this brain is in.
      if (owner.install(await startBrain('The user just joined the voice channel. Greet them in a few words and wait.'))) memory.wake();
    } finally {
      wakeInFlight = false;
    }
    bridge.start();

    const stop = async (why: string) => {
      if (stopped) return;
      stopped = true;
      clearInterval(idleTimer);
      // An unsent draft: said (if the brain can still speak), traced, and kept on the desk card a while.
      draft.end();
      // Ended while paused: traced; held updates stay on the desk as New, and the pill clears.
      pause.end();
      const usage = await owner.end();
      bridge.clearOutput();
      bridge.stop();
      player.stop(true);
      connection.destroy();
      log('session.end', { reason: why, usage, durationMs: Date.now() - started });
      // A restart (shutdown) with the owner still here resumes this session; anything else ends it.
      if (why !== 'shutdown') clearSessionAnchor(anchorFile);
      sessionTrace('session.end', `voice session ended (${why}) after ${Math.round((Date.now() - started) / 60_000)} min`, { reason: why, durationMs: Date.now() - started });
      void (setup.operatorExtras.desk as { flushTrace?: () => Promise<void> } | undefined)?.flushTrace?.();
      if (session?.connection === connection) session = null;
    };
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        void stop('voice disconnected');
      }
    });

    session = { connection, bridge, stop };
  } catch (err) {
    console_(`start failed: ${(err as Error).message}`);
  } finally {
    starting = false;
  }
}

client.on('voiceStateUpdate', (before, after) => {
  const member = after.member ?? before.member;
  if (!member || member.user.bot || !isOwner(member.id)) return;
  if (after.channelId === channelId && before.channelId !== channelId) {
    if (leaveTimer) clearTimeout(leaveTimer);
    leaveTimer = null;
    void startSession(`${member.user.username} joined`);
  } else if (before.channelId === channelId && after.channelId !== channelId) {
    void operatorChannel().then((channel) => {
      if (humansIn(channel) > 0 || leaveTimer) return;
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        void operatorChannel().then((current) => {
          if (humansIn(current) === 0) void session?.stop('everyone left');
        });
      }, LEAVE_AFTER_MS);
    });
  }
});

client.once('clientReady', async () => {
  const channel = await operatorChannel();
  console_(
    `ready as ${client.user?.tag}; watching #${channel.name}${profile ? ` for operator "${profile.id}"` : ''} ` +
      `(${setup.route.label}; agents: ${setup.agents.map((a) => a.id).join(', ')}; owners: ${owners.size ? owners.size : 'anyone'})`,
  );
  if (args.has('join-now') || humansIn(channel) > 0) void startSession(args.has('join-now') ? 'join-now' : 'people already here');
});

const shutdown = async () => {
  await session?.stop('shutdown');
  await client.destroy();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await client.login(token);
