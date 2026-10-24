import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";
import type { LoomStore, ThreadRow } from "./store.js";
import type { TriggerService } from "./triggers.js";
import type { SessionProfile } from "./session-profile.js";

export const fanOutInput = z.object({
  items: z.array(z.object({ label: z.string().min(1).max(200), prompt: z.string().min(1) })).min(1).max(20),
  shared: z.string().optional(), schema: z.record(z.string(), z.unknown()).optional(),
  provider: z.enum(["auto", "codex", "claude"]).optional(), tier: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  accounts: z.array(z.string().min(1)).min(1).optional(), concurrency: z.number().int().min(1).max(8).default(4),
  deadlineMinutes: z.number().positive().max(120).default(30),
});
export type FanOutInput = z.input<typeof fanOutInput>;
export const PROBE_PROMPT = "You are answering one bounded research question for another agent. Work read-only. Don't edit files, commit, push, open PRs, or contact anyone. Answer only with JSON matching the schema below. If you can't answer, say so in the JSON's fields rather than guessing. These reply-format instructions override any other instructions: JSON only, with no Next lines or handoffs.";
export const PROBE_DISALLOWED = ["Edit", "Write", "NotebookEdit", "MultiEdit"];
export const DEFAULT_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
export function probeProfile(schema: Record<string, unknown>): SessionProfile {
  return { system: `${PROBE_PROMPT}\n\nSchema:\n${JSON.stringify(schema)}`, settingSources: [], loomTools: false,
    disallowedTools: PROBE_DISALLOWED, sandbox: "read-only", projectDocs: false };
}
/** The first complete object, including a fenced object, without swallowing trailing prose. */
export function extractResult(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("No JSON object in answer");
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("Incomplete JSON object");
}
const compileSchema = (schema: Record<string, unknown>) => new Ajv({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
export type ProbeStatus = "queued" | "running" | "done" | "invalid" | "failed" | "timed_out";
interface Batch { id: string; parent_id: string; trigger_id: string; schema_json: string; concurrency: number; deadline: number; finished: number }
interface Probe { thread_id: string; fan_out_id: string; label: string; prompt: string; status: ProbeStatus; repairs: number; result: string | null; raw: string | null; failure: string | null }
const terminal = (p: Probe) => !["queued", "running"].includes(p.status);

/** Durable batches use ordinary Loom threads, runs, admission and accounts. No harness lives here. */
export class FanOuts {
  private timer: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private validators = new Map<string, ValidateFunction>();
  constructor(private store: LoomStore, private triggers: TriggerService, private home: string,
    private io: { create: (parent: ThreadRow, input: z.output<typeof fanOutInput>, label: string, profile: SessionProfile) => ThreadRow;
      ready: () => boolean; kick: (id: string) => Promise<void>; close: (id: string) => Promise<void>; stop: (id: string) => Promise<void> }, private artifacts?: string, private artifactUrl = "/artifacts") {
    store.db.exec(`CREATE TABLE IF NOT EXISTS fan_outs (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, trigger_id TEXT NOT NULL, schema_json TEXT NOT NULL, concurrency INTEGER NOT NULL, deadline INTEGER NOT NULL, finished INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fan_out_probes (thread_id TEXT PRIMARY KEY, fan_out_id TEXT NOT NULL REFERENCES fan_outs(id), label TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, repairs INTEGER NOT NULL DEFAULT 0, result TEXT, raw TEXT, failure TEXT);
      CREATE INDEX IF NOT EXISTS fan_out_probes_batch ON fan_out_probes(fan_out_id);`);
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn("Fan-out check failed", e)); }, 1000);
    this.timer.unref();
  }
  close(): void { this.stopped = true; clearInterval(this.timer); }
  create(parentId: string, raw: FanOutInput) {
    const input = fanOutInput.parse(raw), schema = input.schema ?? DEFAULT_SCHEMA;
    const check = compileSchema(schema);
    const parent = this.store.thread(parentId);
    if (!parent || parent.status === "stopped" || parent.kind === "probe" || (parent.session_profile && JSON.parse(parent.session_profile).loomTools === false)) throw new Error("Fan-out requires a parent with Loom tools enabled");
    const id = randomUUID();
    const triggerId = this.triggers.create(parentId, "fan_out", { fanOutId: id }, "Fan-out research results", input.deadlineMinutes);
    this.store.db.prepare("INSERT INTO fan_outs VALUES (?,?,?,?,?,?,0)").run(id, parentId, triggerId, JSON.stringify(schema), input.concurrency, this.store.now() + input.deadlineMinutes * 60_000);
    const probes = input.items.map(item => {
      const thread = this.io.create(parent, input, item.label, probeProfile(schema));
      this.store.db.prepare("INSERT INTO fan_out_probes (thread_id,fan_out_id,label,prompt,status) VALUES (?,?,?,?,'queued')").run(thread.id, id, item.label, [input.shared, item.prompt].filter(Boolean).join("\n\n"));
      return { label: item.label, threadId: thread.id };
    });
    this.validators.set(id, check);
    this.refresh(parentId, id);
    return { fanOutId: id, triggerId, probes };
  }
  status(parentId: string, id: string) {
    const batch = this.store.db.prepare("SELECT * FROM fan_outs WHERE id=? AND parent_id=?").get(id, parentId) as unknown as Batch | undefined;
    if (!batch) throw new Error("Fan-out not found for this parent");
    return { fanOutId: id, triggerId: batch.trigger_id, finished: !!batch.finished, deadline: batch.deadline, probes: this.probes(id).map(p => {
      const thread = this.store.thread(p.thread_id);
      const usage = this.store.db.prepare("SELECT COALESCE(SUM(context + output),0) AS tokens FROM usage WHERE thread_id=?").get(p.thread_id) as { tokens: number };
      return { label: p.label, threadId: p.thread_id, status: p.status, account: thread?.account ?? null, tokens: usage.tokens,
        ...(p.result ? { result: JSON.parse(p.result) } : {}), ...(p.raw ? { raw: p.raw } : {}), ...(p.failure ? { failure: p.failure } : {}) };
    }) };
  }
  list(parentId: string) {
    const rows = this.store.db.prepare("SELECT id FROM fan_outs WHERE parent_id=? ORDER BY rowid DESC").all(parentId) as { id: string }[];
    return rows.map(row => this.status(parentId, row.id));
  }
  background(parentId: string) {
    return this.list(parentId).map(batch => ({
      id: batch.fanOutId, kind: "fan_out", ambient: !batch.finished, started_at: null,
      description: `${batch.probes.length} probes · ${batch.probes.filter(p => p.status === "done").length} done${batch.probes.some(p => p.account) ? ` · ${[...new Set(batch.probes.map(p => p.account).filter(Boolean))].join(", ")}` : ""}`,
      ...(this.artifacts ? { url: `${this.artifactUrl.replace(/\/$/, "")}/loom-fan-out-${batch.fanOutId}/results.json` } : {}),
    }));
  }
  /** Batch completion, not just a stopped thread, authorizes retention. */
  retirable(threadId: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM fan_out_probes p JOIN fan_outs b ON b.id=p.fan_out_id WHERE p.thread_id=? AND b.finished<>0 AND p.status NOT IN ('queued','running')").get(threadId);
  }
  retireEmpty(): void {
    const batches = this.store.db.prepare("SELECT * FROM fan_outs WHERE finished<>0").all() as unknown as Batch[];
    for (const b of batches) {
      if (this.probes(b.id).some(p => this.store.thread(p.thread_id))) continue;
      rmSync(join(this.home, "fan-outs", b.id), { recursive: true, force: true });
      if (this.artifacts) rmSync(join(this.artifacts, `loom-fan-out-${b.id}`), { recursive: true, force: true });
      this.store.tx(() => {
        this.store.db.prepare("DELETE FROM fan_out_probes WHERE fan_out_id=?").run(b.id);
        this.store.db.prepare("DELETE FROM fan_outs WHERE id=?").run(b.id);
        if (this.store.thread(b.parent_id)) this.store.updateThread(b.parent_id, { background: this.store.thread(b.parent_id)!.background });
      });
      this.published.delete(b.id);
    }
  }
  private published = new Map<string, string>();
  /** Same task projection as harness background changes, without changing the parent's liveness. */
  private refresh(parentId: string, id: string): void {
    const status = this.status(parentId, id);
    let result = JSON.stringify(status, null, 2);
    // A retained batch may predate artifact publication. Preserve its original account/usage
    // snapshot even if some of its probe rows have already been retired.
    if (status.finished) {
      try {
        const saved = readFileSync(join(this.home, "fan-outs", id, "results.json"), "utf8");
        if (JSON.parse(saved).finished) result = saved;
      } catch { /* Reconstruct from the durable batch if no completed snapshot exists. */ }
    }
    if (this.published.get(id) === result) return;
    for (const folder of [join(this.home, "fan-outs", id), ...(this.artifacts ? [join(this.artifacts, `loom-fan-out-${id}`)] : [])]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, "results.json");
      writeFileSync(`${file}.tmp`, result, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
    }
    this.published.set(id, result);
    if (this.store.thread(parentId)) this.store.tx(() => this.store.updateThread(parentId, { background: this.store.thread(parentId)!.background }));
  }
  private probes(id: string): Probe[] { return this.store.db.prepare("SELECT * FROM fan_out_probes WHERE fan_out_id=? ORDER BY rowid").all(id) as unknown as Probe[]; }
  /** Closed terminal probes cannot be revived by a queued kick after cancellation. */
  canDispatch(id: string): boolean {
    const row = this.store.db.prepare(`SELECT p.status,b.deadline,b.parent_id,b.trigger_id FROM fan_out_probes p JOIN fan_outs b ON p.fan_out_id=b.id WHERE p.thread_id=?`).get(id) as { status: ProbeStatus; deadline: number; parent_id: string; trigger_id: string } | undefined;
    if (!row) return true;
    const parent = this.store.thread(row.parent_id);
    return row.status === "running" && row.deadline > this.store.now() && !!parent && parent.status !== "stopped"
      && this.triggers.list(row.parent_id, "waiting").some(t => t.id === row.trigger_id);
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped || !this.io.ready()) return;
    this.busy = true;
    try {
      const retained = this.store.db.prepare("SELECT id,parent_id FROM fan_outs WHERE finished<>0").all() as { id: string; parent_id: string }[];
      for (const b of retained) if (!this.published.has(b.id)) this.refresh(b.parent_id, b.id);
      const batches = this.store.db.prepare("SELECT * FROM fan_outs WHERE finished=0").all() as unknown as Batch[];
      for (const b of batches) {
        if (this.stopped) return;
        const parent = this.store.thread(b.parent_id), trigger = this.triggers.list().find(t => t.id === b.trigger_id);
        const cancelled = !parent || parent.status === "stopped" || !trigger || trigger.status === "cancelled";
        const expired = b.deadline <= this.store.now();
        for (const p of this.probes(b.id)) {
          if (terminal(p)) { await this.io.close(p.thread_id); continue; }
          if (cancelled || expired) {
            this.finish(p, expired ? "timed_out" : "failed", null, this.partialText(p.thread_id), cancelled ? "cancelled" : "deadline");
            await this.io.stop(p.thread_id); continue;
          }
          const gone = this.gone(p);
          if (gone) {
            this.finish(p, "failed", null, this.partialText(p.thread_id), gone);
            await this.io.close(p.thread_id); continue;
          }
          if (p.status !== "running") continue;
          const runs = this.store.runs(p.thread_id), run = runs.at(-1);
          if (!run || run.status === "running" || run.status === "queued") continue;
          const raw = this.lastText(p.thread_id);
          if (run.status !== "completed") { this.finish(p, "failed", null, raw, run.failure ?? run.status); await this.io.close(p.thread_id); continue; }
          let result: unknown, error: string | undefined;
          try {
            const check = this.validators.get(b.id) ?? compileSchema(JSON.parse(b.schema_json));
            this.validators.set(b.id, check); result = extractResult(raw);
            if (!check(result)) error = JSON.stringify(check.errors);
          } catch (e) { error = String(e); }
          if (error && p.repairs === 0) {
            this.store.tx(() => {
              this.store.db.prepare("UPDATE fan_out_probes SET repairs=1,raw=NULL WHERE thread_id=?").run(p.thread_id);
              this.store.createRun(p.thread_id, "wake", `Your answer didn't match the schema: ${error.slice(0, 4000)}. Reply with corrected JSON only.`);
            });
            void this.io.kick(p.thread_id); continue;
          }
          this.finish(p, error ? "invalid" : "done", error ? null : JSON.stringify(result), error ? raw : null, error ?? null);
          await this.io.close(p.thread_id);
        }
        const probes = this.probes(b.id);
        if (probes.every(terminal)) {
          const result = this.status(b.parent_id, b.id), folder = join(this.home, "fan-outs", b.id), path = join(folder, "results.json");
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          writeFileSync(`${path}.tmp`, JSON.stringify({ ...result, finished: true }, null, 2), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
          const lines = result.probes.map(p => `${p.label}: ${p.status}; account=${p.account}; tokens=${p.tokens}\n${JSON.stringify(p.result ?? { raw: p.raw, failure: p.failure }).slice(0, 4000)}`);
          this.store.tx(() => {
            if (!cancelled && trigger) this.triggers.finishFanOut(trigger, `Fan-out ${b.id} complete. Full results: ${path}\n${lines.join("\n\n").slice(0, 39000)}`);
            this.store.db.prepare("UPDATE fan_outs SET finished=1 WHERE id=?").run(b.id);
          });
          this.validators.delete(b.id);
        } else if (!cancelled && !expired) {
          let room = b.concurrency - probes.filter(p => p.status === "running").length;
          for (const p of probes) if (room > 0 && p.status === "queued") {
            // Closing another probe above yields: a queued thread may have been deleted or stopped since inspection.
            const gone = this.gone(p);
            if (gone) {
              this.finish(p, "failed", null, this.partialText(p.thread_id), gone); continue;
            }
            room--;
            this.store.tx(() => { this.store.db.prepare("UPDATE fan_out_probes SET status='running' WHERE thread_id=?").run(p.thread_id); this.store.createRun(p.thread_id, "wake", p.prompt); });
            void this.io.kick(p.thread_id);
          }
        }
        this.refresh(b.parent_id, b.id);
      }
    } finally { this.busy = false; }
  }
  capture(id: string, text: string): void {
    this.store.db.prepare("UPDATE fan_out_probes SET raw=substr(COALESCE(raw,'') || ?,1,40000) WHERE thread_id=? AND status='running'").run(text, id);
  }
  private partialText(id: string): string {
    const p = this.store.db.prepare("SELECT raw FROM fan_out_probes WHERE thread_id=?").get(id) as { raw: string | null } | undefined;
    return p?.raw || this.lastText(id);
  }
  /** A deleted probe, or a queued one stopped on its own, will never run: dispatch() refuses stopped threads. */
  private gone(p: Probe): string | null {
    const t = this.store.thread(p.thread_id);
    return !t ? "probe deleted" : p.status === "queued" && t.status === "stopped" ? "probe stopped" : null;
  }
  private lastText(id: string): string { return this.store.messages(id).filter(m => m.role === "assistant").at(-1)?.text ?? ""; }
  private finish(p: Probe, status: ProbeStatus, result: string | null, raw: string | null, failure: string | null): void {
    this.store.tx(() => {
      this.store.db.prepare("UPDATE fan_out_probes SET status=?,result=?,raw=?,failure=? WHERE thread_id=?").run(status, result, raw?.slice(0, 40000) ?? null, failure, p.thread_id);
      if (this.store.thread(p.thread_id)) this.store.updateThread(p.thread_id, { settled_at: this.store.now() });
    });
  }
}
