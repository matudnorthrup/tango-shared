import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
import { voiceHistoryCapture } from '../server/desk/voice-history.js';
import { DictationHistoryStore } from '../server/desk/dictation-history-store.js';
const dirs: string[] = [];
beforeEach(() => vi.stubEnv('SCREEN_ALLOWED_LOGINS', 'owner@example.test'));
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const headers = () => new Headers({ 'tailscale-user-login': 'owner@example.test', 'tailscale-headers-info': 'present', 'x-forwarded-for': '100.64.0.1', 'x-forwarded-host': 'desk.example.ts.net', 'x-forwarded-proto': 'https', origin: 'https://desk.example.ts.net', 'sec-fetch-site': 'same-origin' });
const url = (extra = '') => new URL('https://desk.example.ts.net/api/desk/voice?mode=dictation' + extra);
function store() { const dir = mkdtempSync(join(tmpdir(), 'voice-history-')); dirs.push(dir); return new DictationHistoryStore(dir); }
it('defaults browsers on; uses server identity and one immutable final transcript', () => {
  const s = store(); const capture = voiceHistoryCapture(headers(), url(), s);
  expect(capture).toBeTypeOf('function'); capture!('Final words', false); capture!('Duplicate', false);
  const entries = s.list('owner@example.test').entries;
  expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ text: 'Final words', destination: 'Desk dictation', outcome: 'unknown' });
  expect(entries[0]!.device).toMatch(/^[a-f0-9]{64}$/);
});
it.each(['&history=off', '&manualFinish=1', '&role=screen', '&detached=1', '&framed=1'])('suppression only: %s', extra => {
  expect(voiceHistoryCapture(headers(), url(extra), store())).toBeUndefined();
  expect(voiceHistoryCapture(headers(), new URL('https://desk.example.ts.net/api/desk/voice?item=thread' + extra), store(), 'Conversation')).toBeUndefined();
});
it.each(['origin', 'tailscale-user-login', 'tailscale-headers-info', 'x-forwarded-for'])('cannot enable capture without %s', key => {
  const h = headers(); h.delete(key); expect(voiceHistoryCapture(h, url('&history=on'), store())).toBeUndefined();
});
it('rejects loopback, foreign origin, scenes, detached referrers, and non-dictation modes', () => {
  const s = store();
  expect(voiceHistoryCapture(new Headers({ origin: 'http://127.0.0.1:9410' }), url(), s)).toBeUndefined();
  for (const [key, value] of [['origin', 'null'], ['sec-fetch-site', 'cross-site'], ['origin', 'https://foreign.test'], ['x-desk-window', 'detached'], ['tailscale-user-login', 'other@example.test'], ['referer', 'https://desk.example.ts.net/tango-screen/?detached=1'], ['referer', 'https://desk.example.ts.net/tango-screen/?role=screen'], ['referer', 'https://desk.example.ts.net/bundles/scene/index.html']]) {
    const h = headers(); h.set(key!, value!); expect(voiceHistoryCapture(h, url('&history=on'), s)).toBeUndefined();
  }
  expect(voiceHistoryCapture(headers(), new URL('https://desk.example.ts.net/api/desk/voice?item=thread'), s)).toBeUndefined();
});
it('clear during dictation wins and never retries under a new generation', () => {
  const s = store(); const capture = voiceHistoryCapture(headers(), url(), s)!;
  s.clear('owner@example.test', s.list('owner@example.test').generation);
  capture('Stale words', false); capture('Retry', false);
  expect(s.list('owner@example.test').entries).toEqual([]);
});
it('rejects oversized and empty text without breaking voice', () => {
  const s = store(); voiceHistoryCapture(headers(), url(), s)!('x'.repeat(16385), false);
  voiceHistoryCapture(headers(), url(), s)!(' ', false);
  expect(s.list('owner@example.test').entries).toEqual([]);
});

it('accepts browser WebSockets without optional Fetch Metadata or Referer', () => {
  const h = headers(); h.delete('sec-fetch-site');
  expect(voiceHistoryCapture(h, url(), store())).toBeTypeOf('function');
});

it('records multiple conversation turns with server destination and the upgrade generation', () => {
  const s = store();
  const capture = voiceHistoryCapture(headers(), new URL('https://desk.example.ts.net/api/desk/voice?item=thread'), s, 'Synthetic conversation')!;
  capture('First reply', false, 1, true); capture('Duplicate', false, 1, true);
  capture('Second reply', true, 2, false);
  const entries = s.list('owner@example.test').entries;
  expect(entries).toHaveLength(2);
  expect(entries.find(e => e.text === 'First reply')).toMatchObject({ outcome: 'sent', destination: 'Synthetic conversation' });
  expect(entries.find(e => e.text === 'Second reply')).toMatchObject({ outcome: 'failed' });
  s.clear('owner@example.test', s.list('owner@example.test').generation);
  capture('Stale next turn', false, 3, true);
  expect(s.list('owner@example.test').entries).toEqual([]);
});
