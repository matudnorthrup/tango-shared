// The weekly Delegation review on the Inbox (docs/specs/decisions-and-delegation.md, phase 3): what the learning loop
// did this week. What agents decided for the owner is in each space's catch-up now (next/chapter.js, catch-up.md).

import { html, useEffect } from '../../vendor/preact-htm.js';
import { reviewView } from './decided-model.js';
import { linked } from '../decision-links.js';

/** Reads the review while mounted, again every minute. */
function useReview(store, everyMs = 60_000) {
  useEffect(() => {
    void store.loadReview();
    const t = setInterval(() => void store.loadReview(), everyMs);
    return () => clearInterval(t);
  }, []);
}

/** The weekly Delegation review: what the loop did this week. A review, not a gate: the rules are already live. */
export function ReviewCard({ store }) {
  useReview(store);
  const view = reviewView(store.state);
  if (!view) return null;
  return html`<section class="nx-decided nx-review" aria-label="Delegation review">
    <div class="nx-decided-h"><b>Delegation review</b><span class="note">the last 7 days</span></div>
    ${view.sections.map(
      ([name, lines]) => html`<div class="nx-dg" key=${name}>
        <h3 class="nx-dg-h">${name}<span class="n">${lines.length}</span></h3>
        ${lines.map((line, i) => html`<div class="nx-dd" key=${i}><p class="nx-dd-t">${linked(line)}</p></div>`)}
      </div>`,
    )}
    <div class="nx-decided-f"><button class="btn sm ghost" onClick=${() => store.seeReview()}>Got it, see you next week</button></div>
  </section>`;
}
