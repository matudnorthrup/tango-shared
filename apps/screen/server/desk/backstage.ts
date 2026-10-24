import { textSummary } from '../inbox-summarize.js';
import { parseMailHeader, SPEAK_FOR_MARK } from './mail.js';
import type { DeskMessage, MessageMail } from './types.js';

// The owner's conversation and the agents' mail, told apart (desk mail and native messages alike).
//
// A conversation's messages split into turns by what opened them: the owner's own words, or mail that
// started a turn of its own (another agent wrote while this one was idle, or an answer to its mail
// came back), or Loom waking it (a wait it set came due: no message opens that turn, its words say so). Everything the agent said until the next opener belongs to that turn. Mail read mid-turn
// and notes of mail this one sent are markers inside whatever turn they happened in.
//
// The Conversation view then shows the owner's turns as the conversation, folds each run of mail turns
// into one backstage line, and keeps "the latest reply" the latest reply to the owner.

/** The mail a message is, if any: from what the source said, else from a desk mail header. */
export function mailOf(message: Pick<DeskMessage, 'author' | 'text' | 'meta'>): MessageMail | null {
  if (message.author === 'agent') return null;
  if (message.meta?.mail) return message.meta.mail;
  const header = parseMailHeader(message.text);
  if (!header) return null;
  return { kind: header.kind === 'from' ? 'in' : header.kind === 'to' ? 'out' : header.kind, peer: header.title, peerId: header.itemId, mailId: header.mailId };
}

/** The words of a mail message, without the desk's header line and footer. */
export function mailBodyOf(message: Pick<DeskMessage, 'text'>): string {
  return parseMailHeader(message.text)?.body ?? message.text.trim();
}

export interface Turn {
  /** What opened it: the owner, mail that started a turn, Loom waking it, or nothing (the agent spoke first). */
  opener: 'you' | 'mail' | 'wake' | 'none';
  open: DeskMessage | null;
  mail: MessageMail | null;
  /** A wake turn: the run, and the note the agent left with its wait. */
  wake?: { run: string; note?: string | null; cause?: 'trigger' | 'corrective'; answersRun?: string };
  /** What the agent said in it. */
  replies: DeskMessage[];
  /** Mail read mid-turn, and notes of mail this conversation sent, in this turn. */
  markers: Array<{ message: DeskMessage; mail: MessageMail }>;
}

/** Opens a turn of its own: mail in or an answer back, unless it was read mid-turn. */
const opensTurn = (mail: MessageMail) => (mail.kind === 'in' || mail.kind === 'reply') && !mail.inline;

export function turnsOf(messages: DeskMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const wakesOpened = new Set<string>();
  const start = (opener: Turn['opener'], open: DeskMessage | null, mail: MessageMail | null, wake?: Turn['wake']) => {
    current = { opener, open, mail, replies: [], markers: [], ...(wake ? { wake } : {}) };
    turns.push(current);
    return current;
  };
  for (const message of [...messages].sort((a, b) => a.at - b.at)) {
    if (message.author === 'agent') {
      const wake = message.meta?.wake;
      // A wake is a turn of its own. Routine corrective turns remain backstage; missing-answer corrections carry their original run.
      // Once only: the owner steering it mid-run opens their turn, and the replies after it answer them (Codex on #969).
      if (wake && !wakesOpened.has(wake.run)) {
        wakesOpened.add(wake.run);
        start('wake', null, null, wake);
      }
      (current ?? start('none', null, null)).replies.push(message);
      continue;
    }
    const mail = mailOf(message);
    if (!mail) {
      if (message.author === 'owner') start('you', message, null);
      continue;
    }
    if (opensTurn(mail)) start('mail', message, mail);
    else (current ?? start('none', null, null)).markers.push({ message, mail });
  }
  return turns;
}

/** One line of the mail log. */
export interface MailLine {
  at: number;
  messageId: string;
  mailId: string | null;
  kind: MessageMail['kind'];
  peer: string;
  peerId: string | null;
  text: string;
  inline: boolean;
  /** For mail in: what this conversation's agent said back (the end of the turn it started). */
  answer: string | null;
}

const lineOf = (message: DeskMessage, mail: MessageMail, answer: string | null): MailLine => ({
  at: message.at,
  messageId: message.messageId,
  mailId: mail.mailId ?? null,
  kind: mail.kind,
  peer: mail.peer,
  peerId: mail.peerId ?? null,
  text: mailBodyOf(message),
  inline: !!mail.inline,
  answer,
});

/** Every mail in the window, oldest first. An explicit answer to mail read mid-turn joins the mail it answers. */
export function mailLog(turns: Turn[]): MailLine[] {
  const lines: MailLine[] = [];
  const answers = new Map<string, string>();
  for (const turn of turns) {
    if (turn.opener === 'mail' && turn.open && turn.mail) lines.push(lineOf(turn.open, turn.mail, turn.replies.at(-1)?.text.trim() || null));
    for (const marker of turn.markers) {
      if (marker.mail.answers && marker.mail.mailId) answers.set(marker.mail.mailId, mailBodyOf(marker.message));
      else lines.push(lineOf(marker.message, marker.mail, null));
    }
  }
  // The explicit answer is what went back: it wins over whatever the turn ended on (Codex review on #575).
  for (const line of lines) if (line.mailId && answers.has(line.mailId)) line.answer = answers.get(line.mailId)!;
  return lines.sort((a, b) => a.at - b.at);
}

/** "3 in, 2 out · Integration lead, Playtest lead": one backstage line. */
export function backstageLine(lines: MailLine[]): string {
  const into = lines.filter((l) => l.kind === 'in' || l.kind === 'reply').length;
  const out = lines.length - into;
  const peers = [...new Set(lines.map((l) => shortPeer(l.peer)))];
  const counts = [into ? `${into} in` : null, out ? `${out} out` : null].filter(Boolean).join(', ');
  return `✉️ ${counts}${peers.length ? ` · ${peers.slice(0, 3).join(', ')}${peers.length > 3 ? ` +${peers.length - 3}` : ''}` : ''}`;
}

/** A peer's name without the workspace in front ("acme · Integration lead" → "Integration lead"). */
export function shortPeer(peer: string): string {
  const parts = peer.split(' · ');
  return parts.length > 1 ? parts.slice(1).join(' · ') : peer;
}

/** Only a missing-answer correction for the latest owner report may become that report. */
export function isAnswerCorrection(turn: Turn, turns: Turn[]): boolean {
  if (turn.opener !== 'wake' || !turn.wake?.answersRun) return false;
  const before = turns.slice(0, turns.indexOf(turn));
  const original = [...before].reverse().find(t => t.opener === 'you' ||
    (t.opener === 'wake' && t.wake?.cause !== 'corrective') ||
    (t.opener === 'mail' && t.mail?.kind === 'reply' && !!t.open?.text.includes(SPEAK_FOR_MARK)));
  return !!original && [original.open, ...original.replies].some(m => m?.meta?.runId === turn.wake!.answersRun);
}

/** The turn the latest reply to the owner belongs to: the last one the owner opened (or Loom woke) that has a reply. */
export function lastOwnerTurn(turns: Turn[]): Turn | null {
  return [...turns].reverse().find((turn) => (turn.opener === 'you' || (turn.opener === 'wake' && (turn.wake?.cause !== 'corrective' || isAnswerCorrection(turn, turns)))) && turn.replies.length > 0) ?? null;
}

/**
 * The turn the latest reply to the owner belongs to. An answer coming back from a worker this agent mailed
 * (kind `reply`, one that reports to it: ordinary peer answers stay backstage) starts a turn too, and what the agent says in it is its own report; only mail written to
 * it (kind `in`) expecting a peer reply never stands in. No-reply mail leaves the agent speaking to the owner. A conversation run through its
 * workers' replies (a lead) would otherwise show the last thing it said before the first of them. A turn
 * Loom woke it for is its own report too: the wait it set was for the owner's work.
 */
export function lastReportTurn(turns: Turn[]): Turn | null {
  return [...turns].reverse().find((turn) => turn.replies.length > 0 && (turn.opener === 'you' || (turn.opener === 'wake' && (turn.wake?.cause !== 'corrective' || isAnswerCorrection(turn, turns))) || (turn.opener === 'mail' && ((turn.mail?.kind === 'reply' && !!turn.open?.text.includes(SPEAK_FOR_MARK)) ||
      (turn.mail?.kind === 'in' && /(?:^|\n)— Sent through the desk by another agent’s conversation\. No reply needed\./u.test(turn.open?.text ?? '')))))) ?? null;
}

/** Mail since the latest reply to the owner: what happened backstage after it. */
export function mailSince(turns: Turn[]): { lines: MailLine[]; line: string } | null {
  const last = lastReportTurn(turns);
  const from = last ? turns.indexOf(last) : -1;
  const after = turns.slice(from + 1);
  // Mail turns after it, and mail read or sent during the owner's later (unanswered) turns.
  const lines = mailLog(after);
  // Mail read mid-turn or sent during the owner's last turn, after its reply, also counts.
  if (last) {
    const replyAt = last.replies.at(-1)!.at;
    for (const marker of last.markers) if (marker.message.at > replyAt) lines.push(lineOf(marker.message, marker.mail, null));
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.at - b.at);
  return { lines, line: backstageLine(lines) };
}

/** The owner's words that wait for the agent: queued at the source, or sent while it works and not yet answered. */
export function queuedOf(messages: DeskMessage[], working: { since: number } | null): Array<{ messageId: string; at: number; text: string }> {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const lastAgentAt = [...sorted].reverse().find((m) => m.author === 'agent')?.at ?? 0;
  return sorted
    .filter((m) => m.author === 'owner' && !mailOf(m))
    // The source knows (Loom: its run hasn't started); else, while a turn runs, words sent after it began with no reply since.
    .filter((m) => m.meta?.queued === true || (m.meta?.queued === undefined && !!working && m.at > working.since && m.at > lastAgentAt))
    .map((m) => ({ messageId: m.messageId, at: m.at, text: textSummary(m.text, 200) }));
}
