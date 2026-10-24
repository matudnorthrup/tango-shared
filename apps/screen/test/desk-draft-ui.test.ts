import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { blankDraft, DRAFT_LINGER_MS, draftView } from '../public/desk/draft-model.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// The Draft card's logic (voice draft mode): what it shows in each state, and which buttons.

const base = { active: true, target: { agentId: 'sierra', name: 'Sierra', where: null, label: 'Sierra' }, fragments: ['we leave Friday', 'take the small tent'], compiled: null, question: null, note: null, status: 'listening', updatedAt: 1000 };

describe('draft card', () => {
  it('hidden when no draft is open', () => {
    expect(draftView(blankDraft(), 0)).toBeNull();
    expect(draftView(null, 0)).toBeNull();
  });

  it('listening: "Drafting for Sierra", the running text with the newest fragment apart, Cancel only', () => {
    const view = draftView(base, 2000);
    expect(view).toMatchObject({ title: 'Drafting for Sierra', earlier: ['we leave Friday'], newest: 'take the small tent', canSend: false, canCancel: true, canDismiss: false });
    expect(draftView({ ...base, target: null, fragments: [] }, 2000)).toMatchObject({ title: 'Drafting…', empty: true });
  });

  it('confirm: the compiled message, its destination, Send and Cancel', () => {
    const view = draftView({ ...base, status: 'confirm', compiled: 'We leave Friday; take the small tent.', target: { agentId: 'sierra', name: 'Sierra', where: 'Shed vents', label: 'Sierra · Shed vents thread' } }, 2000);
    expect(view).toMatchObject({ title: 'Ready to send', to: 'Sierra · Shed vents thread', compiled: 'We leave Friday; take the small tent.', canSend: true, canCancel: true });
    expect(view.hint).toContain('no, to Victor');
  });

  it('a question blocks Send until it is answered', () => {
    const view = draftView({ ...base, status: 'confirm', compiled: 'x', question: 'This Thursday or next?' }, 2000);
    expect(view).toMatchObject({ title: 'One question before sending', canSend: false, question: 'This Thursday or next?' });
  });

  it('sending: no Cancel or Send while it is on its way', () => {
    const view = draftView({ ...base, status: 'sending', compiled: 'x', target: { agentId: 'sierra', name: 'Sierra', where: null, label: 'Sierra · main channel' } }, 2000);
    expect(view).toMatchObject({ title: 'Sending to Sierra…', canSend: false, canCancel: false, canDismiss: false, to: 'Sierra · main channel' });
  });

  it('a send that was not accepted is back at confirm with its note', () => {
    expect(draftView({ ...base, status: 'confirm', compiled: 'x', note: 'Not sent: Discord is down' }, 2000)).toMatchObject({ canSend: true, canCancel: true, note: 'Not sent: Discord is down' });
  });

  it('sent / cancelled linger briefly; an unsent note stays until dismissed', () => {
    const sent = { ...base, active: false, status: 'sent', compiled: 'x', updatedAt: 1000 };
    expect(draftView(sent, 2000)).toMatchObject({ title: 'Sent to Sierra', canDismiss: true, canCancel: false });
    expect(draftView(sent, 1000 + DRAFT_LINGER_MS + 1)).toBeNull();
    const unsent = { ...base, active: false, status: 'cancelled', note: 'Not sent: the voice session ended', updatedAt: 1000 };
    expect(draftView(unsent, 1000 + 10 * DRAFT_LINGER_MS)).toMatchObject({ title: 'Unsent draft', note: 'Not sent: the voice session ended', canDismiss: true });
  });
});

describe('draft card taps', () => {
  it('Send / Cancel / Dismiss carry the id of the draft on screen (PR review 4)', async () => {
    const calls: Array<[string, string | null]> = [];
    const store = createStore({ mode: 'fixtures', draftCommand: async (action: string, draftId: string | null) => calls.push([action, draftId]) });
    store.handlers.onDraft({ ...base, id: 'draft-7', status: 'confirm', compiled: 'x' });
    await store.draftCommand('send');
    store.handlers.onDraft({ ...base, id: 'draft-8' });
    await store.draftCommand('cancel');
    expect(calls).toEqual([
      ['send', 'draft-7'],
      ['cancel', 'draft-8'],
    ]);
  });
});
