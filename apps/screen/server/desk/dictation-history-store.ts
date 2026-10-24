import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HISTORY_TTL = 7 * 24 * 60 * 60 * 1000;
export const HISTORY_TEXT_BYTES = 16_384;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const isHistoryId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export class HistoryError extends Error {
  constructor(public code: string, public status: 400 | 409 | 429 = 400) { super(code); }
}
export interface HistoryEntry {
  id: string; capturedAt: number; text: string; destination: string;
  outcome: 'sent' | 'failed' | 'undone' | 'unknown'; revision: number; device: string;
}
interface Rate { minute: number; minuteCount: number; hour: number; hourCount: number }
interface State {
  generation: string; entries: HistoryEntry[]; deleted: Array<{ id: string; expires: number }>;
  rates: Record<string, Rate>;
}
export function historyEntry(value: unknown, now: number): Omit<HistoryEntry, 'device'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HistoryError('invalid_entry');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['id', 'capturedAt', 'text', 'destination', 'outcome', 'revision'].includes(k))
    || !isHistoryId(v.id) || !Number.isSafeInteger(v.capturedAt) || (v.capturedAt as number) > now + 60_000
    || (v.capturedAt as number) <= now - HISTORY_TTL
    || typeof v.text !== 'string' || !v.text.trim() || Buffer.byteLength(v.text) > HISTORY_TEXT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.text)
    || typeof v.destination !== 'string' || v.destination.length > 256 || /[\u0000-\u001f\u007f]/.test(v.destination)
    || !['sent', 'failed', 'undone', 'unknown'].includes(v.outcome as string)
    || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1) throw new HistoryError('invalid_entry');
  return v as unknown as Omit<HistoryEntry, 'device'>;
}

/** One atomic snapshot per owner. No WAL, backups, logs, or text-bearing tombstones. */
export class DictationHistoryStore {
  constructor(readonly dir: string, private now = Date.now) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('history_unavailable');
    chmodSync(dir, 0o700);
    // The production directory also ends in .noindex. Fail closed if the OS cannot exclude backups.
    if (process.platform === 'darwin') execFileSync('/usr/bin/tmutil', ['addexclusion', dir], { stdio: 'ignore', timeout: 20_000 });
    this.sweep();
  }
  private file(owner: string) { return join(this.dir, createHash('sha256').update(owner).digest('hex') + '.json'); }
  private empty(): State { return { generation: randomUUID(), entries: [], deleted: [], rates: {} }; }
  private read(file: string): State {
    let stat;
    try { stat = lstatSync(file); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const state = this.empty(); this.write(file, state); return state;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12_000_000) throw new Error('history_unavailable');
    chmodSync(file, 0o600);
    const state = JSON.parse(readFileSync(file, 'utf8')) as State;
    if (!isHistoryId(state.generation) || !Array.isArray(state.entries) || !Array.isArray(state.deleted) || !state.rates) throw new Error('history_unavailable');
    if (this.prune(state)) this.write(file, state);
    return state;
  }
  private prune(state: State) {
    const before = JSON.stringify(state);
    const cutoff = this.now() - HISTORY_TTL;
    state.entries = state.entries.filter(e => e.capturedAt > cutoff);
    state.deleted = state.deleted.filter(e => e.expires > this.now());
    for (const [key, rate] of Object.entries(state.rates)) if (rate.hour + 3_600_000 <= this.now()) delete state.rates[key];
    return before !== JSON.stringify(state);
  }
  private write(file: string, state: State) {
    this.cleanTemps();
    const temp = join(this.dir, `.history-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, file);
      const dir = openSync(this.dir, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
  }
  /** Called at boot and every minute, including when nobody opens history. */
  sweep() {
    this.cleanTemps();
    let failed = false;
    for (const name of readdirSync(this.dir)) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        try { this.read(join(this.dir, name)); } catch { failed = true; }
      }
    }
    if (failed) throw new Error('history_unavailable');
  }
  private cleanTemps() {
    for (const name of readdirSync(this.dir)) if (/^\.history-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name)) rmSync(join(this.dir, name), { force: true });
  }
  list(owner: string) {
    const state = this.read(this.file(owner));
    return { generation: state.generation, entries: state.entries, deleted: state.deleted.map(e => e.id) };
  }
  private generation(state: State, value: unknown) {
    if (value !== state.generation) throw new HistoryError('generation_changed', 409);
  }
  private rate(state: State, device: string) {
    // Server-derived device key. Persist across restarts and clear-all. Also bound total owner churn/tombstones.
    for (const [key, minuteMax, hourMax] of [[device, 12, 120], ['owner', 30, 300]] as const) {
      const now = this.now(), r = state.rates[key] ?? { minute: now, minuteCount: 0, hour: now, hourCount: 0 };
      if (r.minute + 60_000 <= now) { r.minute = now; r.minuteCount = 0; }
      if (r.hour + 3_600_000 <= now) { r.hour = now; r.hourCount = 0; }
      if (r.minuteCount >= minuteMax || r.hourCount >= hourMax) throw new HistoryError('rate_limited', 429);
      r.minuteCount++; r.hourCount++; state.rates[key] = r;
    }
  }
  put(owner: string, device: string, generation: unknown, value: unknown) {
    const file = this.file(owner), state = this.read(file);
    this.generation(state, generation);
    const entry = historyEntry(value, this.now());
    if (state.deleted.some(e => e.id === entry.id)) throw new HistoryError('entry_deleted', 409);
    const old = state.entries.find(e => e.id === entry.id);
    if (old) {
      if (old.device !== device || old.capturedAt !== entry.capturedAt || old.text !== entry.text || old.destination !== entry.destination) throw new HistoryError('entry_conflict', 409);
      if (entry.revision <= old.revision) return { ok: true, revision: old.revision };
    }
    this.rate(state, device);
    if (old) Object.assign(old, entry);
    else state.entries.push({ ...entry, device });
    state.entries.sort((a, b) => b.capturedAt - a.capturedAt || a.id.localeCompare(b.id));
    for (const removed of state.entries.splice(200)) state.deleted.push({ id: removed.id, expires: removed.capturedAt + HISTORY_TTL });
    this.write(file, state);
    return { ok: true, revision: entry.revision };
  }
  delete(owner: string, generation: unknown, id: unknown) {
    if (!isHistoryId(id)) throw new HistoryError('invalid_id');
    const file = this.file(owner), state = this.read(file);
    this.generation(state, generation);
    const entry = state.entries.find(e => e.id === id);
    if (entry) {
      state.entries = state.entries.filter(e => e.id !== id);
      state.deleted.push({ id, expires: entry.capturedAt + HISTORY_TTL });
      this.write(file, state);
    }
    return { ok: true };
  }
  clear(owner: string, generation: unknown) {
    const file = this.file(owner), state = this.read(file);
    this.generation(state, generation);
    state.entries = []; state.deleted = []; state.generation = randomUUID();
    this.write(file, state);
    return { generation: state.generation, entries: [], deleted: [] };
  }
}
