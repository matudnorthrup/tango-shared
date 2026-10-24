import * as path from 'node:path';
import { deskStatus } from '../server/desk/status.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { autoTagPrompt, parseAutoTag, type AutoTagInput } from '../server/desk/autotag.js';
import { fallbackSummary, parseModelSummary } from '../server/desk/summarize.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
// @ts-expect-error plain browser module, no types
import { STALL_MS, canActOnRow, knownGrouping, knownTab, liveState, watchingLabel, labelOrderOf, moveSection, releaseRow, rowTitle, sectionsOf, sortRows, stageOf, tabItems, tileFor, typeOf } from '../public/desk/list-model.js';
// @ts-expect-error plain browser module, no types
import { lastLifeAt, stuckMinutes } from '../public/desk/util.js';
// @ts-expect-error plain browser module, no types
import { currentSnoozeKey, snoozeChoices, wakeLabel } from '../public/desk/util.js';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { cid, makeHarness, NOW, type Harness } from './desk-harness.js';

// The List view (TGO-955): one column grouped by the owner's Loom labels, each row a stable name and
// one paragraph; labels set from the desk (a Loom thread is renamed, Discord keeps it on the desk);
// Loom's own project icons and pins, followed live. Synthetic names and data only.

const evaluated = (row: Record<string, unknown>) => ({ ...row, status: deskStatus(row as never, NOW) });

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const loom = (id: string, title: string, patch: Record<string, unknown> = {}) => evaluated({
  id: `loom:${id}`,
  source: 'loom',
  kind: 'thread',
  agentId: 'loom',
  agentName: 'Loom',
  place: `acme · ${title}`,
  area: 'acme',
  nextStep: 'your_move',
  disposition: 'active',
  lastActivityAt: NOW,
  facts: { project: { name: 'acme', icon: 'rocket', color: 'cyan' } },
  summary: { title: 'Pick a color', gist: 'Two palettes are ready.', ask: 'Which palette?' },
  ...patch,
});
const chat = (id: string, patch: Record<string, unknown> = {}) => evaluated({
  id: `discord:${id}`,
  source: 'discord',
  kind: 'chapter',
  agentId: 'sierra-ollama',
  agentName: 'Sierra',
  place: null,
  nextStep: 'fyi',
  disposition: 'active',
  lastActivityAt: NOW - 1000,
  facts: {},
  summary: { title: 'Fuses checked', about: 'Truck starting trouble', gist: 'The fuse is fine.' },
  ...patch,
});

describe('the list model', () => {
  it('stage and type are the desk’s own fields; a title prefix is not read', () => {
    expect(stageOf(loom('a', 'epic: Checkout', { facts: { stage: 'building', type: 'project' } }))).toBe('building');
    expect(typeOf(loom('a', 'epic: Checkout', { facts: { stage: 'building', type: 'project' } }))).toBe('project');
    expect(stageOf(loom('b', 'disc: Not seeded here'))).toBeNull();
    expect(stageOf(chat('c', { facts: { stage: 'nonsense' } }))).toBeNull();
    expect(knownGrouping('label')).toBe('stage');
  });

  it('names a row by what stays put: the thread title without an old prefix, or what a chat is about', () => {
    expect(rowTitle(loom('a', 'epic: Checkout redesign'))).toBe('Checkout redesign');
    expect(rowTitle(chat('b'))).toBe('Truck starting trouble');
    expect(rowTitle(chat('c', { kind: 'thread', place: 'Garden plan' }))).toBe('Garden plan');
    // A name the owner gave on the desk wins; a Loom thread's is its title.
    expect(rowTitle(chat('d', { kind: 'thread', place: 'Garden plan', facts: { name: 'Raised beds' } }))).toBe('Raised beds');
    expect(rowTitle(loom('e', 'Checkout', { facts: { name: 'ignored' } }))).toBe('Checkout');
  });

  it('tabs: Active is the whole rotation (filters can add hidden ones back, dimmed); then snoozed, parked, history', () => {
    const lists = {
      active: { items: [loom('a', 'x'), loom('b', 'x', { nextStep: 'working' }), chat('c'), loom('f', 'x', { nextStep: 'failed' })] },
      snoozed: { items: [loom('d', 'x', { disposition: 'snoozed' }), loom('e', 'x', { disposition: 'parked' })] },
      everything: { items: [loom('h', 'bug: Hidden', { filteredBy: ['type:bug'] }), loom('old', 'x', { disposition: 'done', filteredBy: ['type:bug'] }), loom('rule', 'bug: Rule-hidden', { hidden: true, filteredBy: ['type:bug'] })] },
      history: { items: [1] },
    };
    const ids = (tab: string, opts?: Record<string, unknown>) => tabItems(lists, tab, opts).map((i: { id?: string }) => i.id ?? i);
    expect(ids('active')).toEqual(['loom:a', 'loom:b', 'discord:c', 'loom:f']);
    expect(ids('active', { showHidden: true })).toEqual(['loom:a', 'loom:b', 'discord:c', 'loom:f', 'loom:h']);
    expect(tabItems(lists, 'active', { showHidden: true }).at(-1)).toMatchObject({ hiddenByFilter: true });
    expect(ids('snoozed')).toEqual(['loom:d']);
    expect(ids('parked')).toEqual(['loom:e']);
    expect(tabItems(lists, 'history')).toHaveLength(1);
    // A tab saved by the old List (Needs you, Working, Everything, …) opens Active.
    expect(knownTab('needs')).toBe('needs');
    expect(knownTab('everything')).toBe('active');
    expect(knownTab('parked')).toBe('active');
  });

  it('reads the server pill with no clock or summary inference in the browser', () => {
    const cases = [
      [{ running: { since: 1 } }, 'working'],
      [{ background: 'working' }, 'working'],
      [{ background: 'monitoring' }, 'waiting'],
      [{ running: { since: 1 }, pending: { kind: 'question' } }, 'needs'],
      [{ failed: { at: 1 }, background: 'monitoring' }, 'failed'],
      [{ job: { id: 'j', label: 'Nightly export' } }, 'working'],
      [{}, 'idle'],
      [{ sourceHealth: { ok: false, at: NOW } }, 'unknown'],
    ] as const;
    for (const [facts, pill] of cases) {
      const row = loom('a', 'x', { facts });
      expect(liveState(row, NOW)).toBe(pill);
      expect(liveState(row, NOW + 86_400_000)).toBe(pill);
      expect(liveState({ ...row, seen: 'seen' }, NOW)).toBe(pill);
    }
    expect(liveState(chat('summary', { nextStep: 'your_move', nextStepBasis: 'summary' }))).toBe('idle');
  });

  it('groups Active by pill while retaining stage as a neutral tag', () => {
    const items = [
      loom('none', 'Loose end'),
      chat('chat'),
      loom('disc', 'Research', { facts: { stage: 'discovery', type: 'feat' } }),
      loom('pin', 'Pinned one', { facts: { pinned: true, stage: 'discovery' } }),
      loom('build', 'Big thing', { facts: { stage: 'building', type: 'project' } }),
      chat('staged', { facts: { stage: 'feedback', type: 'bug' } }),
    ];
    const sections = sectionsOf(items, 'stage', 'active');
    expect(sections.map((s: { label: string; items: Array<{ id: string }> }) => [s.label, s.items.map((i) => i.id)])).toEqual([
      ['Idle', ['loom:none', 'loom:disc', 'loom:pin', 'loom:build', 'discord:chat', 'discord:staged']],
    ]);
    expect(items.map(stageOf)).toEqual([null, null, 'discovery', 'discovery', 'building', 'feedback']);
    expect(sectionsOf([], 'none', 'active')).toEqual([]);
  });

  it('a saved stage order cannot change the status precedence', () => {
    const items = [loom('idle', 'I'), loom('run', 'R', { facts: { running: { since: NOW }, stage: 'building' } }), loom('ask', 'A', { facts: { pending: { kind: 'question' }, stage: 'discovery' } })];
    expect(sectionsOf(items, 'stage', 'active', ['building', 'discovery']).map((s: { label: string }) => s.label)).toEqual(['Needs you', 'Working', 'Idle']);
    expect(labelOrderOf(['epic', 'hold', 'feedback'])).toEqual(['feedback', 'discovery', 'building', 'chat', 'none']);
    expect(moveSection(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveSection(['a', 'b', 'c'], 0, 5)).toEqual(['a', 'b', 'c']);
  });

  it('inside a section: newest first; history by when it was done', () => {
    const rows = sortRows([chat('old', { lastActivityAt: 1 }), loom('new', 'x', { lastActivityAt: 9 }), loom('mid', 'x', { lastActivityAt: 5 })], 'active');
    expect(rows.map((i: { id: string }) => i.id)).toEqual(['loom:new', 'loom:mid', 'discord:old']);
    expect(sortRows([loom('a', 'x', { doneAt: 1 }), loom('b', 'x', { doneAt: 2 })], 'history').map((i: { id: string }) => i.id)).toEqual(['loom:b', 'loom:a']);
  });

  it('orders by the owner’s last message, so agent activity does not move a row', () => {
    const rows = [
      loom('busy', 'x', { lastOwnerMessageAt: 1, createdAt: 0, lastActivityAt: 99 }),
      loom('asked', 'x', { lastOwnerMessageAt: 5, createdAt: 0, lastActivityAt: 6 }),
      // Never written in: when it started.
      chat('agents', { lastOwnerMessageAt: null, createdAt: 3, lastActivityAt: 98 }),
    ];
    expect(sortRows(rows, 'active').map((i: { id: string }) => i.id)).toEqual(['loom:asked', 'discord:agents', 'loom:busy']);
  });

  it('oldest first: the thread left longest leads, requests still first; history oldest done first', () => {
    const rows = [
      loom('recent', 'x', { lastOwnerMessageAt: 9 }),
      loom('left', 'x', { lastOwnerMessageAt: 1 }),
      loom('ask', 'x', { lastOwnerMessageAt: 5, sourceState: 'waiting_on_owner', nextStep: 'your_move' }),
      loom('mid', 'x', { lastOwnerMessageAt: 4 }),
    ];
    const ids = (list: Array<{ id: string }>) => list.map((i) => i.id);
    expect(ids(sortRows(rows, 'recent', { oldest: true }))).toEqual(['loom:left', 'loom:mid', 'loom:ask', 'loom:recent']);
    expect(ids(sortRows(rows, 'recent'))).toEqual(['loom:recent', 'loom:ask', 'loom:mid', 'loom:left']);
    expect(ids(sortRows([loom('a', 'x', { doneAt: 1 }), loom('b', 'x', { doneAt: 2 })], 'history', { oldest: true }))).toEqual(['loom:a', 'loom:b']);
    expect(ids(sectionsOf(rows, 'none', 'recent', undefined, { oldest: true })[0].items)).toEqual(['loom:left', 'loom:mid', 'loom:ask', 'loom:recent']);
  });

  it('wakes soonest: back now, then by wake time, then waiting on an event, then parked; your latest message breaks ties', () => {
    const rows = sortRows(
      [
        loom('parked', 'x', { disposition: 'parked', lastActivityAt: 9 }),
        loom('reply', 'x', { disposition: 'snoozed', snoozeTrigger: 'agent_posts', lastActivityAt: 1 }),
        loom('desk', 'x', { disposition: 'snoozed', snoozeTrigger: 'desk', lastActivityAt: 5 }),
        loom('later', 'x', { disposition: 'snoozed', snoozeUntil: new Date(NOW + 7_200_000).toISOString(), lastActivityAt: 9 }),
        // A time beside a trigger is the latest it wakes, so it sorts by the time.
        loom('soon', 'x', { disposition: 'snoozed', snoozeUntil: NOW + 3_600_000, snoozeTrigger: 'agent_posts', lastActivityAt: 1 }),
        loom('active', 'x', { lastActivityAt: 0 }),
      ],
      'wake',
    );
    expect(rows.map((i: { id: string }) => i.id)).toEqual(['loom:active', 'loom:soon', 'loom:later', 'loom:desk', 'loom:reply', 'loom:parked']);
  });

  it('an away row says when it is back, not how old it is', () => {
    const now = new Date(2026, 9, 14, 8, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();
    expect(wakeLabel({ disposition: 'snoozed', snoozeUntil: at(14, 15) }, now)).toMatch(/^back 3:00\sp\.?m\.?$/);
    expect(wakeLabel({ disposition: 'snoozed', snoozeUntil: at(15, 9) }, now)).toMatch(/^back tomorrow 9:00/);
    expect(wakeLabel({ disposition: 'snoozed', snoozeUntil: at(17, 9) }, now)).toMatch(/^back sat 9:00/);
    expect(wakeLabel({ disposition: 'snoozed', snoozeUntil: at(30, 9) }, now)).toBe('back oct 30');
    expect(wakeLabel({ disposition: 'snoozed', snoozeTrigger: 'desk' }, now)).toBe('back at my desk');
    expect(wakeLabel({ disposition: 'parked' }, now)).toBe('parked');
  });

  it('tiles: Loom’s project icon and color; an agent’s chosen icon, else its default, else a letter', () => {
    expect(tileFor(loom('a', 'x'))).toMatchObject({ icon: 'rocket', color: '#22d3ee', title: 'acme' });
    expect(tileFor(loom('b', 'x', { facts: { project: { name: 'acme', icon: null, color: null } } }))).toMatchObject({ icon: null, letter: 'A' });
    expect(tileFor(chat('c'))).toMatchObject({ icon: 'compass', color: '#fbbf24' });
    expect(tileFor(chat('d'), { sierra: { icon: 'mountain', color: null } })).toMatchObject({ icon: 'mountain', color: null });
    expect(tileFor(chat('e', { agentId: 'newbie', agentName: 'Newbie' }))).toMatchObject({ icon: null, letter: 'N', color: null });
  });

  it('a coding thread with no Loom icon falls back to the owner’s repo icon, else its repo’s letter', () => {
    const repoIcons = { acme: { icon: 'anvil', color: 'rose' } };
    // Loom's own icon still wins; with none, the repo's (any case); a Loom thread too.
    expect(tileFor(loom('a', 'x'), {}, repoIcons)).toMatchObject({ icon: 'rocket' });
    expect(tileFor(loom('b', 'x', { facts: { project: { name: 'Acme', icon: null, color: null } } }), {}, repoIcons)).toMatchObject({ icon: 'anvil', color: '#fb7185', title: 'Acme' });
    const loomRow = chat('l', { source: 'loom', agentId: 'loom', agentName: 'Loom', area: 'acme' });
    expect(tileFor(loomRow, {}, repoIcons)).toMatchObject({ icon: 'anvil', color: '#fb7185', title: 'acme' });
    expect(tileFor(loomRow)).toMatchObject({ icon: null, letter: 'A', color: '#94a3b8' });
  });

  it('a phone swipe: a long one acts, a short one holds a side open, a nudge snaps back', () => {
    expect(releaseRow(200, 360)).toEqual({ action: 'done' });
    expect(releaseRow(-230, 360)).toEqual({ action: 'snooze' });
    expect(releaseRow(60, 360)).toEqual({ open: 84 });
    expect(releaseRow(-60, 360)).toEqual({ open: -156 });
    expect(releaseRow(20, 360)).toEqual({ open: 0 });
  });
});

describe('one row, every open tab', () => {
  it('Snoozed and Parked rows take Done and Snooze like Active; History and a running turn don’t', () => {
    expect(canActOnRow(loom('a', 'Active'))).toBe(true);
    expect(canActOnRow(loom('s', 'Snoozed', { disposition: 'snoozed' }))).toBe(true);
    expect(canActOnRow(loom('p', 'Parked', { disposition: 'parked' }))).toBe(true);
    expect(canActOnRow(loom('d', 'Done', { disposition: 'done' }))).toBe(false);
    expect(canActOnRow(loom('w', 'Working', { nextStep: 'working' }))).toBe(false);
  });

  it('the snooze picker finds the current choice: a preset time, a trigger, park, or custom', () => {
    const now = new Date(2026, 9, 14, 9, 0);
    const choices = snoozeChoices(now);
    const morning = choices.find((c: { key: string }) => c.key === 'morning').args.until;
    expect(currentSnoozeKey({ disposition: 'snoozed', snoozeUntil: Date.parse(morning) }, choices)).toBe('morning');
    expect(currentSnoozeKey({ disposition: 'snoozed', snoozeUntil: morning }, choices)).toBe('morning');
    expect(currentSnoozeKey({ disposition: 'snoozed', snoozeTrigger: 'agent_posts' }, choices)).toBe('agent_posts');
    expect(currentSnoozeKey({ disposition: 'snoozed', snoozeTrigger: 'desk' }, choices)).toBe('desk');
    expect(currentSnoozeKey({ disposition: 'snoozed', snoozeUntil: Date.parse(morning) + 3600000 }, choices)).toBe('custom');
    expect(currentSnoozeKey({ disposition: 'parked' }, choices)).toBe('park');
    expect(currentSnoozeKey({ disposition: 'active' }, choices)).toBe(null);
  });

  it('the snooze presets wake at the owner\'s morning and evening times', () => {
    const now = new Date(2026, 9, 14, 9, 0); // a Wednesday
    const until = (choices: Array<{ key: string; args?: { until?: string } }>, key: string) => new Date(choices.find((c) => c.key === key)!.args!.until!);
    const mine = snoozeChoices(now, { morning: '04:00', evening: '15:30' });
    expect([until(mine, 'morning').getDate(), until(mine, 'morning').getHours()]).toEqual([15, 4]);
    expect([until(mine, 'monday').getDay(), until(mine, 'monday').getHours()]).toEqual([1, 4]);
    expect([until(mine, 'evening').getDate(), until(mine, 'evening').getHours(), until(mine, 'evening').getMinutes()]).toEqual([14, 15, 30]);
    // Past this evening's time, it's tomorrow evening.
    const late = snoozeChoices(new Date(2026, 9, 14, 16, 0), { morning: '04:00', evening: '15:00' });
    expect(late.find((c: { key: string }) => c.key === 'evening').label).toBe('Tomorrow evening');
    expect(until(late, 'evening').getDate()).toBe(15);
    // Nothing set (or junk): 6 am / 6 pm.
    expect(until(snoozeChoices(now, { morning: 'x' }), 'morning').getHours()).toBe(6);
    expect(until(snoozeChoices(now), 'evening').getHours()).toBe(18);
  });
});

describe('the summary paragraph', () => {
  const input = { agentName: 'Loom', place: 'acme', messages: [{ author: 'agent' as const, text: 'Two palettes are ready. Which one?' }] };
  it('reads it from the model, whitespace collapsed; the text fallback has none', () => {
    const out = parseModelSummary(JSON.stringify({ title: 'Pick a palette', gist: 'Two palettes are ready.', paragraph: 'Two palettes are ready.\n\n Pick the one you like.', step: 'your_move', ask: 'Which one?' }), input);
    expect(out.paragraph).toBe('Two palettes are ready. Pick the one you like.');
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'fyi' }), input).paragraph).toBeNull();
    expect(fallbackSummary(input).paragraph).toBeNull();
  });
});

describe('a Discord label stays on the desk', () => {
  let h: Harness;
  beforeEach(() => (h = makeHarness()));
  afterEach(() => h.close());
  it('seeds from an old desk label or thread-name prefix, and the tag command keeps it on the desk', async () => {
    h.core.ensureItem({ id: 'discord:thread:1', source: 'discord', kind: 'thread', conversationKey: 'k1', agentId: 'sierra', agentName: 'Sierra', place: 'chore: Tidy the shed', area: null, createdAt: NOW }, 'agent');
    expect(h.core.item('discord:thread:1')!.facts.type).toBe('chore');
    const r = await h.core.command({ commandId: cid(), type: 'tag', itemId: 'discord:thread:1', args: { stage: 'discovery' } });
    expect(r).toMatchObject({ status: 'applied', outcome: { stage: 'discovery', type: 'chore' } });
  });
  it('at start, items from before are seeded once, open hold items parked, and type filters mapped', () => {
    const make = (id: string, place: string) => h.core.ensureItem({ id, source: 'discord', kind: 'thread', conversationKey: id, agentId: 'sierra', agentName: 'Sierra', place, area: null, createdAt: NOW }, 'agent');
    make('discord:thread:old-epic', 'epic: Big plan');
    make('discord:thread:old-hold', 'hold: Someday');
    // As if they were filed before the desk owned stage and type.
    for (const id of ['discord:thread:old-epic', 'discord:thread:old-hold']) {
      const item = h.core.store.item(id)!;
      h.core.store.patchItem(id, { facts: { ...item.facts, tagsSeeded: false, stage: null, type: null } }, { bump: false });
    }
    h.core.store.setSetting('filters', JSON.stringify({ hideAgents: [], hideRepos: [], hideTypes: ['hold', 'epic', 'bug', 'disc'] }));
    h.core.store.setSetting('label_order', JSON.stringify(['disc', 'epic', 'chat', 'feat', 'hold', 'watch', 'none']));
    h.core.start(); // the filter and section-order migrations
    expect(h.core.item('discord:thread:old-epic')!.facts.tagsSeeded).toBe(false); // seeding waits for the first poll
    expect(h.core.seedAll()).toBe(2);
    expect(h.core.item('discord:thread:old-epic')!.facts).toMatchObject({ stage: 'building', type: 'project', tagsSeeded: true });
    expect(h.core.store.attention('discord:thread:old-hold')?.disposition).toBe('parked');
    expect(JSON.parse(h.core.store.setting('filters')!).hideTypes).toEqual(['project', 'bug']);
    // The old section order, translated onto the stages in the same order.
    expect(JSON.parse(h.core.store.setting('label_order')!)).toEqual(['discovery', 'building', 'chat', 'feedback', 'none']);
  });

  it('renames on the desk (Discord keeps its own name); empty goes back to it', async () => {
    h.core.ensureItem({ id: 'discord:thread:1', source: 'discord', kind: 'thread', conversationKey: 'k1', agentId: 'sierra', agentName: 'Sierra', place: 'Truck', area: null, createdAt: NOW }, 'agent');
    const r = await h.core.command({ commandId: cid(), type: 'rename', itemId: 'discord:thread:1', args: { title: 'pickup brakes' } });
    expect(r).toMatchObject({ status: 'applied', outcome: { title: 'pickup brakes', at: 'desk' } });
    expect(h.core.item('discord:thread:1')!).toMatchObject({ place: 'Truck', facts: { name: 'pickup brakes' } });
    expect(h.core.title(h.core.item('discord:thread:1')!)).toBe('pickup brakes');
    await h.core.command({ commandId: cid(), type: 'rename', itemId: 'discord:thread:1', args: { title: '' } });
    expect(h.core.item('discord:thread:1')!.facts.name).toBeNull();
  });

  it('pins on the desk (Discord has no pins)', async () => {
    h.core.ensureItem({ id: 'discord:thread:1', source: 'discord', kind: 'thread', conversationKey: 'k1', agentId: 'sierra', agentName: 'Sierra', place: 'Truck', area: null, createdAt: NOW }, 'agent');
    const r = await h.core.command({ commandId: cid(), type: 'pin', itemId: 'discord:thread:1', args: { pinned: true } });
    expect(r).toMatchObject({ status: 'applied', outcome: { pinned: true, at: 'desk' } });
    expect(h.core.item('discord:thread:1')!.facts.pinned).toBe(true);
  });
});

describe('HTTP: icons and agent icons', () => {
  let h: Harness;
  let hub: Hub;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    h = makeHarness();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50 } } });
  });
  afterEach(() => {
    hub.close();
    h.close();
  });
  const post = (body: unknown) => app.request('/api/desk/settings', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

  it('serves a Lucide icon by name and nothing else', async () => {
    const ok = await app.request('/api/desk/icon/rocket.svg');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/svg+xml');
    expect(await ok.text()).toContain('<svg');
    expect((await app.request('/api/desk/icon/not-an-icon.svg')).status).toBe(404);
    expect((await app.request('/api/desk/icon/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await app.request('/api/desk/icon/Rocket.svg')).status).toBe(404);
  });

  it('searches icons by name, then by tag, best first; the names are real icons', async () => {
    const byName = (await (await app.request('/api/desk/icons?q=rocket')).json()).icons;
    expect(byName[0]).toBe('rocket');
    const byTag = (await (await app.request('/api/desk/icons?q=money&limit=96')).json()).icons;
    expect(byTag.length).toBeGreaterThan(0);
    for (const name of byTag.slice(0, 5)) expect((await app.request(`/api/desk/icon/${name}.svg`)).status).toBe(200);
    expect((await (await app.request('/api/desk/icons?q=zzzz-nothing')).json()).icons).toEqual([]);
    expect((await (await app.request('/api/desk/icons?limit=5')).json()).icons).toHaveLength(5);
  });

  it('agent icons: a real icon and color save for every screen; a bad one is refused; null resets', async () => {
    expect(await (await post({ agentIcons: { sierra: { icon: 'mountain', color: 'rose' } } })).json()).toMatchObject({ agentIcons: { sierra: { icon: 'mountain', color: 'rose' } } });
    expect((await post({ agentIcons: { sierra: { icon: 'nope-nope', color: null } } })).status).toBe(400);
    expect((await post({ agentIcons: { sierra: { icon: 'mountain', color: 'chartreuse' } } })).status).toBe(400);
    expect((await post({ agentIcons: { 'Bad Id': { icon: 'mountain', color: null } } })).status).toBe(400);
    // The others stay when one is changed.
    await post({ agentIcons: { watson: { icon: 'briefcase', color: null } } });
    expect((await (await app.request('/api/desk/settings')).json()).agentIcons).toEqual({ sierra: { icon: 'mountain', color: 'rose' }, watson: { icon: 'briefcase', color: null } });
    await post({ agentIcons: { sierra: null } });
    expect((await (await app.request('/api/desk/settings')).json()).agentIcons).toEqual({ watson: { icon: 'briefcase', color: null } });
  });

  it('repo icons: saved by the repo’s name in lower case; a bad icon or color is refused; null removes it', async () => {
    expect(await (await post({ repoIcons: { Acme: { icon: 'mountain', color: 'rose' } } })).json()).toMatchObject({ repoIcons: { acme: { icon: 'mountain', color: 'rose' } } });
    expect((await post({ repoIcons: { tango: { icon: 'nope-nope', color: null } } })).status).toBe(400);
    expect((await post({ repoIcons: { tango: { icon: 'mountain', color: 'chartreuse' } } })).status).toBe(400);
    expect((await post({ repoIcons: { '  ': { icon: 'mountain', color: null } } })).status).toBe(400);
    expect((await post({ repoIcons: ['tango'] })).status).toBe(400);
    await post({ repoIcons: { 'side-studio': { icon: 'palette', color: null } } });
    expect((await (await app.request('/api/desk/settings')).json()).repoIcons).toEqual({ acme: { icon: 'mountain', color: 'rose' }, 'side-studio': { icon: 'palette', color: null } });
    await post({ repoIcons: { ACME: null } });
    expect((await (await app.request('/api/desk/settings')).json()).repoIcons).toEqual({ 'side-studio': { icon: 'palette', color: null } });
  });

  it('stage order: saved for every screen, completed with what it leaves out; an unknown or repeated section is refused', async () => {
    const initial = (await (await app.request('/api/desk/settings')).json()).labelOrder;
    expect(initial).toEqual(['discovery', 'building', 'feedback', 'chat', 'none']);
    const saved = (await (await post({ labelOrder: ['chat', 'feedback'] })).json()).labelOrder;
    expect(saved).toEqual(['chat', 'feedback', 'discovery', 'building', 'none']);
    expect((await (await app.request('/api/desk/settings')).json()).labelOrder).toEqual(saved);
    expect((await post({ labelOrder: ['pinned'] })).status).toBe(400);
    expect((await post({ labelOrder: ['epic'] })).status).toBe(400);
    expect((await post({ labelOrder: ['chat', 'chat'] })).status).toBe(400);
  });

  it('snooze times: 6 am / 6 pm until set; one changes without the other; a bad time is refused', async () => {
    expect((await (await app.request('/api/desk/settings')).json()).snoozeTimes).toEqual({ morning: '06:00', evening: '18:00' });
    expect((await (await post({ snoozeTimes: { morning: '04:00' } })).json()).snoozeTimes).toEqual({ morning: '04:00', evening: '18:00' });
    expect((await (await post({ snoozeTimes: { evening: '15:00' } })).json()).snoozeTimes).toEqual({ morning: '04:00', evening: '15:00' });
    expect((await post({ snoozeTimes: { morning: '4am' } })).status).toBe(400);
    expect((await post({ snoozeTimes: { noon: '12:00' } })).status).toBe(400);
    expect((await post({ snoozeTimes: { evening: '24:00' } })).status).toBe(400);
    expect((await (await app.request('/api/desk/settings')).json()).snoozeTimes).toEqual({ morning: '04:00', evening: '15:00' });
  });
});

describe('auto-tag rules', () => {
  it('reads only a known type, with confidence clamped', () => {
    expect(parseAutoTag('```json\n{"type": "Bug", "confidence": 1.4}\n```')).toEqual({ type: 'bug', confidence: 1 });
    expect(parseAutoTag('{"type": "epic", "confidence": 0.9}')).toBeNull();
    expect(parseAutoTag('nope')).toBeNull();
  });
  it('the prompt carries the owner’s examples', () => {
    const prompt = autoTagPrompt({ repo: 'acme', title: 'T', opening: 'Fix it', examples: [{ title: 'Old', opening: 'Make it\nbetter', type: 'enh' }] });
    expect(prompt.system).toContain('- [enh] Old: Make it better');
    expect(prompt.user).toContain('Repo: acme');
  });
});

describe('stage and type tags on a Loom thread', () => {
  let h: Harness;
  let source: DeskLoomSource;
  const at = (minute: number) => NOW + minute * 60_000;
  const ingest = (id: string, title: string) =>
    (source as unknown as { ingest(detail: unknown): void }).ingest({
      thread: { id, title, cwd: '/repos/acme', repo: '/repos/acme', status: 'idle', created_at: at(-60), updated_at: at(-5), settled_at: null },
      runs: [{ id: 'turn-1', status: 'completed', failure: null, started_at: at(-30), ended_at: at(-5) }],
      messages: [
        { id: `u:${id}`, role: 'user', text: 'Make it faster', created_at: at(-30) },
        { id: `a:${id}`, role: 'assistant', text: 'Done; it is twice as fast.', created_at: at(-5) },
      ],
      requests: [],
    });

  beforeEach(() => {
    h = makeHarness();
    source = new DeskLoomSource({ core: h.core, url: 'http://loom.test', tokenFile: `${h.dir}/missing-token`, projectFor: () => ({ name: 'acme', icon: null, color: null }) });
    (h.core as unknown as { options: { adapters: unknown[] } }).options.adapters.push(source);
  });
  afterEach(() => h.close());

  it('the tag command sets stage and type on the desk only', async () => {
    ingest('a', 'Speed');
    const r = await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:a', args: { stage: 'feedback', type: 'project' } });
    expect(r).toMatchObject({ status: 'applied', outcome: { stage: 'feedback', type: 'project' } });
    await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:a', args: { type: null } });
    expect(h.core.item('loom:a')!.facts).toMatchObject({ stage: 'feedback', type: null });
    expect((await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:a', args: { stage: 'urgent' } })).status).toBe('failed');
    expect((await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:a', args: {} })).status).toBe('failed');
  });

  it('stage is owner-only and never changes placement', async () => {
    ingest('a', 'Speed');
    ingest('b', 'Other');
    await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:b', args: { stage: 'building' } });
    const r = await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:a', args: { stage: 'feedback' } });
    expect(r).toMatchObject({ status: 'applied', outcome: { stage: 'feedback' } });
    expect(h.core.store.attention('loom:a')?.disposition).toBe('active');
    const denied = await h.core.command({ commandId: cid(), type: 'tag', itemId: 'loom:b', args: { stage: 'feedback' }, actor: 'agent' });
    expect(denied).toMatchObject({ status: 'failed', error: 'stage is owner-only' });
    expect(h.core.item('loom:b')!.facts.stage).toBe('building');
    expect(h.core.store.attention('loom:b')?.disposition).toBe('active');
  });
});

describe('a Loom thread in the list and the Conversation', () => {
  it('a Loom thread is a coding thread in the list: its project’s tile, its repo as the workspace, its title without the repo', () => {
    const loomItem = { id: 'loom:x', source: 'loom', agentId: 'loom', agentName: 'Loom', area: 'acme', place: 'acme · Harbor Hub', facts: { project: { name: 'acme', icon: 'gamepad-2', color: 'cyan' } } } as never;
    expect(tileFor(loomItem)).toMatchObject({ icon: 'gamepad-2', title: 'acme' });
    expect(rowTitle(loomItem)).toBe('Harbor Hub');
  });

  it('your latest words go above the reply once it answers them', async () => {
    const { answersLatest } = await import('../public/desk/conversation.js');
    const item = { facts: { lastOwnerRequest: { text: 'and the rear ones', at: 2_000 } } };
    expect(answersLatest(item, { at: 1_500 })).toBe(false); // the reply you answered: you follow it
    expect(answersLatest(item, { at: 2_500 })).toBe(true); // its answer to you: you lead it
    expect(answersLatest(item, null)).toBe(false);
    expect(answersLatest({ facts: {}, lastOwnerMessageAt: null }, { at: 2_500 })).toBe(false); // you never wrote
  });

  it('Stop shows only on a Loom thread that is running', async () => {
    const { canStop } = await import('../public/desk/conversation.js');
    expect(canStop({ source: 'loom', facts: { running: { since: 1 } } })).toBe(true);
    expect(canStop({ source: 'loom', facts: {} })).toBe(false);
    expect(canStop({ source: 'discord', facts: { running: { since: 1 } } })).toBe(false);
  });
});
