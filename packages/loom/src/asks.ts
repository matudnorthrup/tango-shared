import { deskPerson } from "./people.js";
import type { LoomStore, ThreadRow } from "./store.js";
import type { OpenAsk } from "./handoff.js";
import { normalizeAsk, sameAsk } from "./ask-lint.js";
import { loadBoard } from "./decisions.js";

export type AskKind = "do" | "answer" | "pointer" | "unclear";
export interface AskSpec {
  kind: AskKind;
  steps?: string[];
  resolves?: { kind: "pr" | "url" | "file" | "thread"; ref: string };
  due?: string;
  class?: string;
}
export type AskStatus = "open" | "done" | "answered" | "resolved" | "superseded" | "withdrawn" | "closed-by-done" | "expired";
export interface AskRow {
  id: string; thread: string; agent: string | null; space: string | null; kind: AskKind;
  text: string; norm: string; who: string; audience: "owner" | "agent"; class: string | null; due: string | null;
  steps: string | null; resolves: string | null; points_to: string | null; status: AskStatus;
  resolved_by: string | null; resolved_at: number | null; resolution_note: string | null;
  message_id: string; run_id: string; revision: number; legacy: number; created_at: number; updated_at: number;
}
export const ASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS asks (
 id TEXT PRIMARY KEY, thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, agent TEXT, space TEXT,
 kind TEXT NOT NULL, text TEXT NOT NULL, norm TEXT NOT NULL, who TEXT NOT NULL, audience TEXT NOT NULL,
 class TEXT, due TEXT, steps TEXT, resolves TEXT, points_to TEXT, status TEXT NOT NULL,
 resolved_by TEXT, resolved_at INTEGER, resolution_note TEXT, message_id TEXT, run_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1, legacy INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS asks_open_thread ON asks(thread) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS asks_origin ON asks(thread, run_id, norm);
CREATE TABLE IF NOT EXISTS ask_seq (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
INSERT OR IGNORE INTO ask_seq VALUES (1, 0);
CREATE TABLE IF NOT EXISTS ask_revisions (ask_id TEXT NOT NULL REFERENCES asks(id) ON DELETE CASCADE, revision INTEGER NOT NULL, at INTEGER NOT NULL, spec TEXT NOT NULL, PRIMARY KEY(ask_id, revision));
`;

/** Invalid or absent kind remains an actionable, reply-only ask; malformed optional fields are refused. */
export function validateAsk(input: unknown): AskSpec {
  if (input == null) return { kind: "unclear" };
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("ask must be an object");
  const s = input as Record<string, unknown>;
  const kind = ["do", "answer", "pointer"].includes(String(s.kind)) ? s.kind as AskKind : "unclear";
  if (s.steps !== undefined && (!Array.isArray(s.steps) || s.steps.length < 2 || s.steps.length > 5 || s.steps.some(x => typeof x !== "string" || !x.trim()) || new Set(s.steps).size !== s.steps.length)) throw new Error("ask.steps needs 2 to 5 distinct nonempty steps");
  if (s.due !== undefined && (typeof s.due !== "string" || !/^\d{4}-\d\d-\d\dT/.test(s.due) || !Number.isFinite(Date.parse(s.due)))) throw new Error("ask.due must be an ISO time");
  if (s.class !== undefined && (typeof s.class !== "string" || !s.class.trim())) throw new Error("ask.class must name a board class");
  if (s.resolves !== undefined) {
    const r = s.resolves as AskSpec["resolves"];
    if (!r || !["pr", "url", "file", "thread"].includes(r.kind) || typeof r.ref !== "string" || !r.ref.trim()) throw new Error("Invalid ask.resolves");
    resolveSpec(r); // Reject unusable references before recording the handoff.
  }
  return { kind, ...(s.steps ? { steps: s.steps as string[] } : {}), ...(s.due ? { due: s.due as string } : {}), ...(s.class ? { class: s.class as string } : {}), ...(s.resolves ? { resolves: s.resolves as NonNullable<AskSpec["resolves"]> } : {}) };
}
export function resolveSpec(r: NonNullable<AskSpec["resolves"]>): Record<string, unknown> {
  if (r.kind === "pr") {
    const m = r.ref.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)\/?$/);
    if (!m || Number(m[2]) < 1) throw new Error("ask.resolves pr needs a GitHub PR URL or owner/repo#number");
    return { repo: m[1], number: Number(m[2]), until: "closed" };
  }
  if (r.kind === "thread") return { threadId: r.ref.replace(/^loom:/, ""), until: "run_completed" };
  if (r.kind === "file") return { path: r.ref, exists: true };
  const url = new URL(r.ref);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("ask.resolves url needs http or https");
  return { url: url.href, status: 200 };
}
export function askRow(store: LoomStore, id: string): AskRow | undefined { return store.db.prepare("SELECT * FROM asks WHERE id=?").get(id) as unknown as AskRow | undefined; }
export function listAsks(store: LoomStore, status?: string): AskRow[] { return store.db.prepare("SELECT * FROM asks WHERE (? IS NULL OR status=?) ORDER BY created_at, rowid").all(status ?? null, status ?? null) as unknown as AskRow[]; }
export function askPayload(row: AskRow) { return { ...row, steps: row.steps ? JSON.parse(row.steps) : null, resolves: row.resolves ? JSON.parse(row.resolves) : null }; }
export function openAsk(row: AskRow): OpenAsk {
  return { text: row.text, at: row.created_at, messageId: row.message_id, runId: row.run_id, id: row.id, kind: row.kind,
    who: row.who, status: row.status, steps: row.steps ? JSON.parse(row.steps) : undefined, due: row.due ?? undefined,
    resolves: row.resolves ? JSON.parse(row.resolves) : undefined, points_to: row.points_to ?? undefined,
    class: row.class ?? undefined, revision: row.revision,
    ...(row.audience === "agent" ? { to: row.who, toAddress: row.who } : {}) };
}
export function finishAsk(store: LoomStore, id: string, status: Exclude<AskStatus, "open">, by: string | null, note?: string): boolean {
  const row = askRow(store, id);
  if (!row || row.status !== "open") return false;
  store.db.prepare("UPDATE asks SET status=?,resolved_by=?,resolved_at=?,resolution_note=?,updated_at=? WHERE id=?").run(status, by, store.now(), note ?? null, store.now(), id);
  const trigger = row.resolves ? JSON.parse(row.resolves).trigger_id : null;
  if (trigger) store.db.prepare("UPDATE triggers SET status='cancelled' WHERE id=? AND status='waiting'").run(trigger);
  const thread = store.thread(row.thread);
  if (thread?.ask && JSON.parse(thread.ask).id === id) store.updateThread(row.thread, { ask: null });
  store.db.prepare("UPDATE runs SET status='canceled',ended_at=? WHERE status='queued' AND id IN (SELECT wake_run_id FROM ask_lints WHERE thread_id=? AND norm=? AND reason != 'points at a closed decision')").run(store.now(), row.thread, row.norm);
  store.touchThread(row.thread);
  return true;
}
/** Undo of desk Clear or Done (matched to its settlement): the thread's latest row it closed is open again, with no open row in the way. Its resolution
 * trigger was cancelled by the close, so the reference goes; the caller's replay arms a fresh one. */
export function reopenAsk(store: LoomStore, threadId: string, settlement?: number): AskRow | null {
  if (store.db.prepare("SELECT 1 FROM asks WHERE thread=? AND status='open'").get(threadId)) return null;
  const row = store.db.prepare("SELECT * FROM asks WHERE thread=? AND status='closed-by-done' AND (? IS NULL OR resolution_note=?) ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId, settlement ?? null, settlement === undefined ? null : `settle:${settlement}`) as unknown as AskRow | undefined;
  if (!row) return null;
  let resolves = row.resolves;
  if (resolves) { const spec = JSON.parse(resolves); delete spec.trigger_id; resolves = JSON.stringify(spec); }
  store.db.prepare("UPDATE asks SET status='open',resolved_at=NULL,resolved_by=NULL,resolution_note=NULL,resolves=?,updated_at=? WHERE id=?").run(resolves, store.now(), row.id);
  return askRow(store, row.id) ?? null;
}
/** A closed row as replay reads it (host.rebuildAsks): where it came from, and how and when it closed. */
export type LedgerClosure = Pick<AskRow, "run_id" | "norm" | "resolved_by"> & { status: Exclude<AskStatus, "open">; resolved_at: number };
export function closeThreadAsk(store: LoomStore, threadId: string, status: Exclude<AskStatus, "open">, by: string | null): void {
  const row = store.db.prepare("SELECT id FROM asks WHERE thread=? AND status='open'").get(threadId) as { id: string } | undefined;
  if (row) finishAsk(store, row.id, status, by);
  if (store.thread(threadId)?.ask) store.updateThread(threadId, { ask: null });
}

/** Called inside the host transaction. Replay finds provenance first and never resurrects a settled row. */
export function recordAskRow(store: LoomStore, thread: ThreadRow, ask: OpenAsk, spec?: AskSpec, legacy = false, replay = false): OpenAsk | null {
  const norm = normalizeAsk(ask.text);
  const current = store.db.prepare("SELECT * FROM asks WHERE thread=? AND status='open'").get(thread.id) as unknown as AskRow | undefined;
  let row = (ask.id ? askRow(store, ask.id) : undefined) ?? store.db.prepare("SELECT * FROM asks WHERE thread=? AND run_id=? AND norm=? ORDER BY rowid DESC LIMIT 1").get(thread.id, ask.runId, norm) as AskRow | undefined;
  if (row && row.status !== "open") return null;
  if (!row && current && sameAsk(current.text, ask.text) && current.audience === (ask.to ? "agent" : "owner")) row = current;
  const s = spec ?? { kind: ask.kind ?? "unclear" };
  const values = { kind: s.kind, steps: s.steps ? JSON.stringify(s.steps.map(text => ({ text }))) : null, due: s.due ?? null, resolves: s.resolves ? JSON.stringify(s.resolves) : null, class: s.class ?? null };
  if (row) {
    if (!replay && spec) {
      const oldResolves = row.resolves ? JSON.parse(row.resolves) : null;
      if (oldResolves) delete oldResolves.trigger_id;
      const sameSteps = JSON.stringify(row.steps ? JSON.parse(row.steps).map((x: { text: string }) => x.text) : null) === JSON.stringify(s.steps ?? null);
      const sameResolve = JSON.stringify(oldResolves) === JSON.stringify(s.resolves ?? null);
      const changed = (row.legacy === 1 && s.kind !== "unclear") || row.kind !== values.kind || row.due !== values.due || row.class !== values.class || !sameResolve || !sameSteps;
      if (changed) {
        if (!sameResolve && row.resolves) { const id = JSON.parse(row.resolves).trigger_id; if (id) store.db.prepare("UPDATE triggers SET status='cancelled' WHERE id=? AND status='waiting'").run(id); }
        store.db.prepare("UPDATE asks SET kind=?,steps=?,due=?,resolves=?,class=?,points_to=?,legacy=?,revision=revision+1,updated_at=? WHERE id=?").run(values.kind, sameSteps ? row.steps : values.steps, values.due, sameResolve ? row.resolves : values.resolves, values.class, s.kind === "pointer" ? pointerTarget(store, ask.text) : null, s.kind !== "unclear" ? 0 : row.legacy, store.now(), row.id);
        store.db.prepare("INSERT INTO ask_revisions VALUES (?,?,?,?)").run(row.id, row.revision + 1, store.now(), JSON.stringify(s));
      }
    }
    return { ...openAsk(askRow(store, row.id)!), ...(ask.to ? { to: ask.to, toAddress: ask.toAddress } : {}) };
  }
  if (current) finishAsk(store, current.id, "superseded", "agent");
  const n = store.db.prepare("UPDATE ask_seq SET last=last+1 WHERE id=1 RETURNING last").get() as { last: number };
  const id = `A-${n.last}`;
  store.db.prepare(`INSERT INTO asks (id,thread,kind,text,norm,who,audience,class,due,steps,resolves,points_to,status,message_id,run_id,legacy,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open',?,?,?,?,?)`).run(id, thread.id, s.kind, ask.text, norm, ask.who ?? ask.toAddress ?? ask.to ?? deskPerson()?.id ?? "owner", ask.to ? "agent" : "owner", values.class, values.due, values.steps, values.resolves, s.kind === "pointer" ? pointerTarget(store, ask.text) : null, ask.messageId, ask.runId, legacy ? 1 : 0, ask.at, store.now());
  return { ...openAsk(askRow(store, id)!), ...(ask.to ? { to: ask.to, toAddress: ask.toAddress } : {}) };
}
function pointerTarget(store: LoomStore, text: string): string | null {
  return text.match(/\bD-\d+\b/i)?.[0].toUpperCase() ?? (store.db.prepare("SELECT id FROM requests WHERE status='open'").all() as { id: string }[]).find(r => text.includes(r.id))?.id ?? null;
}
export function migrateAsks(store: LoomStore): void {
  for (const thread of store.threads()) {
    if (!thread.ask) continue;
    let ask: OpenAsk; try { ask = JSON.parse(thread.ask); } catch { continue; }
    if (ask.id && askRow(store, ask.id)) continue;
    const recorded = recordAskRow(store, thread, ask, { kind: "unclear" }, true);
    store.db.prepare("UPDATE threads SET ask=? WHERE id=?").run(JSON.stringify(recorded), thread.id);
  }
}
export class AskClock {
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: LoomStore, private wake: (thread: string) => void) {
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.warn("Ask clock failed", e); } }, 30_000); this.timer.unref();
  }
  tick(): void {
    const board = loadBoard(); // Fail closed if policy is unavailable.
    for (const row of listAsks(this.store, "open")) {
      if (!row.due || Date.parse(row.due) > this.store.now() || row.class && (board.tripwires.includes(row.class) || board.classes[row.class]?.level === 1)) continue;
      this.store.tx(() => {
        if (!finishAsk(this.store, row.id, "expired", null)) return;
        this.store.createRun(row.thread, "wake", `Loom: Ask ${row.id} expired: ${row.text}. Due ${row.due}.`);
      });
      this.wake(row.thread);
    }
  }
  close(): void { clearInterval(this.timer); }
}

/** Reconcile durable mail and completed delivery turns, also used at startup for pre-fix asks. */
export function reconcileAgentAsks(store: LoomStore): number {
  let closed = 0;
  for (const ask of listAsks(store, "open")) {
    if (ask.audience !== "agent") continue;
    const opened = Math.max(ask.created_at, store.run(ask.run_id)?.ended_at ?? 0);
    const reply = store.db.prepare(`SELECT id, created_at AS at FROM messages WHERE thread_id=? AND role='user'
      AND created_at>=? AND rowid>COALESCE((SELECT rowid FROM messages WHERE id=?),0)
      AND json_extract(origin,'$.kind')='peer' AND json_extract(origin,'$.from')=?
      ORDER BY created_at, rowid LIMIT 1`).get(ask.thread, opened, ask.message_id, ask.who) as { id: string; at: number } | undefined;
    // An explicit resolution condition is stronger than delivery; questions require a reply.
    const mailDelivery = ask.resolves || ask.kind === "answer" || !ask.who.startsWith("loom:") ? undefined : store.db.prepare(`SELECT r.id, r.ended_at AS at FROM messages m JOIN runs r ON r.id=m.run_id
      WHERE m.thread_id=? AND m.role='user' AND m.created_at>=?
      AND m.rowid>COALESCE((SELECT rowid FROM messages WHERE id=?),0)
      AND json_extract(m.origin,'$.kind')='peer' AND json_extract(m.origin,'$.from')=?
      AND m.text LIKE '✉️ Reply from %' AND r.status='completed' AND r.ended_at>=?
      ORDER BY r.ended_at, m.rowid LIMIT 1`).get(ask.who.slice(5), opened, ask.message_id, `loom:${ask.thread}`, opened) as { id: string; at: number } | undefined;
    // Triggers do not persist a wake-run ID. A completed addressee run after the
    // matching worker wait fired is the durable evidence that delivery was handled.
    const workerDelivery = ask.resolves || ask.kind === "answer" || !ask.who.startsWith("loom:") ? undefined : store.db.prepare(`SELECT r.id, r.ended_at AS at FROM triggers t JOIN runs r ON r.thread_id=t.thread_id
      WHERE t.thread_id=? AND t.kind='worker' AND t.status='fired' AND t.fired_at>=?
      AND json_extract(t.spec,'$.threadId')=? AND r.status='completed' AND r.ended_at>=t.fired_at
      ORDER BY r.ended_at, r.position LIMIT 1`).get(ask.who.slice(5), opened, ask.thread) as { id: string; at: number } | undefined;
    const delivery = !mailDelivery ? workerDelivery : !workerDelivery || mailDelivery.at <= workerDelivery.at ? mailDelivery : workerDelivery;
    // Backfill chooses the first closing event, just as the live path does.
    if (reply && (!delivery || reply.at <= delivery.at)) {
      if (finishAsk(store, ask.id, "answered", `agent:${ask.who}`)) closed++;
    } else if (delivery && finishAsk(store, ask.id, "resolved", `delivered:${delivery.id}`)) closed++;
  }
  return closed;
}
