import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SceneKind = 'html' | 'image' | 'video' | 'url' | 'markdown';
export const SCENE_KINDS: readonly SceneKind[] = ['html', 'image', 'video', 'url', 'markdown'];

export interface SceneChoice {
  id: string;
  label: string;
}

/** Where the scene came from, so input on it can go back to that conversation. */
export interface SceneOrigin {
  channelId?: string;
  threadId?: string;
  conversationKey?: string;
  /** Staged by an agent on this machine with a Google URL: the frame may read it with the owner's Google accounts. */
  googleRead?: true;
  /** Staged by an agent on this machine with a Linear URL: the frame may read it with the owner's Linear keys. */
  linearRead?: true;
}

export interface Scene {
  id: string;
  agentId: string;
  /**
   * The conversation that owns it: `thread:<id>`, `channel:<id>`, `loom:<id>`, or
   * `agent:<agentId>` when staged outside a conversation. A live scene is unique
   * per (conversation, agent, slot).
   */
  conversationKey: string;
  agentName: string;
  slot: string;
  kind: SceneKind;
  title: string;
  body: string;
  summary: string;
  choices: SceneChoice[];
  state: Record<string, unknown>;
  urgent: boolean;
  origin: SceneOrigin;
  version: number;
  status: 'live' | 'cleared' | 'expired';
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface StageInput {
  agentId: string;
  agentName?: string;
  slot?: string;
  kind: SceneKind;
  title?: string;
  body: string;
  summary: string;
  choices?: SceneChoice[];
  state?: Record<string, unknown>;
  urgent?: boolean;
  ttlMinutes?: number;
  origin?: SceneOrigin;
}

export interface SceneEvent {
  id: number;
  sceneId: string;
  agentId: string;
  type: string;
  data: Record<string, unknown>;
  routed: string;
  createdAt: number;
  /** Client-supplied (or generated) id: replays of one tap return the first outcome. */
  commandId: string | null;
  conversationKey: string | null;
  status: InputStatus;
  updatedAt: number;
}

/**
 * routing → pending (sent to the operator, waiting for its ack) → acknowledged;
 * pending → fallback (no ack in time, sent to the agent's conversation instead);
 * delivered (an operator without acks, or straight to the agent); failed.
 */
export type InputStatus = 'routing' | 'pending' | 'acknowledged' | 'fallback' | 'delivered' | 'failed';

/** Files an image or video scene may import into the asset store. */
export const MEDIA_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm', '.mov', '.m4v'];

/** An asset import refused because of where the file lives or what it is. */
export class AssetRejected extends Error {}

/**
 * Folders an agent may stage local media from: the screen's profile data dir,
 * the agentic-workflow artifacts dir, the OS temp dir, plus colon-separated
 * SCREEN_ASSET_ROOTS. Anything else (dotfiles, keys, the repo) is refused.
 */
export function defaultAssetRoots(profileDataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.SCREEN_ASSET_ROOTS ?? '').split(':').map((root) => root.trim()).filter((root) => path.isAbsolute(root));
  return [profileDataDir, path.join(os.homedir(), '.agentic-workflow', 'artifacts'), os.tmpdir(), ...extra];
}

function realRoot(root: string): string | null {
  try {
    return fs.realpathSync(root);
  } catch {
    return null; // a root that does not exist allows nothing
  }
}

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' ? false : !relative.startsWith('..') && !path.isAbsolute(relative);
}

const DEFAULT_TTL_MINUTES = 120;
const MAX_TTL_MINUTES = 7 * 24 * 60;
const RETENTION_MS = 30 * 86_400_000;

interface SceneRow {
  id: string;
  agent_id: string;
  conversation_key: string;
  agent_name: string;
  slot: string;
  kind: string;
  title: string;
  body: string;
  summary: string;
  choices: string;
  state: string;
  urgent: number;
  origin: string;
  version: number;
  status: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function toScene(row: SceneRow): Scene {
  return {
    id: row.id,
    agentId: row.agent_id,
    conversationKey: row.conversation_key || sceneConversationKey(row.agent_id, JSON.parse(row.origin) as SceneOrigin),
    agentName: row.agent_name,
    slot: row.slot,
    kind: row.kind as SceneKind,
    title: row.title,
    body: row.body,
    summary: row.summary,
    choices: JSON.parse(row.choices) as SceneChoice[],
    state: JSON.parse(row.state) as Record<string, unknown>,
    urgent: row.urgent === 1,
    origin: JSON.parse(row.origin) as SceneOrigin,
    version: row.version,
    status: row.status as Scene['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** The conversation a scene belongs to: the explicit key, else its thread, else its channel, else the agent alone. */
export function sceneConversationKey(agentId: string, origin: SceneOrigin | undefined): string {
  const explicit = origin?.conversationKey?.trim();
  if (explicit) return explicit;
  if (origin?.threadId) return `thread:${origin.threadId}`;
  if (origin?.channelId) return `channel:${origin.channelId}`;
  return `agent:${agentId}`;
}

interface EventRow {
  id: number;
  scene_id: string;
  agent_id: string;
  type: string;
  data: string;
  routed: string;
  created_at: number;
  command_id: string | null;
  conversation_key: string | null;
  status: string | null;
  updated_at: number | null;
}

function toEvent(row: EventRow): SceneEvent {
  return {
    id: row.id,
    sceneId: row.scene_id,
    agentId: row.agent_id,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    routed: row.routed,
    createdAt: row.created_at,
    commandId: row.command_id,
    conversationKey: row.conversation_key,
    status: (row.status ?? 'delivered') as InputStatus,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

export function titleCaseAgentId(agentId: string): string {
  // "sierra-ollama" stages as Sierra: clones share their persona's name.
  const base = agentId.replace(/-ollama$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Reattribute only Loom assets staged by the former CLI identity. Caller owns the transaction. */
export function migrateLoomAssetOwners(db: DatabaseSync, table: 'scenes' | 'prototypes', slot: 'slot' | 'name'): void {
  // Both identities could already have a live asset in the same slot. Clear the
  // older one before changing identity so the partial unique index remains valid.
  // Ties favor the existing native Loom asset. Keep every row and its timestamps.
  db.exec(`
    UPDATE ${table} AS native SET status = 'cleared'
    WHERE native.agent_id = 'loom' AND native.status = 'live'
      AND EXISTS (
        SELECT 1 FROM ${table} AS legacy
        WHERE legacy.agent_id = 't3' AND legacy.conversation_key GLOB 'loom:*'
          AND legacy.status = 'live' AND legacy.conversation_key = native.conversation_key
          AND legacy.${slot} = native.${slot} AND legacy.updated_at > native.updated_at
      );
    UPDATE ${table} AS legacy SET status = 'cleared'
    WHERE legacy.agent_id = 't3' AND legacy.conversation_key GLOB 'loom:*' AND legacy.status = 'live'
      AND EXISTS (
        SELECT 1 FROM ${table} AS native
        WHERE native.agent_id = 'loom' AND native.status = 'live'
          AND native.conversation_key = legacy.conversation_key AND native.${slot} = legacy.${slot}
      );
    UPDATE ${table} SET agent_id = 'loom',
      agent_name = CASE WHEN lower(agent_name) IN ('t3', 't3 code') THEN 'Loom' ELSE agent_name END
    WHERE agent_id = 't3' AND conversation_key GLOB 'loom:*';
  `);
}

export class SceneStore {
  readonly db: DatabaseSync;
  readonly assetsDir: string;
  readonly assetRoots: string[];

  constructor(readonly dataDir: string, private readonly now: () => number = Date.now, assetRoots?: string[]) {
    this.assetRoots = assetRoots ?? defaultAssetRoots(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    this.assetsDir = path.join(dataDir, 'assets');
    fs.mkdirSync(this.assetsDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'screen.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL,
        slot TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        summary TEXT NOT NULL,
        choices TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT '{}',
        urgent INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'live',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        routed TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presentation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Scene identity moved from (agent, slot) to (conversation, agent, slot), and
   * screen input gained command ids and a delivery status. Additive and
   * idempotent: safe on every start, on fresh and old databases alike.
   */
  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!columns('scenes').has('conversation_key')) {
        this.db.exec("ALTER TABLE scenes ADD COLUMN conversation_key TEXT NOT NULL DEFAULT ''");
      }
      const unkeyed = this.db.prepare("SELECT id, agent_id, origin FROM scenes WHERE conversation_key = ''").all() as Array<{ id: string; agent_id: string; origin: string }>;
      const setKey = this.db.prepare('UPDATE scenes SET conversation_key = ? WHERE id = ?');
      for (const row of unkeyed) {
        let origin: SceneOrigin = {};
        try {
          origin = JSON.parse(row.origin) as SceneOrigin;
        } catch {
          // A malformed origin keys the scene to its agent alone.
        }
        setKey.run(sceneConversationKey(row.agent_id, origin), row.id);
      }
      // The old index guaranteed (agent, slot) uniqueness, a stricter rule, so the new one always builds.
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS scenes_live_conversation_slot ON scenes(conversation_key, agent_id, slot) WHERE status = 'live';
        DROP INDEX IF EXISTS scenes_live_slot;
      `);
      const eventColumns = columns('events');
      if (!eventColumns.has('command_id')) this.db.exec('ALTER TABLE events ADD COLUMN command_id TEXT');
      if (!eventColumns.has('conversation_key')) this.db.exec('ALTER TABLE events ADD COLUMN conversation_key TEXT');
      if (!eventColumns.has('status')) this.db.exec('ALTER TABLE events ADD COLUMN status TEXT');
      if (!eventColumns.has('updated_at')) this.db.exec('ALTER TABLE events ADD COLUMN updated_at INTEGER');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS events_command_id ON events(command_id) WHERE command_id IS NOT NULL');
      migrateLoomAssetOwners(this.db, 'scenes', 'slot');
      // Keep pending inputs and idempotent replay metadata attached to the same
      // conversation. Old events without a key use their scene's explicit key.
      this.db.exec(`
        UPDATE events SET agent_id = 'loom'
        WHERE agent_id = 't3' AND (
          conversation_key GLOB 'loom:*' OR (
            conversation_key IS NULL AND EXISTS (
              SELECT 1 FROM scenes WHERE scenes.id = events.scene_id AND scenes.conversation_key GLOB 'loom:*'
            )
          )
        );
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Stages a scene. The same conversation + agent + slot replaces the live scene
   * in place (same id, next version); another conversation's scene in that slot
   * is left alone.
   */
  stage(input: StageInput): { scene: Scene; replaced: boolean } {
    const now = this.now();
    const slot = input.slot?.trim() || 'main';
    const ttl = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_TTL_MINUTES, 1), MAX_TTL_MINUTES);
    const conversationKey = sceneConversationKey(input.agentId, input.origin);
    const existing = this.liveBySlot(input.agentId, slot, conversationKey);
    const values = {
      agentName: input.agentName?.trim() || titleCaseAgentId(input.agentId),
      kind: input.kind,
      title: input.title?.trim() ?? '',
      body: input.body,
      summary: input.summary.trim(),
      choices: JSON.stringify(input.choices ?? []),
      state: JSON.stringify(input.state ?? {}),
      urgent: input.urgent ? 1 : 0,
      origin: JSON.stringify(input.origin ?? {}),
      expiresAt: now + ttl * 60_000,
    };
    if (existing) {
      this.db
        .prepare(
          `UPDATE scenes SET agent_name = ?, kind = ?, title = ?, body = ?, summary = ?, choices = ?, state = ?, urgent = ?,
             origin = ?, version = version + 1, updated_at = ?, expires_at = ? WHERE id = ?`,
        )
        .run(values.agentName, values.kind, values.title, values.body, values.summary, values.choices, values.state, values.urgent, values.origin, now, values.expiresAt, existing.id);
      return { scene: this.get(existing.id)!, replaced: true };
    }
    const id = randomUUID().slice(0, 12);
    this.db
      .prepare(
        `INSERT INTO scenes (id, agent_id, conversation_key, agent_name, slot, kind, title, body, summary, choices, state, urgent, origin, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, conversationKey, values.agentName, slot, values.kind, values.title, values.body, values.summary, values.choices, values.state, values.urgent, values.origin, now, now, values.expiresAt);
    return { scene: this.get(id)!, replaced: false };
  }

  /** Merges state and/or replaces the summary without re-rendering. */
  update(id: string, patch: { state?: Record<string, unknown>; summary?: string; replaceState?: boolean }): Scene | null {
    const scene = this.get(id);
    if (!scene || scene.status !== 'live') return null;
    const state = patch.state ? (patch.replaceState ? patch.state : { ...scene.state, ...patch.state }) : scene.state;
    this.db
      .prepare('UPDATE scenes SET state = ?, summary = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), patch.summary?.trim() || scene.summary, this.now(), id);
    return this.get(id);
  }

  get(id: string): Scene | null {
    const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow | undefined;
    return row ? toScene(row) : null;
  }

  /** The live scene in an agent's slot: in one conversation when given, else the most recently updated. */
  liveBySlot(agentId: string, slot: string, conversationKey?: string): Scene | null {
    const row = (
      conversationKey
        ? this.db.prepare("SELECT * FROM scenes WHERE conversation_key = ? AND agent_id = ? AND slot = ? AND status = 'live'").get(conversationKey, agentId, slot)
        : this.db.prepare("SELECT * FROM scenes WHERE agent_id = ? AND slot = ? AND status = 'live' ORDER BY updated_at DESC").get(agentId, slot)
    ) as SceneRow | undefined;
    return row ? toScene(row) : null;
  }

  /** A conversation's live scenes, most recently updated first. */
  liveForConversation(conversationKey: string): Scene[] {
    return (this.db.prepare("SELECT * FROM scenes WHERE status = 'live' AND conversation_key = ? ORDER BY updated_at DESC").all(conversationKey) as unknown as SceneRow[]).map(toScene);
  }

  /** Live scenes, most recently updated first. */
  live(agentId?: string): Scene[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM scenes WHERE status = 'live' AND agent_id = ? ORDER BY updated_at DESC").all(agentId)
      : this.db.prepare("SELECT * FROM scenes WHERE status = 'live' ORDER BY updated_at DESC").all();
    return (rows as unknown as SceneRow[]).map(toScene);
  }

  clear(id: string): Scene | null {
    this.db.prepare("UPDATE scenes SET status = 'cleared', updated_at = ? WHERE id = ? AND status = 'live'").run(this.now(), id);
    return this.get(id);
  }

  clearStage(agentId: string): string[] {
    const ids = this.live(agentId).map((scene) => scene.id);
    for (const id of ids) this.clear(id);
    return ids;
  }

  /** Expires overdue scenes and prunes old rows and unreferenced assets. Returns ids that just expired. */
  sweep(): string[] {
    const now = this.now();
    const expired = (this.db.prepare("SELECT id FROM scenes WHERE status = 'live' AND expires_at <= ?").all(now) as Array<{ id: string }>).map((row) => row.id);
    if (expired.length) this.db.prepare("UPDATE scenes SET status = 'expired' WHERE status = 'live' AND expires_at <= ?").run(now);
    const cutoff = now - RETENTION_MS;
    this.db.prepare("DELETE FROM scenes WHERE status != 'live' AND updated_at < ?").run(cutoff);
    this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    const referenced = new Set(
      (this.db.prepare("SELECT body FROM scenes WHERE kind IN ('image', 'video')").all() as Array<{ body: string }>).map((row) => path.basename(row.body)),
    );
    for (const file of fs.readdirSync(this.assetsDir)) {
      const full = path.join(this.assetsDir, file);
      if (!referenced.has(file) && now - fs.statSync(full).mtimeMs > 3_600_000) fs.rmSync(full, { force: true });
    }
    return expired;
  }

  /** Bundle ids (bundles/<id>/…) any kept scene still shows, live or not yet purged. */
  bundleIds(): Set<string> {
    const rows = this.db.prepare("SELECT body FROM scenes WHERE body LIKE 'bundles/%'").all() as Array<{ body: string }>;
    return new Set(rows.map((row) => row.body.split('/')[1]!).filter(Boolean));
  }

  recordEvent(event: Pick<SceneEvent, 'sceneId' | 'agentId' | 'type' | 'data'>, routed: string): void {
    const now = this.now();
    this.db
      .prepare('INSERT INTO events (scene_id, agent_id, type, data, routed, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(event.sceneId, event.agentId, event.type, JSON.stringify(event.data), routed, now, 'delivered', now);
  }

  /**
   * Claims a command id for a screen input. Returns the new event, or the
   * existing one (`created: false`) when the id was already used: the caller
   * returns that outcome instead of routing the input again.
   */
  claimInput(
    event: Pick<SceneEvent, 'sceneId' | 'agentId' | 'type' | 'data' | 'conversationKey'> & { commandId: string },
  ): { event: SceneEvent; created: boolean } {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (scene_id, agent_id, type, data, routed, created_at, command_id, conversation_key, status, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, 'routing', ?)`,
      )
      .run(event.sceneId, event.agentId, event.type, JSON.stringify(event.data), now, event.commandId, event.conversationKey, now);
    return { event: this.inputByCommand(event.commandId)!, created: Number(result.changes) > 0 };
  }

  updateInput(commandId: string, patch: { status: InputStatus; routed?: string }): SceneEvent | null {
    const current = this.inputByCommand(commandId);
    if (!current) return null;
    this.db
      .prepare('UPDATE events SET status = ?, routed = ?, updated_at = ? WHERE command_id = ?')
      .run(patch.status, patch.routed ?? current.routed, this.now(), commandId);
    return this.inputByCommand(commandId);
  }

  inputByCommand(commandId: string): SceneEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE command_id = ?').get(commandId) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  /** Inputs still waiting on the operator's ack, or cut off mid-route by a restart. */
  unsettledInputs(): SceneEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE status IN ('routing', 'pending') ORDER BY id").all() as unknown as EventRow[]).map(toEvent);
  }

  loadPresentation(): unknown {
    const row = this.db.prepare('SELECT state FROM presentation WHERE id = 1').get() as { state: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.state);
    } catch {
      return null;
    }
  }

  savePresentation(state: unknown): void {
    this.db
      .prepare(
        'INSERT INTO presentation (id, state, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
      )
      .run(JSON.stringify(state), this.now());
  }

  /**
   * Copies a local media file into the content-addressed asset store; returns
   * its asset name. Only absolute paths whose real location (symlinks resolved)
   * is under an allowed root, and only image/video extensions.
   */
  importAsset(filePath: string): string {
    if (!path.isAbsolute(filePath)) throw new AssetRejected(`${filePath} is not an absolute path`);
    const real = fs.realpathSync(filePath);
    const ext = path.extname(real).toLowerCase();
    if (!MEDIA_EXTENSIONS.includes(ext)) {
      throw new AssetRejected(`${filePath} is not an image or video (allowed: ${MEDIA_EXTENSIONS.join(' ')})`);
    }
    const roots = this.assetRoots.map(realRoot).filter((root): root is string => root !== null);
    if (!roots.some((root) => within(real, root))) {
      throw new AssetRejected(`${filePath} is outside the folders screens may import from (${this.assetRoots.join(', ')}); save it under one of them or add its folder to SCREEN_ASSET_ROOTS`);
    }
    // Validate and copy the same open file: a writable root (the OS temp dir) could otherwise swap the
    // path for a symlink between the check and the read. O_NOFOLLOW refuses a symlink at the end, and
    // the open file must still be the one a contained path resolves to.
    let data: Buffer;
    const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw new AssetRejected(`${filePath} is not a file`);
      const again = fs.realpathSync(real);
      const now = fs.statSync(again);
      if (!roots.some((root) => within(again, root)) || now.ino !== opened.ino || now.dev !== opened.dev) {
        throw new AssetRejected(`${filePath} changed while it was being imported`);
      }
      data = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}${ext}`;
    const target = path.join(this.assetsDir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, data);
    return name;
  }

  assetPath(name: string): string | null {
    if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) return null;
    const full = path.join(this.assetsDir, name);
    return fs.existsSync(full) ? full : null;
  }
}
