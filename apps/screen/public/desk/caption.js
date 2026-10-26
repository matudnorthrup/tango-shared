import { html } from '../vendor/preact-htm.js';
export function Caption({ line }) {
  return html`<span>${line.speaker === 'owner' ? '' : html`<span class="nx-vwho">${line.name || 'Agent'}: </span>`}“${line.text}”</span>`;
}
