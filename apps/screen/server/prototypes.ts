import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseBundleRef } from './bundles.js';
import { migrateLoomAssetOwners } from './store.js';

// Prototypes: the interactive counterpart of scenes. A scene is a glance (a
// poster the owner reads from across the room); a prototype is the real thing,
// a clickable page the owner uses, or asks the operator to drive ("scroll
// down", "click Continue", "go back"). They live in their own table and their
// own desk view (Prototype), so nothing about scenes changes.
//
// A prototype is an uploaded bundle page (`bundles/<id>/<file>`, which the
// screen serves with the navigation bridge injected) or an http(s) URL (a dev
// server on the tailnet: shown and clickable, but the operator can't drive it).
// One live prototype per (conversation, agent, name); publishing again replaces
// it in place with the next version.

export interface Prototype {
  id: string;
  agentId: string;
  agentName: string;
  conversationKey: string;
  name: string;
  title: string;
  /** `bundles/<id>/<file>` or an http(s) URL. */
  url: string;
  version: number;
  status: 'live' | 'cleared' | 'expired';
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface PublishInput {
  agentId: string;
  agentName?: string;
  conversationKey: string;
  name?: string;
  title?: string;
  url: string;
  ttlMinutes?: number;
}

export interface PublicPrototype {
  id: string;
  agentId: string;
  agentName: string;
  conversationKey: string;
  name: string;
  title: string;
  url: string;
  /** Served by the screen with the navigation bridge: the operator can scroll and click it. */
  drivable: boolean;
  version: number;
  updatedAt: number;
}

/** Prototypes outlive glance scenes: they're worked on for days. */
const DEFAULT_TTL_MINUTES = 3 * 24 * 60;
const MAX_TTL_MINUTES = 14 * 24 * 60;
const RETENTION_MS = 30 * 86_400_000;

interface Row {
  id: string;
  agent_id: string;
  agent_name: string;
  conversation_key: string;
  name: string;
  title: string;
  url: string;
  version: number;
  status: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function toPrototype(row: Row): Prototype {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    conversationKey: row.conversation_key,
    name: row.name,
    title: row.title,
    url: row.url,
    version: row.version,
    status: row.status as Prototype['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export function isDrivable(prototype: Pick<Prototype, 'url'>): boolean {
  return parseBundleRef(prototype.url) !== null;
}

export function publicPrototype(prototype: Prototype): PublicPrototype {
  return {
    id: prototype.id,
    agentId: prototype.agentId,
    agentName: prototype.agentName,
    conversationKey: prototype.conversationKey,
    name: prototype.name,
    title: prototype.title,
    url: prototype.url,
    drivable: isDrivable(prototype),
    version: prototype.version,
    updatedAt: prototype.updatedAt,
  };
}

export class PrototypeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prototypes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'live',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS prototypes_live_name ON prototypes(conversation_key, agent_id, name) WHERE status = 'live';
    `);
    this.db.exec('SAVEPOINT migrate_loom_prototypes');
    try {
      migrateLoomAssetOwners(this.db, 'prototypes', 'name');
      this.db.exec('RELEASE migrate_loom_prototypes');
    } catch (err) {
      this.db.exec('ROLLBACK TO migrate_loom_prototypes');
      this.db.exec('RELEASE migrate_loom_prototypes');
      throw err;
    }

  }

  /** Publishes a prototype; the same conversation + agent + name replaces the live one in place. */
  publish(input: PublishInput): { prototype: Prototype; replaced: boolean } {
    const now = this.now();
    const name = input.name?.trim() || 'main';
    const ttl = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_TTL_MINUTES, 1), MAX_TTL_MINUTES);
    const agentName = input.agentName?.trim() || input.agentId;
    const title = input.title?.trim() ?? '';
    const existing = this.db
      .prepare("SELECT * FROM prototypes WHERE conversation_key = ? AND agent_id = ? AND name = ? AND status = 'live'")
      .get(input.conversationKey, input.agentId, name) as Row | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE prototypes SET agent_name = ?, title = ?, url = ?, version = version + 1, updated_at = ?, expires_at = ? WHERE id = ?')
        .run(agentName, title, input.url, now, now + ttl * 60_000, existing.id);
      return { prototype: this.get(existing.id)!, replaced: true };
    }
    const id = `p${randomUUID().replace(/-/g, '').slice(0, 11)}`;
    this.db
      .prepare(
        `INSERT INTO prototypes (id, agent_id, agent_name, conversation_key, name, title, url, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, agentName, input.conversationKey, name, title, input.url, now, now, now + ttl * 60_000);
    return { prototype: this.get(id)!, replaced: false };
  }

  get(id: string): Prototype | null {
    const row = this.db.prepare('SELECT * FROM prototypes WHERE id = ?').get(id) as Row | undefined;
    return row ? toPrototype(row) : null;
  }

  /** Live and not past its expiry (the sweep may not have run yet). */
  isLive(id: string | null | undefined): boolean {
    if (!id) return false;
    const prototype = this.get(id);
    return !!prototype && prototype.status === 'live' && prototype.expiresAt > this.now();
  }

  /** A conversation's live prototypes, most recently updated first. */
  liveForConversation(conversationKey: string): Prototype[] {
    return (
      this.db
        .prepare("SELECT * FROM prototypes WHERE status = 'live' AND conversation_key = ? AND expires_at > ? ORDER BY updated_at DESC")
        .all(conversationKey, this.now()) as unknown as Row[]
    ).map(toPrototype);
  }

  /** Live prototypes, most recently updated first; one agent's when given. */
  live(agentId?: string): Prototype[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM prototypes WHERE status = 'live' AND agent_id = ? AND expires_at > ? ORDER BY updated_at DESC").all(agentId, this.now())
      : this.db.prepare("SELECT * FROM prototypes WHERE status = 'live' AND expires_at > ? ORDER BY updated_at DESC").all(this.now());
    return (rows as unknown as Row[]).map(toPrototype);
  }

  clear(id: string): Prototype | null {
    this.db.prepare("UPDATE prototypes SET status = 'cleared', updated_at = ? WHERE id = ? AND status = 'live'").run(this.now(), id);
    return this.get(id);
  }

  /** Expires overdue prototypes and prunes old rows. Returns the ids that just expired. */
  sweep(): string[] {
    const now = this.now();
    const expired = (this.db.prepare("SELECT id FROM prototypes WHERE status = 'live' AND expires_at <= ?").all(now) as Array<{ id: string }>).map((row) => row.id);
    if (expired.length) this.db.prepare("UPDATE prototypes SET status = 'expired' WHERE status = 'live' AND expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM prototypes WHERE status != 'live' AND updated_at < ?").run(now - RETENTION_MS);
    return expired;
  }

  /** Bundle ids any kept prototype still points at, so the bundle sweep leaves them. */
  bundleIds(): Set<string> {
    const rows = this.db.prepare("SELECT url FROM prototypes WHERE url LIKE 'bundles/%'").all() as Array<{ url: string }>;
    return new Set(rows.map((row) => row.url.split('/')[1]!).filter(Boolean));
  }
}
