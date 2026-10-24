import type { LateUpdate } from './live-operator.js';

// One owner for a voice session's "brains" (a GPT-Live connection plus the operator
// driving it). A brain is replaced when the connection drops, sleeps when idle, and
// wakes on speech; every one of those exits goes through retire(), which stops the
// operator (timers, screen handlers, callbacks still in flight) and closes the
// connection. Agent results that come back to a retired operator are handed to the
// current brain, or held for the next one.

export interface OwnedBrain {
  operator: { stop(): void; adoptLateUpdate(late: LateUpdate): void };
  live: { close(): Promise<unknown> };
  /** Set once the owner retires it: its 'closed' event is expected, not a drop. */
  closing: boolean;
}

/** Updates held for the next brain (a long pause can pile up many; LiveOperator won't sleep with more). */
export const MAX_HELD_LATE = 200;

export class OperatorSessionOwner<B extends OwnedBrain> {
  private brain: B | null = null;
  private ended = false;
  private readonly held: LateUpdate[] = [];
  private readonly retired = new WeakSet<B>();

  constructor(private readonly log: (event: string, data?: Record<string, unknown>) => void = () => {}) {}

  get current(): B | null {
    return this.brain;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Makes a freshly started brain the current one. Refused, and the brain retired, when the
   * session has ended or another brain is already current (two would talk over each other).
   */
  install(next: B): boolean {
    if (this.ended || (this.brain && this.brain !== next)) {
      this.log('brain.refused', { reason: this.ended ? 'session ended' : 'another brain is live' });
      void this.retire(next);
      return false;
    }
    this.brain = next;
    const held = this.held.splice(0);
    for (const late of held) next.operator.adoptLateUpdate(late);
    if (held.length) this.log('brain.adopted', { updates: held.length });
    return true;
  }

  /** Stops a brain's operator and closes its connection. Safe to call more than once. Returns the close result. */
  async retire(brain: B | null = this.brain): Promise<unknown> {
    if (!brain) return null;
    if (this.brain === brain) this.brain = null;
    brain.closing = true;
    // stop() is idempotent and only ever disconnects this operator's own screen handlers.
    brain.operator.stop();
    if (this.retired.has(brain)) return null;
    this.retired.add(brain);
    return brain.live.close().catch(() => null);
  }

  /** From a retired operator: an update it never relayed. The current brain relays it, or the next one. */
  deliverLate(late: LateUpdate): void {
    if (this.ended) {
      this.log('late.dropped', { agent: late.agent.id, reason: 'session ended' });
      return;
    }
    if (this.brain) {
      this.brain.operator.adoptLateUpdate(late);
      return;
    }
    this.held.push(late);
    if (this.held.length > MAX_HELD_LATE) this.held.shift();
  }

  /** The session is over (everyone left, voice disconnected, shutdown): nothing more starts or relays. */
  async end(): Promise<unknown> {
    this.ended = true;
    this.held.length = 0;
    return this.retire(this.brain);
  }
}
