import { doneLabel } from '../query-identity.js';
// The next layout's thread row and tiles (spec: "Thread row"). One row, the same in every list.

import { PrChip } from './prs.js';
import { Component, html, useState } from '../../vendor/preact-htm.js';
import { useRowSwipe } from '../list.js';
import { Menu, contextMenuProps } from './menu.js';
import { threadMenu } from './thread.js';
import { projectTile, ICON_COLORS, AGENT_ICON_DEFAULTS, canActOnRow, repoIconOf } from '../list-model.js';
import { agentColor, inFlightOf } from '../util.js';
import { rowOf, shownRows, statusWords, KINDS } from './model.js';
import { linked } from '../decision-links.js';
import { GroupPick, SelectCheck, both, useLongPress } from './select.js';

const REPO_GLYPH = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>`;

/** A project's tile, an agent's avatar (its Discord picture when the desk has it), or a repo's icon (Loom's, else the owner's) or glyph. */
export function Tile({ tile, store, size = 22 }) {
  if (!tile) return null;
  const style = `--ts:${size}px`;
  if (tile.kind === 'project') {
    const t = projectTile(tile.project || (store.state.projects || []).find((p) => p.id === tile.id));
    return html`<span class="nx-tile" style=${`${style};--c:${t.color}`} title=${t.title} aria-hidden="true">
      ${t.icon ? html`<i style=${`-webkit-mask-image:url(api/desk/icon/${t.icon}.svg);mask-image:url(api/desk/icon/${t.icon}.svg)`}></i>` : html`<b>${t.letter}</b>`}
    </span>`;
  }
  if (tile.kind === 'agent') {
    const agent = (store.state.agents || []).find((a) => a.id === tile.id);
    if (agent?.avatar) return html`<img class="nx-tile nx-av" style=${style} src=${agent.avatar} alt="" title=${tile.name} loading="lazy" />`;
    const chosen = store.state.agentIcons?.[tile.id] || AGENT_ICON_DEFAULTS[tile.id];
    const color = (chosen?.color && ICON_COLORS[chosen.color]) || agentColor(tile.id);
    return html`<span class="nx-tile" style=${`${style};--c:${color}`} title=${tile.name} aria-hidden="true">
      ${chosen?.icon ? html`<i style=${`-webkit-mask-image:url(api/desk/icon/${chosen.icon}.svg);mask-image:url(api/desk/icon/${chosen.icon}.svg)`}></i>` : html`<b>${(tile.name || '?')[0].toUpperCase()}</b>`}
    </span>`;
  }
  const look = tile.look || repoIconOf(tile.id, store.state.repoIcons);
  if (look?.icon) {
    return html`<span class="nx-tile" style=${`${style};--c:${ICON_COLORS[look.color] || ICON_COLORS.slate}`} title=${tile.name} aria-hidden="true">
      <i style=${`-webkit-mask-image:url(api/desk/icon/${look.icon}.svg);mask-image:url(api/desk/icon/${look.icon}.svg)`}></i>
    </span>`;
  }
  return html`<span class="nx-tile repo" style=${style} title=${tile.name} aria-hidden="true">${REPO_GLYPH}</span>`;
}

/** A conversation's kind as a glyph before its title: a thread (quiet grey), its space's chat, a job, a worker. */
export const KIND_GLYPHS = {
  thread: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/></svg>`,
  default: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5V13h-4v-3h-3v3h-4z"/></svg>`,
  job: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/></svg>`,
  worker: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3v5a2 2 0 0 0 2 2h7M10 7.5 12.5 10 10 12.5"/></svg>`,
};
export function KindGlyph({ kind }) {
  const glyph = KIND_GLYPHS[kind];
  return glyph ? html`<span class=${`nx-kg ${kind}`} title=${KINDS[kind]}>${glyph}</span>` : null;
}

const SWIPE_ICONS = {
  done: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  more: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>`,
  snooze: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 1 1 8.5 4a7 7 0 0 0 11.5 11.5z"/></svg>`,
};

/**
 * A thread row (spec: "Thread row"). The big line is what the thread needs from you when it's waiting on
 * you (the next action), else its title; then the latest message; then the status pill, the thread's own
 * title when it isn't the big line, where it lives, and the quiet facts. Time and tile sit at the right.
 * On a touch screen (a phone, an iPad) it swipes as the classic List's rows do: right for Done, left for
 * More and Snooze; a short swipe holds the buttons open. With a mouse, a right-click opens its ⋯ menu at the pointer.
 * While its list is a picker (select.js) it shows a check, a tap (Shift: a range) toggles it, and it doesn't swipe;
 * a long press on a touch screen starts that.
 */
export function ThreadRow({ item, store, context = null, compact = false, kids = null }) {
  // Redrawn only when something it shows changed: a list update (every agent message) left most rows as they were.
  const s = store.state;
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  return html`<${QuietRow} item=${item} store=${store} context=${context} compact=${compact} kidsN=${kids?.n || 0} kidsOpen=${!!kids?.open} projects=${s.projects} now=${s.now} select=${s.nextSelect} focused=${s.focusId === item.id}
    filters=${s.filters} agents=${s.agents} agentIcons=${s.agentIcons} repoIcons=${s.repoIcons} layout=${root?.className || ''} />`;
}

/** Every value the row (and its tile) reads, as props: equal props, nothing to redraw. */
class QuietRow extends Component {
  shouldComponentUpdate(next) {
    for (const key in next) if (next[key] !== this.props[key]) return true;
    return false;
  }
  render({ item, store, context, compact, kidsN, kidsOpen }) {
    const kids = kidsN ? { n: kidsN, open: kidsOpen, working: item.facts?.runningWorkers || 0, onToggle: () => store.toggleWorkers(item.id) } : null;
    return html`<${ThreadRowBody} item=${item} store=${store} context=${context} compact=${compact} kids=${kids} />`;
  }
}

function ThreadRowBody({ item, store, context = null, compact = false, kids = null }) {
  const r = rowOf(item, { projects: store.state.projects || [], context, now: store.state.now, lists: store.state.lists, filters: store.state.filters });
  const [more, setMore] = useState(false);
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const swipe = !!root?.classList.contains('can-swipe');
  const hoverIcons = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches && !root?.classList.contains('is-phone');
  const canAct = canActOnRow(item);
  const picking = store.state.nextSelect?.kind === 'thread';
  const picked = picking && store.state.nextSelect.ids.includes(item.id);
  const { wrap, tapped, underAct, handlers } = useRowSwipe({
    swipe: swipe && !picking,
    hoverIcons,
    canAct,
    right: (s, width) => {
      s.style.transform = `translateX(${width}px)`;
      // Done may only ask first (stop a running job?) and send nothing: then the row comes back.
      Promise.resolve(store.done(item.id))
        .then((res) => (res?.status !== 'sent' || res?.outcome?.cleared || doneLabel(item) === 'Clear') && (s.style.transform = ''))
        .catch(() => (s.style.transform = ''));
    },
    left: () => store.openSnooze(item.id),
  });
  const press = useLongPress(() => (picking ? store.nextSelectToggle(item.id) : store.nextSelectStart('thread', item.id)), { enabled: swipe });
  const open = (e) => tapped() && (picking ? store.nextSelectToggle(item.id, { range: !!e?.shiftKey }) : store.nextOpen(item.id));
  const asking = false;
  const phone = !!root?.classList.contains('is-phone');
  return html`<div class="lrow-wrap nx-rowwrap" ref=${wrap} data-id=${item.id} data-select-id=${picking ? item.id : null} ...${both(handlers, press)}>
    ${swipe
      ? html`<div class="lunder" aria-hidden="true">
          <div class="side">${canAct ? html`<button class="u-done" tabindex="-1" onClick=${underAct(() => store.done(item.id))}>${SWIPE_ICONS.done}${doneLabel(item)}</button>` : null}</div>
          <div class="side">
            <button class="u-more" tabindex="-1" onClick=${underAct(() => setMore(true))}>${SWIPE_ICONS.more}More</button>
            ${canAct ? html`<button class="u-snooze" tabindex="-1" onClick=${underAct(() => store.openSnooze(item.id))}>${SWIPE_ICONS.snooze}Snooze</button>` : null}
          </div>
        </div>`
      : null}
    <div class="lslide">
      <${RowCard} store=${store} compact=${compact} asking=${asking} cls=${store.state.focusId === item.id ? 'focused' : ''} label=${picking ? r.title : `Open ${r.title}`} onOpen=${open} onEnter=${false} check=${picking ? picked : null}
        onFocus=${() => store.set({ focusId: item.id })}
        ...${contextMenuProps(store, { kind: 'thread', id: item.id })}
        title=${html`${item.seen !== 'seen' ? html`<span class="nx-unread" aria-label="Unread">●</span>` : null}${r.pinned ? html`<span class="nx-pin" aria-label="Pinned">•</span>` : null}${asking ? r.next : r.title}`}
        time=${r.time} busy=${r.busy} tile=${r.tile} detail=${statusWords(item).ask} why=${statusWords(item).why} preview=${r.preview} pill=${r.status} kind=${r.kind} trail=${r.trail}
        where=${asking || (r.home && !r.trail?.length) ? [asking ? r.title : null, r.trail?.length ? null : r.home?.name].filter(Boolean).join(' · ') : null} facts=${r.facts} prItem=${item} kids=${picking ? null : kids} />
      ${swipe ? html`<button class="sr-only" aria-label=${`Actions for ${r.title}`} onClick=${(e) => (e.stopPropagation(), setMore(true))}>Actions</button>` : null}
    </div>
    ${more ? html`<${Menu} items=${threadMenu(item, store, { onReply: () => (store.nextOpen(item.id), store.openReply(item.id)) })} onClose=${() => setMore(false)} phone=${true} title=${r.title} />` : null}
  </div>`;
}

/**
 * What a row shows, without what it does: the big line, time and tile; the preview (clamped by Settings ›
 * Display › Preview lines); then the pill, where it lives and the quiet facts. The thread row draws it, and
 * so does a Screen window's feed (feed.js), so the two always look alike.
 *   pill: { cls, label } | null · where: string | null · facts: string[]
 *   onEnter: false when the page's list keys (keyboard.js) answer Enter instead.
 *   check: true or false while its list is a picker (a checkbox then, not a link); null otherwise.
 *   kids: { n, working, open, onToggle } when workers report to it: a chip beside the pill that folds them, tapped on its own.
 */
export function RowCard({ store, title, time, busy = null, tile, detail = null, why = null, preview = null, pill = null, dot = null, where = null, facts = [], kind = null, trail = null, asking = false, compact = false, cls = '', label, onOpen = null, onEnter = null, onFocus = null, onContextMenu = null, onMouseDown = null, check = null, kids = null, prItem = null }) {
  const link = !!onOpen;
  const picking = check !== null;
  return html`<div class=${`nx-row${compact ? ' compact' : ''}${asking ? ' asking' : ''}${cls ? ` ${cls}` : ''}${link ? '' : ' static'}${picking ? ' picking' : ''}${check ? ' picked' : ''}`} role=${picking ? 'checkbox' : link ? 'link' : null} aria-checked=${picking ? !!check : null} tabindex=${link ? 0 : null} aria-label=${link ? label : null}
    onClick=${onOpen} onFocus=${onFocus} onContextMenu=${onContextMenu} onMouseDown=${onMouseDown} onKeyDown=${link && onEnter !== false ? (e) => e.key === 'Enter' && e.target === e.currentTarget && (onEnter || onOpen)() : null}>
    ${picking ? html`<${SelectCheck} on=${check} />` : null}
    <span class="nx-r1">
      <${KindGlyph} kind=${kind} />
      <span class="nx-title">${title}</span>
      <span class="nx-time">${busy ? html`<span class=${`nx-busy ${busy}`} role="img" aria-label=${busy === 'working' ? 'Working' : 'Working in background'} title=${busy === 'working' ? 'Working' : 'Working in background'}></span>` : null}${time}</span>
      <${Tile} tile=${tile} store=${store} />
    </span>
    ${detail ? html`<span class="nx-detail">${linked(detail)}</span>` : null}
    ${preview ? html`<span class="nx-prev">${linked(preview)}</span>` : null}
    <span class="nx-meta">
      ${dot ? html`<span class=${`nx-gdot nx-live ${dot.cls}`} role="img" aria-label=${dot.label} title=${dot.label}></span>` : null}
      ${pill ? html`<span class=${`nx-pill ${pill.cls}`}>${pill.label}</span>` : null}
      ${kids ? html`<button class="nx-kids" aria-expanded=${kids.open} aria-label=${`${kids.open ? 'Hide' : 'Show'} ${kids.n} reporting here${kids.working ? `, ${kids.working} working` : ''}`}
        onClick=${(e) => (e.stopPropagation(), kids.onToggle())} onKeyDown=${(e) => e.stopPropagation()}>
        <svg class="nx-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>${kids.n} reporting${kids.working ? html`<span class="w"> · ${kids.working} working</span>` : null}
      </button>` : null}
      ${prItem ? html`<${PrChip} item=${prItem} store=${store} />` : null}
      ${why ? html`<span class="nx-why">${linked(why)}</span>` : null}
      ${kind && kind !== 'thread' ? html`<span class="nx-kind">${KINDS[kind]}</span>` : null}
      ${where ? html`<span class="nx-where">${where}</span>` : null}
      ${trail?.length ? html`<span class="nx-trail" title=${`Reports to ${trail[trail.length - 1]}`}><i aria-hidden="true">↳</i>${trail.map((t, i) => html`${i ? html`<i aria-hidden="true">›</i>` : null}<span>${t}</span>`)}</span>` : null}
      ${inFlightOf(prItem).filter(e => e.url).map(e => html`<a class="nx-fact" href=${e.url} target="_blank" rel="noopener" onClick=${event => event.stopPropagation()} onKeyDown=${event => event.stopPropagation()}>${e.text}</a>`)}
      ${facts.map((f) => html`<span class=${f.startsWith('overdue ') ? 'nx-fact nx-overdue' : 'nx-fact'}>${f}</span>`)}
    </span>
  </div>`;
}

/** A group heading's dot: a status's color, or a project's. */
function dotOf(key, store) {
  const [kind, id] = String(key).split(':');
  // Sent is in with Working (model.js isSent): the same color.
  if (kind === 'sent') return { cls: 'working' };
  if (kind === 'live' || ['needs', 'failed', 'stuck', 'finished', 'working', 'waiting', 'idle', 'unknown', 'away', 'done'].includes(kind)) return { cls: id || kind };
  if (kind === 'project') {
    const p = (store.state.projects || []).find((x) => x.id === id);
    return p ? { color: ICON_COLORS[p.color] || ICON_COLORS.slate } : null;
  }
  return null;
}

/** A group's quiet heading: a chevron that collapses it, its dot (if any), its label and count; `extra` at the right (Select N). */
export function GroupHead({ label, n, shut, dot = null, onToggle, extra = null }) {
  return html`<h2 class="nx-gh"><button aria-expanded=${!shut} onClick=${onToggle}>
    <svg class="nx-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>${dot ? html`<span class=${`nx-gdot ${dot.cls || ''}`} style=${dot.color ? `background:${dot.color}` : ''}></span>` : null}${label}${label === 'Needs you' ? html`<span class="n">${n}</span>` : null}
  </button>${extra}</h2>`;
}

/**
 * Groups of rows under quiet headings that collapse (kept per device with the classic List's, under `scope`).
 * Rows away (snoozed, parked) or done are compact.
 */
export function Groups({ groups, store, context = null, scope = 'list' }) {
  return shownRows(groups, store.state).map((g) => {
    if (!g.trees.length) return null;
    const key = `${scope}|${g.key}`;
    const shut = (store.state.listCollapsed || []).includes(key);
    const dot = dotOf(g.key, store);
    return html`<section class=${`nx-group${shut ? ' shut' : ''}`} key=${g.key}>
      ${g.label ? html`<${GroupHead} label=${g.label} n=${g.items.length} shut=${shut} dot=${dot} onToggle=${() => store.toggleListSection(key)} extra=${store.state.nextSelect?.kind === 'thread' && !shut ? html`<${GroupPick} store=${store} ids=${g.rows.map((i) => i.id)} />` : null} />` : null}
      ${shut ? null : g.trees.map(tree => html`<${ThreadTree} key=${tree.item.id} tree=${tree} store=${store} context=${context} />`)}
    </section>`;
  });
}

/** A row and the workers and jobs that report to it, folded behind the row's "N reporting" chip until the owner opens it. */
function ThreadTree({ tree, store, context }) {
  const n = tree.children.length;
  const open = n > 0 && (store.state.workersOpen || []).includes(tree.item.id);
  return html`<div><${ThreadRow} item=${tree.item} store=${store} context=${context} compact=${tree.item.disposition !== 'active'} kids=${n ? { n, open } : null} />
    ${open ? html`<div class="nx-children">${tree.children.map(child => html`<${ThreadTree} key=${child.item.id} tree=${child} store=${store} context=${context} />`)}</div>` : null}</div>`;
}
