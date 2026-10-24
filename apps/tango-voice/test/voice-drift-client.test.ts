import { afterEach, expect, it, vi } from 'vitest';
import { HttpDeskClient } from '../src/live/desk-client.js';
import { nextSummary } from '../src/live/next-up.js';

afterEach(() => vi.unstubAllGlobals());
it.each(['accept', 'defer'] as const)('posts only the heard %s plan and preserves the conflict without retrying', async (how) => {
  const shown = { updateIds: [1], revision: 'heard', line: 'Mark one update seen.' };
  const changed = { updateIds: [1, 2], revision: 'new', line: 'Mark two updates seen.' };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'The chapter changed since you saw it', changed: true, plan: changed }), { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  const client = new HttpDeskClient('http://desk.invalid', { collaborationToken: '' });
  expect(await client.chapterAct('project:test', how, shown, 'command')).toEqual({ ok: false, error: 'The chapter changed since you saw it', changed: true, plan: changed });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(`http://desk.invalid/api/desk/chapters/project%3Atest/${how}`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ updateIds: [1], revision: 'heard', commandId: 'command' }) }));
});
it('next up says stuck and why, never failed turn', () => {
  const words = nextSummary([{ agentName: 'Agent', title: 'Build', place: null, ask: null, step: 'failed', pill: 'stuck', waitingSince: 0 }], 60_000);
  expect(words).toContain('stuck: it said it would keep going, but nothing is running');
  expect(words).not.toContain('failed');
});

it('reads the current plan even when the chapter has no remaining lines', async () => {
  const plan = { updateIds: [], revision: 'after-heard', line: 'Nothing left.' };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ lines: [], plan })));
  vi.stubGlobal('fetch', fetcher);
  const client = new HttpDeskClient('http://desk.invalid');
  expect(await client.chapterPlan('project:test')).toEqual(plan);
  expect(fetcher).toHaveBeenCalledWith('http://desk.invalid/api/desk/chapters/project%3Atest', expect.any(Object));
});
