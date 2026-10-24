import type { ApprovalDecision, PendingQuestion, PendingRequest } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The questions of a user-input request, the way source validates them (a question needs options unless free text is allowed). */
export function parseQuestions(value: unknown): PendingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index): PendingQuestion[] => {
    if (!isRecord(raw)) return [];
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .map((option) => (typeof option === 'string' ? { label: option.trim(), description: '' } : isRecord(option) ? { label: str(option.label), description: str(option.description) } : null))
      .filter((option): option is { label: string; description: string } => option !== null && option.label !== '');
    if (options.length === 0 && raw.allowCustomAnswer === false) return [];
    const question = str(raw.question) || str(raw.header);
    return [
      {
        id: str(raw.id) || question || `q${index + 1}`,
        header: str(raw.header),
        question,
        options,
        multiSelect: raw.multiSelect === true,
        ...(typeof raw.allowCustomAnswer === 'boolean' ? { allowCustomAnswer: raw.allowCustomAnswer } : {}),
      },
    ];
  });
}

/** The source answer for one question: a label or free text, or labels for a multi-select. */
export type PendingAnswer = string | string[];

/**
 * Checks answers against the request: one per question, known question ids only, offered labels
 * where source takes no free text, one answer for a single-select. Returns them as source takes them.
 */
export function validateAnswers(pending: PendingRequest, raw: unknown): { answers: Record<string, PendingAnswer> } | { error: string } {
  if (!isRecord(raw)) return { error: 'answers must be an object keyed by question id' };
  const known = new Set(pending.questions.map((question) => question.id));
  for (const key of Object.keys(raw)) if (!known.has(key)) return { error: `unknown question "${key.slice(0, 80)}"` };
  const answers: Record<string, PendingAnswer> = {};
  for (const question of pending.questions) {
    const value = raw[question.id];
    const list = [...new Set((Array.isArray(value) ? value : [value]).map(str).filter(Boolean))];
    const name = question.header || question.question.slice(0, 60);
    if (list.length === 0) return { error: `no answer for "${name}"` };
    const labels = new Set(question.options.map((option) => option.label));
    if (question.allowCustomAnswer === false && list.some((entry) => !labels.has(entry))) return { error: `"${name}" takes one of its options only` };
    if (question.multiSelect) answers[question.id] = list;
    else if (list.length > 1) return { error: `"${name}" takes one answer` };
    else answers[question.id] = list[0]!;
  }
  return { answers };
}

/** How an answered decision brief counts (decisions phase 3): Always do this, Ask me next time, Just this once. */
export type BriefRuleChoice = 'always' | 'next-time' | 'once';
export const BRIEF_RULE_CHOICES: readonly BriefRuleChoice[] = ['always', 'next-time', 'once'];

/** What the owner sends back to a pending source request. */
export type PendingResolution =
  /** `revision`: a decision brief's revision the owner answered (TGO-1079); an answer to an older one is refused. */
  | { kind: 'respond'; requestId: string; answers: Record<string, PendingAnswer>; rule?: BriefRuleChoice; reason?: string; revision?: number }
  | { kind: 'approve'; requestId: string; decision: ApprovalDecision }
  | { kind: 'dismiss'; requestId: string };

/** The request changed between the owner seeing it and answering it. */
export const QUESTION_CHANGED = 'the question changed';

