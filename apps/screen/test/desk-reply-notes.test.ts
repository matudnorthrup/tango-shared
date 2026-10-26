import { describe, expect, it, vi } from 'vitest';
import { latestReply, sinceOwner } from '../server/desk/view.js';
import { turnsOf } from '../server/desk/backstage.js';

// Inspect Reply before and after opening the later-notes toggle.
const toggle = vi.hoisted(() => ({ open: false }));
vi.mock('../public/vendor/preact-htm.js', async importOriginal => ({
  ...await importOriginal<object>(), useState: (initial: unknown) => [toggle.open || initial, () => { toggle.open = !toggle.open; }],
}));
// @ts-expect-error plain browser module
import { Reply } from '../public/desk/conversation.js';

describe('reply before the owner has written', () => {
  it('exposes labelled working notes in a closed disclosure alongside the answer', () => {
    const messages = [
      { itemId: 'i', messageId: 'n', author: 'agent' as const, text: '**Checking** the build.', at: 1, meta: { phase: 'note' as const } },
      { itemId: 'i', messageId: 'a', author: 'agent' as const, text: 'Build passed.', at: 2, meta: { phase: 'answer' as const } },
    ];
    const d = { sinceOwner: sinceOwner(turnsOf(messages)), reply: latestReply(messages) };
    expect(d.sinceOwner).toBeNull();
    const tree = Reply({ item: { id: 'i' }, d, store: { state: { now: 1000 } } });
    const rows = tree.props.children.flat().filter(Boolean);
    const notes = rows.find((row: any) => row.type === 'details');
    expect(notes).toBeDefined();
    expect(notes.props.open).toBeUndefined();
    expect(JSON.stringify(notes.props.children[0])).toContain('notes while working');
    expect(JSON.stringify(notes)).toContain('**Checking** the build.');
    expect(JSON.stringify(tree)).toContain('Build passed.');
  });

  it('does not add a working-note disclosure for legacy replies', () => {
    const tree = Reply({ item: { id: 'i' }, d: { reply: { text: 'Legacy answer.', at: 2 } }, store: { state: { now: 1000 } } });
    expect(JSON.stringify(tree)).not.toContain('notes while working');
  });
});


describe('working notes inside later entries', () => {
  it('keeps each entry’s notes in its own closed disclosure after opening later notes', () => {
    const working = { at: 3, messageIds: ['n'], text: '**Checking** again.', attachments: [{ kind: 'image', url: '/chart.png', name: 'chart.png' }] };
    const d = { reply: { text: 'Pinned report.', at: 1 }, laterNotes: { count: 2, notes: [
      { text: 'Recorded the handoff.', at: 4, notes: [working] },
      { text: 'Legacy later reply.', at: 5 },
    ] } };
    const render = () => Reply({ item: { id: 'i' }, d, store: { state: { now: 1000 } } });
    try {
      const closed = render();
      expect(JSON.stringify(closed)).not.toContain('Checking');
      const toggleRow = closed.props.children.flat().find((row: any) => row?.props?.class === 'ml-sum');
      toggleRow.props.children[0].props.onClick();
      const opened = render();
      const later = opened.props.children.flat().find((row: any) => row?.props?.class === 'ml-sum open');
      const entries = later.props.children[1].props.children;
      const disclosure = entries[0].props.children.find((row: any) => row?.type === 'details');
      expect(disclosure.props.open).toBeUndefined();
      expect(disclosure.props.children[0].props.children).toEqual([1, ' notes while working']);
      expect(JSON.stringify(disclosure)).toContain('**Checking** again.');
      expect(JSON.stringify(disclosure)).toContain('/chart.png');
      expect(JSON.stringify(disclosure)).toContain(new Date(3).toISOString());
      expect(JSON.stringify(entries[0])).toContain('Recorded the handoff.');
      expect(JSON.stringify(entries[1])).toContain('Legacy later reply.');
      expect(JSON.stringify(entries[1])).not.toContain('notes while working');
    } finally { toggle.open = false; }
  });
});
