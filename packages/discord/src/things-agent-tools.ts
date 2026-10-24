import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AgentTool } from "@tango/core";
import { runThingsBridge, type ThingsBridge } from "./things-bridge.js";

const id = z.string().regex(/^[A-Za-z0-9-]{1,80}$/);
const kind = z.enum(["todo", "project", "area", "tag"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}, "Expected a valid calendar date");
const lists = ["Inbox", "Today", "Anytime", "Upcoming", "Someday", "Logbook", "Trash"] as const;
const readSchema = z.object({
  operation: z.enum(["doctor", "list", "search", "get", "projects", "areas", "tags"]),
  id: id.optional(),
  list: z.enum(lists).optional(),
  query: z.string().min(1).max(500).optional(),
  project_id: id.optional(),
  area_id: id.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
}).strict().superRefine((p, ctx) => {
  if (p.operation === "get" && !p.id) ctx.addIssue({ code: "custom", message: "get requires id" });
  if (p.operation === "search" && !p.query) ctx.addIssue({ code: "custom", message: "search requires query" });
  if (p.operation === "list" && !p.list && !p.project_id && !p.area_id) ctx.addIssue({ code: "custom", message: "list requires list, project_id or area_id" });
  if ([p.list, p.project_id, p.area_id].filter(Boolean).length > 1) ctx.addIssue({ code: "custom", message: "Choose one list or parent filter" });
  if (p.list && p.operation !== "list") ctx.addIssue({ code: "custom", message: "Built-in list is only valid for the list operation" });
});
const writeSchema = z.object({
  operation: z.enum(["create", "update", "trash"]),
  kind,
  id: id.optional(),
  title: z.string().trim().min(1).max(1000).optional(),
  notes: z.string().max(10_000).optional(),
  tags: z.array(z.string().trim().min(1).max(100).refine((s) => !s.includes(","), "Tag names cannot contain commas")).max(50).optional(),
  project_id: id.optional(),
  area_id: id.optional(),
  when: z.union([date, z.enum(["today", "anytime", "someday", "inbox"])]).optional(),
  deadline: date.nullable().optional(),
  status: z.enum(["open", "completed", "canceled"]).optional(),
  expected_modified: z.number().optional(),
}).strict().superRefine((p, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (p.operation === "create" && (!p.title || p.id || p.expected_modified !== undefined)) bad("create requires title and forbids id/expected_modified");
  if (p.operation !== "create" && !p.id) bad("update/trash requires id");
  if (p.project_id && p.area_id) bad("Choose project_id or area_id");
  if (p.project_id && p.kind !== "todo") bad("Only to-dos can be placed in a project");
  if (p.area_id && !["todo", "project"].includes(p.kind)) bad("Only to-dos/projects can be placed in an area");
  if (["area", "tag"].includes(p.kind) && [p.notes, p.when, p.deadline, p.status].some((v) => v !== undefined)) bad("Areas/tags support title only (areas also support tags)");
  if (p.kind === "tag" && p.tags !== undefined) bad("Tag hierarchy editing is not supported");
  if (p.kind === "project" && p.when === "inbox") bad("Projects cannot be placed in Inbox");
  if (p.when === "inbox" && (p.project_id || p.area_id)) bad("Inbox items cannot also have a parent");
  const changed = [p.title, p.notes, p.tags, p.project_id, p.area_id, p.when, p.deadline, p.status].some((v) => v !== undefined);
  if (p.operation === "update" && !changed) bad("update requires at least one changed field");
  if (p.operation === "trash" && (!["todo", "project"].includes(p.kind) || changed)) bad("trash accepts only a to-do/project ID and no edits");
});
type Write = z.infer<typeof writeSchema>;
type Row = Record<string, unknown>;

export function resolveThingsDatabase(root = join(homedir(), "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac")): string {
  const configured = process.env.THINGS_DATABASE_PATH?.trim();
  if (configured) return configured;
  const suffix = "Things Database.thingsdatabase/main.sqlite";
  const candidates = [join(root, suffix), ...readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("ThingsData-"))
    .map((d) => join(root, d.name, suffix))].filter(existsSync);
  if (candidates.length !== 1) throw new Error("Things database missing or ambiguous. Set THINGS_DATABASE_PATH in the local profile to the active main.sqlite file.");
  return candidates[0]!;
}

function openDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
  return db;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "number" || value === 0) return null;
  return `${value >> 16}-${String((value >> 12) & 15).padStart(2, "0")}-${String((value >> 7) & 31).padStart(2, "0")}`;
}

const TASK_SELECT = `SELECT t.uuid AS id, t.type, t.title, t.notes, t.status,
  t.trashed, t.userModificationDate AS modified, t.start, t.startDate, t.deadline,
  (COALESCE(h.trashed,0) OR COALESCE(p.trashed,0) OR COALESCE(hp.trashed,0)) AS context_trashed,
  t.rt1_recurrenceRule AS recurrence, t.repeater,
  COALESCE(t.project,h.project) AS project_id, COALESCE(t.area,p.area,hp.area) AS area_id,
  t.heading AS heading_id, t."index" AS sort_index
  FROM TMTask t LEFT JOIN TMTask h ON h.uuid=t.heading
  LEFT JOIN TMTask p ON p.uuid=t.project LEFT JOIN TMTask hp ON hp.uuid=h.project`;
const ACTIVE = "t.trashed=0 AND COALESCE(h.trashed,0)=0 AND COALESCE(p.trashed,0)=0 AND COALESCE(hp.trashed,0)=0";

function task(db: DatabaseSync, raw: Row): Row {
  const { type, startDate, deadline, recurrence, repeater, start, context_trashed, sort_index: _sort, ...rest } = raw;
  return { ...rest, kind: ["todo", "project", "heading"][Number(type)],
    status: ({ 0: "open", 2: "canceled", 3: "completed" } as Record<number, string>)[Number(raw.status)] ?? "unknown",
    trashed: Boolean(raw.trashed || context_trashed), start: ["inbox", "anytime", "someday"][Number(start)],
    start_date: isoDate(startDate), deadline: isoDate(deadline), repeating: Boolean(recurrence || repeater),
    tags: db.prepare("SELECT g.title FROM TMTag g JOIN TMTaskTag tt ON tt.tags=g.uuid WHERE tt.tasks=? ORDER BY g.\"index\"").all(String(raw.id)).map((r) => r.title),
    checklist: db.prepare("SELECT uuid AS id,title,status FROM TMChecklistItem WHERE task=? ORDER BY \"index\"").all(String(raw.id))
      .map((r) => ({ ...r, completed: r.status === 3 })),
  };
}

function get(db: DatabaseSync, itemId: string): Row | null {
  const raw = db.prepare(`${TASK_SELECT} WHERE t.uuid=?`).get(itemId);
  if (raw) return task(db, raw);
  for (const [table, k] of [["TMArea", "area"], ["TMTag", "tag"]]) {
    const item = db.prepare(`SELECT uuid AS id,title FROM ${table} WHERE uuid=?`).get(itemId);
    if (item) return { ...item, kind: k, ...(k === "area" ? {
      tags: db.prepare('SELECT g.title FROM TMTag g JOIN TMAreaTag a ON a.tags=g.uuid WHERE a.areas=? ORDER BY g."index"').all(itemId).map((r) => r.title),
    } : {}) };
  }
  return null;
}

export interface ThingsOptions {
  databasePath?: string;
  bridge?: ThingsBridge;
  verificationAttempts?: number;
  verificationDelayMs?: number;
}

export function createThingsTools(options: ThingsOptions = {}): AgentTool[] {
  const bridge = options.bridge ?? runThingsBridge;
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = openDatabase(options.databasePath ?? resolveThingsDatabase());
    try { return fn(db); } finally { db.close(); }
  };
  let queue: Promise<unknown> = Promise.resolve();

  async function read(input: Record<string, unknown>): Promise<unknown> {
    const p = readSchema.parse(input);
    if (p.operation === "doctor") {
      withDb((db) => db.prepare("SELECT uuid FROM TMTask LIMIT 1").get());
      try { return { database_readable: true, ...await bridge({ operation: "doctor" }) }; }
      catch (e) { return { database_readable: true, automation: false, error: (e as Error).message }; }
    }
    if (p.operation === "get") return withDb((db) => {
      const item = get(db, p.id!);
      if (!item) throw new Error("Things item not found");
      return item;
    });
    let listIds: string[] | undefined;
    if (p.list) {
      const result = await bridge({ operation: "list", list: p.list });
      listIds = z.array(id).parse(result.ids);
    }
    return withDb((db) => {
      let rows: Row[];
      if (p.operation === "areas" || p.operation === "tags") {
        const table = p.operation === "areas" ? "TMArea" : "TMTag";
        rows = db.prepare(`SELECT uuid AS id,title FROM ${table} ORDER BY "index",uuid`).all()
          .map((r) => ({ ...r, kind: p.operation === "areas" ? "area" : "tag" }));
      } else if (listIds) {
        // Things owns list membership, localization and ordering; don't approximate Today in SQL.
        rows = listIds.slice(p.offset, p.offset + p.limit).map((itemId) => get(db, itemId)).filter((r): r is Row => r !== null);
        return { items: rows, total: listIds.length, next_offset: p.offset + p.limit < listIds.length ? p.offset + p.limit : null };
      } else {
        const clauses = [ACTIVE, "t.rt1_recurrenceRule IS NULL"];
        const params: SQLInputValue[] = [];
        if (p.operation === "projects") clauses.push("t.type=1 AND t.status=0");
        else if (p.operation === "list") clauses.push("t.status=0");
        if (p.query) { clauses.push("(instr(lower(t.title),lower(?))>0 OR instr(lower(t.notes),lower(?))>0)"); params.push(p.query, p.query); }
        if (p.project_id) { clauses.push("COALESCE(t.project,h.project)=?"); params.push(p.project_id); }
        if (p.area_id) { clauses.push("COALESCE(t.area,p.area,hp.area)=?"); params.push(p.area_id); }
        const sql = `${TASK_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY t."index",t.uuid`;
        const total = Number(db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(...params)!.n);
        rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, p.limit, p.offset).map((r) => task(db, r));
        return { items: rows, total, next_offset: p.offset + p.limit < total ? p.offset + p.limit : null };
      }
      return { items: rows.slice(p.offset, p.offset + p.limit), total: rows.length,
        next_offset: p.offset + p.limit < rows.length ? p.offset + p.limit : null };
    });
  }

  async function write(p: Write): Promise<unknown> {
    const before = withDb((db) => {
      const item = p.id ? get(db, p.id) : null;
      if (p.id && (!item || item.kind !== p.kind)) throw new Error("ID not found or kind does not match; read the item first");
      if (item?.trashed) throw new Error("Item is in Trash; restore it in Things before editing");
      if (item?.repeating) throw new Error("Repeating items must be edited in Things; recurrence writes are not supported");
      if (p.expected_modified !== undefined && item?.modified !== p.expected_modified) throw new Error("Item changed since it was read; refresh before editing");
      for (const [parentId, expected] of [[p.project_id, "project"], [p.area_id, "area"]]) {
        if (!parentId) continue;
        const parent = get(db, parentId);
        if (!parent || parent.kind !== expected || parent.trashed || parent.repeating || (expected === "project" && parent.status !== "open")) throw new Error("Parent is missing, closed, repeating, or the wrong kind");
      }
      if (p.tags) {
        const available = new Set(db.prepare("SELECT title FROM TMTag").all().map((r) => r.title));
        if (p.tags.some((tag) => !available.has(tag))) throw new Error("Unknown tag; create tags explicitly before assigning them");
      }
      return item;
    });
    let result: Row;
    try { result = await bridge(p); }
    catch (error) { return { outcome: "unknown", retry_safe: false, id: p.id ?? null, error: (error as Error).message }; }
    if (result.error || typeof result.id !== "string") return { outcome: "unknown", retry_safe: false, id: result.id ?? null, error: "Things could not confirm the write; read back before retrying." };
    let after: Row | null = null;
    for (let i = 0; i < (options.verificationAttempts ?? 10); i++) {
      try { after = withDb((db) => get(db, String(result.id))); }
      catch { break; } // Preserve the returned ID and uncertain outcome if readback fails.
      if (after && matches(p, after)) return { outcome: "verified", id: result.id, before, after };
      await delay(options.verificationDelayMs ?? 200);
    }
    return { outcome: "unverified", id: result.id, retry_safe: false, before, after,
      error: "Things accepted the command but the local database has not confirmed all requested fields. Read back before retrying. Cloud sync is not verified." };
  }

  return [{
    name: "things_read",
    description: "Read Things on this Mac: doctor, built-in list, project/area contents, search, get item with checklist, projects, areas, tags. Paginated. Built-in lists use Things automation. See agents/tools/things.md.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
      operation: { type: "string", enum: ["doctor", "list", "search", "get", "projects", "areas", "tags"] },
      id: { type: "string" }, list: { type: "string", enum: [...lists] }, query: { type: "string" },
      project_id: { type: "string" }, area_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
    } }, handler: read,
  }, {
    name: "things_write",
    description: "Write Things through the Mac app: create/update to-dos, projects, areas and tags; schedule, move, complete/cancel/reopen; trash to-dos/projects (including children). IDs required for updates. No recurrence or checklist writes. Returns verified only after local DB readback; never proves cloud sync. Never blindly retry unknown/unverified outcomes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation", "kind"], properties: {
      operation: { type: "string", enum: ["create", "update", "trash"] }, kind: { type: "string", enum: ["todo", "project", "area", "tag"] },
      id: { type: "string" }, title: { type: "string" }, notes: { type: "string" }, tags: { type: "array", items: { type: "string" } },
      project_id: { type: "string" }, area_id: { type: "string" }, when: { type: "string", description: "YYYY-MM-DD, today, anytime, someday, inbox" },
      deadline: { type: ["string", "null"], description: "YYYY-MM-DD; null clears" }, status: { type: "string", enum: ["open", "completed", "canceled"] },
      expected_modified: { type: "number", description: "Optional modified value from things_read for stale-read protection" },
    } },
    async handler(input) {
      const parsed = writeSchema.parse(input);
      const result = queue.then(() => write(parsed));
      queue = result.catch(() => {});
      return result;
    },
  }];
}

function matches(p: Write, row: Row): boolean {
  if (p.operation === "trash") return row.trashed === true;
  if (row.kind !== p.kind) return false;
  if (p.kind === "todo" && p.area_id && row.project_id !== null) return false;
  for (const key of ["title", "notes", "deadline", "status", "project_id", "area_id"] as const) {
    if (p[key] !== undefined && row[key] !== p[key]) return false;
  }
  if (p.tags && JSON.stringify([...p.tags].sort()) !== JSON.stringify([...(row.tags as string[])].sort())) return false;
  if (p.when) {
    if (p.when === "today") {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (row.start_date !== today) return false;
    } else if (["inbox", "anytime", "someday"].includes(p.when)) {
      if (row.start !== p.when || row.start_date !== null) return false;
    } else if (row.start_date !== p.when) return false;
  }
  return true;
}
