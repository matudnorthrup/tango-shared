import type { AskKind, AskSpec, AskStatus } from "./asks.js";
// The shared closing-line parser remains for non-Loom sources and retiring Loom asks.
// Loom owner asks open only from tool-recorded kind/id hand-offs (D-353).

export interface Handoff {
  owner: "you" | "me" | "waiting" | "none";
  /** What follows the label, in plain text ("" when nothing does). */
  text: string;
  waitingOn?: string | null;
}

const HANDOFF = /^\s*\*{0,2}\s*Next\s*[—–-]+\s*(you|me|none|waiting on\b[^:*]*)\s*:?\s*\*{0,2}\s*:?\s*(.*)$/i;

/**
 * The last such line counts, and only when it closes the message (a few list lines may follow an empty
 * "Next — you:"); a line quoted mid-message is not a hand-off.
 */
export function closingHandoff(text: string, includeWaitingOn = false): Handoff | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = HANDOFF.exec(lines[index]!);
    if (!match) continue;
    const after = lines.slice(index + 1).map((line) => line.trim()).filter(Boolean);
    if (after.length > 8) return null;
    const label = match[1]!.toLowerCase();
    const rest = [match[2]!, ...(match[2]!.trim() ? [] : after)]
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/[*_`]/g, "").trim())
      .filter(Boolean)
      .join("; ");
    // The owner's name is private profile configuration, never a repository default.
    const ownerName = process.env.TANGO_OWNER_NAME?.trim().toLowerCase();
    const waitingOn = label.startsWith("waiting on ") ? match[1]!.trim().slice(11).trim() : null;
    const owner = waitingOn && (/^(you|the owner|owner|user|the user)$/i.test(waitingOn) || waitingOn.toLowerCase() === ownerName)
      ? "you" : waitingOn !== null ? "waiting" : (label as Handoff["owner"]);
    return { owner, ...(includeWaitingOn && waitingOn && owner === "waiting" ? { waitingOn } : {}), text: rest.length > 200 ? `${rest.slice(0, 199).trimEnd()}…` : rest };
  }
  return null;
}

/** A thread's open ask: the agent ended a turn handing the owner the next move, and they haven't answered. */
export interface OpenAsk {
  who?: string;
  id?: string;
  kind?: AskKind;
  status?: AskStatus;
  steps?: { text: string; done_at?: number; by?: string }[];
  due?: string;
  resolves?: NonNullable<AskSpec["resolves"]> & { trigger_id?: string };
  points_to?: string;
  class?: string;
  revision?: number;
  /** Pending typed fields, consumed when the ledger records the hand-off. */
  spec?: AskSpec;
  text: string;
  /** When the agent asked (the closing message's time). */
  at: number;
  messageId: string;
  runId: string;
  /**
   * Who the ask is for, when not the owner: the agent the hand-off named (owner "agent", `to`), by display name and
   * address, so the desk shows the thread waiting on that agent, not Needs you (live audit, 10/20). Absent: the owner.
   */
  to?: string;
  toAddress?: string;
}

/** Who acts next, by kind: the desk's person or another human, an agent (this thread or another), a system, or nobody. */
export const NEXT_KINDS = ["human", "agent", "system", "nobody"] as const;
export type NextKind = (typeof NEXT_KINDS)[number];
export const WHO_HELP = "a human by id or name, an agent by address (loom:<thread id>, or the [id] in mail it sent this thread), a system by name (CI on PR 12)";

/** A closing handoff retained for one run, independently of its open ask. */
export interface RecordedHandoff extends Handoff {
  ask?: AskSpec;
  messageId: string | null;
  runId: string;
  at: number;
  source: "tool" | "closing-line";
  /**
   * Who this turn's ask is for: the agent the hand-off named (owner "agent"), resolved when it was recorded. Null or
   * absent: the owner.
   */
  audience?: { to: string; toAddress?: string } | null;
  /** The hand-off as the agent labeled it (`kind`, `who`), when it used them. */
  next?: { kind: NextKind; who: string };
  /** A "me" hand-off with nothing behind it (no run, wait or worker): when Loom woke the thread once to carry it on. */
  wokeAt?: number;
  /** The corrective wake ended without a viable tool hand-off: the desk's Stuck. */
  stuck?: boolean;
  /** This turn never called loom.handoff; prose cannot assign the owner a move. */
  missingTool?: boolean;
  /** Synthetic record only: no closing line to retire an ask on replay. */
  noClosingLine?: boolean;
}

/** The one wake for a "me" hand-off with nothing behind it; a run started with this text is that wake. */
export const STALL_WAKE_TEXT = "Loom: your hand-off says you act next, but nothing will bring you back: no turn is queued, no wait is armed and no worker is running. Do the next step now, or arm a wait with loom.wait_for, or hand off to whoever acts next. If this turn also ends that way, the desk shows the thread as Stuck.";
/** The one wake for a hand-off to another thread that isn't working on anything that would bring it back. */
export const AGENT_STALL_WAKE_TEXT = "Loom: your hand-off says another thread acts next, but that thread has no turn running or queued and no wait armed, so nothing will bring it to the work or wake you. Send it the work as mail and hand off again (Loom then wakes you when it settles), or do the next step yourself, or hand off to whoever really acts next.";
/** The one wake for a hand-off that names the thread it waits on in words, so Loom can't follow it. */
export const UNADDRESSED_WAKE_TEXT = "Loom: your hand-off says you're waiting on another thread, but names it only in words, so Loom can't wake you when it finishes. Hand off again with loom.handoff (kind agent, who loom:<its thread id>), or arm loom.wait_for (kind worker, spec {threadId}), or say who else acts next.";
export const MISSING_HANDOFF_WAKE_TEXT = "Loom: your turn ended without loom.handoff, so nobody is recorded as acting next and no ask reached the owner. Call loom.handoff with kind and who (the desk's person by id only if it is really theirs). If this turn also ends without it, the desk shows Stuck.";
export const RERECORD_ASK_WAKE_TEXT = "Loom: your open ask to the owner was read from your closing line before hand-offs named who acts next. Re-record it now with loom.handoff and declare the ask's kind (do, answer or pointer): kind human, who the desk's person, only if it is really theirs; kind agent, who loom:<id> if your lead, starter or another thread acts next; nobody if it is settled.";
export const UNCLEAR_ASK_WAKE_TEXT = "Loom: declare the ask's kind on loom.handoff: ask.kind do for an errand, answer for a fact only the owner knows, or pointer for an existing brief or request. Re-record the same ask with its kind; do not replace it with a different ask.";
/** Wakes whose outcome Loom reads by their exact text: each keeps a turn of its own, and the next one like it ends Stuck. */
export const STALL_WAKE_TEXTS: ReadonlySet<string> = new Set([UNCLEAR_ASK_WAKE_TEXT, MISSING_HANDOFF_WAKE_TEXT, STALL_WAKE_TEXT, AGENT_STALL_WAKE_TEXT, UNADDRESSED_WAKE_TEXT]);

export const MISSING_ANSWER_WAKE_PREFIX = "Loom: your reply had no written answer to the owner question.";

/** The original owner run, carried durably in this Loom-owned corrective text. */
export function missingAnswerRun(text: string): string | undefined {
  if (!text.startsWith(MISSING_ANSWER_WAKE_PREFIX)) return undefined;
  return /^ \(run ([a-zA-Z0-9-]+)\)/.exec(text.slice(MISSING_ANSWER_WAKE_PREFIX.length))?.[1];
}

/** Stable provenance for wake runs, including pre-migration history. Only Loom-owned texts match. */
export type WakeCause = "trigger" | "corrective";
export function wakeCause(text: string): WakeCause {
  return text.startsWith(MISSING_ANSWER_WAKE_PREFIX) || STALL_WAKE_TEXTS.has(text) || text === RERECORD_ASK_WAKE_TEXT ||
    text.startsWith('Loom: Your closing "Next — you" (') ||
    text.startsWith('Loom: your closing "Next — you" points at a decision that is already closed.')
    ? "corrective" : "trigger";
}
