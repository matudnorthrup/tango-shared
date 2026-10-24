import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { VoiceSession, sendVoiceReply } from '../public/desk/voice-session.js';

it.each([
  [{ status: 'sent' }, true],
  [{ status: 'failed' }, false],
  [{ status: 'failed', transport: true }, undefined],
  [{ status: 'failed', outcome: { delivery: 'unknown' } }, undefined],
  [undefined, undefined],
])('acknowledges only a confirmed voice reply outcome: %j', async (result, expected) => {
  const delivered = vi.fn();
  const store = { sendReply: vi.fn().mockResolvedValue(result) };
  expect(await sendVoiceReply(store, 'thread', true, delivered)).toBe(result);
  if (expected === undefined) expect(delivered).not.toHaveBeenCalled();
  else expect(delivered).toHaveBeenCalledExactlyOnceWith(expected);
});
function setup() {
  const opts = { change: vi.fn(), send: vi.fn(async () => ({ status: 'sent' })), arm: vi.fn(), stop: vi.fn(), finish: vi.fn() };
  return { session: new VoiceSession(opts), ...opts };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
it('in Focus waits three seconds, arms before sending, then speaks and ends', async () => {
  const s = setup(); s.session.start(); s.session.ready(); s.session.setFocus(true); s.session.inputEnd();
  await vi.advanceTimersByTimeAsync(2999); expect(s.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(s.send).toHaveBeenCalledOnce(); expect(s.session.state).toBe('waiting');
  expect(s.arm.mock.invocationCallOrder[0]).toBeLessThan(s.send.mock.invocationCallOrder[0]!);
  s.session.speaking(); expect(s.session.state).toBe('speaking'); s.session.cancel(); expect(s.session.state).toBe('idle');
});
it.each(['connecting', 'listening', 'sending', 'waiting', 'speaking', 'error'])('page hidden cancels %s', async state => {
  const s = setup(); s.session.start(); s.session.ready(); s.session.inputEnd(); s.session.state = state;
  s.session.hidden(); await vi.advanceTimersByTimeAsync(4000); expect(s.send).not.toHaveBeenCalled(); expect(s.stop).toHaveBeenCalledOnce(); expect(s.session.state).toBe('idle');
});
it('editing cancels the undo send; tapping while listening asks to finish', async () => {
  const s = setup(); s.session.start(); s.session.ready(); s.session.tap(); expect(s.finish).toHaveBeenCalledOnce();
  s.session.inputEnd(); s.session.edit(); await vi.advanceTimersByTimeAsync(4000); expect(s.send).not.toHaveBeenCalled();
});
it('a failed send ends the exchange', async () => { const s = setup(); s.send.mockResolvedValue({ status: 'failed' }); s.session.start(); s.session.ready(); s.session.inputEnd(); await vi.advanceTimersByTimeAsync(3000); expect(s.session.state).toBe('error'); });

it('does not resurrect an error after cancellation while a send is pending', async () => {
  const s = setup(); let reject!: (error: Error) => void;
  s.send.mockImplementation(() => new Promise((_, no) => { reject = no; }));
  s.session.start(); s.session.ready(); s.session.inputEnd();
  await vi.advanceTimersByTimeAsync(3000); s.session.cancel(); reject(new Error('late failure'));
  await Promise.resolve(); expect(s.session.state).toBe('idle');
});

it('dictates with no playback and closes immediately after the ordinary send', async () => {
  const s = setup(); s.session.start(); s.session.ready(); s.session.inputEnd();
  await vi.advanceTimersByTimeAsync(3000);
  expect(s.arm).not.toHaveBeenCalled(); expect(s.send).toHaveBeenCalledWith(false);
  expect(s.session.state).toBe('idle'); expect(s.stop).toHaveBeenCalledOnce();
});
it('can toggle Focus during dictation; closes it on toggle off', async () => {
  const s = setup(); s.session.start(); s.session.ready(); s.session.setFocus(true); s.session.inputEnd();
  await vi.advanceTimersByTimeAsync(3000); expect(s.send).toHaveBeenCalledWith(true);
  expect(s.session.state).toBe('waiting'); s.session.setFocus(false);
  expect(s.session.state).toBe('idle'); expect(s.session.focus).toBe(false);
});
it('reopens only after playback and ends after 30 seconds without words', async () => {
  const reopen = vi.fn(async () => {}); const s = setup(); s.session.reopen = reopen;
  s.session.start(); s.session.ready(); s.session.setFocus(true); s.session.inputEnd();
  await vi.advanceTimersByTimeAsync(3000); expect(reopen).not.toHaveBeenCalled();
  s.session.speaking(); expect(reopen).not.toHaveBeenCalled(); await s.session.spoken();
  expect(reopen).toHaveBeenCalledOnce(); expect(s.session.state).toBe('your-turn');
  await vi.advanceTimersByTimeAsync(29999); expect(s.session.state).toBe('your-turn');
  await vi.advanceTimersByTimeAsync(1); expect(s.session.state).toBe('idle'); expect(s.session.focus).toBe(false);
});
it('words cancel the post-reply idle timeout and allow another turn', async () => {
  const s = setup(); s.session.reopen = async () => {}; s.session.focus = true; s.session.state = 'speaking';
  await s.session.spoken(); s.session.activity(); await vi.advanceTimersByTimeAsync(31000);
  expect(s.session.state).toBe('your-turn'); s.session.inputEnd(); await vi.advanceTimersByTimeAsync(3000);
  expect(s.send).toHaveBeenCalledWith(true); expect(s.session.state).toBe('waiting');
});
it('cancellation during mic reopening cannot restart listening', async () => {
  const s = setup(); let resolve!: () => void;
  s.session.reopen = () => new Promise<void>(r => { resolve = r; }); s.session.focus = true; s.session.state = 'speaking';
  const done = s.session.spoken(); s.session.cancel(); resolve(); await done;
  expect(s.session.state).toBe('idle'); expect(s.session.idleTimer).toBe(null);
});

it('uses the ordinary reply path with remembered send preference unless Focus is on', async () => {
 const store = { sendReply: vi.fn() };
 await sendVoiceReply(store, 'thread', false); expect(store.sendReply).toHaveBeenLastCalledWith('thread', undefined, {});
 await sendVoiceReply(store, 'thread', true); expect(store.sendReply).toHaveBeenLastCalledWith('thread', undefined, { stay: true });
});

it('cannot enable Focus after an ordinary send has dispatched', async () => {
  const s = setup(); let resolve!: (value: { status: string }) => void;
  s.send.mockImplementation(() => new Promise(r => { resolve = r; }));
  s.session.start(); s.session.ready(); s.session.inputEnd();
  await vi.advanceTimersByTimeAsync(3000);
  s.session.setFocus(true);
  expect(s.session.focus).toBe(false); expect(s.arm).not.toHaveBeenCalled();
  resolve({ status: 'sent' }); await Promise.resolve();
  expect(s.session.state).toBe('idle'); expect(s.stop).toHaveBeenCalledOnce();
});


it('Other-answer dictation closes without a send timer, send, arm, Focus or playback', async () => {
  const send = vi.fn(), arm = vi.fn(), reopen = vi.fn(), stop = vi.fn(), change = vi.fn();
  const session = new VoiceSession({ dictationOnly: true, send, arm, reopen, stop, change, finish: vi.fn() });
  session.start(); session.ready(); session.setFocus(true);
  expect(session.focus).toBe(false);
  session.inputEnd();
  expect(session.state).toBe('finishing'); expect(session.timer).toBe(null);
  await vi.advanceTimersByTimeAsync(1499); expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(session.state).toBe('idle'); expect(stop).toHaveBeenCalledOnce();
  session.speaking(); await session.spoken();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).not.toHaveBeenCalled(); expect(arm).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled();
  expect(change.mock.calls.map(([state]) => state)).toEqual(['connecting', 'listening', 'finishing', 'idle']);
});


it('editing while final transcript deltas drain cancels immediately', async () => {
  const stop = vi.fn();
  const session = new VoiceSession({ dictationOnly: true, change: vi.fn(), stop });
  session.start(); session.ready(); session.inputEnd(); session.edit();
  expect(session.state).toBe('idle'); expect(session.drainTimer).toBe(null);
  await vi.advanceTimersByTimeAsync(2000); expect(stop).toHaveBeenCalledOnce();
});

it('holding keeps capturing, Keep dismisses the nudge, and Send is an explicit finish', async () => {
  const s = setup(); s.session.start(); s.session.ready(); s.session.holding();
  await vi.advanceTimersByTimeAsync(60000); expect(s.send).not.toHaveBeenCalled();
  s.session.holding(true); s.session.keep(); expect(s.session.state).toBe('holding');
  s.session.tap(); expect(s.finish).toHaveBeenCalledOnce();
  s.session.inputEnd(); await vi.advanceTimersByTimeAsync(3000); expect(s.send).toHaveBeenCalledOnce();
});
