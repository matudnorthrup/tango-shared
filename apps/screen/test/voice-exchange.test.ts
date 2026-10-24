import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSessionClient } from '@tango/tango-voice/live/gpt-live-client';
import { VoiceExchange, pickThreadVoice, voiceSnapshot } from '../server/desk/voice-exchange.js';
class Fake extends EventEmitter {
  sessionId = 'fake'; expiresAt = null; isOpen = true;
  start = vi.fn(async () => {}); appendAudio = vi.fn();
  appendContext = vi.fn(async () => ({ clientEventId: 'ack' }));
  close = vi.fn(async () => { this.isOpen = false; });
}
function setup(manualFinish = false, capture?: (text: string, failed: boolean) => void) {
  const clients: Fake[] = [];
  let snapshot = { working: false, replyId: 'old', text: 'Previous reply' };
  const json = vi.fn(), audio = vi.fn(), log = vi.fn(), disconnect = vi.fn();
  const exchange = new VoiceExchange({ capture, manualFinish, voice: 'breeze', create: () => { const c = new Fake(); clients.push(c); return c as unknown as LiveSessionClient; }, snapshot: () => snapshot, json, audio, log, disconnect });
  return { exchange, clients, json, audio, log, disconnect, snapshot: (s: typeof snapshot) => { snapshot = s; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('voice palette', () => {
  it('is stable, excludes operator, and honors valid profile overrides', () => {
    for (const operator of ['cove', 'breeze', 'ember']) for (let i = 0; i < 100; i++) {
      expect(pickThreadVoice(String(i), operator)).not.toBe(operator);
      expect(pickThreadVoice(String(i), operator)).toBe(pickThreadVoice(String(i), operator));
    }
    expect(pickThreadVoice('a', 'cove', 'breeze')).toBe('breeze');
    expect(pickThreadVoice('a', 'cove', 'cove')).not.toBe('cove');
    expect(pickThreadVoice('a', 'cove', 'unknown')).not.toBe('unknown');
  });
});
it('forwards input only while listening; suppresses model answers until a new completed reply', async () => {
  const s = setup(); await s.exchange.start(); const c = s.clients[0]!;
  const pcm = Buffer.alloc(4800, 30);
  s.exchange.input(pcm); expect(c.appendAudio).toHaveBeenCalledOnce();
  c.emit('audio', pcm); expect(s.audio).not.toHaveBeenCalled();
  c.emit('inputTranscript', { delta: 'Hello' }); expect(s.json).toHaveBeenCalledWith({ type: 'transcript', delta: 'Hello' });
  c.emit('delegation', { id: 'turn' }); expect(s.exchange.state).toBe('sending');
  expect(s.json).not.toHaveBeenCalledWith({ type: 'status', state: 'speech_end' });
  s.exchange.arm(); s.exchange.input(pcm); expect(c.appendAudio).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500); expect(c.appendContext).not.toHaveBeenCalled();
  s.snapshot({ working: true, replyId: 'new', text: 'Still working' });
  await vi.advanceTimersByTimeAsync(500); expect(c.appendContext).not.toHaveBeenCalled();
  s.snapshot({ working: false, replyId: 'new', text: 'Finished' });
  await vi.advanceTimersByTimeAsync(250); expect(s.exchange.state).toBe('speaking');
  expect(c.appendContext).toHaveBeenCalledWith('commentary', expect.stringContaining('Finished'), 'turn');
  c.emit('audio', pcm); expect(s.audio).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2500); expect(s.exchange.state).toBe('paused');
  expect(s.disconnect).not.toHaveBeenCalled();
  s.exchange.input(pcm); expect(c.appendAudio).toHaveBeenCalledOnce();
  s.exchange.resume(); expect(s.exchange.state).toBe('listening');
  s.exchange.input(pcm); expect(c.appendAudio).toHaveBeenCalledTimes(2);
  s.exchange.end('test');
});
it('closes at ten minutes and reopens without microphone when the reply lands', async () => {
  const s = setup(); await s.exchange.start(); s.exchange.finishInput(); s.exchange.arm();
  await vi.advanceTimersByTimeAsync(600_000); expect(s.clients[0]!.close).toHaveBeenCalledOnce();
  expect(s.exchange.state).toBe('waiting');
  s.snapshot({ working: false, replyId: 'new', text: 'Long task finished' });
  await vi.advanceTimersByTimeAsync(250); expect(s.clients).toHaveLength(2);
  expect(s.clients[1]!.appendAudio).not.toHaveBeenCalled();
  expect(s.clients[1]!.appendContext).toHaveBeenCalledOnce(); s.exchange.end('test');
});
it.each(['connecting', 'listening', 'sending', 'waiting', 'speaking'] as const)('cancels from %s without speaking later', async state => {
  const s = setup(); if (state !== 'connecting') await s.exchange.start();
  s.exchange.state = state; s.exchange.end('cancel');
  await vi.advanceTimersByTimeAsync(1_300_000);
  expect(s.disconnect).toHaveBeenCalledOnce(); expect(s.exchange.state).toBe('ended'); expect(s.audio).not.toHaveBeenCalled();
});
it('hard caps at twenty minutes', async () => { const s = setup(); await s.exchange.start(); await vi.advanceTimersByTimeAsync(1_200_000); expect(s.exchange.state).toBe('ended'); });
it('closes a client whose connection completes after cancellation', async () => {
  const s = setup(); const started = s.exchange.start(); s.exchange.end('cancel'); await started;
  expect(s.exchange.state).toBe('ended'); expect(s.clients[0]!.close).toHaveBeenCalled();
});

it('waits through a needs pill and new agent message until the live turn ends', async () => {
  const s = setup();
  await s.exchange.start();
  s.exchange.finishInput(); s.exchange.arm();
  const detail = {
    item: { nextStep: 'your_move', status: { pill: 'needs', stillWorking: true } },
    reply: { messageIds: ['question'], text: 'A mid-turn question' },
  };
  s.snapshot(voiceSnapshot(detail));
  await vi.advanceTimersByTimeAsync(500);
  const c = s.clients[0]!;
  c.emit('audio', Buffer.alloc(4800, 30));
  expect(s.exchange.state).toBe('waiting');
  expect(c.appendContext).not.toHaveBeenCalled();
  expect(s.audio).not.toHaveBeenCalled();
  expect(s.disconnect).not.toHaveBeenCalled();

  detail.reply = { messageIds: ['final'], text: 'The completed answer' };
  s.snapshot(voiceSnapshot(detail));
  await vi.advanceTimersByTimeAsync(250);
  expect(c.appendContext).not.toHaveBeenCalled();
  detail.item.status.stillWorking = false;
  s.snapshot(voiceSnapshot(detail));
  await vi.advanceTimersByTimeAsync(250);
  expect(s.exchange.state).toBe('speaking');
  expect(c.appendContext).toHaveBeenCalledExactlyOnceWith('commentary', expect.stringContaining('The completed answer'), null);
  c.emit('audio', Buffer.alloc(4800, 30));
  expect(s.audio).toHaveBeenCalledOnce();
  s.exchange.end('test');
});

it('watches a new thread from its first reply, including one already completed', async () => {
 const s = setup(); s.snapshot({ working: false, replyId: 'first', text: 'Already finished' });
 await s.exchange.start(true); expect(s.exchange.state).toBe('waiting');
 await vi.advanceTimersByTimeAsync(250); expect(s.exchange.state).toBe('speaking');
 expect(s.clients[0]!.appendContext).toHaveBeenCalledWith('commentary', expect.stringContaining('Already finished'), null);
 s.exchange.end('test');
});

it('new-thread watching stays silent until its first turn finishes', async () => {
  const s = setup(); s.snapshot({ working: true, replyId: '', text: '' });
  await s.exchange.start(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.exchange.state).toBe('waiting');
  s.snapshot({ working: true, replyId: 'first', text: 'Still working' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.exchange.state).toBe('waiting');
  expect(s.clients[0]!.appendContext).not.toHaveBeenCalled();
  s.snapshot({ working: false, replyId: 'first', text: 'Finished' });
  await vi.advanceTimersByTimeAsync(250);
  expect(s.exchange.state).toBe('speaking');
  s.exchange.end('test');
});

it('manual-finish dictation keeps capturing across model delegation until explicit release', async () => {
  const s = setup(true); await s.exchange.start(); const c = s.clients[0]!;
  c.emit('inputTranscript', { delta: 'Initial words' });
  c.emit('delegation', { id: 'pause' });
  expect(s.json).toHaveBeenCalledWith({ type: 'status', state: 'speech_end' });
  expect(s.exchange.state).toBe('listening');
  s.exchange.input(Buffer.alloc(4800)); expect(c.appendAudio).toHaveBeenCalledOnce();
  c.emit('inputTranscript', { delta: 'continued words' });
  expect(s.json).toHaveBeenCalledWith({ type: 'transcript', delta: 'continued words' });
  s.exchange.finishInput(); expect(s.exchange.state).toBe('sending');
  s.exchange.input(Buffer.alloc(4800)); expect(c.appendAudio).toHaveBeenCalledOnce();
  c.emit('inputTranscript', { delta: ' late words' });
  expect(s.json).toHaveBeenCalledWith({ type: 'transcript', delta: ' late words' });
  s.exchange.end('test');
});

it('keeps a warm socket without a model or audio until explicit start', async () => {
  const s = setup(true); s.exchange.warm();
  expect(s.exchange.state).toBe('armed');
  s.exchange.input(Buffer.alloc(4800)); s.exchange.finishInput();
  await vi.advanceTimersByTimeAsync(21 * 60_000);
  expect(s.clients).toHaveLength(0); expect(s.disconnect).not.toHaveBeenCalled();
  await Promise.all([s.exchange.start(), s.exchange.start()]);
  expect(s.clients).toHaveLength(1); expect(s.exchange.state).toBe('listening');
  s.exchange.input(Buffer.alloc(4800)); expect(s.clients[0]!.appendAudio).toHaveBeenCalledOnce();
  s.exchange.end('cancel'); expect(s.clients[0]!.close).toHaveBeenCalledOnce();
});
it('bounds unused warm sockets and never opens a model after close', async () => {
  const s = setup(true); s.exchange.warm();
  await vi.advanceTimersByTimeAsync(35 * 60_000);
  expect(s.disconnect).toHaveBeenCalledOnce();
  await s.exchange.start(); expect(s.clients).toHaveLength(0);
});

describe('local pause endpointing', () => {
  // A breath of room quiet, then a tone: the detector learns its floor from the first audio.
  const speech = (ms: number) => { const quiet = 4800, n = ms * 24, pcm = Buffer.alloc(quiet + n * 2); for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 19)), quiet + i * 2); return pcm; };
  const say = (s: ReturnType<typeof setup>, pcm: Buffer) => { for (let i = 0; i < pcm.length; i += 4800) s.exchange.input(pcm.subarray(i, i + 4800)); };
  it('ends the turn on a pause after words, without the model', async () => {
    const s = setup(); await s.exchange.start(); const c = s.clients[0]!;
    say(s, speech(1000)); c.emit('inputTranscript', { delta: 'Log my carry session' });
    say(s, Buffer.alloc(48000)); expect(s.exchange.state).toBe('listening');
    say(s, Buffer.alloc(28800)); expect(s.exchange.state).toBe('sending');
    expect(s.log).toHaveBeenCalledWith('input_end', { by: 'pause', mode: 'quick', rule: 'pause' });
    s.exchange.end('test');
  });
  it('waits for words that arrive after the pause', async () => {
    const s = setup(); await s.exchange.start(); const c = s.clients[0]!;
    say(s, speech(1000)); say(s, Buffer.alloc(76800));
    expect(s.exchange.state).toBe('listening');
    c.emit('inputTranscript', { delta: ' ' }); expect(s.exchange.state).toBe('listening');
    c.emit('inputTranscript', { delta: 'Hello' }); expect(s.exchange.state).toBe('listening');
    say(s, Buffer.alloc(28800)); expect(s.exchange.state).toBe('sending');
    s.exchange.end('test');
  });
  it('leaves a manual-finish client to its own detector', async () => {
    const s = setup(true); await s.exchange.start(); const c = s.clients[0]!;
    say(s, speech(1000)); c.emit('inputTranscript', { delta: 'Hello' }); say(s, Buffer.alloc(96000));
    expect(s.exchange.state).toBe('listening'); s.exchange.end('test');
  });
  it('starts fresh for the next Focus turn', async () => {
    const s = setup(); await s.exchange.start(); const c = s.clients[0]!;
    say(s, speech(1000)); c.emit('inputTranscript', { delta: 'First' }); say(s, Buffer.alloc(192000));
    expect(s.exchange.state).toBe('sending');
    s.exchange.state = 'paused'; s.exchange.resume();
    say(s, Buffer.alloc(96000)); expect(s.exchange.state).toBe('listening');
    say(s, speech(1000)); say(s, Buffer.alloc(96000)); expect(s.exchange.state).toBe('listening');
    c.emit('inputTranscript', { delta: 'Second' }); say(s, Buffer.alloc(96000)); expect(s.exchange.state).toBe('sending');
    s.exchange.end('test');
  });
});

// Exercise the policy through the same transport as browser and native dictation.
describe('shared turn taking', () => {
  const audio = (s: ReturnType<typeof setup>, ms: number, loud = false) => {
    const pcm = Buffer.alloc(960);
    if (loud) for (let i = 0; i < 480; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 19)), i * 2);
    for (let i = 0; i < ms; i += 20) s.exchange.input(pcm);
  };
  const words = (s: ReturnType<typeof setup>, text: string) => {
    audio(s, 100); audio(s, 200, true); s.clients[0]!.emit('inputTranscript', { delta: text });
  };
  it('waits to four seconds for an unfinished end', async () => {
    const s = setup(); await s.exchange.start(); words(s, 'Change the title and');
    audio(s, 1500); expect(s.exchange.state).toBe('listening');
    expect(s.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'waiting', untilMs: 4000 }));
    audio(s, 2480); expect(s.exchange.state).toBe('listening');
    audio(s, 20); expect(s.exchange.state).toBe('sending');
    expect(s.log).toHaveBeenCalledWith('input_end', { by: 'pause', mode: 'quick', rule: 'unfinished-wait' }); s.exchange.end('test');
  });
  it('holds through ten seconds and model delegation, strips the preamble and closer', async () => {
    const s = setup(); await s.exchange.start(); words(s, "Hey, I'm gonna ramble for a minute.");
    audio(s, 10000); s.clients[0]!.emit('delegation', { id: 'ramble' });
    expect(s.exchange.state).toBe('listening');
    expect(s.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'holding' }));
    words(s, 'Use the blue one.'); audio(s, 1500); words(s, 'Okay send it'); audio(s, 1500);
    expect(s.json).toHaveBeenCalledWith({ type: 'transcript_final', text: 'Use the blue one.' });
    expect(s.log).toHaveBeenCalledWith('input_end', { by: 'pause', mode: 'ramble', rule: 'closer' }); s.exchange.end('test');
  });
  it('hears a closer whose words arrive in pieces after the pause', async () => {
    const s = setup(); await s.exchange.start(); words(s, "Hey, I'm gonna ramble for a minute."); audio(s, 1500);
    words(s, 'Use the blue one.'); audio(s, 1500);
    audio(s, 200, true); audio(s, 1600);
    for (const delta of ['Okay', ' send', ' it']) s.clients[0]!.emit('inputTranscript', { delta });
    audio(s, 600);
    expect(s.json).toHaveBeenCalledWith({ type: 'transcript_final', text: 'Use the blue one.' });
    expect(s.log).toHaveBeenCalledWith('input_end', { by: 'pause', mode: 'ramble', rule: 'closer' }); s.exchange.end('test');
  });
  it('keeps the word boundary when words keep arriving after the hand-off', async () => {
    const s = setup(); await s.exchange.start();
    words(s, 'Use '); audio(s, 1500);
    expect(s.exchange.state).toBe('sending');
    s.clients[0]!.emit('inputTranscript', { delta: 'blue.' });
    const finals = s.json.mock.calls.filter(([v]) => v.type === 'transcript_final');
    expect(finals.at(-1)?.[0]).toEqual({ type: 'transcript_final', text: 'Use blue.' }); s.exchange.end('test');
  });
  it('nudges once at ninety seconds and a tap finishes a ramble', async () => {
    const s = setup(); await s.exchange.start(); words(s, 'Let me get this all out.'); audio(s, 1500);
    words(s, 'Use blue.'); audio(s, 91000);
    expect(s.json.mock.calls.filter(([v]) => v.state === 'holding_nudge')).toHaveLength(1);
    s.exchange.finishInput(); expect(s.json).toHaveBeenCalledWith({ type: 'transcript_final', text: 'Use blue.' }); s.exchange.end('test');
  });
  it('lets late words drain before a cancel-shaped start ends the turn', async () => {
    const s = setup(); await s.exchange.start(); audio(s, 100); audio(s, 200, true); audio(s, 1600);
    s.clients[0]!.emit('inputTranscript', { delta: 'Cancel' });
    s.clients[0]!.emit('inputTranscript', { delta: ' the meeting tomorrow.' });
    expect(s.exchange.state).toBe('listening'); audio(s, 600);
    expect(s.exchange.state).toBe('sending');
    expect(s.json).toHaveBeenCalledWith({ type: 'transcript_final', text: 'Cancel the meeting tomorrow.' }); s.exchange.end('test');
  });
  it('cancels on the whole last segment without sending', async () => {
    const s = setup(); await s.exchange.start(); words(s, 'Never mind'); audio(s, 1500);
    expect(s.exchange.state).toBe('ended'); expect(s.json).toHaveBeenCalledWith({ type: 'cancel' });
    expect(s.log.mock.calls.some(([kind]) => kind === 'input_end')).toBe(false);
  });
  it.each([
    ['Use blue.', 'speech_end', undefined],
    ['Use blue and', 'waiting', 4000],
    ["I'm gonna talk for a while.", 'holding', undefined],
  ])('answers native pause for %s', async (text, state, untilMs) => {
    const s = setup(true); await s.exchange.start(); words(s, text!); s.exchange.requestPause(1500);
    expect(s.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', state, ...(untilMs ? { untilMs } : {}) }));
    expect(s.exchange.state).toBe('listening'); s.exchange.end('test');
  });
  it('echoes the native pause request id so a stale answer can be dropped', async () => {
    const s = setup(true); await s.exchange.start(); words(s, 'Use blue.'); s.exchange.requestPause(1500, 'req-1');
    expect(s.json).toHaveBeenCalledWith({ type: 'status', state: 'speech_end', id: 'req-1' });
    s.exchange.end('test');
  });
});

it('private recovery waits for terminal close and includes late transcript deltas once', async () => {
  const capture = vi.fn(); const s = setup(true, capture); await s.exchange.start();
  s.clients[0]!.emit('inputTranscript', { delta: 'Some words ' }); s.exchange.finishInput();
  expect(capture).not.toHaveBeenCalled();
  s.clients[0]!.emit('inputTranscript', { delta: 'and more' });
  s.exchange.end('browser disconnected'); s.exchange.end('socket error');
  expect(capture).toHaveBeenCalledExactlyOnceWith('Some words and more', false, 1, false);
  expect(JSON.stringify(s.log.mock.calls)).not.toContain('Some words');
});
it('recovers partial words on failure but excludes intentional cancel and empty capture', async () => {
  const capture = vi.fn(); const s = setup(true, capture); await s.exchange.start();
  s.clients[0]!.emit('inputTranscript', { delta: 'Partial words' }); s.exchange.fail('Voice connection failed.');
  expect(capture).toHaveBeenCalledExactlyOnceWith('Partial words', true, 1, false);
  const canceled = setup(false, capture); await canceled.exchange.start();
  canceled.clients[0]!.emit('inputTranscript', { delta: 'Cancel' }); canceled.exchange.end('cancel');
  expect(capture).toHaveBeenCalledTimes(1);
});

it('captures each conversation send once, after delivery, with a fresh Focus turn', async () => {
  const capture = vi.fn(); const s = setup(false, capture); await s.exchange.start();
  const client = s.clients[0]!;
  client.emit('inputTranscript', { delta: 'First ' }); s.exchange.finishInput();
  client.emit('inputTranscript', { delta: 'reply' }); s.exchange.arm();
  expect(capture).not.toHaveBeenCalled();
  s.exchange.delivered(true); s.exchange.delivered(true);
  expect(capture).toHaveBeenCalledExactlyOnceWith('First reply', false, 1, true);
  s.exchange.state = 'paused'; s.exchange.resume();
  client.emit('inputTranscript', { delta: 'Second reply' }); s.exchange.finishInput();
  s.exchange.delivered(false); s.exchange.end('browser stopped');
  expect(capture.mock.calls).toEqual([['First reply', false, 1, true], ['Second reply', true, 2, false]]);
  expect(JSON.stringify(s.log.mock.calls)).not.toContain('reply');
});

it('retains unacknowledged Focus turns before resume without claiming delivery', async () => {
  const capture = vi.fn(); const s = setup(false, capture); await s.exchange.start();
  s.clients[0]!.emit('inputTranscript', { delta: 'Older browser reply' }); s.exchange.finishInput(); s.exchange.arm();
  s.exchange.state = 'paused'; s.exchange.resume();
  expect(capture).toHaveBeenCalledExactlyOnceWith('Older browser reply', false, 1, false);
  s.exchange.end('cancel');
});

it.each([undefined, false, true])('voice failure after handoff preserves delivery evidence (%s)', async ack => {
  const capture = vi.fn(); const s = setup(false, capture); await s.exchange.start();
  s.clients[0]!.emit('inputTranscript', { delta: 'Submitted reply' });
  s.exchange.finishInput(); s.exchange.arm();
  if (ack !== undefined) s.exchange.delivered(ack);
  s.exchange.fail('Voice connection failed.');
  expect(capture).toHaveBeenCalledExactlyOnceWith('Submitted reply', ack === false, 1, ack === true);
});
