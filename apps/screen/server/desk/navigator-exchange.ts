import { TurnPolicy } from '@tango/tango-voice/turn/turn-policy';
import { SpeechPause } from './speech-pause.js';
import type { LiveSessionClient, LiveDelegation, LiveTranscriptDelta } from '@tango/tango-voice/live/gpt-live-client';
import type { NavigatorContext, NavigatorResolution } from './navigator-resolver.js';

/** Quiet transcription after a late word before a command resolves. */
const LATE_DRAIN_MS = 600;
export interface NavigatorOptions {
  create(): LiveSessionClient;
  voice: string;
  resolve(text: string, context: NavigatorContext): Promise<NavigatorResolution>;
  json(value: Record<string, unknown>): void;
  audio(pcm: Buffer): void;
  log(kind: string, data?: Record<string, unknown>): void;
  disconnect(): void;
}
/** One delegated utterance; only an acknowledged browser action may become spoken confirmation. */
export class NavigatorExchange {
  state = 'connecting';
  private client: LiveSessionClient;
  private closed = false;
  private transcript = '';
  private policy = new TurnPolicy({ ramble: false });
  private pause = new SpeechPause();
  private untilMs = 0;
  private unfinished = false;
  private lateInPause = false;
  private context: NavigatorContext | null = null;
  private delegation: string | null = null;
  private resolution: NavigatorResolution | null = null;
  private started = Date.now();
  private speakingAt = 0;
  private lastAudio = 0;
  private firstAudio = false;
  private confirmationAppended = false;
  private mutedAudio = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private o: NavigatorOptions) {
    this.client = o.create();
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.started > 90_000) this.end('session limit');
      if (this.state === 'confirming' && ((this.lastAudio && now - this.lastAudio > 1800) || now - this.speakingAt > 15_000)) this.end('confirmed');
    }, 200);
    this.client.on('error', () => this.fail());
    this.client.on('closed', () => { if (!this.closed) this.fail(); });
    this.client.on('inputTranscript', (d: LiveTranscriptDelta) => {
      if (this.state !== 'listening') return;
      const delta = d.delta.slice(0, 8000 - this.transcript.length);
      this.transcript += delta; this.policy.words(delta, this.lateInPause); this.untilMs = 0;
      if (delta.trim() && this.pause.paused) this.lateInPause = true;
      this.o.json({ type: 'transcript', delta: d.delta });
      // Late words after the pause drain before the command resolves, so "Open" + " Voice Mode" stays whole.
      if (delta.trim() && this.pause.paused) this.untilMs = this.pause.trailingQuietMs + LATE_DRAIN_MS;
    });
    this.client.on('delegation', (d: LiveDelegation) => { if (this.state === 'listening') { this.delegation = d.id; this.checkPause('model'); } });
    this.client.on('outputTranscript', (d: LiveTranscriptDelta) => this.o.log('output_transcript', { characters: d.delta.length, beforeConfirmation: !this.confirmationAppended }));
    this.client.on('audio', (pcm: Buffer) => {
      if (this.closed) return;
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      if (this.state !== 'confirming' || !this.confirmationAppended) {
        if (peak > 120 && !this.mutedAudio) { this.mutedAudio = true; this.o.log('output_muted'); }
        return;
      }
      if (peak > 120) {
        this.lastAudio = Date.now();
        if (!this.firstAudio) { this.firstAudio = true; this.o.log('confirmation_audio', { latencyMs: Date.now() - this.speakingAt }); }
      }
      if (this.firstAudio) this.o.audio(pcm);
    });
    o.log('navigator_start');
  }
  private status(state: string) { this.state = state; this.o.json({ type: 'status', state }); }
  async start() {
    try {
      await this.client.start({ voice: this.o.voice, instructions: 'You are the voice navigator for the desk on the user’s screen. Backend tools: the desk backend opens named threads, changes tabs and spaces, and handles seen, snooze, done and pin. Delegation policy: ALWAYS delegate every complete user request to the backend, including requests to open or show a thread, go somewhere, mark something, or requests you cannot perform. The backend decides whether it is allowed. Do not try to do the work yourself or answer from memory. When the user finishes their command, delegate immediately. Do not wait for another instruction. Say nothing before delegating. Only when DESK_CONFIRMATION is appended, read that short sentence exactly, then stop.' });
      if (this.closed) { await this.client.close(0); return; }
      this.status('listening');
    } catch { this.fail(); }
  }
  setContext(context: NavigatorContext) { if (!this.context && ['connecting', 'listening'].includes(this.state) && !this.transcript) this.context = context; }
  input(pcm: Buffer) {
    if (this.state !== 'listening' || pcm.length > 9600 || pcm.length % 2 !== 0) return;
    this.client.appendAudio(pcm); this.pause.append(pcm);
    if (!this.pause.paused) this.lateInPause = false;
    if (this.pause.paused && this.transcript && this.pause.trailingQuietMs >= this.untilMs) this.checkPause('pause');
  }
  private checkPause(by: 'pause' | 'model') {
    const result = this.policy.pause(this.pause.trailingQuietMs, by === 'model' ? 'model' : 'local');
    if (result.kind === 'cancel') { this.o.json({ type: 'cancel' }); this.end('cancel'); return; }
    if (result.kind === 'wait') { this.untilMs = result.untilMs ?? Infinity; this.unfinished ||= result.untilMs === 4000; return; }
    this.transcript = result.text;
    this.o.log('input_end', { characters: this.transcript.length, by, mode: 'quick', rule: this.unfinished ? 'unfinished-wait' : by });
    void this.resolve();
  }
  private async resolve() {
    this.status('resolving');
    try {
      if (!this.context || !this.transcript.trim()) { await this.confirm("I didn't catch a desk command."); return; }
      this.resolution = await this.o.resolve(this.transcript, this.context);
      if (this.closed) return;
      this.o.log('resolved', { action: this.resolution.action, outcome: this.resolution.action ? 'action' : 'no action' });
      this.status('executing');
      this.o.json({ type: 'action', ...this.resolution });
    } catch { this.fail(); }
  }
  async acknowledge(ok: boolean) {
    if (this.closed || this.state !== 'executing' || !this.resolution) return;
    this.o.log('executed', { ok });
    await this.confirm(ok ? this.resolution.confirmation : "That didn't complete. Check the desk.");
  }
  private async confirm(text: string) {
    if (this.closed) return;
    this.speakingAt = Date.now();
    this.status('confirming');
    this.o.json({ type: 'confirmation', text });
    try { await this.client.appendContext('commentary', `DESK_CONFIRMATION (read exactly, then stop): ${JSON.stringify(text)}`, this.delegation); this.confirmationAppended = true; }
    catch { this.fail(); }
  }
  fail() {
    if (this.closed) return;
    this.o.json({ type: 'error', message: 'Voice command could not complete.' });
    this.end('error');
  }
  end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    void this.client.close(0).catch(() => undefined);
    this.status('ended');
    this.o.log('ended', { reason, durationMs: Date.now() - this.started });
    this.o.disconnect();
  }
}
