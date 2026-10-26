import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { voiceLabel } from './voice-session.js';
import { startVoiceRuntime, voiceEndpoint as endpoint } from './voice-runtime.js';
let active = null;
export function cancelVoiceEdit(item) { if (active?.item === item) active.session.edit(); }

/** The same capture/session moves from Start work to its new thread, retaining the unlocked AudioContext. */
export function VoiceButton({ item, store, startWork = false, ready = true, dictation = null }) {
  const id = dictation?.id || (startWork ? 'start-work' : item.id);
  const [view, setView] = useState({ state: 'idle', focus: false, voice: '', level: 0 });
  const [seconds, setSeconds] = useState(3);
  const own = useRef(null);
  const current = useRef({ ready, dictation }); current.current = { ready, dictation };
  useEffect(() => {
    if (view.state !== 'sending') return;
    setSeconds(3);
    const timer = setInterval(() => setSeconds(n => Math.max(1, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [view.state]);
  useEffect(() => {
    const abort = new AbortController();
    if (!startWork && !dictation) fetch(endpoint(id), { signal: abort.signal }).then(r => r.ok ? r.json() : null).then(v => { if (v) setView(old => ({ ...old, voice: v.voice })); }).catch(() => {});
    if (active?.item === id) { own.current = active; active.update = setView; active.publish(); }
    return () => {
      abort.abort();
      const runtime = own.current;
      if (runtime?.item === id && !runtime.transferring) runtime.session.cancel();
      if (runtime?.update === setView) runtime.update = () => {};
    };
  }, [id]);
  async function start() {
    active?.session.cancel();
    await startVoiceRuntime({ id, store, startWork, dictation, current, update: setView,
      own: runtime => { own.current = active = runtime; },
      stopped: runtime => { if (active === runtime) active = null; },
    });
  }
  const { state, focus, voice, level } = view;
  const on = !['idle', 'error'].includes(state);
  const label = !on ? (dictation ? 'Dictate your answer' : 'Start voice reply') : ['listening', 'your-turn', 'holding', 'holding_nudge'].includes(state) ? 'Finish dictation' : 'Stop listening';
  return html`<div class="rd-voice">
    <button type="button" class=${`ib rd-mic ${state}`} aria-label=${label} title=${`${label}${voice ? ` · Speaks as ${voice[0].toUpperCase() + voice.slice(1)}` : ''}`} onClick=${() => on ? own.current?.session.tap() : start()} style=${`--voice-level:${level}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>
    </button>
    ${on ? html`${!dictation ? html`<button type="button" class="btn rd-focus" aria-pressed=${focus} disabled=${!focus && !['connecting', 'listening', 'holding', 'holding_nudge', 'sending'].includes(state)} onClick=${() => own.current?.session.setFocus(!focus)}>${startWork ? 'Send and go to Focus' : 'Focus'}</button>` : null}
      <div class="rd-voice-strip" role="status"><span>${voiceLabel(state, seconds)}</span>${['holding', 'holding_nudge'].includes(state) ? html`<button type="button" class="linkish" onClick=${() => own.current?.session.tap()}>Send</button>` : null}${state === 'holding_nudge' ? html`<button type="button" class="linkish" onClick=${() => own.current?.session.keep()}>Keep</button>` : null}${state === 'sending' ? html`<button type="button" class="linkish" onClick=${() => own.current?.session.cancel()}>Undo</button>` : null}<button type="button" class="linkish" onClick=${() => own.current?.session.cancel()}>Stop listening</button></div>` : null}
  </div>`;
}
