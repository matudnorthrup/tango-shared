import { describe, expect, it } from 'vitest';
import { resolveDraftDestination, type DraftCompileResult, type DraftContext, type DraftDestinationState } from '../src/live/draft-mode.js';

const agents = [{ id: 'sierra', name: 'Sierra', role: 'research' }];
const context: DraftContext = {
  input: { agents, tasks: [], threads: [], transcript: [], now: 0, loomRepos: ['tango'], startPlace: null },
  resolveItem: () => null,
};
const state: DraftDestinationState = {
  agents, startSpeech: '', fragments: [], clarifications: [], newLoom: false, newThread: false,
  targetItem: null, target: null,
};
const result: DraftCompileResult = {
  message: 'Check the quote.', agentId: null, item: null, threadId: null, newThreadTitle: null, questions: [],
};

describe('shared draft destination resolver', () => {
  it('leaves a phone note without a target unresolved', () => {
    expect(resolveDraftDestination(result, context, state)).toEqual({ destination: null, usedNamed: false });
  });

  it('rejects an offered repo that was not spoken, and accepts it in an answer', () => {
    const compiled = { ...result, newLoomRepo: 'TANGO' };
    expect(resolveDraftDestination(compiled, context, state).destination).toBeNull();
    expect(resolveDraftDestination(compiled, context, {
      ...state, clarifications: [{ question: 'Which repo?', answer: 'tango' }],
    }).destination).toMatchObject({ kind: 'new_loom', repo: 'tango' });
  });

  it('returns named-item tracking without mutating the caller', () => {
    const named = { id: 'loom:example', agentId: 'loom', agentName: 'Loom', place: 'Quote', threadId: null, isAgent: false };
    const input = { ...state, targetItem: named };
    const before = structuredClone(input);
    expect(resolveDraftDestination(result, context, input)).toMatchObject({
      destination: { kind: 'item', itemId: named.id }, usedNamed: true,
    });
    expect(input).toEqual(before);
    expect(resolveDraftDestination({ ...result, agentId: 'sierra' }, context, input)).toMatchObject({
      destination: { kind: 'home', agentId: 'sierra' }, usedNamed: false,
    });
  });

  it('preserves the operator screen-place fallback and early-branch tracking', () => {
    const placed: DraftContext = { ...context, input: { ...context.input, startPlace: { from: 'project', repo: 'tango', projectId: 'project-example' } } };
    const resolution = resolveDraftDestination(result, placed, { ...state, newLoom: true });
    expect(resolution.destination).toMatchObject({ kind: 'new_loom', inferred: true, projectId: 'project-example' });
    expect(resolution).not.toHaveProperty('usedNamed');
  });
});
