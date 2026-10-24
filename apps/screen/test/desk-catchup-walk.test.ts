import { describe, expect, it } from 'vitest';
import { catchupWalk, type WalkCard } from '../server/desk/catchup-walk.js';

// Catch me up by voice (docs/specs/catch-up.md, "Voice"): the focus card and map the page shows, read on the server.

const chapter = (spaceId: string, over: Record<string, unknown> = {}) => ({ spaceId, headline: null, status: null, state: 'news', moments: 0, needs: 0, smaller: 0, since: 100, lastAt: 200, backAt: null, ...over });
const line = (id: number, kind: string, at: number, over: Record<string, unknown> = {}) => ({ id, kind, at, moment: kind !== 'fyi', title: `line ${id}`, detail: null, briefId: null, itemId: null, decisionId: null, ...over });
const card = (lines: unknown[], over: Partial<WalkCard> = {}): WalkCard => ({ lines, waiting: [], view: { moments: [], titles: {} }, briefs: [], ...over }) as unknown as WalkCard;

describe('the catch-up walk', () => {
  const chapters = [
    chapter('project:desk', { needs: 1, moments: 2, smaller: 1, lastAt: 500, headline: 'The plan waits on you (TGO-12).' }),
    chapter('agent:sierra', { moments: 1, lastAt: 400 }),
    chapter('project:house', { smaller: 2, lastAt: 300 }),
  ];
  const cards: Record<string, WalkCard> = {
    'project:desk': card([line(1, 'shipped', 10), line(2, 'needs', 5, { briefId: 'D-9', itemId: 'loom:a' }), line(3, 'fyi', 20)], {
      view: { moments: [{ key: 'line:1', kind: 'shipped', title: 'x', ids: [1, 4], line: 1 }], titles: { 1: 'The search fix shipped' } } as never,
      briefs: [{ id: 'D-9', itemId: 'loom:a', ask: 'Approve the plan?', standing: null, options: [{ key: 'A', label: 'Approve', consequence: null, recommended: true, answer: 'A · Approve (Recommended)' }, { key: 'B', label: 'Hold', consequence: null, recommended: false, answer: 'B · Hold' }], defaultOption: 'A', vetoLeftMs: null, level: 2, revision: 3 }],
    }),
    'agent:sierra': card([line(21, 'decided', 30, { decisionId: 'D-4' })]),
    'project:house': card([line(41, 'fyi', 1), line(42, 'fyi', 2)]),
  };
  const read: string[] = [];
  const input = {
    chapters: chapters as never,
    card: (id: string) => (read.push(id), cards[id]!),
    projects: [{ id: 'desk', name: 'Desk' }, { id: 'house', name: 'House' }],
    agents: [{ id: 'sierra', name: 'Sierra' }],
  };

  it('the focus is the page\'s: a brief first, with its options and the recommended one; the map in the page\'s groups', () => {
    const walk = catchupWalk(input);
    expect(walk.focus).toMatchObject({ spaceId: 'project:desk', name: 'Desk', headline: 'The plan waits on you.', line: { id: 2, kind: 'needs', briefId: 'D-9', ids: [2] } });
    expect(walk.focus!.brief).toEqual({ ask: 'Approve the plan?', options: [{ key: 'A', label: 'Approve', recommended: true, answer: 'A · Approve (Recommended)', consequence: null }, { key: 'B', label: 'Hold', recommended: false, answer: 'B · Hold', consequence: null }], defaultOption: 'A', revision: 3, level: 2, tripwire: null, vetoLeftMs: null });
    expect(walk.map).toEqual({
      needs: [{ spaceId: 'project:desk', name: 'Desk', summary: '1 needs you · 1 to see · 1 small' }],
      look: [{ spaceId: 'agent:sierra', name: 'Sierra', summary: '1 to see' }],
      smaller: [{ spaceId: 'project:house', name: 'House', summary: '2 small' }],
    });
    expect(walk.left).toBe(3);
    // Only the spaces with moments are read.
    expect(read).not.toContain('project:house');
  });

  it('carries the shown plan and brief context without fetching another revision', () => {
    const plan = { updateIds: [1, 2, 3], revision: 'shown', line: 'Mark one finished thread done.' };
    const walk = catchupWalk({ ...input, card: (id) => ({ ...cards[id]!, plan, briefs: cards[id]!.briefs.map(b => ({ ...b, level: 3, tripwire: 'access', vetoLeftMs: 7200000, options: b.options.map(o => ({ ...o, consequence: 'Keeps the page short' })) })) }) });
    expect(walk.focus?.plan).toEqual(plan);
    expect(walk.focus?.brief).toMatchObject({ level: 3, tripwire: 'access', vetoLeftMs: 7200000, options: [expect.objectContaining({ consequence: 'Keeps the page short' }), expect.anything()] });
  });

  it('skips move on; a moment carries every line folded into it, in the writer\'s title; go to a space takes its first moment', () => {
    expect(catchupWalk(input, { skipped: [2] }).focus?.line).toMatchObject({ id: 1, ids: [1, 4], title: 'The search fix shipped' });
    expect(catchupWalk(input, { skipped: [2, 1] }).focus?.line).toMatchObject({ id: 21, decisionId: 'D-4' });
    expect(catchupWalk(input, { space: 'agent:sierra' }).focus?.line.id).toBe(21);
    // A space with nothing left to show falls back to the walk's own order.
    expect(catchupWalk(input, { space: 'project:house' }).focus?.line.id).toBe(2);
    expect(catchupWalk(input, { focus: 21 }).focus?.line.id).toBe(21);
    expect(catchupWalk(input, { skipped: [2, 1, 21] }).focus).toBeNull();
  });

  it('marks a rule event, so voice offers Got it on it and never Fine by me', () => {
    expect(catchupWalk(input, { focus: 21 }).focus?.line.rule).toBe(false);
    const ruled = { ...input, card: (id: string) => (id === 'agent:sierra' ? card([line(21, 'decided', 30, { decisionId: 'D-4', data: { ruleEvent: 'made' } })]) : cards[id]!) };
    expect(catchupWalk(ruled, { focus: 21 }).focus?.line).toMatchObject({ id: 21, rule: true });
  });
});
