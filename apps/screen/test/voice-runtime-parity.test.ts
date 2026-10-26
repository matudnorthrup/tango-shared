import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../public/vendor/preact-htm.js', async original => ({
  ...await original<any>(), useState: (v: any) => [v, () => {}], useRef: (v: any) => ({ current: v }), useEffect: () => {},
}));
const owned = vi.hoisted(() => ({ session: null as any }));
vi.mock('../public/desk/voice-owner.js', async original => { const actual = await original<any>(); return { ...actual, claimVoice: (s: any) => { actual.claimVoice(s); owned.session = s; } }; });
// @ts-expect-error browser module
import { VoiceButton } from '../public/desk/voice.js';
// @ts-expect-error browser module
import { claimVoice } from '../public/desk/voice-owner.js';
let sockets: any[], track: any, sounds: any[];
function nodes(v: any): any[] { return Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' ? [v, ...nodes(v.props?.children)] : []; }
function store() {
  const s: any = { state: { role: 'full', presentation: {}, startWork: { form: { prompt: 'Base' } } }, draft: 'Base',
    draftFor: () => s.draft, setDraft: (_: any, text: string) => { s.draft = text; }, setStartField: (_: any, text: string) => { s.state.startWork.form.prompt = text; },
    set: (v: any) => Object.assign(s.state, v), subscribe: vi.fn(() => () => {}), toast: vi.fn(), refreshLists: vi.fn(), nextOpen: vi.fn(),
    submitStartWork: vi.fn(async () => ({ itemId: 'new-thread' })), sendReply: vi.fn(async () => { s.draft = ''; return { status: 'sent' }; }),
  }; return s;
}
async function start(s: any, props = {}) {
  const tree = VoiceButton({ item: { id: 'thread' }, store: s, ...props });
  await nodes(tree).find(n => n.type === 'button').props.onClick();
  sockets.at(-1).emit({ type: 'status', state: 'listening' });
  return tree;
}
beforeEach(() => {
  vi.useFakeTimers(); sockets = []; sounds = []; track = { stop: vi.fn() };
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', {}); vi.stubGlobal('location', { href: 'https://fixture.invalid/', protocol: 'https:' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
  vi.stubGlobal('AudioContext', class { resume = async () => {}; close = vi.fn(); audioWorklet = { addModule: async () => {} }; currentTime = 0; destination = {}; createMediaStreamSource = () => ({ connect() {}, disconnect() {} }); createBuffer = (_: any, size: number) => ({ getChannelData: () => new Float32Array(size), duration: 1 }); createBufferSource = () => { const s = { connect() {}, start: vi.fn(), stop: vi.fn() }; sounds.push(s); return s; }; });
  vi.stubGlobal('AudioWorkletNode', class { port = {}; disconnect() {} });
  vi.stubGlobal('WebSocket', class { static OPEN = 1; readyState = 1; binaryType = ''; bufferedAmount = 0; onmessage: any; onclose: any; send = vi.fn(); close = vi.fn(); constructor(public url: URL) { sockets.push(this); } emit(v: any) { this.onmessage({ data: typeof v === 'object' && !(v instanceof ArrayBuffer) ? JSON.stringify(v) : v }); } });
});
afterEach(() => { claimVoice({ cancel() {} }); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('keeps composer base, final words, ordinary reply and late-final protection', async () => {
  const s = store(); await start(s); const socket = sockets[0];
  socket.emit({ type: 'transcript', delta: 'hello' }); expect(s.draft).toBe('Base\nhello');
  socket.emit({ type: 'status', state: 'sending' });
  socket.emit({ type: 'transcript_final', text: 'hello world' }); expect(s.draft).toBe('Base\nhello world');
  await vi.advanceTimersByTimeAsync(3000); expect(s.sendReply).toHaveBeenCalledWith('thread', undefined, {});
  socket.emit({ type: 'transcript_final', text: 'late' }); expect(s.draft).toBe(''); expect(track.stop).toHaveBeenCalled();
});
it('Focus arms the reply, plays only after speaking, and reopens capture', async () => {
  const s = store(); await start(s);
  const session = owned.session, socket = sockets[0]; session.setFocus(true);
  expect(s.state.voiceFocusItem).toBe('thread');
  socket.emit(new Int16Array([100]).buffer); expect(sounds).toHaveLength(0);
  socket.emit({ type: 'status', state: 'sending' }); await vi.advanceTimersByTimeAsync(3000);
  expect(s.sendReply).toHaveBeenCalledWith('thread', undefined, { stay: true });
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'sent' }));
  socket.emit({ type: 'status', state: 'speaking' }); socket.emit(new Int16Array([100]).buffer); expect(sounds).toHaveLength(1);
  socket.emit({ type: 'status', state: 'paused' }); await vi.advanceTimersByTimeAsync(1100);
  expect(session.state).toBe('your-turn'); expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resume' }));
});
it('Start work transfers the same Focus session to the new authorized thread', async () => {
  const s = store(); await start(s, { startWork: true }); const session = owned.session; session.setFocus(true);
  sockets[0].emit({ type: 'status', state: 'sending' }); await vi.advanceTimersByTimeAsync(3000);
  expect(s.submitStartWork).toHaveBeenCalledOnce(); expect(s.nextOpen).toHaveBeenCalledWith('new-thread');
  expect(s.state.voiceFocusItem).toBe('new-thread'); expect(sockets[1].url.searchParams.get('watch')).toBe('1');
  expect(owned.session).toBe(session);
});
it('dictation writes its callback without sending a reply', async () => {
  const s = store(), onTranscript = vi.fn(); await start(s, { dictation: { id: 'answer', value: 'Base', onTranscript } });
  sockets[0].emit({ type: 'transcript_final', text: 'answer' }); expect(onTranscript).toHaveBeenCalledWith('Base answer');
  sockets[0].emit({ type: 'status', state: 'sending' }); await vi.advanceTimersByTimeAsync(3000);
  expect(s.sendReply).not.toHaveBeenCalled();
});
