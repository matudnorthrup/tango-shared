// The catch-up card on a space's page (docs/specs/catch-up.md, "The chapter card"). It replaces Where it stands:
// while the space has news, "Since you were here" lists one colored line per thing that matters, opens to a card per
// moment, and ends in Accept and Snooze with exactly what Accept will do; once handled, it goes back to Where it
// stands, with the chapter's headline, what's next, what still waits on the owner, and what changed since.

import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { age, clockTime, dayLabel } from '../util.js';
import { isKnownDecision, linked } from '../decision-links.js';
import { plainDetail, plainWords } from '../plain-words.js';
import { projectOf } from '../list-model.js';
import { BriefCard, BriefPlaces, briefPending } from '../brief.js';
import { BriefRule } from '../conversation.js';
import { AskCard } from '../ask-card.js';
import { pendingOf } from '../pending.js';
import { RULE_CHOICES, ruleTag } from './decided-model.js';
import { alsoAsked, tidyCount, tidyLines, withTidy } from './catchup-model.js';

/** A title in plain words; one that named only an id reads as a neutral update, never empty. */
const titled = (text) => plainWords(text) || 'An update';

/** A line's PR links by number ("17173" → its URL), so a "#17173" in its detail can be that link. */
function prLinks(refs) {
  const out = new Map();
  for (const r of refs || []) {
    const m = r.url?.match(/\/pull\/(\d+)/);
    if (m && !out.has(m[1])) out.set(m[1], r.url);
  }
  return out;
}

/** An opened line's detail: an id only as a link (a known decision, a PR the line links to), every other one in words. */
export function detailed(text, refs) {
  const prs = prLinks(refs);
  const prOf = (id) => id.match(/^(?:PR\s*)?#(\d+)$/)?.[1];
  const plain = plainDetail(text, (id) => (prOf(id) ? prs.has(prOf(id)) : /^D-(\d+)$/.test(id) && isKnownDecision(id.slice(2))));
  if (!prs.size || typeof plain !== 'string') return linked(plain);
  return plain.split(/((?:PR\s*)?#\d+\b)/).flatMap((part, i) =>
    i % 2 && prs.has(prOf(part)) ? [html`<a class="nx-link quiet" href=${prs.get(prOf(part))} target="_blank" rel="noopener">${part}</a>`] : [].concat(linked(part)),
  );
}

const PULSE = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8.5h3l2-5 3 9 2-4h3"/></svg>`;

export const KIND_LABEL = { needs: 'Needs you', failed: 'Failed', decided: 'Decided for you', shipped: 'Finished', fyi: 'FYI' };
const KIND_ORDER = ['needs', 'failed', 'decided', 'shipped', 'fyi'];
// Smaller updates group by kind; a routine decision is the usual smaller decided line.
const SMALL_LABEL = { needs: 'Needs you', failed: 'Failed', decided: 'Routine decisions', shipped: 'Finished', fyi: 'FYI' };
const byKind = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.at - a.at;

/** "Sun 9:00 pm" for a time before today, "9:00 pm" for today's. */
export function when(ms, now) {
  if (dayLabel(ms, now) === 'Today' && ms > now) return `today ${clockTime(ms)}`;
  const day = dayLabel(ms, now);
  return day === 'Today' ? clockTime(ms) : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${clockTime(ms)}`;
}

/** Reads the space's chapter while mounted, again every minute and whenever its lead says something new. */
function useChapter(store, spaceId, leadAt) {
  useEffect(() => {
    void store.loadChapter(spaceId);
    const t = setInterval(() => void store.loadChapter(spaceId), 60_000);
    return () => clearInterval(t);
  }, [spaceId]);
  useEffect(() => {
    if (leadAt) void store.loadChapter(spaceId);
  }, [leadAt]);
}

/** Reads every space's chapter in brief while mounted (the sidebar's dots, the Inbox summary), again every minute. */
export function useCatchup(store) {
  useEffect(() => {
    void store.loadCatchup();
    const t = setInterval(() => void store.loadCatchup(), 60_000);
    return () => clearInterval(t);
  }, []);
}

export function Dot({ kind, hollow = false }) {
  return html`<i class=${`nx-ch-dot k-${kind}${hollow ? ' hollow' : ''}`} aria-hidden="true"></i>`;
}

function Refs({ line }) {
  return line.refs?.length ? html`<span class="nx-ch-refs">${line.refs.map((r) => html`<a class="nx-link quiet" href=${r.url} target="_blank" rel="noopener">${r.label}</a>`)}</span>` : null;
}

/** The conversation behind a line; never substitute an internal id for a missing item. */
export function LineFrom({ line, brief, store }) {
  const item = line.itemId && store.state.byId?.[line.itemId];
  const name = item?.summary?.about || item?.summary?.title || item?.facts?.name;
  if (!name) return null;
  const about = brief?.about || (store.state.chapters?.[line.spaceId]?.data?.briefs || []).find((b) => b.id === line.briefId)?.about;
  const projects = store.state.projects || [];
  const project = projectOf(item, projects) || projects.find((p) => `project:${p.id}` === line.spaceId);
  return html`<div class="nx-ch-from">${about ? `${about} · from ` : 'From '}<a class="nx-link quiet" href="#" onClick=${(e) => { e.preventDefault(); store.nextOpen(line.itemId); }}>${`“${name}” →`}</a>${project?.linearUrl ? html` · <a class="nx-link quiet" href=${project.linearUrl} target="_blank" rel="noopener">Linear</a>` : null}</div>`;
}

/** Needs you cleaned up (desk/triage.ts): who else asked this, and the writer's labeled summary note. */
function TidyNotes({ line }) {
  return html`${line.also?.length ? html`<p class="nx-chm-also">${alsoAsked(line.also)}</p>` : null}${line.note ? html`<p class="nx-chm-also">${line.note}</p>` : null}`;
}

/** The chapter supplies its answer/defer behavior; BriefCard owns the presentation. */
export function ChapterBrief({ line, brief, store, spaceId }) {
  const ask = !brief && (store.state.chapters?.[spaceId]?.data?.asks || []).find((a) => a.id === (line.askId || line.data?.askId) || a.lineId === line.id);
  if (ask) return html`<${AskCard} key=${ask.id} ask=${ask} itemId=${ask.itemId || line.itemId} line=${line} spaceId=${spaceId} store=${store} places=${html`<${LineFrom} line=${line} store=${store}/><${TidyNotes} line=${line}/>`}/>`;
  const sourceItem = store.state.byId?.[line.itemId];
  const request = !brief && !line.briefId && pendingOf(sourceItem);
  if (request) return html`<${BriefCard} item=${sourceItem} pending=${request} store=${store}/>`;
  if (!brief && !line.briefId && line.itemId) return html`<${AskCard} ask=${{ text: line.title, legacy: true }} itemId=${line.itemId} line=${line} spaceId=${spaceId} store=${store}/>`;
  if (!brief) return html`<div class="nx-chm k-needs"><${LineFrom} line=${line} store=${store}/><p>${line.title}</p><${TidyNotes} line=${line}/>${line.briefId ? html`<button class="btn sm" onClick=${() => store.openDecision(line.briefId)}>Full brief</button>` : null}</div>`;
  const about = brief.about || (store.state.chapters?.[line.spaceId]?.data?.briefs || []).find((b) => b.id === line.briefId)?.about;
  const pending = briefPending(brief, brief.ask || line.title);
  const source = store.state.byId?.[brief.itemId || line.itemId];
  const title = source?.summary?.about || source?.summary?.title || source?.facts?.name;
  const item = { id: brief.itemId || line.itemId, facts: { pending } };
  return html`<${BriefCard} size="compact" item=${item} store=${store} pending=${pending}
    status=${brief.status || 'open'} outcome=${brief.outcome}
    places=${html`<${BriefPlaces} about=${about} from=${title ? { itemId: brief.itemId || line.itemId, title } : null} open=${(id) => store.nextOpen(id)}/><${TidyNotes} line=${line}/>`}
    onOption=${(_option, index) => store.chapterAnswer(spaceId, line, brief, brief.options[index])}
    rule=${html`<${BriefRule} item=${item} store=${store} brief=${brief} pending=${pending}/>`}
    footer=${brief.status && brief.status !== 'open' ? null : html`<button class="btn sm ghost" title="Seen, not decided: back when you pick" onClick=${() => store.chapterLine(spaceId, line, 'defer')}>Snooze</button>`}/>`;
}

/** A new rule (or one approved again) asks how its answer counts: these chips change it, as the brief's did. */
const CHOOSES_RULE = new Set(['rule-created', 'rule-reaffirmed']);

/**
 * Something decided for the owner: Fine by me, Undo where there's a way back, and "I wouldn't have". A rule event is
 * news instead: Got it, and on a new rule the chips for how the answer that made it counts.
 */
export function DecidedMoment({ line, store, spaceId }) {
  const title = (line.itemId && store.state.byId?.[line.itemId]?.summary?.title) || null;
  // The way back rides on the line (older lines carry it in their detail).
  const undo = line.data?.undo || (line.detail?.startsWith('Undo: ') ? line.detail.slice(6) : null);
  const reverse = (undo) => store.reverseDecided({ id: line.decisionId, threadTitle: title }, undo, '');
  // A rule event (new rule, suspension, demotion; some have no rule id) is news: Got it, never Fine or a reversal.
  const event = typeof line.data?.ruleEvent === 'string' ? line.data.ruleEvent : null;
  const rule = !!event || typeof line.data?.rule === 'string';
  const chips = CHOOSES_RULE.has(event) && line.decisionId;
  // A tap shows until the line's own choice moves on from what it said at the tap (store.ruleDecided's { rule, from }).
  const shown = line.data?.ruleChoice || null;
  const tapped = store.state.ruleLocal?.[line.decisionId];
  const choice = tapped && tapped.from === shown ? tapped.rule : shown;
  return html`<div class="nx-chm k-decided">
    <p class="nx-chm-k">${event ? ruleTag({ kind: event }) : 'Decided for you'}${line.detail ? html` · <span>${detailed(line.detail, line.refs)}</span>` : null}</p>
    <${LineFrom} line=${line} store=${store} />
    <p class="nx-chm-t">${line.title}</p>
    ${line.raw && line.raw !== line.title && plainWords(line.raw) ? html`<p class="nx-chm-d raw">${plainWords(line.raw)}</p>` : null}
    ${chips
      ? html`<div class="sys-seg rd-rule-seg nx-chm-rule" role="group" aria-label="How it counts">
          ${RULE_CHOICES.map(([key, label]) => html`<button aria-pressed=${choice === key} disabled=${!!store.state.ruleBusy?.[line.decisionId]} onClick=${() => choice !== key && store.ruleDecided({ decision: line.decisionId, rule: line.data?.rule || null, from: shown }, key)}>${label}</button>`)}
        </div>`
      : null}
    <div class="nx-chm-acts">
      ${rule || !line.decisionId
        ? html`<button class="btn sm" onClick=${() => store.chapterLine(spaceId, line, 'read')}>Got it</button>`
        : html`<button class="btn sm" onClick=${() => store.chapterLine(spaceId, line, 'fine')}>Fine by me</button>
            ${undo ? html`<button class="btn sm" title=${`Undo: ${undo}`} onClick=${() => reverse(true)}>Undo</button>` : null}
            <button class="btn sm ghost" onClick=${() => reverse(false)}>I wouldn’t have</button>`}
      <${Refs} line=${line} />
    </div>
  </div>`;
}

/** The headline: what waits on the owner first (built from the records, `waits`), then the writer's words. */
export function Headline({ chapter, className = 'nx-ch-head' }) {
  const text = plainWords(chapter.headline);
  const waits = chapter.waits ? plainWords(chapter.waits) : '';
  if (!waits || !text.startsWith(waits)) return html`<p class=${className}>${text}</p>`;
  return html`<p class=${className}><span class="nx-waits">${waits}</span>${text.slice(waits.length)}</p>`;
}

/**
 * Shipped, failed or FYI: what happened, its picture, Try it (its first link) and Got it. A correction to a line the
 * owner already saw (desk/recheck.ts) says what they were told, then what is true now.
 */
export function NewsMoment({ line, store, spaceId }) {
  const [first, ...rest] = line.refs || [];
  const changed = line.data?.changed;
  return html`<div class=${`nx-chm k-${changed ? 'changed' : line.kind}`}>
    <p class="nx-chm-k">${changed ? 'Changed since you saw it' : KIND_LABEL[line.kind]}</p>
    <${LineFrom} line=${line} store=${store} />
    ${changed?.was ? html`<p class="nx-chm-was">You were told: ${plainWords(changed.was)}</p>` : null}
    <p class="nx-chm-t">${line.title}</p>
    <${TidyNotes} line=${line} />
    ${line.detail ? html`<p class="nx-chm-d">${detailed(line.detail, line.refs)}</p>` : line.raw && line.raw !== line.title && plainWords(line.raw) ? html`<p class="nx-chm-d raw">${plainWords(line.raw)}</p>` : null}
    ${line.folded?.length ? html`<ul class="nx-chm-fold">${line.folded.map((f) => html`<li key=${f.id}>${linked(f.title)}</li>`)}</ul>` : null}
    ${line.shot ? html`<a class="nx-chm-shot" href=${line.shot} target="_blank" rel="noopener"><img src=${line.shot} alt="" loading="lazy" /></a>` : null}
    <div class="nx-chm-acts">
      ${first ? html`<a class="btn sm ghost" href=${first.url} target="_blank" rel="noopener" title=${first.label}>${line.kind === 'shipped' ? 'Try it' : first.label}</a>` : null}
      ${line.itemId ? html`<button class="btn sm ghost" onClick=${() => store.nextOpen(line.itemId)}>Open thread</button>` : null}
      <button class="btn sm" onClick=${() => store.chapterLine(spaceId, line, 'read')}>Got it</button>
      ${rest.length ? html`<${Refs} line=${{ refs: rest }} />` : null}
    </div>
  </div>`;
}

/** The chapter's rule changes in one moment: each rule with its own controls, and one Got it for them all. */
function RulesMoment({ moment, lines, store, spaceId }) {
  return html`<div class="nx-chm k-decided">
    <p class="nx-chm-k">Rule changes · <span>${lines.length}</span></p>
    <p class="nx-chm-t">${moment.title}</p>
    <ul class="nx-chm-rules">
      ${lines.map((line) => {
        const event = typeof line.data?.ruleEvent === 'string' ? line.data.ruleEvent : null;
        const chips = CHOOSES_RULE.has(event) && line.decisionId;
        const choice = store.state.ruleLocal?.[line.decisionId] || line.data?.ruleChoice || null;
        return html`<li key=${line.id}>
          <span class="t">${event ? html`<b>${ruleTag({ kind: event })}</b> · ` : null}${linked(line.title)}</span>
          ${chips
            ? html`<div class="sys-seg rd-rule-seg nx-chm-rule" role="group" aria-label="How it counts">
                ${RULE_CHOICES.map(([key, label]) => html`<button aria-pressed=${choice === key} disabled=${!!store.state.ruleLocal?.[line.decisionId]} onClick=${() => choice !== key && store.ruleDecided({ decision: line.decisionId, rule: line.data?.rule || null }, key)}>${label}</button>`)}
              </div>`
            : null}
        </li>`;
      })}
    </ul>
    <div class="nx-chm-acts"><button class="btn sm" onClick=${() => store.chapterLine(spaceId, { id: moment.ids[0], ids: moment.ids }, 'read')}>Got it</button></div>
  </div>`;
}

/** A milestone: the group of shipped work the owner will notice, its lines listed, one Got it. */
function MilestoneMoment({ moment, lines, store, spaceId }) {
  const first = lines.flatMap((l) => l.refs || [])[0];
  return html`<div class="nx-chm k-shipped">
    <p class="nx-chm-k">Finished · <span>${lines.length} ${lines.length === 1 ? 'change' : 'changes'}</span></p>
    <p class="nx-chm-t">${moment.title}</p>
    <ul class="nx-chm-fold">${lines.map((l) => html`<li key=${l.id}>${linked(l.title)}${l.folded?.length ? html`<ul class="nx-chm-fold">${l.folded.map((f) => html`<li key=${f.id}>${linked(f.title)}</li>`)}</ul>` : null}</li>`)}</ul>
    <div class="nx-chm-acts">
      ${first ? html`<a class="btn sm ghost" href=${first.url} target="_blank" rel="noopener" title=${first.label}>Try it</a>` : null}
      <button class="btn sm" onClick=${() => store.chapterLine(spaceId, { id: moment.ids[0], ids: moment.ids }, 'read')}>Got it</button>
    </div>
  </div>`;
}

const SMALL_SHOWN = 5;

function SmallGroup({ kind, lines }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, SMALL_SHOWN);
  return html`<div class="nx-chs-g">
    <p class="nx-chs-h"><${Dot} kind=${kind} /><b>${SMALL_LABEL[kind]} · ${lines.length}</b></p>
    <ul>${shown.map((l) => html`<li key=${l.id}>${linked(l.title)}</li>`)}</ul>
    ${lines.length > shown.length ? html`<button class="linkish nx-chs-more" onClick=${() => setAll(true)}>and ${lines.length - shown.length} more</button>` : null}
  </div>`;
}

function ThemeGroup({ group, lines }) {
  const [all, setAll] = useState(false);
  // One line is its own title: no header repeating it.
  if (lines.length === 1) {
    const [l] = lines;
    return html`<div class="nx-chs-g"><p class="nx-chs-h"><${Dot} kind=${group.kind} /><span>${linked(l.title)}</span>${l.folded?.length ? html`<span class="nx-chs-fold"> · ${l.folded.length} decision${l.folded.length === 1 ? '' : 's'} with it</span>` : null}</p></div>`;
  }
  const shown = all ? lines : lines.slice(0, SMALL_SHOWN);
  return html`<div class="nx-chs-g">
    <p class="nx-chs-h"><${Dot} kind=${group.kind} /><b>${group.title} · ${lines.length}</b></p>
    <ul>${shown.map((l) => html`<li key=${l.id}>${linked(l.title)}${l.folded?.length ? html`<span class="nx-chs-fold"> · ${l.folded.length} decision${l.folded.length === 1 ? '' : 's'} with it</span>` : null}</li>`)}</ul>
    ${lines.length > shown.length ? html`<button class="linkish nx-chs-more" onClick=${() => setAll(true)}>and ${lines.length - shown.length} more</button>` : null}
  </div>`;
}

function Smaller({ lines, groups = null }) {
  if (groups) {
    return html`<div class="nx-chm nx-chm-small">
      <p class="nx-chm-k plain">Smaller</p>
      ${groups.map((g) => html`<${ThemeGroup} key=${g.key} group=${g} lines=${g.shown} />`)}
    </div>`;
  }
  const byGroup = KIND_ORDER.map((k) => [k, lines.filter((l) => l.kind === k)]).filter(([, ls]) => ls.length);
  return html`<div class="nx-chm nx-chm-small">
    <p class="nx-chm-k plain">Smaller</p>
    ${byGroup.map(([k, ls]) => html`<${SmallGroup} key=${k} kind=${k} lines=${ls} />`)}
  </div>`;
}

/**
 * The card's collapsed reading (the server's view, desk/collapse.ts) with what the owner already handled at the tap
 * taken out: moments in order, each line in the owner's words with its folded decisions, and the smaller groups.
 */
export function viewOf(data, lineLocal = {}) {
  const view = data?.view;
  if (!view) return null;
  const byId = new Map((data.lines || []).map((l) => [l.id, l]));
  const live = (ids) => ids.some((id) => !lineLocal[id] && byId.has(id));
  // Needs you cleaned up (desk/triage.ts): a kept ask names its repeats; the writer's note is labeled text.
  const shown = (id) => {
    const l = byId.get(id);
    if (!l) return null;
    const folded = (view.folded?.[id] || []).map((f) => byId.get(f)).filter(Boolean).map((f) => ({ ...f, title: view.titles?.[f.id] || f.title }));
    return withTidy({ ...l, raw: l.title, title: view.titles?.[id] || l.title, folded, ids: [id, ...folded.map((f) => f.id)] }, view.tidy, lineLocal, view.titles);
  };
  const moments = view.moments.filter((m) => live(m.ids)).map((m) => ({ ...m, shown: m.line !== null ? shown(m.line) : null, inside: (m.lines || []).filter((id) => !lineLocal[id]).map(shown).filter(Boolean) }));
  const groups = view.groups.filter((g) => live(g.ids)).map((g) => ({ ...g, shown: g.lines.filter((id) => !lineLocal[id]).map(shown).filter(Boolean) })).filter((g) => g.shown.length);
  return { moments, groups, tidy: tidyLines({ data }, lineLocal) };
}

/**
 * What Needs you folded away, on its own row, folded until tapped: Asked elsewhere (a repeat kept in another space).
 * Seeing them is Accept's or Got it's, like any smaller line.
 */
export function Tucked({ tidy }) {
  const [open, setOpen] = useState({});
  if (!tidyCount(tidy)) return null;
  const rows = [
    ['elsewhere', 'Asked elsewhere', tidy.elsewhere, (l) => html`${linked(l.title)}${l.where ? html`<span class="nx-chs-fold"> · also in ${l.where}</span>` : null}`],
  ].filter(([, , lines]) => lines.length);
  return html`<div class="nx-chs-tucked">${rows.map(([key, label, lines, item]) => html`<div class="nx-chs-g" key=${key}>
    <button class="linkish nx-chs-h" aria-expanded=${!!open[key]} onClick=${() => setOpen((o) => ({ ...o, [key]: !o[key] }))}><${Dot} kind="fyi" hollow=${true} /><b>${label} · ${lines.length}</b><span class="nx-chs-fold">${open[key] ? 'Fold' : 'Show'}</span></button>
    ${open[key] ? html`<ul>${lines.map((l) => html`<li key=${l.id}>${item(l)}</li>`)}</ul>` : null}
  </div>`)}</div>`;
}

/** "35 smaller updates: 26 shipped, 9 routine": what the smaller groups hold, counted in lines so the parts add up. */
export function groupsLine(groups) {
  const count = (kind) => groups.filter((g) => g.kind === kind).reduce((n, g) => n + g.shown.length, 0);
  const parts = [[count('shipped'), 'shipped'], [count('decided'), 'routine'], [count('failed'), 'failed'], [count('fyi'), 'FYI'], [count('needs'), 'waiting']].filter(([n]) => n > 0);
  const total = parts.reduce((n, [k]) => n + k, 0);
  return `${total} smaller update${total === 1 ? '' : 's'}: ${parts.map(([n, w]) => `${n} ${w}`).join(', ')}`;
}

/** The moment card for one collapsed moment. */
function MomentCard({ m, briefs, store, spaceId }) {
  if (m.batch === 'rules') return html`<${RulesMoment} moment=${m} lines=${m.inside} store=${store} spaceId=${spaceId} />`;
  if (m.batch === 'milestone') return html`<${MilestoneMoment} moment=${m} lines=${m.inside} store=${store} spaceId=${spaceId} />`;
  const l = m.shown;
  if (!l) return null;
  return l.kind === 'needs' ? html`<${ChapterBrief} line=${l} brief=${briefs.get(l.briefId)} store=${store} spaceId=${spaceId} />`
    : l.kind === 'decided' ? html`<${DecidedMoment} line=${l} store=${store} spaceId=${spaceId} />`
    : html`<${NewsMoment} line=${l} store=${store} spaceId=${spaceId} />`;
}

/** The moments the card lists before "+N more moments" (desk/collapse.ts MOMENT_CAP). */
const MOMENT_CAP = 3;

/** Since you were here: the chapter, folded to its lines or open to a card per moment, then Accept and Snooze. */
function News({ store, spaceId, data, name, leadName }) {
  const view = viewOf(data, store.state.lineLocal);
  if (view) return html`<${Collapsed} store=${store} spaceId=${spaceId} data=${data} view=${view} name=${name} leadName=${leadName} />`;
  return html`<${Uncollapsed} store=${store} spaceId=${spaceId} data=${data} name=${name} leadName=${leadName} />`;
}

/** The card from the server's collapsed view: at most three moments, then "+N more", then the smaller groups. */
function Collapsed({ store, spaceId, data, view, name, leadName }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const { state } = store;
  const briefs = new Map((data.briefs || []).map((b) => [b.id, b]));
  const busy = !!state.chapterLocal[spaceId];
  const since = data.chapter?.since;
  const { moments, groups, tidy } = view;
  const shown = more ? moments : moments.slice(0, MOMENT_CAP);
  const hidden = moments.length - shown.length;
  return html`<section class="nx-chapter news" aria-label="Since you were here">
    <p class="nx-st-h">${PULSE}<b>Since you were here</b>${moments.length ? html`<span class="nx-ch-new">${moments.length} new</span>` : null}
      <span class="nx-st-when">${since ? `${when(since, state.now)} → now` : ''}${leadName ? `${since ? ' · ' : ''}${leadName}` : ''}</span></p>
    ${data.chapter?.headline ? html`<${Headline} chapter=${data.chapter} />` : null}
    ${open
      ? html`<div class="nx-chms">
          ${shown.map((m) => html`<${MomentCard} key=${m.key} m=${m} briefs=${briefs} store=${store} spaceId=${spaceId} />`)}
          ${hidden > 0 ? html`<button class="linkish nx-ch-more" onClick=${() => setMore(true)}>+${hidden} more moment${hidden === 1 ? '' : 's'}</button>` : null}
          ${groups.length ? html`<${Smaller} groups=${groups} />` : null}
          <${Tucked} tidy=${tidy} />
        </div>`
      : html`<ul class="nx-ch-lines">
          ${shown.map((m) => html`<li key=${m.key}><${Dot} kind=${m.kind} /><span class="t">${m.shown?.title || m.title}</span><span class="k">${m.batch === 'rules' ? 'Rule changes' : m.batch === 'milestone' ? `Finished · ${m.inside.length}` : KIND_LABEL[m.kind]}</span></li>`)}
          ${hidden > 0 ? html`<li class="small"><button class="linkish k" onClick=${() => setMore(true)}>+${hidden} more moment${hidden === 1 ? '' : 's'}</button></li>` : null}
          ${groups.length ? html`<li class="small"><${Dot} kind="fyi" hollow=${true} /><span class="k">${groupsLine(groups)}</span></li>` : null}
        </ul>
        <${Tucked} tidy=${tidy} />
        <button class="linkish nx-ch-open" onClick=${() => setOpen(true)}>Open ›</button>`}
    <div class="nx-ch-acts">
      <button class="btn sm pri" disabled=${busy} onClick=${() => store.chapterAct(spaceId, 'accepted', { name, lead: leadName })}>Accept</button>
      <button class="btn sm" disabled=${busy} title="Seen, not decided: back when you pick" onClick=${() => store.chapterAct(spaceId, 'deferred', { name, lead: leadName })}>Snooze</button>
      ${open ? html`<button class="btn sm ghost" onClick=${() => setOpen(false)}>Fold</button>` : null}
    </div>
    <p class="nx-ch-plan">${plainWords(data.plan.line)}</p>
  </section>`;
}

/** The card from the lines alone (a desk older than the collapse view). */
function Uncollapsed({ store, spaceId, data, name, leadName }) {
  const [open, setOpen] = useState(false);
  const { state } = store;
  const shown = data.lines.filter((l) => !state.lineLocal[l.id]);
  const moments = shown.filter((l) => l.moment).sort(byKind);
  const smaller = shown.filter((l) => !l.moment).sort(byKind);
  const briefs = new Map((data.briefs || []).map((b) => [b.id, b]));
  const busy = !!state.chapterLocal[spaceId];
  const since = data.chapter?.since;
  return html`<section class="nx-chapter news" aria-label="Since you were here">
    <p class="nx-st-h">${PULSE}<b>Since you were here</b>${moments.length ? html`<span class="nx-ch-new">${moments.length} new</span>` : null}
      <span class="nx-st-when">${since ? `${when(since, state.now)} → now` : ''}${leadName ? `${since ? ' · ' : ''}${leadName}` : ''}</span></p>
    ${data.chapter?.headline ? html`<${Headline} chapter=${data.chapter} />` : null}
    ${open
      ? html`<div class="nx-chms">
          ${moments.map((l) =>
            l.kind === 'needs' ? html`<${ChapterBrief} key=${l.id} line=${l} brief=${briefs.get(l.briefId)} store=${store} spaceId=${spaceId} />`
            : l.kind === 'decided' ? html`<${DecidedMoment} key=${l.id} line=${l} store=${store} spaceId=${spaceId} />`
            : html`<${NewsMoment} key=${l.id} line=${l} store=${store} spaceId=${spaceId} />`)}
          ${smaller.length ? html`<${Smaller} lines=${smaller} />` : null}
        </div>`
      : html`<ul class="nx-ch-lines">
          ${moments.map((l) => html`<li key=${l.id}><${Dot} kind=${l.kind} /><span class="t">${linked(l.title)}</span><span class="k">${KIND_LABEL[l.kind]}</span></li>`)}
          ${smaller.length ? html`<li class="small"><${Dot} kind="fyi" hollow=${true} /><span class="k">${smaller.length} smaller update${smaller.length === 1 ? '' : 's'}</span></li>` : null}
        </ul>
        <button class="linkish nx-ch-open" onClick=${() => setOpen(true)}>Open ›</button>`}
    <div class="nx-ch-acts">
      <button class="btn sm pri" disabled=${busy} onClick=${() => store.chapterAct(spaceId, 'accepted', { name, lead: leadName })}>Accept</button>
      <button class="btn sm" disabled=${busy} title="Seen, not decided: back when you pick" onClick=${() => store.chapterAct(spaceId, 'deferred', { name, lead: leadName })}>Snooze</button>
      ${open ? html`<button class="btn sm ghost" onClick=${() => setOpen(false)}>Fold</button>` : null}
    </div>
    <p class="nx-ch-plan">${linked(data.plan.line)}</p>
  </section>`;
}

/** Where it stands: the chapter's headline and what's next, what still waits on the owner, and what changed since. */
function Stands({ store, data, line, at }) {
  const [changes, setChanges] = useState(false);
  const { now } = store.state;
  const chapter = data?.chapter;
  const headline = chapter?.headline || line;
  const recent = data?.recent || [];
  const caught = recent[0]?.seenAt || null;
  const from = recent.length ? Math.min(...recent.map((r) => r.at)) : null;
  if (!headline && !data?.waiting?.length) return null;
  return html`<section class="nx-chapter" aria-label="Where it stands">
    <p class="nx-st-h">${PULSE}<b>Where it stands</b><span class="nx-st-when">${chapter?.state === 'deferred' && chapter.backAt ? `snoozed · back ${when(chapter.backAt, now)}` : caught ? `caught up ${when(caught, now)}` : at ? `${age(at, now)} ago` : ''}</span></p>
    ${headline ? html`<p class="nx-ch-head plain">${plainWords(headline)}</p>` : null}
    ${chapter?.status ? html`<p class="nx-ch-status">${plainWords(chapter.status)}</p>` : null}
    ${data?.waiting?.length
      ? html`<ul class="nx-ch-lines">${data.waiting.map(
          (w) => html`<li key=${w.id}><${Dot} kind="needs" /><button class="linkish t" onClick=${() => (w.briefId ? store.openDecision(w.briefId) : w.itemId && store.nextOpen(w.itemId))}>${titled(w.title)}</button><span class="k">waiting on you</span></li>`,
        )}</ul>`
      : null}
    ${recent.length
      ? changes
        ? html`<ul class="nx-ch-lines recent">${recent.map(
            (r) => html`<li key=${r.id}><${Dot} kind=${r.kind} hollow=${true} /><span class="t">${titled(r.title)}</span><span class="k">${r.seenVia === 'deferred' ? 'snoozed' : r.outcome && r.outcome !== 'fine' ? r.outcome : r.outcome === 'fine' ? 'fine by you' : r.seenVia}</span></li>`,
          )}</ul>
          <button class="linkish nx-ch-open" onClick=${() => setChanges(false)}>Fold</button>`
        : html`<button class="linkish nx-ch-open" onClick=${() => setChanges(true)}>What changed since ${when(from, now)}</button>`
      : null}
  </section>`;
}

/**
 * The card under a space's name. `line` and `at` are the old Where it stands (the lead's summary), shown while the
 * desk has no ledger or the space has no chapter yet.
 */
export function ChapterCard({ store, spaceId, name, leadName = null, leadAt = null, line = '', at = null }) {
  useChapter(store, spaceId, leadAt);
  const entry = store.state.chapters?.[spaceId];
  const data = entry?.data;
  const local = store.state.chapterLocal?.[spaceId];
  const news = data && !local && data.chapter?.state !== 'deferred' && data.lines.some((l) => !store.state.lineLocal[l.id]);
  if (news) return html`<${News} store=${store} spaceId=${spaceId} data=${data} name=${name} leadName=${leadName} />`;
  return html`<${Stands} store=${store} data=${data} line=${line} at=${at} />`;
}
