import { applyHistoryPreference } from './voice-history.js';
import { claimVoice, releaseVoice } from './voice-owner.js';
import { VoiceSession, sendVoiceReply } from './voice-session.js';
const root = () => new URL('../', import.meta.url);
export const voiceEndpoint = (item, watch = false) => new URL(`api/desk/voice?${item === 'start-work' ? 'mode=dictation' : `item=${encodeURIComponent(item)}${watch ? '&watch=1' : ''}`}`, root());
const endpoint = voiceEndpoint;

/** Shared capture/playback runtime. The injected adapter owns drafts, sending, captions and navigation. */
export async function startVoiceRuntime({ id, store, startWork = false, dictation = null, current = { current: { ready: true, dictation } }, update = () => {}, own = () => {}, stopped: onStop = () => {} }) {
    const ctx = new AudioContext();
    const unlocked = ctx.resume();
    let socket, stream, node, source, stopped = false, playHead = 0, playbackTimer;
    const pending = new AbortController();
    const origin = store.state.presentation;
    let unsubscribe, destinationOpened = false;
    let base = dictation ? current.current.dictation.value : startWork ? store.state.startWork.form.prompt : store.draftFor(id), transcript = '';
    const playing = new Set();
    const runtime = { item: id, transferring: false, update, voice: '', level: 0,
      publish: () => runtime.update({ state: session.state, focus: session.focus, voice: runtime.voice, level: runtime.level }) };
    const closeMic = () => { stream?.getTracks().forEach(track => track.stop()); node?.disconnect(); source?.disconnect(); stream = node = source = null; };
    const sendJson = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const hidden = () => { if (document.hidden) session.hidden(); };
    const escape = e => { if (e.key === 'Escape') session.cancel(); };
    async function openMic() {
      const next = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, channelCount: 1 } });
      if (stopped) { next.getTracks().forEach(track => track.stop()); return; }
      stream = next;
      node = new AudioWorkletNode(ctx, 'desk-capture');
      source = ctx.createMediaStreamSource(stream); source.connect(node);
      node.port.onmessage = ({ data }) => {
        if (!['listening', 'your-turn', 'holding', 'holding_nudge'].includes(session.state) || socket?.readyState !== WebSocket.OPEN) return;
        const pcm = new Int16Array(data);
        let sum = 0; for (const v of pcm) sum += v * v;
        runtime.level = Math.min(1, Math.sqrt(sum / pcm.length) / 5000); runtime.publish();
        if (socket.bufferedAmount < 48000) socket.send(data);
      };
    }
    const session = new VoiceSession({
      dictationOnly: !!dictation,
      change: next => {
        if (['sending', 'finishing', 'waiting', 'speaking'].includes(next)) closeMic();
        if (!dictation && runtime.item !== 'start-work') store.set({ voiceFocusItem: session.focus ? runtime.item : null });
        runtime.publish();
      },
      finish: () => sendJson({ type: 'finish' }),
      arm: () => { if (runtime.item !== 'start-work') sendJson({ type: 'sent' }); },
      send: async focus => {
        if (runtime.item !== 'start-work') {
          return sendVoiceReply(store, runtime.item, focus, ok => sendJson({ type: 'delivered', ok }));
        }
        if (!current.current.ready) return { status: 'failed' };
        // Start closes the sheet immediately. Preserve capture ownership only for an explicit Focus transfer.
        runtime.transferring = focus;
        const result = await store.submitStartWork();
        if (!focus || stopped) return { status: result?.itemId ? 'sent' : 'failed' };
        if (!result?.itemId) { runtime.transferring = false; return { status: 'failed' }; }
        store.refreshLists(0);
        if (stopped) return { status: 'sent' };
        runtime.item = result.itemId;
        base = ''; transcript = '';
        socket.onclose = null; socket.onmessage = null; socket.close();
        store.set({ voiceFocusItem: runtime.item });
        store.nextOpen(runtime.item);
        destinationOpened = true;
        runtime.transferring = false;
        // Start returns before the source poll ingests the new item. Wait for the normal
        // voice authorization to see it; never bypass replyability to open a session.
        const deadline = Date.now() + 30_000;
        while (!stopped) {
          const response = await fetch(endpoint(runtime.item), { signal: pending.signal });
          if (response.ok) break;
          if (Date.now() >= deadline) { store.toast('The thread started, but voice is not ready. Open its mic when it appears.'); return { status: 'failed' }; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!stopped) connect(true);
        return { status: 'sent' };
      },
      reopen: async () => {
        base = store.draftFor(runtime.item); transcript = '';
        await openMic();
        if (!stopped) sendJson({ type: 'resume' });
      },
      stop: () => {
        if (stopped) return;
        stopped = true; unsubscribe?.(); pending.abort(); clearTimeout(playbackTimer); closeMic();
        sendJson({ type: 'stop' }); socket?.close();
        for (const sound of playing) { try { sound.stop(); } catch {} }
        void ctx.close();
        document.removeEventListener('visibilitychange', hidden);
        document.removeEventListener('keydown', escape, true);
        onStop(runtime);
        if (store.state.voiceFocusItem === runtime.item) store.set({ voiceFocusItem: null });
        releaseVoice(session);
      },
    });
    function connect(watch = false) {
      const url = endpoint(dictation ? 'start-work' : runtime.item, watch); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      applyHistoryPreference(url, store.state.role);
      socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
      socket.onmessage = ({ data }) => {
        if (stopped) return;
        if (typeof data !== 'string') {
          if (session.state !== 'speaking') return;
          const pcm = new Int16Array(data), buffer = ctx.createBuffer(1, pcm.length, 24000);
          const channel = buffer.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
          const sound = ctx.createBufferSource(); sound.buffer = buffer; sound.connect(ctx.destination);
          playing.add(sound); sound.onended = () => playing.delete(sound);
          const at = Math.max(playHead, ctx.currentTime + 0.03); sound.start(at); playHead = at + buffer.duration;
          return;
        }
        const event = JSON.parse(data);
        if (event.voice) { runtime.voice = event.voice; runtime.publish(); }
        const capturing = ['listening', 'your-turn', 'holding', 'holding_nudge', 'sending', 'finishing'].includes(session.state);
        if (event.type === 'transcript' && capturing) {
          if (event.delta.trim()) session.activity();
          transcript += event.delta;
          const text = [base, transcript].filter(Boolean).join(base ? (dictation ? ' ' : '\n') : '');
          if (dictation) current.current.dictation.onTranscript(text);
          else if (runtime.item === 'start-work') store.setStartField('prompt', text);
          else store.setDraft(runtime.item, text);
        } else if (event.type === 'transcript_final' && capturing) {
          // A late final after the send window closed would restore the sent text into the cleared draft.
          transcript = event.text;
          const text = [base, transcript].filter(Boolean).join(base ? (dictation ? ' ' : '\n') : '');
          if (dictation) current.current.dictation.onTranscript(text);
          else if (runtime.item === 'start-work') store.setStartField('prompt', text);
          else store.setDraft(runtime.item, text);
        } else if (event.type === 'cancel') { session.cancel();
        } else if (event.type === 'status') {
          if (event.state === 'listening') session.ready();
          else if (event.state === 'holding' || event.state === 'holding_nudge') session.holding(event.state === 'holding_nudge');
          else if (event.state === 'sending') session.inputEnd();
          else if (event.state === 'speaking') session.speaking();
          else if (event.state === 'paused') playbackTimer = setTimeout(() => void session.spoken(), Math.max(0, (playHead - ctx.currentTime) * 1000));
          else if (event.state === 'ended' && session.state !== 'error') session.cancel();
        } else if (event.type === 'error') { store.toast(event.message); session.error(); }
      };
      socket.onerror = () => { if (!stopped) session.error(); };
      socket.onclose = () => { if (!stopped) session.error(); };
    }
    runtime.session = session;
    unsubscribe = store.subscribe(() => {
      if (destinationOpened && (store.state.presentation.view !== 'conversation' || store.state.presentation.itemId !== runtime.item)) { session.cancel(); return; }
      if (runtime.transferring && runtime.item === 'start-work' && (store.state.presentation !== origin || store.state.startWork)) session.cancel();
    });
    claimVoice(session); own(runtime);
    session.start();
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('keydown', escape, true);
    try {
      await unlocked;
      await ctx.audioWorklet.addModule(new URL('./voice-capture.js', import.meta.url));
      if (stopped) return;
      await openMic();
      if (!stopped) connect();
    } catch { if (!stopped) { store.toast('Voice could not start. Check microphone permission and the subscription login.'); session.error(); } }
    return runtime;
}
