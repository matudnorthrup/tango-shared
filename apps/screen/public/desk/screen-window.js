// A Screen window (?role=screen, role.js): a scene or prototype full window under a slim bar while its
// conversation is the one open, and the feed (feed.js) the rest of the time.

import { html } from '../vendor/preact-htm.js';
import { GEAR } from './chrome.js';
import { Feed, needsYouCount, stuckCount } from './feed.js';
import { agentColor, clockTime } from './util.js';

export function ScreenWindow({ store, held, onBack, onPick }) {
  const { state } = store;
  const shown = held?.kind === 'scene' ? state.scenes[held.id] : held?.kind === 'prototype' ? held.prototype : null;
  const name = shown?.agentName || 'Agent';
  const settings = html`<button class="lgear" onClick=${() => store.openSettings('windows')} aria-label="Settings" title="Settings: what this window is for">${GEAR}</button>`;
  const ctx = { flags: state.flags, projects: state.projects, listViews: state.listViews };
  const needs = held ? 0 : needsYouCount(state.lists, state.now, state.feedScope, ctx);
  const stuck = held ? 0 : stuckCount(state.lists, state.now, state.feedScope, ctx);
  const counts = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null, stuck ? `${stuck} stuck` : null].filter(Boolean).join(' · ');
  return html`<div class=${`screen-view swin${held ? '' : ' idle'}`}>
    <div class="stop"><div class="sbar subbar">
      ${held
        ? html`<span class="av sm" style=${`--c:${agentColor(shown?.agentId || '') || shown?.color}`} aria-hidden="true">${name[0]}</span>
            <span class="showing">${shown ? html`<b>${name}</b> <span class="note">${held.kind === 'prototype' ? 'prototype' : 'is showing'} · ${shown.title || shown.summary || shown.name || 'a screen'}</span>` : html`<span class="note">Loading the screen…</span>`}</span>`
        : html`<span class="showing"><b>Feed</b></span>`}
      <div class="right">
        ${held ? html`<button class="linkish" onClick=${onBack}>Back to the feed</button>` : html`${counts ? html`<span class="swin-needs">${counts}</span>` : null}<span class="swin-clock">${clockTime(state.now)}</span>`}
        ${settings}
      </div>
    </div></div>
    ${held ? null : html`<${Feed} store=${store} onPick=${onPick} />`}
  </div>`;
}
