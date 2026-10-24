// Desk search (TGO-958): the read-only transcript a result opens at its matched message, and the
// highlight the results use. The switcher (next/switcher.js) and Search page (next/search.js) search;
// state and helpers live in search-model.js.

import { html, useEffect, useRef } from '../vendor/preact-htm.js';
import { Tile } from './list.js';
import { rowWhere, typeName, typeOf } from './list-model.js';
import { renderMarkdown } from './md.js';
import { onCodeButton } from './md-actions.js';
import { hitStatus, rowTitle } from './search-model.js';
import { age, dayLabel, shortTime } from './util.js';

export const SEARCH_ICON = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>`;

/** "tango · bug · 3d · done": where it lives, and where it stands. */
function hitMeta(row, now) {
  const kind = typeOf(row);
  return [rowWhere(row), kind ? typeName(kind).toLowerCase() : null, age(row.lastActivityAt, now), hitStatus(row)].filter(Boolean).join(' · ');
}

// ── the ⌘K palette ──────────────────────────────────────────────────────

// ── the List's search mode ──────────────────────────────────────────────

// ── the transcript ──────────────────────────────────────────────────────

/** A conversation read whole, from search's own copy: the match in view, more on either side on demand. */
export function TranscriptSheet({ store }) {
  const { state } = store;
  const t = state.transcript;
  const body = useRef(null);
  const scrolled = useRef(null);
  useEffect(() => {
    // Once per opening: the matched message, centered.
    if (!t || t.loading || scrolled.current === `${t.itemId}@${t.around}`) return;
    scrolled.current = `${t.itemId}@${t.around}`;
    requestAnimationFrame(() => {
      const target = t.around ? body.current?.querySelector('.sx-msg.hit') : body.current?.lastElementChild;
      target?.scrollIntoView({ block: t.around ? 'center' : 'end' });
    });
  }, [t?.itemId, t?.around, t?.loading]);
  useEffect(() => {
    if (!t) scrolled.current = null;
  }, [t]);
  if (!t) return null;
  const row = t.row;
  const terms = state.search.query;

  const close = () => store.closeTranscript();
  // A code block's buttons work as in a conversation; Start opens Start work in its place.
  const onCode = (e) => {
    const start = !!e.target.closest?.('[data-code="start"]');
    if (onCodeButton(e, store, row?.facts?.projectId || null) && start) close();
  };
  return html`<div class="rd-scrim sx-tr-scrim" onClick=${(e) => e.target === e.currentTarget && close()}>
    <div class="rd-modal sx-tr" role="dialog" aria-modal="true" aria-label=${row ? rowTitle(row) : 'Transcript'}>
      <header>
        ${row ? html`<${Tile} item=${row} store=${store} />` : null}
        <div class="rd-mt">
          <h3>${row ? rowTitle(row) : 'Conversation'}</h3>
          <div class="note">${row ? hitMeta(row, state.now) : ''}${row?.archived ? ' · read-only: no longer on the desk' : ''}</div>
        </div>
        <div class="sx-tr-acts">
          ${row && !row.archived ? html`<button class="btn" onClick=${() => (close(), store.openItem(row.id))}>Open on the desk</button>` : null}
          <button class="btn rd-x" onClick=${close}>Close <span class="kbd">esc</span></button>
        </div>
      </header>
      <div class="rd-mbody sx-tr-body" ref=${body}>
        ${t.hasEarlier ? html`<button class="btn sx-page" disabled=${t.loading} onClick=${() => store.moreTranscript('earlier')}>Earlier messages</button>` : null}
        ${t.error ? html`<p class="note warn">Couldn’t load it: ${t.error}</p>` : null}
        ${t.loading && !t.messages.length ? html`<p class="note">Loading…</p>` : null}
        ${t.messages.map(
          (m) => html`<div key=${m.messageId} class=${`sx-msg ${m.author}${m.messageId === t.around ? ' hit' : ''}`}>
            <div class="sx-mh"><b>${m.author === 'owner' ? 'You' : row?.agentName || 'Agent'}</b><span class="note">${dayLabel(m.at, state.now)} ${shortTime(m.at)}</span></div>
            <div class="md" onClick=${onCode} dangerouslySetInnerHTML=${{ __html: m.messageId === t.around ? highlight(renderMarkdown(m.text), terms) : renderMarkdown(m.text) }}></div>
          </div>`,
        )}
        ${t.hasLater ? html`<button class="btn sx-page" disabled=${t.loading} onClick=${() => store.moreTranscript('later')}>Later messages</button>` : null}
      </div>
    </div>
  </div>`;
}

/** The searched words marked in a rendered message (text only: never inside a tag or an entity). */
export function highlight(markup, query) {
  const words = String(query || '')
    .replace(/(^|\s)-\S+/g, ' ')
    .match(/"[^"]+"|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  if (!words?.length) return markup;
  // Search matched any form of a word ("keeps" found "keep"): mark from its stem on.
  const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/i, '') : w);
  const escaped = words.map((w) => w.replace(/"/g, '')).filter((w) => w.length > 1).map((w) => (w.includes(' ') ? w : stem(w)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return markup;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])((?:${escaped.join('|')})[\\p{L}\\p{N}]*)`, 'giu');
  return markup.replace(/(<[^>]*>)|([^<]+)/g, (all, tag, text) => (tag ? tag : text.replace(re, '<mark>$1</mark>')));
}
