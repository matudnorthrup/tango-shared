import { describe, expect, it } from 'vitest';

describe('captions across operator sessions', () => {
  it('a new session starts with no captions from the last one', async () => {
    // @ts-expect-error plain browser module, no types
    const { createStore } = await import('../public/desk/store.js');
    const store = createStore({});
    store.handlers.onOperator({ live: true, status: 'listening', transcript: { speaker: 'owner', text: 'catch me up', final: true } });
    expect(store.state.captions.map((c: any) => c.text)).toEqual(['catch me up']);
    store.handlers.onOperator({ live: true, status: 'speaking', transcript: { speaker: 'agent', name: 'Watson', text: 'Three things.', final: true } });
    expect(store.state.captions).toHaveLength(2);
    store.handlers.onOperator({ live: false, status: 'idle' });
    store.handlers.onOperator({ live: true, status: 'listening' });
    expect(store.state.captions).toEqual([]);
  });
});

describe('captions on a reconnect', () => {
  it("the stream's hello replaying the latest line does not add it again", async () => {
    // @ts-expect-error plain browser module, no types
    const { createStore } = await import('../public/desk/store.js');
    const store = createStore({});
    const latest = { live: true, status: 'listening', transcript: { speaker: 'owner', text: 'open the track PRs', final: true } };
    store.handlers.onOperator({ live: true, status: 'speaking', transcript: { speaker: 'agent', name: 'Operator', text: 'Sent.', final: true } });
    store.handlers.onOperator(latest);
    store.handlers.onOperator(latest, { replay: true }); // hello after a reconnect
    expect(store.state.captions.map((c: any) => c.text)).toEqual(['Sent.', 'open the track PRs']);
    store.handlers.onOperator(latest); // said again: a new line
    expect(store.state.captions.map((c: any) => c.text)).toEqual(['Sent.', 'open the track PRs', 'open the track PRs']);
  });
});

describe('catch-up card conversation links', () => {
  // Expand the real components' virtual nodes without a browser or a separate rendering library.
  function nodes(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (node == null || typeof node === 'boolean') return [];
    if (typeof node !== 'object') return [node];
    if (typeof node.type === 'function') return nodes(node.type(node.props));
    return [node, ...nodes(node.props?.children)];
  }
  it('NewsMoment and DecidedMoment show the conversation, open it, and quietly link its Linear project', async () => {
    // @ts-expect-error browser module
    const { ChapterBrief, NewsMoment, DecidedMoment, LineFrom } = await import('../public/desk/next/chapter.js');
    const opened: string[] = [];
    const store = { state: { byId: { thread: { summary: { about: 'Catch Up feature', title: 'Old title' }, facts: { projectId: 'desk' } } },
      projects: [{ id: 'desk', linearUrl: 'https://linear.app/example/project/desk' }] }, nextOpen: (id: string) => opened.push(id) };
    const line = { id: 528, itemId: 'thread', title: 'Stop Catch me up showing answered asks?', kind: 'needs' };
    for (const component of [NewsMoment, DecidedMoment]) {
      const rendered = nodes(component({ line, brief: { about: 'Catch me up page' }, store, spaceId: 'desk' }));
      expect(rendered.filter(n => typeof n === 'string').join('')).toContain('“Catch Up feature” →');
      const links = rendered.filter(n => n.type === 'a');
      expect(links.some(n => n.props.href === 'https://linear.app/example/project/desk')).toBe(true);
      links.find(n => n.props.onClick).props.onClick({ preventDefault() {} });
    }
    expect(opened).toEqual(['thread', 'thread']);
    const compact = nodes(ChapterBrief({ line, brief: { about: 'Catch me up page' }, store, spaceId: 'desk' }));
    expect(compact.filter(n => typeof n === 'string').join('')).toContain('Catch me up page · from Catch Up feature →');
    compact.find(n => n.type === 'button' && n.props.class === 'bc-link').props.onClick();
    expect(opened.at(-1)).toBe('thread');
    const fallbackStore = { ...store, state: { ...store.state, chapters: { desk: { data: { briefs: [{ id: 528, about: 'Catch me up page' }] } } } } };
    const fallback = nodes(ChapterBrief({ line: { ...line, spaceId: 'desk', briefId: 528 }, brief: {}, store: fallbackStore, spaceId: 'desk' }));
    expect(fallback.filter(n => typeof n === 'string').join('')).toContain('Catch me up page · from');
    const withoutAbout = nodes(ChapterBrief({ line, brief: {}, store, spaceId: 'desk' }));
    expect(withoutAbout.filter(n => typeof n === 'string').join('')).toContain('From Catch Up feature →');
    // A brief that folded a repeat names where else it was asked, inside the brief card.
    const folded = nodes(ChapterBrief({ line: { ...line, also: [{ id: 529, from: 'Notifications' }] }, brief: { about: 'Catch me up page' }, store, spaceId: 'desk' }));
    expect(folded.filter(n => typeof n === 'string').join('')).toContain('Also asked in “Notifications”');
    expect(LineFrom({ line: { itemId: 'missing' }, store })).toBeNull();
    store.state.byId.thread.summary.about = '';
    expect(nodes(LineFrom({ line, store })).join()).toContain('Old title');
  });
});
