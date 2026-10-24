import { afterEach, describe, expect, it, vi } from 'vitest';
import { snowflakeAt } from '../server/discord.js';
import { fallbackSummary } from '../server/desk/summarize.js';
import { AGENT, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

let h: Harness;
afterEach(() => {
  vi.useRealTimers();
  h?.close();
});

describe('summaries while an agent keeps posting', () => {
  it('new words push a summary back, but not past 30 s', async () => {
    vi.useFakeTimers();
    h = makeHarness({ summaryDelayMs: 8000 });
    const runs: number[] = [];
    h.summarizer.impl = async (input) => (runs.push(h.clock.now), fallbackSummary(input));
    h.discord.threads = [{ id: '7001', name: 'Speaker', parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
    h.discord.channels.set('7001', [msg(-1, 'owner', 'Wire the new speakers in')]);
    await h.source.poll();
    await h.core.drainSummaries();
    runs.length = 0;
    // The agent posts every 5 s for a minute: each would reset an 8 s wait.
    for (let i = 1; i <= 12; i++) {
      h.clock.now = NOW + i * 5000;
      h.discord.push('7001', msg(i / 12, 'agent', `Step ${i} done.`));
      await h.source.poll();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]).toBeLessThanOrEqual(NOW + 5000 + 30_000 + 5000);
  });
});
