// Overlays: the activity log drawer (with undo), the snooze picker, the "stop the job too?" question, the rename box, and toasts.

import { html } from '../vendor/preact-htm.js';
import { chooseBulkSnooze, countOf } from './next/select.js';
import { rowTitle } from './list-model.js';
import { agentName, clockTime, placeName, currentSnoozeKey, localInputValue, projectAwayLabel, snoozeTimesOf, toMs } from './util.js';

/** Custom: any future date and time, starting from tomorrow morning. */
function CustomSnooze({ store, until, current, onPick = (c) => store.chooseSnooze(c) }) {
  const now = new Date();
  // A snoozed item's own time when it's a custom one (the picker is changing it), else tomorrow morning.
  const start = until && until > now.getTime() ? new Date(until) : new Date(now);
  if (!(until && until > now.getTime())) {
    const [h, m] = snoozeTimesOf(store.state.snoozeTimes).morning.split(':').map(Number);
    start.setDate(start.getDate() + 1);
    start.setHours(h, m, 0, 0);
  }
  let input = null;
  const go = () => {
    const when = input?.value ? new Date(input.value) : null;
    // A wall time skipped by a clock change (2:30 on spring-forward night) parses to a different hour.
    const problem = !when || Number.isNaN(when.getTime()) ? 'Pick a date and time' : localInputValue(when) !== input.value ? 'That time is skipped by the clock change' : when <= new Date() ? 'Pick a time in the future' : '';
    if (problem) {
      input?.setCustomValidity(problem);
      input?.reportValidity();
      return;
    }
    const label = when.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    onPick({ key: 'custom', label: `until ${label}`, args: { until: when.toISOString() } });
  };
  // Uncontrolled (defaultValue): the desk re-renders every 15 s, and a controlled value would reset an edit.
  return html`<div class=${`choice custom${current ? ' on' : ''}`}>
    <span>Custom${current ? html` <em class="cur">Current</em>` : null}</span>
    <input type="datetime-local" aria-label="Snooze until" defaultValue=${localInputValue(start)} min=${localInputValue(now)} step="300"
      ref=${(n) => (input = n)} onInput=${(e) => e.currentTarget.setCustomValidity('')}
      onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), go())} />
    <button class="btn sm" onClick=${go}>Snooze</button>
  </div>`;
}

const ACTOR = { owner: 'you', screen: 'you · screen', voice: 'you · voice', system: 'auto', agent: 'agent', source: 'source' };

export function describeEvent(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'seen':
      return p.via === 'viewed' ? `Marked seen: open ${Math.round((p.ms || 3000) / 1000)} s` : p.via === 'heard' ? 'Marked seen: heard on voice' : p.via === 'read' ? 'Marked read' : 'Marked seen';
    case 'unseen':
      return 'Marked unread';
    case 'heard':
      return 'Heard on voice';
    case 'done':
      return p.reason === 'chapter.settled' ? 'Chapter settled → Done' : p.stopJob ? 'Done, job stopped' : 'Done';
    case 'reopen':
      return p.reason ? `Reopened: ${p.reason}` : 'Reopened';
    case 'snooze':
      return p.trigger === 'desk' ? 'Snoozed until you’re at your desk' : p.trigger === 'agent_posts' ? 'Snoozed until they post' : p.until ? `Snoozed until ${clockTime(toMs(p.until))}` : 'Snoozed';
    case 'snooze.expired':
      return 'Back from snooze';
    case 'park':
      return 'Parked';
    case 'pickup':
      return 'Picked up';
    case 'sweep.keep':
      return 'Picked up in the sweep';
    case 'sweep.drop':
      return 'Done in the sweep';
    case 'undo':
      return `Undid ${String(p.undid || p.type || 'a change').replace(/[._]/g, ' ')}`;
    case 'chapter.settled':
      return 'Chapter settled → Done';
    case 'source.done':
      return 'Settled at the source';
    case 'source.step':
      return p.to === 'failed' ? 'Turned failed' : 'Now your move';
    case 'writeback':
      return p.outcome === 'failed' ? `Write-back failed: ${p.error || 'unknown error'}` : `Written back (${(p.steps || []).join(', ') || p.outcome})`;
    case 'new':
    case 'agent.posted':
      return 'New from the agent';
    default:
      return String(e.type || 'change').replace(/[._]/g, ' ');
  }
}

export function ActivityDrawer({ store, phone }) {
  const { state } = store;
  const a = state.activity;
  if (!a.open) return null;
  return html`<div class="scrim" onClick=${() => store.toggleActivity(false)}>
    <aside class=${`drawer${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-label="Activity log" onClick=${(e) => e.stopPropagation()}>
      <header class="drawer-h"><h2>Activity log</h2><button class="btn sm ghost" onClick=${() => store.toggleActivity(false)} aria-label="Close">Close</button></header>
      <p class="note">Every automatic change lands here. Undo puts the item back the way it was.</p>
      ${a.loading && !a.events.length ? html`<p class="note">Loading…</p>` : null}
      ${a.error ? html`<p class="warn">Couldn’t load the log: ${a.error}</p>` : null}
      <ol class="log">
        ${a.events.map((e) => {
          const item = state.byId[e.itemId];
          const c = Object.values(state.commands).find((x) => x.type === 'undo' && x.args?.seq === e.seq);
          return html`<li key=${e.seq}>
            <time>${clockTime(e.at)}</time>
            <div class="t">
              <b>${describeEvent(e)}</b>
              <small>${item ? `${agentName(item)} · ${placeName(item) || item.summary?.title || e.title || ''}` : `${e.agentName ? `${e.agentName} · ` : ''}${e.title || e.itemId || ''}`} · ${ACTOR[e.actor] || e.actor}</small>
            </div>
            ${e.undoable
              ? html`<button class="btn sm" disabled=${c?.status === 'pending'} onClick=${() => store.undo(e.seq, e.itemId)}>${c?.status === 'pending' ? 'Undoing…' : 'Undo'}</button>`
              : null}
          </li>`;
        })}
      </ol>
    </aside>
  </div>`;
}

export function SnoozePicker({ store, phone }) {
  const { state } = store;
  if (!state.snoozeFor) return null;
  // A whole project (`project:<id>`): every active conversation in it gets the snooze.
  const project = state.snoozeFor.startsWith('project:') ? state.projects.find((p) => p.id === state.snoozeFor.slice(8)) : null;
  const item = project ? null : state.byId[state.snoozeFor];
  // Held by its project (snoozed or parked as a whole): what it shows is the project's state.
  const heldBy = item?.heldBy ? state.projects.find((p) => p.id === item.heldBy) : null;
  const catchup = /^(chapter|line):/.test(state.snoozeFor) ? state.catchupSnooze : null;
  const choices = store.snoozeChoices(new Date()).filter((c) => !(catchup || state.snoozeChapter) || ['soon', 'evening', 'morning', 'monday'].includes(c.key));
  // Already snoozed or parked (the List's Snoozed and Parked tabs): the picker changes it, on the current choice.
  // Held by its project: the project's state isn't this conversation's own snooze (Codex review on #537).
  const current = item?.heldBy ? null : currentSnoozeKey(item, choices);
  const away = item?.disposition === 'snoozed' || item?.disposition === 'parked';
  // A selection (next/select.js): every thread or project picked gets the snooze.
  const bulk = state.snoozeFor === 'bulk' ? state.nextBulkSnooze : null;
  const close = () => store.set({ snoozeFor: null, catchupSnooze: null, snoozeChapter: null, ...(bulk ? { nextBulkSnooze: null } : {}) });
  const choose = bulk ? (c) => chooseBulkSnooze(store, c) : (c) => store.chooseSnooze(c);
  const pick = (c) => (c.key === current ? close() : choose(c));
  const first = Math.max(0, choices.findIndex((c) => c.key === current));
  return html`<div class="scrim" onClick=${close}>
    <div class=${`picker${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-label="Snooze" onClick=${(e) => e.stopPropagation()}
      onKeyDown=${(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}>
      <h2>${catchup ? html`Snooze ${catchup.name} <span class="note">· briefs stay in Needs you</span>` : bulk ? html`Snooze ${countOf(bulk.kind, bulk.items.length)}${bulk.kind === 'project' ? html` <span class="note">· the projects; their conversations keep their own state</span>` : null}` : project ? html`Snooze ${project.name} <span class="note">· the project; its conversations keep their own state</span>` : html`${away ? 'Change snooze' : 'Snooze'}${item ? html` <span class="note">· ${placeName(item)}</span>` : null}`}</h2>
      ${heldBy ? html`<p class="note">Held by ${heldBy.name}, which is ${projectAwayLabel(heldBy)}. A snooze here is this conversation’s own, under the project’s. <button class="linkish" onClick=${() => store.wakeProject(heldBy.id)}>Wake ${heldBy.name}</button></p>` : null}
      <div class="choices">
        ${choices.map(
          (c, i) => html`<button class=${`choice${c.key === current ? ' on' : ''}`} aria-current=${c.key === current ? 'true' : null}
              ref=${(n) => i === first && n && !n.dataset.f && (n.focus(), (n.dataset.f = '1'))} onClick=${() => pick(c)}>
              <span>${c.label}${c.key === current ? html` <em class="cur">Current</em>` : null}</span><small>${c.hint}</small>
            </button>
            ${c.key === 'monday' ? html`<${CustomSnooze} store=${store} onPick=${choose} current=${current === 'custom'} until=${current === 'custom' ? toMs(item.snoozeUntil) : null} />` : null}`,
        )}
      </div>
      <div class="foot">
        ${away ? html`<button class="btn sm" onClick=${() => (close(), store.pickup(item.id))}>Back to Active</button>` : null}
        <span class="spacer"></span><button class="btn sm ghost" onClick=${close}>Cancel</button>
      </div>
    </div>
  </div>`;
}

export function ConfirmDialog({ store, phone }) {
  const c = store.state.confirm;
  if (!c || c.kind !== 'stopJob') return null;
  const item = store.state.byId[c.itemId];
  const close = () => store.set({ confirm: null });
  return html`<div class="scrim" onClick=${close}>
    <div class=${`picker${phone ? ' sheet' : ''}`} role="alertdialog" aria-modal="true" aria-label="Stop the job too?" onClick=${(e) => e.stopPropagation()}>
      <h2>Stop the job too?</h2>
      <p class="note">${item ? `${agentName(item)} has a background job running for “${placeName(item)}”` : 'A background job is running'}${c.job?.label ? `: “${c.job.label}”` : ''}. Done can stop it or leave it running.</p>
      <div class="foot">
        <button class="btn pri" ref=${(n) => n && !n.dataset.f && (n.focus(), (n.dataset.f = '1'))} onClick=${() => store.sendDone(c.itemId, true)}>Stop the job and mark done</button>
        <button class="btn" onClick=${() => store.sendDone(c.itemId, false)}>Leave it running</button>
        <span class="spacer"></span>
        <button class="btn ghost" onClick=${close}>Cancel</button>
      </div>
    </div>
  </div>`;
}

/** Renames a conversation, from its ⋯ menu: a Loom thread in Loom (it needs a name), anything else on the desk. */
export function RenameDialog({ store, phone }) {
  const c = store.state.confirm;
  if (!c || c.kind !== 'rename') return null;
  const item = store.state.byId[c.itemId];
  if (!item) return null;
  const coding = item.source === 'loom';
  const close = () => store.set({ confirm: null });
  const save = (e) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get('title') || '').trim();
    if (coding && !title) return;
    close();
    if (title !== rowTitle(item) || (!title && item.facts?.name)) store.rename(item.id, title);
  };
  return html`<div class="scrim" onClick=${close}>
    <form class=${`picker ve-pop${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-label="Rename" onClick=${(e) => e.stopPropagation()} onSubmit=${save}>
      <h2>Rename</h2>
      <label class="ve-field"><input type="text" name="title" maxlength="200" aria-label="Name" placeholder=${coding ? 'Thread title' : 'Leave empty for its own name'} required=${coding}
        defaultValue=${coding ? rowTitle(item) : item.facts?.name || rowTitle(item)}
        ref=${(n) => n && !n.dataset.f && ((n.dataset.f = '1'), setTimeout(() => (n.focus(), n.select())))}
        onKeyDown=${(e) => e.key === 'Escape' && (e.stopPropagation(), close())} /></label>
      <p class="note">${coding ? 'Renames the thread in Loom too.' : 'Kept on the desk.'}</p>
      <div class="foot">
        <button class="btn pri" type="submit">Rename</button>
        <span class="spacer"></span>
        <button class="btn ghost" type="button" onClick=${close}>Cancel</button>
      </div>
    </form>
  </div>`;
}

export function Toasts({ store }) {
  const toasts = store.state.toasts;
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map(
      (t) => html`<div class=${`toast${t.actions?.length > 1 ? ' multi' : ''}`} key=${t.id}>
        <span>${t.text}</span>
        ${t.actions?.length
          ? html`<span class="toast-actions">${t.actions.map(
              (a, i) => html`<button class=${`btn sm${i ? ' ghost' : ''}`} onClick=${() => (store.dismissToast(t.id), a.fn())}>${a.label}</button>`,
            )}</span>`
          : null}
        <button class="x" aria-label="Dismiss" onClick=${() => store.dismissToast(t.id)}>×</button>
      </div>`,
    )}
  </div>`;
}
