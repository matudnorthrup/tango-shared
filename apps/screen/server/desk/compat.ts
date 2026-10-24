import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { coordinatorItemIds } from './coordinator.js';
import type { Hub } from '../hub.js';
import type { InboxRules } from '../inbox-rules.js';
import type { InboxState, InboxStatus } from '../inbox-store.js';
import { textSummary } from '../inbox-summarize.js';
import type { DeskCore } from './core.js';
import type { CommandType, DeskItem } from './types.js';
import { briefing as deskBriefing, inView, presentItem, scenesFor, sectionOrder } from './view.js';

// The old /api/inbox* routes, served from the desk (SCREEN_DESK=v2) until the
// voice operator (apps/tango-voice/src/live/screen-director.ts) and the
// agent_inbox tool (packages/discord/src/agent-inbox-tools.ts) move to the desk
// API. Shapes follow the old InboxView as closely as practical:
//
//   status  your_move/failed → needs_you, working → in_progress, watching/fyi → done
//   state   active new/updated → queued, active seen → heard (+acked), snoozed/parked → later, done → read

export interface InboxCompatOptions {
  core: DeskCore;
  hub: Hub;
  rules: InboxRules | null;
  pollSources: () => Promise<{ conversations: number; messages: number }>;
  /** Reads one Discord conversation now (operator answers filed before the poll saw them). */
  catchUp?: (channelId: string) => Promise<unknown>;
}

type OldFilter = 'active' | 'open' | 'needs_you' | 'in_progress' | 'done' | 'later' | 'archive' | 'all';
const FILTERS: readonly OldFilter[] = ['active', 'open', 'needs_you', 'in_progress', 'done', 'later', 'archive', 'all'];

export function compatStatus(item: Pick<DeskItem, 'nextStep'>): InboxStatus {
  return item.nextStep === 'your_move' || item.nextStep === 'failed' ? 'needs_you' : item.nextStep === 'working' ? 'in_progress' : 'done';
}

export function compatState(item: Pick<DeskItem, 'disposition' | 'seen'>): InboxState {
  if (item.disposition === 'done') return 'read';
  if (item.disposition === 'snoozed' || item.disposition === 'parked') return 'later';
  return item.seen === 'seen' ? 'heard' : 'queued';
}

/** Old ids the operator may still hold: thread:<id> is now discord:thread:<id>. */
export function resolveCompatId(core: DeskCore, id: string): string | null {
  if (core.store.item(id)) return id;
  if (id.startsWith('thread:') && core.store.item(`discord:${id}`)) return `discord:${id}`;
  if (id.startsWith('topic:')) {
    // topic:<channelId>:<firstMessageId>: the chapter holding that message.
    const messageId = id.split(':')[2];
    return messageId ? core.store.itemForMessage(messageId) : null;
  }
  return null;
}

function inFilter(item: DeskItem, filter: OldFilter): boolean {
  const active = inView(item, 'active');
  const status = compatStatus(item);
  switch (filter) {
    case 'active':
    case 'open':
      return active;
    case 'needs_you':
      return active && status === 'needs_you' && item.seen !== 'seen';
    case 'in_progress':
      return active && status === 'in_progress';
    case 'done':
      return active && status === 'done';
    case 'later':
      return item.disposition === 'snoozed' || item.disposition === 'parked';
    case 'archive':
      return item.disposition === 'done';
    case 'all':
      return true;
  }
}

export function compatView(core: DeskCore, item: DeskItem, scenes: ReturnType<Hub['liveScenes']>, lastTexts?: Map<string, string>) {
  const view = presentItem(item);
  // A list passes every item's last agent text from one query; a single item reads its own.
  const lastText = lastTexts ? (lastTexts.get(item.id) ?? '') : ([...core.store.messages(item.id, 20)].reverse().find((message) => message.author === 'agent')?.text ?? '');
  return {
    id: item.id,
    kind: item.kind === 'chapter' ? 'topic' : 'thread',
    agentId: item.agentId,
    agentName: item.agentName,
    // Where a reply goes: the thread, the home channel, or the T3 item id (as before).
    channelId: item.source === 'loom' ? item.id : (item.threadId ?? item.channelId),
    place: item.place,
    taskId: null,
    summary: textSummary(view.line || item.summary?.gist || '', 140),
    summarySource: item.summary?.source ?? 'text',
    lastText,
    status: compatStatus(item),
    state: compatState(item),
    stateAt: item.attentionUpdatedAt,
    note: item.disposition === 'done' ? 'done' : item.backFromSnooze ? 'back from snooze' : null,
    createdAt: item.createdAt,
    lastActivityAt: item.lastActivityAt,
    messageCount: item.messageCount,
    lastAgentMessageId: item.lastAgentMessageId,
    acked: item.disposition === 'active' && item.seen === 'seen',
    color: view.color,
    quiet: false,
    hidden: item.hidden,
    labels: item.labels,
    rules: [],
    score: 0,
    sceneId: scenesFor(core, item, scenes)[0] ?? null,
    // New fields, for clients that already know them.
    nextStep: item.nextStep,
    disposition: item.disposition,
    seen: item.seen,
    ask: item.ask,
    options: item.options,
  };
}

export function registerInboxCompat(app: Hono, options: InboxCompatOptions): void {
  const { core, hub } = options;
  const run = (type: CommandType, itemId: string, args: Record<string, unknown> = {}) => core.command({ commandId: `compat:${randomUUID()}`, type, itemId, args, actor: 'owner' });
  const view = (id: string) => {
    const item = core.item(id);
    return item ? compatView(core, item, hub.liveScenes()) : null;
  };
  const resolve = (id: string) => resolveCompatId(core, id);

  app.get('/api/inbox', (c) => {
    const filter = (c.req.query('filter') ?? c.req.query('state') ?? 'open') as OldFilter;
    if (!FILTERS.includes(filter)) return c.json({ error: `filter must be one of ${FILTERS.join(', ')}` }, 400);
    const sort = c.req.query('sort') ?? 'smart';
    const agent = c.req.query('agent');
    const base = (id: string) => id.replace(/-ollama$/, '');
    const all = core.items().filter((item) => !agent || base(item.agentId) === base(agent) || (agent === '@tango' && item.source !== 't3'));
    const scenes = hub.liveScenes();
    const lastTexts = core.store.lastAgentTexts();
    const items = all.filter((item) => inFilter(item, filter));
    // smart ≈ the board: urgent first, then New/Updated, then most recent.
    const urgent = (item: DeskItem) => (item.nextStep === 'your_move' || item.nextStep === 'failed' ? 1 : 0);
    if (sort === 'smart') items.sort((a, b) => urgent(b) - urgent(a) || sectionOrder(a, b));
    else if (sort === 'agent') items.sort((a, b) => a.agentName.localeCompare(b.agentName) || b.lastActivityAt - a.lastActivityAt);
    else items.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const counts = Object.fromEntries(FILTERS.map((name) => [name, all.filter((item) => inFilter(item, name)).length]));
    const agents = new Map<string, { id: string; name: string; color: string }>();
    for (const item of core.items()) agents.set(base(item.agentId), { id: base(item.agentId), name: item.agentName, color: presentItem(item).color });
    return c.json({
      items: items.map((item) => compatView(core, item, scenes, lastTexts)),
      counts,
      sources: {
        agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
      },
      rulesError: options.rules?.error ?? null,
    });
  });

  app.get('/api/inbox/briefing', (c) => {
    const brief = deskBriefing(core);
    const active = core.items().filter((item) => inView(item, 'active'));
    const later = core.items().filter((item) => inFilter(item, 'later'));
    const lastTexts = core.store.lastAgentTexts();
    const byAgent = new Map<string, DeskItem[]>();
    for (const item of active.sort(sectionOrder)) byAgent.set(item.agentId, [...(byAgent.get(item.agentId) ?? []), item]);
    return c.json({
      text: brief.text,
      counts: { open: active.length, needsYou: brief.counts.yourMove, later: later.length },
      agents: [...byAgent.entries()].map(([agentId, items]) => ({
        agentId,
        agentName: items[0]!.agentName,
        needsYou: items.filter((item) => compatStatus(item) === 'needs_you' && item.seen !== 'seen').length,
        items: items.slice(0, 5).map((item) => {
          const old = compatView(core, item, [], lastTexts);
          return { id: item.id, summary: old.summary, status: old.status, state: old.state, place: item.place, quiet: false, seen: old.acked, age: '' };
        }),
      })),
    });
  });

  app.get('/api/inbox/rules', (c) => c.json({ path: options.rules?.path ?? null, rules: options.rules?.list() ?? [], error: options.rules?.error ?? null }));

  app.post('/api/inbox/poll', async (c) => c.json(await options.pollSources()));

  app.post('/api/inbox/rebuild', (c) => c.json({ error: 'rebuild is not part of the desk (SCREEN_DESK=v2)' }, 501));

  app.post('/api/inbox/bulk', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; action?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
    const action = String(body.action ?? '');
    if (!['done', 'read', 'later', 'dismiss'].includes(action)) return c.json({ error: 'action must be done, read, later, or dismiss' }, 400);
    let reacted = 0;
    let archived = 0;
    for (const raw of ids) {
      const id = resolve(raw);
      if (!id) continue;
      // No silent stopJob: an item with a running job fails here and is left for an explicit choice.
      const result = action === 'later' ? await run('park', id) : await run('done', id);
      const steps = ((result.outcome?.writeback as { steps?: string[] } | undefined)?.steps ?? []) as string[];
      reacted += steps.includes('reacted') ? 1 : 0;
      archived += steps.includes('archived') ? 1 : 0;
    }
    return c.json({ count: ids.length, reacted, archived });
  });

  /** The operator files a relayed answer: the desk reads Discord itself, so this finds (or catches up to) its item. */
  app.post('/api/inbox/items', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ids = Array.isArray(body.messageIds) ? body.messageIds.filter((id): id is string => typeof id === 'string') : [];
    const find = () => ids.map((id) => core.store.itemForMessage(id)).find((id): id is string => Boolean(id)) ?? null;
    let itemId = find();
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!itemId && channelId && options.catchUp) {
      await Promise.race([options.catchUp(channelId).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3000).unref?.())]);
      itemId = find();
    }
    const found = itemId ? view(itemId) : null;
    return found ? c.json(found) : c.json({ error: 'not filed yet; the desk files it when Discord has it' }, 404);
  });

  app.post('/api/inbox/focus', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    hub.setInboxFocus(typeof body.itemId === 'string' ? (resolve(body.itemId) ?? body.itemId) : null);
    return c.json({ ok: true });
  });

  app.get('/api/inbox/:id', (c) => {
    const id = resolve(c.req.param('id'));
    const found = id && !coordinatorItemIds(core.store.setting('coordinators')).has(id) ? view(id) : null;
    if (!found) return c.json({ error: 'not found' }, 404);
    const messages = core.store.messages(found.id, 30).map((message) => ({ ...message, channelId: found.channelId ?? '' }));
    return c.json({ ...found, messages });
  });

  const MARKS: Record<string, { type: CommandType; args?: Record<string, unknown> }> = {
    read: { type: 'done' },
    dismiss: { type: 'done' },
    later: { type: 'park' },
    // The operator only marked heard after its delivery check confirmed playback.
    heard: { type: 'heard', args: { playbackComplete: true } },
    reopen: { type: 'reopen' },
  };
  app.post('/api/inbox/:id/:action{read|later|dismiss|heard|reopen}', async (c) => {
    const id = resolve(c.req.param('id'));
    if (!id) return c.json({ error: `no inbox item ${c.req.param('id')}` }, 400);
    const mark = MARKS[c.req.param('action')]!;
    const result = await run(mark.type, id, mark.args);
    if (result.status === 'failed') return c.json({ error: result.error }, 400);
    return c.json(view(id));
  });

  app.post('/api/inbox/:id/:action{merge|split}', (c) => c.json({ error: 'chapters are split by time on the desk; merge and split are gone' }, 400));

  app.post('/api/inbox/:id/done', async (c) => {
    const id = resolve(c.req.param('id'));
    if (!id) return c.json({ error: `no inbox item ${c.req.param('id')}` }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // stopJob only when the caller chose; with a job running and no choice, the desk's "stopJob is
    // required" failure goes back to the caller (409) instead of a silent "leave it running".
    const result = await run('done', id, typeof body.stopJob === 'boolean' ? { stopJob: body.stopJob } : {});
    if (result.status === 'failed') return c.json({ error: result.error, ...(/stopJob is required/.test(result.error ?? '') ? { stopJobRequired: true } : {}) }, /stopJob is required/.test(result.error ?? '') ? 409 : 400);
    const steps = ((result.outcome?.writeback as { steps?: string[] } | undefined)?.steps ?? []) as string[];
    return c.json({ ...view(id), reacted: steps.includes('reacted'), archived: steps.includes('archived') || steps.includes('settled') });
  });

  app.post('/api/inbox/:id/react', async (c) => {
    const id = resolve(c.req.param('id'));
    if (!id) return c.json({ error: `no inbox item ${c.req.param('id')}` }, 400);
    const emoji = String(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).emoji ?? '👀');
    const result = emoji.startsWith('✅') ? await run('done', id) : emoji.startsWith('💤') ? await run('park', id) : await run('seen', id);
    if (result.status === 'failed') return c.json({ error: result.error }, 400);
    return c.json(view(id));
  });

  app.post('/api/inbox/:id/reply', async (c) => {
    const id = resolve(c.req.param('id'));
    if (!id) return c.json({ error: `no inbox item ${c.req.param('id')}` }, 400);
    const text = String(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).text ?? '').trim();
    if (!text) return c.json({ error: 'text is required' }, 400);
    const result = await run('reply', id, { text });
    if (result.status === 'failed') return c.json({ error: result.error }, 502);
    return c.json(view(id));
  });

  app.post('/api/inbox/:id/open', async (c) => {
    const id = resolve(c.req.param('id'));
    const found = id ? view(id) : null;
    if (!found) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.remote === true) {
      if (found.sceneId) hub.show(found.sceneId, 'director');
      else if (hub.showingScene()) hub.showDashboard();
      hub.openInboxItem(found.id);
    } else {
      hub.setInboxFocus(found.id);
      if (found.sceneId) hub.show(found.sceneId, 'screen');
    }
    return c.json({ sceneId: found.sceneId });
  });
}
