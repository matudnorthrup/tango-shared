// Search gets its own place; opening a live result leaves this route underneath the thread.
import { html } from '../../vendor/preact-htm.js';
import { SEARCH_ICON } from '../search.js';
import { viewsOf } from '../list-views.js';
import { hitFacets, hitStatus, markParts, messageMatches, searchScope, sortHits, SORTS } from '../search-model.js';
import { rowOf } from './model.js';
import { Tile } from './rows.js';

function ResultRow({ hit, store }) {
  const r = rowOf(hit.row, { projects: store.state.projects || [], now: store.state.now });
  const match = messageMatches(hit)[0];
  const open = () => hit.row.archived ? store.openHit(hit) : store.nextOpen(hit.itemId);
  return html`<article class="nx-row compact nx-search-row" role="link" tabindex="0" aria-label=${`Open ${r.title}`}
    onClick=${open} onKeyDown=${(e) => e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), open())}>
    <span class="nx-r1"><span class="nx-title">${r.title}</span><span class="nx-time">${r.time}</span><${Tile} tile=${r.tile} store=${store} /></span>
    ${match ? html`<span class="nx-prev">${match.how === 'semantic' ? '≈ ' : ''}${markParts(match.snippet).map((p) => p.mark ? html`<mark>${p.text}</mark>` : p.text)}</span>` : r.preview ? html`<span class="nx-prev">${r.preview}</span>` : null}
    <span class="nx-meta">${r.status && !hit.row.archived ? html`<span class=${`nx-pill ${r.status.cls}`}>${r.status.label}</span>` : html`<span class="nx-fact">${hitStatus(hit.row)}</span>`}${r.home ? html`<span class="nx-where">${r.home.name}</span>` : null}</span>
  </article>`;
}

export function SearchPage({ store }) {
  const { state } = store;
  const s = state.search;
  const views = viewsOf(state.listViews, state.listGroup);
  const tab = views.some((v) => v.id === s.tab) ? s.tab : 'all';
  const hits = sortHits(s.hits, s.sort);
  // Offer every known repo and agent, including those outside the ranked result window.
  const rows = new Map(Object.values(state.lists || {}).flatMap((list) => list?.items || []).map((row) => [row.id, row]));
  for (const hit of s.hits) if (!rows.has(hit.itemId)) rows.set(hit.itemId, hit.row);
  const facets = hitFacets([...rows.values()].map((row) => ({ row })));
  // A pick the new words no longer hit stays listed (0), so the filter hiding everything shows (Codex review on #625).
  const kept = (options, picked) => (picked && !options.some(([value]) => value === picked) ? [...options, [picked, `${picked} (0)`]] : options);
  const select = (label, key, options) => html`<label class="sx-sel"><span>${label}</span><select aria-label=${label} value=${s[key]} onChange=${(e) => store.setSearchOption({ [key]: e.target.value })}>${options.map(([value, text]) => html`<option value=${value}>${text}</option>`)}</select></label>`;
  const pending = s.loading || s.searched !== s.query;
  // Open conversations by default; the link widens to done and archived ones and says how many that adds.
  const scope = searchScope(state);
  const scopeLink = scope.link ? html` · <button class="nx-link" onClick=${() => store.setSearchOption({ wide: scope.link.wide })}>${scope.link.label}</button>` : null;
  return html`<div class="nx-col nx-search-page">
    <h1 class="nx-h1">Search</h1>
    <label class="sx-in slim nx-search-field">${SEARCH_ICON}<input type="search" aria-label="Search conversations" placeholder="Search conversations" value=${s.query}
      onInput=${(e) => store.nextGo({ page: 'search', query: e.target.value })} autocomplete="off" spellcheck=${false} />${s.loading ? html`<span class="sx-spin" aria-label="Searching"></span>` : null}</label>
    ${s.tokens?.length ? html`<div class="nx-pills" aria-label="Search fields">${s.tokens.map((t) => html`<span class="nx-fact">${t.field}:${t.value}</span>`)}</div>` : null}
    ${s.space ? html`<label class="sx-sel"><input type="checkbox" aria-label="In this space" checked=${s.scope !== 'global'} onChange=${(e) => { const scope = e.target.checked ? `space:${s.space.id}` : 'global'; store.setSearchOption({ scope }); store.nextGo({ ...state.nextRoute, scope }); }} />In this space · ${s.space.name}</label>` : null}
    <div class="nx-pills" role="tablist" aria-label="Search views">
      ${[{ id: 'all', name: 'All' }, ...views].map((v) => html`<button class=${`nx-ptab${tab === v.id ? ' on' : ''}`} role="tab" aria-selected=${tab === v.id} onClick=${() => store.setSearchOption({ tab: v.id })}>${v.name}</button>`)}
    </div>
    <div class="sx-ctl">
      ${select('Sort', 'sort', SORTS)}
      ${select('Project', 'project', kept([['', 'Any'], ...(state.projects || []).map((p) => [p.id, p.name])], s.project))}
      ${select('Repo', 'repo', kept([['', 'Any'], ...facets.projects.map((p) => [p.name, p.name])], s.repo))}
      ${select('Agent', 'agent', kept([['', 'Any'], ...facets.agents.map((a) => [a.id, a.name])], s.agent))}
    </div>
    ${!s.query.trim() ? html`<p class="nx-empty">Type words to search your conversations.</p>`
      : s.error ? html`<p class="nx-empty warn" role="alert">Search failed: ${s.error}</p>`
      : pending ? html`<p class="nx-empty" role="status">Searching…</p>`
      : html`<p class="nx-hidden" role="status">${s.total}${s.more ? '+' : ''} ${scope.open ? 'open ' : ''}result${s.total === 1 && !s.more ? '' : 's'} · ${s.semantic ? 'Words and meaning' : 'Words only'}${scopeLink}</p>${hits.length ? hits.map((hit) => html`<${ResultRow} key=${hit.itemId} hit=${hit} store=${store} />`) : html`<p class="nx-empty">${s.hits.length ? 'No results match these filters.' : `Nothing ${scope.open ? 'open ' : ''}matches “${s.query}”.`}</p>`}`}
  </div>`;
}
