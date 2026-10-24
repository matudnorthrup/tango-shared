import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type {
  LiveAck,
  LiveContextKind,
  LiveSessionClient,
  LiveSessionOptions,
  LiveTranscriptDelta,
} from './gpt-live-client.js';

// GPT-Live over a ChatGPT subscription (the "Codex" route), signed in with a
// Codex CLI login. Unlike the public API this is WebRTC: audio travels as
// Opus/RTP, and events go over a sideband WebSocket using the subscription
// ("frameless") event names. The endpoint is undocumented; the wire shapes
// follow OpenClaw's implementation (extensions/openai/realtime-quicksilver-*).
//
// External audio interface matches GptLiveClient: mono PCM16 at 24 kHz.

const CALL_URL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
const SIDEBAND_URL = 'wss://api.openai.com/v1/live/';
const FRAME_MS = 20;
const OPUS_SAMPLES = 960; // 20 ms at 48 kHz
const RELAY_FRAME_BYTES = 480 * 2; // 20 ms of 24 kHz mono
const MAX_BUFFERED_INPUT_BYTES = 24 * 2 * 500; // keep input latency under 500 ms

type Werift = typeof import('werift');
type Libopus = typeof import('libopus-wasm');

export interface CodexAuth {
  token: string;
  accountId: string;
  expiresAt: number | null;
}

/** Reads the access token a Codex CLI login keeps in <codexHome>/auth.json. */
export function readCodexAuth(codexHome = join(homedir(), '.codex')): CodexAuth {
  const auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')) as {
    tokens?: { access_token?: string; account_id?: string };
  };
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId) throw new Error(`No ChatGPT login in ${codexHome}/auth.json (run codex login)`);
  let expiresAt: number | null = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
    expiresAt = payload.exp ? payload.exp * 1000 : null;
  } catch {
    // Opaque token; let the server judge it.
  }
  if (expiresAt !== null && expiresAt < Date.now() + 5 * 60_000) {
    throw new Error(`ChatGPT login in ${codexHome} has expired; run any codex command to refresh it`);
  }
  return { token, accountId, expiresAt };
}

export interface CodexLiveClientOptions {
  codexHome?: string;
  model?: string;
}

export class CodexLiveClient extends EventEmitter implements LiveSessionClient {
  sessionId: string | null = null;
  expiresAt: number | null = null;
  private socket: WebSocket | null = null;
  private peer: InstanceType<Werift['RTCPeerConnection']> | null = null;
  private encoder: Awaited<ReturnType<Libopus['createEncoder']>> | null = null;
  private decoder: Awaited<ReturnType<Libopus['createDecoder']>> | null = null;
  private werift: Werift | null = null;
  private clock: NodeJS.Timeout | null = null;
  private input: Buffer[] = [];
  private inputBytes = 0;
  private lastInputSample = 0;
  private sequence = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private framesSent = 0;
  private clockStartedAt = 0;
  private startedAt = 0;
  private closed = false;
  private eventSeq = 0;

  constructor(private readonly options: CodexLiveClientOptions = {}) {
    super();
  }

  get isOpen(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  async start(session: LiveSessionOptions): Promise<void> {
    const auth = readCodexAuth(this.options.codexHome);
    const [werift, libopus] = await Promise.all([import('werift'), import('libopus-wasm')]);
    this.werift = werift;
    this.encoder = await libopus.createEncoder({
      application: libopus.Application.Voip,
      channels: 2,
      sampleRate: 48_000,
      frameSize: OPUS_SAMPLES,
    });
    this.decoder = await libopus.createDecoder({ channels: 2, sampleRate: 48_000 });

    const peer = new werift.RTCPeerConnection({ codecs: { audio: [werift.useOPUS({ payloadType: 111 })], video: [] } });
    this.peer = peer;
    const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv' });
    let mediaGrace: NodeJS.Timeout | null = null;
    peer.connectionStateChange.subscribe((state) => {
      // Only real recovery (connected) or a final state ends the grace period: "connecting"
      // during an ICE retry is not audio.
      if (mediaGrace && ['connected', 'failed', 'closed'].includes(state)) {
        clearTimeout(mediaGrace);
        mediaGrace = null;
      }
      if (state === 'connected') this.startClock(transceiver);
      else if (['failed', 'disconnected', 'closed'].includes(state) && !this.closed) {
        this.emit('error', { message: `WebRTC media ${state}` });
        // Audio is gone: close the session so the host reconnects. A dead session with no audio
        // otherwise sat until everyone left (10/05 12:56). "disconnected" can recover; give it 5 s.
        const drop = () => void this.dropForMedia(state);
        if (state === 'disconnected') mediaGrace ??= setTimeout(drop, 5000);
        else drop();
      }
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    const headers = {
      Authorization: `Bearer ${auth.token}`,
      'chatgpt-account-id': auth.accountId,
      'OpenAI-Alpha': 'quicksilver=v2',
      'session-id': randomUUID(),
      'thread-id': randomUUID(),
      'x-session-id': randomUUID(),
    };
    const response = await fetch(CALL_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: peer.localDescription?.sdp,
        session: {
          model: this.options.model ?? 'gpt-live-1-codex',
          instructions: session.instructions,
          audio: { output: { voice: session.voice ?? 'cove' } },
          delegation: { type: 'client' },
          ...(session.input?.length
            ? {
                initial_items: session.input
                  .filter((message) => message.role !== 'developer')
                  .map((message) => ({
                    type: 'message',
                    role: message.role,
                    content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
                  })),
              }
            : {}),
        },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300).split(auth.token).join('[token]').split(auth.accountId).join('[account]');
      throw new Error(`GPT-Live (subscription) call failed ${response.status}: ${detail}`);
    }
    const callId =
      response.headers.get('location')?.split('/').filter(Boolean).find((part) => /^rtc_[\w-]+$/.test(part)) ??
      response.headers.get('openai-session-id') ??
      '';
    if (!callId) throw new Error('GPT-Live (subscription) call returned no call id');
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    transceiver.receiver.track.onReceiveRtp.subscribe((packet) => this.onRtp(packet));

    this.sessionId = callId;
    this.expiresAt = auth.expiresAt;
    this.startedAt = Date.now();
    const socket = new WebSocket(`${SIDEBAND_URL}${callId}`, { headers, maxPayload: 16 * 1024 * 1024 });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GPT-Live sideband timed out')), 15_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) this.onEvent(String(data));
    });
    socket.on('error', (err) => this.emit('error', { message: `sideband: ${err.message}` }));
    socket.on('close', (code, reason) => {
      if (!this.closed) this.emit('closed', { reason: `sideband ${code} ${reason}`.trim(), usage: null });
      void this.teardown();
    });
  }

  appendAudio(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    this.input.push(pcm);
    this.inputBytes += pcm.length;
    while (this.inputBytes > MAX_BUFFERED_INPUT_BYTES && this.input.length > 1) {
      this.inputBytes -= this.input.shift()!.length;
    }
  }

  appendContext(kind: LiveContextKind, content: string, delegationId: string | null): Promise<LiveAck> {
    this.eventSeq += 1;
    const eventId = `${kind}_${this.eventSeq}`;
    // Subscription channels: "speakable" is said aloud, "commentary" is silent context.
    const channel = kind === 'commentary' ? 'speakable' : kind === 'thinking' ? 'commentary' : undefined;
    this.send({
      type: delegationId ? 'delegation.context.append' : 'session.context.append',
      ...(delegationId ? { delegation_item_id: delegationId } : {}),
      ...(channel ? { channel } : {}),
      content: [{ type: 'input_text', text: content }],
    });
    // This route has no append acknowledgements.
    return Promise.resolve({ clientEventId: eventId });
  }

  async close(timeoutMs = 5000): Promise<unknown> {
    if (this.closed) return null;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.send({ type: 'session.close' });
      await closed;
    }
    const seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    await this.teardown();
    this.emit('closed', { reason: 'close_requested', usage: { seconds, billing: 'chatgpt-subscription' } });
    return { seconds, billing: 'chatgpt-subscription' };
  }

  /** Media failed under a live session: tear down and report it closed (the host reconnects on "closed"). */
  private async dropForMedia(state: string): Promise<void> {
    if (this.closed) return;
    const seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    await this.teardown().catch(() => undefined);
    this.emit('closed', { reason: `media ${state}`, usage: { seconds, billing: 'chatgpt-subscription' } });
  }

  private async teardown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    try {
      this.socket?.close(1000, 'session closed');
    } catch {
      // Already closed.
    }
    await this.peer?.close().catch(() => undefined);
    this.encoder?.free();
    this.decoder?.free();
    this.encoder = null;
    this.decoder = null;
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  private nowMs(): number {
    return Date.now() - this.startedAt;
  }

  private onEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type);
    const item = (event.item ?? {}) as { id?: string; text?: string; type?: string; content?: Array<{ type: string; text?: string }> };
    const at = this.nowMs();
    switch (type) {
      case 'input_transcript.added':
      case 'output_transcript.added':
        if (item.text) {
          this.emit(type === 'input_transcript.added' ? 'inputTranscript' : 'outputTranscript', {
            delta: item.text,
            startMs: at,
            endMs: at,
          } satisfies LiveTranscriptDelta);
        }
        break;
      case 'delegation.created':
        if (item.id) {
          const prompt = (item.content ?? [])
            .filter((part) => part.type === 'input_text')
            .map((part) => part.text ?? '')
            .join('');
          this.emit('delegation', { id: item.id, offsetMs: at, prompt });
        }
        break;
      case 'error': {
        const detail = (event.error ?? event) as { message?: string; code?: string };
        this.emit('error', { code: detail.code, message: detail.message ?? raw.slice(0, 300) });
        break;
      }
      case 'session.closed':
        this.emit('closed', { reason: String(event.reason ?? 'closed'), usage: null });
        break;
    }
    this.emit('event', event);
  }

  // --- media ---------------------------------------------------------------

  private startClock(transceiver: ReturnType<InstanceType<Werift['RTCPeerConnection']>['addTransceiver']>): void {
    if (this.clock || this.closed) return;
    this.clockStartedAt = Date.now();
    this.framesSent = 0;
    this.clock = setInterval(() => {
      const due = Math.floor((Date.now() - this.clockStartedAt) / FRAME_MS);
      // After a stall, skip ahead rather than bursting stale audio.
      if (due - this.framesSent > 10) {
        this.timestamp = (this.timestamp + (due - this.framesSent - 1) * OPUS_SAMPLES) >>> 0;
        this.framesSent = due - 1;
      }
      while (this.framesSent < due) {
        this.sendFrame(transceiver);
        this.framesSent += 1;
      }
    }, FRAME_MS / 2);
  }

  private sendFrame(transceiver: ReturnType<InstanceType<Werift['RTCPeerConnection']>['addTransceiver']>): void {
    if (!this.encoder || !this.werift) return;
    const relay = this.takeRelayFrame();
    const speaker = new Int16Array(OPUS_SAMPLES * 2);
    for (let i = 0; i < 480; i++) {
      const sample = relay.readInt16LE(i * 2);
      const first = Math.round((this.lastInputSample + sample) / 2);
      // 24 kHz -> 48 kHz by linear interpolation, duplicated to both channels.
      speaker[i * 4] = speaker[i * 4 + 1] = first;
      speaker[i * 4 + 2] = speaker[i * 4 + 3] = sample;
      this.lastInputSample = sample;
    }
    const opus = this.encoder.encode(speaker, { frameSize: OPUS_SAMPLES });
    const rtp = new this.werift.RtpPacket(
      new this.werift.RtpHeader({ marker: false, payloadType: 111, sequenceNumber: this.sequence, timestamp: this.timestamp }),
      Buffer.from(opus),
    );
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + OPUS_SAMPLES) >>> 0;
    void transceiver.sender.sendRtp(rtp).catch(() => undefined);
  }

  private takeRelayFrame(): Buffer {
    const frame = Buffer.alloc(RELAY_FRAME_BYTES);
    let offset = 0;
    while (offset < RELAY_FRAME_BYTES && this.input.length > 0) {
      const head = this.input[0];
      const take = Math.min(head.length, RELAY_FRAME_BYTES - offset);
      head.copy(frame, offset, 0, take);
      offset += take;
      if (take === head.length) this.input.shift();
      else this.input[0] = head.subarray(take);
    }
    this.inputBytes -= offset;
    return frame;
  }

  private lastSequence: number | null = null;

  private onRtp(packet: InstanceType<Werift['RtpPacket']>): void {
    if (!this.decoder || !this.werift || this.closed) return;
    const sequence = packet.header.sequenceNumber;
    if (this.lastSequence !== null) {
      const ahead = (sequence - this.lastSequence) & 0xffff;
      if (ahead === 0 || ahead > 0x8000) return; // duplicate or late
    }
    this.lastSequence = sequence;
    let decoded: Int16Array;
    try {
      decoded = this.decoder.decode(this.werift.dePacketizeRtpPackets('opus', [packet]).data, { maxFrameSize: 5760 });
    } catch {
      decoded = this.decoder.decodePacketLoss(OPUS_SAMPLES);
    }
    // 48 kHz speaker -> 24 kHz mono: average both channels and adjacent samples.
    const frames = Math.floor(decoded.length / 4);
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      const sum = decoded[i * 4] + decoded[i * 4 + 1] + decoded[i * 4 + 2] + decoded[i * 4 + 3];
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 4))), i * 2);
    }
    this.emit('audio', out);
  }
}
