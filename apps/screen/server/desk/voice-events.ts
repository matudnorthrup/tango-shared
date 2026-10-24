import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isDirectLocalCaller } from '../access.js';

const ENDS = ['silence', 'tap', 'release', 'escape', 'cancel', 'limit', 'provider', 'error', 'not_started'] as const;
const OUTCOMES = ['posted', 'undone', 'empty', 'error', 'command_run', 'command_refused', 'command_ambiguous'] as const;
const ERRORS = ['preparation', 'capture', 'transport', 'finish', 'post', 'unknown'] as const;
export interface VoiceEvent {
  exchangeId: string;
  clientApp: 'tango-mac';
  clientRole: 'host' | 'client';
  version: string;
  deviceName?: string;
  mode: 'dictation' | 'command';
  endReason: typeof ENDS[number];
  outcome: typeof OUTCOMES[number];
  errorCode?: typeof ERRORS[number];
  targetId?: string;
  captureMs?: number;
  speechEndToStopMs?: number;
  stopToTranscriptMs?: number;
  transcriptToPostMs?: number;
}
export interface StoredVoiceEvent extends VoiceEvent { at: string; login: string | null; connection: 'local' | 'tailnet' }
const FIELDS = new Set(['exchangeId', 'clientApp', 'clientRole', 'version', 'deviceName', 'mode', 'endReason', 'outcome', 'errorCode', 'targetId', 'captureMs', 'speechEndToStopMs', 'stopToTranscriptMs', 'transcriptToPostMs']);
function short(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** Exact schema: never serialize arbitrary client fields, exception messages, audio, or transcripts. */
export function voiceEvent(value: unknown): VoiceEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid voice event');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !FIELDS.has(k)) || typeof v.exchangeId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v.exchangeId)
    || v.clientApp !== 'tango-mac' || !['host', 'client'].includes(v.clientRole as string)
    || !short(v.version, 80) || !['dictation', 'command'].includes(v.mode as string)
    || !ENDS.includes(v.endReason as typeof ENDS[number]) || !OUTCOMES.includes(v.outcome as typeof OUTCOMES[number])
    || (v.errorCode !== undefined && !ERRORS.includes(v.errorCode as typeof ERRORS[number]))
    || (v.deviceName !== undefined && !short(v.deviceName, 128))
    || (v.targetId !== undefined && (!short(v.targetId, 256) || !/^[\w:.-]+$/.test(v.targetId)))) throw new Error('Invalid voice event');
  for (const key of ['captureMs', 'speechEndToStopMs', 'stopToTranscriptMs', 'transcriptToPostMs']) {
    const n = v[key];
    // A negative stopToTranscriptMs means the last delta arrived before capture stopped.
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n > 1_800_000 || n < (key === 'stopToTranscriptMs' ? -1_800_000 : 0))) throw new Error('Invalid voice timing');
  }
  return v as unknown as VoiceEvent;
}

/** Three files total, 1 MiB each, alongside existing voice diagnostics. No unbounded history. */
export class VoiceEventLog {
  private readonly file: string;
  constructor(private dir: string, private maxBytes = 1_048_576) { this.file = join(dir, 'events.jsonl'); }
  private files() { return [this.file, `${this.file}.1`, `${this.file}.2`]; }
  read(limit = 100): StoredVoiceEvent[] {
    const result: StoredVoiceEvent[] = [];
    for (const file of this.files()) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').trim().split('\n').reverse()) {
        try { result.push(JSON.parse(line) as StoredVoiceEvent); } catch { /* A partial last line is not a record. */ }
        if (result.length >= limit) return result;
      }
    }
    return result;
  }
  append(event: StoredVoiceEvent) {
    // Deduplicate the latest 1,000 reports (bounded retry horizon).
    if (this.read(1000).some(row => row.exchangeId === event.exchangeId && row.login === event.login)) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(event) + '\n';
    if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) {
      rmSync(`${this.file}.2`, { force: true });
      if (existsSync(`${this.file}.1`)) renameSync(`${this.file}.1`, `${this.file}.2`);
      renameSync(this.file, `${this.file}.1`);
    }
    appendFileSync(this.file, line, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

export function registerVoiceEvents(app: Hono, dataDir: string) {
  const log = new VoiceEventLog(join(dataDir, 'voice'));
  app.post('/api/desk/voice/events', bodyLimit({ maxSize: 4096 }), async c => {
    let event: VoiceEvent;
    try { event = voiceEvent(await c.req.json()); } catch { return c.json({ error: 'Invalid voice event' }, 400); }
    // accessControl already authenticated Serve. Never accept a login from the body.
    const login = c.req.header('tailscale-user-login');
    try {
      log.append({ ...event, at: new Date().toISOString(), login: login?.slice(0, 254) ?? null,
        connection: isDirectLocalCaller(c.req.raw.headers) ? 'local' : 'tailnet' });
      return c.json({ ok: true });
    } catch { return c.json({ error: 'Voice diagnostics unavailable' }, 503); }
  });
  app.get('/api/desk/voice/events', c => {
    if (!isDirectLocalCaller(c.req.raw.headers)) return c.json({ error: 'local callers only' }, 403);
    const limit = Number(c.req.query('limit') ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return c.json({ error: 'limit must be 1–500' }, 400);
    c.header('Cache-Control', 'no-store');
    try { return c.json({ events: log.read(limit) }); }
    catch { return c.json({ error: 'Voice diagnostics unavailable' }, 503); }
  });
}
