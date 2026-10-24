import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snowflakeAt } from '../server/discord.js';
import { deskStatus } from '../server/desk/status.js';
import { briefing } from '../server/desk/view.js';
import { AGENT, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// The ask lifecycle across rows, through the desk (docs/specs/agent-desk.md "Asks"; owner, 10/18).

const HOME = AGENT.homeChannelId;
const thread = (id: string, name = 'Speaker') => ({ id, name, parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) });

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.close());

const chapters = () => h.core.items().filter((entry) => entry.kind === 'chapter').sort((a, b) => a.createdAt - b.createdAt);

describe('asks across rows', () => {
  it('questions in Discord prose create no owner records; only superseded chapters are filed', async () => {
    h.discord.channels.set(HOME, [msg(-180, 'agent', 'Choose a layout?'), msg(-60, 'agent', 'Still open: choose a layout?')]);
    await h.source.poll();
    expect(chapters()).toHaveLength(2);
    for (const row of chapters()) {
      expect(row).toMatchObject({ nextStep: 'fyi', askRecord: null });
      expect(deskStatus(row)).toMatchObject({ pill: 'idle', countsForOwner: false });
    }
    expect(briefing(h.core).yourMove).toEqual([]);
    h.core.tick();
    expect(chapters().map((row) => row.disposition)).toEqual(['done', 'active']);
  });

  it('a recorded ask on an older thread stays open even when a newer thread repeats it', async () => {
    h.discord.threads = [thread('7401', 'Layout A'), thread('7402', 'Layout B')];
    h.discord.channels.set('7401', [msg(-180, 'agent', 'Choose a layout?')]);
    h.discord.channels.set('7402', [msg(-60, 'agent', 'Choose a layout?')]);
    await h.source.poll();
    const rows = h.core.items();
    for (const row of rows) {
      h.core.setFacts(row.id, { openAsk: { text: 'Choose a layout?', at: row.lastActivityAt } });
      h.core.refresh(row.id);
    }
    h.core.tick();
    for (const row of rows) {
      expect(h.core.item(row.id)).toMatchObject({ disposition: 'active', status: { pill: 'needs', countsForOwner: true } });
    }
    expect(briefing(h.core).yourMove.map((entry) => entry.id).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it('Discord closing lines create no ask; recorded asks with identical words or errand verbs each remain open', async () => {
    const same = 'Next — you: review the SQL script and say when it ran';
    h.discord.threads = [thread('7301', 'Scripts A'), thread('7302', 'Scripts B'), thread('7303', 'Garage')];
    h.discord.channels.set('7301', [msg(-50, 'agent', same)]);
    h.discord.channels.set('7302', [msg(-40, 'agent', same)]);
    h.discord.channels.set('7303', [msg(-30, 'agent', 'Next — you: buy the headlight')]);
    await h.source.poll();
    for (const id of ['7301', '7302', '7303']) {
      const row = h.core.item(`discord:thread:${id}`)!;
      expect(row).toMatchObject({ nextStep: 'fyi', askRecord: null });
      h.core.setFacts(row.id, { openAsk: { text: id === '7303' ? 'Buy the headlight' : 'Review the SQL script', at: NOW - 1000 } });
      h.core.refresh(row.id);
      expect(deskStatus(h.core.item(row.id)!)).toMatchObject({ pill: 'needs', countsForOwner: true });
    }
    expect(briefing(h.core).yourMove.map((entry) => entry.id).sort()).toEqual(['discord:thread:7301', 'discord:thread:7302', 'discord:thread:7303']);
    expect(briefing(h.core).counts).toMatchObject({ yourMove: 3, todo: 0 });
  });
});
