// Fresh sessions (docs/specs/loom-context-management.md): at a seam, a thread stops resuming its native transcript
// and starts a new session from what it carries (Loom's state, the agent's handoff, where the old transcript is).
// The transcript is a cache; Loom's store and git are the record.
import { randomUUID } from "node:crypto";
import type { LoomStore } from "./store.js";

/** "workers": on for worker threads and shadow for every other role, the rollout's middle step. */
export type FreshMode = "off" | "shadow" | "workers" | "on";

export interface FreshPolicy {
  mode: FreshMode;
  /** Context past which a finished run is followed by a handoff and a fresh session. */
  soft: number;
  /** After this long idle the prompt cache is cold, so resuming re-writes the whole context anyway... */
  idleMs: number;
  /** ...and a thread past this much context starts fresh instead. */
  idleMin: number;
}

export function freshPolicy(env: NodeJS.ProcessEnv = process.env): FreshPolicy {
  const mode = env.LOOM_FRESH_SESSIONS === "on" || env.LOOM_FRESH_SESSIONS === "off" || env.LOOM_FRESH_SESSIONS === "workers" ? env.LOOM_FRESH_SESSIONS : "shadow";
  const num = (key: string, fallback: number) => (Number.isFinite(Number(env[key])) && Number(env[key]) > 0 ? Number(env[key]) : fallback);
  return { mode, soft: num("LOOM_FRESH_SOFT", 150_000), idleMs: num("LOOM_FRESH_IDLE_MS", 3_600_000), idleMin: num("LOOM_FRESH_IDLE_MIN", 80_000) };
}

/** The mode one thread runs under: "workers" resolves to on for a worker and shadow for everything else. */
export function freshModeFor(mode: FreshMode, role: string): "off" | "shadow" | "on" {
  return mode === "workers" ? (role === "worker" ? "on" : "shadow") : mode;
}

/** Why a thread starts fresh: stored on the thread until the next session opens (threads.fresh). */
export interface FreshReason {
  reason: "soft-threshold" | "cold-cache" | "task-done" | "owner" | "budget" | "worktree";
  context: number;
  at: number;
  /** The session it leaves, so the new one can find its transcript. */
  previousSession: string | null;
  /** Durable promotion seam: save on the old cwd, then allocate before opening the next session. */
  worktree?: { stage: "handoff" | "ready" | "moved"; previousCwd: string; dirty?: string };
}

/** The one turn Loom sends a session before it is reset: write the handoff, nothing else. */
export const HANDOFF_PROMPT = [
  "Loom: this session's context is large, so Loom will start a fresh session for this thread after this turn.",
  "Call `loom.save_handoff` once with your handoff: what this thread is for and where it stands, the decisions made and why, the next concrete step, and the files, PRs and docs that matter.",
  "If this session began from an earlier handoff, fold it in and drop what is finished: the handoff is this thread's rolling summary, and a lead's is the summary its workers start from.",
  "Loom carries the thread's waits, briefs, open ask, background tasks and worktree itself; don't repeat them. Don't do any other work in this turn, and reply with one line.",
].join(" ");

export const HANDOFFS_SCHEMA = `
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, native_session_id TEXT,
  created_at INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_thread ON handoffs(thread_id, created_at);
`;

export interface HandoffInput {
  summary: string;
  decisions?: string;
  next?: string;
  files?: string;
}

/** Each part's cap: a handoff is a page, not a transcript. */
const PART_MAX = 6_000;
const clip = (text: string) => (text.length > PART_MAX ? `${text.slice(0, PART_MAX - 1).trimEnd()}…` : text);

export function renderHandoff(input: HandoffInput): string {
  const parts: [string, string | undefined][] = [["Where it stands", input.summary], ["Decisions", input.decisions], ["Next", input.next], ["Files, PRs and docs", input.files]];
  return parts.filter(([, text]) => text && text.trim()).map(([title, text]) => `### ${title}\n${clip(text!.trim())}`).join("\n\n");
}

export class Handoffs {
  constructor(private readonly store: LoomStore) {
    store.db.exec(HANDOFFS_SCHEMA);
  }
  save(threadId: string, nativeSessionId: string | null, input: HandoffInput): string {
    const id = randomUUID();
    this.store.db.prepare("INSERT INTO handoffs VALUES (?, ?, ?, ?, ?)").run(id, threadId, nativeSessionId, this.store.now(), renderHandoff(input));
    return id;
  }
  latest(threadId: string): { body: string; created_at: number; native_session_id: string | null } | undefined {
    return this.store.db.prepare("SELECT body, created_at, native_session_id FROM handoffs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId) as { body: string; created_at: number; native_session_id: string | null } | undefined;
  }
}

const k = (n: number) => `${Math.round(n / 1000)}k`;

export function describeFresh(fresh: FreshReason): string {
  const why = { "soft-threshold": "context past the soft threshold", "cold-cache": "idle past the cache, with a large context", "task-done": "its task is done", owner: "the owner asked", budget: "past 80% of its daily budget", worktree: "moving into its own worktree" }[fresh.reason];
  return `Fresh session (context ${k(fresh.context)}; ${why})`;
}

/** The first words of a fresh session: what it carries, then the run's own text follows. */
export function freshPacket(input: { fresh: FreshReason; carry: string; handoff?: { body: string; created_at: number } | null; replies?: { text: string; at: number }[]; transcript: string | null; lead?: boolean }): string {
  const lines = [
    "Loom: this is a fresh session for an existing thread. The earlier conversation is not in your context; what you need from it is below.",
    "",
    input.carry,
  ];
  if (input.fresh.worktree) lines.push("", "# Worktree move", `The original checkout is ${input.fresh.worktree.previousCwd}. Uncommitted changes were NOT carried over.`, input.fresh.worktree.dirty || "The checkout had no uncommitted changes.");
  if (input.handoff) lines.push("", `# Your handoff from the previous session (${new Date(input.handoff.created_at).toISOString().replace(/\.\d+Z$/, "Z")})`, input.handoff.body);
  else lines.push("", "# No handoff was saved");
  // An idle reset has no handoff turn (the cache is cold, so one would re-read the whole old session). A lead's
  // handoff is what its workers start from, so the fresh session writes one once it has caught up.
  if (!input.handoff && input.lead) lines.push("", "This thread has workers, and they start from its handoff. Once you have handled this turn, call `loom.save_handoff` once with where the thread stands.");
  const replies = input.replies ?? [];
  if (replies.length) {
    lines.push("", input.handoff ? "# What the previous session said after its handoff, oldest first" : "The previous session's last replies follow, oldest first; with the owner's latest messages above, they say where the work stood.");
    for (const reply of replies) lines.push("", `## ${new Date(reply.at).toISOString().replace(/\.\d+Z$/, "Z")}`, reply.text.length > 4_000 ? `${reply.text.slice(0, 3_999).trimEnd()}…` : reply.text);
  }
  if (!input.transcript && input.fresh.previousSession) lines.push("", `The previous native session id is ${input.fresh.previousSession}; use its transcript if the handoff lacks a needed detail.`);
  if (input.transcript) lines.push("", `The full earlier transcript is ${input.transcript}. Search it (grep) only for a detail the handoff doesn't have; don't read it whole.`);
  return lines.join("\n");
}
