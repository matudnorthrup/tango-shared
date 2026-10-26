import { PhoneNote } from './phone-note.js';
import { OwnerReceipts, mergeOwnerReceipts } from './owner-receipts.js';
import { VoiceButton, cancelVoiceEdit } from './voice.js';
// A thread's pieces, which the next layout's thread page (next/thread.js) lays out: what the agent
// needs, its latest reply in full, backstage mail, the timeline and links sheets, and the reply box
// (a voice draft for this item fills it live).

import { PrList } from './next/prs.js';
import { threadPrs, otherLinks } from './next/pr-model.js';
import { AnswerRule, RULE_CHIPS } from './answer-rule.js';
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { ACCEPT, pastedFiles, Shelf, Thumbs, useFileDrop } from './attachments.js';
import { BriefCard } from './brief.js';
import { AskCard } from './ask-card.js';
import { Answers, Beat, CommandLine, InFlightList, Ticker, WritebackLine } from './cards.js';
import { answerOf, askParts, callsOf, canOpen, exchangeMessageIds, exchangesOf, mailBody, replyMessages } from './conversation-model.js';
import { draftForItem, draftView } from './draft-model.js';
import { renderMarkdown } from './md.js';
import { onCodeButton } from './md-actions.js';
import { isCoding, statusWords } from './next/model.js';
import { replyTakesFocus } from './next/keyboard.js';
import { DraftCard } from './mail-draft.js';
import { CoordinatorPane, DOCK_QUERY as DOCK, LinkList, SidePanel } from './coordinator.js';
import { panelTabs } from './coordinator-model.js';
import { pendingHeadline, pendingOf } from './pending.js';
import { projectOf } from './list-model.js';
import { activityText, age, agentColor, agentName, askedOf, failureText, storageGet, stuckMinutes, isSendKey, fitToContent, refitOnResize } from './util.js';
import { linked } from './decision-links.js';

function currentItem(state) {
  const d = state.detail;
  const id = state.presentation.itemId || d?.id;
  return (d && d.id === id && d.item) || state.byId[id] || null;
}

function Markdown({ text, cls = '', store }) {
  const ref = useRef(null);
  const markup = renderMarkdown(text);
  useEffect(() => {
    if (storageGet('codeWrap', '') !== '1') return;
    for (const block of ref.current?.querySelectorAll('.md-code') ?? []) {
      block.classList.add('wrap');
      block.querySelector('[data-code="wrap"]')?.setAttribute('aria-pressed', 'true');
    }
  }, [markup]);
  // Start on a code block: the new thread joins the project this conversation belongs to.
  const projectId = () => currentItem(store.state)?.facts?.projectId || null;
  return html`<div ref=${ref} class=${`md ${cls}`} onClick=${(e) => onCodeButton(e, store, projectId())} dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}

/** The detail's beats; an older server without them gets the plain timeline. */
function beatsOf(d) {
  if (d?.beats?.length) return d.beats;
  return (d?.timeline || []).filter((b) => b.kind !== 'now').map((b) => ({ at: b.at, kind: b.kind, headline: b.text, messageId: null }));
}

/** The latest reply in full; an older server without it gets the last agent message. */
export function replyOf(d) {
  // An explicit null is the server saying "no reply to you yet" (mail answers never stand in); only an older server omits it.
  if (d && d.reply !== undefined) return d.reply;
  const last = [...(d?.messages || [])].reverse().find((m) => m.author === 'agent');
  return last ? { at: last.at, messageIds: [last.messageId], text: last.text, attachments: last.attachments } : null;
}

function linkCount(item, d) {
  return (item.artifacts?.length || 0) + (d?.scenes?.length || 0) + (d?.prototypes?.length || 0);
}

/** "3 links · 1 screen", "1 screen": artifacts and screens counted apart. */
function linkLabel(item, d) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const links = item.artifacts?.length || 0;
  const screens = d?.scenes?.length || 0;
  const prototypes = d?.prototypes?.length || 0;
  return [links ? plural(links, 'link') : null, screens ? plural(screens, 'screen') : null, prototypes ? plural(prototypes, 'prototype') : null].filter(Boolean).join(' · ');
}

// ── sidebar ─────────────────────────────────────────────────────────

function GoalBlock({ item }) {
  const s = item.summary || {};
  const goal = s.goal || s.about;
  return html`
    ${goal ? html`<section class="rd-block"><h3 class="h4">Goal</h3><p>${goal}</p></section>` : null}
    ${s.milestone
      ? html`<section class="rd-block"><h3 class="h4">Working toward</h3><p class="rd-ms">${s.milestone}</p></section>`
      : askedOf(item)
        ? html`<section class="rd-block"><h3 class="h4">You asked</h3><p>${askedOf(item)}</p></section>`
        : null}`;
}

/** "How we got here": one row per exchange, what the owner said over what the agent said back. */
function ExchangeList({ exchanges, messages, item, store, sheet = false }) {
  if (!exchanges.length) return html`<p class="note">No history yet.</p>`;
  const last = exchanges.length - 1;
  const now = store.state.now;
  const who = agentName(item);
  return html`<ol class=${`rd-ex${sheet ? ' in-sheet' : ''}`} style=${`--c:${agentColor(item)}`}>
    ${exchanges.map((x, i) => {
      const ask = askParts(x.ask);
      const answer = answerOf(x);
      const more = (replyMessages(exchanges, i, messages) || x.replies).length - 1;
      const body = html`
        ${ask ? html`<span class=${ask.mail ? 'q mail' : 'q'}><b>${ask.who}</b>${linked(ask.text)}${x.ask?.queued ? html`<em class="qd">Queued</em>` : null}</span>` : null}
        ${answer ? html`<span class="a"><b>${who}</b>${linked(answer.headline)}</span>` : ask ? html`<span class="a pending">${i === last ? `${who} hasn’t replied yet` : 'No reply'}</span>` : null}
        ${x.events.filter((e) => e.kind !== 'backstage' && e.kind !== 'mail').map((e) => html`<span class=${`ev ${e.kind}`}>${linked(e.headline)}</span>`)}
        <small>${age(x.at, now)} ago${more > 0 ? ` · ${more + 1} replies` : ''}</small>`;
      // The mail in and after this exchange: one quiet row (a row's button can't hold the line's buttons).
      const mail = mailLinesOf(x);
      return [
        html`<li key=${x.ask?.messageId || answer?.messageId || `${x.at}-${i}`} class=${i === last && !mail.length ? 'last' : ''}>
          ${canOpen(x)
            ? html`<button onClick=${() => store.openSheet({ kind: 'exchange', index: i, from: sheet ? 'context' : null })}>${body}</button>`
            : html`<div>${body}</div>`}
        </li>`,
        mail.length ? html`<li key=${`mail-${x.at}-${i}`} class="bs-row"><${MailSummary} lines=${mail} store=${store} phone=${sheet} /></li>` : null,
      ];
    })}
  </ol>`;
}

/** Links, screens and prototypes: the right panel, or the Links sheet on a phone. */
function LinksBody({ item, d, store }) {
  const done = (fn) => () => (store.closeSheet(), fn());
  if (!linkCount(item, d) && !threadPrs(item).length) return html`<p class="note">No links or screens yet.</p>`;
  return html`
    ${d?.prototypes?.length
      ? html`<section class="rd-block"><h3 class="h4">Prototypes</h3><div class="rd-chips">${d.prototypes.map((p) => html`<button class="pill art proto" onClick=${done(() => store.showPrototype(p.id))}>${p.title || p.name}</button>`)}</div></section>`
      : null}
    ${threadPrs(item).length ? html`<section class="rd-block"><h3 class="h4">Pull requests</h3><${PrList} item=${item} now=${store.state.now} /></section>` : null}
    ${otherLinks(item).length
      ? html`<section class="rd-block"><h3 class="h4">Links</h3><${LinkList} links=${otherLinks(item)} store=${store} projectId=${item.facts?.projectId || null} /></section>`
      : null}
    ${d?.scenes?.length
      ? html`<section class="rd-block"><h3 class="h4">Screens</h3><div class="rd-chips">${d.scenes.map((s) => html`<button class="pill art" onClick=${done(() => store.showScreen(s.id))}>▢ ${s.title || s.summary || 'Screen'}</button>`)}</div></section>`
      : null}`;
}

/** The right panel with tabs: the project's coordinator, and this conversation's links and screens. */
function ConvoPanel({ item, d, store, project, panel, n }) {
  return html`<${SidePanel} store=${store} tabs=${panel.tabs} tab=${panel.tab} counts=${{ links: n, mail: d?.mail?.length || 0 }}
    bodies=${{
      coordinator: () => html`<${CoordinatorPane} project=${project} store=${store} fromItemId=${item.id} />`,
      links: () => html`<div class="sp-links"><${LinksBody} item=${item} d=${d} store=${store} /></div>`,
      mail: () => html`<${MailPane} d=${d} store=${store} />`,
    }} />`;
}

/** Every mail an exchange holds, oldest first: what it sent mid-turn and the backstage after it. */
function mailLinesOf(x) {
  return x.events.filter((e) => e.kind === 'mail' || e.kind === 'backstage').flatMap((e) => e.lines || []).sort((a, b) => a.at - b.at);
}

/** "AB": a thread's initials, from its short name. */
function initialsOf(peer) {
  const words = String(peer || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

/** The threads in some mail, as small initials in each one's own color: who was talking to whom. */
function MailPeople({ peers, size = '' }) {
  return html`<span class=${`ml-people${size ? ` ${size}` : ''}`}>${peers.map((p) => html`<i style=${`--pc:${agentColor(p)}`} title=${p}>${initialsOf(p)}</i>`)}</span>`;
}

const peersOf = (lines) => [...new Set(lines.map((l) => l.peer))];
const countsOf = (lines) => {
  const into = lines.filter((l) => l.kind === 'in' || l.kind === 'reply').length;
  const out = lines.length - into;
  return [out ? `${out} sent` : null, into ? `${into} received` : null].filter(Boolean).join(', ');
};

/** One mail: who and when, what it said, and what came back. Tapping the peer opens that conversation. */
function MailLine({ line, store, full = false, showPeer = true }) {
  const arrow = line.kind === 'out' ? '→' : line.kind === 'started' ? 'started' : '←';
  const name = line.peerId && store.state.byId[line.peerId] ? html`<button class="ml-peer" onClick=${(e) => (e.stopPropagation(), store.openItem(line.peerId))}>${line.peer}</button>` : html`<b class="ml-peer">${line.peer}</b>`;
  // Spans only: the history's row styles (".rd-ex li > button/div") must not reach inside a folded line.
  const dir = line.kind === 'out' ? 'Sent' : line.kind === 'started' ? 'Started' : line.kind === 'reply' ? 'Answer' : 'Received';
  const when = `${age(line.at, store.state.now)} ago${line.inline ? ' · mid-turn' : ''}`;
  return html`<li class="ml-line"><span class="ml-head">${showPeer
      ? html`<${MailPeople} peers=${[line.peer]} size="sm" /> <span class="ml-dir">${arrow}</span> ${name}<span class="ml-when"> · ${when}</span>`
      : html`<span class="ml-when">${dir} · ${when}</span>`}</span>
    ${full ? html`<span class="ml-text md-wrap"><${Markdown} text=${line.text} store=${store} /></span>` : html`<span class="ml-text">${linked(line.headline)}</span>`}
    ${line.answer ? html`<span class="ml-ans">↳ ${line.answer}</span>` : null}</li>`;
}

export function MailDrafts({ d, store }) {
  if (!d?.mailDrafts?.length) return null;
  return html`<section aria-label="Mail awaiting approval"><h3>Messages awaiting your approval</h3>
    ${d.mailDrafts.map((draft) => html`<${DraftCard} key=${draft.id} draft=${draft} store=${store} onAction=${(action, text) => store.mailDraft(draft.id, action, text)} />`)}
  </section>`;
}

/** The Mail tab: every mail in this conversation, newest first, grouped by the other conversation. */
function MailPane({ d, store }) {
  const lines = [...(d?.mail || [])].reverse();
  if (!lines.length) return html`<${MailDrafts} d=${d} store=${store} />${d?.mailDrafts?.length ? null : html`<p class="note">No agent mail.</p>`}`;
  const groups = [];
  for (const line of lines) {
    const group = groups.find((g) => g.peer === line.peer);
    if (group) group.lines.push(line);
    else groups.push({ peer: line.peer, lines: [line] });
  }
  return html`<${MailDrafts} d=${d} store=${store} /><div class="sp-mail">${groups.map((g) => {
    const id = g.lines.find((l) => l.peerId && store.state.byId[l.peerId])?.peerId;
    return html`<section class="ml-group"><h4><${MailPeople} peers=${[g.peer]} /><span class="ml-g-t">${id ? html`<button class="ml-peer" onClick=${() => store.openItem(id)}>${g.peer}</button>` : g.peer}<small>${countsOf(g.lines)}</small></span></h4><ul class="ml">${g.lines.map((line) => html`<${MailLine} line=${line} store=${store} full=${true} showPeer=${false} />`)}</ul></section>`;
  })}</div>`;
}

/**
 * Mail, quietly: who (their initials), how much, and with whom, in the gray of a timestamp. Opens in
 * place; the Mail tab has all of it. `lead` prefixes the counts ("since your reply").
 */
function MailSummary({ lines, store, phone = false, lead = '' }) {
  const [open, setOpen] = useState(false);
  const peers = peersOf(lines);
  return html`<div class=${`ml-sum${open ? ' open' : ''}`}>
    <button class="ml-sum-h" aria-expanded=${open} title=${open ? 'Hide the mail' : 'Show the mail'} onClick=${(e) => (e.stopPropagation(), setOpen(!open))}>
      <${MailPeople} peers=${peers} />
      <span class="ml-sum-t">${lead ? `${lead}: ` : ''}${countsOf(lines)}<span class="ml-sum-n"> · ${peers.join(', ')}</span></span>
    </button>
    ${open
      ? html`<ul class="ml">${lines.map((line) => html`<${MailLine} line=${line} store=${store} />`)}</ul>
          <button class="ml-all" onClick=${(e) => (e.stopPropagation(), store.openSideTab('mail', { phone, docked: !phone && window.matchMedia?.(DOCK).matches !== false }))}>All of it in the Mail tab</button>`
      : null}
  </div>`;
}

/** The left panel's content: goal and milestone, then the exchanges. */
function ContextBody({ item, d, store, sheet = false }) {
  return html`<${GoalBlock} item=${item} />
    <section class="rd-block rd-hist"><h3 class="h4">How we got here</h3><${ExchangeList} exchanges=${exchangesOf(beatsOf(d))} messages=${d?.messages} item=${item} store=${store} sheet=${sheet} /></section>`;
}

// ── main column ─────────────────────────────────────────────────────

/**
 * The rule chips (decisions phase 3): how approving the recommendation counts. On a candidate "Always do this" is
 * preselected, so the recommended option stays one tap; pick another chip, or add a reason, before answering.
 */
export function BriefRule({ item, store, brief, pending = null }) {
  if (!brief.proposedRule || brief.tripwire || store.state.holds[item.id]) return null;
  const picked = store.briefRuleOf(item.id, pending);
  if (!picked) return null;
  return html`<div class="rd-brief-rule">
    <p><b class="bc-rule-k">${brief.precedentOf
      // D-61: a first approval is a precedent; the second similar one proposes the rule for both.
      ? `Proposes a rule (you approved a similar call, ${brief.precedentOf}):`
      : brief.candidate ? 'Counts toward a rule:' : 'Saves a rule only if you say Always:'}</b> ${brief.proposedRule}</p>
    <div class="rd-rule-row">
      <div class="sys-seg rd-rule-seg" role="group" aria-label="Make it a rule?">
        ${RULE_CHIPS.map(([key, label]) => html`<button aria-pressed=${picked.rule === key} onClick=${() => store.setBriefRule(item.id, { rule: key }, pending)}>${label}</button>`)}
      </div>
      <input class="rd-rule-why" maxlength="200" placeholder="Why? (optional; agents learn from it)" value=${picked.reason} onInput=${(e) => store.setBriefRule(item.id, { reason: e.target.value }, pending)} />
    </div>
  </div>`;
}

/** Only unanswered rule proposals belong in the conversation. */
function RuleProposals({ item, store }) {
  const open = pendingOf(item)?.brief?.id;
  const seen = new Set();
  return (item.facts?.rulesSaved || []).filter(saved => {
    if (saved.decisionId === open || saved.proposal?.state !== 'proposed') return false;
    const key = [...saved.proposal.from].sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(saved => html`<${AnswerRule} saved=${saved} store=${store} proposalOnly=${true} key=${saved.decisionId} />`);
}

/** What the item needs from the owner, or where it stands: an informational callout above the reply. */
function Needs({ item, store, asked = true }) {
  if (item.facts?.phoneNote) return html`<${PhoneNote} key=${item.facts.phoneNote.noteId} item=${item} />`;
  const status = item.status;
  const labels = { needs: 'Needs you', failed: 'Failed', stuck: 'Stuck', finished: 'Finished', working: 'Working', waiting: 'Waiting', idle: 'Idle', unknown: 'Unknown' };
  const key = status?.pill || 'unknown';
  const pending = pendingOf(item);
  // Why the pill, in gray beside it, only where it says something the pill doesn't (next/model.js statusWords). An
  // ask a brief card shows was read twice (owner, 10/21).
  const words = statusWords(item);
  const why = words.why;
  const ask = pending?.brief ? null : words.ask;
  if (pending?.brief) return html`<${BriefCard} key=${`${item.id}:${pending.brief.id}`} item=${item} store=${store} pending=${pending} status=${pending.brief.status || "open"} outcome=${pending.brief.outcome} rule=${html`<${BriefRule} item=${item} store=${store} brief=${pending.brief} />`} /><${CarriedBriefs} item=${item} store=${store} shown=${pending.brief.id} />`;
  if (key === 'needs' && pending) return html`<${BriefCard} item=${item} store=${store} summary=${item.summary?.gist} pending=${pending} /><${CarriedBriefs} item=${item} store=${store} />`;
  if (key === 'needs') return html`<${AskCard} key=${item.facts?.openAsk?.id || item.id} ask=${item.facts?.openAsk || { text: ask || 'Your input is needed', legacy: true }} itemId=${item.id} store=${store}/><${CarriedBriefs} item=${item} store=${store} />`;
  return html`<section class=${`rd-needs rd-status-card ${key}`}>
    <p class="rd-status"><span class=${`nx-pill ${key === 'needs' ? 'move' : key === 'waiting' ? 'watching' : key === 'stuck' ? 'failed' : key}`}>${labels[key]}</span>${why ? html` <span class="rd-status-why">${linked(why)}</span>` : null}</p>
    ${item.summary?.gist ? html`<p>${linked(item.summary.gist)}</p>` : null}
    <${CarriedBriefs} item=${item} store=${store} shown=${pending?.brief?.id ?? null} />
  </section>`;

}

/**
 * Other threads' briefs this conversation carries, beyond the one it shows as its own question: each in full,
 * labelled where it came from, answered on this row (the server sends the answer to the thread that raised it).
 */
function CarriedBriefs({ item, store, shown = null }) {
  const list = (item.facts?.carried || []).filter((c) => c.pending?.brief && c.pending.brief.id !== shown && !(c.counts && item.facts?.pending?.requestId === c.pending.requestId));
  if (!list.length) return null;
  return list.map((c) => {
    const shownAs = { ...c.pending, brief: { ...c.pending.brief, from: c.from } };
    return html`<${BriefCard} key=${`${item.id}:${shownAs.brief.id}`} item=${item} store=${store} pending=${shownAs} answer=${c.pending} rule=${html`<${BriefRule} item=${item} store=${store} brief=${shownAs.brief} pending=${c.pending} />`} />`;
  });
}

/** The owner's question, its answer, and the reports that followed it. */
export function ConversationStack({ window, item, d, store }) {
  const receipt = mergeOwnerReceipts(item.id, d, store.state.ownerReceipts).some(r => r.messageId === window.owner.messageId);
  const body = reply => html`<${Markdown} text=${reply.text} store=${store} /><${Thumbs} images=${reply.attachments} store=${store} />`;
  const when = at => html`<time datetime=${new Date(at).toISOString()}>${age(at, store.state.now)} ago</time>`;
  const folded = (replies, label) => replies?.length ? html`<details class="rd-report-updates">
    <summary>${label}</summary>
    ${replies.map(reply => html`<article key=${reply.messageIds.join(':')} class="rd-report-update">
      <div class="note">${when(reply.at)}</div>${body(reply)}
      ${folded(reply.notes, `${reply.notes?.length} notes while working`)}
    </article>`)}
  </details>` : null;
  const report = (reply, update = false) => reply ? html`<article class="rd-report rd-report-latest ${update ? 'rd-report-followup' : ''}">
    ${reply.text || reply.attachments?.length ? html`<div class="note rd-report-label"><span class="rd-report-agent">${agentName(item)}</span> · ${update ? 'update · ' : ''}${when(reply.at)}</div>${body(reply)}` : null}
    ${folded(reply.notes, `${reply.notes?.length} notes while working`)}
  </article>` : null;
  return html`<div class="rd-conversation-stack">
    ${receipt ? html`<${OwnerReceipts} item=${item} d=${d} store=${store} onlyMessageId=${window.owner.messageId} />` : html`<article class="rd-owner-receipt"><div class="note">You · ${when(window.owner.at)}</div><p style="white-space:pre-wrap;overflow-wrap:anywhere">${window.owner.text}</p></article>`}
    ${window.first && window.latest ? html`<details class="rd-report-updates rd-report-update">
      <summary>First answer · ${when(window.first.at)} · ${window.first.headline || window.first.text.split('\n')[0]}</summary>
      ${report(window.first)}
    </details>` : report(window.first)}
    ${window.updates.map(reply => report(reply, true))}
    ${report(window.latest, true)}
    ${folded(window.acks, html`${window.acks.length} short check-in${window.acks.length === 1 ? '' : 's'} since · ${window.acks.length ? when(window.acks.at(-1).at) : ''}`)}
    ${!window.first?.text && !window.first?.attachments?.length && !window.latest?.text && !window.latest?.attachments?.length ? html`<p class="note">No reply yet.</p>` : null}
  </div>`;
}

/** The latest reply in full, under one quiet line: when it came, how long the thread is, and one button for its links. */
function Reply({ item, d, store, onLinks }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const reply = replyOf(d);
  const n = linkCount(item, d);
  const now = store.state.now;
  const workingNotes = notes => notes?.length ? html`<details class="rd-report-updates">
      <summary>${notes.length} notes while working</summary>
      ${notes.map(note => html`<article key=${note.messageIds.join(':')} class="rd-report-update">
        <div class="note"><time datetime=${new Date(note.at).toISOString()}>${age(note.at, now)} ago</time></div>
        <${Markdown} text=${note.text} store=${store} /><${Thumbs} images=${note.attachments} store=${store} />
      </article>`)}
    </details>` : null;
  const started = d?.timeline?.[0]?.at ?? d?.messages?.[0]?.at;
  const meta = [
    reply ? html`<span>${agentName(item)} replied ${age(reply.at, now)} ago</span>` : null,
    item.messageCount ? html`<span>${item.messageCount} messages</span>` : null,
    started ? html`<span class="rd-started">started ${age(started, now)} ago</span>` : null,
  ].filter(Boolean);
  return html`<section class="rd-reply">
    <div class="rd-rh">
      <span class="note rd-meta">${meta}</span>
      ${n && onLinks ? html`<button class="pill rd-links" onClick=${onLinks} title="Links and screens">↗ ${linkLabel(item, d)}</button>` : null}
    </div>
    ${d?.sinceOwner ? html`<${ConversationStack} window=${d.sinceOwner} item=${item} d=${d} store=${store} />` : reply ? html`${reply.text ? html`<${Markdown} text=${reply.text} store=${store} />` : null}<${Thumbs} images=${reply.attachments} store=${store} />` : html`<p class="note">${d?.loading ? 'Loading…' : 'No reply yet.'}</p>`}
    ${!d?.sinceOwner ? workingNotes(reply?.notes) : null}
    ${!d?.sinceOwner && d?.laterNotes?.count ? html`<div class=${`ml-sum${notesOpen ? ' open' : ''}`}>
      <button class="ml-sum-h" aria-expanded=${notesOpen} onClick=${() => setNotesOpen(!notesOpen)}><span class="ml-sum-t">${d.laterNotes.count} later ${d.laterNotes.count === 1 ? 'note' : 'notes'}</span></button>
      ${notesOpen ? html`<div class="ml">${d.laterNotes.notes.map(note => html`<div><${Markdown} text=${note.text} store=${store} /><${Thumbs} images=${note.attachments} store=${store} />${workingNotes(note.notes)}</div>`)}</div>` : null}
    </div>` : null}
  </section>`;
}

// ── the reply box (typed or voice) ──────────────────────────────────

function ComposerActions({ item, store, live, view }) {
  if (item.disposition && item.disposition !== 'active') {
    return html`<div class="rd-acts">
      <span class="note">${item.disposition === 'done' ? 'Done' : item.disposition === 'parked' ? 'Parked' : 'Snoozed'}</span>
      <span class="spacer"></span>
      ${item.disposition === 'done'
        ? html`<button class="btn" onClick=${() => store.reopen(item.id)}>Reopen</button>`
        : html`<button class="btn" onClick=${() => store.pickup(item.id)}>Pick up</button>`}
    </div>`;
  }
  const typed = store.draftFor(item.id);
  const images = store.imagesFor(item.id);
  const reading = store.state.replyReading[item.id] || 0;
  const pending = store.state.draftPending;
  let send;
  if (live && view.canUndo) send = html`<button class="btn big pri" disabled=${!!pending} onClick=${() => store.draftCommand('cancel')}>Undo · ${view.undoSeconds}s</button>`;
  else if (live && view.canSend) send = html`<button class="btn big pri" disabled=${!!pending} onClick=${() => store.draftCommand('send')}>Send</button>`;
  else if (live) send = html`<button class="btn big pri" disabled title="Say “I’m done” to send">Send</button>`;
  else send = html`<${SendSplit} item=${item} store=${store} disabled=${reading || (!typed.trim() && !images.length)} label=${reading ? 'Adding image…' : null} />`;
  // Send is the primary action, so it sits bottom right; Snooze and Done live up on the metadata line.
  return html`<div class="rd-acts">
    ${!live ? html`<${AttachButton} item=${item} store=${store} />` : null}
    ${!live && item.replyable !== false && globalThis.navigator?.mediaDevices?.getUserMedia ? html`<${VoiceButton} item=${item} store=${store} />` : null}
    ${live && view.canCancel ? html`<button class="btn big ghost" disabled=${!!pending} onClick=${() => store.draftCommand('cancel')}>Discard</button>` : null}
    ${item.nextStep === 'failed' ? html`<button class="btn big" onClick=${() => store.retry(item.id)}>Retry</button>` : null}
    ${item.nextStep === 'working' && canStop(item) ? html`<button class="btn big" title="Stop the turn in progress; the thread stays open" onClick=${() => store.stop(item.id)}>Stop the turn</button>` : null}
    ${item.nextStep === 'working' && stuckMinutes(item, store.state.now) ? html`<button class="btn big" onClick=${() => store.nudge(item.id)}>Nudge</button>` : null}
    ${item.watching?.waitingOn?.who ? html`<button class="btn big" onClick=${() => store.nudgeWaiting(item.id)}>Nudge ${item.watching.waitingOn.who}</button>` : null}
    <span class="spacer"></span>
    ${send}
  </div>`;
}

/**
 * Send, split: the main tap sends in the remembered mode (back to the List, or stay on this thread);
 * the arrow switches the mode. ⌘↵ sends in the mode, ⌘⇧↵ the other way once.
 */
function SendSplit({ item, store, disabled, label }) {
  const stay = store.state.sendStay;
  const choose = (on) => (e) => {
    e.currentTarget.closest('details').open = false;
    store.setSendStay(on);
  };
  const mode = (on, text, hint) =>
    html`<button role="menuitemradio" aria-checked=${stay === on} onClick=${choose(on)}><b><i class="ck">${stay === on ? '✓' : ''}</i>${text}</b><span>${hint}</span></button>`;
  return html`<span class="split rd-send">
    <button class="btn big pri" disabled=${disabled} title=${stay ? 'Send and stay on this thread' : 'Send and go back to the list'} onClick=${() => { cancelVoiceEdit(item.id); store.sendReply(item.id); }}>
      ${label || (stay ? 'Send & stay' : 'Send')} <span class="kbd">⌘↵</span>
    </button>
    <details class="ddpill end up">
      <summary class="btn big pri caret" aria-label="Send options" title="After sending: go back to the list, or stay here">▾</summary>
      <div class="menu" role="menu">
        ${mode(false, 'Send', 'back to the list')}
        ${mode(true, 'Send & stay', 'keep this thread open')}
      </div>
    </details>
  </span>`;
}

/** The paperclip: picks images from the device (the photo library on a phone). */
function AttachButton({ item, store }) {
  const input = useRef(null);
  return html`<button class="ib rd-attach" aria-label="Attach images" title="Attach images (or paste, or drop them here)" onClick=${() => input.current?.click()}>${CLIP}</button>
    <input
      type="file"
      accept=${ACCEPT}
      multiple
      hidden
      ref=${input}
      onChange=${(e) => {
        store.addReplyImages(item.id, [...(e.currentTarget.files || [])]);
        e.currentTarget.value = '';
      }}
    />`;
}

const CLIP = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>`;

/**
 * Files dragged anywhere over the Conversation go into the reply's draft. Not while a voice draft
 * fills the box.
 */
function useDropToAttach(item, store, live) {
  return useFileDrop(
    (files) => {
      if (!item) return;
      store.addReplyImages(item.id, files);
      store.openReply(item.id);
    },
    { blocked: live || item?.replyable === false },
  );
}

/** A voice draft for this item fills the reply box (and the owner can't type or attach into it). */
function voiceDraft(state, item) {
  const card = item ? draftForItem(state.draft, item.id) : null;
  const view = card ? draftView(card, state.now) : null;
  return { card, view, live: !!view && (card.active || view.status === 'sent') };
}


function Composer({ item, store }) {
  const { state } = store;
  const { card, view, live } = voiceDraft(state, item);
  const area = useRef(null);
  const dock = useRef(null);
  const typed = store.draftFor(item.id);
  // The reply box grows with the draft up to its max, then scrolls (fitToContent covers browsers without field-sizing).
  useEffect(() => fitToContent(area.current), [typed, live]);
  useEffect(() => refitOnResize(area.current), [live]);
  // The column scrolls clear of the dock however tall it grows (pinned images, a long draft).
  useEffect(() => {
    const node = dock.current;
    if (!node || typeof ResizeObserver !== 'function') return undefined;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty('--dock-h', `${Math.ceil(node.getBoundingClientRect().height)}px`));
    observer.observe(node);
    return () => (observer.disconnect(), root.style.removeProperty('--dock-h'));
  }, []);
  // Opened with a mouse or trackpad, the cursor starts in the reply box (keyboard.js replyTakesFocus).
  useEffect(() => {
    const finePointer = !!globalThis.matchMedia?.('(pointer: fine)').matches;
    const root = document.documentElement;
    const keyboardMode = root.classList.contains('nx-kbd');
    if (area.current && !live && replyTakesFocus({ finePointer, keyboardMode, active: document.activeElement, lastPointer: root.dataset.lastPointer })) area.current.focus({ preventScroll: true });
  }, []);
  // "r" (or a Reply tap anywhere) puts the cursor in the reply box.
  useEffect(() => {
    if (state.replyOpen === item.id && area.current && !live) area.current.focus();
  }, [state.replyOpen, item.id, live]);
  // No runtime named: a coding thread's reply goes to its thread, a named agent's to the agent.
  const to = isCoding(item) ? 'in this thread' : `to ${agentName(item)}`;
  let body;
  if (live && view.compiled && ['confirm', 'sending', 'sent'].includes(view.status)) body = html`<${Markdown} text=${view.compiled} cls="rd-text" store=${store} />`;
  else if (live && view.empty) body = html`<p class="rd-text ph">Listening. Everything you say goes into this reply. Say “I’m done” to send it.</p>`;
  else if (live) body = html`<p class="rd-text">${view.earlier.map((f) => html`<span class="frag">${f} </span>`)}${view.newest ? html`<span class="frag newest">${view.newest}</span>` : null}</p>`;
  else
    body = html`<textarea
      ref=${area}
      class="rd-text"
      rows="2"
      aria-label=${`Reply ${to}`}
      placeholder=${state.operator.live ? 'Type a reply, or just start talking…' : `Reply ${to}…`}
      value=${typed}
      onPointerDown=${() => cancelVoiceEdit(item.id)}
      onInput=${(e) => { cancelVoiceEdit(item.id); store.setDraft(item.id, e.currentTarget.value); }}
      onPaste=${(e) => {
        const files = pastedFiles(e);
        if (!files.length) return;
        e.preventDefault();
        store.addReplyImages(item.id, files);
      }}
      onKeyDown=${(e) => {
        if (isSendKey(e)) {
          e.preventDefault();
          cancelVoiceEdit(item.id);
          store.sendReply(item.id, undefined, e.shiftKey ? { stay: !state.sendStay } : {});
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.currentTarget.blur();
          store.closeReply();
        }
      }}
    ></textarea>`;
  return html`<div class="rd-dock" ref=${dock}>
    <div class=${`rd-composer${live ? ' live' : ''}`} aria-live=${live ? 'polite' : null}>
      <div class="rd-ctop">
        <b>${live ? view.title.replace(/^Drafting for .*$/, 'Your reply') : 'Reply'}</b><span class="note rd-to">${to}</span>
        ${live && view.hint ? html`<span class="note rd-hint">${view.hint}</span>` : !live ? html`<span class="note rd-hint">⌘↵ to send · ⌘⇧↵ to ${state.sendStay ? 'send and go back' : 'send and stay'} · paste or drop images · Esc to leave</span>` : null}
      </div>
      ${!live
        ? html`<${Shelf}
            images=${store.imagesFor(item.id)}
            reading=${state.replyReading[item.id] || 0}
            onRemove=${(id) => store.removeReplyImage(item.id, id)}
            onOpen=${(i) => store.openLightbox(store.imagesFor(item.id).map((a) => ({ src: a.dataUrl, name: a.name })), i)}
          />`
        : null}
      ${body}
      ${live && view.question ? html`<p class="rd-q">${view.question}</p>` : null}
      <${ComposerActions} item=${item} store=${store} live=${live} view=${view} />
    </div>
  </div>`;
}

// ── modals / sheets ─────────────────────────────────────────────────

function Sheet({ store, title, sub, back, children, footer }) {
  return html`<div class="rd-scrim" onClick=${(e) => e.target === e.currentTarget && store.closeSheet()}>
    <div class="rd-modal" role="dialog" aria-modal="true" aria-label=${typeof title === 'string' ? title : 'Details'}>
      <header>
        ${back ? html`<button class="btn rd-back" aria-label="Back" onClick=${back}>‹</button>` : null}
        <div class="rd-mt"><h3>${title}</h3>${sub ? html`<div class="note">${sub}</div>` : null}</div>
        <button class="btn rd-x" onClick=${() => store.closeSheet()}>Close <span class="kbd">esc</span></button>
      </header>
      <div class="rd-mbody">${children}</div>
      ${footer ? html`<footer>${footer}</footer>` : null}
    </div>
  </div>`;
}

function ExchangeSheet({ item, d, store, exchanges }) {
  const { index, from } = store.state.sheet;
  const x = exchanges[index];
  if (!x) return null;
  const byId = new Map((d?.messages || []).map((m) => [m.messageId, m]));
  // Step to the nearest exchange that has a message to show.
  const step = (dir) => {
    for (let i = index + dir; i >= 0 && i < exchanges.length; i += dir) if (canOpen(exchanges[i])) return i;
    return -1;
  };
  const prev = step(-1);
  const next = step(1);
  const ask = askParts(x.ask);
  const answer = answerOf(x);
  const who = agentName(item);
  // The whole run of replies when it's loaded (short messages the beats skip included), else the beats.
  const run = replyMessages(exchanges, index, d?.messages);
  const replies = run ? run.map((m) => ({ at: m.at, messageId: m.messageId, headline: '' })) : x.replies;
  const missing = !run && exchangeMessageIds(x).some((id) => !byId.has(id));
  const part = (beat, name, cls) => {
    const m = beat.messageId ? byId.get(beat.messageId) : null;
    const text = m?.text && beat.mail ? mailBody(m.text) : m?.text;
    return html`<section class=${`rd-turn ${cls}${beat.mail ? ' mail' : ''}`}>
      <div class="rd-turn-h"><b>${name}</b><span class="note">${age(beat.at, store.state.now)} ago</span></div>
      ${m ? html`${text ? html`<${Markdown} text=${text} store=${store} />` : null}<${Thumbs} images=${m.attachments} store=${store} />` : html`<p class="md">${linked(beat.headline)}</p>`}
    </section>`;
  };
  return html`<${Sheet}
    store=${store}
    title=${ask?.text || answer?.headline || 'Exchange'}
    sub=${`${replies.length ? `${who} replied${replies.length > 1 ? ` ${replies.length} times` : ''}` : 'No reply yet'} · ${age(x.at, store.state.now)} ago`}
    back=${from === 'context' ? () => store.openSheet({ kind: 'context' }) : null}
    footer=${html`<button class="btn" disabled=${prev < 0} onClick=${() => store.openSheet({ kind: 'exchange', index: prev, from })}>← Earlier</button>
      <span class="spacer"></span>
      <button class="btn" disabled=${next < 0} onClick=${() => store.openSheet({ kind: 'exchange', index: next, from })}>Later →</button>`}
  >
    <div style=${`--c:${agentColor(item)}`}>
      ${x.ask ? part(x.ask, ask.who, 'you') : null}
      ${replies.map((r) => part(r, who, 'agent'))}
      ${x.events.filter((e) => e.kind !== 'backstage' && e.kind !== 'mail').map((e) => html`<p class=${`rd-turn-ev ${e.kind}`}>${linked(e.headline)} <span class="note">· ${age(e.at, store.state.now)} ago</span></p>`)}
      ${mailLinesOf(x).length ? html`<${MailSummary} lines=${mailLinesOf(x)} store=${store} phone=${true} />` : null}
      ${missing ? html`<p class="note">Part of this is no longer in the recent history; showing its headline.</p>` : null}
    </div>
  </${Sheet}>`;
}

function Sheets({ item, d, store }) {
  const sheet = store.state.sheet;
  if (!sheet || !item) return null;
  if (sheet.kind === 'exchange') return html`<${ExchangeSheet} item=${item} d=${d} store=${store} exchanges=${exchangesOf(beatsOf(d))} />`;
  if (sheet.kind === 'context') {
    return html`<${Sheet} store=${store} title="Goal and history" sub=${item.summary?.title || null}>
      <div class="rd-side in-sheet" ref=${(node) => scrollToLatest(node?.closest('.rd-mbody'), `context:${item.id}`, beatsOf(d).length)}><${ContextBody} item=${item} d=${d} store=${store} sheet=${true} /></div>
    </${Sheet}>`;
  }
  if (sheet.kind === 'links') {
    const project = projectOf(item, store.state.projects);
    const n = linkCount(item, d);
    const panel = panelTabs({ inProject: !!project && !project.finishedAt, links: n, mail: d?.mail?.length || 0, remembered: store.state.sideTab });
    if (panel.tabs.length < 2 && panel.tab === 'links') return html`<${Sheet} store=${store} title="Links and screens"><div class="rd-side in-sheet"><${LinksBody} item=${item} d=${d} store=${store} /></div></${Sheet}>`;
    return html`<${Sheet} store=${store} title=${project?.name || (panel.tab === 'mail' ? 'Agent mail' : 'Links and mail')}><div class="rd-side in-sheet sp-insheet"><${ConvoPanel} item=${item} d=${d} store=${store} project=${project} panel=${panel} n=${n} /></div></${Sheet}>`;
  }
  return null;
}

// ── layouts ─────────────────────────────────────────────────────────

/**
 * Whether the agent's reply answers your latest words: then they sit above its answer, in time order,
 * and Working on it below. Before its first word, the reply shown is the one you answered, so they follow it.
 */
export function answersLatest(item, reply) {
  const at = item?.facts?.lastOwnerRequest?.at ?? item?.lastOwnerMessageAt ?? null;
  return !!reply && at !== null && reply.at > at;
}

/** A thread whose source can stop its turn from the desk (Loom). */
export const canStop = (item) => item?.source === 'loom' && !!item.facts?.running;

/** Working or failed is the newest thing in the thread, so its callout sits under the reply it follows. */
const inFlight = (item) => item.nextStep === 'working' || item.nextStep === 'failed';

/**
 * Under the reply while it works: "Reply sent", Working on it (or It failed), then your queued words.
 * A reply you just sent scrolls it into view above the reply box, as a chat does, and again when that
 * reply lands in the queue; opening a working thread doesn't.
 */
function Latest({ item, d, store, asked = true }) {
  const ref = useRef(null);
  const sent = store.lastCommand(item.id, ['reply', 'answer']);
  const fresh = sent && store.state.now - sent.at < 60_000 ? `${sent.commandId}:${d?.queued?.length || 0}` : null;
  useEffect(() => {
    const node = ref.current;
    if (!fresh || !node || node.dataset.scrolled === String(fresh)) return;
    node.dataset.scrolled = fresh;
    node.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [fresh]);
  return html`<div class="rd-latest" ref=${ref}>
    <${CommandLine} item=${item} store=${store} />
    <${WritebackLine} item=${item} store=${store} />
    <${Needs} item=${item} store=${store} asked=${asked} />
    <${RuleProposals} item=${item} store=${store} />
    <${Queued} d=${d} store=${store} />
  </div>`;
}

/** Your words still waiting: sent while the agent works, read when it finishes its current step. */
function Queued({ d, store }) {
  const queued = d?.ownerReceipts !== undefined ? [] : d?.queued || [];
  if (!queued.length) return null;
  return html`<section class="rd-queued" aria-label="Queued">
    <h3 class="h4">${store.state.voiceFocusItem === d?.item?.id ? 'Sent · starts shortly' : 'Queued'} <span class="note">· it reads ${queued.length === 1 ? 'this' : 'these'} when it finishes its current step</span></h3>
    <ol>${queued.map((q) => html`<li key=${q.messageId}><span>${q.text}</span><small class="note">${age(q.at, store.state.now)} ago</small></li>`)}</ol>
  </section>`;
}

/** What happened backstage since the latest reply to you: one line; open it, or the Mail tab. */
function Backstage({ d, store, phone = false }) {
  const b = d?.backstage;
  if (!b?.lines?.length) return null;
  return html`<section class="rd-backstage"><${MailSummary} lines=${b.lines} store=${store} phone=${phone} lead="Since this reply" /></section>`;
}

/** The sidebar opens scrolled to the newest beat, once per item (and again when a beat arrives). */
function scrollToLatest(node, id, count) {
  if (!node) return;
  const key = `${id}:${count}`;
  if (node.dataset.scrolled === key) return;
  node.dataset.scrolled = key;
  requestAnimationFrame(() => (node.scrollTop = node.scrollHeight));
}

export { DOCK_QUERY } from './coordinator.js';

// The next layout's thread page (next/thread.js) builds on these same pieces.
export { currentItem, linkCount, beatsOf, inFlight, Latest, Needs, RuleProposals, Reply, Queued, Backstage, Composer, Sheets, ContextBody, LinksBody, MailPane, useDropToAttach, voiceDraft };
