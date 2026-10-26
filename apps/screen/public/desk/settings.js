import { historyEnabled, setHistoryEnabled } from './voice-history.js';
// Settings: one window with five pages, picked from a side nav (a strip of tabs on a phone). Each thing is set in one place.
//   This device       · text size, preview lines, sort order; what each open window is for (role.js)
//   Inbox tabs        · the tabs (views-editor.js); mutes at the foot
//   Projects & agents · projects, agents' and repos' icons, a project page's sections, space views
//   Notifications     · the Screen feed, snooze times
//   Accounts          · routing (which accounts each repo's threads run on)
// Everything saves as it changes. A page can open a sub-page (one tab, one project) with a way back.

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { DEFAULT_SNOOZE_TIMES, agentColor } from './util.js';
import { viewsOf } from './list-views.js';
import { GROUPS, agentsOf } from './next/model.js';
import { AGENT_ICON_DEFAULTS, ICON_COLORS, baseAgent, repoIconOf, repoOf } from './list-model.js';
import { facetsFor, isHidden, DEFAULT_TEXT_SCALE, PREVIEW_LINE_CHOICES, applyPreviewLines, applyTextScale, savedPreviewLines, savedTextScale } from './filters.js';
import { IconMask, IconPicker } from './icon-picker.js';
import { ProjectForm, ProjectTile } from './projects-editor.js';
import { ROLE_HINTS, ROLE_NAMES, SCREEN_ROLES } from './role.js';
import { Seg, TabEditor, TabsPage } from './views-editor.js';

const NAV = [
  ['device', 'This device', 'monitor-smartphone'],
  ['tabs', 'Inbox tabs', 'panels-top-left'],
  ['projects', 'Projects & agents', 'folder'],
  ['notifications', 'Notifications', 'bell'],
  ['accounts', 'Accounts', 'route'],
];
const PAGES = NAV.map(([key]) => key);
/** The pages before they were regrouped, so a link to one opens its new home at that section. */
export const SETTINGS_HOME = { display: 'device', windows: 'device', mutes: 'tabs', agents: 'projects', repos: 'projects', spaceviews: 'projects', feed: 'notifications', snooze: 'notifications', routing: 'accounts', };
const SCOPE = { device: 'This device only' };

/** A section of a page: its heading, with an anchor an old page's link scrolls to. */
const section = (key, title, focus) => html`<div id=${`stg-sec-${key}`} class="stg-gh stg-sec" ref=${(n) => n && focus === key && n.dataset.focused !== key && ((n.dataset.focused = key), requestAnimationFrame(() => n.scrollIntoView?.({ block: 'start' })))}><h3>${title}</h3></div>`;

export function SettingsPanel({ store, phone }) {
  const { state } = store;
  if (!state.filterOpen) return null;
  const asked = state.settingsPage;
  const page = PAGES.includes(asked) ? asked : SETTINGS_HOME[asked] || 'device';
  const focus = SETTINGS_HOME[asked] ? asked : null;
  const sub = state.settingsSub;
  const close = () => store.closeFilters();
  const title = NAV.find(([key]) => key === page)[1];
  // A page's title, its scope, and on a sub-page the way back to it.
  const head = (text, back = null, to = page) => html`<header class="stg-h">
    ${back ? html`<button class="stg-back" onClick=${() => store.openSettings(to)}>‹ ${back}</button>` : null}
    <h2>${text}</h2>
    <span class="stg-scope">${SCOPE[page] || 'Every screen'}</span>
  </header>`;
  let body;
  if (asked === 'spaceviews' && sub?.tab) body = html`<${TabEditor} key=${`space:${sub.tab}`} store=${store} id=${sub.tab} space=${null} fresh=${!!sub.fresh} head=${(t) => head(t, 'Space views', 'spaceviews')} />`;
  else if (asked === 'spaceviews') body = html`<${TabsPage} key="space" store=${store} space=${null} head=${(t) => head(t, title)} />`;
  else if (page === 'tabs' && sub?.tab) body = html`<${TabEditor} key=${sub.tab} store=${store} id=${sub.tab} fresh=${!!sub.fresh} head=${(t) => head(t, 'Inbox tabs')} />`;
  else if (page === 'projects' && sub?.project)
    body = html`${head(sub.project === 'new' ? 'New project' : 'Edit project', title)}<${ProjectForm} key=${sub.project} store=${store} editing=${sub.project} inSettings=${true} onDone=${() => store.openSettings('projects')} />`;
  else if (page === 'device')
    body = html`${head(title)}
      <${DisplayPage} store=${store} head=${section('display', 'Text and previews', focus)} />
      <${OrderRow} store=${store} />
      ${state.role !== 'screen' && new URLSearchParams(location.search).get('detached') !== '1' ? html`<div class="stg-foot"><${HistorySetting} /><a class="btn sm" href="history" target="_blank" rel="noopener">Dictation history ↗</a><p class="stg-hint">Private recovery across devices. Opens only for an authenticated owner, outside shared screens.</p></div>` : null}
      <${WindowsPage} store=${store} head=${section('windows', 'Windows', focus)} />`;
  else if (page === 'tabs')
    body = html`<${TabsPage} store=${store} head=${() => head(title)} />
      <${MutesPage} store=${store} head=${section('mutes', 'Mutes', focus)} />`;
  else if (page === 'projects')
    body = html`${head(title)}
      <${ProjectsPage} store=${store} head=${null} />
      <${AgentsPage} store=${store} head=${section('agents', 'Agents', focus)} />
      <${ReposPage} store=${store} head=${section('repos', 'Repos not in a project', focus)} />
      ${section('spaceviewlist', 'Space views', focus)}
      <p class="stg-hint">The views every project and agent page shows. Edit them here, from a project's or agent's ⋯ → Edit views…, or by right-clicking a view.</p>
      <div class="stg-foot"><button class="btn sm" onClick=${() => store.openSettings('spaceviews')}>Edit space views…</button></div>`;
  else if (page === 'notifications')
    body = html`${head(title)}
      <${FeedPage} store=${store} head=${section('feed', 'Feed', focus)} />
      <${SnoozePage} store=${store} head=${section('snooze', 'Snooze times', focus)} />`;
  else if (page === 'accounts') body = html`<${RoutingPage} store=${store} head=${html`${head(title)}${section('routing', 'Routing', focus)}`} />`;

  return html`<div class="scrim stg-scrim" onClick=${close}>
    <div class=${`stg${phone ? ' phone' : ''}`} role="dialog" aria-modal="true" aria-label="Settings" onClick=${(e) => e.stopPropagation()}>
      <nav class="stg-nav" aria-label="Settings">
        <h2>Settings</h2>
        ${NAV.map(([key, label, icon]) => html`<button key=${key} class=${key === page ? 'on' : ''} aria-current=${key === page ? 'page' : null} onClick=${() => store.openSettings(key)}><${IconMask} name=${icon} />${label}</button>`)}
        <span class="stg-sp"></span>
        <button class="stg-act" onClick=${() => (close(), store.toggleActivity(true))}><${IconMask} name="history" />Activity log</button>
      </nav>
      <main class="stg-main">
        <button class="stg-x" onClick=${close} aria-label="Close settings">×</button>
        ${body}
      </main>
    </div>
  </div>`;
}

/** This device's sort for the Inbox and Catch me up, the same pick as the Filter menu's Sort. */
function OrderRow({ store }) {
  const order = store.state.nextOrder === 'oldest' ? 'oldest' : 'newest';
  return html`<div class="stg-group">
    <div class="stg-row">
      <div class="stg-k"><b>Sort order</b><small>Inbox and Catch me up. Oldest first brings up what was left longest; a tab can pick its own</small></div>
      <${Seg} label="Sort order" options=${[['newest', 'Newest first'], ['oldest', 'Oldest first']]} value=${order} onChange=${(next) => store.nextSetOrder?.(next)} />
    </div>
  </div>`;
}

function DisplayPage({ head, store }) {
  const [scale, setScale] = useState(savedTextScale);
  const [lines, setLines] = useState(savedPreviewLines);
  const size = (value) => setScale(applyTextScale(value, { save: true }));
  return html`${head}
    <div class="stg-group">
      <div class="stg-row">
        <div class="stg-k"><b>Text size</b>${scale !== DEFAULT_TEXT_SCALE ? html`<small><button class="linkish" onClick=${() => size(DEFAULT_TEXT_SCALE)}>Reset to ${DEFAULT_TEXT_SCALE}×</button></small>` : null}</div>
        <div class="stg-size">
          <span aria-hidden="true" class="stg-a">A</span>
          <input type="range" min="0.8" max="2" step="0.05" value=${scale} aria-label="Text size" onInput=${(e) => size(e.currentTarget.value)} />
          <span aria-hidden="true" class="stg-a big">A</span>
          <output>${scale.toFixed(2).replace(/0$/, '')}×</output>
        </div>
      </div>
      <div class="stg-row">
        <div class="stg-k"><b>Preview lines</b><small>How much of each row’s update the List shows</small></div>
        <${Seg} label="Preview lines" options=${PREVIEW_LINE_CHOICES.map((c) => [c, c === 'all' ? 'All' : c === 0 ? 'None' : String(c)])} value=${lines} onChange=${(value) => setLines(applyPreviewLines(value, { save: true }))} />
      </div>
    </div>`;
}

/** What a Screen window's feed posts (feed.js; desk/feed.ts): agents talking, and threads turning to you. */
function FeedPage({ store, head }) {
  const { state } = store;
  const [error, setError] = useState(null);
  const f = state.feedSettings || { chatter: 'hidden', needsYou: false, summaries: false, usage: true };
  const save = async (patch) => setError(await store.saveFeedSettings(patch));
  return html`${head}
    <p class="stg-hint">The feed is what a Screen window shows when no screen is up: each thread’s news as it happens (a thread still working posts every few minutes; done or waiting on you, at once), project status and digests, PRs decided and screens put up.</p>
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    <div class="stg-group">
      <div class="stg-row">
        <div class="stg-k"><b>Agents talking</b><small>When agents mail each other’s threads: one line per pair of threads, at most every few minutes</small></div>
        <${Seg} label="Agents talking" options=${[['hidden', 'Hidden'], ['shown', 'Shown']]} value=${f.chatter === 'daily' ? 'shown' : f.chatter} onChange=${(chatter) => save({ chatter })} />
      </div>
      <div class="stg-row">
        <div class="stg-k"><b>Answered asks</b><small>Needs you, Failed and Stuck always post. Off: once answered, retried or checking again, the post folds away</small></div>
        <${Seg} label="Show answered asks" options=${[[false, 'Off'], [true, 'On']]} value=${f.needsYou} onChange=${(needsYou) => save({ needsYou })} />
      </div>
      <div class="stg-row">
        <div class="stg-k"><b>Summaries from threads that post updates</b><small>A thread that wrote its own update today says what happened in it. Off: its model summaries don’t post as well</small></div>
        <${Seg} label="Summaries from threads that post updates" options=${[[false, 'Off'], [true, 'On']]} value=${!!f.summaries} onChange=${(summaries) => save({ summaries })} />
      </div>
      <div class="stg-row">
        <div class="stg-k"><b>Account usage</b><small>A ring per Claude and Codex account above the posts: the week left outside, the 5-hour window inside</small></div>
        <${Seg} label="Account usage" options=${[[true, 'Shown'], [false, 'Hidden']]} value=${f.usage !== false} onChange=${(usage) => save({ usage })} />
      </div>
    </div>`;
}


/** What each open window is for: this one first, then every other one connected now. */
function WindowsPage({ store, head }) {
  const { state } = store;
  const roles = SCREEN_ROLES.map((role) => [role, ROLE_NAMES[role]]);
  const scopes = [['everything', 'Everything'], ...viewsOf(state.listViews).map((v) => [`tab:${v.id}`, `Inbox · ${v.name}`]), ...(state.projects || []).map((p) => [`space:project:${p.id}`, `Project · ${p.name}`]), ...agentsOf(state.lists, state.now).map((a) => [`space:agent:${a.id}`, `Agent · ${a.name}`])];
  const picker = (value, id, name) => html`<label class="stg-row"><span class="stg-k"><b>Feed scope</b><small>News and Needs-you count for ${name}</small></span><select aria-label=${`Feed scope for ${name}`} value=${value || 'everything'} onChange=${(e) => store.setWindowFeedScope(e.target.value, id)}>${!scopes.some(([key]) => key === value) && value ? html`<option value=${value}>Unavailable scope</option>` : null}${scopes.map(([key, label]) => html`<option value=${key}>${label}</option>`)}</select></label>`;
  const others = (state.windows || []).filter((w) => w.id !== state.screenId);
  return html`${head}
    <p class="stg-hint">${ROLE_HINTS[state.role]}. Kept in this window’s address, so a bookmark or a reload opens the same way.</p>
    <div class="stg-group">
      <div class="stg-row">
        <div class="stg-k"><b>This window</b><small>${state.screenId ? `Connected as ${state.screenId}` : 'Connecting…'}</small></div>
        <${Seg} label="This window" options=${roles} value=${state.role} onChange=${(role) => store.setWindowRole(role)} />
      </div>
      ${picker(state.feedScope, null, 'this window')}
    </div>
    ${others.length
      ? html`<div class="stg-gh"><h3>Other windows</h3></div>
          <div class="stg-group">
            ${others.map(
              (w) => html`<div class="stg-row" key=${w.id}>
                <div class="stg-k"><b>${w.name}</b><small>${w.id}</small></div>
                <${Seg} label=${w.name} options=${roles} value=${w.role} onChange=${(role) => store.setWindowRole(role, w.id)} />
              </div>${picker(w.feedScope, w.id, w.name)}`,
            )}
          </div>`
      : null}
    <div class="stg-foot">
      <button class="linkish" onClick=${() => store.openScreenWindow()}>Open a Screen window</button>
    </div>`;
}


function ProjectsPage({ store, head }) {
  const { state } = store;
  const open = (state.projects || []).filter((p) => !p.finishedAt);
  const finished = (state.projects || []).filter((p) => p.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt);
  const edit = (id) => store.openSettings('projects', { project: id });
  const hiddenSections = state.projectSectionsHidden || ['done'];
  const [sectionsError, setSectionsError] = useState(null);
  const saveHidden = async (next) => setSectionsError(await store.saveProjectSectionsHidden(next));
  const meta = (p) => {
    const n = store.projectItems(p.id, ['active', 'snoozed', 'parked']).length;
    return [`${n} open conversation${n === 1 ? '' : 's'}`, p.away ? p.away.state : null, p.linearUrl ? 'linked to Linear' : null].filter(Boolean).join(' · ');
  };
  const when = (at) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return html`${head}
    <div class="stg-gh"><h3>Projects</h3><button class="linkish" onClick=${() => edit('new')}>+ New project</button></div>
    <div class="stg-group">
      ${open.length
        ? open.map((p) => html`<div key=${p.id} class="stg-row">
            <${ProjectTile} project=${p} />
            <div class="stg-k"><b>${p.name}</b><small>${meta(p)}</small></div>
            <button class="btn sm" onClick=${() => edit(p.id)}>Edit</button>
          </div>`)
        : html`<div class="stg-row"><span class="note">No open projects. Make one here, or from a conversation’s ⋯ menu.</span></div>`}
    </div>
    <div class="stg-gh"><h3>Sections on a project’s page</h3></div>
    <p class="stg-hint">What every project shows, unless its ⋯ → Sections picks its own. Hidden ones say how many they hold, and finished threads are always in its History.</p>
    <div class="stg-group">
      ${GROUPS.map(([key, label]) => {
        const shown = !hiddenSections.includes(key);
        return html`<label key=${key} class="stg-row stg-toggle">
          <div class="stg-k"><b>${label}</b></div>
          <input type="checkbox" role="switch" class="stg-switch" checked=${shown} aria-label=${`Show ${label}`} onChange=${() => saveHidden(shown ? GROUPS.map(([k]) => k).filter((k) => k === key || hiddenSections.includes(k)) : hiddenSections.filter((k) => k !== key))} />
        </label>`;
      })}
      ${sectionsError ? html`<div class="stg-row"><span class="warn" role="alert">${sectionsError}</span></div>` : null}
    </div>
    ${finished.length
      ? html`<div class="stg-gh"><h3>Finished</h3></div>
          <div class="stg-group">
            ${finished.map((p) => html`<div key=${p.id} class="stg-row">
              <${ProjectTile} project=${p} />
              <div class="stg-k"><b>${p.name}</b><small>Finished ${when(p.finishedAt)}</small></div>
              <button class="btn sm" onClick=${() => store.reopenProject(p.id)}>Reopen</button>
            </div>`)}
          </div>`
      : null}`;
}

function AgentsPage({ store, head }) {
  const { state } = store;
  const facets = state.facets?.agents || [];
  const agents = [...new Set([...Object.keys(AGENT_ICON_DEFAULTS), ...facets.map((a) => baseAgent(a.id))])].filter((id) => id && id !== 'loom').sort();
  const names = Object.fromEntries(facets.map((a) => [baseAgent(a.id), a.name]));
  const nameOf = (id) => names[id] || id[0].toUpperCase() + id.slice(1);
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState(null);
  const look = (id) => {
    const current = state.agentIcons[id] || AGENT_ICON_DEFAULTS[id] || { icon: '', color: null };
    return { ...current, tint: (current.color && ICON_COLORS[current.color]) || agentColor(id) };
  };
  const save = async (id, next) => setError(await store.saveAgentIcons({ [id]: next }));
  const tile = (id, big = false) => {
    const l = look(id);
    return html`<span class=${`lt${big ? ' big' : ''}`} style=${`--c:${l.tint}`} aria-hidden="true">${l.icon ? html`<i style=${`-webkit-mask-image:url(api/desk/icon/${l.icon}.svg);mask-image:url(api/desk/icon/${l.icon}.svg)`}></i>` : html`<b>${nameOf(id)[0]}</b>`}</span>`;
  };
  const edit = picked && agents.includes(picked) ? picked : null;
  const l = edit ? look(edit) : null;
  return html`${head}
    <p class="stg-hint">Tap an agent to change its icon or color. Loom threads use their project’s icon from Loom.</p>
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    ${edit
      ? html`<div class="stg-card stg-agent-edit" ref=${(n) => n && n.dataset.for !== edit && ((n.dataset.for = edit), n.scrollIntoView?.({ block: 'start', behavior: 'smooth' }))}>
          <div class="stg-gh">${tile(edit, true)}<h3>${nameOf(edit)}</h3><span class="spacer"></span>
            ${state.agentIcons[edit] ? html`<button class="linkish" onClick=${() => save(edit, null)}>Reset to default</button>` : null}
            <button class="btn sm" onClick=${() => setPicked(null)}>Done</button>
          </div>
          <${IconPicker} store=${store} value=${l.icon} color=${l.tint} onPick=${(icon) => save(edit, { icon, color: l.color || null })} />
          <div class="pe-swatches" role="group" aria-label="Color">
            <button type="button" class=${`auto${!l.color ? ' on' : ''}`} style=${`--c:${agentColor(edit)}`} aria-label="Agent color" aria-pressed=${!l.color} title="Agent color" onClick=${() => save(edit, { icon: l.icon || 'circle', color: null })}></button>
            ${Object.entries(ICON_COLORS).map(([key, color]) => html`<button type="button" class=${l.color === key ? 'on' : ''} style=${`--c:${color}`} aria-label=${key} title=${key} aria-pressed=${l.color === key} onClick=${() => save(edit, { icon: l.icon || 'circle', color: key })}></button>`)}
          </div>
        </div>`
      : null}
    <div class="stg-agents">
      ${agents.map((id) => html`<button key=${id} class=${`stg-agent${id === edit ? ' on' : ''}`} aria-pressed=${id === edit} onClick=${() => setPicked(id === edit ? null : id)}>${tile(id, true)}<span>${nameOf(id)}</span></button>`)}
    </div>`;
}

/** A repo's icon and color: a coding thread's tile when no project (or repository) gives it one. */
function ReposPage({ store, head }) {
  const { state } = store;
  // Every repo the desk has threads in (Loom's facets, and the loaded lists for Loom), and any with an icon set, once each (names in any case).
  const loaded = Object.values(state.lists || {}).flatMap((list) => (list.items || []).map(repoOf));
  const byKey = new Map();
  for (const name of [...(state.facets?.repos || []).map((r) => r.name), ...loaded, ...Object.keys(state.repoIcons || {})]) if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  const repos = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState(null);
  const look = (name) => {
    const current = repoIconOf(name, state.repoIcons) || { icon: '', color: null };
    return { ...current, tint: ICON_COLORS[current.color] || ICON_COLORS.slate };
  };
  const save = async (name, next) => setError(await store.saveRepoIcons({ [name]: next }));
  const tile = (name, big = false) => {
    const l = look(name);
    return html`<span class=${`lt${big ? ' big' : ''}`} style=${`--c:${l.tint}`} aria-hidden="true">${l.icon ? html`<i style=${`-webkit-mask-image:url(api/desk/icon/${l.icon}.svg);mask-image:url(api/desk/icon/${l.icon}.svg)`}></i>` : html`<b>${name[0].toUpperCase()}</b>`}</span>`;
  };
  const edit = picked && repos.includes(picked) ? picked : null;
  const l = edit ? look(edit) : null;
  return html`${head}
    <p class="stg-hint">Tap a repo to give it an icon and color. A coding thread shows it when no project gives it one.</p>
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    ${edit
      ? html`<div class="stg-card stg-agent-edit" ref=${(n) => n && n.dataset.for !== edit && ((n.dataset.for = edit), n.scrollIntoView?.({ block: 'start', behavior: 'smooth' }))}>
          <div class="stg-gh">${tile(edit, true)}<h3>${edit}</h3><span class="spacer"></span>
            ${repoIconOf(edit, state.repoIcons) ? html`<button class="linkish" onClick=${() => save(edit, null)}>Remove icon</button>` : null}
            <button class="btn sm" onClick=${() => setPicked(null)}>Done</button>
          </div>
          <${IconPicker} store=${store} value=${l.icon} color=${l.tint} onPick=${(icon) => save(edit, { icon, color: l.color || null })} />
          <div class="pe-swatches" role="group" aria-label="Color">
            ${Object.entries(ICON_COLORS).map(([key, color]) => html`<button type="button" class=${(l.color || 'slate') === key ? 'on' : ''} style=${`--c:${color}`} aria-label=${key} title=${key} aria-pressed=${(l.color || 'slate') === key} onClick=${() => save(edit, { icon: l.icon || 'folder-git-2', color: key })}></button>`)}
          </div>
        </div>`
      : null}
    ${repos.length ? null : html`<p class="stg-hint">No repos yet: they show here once a coding thread runs in one.</p>`}
    <div class="stg-agents">
      ${repos.map((name) => html`<button key=${name} class=${`stg-agent${name === edit ? ' on' : ''}`} aria-pressed=${name === edit} onClick=${() => setPicked(name === edit ? null : name)}>${tile(name, true)}<span>${name}</span></button>`)}
    </div>`;
}

/** What a rule means right now, in a line: how Loom spreads the threads, or why one account is a risk. */
export function routingEffect(ids, running) {
  if (!ids.length) return 'Loom picks from every Claude account.';
  if (ids.length > 1) return `Loom spreads new threads across ${ids.length} accounts and moves one when its account runs low.`;
  return running > 1 ? `${running} running threads share one account: at its limit they have nowhere to move.` : 'Always this one account.';
}

/**
 * Which accounts each repo's new threads may run on (the Start work policy file). Loom picks the account with
 * the most room among them and moves a thread when its account runs low; a pin on the Start work sheet picks one.
 */
function RoutingPage({ store, head }) {
  const { state } = store;
  useEffect(() => {
    void store.loadRouting();
    if (!state.capacity) void store.loadCapacity();
  }, []);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState('');
  const r = state.routing;
  const data = r?.data;
  if (!data) return html`${head}${r?.error ? html`<p class="warn" role="alert">Can’t read the routing rules: ${r.error}</p>` : html`<p class="stg-hint">Loading…</p>`}`;
  const { rules, accounts } = data;
  // Running threads per repo, from the Capacity page's reading when there is one.
  const threads = (state.capacity?.data?.accounts || []).flatMap((a) => a.threads.filter((t) => t.running));
  const runningIn = (repo) => threads.filter((t) => (repo ? t.repo === repo : !rules.repos.some((x) => x.repo === t.repo))).length;
  const asUpdate = (repos, pool) => ({ default: pool, repos: Object.fromEntries(repos.map((x) => [x.repo, x.accounts])) });
  const save = async (repos, pool = rules.default) => setError(await store.saveRouting(asUpdate(repos, pool)));
  const toggle = (ids, id) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const chips = (ids, onChange, keepOne) => html`<span class="stg-chips" role="group" aria-label="Accounts">
    ${accounts.map((a) => {
      const on = ids.includes(a.id);
      const last = keepOne && on && ids.length === 1;
      return html`<button type="button" class=${on ? 'on' : ''} aria-pressed=${on} disabled=${last} title=${last ? 'A repo needs one account at least: remove its rule instead' : ''} onClick=${() => onChange(toggle(ids, a.id))}>
        <span class="nx-dot" style=${`--c:${a.color || 'var(--muted)'}`}></span>${a.name}${a.usage?.weekly != null ? html` <span class="stg-pct">${Math.round(a.usage.weekly)}%</span>` : null}
      </button>`;
    })}
  </span>`;
  const unruled = (data.repos || []).filter((name) => !rules.repos.some((x) => x.repo === name.toLowerCase()));
  return html`${head}
    <p class="stg-hint">Which accounts each repo’s new threads may run on. Loom picks the one with the most room and moves a thread when its account runs low. Plan-first threads still run on Loom.</p>
    ${rules.error ? html`<p class="warn" role="alert">The routing file is broken (${rules.error}). Saving here replaces it.</p>` : null}
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    ${data.editable ? null : html`<p class="warn">No routing file is set up for this desk, so these can’t be changed here.</p>`}
    <div class="stg-routes">
      ${rules.repos.map((rule) => html`<div class="stg-row stg-route" key=${rule.repo}>
        <div class="stg-k"><b>${rule.repo}</b><small class=${rule.accounts.length === 1 && runningIn(rule.repo) > 1 ? 'warn' : ''}>${routingEffect(rule.accounts, runningIn(rule.repo))}</small></div>
        ${chips(rule.accounts, (ids) => save(rules.repos.map((x) => (x.repo === rule.repo ? { ...x, accounts: ids } : x))), true)}
        <button class="linkish stg-del" aria-label=${`Delete the ${rule.repo} rule`} title="Its threads follow Everything else" onClick=${() => save(rules.repos.filter((x) => x.repo !== rule.repo))}>Delete rule</button>
      </div>`)}
      <div class="stg-row stg-route">
        <div class="stg-k"><b>Everything else</b><small>${routingEffect(rules.default, runningIn(null))}</small></div>
        ${chips(rules.default, (ids) => save(rules.repos, ids), false)}
      </div>
    </div>
    ${unruled.length
      ? html`<div class="stg-foot">
          <select class="stg-input" aria-label="Repo" value=${adding} onChange=${(e) => setAdding(e.currentTarget.value)}>
            <option value="">Add a rule for a repo…</option>
            ${unruled.map((name) => html`<option value=${name}>${name}</option>`)}
          </select>
          <button class="btn sm" disabled=${!adding} onClick=${() => (save([...rules.repos, { repo: adding.toLowerCase(), accounts: rules.default.length ? rules.default : [accounts[0].id] }]), setAdding(''))}>Add</button>
        </div>`
      : null}`;
}

/** The snooze picker's "morning" (also Monday's) and "evening" times, for every screen. */
function SnoozePage({ store, head }) {
  const times = store.state.snoozeTimes;
  const [error, setError] = useState(null);
  const save = async (key, value) => {
    if (!value || value === times[key]) return;
    setError(await store.saveSnoozeTimes({ [key]: value }));
  };
  const isDefault = times.morning === DEFAULT_SNOOZE_TIMES.morning && times.evening === DEFAULT_SNOOZE_TIMES.evening;
  const row = (key, label, uses) => html`<label class="stg-row">
    <div class="stg-k"><b>${label}</b><small>${uses}</small></div>
    <input type="time" class="stg-input stg-time" step="300" aria-label=${`${label} snooze time`} value=${times[key]} onChange=${(e) => save(key, e.currentTarget.value)} />
  </label>`;
  return html`${head}
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    <div class="stg-group">
      ${row('morning', 'Morning', '“Tomorrow morning” and “Monday”')}
      ${row('evening', 'Evening', '“This evening”')}
    </div>
    <div class="stg-foot">
      <button class="linkish" disabled=${isDefault} onClick=${async () => setError(await store.saveSnoozeTimes({ ...DEFAULT_SNOOZE_TIMES }))}>Reset to 6 am / 6 pm</button>
    </div>`;
}

export function MutesPage({ store, head }) {
  const { state } = store;
  const inventory = state.facets || facetsFor([...new Map(Object.values(state.lists).flatMap((l) => l.items || []).map((item) => [item.id, item])).values()], state.filters);
  return html`${head}<p class="stg-hint">Mute conversations in the Inbox and owner queues. They stay visible in projects, agents and Search.</p>
    ${[['agent', 'Agents', inventory.agents], ['repo', 'Repos', inventory.repos]].map(([facet, label, values]) => html`<div class="stg-gh"><h3>${label}</h3></div><div class="stg-group">${(values || []).map((v) => html`<label class="stg-row"><span class="stg-k"><b>${v.name}</b><small>${v.count} conversations</small></span><input type="checkbox" aria-label=${`Mute ${v.name}`} checked=${isHidden(state.filters, facet, v.id || v.name)} onChange=${() => store.toggleFilter(facet, v.id || v.name)} /></label>`)}</div>`)}`;
}

function HistorySetting() {
  const [enabled, setEnabled] = useState(historyEnabled);
  const [error, setError] = useState('');
  return html`<label><input type="checkbox" checked=${enabled} onChange=${e => {
    try { setHistoryEnabled(e.currentTarget.checked); setEnabled(e.currentTarget.checked); setError(''); }
    catch { setError('Could not save this device’s setting.'); }
  }} /> Save new desk dictations from this device</label>
  <p class="stg-hint">Saves text, never audio, in your private history across devices for 7 days (up to 200 entries). Applies to new dictation sessions. Turn off here in Settings → This device. Clear saved text in Dictation history.</p>
  ${error ? html`<p role="alert">${error}</p>` : null}`;
}
