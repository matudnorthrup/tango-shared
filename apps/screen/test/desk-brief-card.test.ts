import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
// @ts-expect-error plain browser module, no types
import { supportingSummary, activeLeft, KIND_CLASSES, assetKind, dueText, kindText, optionRow, receiptRows, revisionText, statusPill, summaryLine, tripwireText } from '../public/desk/brief-model.js';
// @ts-expect-error plain browser module, no types
import { age } from '../public/desk/util.js';

// The decision brief card in plain words (TGO-1080, R-12): no level numbers or board codes reach the owner.

const MIN = 60_000;
const HOUR = 60 * MIN;
const brief = (over: Record<string, unknown> = {}) => ({
  id: 'D-9', class: 'product-choice-in-scope', level: 2, candidate: true, door: 'two-way', blast: 'private', tripwire: null,
  standing: 's', background: 'b', assets: [], deadline: null, defaultOption: null, vetoLeftMs: null, proposedRule: null,
  confidence: 'high', changeMyMind: null, ...over,
});

describe('the brief card in plain words', () => {
  it('says who decides: your call, waits for you, or a level 3 countdown from the veto time left', () => {
    expect(statusPill(brief({ level: 1 }))).toEqual({ kind: 'call', text: 'Your call' });
    expect(statusPill(brief({ level: 2 }))).toEqual({ kind: 'wait', text: 'Recommend · waits for you' });
    const timer = statusPill(brief({ level: 3, defaultOption: 'A', vetoLeftMs: 2 * HOUR + 11 * MIN }));
    expect(timer).toMatchObject({ kind: 'timer', text: 'Goes ahead in 2h 11m unless you say otherwise' });
    expect(timer.fraction).toBeCloseTo((2 * HOUR + 11 * MIN) / (4 * HOUR));
    // A level 3 with no default never runs on its own: the owner's call.
    expect(statusPill(brief({ level: 3 })).kind).toBe('call');
    // The ring is the share of the window Loom reports (the board's veto_window), not a fixed 4 hours.
    expect(statusPill(brief({ level: 3, defaultOption: 'A', vetoLeftMs: 2 * HOUR, vetoWindowMs: 8 * HOUR })).fraction).toBeCloseTo(0.25);
    expect(activeLeft(40 * MIN)).toBe('40m');
    expect(activeLeft(30_000)).toBe('a minute');
  });

  it('names every board tripwire in plain words, and an unknown one without its code', () => {
    expect(['identity', 'money', 'external-in-name', 'security-privacy', 'one-way-no-copy', 'precedent-conflict', 'surprise'].map(tripwireText)).toEqual([
      'Needs your sign-in', 'Spends money', 'Acts in your name', 'Touches security or privacy', "Can't be undone", 'Two of your rules conflict', 'Might surprise you',
    ]);
    expect(tripwireText(null)).toBeNull();
    expect(tripwireText('new-wire')).toBe('Needs you: new wire');
    expect(kindText('credentials-identity')).toBe('Sign-ins and credentials');
    expect(kindText('some-new-class')).toBe('Some new class');
    // Every class on the board has its own words (Codex review on #819).
    const board = load(readFileSync(resolve(import.meta.dirname, '../../../config/decisions/board.yaml'), 'utf8')) as { classes: Record<string, unknown> };
    expect(KIND_CLASSES).toEqual(expect.arrayContaining(Object.keys(board.classes)));
    expect(kindText('ops-shared-prod')).toBe('A system other people use');
  });

  it('keeps the due pill short; the whole deadline is in Details', () => {
    expect(dueText("Within about 1 h, when Time Machine's automatic run restarts the backup.")).toBe('Within about 1 h');
    expect(dueText('Friday')).toBe('Friday');
    expect(dueText(null)).toBeNull();
    expect(dueText('x'.repeat(80))).toHaveLength(48);
  });

  it('folds the facts into one line: undo, reach, raised and updated', () => {
    const now = 10 * HOUR;
    expect(summaryLine(brief(), now - 6 * MIN, now, age)).toBe('Reversible · only affects you · raised 6m ago');
    expect(summaryLine(brief({ door: 'one-way', blast: 'team', updated: { at: now - 30_000, what: 'w', why: 'y' } }), now - 3 * HOUR, now, age)).toBe('Hard to undo · affects the team · raised 3h ago · updated just now');
  });

  it('the receipt carries every fact, the threads included, and drops what the brief lacks', () => {
    const now = 10 * HOUR;
    const rows = Object.fromEntries(receiptRows(brief({ level: 3, defaultOption: 'A', revision: 2, updated: { at: now - 10 * MIN, what: 'w', why: 'y' }, from: { itemId: 'w', title: 'Worker' }, deadline: 'Friday' }), { at: now - HOUR, now, age, here: 'Lead', defaultLabel: 'A · Ship' }));
    expect(rows).toMatchObject({
      Decision: 'D-9', Kind: 'Product choice in approved work', 'Who decides': 'Goes ahead unless you say otherwise', "If you don't answer": 'A · Ship goes ahead',
      Undo: 'Reversible', Affects: 'Only you', 'Raised in': 'Worker', 'Shown by': 'Lead', Raised: '1h ago', Updated: '10m ago', Version: '2nd', 'Needed by': 'Friday',
    });
    const own = Object.fromEntries(receiptRows(brief({ level: 1, tripwire: 'money', confidence: null }), { now, age, here: 'Worker', carriedBy: { itemId: 'l', title: 'Lead' } }));
    expect(own).toMatchObject({ 'Raised in': 'Worker', 'Shown by': 'Lead', "If you don't answer": 'Nothing happens', 'Needs you because': 'Spends money', Updated: 'Not since' });
    expect(own).not.toHaveProperty('Confidence');
    expect(own).not.toHaveProperty('Raised');
  });

  it('reads an option row from its label: key, words, recommended, and whether it runs without an answer', () => {
    const l3 = brief({ level: 3, defaultOption: 'A' });
    expect(optionRow({ label: 'A · Ship it (Recommended)', description: 'All of it' }, l3)).toEqual({ key: 'A', title: 'Ship it', recommended: true, isDefault: true, consequence: 'All of it', label: 'A · Ship it (Recommended)' });
    expect(optionRow({ label: 'B · Wait', description: '' }, l3)).toMatchObject({ key: 'B', title: 'Wait', recommended: false, isDefault: false });
    expect(optionRow({ label: 'A · Ship it (Recommended)' }, brief())).toMatchObject({ isDefault: false });
    expect(optionRow({ label: 'Just words' }, l3)).toMatchObject({ key: null, title: 'Just words' });
    // Any key Loom accepts, not just a letter (Codex review on #819).
    const approve = brief({ level: 3, defaultOption: 'APPROVE' });
    expect(optionRow({ label: 'APPROVE · Ship it · today (Recommended)', description: 'd' }, approve)).toMatchObject({ key: 'APPROVE', title: 'Ship it · today', recommended: true, isDefault: true });
    expect(optionRow({ label: 'opt-2 · Wait' }, approve)).toMatchObject({ key: 'opt-2', title: 'Wait', isDefault: false });
    // A key that holds the separator, or one key prefixing another, splits by its position's own key (Codex on #819).
    const dotted = brief({ level: 3, defaultOption: 'A', optionKeys: ['A', 'A · B'] });
    expect(optionRow({ label: 'A · B · Ship (Recommended)' }, dotted, 0)).toMatchObject({ key: 'A', title: 'B · Ship', isDefault: true });
    expect(optionRow({ label: 'A · B · Wait' }, dotted, 1)).toMatchObject({ key: 'A · B', title: 'Wait', isDefault: false });
  });

  it('a revision pill from the 2nd version, and asset kinds in words', () => {
    expect(revisionText(brief({ revision: 1 }))).toBeNull();
    expect(revisionText(brief({ revision: 2 }))).toBe('Revised · 2nd version');
    expect(revisionText(brief({ revision: 11 }))).toBe('Revised · 11th version');
    expect([21, 22, 23, 111, 112, 101].map((revision) => revisionText(brief({ revision })))).toEqual(['21st', '22nd', '23rd', '111th', '112th', '101st'].map((n) => `Revised · ${n} version`));
    expect(revisionText(brief())).toBeNull();
    expect(assetKind('pr')).toBe('Pull request');
    expect(assetKind('dashboard')).toBe('Dashboard');
  });
});

describe('plain ask context', () => {
  it('omits repetitions despite punctuation, case and whitespace, preserving additional facts', () => {
    expect(supportingSummary('Use the shorter introduction?', 'Summary: USE the shorter introduction.')).toBeNull();
    expect(supportingSummary('Do not use the shorter introduction?', 'Use the shorter introduction')).toBe('Use the shorter introduction');
    expect(supportingSummary('Use the shorter introduction?', 'Use the shorter introduction. It keeps the example.')).toBe('Use the shorter introduction. It keeps the example.');
    expect(supportingSummary('Use the shorter introduction?', 'Do not use the shorter introduction.')).toBe('Do not use the shorter introduction.');
    expect(supportingSummary('Use it?', '  ')).toBeNull();
  });
});

it('discussion suppresses the owner ask and demotes formal answers without disabling them', async () => {
  // @ts-expect-error plain browser module
  const { BriefCard, BRIEF_STATUS } = await import('../public/desk/brief.js');
  const card = BriefCard({ item: { id: 'i' }, store: { state: { now: 100 } },
    pending: { question: 'Which layout?', brief: brief({ discussingSince: 20 }), questions: [] } });
  const text = JSON.stringify(card);
  expect(BRIEF_STATUS.discussing).toBe('In discussion');
  expect(text).toContain('In discussion: your reply was delivered; the agent will respond.');
  expect(text).toContain('Answer formally instead');
  expect(card.props.class).toContain('fyi');
  expect(text).not.toContain('"readOnly":true');
});
