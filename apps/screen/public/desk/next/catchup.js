// Catch me up (docs/specs/catch-up.md, "Catch me up"): one column, the focus card on top (one moment, its space above
// it; acting on it brings up the next, Skip moves on without marking it seen), then Everything left, the map: one
// row per space grouped Needs you, Worth a look and Smaller, each with a dot per moment and Accept or Snooze, and
// Done here last.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { linked } from '../decision-links.js';
import { plainWords } from '../plain-words.js';
import { Tile } from './rows.js';
import { sidebarPlaces } from './model.js';
import { ChapterBrief, DecidedMoment, LineFrom, detailed, Dot, KIND_LABEL, NewsMoment, Tucked, useCatchup, when } from './chapter.js';
import { catchupHeader, catchupStatus, chapterUnread, catchupMap, catchupSpaces, focusOf, momentOrder, openLines, rowDots, rowSummary, settledAfterAct, smallerReads, spaceName, spaceRoute, tidyCount, tidyLines } from './catchup-model.js';

/** A space's tile: a project's, an agent's avatar; System and the rest have none. */
function SpaceTile({ space, store, size = 18 }) {
  const r = spaceRoute(space.spaceId);
  if (r?.page === 'project') return html`<${Tile} tile=${{ kind: 'project', id: r.id }} store=${store} size=${size} />`;
  if (r?.page === 'agent') return html`<${Tile} tile=${{ kind: 'agent', id: r.id, name: space.name }} store=${store} size=${size} />`;
  return null;
}

/** An incident is handled on the System page (Ack, Snooze), never with Got it here: the moment goes there. */
function SystemMoment({ line, store }) {
  return html`<div class=${`nx-chm k-${line.kind}`}>
    <p class="nx-chm-k">${KIND_LABEL[line.kind]}</p>
    <p class="nx-chm-t">${linked(line.title)}</p>
    ${line.detail ? html`<p class="nx-chm-d">${detailed(line.detail, line.refs)}</p>` : null}
    <div class="nx-chm-acts"><button class="btn sm" onClick=${() => store.nextGo(spaceRoute('system'))}>Open System</button></div>
  </div>`;
}

/** A headline with what waits on the owner (built from the records) set apart from the writer's words. */
function waitsFirst(space) {
  const text = plainWords(space.headline);
  const waits = space.waits ? plainWords(space.waits) : '';
  return waits && text.startsWith(waits) ? html`<span class="nx-waits">${waits}</span>${text.slice(waits.length)}` : text;
}

function Moment({ line, store, spaceId }) {
  if (spaceId === 'system') return html`<${SystemMoment} line=${line} store=${store} />`;
  const brief = (store.state.chapters[spaceId]?.data?.briefs || []).find((b) => b.id === line.briefId);
  if (line.kind === 'needs') return html`<${ChapterBrief} line=${line} brief=${brief} store=${store} spaceId=${spaceId} />`;
  if (line.kind === 'decided') return html`<${DecidedMoment} line=${line} store=${store} spaceId=${spaceId} />`;
  return html`<${NewsMoment} line=${line} store=${store} spaceId=${spaceId} />`;
}

/** The focus card: the space's tile, name and headline, then the moment itself, full size. */
function Focus({ focus, store, onSkip }) {
  const { space, line } = focus;
  const go = () => store.nextGo(space.route);
  return html`<section class="nx-cu-focus" aria-label=${`${KIND_LABEL[line.kind]} in ${space.name}`}>
    <p class="nx-cu-sp"><${SpaceTile} space=${space} store=${store} size=${18} /><button class="linkish" onClick=${go}>${space.name}</button>${space.headline ? html`<span class="nx-cu-hl" title=${plainWords(space.headline)}>${waitsFirst(space)}</span>` : null}</p>
    <${Moment} line=${line} store=${store} spaceId=${space.spaceId} />
    <button class="btn sm ghost nx-cu-skip" title="On to the next one; this stays unseen" onClick=${onSkip}>Skip</button>
  </section>`;
}

/** A map row: tile, name, a dot per moment (hollow once handled), what's in it, Accept or Snooze; open, its moments. */
function Row({ space, store, open, onToggle, focusId, onFocus, shown, onAct }) {
  const { state } = store;
  const entry = state.chapters[space.spaceId];
  const lines = openLines(entry, state.lineLocal);
  const tidy = tidyLines(entry, state.lineLocal);
  const plan = entry?.data?.plan;
  const busy = !!state.chapterLocal[space.spaceId] || !plan;
  const moments = (lines || []).filter((l) => l.moment).sort(momentOrder);
  const others = moments.filter((l) => l.id !== focusId);
  const small = (lines || []).filter((l) => !l.moment);
  const dots = rowDots(shown, lines);
  return html`<div class=${`nx-cu-row${open ? ' open' : ''}`}>
    <div class="nx-cu-rh">
      <button class="nx-cu-rn" aria-expanded=${open} onClick=${onToggle}>
        <${SpaceTile} space=${space} store=${store} size=${18} /><b>${space.name}</b>
        <span class="nx-cu-dots" aria-hidden="true">${dots.map((d) => html`<${Dot} key=${d.id} kind=${d.kind || 'fyi'} hollow=${d.hollow} />`)}</span>
        <span class=${`nx-cu-sum${space.needs ? ' needs' : ''}`}>${rowSummary(space, lines, tidy)}</span>
      </button>
      <span class="nx-cu-acts">
        ${space.spaceId === 'system'
          ? html`<button class="btn sm" title="Incidents are acked or snoozed on the System page" onClick=${() => store.nextGo(spaceRoute('system'))}>Open System</button>`
          : html`<button class="btn sm" disabled=${busy} onClick=${() => onAct(space, 'accepted')}>Accept</button>
              <button class="btn sm ghost" disabled=${busy} title="Seen, not decided: back when you pick" onClick=${() => onAct(space, 'deferred')}>Snooze</button>`}
      </span>
    </div>
    ${open
      ? html`<div class="nx-cu-rb">
          <ul class="nx-ch-lines">
            ${others.map((l) => html`<li key=${l.id}><${Dot} kind=${l.kind} /><button class="linkish t" onClick=${() => onFocus(l.id)}>${linked(l.title)}</button><span class="k">${KIND_LABEL[l.kind]}</span><${LineFrom} line=${l} store=${store} /></li>`)}
            ${small.length ? html`<li class="small"><${Dot} kind="fyi" hollow=${true} /><span class="k">${small.length} smaller update${small.length === 1 ? '' : 's'}</span></li>` : null}
          </ul>
          <${Tucked} tidy=${tidy} />
          ${plan
            ? html`<p class="nx-ch-plan">${linked(plan.line)}</p>`
            : chapterUnread(entry)
              ? html`<p class="nx-ch-plan">Couldn’t read this: ${entry.error}. <button class="linkish" onClick=${() => store.loadChapter(space.spaceId)}>Try again</button></p>`
              : html`<p class="nx-ch-plan">Reading…</p>`}
        </div>`
      : null}
  </div>`;
}

/** Every space with only smaller updates shares one row: a line or two each, and one Got it for all of them. */
function SmallerRow({ spaces, store, open, onToggle, onGotIt }) {
  const { state } = store;
  const per = spaces.map((space) => ({ space, lines: openLines(state.chapters[space.spaceId], state.lineLocal), tidy: tidyLines(state.chapters[space.spaceId], state.lineLocal) }));
  const count = per.reduce((n, p) => n + (p.lines ? p.lines.length + tidyCount(p.tidy) : p.space.smaller), 0);
  const ready = per.every((p) => p.lines);
  return html`<div class=${`nx-cu-row${open ? ' open' : ''}`}>
    <div class="nx-cu-rh">
      <button class="nx-cu-rn" aria-expanded=${open} onClick=${onToggle}>
        <span class="nx-cu-tiles">${spaces.slice(0, 5).map((space) => html`<${SpaceTile} key=${space.spaceId} space=${space} store=${store} size=${16} />`)}</span>
        <b>Smaller updates · ${spaces.length} place${spaces.length === 1 ? '' : 's'}</b>
        <span class="nx-cu-sum">${count} line${count === 1 ? '' : 's'}</span>
      </button>
      <span class="nx-cu-acts"><button class="btn sm" disabled=${!ready} onClick=${() => onGotIt(per)}>Got it</button></span>
    </div>
    ${open
      ? html`<div class="nx-cu-rb">${per.map(
          ({ space, lines, tidy }) => {
            const entry = state.chapters[space.spaceId];
            return html`<div class="nx-cu-sm" key=${space.spaceId}><b>${space.name}</b> ${chapterUnread(entry)
              ? html`Couldn’t read this: ${entry.error}. <button class="linkish" onClick=${() => store.loadChapter(space.spaceId)}>Try again</button>`
              : html`${(lines || []).slice(0, 2).map((l) => html`<div class="nx-cu-small-line">${l.title}<${LineFrom} line=${l} store=${store} /></div>`)}${lines && lines.length > 2 ? ` · and ${lines.length - 2} more` : ''}<${Tucked} tidy=${tidy} />`}</div>`;
          },
        )}</div>`
      : null}
  </div>`;
}

/** Done here: what the owner accepted or deferred on this visit, and the picks still left for them. */
function DoneHere({ done, store }) {
  const { state } = store;
  const list = Object.entries(done).sort((a, b) => a[1].at - b[1].at);
  if (!list.length) return null;
  return html`<section class="nx-cu-done" aria-label="Done here">
    <p class="nx-cu-g">Done here</p>
    ${list.map(([spaceId, d]) => {
      const waiting = state.chapters[spaceId]?.data?.waiting || [];
      const back = state.chapters[spaceId]?.data?.chapter?.backAt;
      return html`<p class="nx-cu-dr" key=${spaceId}>
        <${SpaceTile} space=${{ spaceId, name: d.name }} store=${store} size=${16} /><b>${d.name}</b>
        <span>${d.act === 'deferred' ? `Snoozed${back ? ` · back ${when(back, state.now)}` : ''}` : d.act === 'seen' ? 'Got it' : 'Accepted'}</span>
        ${waiting.map((w) => html`<button class="linkish nx-cu-pick" key=${w.id} onClick=${() => (w.briefId ? store.openDecision(w.briefId) : w.itemId && store.nextOpen(w.itemId))}>Waiting on you: ${plainWords(w.title)}</button>`)}
      </p>`;
    })}
  </section>`;
}

/** Saved chapter state, independent of this visit's Done here list. */
function SnoozedFooter({ store }) {
  const [open, setOpen] = useState(false);
  const { state } = store;
  const places = { projects: state.projects || [], agents: sidebarPlaces(state).agents };
  const snoozed = (state.catchup?.data || []).filter((c) => c.state === 'deferred')
    .map((c) => ({ ...c, name: spaceName(c.spaceId, places) || c.spaceId, route: spaceRoute(c.spaceId) }))
    .sort((a, b) => a.backAt - b.backAt);
  if (!snoozed.length) return null;
  return html`<section class="nx-cu-done" aria-label="Snoozed chapters">
    <button class="linkish" aria-expanded=${open} onClick=${() => setOpen(!open)}>${snoozed.length} snoozed · back ${when(snoozed[0].backAt, state.now)}</button>
    ${open ? snoozed.map((space) => html`<p class="nx-cu-dr" key=${space.spaceId}>
      <${SpaceTile} space=${space} store=${store} size=${16} /><b>${space.name}</b>
      <span>back ${when(space.backAt, state.now)}</span>
      ${space.route ? html`<button class="linkish" onClick=${() => store.nextGo(space.route)}>Open</button>` : null}
    </p>`) : null}
  </section>`;
}

/** Newest first or Oldest first: the same pick as the Inbox's Filter menu, on this device. */
function OrderToggle({ store }) {
  const oldest = store.state.nextOrder === 'oldest';
  return html`<button class="linkish nx-cu-order" title=${oldest ? 'Places left longest come first. Tap for newest first.' : 'Newest first. Tap for the places left longest first.'} onClick=${() => store.nextSetOrder(oldest ? 'newest' : 'oldest')}>${oldest ? 'Oldest first' : 'Newest first'}</button>`;
}

export function CatchupPage({ store }) {
  useCatchup(store);
  const { state } = store;
  const spaces = catchupSpaces(state, { projects: state.projects || [], agents: sidebarPlaces(state).agents });
  const [skipped, setSkipped] = useState([]);
  const [focusId, setFocusId] = useState(null);
  const [opened, setOpened] = useState({});
  const [done, setDone] = useState({});
  const shown = useRef({});
  // Each listed space's chapter: its lines, briefs and what Accept would do. Read again on entering the page, since one
  // read earlier on its own page may be stale (updates reload only the current page's chapter); then each new one.
  const keys = spaces.map((c) => c.spaceId).join('|');
  const read = useRef(new Set());
  useEffect(() => {
    for (const c of spaces) {
      if (read.current.has(c.spaceId)) continue;
      read.current.add(c.spaceId);
      void store.loadChapter(c.spaceId);
    }
  }, [keys]);
  // The voice walk moved (list_place catchup): its focus and skips, and the chapters read again, since it may have
  // acted on one. Read-only here: following marks nothing seen.
  const follow = state.catchupFollow;
  useEffect(() => {
    if (!follow) return;
    setFocusId(follow.focus);
    setSkipped(follow.skipped);
    void store.loadCatchup();
    for (const c of spaces) void store.loadChapter(c.spaceId);
  }, [follow?.at]);
  const map = catchupMap(spaces, done);
  const focus = focusOf(spaces, state.chapters, { lineLocal: state.lineLocal, skipped, focusId, done });
  // The moments the page has shown, per space, so a handled one stays as a hollow dot.
  for (const c of spaces) {
    const lines = openLines(state.chapters[c.spaceId], state.lineLocal);
    if (!lines) continue;
    const seen = (shown.current[c.spaceId] ||= new Set());
    for (const l of lines) if (l.moment) seen.add(l.id);
  }
  // Done here hears from the store, so a Retry from the failure toast lands here too.
  const act = (space, how) =>
    store.chapterAct(space.spaceId, how, {
      name: space.name,
      // A part that didn't go through stays in Everything left with its line.
      onDone: () => settledAfterAct(store.state.chapters[space.spaceId], store.state.lineLocal) && setDone((d) => ({ ...d, [space.spaceId]: { act: how, at: Date.now(), name: space.name } })),
    });
  const gotIt = async (per) => {
    const reads = smallerReads(per);
    if (!reads.length) return;
    const names = Object.fromEntries(per.map((p) => [p.space.spaceId, p.space.name]));
    await store.smallerSeen(reads, { onDone: () => setDone((d) => ({ ...d, ...Object.fromEntries(reads.map((r) => [r.spaceId, { act: 'seen', at: Date.now(), name: names[r.spaceId] }])) })) });
  };
  const head = catchupHeader(spaces.filter((c) => !done[c.spaceId]));
  const rows = [...map.needs, ...map.look];
  const isOpen = (spaceId) => opened[spaceId] ?? focus?.space.spaceId === spaceId;
  const toggle = (spaceId) => setOpened((o) => ({ ...o, [spaceId]: !isOpen(spaceId) }));
  const row = (space) => html`<${Row} key=${space.spaceId} space=${space} store=${store} open=${isOpen(space.spaceId)} onToggle=${() => toggle(space.spaceId)} focusId=${focus?.line.id ?? null} onFocus=${(id) => (setFocusId(id), window.scrollTo({ top: 0, behavior: 'smooth' }))} shown=${shown.current[space.spaceId]} onAct=${act} />`;
  const status = catchupStatus(state.catchup);
  const loading = status === 'loading';
  const nothing = !rows.length && !map.smaller.length;
  return html`<div class="nx-col nx-cu">
    <header class="nx-cu-head">
      <h1 class="nx-h1">Catch me up</h1>
      <span>${head.since ? `Since ${when(head.since, state.now)} · ` : ''}${head.left ? `${head.left} left · ` : ''}<${OrderToggle} store=${store} /></span>
    </header>
    ${status === 'error' || status === 'off'
      ? html`<p class="nx-cu-empty">${status === 'off' ? 'This desk has no catch-up.' : html`Couldn’t read what’s waiting: ${state.catchup.error}. <button class="linkish" onClick=${() => store.loadCatchup()}>Try again</button>`}</p>`
      : focus
      ? html`<${Focus} focus=${focus} store=${store} onSkip=${() => (setSkipped((s) => [...s, focus.line.id]), setFocusId(null))} />`
      : loading
        ? html`<p class="nx-cu-empty">Reading…</p>`
        : nothing
          ? html`<p class="nx-cu-empty">You’re caught up.${Object.keys(done).length ? ' That’s everything for now.' : ''}</p>`
          : html`<p class="nx-cu-empty">${skipped.length ? html`Every moment is handled or skipped. <button class="linkish" onClick=${() => setSkipped([])}>Show the skipped ones</button>` : 'Nothing that matters is waiting.'} Accept or Snooze what’s left below.</p>`}
    ${nothing
      ? null
      : html`<p class="nx-cu-g top">Everything left<span> · ${rows.length ? `${rows.length} place${rows.length === 1 ? '' : 's'}` : ''}${rows.length && map.smaller.length ? ', plus smaller updates' : map.smaller.length ? 'smaller updates' : ''}</span></p>
        <section class="nx-cu-map" aria-label="Everything left">
          ${map.needs.length ? html`<p class="nx-cu-g">Needs you</p>${map.needs.map(row)}` : null}
          ${map.look.length ? html`<p class="nx-cu-g">Worth a look</p>${map.look.map(row)}` : null}
          ${map.smaller.length ? html`<p class="nx-cu-g">Smaller</p><${SmallerRow} spaces=${map.smaller} store=${store} open=${!!opened.smaller} onToggle=${() => setOpened((o) => ({ ...o, smaller: !o.smaller }))} onGotIt=${gotIt} />` : null}
        </section>`}
    <${DoneHere} done=${done} store=${store} />
    <${SnoozedFooter} store=${store} />
  </div>`;
}
