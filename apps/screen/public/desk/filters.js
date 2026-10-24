// Global owner Mutes: shared settings, applied to Inbox and owner queues.
// Space pages and Search retain muted rows. Stored keys remain filters/hide*.

import { personaId, itemRepo, hideMatches, hideFacets } from './query.js';
export { personaId, itemRepo } from './query.js';

export const NO_FILTERS = Object.freeze({ hideAgents: [], hideRepos: [], hideTypes: [] });
const KEYS = { agent: 'hideAgents', repo: 'hideRepos', type: 'hideTypes' };
const TYPE_PATTERN = /^\s*([a-z][a-z0-9_-]{0,15}):(?!\/\/)/i;

export function itemTitle(item) {
  const place = item?.place || '';
  if (!item || (item.source !== 'loom')) return place;
  const repo = itemRepo(item);
  if (repo && place.startsWith(`${repo} · `)) return place.slice(repo.length + 3);
  const at = place.indexOf(' · ');
  return at >= 0 ? place.slice(at + 3) : place;
}

export function threadType(title) {
  const match = TYPE_PATTERN.exec(title || '');
  return match ? match[1].toLowerCase() : null;
}

export function itemType(item) {
  // The owner's type tag, kept on the desk (no longer the Loom title prefix).
  return item?.facts?.type ?? null;
}

export function normalizeFilters(filters) {
  const f = filters || {};
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  return { hideAgents: [...new Set(list(f.hideAgents).map(personaId))], hideRepos: list(f.hideRepos), hideTypes: list(f.hideTypes) };
}

export function hiddenCount(filters) {
  const f = normalizeFilters(filters);
  return f.hideAgents.length + f.hideRepos.length + f.hideTypes.length;
}

export function isHidden(filters, facet, value) {
  const list = normalizeFilters(filters)[KEYS[facet]];
  if (facet === 'repo') return list.some((v) => v.toLowerCase() === String(value).toLowerCase());
  return list.includes(facet === 'agent' ? personaId(value) : String(value).toLowerCase());
}

/** The filters with one facet value flipped (hidden ↔ shown). */
export function toggleFilter(filters, facet, value) {
  const next = normalizeFilters(filters);
  const key = KEYS[facet];
  if (!key) return next;
  const v = facet === 'agent' ? personaId(value) : facet === 'type' ? String(value).toLowerCase().replace(/:$/, '') : String(value).trim();
  const same = (x) => (facet === 'repo' ? x.toLowerCase() === v.toLowerCase() : x === v);
  next[key] = next[key].some(same) ? next[key].filter((x) => !same(x)) : [...next[key], v];
  return next;
}

/** The filters without the values that filtered this item (its `filteredBy`): the "Show" action. */
export function showFiltered(filters, matches) {
  let next = normalizeFilters(filters);
  for (const m of matches || []) if (isHidden(next, m.facet, m.value)) next = toggleFilter(next, m.facet, m.value);
  return next;
}

/** The hidden facet values an item matches (what the server returns as `filteredBy`). */
export function filterMatches(item, filters) {
  return hideMatches(item, normalizeFilters(filters));
}

/** `{ agents, repos, types }` with counts, from items (the fixtures' /api/desk/facets). */
export function facetsFor(items, filters) {
  return hideFacets(items, normalizeFilters(filters));
}

// ── text size (this device only) ─────────────────────────────────────

export const DEFAULT_TEXT_SCALE = 1.2;
const TEXT_SCALE_KEY = 'desk.textScale';
const clampScale = (value) => Math.min(2, Math.max(0.8, Math.round(Number(value) * 20) / 20));

/** The text size picked on this device, else the default (storage can be missing or blocked). */
export function savedTextScale() {
  try {
    const raw = localStorage.getItem(TEXT_SCALE_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) return clampScale(raw);
  } catch {}
  return DEFAULT_TEXT_SCALE;
}

/** Sets the desk's text size (the --scale knob in desk.css) and remembers it on this device. */
export function applyTextScale(value, { save = false } = {}) {
  const scale = clampScale(value);
  document.documentElement.style.setProperty('--scale', String(scale));
  if (save) {
    try {
      if (scale === DEFAULT_TEXT_SCALE) localStorage.removeItem(TEXT_SCALE_KEY);
      else localStorage.setItem(TEXT_SCALE_KEY, String(scale));
    } catch {}
  }
  return scale;
}

// ── List preview lines (this device only) ───────────────────────────

export const DEFAULT_PREVIEW_LINES = 3;
export const PREVIEW_LINE_CHOICES = [0, 1, 2, 3, 4, 5, 'all'];
const PREVIEW_LINES_KEY = 'desk.previewLines';
const toPreviewLines = (value) => (value === 'all' ? 'all' : PREVIEW_LINE_CHOICES.includes(Number(value)) ? Number(value) : DEFAULT_PREVIEW_LINES);

/** How many lines of each row's paragraph the List shows on this device: 0 (title only) to 5, or 'all'. */
export function savedPreviewLines() {
  try {
    const raw = localStorage.getItem(PREVIEW_LINES_KEY);
    if (raw !== null) return toPreviewLines(raw);
  } catch {}
  return DEFAULT_PREVIEW_LINES;
}

/** Sets the List's paragraph clamp (--list-lines and --list-body in desk.css) and remembers it on this device. */
export function applyPreviewLines(value, { save = false } = {}) {
  const lines = toPreviewLines(value);
  const style = document.documentElement.style;
  style.setProperty('--list-lines', lines === 'all' ? 'none' : String(lines || 1));
  style.setProperty('--list-body', lines === 0 ? 'none' : '-webkit-box');
  if (save) {
    try {
      if (lines === DEFAULT_PREVIEW_LINES) localStorage.removeItem(PREVIEW_LINES_KEY);
      else localStorage.setItem(PREVIEW_LINES_KEY, String(lines));
    } catch {}
  }
  return lines;
}

