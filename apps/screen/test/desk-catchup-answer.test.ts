import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';
// @ts-expect-error plain browser module, no types
import { openLines } from '../public/desk/next/catchup-model.js';

// Catch me up's brief card answers on a tap: an option is the normal answer path (`respond`) with the revision the
// card showed, and the brief leaves the card (docs/specs/catch-up.md, "Catch me up").

const brief = {
  id: 'D-7',
  itemId: 'loom:lead',
  ask: 'Stage the holdout rule?',
  standing: null,
  options: [
    { key: 'A', label: 'Stage with these defaults', consequence: null, recommended: true, answer: 'A · Stage with these defaults (Recommended)' },
    { key: 'B', label: 'Stage with a 20% holdout', consequence: null, recommended: false, answer: 'B · Stage with a 20% holdout' },
  ],
  defaultOption: 'A',
  vetoLeftMs: null,
  level: 3,
  revision: 2,
};
const line = { id: 11, kind: 'needs', moment: true, title: 'Stage the holdout rule?', briefId: 'D-7', itemId: 'loom:lead', at: 1 };

function setup(status: 'sent' | 'failed') {
  const sent: Array<{ type: string; itemId: string; args: Record<string, unknown> }> = [];
  const store = createStore({
    mode: 'live',
    chapters: async () => ({ chapters: [] }),
    // The ledger hasn't resolved the line yet when the card reads again.
    chapter: async () => ({ lines: [line], waiting: [], plan: { updateIds: [11], revision: 'r', line: '' }, briefs: [brief] }),
    command: async (c: { type: string; itemId: string; args: Record<string, unknown> }) => {
      sent.push(c);
      return status === 'sent' ? { status: 'sent' } : { status: 'failed', error: 'refused' };
    },
  });
  return { store, sent };
}

describe('a brief answered on the catch-up card', () => {
  it('tapping B answers B with the revision shown, and the brief leaves the card', async () => {
    const { store, sent } = setup('sent');
    await store.loadChapter('project:notifications');
    await store.chapterAnswer('project:notifications', line, brief, brief.options[1]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'respond', itemId: 'loom:lead', args: { requestId: 'decision:D-7', answers: { decision: 'B · Stage with a 20% holdout' }, revision: 2 } });
    expect(openLines(store.state.chapters['project:notifications'], store.state.lineLocal)).toEqual([]);
  });

  it('sends the rule choice and reason selected on the compact card', async () => {
    const { store, sent } = setup('sent');
    store.setBriefRule(brief.itemId, { rule: 'next-time', reason: 'Keep this manual' }, { requestId: 'decision:D-7', brief });
    await store.chapterAnswer('project:notifications', line, brief, brief.options[0]);
    expect(sent[0].args).toMatchObject({ rule: 'next-time', reason: 'Keep this manual', revision: 2 });
  });

  it('a refused answer puts the brief back', async () => {
    const { store } = setup('failed');
    await store.loadChapter('project:notifications');
    await store.chapterAnswer('project:notifications', line, brief, brief.options[0]);
    expect(openLines(store.state.chapters['project:notifications'], store.state.lineLocal).map((l: { id: number }) => l.id)).toEqual([11]);
  });
});
