import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpeakerTts, wavPcm24 } from '../src/testing/speaker-tts.js';
import type { OperatorProfile } from '../src/live/operator-profile.js';
import { resolveOperatorSetup } from '../src/testing/live-operator-setup.js';

describe('speaker TTS', () => {
  it('rejects unknown providers and requires a key only for explicit API TTS', () => {
    expect(() => createSpeakerTts({ cacheDir: '.', provider: 'unknown' })).toThrow('Unknown --tts');
    expect(() => createSpeakerTts({ cacheDir: '.', provider: 'openai' })).toThrow('--tts openai');
    expect(() => createSpeakerTts({ cacheDir: '.' })).not.toThrow();
  });
  it('caches explicit API synthesis on disk', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'speaker-test-'));
    const request = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2])));
    try {
      const synth = createSpeakerTts({ provider: 'openai', apiKey: 'test', cacheDir, fetch: request });
      expect(await synth('Hello')).toEqual(Buffer.from([1, 2]));
      await synth('Hello');
      expect(request).toHaveBeenCalledTimes(1);
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  });
  it('extracts WAV data after an odd-sized metadata chunk and rejects other rates', () => {
    const wav = Buffer.alloc(58);
    wav.write('RIFF'); wav.writeUInt32LE(50, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt16LE(16, 34);
    wav.write('JUNK', 36); wav.writeUInt32LE(1, 40);
    wav.write('data', 46); wav.writeUInt32LE(4, 50); wav.writeInt16LE(123, 54);
    expect(wavPcm24(wav)).toEqual(wav.subarray(54));
    wav.writeUInt32LE(48000, 24);
    expect(() => wavPcm24(wav)).toThrow('24 kHz');
    expect(() => wavPcm24(wav.subarray(0, 55))).toThrow('Truncated');
  });
  it('defaults operator setup to Codex without an API key', () => {
    expect(resolveOperatorSetup(new Map(), '', null).route.label).toContain('ChatGPT subscription');
    const profile = { id: 'test', agents: [], auth: 'codex', ownerUserIds: [], voiceChannelId: '', idleMinutes: 5, stateDir: '.' } satisfies OperatorProfile;
    expect(resolveOperatorSetup(new Map([['operator', 'test']]), '', profile).route.label).toContain('ChatGPT subscription');
    expect(() => resolveOperatorSetup(new Map([['auth', 'api']]), '', null)).toThrow('--auth api');
  });
});
