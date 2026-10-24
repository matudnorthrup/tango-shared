// Keyboard triage follows the rendered list: filters, temporary sections and phone tabs included.

import { visibleRowOrder, stepRowFocus } from './model.js';
import { canActOnRow } from '../list-model.js';
import { viewFor } from '../role.js';
import { optionsOf } from '../util.js';
import { selectionActions } from './select.js';

/**
 * A menu or dialog on screen. The switcher stays mounted while shut (aria-hidden), and the composer's Send
 * menu sits in a closed <details> (laid out, but not shown: checkVisibility knows), so neither counts then.
 * The keys sheet's own scrim counts too, but ? and Esc are handled before this is asked.
 */
function overlayOpen() {
  // A scrim means something lies over the page: the sidebar or drawer over a narrow window (Codex review on #634).
  if (document.querySelector?.('.nx-scrim')) return true;
  return [...document.querySelectorAll('[role="menu"], [role="dialog"]')].some((el) => !el.closest('[aria-hidden="true"]') && (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0));
}

/**
 * What `?` lists: the keys of the page you're on. Typing in a box takes every key until Esc leaves it.
 * d is Done; e (Gmail's archive, the classic desk's key) still works, unlisted.
 */
export const KEY_HELP = {
  list: [['j  k', 'Next and previous row'], ['Enter', 'Open the row'], ['r', 'Reply'], ['d', 'Done / Clear'], ['s', 'Snooze…'], ['S', 'Snooze until they post'], ['1 2 3', 'Answer the ask'], ['x', 'Select rows'], ['f', 'Filter'], ['n', 'New thread']],
  select: [['j  k', 'Next and previous row'], ['x  Enter', 'Pick the row'], ['u  U', 'Mark the picked rows read, unread'], ['d', 'Done / Clear, for the picked rows'], ['s', 'Snooze…, for the picked rows'], ['⌘A', 'Pick all'], ['Esc', 'Stop selecting']],
  thread: [['r', 'Reply'], ['d', 'Done / Clear'], ['s', 'Snooze…'], ['S', 'Snooze until they post'], ['1 2 3', 'Answer the ask'], ['Esc', 'Leave the reply box, then back']],
  any: [['⌘[  ⌘]', 'Back and forward (even while typing)'], ['⌘K  /', 'Search or jump to'], ['?  ⌘/', 'These keys (⌘/ even while typing)']],
};

/** The help rows for where you are: a thread, a list (f only where the Inbox has its Filter), selecting, or none. */
export function keyHelp(state, { thread = false, stage = false } = {}) {
  if (stage) return null;
  if (thread) return { title: 'On a thread', rows: KEY_HELP.thread };
  const page = state.nextRoute?.page;
  if (!['inbox', 'project', 'agent'].includes(page)) return null;
  if (state.nextSelect?.kind === 'thread') return { title: 'Selecting', rows: KEY_HELP.select };
  return { title: 'On a list', rows: page === 'inbox' ? KEY_HELP.list : KEY_HELP.list.filter(([k]) => k !== 'f') };
}

/** Keys that mean the owner is driving by keyboard: only then do focused rows show their ring. */
const DRIVING = new Set(['Tab', 'j', 'k', 'ArrowUp', 'ArrowDown']);

/**
 * A thread just opened in this window: should its reply box take the cursor? Yes with a mouse or trackpad, so
 * dictation lands (Wispr pastes only when macOS says a text box has focus; a thread used to open with focus on the
 * page). Not while driving by keyboard (the thread's letter keys stay live), not on a touch screen (no keyboard
 * popping up), and never when a text box already has it.
 */
export function replyTakesFocus({ finePointer, keyboardMode, active, lastPointer = '' }) {
  // A touch laptop's primary pointer is fine; the press that opened the thread says whether it was a tap (Codex review on #780).
  if (!finePointer || keyboardMode || lastPointer === 'touch' || lastPointer === 'pen') return false;
  return !(active && (/^(input|textarea|select)$/i.test(active.tagName || '') || active.isContentEditable));
}

/** Keyboard mode on `<html>` (the focus ring's switch): on with a driving key, off with any pointer. */
export function watchKeyboardMode(root = document.documentElement) {
  const on = (e) => DRIVING.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && root.classList.add('nx-kbd');
  const off = (e) => {
    root.classList.remove('nx-kbd');
    // The last press's kind (mouse, touch, pen), for replyTakesFocus.
    if (e?.pointerType) root.dataset.lastPointer = e.pointerType;
  };
  document.addEventListener('keydown', on, true);
  document.addEventListener('pointerdown', off, true);
  return () => {
    document.removeEventListener('keydown', on, true);
    document.removeEventListener('pointerdown', off, true);
    off();
    delete root.dataset.lastPointer;
  };
}

const snoozeKey = (event, store, item) => {
  // S snoozes until they post; an away row is retimed to that, not refused as already out.
  if (event.key === 's') store.openSnooze(item.id);
  else store.quickSnooze(item.id, item.disposition === 'snoozed' || item.disposition === 'parked' ? { retime: true } : {});
};

/** An open thread's keys: the same letters as its row, acting on the thread itself. */
function onThreadKey(event, store, item) {
  const { state } = store;
  const actable = canActOnRow(item);
  switch (event.key) {
    case 'r':
      if (item.replyable === false) return;
      // Already open (replyOpen unchanged), the box takes no new focus by itself: put the cursor there.
      store.openReply(item.id);
      globalThis.requestAnimationFrame?.(() => document.querySelector('.rd-composer textarea')?.focus());
      break;
    case 'd':
    case 'e':
      if (!actable) return;
      store.done(item.id);
      break;
    case 's':
    case 'S':
      if (!actable || event.repeat) return;
      snoozeKey(event, store, item);
      break;
    case '1':
    case '2':
    case '3': {
      const option = actable && item.nextStep === 'your_move' ? optionsOf(item)[Number(event.key) - 1] : null;
      if (!option || state.holds[item.id]) return;
      store.answer(item.id, option);
      break;
    }
    default: return;
  }
  event.preventDefault();
}

/** Another menu or dialog over the page: the keys sheet waits for it (Codex review on #634, #692). */
export function keysCovered(state) {
  return !!(state.search?.open || state.transcript || state.sheet || state.startWork || state.projectEditor || state.nextSwitcher || state.snoozeFor || state.confirm || state.activity.open || state.lists_open || state.filterOpen || state.listMenu || overlayOpen());
}

/**
 * ⌘[ and ⌘] go back and forward, the macOS way, even mid-typing (they type nothing). Back is Esc's and the crumb's
 * (nav.js nextBack); Forward re-applies this window's last Back. Both are taken from Chrome, whose own back and
 * forward would leave the page. Under a menu, dialog or full-size image they do nothing: Esc closes it first. True when handled.
 */
export function onHistoryKey(event, store) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || (event.key !== '[' && event.key !== ']')) return false;
  event.preventDefault();
  const { state } = store;
  if (event.repeat || state.nextKeys || state.lightbox || keysCovered(state)) return true;
  if (event.key === '[') store.nextBack?.();
  else store.nextForward?.();
  return true;
}

export function onListKey(event, store) {
  const { state } = store;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.target?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"]), .composer')) return;
  // ? shows the keys only over the page itself: another menu or dialog up keeps it.
  const covered = () => keysCovered(state);
  if ((event.key === '?' && (state.nextKeys || !covered())) || (event.key === 'Escape' && state.nextKeys)) {
    store.set({ nextKeys: event.key === '?' ? !state.nextKeys : false });
    event.preventDefault();
    return;
  }
  // The keys sheet is modal: nothing behind it acts, not even a focused button's Enter (Codex review on #634).
  if (state.nextKeys) {
    event.preventDefault();
    return;
  }
  const p = state.presentation;
  if (p && viewFor(state.role, p) === 'conversation' && p.itemId) {
    if ( state.sheet || state.startWork || state.nextSwitcher || state.snoozeFor || state.confirm || overlayOpen()) return;
    // What the page shows: the loaded detail beats an older list copy (Codex review on #634), as in currentItem().
    const item = (state.detail?.id === p.itemId && state.detail.item) || state.byId[p.itemId];
    if (item) onThreadKey(event, store, item);
    return;
  }
  if (state.replyOpen || covered()) {
    if (event.key === 'Enter' && event.target?.closest?.('.nx-row')) event.preventDefault();
    return;
  }
  if (!['inbox', 'project', 'agent'].includes(state.nextRoute.page)) return;
  const groups = [...document.querySelectorAll('.nx-main .nx-group')].map((group) => ({
    shut: group.classList.contains('shut'),
    items: [...group.querySelectorAll('.nx-row')].map((node) => ({ id: node.dataset.rowId || node.closest('[data-id]')?.dataset.id, node })).filter((r) => r.id),
  }));
  const rows = visibleRowOrder(groups);
  const focused = rows.find((r) => r.id === state.focusId);
  const item = focused && state.byId[focused.id];
  const actable = item && canActOnRow(item);
  // While the list is a picker (select.js): x and Enter toggle the focused row; u, U, d and s act on the whole selection.
  const picking = state.nextSelect?.kind === 'thread';
  if (picking && ['Enter', 'x', 'u', 'U', 'd', 'e', 's', 'S', 'r', '1', '2', '3'].includes(event.key)) {
    if ((event.key === 'Enter' || event.key === 'x') && item) store.nextSelectToggle(item.id, { range: event.shiftKey });
    else if (['u', 'U', 'd', 'e', 's'].includes(event.key)) {
      if (!state.nextSelect.ids.length || event.repeat) return;
      selectionActions(store).acts[{ u: 'read', U: 'unread', d: 'done', e: 'done', s: 'snooze' }[event.key]].onSelect();
    } else return;
    event.preventDefault();
    return;
  }
  switch (event.key) {
    // x starts selecting, with the focused row.
    case 'x':
      store.nextSelectStart('thread', item?.id || null);
      break;
    case 'j':
    case 'k': {
      const id = stepRowFocus(rows, state.focusId, event.key === 'j' ? 1 : -1);
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      store.set({ focusId: id });
      row.node.focus({ preventScroll: true });
      row.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'Enter':
      if (!item || (event.target?.closest?.('button, a, summary') && !event.target?.matches?.('.nx-row'))) return;
      store.nextOpen(item.id);
      break;
    case 'd':
    case 'e':
      if (!actable) return;
      store.done(item.id);
      break;
    case 's':
    case 'S':
      if (!actable || event.repeat) return;
      snoozeKey(event, store, item);
      break;
    case 'r':
      if (!item || item.replyable === false) return;
      store.nextOpen(item.id);
      store.openReply(item.id);
      break;
    case '1':
    case '2':
    case '3': {
      const option = actable && item.nextStep === 'your_move' ? optionsOf(item)[Number(event.key) - 1] : null;
      if (!option || state.holds[item.id]) return;
      store.answer(item.id, option);
      break;
    }
    case 'f': {
      const button = document.querySelector('.nx-filter .nx-fbtn');
      if (!button) return;
      button.click();
      break;
    }
    // n starts work where you are, like the floating +: on a project's page, in that project.
    case 'n': store.openStartWork({ projectId: state.nextRoute.page === 'project' ? state.nextRoute.id : null }); break;
    default: return;
  }
  event.preventDefault();
}
