// Lab fences: while a voice lab session runs against the real desk (apps/tango-voice lab:tts-session),
// the agents in its scratch threads are fenced in too. A scratch thread can't start a new thread, and
// can't mail (or answer mail from) a conversation outside the fence. The lab registers its scratch
// items (POST /api/desk/lab-fence) and renews them while it runs; a fence lapses on its own after its
// TTL, so a lab that crashed never leaves one behind. In memory only: the lab renews after a restart.

export const LAB_FENCE_MAX_TTL_MS = 30 * 60_000;
export const LAB_FENCE_DEFAULT_TTL_MS = 5 * 60_000;
export const LAB_FENCE_MAX_ITEMS = 50;

interface Fence {
  items: Set<string>;
  expiresAt: number;
}

export class LabFences {
  private readonly fences = new Map<string, Fence>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Sets (or renews) one session's fence. */
  set(sessionId: string, items: string[], ttlMs = LAB_FENCE_DEFAULT_TTL_MS): { sessionId: string; items: string[]; expiresAt: number } {
    const ttl = Math.min(LAB_FENCE_MAX_TTL_MS, Math.max(1000, Number.isFinite(ttlMs) ? ttlMs : LAB_FENCE_DEFAULT_TTL_MS));
    const fence = { items: new Set(items), expiresAt: this.now() + ttl };
    this.fences.set(sessionId, fence);
    return { sessionId, items: [...fence.items], expiresAt: fence.expiresAt };
  }

  clear(sessionId: string): boolean {
    return this.fences.delete(sessionId);
  }

  active(): Array<{ sessionId: string; items: string[]; expiresAt: number }> {
    this.prune();
    return [...this.fences].map(([sessionId, fence]) => ({ sessionId, items: [...fence.items], expiresAt: fence.expiresAt }));
  }

  /** The lab session whose fence holds this item, if any. */
  fencedBy(itemId: string | undefined | null): string | null {
    if (!itemId) return null;
    this.prune();
    for (const [sessionId, fence] of this.fences) if (fence.items.has(itemId)) return sessionId;
    return null;
  }

  /** Why a scratch thread may not start a thread (null: not fenced). */
  checkStart(from: string): string | null {
    const session = this.fencedBy(from);
    return session ? `${from} is a scratch thread of lab session ${session}: it can't start new threads` : null;
  }

  /** Why `from` may not write to `to` (null: allowed). Within one fence, and between unfenced items, is fine. */
  checkWrite(from: string, to: string): string | null {
    const session = this.fencedBy(from);
    if (!session) return null;
    if (this.fences.get(session)?.items.has(to)) return null;
    return `${from} is a scratch thread of lab session ${session}: it can only write to that session's scratch threads, not ${to}`;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, fence] of this.fences) if (fence.expiresAt <= now) this.fences.delete(id);
  }
}
