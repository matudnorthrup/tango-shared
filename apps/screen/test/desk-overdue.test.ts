import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snowflakeAt } from '../server/discord.js';
import { deskStatus } from '../server/desk/status.js';
import { fallbackSummary } from '../server/desk/summarize.js';
import { briefing } from '../server/desk/view.js';
import { AGENT, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// A wait past its time is a fact on the Watching row, never an ask of the owner (owner, 10/18). The agent's own
// late check-back is woken by the desk, once; a slow person is theirs to nudge and is left alone.

const HOME = AGENT.homeChannelId;
const thread = (id: string, name = 'Speaker') => ({ id, name, parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) });
const HOUR = 3_600_000;

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.close());

async function watchingThread(id: string, summary: Record<string, unknown>) {
  h.discord.threads = [thread(id, 'Export')];
  h.discord.channels.set(id, [msg(-30, 'agent', 'Export is running; more soon.')]);
  await h.source.poll();
  const itemId = `discord:thread:${id}`;
  const item = h.core.item(itemId)!;
  h.core.store.patchItem(itemId, { summary: { ...fallbackSummary({ agentName: 'Sierra', place: null, messages: [] }), step: 'watching', contentKey: item.facts.contentKey ?? '', at: NOW, ...summary } as never });
  h.core.refresh(itemId);
  return itemId;
}

describe('overdue waits', () => {
  it('a summary promise never creates a wait, overdue count, or wake', async () => {
    const itemId = await watchingThread('7101', { watchUntil: null });
    for (const hours of [23, 25, 49]) {
      h.clock.now = NOW + hours * HOUR;
      h.core.tick();
      expect(h.core.item(itemId)).toMatchObject({ nextStep: 'fyi', watching: null });
      expect(deskStatus(h.core.item(itemId)!)).toMatchObject({ pill: 'idle', countsForOwner: false });
      expect(briefing(h.core).counts).toMatchObject({ overdue: 0, yourMove: 0 });
      expect(h.posted).toHaveLength(0);
    }
  });

  it('a named person in a summary never creates a wait or owner move', async () => {
    const itemId = await watchingThread('7102', { waitingOn: { who: 'Reviewer', what: 'copy review', kind: 'person' } });
    h.clock.now = NOW + 49 * HOUR;
    h.core.tick();
    expect(h.core.item(itemId)).toMatchObject({ nextStep: 'fyi', nextStepBasis: 'source:responding', ask: null, watching: null });
    expect(h.posted).toHaveLength(0);
    expect(h.core.item(itemId)!.facts.overdueWoke ?? null).toBeNull();
    expect(briefing(h.core).counts).toMatchObject({ overdue: 0, yourMove: 0 });
  });

  it('a recorded wait names its target; a failing check reads Unknown', async () => {
    const itemId = await watchingThread('7103', {});
    const wait = { id: 'w', kind: 'pr' as const, target: 'PR #9', armedAt: NOW, lastCheckedAt: NOW };
    h.core.setFacts(itemId, { waits: [wait] });
    h.core.refresh(itemId);
    expect(deskStatus(h.core.item(itemId)!, NOW)).toMatchObject({ pill: 'waiting', detail: 'PR #9 · checked 0m ago' });
    h.core.setFacts(itemId, { waits: [{ ...wait, checkError: 'offline' }] });
    h.core.refresh(itemId);
    expect(deskStatus(h.core.item(itemId)!, NOW)).toMatchObject({ pill: 'unknown', basis: 'source:wait' });
    expect(h.posted).toHaveLength(0);
  });
});
