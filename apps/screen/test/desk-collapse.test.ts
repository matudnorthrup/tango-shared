import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { collapse, ownerTitle, readLayout, themeOf } from '../server/desk/collapse.js';
import { writtenLayout } from '../server/desk/chapter-writer.js';
import { costly, DeskUpdates, momentFor, type DeskUpdate, type UpdatesDecidedSource } from '../server/desk/updates.js';
import { NOW } from './desk-harness.js';

// Collapsing the noise (D-94, TGO-1112): one fact one line, routine ops and rule-made decisions are not moments, rule
// changes batch, Shipped groups by theme, at most three moments shown, titles in the owner's language, and the headline
// rewritten soon after the owner handles a line.

const HOUR = 3_600_000;
const routine = (cls: string) => cls === 'merge-when-green';

function ledger(extra: Partial<ConstructorParameters<typeof DeskUpdates>[0]> = {}) {
  const clock = { now: NOW };
  const db = new DatabaseSync(':memory:');
  const updates = new DeskUpdates({ db, items: () => [], spaceOf: () => null, exec: null, now: () => clock.now, ...extra });
  return { updates, clock, db };
}

let nextId = 1;
function line(over: Partial<DeskUpdate>): DeskUpdate {
  const id = over.id ?? nextId++;
  return {
    id, spaceId: 'project:desk', itemId: null, kind: 'fyi', moment: false, title: `line ${id}`, detail: null, refs: [], shot: null, briefId: null, decisionId: null, class: null,
    coversFrom: null, coversTo: null, data: {}, source: 'auto:pr', subject: null, supersedes: null, supersededBy: null, at: NOW - id * 1000, seenAt: null, seenVia: null,
    outcome: null, backAt: null, resolvedAt: null, ...over,
  };
}
const pr = (n: number, title: string, over: Partial<DeskUpdate> = {}) => line({ kind: 'shipped', title: `Merged PR #${n}: ${title}`, subject: `pr:o/tango#${n}`, refs: [{ label: `PR #${n}`, url: `https://github.com/o/tango/pull/${n}` }], ...over });
const rule = (r: string, over: Partial<DeskUpdate> = {}) => line({ kind: 'decided', moment: true, source: 'auto:decision', title: `${r}: a rule`, data: { ruleEvent: 'rule-created', rule: r }, decisionId: `D-${r}`, ...over });

describe('owner-language titles', () => {
  it('takes out commit prefixes, issue tags, release hashes and PIDs', () => {
    expect(ownerTitle('Merged PR #852: feat(desk): sidebar dot, Catch me up row and Inbox summary; retire Decided for you (TGO-1104)')).toBe('Sidebar dot, Catch me up row and Inbox summary; retire Decided for you');
    expect(ownerTitle('Restarted Loom on release 20261019-231105-3b3ff15 (a few seconds); after the restart, no orphans')).toBe('Restarted Loom (a few seconds); after the restart, no orphans');
    expect(ownerTitle('Artifact host down: an orphaned tshare-server (PID 71898) held :9350')).toBe('Artifact host down: an orphaned tshare-server held :9350');
    expect(ownerTitle('Merged PR #830: feat(desk): catch-up ledger — updates, automatic sources, seen marks (TGO-1101)')).toBe('Catch-up ledger: updates, automatic sources, seen marks');
    expect(ownerTitle('Merged PR #825: docs: catch-up and seen spec')).toBe('Catch-up and seen spec');
    expect(ownerTitle('The redesigned decision card is live.')).toBe('The redesigned decision card is live.');
  });

  it('reads the theme from the PR scope', () => {
    expect(themeOf({ title: 'Merged PR #1: feat(desk,loom): x', source: 'auto:pr' })).toBe('desk');
    expect(themeOf({ title: 'Merged PR #2: docs: spec', source: 'auto:pr' })).toBe('docs');
    expect(themeOf({ title: 'The card is live', source: 'lead' })).toBe('other');
  });
});

describe('routine ops and rule-made decisions are not moments', () => {
  it('a restart is a moment only when it failed or cost more than a minute', () => {
    expect(costly('Restarted Loom on release x (a few seconds)')).toBe(false);
    expect(costly('Restarted Loom twice and the desk once (~15 s)')).toBe(false);
    expect(costly('Added loom.sqlite to the nightly B2 backup')).toBe(false);
    expect(costly('Restarted the desk; it was down for 4 min')).toBe(true);
    expect(costly('Restart failed; rolled back to the last release')).toBe(true);
    const ops = (title: string) => momentFor({ kind: 'decided', class: 'ops-own-machine', title }, { routine });
    expect(ops('Restarted Loom (a few seconds)')).toBe(false);
    expect(ops('Restart failed, Loom did not come back')).toBe(true);
  });

  it('a long duration is costly only when it is time down', () => {
    expect(costly('Backed up the last 24 hours of messages')).toBe(false);
    expect(costly('Ran verification for 3 minutes')).toBe(false);
    expect(costly('Restarted Loom (3 min)')).toBe(true);
    expect(costly('Deployed the desk. Ran checks for 10 minutes; it was offline for 20 s')).toBe(false);
    expect(costly('The desk was out for 2 minutes')).toBe(true);
    // The duration has to belong to the outage words, not just share a clause with them.
    expect(costly('Restarted Loom, then ran verification for 3 minutes')).toBe(false);
    expect(costly('Restarted Loom and ran verification for 3 minutes')).toBe(false);
    expect(costly('Restart took 90 s')).toBe(true);
    expect(costly('Loom came back after 5 min')).toBe(true);
    expect(costly('About 4 minutes of downtime')).toBe(true);
    expect(costly('The outage lasted 5 minutes')).toBe(true);
    expect(costly('Downtime was 4 minutes')).toBe(true);
    expect(costly('Downtime was 20 s')).toBe(false);
  });

  it('a costly op stays a moment even once its class is routine or a rule allowed it', () => {
    const always = () => true;
    expect(momentFor({ kind: 'decided', class: 'ops-own-machine', title: 'Restart failed; rolled back' }, { routine: always })).toBe(true);
    expect(momentFor({ kind: 'decided', class: 'ops-own-machine', title: 'Desk was down for 5 min', data: { underRule: 'R-9' } }, { routine: always })).toBe(true);
    expect(momentFor({ kind: 'decided', class: 'ops-own-machine', title: 'Restarted Loom (~15 s)' }, { routine: always })).toBe(false);
  });

  it('a decision made under a standing rule is routine, whatever its class', () => {
    expect(momentFor({ kind: 'decided', class: 'product-choice-in-scope', title: 'Merged #844 at the Codex cap', data: { underRule: 'R-15' } }, { routine })).toBe(false);
    expect(momentFor({ kind: 'decided', class: 'product-choice-in-scope', title: 'Picked the layout' }, { routine })).toBe(true);
    // A rule event stays a moment.
    expect(momentFor({ kind: 'decided', alwaysMoment: true, class: 'product-choice-in-scope', title: 'R-15', data: { underRule: 'R-15' } }, { routine })).toBe(true);
  });

  it('the decided source records the rule it was made under', async () => {
    const decided: UpdatesDecidedSource = {
      async decided() {
        return { decisions: [{ id: 'D-93', thread_id: 't', thread_title: null, class: 'product-choice-in-scope', level: 3, status: 'acted', summary: 'Merged PR #844 at the Codex cap', undo: null, ref: null, at: NOW - HOUR, reversed_at: null, reversal: null, rule: 'R-15' }], more: false };
      },
    };
    const { updates } = ledger({ decided });
    await updates.syncDecided();
    expect(updates.latest('decision:D-93')).toMatchObject({ moment: false, data: { underRule: 'R-15' } });
  });

  it('once, lines already written are rated again with the rule Loom reads back; never without it, never twice', async () => {
    const db = new DatabaseSync(':memory:');
    const old = ledger({ db });
    old.updates.record({ spaceId: 'project:desk', kind: 'decided', class: 'product-choice-in-scope', title: 'Merged #844 at the Codex cap', decisionId: 'D-93', source: 'auto:decision', subject: 'decision:D-93', at: NOW - 2 * HOUR });
    old.updates.record({ spaceId: 'project:desk', kind: 'decided', class: 'design-direction', title: 'Picked the card layout', decisionId: 'D-50', source: 'auto:decision', subject: 'decision:D-50', at: NOW - 2 * HOUR });
    old.updates.record({ spaceId: 'project:desk', kind: 'decided', class: 'ops-own-machine', title: 'Restarted Loom (a few seconds)', decisionId: 'D-75', source: 'auto:decision', subject: 'decision:D-75', at: NOW - 2 * HOUR });
    // Written before rule 2: still a moment in the ledger.
    db.prepare("UPDATE desk_updates SET moment = 1 WHERE subject = 'decision:D-75'").run();
    const row = (id: string, rule?: string | null) => ({ id, thread_id: 't', thread_title: null, class: 'x', level: 3, status: 'acted' as const, summary: id, undo: null, ref: null, at: NOW - 2 * HOUR, reversed_at: null, reversal: null, ...(rule !== undefined ? { rule } : {}) });
    // An older Loom that doesn't say: nothing changes yet, and it tries again.
    let rows = [row('D-93'), row('D-50'), row('D-75')];
    const decided: UpdatesDecidedSource = { async decided(since) { return { decisions: rows.filter((r) => r.at >= since), more: false }; } };
    const { updates } = ledger({ db, decided });
    await updates.syncDecided();
    expect(updates.latest('decision:D-93')!.moment).toBe(true);
    rows = [row('D-93', 'R-15'), row('D-50', null), row('D-75', null)];
    await updates.syncDecided();
    expect(updates.latest('decision:D-93')).toMatchObject({ moment: false, data: { underRule: 'R-15' } });
    expect(updates.latest('decision:D-50')!.moment).toBe(true);
    expect(updates.latest('decision:D-75')!.moment).toBe(false);
    // Once only.
    db.prepare("UPDATE desk_updates SET moment = 1 WHERE subject = 'decision:D-93'").run();
    await updates.syncDecided();
    expect(updates.latest('decision:D-93')!.moment).toBe(true);
  });

  it("once, open lines for rules the owner made or reaffirmed are marked handled; suspensions and demotions stay", async () => {
    const db = new DatabaseSync(':memory:');
    const old = ledger({ db });
    const made = old.updates.record({ spaceId: 'project:desk', kind: 'decided', alwaysMoment: true, title: 'R-18: merge at the cap', decisionId: 'D-105', data: { ruleEvent: 'rule-created', rule: 'R-18' }, source: 'auto:decision', subject: 'rule:E-12', at: NOW - HOUR });
    const noDecision = old.updates.record({ spaceId: 'project:desk', kind: 'decided', alwaysMoment: true, title: 'R-10', data: { ruleEvent: 'rule-created', rule: 'R-10' }, source: 'auto:decision', subject: 'rule:E-3', at: NOW - HOUR });
    const suspended = old.updates.record({ spaceId: 'project:desk', kind: 'decided', alwaysMoment: true, title: 'R-4 suspended', data: { ruleEvent: 'rule-suspended', rule: 'R-4' }, source: 'auto:decision', subject: 'rule:E-9', at: NOW - HOUR });
    const decided: UpdatesDecidedSource = { async decided() { return { decisions: [], more: false }; } };
    const { updates } = ledger({ db, decided });
    await updates.syncDecided();
    expect(updates.get(made!.id)).toMatchObject({ seenVia: 'acted' });
    expect(updates.get(noDecision!.id)).toMatchObject({ seenVia: 'acted' });
    expect(updates.get(suspended!.id)!.seenAt).toBeNull();
    // Once only.
    db.prepare('UPDATE desk_updates SET seen_at = NULL, seen_via = NULL WHERE id = ?').run(made!.id);
    await updates.syncDecided();
    expect(updates.get(made!.id)!.seenAt).toBeNull();
  });

  it('with nothing to rate again, the pass waits until Loom shows it reports the rule, then lines from an older Loom are rated', async () => {
    const db = new DatabaseSync(':memory:');
    const row = (id: string, rule?: string | null) => ({ id, thread_id: 't', thread_title: null, class: 'x', level: 3, status: 'acted' as const, summary: `Merged ${id}`, undo: null, ref: null, at: NOW - HOUR, reversed_at: null, reversal: null, ...(rule !== undefined ? { rule } : {}) });
    let rows = [row('D-93')];
    const decided: UpdatesDecidedSource = { async decided(since) { return { decisions: rows.filter((r) => r.at >= since), more: false }; } };
    const { updates } = ledger({ db, decided });
    // An older Loom: the line is read without its rule, and the pass stays pending.
    await updates.syncDecided();
    expect(updates.latest('decision:D-93')!.moment).toBe(true);
    // Loom upgrades: the pass reads the rule back and lowers it.
    rows = [row('D-93', 'R-15')];
    await updates.syncDecided();
    expect(updates.latest('decision:D-93')).toMatchObject({ moment: false, data: { underRule: 'R-15' } });
  });

  it('once, an open op stored as routine that failed is raised to a moment, without waiting on Loom', async () => {
    const db = new DatabaseSync(':memory:');
    const old = ledger({ db });
    for (const [id, title] of [['D-80', 'Restart failed; rolled back'], ['D-81', 'Restarted Loom (~15 s)'], ['D-82', 'Desk was down for 6 min']] as const) {
      old.updates.record({ spaceId: 'project:desk', kind: 'decided', class: 'ops-own-machine', title, decisionId: id, source: 'auto:decision', subject: `decision:${id}`, at: NOW - HOUR });
    }
    // Stored while the class was routine; D-82 the owner has already seen.
    db.prepare("UPDATE desk_updates SET moment = 0 WHERE kind = 'decided'").run();
    db.prepare("UPDATE desk_updates SET seen_at = ? WHERE subject = 'decision:D-82'").run(NOW);
    const decided: UpdatesDecidedSource = { async decided() { return { decisions: [], more: false }; } };
    const { updates } = ledger({ db, decided });
    await updates.syncDecided();
    expect(updates.latest('decision:D-80')!.moment).toBe(true);
    expect(updates.latest('decision:D-81')!.moment).toBe(false);
    expect(updates.latest('decision:D-82')!.moment).toBe(false);
  });
});

describe('the collapsed card', () => {
  it("folds a PR's routine decisions into its Shipped line, never a moment or a rule event", () => {
    const ship = pr(856, 'feat(desk): Catch me up page (TGO-1105)');
    const merged = line({ kind: 'decided', source: 'auto:decision', class: 'merge-when-green', title: 'Merged #856 once green and restarted the desk', decisionId: 'D-102' });
    const weighty = line({ kind: 'decided', moment: true, source: 'auto:decision', title: 'Merged #856 though CI was red', decisionId: 'D-103' });
    const view = collapse([ship, merged, weighty]);
    expect(view.folded).toEqual({ [ship.id]: [merged.id] });
    expect(view.groups.map((g) => [g.title, g.lines, g.ids])).toEqual([['Desk', [ship.id], [ship.id, merged.id]]]);
    expect(view.moments.map((m) => m.line)).toEqual([weighty.id]);
    expect(view.titles[ship.id]).toBe('Catch me up page');
  });

  it('folds a decision into the PR of the repo it links; a bare #N folds only when one repo has that number', () => {
    const tango = pr(9, 'feat(desk): card');
    const other = line({ kind: 'shipped', title: 'Merged PR #9: fix(api): retry', subject: 'pr:o/api#9', refs: [{ label: 'PR #9', url: 'https://github.com/o/api/pull/9' }] });
    const linked = line({ kind: 'decided', source: 'auto:decision', title: 'Merged #9 once green', refs: [{ label: 'PR', url: 'https://github.com/o/api/pull/9' }] });
    const bare = line({ kind: 'decided', source: 'auto:decision', title: 'Merged #9 once green' });
    const view = collapse([tango, other, linked, bare]);
    expect(view.folded).toEqual({ [other.id]: [linked.id] });
    // With one repo's #9 in the chapter, the bare mention folds.
    expect(collapse([tango, bare]).folded).toEqual({ [tango.id]: [bare.id] });
  });

  it('batches the rule changes into one moment, and orders moments needs, broken, rules, milestone, decided', () => {
    const decided = line({ kind: 'decided', moment: true, source: 'auto:decision', title: 'Changed how the desk sorts', at: NOW });
    const rules = [rule('R-15'), rule('R-16'), rule('R-9')];
    const brief = line({ kind: 'needs', moment: true, source: 'auto:brief', title: 'Approve the plan?', at: NOW - 9 * HOUR });
    const failed = line({ kind: 'failed', moment: true, source: 'auto:incident', title: 'Backup failed' });
    const view = collapse([decided, ...rules, brief, failed]);
    expect(view.moments.map((m) => m.key)).toEqual([`line:${brief.id}`, `line:${failed.id}`, 'rules', `line:${decided.id}`]);
    expect(view.moments[2]).toMatchObject({ title: '3 rule changes', ids: rules.map((r) => r.id), batch: 'rules' });
    // One rule change is its own moment.
    expect(collapse([rules[0]!]).moments).toMatchObject([{ key: `line:${rules[0]!.id}` }]);
  });

  it("groups Shipped by the writer's themes, promotes its milestone, and themes the rest by scope", () => {
    const a = pr(1, 'feat(desk): catch-up card');
    const b = pr(2, 'feat(loom,desk): leads write updates');
    const c = pr(3, 'fix(desk): status evaluator');
    const d = pr(4, 'fix(discord): replies post as you');
    const e = pr(5, 'fix(desk): composer grows');
    const layout = readLayout(JSON.stringify({ groups: [{ title: 'The catch-up card is live', ids: [a.id, b.id] }, { title: 'Desk polish', ids: [c.id, 999] }], milestone: 0, titles: { [String(d.id)]: 'Discord replies post as you' } }));
    const view = collapse([a, b, c, d, e], layout);
    expect(view.moments).toMatchObject([{ kind: 'shipped', title: 'The catch-up card is live', batch: 'milestone', lines: [a.id, b.id] }]);
    expect(view.groups.map((g) => [g.title, g.lines])).toEqual([['Desk polish', [c.id]], ['Desk', [e.id]], ['Discord', [d.id]]]);
    expect(view.titles[d.id]).toBe('Discord replies post as you');
  });

  it("a lead's update naming a PR takes that PR's Shipped line under it: one event, one line, in the lead's words", () => {
    const merged = pr(71, 'fix(desk): queued threads no longer look idle');
    const routine = line({ kind: 'decided', source: 'auto:decision', class: 'merge-when-green', title: 'Merged once green', refs: merged.refs });
    const said = line({ kind: 'shipped', moment: true, source: 'lead', title: 'Threads with mail waiting no longer show as idle', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/71' }] });
    const fyi = line({ kind: 'fyi', source: 'lead', title: 'Ask box icon stays put (#72)' });
    const other = pr(72, 'fix(desk): ask box icon and send stay on the first line');
    const view = collapse([said, merged, routine, fyi, other]);
    expect(view.moments).toMatchObject([{ line: said.id, title: 'Threads with mail waiting no longer show as idle', ids: [said.id, merged.id, routine.id] }]);
    expect(view.folded).toEqual({ [said.id]: [merged.id, routine.id], [fyi.id]: [other.id] });
    expect(view.groups.map((g) => [g.title, g.ids])).toEqual([['FYI', [fyi.id, other.id]]]);
  });

  it("a lead's update naming several PRs takes each of their Shipped lines, so no milestone retells it", () => {
    const page = pr(81, 'feat(desk): Catch me up page');
    const rules = pr(82, "feat(desk): collapse the chapter card's noise");
    const said = line({ kind: 'shipped', moment: true, source: 'lead', title: 'The Catch me up page and all eight collapse rules are live.', refs: [81, 82].map((n) => ({ label: 'PR', url: `https://github.com/o/tango/pull/${n}` })) });
    const view = collapse([said, page, rules], { groups: [{ title: 'Catch me up page and quieter cards', ids: [page.id, rules.id] }], milestone: 0, titles: {} });
    expect(view.moments).toMatchObject([{ line: said.id, ids: [said.id, page.id, rules.id] }]);
    expect(view.groups).toEqual([]);
  });

  it("a lead's routine decision naming a PR keeps its words: the PR line folds under it, not the other way round", () => {
    const merged = pr(91, 'fix(desk): queued threads no longer look idle');
    const said = line({ kind: 'decided', source: 'lead', class: 'merge-when-green', title: 'Merged the idle-thread fix once CI went green', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/91' }] });
    const view = collapse([said, merged]);
    expect(view.folded).toEqual({ [said.id]: [merged.id] });
    expect(view.groups.flatMap((g) => g.ids)).toEqual([said.id, merged.id]);
  });

  it('a writer group titled only with an id is dropped, and its lines fall to their themes', () => {
    const a = pr(61, 'feat(desk): catch-up card');
    const b = pr(62, 'fix(desk): status evaluator');
    const view = collapse([a, b], readLayout(JSON.stringify({ groups: [{ title: 'TGO-123', ids: [a.id, b.id] }], milestone: 0, titles: {} })));
    expect(view.moments.filter((m) => m.batch === 'milestone')).toEqual([]);
    expect(view.groups.map((g) => [g.title, g.lines])).toEqual([['Desk', [a.id, b.id]]]);
  });

  it('a brief or a failure is never collapsed; routine decisions, failures resolved and FYIs group by kind', () => {
    const briefs = [1, 2, 3, 4].map((n) => line({ kind: 'needs', moment: true, source: 'auto:brief', title: `Approve ${n}?` }));
    const routineLine = line({ kind: 'decided', source: 'auto:decision', title: 'Restarted Loom (a few seconds)' });
    const fyi = line({ kind: 'fyi', source: 'auto:incident', title: 'Backup failed: resolved' });
    const view = collapse([...briefs, routineLine, fyi]);
    expect(view.moments).toHaveLength(4);
    expect(view.groups.map((g) => [g.key, g.title, g.lines])).toEqual([['decided', 'Routine', [routineLine.id]], ['fyi', 'FYI', [fyi.id]]]);
  });

  it('the chapter counts its moments as the card shows them', () => {
    const { updates } = ledger({ items: () => [{ id: 'loom:ask', facts: { pending: { kind: 'question' } }, seen: 'new', disposition: 'active' }] as never });
    for (const r of ['R-1', 'R-2', 'R-3']) updates.record({ spaceId: 'project:desk', kind: 'decided', alwaysMoment: true, title: `${r}: x`, data: { ruleEvent: 'rule-created', rule: r }, source: 'auto:decision', subject: `rule:${r}` });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:ask', kind: 'needs', title: 'Approve?', source: 'auto:brief', subject: 'decision:D-1', briefId: 'D-1' });
    expect(updates.chapters()[0]).toMatchObject({ moments: 2, needs: 1, state: 'news' });
    const lines = updates.list({ space: 'project:desk' });
    expect(updates.view('project:desk', lines).moments.map((m) => m.key)).toEqual([`line:${lines.find((l) => l.kind === 'needs')!.id}`, 'rules']);
  });
});

describe('the writer groups and titles', () => {
  it('keeps only the lines it was given, and the milestone follows its group', () => {
    const open = [10, 11, 12].map((id) => ({ id, kind: 'shipped' as const, moment: false, title: 't', detail: null, at: NOW, source: 'auto:pr' as const }));
    expect(writtenLayout({ groups: [{ title: 'Gone', ids: [99] }, { title: ' Desk  polish ', ids: [10, 11, 99] }], milestone: 1, titles: { 12: 'Owner words', 99: 'x' } }, { open })).toEqual({ groups: [{ title: 'Desk polish', ids: [10, 11] }], milestone: 0, titles: { 12: 'Owner words' } });
    expect(writtenLayout({ groups: 'nope', milestone: 'x', titles: null }, { open })).toBeNull();
  });

  it('stores the layout with the prose, and a plain fallback keeps the one it had', async () => {
    const results: Array<{ headline: string; status: string; layout?: { groups: Array<{ title: string; ids: number[] }>; milestone: number | null; titles: Record<string, string> } }> = [];
    const { updates, clock } = ledger({ writeChapter: async () => results.shift() ?? null });
    const a = updates.record({ spaceId: 'project:desk', kind: 'shipped', title: 'Merged PR #1: feat(desk): a', source: 'auto:pr', subject: 'pr:o/r#1', at: NOW - HOUR });
    results.push({ headline: 'h', status: 's', layout: { groups: [{ title: 'Card work', ids: [a.id] }], milestone: null, titles: {} } });
    await updates.writeChapters();
    expect(updates.view('project:desk', updates.list({ space: 'project:desk' })).groups[0]!.title).toBe('Card work');
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'x', source: 'lead', at: clock.now + 1 });
    clock.now += HOUR;
    results.push({ headline: 'h2', status: 's2' });
    await updates.writeChapters();
    expect(updates.chapters()[0]!.headline).toBe('h2');
    expect(updates.view('project:desk', updates.list({ space: 'project:desk' })).groups[0]!.title).toBe('Card work');
  });
});

describe('the headline refreshes when a line is handled', () => {
  it('rewrites within a minute of the owner handling a line, inside the 30-minute gap', async () => {
    let n = 0;
    const { updates, clock } = ledger({ writeChapter: async () => ({ headline: `h${++n}`, status: `s${n}` }) });
    const brief = updates.record({ spaceId: 'project:desk', kind: 'needs', title: 'Approve?', source: 'auto:brief', at: NOW - HOUR });
    await updates.writeChapters();
    expect(n).toBe(1);
    clock.now += 2 * 60_000;
    updates.seen([brief.id], 'acted', 'A');
    clock.now += 30_000;
    await updates.writeChapters();
    expect(n).toBe(1);
    clock.now += 31_000;
    await updates.writeChapters();
    expect(updates.chapters()[0]).toMatchObject({ headline: 'h2' });
    // A new line after is the usual pace again: settle, then the gap.
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'x', source: 'lead', at: clock.now });
    clock.now += 6 * 60_000;
    await updates.writeChapters();
    expect(n).toBe(2);
  });
});

describe('the card view', () => {
  it('a milestone moment lists each line with the decisions folded into it', async () => {
    const { viewOf } = await import('../public/desk/next/chapter.js');
    const shippedLine = { id: 1, kind: 'shipped', title: 'Merged PR #9: feat(desk): card', subject: 'pr:o/r#9', moment: false, at: NOW, data: {}, refs: [] } as unknown as DeskUpdate;
    const decided = { id: 2, kind: 'decided', title: 'Merged #9 once green', moment: false, at: NOW - 1, data: {}, refs: [], decisionId: 'D-1' } as unknown as DeskUpdate;
    const view = collapse([shippedLine, decided], { groups: [{ title: 'The card', ids: [1] }], milestone: 0, titles: {} });
    const out = viewOf({ view, lines: [shippedLine, decided] });
    const milestone = out!.moments.find((m: { batch?: string }) => m.batch === 'milestone');
    expect(milestone.ids).toEqual([1, 2]);
    expect(milestone.inside[0].folded.map((f: { id: number }) => f.id)).toEqual([2]);
  });
});

describe('chapter counts', () => {
  it("count smaller updates as the card lists them: a milestone's lines and folded decisions are not counted again", () => {
    const { updates } = ledger();
    const space = 'project:desk';
    const a = updates.record({ spaceId: space, kind: 'shipped', title: 'Merged PR #1: feat(desk): card', subject: 'pr:o/r#1', source: 'auto:pr', at: NOW - 3 * HOUR });
    const b = updates.record({ spaceId: space, kind: 'shipped', title: 'Merged PR #2: feat(desk): page', subject: 'pr:o/r#2', source: 'auto:pr', at: NOW - 2 * HOUR });
    updates.record({ spaceId: space, kind: 'shipped', title: 'Merged PR #3: fix(loom): wait', subject: 'pr:o/r#3', source: 'auto:pr', at: NOW - 2 * HOUR });
    updates.record({ spaceId: space, kind: 'decided', class: 'merge-when-green', title: 'Merged #3 once green', decisionId: 'D-1', subject: 'decision:D-1', source: 'auto:decision', at: NOW - HOUR });
    updates.setProse(space, { headline: 'h', status: 's', layout: { groups: [{ title: 'The card is live', ids: [a!.id, b!.id] }], milestone: 0, titles: {} } }, 'model');
    expect(updates.chapters().find((c) => c.spaceId === space)).toMatchObject({ moments: 1, smaller: 1 });
  });
});

describe('no bare reference ids on the catch-up', () => {
  it('names the thing in words instead of D-n, R-n, E-n, #PR or TGO-n', async () => {
    const { plainWords, sentences, words } = await import('../public/desk/plain-words.js');
    expect(plainWords('Merged #856 once green')).toBe('Merged the PR once green');
    expect(plainWords('Merged PR #844 at the Codex cap under R-15')).toBe('Merged the PR at the Codex cap under a standing rule');
    expect(plainWords('R-18: merge capped PRs and fix edges next')).toBe('Merge capped PRs and fix edges next');
    expect(plainWords('Catch me up page (TGO-1105)')).toBe('Catch me up page');
    expect(plainWords('Asked the build thread to add to #864, citing R-17')).toBe('Asked the build thread to add to the PR, citing a standing rule');
    expect(plainWords('The fix still needs your call (D-100)')).toBe('The fix still needs your call');
    expect(plainWords('Rules R-15, R-16 and R-17 changed')).toBe('Rules changed');
    expect(plainWords('Nothing to take out here')).toBe('Nothing to take out here');
    expect(plainWords('Plan r6 drops the guest arm')).toBe('Plan drops the guest arm');
    expect(plainWords('Approve the rollout plan (r3)?')).toBe('Approve the rollout plan?');
    expect(plainWords('Room r2d2 and the r6.1 build stay')).toBe('Room r2d2 and the r6.1 build stay');
    expect(plainWords('r6 drops the guest arm')).toBe('Drops the guest arm');
    expect(plainWords('r6.1 ships today')).toBe('r6.1 ships today');
    for (const text of ['Merged #856 once green', 'Under R-15 per D-94 (E-12)', 'TGO-1112 shipped']) expect(plainWords(text)).not.toMatch(/\b[DRE]-\d|#\d|TGO-\d/);
    expect(sentences('One. Two! Three? Four.', 2)).toBe('One. Two!');
    expect(words('a b c d e f g h i j k l', 8)).toBe('a b c d e f g h…');
  });

  it("an opened line's detail keeps an id only where it can be a link", async () => {
    const { plainDetail } = await import('../public/desk/plain-words.js');
    const keep = (id: string) => id === 'D-94' || id === '#17175';
    // The live case: a PR the line doesn't link to is named in words, not left as a bare number.
    expect(plainDetail('Production stays off. #17173 now draws only registered accounts, with CI green.', keep)).toBe('Production stays off. The PR now draws only registered accounts, with CI green.');
    expect(plainDetail('Stacked on #17175 per D-94 under R-17 (TGO-1105)', keep)).toBe('Stacked on #17175 per D-94 under a standing rule');
    expect(plainDetail('D-3 was the first ruling', keep)).toBe('A decision was the first ruling');
  });

  it('a wait in prose needs an open ask behind it', async () => {
    const { unbackedAsk } = await import('../server/desk/chapter-writer.js');
    const open = [{ kind: 'needs', title: "Accept Claude's updated terms on the new personal account so new threads can use it." }, { kind: 'shipped', title: 'Merged the printer fix' }];
    const live = "Claude's new account still waits on your terms acceptance; three fixes still await your merge, and the printer monitor needs a fix picked.";
    expect(unbackedAsk(live, open)).toBe('three fixes still await your merge');
    expect(unbackedAsk("Claude's new account still waits on your terms acceptance.", open)).toBeNull();
    expect(unbackedAsk('The printer monitor needs a fix picked.', open)).toBe('The printer monitor needs a fix picked.');
    // No wait claimed: nothing to back.
    expect(unbackedAsk('Three fixes shipped and the voice walk is quieter.', [])).toBeNull();
    // Waits said without a waiting word, carried forward in a status after the owner answered them.
    expect(unbackedAsk('Voice control is live on the desk. Next: your four design calls and two voice questions.', [])).toBe('your four design calls and two voice questions.');
    expect(unbackedAsk('Everything is built, but the game stays Private until you pick visibility and sign in; three launch steps are yours.', [])).toBe('the game stays Private until you pick visibility and sign in;');
    expect(unbackedAsk('The game stays Private until you pick visibility.', [{ kind: 'needs', title: 'Pick the game visibility: Public or Unlisted?' }])).toBeNull();
  });

  it('titles, the rules batch and the headline carry no ids; a writer title is short', () => {
    const merged = line({ kind: 'decided', moment: true, source: 'auto:decision', title: 'Merged #864 under R-15 though two review comments were left open for the next PR', decisionId: 'D-110' });
    const lead = line({ kind: 'fyi', moment: true, source: 'lead', title: 'Asked the build thread to add to #864' });
    const view = collapse([merged, lead, rule('R-15'), rule('R-16')], { groups: [], milestone: null, titles: { [String(merged.id)]: 'Merged the collapse PR with two edges left for the next one' } });
    expect(view.titles[merged.id]).toBe('Merged the collapse PR with two edges left…');
    expect(view.titles[lead.id]).toBe('Asked the build thread to add to the PR');
    expect(view.moments.find((m) => m.batch === 'rules')!.title).toBe('2 rule changes');
  });

  it("the chapter's headline is two sentences at most, in plain words, and its status has no ids", () => {
    const { updates } = ledger();
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'x', source: 'lead' });
    updates.setProse('project:desk', { headline: 'Merged #864. R-18 is a rule now. The fix for D-100 still needs your call. And more.', status: 'Next: D-97 (TGO-1106).' }, 'model');
    const chapter = updates.chapters().find((c) => c.spaceId === 'project:desk')!;
    expect(chapter.headline).toBe('Merged the PR. A rule is a rule now.');
    expect(chapter.status).toBe('Next: a decision.');
  });
});

describe('the catch-up after it went live (design check on the live desk)', () => {
  it('splits sentences only at a sentence end, so an address or a version stays whole', async () => {
    const { sentences, fit } = await import('../public/desk/plain-words.js');
    expect(sentences('Mail to sam.lee@example.com from MasterClass is waiting. Yes to all three. More.', 2)).toBe('Mail to sam.lee@example.com from MasterClass is waiting. Yes to all three.');
    expect(sentences('Node 24.19 is live. Done.', 1)).toBe('Node 24.19 is live.');
    // Whole sentences first: two that run long become one, and only a first sentence too long is cut.
    expect(fit('Short one here. ' + 'word '.repeat(40).trim() + '.', 2, 35)).toBe('Short one here.');
    expect(fit('word '.repeat(40).trim() + '.', 2, 35)).toMatch(/^(word ){34}word…$/);
    expect(fit('The desk shipped the rules.', 2, 3)).toBe('The desk shipped…');
  });

  it('drops a clause whose id was all it named, and leaves names that only look like tickets', async () => {
    const { plainWords } = await import('../public/desk/plain-words.js');
    expect(plainWords('Lock-screen stack Ready. Next: TGO-1068.')).toBe('Lock-screen stack Ready.');
    expect(plainWords('Waiting on Riley. Next: TGO-1068')).toBe('Waiting on Riley.');
    expect(plainWords('HTTP-2 is enabled on GPT-4 calls (TGO-12)')).toBe('HTTP-2 is enabled on GPT-4 calls');
    expect(plainWords('SOC-2 and ISO-27001 checks pass')).toBe('SOC-2 and ISO-27001 checks pass');
  });

  it('a title that named only an id reads as a neutral update, never the bare id', () => {
    expect(ownerTitle('TGO-123.')).toBe('An update');
    const auto = line({ kind: 'fyi', moment: true, title: 'TGO-123.' });
    const lead = line({ kind: 'fyi', moment: true, source: 'lead', title: 'Next: TGO-124.' });
    const written = line({ kind: 'fyi', moment: true, title: 'Fixed the dot' });
    const view = collapse([auto, lead, written], { titles: { [String(written.id)]: 'TGO-125' }, groups: [] } as never);
    expect(view.moments.find((m) => m.line === auto.id)?.title).toBe('An update');
    expect(view.moments.find((m) => m.line === lead.id)?.title).toBe('An update');
    expect(view.moments.find((m) => m.line === written.id)?.title).toBe('Fixed the dot');
  });

  it('drops two id-only clauses in a row, and a sentence that was only an id leaves no stray period', async () => {
    const { plainWords } = await import('../public/desk/plain-words.js');
    expect(plainWords('Status: TGO-1. Next: TGO-2.')).toBe('');
    expect(plainWords('TGO-1. Next: TGO-2.')).toBe('');
    expect(plainWords('The next important milestone is: TGO-1068.')).toBe('');
    expect(plainWords('Shipped it. The next important milestone is: TGO-1068. Then rest.')).toBe('Shipped it. Then rest.');
    expect(plainWords('TGO-3 shipped. TGO-4.')).toBe('Shipped.');
    expect(plainWords('Fixed it (TGO-5). Next: TGO-6. Then deploy.')).toBe('Fixed it. Then deploy.');
    expect(plainWords('Wait... v1.2.3 is out?! Yes.')).toBe('Wait... v1.2.3 is out?! Yes.');
  });

  it("caps the status like the headline: where it stands, then its Next", async () => {
    const { ownerStatus } = await import('../server/desk/updates.js');
    expect(ownerStatus('Lock-screen stack Ready. Metrics PRs repaired. Orchard push waits on one click. Next: Riley clicks Confirm. Then more.')).toBe('Lock-screen stack Ready. Next: Riley clicks Confirm.');
    expect(ownerStatus('Quiet. Nothing else. A third.')).toBe('Quiet. Nothing else.');
    expect(ownerStatus('Unfiled is quiet. Next: TGO-1068.')).toBe('Unfiled is quiet.');
  });

  it('rewrites every chapter once when the writer rules change, gap or not', async () => {
    const { updates, clock } = ledger({ writeChapter: async () => ({ headline: 'New voice.', status: 'Fine. Next: nothing.' }) });
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'x', source: 'lead' });
    clock.now += 10 * 60_000;
    await updates.writeChapters();
    expect(updates.chapters().find((c) => c.spaceId === 'project:desk')!.headline).toBe('New voice.');
    // Prose from an older writer, written a minute ago: inside the gap, but rewritten anyway.
    updates.setProse('project:desk', { headline: 'Old voice needs your approval.' }, 'model');
    (updates as unknown as { options: { db: DatabaseSync } }).options.db.prepare('UPDATE desk_chapters SET writer_version = 1').run();
    clock.now += 60_000;
    await updates.writeChapters();
    expect(updates.chapters().find((c) => c.spaceId === 'project:desk')!.headline).toBe('New voice.');
    // Once rewritten, the gap holds again.
    updates.setProse('project:desk', { headline: 'Current.' }, 'model');
    clock.now += 60_000;
    await updates.writeChapters();
    expect(updates.chapters().find((c) => c.spaceId === 'project:desk')!.headline).toBe('Current.');
  });

  it('a decision that only links a PR for context is its own line, not folded into it', () => {
    const shipped = pr(821, "fix(loom,desk): the owner's own rules leave Decided for you");
    const context = line({ kind: 'decided', source: 'auto:decision', class: 'ops-own-machine', title: 'Stopped a sandbox test writing over the live rules', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/821' }] });
    const merge = line({ kind: 'decided', source: 'auto:decision', class: 'merge-when-green', title: 'Merged once green', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/821' }] });
    const named = line({ kind: 'decided', source: 'auto:decision', class: 'ops-own-machine', title: 'Deployed #821 to the desk', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/821' }] });
    const view = collapse([shipped, context, merge, named]);
    expect(view.folded[shipped.id]).toEqual([merge.id, named.id]);
  });

  it("a lead's routine decision that only links a PR for context stays its own line too", () => {
    const shipped = pr(822, 'fix(desk): search shows open conversations first');
    const context = line({ kind: 'decided', source: 'lead', class: 'ops-own-machine', title: 'Stopped a sandbox test writing over the live rules', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/822' }] });
    const merged = line({ kind: 'decided', source: 'lead', class: 'merge-when-green', title: 'Merged the search fix once green', refs: [{ label: 'PR', url: 'https://github.com/o/tango/pull/822' }] });
    expect(collapse([shipped, context]).folded[context.id]).toBeUndefined();
    expect(collapse([shipped, merged]).folded[merged.id]).toEqual([shipped.id]);
  });

  it("binds a restart's parenthesized time to the restart, not to other work", () => {
    expect(costly('Restarted Loom and ran verification (3 min)')).toBe(false);
    expect(costly('Restarted the screen server (3 min)')).toBe(true);
  });
});

describe('the card and the writer, after the live check', () => {
  it('counts the smaller groups in lines, so the parts add up', async () => {
    const { groupsLine } = await import('../public/desk/next/chapter.js');
    const g = (kind: string, n: number) => ({ kind, shown: Array.from({ length: n }, (_, i) => ({ id: i })) });
    expect(groupsLine([g('shipped', 2), g('decided', 1), g('fyi', 2)])).toBe('5 smaller updates: 2 shipped, 1 routine, 2 FYI');
    expect(groupsLine([g('fyi', 1)])).toBe('1 smaller update: 1 FYI');
  });

  it('asks the writer once more when it writes past the card, and keeps the short one', async () => {
    const { createChapterWriter, overLimit } = await import('../server/desk/chapter-writer.js');
    const long = 'word '.repeat(50).trim() + '.';
    const replies = [
      { headline: long, status: 'Fine. Next: x.', groups: [], milestone: null, titles: {} },
      { headline: 'Short now.', status: 'Fine. Next: x.', groups: [], milestone: null, titles: {} },
    ];
    const sent: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }));
    }) as unknown as typeof fetch;
    try {
      const write = createChapterWriter({ apiKey: 'k', model: 'm' });
      const out = await write({ spaceId: 's', name: 'Desk', open: [], handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW });
      expect(out!.headline).toBe('Short now.');
      expect(sent).toHaveLength(2);
      expect(JSON.stringify(sent[0])).toContain('never the internal mechanism');
    } finally {
      globalThis.fetch = real;
    }
    expect(overLimit('One. Two. Three.', 35)).toBe(true);
    expect(overLimit('One. Two.', 35)).toBe(false);
  });
});

describe('a pending ask told as done', () => {
  const open = [{ id: 1, kind: 'needs', moment: true, title: 'Stage the Test 2 holdout rule?', at: NOW }];
  async function run(replies: unknown[]) {
    const { createChapterWriter } = await import('../server/desk/chapter-writer.js');
    const sent: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }));
    }) as unknown as typeof fetch;
    try {
      const out = await createChapterWriter({ apiKey: 'k', model: 'm' })({ spaceId: 's', name: 'Notifications', open, handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW });
      return { out: out!, sent };
    } finally {
      globalThis.fetch = real;
    }
  }
  const reply = (headline: string) => ({ headline, status: 'Fine. Next: x.', groups: [], milestone: null, titles: {} });

  it('goes back to the writer once, and its rewrite stands', async () => {
    const { out, sent } = await run([reply('The Test 2 holdout rule is staged.'), reply('Staging the Test 2 holdout rule waits on you.')]);
    expect(out.headline).toBe('Staging the Test 2 holdout rule waits on you.');
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0])).toContain('An open needs line is not done');
  });

  it('still told as done, the plain headline stands in (what waits is the desk\'s half, so the rest is empty)', async () => {
    const { out } = await run([reply('The Test 2 holdout rule is staged.'), reply('The Test 2 holdout rule is done.')]);
    expect(out.headline).toBe('');
  });
});

describe('the plain fallback', () => {
  it('reads in the owner words, and leaves a chapter due its rewrite for the model on the next pass', async () => {
    const { plainChapter } = await import('../server/desk/chapter-writer.js');
    const out = plainChapter({ spaceId: 's', name: 'Desk', open: [{ id: 1, kind: 'shipped', moment: false, title: 'Merged PR #869: fix(desk): the ask box stays on one line', at: NOW }], handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW });
    expect(out.status).toBe('The ask box stays on one line.');
    let model = false;
    const { updates, clock } = ledger({ writeChapter: async (input) => (model ? { headline: 'Model.', status: 'Fine. Next: x.' } : plainChapter(input)) });
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'x', source: 'lead' });
    updates.setProse('project:desk', { headline: 'Old.' }, 'model');
    (updates as unknown as { options: { db: DatabaseSync } }).options.db.prepare('UPDATE desk_chapters SET writer_version = 1').run();
    clock.now += 10 * 60_000;
    await updates.writeChapters();
    expect(updates.chapters().find((c) => c.spaceId === 'project:desk')!.headline).toBe('X.');
    model = true;
    clock.now += 60_000;
    await updates.writeChapters();
    expect(updates.chapters().find((c) => c.spaceId === 'project:desk')!.headline).toBe('Model.');
  });
});

describe('after review of the live-check fixes', () => {
  it("a lead's own prose is not rewritten when the writer's rules change", async () => {
    let calls = 0;
    const { updates, clock } = ledger({ writeChapter: async () => (calls++, { headline: 'Model.', status: 'Fine. Next: x.' }) });
    updates.record({ spaceId: 'project:desk', kind: 'fyi', title: 'x', source: 'lead' });
    clock.now += 10 * 60_000;
    updates.setProse('project:desk', { headline: 'The lead wrote this.' }, 'lead');
    (updates as unknown as { options: { db: DatabaseSync } }).options.db.prepare('UPDATE desk_chapters SET writer_version = NULL').run();
    clock.now += 60_000;
    await updates.writeChapters();
    expect(calls).toBe(0);
    expect(updates.chapters().find((c) => c.spaceId === 'project:desk')!.headline).toBe('The lead wrote this.');
  });

  it('a restart target can run a few words', () => {
    expect(costly('Restarted the production Redis cache server (3 min)')).toBe(true);
  });

  it('rewrites within a minute of an answer even when its lead posts right after', async () => {
    let n = 0;
    const { updates, clock, db } = ledger({ writeChapter: async () => ({ headline: `h${++n}`, status: `s${n}` }) });
    const brief = updates.record({ spaceId: 'project:desk', kind: 'needs', title: 'Stage the Test 2 holdout rule?', source: 'auto:brief', subject: 'decision:D-1', briefId: 'D-1', at: NOW - HOUR });
    await updates.writeChapters();
    expect(n).toBe(1);
    clock.now += 2 * 60_000;
    // The owner answers (Loom resolves the line), and the lead posts what it did 30 seconds later.
    db.prepare('UPDATE desk_updates SET resolved_at = ?, seen_at = ?, seen_via = ? WHERE id = ?').run(clock.now, clock.now, 'acted', brief.id);
    clock.now += 30_000;
    updates.record({ spaceId: 'project:desk', kind: 'shipped', title: 'The holdout rule is staged.', source: 'lead', at: clock.now });
    clock.now += 61_000;
    await updates.writeChapters();
    expect(updates.chapters()[0]).toMatchObject({ headline: 'h2' });
  });

  it('until then, prose still asking for an answered ask gives way to the plain version', async () => {
    const { updates, clock, db } = ledger({ writeChapter: async () => ({ headline: 'Two things wait on you: stage the Test 2 holdout rule, and one push click on the preview.', status: 'The holdout rule waits on your answer. Next: launch.' }) });
    const brief = updates.record({ spaceId: 'project:desk', kind: 'needs', title: 'Stage the Test 2 holdout rule?', source: 'auto:brief', subject: 'decision:D-1', briefId: 'D-1', at: NOW - HOUR });
    updates.record({ spaceId: 'project:desk', kind: 'needs', title: 'Make one push click on the preview.', source: 'lead', at: NOW - HOUR });
    await updates.writeChapters();
    expect(updates.chapters()[0]!.headline).toMatch(/^Two things wait on you/);
    clock.now += 1000;
    db.prepare('UPDATE desk_updates SET resolved_at = ?, seen_at = ?, seen_via = ? WHERE id = ?').run(clock.now, clock.now, 'acted', brief.id);
    const chapter = updates.chapters()[0]!;
    expect(chapter.headline).toBe('Make one push click on the preview.');
    expect(chapter.needs).toBe(0);
    expect(chapter.status).not.toMatch(/holdout/);
  });
});


describe('catch-up wording from the content audit', () => {
  it('preserves decision URLs and collapses repeated replacement words', async () => {
    const { plainWords, jargonWords } = await import('../public/desk/plain-words.js');
    expect(plainWords('Resolve D-223: https://example.test/decision/D-223')).toBe('Resolve a decision: https://example.test/decision/D-223');
    expect(plainWords('The PR #919 and PR #927 no longer conflict.')).toBe('The PRs no longer conflict.');
    expect(plainWords('#919 and #927 are ready.')).toBe('The PRs are ready.');
    expect(jargonWords('v6, version six, phase 0, round 3, step 2, 97530d0')).toEqual(['v6', 'version six', 'phase 0', 'round 3', 'step 2', '97530d0']);
    expect(jargonWords('Release 1.2.3 uses GPT-4 and HTTP-2.')).toEqual([]);
  });

  it.each([false, true])('retries jargon once and falls back to the original title if needed (repeat: %s)', async (repeat) => {
    const { createChapterWriter } = await import('../server/desk/chapter-writer.js');
    const sent: any[] = [];
    const real = globalThis.fetch;
    const title = 'Stop Catch me up showing answered asks?';
    globalThis.fetch = (async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      const dirty = sent.length === 1 || repeat;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        headline: dirty ? 'Catch me up version six.' : 'Catch me up has answered asks.',
        status: dirty ? 'Catch me up phase 0.' : 'Catch me up needs a fix.',
        titles: { '528': dirty ? 'Approve v6, build in step with v2' : title }, groups: [], milestone: null,
      }) } }] }));
    }) as typeof fetch;
    try {
      const out = await createChapterWriter({ apiKey: 'test', model: 'test' })({
        spaceId: 'project:desk', name: 'Desk', open: [{ id: 528, kind: 'needs', moment: true, title, at: NOW, source: 'auto:brief',
          conversation: '"Catch Up" feature', standing: 'Answered asks still appear.', background: 'Recheck a card when its source changes.' }],
        handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW,
      });
      expect(sent).toHaveLength(2);
      const prompt = sent[0].messages[1].content;
      expect(prompt).toContain('No ticket, PR or version numbers');
      expect(prompt).toContain('(from "\\"Catch Up\\" feature")');
      expect(prompt).toContain('where it stands: Answered asks still appear.');
      expect(prompt).toContain('background: Recheck a card when its source changes.');
      expect(sent[1].messages.at(-1).content).toContain('version six');
      expect(sent[1].messages.at(-1).content).toContain('v6');
      expect(out!.layout!.titles[528]).toBe(title);
      if (repeat) expect(out!.headline).toBe('');
    } finally { globalThis.fetch = real; }
  });
  it('keeps the checked headline when the plain-words rewrite calls a waiting ask done', async () => {
    const { createChapterWriter } = await import('../server/desk/chapter-writer.js');
    const replies = [
      { headline: 'Approve the video crop: it waits on you.', status: 'The crop waits on you. Next: approve it.', titles: { '7': 'Approve the v6 crop?' }, groups: [], milestone: null },
      { headline: 'The video crop is approved.', status: 'Nothing waits. Next: none.', titles: { '7': 'Approve the video crop?' }, groups: [], milestone: null },
    ];
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }))) as unknown as typeof fetch;
    try {
      const out = await createChapterWriter({ apiKey: 'k', model: 'm' })({ spaceId: 's', name: 'Videos', open: [{ id: 7, kind: 'needs', moment: true, title: 'Approve the video crop?', at: NOW }], handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW });
      expect(out!.headline).toBe('Approve the video crop: it waits on you.');
      expect(out!.layout!.titles[7]).toBe('Approve the video crop?');
    } finally { globalThis.fetch = real; }
  });
});

describe('the writer receives a conversation and the brief problem', () => {
  it('carries the source name, standing and first background line, bounded to 300 characters', async () => {
    let received: any;
    const { updates, clock } = ledger({
      items: () => [{ id: 'loom:catchup', facts: { openBrief: { brief: { id: 'D-219', standing: 'Answered asks still appear. ' + 'x'.repeat(400), background: 'Cards should reflect their sources.\nSecond line is not sent.' } } }, summary: { about: 'Catch Up feature', title: 'Approve the fix' } }] as never,
      writeChapter: async (input) => { received = input; return { headline: 'Catch me up waits on you.', status: 'Ready.' }; },
    });
    updates.record({ spaceId: 'project:desk', itemId: 'loom:catchup', briefId: 'D-219', kind: 'needs', title: 'Stop Catch me up showing answered asks?', source: 'auto:brief' });
    clock.now += 10 * 60_000;
    await updates.writeChapters();
    expect(received.open[0]).toMatchObject({ conversation: 'Catch Up feature', background: 'Cards should reflect their sources.' });
    expect(received.open[0].standing).toHaveLength(300);
  });

  it.skipIf(!process.env.CATCHUP_PROMPT_INPUT)('logs the exact writer prompt for a captured space without contacting a model', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { createChapterWriter } = await import('../server/desk/chapter-writer.js');
    const input = JSON.parse(readFileSync(process.env.CATCHUP_PROMPT_INPUT!, 'utf8'));
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      writeFileSync(process.env.CATCHUP_PROMPT_OUTPUT!, body.messages.map((m: any) => `${m.role}:\n${m.content}`).join('\n\n'));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: 'Catch me up is ready.', status: 'Catch me up is ready.', titles: {} }) } }] }));
    }) as typeof fetch;
    try { await createChapterWriter({ apiKey: 'test', model: 'test' })(input); }
    finally { globalThis.fetch = real; }
  });
});

describe('Needs you cleaned up: the writer sorts out chores, asks filed as news, repeats and answered asks', () => {
  const T = NOW - 10 * HOUR;
  const open = [
    { id: 1, kind: 'needs', moment: true, title: 'Approve the crop?', at: T, source: 'auto:brief', brief: true },
    { id: 2, kind: 'needs', moment: true, title: 'reconcile the missing source worktree with the cutover backup record before authorizing further implementation', at: T + 1, source: 'auto:status' },
    { id: 3, kind: 'needs', moment: true, title: 'still open.', at: T + 2, source: 'lead' },
    { id: 4, kind: 'failed', moment: true, title: 'Backup failed', at: T + 3, source: 'auto:status' },
    { id: 5, kind: 'fyi', moment: false, title: 'Three PRs need your merge', at: T + 4, source: 'lead' },
    { id: 6, kind: 'needs', moment: true, title: 'Confirm the Test 2 card in Slack (link 4) before it expires', at: T + 5, source: 'auto:status' },
    { id: 7, kind: 'needs', moment: true, title: 'The Test 2 holdout experiment card is in Slack, waiting for your Confirm.', at: T + 6, source: 'lead' },
    { id: 8, kind: 'needs', moment: true, title: 'Sign in to claude.ai', at: T + 7, source: 'auto:status' },
    { id: 9, kind: 'fyi', moment: false, title: 'The claude.ai account works again', at: T + 8, source: 'lead' },
  ] as const;
  const handled = [{ id: 20, kind: 'fyi', title: 'Ridge Loop is uploaded, private', outcome: null, at: T + 9, source: 'lead' }] as const;

  it('keeps only what may apply: never a brief or a failure as a chore or answered, asks only from news, an answer only from a newer line', async () => {
    const { writtenTriage } = await import('../server/desk/chapter-writer.js');
    const triage = writtenTriage({
      chores: [1, 2, 3, 4, 5, 99, 'x'],
      asks: [5, 9, 2, 99],
      same: [[6, 7, 99], [1, 6], [3]],
      answered: { 8: 9, 1: 9, 4: 9, 2: 9, 6: 6, 7: 1, 99: 9, 3: 20 },
    }, { open: open as never, handled: handled as never });
    expect(triage).toEqual({ chores: [2, 3], asks: [5], same: [[6, 7]], answered: { 8: 9 } });
    // A line goes to one place: answered before repeats.
    expect(writtenTriage({ answered: { 6: 20 }, same: [[6, 7]] }, { open: open as never, handled: handled as never })).toEqual({ chores: [], asks: [], same: [], answered: { 6: 20 } });
    expect(writtenTriage({ chores: [1, 4] }, { open: open as never })).toBeNull();
    expect(writtenTriage('nope', { open: open as never })).toBeNull();
    // Kept in the layout even when the writer wrote no groups or titles.
    expect(writtenLayout({ triage: { chores: [2] } }, { open: open as never })).toEqual({ groups: [], milestone: null, titles: {}, triage: { chores: [2], asks: [], same: [], answered: {} } });
  });

  it('a stored sort reads back with its shape checked, and a layout without one has none', () => {
    expect(readLayout(JSON.stringify({ groups: [], titles: {}, triage: { chores: [1, 'x', 1], same: [[1], [2, 3]], answered: { 4: 5, x: 1, 6: '7' } } }))).toEqual({ groups: [], milestone: null, titles: {}, triage: { chores: [1], asks: [], same: [[2, 3]], answered: { 4: 5 } } });
    expect(readLayout(JSON.stringify({ groups: [], titles: {} }))).toEqual({ groups: [], milestone: null, titles: {} });
  });

  it('the sort is kept as labels and the guards read the lines as the facts have them', async () => {
    const { createChapterWriter } = await import('../server/desk/chapter-writer.js');
    const triage = { chores: [2], asks: [], same: [], answered: {} };
    const replies = [
      { headline: 'The crop waits on you.', status: 'Quiet. Next: x.', groups: [], milestone: null, titles: {}, triage },
    ];
    const sent: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }));
    }) as unknown as typeof fetch;
    try {
      const out = await createChapterWriter({ apiKey: 'k', model: 'm' })({ spaceId: 's', name: 'Videos', open: [open[0], open[1]] as never, handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW });
      expect(out!.headline).toBe('The crop waits on you.');
      expect(out!.layout?.triage).toEqual(triage);
      expect(sent).toHaveLength(1);
      const prompt = JSON.stringify(sent[0]);
      expect(prompt).toContain('triage.chores');
      expect(prompt).toContain('line 1: [needs, moment, auto, brief]');
      expect(prompt).toContain('line 2: [needs, moment, auto, status]');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('a writer that fails gives the plain chapter, with no sort', async () => {
    const { createChapterWriter, plainChapter } = await import('../server/desk/chapter-writer.js');
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    try {
      const input = { spaceId: 's', name: 'Videos', open: [open[0], open[1]] as never, handled: [], previous: { headline: null, status: null }, milestone: null, now: NOW };
      const out = await createChapterWriter({ apiKey: 'k', model: 'm' })(input);
      expect(out).toEqual(plainChapter(input));
      expect(out).not.toHaveProperty('layout');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('as notes on the lines as they are now: nothing moves, a brief or failure is never called noise, and a brief folds only under a brief', async () => {
    const { tidyChapter, crossFolds } = await import('../server/desk/triage.js');
    const brief = line({ kind: 'needs', moment: true, source: 'auto:brief', briefId: 'D-1', title: 'Approve the crop?', at: T });
    const failed = line({ kind: 'failed', moment: true, source: 'lead', title: 'Backup failed', at: T });
    const status = line({ kind: 'needs', moment: true, source: 'auto:status', title: 'Approve the crop now', at: T + 5 });
    const leadAsk = line({ kind: 'needs', moment: true, source: 'lead', title: 'still open.', at: T + 1 });
    const later = line({ kind: 'fyi', source: 'lead', title: 'Crop approved', at: T + 9 });
    const demoted = line({ kind: 'fyi', source: 'auto:status', title: 'Merge it?', status: { pill: 'idle' } as never });
    const merge = line({ kind: 'shipped', source: 'lead', title: 'Three PRs need your merge', at: T + 2 });
    const report = line({ kind: 'shipped', source: 'auto:done', title: 'Scrolling fix merged, deployed and live', at: T + 3 });
    const lines = [brief, failed, status, leadAsk, later, demoted, merge, report];
    const lookup = (id: number) => lines.find((l) => l.id === id) ?? null;
    const tidy = tidyChapter(lines, { chores: [brief.id, failed.id, leadAsk.id], asks: [later.id, demoted.id, brief.id, merge.id, report.id], same: [[status.id, brief.id]], answered: { [brief.id]: later.id, [failed.id]: later.id } }, { lookup, from: () => 'Videos thread' });
    // The writer's same-ask guess folds nothing (only a shared brief or the same words do, below).
    expect(tidy.also).toEqual({});
    expect(tidy.elsewhere).toEqual([]);
    // Notes only: a chore that isn't a brief or failure; an ask on news filed by its writer that addresses the owner
    // (not a needs line the desk demoted, not a report).
    expect(tidy.notes).toEqual({ [leadAsk.id]: { label: 'housekeeping' }, [merge.id]: { label: 'ask' } });
    // Answered only by a newer line.
    expect(tidyChapter([status, later], { chores: [], asks: [], same: [], answered: { [status.id]: later.id } }, { lookup }).notes).toEqual({ [status.id]: { label: 'answered', by: { id: later.id, title: 'Crop approved' } } });
    expect(tidyChapter([status, leadAsk], { chores: [], asks: [], same: [], answered: { [status.id]: leadAsk.id } }, { lookup }).notes).toEqual({});
    // Across spaces: the copy in the most specific space stays; a brief never folds under a line that isn't one.
    const a = line({ kind: 'needs', spaceId: 'unfiled', title: 'Confirm the Test 2 card in Slack.', at: T + 9 });
    const b = line({ kind: 'needs', spaceId: 'project:exp', title: 'confirm the test 2 card in slack', at: T });
    const c = line({ kind: 'needs', spaceId: 'agent:notifications', title: 'Confirm the Test 2 card — in Slack', at: T + 3 });
    const d = line({ kind: 'needs', spaceId: 'unfiled', source: 'auto:brief', briefId: 'D-7', title: 'Approve the crop?', at: T });
    const e = line({ kind: 'needs', spaceId: 'project:exp', source: 'lead', title: 'Approve the crop?', at: T + 1 });
    const f = line({ kind: 'needs', spaceId: 'agent:notifications', source: 'auto:brief', briefId: 'D-8', title: 'Ship the clip?', at: T });
    const g = line({ kind: 'needs', spaceId: 'project:exp', source: 'lead', title: 'Ship the clip?', at: T + 1 });
    const folds = crossFolds([a, b, c, d, e, f, g]);
    // An Unfiled brief never takes a copy Catch me up can show (Unfiled has no page); a brief elsewhere does.
    expect([...folds].map(([id, kept]) => [id, kept.id]).sort()).toEqual([[a.id, b.id], [c.id, b.id], [g.id, f.id]].sort());
    // Two briefs asked in the same words are two decisions: neither folds under the other.
    const h = line({ kind: 'needs', spaceId: 'project:exp', source: 'auto:brief', briefId: 'D-1', title: 'Approve the rollout?', at: T });
    const i = line({ kind: 'needs', spaceId: 'project:ops', source: 'auto:brief', briefId: 'D-2', title: 'Approve the rollout?', at: T + 1 });
    const j = line({ kind: 'needs', spaceId: 'project:ops', source: 'auto:brief', briefId: 'D-2', title: 'Approve the rollout (again)?', at: T + 2 });
    expect([...crossFolds([h, i, j])].map(([id, kept]) => [id, kept.id])).toEqual([[i.id, j.id]]);
    expect(crossFolds([h, i]).size).toBe(0);
    // Two recorded asks in the same words are two errands (each has its own record, steps and Did it): neither folds
    // under the other; the same ask id in another space does; a words-only copy folds under the recorded one.
    const n = line({ kind: 'needs', spaceId: 'project:exp', source: 'auto:status', title: 'Connect the backup drive', at: T, data: { askId: 'A-1', askKind: 'do', askRevision: 1 } });
    const o = line({ kind: 'needs', spaceId: 'project:ops', source: 'auto:status', title: 'Connect the backup drive', at: T + 1, data: { askId: 'A-2', askKind: 'do', askRevision: 1 } });
    const p = line({ kind: 'needs', spaceId: 'agent:notifications', source: 'auto:status', title: 'Connect the backup drive', at: T + 2, data: { askId: 'A-2', askKind: 'do', askRevision: 1 } });
    const q = line({ kind: 'needs', spaceId: 'agent:notifications', source: 'lead', title: 'Connect the backup drive', at: T + 3 });
    expect([...crossFolds([n, o, p, q])].map(([id, kept]) => [id, kept.id]).sort()).toEqual([[p.id, o.id], [q.id, o.id]].sort());
    expect(crossFolds([n, o]).size).toBe(0);
    // A copy in a deferred chapter (off the page until it comes back) never hides the copy that shows.
    const k = line({ kind: 'needs', spaceId: 'project:exp', source: 'lead', title: 'Merge the docs PR?', at: T, backAt: NOW + HOUR, seenVia: 'deferred' });
    const m = line({ kind: 'needs', spaceId: 'agent:notifications', source: 'lead', title: 'Merge the docs PR?', at: T });
    expect([...crossFolds([k, m], NOW)].map(([id, kept]) => [id, kept.id])).toEqual([[k.id, m.id]]);
    expect([...crossFolds([k, m], NOW + 2 * HOUR)].map(([id, kept]) => [id, kept.id])).toEqual([[m.id, k.id]]);
    // A lead's needs post the desk filed as news (its conversation stopped asking) never comes back as an ask.
    const stale = line({ kind: 'fyi', source: 'lead', title: 'Three PRs need your merge', data: { loomId: 'x', filedAs: 'needs' } });
    expect(tidyChapter([stale], { chores: [], asks: [stale.id], same: [], answered: {} }, { lookup }).notes).toEqual({});
  });
});

describe('Needs you cleaned up, in the ledger', () => {
  const T = NOW - 10 * HOUR;
  const asking = (id: string) => ({ id, facts: { pending: { kind: 'question' } }, seen: 'new', disposition: 'active', summary: { title: id === 'loom:b' ? 'Notifications' : 'Experiments' } });
  const items = [asking('loom:a'), asking('loom:b')] as never;
  const names: Record<string, string> = { 'project:exp': 'Experiments', unfiled: 'Unfiled', 'agent:notifications': 'Notifications' };

  function chapter() {
    const { updates } = ledger({ items: () => items, spaceName: (id) => names[id] ?? id });
    const at = (n: number) => T + n * 60_000;
    const brief = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: 'Approve the holdout?', source: 'auto:brief', subject: 'decision:D-1', briefId: 'D-1', at: at(1) });
    const chore = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: "reconcile the missing source's preservation status before work resumes", source: 'auto:status', at: at(2) });
    const ask = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'fyi', title: 'Three PRs need your merge', source: 'lead', at: at(3) });
    const dupA = updates.record({ spaceId: 'project:exp', itemId: 'loom:b', kind: 'needs', title: 'Confirm the Test 2 card in Slack (link 4) before it expires', source: 'auto:status', at: at(4) });
    const dupB = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: 'The Test 2 holdout experiment card is in Slack, waiting for your Confirm.', source: 'lead', at: at(5) });
    const old = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: 'Sign in to claude.ai', source: 'lead', at: at(6) });
    const works = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'fyi', title: 'The claude.ai account works again', source: 'lead', at: at(7) });
    return { updates, brief, chore, ask, dupA, dupB, old, works };
  }

  it("counts only from the facts: the writer's sort is notes and moves no count (R-21)", () => {
    const { updates, brief, chore, ask, dupA, dupB, old, works } = chapter();
    const before = updates.chapters()[0]!;
    expect(before).toMatchObject({ spaceId: 'project:exp', needs: 5 });
    updates.setProse('project:exp', { headline: 'x', layout: { groups: [], milestone: null, titles: {}, triage: { chores: [brief.id, chore.id], asks: [ask.id], same: [[dupA.id, dupB.id]], answered: { [old.id]: works.id, [brief.id]: works.id } } } }, 'model');
    const c = updates.chapters()[0]!;
    expect(c).toMatchObject({ needs: 5, moments: before.moments, smaller: before.smaller });
    const view = updates.view('project:exp', updates.list({ space: 'project:exp' }));
    expect(view.moments.filter((m) => m.kind === 'needs').map((m) => m.line).sort()).toEqual([brief.id, chore.id, dupA.id, dupB.id, old.id].sort());
    // The brief is never called a chore or answered.
    expect(view.tidy?.notes).toEqual({ [chore.id]: { label: 'housekeeping' }, [old.id]: { label: 'answered', by: { id: works.id, title: 'The claude.ai account works again' } }, [ask.id]: { label: 'ask' } });
  });

  it("Accept leaves ask repeats for the owner even when Needs you folds them away", async () => {
    const { planChapter } = await import('../server/desk/catchup-actions.js');
    const { updates } = ledger({ items: () => items, spaceName: (id) => names[id] ?? id });
    updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: 'Confirm the Test 2 card in Slack.', source: 'auto:status', at: T });
    updates.record({ spaceId: 'project:exp', itemId: 'loom:b', kind: 'needs', title: 'confirm the Test 2 card in Slack', source: 'lead', at: T + 1000 });
    const plan = planChapter(updates, 'project:exp', [], NOW);
    expect(plan.folded).toBeUndefined();
    expect(plan.seen).toEqual([]);
    expect(plan.left).toHaveLength(2);
    expect(plan.line).toContain('leaves 2 asks for you');
  });

  it('folds the same ask across spaces into the most specific one, by brief or by its words', () => {
    const { updates } = ledger({ items: () => items, spaceName: (id) => names[id] ?? id });
    const kept = updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: 'Confirm the Test 2 card in Slack.', source: 'auto:status', at: T });
    const unfiled = updates.record({ spaceId: 'unfiled', itemId: 'loom:b', kind: 'needs', title: 'confirm the Test 2 card in Slack', source: 'lead', at: T + 1000 });
    const agent = updates.record({ spaceId: 'agent:notifications', itemId: 'loom:b', kind: 'needs', title: 'Confirm the Test 2 card in Slack!', source: 'lead', at: T + 2000 });
    const byBrief = updates.record({ spaceId: 'unfiled', itemId: 'loom:b', kind: 'needs', title: 'Pick a launch date?', source: 'lead', briefId: 'D-9', at: T });
    const byBriefKept = updates.record({ spaceId: 'agent:notifications', itemId: 'loom:a', kind: 'needs', title: 'When should it launch?', source: 'auto:brief', briefId: 'D-9', subject: 'decision:D-9', at: T });
    const needs = Object.fromEntries(updates.chapters().map((c) => [c.spaceId, c.needs]));
    expect(needs).toEqual({ 'project:exp': 1, unfiled: 0, 'agent:notifications': 1 });
    const there = updates.view('unfiled', updates.list({ space: 'unfiled' }));
    expect(there.tidy?.elsewhere.sort((x, y) => x.id - y.id)).toEqual([{ id: unfiled.id, keptId: kept.id, where: 'Experiments' }, { id: byBrief.id, keptId: byBriefKept.id, where: 'Notifications' }].sort((x, y) => x.id - y.id));
    expect(there.moments).toEqual([]);
    const here = updates.view('project:exp', updates.list({ space: 'project:exp' }));
    expect(here.tidy?.also[String(kept.id)]?.map((a) => a.id).sort()).toEqual([unfiled.id, agent.id].sort());
    expect(here.moments.map((m) => m.line)).toEqual([kept.id]);
  });

  it('with no sort and nothing repeated, the view and counts are as before', () => {
    const { updates } = ledger({ items: () => items });
    updates.record({ spaceId: 'project:exp', itemId: 'loom:a', kind: 'needs', title: 'Approve?', source: 'lead' });
    expect(updates.view('project:exp', updates.list({ space: 'project:exp' }))).not.toHaveProperty('tidy');
    expect(updates.chapters()[0]).toMatchObject({ needs: 1, moments: 1, smaller: 0 });
  });
});

describe('Needs you cleaned up, on the card', () => {
  function nodes(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (node == null || typeof node === 'boolean') return [];
    if (typeof node !== 'object') return [node];
    if (typeof node.type === 'function') return nodes(node.type(node.props));
    return [node, ...nodes(node.props?.children)];
  }
  it('a note is labeled summary text that changes no kind, and a kept repeat names where else it was asked', async () => {
    // @ts-expect-error browser module
    const { viewOf, ChapterBrief } = await import('../public/desk/next/chapter.js');
    const ask = line({ kind: 'fyi', source: 'lead', title: 'Three PRs need your merge' });
    const kept = line({ kind: 'needs', moment: true, source: 'lead', title: 'The Test 2 card waits for your Confirm.' });
    const copy = line({ kind: 'needs', moment: true, source: 'auto:status', title: 'Confirm the Test 2 card in Slack' });
    const chore = line({ kind: 'needs', moment: true, source: 'auto:status', title: 'still open.' });
    const tidy = { also: { [kept.id]: [{ id: copy.id, from: 'Notifications', spaceId: 'project:desk' }] }, elsewhere: [], notes: { [chore.id]: { label: 'housekeeping' as const }, [ask.id]: { label: 'ask' as const } } };
    const lines = [ask, kept, copy, chore];
    const out = viewOf({ view: collapse(lines, null, tidy), lines });
    expect(out.moments.map((m: { line: number; kind: string }) => [m.line, m.kind]).sort()).toEqual([[kept.id, 'needs'], [chore.id, 'needs']].sort());
    expect(out.groups.flatMap((g: { shown: Array<{ id: number; kind: string; note?: string }> }) => g.shown).find((l: { id: number }) => l.id === ask.id)).toMatchObject({ kind: 'fyi', note: 'Summary: this asks you something' });
    const shown = out.moments.find((m: { line: number }) => m.line === kept.id).shown;
    const text = nodes(ChapterBrief({ line: shown, brief: undefined, store: { state: { byId: {}, chapters: {} } }, spaceId: 'project:desk' })).filter((n) => typeof n === 'string').join('');
    expect(text).toContain('Also asked in “Notifications”');
    const choreShown = out.moments.find((m: { line: number }) => m.line === chore.id).shown;
    const choreText = nodes(ChapterBrief({ line: choreShown, brief: undefined, store: { state: { byId: {}, chapters: {} } }, spaceId: 'project:desk' })).filter((n) => typeof n === 'string').join('');
    expect(choreText).toContain('Summary: reads like the agent’s own bookkeeping');
  });
});
