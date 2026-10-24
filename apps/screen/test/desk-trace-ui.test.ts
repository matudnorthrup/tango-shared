import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createTraceReporter, renderKey, renderLine, toastKind } from '../public/desk/trace.js';

// The screen's render reports for the session trace: throttled, batched, fire-and-forget.

function fakeClock() {
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: 0,
    setTimer: (fn: () => void, ms: number) => timers.push({ at: clock.now + ms, fn }),
    async advance(ms: number) {
      clock.now += ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= clock.now);
        if (due.length === 0) break;
        for (const timer of due) timers.splice(timers.indexOf(timer), 1);
        for (const timer of due) timer.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
  return clock;
}

describe('screen trace reporter', () => {
  it('batches reports and posts at most every 500 ms', async () => {
    const clock = fakeClock();
    const posts: unknown[][] = [];
    const reporter = createTraceReporter({ send: async (batch: unknown[]) => void posts.push(batch), now: () => clock.now, setTimer: clock.setTimer });
    reporter.report({ kind: 'render', summary: 'board' });
    reporter.report({ kind: 'render', summary: 'conversation' });
    await clock.advance(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject([{ source: 'screen', kind: 'render', summary: 'board' }, { summary: 'conversation' }]);
    reporter.report({ kind: 'render', summary: 'screen' });
    await clock.advance(100);
    expect(posts).toHaveLength(1); // throttled
    reporter.report({ kind: 'toast', summary: 'Sent' });
    await clock.advance(400);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.map((entry: any) => entry.summary)).toEqual(['screen', 'Sent']);
  });

  it('keeps only the newest entries when the buffer fills, and switches off on 404', async () => {
    const clock = fakeClock();
    const posts: unknown[][] = [];
    let fail: { status: number } | null = null;
    const reporter = createTraceReporter({
      send: async (batch: unknown[]) => {
        posts.push(batch);
        if (fail) throw Object.assign(new Error('HTTP'), fail);
      },
      maxBuffer: 3,
      now: () => clock.now,
      setTimer: clock.setTimer,
    });
    for (let i = 0; i < 5; i++) reporter.report({ kind: 'render', summary: `r${i}` });
    await clock.advance(0);
    expect(posts[0]!.map((entry: any) => entry.summary)).toEqual(['r2', 'r3', 'r4']);
    fail = { status: 404 };
    reporter.report({ kind: 'render', summary: 'x' });
    await clock.advance(600);
    expect(reporter.disabled).toBe(true);
    reporter.report({ kind: 'render', summary: 'y' });
    await clock.advance(600);
    expect(posts).toHaveLength(2);
  });

  it('a transport error drops the batch but keeps reporting', async () => {
    const clock = fakeClock();
    let calls = 0;
    const reporter = createTraceReporter({
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network');
      },
      now: () => clock.now,
      setTimer: clock.setTimer,
    });
    reporter.report({ kind: 'render', summary: 'a' });
    await clock.advance(0);
    reporter.report({ kind: 'render', summary: 'b' });
    await clock.advance(600);
    expect(calls).toBe(2);
    expect(reporter.disabled).toBe(false);
  });

  it('render keys change only when what is shown changes', () => {
    expect(renderKey({ view: 'active' })).toBe('active');
    expect(renderKey({ view: 'conversation', itemId: 'i1' })).toBe('conversation:i1');
    expect(renderKey({ view: 'screen', sceneId: 's1' }, { version: 2 })).toBe('screen:s1@2');
    expect(renderLine({ view: 'screen', sceneId: 's1' }, { scene: { id: 's1', title: 'The loop map', version: 2, agentName: 'Sierra' } })).toBe('screen “The loop map” v2 (Sierra)');
    expect(renderLine({ view: 'conversation', itemId: 'i1' }, { item: { agentName: 'Victor', place: 'Search PR' } })).toBe('conversation Victor · Search PR');
    expect(toastKind('Reply didn’t go through: x')).toBe('toast.error');
    expect(toastKind('Sent to Sierra')).toBe('toast');
  });
});
