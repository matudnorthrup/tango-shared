import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Extract chunked WAV audio; say may include metadata before its data chunk. */
export function wavPcm24(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF WAV');
  let valid = false;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV chunk');
    if (tag === 'fmt ') {
      valid = size >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
        && wav.readUInt32LE(start + 4) === 24000 && wav.readUInt16LE(start + 14) === 16;
    }
    if (tag === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!valid || !pcm?.length || pcm.length % 2) throw new Error('Expected nonempty 24 kHz mono PCM16 WAV');
  return pcm;
}

/** Local speaker by default, independently of the operator's authentication. */
export function createSpeakerTts(options: { provider?: string; apiKey?: string; cacheDir: string; fetch?: typeof fetch }) {
  const provider = options.provider ?? 'say';
  if (provider !== 'say' && provider !== 'openai') throw new Error('Unknown --tts (use say or openai)');
  if (provider === 'openai' && !options.apiKey) throw new Error('OPENAI_API_KEY is required for --tts openai');
  return async (text: string): Promise<Buffer> => {
    mkdirSync(options.cacheDir, { recursive: true });
    const key = createHash('sha256').update(`${provider}|pcm24-v1|onyx|${text}`).digest('hex');
    const file = join(options.cacheDir, `${key}.pcm`);
    if (existsSync(file)) return readFileSync(file);
    let pcm: Buffer;
    if (provider === 'say') {
      const dir = mkdtempSync(join(tmpdir(), 'tango-speaker-'));
      try {
        const wav = join(dir, 'speaker.wav');
        const input = join(dir, 'text.txt');
        writeFileSync(input, text);
        await promisify(execFile)('say', ['-o', wav, '--data-format=LEI16@24000', '-f', input], { timeout: 60_000 });
        pcm = wavPcm24(readFileSync(wav));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    } else {
      const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: text, response_format: 'pcm' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`TTS failed ${response.status}`);
      pcm = Buffer.from(await response.arrayBuffer());
    }
    writeFileSync(file, pcm);
    return pcm;
  };
}
