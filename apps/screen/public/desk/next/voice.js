// The top bar's voice control. Keep arrival and confirm history across page changes.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { NavigatorButton } from '../navigator.js';
import { HINTS } from '../dock.js';
import { DraftCard } from '../draft.js';
import { Wave } from '../chrome.js';
import { Tile } from './rows.js';
import { agentsOf } from './model.js';
import { confirmToOpen, freshCaption, voiceLine } from './voice-model.js';

const sessions = new WeakMap();
function Caption({ line }) {
  return html`<span>${line.speaker === 'owner' ? '' : html`<span class="nx-vwho">${line.name || 'Agent'}: </span>`}“${line.text}”</span>`;
}

export function Voice({ store, phone }) {
  const { state } = store;
  if (!sessions.has(store)) sessions.set(store, { arrival: null, seen: [] });
  const session = sessions.get(store);
  const last = state.captions.at(-1);
  if (last !== session.arrival?.line) session.arrival = last ? { line: last, at: Date.now() } : null;
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const line = voiceLine(state, session.arrival, Math.max(now, Date.now()));
  useEffect(() => {
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, (session.arrival?.at || 0) + 4000 - Date.now()));
    const settle = setTimeout(() => setNow(Date.now()), Math.max(0, (session.arrival?.at || 0) + 6000 - Date.now()));
    return () => { clearTimeout(timer); clearTimeout(settle); };
  }, [last]);
  // A modal (Settings, Start work, a sheet, the switcher, the drawer) closes the panel, and a ready
  // draft waits for it to go before opening: the bar must never sit over a dialog (Codex review on #627).
  const modal = !!(state.nextSwitcher || state.startWork || state.sheet || state.filterOpen || state.snoozeFor || state.confirm);
  useEffect(() => {
    if (modal) { setOpen(false); return; }
    const id = confirmToOpen(state.draft, session.seen);
    if (id && !state.pause?.active) { session.seen.push(id); setOpen(true); }
  }, [state.draft, state.pause?.active, modal]);
  useEffect(() => {
    if (!line) setOpen(false);
  }, [!!line]);
  useEffect(() => {
    if (!open) return;
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    const outside = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  if (!state.operator.live && !state.pause?.active && !state.draft?.active) return html`<${NavigatorButton} store=${store} phone=${phone} />`;
  if (!line) return null;
  const paused = line.kind === 'paused';
  const agentName = line.agentName || (phone && line.kind === 'caption' && state.operator.status === 'speaking' ? state.operator.agentName : null);
  const agent = agentName && [...(state.agents || []), ...agentsOf(state.lists, state.now)].find((a) => a.name?.toLowerCase() === agentName.toLowerCase());
  const icon = paused ? html`<span class="pp-ic" aria-hidden="true"><i></i><i></i></span>`
    : agentName ? html`<${Tile} tile=${{ kind: 'agent', id: agent?.id || agentName.toLowerCase(), name: agentName }} store=${store} size=${phone ? 20 : 18} />`
    : line.kind === 'thinking' && !phone ? html`<span class="nx-vdots" aria-hidden="true"><i></i><i></i><i></i></span>` : html`<${Wave} />`;
  const resume = html`<button class="nx-vresume" disabled=${!line.pause?.canResume} onClick=${() => store.resumePause()}>${state.pausePending ? 'Resuming…' : 'Resume'}</button>`;
  const peek = !paused && freshCaption(session.arrival, Math.max(now, Date.now()), 4000);
  return html`<div class=${`nx-voice${open ? ' open' : ''}${phone ? ' phone' : ''}${paused ? ' paused' : ''}${line.kind === 'confirm' ? ' confirm' : ''}${line.kind === 'listening' || line.kind === 'drafting' ? ' quiet' : ''}`} ref=${root}>
    <div class="nx-vpill">
      <button class="nx-vtoggle" ref=${trigger} aria-label=${phone ? `Voice: ${line.text || 'latest caption'}` : 'Voice operator'} aria-expanded=${open} aria-controls="nx-voice-panel" onClick=${() => setOpen(!open)}>
        ${icon}${phone ? null : html`<span class="nx-vtext">${line.caption ? html`<${Caption} line=${line.caption} />` : line.kind === 'drafting' ? html`<span class="nx-vwho">Drafting to </span><b>${line.to}</b>` : paused ? html`<b>${line.pause.still ? 'Still paused' : 'Paused'}</b><span class="nx-vwho"> · ${line.pause.waiting} waiting</span>` : line.text}</span><svg class=${`nx-vchev${open ? ' open' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>`}
      </button>
      ${!phone && paused ? resume : null}
      ${phone && paused && line.pause.waiting ? html`<span class="nx-vbadge">${line.pause.waiting}</span>` : null}
    </div>
    ${phone && peek && !open ? html`<button class="nx-vpeek" onClick=${() => setOpen(true)}><${Caption} line=${peek} /></button>` : null}
    ${open ? html`
      ${phone ? html`<div class="nx-vscrim" onClick=${close}></div>` : null}
      <section id="nx-voice-panel" class="nx-vpanel" role="dialog" aria-label="Voice operator">
        ${phone ? html`<div class="nx-vgrab"></div>` : null}
        <${DraftCard} store=${store} phone=${phone} />
        ${paused ? html`<p class="note">${line.pause.title}</p>${phone ? resume : null}` : state.captions.length ? html`<h4>Latest</h4>${state.captions.slice(-4).map((c, i) => html`<p class="nx-vcap" key=${i}><${Caption} line=${c} /></p>`)}` : null}
        <h4>Say</h4><div class="nx-vhints">${HINTS[store.threadOpen() ? 'conversation' : 'active'].map((h) => html`<span>${h}</span>`)}</div>
      </section>` : null}
  </div>`;
}
