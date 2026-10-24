import { threadPrs } from './next/pr-model.js';
// List pieces the next layout's pages use: a row's swipe (useRowSwipe), its PRs and tile, the weekly
// sweep card and the done-today shelf.

import { html, useRef, useState } from '../vendor/preact-htm.js';
import { CHEV } from './dock.js';
import { agentColor, agentName, clockTime, dayLabel, placeName } from './util.js';
import { ROW_SWIPE, releaseRow, rowTitle, tileFor } from './list-model.js';

/** The conversation's PRs (its own and any it linked), each with whether the desk watches its review. */
export function prsOf(item) {
  return threadPrs(item).map(p => ({ ...p, label: p.title || `#${p.number}` }));
}

/** The project's Loom icon (or the agent's), tinted through a mask so any Lucide icon takes the color. */
export function Tile({ item, store }) {
  const t = tileFor(item, store.state.agentIcons, store.state.repoIcons);
  const color = t.color || agentColor(item);
  return html`<span class="lt" style=${`--c:${color}`} title=${t.title} aria-hidden="true">
    ${t.icon ? html`<i style=${`-webkit-mask-image:url(api/desk/icon/${t.icon}.svg);mask-image:url(api/desk/icon/${t.icon}.svg)`}></i>` : html`<b>${t.letter}</b>`}
  </span>`;
}

// One row open at a time on a phone; a new swipe or a tap elsewhere closes it.
let openRow = null;
function closeOpenRow() {
  // A row that left the page (a tab change, a refresh) is no longer open: it must not eat the next tap.
  if (openRow && !openRow.isConnected) openRow = null;
  if (!openRow) return;
  const slide = openRow.querySelector('.lslide');
  if (slide) {
    slide.classList.add('anim');
    slide.style.transform = '';
  }
  openRow = null;
}

/**
 * A row's phone swipes, shared by conversation rows and project folders: right past half commits the
 * right-hand action, left past 60% the left-hand one; a shorter swipe holds its side's buttons open.
 * `right(slide, width)` and `left()` run the actions; with `canAct` false only More shows, on the left.
 */
export function useRowSwipe({ swipe, hoverIcons, canAct, right, left }) {
  const wrap = useRef(null);
  const drag = useRef(null);
  const swallow = useRef(false);
  const slide = () => wrap.current?.querySelector('.lslide');
  const down = (e) => {
    // A mouse drags rows only where nothing can hover (a touchscreen laptop's mouse selects text as usual).
    if (!swipe || (e.pointerType === 'mouse' && (e.button !== 0 || hoverIcons))) return;
    // A control inside the row (its ⋯, the swipe buttons) is a press on that control, never the start of a swipe:
    // it mustn't arm the tap suppression either, or the row's next real tap is eaten (Codex review on #539).
    if (e.target.closest('.lunder, button, a')) return;
    // A tap on another row while one is open only closes it (as in Mail), it doesn't open a conversation.
    if (openRow && !openRow.isConnected) openRow = null;
    if (openRow && openRow !== wrap.current) {
      closeOpenRow();
      swallow.current = true;
    }
    const base = openRow === wrap.current ? parseFloat(slide()?.style.transform.replace(/[^-\d.]/g, '')) || 0 : 0;
    drag.current = { x: e.clientX, y: e.clientY, base, dx: base, on: false, off: false };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || d.off) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.on) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) return (d.off = true); // a scroll
      d.on = true;
    }
    d.dx = d.base + dx;
    const s = slide();
    if (s) {
      s.classList.remove('anim');
      s.style.transform = `translateX(${d.dx}px)`;
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    swallow.current = true;
    setTimeout(() => (swallow.current = false), 0);
    const s = slide();
    const width = wrap.current?.offsetWidth || 360;
    const result = releaseRow(d.dx, width);
    if (!s) return;
    s.classList.add('anim');
    if (result.action === 'done' && canAct) {
      openRow = null;
      right(s, width);
      return;
    }
    if (result.action === 'snooze' && canAct) {
      s.style.transform = '';
      openRow = null;
      left();
      return;
    }
    // Nothing to reveal on the right of a row that can't be done (working, snoozed, history): snap back.
    // Only More on the left of such a row: reveal just that one button.
    const open = !canAct ? (result.open > 0 ? 0 : result.open < 0 ? -ROW_SWIPE.oneButton : 0) : result.open;
    s.style.transform = open ? `translateX(${open}px)` : '';
    openRow = open ? wrap.current : null;
  };
  /** A tap that ends a swipe (or closes another open row) isn't a tap on the row. */
  const tapped = () => {
    if (swallow.current) {
      swallow.current = false;
      return false;
    }
    if (openRow && !openRow.isConnected) openRow = null;
    if (openRow) {
      closeOpenRow();
      return false;
    }
    return true;
  };
  const underAct = (fn) => (e) => {
    e.stopPropagation();
    closeOpenRow();
    fn();
  };
  return { wrap, tapped, underAct, handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: () => (drag.current = null) } };
}

/** The weekly sweep: what sat parked or untouched for a week, to pick up (back to Active) or finish (Done). Collapsed until tapped. */
export function SweepCard({ sweep, store }) {
  const [open, setOpen] = useState(false);
  // Picked up or done: gone from the sweep, and from its count, at the tap until the sweep is read again (optimistic).
  const items = (sweep?.items || []).filter((item) => store.state.swept[item.id] === undefined);
  if (!items.length) return null;
  return html`<section class="sweep" aria-label="Weekly sweep">
    <button class="sweep-h" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <b>Weekly sweep</b><span class="note">${items.length} to pick up or finish</span>${CHEV}
    </button>
    ${open
      ? items.map((item) => {
          const c = store.lastCommand(item.id, ['sweep']);
          return html`<div class="sz" key=${item.id}>
            <button class="t linkish" onClick=${() => store.openItem(item.id)}>${placeName(item) || item.summary?.title}<small>${agentName(item)} · ${item.disposition === 'parked' ? 'parked' : 'untouched'} since ${dayLabel(item.attentionUpdatedAt || item.updatedAt || item.lastActivityAt).toLowerCase()}</small></button>
            ${c?.status === 'failed' ? html`<span class="warn">Failed</span>` : null}
            <button class="btn sm" onClick=${() => store.sweep(item.id, 'keep')}>Pick up</button>
            <button class="btn sm ghost" onClick=${() => store.sweep(item.id, 'drop')}>Done</button>
          </div>`;
        })
      : null}
  </section>`;
}

/** An empty view of what needs the owner: today's finished work instead of a blank (see trophyShelf). */
export function TrophyShelf({ shelf, store, historyTab, hidden, onHistory = null }) {
  const filtersNote = hidden ? html`<p class="note">${hidden} hidden by your filters · <button class="linkish" onClick=${() => store.clearFilters()}><u>clear filters</u></button></p>` : null;
  if (!shelf.count) return html`<div class="ltrophy"><p class="ltrophy-h">All clear</p><p class="note">Nothing needs you. Finished work lands here as a tally for the day.</p></div>`;
  return html`<div class="ltrophy">
    <p class="ltrophy-n">${shelf.count}</p>
    <p class="ltrophy-h">done today</p>
    <ul class="ltrophy-list" aria-label="Finished today">
      ${shelf.items.map(
        (item) => html`<li key=${item.id}><button onClick=${() => store.openItem(item.id)}><span class="dot" style=${`--c:${agentColor(item)}`}></span><span class="t">${rowTitle(item)}</span><span class="at">${clockTime(shelf.doneAt(item))}</span></button></li>`,
      )}
    </ul>
    ${shelf.count > shelf.items.length
      ? historyTab
        ? html`<button class="linkish note" onClick=${() => (onHistory ? onHistory(historyTab) : store.setListTab(historyTab))}>and ${shelf.count - shelf.items.length} more in <u>History</u></button>`
        : html`<p class="note">and ${shelf.count - shelf.items.length} more</p>`
      : null}
    ${filtersNote}
  </div>`;
}

