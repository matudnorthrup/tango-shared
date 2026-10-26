import { loadApps } from './app-list.js';
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { sameNavigatorAction } from './navigator-actions.js';
import { NavigatorSession } from './navigator-session.js';
import { navigatorContext, executeNavigator } from './navigator-context.js';
import { claimVoice, releaseVoice } from './voice-owner.js';
export function NavigatorButton({ store, phone }) {
  const [state, setState] = useState('idle'), [text, setText] = useState(''), [candidates, setCandidates] = useState([]);
  const own = useRef(null);
  useEffect(() => () => own.current?.cancel(), []);
  function start() {
    let context = navigatorContext(store);
    const ctx = new AudioContext(), unlocked = ctx.resume();
    let socket, stream, node, source, stopped = false, playHead = 0;
    const sounds = new Set();
    const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const closeMic = () => { stream?.getTracks().forEach(t => t.stop()); node?.disconnect(); source?.disconnect(); };
    const hidden = () => { if (document.hidden) session.hidden(); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); session.cancel(); } };
    const session = new NavigatorSession({
      change: setState, closeMic,
      execute: async value => {
        setCandidates((value.candidates || []).filter(c => c.action?.op === 'open' && context.choices.some(x => sameNavigatorAction(c.action, x.action))));
        return executeNavigator(store, value, context);
      },
      acknowledge: ok => send({ type: 'executed', ok }),
      stop: () => {
        if (stopped) return;
        stopped = true; closeMic(); send({ type: 'stop' }); socket?.close();
        for (const sound of sounds) { try { sound.stop(); } catch {} }
        void ctx.close(); releaseVoice(session);
        document.removeEventListener('visibilitychange', hidden);
        document.removeEventListener('keydown', key, true);
      },
    });
    claimVoice(session); own.current = session; setText(''); setCandidates([]); session.start();
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('keydown', key, true);
    void (async () => {
      try {
        await unlocked;
        context = navigatorContext(store, await loadApps());
        if (stopped) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, channelCount: 1 } });
        if (stopped) { closeMic(); return; }
        await ctx.audioWorklet.addModule(new URL('./voice-capture.js', import.meta.url));
        if (stopped) return;
        node = new AudioWorkletNode(ctx, 'desk-capture'); source = ctx.createMediaStreamSource(stream); source.connect(node);
        const url = new URL('../api/desk/voice?mode=navigator', import.meta.url); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
        socket.onopen = () => send({ type: 'context', context });
        node.port.onmessage = ({ data }) => { if (session.state === 'listening' && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 48000) socket.send(data); };
        socket.onmessage = ({ data }) => {
          if (stopped) return;
          if (typeof data !== 'string') {
            if (session.state !== 'confirming') return;
            const pcm = new Int16Array(data), buffer = ctx.createBuffer(1, pcm.length, 24000), channel = buffer.getChannelData(0);
            for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
            const sound = ctx.createBufferSource(); sound.buffer = buffer; sound.connect(ctx.destination); sounds.add(sound); sound.onended = () => sounds.delete(sound);
            const at = Math.max(playHead, ctx.currentTime + 0.03); sound.start(at); playHead = at + buffer.duration;
            return;
          }
          const event = JSON.parse(data);
          if (event.type === 'status') {
            if (event.state === 'listening') session.ready();
            else if (event.state === 'resolving') session.resolving();
            else if (event.state === 'confirming') session.confirming();
            else if (event.state === 'ended') session.cancel();
          } else if (event.type === 'action') void session.action(event);
          else if (event.type === 'confirmation') setText(event.text);
          else if (event.type === 'error') { store.toast(event.message); session.error(); }
        };
        socket.onerror = () => { if (!stopped) { store.toast('Voice connection failed.'); session.error(); } };
        socket.onclose = () => { if (!stopped) session.cancel(); };
      } catch { if (!stopped) { store.toast('Voice could not start. Check microphone permission and the subscription login.'); session.error(); } }
    })();
  }
  const active = state !== 'idle';
  const label = state === 'idle' ? 'Voice command' : state === 'connecting' ? 'Connecting…' : state === 'listening' ? 'Listening…' : state === 'confirming' ? text || 'Confirming…' : 'Doing…';
  return html`<div class=${`nx-voice nx-navigator${active ? ' active' : ''}${phone ? ' phone' : ''}`}>
    <div class="nx-vpill"><button class="nx-vtoggle" aria-label=${active ? `Stop voice command · ${label}` : 'Start voice command'} title=${label} onClick=${() => active ? own.current?.tap() : start()}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>
      ${!phone || active ? html`<span class="nx-vtext" role="status">${label}</span>` : null}
    </button></div>
    ${candidates.length ? html`<section class="nx-vpanel" aria-label="Matching threads">${candidates.map(c => html`<button class="btn" onClick=${() => { own.current?.cancel(); void executeNavigator(store, { action: c.action }, navigatorContext(store)); setCandidates([]); }}>${c.label}</button>`)}<button class="btn" onClick=${() => setCandidates([])}>Close</button></section>` : null}
  </div>`;
}
