import { VoiceButton, cancelVoiceEdit } from './voice.js';
import { doneLabel } from './query-identity.js';
// A thread's atoms: avatar, ticker, setup stages, the beat line, a pending request and its answers,
// and the command and write-back lines.

import { html } from '../vendor/preact-htm.js';
import { PREDICTED } from './optimistic.js';
import { optionRow } from './brief-model.js';
import { linked } from './decision-links.js';
import { allowsOther, answeredCount, approvalTone, canDismiss, isOneTap, isPicked, isRecommended, pendingOf, questionChanged } from './pending.js';
import { agentColor, deliveryUnknown, optionsOf, writebackFailed, agentName, clockTime, inFlightOf, lastLifeAt, runningJob, waitAge, waitingOn, secondsAgo, stuckMinutes } from './util.js';

export function Avatar({ item, lg }) {
  const name = agentName(item);
  return html`<span class=${`av${lg ? ' lg' : ''}`} style=${`--c:${agentColor(item)}`} aria-hidden="true">${name.length <= 2 ? name : name[0]}</span>`;
}

function stop(event) {
  event.stopPropagation();
}

/** The live activity line; re-keyed per line so each new one slides in. */
export function Ticker({ text, tone }) {
  if (!text) return null;
  return html`<div class=${`ticker${tone ? ' ' + tone : ''}`} aria-live="polite"><div class="tl" key=${text}>${text}</div></div>`;
}

const SETUP_STAGES = { fetch: 'Fetch base', checkout: 'Check out', submodules: 'Submodules', 'setup-script': 'Setup script', agent: 'Start agent' };

/** A new thread's worktree setup, stage by stage (Start work); Loom's own setup card, on the desk. */
export function SetupStages({ setup, now }) {
  const stages = (setup.stages || []).filter((stage) => stage.status !== 'skipped');
  return html`<div class="beat setup" aria-label="Worktree setup">
    <span class="hb"></span><span>Setting up the worktree${setup.startedAt ? ` · started ${secondsAgo(setup.startedAt, now)}` : ''}</span>
    <span class="setup-stages">${stages.map((stage) => html`<span class=${`stage ${stage.status}`}>${stage.status === 'done' ? '✓ ' : stage.status === 'failed' ? '✕ ' : ''}${SETUP_STAGES[stage.id] || stage.id}${stage.status === 'running' && stage.percent != null ? ` ${Math.round(stage.percent)}%` : ''}</span>`)}</span>
  </div>`;
}

/**
 * What is in flight behind the thread, one line each: what it is doing, for how long, when a wait gives
 * up, and a wait whose checks are failing. Nothing in flight: nothing shown.
 */
export function InFlightList({ item, now }) {
  const all = inFlightOf(item);
  if (!all.length) return null;
  return html`<ul class="inflight" aria-label="In flight">
    ${all.map((e, i) => html`<li key=${i}>
      <b>${e.verb}</b> ${e.url ? html`<a href=${e.url} target="_blank" rel="noopener" onClick=${(event) => event.stopPropagation()}>${e.text}</a>` : html`<span>${e.text}</span>`}
      <small>${[e.since ? waitAge(e.since, now) : null, e.until ? (e.until < now ? `gave up at ${clockTime(e.until)}` : `gives up ${clockTime(e.until)}`) : null].filter(Boolean).join(' · ')}</small>
      ${e.error ? html`<span class="warn">last check failed: ${e.error}</span>` : null}
    </li>`)}
  </ul>`;
}

export function Beat({ item, now }) {
  if (item.nextStep === 'working' && item.facts?.setup?.phase === 'running') return html`<${SetupStages} setup=${item.facts.setup} now=${now} />`;
  if (item.nextStep === 'working') {
    const stuck = stuckMinutes(item, now);
    const at = lastLifeAt(item);
    if (stuck) {
      return html`<div class="beat stall"><span class="hb"></span><span class="warn">No activity for ${stuck} min</span>${at ? html`<span> · the same step since ${clockTime(at)}</span>` : null}</div>`;
    }
    const approach = item.facts?.approach;
    return html`<div class="beat"><span class="hb"></span>${at ? `Active ${secondsAgo(at, now)}` : 'Working'}${approach ? ` · approach: ${approach}` : ''}</div>`;
  }
  if (item.nextStep === 'watching' && waitingOn(item)) {
    const w = waitingOn(item);
    return html`<div class="beat watch"><span class="hb"></span>${w.what || `Waiting on ${w.who}`}${w.since ? ` · ${waitAge(w.since, now)}` : ''}</div>`;
  }
  if (item.nextStep === 'watching') {
    const next = item.watching?.nextCheckAt || (item.summary?.watchUntil ? Date.parse(item.summary.watchUntil) : null);
    const job = runningJob(item);
    const parts = [];
    if (next) parts.push(`Next check ${clockTime(next)}`);
    if (job) parts.push(`background job “${job.label || job.id}” running`);
    if (!parts.length) parts.push('Waiting for an update');
    return html`<div class="beat watch"><span class="hb"></span>${parts.join(' · ')}</div>`;
  }
  if (item.nextStep === 'failed') {
    const good = item.facts?.lastGoodStep;
    return good ? html`<div class="beat stall fail"><span class="hb"></span>Last good step: ${good}</div>` : null;
  }
  return null;
}

/** An answer tapped and on its way: what was picked, in place of the chips. */
function Hold({ hold }) {
  return html`<div class="hold sent" role="status"><span>✓ Sent “${hold.option}”</span></div>`;
}

/**
 * A brief's option as a full-width row (TGO-1080, R-12): its key, its words, whether it's recommended or the default
 * that runs without an answer, and its whole consequence, never cut off. One tap answers, as a chip does.
 */
export function BriefOption({ option, brief, index, picked, onClick, disabled = false, readOnly = false }) {
  const row = optionRow(option, brief, index);
  const Tag = readOnly ? 'div' : 'button';
  return html`<${Tag}
    disabled=${!readOnly && disabled}
    class=${`pq-chip bc-opt${picked ? ' on' : ''}${row.recommended ? ' rec' : ''}`}
    aria-pressed=${readOnly ? undefined : picked ? 'true' : 'false'}
    onClick=${readOnly ? undefined : (e) => (stop(e), e.target?.closest?.('a') ? null : onClick())}
  >
    <span class="bc-key">${row.key || '•'}</span>
    <span class="pq-label">${linked(row.title)}${readOnly && picked ? ' · ✓ Chosen' : ''}</span>
    ${row.recommended || row.isDefault ? html`<span class="bc-rec">${row.recommended ? '★ Recommended' : ''}${row.recommended && row.isDefault ? ' · ' : ''}${row.isDefault ? "goes ahead if you don't answer" : ''}</span>` : null}
    ${row.consequence ? html`<span class="pq-desc">${linked(row.consequence)}</span>` : null}
  </${Tag}>`;
}

/** One option chip of a Loom question: the label, its description on hover (and inline when `big`). */
function OptionChip({ option, picked, multi, big, onClick, brief = null, index = null }) {
  if (big && brief && !multi) return html`<${BriefOption} option=${option} brief=${brief} index=${index} picked=${picked} onClick=${onClick} />`;
  const rec = isRecommended(option.label);
  return html`<button
    class=${`pq-chip${picked ? ' on' : ''}${rec ? ' rec' : ''}${big && option.description ? ' wide' : ''}`}
    aria-pressed=${picked ? 'true' : 'false'}
    title=${option.description || ''}
    onClick=${(e) => (stop(e), onClick())}
  >
    ${multi ? html`<span class="pq-box" aria-hidden="true">${picked ? '☑' : '☐'}</span>` : null}
    <span class="pq-label">${option.label}</span>
    ${big && option.description ? html`<span class="pq-desc">${option.description}</span>` : null}
  </button>`;
}

/** The options' descriptions, folded (cards; on a phone this is the long-press stand-in). */
function OptionNotes({ question }) {
  const notes = question.options.filter((option) => option.description);
  if (!notes.length) return null;
  return html`<details class="pq-more" onClick=${stop}>
    <summary>What the options mean</summary>
    <dl>${notes.map((option) => html`<dt>${option.label}</dt><dd>${option.description}</dd>`)}</dl>
  </details>`;
}

function OtherAnswer({ item, store, question, draft, oneTap, shown = null }) {
  if (!allowsOther(question)) return null;
  const open = !!draft.otherOpen[question.id];
  const value = draft.other[question.id] || '';
  const voiceId = JSON.stringify(['other', item.id, (shown || pendingOf(item))?.requestId, question.id]);
  if (!open) return html`<button class="pq-chip ghost" onClick=${(e) => (stop(e), store.pendingToggleOther(item.id, question.id, shown))}>Other…</button>`;
  const send = (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelVoiceEdit(voiceId);
    if (oneTap && value.trim()) store.answerPending(item.id, question.id, value.trim(), shown);
  };
  return html`<form class="pq-other" onSubmit=${send} onClick=${stop}>
    <input
      type="text"
      aria-label=${`Your own answer: ${question.header || question.question}`}
      placeholder="Your own answer…"
      value=${value}
      ref=${(node) => node && !node.dataset.focused && (node.focus(), (node.dataset.focused = '1'))}
      onClick=${() => cancelVoiceEdit(voiceId)}
      onInput=${(e) => { cancelVoiceEdit(voiceId); store.pendingOther(item.id, question.id, e.currentTarget.value, shown); }}
      onKeyDown=${(e) => e.key === 'Escape' && (e.stopPropagation(), cancelVoiceEdit(voiceId), store.pendingToggleOther(item.id, question.id, shown))}
    />
    <${VoiceButton} key=${voiceId} item=${item} store=${store} dictation=${{ id: voiceId, value, onTranscript: text => store.pendingOther(item.id, question.id, text, shown) }} />
    ${oneTap ? html`<button type="submit" class="btn sm pri" disabled=${!value.trim()}>Send</button>` : null}
  </form>`;
}

/**
 * A Loom thread waiting on the owner: every question with its header, option chips (descriptions on
 * hover, folded below, inline in the Conversation view), multi-select toggles, an "Other…" answer,
 * and one Submit once all are answered. One single-select question keeps one-tap chips. Approvals
 * get a chip per offered decision (warnings shown). A tap sends at once.
 */
export function PendingRequest({ item, store, big, pending = null }) {
  // `pending`: a brief this row carries from another thread, answered as itself (not the row's own question).
  const p = pending || pendingOf(item);
  const held = store.state.holds[item.id];
  if (held) return html`<${Hold} hold=${held} />`;
  if (!p) return null;
  if (!p.requestId) return html`<p class="note pq-note">Answer this one in Loom: the desk didn’t get its request id.</p>`;
  const failedNote = p.failed ? html`<div class="cmd failed pq-failed" role="alert">Loom didn’t take that answer: ${p.failed.message} · answer again</div>` : null;
  if (p.kind === 'approval') {
    return html`<div class=${`pq${big ? ' big' : ''}`} onClick=${stop}>
      ${failedNote}
      <div class="qr pq-chips">
        ${p.approval.options.map(
          (option) => html`<button class=${`pq-chip ${approvalTone(option.decision)}${option.warning ? ' stack' : ''}`} title=${option.warning || ''} onClick=${(e) => (stop(e), store.approve(item.id, option))}>
            <span class="pq-label">${option.label}</span>${option.warning ? html`<span class="pq-warn">⚠ ${option.warning}</span>` : null}
          </button>`,
        )}
      </div>
    </div>`;
  }
  const draft = store.pendingDraft(item.id, pending);
  const oneTap = isOneTap(p);
  const answered = answeredCount(p, draft);
  const complete = answered === p.questions.length;
  return html`<div class=${`pq${big ? ' big' : ''}`} onClick=${stop}>
    ${failedNote}
    ${p.questions.map(
      (question) => html`<fieldset class="pq-q" key=${question.id}>
        <legend>
          ${question.header && !(big && p.brief) ? html`<span class="pq-h">${question.header}</span>` : null}
          ${big && p.questions.length === 1 ? null : html`<span class="pq-text">${question.question}</span>`}
          ${question.multiSelect ? html`<span class="pq-multi">pick any</span>` : null}
        </legend>
        <div class=${`pq-chips${big && p.brief ? ' bc-opts' : ''}`}>
          ${question.options.map(
            (option, index) => html`<${OptionChip}
              option=${option}
              big=${big}
              brief=${p.brief || null}
              index=${index}
              multi=${question.multiSelect}
              picked=${!oneTap && isPicked(draft, question.id, option.label)}
              onClick=${() => (oneTap ? store.answerPending(item.id, question.id, option.label, pending) : store.pendingPick(item.id, question, option.label))}
            />`,
          )}
          <${OtherAnswer} item=${item} store=${store} question=${question} draft=${draft} oneTap=${oneTap} shown=${pending} />
        </div>
        ${big ? null : html`<${OptionNotes} question=${question} />`}
      </fieldset>`,
    )}
    ${!oneTap || canDismiss(p) ? html`<div class="pq-foot">
      ${oneTap
        ? null
        : html`<button class="btn sm pri" disabled=${!complete} onClick=${(e) => (stop(e), store.submitPending(item.id))}>
            ${complete ? 'Submit' : `Submit · ${answered} of ${p.questions.length} answered`}
          </button>`}
      <span class="spacer"></span>
      ${canDismiss(p)
        ? html`<button class="btn sm ghost" title="Dismiss the question without answering" onClick=${(e) => (stop(e), store.dismissPending(item.id))}>Dismiss</button>`
        : null}
    </div>` : null}
  </div>`;
}

/** Answer chips (only when the agent spelled out options), sent on tap. A pending Loom request gets its full form. */
export function Answers({ item, store, big, pending = null }) {
  if (pending || pendingOf(item)) return html`<${PendingRequest} item=${item} store=${store} big=${big} pending=${pending} />`;
  const options = optionsOf(item);
  const hold = store.state.holds[item.id];
  if (hold) return html`<${Hold} hold=${hold} />`;
  if (!options.length || item.nextStep !== 'your_move') return null;
  return html`<div class=${`qr${big ? ' big' : ''}`}>
    ${options.slice(0, 6).map(
      (option, i) => html`<button onClick=${(e) => (stop(e), store.answer(item.id, option))} title=${i < 3 ? `Press ${i + 1}` : ''}>${option}</button>`,
    )}
  </div>`;
}

const PENDING_TEXT = { undo: 'Undoing…' };
const SENT_TEXT = { reply: 'Reply sent', answer: 'Answer sent', respond: 'Answer sent', approve: 'Approval sent', dismiss: 'Question dismissed', retry: 'Retry sent', seen: 'Marked seen' };
const Loom_ANSWER = { respond: 'Answer', approve: 'Approval', dismiss: 'Dismiss' };

/** pending → sent → failed for the latest command on this item. */
export function CommandLine({ item, store }) {
  const c = store.lastCommand(item.id);
  if (!c || (c.type === 'reply' && store.state.ownerReceipts !== undefined)) return null;
  // A predicted command already shows its effect (optimistic.js): no spinner for it; a failure still lands here and as a toast.
  if (c.status === 'pending') return PREDICTED.has(c.type) ? null : html`<div class="cmd pending" role="status"><span class="spin"></span>${PENDING_TEXT[c.type] || 'Sending…'}</div>`;
  if (c.status === 'sent') return SENT_TEXT[c.type] ? html`<div class="cmd sent" role="status">✓ ${SENT_TEXT[c.type]}</div>` : null;
  if (deliveryUnknown(c) && (c.type === 'reply' || c.type === 'answer' || c.type === 'retry')) {
    // The bot didn't confirm in time: it may have gone out. Don't invite a blind resend.
    return html`<div class="cmd unknown" role="alert">
      <span>May have sent: ${agentName(item)} didn’t confirm in time. Check the conversation before sending again${c.type === 'reply' ? ' · your draft is kept' : ''}.</span>
      ${c.type === 'reply' ? html`<button class="btn sm ghost" onClick=${(e) => (stop(e), store.openReply(item.id))}>Review draft</button>` : null}
    </div>`;
  }
  if (Loom_ANSWER[c.type]) {
    // The question moved on (answered in Loom, or a new one): pick again; a retry would only fail again.
    const changed = questionChanged(c);
    return html`<div class="cmd failed" role="alert">
      <span>${Loom_ANSWER[c.type]} didn’t go through: ${c.error || 'unknown error'}${changed ? ' · pick again from what Loom asks now' : c.type === 'respond' ? ' · your picks are kept' : ''}</span>
      ${changed ? null : html`<button class="btn sm" onClick=${(e) => (stop(e), store.retryCommand(c))}>Retry</button>`}
    </div>`;
  }
  return html`<div class="cmd failed" role="alert">
    <span>${c.type === 'reply' ? 'Reply didn’t send' : `${c.type[0].toUpperCase()}${c.type.slice(1)} didn’t go through`}: ${c.error || 'unknown error'}${c.type === 'reply' ? ' · your draft is kept' : ''}</span>
    <button class="btn sm" onClick=${(e) => (stop(e), c.type === 'reply' ? store.openReply(item.id) : store.retryCommand(c))}>${c.type === 'reply' ? 'Edit & resend' : 'Retry'}</button>
  </div>`;
}

export function WritebackLine({ item, store }) {
  if (!writebackFailed(item) || item.disposition !== 'done') return null;
  return html`<div class="cmd failed" role="alert">
    <span>${doneLabel(item) === 'Clear' ? 'Cleared' : 'Done'} here, but the write-back failed: ${item.writeback.error || 'unknown error'}</span>
    <button class="btn sm" onClick=${(e) => (stop(e), store.sendDone(item.id))}>Retry</button>
  </div>`;
}

