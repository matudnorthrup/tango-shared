import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snowflakeAt } from '../server/discord.js';
import { STALL_MS, deskStatus } from '../server/desk/status.js';
import { briefing, listItems, nextUpQueue } from '../server/desk/view.js';
import { AGENT, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// One answer to "does this wait on the owner" (desk/status.ts needsOwner), read the same way by every surface.

const HOME = AGENT.homeChannelId;
const thread = (id: string, name = 'Speaker') => ({ id, name, parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) });

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.close());

describe('what waits on the owner, across surfaces', () => {
  it('a stale starting message is Unknown, while a recorded ask counts equally across owner surfaces', async () => {
    h.discord.threads = [thread('7401', 'Dropped'), thread('7402', 'Asked')];
    h.discord.channels.set('7401', [msg(-10, 'agent', 'Ready when you are.'), msg(-4, 'owner', 'go ahead with the blue one')]);
    h.discord.channels.set('7402', [msg(-5, 'agent', 'Blue or green?')]);
    await h.source.poll();
    const dropped = 'discord:thread:7401';
    expect(h.core.item(dropped)).toMatchObject({ facts: { lastAuthor: 'owner' } });
    // Four minutes with no run: stalled, Failed on every surface, and in every count.
    h.clock.now = NOW + 1;
    expect(NOW - h.core.item(dropped)!.lastOwnerMessageAt!).toBeGreaterThanOrEqual(STALL_MS);
    h.core.setFacts('discord:thread:7402', { openAsk: { text: 'Blue or green?', at: NOW - 1000 } });
    h.core.refresh('discord:thread:7402');
    expect(deskStatus(h.core.item(dropped)!, h.clock.now)).toMatchObject({ pill: 'unknown', countsForOwner: false });
    const next = nextUpQueue(h.core).map((entry) => entry.id).sort();
    const brief = briefing(h.core);
    expect(next).toEqual(['discord:thread:7402']);
    expect(brief.yourMove.map((entry) => entry.id).sort()).toEqual(next);
    expect(brief.counts.yourMove).toBe(next.length);
    expect(listItems(h.core, { view: 'active' }).counts.yourMove).toBe(next.length);
    expect(brief.yourMove.some((entry) => entry.id === dropped)).toBe(false);
  });
});
