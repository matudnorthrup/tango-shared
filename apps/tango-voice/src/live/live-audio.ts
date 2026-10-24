import { EventEmitter } from 'node:events';
import { LIVE_BYTES_PER_MS } from './gpt-live-client.js';

export const FRAME_MS = 100;
const FRAME_BYTES = FRAME_MS * LIVE_BYTES_PER_MS;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

export function pcmRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Paces microphone PCM to GPT-Live in real time, filling gaps with silence.
 * Discord only delivers packets while someone talks; GPT-Live needs a
 * continuous stream to judge pauses, so the pump always sends a frame.
 *
 * Emits 'frame' (pcm: Buffer, atMs: number) for every frame sent.
 */
export class LiveInputPump extends EventEmitter {
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private framesSent = 0;

  constructor(private readonly sendFrame: (pcm: Buffer) => void, private readonly now: () => number = Date.now) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.framesSent = 0;
    // Tick faster than the frame size and catch up on drift.
    this.timer = setInterval(() => this.tick(), FRAME_MS / 4);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  push(pcm: Buffer): void {
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
  }

  /** Milliseconds of real (non-filler) audio still waiting to be sent. */
  get pendingMs(): number {
    return this.queuedBytes / LIVE_BYTES_PER_MS;
  }

  private tick(): void {
    const due = Math.floor((this.now() - this.startedAt) / FRAME_MS);
    while (this.framesSent < due) {
      const frame = this.takeFrame();
      this.sendFrame(frame);
      this.emit('frame', frame, this.startedAt + this.framesSent * FRAME_MS);
      this.framesSent += 1;
    }
  }

  private takeFrame(): Buffer {
    if (this.queuedBytes === 0) return SILENCE_FRAME;
    const out = Buffer.alloc(FRAME_BYTES);
    let offset = 0;
    while (offset < FRAME_BYTES && this.queue.length > 0) {
      const head = this.queue[0];
      const take = Math.min(head.length, FRAME_BYTES - offset);
      head.copy(out, offset, 0, take);
      offset += take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.queuedBytes -= offset;
    return out;
  }
}

/**
 * Tracks when a party (user or assistant) last made sound, from PCM energy.
 * Used to decide whether the conversational floor is free.
 */
export class SpeechActivity {
  lastVoiceAt = 0;
  /** When the most recent stretch of speech began; kept after it ends (0 before any). */
  lastSegmentAt = 0;
  private voicedSince: number | null = null;

  constructor(private readonly threshold = 350, private readonly now: () => number = Date.now) {}

  observe(pcm: Buffer, atMs = this.now()): void {
    if (pcmRms(pcm) >= this.threshold) {
      // A new stretch of speech starts after a gap (Discord sends no silence frames between them).
      if (this.voicedSince === null || atMs - this.lastVoiceAt >= 400) this.voicedSince = this.lastSegmentAt = atMs;
      this.lastVoiceAt = atMs + pcm.length / LIVE_BYTES_PER_MS;
    } else if (this.voicedSince !== null && atMs - this.lastVoiceAt > 400) {
      this.voicedSince = null;
    }
  }

  /** When the current (or most recent) stretch of speech began, or null after silence. */
  segmentStart(): number | null {
    return this.voicedSince;
  }

  quietForMs(at = this.now()): number {
    return Math.max(0, at - this.lastVoiceAt);
  }

  isActive(at = this.now(), holdMs = 400): boolean {
    return at - this.lastVoiceAt < holdMs;
  }
}

/**
 * Output audio arrives roughly in real time but can burst. Model a playback
 * cursor so "assistant is speaking" reflects what a listener would hear.
 */
export class LivePlaybackClock {
  private cursor = 0;
  readonly activity: SpeechActivity;

  constructor(threshold = 350, private readonly now: () => number = Date.now) {
    this.activity = new SpeechActivity(threshold, now);
  }

  /** Returns the wall-clock time this chunk starts playing. */
  enqueue(pcm: Buffer): number {
    const at = Math.max(this.now(), this.cursor);
    this.cursor = at + pcm.length / LIVE_BYTES_PER_MS;
    this.activity.observe(pcm, at);
    return at;
  }

  /** True while queued audio with voice is still playing. */
  isSpeaking(at = this.now()): boolean {
    return this.activity.lastVoiceAt > at || this.activity.isActive(at);
  }

  quietForMs(at = this.now()): number {
    return this.activity.lastVoiceAt > at ? 0 : this.activity.quietForMs(at);
  }

  /** The queued audio was thrown away (the output buffer was cleared): nothing is playing from now on. */
  cut(at = this.now()): void {
    this.cursor = Math.min(this.cursor, at);
    // Past the activity hold too, so isSpeaking() is false at once.
    this.activity.lastVoiceAt = Math.min(this.activity.lastVoiceAt, at - 1000);
  }
}
