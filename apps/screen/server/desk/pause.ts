import { randomUUID } from 'node:crypto';

// The voice operator's pause pill (pause mode, apps/tango-voice/src/live/pause-mode.ts). The
// operator publishes it (POST /api/desk/pause, local only); screens get it as `pause` events on
// /api/desk/stream (and GET /api/desk/pause) and show "Paused · N waiting" in the top bar. A tap
// posts POST /api/desk/pause/command { action: 'resume', pauseId }, relayed to the operator as a
// `pauseCommand` event on its own stream: the operator owns the pause and resumes it exactly as
// it does for "Tango, I'm back".

export interface PauseCard {
  /** The pause's identity (null when never paused). */
  id: string | null;
  active: boolean;
  since: number | null;
  /** Voice updates waiting. */
  waiting: number;
  /** Paused 30 minutes or more. */
  still: boolean;
  updatedAt: number;
}

export interface PauseCommand {
  commandId: string;
  action: 'resume';
  pauseId: string;
  at: number;
}

export function blankPause(at = Date.now()): PauseCard {
  return { id: null, active: false, since: null, waiting: 0, still: false, updatedAt: at };
}

/** A posted pill, validated and bounded; null when it isn't one. */
export function parsePauseCard(body: unknown, now = Date.now()): PauseCard | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : null;
  const active = raw.active === true;
  const waiting = typeof raw.waiting === 'number' && Number.isFinite(raw.waiting) ? Math.max(0, Math.min(999, Math.floor(raw.waiting))) : 0;
  const since = typeof raw.since === 'number' && Number.isFinite(raw.since) ? raw.since : null;
  return { id, active, since: active ? since : null, waiting: active ? waiting : 0, still: active && raw.still === true, updatedAt: now };
}

/** The current pill, its listeners, and the operators listening for taps. */
export class PauseBoard {
  private card: PauseCard = blankPause();
  private readonly cardListeners = new Set<(card: PauseCard) => void>();
  private readonly commandListeners = new Set<(command: PauseCommand) => void>();

  current(): PauseCard {
    return this.card;
  }

  set(card: PauseCard): PauseCard {
    this.card = card;
    for (const listener of this.cardListeners) listener(card);
    return card;
  }

  subscribe(listener: (card: PauseCard) => void): () => void {
    this.cardListeners.add(listener);
    return () => this.cardListeners.delete(listener);
  }

  /** An operator's desk stream (`?client=operator`, authenticated) hears resume taps. */
  subscribeCommands(listener: (command: PauseCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  get operators(): number {
    return this.commandListeners.size;
  }

  /** A tap on the pill: resume, for the pause the screen showed, with an operator listening. */
  command(action: unknown, pauseId?: unknown): { status: number; body: Record<string, unknown> } {
    if (action !== 'resume') return { status: 400, body: { error: 'action must be resume' } };
    const id = typeof pauseId === 'string' && pauseId.trim() ? pauseId.trim() : null;
    if (!id) return { status: 400, body: { error: 'pauseId is required: the id of the pause shown' } };
    if (!this.card.active) return { status: 409, body: { error: 'the operator is not paused' } };
    if (id !== this.card.id) return { status: 409, body: { error: 'that pause is no longer the current one' } };
    if (this.operators === 0) return { status: 409, body: { error: 'the voice operator is not connected: say “Tango, I’m back” instead' } };
    const command: PauseCommand = { commandId: randomUUID(), action: 'resume', pauseId: id, at: Date.now() };
    for (const listener of this.commandListeners) listener(command);
    return { status: 202, body: { accepted: true, commandId: command.commandId } };
  }
}
