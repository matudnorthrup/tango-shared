import type { DatabaseSync } from "node:sqlite";

// Catch-up (docs/specs/catch-up.md): what a lead writes for the owner's catch-up instead of retelling it in chat.
// Loom keeps it; the desk reads it (GET /updates) into its update ledger, files each line in the space of the
// conversation it came from, and keeps the owner's seen marks. Two things a lead writes:
//   desk_update   a typed line of news (needs | failed | decided | shipped | fyi), U-<n>
//   chapter_note  the space's chapter headline and status: metadata, never a line of news, N-<n>

export const UPDATE_KINDS = ["needs", "failed", "decided", "shipped", "fyi"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];

export const CATCHUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_updates (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  moment INTEGER,
  refs TEXT NOT NULL DEFAULT '[]',
  shot TEXT,
  supersedes TEXT,
  covers_from INTEGER,
  covers_to INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_updates_at ON lead_updates(created_at, seq);
CREATE TABLE IF NOT EXISTS chapter_notes (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  headline TEXT,
  status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chapter_notes_at ON chapter_notes(created_at, seq);
CREATE TABLE IF NOT EXISTS catchup_seq (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
INSERT OR IGNORE INTO catchup_seq (id, last) VALUES (1, 0);
`;

export interface LeadUpdateRow {
  id: string;
  seq: number;
  thread_id: string;
  run_id: string | null;
  kind: UpdateKind;
  title: string;
  detail: string | null;
  moment: number | null;
  refs: string;
  shot: string | null;
  supersedes: string | null;
  covers_from: number | null;
  covers_to: number | null;
  created_at: number;
}

export interface ChapterNoteRow {
  id: string;
  seq: number;
  thread_id: string;
  headline: string | null;
  status: string | null;
  created_at: number;
}

const MAX_TITLE = 160;
const MAX_DETAIL = 600;
const MAX_NOTE = 400;
const WORDS_TITLE = 20;

const flat = (text: unknown) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
const isUrl = (text: string) => /^https?:\/\/\S+$/.test(text);

export interface UpdateInput { kind?: unknown; title?: unknown; detail?: unknown; moment?: unknown; refs?: unknown; shot?: unknown; supersedes?: unknown }

/** A desk_update as a lead sent it: the line to keep, or what's wrong with it (said back to the lead). */
export function lintUpdate(input: UpdateInput): { errors: string[]; update: Pick<LeadUpdateRow, "kind" | "title" | "detail" | "moment" | "shot" | "supersedes"> & { refs: Array<{ label: string; url: string }> } } {
  const errors: string[] = [];
  const kind = UPDATE_KINDS.find((k) => k === input.kind);
  if (!kind) errors.push(`kind must be one of ${UPDATE_KINDS.join(", ")} (a chapter's headline or status goes in chapter_note)`);
  const title = flat(input.title);
  if (!title) errors.push("title is required: one finished sentence");
  else if (title.length > MAX_TITLE || title.split(" ").length > WORDS_TITLE) errors.push(`title is at most ${WORDS_TITLE} words: put the rest in detail`);
  const detail = flat(input.detail) || null;
  if (detail && detail.length > MAX_DETAIL) errors.push(`detail is at most ${MAX_DETAIL} characters: one or two sentences`);
  if (input.moment !== undefined && typeof input.moment !== "boolean") errors.push("moment must be true or false");
  const refs: Array<{ label: string; url: string }> = [];
  if (input.refs !== undefined) {
    if (!Array.isArray(input.refs) || input.refs.length > 6) errors.push("refs must be up to 6 links");
    else for (const ref of input.refs as Array<{ label?: unknown; url?: unknown }>) {
      const url = flat(ref?.url);
      if (!isUrl(url) || /\/\/(localhost|127\.0\.0\.1)/.test(url)) { errors.push(`refs: ${url || "a link"} isn't a URL the owner can open (never localhost)`); continue; }
      refs.push({ label: flat(ref?.label).slice(0, 60) || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), url });
    }
  }
  const shot = flat(input.shot) || null;
  if (shot && (!isUrl(shot) || /\/\/(localhost|127\.0\.0\.1)/.test(shot))) errors.push("shot must be an image URL the owner can open (never localhost)");
  const supersedes = flat(input.supersedes) || null;
  if (supersedes && !/^U-\d+$/.test(supersedes)) errors.push("supersedes is the id of an earlier desk_update (U-<n>)");
  return { errors, update: { kind: kind ?? "fyi", title, detail, moment: typeof input.moment === "boolean" ? (input.moment ? 1 : 0) : null, shot, supersedes, refs } };
}

/** A chapter_note: a headline, a status, or both; what's wrong with it otherwise. */
export function lintNote(input: { headline?: unknown; status?: unknown }): { errors: string[]; note: { headline: string | null; status: string | null } } {
  const errors: string[] = [];
  const headline = flat(input.headline) || null;
  const status = flat(input.status) || null;
  if (!headline && !status) errors.push("give a headline, a status, or both");
  for (const [name, text] of [["headline", headline], ["status", status]] as const) if (text && text.length > MAX_NOTE) errors.push(`${name} is at most ${MAX_NOTE} characters: one or two sentences`);
  return { errors, note: { headline, status } };
}

export class CatchupStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {
    db.exec(CATCHUP_SCHEMA);
  }

  private next(): number {
    return (this.db.prepare("UPDATE catchup_seq SET last = last + 1 WHERE id = 1 RETURNING last").get() as { last: number }).last;
  }

  update(id: string): LeadUpdateRow | null {
    return (this.db.prepare("SELECT * FROM lead_updates WHERE id = ?").get(id) as unknown as LeadUpdateRow | undefined) ?? null;
  }

  addUpdate(row: Omit<LeadUpdateRow, "id" | "seq" | "created_at" | "refs"> & { refs: Array<{ label: string; url: string }> }): LeadUpdateRow {
    const seq = this.next();
    const id = `U-${seq}`;
    this.db
      .prepare("INSERT INTO lead_updates (id, seq, thread_id, run_id, kind, title, detail, moment, refs, shot, supersedes, covers_from, covers_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, seq, row.thread_id, row.run_id, row.kind, row.title, row.detail, row.moment, JSON.stringify(row.refs), row.shot, row.supersedes, row.covers_from, row.covers_to, this.now());
    return this.update(id)!;
  }

  /**
   * A run's lines cover its words through the run's end, the final reply included. Each is sequenced again, so the
   * desk reads the new span.
   */
  closeRun(runId: string, at: number): void {
    for (const { id } of this.db.prepare("SELECT id FROM lead_updates WHERE run_id = ? AND covers_to IS NOT NULL AND covers_to < ?").all(runId, at) as Array<{ id: string }>) {
      this.db.prepare("UPDATE lead_updates SET covers_to = ?, seq = ? WHERE id = ?").run(at, this.next(), id);
    }
  }

  addNote(row: Omit<ChapterNoteRow, "id" | "seq" | "created_at">): ChapterNoteRow {
    const seq = this.next();
    const id = `N-${seq}`;
    this.db.prepare("INSERT INTO chapter_notes (id, seq, thread_id, headline, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, seq, row.thread_id, row.headline, row.status, this.now());
    return this.db.prepare("SELECT * FROM chapter_notes WHERE id = ?").get(id) as unknown as ChapterNoteRow;
  }

  /** What leads wrote after `after` (a seq): the desk pages through it by seq, so nothing written in one ms is lost. */
  since(after: number, limit = 200): { updates: Array<Omit<LeadUpdateRow, "refs"> & { refs: Array<{ label: string; url: string }> }>; notes: ChapterNoteRow[]; last: number; more: boolean } {
    const updates = this.db.prepare("SELECT * FROM lead_updates WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit + 1) as unknown as LeadUpdateRow[];
    const notes = this.db.prepare("SELECT * FROM chapter_notes WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit + 1) as unknown as ChapterNoteRow[];
    // One page ends where the shorter list's limit does, so neither skips past the other.
    const merged = [...updates.map((u) => u.seq), ...notes.map((n) => n.seq)].sort((a, b) => a - b);
    const more = merged.length > limit;
    const last = more ? merged[limit - 1]! : (merged.at(-1) ?? after);
    return {
      updates: updates.filter((u) => u.seq <= last).map((u) => ({ ...u, refs: JSON.parse(u.refs) as Array<{ label: string; url: string }> })),
      notes: notes.filter((n) => n.seq <= last),
      last,
      more,
    };
  }
}

/** The lead's standing instructions on catch-up (spec "Leads stop retelling"), added to every space default's. */
export { CATCHUP_LEAD_GUIDANCE } from "./instructions.js";

/** Reads the seen block for a lead's turn from the desk (GET /api/desk/catchup/seen); null when it has none or can't answer. */
export function deskSeenBrief(deskUrl: string, timeoutMs = 3000): (threadId: string, since: number) => Promise<string | null> {
  const base = deskUrl.replace(/\/$/, "");
  return async (threadId, since) => {
    const response = await fetch(`${base}/api/desk/catchup/seen?itemId=${encodeURIComponent(`loom:${threadId}`)}&since=${since}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as { text?: string | null };
    return typeof body.text === "string" && body.text.trim() ? body.text.trim() : null;
  };
}
