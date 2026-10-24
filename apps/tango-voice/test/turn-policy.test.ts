import { describe, expect, it } from 'vitest';
import { TurnPolicy, TURN } from '../src/turn/turn-policy.js';
import fixtures from './fixtures/turn-policy.json';

describe('shared turn policy fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const policy = new TurnPolicy({ ramble: fixture.ramble });
      for (const entry of fixture.steps) {
        if ('words' in entry) {
          for (const delta of Array.isArray(entry.words) ? entry.words : [entry.words]) {
            policy.words(delta!);
          }
        }
        const result = 'explicit' in entry && entry.explicit
          ? policy.explicitFinish()
          : policy.pause(entry.pause!.quietMs, entry.pause!.by as 'local' | 'model');
        expect(result).toEqual(entry.expected);
        if (result.kind === 'wait') expect(policy.mode()).toBe(result.mode);
      }
    });
  }
  it('keeps late deltas of one pause in one segment when asked', () => {
    const policy = new TurnPolicy();
    policy.words("I'm gonna ramble for a minute. Use blue."); policy.pause(1500, 'local');
    policy.words('Okay'); expect(policy.pause(1500, 'local').kind).toBe('wait');
    policy.words(' send', true); policy.pause(1500, 'local');
    policy.words(' it', true);
    expect(policy.pause(1500, 'local')).toEqual({ kind: 'finish', text: 'Use blue.' });
  });
  it('exports the agreed timing contract', () => {
    expect(TURN).toEqual({ pauseMs: 1500, unfinishedPauseMs: 4000, undoMs: 3000,
      rambleNudgeMs: 90_000, rambleCapMs: 600_000 });
  });
});
