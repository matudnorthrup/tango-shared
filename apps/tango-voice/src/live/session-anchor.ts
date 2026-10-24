import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * The owner's voice session, kept in a file so it outlives operator restarts (a deploy mid-call starts a
 * new process with the owner still in the channel) as well as brains (sleep, reconnects). A session starts
 * clear: only what the owner asked or directed since `startedAt` is spoken, one answer per owner message
 * (`answered`), TGO-1050. `asleep` keeps the spans the voice model slept: what the owner typed then (on the desk,
 * in Discord) was for that thread, not for voice.
 */
export interface SessionAnchorOptions {
  /** The owner just joined: a new session, whatever the file says. */
  fresh: boolean;
  now?: number;
  /** An anchor older than this is stale (the process died without clearing it). Default 12 h. */
  maxAgeMs?: number;
}

/** Owner turns whose answer was already spoken this session. */
export interface AnsweredTurns {
  has(key: string): boolean;
  add(key: string): void;
}

const MAX_ANSWERED = 500;
const MAX_SPANS = 200;

export class VoiceSessionMemory implements AnsweredTurns {
  readonly startedAt: number;
  private readonly answered: string[];
  /** [fell asleep, woke] spans; an open span (woke null) while asleep. */
  private readonly asleep: Array<[number, number | null]>;

  constructor(private readonly file: string, options: SessionAnchorOptions) {
    const now = options.now ?? Date.now();
    const saved = options.fresh ? null : read(file);
    const valid = saved && typeof saved.startedAt === 'number' && saved.startedAt <= now && now - saved.startedAt < (options.maxAgeMs ?? 12 * 3_600_000);
    this.startedAt = valid ? saved.startedAt! : now;
    this.answered = valid && Array.isArray(saved.answered) ? saved.answered.filter((key): key is string => typeof key === 'string') : [];
    this.asleep = valid && Array.isArray(saved.asleep) ? saved.asleep.filter(isSpan) : [];
    this.save();
  }

  has(key: string): boolean {
    return this.answered.includes(key);
  }

  add(key: string): void {
    if (this.has(key)) return;
    this.answered.push(key);
    if (this.answered.length > MAX_ANSWERED) this.answered.splice(0, this.answered.length - MAX_ANSWERED);
    this.save();
  }

  /** The voice model hung up for quiet (not a dropped connection, which reconnects at once). */
  sleep(at = Date.now()): void {
    if (this.asleep.at(-1)?.[1] === null) return;
    this.asleep.push([at, null]);
    if (this.asleep.length > MAX_SPANS) this.asleep.splice(0, this.asleep.length - MAX_SPANS);
    this.save();
  }

  wake(at = Date.now()): void {
    const open = this.asleep.at(-1);
    if (!open || open[1] !== null) return;
    open[1] = at;
    this.save();
  }

  /** Was the voice model asleep at `at`? */
  asleepAt(at: number): boolean {
    return this.asleep.some(([from, to]) => at >= from && (to === null || at < to));
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ startedAt: this.startedAt, answered: this.answered, asleep: this.asleep }));
    } catch {
      /* the file only carries the session across restarts; the session runs without it */
    }
  }
}

const isSpan = (span: unknown): span is [number, number | null] =>
  Array.isArray(span) && span.length === 2 && typeof span[0] === 'number' && (span[1] === null || typeof span[1] === 'number');

function read(file: string): { startedAt?: number; answered?: unknown[]; asleep?: unknown[] } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { startedAt?: number; answered?: unknown[]; asleep?: unknown[] };
  } catch {
    return null; // none yet, or unreadable: a new session
  }
}

/** The owner left: the next session starts clear. */
export function clearSessionAnchor(file: string): void {
  rmSync(file, { force: true });
}
