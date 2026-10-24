import { html, useState, useRef, useEffect, useLayoutEffect } from '../../vendor/preact-htm.js';
import { age } from '../util.js';
import { PR_ICONS } from './icons.js';
import { prChip, prGroups, threadPrs, prColor, prState } from './pr-model.js';

const stop = e => e.stopPropagation();
function PrIcon({ pr }) {
  return html`<span class=${`nx-pr-icon pr-${prColor(pr)}`} aria-label=${pr.state}>${PR_ICONS[pr.state]}</span>`;
}
function PrLine({ pr, now, compact = false, repo = false }) {
  const relation = pr.relation === 'worker' ? `by worker ${pr.via?.title || ''}` : { opened: 'opened here', watched: 'watched', mentioned: 'mentioned' }[pr.relation];
  return html`<a class=${`nx-pr-line${compact ? ' compact' : ''}`} href=${pr.url} target="_blank" rel="noopener noreferrer">
    <${PrIcon} pr=${pr} /><span class="nx-pr-copy"><span class="nx-pr-title">#${pr.number} ${pr.title || 'Pull request'}</span>
    ${compact ? null : html`<span class="nx-pr-relation">${repo ? pr.repo + ' · ' : ''}${relation}</span>`}</span>
    <span class=${`nx-pr-state pr-${prColor(pr)}`}>${prState(pr, now)}</span>
    ${compact ? null : html`<span class="nx-pr-sub">${pr.checks ? html`<span class=${`pr-${pr.checks === 'failing' ? 'bad' : pr.checks === 'running' ? 'wait' : 'open'}`}>CI ${pr.checks} · </span>` : null}${pr.watched ? 'watching · ' : ''}${pr.checkedAt ? `checked ${age(pr.checkedAt, now)} ago` : 'not checked'}${pr.error ? html`<span class="pr-bad"> · ${pr.error}</span>` : null}</span>`}
  </a>`;
}
export function PrList({ item, now }) {
  const repo = new Set(threadPrs(item).map(p => p.repo)).size > 1;
  return html`<div class="nx-pr-list">${prGroups(item).map(g => g.folded
    ? html`<details><summary>Mentioned (${g.prs.length})</summary>${g.prs.map(p => html`<${PrLine} key=${p.url} pr=${p} now=${now} repo=${repo} />`)}</details>`
    : html`<section><h3>${g.label}</h3>${g.prs.map(p => html`<${PrLine} key=${p.url} pr=${p} now=${now} repo=${repo} />`)}</section>`)}</div>`;
}
export function PrChip({ item, store, onAll }) {
  const chip = prChip(item);
  const [open, setOpen] = useState(false);
  const anchor = useRef(null), pop = useRef(null), timer = useRef(null);
  const cancel = () => clearTimeout(timer.current);
  const leave = () => { if (!window.matchMedia('(pointer: fine)').matches) return; cancel(); timer.current = setTimeout(() => setOpen(false), 180); };
  useLayoutEffect(() => {
    if (!open || !pop.current) return;
    const el = pop.current;
    el.showPopover();
    const position = () => {
      const r = anchor.current.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 8))}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = e => { if (!anchor.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  useEffect(() => () => cancel(), []);
  if (!chip) return null;
  const all = () => { setOpen(false); if (onAll) onAll(); else { store.set({ nextPrItem: item.id, nextPanel: { open: true, tab: 'prs' } }); store.nextOpen(item.id); } };
  return html`<span class="nx-pr-anchor" onClick=${stop} onKeyDown=${stop}>
    <button ref=${anchor} class="nx-pr-chip" aria-label=${`Pull requests: ${chip.words}`} aria-expanded=${open}
      onPointerEnter=${() => { if (window.matchMedia('(pointer: fine)').matches) { cancel(); setOpen(true); } }} onPointerLeave=${leave}
      onClick=${() => { cancel(); setOpen(!open); }}>${PR_ICONS[chip.state]}${chip.words}</button>
    ${open ? html`<div ref=${pop} popover="manual" class="nx-pr-pop" role="region" aria-label="Pull request summary" onPointerEnter=${cancel} onPointerLeave=${leave}>
      <div class="nx-pr-pop-lines">${chip.prs.map(p => html`<${PrLine} key=${p.url} pr=${p} now=${store.state.now} compact=${true} />`)}</div>
      <button class="nx-pr-all" onClick=${all}>All pull requests</button>
    </div>` : null}
  </span>`;
}
