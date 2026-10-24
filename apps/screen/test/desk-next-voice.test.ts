import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module
import { confirmToOpen, freshCaption, voiceLine } from '../public/desk/next/voice-model.js';
const base = { operator: { live: false, status: 'idle' }, captions: [], draft: null, pause: null };
const arrival = { line: { speaker: 'agent', name: 'Agent', text: 'Ready' }, at: 1000 };
const draft = { id: 'd1', active: true, status: 'confirm', target: { label: 'Agent · thread' }, compiled: 'Hello' };
describe('next voice summary', () => {
  it('hides idle but shows drafts and pauses, with pause first', () => {
    expect(voiceLine(base, arrival, 1000)).toBeNull();
    expect(voiceLine({ ...base, draft }, arrival, 1000)).toMatchObject({ kind: 'confirm', text: 'Send to Agent · thread?' });
    expect(voiceLine({ ...base, draft, pause: { active: true, id: 'p1', waiting: 3 } }, arrival, 1000)).toMatchObject({ kind: 'paused', text: 'Paused · 3 waiting', pause: { canResume: true } });
    expect(voiceLine({ ...base, pausePending: true, pause: { active: true, id: 'p1', still: true, waiting: 2 } }, null, 1000)).toMatchObject({ text: 'Still paused · 2 waiting', pause: { canResume: false } });
  });
  it('settles fresh captions back to operator state and gives drafting priority', () => {
    const live = { ...base, operator: { live: true, status: 'thinking' } };
    expect(voiceLine(live, arrival, 6999)).toMatchObject({ kind: 'caption', agentName: 'Agent' });
    expect(voiceLine(live, arrival, 7000)).toMatchObject({ kind: 'thinking' });
    expect(voiceLine({ ...live, operator: { live: true, status: 'speaking', agentName: 'Agent' } }, arrival, 7000)).toMatchObject({ kind: 'speaking', text: 'Agent is speaking…' });
    expect(voiceLine({ ...live, operator: { live: true, status: 'listening' } }, null, 7000)).toMatchObject({ kind: 'listening' });
    expect(voiceLine({ ...live, draft: { ...draft, status: 'compiling' } }, arrival, 1000)).toMatchObject({ kind: 'drafting', text: 'Drafting to Agent · thread' });
  });
  it('retains questions, notes and terminal draft states', () => {
    expect(voiceLine({ ...base, draft: { ...draft, question: 'Which thread?' } }, arrival, 1000).text).toBe('One question before sending');
    for (const status of ['sending', 'sent', 'cancelled']) expect(voiceLine({ ...base, draft: { ...draft, status, active: status === 'sending', updatedAt: 1000 } }, arrival, 1000).kind).toBe('draft');
    expect(voiceLine({ ...base, draft: { ...draft, status: 'cancelled', active: false, note: 'Not delivered' } }, arrival, 99999).kind).toBe('draft');
    expect(voiceLine({ ...base, draft: { ...draft, status: 'sent', active: false, updatedAt: 1000 } }, null, 17000)).toBeNull();
  });
  it('uses arrival windows of four and six seconds', () => {
    expect(freshCaption(arrival, 4999, 4000)).toBe(arrival.line);
    expect(freshCaption(arrival, 5000, 4000)).toBeNull();
    expect(freshCaption(arrival, 6999)).toBe(arrival.line);
    expect(freshCaption(arrival, 7000)).toBeNull();
    expect(freshCaption(null, 1000)).toBeNull();
  });
  it('auto-opens once per confirm id even after returning to confirm', () => {
    expect(confirmToOpen({ ...draft, status: 'listening' }, [])).toBeNull();
    expect(confirmToOpen(draft, [])).toBe('d1');
    expect(confirmToOpen(draft, ['d1'])).toBeNull();
    expect(confirmToOpen({ ...draft, id: 'd2' }, ['d1'])).toBe('d2');
    expect(confirmToOpen(draft, ['d1', 'd2'])).toBeNull();
    expect(confirmToOpen({ ...draft, active: false }, [])).toBeNull();
  });
});

describe('voice actions through the fixture store', () => {
  it('sends and cancels drafts and resumes a pause through the existing methods', async () => {
    // @ts-expect-error plain browser module
    const { createFixtureClient } = await import('../public/desk/fixtures.js');
    // @ts-expect-error plain browser module
    const { createStore } = await import('../public/desk/store.js');
    for (const action of ['send', 'cancel', 'resume']) {
      const client = createFixtureClient({ params: new URLSearchParams(`operator=live&${action === 'resume' ? 'pause=1&waiting=3' : 'draft=confirm'}`) });
      const store = createStore(client);
      const disconnect = client.connect({ onDraft: store.handlers.onDraft, onPause: store.handlers.onPause });
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (action === 'resume') {
          expect(voiceLine(store.state, null, Date.now()).pause.canResume).toBe(true);
          await store.resumePause();
          expect(store.state.pause.active).toBe(false);
        } else {
          expect(voiceLine(store.state, null, Date.now()).kind).toBe('confirm');
          await store.draftCommand(action);
          expect(store.state.draft.status).toBe(action === 'send' ? 'sent' : 'cancelled');
        }
      } finally { disconnect(); }
    }
  });
});
