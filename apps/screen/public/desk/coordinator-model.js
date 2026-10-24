// What the coordinator panel shows, as plain functions (desk-coordinator-ui tests): the answer's
// markdown with conversation chips, the timeline of questions, answers, drafts and digests, and the
// side panel's tabs.

import { renderMarkdown } from './md.js';
import { liveState } from './list-model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ESC[c]);

/** The state colors a chip's dot takes (the List's live states). */
export const CHIP_COLORS = { needs: 'var(--move)', failed: 'var(--danger)', working: 'var(--working)', watching: 'var(--watching)', held: 'var(--watching)', ready: 'var(--fyi)', sent: 'var(--muted)' };

const DESK_LINK = /\[([^\]\n]{1,120})\]\(desk:([A-Za-z0-9:._-]{1,200})\)/g;

/**
 * Markdown from the coordinator: `[title](desk:<itemId>)` links become chips (the label escaped: it is
 * taken out before renderMarkdown escapes the rest; Codex review on #545) that open the conversation
 * (`data-item`), dotted with its live state when the desk has it. The rest is the usual safe markdown.
 */
export function coordinatorMarkdown(text, lookup = () => null, now = Date.now()) {
  const chips = [];
  const marked = String(text ?? '').replace(DESK_LINK, (_, label, id) => `\u0001${chips.push({ label, id }) - 1}\u0001`);
  return renderMarkdown(marked).replace(/\u0001(\d+)\u0001/g, (_, i) => {
    const { label, id } = chips[Number(i)];
    const item = lookup(id);
    const color = item ? CHIP_COLORS[liveState(item, now)] || 'var(--muted)' : 'var(--dim)';
    return `<button type="button" class="cchip" data-item="${escape(id)}" style="--c:${color}" title="Open this conversation"><i></i>${escape(label)}</button>`;
  });
}

/**
 * One timeline, oldest first: the thread's questions, answers and relayed answers, the drafted questions
 * and the morning digests. Questions the owner just asked (not in the thread yet) come last.
 */
export function coordinatorTimeline(view, pending = []) {
  const entries = [];
  for (const m of view?.messages || []) entries.push({ key: `m:${m.id}`, kind: m.kind, at: m.at, text: m.text, streaming: !!m.streaming, fromItemId: m.fromItemId || null });
  for (const d of view?.drafts || []) entries.push({ key: `d:${d.id}`, kind: 'draft', at: d.createdAt, draft: d });
  for (const g of view?.digests || []) entries.push({ key: `g:${g.at}`, kind: 'digest', at: g.at, text: g.text });
  entries.sort((a, b) => a.at - b.at);
  for (const p of pending) entries.push({ key: `p:${p.at}`, kind: 'question', at: p.at, text: p.text, pending: true, failed: p.failed || null, commandId: p.commandId || null, fromItemId: p.fromItemId || null });
  return entries;
}

/** Questions the owner asked that the thread now has: dropped from the pending ones (a failed one stays, to retry). */
export function stillPending(pending, view) {
  const asked = (view?.messages || []).filter((m) => m.kind === 'question');
  return pending.filter((p) => p.failed || !asked.some((m) => m.text.trim() === p.text.trim() && m.at >= p.at - 120_000));
}

/** The words for a drafted question's state. */
export const DRAFT_WORDS = {
  draft: 'Draft · nothing is sent until you send it',
  queued: 'Waiting for it to be idle, then it’s sent',
  sending: 'Sending…',
  sent: 'Sent · waiting for its answer, which comes back here',
  answered: 'Answered',
  unanswered: 'No answer after three days',
  dropped: 'Not sent',
};

/**
 * The side panel's tabs: Coordinator when the conversation (or the page) is in a project, Links when
 * there are any (always on a project page). The remembered tab when it's there, else the first.
 */
export function panelTabs({ inProject, links, mail = 0, projectPage = false, remembered = null }) {
  const tabs = [];
  if (inProject) tabs.push('coordinator');
  if (links > 0 || projectPage) tabs.push('links');
  // Agent mail: what this conversation and others' said to each other, out of the conversation itself.
  if (mail > 0 && !projectPage) tabs.push('mail');
  const tab = tabs.includes(remembered) ? remembered : tabs[0] || null;
  return { tabs, tab };
}

/** Every link the project's conversations produced, newest conversation first, without repeats. */
export function projectLinks(items) {
  const seen = new Set();
  const groups = [];
  for (const item of [...items].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
    const links = (item.artifacts || []).filter((a) => a.url && !seen.has(a.url) && seen.add(a.url));
    if (links.length) groups.push({ item, links });
  }
  return groups;
}
