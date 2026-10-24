// A project's coordinator (TGO-967) and the right side panel it shares with links and screens.
//
// The right panel takes tabs: Coordinator (in a conversation that belongs to a project, and on a
// project's page in the List) and Links. The coordinator is a read-only agent: the owner asks it
// about the project, it answers with chips for the conversations it means, and when only a
// conversation's agent knows, it drafts a question the owner sends ("Send when it’s idle") or drops.
// Keep watch keeps "Where it stands" and stall flags on the project page and its folder.
//
// The coordinator never needs the owner: no badge, no count, no ring. It is a resource.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { coordinatorMarkdown, coordinatorTimeline, projectLinks } from './coordinator-model.js';
import { isHandoff, onCodeButton, startFromHandoff } from './md-actions.js';
import { DraftCard } from './mail-draft.js';
import { KIND_WORD, age } from './util.js';
import { rowTitle } from './list-model.js';

// From this width a side panel fits in the margin beside the 760px column, so it stays open over the
// page; below it a panel would cover the column, so it flies out over a scrim instead.
export const DOCK_QUERY = '(min-width: 1440px)';

export const COMPASS = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>`;
const EYE = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>`;
export const SEND = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>`;
const LOCK = html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`;
const START = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>`;
const X = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>`;

const TAB_LABEL = { coordinator: 'Coordinator', links: 'Links', mail: 'Mail' };

/** The right panel's content: its tabs (when more than one) over the open tab's body. */
export function SidePanel({ store, tabs, tab, bodies, counts = {}, onClose = null }) {
  return html`<div class="sp">
    ${tabs.length > 1 || onClose
      ? html`<div class="sp-tabs" role="tablist">
          ${tabs.length > 1
            ? tabs.map((t) => html`<button role="tab" aria-selected=${t === tab} class=${t === tab ? 'on' : ''} onClick=${() => store.setSideTab(t)}>${t === 'coordinator' ? COMPASS : null}${TAB_LABEL[t]}${counts[t] ? html`<span class="n">${counts[t]}</span>` : null}</button>`)
            : html`<span class="sp-title">${TAB_LABEL[tab]}</span>`}
          ${onClose ? html`<button class="ib sp-x" aria-label="Close" title="Close" onClick=${onClose}>${X}</button>` : null}
        </div>`
      : null}
    <div class=${`sp-pane ${tab}`}>${bodies[tab] ? bodies[tab]() : null}</div>
  </div>`;
}

/** The conversation chips in an answer open that conversation; its code blocks' buttons work as in a conversation. */
function onChip(event, store, projectId) {
  if (onCodeButton(event, store, projectId)) return;
  const chip = event.target.closest?.('.cchip');
  if (!chip) return;
  event.preventDefault();
  store.openItem(chip.dataset.item);
}

function Answer({ text, store, projectId = null, streaming = false }) {
  const markup = coordinatorMarkdown(text, (id) => store.state.byId[id] || null, store.state.now || Date.now());
  return html`<div class=${`md cp-md${streaming ? ' streaming' : ''}`} onClick=${(e) => onChip(e, store, projectId)} dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}


function Chip({ itemId, title, store }) {
  const item = store.state.byId[itemId];
  return html`<button class="cchip" onClick=${() => store.openItem(itemId)}><i></i>${item ? rowTitle(item) : title}</button>`;
}


function Entry({ entry, project, store }) {
  if (entry.kind === 'question') {
    return html`<div class=${`cp-q${entry.pending && !entry.failed ? ' pending' : ''}`}>${entry.fromItemId ? html`<small>About <${Chip} itemId=${entry.fromItemId} title="a conversation" store=${store} /></small>` : null}${entry.text}
      ${entry.failed
        ? html`<div class="cp-qfail">Didn’t send: ${entry.failed}. <button class="linkish" onClick=${() => store.retryQuestion(project.id, entry.commandId)}>Retry</button> · <button class="linkish" onClick=${() => store.dropQuestion(project.id, entry.commandId)}>Drop</button></div>`
        : null}</div>`;
  }
  if (entry.kind === 'answer') return html`<${Answer} text=${entry.text} store=${store} projectId=${project.id} streaming=${entry.streaming} />`;
  // "“Title” (loom:…) answered your question." without the id.
  if (entry.kind === 'relay') return html`<div class="cp-relaynote">${entry.text.split('\n')[0].replace(/ \([^()\s]+\)/, '')}</div>`;
  if (entry.kind === 'draft') return html`<${DraftCard} draft=${entry.draft} project=${project} store=${store} key=${entry.draft.id} />`;
  if (entry.kind === 'digest') return html`<div class="cp-digest"><div class="cp-dk">Morning · ${new Date(entry.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div><${Answer} text=${entry.text} store=${store} projectId=${project.id} /></div>`;
  return null;
}

/** Keep watch and how questions reach conversations. */
function WatchMenu({ project, summary, store }) {
  const watch = summary?.watch || { on: false, stands: true, flags: true, digest: false };
  const reach = summary?.reach || 'approve';
  const set = (patch) => store.setCoordinatorWatch(project.id, patch);
  const toggle = (key, name, desc) => html`<button class=${`tg${watch[key] ? ' on' : ''}`} role="switch" aria-checked=${!!watch[key]} onClick=${() => set({ [key]: !watch[key] })}><span class="tn">${name}</span><span class="sw"></span><span class="td">${desc}</span></button>`;
  return html`<div class="lmenu cp-menu" role="menu" onClick=${(e) => e.stopPropagation()}>
    ${toggle('on', html`<b>Keep watch</b>`, 'Checks in when the conversations change, not on a timer. Stops while the project is snoozed or parked.')}
    <div class="sep"></div>
    <div class="mlbl">While keeping watch</div>
    ${toggle('stands', 'Write “Where it stands”', 'On the project page and on its folder in the List.')}
    ${toggle('flags', 'Flag stalls', 'Waiting on you over a day, failed with no retry, or a review older than two days.')}
    ${toggle('digest', 'Morning digest', 'A short digest here at your morning snooze time.')}
    <div class="sep"></div>
    <div class="mlbl">Asking conversations</div>
    <div class="cp-seg">
      <button class=${reach === 'approve' ? 'on' : ''} onClick=${() => set({ reach: 'approve' })}>I approve each</button>
      <button class=${reach === 'idle' ? 'on' : ''} onClick=${() => set({ reach: 'idle' })}>Ask idle ones directly</button>
    </div>
    <div class="hint">${reach === 'approve' ? 'The coordinator drafts a question; nothing reaches a conversation until you send it.' : 'Questions go to a conversation only while it’s idle, and never start work there. Each one shows here.'}</div>
  </div>`;
}

/** The Keep watch button, with its menu. */
export function WatchButton({ project, store, compact = false }) {
  const summary = store.state.coordinators[project.id];
  const open = store.state.listMenu?.watch === project.id;
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !e.target.closest('.cp-menu, .cp-watch') && store.set({ listMenu: null });
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  const on = !!summary?.watch?.on;
  return html`<span class="cp-watchwrap">
    <button class=${`btn sm cp-watch${on ? ' on' : ''}`} aria-expanded=${open} title="Keep watch" onClick=${(e) => (e.stopPropagation(), store.set({ listMenu: open ? null : { watch: project.id } }))}>${EYE}${compact ? null : html`<span>${on ? 'Watching' : 'Keep watch'}</span>`}</button>
    ${open ? html`<${WatchMenu} project=${project} summary=${summary} store=${store} />` : null}
  </span>`;
}

/** The question box: Enter asks, Shift+Enter is a new line. */
export function AskBox({ project, store, fromItemId = null, placeholder = 'Ask about this project…', onAsked = null, autoFocus = false }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  const ask = () => {
    const words = text.trim();
    if (!words) return;
    setText('');
    store.askCoordinator(project.id, words, fromItemId);
    onAsked?.();
  };
  return html`<form class="cp-ask" onSubmit=${(e) => (e.preventDefault(), ask())}>
    ${COMPASS}
    <textarea ref=${ref} rows="1" placeholder=${placeholder} value=${text} onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          ask();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.target.blur();
        }
      }}></textarea>
    <button class="cp-go" type="submit" aria-label="Ask" disabled=${!text.trim()}>${SEND}</button>
  </form>`;
}

/** The Coordinator tab: the conversation with it, its drafted questions, and the question box. */
export function CoordinatorPane({ project, store, fromItemId = null }) {
  const c = store.state.coordinator;
  const mine = c?.projectId === project.id ? c : null;
  const summary = store.state.coordinators[project.id];
  const body = useRef(null);
  useEffect(() => {
    store.openCoordinator(project.id);
  }, [project.id]);
  const entries = coordinatorTimeline(mine?.view, mine?.pending || []);
  const last = entries.at(-1);
  const thinking = (mine?.view?.running || mine?.pending?.some((p) => !p.failed)) && !(last?.kind === 'answer' && last.streaming);
  // Kept at the newest entry as answers arrive.
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [entries.length, last?.text?.length, thinking]);
  const members = store.projectItems(project.id, ['active', 'snoozed', 'parked']).length;
  return html`<div class="cp">
    <div class="cp-head">
      <span class="cp-tile">${COMPASS}</span>
      <div class="cp-who"><small>Reads ${members} conversation${members === 1 ? '' : 's'} in ${project.name}; never posts in them</small></div>
      <${WatchButton} project=${project} store=${store} />
    </div>
    <div class="cp-body" ref=${body}>
      ${!entries.length && !thinking
        ? html`<div class="cp-intro">
            <p>Ask anything about <b>${project.name}</b>: what’s blocking it, what changed, what’s waiting on you.</p>
            <p>It reads the conversations, their PRs and transcripts, and only drafts questions for them. Nothing reaches a conversation unless you send it.</p>
            <div class="cp-sugg">${['What’s blocking this project?', 'What changed since yesterday?', 'Is anything waiting on me?'].map((q) => html`<button onClick=${() => store.askCoordinator(project.id, q, fromItemId)}>${q}</button>`)}</div>
          </div>`
        : entries.map((entry) => html`<${Entry} key=${entry.key} entry=${entry} project=${project} store=${store} />`)}
      ${thinking ? html`<div class="cp-thinking"><span class="dots"><i></i><i></i><i></i></span>${mine?.view?.threadId ? 'Reading the project…' : 'Starting the coordinator…'}</div>` : null}
      ${mine?.error || mine?.view?.error ? html`<p class="note cp-err">${mine.error || mine.view.error}</p>` : null}
    </div>
    <div class="cp-foot">
      <${AskBox} project=${project} store=${store} fromItemId=${fromItemId} placeholder=${entries.length ? 'Ask a follow-up…' : 'Ask about this project…'} />
      <div class="cp-fine">${LOCK}Reads only. Nothing reaches a conversation unless ${summary?.reach === 'idle' ? 'it’s idle' : 'you send it'}.</div>
    </div>
  </div>`;
}

/** A Links list; a handoff brief carries Start, which opens Start work with the brief, in the project it came from. */
export function LinkList({ links, store, projectId = null }) {
  return html`<ol class="rd-linklist">${links.map(
    (a) => html`<li><a href=${a.url} target="_blank" rel="noopener">${a.label || a.url}</a>${KIND_WORD[a.kind] ? html`<span class="note"> · ${KIND_WORD[a.kind]}</span>` : null}${
      isHandoff(a)
        ? html`<button type="button" class="link-start" title="Start a new thread from this handoff" aria-label=${`Start a new thread from ${a.label || 'this handoff'}`} onClick=${() => startFromHandoff(store, a, projectId)}>${START}<span>Start</span></button>`
        : null
    }</li>`,
  )}</ol>`;
}

/** The Links tab on a project's page: every link its conversations produced, by conversation. */
export function ProjectLinks({ project, store }) {
  const groups = projectLinks(store.projectItems(project.id, ['active', 'snoozed', 'parked', 'done']));
  if (!groups.length) return html`<p class="note">No links in this project’s conversations yet.</p>`;
  return html`${groups.map(
    ({ item, links }) => html`<section class="rd-block">
      <h3 class="h4"><button class="linkish" onClick=${() => store.openItem(item.id)}>${rowTitle(item)}</button></h3>
      <${LinkList} links=${links} store=${store} projectId=${project.id} />
    </section>`,
  )}`;
}
