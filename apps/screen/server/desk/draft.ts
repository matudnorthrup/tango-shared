import { randomUUID } from 'node:crypto';

// The voice operator's Draft card (draft mode, apps/tango-voice/src/live/draft-mode.ts).
// The operator publishes it (POST /api/desk/draft, local only), screens get it as `draft`
// events on /api/desk/stream (and GET /api/desk/draft). The card's Send / Cancel buttons post
// POST /api/desk/draft/command, which is relayed to the operator as a `draftCommand` event on the
// same stream: the operator owns the draft and does the send through its normal path, so a tap
// and a spoken "yes" are one code path. Dismiss (clearing a sent / cancelled / unsent card once
// no draft is open) is the only thing the desk does on its own.

/** `sending`: confirmed and on its way; it can no longer be cancelled. */
export type DraftStatus = 'listening' | 'compiling' | 'confirm' | 'sending' | 'sent' | 'cancelled';
const STATUSES: readonly DraftStatus[] = ['listening', 'compiling', 'confirm', 'sending', 'sent', 'cancelled'];

export interface DraftCard {
  /** The draft's identity (null when blank). */
  id: string | null;
  active: boolean;
  /** itemId: the desk item the draft is for (the Conversation view shows the draft in that item's reply box). */
  target: { agentId: string; name: string; where: string | null; label: string; itemId: string | null } | null;
  fragments: string[];
  compiled: string | null;
  question: string | null;
  note: string | null;
  status: DraftStatus;
  /** While `sending`: the end of the undo window (epoch ms). Until then a Cancel tap is an Undo. */
  undoUntil: number | null;
  updatedAt: number;
}

export interface DraftCommand {
  commandId: string;
  action: 'send' | 'cancel';
  /** The draft the tap was on. */
  draftId: string;
  at: number;
}

const MAX_FRAGMENTS = 200;
const MAX_TEXT = 4000;

export function blankDraft(at = Date.now()): DraftCard {
  return { id: null, active: false, target: null, fragments: [], compiled: null, question: null, note: null, status: 'listening', undoUntil: null, updatedAt: at };
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** A posted card, validated and bounded, and the draft id it clears (if it is a clear). Null when it isn't a card at all. */
export function parseDraftPost(body: unknown, now = Date.now()): { card: DraftCard; clears: string | null } | null {
  const card = parseDraftCard(body, now);
  if (!card) return null;
  return { card, clears: text((body as Record<string, unknown>).clears, 80) };
}

export function parseDraftCard(body: unknown, now = Date.now()): DraftCard | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const target = raw.target && typeof raw.target === 'object' ? (raw.target as Record<string, unknown>) : null;
  const agentId = target ? text(target.agentId, 80) : null;
  const name = target ? text(target.name, 80) : null;
  return {
    id: text(raw.id, 80),
    active: raw.active === true,
    target: agentId && name ? { agentId, name, where: text(target!.where, 200), label: text(target!.label, 240) ?? name, itemId: text(target!.itemId, 200) } : null,
    fragments: Array.isArray(raw.fragments) ? raw.fragments.map((fragment) => text(fragment, MAX_TEXT)).filter((fragment): fragment is string => fragment !== null).slice(-MAX_FRAGMENTS) : [],
    compiled: text(raw.compiled, MAX_TEXT * 2),
    question: text(raw.question, 500),
    note: text(raw.note, 200),
    status: STATUSES.includes(raw.status as DraftStatus) ? (raw.status as DraftStatus) : 'listening',
    undoUntil: typeof raw.undoUntil === 'number' && Number.isFinite(raw.undoUntil) ? raw.undoUntil : null,
    updatedAt: now,
  };
}

/** The current card, its listeners, and how many operators are listening for taps. */
export class DraftBoard {
  private card: DraftCard = blankDraft();
  private readonly cardListeners = new Set<(card: DraftCard) => void>();
  private readonly commandListeners = new Set<(command: DraftCommand) => void>();

  current(): DraftCard {
    return this.card;
  }

  /**
   * A new card. A clear (`clears` = the draft it was meant for) is ignored once another draft has
   * replaced that one: a late timer from an ended session never wipes a newer session's draft.
   */
  set(card: DraftCard, clears: string | null = null): DraftCard {
    if (clears !== null && this.card.id !== clears) return this.card;
    this.card = card;
    for (const listener of this.cardListeners) listener(card);
    return card;
  }

  subscribe(listener: (card: DraftCard) => void): () => void {
    this.cardListeners.add(listener);
    return () => this.cardListeners.delete(listener);
  }

  /** An operator's desk stream (`?client=operator`) hears Send / Cancel taps. */
  subscribeCommands(listener: (command: DraftCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  get operators(): number {
    return this.commandListeners.size;
  }

  /**
   * A tap on the card. send needs a compiled draft waiting for confirmation, cancel an open draft,
   * and both an operator to hear it; dismiss clears a card that is no longer open.
   */
  command(action: unknown, draftId?: unknown, now = Date.now()): { status: number; body: Record<string, unknown> } {
    // Every tap names the draft the screen showed: one on a card that has since been replaced is refused.
    const id = typeof draftId === 'string' && draftId.trim() ? draftId.trim() : null;
    if (id !== null && id !== this.card.id) return { status: 409, body: { error: 'that draft is no longer the current one' } };
    if (action === 'dismiss') {
      if (this.card.active) return { status: 409, body: { error: 'the draft is still open: cancel it instead' } };
      this.set(blankDraft());
      return { status: 200, body: { dismissed: true } };
    }
    if (action !== 'send' && action !== 'cancel') return { status: 400, body: { error: 'action must be send, cancel or dismiss' } };
    if (!id) return { status: 400, body: { error: 'draftId is required: the id of the draft shown' } };
    if (!this.card.active) return { status: 409, body: { error: 'no draft is open' } };
    // A send held for its undo window can still be called back with Cancel.
    const undoable = action === 'cancel' && this.card.status === 'sending' && this.card.undoUntil !== null && now < this.card.undoUntil;
    if (this.card.status === 'sending' && !undoable) return { status: 409, body: { error: 'the draft is already on its way' } };
    if (action === 'send' && (this.card.status !== 'confirm' || !this.card.compiled || this.card.question)) return { status: 409, body: { error: 'the draft is not ready to send yet' } };
    if (this.operators === 0) return { status: 409, body: { error: 'the voice operator is not connected: say it instead' } };
    const command: DraftCommand = { commandId: randomUUID(), action, draftId: id, at: Date.now() };
    for (const listener of this.commandListeners) listener(command);
    return { status: 202, body: { accepted: true, commandId: command.commandId } };
  }
}
