// The next layout's places: the Inbox (the owner's views as pill tabs), Projects, a project, Agents, an agent.

import { viewToQuery } from '../query.js';
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { age, fitToContent, isSendKey, refitOnResize, projectAwayLabel } from '../util.js';
import { ProjectLinks, SEND } from '../coordinator.js';
import { Menu, contextMenuProps } from './menu.js';
import { MENU_ICONS as MI } from './icons.js';
import { Tabs, usePanel } from './thread.js';
import { FILTER_FACETS, filteredView, filterName, GROUPS, PROJECT_GROUPS, parentChoices, childProjects, foldedChildren, ownMatch, parentCrumb, rollupMatch, agentViews, healthOf, kindOf, pageView, projectViews, shownSpaceViews, spaceGroups, spaceViews, agentChat, agentOf, agentsOf, applyFilter, countsOf, currentInboxView, facetLabel, filterCount, filterOptions, groupByStatus, groupProjects, hiddenSectionsOf, inboxViews, needsViewId, projectGroup, rowOf, SHOW_ONLY, sidebarPlaces, threadTitle, threadsIn, whereTree } from './model.js';
import { GroupHead, Groups, KindGlyph, Tile } from './rows.js';
import { MAX_VIEWS, viewsOf, trophyShelf, viewSections } from '../list-views.js';
import { SweepCard, TrophyShelf } from '../list.js';
import { facetsFor, isHidden } from '../filters.js';
import { draftView } from '../draft-model.js';
import { newProject } from '../projects-editor.js';
import { GroupPick, SelectButton, SelectCheck, both, useLongPress } from './select.js';
import { ReviewCard } from './decided.js';
import { ChapterCard, useCatchup, when } from './chapter.js';
import { catchupSpaces, inboxSummary, nextCatchup } from './catchup-model.js';


function Empty({ text }) {
  return html`<p class="nx-empty">${text}</p>`;
}

/** A page's views as pill tabs, as on the Inbox: the same look and counts on every page with a list. */
function ViewPills({ views, current, onPick, hot = null, label = 'Views', store, spaceKey }) {
  return html`<div class="nx-pills" role="tablist" aria-label=${label}>
    ${views.map((v) => {
      const on = v.id === current;
      const n = v.n ?? v.items?.length ?? 0;
      return html`<button role="tab" aria-selected=${on} class=${`nx-ptab${on ? ' on' : ''}`} onClick=${() => onPick(v.id)} ...${spaceKey ? contextMenuProps(store, { kind: 'spaceview', id: v.id, spaceKey }) : {}}>${v.name}${v.id === 'needs' && n ? html`<span class=${`n${v.id === hot ? ' hot' : ''}`}>${n}</span>` : null}</button>`;
    })}
  </div>`;
}

/** The view a page is on, kept per device like the Inbox's tab (pageView: the same pick the voice operator reads). */
function usePageView(store, key, views) {
  const pick = (id) => store.setPageView(key, id);
  return [pageView(store.state, key, views), pick];
}

/** "Inbox", the views as pill tabs, then the view's threads by status. */
/** The tab the shelf's "more in History" opens: every done thread, no other filter (Codex review on #794). */
export function isPlainHistory(view) {
  const { where } = viewToQuery(view);
  const done = where.disposition;
  return !!done && JSON.stringify(done) === JSON.stringify({ in: ['done'] }) && Object.keys(where).length === 1;
}

export function InboxPage({ store }) {
  const { state } = store;
  const views = inboxViews(state);
  const currentId = currentInboxView(state)?.id;
  const current = views.find((v) => v.view.id === currentId) || views[0];
  const hot = needsViewId(views.map((v) => v.view));
  if (!current) return html`<div class="nx-col"><h1 class="nx-h1">Inbox</h1><${Empty} text="Loading…" /></div>`;
  const loaded = ['active', 'snoozed', 'history'].every((k) => state.lists[k]?.loaded || !current.view.status?.length);
  // The view's own grouping and sort (Settings → Tabs), as on the classic List.
  const filter = state.nextFilter || {};
  const kept = applyFilter(current.items, filter, state.projects || []);
  const groups = viewSections(kept, current.view, state.labelOrder, state.projects || [], state.nextOrder);
  // As on the classic List: an empty view of what needs the owner shows today's finished work instead.
  const found = !groups.length && !filterCount(filter) && state.lists.history?.loaded && !draftView(state.draft, state.now) && trophyShelf(state.lists, current.view, state.now);
  const shelf = found;
  const historyTab = views.find(({ view: v }) => isPlainHistory(v))?.view.id;
  return html`<div class="nx-col">
    <div class="nx-ihead"><h1 class="nx-h1">Inbox</h1><span class="nx-iacts"><${SelectButton} store=${store} kind="thread" /><${FilterButton} store=${store} items=${current.items} filter=${filter} kept=${kept.length} view=${current.view} /></span></div>
    <div class="nx-pills" role="tablist" aria-label="Views">
      ${views.map(({ view, items }) => {
        const on = view.id === current.view.id;
        return html`<button role="tab" aria-selected=${on} class=${`nx-ptab${on ? ' on' : ''}`} onClick=${() => store.nextGo({ page: 'inbox', view: view.id })} ...${contextMenuProps(store, { kind: 'view', id: view.id })}>
          ${view.name}${view.id === 'needs' && items.length ? html`<span class=${`n${view.id === hot ? ' hot' : ''}`}>${items.length}</span>` : null}
        </button>`;
      })}
    </div>
    <${FilterChips} store=${store} items=${current.items} />
    <${MuteChips} store=${store} />
    ${current.view.id === views[0]?.view.id ? html`<${InboxSummary} store=${store} /><${ReviewCard} store=${store} /><${SweepCard} sweep=${state.lists.active?.sweep} store=${store} />` : null}
    ${groups.length ? html`<${Groups} groups=${groups} store=${store} scope=${`inbox:${current.view.id}`} />` : shelf ? html`<${TrophyShelf} shelf=${shelf} store=${store} historyTab=${historyTab} onHistory=${(id) => store.nextGo({ page: 'inbox', view: id })} />` : html`<${Empty} text=${loaded ? (filterCount(filter) ? 'Nothing matches the filter.' : `Nothing in ${current.view.name}.`) : 'Loading…'} />`}
  </div>`;
}

/**
 * The Inbox summary (docs/specs/catch-up.md): since when, what needs the owner, what's worth a look and where the
 * smaller updates are, across spaces, then Catch me up. It took the place of Decided for you, which is in each
 * space's catch-up now.
 */
function InboxSummary({ store }) {
  useCatchup(store);
  const { state } = store;
  const spaces = catchupSpaces(state, { projects: state.projects || [], agents: sidebarPlaces(state).agents });
  const view = inboxSummary(spaces);
  if (!view) return null;
  const to = nextCatchup(spaces);
  return html`<section class="nx-isum" aria-label="Since you were here">
    <p class="nx-isum-h">${view.since ? html`<b>Since ${when(view.since, state.now)}</b>` : html`<b>Since you were here</b>`}<span>${view.tally}</span></p>
    ${view.lines.map((l) => html`<p class=${`nx-isum-l k-${l.kind}`} key=${l.kind}><i aria-hidden="true"></i><span>${l.lead ? html`<b>${l.lead}</b> ` : null}${l.where}</span></p>`)}
    <div class="nx-isum-f">
      ${to ? html`<button class="btn sm pri" onClick=${() => store.nextGo(to)}>Catch me up</button>` : null}
      <span>or open any project: its card is waiting</span>
    </div>
  </section>`;
}

const FILTER_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z"/></svg>`;

/** This device's sort, for the Inbox and Catch me up: oldest first brings up what was left longest. */
export const ORDERS = [['newest', 'Newest first'], ['oldest', 'Oldest first']];

/**
 * Device picks narrow the current tab; the menu can save their intersection as a shared tab. Sort, then Where in the
 * sidebar's shape, then one-tap Show only toggles and the two lists worth a submenu (Waiting on, Last active).
 */
function FilterButton({ store, items, filter, kept, view }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(null);
  const projects = store.state.projects || [];
  const options = filterOptions(items, projects, store.state.nextFilter || {}, store.state.now);
  const toggle = (facet, value) => {
    const now = filter[facet] || [];
    store.nextSetFilter({ ...filter, [facet]: now.includes(value) ? now.filter((v) => v !== value) : [...now, value] });
  };
  const hint = (facet) => filter[facet]?.length ? (filter[facet].length === 1 ? facetLabel(facet, filter[facet][0], projects, items) : `${filter[facet].length} picked`) : '';
  // The filter carries across tabs: a pick this tab doesn't have still shows (with 0) so it can be unpicked.
  const check = (facet, o, extra = {}) => ({ label: o.label, hint: String(o.n), on: (filter[facet] || []).includes(o.value), keep: true, onSelect: () => toggle(facet, o.value), ...extra });
  const list = (facet, label) => ({ label, hint: hint(facet), sub: options[facet].map((o) => check(facet, o)) });
  const tree = whereTree(options.where, projects, sidebarPlaces(store.state).agents, filter.where || []);
  // The sidebar's headings: Projects, then Agents; Not in a project after a line.
  const where = tree.flatMap((o, i) => [
    ...(o.section !== tree[i - 1]?.section ? (o.section === 'projects' ? [{ heading: 'Projects' }] : o.section === 'agents' ? [{ heading: 'Agents' }] : i ? ['sep'] : []) : []),
    check('where', o, { indent: o.depth }),
  ]);
  const order = store.state.nextOrder === 'oldest' ? 'oldest' : 'newest';
  const menu = [
    { heading: 'Sort' },
    ...ORDERS.map(([key, label]) => ({ label, on: order === key, keep: true, onSelect: () => store.nextSetOrder(key) })),
    'sep',
    ...(tree.length ? [{ label: 'Where', hint: hint('where'), sub: where }] : []),
    // Stage leaves the menu while its flag is off, unless a stage is still picked (so it can be unpicked).
    ...(store.state.flags?.stageLabels || filter.stage?.length ? [list('stage', 'Stage')] : []),
    { heading: 'Show only' },
    ...SHOW_ONLY.map(([facet, value, label]) => ({ label, on: (filter[facet] || []).includes(value), keep: true, onSelect: () => toggle(facet, value) })),
    list('wait', 'Waiting on'),
    list('age', 'Last active'),
  ];
  const n = filterCount(filter);
  if (n) menu.push('sep', { label: 'Clear filter', onSelect: () => store.nextSetFilter({}) });
  const full = viewsOf(store.state.listViews, store.state.listGroup).length >= MAX_VIEWS;
  menu.push('sep', { label: 'Save as tab…', disabled: full, hint: full ? '20-tab limit reached' : '', onSelect: () => setSaving({ view, filter: structuredClone(filter), name: filterName(filter, projects, items) }) });
  menu.push({ label: 'Edit tabs…', onSelect: () => store.openSettings('tabs', { tab: view.id }) });
  return html`<span class="nx-anchor nx-filter">
    ${saving ? html`<${SaveFilterTab} store=${store} draft=${saving} onClose=${() => setSaving(null)} />` : null}
    <button class=${`nx-fbtn${n ? ' on' : ''}`} data-menu-button aria-haspopup="menu" aria-expanded=${open} onClick=${(e) => (e.stopPropagation(), setOpen(!open))}>${FILTER_ICON}<span>${order === 'oldest' ? 'Oldest first' : 'Filter'}</span>${n ? html`<span class="n">${kept}</span>` : null}</button>
    ${open ? html`<${Menu} items=${menu} onClose=${() => setOpen(false)} phone=${window.matchMedia('(max-width: 699px)').matches} title="Filter" />` : null}
  </span>`;
}

/** Same-size count pills with one color: needs you. */
function Counts({ items, now }) {
  const c = countsOf(items, now);
  const parts = [
    c.needs ? html`<span class="nx-cp hot">${c.needs} need${c.needs === 1 ? 's' : ''} you</span>` : null,
  ].filter(Boolean);
  return parts.length ? html`<span class="nx-counts">${parts}</span>` : null;
}

/** A project or an agent. On the Projects page (`pickable`) it takes part in selecting, as a thread row does. */
function PlaceRow({ tile, name, line, items, store, onOpen, time = null, pickable = false, health = [], crumb = null, inpage = false }) {
  const picking = pickable && store.state.nextSelect?.kind === 'project';
  const picked = picking && store.state.nextSelect.ids.includes(tile.id);
  const touch = typeof document !== 'undefined' && document.documentElement.classList.contains('can-swipe');
  const press = useLongPress(() => (picking ? store.nextSelectToggle(tile.id) : store.nextSelectStart('project', tile.id)), { enabled: pickable && touch });
  const menu = contextMenuProps(store, { kind: tile.kind, id: tile.id });
  const click = (e) => (e.preventDefault(), picking ? store.nextSelectToggle(tile.id, { range: e.shiftKey }) : onOpen());
  return html`<a class=${`nx-place${inpage ? ' inpage' : ''}${picking ? ' picking' : ''}${picked ? ' picked' : ''}`} href="#" data-select-id=${picking ? tile.id : null} role=${picking ? 'checkbox' : null} aria-checked=${picking ? picked : null}
    ...${both(press, { onMouseDown: menu.onMouseDown, onClick: click, onContextMenu: (e) => (press.onContextMenu(e), e.defaultPrevented || menu.onContextMenu(e)) })}>
    ${picking ? html`<${SelectCheck} on=${picked} />` : null}
    <${Tile} tile=${tile} store=${store} size=${inpage ? 28 : 32} />
    <span class="nx-pb">
      <span class="nx-pn">${name}${crumb ? html`<small>${crumb} ›</small>` : null}</span>
      ${line ? html`<span class="nx-pl">${line}</span>` : null}
      <span class="nx-pfacts"><${Counts} items=${items} now=${store.state.now} />${health.map((h) => html`<span class=${`nx-health${h.bad ? ' bad' : ''}`}>${h.text}</span>`)}</span>
    </span>
    ${time ? html`<span class="nx-time">${time}</span>` : null}
  </a>`;
}

const PLUS = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`;

/** Where a project stands, in a line: its default's latest summary, else the old coordinator's, else what it is for. */
function standsOf(p, open, state) {
  const lead = open.find((i) => kindOf(i) === 'default');
  return (lead ? lead.summary?.headline || lead.summary?.gist : state.coordinators?.[p.id]?.status?.line) || state.spaces?.[`project:${p.id}`]?.about || p.about || '';
}

/** "3 projects": the open projects inside a space, said in its health meta. */
function projectsNote(key, projects) {
  const n = childProjects(key, projects).length;
  return n ? [{ text: `${n} project${n === 1 ? '' : 's'}` }] : [];
}

export function ProjectsPage({ store }) {
  const { state } = store;
  const projects = state.projects || [];
  const agents = agentsOf(state.lists, state.now);
  // Top-level spaces only (docs/specs/spaces.md, Nesting): a parent's pills are the roll-up of the children it folds,
  // its health is its own; a child listed on its own (away from its parent's group, or an agent's) has its parent as a crumb.
  const row = (p) => {
    const folded = foldedChildren(p, projects, state.now);
    const own = threadsIn(state.lists, ownMatch('project', p.id, projects)).open;
    const rolled = folded.length ? threadsIn(state.lists, rollupMatch('project', p.id, folded, projects)).open : own;
    return html`<${PlaceRow} key=${p.id} pickable=${true} tile=${{ kind: 'project', id: p.id, project: p }} name=${p.name} crumb=${parentCrumb(p, projects, agents)} line=${['snoozed', 'parked'].includes(projectGroup(p, state.now)) ? projectAwayLabel(p, state.now) : standsOf(p, own, state)} items=${rolled} health=${[...projectsNote(`project:${p.id}`, projects), ...healthOf(own, state.now)]} store=${store} onOpen=${() => store.nextGo({ page: 'project', id: p.id })} />`;
  };
  // Active, Snoozed, Parked and Done are views now, as the Inbox's are (they were folding groups).
  const views = projectViews(state.projects, state.now);
  const [current, pick] = usePageView(store, 'projects', views);
  const shown = views.find((v) => v.id === current)?.items || [];
  const create = () => newProject(store, { then: 'next' });
  return html`<div class="nx-col">
    <div class="nx-ihead"><h1 class="nx-h1">Projects</h1><span class="nx-iacts"><${SelectButton} store=${store} kind="project" /><button class="nx-fbtn" onClick=${create}>${PLUS}<span>New project</span></button></span></div>
    ${state.projects?.length ? html`<${ViewPills} views=${views} current=${current} onPick=${pick} label="Project views" />` : null}
    ${shown.length
      ? html`<section class="nx-group">${shown.map(row)}</section>`
      : state.projects?.length ? html`<${Empty} text="Nothing here." />` : html`<p class="nx-empty">No projects yet. <button class="nx-link" onClick=${create}>Make one</button> to keep a piece of work’s threads together.</p>`}
  </div>`;
}

/**
 * A space's own projects, first on its Overview (docs/specs/spaces.md, Nesting: the folder page): each as a place row
 * with its tile, name, where it stands, its counts and health, under a "Projects" heading that folds like the others.
 */
function ChildPlaces({ spaceKey, store, scope }) {
  const { state } = store;
  const projects = state.projects || [];
  const children = childProjects(spaceKey, projects);
  if (!children.length) return null;
  const key = `${scope}|projects`;
  const shut = (state.listCollapsed || []).includes(key);
  return html`<section class=${`nx-group${shut ? ' shut' : ''}`} key="projects">
    <${GroupHead} label="Projects" n=${children.length} shut=${shut} onToggle=${() => store.toggleListSection(key)} />
    ${shut
      ? null
      : children.map((c) => {
          const { open } = threadsIn(state.lists, ownMatch('project', c.id, projects));
          const away = ['snoozed', 'parked'].includes(projectGroup(c, state.now));
          return html`<${PlaceRow} key=${c.id} inpage=${true} tile=${{ kind: 'project', id: c.id, project: c }} name=${c.name} line=${away ? projectAwayLabel(c, state.now) : standsOf(c, open, state)} items=${open} health=${healthOf(open, state.now)} store=${store} onOpen=${() => store.nextGo({ page: 'project', id: c.id })} />`;
        })}
  </section>`;
}

const PULSE = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8.5h3l2-5 3 9 2-4h3"/></svg>`;

/** "Where it stands": news about the work, in its own small card so it reads apart from what the space is for. */
function Stands({ line, at, now }) {
  return html`<div class="nx-stands"><span class="nx-st-h">${PULSE}<b>Where it stands</b>${at ? html`<span class="nx-st-when">${age(at, now)} ago</span>` : null}</span><p>${line}</p></div>`;
}

/** A place's header: tile and name, then its actions in the same corner as a thread's (⋯ and the panel). */
function PlaceHead({ tile, store, name, about, line, standsAt = null, chapter = null, items, actions = null, counts = true }) {
  return html`<header class="nx-phead">
    <div class="nx-ptop"><${Tile} tile=${tile} store=${store} size=${36} /><h1 class="nx-h1">${name}</h1>${actions ? html`<span class="nx-tacts">${actions}</span>` : null}</div>
    ${about ? html`<p class="nx-about">${about}</p>` : null}
    ${chapter || (line ? html`<${Stands} line=${line} at=${standsAt} now=${store.state.now} />` : null)}
    ${counts ? html`<${Counts} items=${items} now=${store.state.now} />` : null}
  </header>`;
}

/**
 * Ask the space (docs/specs/spaces.md: talking to a space is talking to its default), on every layout. The words
 * are the default's reply draft, so the thread's composer has them too and a failed send comes back here.
 * A project with no default yet asks its old coordinator.
 */
function SpaceAsk({ lead, project = null, name, store }) {
  // The coordinator is retired (docs/specs/spaces.md): a space with no default yet has nobody to ask.
  const area = useRef(null);
  const text = lead ? store.draftFor(lead.id) : '';
  useEffect(() => fitToContent(area.current), [text]);
  useEffect(() => refitOnResize(area.current), [lead?.id]);
  if (!lead) return null;
  // Only the words shown here go: images in the thread's draft stay there for its composer (Codex review on #704).
  const send = async () => {
    const words = text.trim();
    if (!words) return;
    store.setDraft(lead.id, '');
    const result = await store.sendReply(lead.id, words, { stay: true });
    if (result?.status === 'failed' && !store.draftFor(lead.id)) store.setDraft(lead.id, words);
  };
  return html`<form class="nx-ask cp-ask lead" onSubmit=${(e) => (e.preventDefault(), send())}>
    <${KindGlyph} kind="default" />
    <textarea ref=${area} rows="1" aria-label=${`Ask ${name}`} placeholder=${`Ask ${name}…`} value=${text} onInput=${(e) => store.setDraft(lead.id, e.currentTarget.value)}
      onKeyDown=${(e) => {
        if (isSendKey(e) || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
          e.preventDefault();
          send();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.currentTarget.blur();
        }
      }}></textarea>
    <button class="cp-go" type="submit" aria-label=${`Send to ${name}`} disabled=${!text.trim()}>${SEND}</button>
  </form>`;
}

const DOTS = html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`;
const PANEL = html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/></svg>`;

/** ⋯ for a place: its menu as a dropdown (desk) or a sheet (phone). */
function MoreButton({ items, title, phone }) {
  const [open, setOpen] = useState(false);
  return html`<span class="nx-anchor">
    <button class="nx-ib" data-menu-button aria-label="Actions" aria-haspopup="menu" aria-expanded=${open} title="Actions" onClick=${(e) => (e.stopPropagation(), setOpen(!open))}>${DOTS}</button>
    ${open ? html`<${Menu} items=${items} onClose=${() => setOpen(false)} phone=${phone} title=${title} />` : null}
  </span>`;
}

/**
 * ⋯ → Move into: the space a project is inside (docs/specs/spaces.md, Nesting). Its threads go with it. A project
 * that holds projects stays at the top (two levels), so it has nothing to pick.
 */
function moveInto(project, store) {
  const { state } = store;
  const choices = parentChoices(project, state.projects || [], agentsOf(state.lists, state.now));
  if (project.finishedAt || choices.length < 2) return null;
  const tile = (c) => (c.kind === 'project' ? html`<${Tile} tile=${{ kind: 'project', id: c.project.id, project: c.project }} store=${store} size=${16} />` : c.kind === 'agent' ? html`<${Tile} tile=${{ kind: 'agent', id: c.agent.id, name: c.agent.name }} store=${store} size=${16} />` : null);
  const here = choices.find((c) => (c.value || null) === (project.parent || null));
  return {
    icon: MI.folder,
    label: 'Move into',
    hint: here?.label || 'Your space',
    sub: choices.map((c) => ({ label: c.label, icon: tile(c), on: (c.value || null) === (project.parent || null), onSelect: () => (c.value || null) !== (project.parent || null) && store.setProjectParent(project.id, c.value) })),
  };
}

/** The project's ⋯: the Desk's project actions. */
export function projectMenu(project, store) {
  const mailOff = (store.state.mailOff || []).includes(`project:${project.id}`);
  const hidden = hiddenSectionsOf(project, store.state);
  const toggle = (key) => store.setProjectSections(project.id, hidden.includes(key) ? hidden.filter((k) => k !== key) : GROUPS.map(([k]) => k).filter((k) => k === key || hidden.includes(k)));
  return [
    { icon: MI.edit, label: 'Edit project…', onSelect: () => store.set({ projectEditor: { editing: project.id, forItem: null } }) },
    { icon: MI.edit, label: 'Edit views…', onSelect: () => store.openSettings('spaceviews') },
    { icon: MI.palette, label: 'Space settings', onSelect: () => store.nextGo({ page: 'spacesettings', id: `project:${project.id}` }) },
    {
      icon: MI.sections,
      label: 'Sections',
      sub: [
        ...GROUPS.map(([key, label]) => ({ label, on: !hidden.includes(key), onSelect: () => toggle(key) })),
        'sep',
        { label: 'Same as every project', on: !project.hiddenSections, hint: 'Settings', onSelect: () => store.setProjectSections(project.id, null) },
      ],
    },
    { icon: MI.mail, label: mailOff ? 'Turn agent mail back on' : 'Turn agent mail off', onSelect: () => store.setMailOff(`project:${project.id}`, !mailOff) },
    moveInto(project, store),
    'sep',
    ...(project.away
      ? [{ icon: MI.wake, label: 'Wake project', onSelect: () => store.wakeProject(project.id) }]
      : [
          { icon: MI.snooze, label: 'Snooze project…', onSelect: () => store.openProjectSnooze(project.id) },
          { icon: MI.park, label: 'Park project', onSelect: () => store.parkProject(project.id) },
        ]),
    project.finishedAt ? { icon: MI.back, label: 'Reopen project', onSelect: () => store.reopenProject(project.id) } : { icon: MI.finish, label: 'Finish project…', onSelect: () => store.set({ confirm: { kind: 'finishProject', projectId: project.id } }) },
  ].filter(Boolean);
}

/**
 * The project's panel: every link its threads have, and what's been done in it. Its coordinator is folded into the
 * space's default conversation (docs/specs/spaces.md): ask the default instead.
 */
function ProjectPanelBody({ tab, project, store, done }) {
  if (tab === 'history')
    return done.length
      ? html`<div class="nx-hist">${done.slice(0, 30).map((i) => html`<button class="nx-hrow" onClick=${() => store.nextOpen(i.id)}><span>${threadTitle(i)}</span><small>${age(i.doneAt || i.lastActivityAt, store.state.now)}</small></button>`)}</div>`
      : html`<p class="nx-empty">Nothing finished here yet.</p>`;
  return html`<${ProjectLinks} project=${project} store=${store} />`;
}

/** An empty first view whose other tabs hold rows (workers, finished work) says where they are (Codex review on #776). */
export function overviewEmpty(views, nothing) {
  const rest = views.filter((v, index) => index > 0 && v.items.length).map((v) => v.name);
  return rest.length ? `Nothing you're working on here. See ${rest.join(', ')}.` : nothing;
}

export function ProjectPage({ store, id, phone = false, fits = true }) {
  const { state } = store;
  const panel = usePanel(store, fits, 'nextProjectPanel', 'links');
  const [phoneTab, setPhoneTab] = useState('threads');
  const showHidden = state.nextShowHidden;
  const setShowHidden = (id) => store.set({ nextShowHidden: id });
  const project = (state.projects || []).find((p) => p.id === id);
  if (!project) return html`<div class="nx-col"><${Empty} text="That project is gone." /></div>`;
  const { open, done } = threadsIn(state.lists, ownMatch('project', id, state.projects || []));
  // Where it stands: the space's default conversation says it (its latest summary); the old coordinator's line only
  // while a project has no default yet.
  const lead = open.find((i) => kindOf(i) === 'default');
  // With a default, only its own summary (never the retired coordinator's line), timed by the summary itself.
  const leadLine = lead?.summary?.headline || lead?.summary?.gist || '';
  const stands = project.away ? projectAwayLabel(project, state.now) : lead ? leadLine : state.coordinators?.[id]?.status?.line || '';
  const standsAt = project.away ? null : lead ? (leadLine && lead.summary?.at) || null : state.coordinators?.[id]?.status?.at || null;
  // The catch-up card takes Where it stands' place (docs/specs/catch-up.md); away, the project says so instead.
  const chapter = project.away ? null : html`<${ChapterCard} store=${store} spaceId=${`project:${id}`} name=${project.name} leadName=${lead ? threadTitle(lead) : null} leadAt=${lead?.lastActivityAt || null} line=${stands} at=${standsAt} />`;
  const context = { kind: 'project', id };
  const tabs = [{ key: 'links', label: 'Links' }, { key: 'history', label: 'History', n: done.length || null }];
  const tab = tabs.some((t) => t.key === panel.tab) ? panel.tab : tabs[0].key;
  const overlay = !phone && panel.open && !fits;
  document.documentElement.classList.toggle('nx-panel-in', !phone && panel.open && !overlay);
  document.documentElement.classList.toggle('nx-panel-over', overlay);
  const pick = { icon: MI.select, label: 'Select threads', hint: 'x', onSelect: () => store.nextSelectStart('thread') };
  const actions = html`<${MoreButton} items=${[pick, 'sep', ...projectMenu(project, store)]} title=${project.name} phone=${phone} />
    ${phone ? null : html`<button class=${`nx-ib${panel.open ? ' on' : ''}`} aria-label=${panel.open ? 'Hide the panel' : 'Show the panel'} aria-pressed=${panel.open} title="Coordinator, links and history" onClick=${() => panel.set({ open: !panel.open })}>${PANEL}</button>`}`;
  // The sections the owner hid (⋯ → Sections) say how many they hold, in one quiet line that shows them for now.
  const hidden = showHidden === id ? [] : hiddenSectionsOf(project, state);
  // Show lists every thread the hidden line counted, not just the latest ten finished (Codex review on #596).
  const views = spaceViews(open, done, shownSpaceViews(state), { now: state.now, projects: state.projects });
  const [view, pickView] = usePageView(store, `project:${id}`, views);
  const items = views.find((v) => v.id === view)?.items || [];
  // Overview keeps the project's Sections (⋯ → Sections); the other views show everything they hold.
  const groups = spaceGroups(views.find((v) => v.id === view), items, state.now, view === views[0]?.id ? hidden : []);
  const held = view === views[0]?.id ? spaceGroups({ ...views[0], group: 'status' }, items, state.now).filter((g) => hidden.includes(g.key)) : [];
  const heldLine = held.length
    ? html`<p class="nx-held"><button class="linkish" onClick=${() => setShowHidden(id)}>${held.map((g) => `${g.label} ${g.items.length}`).join(' · ')} hidden here. Show</button></p>`
    : null;
  const threads = html`<${ViewPills} views=${views} current=${view} onPick=${pickView} store=${store} spaceKey=${`project:${id}`} label="Project views" />
    ${view === views[0]?.id ? html`<${ChildPlaces} spaceKey=${`project:${id}`} store=${store} scope=${`project:${id}:${view}`} />` : null}
    ${groups.length || heldLine ? html`<${Groups} groups=${groups} store=${store} context=${context} scope=${`project:${id}:${view}`} />${heldLine}` : view === views[0]?.id && childProjects(`project:${id}`, state.projects).length ? null : html`<${Empty} text=${view === views[0]?.id ? overviewEmpty(views, 'Nothing in this project yet. The + starts work in it.') : 'Nothing here.'} />`}`;
  return html`<div class="nx-col">
      <${PlaceHead} tile=${{ kind: 'project', id, project }} store=${store} name=${project.name} line=${stands} standsAt=${standsAt} chapter=${chapter} about=${state.spaces?.[`project:${id}`]?.about || project.about} items=${open} actions=${actions} counts=${false} />
      <${SpaceAsk} lead=${lead} project=${project} name=${project.name} store=${store} />
      ${phone ? html`<${Tabs} tabs=${[{ key: 'threads', label: 'Threads' }, ...tabs]} tab=${phoneTab} onTab=${setPhoneTab} />` : null}
      ${!phone || phoneTab === 'threads' ? threads : html`<div class="nx-inpanel"><${ProjectPanelBody} tab=${phoneTab} project=${project} store=${store} done=${done} /></div>`}
    </div>
    ${!phone && panel.open
      ? html`<aside class=${`nx-panel${overlay ? ' overlay' : ''}`} aria-label="Project panel">
          <${Tabs} tabs=${tabs} tab=${tab} onTab=${(t) => panel.set({ tab: t })} onClose=${() => panel.set({ open: false })} />
          <div class="nx-pbody"><${ProjectPanelBody} tab=${tab} project=${project} store=${store} done=${done} /></div>
        </aside>`
      : null}`;
}

export function AgentsPage({ store }) {
  const { state } = store;
  const views = agentViews(state);
  const agents = views[0].items;
  const [current, pick] = usePageView(store, 'agents', views);
  const shown = views.find((v) => v.id === current)?.items || [];
  return html`<div class="nx-col">
    <div class="nx-ihead"><h1 class="nx-h1">Agents</h1></div>
    ${agents.length ? html`<${ViewPills} views=${views} current=${current} onPick=${pick} hot="needs" label="Agent views" />` : null}
    ${shown.length
      ? html`<section class="nx-group">${shown.map((a) => html`<${PlaceRow} key=${a.id} tile=${{ kind: 'agent', id: a.id, name: a.name }} name=${a.name} line=${a.chat ? rowOf(a.chat, { now: state.now }).preview : ''} items=${a.open} health=${[...projectsNote(`agent:${a.id}`, state.projects || []), ...a.health]} store=${store} onOpen=${() => store.nextGo({ page: 'agent', id: a.id })} />`)}</section>`
      : html`<${Empty} text=${agents.length ? 'Nothing here.' : 'No agent conversations yet.'} />`}
  </div>`;
}


/** "Chat with Sierra": the agent's home channel, pinned above its threads. */
function ChatRow({ chat, store, name }) {
  const r = rowOf(chat, { projects: store.state.projects || [], context: { kind: 'agent', id: chat.agentId }, now: store.state.now });
  return html`<a class=${`nx-row nx-chat${store.state.focusId === chat.id ? ' focused' : ''}${r.next ? ' asking' : ''}`} data-row-id=${chat.id} href="#" onFocus=${() => store.set({ focusId: chat.id })} onKeyDown=${(e) => { if (e.key === 'Enter') { store.nextListKey?.(e); e.preventDefault(); e.stopPropagation(); } }} onClick=${(e) => (e.preventDefault(), store.nextOpen(chat.id))} ...${contextMenuProps(store, { kind: 'thread', id: chat.id })}>
    <span class="nx-r1"><${KindGlyph} kind="default" /><span class="nx-title">${r.next || `Chat with ${name}`}</span><span class="nx-time">${r.time}</span></span>
    ${r.preview ? html`<span class="nx-prev">${r.preview}</span>` : null}
    <span class="nx-meta">
      ${r.status ? html`<span class=${`nx-pill ${r.status.cls}`}>${r.status.label}</span>` : null}
      <span class="nx-kind">Default</span>
      ${r.next ? html`<span class="nx-where">Chat with ${name}</span>` : null}
    </span>
  </a>`;
}

/** The agent's ⋯: message it in its chat, or change how it looks. */
export function agentMenu(id, name, store) {
  const chat = agentChat(store.state.lists, id);
  return [
    chat && chat.replyable !== false ? { icon: MI.message, label: `Message ${name}`, onSelect: () => (store.nextOpen(chat.id), store.openReply(chat.id)) } : null,
    { icon: MI.palette, label: 'Icon and color…', onSelect: () => store.openSettings('agents') },
    { icon: MI.edit, label: 'Edit views…', onSelect: () => store.openSettings('spaceviews') },
    { icon: MI.edit, label: 'Space settings', onSelect: () => store.nextGo({ page: 'spacesettings', id: `agent:${id}` }) },
  ].filter(Boolean);
}

export function AgentPage({ store, id, phone = false }) {
  const { state } = store;
  // The agent's threads; its home chat's chapters fold into the one pinned chat.
  const chat = agentChat(state.lists, id);
  // Its chat (a home channel's chapters, or an agent space's default) is pinned once, never also in the list.
  // Its own: the ones in its projects list under those (the Projects group), as a project's children's do.
  const own = ownMatch('agent', id, state.projects || []);
  const { open, done } = threadsIn(state.lists, (i) => own(i) && i.kind !== 'chapter' && i.id !== chat?.id);
  const agent = agentsOf(state.lists, state.now).find((a) => a.id === id);
  const name = agent?.name || id;
  const context = { kind: 'agent', id };
  const items = [{ icon: MI.select, label: 'Select threads', hint: 'x', onSelect: () => store.nextSelectStart('thread') }, 'sep', ...agentMenu(id, name, store)];
  const views = spaceViews(chat ? [chat, ...open] : open, done, shownSpaceViews(state), { now: state.now, projects: state.projects });
  const [view, pickView] = usePageView(store, `agent:${id}`, views);
  const viewItems = (views.find((v) => v.id === view)?.items || []).filter((i) => i.id !== chat?.id);
  const groups = spaceGroups(views.find((v) => v.id === view), viewItems, state.now);
  // Its chat (the space's default) heads the Overview and the Threads view, as the pinned "Chat with" row.
  const showChat = chat && views.find((v) => v.id === view)?.items.some((i) => i.id === chat.id);
  const stands = state.spaces?.[`agent:${id}`]?.stands || chat?.summary?.headline || '';
  const standsAt = state.spaces?.[`agent:${id}`]?.standsAt || (chat?.summary?.headline ? chat.lastActivityAt : null);
  // An agent's space has its chapter as a project's does: Catch me up lands here too (Codex review on #852).
  const chapter = html`<${ChapterCard} store=${store} spaceId=${`agent:${id}`} name=${name} leadName=${chat ? threadTitle(chat) : null} leadAt=${chat?.lastActivityAt || null} line=${stands} at=${standsAt} />`;
  return html`<div class="nx-col">
    <${PlaceHead} tile=${{ kind: 'agent', id, name }} store=${store} name=${name} about=${state.spaces?.[`agent:${id}`]?.about || ''} line=${stands} standsAt=${standsAt} chapter=${chapter} items=${chat ? [chat, ...open] : open} actions=${html`<${MoreButton} items=${items} title=${name} phone=${phone} />`} counts=${false} />
    <${SpaceAsk} lead=${chat} name=${name} store=${store} />
    <${ViewPills} views=${views} current=${view} onPick=${pickView} store=${store} spaceKey=${`agent:${id}`} label="Agent views" />
    ${view === views[0]?.id ? html`<${ChildPlaces} spaceKey=${`agent:${id}`} store=${store} scope=${`agent:${view}`} />` : null}
    ${groups.length || showChat ? html`<${Groups} groups=${[...(showChat ? [{ key: 'default', label: null, items: [chat] }] : []), ...groups]} store=${store} context=${context} scope=${`agent:${view}`} />` : showChat || (view === views[0]?.id && childProjects(`agent:${id}`, state.projects).length) ? null : html`<${Empty} text=${view === views[0]?.id ? overviewEmpty(views, `Nothing with ${name} right now.`) : 'Nothing here.'} />`}
  </div>`;
}

export function MuteChips({ store }) {
  const { state } = store;
  const inventory = facetsFor([...new Map(Object.values(state.lists).flatMap((l) => l.items || []).map((item) => [item.id, item])).values()], state.filters);
  const chips = [['agent', inventory.agents], ['repo', inventory.repos]].flatMap(([facet, values]) => values.filter((v) => isHidden(state.filters, facet, v.id || v.name)).map((v) => ({ facet, value: v.id || v.name, name: v.name })));
  return chips.length ? html`<p class="nx-hidden">Muted: ${chips.map((c) => html`<button class="nx-link" aria-label=${`Unmute ${c.name}`} onClick=${() => store.toggleFilter(c.facet, c.value)}>${c.name} ×</button>`)}</p>` : null;
}

export function FilterChips({ store, items = [] }) {
  const filter = store.state.nextFilter || {};
  const named = (facet, value) => SHOW_ONLY.find(([f, v]) => f === facet && v === value)?.[2];
  const chips = FILTER_FACETS.flatMap(([facet, label]) => (filter[facet] || []).map((value) => ({ facet, value, label: named(facet, value) || `${label}: ${facetLabel(facet, value, store.state.projects || [], items)}` })));
  return chips.length ? html`<p class="nx-filter-chips" aria-label="Filters on this device"><span>On this device:</span> ${chips.map((c) => html`<button class="nx-link" aria-label=${`Remove ${c.label}`} onClick=${() => store.nextSetFilter({ ...filter, [c.facet]: filter[c.facet].filter((v) => v !== c.value) })}>${c.label} ×</button>`)} <button class="nx-link" onClick=${() => store.nextSetFilter({})}>Clear</button></p>` : null;
}

function SaveFilterTab({ store, draft, onClose }) {
  const [name, setName] = useState(draft.name);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    const err = await saveFilteredTab(store, draft, name);
    setPending(false);
    if (err) return setError(err);
    onClose();
  };
  return html`<div class="scrim" onClick=${onClose}>
    <form class="picker ve-pop" role="dialog" aria-modal="true" aria-label="Save as tab" onClick=${(e) => e.stopPropagation()} onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} onSubmit=${save}>
      <h3>Save as tab</h3>
      <label>Name <input class="stg-input" maxlength="40" value=${name} onInput=${(e) => setName(e.currentTarget.value)} ref=${(n) => { if (n && !n.dataset.focused) { n.dataset.focused = '1'; requestAnimationFrame(() => { n.focus(); n.select(); }); } }} /></label>
      ${error ? html`<p role="alert" class="warn">${error}</p>` : null}
      <div class="stg-foot"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn pri" disabled=${pending || !name.trim()}>Save tab</button></div>
    </form>
  </div>`;
}

/** Recheck the shared tab limit at submit; a failed save keeps this device's picks and place. */
export async function saveFilteredTab(store, draft, name) {
  const views = viewsOf(store.state.listViews, store.state.listGroup);
  if (views.length >= MAX_VIEWS) return '20-tab limit reached. Delete a tab first.';
  name = name.trim();
  if (!name || name.length > 40) return 'Give it a name of 1 to 40 characters.';
  const view = filteredView(draft.view, draft.filter, views, name, store.state.projects || []);
  const err = await store.saveListViews([...views, view]);
  if (err) return err;
  store.nextSetFilter({});
  store.nextGo({ page: 'inbox', view: view.id });
  return null;
}
