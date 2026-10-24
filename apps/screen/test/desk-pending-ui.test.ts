import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';
import {
  allowsOther,
  answeredCount,
  answersFrom,
  approvalTone,
  canDismiss,
  currentDraft,
  describeAnswers,
  emptyDraft,
  isOneTap,
  isPicked,
  isRecommended,
  pendingHeadline,
  pendingOf,
  pick,
  questionChanged,
  setOther,
  toggleOther,
  // @ts-expect-error plain browser module, no types
} from '../public/desk/pending.js';

// The screen's logic for a Loom request waiting on the owner: which items get the form, picks per
// question (single, multi, free text), when Submit is ready, and what gets sent. Synthetic content.

const reviewer = {
  id: 'Who should review it?',
  header: 'Reviewer',
  question: 'Who should review it?',
  multiSelect: false,
  options: [
    { label: 'Both leads (Recommended)', description: 'Covers both sides of the change.' },
    { label: 'Storage lead only', description: 'Lighter.' },
  ],
};
const labels = { id: 'labels', header: 'Labels', question: 'Which labels?', multiSelect: true, allowCustomAnswer: false, options: [{ label: 'bug', description: '' }, { label: 'ui', description: '' }] };
const pending = (questions: unknown[], extra: Record<string, unknown> = {}) => ({ kind: 'question', requestId: 'req-1', questions, question: '', options: [], at: 1, ...extra });
const t3 = (p: unknown, extra: Record<string, unknown> = {}) => ({ id: 'loom:a', source: 'loom', nextStep: 'your_move', disposition: 'active', facts: { pending: p }, ...extra });

// The window's move count (hub.ts staleMove) isn't what these tests are about.
const withoutWindow = ({ window: _window, ...intent }: Record<string, unknown>) => intent;

describe('pending request UI logic', () => {
  it('only your-move, active items with questions or approval options get the form', () => {
    const p = pending([reviewer]);
    expect(pendingOf(t3(p))).toBe(p);
    expect(pendingOf(t3(p, { nextStep: 'working' }))).toBeNull();
    expect(pendingOf(t3(p, { disposition: 'done' }))).toBeNull();
    expect(pendingOf(t3(pending([])))).toBeNull();
    expect(pendingOf(t3({ kind: 'approval', requestId: 'a', questions: [], approval: { options: [{ decision: 'accept', label: 'Approve' }] } }))).toBeTruthy();
    expect(pendingOf({ id: 'discord:thread:1', nextStep: 'your_move', facts: {} })).toBeNull();
  });

  it('Dismiss only for requests Loom marks dismissible', () => {
    expect(canDismiss(pending([reviewer], { dismissible: true }))).toBe(true);
    expect(canDismiss(pending([reviewer]))).toBe(false);
    expect(canDismiss(pending([reviewer], { dismissible: true, requestId: null }))).toBe(false);
    expect(canDismiss({ kind: 'approval', requestId: 'a', dismissible: true, questions: [] })).toBe(false);
  });

  it('one single-select question is one tap; several questions or a multi-select need Submit', () => {
    expect(isOneTap(pending([reviewer]))).toBe(true);
    expect(isOneTap(pending([reviewer, labels]))).toBe(false);
    expect(isOneTap(pending([labels]))).toBe(false);
  });

  it('single-select picks replace each other and a second tap clears; multi-select toggles', () => {
    const p = pending([reviewer, labels]);
    let draft = emptyDraft(p);
    draft = pick(draft, reviewer, 'Storage lead only');
    draft = pick(draft, reviewer, 'Both leads (Recommended)');
    expect(isPicked(draft, reviewer.id, 'Both leads (Recommended)')).toBe(true);
    expect(isPicked(draft, reviewer.id, 'Storage lead only')).toBe(false);
    expect(isPicked(pick(draft, reviewer, 'Both leads (Recommended)'), reviewer.id, 'Both leads (Recommended)')).toBe(false);
    draft = pick(pick(pick(draft, labels, 'bug'), labels, 'ui'), labels, 'bug');
    expect(draft.picks.labels).toEqual(['ui']);
  });

  it('Submit is ready only when every question has an answer; free text replaces the chips', () => {
    const p = pending([reviewer, labels]);
    let draft = pick(emptyDraft(p), reviewer, 'Storage lead only');
    expect(answeredCount(p, draft)).toBe(1);
    expect(answersFrom(p, draft)).toBeNull();
    draft = pick(draft, labels, 'bug');
    expect(answersFrom(p, draft)).toEqual({ [reviewer.id]: 'Storage lead only', labels: ['bug'] });
    draft = setOther(toggleOther(draft, reviewer.id), reviewer.id, 'Someone from the platform team');
    expect(isPicked(draft, reviewer.id, 'Storage lead only')).toBe(false);
    expect(answersFrom(p, draft)).toEqual({ [reviewer.id]: 'Someone from the platform team', labels: ['bug'] });
    expect(describeAnswers(p, answersFrom(p, draft))).toBe('Reviewer: Someone from the platform team · Labels: bug');
    // A blank free-text box is no answer; picking a chip again clears it.
    draft = setOther(draft, reviewer.id, '   ');
    expect(answersFrom(p, draft)).toBeNull();
    // Labels-only questions offer no Other… and ignore free text.
    expect(allowsOther(labels)).toBe(false);
    expect(allowsOther(reviewer)).toBe(true);
  });

  it('a draft belongs to one request: a new request id starts over; picks survive otherwise', () => {
    const p = pending([reviewer]);
    const draft = pick(emptyDraft(p), reviewer, 'Storage lead only');
    expect(currentDraft(p, draft)).toBe(draft);
    expect(currentDraft({ ...p, requestId: 'req-2' }, draft).picks).toEqual({});
  });

  it('headlines, recommended labels, approval tones and "question changed" failures', () => {
    expect(pendingHeadline(pending([reviewer]))).toBe('Who should review it?');
    expect(pendingHeadline(pending([reviewer, labels]))).toBe('2 questions before it goes on');
    expect(pendingHeadline({ kind: 'approval', approval: { detail: 'Run the migration', options: [] } })).toBe('Approve? Run the migration');
    expect(isRecommended('Both leads (Recommended)')).toBe(true);
    expect(isRecommended('Storage lead only')).toBe(false);
    expect([approvalTone('accept'), approvalTone('acceptForSession'), approvalTone('decline'), approvalTone('cancel')]).toEqual(['ok', 'ok', 'no', 'no']);
    expect(questionChanged({ status: 'failed', error: 'the question changed since you saw it' })).toBe(true);
    expect(questionChanged({ status: 'failed', error: 'x', outcome: { changed: true } })).toBe(true);
    expect(questionChanged({ status: 'failed', error: 'answer not delivered: HTTP 500' })).toBe(false);
  });
});

describe('store: answering from an open Conversation', () => {
  it('uses the loaded detail (fresh request) over the stale list copy', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied' }),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = t3(pending([reviewer], { requestId: 'req-old' }));
    store.state.detail = { id: 'loom:a', loading: false, item: t3(pending([reviewer], { requestId: 'req-new' })), messages: [], timeline: [], scenes: [] };
    await store.answer('loom:a', 'Storage lead only');
    expect(sent).toEqual([expect.objectContaining({ type: 'respond', itemId: 'loom:a', args: { requestId: 'req-new', answers: { [reviewer.id]: 'Storage lead only' } } })]);
    // While the detail is still loading, the list copy is all there is.
    store.state.byId['loom:b'] = { ...t3(pending([reviewer], { requestId: 'req-old' })), id: 'loom:b' };
    store.state.detail = { id: 'loom:b', loading: true, item: null, messages: [], timeline: [], scenes: [] };
    await store.answer('loom:b', 'Storage lead only');
    expect(sent[1]).toMatchObject({ itemId: 'loom:b', args: { requestId: 'req-old' } });
  });
});

describe('store: a carried brief keeps its own draft', () => {
  it('typing on the carried brief leaves the row’s own draft alone, and answering it clears only its own', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied' }),
    };
    const store = createStore(client);
    const own = pending([reviewer, labels]);
    const brief = pending([{ id: 'decision', header: 'Your options', question: 'Ship it?', multiSelect: false, allowCustomAnswer: true, options: [{ label: 'A · Ship', description: '' }] }], { requestId: 'decision:D-6' });
    store.state.byId['loom:a'] = t3(own, { facts: { pending: own, carried: [{ from: { itemId: 'loom:w', title: 'Worker' }, pending: brief, why: 'worker', counts: true }] } });
    store.pendingPick('loom:a', reviewer, 'Storage lead only');
    store.pendingToggleOther('loom:a', 'decision', brief);
    store.pendingOther('loom:a', 'decision', 'Ship it Monday', brief);
    expect(store.pendingDraft('loom:a').picks[reviewer.id]).toEqual(['Storage lead only']);
    expect(store.pendingDraft('loom:a', brief).other.decision).toBe('Ship it Monday');
    await store.answerPending('loom:a', 'decision', 'Ship it Monday', brief);
    expect(sent).toEqual([expect.objectContaining({ type: 'respond', itemId: 'loom:a', args: { requestId: 'decision:D-6', answers: { decision: 'Ship it Monday' } } })]);
    // The row's own half-done answers are still there.
    expect(store.pendingDraft('loom:a').picks[reviewer.id]).toEqual(['Storage lead only']);
  });

  it('an answer to a revised brief names the revision the card showed (TGO-1079)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied' }),
    };
    const store = createStore(client);
    const brief = pending([{ id: 'decision', header: 'Your options', question: 'Ship it?', multiSelect: false, allowCustomAnswer: true, options: [{ label: 'A · Ship', description: '' }] }], { requestId: 'decision:D-6', brief: { id: 'D-6', revision: 3 } });
    store.state.byId['loom:w'] = t3(brief, { id: 'loom:w', source: 'loom' });
    await store.answer('loom:w', 'A · Ship');
    expect(sent).toEqual([expect.objectContaining({ type: 'respond', itemId: 'loom:w', args: { requestId: 'decision:D-6', answers: { decision: 'A · Ship' }, revision: 3 } })]);
  });
});

describe('store: a tapped answer goes at once', () => {
  const setup = (reply: (cmd: Record<string, unknown>) => Record<string, unknown>) => {
    const sent: Array<Record<string, unknown>> = [];
    let land = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => (sent.push(cmd), new Promise((resolve) => (land = () => resolve({ commandId: cmd.commandId, ...reply(cmd) })))),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = t3(pending([reviewer]));
    return { store, sent, land: () => land() };
  };

  it('sends on the tap, no countdown, and shows what was sent in place of the chips', async () => {
    const { store, sent, land } = setup(() => ({ status: 'applied' }));
    const answering = store.answer('loom:a', 'Storage lead only');
    expect(sent).toHaveLength(1);
    expect(store.state.holds['loom:a']).toMatchObject({ option: 'Storage lead only' });
    // A second tap while the first is on its way sends nothing more.
    store.answer('loom:a', 'Both leads (Recommended)');
    expect(sent).toHaveLength(1);
    land();
    await answering;
    expect(store.state.toasts).toEqual([]);
  });

  it('a failure brings the chips back and a Retry toast that sends the same answer', async () => {
    let fail = true;
    const { store, sent, land } = setup(() => (fail ? { status: 'failed', error: 'Loom is offline' } : { status: 'applied' }));
    const answering = store.answer('loom:a', 'Storage lead only');
    land();
    await answering;
    expect(store.state.holds['loom:a']).toBeUndefined();
    const toast = store.state.toasts.at(-1);
    expect(toast).toMatchObject({ sticky: true, text: expect.stringContaining('Loom is offline') });
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Retry', 'Open']);
    fail = false;
    const retrying = toast.actions[0].fn();
    land();
    await retrying;
    expect(sent[1]).toMatchObject({ type: 'respond', args: sent[0].args });
  });

  it('no Retry when the question moved on', async () => {
    const { store, land } = setup(() => ({ status: 'failed', error: 'the question changed since you saw it' }));
    const answering = store.answer('loom:a', 'Storage lead only');
    land();
    await answering;
    expect(store.state.toasts.some((t: { actions: Array<{ label: string }> }) => t.actions.some((a) => a.label === 'Retry'))).toBe(false);
  });
});

describe('store: a typed reply goes back to the board, like a spoken one', () => {
  const setup = (view: string, itemId = 'loom:a') => {
    const intents: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => ({ commandId: cmd.commandId, status: 'applied' }),
      present: async (intent: Record<string, unknown>) => (intents.push(withoutWindow(intent)), { view: intent.view, itemId: null, queue: [] }),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = t3(null);
    store.state.presentation = { view, itemId, conversationKey: 'k', sceneId: null, queue: [], by: 'screen', since: 1 };
    return { store, intents };
  };

  it('from its Conversation or Screen view', async () => {
    for (const view of ['conversation', 'screen']) {
      const { store, intents } = setup(view);
      await store.sendReply('loom:a', 'Ship it');
      expect(intents).toEqual([{ view: 'active' }]);
      expect(store.state.presentation.view).toBe('active');
    }
  });

  it('a prototype being tried stays up; another item on screen stays up', async () => {
    const proto = setup('prototype');
    await proto.store.sendReply('loom:a', 'The button is off');
    expect(proto.intents).toEqual([]);
    const other = setup('conversation', 'loom:b');
    await other.store.sendReply('loom:a', 'Ship it');
    expect(other.intents).toEqual([]);
  });

  it('goes back at the tap, before the send lands', async () => {
    const { store, intents } = setup('conversation');
    const sending = store.sendReply('loom:a', 'Ship it');
    expect(intents).toEqual([{ view: 'active' }]);
    await sending;
  });

  it('a failed send puts the words back ahead of anything typed since, with Retry', async () => {
    const intents: Array<Record<string, unknown>> = [];
    const sent: Array<Record<string, unknown>> = [];
    let land = (): void => {};
    let fail = true;
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => (sent.push(cmd), new Promise((resolve) => (land = () => resolve(fail ? { commandId: cmd.commandId, status: 'failed', error: 'HTTP 502' } : { commandId: cmd.commandId, status: 'applied' })))),
      present: async (intent: Record<string, unknown>) => (intents.push(withoutWindow(intent)), { view: intent.view, itemId: null, queue: [] }),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = { ...t3(null), agentName: 'Sierra' };
    store.state.presentation = { view: 'conversation', itemId: 'loom:a', conversationKey: 'k', sceneId: null, queue: [], by: 'screen', since: 1 };
    store.setDraft('loom:a', 'Ship it');
    const sending = store.sendReply('loom:a');
    expect(store.draftFor('loom:a')).toBe('');
    store.setDraft('loom:a', 'and tag it');
    land();
    await sending;
    expect(store.draftFor('loom:a')).toBe('Ship it\n\nand tag it');
    const toast = store.state.toasts.at(-1);
    expect(toast).toMatchObject({ sticky: true, text: expect.stringContaining('Sierra') });
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Retry', 'Open']);
    fail = false;
    const retrying = toast.actions[0].fn();
    land();
    await retrying;
    expect(sent[1]).toMatchObject({ type: 'reply', args: { text: 'Ship it' } });
    expect(store.draftFor('loom:a')).toBe('and tag it');
  });

  // One item's commands go to the desk in the order tapped, so the second fails after the first.
  it.each([[0, 1]])('two sends that both fail come back in the order they were sent (failing %i then %i)', async (a, b) => {
    const lands: Array<() => void> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => new Promise((resolve) => lands.push(() => resolve({ commandId: cmd.commandId, status: 'failed', error: 'HTTP 502' }))),
      present: async () => ({ view: 'conversation', itemId: 'loom:a', queue: [] }),
    };
    const store = createStore(client);
    store.setSendStay(true);
    store.state.byId['loom:a'] = t3(null);
    store.setDraft('loom:a', 'first');
    const one = store.sendReply('loom:a');
    store.setDraft('loom:a', 'second');
    const two = store.sendReply('loom:a');
    store.setDraft('loom:a', 'third, still typing');
    lands[a]();
    await (a === 0 ? one : two);
    await new Promise((r) => setTimeout(r, 0)); // the second goes once the first has answered
    lands[b]();
    await Promise.all([one, two]);
    expect(store.draftFor('loom:a')).toBe('first\n\nsecond\n\nthird, still typing');
    store.setSendStay(false);
  });

  it('restored images stay within a reply’s limit, the failed reply’s first', async () => {
    let land = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => new Promise((resolve) => (land = () => resolve({ commandId: cmd.commandId, status: 'failed', error: 'HTTP 502' }))),
      present: async () => ({ view: 'active', itemId: null, queue: [] }),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = t3(null);
    const image = (id: string) => ({ id, name: `${id}.png`, mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' });
    const first = Array.from({ length: 8 }, (_, i) => image(`a${i}`));
    store.state.replyImages['loom:a'] = first;
    store.setDraft('loom:a', 'these');
    const sending = store.sendReply('loom:a');
    store.state.replyImages['loom:a'] = Array.from({ length: 3 }, (_, i) => image(`b${i}`));
    land();
    await sending;
    expect(store.imagesFor('loom:a').map((i: { id: string }) => i.id)).toEqual(first.map((i) => i.id));
    expect(store.state.toasts.at(-1).text).toContain('3 newer images didn’t fit');
  });

  it('Send & stay keeps the thread open, as the remembered mode or for one send', async () => {
    const remembered = setup('conversation');
    remembered.store.setSendStay(true);
    await remembered.store.sendReply('loom:a', 'Ship it');
    expect(remembered.intents).toEqual([]);
    expect(remembered.store.state.presentation.view).toBe('conversation');
    // ⌘⇧↵ sends the other way once: back to the board this time, the mode unchanged.
    await remembered.store.sendReply('loom:a', 'And this', { stay: false });
    expect(remembered.intents).toEqual([{ view: 'active' }]);
    expect(remembered.store.state.sendStay).toBe(true);
    remembered.store.setSendStay(false);
    const once = setup('conversation');
    await once.store.sendReply('loom:a', 'Ship it', { stay: true });
    expect(once.intents).toEqual([]);
  });
});

describe('store: Done from a thread goes back at the tap', () => {
  it('leaves before the server answers; a failure is a toast with Retry', async () => {
    const intents: Array<Record<string, unknown>> = [];
    const sent: Array<Record<string, unknown>> = [];
    let fail = true;
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), fail ? { commandId: cmd.commandId, status: 'failed', error: 'HTTP 502' } : { commandId: cmd.commandId, status: 'applied' }),
      present: async (intent: Record<string, unknown>) => (intents.push(withoutWindow(intent)), { view: intent.view, itemId: null, queue: [] }),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = { ...t3(null), place: 'Shed vents' };
    store.state.presentation = { view: 'conversation', itemId: 'loom:a', conversationKey: 'k', sceneId: null, queue: [], by: 'screen', since: 1 };
    const doing = store.sendDone('loom:a');
    expect(intents).toEqual([{ view: 'active' }]);
    await doing;
    const toast = store.state.toasts.at(-1);
    expect(toast).toMatchObject({ sticky: true, text: expect.stringContaining('Shed vents') });
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Retry', 'Open']);
    fail = false;
    // The Retry sends what the tap sent, guard and all, even after the item changed underneath.
    store.state.byId['loom:a'] = { ...store.state.byId['loom:a'], disposition: 'snoozed', attentionUpdatedAt: 99 };
    await toast.actions[0].fn();
    expect(sent.map((c) => c.type)).toEqual(['done', 'done']);
    expect(sent[1].args).toEqual(sent[0].args);
  });

  it('no Retry when the item changed since the tap', async () => {
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => ({ commandId: cmd.commandId, status: 'failed', error: 'it’s back in Active with something new', outcome: { changed: true } }),
      present: async () => ({ view: 'active', itemId: null, queue: [] }),
    };
    const store = createStore(client);
    store.state.byId['loom:a'] = { ...t3(null), disposition: 'snoozed', attentionUpdatedAt: 5, place: 'Shed vents' };
    await store.sendDone('loom:a');
    expect(store.state.toasts.at(-1).actions.map((a: { label: string }) => a.label)).toEqual(['Open']);
  });
});
