import { describe, expect, it } from 'vitest';
import { destinationAnswerKey, destinationDecisionPrompt, matchDestinationAnswer } from '../src/live/destination-ask.js';
import { unfinishedDecisionPrompt } from '../src/live/draft-mode.js';

describe('destination decision prompt', () => {
  const options = [{ threadId: '111', title: 'Bluetooth Speaker' }, { threadId: '222', title: 'Dock lines' }];

  it('offers main, each thread, cancel and unclear', () => {
    const prompt = destinationDecisionPrompt('the bluetooth one', 'Sierra', options);
    const answer = prompt.questions.answer;
    expect(answer.type === 'choice' && Object.keys(answer.criteria)).toEqual(['main', 'thread:111', 'thread:222', 'cancel', 'unclear']);
    expect(prompt.state).toEqual({ question: "Sierra's main chat, or the Bluetooth Speaker thread, or the Dock lines thread?", owner_reply: 'the bluetooth one' });
  });

  it('keys the matcher answer the same way', () => {
    expect(destinationAnswerKey(matchDestinationAnswer('the bluetooth speaker thread', options))).toBe('thread:111');
    expect(destinationAnswerKey(matchDestinationAnswer('main chat', options))).toBe('main');
    expect(destinationAnswerKey({ kind: 'unclear' })).toBe('unclear');
  });
});

describe('unfinished decision prompt', () => {
  it('asks one yes/no about the speech', () => {
    const prompt = unfinishedDecisionPrompt('so for the newsletter this week I want to');
    expect(prompt.state).toEqual({ dictation: 'so for the newsletter this week I want to' });
    expect(prompt.questions.unfinished.type).toBe('binary');
  });
});
