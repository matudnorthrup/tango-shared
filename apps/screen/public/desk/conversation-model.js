// The Conversation view's history as exchanges: each thing the owner said (or a wait Loom woke the
// agent for), paired with what the agent said back. The server sends "How we got here" as a flat list of beats (owner, agent, ok,
// fail); an agent beat answers the owner beat before it, and a desk event (Done, Snoozed, a
// failed write-back) belongs to the exchange it happened in.

/**
 * Beats → exchanges, oldest first: { ask, replies, events, at, index }. `ask` is the owner beat
 * (null for what the agent said before the owner's first message); `replies` the agent beats that
 * answered it; `events` the desk's own beats in between. `at` is when the exchange last moved.
 */
export function exchangesOf(beats) {
  const out = [];
  let cur = null;
  const start = (ask) => {
    cur = { ask, replies: [], events: [], at: ask?.at ?? 0, index: out.length };
    out.push(cur);
  };
  for (const beat of beats || []) {
    if (beat.kind === 'owner' || beat.kind === 'wake') start(beat);
    else {
      if (!cur) start(null);
      (beat.kind === 'agent' ? cur.replies : cur.events).push(beat);
    }
    cur.at = Math.max(cur.at, beat.at || 0);
  }
  return out;
}

/** The reply that stands for the exchange: its last agent beat (where the run ended up). */
export function answerOf(exchange) {
  return exchange.replies.length ? exchange.replies[exchange.replies.length - 1] : null;
}

/** The message ids the exchange's sheet shows, in order: what the owner said, then every reply. */
export function exchangeMessageIds(exchange) {
  return [exchange.ask?.messageId, ...exchange.replies.map((b) => b.messageId)].filter(Boolean);
}

/** True when the exchange has something to open (a message behind it). */
export function canOpen(exchange) {
  return exchangeMessageIds(exchange).length > 0;
}

/**
 * The calls listed under "It needs a call from you": the summary's questions only while that summary
 * covers the newest words and agrees it is the owner's move; else the ask the step was decided on
 * (a recorded ask, a "Next — you" line, a PR review). Live 10/18: the heading came from one source and
 * the list from an older or truncated summary, so the two disagreed.
 */
export function callsOf(item) {
  const s = item?.summary || {};
  const current = (s.contentKey ?? '') === (item?.facts?.contentKey ?? '');
  if (current && s.step === 'your_move' && s.questions?.length) return s.questions;
  const ask = item?.ask ?? (current && s.step === 'your_move' ? s.ask : null) ?? null;
  return ask ? [{ q: ask, lean: null }] : [];
}

/**
 * Who spoke and what, for the owner's side. Only the desk's own beats (no message behind them) carry
 * a "You answered:" prefix to strip; a real message is shown as the owner wrote it (Codex review on #493).
 */
export function askParts(ask) {
  if (!ask) return null;
  if (ask.kind === 'wake') return { who: '⏰ Loom', text: ask.headline };
  // Desk mail: another conversation wrote, or answered this one's mail.
  if (ask.mail) return { who: ask.mail.kind === 'reply' ? `✉️ Reply from ${ask.mail.title}` : `✉️ Mail from ${ask.mail.title}`, text: ask.headline, mail: ask.mail };
  const m = ask.messageId ? null : /^You( answered)?:\s*/.exec(ask.headline);
  return { who: m?.[1] ? 'You answered' : 'You', text: m ? ask.headline.slice(m[0].length) : ask.headline };
}

/**
 * Every agent message that answered exchange `index`, from the loaded messages: the whole run, not just
 * the beats (the server keeps only a run's last message and long ones as beats; Codex review on #493).
 * Between this exchange's owner message and the next one's. Null when the run isn't in the loaded
 * window, so the caller falls back to the beats.
 */
export function replyMessages(exchanges, index, messages) {
  const x = exchanges[index];
  if (!x || !messages?.length) return null;
  const from = x.ask?.at ?? -Infinity;
  const nextAsk = exchanges.slice(index + 1).find((e) => e.ask)?.ask;
  // Mail after the exchange (a backstage line) and what was said back to it aren't replies to the owner.
  const backstage = x.events.filter((e) => e.kind === 'backstage' && e.lines?.length).map((e) => e.lines[0].at);
  const to = Math.min(nextAsk?.at ?? Infinity, ...backstage);
  const run = messages.filter((m) => m.author === 'agent' && m.text?.trim() && m.at > from && m.at < to);
  // A window that starts after the owner's message may hold only the end of the run; and it must hold every beat.
  if (x.ask?.messageId && !messages.some((m) => m.messageId === x.ask.messageId)) return null;
  const ids = new Set(run.map((m) => m.messageId));
  return x.replies.every((b) => !b.messageId || ids.has(b.messageId)) ? run : null;
}

/** A desk mail turn's words without its header line and the footer the desk adds for the agent. */
export function mailBody(text) {
  // The header line, and at most one line a relay put ahead of it.
  const head = /^(?:[^\n]*\n)?✉️ [^\n]*\n?/u;
  if (!head.test((text || '').trimStart())) return text;
  return text.trimStart().replace(head, '').replace(/\n+— (Sent through the desk|This answers your mail)[\s\S]*$/u, '').trim();
}
