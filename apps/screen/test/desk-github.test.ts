import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskGitHubReviews, GH_PR_FIELDS } from '../server/desk/source-github.js';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { cid, makeHarness, NOW, type Harness } from './desk-harness.js';

// PR watches read through `gh` (desk/source-github.ts), on Loom threads. Synthetic repos, reviewers and ids only.

let h: Harness;
let source: DeskLoomSource;
/** Turns the fake Loom was asked to start. */
let dispatched: Array<Record<string, unknown>>;

const at = (minute: number) => NOW + minute * 60_000;

/** Files one idle Loom thread the way a Loom snapshot would. */
function thread(id: string, title = `Thread ${id}`): void {
  (source as unknown as { ingest(detail: unknown): void }).ingest({
    thread: { id, title, cwd: '/repos/acme', repo: '/repos/acme', status: 'idle', created_at: at(-60), updated_at: at(-5), settled_at: null },
    runs: [{ id: 'turn-1', status: 'completed', failure: null, started_at: at(-30), ended_at: at(-5) }],
    messages: [
      { id: `u:${id}:1`, role: 'user', text: 'Build the overview map', created_at: at(-30) },
      { id: `a:${id}:1`, role: 'assistant', text: 'The overview map is up.', created_at: at(-5) },
    ],
    requests: [],
  });
}

const item = (id: string) => h.core.item(id)!;
const text = (command: Record<string, unknown> | undefined) => String(command?.text ?? '');
const watch = (itemId: string, args: Record<string, unknown>, actor?: 'agent') => h.core.command({ commandId: cid(), type: 'watch', itemId, ...(actor ? { actor } : {}), args });

beforeEach(() => {
  h = makeHarness();
  dispatched = [];
  source = new DeskLoomSource({ core: h.core, url: 'http://loom.test', tokenFile: `${h.dir}/missing-token`, projectFor: () => ({ name: 'acme', icon: null, color: null }) });
  vi.spyOn(source as never, 'call' as never).mockImplementation((async (_path: string, options: { body: Record<string, unknown> }) => {
    dispatched.push(options.body);
    return { status: 200, body: { ok: true } };
  }) as never);
  (h.core as unknown as { options: { adapters: unknown[] } }).options.adapters.push(source);
});

afterEach(() => h.close());

describe('PR review state (gh)', () => {
  it('pending and changes-requested reviews wait; a notify approval never asks the owner', async () => {
    thread('a');
    await watch('loom:a', { url: 'https://github.com/acme/widgets/pull/9', onApprove: 'notify' });
    let answer: Record<string, unknown> = { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'reviewer-a' }], reviews: [] };
    const calls: string[][] = [];
    const github = new DeskGitHubReviews({
      core: h.core,
      now: () => h.clock.now,
      exec: async (_command, args) => {
        calls.push(args);
        return args[0] === 'auth' ? 'Logged in' : JSON.stringify(answer);
      },
    });
    expect(await github.poll()).toBe(1);
    expect(calls[1]).toEqual(['pr', 'view', 'https://github.com/acme/widgets/pull/9', '--json', GH_PR_FIELDS]);
    expect(item('loom:a')).toMatchObject({ nextStep: 'watching', nextStepBasis: 'source:pr-review', watching: { reason: 'PR #9 · checked 0m ago' } });
    // A long wait stays a wait; it never turns into an ask.
    h.core.store.setSetting('waiting_nudge_hours', '24');
    h.clock.now = NOW + 25 * 3_600_000;
    h.core.tick();
    expect(item('loom:a')).toMatchObject({ nextStep: 'watching', ask: null, watching: { reason: 'PR #9 · checked 1500m ago' } });
    await h.core.command({ commandId: cid(), type: 'seen', itemId: 'loom:a' });
    answer = { state: 'OPEN', reviewDecision: 'APPROVED', reviewRequests: [], reviews: [{ state: 'APPROVED', author: { login: 'reviewer-a' } }] };
    await github.poll();
    expect(item('loom:a')).toMatchObject({ ask: null });
    expect(item('loom:a').nextStep).not.toBe('your_move');
    expect(dispatched).toHaveLength(0);

    const offline = new DeskGitHubReviews({ core: h.core, exec: async () => Promise.reject(new Error('gh: not logged in')) });
    expect(await offline.poll()).toBe(0);
  });

  it("CI on a watched PR: failing beats running beats passing; no checks is none; a failed read keeps it; unresolved checks read Waiting", async () => {
    thread('a');
    await watch('loom:a', { url: 'https://github.com/acme/widgets/pull/9', onApprove: 'notify' });
    const run = (status: string, conclusion: string | null = null) => ({ __typename: 'CheckRun', status, conclusion });
    let answer: Record<string, unknown> | null = { state: 'OPEN', statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')] };
    const github = new DeskGitHubReviews({ core: h.core, now: () => h.clock.now, exec: async (_c, args) => (args[0] === 'auth' ? 'ok' : answer ? JSON.stringify(answer) : Promise.reject(new Error('gh down'))) });
    await github.poll();
    expect(item('loom:a').facts.prChecks).toEqual({ state: 'running', number: 9 });
    answer = { state: 'OPEN', statusCheckRollup: [run('IN_PROGRESS'), run('COMPLETED', 'FAILURE'), { __typename: 'StatusContext', state: 'SUCCESS' }] };
    await github.poll();
    expect(item('loom:a').facts.prChecks).toEqual({ state: 'failing', number: 9 });
    expect(item('loom:a').nextStep).toBe('watching');
    answer = null;
    await github.poll();
    expect(item('loom:a').facts.prChecks).toEqual({ state: 'failing', number: 9 });
    answer = { state: 'OPEN', statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), { __typename: 'StatusContext', state: 'SUCCESS' }] };
    await github.poll();
    expect(item('loom:a').facts.prChecks).toEqual({ state: 'passing', number: 9 });
    answer = { state: 'OPEN', statusCheckRollup: [run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'STALE')] };
    await github.poll();
    expect(item('loom:a').facts.prChecks).toEqual({ state: 'failing', number: 9 });
    answer = { state: 'OPEN', statusCheckRollup: [] };
    await github.poll();
    expect(item('loom:a').facts.prChecks).toBeNull();
  });

  it('a watched PR waits on review, wakes the agent once per approval, and drops off when merged', async () => {
    thread('a');
    const answers = new Map<string, Record<string, unknown>>([
      // Required review: the requested reviewer commented and dropped off reviewRequests, but the PR still waits.
      ['https://github.com/acme/api/pull/31', { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], reviews: [{ state: 'COMMENTED', author: { login: 'reviewer-a' }, authorAssociation: 'MEMBER' }] }],
    ]);
    const github = new DeskGitHubReviews({ core: h.core, now: () => h.clock.now, exec: async (_command, args) => (args[0] === 'auth' ? 'ok' : JSON.stringify(answers.get(args[2]!))) });
    await github.poll();
    expect(item('loom:a').nextStep).not.toBe('watching');

    // Bad link: refused, nothing stored.
    expect(await watch('loom:a', { url: 'https://example.com/pull/1' })).toMatchObject({ status: 'failed' });
    const added = await watch('loom:a', { url: 'https://github.com/acme/api/pull/31/files' }, 'agent');
    expect(added).toMatchObject({ status: 'applied', outcome: { watching: true, url: 'https://github.com/acme/api/pull/31', number: 31, onApprove: 'continue' } });
    await github.poll();
    expect(item('loom:a')).toMatchObject({ nextStep: 'watching', nextStepBasis: 'source:pr-review', watching: { reason: 'PR #31 · checked 0m ago' } });
    expect(dispatched).toHaveLength(0);

    // Approved: the desk posts into the thread once.
    answers.set('https://github.com/acme/api/pull/31', { state: 'OPEN', reviewDecision: 'APPROVED', reviewRequests: [], reviews: [{ state: 'APPROVED', author: { login: 'reviewer-a' }, authorAssociation: 'MEMBER' }] });
    h.clock.now += 60_000;
    await github.poll();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ threadId: 'a' });
    expect(text(dispatched[0])).toContain('[Desk] PR #31 was approved by reviewer-a: https://github.com/acme/api/pull/31');
    await github.poll();
    expect(dispatched).toHaveLength(1);

    // Merged: the agent hears it once, and the watch is over.
    answers.set('https://github.com/acme/api/pull/31', { state: 'MERGED', reviewDecision: 'APPROVED' });
    await github.poll();
    expect(item('loom:a').facts.prWatches ?? null).toBeNull();
    expect(item('loom:a').facts.prReview ?? null).toBeNull();
  });

  it('a watch on a done item is still read, and a watch stopped mid-poll never wakes', async () => {
    thread('a');
    await h.core.command({ commandId: cid(), type: 'done', itemId: 'loom:a' });
    await watch('loom:a', { url: 'https://github.com/acme/api/pull/5' });
    const github = new DeskGitHubReviews({ core: h.core, now: () => h.clock.now, exec: async (_command, args) => (args[0] === 'auth' ? 'ok' : JSON.stringify({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'reviewer-a' }] })) });
    expect(await github.poll()).toBe(1);
    expect(item('loom:a').facts.prReview).toMatchObject({ state: 'pending', number: 5 });
    // Stopped while gh is answering: the approval it returns wakes nobody.
    const approved = new DeskGitHubReviews({
      core: h.core,
      now: () => h.clock.now,
      exec: async (_command, args) => {
        if (args[0] === 'auth') return 'ok';
        await watch('loom:a', { url: 'https://github.com/acme/api/pull/5', off: true });
        return JSON.stringify({ state: 'OPEN', reviewDecision: 'APPROVED', reviews: [] });
      },
    });
    await approved.poll();
    // Done told Loom to settle the thread; no turn was started.
    expect(dispatched.filter((command) => command.type !== 'settle')).toHaveLength(0);
  });

  it('watching a PR never changes an owner stage or seeds one', async () => {
    thread('a');
    thread('b');
    await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:a', args: { stage: 'building' } });
    const watched = await watch('loom:a', { url: 'https://github.com/acme/api/pull/5' });
    expect(watched).toMatchObject({ status: 'applied', outcome: { stage: 'building' } });
    expect(item('loom:a').facts.stage).toBe('building');
    // Stopping the watch leaves the stage where it is.
    await watch('loom:a', { url: 'https://github.com/acme/api/pull/5', off: true });
    expect(item('loom:a').facts.stage).toBe('building');
    expect(item('loom:b').facts.stage ?? null).toBeNull();
    await watch('loom:b', { url: 'https://github.com/acme/api/pull/6' });
    expect(item('loom:b').facts.stage ?? null).toBeNull();
    // An unseeded item stays unseeded.
    thread('c', 'epic: Maps');
    h.core.setFacts('loom:c', { tagsSeeded: false, stage: null, type: null });
    await watch('loom:c', { url: 'https://github.com/acme/api/pull/7' });
    expect(item('loom:c').facts).toMatchObject({ type: null, stage: null, tagsSeeded: false });
  });

  it('a notify watch only tells the owner; off stops watching', async () => {
    thread('a');
    const github = new DeskGitHubReviews({ core: h.core, now: () => h.clock.now, exec: async (_command, args) => (args[0] === 'auth' ? 'ok' : JSON.stringify({ state: 'OPEN', reviewDecision: 'APPROVED', reviews: [] })) });
    await watch('loom:a', { url: 'https://github.com/acme/api/pull/5', onApprove: 'notify' });
    await github.poll();
    expect(item('loom:a')).toMatchObject({ ask: null });
    expect(dispatched).toHaveLength(0);
    const off = await watch('loom:a', { url: 'https://github.com/acme/api/pull/5', off: true });
    expect(off).toMatchObject({ status: 'applied', outcome: { watching: false } });
    expect(item('loom:a').facts.prWatches ?? null).toBeNull();
    expect(item('loom:a').ask).not.toBe('PR #5 approved — merge?');
  });
});

describe('a PR watch whose check fails still wakes', () => {
  const url = 'https://github.com/acme/api/pull/913';

  it('gh auth fails at start then recovers and watches resume', async () => {
    thread('a');
    await watch('loom:a', { url });
    let fail = true;
    const github = new DeskGitHubReviews({ core: h.core, now: () => h.clock.now, exec: async (_c, args) => {
      if (args[0] === 'auth') { if (fail) throw new Error('gh auth failed'); return 'ok'; }
      return JSON.stringify({ state: 'OPEN', reviewDecision: 'APPROVED' });
    } });
    await github.poll();
    expect(item('loom:a').facts.prWatches?.[0]?.last_error).toContain('PR watch offline');
    fail = false;
    await github.poll();
    expect(dispatched).toHaveLength(1);
    expect(item('loom:a').facts.prWatches?.[0]).toMatchObject({ last_error: null, consecutive_errors: 0 });
  });

  it('3 PR watch errors wake the thread with the error once', async () => {
    thread('a');
    await watch('loom:a', { url });
    const github = new DeskGitHubReviews({ core: h.core, exec: async () => { throw new Error('gh auth failed'); } });
    await github.poll();
    await github.poll();
    expect(dispatched).toHaveLength(0);
    await github.poll();
    await github.poll();
    expect(dispatched).toHaveLength(1);
    expect(text(dispatched[0])).toContain('gh auth failed');
  });

  it.each(['MERGED', 'CLOSED', 'CHANGES_REQUESTED'])('%s wakes the watching agent', async (state) => {
    thread('a');
    await watch('loom:a', { url });
    const github = new DeskGitHubReviews({ core: h.core, exec: async (_c, args) => (args[0] === 'auth' ? 'ok' : JSON.stringify({ state: state === 'CHANGES_REQUESTED' ? 'OPEN' : state, reviewDecision: state === 'CHANGES_REQUESTED' ? state : null })) });
    await github.poll();
    await github.poll();
    expect(dispatched).toHaveLength(1);
  });

  it("re-watching after changes requested keeps the wake state, so the same review doesn't wake again", async () => {
    thread('a');
    await watch('loom:a', { url });
    const github = new DeskGitHubReviews({ core: h.core, exec: async (_c, args) => (args[0] === 'auth' ? 'ok' : JSON.stringify({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' })) });
    await github.poll();
    expect(dispatched).toHaveLength(1);
    await watch('loom:a', { url });
    expect(item('loom:a').facts.prWatches?.[0]?.wokeState).toBe('changes_requested');
    await github.poll();
    expect(dispatched).toHaveLength(1);
  });
});
