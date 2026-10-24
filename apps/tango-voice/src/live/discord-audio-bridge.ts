import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Discord voice <-> GPT-Live audio, without native opus:
//   in:  per-speaker Opus (48 kHz speaker) -> decode -> mono 24 kHz -> mixed
//        -> paced 20 ms frames (silence when nobody talks) -> GPT-Live
//   out: GPT-Live mono 24 kHz -> 48 kHz speaker -> Opus 20 ms packets -> Discord
// The jitter buffer drops old audio instead of queueing it: queueing builds
// latency on every gap, which the lab measured in the browser path.

type Libopus = typeof import('libopus-wasm');
type Decoder = Awaited<ReturnType<Libopus['createDecoder']>>;
type Encoder = Awaited<ReturnType<Libopus['createEncoder']>>;

const FRAME_MS = 20;
const RELAY_FRAME_BYTES = 480 * 2; // 20 ms mono 24 kHz
const OPUS_SAMPLES = 960; // 20 ms at 48 kHz
const MAX_SPEAKER_BUFFER_BYTES = RELAY_FRAME_BYTES * 15; // 300 ms

/** 48 kHz interleaved speaker -> 24 kHz mono (average channels and sample pairs). */
export function speaker48ToMono24(decoded: Int16Array): Buffer {
  const frames = Math.floor(decoded.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sum = decoded[i * 4] + decoded[i * 4 + 1] + decoded[i * 4 + 2] + decoded[i * 4 + 3];
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 4))), i * 2);
  }
  return out;
}

/** 24 kHz mono -> 48 kHz interleaved speaker by linear interpolation. */
export function mono24ToSpeaker48(pcm: Buffer, previous = 0): { speaker: Int16Array; last: number } {
  const samples = Math.floor(pcm.length / 2);
  const speaker = new Int16Array(samples * 4);
  let last = previous;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const mid = Math.round((last + sample) / 2);
    speaker[i * 4] = speaker[i * 4 + 1] = mid;
    speaker[i * 4 + 2] = speaker[i * 4 + 3] = sample;
    last = sample;
  }
  return { speaker, last };
}

class SpeakerInput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(readonly decoder: Decoder) {}

  push(pcm: Buffer): void {
    this.chunks.push(pcm);
    this.bytes += pcm.length;
    while (this.bytes > MAX_SPEAKER_BUFFER_BYTES && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.length;
  }

  take(into: Int32Array): boolean {
    if (this.bytes === 0) return false;
    let sample = 0;
    while (sample < into.length && this.chunks.length > 0) {
      const head = this.chunks[0];
      const available = head.length / 2;
      const count = Math.min(available, into.length - sample);
      for (let i = 0; i < count; i++) into[sample + i] += head.readInt16LE(i * 2);
      sample += count;
      if (count === available) this.chunks.shift();
      else this.chunks[0] = head.subarray(count * 2);
      this.bytes -= count * 2;
    }
    return true;
  }
}

/**
 * Events: 'frame' (pcm24: Buffer) every 20 ms for GPT-Live, mixed across speakers.
 */
export class DiscordAudioBridge extends EventEmitter {
  private libopus: Libopus | null = null;
  private encoder: Encoder | null = null;
  private speakers = new Map<string, SpeakerInput>();
  private clock: NodeJS.Timeout | null = null;
  private clockStartedAt = 0;
  private framesSent = 0;
  private outPending: Buffer[] = [];
  private outPendingBytes = 0;
  private outLast = 0;
  private outPackets: Buffer[] = [];
  private silencePacket: Buffer | null = null;
  readonly output: Readable;

  constructor() {
    super();
    // Opus packets for an AudioResource (StreamType.Opus). Always has a packet:
    // silence when the operator is quiet, so Discord playback never stalls.
    this.output = new Readable({
      objectMode: true,
      // Keep read-ahead to ~1 packet so silence isn't queued in front of speech.
      highWaterMark: 1,
      read: () => {
        this.output.push(this.outPackets.shift() ?? this.silencePacket ?? Buffer.from([0xf8, 0xff, 0xfe]));
      },
    });
  }

  async init(): Promise<void> {
    this.libopus = await import('libopus-wasm');
    this.encoder = await this.libopus.createEncoder({
      application: this.libopus.Application.Voip,
      channels: 2,
      sampleRate: 48_000,
      frameSize: OPUS_SAMPLES,
    });
    this.silencePacket = Buffer.from(this.encoder.encode(new Int16Array(OPUS_SAMPLES * 2), { frameSize: OPUS_SAMPLES }));
  }

  start(): void {
    if (this.clock) return;
    this.clockStartedAt = Date.now();
    this.framesSent = 0;
    this.clock = setInterval(() => {
      const due = Math.floor((Date.now() - this.clockStartedAt) / FRAME_MS);
      if (due - this.framesSent > 10) this.framesSent = due - 1; // after a stall, don't burst
      while (this.framesSent < due) {
        this.emit('frame', this.mixFrame());
        this.framesSent += 1;
      }
    }, FRAME_MS / 2);
  }

  stop(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    for (const speaker of this.speakers.values()) speaker.decoder.free();
    this.speakers.clear();
    this.encoder?.free();
    this.encoder = null;
    this.output.push(null);
  }

  /** One Opus packet received from a speaker. */
  async pushOpus(userId: string, packet: Buffer): Promise<void> {
    if (!this.libopus) return;
    let speaker = this.speakers.get(userId);
    if (!speaker) {
      speaker = new SpeakerInput(await this.libopus.createDecoder({ channels: 2, sampleRate: 48_000 }));
      this.speakers.set(userId, speaker);
    }
    let decoded: Int16Array;
    try {
      decoded = speaker.decoder.decode(packet, { maxFrameSize: 5760 });
    } catch {
      return; // corrupt packet: drop it rather than poison the stream
    }
    speaker.push(speaker48ToMono24(decoded));
  }

  /** GPT-Live output (mono 24 kHz) to play into the channel. */
  pushOutput(pcm24: Buffer): void {
    if (!this.encoder) return;
    this.outPending.push(pcm24);
    this.outPendingBytes += pcm24.length;
    while (this.outPendingBytes >= RELAY_FRAME_BYTES) {
      const frame = Buffer.alloc(RELAY_FRAME_BYTES);
      let offset = 0;
      while (offset < RELAY_FRAME_BYTES) {
        const head = this.outPending[0];
        const take = Math.min(head.length, RELAY_FRAME_BYTES - offset);
        head.copy(frame, offset, 0, take);
        offset += take;
        if (take === head.length) this.outPending.shift();
        else this.outPending[0] = head.subarray(take);
      }
      this.outPendingBytes -= RELAY_FRAME_BYTES;
      const { speaker, last } = mono24ToSpeaker48(frame, this.outLast);
      this.outLast = last;
      this.outPackets.push(Buffer.from(this.encoder.encode(speaker, { frameSize: OPUS_SAMPLES })));
    }
    // Never let playback fall more than ~1 s behind the model.
    if (this.outPackets.length > 50) this.outPackets.splice(0, this.outPackets.length - 50);
  }

  /** Stop speaking immediately (e.g. on session end). */
  clearOutput(): void {
    this.outPackets = [];
    this.outPending = [];
    this.outPendingBytes = 0;
  }

  forgetSpeaker(userId: string): void {
    this.speakers.get(userId)?.decoder.free();
    this.speakers.delete(userId);
  }

  private mixFrame(): Buffer {
    const mix = new Int32Array(RELAY_FRAME_BYTES / 2);
    for (const speaker of this.speakers.values()) speaker.take(mix);
    const out = Buffer.alloc(RELAY_FRAME_BYTES);
    for (let i = 0; i < mix.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i])), i * 2);
    return out;
  }
}
