import { randomUUID } from "node:crypto";
import type { LoomStore } from "./store.js";

export const LEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS resource_leases (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  identity TEXT NOT NULL,
  policy TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activity_at INTEGER NOT NULL,
  reclaimed_at INTEGER,
  result TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_lease_live_key ON resource_leases(resource_key)
  WHERE state != 'reclaimed';
CREATE INDEX IF NOT EXISTS resource_lease_owner ON resource_leases(thread_id, state);
`;

export type ResourceKind = "dev_server" | "browser" | "mapping" | "build" | "dependencies" | "cache";
export type LeasePolicy = "run_end" | "thread_cool" | "manual";
export interface ResourceLease {
  id: string;
  thread_id: string | null;
  run_id: string | null;
  kind: ResourceKind;
  resource_key: string;
  /** Exact backend identity, not a display name or a PID alone. */
  identity: string;
  policy: LeasePolicy;
  state: "active" | "reclaiming" | "blocked" | "unowned" | "reclaimed";
  created_at: number;
  activity_at: number;
  reclaimed_at: number | null;
  result: string | null;
}
export interface LeaseBackend {
  /** Unknown means discovery failed; it must never authorize a destructive operation. */
  inspect(identity: unknown): Promise<"same" | "gone" | "different" | "unknown">;
  /** Must recheck identity immediately before acting; retry after crash must be safe. */
  reclaim(identity: unknown): Promise<void>;
  /** Remove artifacts only after absence is confirmed. */
  cleanup?(identity: unknown): Promise<void>;
}

/** Durable ownership survives coordinator restart and thread deletion (deliberately no cascading FK). */
export class ResourceLeases {
  private pass: Promise<unknown> = Promise.resolve();
  constructor(private store: LoomStore, private options: {
    backends?: Partial<Record<ResourceKind, LeaseBackend>>;
    warm: (threadId: string) => boolean;
  }) {}

  list(threadId?: string): ResourceLease[] {
    return (threadId === undefined
      ? this.store.db.prepare("SELECT * FROM resource_leases ORDER BY created_at, id").all()
      : this.store.db.prepare("SELECT * FROM resource_leases WHERE thread_id = ? ORDER BY created_at, id").all(threadId)) as unknown as ResourceLease[];
  }

  register(input: { threadId?: string; runId?: string; kind: ResourceKind; key: string; identity: unknown; policy: LeasePolicy }): ResourceLease {
    const { threadId, runId } = input;
    if (threadId && !this.store.thread(threadId)) throw new Error("Unknown lease owner");
    const run = runId ? this.store.run(runId) : null;
    if (runId && (!threadId || !run || run.thread_id !== threadId || run.status !== "running")) throw new Error("Lease run is not active for this owner");
    if (threadId && input.policy === "run_end" && !runId) throw new Error("Run-end lease requires a run");
    if (!input.key.trim()) throw new Error("Lease requires an exact resource key");
    const identity = JSON.stringify(input.identity);
    if (!identity || identity === "null") throw new Error("Lease requires an identity");
    const existing = this.list().find(r => r.resource_key === input.key && r.state !== "reclaimed");
    if (existing) {
      if (existing.thread_id !== (threadId ?? null) || existing.run_id !== (runId ?? null) || existing.identity !== identity || existing.kind !== input.kind || existing.policy !== input.policy || existing.state === "reclaiming") throw new Error("Resource already leased; ownership or identity differs");
      return existing;
    }
    const now = this.store.now();
    const row: ResourceLease = { id: randomUUID(), thread_id: threadId ?? null, run_id: runId ?? null, kind: input.kind, resource_key: input.key, identity, policy: input.policy, state: threadId ? "active" : "unowned", created_at: now, activity_at: now, reclaimed_at: null, result: null };
    this.store.db.prepare(`INSERT INTO resource_leases (id,thread_id,run_id,kind,resource_key,identity,policy,state,created_at,activity_at,reclaimed_at,result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.thread_id, row.run_id, row.kind, row.resource_key, row.identity, row.policy, row.state, now, now, null, null);
    return row;
  }

  /** Even blocked/unknown resources pin their owner's checkout until positively released. */
  holds(threadId: string): boolean {
    return this.list(threadId).some(r => r.state !== "reclaimed" && ["build", "dev_server", "browser", "mapping"].includes(r.kind));
  }

  building(threadId: string): boolean {
    return this.list(threadId).some(row => row.kind === "build" && row.state !== "reclaimed");
  }

  private due(row: ResourceLease): boolean {
    if (!row.thread_id || row.state === "unowned" || row.state === "reclaimed" || row.policy === "manual") return false;
    if (row.policy === "run_end") {
      const run = row.run_id ? this.store.run(row.run_id) : null;
      return !run || !["queued", "running"].includes(run.status);
    }
    const thread = this.store.thread(row.thread_id);
    if (!thread) return true;
    if (this.store.activeRun(thread.id) || this.store.nextQueuedRun(thread.id) || this.store.openRequests(thread.id).length || thread.background) return false;
    return thread.status === "stopped" || thread.settled_at !== null || (thread.cooled_at !== null && !this.options.warm(thread.id));
  }

  /** Serial, idempotent restart reconciliation. Dry runs neither mutate records nor call a backend. */
  reconcile(dryRun = false): Promise<ResourceLease[]> {
    return this.sweep(dryRun);
  }

  /** Release one resource owned by the caller, retaining all identity checks. */
  release(id: string, threadId: string): Promise<ResourceLease[]> {
    return this.sweep(false, { id, threadId });
  }

  private sweep(dryRun: boolean, release?: { id: string; threadId: string }): Promise<ResourceLease[]> {
    const next = this.pass.then(async () => {
      for (const row of this.list()) {
        if (release && (row.id !== release.id || row.thread_id !== release.threadId)) continue;
        if (row.state === "unowned" || row.state === "reclaimed" || dryRun) continue;
        const backend = this.options.backends?.[row.kind];
        if (!backend) { if (this.due(row)) this.result(row, "blocked", "No managed backend; report only"); continue; }
        try {
          const identity: unknown = JSON.parse(row.identity);
          const found = await backend.inspect(identity);
          if (found === "gone") { await backend.cleanup?.(identity); this.result(row, "reclaimed", "Already absent"); continue; }
          if (found !== "same") { this.result(row, "blocked", `Identity ${found}; preserved`); continue; }
          this.store.db.prepare("UPDATE resource_leases SET activity_at = ? WHERE id = ?").run(this.store.now(), row.id);
          // A turn may have arrived while inspection awaited I/O.
          if (!release && !this.due(row)) continue;
          this.result(row, "reclaiming", "Reclaim started");
          await backend.reclaim(identity);
          const after = await backend.inspect(identity);
          if (after === "gone") await backend.cleanup?.(identity);
          this.result(row, after === "gone" ? "reclaimed" : "blocked", after === "gone" ? "Reclaimed" : `Reclaim unconfirmed (${after}); preserved`);
        } catch (error) { this.result(row, "blocked", String(error)); }
      }
      return this.list();
    });
    this.pass = next.catch(() => {});
    return next;
  }

  async drain(): Promise<void> { await this.pass; }

  private result(row: ResourceLease, state: ResourceLease["state"], result: string) {
    this.store.db.prepare("UPDATE resource_leases SET state = ?, result = ?, reclaimed_at = ? WHERE id = ?").run(state, result, state === "reclaimed" ? this.store.now() : null, row.id);
  }
}
