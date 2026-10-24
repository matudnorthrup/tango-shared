import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { className, reviewView, ruleSavedView, ruleTag, ruleTapSpent } from '../public/desk/next/decided-model.js';

describe('the delegation loop on the desk', () => {
  it('names a class and tags a rule change in the owner\'s terms', () => {
    expect(className('merge-when-green')).toBe('Merge when green');
    expect(ruleTag({ kind: 'rule-created' })).toBe('New rule');
    expect(ruleTag({ kind: 'class-demoted' })).toBe('Asks more');
  });

  it('the weekly review shows only when due, its empty sections left out, until Seen at the tap', () => {
    const review = { since: 0, until: 1, created: [{ text: 'R-4: for x, y' }], suspended: [], demoted: [], due: [], dissent: [{ class: 'merge-when-green', rule: null, count: 2, notes: [{ text: 'too soon' }] }] };
    const view = reviewView({ review: { data: { due: true, review } } })!;
    expect(view.sections).toEqual([['Rules created', ['R-4: for x, y']], ['Recurring dissent', ['Merge when green: 2 times · “too soon”']]]);
    expect(reviewView({ review: { data: { due: false, review } } })).toBeNull();
    expect(reviewView({ review: { data: { due: true, review } }, reviewSeenLocal: true })).toBeNull();
  });

  it("the answered brief's rule line: a tap shows until the thread moves on; a lapsed Always isn't 'ask next time'", () => {
    const saved = (over: Record<string, unknown> = {}) => ({ decisionId: 'D-5', choice: 'always', ruleId: 'R-1', ruleState: 'active', text: 'x', at: 1, ...over });
    expect(ruleSavedView(saved(), undefined)).toEqual({ choice: 'always', standing: true, lapsed: false });
    // Tapped Ask me next time: shown at once, while the thread still says always.
    expect(ruleSavedView(saved(), { rule: 'next-time', from: 'always' })).toMatchObject({ choice: 'next-time', standing: false });
    // The thread caught up, then another window chose Always again: the thread's copy wins over the old tap.
    expect(ruleSavedView(saved({ choice: 'next-time', ruleState: 'retired' }), { rule: 'next-time', from: 'always' })).toMatchObject({ choice: 'next-time' });
    expect(ruleSavedView(saved({ choice: 'always' }), { rule: 'next-time', from: 'always' }).choice).toBe('next-time');
    expect(ruleSavedView(saved({ choice: 'once' }), { rule: 'next-time', from: 'always' }).choice).toBe('once');
    // Always whose rule was suspended or retired for its own reasons.
    expect(ruleSavedView(saved({ ruleState: 'suspended' }), undefined)).toEqual({ choice: 'always', standing: false, lapsed: true });
    // Spent once the thread's copy moves on (dropped then), so always -> next-time -> always elsewhere can't revive it.
    expect(ruleTapSpent(saved(), { rule: 'next-time', from: 'always' })).toBe(false);
    expect(ruleTapSpent(saved({ choice: 'next-time' }), { rule: 'next-time', from: 'always' })).toBe(true);
    expect(ruleTapSpent(saved(), undefined)).toBe(false);
  });
});
