// Per-window feed membership uses exactly the saved-tab and space query contract.
import { matches, viewForFlags, viewToQuery } from './query.js';
import { viewsOf } from './list-views.js';

export function feedScopeOf(value) {
  if (value == null || value === '' || value === 'everything') return 'everything';
  return typeof value === 'string' && /^(tab:.+|space:(project|agent):.+)$/.test(value) ? value : 'tab:unavailable';
}

export function feedScopeQuery(scope, views, flags) {
  if (!scope || scope === 'everything') return null;
  if (scope.startsWith('tab:')) {
    const view = viewsOf(views).find((v) => v.id === scope.slice(4));
    // A deleted tab remains empty until the owner chooses another scope.
    return view ? viewToQuery(viewForFlags(view, flags), { audience: 'owner' }) : { scope: { kind: 'global' }, audience: 'all', where: { missing: { unset: true } } };
  }
  return { scope: { kind: 'space', id: scope.slice(6), descendants: true }, audience: 'all', where: {} };
}

export function itemInFeedScope(item, scope, ctx = {}) {
  const query = feedScopeQuery(scope, ctx.listViews, ctx.flags);
  return !query || !!item && matches(item, query, ctx);
}

/**
 * Whether a feed post belongs in a window's scope: by its conversation, or, for a project's own news (a
 * status or digest has a project and no conversation), by that project and the projects it sits inside
 * (Codex review on #801).
 */
export function postInFeedScope(post, item, scope, ctx = {}) {
  if (!scope || scope === 'everything') return true;
  if (item) return itemInFeedScope(item, scope, ctx);
  if (!post?.projectId || !scope.startsWith('space:project:')) return false;
  const want = scope.slice(6);
  let key = `project:${post.projectId}`;
  const seen = new Set();
  while (key && !seen.has(key)) {
    if (key === want) return true;
    seen.add(key);
    key = ctx.projects?.find((p) => `project:${p.id}` === key)?.parent || null;
  }
  return false;
}

export function scopedFeedPosts(posts, byId, scope, ctx = {}) {
  return posts.filter((post) => postInFeedScope(post, byId[post.itemId], scope, ctx));
}
