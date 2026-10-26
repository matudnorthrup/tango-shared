import { html, useEffect, useState } from '../vendor/preact-htm.js';

/** Held dictation uses an explicit destination picker; choosing never invokes the model. */
export function PhoneNote({ item }) {
  const note = item.facts?.phoneNote;
  const [choices, setChoices] = useState([]);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    if (note && !note.uncertain && item.disposition === 'active') {
      fetch('/api/desk/voice-note/destinations').then(async response => {
        const body = await response.json();
        if (!stopped) { setChoices(body.choices || []); if (!response.ok) setStatus(body.error); }
      }).catch(() => !stopped && setStatus('Destinations are unavailable. Your note is saved.'));
    }
    return () => { stopped = true; };
  }, [note?.noteId, note?.uncertain, item.disposition]);
  if (note?.sent) return html`<section class="rd-report" aria-label="Phone note sent"><h3>Phone note sent</h3><p>${note.sent}</p></section>`;
  if (!note || item.disposition !== 'active') return null;
  const send = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/desk/voice-note/${encodeURIComponent(note.noteId)}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const result = await response.json(); setStatus(result.say || result.error);
    } catch { setStatus('Could not confirm delivery. Refresh before sending again.'); }
    // An ambiguous network response must never enable another send here.
  };
  return html`<section class="rd-report" aria-label="Phone note destination">
    <h3>Phone note</h3>
    ${note.uncertain ? html`<p>Delivery is unconfirmed. Check the destination before sending this note again.</p>` : html`
      <div class="sx-ctl"><label class="sx-sel">Send to <select value=${key} disabled=${busy} onChange=${event => setKey(event.target.value)}>
        <option value="">Choose a destination</option>
        ${choices.map(choice => html`<option value=${choice.key}>${choice.destination.label}</option>`)}
      </select></label>
      <button class="btn pri" disabled=${busy || !key} onClick=${send}>Send note</button></div>`}
    ${status ? html`<p role="status">${status}</p>` : null}
  </section>`;
}
