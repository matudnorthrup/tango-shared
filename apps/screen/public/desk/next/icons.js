// The next layout's view icons, shared by the sidebar and the switcher.

import { html } from '../../vendor/preact-htm.js';

/** The Inbox views' icons (the round-2 prototype's set). */
export const VIEW_ICONS = {
  inbox: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 9.5 3.6 3.7a1 1 0 0 1 1-.7h6.8a1 1 0 0 1 1 .7L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/></svg>`,
  needs: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.8 3.5 9h4L7 14.2 12.5 7h-4z"/></svg>`,
  working: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a5.8 5.8 0 1 1-5.6 4.3"/></svg>`,
  watching: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 8s2.4-4.5 6.4-4.5S14.4 8 14.4 8 12 12.5 8 12.5 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/></svg>`,
  snoozed: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/></svg>`,
  parked: html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M6.5 11V5h2.2a1.8 1.8 0 0 1 0 3.6H6.5"/></svg>`,
  history: html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3"/></svg>`,
};

const svg = (d) => html`<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;

/** The stage's crumb: a scene (a screen) or a prototype (a page to click through). */
export const STAGE_ICONS = {
  screen: svg(html`<rect x="1.5" y="2.5" width="13" height="8.5" rx="1"/><path d="M6 14h4M8 11v3"/>`),
  prototype: svg(html`<rect x="1.5" y="2" width="13" height="10" rx="1"/><path d="M1.5 4.75h13"/><path d="M8.5 7.5l1.6 6.5 1.1-2.3 2.3-1.1z"/>`),
};

/** The ⋯ menus' icons (threads, projects, agents): 16px, stroked in currentColor. */
export const MENU_ICONS = {
  select: svg(html`<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="m5.3 8.2 1.9 1.9 3.6-3.8"/>`),
  open: svg(html`<path d="M2.5 8h8M7.5 4.5 11 8l-3.5 3.5"/><path d="M13.5 3v10"/>`),
  reply: svg(html`<path d="M6.5 4 2.5 8l4 4"/><path d="M2.5 8h7a4 4 0 0 1 4 4v1"/>`),
  snooze: svg(html`<path d="M13.5 10A5.5 5.5 0 1 1 6 2.5a4.5 4.5 0 0 0 7.5 7.5z"/>`),
  park: svg(html`<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M6.5 11V5h2.2a1.8 1.8 0 0 1 0 3.6H6.5"/>`),
  done: svg(html`<path d="m3 8.5 3.2 3.2L13 4.8"/>`),
  back: svg(html`<path d="M3 3.5v3.8h3.8"/><path d="M3.4 7.3A5 5 0 1 1 4.8 11.5"/>`),
  folder: svg(html`<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>`),
  tag: svg(html`<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r="1"/>`),
  plus: svg(html`<path d="M8 3v10M3 8h10"/>`),
  pin: svg(html`<path d="M10.5 2.5 13.5 5.5 11 8l.5 3L9.5 13 3 6.5 5 4.5l3 .5z"/><path d="m5.5 10.5-3 3"/>`),
  edit: svg(html`<path d="M11 2.5 13.5 5 6 12.5H3.5V10z"/><path d="m9.5 4 2.5 2.5"/>`),
  eye: svg(html`<path d="M1.6 8s2.4-4.5 6.4-4.5S14.4 8 14.4 8 12 12.5 8 12.5 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>`),
  eyeOff: svg(html`<path d="M6.3 3.8A6.8 6.8 0 0 1 8 3.5c4 0 6.4 4.5 6.4 4.5a12 12 0 0 1-1.8 2.4M10.1 10.3A2 2 0 0 1 7.2 6.7M4.4 5A11.6 11.6 0 0 0 1.6 8s2.4 4.5 6.4 4.5c1.1 0 2.1-.3 3-.8"/><path d="m2.5 2.5 11 11"/>`),
  external: svg(html`<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/><path d="M12 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4.5A.5.5 0 0 1 3 4h3.5"/>`),
  sections: svg(html`<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>`),
  mail: svg(html`<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/>`),
  wake: svg(html`<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>`),
  finish: svg(html`<circle cx="8" cy="8" r="6"/><path d="m5.3 8.2 1.9 1.9 3.6-3.8"/>`),
  message: svg(html`<path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3.5 2.5V11.5h-2a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>`),
  palette: svg(html`<path d="M8 2a6 6 0 1 0 0 12c.8 0 1.2-.6 1.2-1.2 0-.9-.7-1.1-.7-1.8 0-.6.5-1 1.1-1H11a3 3 0 0 0 3-3C14 4.6 11.3 2 8 2z"/><circle cx="5" cy="7" r=".8"/><circle cx="8" cy="4.8" r=".8"/><circle cx="11" cy="7" r=".8"/>`),
};

/** Pull request states, shared with decision assets. */
export const PR_ICONS = {
  open: svg(html`<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7"/><path d="M8.5 3 7 4.5 8.5 6"/>`),
  draft: svg(html`<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 9V8M11.5 5.5v-1M8 3h1"/>`),
  merged: svg(html`<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="11" r="1.5"/><path d="M4 4.5v7M4 5c0 4 6.5 2 8 4.5"/>`),
  closed: svg(html`<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><path d="M4 4.5v7M9 3l5 5M14 3 9 8M11.5 10v3"/>`),
};
