import { readReceipts, saveReceipts } from './owner-receipts.js';
import { doneLabel } from './query-identity.js';
import { defaultStartMode } from './start-mode.js';
// App state and every action the views can take. Views read `store.state` and
// call actions; the store talks to the data layer (api.js or fixtures.js) only.

import { agentsOf, findItem, homeOf, nestedProjectList, ownerChoices, ownerName, parentOf, reconcileSelection } from './next/model.js';
import { MAX_IMAGES, prepareImage } from './attachments.js';
import { blankDraft } from './draft-model.js';
import { overlaid, overlaidLists, predict, predictSystem, SETTLES_WHEN } from './optimistic.js';
import { blankPause } from './pause-model.js';
import { filterMatches, normalizeFilters, NO_FILTERS, showFiltered as withoutMatches, toggleFilter as flipFilter } from './filters.js';
import { answersFrom, canDismiss, currentDraft, describeAnswers, isOneTap, pendingOf, pick, questionChanged, setOther, toggleOther } from './pending.js';
import { stillPending } from './coordinator-model.js';
import { feedScopeOf } from './feed-scope.js';
import { setKnownDecisions } from './decision-links.js';
import { roleOf, urlWithRole, viewFor } from './role.js';
import { blankSearch, createSearchActions } from './search-model.js';
import { repoNamedIn, titleFrom as titleFromPrompt } from './start-work.js';
import { deliveryUnknown, runningJob, snoozeChoices as presetChoices, snoozeTimesOf, storageGet, storageSet, uuid } from './util.js';

const LIST_VIEWS = ['active', 'snoozed', 'everything', 'history'];
// A tapped answer shows as sent this long while the refreshed item takes its chips away.
const ANSWER_SENT_MS = 2500;
// A command with no answer by then is treated as a lost answer (its prediction comes down; a Retry replays its id).
const COMMAND_TIMEOUT_MS = 60_000;
// Starting a thread builds its worktree first: it gets longer before it counts as lost (a Retry can't start two).
const START_TIMEOUT_MS = 180_000;
// A guard filled in when the command goes (store.js command): never sent as itself (JSON leaves a symbol out).
const GUARD_AT_SEND = Symbol('guard at send');
// With it, the token the tap saw: the guard if no command on the item has answered with a newer one (the one before
// it failed, say), so a follow-up is never sent unguarded (Codex review on #671).
const GUARD_SEEN = Symbol('guard seen at the tap');
// How long a request that never ends keeps the next command on the same item waiting.
const ORDER_HOLD_MS = 300_000;
// Commands that always move an item's attention time (desk/attention.ts): the guard a list copy carries is stale after them.
const MOVES_ATTENTION = new Set(['done', 'snooze', 'park', 'pickup', 'reopen', 'sweep', 'reply', 'answer', 'respond', 'approve', 'dismiss']);
/**
 * Whether this command moves the item's attention time, so its old guard is stale: the ones above always; read
 * and unread only on an active item; a pin only when it moves the item to another list (Codex review on #671).
 */
function movesAttention(type, item, predicted, args = {}) {
  if (MOVES_ATTENTION.has(type)) return true;
  // Held by its project, it is active underneath: what the desk does to that underlying state is what counts, not
  // where the row ends up showing (Codex review on #671).
  const activeUnderneath = (item.disposition ?? 'active') === 'active' || !!item.heldBy;
  if (type === 'seen' || type === 'unseen') return activeUnderneath;
  if (type === 'pin') return !!args.pinned && !activeUnderneath; // a pickup
  return !!predicted && (predicted.disposition ?? 'active') !== (item.disposition ?? 'active');
}

/** The request, or a rejection with no body (a lost answer) if it hasn't answered in `ms`: nothing optimistic hangs. */
function answerWithin(promise, ms = COMMAND_TIMEOUT_MS) {
  let timer;
  const stalled = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('the desk didn’t answer in time')), ms)));
  return Promise.race([promise, stalled]).finally(() => clearTimeout(timer));
}

/** `role`: what this window is for (role.js), from its URL. */
export function createStore(client, { role = 'full', listCache = null } = {}) {
  const listeners = new Set();
  let scheduled = false;
  let toastSeq = 0;

  const state = {
    mode: client.mode,
    online: false,
    lists: Object.fromEntries(LIST_VIEWS.map((v) => [v, { items: [], counts: {}, sweep: null, loaded: false }])),
    counts: {},
    byId: {},
    group: 'step',
    // The List view (list.js): its own choices on this device.
    listTab: storageGet('listTab', 'active'),
    listGroup: storageGet('listGroup', 'live'),
    listCollapsed: (() => {
      try {
        return JSON.parse(storageGet('listCollapsed', '[]'));
      } catch {
        return [];
      }
    })(),
    // The leads whose workers are showing under them in a list; every lead starts folded (owner, 10/20).
    workersOpen: (() => {
      try {
        return JSON.parse(storageGet('workersOpen', '[]'));
      } catch {
        return [];
      }
    })(),
    // The Conversation view's side panels: goal and history on the left, links and screens on the right.
    // Both lie over the page, never pushing the column: they stay open on a wide desk (this device
    // remembers which), and fly out over a scrim when narrower.
    convoPanels: { left: storageGet('convoLeft', '1') === '1', right: storageGet('convoRight', '1') === '1' },
    convoFlyout: null, // 'left' | 'right' | null: the one panel open over a narrow desk
    agentIcons: {}, // the owner's icon and color per agent (server setting, every screen)
    repoIcons: {}, // the same per repo, keyed by its name in lower case: a coding thread's fallback tile
    spaceViews: null,
    nextPageViews: (() => { try { const v = JSON.parse(storageGet('nextPageViews', '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } })(),
    listViews: null, // the owner's List views (server setting; null: the built-in ones)
    projects: [], // the owner's projects, folders of related conversations (server setting, every screen)
    coordinators: {}, // projectId -> the project coordinator's summary: watch, status, flags (coordinator.js)
    coordinator: null, // the coordinator open in the side panel: { projectId, view, pending: [{ text, at }], loading, error }
    sendStay: storageGet('sendStay', '0') === '1', // after a typed send: stay in the Conversation (this device) rather than go back to the List
    sideTab: storageGet('sideTab', 'coordinator'), // the right panel's tab: 'coordinator' | 'links' (this device)
    projectsRev: 0, // the server's revision of them: a save from an older copy is refused
    projectsLoaded: false, // whether `projects` came from the server yet (an empty list before then isn't "none")
    projectSectionsHidden: ['done'], // the status sections a project's page hides unless it picks its own (desk/projects.ts)
    mailOff: [], // conversations and projects (project:<id>) closed to agent mail (desk/mail.ts)
    feed: { posts: [], loaded: false }, // a Screen window's news feed (feed.js; desk/feed.ts), newest first
    feedSettings: { chatter: 'hidden', needsYou: false, summaries: false, usage: true }, // what the feed shows (server setting, every screen)
    listProject: storageGet('listProject', '') || null, // the project open in the List on this device, or null
    projectEditor: null, // the project dialog: { editing: project id | 'new', forItem: item id | null }
    labelOrder: null, // the owner's order for the List view's label sections (server setting; null: the default)
    snoozeTimes: snoozeTimesOf(null), // the snooze presets' morning and evening times (server setting, every screen)
    presentation: { view: 'active', itemId: null, conversationKey: null, sceneId: null, queue: [], by: null, since: 0 },
    detail: null, // { id, item, messages, timeline, scenes, loading, error }
    scenes: {}, // scene cache by id (from the hub stream and lookups)
    activity: { open: false, events: [], loading: false },
    ownerReceipts: readReceipts(),
    commands: {}, // commandId -> { commandId, type, itemId, args, status, error, outcome, at }
    holds: {}, // itemId -> { option (what is shown), type, args }: an answer tapped and on its way (its chips are hidden meanwhile)
    pendingDrafts: {}, // itemId -> the owner's picks on a Loom request (pending.js); kept when sending fails
    drafts: {},
    replyImages: {}, // itemId -> the images pinned in that reply's draft ({ id, name, mimeType, dataUrl, sizeBytes })
    replyReading: {}, // itemId -> images still being read in (Send waits for them)
    lightbox: null, // { images: [{ src, name }], index }: an image full size
    replyOpen: null,
    sheet: null, // Conversation view overlay: { kind: 'exchange', index, from } | { kind: 'context' } | { kind: 'links' }
    focusId: null,
    snoozeFor: null,
    catchupSnooze: null,
    snoozeGuard: null, // asSeen() of the item when the picker opened
    confirm: null,
    toasts: [],
    swept: {}, // itemId -> when its sweep answer was taken (0 while on its way): kept off the sweep card until it's read again
    operator: { live: false, status: 'idle', transcript: null, agentName: null },
    captions: [],
    draft: blankDraft(), // the voice operator's Draft card (draft mode)
    draftPending: null, // 'send' | 'cancel' while a tap is on its way
    pause: blankPause(), // the voice operator's pause pill (pause mode)
    pausePending: false, // a resume tap is on its way
    screenId: null,
    feedScope: feedScopeOf(typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('feedScope')),
    role: roleOf(role), // what this window is for: full | control | screen (role.js; the URL keeps it)
    windows: [], // every connected window: [{ id, name, role }] (the hub's dashboard)
    live: {}, // { scenes: ids, prototypes: [prototype], sceneList: [scene] }: what is live (a screen window's hold and Recent screens)
    lists_open: null, // desktop drawer with Snoozed / Everything / History
    filters: { ...NO_FILTERS }, // the owner's board filters (shared by every screen)
    filterOpen: false, // Settings is open
    settingsPage: 'device', // its page: device | tabs | projects | notifications | accounts | labs (or an older name, settings.js SETTINGS_HOME)
    settingsSub: null, // a page's sub-page: { tab: view id } | { project: project id | 'new' }
    facets: null, // { agents, repos, types } with counts, while the panel is open
    facetsLoaded: false,
    search: blankSearch(), // ⌘K and the List's search mode (search-model.js)
    transcript: null, // a conversation read whole from search: { itemId, around, row, messages, hasEarlier, hasLater, loading, error }
    startWork: null, // the Start work sheet: { options, loading, loadError, form, sending, error, commandId }
    capacity: null, // the Capacity page and a thread's account (capacity.js): { data, loading, error }
    system: null, // the System page and the sidebar's System row (next/system.js): { data, loading, error }
    systemJobs: {}, // a job's page (System › job): jobId -> { data, loading, error }
    catchup: null, // every space's chapter in brief (GET /api/desk/chapters): the sidebar's dots and the Inbox summary: { data, error }
    decidedLocal: {}, // decisionId -> { reversal, note }: a reversal at the tap, until it goes through
    chapters: {}, // spaceId -> { data, loading, error }: the space's catch-up chapter (GET /api/desk/chapters/:space)
    chapterLocal: {}, // spaceId -> 'accepted' | 'deferred': Accept or Defer shown at the tap, until the reading has it
    lineLocal: {}, // update id -> true: a line handled at the tap (Fine by me, Got it, a brief's Defer)
    catchupFollow: null, // { focus, skipped, at }: Catch me up as the voice walk has it (list_place catchup); the page follows
    decisionPage: null, // a decision's brief page (next/decision.js), over the desk: { id, data, loading, error }
    briefRules: {}, // brief requestId -> { rule, reason }: the rule chips on a decision brief (own or carried), picked before the answer
    ruleLocal: {}, // decisionId -> { rule, from }: the choice tapped on an answered brief, shown until the thread's copy moves on from `from`
    ruleMade: {}, // decisionId -> the rule Loom said the tap made or kept (shown until the thread catches up)
    ruleBusy: {}, // decisionId -> true while a rule choice is on its way: further taps wait (one decision, one rule)
    review: null, // the weekly Delegation review (next/decided.js): { data: { due, seenAt, review }, error }
    reviewSeenLocal: false, // "Seen" on the review at the tap
    routing: null, // Settings › Routing: { data, loading, error }
    now: Date.now(),
  };

  function notify() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const fn of listeners) fn(state);
    });
  }
  function set(patch) {
    Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    if (state.nextSelect) state.nextSelect = reconcileSelection(state);
    notify();
  }

  // ── toasts ─────────────────────────────────────────────────────────
  // The build this page was served with (the shell's meta tag; else the first hello, as in fixtures), and the
  // newer build already offered while the owner was typing (offered again for any later one).
  let pageBuild = (typeof document !== 'undefined' && document.querySelector('meta[name="desk-build"]')?.getAttribute('content')) || null;
  let promptedFor = null;
  function toast(text, { action = null, actions = null, sticky = false, ms = 4500 } = {}) {
    const id = ++toastSeq;
    set({ toasts: [...state.toasts, { id, text, actions: actions || (action ? [action] : []), sticky }].slice(-4) });
    if (!sticky) setTimeout(() => dismissToast(id), ms);
    return id;
  }
  function dismissToast(id) {
    set({ toasts: state.toasts.filter((t) => t.id !== id) });
  }

  // ── lists ──────────────────────────────────────────────────────────
  function indexItems() {
    const byId = {};
    // Oldest read first, so an item in several lists is its freshest copy (Codex review on #671).
    const views = [...LIST_VIEWS].sort((a, b) => (fetchedFrom[a] ?? 0) - (fetchedFrom[b] ?? 0));
    for (const view of views) for (const item of state.lists[view].items) byId[item.id] = item;
    if (state.detail?.item) byId[state.detail.item.id] = byId[state.detail.item.id] || state.detail.item;
    return byId;
  }

  // One request per list at a time, so an older answer can't land after a newer one: a refresh queues
  // behind the load on its way; `join` (a caller that only needs the list loaded) shares it (Codex review on #541).
  const listLoads = {};
  function loadList(view, { join = false } = {}) {
    if (join && listLoads[view]) return listLoads[view];
    const load = (listLoads[view] || Promise.resolve()).then(() => fetchList(view)).finally(() => {
      if (listLoads[view] === load) delete listLoads[view];
    });
    listLoads[view] = load;
    return load;
  }
  // The ETag of each list this window holds, for its group: an unchanged list comes back empty (304) and isn't redrawn.
  const listEtags = {};
  // An item that came back exactly as it was keeps its object, so a row that shows it isn't redrawn (next/rows.js).
  const itemText = new WeakMap();
  const textOf = (item) => {
    let text = itemText.get(item);
    if (text === undefined) itemText.set(item, (text = JSON.stringify(item)));
    return text;
  };
  function reuseItems(view, items) {
    const before = new Map((state.lists[view]?.items || []).map((item) => [item.id, item]));
    return items.map((item) => {
      const old = before.get(item.id);
      return old && textOf(old) === textOf(item) ? old : item;
    });
  }
  // What this device kept from its last visit (list-cache.js), by view: { group, etag, build, data }.
  const storedLists = {};
  /** `from`: when the server read began (null for a list kept on this device: not a fresh read, so no prediction settles on it). */
  function showList(view, json, from = null) {
    rawLists[view] = reuseItems(view, json.items || []);
    state.lists[view] = { items: rawLists[view], counts: json.counts || {}, sweep: json.sweep || null, loaded: true };
    if (view === 'active' && json.counts) state.counts = json.counts;
    state.byId = indexItems();
    if (state.focusId && !state.byId[state.focusId]) state.focusId = null;
    if (from !== null) listRead(view, from);
    else showOverlays();
    settleProjectRepo();
    notify();
  }
  /** The server's copy of this list is current as of `from` (a fresh read, or a 304 saying it hasn't changed). */
  function listRead(view, from) {
    fetchedFrom[view] = from;
    // Active carries the sweep: what was picked up or done before this read began is gone from it now.
    if (view === 'active') state.swept = Object.fromEntries(Object.entries(state.swept).filter(([, at]) => at === 0 || at > from));
    settleOverlays();
    notify();
  }
  async function fetchList(view) {
    const startedAt = projectTick(); // the one clock for reads and answers: it never ties as milliseconds do
    try {
      const group = state.group;
      const stored = storedLists[view]?.group === group ? storedLists[view] : null;
      const held = listEtags[view]?.group === group && state.lists[view].loaded ? listEtags[view].etag : (stored?.etag ?? null);
      const json = client.itemsIfChanged ? await client.itemsIfChanged({ view, group, etag: held }) : await client.items({ view, group });
      if (json.notModified) {
        // Kept from another build: shown only now that the server says it is still exactly this.
        if (!state.lists[view].loaded && stored) {
          listEtags[view] = { group, etag: stored.etag };
          showList(view, stored.data, startedAt);
        } else listRead(view, startedAt);
        return;
      }
      listEtags[view] = json.etag ? { group, etag: json.etag } : null;
      const { etag, ...data } = json;
      showList(view, data, startedAt);
      if (etag && listCache) {
        storedLists[view] = { group, etag, build: pageBuild, data };
        void listCache.write(`${view}|${group}`, { group, etag, build: pageBuild, data });
      }
    } catch (err) {
      if (!state.lists[view].loaded) console.warn('[desk] list failed', view, err.message);
    }
  }

  // ── optimistic overlays (optimistic.js): a command's predicted effect, shown from the tap ──
  // Kept over the server's copies (rawLists, the open Conversation's item) until every list loaded, and the
  // Conversation when it shows the item, has been read again since the command answered; dropped at once on failure.
  const overlays = []; // [{ id, itemId, apply(item), settledAt }]
  const rawLists = {}; // view -> the server's items, before overlays
  const fetchedFrom = {}; // view -> when the newest list read that landed was asked for
  const onlyById = {}; // itemId -> the server's copy of an item known outside the lists (before its overlays)
  let rawDetail = null; // { id, item, from }: the open Conversation's item as the server sent it
  // After the command answers, a refresh that never lands can't pin a prediction past this. Before it answers, the
  // request's own deadline (COMMAND_TIMEOUT_MS) brings it down: a reply can take a while to reach its source.
  const OVERLAY_MAX_MS = 20_000;
  function showOverlays() {
    const raw = Object.fromEntries(LIST_VIEWS.map((view) => [view, rawLists[view] ?? state.lists[view].items]));
    const lists = overlaidLists(raw, overlays, fetchedFrom, (item) => filterMatches(item, state.filters), rawDetail);
    for (const view of LIST_VIEWS) if (lists[view] !== state.lists[view].items) state.lists[view] = { ...state.lists[view], items: lists[view] };
    const byId = indexItems();
    for (const [id, item] of Object.entries(onlyById)) if (!byId[id]) byId[id] = overlaid([item], overlays)[0];
    for (const [id, item] of Object.entries(state.byId)) if (!byId[id] && !onlyById[id]) byId[id] = item;
    state.byId = byId;
    if (state.detail?.item && rawDetail?.id === state.detail.id) state.detail = { ...state.detail, item: overlaid([rawDetail.item], overlays)[0] };
  }
  /** Shows what `type` will do to the item at once; returns the overlay (null when it can't be predicted). */
  function addOverlay(type, itemId, args) {
    // The copy on screen: the open Conversation's when it shows the item, else the list's (Codex review on #671).
    const item = itemId ? asShown(itemId) || itemFor(itemId) : null;
    if (!item || predict(type, item, args, { projects: state.projects }) === undefined) return null;
    // The server's copy at the tap: a settle check can ask whether the server has moved on from it.
    const before = serverCopy(itemId) || item;
    const settles = SETTLES_WHEN[type];
    const overlay = overlayWith(itemId, (it) => predict(type, it, args, { projects: state.projects }), settles ? (server) => settles(server, before) : null);
    if (overlay) overlay.movesAttention = movesAttention(type, item, predict(type, item, args, { projects: state.projects }), args);
    return overlay;
  }
  /** An overlay from any prediction (a whole project's conversations use it too). */
  /** `until(serverCopy)`: the server shows it only later than its answer; the overlay waits for that too (or the cap). */
  function overlayWith(itemId, apply, until = null) {
    const item = itemFor(itemId);
    if (!item) return null;
    const inLists = LIST_VIEWS.some((view) => (rawLists[view] ?? state.lists[view].items).some((i) => i.id === itemId));
    if (!inLists && !onlyById[itemId]) onlyById[itemId] = state.byId[itemId] || item;
    if (state.detail?.id === itemId && state.detail.item && rawDetail?.id !== itemId) rawDetail = { id: itemId, item: state.detail.item, from: 0 };
    const overlay = { id: uuid(), itemId, apply, until, settledAt: null };
    overlays.push(overlay);
    showOverlays();
    notify();
    return overlay;
  }
  function dropOverlay(overlay) {
    const at = overlays.indexOf(overlay);
    if (at < 0) return;
    overlays.splice(at, 1);
    if (!overlays.some((o) => o.itemId === overlay.itemId)) delete onlyById[overlay.itemId];
    showOverlays();
    notify();
  }
  /** The item as the server last sent it (before overlays): the open Conversation's copy, else the freshest list's. */
  function serverCopy(itemId) {
    // The freshest copy: a list's, or the open Conversation's when it was read later (Codex review on #671).
    let best = null;
    let bestFrom = -1;
    for (const view of LIST_VIEWS) {
      const found = (rawLists[view] || []).find((item) => item.id === itemId);
      if (found && (fetchedFrom[view] ?? 0) > bestFrom) (best = found), (bestFrom = fetchedFrom[view] ?? 0);
    }
    if (rawDetail?.id === itemId && rawDetail.from > bestFrom) best = rawDetail.item;
    return best || onlyById[itemId] || null;
  }
  /** Settles overlays once their command answered: kept until the server's copies agree, and at most OVERLAY_MAX_MS. */
  function settleAfter(list) {
    const at = projectTick();
    const time = Date.now();
    for (const o of list) if (o) (o.settledAt = at), (o.settledTime = time);
    setTimeout(() => (settleOverlays(), notify()), OVERLAY_MAX_MS + 50);
  }
  /** Drops the predictions the server's copies now carry (read since the command answered). */
  function settleOverlays() {
    const now = Date.now();
    for (const o of [...overlays]) {
      if (o.settledAt === null) continue;
      // In tap order per item: a newer prediction stays while an older one for the same item is still on its way,
      // so answers arriving out of order never show the older state over the newer (Codex review on #671).
      if (overlays.some((x) => x !== o && x.itemId === o.itemId && x.settledAt === null && overlays.indexOf(x) < overlays.indexOf(o))) continue;
      const listsRead = LIST_VIEWS.every((view) => !state.lists[view].loaded || (fetchedFrom[view] ?? 0) >= o.settledAt);
      // Only a conversation on screen needs reading again; one left cached behind the board doesn't (Codex review on #671).
      const shown = state.detail?.id === o.itemId && state.presentation?.itemId === o.itemId && state.presentation?.view !== 'active';
      const detailRead = !shown || (rawDetail?.id === o.itemId && rawDetail.from >= o.settledAt);
      const server = o.until ? serverCopy(o.itemId) : null;
      const shows = !o.until || (server && o.until(server));
      if ((listsRead && detailRead && shows) || now - o.settledTime > OVERLAY_MAX_MS) {
        overlays.splice(overlays.indexOf(o), 1);
        if (!overlays.some((x) => x.itemId === o.itemId)) delete onlyById[o.itemId];
      }
    }
    showOverlays();
  }

  /** A sweep answer: off the sweep card at the tap (it isn't a list, so it has its own overlay: `swept`). */
  async function sweep(itemId, decision, retryOf = {}) {
    set({ swept: { ...state.swept, [itemId]: 0 } });
    // Its own Retry, so a retried answer is kept off the card too, with the same id after a lost answer (Codex review on #671).
    const result = await command('sweep', itemId, { decision }, { quiet: true, ...retryOf });
    if (result.status !== 'sent') failToast('sweep', itemId, result, () => sweep(itemId, decision, again(result)));
    const swept = { ...state.swept };
    if (result.status === 'sent') {
      swept[itemId] = projectTick(); // the read clock: Active read after this carries the answer
      setTimeout(() => {
        if (state.swept[itemId] === swept[itemId]) set({ swept: Object.fromEntries(Object.entries(state.swept).filter(([id]) => id !== itemId)) });
      }, OVERLAY_MAX_MS);
    } else delete swept[itemId];
    set({ swept });
    return result;
  }

  /** The lists from this device's last visit: the same build's are shown at once; another build's wait for a 304. */
  async function restoreLists() {
    if (!listCache) return;
    const group = state.group;
    const entries = await Promise.all(LIST_VIEWS.map((view) => listCache.read(`${view}|${group}`).catch(() => null)));
    LIST_VIEWS.forEach((view, i) => {
      const entry = entries[i];
      if (!entry || entry.group !== group) return;
      storedLists[view] = entry;
      if (entry.build && entry.build === pageBuild && !state.lists[view].loaded) {
        listEtags[view] = { group, etag: entry.etag };
        showList(view, entry.data);
      }
    });
  }

  let refreshTimer = null;
  function refreshLists(delay = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => LIST_VIEWS.forEach((view) => loadList(view)), delay);
  }

  // ── filters (spec "Filters"): stored on the server, applied there, shared by every screen ──
  let filterSeq = 0;
  let viewsSeq = 0;
  let spaceViewsSeq = 0;
  // Saves of the views on their way. Every save is broadcast back whole, so while ours are in flight a broadcast
  // carries views older than what this screen shows; the last save's answer settles them (quick edits lost the
  // earlier ones: an echo put back the state before them).
  let viewSaves = 0;
  let spaceViewSaves = 0;
  /**
   * Every settings write goes to the desk in the order made, each once the one before it has ended (at most
   * ORDER_HOLD_MS): two quick reorders, say, are stored in the order tapped (Codex review on #671). The deadline counts
   * from the call; one whose deadline passes while it waits its turn is never sent, and fails as plainly refused.
   */
  /**
   * Writes on one key (a setting, a project's watch, one mail switch, one thread's move) reach the desk in the order
   * made: each goes once the request before it on that key has really ended (at most ORDER_HOLD_MS), so the last tap
   * is what the desk keeps (Codex review on #671). The deadline counts from the call; one whose deadline passes while
   * it waits its turn is never sent, and fails as plainly refused (a body), not as a lost answer.
   */
  const lines = new Map(); // key -> the newest write's end, while one is on its way
  function inLine(key, send, ms = COMMAND_TIMEOUT_MS) {
    let request;
    let cancelled = false;
    const go = () => {
      if (!cancelled) request = send();
    };
    const prev = lines.get(key);
    const started = prev ? prev.then(go) : (go(), Promise.resolve()); // nothing ahead: it goes at once
    const line = started.then(() => answerWithin(request, ORDER_HOLD_MS)).catch(() => {});
    lines.set(key, line);
    line.finally(() => lines.get(key) === line && lines.delete(key));
    return answerWithin(started.then(() => request), ms).catch((err) => {
      if (request) throw err;
      cancelled = true;
      const why = 'the change before it was still going, so this one wasn’t sent';
      throw Object.assign(new Error(why), { body: { error: why } });
    });
  }
  /** Every settings write, one line: two quick reorders are stored in the order tapped. */
  // `body` may be a function: built when its turn comes, from what the writes before it left.
  const settingsInOrder = (body) => inLine('settings', () => client.saveSettings(typeof body === 'function' ? body() : body));

  /**
   * After a lost answer (no reply, a timeout) a settings change may or may not have been saved: rather than guess
   * and roll back, read what the desk has (Codex review on #671). Each setting's sequence moves on first, so this
   * read is what shows even over a save still waiting.
   */
  function reconcileSettings() {
    feedSettingsSeq += 1;
    filterSeq += 1;
    viewsSeq += 1;
    spaceViewsSeq += 1;
    sectionsSeq += 1;
    snoozeTimesSeq += 1;
    for (const field of Object.keys(iconSeqs)) iconSeqs[field] += 1;
    for (const key of Object.keys(spaceSeqs)) spaceSeqs[key] += 1;
    return loadSettings();
  }
  async function loadSettings() {
    if (!client.settings) return;
    // A setting saved or streamed while this read was out is newer than its answer: each one checks its own
    // sequence from when the read began (Codex review on #595, #671).
    const at = { spaceViews: spaceViewsSeq, feed: feedSettingsSeq, filters: filterSeq, views: viewsSeq, sections: sectionsSeq, snooze: snoozeTimesSeq, agentIcons: iconSeqs.agentIcons, repoIcons: iconSeqs.repoIcons, labels: labelSaveSeq, labelStream: labelOrderSeq };
    const spacesAt = JSON.stringify(spaceSeqs);
    const spacesSame = () => JSON.stringify(spaceSeqs) === spacesAt;
    const from = projectTick();
    try {
      const json = await client.settings();
      const labelsSame = at.labels === labelSaveSeq && at.labelStream === labelOrderSeq;
      if (labelsSame) confirmedLabelOrder = json.labelOrder || null;
      confirmProjects(json.projects || [], json.projectsRev || 0, from);
      set({
        ...(at.filters === filterSeq ? { filters: normalizeFilters(json.filters) } : {}),
        ...(spacesSame() ? { spaces: json.spaces || {} } : {}),
        ...(at.agentIcons === iconSeqs.agentIcons ? { agentIcons: json.agentIcons || {} } : {}),
        ...(at.repoIcons === iconSeqs.repoIcons ? { repoIcons: json.repoIcons || {} } : {}),
        ...(labelsSame && labelSaves === 0 ? { labelOrder: json.labelOrder || null } : {}),
        ...(at.snooze === snoozeTimesSeq ? { snoozeTimes: snoozeTimesOf(json.snoozeTimes) } : {}),
        ...(at.spaceViews === spaceViewsSeq ? { spaceViews: json.spaceViews || null } : {}),
        ...(at.views === viewsSeq ? { listViews: json.listViews || null } : {}),
        mailOff: confirmMail(json.mailOff || []),
        ...(at.sections === sectionsSeq ? { projectSectionsHidden: json.projectSectionsHidden || ['done'] } : {}),
        ...(json.feed && at.feed === feedSettingsSeq ? { feedSettings: json.feed } : {}),
      });
    } catch {
      /* an older server without filters: none apply */
    }
  }

  // ── the news feed (feed.js): read by a Screen window, again whenever a post is written or the settings change ──
  let feedTimer = null;
  let feedLoadSeq = 0;
  let feedSettle = false;
  /**
   * `settle`: what this read brings in is not news arriving (a settings change showing older posts, a
   * reconnect): the feed shows it at once instead of one at a time (Codex review on #631).
   */
  async function loadFeed({ settle = false } = {}) {
    feedSettle = feedSettle || settle;
    if (!client.feed || state.role !== 'screen') return;
    // Only the newest read lands: an older one finishing last would hide the newest posts (Codex review on #595).
    const seq = ++feedLoadSeq;
    try {
      const json = await client.feed({ limit: 60, scope: state.feedScope });
      if (seq === feedLoadSeq) {
        set({ feed: { posts: json.posts || [], loaded: true, settle: (state.feed.settle || 0) + (feedSettle ? 1 : 0) } });
        feedSettle = false;
      }
    } catch {
      /* the next post or settings change tries again */
    }
  }
  function feedChanged({ settle = false } = {}) {
    feedSettle = feedSettle || settle;
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => loadFeed(), 400);
  }
  // Like the snooze times: only the newest save's answer (or failure) lands (Codex review on #595).
  let feedSettingsSeq = 0;
  async function saveFeedSettings(patch) {
    const seq = ++feedSettingsSeq;
    const before = state.feedSettings;
    set({ feedSettings: { ...before, ...patch } });
    try {
      const json = await settingsInOrder({ feed: patch });
      if (seq === feedSettingsSeq && json.feed) set({ feedSettings: json.feed });
      feedChanged({ settle: true });
      return null;
    } catch (err) {
      if (seq === feedSettingsSeq) set({ feedSettings: before });
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      return err.body?.error || err.message || 'network error';
    }
  }
  // ── capacity and routing (next/capacity.js, Settings › Routing) ──
  let capacitySeq = 0;
  /**
   * Moves Loom accepted but hasn't made yet (it waits for the turn in progress): itemId → { to, at }. Each
   * reading shows the thread on its new account, marked pending, until Loom's own reading agrees (or an hour passes).
   */
  const pendingMoves = new Map();
  function withPendingMoves(data) {
    if (!data || !pendingMoves.size) return data;
    let accounts = data.accounts;
    for (const [itemId, { to, at }] of [...pendingMoves]) {
      const from = accounts.find((a) => a.threads.some((t) => t.itemId === itemId));
      if (!from || from.id === to || Date.now() - at > 3_600_000 || !accounts.some((a) => a.id === to)) {
        pendingMoves.delete(itemId);
        continue;
      }
      const thread = { ...from.threads.find((t) => t.itemId === itemId), pending: true };
      const key = thread.running ? 'running' : 'idle';
      accounts = accounts.map((a) => (a.id === from.id ? { ...a, threads: a.threads.filter((t) => t.itemId !== itemId), [key]: a[key] - 1 } : a.id === to ? { ...a, threads: [thread, ...a.threads], [key]: a[key] + 1 } : a));
    }
    return { ...data, accounts };
  }
  async function loadCapacity() {
    const seq = ++capacitySeq;
    set({ capacity: { ...(state.capacity || { data: null, error: null }), loading: true } });
    try {
      const data = withPendingMoves(await client.capacity());
      if (seq === capacitySeq) set({ capacity: { data, loading: false, error: null } });
    } catch (err) {
      if (seq === capacitySeq) set({ capacity: { ...(state.capacity || { data: null }), loading: false, error: err.body?.error || err.message || 'network error' } });
    }
  }
  /**
   * Moves a Loom thread to another account. Optimistic: the Capacity page shows it there at once; a refusal
   * puts it back and offers Retry. Loom moves it at its next safe point (after the turn in progress).
   */
  async function moveThread(itemId, accountId, commandId = uuid(), { allow = false } = {}) {
    const before = state.capacity;
    const data = before?.data;
    const from = data?.accounts.find((a) => a.threads.some((t) => t.itemId === itemId));
    const to = data?.accounts.find((a) => a.id === accountId);
    if (data && from && to && from.id !== to.id) {
      pendingMoves.set(itemId, { to: to.id, at: Date.now() });
      set({ capacity: { ...before, data: withPendingMoves(data) } });
    }
    try {
      await inLine(`move:${itemId}`, () => client.moveThread({ itemId, account: accountId, commandId, ...(allow ? { allow: true } : {}) }));
      toast(`Moving to ${to?.name || 'the other account'}${from?.threads.find((t) => t.itemId === itemId)?.running ? ' after the current turn' : ''}. Same conversation.`);
      void loadCapacity();
      return null;
    } catch (err) {
      // Back where it was, then Loom's own reading.
      pendingMoves.delete(itemId);
      set({ capacity: before });
      void loadCapacity();
      const why = err.body?.error || err.message || 'network error';
      // No answer: the same id again, so Loom replays the move rather than making it twice (Codex review on #671).
      toast(`Didn’t move: ${why}`, { sticky: true, action: { label: 'Retry', fn: () => moveThread(itemId, accountId, err.body ? uuid() : commandId, { allow }) } });
      return why;
    }
  }
  // ── the System page (next/system.js, desk/system.ts) ──
  let systemSeq = 0;
  // Commands on their way: each reading has their predictions laid over it until they answer (optimistic.js predictSystem).
  const systemPending = new Map(); // commandId -> { type, args, at }
  const withSystemPending = (data) => [...systemPending.values()].reduce((acc, c) => predictSystem(c.type, acc, c.args, c.at) || acc, data);
  async function loadSystem() {
    const seq = ++systemSeq;
    set({ system: { ...(state.system || { data: null, error: null }), loading: true } });
    try {
      const data = await client.system({ retired: true });
      if (seq === systemSeq) set({ system: { data: withSystemPending(data), raw: data, loading: false, error: null } });
    } catch (err) {
      if (seq === systemSeq) set({ system: { ...(state.system || { data: null }), loading: false, error: err.body?.error || err.message || 'network error' } });
    }
  }
  // ── decision ids as links, and a decision's brief page (TGO-1110) ───────
  let idsAt = 0;
  /** Which `D-n` Loom has a decision for: the ones that become links (decision-links.js). Throttled; a failure leaves what was known. */
  async function loadDecisionIds(force = false) {
    if (!force && Date.now() - idsAt < 15_000) return;
    idsAt = Date.now();
    try {
      const { ids } = await client.decisionIds();
      if (Array.isArray(ids)) setKnownDecisions(ids);
    } catch {
      /* the ids stay as they were */
    }
  }
  let decisionSeq = 0;
  /** The brief page for `id` over the desk: its text, chips and outcome; loaded now, and again when the thread behind it changes. */
  async function loadDecision(id) {
    const seq = ++decisionSeq;
    set({ decisionPage: { id, data: state.decisionPage?.id === id ? state.decisionPage.data : null, loading: true, error: null } });
    try {
      const data = await client.decision(id);
      if (seq === decisionSeq) set({ decisionPage: { id, data, loading: false, error: null } });
    } catch (err) {
      if (seq === decisionSeq) set({ decisionPage: { id, data: null, loading: false, error: err.status === 404 ? `There is no decision ${id}.` : err.body?.error || err.message || 'network error' } });
    }
  }
  function openDecision(id) {
    if (!/^D-\d+$/.test(id)) return;
    void loadDecision(id);
  }
  function closeDecision() {
    decisionSeq += 1;
    set({ decisionPage: null });
    // Opened by address (/decision/D-67): the desk's own address again, so the page doesn't reopen on a reload.
    if (/\/decision\/D-\d+\/?$/.test(location.pathname)) history.replaceState(history.state, '', document.baseURI + location.search);
  }
  let catchupSeq = 0;
  /** Every space's chapter in brief: its state and counts (desk/updates.ts chapters()). */
  async function loadCatchup() {
    const seq = ++catchupSeq;
    try {
      const data = await client.chapters();
      if (seq === catchupSeq) set({ catchup: { data: data.chapters || [], error: null } });
    } catch (err) {
      if (seq === catchupSeq) set({ catchup: { data: state.catchup?.data ?? null, error: err.status === 404 ? 'off' : err.body?.error || err.message || 'network error' } });
    }
  }
  /** Catch-up lines changed: the chapter list reads again, and the chapter on this window's page, once each was read. */
  let updatesTimer = null;
  function updatesChanged() {
    clearTimeout(updatesTimer);
    updatesTimer = setTimeout(() => {
      if (state.catchup) void loadCatchup();
      const r = state.nextRoute;
      const here = r && ['project', 'agent'].includes(r.page) ? `${r.page}:${r.id}` : null;
      if (here && state.chapters[here] && !state.chapterLocal[here]) void loadChapter(here);
      // Catch me up reads every space it lists.
      if (r?.page === 'catchup') for (const spaceId of Object.keys(state.chapters)) if (!state.chapterLocal[spaceId]) void loadChapter(spaceId);
    }, 1500);
  }
  const chapterSeqs = {};
  /** A space's catch-up chapter: its open lines, the briefs behind them, and what Accept would do (desk/catchup-actions.ts). */
  async function loadChapter(spaceId) {
    const seq = (chapterSeqs[spaceId] = (chapterSeqs[spaceId] || 0) + 1);
    const was = state.chapters[spaceId];
    set({ chapters: { ...state.chapters, [spaceId]: { data: was?.data ?? null, loading: true, error: null } } });
    try {
      const data = await client.chapter(spaceId);
      if (seq !== chapterSeqs[spaceId]) return;
      set({ chapters: { ...state.chapters, [spaceId]: { data, loading: false, error: null } } });
    } catch (err) {
      if (seq === chapterSeqs[spaceId]) set({ chapters: { ...state.chapters, [spaceId]: { data: was?.data ?? null, loading: false, error: err.status === 404 ? 'off' : err.body?.error || err.message || 'network error' } } });
    }
  }
  /**
   * Accept or Defer a chapter, on exactly the lines the owner saw. Optimistic: the card turns at the tap; a refusal
   * takes it back and offers Retry, and a chapter that changed since comes back with its new plan to look at again.
   * True once it went through; `onDone` hears it too, including when a Retry from the toast is what got it there.
   */
  async function chapterAct(spaceId, act, { name = 'this space', lead = null, onDone = null, backAt, shownPlan } = {}, commandId = uuid()) {
    const plan = shownPlan || state.chapters[spaceId]?.data?.plan;
    if (!plan) return false;
    if (act === 'deferred' && backAt === undefined) {
      set({ snoozeFor: `chapter:${spaceId}`, catchupSnooze: { name, pick: (until) => chapterAct(spaceId, act, { name, lead, onDone, backAt: until, shownPlan: plan }, commandId) } });
      return false;
    }
    set({ chapterLocal: { ...state.chapterLocal, [spaceId]: act } });
    let result;
    try {
      const body = { updateIds: plan.updateIds, revision: plan.revision, commandId, ...(backAt !== undefined ? { backAt } : {}) };
      result = await (act === 'accepted' ? client.chapterAccept(spaceId, body) : client.chapterDefer(spaceId, body));
    } catch (err) {
      const { [spaceId]: _gone, ...rest } = state.chapterLocal;
      set({ chapterLocal: rest });
      if (err.status === 409 && err.body?.changed) {
        toast('Something new came in, so nothing was done. Have another look.');
        void loadChapter(spaceId);
        return false;
      }
      const same = !err.body || err.body.unknown;
      // Unknown outcomes still replay the receipt, even after the chosen time.
      // A definitive expired-time refusal needs a fresh pick instead.
      const expired = act === 'deferred' && err.status === 400 && err.body?.error === 'backAt must be a future time (ms)';
      toast(`${act === 'accepted' ? 'Accept' : 'Snooze'} didn’t go through: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => chapterAct(spaceId, act, { name, lead, onDone, backAt: expired && backAt <= Date.now() ? undefined : backAt, shownPlan: plan }, same ? commandId : uuid()) } });
      return false;
    }
    const who = lead || 'The lead';
    if (act === 'deferred') toast(`Snoozed ${name} until ${snoozeWhen(result.backAt ?? backAt)}. Nothing was answered; briefs stay in Needs you.`);
    else if (result?.failed?.length) toast(`Accepted for ${name}, but ${result.failed.length} didn’t go through: ${result.failed[0].error}. It stays on the card.`, { sticky: true });
    else toast(`Accepted for ${name}. ${who} won’t retell this.`);
    void loadCatchup();
    await loadChapter(spaceId);
    const { [spaceId]: _shown, ...local } = state.chapterLocal;
    set({ chapterLocal: local });
    const ok = !result?.failed?.length;
    if (ok) onDone?.();
    return ok;
  }
  /**
   * Catch me up's shared Smaller row: one Got it reads every line it showed, across its spaces. Optimistic: the lines
   * go at the tap; a refusal brings them back and offers Retry. True once it went through; `onDone` hears it too,
   * including when a Retry from the toast is what got it there.
   */
  async function smallerSeen(spaces, { onDone = null } = {}) {
    const ids = spaces.flatMap((s) => s.ids);
    if (!ids.length) return false;
    set({ lineLocal: { ...state.lineLocal, ...Object.fromEntries(ids.map((id) => [id, true])) } });
    const back = () => set({ lineLocal: Object.fromEntries(Object.entries(state.lineLocal).filter(([id]) => !ids.includes(Number(id)))) });
    try {
      await client.updatesSeen({ ids, via: 'read', outcome: 'got-it' });
    } catch (err) {
      back();
      toast(`That didn’t go through: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => smallerSeen(spaces, { onDone }) } });
      return false;
    }
    void loadCatchup();
    await Promise.all(spaces.map((s) => loadChapter(s.spaceId)));
    back();
    onDone?.();
    return true;
  }
  function snoozeWhen(ms) {
    return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  /**
   * One line handled from its card: Got it (read), Snooze, or Fine by me on a decision. A collapsed
   * moment or group carries `ids`, every line it stands for (a PR's folded decisions, a batch of rule changes).
   */
  async function chapterLine(spaceId, line, how, commandId = uuid(), backAt, threadSnoozed = false) {
    if (threadSnoozed?.undone) return;
    if (how === 'defer' && backAt === undefined) {
      const name = state.projects.find((p) => `project:${p.id}` === spaceId)?.name || agentsOf(state.lists, state.now).find((a) => `agent:${a.id}` === spaceId)?.name || 'this space';
      set({ snoozeFor: `line:${spaceId}:${line.id}`, catchupSnooze: { name, pick: (until) => chapterLine(spaceId, line, how, commandId, until, threadSnoozed) } });
      return;
    }
    const ids = line.ids?.length ? line.ids : [line.id];
    const drop = () => {
      const rest = { ...state.lineLocal };
      for (const id of ids) delete rest[id];
      set({ lineLocal: rest });
    };
    set({ lineLocal: { ...state.lineLocal, ...Object.fromEntries(ids.map((id) => [id, true])) } });
    try {
      if (how === 'fine') await client.decidedConfirm({ decisionId: line.decisionId, commandId });
      else {
        const write = client.updatesSeen({ ids, via: how === 'defer' ? 'deferred' : 'read', outcome: how === 'defer' ? 'later' : 'got-it', ...(backAt !== undefined ? { backAt } : {}) });
        if (threadSnoozed) threadSnoozed.pending = write;
        const receipt = await write;
        if (threadSnoozed) threadSnoozed.marks = receipt?.updates || [];
      }
    } catch (err) {
      drop();
      const same = !err.body || err.body.unknown;
      toast(`That didn’t go through: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => chapterLine(spaceId, line, how, same ? commandId : uuid(), how === 'defer' && backAt <= Date.now() ? undefined : backAt, threadSnoozed) } });
      return;
    }
    if (how === 'defer' && !threadSnoozed) toast(`Snoozed until ${snoozeWhen(backAt)}. It stays in Needs you.`);
    await loadChapter(spaceId);
    drop();
  }
  /**
   * Did it, or one step ticked, on a recorded ask: sent with the revision the card showed, as a brief's answer is. An
   * ask re-recorded since (other steps, another kind) or already closed is refused, nothing is marked, and the card is
   * read again so it shows the record as it is now.
   */
  async function resolveAsk(ask, { itemId, spaceId, step, commandId = uuid() } = {}) {
    const reread = () => Promise.all([loadFeed(), loadCatchup(), ...(spaceId ? [loadChapter(spaceId)] : []), ...(state.detail?.id === itemId ? [loadDetail(itemId)] : [])]);
    const result = await client.resolveAsk(ask.id, { commandId, ...(step ? { step } : {}), ...(typeof ask.revision === 'number' ? { revision: ask.revision } : {}) });
    if (result?.status === 'failed' || result?.ok === false) {
      if (result.outcome?.changed || result.changed) await reread();
      throw Object.assign(new Error(result.error || 'Could not complete this ask'), { body: result, definitive: true });
    }
    await reread();
    return result;
  }
  async function replyAsk(itemId, text, { spaceId } = {}) {
    const result = await sendReply(itemId, text, { stay: true });
    if (result?.status !== 'sent') throw new Error(result?.error || 'Reply was not sent');
    if (spaceId) await loadChapter(spaceId);
    return result;
  }
  async function deferAsk(ask, { itemId, line, spaceId } = {}) {
    let target = line;
    let space = spaceId;
    // In a conversation, find its existing chapter line; never invent or resolve an ask.
    if (!target) {
      await loadCatchup();
      const spaces = state.catchup?.data || [];
      await Promise.all(spaces.map((entry) => loadChapter(entry.spaceId)));
      for (const [id, entry] of Object.entries(state.chapters)) {
        const found = entry.data?.lines?.find((candidate) => candidate.kind === 'needs' && !candidate.briefId && (ask.id ? (candidate.askId || candidate.data?.askId) === ask.id : candidate.itemId === itemId));
        if (found) { target = found; space = id; break; }
      }
    }
    if (!target) throw new Error('This ask has no catch-up line to defer yet. Try again after the next sync.');
    await client.updatesSeen({ ids: [target.id], via: 'deferred', outcome: 'later' });
    if (space) await loadChapter(space);
    await loadCatchup();
  }
  /**
   * A brief's option tapped on a catch-up card: the normal answer path (`respond`), as a tap on its decision page, with
   * the revision the card showed, so one revised since is refused. The line leaves the card at the tap and stays gone
   * once sent: the ledger resolves it when the answer reaches Loom, which can take a sync or two.
   */
  async function chapterAnswer(spaceId, line, brief, option) {
    if (!brief?.itemId || state.holds[brief.itemId]) return;
    const ids = line.ids?.length ? line.ids : [line.id];
    set({ lineLocal: { ...state.lineLocal, ...Object.fromEntries(ids.map((id) => [id, true])) } });
    const result = await hold(brief.itemId, `${option.key} · ${option.label}`, 'respond', { requestId: `decision:${brief.id}`, answers: { decision: option.answer }, ...briefRuleArgs(brief.itemId, { requestId: `decision:${brief.id}`, brief }), ...(typeof brief.revision === 'number' ? { revision: brief.revision } : {}) });
    if (result?.status !== 'sent') {
      const rest = { ...state.lineLocal };
      for (const id of ids) delete rest[id];
      set({ lineLocal: rest });
    }
    await loadChapter(spaceId);
    return result;
  }
  /**
   * Undo (the thread that did it puts it back) or "I wouldn't have" (recorded, nothing changes). Optimistic: the row
   * says so at the tap; a refusal takes it back and offers Retry.
   */
  async function reverseDecided(decision, undo, note = '', commandId = uuid()) {
    set({ decidedLocal: { ...state.decidedLocal, [decision.id]: { reversal: undo ? 'undo' : 'disagree', note } } });
    try {
      await client.decidedReverse({ decisionId: decision.id, undo, note: note || undefined, commandId });
    } catch (err) {
      const { [decision.id]: _gone, ...rest } = state.decidedLocal;
      set({ decidedLocal: rest });
      // A transport failure may have landed: the same command id makes the retry safe.
      // Lost on the way, or Loom didn't answer (it may have applied it): the same command id replays its receipt.
      const same = !err.body || err.body.unknown;
      toast(`${undo ? 'Undo' : 'That'} didn’t go through: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => reverseDecided(decision, undo, note, same ? commandId : uuid()) } });
      return;
    }
    toast(undo ? `Asked “${decision.threadTitle || 'the thread'}” to undo it.` : 'Noted: you wouldn’t have. Nothing was changed.');
    void loadCatchup();
    // The decision's catch-up line is handled too: the chapters on screen read it again.
    for (const spaceId of Object.keys(state.chapters)) void loadChapter(spaceId);
  }
  /**
   * A new rule's line: the owner changes how the answer that made it counts (Always / Ask me next time / Just this
   * once). Optimistic: the chip shows at the tap; a refusal takes it back and offers Retry.
   */
  async function ruleDecided(entry, rule, commandId = uuid()) {
    if (!entry.decision || state.ruleBusy?.[entry.decision]) return;
    const was = state.ruleLocal[entry.decision];
    // Shown until the thread's own copy moves on from what it said at the tap (`from`): then that copy wins again,
    // so a later change from another window or the agent shows here too.
    set({ ruleLocal: { ...state.ruleLocal, [entry.decision]: { rule, from: entry.from ?? null } }, ruleBusy: { ...state.ruleBusy, [entry.decision]: true } });
    const done = () => { const { [entry.decision]: _b, ...busy } = state.ruleBusy; set({ ruleBusy: busy }); };
    let answer;
    try {
      // Confirming a proposed rule says which text was seen: Loom refuses it if a rewrite landed since.
      answer = await client.decidedRule({ decisionId: entry.decision, rule, commandId, ...(entry.proposal ? { proposal: entry.proposal } : {}) });
    } catch (err) {
      const { [entry.decision]: _gone, ...rest } = state.ruleLocal;
      set({ ruleLocal: was === undefined ? rest : { ...rest, [entry.decision]: was } });
      done();
      const same = !err.body || err.body.unknown;
      toast(`That didn’t go through: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => ruleDecided(entry, rule, same ? commandId : uuid()) } });
      return;
    }
    // Another approval can keep a shared rule standing after this one stops backing it: say which happened.
    const stands = answer?.ruleState === 'active';
    toast(rule === 'always'
      ? `${answer?.rule || entry.rule || 'The rule'} stands: agents act on it and tell you.`
      : stands
        ? `This answer no longer backs ${entry.rule || 'the rule'}, but another approval still keeps it standing.`
        : rule === 'once' ? 'Just this once: no rule, and it won’t be proposed again.' : 'No rule: agents will ask next time.');
    // The tapped choice stays shown (the thread's own copy catches up through the change stream); taps wait for this one.
    if (answer?.rule) set({ ruleMade: { ...state.ruleMade, [entry.decision]: answer.rule } });
    done();
    if (state.decisionPage?.id === entry.decision) void loadDecision(entry.decision);
    // A catch-up rule line is handled with the choice: the chapters on screen read it again.
    void loadCatchup();
    await Promise.all(Object.keys(state.chapters).map((spaceId) => loadChapter(spaceId)));
  }
  /** A tap the thread's copy has moved past: dropped for good, so a later change back to the old value isn't hidden. */
  function dropRuleTap(decisionId) {
    if (!state.ruleLocal[decisionId] || state.ruleBusy?.[decisionId]) return;
    const { [decisionId]: _gone, ...rest } = state.ruleLocal;
    set({ ruleLocal: rest });
  }
  /** The weekly Delegation review (desk/decided.ts review). */
  async function loadReview() {
    try {
      set({ review: { data: await client.decidedReview(), error: null } });
    } catch (err) {
      set({ review: { data: state.review?.data ?? null, error: err.status === 404 ? 'off' : err.body?.error || err.message || 'network error' } });
    }
  }
  async function seeReview(commandId = uuid()) {
    set({ reviewSeenLocal: true });
    try {
      // Up to the end of the review on screen: anything that landed since is in the next one.
      // The rules it showed as due come up again after another review period, not every week.
      const review = state.review?.data?.review;
      await client.decidedReviewSeen({ until: review?.until, rules: (review?.due || []).map((rule) => rule.id), commandId });
    } catch (err) {
      set({ reviewSeenLocal: false });
      const same = !err.body || err.body.unknown;
      toast(`Couldn’t put the review away: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => seeReview(same ? commandId : uuid()) } });
      return;
    }
    await loadReview();
    set({ reviewSeenLocal: false });
  }
  /**
   * A decision brief's rule chips: what the owner picked (Always do this, Ask me next time, Just this once) and their
   * reason, for the open brief only. Untouched, the answer leaves it to Loom: Always on a candidate approved as it stands.
   */
  function briefRuleOf(itemId, shown = null) {
    // Keyed by the brief's request, so a carried brief (another thread's, shown on this row) has chips of its own.
    const pending = shown || pendingOf(itemFor(itemId));
    const brief = pending?.brief;
    if (!brief) return null;
    const current = state.briefRules[pending.requestId] || null;
    // D-61: the default is "Just this once" (a precedent); Always is the owner's explicit choice.
    return { rule: current?.rule ?? (brief.candidate ? 'once' : 'next-time'), reason: current?.reason ?? '', touched: !!current?.rule };
  }
  function setBriefRule(itemId, patch, shown = null) {
    const pending = shown || pendingOf(itemFor(itemId));
    if (!pending?.brief) return;
    set({ briefRules: { ...state.briefRules, [pending.requestId]: { ...(state.briefRules[pending.requestId] || {}), ...patch } } });
  }
  /** What a brief's answer carries besides the option: the rule chip if the owner picked one, and their reason. */
  function briefRuleArgs(itemId, pending) {
    if (!pending?.brief) return {};
    const picked = briefRuleOf(itemId, pending);
    return { ...(picked?.touched ? { rule: picked.rule } : {}), ...(picked?.reason.trim() ? { reason: picked.reason.trim() } : {}) };
  }
  function clearBriefRule(requestId) {
    if (!requestId || !state.briefRules[requestId]) return;
    const next = { ...state.briefRules };
    delete next[requestId];
    set({ briefRules: next });
  }
  const jobSeqs = {};
  async function loadSystemJob(id) {
    const seq = (jobSeqs[id] = (jobSeqs[id] || 0) + 1);
    const was = state.systemJobs[id];
    set({ systemJobs: { ...state.systemJobs, [id]: { data: was?.data || null, error: null, loading: true } } });
    try {
      const data = await client.systemJob(id);
      if (seq === jobSeqs[id]) set({ systemJobs: { ...state.systemJobs, [id]: { data, loading: false, error: null } } });
    } catch (err) {
      if (seq === jobSeqs[id]) set({ systemJobs: { ...state.systemJobs, [id]: { data: was?.data || null, loading: false, error: err.status === 404 ? 'gone' : err.body?.error || err.message || 'network error' } } });
    }
  }
  /**
   * A System command (incident.ack, job.pause, …): optimistic like every desk command. The page shows it at the
   * tap; the toast says what happened (with Undo where it's undoable); a refusal takes it back and offers Retry.
   * `done`: the toast's words (or a function of the desk's outcome); `undo`: [type, args] that reverses it;
   * `action(outcome)`: the toast's button instead (Fix's "Open thread").
   */
  async function systemCommand(type, args = {}, { label = null, done = null, undo = null, action = null, commandId: reuse = null } = {}) {
    const commandId = reuse || uuid();
    const at = Date.now();
    systemPending.set(commandId, { type, args, at });
    if (state.system?.data) set({ system: { ...state.system, data: predictSystem(type, state.system.data, args, at) || state.system.data } });
    let result;
    try {
      result = await answerWithin(client.systemCommand({ commandId, type, args }));
    } catch (err) {
      result = { commandId, status: 'failed', error: err.body?.error || err.message || 'network error', ...(err.body ? {} : { transport: true }) };
    }
    systemPending.delete(commandId);
    if (result?.status === 'failed') {
      // Back to the last reading without it, then the desk's own.
      if (state.system?.raw) set({ system: { ...state.system, data: withSystemPending(state.system.raw) } });
      void loadSystem();
      // A critical job asks first (@tango/system): the desk's answer says so, and the toast offers to do it anyway.
      if (result.outcome?.needsForce) toast(result.error || `That job is critical. ${label || 'Do it'} anyway?`, { sticky: true, action: { label: 'Do it anyway', fn: () => systemCommand(type, { ...args, force: true }, { label, done, undo, action }) } });
      else toast(`${label || 'That'} didn’t go through: ${result.error || 'unknown error'}`, { sticky: true, action: { label: 'Retry', fn: () => systemCommand(type, args, { label, done, undo, action, ...(result.transport ? { commandId } : {}) }) } });
      return result;
    }
    const words = (typeof done === 'function' ? done(result.outcome || {}) : done) || result.outcome?.message || 'Done.';
    const button = action?.(result.outcome || {});
    toast(words, button ? { ms: 8000, action: button } : undo ? { ms: 6000, action: { label: 'Undo', fn: () => systemCommand(undo[0], undo[1], { label: 'Undo', done: 'Undone.' }) } } : {});
    void loadSystem();
    if (args.jobId && state.systemJobs[args.jobId]) void loadSystemJob(args.jobId);
    return result;
  }
  async function accountHistory(itemId) {
    try {
      return (await client.accountHistory(itemId)).history || [];
    } catch {
      return null;
    }
  }
  async function loadRouting() {
    set({ routing: { ...(state.routing || { data: null, error: null }), loading: true } });
    try {
      set({ routing: { data: await client.routing(), loading: false, error: null } });
    } catch (err) {
      set({ routing: { ...(state.routing || { data: null }), loading: false, error: err.body?.error || err.message || 'network error' } });
    }
  }
  /** Saves `{ default, repos }` as shown at once; a refusal puts the last saved rules back and says why. */
  let routingSeq = 0;
  async function saveRouting(update) {
    const seq = ++routingSeq;
    const before = state.routing;
    if (before?.data) set({ routing: { ...before, data: { ...before.data, rules: { ...before.data.rules, default: update.default, repos: Object.entries(update.repos).map(([repo, accounts]) => ({ repo, accounts })) } } } });
    try {
      const json = await answerWithin(client.saveRouting(update));
      if (seq === routingSeq && state.routing?.data) set({ routing: { ...state.routing, data: { ...state.routing.data, rules: json.rules } } });
      // The sheet's seats and the Capacity page follow the new rules.
      if (state.capacity) void loadCapacity();
      if (state.startWork) void loadStartOptions();
      return null;
    } catch (err) {
      if (seq === routingSeq) set({ routing: before });
      // No answer: it may have been saved, and nothing streams routing, so read what the desk has (Codex review on #671).
      if (!err.body && seq === routingSeq) void loadRouting();
      return err.body?.error || err.message || 'network error';
    }
  }
  // ── project coordinators (coordinator.js) ──
  async function loadCoordinators() {
    if (!client.coordinators) return;
    try {
      const { coordinators } = await client.coordinators();
      confirmedWatch.clear();
      for (const c of coordinators || []) confirmedWatch.set(c.projectId, c);
      set({ coordinators: Object.fromEntries((coordinators || []).map((c) => [c.projectId, c])) });
      // Changes still on their way show over them.
      for (const projectId of pendingWatch.keys()) showWatch(projectId);
    } catch {
      /* an older server without coordinators */
    }
  }
  let coordinatorSeq = 0;
  let coordinatorPoll = null;
  /** The open coordinator's thread, drafts and digests; polled while it is answering. */
  async function loadCoordinator(projectId, { catchUp = false } = {}) {
    if (!client.coordinator || !projectId) return;
    const seq = ++coordinatorSeq;
    if (state.coordinator?.projectId !== projectId) set({ coordinator: { projectId, view: null, pending: [], loading: true, error: null } });
    try {
      const view = await client.coordinator(projectId, { catchUp });
      if (seq !== coordinatorSeq || state.coordinator?.projectId !== projectId) return;
      const pending = stillPending(state.coordinator.pending || [], view);
      // What the coordinator has (before predictions): a failed action rolls back to this (Codex review on #671).
      for (const d of view?.drafts || []) confirmedDrafts.set(d.id, d);
      // A draft action still on its way keeps showing over an older read (Codex review on #671).
      if (view?.drafts && draftActs.size) view.drafts = view.drafts.map((d) => (draftActs.get(d.id)?.length ? draftActs.get(d.id).at(-1).apply(d) : d));
      set({ coordinator: { projectId, view, pending, loading: false, error: null }, ...(view.summary ? { coordinators: { ...state.coordinators, [projectId]: view.summary } } : {}) });
    } catch (err) {
      if (seq !== coordinatorSeq || state.coordinator?.projectId !== projectId) return;
      set({ coordinator: { ...state.coordinator, loading: false, error: `Couldn’t reach the coordinator: ${err.message}` } });
    }
    clearTimeout(coordinatorPoll);
    const c = state.coordinator;
    if (c?.projectId === projectId && (c.view?.running || c.pending.some((p) => !p.failed))) coordinatorPoll = setTimeout(() => state.coordinator?.projectId === projectId && loadCoordinator(projectId), 2500);
  }
  /** The Coordinator tab opened for a project: read it (and catch a stale status up). */
  function openCoordinator(projectId) {
    if (state.coordinator?.projectId === projectId && state.coordinator.view) return;
    loadCoordinator(projectId, { catchUp: true });
  }
  async function askCoordinator(projectId, text, fromItemId = null) {
    const words = String(text || '').trim();
    if (!words || !client.coordinatorAsk) return;
    const current = state.coordinator?.projectId === projectId ? state.coordinator : { projectId, view: null, pending: [], loading: true, error: null };
    // One id per question, kept with it: a retry after a lost answer is the same command, so the server
    // and Loom drop the repeat (Codex review on #545).
    const question = { text: words, at: Date.now(), commandId: uuid(), fromItemId };
    set({ coordinator: { ...current, pending: [...current.pending, question], error: null } });
    return sendQuestion(projectId, question);
  }
  async function sendQuestion(projectId, question) {
    try {
      // A project's first question starts its coordinator thread and worktree: the start's longer deadline; a question
      // to a coordinator already running gets the usual one (Codex review on #671).
      const first = !state.coordinators[projectId]?.exists;
      await answerWithin(client.coordinatorAsk(projectId, { text: question.text, commandId: question.commandId, ...(question.fromItemId ? { fromItemId: question.fromItemId } : {}) }), first ? START_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
    } catch (err) {
      const c = state.coordinator;
      const why = err.body?.error || err.message;
      if (c?.projectId === projectId) set({ coordinator: { ...c, pending: c.pending.map((p) => (p.commandId === question.commandId ? { ...p, failed: why } : p)) } });
      toast(`The coordinator didn’t get that: ${why}`);
      return;
    }
    // Only if it's still the one open: a late answer never takes the panel back (Codex review on #545).
    if (state.coordinator?.projectId === projectId) loadCoordinator(projectId);
  }
  /** Sends a question that failed again, as the same command. */
  function retryQuestion(projectId, commandId) {
    const c = state.coordinator;
    const question = c?.projectId === projectId ? c.pending.find((p) => p.commandId === commandId) : null;
    if (!question) return;
    set({ coordinator: { ...c, pending: c.pending.map((p) => (p.commandId === commandId ? { ...p, failed: null } : p)) } });
    return sendQuestion(projectId, { ...question, failed: null });
  }
  /** Lets a failed question go. */
  function dropQuestion(projectId, commandId) {
    const c = state.coordinator;
    if (c?.projectId === projectId) set({ coordinator: { ...c, pending: c.pending.filter((p) => p.commandId !== commandId) } });
  }
  // Keep watch, as Agent mail: the coordinator's confirmed summary with this screen's changes on their way over it,
  // so a streamed echo of an earlier change can't hide a newer one (Codex review on #671).
  const confirmedWatch = new Map(); // projectId -> the summary as the desk last sent it (null: none)
  const pendingWatch = new Map(); // projectId -> [{ patch }]: changes on their way, oldest first
  const blankSummary = (projectId) => ({ projectId, exists: false, watch: { on: false, stands: true, flags: true, digest: false }, reach: 'approve', status: null, flags: [], drafts: 0 });
  function showWatch(projectId) {
    const base = confirmedWatch.has(projectId) ? confirmedWatch.get(projectId) : state.coordinators[projectId] || null;
    const pending = pendingWatch.get(projectId) || [];
    const shown = pending.length
      ? pending.reduce((acc, { patch: { reach, ...watch } }) => ({ ...acc, watch: { ...acc.watch, ...watch }, ...(reach ? { reach } : {}) }), base || blankSummary(projectId))
      : base;
    const coordinators = { ...state.coordinators };
    if (shown) coordinators[projectId] = shown;
    else delete coordinators[projectId];
    set({ coordinators });
  }
  async function setCoordinatorWatch(projectId, patch) {
    if (!client.coordinatorWatch) return;
    if (!confirmedWatch.has(projectId)) confirmedWatch.set(projectId, state.coordinators[projectId] || null);
    const change = { patch };
    pendingWatch.set(projectId, [...(pendingWatch.get(projectId) || []), change]);
    showWatch(projectId);
    const done = () => pendingWatch.set(projectId, (pendingWatch.get(projectId) || []).filter((c) => c !== change));
    try {
      const summary = await inLine(`watch:${projectId}`, () => client.coordinatorWatch(projectId, patch));
      done();
      confirmedWatch.set(projectId, summary);
      showWatch(projectId);
      if (patch.on === true) toast('Keeping watch: “Where it stands” is on its way');
    } catch (err) {
      done();
      showWatch(projectId);
      // A lost answer may have been saved: the desk's summaries settle it.
      if (!err.body) void loadCoordinators();
      toast(`Couldn’t change that: ${err.body?.error || err.message}`);
    }
  }

  const DRAFT_TOASTS = { send: 'It goes as soon as that conversation is idle', now: 'Sent', drop: 'Not sent' };
  // draftId -> the actions on their way, oldest first: the newest shows; one that ends (sent or failed) leaves
  // the others, so an older one still on its way keeps showing if a newer one fails (Codex review on #671).
  const draftActs = new Map();
  const confirmedDrafts = new Map(); // draftId -> the draft as the coordinator last sent it
  const draftChains = new Map(); // draftId -> its newest action's request: the next one waits for it
  const endAct = (draftId, act) => {
    const left = (draftActs.get(draftId) || []).filter((a) => a !== act);
    if (left.length) draftActs.set(draftId, left);
    else draftActs.delete(draftId);
  };
  // Failed approval edits belong to the draft, not the current detail response.
  const failedMailEdits = new Map();
  function mergeMailDrafts(detailId, drafts) {
    for (const [id, edit] of failedMailEdits) {
      if (edit.detailId === detailId && !drafts.some((d) => d.id === id && d.state === 'draft')) failedMailEdits.delete(id);
    }
    return drafts.map((d) => {
      const edit = failedMailEdits.get(d.id);
      return edit?.detailId === detailId && d.state === 'draft' ? { ...d, text: edit.text } : d;
    });
  }
  async function mailDraft(id, action, text) {
    const detailId = state.detail?.id;
    const drafts = state.detail?.mailDrafts || [];
    // A retry from the closed editor must send the words currently shown on the card.
    if (action === 'send' && text === undefined) text = drafts.find((d) => d.id === id)?.text;
    set({ detail: { ...state.detail, mailDrafts: drafts.filter((d) => d.id !== id) } });
    try {
      await client.mailDraft(id, { action, ...(text !== undefined ? { text } : {}) });
      failedMailEdits.delete(id);
      if (state.detail?.id === detailId) await loadDetail(detailId);
    } catch (err) {
      // The draft comes back with the owner's edit, so a retry sends their words, not the agent's (Codex review on #980).
      if (action === 'send' && text !== undefined) failedMailEdits.set(id, { detailId, text });
      const back = drafts.map((d) => (d.id === id && text !== undefined ? { ...d, text } : d));
      if (state.detail?.id === detailId) set({ detail: { ...state.detail, mailDrafts: back } });
      toast(`Couldn’t ${action === 'drop' ? 'discard' : 'send'} that: ${err.body?.error || err.message}`);
    }
  }

  async function coordinatorDraft(projectId, draftId, action, text) {
    if (!client.coordinatorDraft) return;
    // An edit still on its way goes with a follow-up (Send now after an edited Send): if that first request fails,
    // the follow-up still sends the edited words, not the old ones (Codex review on #671).
    if (text === undefined) text = (draftActs.get(draftId) || []).map((a) => a.text).filter((t) => t !== undefined).at(-1);
    const act = { text, apply: (d) => ({ ...d, state: { send: 'queued', now: 'sending', drop: 'dropped' }[action], error: null, ...(text !== undefined ? { text } : {}) }) };
    draftActs.set(draftId, [...(draftActs.get(draftId) || []), act]);
    // Optimistic: the draft shows queued, sending or dropped at the tap; the coordinator's next read says how it went.
    const c = state.coordinator;
    const original = c?.projectId === projectId ? c.view?.drafts?.find((d) => d.id === draftId) : null;
    const predicted = original ? act.apply(original) : null;
    // Puts this draft back, unless something newer has replaced the prediction meanwhile: as the coordinator last had it,
    // with any other action still on its way over it, never an earlier failed prediction (Codex review on #671).
    const restore = () => {
      const now = state.coordinator;
      // By draft and state, not the object: a reload meanwhile re-applies the prediction as a new one.
      const shows = (d) => d.id === draftId && d.state === predicted?.state;
      if (!predicted || now?.projectId !== projectId || !now.view?.drafts?.some(shows)) return;
      const base = confirmedDrafts.get(draftId) || original;
      const pending = draftActs.get(draftId) || [];
      const back = pending.length ? pending.at(-1).apply(base) : base;
      set({ coordinator: { ...now, view: { ...now.view, drafts: now.view.drafts.map((d) => (shows(d) ? back : d)) } } });
    };
    if (predicted) set({ coordinator: { ...c, view: { ...c.view, drafts: c.view.drafts.map((d) => (d.id === draftId ? predicted : d)) } } });
    try {
      // An edit is sent as written, even emptied: the server refuses an empty one rather than sending the old words.
      // One draft's actions go out in the order tapped: an edited Send lands before the Send now that follows it,
      // so the edit is what goes (Codex review on #671).
      // As item commands: the next waits for this request itself to end (at most ORDER_HOLD_MS); this one's deadline
      // counts from the tap, and if it passes while it waits its turn it never goes (Codex review on #671).
      let request;
      let cancelled = false;
      const go = () => {
        if (!cancelled) request = client.coordinatorDraft(projectId, draftId, { action, ...(text !== undefined ? { text } : {}) });
      };
      const prev = draftChains.get(draftId);
      const started = prev ? prev.then(go) : (go(), Promise.resolve());
      const done = started.then(() => answerWithin(request, ORDER_HOLD_MS)).catch(() => {});
      draftChains.set(draftId, done);
      done.finally(() => draftChains.get(draftId) === done && draftChains.delete(draftId));
      let answer;
      try {
        answer = await answerWithin(started.then(() => request));
      } catch (err) {
        if (request) throw err;
        cancelled = true;
        throw Object.assign(new Error('the action before it on this draft was still going, so this one wasn’t sent'), { body: { error: 'the action before it on this draft was still going, so this one wasn’t sent' } });
      }
      // Done: the server has it. Other actions on the same draft keep theirs.
      endAct(draftId, act);
      // The draft as the coordinator now has it comes back with the answer: shown at once (with any later action on
      // its way over it), so it can't sit at "Sending…" if the read after fails (Codex review on #671).
      if (answer?.draft?.id === draftId) {
        confirmedDrafts.set(draftId, answer.draft);
        const now = state.coordinator;
        const pending = draftActs.get(draftId) || [];
        const shown = pending.length ? pending.at(-1).apply(answer.draft) : answer.draft;
        if (now?.projectId === projectId && now.view?.drafts) set({ coordinator: { ...now, view: { ...now.view, drafts: now.view.drafts.map((d) => (d.id === draftId ? shown : d)) } } });
      }
      toast(DRAFT_TOASTS[action]);
    } catch (err) {
      endAct(draftId, act);
      restore();
      toast(`Couldn’t ${action === 'drop' ? 'drop' : 'send'} that: ${err.body?.error || err.message}`, { sticky: true, actions: [{ label: 'Retry', fn: () => coordinatorDraft(projectId, draftId, action, text) }] });
    }
    loadCoordinator(projectId);
  }
  function setSideTab(sideTab) {
    storageSet('sideTab', sideTab);
    set({ sideTab });
  }
  /** Opens the conversation's right panel on a tab (Mail from a backstage line): the sheet on a phone. */
  function openSideTab(sideTab, { phone = false, docked = true } = {}) {
    setSideTab(sideTab);
    if (phone) return set({ sheet: { kind: 'links' } });
    if (!docked) return set({ convoFlyout: 'right' });
    if (!state.convoPanels.right) togglePanel('right', true);
  }

  async function loadFacets() {
    if (!client.facets) return;
    try {
      const facets = await client.facets();
      set({ facets, facetsLoaded: true });
    } catch (err) {
      set({ facetsLoaded: true });
      console.warn('[desk] facets failed', err.message);
    }
  }
  /** Opens Settings, on a page (else the one it was last on) and maybe a sub-page of it. */
  // ── what this window is for (role.js) ──
  function applyRole(value) {
    const role = roleOf(value);
    if (role === state.role) return;
    // The URL keeps it: a reload, a bookmark or the next connect opens the same way.
    if (typeof history !== 'undefined') history.replaceState(history.state, '', urlWithRole(location.href, role));
    set({ role });
    if (role === 'screen') loadFeed();
    // The hub stream reconnects with it now: the browser's own retries would reuse the old address (Codex review on #571).
    client.restartScreenStream?.();
  }

  function applyFeedScope(value) {
    const feedScope = feedScopeOf(value);
    if (typeof history !== 'undefined') {
      const url = new URL(location.href);
      if (feedScope === 'everything') url.searchParams.delete('feedScope');
      else url.searchParams.set('feedScope', feedScope);
      history.replaceState(history.state, '', url.toString());
    }
    set({ feedScope, feed: { posts: [], loaded: false } });
    loadFeed({ settle: true });
  }

  async function setWindowFeedScope(scope, windowId = null) {
    const feedScope = feedScopeOf(scope);
    if (!windowId || windowId === state.screenId) applyFeedScope(feedScope);
    const id = windowId || state.screenId;
    if (id) {
      try { await client.setScreenFeedScope(id, feedScope); }
      catch (err) { toast(`Couldn’t change that window: ${err.message}`); }
    }
  }

  /** Sets what a window is for: this one (no id, or its own), or another connected window. */
  async function setWindowRole(role, windowId = null) {
    if (!windowId || windowId === state.screenId) {
      // Its reconnect tells the hub (with no stream to restart, say it directly).
      applyRole(role);
      if (!client.restartScreenStream && state.screenId) client.setScreenRole?.(state.screenId, roleOf(role)).catch(() => {});
      return;
    }
    try {
      await client.setScreenRole(windowId, roleOf(role));
    } catch (err) {
      toast(`Couldn’t change that window: ${err.message}`);
    }
  }

  /** Opens a Screen window (drag it to the other monitor): what agents show goes there. */
  function openScreenWindow() {
    const url = new URL(urlWithRole(location.href, 'screen'));
    url.searchParams.delete('name');
    const opened = window.open(url.toString(), `tango-screen-${Date.now()}`, 'popup=yes,width=1280,height=800');
    if (!opened) toast('The browser blocked the new window: allow pop-ups for the desk');
  }

  function openSettings(page = null, sub = null) {
    set({ filterOpen: true, settingsPage: page || state.settingsPage || 'device', settingsSub: sub });
    loadFacets();
  }
  const openFilters = () => openSettings();
  /** Lucide icon names for a search in Settings' icon picker; none when the desk can't say. */
  async function searchIcons(query) {
    try {
      return (await client.icons(query)).icons || [];
    } catch {
      return [];
    }
  }
  function closeFilters() {
    set({ filterOpen: false, settingsSub: null });
  }
  /**
   * Optimistic: the panel flips at once, the lists refresh when the server has it; a failure rolls back.
   * Resolves true once saved. Only the newest change may touch `filters` when it settles: a later
   * save, or a `settings` event from any screen (which advances filterSeq), supersedes it.
   */
  async function saveFilters(next) {
    const before = state.filters;
    const seq = ++filterSeq;
    set(predict('mutes', { filters: before }, { filters: normalizeFilters(next) }));
    try {
      const json = await settingsInOrder({ filters: state.filters });
      if (seq === filterSeq) set({ filters: normalizeFilters(json.filters) });
      refreshLists(0);
      if (state.filterOpen) loadFacets();
      return true;
    } catch (err) {
      if (seq === filterSeq) set({ filters: before });
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      toast(`Mute didn’t save: ${err.body?.error || err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => saveFilters(next) } });
      return false;
    }
  }
  const toggleFilter = (facet, value) => saveFilters(flipFilter(state.filters, facet, value));
  const clearFilters = () => saveFilters({ ...NO_FILTERS });
  /** Show: announced only once the save went through (a failure rolls back and says so). */
  const showFiltered = async (matches) => {
    const saved = await saveFilters(withoutMatches(state.filters, matches));
    if (saved) toast('Unmuted');
    return saved;
  };

  // ── detail (Conversation view) ─────────────────────────────────────
  let detailRead = 0;
  async function loadDetail(id) {
    const read = ++detailRead;
    if (!id) return set({ detail: null });
    const startedAt = projectTick();
    if (state.detail?.id !== id) set({ detail: { id, loading: true, item: state.byId[id] || null, messages: [], timeline: [], beats: [], reply: null, sinceOwner: null, laterNotes: null, backstage: null, mail: [], queued: [], scenes: [], prototypes: [] } });
    try {
      const json = await client.item(id);
      if (state.detail?.id !== id || read !== detailRead) return;
      const item = json.item || json; // tolerate `{...item, messages}` as well as `{ item, messages }`
      const scenes = json.scenes || [];
      const cache = { ...state.scenes };
      for (const s of scenes) cache[s.id] = { ...cache[s.id], ...s };
      rawDetail = { id, item, from: startedAt };
      state.detail = { id, loading: false, item, messages: json.messages || [], timeline: json.timeline || [], beats: json.beats || [], reply: json.reply === undefined ? undefined : json.reply, sinceOwner: json.sinceOwner || null, laterNotes: json.laterNotes || null, backstage: json.backstage || null, mail: json.mail || [], mailDrafts: mergeMailDrafts(id, json.mailDrafts || []), queued: json.queued || [], ownerReceipts: json.ownerReceipts || [], receiptCommandIds: json.receiptCommandIds || [], scenes, prototypes: json.prototypes || [] };
      const confirmed = new Set([...(json.receiptCommandIds || []), ...(json.ownerReceipts || []).map(r => r.commandId).filter(Boolean)]);
      state.ownerReceipts = state.ownerReceipts.filter(r => r.itemId !== id || !confirmed.has(r.commandId));
      saveReceipts(state.ownerReceipts);
      state.scenes = cache;
      settleOverlays();
      notify();
    } catch (err) {
      if (state.detail?.id === id && read === detailRead) set({ detail: { ...state.detail, loading: false, error: err.message } });
    }
  }

  // ── presentation ───────────────────────────────────────────────────
  // This window's own moves, in order. While its newest one is still on the way, what the hub sends is older than
  // what the owner asked for: a slow server let an earlier move (Send's "back to the board") land after the owner
  // had opened the next thread, and it won. The newest broadcast meanwhile is kept and weighed against the answer.
  const windowId = `w-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  let presentSeq = 0;
  let presentAnswered = 0;
  let presentSentAt = 0;
  let heldPresentation = null;
  let holdTimer = null;
  const PRESENT_HOLD_MS = 20_000;
  const presentInFlight = () => presentAnswered < presentSeq && Date.now() - presentSentAt < PRESENT_HOLD_MS;
  function releaseHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    const held = heldPresentation;
    heldPresentation = null;
    return held;
  }

  /** The hub's presentation from the stream or a reread: held while this window's newest move is on the way. */
  function receivePresentation(p) {
    if (!p || !p.view) return;
    if (presentInFlight()) {
      if (!heldPresentation || !(p.since < heldPresentation.since)) heldPresentation = p;
      // A move that never answers doesn't hold the window for good (Codex review on #642).
      if (!holdTimer) holdTimer = setTimeout(() => receivePresentation(releaseHold()), Math.max(0, presentSentAt + PRESENT_HOLD_MS - Date.now()) + 1);
      return;
    }
    releaseHold();
    applyPresentation(p);
  }

  /** The answer to this window's move `seq`: only the newest counts, and a later move by another screen still wins. */
  function presentAnswer(seq, answer) {
    presentAnswered = Math.max(presentAnswered, seq);
    if (seq !== presentSeq) return;
    // The service answers `{ applied, presentation }`; fixtures, the presentation itself (Codex review on #642).
    const p = answer?.presentation ?? answer;
    const held = releaseHold();
    applyPresentation(held && p?.since && held.since > p.since ? held : p || held);
  }

  function applyPresentation(p) {
    if (!p || !p.view) return;
    if (p.since && state.presentation.since && p.since < state.presentation.since && p.by === state.presentation.by) return;
    set({ presentation: { queue: [], ...p } });
    const itemId = p.view === 'active' ? null : p.itemId;
    if (itemId && state.detail?.id !== itemId) loadDetail(itemId);
    if (p.sceneId && !state.scenes[p.sceneId]) resolveScene(p.sceneId);
  }

  async function resolveScene(id) {
    try {
      const scene = await client.scene(id);
      set({ scenes: { ...state.scenes, [id]: { ...state.scenes[id], ...scene } } });
      return scene;
    } catch {
      /* the scene is gone; the Screen view says so */
      return null;
    }
  }

  function present(intent) {
    // A move of this window's ends any idle (hub.ts idleScreens), as the hub's answer will say.
    const optimistic = { ...state.presentation, ...intent, by: 'screen', since: Date.now(), stageIdle: false };
    if (intent.view === 'active') Object.assign(optimistic, { itemId: null, conversationKey: null, sceneId: null, prototypeId: null, prototype: null });
    if (intent.view === 'conversation') Object.assign(optimistic, { sceneId: null, prototypeId: null, prototype: null });
    if (intent.view === 'screen') Object.assign(optimistic, { prototypeId: null, prototype: null });
    if (intent.view === 'prototype') {
      const known = knownPrototypes();
      Object.assign(optimistic, { sceneId: null, prototype: known.find((x) => x.id === intent.prototypeId) || null });
    }
    applyPresentation(optimistic);
    const seq = ++presentSeq;
    presentSentAt = Date.now();
    // The hub refuses a move of this window's that lands after a newer one (hub.ts staleMove).
    client.present({ ...intent, window: { id: windowId, seq, ...(state.screenId ? { screenId: state.screenId } : {}) } }).then(
      (p) => presentAnswer(seq, p),
      (err) => {
        if (err.status !== 404) console.warn('[desk] presentation failed', err.message);
        presentAnswered = Math.max(presentAnswered, seq);
        if (seq !== presentSeq) return;
        // Refused (a prototype or scene that's gone): take back the optimistic view.
        if (err.status === 404 || err.status === 409) client.presentation().then(receivePresentation, () => {});
        else receivePresentation(releaseHold());
      },
    );
  }

  function openItem(id) {
    const item = state.byId[id];
    set({ focusId: id, sheet: null });
    present({ view: 'conversation', itemId: id, conversationKey: item?.conversationKey ?? null });
  }
  function goBoard() {
    set({ replyOpen: null, snoozeFor: null, confirm: null, sheet: null, convoFlyout: null });
    present({ view: 'active' });
  }
  function setListTab(listTab) {
    storageSet('listTab', listTab);
    set({ listTab });
  }
  /** Opens one of the owner's projects in the List (null: back to the List); this device remembers it. */
  function openProject(listProject) {
    storageSet('listProject', listProject || '');
    set({ listProject: listProject || null, listMenu: null });
  }
  /** Home: out of any project, back to the first of the owner's views. */
  function goListHome(firstTab) {
    openProject(null);
    if (firstTab) setListTab(firstTab);
  }
  function setListGroup(listGroup) {
    storageSet('listGroup', listGroup);
    set({ listGroup });
  }
  function toggleListSection(key) {
    const open = !state.listCollapsed.includes(key);
    const listCollapsed = open ? [...state.listCollapsed, key] : state.listCollapsed.filter((k) => k !== key);
    storageSet('listCollapsed', JSON.stringify(listCollapsed));
    set({ listCollapsed });
  }
  function toggleWorkers(id) {
    const workersOpen = state.workersOpen.includes(id) ? state.workersOpen.filter((k) => k !== id) : [...state.workersOpen, id];
    storageSet('workersOpen', JSON.stringify(workersOpen));
    set({ workersOpen });
  }
  /** The owner's label for the List view: a Loom thread is renamed in Loom, anything else keeps it on the desk. */
  async function setLabel(itemId, label) {
    return command('label', itemId, { label: label || null });
  }
  /** Pins or unpins: a Loom thread in Loom's sidebar, anything else on the desk. The List view shows pins first. */
  /** The owner's type, kept on the desk (null clears). */
  async function setTags(itemId, tags) {
    return command('tag', itemId, tags);
  }
  /** A conversation's kind (docs/specs/spaces.md): thread, job (ops), worker or its space's default. */
  async function setRole(itemId, role, parentItemId) {
    const result = await command('role', itemId, { role, ...(parentItemId !== undefined ? { parentItemId } : {}) });
    if (result?.status === 'sent') toast({ interactive: 'Now a thread: it talks with you', ops: 'Now a job: it runs on a schedule and reports to its space', worker: 'Now a worker: it reports to the thread that started it', default: 'Now this space’s default conversation' }[role] || 'Changed');
    return result;
  }
  async function handOff(itemId, role, parentItemId) {
    const owner = findItem(state.lists, parentItemId);
    const result = await command('role', itemId, { role, parentItemId, follow: true });
    if (result?.status === 'sent') {
      const space = result.outcome?.movedTo;
      const name = space?.startsWith('project:') ? state.projects.find((p) => p.id === space.slice(8))?.name
        : space?.startsWith('agent:') ? owner?.facts?.agentSpace?.name || owner?.agentName : 'No project';
      toast(`Now a ${role === 'ops' ? 'job' : 'worker'} · reports to ${owner ? ownerName(owner) : parentItemId}${'movedTo' in (result.outcome || {}) ? ` · moved to ${name || space}` : ''}`);
    }
    return result;
  }
  /** "Keep this session" (Loom): no automatic fresh session for this thread until switched back. */
  async function keepSession(itemId, keep) {
    const result = await command('keep', itemId, { keep });
    if (result?.status === 'sent') toast(keep ? 'Keeping this session: Loom won’t start it fresh on its own' : 'Loom may start this session fresh again');
    return result;
  }
  /** The daily budget's Raise: +50% for today, and a thread held by it goes again. */
  async function raiseBudget(itemId) {
    const result = await command('raise', itemId);
    if (result?.status === 'sent') toast('Budget raised for today');
    return result;
  }
  /** The thread's next turn opens a new session from its handoff and Loom's record. */
  async function freshStart(itemId) {
    const result = await command('fresh', itemId);
    if (result?.status === 'sent') toast('The next turn starts a fresh session');
    return result;
  }
  /** Into an agent's space ({ id, name }), or out of it (null). */
  async function setAgentSpace(itemId, agent) {
    return command('space', itemId, { agent });
  }
  /** Out of the rotation until picked up (a snooze with no wake-up). */
  function park(itemId) {
    // From Snoozed: refused if the agent posted since the menu opened (it came back with news; Codex review on #498).
    return command('park', itemId, asSeen(itemId));
  }
  /** The desk watches (or stops watching) a PR's review; on approval the agent is woken in its conversation. */
  async function watchPr(itemId, url, on) {
    const result = await command('watch', itemId, { url, off: !on });
    if (result?.status === 'sent') toast(on ? 'Watching the review: the agent picks it back up when it’s approved' : 'Stopped watching the review');
    return result;
  }
  /** Renames a conversation: a Loom thread in Loom, anything else on the desk (an empty name goes back to its own). */
  async function rename(itemId, title) {
    return command('rename', itemId, { title });
  }
  async function setPinned(itemId, pinned) {
    return command('pin', itemId, { pinned: !!pinned });
  }
  /**
   * Closes a conversation (an item id) or a project (`project:<id>`) to agent mail and agents starting
   * threads from it, or opens it again (desk/mail.ts).
   */
  // Agent mail, as projects: the desk's confirmed list with this screen's toggles on their way over it. An unrelated
  // settings event can't wipe a toggle in flight, and a rollback never lands on another's unconfirmed state.
  let confirmedMail = null;
  const pendingMail = new Map(); // key -> { off }: the newest toggle on its way for it
  const withPendingMail = (list) => {
    let out = [...(list || [])];
    for (const [key, { off }] of pendingMail) out = off ? [...new Set([...out, key])] : out.filter((k) => k !== key);
    return out;
  };
  function confirmMail(list) {
    confirmedMail = list || [];
    return withPendingMail(confirmedMail);
  }
  async function setMailOff(key, off) {
    const toggle = { off: !!off };
    if (confirmedMail === null) confirmedMail = state.mailOff || [];
    pendingMail.set(key, toggle);
    set({ mailOff: withPendingMail(confirmedMail) });
    const done = () => pendingMail.get(key) === toggle && pendingMail.delete(key);
    try {
      const json = await inLine(`mail:${key}`, () => client.mailOff({ ...(key.startsWith('project:') ? { projectId: key.slice('project:'.length) } : { itemId: key }), off: !!off }));
      done();
      set({ mailOff: confirmMail(json.off || []) });
      toast(off ? 'Agents can’t mail it now' : 'Agents can mail it again');
    } catch (err) {
      done();
      // A lost answer may have been saved: read what the desk has rather than guess.
      set({ mailOff: withPendingMail(confirmedMail) });
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      toast(`Didn’t change agent mail: ${err.message || 'unknown error'}`);
    }
  }

  /** Moves a conversation into one of the owner's projects (null: out of its project). */
  async function setProject(itemId, projectId, parentItemId) {
    const result = await command('project', itemId, { projectId: projectId || null, ...(parentItemId ? { parentItemId } : {}) });
    if (result?.status === 'sent') {
      const item = findItem(state.lists, itemId);
      const destination = item ? homeOf({ ...item, facts: { ...item.facts, projectId } }, state.projects) : null;
      const name = state.projects.find((p) => p.id === projectId)?.name || (destination?.kind === 'agent' ? destination.name : null);
      const outcome = result.outcome || {};
      const owner = findItem(state.lists, parentItemId || outcome.parentItemId);
      const moved = name ? `Moved to ${name}` : parentItemId || 'previousParentItemId' in outcome ? 'Moved to No project' : 'Out of its project';
      toast(parentItemId ? `${moved} · reports to ${owner ? ownerName(owner) : parentItemId}` : 'previousParentItemId' in outcome ? `${moved} · ${owner ? `now reports to ${ownerName(owner)}` : 'reports to no one yet'}` : moved);
    }
    return result;
  }
  // ── a whole project at once: each conversation in it, through its own command ──

  /**
   * The project's open conversations in the given dispositions, from the lists the desk loads. Everything
   * holds what the owner's filters and inbox rules keep out of Active: a whole project means those too (Codex review on #522).
   */
  function projectItems(projectId, dispositions) {
    const byId = new Map();
    for (const key of ['active', 'snoozed', 'everything']) for (const item of state.lists[key]?.items || []) if (!byId.has(item.id)) byId.set(item.id, item);
    return [...byId.values()].filter((item) => item.facts?.projectId === projectId && dispositions.includes(item.disposition));
  }
  const projectName = (projectId) => state.projects.find((p) => p.id === projectId)?.name || 'the project';
  const stayedNote = (stayed) => (stayed ? ` · ${stayed} still working, left as ${stayed === 1 ? 'it is' : 'they are'}` : '');
  /**
   * A whole project at once, done by the desk from its own state (one call, never a screen's stale
   * snapshot; Codex review on #522). A running turn stays as it is; the toast says how many.
   */
  // ── projects: what the desk confirmed, with this screen's changes on their way over it (as items' overlays) ──
  // Every source of truth (a read, a stream, a save's answer) replaces the confirmed list, unless something newer
  // came first; what shows is always that list with the changes still on their way applied in order. A change that
  // fails just leaves the stack, so a rollback can never land on another change's unconfirmed state (Codex review on #671).
  let confirmedProjectList = null; // null: not heard from the desk yet
  const projectChains = new Map(); // projectId -> its newest action's request: the next one waits for it
  let projectClock = 0; // orders asks, answers and streams exactly (a millisecond clock ties)
  const projectTick = () => ++projectClock;
  let confirmedFrom = 0; // when (projectClock) the newest confirmed list was asked for (a stream: when it came)
  const projectActs = []; // [{ apply(list) -> list, settledAt }]: oldest first
  function showProjects(extra = {}) {
    const base = confirmedProjectList ?? state.projects;
    set({ projects: projectActs.reduce((list, act) => act.apply(list), base), ...extra });
  }
  /** A list from the desk, as of `from`: kept unless a newer one came; changes it already carries leave the stack. */
  function confirmProjects(projects, rev, from) {
    if (!Array.isArray(projects) || from < confirmedFrom) return false;
    confirmedProjectList = projects;
    confirmedFrom = from;
    for (const act of [...projectActs]) if (act.settledAt !== null && act.settledAt <= from) projectActs.splice(projectActs.indexOf(act), 1);
    showProjects({ ...(rev != null ? { projectsRev: rev } : {}), projectsLoaded: true });
    return true;
  }
  /** A change shown at once over the confirmed list: its `apply` runs on whatever the list is when shown. */
  function projectAct(apply, kind = 'action') {
    if (confirmedProjectList === null) confirmedProjectList = state.projects; // what shows is the base until the desk says
    const act = { apply, kind, settledAt: null };
    projectActs.push(act);
    showProjects();
    return act;
  }
  function endProjectAct(act) {
    const at = projectActs.indexOf(act);
    if (at >= 0) projectActs.splice(at, 1);
    showProjects();
  }
  /** Answered: kept until a list read after the answer carries it, and at most OVERLAY_MAX_MS. */
  function settleProjectAct(act) {
    act.settledAt = projectTick();
    setTimeout(() => endProjectAct(act), OVERLAY_MAX_MS);
  }
  /** The projects as the desk has them now (after an action): a read that a newer stream outranks. */
  function reloadProjects() {
    const from = projectTick();
    client.settings?.().then((json) => confirmProjects(json.projects, json.projectsRev, from)).catch(() => {});
  }
  async function projectAction(projectId, body) {
    // Optimistic, as every command: the project shows away, back or finished at the tap, and so do its conversations.
    const at = Date.now();
    const predicted = (p) =>
      body.action === 'wake' ? { ...p, away: null } : body.action === 'finish' ? { ...p, away: null, finishedAt: at } : { ...p, away: { state: body.action === 'park' ? 'parked' : 'snoozed', at, ...(body.until != null ? { until: body.until } : {}), ...(body.trigger ? { trigger: body.trigger } : {}) } };
    const original = state.projects.find((p) => p.id === projectId) || null;
    const shown = original ? predicted(original) : null;
    // Its open child projects (docs/specs/spaces.md, Nesting): finishing with it, or kept open and moved up to where it
    // is; away, it holds the ones not away on their own (projects.ts holderOf).
    const kids = state.projects.filter((p) => p.parent === `project:${projectId}` && !p.finishedAt);
    const ending = new Set([projectId, ...(body.action === 'finish' && body.children === 'finish' ? kids.map((k) => k.id) : [])]);
    const kept = body.action === 'finish' && body.children !== 'finish' ? new Set(kids.map((k) => k.id)) : new Set();
    const moveUp = (p) => {
      const { parent: _parent, ...rest } = p;
      return original?.parent?.startsWith('agent:') ? { ...rest, parent: original.parent } : rest;
    };
    const act = projectAct((list) => list.map((p) => (p.id === projectId || (body.action === 'finish' && ending.has(p.id)) ? predicted(p) : kept.has(p.id) ? moveUp(p) : p)));
    // Its conversations follow at the tap too: held while it is away, back when it wakes, done or on their own when
    // it finishes; a running turn is never touched (core.ts projectAction / withProjectHold; Codex review on #671).
    const heldKids = body.action === 'finish' ? [...ending].filter((id) => id !== projectId) : body.action === 'wake' ? kids.map((k) => k.id) : kids.filter((k) => !k.away).map((k) => k.id);
    const mine = [projectId, ...heldKids].flatMap((id) => projectItems(id, ['active', 'snoozed', 'parked']));
    // Where `out` moves a conversation: up to the enclosing project when that stays open, else out of every project.
    const upTo = (item) => {
      const from = state.projects.find((p) => p.id === item.facts?.projectId);
      const parent = from?.parent?.startsWith('project:') ? from.parent.slice(8) : null;
      return parent && !ending.has(parent) && !state.projects.find((p) => p.id === parent)?.finishedAt ? parent : null;
    };
    // As the desk tests it (core.ts projectAction): a turn waiting on a question isn't working (Codex review on #671).
    const running = (item) => item.nextStep === 'working';
    const moves = mine.map((item) => {
      if (body.action === 'wake') return item.heldBy === projectId ? overlayWith(item.id, (it) => ({ ...it, disposition: 'active', snoozeUntil: null, snoozeTrigger: null, heldBy: null })) : null;
      if (body.action === 'finish') {
        // The project is no longer away: whatever it held is its own again (Codex review on #671).
        const release = (it) => (it.heldBy === projectId ? { ...it, disposition: 'active', snoozeUntil: null, snoozeTrigger: null, heldBy: null } : it);
        // A running turn stays in the finished project either way, as the desk does it (Codex review on #671).
        if (running(item)) return item.heldBy === projectId ? overlayWith(item.id, release) : null;
        if (body.how === 'out') return overlayWith(item.id, (it) => ({ ...release(it), facts: { ...(it.facts || {}), projectId: upTo(it) } }));
        return overlayWith(item.id, (it) => predict('done', it));
      }
      // Away: every conversation in rotation is held, a running one too (desk-projects.test.ts; Codex review on #671).
      const away = shown?.away;
      // Rows it already holds take the new away state too (snoozed ↔ parked, a new time; Codex review on #671).
      return away && (item.disposition === 'active' || item.heldBy === projectId) ? overlayWith(item.id, (it) => ({ ...it, disposition: away.state, snoozeUntil: away.until ?? null, snoozeTrigger: away.trigger ?? null, heldBy: projectId })) : null;
    });
    let request; // set once it has gone
    let cancelled = false; // its deadline passed while it waited its turn: it never goes
    try {
      // One project's actions reach the desk in the order tapped (Park then Wake ends awake), and so do they and its
      // conversations' own commands: this waits for any on its way, and theirs tapped after wait for it (Park, then
      // Pick up one of them, ends picked up; Codex review on #671).
      // Members as the desk has them too (a move out tapped just before is still in it there; Codex review on #671).
      const members = new Set(mine.map((item) => item.id));
      for (const view of LIST_VIEWS) for (const item of rawLists[view] || []) if (item.facts?.projectId === projectId || heldKids.includes(item.facts?.projectId)) members.add(item.id);
      // ...and after a save still creating or changing it (Codex review on #671).
      const ahead = [projectChains.get(projectId), projectActs.some((a) => a.kind === 'save') ? projectSaves : null, ...[...members].map((id) => itemChains.get(id))].filter(Boolean);
      const go = () => {
        if (!cancelled) request = client.projectAction(projectId, body);
      };
      const started = ahead.length ? Promise.all(ahead).then(go) : (go(), Promise.resolve());
      const done = started.then(() => answerWithin(request, ORDER_HOLD_MS)).catch(() => {});
      projectChains.set(projectId, done);
      done.finally(() => projectChains.get(projectId) === done && projectChains.delete(projectId));
      for (const id of members) {
        itemChains.set(id, done);
        done.finally(() => itemChains.get(id) === done && itemChains.delete(id));
      }
      // The deadline counts from the tap, the wait for its turn included (Codex review on #671).
      const result = await answerWithin(started.then(() => request));
      settleAfter(moves);
      settleProjectAct(act);
      refreshLists(0);
      reloadProjects();
      return result;
    } catch (err) {
      endProjectAct(act);
      for (const o of moves) if (o) dropOverlay(o);
      if (!request) {
        // Never went: an action before it was still going. Nothing reached the desk, so a plain Retry.
        cancelled = true;
        toast(`${projectName(projectId)}: the action before it was still going, so this one wasn’t sent.`, { sticky: true, actions: [{ label: 'Retry', fn: () => projectAction(projectId, body) }] });
        return null;
      }
      // No answer from the desk: it may have acted, and a project action has no replay, so no blind Retry (Codex review on #671).
      const lost = !err.body;
      if (lost) {
        // Read what the desk has now, and again once the stalled request really ends (Codex review on #671).
        const reconcile = () => (reloadProjects(), refreshLists(0));
        reconcile();
        Promise.resolve(request).finally(reconcile).catch(() => {});
      }
      toast(lost ? `${projectName(projectId)}: the desk didn’t answer, so it may have changed. It shows as it was; check before trying again.` : `${projectName(projectId)}: ${err.body?.error || err.message || 'network error'}`, { sticky: true, actions: lost ? [] : [{ label: 'Retry', fn: () => projectAction(projectId, body) }] });
      return null;
    }
  }
  /**
   * Snooze for a project as a whole: the picker, then the project is snoozed. Its conversations keep their
   * own state (done stays done, a snooze keeps its time); the ones in rotation are held until it wakes.
   */
  function openProjectSnooze(projectId) {
    set({ snoozeFor: `project:${projectId}`, snoozeGuard: null, listMenu: null });
  }
  const heldNote = (held, until = 'until then') => (held ? ` · ${held} held ${until}; the rest keep their own state` : ' · nothing in rotation to hold');
  async function snoozeProject(projectId, choice) {
    const result = await projectAction(projectId, choice.type === 'park' ? { action: 'park' } : { action: 'snooze', ...choice.args });
    if (result) toast(`${choice.type === 'park' ? 'Parked' : 'Snoozed'} ${projectName(projectId)}${choice.type === 'park' ? '' : ` · ${choice.label.toLowerCase()}`}${heldNote(result.held, choice.type === 'park' ? 'until you wake it' : 'until then')}`);
  }
  /** Parks a project as a whole: held out of the rotation until it's woken (or one of its conversations has news). */
  async function parkProject(projectId) {
    set({ listMenu: null });
    const result = await projectAction(projectId, { action: 'park' });
    if (result) toast(`Parked ${projectName(projectId)}${heldNote(result.held, 'until you wake it')}`);
  }
  /** Ends a project's snooze or park: what it held is back in the rotation, as each one was. */
  async function wakeProject(projectId) {
    set({ listMenu: null, snoozeFor: null });
    const result = await projectAction(projectId, { action: 'wake' });
    if (result) toast(`${projectName(projectId)} is back`);
  }
  /**
   * Finishes a project: it goes to History. Its open conversations are marked done (`done`), or taken
   * out of it and listed on their own (`out`). A running turn is never marked done; it stays in the project.
   */
  async function finishProject(projectId, how, children) {
    set({ confirm: null, listMenu: null });
    const name = projectName(projectId);
    if (state.listProject === projectId) openProject(null);
    const result = await projectAction(projectId, { action: 'finish', how, ...(children ? { children } : {}) });
    if (!result) return;
    const kids = result.finished ? ` with ${result.finished} project${result.finished === 1 ? '' : 's'}` : result.keptOpen ? ` · ${result.keptOpen} project${result.keptOpen === 1 ? '' : 's'} kept open` : '';
    const inside = state.projects.find((p) => p.id === projectId)?.parent?.startsWith('project:');
    toast(`Finished ${name}${kids}${result.acted ? ` · ${result.acted} ${how === 'out' ? (inside ? 'moved up' : 'listed on their own') : 'done'}` : ''}${stayedNote(result.stayed)}`);
  }
  /**
   * Puts a project inside another space (docs/specs/spaces.md, Nesting): `project:<id>`, `agent:<id>`, or null for the
   * person's own space. Its threads stay in it, so their breadcrumbs follow. Resolves to an error, or null.
   */
  async function setProjectParent(projectId, parent) {
    const err = await saveProjects((list) => list.map((p) => {
      if (p.id !== projectId) return p;
      const { parent: _old, ...rest } = p;
      return parent ? { ...rest, parent } : rest;
    }));
    if (err) toast(`${projectName(projectId)} didn’t move: ${err}`, { sticky: true, actions: [{ label: 'Retry', fn: () => setProjectParent(projectId, parent) }] });
    return err;
  }
  /** Back from History: the project is open again. */
  async function reopenProject(projectId) {
    // Inside a parent that has finished, or moved into another space meanwhile: it reopens at the top.
    const reopened = (p, list) => {
      const up = p.parent?.startsWith('project:') ? list.find((q) => q.id === p.parent.slice(8)) : null;
      const { parent: _parent, ...rest } = p;
      return { ...(p.parent?.startsWith('project:') && (!up || up.finishedAt || up.parent) ? rest : p), finishedAt: null };
    };
    const err = await saveProjects((list) => list.map((p) => (p.id === projectId ? reopened(p, list) : p)));
    if (err) toast(`Didn’t reopen: ${err}`);
  }
  /**
   * The owner's projects, whole; every screen gets them. `change` is the new list, or better a function from the
   * list to the new one: it then applies over whatever the desk confirms meanwhile. Resolves to an error, or null.
   */
  let projectSaves = Promise.resolve(); // the newest save: the next one waits for it
  async function saveProjects(change) {
    const apply = typeof change === 'function' ? change : () => change;
    const act = projectAct(apply, 'save');
    // One at a time, each from the list and revision the last one's answer left: two saves sent with the same
    // revision would make the desk refuse the second though both were meant (Codex review on #671).
    const turn = projectSaves.catch(() => {}).then(() => sendProjectSave(act));
    projectSaves = turn;
    return turn;
  }
  async function sendProjectSave(act) {
    let from = projectTick();
    // What's sent: the desk's list with this save (and any before it) applied, never a project action's prediction
    // (it goes through its own endpoint; saving its predicted state first would make the desk refuse it; Codex review on #671).
    // Built as it goes, not when queued: the list and revision the save before it left (Codex review on #671).
    const body = () => {
      from = projectTick(); // its place in the order is when it goes (Codex review on #671)
      const saves = projectActs.filter((a) => a.kind === 'save');
      const payload = saves.slice(0, saves.indexOf(act) + 1).reduce((list, a) => a.apply(list), confirmedProjectList ?? state.projects);
      return { projects: payload, projectsRev: state.projectsRev };
    };
    try {
      const json = await settingsInOrder(body);
      // Its answer is the desk's list with this change in it; a newer stream (another screen) outranks it.
      endProjectAct(act);
      confirmProjects(json.projects, json.projectsRev, from);
      return null;
    } catch (err) {
      // Changed on another screen since this one read them: theirs stand. Either way this change leaves the stack.
      endProjectAct(act);
      if (Array.isArray(err.body?.projects)) confirmProjects(err.body.projects, err.body.projectsRev, projectTick());
      // No answer: it may have been saved (and the revision moved on). The desk's copy settles it (Codex review on #671).
      if (!err.body) void reconcileSettings();
      return err.body?.error || err.message || 'network error';
    }
  }
  /** The page's view pick belongs to this device, alongside its saved route. */
  function setPageView(key, id) {
    const nextPageViews = { ...state.nextPageViews, [key]: id };
    set({ nextPageViews });
    storageSet('nextPageViews', JSON.stringify(nextPageViews));
  }
  /** The views every project and agent page shows (one set for all; owner, 10/19). Saves optimistically; failures offer Retry. */
  async function saveSpaceViews(views) {
    const seq = ++spaceViewsSeq;
    const before = state.spaceViews;
    set({ spaceViews: views });
    spaceViewSaves += 1;
    try {
      const json = await settingsInOrder({ spaceViews: views });
      if (seq === spaceViewsSeq) set({ spaceViews: json.spaceViews || null });
      return null;
    } catch (err) {
      if (seq === spaceViewsSeq) set({ spaceViews: before });
      if (!err.body) void reconcileSettings();
      const error = err.body?.error || err.message || 'network error';
      toast(`Views didn’t save: ${error}`, { sticky: true, action: { label: 'Retry', fn: () => saveSpaceViews(views) } });
      return error;
    } finally {
      spaceViewSaves -= 1;
    }
  }
  /** The owner's Inbox views (null: built-ins); every screen gets them. */
  async function saveListViews(listViews) {
    // Overlapping saves (a quick reorder, another screen): only the newest answer applies (Codex review on #502).
    const seq = ++viewsSeq;
    const before = state.listViews;
    set({ listViews });
    viewSaves += 1;
    try {
      const json = await settingsInOrder({ listViews });
      if (seq === viewsSeq) set({ listViews: json.listViews || null });
      return null;
    } catch (err) {
      if (seq === viewsSeq) set({ listViews: before }); // refused: back to what the screen had
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      return err.body?.error || err.message || 'network error';
    } finally {
      viewSaves -= 1;
    }
  }
  /** The status sections every project's page hides unless it picks its own; every screen gets them. Resolves to an error, or null. */
  // Overlapping saves (quick checks, another screen): only the newest answer applies (Codex review on #596).
  let sectionsSeq = 0;
  async function saveProjectSectionsHidden(hidden) {
    const seq = ++sectionsSeq;
    const before = state.projectSectionsHidden;
    set({ projectSectionsHidden: hidden });
    try {
      const json = await settingsInOrder({ projectSectionsHidden: hidden });
      if (seq === sectionsSeq) set({ projectSectionsHidden: json.projectSectionsHidden || hidden });
      return null;
    } catch (err) {
      if (seq === sectionsSeq) set({ projectSectionsHidden: before });
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      return err.body?.error || err.message || 'network error';
    }
  }
  /** A space's own record (desk/spaces.ts), replaced whole; every screen gets it. Resolves to an error, or null. */
  const spaceSeqs = {};
  async function saveSpace(key, record) {
    const seq = (spaceSeqs[key] = (spaceSeqs[key] || 0) + 1);
    const before = state.spaces || {};
    set({ spaces: { ...before, [key]: record } });
    try {
      const json = await settingsInOrder({ spaces: { [key]: record } });
      if (seq === spaceSeqs[key] && json.spaces) set({ spaces: { ...state.spaces, [key]: json.spaces[key] } });
      return null;
    } catch (err) {
      if (seq === spaceSeqs[key]) {
        const spaces = { ...state.spaces };
        if (Object.hasOwn(before, key)) spaces[key] = before[key];
        else delete spaces[key];
        set({ spaces });
      }
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      return err.body?.error || err.message || 'network error';
    }
  }
  /** One project's hidden sections (null: back to the desk's default). */
  async function setProjectSections(projectId, hidden) {
    const err = await saveProjects((list) =>
      list.map((p) => {
        if (p.id !== projectId) return p;
        const { hiddenSections, ...rest } = p;
        return hidden ? { ...rest, hiddenSections: hidden } : rest;
      }),
    );
    if (err) toast(`Didn’t change its sections: ${err}`);
  }
  // Overlapping saves (quick reorders): the newest order shows while any is on its way; once none is, the order the
  // server confirmed last shows, whichever answered first or failed (Codex review on #671).
  let labelOrderSeq = 0; // streamed orders: a save answered after one came in is older than it
  let confirmedLabelOrder; // the order the server last said it has (undefined: not heard yet)
  let labelSaves = 0; // saves on their way
  let labelBatchBefore = null; // what showed before the first of them
  let labelBatchFailed = false;
  const labelSent = new Set(); // this batch's orders, as JSON: their streamed echoes aren't another screen's
  let labelSaveSeq = 0; // each save, in the order made
  let labelAccepted = 0; // the newest save whose answer was taken: an older one answering later doesn't count (Codex review on #671)
  async function saveLabelOrder(labelOrder) {
    if (labelSaves++ === 0) {
      labelBatchBefore = state.labelOrder;
      labelBatchFailed = false;
      labelSent.clear();
    }
    labelSent.add(JSON.stringify(labelOrder));
    const mine = ++labelSaveSeq;
    const streamed = labelOrderSeq;
    set({ labelOrder });
    try {
      const json = await settingsInOrder({ labelOrder });
      if (streamed === labelOrderSeq && mine > labelAccepted) {
        labelAccepted = mine;
        confirmedLabelOrder = json.labelOrder || null;
      }
      return null;
    } catch (err) {
      labelBatchFailed = true;
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      return err.body?.error || err.message || 'network error';
    } finally {
      if (--labelSaves === 0) {
        if (confirmedLabelOrder !== undefined) set({ labelOrder: confirmedLabelOrder });
        else if (labelBatchFailed) set({ labelOrder: labelBatchBefore });
      }
    }
  }
  /** The snooze presets in the owner's morning and evening times. */
  const snoozeChoices = (now = new Date()) => presetChoices(now, state.snoozeTimes);
  /** `{ morning?, evening? }` as "HH:MM"; every screen gets it. Resolves to an error, or null. */
  // Overlapping saves (another screen, a quick second change): only the newest answer applies.
  let snoozeTimesSeq = 0;
  async function saveSnoozeTimes(times) {
    const seq = ++snoozeTimesSeq;
    const before = state.snoozeTimes;
    set({ snoozeTimes: snoozeTimesOf({ ...before, ...times }) });
    try {
      const json = await settingsInOrder({ snoozeTimes: times });
      if (seq === snoozeTimesSeq) set({ snoozeTimes: snoozeTimesOf(json.snoozeTimes) });
      return null;
    } catch (err) {
      if (seq === snoozeTimesSeq) set({ snoozeTimes: before });
      if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
      return err.body?.error || err.message || 'network error';
    }
  }
  /** `{ agentId: { icon, color } | null }` (null goes back to the default); every screen gets it. */
  // Optimistic, so an icon then a color picked before the first save lands builds on the first
  // (Codex review on #546); only the newest answer applies.
  const saveAgentIcons = iconSaver('agentIcons', (agent) => agent);
  /** `{ repoName: { icon, color } | null }` (null goes back to the repo glyph); kept by the name in lower case. */
  const saveRepoIcons = iconSaver('repoIcons', (repo) => repo.trim().toLowerCase());
  // Per field; a settings event bumps it too, so an answer still in flight never overwrites another screen's newer map.
  const iconSeqs = { agentIcons: 0, repoIcons: 0 };
  function iconSaver(field, keyOf) {
    return async (icons) => {
      const mine = ++iconSeqs[field];
      const before = state[field];
      const next = { ...before };
      for (const [key, value] of Object.entries(icons)) {
        if (value === null) delete next[keyOf(key)];
        else next[keyOf(key)] = value;
      }
      set({ [field]: next });
      try {
        const json = await settingsInOrder({ [field]: icons });
        if (mine === iconSeqs[field]) set({ [field]: json[field] || {} });
        return null;
      } catch (err) {
        if (mine === iconSeqs[field]) set({ [field]: before });
        if (!err.body) void reconcileSettings(); // it may have been saved after all: the desk's copy settles it
        return err.body?.error || err.message || 'network error';
      }
    };
  }
  function showConversation() {
    const id = state.presentation.itemId || state.detail?.id || state.focusId;
    if (id) openItem(id);
  }
  /** `owner`: a screen a worker or job staged, opened from what it reports to: shown as the worker's, so a reply answers it. */
  function showScreen(sceneId, owner = null) {
    const p = state.presentation;
    const scene = sceneId || p.sceneId || state.detail?.scenes?.[0]?.id;
    if (!scene) return;
    const cached = state.scenes[scene];
    const queued = (p.queueScenes || []).find((q) => q.sceneId === scene);
    // A queued scene belongs to another conversation: the server makes that one current.
    if (queued) return present({ view: 'screen', sceneId: scene, conversationKey: queued.conversationKey });
    if (owner?.itemId) return present({ view: 'screen', sceneId: scene, itemId: owner.itemId, conversationKey: owner.conversationKey || null });
    present({ view: 'screen', sceneId: scene, itemId: p.itemId || cached?.itemId || null, conversationKey: p.conversationKey || cached?.conversationKey || null });
  }

  /** The hub's list when it sent one (even empty: the last one was cleared), else the open item's. */
  function knownPrototypes() {
    const p = state.presentation;
    if (Array.isArray(p.prototypes)) return p.prototypes;
    return state.detail?.id === p.itemId ? state.detail?.prototypes || [] : [];
  }

  /** The Prototype view: the given prototype, else the one up, else the conversation's newest. */
  function showPrototype(prototypeId, owner = null) {
    const p = state.presentation;
    const known = knownPrototypes();
    const id = prototypeId || p.prototypeId || known[0]?.id;
    if (!id) return;
    const chosen = known.find((x) => x.id === id);
    if (owner?.itemId) return present({ view: 'prototype', prototypeId: id, itemId: owner.itemId, conversationKey: owner.conversationKey || chosen?.conversationKey || null });
    present({ view: 'prototype', prototypeId: id, itemId: p.itemId || null, conversationKey: chosen?.conversationKey || p.conversationKey || null });
  }

  // ── commands ───────────────────────────────────────────────────────
  /**
   * Every desk command is optimistic by default: its predicted effect (optimistic.js) shows at the tap, the
   * request goes out behind it, and a failure takes the prediction back with a toast offering Retry and Open.
   * `quiet`: the caller words its own failure (failToast keeps the same Retry). `optimistic: false` waits for the server.
   */
  async function command(type, itemId, args = {}, { quiet = false, optimistic = true, commandId: reuse = null } = {}) {
    // `reuse`: a Retry after a lost answer sends the same id, so the desk replays what it did rather than doing it twice.
    const commandId = reuse || uuid();
    const overlay = optimistic ? addOverlay(type, itemId, args) : null;
    // Kept for the item's command line; the images themselves (megabytes of data URL) aren't.
    const entry = { commandId, type, itemId, args: args.attachments ? { ...args, attachments: args.attachments.length } : args, status: 'pending', at: Date.now() };
    if (type === 'reply') {
      const old = state.ownerReceipts.find(r => r.commandId === commandId);
      putReceipt({ commandId, itemId, text: args.text || `(${args.attachments?.length || 0} images)`, at: old?.at ?? entry.at, images: args.attachments?.length || 0, status: 'sending' });
    }
    set({ commands: { ...state.commands, [commandId]: entry } });
    let result;
    let request; // set once it has gone (a command queued behind another on its item goes when that one ends)
    let cancelled = false; // its deadline passed while it waited its turn: it never goes
    try {
      // A request that never answers counts as a lost answer, so its prediction can't stay up forever (Codex review on #671).
      // One item's commands reach the desk in the order tapped (Pin then Unpin ends unpinned): each waits for the one
      // before it on the same item; its own deadline starts when it goes (Codex review on #671).
      // A move into a project still being created waits for that save, or the desk wouldn't know it (Codex review on #671).
      const savingProjects = projectActs.some((a) => a.kind === 'save') ? projectSaves : null;
      const waits = [itemId ? itemChains.get(itemId) : null, type === 'project' && args.projectId ? savingProjects : null].filter(Boolean);
      const before = waits.length ? Promise.all(waits) : null;
      // The next one waits for this request itself to end, not just its deadline here: a slow request answered
      // after the deadline still lands before what was tapped after it (Codex review on #671). A request that never
      // ends at all holds the line at most ORDER_HOLD_MS.
      const go = () => {
        if (cancelled) return;
        // A guard left for now (GUARD_AT_SEND): the attention time the desk gave the command before it on this item.
        const sendArgs = args.ifStateAt === GUARD_AT_SEND ? withGuard(args, itemId) : args;
        request = client.command({ commandId, type, itemId, args: sendArgs }).then((r) => {
          if (itemId && r?.status !== 'failed' && typeof r?.outcome?.attentionAt === 'number') latestGuard.set(itemId, r.outcome.attentionAt);
          return r;
        });
      };
      // Resolves once it has gone (not when it answers); nothing ahead of it: it goes at once.
      const started = before ? before.then(go) : (go(), Promise.resolve());
      const done = started.then(() => answerWithin(request, ORDER_HOLD_MS)).catch(() => {});
      if (itemId) itemChains.set(itemId, done);
      done.finally(() => itemId && itemChains.get(itemId) === done && itemChains.delete(itemId));
      // The deadline counts from the tap, the wait for its turn included, so nothing predicted stays up past it
      // (Codex review on #671).
      result = await answerWithin(started.then(() => request));
    } catch (err) {
      if (!request) {
        // Never went: the command before it on this thread was still going. Nothing reached the desk, so a plain Retry.
        cancelled = true;
        result = { commandId, status: 'failed', error: 'the action before it on this thread was still going, so this one wasn’t sent' };
      } else {
        // No answer from the desk (a body means it answered): it may have acted before the connection went (Codex review on #671).
        result = { commandId, status: 'failed', error: err.body?.error || err.message || 'network error', ...(err.body ? {} : { transport: true }) };
      }
    }
    const status = result.status === 'failed' ? 'failed' : 'sent';
    const receipt = state.ownerReceipts.find(r => r.commandId === commandId);
    if (receipt) putReceipt({ ...receipt, status: status === 'sent' ? 'delivered' : result.transport || deliveryUnknown(result) ? 'uncertain' : 'failed' });
    if (overlay) {
      // The cap holds even if the refreshes after it fail: nothing else may come to settle it (Codex review on #671).
      if (status === 'sent') settleAfter([overlay]);
      else dropOverlay(overlay);
    }
    // `transport`: the desk didn't answer; an inline Retry replays this id rather than acting twice (Codex review on #671).
    const commands = { ...state.commands, [commandId]: { ...entry, status, error: result.error, outcome: result.outcome, ...(result.transport ? { transport: true } : {}) } };
    if (status === 'sent') {
      // A later success supersedes earlier failures of the same kind on this item (a resend that worked).
      const kind = (t) => (['reply', 'answer', 'retry', 'respond', 'approve', 'dismiss'].includes(t) ? 'say' : t);
      for (const [id, c] of Object.entries(commands)) if (id !== commandId && c.itemId === itemId && c.status === 'failed' && kind(c.type) === kind(type)) delete commands[id];
    }
    set({ commands });
    if (status === 'sent') {
      // A "sent" marker fades after a moment; failures stay until replaced.
      setTimeout(() => {
        const c = state.commands[commandId];
        if (c && c.status === 'sent') {
          const next = { ...state.commands };
          delete next[commandId];
          set({ commands: next });
        }
      }, 2500);
    } else if (deliveryUnknown(result)) {
      // Not a plain failure: the words may be out. Warn instead of inviting a resend.
      toast(`${verb(type)} may have sent: ${state.byId[itemId]?.agentName || 'the agent'} didn’t confirm in time. Check before sending again.`, { sticky: true });
    } else if (!quiet) {
      failToast(type, itemId, result, () => command(type, itemId, args, again(result)));
    }
    refreshLists(150);
    if (itemId && state.detail?.id === itemId) loadDetail(itemId);
    return { ...result, status };
  }

  /** A job's Run now: the button says "Run started" at the tap; a failure says why with Retry. */
  async function runJob(itemId, retryOf = {}) {
    const result = await command('run', itemId, {}, { quiet: true, ...retryOf });
    // After a lost answer the Retry sends the same id, so the desk replays it rather than starting the job twice (Codex review on #671).
    if (result.status === 'failed') failToast('run', itemId, result, () => runJob(itemId, again(result)), `Run didn’t start: ${result.error || 'unknown error'}`);
    return result;
  }

  /** A job's Pause or Resume: shown at the tap; a failure puts it back and says why with Retry. */
  async function pauseJob(itemId, paused) {
    const result = await command('pause', itemId, { paused }, { quiet: true });
    if (result.status === 'failed') failToast('pause', itemId, result, () => pauseJob(itemId, paused), `${paused ? 'Pause' : 'Resume'} didn’t go through: ${result.error || 'unknown error'}`);
    return result;
  }

  function verb(type) {
    return { reply: 'Reply', answer: 'Answer', respond: 'Answer', approve: 'Approval', dismiss: 'Dismiss', done: 'Done', snooze: 'Snooze', park: 'Park', pickup: 'Pick up', retry: 'Retry', seen: 'Mark read', unseen: 'Mark unread', undo: 'Undo', sweep: 'Sweep', reopen: 'Reopen', viewed: 'Viewed', label: 'Label', tag: 'Type', rename: 'Rename', pin: 'Pin', project: 'Move', watch: 'Watching the review', role: 'Kind', space: 'Move', run: 'Run', pause: 'Pause' }[type] || type;
  }

  /**
   * The desk's one failure toast for something the owner already moved on from: why, Retry (`retry`), and Open.
   * No Retry when the item changed since the tap (look first) or the words may already be out (never twice).
   */
  /** A Retry's options: the same command id when the desk may have it already (see command). */
  const again = (result) => (result.transport ? { commandId: result.commandId } : {});
  // itemId -> the attention time the desk returned with the last command on it (CommandResult outcome.attentionAt)
  const latestGuard = new Map();
  const withGuard = (args, itemId) => {
    const { ifStateAt: _later, [GUARD_SEEN]: seen, ...rest } = args;
    // An item's attention time only grows: the newer of the desk's last answer and what the tap saw (a list read may
    // have brought a newer one than an older answer; Codex review on #671).
    const known = [latestGuard.get(itemId), seen].filter((t) => typeof t === 'number');
    const at = known.length ? Math.max(...known) : undefined;
    return typeof at === 'number' ? { ...rest, ifStateAt: at } : rest;
  };
  const itemChains = new Map(); // itemId -> its newest command's request: the next one on the item waits for it
  function failToast(type, itemId, result, retry, text = null) {
    const name = state.byId[itemId]?.place || state.byId[itemId]?.agentName || null;
    const actions = [];
    if (retry && result.outcome?.changed !== true && !questionChanged(result) && !deliveryUnknown(result)) actions.push({ label: 'Retry', fn: retry });
    if (itemId && state.byId[itemId]) actions.push({ label: 'Open', fn: () => openItem(itemId) });
    return toast(text || `${verb(type)} didn’t go through${name ? ` for ${name}` : ''}: ${result.error || 'unknown error'}`, { sticky: true, actions });
  }

  function putReceipt(receipt) {
    const receipts = [...state.ownerReceipts.filter(r => r.commandId !== receipt.commandId), receipt];
    saveReceipts(receipts);
    set({ ownerReceipts: receipts });
  }
  function retireReceipts(commandIds) {
    const retired = new Set(commandIds);
    const receipts = state.ownerReceipts.filter(r => !retired.has(r.commandId));
    saveReceipts(receipts);
    set({ ownerReceipts: receipts });
  }
  async function retryReceipt(receipt) {
    // A toast can outlive the failed receipt after the composer successfully resends it.
    if (!state.ownerReceipts.some(r => r.commandId === receipt.commandId)) return;
    if (receipt.images) return openReply(receipt.itemId);
    // Unknown delivery replays the same id. A definite refusal needs a new command.
    if (receipt.status === 'failed') {
      state.ownerReceipts = state.ownerReceipts.filter(r => r.commandId !== receipt.commandId);
      saveReceipts(state.ownerReceipts);
    }
    const result = await command('reply', receipt.itemId, { text: receipt.text }, { quiet: true, commandId: receipt.status === 'uncertain' ? receipt.commandId : null });
    if (result.status === 'sent') {
      retireReceipts(receipt.supersedes || []);
      const draft = draftFor(receipt.itemId);
      const head = restoredHead[receipt.itemId] || [];
      const joined = head.map(h => h.text).join('\n\n');
      if (head.some(h => h.commandId === receipt.commandId) && draft.startsWith(joined)) {
        const remaining = head.filter(h => h.commandId !== receipt.commandId);
        restoredHead[receipt.itemId] = remaining;
        setDraft(receipt.itemId, [...remaining.map(h => h.text), draft.slice(joined.length).trim()].filter(Boolean).join('\n\n'));
      } else if (draft.trim() === receipt.text) setDraft(receipt.itemId, '');
    } else if (result.commandId) {
      const next = state.ownerReceipts.find(r => r.commandId === result.commandId);
      if (next && receipt.supersedes?.length) putReceipt({ ...next, supersedes: receipt.supersedes });
      restoredHead[receipt.itemId] = (restoredHead[receipt.itemId] || []).map(h => h.commandId === receipt.commandId ? { ...h, commandId: result.commandId } : h);
    }
    return result;
  }

  function lastCommand(itemId, types) {
    let latest = null;
    for (const c of Object.values(state.commands)) {
      if (c.itemId !== itemId || (types && !types.includes(c.type)) || c.type === 'viewed') continue;
      if (!latest || c.at > latest.at) latest = c;
    }
    return latest;
  }

  function offerUndo(result, text) {
    const seq = result.outcome?.seq;
    toast(text, seq ? { action: { label: 'Undo', fn: () => undo(seq, null) } } : {});
  }

  // Reply: the draft survives a failure (and a reload).
  function setDraft(itemId, text) {
    state.drafts[itemId] = text;
    storageSet(`draft.${itemId}`, text);
    notify();
  }
  function draftFor(itemId) {
    if (state.drafts[itemId] == null) state.drafts[itemId] = storageGet(`draft.${itemId}`, '');
    return state.drafts[itemId];
  }
  // A reply's images ride with its draft: kept in this browser too while they fit (a few MB), so a
  // reload doesn't lose them; when they don't fit, they stay until the page goes.
  function imagesFor(itemId) {
    if (state.replyImages[itemId] == null) {
      let kept = [];
      try {
        kept = JSON.parse(localStorage.getItem(`desk.draftImages.${itemId}`) || '[]');
      } catch {
        /* none, or private mode */
      }
      state.replyImages[itemId] = Array.isArray(kept) ? kept : [];
    }
    return state.replyImages[itemId];
  }
  function setImages(itemId, images) {
    set({ replyImages: { ...state.replyImages, [itemId]: images } });
    try {
      if (images.length) localStorage.setItem(`desk.draftImages.${itemId}`, JSON.stringify(images));
      else localStorage.removeItem(`desk.draftImages.${itemId}`);
    } catch {
      try {
        localStorage.removeItem(`desk.draftImages.${itemId}`);
      } catch {
        /* private mode */
      }
      if (images.length) toast('These images are too big to keep if the page reloads; they’re still in the draft.');
    }
  }
  async function addReplyImages(itemId, files) {
    if (!files.length) return;
    const room = MAX_IMAGES - imagesFor(itemId).length - (state.replyReading[itemId] || 0);
    if (room <= 0) return toast(`A reply takes up to ${MAX_IMAGES} images.`);
    if (files.length > room) toast(`A reply takes up to ${MAX_IMAGES} images; added the first ${room}.`);
    const take = files.slice(0, room);
    const reading = (delta) => set({ replyReading: { ...state.replyReading, [itemId]: Math.max(0, (state.replyReading[itemId] || 0) + delta) } });
    reading(take.length);
    const prepared = await Promise.all(take.map(prepareImage));
    reading(-take.length);
    for (const p of prepared) if (p.error) toast(p.error);
    const added = prepared.filter((p) => !p.error);
    if (added.length) setImages(itemId, [...imagesFor(itemId), ...added].slice(0, MAX_IMAGES));
  }
  function removeReplyImage(itemId, id) {
    setImages(itemId, imagesFor(itemId).filter((image) => image.id !== id));
  }
  function openLightbox(images, index = 0) {
    if (images?.length) set({ lightbox: { images, index } });
  }
  function openReply(itemId) {
    if (state.byId[itemId]?.replyable === false) return;
    set({ replyOpen: itemId, focusId: itemId });
  }
  function closeReply() {
    set({ replyOpen: null });
  }
  const openSheet = (sheet) => set({ sheet });
  /** A Conversation side panel: docked (and remembered) on a wide desk, a flyout on a narrow one. */
  function togglePanel(side, docked) {
    if (!docked) return set({ convoFlyout: state.convoFlyout === side ? null : side });
    const convoPanels = { ...state.convoPanels, [side]: !state.convoPanels[side] };
    storageSet(side === 'left' ? 'convoLeft' : 'convoRight', convoPanels[side] ? '1' : '0');
    set({ convoPanels });
  }
  const closeSheet = () => set({ sheet: null });
  /** The Send button's mode: back to the List after a send (the default), or stay on the thread. */
  function setSendStay(on) {
    storageSet('sendStay', on ? '1' : '');
    set({ sendStay: !!on });
  }

  /**
   * Optimistic: the box clears and the board comes back at the tap; the words go out behind it. A failure
   * puts them back in the draft (ahead of anything typed since) with a Retry toast, so the owner isn't held
   * on the thread waiting for the backend. `stay` overrides the remembered send mode for this one send
   * (⌘⇧↵ sends the other way).
   */
  // Failed sends put back at the head of a draft, in the order they were sent (two quick sends that both
  // fail come back first-then-second, whichever failed first; Codex review on #644).
  const restoredHead = {}; // itemId -> [{ seq, text, commandId }]
  let replySeq = 0;
  async function sendReply(itemId, text, { stay = state.sendStay } = {}) {
    if (state.byId[itemId]?.replyable === false) return { status: 'failed', error: 'This conversation is read-only' };
    const fromDraft = text == null;
    const seq = ++replySeq;
    const body = String(text ?? draftFor(itemId)).trim();
    // The draft's images go with the draft; a canned reply (Nudge) sends only its words.
    const images = fromDraft ? imagesFor(itemId) : [];
    if (!body && !images.length) return;
    if (fromDraft && state.replyReading[itemId]) return toast('Still adding the image…');
    const args = { text: body, ...(images.length ? { attachments: images.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl })) } : {}) };
    const name = state.byId[itemId]?.agentName || 'the agent';
    // Sending the restored composer (including edits or reviewed images) replaces its failed attempts.
    // Keep ancestors across repeated failures, and retire them only after a confirmed delivery.
    const supersedes = fromDraft ? (restoredHead[itemId] || []).flatMap(h => [h.commandId, ...(h.supersedes || [])]).filter(id =>
      state.ownerReceipts.some(r => r.commandId === id && r.status === 'failed')) : [];
    if (fromDraft) {
      delete restoredHead[itemId];
      setDraft(itemId, '');
      // Only what goes: an image added after the tap stays in the draft (Codex review on #506).
      if (images.length) {
        const sent = new Set(images.map((image) => image.id));
        setImages(itemId, imagesFor(itemId).filter((image) => !sent.has(image.id)));
      }
    }
    if (state.replyOpen === itemId) set({ replyOpen: null });
    // As after a spoken reply: the board comes back so the owner can move on; a prototype being tried
    // stays up. Send & stay keeps the thread.
    const p = state.presentation;
    if (!stay && p.itemId === itemId && p.view !== 'active' && p.view !== 'prototype') goBoard();
    const result = await command('reply', itemId, args, { quiet: true });
    if (result.status === 'sent') {
      retireReceipts(supersedes);
      toast(`Sent to ${name}`);
      return result;
    }
    const failedReceipt = state.ownerReceipts.find(r => r.commandId === result.commandId);
    if (failedReceipt && supersedes.length) putReceipt({ ...failedReceipt, supersedes });
    let dropped = 0;
    if (fromDraft) {
      // Back in the draft so nothing is lost: failed sends first, in send order, then words typed since.
      const draft = draftFor(itemId);
      let head = restoredHead[itemId] || [];
      const joined = head.map((h) => h.text).join('\n\n');
      if (!head.length || !draft.startsWith(joined)) head = []; // edited since: what's there now stays after
      const since = (head.length ? draft.slice(joined.length) : draft).trim();
      head = [...head, { seq, text: body, commandId: result.commandId, supersedes }].sort((a, b) => a.seq - b.seq);
      restoredHead[itemId] = head;
      setDraft(itemId, [...head.map((h) => h.text), since].filter(Boolean).join('\n\n'));
      if (images.length) {
        // The failed reply's images first; newer ones as far as a reply takes them (Codex review on #644).
        const merged = [...images, ...imagesFor(itemId).filter((image) => !images.some((sent) => sent.id === image.id))];
        dropped = Math.max(0, merged.length - MAX_IMAGES);
        setImages(itemId, merged.slice(0, MAX_IMAGES));
      }
    }
    // May have gone out (the bot didn't confirm): command() already warned; never invite a blind resend.
    if (result.transport) {
      // The desk didn't answer: the words may already be out. Back in the draft, no blind resend (Codex review on #671).
      toast(`Reply to ${name} may not have gone through (the desk didn’t answer)${fromDraft ? ' · it’s back in the draft' : ''}. Check the thread before sending again.`, { sticky: true, actions: [{ label: 'Open', fn: () => (openItem(itemId), openReply(itemId)) }] });
    } else if (!deliveryUnknown(result)) {
      const receipt = state.ownerReceipts.find(r => r.commandId === result.commandId);
      const retry = receipt && !images.length ? () => retryReceipt(receipt) : fromDraft ? () => sendReply(itemId, undefined, { stay }) : () => sendReply(itemId, body, { stay });
      toast(`Reply to ${name} didn’t send: ${result.error || 'unknown error'}${fromDraft ? ' · it’s back in the draft' : ''}${dropped ? ` · ${dropped} newer image${dropped > 1 ? 's' : ''} didn’t fit (${MAX_IMAGES} per reply)` : ''}`, { sticky: true, actions: [{ label: 'Retry', fn: retry }, { label: 'Open', fn: () => (openItem(itemId), openReply(itemId)) }] });
    }
    return result;
  }

  // Answer chips: a tap sends now (the voice operator keeps its own undo window; a tap is deliberate).
  // The chips give way to "Sent “…”" at once; a failure brings them back with a Retry toast.
  async function hold(itemId, label, type, args, onSent, retryOf = {}) {
    if (state.holds[itemId]) return;
    const entry = { option: label, type, args };
    set({ holds: { ...state.holds, [itemId]: entry } });
    const result = await command(type, itemId, args, { quiet: true, ...retryOf });
    const release = () => {
      if (state.holds[itemId] !== entry) return;
      const next = { ...state.holds };
      delete next[itemId];
      set({ holds: next });
    };
    if (result.status === 'sent') {
      onSent?.(result);
      setTimeout(release, ANSWER_SENT_MS);
    } else {
      release();
      // The question moved on, or the words may be out: no blind retry (the item's command line says which).
      if (!questionChanged(result) && !deliveryUnknown(result)) failToast(type, itemId, result, () => hold(itemId, label, type, args, onSent, again(result)), `“${label}” didn’t reach ${state.byId[itemId]?.agentName || 'the agent'}: ${result.error || 'unknown error'}`);
    }
    return result;
  }
  function answer(itemId, option) {
    const pending = pendingOf(itemFor(itemId));
    // A Loom request: a single question answers it; several need the full form (no blind chip).
    if (pending) {
      if (isOneTap(pending)) return answerPending(itemId, pending.questions[0].id, option);
      if (pending.kind === 'approval') {
        const choice = pending.approval.options.find((o) => o.label === option);
        return choice ? approve(itemId, choice) : undefined;
      }
      return;
    }
    return hold(itemId, option, 'answer', { option });
  }
  // A decision brief's answer names the revision the card showed: one revised since is refused, not answered (TGO-1079).
  const seenRevision = (pending) => (typeof pending?.brief?.revision === 'number' ? { revision: pending.brief.revision } : {});
  // Loom requests: picks live in a draft per item (tied to the request id) and survive a failed send.
  /** The freshest copy: an open Conversation's loaded detail beats the (possibly older) list copy. */
  function itemFor(itemId) {
    const detail = state.detail?.id === itemId && !state.detail.loading ? state.detail.item : null;
    return detail || state.byId[itemId] || null;
  }
  // `shown`: the request a card shows when it isn't the row's own (a brief the row carries from another thread).
  // A carried brief's draft is its own, keyed by its request: it never overwrites or clears the row's (Codex review on #781).
  const draftKey = (itemId, shown) => (shown ? `${itemId}|${shown.requestId}` : itemId);
  function pendingDraft(itemId, shown = null) {
    return currentDraft(shown || pendingOf(itemFor(itemId)), state.pendingDrafts[draftKey(itemId, shown)]);
  }
  function updateDraft(itemId, fn, shown = null) {
    set({ pendingDrafts: { ...state.pendingDrafts, [draftKey(itemId, shown)]: fn(pendingDraft(itemId, shown)) } });
  }
  function clearDraft(itemId, shown = null) {
    const next = { ...state.pendingDrafts };
    delete next[draftKey(itemId, shown)];
    set({ pendingDrafts: next });
  }
  function pendingPick(itemId, question, label) {
    updateDraft(itemId, (draft) => pick(draft, question, label));
  }
  function pendingToggleOther(itemId, questionId, shown = null) {
    updateDraft(itemId, (draft) => toggleOther(draft, questionId), shown);
  }
  function pendingOther(itemId, questionId, text, shown = null) {
    updateDraft(itemId, (draft) => setOther(draft, questionId, text), shown);
  }
  /** One question, one tap (or one free-text answer): sent at once. `shown`: the carried request the card shows. */
  function answerPending(itemId, questionId, value, shown = null) {
    const pending = shown || pendingOf(itemFor(itemId));
    if (!pending?.requestId) return;
    const question = pending.questions.find((q) => q.id === questionId);
    if (!question || !String(value).trim()) return;
    const answers = { [question.id]: question.multiSelect ? [value] : value };
    return hold(itemId, String(value), 'respond', { requestId: pending.requestId, answers, ...briefRuleArgs(itemId, pending), ...seenRevision(pending) }, () => (clearDraft(itemId, shown), clearBriefRule(pending.requestId)));
  }
  /** Every question answered: one Submit, sent at once. */
  function submitPending(itemId) {
    const pending = pendingOf(itemFor(itemId));
    if (!pending?.requestId) return;
    const answers = answersFrom(pending, pendingDraft(itemId));
    if (!answers) return;
    return hold(itemId, describeAnswers(pending, answers), 'respond', { requestId: pending.requestId, answers, ...briefRuleArgs(itemId, pending), ...seenRevision(pending) }, () => (clearDraft(itemId), clearBriefRule(pending.requestId)));
  }
  function approve(itemId, option) {
    const pending = pendingOf(itemFor(itemId));
    if (!pending?.requestId || pending.kind !== 'approval') return;
    return hold(itemId, option.label, 'approve', { requestId: pending.requestId, decision: option.decision });
  }
  async function dismissPending(itemId) {
    const pending = pendingOf(itemFor(itemId));
    if (!pending?.requestId || !canDismiss(pending)) return;
    const result = await command('dismiss', itemId, { requestId: pending.requestId });
    if (result.status === 'sent') {
      clearDraft(itemId);
      toast('Dismissed the question');
    }
  }
  function retryCommand(c) {
    // The desk didn't answer: the same id again, so it replays what it did. A reply's words are back in the draft
    // (its images aren't kept here), so it is never re-sent from here blindly (Codex review on #671).
    const reuse = c.transport ? { commandId: c.commandId } : {};
    if (c.type === 'reply') return c.transport ? openReply(c.itemId) : sendReply(c.itemId, c.args.text);
    if (c.type === 'answer' && deliveryUnknown(c)) return; // may have gone out: never re-sent blindly
    // With the args it was first sent with, guard included: a Retry is the same tap again, not a new one read from
    // the row as it is now (Codex review on #671).
    if (c.type === 'done') return runDone(c.itemId, c.args, c.args.stopJob, state.byId[c.itemId]?.place || 'Item', reuse);
    if (c.type === 'respond' || c.type === 'approve') {
      // A carried brief's retry clears that brief's draft, not the row's own.
      const own = pendingOf(itemFor(c.itemId))?.requestId;
      const shown = c.args?.requestId && c.args.requestId !== own ? { requestId: c.args.requestId } : null;
      return command(c.type, c.itemId, c.args, reuse).then((r) => (r.status === 'sent' && clearDraft(c.itemId, shown), r));
    }
    return command(c.type, c.itemId, c.args, reuse);
  }

  /**
   * The copy the owner is looking at: the open Conversation's loaded detail while that item is the one open
   * (a control window draws it under a stage too),
   * else the list's (the detail stays cached after going back to the list). Codex review on #634.
   */
  function asShown(itemId) {
    const p = state.presentation;
    return p && viewFor(state.role, p) === 'conversation' && p.itemId === itemId ? itemFor(itemId) : state.byId[itemId] || null;
  }

  /**
   * An action on a snoozed or parked item applies only while it is as shown: the server refuses it once
   * the agent posted, another screen changed it, or it was done (ifStateAt; Codex review on #492).
   */
  function asSeen(itemId) {
    // Its own prediction still showing: the copy's guard is from before it (the server moved it on). The guard is
    // filled in when the command goes, from the time the desk gave the one before it on this item (commands on an
    // item go in order), so a follow-up is still checked against what happened since (Codex review on #671).
    // Only after a command that moves the desk's attention time (a Rename doesn't: its guard still holds).
    if (overlays.some((o) => o.itemId === itemId && o.movesAttention)) {
      const seen = asShown(itemId)?.attentionUpdatedAt;
      return { ifStateAt: GUARD_AT_SEND, ...(typeof seen === 'number' ? { [GUARD_SEEN]: seen } : {}) };
    }
    const item = asShown(itemId);
    return item && item.disposition !== 'active' && typeof item.attentionUpdatedAt === 'number' ? { ifStateAt: item.attentionUpdatedAt } : {};
  }

  // Done: asks about a running job first; reports a failed write-back with retry.
  function done(itemId) {
    const item = asShown(itemId);
    // The guard is taken at the click: the stop-the-job question can stay open while the item changes (Codex review on #492).
    if (item && doneLabel(item) !== 'Clear' && runningJob(item)) return set({ confirm: { kind: 'stopJob', itemId, job: runningJob(item), guard: asSeen(itemId) } });
    return sendDone(itemId);
  }
  async function sendDone(itemId, stopJob) {
    const guard = state.confirm?.kind === 'stopJob' && state.confirm.itemId === itemId ? state.confirm.guard || {} : asSeen(itemId);
    set({ confirm: null });
    const args = { ...guard, ...(typeof stopJob === 'boolean' ? { stopJob } : {}) };
    const name = state.byId[itemId]?.place || 'Item';
    // Back to the board at the tap; a Done that fails says so with Retry rather than holding the thread open.
    if (doneLabel(state.byId[itemId]) !== 'Clear' && state.presentation.itemId === itemId && state.presentation.view !== 'active') goBoard();
    return runDone(itemId, args, stopJob, name);
  }
  /** Sends a Done (first try or a toast's Retry, with the guard taken at the original tap). */
  async function runDone(itemId, args, stopJob, name, retryOf = {}) {
    const label = doneLabel(state.byId[itemId]);
    const result = await command('done', itemId, args, { quiet: true, optimistic: args.retryClearSeq === undefined, ...retryOf });
    if (result.status !== 'sent') {
      // Changed since the tap (the agent posted, another screen acted): failToast offers no Retry (Codex review on #644).
      if (!deliveryUnknown(result)) failToast('done', itemId, result, () => runDone(itemId, args, stopJob, name, again(result)), `${label} didn’t go through for ${name}: ${result.error || 'unknown error'}`);
      return result;
    }
    const wb = result.outcome?.writeback;
    if (wb && wb.outcome === 'failed') {
      toast(`${result.outcome?.cleared ? 'Cleared' : label} here, but the write-back failed: ${wb.error || 'unknown error'}`, { sticky: true, action: { label: 'Retry', fn: () => result.outcome?.cleared
        ? runDone(itemId, { retryClearSeq: result.outcome.seq }, stopJob, name)
        : sendDone(itemId, stopJob) } });
    } else {
      offerUndo(result, `${result.outcome?.cleared ? 'Cleared' : label} · ${name}`);
    }
    return result;
  }

  function openSnooze(itemId, chapter = null) {
    // Captured now: the picker can sit open while the lists refresh underneath it.
    set({ snoozeFor: itemId, snoozeGuard: asSeen(itemId), snoozeChapter: chapter, focusId: itemId });
  }
  async function chooseSnooze(choice) {
    const itemId = state.snoozeFor;
    const catchup = /^(chapter|line):/.test(itemId || '') ? state.catchupSnooze : null;
    if (catchup) {
      const until = new Date(choice.args?.until).getTime();
      if (!Number.isFinite(until) || until <= Date.now()) return;
      set({ snoozeFor: null, catchupSnooze: null });
      return catchup.pick(until);
    }
    const guard = state.snoozeGuard || {};
    const chapter = state.snoozeChapter;
    set({ snoozeFor: null, snoozeGuard: null, snoozeChapter: null });
    if (!itemId) return;
    if (itemId.startsWith('project:')) return snoozeProject(itemId.slice(8), choice);
    // Back to the board at the tap; a failure still toasts (command() says why).
    if (state.presentation.itemId === itemId && state.presentation.view !== 'active') goBoard();
    const result = choice.type === 'park' ? await command('park', itemId, guard) : await command('snooze', itemId, { ...choice.args, ...guard });
    const label = choice.type === 'park' ? 'Parked' : choice.key === 'custom' ? `Snoozed ${choice.label}` : `Snoozed · ${choice.label.toLowerCase()}`;
    if (result.status === 'sent' && chapter) {
      const until = new Date(choice.args?.until).getTime();
      const operation = { backAt: Number.isFinite(until) ? until : null, marks: [], undone: false, pending: null };
      if (result.outcome?.seq) toast(label, { action: { label: 'Undo', fn: () => undoChapterSnooze(result.outcome.seq, chapter, operation) } });
      else toast(label);
      await chapterLine(chapter.spaceId, chapter.line, Number.isFinite(until) ? 'defer' : 'read', uuid(), Number.isFinite(until) ? until : undefined, operation);
      void loadCatchup();
    } else if (result.status === 'sent') offerUndo(result, label);
  }

  async function restoreChapterSnooze(chapter, operation) {
    try {
      const ids = chapter.line.ids?.length ? chapter.line.ids : [chapter.line.id];
      for (const id of ids) {
        const mark = operation.marks.find(m => m.id === id);
        // A lost line-write response still has the exact timed deferral to match.
        if (operation.backAt === null && !mark) continue;
        await client.updatesRestoreSnooze({ ids: [id], backAt: operation.backAt, seenAt: mark?.seenAt ?? null });
      }
      await Promise.all([loadChapter(chapter.spaceId), loadCatchup()]);
    } catch (err) {
      toast(`Thread restored; the catch-up card couldn’t be restored: ${err.message || 'network error'}`, { sticky: true, action: { label: 'Retry', fn: () => restoreChapterSnooze(chapter, operation) } });
    }
  }
  async function undoChapterSnooze(seq, chapter, operation, retry = {}) {
    const result = await command('undo', null, { seq }, { quiet: true, ...retry });
    if (result.status !== 'sent') {
      failToast('undo', null, result, () => undoChapterSnooze(seq, chapter, operation, again(result)));
      return;
    }
    operation.undone = true; // A saved line-write Retry must not re-hide the restored card.
    await operation.pending?.catch(() => {});
    await restoreChapterSnooze(chapter, operation);
    if (state.activity.open) loadActivity();
  }

  // One tap: off the board until the agent posts again. The toast offers Undo and a quick re-time,
  // so the default is safe to fire without the picker. A second tap on the card is the same tap: while
  // the first is in flight, and for a moment after, until the refreshed list has taken the card away.
  const snoozing = new Map(); // itemId -> time the last quick snooze finished (0 while in flight)
  const SNOOZE_SETTLE_MS = 2000;
  async function quickSnooze(itemId, { label = 'until they post', args = { trigger: 'agent_posts' }, retime = null, retryOf = {} } = {}) {
    const last = snoozing.get(itemId);
    if (last === 0 || (!retime && last !== undefined && Date.now() - last < SNOOZE_SETTLE_MS)) return null;
    snoozing.set(itemId, 0);
    // Off the board at the tap (the row goes too: the command is optimistic).
    if (!retime && state.presentation.itemId === itemId && state.presentation.view !== 'active') goBoard();
    let result;
    try {
      // A re-time only applies while the item is still snoozed; the server checks that atomically.
      // retime is the seq of the snooze whose toast offered it, so a stale toast can't re-time a newer one.
      // A first tap applies only from Active (another screen may have just snoozed it).
      result = await command('snooze', itemId, retime ? { ...args, onlyIfSnoozed: true, ...(typeof retime === 'number' ? { snoozeSeq: retime } : {}) } : { ...args, onlyIfActive: true }, { quiet: true, ...retryOf });
    } finally {
      snoozing.set(itemId, Date.now());
    }
    if (result.status !== 'sent') {
      snoozing.delete(itemId); // nothing changed: a Retry (or a second tap) goes through (Codex review on #671)
      if (retime && result.outcome?.snoozed === false) toast(`${state.byId[itemId]?.agentName || 'The agent'} already posted; it’s back in Active`);
      else if (retime && result.outcome?.replaced) toast('That snooze was already changed; the newer one stands');
      else if (!retime && result.outcome?.active === false) toast('Already out of the rotation');
      else failToast('snooze', itemId, result, () => quickSnooze(itemId, { label, args, retime, retryOf: again(result) }));
      return result;
    }
    const name = state.byId[itemId]?.place;
    const seq = result.outcome?.seq;
    const presets = snoozeChoices(new Date());
    const relabel = { morning: 'Tomorrow', monday: 'Next week' };
    const others = ['soon', 'evening', 'morning', 'monday']
      .map((key) => presets.find((c) => c.key === key))
      .filter(Boolean)
      .map((c) => ({ text: relabel[c.key] || c.label, args: c.args }))
      .filter((c) => c.text.toLowerCase() !== label)
      .map((c) => ({ label: c.text, fn: () => quickSnooze(itemId, { label: c.text.toLowerCase(), args: c.args, retime: seq ?? true }) }));
    if (label !== 'until they post') others.unshift({ label: 'Until they post', fn: () => quickSnooze(itemId, { retime: seq ?? true }) });
    const actions = [...(seq ? [{ label: 'Undo', fn: () => undo(seq, null) }] : []), ...others];
    toast(`Snoozed ${label}${name ? ` · ${name}` : ''}`, { actions, ms: 9000 });
    return result;
  }

  async function undo(seq, itemId) {
    const result = await command('undo', itemId, { seq });
    if (result.status === 'sent') {
      toast('Undone');
      if (state.activity.open) loadActivity();
    }
  }

  async function loadActivity() {
    set({ activity: { ...state.activity, loading: true } });
    try {
      const json = await client.activity({ limit: 60 });
      set({ activity: { ...state.activity, events: json.events || [], loading: false } });
    } catch (err) {
      set({ activity: { ...state.activity, loading: false, error: err.message } });
    }
  }
  function toggleActivity(open = !state.activity.open) {
    set({ activity: { ...state.activity, open } });
    if (open) loadActivity();
  }

  // ── draft mode: taps on the Draft card go to the operator, which owns the draft ──
  // ── start work: a new Loom thread (start-work.js) ───────────────────────
  const blankStartForm = (repo = '', repoFrom = '') => ({ prompt: '', repo, repoFrom, repoInferred: false, account: '', pin: '', agent: '', placeOpen: false, placeQuery: '', optsOpen: false, openOpt: null, title: '', titleOpen: false, mode: 'auto', modeChosen: false, plan: false, attachments: [], acctOpen: false, role: 'interactive', parent: '' });
  /**
   * The repo a fresh sheet starts on: from inside a project, where its latest Loom thread runs; else the
   * Loom thread in focus, else the last one this device started in.
   */
  function defaultRepo(repos, projectId = null) {
    const fromProject = projectRepo(repos, projectId);
    if (fromProject) return { repo: fromProject, repoFrom: 'project' };
    const focus = state.focusId ? state.byId[state.focusId] : null;
    const fromFocus = focus?.source === 'loom' ? repos.find((r) => r.name === focus.area) : null;
    if (fromFocus) return { repo: fromFocus.id, repoFrom: 'focus' };
    const last = storageGet('startWork.repo', '');
    const remembered = repos.find((r) => r.name === last);
    if (remembered) return { repo: remembered.id, repoFrom: 'last' };
    // Else the repo of the most recently active Loom thread, as Loom itself opens a new draft.
    const recent = state.lists.active.items.filter((item) => (item.source === 'loom') && repos.some((r) => r.name === item.area)).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
    const fromRecent = recent ? repos.find((r) => r.name === recent.area) : null;
    return fromRecent ? { repo: fromRecent.id, repoFrom: 'recent' } : { repo: '', repoFrom: '' };
  }
  /** The repo of the project's most recently active Loom thread, from the lists loaded so far. */
  function projectRepo(repos, projectId) {
    if (!projectId) return null;
    const latest = [...projectItems(projectId, ['active', 'snoozed', 'parked']), ...(state.lists.history?.items || []).filter((item) => item.facts?.projectId === projectId)]
      .filter((item) => (item.source === 'loom') && repos.some((r) => r.name === item.area))
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
    return latest ? repos.find((r) => r.name === latest.area).id : null;
  }
  /**
   * A sheet opened from a project before its lists arrived (a fresh or restored page) follows the
   * project's repo as each list lands, in whatever order, unless the owner picked one (Codex review on #541).
   */
  function settleProjectRepo() {
    const sw = state.startWork;
    if (!sw?.projectId || !sw.options || sw.sending || sw.form.repoFrom === 'picked') return;
    const repo = projectRepo(sw.options.repos, sw.projectId);
    const current = sw.form.repoInferred ? sw.form.repoBefore?.repo : sw.form.repo;
    if (!repo) return;
    if (repo === current) {
      // Already there by another default: the hint says it's the project's repo now.
      if (!sw.form.repoInferred && sw.form.repoFrom !== 'project') state.startWork = { ...sw, form: { ...sw.form, repoFrom: 'project' } };
      return;
    }
    // A repo named in the prompt keeps the field; the project's repo is where it goes back to.
    const form = sw.form.repoInferred ? { ...sw.form, repoBefore: { repo, repoFrom: 'project' } } : withRepoDefaults({ ...sw.form, repo, repoFrom: 'project' }, sw.options);
    state.startWork = { ...sw, form };
  }
  function withRepoDefaults(form, options) {
    const repo = options?.repos.find((r) => r.id === form.repo);
    return { ...form, mode: form.modeChosen ? form.mode : 'auto', modeHint: defaultStartMode({ ...form, repo }) };
  }
  /**
   * A repo named in the description switches the sheet to it until the owner picks one.
   * Edit the name back out and the sheet goes back to the repo it had (Codex review on #484).
   */
  function withNamedRepo(form, options) {
    // With an agent picked, a repo the words name is just words.
    if (form.repoFrom === 'picked' || !options || form.agent) return form;
    const named = repoNamedIn(form.prompt, options.repos);
    if (named && named !== form.repo) {
      return { ...form, repo: named, repoInferred: true, repoBefore: form.repoInferred ? form.repoBefore : { repo: form.repo, repoFrom: form.repoFrom } };
    }
    if (!named && form.repoInferred) {
      return { ...form, repo: form.repoBefore?.repo ?? '', repoFrom: form.repoBefore?.repoFrom ?? '', repoInferred: false, repoBefore: null };
    }
    return form;
  }
  async function loadStartOptions() {
    try {
      const options = await client.startWorkOptions();
      if (!state.startWork) return;
      const sw = state.startWork;
      // A first load fills the repo; a refresh (after a start) only updates the accounts and their headroom.
      let form = sw.form;
      if (!sw.options && !form.repo) {
        // The same place starts the same thread however the sheet opened: a project an agent owns is a thread with that agent (Codex review on #948).
        const agent = form.agent || (sw.projectId ? projectAgent(sw.projectId, options) : '');
        const picked = defaultRepo(options.repos, sw.projectId);
        // A prefilled prompt (Start on a code block) that names a repo switches to it, as typing it would.
        form = withNamedRepo({ ...form, ...picked, agent }, options);
      }
      set({ startWork: { ...sw, options, loading: false, form: withRepoDefaults(form, options) } });
    } catch (err) {
      if (!state.startWork) return;
      if (state.startWork.options) return; // a refresh that failed leaves the sheet as it was
      set({ startWork: { ...state.startWork, loading: false, loadError: `Can’t reach Loom: ${err.body?.error || err.message || 'network error'}` } });
    }
  }
  /** The agent a project's thread starts with: the project's owner, when the desk can start a thread with it. */
  function projectAgent(projectId, options) {
    const owner = parentOf((state.projects || []).find((p) => p.id === projectId));
    return owner?.kind === 'agent' && (options?.agents || []).some((a) => a.id === owner.id) ? owner.id : '';
  }
  /** Opens the sheet; `prompt` fills it in (Start on a code block), replacing the prompt of a sheet already open. */
  async function openStartWork({ prompt = '', projectId = null, agentId = null } = {}) {
    if (state.startWork) {
      if (prompt && !state.startWork.sending) setStartField('prompt', prompt);
      return;
    }
    // One command id per sheet: a retry after a lost answer can't start a second thread.
    // From inside a project (`projectId`), the new thread joins it.
    set({ startWork: { options: null, loading: true, loadError: null, form: { ...blankStartForm(), prompt, agent: agentId || '' }, sending: false, error: null, commandId: uuid(), background: 0, projectId } });
    // The project's repo comes from its threads: on a fresh page, the sheet waits for the lists that hold them (Codex review on #541).
    if (projectId) await Promise.all(LIST_VIEWS.filter((view) => !state.lists[view].loaded).map((view) => loadList(view, { join: true })));
    await loadStartOptions();
  }
  function closeStartWork() {
    if (state.startWork?.sending) return; // the start is on its way; its outcome lands as a toast
    set({ startWork: null });
  }
  /**
   * Picks the project the new thread joins (or none). The sheet follows the project's repo, as if it
   * had been opened there, unless the owner picked a repo.
   */
  async function setStartProject(projectId) {
    const sw = state.startWork;
    if (!sw || sw.sending) return;
    const id = projectId || null;
    // A repo that only came from the old project no longer explains itself.
    let form = sw.form.repoFrom === 'project' ? { ...sw.form, repoFrom: 'last' } : sw.form;
    // A project change keeps only owners in the new space or one around it.
    if (form.parent) {
      const projects = state.projects || [];
      const space = id ? { kind: 'project', id } : form.agent ? { kind: 'agent', id: form.agent } : null;
      const around = [space, null];
      for (let at = id, hops = 0; at && hops < 4; hops += 1) {
        const parent = projects.find((p) => p.id === at)?.parent;
        if (!parent) break;
        const [kind, parentId] = parent.split(':');
        around.push({ kind, id: parentId });
        at = kind === 'project' ? parentId : null;
      }
      const legal = around.some((where) => ownerChoices(state.lists, where, projects, { limit: Infinity }).choices.some((o) => o.id === form.parent));
      if (!legal) form = { ...form, parent: '' };
    }
    const unloaded = id ? LIST_VIEWS.filter((view) => !state.lists[view].loaded) : [];
    // Start waits until the project's repo is known, so a quick Start can't file it under the project in the old repo (Codex review on #567).
    set({ startWork: { ...sw, projectId: id, form, error: null, projectLoading: unloaded.length > 0 } });
    if (!id) return;
    await Promise.all(unloaded.map((view) => loadList(view, { join: true })));
    if (state.startWork?.projectId !== id) return;
    settleProjectRepo();
    // A list that failed to load may hold the project's latest thread: the sheet says to check the repo rather than block Start (Codex review on #567).
    const unread = unloaded.some((view) => !state.lists[view].loaded);
    set({ startWork: { ...state.startWork, projectLoading: false, form: unread && state.startWork.form.repoFrom !== 'picked' ? { ...state.startWork.form, repoFrom: 'unread' } : state.startWork.form } });
  }
  /**
   * The sheet's place chip (start-work.js): a project (the thread joins it, on the project's repo; a project an agent
   * owns is a thread with that agent when it can start one), an agent (a thread with it), or a repo on its own.
   */
  async function pickStartPlace({ kind, id }) {
    const sw = state.startWork;
    if (!sw || sw.sending) return;
    const closed = { placeOpen: false, placeQuery: '' };
    if (kind === 'project') {
      const agent = projectAgent(id, sw.options);
      // The project's repo is the newer pick: a repo picked for an earlier place gives way (Options → Repo still overrides).
      const form = { ...sw.form, ...closed, agent, pin: '', ...(agent ? { account: '', plan: false, repoInferred: false } : {}), ...(sw.form.repoFrom === 'picked' ? { repoFrom: 'last' } : {}) };
      set({ startWork: { ...sw, form } });
      return setStartProject(id);
    }
    const form = kind === 'agent'
      ? { ...sw.form, ...closed, agent: id, pin: '', account: '', plan: false, repoInferred: false }
      : { ...sw.form, ...closed, agent: '', repo: id, repoFrom: 'picked', repoInferred: false, pin: '' };
    set({ startWork: { ...sw, form: withRepoDefaults(form, sw.options) } });
    return setStartProject(null);
  }
  function setStartField(key, value) {
    const sw = state.startWork;
    if (!sw) return;
    if (key === 'parent' && value) {
      const group = startOwner(sw).groups?.find((g) => g.choices.some((o) => o.id === value));
      if (group && group.projectId !== (sw.projectId || null)) {
        void setStartProject(group.projectId);
        set({ startWork: { ...state.startWork, form: { ...state.startWork.form, parent: value } } });
        return;
      }
    }
    let form = { ...sw.form, [key]: value };
    if (key === 'repo') {
      form.repoInferred = false;
      form.repoFrom = 'picked';
    }
    if (key === 'mode') form.modeChosen = true;
    if (key === 'account') form.acctOpen = false;
    if (key === 'placeOpen' && !value) form.placeQuery = '';
    // A pin is to one of this repo's accounts, and only on Loom: another repo, or plan first (which runs on Loom), drops it.
    if (key === 'repo') form.pin = '';
    // A thread reports to no one: a worker or job picks again from its space's lead.
    if (key === 'role' && value === 'interactive') form.parent = '';
    if (key === 'prompt') {
      form = withNamedRepo(form, sw.options);
      // The prompt named another repo: a pin was to the old one's accounts.
      if (form.repo !== sw.form.repo) form.pin = '';
    }
    form = withRepoDefaults(form, sw.options);
    set({ startWork: { ...sw, form, error: ['acctOpen', 'titleOpen', 'optsOpen', 'openOpt', 'placeOpen', 'placeQuery'].includes(key) ? sw.error : null } });
  }
  async function addStartAttachments(files) {
    // Read in as a reply's images are (big ones scaled down, HEIC made JPEG); one that can't go says why.
    const read = async (file) => {
      const prepared = await prepareImage(file);
      if (prepared.error) toast(prepared.error);
      return prepared.error ? null : prepared;
    };
    const fits = files.slice(0, MAX_IMAGES);
    if (fits.length < files.length) toast(`A new thread takes up to ${MAX_IMAGES} images.`);
    const sheet = state.startWork?.commandId;
    if (!sheet || !fits.length) return;
    // Start waits while images are still being read, so a quick ⌘↵ can't leave one behind (Codex review on #484).
    const reading = (delta) => state.startWork?.commandId === sheet && set({ startWork: { ...state.startWork, form: { ...state.startWork.form, reading: Math.max(0, (state.startWork.form.reading || 0) + delta) } } });
    reading(fits.length);
    const added = (await Promise.all(fits.map(read))).filter(Boolean);
    reading(-fits.length);
    // A read that lands after its sheet started (or moved on to the next) belongs to no sheet.
    const sw = state.startWork;
    if (!sw || sw.commandId !== sheet || !added.length) return;
    set({ startWork: { ...sw, form: { ...sw.form, attachments: [...sw.form.attachments, ...added].slice(0, 8) } } });
  }
  function removeStartAttachment(index) {
    const sw = state.startWork;
    if (!sw) return;
    set({ startWork: { ...sw, form: { ...sw.form, attachments: sw.form.attachments.filter((_, i) => i !== index) } } });
  }
  /**
   * Start the thread. With `another`, the sheet clears at once for the next one (keeping the repo)
   * while this one starts in the background; its outcome lands as a toast.
   */
  /**
   * Optimistic: the sheet closes (or, for Start & another, clears) at the tap and the thread starts behind it.
   * A start that fails comes back as a toast: Retry sends the same request (its command id can't start two
   * threads), Edit reopens the sheet with what was written and why it failed.
   */
  /**
   * Who a new worker or job reports to: the owner picked on the sheet while it's still in the space, else the
   * space's lead (docs/specs/spaces.md). `choices` for the sheet's picker; `owner` null for a thread, or with no one.
   */
  function startOwner(sw = state.startWork) {
    if (!sw) return { groups: [], choices: [], lead: null, owner: null };
    const space = sw.projectId ? { kind: 'project', id: sw.projectId } : sw.form.agent ? { kind: 'agent', id: sw.form.agent } : null;
    const projects = state.projects || [];
    const label = sw.projectId ? projects.find((p) => p.id === sw.projectId)?.name || 'Project'
      : sw.form.agent ? sw.options?.agents?.find((a) => a.id === sw.form.agent)?.name || sw.form.agent : 'No project';
    const current = { space, projectId: sw.projectId || null, label };
    const others = nestedProjectList(projects, agentsOf(state.lists, state.now))
      .filter(({ project }) => project.id !== sw.projectId)
      .map(({ project, label }) => ({ space: { kind: 'project', id: project.id }, projectId: project.id, label }));
    const spaces = [current, ...others];
    if (sw.projectId && sw.form.agent) spaces.push({ space: { kind: 'agent', id: sw.form.agent }, projectId: null, label: sw.options?.agents?.find((a) => a.id === sw.form.agent)?.name || sw.form.agent });
    else if (space && !sw.form.agent) spaces.push({ space: null, projectId: null, label: 'No project' });
    const groups = spaces.map((group) => ({ ...group, ...ownerChoices(state.lists, group.space, projects) })).filter((group, i) => i === 0 || group.choices.length);
    const { lead, choices } = groups[0];
    const all = groups.flatMap((g) => g.choices);
    return { groups, choices, lead, owner: sw.form.role === 'interactive' ? null : all.find((c) => c.id === sw.form.parent) || lead };
  }
  /** The start request's kind: nothing for a thread, else the role and who it reports to. */
  function startKind(sw) {
    const { owner } = startOwner(sw);
    return sw.form.role !== 'interactive' && owner ? { role: sw.form.role, parentItemId: owner.id } : {};
  }
  async function submitStartWork({ another = false } = {}) {
    const sw = state.startWork;
    if (!sw || sw.form.reading || sw.projectLoading) return;
    const { form } = sw;
    // A worker or job never starts reporting to no one (the sheet holds Start until it has someone).
    if (form.role !== 'interactive' && !startOwner(sw).owner) return;
    if (form.agent) return submitAgentThread(sw, { another });
    const body = {
      commandId: sw.commandId,
      repo: form.repo,
      prompt: form.prompt,
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
      // Auto sends no account: the desk picks from the policy (one start at a time, so back-to-back
      // starts take turns). A picked account is sent as picked.
      ...(form.account ? { account: form.account } : {}),
      ...(form.pin ? { pin: form.pin } : {}),
      mode: form.mode,
      plan: form.plan,
      ...(form.attachments.length ? { attachments: form.attachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl })) } : {}),
      ...(sw.projectId ? { projectId: sw.projectId } : {}),
      ...startKind(sw),
    };
    const repoName = sw.options?.repos.find((r) => r.id === form.repo)?.name;
    if (repoName) storageSet('startWork.repo', repoName);
    if (another) {
      set({ startWork: { ...sw, form: withRepoDefaults(blankStartForm(form.repo, form.repoFrom === 'focus' || form.repoFrom === 'project' ? form.repoFrom : 'last'), sw.options), sending: false, error: null, commandId: uuid(), background: (sw.background || 0) + 1 } });
      // The next sheet's auto pick reflects this start's turn once the desk has reserved it.
      setTimeout(() => void loadStartOptions(), 1500);
    } else {
      set({ startWork: null });
      toast(`Starting “${body.title || titleFromPrompt(form.prompt)}”${repoName ? ` in ${repoName}` : ''}…`, { ms: 2500 });
    }
    return runStartWork(body, { form, options: sw.options, projectId: sw.projectId }, { counted: another });
  }
  /** Sends a start (first try or a toast's Retry) and reports how it went without holding the sheet open. */
  /** A thread with a named agent: the bot opens it in the agent's channel and wakes the agent there. */
  async function submitAgentThread(sw, { another = false, retry = false }) {
    const { form } = sw;
    const name = sw.options?.agents?.find((a) => a.id === form.agent)?.name || form.agent;
    const body = {
      commandId: sw.commandId,
      agentId: form.agent,
      prompt: form.prompt,
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
      ...(form.attachments.length ? { attachments: form.attachments.map(({ name: n, mimeType, dataUrl }) => ({ name: n, mimeType, dataUrl })) } : {}),
      ...(sw.projectId ? { projectId: sw.projectId } : {}),
      ...startKind(sw),
    };
    if (retry) toast(`Trying again with ${name}…`, { ms: 2500 });
    else if (another) set({ startWork: { ...sw, form: { ...blankStartForm(), agent: form.agent }, sending: false, error: null, commandId: uuid() } });
    else {
      set({ startWork: null });
      toast(`Starting “${body.title || titleFromPrompt(form.prompt)}” with ${name}…`, { ms: 2500 });
    }
    try {
      const result = await answerWithin(client.startAgentThread(body), START_TIMEOUT_MS);
      toast(`Started with ${result.agent.name}: “${result.title}”. ${result.agent.name} is on it.`, { ms: 7000, actions: [{ label: 'Open', fn: () => openItem(result.itemId) }] });
      if (result.projectSkipped) toast('Its project was finished or deleted meanwhile: the thread is on its own.', { sticky: true });
      refreshLists();
      return result;
    } catch (err) {
      const error = err.body?.error || err.message || 'network error';
      const edit = () => {
        if (state.startWork) return toast('Finish or close the open sheet first; this one stays here.', { sticky: true, actions: [{ label: 'Edit', fn: edit }] });
        set({ startWork: { ...sw, sending: false, error, background: 0 } });
      };
      toast(`New thread with ${name} didn’t start: ${error}`, { sticky: true, actions: [{ label: 'Retry', fn: () => submitAgentThread(sw, { retry: true }) }, { label: 'Edit', fn: edit }] });
      return null;
    }
  }
  async function runStartWork(body, from, { counted = false } = {}) {
    // Only a Start & another counts in the open sheet's "N starting".
    const finishBackground = () => {
      if (counted && state.startWork?.background) set({ startWork: { ...state.startWork, background: Math.max(0, state.startWork.background - 1) } });
    };
    try {
      const result = await answerWithin(client.startWork(body), START_TIMEOUT_MS);
      finishBackground();
      if (state.startWork) void loadStartOptions();
      const extras = result.plan.attachments ? ` with ${result.plan.attachments} image${result.plan.attachments > 1 ? 's' : ''}` : '';
      // On Loom the account is Loom's business (it moves the thread when one runs low): only a pin is worth saying.
      const where = result.plan.account.driver === 'loom' ? (result.plan.pin ? ` pinned to ${result.plan.account.name.replace(/^Loom · /, '')}` : '') : ` on ${result.plan.account.name}`;
      toast(`Started in ${result.plan.repo.name}${where}${extras}: “${result.plan.title}”. It's in your List as Working.`, { ms: 7000 });
      if (result.projectSkipped) toast('Its project was finished or deleted meanwhile: the thread is on its own.', { sticky: true });
      refreshLists();
      return result;
    } catch (err) {
      finishBackground();
      const check = err.body?.check;
      const error = check && !check.ready ? [check.question, ...(check.problems || [])].filter(Boolean).join(' ') : err.body?.error || err.message || 'network error';
      const open = state.startWork;
      const failed = { form: { ...from.form, acctOpen: false }, commandId: body.commandId, projectId: from.projectId ?? null, sending: false, error };
      if (counted && open && !open.form.prompt.trim() && !open.form.attachments.length) {
        // Start & another, and the sheet it left is still empty: put the one that failed back, with why, to fix and retry.
        // A sheet opened afresh since is the owner's new one (its picks stay); this one waits in the toast (Codex review on #644).
        set({ startWork: { ...open, ...failed } });
        return null;
      }
      const edit = () => {
        if (state.startWork) return toast('Finish or close the open sheet first; this one stays here.', { sticky: true, actions: [{ label: 'Edit', fn: edit }] });
        set({ startWork: { options: from.options, loading: !from.options, loadError: null, background: 0, ...failed } });
        void loadStartOptions();
      };
      const actions = [{ label: 'Edit', fn: edit }];
      // A readiness question (or a missing repo) needs the owner's edit; anything else is worth one more try as sent.
      if (!(check && !check.ready)) actions.unshift({ label: 'Retry', fn: () => runStartWork(body, from) });
      toast(`New thread didn’t start (“${body.title || titleFromPrompt(from.form.prompt)}”): ${error}`, { sticky: true, actions });
      return null;
    }
  }

  async function draftCommand(action) {
    // The tap is for the draft on screen now; the desk refuses it if another draft replaced that one.
    const draftId = state.draft?.id || null;
    if (action === 'dismiss') set({ draft: blankDraft() });
    else set({ draftPending: action });
    try {
      await answerWithin(client.draftCommand(action, draftId));
    } catch (err) {
      if (state.draftPending === action) set({ draftPending: null });
      if (action !== 'dismiss') toast(`${action === 'send' ? 'Send' : 'Cancel'} didn’t go through: ${err.body?.error || err.message}`);
    } finally {
      // The operator's next card says what happened; don't leave the buttons disabled if it never comes.
      setTimeout(() => state.draftPending === action && set({ draftPending: null }), 4000);
    }
  }

  // ── pause mode: a tap on the pill asks the operator to resume (it owns the pause) ──
  async function resumePause() {
    const pauseId = state.pause?.id || null;
    if (!state.pause?.active || !pauseId || state.pausePending) return;
    set({ pausePending: true });
    try {
      await answerWithin(client.pauseCommand('resume', pauseId));
    } catch (err) {
      set({ pausePending: false });
      toast(`Resume didn’t go through: ${err.body?.error || err.message}`);
      return;
    }
    // The operator's next pill says it resumed; don't leave the pill stuck on "Resuming…" if it never comes.
    setTimeout(() => state.pausePending && set({ pausePending: false }), 4000);
  }

  // ── stream handlers ────────────────────────────────────────────────
  const handlers = {
    onStatus: (online) => online !== state.online && set({ online }),
    onResync: () => {
      refreshLists(0);
      loadSettings();
      loadCoordinators();
      // Posts written while the stream was down aren't replayed (Codex review on #595); they show at once.
      loadFeed({ settle: true });
      if (state.coordinator) loadCoordinator(state.coordinator.projectId);
      client.presentation().then(receivePresentation, () => {});
      if (state.detail?.id) loadDetail(state.detail.id);
    },
    onItem: (d) => {
      refreshLists();
      if (d && state.detail?.id === d.id) loadDetail(d.id);
      // The coordinator's own thread moved (an answer arrived).
      if (d && state.coordinator?.view?.itemId === d.id) loadCoordinator(state.coordinator.projectId);
    },
    /** A project's coordinator changed (Keep watch, a new status, a draft, an answer relayed). */
    onCoordinator: (summary) => {
      if (!summary?.projectId) return;
      confirmedWatch.set(summary.projectId, summary);
      showWatch(summary.projectId);
      if (state.coordinator?.projectId === summary.projectId) loadCoordinator(summary.projectId);
    },
    onPresentation: receivePresentation,
    /** Another screen (or this one) changed the filters or the sweep day. */
    onSettings: (settings) => {
      if (!settings) return;
      for (const field of ['agentIcons', 'repoIcons']) {
        if (!settings[field]) continue;
        iconSeqs[field] += 1; // the server's newest: a save still in flight mustn't overwrite it (Codex review on #608)
        set({ [field]: settings[field] });
      }
      // The desk's list, with this screen's toggles still on their way over it (Codex review on #671).
      if (Array.isArray(settings.mailOff)) set({ mailOff: confirmMail(settings.mailOff) });
      if (settings.spaces && typeof settings.spaces === 'object') {
        for (const key of Object.keys(spaceSeqs)) spaceSeqs[key] += 1; // the server's newest: a save still in flight mustn't overwrite it
        set({ spaces: settings.spaces });
      }
      if (Array.isArray(settings.projectSectionsHidden)) {
        sectionsSeq += 1; // the server's newest: a save still in flight mustn't overwrite it
        set({ projectSectionsHidden: settings.projectSectionsHidden });
      }
      if (settings.feed && JSON.stringify(settings.feed) !== JSON.stringify(state.feedSettings)) {
        feedSettingsSeq += 1; // the server's newest: a save still in flight mustn't overwrite it
        set({ feedSettings: settings.feed });
        feedChanged({ settle: true });
      }
      if (settings.labelOrder) {
        confirmedLabelOrder = settings.labelOrder;
        // The echo of this screen's own save: confirmed, but a newer reorder still on its way keeps showing. Another
        // screen's order is newer than any save of ours still on its way, so it shows (Codex review on #671).
        const echo = labelSent.has(JSON.stringify(settings.labelOrder));
        if (!echo) labelOrderSeq += 1;
        if (!echo || labelSaves === 0) set({ labelOrder: settings.labelOrder });
      }
      if (settings.snoozeTimes) {
        snoozeTimesSeq += 1; // the server's newest: a save still in flight mustn't overwrite it
        set({ snoozeTimes: snoozeTimesOf(settings.snoozeTimes) });
      }
      // The desk's newest: it outranks any read or save answer asked for before it came.
      if (Array.isArray(settings.projects)) confirmProjects(settings.projects, settings.projectsRev || 0, projectTick());
      // The views, unless a save of this screen's is still on its way: its answer settles them.
      if ('spaceViews' in settings && !spaceViewSaves) {
        spaceViewsSeq += 1;
        set({ spaceViews: settings.spaceViews || null });
      }
      if ('listViews' in settings && !viewSaves) {
        viewsSeq += 1; // the server's newest: a save still in flight mustn't overwrite it
        set({ listViews: settings.listViews || null });
        feedChanged({ settle: true });
      }
      if (settings.filters) {
        // The server's newest state: any save still in flight must not overwrite or roll it back.
        filterSeq += 1;
        set({ filters: normalizeFilters(settings.filters) });
      }
      refreshLists(0);
      if (state.filterOpen) loadFacets();
    },
    onActivity: (event) => {
      if (!event) return;
      if (state.activity.open) set({ activity: { ...state.activity, events: [event, ...state.activity.events.filter((e) => e.seq !== event.seq)] } });
    },
    onOperator: (o, { replay = false } = {}) => {
      if (!o) return;
      // A session starting or ending starts the captions over: no last line from the session before (Codex review on #532).
      const boundary = typeof o.live === 'boolean' && o.live !== state.operator.live;
      let captions = boundary ? [] : state.captions;
      const t = o.transcript;
      if (t && t.text) {
        const line = { speaker: t.speaker, name: t.name || o.agentName, text: t.text, final: t.final !== false };
        const last = captions[captions.length - 1];
        // The stream's hello replays the latest line on every reconnect: the same line again is not a new one
        // (a real "yes", then "yes" again, is two).
        const same = replay && last && last.speaker === line.speaker && last.text === line.text && last.final === line.final;
        if (!same) captions = last && !last.final && last.speaker === line.speaker ? [...captions.slice(0, -1), line] : [...captions, line];
        captions = captions.slice(-4);
      }
      set({ operator: { ...state.operator, ...o }, captions });
    },
    onDraft: (card) => card && set({ draft: card, draftPending: null }),
    // A deploy restarted the service with new code: this page reloads (reply drafts are kept in storage), or,
    // while the owner is typing, offers to.
    onBuild: (build) => {
      if (!pageBuild) return void (pageBuild = build);
      if (build === pageBuild || build === promptedFor) return;
      const typing = /^(input|textarea)$/i.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (!typing) return location.reload();
      promptedFor = build;
      toast('The desk was updated', { sticky: true, action: { label: 'Reload', fn: () => location.reload() } });
    },
    onPause: (card) => card && set({ pause: card, pausePending: false }),
    onFeed: () => feedChanged(),
    onUpdates: () => updatesChanged(),
    // The ledger changed: the System page (and the sidebar's chip) read again, once one has read it.
    onSystem: () => {
      if (state.system) void loadSystem();
      const r = state.nextRoute;
      if (r?.page === 'system' && r.id && state.systemJobs[r.id]) void loadSystemJob(r.id);
    },
    onHello: (h) => set({ screenId: h.screenId, operator: { ...state.operator, live: h.operatorLive || state.operator.live } }),
    onDashboard: (d) =>
      set({
        operator: { ...state.operator, live: d.operatorLive },
        ...(d.windows ? { windows: d.windows } : {}),
        ...(d.liveSceneIds ? { live: { scenes: d.liveSceneIds, prototypes: d.livePrototypes || state.live.prototypes, sceneList: d.liveScenes || state.live.sceneList } } : {}),
      }),
    // Another window's Settings changed what this one is for.
    onRole: (d) => { if (d?.role) applyRole(d.role); if (d?.feedScope !== undefined) applyFeedScope(d.feedScope); },
    onShow: (d) => {
      if (d?.scene) {
        const prev = state.scenes[d.scene.id];
        set({ scenes: { ...state.scenes, [d.scene.id]: { ...prev, ...d.scene, _updated: !!d.updated } } });
      }
    },
    onAck: (a) => {
      const what = a.label ? `“${a.label}”` : 'that';
      if (a.routed === 'operator' || a.routed === 'agent') toast(`Sent ${what} to ${a.agentName}`);
      else toast(`${a.agentName} couldn’t be reached`);
    },
  };

  async function start() {
    // The lists wait for what this device kept (to send its ETags), never long: a slow or broken IndexedDB is skipped.
    void Promise.race([restoreLists().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 300))]).then(() => LIST_VIEWS.forEach((view) => loadList(view)));
    loadSettings();
    loadCoordinators();
    loadFeed();
    try {
      applyPresentation(await client.presentation());
    } catch {
      /* no presentation endpoint yet: stay on the board */
    }
    setInterval(() => set({ now: Date.now() }), 15000);
    // A draft in its undo window counts down every second (and its Undo goes away on time).
    setInterval(() => {
      const until = state.draft?.status === 'sending' ? state.draft.undoUntil : null;
      if (until && Date.now() < until + 1000) set({ now: Date.now() });
    }, 250);
  }

  const searchActions = createSearchActions({ client, get: () => state, set, openItem, goHome: goBoard });

  return {
    ...searchActions,
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set,
    handlers,
    start,
    restoreLists,
    toast,
    dismissToast,
    refreshLists,
    loadList,
    projectItems,
    projectAction,
    openFilters,
    openSettings,
    setWindowRole,
    setWindowFeedScope,
    saveFeedSettings,
    loadCapacity,
    loadSystem,
    loadChapter,
    chapterAct,
    smallerSeen,
    chapterLine,
    chapterAnswer,
    resolveAsk,
    replyAsk,
    deferAsk,
    loadCatchup,
    loadDecisionIds,
    loadDecision,
    openDecision,
    closeDecision,
    reverseDecided,
    ruleDecided,
    dropRuleTap,
    loadReview,
    seeReview,
    briefRuleOf,
    setBriefRule,
    loadSystemJob,
    systemCommand,
    moveThread,
    accountHistory,
    loadRouting,
    saveRouting,
    resolveScene,
    openScreenWindow,
    searchIcons,
    closeFilters,
    toggleFilter,
    clearFilters,
    showFiltered,
    loadDetail,
    present,
    openItem,
    goBoard,
    showConversation,
    showScreen,
    showPrototype,
    command,
    lastCommand,
    retryReceipt,
    retryCommand,
    setDraft,
    draftFor,
    imagesFor,
    addReplyImages,
    removeReplyImage,
    openLightbox,
    openReply,
    closeReply,
    openSheet,
    closeSheet,
    sendReply,
    setSendStay,
    answer,
    pendingDraft,
    pendingPick,
    pendingToggleOther,
    pendingOther,
    answerPending,
    submitPending,
    approve,
    dismissPending,
    done,
    sendDone,
    openSnooze,
    chooseSnooze,
    quickSnooze,
    snoozeChoices,
    undo,
    toggleActivity,
    loadActivity,
    draftCommand,
    resumePause,
    openStartWork,
    closeStartWork,
    setStartField,
    setStartProject,
    pickStartPlace,
    submitStartWork,
    startOwner,
    setListTab,
    goListHome,
    setListGroup,
    openProject,
    setProject,
    saveProjects,
    openProjectSnooze,
    parkProject,
    wakeProject,
    finishProject,
    setProjectParent,
    reopenProject,
    toggleListSection,
    toggleWorkers,
    togglePanel,
    openCoordinator,
    loadCoordinator,
    askCoordinator,
    retryQuestion,
    dropQuestion,
    setCoordinatorWatch,
    mailDraft,
    coordinatorDraft,
    setSideTab,
    openSideTab,
    setLabel,
    setTags,
    setRole,
    handOff,
    setAgentSpace,
    saveSpace,
    saveListViews,
    saveSpaceViews,
    setPageView,
    park,
    setPinned,
    setMailOff,
    rename,
    watchPr,
    saveLabelOrder,
    saveProjectSectionsHidden,
    setProjectSections,
    saveSnoozeTimes,
    saveAgentIcons,
    saveRepoIcons,
    addStartAttachments,
    removeStartAttachment,
    retry: (itemId) => command('retry', itemId),
    runJob,
    pauseJob,
    stop: (itemId) => command('stop', itemId),
    keepSession,
    raiseBudget,
    freshStart,
    seen: (itemId) => command('seen', itemId),
    // Read or unread wherever it is (Snoozed, Parked, Done too); it stays there, and nothing goes to the source.
    // The guard an action on this item sends (bulk actions use it too): none while its own prediction is showing.
    guardFor: (itemId) => asSeen(itemId),
    markRead: (itemId, read) => command(read ? 'seen' : 'unseen', itemId, { ...(read ? { via: 'read' } : {}), ...asSeen(itemId) }).then((r) => r.status === 'sent' && toast(read ? 'Marked read' : 'Marked unread')),
    // Guarded as Pick up is: refused if the agent posted since (a Done prediction may still show it finished; Codex review on #671).
    reopen: (itemId) => command('reopen', itemId, asSeen(itemId)),
    pickup: (itemId) => command('pickup', itemId, asSeen(itemId)).then((r) => r.status === 'sent' && toast('Back in Active')),
    sweep,
    nudge: (itemId) => sendReply(itemId, 'status?'),
    nudgeWaiting: (itemId) => {
      const w = state.byId[itemId]?.watching?.waitingOn;
      if (w) return sendReply(itemId, `Can you nudge ${w.who} on ${w.what}?`);
    },
  };
}
