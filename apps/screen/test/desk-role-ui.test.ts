import { describe, expect, it } from 'vitest';
import { deskStatus } from '../server/desk/status.js';
// @ts-expect-error plain browser module, no types
import { roleOf, screenHold, stageKey, urlWithRole, viewFor } from '../public/desk/role.js';
// @ts-expect-error plain browser module, no types
import { bareName, eventPill, feedDays, feedShown, feedTap, feedVisible, kindLabel, liveDot, needsYouCount, nextArrival, openPosts, stuckCount } from '../public/desk/feed.js';

// What each window draws of the one presentation, by its role.

const p = (view: string, extra: Record<string, unknown> = {}) => ({ view, itemId: 'item-1', conversationKey: 'loom:a', sceneId: null, prototype: null, prototypes: [], ...extra });
const proto = (id: string, version = 1) => ({ id, version, title: id, agentName: 'Victor' });

describe('window roles', () => {
  it('reads the role from the address, defaulting to everything', () => {
    expect(roleOf('control')).toBe('control');
    expect(roleOf('screen')).toBe('screen');
    expect(roleOf(null)).toBe('full');
    expect(roleOf('kiosk')).toBe('full');
    expect(urlWithRole('https://desk.test/tango-screen/?name=wall', 'screen')).toBe('https://desk.test/tango-screen/?name=wall&role=screen');
    expect(urlWithRole('https://desk.test/tango-screen/?role=screen', 'full')).toBe('https://desk.test/tango-screen/');
  });

  it('a full window lets a scene take over; a control window stays on the conversation', () => {
    expect(viewFor('full', p('screen', { sceneId: 'x' }))).toBe('screen');
    expect(viewFor('control', p('screen', { sceneId: 'x' }))).toBe('conversation');
    expect(viewFor('control', p('prototype'))).toBe('conversation');
    expect(viewFor('control', p('screen', { itemId: null }))).toBe('active');
    expect(viewFor('control', p('active'))).toBe('active');
    expect(viewFor('screen', p('conversation'))).toBe('screen');
  });

  it('a screen window shows a scene while its conversation is open, then gives way to the feed', () => {
    let held = screenHold(null, p('conversation'));
    expect(held).toBeNull();
    held = screenHold(held, p('screen', { sceneId: 'scene-1' }));
    expect(held).toEqual({ kind: 'scene', id: 'scene-1', conversationKey: 'loom:a' });
    // The presentation arrives before the dashboard lists the new scene as live: it stays up.
    expect(screenHold(held, p('screen', { sceneId: 'scene-1' }), { scenes: [] }, false)).toBe(held);
    // Back to the conversation's overview on the Control window: still its conversation, so it stays.
    held = screenHold(held, p('conversation'), { scenes: ['scene-1'] }, false);
    expect(held).toMatchObject({ id: 'scene-1' });
    // The owner opens another conversation, or the List: the feed.
    expect(screenHold(held, p('conversation', { conversationKey: 'loom:b' }), { scenes: ['scene-1'] }, false)).toBeNull();
    expect(screenHold(held, p('active', { itemId: null, conversationKey: null }), { scenes: ['scene-1'] }, false)).toBeNull();
    // It ends: the feed.
    expect(screenHold(held, p('conversation'), { scenes: [] }, false)).toBeNull();
  });

  it('only something newly put up takes the window, and a pick from the shelf stays until dismissed', () => {
    // Sent back to the feed while the presentation still shows it: it doesn't come back on the next render.
    expect(screenHold(null, p('screen', { sceneId: 'scene-1' }), {}, false)).toBeNull();
    const pinned = { kind: 'scene', id: 'scene-9', conversationKey: 'loom:z', pinned: true };
    expect(screenHold(pinned, p('conversation', { conversationKey: 'loom:b' }), { scenes: ['scene-9'] }, false)).toBe(pinned);
    expect(screenHold(pinned, p('active'), { scenes: [] }, false)).toBeNull();
    // Something new put up replaces it.
    expect(screenHold(pinned, p('screen', { sceneId: 'scene-2' }), {}, true)).toMatchObject({ id: 'scene-2' });
  });

  it('a held prototype reloads at its newest version', () => {
    let held = screenHold(null, p('prototype', { prototype: { ...proto('proto-1'), conversationKey: 'loom:a' } }));
    expect(held).toMatchObject({ kind: 'prototype', prototype: { id: 'proto-1', version: 1 } });
    held = screenHold(held, p('conversation'), { prototypes: [proto('proto-1', 2)] }, false);
    expect(held.prototype.version).toBe(2);
    expect(stageKey(p('prototype', { prototype: proto('proto-1', 3) }))).toBe('prototype:proto-1@3');
    expect(screenHold(held, p('conversation'), { prototypes: [] }, false)).toBeNull();
  });

});

describe('the feed', () => {
  const now = new Date('2026-10-16T15:00:00').getTime();
  const post = (seq: number, at: number, extra: Record<string, unknown> = {}) => ({ seq, at, kind: 'update', itemId: `loom:${seq}`, title: `Post ${seq}`, text: '', count: 1, data: {}, ...extra });

  it('groups posts by day, newest first', () => {
    const days = feedDays([post(3, now - 60_000), post(2, now - 3_600_000), post(1, now - 86_400_000)], now);
    expect(days.map((d: any) => [d.day, d.posts.length])).toEqual([['Today', 2], ['Yesterday', 1]]);
  });

  it('a tap brings a live screen back here, else opens the thread', () => {
    expect(feedTap(post(1, now, { kind: 'screen', data: { id: 's1' } }), { scenes: ['s1'] })).toEqual({ pick: { kind: 'scene', id: 's1' } });
    expect(feedTap(post(1, now, { kind: 'screen', data: { id: 's1' } }), { scenes: [] })).toEqual({ open: 'loom:1' });
    const proto = { id: 'p1', version: 2, conversationKey: 'loom:9' };
    expect(feedTap(post(2, now, { kind: 'prototype', data: { id: 'p1' } }), { prototypes: [proto] })).toEqual({ pick: { kind: 'prototype', id: 'p1', prototype: proto, conversationKey: 'loom:9' } });
    expect(feedTap(post(3, now, { kind: 'project', itemId: null }), {})).toBeNull();
  });

  it("names threads without their repo, and says what a project's post is", () => {
    expect(bareName('acme · Photo Walk Slice Build')).toBe('Photo Walk Slice Build');
    expect(bareName('Chat with Juliet')).toBe('Chat with Juliet');
    expect(kindLabel({ kind: 'project', data: { digest: true } })).toBe('Daily digest');
    expect(kindLabel({ kind: 'project', data: {} })).toBe('Project status');
    expect(kindLabel({ kind: 'started', data: {} })).toBe('New thread');
  });

  it('new posts arrive one at a time, oldest first; a changed post arrives again', () => {
    const posts = [post(3, now - 1000), post(2, now - 5000), post(1, now - 9000)];
    expect(nextArrival(posts, new Set([`1@${now - 9000}`]))).toMatchObject({ seq: 2 });
    expect(nextArrival(posts, new Set(posts.map((p: any) => `${p.seq}@${p.at}`)))).toBeNull();
    // Post 3 changed (a state folded in an update): it arrives again.
    expect(nextArrival([{ ...posts[0], at: now }, posts[1], posts[2]], new Set(posts.map((p: any) => `${p.seq}@${p.at}`)))).toMatchObject({ seq: 3, at: now });
  });

  it('a changed post stays where it was until its new version arrives', () => {
    const old = post(2, now - 60_000, { title: 'Old words' });
    const shown = new Set([`1@${now - 90_000}`, `2@${now - 60_000}`]);
    const seen = new Map([[2, old]]);
    const posts = [post(2, now, { title: 'New words' }), post(1, now - 90_000)];
    // Waiting to arrive: the old copy, in its old place.
    expect(feedVisible(posts, shown, null, seen).map((p: any) => p.title)).toEqual(['Old words', 'Post 1']);
    // Changed again while arriving: the arriving copy finishes its entrance.
    const arriving = post(2, now, { title: 'New words' });
    expect(feedVisible([post(2, now + 5, { title: 'Newer words' }), post(1, now - 90_000)], shown, `2@${now}`, seen, arriving).map((p: any) => p.title)).toEqual(['New words', 'Post 1']);
    // Arriving: the new version, at the top; the old copy is gone.
    expect(feedVisible(posts, shown, `2@${now}`, seen).map((p: any) => p.title)).toEqual(['New words', 'Post 1']);
  });

  it('counts what needs you for the bar', () => {
    const item = (facts: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const row = { id: String(Math.random()), nextStep: 'quiet', disposition: 'active', facts, ...extra };
      return { ...row, status: deskStatus(row as never, now) };
    };
    const lists = { active: { items: [item({ pending: true }, { nextStep: 'your_move' }), item({ running: true }), item({ pending: true }, { nextStep: 'your_move', hiddenByFilter: true }), item({ pending: true }, { nextStep: 'your_move', filteredBy: [{ facet: 'agent', value: 'sierra' }] })] } };
    expect(needsYouCount(lists, now)).toBe(1);
  });
});

describe('window feed scope', () => {
  const now = Date.UTC(2026, 9, 19);
  it('scopes posts and the Needs-you badge through the same saved tab query', async () => {
    const { scopedFeedPosts } = await import('../public/desk/feed-scope.js');
    const a = { id: 'a', status: { pill: 'needs', countsForOwner: true, audience: 'owner' }, source: 'loom', agentId: 'agent', nextStep: 'your_move', disposition: 'active', facts: { projectId: 'p1', pending: true } };
    const b = { ...a, id: 'b', facts: { projectId: 'p2', pending: true } };
    const ctx = { projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], listViews: [{ id: 'mine', name: 'Mine', status: ['active'], projects: ['p1'] }] };
    const posts = [{ itemId: 'a' }, { itemId: 'b' }, { itemId: null }];
    expect(scopedFeedPosts(posts, { a, b }, 'tab:mine', ctx)).toEqual([{ itemId: 'a' }]);
    expect(needsYouCount({ active: { items: [a, b] } }, now, 'tab:mine', ctx)).toBe(1);
    expect(scopedFeedPosts(posts, { a, b }, 'everything', ctx)).toEqual(posts);
    expect(scopedFeedPosts(posts, { a, b }, 'tab:deleted', ctx)).toEqual([]);
    expect(needsYouCount({ active: { items: [a, b] } }, now, 'tab:deleted', ctx)).toBe(0);
  });

  it('includes descendant projects in a space and excludes unknown conversations', async () => {
    const { scopedFeedPosts } = await import('../public/desk/feed-scope.js');
    const a = { source: 'loom', facts: { projectId: 'child' } };
    const ctx = { projects: [{ id: 'parent' }, { id: 'child', parent: 'project:parent' }] };
    expect(scopedFeedPosts([{ itemId: 'a' }, { itemId: 'missing' }], { a }, 'space:project:parent', ctx)).toEqual([{ itemId: 'a' }]);
  });
});

describe('feed state posts read the rows now (spec feed-status.md)', () => {
  const needsRow = { id: 'a', status: { pill: 'needs', countsForOwner: true, audience: 'owner' }, facts: {} };
  const answered = { ...needsRow, status: { pill: 'idle', countsForOwner: false, audience: 'owner' } };
  const brokenWait = { id: 'w1', kind: 'pr', target: 'PR #5', armedAt: 0, checkError: '502', consecutiveErrors: 3 };
  const post = (seq: number, kind: string, itemId: string | null, data: Record<string, unknown> = {}) => ({ seq, at: seq, kind, itemId, title: `t${seq}`, text: '', data });

  it('colors a Needs you post only while its row is still in Needs you, and only the newest one', () => {
    const posts = [post(3, 'needs', 'a'), post(2, 'update', 'a'), post(1, 'needs', 'a')];
    expect([...openPosts(posts, { a: needsRow })]).toEqual([3]);
    expect(eventPill(posts[0], true)).toEqual({ cls: 'move', label: 'Needs you' });
    expect(eventPill(posts[2], false)).toEqual({ cls: 'neutral', label: 'Needs you · answered' });
    expect([...openPosts(posts, { a: answered })]).toEqual([]);
  });

  it('a Failed post on a row whose failure went to its lead is never open', () => {
    const worker = { id: 'w', status: { pill: 'failed', countsForOwner: false, audience: 'lead' }, facts: {} };
    expect([...openPosts([post(1, 'failed', 'w')], { w: worker })]).toEqual([]);
  });

  it('Stuck stays open while a wait keeps failing, whatever the pill; one or two failures are not stuck', () => {
    const working = { id: 's', status: { pill: 'working', countsForOwner: false }, facts: { waits: [brokenWait] } };
    expect([...openPosts([post(1, 'stuck', 's')], { s: working })]).toEqual([1]);
    const twice = { ...working, facts: { waits: [{ ...brokenWait, consecutiveErrors: 2 }] } };
    expect([...openPosts([post(1, 'stuck', 's')], { s: twice })]).toEqual([]);
    expect(eventPill(post(1, 'stuck', 's'), false).label).toBe('Stuck · checking again');
  });

  it('a Stuck post is open only while its own wait is broken, not another of the thread\'s waits', () => {
    const w1 = { ...brokenWait, id: 'w1' };
    const row = { id: 's', status: { pill: 'working', countsForOwner: false }, facts: { waits: [w1, { ...brokenWait, id: 'w2', checkError: null, consecutiveErrors: 0 }] } };
    const posts = [post(2, 'stuck', 's', { waitId: 'w2' }), post(1, 'stuck', 's', { waitId: 'w1' })];
    expect([...openPosts(posts, { s: row })]).toEqual([1]);
  });

  it('"Show answered asks" off folds a closed state post: into its words when it carries some, else away', () => {
    const posts = [post(3, 'needs', 'a'), post(2, 'failed', 'b', { update: true }), post(1, 'failed', 'c')];
    const byId = { a: needsRow, b: answered, c: answered };
    expect(feedShown(posts, byId, { needsYou: false }).map((p: { seq: number; kind: string }) => [p.seq, p.kind])).toEqual([[3, 'needs'], [2, 'update']]);
    expect(feedShown(posts, byId, { needsYou: true })).toEqual(posts);
  });

  it('every other post takes a neutral pill; the live dot is the row\'s pill now', () => {
    for (const kind of ['update', 'done', 'pr', 'mail', 'system', 'screen', 'started']) expect(eventPill(post(1, kind, 'a')).cls).toBe('neutral');
    expect(liveDot(needsRow)).toEqual({ cls: 'needs', label: 'Needs you' });
    expect(liveDot(null)).toBeNull();
  });

  it('Decided and Finished take a dark chip; a summary is labeled Summary', () => {
    expect(eventPill(post(1, 'decided', 'a'))).toEqual({ cls: 'dark', label: 'Decided for you' });
    expect(eventPill(post(1, 'shipped', 'a'))).toEqual({ cls: 'dark', label: 'Finished' });
    expect(eventPill(post(1, 'update', 'a', { summary: true }))).toEqual({ cls: 'neutral', label: 'Summary' });
    expect(eventPill(post(1, 'update', 'a', { ledger: true }))).toEqual({ cls: 'neutral', label: 'Update' });
  });

  it('the bar counts stuck rows beside Needs you', () => {
    const stuckRow = { id: 's', status: { pill: 'working', countsForOwner: false }, disposition: 'active', facts: { waits: [brokenWait] } };
    const lists = { active: { items: [{ ...needsRow, disposition: 'active' }, stuckRow] } };
    expect(needsYouCount(lists)).toBe(1);
    expect(stuckCount(lists)).toBe(1);
  });
});
