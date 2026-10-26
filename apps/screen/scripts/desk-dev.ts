// Dev tool: the Agent Desk on a throwaway instance, fed by fake sources through
// the real code paths. Never the production service. This is the desk agents test on
// (`npm run desk:test`): nothing here reaches the owner's windows, the real Loom or bot,
// or the machine's jobs, unless a flag below says so.
//
//   npm run desk:test                       invented data, sandbox Loom, port 9431
//   npm run desk:test -- --mirror           a frozen copy of the live desk's data instead
//   SCREEN_PORT=9441 npm run desk:test      another port (the bot stub is port+1, the sandbox Loom port+2)
//
// What is sandboxed:
//   - the desk's data: a temp SCREEN_DATA_DIR (removed on exit), never a profile's real screen data
//   - Loom: a real Loom (packages/loom) on its own LOOM_HOME and port with the fake runtime
//     (LOOM_FAKE_RUNTIME=1): Start work, replies, answers and mail run fake turns. --no-loom: none.
//   - the bot: the stub below; Discord: an in-memory fake; Start work's accounts: an invented settings file
//   - the System page: its own ledger, seeded, with dry actions (no launchctl, signals or bot calls)
//   - the usage monitor: not read
// --mirror: the live desk's screen.db is copied (read-only, VACUUM INTO) into the temp dir and served as it was:
// the sources don't poll, so nothing re-syncs it, and every command lands in the copy, the bot stub or the
// sandbox Loom. It holds real conversations: keep its screenshots on the tailnet, never in a PR or the repo.
//
// What it runs: the real screen app (createApp), hub, desk core, routes and UI,
// with an isolated SCREEN_DATA_DIR (a temp dir unless set), an in-memory fake
// Discord and sandbox Loom seeded with synthetic conversations, a background
// job on disk, and bot turn events sent through POST /api/desk/agent-events.
// The bot's /screen/input is a local stub on SCREEN_PORT + 1 that records every
// post (and echoes it into the fake Discord, the way the real bot does).
//
// Stub controls (http://127.0.0.1:<port+1>):
//   GET  /posts                       what the desk posted to the "bot"
//   POST /mode {"mode":"ok|fail|slow"} next replies succeed, fail (HTTP 500), or time out
//   POST /fail-archive {"on":true}     Discord thread archive fails (Done write-back failure)
//   POST /agent-post {"conversation":"<threadId or home channel id>","text":"…"}  a new agent message
//
// Stage a scene in a seeded conversation (the Sierra loop thread):
//   curl -s localhost:<port>/api/scenes -H 'Content-Type: application/json' \
//     -d '{"agentId":"sierra","threadId":"<printed thread id>","channelId":"<printed home id>","kind":"html","body":"<h1>Loop</h1>","summary":"The loop map","check":false}'
//
// All names, ids and links here are invented.

import { createDraftCompiler } from '@tango/tango-voice/live/draft-mode';
import { voiceSnapshot } from '../server/desk/voice-exchange.js';
import { attachDeskVoice, type DeskVoiceOptions } from '../server/desk/voice.js';
import { itemDetail } from '../server/desk/view.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { openLedger, recordEvent, recordRun, setCursor, upsertJob } from '@tango/system';
import { createApp } from '../server/app.js';
import { snowflakeAt, type DiscordMessage, type DiscordRest, type DiscordThread } from '../server/discord.js';
import { createDesk } from '../server/desk/setup.js';
import { fallbackSummary, shortTitle, type DeskSummarizer, type DeskSummaryOutput } from '../server/desk/summarize.js';
import { choiceLabel, Hub, type FallbackRouter } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { BundleStore } from '../server/bundles.js';
import { PrototypeStore } from '../server/prototypes.js';
import { seedConversationWindow, seedLabelledConversation } from '../test/fixtures/conversation-window.js';
import { seedAskReport, seedMissingAnswerReport } from '../test/fixtures/ask-report.js';
import { sandboxProfileEnv } from './sandbox-profile.js';

const args = new Set(process.argv.slice(2));
const MIRROR = args.has('--mirror') || process.env.DESK_DEV_MIRROR === '1';
const SANDBOX_LOOM = !args.has('--no-loom') && process.env.DESK_DEV_LOOM !== '0';
const PORT = Number(process.env.SCREEN_PORT ?? 9431);
const BOT_PORT = Number(process.env.DESK_DEV_BOT_PORT ?? PORT + 1);
const LOOM_PORT = Number(process.env.DESK_DEV_LOOM_PORT ?? PORT + 2);
/** The live services' ports (screen, Loom, usage monitor): a test desk never takes one. */
const PRODUCTION_PORTS = new Set([9410, 9420, 9380]);
const OUR_PORTS: Array<[string, number]> = [['SCREEN_PORT', PORT], ['the bot stub (DESK_DEV_BOT_PORT)', BOT_PORT]];
// Only a sandbox Loom that runs takes its port (Codex review on #784).
if (SANDBOX_LOOM) OUR_PORTS.push(['the sandbox Loom (DESK_DEV_LOOM_PORT)', LOOM_PORT]);
for (const [name, port] of OUR_PORTS) {
  if (PRODUCTION_PORTS.has(port)) throw new Error(`${port} belongs to a live service; pick another port for ${name}`);
}
const BOT_TIMEOUT_MS = Number(process.env.DESK_DEV_BOT_TIMEOUT_MS ?? 3000);
const OWN_DATA_DIR = !process.env.SCREEN_DATA_DIR;
const DATA_DIR = path.resolve(process.env.SCREEN_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'desk-dev-')));
// A profile's own screen data is the live desk's: never served (or written) by a test desk.
if (DATA_DIR.startsWith(path.join(os.homedir(), '.tango', 'profiles') + path.sep)) throw new Error(`${DATA_DIR} is a profile's live data; leave SCREEN_DATA_DIR unset for a temp dir`);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const log = (event: string, data: Record<string, unknown> = {}) => console.log(`[desk-dev] ${event} ${JSON.stringify(data)}`);

// ── synthetic ids (runs of zeros, so they can't be mistaken for real ones) ──
const OWNER = '1500000000000000099';
const id = (n: number) => `15000000000000${String(n).padStart(5, '0')}`;
const AGENTS = [
  { id: 'sierra', name: 'Sierra', homeChannelId: id(1) },
  { id: 'victor', name: 'Victor', homeChannelId: id(2) },
  { id: 'malibu', name: 'Malibu', homeChannelId: id(3) },
  { id: 'juliet', name: 'Juliet', homeChannelId: id(4) },
  { id: 'foxtrot', name: 'Foxtrot', homeChannelId: id(5) },
];
const home = (agentId: string) => AGENTS.find((agent) => agent.id === agentId)!.homeChannelId;
const THREADS = {
  merge: { id: id(101), agent: 'victor', name: 'operator-dependability' },
  ferry: { id: id(102), agent: 'juliet', name: 'Ferry booking' },
  loop: { id: id(103), agent: 'sierra', name: 'Ridge Loop loop' },
  gutter: { id: id(104), agent: 'foxtrot', name: 'Gutter quote' },
  receipts: { id: id(105), agent: 'sierra', name: 'Q3 receipts' },
  search: { id: id(106), agent: 'victor', name: 'Search ranking PR' },
  deck: { id: id(107), agent: 'foxtrot', name: 'Deck stain quote' },
};

// ── fake Discord ─────────────────────────────────────────────────────────
let seq = 0;
const now = Date.now();
function message(channelId: string, minutesAgo: number, author: 'agent' | 'owner', content: string): DiscordMessage {
  seq += 1;
  return {
    id: (BigInt(snowflakeAt(Date.now() - minutesAgo * 60_000)) + BigInt(seq)).toString(),
    type: 0,
    channel_id: channelId,
    content,
    author: author === 'owner' ? { id: OWNER, username: 'owner' } : { id: id(900), bot: true, username: 'agent' },
    ...(author === 'agent' ? { webhook_id: 'w' } : {}),
  };
}

class FakeDiscord {
  channels = new Map<string, DiscordMessage[]>();
  threads: DiscordThread[] = [];
  failArchive = false;
  async channel(channelId: string) {
    const thread = this.threads.find((entry) => entry.id === channelId);
    return { id: channelId, guild_id: 'guild', last_message_id: this.channels.get(channelId)?.at(-1)?.id ?? null, parent_id: thread?.parent_id, name: thread?.name };
  }
  async activeThreads() {
    // A last message id far ahead, so every poll reads the thread.
    return this.threads.map((thread) => ({ ...thread, last_message_id: snowflakeAt(Date.now() + 365 * 86_400_000) }));
  }
  async messages(channelId: string, options: { after?: string } = {}) {
    return (this.channels.get(channelId) ?? []).filter((entry) => !options.after || BigInt(entry.id) > BigInt(options.after));
  }
  async messagesSince(channelId: string, sinceMs: number) {
    return (this.channels.get(channelId) ?? []).filter((entry) => Number((BigInt(entry.id) >> 22n) + 1420070400000n) >= sinceMs);
  }
  async message(channelId: string, messageId: string) {
    const found = (this.channels.get(channelId) ?? []).find((entry) => entry.id === messageId);
    if (!found) throw new Error('Discord GET HTTP 404');
    return found;
  }
  async reactionUsers() {
    return [] as string[];
  }
  async react(channelId: string, messageId: string, emoji: string) {
    log('discord.react', { channelId, messageId, emoji });
  }
  async archiveThread(threadId: string) {
    if (this.failArchive) throw new Error('Discord PATCH /channels HTTP 403 (simulated)');
    log('discord.archive', { threadId });
  }
  push(channelId: string, entry: DiscordMessage) {
    const list = this.channels.get(channelId) ?? [];
    list.push(entry);
    list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    this.channels.set(channelId, list);
  }
  thread(key: keyof typeof THREADS) {
    const thread = THREADS[key];
    this.threads.push({ id: thread.id, name: thread.name, parent_id: home(thread.agent), last_message_id: null } as DiscordThread);
    return thread.id;
  }
}

const discord = new FakeDiscord();
const say = (channelId: string, minutesAgo: number, author: 'agent' | 'owner', text: string) => discord.push(channelId, message(channelId, minutesAgo, author, text));

say(discord.thread('merge'), 180, 'owner', 'The operator double-sends after a media reconnect. Can you fix it?');
say(THREADS.merge.id, 120, 'agent', 'Reproduced it: the resend path fires even when no new speech arrived.');
say(THREADS.merge.id, 4, 'agent', 'PR https://github.com/example/tango/pull/372 is green (CI https://github.com/example/tango/actions/runs/101). Merge now, tonight, or hold?');
say(discord.thread('ferry'), 50, 'owner', 'Find me a ferry Saturday morning, truck included.');
say(THREADS.ferry.id, 6, 'agent', 'The 9:10 sailing has 2 vehicle spots left. Book it for the truck?');
say(discord.thread('loop'), 70, 'owner', 'Can we still do the coast loop Saturday?');
say(THREADS.loop.id, 25, 'agent', 'Two closures on the north spur. Reroute on the forest road (+11 mi gravel) or drop the north spur?');
say(discord.thread('gutter'), 90, 'owner', 'Get me two gutter quotes.');
say(THREADS.gutter.id, 40, 'agent', 'Compared 2 bids and recommended the local crew: same price, a week sooner.');
say(discord.thread('receipts'), 12, 'owner', 'Match the Q3 receipts to the statements.');
say(discord.thread('search'), 2 * 24 * 60, 'owner', 'Tune the search ranking for short queries.');
say(THREADS.search.id, 2 * 24 * 60 - 120, 'agent', 'Opened PR https://github.com/example/acme/pull/381 with the ranking tweak; review requested from the design lead.');
say(discord.thread('deck'), 26 * 60, 'agent', 'Two bids for the back deck: warrantied ($1,150) or cheaper ($890)?');
say(home('malibu'), 120, 'owner', 'Scan this week’s feedback and tell me what stands out.');
say(home('malibu'), 118, 'agent', 'Started background job “feedback-scan”. Next check at 6 pm.');
say(home('juliet'), 150, 'agent', 'Weather is clear all weekend.');

const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

// Start work's repos: small git repos in the sandbox, so a worktree or a Loom thread has somewhere real to start.
const REPOS_DIR = path.join(DATA_DIR, 'repos');
function sandboxRepo(name: string): string {
  const dir = path.join(REPOS_DIR, name);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const git = (...gitArgs: string[]) => execFileSync('git', ['-C', dir, ...gitArgs], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nA sandbox repo for the test desk (invented).\n`);
  git('add', '.');
  git('-c', 'user.name=desk-dev', '-c', 'user.email=desk-dev@example.invalid', 'commit', '-q', '-m', 'sandbox');
  // An origin of its own, so "start from origin" finds origin/HEAD.
  git('remote', 'add', 'origin', dir);
  git('fetch', '-q', 'origin');
  git('remote', 'set-head', 'origin', 'main');
  return dir;
}
const PROJECTS = [
  { id: 'p-tango', title: 'tango', workspaceRoot: sandboxRepo('tango') },
  { id: 'p-acme', title: 'acme', workspaceRoot: sandboxRepo('acme') },
];
// The repository catalog is explicit so test starts never discover real checkouts.
const START_REPOS = path.join(DATA_DIR, 'start-work-repos.json');
fs.writeFileSync(START_REPOS, JSON.stringify(PROJECTS.map(repo => ({ id: repo.id, name: repo.title, path: repo.workspaceRoot }))));
const START_POLICY = path.join(DATA_DIR, 'start-work.yaml');
fs.writeFileSync(START_POLICY, 'default: [sandbox-a, sandbox-b, sandbox-codex]\n');

// ── canned summaries (the model's part, deterministic here) ──────────────
const CANNED: Array<[RegExp, Partial<DeskSummaryOutput>]> = [
  [/Merge now, tonight, or hold\?/, { title: 'Merge the reconnect fix?', gist: 'PR #372 fixes the double-send after a media reconnect. CI is green; the live bot still runs yesterday’s build.', step: 'your_move', ask: 'Merge and restart now, tonight, or hold?', options: ['Merge now', 'tonight', 'hold'], context: ['A restart takes about 40 s; voice reconnects on its own.', 'Rollback is the previous build, about a minute.'], ownerAsk: 'Fix the double-send after a media reconnect' }],
  [/Book it for the truck\?/, { title: 'Book the Saturday sailing?', gist: 'The Saturday 9:10 sailing has 2 vehicle spots left; the 11:30 is full.', step: 'your_move', ask: 'Book the 9:10 for the truck?', context: ['Cancellation is free until Thursday noon.'] }],
  [/Reroute on the forest road/, { title: 'Reroute or drop the north spur?', gist: 'Two closures block the north spur of the coast loop. A forest-road reroute adds 11 miles of gravel.', step: 'your_move', ask: 'Reroute on the forest road or drop the north spur?', options: ['Reroute on the forest road', 'drop the north spur'], context: ['The reroute adds about 35 minutes.', 'Dropping the spur finishes 40 minutes earlier.'] }],
  [/recommended the local crew/, { title: 'Gutter quote: local crew', gist: 'Compared two gutter bids; the local crew is the same price and a week sooner.', step: 'fyi' }],
  [/review requested from the design lead/, { title: 'Waiting on a review', gist: 'PR #381 has the ranking tweak; tests pass.', step: 'watching', waitingOn: { who: 'the design lead', what: 'PR #381 review' } }],
  [/warrantied .* or cheaper/, { title: 'Which deck stain bid?', gist: 'Two bids for staining the back deck: $1,150 with a 2-year warranty, or $890 with none.', step: 'your_move', ask: 'Warrantied or cheaper?', options: ['warrantied', 'cheaper'] }],
  [/feedback-scan/, { title: 'Weekly feedback scan', gist: 'A background scan of this week’s feedback is running; first results at 6 pm.', step: 'watching' }],
  [/Weather is clear/, { title: 'Weekend weather', gist: 'Clear all weekend.', step: 'fyi' }],
];
const summarize: DeskSummarizer = async (input) => {
  const base = fallbackSummary(input);
  const last = [...input.messages].reverse().find((entry) => entry.author === 'agent')?.text ?? '';
  const canned = CANNED.find(([pattern]) => pattern.test(last))?.[1];
  const merged = { ...base, ...canned, source: canned ? ('model' as const) : base.source };
  return { ...merged, title: merged.title || shortTitle(merged.gist) };
};

// ── the bot stub ─────────────────────────────────────────────────────────
const posts: Array<Record<string, unknown>> = [];
let mode: 'ok' | 'fail' | 'slow' = 'ok';
const readBody = (req: http.IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
// The store bridge's synthetic local ids stay stable as the fake bot receives replies.
const storeIds = new Map<string, number>();
function storeFixture() {
  const rows = [...discord.channels.entries()].flatMap(([channelId, posts]) => posts.map(post => ({ channelId, post })))
    .sort((a, b) => BigInt(a.post.id) < BigInt(b.post.id) ? -1 : 1);
  return rows.map(({ channelId, post }) => {
    if (!storeIds.has(post.id)) storeIds.set(post.id, storeIds.size + 1);
    const thread = discord.threads.find(t => t.id === channelId);
    const agent = AGENTS.find(a => a.homeChannelId === (thread?.parent_id ?? channelId))!;
    return { id: storeIds.get(post.id)!, conversation_key: `${thread ? 'thread' : 'channel'}:${channelId}`,
      author_kind: !post.author.bot || post.content.startsWith('🖥️') ? 'owner' : 'agent',
      content: post.content.replace(/^🖥️\s*/, ''), created_at: new Date(Number((BigInt(post.id) >> 22n) + 1420070400000n)).toISOString(),
      discord_message_ids: JSON.stringify([post.id]), attachments: '[]', reply_to_message_id: null,
      agent_id: agent.id, kind: thread ? 'thread' : 'home', title: thread?.name ?? '', discord_channel_id: agent.homeChannelId, discord_thread_id: thread?.id ?? null };
  });
}
const botStub = http.createServer(async (req, res) => {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const reply = (status: number, json: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  const url = new URL(req.url ?? '/', 'http://stub');
  if (url.pathname === '/conversations') {
    const rows = storeFixture();
    const keys = [...new Set(rows.map(row => row.conversation_key))];
    const conversations = keys.map(key => {
      const messages = rows.filter(row => row.conversation_key === key);
      return { ...messages[0], revision: Math.max(...messages.map(m => m.id)), changed_message_ids: JSON.stringify(messages.map(m => m.id)) };
    }).filter(c => c.revision > Number(url.searchParams.get('updatedAfter') ?? 0));
    return reply(200, { conversations, cursor: storeIds.size });
  }
  const storeRead = /^\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  if (storeRead) return reply(200, { messages: storeFixture().filter(row => row.conversation_key === decodeURIComponent(storeRead[1]!) && row.id > Number(url.searchParams.get('after') ?? 0))
    .sort((a,b) => a.id-b.id).slice(0, Number(url.searchParams.get('limit') ?? 100)) });
  if (req.url === '/screen/input' && req.method === 'POST') {
    posts.push({ ...body, at: Date.now(), mode });
    if (mode === 'fail') return reply(500, { error: 'simulated bot failure' });
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, BOT_TIMEOUT_MS + 2000));
    // The real bot posts the owner's words (🖥️-prefixed) in the conversation.
    const channelId = String(body.channelId ?? '');
    const text = String((body.data as { text?: string; label?: string })?.text ?? body.label ?? '');
    if (channelId && text) discord.push(channelId, { ...message(channelId, 0, 'agent', `🖥️ ${text}`) });
    return reply(200, { ok: true });
  }
  if (req.url === '/posts') return reply(200, posts);
  if (req.url === '/mode' && req.method === 'POST') {
    mode = body.mode === 'fail' || body.mode === 'slow' ? body.mode : 'ok';
    return reply(200, { mode });
  }
  if (req.url === '/fail-archive' && req.method === 'POST') {
    discord.failArchive = body.on === true;
    return reply(200, { failArchive: discord.failArchive });
  }
  if (req.url === '/agent-post' && req.method === 'POST') {
    const conversation = String(body.conversation ?? '');
    say(conversation, 0, 'agent', String(body.text ?? 'Update.'));
    return reply(200, { ok: true });
  }
  if (req.url === '/status/work') return reply(200, { channelTurns: 0, voiceTurns: 0, voiceConversations: [] });
  reply(404, { error: 'not found' });
});
botStub.listen(BOT_PORT, '127.0.0.1');
const BOT_URL = `http://127.0.0.1:${BOT_PORT}/screen/input`;

async function postToBot(body: Record<string, unknown>): Promise<string> {
  try {
    const response = await fetch(BOT_URL, { method: 'POST', signal: AbortSignal.timeout(BOT_TIMEOUT_MS), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return response.ok ? 'agent' : `failed:bot HTTP ${response.status}`;
  } catch (err) {
    const name = (err as Error).name;
    return name === 'TimeoutError' || name === 'AbortError' ? `unknown:${(err as Error).message}` : `failed:${(err as Error).message}`;
  }
}
const fallback: FallbackRouter = async (scene, input) =>
  postToBot({ agentId: scene.agentId, channelId: scene.origin.threadId ?? scene.origin.channelId, conversationKey: input.conversationKey, commandId: input.commandId, sceneId: scene.id, type: input.type, label: input.type === 'choice' ? choiceLabel(scene, input.data) : undefined, data: input.data });

// ── a background job on disk (Malibu's home channel) ─────────────────────
const jobsDir = path.join(DATA_DIR, 'background-jobs');
fs.mkdirSync(path.join(jobsDir, 'job-feedback-scan'), { recursive: true });
fs.writeFileSync(
  path.join(jobsDir, 'job-feedback-scan', 'job.json'),
  JSON.stringify({ id: 'job-feedback-scan', agentId: 'malibu', channelId: home('malibu'), threadId: null, label: 'feedback-scan', status: 'running', startedAt: iso(118), timeoutSeconds: 8 * 3600 }),
);

// ── the sandbox Loom: real Loom, fake runtime, its own home and port ──────
const LOOM_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'loom', 'src', 'main.ts');
let loomChild: ChildProcess | null = null;
let loomHome: string | null = null;

/** The sandbox's processes and temp state go on exit, however far startup got (Codex review on #784). */
function stopSandbox(): void {
  loomChild?.kill('SIGTERM');
  if (loomHome) {
    // Loom's session hosts outlive it by design (a restart reattaches them): the sandbox's own go with it.
    const hosts = path.join(loomHome, 'hosts');
    for (const file of fs.existsSync(hosts) ? fs.readdirSync(hosts).filter((name) => name.endsWith('.json')) : []) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(hosts, file), 'utf8')) as { pid?: number };
        if (pid) process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(loomHome, { recursive: true, force: true });
  }
  // A mirror's copy holds real conversations: it never outlives the desk.
  if (OWN_DATA_DIR) fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
/** The desk's own services, once they run. */
let closeServices = () => {};
const shutdown = () => {
  closeServices();
  stopSandbox();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function startSandboxLoom(): Promise<{ url: string; tokenFile: string; token: string }> {
  // A short path: Loom's session hosts listen on Unix sockets under it (macOS caps their length).
  loomHome = fs.mkdtempSync('/tmp/loom-desk-');
  const token = randomUUID();
  const tokenFile = path.join(loomHome, 'token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.writeFileSync(path.join(loomHome, 'accounts.json'), JSON.stringify({ claude: { default: 'sandbox-a', accounts: [{ name: 'sandbox-a' }, { name: 'sandbox-b' }] }, codex: { default: 'sandbox-codex', accounts: [{ name: 'sandbox-codex', home: path.join(loomHome, 'codex') }] } }));
  loomChild = spawn(process.execPath, ['--import', 'tsx', LOOM_MAIN], {
    env: {
      ...process.env,
      LOOM_HOME: loomHome,
      LOOM_FAN_OUT_ARTIFACTS: process.env.DESK_DEV_FAN_OUT_ARTIFACTS || path.join(loomHome, "artifacts"),
      // Its own profile: Loom rewrites decisions/rules.md under it, and must never reach the live one.
      ...sandboxProfileEnv(loomHome),
      LOOM_PORT: String(LOOM_PORT),
      // No releases here: session hosts run from this checkout's source.
      LOOM_RELEASES_DIR: path.join(loomHome, 'releases'),
      LOOM_ACCOUNTS: path.join(loomHome, 'accounts.json'),
      LOOM_USAGE_URL: '',
      LOOM_FAKE_RUNTIME: '1',
      LOOM_FAKE_TURN_MS: process.env.LOOM_FAKE_TURN_MS ?? '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relay = (data: Buffer) => String(data).split('\n').filter(Boolean).forEach((line) => console.log(`[desk-dev:loom] ${line}`));
  loomChild.stdout?.on('data', relay);
  loomChild.stderr?.on('data', relay);
  const url = `http://127.0.0.1:${LOOM_PORT}`;
  for (let i = 0; i < 120; i += 1) {
    if (loomChild.exitCode !== null) throw new Error(`the sandbox Loom exited (${loomChild.exitCode}); is port ${LOOM_PORT} free?`);
    const ok = await fetch(`${url}/health`).then((r) => r.ok, () => false);
    if (ok) return { url, tokenFile, token };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('the sandbox Loom did not answer /health in 60 s');
}

/** Two Loom threads to start from: one finished, one waiting on a question (the fake runtime asks when the text says "question"). */
async function seedSandboxLoom(url: string, token: string): Promise<void> {
  const submit = (text: string, title: string) =>
    fetch(`${url}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), type: 'submit', provider: 'claude', cwd: PROJECTS[0]!.workspaceRoot, kind: 'coding', title, text }),
    }).then(async (r) => {
      const result = await r.json();
      if (!r.ok || !result.ok) throw new Error(`Sandbox Loom seed failed: ${JSON.stringify(result)}`);
      return result;
    });
  await submit('Tidy the sandbox README.', 'Sandbox README tidy');
  await submit('Plan the trail map export, then ask me a question before you build it.', 'Trail map export plan');
}

// ── the System page's ledger: its own, seeded with invented jobs; its actions are dry ──
const SYSTEM_DB = path.join(DATA_DIR, 'system.sqlite');
function seedSystem(): void {
  const ledger = openLedger({ path: SYSTEM_DB });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const PULL = 'launchd:com.example.health-pull';
  upsertJob(ledger, { id: PULL, runner: 'launchd', name: 'health-pull', group: 'Health', cadence: 'Every 15 min', cadenceSeconds: 900, criticality: 'critical', lastRunAt: ago(5 * 60_000), lastStatus: 'failed' });
  upsertJob(ledger, { id: 'schedule:brief', runner: 'schedule', name: 'Daily Brief', owner: 'sierra', group: 'Sierra', cadence: 'Daily 05:00', cadenceSeconds: 86400, lastRunAt: ago(3_600_000), lastStatus: 'ok' });
  upsertJob(ledger, { id: 'launchd:com.example.stale', runner: 'launchd', name: 'stale build', managed: false, facts: { cpu: 31, pid: 4242 } });
  for (const [k, status] of (['ok', 'quiet', 'ok'] as const).entries()) recordRun(ledger, { jobId: PULL, startedAt: ago(60_000 * (40 - k * 10)), status, durationMs: 1200, summary: status === 'ok' ? 'Pulled 214 samples' : 'Nothing new' });
  recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.failed', severity: 'error', title: 'Exited 1: Health store locked' });
  recordEvent(ledger, { source: 'scheduler', jobId: 'schedule:brief', kind: 'delivery.failed', severity: 'error', title: 'Delivery failed: channel not found' });
  setCursor(ledger, 'health', JSON.stringify({ checkedAt: new Date().toISOString(), services: [{ id: 'bot', name: 'Bot', ok: true, detail: 'up', since: ago(3 * 3_600_000) }, { id: 'loom', name: 'Loom', ok: true, detail: 'sandbox', since: ago(60_000) }], machine: { load1: 4, load5: 5, cores: 24, memUsedGb: 21, memTotalGb: 64, diskUsedPct: 60, diskFreeGb: 400 } }));
  ledger.db.close();
}

// ── --mirror: a frozen copy of the live desk's data ──────────────────────
function mirrorLiveDesk(): string {
  const profile = process.env.TANGO_PROFILE?.trim() || 'default';
  const from = process.env.DESK_DEV_MIRROR_FROM ?? path.join(os.homedir(), '.tango', 'profiles', profile, 'data', 'screen', 'screen.db');
  const to = path.join(DATA_DIR, 'screen', 'screen.db');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) fs.rmSync(to);
  // Read-only on the live file: VACUUM INTO writes a consistent copy without touching it.
  const live = new DatabaseSync(from, { readOnly: true });
  live.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  live.close();
  return from;
}

// ── the service ──────────────────────────────────────────────────────────
let mirroredFrom: string | null = null;
let sandboxLoom: Awaited<ReturnType<typeof startSandboxLoom>> | null = null;
try {
  mirroredFrom = MIRROR ? mirrorLiveDesk() : null;
  if (!MIRROR) seedSystem();
  sandboxLoom = SANDBOX_LOOM ? await startSandboxLoom() : null;
  if (sandboxLoom && !MIRROR) await seedSandboxLoom(sandboxLoom.url, sandboxLoom.token);
} catch (err) {
  stopSandbox();
  throw err;
}
const store = new SceneStore(path.join(DATA_DIR, 'screen'), Date.now, [os.tmpdir()]);
const prototypes = new PrototypeStore(store.db);
const bundles = new BundleStore(path.join(DATA_DIR, 'bundles'));
// DESK_DEV_IDLE_MS: a shorter idle return (hub.ts DIRECTOR_GRACE_MS), to watch Screen windows go back to their feed.
const hub = new Hub(store, fallback, log, undefined, process.env.DESK_DEV_IDLE_MS ? Number(process.env.DESK_DEV_IDLE_MS) : undefined, { prototypes });
const desk = createDesk({
  push: false,
  db: store.db,
  hub,
  discord: discord as unknown as DiscordRest,
  agents: AGENTS,
  ownerIds: [OWNER],
  rules: null,
  summarize,
  postToBot,
  jobsDir,
  jobBridgeUrl: `http://127.0.0.1:${BOT_PORT}/background-jobs`,
  collaborationToken: '',
  githubReviews: false,
  // A mirror's merged PRs are read through gh (read-only) so its catch-up ledger has them.
  updatesGh: MIRROR,
  log,
  discordPollMs: 5_000,
  botStatusUrl: `http://127.0.0.1:${BOT_PORT}/status/work`,
  // The usage monitor isn't read: the bot stub answers 404.
  usageUrl: `http://127.0.0.1:${BOT_PORT}/usage`,
  startWorkReposFile: START_REPOS,
  startWorkPolicyFile: START_POLICY,
  loom: sandboxLoom ? { url: sandboxLoom.url, tokenFile: sandboxLoom.tokenFile } : null,
  // A mirror keeps the copy's System page off (its ledger is the machine's); otherwise the sandbox's own, dry.
  systemDb: MIRROR ? false : SYSTEM_DB,
  systemActions: 'dry',
  systemFixRepo: 'tango',
});
// Real subscription audio is opt-in; the conversation and sends remain sandboxed.
const voice: DeskVoiceOptions | undefined = args.has('--voice') ? {
  dataDir: DATA_DIR,
  item: id => desk.core.item(id),
  snapshot: id => {
    const detail = itemDetail(desk.core, id, [], []);
    return voiceSnapshot(detail);
  },
} : undefined;
// Deterministic text-model fixtures for Shortcut HTTP checks: no model credentials or paid calls.
if (args.has('--phone-note-fixtures')) desk.routes.phoneNoteRuntime = async () => {
  const rows = desk.core.items().filter(item => item.replyable && item.disposition === 'active');
  const byHandle = new Map(rows.map((item, i) => [`i${i + 1}`, item]));
  return {
    context: { input: { agents: AGENTS.map(agent => ({ ...agent, role: 'test agent' })), tasks: [], threads: [], transcript: [], now: Date.now(), startPlace: null, loomRepos: ['tango'],
      desk: { items: [...byHandle].map(([handle, item]) => ({ handle, agentName: item.agentName, place: item.place, step: item.nextStep, line: '', threadId: item.threadId })) } },
      resolveItem: handle => { const row = byHandle.get(handle); return row ? { ...row, isAgent: false } : null; } },
    compile: createDraftCompiler(async request => {
      const text = request.input.map(part => part.text).join('\n').split('Fragments, in order:')[1]?.split('Message rules:')[0] ?? '';
      const clarification = request.input.map(part => part.text).join('\n').split('Clarifications:')[1] ?? '';
      const agent = AGENTS.find(agent => (text + clarification).includes(agent.name));
      return JSON.stringify({ message: text.trim(), agent_id: agent?.id ?? '', item: '', thread_id: '', new_thread_title: '', new_loom_repo: '', questions: agent ? [] : ["Who's it for?"] });
    }),
  };
};
const app = createApp({ voice, store, hub, publicDir, bundles, prototypes, desk: { routes: { ...desk.routes, scenes: () => hub.liveScenes(), prototypes: () => prototypes.live() }, compat: desk.compat } });

const httpServer = serve({ fetch: (request) => {
  if (new URL(request.url).pathname === '/apps.json') {
    return Response.json([
      { id: 'desk', name: 'Tango Desk', path: '/tango-screen/', icon: 'desk' },
      { id: 'lift', name: 'Tango Lift', path: '/tango-workout/', icon: 'lift' },
      { id: 'food', name: 'Tango Food', path: '/tango-food/', icon: 'food' },
      { id: 'kilo', name: 'Kilo Ledger', path: '/kilo/', icon: 'kilo' },
      { id: 'usage', name: 'Tango Usage', path: '/tango-usage/', icon: 'usage' },
      { id: 'state', name: 'Tango State', path: '/tango-state/', icon: 'state' },
    ], { headers: { 'Cache-Control': 'no-store' } });
  }
  // Mirror the production proxy mount so native tests exercise a path-scoped desk.
  const mounted = new URL(request.url);
  if (mounted.pathname === '/tango-screen' || mounted.pathname.startsWith('/tango-screen/')) {
    mounted.pathname = mounted.pathname.slice('/tango-screen'.length) || '/';
    return app.fetch(new Request(mounted, request));
  }
  return app.fetch(request);
}, port: PORT, hostname: '127.0.0.1' }, async () => {
  log('listening', {
    url: `http://127.0.0.1:${PORT}/`,
    bot: `http://127.0.0.1:${BOT_PORT}`,
    loom: sandboxLoom?.url ?? null,
    dataDir: DATA_DIR,
    ...(mirroredFrom ? { mirror: mirroredFrom } : { loopThread: THREADS.loop.id, sierraHome: home('sierra'), mergeThread: THREADS.merge.id, victorHome: home('victor') }),
  });
  // A mirror is served as it was copied: no source polls it (they'd re-sync it against the fakes).
  if (MIRROR) {
    // The catch-up ledger, filled once from the copy's last day (Done events, open briefs, merged PRs read through gh).
    if (desk.updates) {
      await desk.updates.backfill(Date.now() - 24 * 3_600_000, desk.store.recentEvents(5_000, ['done', 'source.done', 'chapter.settled']));
      log('updates', { lines: desk.updates.list().length, chapters: desk.updates.chapters().length });
    }
    return log('ready', { items: desk.core.items().length });
  }
  await desk.pollSources();
  await desk.core.drainSummaries();
  if (args.has('--conversation-window')) seedConversationWindow(desk.core, Date.now() - 60_000);
  if (args.has('--labelled-conversation')) seedLabelledConversation(desk.core, Date.now() - 60_000);
  if (args.has('--ask-report')) seedAskReport(desk.core, Date.now() - 60_000, 't3');
  if (args.has('--missing-answer')) seedMissingAnswerReport(desk.core, Date.now() - 60_000, 't3');
  // Retained history has no source adapter: exercise its read-only UI in the sandbox.
  desk.core.store.createItem({ id: 't3:retired-example', source: 't3', kind: 'thread', conversationKey: 't3:retired-example', agentId: 'helper', agentName: 'Helper', place: 'tango · Trail map export plan' });
  desk.core.store.addMessage({ messageId: 'retired-message', itemId: 't3:retired-example', author: 'agent', at: Date.now(), text: 'This historical conversation remains readable.' });

  // Bot turn events, through the real endpoint: Sierra is mid-turn on the receipts.
  const event = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${PORT}/api/desk/agent-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'sierra', conversationKey: `thread:${THREADS.receipts.id}`, turnId: 'turn-r1', at: Date.now(), ...body }) });
  await event({ type: 'turn.started', at: Date.now() - 10 * 60_000 });
  await event({ type: 'turn.activity', activity: '29 of 41 matched · 2 flagged so far' });
  desk.start();
  log('seeded', { items: desk.core.items().length });
});

const closeVoice = voice ? attachDeskVoice(httpServer as http.Server, app, voice) : undefined;

closeServices = () => {
  closeVoice?.();
  desk.close();
  hub.close();
  botStub.close();
};
