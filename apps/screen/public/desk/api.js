// The real desk client: every request the UI makes to the screen service goes
// through here. fixtures.js implements the same interface with invented data, so
// swapping the two is the only difference between ?fixtures=1 and production.
//
// Interface (both implementations):
//   mode                                   'live' | 'fixtures'
//   items({ view, group })              -> { items: DeskItem[], counts, sections?, sweep? }
//   itemsIfChanged({ view, group, etag }) -> items() + { etag }, or { notModified: true } (live only)
//   item(id)                            -> { item, messages, timeline, scenes }
//   activity({ limit })                 -> { events: DeskEvent[] }
//   briefing()                          -> catch-up payload
//   agents()                            -> { agents: [{ id, name, avatar }] } (avatar: the picture's URL, or null)
//   presentation()                      -> { view, itemId, conversationKey, sceneId, queue, by, since }
//   present(intent)                     -> presentation (POST, by: 'screen')
//   command({ commandId, type, itemId, args }) -> { commandId, status, error?, outcome? }
//   settings()                          -> { sweepDay, filters: { hideAgents, hideRepos, hideTypes } }
//   saveSettings({ filters?, sweepDay?, snoozeTimes? }) -> settings (every screen gets onSettings)
//   projectAction(projectId, { action, until?, trigger?, how? }) -> { acted, stayed }: a whole project at once
//   icons(q)                            -> { icons: [name] } Lucide names for the icon picker
//   facets()                            -> { agents: [{ id, name, count }], repos: [{ name, count }], types: [{ name, count }] }
//   presence()                          -> tells the server the owner is at this screen (desk snooze trigger)
//   scene(id)                           -> public scene (for the Screen view's frame)
//   frameUrl(scene)                     -> URL for the sandboxed frame
//   prototypeUrl(prototype)             -> URL for a prototype (Prototype view)
//   prototypePage(id, page), prototypeResult(id, { name, commandId, ok, detail }) -> relay what a prototype's bridge reported
//   input({ sceneId, type, data })      -> scene input (taps inside a frame)
//   unlockAudio(screenId)
//   listPage(screenId, page, touchedAt)  -> what this screen's List shows, for voice ("the third one", "the Watching tab")
//   trace(entries)                      -> live only: what this screen rendered, for the session trace (/trace)
//   draftCommand(action, draftId)       -> the Draft card's Send / Cancel / Dismiss for the draft shown (voice draft mode)
//   pauseCommand('resume', pauseId)     -> a tap on the pause pill (voice pause mode)
//   search(q, { limit, include })      -> { query, semantic, wider?, hits: [{ itemId, score, matchCount, matches: [{ messageId, author, at, snippet, how }], row }] }
//   transcript(itemId, { around?, before?, after?, limit? }) -> { row, messages, hasEarlier, hasLater }
//   startWorkOptions()                  -> { repos: [{ id, name, account, accountReason?, pool?, mode }], accounts: [{ id, name, driver, model, color?, usage? }], fields, policyModel, policyError }
//   startWork({ commandId, repo, prompt, title?, account?, pin?, mode, plan, attachments? }) -> { ok, threadId, itemId, plan } (throws with body.check when a field is missing)
//   capacity()                          -> { accounts: [{ id, name, provider, fiveHour, weekly, running, idle, threads }], rules, machine, loom, moves }
//   moveThread({ itemId, account, commandId }) -> { ok }; accountHistory(itemId) -> { history: [{ account, name, at, reason }] }
//   routing() / saveRouting({ default, repos }) -> { rules: { default, repos: [{ repo, accounts }] }, accounts, repos, editable }
//     no account = the policy's pick (auto); attachments: [{ name, mimeType, dataUrl }] images
//   coordinators()                      -> { coordinators: [{ projectId, exists, watch, reach, status, flags, drafts }] }
//   coordinator(projectId, { catchUp }) -> { summary, threadId, itemId, messages, running, drafts, digests, error }
//   coordinatorAsk(projectId, { text, fromItemId? }) -> { ok, threadId } (the first question starts the coordinator)
//   coordinatorWatch(projectId, { on?, stands?, flags?, digest?, reach? }) -> summary
//   coordinatorDraft(projectId, draftId, { action: send | now | drop, text? }) -> { ok, draft }
//   connect(handlers)                   -> disconnect()
//     handlers: onStatus(online), onResync(), onItem({ id, revision }), onPresentation(p), onSettings(settings),
//               onActivity(event), onOperator(o), onDraft(card), onPause(card), onHello({ screenId, operatorLive }),
//               onShow({ scene, updated }), onState({ sceneId, state }),
//               onCommand({ sceneId, name }), onAck(ack), onDashboard({ operatorLive, windows, liveSceneIds, livePrototypes }),
//               onRole({ role }), onCoordinator(summary)
//
// A detached window (?detached=1, createLiveClient({ detached: true })) is how an agent tests on the real desk.
// It keeps its own presentation: it never moves the owner's windows and doesn't follow theirs, and it sends no
// presence, List report, role change or "viewed" mark. Every request says so (X-Desk-Window), and the service
// refuses those writes from it too (server/access.ts refuseDetachedDriving).

// The desk's root, as the page resolves its own URLs: its address, or what a <base> sets (a decision's page,
// /decision/D-67, is the desk served from deeper down; server/app.ts).
const base = (() => {
  if (typeof location === 'undefined') return '/';
  const path = new URL(typeof document === 'undefined' ? location.href : document.baseURI).pathname;
  return path.endsWith('/') ? path : path.replace(/[^/]*$/, '');
})();

/** A prototype's frame URL: an uploaded page gets its version in the query (before any #route), a URL as-is. */
export function prototypeUrl(p, at = base) {
  if (/^https?:\/\//i.test(p.url)) return p.url;
  const hash = p.url.indexOf('#');
  const page = hash >= 0 ? p.url.slice(0, hash) : p.url;
  const route = hash >= 0 ? p.url.slice(hash) : '';
  return `${at}${page}${page.includes('?') ? '&' : '?'}v=${p.version}${route}`;
}

let detachedWindow = false;

async function request(path, body, method) {
  const response = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    // When it left: the service traces a request that waited behind a busy server (desk/stalls.ts).
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Desk-Sent-At': String(Date.now()), ...(detachedWindow ? { 'X-Desk-Window': 'detached' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!response.ok) {
    const error = new Error((json && json.error) || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

/**
 * An EventSource that starts over by itself after the proxy's 502s (the browser gives up on those).
 * `url` may be a function: read again at each fresh start (the window's role can change meanwhile).
 */
function resilientStream(url, events, { onOpen, onDown } = {}) {
  let source = null;
  let retryMs = 2000;
  let timer = null;
  let stopped = false;
  let opened = false;
  const open = () => {
    if (stopped) return;
    source = new EventSource(typeof url === 'function' ? url() : url);
    source.onopen = () => {
      retryMs = 2000;
      onOpen?.(opened);
      opened = true;
    };
    source.onerror = () => {
      onDown?.();
      if (source.readyState !== EventSource.CLOSED) return; // the browser is retrying itself
      clearTimeout(timer);
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    for (const [name, fn] of Object.entries(events)) {
      source.addEventListener(name, (event) => {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        fn(data);
      });
    }
  };
  open();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
  // A fresh start now, at the URL as it is now (the browser's own retries reuse the first one).
  stop.restart = () => {
    if (stopped) return;
    clearTimeout(timer);
    source?.close();
    open();
  };
  return stop;
}

/** What a window takes from the hub's dashboard. */
function dashboardOf(d) {
  const liveScenes = d.agents ? d.agents.flatMap((agent) => agent.scenes || []) : null;
  return { operatorLive: !!d.operatorLive, windows: d.windows || [], liveSceneIds: d.liveSceneIds || null, livePrototypes: d.livePrototypes || null, liveScenes };
}

/** `screenRole`: what this window is for, read at each connect (role.js). */
export function createLiveClient({ screenName = '', screenRole = () => 'full', detached = false } = {}) {
  let hubStream = null;
  if (detached) detachedWindow = true;
  const client = {
    mode: 'live',
    detached,
    items: ({ view = 'active', group = 'step' } = {}) => request(`api/desk/items?view=${encodeURIComponent(view)}&group=${encodeURIComponent(group)}`),
    /** items(), or `{ notModified: true }` when the list still has `etag`; a fresh answer carries its `etag`. */
    itemsIfChanged: async ({ view = 'active', group = 'step', etag = null } = {}) => {
      const response = await fetch(`${base}api/desk/items?view=${encodeURIComponent(view)}&group=${encodeURIComponent(group)}`, {
        // The browser's own cache stays out of it: this window keeps the list it has.
        cache: 'no-store',
        headers: { 'X-Desk-Sent-At': String(Date.now()), ...(etag ? { 'If-None-Match': etag } : {}) },
      });
      if (response.status === 304) return { notModified: true };
      const json = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error((json && json.error) || `HTTP ${response.status}`), { status: response.status, body: json });
      return { ...json, etag: response.headers.get('ETag') };
    },
    item: (id) => request(`api/desk/items/${encodeURIComponent(id)}`),
    activity: ({ limit = 50 } = {}) => request(`api/desk/activity?limit=${limit}`),
    briefing: () => request('api/desk/briefing'),
    settings: () => request('api/desk/settings'),
    saveSettings: (body) => request('api/desk/settings', body),
    mailOff: (body) => request('api/desk/mail-off', body),
    projectAction: (projectId, body) => request(`api/desk/projects/${encodeURIComponent(projectId)}/action`, body),
    facets: () => request('api/desk/facets'),
    agents: () => request('api/desk/agents'),
    icons: (q = '') => request(`api/desk/icons?q=${encodeURIComponent(q)}`),
    presentation: () => request('api/desk/presentation'),
    // The window's name (?name=) goes with its move, so the trace says which window moved the desk.
    present: (intent) => request('api/desk/presentation', { ...intent, by: 'screen', ...(intent.window && screenName ? { window: { ...intent.window, name: screenName } } : {}) }),
    command: (cmd) => request('api/desk/commands', cmd),
    presence: () => request('api/desk/presence', {}),
    scene: (id) => request(`api/scenes/${encodeURIComponent(id)}`),
    frameUrl: (scene) => `${base}frame/${encodeURIComponent(scene.id)}?v=${scene.version}`,
    input: (body) => request('api/input', body),
    // A prototype: an uploaded bundle page (served next to the desk), or a URL as-is.
    prototypeUrl: (p) => prototypeUrl(p, base),
    prototypePage: (id, page) => request(`api/prototypes/${encodeURIComponent(id)}/page`, { page }),
    prototypeResult: (id, result) => request(`api/prototypes/${encodeURIComponent(id)}/result`, result),
    prototypeActivity: (id) => request(`api/prototypes/${encodeURIComponent(id)}/activity`, {}),
    unlockAudio: (screenId) => (screenId ? request(`api/screens/${screenId}/audio`, {}) : Promise.resolve()),
    listPage: (screenId, page, touchedAt) => request(`api/screens/${screenId}/list`, { page, touchedAt }),
    setScreenFeedScope: (screenId, feedScope) => request(`api/screens/${encodeURIComponent(screenId)}/feed-scope`, { feedScope }),
    setScreenRole: (screenId, role) => request(`api/screens/${encodeURIComponent(screenId)}/role`, { role }),
    // The window's role changed: reconnect the hub stream with it, so every later reconnect carries it too.
    restartScreenStream: () => hubStream?.restart(),
    trace: (entries) => request('api/desk/trace', entries),
    draftCommand: (action, draftId) => request('api/desk/draft/command', { action, ...(draftId ? { draftId } : {}) }),
    pauseCommand: (action, pauseId) => request('api/desk/pause/command', { action, pauseId }),
    search: (q, { limit = 150, where = {}, scope = 'global', audience = 'all', include = 'all' } = {}) => request(`api/desk/search?${new URLSearchParams({ q, limit: String(limit), where: JSON.stringify(where), scope, audience, include })}`),
    transcript: (itemId, params = {}) => {
      const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
      return request(`api/desk/search/transcript/${encodeURIComponent(itemId)}${query ? `?${query}` : ''}`);
    },
    startWorkOptions: () => request('api/desk/start-work'),
    startWork: (body) => request('api/desk/start-work', body),
    startAgentThread: (body) => request('api/desk/agent-threads', body),
    capacity: () => request('api/desk/capacity'),
    // The System page (desk/system.ts). Its commands go through /api/desk/commands like an item's.
    system: ({ retired = true } = {}) => request(`api/desk/system${retired ? '?retired=1' : ''}`),
    systemJob: (id) => request(`api/desk/system/jobs/${encodeURIComponent(id)}`),
    systemEvents: (params = {}) => {
      const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
      return request(`api/desk/system/events${query ? `?${query}` : ''}`);
    },
    systemCommand: (body) => request('api/desk/commands', body),
    moveThread: (body) => request('api/desk/capacity/move', body),
    // The catch-up (docs/specs/catch-up.md): every space's chapter in brief, one space's chapter, Accept and Defer on
    // it, and the owner's answers on what agents decided (desk/decided.ts): Fine by me, a reversal, how a rule counts.
    chapters: () => request('api/desk/chapters'),
    chapter: (spaceId) => request(`api/desk/chapters/${encodeURIComponent(spaceId)}`),
    chapterAccept: (spaceId, body) => request(`api/desk/chapters/${encodeURIComponent(spaceId)}/accept`, body),
    chapterDefer: (spaceId, body) => request(`api/desk/chapters/${encodeURIComponent(spaceId)}/defer`, body),
    decidedConfirm: (body) => request('api/desk/decided/confirm', body),
    resolveAsk: (id, body) => request(`api/desk/asks/${encodeURIComponent(id)}/resolve`, body),
    updatesSeen: (body) => request('api/desk/updates/seen', body),
    decidedReverse: (body) => request('api/desk/decided/reverse', body),
    decidedRule: (body) => request('api/desk/decided/rule', body),
    decidedReview: () => request('api/desk/decided/review'),
    // A decision's brief page (TGO-1110), and the ids Loom has one for (which D-n become links).
    decision: (id) => request(`api/desk/decisions/${encodeURIComponent(id)}`),
    decisionIds: () => request('api/desk/decisions'),
    decidedReviewSeen: (body) => request('api/desk/decided/review/seen', body),
    accountHistory: (itemId) => request(`api/desk/capacity/history/${encodeURIComponent(itemId)}`),
    routing: () => request('api/desk/routing'),
    saveRouting: (body) => request('api/desk/routing', body, 'PUT'),
    coordinators: () => request('api/desk/coordinators'),
    feed: ({ limit = 60, scope = 'everything' } = {}) => request(`api/desk/feed?limit=${limit}&scope=${encodeURIComponent(scope)}`),
    coordinator: (projectId, { catchUp = false } = {}) => request(`api/desk/projects/${encodeURIComponent(projectId)}/coordinator${catchUp ? '?catchUp=1' : ''}`),
    coordinatorAsk: (projectId, body) => request(`api/desk/projects/${encodeURIComponent(projectId)}/coordinator/ask`, body),
    coordinatorWatch: (projectId, body) => request(`api/desk/projects/${encodeURIComponent(projectId)}/coordinator/watch`, body),
    mailDraft: (id, body) => request(`api/desk/mail/${encodeURIComponent(id)}/draft`, body),
    coordinatorDraft: (projectId, draftId, body) => request(`api/desk/projects/${encodeURIComponent(projectId)}/coordinator/drafts/${encodeURIComponent(draftId)}`, body),

    connect(h) {
      // The desk stream: items, presentation, activity, operator status.
      const stopDesk = resilientStream(
        `${base}api/desk/stream`,
        {
          // The desk stream's hello carries the operator status and the presentation as they are now.
          hello: (d) => {
            if (d.build) h.onBuild?.(d.build);
            if (d.operator) h.onOperator?.(d.operator, { replay: true }); // the latest line again, not a new one
            if (d.draft) h.onDraft?.(d.draft);
            if (d.pause) h.onPause?.(d.pause);
            if (d.presentation) h.onPresentation?.(d.presentation);
          },
          item: (d) => h.onItem?.(d),
          presentation: (d) => h.onPresentation?.(d),
          activity: (d) => h.onActivity?.(d),
          settings: (d) => h.onSettings?.(d),
          operator: (d) => h.onOperator?.(d),
          draft: (d) => h.onDraft?.(d),
          pause: (d) => h.onPause?.(d),
          coordinator: (d) => h.onCoordinator?.(d),
          feed: (d) => h.onFeed?.(d),
          system: (d) => h.onSystem?.(d),
          updates: (d) => h.onUpdates?.(d),
        },
        {
          onOpen: (reconnect) => {
            h.onStatus?.(true);
            if (reconnect) h.onResync?.(); // things changed while this screen was away
          },
          onDown: () => h.onStatus?.(false),
        },
      );
      // The scene hub's stream (unchanged): staged scenes, frame state, voice commands, input acks.
      const stopHub = (hubStream = resilientStream(
        () => {
          const query = new URLSearchParams();
          if (screenName) query.set('name', screenName);
          if (typeof location !== 'undefined') query.set('feedScope', new URL(location.href).searchParams.get('feedScope') || 'everything');
          if (screenRole() !== 'full') query.set('role', screenRole());
          if (detached) query.set('detached', '1');
          const qs = query.toString();
          return `${base}stream${qs ? `?${qs}` : ''}`;
        },
        {
          hello: (d) => {
            h.onHello?.({ screenId: d.screenId, operatorLive: !!d.dashboard?.operatorLive, showing: d.showing });
            if (d.dashboard) h.onDashboard?.(dashboardOf(d.dashboard));
          },
          dashboard: (d) => h.onDashboard?.(dashboardOf(d)),
          role: (d) => h.onRole?.(d),
          show: (d) => h.onShow?.(d),
          // A scene re-staged while not the one up: refreshes the cache (a Screen window may hold it).
          scene: (d) => h.onShow?.(d),
          state: (d) => h.onState?.(d),
          command: (d) => h.onCommand?.(d),
          ack: (d) => h.onAck?.(d),
          presentation: (d) => h.onPresentation?.(d),
        },
      ));
      return () => {
        stopDesk();
        stopHub();
      };
    },
  };
  return detached ? detach(client) : client;
}

const BOARD = { view: 'active', itemId: null, conversationKey: null, sceneId: null, prototypeId: null, queue: [], queueScenes: [], upNext: null, prototypes: [], prototype: null, by: 'screen', manual: false, reason: null };

/** A detached window's client: its moves stay in this window, and nothing it does stands in for the owner's windows. */
function detach(client) {
  const refused = () => Promise.reject(Object.assign(new Error('a detached window does not drive the desk’s windows'), { status: 403 }));
  const dropPresentation = (h) => ({ ...h, onPresentation: undefined });
  return {
    ...client,
    // It starts on the board, whatever the owner's windows show. A reread later (a reconnect's resync) changes
    // nothing: this is older than any move the window made itself, and the store keeps the newer one (applyPresentation).
    presentation: () => Promise.resolve({ ...BOARD, since: 1 }),
    // The store already drew the move (its optimistic presentation); null keeps it.
    present: () => Promise.resolve(null),
    presence: () => Promise.resolve({ ok: true, fired: false }),
    listPage: () => Promise.resolve({ ok: true }),
    setScreenRole: refused,
    setScreenFeedScope: refused,
    command: (cmd) => (cmd?.type === 'viewed' ? Promise.resolve({ commandId: cmd.commandId, status: 'applied', outcome: { detached: true } }) : client.command(cmd)),
    connect: (h) => client.connect(dropPresentation(h)),
  };
}
