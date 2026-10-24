import { describe, expect, it } from 'vitest';
import { SpeechPause } from '../server/desk/speech-pause.js';

/** `ms` of 24 kHz PCM: a 200 Hz tone at `amplitude` (0 is silence). */
export function tone(ms: number, amplitude: number): Buffer {
  const n = Math.round(ms * 24), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 200 * i) / 24000)), i * 2);
  return pcm;
}
/** Feeds `pcm` in the browser's 100 ms chunks; the chunk index that ended a pause, or -1. */
function feed(pause: SpeechPause, pcm: Buffer): number {
  for (let i = 0, k = 0; i < pcm.length; i += 4800, k++) if (pause.append(pcm.subarray(i, i + 4800))) return k;
  return -1;
}

describe('SpeechPause', () => {
  it('ends after 1.5 s of quiet following speech, once per pause', () => {
    const pause = new SpeechPause();
    expect(feed(pause, tone(500, 0))).toBe(-1);
    expect(feed(pause, tone(1000, 8000))).toBe(-1);
    expect(feed(pause, tone(1400, 0))).toBe(-1);
    expect(feed(pause, tone(200, 0))).toBeGreaterThanOrEqual(0);
    expect(feed(pause, tone(2000, 0))).toBe(-1);
    // Speaking again re-arms it.
    expect(feed(pause, tone(500, 8000))).toBe(-1);
    expect(feed(pause, tone(1600, 0))).toBeGreaterThanOrEqual(0);
  });
  it('learns the floor from gaps when speech starts with the first audio', () => {
    const pause = new SpeechPause();
    for (let w = 0; w < 6; w++) { feed(pause, tone(300, 8000)); feed(pause, tone(100, 0)); }
    expect(pause.heardSpeech).toBe(true);
    expect(feed(pause, tone(1600, 0))).toBeGreaterThanOrEqual(0);
  });
  it('ends a short first utterance heard from the first frame', () => {
    const pause = new SpeechPause();
    expect(feed(pause, tone(600, 8000))).toBe(-1);
    expect(feed(pause, tone(1400, 0))).toBe(-1);
    expect(feed(pause, tone(200, 0))).toBeGreaterThanOrEqual(0);
  });
  it('never ends on silence or steady noise alone', () => {
    const pause = new SpeechPause();
    expect(feed(pause, tone(5000, 0))).toBe(-1);
    const noisy = new SpeechPause();
    expect(feed(noisy, tone(5000, 2000))).toBe(-1);
  });
  it('ignores a click inside the pause', () => {
    const pause = new SpeechPause();
    feed(pause, tone(300, 0)); feed(pause, tone(1000, 8000));
    expect(feed(pause, tone(800, 0))).toBe(-1);
    expect(feed(pause, tone(20, 8000))).toBe(-1);
    // The click didn't restart the 1.5 s.
    expect(feed(pause, tone(800, 0))).toBeGreaterThanOrEqual(0);
  });
});

it('reports accumulated quiet after the first pause and resets on resumed speech', () => {
  const pause = new SpeechPause();
  pause.append(tone(100, 0)); pause.append(tone(500, 8000));
  pause.append(tone(1500, 0)); expect(pause.trailingQuietMs).toBe(1500);
  expect(pause.append(tone(2500, 0))).toBe(false); expect(pause.trailingQuietMs).toBe(4000);
  pause.append(tone(86000, 0)); expect(pause.trailingQuietMs).toBe(90000);
  pause.append(tone(60, 8000)); expect(pause.trailingQuietMs).toBe(0); expect(pause.paused).toBe(false);
});
