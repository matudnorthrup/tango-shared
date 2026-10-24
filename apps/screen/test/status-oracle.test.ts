import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readAsk } from '../server/desk/asks.js';
import { deriveNextStep, type StepInput } from '../server/desk/next-step.js';
import { deskStatus, type Pill } from '../server/desk/status.js';

// Replay the scrubbed October 18 rows under the accepted October 20 fact contract.
// Old move/ask-kind judgments in the fixture remain historical data.
interface OracleCase {
  id: string;
  source: 't3' | 'loom' | 'discord';
  row: { conversationKey: string };
  input: StepInput & { seen: 'new' | 'seen' | 'updated' };
}
const oracle = JSON.parse(readFileSync(new URL('./fixtures/status-oracle.json', import.meta.url), 'utf8')) as { cases: OracleCase[] };

// Only recorded asks count; retired T3 closing prose cannot reopen an owner ask.
const needs = new Set([30, 31, 32, 33, 34, 39, 40, 46, 48]);
// Linked context-only PRs (16/17) no longer create a wait without ownership or a watch.
const waiting = new Set([6, 15, 18]);
const working = new Set([20, 21]);

describe('status oracle: historical rows replayed from recorded facts', () => {
  for (const [index, c] of oracle.cases.entries()) {
    it(`${c.id} · ${c.source}: facts decide the pill and opening only clears unread`, () => {
      // The scrubber collapsed per-PR URLs; restore the branch identity where its number agrees.
      const facts = { ...c.input.facts };
      facts.prReviews = facts.prReviews?.map(pr => pr.number === facts.pullRequest?.number ? { ...pr, url: facts.pullRequest.url } : pr);
      facts.prChecksAll = facts.prChecksAll?.map(pr => pr.number === facts.pullRequest?.number ? { ...pr, url: facts.pullRequest.url } : pr);
      const input = { ...c.input, facts, handoff: c.source === 't3' ? c.input.handoff : null };
      const result = deriveNextStep(input);
      const askRecord = readAsk(result, input, c.row);
      const item = { source: c.source, facts: input.facts, nextStep: result.step, nextStepBasis: result.basis, seen: input.seen, askRecord, lastOwnerMessageAt: input.lastOwnerMessageAt };
      const pill: Pill = needs.has(index + 1) ? 'needs' : waiting.has(index + 1) ? 'waiting' : working.has(index + 1) ? 'working' : 'idle';
      expect(deskStatus(item, input.now)).toMatchObject({ pill, countsForOwner: pill === 'needs', unread: input.seen !== 'seen' });
      expect(deskStatus({ ...item, seen: 'seen' }, input.now)).toMatchObject({ pill, countsForOwner: pill === 'needs', unread: false });
      expect(result.step).toBe(pill === 'needs' ? 'your_move' : pill === 'waiting' ? 'watching' : pill === 'working' ? 'working' : 'fyi');
    });
  }
});

describe('summaries during background work', () => {
  for (const background of ['working', 'monitoring'] as const) {
    for (const askKind of ['decision', 'todo'] as const) {
      it(`${background}: a summary's ${askKind} never records an owner move`, () => {
        const input = { facts: { contentKey: 'new', background }, summary: { contentKey: 'new', step: 'your_move', ask: 'Choose a layout', options: [], askKind }, lastAgentAt: 200, lastOwnerMessageAt: 100, lastActivityAt: 200, now: 300, fallbackStep: 'fyi' } as const;
        const result = deriveNextStep(input as never);
        expect(readAsk(result, input as never, { conversationKey: 'test' })).toBeNull();
        expect(deskStatus({ facts: input.facts, seen: 'new' }, 300)).toMatchObject({ pill: background === 'working' ? 'working' : 'waiting', countsForOwner: false });
        const facts = { ...input.facts, openAsk: { text: 'Choose a layout', at: 200 } };
        expect(deskStatus({ facts, seen: 'new' }, 300)).toMatchObject({ pill: 'needs', stillWorking: background === 'working', countsForOwner: true });
      });
    }
  }
});
