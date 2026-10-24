import { conversationInputUrl } from './desk/conversation-input.js';
import { DictationHistoryStore } from './desk/dictation-history-store.js';
import { voiceSnapshot } from './desk/voice-exchange.js';
import { attachDeskVoice, type DeskVoiceOptions } from './desk/voice.js';
import { itemDetail } from './desk/view.js';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import yaml from 'js-yaml';
import { createApp } from './app.js';
import { DiscordRest } from './discord.js';
import { InboxEngine, type InboxAgent } from './inbox.js';
import { InboxRules } from './inbox-rules.js';
import { InboxStore } from './inbox-store.js';
import { createOllamaSummarizer } from './inbox-summarize.js';
import { createOllamaTopicAssigner } from './inbox-topics.js';
import { SceneChecker } from './check.js';
import { createDesk } from './desk/setup.js';
import type { IntakeChannel } from './desk/source-discord.js';
import { realAvatarUrl } from './desk/agents.js';
import { loomFromEnv } from './desk/source-loom.js';
import { refreshOllamaCatalogInBackground, resolveConfiguredPath, tryResolveOllamaModelName, VoyageEmbeddingProvider } from '@tango/core';
import { AtlasMemoryClient } from '@tango/atlas-memory/memory-client';
import { ollamaChatProvider } from './desk/loom-memory.js';
import { createCoordinatorWriter } from './desk/coordinator.js';
import { createAutoTagger } from './desk/autotag.js';
import { createDeskSummarizer, withDecisionShadow } from './desk/summarize.js';
import { createChapterWriter } from './desk/chapter-writer.js';
import { choiceLabel, Hub, type FallbackRouter } from './hub.js';
import { defaultAssetRoots, SceneStore } from './store.js';
import { GoogleContent } from './google.js';
import { LinearContent, linearKeysFromEnv } from './linear.js';
import { BundleStore } from './bundles.js';
import { PrototypeStore } from './prototypes.js';
import { directCodingScene, loomSceneItemId, routeLoomInput } from './loom-scenes.js';

// 9410: 9310-9390 are the tailnet-site series and 9400 is taken by a
// machine-local Python service. Tailnet access is `tailscale serve
// --set-path /tango-screen`, which proxies to localhost.
const PORT = Number(process.env.SCREEN_PORT ?? 9410);
const HOST = process.env.SCREEN_HOST ?? '127.0.0.1';
const profile = process.env.TANGO_PROFILE?.trim() || 'default';
if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid profile');
// "~/…" expanded the same way the decision judge reads it.
const DATA_DIR = process.env.SCREEN_DATA_DIR?.trim() ? resolveConfiguredPath(process.env.SCREEN_DATA_DIR) : path.join(os.homedir(), '.tango', 'profiles', profile, 'data', 'screen');
// With no operator session, screen input goes to the bot, which posts it in the
// scene's conversation and wakes the agent.
const BOT_INPUT_URL = process.env.TANGO_SCREEN_BOT_URL ?? 'http://127.0.0.1:9200/screen/input';
const BRIDGE_TOKEN = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim() ?? '';
// The Agent Desk (docs/specs/agent-desk.md). Off by default: today's inbox runs untouched.
const DESK_V2 = process.env.SCREEN_DESK === 'v2';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
// dist/main.js and server/main.ts both sit one level under the app.
const publicDir = path.resolve(serverDir, '..', 'public');

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(`[screen ${new Date().toISOString()}] ${event} ${JSON.stringify(data)}`);
}

/** Posts owner input into an agent's conversation through the bot, which wakes the agent. */
async function postToBot(body: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const response = await fetch(conversationInputUrl(BOT_INPUT_URL, body.type, process.env.TANGO_CONVERSATION_SOURCE), {
      method: 'POST',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { 'Content-Type': 'application/json', ...(BRIDGE_TOKEN ? { 'X-Tango-Collaboration-Token': BRIDGE_TOKEN } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) return `failed:bot HTTP ${response.status}`;
    return 'agent';
  } catch (err) {
    // A timeout is ambiguous (the bot may have posted it and been slow to answer); a refused connection is not.
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return `unknown:${(err as Error).message}`;
    return `failed:${(err as Error).message}`;
  }
}

/** A new thread with an agent (the bot's `start` input): the thread's id, or why it didn't start. */
async function startInBot(body: Record<string, unknown>): Promise<{ ok: true; threadId: string; conversationKey?: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(conversationInputUrl(BOT_INPUT_URL, body.type, process.env.TANGO_CONVERSATION_SOURCE), {
      method: 'POST',
      // Uploading images to Discord takes longer than posting words.
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json', ...(BRIDGE_TOKEN ? { 'X-Tango-Collaboration-Token': BRIDGE_TOKEN } : {}) },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { threadId?: string; conversationKey?: string; reason?: string; error?: string } | null;
    if (response.ok && (json?.threadId || json?.conversationKey)) return { ok: true, threadId: json.threadId ?? json.conversationKey!, ...(json.conversationKey ? { conversationKey: json.conversationKey } : {}) };
    return { ok: false, error: json?.reason || json?.error || `the bot answered ${response.status}` };
  } catch (err) {
    return { ok: false, error: `the bot isn't answering (${(err as Error).message})` };
  }
}

// A tap goes back to the scene's own conversation (its thread when it has one), never "the agent's latest".
const fallback: FallbackRouter = async (scene, input) => {
  if (scene.conversationKey?.startsWith('t3:')) return 'failed:T3 is retired; use Loom';
  // A Loom thread's scene: the tap is a new turn in that thread.
  if (loomSceneItemId(scene)) return routeLoomInput(loomReply, scene, input);
  const channelId = scene.origin.threadId ?? scene.origin.channelId;
  if (!channelId && !scene.conversationKey?.startsWith('conv:')) return 'failed:no-conversation';
  return postToBot({
    agentId: scene.agentId,
    channelId,
    threadId: scene.origin.threadId,
    parentChannelId: scene.origin.channelId,
    conversationKey: input.conversationKey,
    commandId: input.commandId,
    sceneId: scene.id,
    sceneTitle: scene.title || scene.summary,
    type: input.type,
    label: input.type === 'choice' ? choiceLabel(scene, input.data) : undefined,
    data: input.data,
  });
};

// ── inbox ────────────────────────────────────────────────────────────────
// The owner's agents and their home channels: names from the repo config, the
// channel from the profile overlay (real ids never live in the repo).
const INBOX_AGENTS = (process.env.SCREEN_INBOX_AGENTS ?? 'watson,sierra,victor,malibu,papa,foxtrot,juliet,charlie')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profileDir = path.join(os.homedir(), '.tango', 'profiles', profile);

function readYaml(file: string): Record<string, unknown> | null {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function inboxAgents(): InboxAgent[] {
  const agents: InboxAgent[] = [];
  for (const id of INBOX_AGENTS) {
    let overlay = '';
    try {
      overlay = fs.readFileSync(path.join(profileDir, 'config', 'v2', 'agents', `${id}.yaml`), 'utf8');
    } catch {
      continue; // no profile overlay: not one of this owner's agents here
    }
    // Same lookup the voice operator uses (real-test-agents.ts).
    const homeChannelId = /default_channel_id:\s*['"]?(\d+)/.exec(overlay)?.[1];
    const repo = readYaml(path.join(repoDir, 'config', 'v2', 'agents', `${id}.yaml`));
    if (!homeChannelId) continue;
    const name = typeof repo?.display_name === 'string' ? repo.display_name : id.charAt(0).toUpperCase() + id.slice(1);
    // Its picture: the profile's avatar_url (the real one), else the repo's (a placeholder in the public
    // repo, which realAvatarUrl drops), with the repo's avatar file behind either.
    const overlayUrl = realAvatarUrl(/^avatar_url:\s*['"]?([^'"\s]+)/m.exec(overlay)?.[1]);
    // The file backs a URL that stops working (Discord's attachment links expire).
    const configured = typeof repo?.avatar_path === 'string' ? path.join(repoDir, repo.avatar_path) : path.join(repoDir, 'agents', 'assistants', id, 'avatar.png');
    const file = fs.existsSync(configured) ? configured : null;
    const url = overlayUrl ?? realAvatarUrl(repo?.avatar_url);
    const avatar = url || file ? { url, file } : null;
    agents.push({ id, name, homeChannelId, avatar });
  }
  return agents;
}

/**
 * Intake channels: where a website form's webhook posts requests for an agent (the bot's own
 * intake-webhooks.yaml, read from the profile only: the repo's copy is placeholders).
 */
function intakeChannels(): IntakeChannel[] {
  const entries = readYaml(path.join(profileDir, 'config', 'intake-webhooks.yaml'))?.intake_webhooks;
  const byChannel = new Map<string, IntakeChannel>();
  for (const entry of Array.isArray(entries) ? (entries as Array<Record<string, unknown>>) : []) {
    const [channelId, agentId, webhookId, label] = [entry.channel_id, entry.agent_id, entry.webhook_id, entry.label].map((v) => String(v ?? '').trim());
    if (!channelId || !agentId || !webhookId) continue;
    const channel = byChannel.get(channelId) ?? { channelId, agentId, label: label || 'intake', webhookIds: [] };
    // A channel is one agent's conversation on the desk: a webhook for another agent there isn't shown.
    if (channel.agentId !== agentId) {
      log('desk.intake.skipped', { channelId, agentId, reason: `channel belongs to ${channel.agentId}` });
      continue;
    }
    channel.webhookIds.push(webhookId);
    byChannel.set(channelId, channel);
  }
  return [...byChannel.values()];
}

/** Isolated agents : kept out of desk mail entirely. */
function isolatedAgents(): string[] {
  const dir = path.join(repoDir, 'config', 'v2', 'agents');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.yaml'));
  } catch {
    return [];
  }
  return files.filter((file) => readYaml(path.join(dir, file))?.isolated === true).map((file) => file.replace(/\.yaml$/, ''));
}

// Image/video scenes import only from the profile data dir, artifacts, temp and SCREEN_ASSET_ROOTS.
const store = new SceneStore(DATA_DIR, Date.now, defaultAssetRoots(path.join(profileDir, 'data')));
const bundles = new BundleStore(path.join(DATA_DIR, 'bundles'));
const prototypes = new PrototypeStore(store.db);
const google = new GoogleContent({
  dir: path.join(DATA_DIR, 'google'),
  accounts: process.env.SCREEN_GOOGLE_ACCOUNTS ? process.env.SCREEN_GOOGLE_ACCOUNTS.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
});
// Every LINEAR_API_KEY / LINEAR_API_KEY_<NAME>; each serves the workspace it belongs to.
const linear = new LinearContent({ keys: linearKeysFromEnv(process.env) });
const hub = new Hub(store, fallback, log, undefined, undefined, { direct: directCodingScene, prototypes });
const discordToken = process.env.DISCORD_TOKEN ?? '';
const discord = discordToken ? new DiscordRest(discordToken) : null;
const rules = new InboxRules(process.env.SCREEN_INBOX_RULES ?? path.join(profileDir, 'config', 'screen', 'inbox-rules.yaml'));
const agents = process.env.SCREEN_INBOX === 'off' ? [] : inboxAgents();
const inboxStore = new InboxStore(store.db);
const engine = new InboxEngine({
  store: inboxStore,
  discord,
  agents,
  // The owner's Discord accounts; only their replies and reactions count as read.
  ownerIds: (process.env.TANGO_OWNER_DISCORD_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
  rules,
  summarize: createOllamaSummarizer({
    apiKey: process.env.OLLAMA_API_KEY ?? '',
    model: process.env.SCREEN_INBOX_MODEL ?? 'deepseek-v4.1-flash',
    baseUrl: process.env.OLLAMA_BASE_URL,
  }),
  assignTopic: createOllamaTopicAssigner({
    apiKey: process.env.OLLAMA_API_KEY ?? '',
    model: process.env.SCREEN_INBOX_MODEL ?? 'deepseek-v4.1-flash',
    baseUrl: process.env.OLLAMA_BASE_URL,
  }),
  onChange: (ids) => hub.inboxChanged(ids),
  log,
});
function loomMemoryFromEnv() {
  if (process.env.SCREEN_LOOM_MEMORY === 'off' || !process.env.OLLAMA_API_KEY) return null;
  let atlas: AtlasMemoryClient;
  try {
    atlas = new AtlasMemoryClient(process.env.ATLAS_MEMORY_DB || undefined);
  } catch (error) {
    log('loom-memory.off', { reason: error instanceof Error ? error.message.split('\n')[0] : String(error) });
    return null;
  }
  const apiKey = process.env.OLLAMA_API_KEY;
  return {
    provider: ollamaChatProvider({
      apiKey,
      baseUrl: process.env.OLLAMA_BASE_URL,
      resolveModel: (model: string) => {
        refreshOllamaCatalogInBackground(apiKey, process.env.OLLAMA_BASE_URL);
        return tryResolveOllamaModelName(model);
      },
    }),
    model: process.env.SCREEN_LOOM_MEMORY_MODEL || 'role:memory-extraction',
    atlas,
  };
}

const desk = DESK_V2
  ? createDesk({
      db: store.db,
      hub,
      discord,
      agents,
      intake: intakeChannels(),
      ownerIds: (process.env.TANGO_OWNER_DISCORD_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
      rules,
      summarize: withDecisionShadow(createDeskSummarizer({
        apiKey: process.env.OLLAMA_API_KEY ?? '',
        model: process.env.SCREEN_INBOX_MODEL ?? 'deepseek-v4.1-flash',
        baseUrl: process.env.OLLAMA_BASE_URL,
        timeZone: process.env.SCREEN_TZ || 'America/Los_Angeles',
      })),
      autoTag:
        process.env.SCREEN_DESK_AUTOTAG === 'off' || !process.env.OLLAMA_API_KEY
          ? undefined
          : createAutoTagger({ apiKey: process.env.OLLAMA_API_KEY ?? '', model: process.env.SCREEN_INBOX_MODEL ?? 'deepseek-v4.1-flash', baseUrl: process.env.OLLAMA_BASE_URL }),
      coordinatorWriter: createCoordinatorWriter({
        apiKey: process.env.OLLAMA_API_KEY ?? '',
        model: process.env.SCREEN_COORDINATOR_MODEL || process.env.SCREEN_INBOX_MODEL || 'deepseek-v4.1-flash',
        baseUrl: process.env.OLLAMA_BASE_URL,
      }),
      coordinatorRepo: process.env.SCREEN_COORDINATOR_REPO || undefined,
      chapterWriter: createChapterWriter({
        apiKey: process.env.OLLAMA_API_KEY ?? '',
        model: process.env.SCREEN_COORDINATOR_MODEL || process.env.SCREEN_INBOX_MODEL || 'deepseek-v4.1-flash',
        baseUrl: process.env.OLLAMA_BASE_URL,
      }),
      mailBlockedAgents: isolatedAgents(),
      postToBot,
      startInBot,
      loom: loomFromEnv(),
      // Loom threads' memory (docs/specs/loom-context-management.md): extraction on the memory-extraction role.
      // Atlas failing to open (a missing native build) turns capture off; it never takes the desk down.
      loomMemory: loomMemoryFromEnv(),
      t3AttachmentsDir: process.env.SCREEN_T3_ATTACHMENTS_DIR || path.join(os.homedir(), '.t3', 'userdata', 'attachments'),
      jobsDir: process.env.SCREEN_BACKGROUND_JOBS_DIR ?? path.join(profileDir, 'data', 'background-jobs'),
      agentctlDir: process.env.AGENTIC_STATE_HOME ?? path.join(os.homedir(), '.local', 'state', 'agentic'),
      schedulesDb: process.env.SCREEN_SCHEDULES_DB ?? path.join(profileDir, 'data', 'tango.sqlite'),
      // The System page's ledger (docs/specs/system-visibility.md): `off` leaves the page out.
      systemActions: process.env.SCREEN_SYSTEM_ACTIONS === 'dry' ? 'dry' : 'live',
      systemFixProject: process.env.SCREEN_SYSTEM_FIX_PROJECT?.trim() || undefined,
      systemFixRepo: process.env.SCREEN_SYSTEM_FIX_REPO?.trim() || undefined,
      systemDb: process.env.SCREEN_SYSTEM_DB === 'off' ? false : process.env.SCREEN_SYSTEM_DB?.trim() ? resolveConfiguredPath(process.env.SCREEN_SYSTEM_DB) : undefined,
      avatarsDir: path.join(DATA_DIR, 'agent-avatars'),
      jobBridgeUrl: process.env.TANGO_BACKGROUND_JOB_BRIDGE_URL ?? 'http://127.0.0.1:9200/background-jobs',
      collaborationToken: BRIDGE_TOKEN,
      githubReviews: process.env.SCREEN_DESK_GITHUB !== 'off',
      log,
      discordPollMs: Number(process.env.SCREEN_INBOX_POLL_MS ?? 45_000),
      botStatusUrl: process.env.TANGO_BOT_STATUS_URL ?? 'http://127.0.0.1:9200/status/work',
      startWorkReposFile: process.env.SCREEN_START_WORK_REPOS || undefined,
      startWorkPolicyFile: process.env.SCREEN_START_WORK_POLICY ?? path.join(profileDir, 'config', 'screen', 'start-work.yaml'),
      usageUrl: process.env.SCREEN_USAGE_URL || undefined,
      usageAliasesFile: process.env.USAGE_UI_PROFILE_ALIASES ?? path.join(profileDir, 'usage-monitor', 'profile-aliases.json'),
      // Semantic search: 512 dimensions keeps every vector in memory (int8) at a few tens of MB.
      searchEmbedder: process.env.VOYAGE_API_KEY?.trim() && process.env.SCREEN_SEARCH_SEMANTIC !== 'off'
        ? new VoyageEmbeddingProvider({ apiKey: process.env.VOYAGE_API_KEY, model: process.env.SCREEN_SEARCH_MODEL || 'voyage-4-lite', outputDimension: 512, timeoutMs: 30_000 })
        : null,
    })
  : null;

/** A tap on a Loom thread's scene becomes a new user turn in that thread (the fallback router above). */
const loomReply = desk?.loom
  ? async (itemId: string, text: string, commandId?: string) => {
      const item = desk.core.store.item(itemId);
      if (!item) return { ok: false as const, error: 'that Loom thread is not on the desk' };
      return desk.loom!.reply(item, text, commandId ? { commandId } : {});
    }
  : null;
const checker = new SceneChecker(path.join(DATA_DIR, 'checks'));
const voice: DeskVoiceOptions | undefined = desk ? {
  dataDir: DATA_DIR,
  item: id => desk.core.item(id),
  snapshot: id => {
    const detail = itemDetail(desk.core, id, [], []);
    return voiceSnapshot(detail);
  },
} : undefined;
// Never derive this from SCREEN_DATA_DIR: scenes, artifacts and indexed data are not private storage.
let dictationHistory: DictationHistoryStore | undefined;
if (desk) {
  try {
    const privateDir = path.join(profileDir, 'private');
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(profileDir).isSymbolicLink() || fs.lstatSync(privateDir).isSymbolicLink()) throw new Error('private_path_required');
    fs.chmodSync(privateDir, 0o700);
    dictationHistory = new DictationHistoryStore(path.join(privateDir, 'dictation-history.noindex'));
  } catch { log('history.unavailable'); } // Fail history closed without taking the rest of the desk down.
}
if (voice) voice.dictationHistory = dictationHistory;
const historySweep = dictationHistory ? setInterval(() => {
  try { dictationHistory.sweep(); } catch { log('history.maintenance-failed'); }
}, 60_000) : undefined;
historySweep?.unref();
const app = createApp({
  dictationHistory,
  voice,
  store,
  hub,
  publicDir,
  bundles,
  prototypes,
  google,
  linear,
  inbox: desk ? undefined : {
    engine,
    rules,
    reply: ({ agentId, channelId, text, title }) =>
      postToBot({ agentId, channelId, sceneTitle: title, type: 'reply', data: { text } }),
    react: async (channelId, messageId, emoji) => {
      if (!discord) throw new Error('DISCORD_TOKEN is not set');
      await discord.react(channelId, messageId, emoji);
    },
  },
  desk: desk ? { routes: { ...desk.routes, scenes: () => hub.liveScenes(), prototypes: () => prototypes.live() }, compat: desk.compat } : undefined,
  onSlowRequest: desk
    ? ({ method, path, ms, waitedMs }) =>
        desk.trace.record({
          source: 'desk',
          kind: 'server.slow-request',
          summary: `${method} ${path} took ${ms} ms${waitedMs !== null ? `, ${waitedMs} ms after the screen sent it` : ''}`,
          data: { method, path, ms, waitedMs },
        })
    : undefined,
  check: (sceneId, version) => checker.check(`http://127.0.0.1:${PORT}/frame/${sceneId}?v=${version}`, `${sceneId}-v${version}`),
  checkPrototype: (prototype) => checker.check(`http://127.0.0.1:${PORT}/${prototype.url}`, `${prototype.id}-v${prototype.version}`, { glance: false }),
});

const sweep = () => {
  try {
    hub.removed(store.sweep(), 'expired');
    hub.prototypesRemoved(prototypes.sweep(), 'expired');
    bundles.sweep(new Set([...store.bundleIds(), ...prototypes.bundleIds()]));
  } catch (err) {
    log('sweep.error', { message: (err as Error).message });
  }
};
setInterval(sweep, 60_000).unref();
sweep();

if (desk) {
  log('desk.start', { agents: agents.map((agent) => agent.id), discord: Boolean(discord) });
  desk.start();
} else if (discord && agents.length) {
  log('inbox.agents', { agents: agents.map((agent) => agent.id), rules: rules.path });
  const pollMs = Number(process.env.SCREEN_INBOX_POLL_MS ?? 45_000);
  const poll = () => void engine.poll().then((result) => result.messages && log('inbox.poll', result));
  setTimeout(poll, 2000).unref();
  setInterval(poll, pollMs).unref();
  setInterval(() => void engine.checkReactions(), 3 * 60_000).unref();
  setInterval(() => engine.store.prune(), 3_600_000).unref();
  // Chat topics settle once they go quiet past the end of their day.
  setInterval(() => engine.settleQuiet(), 10 * 60_000).unref();
  // Self-check: heal what races left behind (empty answers, placeholders, stale "in progress").
  const repair = () => void engine.repair().catch((err) => log('inbox.repair.error', { message: (err as Error).message }));
  setTimeout(repair, 30_000).unref();
  setInterval(repair, 10 * 60_000).unref();
} else {
  log('inbox.disabled', { reason: discord ? 'no agents with a home channel' : 'DISCORD_TOKEN is not set' });
}

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => log('listening', { url: `http://${HOST}:${PORT}`, dataDir: DATA_DIR }));

const closeVoice = voice ? attachDeskVoice(httpServer as import('node:http').Server, app, voice) : undefined;

const shutdown = async () => {
  if (historySweep) clearInterval(historySweep);
  closeVoice?.();
  engine.close();
  desk?.close();
  hub.close();
  await checker.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
