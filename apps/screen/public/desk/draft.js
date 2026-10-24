// The Draft card (voice draft mode): the owner is thinking out loud and the operator is holding
// every word until it's confirmed. It sits at the top of the Inbox.

import { html } from '../vendor/preact-htm.js';
import { draftView } from './draft-model.js';
import { agentColor } from './util.js';

function Buttons({ store, view, small }) {
  const pending = store.state.draftPending;
  return html`<div class="draft-actions">
    ${view.canSend ? html`<button class=${`btn pri${small ? ' sm' : ''}`} disabled=${!!pending} onClick=${() => store.draftCommand('send')}>${pending === 'send' ? 'Sending…' : 'Send'}</button>` : null}
    ${view.canUndo ? html`<button class=${`btn pri${small ? ' sm' : ''}`} disabled=${!!pending} onClick=${() => store.draftCommand('cancel')}>Undo · ${view.undoSeconds}s</button>` : null}
    ${view.canCancel ? html`<button class=${`btn${small ? ' sm' : ''}`} disabled=${!!pending} onClick=${() => store.draftCommand('cancel')}>Cancel</button>` : null}
    ${view.canDismiss ? html`<button class=${`btn ghost${small ? ' sm' : ''}`} onClick=${() => store.draftCommand('dismiss')}>Dismiss</button>` : null}
  </div>`;
}

export function DraftCard({ store, phone }) {
  const card = store.state.draft;
  const view = draftView(card, store.state.now);
  if (!view) return null;
  const color = card.target ? agentColor(card.target.agentId) : 'var(--fyi)';
  const live = card.active && (view.status === 'listening' || view.status === 'compiling');
  return html`<section class=${`draft draft-${view.status}${phone ? ' phone' : ''}`} style=${`--c:${color}`} aria-label="Draft" aria-live="polite">
    <header class="draft-h">
      <span class="dot" style=${`--c:${color}`}></span>
      <h2>${view.title}</h2>
      ${view.to && (view.status === 'confirm' || view.status === 'sending' || view.status === 'sent') ? html`<span class="draft-to">To: <b>${view.to}</b></span>` : null}
    </header>
    ${view.compiled && (view.status === 'confirm' || view.status === 'sending' || view.status === 'sent')
      ? html`<p class="draft-compiled">${view.compiled}</p>`
      : view.empty
        ? html`<p class="draft-text note">Listening… say the message the way it comes to you.</p>`
        : html`<p class="draft-text">${view.earlier.map((fragment) => html`<span class="frag">${fragment} </span>`)}${view.newest ? html`<span class="frag newest">${view.newest}</span>` : null}</p>`}
    ${view.question ? html`<p class="draft-q">${view.question}</p>` : null}
    ${view.note ? html`<p class="draft-note warn">${view.note}</p>` : null}
    <footer class="draft-f">
      ${view.hint ? html`<span class="note">${view.hint}</span>` : html`<span></span>`}
      <${Buttons} store=${store} view=${view} />
    </footer>
  </section>`;
}

