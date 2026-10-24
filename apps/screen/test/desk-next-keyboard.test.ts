import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module, no types
import { keyHelp, onHistoryKey, onListKey, replyTakesFocus } from '../public/desk/next/keyboard.js';

// The DOM supplies only the rows the page rendered; the store owns their actions.
function setup(page = 'inbox') {
  const nodes = ['a', 'b', 'hidden'].map((id) => ({ dataset: { rowId: id }, focus: vi.fn(), scrollIntoView: vi.fn() }));
  const group = (rows: unknown[], shut = false) => ({ classList: { contains: () => shut }, querySelectorAll: () => rows });
  let menu = false;
  const overlay = { closest: () => null, checkVisibility: () => true };
  vi.stubGlobal('document', { querySelectorAll: (sel: string) => (sel.includes('role=') ? (menu ? [overlay] : []) : [group(nodes.slice(0, 2)), group(nodes.slice(2), true)]) });
  const state = { nextRoute: { page }, focusId: null as string | null, activity: {}, holds: {}, byId: Object.fromEntries(nodes.map((n) => [n.dataset.rowId, { id: n.dataset.rowId, disposition: 'active', nextStep: 'fyi' }])) };
  const store = { state, set: (patch: object) => Object.assign(state, patch), nextOpen: vi.fn(), done: vi.fn(), openSnooze: vi.fn(), quickSnooze: vi.fn(), openReply: vi.fn(), answer: vi.fn(), openStartWork: vi.fn() };
  const press = (key: string, over = {}) => onListKey({ key, target: { closest: () => null }, preventDefault: vi.fn(), ...over }, store);
  return { store, state, nodes, press, menu: () => { menu = true; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('next list keyboard', () => {
  it.each(['d', 'e'])('%s routes a standing conversation through the same server-decided action', (key) => {
    const { press, state, store } = setup();
    Object.assign(state.byId.a, { facts: { role: 'default' } });
    state.focusId = 'a';
    press(key);
    expect(store.done).toHaveBeenCalledWith('a');
  });

  it.each(['inbox', 'project', 'agent'])('focuses, scrolls, opens and triages visible %s rows', (page) => {
    const { press, state, nodes, store } = setup(page);
    press('j');
    expect(state.focusId).toBe('a');
    press('j');
    press('j');
    expect(state.focusId).toBe('b');
    expect(nodes[1].focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(nodes[1].scrollIntoView).toHaveBeenCalled();
    press('Enter');
    expect(store.nextOpen).toHaveBeenCalledWith('b');
    press('e');
    expect(store.done).toHaveBeenCalledWith('b');
    press('s');
    expect(store.openSnooze).toHaveBeenCalledWith('b');
    press('S');
    expect(store.quickSnooze).toHaveBeenCalledWith('b', {});
    state.byId.b.disposition = 'snoozed';
    press('S');
    expect(store.quickSnooze).toHaveBeenLastCalledWith('b', { retime: true });
    press('r');
    expect(store.openReply).toHaveBeenCalledWith('b');
    press('k');
    expect(state.focusId).toBe('a');
  });

  it('ignores stale focus, running and done rows, and held snooze keys', () => {
    const { press, state, store } = setup();
    state.focusId = 'hidden';
    for (const key of ['Enter', 'e', 's', 'S', 'r', '1']) press(key);
    expect(store.nextOpen).not.toHaveBeenCalled();
    state.focusId = 'a';
    state.byId.a.nextStep = 'working';
    for (const key of ['e', 's', 'S']) press(key);
    state.byId.a.nextStep = 'fyi';
    state.byId.a.disposition = 'done';
    for (const key of ['e', 's', 'S']) press(key);
    state.byId.a.disposition = 'snoozed';
    press('s', { repeat: true });
    press('S', { repeat: true });
    expect(store.done).not.toHaveBeenCalled();
    expect(store.openSnooze).not.toHaveBeenCalled();
    expect(store.quickSnooze).not.toHaveBeenCalled();
    press('s');
    expect(store.openSnooze).toHaveBeenCalledWith('a');
  });

  it.each(['sheet', 'startWork', 'projectEditor', 'nextSwitcher', 'snoozeFor', 'confirm', 'filterOpen', 'listMenu', 'replyOpen'])('does not triage behind %s', (overlay) => {
    const { press, state, store } = setup();
    Object.assign(state, { [overlay]: true, focusId: 'a' });
    press('j');
    press('e');
    expect(state.focusId).toBe('a');
    expect(store.done).not.toHaveBeenCalled();
  });

  it('answers only an actionable visible row, respecting pending holds', () => {
    const { press, state, store } = setup();
    state.focusId = 'a';
    state.byId.a.nextStep = 'your_move';
    Object.assign(state.byId.a, { options: ['First', 'Second', 'Third'] });
    for (const key of ['1', '2', '3']) press(key);
    expect(store.answer.mock.calls).toEqual([['a', 'First'], ['a', 'Second'], ['a', 'Third']]);
    Object.assign(state.holds, { a: true });
    press('1');
    expect(store.answer).toHaveBeenCalledTimes(3);
  });

  it('n starts work where you are: in the project on its page (Codex review on #624)', () => {
    const { store, state, press } = setup('project');
    state.nextRoute = { page: 'project', id: 'p1' } as typeof state.nextRoute;
    press('n');
    expect(store.openStartWork).toHaveBeenLastCalledWith({ projectId: 'p1' });
    state.nextRoute = { page: 'inbox' };
    press('n');
    expect(store.openStartWork).toHaveBeenLastCalledWith({ projectId: null });
  });

  it('an open thread takes the same letters, acting on the thread', () => {
    const { store, state, press } = setup();
    Object.assign(state, { presentation: { view: 'conversation', itemId: 'b' } });
    // The list copy is stale (done); the loaded detail the page shows is active, so e acts.
    (state.byId as Record<string, unknown>).b = { id: 'b', disposition: 'done', nextStep: 'fyi' };
    Object.assign(state, { detail: { id: 'b', item: { id: 'b', disposition: 'active', nextStep: 'fyi' } } });
    press('e');
    expect(store.done).toHaveBeenCalledWith('b');
    press('s');
    expect(store.openSnooze).toHaveBeenCalledWith('b');
    press('S');
    expect(store.quickSnooze).toHaveBeenCalledWith('b', {});
    press('r');
    expect(store.openReply).toHaveBeenCalledWith('b');
    expect(store.nextOpen).not.toHaveBeenCalled();
    press('e', { target: { closest: () => ({}) } }); // typing in the reply box
    expect(store.done).toHaveBeenCalledTimes(1);
    // A control window keeps the thread up under a stage: its keys still act on it.
    Object.assign(state, { role: 'control', presentation: { view: 'screen', itemId: 'b', sceneId: 's1' } });
    press('e');
    expect(store.done).toHaveBeenCalledTimes(2);
  });

  it('? shows the keys and Esc or ? puts them away; nothing else acts meanwhile', () => {
    const { store, state, press } = setup();
    press('?');
    expect(state).toMatchObject({ nextKeys: true });
    press('j');
    expect(state.focusId).toBeNull();
    const enter = { preventDefault: vi.fn() };
    press('Enter', enter);
    expect(enter.preventDefault).toHaveBeenCalled(); // a focused button behind the sheet doesn't fire
    expect(store.nextOpen).not.toHaveBeenCalled();
    press('Escape');
    expect(state).toMatchObject({ nextKeys: false });
    press('?');
    press('?');
    expect(state).toMatchObject({ nextKeys: false });
    Object.assign(state, { listMenu: 'x' }); // a menu up: ? leaves it be
    press('?');
    expect(state).toMatchObject({ nextKeys: false });
    expect(store.done).not.toHaveBeenCalled();
  });

  it('ignores typing, modifiers and open menus', () => {
    const { press, state, menu, store } = setup();
    state.focusId = 'a';
    press('j', { target: { closest: () => ({}) } });
    press('e', { ctrlKey: true });
    menu();
    press('j');
    press('e');
    expect(state.focusId).toBe('a');
    expect(store.done).not.toHaveBeenCalled();
  });

  it('? lists only what the page answers to', () => {
    const keys = (help: { rows: string[][] } | null) => help?.rows.map(([k]) => k);
    expect(keys(keyHelp({ nextRoute: { page: 'inbox' } }))).toContain('f');
    expect(keys(keyHelp({ nextRoute: { page: 'project', id: 'p1' } }))).not.toContain('f');
    expect(keyHelp({ nextRoute: { page: 'inbox' }, nextSelect: { kind: 'thread', ids: [] } })?.title).toBe('Selecting');
    expect(keyHelp({ nextRoute: { page: 'projects' } })).toBeNull();
    expect(keyHelp({ nextRoute: { page: 'inbox' } }, { thread: true, stage: true })).toBeNull();
    expect(keyHelp({ nextRoute: { page: 'inbox' } }, { thread: true })?.title).toBe('On a thread');
  });

  it('d is Done, on a row and on a thread; e still works', () => {
    const { store, state, press } = setup();
    press('j');
    press('d');
    expect(store.done).toHaveBeenLastCalledWith('a');
    Object.assign(state, { presentation: { view: 'conversation', itemId: 'b' } });
    press('d');
    press('e');
    expect(store.done).toHaveBeenCalledTimes(3);
    expect(keyHelp({ nextRoute: { page: 'inbox' } })?.rows.map(([k]: string[]) => k)).toContain('d');
  });
});

describe('reply box focus when a thread opens', () => {
  const body = { tagName: 'BODY' };
  it('takes the cursor with a mouse or trackpad, so dictation lands', () => {
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: body })).toBe(true);
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: null })).toBe(true);
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: { tagName: 'A' } })).toBe(true);
  });
  it('leaves keyboard driving, touch screens and a text box already in use alone', () => {
    expect(replyTakesFocus({ finePointer: true, keyboardMode: true, active: body })).toBe(false);
    expect(replyTakesFocus({ finePointer: false, keyboardMode: false, active: body })).toBe(false);
    // A touch laptop: a fine primary pointer, but the thread was opened by a tap.
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: body, lastPointer: 'touch' })).toBe(false);
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: body, lastPointer: 'mouse' })).toBe(true);
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: { tagName: 'INPUT' } })).toBe(false);
    expect(replyTakesFocus({ finePointer: true, keyboardMode: false, active: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
  });
});

describe('⌘[ and ⌘]', () => {
  const make = (state: object = {}) => ({ state: { search: {}, activity: {}, ...state }, nextBack: vi.fn(), nextForward: vi.fn() });
  const key = (k: string, over = {}) => ({ key: k, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault: vi.fn(), ...over });

  it('go back and forward, even while typing, and never reach Chrome', () => {
    vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [] });
    const store = make();
    const back = key('[', { target: { tagName: 'TEXTAREA' } });
    expect(onHistoryKey(back, store)).toBe(true);
    expect(store.nextBack).toHaveBeenCalledOnce();
    expect(back.preventDefault).toHaveBeenCalled();
    expect(onHistoryKey(key(']'), store)).toBe(true);
    expect(store.nextForward).toHaveBeenCalledOnce();
  });

  it('leave other keys alone and wait under a menu or dialog', () => {
    vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [] });
    const store = make();
    expect(onHistoryKey(key('[', { metaKey: false }), store)).toBe(false);
    expect(onHistoryKey(key('[', { shiftKey: true }), store)).toBe(false);
    expect(onHistoryKey(key('k'), store)).toBe(false);
    const covered = make({ nextSwitcher: true });
    const press = key('[');
    expect(onHistoryKey(press, covered)).toBe(true);
    expect(press.preventDefault).toHaveBeenCalled();
    expect(covered.nextBack).not.toHaveBeenCalled();
    const image = make({ lightbox: { images: [], index: 0 } });
    expect(onHistoryKey(key('['), image)).toBe(true);
    expect(image.nextBack).not.toHaveBeenCalled();
    expect(onHistoryKey(key(']', { repeat: true }), store)).toBe(true);
    expect(store.nextForward).not.toHaveBeenCalled();
  });
});

it('r does nothing for a retired row, while Done remains available', () => {
  const { press, state, store } = setup();
  state.focusId = 'a';
  Object.assign(state.byId.a, { replyable: false });
  press('r');
  expect(store.openReply).not.toHaveBeenCalled();
  expect(store.nextOpen).not.toHaveBeenCalled();
  press('d');
  expect(store.done).toHaveBeenCalledWith('a');
});
