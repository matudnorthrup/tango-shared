import { startNavigatorBridge } from './navigator-bridge.js';
// Agent Desk entry point: picks the data layer, wires the store, the scene stage
// and the streams, and renders the view the presentation hub says is up.

import { html, render, useEffect, useState } from '../vendor/preact-htm.js';
import { createLiveClient } from './api.js';
import { nextListReport } from './next/model.js';
import { prototypeFor, sceneFor } from './chrome.js';
import { ActivityDrawer, ConfirmDialog, RenameDialog, SnoozePicker, Toasts } from './overlays.js';
import { StartWorkSheet } from './start-work.js';
import { FinishProjectDialog, ProjectEditor } from './projects-editor.js';
import { TranscriptSheet } from './search.js';
import { applyPreviewLines, applyTextScale, savedPreviewLines, savedTextScale } from './filters.js';
import { SettingsPanel } from './settings.js';
import { prototypeStage } from './prototype.js';
import { createProtoNav } from './proto-nav.js';
import { ScreenWindow } from './screen-window.js';
import { roleOf, screenHold, stageKey, viewFor } from './role.js';
import { createStage, scrollDocument } from './stage.js';
import { createStore } from './store.js'
import { createListCache } from './list-cache.js';
import { createNextNav, dropLayoutChoice } from './next/nav.js';
import { FinishProjectsDialog } from './next/select.js';
import { NextShell } from './next/app.js';
import { DecisionSheet } from './next/decision.js';
import { DECISION_PATH, decisionOfLink, onKnownDecisions, wantDecisionIds } from './decision-links.js';
import { keysCovered, onHistoryKey } from './next/keyboard.js';
import { createTraceReporter, renderKey, renderLine, toastKind } from './trace.js';

const params = new URLSearchParams(location.search);
const fixtures = params.get('fixtures') === '1';
// ?detached=1: this window keeps its own presentation and never moves (or follows) the owner's windows (api.js).
const detached = params.get('detached') === '1';
// What this window is for (role.js): ?role=control keeps scenes off it, ?role=screen shows only them.
const initialRole = roleOf(params.get('role'));
// The classic layout is retired: an old ?ui= link or saved choice is dropped (docs/specs/agent-desk-next.md).
dropLayoutChoice();

/** The next layout's stylesheet, once: its rows (next/rows.js) are scoped to their own classes. */
function nextCss() {
  if (document.querySelector('link[data-next-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'desk-next.css';
  link.dataset.nextCss = '';
  document.head.appendChild(link);
}

async function boot() {
  applyTextScale(savedTextScale());
  applyPreviewLines(savedPreviewLines());
  const client = fixtures
    ? (await import('./fixtures.js')).createFixtureClient({ params })
    : createLiveClient({ screenName: params.get('name') || '', screenRole: () => store.state.role, detached });
  const store = createStore(client, { role: initialRole, listCache: client.mode === 'live' ? createListCache() : null });
  Object.assign(store, createNextNav(store));
  if (!fixtures && !detached) startNavigatorBridge(store, { name: params.get('name') || 'Desk window' });
  // Agents' pictures for the tiles (desk/agents.ts on the server).
  client.agents?.().then((r) => store.set({ agents: r.agents || [] })).catch(() => {});
  nextCss();
  document.documentElement.classList.add('ui-next');
  const protoNav = createProtoNav();
  const stage = createStage({
    client,
    onToast: (t) => store.toast(t),
    // Escape pressed inside the frame on screen: the desk's own Escape (the stage steps back one crumb).
    onEscape: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    // The prototype's bridge: relayed to the service (for the operator), and kept for the bar.
    onPrototype: (prototypeId, message) => {
      if (message.type === 'proto-page' && message.page) {
        protoNav.page(prototypeId, message.page.path);
        store.set({ prototypePage: { prototypeId, ...message.page } });
        client.prototypePage?.(prototypeId, message.page).catch(() => {});
      } else if (message.type === 'proto-activity') {
        client.prototypeActivity?.(prototypeId).catch(() => {});
      } else if (message.type === 'proto-result') {
        if (!message.ok && message.detail) store.toast(`Couldn’t ${message.name.replace('_', ' ')}: ${message.detail}`);
        client.prototypeResult?.(prototypeId, { name: message.name, commandId: message.commandId || undefined, ok: !!message.ok, detail: message.detail || '' }).catch(() => {});
      }
    },
  });
  const phoneQuery = window.matchMedia('(max-width: 699px)');
  // Any touch input at any width (an iPad, a touchscreen laptop): the List swipes there too.
  const touchQuery = window.matchMedia('(any-pointer: coarse)');
  // Whether the main pointer can hover: then the hover icons stay as well (a touchscreen laptop gets both).
  const hoverQuery = window.matchMedia('(hover: hover)');
  const unlockButton = document.getElementById('unlock');
  const offline = document.getElementById('offline');
  let audioUnlocked = false;

  // ── the stage follows the presentation ─────────────────────────────
  // A screen window shows a scene or prototype while its conversation is open, else the feed (role.js).
  // Only something newly put up takes it: a scene sent back to the feed doesn’t return on the next render.
  let held = null;
  let lastStage;
  const holdFor = (state) => {
    if (state.role !== 'screen') {
      // Back to Screen later: what is up then counts as newly put up (Codex review on #576).
      lastStage = undefined;
      return (held = null);
    }
    const key = stageKey(state.presentation);
    if (state.presentation.stageIdle) {
      // Left alone (hub.ts idleScreens): the feed, until the next move puts something new up. One the owner
      // brought back from the feed stays, as it does when the desk moves on.
      lastStage = key;
      if (!held?.pinned) held = null;
    }
    const fresh = key !== lastStage;
    lastStage = key;
    return (held = screenHold(held, state.presentation, state.live, fresh));
  };
  // The Screen window's own choices: back to the feed, or a screen picked from a feed post.
  const backToFeed = () => {
    held = null;
    store.set({});
  };
  const pickScreen = (r) => {
    held = r.kind === 'scene' ? { kind: 'scene', id: r.id, conversationKey: r.conversationKey, pinned: true } : { kind: 'prototype', prototype: r.prototype, conversationKey: r.conversationKey, pinned: true };
    if (r.kind === 'scene' && !store.state.scenes[r.id]) store.resolveScene(r.id);
    store.set({});
  };
  const heldStage = (state) => {
    const h = holdFor(state);
    if (!h) return null;
    return h.kind === 'scene' ? state.scenes[h.id] || null : prototypeStage(h.prototype, client);
  };
  let lastScene = null;
  store.subscribe((state) => {
    // The Screen view's scene, or the Prototype view's page: both go full bleed in the stage frames.
    // A control window never shows them; a screen window shows what it holds.
    const proto = state.role === 'full' ? prototypeFor(state) : null;
    const scene =
      state.role === 'control' ? null : state.role === 'screen' ? heldStage(state) : state.presentation.view === 'screen' ? sceneFor(state) : proto ? prototypeStage(proto, client) : null;
    const key = scene ? `${scene.id}@${scene.version}` : null;
    if (key === lastScene) return;
    const reloaded = !!(scene?.kind === 'prototype' && lastScene && lastScene.startsWith(`${scene.id}@`));
    lastScene = key;
    stage.show(scene, { updated: !!scene?._updated || reloaded });
    unlockButton.hidden = audioUnlocked || !scene || scene.kind !== 'video';
  });

  // ── session trace: what this screen actually rendered, and the errors it showed (/trace) ──
  // Named with ?name= (e.g. ?name=kitchen); otherwise the hub's id and the screen's shape.
  const tracer = createTraceReporter({ send: client.trace });
  const screenLabel = () => params.get('name') || `${phoneQuery.matches ? 'phone' : 'desk'}${store.state.screenId ? ` ${store.state.screenId}` : ''}`;
  const screenData = () => ({ screenId: store.state.screenId, screenName: params.get('name') || null, role: store.state.role, phone: phoneQuery.matches, visible: document.visibilityState === 'visible' });
  let lastRender = null;
  let lastToast = 0;
  let wasOnline = null;
  let offlineSince = 0;
  // What this window actually draws (role.js): a control window's conversation, a screen window's held scene
  // or prototype, not the presentation as such (Codex review on #571).
  const drawn = (state) => {
    const p = state.presentation;
    if (state.role === 'control') return { ...p, view: viewFor('control', p) };
    if (state.role !== 'screen') return p;
    const h = holdFor(state);
    if (h?.kind === 'scene') return { ...p, view: 'screen', sceneId: h.id };
    if (h) return { ...p, view: 'prototype', prototypeId: h.prototype.id, prototype: h.prototype };
    return { ...p, view: 'active' };
  };
  store.subscribe((state) => {
    const p = drawn(state);
    const scene = p.view === 'screen' && p.sceneId ? state.scenes[p.sceneId] || null : null;
    const key = `${state.role}:${renderKey(p, scene)}`;
    if (key !== lastRender) {
      lastRender = key;
      const item = p.itemId ? state.byId[p.itemId] || (state.detail?.id === p.itemId ? state.detail.item : null) : null;
      const line = state.role === 'screen' && p.view === 'active' ? 'the feed' : renderLine(p, { scene, item });
      tracer.report({
        kind: 'render',
        summary: `${screenLabel()}${state.role === 'full' ? '' : ` (${state.role})`} shows ${line}`,
        data: { ...screenData(), view: p.view, itemId: p.itemId || null, conversationKey: p.conversationKey || null, sceneId: p.sceneId || null, sceneVersion: scene?.version ?? null, by: p.by || null, reason: p.reason || null, presentationSince: p.since || null },
      });
    }
    for (const t of state.toasts) {
      if (t.id <= lastToast) continue;
      lastToast = t.id;
      tracer.report({ kind: toastKind(t.text), summary: `${screenLabel()} toast: ${t.text}`, data: { ...screenData(), text: t.text } });
    }
    if (state.online !== wasOnline) {
      // Only a drop after being online counts (the first connect is not a reconnect).
      if (state.online && offlineSince) tracer.report({ kind: 'connection', summary: `${screenLabel()} reconnected after ${Math.round((Date.now() - offlineSince) / 1000)} s offline`, data: { ...screenData(), offlineMs: Date.now() - offlineSince } });
      offlineSince = !state.online && wasOnline === true ? Date.now() : state.online ? 0 : offlineSince;
      wasOnline = state.online;
    }
  });

  // A text box that had the cursor and was redrawn away (a move on any window, a list refresh): the trace says so,
  // so "my dictation didn't land" can be matched to what took the box (Wispr pastes only into a focused box).
  document.addEventListener('focusout', (event) => {
    const box = event.target;
    if (!/^(textarea|input)$/i.test(box?.tagName || '') || event.relatedTarget) return;
    const label = box.getAttribute('aria-label') || box.placeholder || box.tagName.toLowerCase();
    setTimeout(() => {
      if (box.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
      const p = store.state.presentation;
      tracer.report({ kind: 'focus.dropped', summary: `${screenLabel()} lost the cursor: “${label}” was redrawn away (now ${p.view}${p.itemId ? ` ${p.itemId}` : ''})`, data: { ...screenData(), box: label, view: p.view, itemId: p.itemId || null, by: p.by || null, route: store.state.nextRoute || null } });
    }, 0);
  }, true);

  // ── streams ────────────────────────────────────────────────────────
  client.connect({
    ...store.handlers,
    onHello: (h) => {
      store.handlers.onHello(h);
      // Back after an outage: a scene this Screen window holds (no longer the one up) may have moved on meanwhile.
      const h0 = held;
      if (h0?.kind !== 'scene' || store.state.presentation.sceneId === h0.id) return;
      store.resolveScene(h0.id).then((scene) => {
        if (scene && stage.showing?.id === scene.id) stage.post({ type: 'state', state: scene.state || {} });
      });
    },
    onStatus: (online) => {
      store.handlers.onStatus(online);
      offline.hidden = online;
    },
    onState: (d) => {
      const showing = stage.showing;
      if (showing && showing.id === d.sceneId) stage.post({ type: 'state', state: d.state });
    },
    onCommand: (d) => {
      const showing = stage.showing;
      if (d.prototypeId) {
        // A voice command for the prototype on screen: its bridge runs it.
        if (!showing || showing._prototypeId !== d.prototypeId) return;
        if (d.name === 'back') {
          // On its first page, back would take the desk itself back: say so instead.
          if (!protoNav.canGoBack(d.prototypeId)) {
            client.prototypeResult?.(d.prototypeId, { name: 'back', commandId: d.commandId || undefined, ok: false, detail: 'already on the first page of the prototype' }).catch(() => {});
            return;
          }
          protoNav.goingBack();
        }
        stage.post({ type: 'command', name: d.name, args: d.args || {}, commandId: d.commandId || null });
        return;
      }
      // Voice moving the List ("the Watching tab", "open the Voice project", "back to the List"): every screen follows.
      // A tab is an Inbox view, a project its page.
      if (d.name === 'list_tab' && typeof d.args?.tab === 'string') return store.nextGo({ page: 'inbox', view: d.args.tab });
      if (d.name === 'list_back') return store.nextBack();
      if (d.name === 'list_place' && d.args?.page === 'inbox') return store.nextGo({ page: 'inbox', view: store.state.listTab });
      // Catch me up by voice: the page, on the walk's focus with its skips (docs/specs/catch-up.md, "Voice").
      if (d.name === 'list_place' && d.args?.page === 'catchup') {
        const ids = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : []);
        store.set({ catchupFollow: { focus: Number.isInteger(d.args.focus) ? d.args.focus : null, skipped: ids(d.args.skipped), at: Date.now() } });
        return store.nextGo({ page: 'catchup' });
      }
      if (d.name === 'list_place' && ['projects', 'agents', 'agent', 'capacity', 'system'].includes(d.args?.page)) return store.nextGo({ page: d.args.page, ...(typeof d.args.id === 'string' ? { id: d.args.id } : {}) });
      // A view of the page on screen ("the Workers view" on a space): the pick its pills make (pages.js usePageView).
      if (d.name === 'list_view' && typeof d.args?.view === 'string') {
        const route = store.state.nextRoute || {};
        if (!route.page || route.page === 'inbox') return store.nextGo({ page: 'inbox', view: d.args.view });
        if (route.page === 'system') return store.nextGo({ page: 'system', view: d.args.view });
        const key = route.id ? `${route.page}:${route.id}` : route.page;
        return store.setPageView(key, d.args.view);
      }
      if (d.name === 'list_project') {
        const project = typeof d.args?.project === 'string' ? d.args.project : null;
        return store.nextGo(project ? { page: 'project', id: project } : { page: 'inbox', view: store.state.listTab });
      }
      if (showing && showing.id === d.sceneId) stage.post({ type: 'command', name: d.name });
      else if (!showing && d.sceneId === null) scrollDocument(d.name);
    },
  });

  // ── the List, for voice ────────────────────────────────────────────
  // What this screen's List shows goes to the hub, with when the owner last touched this screen: the
  // operator resolves "the third one" and "the Watching tab" against the screen they're looking at.
  let touchedAt = 0;
  let reported = '';
  let reportTimer = null;
  const reportList = () => {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const { screenId } = store.state;
      // A screen window has no List: voice resolves "the third one" against the windows that do.
      if (!screenId || !client.listPage || store.state.role === 'screen') return;
      const page = nextListReport(store.state);
      const key = JSON.stringify([screenId, page, touchedAt]);
      if (key === reported) return;
      reported = key;
      client.listPage(screenId, page, touchedAt).catch(() => {
        reported = '';
      });
    }, 400);
  };
  store.subscribe(reportList);
  const touched = () => {
    touchedAt = Date.now();
    reportList();
  };
  document.addEventListener('pointerdown', touched, { capture: true, passive: true });
  document.addEventListener('keydown', touched, { capture: true });

  // ── audio unlock, wake lock ────────────────────────────────────────
  const unlockAudio = () => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    unlockButton.hidden = true;
    client.unlockAudio(store.state.screenId).catch(() => {});
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  unlockButton.addEventListener('click', unlockAudio);

  const keepAwake = () => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').catch(() => {});
  };
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  // ── "viewed": a conversation open ≥ 3 s counts as seen ─────────────
  // News while it stays open (the agent writing as the owner reads) is seen too: it counts as a new look, so the
  // row's unread dot doesn't come back under the owner's eyes (owner, 10/21).
  let viewTimer = null;
  let viewedKey = null;
  store.subscribe((state) => {
    const p = state.presentation;
    const open = viewFor(state.role, p) === 'conversation' && p.itemId ? p.itemId : null;
    const news = open && state.byId[open]?.seen !== 'seen' ? state.byId[open]?.attentionUpdatedAt ?? '' : '';
    const key = open ? `${open}@${p.since}#${news}` : null;
    if (key === viewedKey) return;
    viewedKey = key;
    clearTimeout(viewTimer);
    if (!key) return;
    const itemId = p.itemId;
    const opened = Date.now();
    viewTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      const item = store.state.byId[itemId] || store.state.detail?.item;
      // Seen already counts, except a guessed label the owner hasn't looked at yet (the List's dot),
      // or a new Loom thread whose guess hasn't come in: a look now means no dot later (Codex review on #515).
      const f = item?.facts || {};
      const guessing = (item?.source === 'loom') && !f.autoTag && f.type === undefined && f.stage === undefined;
      if (item && item.seen === 'seen' && !f.autoTag?.unconfirmed && !guessing) return;
      store.command('viewed', itemId, { ms: Date.now() - opened }, { quiet: true });
    }, 3000);
  });

  // ── presence: "until I'm at my desk" snoozes fire when the owner shows up at a screen ──
  // A ping when the page becomes visible and on interaction, at most once a minute.
  let lastPresence = 0;
  const presence = () => {
    if (document.visibilityState !== 'visible' || !client.presence) return;
    const now = Date.now();
    if (now - lastPresence < 60_000) return;
    lastPresence = now;
    client.presence().catch(() => {});
  };
  document.addEventListener('visibilitychange', presence);
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, presence, { passive: true });
  // Reading counts too: a visible, focused desk is the owner at work (level 3 veto windows run on active time).
  setInterval(() => { if (document.hasFocus()) presence(); }, 60_000);
  presence();

  // ── decision ids are links (TGO-1110): D-67 in any text opens that brief over the desk ───────────
  // A link to a decision page, whatever its address (this desk's /decision/D-67, or the tailnet one an agent wrote),
  // opens over the desk instead of leaving it; a modified click still opens the address (a new tab).
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const id = decisionOfLink(event.target?.closest?.('a'));
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    store.openDecision(id);
  }, true);
  // The page is a sheet over everything, so its Escape wins even with the cursor in a box behind it (a reply box
  // keeps its own Escape and would stop this one on the way up).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !store.state.decisionPage) return;
    event.preventDefault();
    event.stopPropagation();
    store.closeDecision();
  }, true);
  // Which ids are links: Loom's decisions, read now and again when text names one above the newest known.
  wantDecisionIds(() => void store.loadDecisionIds());
  onKnownDecisions(() => store.set({}));
  void store.loadDecisionIds(true);
  setInterval(() => void store.loadDecisionIds(), 60_000);
  // Opened by address (/decision/D-67, a phone's deep link): the desk with that brief up.
  const deepLink = location.pathname.match(DECISION_PATH)?.[1];
  if (deepLink) store.openDecision(deepLink);

  // Close open dropdown pills when clicking elsewhere.
  document.addEventListener('click', (event) => {
    for (const d of document.querySelectorAll('details.ddpill[open]')) if (!d.contains(event.target)) d.open = false;
  });

  // ── keyboard ───────────────────────────────────────────────────────
  // A screen window takes no desk keys: Esc there would end the conversation on every window.
  document.addEventListener('keydown', (event) => store.state.role !== 'screen' && onKey(event, store, phoneQuery.matches));

  function App() {
    const [phone, setPhone] = useState(phoneQuery.matches);
    const [touch, setTouch] = useState(touchQuery.matches);
    const [hover, setHover] = useState(hoverQuery.matches);
    useEffect(() => {
      const fn = () => setPhone(phoneQuery.matches);
      const tfn = () => setTouch(touchQuery.matches);
      const hfn = () => setHover(hoverQuery.matches);
      phoneQuery.addEventListener('change', fn);
      touchQuery.addEventListener('change', tfn);
      hoverQuery.addEventListener('change', hfn);
      return () => {
        phoneQuery.removeEventListener('change', fn);
        touchQuery.removeEventListener('change', tfn);
        hoverQuery.removeEventListener('change', hfn);
      };
    }, []);
    const role = store.state.role;
    // What this window draws of the presentation (role.js): a control window stays off the stage.
    const view = viewFor(role, store.state.presentation);
    document.documentElement.dataset.view = role === 'screen' && holdFor(store.state)?.kind === 'prototype' ? 'prototype' : view;
    document.documentElement.dataset.role = role;
    document.documentElement.classList.toggle('is-phone', phone);
    document.documentElement.classList.toggle('is-touch', touch && !hover);
    // Any touch input: rows keep the sideways drag for the swipe, even on a touchscreen laptop.
    document.documentElement.classList.toggle('can-swipe', touch || phone);
    let body;
    if (role === 'screen') body = html`<${ScreenWindow} store=${store} held=${holdFor(store.state)} onBack=${backToFeed} onPick=${pickScreen} />`;
    // A scene or prototype: the stage under its breadcrumb, one crumb past its thread.
    else if (view === 'screen' || view === 'prototype') body = html`<${NextShell} store=${store} stage=${true} thread=${!!store.state.presentation.itemId} />`;
    else body = html`<${NextShell} store=${store} thread=${view === 'conversation'} />`;
    return html`
      ${store.state.mode === 'fixtures' ? html`<div class="fixture-tag" title="Invented data from desk/fixtures.js">fixtures</div>` : null}
      ${detached && store.state.mode !== 'fixtures' ? html`<div class="fixture-tag" title="This window keeps its own view: it doesn't move the desk's other windows or follow them">detached</div>` : null}
      ${body}
      <${ActivityDrawer} store=${store} phone=${phone} />
      <${SnoozePicker} store=${store} phone=${phone} />
      <${ConfirmDialog} store=${store} phone=${phone} />
      <${RenameDialog} store=${store} phone=${phone} />
      <${SettingsPanel} store=${store} phone=${phone} />
      <${FinishProjectDialog} store=${store} phone=${phone} />
      <${FinishProjectsDialog} store=${store} phone=${phone} />
      <${StartWorkSheet} store=${store} phone=${phone} />
      <${ProjectEditor} store=${store} phone=${phone} />
      <${TranscriptSheet} store=${store} />
      <${DecisionSheet} store=${store} phone=${phone} />
      <${Toasts} store=${store} />`;
  }

  // Re-render on every store change, subscribed before the first fetch can land (an effect-based
  // subscription runs after paint, which a hidden or throttled tab may never reach, and would miss it).
  const root = document.getElementById('app');
  store.subscribe(() => render(html`<${App} />`, root));
  render(html`<${App} />`, root);
  store.start();
  window.__desk = { store, client }; // debugging aid
}

function onKey(event, store, phone) {
  const { state } = store;
  const target = event.target;
  const typing = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
  // ⌘[ and ⌘] go back and forward, even mid-typing (next/keyboard.js).
  if (onHistoryKey(event, store)) return;
  // An image open full size takes the keys first: Esc closes it, ← → step through its set.
  if (state.lightbox) {
    const { images, index } = state.lightbox;
    if (event.key === 'Escape') store.set({ lightbox: null });
    else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && images.length > 1) store.set({ lightbox: { images, index: (index + (event.key === 'ArrowRight' ? 1 : -1) + images.length) % images.length } });
    else return;
    event.preventDefault();
    return;
  }
  // ⌘K (Ctrl-K) searches from anywhere, even mid-typing; the palette's own field takes it from there.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.nextKeys) store.set({ nextKeys: false });
    if (state.transcript) store.closeTranscript();
    if (state.search.open) store.closeSearch();
    else if (state.nextSwitcher) store.nextSwitch(false);
    else store.openSearch();
    return;
  }
  // ⌘/ (Ctrl-/) shows the keys from anywhere, even mid-typing, where ? would type a question mark.
  // Not under another menu or dialog: it waits for that to close.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === '/' || event.key === '?')) {
    event.preventDefault();
    if (state.nextKeys || !keysCovered(state)) store.set({ nextKeys: !state.nextKeys });
    return;
  }
  if (event.key === 'Escape') {
    if (typing) return; // the reply box handles its own Escape
    if (state.nextKeys) return store.set({ nextKeys: false });
    if (state.transcript) return store.closeTranscript();
    if (state.search.open) return store.closeSearch();
    if (state.search.inList && state.presentation.view === 'active') return store.clearSearch();
    if (state.sheet) return store.closeSheet();
    // Over Start work when it's making a project for the new thread: Escape closes the dialog, not the sheet.
    if (state.projectEditor) return store.set({ projectEditor: null });
    if (state.startWork) return store.closeStartWork();
    if (state.snoozeFor) return store.set({ snoozeFor: null });
    if (state.confirm) return store.set({ confirm: null });
    if (state.filterOpen) return store.closeFilters();
    if (state.activity.open) return store.toggleActivity(false);
    if (state.lists_open) return store.set({ lists_open: null });
    if (state.replyOpen) return store.closeReply();
    if (state.convoFlyout) return store.set({ convoFlyout: null });
    if (state.listMenu) return store.set({ listMenu: null });
    // The stage goes back one crumb, to its thread.
    if (store.stageUp?.()) return store.nextBack();
    // Out of a thread one crumb: a worker's or job's goes to what it reports to (next/nav.js).
    if (state.presentation.view !== 'active') return store.threadOpen?.() ? store.nextBack() : store.goBoard();
    if (state.nextSelect) return store.nextSelectEnd();
    return;
  }
  // ⌘A while a list is a picker (next/select.js): every row on the page, or none.
  if (state.nextSelect && !state.nextKeys && (event.metaKey || event.ctrlKey) && event.key === 'a' && !typing && state.presentation.view === 'active' && !state.snoozeFor && !state.confirm && !state.nextSwitcher) {
    event.preventDefault();
    store.nextSelectAll();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  // An exchange open in the Conversation view: ← → step through the exchanges.
  if (state.sheet?.kind === 'exchange' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const button = document.querySelectorAll('.rd-modal footer .btn')[event.key === 'ArrowLeft' ? 0 : 1];
    if (button && !button.disabled) button.click();
    event.preventDefault();
    return;
  }
  if (state.sheet || state.startWork || state.transcript || state.search.open || state.nextSwitcher) return;
  // The keys sheet (?) is modal: its handler swallows everything but Esc and ?.
  if (state.nextKeys) return store.nextListKey?.(event);
  // "/" searches: the switcher.
  if (event.key === '/') {
    event.preventDefault();
    store.openSearch();
    return;
  }
  // The next layout owns its visible rows and their keyboard focus, and an open thread's keys (next/keyboard.js);
  // ? anywhere, a stage too. A control window draws the thread under a stage.
  const drawn = viewFor(state.role, state.presentation);
  if (drawn === 'active' || drawn === 'conversation' || event.key === '?') store.nextListKey?.(event);
}

boot().catch((err) => {
  console.error('[desk] failed to start', err);
  document.getElementById('app').textContent = `The desk failed to start: ${err.message}`;
});

