// Loom's read of Tango's memory (docs/specs/loom-context-management.md): what Atlas learned from a thread's runs (the
// desk extracts them, apps/screen/server/desk/loom-memory.ts), read back when the thread's context is rebuilt. Read
// only, through node:sqlite, so Loom takes no Tango package and no native module.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The agent id the desk files Loom threads' memories under. */
export const LOOM_MEMORY_AGENT = "loom";

/** Where Atlas keeps its database, resolved as Atlas resolves it (trimmed, `~` expanded). */
export function atlasPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ATLAS_MEMORY_DB?.trim();
  if (!configured) return join(homedir(), ".tango", "atlas", "memory.db");
  if (configured === "~") return homedir();
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

export type MemoryReader = (threadIds: string[], limit: number) => string[];

/** The most important memories from these threads (a thread and its lead), newest first among equals. Never throws. */
export function atlasReader(path = atlasPath()): MemoryReader {
  return (threadIds, limit) => {
    if (!threadIds.length || !existsSync(path)) return [];
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(
        `SELECT content FROM memories WHERE agent_id = ? AND archived_at IS NULL
           AND json_extract(metadata, '$.thread_id') IN (${threadIds.map(() => "?").join(", ")})
           AND COALESCE(tags, '') NOT LIKE '%"handoff"%'
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      ).all(LOOM_MEMORY_AGENT, ...threadIds, limit) as { content: string }[];
      return rows.map((row) => row.content);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  };
}
