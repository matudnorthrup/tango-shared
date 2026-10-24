// A space's own record (docs/specs/spaces.md): what an agent or a project is for, and how its conversations
// behave. Kept as one desk setting, keyed `project:<id>` or `agent:<id>`. A space's default conversation and
// its jobs and workers come from roles (roles.ts), not from here; what it inherits is the person's own space.

export type SpaceKey = `project:${string}` | `agent:${string}`;

export interface SpaceRecord {
  /** What the space is for, in a line (a project's falls back to its own `about`). */
  about?: string;
  /** Agents: how it presents itself. Inherited by every conversation in its space. */
  persona?: { voice?: string };
  /** Projects usually finish; an open-ended one never does on its own. */
  lifetime?: 'finishes' | 'open';
  /** The space's own rules, on top of the person's. */
  rules?: string[];
  /** Tool groups added (true) or narrowed (false) here; anything unset is inherited. */
  tools?: Record<string, boolean>;
  /** Permissions set here; anything unset is inherited. A space can narrow but never widen past its parent. */
  permissions?: Record<string, boolean>;
  /** What its conversations remember: shared across the space, or each its own. */
  memory?: 'space' | 'conversation';
}

const KEY = /^(project|agent):[\w.-]{1,80}$/;
const FLAG = /^[a-zA-Z][\w-]{0,40}$/;
const MAX_RULES = 30;

export function readSpaces(raw: string | null): Record<string, SpaceRecord> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, SpaceRecord> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = parseRecord(value);
      if (KEY.test(key) && !('error' in record)) out[key] = record.record;
    }
    return out;
  } catch {
    return {};
  }
}

function flags(value: unknown, field: string): Record<string, boolean> | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${field} must map names to true or false` };
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!FLAG.test(k) || typeof v !== 'boolean') return { error: `${field} must map names to true or false` };
    out[k] = v;
  }
  return out;
}

function parseRecord(value: unknown): { record: SpaceRecord } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'a space must be an object' };
  const v = value as Record<string, unknown>;
  const record: SpaceRecord = {};
  if (v.about !== undefined) {
    if (typeof v.about !== 'string' || v.about.length > 300) return { error: 'about must be text, up to 300 characters' };
    if (v.about.trim()) record.about = v.about.trim();
  }
  if (v.persona !== undefined) {
    const p = v.persona as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || (p.voice !== undefined && (typeof p.voice !== 'string' || p.voice.length > 300))) return { error: 'persona.voice must be text, up to 300 characters' };
    if (typeof p.voice === 'string' && p.voice.trim()) record.persona = { voice: p.voice.trim() };
  }
  if (v.lifetime !== undefined) {
    if (v.lifetime !== 'finishes' && v.lifetime !== 'open') return { error: 'lifetime must be finishes or open' };
    record.lifetime = v.lifetime;
  }
  if (v.rules !== undefined) {
    if (!Array.isArray(v.rules) || v.rules.length > MAX_RULES || v.rules.some((r) => typeof r !== 'string' || !r.trim() || r.length > 300)) return { error: `rules must be up to ${MAX_RULES} lines of text, each up to 300 characters` };
    record.rules = (v.rules as string[]).map((r) => r.trim());
  }
  for (const field of ['tools', 'permissions'] as const) {
    if (v[field] === undefined) continue;
    const parsed = flags(v[field], field);
    if ('error' in parsed) return { error: parsed.error as string };
    record[field] = parsed as Record<string, boolean>;
  }
  if (v.memory !== undefined) {
    if (v.memory !== 'space' && v.memory !== 'conversation') return { error: 'memory must be space or conversation' };
    record.memory = v.memory;
  }
  return { record };
}

/**
 * `{ "<kind>:<id>": record | null }`: each given space's record replaces its stored one whole (null removes it);
 * the others stay as they are.
 */
export function parseSpaces(raw: unknown, current: Record<string, SpaceRecord>): { spaces: Record<string, SpaceRecord> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'spaces must map "project:<id>" or "agent:<id>" to a space or null' };
  const next = { ...current };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY.test(key)) return { error: `"${key}" isn't a space: use "project:<id>" or "agent:<id>"` };
    if (value === null) {
      delete next[key];
      continue;
    }
    const parsed = parseRecord(value);
    if ('error' in parsed) return { error: `${key}: ${parsed.error}` };
    next[key] = parsed.record;
  }
  return { spaces: next };
}
