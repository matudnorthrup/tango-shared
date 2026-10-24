import { describe, expect, it } from 'vitest';
import { deskStatus } from '../server/desk/status.js';
import { DEFAULT_VIEWS, matchesView } from '../public/desk/list-views.js';
// @ts-expect-error plain browser module, no types
import { visibleRowOrder, stepRowFocus, NONE, applyFilter, filterOptions, agentOf, agentsOf, breakdownOf, countsOf, placesOf, tallyOf, crumbsOf, HOME_ROUTE, threadRoute, groupByStatus, groupProjects, homeOf, nextAction, previewOf, rowOf, statusOf, statusWords, tallyOf, groupByStatus as groupHeld, threadTitle, tileOf, reachesOwner } from '../public/desk/next/model.js';

// The next layout's row and navigation model (docs/specs/agent-desk-next.md). Invented names only.

const NOW = 1_790_000_000_000;
const projects = [{ id: 'p1', name: 'Desk reliability', color: 'violet', icon: null, createdAt: 0 }];

const item = (over: Record<string, unknown> = {}) => {
  const row = {
  id: 'x',
  source: 'discord',
  kind: 'thread',
  agentId: 'sierra',
  agentName: 'Sierra',
  place: 'Saturday ferry',
  area: null,
  facts: { lastAuthor: 'agent' },
  summary: { gist: 'The 9:10 has two spots left.' },
  artifacts: [],
  nextStep: 'fyi',
  disposition: 'active',
  lastActivityAt: NOW - 5 * 60_000,
  ...over,
  };
  return { ...row, status: deskStatus(row as never, NOW) };
};

describe('thread rows', () => {
  it('titles are the thread’s own: a coding thread without its repo lead, never a summary', () => {
    expect(threadTitle(item({ source: 'loom', agentId: 'loom', place: 'tango · Phone drawer widens the page', summary: { title: 'Fixing it' } }))).toBe('Phone drawer widens the page');
    expect(threadTitle(item({ source: 'loom', place: 'tango · bug: Reconnect double-send' }))).toBe('Reconnect double-send');
    expect(threadTitle(item())).toBe('Saturday ferry');
    expect(threadTitle(item({ kind: 'chapter', place: null }))).toBe('Chat with Sierra');
    expect(threadTitle(item({ facts: { name: 'Ferry for the truck' } }))).toBe('Ferry for the truck');
  });

  it('previews the newest words until a summary covers them: the owner’s just-sent message, then the agent’s reply', () => {
    const summary = { gist: 'The 9:10 has two spots left.', at: 1_000 };
    expect(previewOf(item({ summary }))).toBe('Summary: The 9:10 has two spots left.');
    // Sent after the summary: the owner sees what they wrote while the agent works.
    const sent = item({ summary, facts: { lastAuthor: 'owner', lastOwnerRequest: { text: 'Book **the 9:10**\nfor two', at: 2_000, filedAt: 2_000 } } });
    expect(previewOf(sent)).toBe('You: Book the 9:10 for two');
    // The agent answered: its own words, plain, until the summary catches up.
    const answered = item({ summary, facts: { lastAuthor: 'agent', lastOwnerRequest: { text: 'Book it', at: 2_000 }, lastAgentWords: { text: '## Booked\n- Two seats on the [9:10](https://x.example)', at: 3_000, filedAt: 3_000 } } });
    expect(previewOf(answered)).toBe('Booked Two seats on the 9:10');
    // The summary landed after those words: it speaks for them.
    expect(previewOf({ ...answered, summary: { gist: 'Two seats booked on the 9:10.', at: 4_000 } })).toBe('Summary: Two seats booked on the 9:10.');
    // Words a late poll filed after the summary count from when they were filed.
    expect(previewOf(item({ summary, facts: { lastAuthor: 'owner', lastOwnerRequest: { text: 'and a car', at: 500, filedAt: 1_500 } } }))).toBe('You: and a car');
  });

  it('lives in its project, else its named agent, else its repo; coding threads are never an agent', () => {
    expect(homeOf(item({ facts: { projectId: 'p1' } }), projects)).toMatchObject({ kind: 'project', name: 'Desk reliability' });
    expect(homeOf(item(), projects)).toMatchObject({ kind: 'agent', id: 'sierra', name: 'Sierra' });
    expect(homeOf(item({ agentId: 'sierra-ollama' }), projects)).toMatchObject({ kind: 'agent', id: 'sierra' });
    expect(homeOf(item({ source: 'loom', agentId: 'loom', agentName: 'Loom', area: 'acme' }), projects)).toEqual({ kind: 'repo', id: 'acme', name: 'acme' });
    // A Loom workspace's own icon rides along for the repo tile (the owner's repo icon is the fallback).
    expect(homeOf(item({ source: 'loom', facts: { project: { name: 'acme', icon: 'rocket', color: 'cyan' } } }), projects)).toEqual({ kind: 'repo', id: 'acme', name: 'acme', look: { icon: 'rocket', color: 'cyan' } });
    expect(agentOf(item({ source: 'loom', agentId: 'loom' }))).toBeNull();
  });

  it('on a project’s own page the tile is still the project’s, and the home goes unsaid', () => {
    const inProject = item({ facts: { projectId: 'p1', lastAuthor: 'agent' } });
    expect(tileOf(inProject, projects)).toMatchObject({ kind: 'project' });
    const row = rowOf(inProject, { projects, context: { kind: 'project', id: 'p1' }, now: NOW });
    expect(row.tile).toMatchObject({ kind: 'project', id: 'p1' });
    expect(row.home).toBeNull();
    expect(rowOf(inProject, { projects, now: NOW }).home).toMatchObject({ name: 'Desk reliability' });
  });

  it('an agent’s chat doesn’t repeat the agent as its home', () => {
    expect(rowOf(item({ kind: 'chapter', place: null }), { projects, now: NOW }).home).toBeNull();
    expect(rowOf(item(), { projects, now: NOW }).home).toMatchObject({ kind: 'agent', name: 'Sierra' });
  });

  it('status owns the color; away and waits are quiet facts', () => {
    const snoozed = item({ disposition: 'snoozed', snoozeTrigger: 'desk', nextStep: 'watching', nextStepBasis: 'summary', facts: { lastAuthor: 'agent', background: 'monitoring' } });
    const row = rowOf(snoozed, { projects, now: NOW });
    expect(row.status).toMatchObject({ key: 'waiting', label: 'Waiting' });
    expect(row.facts).toContain('back at my desk');
    expect(rowOf(item({ disposition: 'done' }), { projects, now: NOW }).status).toMatchObject({ key: 'idle' });
  });

  it('the next action is the agent’s own ask, only while it waits on the owner', () => {
    const asking = item({ nextStep: 'your_move', ask: 'Book the 9:10 for the truck?', facts: { lastAuthor: 'agent', pending: { kind: 'question', question: 'Book the 9:10 for the truck?' } } });
    expect(nextAction(asking, NOW)).toBe('Book the 9:10 for the truck?');
    expect(nextAction(item({ ask: 'Book it?' }), NOW)).toBeNull(); // ready, not waiting on the owner
    const failed = item({ nextStep: 'failed', facts: { failed: { at: NOW, reason: 'error', message: 'Provider overloaded' } } });
    expect(nextAction(failed, NOW)).toContain('overloaded');
  });

  it('the summary’s short action never masks a newer ask from the source', () => {
    const base = { nextStep: 'your_move', ask: 'Approve running `npm test`?', facts: { lastAuthor: 'agent', pending: { kind: 'approval', question: 'Approve running `npm test`?' } } };
    const bySummary = item({ ...base, nextStepBasis: 'summary', summary: { gist: 'x', next: 'Review the plan', at: NOW } });
    expect(nextAction(bySummary, NOW)).toBe('Approve running `npm test`?');
    expect(nextAction(item({ ...base, nextStepBasis: 'source:running', summary: { gist: 'x', next: 'Review the plan', at: NOW } }), NOW)).toBe('Approve running `npm test`?');
    const stale = item({ ...base, nextStepBasis: 'source:next-line', lastActivityAt: NOW, summary: { gist: 'x', next: 'Review the plan', at: NOW - 60_000 } });
    expect(nextAction(stale, NOW)).toBe('Approve running `npm test`?');
  });

  it("rows have one pill, with wait details and audience from recorded facts", () => {
    // The server's two markers (desk/status.ts).
    const asking = rowOf(item({ nextStep: 'your_move', seen: 'new', facts: { openAsk: { text: 'Approve?', at: NOW }, running: { since: NOW } } }), { now: NOW });
    expect(asking.status?.key).toBe('needs');
    expect(asking.busy).toBeNull();
    expect(asking.status?.label).toBe('Needs you');
    const quietBusy = rowOf(item({ nextStep: 'working', facts: { background: 'working' } }), { now: NOW });
    expect(quietBusy.status).toMatchObject({ key: 'working' });
    expect(quietBusy.busy).toBeNull();
    // Read or unread is applied here, the moment the owner opens it.
    expect(rowOf(item({ seen: 'seen', facts: { openAsk: { text: 'Approve?', at: NOW } } }), { now: NOW }).status?.key).toBe('needs');
    const waiting = item({ facts: { waits: [{ id: 'w', kind: 'pr', target: 'PR #9 review', armedAt: NOW, lastCheckedAt: NOW }] } });
    expect(rowOf(waiting, { now: NOW }).status).toMatchObject({ key: 'waiting', label: 'Waiting' });
    expect(waiting.status.detail).toBe('PR #9 review · checked 0m ago');
    expect(rowOf(item({ disposition: 'done', status: { move: null, busy: 'working' } }), { now: NOW }).busy).toBeNull();
    // Who a row reaches is the server's call (status.audience): a worker whose owner is gone reaches the owner; a
    // row the server calls a lead's does not, whatever its kind. A server from before that is read by kind.
    expect(reachesOwner(item({ facts: { role: 'worker' }, status: { move: 'needs', busy: null, audience: 'owner' } }))).toBe(true);
    expect(reachesOwner(item({ facts: { role: 'worker', parentItemId: 'lead' } }))).toBe(false);
    expect(reachesOwner(item({ facts: { role: 'worker' } }))).toBe(true);
    expect(reachesOwner(item({}))).toBe(true);
  });

  it('a busy row says what it is on behind the scenes: the first thing in flight, and how many more', () => {
    const inFlight = [
      { kind: 'wait', text: 'merge #724 when CI and Codex review are green', since: NOW - 600_000, until: NOW + 3_600_000 },
      { kind: 'shell', text: 'npm test', since: NOW - 60_000 },
    ];
    const busyItem = item({ nextStep: 'watching', status: { move: 'watching', busy: 'background' }, facts: { lastAuthor: 'agent', inFlight } });
    const busy = rowOf(busyItem, { now: NOW });
    // Waiting already says it beside the pill (statusWords): the fact would repeat it word for word.
    expect(statusWords(busyItem).why).toMatch(/^merge #724 when CI and Codex review are green/);
    expect(busy.facts.some((f: string) => f.startsWith('waiting:'))).toBe(false);
    // Under another pill (no reason beside it), the fact says what is in flight.
    const quiet = { ...busyItem, status: { ...busyItem.status, pill: 'idle' } };
    expect(rowOf(quiet, { now: NOW }).facts).toContain('waiting: merge #724 when CI and Codex review are… +1');
    // While a turn runs the dot already says so: no fact.
    const running = rowOf(item({ nextStep: 'working', facts: { lastAuthor: 'agent', running: { since: NOW }, inFlight } }), { now: NOW });
    expect(running.facts.some((f: string) => f.startsWith('waiting:'))).toBe(false);
    // A watcher watches; a wait whose checks fail says so.
    const watchItem = item({ facts: { lastAuthor: 'agent', inFlight: [{ kind: 'shell', text: 'tail the deploy log', since: NOW, watcher: true }, { kind: 'wait', text: 'preview up', since: NOW, error: 'ECONNREFUSED' }] } });
    expect(rowOf({ ...watchItem, status: { ...watchItem.status, pill: 'idle' } }, { now: NOW }).facts).toEqual(expect.arrayContaining(['watching: tail the deploy log +1', 'wait check failing']));
    // A background job is in flight too.
    expect(rowOf(item({ facts: { lastAuthor: 'agent', job: { id: 'j1', agentId: 'sierra', label: 'Nightly import', startedAt: NOW, deadlineAt: null } } }), { now: NOW }).facts).toContain('running: Nightly import');
  });

  it('shows linked fan-out progress only as a link, preserving other wait details', () => {
    const text = '4 probes · 2 done · test-account';
    const parent = item({ facts: { inFlight: [{ kind: 'agent', text, watcher: true, url: '/artifacts/batch/results.json' }] } });
    expect(parent.status.detail).toBe(text);
    expect(statusWords(parent).why).toBeNull();
    expect(rowOf(parent, { now: NOW }).facts).not.toContain(text);
    expect(statusWords({ ...parent, status: { ...parent.status, detail: 'Review overdue' } }).why).toBe('Review overdue');
    const unlinked = item({ facts: { inFlight: [{ kind: 'agent', text, watcher: true }] } });
    expect(statusWords(unlinked).why).toBe(text);
  });

  it('every row has one of six pills, independent of the retired live vocabulary', () => {
    for (const live of ['needs', 'ready', 'failed', 'todo', 'working', 'watching', 'fyi', 'sent']) {
      const row = { ...item(), status: { pill: 'idle', live, move: null, busy: null } };
      expect(statusOf(row, NOW)).toMatchObject({ key: 'idle', label: 'Idle' });
      expect(rowOf(row, { now: NOW }).status).toMatchObject({ key: 'idle', label: 'Idle' });
    }
  });

  it('a held message says Waiting and why, never Failed', () => {
    const held = item({ status: { live: 'held', move: null, busy: null }, facts: { lastAuthor: 'owner', held: { reason: 'disk_low' } } });
    expect(statusOf(held, NOW)).toMatchObject({ key: 'waiting', label: 'Waiting', cls: 'watching' });
    const limit = item({ status: { live: 'held', move: null, busy: null }, facts: { lastAuthor: 'owner', held: { reason: 'account_limit', until: Date.now() + 3_600_000 } } });
    expect(statusOf(limit, NOW)?.label).toBe('Waiting');
    expect(statusOf(item({ status: { live: 'held', move: null, busy: null }, facts: { held: { reason: 'something_new' } } }), NOW)?.label).toBe('Waiting');
  });

  it('a held thread is Waiting in Active and the status tally', () => {
    const held = item({ id: 'h', status: { live: 'held', move: null, busy: null }, facts: { lastAuthor: 'owner', held: { reason: 'disk_low' } } });
    expect(matchesView(held, DEFAULT_VIEWS.find((v: { id: string }) => v.id === 'active'))).toBe(true);
    expect(groupHeld([held], NOW).map((g: { key: string }) => g.key)).toEqual(['waiting']);
    const tally = tallyOf([held], NOW);
    expect(tally.by.waiting).toBe(1);
    expect(Object.values(tally.by).every((n) => Number.isFinite(n))).toBe(true);
  });

  it('a Later row keeps its pill and wake time without adding to the owner count', () => {
    const away = (disposition: string) => item({ disposition, seen: 'new', nextStep: 'your_move', snoozeUntil: NOW + 86_400_000, facts: { openAsk: { text: 'Approve?', at: NOW } }, status: { live: 'needs', move: 'needs', busy: null, unread: true, audience: 'owner' } });
    for (const d of ['snoozed', 'parked']) {
      expect(statusOf(away(d), NOW), d).toMatchObject({ key: 'needs' });
      expect(away(d).status.countsForOwner).toBe(false);
      expect(rowOf(away(d), { now: NOW }).status, d).toMatchObject({ key: 'needs' });
    }
    expect(rowOf(away('snoozed'), { now: NOW }).facts.length).toBeGreaterThan(0); // its wake label
    expect(statusOf(away('active'), NOW)?.key).toBe('needs');
  });

  it('groups by what the owner deals with first; away and done last', () => {
    const groups = groupByStatus(
      [
        item({ id: 'a', disposition: 'done' }),
        item({ id: 'b', nextStep: 'your_move', facts: { pending: { kind: 'question' } } }),
        item({ id: 'c', facts: { running: { since: NOW } } }),
        item({ id: 'd', disposition: 'snoozed' }),
      ],
      NOW,
    );
    expect(groups.map((g: { key: string }) => g.key)).toEqual(['needs', 'working', 'away', 'done']);
  });

  it('a reply past an open question leaves Needs you for Sent, with the owner’s words as the preview', () => {
    const replied = item({ id: 's', lastOwnerMessageAt: NOW, facts: { pending: { kind: 'question', requestId: 'q', at: NOW - 60_000 }, lastAuthor: 'owner', lastOwnerRequest: { text: 'Go with B', at: NOW, filedAt: NOW } } });
    expect(statusOf(replied, NOW)).toMatchObject({ key: 'working', label: 'Sent' });
    expect(rowOf(replied, { now: NOW }).preview).toBe('You: Go with B');
    expect(statusWords(replied).ask).toBe(null);
    const groups = groupByStatus([replied, item({ id: 'c', facts: { running: { since: NOW } } })], NOW);
    expect(groups.map((g: { key: string; label: string }) => [g.key, g.label])).toEqual([['sent', 'Sent'], ['working', 'Working']]);
  });

  it('orders a section by the owner’s last message, so agent activity never moves a row', () => {
    const running = { running: { since: NOW } };
    const groups = groupByStatus(
      [
        item({ id: 'busy', lastOwnerMessageAt: NOW - 9000, lastActivityAt: NOW, facts: running }),
        item({ id: 'asked', lastOwnerMessageAt: NOW - 1000, lastActivityAt: NOW - 900, facts: running }),
        item({ id: 'agents', lastOwnerMessageAt: null, createdAt: NOW - 5000, lastActivityAt: NOW - 1, facts: running }),
      ],
      NOW,
    );
    expect(groups[0].items.map((i: { id: string }) => i.id)).toEqual(['asked', 'agents', 'busy']);
  });

  it('groups active pins by pill; away and done pins stay with their placement', () => {
    const groups = groupByStatus(
      [
        item({ id: 'a', nextStep: 'your_move', facts: { pending: { kind: 'question' } } }),
        item({ id: 'b', facts: { pinned: true, running: { since: NOW } } }),
        item({ id: 'c', disposition: 'snoozed', facts: { pinned: true } }),
        item({ id: 'd', disposition: 'done', facts: { pinned: true } }),
      ],
      NOW,
    );
    expect(groups.map((g: { key: string; items: Array<{ id: string }> }) => [g.key, g.items.map((i) => i.id)])).toEqual([['needs', ['a']], ['working', ['b']], ['away', ['c']], ['done', ['d']]]);
  });
});

describe('the Inbox filter', () => {
  const items = [
    item({ id: 'a', facts: { type: 'bug', projectId: 'p1' } }),
    item({ id: 'b', facts: { type: 'feat' } }),
    item({ id: 'c', source: 'loom', agentId: 'loom', area: 'tango', facts: { type: 'bug', stage: 'building' } }),
  ];
  it('keeps what matches every facet with picks; none means no value', () => {
    expect(applyFilter(items, {}, projects).map((i: { id: string }) => i.id)).toEqual(['a', 'b', 'c']);
    expect(applyFilter(items, { type: ['bug'] }, projects).map((i: { id: string }) => i.id)).toEqual(['a', 'c']);
    expect(applyFilter(items, { type: ['bug'], project: [NONE] }, projects).map((i: { id: string }) => i.id)).toEqual(['c']);
    expect(applyFilter(items, { repo: ['tango'] }, projects).map((i: { id: string }) => i.id)).toEqual(['c']);
  });
  it('offers each facet’s values with counts', () => {
    const o = filterOptions(items, projects);
    expect(o.type).toBeUndefined(); // Type is removed from view; stored values remain.
    expect(o.project.map((p: { label: string }) => p.label)).toEqual(['Desk reliability', 'No project']);
  });
});

describe('places and the breadcrumb', () => {
  it('names the path you took to a thread', () => {
    const views = [{ id: 'ready', name: 'Needs you' }, { id: 'active', name: 'Active' }];
    expect(crumbsOf({ page: 'inbox', view: 'ready' }, { views, thread: 'Saturday ferry' }).map((c: { label: string }) => c.label)).toEqual(['Inbox', 'Needs you', 'Saturday ferry']);
    expect(crumbsOf({ page: 'project', id: 'p1' }, { projects, thread: 'Reconnect' }).map((c: { label: string }) => c.label)).toEqual(['Projects', 'Desk reliability', 'Reconnect']);
    expect(crumbsOf({ page: 'project', id: 'p1' }, { projects, thread: 'Reconnect' })[1]).toMatchObject({ tile: { kind: 'project', id: 'p1' } });
    expect(crumbsOf({ page: 'agent', id: 'sierra' }, { agents: [{ id: 'sierra', name: 'Sierra' }] }).map((c: { label: string }) => c.label)).toEqual(['Agents', 'Sierra']);
    expect(crumbsOf({ page: 'inbox', view: 'ready' }, { views }).map((c: { label: string }) => c.label)).toEqual(['Inbox']);
  });

  it('nests a worker or job under the conversation it reports to, which opens it', async () => {
    // @ts-expect-error plain browser module, no types
    const { ownerCrumb } = await import('../public/desk/next/model.js');
    const lead = item({ id: 'lead', source: 'loom', place: 'tango · Desk lead', facts: { role: 'default', projectId: 'p1' } });
    const thread = item({ id: 'dd', source: 'loom', place: 'tango · Decision Delegation', facts: { projectId: 'p1' } });
    const worker = item({ id: 'w', source: 'loom', place: 'tango · Phase 3', facts: { role: 'worker', parentItemId: 'dd', projectId: 'p1' } });
    const toLead = item({ id: 'w2', source: 'loom', place: 'tango · Cleanup', facts: { role: 'worker', parentItemId: 'lead', projectId: 'p1' } });
    const chat = item({ id: 'chat', kind: 'chapter', agentId: 'sierra', agentName: 'Sierra', facts: {} });
    const job = item({ id: 'j', agentId: 'sierra', agentName: 'Sierra', facts: { name: 'Fuel watch', role: 'ops', parentItemId: 'chat' } });
    const nested = item({ id: 'j2', agentId: 'sierra', agentName: 'Sierra', facts: { name: 'Fuel retry', role: 'ops', parentItemId: 'j' } });
    const gone = item({ id: 'w3', source: 'loom', place: 'tango · Orphan', facts: { role: 'worker', parentItemId: 'missing' } });
    const lists = { active: { items: [lead, thread, worker, toLead, chat, job, nested, gone] } };
    const labels = (route: object, it: any) => crumbsOf(route, { projects, agents: [{ id: 'sierra', name: 'Sierra' }], thread: threadTitle(it), owner: ownerCrumb(it, lists) }).map((c: { label: string }) => c.label);
    expect(ownerCrumb(worker, lists)).toEqual({ label: 'Decision Delegation', owner: 'dd' });
    expect(ownerCrumb(job, lists)).toEqual({ label: 'Sierra', owner: 'chat', chatOf: 'sierra' });
    expect(labels({ page: 'project', id: 'p1' }, worker)).toEqual(['Projects', 'Desk reliability', 'Decision Delegation', 'Phase 3']);
    // The space's lead goes by the lead's name; the root still follows the path you took.
    expect(labels({ page: 'project', id: 'p1' }, toLead)).toEqual(['Projects', 'Desk reliability', 'Desk lead', 'Cleanup']);
    expect(labels({ page: 'inbox', view: null }, worker)).toEqual(['Inbox', 'Decision Delegation', 'Phase 3']);
    // An agent's job reporting to its chat doesn't say the agent twice; one reporting to another job names it.
    expect(labels({ page: 'agent', id: 'sierra' }, job)).toEqual(['Agents', 'Sierra', 'Fuel watch']);
    expect(labels({ page: 'agent', id: 'sierra' }, nested)).toEqual(['Agents', 'Sierra', 'Fuel watch', 'Fuel retry']);
    // A different conversation that shares the place's name still shows: identity, not label (Codex review on #772).
    const namesake = item({ id: 'ns', source: 'loom', place: 'tango · Desk reliability', facts: { projectId: 'p1' } });
    const under = item({ id: 'w4', source: 'loom', place: 'tango · Probe', facts: { role: 'worker', parentItemId: 'ns', projectId: 'p1' } });
    const lists2 = { active: { items: [namesake, under] } };
    expect(crumbsOf({ page: 'project', id: 'p1' }, { projects, thread: 'Probe', owner: ownerCrumb(under, lists2) }).map((c: { label: string }) => c.label)).toEqual(['Projects', 'Desk reliability', 'Desk reliability', 'Probe']);
    // Opened from the Inbox, the agent's chat is named: no agent crumb stands for it there.
    expect(labels({ page: 'inbox', view: null }, job)).toEqual(['Inbox', 'Sierra', 'Fuel watch']);
    // A Loom default in an agent space is that agent's chat too; a project's default isn't (Codex review on #772).
    const meridianLead = item({ id: 'ml', agentId: 'loom', agentName: 'Loom', source: 'loom', place: 'acme · Compass', facts: { role: 'default', agentSpace: { id: 'compass', name: 'Compass' } } });
    const prOps = item({ id: 'po', agentId: 'loom', agentName: 'Loom', source: 'loom', place: 'acme · Release Notes', facts: { role: 'ops', parentItemId: 'ml', agentSpace: { id: 'compass', name: 'Compass' } } });
    const lists3 = { active: { items: [prOps] }, everything: { items: [meridianLead, prOps] } };
    expect(ownerCrumb(prOps, lists3)).toEqual({ label: 'Compass', owner: 'ml', chatOf: 'compass' });
    expect(crumbsOf({ page: 'agent', id: 'compass' }, { agents: [{ id: 'compass', name: 'Compass' }], thread: 'Release Notes', owner: ownerCrumb(prOps, lists3) }).map((c: { label: string }) => c.label)).toEqual(['Agents', 'Compass', 'Release Notes']);
    expect(ownerCrumb(toLead, lists)).toEqual({ label: 'Desk lead', owner: 'lead' });
    // A thread, a default, or an owner that's gone: no owner crumb.
    expect(ownerCrumb(thread, lists)).toBeNull();
    expect(ownerCrumb(lead, lists)).toBeNull();
    expect(ownerCrumb(gone, lists)).toBeNull();
    // Only under an open thread.
    expect(crumbsOf({ page: 'project', id: 'p1' }, { projects, owner: ownerCrumb(worker, lists) }).map((c: { label: string }) => c.label)).toEqual(['Projects', 'Desk reliability']);
  });

  it('offers a worker or job its space’s lead first, then the space’s other threads, never itself or its own workers', async () => {
    // @ts-expect-error plain browser module, no types
    const { ownerChoices, spaceOf } = await import('../public/desk/next/model.js');
    const lead = item({ id: 'lead', source: 'loom', place: 'tango · Desk lead', lastActivityAt: NOW - 9000, facts: { role: 'default', projectId: 'p1' } });
    const a = item({ id: 'a', source: 'loom', place: 'tango · Old thread', lastActivityAt: NOW - 5000, facts: { projectId: 'p1' } });
    const b = item({ id: 'b', source: 'loom', place: 'tango · New thread', lastActivityAt: NOW - 1000, facts: { projectId: 'p1' } });
    const me = item({ id: 'me', source: 'loom', place: 'tango · Me', facts: { projectId: 'p1' } });
    const mine = item({ id: 'mine', source: 'loom', place: 'tango · My worker', facts: { role: 'worker', parentItemId: 'me', projectId: 'p1' } });
    const sib = item({ id: 'sib', source: 'loom', place: 'tango · Sibling worker', facts: { role: 'worker', parentItemId: 'lead', projectId: 'p1' } });
    const elsewhere = item({ id: 'x', source: 'loom', place: 'tango · Elsewhere', facts: {} });
    const lists = { active: { items: [lead, a, b, me, mine, sib, elsewhere] } };
    const got = ownerChoices(lists, spaceOf(me, projects), projects, { self: 'me' });
    expect(got.lead.id).toBe('lead');
    expect(got.choices.map((c: { id: string }) => c.id)).toEqual(['lead', 'b', 'a']);
    // A new one on the sheet (no self yet): the same space, its lead first.
    expect(ownerChoices(lists, { kind: 'project', id: 'p1' }, projects).choices.map((c: { id: string }) => c.id)).toEqual(['lead', 'b', 'a', 'me']);
    // An agent's chat is its lead.
    const chat = item({ id: 'chat', kind: 'chapter', agentId: 'sierra', agentName: 'Sierra', facts: {} });
    const t = item({ id: 'st', agentId: 'sierra', agentName: 'Sierra', facts: { name: 'Fuel' } });
    expect(ownerChoices({ active: { items: [t, chat] } }, { kind: 'agent', id: 'sierra' }, projects).choices.map((c: { id: string }) => c.id)).toEqual(['chat', 'st']);
    // Its only chat finished: no lead, never the done chat (Codex review on #854).
    const ended = { ...chat, disposition: 'done' };
    expect(ownerChoices({ active: { items: [t] }, history: { items: [ended] } }, { kind: 'agent', id: 'sierra' }, projects)).toMatchObject({ lead: null, choices: [{ id: 'st' }] });
    // No default in the space: no lead, the threads still offered.
    expect(ownerChoices({ active: { items: [a, b] } }, { kind: 'project', id: 'p1' }, projects)).toMatchObject({ lead: null });
  });

  it('follows a thread opened from a project into the project it moves to', () => {
    const both = [...projects, { id: 'p2', name: 'Billing' }];
    const route = { page: 'project', id: 'p1' };
    const inP1 = { id: 't', facts: { projectId: 'p1' } };
    expect(threadRoute(route, inP1, both)).toBe(route);
    expect(threadRoute(route, { id: 't', facts: { projectId: 'p2' } }, both)).toEqual({ page: 'project', id: 'p2' });
    expect(crumbsOf(threadRoute(route, { id: 't', facts: { projectId: 'p2' } }, both), { projects: both, thread: 'Reconnect' }).map((c: { label: string }) => c.label)).toEqual(['Projects', 'Billing', 'Reconnect']);
    // Out of any project: the Inbox. Not loaded yet: where it was opened.
    expect(threadRoute(route, { id: 't', facts: {} }, both)).toEqual({ page: 'inbox', view: null });
    expect(threadRoute(route, null)).toBe(route);
    // Projects not loaded yet (a reload): follows the thread's id, never falls back to the Inbox.
    expect(threadRoute(route, { id: 't', facts: { projectId: 'p2' } }, [], false)).toEqual({ page: 'project', id: 'p2' });
    expect(threadRoute(route, inP1, [], false)).toBe(route);
    // Its project deleted (the thread keeps the id): the Inbox, as for a thread on its own.
    expect(threadRoute(route, inP1, [{ id: 'p2', name: 'Billing' }])).toEqual({ page: 'inbox', view: null });
    // Opened from the Inbox or an agent: the path you took stays.
    const inbox = { page: 'inbox', view: 'ready' };
    expect(threadRoute(inbox, { id: 't', facts: { projectId: 'p2' } }, both)).toBe(inbox);
  });

  it('lists named agents with open and needs-you counts, never coding threads', () => {
    const lists = {
      active: { items: [item({ id: 'a' }), item({ id: 'b', agentId: 'sierra-ollama', nextStep: 'your_move', facts: { pending: { kind: 'q' } } }), item({ id: 'c', source: 'loom', agentId: 'loom', agentName: 'Loom' })] },
      snoozed: { items: [item({ id: 'e', agentId: 'victor', agentName: 'Victor', disposition: 'parked', facts: { pending: { kind: 'q' } } })] },
      history: { items: [item({ id: 'd', agentId: 'victor', agentName: 'Victor', disposition: 'done' })] },
    };
    expect(agentsOf(lists, NOW)).toEqual([
      { id: 'sierra', name: 'Sierra', open: 2, needs: 1 },
      { id: 'victor', name: 'Victor', open: 1, needs: 0 },
    ]);
  });
});

describe('sidebar counts', () => {
  const threads = [
    item({ id: 'a', facts: { pending: { kind: 'q' } } }),
    item({ id: 'b', seen: 'seen' }),
    item({ id: 'h', seen: 'updated' }),
    item({ id: 'c', facts: { running: true } }),
    item({ id: 'd', facts: { lastAuthor: 'owner' }, lastActivityAt: NOW }),
    item({ id: 'e', disposition: 'snoozed' }),
    item({ id: 'f', disposition: 'parked' }),
    item({ id: 'g', disposition: 'done' }),
  ];

  it('counts recorded owner requests; other states and Later never add an owner count', () => {
    const t = tallyOf(threads, NOW);
    expect([t.waiting, t.active]).toEqual([1, 5]);
    expect(breakdownOf(t)).toEqual([[1, 'needs you', 'move']]);
    expect(tallyOf([], NOW)).toMatchObject({ waiting: 0, active: 0 });
  });

  it("a project's counts leave snoozed and parked out of needs you, even with an open request", () => {
    const away = [item({ id: 's', disposition: 'snoozed', facts: { pending: { kind: 'q' } } }), item({ id: 'p', disposition: 'parked', facts: { lastAuthor: 'agent' } })];
    expect(countsOf([...threads, ...away], NOW)).toMatchObject({ needs: 1, open: 9 });
  });

  it('opening a failure keeps its owner count; a stale starting message is Unknown', () => {
    const failed = { nextStep: 'failed', facts: { failed: { at: 1 }, lastAuthor: 'agent' } };
    expect(tallyOf([item({ id: 'f1', ...failed, seen: 'new' })], NOW).waiting).toBe(1);
    const read = tallyOf([item({ id: 'f2', ...failed, seen: 'seen' })], NOW);
    expect([read.waiting, read.by.failed]).toEqual([1, 1]);
    // A turn that failed after the owner's message: read, it is out of the count like any other read failure.
    const afterOwner = item({ id: 'f3', seen: 'seen', nextStep: 'failed', facts: { failed: { at: 1 }, lastAuthor: 'owner' }, lastOwnerMessageAt: NOW - 10 * 60_000 });
    expect(tallyOf([afterOwner], NOW).waiting).toBe(1);
    expect(tallyOf([{ ...afterOwner, seen: 'new' }], NOW).waiting).toBe(1);
    const stalled = item({ id: 's', seen: 'seen', nextStep: 'working', facts: { lastAuthor: 'owner' }, lastOwnerMessageAt: NOW - 10 * 60_000 });
    expect(tallyOf([stalled], NOW).waiting).toBe(0);
    expect(statusOf(stalled, NOW).key).toBe('unknown');
  });

  it('says where a view’s threads are, most first', () => {
    const ps = [{ id: 'p1', name: 'Desk reliability' }];
    const rows = [item({ id: 'a', facts: { projectId: 'p1' } }), item({ id: 'b', facts: { projectId: 'p1' } }), item({ id: 'c', agentId: 'watson', agentName: 'Watson' })];
    expect(placesOf(rows, ps)).toEqual([[2, 'Desk reliability'], [1, 'Watson']]);
  });
});

describe('projects page', () => {
  it('groups projects Active, Snoozed, Parked, Done, leaving out empty groups', () => {
    const ps = [
      { id: 'a', name: 'Ferry', finishedAt: null, away: null },
      { id: 'b', name: 'Garden', finishedAt: NOW, away: { state: 'parked' } },
      { id: 'c', name: 'Roof', finishedAt: null, away: { state: 'parked' } },
      { id: 'd', name: 'Boat', finishedAt: null, away: { state: 'snoozed', until: NOW + 60_000 } },
    ];
    expect(groupProjects(ps, NOW).map((g: { key: string; items: { id: string }[] }) => [g.key, g.items.map((p) => p.id)])).toEqual([
      ['active', ['a']],
      ['snoozed', ['d']],
      ['parked', ['c']],
      ['done', ['b']],
    ]);
    expect(groupProjects([ps[0]]).map((g: { key: string }) => g.key)).toEqual(['active']);
    // A snooze past its time is active before the server's wake tick clears it (Codex review on #597).
    expect(groupProjects([{ id: 'e', finishedAt: null, away: { state: 'snoozed', until: NOW - 1 } }], NOW).map((g: { key: string }) => g.key)).toEqual(['active']);
  });
});

// @ts-expect-error plain browser module, no types
import { nextListReport } from '../public/desk/next/model.js';

describe('next voice report', () => {
  const state = (extra = {}) => ({ now: NOW, projects, nextRoute: { page: 'inbox', view: 'all' }, listTab: 'all', listCollapsed: [], listViews: [{ id: 'all', name: 'All', status: ['active'], group: 'none', sort: 'recent', fold: false }], lists: { active: { items: [item({ id: 'older' }), item({ id: 'newer', lastActivityAt: NOW })] }, history: { loaded: true, items: [] } }, ...extra });
  it('matches Inbox order and filter', () => {
    expect(nextListReport(state()).rows.map((r: any) => r.id)).toEqual(['newer', 'older']);
    expect(nextListReport(state({ nextFilter: { agent: ['other'] } })).rows).toEqual([]);
  });
  it('a worker shows what it reports to, even its own space’s lead on that space’s page', async () => {
    // @ts-expect-error plain browser module, no types
    const { trailOf } = await import('../public/desk/next/model.js');
    const lead = item({ id: 'lead', source: 'loom', place: 'tango · Tango Desk lead', facts: { role: 'default', projectId: 'p1' } });
    const worker = item({ id: 'w', source: 'loom', place: 'tango · A worker', facts: { role: 'worker', parentItemId: 'lead', projectId: 'p1' } });
    const lists = { active: { items: [lead, worker] } };
    expect(trailOf(worker, lists, null)).toEqual(['Tango Desk lead']);
    expect(trailOf(worker, lists, { name: 'Tango Desk' })).toEqual(['Tango Desk', 'Tango Desk lead']);
  });
  it('a conversation in an agent space belongs to that agent, under its own name', () => {
    const compass = item({ id: 'm', agentId: 'loom', agentName: 'Loom', source: 'loom', place: 'acme · Compass', facts: { agentSpace: { id: 'compass', name: 'Compass' } } });
    const lists = { active: { items: [compass] }, history: { loaded: true, items: [] } };
    expect(nextListReport(state({ lists, nextRoute: { page: 'agents' } })).rows.map((r: any) => [r.id, r.title])).toContainEqual(['compass', 'Compass']);
    // Its default is its chat: pinned first on its page, once (Codex review on #701).
    const lead = item({ id: 'lead', agentId: 'loom', agentName: 'Loom', source: 'loom', place: 'acme · Compass', facts: { role: 'default', agentSpace: { id: 'compass', name: 'Compass' } } });
    const desk = item({ id: 'desk', agentId: 'loom', agentName: 'Loom', source: 'loom', place: 'acme · Release Notes', facts: { role: 'ops', parentItemId: 'lead', agentSpace: { id: 'compass', name: 'Compass' } }, status: { move: null, busy: null } });
    const rows = (more = {}) => nextListReport(state({ lists: { active: { items: [lead, desk] }, history: { loaded: true, items: [] } }, nextRoute: { page: 'agent', id: 'compass' }, ...more })).rows.map((r: any) => r.id);
    // What reports to the chat is folded under it, as the list draws it, until the owner opens it.
    expect(rows()).toEqual(['lead']);
    expect(rows({ workersOpen: ['lead'] })).toEqual(['lead', 'desk']);
  });
  it('a job’s row leads with its title, not an ask meant for what it reports to', () => {
    const job = item({ id: 'job', nextStep: 'your_move', nextStepBasis: 'summary', summary: { next: 'Run the database script' }, facts: { role: 'ops', parentItemId: 'lead' }, status: { move: null, busy: null } });
    const lists = { active: { items: [job] }, history: { loaded: true, items: [] } };
    expect(nextListReport(state({ lists })).rows).toEqual([]); // and never an Inbox row
    expect(rowOf(job, { now: NOW }).next).toBeNull();
  });
  it('names every page by its own name', () => {
    const name = (route: object) => nextListReport(state({ nextRoute: route })).place.name;
    expect(name({ page: 'capacity' })).toBe('Capacity');
    expect(name({ page: 'search' })).toBe('Search');
    expect(name({ page: 'spacesettings', id: 'project:p1' })).toBe(`${projects.find((p: { id: string }) => p.id === 'p1').name} settings`);
    expect(name({ page: 'agents' })).toBe('Agents');
  });
  it('reports the page’s own views and the one it is on, so voice can switch them (sweep RC2)', () => {
    const lead = item({ id: 'lead', place: 'tango · Tango Desk lead', facts: { role: 'default', projectId: 'p1' } });
    const worker = item({ id: 'w', place: 'tango · A worker', facts: { role: 'worker', parentItemId: 'lead', projectId: 'p1' } });
    const lists = { active: { items: [lead, worker] }, history: { loaded: true, items: [] } };
    const page = nextListReport(state({ lists, nextRoute: { page: 'project', id: 'p1' } }));
    expect(page.views.map((v: { id: string }) => v.id)).toEqual(['overview', 'threads', 'workers']);
    expect(page.view).toEqual({ id: 'overview', name: 'Overview' });
    const workers = nextListReport(state({ lists, nextRoute: { page: 'project', id: 'p1' }, nextPageViews: { 'project:p1': 'workers' } }));
    expect(workers.view.id).toBe('workers');
    expect(workers.rows.map((r: { id: string }) => r.id)).toEqual(['w']);
    // The Inbox's views are its tabs.
    const inbox = nextListReport(state());
    expect(inbox.views).toEqual(inbox.tabs);
    expect(inbox.view.id).toBe(inbox.tab.id);
    // A page without view pills has no views (Codex review on #715).
    expect(nextListReport(state({ nextRoute: { page: 'search' } })).views).toEqual([]);
  });
  it('leaves jobs on schedule out of the counts', () => {
    const t = tallyOf([item({ id: 'a' }), item({ id: 'job', facts: { role: 'ops' }, status: { move: null, busy: null } }), item({ id: 'bad', nextStep: 'failed', facts: { role: 'ops', failed: { at: NOW, reason: 'x', message: 'x' } }, status: { move: 'failed', busy: null } })], NOW);
    expect(t.active).toBe(2);
    // Background work running in a job counts too (Codex review on #698).
    expect(tallyOf([item({ id: 'bg', facts: { role: 'ops', background: 'working' }, status: { move: null, busy: 'background' } })], NOW).active).toBe(1);
  });
  it('puts a space’s default first on its Overview, whatever its status', () => {
    const lists = { active: { items: [item({ id: 'busy', lastActivityAt: NOW, facts: { projectId: 'p1' } }), item({ id: 'lead', nextStep: 'working', facts: { projectId: 'p1', role: 'default', running: { since: NOW } } })] } };
    expect(nextListReport(state({ nextRoute: { page: 'project', id: 'p1' }, lists })).rows.map((r: any) => r.id)[0]).toBe('lead');
    // Snoozed or parked, it still leads (Codex review on #694).
    const away = { active: { items: [lists.active.items[0]] }, snoozed: { items: [item({ id: 'lead', disposition: 'snoozed', facts: { projectId: 'p1', role: 'default' } })] } };
    expect(nextListReport(state({ nextRoute: { page: 'project', id: 'p1' }, lists: away })).rows.map((r: any) => r.id)[0]).toBe('lead');
  });
  it('skips collapsed project sections, and reads the view the page is on', () => {
    const s = state({ nextRoute: { page: 'project', id: 'p1' }, lists: { active: { items: [item({ facts: { projectId: 'p1' } }), item({ id: 'job', facts: { projectId: 'p1', role: 'ops' } })] } } });
    expect(nextListReport(s).rows).toHaveLength(2);
    expect(nextListReport({ ...s, listCollapsed: [`project:p1:overview|${groupByStatus([s.lists.active.items[0]], NOW)[0].key}`] }).rows.map((r: any) => r.id)).toEqual(['job']);
    // On the Jobs view, only the job: the voice operator's "the first one" is what the owner sees.
    expect(nextListReport({ ...s, nextPageViews: { 'project:p1': 'jobs' } }).rows.map((r: any) => r.id)).toEqual(['job']);
    expect(nextListReport(state({ nextRoute: { page: 'projects' }, nextPageViews: { projects: 'done' } })).rows.map((r: any) => r.kind)).toEqual(['project']);
  });
  it('reports agent rows and pins only the latest chat', () => {
    expect(nextListReport(state({ nextRoute: { page: 'agents' } })).rows[0]).toMatchObject({ kind: 'agent', id: 'sierra' });
    const lists = { active: { items: [item({ id: 'thread' }), item({ id: 'chat', kind: 'chapter', lastActivityAt: NOW }), item({ id: 'old-chat', kind: 'chapter' })] } };
    expect(nextListReport(state({ lists, nextRoute: { page: 'agent', id: 'sierra' } })).rows.map((r: any) => r.id)).toEqual(['chat', 'thread']);
  });
  it('a summary action cannot replace the real title', () => {
    const lists = { active: { items: [item({ nextStep: 'your_move', nextStepBasis: 'summary', summary: { next: 'Pick a sailing' } })] } };
    expect(nextListReport(state({ lists })).rows[0].title).toBe('Saturday ferry');
  });
});

describe('keyboard row order', () => {
  it('keeps rendered group order and skips collapsed groups and absent filtered rows', () => {
    const rows = visibleRowOrder([{ items: [{ id: 'b' }, { id: 'a' }] }, { shut: true, items: [{ id: 'hidden' }] }, { items: [{ id: 'c' }] }]);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['b', 'a', 'c']);
    expect(stepRowFocus(rows, null, 1)).toBe('b');
    expect(stepRowFocus(rows, 'hidden', -1)).toBe('b');
    expect(stepRowFocus(rows, 'b', 1)).toBe('a');
    expect(stepRowFocus(rows, 'a', -1)).toBe('b');
    expect(stepRowFocus(rows, 'b', -1)).toBe('b');
    expect(stepRowFocus(rows, 'c', 1)).toBe('c');
    expect(stepRowFocus([], 'gone', 1)).toBeNull();
  });
});

describe('search breadcrumbs', () => {
  it('keeps the words as the parent of an opened thread', () => {
    const route = { page: 'search', query: 'router repair' };
    expect(crumbsOf(route)).toEqual([{ label: 'Inbox', route: HOME_ROUTE }, { label: 'Search “router repair”', route }]);
    expect(crumbsOf(route, { thread: 'Fix connection' })).toEqual([{ label: 'Inbox', route: HOME_ROUTE }, { label: 'Search “router repair”', route }, { label: 'Fix connection' }]);
  });
});

describe('a worker’s row', () => {
  it('leads with its title while its ask is its owner’s, and with the ask once it is the owner’s move', () => {
    const worker = { id: 'w', disposition: 'active', nextStep: 'your_move', ask: 'Pick a palette', facts: { role: 'worker', parentItemId: 'lead' } };
    expect(nextAction({ ...worker, status: { move: null, busy: null } })).toBe(null);
    expect(nextAction({ ...worker, seen: 'updated', status: { pill: 'needs', countsForOwner: true, detail: 'Pick a palette' }, facts: { ...worker.facts, ownerGone: true } })).toBe('Pick a palette');
  });
});

it('shows worker asks as quiet facts beside the lead status', () => {
  expect(rowOf(item({ facts: { workerAsks: { count: 2, latestAt: NOW, ids: ['a', 'b'] } } }), { now: NOW }).facts).toContain('2 asks from workers');
});

describe('context facts (loom-context-management)', async () => {
  // @ts-expect-error plain browser module, no types
  const { factsOf, tokensLabel, LARGE_CONTEXT } = await import('../public/desk/next/model.js');
  it('says a budget past 80% on the row, and nothing from an earlier day', async () => {
    // @ts-expect-error plain browser module, no types
    const { budgetToday } = await import('../public/desk/next/model.js');
    const budget = { limit: 100_000_000, base: 100_000_000, today: 85_000_000, raised: 0, share: 0.85, resetsAt: NOW + 3_600_000 };
    expect(factsOf(item({ facts: { budget } }), NOW)).toContain('budget 85%');
    expect(factsOf(item({ facts: { budget: { ...budget, today: 50_000_000, share: 0.5 } } }), NOW).some((f: string) => f.startsWith('budget'))).toBe(false);
    expect(factsOf(item({ facts: { budget: { ...budget, resetsAt: NOW - 1 } } }), NOW).some((f: string) => f.startsWith('budget'))).toBe(false);
    expect(budgetToday(item({ facts: { budget: { ...budget, limit: 0 } } }), NOW)).toBeNull();
  });

  it('says a large context on the row, and nothing for a healthy or finished one', () => {
    const at = NOW;
    expect(factsOf(item({ facts: { context: { tokens: 480_000, at, today: 140_000_000, callsToday: 300 } } }), NOW)).toContain('context 480k');
    expect(factsOf(item({ facts: { context: { tokens: LARGE_CONTEXT - 1, at, today: 0, callsToday: 1 } } }), NOW).some((f: string) => f.startsWith('context'))).toBe(false);
    expect(factsOf(item({ disposition: 'done', facts: { context: { tokens: 900_000, at, today: 0, callsToday: 1 } } }), NOW).some((f: string) => f.startsWith('context'))).toBe(false);
  });
  it('labels token counts the way the desk says them', () => {
    expect([tokensLabel(48_200), tokensLabel(1_400_000), tokensLabel(140_000_000), tokensLabel(2_100_000_000)]).toEqual(['48k', '1.4M', '140M', '2.1B']);
  });
});

it('an idle wait has a Watching pill and no busy dot; owner moves beat background work', () => {
  const waiting = item({ nextStep: 'watching', nextStepBasis: 'source:background', facts: { background: 'monitoring', inFlight: [{ kind: 'wait', text: 'PR #913 review' }] } });
  expect(rowOf(waiting).busy).toBeNull();
  expect(rowOf(waiting).status?.label).toBe('Waiting');
  expect(statusOf(waiting)?.label).toBe('Waiting');
  for (const facts of [{ background: 'working', pending: { kind: 'question' } }, { background: 'working', openAsk: { text: 'Approve?', at: NOW } }]) {
    const asking = item({ nextStep: 'your_move', nextStepBasis: 'source:ask', seen: 'new', facts });
    expect(statusOf(asking)?.label).toBe('Needs you');
    expect(rowOf(asking).status?.label).toBe('Needs you');
  }
});


it('shows the discussion annotation on a working row', () => {
  const row = item({ facts: { discussing: [{ id: 'D-4', ask: 'Choose a plan', since: NOW }] } });
  expect(statusOf(row, NOW)).toMatchObject({ key: 'working', label: 'In discussion · D-4', cls: 'working' });
});

it('keeps the actual reply ahead of a newer summary while a brief is in discussion', () => {
  const row = item({ facts: { discussing: [{ id: 'D-4', since: NOW - 1000 }], lastAuthor: 'agent',
    lastAgentWords: { text: 'Here are the fixed links.', at: NOW, filedAt: NOW } },
    summary: { at: NOW + 1000, paragraph: 'Choose a plan.' } });
  expect(previewOf(row)).toBe('Here are the fixed links.');
});
