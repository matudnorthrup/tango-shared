#!/usr/bin/env node
// tango-screen: show a scene on the Tango screens from a coding-agent session
// (Loom threads, any repo). It talks to the screen service on this
// machine and files the scene under the thread it runs in (Loom's
// TANGO_DESK_ITEM, or --thread loom:<id>), so the scene shows on
// that thread's Agent Desk card and a tap on it starts a turn in the thread.
//
//   tango-screen show <file|folder|url|->  [--title T] [--summary S] [--slot main]
//                                          [--choice A --choice B] [--state JSON] [--urgent]
//                                          [--ttl MINUTES] [--kind html|markdown|image|video|url]
//                                          [--entry index.html] [--thread ID]
//   tango-screen prototype <folder|file|url> [--title T] [--name main] [--entry index.html]
//                                          [--ttl MINUTES] [--thread ID]
//   tango-screen update [--slot main] [--state JSON] [--replace-state] [--summary S]
//   tango-screen list                      this thread's scenes and prototypes
//   tango-screen clear [--slot main | --all | --prototype [--name main]]
//   tango-screen thread                    which Loom thread this session belongs to
//   tango-screen watch-pr [PR URL] [--notify] [--off] [--thread ID]
//                                          the desk watches the PR's review (default: the thread's PR)
//   tango-screen coordinator context <projectId>          a project coordinator's read of its conversations (JSON)
//   tango-screen coordinator transcript <projectId> <itemId> [--limit N]   one of its conversations' messages
//   tango-screen coordinator draft <projectId> --to <itemId> "<question>"
//                                          drafts a question for one of the project's conversations
//
// Desk mail: talk to other agents' conversations (Tango agents and Loom threads)
//   tango-screen threads [--project ID] [--status working|idle|needs owner|failed|watching] [--agent A] [--all]
//                                          every conversation on the desk: id, status, title, what it's doing
//   tango-screen fan-out [list|fanOutId] [--thread ID]  progress and results for this thread
//   tango-screen peek <itemId> [--limit N] one conversation, read-only: where it stands and its last messages
//   tango-screen send <itemId> "<message>" [--no-reply] [--now] [--wake]
//     Peer chains past 8 reply hops get one desk notice; mail continues. Started/reopened workers start at zero;
//     no-reply mail and replies to it add no hops. All pairs deliver 6/hour;
//     excess is held with an estimated time (also with --now), with notices and two-day expiry.
//                                          mail it: delivered when it's next idle (--now --no-reply: an FYI
//                                          into a running turn too; --wake: a parked or finished one). Its answer comes
//                                          back to you as a turn ("✉️ Reply from …") once you're idle, or:
//   tango-screen wait <mailId> [--timeout SECONDS]   block until the answer arrives and print it
//   tango-screen mail                      this conversation's mail, sent and received
//   tango-screen reply <mailId> "<answer>"  answer mail you got mid-task (its footer says when); the desk takes it back
//   tango-screen whoami                    this conversation's desk item id (what others mail)
//   tango-screen decision <D-n>            the link to a decision's brief page (put it beside the id when you pass a brief up)
//   tango-screen role <interactive|worker|ops|default> [--parent ITEM]
//                                          who this conversation works for (default: interactive; a thread
//                                          another conversation started is a worker under it)
//   tango-screen start "<task>" [--title T] [--repo R] [--project ID | --no-project] [--mode auto|worktree|local] [--same-tree]
//                      [--account A] [--no-report] [--role worker|interactive|ops|default] [--tier T]
//                                          start a new thread for a separate piece of work (Loom, best account;
//                                          this repo and desk project by default). The task is its opening turn;
//                                          its first answer comes back to you as "✉️ Reply from …" (or `wait`)
//
// Mail is words only; it never answers or approves anything a conversation is waiting on the owner
// for. The owner sees every mail in both conversations on the desk. Mail arriving here starts with
// "✉️ Mail from “…” [itemId] · m-…": answer it in your reply and the desk takes the answer back.
//
// What `show` does with each target:
//   folder          uploads it (no dotfiles, no node_modules) and shows its index.html
//   .html file      uploads it (plus its folder when it links relative files) and shows it as-is
//   image / video   uploads it and shows it full screen
//   .md file        renders it as markdown
//   http(s) URL     shows it; a localhost URL is exposed on the tailnet first (tshare port)
//   -               HTML from stdin, rendered with the screen's base styles and `tango` bridge
//
// `prototype` publishes the real, clickable thing to the desk's Prototype view
// (a folder or .html page is uploaded; a localhost URL is put on the tailnet).
// The owner opens it from the thread's card or by voice, clicks through it, and
// the operator can drive an uploaded one ("click Continue", "scroll down",
// "go back"). A screen is the glance; a prototype is the thing to use. It lasts
// three days (--ttl), and publishing again under the same --name updates it in
// place, reloading it on any screen showing it.
//
// `watch-pr` hands a PR review wait to the desk, which polls GitHub for as long
// as it takes (days, weeks) and outlives this session: end your turn instead of
// holding a watcher open. The thread shows as Watching while the review is
// pending. On approval the desk posts a message into this thread so you pick it
// back up and merge if the project allows (--notify: only the owner's card says
// "approved — merge?"). A merged or closed PR drops off; --off stops watching.
//
// Everything stays on this machine and the tailnet. Nothing here belongs in a
// commit, a PR, or a team-facing note.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2000;
const DEFAULT_TTL_MINUTES = 24 * 60;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache']);

class CliError extends Error {}

// ── targets ──────────────────────────────────────────────────────────────

/** True when HTML refers to files next to it (src/href that isn't a URL, data:, #, or root-absolute). */
export function hasRelativeRefs(html) {
  for (const match of html.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi)) {
    const ref = match[2].trim();
    if (ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/|\{\{|\$\{)/i.test(ref)) return true;
  }
  return /\burl\(\s*(["']?)(?![a-z][a-z0-9+.-]*:|\/|#|data:)[^)"']+\1\s*\)/i.test(html);
}

/** Every file under `root` worth uploading: no dotfiles, no dependency or build caches, no symlinks. */
export function collectFiles(root, { maxFiles = MAX_BUNDLE_FILES, maxBytes = MAX_BUNDLE_BYTES } = {}) {
  const files = [];
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        bytes += size;
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), abs: full, size });
        if (files.length > maxFiles) throw new CliError(`${root} has more than ${maxFiles} files; pass a smaller folder`);
        if (bytes > maxBytes) throw new CliError(`${root} is over ${maxBytes / 1024 / 1024} MB; pass a smaller folder`);
      }
    }
  };
  walk(root);
  return files;
}

/** Which page of a folder to show: --entry, else index.html, else its only HTML file. */
export function pickEntry(files, entry) {
  if (entry) {
    const wanted = entry.replace(/^\.\//, '');
    if (!files.some((file) => file.path === wanted)) throw new CliError(`--entry ${entry} is not in the folder`);
    return wanted;
  }
  if (files.some((file) => file.path === 'index.html')) return 'index.html';
  const pages = files.filter((file) => /\.html?$/i.test(file.path));
  if (pages.length === 1) return pages[0].path;
  throw new CliError(pages.length ? `the folder has several pages and no index.html; pass --entry (${pages.slice(0, 5).map((p) => p.path).join(', ')})` : 'the folder has no HTML page');
}

/**
 * How to show a target: {kind, body} for an inline scene, {kind, upload: {root, files, entry}} for
 * an uploaded bundle, or {kind: 'url', localPort, url} for a dev server that needs exposing first.
 */
export function planTarget(target, { kind, entry, stdin, cwd = process.cwd() } = {}) {
  if (target === '-') return { kind: kind ?? 'html', body: stdin ?? '' };
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)) {
      return { kind: 'url', localPort: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url };
    }
    return { kind: 'url', body: target };
  }
  const abs = path.resolve(cwd, target);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new CliError(`no such file or folder: ${target}`);
  }
  if (stat.isDirectory()) {
    const files = collectFiles(abs);
    return { kind: 'url', upload: { root: abs, files, entry: pickEntry(files, entry) } };
  }
  const ext = path.extname(abs).toLowerCase();
  if (kind === 'html') return { kind: 'html', body: fs.readFileSync(abs, 'utf8') };
  if (kind === 'markdown' || ext === '.md' || ext === '.markdown') return { kind: 'markdown', body: fs.readFileSync(abs, 'utf8') };
  const single = (sceneKind) => ({ kind: sceneKind, upload: { root: path.dirname(abs), files: [{ path: path.basename(abs), abs, size: stat.size }], entry: path.basename(abs) } });
  if (IMAGE_EXT.has(ext)) return single(kind === 'url' ? 'url' : 'image');
  if (VIDEO_EXT.has(ext)) return single(kind === 'url' ? 'url' : 'video');
  if (ext === '.html' || ext === '.htm') {
    if (!hasRelativeRefs(fs.readFileSync(abs, 'utf8'))) return single('url');
    const root = path.dirname(abs);
    const files = collectFiles(root);
    return { kind: 'url', upload: { root, files, entry: path.relative(root, abs).split(path.sep).join('/') } };
  }
  throw new CliError(`don't know how to show ${path.basename(abs)}; pass an HTML/markdown/image/video file, a folder, or a URL`);
}

// ── tailnet helpers (best effort) ────────────────────────────────────────

function tailscaleServe() {
  try {
    return JSON.parse(execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/** The tailnet URL `tailscale serve` maps to a local port, e.g. the screen's /tango-screen. */
export function tailnetUrlFor(status, port, pathPrefix) {
  for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
    for (const [mount, handler] of Object.entries(web?.Handlers ?? {})) {
      const proxy = handler?.Proxy ?? '';
      if (!new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy)) continue;
      if (pathPrefix !== undefined && mount !== pathPrefix && mount !== `${pathPrefix}/`) continue;
      const [host, servePort] = hostPort.split(':');
      return `https://${host}${servePort && servePort !== '443' ? `:${servePort}` : ''}${mount === '/' ? '' : mount.replace(/\/$/, '')}`;
    }
  }
  return null;
}

function exposePort(port) {
  const known = tailnetUrlFor(tailscaleServe(), port);
  if (known) return known;
  try {
    return execFileSync('tshare', ['port', String(port)], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new CliError(`localhost:${port} is not on the tailnet and \`tshare port ${port}\` failed (${err.message.split('\n')[0]}); screens can't open localhost`);
  }
}

// ── screen service ───────────────────────────────────────────────────────

function screenUrl(env) {
  return (env.TANGO_SCREEN_URL ?? 'http://127.0.0.1:9410').replace(/\/$/, '');
}

async function call(env, method, pathname, body, timeoutMs = 60_000) {
  let response;
  try {
    response = await fetch(`${screenUrl(env)}${pathname}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new CliError(`the screen service is not reachable at ${screenUrl(env)}: ${err.message}`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) throw Object.assign(new CliError(String(parsed.error ?? `screen service: HTTP ${response.status}`)), { status: response.status });
  return parsed;
}

async function readLoom(env, pathname) {
  const home = env.LOOM_HOME || path.join(os.homedir(), '.tango', 'loom');
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  const base = env.LOOM_URL || `http://127.0.0.1:${env.LOOM_PORT || 9420}`;
  const response = await fetch(`${base}${pathname}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new CliError(`Loom lookup failed (${response.status})`);
  return response.json();
}

async function upload(env, { files }) {
  const payload = files.map((file) => ({ path: file.path, data: fs.readFileSync(file.abs).toString('base64') }));
  return call(env, 'POST', '/api/bundles', { files: payload });
}

function parseJson(value, flag) {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new CliError(`${flag} must be a JSON object`);
}

async function threadPrototypes(env, conversationKey, name) {
  const query = new URLSearchParams({ conversationKey, agentId: 'loom', ...(name ? { name } : {}) });
  const { prototypes } = await call(env, 'GET', `/api/prototypes?${query}`);
  return prototypes;
}

async function threadScenes(env, conversationKey, slot) {
  const query = new URLSearchParams({ conversationKey, ...(slot ? { slot } : {}) });
  const { scenes } = await call(env, 'GET', `/api/stages/loom?${query}`);
  return scenes;
}

// ── commands ─────────────────────────────────────────────────────────────

const OPTIONS = {
  title: { type: 'string' },
  summary: { type: 'string' },
  slot: { type: 'string' },
  name: { type: 'string' },
  prototype: { type: 'boolean' },
  choice: { type: 'string', multiple: true },
  state: { type: 'string' },
  'replace-state': { type: 'boolean' },
  urgent: { type: 'boolean' },
  ttl: { type: 'string' },
  kind: { type: 'string' },
  entry: { type: 'string' },
  thread: { type: 'string' },
  all: { type: 'boolean' },
  'no-check': { type: 'boolean' },
  notify: { type: 'boolean' },
  off: { type: 'boolean' },
  json: { type: 'boolean' },
  to: { type: 'string' },
  limit: { type: 'string' },
  project: { type: 'string' },
  status: { type: 'string' },
  agent: { type: 'string' },
  from: { type: 'string' },
  'no-reply': { type: 'boolean' },
  'no-report': { type: 'boolean' },
  'no-project': { type: 'boolean' },
  repo: { type: 'string' },
  mode: { type: 'string' },
  'same-tree': { type: 'boolean' },
  account: { type: 'string' },
  role: { type: 'string' },
  tier: { type: 'string' },
  parent: { type: 'string' },
  now: { type: 'boolean' },
  wake: { type: 'boolean' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

async function coordinatorCommand({ env, out, values, args }) {
  const [sub, id, ...rest] = args;
  if (sub === 'context') {
    if (!id) throw new CliError('coordinator context needs a project id');
    return out(JSON.stringify(await call(env, 'GET', `/api/desk/projects/${encodeURIComponent(id)}/coordinator/context`), null, 2));
  }
  if (sub === 'transcript') {
    const itemId = rest[0];
    if (!id || !itemId) throw new CliError('coordinator transcript needs a project id and an item id');
    const limit = Math.min(200, Math.max(1, Number(values.limit ?? 40) || 40));
    const result = await call(env, 'GET', `/api/desk/projects/${encodeURIComponent(id)}/coordinator/transcript/${encodeURIComponent(itemId)}?limit=${limit}`);
    if (values.json) return out(JSON.stringify(result, null, 2));
    for (const message of result.messages ?? []) out(`── ${message.author ?? message.role ?? '?'} · ${message.at ? new Date(message.at).toISOString() : ''}\n${message.text ?? ''}\n`);
    return;
  }
  if (sub === 'draft') {
    const text = rest.join(' ').trim();
    if (!id || !values.to || !text) throw new CliError('coordinator draft needs a project id, --to <itemId> and the question');
    const result = await call(env, 'POST', `/api/desk/projects/${encodeURIComponent(id)}/coordinator/drafts`, { to: values.to, text });
    return out(result.draft.state === 'queued' ? `queued for ${result.draft.toTitle}: it is sent once that conversation is idle` : `drafted for ${result.draft.toTitle}: the owner decides whether it is sent`);
  }
  throw new CliError('coordinator needs context, transcript or draft; try --help');
}

// ── desk mail ────────────────────────────────────────────────────────────

const MAIL_COMMANDS = new Set(['threads', 'peek', 'send', 'wait', 'mail', 'whoami', 'start', 'reply', 'role', 'decision']);

/** The current Loom conversation, supplied by its session host. */
export function deskItemFromEnv(env) {
  return typeof env.TANGO_DESK_ITEM === 'string' && env.TANGO_DESK_ITEM ? env.TANGO_DESK_ITEM : null;
}

function rejectRetired(item) {
  if (typeof item === 'string' && /^t3(?::|$)/i.test(item)) throw new CliError('T3 is retired; use Loom');
}

async function selfItem(env, cwd, values) {
  const override = values.thread ?? env.TANGO_SCREEN_THREAD;
  rejectRetired(override);
  const item = values.from ?? (override ? (override.startsWith('loom:') ? override : `loom:${override}`) : deskItemFromEnv(env));
  rejectRetired(item);
  if (item) return item;
  throw new CliError('No conversation selected; run inside Loom or pass --from <itemId>');
}

export async function resolveConversation(env, cwd, values) {
  const override = values.thread ?? env.TANGO_SCREEN_THREAD;
  if (env.T3_THREAD_ID) throw new CliError('T3 is retired; use Loom');
  rejectRetired(override);
  const item = override ? (override.startsWith('loom:') ? override : `loom:${override}`) : deskItemFromEnv(env);
  rejectRetired(item);
  if (typeof item === 'string' && item.startsWith('loom:') && item.length > 5) {
    return { thread: { id: item.slice(5), title: 'this Loom thread' }, conversationKey: item, projectName: repoName(cwd), runtime: 'Loom' };
  }
  throw new CliError('No Loom conversation selected; run inside Loom or pass --thread loom:<id>');
}

/** The repo's name for a scene's byline: its top-level folder (a worktree's main checkout), else the folder here. */
function repoName(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.basename(path.dirname(common));
  } catch {
    return path.basename(cwd);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mailCommand({ command, env, cwd, out, values, args }) {
  if (command === 'whoami') return out(await selfItem(env, cwd, values));
  if (command === 'decision') {
    const id = /^D-\d+$/i.test(args[0] ?? '') ? args[0].toUpperCase() : null;
    if (!id) throw new CliError('usage: tango-screen decision <D-n>');
    const base = tailnetUrlFor(tailscaleServe(), new URL(screenUrl(env)).port || 80, '/tango-screen');
    if (!base) throw new CliError("the desk isn't on the tailnet here (tailscale serve has no /tango-screen); name the id and say where to open it");
    return out(`${base}/decision/${id}`);
  }
  if (command === 'threads') {
    const query = new URLSearchParams();
    for (const key of ['project', 'status', 'agent', 'limit']) if (values[key]) query.set(key, values[key]);
    if (values.all) query.set('all', '1');
    const { threads } = await call(env, 'GET', `/api/desk/mail/threads?${query}`);
    if (values.json) return out(JSON.stringify(threads, null, 2));
    let me = null;
    try {
      me = await selfItem(env, cwd, values);
    } catch {
      // not inside a conversation the desk knows: no "you" marker
    }
    if (!threads.length) return out('no conversations');
    for (const t of threads) {
      const where = [t.agent, t.project ? `project ${t.project}` : null, t.disposition !== 'active' ? t.disposition : null, t.mail === 'off' ? 'mail off' : null].filter(Boolean).join(' · ');
      out(`${t.id}${t.id === me ? '  (you)' : ''}\n  [${t.status}] ${t.title}  (${where})${t.gist ? `\n  ${t.gist}` : ''}`);
    }
    return;
  }
  if (command === 'peek') {
    const id = args[0];
    if (!id) throw new CliError('peek needs an item id (see threads)');
    let peek;
    const limit = Math.min(60, Math.max(1, Number(values.limit ?? 12) || 12));
    try { peek = await call(env, 'GET', `/api/desk/mail/peek/${encodeURIComponent(id)}?limit=${limit}`); }
    catch (error) {
      if (error.status !== 404 || !id.startsWith('loom:')) throw error;
      const detail = await readLoom(env, `/threads/${encodeURIComponent(id.slice(5))}`);
      if (detail.thread.kind !== 'probe') throw error;
      peek = { id, title: detail.thread.title, status: detail.thread.status, agent: detail.thread.provider,
        messages: detail.messages.slice(-limit).map(m => ({ author: m.role, at: new Date(m.created_at).toISOString(), text: m.text })) };
    }
    if (values.json) return out(JSON.stringify(peek, null, 2));
    out(`${peek.title}  [${peek.status}${peek.idle ? ', idle' : ''}]  ${peek.agent} · ${peek.id}`);
    if (peek.summary || peek.gist) out(`\n${peek.summary || peek.gist}`);
    if (peek.ask) out(`\nWaiting on the owner for: ${peek.ask}`);
    out('');
    for (const m of peek.messages) out(`── ${m.author} · ${m.at}\n${m.text}\n`);
    return;
  }
  if (command === 'send') {
    const [to, ...rest] = args;
    const text = rest.join(' ').trim();
    if (!to || !text) throw new CliError('send needs an item id and the message: tango-screen send <itemId> "…"');
    const from = await selfItem(env, cwd, values);
    const { mail } = await call(env, 'POST', '/api/desk/mail', { from, to, text, expect: values['no-reply'] ? 'none' : 'reply', now: values.now === true, wake: values.wake === true });
    if (values.json) return out(JSON.stringify(mail, null, 2));
    out(`${mail.id}: mail to “${mail.toTitle}” is ${mail.state === 'draft' ? 'drafted for the owner’s approval; not sent' : mail.state === 'queued' ? (mail.heldUntil ? `held by the hourly pair limit until approximately ${mail.heldUntil}` : String(mail.to).startsWith('loom:') ? 'on its way: a Loom thread reads it as soon as its current step finishes' : 'queued; delivered when it is next idle') : mail.state}`);
    if (mail.expect === 'reply') out(`its answer comes back to you as a turn once you're idle; or block on it now with: tango-screen wait ${mail.id}`);
    return;
  }
  if (command === 'role') {
    const role = args[0];
    if (!['interactive', 'worker', 'ops', 'default'].includes(role)) throw new CliError('role needs one of: interactive, worker, ops, default');
    const itemId = await selfItem(env, cwd, values);
    const commandId = `cli-role-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await call(env, 'POST', '/api/desk/commands', { commandId, type: 'role', itemId, actor: 'agent', args: { role, ...(values.parent ? { parentItemId: values.parent } : {}) } });
    if (result.status === 'failed') throw new CliError(result.error || 'the desk refused the role');
    return out(`${itemId} is now ${result.outcome.role}${result.outcome.parentItemId ? ` under ${result.outcome.parentItemId}` : ''}`);
  }
  if (command === 'start') {
    const prompt = args.join(' ').trim();
    if (!prompt) throw new CliError('start needs the task: tango-screen start "…"');
    const from = await selfItem(env, cwd, values);
    // One id for this start: a retry after a timeout is the same start, never a second thread.
    const commandId = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const body = {
      from,
      prompt,
      commandId,
      ...(values.title ? { title: values.title } : {}),
      ...(values.repo ? { repo: values.repo } : {}),
      ...(values['no-project'] ? { projectId: null } : values.project ? { projectId: values.project } : {}),
      ...(values.mode ? { mode: values.mode } : {}),
      ...(values['same-tree'] ? { sameTree: true } : {}),
      ...(values.account ? { account: values.account } : {}),
      ...(values.role ? { role: values.role } : {}),
      ...(values.tier !== undefined ? { tier: values.tier } : {}),
      report: !values['no-report'],
    };
    let result;
    try {
      // Past Loom's own 150 s for making a worktree.
      result = await call(env, 'POST', '/api/desk/mail/start', body, 180_000);
    } catch (err) {
      if (!/not reachable|aborted|timeout/i.test(String(err.message))) throw err;
      result = await call(env, 'POST', '/api/desk/mail/start', body, 180_000);
    }
    if (values.json) return out(JSON.stringify(result, null, 2));
    out(`started “${result.mail.toTitle}” (${result.itemId}) · ${result.mail.id}`);
    if (result.projectSkipped) out('note: its desk project was finished or deleted while it started, so it is on its own');
    if (result.mail.expect === 'reply') out(`its first answer comes back to you as a turn once you're idle; or block on it with: tango-screen wait ${result.mail.id}`);
    return;
  }
  if (command === 'reply') {
    const [id, ...rest] = args;
    const text = rest.join(' ').trim();
    if (!id || !text) throw new CliError('reply needs a mail id and your answer: tango-screen reply m-… "…"');
    const from = await selfItem(env, cwd, values);
    const { mail } = await call(env, 'POST', `/api/desk/mail/${encodeURIComponent(id)}/answer`, { from, text });
    return out(`answered ${mail.id}: the desk takes it back to “${mail.fromTitle}”`);
  }
  if (command === 'wait') {
    const id = args[0];
    if (!id) throw new CliError('wait needs a mail id');
    const timeout = Math.min(3600, Math.max(5, Number(values.timeout ?? 600) || 600)) * 1000;
    const until = Date.now() + timeout;
    for (;;) {
      const mail = await call(env, 'GET', `/api/desk/mail/${encodeURIComponent(id)}?claim=1`);
      if (mail.state === 'answered' || mail.answer) return out(values.json ? JSON.stringify(mail, null, 2) : `✉️ Reply from “${mail.toTitle}” (${mail.to}):\n\n${mail.answer}`);
      if (['failed', 'dropped', 'unanswered', 'done'].includes(mail.state)) throw new CliError(`${id} is ${mail.state}${mail.error ? `: ${mail.error}` : ''}`);
      if (Date.now() >= until) throw new CliError(`no answer to ${id} yet (it is ${mail.state}); it will still come back to you as a turn when it arrives`);
      await sleep(5_000);
    }
  }
  if (command === 'mail') {
    const item = await selfItem(env, cwd, values);
    const { mail } = await call(env, 'GET', `/api/desk/mail?item=${encodeURIComponent(item)}`);
    if (values.json) return out(JSON.stringify(mail, null, 2));
    if (!mail.length) return out('no mail yet');
    for (const m of mail) {
      const outgoing = m.from === item;
      out(`${m.id} ${outgoing ? `→ “${m.toTitle}” (${m.to})` : `← “${m.fromTitle}” (${m.from})`} [${m.state}] ${m.createdAt}\n  ${m.text.replace(/\s+/g, ' ').slice(0, 200)}${m.answer ? `\n  answer: ${m.answer.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
    }
  }
}

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  return text.slice(1, text.findIndex((line, i) => i > 1 && !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, '')).join('\n');
}

export async function run(argv, { env = process.env, cwd = process.cwd(), out = console.log, readStdin, exec = execFileSync } = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, target] = positionals;
  if (values.help || !command) return out(usage());
  for (const item of [values.from, values.parent, values.agent, values.thread, env.TANGO_SCREEN_THREAD, env.TANGO_DESK_ITEM, ...(['peek', 'send'].includes(command) ? [target] : [])]) rejectRetired(item);
  if (env.T3_THREAD_ID) throw new CliError('T3 is retired; use Loom');
  const slot = values.slot?.trim() || 'main';

  // A project coordinator's reads and drafts: about the desk project, not the thread it runs in.
  if (command === 'coordinator') return coordinatorCommand({ env, out, values, args: positionals.slice(1) });
  // Desk mail: about other conversations; the sender is this one (Loom: TANGO_DESK_ITEM).
  if (MAIL_COMMANDS.has(command)) return mailCommand({ command, env, cwd, out, values, args: positionals.slice(1) });

  const { thread, conversationKey, projectName, runtime } = await resolveConversation(env, cwd, values);

  if (command === 'fan-out') {
    const suffix = !target || target === 'list' ? '' : `/${encodeURIComponent(target)}`;
    return out(JSON.stringify(await readLoom(env, `/threads/${encodeURIComponent(thread.id)}/fan-outs${suffix}`), null, 2));
  }

  if (command === 'thread') return out(`${thread.id}  ${thread.title}  (${projectName}${thread.worktreePath ? `, ${thread.worktreePath}` : ''})`);

  if (command === 'watch-pr') {
    let url = target;
    if (!url) {
      try {
        url = exec('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { /* A checkout without a PR needs an explicit URL. */ }
    }
    if (!url) throw new CliError('watch-pr needs a PR URL (this thread has no PR of its own)');
    const result = await call(env, 'POST', '/api/desk/pr-watch', { conversationKey, url, onApprove: values.notify ? 'notify' : 'continue', off: values.off === true });
    if (values.json) return out(JSON.stringify(result, null, 2));
    if (values.off) return out(result.unchanged ? `was not watching ${result.url}` : `stopped watching ${result.url}`);
    out(`the desk is watching PR #${result.number} for its review (${result.url}) on ${thread.id.slice(0, 8)} ${thread.title}`);
    out(result.onApprove === 'continue' ? 'on approval it posts here so you pick it back up; you can end your turn now' : 'on approval the owner gets "approved — merge?"; you can end your turn now');
    return;
  }

  if (command === 'list') {
    const scenes = await threadScenes(env, conversationKey);
    const prototypes = await threadPrototypes(env, conversationKey).catch(() => []);
    if (!scenes.length && !prototypes.length) return out('no live scenes or prototypes for this thread');
    for (const scene of scenes) out(`${scene.slot}\t${scene.kind}\tv${scene.version}\t${scene.title || scene.summary}\t(${scene.id})`);
    for (const prototype of prototypes) out(`prototype ${prototype.name}\tv${prototype.version}\t${prototype.title || prototype.url}\t(${prototype.id})`);
    return;
  }

  if (command === 'clear' && values.prototype) {
    const name = values.name?.trim() || 'main';
    const prototypes = await threadPrototypes(env, conversationKey, values.all ? undefined : name);
    for (const prototype of prototypes) await call(env, 'DELETE', `/api/prototypes/${encodeURIComponent(prototype.id)}`);
    return out(prototypes.length ? `cleared prototype ${prototypes.map((prototype) => prototype.name).join(', ')}` : `no prototype${values.all ? '' : ` named ${name}`} to clear`);
  }

  if (command === 'prototype') return publishPrototype({ env, cwd, out, values, target, thread, conversationKey, projectName, runtime });

  if (command === 'clear') {
    const scenes = await threadScenes(env, conversationKey, values.all ? undefined : slot);
    for (const scene of scenes) await call(env, 'DELETE', `/api/scenes/${encodeURIComponent(scene.id)}`);
    return out(scenes.length ? `cleared ${scenes.map((scene) => scene.slot).join(', ')}` : `nothing to clear${values.all ? '' : ` in slot ${slot}`}`);
  }

  if (command === 'update') {
    const [scene] = await threadScenes(env, conversationKey, slot);
    if (!scene) throw new CliError(`no live scene in slot ${slot} for this thread`);
    await call(env, 'PATCH', `/api/scenes/${encodeURIComponent(scene.id)}`, {
      state: parseJson(values.state, '--state'),
      summary: values.summary,
      replaceState: values['replace-state'] === true,
    });
    return out(`updated ${slot} (${scene.id})`);
  }

  if (command !== 'show') throw new CliError(`unknown command ${command}; try --help`);
  if (!target) throw new CliError('show needs a file, folder, URL, or - (HTML on stdin)');
  const title = values.title?.trim();
  const summary = values.summary?.trim() || title;
  if (!summary) throw new CliError('pass --title (and optionally --summary): one line saying what the scene shows');
  if (values.kind && !['html', 'markdown', 'image', 'video', 'url'].includes(values.kind)) throw new CliError('--kind must be html, markdown, image, video, or url');

  const stdin = target === '-' ? await (readStdin ?? (() => fs.readFileSync(0, 'utf8')))() : undefined;
  const plan = planTarget(target, { kind: values.kind, entry: values.entry, stdin, cwd });
  let body = plan.body;
  let bundlePath;
  if (plan.upload) {
    const saved = await upload(env, plan.upload);
    bundlePath = `${saved.base}${plan.upload.entry.split('/').map(encodeURIComponent).join('/')}`;
    body = bundlePath;
  } else if (plan.localPort) {
    const base = exposePort(plan.localPort);
    body = `${base}${plan.url.pathname}${plan.url.search}${plan.url.hash}`;
  }
  if (!body?.trim()) throw new CliError('nothing to show (empty body)');

  const ttl = values.ttl === undefined ? DEFAULT_TTL_MINUTES : Number(values.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new CliError('--ttl must be a number of minutes');
  const result = await call(env, 'POST', '/api/scenes', {
    agentId: 'loom',
    agentName: `${runtime} · ${projectName}`,
    slot,
    kind: plan.kind,
    title,
    body,
    summary,
    choices: values.choice,
    state: parseJson(values.state, '--state'),
    urgent: values.urgent === true,
    ttlMinutes: ttl,
    conversationKey,
    check: values['no-check'] ? false : undefined,
  });

  const publicBase = tailnetUrlFor(tailscaleServe(), new URL(screenUrl(env)).port || 80, '/tango-screen');
  const report = {
    sceneId: result.sceneId,
    slot: result.slot,
    version: result.version,
    replaced: result.replaced,
    thread: `${thread.id.slice(0, 8)} ${thread.title}`,
    ...(publicBase ? { scene: `${publicBase}/frame/${result.sceneId}`, desk: `${publicBase}/` } : {}),
    ...(publicBase && bundlePath ? { open: `${publicBase}/${bundlePath}` } : {}),
    ...(result.check ? { check: result.check } : {}),
    ...(result.google ? { google: result.google } : {}),
    ...(result.linear ? { linear: result.linear } : {}),
  };
  if (values.json) return out(JSON.stringify(report, null, 2));
  out(`${result.replaced ? 'updated' : 'staged'} “${title ?? summary}” in slot ${result.slot} (v${result.version}) on ${report.thread}`);
  if (report.scene) out(`scene: ${report.scene}`);
  if (report.open) out(`open:  ${report.open}`);
  if (report.desk) out(`desk:  ${report.desk}`);
  // A Google Docs/Sheets/Slides/Drive link: the service reads it through the owner's Google accounts.
  if (result.google?.error) out(`google: could not read it (${result.google.error}); the screen shows an open-in-Google card instead`);
  else if (result.google?.pending) out('google: still reading it; the screen shows it when ready');
  else if (result.google) out(`google: showing “${result.google.name}”${result.google.pages ? ` (${result.google.pages} pages)` : ''}`);
  // A Linear issue, project, or document link: the service reads it with the owner's Linear keys.
  if (result.linear?.error) out(`linear: could not read it (${result.linear.error}); the screen shows an open-in-Linear card instead`);
  else if (result.linear?.pending) out('linear: still reading it; the screen shows it when ready');
  else if (result.linear) out(`linear: showing ${result.linear.kind} “${result.linear.name}”`);
  const check = result.check;
  if (check && !check.skipped) {
    out(`check: ${check.ok ? 'ok' : 'FAILED'}${check.errors?.length ? `; errors: ${check.errors.join('; ')}` : ''}`);
    // Glance and phone warnings: fix them and show it again in the same slot.
    for (const warning of check.warnings ?? []) out(`  warning: ${warning}`);
    if (check.screenshot) out(`  screenshot (desk):  ${check.screenshot}`);
    if (check.phoneScreenshot) out(`  screenshot (phone): ${check.phoneScreenshot}`);
  }
  out('These links are tailnet-only and private: keep them out of commits, PRs, and team-facing notes.');
}

/** Plans a prototype target: an uploaded folder or page, or a URL (localhost goes on the tailnet first). */
export function planPrototype(target, { entry, cwd = process.cwd() } = {}) {
  if (!target) throw new CliError('prototype needs a folder, an .html page, or a URL');
  if (target === '-') throw new CliError('a prototype is a folder, an .html page, or a URL; for inline HTML use show');
  const plan = planTarget(target, { entry, cwd });
  if (plan.kind !== 'url' || (plan.upload && !/\.html?$/i.test(plan.upload.entry))) {
    throw new CliError(`a prototype is a folder, an .html page, or a URL (not ${path.basename(target)}); use show for images, video, and markdown`);
  }
  return plan;
}

async function publishPrototype({ env, cwd, out, values, target, thread, conversationKey, projectName, runtime }) {
  const plan = planPrototype(target, { entry: values.entry, cwd });
  let url = plan.body;
  if (plan.upload) {
    const saved = await upload(env, plan.upload);
    url = `${saved.base}${plan.upload.entry.split('/').map(encodeURIComponent).join('/')}`;
  } else if (plan.localPort) {
    url = `${exposePort(plan.localPort)}${plan.url.pathname}${plan.url.search}${plan.url.hash}`;
  }
  const ttl = values.ttl === undefined ? undefined : Number(values.ttl);
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) throw new CliError('--ttl must be a number of minutes');
  const title = values.title?.trim();
  const result = await call(env, 'POST', '/api/prototypes', {
    agentId: 'loom',
    agentName: `${runtime} · ${projectName}`,
    conversationKey,
    name: values.name?.trim() || 'main',
    title,
    url,
    ...(ttl !== undefined ? { ttlMinutes: ttl } : {}),
    check: values['no-check'] ? false : undefined,
  });
  const publicBase = tailnetUrlFor(tailscaleServe(), new URL(screenUrl(env)).port || 80, '/tango-screen');
  const open = /^https?:\/\//i.test(url) ? url : publicBase ? `${publicBase}/${url}` : null;
  const report = {
    prototypeId: result.id,
    name: result.name,
    version: result.version,
    replaced: result.replaced,
    drivable: result.drivable,
    thread: `${thread.id.slice(0, 8)} ${thread.title}`,
    ...(open ? { open } : {}),
    ...(publicBase ? { desk: `${publicBase}/` } : {}),
    ...(result.check ? { check: result.check } : {}),
  };
  if (values.json) return out(JSON.stringify(report, null, 2));
  out(`${result.replaced ? 'updated' : 'published'} prototype “${title || result.name}” (v${result.version}) on ${report.thread}`);
  if (result.showing) out('it is on screen now and reloaded in place');
  if (report.open) out(`open:  ${report.open}`);
  if (report.desk) out(`desk:  ${report.desk}  (the thread's card → Try the prototype, or say "show me the prototype")`);
  if (!result.drivable) out('note: a URL prototype is clickable on the desk, but voice can only drive uploaded pages');
  const check = result.check;
  if (check && !check.skipped) {
    out(`check: ${check.ok ? 'ok' : 'FAILED'}${check.errors?.length ? `; errors: ${check.errors.join('; ')}` : ''}`);
    for (const warning of check.warnings ?? []) out(`  warning: ${warning}`);
    if (check.screenshot) out(`  screenshot (desk):  ${check.screenshot}`);
    if (check.phoneScreenshot) out(`  screenshot (phone): ${check.phoneScreenshot}`);
  }
  out('These links are tailnet-only and private: keep them out of commits, PRs, and team-facing notes.');
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`tango-screen: ${err instanceof CliError || err?.code?.startsWith?.('ERR_PARSE_ARGS') ? err.message : err.stack ?? err}`);
    process.exit(1);
  });
}
