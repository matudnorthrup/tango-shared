import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { navigatorContext, resolveNavigator } from '../server/desk/navigator-resolver.js';
import { NavigatorExchange } from '../server/desk/navigator-exchange.js';
// @ts-expect-error browser module
import { NavigatorSession } from '../public/desk/navigator-session.js';
// @ts-expect-error browser module
import { validNavigatorAction } from '../public/desk/navigator-actions.js';
// @ts-expect-error browser module
import { claimVoice, releaseVoice } from '../public/desk/voice-owner.js';
const context = { place: 'Inbox', choices: [
  { action: { op: 'open', target: 'thread:one' }, label: 'Voice Mode · visible position 1', confirmation: 'Opened Voice Mode.' },
  { action: { op: 'open', target: 'thread:two' }, label: 'Voice fixes · visible position 2', confirmation: 'Opened Voice fixes.' },
  { action: { op: 'tab', target: 'watching' }, label: 'Watching tab', confirmation: 'Opened Watching.' },
] };
it.each([['open Voice Mode', 0], ['open the second one', 1], ['go to Watching', 2]])('resolves %s from catalog without trusting model payloads', async (text, index) => {
  const call = vi.fn(async () => JSON.stringify({ status: 'action', index, action: { op: 'approve' } }));
  expect((await resolveNavigator(text, context, call)).action).toEqual(context.choices[index].action);
  expect(call.mock.calls[0][0].input[0].text).toContain(text);
});
it('shows only open candidates on ambiguity and refuses without an action', async () => {
  expect(await resolveNavigator('open voice', context, async () => '{"status":"ambiguous","candidates":[0,1,2,99]}')).toMatchObject({ action: null, candidates: context.choices.slice(0, 2) });
  for (const text of ['approve it', 'reply yes', 'stop it', 'rename it', 'open it and approve']) expect(await resolveNavigator(text, context, async () => '{"status":"refused"}')).toMatchObject({ action: null, confirmation: "That one's a tap." });
});
it('rejects malformed context, invented indexes, extra arguments and unsafe commands', async () => {
  for (const op of ['approve', 'reply', 'stop', 'retry', 'rename', 'project', 'run']) expect(validNavigatorAction({ op, target: 'one' })).toBe(false);
  expect(validNavigatorAction({ op: 'done', target: 'one', stopJob: true })).toBe(false);
  expect(validNavigatorAction({ op: 'snooze', target: 'one', when: 'never' })).toBe(false);
  expect(() => navigatorContext({ ...context, choices: [{ action: { op: 'reply' } }] })).toThrow();
  for (const raw of ['garbage', '{"status":"action","index":99}', '{"status":"action","index":0.5}']) expect((await resolveNavigator('open voice', context, async () => raw)).action).toBeNull();
});
it('browser session executes once, closes mic, and ignores late acknowledgements after cancellation', async () => {
  let finish!: (value: boolean) => void;
  const e = { change: vi.fn(), closeMic: vi.fn(), stop: vi.fn(), acknowledge: vi.fn(), execute: vi.fn(() => new Promise<boolean>(r => finish = r)) };
  const s = new NavigatorSession(e); s.start(); s.ready(); s.resolving();
  const pending = s.action({}); void s.action({}); s.tap(); finish(true); await pending;
  expect(e.execute).toHaveBeenCalledTimes(1); expect(e.closeMic).toHaveBeenCalledOnce(); expect(e.acknowledge).not.toHaveBeenCalled(); expect(e.stop).toHaveBeenCalledOnce();
});
it.each(['connecting', 'listening', 'resolving', 'executing', 'confirming'])('cancels at %s', state => {
  const stop = vi.fn(); const s = new NavigatorSession({ change: vi.fn(), stop }); s.state = state; s.hidden(); s.cancel(); expect(s.state).toBe('idle'); expect(stop).toHaveBeenCalledOnce();
});
it('reply and navigator sessions replace one another without a stale release', () => {
  const a = { cancel: vi.fn() }, b = { cancel: vi.fn() }, c = { cancel: vi.fn() };
  claimVoice(a); claimVoice(b); releaseVoice(a); claimVoice(c); releaseVoice(c);
  expect(a.cancel).toHaveBeenCalledOnce(); expect(b.cancel).toHaveBeenCalledOnce();
});
class Fake extends EventEmitter {
  start = vi.fn(async () => {}); close = vi.fn(async () => {}); appendAudio = vi.fn(); appendContext = vi.fn(async () => ({}));
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
it('server mutes spontaneous audio, executes once, then speaks only after browser ack and closes', async () => {
  const client = new Fake(), json = vi.fn(), audio = vi.fn(), resolve = vi.fn(async () => ({ action: context.choices[0].action, confirmation: 'Opened Voice Mode.', candidates: [] }));
  const exchange = new NavigatorExchange({ create: () => client as never, voice: 'cove', resolve, json, audio, log: vi.fn(), disconnect: vi.fn() });
  exchange.setContext(context); await exchange.start(); const pcm = Buffer.alloc(4800); pcm.writeInt16LE(2000);
  client.emit('audio', pcm); expect(audio).not.toHaveBeenCalled();
  client.emit('inputTranscript', { delta: 'open Voice Mode' }); client.emit('delegation', { id: 'd1' }); client.emit('delegation', { id: 'd2' });
  await vi.advanceTimersByTimeAsync(1); expect(resolve).toHaveBeenCalledOnce(); expect(exchange.state).toBe('executing');
  client.emit('audio', pcm); expect(audio).not.toHaveBeenCalled();
  await exchange.acknowledge(true); expect(client.appendContext).toHaveBeenCalledWith('commentary', expect.stringContaining('Opened Voice Mode.'), 'd1');
  client.emit('audio', pcm); expect(audio).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2200); expect(exchange.state).toBe('ended');
});
it('a cancelled server resolution cannot execute later', async () => {
  const client = new Fake(), json = vi.fn(); let finish!: (v: any) => void;
  const e = new NavigatorExchange({ create: () => client as never, voice: 'cove', resolve: () => new Promise(r => finish = r), json, audio: vi.fn(), log: vi.fn(), disconnect: vi.fn() });
  e.setContext(context); await e.start(); client.emit('inputTranscript', { delta: 'open Voice Mode' }); client.emit('delegation', { id: 'd' }); e.end('cancel'); finish({ action: context.choices[0].action }); await vi.advanceTimersByTimeAsync(1);
  expect(json.mock.calls.some(([v]) => v.type === 'action')).toBe(false);
});
// @ts-expect-error browser module
import { createStore } from '../public/desk/store.js';
// @ts-expect-error browser module
import { navigatorContext as browserContext, executeNavigator } from '../public/desk/navigator-context.js';
it('navigator uses the same nextOpen and presentation paths as a tap, without a clock guard', async () => {
 const present = vi.fn(async (p: any) => p), store = createStore({ present });
 store.set({ byId: { one: { id: 'one', conversationKey: 'key', facts: {}, summary: { title: 'Voice Mode' } } }, detail: { id: 'one' } });
 store.nextOpen = vi.fn((id: string) => store.openItem(id));
 const context = browserContext(store);
 expect(await executeNavigator(store, { action: { op: 'open', target: 'one' } }, context)).toBe(true);
 expect(store.nextOpen).toHaveBeenCalledWith('one');
 expect(present).toHaveBeenCalledWith(expect.objectContaining({ view: 'conversation', itemId: 'one' }));
 expect(store.state.presentation.itemId).toBe('one');
 await Promise.resolve();
 // A phone clock ahead of the hub must not hide a later operator move.
 store.handlers.onPresentation({ view: 'active', since: Date.now() - 3600000, by: 'operator' });
 expect(store.state.presentation.view).toBe('active');
});

it('navigator never rambles and still waits for unfinished commands', async () => {
  const client = new Fake(), resolve = vi.fn(async () => ({ action: null, confirmation: 'No action.', candidates: [] }));
  const make = () => new NavigatorExchange({ create: () => client as never, voice: 'cove', resolve, json: vi.fn(), audio: vi.fn(), log: vi.fn(), disconnect: vi.fn() });
  const e = make(); e.setContext(context); await e.start();
  client.emit('inputTranscript', { delta: "I'm gonna ramble for a minute." }); client.emit('delegation', { id: 'd' });
  expect(resolve).toHaveBeenCalledOnce(); e.end('test'); client.removeAllListeners(); resolve.mockClear();
  const next = make(); next.setContext(context); await next.start();
  next.input(Buffer.alloc(4800));
  const speech = Buffer.alloc(9600); for (let i = 0; i < 4800; i++) speech.writeInt16LE(Math.round(8000 * Math.sin(i / 19)), i * 2);
  next.input(speech); client.emit('inputTranscript', { delta: 'Open Voice Mode and' }); client.emit('delegation', { id: 'd2' });
  for (let i = 0; i < 39; i++) next.input(Buffer.alloc(4800));
  expect(resolve).not.toHaveBeenCalled(); next.input(Buffer.alloc(4800)); expect(resolve).toHaveBeenCalledOnce(); next.end('test');
});

it('navigator drains words that arrive after the pause before resolving', async () => {
  const client = new Fake(), resolve = vi.fn(async () => ({ action: null, confirmation: 'No action.', candidates: [] }));
  const speech = Buffer.alloc(9600); for (let i = 0; i < 4800; i++) speech.writeInt16LE(Math.round(8000 * Math.sin(i / 19)), i * 2);
  for (const viaModel of [true, false]) {
    const e = new NavigatorExchange({ create: () => client as never, voice: 'cove', resolve, json: vi.fn(), audio: vi.fn(), log: vi.fn(), disconnect: vi.fn() });
    e.setContext(context); await e.start(); e.input(speech);
    for (let i = 0; i < 16; i++) e.input(Buffer.alloc(4800));
    client.emit('inputTranscript', { delta: 'Open' }); client.emit('inputTranscript', { delta: ' Voice Mode' });
    expect(resolve).not.toHaveBeenCalled();
    if (viaModel) client.emit('delegation', { id: 'd' });
    else for (let i = 0; i < 7; i++) e.input(Buffer.alloc(4800));
    expect(resolve).toHaveBeenCalledOnce(); expect(resolve.mock.calls[0]![0]).toBe('Open Voice Mode');
    e.end('test'); client.removeAllListeners(); resolve.mockClear();
  }
});
