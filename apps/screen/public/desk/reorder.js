// A list the owner puts in order (Settings → Tabs): drag a row by its handle (mouse or
// touch) or use its arrows. Every reorderable list in the desk uses this one, so they all move alike:
//   pick up  the row lifts (raised, a shadow, a little larger) under the pointer;
//   move     it follows the pointer, and the rows it passes slide aside to open its new slot;
//   drop     it settles into that slot, and only then is the new order saved (`onMove`, once).
// The DOM keeps its order while dragging; rows move by `translate` alone, so nothing re-renders
// under the pointer. Near the top or bottom of a scrolling panel, the panel scrolls along.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { moveSection } from './list-model.js';

const SETTLE_MS = 180;
const EDGE = 48; // px from a scrolling panel's edge where it starts to scroll
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where the dragged row lands: how many of the other rows' middles are above its middle. */
export function dropIndex(tops, heights, from, dy) {
  const middle = tops[from] + heights[from] / 2 + dy;
  let to = 0;
  for (let i = 0; i < tops.length; i += 1) if (i !== from && tops[i] + heights[i] / 2 < middle) to += 1;
  return to;
}

/** How far each row is shifted while row `from` hovers over slot `to`: the passed rows make room. */
export function shiftFor(i, from, to, height) {
  if (from < to && i > from && i <= to) return -height;
  if (from > to && i >= to && i < from) return height;
  return 0;
}

/** The dragged row's offset once it sits in slot `to` (its new top, less its old one). */
export function settleOffset(tops, heights, from, to) {
  if (to > from) return tops[to] + heights[to] - (tops[from] + heights[from]);
  if (to < from) return tops[to] - tops[from];
  return 0;
}

function scrollParent(node) {
  for (let n = node?.parentElement; n; n = n.parentElement) {
    const { overflowY } = getComputedStyle(n);
    if ((overflowY === 'auto' || overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** `keys` in their current order; `row(key)` renders a row's body; `name(key)` labels its controls. */
export function ReorderList({ keys: given, row, name, onMove, label }) {
  // { key, from, to, dy, settling } while a row is held; null otherwise.
  const [drag, setDrag] = useState(null);
  // The order just dropped, shown until the save settles (the page's own keys may lag a render).
  const [order, setOrder] = useState(null);
  // One frame without transitions while the rows take their new places, so nothing slides back.
  const [still, setStill] = useState(false);
  const keys = order || given;
  const [landed, setLanded] = useState(null); // the key just dropped, for a brief "set down" pulse
  const listRef = useRef(null);
  const g = useRef(null); // the gesture: where it started, the rows' layout then, the scroller
  const timers = useRef([]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      cancelAnimationFrame(g.current?.raf);
      document.documentElement.classList.remove('is-reordering');
    },
    [],
  );
  const later = (fn, ms) => timers.current.push(setTimeout(fn, ms));

  const measure = () => {
    const rows = [...listRef.current.querySelectorAll(':scope > .ro-row')];
    const rects = rows.map((r) => r.getBoundingClientRect());
    return { tops: rects.map((r) => r.top), heights: rects.map((r) => r.height) };
  };
  const update = () => {
    const s = g.current;
    if (!s) return;
    const dy = s.y - s.startY + ((s.scroller?.scrollTop ?? 0) - s.startScroll);
    // Not past the list's ends: the row stays over the list.
    const min = s.tops[0] - s.tops[s.from];
    const max = s.tops[s.tops.length - 1] + s.heights[s.heights.length - 1] - (s.tops[s.from] + s.heights[s.from]);
    const clamped = Math.max(min, Math.min(max, dy));
    setDrag({ key: s.key, from: s.from, to: dropIndex(s.tops, s.heights, s.from, clamped), dy: clamped, settling: false });
  };
  // While the pointer rests near a scrolling panel's edge, keep scrolling it.
  const edgeScroll = () => {
    const s = g.current;
    if (!s?.scroller) return;
    const box = s.scroller.getBoundingClientRect();
    const speed = s.y < box.top + EDGE ? -Math.ceil((box.top + EDGE - s.y) / 4) : s.y > box.bottom - EDGE ? Math.ceil((s.y - (box.bottom - EDGE)) / 4) : 0;
    if (speed) {
      s.scroller.scrollTop += speed;
      update();
    }
    s.raf = requestAnimationFrame(edgeScroll);
  };

  const grab = (key) => (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try {
      listRef.current?.setPointerCapture(e.pointerId);
    } catch {}
    const scroller = scrollParent(listRef.current);
    const from = keys.indexOf(key);
    g.current = { key, from, startY: e.clientY, y: e.clientY, startScroll: scroller?.scrollTop ?? 0, scroller, listTop: listRef.current.getBoundingClientRect().top, ...measure() };
    document.documentElement.classList.add('is-reordering');
    navigator.vibrate?.(8);
    setLanded(null);
    setDrag({ key, from, to: from, dy: 0, settling: false });
    g.current.raf = requestAnimationFrame(edgeScroll);
  };
  const move = (e) => {
    if (!g.current || drag?.settling) return;
    g.current.y = e.clientY;
    update();
  };
  const drop = () => {
    const s = g.current;
    if (!s || !drag || drag.settling) return;
    cancelAnimationFrame(s.raf);
    document.documentElement.classList.remove('is-reordering');
    const { from, to } = drag;
    const next = moveSection(keys, from, to);
    const changed = from !== to;
    // Settle into the slot, then hand over the new order: the rows are already where it puts them.
    setDrag({ ...drag, dy: settleOffset(s.tops, s.heights, from, to), settling: true });
    later(
      () => {
        g.current = null;
        setDrag(null);
        if (changed) commit(next, s.key);
      },
      reduceMotion() ? 0 : SETTLE_MS,
    );
  };
  const commit = (next, key) => {
    setStill(true);
    setOrder(next);
    setLanded(key);
    Promise.resolve(onMove(next)).finally(() => setOrder(null));
    requestAnimationFrame(() => requestAnimationFrame(() => setStill(false)));
    later(() => setLanded(null), 600);
  };
  const step = (i, j) => commit(moveSection(keys, i, j), keys[i]);

  return html`<ol class=${`ro-list${drag ? ' dragging' : ''}${still ? ' still' : ''}`} aria-label=${label} ref=${listRef} onPointerMove=${move} onPointerUp=${drop} onPointerCancel=${drop}>
    ${keys.map((key, i) => {
      const held = drag?.key === key;
      const offset = !drag ? 0 : held ? drag.dy : shiftFor(i, drag.from, drag.to, g.current?.heights[drag.from] ?? 0);
      const cls = `ro-row${held ? (drag.settling ? ' settling' : ' lifted') : ''}${landed === key && !drag ? ' landed' : ''}`;
      return html`<li key=${key} class=${cls} style=${offset ? `translate: 0 ${offset}px` : ''}>
        <span class="ro-grip" role="button" tabindex="-1" aria-label=${`Drag ${name(key)}`} title="Drag to reorder" onPointerDown=${grab(key)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
        </span>
        ${row(key)}
        <span class="ro-arrows">
          <button class="lo-arrow" aria-label=${`Move ${name(key)} up`} disabled=${i === 0 || !!drag} onClick=${() => step(i, i - 1)}>↑</button>
          <button class="lo-arrow" aria-label=${`Move ${name(key)} down`} disabled=${i === keys.length - 1 || !!drag} onClick=${() => step(i, i + 1)}>↓</button>
        </span>
      </li>`;
    })}
    ${drag && !drag.settling && g.current
      ? html`<li class="ro-slot" aria-hidden="true" style=${`top: ${g.current.tops[drag.from] - g.current.listTop + settleOffset(g.current.tops, g.current.heights, drag.from, drag.to)}px; height: ${g.current.heights[drag.from]}px`}></li>`
      : null}
  </ol>`;
}
