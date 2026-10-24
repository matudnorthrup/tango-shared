import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { alsoAsked, catchupCounts, catchupHeader, catchupStatus, catchupMap, catchupSpaces, chapterIndex, focusOf, inboxSummary, nextCatchup, openLines, placeDot, rowDots, rowSummary, settledAfterAct, smallerReads, spaceRoute, tidyLines } from '../public/desk/next/catchup-model.js';

// The catch-up across spaces (docs/specs/catch-up.md, Sidebar and Inbox summary), from GET /api/desk/chapters.

const chapter = (spaceId: string, over: Record<string, unknown> = {}) => ({ spaceId, headline: null, status: null, state: 'news', moments: 0, needs: 0, smaller: 0, since: 100, lastAt: 200, backAt: null, ...over });
const places = {
  projects: [{ id: 'tango', name: 'Tango' }, { id: 'desk', name: 'Desk' }, { id: 'voice', name: 'Voice' }, { id: 'house', name: 'House' }, { id: 'billing', name: 'Billing' }],
  agents: [{ id: 'sierra', name: 'Sierra' }],
};

describe('the catch-up across spaces', () => {
  it('a dot marks a place with a moment open; smaller updates alone, or a caught-up or deferred chapter, get none', () => {
    const index = chapterIndex({ catchup: { data: [
      chapter('project:desk', { moments: 2, smaller: 1 }),
      chapter('project:house', { smaller: 3 }),
      chapter('project:billing', { state: 'caught_up' }),
      chapter('project:voice', { state: 'deferred', moments: 0, backAt: 900 }),
      chapter('agent:sierra', { moments: 1, needs: 1 }),
    ] } });
    const place = (key: string, children: Array<{ id: string }> = []) => ({ key, children });
    expect(placeDot(place('project:desk'), index)).toBe(true);
    expect(placeDot(place('project:house'), index)).toBe(false);
    expect(placeDot(place('project:billing'), index)).toBe(false);
    expect(placeDot(place('project:voice'), index)).toBe(false);
    expect(placeDot(place('agent:sierra'), index)).toBe(true);
    // A parent: closed, any child's news shows on it; open, it speaks for itself and the child shows its own.
    expect(placeDot(place('project:tango', [{ id: 'desk' }, { id: 'voice' }]), index)).toBe(true);
    expect(placeDot(place('project:tango', [{ id: 'desk' }]), index, { isOpen: true })).toBe(false);
    expect(placeDot(place('project:tango', [{ id: 'house' }]), index)).toBe(false);
    // Before the desk has read the chapters, nothing.
    expect(placeDot(place('project:desk'), chapterIndex({ catchup: null }))).toBe(false);
  });

  it('the spaces to catch up on, in order, named, with spaces the desk can\'t name left out; Unfiled opens the Inbox', () => {
    const state = { catchup: { data: [
      chapter('agent:sierra', { moments: 1, needs: 1 }),
      chapter('project:desk', { moments: 2, smaller: 1 }),
      chapter('unfiled', { moments: 4 }),
      chapter('project:gone', { moments: 1 }),
      chapter('project:house', { smaller: 3 }),
      chapter('project:billing', { state: 'caught_up' }),
      // A brief already seen still waits: it's in, though nothing is new.
      chapter('project:voice', { state: 'caught_up', needs: 1 }),
      // An open incident: the System page handles it (Codex review on #852).
      chapter('system', { moments: 1 }),
      // Deferred, a brief and all: out until it comes back (Codex review on #852).
      chapter('project:tango', { state: 'deferred', needs: 1, moments: 2, backAt: 900 }),
    ] } };
    const spaces = catchupSpaces(state, places);
    expect(spaces.map((c: { name: string }) => c.name)).toEqual(['Sierra', 'Desk', 'Unfiled', 'House', 'Voice', 'System']);
    expect(catchupCounts(spaces)).toEqual({ moments: 8, needs: 2 });
    expect(nextCatchup(spaces)).toEqual({ page: 'catchup' });
    expect(nextCatchup([])).toBeNull();
    expect(spaceRoute('project:a:b')).toEqual({ page: 'project', id: 'a:b' });
    expect(spaceRoute('unfiled')).toEqual({ page: 'inbox', view: null });
    expect(spaceRoute('system')).toEqual({ page: 'system', view: 'overview' });
  });

  it('oldest first: each group runs from the place whose oldest open line has waited longest', () => {
    const data = [
      chapter('agent:sierra', { moments: 1, needs: 1, since: 50 }),
      chapter('project:voice', { moments: 1, needs: 1, since: 10 }),
      chapter('project:desk', { moments: 2, since: 90 }),
      chapter('project:house', { moments: 1, since: 20 }),
    ];
    const names = (list: Array<{ name: string }>) => list.map((c) => c.name);
    expect(names(catchupSpaces({ catchup: { data } }, places))).toEqual(['Sierra', 'Voice', 'Desk', 'House']);
    const map = catchupMap(catchupSpaces({ catchup: { data }, nextOrder: 'oldest' }, places));
    expect(names(map.needs)).toEqual(['Voice', 'Sierra']);
    expect(names(map.look)).toEqual(['House', 'Desk']);
    // A brief read and still unanswered dates its place (oldestAt), though nothing in it is unread (Codex review on #1030).
    const read = [chapter('agent:sierra', { needs: 1, since: 200, oldestAt: 200 }), chapter('project:voice', { state: 'caught_up', needs: 1, since: null, oldestAt: 100, lastAt: 300 })];
    expect(names(catchupSpaces({ catchup: { data: read }, nextOrder: 'oldest' }, places))).toEqual(['Voice', 'Sierra']);
  });

  it('the Inbox summary: since the earliest chapter, what needs the owner, what is worth a look, where the smaller updates are', () => {
    const spaces = catchupSpaces({ catchup: { data: [
      chapter('agent:sierra', { moments: 1, needs: 1, smaller: 2, since: 300 }),
      chapter('project:desk', { moments: 2, needs: 2, smaller: 1, since: 120 }),
      chapter('project:voice', { moments: 1, smaller: 1 }),
      chapter('project:house', { smaller: 3 }),
      chapter('project:billing', { smaller: 1 }),
    ] } }, places);
    const view = inboxSummary(spaces);
    expect(view.since).toBe(100);
    expect(view.tally).toBe('12 updates across 5 places');
    expect(view.lines).toEqual([
      { kind: 'needs', lead: '3 need you', where: 'in Sierra, Desk' },
      { kind: 'look', lead: 'Worth a look', where: 'in Voice' },
      { kind: 'small', lead: null, where: 'Smaller updates in 2 more' },
    ]);
    // Only smaller updates: no "more" to be more than; one place is named.
    expect(inboxSummary(catchupSpaces({ catchup: { data: [chapter('project:house', { smaller: 3 }), chapter('project:billing', { smaller: 1 })] } }, places)).lines).toEqual([{ kind: 'small', lead: null, where: 'Smaller updates in 2 places' }]);
    expect(inboxSummary(catchupSpaces({ catchup: { data: [chapter('project:house', { smaller: 1 })] } }, places)).lines[0].where).toBe('Smaller updates in House');
    // Nothing waiting: no card.
    expect(inboxSummary([])).toBeNull();
  });
});

describe('the Catch me up page', () => {
  const line = (id: number, kind: string, at: number, moment = kind !== 'fyi') => ({ id, kind, at, moment, title: `line ${id}` });
  const entry = (lines: unknown[]) => ({ data: { lines } });
  const spaces = catchupSpaces(
    {
      catchup: {
        data: [
          chapter('project:desk', { needs: 1, moments: 2, smaller: 1, lastAt: 500 }),
          chapter('agent:sierra', { moments: 1, lastAt: 400, since: 50 }),
          chapter('project:house', { smaller: 2, lastAt: 300 }),
        ],
      },
    },
    places,
  );
  const chapters = {
    'project:desk': entry([line(1, 'shipped', 10), line(2, 'needs', 5), line(3, 'fyi', 20, false)]),
    'agent:sierra': entry([line(21, 'decided', 30)]),
    'project:house': entry([line(41, 'fyi', 1, false), line(42, 'fyi', 2, false)]),
  };

  it('the map groups Needs you, Worth a look and Smaller; a space done here drops out until a new moment comes in', () => {
    const map = catchupMap(spaces);
    expect([map.needs, map.look, map.smaller].map((g: { spaceId: string }[]) => g.map((c) => c.spaceId))).toEqual([['project:desk'], ['agent:sierra'], ['project:house']]);
    expect(catchupMap(spaces, { 'agent:sierra': { at: 450 } }).look).toEqual([]);
    // A moment in Sierra (at 400) after it was done here (at 350) brings it back.
    expect(catchupMap(spaces, { 'agent:sierra': { at: 350 } }).look.map((c: { spaceId: string }) => c.spaceId)).toEqual(['agent:sierra']);
    // Smaller updates never bring a space back.
    expect(catchupMap(spaces, { 'project:house': { at: 100 } }).smaller).toEqual([]);
  });

  it('open lines leave out those handled at the tap, and are null until the chapter is read', () => {
    expect(openLines(chapters['project:desk'], { 1: 'accepted' }).map((l: { id: number }) => l.id)).toEqual([2, 3]);
    expect(openLines(undefined)).toBeNull();
  });

  it('a brief read but not answered (in waiting) is an open moment that needs the owner, once', () => {
    const seen = { data: { lines: [line(3, 'fyi', 20, false)], waiting: [{ id: 2, kind: 'needs', briefId: 'D-4', title: 'Approve?', at: 5, moment: false }] } };
    expect(openLines(seen)).toEqual([line(3, 'fyi', 20, false), { id: 2, kind: 'needs', briefId: 'D-4', title: 'Approve?', at: 5, moment: true, waiting: true }]);
    expect(rowSummary(spaces[0], openLines(seen))).toBe('1 needs you · 1 small');
    // It is the focus for its space, under Needs you.
    expect(focusOf(spaces, { ...chapters, 'project:desk': seen }).line).toMatchObject({ id: 2, waiting: true });
    // Also a line: listed once.
    expect(openLines({ data: { lines: [line(2, 'needs', 5)], waiting: [line(2, 'needs', 5)] } })).toHaveLength(1);
    // Handled at the tap: gone.
    expect(openLines(seen, { 2: true })).toEqual([line(3, 'fyi', 20, false)]);
    // Deferred on its own (its Defer): out of the catch-up until it's back, so the page moves on.
    const backAt = Date.now() + 3_600_000;
    const deferred = { data: { lines: [line(3, 'fyi', 20, false)], waiting: [{ id: 2, kind: 'needs', briefId: 'D-4', title: 'Approve?', at: 5, moment: false, seenVia: 'deferred', backAt }] } };
    expect(openLines(deferred)).toEqual([line(3, 'fyi', 20, false)]);
    expect(focusOf(spaces, { ...chapters, 'project:desk': deferred })?.line.id).not.toBe(2);
    expect(openLines(deferred, {}, backAt).map((l: { id: number }) => l.id)).toEqual([3, 2]);
  });

  it("reads each line in the owner's words: the writer's short title over the ledger's, never a bare id", () => {
    const entry = {
      data: {
        lines: [
          { id: 1, kind: 'shipped', title: 'feat(desk): the long ledger title for the catch-up ledger', at: 1, moment: true },
          { id: 2, kind: 'decided', title: 'Merged PR #864 under R-15', at: 2, moment: true },
        ],
        view: { titles: { 1: 'Catch-up collapses its noise' } },
      },
    };
    const [a, b] = openLines(entry);
    expect(a).toMatchObject({ title: 'Catch-up collapses its noise', raw: 'feat(desk): the long ledger title for the catch-up ledger' });
    expect(b.title).not.toMatch(/#864|R-15/);
    expect(b.raw).toBeUndefined();
  });

  it('after Accept or Defer a space is done here only once no moment is left (a failed part stays)', () => {
    expect(settledAfterAct({ data: { lines: [line(3, 'fyi', 20, false)] } })).toBe(true);
    expect(settledAfterAct({ data: { lines: [line(2, 'needs', 5)] } })).toBe(false);
    // A brief Accept left for the owner, or one Defer left unanswered, is a pick in Done here, not something left.
    expect(settledAfterAct({ data: { lines: [], waiting: [line(2, 'needs', 5)] } })).toBe(true);
    expect(settledAfterAct({ data: { lines: [line(2, 'needs', 5)] } }, { 2: true })).toBe(true);
    expect(settledAfterAct(undefined)).toBe(false);
  });

  it('the Smaller row reads only smaller lines: a space where a moment has since come in stays out of the Got it', () => {
    const house = { spaceId: 'project:house' };
    const voice = { spaceId: 'project:voice' };
    expect(smallerReads([
      { space: house, lines: [line(41, 'fyi', 1, false), line(42, 'fyi', 2, false)] },
      { space: voice, lines: [line(31, 'fyi', 1, false), line(32, 'shipped', 3)] },
      { space: { spaceId: 'agent:sierra' }, lines: null },
    ])).toEqual([{ spaceId: 'project:house', ids: [41, 42] }]);
  });

  it('a row sums its open lines once read, else its counts', () => {
    expect(rowSummary(spaces[0], openLines(chapters['project:desk']))).toBe('1 needs you · 1 to see · 1 small');
    expect(rowSummary(chapter('x', { needs: 2, moments: 3, smaller: 4 }))).toBe('2 need you · 1 to see · 4 small');
    expect(rowSummary(chapter('x', { smaller: 1 }), [])).toBe('');
  });

  it('the focus: the first open moment in catch-up order, kind first; Skip moves on, a tapped line takes it, done spaces drop out', () => {
    const at = (o = {}) => {
      const f = focusOf(spaces, chapters, o);
      return f && [f.space.spaceId, f.line.id];
    };
    // In Desk, the brief waiting on the owner comes before what shipped.
    expect(at()).toEqual(['project:desk', 2]);
    expect(at({ skipped: [2] })).toEqual(['project:desk', 1]);
    expect(at({ skipped: [2, 1] })).toEqual(['agent:sierra', 21]);
    // A line handled at the tap is gone from the focus.
    expect(at({ lineLocal: { 2: 'answered' } })).toEqual(['project:desk', 1]);
    // A tapped line takes the focus, even one skipped; a tapped line no longer open falls back.
    expect(at({ focusId: 21, skipped: [21] })).toEqual(['agent:sierra', 21]);
    expect(at({ focusId: 99 })).toEqual(['project:desk', 2]);
    expect(at({ done: { 'project:desk': { at: 900 } } })).toEqual(['agent:sierra', 21]);
    // Smaller updates are never the focus.
    expect(at({ skipped: [2, 1, 21] })).toBeNull();
    // A chapter not read yet has no focus to give.
    expect(focusOf(spaces, {}, {})).toBeNull();
  });

  it('a row keeps a dot per moment it showed: filled while open, hollow once handled', () => {
    const lines = openLines(chapters['project:desk'], { 2: 'answered' });
    expect(rowDots(new Set([1, 2]), lines)).toEqual([
      { id: 1, kind: 'shipped', hollow: false },
      { id: 2, kind: null, hollow: true },
    ]);
    expect(rowDots(undefined, null)).toEqual([]);
  });

  it('a failed read of the chapter list is an error, never caught up', () => {
    expect(catchupStatus(undefined)).toBe('loading');
    expect(catchupStatus({ data: null, error: 'network error' })).toBe('error');
    expect(catchupStatus({ data: null, error: 'off' })).toBe('off');
    expect(catchupStatus({ data: [], error: null })).toBe('ready');
    // A refresh that failed keeps what was read.
    expect(catchupStatus({ data: [chapter('agent:sierra')], error: 'network error' })).toBe('ready');
  });

  it('the header: since the earliest chapter, and the moments left', () => {
    expect(catchupHeader(spaces)).toEqual({ since: 50, left: 3 });
    expect(catchupHeader([])).toEqual({ since: null, left: 0 });
  });
});

describe('Needs you cleaned up, on the page', () => {
  const l = (id: number, kind: string, title: string, moment = kind === 'needs') => ({ id, kind, title, at: id, moment, spaceId: 'project:exp' });
  const entry = {
    data: {
      lines: [l(1, 'needs', 'Approve the holdout?'), l(2, 'needs', 'reconcile the missing source worktree'), l(3, 'needs', 'Sign in to claude.ai'), l(4, 'needs', 'The Test 2 card waits for your Confirm.'),
        l(5, 'needs', 'Confirm the Test 2 card in Slack'), l(6, 'needs', 'Upload Ridge Loop privately?'), l(7, 'fyi', 'Three PRs need your merge')],
      waiting: [],
      tidied: [],
      view: {
        titles: { 9: 'Claude.ai account works' },
        tidy: {
          also: { 4: [{ id: 5, from: 'Notifications', spaceId: 'project:exp' }] },
          elsewhere: [{ id: 6, keptId: 40, where: 'Videos' }],
          notes: { 2: { label: 'housekeeping' }, 3: { label: 'answered', by: { id: 9, title: 'The claude.ai account works again (D-12)' } }, 7: { label: 'ask' } },
        },
      },
    },
  };
  const space = { spaceId: 'project:exp', name: 'Experiments', needs: 4, moments: 4, smaller: 2, state: 'news', since: 1, lastAt: 9 };

  it('Needs you lists each real ask once by the facts: repeats fold, and the writer only adds labeled notes', () => {
    const lines = openLines(entry);
    // The writer's chore, answered and ask notes move nothing: only the repeats fold.
    expect(lines.map((x: { id: number }) => x.id)).toEqual([1, 2, 3, 4, 7]);
    expect(lines[3]).toMatchObject({ id: 4, also: [{ id: 5, from: 'Notifications' }] });
    expect(lines[1]).toMatchObject({ id: 2, kind: 'needs', note: 'Summary: reads like the agent’s own bookkeeping' });
    expect(lines[2]).toMatchObject({ id: 3, kind: 'needs', note: 'Summary: a later update may have settled this: Claude.ai account works' });
    expect(lines[4]).toMatchObject({ id: 7, kind: 'fyi', note: 'Summary: this asks you something' });
    expect(lines[0]).not.toHaveProperty('note');
    expect(alsoAsked(lines[3].also)).toBe('Also asked in “Notifications”');
    expect(alsoAsked([{ id: 1, from: null }, { id: 2, from: 'A' }])).toBe('Also asked 2 more times');
    expect(alsoAsked([])).toBeNull();
    // Handled at the tap, the repeat no longer counts.
    expect(openLines(entry, { 5: true })[3]).not.toHaveProperty('also');
    expect(focusOf([space], { 'project:exp': entry }).line.id).toBe(4);
  });

  it('what it folded away sits on its own row: asked elsewhere', () => {
    const tidy = tidyLines(entry);
    expect(tidy).toEqual({ elsewhere: [expect.objectContaining({ id: 6, where: 'Videos' })] });
    expect(tidyLines(undefined)).toBeNull();
    expect(tidyLines({ data: { lines: [l(1, 'needs', 'x')] } })).toEqual({ elsewhere: [] });
    expect(rowSummary(space, openLines(entry), tidy)).toBe('4 need you · 1 small · 1 asked elsewhere');
    expect(rowSummary(space, null, tidy)).toBe('4 need you · 1 small · 1 asked elsewhere');
  });

  it("the Smaller row's Got it reads the folded lines it shows too", () => {
    const quiet = { data: { lines: [l(2, 'needs', 'Upload it?'), l(11, 'fyi', 'Docs tidied', false)], view: { tidy: { also: {}, elsewhere: [{ id: 2, keptId: 40, where: 'Videos' }], notes: {} } } } };
    const per = [{ space: { spaceId: 'project:exp' }, lines: openLines(quiet), tidy: tidyLines(quiet) }];
    expect(smallerReads(per)).toEqual([{ spaceId: 'project:exp', ids: [11, 2] }]);
  });
});
