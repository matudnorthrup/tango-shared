import { facets, matches, type DeskQuery, type QueryContext } from './query.js';

type NamedSpace = { id: string; name: string };
export interface SearchFields {
  text: string;
  tokens: Array<{ field: string; value: string }>;
  queries: DeskQuery[];
  before?: number;
  after?: number;
}

/** Parse only supported field/value pairs. Unknown fields and invalid dates remain searchable words. */
export function parseSearchFields(raw: string, spaces: NamedSpace[] = [], agents: NamedSpace[] = [], now = Date.now()): SearchFields {
  const result: SearchFields = { text: '', tokens: [], queries: [] };
  const date = (value: string) => {
    if (/^\d+d$/.test(value)) return now - Number(value.slice(0, -1)) * 86_400_000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : undefined;
  };
  const query = (where: DeskQuery['where']): DeskQuery => ({ scope: { kind: 'global' }, audience: 'all', where });
  result.text = raw.replace(/(^|\s)([a-z]+):(?:"([^"]*)"|([^\s"]+))/gi, (whole, _prefix: string, field: string, quoted: string | undefined, bare: string | undefined) => {
    field = field.toLowerCase();
    const value = quoted ?? bare ?? '';
    let parsed: DeskQuery | undefined;
    if (field === 'is') {
      // The six pills; the retired words still find their rows (ready/todo → idle, watching/held → waiting).
      const live = ({ ready: 'idle', todo: 'idle', watching: 'waiting', held: 'waiting' } as Record<string, string>)[value] ?? value;
      if (['failed', 'stuck', 'needs', 'finished', 'working', 'waiting', 'idle', 'unknown'].includes(live)) parsed = query({ live: { in: [live] } });
      if (['unread', 'pinned'].includes(value)) parsed = query({ [value]: { in: ['true'] } });
    } else if (field === 'kind' && ['thread', 'default', 'job', 'worker'].includes(value)) parsed = query({ kind: { in: [value] } });
    else if (['agent', 'type', 'stage', 'repo'].includes(field)) {
      const id = field === 'agent' ? agents.find((a) => a.name.toLowerCase() === value.toLowerCase() || a.id.toLowerCase() === value.toLowerCase())?.id ?? value : value;
      parsed = query({ [field === 'repo' ? 'workspace' : field]: { in: [id] } });
    } else if (field === 'in') {
      const space = spaces.find((s) => s.name.toLowerCase() === value.toLowerCase() || s.id.toLowerCase() === value.toLowerCase());
      // An unresolved named space matches nothing; it must never silently become a global search.
      parsed = { ...query({}), scope: { kind: 'space', id: space?.id ?? 'unresolved:', descendants: true } };
    } else if (field === 'before' || field === 'after') {
      const at = date(value);
      if (at === undefined) return whole;
      if (field === 'before') result.before = Math.min(result.before ?? Infinity, at);
      else result.after = Math.max(result.after ?? -Infinity, at);
    } else return whole;
    if (!parsed && field !== 'before' && field !== 'after') return whole;
    if (parsed) result.queries.push(parsed);
    result.tokens.push({ field, value });
    return ' ';
  }).trim();
  return result;
}

/** Strict public API validation; never interpret malformed narrowing as a broad query. */
export function searchQuery(where: string | undefined, scope = 'global', audience = 'all'): DeskQuery {
  if (!['owner', 'all'].includes(audience)) throw new Error('invalid audience');
  if (scope !== 'global' && !/^space:(project|agent):[\w.-]{1,80}$/.test(scope)) throw new Error('invalid scope');
  const parsed: unknown = where ? JSON.parse(where) : {};
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid where');
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(facets, key) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid facet');
    for (const [op, picks] of Object.entries(value)) {
      if (op === 'unset' ? typeof picks !== 'boolean' : !['in', 'not'].includes(op) || !Array.isArray(picks) || picks.length > 100 || picks.some((v) => typeof v !== 'string' || v.length > 200)) throw new Error('invalid facet values');
    }
  }
  return { scope: scope === 'global' ? { kind: 'global' } : { kind: 'space', id: scope.slice(6), descendants: true }, audience: audience as 'all' | 'owner', where: parsed as DeskQuery['where'] };
}

// Snapshots retain identity, role, metadata, pin and project membership, but no current attention/read state.
const ARCHIVE_FACETS = new Set(['kind', 'stage', 'type', 'project', 'workspace', 'repo', 'agent', 'pinned', 'space', 'parent']);
export function searchMatches(row: { archived?: boolean; lastActivityAt: number }, queries: DeskQuery[], fields: SearchFields, ctx: QueryContext): boolean {
  if (fields.before !== undefined && row.lastActivityAt >= fields.before) return false;
  if (fields.after !== undefined && row.lastActivityAt <= fields.after) return false;
  return [...queries, ...fields.queries].every((q) => {
    if (row.archived && Object.entries(q.where).some(([key, f]) => !ARCHIVE_FACETS.has(key) && (f.in?.length || f.not?.length || f.unset !== undefined))) return false;
    return matches(row, q, ctx);
  });
}
