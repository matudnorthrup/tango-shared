import type { DraftCompileResult } from '@tango/tango-voice/live/draft-mode';
import type { DeskRoutesOptions } from '../server/desk/routes.js';
import { Hono } from 'hono';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneNotes, parsePhoneNote, phoneNoteReceipt, type PhoneNoteDeps } from '../server/desk/phone-note.js';
import { makeHarness, type Harness } from './desk-harness.js';
const handles: Harness[] = [];
const services: PhoneNotes[] = [];
afterEach(() => { services.splice(0).forEach(n => n.close()); handles.splice(0).forEach(h => h.close()); vi.useRealTimers(); });
function setup(overrides: Partial<PhoneNoteDeps> = {}) {
  const h = makeHarness(); handles.push(h);
  const compile = vi.fn(async (): Promise<DraftCompileResult> => ({ message: 'Fix the menu', agentId: null, item: null, threadId: null, newThreadTitle: 'Menu', newLoomRepo: 'tango', questions: [] as string[] }));
  const deliver = vi.fn(async () => ({ ok: true, itemId: 'loom:example' }));
  const runtime = async () => ({ compile, context: { input: { agents: [], tasks: [], threads: [], transcript: [], now: Date.now(), startPlace: null, loomRepos: ['tango'] }, resolveItem: () => null } });
  const deps = { core: h.core, runtime, deliver, ...overrides };
  const notes = new PhoneNotes(deps); services.push(notes);
  return { h, compile, deliver, deps, notes };
}
const request = { text: 'In tango, fix the menu', noteId: 'ios-123' };
describe('phone notes', () => {
  it('validates the bounded dictation and id', () => {
    for (const body of [null, [], {}, { ...request, text: '' }, { ...request, text: 'x'.repeat(16001) }, { ...request, noteId: '../bad' }, { ...request, answer: '' }]) expect(parsePhoneNote(body)).toBeNull();
    expect(parsePhoneNote(request)).toEqual(request);
  });
  it('sends once across concurrent retries and service restart', async () => {
    const { notes, deliver, deps } = setup();
    const results = await Promise.all([notes.submit(request), notes.submit(request)]);
    expect(results[0]).toEqual(results[1]); expect(results[0].status).toBe('sent');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await new PhoneNotes(deps).submit(request)).toEqual(results[0]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('holds a guessed repo and keeps multiple drafts as separate items', async () => {
    const { notes, deliver, h } = setup();
    expect((await notes.submit({ ...request, text: 'I have a few thoughts' })).status).toBe('ask');
    await notes.submit({ noteId: request.noteId, answer: 'Not sure' });
    await notes.submit({ text: 'More thoughts', noteId: 'ios-124' });
    await notes.submit({ noteId: 'ios-124', answer: 'Not sure' });
    expect(deliver).not.toHaveBeenCalled();
    expect(h.core.item('phone:ios-123')?.facts.phoneNote?.text).toBe('Fix the menu');
    expect(h.core.item('phone:ios-124')).not.toBeNull();
    expect(h.core.item('phone:ios-123')?.nextStep).toBe('your_move');
  });
  it('asks compiler questions without sending', async () => {
    const { notes, compile, deliver } = setup();
    compile.mockResolvedValueOnce({ message: 'A thought', agentId: null, item: null, threadId: null, newThreadTitle: '', newLoomRepo: null, questions: ["Who's it for?"] });
    expect((await notes.submit(request)).status).toBe('ask'); expect(deliver).not.toHaveBeenCalled();
  });
  it('never reports sent for refused or uncertain delivery', async () => {
    const { notes, deliver, h } = setup(); deliver.mockResolvedValueOnce({ ok: false, itemId: '' });
    expect((await notes.submit(request)).status).toBe('held');
    expect(h.core.item('phone:ios-123')?.facts.phoneNote?.uncertain).toBe(true);
    expect(await notes.sendHeld(request.noteId, 'repo:tango')).toBeNull();
    await notes.submit(request); expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('caps a slow compile and never sends its late result', async () => {
    vi.useFakeTimers(); const { notes, compile, deliver } = setup({ timeoutMs: 100 });
    let finish!: (result: Awaited<ReturnType<typeof compile>>) => void;
    compile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = notes.submit(request); await vi.advanceTimersByTimeAsync(101);
    expect((await pending).status).toBe('held');
    finish({ message: 'Fix it', agentId: null, item: null, threadId: null, newThreadTitle: '', newLoomRepo: 'tango', questions: [] });
    await vi.advanceTimersByTimeAsync(1); expect(deliver).not.toHaveBeenCalled();
  });
  it('records a late delivery success without sending a retry', async () => {
    vi.useFakeTimers(); const { notes, deliver } = setup({ timeoutMs: 100 });
    let finish!: (result: { ok: boolean; itemId: string }) => void;
    deliver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = notes.submit(request); await vi.advanceTimersByTimeAsync(101);
    expect((await pending).status).toBe('held');
    finish({ ok: true, itemId: 'loom:example' }); await vi.advanceTimersByTimeAsync(1);
    expect((await notes.submit(request)).status).toBe('sent'); expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('requires a current explicit destination to send a held draft once', async () => {
    const { notes, deliver } = setup(); await notes.submit({ ...request, text: 'A thought' }); await notes.submit({ noteId: request.noteId, answer: 'Not sure' });
    expect(await notes.sendHeld(request.noteId, 'repo:unknown')).toBeNull();
    const results = await Promise.all([notes.sendHeld(request.noteId, 'repo:tango'), notes.sendHeld(request.noteId, 'repo:tango')]);
    expect(results.filter(r => r?.status === 'sent')).toHaveLength(1); expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('phone note HTTP route', () => {
  it('rejects invalid JSON and reuses the existing home reply path once', async () => {
    const { h, deps, compile } = setup();
    const reply = vi.fn(async (): Promise<{ ok: boolean; notDelivered?: boolean }> => ({ ok: true }));
    const app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], phoneAgentReply: reply, phoneNoteRuntime: async () => {
      const runtime = await deps.runtime();
      runtime.context.input.agents = [{ id: 'sierra', name: 'Sierra', role: 'test agent' }];
      return runtime;
    } });
    compile.mockResolvedValue({ message: 'Check the loop', agentId: 'sierra', item: null, threadId: null, newThreadTitle: '', newLoomRepo: '', questions: [] });
    const post = (body: string) => app.request('/api/desk/voice-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect((await post('{')).status).toBe(400);
    const body = JSON.stringify({ text: 'Sierra, check the loop', noteId: 'http-1' });
    expect(await (await post(body)).json()).toMatchObject({ status: 'sent' });
    expect(await (await post(body)).json()).toMatchObject({ status: 'sent' });
    expect(reply).toHaveBeenCalledExactlyOnceWith('sierra', undefined, 'Check the loop', 'phone-http-1');
    reply.mockResolvedValue({ ok: false, notDelivered: true });
    expect(await (await post(JSON.stringify({ text: 'Sierra, another note', noteId: 'http-2' }))).json()).toMatchObject({ status: 'held' });
    expect(h.core.item('phone:http-2')?.facts.phoneNote?.uncertain).toBe(false);
  });
  it('asks about a role-based agent guess when nobody was named', async () => {
    const { notes, compile, deliver, deps } = setup();
    const base = deps.runtime;
    deps.runtime = async () => { const runtime = await base(); runtime.context.input.agents = [{ id: 'sierra', name: 'Sierra', role: 'travel' }]; return runtime; };
    compile.mockResolvedValue({ message: 'Plan a trip', agentId: 'sierra', item: null, threadId: null, newThreadTitle: '', newLoomRepo: '', questions: [] });
    expect((await notes.submit({ text: 'A trip would be nice', noteId: 'ramble' })).status).toBe('ask');
    expect(deliver).not.toHaveBeenCalled();
  });
});

it.each(['new_loom', 'new_thread', 'item'] as const)('delivers %s through the matching desk path', async kind => {
  const { h, deps, compile } = setup();
  const start = vi.fn(async () => ({ ok: true, itemId: 'new:item' }));
  const command = vi.spyOn(h.core, 'command').mockResolvedValue({ commandId: 'phone-path', status: 'applied' });
  const afterStart = vi.fn();
  const app = new Hono();
  registerDeskRoutes(app, { core: h.core, scenes: () => [],
    startWork: { service: { start } as unknown as NonNullable<DeskRoutesOptions['startWork']>['service'], afterStart },
    agentStart: { service: { start } as unknown as NonNullable<DeskRoutesOptions['agentStart']>['service'], afterStart },
    phoneNoteRuntime: async () => { const runtime = await deps.runtime();
      runtime.context.input.agents = [{ id: 'sierra', name: 'Sierra', role: 'test agent' }];
      runtime.context.resolveItem = handle => handle === 'i1' ? { id: 'loom:existing', agentId: 'coder', agentName: 'Coder', place: 'Menu', threadId: null, isAgent: false } : null;
      return runtime; },
  });
  compile.mockResolvedValue({ message: 'Fix it', agentId: kind === 'new_thread' ? 'sierra' : null, item: kind === 'item' ? 'i1' : null, threadId: null, newThreadTitle: kind === 'item' ? null : 'Menu', newLoomRepo: kind === 'new_loom' ? 'tango' : null, questions: [] });
  const response = await app.request('/api/desk/voice-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId: 'path', text: 'Sierra, in tango, fix the menu' }) });
  expect(await response.json()).toMatchObject({ status: 'sent' });
  if (kind === 'item') expect(command).toHaveBeenCalledWith({ commandId: 'phone-path', itemId: 'loom:existing', actor: 'owner', type: 'reply', args: { text: 'Fix it' } });
  else { expect(start).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'phone-path', prompt: 'Fix it', ...(kind === 'new_loom' ? { repo: 'tango' } : { agentId: 'sierra' }) })); expect(afterStart).toHaveBeenCalledOnce(); }
});

it('recovers interrupted routing and delivery as separate held drafts on restart', () => {
  const { deps, h } = setup();
  for (const phase of ['routing', 'delivering']) h.core.store.setMarker(`phone-note:${phase}`, JSON.stringify({ noteId: phase, text: 'Keep my original words', phase }));
  new PhoneNotes(deps);
  expect(h.core.item('phone:routing')?.facts.phoneNote?.uncertain).toBe(false);
  expect(h.core.item('phone:delivering')?.facts.phoneNote?.uncertain).toBe(true);
});

it('asks about an invented item handle instead of falling back to an agent home', async () => {
  const { notes, deps, compile, deliver } = setup(); const base = deps.runtime;
  deps.runtime = async () => { const runtime = await base(); runtime.context.input.agents = [{ id: 'sierra', name: 'Sierra', role: 'test agent' }]; return runtime; };
  compile.mockResolvedValue({ message: 'A thought', agentId: 'sierra', item: 'invented', threadId: null, newThreadTitle: null, newLoomRepo: null, questions: [] });
  expect((await notes.submit({ noteId: 'invented', text: 'A thought' })).status).toBe('ask');
  expect(deliver).not.toHaveBeenCalled();
});

it('keeps a definitively rejected delivery selectable across restart', async () => {
  const deliver = vi.fn().mockResolvedValueOnce({ ok: false, notDelivered: true }).mockResolvedValueOnce({ ok: true });
  const { notes, deps, h } = setup({ deliver });
  expect((await notes.submit(request)).status).toBe('held');
  expect(h.core.item('phone:ios-123')?.facts.phoneNote?.uncertain).toBe(false);
  const restored = new PhoneNotes(deps);
  expect((await restored.submit(request)).status).toBe('held');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect((await restored.sendHeld(request.noteId, 'repo:tango'))?.status).toBe('sent');
  expect(deliver).toHaveBeenCalledTimes(2);
});

describe('one clarification round', () => {
  it('validates answer-only posts', () => {
    expect(parsePhoneNote({ noteId: 'note', answer: ' Sierra ' })).toEqual({ noteId: 'note', answer: 'Sierra' });
    expect(parsePhoneNote({ noteId: 'note', answer: 42 })).toBeNull();
  });
  it('uses the original text and answer to route once, including across restart', async () => {
    const { notes, deps, deliver, compile } = setup();
    expect((await notes.submit({ noteId: 'answer', text: 'Fix the menu' })).status).toBe('ask');
    notes.close();
    const restored = new PhoneNotes(deps); services.push(restored);
    const results = await Promise.all([restored.submit({ noteId: 'answer', answer: 'tango' }), restored.submit({ noteId: 'answer', answer: 'tango' })]);
    expect(results.map(r => r.status)).toEqual(['sent', 'sent']);
    expect(compile).toHaveBeenLastCalledWith(expect.objectContaining({ fragments: ['Fix the menu'], clarifications: [{ question: "Who's it for?", answer: 'tango' }] }));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await restored.submit({ noteId: 'answer', answer: 'another repo' })).status).toBe('sent');
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('holds unanswered notes at two minutes and ignores late answers', async () => {
    vi.useFakeTimers(); const { notes, h, deliver } = setup();
    await notes.submit({ noteId: 'timeout', text: 'A thought' });
    await vi.advanceTimersByTimeAsync(119999);
    expect(h.core.item('phone:timeout')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.core.item('phone:timeout')).not.toBeNull();
    expect((await notes.submit({ noteId: 'timeout', answer: 'tango' })).status).toBe('held');
    expect(deliver).not.toHaveBeenCalled();
  });
  it('recovers expired questions after restart without delivery', async () => {
    vi.useFakeTimers(); const { notes, deps, h } = setup();
    await notes.submit({ noteId: 'expired', text: 'A thought' }); notes.close();
    await vi.advanceTimersByTimeAsync(120001);
    const restored = new PhoneNotes(deps); services.push(restored);
    expect(h.core.item('phone:expired')?.facts.phoneNote?.uncertain).toBe(false);
  });
  it('never creates or delivers a note from an orphan answer', async () => {
    const { notes, compile, deliver } = setup();
    expect((await notes.submit({ noteId: 'missing', answer: 'tango' })).status).toBe('held');
    expect(compile).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
  });
});

it.each([false, true])('only unlocks a refused start when preflight proves it was not dispatched (ready=%s)', async ready => {
  const { h, deps } = setup();
  const app = new Hono();
  const start = vi.fn(async () => ({ ok: false, check: { ready, plan: ready ? {} : null }, error: 'Unavailable' }));
  registerDeskRoutes(app, { core: h.core, scenes: () => [], phoneNoteRuntime: deps.runtime,
    startWork: { service: { start } as unknown as NonNullable<DeskRoutesOptions['startWork']>['service'], afterStart: vi.fn() },
  });
  const response = await app.request('/api/desk/voice-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  expect(await response.json()).toMatchObject({ status: 'held' });
  expect(h.core.item('phone:ios-123')?.facts.phoneNote?.uncertain).toBe(ready);
});


describe('spoken delivery receipts', () => {
  it.each([
    ['home', undefined, 'Sent to Sierra.'],
    ['new_thread', 'shed vents quote', 'Sent to Sierra, new thread: shed vents quote.'],
    ['new_loom', 'desk menu overflow', 'Started a tango thread: desk menu overflow.'],
    ['thread', 'shed vents quote', 'Sent to Sierra, thread: shed vents quote.'],
    ['item', undefined, 'Sent to Sierra.'],
  ] as const)('speaks %s without visual label syntax', (kind, title, expected) => {
    const say = phoneNoteReceipt({ kind, title, name: 'Sierra', agentId: 'sierra', repo: 'tango', label: 'WRONG · visual label' });
    expect(say).toBe(expected);
    expect(say).not.toContain('·');
  });
  it('removes middle dots from user-provided titles too', () => {
    expect(phoneNoteReceipt({ kind: 'new_thread', name: 'Sierra', agentId: 'sierra', title: 'Vents · quote', label: 'unused' })).not.toContain('·');
  });
  it('uses spoken receipts for immediate and held-note delivery', async () => {
    const { notes } = setup();
    expect((await notes.submit(request)).say).toBe('Started a tango thread: Menu.');
    await notes.submit({ noteId: 'held-speech', text: 'A thought' });
    await notes.submit({ noteId: 'held-speech', answer: 'Not sure' });
    const receipt = await notes.sendHeld('held-speech', 'repo:tango');
    expect(receipt?.say).toBe('Started a tango thread.');
    expect(receipt?.say).not.toContain('·');
  });
});


it.each(['error', 'timeout', 'restart', 'empty'] as const)('preserves the answer in held delivery after %s during clarification compilation', async failure => {
  vi.useFakeTimers();
  const { notes, deps, compile, deliver, h } = setup({ timeoutMs: 100 });
  const text = 'Schedule the release';
  const answer = 'Friday, not Thursday';
  const fallback = `${text}\n\nClarification: ${answer}`;
  compile.mockResolvedValueOnce({ message: text, agentId: null, item: null, threadId: null, newThreadTitle: '', newLoomRepo: null, questions: ['Which day?'] });
  expect((await notes.submit({ noteId: 'correction', text })).status).toBe('ask');
  if (failure === 'error') compile.mockRejectedValueOnce(new Error('Compiler unavailable'));
  else if (failure === 'empty') compile.mockResolvedValueOnce({ message: '', agentId: null, item: null, threadId: null, newThreadTitle: '', newLoomRepo: null, questions: [] });
  else compile.mockImplementationOnce(() => new Promise(() => {}));
  const pending = notes.submit({ noteId: 'correction', answer });
  // Capture the durable state written before the second compiler completes.
  const interrupted = h.core.store.marker('phone-note:correction')!;
  await vi.advanceTimersByTimeAsync(101);
  expect((await pending).status).toBe('held');
  let sender = notes;
  if (failure === 'restart') {
    notes.close();
    h.core.store.setMarker('phone-note:correction', interrupted);
    sender = new PhoneNotes(deps); services.push(sender);
  }
  expect(h.core.item('phone:correction')?.facts.phoneNote?.text).toBe(fallback);
  expect((await sender.sendHeld('correction', 'repo:tango'))?.status).toBe('sent');
  expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'new_loom' }), fallback, 'phone-correction');
});
