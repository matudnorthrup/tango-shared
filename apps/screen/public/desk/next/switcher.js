// The next layout's quick switcher (spec: "The quick switcher"): one field over every place (the Inbox
// views, projects, agents), the actions, and as you type, threads matched by words and meaning (the
// desk's search). Opens from ⌘K, "/", the sidebar's search field, the phone's search icon, and pulling
// down past the top of a list. It stays mounted while shut so a tap can focus its field in the tap
// itself: iOS raises the keyboard only then.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { SEARCH_ICON } from '../search.js';
import { ICON_COLORS } from '../list-model.js';
import { agentsOf, homeOf, inboxViews, threadTitle, viewIcon } from './model.js';
import { VIEW_ICONS } from './icons.js';
import { Tile } from './rows.js';
import { criticalOpen } from './system-model.js';
import { newProject } from '../projects-editor.js';
import { searchScope } from '../search-model.js';

/** Focus the switcher's field now, inside the tap or touch that opened it. */
export function focusSwitcher() {
  document.querySelector('.nx-sw input')?.focus({ preventScroll: true });
}

/** The System entry's hint: how many critical incidents are open, else nothing. */
function systemHint(state) {
  const n = criticalOpen(state.system?.data).length;
  return n ? `${n} critical` : '';
}

/** Everything the switcher can go to, with what it shows: [{ section, key, label, hint, tile?, dot?, run }]. */
export function switcherEntries(store, query) {
  const { state } = store;
  const q = query.trim().toLowerCase();
  const match = (text) => !q || String(text || '').toLowerCase().includes(q);
  const out = [];
  for (const { view, items } of inboxViews(state)) {
    if (match(view.name)) out.push({ section: 'Inbox', key: `v:${view.id}`, label: view.name, icon: VIEW_ICONS[viewIcon(view)], hint: items.length ? String(items.length) : '', run: () => store.nextGo({ page: 'inbox', view: view.id }) });
  }
  for (const p of (state.projects || []).filter((p) => !p.finishedAt)) {
    if (match(p.name)) out.push({ section: 'Projects', key: `p:${p.id}`, label: p.name, dot: ICON_COLORS[p.color] || ICON_COLORS.slate, run: () => store.nextGo({ page: 'project', id: p.id }) });
  }
  for (const a of agentsOf(state.lists, state.now)) {
    if (match(a.name)) out.push({ section: 'Agents', key: `a:${a.id}`, label: a.name, tile: { kind: 'agent', id: a.id, name: a.name }, hint: a.needs ? `${a.needs} need you` : '', run: () => store.nextGo({ page: 'agent', id: a.id }) });
  }
  const actions = [
    { key: 'x:new', label: 'New thread', run: () => store.openStartWork({}) },
    { key: 'x:project', label: 'New project', run: () => newProject(store, { then: 'next' }) },
    { key: 'x:settings', label: 'Settings', run: () => store.openFilters() },
    // System is reached here on a phone (no tab of its own); Capacity is its Capacity tab.
    { key: 'x:system', label: 'System', hint: systemHint(state), run: () => store.nextGo({ page: 'system', view: 'overview' }) },
    { key: 'x:capacity', label: 'Capacity', run: () => store.nextGo({ page: 'system', view: 'capacity' }) },
    { key: 'x:routing', label: 'Routing rules', run: () => store.openSettings('routing') },
  ];
  for (const a of actions) if (match(a.label)) out.push({ section: 'Actions', ...a });
  if (q) {
    for (const hit of state.search.hits.slice(0, 8)) {
      const home = homeOf(hit.row, state.projects || []);
      out.push({ section: 'Threads', key: `t:${hit.itemId}`, label: threadTitle(hit.row), hint: home?.name || '', tile: home, run: () => (hit.row.archived ? store.openHit(hit) : store.nextOpen(hit.itemId)) });
    }
  }
  return out;
}

export function Switcher({ store, phone }) {
  const { state } = store;
  const open = !!state.nextSwitcher;
  const s = state.search;
  const input = useRef(null);
  const [cursor, setCursor] = useState(0);
  const entries = open ? switcherEntries(store, s.query) : [];
  const at = Math.min(cursor, Math.max(0, entries.length - 1));
  useEffect(() => {
    if (open) {
      setCursor(0);
      requestAnimationFrame(() => input.current?.focus());
    } else input.current?.blur();
  }, [open]);
  useEffect(() => setCursor(0), [s.query]);
  useEffect(() => {
    document.querySelector('.nx-sw .nx-swi.on')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const close = () => {
    store.set({ nextSwitcher: false });
    // On the Search page an edited query becomes the page's (and the saved route's), so a reload keeps it.
    if (state.nextRoute.page !== 'search') store.setSearchQuery('');
    else if (s.query !== state.nextRoute.query) store.nextGo({ page: 'search', query: s.query }, { keepThread: true });
  };
  const pick = (e) => {
    close();
    e.run();
  };
  // Widen to done and archived conversations, or back to open ones, as on the Search page.
  const scope = searchScope(state).link;
  const scopeLink = scope ? html`<button class="nx-link" onClick=${() => { store.setSearchOption({ wide: scope.wide }); input.current?.focus(); }}>${scope.label}</button>` : null;
  const all = () => {
    store.set({ nextSwitcher: false });
    store.setSearchOption({ tab: 'all', project: '', repo: '', agent: '' });
    store.nextGo({ page: 'search', query: s.query });
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey) && s.query.trim()) return (e.preventDefault(), all());
    if (e.key === 'Escape') return (e.preventDefault(), close());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (entries.length) setCursor((at + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length);
    } else if (e.key === 'Enter' && entries[at]) {
      e.preventDefault();
      pick(entries[at]);
    }
  };
  let last = null;
  return html`<div class=${`nx-sw-scrim${open ? '' : ' shut'}${phone ? ' phone' : ''}`} aria-hidden=${!open} onClick=${(e) => e.target === e.currentTarget && close()}>
    <div class="nx-sw" role="dialog" aria-modal="true" aria-label="Go to">
      <div class="nx-swin">
        ${SEARCH_ICON}
        <input ref=${input} type="search" placeholder="Go to a place, or search threads…" value=${s.query} aria-label="Go to or search" tabIndex=${open ? 0 : -1}
          onInput=${(e) => store.setSearchQuery(e.target.value)} onKeyDown=${onKey} autocomplete="off" spellcheck=${false} />
        ${s.loading ? html`<span class="sx-spin" aria-label="Searching"></span>` : null}
        ${phone ? html`<button class="nx-swx" onClick=${close}>Cancel</button>` : html`<kbd>esc</kbd>`}
      </div>
      <div class="nx-swl" role="listbox">
        ${entries.map((e, i) => {
          const head = e.section !== last ? html`<div class="nx-sws">${e.section}</div>` : null;
          last = e.section;
          return html`${head}<button role="option" aria-selected=${i === at} class=${`nx-swi${i === at ? ' on' : ''}`} onMouseMove=${() => i !== at && setCursor(i)} onClick=${() => pick(e)}>
            ${e.tile ? html`<${Tile} tile=${e.tile} store=${store} size=${20} />` : e.icon ? html`<span class="nx-swic">${e.icon}</span>` : e.dot ? html`<i class="nx-dot" style=${`--c:${e.dot}`}></i>` : html`<span class="nx-swg"></span>`}
            <span class="nx-swt">${e.label}</span>${e.hint ? html`<span class="nx-swh">${e.hint}</span>` : null}
          </button>`;
        })}
        ${open && s.query.trim() && s.error ? html`<p class="nx-empty warn">Thread search failed: ${s.error}</p>` : open && s.query.trim() && !entries.length && !s.loading ? html`<p class="nx-empty">Nothing ${searchScope(state).open ? 'open ' : ''}matches “${s.query}”.</p>` : null}
      </div>
      ${s.query.trim() ? html`<footer class="sx-foot"><button class="nx-link" onClick=${all}>${s.hits.length === 1 ? 'The 1 result' : `All ${s.hits.length}${s.hits.length >= 150 ? '+' : ''} results`}</button>${scopeLink}${phone ? null : html`<span class="sx-keys">⌘ / ⇧ Enter · all results</span>`}</footer>` : null}
    </div>
  </div>`;
}
