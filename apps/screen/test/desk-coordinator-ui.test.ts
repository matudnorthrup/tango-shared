import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { coordinatorMarkdown, coordinatorTimeline, panelTabs, projectLinks, stillPending } from '../public/desk/coordinator-model.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// The coordinator panel's logic (coordinator-model.js) and its store actions.

describe('coordinator answers', () => {
  it('desk links become chips dotted with the conversation’s state; the rest stays safe markdown', () => {
    const items: Record<string, unknown> = { 'loom:a': { id: 'loom:a', status: { pill: 'needs', countsForOwner: true }, nextStep: 'your_move', facts: { pending: { question: 'Apply?' } }, disposition: 'active' } };
    const out = coordinatorMarkdown('**Two** things: [Migration](desk:loom:a) and [Gone](desk:loom:zz). <script>x</script>', (id: string) => items[id] || null);
    expect(out).toContain('<strong>Two</strong>');
    expect(out).toContain('<button type="button" class="cchip" data-item="loom:a" style="--c:var(--move)"');
    expect(out).toContain('>Migration</button>');
    expect(out).toContain('data-item="loom:zz" style="--c:var(--dim)"');
    expect(out).not.toContain('<script>');
    // A label is escaped too: it is taken out before the rest is (Codex review on #545).
    const sneaky = coordinatorMarkdown('[<img src=x onerror=alert(1)>](desk:loom:a)', () => null);
    expect(sneaky).not.toContain('<img');
    expect(sneaky).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('one timeline: messages, drafts and digests by time, the owner’s unsent questions last', () => {
    const view = {
      messages: [
        { id: 'q', kind: 'question', text: 'Status?', at: 10 },
        { id: 'a', kind: 'answer', text: 'Fine.', at: 20 },
      ],
      drafts: [{ id: 'd', createdAt: 21, state: 'draft' }],
      digests: [{ at: 5, text: '- quiet' }],
    };
    expect(coordinatorTimeline(view, [{ text: 'And now?', at: 30 }]).map((e: { kind: string }) => e.kind)).toEqual(['digest', 'question', 'answer', 'draft', 'question']);
  });

  it('a question the thread now has is no longer pending', () => {
    const pending = [{ text: 'Status?', at: 1000 }, { text: 'Next?', at: 2000 }];
    expect(stillPending(pending, { messages: [{ kind: 'question', text: 'Status? ', at: 1500 }] })).toEqual([{ text: 'Next?', at: 2000 }]);
  });
});

describe('the right panel’s tabs', () => {
  it('Coordinator in a project, Links when there are any; the remembered tab when it is there', () => {
    expect(panelTabs({ inProject: true, links: 3, remembered: 'links' })).toEqual({ tabs: ['coordinator', 'links'], tab: 'links' });
    expect(panelTabs({ inProject: true, links: 0, remembered: 'links' })).toEqual({ tabs: ['coordinator'], tab: 'coordinator' });
    expect(panelTabs({ inProject: false, links: 2, remembered: 'coordinator' })).toEqual({ tabs: ['links'], tab: 'links' });
    expect(panelTabs({ inProject: false, links: 0 })).toEqual({ tabs: [], tab: null });
    expect(panelTabs({ inProject: true, links: 0, projectPage: true })).toEqual({ tabs: ['coordinator', 'links'], tab: 'coordinator' });
  });

  it('a project’s links, newest conversation first, each link once', () => {
    const groups = projectLinks([
      { id: 'a', lastActivityAt: 1, artifacts: [{ url: 'https://x/1', label: 'PR 1' }] },
      { id: 'b', lastActivityAt: 2, artifacts: [{ url: 'https://x/1', label: 'PR 1' }, { url: 'https://x/2', label: 'PR 2' }] },
      { id: 'c', lastActivityAt: 3, artifacts: [] },
    ]);
    expect(groups.map((g: { item: { id: string }; links: Array<{ url: string }> }) => [g.item.id, g.links.map((l) => l.url)])).toEqual([
      ['b', ['https://x/1', 'https://x/2']],
    ]);
  });
});

describe('coordinator store actions', () => {
  const summary = { projectId: 'desk', exists: true, watch: { on: false, stands: true, flags: true, digest: false }, reach: 'approve', status: null, flags: [], drafts: 0 };

  it('asking shows the question at once, sends it, and reads the thread', async () => {
    const calls: unknown[] = [];
    let view = { summary, threadId: 'c1', itemId: 'loom:c1', messages: [] as unknown[], running: true, drafts: [], digests: [], error: null };
    const store = createStore({
      mode: 'fixtures',
      coordinator: async (projectId: string, options: unknown) => (calls.push(['view', projectId, options]), view),
      coordinatorAsk: async (projectId: string, body: unknown) => {
        calls.push(['ask', projectId, body]);
        view = { ...view, messages: [{ id: 'q', kind: 'question', text: 'Status?', at: Date.now() }] };
        return { ok: true, threadId: 'c1' };
      },
    });
    const asking = store.askCoordinator('desk', ' Status? ', 'loom:a');
    expect(store.state.coordinator.pending.map((p: { text: string }) => p.text)).toEqual(['Status?']);
    await asking;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls[0]).toEqual(['ask', 'desk', { text: 'Status?', fromItemId: 'loom:a', commandId: expect.any(String) }]);
    expect(store.state.coordinator.pending).toEqual([]);
    expect(store.state.coordinator.view.messages).toHaveLength(1);
    expect(store.state.coordinators.desk).toEqual(summary);
  });

  it('a failed question stays to retry as the same command, or to drop', async () => {
    const ids: string[] = [];
    let fail = true;
    const store = createStore({
      mode: 'fixtures',
      coordinator: async () => ({ summary: null, messages: [], drafts: [], digests: [], running: false }),
      coordinatorAsk: async (_: string, body: { commandId: string }) => {
        ids.push(body.commandId);
        if (fail) throw Object.assign(new Error('x'), { body: { error: 'timed out' } });
        return { ok: true };
      },
    });
    await store.askCoordinator('desk', 'Status?');
    const [question] = store.state.coordinator.pending;
    expect(question).toMatchObject({ text: 'Status?', failed: 'timed out' });
    expect(store.state.toasts.map((t: { text: string }) => t.text)).toContain('The coordinator didn’t get that: timed out');
    fail = false;
    await store.retryQuestion('desk', question.commandId);
    expect(ids).toEqual([question.commandId, question.commandId]);
    store.dropQuestion('desk', question.commandId);
    expect(store.state.coordinator.pending).toEqual([]);
  });

  it('Keep watch changes at once and takes the server’s answer; a stream event updates the folder line', async () => {
    const store = createStore({ mode: 'fixtures', coordinatorWatch: async (_: string, patch: Record<string, unknown>) => ({ ...summary, watch: { ...summary.watch, ...patch } }) });
    const saving = store.setCoordinatorWatch('desk', { on: true });
    expect(store.state.coordinators.desk.watch.on).toBe(true);
    await saving;
    store.handlers.onCoordinator({ ...summary, watch: { ...summary.watch, on: true }, status: { text: 'Fine.', line: 'All fine.', at: 1, source: 'model' } });
    expect(store.state.coordinators.desk.status.line).toBe('All fine.');
  });
});
