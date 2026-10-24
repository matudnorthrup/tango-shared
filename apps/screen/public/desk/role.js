// What this window is for: its role, kept in the URL (?role=) so a bookmark, a reload or a kiosk
// opens the same way, and two windows of one browser can differ. Settings › Windows changes it, for
// this window or any other connected one (the hub tells that window).
//   full    everything; a scene or prototype takes the window over (a laptop, a phone). The default.
//   control the List and conversations only; a scene or prototype goes to a screen window instead.
//   screen  scenes and prototypes, full window, while their conversation is the one open; otherwise
//           the feed (feed.js), what changed across the desk.
// Every window still follows the one presentation: the role only decides what each draws of it.

export const SCREEN_ROLES = ['full', 'control', 'screen'];
export const ROLE_NAMES = { full: 'Everything', control: 'Control', screen: 'Screen' };
export const ROLE_HINTS = {
  full: 'The List and conversations, and what agents show takes over the window',
  control: 'The List and conversations; what agents show goes to a Screen window',
  screen: 'Only what agents show: scenes and prototypes, full window',
};

export function roleOf(value) {
  return SCREEN_ROLES.includes(value) ? value : 'full';
}

/** This page's address with its role set (`full` drops the parameter: the plain URL is the default). */
export function urlWithRole(href, role) {
  const url = new URL(href);
  if (role === 'full') url.searchParams.delete('role');
  else url.searchParams.set('role', role);
  return url.toString();
}

/**
 * The view a window draws of the presentation. A control window stays on the conversation (or the
 * List) while a scene or prototype is up; a screen window draws only the stage.
 */
export function viewFor(role, p) {
  if (role === 'screen') return 'screen';
  if (role === 'control' && (p.view === 'screen' || p.view === 'prototype')) return p.itemId ? 'conversation' : 'active';
  return p.view;
}

/** The scene or prototype the presentation puts up, as a screen window holds it; null for none. */
export function stageOf(p) {
  if (p.view === 'screen' && p.sceneId) return { kind: 'scene', id: p.sceneId, conversationKey: p.conversationKey };
  if (p.view === 'prototype' && p.prototype) return { kind: 'prototype', prototype: p.prototype, conversationKey: p.prototype.conversationKey };
  return null;
}

/** "scene:<id>" or "prototype:<id>@<version>": a change in it is something new put up. */
export function stageKey(p) {
  const s = stageOf(p);
  return !s ? null : s.kind === 'scene' ? `scene:${s.id}` : `prototype:${s.prototype.id}@${s.prototype.version}`;
}

/**
 * What a screen window shows, or null for the feed. Something new put up (`fresh`) takes the window. It
 * stays while its conversation is the one open, then gives way to the feed, where its post can bring it
 * back; one the owner brought back that way (`pinned`) stays until they go back to the feed.
 * Either way it goes once it is no longer live (`live`: the dashboard's scene ids and prototypes).
 *   held: { kind: 'scene', id, conversationKey, pinned? } | { kind: 'prototype', prototype, conversationKey, pinned? } | null
 */
export function screenHold(held, p, live = {}, fresh = true) {
  const up = stageOf(p);
  if (up && fresh) return held && !held.pinned && sameHold(held, up) ? held : up;
  // Still the one the presentation shows: it stays, even before the dashboard lists it as live.
  if (up && held && !held.pinned && sameHold(held, up)) return held;
  if (!held) return null;
  if (!held.pinned && (p.view === 'active' || p.conversationKey !== held.conversationKey)) return null;
  if (held.kind === 'scene') return live.scenes && !live.scenes.includes(held.id) ? null : held;
  // One no longer live lets it go; a newer version (from the dashboard or the presentation, whichever
  // came first) reloads it.
  const id = held.prototype.id;
  if (live.prototypes && !live.prototypes.some((x) => x.id === id)) return null;
  const newest = [...(live.prototypes || []), ...(p.prototypes || [])].filter((x) => x.id === id).reduce((a, b) => (b.version > a.version ? b : a), held.prototype);
  return sameVersion(newest, held.prototype) ? held : { ...held, prototype: newest };
}

function sameHold(a, b) {
  return a.kind === b.kind && (a.kind === 'scene' ? a.id === b.id : sameVersion(a.prototype, b.prototype));
}

function sameVersion(a, b) {
  return a.id === b.id && a.version === b.version;
}

