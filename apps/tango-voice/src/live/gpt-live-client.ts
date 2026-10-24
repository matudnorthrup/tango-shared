import { EventEmitter } from 'node:events';

// Thin WebSocket client for OpenAI GPT-Live (wss://api.openai.com/v1/live/sessions).
// Audio is mono PCM16 at 24 kHz in both directions. The caller owns pacing:
// GPT-Live expects a continuous input stream (silence included), see LiveInputPump.

export const LIVE_SAMPLE_RATE = 24_000;
export const LIVE_BYTES_PER_MS = (LIVE_SAMPLE_RATE * 2) / 1000;

export type LiveContextKind = 'instructions' | 'thinking' | 'commentary';

export interface LiveHistoryMessage {
  role: 'developer' | 'user' | 'assistant';
  text: string;
}

export interface LiveSessionOptions {
  model?: string;
  instructions: string;
  voice?: string;
  input?: LiveHistoryMessage[];
}

export interface LiveTranscriptDelta {
  delta: string;
  startMs: number;
  endMs: number;
}

export interface LiveDelegation {
  id: string;
  offsetMs: number;
  /** The voice model's own phrasing of the request (subscription route only). */
  prompt?: string;
}

export interface LiveAck {
  clientEventId: string;
  startMs?: number;
  endMs?: number;
}

export interface LiveClientError {
  clientEventId?: string;
  code?: string;
  message: string;
}

export interface GptLiveClientOptions {
  apiKey: string;
  url?: string;
}

type LiveEvent = { type: string; [key: string]: unknown };

/** What the operator needs from a GPT-Live connection, whichever route it uses. */
export interface LiveSessionClient extends EventEmitter {
  readonly sessionId: string | null;
  readonly expiresAt: number | null;
  readonly isOpen: boolean;
  start(session: LiveSessionOptions): Promise<void>;
  appendAudio(pcm: Buffer): void;
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null): Promise<LiveAck>;
  close(timeoutMs?: number): Promise<unknown>;
}

/**
 * Events:
 * - 'event' (LiveEvent): every server event except audio deltas
 * - 'audio' (Buffer): output PCM16
 * - 'inputTranscript' / 'outputTranscript' (LiveTranscriptDelta)
 * - 'delegation' (LiveDelegation)
 * - 'ack' (LiveAck): context append acknowledged
 * - 'error' (LiveClientError)
 * - 'closed' ({ reason, usage })
 */
export class GptLiveClient extends EventEmitter implements LiveSessionClient {
  private socket: WebSocket | null = null;
  private eventSeq = 0;
  private pendingAcks = new Map<string, { resolve: (ack: LiveAck) => void; reject: (err: Error) => void }>();
  sessionId: string | null = null;
  expiresAt: number | null = null;

  constructor(private readonly options: GptLiveClientOptions) {
    super();
  }

  async start(session: LiveSessionOptions): Promise<void> {
    const url = this.options.url ?? 'wss://api.openai.com/v1/live/sessions';
    // Node's undici WebSocket accepts headers in the init object.
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.options.apiKey}` } } as never);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('GPT-Live session.start timed out')), 15_000);
      socket.onopen = () => {
        this.send({
          type: 'session.start',
          session: {
            model: session.model ?? 'gpt-live-1',
            instructions: session.instructions,
            audio: {
              format: { type: 'audio/pcm', rate: LIVE_SAMPLE_RATE },
              output: { voice: session.voice ?? 'marin' },
            },
            delegation: { type: 'client' },
            input: (session.input ?? []).map((message) => ({
              type: 'message',
              role: message.role,
              content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
            })),
          },
        });
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as LiveEvent;
        if (event.type === 'session.started') {
          clearTimeout(timeout);
          const started = event.session as { id: string; expires_at?: number };
          this.sessionId = started.id;
          this.expiresAt = started.expires_at ?? null;
          resolve();
        } else if (event.type === 'error' && !this.sessionId) {
          clearTimeout(timeout);
          reject(new Error(`GPT-Live start failed: ${JSON.stringify(event.error ?? event)}`));
        }
        this.handleEvent(event);
      };
      socket.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error(`GPT-Live socket error: ${(err as { message?: string }).message ?? 'unknown'}`));
      };
      socket.onclose = (ev) => {
        this.emit('closed', { reason: `socket ${ev.code} ${ev.reason}`.trim(), usage: null });
        for (const pending of this.pendingAcks.values()) pending.reject(new Error('GPT-Live socket closed'));
        this.pendingAcks.clear();
      };
    });
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  appendAudio(pcm: Buffer): void {
    if (!this.isOpen || pcm.length === 0) return;
    this.send({ type: 'session.input_audio.append', audio: pcm.toString('base64') }, false);
  }

  /** Append context; resolves when GPT-Live acknowledges injection (not speech). */
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null): Promise<LiveAck> {
    const eventId = this.nextEventId(kind);
    const ack = new Promise<LiveAck>((resolve, reject) => {
      this.pendingAcks.set(eventId, { resolve, reject });
    });
    this.send({ type: `session.${kind}.append`, event_id: eventId, delegation_id: delegationId, content });
    return ack;
  }

  muteInput(muted: boolean): void {
    this.send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  }

  async close(timeoutMs = 15_000): Promise<unknown> {
    if (!this.isOpen) return null;
    const closed = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.once('closed', ({ usage }: { usage: unknown }) => {
        clearTimeout(timer);
        resolve(usage);
      });
    });
    this.send({ type: 'session.close' });
    const usage = await closed;
    this.socket?.close();
    return usage;
  }

  private handleEvent(event: LiveEvent): void {
    switch (event.type) {
      case 'session.output_audio.delta':
        this.emit('audio', Buffer.from(String(event.delta), 'base64'));
        return;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        this.emit(event.type === 'session.input_transcript.delta' ? 'inputTranscript' : 'outputTranscript', {
          delta: String(event.delta ?? ''),
          startMs: Number(event.start_ms ?? 0),
          endMs: Number(event.end_ms ?? 0),
        } satisfies LiveTranscriptDelta);
        break;
      case 'session.delegation.created': {
        const delegation = event.delegation as { id: string };
        this.emit('delegation', { id: delegation.id, offsetMs: Number(event.offset_ms ?? 0) } satisfies LiveDelegation);
        break;
      }
      case 'session.instructions.appended':
      case 'session.thinking.appended':
      case 'session.commentary.appended': {
        const ack: LiveAck = {
          clientEventId: String(event.client_event_id),
          startMs: event.start_ms as number | undefined,
          endMs: event.end_ms as number | undefined,
        };
        this.pendingAcks.get(ack.clientEventId)?.resolve(ack);
        this.pendingAcks.delete(ack.clientEventId);
        this.emit('ack', ack);
        break;
      }
      case 'error': {
        const detail = (event.error ?? {}) as { message?: string; code?: string; client_event_id?: string };
        const error: LiveClientError = {
          clientEventId: detail.client_event_id ?? (event.client_event_id as string | undefined),
          code: detail.code,
          message: detail.message ?? JSON.stringify(event),
        };
        if (error.clientEventId && this.pendingAcks.has(error.clientEventId)) {
          this.pendingAcks.get(error.clientEventId)?.reject(new Error(`${error.code ?? 'error'}: ${error.message}`));
          this.pendingAcks.delete(error.clientEventId);
        }
        this.emit('error', error);
        break;
      }
      case 'session.closed':
        this.emit('closed', { reason: String(event.reason ?? 'closed'), usage: event.usage ?? null });
        break;
    }
    this.emit('event', event);
  }

  private nextEventId(prefix: string): string {
    this.eventSeq += 1;
    return `${prefix}_${Date.now().toString(36)}_${this.eventSeq}`;
  }

  private send(event: Record<string, unknown>, withId = true): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (withId && !event.event_id) event.event_id = this.nextEventId('evt');
    this.socket.send(JSON.stringify(event));
  }
}
