import { personaId, itemRepo, hideMatches, hideFacets } from '../../public/desk/query.js';
export { personaId, itemRepo } from '../../public/desk/query.js';
import type { DeskItem } from './types.js';

// In-app desk filters (spec "Filters"): the owner hides agents, T3 repos and
// thread types from the Active board, its counts and the voice briefing. They
// are toggles stored in desk_settings `filters` and shared by every screen; the
// rules file's `hide` stays the permanent, profile-level way to hide things.

export interface DeskFilters {
  hideAgents: string[];
  hideRepos: string[];
  hideTypes: string[];
}

export type FilterFacet = 'agent' | 'repo' | 'type';

/** Why an item is filtered: each hidden facet value it matches. */
export interface FilterMatch {
  facet: FilterFacet;
  value: string;
}

export const EMPTY_FILTERS: DeskFilters = { hideAgents: [], hideRepos: [], hideTypes: [] };

const MAX_VALUES = 100;
const MAX_LENGTH = 120;
/** A thread type: a short word at the start of a title, before a colon ("bug:", "ops: …"). */
const TYPE_PATTERN = /^\s*([a-z][a-z0-9_-]{0,15}):(?!\/\/)/i;

/** The title without a coding thread's "<repo> · " prefix. */
export function itemTitle(item: Pick<DeskItem, 'source' | 'area' | 'place'>): string {
  const place = item.place ?? '';
  if (item.source !== 'loom') return place;
  const repo = itemRepo(item);
  if (repo && place.startsWith(`${repo} · `)) return place.slice(repo.length + 3);
  const at = place.indexOf(' · ');
  return at >= 0 ? place.slice(at + 3) : place;
}

/** The thread type: the lowercased word before ":" at the start of the title ("bug:Fix" → "bug"), or null. */
export function threadType(title: string | null | undefined): string | null {
  const match = TYPE_PATTERN.exec(title ?? '');
  return match ? match[1]!.toLowerCase() : null;
}

/** The owner's type tag, kept on the desk (it used to be read from the T3 title prefix). */
export function itemType(item: { facts?: { type?: string | null } }): string | null {
  return item.facts?.type ?? null;
}

function cleanList(value: unknown, name: string, normalize: (entry: string) => string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${name} must be an array of strings`;
  if (value.length > MAX_VALUES) return `${name} takes at most ${MAX_VALUES} values`;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) return `${name} must be an array of non-empty strings`;
    if (entry.length > MAX_LENGTH) return `${name} values are at most ${MAX_LENGTH} characters`;
    const normalized = normalize(entry);
    if (!normalized) return `${name} has an invalid value: ${entry}`;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/** Validates a filters object: `{ hideAgents?, hideRepos?, hideTypes? }`, each an array of strings. */
export function parseFilters(raw: unknown): { filters: DeskFilters } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'filters must be an object { hideAgents, hideRepos, hideTypes }' };
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !['hideAgents', 'hideRepos', 'hideTypes'].includes(key));
  if (unknown.length) return { error: `filters has unknown keys: ${unknown.join(', ')}` };
  const hideAgents = cleanList(body.hideAgents, 'hideAgents', personaId);
  if (typeof hideAgents === 'string') return { error: hideAgents };
  const hideRepos = cleanList(body.hideRepos, 'hideRepos', (entry) => entry.trim());
  if (typeof hideRepos === 'string') return { error: hideRepos };
  // Types are stored lowercase without the colon; "Bug:" and "bug" are one type.
  const hideTypes = cleanList(body.hideTypes, 'hideTypes', (entry) => {
    const type = entry.trim().replace(/:$/, '').toLowerCase();
    return /^[a-z][a-z0-9_-]{0,15}$/.test(type) ? type : '';
  });
  if (typeof hideTypes === 'string') return { error: hideTypes };
  return { filters: { hideAgents, hideRepos, hideTypes } };
}

/** The stored filters (desk_settings `filters`), tolerant of a missing or damaged value. */
export function readFilters(store: { setting(key: string): string | null }): DeskFilters {
  const raw = store.setting('filters');
  if (!raw) return { ...EMPTY_FILTERS };
  try {
    const parsed = parseFilters(JSON.parse(raw));
    return 'filters' in parsed ? parsed.filters : { ...EMPTY_FILTERS };
  } catch {
    return { ...EMPTY_FILTERS };
  }
}

export function writeFilters(store: { setSetting(key: string, value: string): void }, filters: DeskFilters): void {
  store.setSetting('filters', JSON.stringify(filters));
}

export function filtersActive(filters: DeskFilters): boolean {
  return filters.hideAgents.length + filters.hideRepos.length + filters.hideTypes.length > 0;
}

/** The hidden facet values an item matches; empty when it is not filtered. */
export function filterMatches(item: Pick<DeskItem, 'agentId' | 'source' | 'area' | 'place' | 'facts'>, filters: DeskFilters): FilterMatch[] {
  return hideMatches(item, filters);
}

export function isFiltered(item: Pick<DeskItem, 'agentId' | 'source' | 'area' | 'place' | 'facts'>, filters: DeskFilters): boolean {
  return filterMatches(item, filters).length > 0;
}

export interface DeskFacets {
  agents: Array<{ id: string; name: string; count: number }>;
  repos: Array<{ name: string; count: number }>;
  types: Array<{ name: string; count: number }>;
}

/**
 * What can be filtered, from the given items (the Everything view), with counts.
 * Hidden values stay listed (count 0 when nothing carries them any more) so they can be turned back on.
 */
export function facetsFor(items: DeskItem[], filters: DeskFilters = EMPTY_FILTERS): DeskFacets {
  return hideFacets(items, filters);
}
