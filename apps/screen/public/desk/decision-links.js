// Decision ids as links (TGO-1110): wherever the desk renders text, `D-67` is one tap from its brief. Only ids Loom
// has a decision for become links (the rest stay text, as the owner's first rulings D-1 to D-3 do): the desk learns
// them from Loom (store.loadDecisionIds → setKnownDecisions) and a link to an id it doesn't know yet asks again.

import { html } from '../vendor/preact-htm.js';

/** A decision id as a word: not part of "XD-6", "D-6-b" or a longer number. */
const ID = /(?<![\w-])D-(\d+)(?![\w-])/g;
/** The page's address on the desk, relative to its root (the desk may sit behind a path prefix, as /tango-screen). */
export const decisionHref = (id) => `decision/${id}`;
/** A decision page address, on this desk or any other: `…/decision/D-67`. */
export const DECISION_PATH = /\/decision\/(D-\d+)\/?$/;

let known = new Set();
let wanted = null;
const listeners = new Set();

/** The ids Loom has a decision for (numbers). */
export function setKnownDecisions(ids) {
  known = new Set(ids);
  for (const listener of listeners) listener();
}
export const isKnownDecision = (n) => known.has(Number(n));
/** Told when the known ids change (the desk then draws its text again). */
export function onKnownDecisions(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** The desk's way to ask Loom again; called (throttled by the desk) when text names an id above the newest one known. */
export function wantDecisionIds(fn) {
  wanted = fn;
}
function unseen(n) {
  if (wanted && n > Math.max(0, ...known)) wanted();
}

/** The segments of already-escaped HTML that are plain text: not inside a tag, a link or a code block. */
const SKIP = /(<a\b[\s\S]*?<\/a>|<pre\b[\s\S]*?<\/pre>|<[^>]+>)/g;

/** Escaped HTML with every known `D-n` outside links and code blocks turned into a link to its page. */
export function linkDecisionsInHtml(markup) {
  if (!markup || !markup.includes('D-')) return markup;
  return markup
    .split(SKIP)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(ID, (match, n) => {
            if (!isKnownDecision(n)) return (unseen(Number(n)), match);
            return `<a class="dlink" data-decision="${match}" href="${decisionHref(match)}">${match}</a>`;
          }),
    )
    .join('');
}

/** Plain text as parts a template can render: strings, and a link for each known `D-n`. */
export function linked(text) {
  if (typeof text !== 'string' || !text.includes('D-')) return text ?? '';
  const source = text;
  const parts = [];
  let at = 0;
  for (const m of source.matchAll(ID)) {
    if (!isKnownDecision(m[1])) {
      unseen(Number(m[1]));
      continue;
    }
    if (m.index > at) parts.push(source.slice(at, m.index));
    parts.push(html`<a class="dlink" data-decision=${m[0]} href=${decisionHref(m[0])}>${m[0]}</a>`);
    at = m.index + m[0].length;
  }
  if (!parts.length) return source;
  if (at < source.length) parts.push(source.slice(at));
  return parts;
}

/** The decision a click on this link opens on the desk, or null: a `D-n` link, or an address of a decision page on this origin. */
export function decisionOfLink(anchor, origin = typeof location !== 'undefined' ? location.origin : '') {
  if (!anchor) return null;
  if (anchor.dataset?.decision) return anchor.dataset.decision;
  try {
    const url = new URL(anchor.getAttribute('href') || '', anchor.baseURI || origin);
    return url.origin === origin ? url.pathname.match(DECISION_PATH)?.[1] ?? null : null;
  } catch {
    return null;
  }
}
