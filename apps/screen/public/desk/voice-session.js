/** Browser exchange policy, independent of microphone / DOM for deterministic tests. */
export class VoiceSession {
  state = 'idle';
  focus = false;
  timer = null;
  idleTimer = null;
  drainTimer = null;
  constructor({ change, send, arm, stop, finish, reopen, dictationOnly = false }) { Object.assign(this, { change, send, arm, stop, finish, reopen, dictationOnly }); }
  set(state) { this.state = state; this.change(state); }
  setFocus(on) {
    if (this.dictationOnly) return;
    if (!on && this.focus) return this.cancel();
    if (on && !this.focus && !['connecting', 'listening', 'holding', 'holding_nudge', 'sending'].includes(this.state)) return;
    this.focus = on;
    this.change(this.state);
  }
  start() { if (this.state === 'idle' || this.state === 'error') this.set('connecting'); }
  ready() { if (this.state === 'connecting') this.set('listening'); }
  holding(nudge = false) { if (['listening', 'your-turn', 'holding', 'holding_nudge'].includes(this.state)) { this.activity(); this.set(nudge ? 'holding_nudge' : 'holding'); } }
  keep() { if (this.state === 'holding_nudge') this.set('holding'); }
  activity() { clearTimeout(this.idleTimer); this.idleTimer = null; }
  inputEnd() {
    if (!['listening', 'your-turn', 'holding', 'holding_nudge'].includes(this.state)) return;
    this.activity();
    if (this.dictationOnly) {
      this.set('finishing');
      // Capture is closed; allow in-flight transcript deltas to reach the draft.
      this.drainTimer = setTimeout(() => this.cancel(), 1500);
      return;
    }
    this.set('sending');
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.state !== 'sending') return;
      if (this.focus) this.arm();
      this.set('waiting');
      try {
        const result = await this.send(this.focus);
        if (this.state !== 'waiting') return;
        if (result?.status !== 'sent') this.error();
        else if (!this.focus) this.cancel();
      } catch { if (this.state === 'waiting') this.error(); }
    }, 3000);
  }
  speaking() { if (this.focus && this.state === 'waiting') this.set('speaking'); }
  async spoken() {
    if (!this.focus || this.state !== 'speaking') return;
    this.set('reopening');
    try {
      await this.reopen();
      if (this.state !== 'reopening') return;
      this.set('your-turn');
      this.idleTimer = setTimeout(() => this.cancel(), 30_000);
    } catch { if (this.state === 'reopening') this.error(); }
  }
  tap() { if (['listening', 'your-turn', 'holding', 'holding_nudge'].includes(this.state)) this.finish(); else this.cancel(); }
  edit() { if (['connecting', 'listening', 'your-turn', 'holding', 'holding_nudge', 'sending', 'finishing'].includes(this.state)) this.cancel(); }
  hidden() { this.cancel(); }
  cancel() { clearTimeout(this.drainTimer); this.drainTimer = null; clearTimeout(this.timer); this.timer = null; this.activity(); this.focus = false; this.stop(); this.set('idle'); }
  error() { this.cancel(); this.set('error'); }
}

export const voiceLabel = (state, seconds = 3) => ({ connecting: 'Connecting…', listening: 'Listening…', holding: "Holding · say 'send it' when you're done", holding_nudge: 'Still holding', finishing: 'Finishing dictation…', sending: `Sending in ${seconds}s`, waiting: 'Sent · waiting for the reply', speaking: 'Reading the reply', reopening: 'Your turn', 'your-turn': 'Your turn' })[state] || '';
/** Voice has only the ordinary reply path, never decision/approval commands. */
export async function sendVoiceReply(store, item, focus, delivered = () => {}) {
  const result = await store.sendReply(item, undefined, focus ? { stay: true } : {});
  // A lost response can still have delivered. Let close/resume retain an unknown outcome.
  if (!result?.transport && result?.outcome?.delivery !== 'unknown') {
    if (result?.status === 'sent') delivered(true);
    else if (result?.status === 'failed') delivered(false);
  }
  return result;
}
