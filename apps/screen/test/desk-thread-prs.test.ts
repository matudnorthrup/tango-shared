import { afterEach, beforeEach, expect, it } from 'vitest';
import { addThreadPr, backfillOpenedPrs, DeskThreadPrs, sortThreadPrs } from '../server/desk/thread-prs.js';
import { defaultExec } from '../server/desk/source-github.js';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { deskStatus } from '../server/desk/status.js';
import { presentItem } from '../server/desk/view.js';
import { makeHarness, NOW, type Harness } from './desk-harness.js';
import type { ThreadPr } from '../server/desk/types.js';
let h: Harness;
const url = 'https://github.com/acme/widgets/pull/7';
beforeEach(() => { h = makeHarness(); });
afterEach(() => h.close());
function thread(id: string, extra: Record<string, unknown> = {}, messages: unknown[] = []) {
  const source = new DeskLoomSource({ core: h.core, url: 'http://loom.test', tokenFile: `${h.dir}/missing`, projectFor: () => null });
  (source as unknown as { ingest(d: unknown): void }).ingest({ thread: { id, title: id, cwd: '/repos/widgets', status: 'idle', created_at: NOW, updated_at: NOW, ...extra }, messages, requests: [], runs: [], openedPrUrls: [] });
}
const response = (state = 'OPEN') => JSON.stringify({ data: { p0: { pullRequest: { title: 'Add widgets', state, reviewDecision: 'APPROVED', mergedAt: state === 'MERGED' ? new Date(NOW).toISOString() : null, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } } } } });
it('keeps strongest relation and sorts by relation, state and newest', () => {
  const prs: ThreadPr[] = [];
  for (const relation of ['mentioned', 'watched', 'worker', 'opened', 'mentioned'] as const) addThreadPr(prs, url, relation, NOW);
  expect(prs).toHaveLength(1);
  expect(prs[0]).toMatchObject({ relation: 'opened', firstSeenAt: NOW });
  addThreadPr(prs, url.replace('/7', '/8'), 'mentioned', NOW + 1);
  expect(sortThreadPrs(prs)[0]?.number).toBe(7);
});
it('reads all agent messages, batches unique URLs, persists membership and never changes status', async () => {
  thread('a', {}, [{ id: 'old', role: 'assistant', text: `First ${url}`, created_at: NOW - 10 }, { id: 'new', role: 'assistant', text: 'No links here', created_at: NOW }]);
  h.core.setFacts('loom:a', { openedPrUrls: [url] });
  const before = deskStatus(h.core.item('loom:a')!);
  const calls: string[][] = [];
  const poller = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async (_, args) => { calls.push(args); return response(); } });
  await poller.poll();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 2)).toEqual(['api', 'graphql']);
  expect(calls[0]?.[3]).toContain('p0: repository');
  const item = h.core.item('loom:a')!;
  expect(presentItem(item).prs).toMatchObject([{ url, title: 'Add widgets', state: 'open', relation: 'opened', checks: 'passing', review: 'approved', checkedAt: NOW }]);
  expect(deskStatus(item)).toEqual(before);
  expect(deskStatus({ ...item, prs: [] })).toEqual(deskStatus(item));
  h.core.setFacts(item.id, { openedPrUrls: [] });
  await new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => { throw Error('not due'); } }).poll();
  expect(h.core.store.deskItem(item.id)?.prs).toHaveLength(1);
});
it('rolls opened PRs recursively to leads, with original worker attribution', async () => {
  thread('lead'); thread('middle'); thread('worker');
  h.core.roles.set('loom:middle', { role: 'worker', parentItemId: 'loom:lead' }, 'agent', NOW);
  h.core.roles.set('loom:worker', { role: 'worker', parentItemId: 'loom:middle' }, 'agent', NOW);
  h.core.setFacts('loom:worker', { openedPrUrls: [url], waits: [{ id: 'w', kind: 'pr', target: url, armedAt: NOW }] });
  let calls = 0;
  await new DeskThreadPrs({ core: h.core, now: () => NOW, exec: async () => { calls++; return response(); } }).poll();
  expect(calls).toBe(1);
  for (const id of ['lead', 'middle']) expect(h.core.item(`loom:${id}`)?.prs).toMatchObject([{ relation: 'worker', watched: true, via: { itemId: 'loom:worker', title: 'widgets · worker' } }]);
});
it('retains state and successful observation time on failure, and never re-reads terminal PRs', async () => {
  thread('a'); h.core.setFacts('loom:a', { openedPrUrls: [url] });
  let answer = response(); let fail = false; let calls = 0;
  const poller = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => { calls++; if (fail) throw Error('offline'); return answer; } });
  await poller.poll();
  h.clock.now += 300_000; fail = true; await poller.poll();
  expect(h.core.item('loom:a')?.prs?.[0]).toMatchObject({ state: 'open', checkedAt: NOW, error: 'Error: offline' });
  await poller.poll(); expect(calls).toBe(2);
  h.clock.now += 300_000; fail = false; answer = response('MERGED'); await poller.poll();
  h.clock.now += 3_600_000; await poller.poll();
  expect(calls).toBe(3);
  expect(h.core.item('loom:a')?.prs?.[0]).toMatchObject({ state: 'merged', mergedAt: NOW });
  expect(h.core.item('loom:a')?.prs?.[0]?.error).toBeUndefined();
});
it('throttles mentioned PRs for 30 minutes and tracks Loom waits without dropping entries', async () => {
  thread('a', {}, [{ id: 'a', role: 'assistant', text: url, created_at: NOW }]);
  let calls = 0;
  const poller = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => { calls++; return response(); } });
  await poller.poll(); h.clock.now += 300_000; await poller.poll(); expect(calls).toBe(1);
  h.clock.now += 1_500_000; await poller.poll(); expect(calls).toBe(2);
  h.core.setFacts('loom:a', { waits: [{ id: 'w', kind: 'pr', target: 'PR #7 review', prUrl: url, armedAt: NOW }] });
  await poller.poll(); expect(h.core.item('loom:a')?.prs?.[0]).toMatchObject({ relation: 'watched', watched: true });
  h.core.setFacts('loom:a', { waits: [] }); await poller.poll();
  expect(h.core.item('loom:a')?.prs?.[0]).toMatchObject({ relation: 'watched', watched: false });
});
it('resolves the branch until found, then stops discovery', async () => {
  thread('a'); h.core.setFacts('loom:a', { prBranch: { branch: 'codex/widgets', cwd: '/repos/widgets' } });
  const calls: string[][] = [];
  const poller = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async (cmd, args) => {
    calls.push(args);
    if (cmd === 'git') return 'git@github.com:acme/widgets.git';
    if (args[0] === 'pr') return JSON.stringify([{ url }]);
    return response();
  } });
  await poller.poll(); h.clock.now += 300_000; await poller.poll();
  expect(calls.filter(args => args[0] === 'pr')).toEqual([['pr', 'list', '--head', 'codex/widgets', '--repo', 'acme/widgets', '--state', 'all', '--json', 'url']]);
});
it('keeps successful aliases when another alias is missing, and chunks large batches', async () => {
  thread('a');
  h.core.setFacts('loom:a', { openedPrUrls: Array.from({ length: 26 }, (_, i) => `https://github.com/acme/widgets/pull/${i + 1}`) });
  const queries: string[] = [];
  await new DeskThreadPrs({ core: h.core, now: () => NOW, exec: async (_, args) => {
    queries.push(args[3]!);
    return response('CLOSED');
  } }).poll();
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('p24: repository');
  expect(queries[1]).not.toContain('p1: repository');
  const prs = h.core.item('loom:a')!.prs!;
  expect(prs.filter(p => p.state === 'closed')).toHaveLength(2);
  expect(prs.filter(p => p.error === 'GitHub returned no pull request')).toHaveLength(24);
});
it('finds repaired historical agent messages and excludes owner mentions', async () => {
  thread('a', {}, [{ id: 'a', role: 'assistant', text: 'Result: ', created_at: NOW }, { id: 'u', role: 'user', text: url.replace('/7', '/99'), created_at: NOW }]);
  const poller = new DeskThreadPrs({ core: h.core, now: () => NOW, exec: async () => response() });
  await poller.poll();
  h.core.store.addMessage({ itemId: 'loom:a', messageId: 'repaired', author: 'agent', text: 'Result: ', at: NOW - 10 });
  h.core.store.addMessage({ itemId: 'loom:a', messageId: 'repaired', author: 'agent', text: `Result: ${url}`, at: NOW - 10 });
  await poller.poll();
  expect(h.core.item('loom:a')?.prs?.map(p => p.number)).toEqual([7]);
});
it('coalesces item notifications, including its own membership writes', async () => {
  thread('a'); h.core.setFacts('loom:a', { openedPrUrls: [url] });
  let calls = 0;
  const poller = new DeskThreadPrs({ core: h.core, now: () => NOW, exec: async () => { calls++; return response(); } });
  const stop = h.core.subscribe(e => { if (e.type === 'item') void poller.poll(); });
  try { await poller.poll(); expect(calls).toBe(1); } finally { stop(); }
});
it('uses partial stdout on gh exit 1 and backs off only NOT_FOUND aliases across restarts', async () => {
  thread('a'); h.core.setFacts('loom:a', { openedPrUrls: [url, url.replace('/7', '/8')] });
  const queries: string[] = [];
  let recovered = false;
  const exec = async (_: string, args: string[]) => {
    queries.push(args[3]!);
    if (recovered) { const good = JSON.parse(response()); good.data.p1 = good.data.p0; return JSON.stringify(good); }
    if (!args[3]!.includes('number:8')) return response();
    const good = JSON.parse(response());
    good.data.p1 = { pullRequest: null };
    good.errors = [{ type: 'NOT_FOUND', path: ['p1', 'pullRequest'] }];
    throw Object.assign(new Error('gh exited 1'), { stdout: JSON.stringify(good) });
  };
  await new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec }).poll();
  const prs = () => h.core.item('loom:a')!.prs!;
  expect(prs().find(p => p.number === 7)).toMatchObject({ title: 'Add widgets', checkedAt: NOW, review: 'approved' });
  expect(prs().find(p => p.number === 7)?.error).toBeUndefined();
  expect(prs().find(p => p.number === 8)).toMatchObject({ error: 'NOT_FOUND', checkedAt: null });
  h.clock.now += 300_000;
  const restarted = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec });
  await restarted.poll();
  expect(queries[1]).not.toContain('number:8');
  expect(prs().find(p => p.number === 8)?.error).toBe('NOT_FOUND');
  h.clock.now = NOW + 6 * 60 * 60_000;
  recovered = true;
  await restarted.poll();
  expect(queries[2]).toContain('number:8');
  expect(prs().find(p => p.number === 8)?.error).toBeUndefined();
  expect(h.core.store.marker(`thread-prs:retry:${url.replace('/7', '/8')}`)).toBeNull();
});
it('keeps prior states when a rejected process has non-JSON stdout', async () => {
  thread('a'); h.core.setFacts('loom:a', { openedPrUrls: [url] });
  await new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => response() }).poll();
  h.clock.now += 300_000;
  await new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => { throw Object.assign(new Error('offline'), { stdout: 'not JSON' }); } }).poll();
  expect(h.core.item('loom:a')!.prs![0]).toMatchObject({ title: 'Add widgets', checkedAt: NOW, state: 'open', error: 'Error: offline' });
});
it('persists the mention cursor, finds older backfills, and rewinds for repaired or reused rows', async () => {
  thread('a', {}, [{ id: 'initial', role: 'assistant', text: url, created_at: NOW }]);
  const poll = () => new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => response() }).poll();
  await poll();
  const cursor = Number(h.core.store.marker('thread-prs:messages'));
  expect(cursor).toBeGreaterThan(0);
  await poll();
  expect(Number(h.core.store.marker('thread-prs:messages'))).toBe(cursor);
  const message = { messageId: 'older', itemId: 'loom:a', author: 'agent' as const, at: NOW - 1000, text: 'Result: ' };
  h.core.store.addMessage(message);
  await poll();
  const after = Number(h.core.store.marker('thread-prs:messages'));
  expect(after).toBeGreaterThan(cursor);
  h.core.store.addMessage({ ...message, text: `Result: ${url.replace('/7', '/8')}` });
  expect(Number(h.core.store.marker('thread-prs:messages'))).toBeLessThan(after);
  await poll();
  expect(h.core.item('loom:a')!.prs!.map(p => p.number)).toContain(8);
  h.core.store.db.prepare('DELETE FROM desk_messages WHERE message_id = ?').run('older');
  h.core.store.addMessage({ ...message, messageId: 'reused', text: url.replace('/7', '/9') });
  expect(Number(h.core.store.marker('thread-prs:messages'))).toBeLessThan(after);
  await poll();
  expect(h.core.item('loom:a')!.prs!.map(p => p.number)).toContain(9);
});

it('the process adapter retains stdout on a nonzero exit', async () => {
  await expect(defaultExec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({data:{p0:null}})); process.exitCode=1'])).rejects.toMatchObject({ stdout: '{"data":{"p0":null}}' });
});

it.each([
  ['SUCCESS', 'passing'], ['FAILURE', 'failing'], ['ERROR', 'failing'],
  ['PENDING', 'running'], ['EXPECTED', 'running'], [null, null],
])('reads aggregate rollup %s as %s without a context limit', async (state, checks) => {
  thread('a'); h.core.setFacts('loom:a', { openedPrUrls: [url] });
  await new DeskThreadPrs({ core: h.core, now: () => NOW, exec: async (_, args) => {
    expect(args[3]).toContain('statusCheckRollup { state }');
    expect(args[3]).not.toContain('contexts');
    const data = JSON.parse(response());
    data.data.p0.pullRequest.commits.nodes[0].commit.statusCheckRollup = state ? { state } : null;
    return JSON.stringify(data);
  } }).poll();
  expect(h.core.item('loom:a')!.prs![0].checks).toBe(checks);
  expect(h.core.item('loom:a')!.prs![0].error).toBeUndefined();
});

it.each([
  ['exactly one', [NOW + 180_000, NOW + 180_001], ['opened', 'mentioned']],
  ['none', [NOW - 180_001, NOW + 180_001], ['mentioned', 'mentioned']],
  ['ambiguous', [NOW - 60_000, NOW + 60_000], ['mentioned', 'mentioned']],
  ['incomplete', [NOW, null], ['mentioned', 'mentioned']],
] as const)('backfills legacy ownership with %s creation-time match', (_, times, relations) => {
  const prs: ThreadPr[] = [];
  addThreadPr(prs, url, 'mentioned', NOW);
  addThreadPr(prs, url.replace('/7', '/8'), 'mentioned', NOW);
  backfillOpenedPrs(prs, [{ at: NOW }], u => times[u === url ? 0 : 1]);
  expect(prs.map(pr => pr.relation)).toEqual(relations);
});
it('backfills a cached terminal mention once, rolls ownership to its lead, and retains the exact contract', async () => {
  thread('lead'); thread('a', {}, [{ id: 'm', role: 'assistant', text: url, created_at: NOW }]);
  h.core.roles.set('loom:a', { role: 'worker', parentItemId: 'loom:lead' }, 'agent', NOW);
  await new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => response('MERGED') }).poll();
  // A cache from before createdAt was read, followed by a newer Loom exposing legacy results.
  h.core.store.deleteMarker(`thread-prs:created:${url}`);
  h.core.setFacts('loom:a', { legacyPrCreates: [{ id: 'effect', at: NOW }] });
  h.clock.now += 30 * 60_000;
  let calls = 0;
  const poll = () => new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async (_, args) => {
    calls++; expect(args[3]).toContain('createdAt');
    const answer = JSON.parse(response('MERGED'));
    answer.data.p0.pullRequest.createdAt = new Date(NOW - 60_000).toISOString();
    return JSON.stringify(answer);
  } }).poll();
  await poll();
  expect(h.core.item('loom:a')!.prs![0]).toMatchObject({ relation: 'opened', state: 'merged' });
  expect(h.core.item('loom:lead')!.prs![0]).toMatchObject({ relation: 'worker', state: 'merged', via: { itemId: 'loom:a' } });
  expect(h.core.item('loom:a')!.prs![0]).not.toHaveProperty('createdAt');
  h.clock.now += 3_600_000;
  await poll();
  expect(calls).toBe(1);
});
it('re-reads owned PRs once after a turn end or merge, without waiting five minutes', async () => {
  thread('a', {}, [{ id: 'm', role: 'assistant', text: url.replace('/7', '/8'), created_at: NOW }]);
  h.core.setFacts('loom:a', { openedPrUrls: [url] });
  let answer = response(); const read: string[] = [];
  const poller = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async (_, args) => { read.push(args[3]!); return answer; } });
  await poller.poll(); expect(read).toHaveLength(1);
  h.clock.now += 60_000; answer = response('MERGED');
  h.core.setFacts('loom:a', { prRefreshAt: h.clock.now - 1_000 });
  await poller.poll();
  expect(read).toHaveLength(2);
  expect(read[1]).toContain('pullRequest(number:7)');
  expect(read[1]).not.toContain('pullRequest(number:8)');
  expect(h.core.item('loom:a')?.prs?.find(pr => pr.number === 7)).toMatchObject({ state: 'merged', checkedAt: h.clock.now });
  // The same turn end never prompts a second read.
  h.clock.now += 10_000; await poller.poll(); expect(read).toHaveLength(2);
});
it('reads once after a merge that is still open, then falls back to the regular pass', async () => {
  thread('a'); h.core.setFacts('loom:a', { openedPrUrls: [url] });
  let calls = 0;
  const poller = new DeskThreadPrs({ core: h.core, now: () => h.clock.now, exec: async () => { calls++; return response(); } });
  await poller.poll();
  h.clock.now += 30_000; h.core.setFacts('loom:a', { prRefreshAt: h.clock.now }); await poller.poll(); expect(calls).toBe(2);
  h.clock.now += 60_000; await poller.poll(); expect(calls).toBe(2);
  h.clock.now += 300_000; await poller.poll(); expect(calls).toBe(3);
});
it('takes the refresh time from the latest turn end or Loom merge', () => {
  const source = new DeskLoomSource({ core: h.core, url: 'http://loom.test', tokenFile: `${h.dir}/missing`, projectFor: () => null });
  const ingest = (extra: Record<string, unknown>) => (source as unknown as { ingest(d: unknown): void }).ingest({ thread: { id: 'a', title: 'a', cwd: '/repos/widgets', status: 'idle', created_at: NOW, updated_at: NOW }, messages: [], requests: [], openedPrUrls: [], ...extra });
  ingest({ runs: [] });
  expect(h.core.item('loom:a')?.facts.prRefreshAt).toBeNull();
  ingest({ runs: [{ id: 'r1', status: 'completed', failure: null, started_at: NOW - 50, ended_at: NOW - 20 }, { id: 'r2', status: 'running', failure: null, started_at: NOW - 10, ended_at: null }], lastPrMergeAt: NOW - 5 });
  expect(h.core.item('loom:a')?.facts.prRefreshAt).toBe(NOW - 5);
});

it('does not borrow another row watch after its own watch is cancelled', async () => {
  thread('a'); thread('b');
  h.core.setFacts('loom:a', { waits: [{ id: 'a-wait', kind: 'pr', target: url, armedAt: NOW }] });
  h.core.setFacts('loom:b', { waits: [{ id: 'b-wait', kind: 'pr', target: url, armedAt: NOW }] });
  const poller = new DeskThreadPrs({ core: h.core, now: () => NOW, exec: async () => response() });
  await poller.poll();
  h.core.setFacts('loom:a', { waits: [] }); await poller.poll();
  expect(h.core.item('loom:a')?.prs?.[0]).toMatchObject({ relation: 'watched', watched: false });
  expect(h.core.item('loom:b')?.prs?.[0]).toMatchObject({ watched: true });
});
