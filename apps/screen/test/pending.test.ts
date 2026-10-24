import { describe, expect, it } from 'vitest';
import { parseQuestions, validateAnswers } from '../server/desk/pending.js';
import type { PendingRequest } from '../server/desk/types.js';

const pending = (questions: unknown): PendingRequest => ({ kind: 'question', requestId: 'r', questions: parseQuestions(questions), question: '', options: [], at: 1 });
describe('shared pending questions', () => {
  it('requires every answer and rejects unknown ids or multiple single-select answers', () => {
    const p = pending([{ id: 'review', header: 'Reviewer', question: 'Who?', options: ['Lead', 'Peer'] }, { id: 'merge', header: 'Merge', question: 'Merge?', options: ['Yes', 'No'] }]);
    expect(validateAnswers(p, { review: 'Lead' })).toEqual({ error: 'no answer for "Merge"' });
    expect(validateAnswers(p, { review: 'Lead', merge: 'Yes', extra: 'x' })).toEqual({ error: 'unknown question "extra"' });
    expect(validateAnswers(p, { review: ['Lead', 'Peer'], merge: 'Yes' })).toEqual({ error: '"Reviewer" takes one answer' });
    expect(validateAnswers(p, { review: ' Someone else ', merge: ['No'] })).toEqual({ answers: { review: 'Someone else', merge: 'No' } });
  });
  it('honors strict options, deduplicates multiple selections, and ignores malformed questions', () => {
    const p = pending([{ id: 'tags', header: 'Tags', question: 'Labels?', multiSelect: true, allowCustomAnswer: false, options: ['bug', 'ui'] }]);
    expect(validateAnswers(p, { tags: ['bug', 'ui', 'bug'] })).toEqual({ answers: { tags: ['bug', 'ui'] } });
    expect(validateAnswers(p, { tags: ['docs'] })).toEqual({ error: '"Tags" takes one of its options only' });
    expect(parseQuestions([null, { question: 'No options', allowCustomAnswer: false }])).toEqual([]);
  });
});
