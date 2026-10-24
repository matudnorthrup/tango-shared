// The delegation loop in the owner's terms (docs/specs/decisions-and-delegation.md): a class's name, a rule change's
// tag and chips, and the weekly review. Pure, so the tests read it without a page.

/** A board class in words: "merge-when-green" → "Merge when green". */
export function className(cls) {
  const words = String(cls || '').replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Other';
}

/** The chips on a new rule's line: how the answer that made it counts. */
export const RULE_CHOICES = [
  ['always', 'Always do this'],
  ['next-time', 'Ask me next time'],
  ['once', 'Just this once'],
];

/** A rule change's tag, in the owner's terms. */
export function ruleTag(e) {
  return { 'rule-created': 'New rule', 'rule-suspended': 'Rule suspended', 'rule-retired': 'Rule retired', 'rule-withdrawn': 'Rule withdrawn', 'rule-superseded': 'Rule superseded', 'rule-restored': 'Rule restored', 'rule-reaffirmed': 'Approved again', 'class-demoted': 'Asks more', 'class-restored': 'Trusted again' }[e.kind] || 'Rule';
}

/** The weekly Delegation review, when it is due and not put away at the tap; null otherwise. */
export function reviewView(state) {
  const data = state.review?.data;
  if (!data?.due || state.reviewSeenLocal) return null;
  const r = data.review;
  const sections = [
    ['Rules created', r.created.map((e) => e.text)],
    ['Suspended or retired', r.suspended.map((e) => e.text)],
    ['Demoted or restored', r.demoted.map((e) => e.text)],
    ['Due for review', r.due.map((rule) => `${rule.id}: for ${rule.scope}, ${rule.do}`)],
    ['Recurring dissent', r.dissent.map((d) => `${d.rule || className(d.class)}: ${d.count} times · “${d.notes.at(-1)?.text ?? ''}”`)],
  ].filter(([, lines]) => lines.length);
  return sections.length ? { sections, since: r.since } : null;
}

/**
 * The answered brief's rule line (answer-rule.js AnswerRule): the choice to show, and whether its rule stands. A tap
 * (`tapped`: { rule, from }) shows until the thread's copy moves on from what it said at the tap (`from`); after that
 * the thread's copy wins, so a change made elsewhere shows too. Always whose rule stopped standing for a reason of
 * its own (a reversal, unused, a later ruling) is `lapsed`, not "ask next time".
 */
/** Whether a tap is spent: the thread's copy has moved on from what it said at the tap, so the tap never shows again. */
export function ruleTapSpent(saved, tapped) {
  return !!tapped && tapped.from !== saved.choice;
}

export function ruleSavedView(saved, tapped) {
  const choice = tapped && tapped.from === saved.choice && tapped.rule !== saved.choice ? tapped.rule : saved.choice;
  const standing = choice === 'always' && (choice !== saved.choice || saved.ruleState === 'active' || !saved.ruleState);
  return { choice, standing, lapsed: choice === 'always' && !standing };
}
