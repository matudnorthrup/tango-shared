import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface DeskDevice { token: string; platform: 'ios'; bundleId: string; environment: 'sandbox' | 'production' }
export function parseDevice(value: unknown): DeskDevice | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (typeof d.token !== 'string' || !/^[a-f0-9]{32,512}$/i.test(d.token) || d.platform !== 'ios'
    || typeof d.bundleId !== 'string' || !/^[A-Za-z0-9.-]{3,255}$/.test(d.bundleId)
    || !['sandbox', 'production'].includes(String(d.environment))) return null;
  return { token: d.token.toLowerCase(), platform: 'ios', bundleId: d.bundleId, environment: d.environment as DeskDevice['environment'] };
}

/** Private device tokens and delivery receipts share screen.db's lifetime. Never returned by a read API. */
export class DeskDevices {
  readonly id: string;
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS desk_devices (
      token TEXT NOT NULL, bundle_id TEXT NOT NULL, environment TEXT NOT NULL, registered_at INTEGER NOT NULL,
      PRIMARY KEY(token, bundle_id, environment));
      CREATE TABLE IF NOT EXISTS desk_push_receipts (
      device TEXT NOT NULL, brief TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(device, brief, revision));
      CREATE TABLE IF NOT EXISTS desk_push_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);`);
    const columns = db.prepare('PRAGMA table_info(desk_devices)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'registered_at')) {
      // Older devices have no known registration time: start their cutoff at migration.
      db.exec('BEGIN');
      try {
        db.exec('ALTER TABLE desk_devices ADD COLUMN registered_at INTEGER NOT NULL DEFAULT 0');
        db.prepare('UPDATE desk_devices SET registered_at = ?').run(Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.prepare('INSERT OR IGNORE INTO desk_push_identity VALUES (1, ?)').run(randomUUID());
    this.id = (db.prepare('SELECT id FROM desk_push_identity WHERE singleton = 1').get() as { id: string }).id;
  }
  key(d: DeskDevice): string { return `${d.environment}:${d.bundleId}:${d.token}`; }
  register(d: DeskDevice): void {
    this.db.prepare('INSERT OR IGNORE INTO desk_devices (token, bundle_id, environment, registered_at) VALUES (?, ?, ?, ?)').run(d.token, d.bundleId, d.environment, Date.now());
  }
  all(): (DeskDevice & { registeredAt: number })[] {
    return (this.db.prepare('SELECT token, bundle_id AS bundleId, environment, registered_at AS registeredAt FROM desk_devices').all() as (Omit<DeskDevice, 'platform'> & { registeredAt: number })[]).map(d => ({ ...d, platform: 'ios' }));
  }
  drop(d: DeskDevice): void {
    this.db.prepare('DELETE FROM desk_devices WHERE token = ? AND bundle_id = ? AND environment = ?').run(d.token, d.bundleId, d.environment);
    this.db.prepare('DELETE FROM desk_push_receipts WHERE device = ?').run(this.key(d));
  }
  sent(d: DeskDevice, brief: string, revision: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM desk_push_receipts WHERE device = ? AND brief = ? AND revision = ?').get(this.key(d), brief, revision);
  }
  mark(d: DeskDevice, brief: string, revision: number): void {
    this.db.prepare('INSERT OR IGNORE INTO desk_push_receipts VALUES (?, ?, ?)').run(this.key(d), brief, revision);
  }
}
