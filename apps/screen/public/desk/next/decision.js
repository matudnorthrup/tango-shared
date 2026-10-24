// A decision's brief page (TGO-1110): /decision/D-<n>, or any D-n link on the desk. The full brief card with its answer
// chips, rule chips and revision line, where it came from and who carries it, and, once closed, how it ended. It sits
// over the desk (a scrim and a sheet) and on a phone fills the screen, so the same page serves a deep link and a tap.

import { html, useEffect, useRef } from '../../vendor/preact-htm.js';
import { age } from '../util.js';
import { BriefRule } from '../conversation.js';
import { BriefCard, BriefPlaces, briefPending } from '../brief.js';

function Changes({ page, store }) {
  if (!page.changes?.length) return null;
  return html`<details class="rd-brief-bg rd-dsheet-changes"><summary>Revision ${page.revision}: ${page.changes.length} change${page.changes.length > 1 ? 's' : ''}</summary>
    <ul>${page.changes.map((c) => html`<li key=${c.revision}><b>Revision ${c.revision}</b> · ${age(c.at, store.state.now)} ago${c.by_title ? ` · ${c.by_title}` : ''}: ${c.what}${c.why ? html` <span class="note">Why: ${c.why}</span>` : ''}</li>`)}</ul>
  </details>`;
}

/** Where the brief was raised and who carries it: links to those threads, as on the card's row. */
function Places({ page, store }) {
  const carried = (page.carriedBy || []).filter((p) => p.itemId !== page.raisedOn?.itemId);
  return html`<${BriefPlaces} from=${page.raisedOn || null} carriedBy=${carried} open=${(itemId) => (store.closeDecision(), store.openItem(itemId))} />`;
}

/** The sheet body for a loaded decision. */
export function DecisionBody({ page, store }) {
  const pending = page.pending || briefPending({ ...page.brief, id: page.id, class: page.class, level: page.level, revision: page.revision }, page.ask, page.createdAt);
  const item = { id: page.raisedOn?.itemId || '', nextStep: 'your_move', facts: { name: page.raisedOn?.title } };
  const brief = pending.brief;
  return html`<${BriefCard} key=${page.id} item=${item} store=${store} pending=${pending} answer=${pending}
    status=${page.status} outcome=${page.outcome} savedRule=${page.savedRule}
    places=${html`<${Places} page=${page} store=${store} />`}
    answers=${item.id ? undefined : html`<p class="note">The thread this was raised on is gone; it can’t be answered here.</p>`}
    rule=${item.id && ['open', 'discussing'].includes(page.status) ? html`<${BriefRule} item=${item} store=${store} brief=${brief} pending=${pending} />` : null}/>
    <${Changes} page=${page} store=${store} />`;

}

export function DecisionSheet({ store, phone = false }) {
  const d = store.state.decisionPage;
  const id = d?.id;
  const answering = !!(d?.data?.raisedOn && store.state.holds[d.data.raisedOn.itemId]);
  // Kept current while it is up: an answer from another screen, or a revision, shows without a reload.
  useEffect(() => {
    if (!id) return undefined;
    const t = setInterval(() => store.loadDecision(id), 15_000);
    return () => clearInterval(t);
  }, [id]);
  // Right after the owner's answer, read it back so the outcome shows in place of the chips.
  useEffect(() => {
    if (!id || answering) return undefined;
    const t = setTimeout(() => store.loadDecision(id), 800);
    return () => clearTimeout(t);
  }, [id, answering]);
  const sheet = useRef(null);
  // The cursor moves into the sheet, off the box behind it.
  useEffect(() => {
    if (id) sheet.current?.focus();
  }, [id]);
  if (!d) return null;
  const close = () => store.closeDecision();
  const page = d.data;
  return html`<div class="rd-scrim rd-dsheet-scrim" onClick=${(e) => e.target === e.currentTarget && close()}>
    <div ref=${sheet} tabindex="-1" class=${`rd-modal rd-dsheet${phone ? ' phone' : ''}`} role="dialog" aria-modal="true" aria-label=${`Decision ${d.id}`} data-decision-page=${d.id}>
      <header>
        <div class="rd-mt"><h3>Decision brief</h3><div class="note">${!page && d.loading ? 'Loading…' : ''}</div></div>
        <button class="btn rd-x" onClick=${close}>Close <span class="kbd">esc</span></button>
      </header>
      <div class="rd-mbody">
        ${d.error ? html`<p class="note warn">${d.error}</p>` : null}
        ${page ? html`<${DecisionBody} page=${page} store=${store} />` : d.loading && !d.error ? html`<p class="note">Loading…</p>` : null}
      </div>
    </div>
  </div>`;
}
