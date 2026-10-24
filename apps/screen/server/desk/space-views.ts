import { ITEM_TYPES, STAGES } from './types.js';

export interface SpaceView {
  id: string;
  name: string;
  where: Record<string, { in?: string[]; not?: string[]; unset?: boolean }>;
  done?: boolean;
  group?: 'status' | 'stage' | 'type' | 'health' | 'none';
  sort?: 'recent' | 'asks';
}
const FACETS: Record<string, readonly string[] | null> = {
  wait: ['person', 'agent', 'review', 'job', 'monitor', 'check-back'], overdue: ['true', 'false'],
  health: ['failing', 'paused', 'running', 'on-schedule'], age: ['today', 'week', 'month', 'older'],
  source: null, account: null,
  kind: ['thread', 'default', 'job', 'worker'],
  live: ['needs', 'failed', 'stuck', 'finished', 'working', 'waiting', 'idle', 'unknown'],
  busy: ['working', 'background'], unread: ['true', 'false'], pinned: ['true', 'false'],
  stage: STAGES, type: ITEM_TYPES, agent: null, workspace: null, repo: null,
};
export function parseSpaceViews(raw: unknown): { views: SpaceView[] | null } | { error: string } {
  if (raw === null) return { views: null };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return { error: 'space views must contain 1 to 20 views, or null' };
  const ids = new Set<string>();
  const views: SpaceView[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.id) || ids.has(v.id)) return { error: 'space view ids must be valid and unique' };
    ids.add(v.id);
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40) return { error: 'space view names must be 1 to 40 characters' };
    if (!v.where || typeof v.where !== 'object' || Array.isArray(v.where)) return { error: 'space view where must be an object' };
    if (v.done !== undefined && typeof v.done !== 'boolean') return { error: 'done must be boolean' };
    if (v.group !== undefined && !['status', 'stage', 'type', 'health', 'none'].includes(v.group)) return { error: 'unknown space view grouping' };
    if (v.sort !== undefined && !['recent', 'asks'].includes(v.sort)) return { error: 'unknown space view sort' };
    const where: SpaceView['where'] = {};
    for (const [facet, rawFilter] of Object.entries(v.where)) {
      if (!Object.hasOwn(FACETS, facet) || !rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) return { error: 'unknown or invalid space view facet' };
      const filter = rawFilter as Record<string, unknown>;
      if (Object.keys(filter).some((k) => !['in', 'not', 'unset'].includes(k)) || (filter.unset !== undefined && typeof filter.unset !== 'boolean')) return { error: 'invalid facet filter' };
      const next: SpaceView['where'][string] = {};
      for (const key of ['in', 'not'] as const) {
        const values = filter[key];
        if (values === undefined) continue;
        if (!Array.isArray(values) || values.some((x) => typeof x !== 'string' || !x.trim() || x.length > 120 || (FACETS[facet] && !FACETS[facet]!.includes(x)))) return { error: `unknown or invalid ${facet} value` };
        next[key] = [...new Set(values as string[])];
      }
      if (filter.unset !== undefined) next.unset = filter.unset as boolean;
      where[facet] = next;
    }
    views.push({ id: v.id, name: v.name.trim(), where, ...(v.done !== undefined ? { done: v.done } : {}), ...(v.group ? { group: v.group } : {}), ...(v.sort ? { sort: v.sort } : {}) });
  }
  return { views };
}
export function readSpaceViews(raw: string | null): SpaceView[] | null {
  try { const result = parseSpaceViews(JSON.parse(raw || 'null')); return 'error' in result ? null : result.views; } catch { return null; }
}
