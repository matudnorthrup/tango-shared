import { describe, expect, it } from 'vitest';
import { createVoiceSummarizer } from '../src/live/task-extractor.js';
import type { ResponsesCaller } from '../src/live/responses-caller.js';
import { STILL_RUNNING_TEXT } from '../src/live/agent-backend.js';
import { askedDirective, boundQuestion } from '../src/live/live-operator.js';

describe('createVoiceSummarizer', () => {
  it('gives the summarizer the question so the condensed reply answers it', async () => {
    const calls: Parameters<ResponsesCaller>[0][] = [];
    const call = (async (request) => {
      calls.push(request);
      return 'Short answer.';
    }) as ResponsesCaller;
    const summarize = createVoiceSummarizer(call);
    expect(await summarize('sierra', 'A long reply.', 'Does the sub output matter? Is 5V better than 4V?')).toBe('Short answer.');
    expect(calls[0].instructions).toContain('answer every part of it first');
    expect(calls[0].input[0].text).toBe('Question: Does the sub output matter? Is 5V better than 4V?\n\nReply:\nA long reply.');
  });

  it('condenses without a question as before', async () => {
    const calls: Parameters<ResponsesCaller>[0][] = [];
    const summarize = createVoiceSummarizer((async (request) => {
      calls.push(request);
      return 'Gist.';
    }) as ResponsesCaller);
    await summarize('sierra', 'A long reply.');
    expect(calls[0].instructions).toContain('at most four short sentences');
    // An offer ("say the word and I'll search your Downloads folder") is kept like a question (10/10).
    expect(calls[0].instructions).toContain('otherwise, if it offers to do something next');
    expect(calls[0].input[0].text).toBe('A long reply.');
  });
});

describe('askedDirective', () => {
  it('asks for every part of the question on a finished answer', () => {
    expect(askedDirective({ kind: 'result', text: 'Both work.' }, 'Does A work? Does B?')).toContain('Answer every part of that aloud');
  });

  it('prefers the merged message the agent actually answered', () => {
    expect(askedDirective({ kind: 'result', text: 'Done.', asked: 'add Costco\n\nand lunch' }, 'and lunch')).toContain('"add Costco and lunch"');
  });

  it("relays an agent's question without answering for the user", () => {
    expect(askedDirective({ kind: 'question', text: 'Tuesday or Wednesday?' }, 'Book the dentist')).toContain('then ask its question');
  });

  it('adds nothing to status notices', () => {
    expect(askedDirective({ kind: 'result', text: STILL_RUNNING_TEXT }, 'Plan the trip')).toBe('');
    expect(askedDirective({ kind: 'result', text: 'I hit an error on that and could not finish it.' }, 'Plan the trip')).toBe('');
  });
});

describe('boundQuestion', () => {
  const context = 'We looked at speakers last week and the installer had thoughts. '.repeat(15);

  it('keeps the end of a long request, where the asks are, at a word boundary', () => {
    const bounded = boundQuestion(`${context}List the prices. Does 5.0 V beat 4.0 V, e.g. for a 12-inch sub?`);
    expect(bounded.startsWith('…')).toBe(true);
    expect(bounded.length).toBeLessThanOrEqual(701);
    expect(bounded).toContain('List the prices. Does 5.0 V beat 4.0 V, e.g. for a 12-inch sub?');
    expect(bounded.slice(1)).toMatch(/^\S/);
  });

  it('drops "leave out what was not asked" when the question was clipped', () => {
    expect(askedDirective({ kind: 'result', text: 'Prices…' }, `${context}Which should I buy?`)).not.toContain('leave out');
  });

  it('leaves a normal question alone', () => {
    expect(boundQuestion('Is it mainly the screen?')).toBe('Is it mainly the screen?');
  });
});
