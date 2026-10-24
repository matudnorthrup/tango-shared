// The feed: a Screen window's page when no scene or prototype is up (role.js). What changed across the
// desk, newest first, as posts the server writes when things happen (desk/feed.ts): a thread's update in
// its own words, a project's status, a PR decided, a screen put up, work done. Not the List again: the
// List says where things stand, the feed says what happened. Settings › Feed decides what posts.

import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { itemInFeedScope } from './feed-scope.js';
import { FeedUsage } from './feed-usage.js';
import { wantsOwner } from './list-model.js';
import { RowCard } from './next/rows.js';
import { rowOf, STATUS } from './next/model.js';
import { clockTime, dayLabel } from './util.js';

export const FEED_KIND_NAMES = {
  update: 'Update',
  started: 'New thread',
  needs: 'Needs you',
  failed: 'Failed',
  stuck: 'Stuck',
  decided: 'Decided for you',
  shipped: 'Finished',
  done: 'Done',
  project: 'Project',
  pr: 'Pull request',
  screen: 'Showed a screen',
  prototype: 'Published a prototype',
  mail: 'Agents talking',
  system: 'System',
};

/** Posts by day (Today, Yesterday, a weekday…), newest first: [{ day, posts }]. */
export function feedDays(posts, now = Date.now()) {
  const days = [];
  for (const post of posts) {
    const day = dayLabel(post.at, now);
    if (days.at(-1)?.day === day) days.at(-1).posts.push(post);
    else days.push({ day, posts: [post] });
  }
  return days;
}

/** What a tap on a post does: a screen still live goes back up here; anything else with a thread opens it (Control follows). */
export function feedTap(post, live = {}) {
  if (post.kind === 'screen' && post.data?.id && live.scenes?.includes(post.data.id)) return { pick: { kind: 'scene', id: post.data.id } };
  const proto = post.kind === 'prototype' && post.data?.id ? (live.prototypes || []).find((p) => p.id === post.data.id) : null;
  if (proto) return { pick: { kind: 'prototype', id: proto.id, prototype: proto, conversationKey: proto.conversationKey } };
  return post.itemId ? { open: post.itemId } : null;
}

/** The rows in the window's Feed scope that the bar counts. Muted rows stay out of every owner count (Codex review on #763). */
const scoped = (lists, now, scope, ctx) => (lists.active?.items || []).filter((item) => itemInFeedScope(item, scope, { ...ctx, now }) && !item.hiddenByFilter && !item.filteredBy?.length);

/** "Needs you" for the bar: the evaluator's count (wantsOwner reads countsForOwner), the Feed scope on top. */
export function needsYouCount(lists, now = Date.now(), scope = 'everything', ctx = {}) {
  return scoped(lists, now, scope, ctx).filter((item) => wantsOwner(item, now)).length;
}

/** A wait whose checks keep failing: three in a row, when Loom wakes the thread (server desk/status.ts stuckWaits). */
const STUCK_ERRORS = 3;
const waitStuck = (w) => !!w.checkError && (w.consecutiveErrors ?? STUCK_ERRORS) >= STUCK_ERRORS;
export const isStuck = (item) => !!item?.facts?.waits?.some(waitStuck);

/** "1 stuck" beside it: rows in scope with an open Stuck record, whatever their pill. */
export function stuckCount(lists, now = Date.now(), scope = 'everything', ctx = {}) {
  return scoped(lists, now, scope, ctx).filter(isStuck).length;
}

/** The three posts that say where a thread stands, in its status color only while that record is open. */
const STATE_POSTS = { needs: { cls: 'move', closed: 'answered' }, failed: { cls: 'failed', closed: 'retried' }, stuck: { cls: 'unknown', closed: 'checking again' } };

/** Whether the row is still in the state the post says: its status now, never the post's own words. A Stuck post, its own wait. */
function stillIn(post, item) {
  if (!item) return false;
  // A Stuck post without a wait is the row's own Stuck (a "me" hand-off with nothing behind it): its pill says.
  if (post.kind === 'stuck') return post.data?.waitId ? !!item.facts?.waits?.some((w) => w.id === post.data.waitId && waitStuck(w)) : item.status?.pill === 'stuck' || isStuck(item);
  return item.status?.countsForOwner === true && item.status?.pill === post.kind;
}

/**
 * Each state post, open or closed: open when it is its thread's newest post of that kind and the row is still in
 * that state. Seqs of the open ones.
 */
export function openPosts(posts, byId = {}) {
  const open = new Set();
  const newest = new Set();
  for (const post of posts) {
    if (!STATE_POSTS[post.kind] || !post.itemId) continue;
    // Stuck is per wait: each wait's newest post.
    const key = `${post.kind}:${post.itemId}${post.kind === 'stuck' && post.data?.waitId ? `:${post.data.waitId}` : ''}`;
    if (newest.has(key)) continue;
    newest.add(key);
    if (stillIn(post, byId[post.itemId])) open.add(post.seq);
  }
  return open;
}

/**
 * What the feed shows, by the owner's "Show answered asks" (feed setting `needsYou`): off, a state post whose
 * record has closed folds away, into its words as an update when it carries some.
 */
export function feedShown(posts, byId = {}, settings = {}) {
  if (settings.needsYou) return posts;
  const open = openPosts(posts, byId);
  const out = [];
  for (const post of posts) {
    if (!STATE_POSTS[post.kind] || open.has(post.seq)) out.push(post);
    else if (post.data?.update) out.push({ ...post, kind: 'update' });
  }
  return out;
}

/** The event pill: what happened, in neutral colors. Only an open Needs you, Failed or Stuck takes its status color. */
export function eventPill(post, open = false) {
  const state = STATE_POSTS[post.kind];
  if (state) return open ? { cls: state.cls, label: kindLabel(post) } : { cls: 'neutral', label: `${kindLabel(post)} · ${state.closed}` };
  // Decided and Shipped are records the owner may want to undo or look at: a plain dark chip, still no status color.
  if (post.kind === 'decided' || post.kind === 'shipped') return { cls: 'dark', label: kindLabel(post) };
  return { cls: 'neutral', label: kindLabel(post) };
}

/** The row's live status dot: where the thread stands now, from the evaluator. None for a post with no thread. */
export function liveDot(item) {
  const pill = item?.status?.pill;
  if (!pill) return null;
  return { cls: pill, label: STATUS[pill]?.label || pill };
}

/** A thread's name without its repo ("acme · Photo Walk" → "Photo Walk"): the repo is noise here. */
export function bareName(name) {
  const at = String(name || '').indexOf(' · ');
  return at >= 0 ? name.slice(at + 3) : String(name || '');
}

/** The pill: what kind of news it is. A project's post is its coordinator's status or its daily digest. */
export function kindLabel(post) {
  if (post.kind === 'project') return post.data?.digest ? 'Daily digest' : 'Project status';
  // A system incident's post (desk/system.ts): what happened to it.
  if (post.kind === 'system') return { opened: 'New problem', escalated: 'Got worse', regressed: 'Came back', reminder: 'Still open', resolved: 'Resolved' }[post.data?.transition] || 'System';
  // A model's words posting on their own are labeled as such (feed-status.md "What posts").
  if (post.kind === 'update' && post.data?.summary) return 'Summary';
  return FEED_KIND_NAMES[post.kind] || post.kind;
}

/**
 * A post, drawn as the next layout's row (next/rows.js RowCard). The big line is the update's headline
 * (the summarizer writes it as news, never an ask), else the thread's name; the thread then sits in the
 * meta beside its project and the pill. The preview is what happened (Settings › Display › Preview lines).
 */
function Post({ post, store, onPick, entering = false, open = false }) {
  const { state } = store;
  const item = post.itemId ? state.byId[post.itemId] : null;
  const projects = state.projects || [];
  const r = item ? rowOf(item, { projects, now: state.now }) : null;
  const project = post.projectId ? projects.find((p) => p.id === post.projectId) : null;
  const tile = r?.tile ?? (project ? { kind: 'project', id: project.id, project } : post.agentName ? { kind: 'agent', id: post.agentName.toLowerCase(), name: post.agentName } : null);
  const thread = r?.title ?? null;
  const headline = post.data?.headline ? post.title : null;
  const mailTitle = post.kind === 'mail' ? [post.data?.from, post.data?.to].map((id) => (state.byId[id] ? rowOf(state.byId[id], { projects }).title : null)) : null;
  const title = headline || (mailTitle ? (mailTitle.every(Boolean) ? mailTitle.join(' → ') : post.title.split(' → ').map(bareName).join(' → ')) : thread ?? post.title);
  const preview = post.text && post.text.trim() !== title.trim() ? post.text : null;
  const tap = feedTap(post, state.live);
  const go = tap ? () => (tap.pick ? onPick({ ...tap.pick, conversationKey: tap.pick.conversationKey ?? item?.conversationKey ?? null }) : store.openItem(tap.open)) : null;
  // A PR's or a screen's own name is part of the news: it leads the meta when the big line is the thread.
  const named = r && !headline && (post.kind === 'pr' || post.kind === 'screen' || post.kind === 'prototype') ? post.title : null;
  const where = [named, headline ? thread : null, r?.home?.name].filter(Boolean).join(' · ') || null;
  const count = post.count > 1 ? `${post.count} ${post.kind === 'mail' ? 'messages' : 'updates'}` : null;
  return html`<div class=${`fpost${entering ? ' entering' : ''}`}><div class="fpost-in">
    <${RowCard} store=${store} prItem=${item} title=${title} time=${clockTime(post.at)} tile=${tile} preview=${preview}
      pill=${eventPill(post, open)} dot=${liveDot(item)} where=${where} facts=${count ? [count] : []}
      label=${`Open ${thread || title}`} onOpen=${go} />
  </div></div>`;
}

/** How long a new post takes to arrive: the list eases down to open its place, then it fades in. */
export const ENTER_MS = 3600;
const keyOf = (post) => `${post.seq}@${post.at}`;

/**
 * The next post to arrive: the oldest one not shown yet. A post that changed (a state change folding in an
 * update) arrives again, at its new place.
 */
export function nextArrival(posts, shown) {
  return posts.filter((post) => !shown.has(keyOf(post))).sort((a, b) => a.at - b.at || a.seq - b.seq)[0] || null;
}

/**
 * What shows now: posts that have arrived, the one arriving, and, for a post that changed and waits to
 * arrive again, its last copy where it was (removing it at once made the list jump before the drop-in).
 *   seen: seq -> the copy last shown
 */
export function feedVisible(posts, shown, entering, seen, enteringCopy = null) {
  const out = [];
  for (const post of posts) {
    const key = keyOf(post);
    if (shown.has(key) || key === entering) out.push(post);
    // Changed while arriving: the arriving copy finishes its entrance (Codex review on #640).
    else if (enteringCopy && enteringCopy.seq === post.seq && keyOf(enteringCopy) === entering) out.push(enteringCopy);
    else if (seen.has(post.seq) && shown.has(keyOf(seen.get(post.seq)))) out.push(seen.get(post.seq));
  }
  return out.sort((a, b) => b.at - a.at || b.seq - a.seq);
}

export function Feed({ store, onPick }) {
  const { state } = store;
  const { loaded } = state.feed;
  // Closed state posts fold by the rows' status now, so the feed follows the List without a new read.
  const posts = useMemo(() => feedShown(state.feed.posts, state.byId, state.feedSettings), [state.feed.posts, state.byId, state.feedSettings]);
  const open = useMemo(() => openPosts(state.feed.posts, state.byId), [state.feed.posts, state.byId]);
  // What has arrived (by seq@at); the rest arrive one at a time. Everything there on first load just shows.
  const [shown, setShown] = useState(null);
  const [entering, setEntering] = useState(null);
  const seen = useRef(new Map());
  const enteringCopy = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (loaded && shown === null) setShown(new Set(posts.map(keyOf)));
  }, [loaded]);
  // A read that brought nothing new (a settings change, a reconnect): everything in it shows at once.
  const settled = useRef(state.feed.settle);
  useEffect(() => {
    if (shown !== null && state.feed.settle) setShown((was) => new Set([...was, ...posts.map(keyOf)]));
  }, [state.feed.settle]);
  useEffect(() => {
    // A settling read lands this render: its posts are shown, not queued (the effect above, then this one again).
    if (settled.current !== state.feed.settle) {
      settled.current = state.feed.settle;
      return;
    }
    if (!shown || entering) return;
    const next = nextArrival(posts, shown);
    if (!next) return;
    const key = keyOf(next);
    setEntering(key);
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer.current = setTimeout(() => {
      // Arrived: this copy is now the one that holds its place, even if the row changed meanwhile (Codex review on #640).
      if (enteringCopy.current && keyOf(enteringCopy.current) === key) seen.current.set(enteringCopy.current.seq, enteringCopy.current);
      setShown((was) => new Set(was).add(key));
      setEntering(null);
    }, reduced ? 0 : ENTER_MS);
  }, [posts, shown, entering, state.feed.settle]);
  if (entering && keyOf(enteringCopy.current || { seq: 0, at: 0 }) !== entering) enteringCopy.current = posts.find((post) => keyOf(post) === entering) || enteringCopy.current;
  const visible = shown ? feedVisible(posts, shown, entering, seen.current, enteringCopy.current) : posts;
  // Only copies that have arrived are remembered: one still arriving isn't a place to hold.
  for (const post of visible) if (shown?.has(keyOf(post))) seen.current.set(post.seq, post);
  const days = feedDays(visible, state.now);
  const body = !loaded
    ? html`<p class="fempty">Loading the feed…</p>`
    : !posts.length
      ? html`<p class="fempty">Nothing new yet. Updates, project news and finished work show here as they happen.</p>`
      : days.map(({ day, posts: list }) => html`<section key=${day}><h2 class="fday">${day}</h2>${list.map((post) => html`<${Post} key=${post.seq} post=${post} store=${store} onPick=${onPick} entering=${keyOf(post) === entering} open=${open.has(post.seq)} />`)}</section>`);
  const usage = state.feedSettings?.usage !== false ? html`<${FeedUsage} store=${store} />` : null;
  return html`<div class="feed"><div class="feed-col">${usage}${body}</div></div>`;
}
