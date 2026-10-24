import { doneLabel } from '../query-identity.js';
// The next layout's selection (spec: "Selecting"). Select turns a list into a picker: each row shows a check and a
// tap toggles it, the breadcrumb bar becomes Cancel · N selected · Select all, and a bar along the bottom acts on
// every selected thread (or project, on the Projects page) at once. Each one goes through its own command, as
// from its own menu, and the toast's Undo takes the whole batch back.

import { html, useRef, useState } from '../../vendor/preact-htm.js';
import { MENU_STAGES, MENU_TYPES, canActOnRow, stageName, stageOf, typeName, typeOf, wantsOwner } from '../list-model.js';
import { isFresh, runningJob, waitAge } from '../util.js';
import { agentsOf, nestedProjectList, projectGroup } from './model.js';
import { Menu } from './menu.js';
import { Tile } from './rows.js';
import { MENU_ICONS as MI } from './icons.js';
import { Voice } from './voice.js';

const CHECK = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.8 8.4 2.7 2.7 5.7-6"/></svg>`;
const MORE = html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`;

const noun = (kind, n) => (kind === 'project' ? (n === 1 ? 'project' : 'projects') : n === 1 ? 'thread' : 'threads');
export const countOf = (kind, n) => `${n} ${noun(kind, n)}`;

// ── which rows ──

/** The selectable rows on the page, in the order they show (filters and folded sections included). */
export function visibleIds(root = typeof document !== 'undefined' ? document : null) {
  return root ? [...root.querySelectorAll('.nx-main [data-select-id]')].map((el) => el.dataset.selectId) : [];
}

/** `ids` with `id` flipped; with `range`, every row from the last one toggled (`anchor`) to `id` is picked. */
export function toggleIds(ids, id, { range = false, anchor = null, order = [] } = {}) {
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (range && a >= 0 && b >= 0) {
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return [...ids, ...span.filter((x) => !ids.includes(x))];
  }
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Adds selecting to the store: `nextSelect` is { kind: 'thread' | 'project', ids, anchor } while a list is a picker. */
export function createSelect(store) {
  const sel = () => store.state.nextSelect;
  function nextSelectStart(kind, id = null) {
    store.set({ nextSelect: { kind, ids: id ? [id] : [], anchor: id }, nextContext: null });
  }
  function nextSelectEnd() {
    if (sel()) store.set({ nextSelect: null });
  }
  function nextSelectToggle(id, { range = false } = {}) {
    const s = sel();
    if (!s) return;
    store.set({ nextSelect: { ...s, ids: toggleIds(s.ids, id, { range, anchor: s.anchor, order: range ? visibleIds() : [] }), anchor: id } });
  }
  function nextSelectSet(ids) {
    const s = sel();
    if (s) store.set({ nextSelect: { ...s, ids: [...new Set(ids)] } });
  }
  /** Every row on the page, or none when they all are. */
  function nextSelectAll() {
    const s = sel();
    if (!s) return;
    const all = visibleIds();
    nextSelectSet(all.every((id) => s.ids.includes(id)) ? [] : all);
  }
  return { nextSelectStart, nextSelectEnd, nextSelectToggle, nextSelectSet, nextSelectAll };
}

/** The selected threads (or projects) that still exist; the store reconciles ids when visibility changes. */
export function selectedOf(state) {
  const s = state.nextSelect;
  if (!s) return [];
  if (s.kind === 'project') return s.ids.map((id) => (state.projects || []).find((p) => p.id === id)).filter(Boolean);
  return s.ids.map((id) => state.byId[id]).filter(Boolean);
}

// ── acting on them ──

const away = (item) => item.disposition === 'snoozed' || item.disposition === 'parked';
// From Snoozed or Parked, an action applies only while the item is as shown (the server's ifStateAt; store.js asSeen).
const asSeen = (item) => (item.disposition !== 'active' && typeof item.attentionUpdatedAt === 'number' ? { ifStateAt: item.attentionUpdatedAt } : {});
// The store's guard knows a prediction still showing (a Snooze just tapped) has made the copy's token stale (Codex review on #671).
const guardOf = (store, item) => (store.guardFor ? store.guardFor(item.id) : asSeen(item));

/** What each thread action applies to; the rest of the selection is left as it is and the toast says how many. */
export const CAN = {
  done: canActOnRow,
  snooze: canActOnRow,
  park: (item) => item.disposition === 'active' || item.disposition === 'snoozed',
  pickup: away,
  // Read or unread wherever it is: Snoozed, Parked and Done too, and it stays there. Read, the owner's turn moves
  // from Needs you to Ready (an open request stays until it is answered).
  read: isFresh,
  unread: (item) => !isFresh(item),
  // Waiting on someone past the nudge gap (desk/next-step.ts Overdue): the owner asks the agent to nudge them.
  nudge: (item) => item.disposition === 'active' && !!item.watching?.overdue && item.watching.overdue.kind !== 'check-back' && !!item.watching?.waitingOn?.who,
};

/** What the owner says to the agent on Nudge: who is late, on what, and for how long. */
export function nudgeText(item, now = Date.now()) {
  const w = item.watching.waitingOn;
  return `Please nudge ${w.who} about ${w.what}: it has been overdue for ${waitAge(item.watching.overdue.since, now)}. If you can't reach them, say what I can do.`;
}

/** Nudge: a reply from the owner asking the agent to chase whoever is late. */
export async function bulkNudge(store, items) {
  const send = (item, o = quiet) => store.command('reply', item.id, { text: nudgeText(item, store.state.now) }, o);
  return runThreads(store, items, { can: CAN.nudge, label: 'Asked to nudge', send, none: (n) => (n === 1 ? 'Not waiting on anyone overdue' : `None of those ${n} is waiting on someone overdue`) });
}

/**
 * Sends one command per thread, then one toast for the lot: how many it changed, how many it left, how many
 * failed, and an Undo that takes the batch back (the server's undo for status changes; the old value re-sent for
 * a project, stage, type or pin).
 */
async function runThreads(store, items, { can = () => true, send, label, restore = null, note = null, none = null, summary = null, reuse = {} }) {
  const go = items.filter(can);
  const left = items.length - go.length;
  store.nextSelectEnd();
  if (!go.length) {
    store.toast(none ? none(items.length) : `${label}: none of ${items.length === 1 ? 'that one' : `those ${items.length}`} could change`);
    return [];
  }
  // A Retry after a lost answer sends each one's own command id again, so the desk replays it rather than acting twice.
  const results = await Promise.all(go.map(async (item) => ({ item, result: await send(item, reuse[item.id] ? { ...quiet, commandId: reuse[item.id] } : quiet).catch((err) => ({ status: 'failed', error: err.message })) })));
  const sent = results.filter((r) => r.result?.status === 'sent');
  const failed = results.length - sent.length;
  const seqs = sent.map((r) => r.result.outcome?.seq).filter(Boolean);
  const text = [
    summary ? summary(sent) : `${label} · ${countOf('thread', sent.length)}`,
    left ? `${left} left as ${left === 1 ? 'it was' : 'they were'}` : null,
    failed ? `${failed} didn’t go through` : null,
    note ? note(sent.map((r) => r.item)) : null,
  ].filter(Boolean).join(' · ');
  // A failed undo or restore resolves as 'failed' (store.command doesn't throw): count it rather than claim it all came back.
  const undo = async () => {
    const tries = [...seqs.map((seq) => store.command('undo', null, { seq }, { quiet: true })), ...(restore ? sent.map((r) => restore(r.item, r.result.outcome)) : [])];
    const back = await Promise.all(tries.map((p) => p.catch((err) => ({ status: 'failed', error: err.message }))));
    const missed = back.filter((r) => r?.status !== 'sent').length;
    if (missed) store.toast(`Undo didn’t finish: ${missed} of ${back.length} didn’t go back`, { sticky: true });
    else store.toast('Undone');
  };
  store.toast(text, sent.length && (seqs.length || restore) ? { action: { label: 'Undo', fn: undo }, ms: 9000 } : {});
  // The ones that didn't go through: why, and Retry for just those, as a single action's toast offers (Codex review on #671).
  // Ones that changed since they were picked would only be refused again: look at those first (Codex review on #671).
  const missed = results.filter((r) => r.result?.status !== 'sent' && r.result?.outcome?.changed !== true);
  const changed = results.filter((r) => r.result?.status !== 'sent' && r.result?.outcome?.changed === true);
  if (missed.length) {
    const why = missed[0].result?.error || 'unknown error';
    store.toast(`${label}: ${countOf('thread', missed.length)} didn’t go through (${why})`, { sticky: true, actions: [{ label: 'Retry', fn: () => retryMissed(store, missed, { can, send, label, restore, note, none, summary }) }] });
  }
  if (changed.length) store.toast(`${label}: ${countOf('thread', changed.length)} changed since you picked ${changed.length === 1 ? 'it' : 'them'}; ${changed.length === 1 ? 'it shows' : 'they show'} as ${changed.length === 1 ? 'it is' : 'they are'} now`, { sticky: true });
  return results;
}

const quiet = { quiet: true };

/**
 * Retry for a bulk action's failures: each command again exactly as first sent, guard and all (the store's
 * retryCommand; the same id after a lost answer), never rebuilt from the row as it is now (Codex review on #671).
 */
function retryMissed(store, missed, opts) {
  const entries = missed.map((r) => store.state.commands?.[r.result?.commandId]).filter(Boolean);
  if (store.retryCommand && entries.length === missed.length) return Promise.all(entries.map((c) => store.retryCommand(c)));
  return runThreads(store, missed.map((r) => r.item), { ...opts, reuse: Object.fromEntries(missed.filter((r) => r.result?.transport).map((r) => [r.item.id, r.result.commandId])) });
}

export async function bulkDone(store, items) {
  // A background job is left running, as finishing a project leaves it.
  const send = (item, o = quiet) => store.command('done', item.id, { ...guardOf(store, item), ...(runningJob(item) ? { stopJob: false } : {}) }, o);
  const results = await runThreads(store, items, { can: CAN.done, label: 'Done', send, summary: (sent) => {
    const cleared = sent.filter(({ item, result }) => result.outcome?.cleared ?? doneLabel(item) === 'Clear').length;
    return [`Done · ${countOf('thread', sent.length - cleared)}`, cleared ? `${cleared} cleared` : null].filter(Boolean).join(' · ');
  } });
  offerWritebackRetry(store, results, send);
  return results;
}

/** Done here but not at the source (store.js sendDone does the same for one): say so, with Retry for those. */
function offerWritebackRetry(store, results, send) {
  const failed = results.filter((r) => r.result?.status === 'sent' && r.result.outcome?.writeback?.outcome === 'failed').map((r) => r.item);
  if (!failed.length) return;
  const retry = async () => offerWritebackRetry(store, await Promise.all(failed.map(async (item) => ({ item, result: await send(item) }))), send);
  store.toast(`Done here, but ${failed.length === 1 ? 'the write-back' : `${failed.length} write-backs`} failed`, { sticky: true, action: { label: 'Retry', fn: retry } });
}
export function bulkRead(store, items) {
  // Read, an open request (a question or an approval) still needs an answer, so it stays Needs you: say how many.
  const note = (read) => {
    const n = read.filter((item) => wantsOwner({ ...item, seen: 'seen' }, store.state.now)).length;
    return n ? `${n} still ${n === 1 ? 'needs an answer' : 'need answers'}` : null;
  };
  return runThreads(store, items, { can: CAN.read, label: 'Marked read', note, none: (n) => (n === 1 ? 'Already read' : `All ${n} already read`), send: (item, o = quiet) => store.command('seen', item.id, { via: 'read', ...guardOf(store, item) }, o) });
}
export function bulkUnread(store, items) {
  return runThreads(store, items, { can: CAN.unread, label: 'Marked unread', none: (n) => (n === 1 ? 'Already unread' : `All ${n} already unread`), send: (item, o = quiet) => store.command('unseen', item.id, guardOf(store, item), o) });
}
export function bulkSnooze(store, items, choice) {
  if (choice.type === 'park') return bulkPark(store, items);
  const label = choice.key === 'custom' ? `Snoozed ${choice.label}` : `Snoozed · ${choice.label.toLowerCase()}`;
  return runThreads(store, items, { can: CAN.snooze, label, send: (item, o = quiet) => store.command('snooze', item.id, { ...choice.args, ...guardOf(store, item) }, o) });
}
export function bulkPark(store, items) {
  return runThreads(store, items, { can: CAN.park, label: 'Parked', send: (item, o = quiet) => store.command('park', item.id, guardOf(store, item), o) });
}
export function bulkPickup(store, items) {
  return runThreads(store, items, { can: CAN.pickup, label: 'Back in Active', send: (item, o = quiet) => store.command('pickup', item.id, guardOf(store, item), o) });
}
export function bulkMove(store, items, projectId) {
  const name = (store.state.projects || []).find((p) => p.id === projectId)?.name;
  return runThreads(store, items, {
    can: (item) => (item.facts?.projectId || null) !== (projectId || null),
    label: name ? `Moved to ${name}` : 'Out of their project',
    send: (item, o = quiet) => store.command('project', item.id, { projectId: projectId || null }, o),
    restore: (item, outcome) => store.command('project', item.id, { projectId: item.facts?.projectId || null, ...(outcome && Object.hasOwn(outcome, 'previousParentItemId') ? { parentItemId: outcome.previousParentItemId } : {}) }, quiet),
  });
}
export function bulkTag(store, items, field, value) {
  const of = field === 'stage' ? stageOf : typeOf;
  const name = value ? (field === 'stage' ? stageName(value) : typeName(value)) : 'none';
  return runThreads(store, items, {
    can: (item) => (of(item) || null) !== (value || null),
    label: `${field === 'stage' ? 'Stage' : 'Type'} · ${name}`,
    send: (item, o = quiet) => store.command('tag', item.id, { [field]: value || null }, o),
    restore: (item) => store.command('tag', item.id, { [field]: of(item) || null }, quiet),
  });
}
export function bulkPin(store, items, pinned) {
  return runThreads(store, items, {
    can: (item) => !!item.facts?.pinned !== pinned,
    label: pinned ? 'Pinned' : 'Unpinned',
    send: (item, o = quiet) => store.command('pin', item.id, { pinned }, o),
    restore: (item) => store.command('pin', item.id, { pinned: !!item.facts?.pinned }, quiet),
  });
}

/** A whole project at a time (store.projectAction), one toast for the lot. */
async function runProjects(store, projects, { can, body, label }) {
  const go = projects.filter(can);
  const left = projects.length - go.length;
  store.nextSelectEnd();
  if (!go.length) return store.toast(`${label}: none of ${projects.length === 1 ? 'that one' : `those ${projects.length}`} could change`);
  const results = await Promise.all(go.map((p) => store.projectAction(p.id, body)));
  const ok = results.filter(Boolean).length;
  store.toast([`${label} · ${countOf('project', ok)}`, left ? `${left} left as ${left === 1 ? 'it was' : 'they were'}` : null].filter(Boolean).join(' · '));
}

const groupOf = (store) => (p) => projectGroup(p, store.state.now);
export const PROJECT_CAN = {
  wake: (g) => g === 'snoozed' || g === 'parked',
  snooze: (g) => g !== 'done',
  park: (g) => g === 'active' || g === 'snoozed',
  finish: (g) => g !== 'done',
};
const projectCan = (store, key) => (p) => PROJECT_CAN[key](groupOf(store)(p));

export function bulkProjectSnooze(store, projects, choice) {
  if (choice.type === 'park') return runProjects(store, projects, { can: projectCan(store, 'park'), body: { action: 'park' }, label: 'Parked' });
  return runProjects(store, projects, { can: projectCan(store, 'snooze'), body: { action: 'snooze', ...choice.args }, label: `Snoozed · ${choice.label.toLowerCase()}` });
}

/** The snooze picker's answer for a selection (overlays.js SnoozePicker, with snoozeFor 'bulk'). */
export function chooseBulkSnooze(store, choice) {
  const bulk = store.state.nextBulkSnooze;
  store.set({ snoozeFor: null, nextBulkSnooze: null });
  if (!bulk) return;
  if (bulk.kind === 'project') return bulkProjectSnooze(store, bulk.items, choice);
  return bulkSnooze(store, bulk.items, choice);
}
function openBulkSnooze(store, kind, items) {
  store.set({ snoozeFor: 'bulk', nextBulkSnooze: { kind, items }, snoozeGuard: null });
}

// ── the actions, as menus and as the bottom bar ──

// A project's own tile (its color and icon), sized to a menu item's icon.
const tile = (p, store) => html`<${Tile} tile=${{ kind: 'project', id: p.id, project: p }} store=${store} size=${16} />`;

/** The actions for what's selected: { key: item } for the bar, and `menu` for More and a right-click. */
export function selectionActions(store) {
  const { state } = store;
  const kind = state.nextSelect?.kind;
  const items = selectedOf(state);
  const any = (fn) => items.some(fn);
  if (kind === 'project') {
    const g = groupOf(store);
    const acts = {
      wake: any((p) => PROJECT_CAN.wake(g(p))) ? { icon: MI.wake, label: 'Wake', onSelect: () => runProjects(store, items, { can: projectCan(store, 'wake'), body: { action: 'wake' }, label: 'Woke' }) } : null,
      snooze: { icon: MI.snooze, label: 'Snooze…', short: 'Snooze', onSelect: () => openBulkSnooze(store, 'project', items) },
      park: { icon: MI.park, label: 'Park', onSelect: () => runProjects(store, items, { can: projectCan(store, 'park'), body: { action: 'park' }, label: 'Parked' }) },
      finish: { icon: MI.finish, label: 'Finish…', short: 'Finish', onSelect: () => store.set({ confirm: { kind: 'finishProjects', projects: items } }) },
    };
    return { acts, bar: ['wake', 'snooze', 'park', 'finish'].filter((k) => acts[k]), menu: ['wake', 'snooze', 'park', 'finish'].map((k) => acts[k]).filter(Boolean) };
  }
  const projects = nestedProjectList(state.projects, agentsOf(state.lists, state.now));
  const acts = {
    read: { icon: MI.eye, label: 'Mark read', short: 'Read', hint: 'u', onSelect: () => bulkRead(store, items) },
    unread: { icon: MI.eyeOff, label: 'Mark unread', hint: 'U', onSelect: () => bulkUnread(store, items) },
    done: { icon: MI.done, label: items.length && items.every((item) => doneLabel(item) === 'Clear') ? 'Clear' : 'Done', hint: 'd', onSelect: () => bulkDone(store, items) },
    snooze: { icon: MI.snooze, label: 'Snooze…', short: 'Snooze', hint: 's', onSelect: () => openBulkSnooze(store, 'thread', items) },
    park: { icon: MI.park, label: 'Park', onSelect: () => bulkPark(store, items) },
    pickup: any(away) ? { icon: MI.back, label: 'Back to Active', short: 'Active', onSelect: () => bulkPickup(store, items) } : null,
    nudge: any(CAN.nudge) ? { icon: MI.wake, label: 'Nudge', short: 'Nudge', onSelect: () => bulkNudge(store, items) } : null,
    move: {
      icon: MI.folder,
      label: 'Move to project',
      short: 'Move',
      sub: [...projects.map(({ project: p, label }) => ({ label, icon: tile(p, store), onSelect: () => bulkMove(store, items, p.id) })), 'sep', { label: 'No project', onSelect: () => bulkMove(store, items, null) }],
    },
    stage: store.state.flags?.stageLabels ? { icon: MI.sections, label: 'Stage', sub: [...MENU_STAGES.map((key) => ({ label: stageName(key), onSelect: () => bulkTag(store, items, 'stage', key) })), { label: 'No stage', onSelect: () => bulkTag(store, items, 'stage', null) }] } : null,
    type: { icon: MI.tag, label: 'Type', sub: [...MENU_TYPES.map((key) => ({ label: typeName(key), onSelect: () => bulkTag(store, items, 'type', key) })), { label: 'None', onSelect: () => bulkTag(store, items, 'type', null) }] },
    pin: any((i) => !i.facts?.pinned) ? { icon: MI.pin, label: 'Pin', onSelect: () => bulkPin(store, items, true) } : null,
    unpin: any((i) => i.facts?.pinned) ? { icon: MI.pin, label: 'Unpin', onSelect: () => bulkPin(store, items, false) } : null,
  };
  // Everything snoozed or parked: Back to Active takes Park's place on the bar.
  const allAway = items.length > 0 && items.every(away);
  // Mark read leads the bar: Needs you to Ready in one tap, wherever the threads are.
  const bar = ['read', 'done', 'snooze', allAway ? 'pickup' : 'park', 'move'];
  const menu = ['read', 'unread', 'sep', 'done', 'snooze', 'park', 'pickup', 'nudge', 'sep', 'move', 'stage', 'type', 'sep', 'pin', 'unpin'].map((k) => (k === 'sep' ? k : acts[k])).filter(Boolean);
  return { acts, bar, menu, more: menu.filter((it) => it === 'sep' || !bar.some((k) => acts[k] === it)) };
}

/** A right-click on a selected row: the actions for the whole selection, then a way out. */
export function selectionMenu(store) {
  const { menu } = selectionActions(store);
  return [...menu, 'sep', { icon: MI.done, label: 'Select all', hint: '⌘A', onSelect: () => store.nextSelectAll() }, { label: 'Stop selecting', hint: 'esc', onSelect: () => store.nextSelectEnd() }];
}

// ── the pieces on the page ──

/** The circle a row shows while its list is a picker. */
export function SelectCheck({ on }) {
  return html`<span class=${`nx-check${on ? ' on' : ''}`} aria-hidden="true">${CHECK}</span>`;
}

/** "Select" beside a list's title (Inbox, Projects): the visible way in on every screen. */
export function SelectButton({ store, kind }) {
  if (store.state.nextSelect) return null;
  return html`<button class="nx-fbtn nx-selbtn" onClick=${() => store.nextSelectStart(kind)}>${CHECK}<span>Select</span></button>`;
}

/** A group heading's Select all / Deselect, while selecting. */
export function GroupPick({ store, ids }) {
  const s = store.state.nextSelect;
  if (!s || !ids.length) return null;
  const all = ids.every((id) => s.ids.includes(id));
  return html`<button class="nx-gpick" onClick=${(e) => (e.stopPropagation(), store.nextSelectSet(all ? s.ids.filter((id) => !ids.includes(id)) : [...s.ids, ...ids]))}>${all ? 'Deselect' : `Select ${ids.length}`}</button>`;
}

/** The breadcrumb bar while selecting: Cancel · N selected · Select all, with the voice pill kept where it was. */
export function SelectBar({ store, phone }) {
  const s = store.state.nextSelect;
  const n = selectedOf(store.state).length;
  const all = visibleIds();
  const every = all.length > 0 && all.every((id) => s.ids.includes(id));
  return html`<header class=${`nx-bar nx-selbar${phone ? ' phone' : ''}`}>
    <button class="nx-tbtn" onClick=${() => store.nextSelectEnd()}>Cancel</button>
    <span class="nx-selc" aria-live="polite">${n ? `${n} selected` : `Select ${noun(s.kind, 2)}`}</span>
    <${Voice} store=${store} phone=${phone} />
    <button class="nx-tbtn" onClick=${() => store.nextSelectAll()}>${every ? 'Deselect all' : 'Select all'}</button>
  </header>`;
}

/** The bar along the bottom while selecting: the main actions with labels, then More. */
export function SelectDock({ store, phone }) {
  const [menu, setMenu] = useState(null);
  const n = selectedOf(store.state).length;
  const { acts, bar, more } = selectionActions(store);
  const open = (e, items, title) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ items, title, at: phone ? null : { x: r.left, y: r.top - 6 } });
  };
  const button = (key) => {
    const it = acts[key];
    return html`<button class="nx-dk" disabled=${!n} data-menu-button onClick=${(e) => (it.sub ? open(e, it.sub, it.label) : it.onSelect())}>${it.icon}<span>${it.short || it.label}</span></button>`;
  };
  // The menu sits outside the bar: the bar's backdrop blur would make it the box a fixed sheet is placed in.
  return html`<nav class="nx-seldock" aria-label="Act on the selection">
    <div class="nx-dkrow">
      ${bar.map(button)}
      ${more?.some((it) => it !== 'sep') ? html`<button class="nx-dk" disabled=${!n} data-menu-button onClick=${(e) => open(e, more.filter((it, i, all) => it !== 'sep' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'sep')), countOf(store.state.nextSelect.kind, n))}>${MORE}<span>More</span></button>` : null}
    </div>
  </nav>
  ${menu ? html`<${Menu} items=${menu.items} title=${menu.title} phone=${phone} at=${menu.at} onClose=${() => setMenu(null)} />` : null}`;
}

/** Finishing several projects asks once what happens to their open threads (projects-editor.js asks for one). */
export function FinishProjectsDialog({ store, phone }) {
  const c = store.state.confirm;
  if (!c || c.kind !== 'finishProjects') return null;
  const picked = c.projects.filter(projectCan(store, 'finish'));
  // A parent asks once about its open child projects (docs/specs/spaces.md, Nesting): they finish with it, or stay open
  // and move up. A child picked with its parent goes with the parent's choice.
  const kidsOf = (p) => (store.state.projects || []).filter((k) => k.parent === `project:${p.id}` && !k.finishedAt);
  const withKids = !c.keepKids;
  const ids = new Set(picked.map((p) => p.id));
  const projects = picked.filter((p) => !(withKids && p.parent?.startsWith('project:') && ids.has(p.parent.slice(8))));
  const kids = [...new Map(projects.flatMap(kidsOf).map((k) => [k.id, k])).values()];
  const ending = [...projects, ...(withKids ? kids.filter((k) => !ids.has(k.id)) : [])];
  const open = ending.reduce((n, p) => n + store.projectItems(p.id, ['active', 'snoozed', 'parked']).length, 0);
  const close = () => store.set({ confirm: null });
  const finish = (how) => (close(), runProjects(store, projects, { can: () => true, body: { action: 'finish', how, ...(kids.length ? { children: withKids ? 'finish' : 'keep' } : {}) }, label: 'Finished' }));
  return html`<div class="scrim" onClick=${close}>
    <div class=${`picker${phone ? ' sheet' : ''}`} role="alertdialog" aria-modal="true" aria-label=${`Finish ${countOf('project', projects.length)}?`} onClick=${(e) => e.stopPropagation()}>
      <h2>Finish ${countOf('project', projects.length)}?</h2>
      ${kids.length
        ? html`<div class="pe-kids" role="radiogroup" aria-label="Their projects">
            <p class="note">${countOf('project', kids.length)} inside them: ${kids.map((k) => k.name).join(', ')}.</p>
            <label><input type="radio" name="pe-kids" checked=${withKids} onChange=${() => store.set({ confirm: { ...c, keepKids: false } })} /> Finish those too</label>
            <label><input type="radio" name="pe-kids" checked=${!withKids} onChange=${() => store.set({ confirm: { ...c, keepKids: true } })} /> Keep those open, in your space</label>
          </div>`
        : null}
      <p class="note">${open ? `${countOf('thread', open)} still open in them. A turn that’s still running is left as it is.` : 'Nothing in them is open.'} They move to History; reopen one from Settings.</p>
      <div class="foot">
        <button class="btn pri" ref=${(el) => el && !el.dataset.f && (el.focus(), (el.dataset.f = '1'))} onClick=${() => finish('done')}>${open ? 'Mark them done and finish' : 'Finish'}</button>
        ${open ? html`<button class="btn" onClick=${() => finish('out')}>Keep them open, on their own</button>` : null}
        <span class="spacer"></span>
        <button class="btn ghost" onClick=${close}>Cancel</button>
      </div>
    </div>
  </div>`;
}

/**
 * A long press on a row (a touch screen) starts selecting with that row, as a phone's lists do. A move (a scroll
 * or a swipe) cancels it, and the tap that ends a long press doesn't open the row.
 */
export function useLongPress(onLong, { enabled = true, ms = 480 } = {}) {
  const t = useRef(null);
  const fired = useRef(false);
  const stop = () => {
    clearTimeout(t.current?.timer);
    t.current = null;
  };
  return {
    onPointerDown: (e) => {
      fired.current = false;
      if (!enabled || e.pointerType !== 'touch' || e.target.closest?.('button, a, .lunder')) return;
      t.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => ((fired.current = true), (t.current = null), navigator.vibrate?.(10), onLong()), ms) };
    },
    onPointerMove: (e) => t.current && Math.hypot(e.clientX - t.current.x, e.clientY - t.current.y) > 8 && stop(),
    onPointerUp: stop,
    onPointerCancel: stop,
    onClickCapture: (e) => fired.current && (e.stopPropagation(), e.preventDefault(), (fired.current = false)),
    onContextMenu: (e) => fired.current && e.preventDefault(),
  };
}

/** Two sets of pointer handlers on one element. */
export function both(a, b) {
  const out = { ...a };
  for (const [k, fn] of Object.entries(b)) out[k] = a[k] ? (e) => (a[k](e), fn(e)) : fn;
  return out;
}
