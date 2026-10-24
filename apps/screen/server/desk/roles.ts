import type { DatabaseSync } from 'node:sqlite';
import { THREAD_ROLES, type ThreadRole } from './types.js';

// Thread roles (docs/specs/resilient-runtime.md "Thread roles"): who a conversation works for, and the
// conversation that started it. Kept on the desk, keyed by item id, so a role set at start holds before
// the source first reports the thread. A thread another conversation started (desk_mail kind 'start')
// is a worker under its starter unless a role was set for it. Loom will keep these on its threads
// (role, parent_thread_id); the desk then follows Loom and keeps this table for Loom and Discord.

export interface RoleRecord {
  role: ThreadRole;
  parentItemId: string | null;
}

export const isThreadRole = (value: unknown): value is ThreadRole => typeof value === 'string' && (THREAD_ROLES as readonly string[]).includes(value);

export class DeskRoles {
  private cache: Map<string, RoleRecord> | null = null;

  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS desk_roles (item_id TEXT PRIMARY KEY, role TEXT NOT NULL, parent_item TEXT, by TEXT NOT NULL, at INTEGER NOT NULL)');
  }

  /** Sets a conversation's role, and its parent when given (null clears it). */
  set(itemId: string, change: { role: ThreadRole; parentItemId?: string | null }, by: string, at: number): RoleRecord {
    const current = this.get(itemId);
    const parentItemId = change.parentItemId === undefined ? current.parentItemId : change.parentItemId;
    this.db.prepare('INSERT OR REPLACE INTO desk_roles (item_id, role, parent_item, by, at) VALUES (?, ?, ?, ?, ?)').run(itemId, change.role, parentItemId, by, at);
    this.cache = null;
    return { role: change.role, parentItemId };
  }

  /** The source (Loom) keeps this conversation's role: recorded when it differs, never written again otherwise. */
  follow(itemId: string, record: RoleRecord): boolean {
    const current = this.get(itemId);
    if (current.role === record.role && current.parentItemId === record.parentItemId) return false;
    this.set(itemId, record, 'source', Date.now());
    return true;
  }

  /** Set explicitly (by the owner, an agent or the source), not inferred from a start. */
  isSet(itemId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM desk_roles WHERE item_id = ?').get(itemId);
  }

  get(itemId: string): RoleRecord {
    return this.all().get(itemId) ?? { role: 'interactive', parentItemId: null };
  }

  /** Every conversation with a role other than the default or a parent. Started threads first, set roles over them. */
  all(): Map<string, RoleRecord> {
    if (this.cache) return this.cache;
    const map = new Map<string, RoleRecord>();
    try {
      const started = this.db.prepare("SELECT to_item, from_item FROM desk_mail WHERE kind = 'start' ORDER BY created_at").all() as Array<{ to_item: string; from_item: string }>;
      for (const row of started) map.set(row.to_item, { role: 'worker', parentItemId: row.from_item });
    } catch {
      /* no desk_mail table yet (mail isn't set up) */
    }
    const set = this.db.prepare('SELECT item_id, role, parent_item FROM desk_roles').all() as Array<{ item_id: string; role: string; parent_item: string | null }>;
    for (const row of set) if (row.role === 'coordinator') row.role = 'default'; // renamed (spaces.md)
    for (const row of set) if (isThreadRole(row.role)) map.set(row.item_id, { role: row.role, parentItemId: row.parent_item });
    this.cache = map;
    return map;
  }

  /** A thread was started (desk_mail changed underneath): read again. */
  invalidate(): void {
    this.cache = null;
  }
}
