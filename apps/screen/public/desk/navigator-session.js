/** DOM-free single-command lifecycle; cancellation invalidates in-flight execution results. */
export class NavigatorSession {
  state = 'idle';
  constructor(effects) { this.e = effects; }
  set(state) { this.state = state; this.e.change(state); }
  start() { if (this.state === 'idle') this.set('connecting'); }
  ready() { if (this.state === 'connecting') this.set('listening'); }
  resolving() { if (this.state === 'listening') { this.set('resolving'); this.e.closeMic(); } }
  async action(value) {
    if (this.state !== 'resolving') return;
    this.set('executing');
    let ok = false;
    try { ok = await this.e.execute(value); } catch {}
    if (this.state === 'executing') this.e.acknowledge(ok);
  }
  confirming() { if (['resolving', 'executing'].includes(this.state)) this.set('confirming'); }
  cancel() { if (this.state === 'idle') return; this.set('idle'); this.e.stop(); }
  error() { this.cancel(); }
  tap() { this.cancel(); }
  hidden() { this.cancel(); }
}
