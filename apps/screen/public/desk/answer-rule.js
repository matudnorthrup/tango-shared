// Rule controls shared by pending proposals and answered full brief cards.
import { html, useEffect } from '../vendor/preact-htm.js';
import { ruleSavedView, ruleTapSpent } from './next/decided-model.js';

export const RULE_CHIPS = [
  ['always', 'Always do this'],
  ['next-time', 'Ask me next time'],
  ['once', 'Just this once'],
];

export function AnswerRule({ saved, store, proposalOnly = false }) {
  const tapped = store.state.ruleLocal?.[saved.decisionId];
  // Once the thread's copy moves on from what it said at the tap, the tap is spent: dropped, never shown again.
  const busy = !!store.state.ruleBusy?.[saved.decisionId];
  // Again when the request finishes: the thread's copy can arrive while it is still in flight.
  useEffect(() => { if (ruleTapSpent(saved, tapped)) store.dropRuleTap(saved.decisionId); }, [saved.choice, tapped, busy]);
  const { choice, standing, lapsed } = ruleSavedView(saved, store.state.ruleLocal?.[saved.decisionId]);
  const pending = !!store.state.ruleBusy?.[saved.decisionId];
  const ruleId = saved.ruleId || store.state.ruleMade?.[saved.decisionId];
  const entry = { decision: saved.decisionId, rule: ruleId, from: saved.choice };
  // D-61: the second similar approval proposes one rule for both; one tap makes it.
  const proposed = saved.proposal?.state === 'proposed' && !tapped && choice !== 'always' && choice !== 'next-time';
  if (proposalOnly && !proposed) return null;
  if (proposalOnly) {
    return html`<section class="rd-rule-saved rd-rule-proposed" aria-label="Proposed rule">
      <p><span class="note">You've made this call twice (${saved.proposal.from.join(', ')}) · </span>Proposed rule: <b>${saved.proposal.text}</b></p>
      <div class="rd-rule-acts">
        <button class="btn sm pri" disabled=${pending} onClick=${() => store.ruleDecided({ ...entry, proposal: saved.proposal.text }, 'always')}>Make it a rule</button>
        <button class="btn sm ghost" disabled=${pending} onClick=${() => store.ruleDecided(entry, 'once')}>Not now</button>
      </div>
    </section>`;
  }
  const headline = standing
    ? html`Saved as <b>${ruleId || 'a rule'}</b>${saved.choice === 'always' ? html`: ${saved.text}` : null}`
    : lapsed ? html`Always, but <b>${saved.ruleId}</b> is ${saved.ruleState} now: ${saved.text}`
    // Only an answer that counts (taken as recommended, its pair not already set aside) waits for a second call.
    : choice === 'once' ? (saved.precedent && saved.proposal?.state !== 'dismissed' ? html`Kept as a precedent, not a rule: a second similar call proposes one` : html`Just this once: not a rule`)
    : html`Not a rule: ask next time`;
  return html`<section class="rd-rule-saved" aria-label="How your answer counts">
    <p><span class="note">Decision ${saved.decisionId} · </span>${headline}
      ${standing ? html` · <button class="nx-link" disabled=${pending} onClick=${() => store.ruleDecided(entry, 'next-time')}>Undo</button>` : null}</p>
    <div class="sys-seg rd-rule-seg" role="group" aria-label="How it counts">
      ${RULE_CHIPS.map(([key, label]) => html`<button aria-pressed=${choice === key} disabled=${pending} onClick=${() => (choice !== key || (key === 'always' && lapsed)) && store.ruleDecided(key === 'always' && saved.proposal?.state === 'proposed' ? { ...entry, proposal: saved.proposal.text } : entry, key)}>${label}</button>`)}
    </div>
  </section>`;
}

