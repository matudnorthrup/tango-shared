import type { DeskItemSummary, DeskPendingQuestion, DeskPendingRequest } from './desk-client.js';
import { resolvePointedChoice } from './task-extractor.js';

// A Loom thread waiting on the owner (docs/specs/agent-desk.md, facts.pending): a user-input
// request with one or several multiple-choice questions, or an approval. The operator reads
// it out question by question and turns spoken answers into a desk `respond` / `approve`:
// labels matched from what was said, free text where Loom takes it.

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';

/** The request the operator can read and answer, or null. */
export function pendingOf(item: Pick<DeskItemSummary, 'facts' | 'nextStep'> | null | undefined): DeskPendingRequest | null {
  const pending = item?.facts?.pending;
  if (!pending || item!.nextStep !== 'your_move') return null;
  if (pending.kind === 'question' && pending.questions?.length) return pending;
  if (pending.kind === 'approval' && pending.approval?.options?.length) return pending;
  return null;
}

/** One single-select question: "the first one" can answer it without the model. */
export function isSingleChoice(pending: DeskPendingRequest | null): boolean {
  return !!pending && pending.kind === 'question' && pending.questions.length === 1 && !pending.questions[0]!.multiSelect;
}

const RECOMMENDED = /\s*\(recommended\)\s*/i;
const spokenLabel = (label: string) => (RECOMMENDED.test(label) ? `${label.replace(RECOMMENDED, ' ').trim()} (recommended)` : label);

/** "Loom (tango · Fix the budget) is asking: Who reviews? — options: A (recommended), B. Then: Merge? — options: …" */
export function speakPending(who: string, pending: DeskPendingRequest): string {
  if (pending.kind === 'approval') {
    const options = (pending.approval?.options ?? []).map((option) => `${option.label}${option.warning ? ` (${option.warning})` : ''}`);
    return `${who} is asking for approval: ${pending.approval?.detail || pending.question} — options: ${options.join(', ')}.`;
  }
  const parts = pending.questions.map((question, index) => {
    const options = question.options.map((option) => spokenLabel(option.label));
    const lead = index === 0 ? `${who} is asking${pending.questions.length > 1 ? ` ${pending.questions.length} questions. First` : ''}: ` : index === pending.questions.length - 1 ? 'And last: ' : 'Next: ';
    return `${lead}${question.question}${options.length ? ` — options: ${options.join(', ')}` : ''}${question.multiSelect ? ' (any of them)' : ''}.`;
  });
  return parts.join(' ');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(RECOMMENDED, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FILLER = /^(?:(?:ok(?:ay)?|yeah|yes|um+|uh+|so|well|hmm|let'?s|lets|i'?ll|ill|we'?ll|i think|i guess|go with|pick|choose|take|do|use|answer|say|the answer is|its|it'?s)\s+)+/;

/** "the recommended one" / "whatever you recommend": the one label marked (Recommended). */
const SAYS_RECOMMENDED = /\b(?:recommended|recommend(?:ation)?|your (?:pick|suggestion)|what you suggest(?:ed)?)\b/;

/**
 * The label the owner meant for one question, from their words: exact label, an ordinal ("the
 * second one", "option two"), "the recommended one", or a unique partial match. Otherwise their
 * words as free text when the question takes it; null when it takes labels only.
 */
export type AnswerMatch = { answer: string; matched: boolean } | { ambiguous: string[] };

export function matchAnswer(question: DeskPendingQuestion, spoken: string): AnswerMatch | null {
  const words = spoken.trim();
  if (!words) return null;
  const labels = question.options.map((option) => option.label);
  const said = normalize(words).replace(FILLER, '').trim();
  const exact = labels.find((label) => normalize(label) === said);
  if (exact) return { answer: exact, matched: true };
  if (said.split(' ').length <= 6) {
    const pointed = resolvePointedChoice(said, labels);
    if (pointed) return { answer: pointed.label, matched: true };
    if (SAYS_RECOMMENDED.test(said)) {
      const recommended = labels.filter((label) => RECOMMENDED.test(label));
      if (recommended.length === 1) return { answer: recommended[0]!, matched: true };
    }
  }
  if (said.length > 2) {
    // Whole words first ("prompt lead" is "Prompt lead only", not "…prompt leads"), then substrings.
    const saidWords = said.split(' ');
    const byWords = labels.filter((label) => {
      const words = new Set(normalize(label).split(' '));
      return saidWords.every((word) => words.has(word));
    });
    const partial = byWords.length
      ? byWords
      : labels.filter((label) => {
          const core = normalize(label);
          return core.includes(said) || (core.length > 2 && said.includes(core));
        });
    if (partial.length === 1) return { answer: partial[0]!, matched: true };
    // "Storage" with two storage options: ask, never send the word as a free-text answer.
    if (partial.length > 1) return { ambiguous: partial };
  }
  if (question.allowCustomAnswer === false) return null;
  return { answer: words, matched: false };
}

/** Which question an extractor answer names: q1/q2…, "1", the question id, or its header. A lone question needs no name. */
export function resolveQuestion(pending: DeskPendingRequest, handle: string): DeskPendingQuestion | undefined {
  const questions = pending.questions;
  const key = handle.trim().toLowerCase();
  if (!key) return questions.length === 1 ? questions[0] : undefined;
  const index = /^q?(\d+)$/.exec(key);
  if (index) return questions[Number(index[1]) - 1];
  return questions.find((question) => question.id.toLowerCase() === key || question.header.toLowerCase() === key || question.question.toLowerCase() === key);
}

export interface BuiltAnswers {
  answers: Record<string, string | string[]>;
  /** Questions with no answer yet (ask the owner). */
  missing: DeskPendingQuestion[];
  /** Answers that matched nothing on a labels-only question, or several labels at once (`candidates`). */
  rejected: Array<{ question: DeskPendingQuestion; said: string; candidates?: string[] }>;
}

/** Turns spoken per-question answers into the desk's `answers`; several answers to a multi-select collect into a list. */
export function buildAnswers(pending: DeskPendingRequest, entries: Array<{ question: string; answer: string }>): BuiltAnswers {
  const collected = new Map<string, string[]>();
  const rejected: BuiltAnswers['rejected'] = [];
  for (const entry of entries) {
    const question = resolveQuestion(pending, entry.question);
    if (!question) continue;
    const match = matchAnswer(question, entry.answer);
    if (!match || 'ambiguous' in match) {
      rejected.push({ question, said: entry.answer, ...(match ? { candidates: match.ambiguous } : {}) });
      continue;
    }
    const list = collected.get(question.id) ?? [];
    if (!list.includes(match.answer)) list.push(match.answer);
    collected.set(question.id, question.multiSelect ? list : [match.answer]);
  }
  const answers: Record<string, string | string[]> = {};
  const missing: DeskPendingQuestion[] = [];
  for (const question of pending.questions) {
    const list = collected.get(question.id);
    if (!list?.length) {
      if (!rejected.some((entry) => entry.question.id === question.id)) missing.push(question);
      continue;
    }
    answers[question.id] = question.multiSelect ? list : list[0]!;
  }
  return { answers, missing, rejected };
}

/**
 * Answers given across several utterances: a multi-select question collects (deduped, in the
 * order said); a single-select question takes the latest answer.
 */
export function mergeAnswers(pending: DeskPendingRequest, kept: Record<string, string | string[]>, added: Record<string, string | string[]>): Record<string, string | string[]> {
  const merged = { ...kept };
  const asList = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
  for (const [id, value] of Object.entries(added)) {
    const question = pending.questions.find((candidate) => candidate.id === id);
    merged[id] = question?.multiSelect ? [...new Set([...asList(merged[id]), ...asList(value)])] : value;
  }
  return merged;
}

const APPROVE = /\b(?:approve|approved|accept|allow|yes|go ahead|do it|run it)\b/;
/** Scope words. A request for one scope never gets a broader decision than asked for. */
/** Session approval. "(Just) this time" and "(just) this once" count as session approval (owner decision on #388). */
const FOR_SESSION = /\b(?:(?:this|the|rest of the|for the) session|for now|for today|until (?:i|we) restart|(?:just |only )?this time|(?:just )?(?:this )?once|only once|one time)\b/;
const PERMANENT = /\b(?:always|from now on|every time|everytime|permanently|forever|for good)\b/;
const DECLINE = /\b(?:decline|deny|reject|no|don'?t|do not|refuse)\b/;
const CANCEL = /\b(?:cancel|stop|abort)\b/;

/**
 * The decision the owner's words ask for, offered or not: a no, a cancel, or an approval with its
 * scope. Null when the words don't say. Session wording wins over "always" when both appear
 * ("always allow it for this session"); "(just) this time" / "(just) this once" are session approval.
 */
export function requestedDecision(spoken: string): ApprovalDecision | null {
  // "Don't ask again" is permanent wording, not a no.
  const text = spoken.toLowerCase().replace(/\b(?:don'?t ask (?:me )?again|never ask(?: again)?)\b/g, ' always ');
  if (CANCEL.test(text)) return 'cancel';
  if (DECLINE.test(text)) return 'decline';
  if (FOR_SESSION.test(text)) return 'acceptForSession';
  if (PERMANENT.test(text)) return 'acceptAlways';
  if (APPROVE.test(text)) return 'accept';
  return null;
}

/**
 * The approval decision to send, if one of the offered ones fits. The owner's words win over a
 * model's `wanted` decision: "allow it for this session" is never sent as acceptAlways, whatever
 * the model said. A scope that isn't offered is a question for the owner (null), never a broader
 * stand-in.
 */
export function matchDecision(pending: DeskPendingRequest, spoken: string, wanted?: ApprovalDecision): ApprovalDecision | null {
  const offered = (pending.approval?.options ?? []).map((option) => option.decision as ApprovalDecision);
  const label = pending.approval?.options.find((option) => normalize(option.label) === normalize(spoken));
  if (label) return label.decision as ApprovalDecision;
  const said = requestedDecision(spoken);
  const target = said ?? wanted ?? null;
  if (!target) return null;
  if (offered.includes(target)) return target;
  // A cancel the request doesn't offer is still a no.
  return target === 'cancel' && offered.includes('decline') ? 'decline' : null;
}

/** The scope the owner asked for (their words, else the model's decision) when the request doesn't offer it. */
export function missingScope(pending: DeskPendingRequest, spoken: string, wanted?: ApprovalDecision): 'session' | 'permanent' | null {
  if (matchDecision(pending, spoken, wanted)) return null;
  const target = requestedDecision(spoken) ?? wanted ?? null;
  return target === 'acceptForSession' ? 'session' : target === 'acceptAlways' ? 'permanent' : null;
}

/** The owner's words in a sentence: "Reviewer: Storage lead only; Merge: Wait". */
export function describeAnswers(pending: DeskPendingRequest, answers: Record<string, string | string[]>): string {
  const text = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(', ') : (value ?? ''));
  if (pending.questions.length === 1) return text(answers[pending.questions[0]!.id]);
  return pending.questions.map((question, index) => `${question.header || `question ${index + 1}`}: ${text(answers[question.id])}`).join('; ');
}

/** A short spoken pick ("the first one", "option two", "the recommended one"), or null when it's more than that. */
const QUICK_PICK = /^(?:(?:ok(?:ay)?|yeah|yes|um|uh|so|let'?s|i'?ll|we'?ll|go with|pick|choose|take|do|use)\s+)*(?:the\s+)?(?:(first|second|third|fourth|last|middle|top|recommended)(?:\s+(?:one|option|choice))?|(?:option|number|choice)\s+(one|two|three|four|1|2|3|4))(?:\s+please)?$/;

export function quickPick(speech: string, pending: DeskPendingRequest): string | null {
  if (!isSingleChoice(pending)) return null;
  const text = speech.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!QUICK_PICK.test(text)) return null;
  const question = pending.questions[0]!;
  const digits: Record<string, string> = { '1': 'one', '2': 'two', '3': 'three', '4': 'four' };
  const match = matchAnswer(question, text.replace(/\b([1-4])\b/, (digit) => digits[digit]!));
  return match && 'answer' in match && match.matched ? match.answer : null;
}
