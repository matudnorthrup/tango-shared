// The decision brief card (TGO-1080, the owner's v2 "rows" pick, R-12): plain-word pills, where it came from, the
// ask, one summary line that opens the full receipt, where it stands, the options as full-width rows, the rule, the
// assets as tiles, and the background on its own row. Answering is the same Answers form as any pending question.

import { PR_ICONS } from './next/icons.js';
import { html } from '../vendor/preact-htm.js';
import { AnswerRule } from './answer-rule.js';
import { Answers, BriefOption } from './cards.js';
import { assetKind, dueText, optionRow, receiptRows, revisionText, statusPill, summaryLine, tripwireText, ago, supportingSummary } from './brief-model.js';
import { threadTitle } from './next/model.js';
import { age } from './util.js';
import { linked } from './decision-links.js';

const svg = (d) => html`<svg class="bc-ico" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
const ICONS = {
  thread: svg(html`<path d="M14 8a5.5 5.5 0 0 1-8 4.9L2.5 14l1-3.3A5.5 5.5 0 1 1 14 8z"/>`),
  carried: svg(html`<path d="M2.5 8h8M7.5 4.5 11 8l-3.5 3.5"/><path d="M13.5 3v10"/>`),
  clock: svg(html`<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>`),
  revised: svg(html`<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1L2.5 5.5"/><path d="M2.5 2.5v3h3"/>`),
  pr: PR_ICONS.open,
  doc: svg(html`<path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M5.5 8.5h5M5.5 11h5"/>`),
  prototype: svg(html`<rect x="1.5" y="2" width="13" height="10" rx="1"/><path d="M1.5 4.75h13"/><path d="M8.5 7.5l1.6 6.5 1.1-2.3 2.3-1.1z"/>`),
  video: svg(html`<rect x="1.5" y="3.5" width="9.5" height="9" rx="1.5"/><path d="m11 7 3.5-2v6L11 9"/>`),
  image: svg(html`<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.3"/><path d="m14.5 11-4-4-7 6.5"/>`),
  link: svg(html`<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.8-.8"/>`),
};
const ASSET_ICON = { pr: 'pr', issue: 'pr', doc: 'doc', report: 'doc', prototype: 'prototype', preview: 'video', video: 'video', screenshot: 'image', image: 'image' };

/** The top line: the decision's id, who decides (a live countdown at level 3), when it's due, why it's the owner's, and its version. */
function BriefPills({ brief, status: closedStatus = null }) {
  const status = closedStatus ? { kind: 'wait', text: BRIEF_STATUS[closedStatus] || closedStatus } : statusPill(brief);
  const due = closedStatus ? null : dueText(brief.deadline);
  const trip = tripwireText(brief.tripwire);
  const rev = revisionText(brief);
  return html`<div class="bc-top">
    <span class="bc-id">${brief.id}</span>
    <span class=${`bc-pill ${status.kind}`} title=${status.kind === 'timer' ? "Counts only time you're using Tango; idle time doesn't count. Any answer stops it." : ''}>
      ${status.kind === 'timer' ? html`<span class="bc-ring" style=${`--p:${Math.round(status.fraction * 100)}`}></span>` : null}<span>${status.text}</span>
    </span>
    ${due ? html`<span class="bc-pill due" title=${brief.deadline}>${ICONS.clock}<span>${due}</span></span>` : null}
    ${trip ? html`<span class="bc-pill trip">${trip}</span>` : null}
    ${rev ? html`<span class="bc-pill rev" title=${brief.updated?.why || ''}>${ICONS.revised}<span>${rev}</span></span>` : null}
  </div>`;
}

/** "From <thread> →" and "Carried by <thread> →", each a link that opens that thread (`open(itemId)`). */
export function BriefPlaces({ from = null, carriedBy = [], about = null, open }) {
  if (!from && !carriedBy.length) return null;
  return html`<div class="bc-from">
    ${from ? html`<button class="bc-link" onClick=${() => open(from.itemId)}>${ICONS.thread}${about ? `${about} · from ` : 'From '}${from.title} →</button>` : null}
    ${carriedBy.map((by) => html`<button class="bc-link carried" onClick=${() => open(by.itemId)}>${ICONS.carried}Carried by ${by.title} →</button>`)}
  </div>`;
}

/** On a row: where the packet came from, or, on the thread that raised it, the row that carries it. */
function BriefFrom({ brief, item, store }) {
  const from = brief.from && brief.from.itemId !== item.id ? brief.from : null;
  const by = !from ? item.facts?.carriedBy || null : null;
  return html`<${BriefPlaces} from=${from} carriedBy=${by ? [by] : []} open=${(id) => store.openItem(id)} />`;
}

function BriefReceipt({ brief, item, at, now, defaultLabel, closed = false }) {
  const here = threadTitle(item) || null;
  const by = brief.from && brief.from.itemId !== item.id ? null : item.facts?.carriedBy || null;
  const rows = receiptRows(brief, { at, now, age, here, carriedBy: by, defaultLabel }).filter(([key]) => !closed || !["Who decides", "If you don't answer"].includes(key));
  return html`<details class="bc-sum">
    <summary>${summaryLine(brief, at, now, age)} · <span class="bc-more">Details</span></summary>
    <dl class="bc-rcpt">${rows.map(([k, v]) => html`<div><dt>${k}</dt><span class="bc-lead"></span><dd>${linked(v)}</dd></div>`)}</dl>
  </details>`;
}

function BriefAssets({ assets }) {
  if (!assets?.length) return null;
  return html`<div class="bc-assets">
    <p class="bc-label">Assets</p>
    <div class="bc-tiles">
      ${assets.map((a) => html`<a class="bc-tile" href=${a.url} target="_blank" rel="noopener">
        <span class="bc-kind">${ICONS[ASSET_ICON[a.kind]] || ICONS.link}${assetKind(a.kind)}</span>
        <span class="bc-title">${a.title}</span>
      </a>`)}
    </div>
  </div>`;
}

function BriefBackground({ brief }) {
  const extra = [brief.changeMyMind ? 'what would change my mind' : null].filter(Boolean);
  return html`<details class="bc-bg">
    <summary>Background${extra.length ? ` · ${extra.join(' · ')}` : ''}</summary>
    <p>${linked(brief.background)}</p>
    ${brief.changeMyMind ? html`<p><b>What would change my mind:</b> ${linked(brief.changeMyMind)}</p>` : null}
  </details>`;
}

/**
 * One brief, as its card, on a row or its own page (next/decision.js): `pending` is the question as shown. `answer`: a
 * brief this row carries from another thread, answered as itself (its own pending); `rule`: its rule chips
 * (conversation.js BriefRule), shown under the options. The page passes `places` (where it was raised and who carries
 * it) in place of the row's From line, and `answers` when the brief can't be answered there. D-n in its text are links.
 */
export function BriefCard({ item, store, pending, answer = null, rule = null, places = undefined, answers = undefined, size = "full", status = "open", outcome = null, onOption = null, footer = null, summary = null, savedRule = null, receipt = null }) {
  const brief = pending.brief;
  if (size === 'receipt') return html`<section class="bc bc-receipt" aria-label=${`Decision ${brief.id}`}><p class="bc-outcome" role="status"><button class="bc-link" onClick=${() => store.openDecision(brief.id)}>${brief.id}</button> ${receipt}</p></section>`;
  // Plain asks share the card's type, spacing and answer form, without decision-only metadata.
  if (!brief) {
    const context = supportingSummary(pending.question, summary);
    return html`<section class="rd-needs your_move rd-brief bc bc-full bc-plain" aria-label="Question">
      <h3 class="bc-ask">${linked(pending.question)}</h3>
      ${context ? html`<p class="bc-standing">${linked(context)}</p>` : null}
      <${Answers} item=${item} store=${store} big=${true} />
    </section>`;
  }
  const compact = size === "compact";
  const discussing = status === "discussing" || (status === "open" && brief.discussingSince != null);
  const closed = status !== "open" && status !== "discussing";
  const now = store.state.now;
  const at = pending.at || null;
  const def = brief.level === 3 && brief.defaultOption ? (pending.questions?.[0]?.options || []).map((o, i) => optionRow(o, brief, i)).find((o) => o.isDefault) : null;
  const updated = brief.updated;
  const options = closed || onOption ? html`<div class="pq-chips bc-opts">${(pending.questions?.[0]?.options || []).map((option, index) => html`<${BriefOption} option=${option} brief=${closed ? { ...brief, defaultOption: null } : brief} index=${index} readOnly=${closed} picked=${closed && outcome?.option?.key === optionRow(option, brief, index).key} disabled=${!!store.state.holds?.[item.id]} onClick=${() => onOption?.(option, index)} />`)}</div>` : answers !== undefined ? answers : html`<${Answers} item=${item} store=${store} big=${true} pending=${answer || (discussing ? pending : null)} />`;
  return html`<section class=${`rd-needs ${closed || discussing ? "fyi" : "your_move"} rd-brief bc bc-${size}${answer ? ' rd-carried' : ''}`} aria-label=${`Decision ${brief.id}`}>
    <${BriefPills} brief=${brief} status=${discussing ? "discussing" : closed ? status : null} />
    ${places !== undefined ? places : html`<${BriefFrom} brief=${brief} item=${item} store=${store} />`}
    <h3 class="bc-ask">${linked(pending.question)}</h3>
    ${!compact && html`<${BriefReceipt} closed=${closed || discussing} brief=${brief} item=${item} at=${at} now=${now} defaultLabel=${def ? `${def.key} · ${def.title}` : null} />`}
    ${discussing ? html`<p class="bc-outcome" role="status">In discussion: your reply was delivered; the agent will respond.</p>` : null}
    ${brief.unaddressedAt ? html`<p class="bc-updated">You replied; the agent didn't address it. Your reply was delivered.</p>` : null}
    ${updated ? html`<p class="bc-updated">${ICONS.revised}<span>Updated: ${linked(updated.why?.trim() || updated.what)}</span></p>` : null}
    ${!compact && brief.standing ? html`<p class="bc-standing">${linked(brief.standing)}</p>` : null}
    ${discussing ? html`<details class="bc-formal"><summary>Answer formally instead</summary>${options}</details>` : options}
    ${closed ? html`<${BriefOutcome} outcome=${outcome} store=${store} />` : rule}
    ${!compact && status === "answered" && savedRule ? html`<${AnswerRule} saved=${savedRule} store=${store} />` : null}
    ${!compact && html`<${BriefAssets} assets=${brief.assets} />`}
    ${!compact && html`<${BriefBackground} brief=${brief} />`}
    ${compact ? html`<div class="bc-footer"><a class="btn sm ghost" href=${`decision/${brief.id}`} onClick=${(e) => { e.preventDefault(); store.openDecision(brief.id); }}>Full brief</a>${footer}</div>` : null}
  </section>`;
}

export const BRIEF_STATUS = { open: 'Open', discussing: 'In discussion', answered: 'Answered', withdrawn: 'Withdrawn', moot: 'Moot', superseded: 'Replaced', defaulted: 'Went ahead by default', acted: 'Decided for you' };

export function BriefOutcome({ outcome, store }) {
  if (!outcome) return null;
  const who = { 'owner-desk': 'You answered', 'owner-chat': 'You answered in chat', default: 'No veto, so the default went ahead', rule: 'A standing rule decided it', agent: 'Closed' }[outcome.by] || 'Closed';
  return html`<div class="bc-outcome" role="status"><p><b>${who}</b>${outcome.option ? `: ${outcome.option.key} · ${outcome.option.label}` : ''}${outcome.text ? ` “${outcome.text}”` : ''}${outcome.at ? ` · ${ago(outcome.at, store.state.now, age)}` : ''}</p>
    ${outcome.reason ? html`<p>Why: ${outcome.reason}</p>` : null}
    ${outcome.in ? html`<button class="bc-link" onClick=${() => { store.closeDecision?.(); store.openItem(outcome.in.itemId); }}>In ${outcome.in.title} →</button>` : null}</div>`;
}

/** Normalize stored brief options for the same rows used by live pending questions. */
export function briefPending(brief, ask, at = null) {
  return { kind: 'question', requestId: `decision:${brief.id}`, at, question: ask, brief,
    questions: [{ id: 'decision', question: ask, options: (brief.options || []).map(o => ({ label: o.answer || `${o.key} · ${o.label}${o.recommended ? ' (Recommended)' : ''}`, description: o.consequence })) }] };
}

/** Durable server receipts in the main conversation; the full brief remains one tap away. */
export function BriefReceipts({ item, store }) {
  const answered = item.facts?.answeredBrief;
  return html`<div class="rd-brief-receipts">
    ${answered ? html`<${BriefCard} item=${item} store=${store} pending=${{ brief: { id: answered.id } }} size="receipt" receipt=${`Answered: ${answered.choice} · agent notified`} />` : null}
    ${(item.facts?.discussing || []).map(brief => html`<${BriefCard} key=${brief.id} item=${item} store=${store} pending=${{ brief }} size="receipt" receipt="In discussion: your reply delivered" />`)}
  </div>`;
}
