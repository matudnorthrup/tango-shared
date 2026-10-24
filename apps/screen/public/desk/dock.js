// What the voice operator says it can do on each view (the voice pill's hints, next/voice.js), and its chevron.

import { html } from '../vendor/preact-htm.js';

export const HINTS = {
  active: ['catch me up', 'let’s talk about …', 'snooze till desk', 'park that', 'done'],
  conversation: ['read it all', 'I’m done', 'scroll down', 'back to the list'],
  screen: ['show the overview', 'scroll down', 'back to the list'],
  prototype: ['click …', 'scroll down', 'go back a page', 'back to the list'],
};

/** Points up while closed (the dock opens upward); turns over when open. */
export const CHEV = html`<svg class="od-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>`;

