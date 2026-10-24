import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module, no types
import { handoffPrompt, isHandoff, onCodeButton, startFromHandoff } from '../public/desk/md-actions.js';

// What a message's buttons and a handoff's Start do (md-actions.js).

function fakeStore(state: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    state: { sheet: null, convoFlyout: null, ...state },
    closeSheet: () => calls.push(['closeSheet']),
    set: (patch: unknown) => calls.push(['set', patch]),
    openStartWork: (opts: unknown) => calls.push(['openStartWork', opts]),
  };
}

/** A click on a code block's Start button, as the delegated handler sees it. */
function startClick(text: string) {
  const block = { querySelector: () => ({ textContent: text }) };
  const button = { dataset: { code: 'start' }, closest: () => block };
  return { target: { closest: () => button }, stopPropagation: vi.fn() };
}

describe('code block Start', () => {
  it('opens Start work with the block, in the project the message belongs to', () => {
    const store = fakeStore({ sheet: { kind: 'exchange' } });
    expect(onCodeButton(startClick('Build the thing.'), store, 'p1')).toBe(true);
    expect(store.calls).toEqual([['closeSheet'], ['openStartWork', { prompt: 'Build the thing.', projectId: 'p1' }]]);
  });

  it('a panel flown out over the page steps aside', () => {
    const store = fakeStore({ convoFlyout: 'right' });
    onCodeButton(startClick('Go.'), store);
    expect(store.calls).toEqual([['set', { convoFlyout: null }], ['openStartWork', { prompt: 'Go.', projectId: null }]]);
  });

  it('a click that is not a toolbar button is left alone (a coordinator chip, say)', () => {
    const event = { target: { closest: () => null }, stopPropagation: vi.fn() };
    expect(onCodeButton(event, fakeStore())).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});

describe('handoff links', () => {
  const base = 'https://host.example.ts.net/artifacts/car-game-research';
  it('a handoff is named so by the agent or by its file', () => {
    expect(isHandoff({ kind: 'file', label: 'Camera handoff', url: `${base}/handoff-labs-camera.md` })).toBe(true);
    expect(isHandoff({ kind: 'file', label: 'Studio handoff', url: `${base}/channel-and-studio.md` })).toBe(true);
    expect(isHandoff({ kind: 'file', label: 'Brief', url: `${base}/HANDOFF-labs-integration.md` })).toBe(true);
    expect(isHandoff({ kind: 'prototype', label: 'design', url: `${base}/design.html` })).toBe(false);
    expect(isHandoff({ kind: 'pr', label: 'PR #1: handoff', url: 'https://github.com/o/r/pull/1' })).toBe(false);
  });

  it('the prompt is the brief, or a pointer when it could not be read', () => {
    const a = { kind: 'file', label: 'Camera handoff', url: `${base}/handoff-labs-camera.md` };
    expect(handoffPrompt(a, '# Handoff: camera\n\nYou own it.\n')).toBe(`# Handoff: camera\n\nYou own it.\n\n(Handoff brief: ${a.url})`);
    expect(handoffPrompt(a, '')).toContain(`Read the handoff brief at ${a.url}`);
  });

  afterEach(() => vi.unstubAllGlobals());

  /** A store whose Start work sheet opens as the real one does: a fresh command id, the prompt in its form. */
  function sheetStore() {
    const store = fakeStore() as ReturnType<typeof fakeStore> & { setStartField: (k: string, v: string) => void };
    let n = 0;
    store.openStartWork = (opts: any) => {
      store.calls.push(['openStartWork', opts]);
      (store.state as any).startWork = { commandId: `c${(n += 1)}`, projectId: opts.projectId, sending: false, form: { prompt: opts.prompt } };
    };
    store.setStartField = (key: string, value: string) => ((store.state as any).startWork.form[key] = value);
    return store;
  }
  const a = { kind: 'file', label: 'Handoff', url: `${base}/handoff-3d-models.md` };

  it('Start opens at once, pointing at the brief, in the project; the brief replaces the pointer once read', async () => {
    let resolve!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (resolve = r))));
    const store = sheetStore();
    const started = startFromHandoff(store, a, 'p1');
    expect(store.calls).toEqual([['openStartWork', { prompt: handoffPrompt(a), projectId: 'p1' }]]);
    resolve({ ok: true, text: async () => '# Handoff: models\n\nYou own the models.' });
    await started;
    expect((store.state as any).startWork.form.prompt).toBe(`# Handoff: models\n\nYou own the models.\n\n(Handoff brief: ${a.url})`);
  });

  it('a slow brief never overwrites the owner’s edits or another sheet (Codex review on #558)', async () => {
    let resolve!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (resolve = r))));
    const store = sheetStore();
    const edited = startFromHandoff(store, a, 'p1');
    (store.state as any).startWork.form.prompt = 'My own words.';
    resolve({ ok: true, text: async () => '# Handoff' });
    await edited;
    expect((store.state as any).startWork.form.prompt).toBe('My own words.');

    const replaced = startFromHandoff(store, a, 'p1');
    (store.state as any).startWork = { commandId: 'other', sending: false, form: { prompt: handoffPrompt(a) } };
    resolve({ ok: true, text: async () => '# Handoff' });
    await replaced;
    expect((store.state as any).startWork.form.prompt).toBe(handoffPrompt(a));
  });

  it('a brief it cannot fetch leaves the pointer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const store = sheetStore();
    await startFromHandoff(store, a, null);
    expect((store.state as any).startWork.form.prompt).toBe(handoffPrompt(a));
  });
});
