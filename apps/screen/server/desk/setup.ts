import { configuredAPNs } from '../apns.js';
import { DeskDevices } from './devices.js';
import { DeskPush } from './push.js';
import { DeskTangoSource } from './source-tango.js';
import { DeskThreadPrs } from './thread-prs.js';
import { LoomMemoryCapture } from './loom-memory.js';
import type { ChatProvider } from '@tango/atlas-memory/capture';
import type { AtlasMemoryClient } from '@tango/atlas-memory/memory-client';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DiscordRest } from '../discord.js';
import type { Hub } from '../hub.js';
import type { InboxAgent } from '../inbox.js';
import type { InboxRules } from '../inbox-rules.js';
import type { InboxCompatOptions } from './compat.js';
import { DeskCore, type BotWork, type DeskSourceAdapter } from './core.js';
import { migrateInboxDecisions } from './migrate.js';
import { readSnoozeTimes, type DeskRoutesOptions } from './routes.js';
import { AgentAvatars } from './agents.js';
import { ProjectCoordinators, readCoordinators, type CoordinatorWriter } from './coordinator.js';
import { followLedger } from './feed-ledger.js';
import { DeskFeed, type NewFeedPost } from './feed.js';
import { holderOf, readProjects } from './projects.js';
import { DeskMail } from './mail.js';
import { DeskDiscordSource, type IntakeChannel } from './source-discord.js';
import { DeskGitHubReviews } from './source-github.js';
import { DeskJobsSource } from './source-jobs.js';
import { DeskAgentctlSource } from './source-agentctl.js';
import { DeskSchedulesSource } from './source-schedules.js';
import { DeskLoomSource } from './source-loom.js';
import { DeskDecided } from './decided.js';
import { Capacity } from './capacity.js';
import { DeskSystem } from './system.js';
import { spaceOf } from './query.js';
import { DeskUpdates, SYSTEM_SPACE, UNFILED_SPACE, type ChapterWriter } from './updates.js';
import { AgentStart } from './agent-start.js';
import { readStartRepos, repoForDir, StartWork } from './start-work.js';
import { UsageMonitor } from './start-work-accounts.js';
import { DeskSearch, type SearchEmbedder } from './search.js';
import { watchStalls } from './stalls.js';
import { DeskStore } from './store.js';
import { DeskTrace } from './trace.js';
import type { AutoTagger } from './autotag.js';
import type { DeskSummarizer } from './summarize.js';
import { DiscordLoomLinks } from './discord-loom-links.js';
import type { Log } from './types.js';

// Wires the desk for the running service (SCREEN_DESK=v2): store, core,
// sources, timers, and the options app.ts needs for the routes and the
// /api/inbox compatibility shim.

export interface DeskSetupOptions {
  db: DatabaseSync;
  /** Disable all APNs configuration and network access in sandbox desks. */
  push?: false;
  hub: Hub;
  discord: DiscordRest | null;
  agents: InboxAgent[];
  /** Intake channels whose requests show as threads of their agent (the profile's intake-webhooks.yaml). */
  intake?: IntakeChannel[];
  ownerIds: string[];
  rules: InboxRules | null;
  summarize: DeskSummarizer;
  /** Guesses a new Loom thread's type and stage (desk/autotag.ts); none = no guessing. */
  autoTag?: AutoTagger;
  postToBot: (body: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<string>;
  /** A new thread with an agent through the bot (Start work on an agent); absent: agents aren't offered there. */
  startInBot?: (body: Record<string, unknown>) => Promise<{ ok: true; threadId: string; conversationKey?: string } | { ok: false; error: string }>;
  /** Loom's API and token file (source-loom.ts loomFromEnv); none = no Loom threads on the desk. */
  loom?: { url: string; tokenFile: string; accountsFile?: string } | null;
  /** Loom threads' memory capture (loom-memory.ts): the extraction model, its service and the Atlas store. Absent: off. */
  loomMemory?: { provider: ChatProvider; model: string; atlas: Pick<AtlasMemoryClient, 'memoryAdd'> } | null;
  /** Retired T3's stored images, served read-only for retained messages; none = not served. */
  t3AttachmentsDir?: string;
  jobsDir: string;
  /** agentctl's task state (~/.local/state/agentic): Codex workers under the conversation that dispatched them; none = not read. */
  agentctlDir?: string;
  /** The bot's database (tango.sqlite): its schedules' runs, shown as jobs under their agents; none = no jobs. */
  schedulesDb?: string;
  /** The system ledger (SCREEN_SYSTEM_DB; default: @tango/system's own path). `false`: no System page. */
  systemDb?: string | false;
  /** `dry`: the System page's job and process actions touch nothing (SCREEN_SYSTEM_ACTIONS=dry, for a desk on a copy). */
  systemActions?: 'live' | 'dry';
  /** The desk project (id or name) Fix starts its cleanup workers in (SCREEN_SYSTEM_FIX_PROJECT); default: the one named Tango. */
  systemFixProject?: string;
  /** Their repo, as Start work names it (SCREEN_SYSTEM_FIX_REPO); default `tango`. */
  systemFixRepo?: string;
  /** How often the System page's ledger is read for items, the feed and open pages (default 30 s). */
  systemPollMs?: number;
  /** Where agents' pictures are kept (desk/agents.ts); none kept when omitted. */
  avatarsDir?: string;
  /** The bot's background-job bridge (cancel on Done with stopJob). */
  jobBridgeUrl: string;
  collaborationToken: string;
  log: Log;
  /** PR review state through `gh` (skipped silently when gh isn't signed in). Default on. */
  githubReviews?: boolean;
  /** The catch-up ledger (desk/updates.ts); false leaves it out. */
  updates?: boolean;
  /** Merged PRs for the ledger through gh (default: when PR reviews are read). */
  updatesGh?: boolean;
  /** Writes each space's chapter headline and status (desk/chapter-writer.ts); absent, chapters keep what leads note. */
  chapterWriter?: ChapterWriter;
  discordPollMs?: number;
  conversationMode?: 'shadow' | 'tango';
  conversationUrl?: string;
  /** Isolated tests can supply a fake bot transport. */
  conversationFetch?: typeof fetch;
  /** The bot's GET /status/work, for closing orphaned turns (TANGO_BOT_STATUS_URL). */
  botStatusUrl?: string;
  /** Optional native repo catalog; otherwise discover local GitHub repositories. */
  startWorkReposFile?: string;
  /** Start work's account policy (profile layer: account names are private); none = Loom's defaults. */
  startWorkPolicyFile?: string;
  /** The usage monitor's snapshot (apps/usage-ui GET /api/usage), for accounts chosen from a pool. */
  usageUrl?: string;
  /** The usage monitor's profile-aliases.json, to match its signed-out errors to configured accounts. */
  usageAliasesFile?: string;
  /** Embeds text for semantic search (Voyage); none = keyword search only. */
  searchEmbedder?: SearchEmbedder | null;
  /** Writes a project coordinator's "Where it stands" and morning digest (desk/coordinator.ts). */
  coordinatorWriter?: CoordinatorWriter;
  /** The former project-coordinator workspace (default tango). */
  coordinatorRepo?: string;
  /** Agents that neither send nor receive desk mail (isolated agents: config/v2/agents `isolated: true`). */
  mailBlockedAgents?: string[];
}

/** Errors from sources and timers ("desk.discord.poll.error", "desk.loom.error", …) also go to the trace, at most once a minute each. */
const SOURCE_ERROR = /^desk\..*error$|^desk\.writeback\.failed$/;
const SOURCE_ERROR_EVERY_MS = 60_000;

export function createDesk(options: DeskSetupOptions) {
  const store = new DeskStore(options.db);
  const trace = new DeskTrace(options.db, Date.now, options.log);
  // Every log line still goes where it went; source and timer errors also land in the trace (rate-limited).
  const baseLog = options.log;
  const log: DeskSetupOptions['log'] = (event, data = {}) => {
    baseLog(event, data);
    if (!SOURCE_ERROR.test(event)) return;
    const message = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : '';
    trace.recordLimited(event, SOURCE_ERROR_EVERY_MS, { source: 'desk', kind: 'source.error', summary: `${event}${message ? `: ${message}` : ''}`, data: { event, ...data } });
  };
  options = { ...options, log };
  const adapters: DeskSourceAdapter[] = [];
  const token = options.collaborationToken;
  const feed = new DeskFeed(options.db);
  const core = new DeskCore({
    store,
    refreshConversation: async (channelId) => {
      const refreshing = conversationMode === 'tango' && !options.intake?.some(entry => entry.channelId === channelId) ? undefined : discord?.refresh(channelId);
      if (conversationMode === 'tango') {
        await Promise.all([refreshing, tango.poll()]);
      } else {
        // Shadow observation must not hold up the coalesced trailing Discord read.
        void tango.poll().catch(err => options.log('desk.tango.poll.error', { message: String(err) }));
        await refreshing;
      }
    },
    feed,
    summarize: options.summarize,
    autoTag: options.autoTag,
    adapters,
    rules: options.rules,
    log: options.log,
    trace: trace.tracer,
    cancelJob: async (job) => {
      // Same body the background_job tool sends; the bot only lets the job's own agent cancel it.
      const response = await fetch(options.jobBridgeUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Tango-Collaboration-Token': token } : {}) },
        body: JSON.stringify({ action: 'cancel', job_id: job.id, _requester_agent_id: job.agentId }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `bridge HTTP ${response.status}`);
    },
    botWork: async () => {
      // Unreachable (or not ok) means nothing in flight we could wait for: null closes the orphan.
      const response = await fetch(options.botStatusUrl ?? 'http://127.0.0.1:9200/status/work', { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      return (await response.json()) as BotWork;
    },
  });
  // A new scene or prototype is news (desk/feed.ts), under the thread it belongs to.
  options.hub.subscribePublished((published) => {
    const item = core.itemForConversation(published.conversationKey);
    core.postFeed({ kind: published.kind, itemId: item?.id ?? null, projectId: item?.facts.projectId ?? null, agentName: published.agentName, title: published.title, text: published.text, data: { id: published.id } });
  });
  // A queued scene taking its turn opens its desk item.
  options.hub.setTracer(trace.tracer);
  options.hub.setItemResolver((conversationKey) => core.itemForConversation(conversationKey)?.id ?? null);
  const conversationMode = options.conversationMode ?? (process.env.TANGO_CONVERSATION_SOURCE === 'tango' ? 'tango' : 'shadow');
  const tango = new DeskTangoSource({ core, agents: options.agents.filter(a => a.homeChannelId && !/-(ollama|classic|test)$/.test(a.id) && !(options.mailBlockedAgents ?? []).includes(a.id)),
    url: options.conversationUrl ?? new URL(options.botStatusUrl ?? 'http://127.0.0.1:9200/status/work').origin,
    token, mode: conversationMode, trace: trace.tracer, fetchImpl: options.conversationFetch });
  const discord =
    options.discord && options.agents.length
      ? new DeskDiscordSource({ core, intakeOnly: conversationMode === 'tango', needsSnapshot: key => !tango.hasDiscordSnapshot(key), onRead: (key, messages, since) => tango.observeDiscord(key, messages, since), discord: options.discord, agents: options.agents, intake: options.intake, ownerIds: options.ownerIds, postToBot: options.postToBot, log: options.log })
      : null;
  const repos = options.loom ? readStartRepos(options.startWorkReposFile) : [];
  const loom = options.loom
    ? new DeskLoomSource({ core, url: options.loom.url, tokenFile: options.loom.tokenFile, projectFor: (dir) => {
      const repo = repoForDir(dir, repos);
      return { name: repo?.name ?? path.basename(path.resolve(dir)), icon: null, color: null };
    }, log: options.log, ...((discord || conversationMode === 'tango') && options.schedulesDb ? { discordLinks: new DiscordLoomLinks({ dbPath: options.schedulesDb, log: options.log }) } : {}), ...(options.loomMemory ? { memory: new LoomMemoryCapture({ store: core.store, ...options.loomMemory, log: options.log }) } : {}) })
    : null;
  if (loom) core.onOwnerActivity((at, source) => loom.beat(at, source));
  tango.setMirror(discord);
  if (conversationMode === 'tango') adapters.push(tango);
  if (discord) adapters.push(discord);
  if (loom) adapters.push(loom);
  const search = new DeskSearch({ db: options.db, embedder: options.searchEmbedder ?? null, log: options.log });
  const jobs = new DeskJobsSource({ core, dir: options.jobsDir, log: options.log });
  const agentctl = options.agentctlDir ? new DeskAgentctlSource({ core, dir: options.agentctlDir, log: options.log }) : null;
  const schedules = options.schedulesDb ? new DeskSchedulesSource({ core, dbPath: options.schedulesDb, log: options.log }) : null;
  if (schedules) adapters.push(schedules);
  const github = options.githubReviews !== false ? new DeskGitHubReviews({ core, log: options.log }) : null;
  const threadPrs = options.githubReviews !== false ? new DeskThreadPrs({ core }) : null;
  // A new watch is read now, not at the next five-minute poll.
  if (github) core.onPrWatch(() => void github.poll().catch((err) => options.log('desk.github.error', { message: (err as Error).message })));

  // Screens and the operator re-read on the old 'inbox' notice, batched per tick.
  let pending = new Set<string>();
  core.subscribe((event) => {
    if (event.type !== 'item') return;
    if (pending.size === 0) setImmediate(() => {
      const ids = [...pending];
      pending = new Set();
      options.hub.inboxChanged(ids);
    });
    pending.add(event.id);
  });

  // The one-time import of the old inbox's decisions waits for the first successful poll of every source.
  const answered = { discord: !discord };
  let tagsSeeded = false;
  const migrate = () => {
    const migrated = migrateInboxDecisions(core, { ready: answered.discord });
    if (!migrated.skipped && !migrated.waiting && store.setting('migrated_inbox_v1')) options.log('desk.migrated', migrated);
    // Items from before stage and type moved to the desk: seeded once every source has answered a poll,
    // so each seeds from its current name, never a stale one (Codex review on #498).
    if (!tagsSeeded && answered.discord) {
      tagsSeeded = true;
      core.seedAll();
    }
  };
  const pollDiscord = async () => {
    if (!discord) return { conversations: 0, messages: 0 };
    const result = await discord.poll();
    if (!result.errors) answered.discord = true;
    migrate();
    return result;
  };
  const pollSources = async () => {
    const discordResult = await pollDiscord();
    await Promise.all([jobs.poll(), agentctl?.poll(), tango.poll().catch(err => options.log('desk.tango.poll.error', { message: String(err) }))]);
    return discordResult;
  };

  const startWork = loom ? new StartWork({
    loom,
    repos,
    accountsFile: options.loom!.accountsFile ?? path.join(path.dirname(options.loom!.tokenFile), 'accounts.json'),
    policyFile: options.startWorkPolicyFile,
    usage: new UsageMonitor(options.usageUrl ?? 'http://127.0.0.1:9380/api/usage', Date.now, fetch, options.usageAliasesFile),
    log: options.log,
    trace: (kind, summary, data) => trace.record({ source: 'desk', kind, summary, data }),
  }) : null;

  // Retained project-coordinator records and context; new conversations use Loom.
  const coordinators = options.coordinatorWriter
    ? new ProjectCoordinators({
        core,
        start: startWork ? (request) => startWork.start(request) : null,
        afterStart: () => {},
        write: options.coordinatorWriter,
        search,
        repo: options.coordinatorRepo,
        morning: () => readSnoozeTimes(store.setting('snooze_times')).morning,
        log: options.log,
      })
    : null;

  // Desk mail: one agent's conversation writing to another's (desk/mail.ts).
  const mail = new DeskMail({
    core,
    db: options.db,
    blockedAgents: options.mailBlockedAgents,
    ...(loom ? { steer: (item, text, origin, commandId) => loom.steer(item, text, origin, commandId) } : {}),
    ...(startWork ? { startWork: { start: (request) => startWork.start(request), afterStart: () => {} } } : {}),
    log: options.log,
  });

  // The owner's words in a worker (or a job with an owner) reach what it reports to at once, backstage (TGO-1075).
  core.onOwnerPostedUp((post) => mail.ownerPostUp(post));

  // "Decided for you": Loom's acted and defaulted decisions, since the owner last looked (desk/decided.ts).
  const decided = loom ? new DeskDecided({ source: loom, settings: store }) : undefined;

  const agentAvatars = options.avatarsDir
    ? new AgentAvatars({ dir: options.avatarsDir, agents: () => options.agents.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar ?? null })) })
    : undefined;
  const capacity = startWork
    ? new Capacity({
        startWork,
        policyFile: options.startWorkPolicyFile,
        loom,
        ...(options.loom ? { loomAccountsFile: options.loom.accountsFile ?? path.join(path.dirname(options.loom.tokenFile), 'accounts.json'), loomWorktrees: path.join(path.dirname(options.loom.tokenFile), 'worktrees') } : {}),
      })
    : null;
  // The System page: the ledger every job and incident lands in; critical incidents are Inbox items of its own.
  const system =
    options.systemDb === false
      ? null
      : new DeskSystem({
          ...(options.systemDb ? { path: options.systemDb } : {}),
          capacity,
          core,
          // A schedule's Run now and Pause go the way its row on an agent's page sends them.
          schedules: schedules
            ? { run: (itemId) => schedules.runJob({ id: itemId } as Parameters<typeof schedules.runJob>[0]), pause: (itemId, paused) => schedules.pauseJob({ id: itemId } as Parameters<typeof schedules.pauseJob>[0], paused) }
            : null,
          ...(options.systemActions ? { actions: options.systemActions } : {}),
          // Fix on an incident: a cleanup worker under the Tango project's default (desk/system-fix.ts).
          fix: {
            mail,
            startWork: startWork ? { start: (request) => startWork.start(request), afterStart: () => {} } : null,
            ...(options.systemFixProject ? { project: options.systemFixProject } : {}),
            ...(options.systemFixRepo ? { repo: options.systemFixRepo } : {}),
          },
          log: options.log,
        });
  if (system) adapters.push(system);
  // The catch-up ledger (desk/updates.ts): typed lines per space with the owner's seen marks, filled from the desk's sources.
  const updates =
    options.updates === false
      ? null
      : new DeskUpdates({
          db: options.db,
          items: () => core.items(),
          spaceOf: (item) => spaceOf(item, { projects: readProjects(store.setting('projects')) }),
          awaySpaces: () => {
            const projects = readProjects(store.setting('projects'));
            return new Set(projects.filter((p) => holderOf(p, projects)).map((p) => `project:${p.id}`));
          },
          coverThread: (itemId, until) => core.coverThread(itemId, until),
          thread: { coveredUntil: (itemId) => store.attention(itemId)?.coveredUntil ?? null, messagesBetween: (itemId, after, before) => store.messagesBetween(itemId, after, before) },
          decided: loom,
          decidedSeenAt: () => {
            const at = Number(store.setting('decided_seen_at'));
            return Number.isFinite(at) && at > 0 ? at : null;
          },
          lead: loom,
          // A worker's merged PR is the end of its task: its next turn starts small (TGO-1113).
          ...(loom ? {
            onMerged: async (item, pr) => {
              if (item.facts.role !== 'worker') return true;
              const r = await loom.taskEnded(item.id, `PR #${pr.number} merged`);
              if (!r.ok) options.log('desk.updates.error', { stage: 'task-ended', itemId: item.id, message: r.error });
              return r.ok;
            },
          } : {}),
          writeChapter: options.chapterWriter ?? null,
          spaceName: (spaceId) => {
            if (spaceId === SYSTEM_SPACE) return 'System';
            if (spaceId === UNFILED_SPACE) return 'Unfiled';
            const [kind, id] = [spaceId.slice(0, spaceId.indexOf(':')), spaceId.slice(spaceId.indexOf(':') + 1)];
            if (kind === 'project') return readProjects(store.setting('projects')).find((p) => p.id === id)?.name ?? id;
            return options.agents.find((a) => a.id === id)?.name ?? id;
          },
          ...((options.updatesGh ?? options.githubReviews !== false) ? {} : { exec: null }),
          ...(system ? { incidents: async () => (await system.snapshot()).incidents } : {}),
          log: options.log,
        });
  if (updates) {
    core.subscribe((event) => {
      if (event.type === 'activity') updates.onDeskEvent(event.event);
    });
    // Decided for you, Shipped and a lead's own Update post from the ledger's rows (feed-status.md).
    followLedger(updates, feed, (itemId) => core.item(itemId));
  }
  // The missed-repeat log (feed-status.md "Checking it"): read before the word filters go.
  feed.onRepeat = ({ post, before, overlap, wouldDrop }) =>
    trace.record({ source: 'desk', kind: 'feed.repeat', summary: `${post.agentName || post.itemId}: a Summary ${Math.round((post.at - before.at) / 60_000)} min after a ${before.kind} post${wouldDrop ? ' (the word filter drops one)' : ''}`, data: { itemId: post.itemId, seq: post.seq, before: before.seq, beforeKind: before.kind, overlap: Math.round(overlap * 100) / 100, wouldDrop } });
  const routes: Omit<DeskRoutesOptions, 'scenes'> = {
    core,
    feed,
    ...(agentAvatars ? { agents: agentAvatars } : {}),
    trace,
    ...(startWork ? { startWork: { service: startWork, afterStart: () => {} } } : {}),
    ...(capacity ? { capacity: { service: capacity, policyFile: options.startWorkPolicyFile } } : {}),
    ...(system ? { system } : {}),
    ...((conversationMode === 'tango' || (options.startInBot && discord))
      ? {
          agentStart: {
            service: new AgentStart({
              // Named agents with a home channel (not their -ollama/-classic/-test clones), less the ones kept apart from the owner's desk work.
              agents: () => options.agents.filter((a) => a.homeChannelId && !/-(ollama|classic|test)$/.test(a.id) && !(options.mailBlockedAgents ?? []).includes(a.id)),
              startInBot: conversationMode === 'tango' ? body => tango.start(body) : options.startInBot!,
              log: options.log,
            }),
            // The new thread is on the desk at once, not at the next poll.
            afterStart: () => void pollSources().catch(() => undefined),
          },
        }
      : {}),
    conversations: {
      push: (key, id) => tango.push(key, id).catch(err => options.log('desk.tango.refresh.error', { message: String(err) })),
      report: () => tango.report(),
      attachment: async (id, index) => {
        const base = options.conversationUrl ?? new URL(options.botStatusUrl ?? 'http://127.0.0.1:9200/status/work').origin;
        return fetch(`${base}/conversations/attachments/${id}/${index}`, { signal: AbortSignal.timeout(10_000), headers: token ? { 'X-Tango-Collaboration-Token': token } : {} });
      },
    },
    collaborationToken: token || undefined,
    attachments: { t3Dir: options.t3AttachmentsDir, discord: options.discord ?? undefined, ...(loom ? { loom: (id: string) => loom.image(id) } : {}) },
    presentation: { current: () => options.hub.publicPresentation(), subscribe: (listener) => options.hub.subscribePresentation(listener) },
    search,
    ...(coordinators ? { coordinators } : {}),
    mail,
    ...(decided ? { decided } : {}),
    ...(updates ? { updates } : {}),
  };
  const push = new DeskPush(core, new DeskDevices(options.db), options.push === false ? null : configuredAPNs(process.env, event => log(event)), log);
  const compat: InboxCompatOptions = { core, hub: options.hub, rules: options.rules, pollSources, catchUp: discord ? async (channelId) => {
    if (conversationMode === 'tango' && !options.intake?.some(entry => entry.channelId === channelId)) { await tango.poll(); return 0; }
    return discord.catchUp(channelId);
  } : undefined };
  const timers: NodeJS.Timeout[] = [];
  const stops: Array<() => void> = [];

  return {
    core,
    store,
    trace,
    discord,
    tango,
    loom,
    jobs,
    search,
    routes,
    compat,
    pollSources,
    coordinators,
    mail,
    feed,
    system,
    updates,
    start(): void {
      const every = (ms: number, work: () => unknown) => {
        const timer = setInterval(() => {
          try {
            void Promise.resolve(work()).catch((err) => options.log('desk.timer.error', { message: (err as Error).message }));
          } catch (err) {
            options.log('desk.timer.error', { message: (err as Error).message });
          }
        }, ms);
        timer.unref?.();
        timers.push(timer);
      };
      stops.push(core.subscribe(event => { if (event.type === 'item') void push.sync(); }));
      every(30_000, () => push.sync());
      void push.sync();
      // First read of every source; each successful poll retries the one-time import (a no-op once done).
      const first = setTimeout(() => {
        void pollSources()
          .then((result) => options.log('desk.poll.first', result))
          // Reviews too: desk deploys restart the service often enough that a five-minute first wait could starve it.
          .then(() => github?.poll())
          .catch((err) => options.log('desk.poll.error', { message: (err as Error).message }));
      }, 2000);
      first.unref?.();
      if (discord) {
        every(options.discordPollMs ?? 45_000, () => pollDiscord());
        every(3 * 60_000, () => discord.checkReactions());
      }
      every(5 * 60_000, () => tango.poll());
      every(30_000, () => jobs.poll());
      if (agentctl) every(30_000, () => agentctl.poll());
      if (schedules) {
        setTimeout(() => schedules.poll(), 5_000).unref?.(); // poll() never throws
        every(60_000, () => schedules.poll());
      }
      if (system) {
        setTimeout(() => void system.tick(), 8_000).unref?.(); // tick() never throws
        every(options.systemPollMs ?? 30_000, () => system.tick());
      }
      if (threadPrs) {
        const pollPrs = () => threadPrs.poll().catch(err => options.log('desk.prs.error', { message: String(err) }));
        stops.push(core.subscribe(event => { if (event.type === 'item') void pollPrs(); }));
        void pollPrs();
        every(5 * 60_000, pollPrs);
      }
      if (github) {
        void github.isAvailable().then((ok) => options.log('desk.github', { available: ok }));
        every(5 * 60_000, () => github.poll());
      }
      if (search.semantic) {
        every(15_000, () =>
          search.embedPending(10).catch((err) => options.log('desk.search.embed.error', { message: (err as Error).message })),
        );
      }
      if (coordinators) {
        every(30_000, () => coordinators.tick());
        // A coordinator's commands wait on the desk's answer (Supervised): answered quickly while it works.
      }
      // The news feed starts with today's finished work and the projects' digests, once; then keeps two weeks.
      if (!store.setting('feed_seeded')) {
        for (const post of feedSeed(core)) feed.post(post);
        store.setSetting('feed_seeded', String(Date.now()));
      }
      if (!store.setting('feed_starts_relabeled')) {
        feed.relabelOldStarts();
        store.setSetting('feed_starts_relabeled', String(Date.now()));
      }
      // At start too: a desk down for weeks shows nothing older than the feed keeps (Codex review on #595).
      feed.prune();
      every(3_600_000, () => feed.prune());
      if (updates) {
        setTimeout(() => void updates.sync(), 15_000).unref?.(); // sync() never throws
        every(60_000, () => updates.sync());
        updates.prune();
        every(3_600_000, () => updates.prune());
      }
      // Mail waits on conversations going idle: looked at often (a pass is a few cheap reads).
      every(5_000, () => mail.tick());
      // Loom pushes its changes: followed over its event stream, not polled.
      loom?.start();
      core.start();
      trace.start();
      // A busy event loop holds every screen's requests (a click landing seconds late): each one goes in the trace.
      const stopStalls = watchStalls({ onStall: (ms) => trace.record({ source: 'desk', kind: 'server.stall', summary: `the server was busy for ${ms} ms`, data: { ms } }) });
      stops.push(stopStalls);
      trace.record({ source: 'desk', kind: 'desk.start', summary: `desk started (${[discord && 'discord', loom && 'loom'].filter(Boolean).join(', ') || 'no sources'})` });
    },
    close(): void {
      push.close();
      for (const timer of timers) clearInterval(timer);
      for (const stop of stops.splice(0)) stop();
      loom?.stop();
      system?.close();
      core.close();
      trace.close();
      feed.close();
    },
  };
}

/** The feed's first posts: what was done today, and each project's digests and current status. */
export function feedSeed(core: DeskCore, now = Date.now()): NewFeedPost[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const posts: NewFeedPost[] = [];
  const done = new Set<string>();
  for (const event of core.store.recentEvents(200, ['done', 'source.done'])) {
    if (event.at < midnight.getTime() || done.has(event.itemId) || core.store.isUndone(event.seq)) continue;
    const item = core.store.item(event.itemId);
    if (!item || item.hidden) continue;
    done.add(event.itemId);
    posts.push({ kind: 'done', at: event.at, itemId: item.id, agentName: item.agentName, title: core.title(item), text: item.summary?.paragraph || item.summary?.gist || '', data: { eventSeq: event.seq }, key: `thread:${item.id}` });
  }
  const projects = new Map(readProjects(core.store.setting('projects')).map((project) => [project.id, project]));
  for (const record of Object.values(readCoordinators(core.store.setting('coordinators')))) {
    const project = projects.get(record.projectId);
    if (!project || project.finishedAt) continue;
    for (const digest of record.digests) posts.push({ kind: 'project', at: digest.at, projectId: project.id, title: project.name, text: digest.text, data: { digest: true } });
    if (record.status?.text && record.status.source === 'model') posts.push({ kind: 'project', at: record.status.at, projectId: project.id, title: project.name, text: record.status.text, data: { line: record.status.line } });
  }
  return posts.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
