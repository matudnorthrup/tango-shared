// Hand-off asks have their own recorded state. A completion is a transition, never a reply.
import { html, useRef, useState } from '../vendor/preact-htm.js';
import { uuid } from './util.js';
import { linked } from './decision-links.js';
import { tripwireText } from './brief-model.js';

const TRIPWIRES = new Set(['identity', 'money', 'external-in-name', 'security-privacy', 'one-way-no-copy', 'precedent-conflict', 'surprise']);
const CLASS_TRIPWIRE = { 'credentials-identity': 'identity', 'act-on-behalf': 'external-in-name', spend: 'money', 'delete-no-copy': 'one-way-no-copy' };
const STATUS = { open: 'Open', done: 'Done', answered: 'Answered', resolved: 'Resolved', superseded: 'Superseded', withdrawn: 'Withdrawn', 'closed-by-done': 'Closed by Done', expired: 'Expired' };

// Short and local: "Jan 2, 4:00 AM", with the year only when it isn't this one.
function dueText(due) {
  const d = new Date(due);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}

export function AskCard({ ask, itemId, line = null, spaceId = null, store, places = null }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const commands = useRef({});
  const complete = async (step) => {
    const key = step || 'all';
    const commandId = commands.current[key] ||= uuid();
    try {
      await store.resolveAsk(ask, { itemId, line, spaceId, step, commandId });
      delete commands.current[key];
    } catch (err) {
      // A recorded failure is cached by command id; retry it with a fresh id.
      // An uncertain network outcome keeps its id so a landed completion is not repeated.
      if (err.definitive || (err.body && !err.body.unknown)) delete commands.current[key];
      throw err;
    }
  };
  // An old source has no recorded status. It can accept words, but never a guessed completion.
  const open = ask.status === 'open' || (!ask.id && !ask.status);
  const canDo = open && ask.kind === 'do' && !!ask.id && !ask.legacy;
  const label = ask.legacy ? 'Reply' : ({ do: 'To do', answer: 'Answer', unclear: 'Reply' }[ask.kind] || 'Reply');
  const tripwire = CLASS_TRIPWIRE[ask.class] || (TRIPWIRES.has(ask.class) ? ask.class : null);
  const steps = ask.steps || [];
  const remaining = steps.filter((s) => !s.done_at).length;
  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err.body?.error || err.message || 'That didn’t go through. Try again.'); }
    finally { setBusy(false); }
  };
  return html`<section class=${`rd-needs bc bc-plain ac${ask.status === 'open' ? ' your_move' : ''}`} aria-label=${`${label}: ${ask.text}`} data-ask-id=${ask.id || ''}>
    <div class="bc-top"><span class="bc-pill call">${label}</span>${ask.status && ask.status !== 'open' && STATUS[ask.status] ? html`<span class="bc-pill wait ac-status">${STATUS[ask.status]}</span>` : null}${tripwire ? html`<span class="bc-pill trip">${tripwireText(tripwire)}</span>` : null}${ask.due ? html`<span class=${`bc-pill ${Date.parse(ask.due) < Date.now() ? 'due' : 'wait'}`}>Due <time datetime=${ask.due}>${dueText(ask.due)}</time></span>` : null}</div>
    ${places}
    <p class="bc-ask">${linked(ask.text)}</p>
    ${steps.length ? html`<div class="ac-steps">
      <p class="bc-label">Steps · ${steps.filter((s) => s.done_at).length} of ${steps.length} done</p>
      <ul>${steps.map((step, index) => html`<li key=${index} class=${step.done_at ? 'done' : ''}><label><input type="checkbox" checked=${!!step.done_at} disabled=${!canDo || busy || !!step.done_at} onChange=${() => act(() => complete(String(index + 1)))}/><span class="ac-step">${step.text}</span>${canDo && !step.done_at && remaining === 1 ? html`<span class="ac-fin">Did it</span>` : null}</label></li>`)}</ul>
    </div>` : null}
    ${error ? html`<p class="ac-err" role="alert">${error}</p>` : null}
    ${open ? html`<form class="ac-reply reply" onSubmit=${(event) => { event.preventDefault(); if (reply.trim()) void act(async () => { await store.replyAsk(itemId, reply, { spaceId }); setReply(''); }); }}>
      <label class="ac-rl"><span class="bc-label">${canDo ? 'Only partly done? Say what happened' : 'Reply'}</span><textarea aria-label="Reply to this ask" rows="2" value=${reply} disabled=${busy} onInput=${(event) => setReply(event.currentTarget.value)} /></label>
      <div class="nx-chm-acts">
        ${canDo && !steps.length ? html`<button type="button" class="btn sm pri" disabled=${busy} onClick=${() => act(() => complete())}>Did it</button>` : null}
        <button class="btn sm" type="submit" disabled=${busy || !reply.trim()}>Send reply</button>
        <button type="button" class="btn sm ghost" disabled=${busy} onClick=${() => act(() => line && spaceId ? itemId ? store.openSnooze(itemId, { spaceId, line }) : store.chapterLine(spaceId, line, 'defer') : store.deferAsk(ask, { itemId, line, spaceId }))}>${line && spaceId ? 'Snooze' : 'Defer'}</button>
        <button type="button" class="btn sm ghost" onClick=${() => store.nextOpen(itemId)}>Open thread</button>
      </div>
    </form>` : null}
  </section>`;
}
