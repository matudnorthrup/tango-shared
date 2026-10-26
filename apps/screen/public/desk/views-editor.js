// Settings → Tabs: the owner's List tabs, as views they define (list-views.js). The Tabs page (put
// them in order, add one, back to the built-in ones) and one tab's page: its name, what it filters
// through the shared query facets, how it groups and sorts.
// Every change is saved at once, for every screen.

import { FILTER_FACETS, SHOW_ONLY, facetLabel, filterOptions, spaceViewDefs, whereChoices } from './next/model.js';
import { agentId, viewToQuery } from './query.js';
import { html, useState } from '../vendor/preact-htm.js';
import { TYPES, rowWhere } from './list-model.js';
import { DEFAULT_VIEWS, LIVE, MAX_VIEWS, SORTS, STATUSES, VIEW_GROUPS, describeView, newViewId, viewsOf } from './list-views.js';
import { ReorderList } from './reorder.js';

// Workspace stays on a tab grouped by it, until that's changed: projects and the sidebar replaced it.
const INBOX_GROUPS = ['live', 'project', 'workspace', 'none'];
const NAMES = Object.fromEntries([...TYPES.map(([k, l]) => [k, l.toLowerCase()])]);
const namesWith = (projects) => ({ ...NAMES, ...Object.fromEntries((projects || []).map((p) => [`project:${p.id}`, p.name])) });
/** Names for a tab's one-line summary: places by their path (Tango › Desk), Waiting on and Last active in words. */
function tabNames(state, items, views) {
  const names = namesWith(state.projects);
  const picked = views.flatMap((v) => [...(v.where?.where?.in || []), ...(v.where?.where?.not || [])]);
  for (const [value, label] of whereChoices(items, state, picked)) names[`where:${value}`] = label;
  for (const facet of ['wait', 'age', 'source', 'account']) for (const v of views.flatMap((view) => [...(view.where?.[facet]?.in || []), ...(view.where?.[facet]?.not || [])])) names[`${facet}:${v}`] = facetLabel(facet, v, state.projects || [], items);
  return names;
}

/** repositorys and agents the desk has items from, for the tab filters' choices. */
function choicesFrom(lists, view = {}) {
  const items = ['active', 'snoozed', 'history'].flatMap((key) => lists[key]?.items || []);
  // What the tab already filters on stays a choice even when no item carries it any more, so it can be cleared.
  const workspaces = [...new Set([...items.filter((i) => i.source === 'loom').map(rowWhere).filter(Boolean), ...(view.workspace || [])])].sort();
  const agents = new Map();
  // A named persona, including the owner of a coding thread placed in an agent space.
  for (const item of items) if (agentId(item)) agents.set(agentId(item), item.facts?.agentSpace?.name || item.agentName || agentId(item));
  for (const id of view.agent || []) if (!agents.has(id)) agents.set(id, id);
  return { workspaces, agents: [...agents.entries()].sort((a, b) => a[1].localeCompare(b[1])) };
}

function Chips({ label, options, values, onChange, checkboxes = false }) {
  const set = new Set(values || []);
  const toggle = (key) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange([...next]);
  };
  return html`<div class="stg-f" role="group" aria-label=${label}>
    <span class="stg-l">${label}${set.size ? null : html` <span class="stg-any">· any</span>`}</span>
    <span class="stg-chips">
      ${options.map(([key, name]) => checkboxes ? html`<label class="stg-facet-check"><input type="checkbox" checked=${set.has(key)} onChange=${() => toggle(key)} />${name}</label>` : html`<button type="button" class=${set.has(key) ? 'on' : ''} aria-pressed=${set.has(key)} onClick=${() => toggle(key)}>${name}</button>`)}
    </span>
  </div>`;
}

export function Seg({ label, options, value, onChange }) {
  return html`<span class="gby" role="group" aria-label=${label}>
    ${options.map(([key, name]) => html`<button type="button" class=${value === key ? 'on' : ''} aria-pressed=${value === key} onClick=${() => onChange(key)}>${name}</button>`)}
  </span>`;
}

/** Saves the whole list of tabs; resolves true when the desk took it, else shows why. */
function useSave(store, space = undefined) {
  const [error, setError] = useState(null);
  const save = async (next) => {
    const err = await (space !== undefined ? store.saveSpaceViews(next) : store.saveListViews(next));
    setError(err);
    return !err;
  };
  return [save, error];
}

export function TabsPage({ store, head, space = undefined }) {
  const { state } = store;
  const [save, error] = useSave(store, space);
  const [restoring, setRestoring] = useState(false);
  const isSpace = space !== undefined;
  const page = isSpace ? 'spaceviews' : 'tabs';
  const open = (tab, fresh = false) => store.openSettings(page, tab ? { tab, fresh } : undefined);
  const views = isSpace ? spaceViewDefs(state) : viewsOf(state.listViews, state.listGroup);
  const byId = Object.fromEntries(views.map((v) => [v.id, v]));
  const names = tabNames(state, ['active', 'snoozed', 'history'].flatMap((key) => state.lists[key]?.items || []), views);
  const custom = isSpace ? state.spaceViews : Array.isArray(state.listViews) && state.listViews.length;
  const add = async () => {
    const view = isSpace ? { id: newViewId(views, 'new view'), name: 'New view', where: {}, group: 'status', sort: 'recent' } : { id: newViewId(views, 'new tab'), name: 'New tab', status: ['active'], group: 'live', sort: 'recent', fold: true, showProjects: ['active'] };
    if (await save([...views, view])) {
      if (!isSpace) store.setListTab(view.id);
      open(view.id, true);
    }
  };
  return html`
    ${head(isSpace ? 'Space views' : 'Tabs')}
    <p class="stg-hint">${isSpace ? 'The views every project and agent page shows.' : 'Each tab is a saved filter of your conversations.'} Drag to reorder; tap one to edit it.</p>
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    <div class="stg-group">
      <${ReorderList}
        label="Tabs"
        keys=${views.map((v) => v.id)}
        name=${(id) => byId[id]?.name || id}
        onMove=${(ids) => save(ids.map((id) => byId[id]))}
        row=${(id) => html`<button class="ro-open" onClick=${() => open(id)}>
          <span class="ro-name">${byId[id].name}</span>
          <span class="ro-desc">${isSpace ? (byId[id].done ? 'Done conversations' : 'Open conversations') : describeView(byId[id], names)}</span>
          <span class="ro-chev" aria-hidden="true">›</span>
        </button>`}
      />
    </div>
    <div class="stg-foot">
      ${custom
        ? restoring
          ? html`<span class="stg-confirm">${isSpace ? 'Your space views are replaced by the built-in ones.' : `Your tabs are replaced by the built-in ones: ${DEFAULT_VIEWS.map((v) => v.name).join(', ')}.`} <button class="linkish danger" onClick=${async () => (await save(null)) && setRestoring(false)}>Restore</button> <button class="linkish" onClick=${() => setRestoring(false)}>Keep mine</button></span>`
          : html`<button class="linkish" onClick=${() => setRestoring(true)}>${isSpace ? 'Restore the built-in views' : 'Restore the built-in tabs'}</button>`
        : html`<span class="note">${isSpace ? 'The built-in views' : 'The built-in tabs'}</span>`}
      <span class="spacer"></span>
      <button class="btn sm pri" disabled=${views.length >= MAX_VIEWS} onClick=${add}>+ New ${isSpace ? 'view' : 'tab'}</button>
    </div>`;
}

export function TabEditor({ store, id, fresh, head, space = undefined }) {
  const { state } = store;
  const [save, error] = useSave(store, space);
  const [name, setName] = useState(null); // the name while it's being typed
  const [deleting, setDeleting] = useState(false);
  const isSpace = space !== undefined;
  const page = isSpace ? 'spaceviews' : 'tabs';
  const open = (tab, fresh = false) => store.openSettings(page, tab ? { tab, fresh } : undefined);
  const views = isSpace ? spaceViewDefs(state) : viewsOf(state.listViews, state.listGroup);
  const view = views.find((v) => v.id === id);
  if (!view) return html`${head('Tab')}<p class="note">This tab is gone (deleted on another screen?).</p>`;
  const items = ['active', 'snoozed', 'history'].flatMap((key) => state.lists[key]?.items || []);
  const facetOptions = filterOptions(items, state.projects || [], {}, state.now);
  const extraOptions = isSpace ? FILTER_FACETS.filter(([facet]) => ['wait', 'overdue', 'age', 'health', 'source', 'account'].includes(facet)).map(([facet, label, where]) => [facet, label, facetOptions[facet].filter((o) => o.value !== NONE).map((o) => [o.value, o.label]), where === 'advanced' ? 'advanced' : undefined]) : [];
  const { workspaces, agents } = choicesFrom(state.lists, isSpace ? Object.fromEntries(Object.entries(view.where || {}).map(([k, f]) => [k, [...(f.in || []), ...(f.not || [])]])) : view);
  const commit = (patch) => save(views.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const put = (key) => (value) => commit({ [key]: Array.isArray(value) && !value.length ? undefined : value });
  const saveName = () => {
    const next = (name ?? view.name).trim();
    setName(null);
    if (next && next !== view.name) commit({ name: next });
  };
  const remove = async () => {
    if (await save(views.filter((v) => v.id !== id))) open();
  };
  return html`
    ${head(view.name)}
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    <p class="stg-summary">${isSpace ? 'Shown on every project and agent page' : describeView(view, tabNames(state, items, [view]))}</p>
    <label class="stg-f"><span class="stg-l">Name</span>
      <input type="text" class="stg-input" maxlength="40" value=${name ?? view.name}
        ref=${(n) => fresh && n && !n.dataset.f && ((n.dataset.f = '1'), requestAnimationFrame(() => (n.focus(), n.select())))}
        onInput=${(e) => setName(e.currentTarget.value)}
        onBlur=${saveName}
        onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
    <div class="stg-card">
      <h3>Which conversations</h3>
      ${isSpace ? html`<${SpaceFacets} view=${view} commit=${commit} workspaces=${workspaces} agents=${agents} showAgent=${true} extraOptions=${extraOptions} />` : html`<${Chips} label="Status" options=${STATUSES} values=${view.status} onChange=${(status) => { const where = { ...view.where }; delete where.disposition; commit({ status, ...(view.where ? { where } : {}) }); }} />
      <${InboxFacets} view=${view} commit=${commit} state=${state} items=${items} />`}
    </div>
    <div class="stg-card">
      <h3>How it’s laid out</h3>
      <div class="stg-f stg-inline"><span class="stg-l">Group by</span><${Seg} label="Group by" options=${(isSpace ? [['status', 'Status'], ['health', 'Health'], ['none', 'None']] : INBOX_GROUPS.map((key) => VIEW_GROUPS.find(([k]) => k === key))).filter(([key]) => (key !== 'workspace' || view.group === 'workspace'))} value=${view.group || (isSpace ? 'status' : 'live')} onChange=${put('group')} /></div>
      ${view.group === 'workspace'
        ? html`<label class="stg-f stg-inline stg-check"><input type="checkbox" checked=${!!view.agentsTogether} onChange=${(e) => commit({ agentsTogether: e.currentTarget.checked || undefined })} /> Group Tango agents together</label>`
        : null}
      <div class="stg-f stg-inline"><span class="stg-l">Sort</span><${Seg} label="Sort" options=${isSpace ? SORTS.filter(([key]) => key === 'recent' || key === 'asks') : SORTS} value=${view.sort || 'recent'} onChange=${put('sort')} /></div>
    </div>
    <div class="stg-foot">
      ${views.length > 1
        ? deleting
          ? html`<span class="stg-confirm">Delete “${view.name}”? <button class="linkish danger" onClick=${remove}>Delete</button> <button class="linkish" onClick=${() => setDeleting(false)}>Keep</button></span>`
          : html`<button class="linkish danger" onClick=${() => setDeleting(true)}>Delete ${isSpace ? 'view' : 'tab'}</button>`
        : null}
      <span class="spacer"></span>
      <span class="note">Changes save as you go</span>
    </div>`;
}

/** Space filters keep the query shape intact, including exclusions and unset choices. */
export function putSpaceFacet(view, facet, operation, values) {
  const where = { ...view.where, [facet]: { ...view.where?.[facet], [operation]: values } };
  if (Array.isArray(values) && !values.length) delete where[facet][operation];
  if (!Object.keys(where[facet]).length) delete where[facet];
  return { where };
}
function SpaceFacets({ view, commit, workspaces, agents, showAgent, inboxOptions = null, extraOptions = [] }) {
  const options = (inboxOptions || [
    ['kind', 'Kind', [['thread', 'Thread'], ['default', 'Default'], ['job', 'Job'], ['worker', 'Worker']]],
    ['live', 'Live state', LIVE],
    ['busy', 'Busy', [['working', 'Working'], ['background', 'Background']]],
    ['unread', 'Unread', [['true', 'Unread'], ['false', 'Read']]],
    ['workspace', 'Workspace / repo', workspaces.map((k) => [k, k])],
    ...(showAgent ? [['agent', 'Agent', agents]] : []),
    ['pinned', 'Pinned', [['true', 'Pinned'], ['false', 'Unpinned']]],
    ...extraOptions,
  ]).map(([facet, label, choices, advanced]) => [facet, label, [...choices], advanced]);
  // Saved inventory values stay removable after the last conversation disappears.
  for (const [facet, , choices] of options) for (const value of [...(view.where?.[facet]?.in || []), ...(view.where?.[facet]?.not || [])]) if (!choices.some(([key]) => key === value)) choices.push([value, value]);
  const renderFacet = ([facet, label, choices]) => html`<div>
      <${Chips} checkboxes=${true} label=${label} options=${choices} values=${view.where?.[facet]?.in} onChange=${(v) => commit(putSpaceFacet(view, facet, 'in', v))} />
      <${Chips} checkboxes=${true} label=${`Exclude ${label.toLowerCase()}`} options=${choices} values=${view.where?.[facet]?.not} onChange=${(v) => commit(putSpaceFacet(view, facet, 'not', v))} />
      ${['type', 'busy', 'workspace', 'repo', 'agent', 'project', 'space', 'wait', 'age', 'health', 'source', 'account'].includes(facet) ? html`<div class="stg-f"><span class="stg-l">Unset ${label.toLowerCase()}</span><${Seg} label=${`Unset ${label}`} options=${[['any', 'Either'], ['include', 'Include unset'], ['exclude', 'Exclude unset']]} value=${view.where?.[facet]?.unset === true ? 'include' : view.where?.[facet]?.unset === false ? 'exclude' : 'any'} onChange=${(v) => { const patch = putSpaceFacet(view, facet, 'unset', v === 'include' ? true : false); if (v === 'any') { delete patch.where[facet].unset; if (!Object.keys(patch.where[facet]).length) delete patch.where[facet]; } commit(patch); }} /></div>` : null}
    </div>`;
  return html`
    ${inboxOptions ? null : html`<div class="stg-f"><label class="stg-facet-check"><input type="checkbox" checked=${!!view.done} onChange=${(e) => commit({ done: e.currentTarget.checked })} />Done conversations instead of open ones</label></div>`}
    ${options.filter(([, , , advanced]) => !advanced).map(renderFacet)}
    <details><summary>Advanced</summary>${options.filter(([, , , advanced]) => advanced).map(renderFacet)}</details>
  `;
}

/** The Filter menu's no-value option: a facet's "unset" (No wait, No type) as one more choice. */
const NONE = '\u0000none';
const UNSET_LABELS = { wait: 'No wait', age: 'No activity', busy: 'Idle', project: 'Not in a project', agent: 'No agent', repo: 'No repo', workspace: 'No repo', space: 'No space', type: 'No type', source: 'No source', account: 'No account' };

/** A facet's saved filter as the tab editor shows it: picked values, and whether they're excluded rather than wanted. */
export function facetPicks(filter = {}) {
  const exclude = !filter.in?.length && filter.unset !== true && (!!filter.not?.length || filter.unset === false);
  if (exclude) return { exclude, picked: [...(filter.not || []), ...(filter.unset === false ? [NONE] : [])], also: [] };
  // A filter saved with both (an older tab, or a Save as tab): its exclusions stay, listed apart.
  return { exclude, picked: [...(filter.in || []), ...(filter.unset === true ? [NONE] : [])], also: filter.not || [] };
}

/** The filter for these picks: "any of these", or with `exclude` "none of these". Undefined when nothing is picked. */
export function facetFilter(picked, exclude, also = []) {
  const values = picked.filter((v) => v !== NONE);
  const unset = picked.includes(NONE);
  const keep = !exclude && also.length ? { not: also } : {};
  if (!values.length && !unset && !keep.not) return undefined;
  return exclude
    ? { ...(values.length ? { not: values } : {}), ...(unset ? { unset: false } : {}) }
    : { ...(values.length ? { in: values } : {}), ...(unset ? { unset: true } : {}), ...keep };
}

/** One facet: its values (Unset among them), any of which a conversation may have, and one Exclude instead switch. */
function FacetPicker({ label, choices, filter, onChange, onRemove = null, named = (v) => v }) {
  const { exclude, picked, also } = facetPicks(filter);
  const options = [...choices, ...picked.filter((v) => !choices.some(([key]) => key === v)).map((v) => [v, named(v)])];
  return html`<div class="stg-facet">
    <${Chips} checkboxes=${true} label=${exclude ? `${label} · not these` : label} options=${options} values=${picked} onChange=${(next) => onChange(facetFilter(next, exclude, also))} />
    <div class="stg-facet-foot">
      <label class="stg-facet-check"><input type="checkbox" checked=${exclude} disabled=${!picked.length} onChange=${() => onChange(facetFilter(picked, !exclude))} />Exclude instead</label>
      ${also.length ? html`<span class="note">Also leaves out ${also.map(named).join(', ')} <button class="linkish" onClick=${() => onChange(facetFilter(picked, false))}>Stop</button></span>` : null}
      ${onRemove ? html`<button class="linkish danger" onClick=${onRemove}>Remove</button>` : null}
    </div>
  </div>`;
}

/** The Inbox tab's filters in the Filter menu's words: Live state, Where, Show only, Waiting on, Last active; Kind, Source, Account under Advanced. */
function InboxFacets({ view, commit, state, items }) {
  const where = { ...viewToQuery(view).where };
  delete where.disposition;
  const projects = state.projects || [];
  const options = filterOptions(items, projects, {}, state.now);
  const saved = (facet) => [...(where[facet]?.in || []), ...(where[facet]?.not || [])];
  // Repos match whatever the case ("Tango" is "tango"), so a saved repo and the one threads spell are one choice.
  const caseless = (facet) => ['repo', 'workspace'].includes(facet);
  const choicesOf = (facet) => [...new Map((options[facet] || []).map((o) => {
    const value = caseless(facet) && o.value !== NONE ? (saved(facet).find((v) => v.toLowerCase() === o.value.toLowerCase()) ?? o.value.toLowerCase()) : o.value;
    return [value, [value, o.value === NONE ? UNSET_LABELS[facet] || o.label : o.label]];
  })).values()];
  const named = (facet) => (v) => (v === NONE ? UNSET_LABELS[facet] || 'None' : facetLabel(facet, v, projects, items));
  const whereNames = Object.fromEntries(whereChoices(items, state, saved('where')));
  const main = [
    ['live', 'Live state', LIVE],
    ['where', 'Where', Object.entries(whereNames)],
    ['wait', 'Waiting on', choicesOf('wait')],
    ['age', 'Last active', choicesOf('age').filter(([v]) => v !== NONE)],
  ];
  const advanced = [
    ['kind', 'Kind', [['thread', 'Thread'], ['default', 'Default']]],
    ['source', 'Source', choicesOf('source')],
    ['account', 'Account', choicesOf('account')],
  ];
  // Show only: a facet that holds exactly the one toggle value.
  const isToggle = (facet, value) => where[facet]?.in?.length === 1 && where[facet].in[0] === value && !where[facet].not?.length && where[facet].unset === undefined;
  const toggles = SHOW_ONLY.filter(([facet]) => !where[facet] || SHOW_ONLY.some(([f, v]) => f === facet && isToggle(f, v)));
  const shown = new Set([...main, ...advanced].map(([facet]) => facet).concat(toggles.map(([facet]) => facet)));
  // Filters only an older tab has (Project, Agent, Repo, Space, Read…): still editable, and one tap removes each.
  const older = Object.keys(where).filter((facet) => !shown.has(facet));
  const update = (facet, filter) => {
    const next = { ...where };
    if (filter) next[facet] = filter;
    else delete next[facet];
    commit({ ...Object.fromEntries(['live', 'busy', 'unread', 'kind', 'pinned', 'type', 'workspace', 'agent', 'projects', 'inProject'].map((key) => [key, undefined])), where: { ...(view.where?.disposition ? { disposition: view.where.disposition } : {}), ...next } });
  };
  const picker = ([facet, label, choices], extra = {}) => html`<${FacetPicker} key=${facet} label=${label} choices=${choices} filter=${where[facet]} onChange=${(f) => update(facet, f)} named=${facet === 'where' ? (v) => whereNames[v] || named('where')(v) : named(facet)} ...${extra} />`;
  const label = (facet) => FILTER_FACETS.find(([f]) => f === facet)?.[1] || { live: 'Live state', workspace: 'Repo', type: 'Type' }[facet] || facet;
  return html`
    ${main.slice(0, 2).map((f) => picker(f))}
    <div class="stg-f" role="group" aria-label="Show only">
      <span class="stg-l">Show only${toggles.some(([f, v]) => isToggle(f, v)) ? null : html` <span class="stg-any">· everything</span>`}</span>
      <span class="stg-chips">${toggles.map(([facet, value, name]) => html`<button type="button" class=${isToggle(facet, value) ? 'on' : ''} aria-pressed=${isToggle(facet, value)} onClick=${() => update(facet, isToggle(facet, value) ? undefined : { in: [value] })}>${name}</button>`)}</span>
    </div>
    ${main.slice(2).map((f) => picker(f))}
    ${older.length ? html`<div class="stg-older"><p class="stg-hint">From before the Filter menu changed. They still apply; edit or remove them here.</p>
      ${older.map((facet) => picker([facet, label(facet), choicesOf(facet)], { onRemove: () => update(facet, undefined) }))}</div>` : null}
    <details open=${advanced.some(([facet]) => where[facet])}><summary>Advanced</summary>${advanced.map((f) => picker(f))}</details>
  `;
}
