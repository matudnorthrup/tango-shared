import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain browser modules, no types
import { decisionOfLink, linkDecisionsInHtml, linked, setKnownDecisions } from '../public/desk/decision-links.js';
// @ts-expect-error plain browser module, no types
import { renderMarkdown } from '../public/desk/md.js';
import { createApp } from '../server/app.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { makeHarness, type Harness } from './desk-harness.js';

// D-n as links (TGO-1110): every text the desk renders turns a known decision id into a link to its page; the page's
// address is served as the desk itself, with its relative URLs resolved against the desk's root.

describe('D-n auto-links', () => {
  beforeEach(() => setKnownDecisions([4, 67]));
  afterEach(() => setKnownDecisions([]));

  it('links known ids in markdown, and leaves unknown ones, lookalikes, links and code blocks alone', () => {
    const html = renderMarkdown('Decision D-67 is still open (not D-1, D-670 or XD-4).\n\n- **D-4** and `D-4`\n- [D-67](https://example.test/decision/D-67)\n\n```\nD-4 in a block\n```');
    expect(html.match(/<a class="dlink"[^>]*>D-\d+<\/a>/g)).toEqual([
      '<a class="dlink" data-decision="D-67" href="decision/D-67">D-67</a>',
      '<a class="dlink" data-decision="D-4" href="decision/D-4">D-4</a>',
      '<a class="dlink" data-decision="D-4" href="decision/D-4">D-4</a>',
    ]);
    expect(html).toContain('not D-1, D-670 or XD-4');
    expect(html).toContain('<a href="https://example.test/decision/D-67" target="_blank" rel="noopener noreferrer">D-67</a>');
    expect(html).toContain('<pre><code>D-4 in a block</code></pre>');
  });

  it('plain text becomes parts for a template: strings, and a link for each known id', () => {
    expect(linked('no ids here')).toBe('no ids here');
    expect(linked('answer D-1 first')).toBe('answer D-1 first');
    const parts = linked('answer D-4, then D-67.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('answer ');
    expect(parts[2]).toBe(', then ');
    expect(parts[4]).toBe('.');
    expect(parts[1]).toMatchObject({ props: { 'data-decision': 'D-4', href: 'decision/D-4' } });
  });

  it('a markup string is only touched outside tags: an attribute that holds an id keeps it', () => {
    expect(linkDecisionsInHtml('<span title="D-4">D-4</span>')).toBe('<span title="D-4"><a class="dlink" data-decision="D-4" href="decision/D-4">D-4</a></span>');
  });

  it('a link to a decision page, on this desk or the tailnet one an agent wrote, opens over the desk', () => {
    const anchor = (href: string, decision?: string) => ({ dataset: decision ? { decision } : {}, getAttribute: () => href, baseURI: 'https://desk.test/tango-screen/' });
    expect(decisionOfLink(anchor('decision/D-4', 'D-4'), 'https://desk.test')).toBe('D-4');
    expect(decisionOfLink(anchor('https://desk.test/tango-screen/decision/D-67'), 'https://desk.test')).toBe('D-67');
    expect(decisionOfLink(anchor('https://elsewhere.test/decision/D-67'), 'https://desk.test')).toBeNull();
    expect(decisionOfLink(anchor('https://desk.test/pull/1'), 'https://desk.test')).toBeNull();
  });
});

describe('the brief page address', () => {
  let h: Harness;
  let hub: Hub;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    h = makeHarness();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    app = createApp({ store: scenes, hub, publicDir: path.resolve('public'), desk: { routes: { core: h.core, scenes: () => [], presentation: { current: () => hub.publicPresentation(), subscribe: (l) => hub.subscribePresentation(l) } }, compat: { core: h.core, hub, rules: null, pollSources: async () => undefined } } });
  });
  afterEach(() => {
    hub.close();
    h.close();
  });

  it('/decision/D-n is the desk shell with its URLs resolved against the desk root; the desk root is unchanged', async () => {
    const page = await (await app.request('/decision/D-67')).text();
    expect(page).toContain('<base href="../">');
    expect(page).toContain('<div id="app">');
    expect(await (await app.request('/decision/D-67/')).text()).toContain('<base href="../../">');
    expect(await (await app.request('/')).text()).not.toContain('<base');
    expect((await app.request('/decision/nope')).status).toBe(404);
  });
});

// Full-page history must not depend on the thread's recent-answer window.
describe('answered decision rule controls', () => {
  it('includes old owner answers even when the originating thread is gone', async () => {
    const { decisionPage } = await import('../server/desk/decided.js');
    const decision = {
      id: 'D-80', class: 'design-direction', level: 2, candidate: 0,
      status: 'answered', ask: 'Use this layout?', created_at: 1, resolved_at: 2,
      decided_by: 'person', rule_choice: 'always',
      rule: { id: 'R-8', state: 'suspended', scope: 'layouts', do: 'reuse the card' },
      brief: { door: 'two-way' as const, blast: 'private' as const, standing: '', background: '', options: [], proposedRule: 'Reuse the card' },
    };
    expect(decisionPage(decision, () => null, []).savedRule).toMatchObject({ decisionId: 'D-80', choice: 'always', ruleId: 'R-8', ruleState: 'suspended' });
    for (const over of [{ status: 'open' }, { status: 'moot' }, { decided_by: 'agent' }, { brief: { ...decision.brief, tripwire: 'money' } }, { rule_choice: null }]) {
      expect(decisionPage({ ...decision, ...over }, () => null, []).savedRule).toBeNull();
    }
  });
});

 it('refreshes the open decision after a rule change, and restores the choice on failure', async () => {
  // @ts-expect-error plain browser module, no types
  const { createStore } = await import('../public/desk/store.js');
  let reads = 0;
  let fail = false;
  const store = createStore({
    decision: async () => { reads++; return { id: 'D-80', savedRule: { choice: 'next-time' } }; },
    chapters: async () => ({ chapters: [] }),
    decidedRule: async () => { if (fail) throw new Error('offline'); return { ruleState: 'retired' }; },
  });
  store.state.decisionPage = { id: 'D-80', data: {} };
  await store.ruleDecided({ decision: 'D-80', from: 'always' }, 'next-time', 'test-rule');
  expect(reads).toBe(1);
  expect(store.state.decisionPage.data.savedRule.choice).toBe('next-time');
  const previous = store.state.ruleLocal['D-80'];
  fail = true;
  await store.ruleDecided({ decision: 'D-80', from: 'next-time' }, 'always', 'test-failed-rule');
  expect(reads).toBe(1);
  expect(store.state.ruleLocal['D-80']).toEqual(previous);
 });

it('projects discussion separately from an open ask, keeping formal answers available', async () => {
  const { decisionPage } = await import('../server/desk/decided.js');
  const d = { id: 'D-9', class: 'design-direction', level: 2, candidate: 0, status: 'open',
    ask: 'Which layout?', created_at: 1, discussing_since: 20,
    brief: { door: 'two-way' as const, blast: 'private' as const, standing: '', background: '', options: [{ key: 'A', label: 'Compact', consequence: 'Fits' }] } };
  const page = decisionPage(d, () => null, []);
  expect(page.status).toBe('discussing');
  expect(page.pending?.brief?.discussingSince).toBe(20);
  expect(page.pending?.questions?.[0].options).toHaveLength(1);
  expect(page.outcome).toBeNull();
  // keep/update clear discussion; an unhandled turn returns the delivery-aware warning.
  for (const state of [{ discussing_since: null }, { discussing_since: null, unaddressed_at: 30 }]) {
    expect(decisionPage({ ...d, ...state }, () => null, []).status).toBe('open');
  }
  expect(decisionPage({ ...d, status: 'moot' }, () => null, []).status).toBe('moot');
});

it('retains only a recorded formal owner answer as a durable receipt', async () => {
  const { answeredBrief } = await import('../server/desk/source-loom.js');
  const d = { id: 'D-9', class: 'design-direction', level: 2, candidate: 0, status: 'answered',
    ask: 'Which layout?', created_at: 1, resolved_at: 20, decided_by: 'person', answer_option: 'A',
    brief: { door: 'two-way' as const, blast: 'private' as const, standing: '', background: '', options: [{ key: 'A', label: 'Compact', consequence: 'Fits' }] } };
  expect(answeredBrief([d])).toEqual({ id: 'D-9', choice: 'A · Compact', at: 20 });
  expect(answeredBrief([d, { ...d, id: 'D-10', resolved_at: 30 }])?.id).toBe('D-10');
  for (const state of [{ status: 'open', discussing_since: 30 }, { status: 'moot' }, { decided_by: 'agent' }, { resolved_at: null }]) {
    expect(answeredBrief([{ ...d, ...state }])).toBeNull();
  }
});

it('keeps rule choice and reason controls available while discussing', async () => {
  // @ts-expect-error plain browser module
  const { DecisionBody } = await import('../public/desk/next/decision.js');
  for (const status of ['open', 'discussing']) {
    const tree = DecisionBody({ page: { id: 'D-9', status, raisedOn: { itemId: 'i' },
      brief: { options: [], proposedRule: 'Use compact layouts' }, changes: [] }, store: {} });
    const card = tree[0];
    expect(card.props.rule).not.toBeNull();
    expect(card.props.rule.props.brief.proposedRule).toBe('Use compact layouts');
  }
});
