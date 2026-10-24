// Picks a Lucide icon (the set Loom uses for project icons) by searching names and tags, for agents
// (Settings → Agents) and projects. Before a search it offers a handful that suit the desk.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';

const SUGGESTED = ['briefcase', 'compass', 'clipboard-list', 'wallet', 'leaf', 'dumbbell', 'heart-handshake', 'lightbulb', 'map-pin', 'code-xml', 'piggy-bank', 'library', 'bot', 'rocket', 'folder', 'house', 'calendar', 'book-open', 'music', 'camera', 'car', 'plane', 'shopping-cart', 'sparkles', 'wrench', 'graduation-cap', 'coffee', 'utensils', 'mountain', 'smile', 'star', 'heart'];

export function IconMask({ name }) {
  return html`<i class="ip-i" style=${`-webkit-mask-image:url(api/desk/icon/${name}.svg);mask-image:url(api/desk/icon/${name}.svg)`}></i>`;
}

/** `value` is the icon chosen now; `onPick(name)` when one is tapped. `color` tints the chosen one. */
export function IconPicker({ store, value, onPick, color }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null);
  const timer = useRef(null);
  const seq = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const search = (text) => {
    setQuery(text);
    clearTimeout(timer.current);
    // Any search still out is for an older query, cleared included (Codex review on #546).
    const n = ++seq.current;
    if (!text.trim()) return setFound(null);
    timer.current = setTimeout(async () => {
      const icons = await store.searchIcons(text);
      if (n === seq.current) setFound(icons);
    }, 150);
  };
  const icons = found ?? [...new Set([...(value ? [value] : []), ...SUGGESTED])];
  return html`<div class="ip" style=${color ? `--c:${color}` : ''}>
    <input type="search" class="stg-input" placeholder="Search icons" aria-label="Search icons" value=${query} spellcheck="false" onInput=${(e) => search(e.currentTarget.value)} />
    <div class="ip-grid" role="listbox" aria-label="Icons">
      ${icons.map((name) => html`<button key=${name} type="button" role="option" class=${name === value ? 'on' : ''} aria-selected=${name === value} aria-label=${name} title=${name} onClick=${() => onPick(name)}><${IconMask} name=${name} /></button>`)}
      ${found && !found.length ? html`<span class="note">No icon matches “${query.trim()}”.</span>` : null}
    </div>
  </div>`;
}
