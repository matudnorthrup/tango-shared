import { describe, expect, it } from 'vitest';
import type { DecisionShadow, DecisionShadowRun } from '@tango/core';
import { deskStepDecisionPrompt, fallbackSummary, withDecisionShadow, type DeskSummaryInput } from '../server/desk/summarize.js';

const input: DeskSummaryInput = {
  agentName: 'Sierra',
  place: 'Truck service',
  messages: [
    { author: 'owner', text: 'Can you find a slot for the truck?' },
    { author: 'agent', text: 'Should I book the Tuesday or the Thursday slot?' },
  ],
  previous: null,
};

function recorder(): DecisionShadow & { runs: DecisionShadowRun[] } {
  const runs: DecisionShadowRun[] = [];
  return { runs, run: (run) => void runs.push(run), flush: async () => {} };
}

describe('desk decision shadow', () => {
  it('shadows model summaries with the step and ack-only questions, and returns the summary unchanged', async () => {
    const shadow = recorder();
    const output = { ...fallbackSummary(input), step: 'your_move' as const, source: 'model' as const };
    const result = await withDecisionShadow(async () => output, shadow)(input);
    expect(result).toBe(output);
    expect(shadow.runs).toHaveLength(1);
    const run = shadow.runs[0]!;
    expect(run.site).toBe('desk.step');
    expect(run.incumbent).toEqual({ step: 'your_move', ackOnly: false });
    expect(run.agree?.({ step: 'your_move', ackOnly: true }, run.incumbent)).toBe(true);
    expect(run.agree?.({ step: 'fyi', ackOnly: false }, run.incumbent)).toBe(false);
    expect(run.compared).toEqual(['step']);
    expect(run.excerpt).toBe('Should I book the Tuesday or the Thursday slot?');
  });

  it('does not compare text fallbacks', async () => {
    const shadow = recorder();
    await withDecisionShadow(async () => fallbackSummary(input), shadow)(input);
    expect(shadow.runs).toHaveLength(0);
  });

  it("passes the owner's report rule to the decision model", () => {
    expect((deskStepDecisionPrompt({ ...input, kind: 'report' }).state as { owner_rule?: string }).owner_rule).toMatch(/recurring report/);
    expect((deskStepDecisionPrompt(input).state as { owner_rule?: string }).owner_rule).toBeUndefined();
  });

  it('sends the latest six messages and the earlier state', () => {
    const many = { ...input, previous: { step: 'your_move' as const, gist: 'Pick a slot', ask: 'Tuesday or Thursday?' }, messages: Array.from({ length: 9 }, (_, index) => ({ author: 'agent' as const, text: `m${index}` })) };
    const prompt = deskStepDecisionPrompt(many);
    const state = prompt.state as { messages: Array<{ text: string }>; earlier_state: string };
    expect(state.messages.map((message) => message.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    expect(state.earlier_state).toBe('your_move: Pick a slot Ask: Tuesday or Thursday?');
    expect(Object.keys(prompt.questions)).toEqual(['step', 'ackOnly']);
  });
});
