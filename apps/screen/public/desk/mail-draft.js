import { html, useState } from '../vendor/preact-htm.js';
import { rowTitle } from './list-model.js';
import { age } from './util.js';
const SEND = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>`;
const DRAFT_WORDS = {
  draft: 'Draft · nothing is sent until you send it',
  queued: 'Waiting for it to be idle, then it’s sent',
  sending: 'Sending…',
  sent: 'Sent · waiting for its answer, which comes back here',
  answered: 'Answered',
  unanswered: 'No answer after three days',
  dropped: 'Not sent',
};

function Chip({ itemId, title, store }) {
  const item = store.state.byId[itemId];
  return html`<button class="cchip" onClick=${() => store.openItem(itemId)}><i></i>${item ? rowTitle(item) : title}</button>`;
}

export function DraftCard({ draft, project, store, onAction = null }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.text);
  // The edit box closes at the tap; the store shows the draft's new state at once (optimistic).
  const act = (action) => {
    const edited = editing ? text : undefined;
    setEditing(false);
    if (onAction) void onAction(action, edited);
    else void store.coordinatorDraft(project.id, draft.id, action, edited);
  };
  const open = draft.state === 'draft';
  return html`<div class=${`cp-draft is-${draft.state}`}>
    <div class="cp-dh">${SEND} ${open ? (onAction ? 'Message for' : 'Question for') : 'To'} <${Chip} itemId=${draft.toItemId} title=${draft.toTitle} store=${store} /></div>
    ${draft.error ? html`<div class="cp-derr">${draft.state === 'dropped' ? 'Not sent' : 'Didn’t send'}: ${draft.error}.${draft.state === 'draft' ? ' It may have gone through: check the conversation before sending again.' : ''}</div>` : null}
    ${editing ? html`<textarea class="cp-edit" value=${text} onInput=${(e) => setText(e.target.value)} rows="3"></textarea>` : html`<div class="cp-dt">${draft.text}</div>`}
    ${open
      ? html`<div class="cp-da">
          <button class="btn sm pri" disabled=${editing && !text.trim()} onClick=${() => act('send')}>${onAction ? 'Approve and send' : 'Send when it’s idle'}</button>
          ${onAction ? null : html`<button class="btn sm" disabled=${editing && !text.trim()} onClick=${() => act('now')}>Send now</button>`}
          ${editing ? null : html`<button class="btn sm ghost" onClick=${() => setEditing(true)}>Edit</button>`}
          <button class="btn sm ghost" onClick=${() => act('drop')}>Don’t send</button>
        </div>`
      : html`<div class=${`cp-ds ${draft.state}`}><i></i>${DRAFT_WORDS[draft.state] || draft.state}${draft.state === 'queued' ? html` <button class="linkish" onClick=${() => act('now')}>Send now</button> · <button class="linkish" onClick=${() => act('drop')}>Cancel</button>` : null}</div>`}
    ${draft.answer ? html`<div class="cp-relay"><div class="cp-rh">Answer · ${age(draft.answer.at, store.state.now)} ago</div><div class="cp-rq">${draft.answer.text}</div></div>` : null}
  </div>`;
}

