// The next layout's menus: a dropdown whose items can open a flyout (Move to project ›, Type ›) on a desk,
// and a bottom sheet that drills in with a back row on a phone. Items:
//   { label, key?, icon?, onSelect, on? (a check: in the icon's place, or at the end beside an icon), hint?, keep? (stays open), indent? (a tree's depth) }  { label, sub: [items] }  'sep'
// A right-click (contextMenuProps) opens the same menu at the pointer: context.js draws it.

import { html, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';

const CHEV = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>`;
const BACK = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>`;
const CHECK = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`;

function Item({ it, onPick, onSub, active }) {
  if (it === 'sep') return html`<div class="nx-msep" role="separator"></div>`;
  if (it.heading) return html`<div class="nx-mhead">${it.heading}</div>`;
  const sub = !!it.sub;
  return html`<button role="menuitem" disabled=${!!it.disabled} title=${it.disabled ? it.hint : null} class=${`nx-mi${active ? ' open' : ''}${it.indent ? ` in${Math.min(it.indent, 2)}` : ''}`} aria-haspopup=${sub ? 'menu' : null} aria-expanded=${sub ? !!active : null}
    onMouseEnter=${sub ? () => onSub(it) : () => onSub(null)} onClick=${(e) => (e.stopPropagation(), sub ? onSub(it, true) : onPick(it))}>
    <span class="nx-mic">${it.on && !it.icon ? CHECK : it.icon || null}</span><span class="nx-mil">${it.label}</span>${it.hint ? html`<span class="nx-mih">${it.hint}</span>` : null}${it.on && it.icon ? html`<span class="nx-mick">${CHECK}</span>` : null}${sub ? html`<span class="nx-mich">${CHEV}</span>` : null}
  </button>`;
}

let serial = 0;
// What was selected in the subject when the press that opens its menu came down (see pressed below).
let pressedOn = null;

const selectedIn = (el) => {
  const sel = window.getSelection?.();
  return !!sel && !sel.isCollapsed && sel.containsNode(el, true);
};

/**
 * A right-click on a row or a place opens its menu at the pointer (`target`: { kind, id }; context.js has the
 * items). A mouse or trackpad only: a touchscreen's long press stays the browser's, and so does Shift+right-click
 * or a right-click on text you selected first, to copy it. The menu key (or Shift+F10) opens it under the focused row.
 */
export function openContextMenu(e, store, target) {
  const root = document.documentElement;
  // The menu key sends no position; Shift+F10 also carries Shift, which isn't Shift+right-click.
  const key = !e.clientX && !e.clientY;
  if ((e.shiftKey && !key) || e.pointerType === 'touch' || root.classList.contains('is-phone') || !window.matchMedia('(any-hover: hover)').matches) return;
  // A Mac selects the word under a right-click. Only a selection that was there before the press keeps the browser's menu;
  // one the press made is cleared.
  const before = !key && pressedOn?.el === e.currentTarget ? pressedOn.selected : selectedIn(e.currentTarget);
  pressedOn = null;
  if (before && selectedIn(e.currentTarget)) return;
  if (selectedIn(e.currentTarget)) window.getSelection().removeAllRanges();
  e.preventDefault();
  let { clientX: x, clientY: y } = e;
  if (key) {
    const box = e.currentTarget.getBoundingClientRect();
    x = box.left + 16;
    y = box.bottom;
  }
  store.set({ nextContext: { ...target, x, y, key, n: ++serial } });
}

/**
 * The press that will open the menu (a right button, or Control-click on a Mac): note what was selected, and keep it
 * from selecting the word under it (it still focuses the subject). Shift+right-click is the browser's and selects as usual.
 */
function pressed(e) {
  if (!(e.button === 2 || (e.button === 0 && e.ctrlKey)) || e.shiftKey) return;
  const selected = selectedIn(e.currentTarget);
  pressedOn = { el: e.currentTarget, selected };
  if (selected) return;
  e.preventDefault();
  // Keeping the press from selecting also keeps it from focusing: focus the subject as the press would have, so the
  // list's keys (e, s, r) act on the row whose menu this is.
  e.currentTarget.focus?.({ preventScroll: true });
}

/** Props for a subject with a right-click menu: spread them on its element. */
export function contextMenuProps(store, target) {
  return { onMouseDown: pressed, onContextMenu: (e) => openContextMenu(e, store, target) };
}

/** A menu at the pointer sits at it, flipped left or up where it would run off the window. */
function placeAt(el, at) {
  if (!el) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const x = at.x + w > window.innerWidth - 8 ? Math.max(8, at.x - w) : at.x;
  const y = at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y;
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 8 - w))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 8 - h))}px`;
}

/**
 * A flyout that would run off the bottom of the window moves up until it fits. In a menu at the pointer it's fixed
 * beside its item, on the side with room, so the menu can scroll (a short window) without clipping it.
 */
function fitFlyout(el) {
  if (!el) return;
  const parent = el.parentElement.closest('.nx-fly');
  const root = el.closest('.nx-menu.at') || parent;
  if (root) {
    const r = el.parentElement.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Nested flyouts continue in their parent's direction while there is room.
    const leftward = parent && parent.getBoundingClientRect().left < parent.parentElement.getBoundingClientRect().left;
    const left = r.left - 4 - w;
    const right = r.right + 4;
    const fallback = Math.max(8, window.innerWidth - 8 - w);
    const x = leftward
      ? left >= 8 ? left : right + w <= window.innerWidth - 8 ? right : fallback
      : right + w <= window.innerWidth - 8 ? right : left >= 8 ? left : fallback;
    el.style.left = `${x}px`;
    el.style.top = `${Math.max(8, Math.min(r.top - 5, window.innerHeight - 8 - h))}px`;
    return;
  }
  const over = el.getBoundingClientRect().bottom - (window.innerHeight - 8);
  if (over > 0) el.style.top = `${-5 - over}px`;
}

/**
 * A dropdown under its button (desk) or a sheet from the bottom (phone); with `at` ({ x, y, key? }), a dropdown at
 * that point (a right-click; `key` when the menu key opened it). `onClose` when it's done.
 */
export function Menu({ items, onClose, phone = false, title = '', at = null }) {
  const [sub, setSub] = useState(null);
  const [nested, setNested] = useState(null);
  const [stack, setStack] = useState([]);
  const ref = useRef(null);
  // Opened from the keyboard (the menu key), it takes focus (arrows move, Enter picks) and gives it back to the row after.
  useLayoutEffect(() => {
    if (!at?.key) return undefined;
    const from = document.activeElement;
    ref.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement);
      if (lost && from?.isConnected) from.focus({ preventScroll: true });
    };
  }, []);
  // Up and Down move within the focused item's level (the menu, or its open flyout); Right opens a flyout, Left closes it.
  const arrows = (e) => {
    const here = document.activeElement;
    const level = here?.closest('[role="menu"]');
    if (!level || !ref.current?.contains(level)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...level.querySelectorAll('[role="menuitem"]:not(:disabled)')].filter((el) => el.closest('[role="menu"]') === level);
      const i = items.indexOf(here);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'ArrowRight' && here.getAttribute('aria-haspopup')) {
      e.preventDefault();
      const row = here.closest('.nx-mrow');
      here.click();
      setTimeout(() => row?.querySelector(':scope > .nx-fly [role="menuitem"]')?.focus());
    } else if (e.key === 'ArrowLeft' && level.classList.contains('nx-fly')) {
      e.preventDefault();
      level.closest('.nx-mrow')?.querySelector(':scope > [role="menuitem"]')?.focus();
      if (level.parentElement.closest('.nx-fly')) setNested(null);
      else setSub(null);
    }
  };
  // Listening from the moment it's drawn (a click right after a right-click still closes it); the event that opened it
  // came before, and is let through.
  useLayoutEffect(() => {
    const since = performance.now();
    const outside = (e) => e.timeStamp >= since && !ref.current?.contains(e.target);
    const away = (e) => outside(e) && !e.target.closest?.('[data-menu-button]') && onClose();
    const key = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    // A right-click elsewhere closes it too (one that opens another menu replaces it); so does the page moving under one at the pointer.
    const right = (e) => outside(e) && onClose();
    // A scroll still settling when it opened (a trackpad's momentum, a smooth scroll) doesn't count.
    const moved = (e) => performance.now() - since > 300 && !ref.current?.contains(e.target) && onClose();
    // One at the pointer closes on any press outside it, caught before a ⋯ button's own handler can stop it.
    const pressed = (e) => outside(e) && onClose();
    const listen = () => {
      document.addEventListener('click', away);
      document.addEventListener('contextmenu', right);
    };
    if (at) listen();
    else setTimeout(listen);
    document.addEventListener('keydown', key, true);
    if (at) {
      document.addEventListener('pointerdown', pressed, true);
      document.addEventListener('scroll', moved, true);
      window.addEventListener('resize', onClose);
      window.addEventListener('blur', onClose);
    }
    return () => {
      document.removeEventListener('click', away);
      document.removeEventListener('contextmenu', right);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', pressed, true);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, []);
  // An item with `keep` (a filter's checkbox) leaves the menu open for the next pick.
  const pick = (it) => {
    if (!it.keep) onClose();
    it.onSelect?.();
  };
  if (phone) {
    // The open level by stable key (falling back to label): the items are rebuilt on each pick (a filter's checks).
    let list = items;
    let level = null;
    for (const name of stack) {
      level = list.find((it) => it !== 'sep' && (it.key ?? it.label) === name);
      list = level?.sub || items;
    }

    return html`<div class="nx-sheet-scrim" onClick=${onClose}>
      <div class="nx-sheet" ref=${ref} role="menu" aria-label=${title || 'Actions'} onClick=${(e) => e.stopPropagation()}>
        <div class="nx-grab"></div>
        ${level
          ? html`<button class="nx-mi nx-mback" onClick=${() => setStack(stack.slice(0, -1))}><span class="nx-mic">${BACK}</span><span class="nx-mil">${level.label}</span></button><div class="nx-msep"></div>`
          : title ? html`<div class="nx-mtitle">${title}</div>` : null}
        ${list.map((it) => html`<${Item} it=${it} onPick=${pick} onSub=${(s, click) => click && s && setStack([...stack, s.key ?? s.label])} />`)}
      </div>
    </div>`;
  }
  const setRef = (el) => {
    ref.current = el;
    if (at) placeAt(el, at);
  };
  return html`<div class=${`nx-menu${at ? ' at' : ''}`} ref=${setRef} role="menu" aria-label=${at ? title || 'Actions' : null} onClick=${(e) => e.stopPropagation()} onContextMenu=${(e) => e.preventDefault()} onKeyDown=${arrows} onScroll=${at ? () => setSub(null) : null}>
    ${items.map((it) => html`<div class="nx-mrow">
      <${Item} it=${it} onPick=${pick} onSub=${(s) => { if (sub !== (s?.key ?? s?.label ?? null)) setNested(null); setSub(s?.key ?? s?.label ?? null); }} active=${!!it.sub && sub === (it.key ?? it.label)} />
      ${it.sub && sub === (it.key ?? it.label) ? html`<div class="nx-menu nx-fly" role="menu" ref=${fitFlyout}>${it.sub.map((s) => html`<div class="nx-mrow">
        <${Item} it=${s} onPick=${pick} active=${!!s.sub && nested === (s.key ?? s.label)} onSub=${(next) => setNested(next?.key ?? next?.label ?? null)} />
        ${s.sub && nested === (s.key ?? s.label) ? html`<div class="nx-menu nx-fly" role="menu" ref=${fitFlyout}>${s.sub.map((row) => html`<${Item} it=${row} onPick=${pick} onSub=${() => {}} />`)}</div>` : null}
      </div>`)}</div>` : null}
    </div>`)}
  </div>`;
}
