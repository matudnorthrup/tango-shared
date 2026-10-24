// A Loom thread blocked on the owner: a user-input request (one or several
// multiple-choice questions) or an approval. Pure helpers for the card, the
// Conversation view and the store; no DOM, so they are unit-tested directly.
//
// item.facts.pending = { kind: 'question' | 'approval', requestId,
//   questions: [{ id, header, question, options: [{ label, description }], multiSelect, allowCustomAnswer? }],
//   approval?: { options: [{ decision, label, warning? }], detail? }, dismissible?, question, options, at }
//
// A draft is the owner's picks so far, tied to one request id (a new request
// starts a fresh draft): { requestId, picks: { [questionId]: label[] }, other: { [questionId]: text }, otherOpen: { [questionId]: bool } }

/** The pending request the desk can show as questions or approval chips, or null. */
export function pendingOf(item) {
  const p = item?.facts?.pending;
  if (!p || item.nextStep !== 'your_move') return null;
  if (item.disposition && item.disposition !== 'active') return null;
  if (p.kind === 'question' && Array.isArray(p.questions) && p.questions.length) return p;
  if (p.kind === 'approval' && p.approval?.options?.length) return p;
  return null;
}

/** One question, one answer: plain chips, one tap sends it. */
export function isOneTap(p) {
  return !!p && p.kind === 'question' && p.questions.length === 1 && !p.questions[0].multiSelect;
}

export function isRecommended(label) {
  return /\(recommended\)/i.test(label || '');
}

/** Loom lets a question be dismissed only when the request says so (responseMode 'message'). */
export function canDismiss(p) {
  return !!p && p.kind === 'question' && !!p.requestId && p.dismissible === true;
}

/** Free text is allowed unless Loom says the question takes its options only. */
export function allowsOther(question) {
  return question.allowCustomAnswer !== false;
}

export function emptyDraft(p) {
  return { requestId: p?.requestId ?? null, picks: {}, other: {}, otherOpen: {} };
}

/** The draft for this request; a draft made for another request id is stale and starts over. */
export function currentDraft(p, draft) {
  return draft && p && draft.requestId === p.requestId ? draft : emptyDraft(p);
}

/** Taps a chip: a single-select question takes it (a second tap clears it); a multi-select toggles it. Clears free text. */
export function pick(draft, question, label) {
  const picked = draft.picks[question.id] || [];
  let next;
  if (question.multiSelect) next = picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label];
  else next = picked.length === 1 && picked[0] === label ? [] : [label];
  return { ...draft, picks: { ...draft.picks, [question.id]: next }, other: { ...draft.other, [question.id]: '' }, otherOpen: { ...draft.otherOpen, [question.id]: false } };
}

/** Opens or closes the "Other…" box for a question. */
export function toggleOther(draft, questionId) {
  return { ...draft, otherOpen: { ...draft.otherOpen, [questionId]: !draft.otherOpen[questionId] } };
}

/** Types a free-text answer; it replaces the chips picked for that question. */
export function setOther(draft, questionId, text) {
  return { ...draft, picks: text.trim() ? { ...draft.picks, [questionId]: [] } : draft.picks, other: { ...draft.other, [questionId]: text }, otherOpen: { ...draft.otherOpen, [questionId]: true } };
}

export function isPicked(draft, questionId, label) {
  return (draft.picks[questionId] || []).includes(label);
}

/** The answer Loom gets for one question: free text, else the label (labels for a multi-select). Null when unanswered. */
export function answerFor(question, draft) {
  const other = (draft.other[question.id] || '').trim();
  if (other && allowsOther(question)) return question.multiSelect ? [other] : other;
  const picked = draft.picks[question.id] || [];
  if (!picked.length) return null;
  return question.multiSelect ? picked : picked[0];
}

export function answeredCount(p, draft) {
  return p.questions.filter((question) => answerFor(question, draft) !== null).length;
}

/** `{ [questionId]: answer }` once every question has one, else null. */
export function answersFrom(p, draft) {
  const answers = {};
  for (const question of p.questions) {
    const answer = answerFor(question, draft);
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

/** "Reviewer: Both leads · Merge: Wait" (one question: just its answer), for the hold bar and toasts. */
export function describeAnswers(p, answers) {
  const text = (value) => (Array.isArray(value) ? value.join(', ') : String(value));
  if (p.questions.length === 1) return text(answers[p.questions[0].id]);
  return p.questions.map((question, index) => `${question.header || `Q${index + 1}`}: ${text(answers[question.id])}`).join(' · ');
}

/** Approve-ish decisions read as positive chips; decline/cancel as plain. */
export function approvalTone(decision) {
  return decision === 'accept' || decision === 'acceptForSession' || decision === 'acceptAlways' ? 'ok' : 'no';
}

/** The Conversation view's heading for a request: the one question, "N questions…", or what needs approval. */
export function pendingHeadline(p) {
  if (p.kind === 'approval') return p.approval?.detail ? `Approve? ${p.approval.detail}` : 'Loom is asking for approval';
  if (p.questions.length === 1) return p.questions[0].question;
  return `${p.questions.length} questions before it goes on`;
}

/** A respond/approve that failed because the request moved on: picking again is the fix, not a retry. */
export function questionChanged(command) {
  return !!command && (command.outcome?.changed === true || /question changed/i.test(command.error || ''));
}
