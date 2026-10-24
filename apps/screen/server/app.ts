import { registerVoiceRoute, type DeskVoiceOptions } from './desk/voice.js';
import { registerDictationHistory } from './desk/dictation-history.js';
import type { DictationHistoryStore } from './desk/dictation-history-store.js';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { withBuild } from './build.js';
import * as path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { compressResponses } from './compress.js';
import { accessControl, isDirectLocalCaller, refuseDetachedDriving, requireJsonPosts } from './access.js';
import { BUNDLE_CSP, BUNDLE_TYPES, BundleRejected, parseBundleRef, withStorageShim, type BundleStore } from './bundles.js';
import type { CheckResult } from './check.js';
import { registerInboxCompat, type InboxCompatOptions } from './desk/compat.js';
import { registerDeskRoutes, type DeskRoutesOptions } from './desk/routes.js';
import { timeRequests, type TimedRequest } from './desk/stalls.js';
import { FRAME_CSP, renderFrame, renderGoogleFrame, renderLinearFrame } from './frame.js';
import { parseGoogleUrl, type GoogleContent } from './google.js';
import { parseLinearUrl, type LinearContent } from './linear.js';
import { createEtags, moduleGraph, withModulePreloads } from './static-assets.js';
import { Hub, InputConflict, SCREEN_ROLES, parseScreenRole, publicScene, type DirectorTask, type ListPage, type PrototypePage, type Sink } from './hub.js';
import type { InboxEngine } from './inbox.js';
import type { InboxRules } from './inbox-rules.js';
import type { InboxState } from './inbox-store.js';
import { briefing, inboxCounts, inboxSources, inboxView, INBOX_FILTERS, type InboxFilter, type InboxSort } from './inbox-view.js';
import { mountPresentation } from './presentation.js';
import { withPrototypeBridge } from './prototype-bridge.js';
import { publicPrototype, type PrototypeStore } from './prototypes.js';
import { AssetRejected, SCENE_KINDS, type SceneChoice, type SceneKind, type SceneStore, type StageInput } from './store.js';

export interface AppOptions {
  dictationHistory?: DictationHistoryStore;
  voice?: DeskVoiceOptions;
  store: SceneStore;
  hub: Hub;
  publicDir: string;
  /** Renders a staged scene headlessly; omitted in tests. */
  check?: (sceneId: string, version: number) => Promise<CheckResult>;
  /** Renders an uploaded prototype page headlessly (errors and phone fit, no glance rules); omitted in tests. */
  checkPrototype?: (prototype: { id: string; url: string; version: number }) => Promise<CheckResult>;
  keepAliveMs?: number;
  /** Reads Google Docs/Sheets/Slides/Drive url scenes through the owner's gog accounts; without it they show as a card. */
  google?: GoogleContent;
  /** Reads Linear issue/project/document url scenes with the owner's API keys; without it they show as a card. */
  linear?: LinearContent;
  /** Prototype bundles served at /bundles/:id/*; uploads are local-only. */
  bundles?: BundleStore;
  /** Prototypes (the desk's Prototype view): pages the owner uses, which the operator can drive. */
  prototypes?: PrototypeStore;
  inbox?: {
    engine: InboxEngine;
    rules: InboxRules;
    /** Posts the owner's reply into the item's conversation and wakes the agent. */
    reply(input: { agentId: string; channelId: string; text: string; title: string }): Promise<string>;
    react(channelId: string, messageId: string, emoji: string): Promise<void>;
  };
  /** The Agent Desk (SCREEN_DESK=v2): its API, and the old /api/inbox* routes served from it. */
  desk?: {
    routes: DeskRoutesOptions;
    compat?: InboxCompatOptions;
  };
  /** Told about each slow API request, or one that waited long before it started (desk/stalls.ts). */
  onSlowRequest?: (request: TimedRequest) => void;
}

const MAX_BODY_CHARS = 2_000_000;
/** Under the CLI's 60 s request timeout. */
const GOOGLE_STAGE_WAIT_MS = 30_000;
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
};

class BadRequest extends Error {}

const UNREAD_STATES: readonly InboxState[] = ['queued'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Agents often wire data-choice taps without also passing `choices`. Read them
 * back out of the HTML so voice picks ("the second one") still resolve:
 * data-label, else the first heading or bold text in the element, else its text.
 */
export function choicesFromHtml(html: string): SceneChoice[] {
  const choices: SceneChoice[] = [];
  const tag = /<([a-z][a-z0-9-]*)\b([^>]*\bdata-choice\s*=\s*(["'])(.*?)\3[^>]*)>/gi;
  for (const match of html.matchAll(tag)) {
    const id = match[4]!.trim();
    if (!id || choices.some((choice) => choice.id === id)) continue;
    const explicit = /\bdata-label\s*=\s*(["'])(.*?)\1/i.exec(match[2]!)?.[2];
    const after = html.slice(match.index! + match[0].length, match.index! + match[0].length + 2000);
    const close = after.search(new RegExp(`</${match[1]}>`, 'i'));
    const inner = close >= 0 ? after.slice(0, close) : after;
    const heading = /<(h[1-4]|strong|b)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(inner)?.[2];
    const label = stripTags(explicit ?? heading ?? inner).slice(0, 80);
    if (label) choices.push({ id, label });
    if (choices.length >= 12) break;
  }
  return choices;
}

/** Accepts [{id,label}] or plain labels (ids become a, b, c…). */
export function parseChoices(value: unknown): SceneChoice[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequest('choices must be an array');
  return value.slice(0, 12).map((item, index) => {
    if (typeof item === 'string') return { id: String.fromCharCode(97 + index), label: item };
    const record = item as Record<string, unknown>;
    const label = str(record?.label);
    if (!label) throw new BadRequest('each choice needs a label');
    return { id: str(record.id) ?? String.fromCharCode(97 + index), label };
  });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The bridge's page snapshot, bounded: it's page content, and it goes into the operator's prompt. */
export function parsePrototypePage(value: unknown): PrototypePage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = (v: unknown, max = 80) => (typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : '');
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
  const scroll = (raw.scroll ?? {}) as Record<string, unknown>;
  return {
    path: text(raw.path, 200),
    title: text(raw.title),
    targets: list(raw.targets, 40)
      .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
      .map((t) => ({ label: text(t.label), kind: text(t.kind, 20) || 'button', inView: t.inView === true }))
      .filter((t) => t.label),
    headings: list(raw.headings, 20).map((h) => text(h)).filter(Boolean),
    fields: list(raw.fields, 12).map((f) => text(f)).filter(Boolean),
    scroll: { percent: Math.max(0, Math.min(100, Math.round(Number(scroll.percent) || 0))), scrollable: scroll.scrollable === true },
  };
}

// Capacity lands on the System page's Capacity tab (desk/next/nav.js placeRoute), so voice waits for 'system'.
const PLACE_PAGES = ['inbox', 'projects', 'project', 'agents', 'agent', 'system', 'search', 'spacesettings'] as const;

/** A screen's List, bounded: titles go into the operator's prompt. Null when it isn't one. */
export function parseListPage(value: unknown): ListPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = (v: unknown, max = 80) => (typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : '');
  const records = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []).map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}));
  const named = (r: Record<string, unknown>) => ({ id: text(r.id, 200), name: text(r.name, 40) });
  const tab = raw.tab && typeof raw.tab === 'object' ? named(raw.tab as Record<string, unknown>) : null;
  if (!tab?.id) return null;
  const project = raw.project && typeof raw.project === 'object' ? named(raw.project as Record<string, unknown>) : null;
  // The next layout's place (Inbox, Projects, a project, Agents, an agent) and its named agents.
  const placeRaw = raw.place && typeof raw.place === 'object' ? (raw.place as Record<string, unknown>) : null;
  const page = placeRaw && PLACE_PAGES.find((p) => p === placeRaw.page);
  const place = page
    ? { page, ...(text(placeRaw.id, 200) ? { id: text(placeRaw.id, 200) } : {}), ...(text(placeRaw.view, 200) ? { view: text(placeRaw.view, 200) } : {}), name: text(placeRaw.name, 60) }
    : null;
  const agents = Array.isArray(raw.agents) ? records(raw.agents, 40).map(named).filter((a) => a.id && a.name) : null;
  // The page's own views ("the Workers view", the System page's tabs) and the one it's on.
  const views = Array.isArray(raw.views) ? records(raw.views, 20).map((r) => ({ ...named(r), count: Math.max(0, Math.round(Number(r.count) || 0)) })).filter((v) => v.id && v.name) : null;
  const view = raw.view && typeof raw.view === 'object' ? named(raw.view as Record<string, unknown>) : null;
  return {
    ...(place ? { place } : {}),
    ...(agents ? { agents } : {}),
    ...(views ? { views } : {}),
    ...(view?.id ? { view } : {}),
    tab,
    tabs: records(raw.tabs, 20).map((r) => ({ ...named(r), count: Math.max(0, Math.round(Number(r.count) || 0)) })).filter((t) => t.id && t.name),
    project: project?.id ? project : null,
    projects: records(raw.projects, 40).map(named).filter((p) => p.id && p.name),
    rows: records(raw.rows, 40)
      .map((r) => ({ kind: r.kind === 'project' ? ('project' as const) : r.kind === 'agent' ? ('agent' as const) : ('item' as const), id: text(r.id, 200), title: text(r.title), where: text(r.where, 60) }))
      .filter((r) => r.id && r.title),
  };
}

function parseState(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    try {
      return parseState(JSON.parse(value));
    } catch {
      throw new BadRequest('state must be a JSON object');
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequest('state must be a JSON object');
  return value as Record<string, unknown>;
}

export function createApp(options: AppOptions): Hono {
  const { store, hub } = options;
  const keepAliveMs = options.keepAliveMs ?? 20_000;
  const app = new Hono();
  app.use('*', compressResponses());
  if (options.onSlowRequest) app.use('/api/*', timeRequests(options.onSlowRequest));
  app.use('*', accessControl({ allowedLogins: process.env.SCREEN_ALLOWED_LOGINS }));
  // Every desk write (commands, presentation, presence, operator, agent events, settings) is JSON.
  app.use('/api/desk/*', requireJsonPosts());
  // A detached window (`?detached=1`: an agent testing on the real desk) never drives the owner's windows.
  app.use('*', refuseDetachedDriving());

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof InputConflict) return c.json({ error: err.message }, 409);
    console.error('[screen] request failed', err);
    return c.json({ error: err.message }, 500);
  });

  const sse = (register: (sink: Sink) => string, unregister: (id: string) => void) =>
    (c: Context) =>
      streamSSE(c, async (stream) => {
        let open = true;
        const sink: Sink = {
          send(event, data) {
            if (open) void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined);
          },
        };
        const id = register(sink);
        stream.onAbort(() => {
          open = false;
          unregister(id);
        });
        while (open) {
          await stream.sleep(keepAliveMs);
          if (open) await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => (open = false));
        }
        unregister(id);
      });

  // ── screens ────────────────────────────────────────────────────────────
  app.get('/stream', (c) =>
    sse((sink) => hub.addScreen(c.req.query('name') ?? '', sink, parseScreenRole(c.req.query('role')) ?? 'full', { detached: c.req.query('detached') === '1', feedScope: c.req.query('feedScope') }), (id) => hub.removeScreen(id))(c),
  );

  app.get('/frame/:id', async (c) => {
    const scene = store.get(c.req.param('id'));
    if (!scene) return c.text('scene not found', 404);
    // Only live scenes a local agent staged (see POST /api/scenes) are read with the owner's accounts;
    // a cleared or expired one is a card, whoever still has its frame link.
    const live = scene.kind === 'url' && scene.status === 'live';
    const google = live && options.google && scene.origin.googleRead ? parseGoogleUrl(scene.body) : undefined;
    const linear = live && options.linear && scene.origin.linearRead ? parseLinearUrl(scene.body) : undefined;
    const html = google
      ? renderGoogleFrame(
          scene,
          google,
          await options.google!.render(google).then(
            (snapshot) => ({ snapshot }),
            (err: Error) => ({ error: err.message }),
          ),
        )
      : linear
        ? renderLinearFrame(
            scene,
            await options.linear!.render(linear).then(
              (snapshot) => ({ snapshot }),
              (err: Error) => ({ error: err.message }),
            ),
          )
        : renderFrame(scene);
    return c.body(html, 200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': FRAME_CSP,
      'cache-control': 'no-store',
    });
  });

  app.get('/assets/:name', async (c) => {
    const file = store.assetPath(c.req.param('name'));
    if (!file) return c.text('not found', 404);
    const data = await fsp.readFile(file);
    return c.body(new Uint8Array(data), 200, {
      'content-type': ASSET_TYPES[path.extname(file)] ?? 'application/octet-stream',
      // Served on the screen's own origin: an SVG opened directly must not run script.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
    });
  });

  // Uploaded images in a Linear scene's markdown need the owner's key; only ones a rendered frame referenced are served.
  app.get('/linear/upload/:scene/:token', async (c) => {
    // Like the frame: only while the scene is live and was staged by a local agent.
    const scene = store.get(c.req.param('scene'));
    const ref = scene && scene.kind === 'url' && scene.status === 'live' && scene.origin.linearRead ? parseLinearUrl(scene.body) : undefined;
    const upload = ref ? await options.linear?.upload(ref, c.req.param('token')) : undefined;
    if (!upload) return c.text('not found', 404);
    return c.body(upload.data, 200, {
      'content-type': upload.type,
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=86400',
    });
  });

  app.get('/google/:key/:file', async (c) => {
    const file = options.google?.pagePath(c.req.param('key'), c.req.param('file'));
    if (!file) return c.text('not found', 404);
    // The weekly sweep may remove it between the check and the read; never echo the cache path.
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) return c.text('not found', 404);
    return c.body(new Uint8Array(data), 200, {
      'content-type': ASSET_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=86400',
    });
  });

  // ── bundles (prototype folders) ────────────────────────────────────────
  app.post('/api/bundles', async (c) => {
    if (!options.bundles) return c.json({ error: 'bundles are not enabled' }, 404);
    // Local agents only: nothing that came through tailscale serve, and no browser.
    if (!isDirectLocalCaller(c.req.raw.headers)) return c.json({ error: 'bundle uploads are local-only' }, 403);
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const saved = options.bundles.save(body.files);
      return c.json({ ...saved, base: `bundles/${saved.id}/` });
    } catch (err) {
      if (err instanceof BundleRejected) throw new BadRequest(err.message);
      throw err;
    }
  });

  // A bundle opened at its folder URL without the slash: relative links need the slash.
  app.get('/bundles/:id', (c) => c.redirect(`${c.req.param('id')}/`, 301));
  app.get('/bundles/:id/*', async (c) => {
    const id = c.req.param('id');
    const prefix = `/bundles/${id}/`;
    const at = c.req.path.indexOf(prefix);
    let rest = at >= 0 ? c.req.path.slice(at + prefix.length) : '';
    try {
      rest = decodeURIComponent(rest);
    } catch {
      return c.text('not found', 404);
    }
    const file = options.bundles?.filePath(id, rest || 'index.html');
    if (!file) return c.text('not found', 404);
    const type = BUNDLE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'content-security-policy': BUNDLE_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
    // Every page gets the navigation bridge: inert unless framed, it lets the operator drive a prototype.
    if (type.startsWith('text/html')) return c.body(withPrototypeBridge(withStorageShim(await fsp.readFile(file, 'utf8'))), 200, headers);
    return c.body(new Uint8Array(await fsp.readFile(file)), 200, headers);
  });

  app.post('/api/input', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const sceneId = str(body.sceneId);
    const type = str(body.type);
    if (!sceneId || !type) throw new BadRequest('sceneId and type are required');
    const data = parseState(body.data) ?? {};
    const commandId = body.commandId === undefined ? undefined : str(body.commandId);
    if (body.commandId !== undefined && (!commandId || commandId.length > 128)) throw new BadRequest('commandId must be a non-empty string (128 chars max)');
    if (!store.get(sceneId)) return c.json({ error: 'unknown scene' }, 404);
    return c.json(await hub.input({ sceneId, type, data, commandId }));
  });

  /** The operator acknowledges an input it received; unacknowledged ones fall back to the bot. */
  app.post('/api/input/:commandId/ack', (c) => {
    const result = hub.ackInput(c.req.param('commandId'));
    return result ? c.json(result) : c.json({ error: 'unknown commandId' }, 404);
  });

  /** A screen reports what its List shows (tabs, project, rows in order), for voice. */
  app.post('/api/screens/:id/list', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const page = parseListPage(body.page);
    if (!page) throw new BadRequest('page must be the List snapshot');
    const touchedAt = Number(body.touchedAt) || 0;
    return hub.setListPage(c.req.param('id'), page, touchedAt) ? c.json({ ok: true }) : c.json({ error: 'unknown screen' }, 404);
  });

  /** What a window is for (full, control, screen): set from any window's Settings. */
  app.post('/api/screens/:id/role', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const role = parseScreenRole(body.role);
    if (!role) throw new BadRequest(`role must be one of ${SCREEN_ROLES.join(', ')}`);
    return hub.setScreenRole(c.req.param('id'), role) ? c.json({ ok: true, role }) : c.json({ error: 'unknown screen' }, 404);
  });

  app.post('/api/screens/:id/feed-scope', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (typeof body.feedScope !== 'string' || !/^(everything|tab:.+|space:(project|agent):.+)$/.test(body.feedScope)) throw new BadRequest('feedScope must be everything, a tab, or a space');
    return hub.setScreenFeedScope(c.req.param('id'), body.feedScope) ? c.json({ ok: true }) : c.json({ error: 'unknown screen' }, 404);
  });

  app.post('/api/screens/:id/audio', (c) => {
    hub.setAudioUnlocked(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── agents ─────────────────────────────────────────────────────────────
  app.post('/api/scenes', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const agentId = str(body.agentId);
    if (!agentId) throw new BadRequest('agentId is required');
    const kind = (str(body.kind) ?? 'html') as SceneKind;
    if (!SCENE_KINDS.includes(kind)) throw new BadRequest(`kind must be one of ${SCENE_KINDS.join(', ')}`);
    let content = typeof body.body === 'string' ? body.body : '';
    if (!content.trim()) throw new BadRequest('body is required');
    if (content.length > MAX_BODY_CHARS) throw new BadRequest('body is too large (2 MB max); put big media in a file and stage it as image or video');
    const summary = str(body.summary);
    if (!summary) throw new BadRequest('summary is required: one sentence saying what the scene shows');
    const bundleRef = parseBundleRef(content);
    if (bundleRef) {
      if (kind !== 'image' && kind !== 'video' && kind !== 'url') throw new BadRequest('a bundle body (bundles/<id>/<file>) is for image, video, or url scenes');
      if (!options.bundles?.has(bundleRef.id, bundleRef.file)) throw new BadRequest(`no such bundle file: ${content.trim()}`);
      content = content.trim();
    } else if (kind === 'image' || kind === 'video') {
      content = content.trim();
      if (path.isAbsolute(content)) {
        try {
          content = `assets/${store.importAsset(content)}`;
        } catch (err) {
          throw new BadRequest(err instanceof AssetRejected ? err.message : `could not read ${content}: ${(err as Error).message}`);
        }
      } else if (!/^https?:\/\//i.test(content)) {
        throw new BadRequest(`${kind} body must be an absolute local file path or an http(s) URL`);
      }
    }
    if (kind === 'url' && !bundleRef && !/^https?:\/\//i.test(content.trim())) throw new BadRequest('url body must be an http(s) URL or a bundle file (bundles/<id>/<file>)');
    // Google files are read with the owner's own Google accounts, so only agents on this machine may show one.
    const googleScene = kind === 'url' && !!options.google && !!parseGoogleUrl(content);
    if (googleScene && !isDirectLocalCaller(c.req.raw.headers)) {
      return c.json({ error: "Google files are read with the owner's Google accounts, so only local agents can show them" }, 403);
    }
    // Linear items are read with the owner's API keys: the same rule.
    const linearScene = kind === 'url' && !!options.linear && !!parseLinearUrl(content);
    if (linearScene && !isDirectLocalCaller(c.req.raw.headers)) {
      return c.json({ error: "Linear items are read with the owner's Linear keys, so only local agents can show them" }, 403);
    }

    const input: StageInput = {
      agentId,
      agentName: str(body.agentName),
      slot: str(body.slot),
      kind,
      title: str(body.title),
      body: content,
      summary,
      choices: (() => {
        const given = parseChoices(body.choices);
        return given.length || kind !== 'html' ? given : choicesFromHtml(content);
      })(),
      state: parseState(body.state),
      urgent: body.urgent === true,
      ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
      origin: {
        ...(str(body.channelId) ? { channelId: str(body.channelId) } : {}),
        ...(str(body.threadId) ? { threadId: str(body.threadId) } : {}),
        ...(str(body.conversationKey) ? { conversationKey: str(body.conversationKey) } : {}),
        ...(googleScene ? { googleRead: true as const } : {}),
        ...(linearScene ? { linearRead: true as const } : {}),
      },
    };
    const { scene, replaced } = store.stage(input);
    // A Google file is read now, so the screens load it warm and the caller hears whether it worked.
    const googleRef = googleScene ? parseGoogleUrl(content) : undefined;
    const googleRead = googleRef
      ? options.google!.render(googleRef).then(
          (snapshot) => ({ name: snapshot.name, ...(snapshot.pages ? { pages: snapshot.pages.length } : {}) }),
          (err: Error) => ({ error: err.message }),
        )
      : undefined;
    const linearRef = linearScene ? parseLinearUrl(content) : undefined;
    const linearRead = linearRef
      ? options.linear!.render(linearRef).then(
          (snapshot) => ({ name: snapshot.name, kind: snapshot.kind }),
          (err: Error) => ({ error: err.message }),
        )
      : undefined;
    const { showing } = hub.staged(scene, replaced);
    // Uploaded pages (bundles) are checked too: that's how coding sessions show prototypes. Outside URLs aren't.
    const wantCheck = body.check !== false && (kind !== 'url' || bundleRef) && kind !== 'video' && options.check;
    const check = wantCheck ? await options.check!(scene.id, scene.version) : undefined;
    // Reported if it finishes in time; a slow read keeps going and the screen shows it when done.
    const google = googleRead
      ? await Promise.race([googleRead, new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), GOOGLE_STAGE_WAIT_MS).unref())])
      : undefined;
    const linear = linearRead
      ? await Promise.race([linearRead, new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), GOOGLE_STAGE_WAIT_MS).unref())])
      : undefined;
    return c.json({
      ...(google ? { google } : {}),
      ...(linear ? { linear } : {}),
      sceneId: scene.id,
      conversationKey: scene.conversationKey,
      slot: scene.slot,
      version: scene.version,
      replaced,
      showing,
      screens: hub.screenList().length,
      operatorLive: hub.operatorLive,
      ...(check ? { check } : {}),
    });
  });

  app.patch('/api/scenes/:id', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const scene = store.update(c.req.param('id'), {
      state: parseState(body.state),
      summary: str(body.summary),
      replaceState: body.replaceState === true,
    });
    if (!scene) return c.json({ error: 'no live scene with that id' }, 404);
    hub.stateChanged(scene);
    return c.json({ sceneId: scene.id, showing: hub.showingScene()?.id === scene.id });
  });

  app.get('/api/scenes/:id', (c) => {
    const scene = store.get(c.req.param('id'));
    return scene ? c.json({ ...publicScene(scene), status: scene.status, origin: scene.origin }) : c.json({ error: 'not found' }, 404);
  });

  /**
   * Finds live scenes by agent + slot (agents address their scenes by slot). A slot
   * is unique per conversation, so pass the conversation (conversationKey, or
   * threadId/channelId) to get that conversation's scene; without it, every
   * conversation's scene in the slot comes back, most recent first.
   */
  app.get('/api/stages/:agentId', (c) => {
    const slot = c.req.query('slot');
    const threadId = c.req.query('threadId');
    const channelId = c.req.query('channelId');
    const conversationKey = c.req.query('conversationKey') || (threadId ? `thread:${threadId}` : channelId ? `channel:${channelId}` : undefined);
    const scenes = store
      .live(c.req.param('agentId'))
      .filter((scene) => (!slot || scene.slot === slot) && (!conversationKey || scene.conversationKey === conversationKey));
    return c.json({ scenes: scenes.map(publicScene) });
  });

  app.delete('/api/scenes/:id', (c) => {
    const scene = store.clear(c.req.param('id'));
    if (!scene) return c.json({ error: 'not found' }, 404);
    hub.removed([scene.id]);
    return c.json({ cleared: [scene.id] });
  });

  app.delete('/api/stages/:agentId', (c) => {
    const cleared = store.clearStage(c.req.param('agentId'));
    hub.removed(cleared);
    return c.json({ cleared });
  });

  app.get('/api/status', (c) => c.json(hub.status()));

  // ── director (the operator) and dashboard taps ─────────────────────────
  // `?ack=1`: this operator acknowledges inputs (POST /api/input/:commandId/ack) and gets the bot fallback for any it misses.
  app.get('/director/stream', (c) => {
    const acks = c.req.query('ack') === '1' || c.req.query('ack') === 'true';
    return sse((sink) => hub.addDirector(sink, { acks }), (id) => hub.removeDirector(id))(c);
  });

  app.post('/api/show', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const by = body.by === 'screen' ? 'screen' : 'director';
    if (body.dashboard === true) {
      hub.showDashboard({ home: true, by });
      return c.json({ showing: null });
    }
    // A director show counts as the owner's pick only with a reason saying so (e.g. 'user');
    // the operator's own focus passes reason 'focus' (or none) and never pins the screen.
    const reason = str(body.reason);
    const sceneId = str(body.sceneId);
    if (sceneId) return c.json({ showing: hub.show(sceneId, by, { reason }) ? hub.showingScene() : null });
    const agentId = str(body.agentId);
    if (agentId) return c.json({ showing: hub.showAgent(agentId, by, { reason }) });
    throw new BadRequest('sceneId, agentId, or dashboard is required');
  });

  app.post('/api/back', (c) => c.json({ showing: hub.back() }));

  app.post('/api/command', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = str(body.name);
    if (!name) throw new BadRequest('name is required');
    const args = parseState(body.args) ?? {};
    const commandId = str(body.commandId)?.slice(0, 128);
    // `delivered`: some screen was connected to get it (false with none, instead of a quiet success).
    const sent = hub.command(name, args, commandId);
    return c.json({ sent, delivered: sent, screens: hub.screenList().length });
  });

  // ── prototypes ─────────────────────────────────────────────────────────
  const prototypes = options.prototypes;
  if (prototypes) {
    /**
     * `{ agentId, agentName?, name?, title?, url, conversationKey | threadId | channelId, ttlMinutes? }`.
     * `url` is an uploaded bundle page (`bundles/<id>/<file>`) or an http(s) URL. Publishing again
     * under the same conversation + agent + name replaces it in place.
     */
    app.post('/api/prototypes', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      const agentId = str(body.agentId);
      if (!agentId) throw new BadRequest('agentId is required');
      const url = str(body.url);
      if (!url) throw new BadRequest('url is required: an uploaded bundle page (bundles/<id>/<file>) or an http(s) URL');
      const bundleRef = parseBundleRef(url);
      if (bundleRef) {
        if (!options.bundles?.has(bundleRef.id, bundleRef.file)) throw new BadRequest(`no such bundle file: ${url}`);
      } else if (!/^https?:\/\//i.test(url)) {
        throw new BadRequest('url must be a bundle page (bundles/<id>/<file>) or an http(s) URL');
      }
      const threadId = str(body.threadId);
      const channelId = str(body.channelId);
      const conversationKey = str(body.conversationKey) ?? (threadId ? `thread:${threadId}` : channelId ? `channel:${channelId}` : `agent:${agentId}`);
      const { prototype, replaced } = prototypes.publish({
        agentId,
        agentName: str(body.agentName),
        conversationKey,
        name: str(body.name),
        title: str(body.title),
        url,
        ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
      });
      const { showing } = hub.prototypePublished(prototype, replaced);
      const check = bundleRef && body.check !== false && options.checkPrototype ? await options.checkPrototype(prototype) : undefined;
      return c.json({ ...publicPrototype(prototype), prototypeId: prototype.id, replaced, showing, screens: hub.screenList().length, ...(check ? { check } : {}) });
    });

    /** Live prototypes: one conversation's (`conversationKey`), one agent's (`agentId`), and/or one name. */
    app.get('/api/prototypes', (c) => {
      const conversationKey = c.req.query('conversationKey');
      const agentId = c.req.query('agentId');
      const name = c.req.query('name');
      const list = (conversationKey ? prototypes.liveForConversation(conversationKey) : prototypes.live(agentId))
        .filter((prototype) => (!agentId || prototype.agentId === agentId) && (!name || prototype.name === name));
      return c.json({ prototypes: list.map(publicPrototype) });
    });

    app.get('/api/prototypes/:id', (c) => {
      const prototype = prototypes.get(c.req.param('id'));
      return prototype ? c.json({ ...publicPrototype(prototype), status: prototype.status, page: hub.prototypePage(prototype.id) }) : c.json({ error: 'not found' }, 404);
    });

    app.delete('/api/prototypes/:id', (c) => {
      const prototype = prototypes.clear(c.req.param('id'));
      if (!prototype) return c.json({ error: 'not found' }, 404);
      hub.prototypesRemoved([prototype.id]);
      return c.json({ cleared: [prototype.id] });
    });

    /** A screen relays what the prototype's bridge reported: what's on the page (for the operator). */
    app.post('/api/prototypes/:id/page', async (c) => {
      const page = parsePrototypePage(((await c.req.json()) as Record<string, unknown>).page);
      if (!page) throw new BadRequest('page must be the bridge snapshot');
      return hub.setPrototypePage(c.req.param('id'), page) ? c.json({ ok: true }) : c.json({ error: 'no live prototype with that id' }, 404);
    });

    /** The owner clicked or typed in the prototype: that is activity (idle returns wait). */
    app.post('/api/prototypes/:id/activity', (c) => (hub.prototypeActivity(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'no live prototype with that id' }, 404)));

    /** A screen relays how a command went (a click that found nothing), for the operator to say so. */
    app.post('/api/prototypes/:id/result', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new BadRequest('name is required');
      hub.prototypeResult(c.req.param('id'), { name, ok: body.ok === true, detail: clip(str(body.detail) ?? '', 200), ...(str(body.commandId) ? { commandId: str(body.commandId)!.slice(0, 128) } : {}) });
      return c.json({ ok: true });
    });
  }

  app.post('/api/director/tasks', async (c) => {
    const body = (await c.req.json()) as { tasks?: DirectorTask[] };
    hub.setTasks(Array.isArray(body.tasks) ? body.tasks.slice(0, 40) : []);
    return c.json({ ok: true });
  });

  mountPresentation(app, hub);

  // ── inbox ──────────────────────────────────────────────────────────────
  const inbox = options.inbox;
  if (inbox) {
    const { engine, rules } = inbox;
    const requireItem = (id: string) => {
      const item = engine.store.get(engine.resolveId(id));
      if (!item) throw new BadRequest(`no inbox item ${id}`);
      return item;
    };
    const view = (id: string) => {
      const resolved = engine.resolveId(id);
      return inboxView(engine.store, rules, hub.liveScenes(), { filter: 'all' }).find((item) => item.id === resolved) ?? null;
    };

    app.get('/api/inbox', (c) => {
      const filter = (c.req.query('filter') ?? c.req.query('state') ?? 'open') as InboxFilter;
      if (!INBOX_FILTERS.includes(filter)) throw new BadRequest(`filter must be one of ${INBOX_FILTERS.join(', ')}`);
      const sort = (c.req.query('sort') ?? 'smart') as InboxSort;
      return c.json({
        items: inboxView(engine.store, rules, hub.liveScenes(), { filter, sort, agentId: c.req.query('agent') || undefined }),
        counts: inboxCounts(engine.store, rules, c.req.query('agent') || undefined),
        sources: inboxSources(engine.store),
        rulesError: rules.error,
      });
    });

    app.get('/api/inbox/briefing', (c) => c.json(briefing(engine.store, rules)));

    app.get('/api/inbox/rules', (c) => c.json({ path: rules.path, rules: rules.list(), error: rules.error }));

    app.post('/api/inbox/poll', async (c) => c.json(await engine.poll()));

    /** Forget everything and read Discord again (deeper look-back, owner reactions included). */
    app.post('/api/inbox/rebuild', async (c) => c.json(await engine.rebuild()));

    /** One action over many items: { ids, action: done | read | later | dismiss }. Done writes to Discord, so it goes one at a time. */
    app.post('/api/inbox/bulk', async (c) => {
      const body = (await c.req.json()) as { ids?: unknown; action?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
      const action = String(body.action ?? '');
      if (!['done', 'read', 'later', 'dismiss'].includes(action)) throw new BadRequest('action must be done, read, later, or dismiss');
      let reacted = 0;
      let archived = 0;
      for (const id of ids) {
        if (action === 'done') {
          const result = await engine.done(id);
          reacted += result.reacted ? 1 : 0;
          archived += result.archived ? 1 : 0;
          await new Promise((resolve) => setTimeout(resolve, 250)); // stay well under Discord's rate limits
        } else {
          engine.mark(id, STATE_ACTIONS[action === 'dismiss' ? 'dismiss' : action]!);
        }
      }
      return c.json({ count: ids.length, reacted, archived });
    });

    app.post('/api/inbox/items', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      const agentId = str(body.agentId);
      const summary = str(body.summary);
      if (!agentId || !summary) throw new BadRequest('agentId and summary are required');
      const kind = body.kind === 'question' || body.kind === 'notice' ? body.kind : 'result';
      const item = await engine.addFromOperatorInOrder({
        agentId,
        agentName: str(body.agentName),
        channelId: str(body.channelId),
        messageIds: Array.isArray(body.messageIds) ? body.messageIds.filter((id): id is string => typeof id === 'string') : [],
        taskId: str(body.taskId),
        summary,
        fullText: str(body.fullText),
        kind,
      });
      return c.json(view(item.id));
    });

    app.get('/api/inbox/:id', (c) => {
      const item = view(c.req.param('id'));
      if (!item) return c.json({ error: 'not found' }, 404);
      return c.json({ ...item, messages: engine.store.messages(item.id, 30) });
    });

    const STATE_ACTIONS: Record<string, InboxState> = { read: 'read', later: 'later', dismiss: 'dismissed', heard: 'heard', reopen: 'queued' };
    app.post('/api/inbox/:id/:action{read|later|dismiss|heard|reopen}', async (c) => {
      const item = requireItem(c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      engine.mark(item.id, STATE_ACTIONS[c.req.param('action')]!, str(body.note));
      return c.json(view(item.id));
    });

    /** "These are the same thing": fold this topic into another of the same agent's. */
    app.post('/api/inbox/:id/merge', async (c) => {
      const item = requireItem(c.req.param('id'));
      const into = str(((await c.req.json()) as Record<string, unknown>).into);
      if (!into) throw new BadRequest('into is required');
      const merged = engine.merge(item.id, into);
      if (!merged) throw new BadRequest('can only merge topics of the same agent');
      return c.json(view(merged.id));
    });

    /** "This part is something else": a new topic from this message on. */
    app.post('/api/inbox/:id/split', async (c) => {
      const item = requireItem(c.req.param('id'));
      const messageId = str(((await c.req.json()) as Record<string, unknown>).messageId);
      if (!messageId) throw new BadRequest('messageId is required');
      const created = engine.split(item.id, messageId);
      if (!created) throw new BadRequest('cannot split there (threads stay whole)');
      return c.json(view(created.id));
    });

    app.post('/api/inbox/:id/done', async (c) => {
      const item = requireItem(c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await engine.done(item.id, { archive: body.archive !== false });
      return c.json({ ...view(item.id), reacted: result.reacted, archived: result.archived });
    });

    app.post('/api/inbox/:id/react', async (c) => {
      const item = requireItem(c.req.param('id'));
      const emoji = str(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).emoji) ?? '👍';
      if (!item.channelId || !item.lastAgentMessageId) throw new BadRequest('this item has no Discord message to react to');
      await inbox.react(item.channelId, item.lastAgentMessageId, emoji);
      // 👍 = "seen, I'll come back to it"; any other reaction means handled.
      if (emoji.startsWith('👍')) engine.ack(item.id);
      else engine.mark(item.id, 'read', `marked ${emoji}`);
      return c.json(view(item.id));
    });

    app.post('/api/inbox/:id/reply', async (c) => {
      const item = requireItem(c.req.param('id'));
      const text = str(((await c.req.json()) as Record<string, unknown>).text);
      if (!text) throw new BadRequest('text is required');
      if (!item.channelId) throw new BadRequest('this item has no conversation to reply in');
      const routed = await inbox.reply({ agentId: item.agentId, channelId: item.channelId, text, title: item.summary || item.place || 'your update' });
      if (routed !== 'agent') return c.json({ error: `reply not delivered (${routed})` }, 502);
      engine.replied(item.id);
      return c.json(view(item.id));
    });

    /** Which item a screen has open (null: back on the list). */
    app.post('/api/inbox/focus', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      hub.setInboxFocus(str(body.itemId) ?? null);
      return c.json({ ok: true });
    });

    /**
     * Opens an item: its agent's scene if there is one. From a screen tap it just
     * records focus; from the operator ({remote: true}) the screens open its detail too.
     */
    app.post('/api/inbox/:id/open', async (c) => {
      const item = view(c.req.param('id'));
      if (!item) return c.json({ error: 'not found' }, 404);
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.remote === true) {
        // Its scene if it has one; otherwise back to the inbox so the detail view is what shows.
        if (item.sceneId) hub.show(item.sceneId, 'director');
        else if (hub.showingScene()) hub.showDashboard();
        hub.openInboxItem(item.id);
      } else {
        hub.setInboxFocus(item.id);
        if (item.sceneId) hub.show(item.sceneId, 'screen');
      }
      if (UNREAD_STATES.includes(item.state)) engine.mark(item.id, 'heard');
      return c.json({ sceneId: item.sceneId });
    });
  }

  // ── the desk (SCREEN_DESK=v2) ──────────────────────────────────────────
  if (options.desk) {
    registerDeskRoutes(app, options.desk.routes);
    // Never both: in v2 the old engine isn't running and options.inbox is unset.
    if (options.desk.compat && !inbox) registerInboxCompat(app, options.desk.compat);
  }

  // ── the session trace page (docs/guides/voice-operator.md, "Diagnosing a live session") ──
  app.get('/trace', async (c) => {
    try {
      const data = await fsp.readFile(path.join(options.publicDir, 'trace.html'));
      return c.body(new Uint8Array(data), 200, { 'content-type': STATIC_TYPES['.html']!, 'cache-control': 'no-cache' });
    } catch {
      return c.text('not found', 404);
    }
  });

  if (options.voice) registerVoiceRoute(app, options.voice);
  if (options.dictationHistory) registerDictationHistory(app, options.dictationHistory, options.publicDir);

  // ── the shell ──────────────────────────────────────────────────────────
  // Files change only with a deploy, which restarts the service: the import graph is read once (static-assets.ts).
  let preloads: string[] | null = null;
  const etagOf = createEtags();
  const fresh = (c: Context, etag: string) => c.req.header('if-none-match') === etag;
  app.get('*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    // A decision's page (/decision/D-67, TGO-1110) is the desk with that brief up: the shell, with its relative URLs
    // resolved against the desk's own root (the page may sit behind a path prefix, as /tango-screen).
    const brief = pathname.match(/^\/decision\/(D-\d+)(\/?)$/);
    const requested = pathname === '/' || brief ? '/index.html' : pathname;
    const file = path.join(options.publicDir, path.normalize(requested));
    if (!file.startsWith(options.publicDir)) return c.text('forbidden', 403);
    try {
      const data = await fsp.readFile(file);
      // The shell carries the build it was served with: the page compares it with the running one (server/build.ts).
      if (requested === '/index.html') {
        preloads ??= moduleGraph(options.publicDir, 'desk/main.js');
        const shell = withModulePreloads(withBuild(data.toString('utf8')), preloads);
        const page = brief ? shell.replace('<head>', `<head>\n<base href="${brief[2] ? '../../' : '../'}">`) : shell;
        const etag = `"${createHash('sha1').update(page).digest('base64url')}"`;
        const headers = { 'content-type': STATIC_TYPES['.html']!, 'cache-control': 'no-cache', etag };
        return fresh(c, etag) ? c.body(null, 304, headers) : c.body(page, 200, headers);
      }
      // Revalidated on every load (no-cache) but cheap when unchanged: a 304 with no body.
      const etag = etagOf(file, data);
      const headers = { 'content-type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag };
      return fresh(c, etag) ? c.body(null, 304, headers) : c.body(new Uint8Array(data), 200, headers);
    } catch {
      return c.text('not found', 404);
    }
  });

  return app;
}
