import { DatabaseSync } from "node:sqlite";

export class LoomAlreadyRunningError extends Error {
  constructor(path: string) {
    super(`Another Loom process owns ${path}`);
  }
}

/**
 * Hold an exclusive SQLite lock on `path` for the life of this process, so
 * only one Loom can own a state directory. The OS drops the lock when the
 * process exits, even on SIGKILL.
 *
 * Same approach as T3 Code's server ownership lock
 * (apps/server/src/serverOwnership.ts, pingdotgg/t3code@d09a9ead, MIT).
 */
export function acquireOwnership(path: string): { release(): void } {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new LoomAlreadyRunningError(path);
  }
  return {
    release() {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already released.
      }
      db.close();
    },
  };
}
