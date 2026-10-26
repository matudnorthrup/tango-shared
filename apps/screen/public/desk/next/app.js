// The next layout's shell (docs/specs/agent-desk-next.md): the sidebar, the breadcrumb bar, the page,
// and the floating +. The center column is centered in the window and never moves for either side.

import { AppSwitcher, phoneBackCrumb } from './app-switcher.js';
import { SpaceSettingsPage } from './space-settings.js';
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { KEY_HELP, keyHelp, onListKey, watchKeyboardMode } from './keyboard.js';
import { SearchPage } from './search.js';
import { Voice } from './voice.js';
import { SEARCH_ICON } from '../search.js';
import { agentOf, agentsOf, awayWord, breakdownOf, openItems, placeTally, placesOf, routeKey, sidebarPlaces, tallyOf, threadRoute, viewIcon, crumbsOf, ownerCrumb, currentInboxView, inboxViews, threadTitle } from './model.js';
import { InboxPage, ProjectsPage, ProjectPage, AgentsPage, AgentPage } from './pages.js';
import { CatchupPage } from './catchup.js';
import { SystemPage, SYSTEM_ICON } from './system.js';
import { systemChip } from './system-model.js';
import { PANEL_FITS, ThreadPage } from './thread.js';
import { Switcher, focusSwitcher } from './switcher.js';
import { STAGE_ICONS, VIEW_ICONS } from './icons.js';
import { prototypeFor, sceneFor } from '../chrome.js';
import { PullCue, useGestures } from './gestures.js';
import { currentItem } from '../conversation.js';
import { Tile } from './rows.js';
import { contextMenuProps } from './menu.js';
import { ContextMenu } from './context.js';
import { ICON_COLORS } from '../list-model.js';
import { newProject } from '../projects-editor.js';
import { SelectBar, SelectDock } from './select.js';
import { useCatchup } from './chapter.js';
import { CATCHUP_ROUTE, catchupCounts, catchupSpaces, chapterIndex, placeDot } from './catchup-model.js';

// The sidebar fits beside the column when the margin holds it (760 column + two 304 margins: 288 sidebar, 16 gap):
// shown by default there, hidden by default below (and then it slides over the page when opened).
const SIDEBAR_FITS = '(min-width: 1368px)';
const PHONE = '(max-width: 699px)';
// A tablet held upright (an iPad in portrait): too narrow for the sidebar to fit, so the tab bar takes its
// place as on a phone. In landscape it's a small laptop and keeps the sidebar.
const TABLET_PORTRAIT = '(min-width: 700px) and (max-width: 1099px) and (orientation: portrait) and (pointer: coarse)';
// Any touch input at any width (an iPad either way up, a touchscreen laptop): pull to search works there too.
const TOUCH = '(any-pointer: coarse)';

function useMedia(query) {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOn(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return on;
}

const I = {
  inbox: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 9.5 3.6 3.7a1 1 0 0 1 1-.7h6.8a1 1 0 0 1 1 .7L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/></svg>`,
  side: html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/></svg>`,
  menu: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>`,
  back: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>`,
  plus: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
  folder: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>`,
  agents: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.4 2.6-3.7 5-3.7s4.4 1.3 5 3.7"/></svg>`,
  gear: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
};

/** The only status count is what needs the owner (owner, 10/20). */
function Count({ waiting }) {
  return waiting ? html`<span class="sr-only">, ${waiting} need you</span><span class="nx-cnt" aria-hidden="true"><span class="w">${waiting}</span></span>` : null;
}

/** The breakdown beside a sidebar row: on hover, or a long-press on a touch screen. */
function SideTip({ tip }) {
  if (!tip) return null;
  return html`<div class="nx-tip" role="tooltip" style=${`top:${tip.top}px;left:${tip.left}px`}>
    <h4>${tip.title}</h4>
    ${tip.nest
      ? html`<ul class="nest">${tip.nest.map((l) => html`<li class=${l.here ? 'here' : 'sub'}><b>${l.waiting || ''}</b>${l.label}${l.away ? html`<span class="away"> · ${l.away}</span>` : null}</li>`)}</ul>`
      : tip.lines.length
        ? html`<ul>${tip.lines.map(([n, label, color]) => html`<li class=${color === 'dim' ? 'away' : ''} style=${color ? `--c:var(--${color})` : ''}>${color ? html`<i></i>` : null}<b>${n}</b>${label}</li>`)}</ul>`
        : html`<p>Nothing here.</p>`}
  </div>`;
}

const LONG_PRESS_MS = 450;
const MAX_PLACES = 8;

/** An Inbox view's breakdown lines: by status when it holds more than one, else by place (the most first, then "N more"). */
function sideLines(tally, items, projects = []) {
  return tally.waiting ? [[tally.waiting, 'needs you', 'move']] : [];

}

/** Hover and long-press for the sidebar's breakdowns. A long-press shows the tip and swallows the tap that ends it. */
function useSideTip() {
  const [tip, setTip] = useState(null);
  const press = useRef({ timer: 0, shown: false, touchAt: 0 }).current;
  useEffect(() => {
    if (!tip?.below) return undefined;
    // A long-press tip stays until the next touch anywhere.
    const close = () => setTip(null);
    const t = setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
    return () => (clearTimeout(t), document.removeEventListener('pointerdown', close));
  }, [tip]);
  const show = (el, content, below) => {
    const r = el.getBoundingClientRect();
    setTip(below ? { ...content, below, top: r.bottom + 4, left: r.left + 8 } : { ...content, top: r.top - 4, left: r.right + 12 });
  };
  // `menu` is the row's context menu props (right-click, the menu key); on a touch screen the press shows the breakdown instead.
  const bind = (content, menu = {}) => ({
    ...menu,
    // A touch screen's emulated mouseenter after a tap or a long-press is not a hover.
    onMouseEnter: (e) => content && Date.now() - press.touchAt > 1000 && show(e.currentTarget, content, false),
    onMouseLeave: () => setTip((t) => (t?.below ? t : null)),
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch' || !content) return;
      press.touchAt = Date.now();
      const el = e.currentTarget;
      press.shown = false;
      clearTimeout(press.timer);
      press.timer = setTimeout(() => ((press.shown = true), show(el, content, true)), LONG_PRESS_MS);
    },
    onPointerUp: () => clearTimeout(press.timer),
    onPointerCancel: () => clearTimeout(press.timer),
    onPointerMove: (e) => e.pointerType === 'touch' && Math.abs(e.movementY) + Math.abs(e.movementX) > 4 && clearTimeout(press.timer),
    onContextMenu: (e) => (e.pointerType === 'touch' || e.pointerType === 'pen' ? content && e.preventDefault() : (setTip(null), menu.onContextMenu?.(e))),
    onClickCapture: (e) => press.shown && ((press.shown = false), e.preventDefault(), e.stopPropagation()),
  });
  return { tip, bind, hide: () => setTip(null) };
}

/** A place's name, with the catch-up dot right after it when its chapter has news. */
function PlaceName({ name, dot }) {
  if (!dot) return html`<span class="nx-sl">${name}</span>`;
  return html`<span class="nx-sl news"><span class="nx-sln">${name}</span><i class="nx-news" aria-hidden="true"></i><span class="sr-only">, news since you were there</span></span>`;
}

const CATCHUP_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>`;

/** Catch me up, at the top of INBOX: open moments (teal) and what needs the owner (yellow), as every count reads. */
function CatchupRow({ counts, on, onGo }) {
  const label = [counts.moments ? `${counts.moments} new` : null, counts.needs ? `${counts.needs} waiting on you` : null].filter(Boolean).join(', ');
  return html`<button class=${`nx-si${on ? ' on' : ''}`} aria-current=${on ? 'page' : null} onClick=${onGo}>
    ${CATCHUP_ICON}<span class="nx-sl">Catch me up</span>
    ${label ? html`<span class="sr-only">, ${label}</span>` : null}
    <span class="nx-cnt" aria-hidden="true">
      ${counts.moments ? html`<span class="m">${counts.moments}</span>` : null}
      ${counts.moments && counts.needs ? html`<span class="bar"></span>` : null}
      ${counts.needs ? html`<span class="w">${counts.needs}</span>` : null}
    </span>
  </button>`;
}

const CHEV = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>`;

function Sidebar({ store, overlay }) {
  const { state } = store;
  const route = state.nextRoute;
  const views = inboxViews(state);
  // Only active top-level projects, and the named agents; each parent holds its active projects (docs/specs/spaces.md, Nesting).
  const { projects, agents } = sidebarPlaces(state);
  const viewId = currentInboxView(state)?.id;
  const on = (r) => !store.threadOpen() && route.page === 'inbox' && r.page === 'inbox' && r.view === viewId;
  const onPlace = (r) => r.page === route.page && (r.id || null) === (route.id || null);
  // A project's and an agent's counts are from their own open threads, not from an Inbox view.
  const open = openItems(state.lists);
  const opened = state.nextSideOpen || [];
  const { tip, bind, hide } = useSideTip();
  const go = (r) => (hide(), store.nextGo(r));
  // The catch-up (docs/specs/catch-up.md, Sidebar): a dot after a place with news, and the Catch me up row.
  useCatchup(store);
  const chapters = chapterIndex(state);
  const catchup = catchupSpaces(state, { projects: state.projects || [], agents });
  /**
   * A project or an agent. A parent has a chevron on its left: open, its children indent once under it and it counts
   * its own; closed, it counts the roll-up and its breakdown lists "here", then each child. In a section where some
   * place has children, the others keep the chevron's room, so the tiles line up.
   */
  const place = (p, { gutter = false, child = false } = {}) => {
    const r = { page: p.kind, id: p.id };
    const parent = !child && p.children?.length > 0;
    const isOpen = parent && opened.includes(p.key);
    const { tally: t, lines, nest } = placeTally(child ? { ...p, children: [] } : p, open, { projects: state.projects || [], isOpen, now: state.now });
    const tile = p.kind === 'project' ? { kind: 'project', id: p.id, project: p.project } : { kind: 'agent', id: p.id, name: p.name };
    // A snoozed or parked child still lists under its parent, dimmed and named with its state.
    const away = child && p.project ? awayWord(p.project, state.now) : null;
    const toggle = (e) => (e.preventDefault(), e.stopPropagation(), hide(), store.nextToggleSpace(p.key, !isOpen));
    // A tree's keys: → opens a parent, ← closes it.
    const keys = parent ? { onKeyDown: (e) => ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) && toggle(e) } : {};
    const row = html`<button key=${p.key} class=${`nx-si${child ? ' child' : ''}${away ? ' away' : ''}${onPlace(r) ? ' on' : ''}`} aria-expanded=${parent ? isOpen : null} onClick=${() => go(r)} ...${keys}
      ...${bind({ title: p.name, lines, nest }, contextMenuProps(store, { kind: p.kind, id: p.id, fromSidebar: true }))}>
      ${parent ? html`<span class=${`nx-chev${isOpen ? ' open' : ''}`} role="button" aria-label=${isOpen ? `Hide ${p.name}’s projects` : `Show ${p.name}’s projects`} title=${isOpen ? 'Hide its projects' : 'Show its projects'} onClick=${toggle}>${CHEV}</span>` : gutter && !child ? html`<span class="nx-chev blank" aria-hidden="true"></span>` : null}
      <${Tile} tile=${tile} store=${store} size=${18} /><${PlaceName} name=${p.name} dot=${placeDot(p, chapters, { isOpen })} />${away ? html`<span class="nx-away">${away}</span>` : null}<${Count} waiting=${t.waiting} active=${t.active} />
    </button>`;
    if (!isOpen) return row;
    return [row, ...p.children.map((c) => place({ kind: 'project', id: c.id, key: `project:${c.id}`, name: c.name, project: c, children: [] }, { child: true }))];
  };
  const gutterIn = (list) => list.some((p) => p.children.length);
  return html`<nav class=${`nx-side${overlay ? ' overlay' : ''}`} aria-label="Places" onScroll=${hide}>
    <div class="nx-side-top">
      <${AppSwitcher} />
      ${html`<button class="nx-ib" aria-label="Hide sidebar" title="Hide sidebar (⌘\\)" onClick=${() => store.nextToggleSidebar(false)}>${I.side}</button>`}
    </div>
    <button class="nx-search" onClick=${() => (focusSwitcher(), store.nextSwitch(true))} aria-label="Search or jump to">${SEARCH_ICON}<span>Search or jump to…</span><kbd>⌘K</kbd></button>
    <div class="nx-sec">Inbox</div>
    ${catchup.length || route.page === 'catchup'
      ? html`<${CatchupRow} counts=${catchupCounts(catchup)} on=${!store.threadOpen() && route.page === 'catchup'} onGo=${() => go(CATCHUP_ROUTE)} />`
      : null}
    ${views.map(({ view, items }) => {
      const r = { page: 'inbox', view: view.id };
      // A view of only done threads (History) has no count: it only grows.
      const doneOnly = !!view.status?.length && view.status.every((s) => s === 'done');
      // Yellow is what in the view waits on the owner, as on every row; grey is every thread in the view, so Snoozed and Parked still say how many they hold.
      const t = tallyOf(items, state.now);
      // A view of mixed statuses breaks down by status; one of a single status (Working, Snoozed) by where its threads are.
      const content = doneOnly || !items.length ? null : { title: view.name, lines: sideLines(t, items, state.projects) };
      return html`<button class=${`nx-si${on(r) ? ' on' : ''}`} aria-current=${on(r) ? 'page' : null} onClick=${() => go(r)} ...${bind(content, contextMenuProps(store, { kind: 'view', id: view.id }))}>
        ${VIEW_ICONS[viewIcon(view)]}<span class="nx-sl">${view.name}</span>${view.id === 'needs' ? html`<${Count} waiting=${t.waiting} />` : null}
      </button>`;
    })}
    <div class="nx-sech">
      <button class=${`nx-sec link${route.page === 'projects' && !store.threadOpen() ? ' on' : ''}`} aria-current=${route.page === 'projects' && !store.threadOpen() ? 'page' : null} title="All projects" onClick=${() => store.nextGo({ page: 'projects' })}>Projects</button>
      <button class="nx-ib nx-secadd" aria-label="New project" title="New project" onClick=${() => (overlay && store.nextToggleSidebar(false), newProject(store, { then: 'next' }))}>${I.plus}</button>
    </div>
    ${projects.length
      ? projects.flatMap((p) => place(p, { gutter: gutterIn(projects) }))
      : html`<p class="nx-none">${(state.projects || []).length ? 'No active projects.' : 'No projects yet.'}</p>`}
    <div class="nx-sec">Agents</div>
    ${agents.flatMap((a) => place(a, { gutter: gutterIn(agents) }))}
    <div class="nx-side-foot">
      <${SystemRow} store=${store} onGo=${(r) => (overlay && store.nextToggleSidebar(false), go(r))} on=${route.page === 'system' && !store.threadOpen()} />
      <button class="nx-si" onClick=${() => (overlay && store.nextToggleSidebar(false), store.openFilters())}>${I.gear}<span class="nx-sl">Settings</span></button>
    </div>
    <${SideTip} tip=${tip} />
  </nav>`;
}

/**
 * System, above Settings (it was Capacity): a red chip with the number of critical incidents open, nothing
 * otherwise, and each Claude account's weekly room as a tiny bar, as Capacity had.
 */
function SystemRow({ store, on, onGo }) {
  const sys = store.state.system;
  const cap = store.state.capacity;
  useEffect(() => {
    if (!sys) void store.loadSystem();
    if (!cap) void store.loadCapacity();
    // Fresh enough for a glance (the stream's `system` events read it again too); the page itself reads every 30 s.
    const t = setInterval(() => (void store.loadSystem(), void store.loadCapacity()), 2 * 60_000);
    return () => clearInterval(t);
  }, []);
  const chip = systemChip(sys?.data);
  const claude = (cap?.data?.accounts || []).filter((a) => a.provider === 'claude' && a.weekly);
  return html`<button class=${`nx-si${on ? ' on' : ''}`} aria-current=${on ? 'page' : null} aria-label=${`System${chip ? `, ${chip} incident${chip.startsWith('1 ') ? '' : 's'} open` : ''}`} onClick=${() => onGo({ page: 'system', view: 'overview' })}>
    ${SYSTEM_ICON}<span class="nx-sl">System</span>
    ${chip ? html`<span class="nx-syschip">${chip}</span>` : null}
    ${claude.length ? html`<span class="nx-capbars" aria-hidden="true">${claude.map((a) => html`<i style=${`height:${Math.max(3, a.weekly.left * 0.14)}px;background:${a.color || 'var(--ok)'}`}></i>`)}</span>` : null}
  </button>`;
}

export function Breadcrumb({ store, crumbs, sidebarShown, phone, tabBar = false }) {
  // The conversation a worker or job reports to opens that conversation.
  const go = (c) => (c.owner ? store.nextOpen(c.owner) : c.route && store.nextGo(c.route));
  if (phone) {
    const parent = phoneBackCrumb(crumbs);
    const here = crumbs[crumbs.length - 1];
    return html`<header class="nx-bar phone">
      ${parent
        ? html`<button class="nx-backc" onClick=${() => (store.threadOpen() ? store.nextBack() : go(parent))} aria-label=${`Back to ${parent.label}`}>${I.back}<span>${parent.label}</span></button>`
        : html`<${AppSwitcher} phone=${true} />`}
      <span class="nx-bt">${parent ? ((store.state.nextRoute.page === 'search' && !store.threadOpen()) || here?.stage ? here?.label : '') : here?.label}</span>
      <${Voice} store=${store} phone=${true} />
    </header>`;
  }
  return html`<header class="nx-bar">
    ${sidebarShown || tabBar ? null : html`<button class="nx-ib" aria-label="Show sidebar" title="Show sidebar (⌘\\)" onClick=${() => store.nextToggleSidebar(true)}>${I.side}</button>`}
    <nav class="nx-crumbs" aria-label="Breadcrumb">
      ${crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return html`${i ? html`<span class="nx-sep" aria-hidden="true">›</span>` : null}${last
          ? html`<span class="nx-crumb here" aria-current="page">${c.tile ? html`<${Tile} tile=${c.tile} store=${store} size=${16} />` : c.icon || null}<span class="nx-ct">${c.label}</span></span>`
          : html`<button class="nx-crumb" title=${c.label} onClick=${() => (store.threadOpen() && c === crumbs[crumbs.length - 2] ? store.nextBack() : go(c))}>${c.tile ? html`<${Tile} tile=${c.tile} store=${store} size=${16} />` : c.color ? html`<i class="nx-dot" style=${`--c:${ICON_COLORS[c.color] || ICON_COLORS.slate}`}></i>` : null}<span class="nx-ct">${c.label}</span></button>`}`;
      })}
    </nav>
    <${Voice} store=${store} phone=${false} />
  </header>`;
}

/**
 * The floating +, icon only: start work where you are. A project (or a thread in one) starts it there; an
 * agent's page (or one of its threads) starts a thread with that agent.
 */
function Fab({ store, item = null }) {
  const { state } = store;
  const route = state.nextRoute;
  const agentId = item ? agentOf(item) : route.page === 'agent' ? route.id : null;
  const id = item ? item.facts?.projectId : route.page === 'project' ? route.id : null;
  const project = id ? (state.projects || []).find((p) => p.id === id && !p.finishedAt) : null;
  if (agentId) {
    // An agent's thread in a project: the new one joins the project too.
    const name = agentsOf(state.lists, state.now).find((a) => a.id === agentId)?.name || agentId;
    return html`<button class="nx-fab" aria-label=${`New thread with ${name}`} title=${`New thread with ${name}`} onClick=${() => store.openStartWork({ agentId, projectId: project?.id || null })}>${I.plus}</button>`;
  }
  const label = project ? `New thread in ${project.name}` : 'New thread';
  return html`<button class="nx-fab" aria-label=${label} title=${label} onClick=${() => store.openStartWork({ projectId: project?.id || null })}>${I.plus}</button>`;
}

/** The page for the place this device is on. */
function Page({ store, phone, fits }) {
  const r = store.state.nextRoute;
  if (r.page === 'search') return html`<${SearchPage} store=${store} />`;
  if (r.page === 'catchup') return html`<${CatchupPage} store=${store} />`;
  if (r.page === 'projects') return html`<${ProjectsPage} store=${store} />`;
  if (r.page === 'project') return html`<${ProjectPage} store=${store} id=${r.id} phone=${phone} fits=${fits} />`;
  if (r.page === 'agents') return html`<${AgentsPage} store=${store} />`;
  if (r.page === 'agent') return html`<${AgentPage} store=${store} id=${r.id} phone=${phone} />`;
  // Capacity is the System page's Capacity tab (nav.js placeRoute).
  if (r.page === 'system' || r.page === 'capacity') return html`<${SystemPage} store=${store} phone=${phone} />`;
  if (r.page === 'spacesettings') return html`<${SpaceSettingsPage} store=${store} id=${r.id} />`;
  return html`<${InboxPage} store=${store} phone=${phone} />`;
}

/** The tab bar on a phone or an upright tablet: Inbox, Projects, Agents, Search. Out of the way inside a thread. */
function TabBar({ store }) {
  const r = store.state.nextRoute;
  const tab = (key, label, icon, on, run) => html`<button class=${`nx-tb${on ? ' on' : ''}`} aria-label=${label} aria-current=${on ? 'page' : null} onClick=${run}>${icon}<span>${label}</span></button>`;
  return html`<nav class="nx-tabbar" aria-label="Tabs">
    ${tab('inbox', 'Inbox', I.inbox, r.page === 'inbox', () => store.nextGo({ page: 'inbox', view: r.page === 'inbox' ? r.view : null }))}
    ${tab('projects', 'Projects', I.folder, r.page === 'projects' || r.page === 'project', () => store.nextGo({ page: 'projects' }))}
    ${tab('agents', 'Agents', I.agents, r.page === 'agents' || r.page === 'agent', () => store.nextGo({ page: 'agents' }))}
    ${tab('search', 'Search', SEARCH_ICON, r.page === 'search', () => (focusSwitcher(), store.nextSwitch(true)))}
  </nav>`;
}

/** Under the stage's frame: a word while the scene or prototype loads (the frame covers it once it's up). */
function StageNote({ state }) {
  const p = state.presentation;
  const up = p.view === 'prototype' ? prototypeFor(state) : sceneFor(state);
  if (up) return null;
  const waiting = p.view === 'prototype' ? (p.prototypeId ? 'Waiting for the prototype to load.' : 'Nothing published for this thread.') : p.sceneId ? 'Waiting for the screen to load.' : 'Nothing on screen.';
  return html`<div class="nx-col"><p class="nx-empty">${waiting}</p></div>`;
}

/**
 * The stage's crumb: what the scene or prototype on screen is called. Its thread is the crumb before it, and
 * the breadcrumb is the only chrome: the frame takes the rest of the window (stage.js draws it).
 */
function stageCrumb(state) {
  const p = state.presentation;
  if (p.view === 'prototype') {
    const proto = prototypeFor(state);
    return { label: proto ? proto.title || proto.name : p.prototypeId ? 'Loading the prototype…' : 'No prototype', icon: STAGE_ICONS.prototype, stage: true };
  }
  const scene = sceneFor(state);
  return { label: scene ? scene.title || scene.summary || 'Screen' : p.sceneId ? 'Loading the screen…' : 'Nothing on screen', icon: STAGE_ICONS.screen, stage: true };
}

/**
 * The next layout around a page; `thread` when a conversation is open (the shared presentation), `stage` when
 * a scene or prototype is up (then `thread` says it has a conversation to go back to).
 */
export function NextShell({ store, thread = false, stage = false }) {
  const phone = useMedia(PHONE);
  const tablet = useMedia(TABLET_PORTRAIT);
  const touch = useMedia(TOUCH);
  const fits = useMedia(SIDEBAR_FITS);
  const panelFits = useMedia(PANEL_FITS);
  const { state } = store;
  useEffect(() => {
    store.nextListKey = (event) => onListKey(event, store);
    return () => { delete store.nextListKey; };
  }, [store]);
  useEffect(() => watchKeyboardMode(), []);
  const pref = state.nextSidebar;
  // A phone or an upright tablet always has the tab bar; wider windows the sidebar.
  const tabBar = phone || tablet;
  const sidebarShown = tabBar ? false : pref ? pref === 'open' : fits;
  const overlay = sidebarShown && !fits;
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        if (!tabBar) store.nextToggleSidebar(!sidebarShown);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [tabBar, sidebarShown]);
  document.documentElement.classList.toggle('nx-sidebar-in', sidebarShown && !overlay);
  if (stage || (!thread && state.nextRoute.page !== 'project')) document.documentElement.classList.remove('nx-panel-in', 'nx-panel-over');
  const views = inboxViews(state).map((v) => v.view);
  const item = thread ? currentItem(state) : null;
  // A thread moved to another project (here or on another screen) takes its breadcrumb and Back with it. Always
  // worked out from where it was opened, so a move undone (or a delete that didn't save) brings the place back.
  const from = thread && item && state.nextThreadFrom?.itemId === item.id ? state.nextThreadFrom.route : state.nextRoute;
  const placeRoute = thread ? threadRoute(from, item, state.projects || [], state.projectsLoaded) : state.nextRoute;
  useEffect(() => {
    if (thread && item && routeKey(placeRoute) !== routeKey(state.nextRoute)) store.nextFollow(placeRoute, { itemId: item.id, route: from });
  }, [routeKey(placeRoute), routeKey(state.nextRoute), item?.id]);
  // Only while that thread stays open: closed, or another one opened (the switcher goes thread to thread), it's forgotten.
  const openId = thread ? store.state.presentation.itemId : null;
  useEffect(() => {
    if (state.nextThreadFrom && state.nextThreadFrom.itemId !== openId) store.set({ nextThreadFrom: null });
  }, [openId]);
  const route = placeRoute.page === 'inbox' ? { ...placeRoute, view: currentInboxView(state)?.id } : placeRoute;
  const systemJob = route.page === 'system' && route.id ? (state.system?.data?.jobs || []).find((j) => j.id === route.id)?.name || state.systemJobs?.[route.id]?.data?.job?.name || null : null;
  const crumbs = crumbsOf(route.page === 'search' ? { ...route, query: state.search.query } : route, { views, projects: state.projects || [], agents: agentsOf(state.lists, state.now), thread: thread ? (item ? threadTitle(item) : 'Thread') : null, owner: item ? ownerCrumb(item, state.lists) : null, systemJob });
  if (stage) crumbs.push(stageCrumb(state));
  const r = state.nextRoute;
  const pushed = stage || thread || r.page === 'project' || r.page === 'agent' || r.page === 'search' || (r.page === 'system' && !!r.id);
  const quiet = !state.nextSwitcher && !state.startWork && !state.sheet && !state.filterOpen && !state.snoozeFor && !state.confirm;
  // Any touch screen (a phone, an iPad) swipes in from the left edge to go back and pulls to search.
  const g = useGestures({
    enabled: (phone || touch) && quiet,
    pull: !thread && !stage,
    onPull: () => store.nextSwitch(true),
    // Not over the stage: its frame takes the touches (the back crumb goes back there).
    onBack: (phone || touch) && pushed && !stage ? () => store.nextBack() : null,
  });
  const bare = thread || stage;
  // A list as a picker (select.js): the selection bar takes the breadcrumb's place, the action bar the bottom edge.
  const selecting = !bare && !!state.nextSelect;
  return html`<div class=${`nx${phone ? ' phone' : ''}${thread ? ' on-thread' : ''}${stage ? ' on-stage' : ''}${tabBar && !bare && !selecting ? ' with-tabbar' : ''}${selecting ? ' selecting' : ''}`}>
    ${sidebarShown ? html`<${Sidebar} store=${store} overlay=${overlay} />` : null}
    ${overlay ? html`<div class="nx-scrim clear" onClick=${() => store.nextToggleSidebar(false)}></div>` : null}
    ${selecting ? html`<${SelectBar} store=${store} phone=${phone} />` : html`<${Breadcrumb} store=${store} crumbs=${crumbs} sidebarShown=${sidebarShown && !overlay} phone=${phone} tabBar=${tabBar} />`}
    ${(phone || touch) && !bare ? html`<${PullCue} cueRef=${g.cue} />` : null}
    <main class="nx-main" id="main" ref=${g.body}>${stage
      ? html`<${StageNote} state=${state} />`
      : thread
        ? html`<${ThreadPage} store=${store} phone=${phone} fits=${panelFits} />`
        : html`<${Page} store=${store} phone=${phone} fits=${panelFits} />`}</main>
    ${stage || (thread && phone) || selecting ? null : html`<${Fab} store=${store} item=${item} />`}
    ${selecting ? html`<${SelectDock} store=${store} phone=${phone} />` : tabBar && !bare ? html`<${TabBar} store=${store} />` : null}
    <${Switcher} store=${store} phone=${phone} />
    <${ContextMenu} store=${store} />
    ${state.nextKeys ? html`<${KeysSheet} store=${store} help=${keyHelp(state, { thread, stage })} />` : null}
  </div>`;
}

/** `?`: the keys this page answers to (a list's or a thread's; elsewhere only the ones that work anywhere). Esc leaves a box. */
function KeysSheet({ store, help }) {
  const close = () => store.set({ nextKeys: false });
  // Opened mid-typing (⌘/): closing it puts the cursor back, so the next letters type, not act (Codex review on #692).
  const from = useRef(document.activeElement);
  useEffect(() => () => from.current?.isConnected && from.current !== document.body && from.current.focus?.({ preventScroll: true }), []);
  const list = (rows) => html`<dl>${rows.map(([k, v]) => html`<dt>${k.split('  ').map((x) => html`<kbd>${x}</kbd>`)}</dt><dd>${v}</dd>`)}</dl>`;
  return html`<div class="nx-scrim nx-keys-scrim" onClick=${close}></div>
    <div class="nx-keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1" ref=${(n) => n && !n.contains(document.activeElement) && n.focus()}>
      ${help ? html`<h2>${help.title}</h2>${list(help.rows)}` : null}
      <h2>Anywhere</h2>
      ${list(KEY_HELP.any)}
      <p>Keys work whenever you aren't typing in a box. Esc leaves the box.</p>
    </div>`;
}
