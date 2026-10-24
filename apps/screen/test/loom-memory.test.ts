import { describe, expect, it } from 'vitest';
import { LOOM_MEMORY_AGENT, LoomMemoryCapture, type LoomCaptureDetail } from '../server/desk/loom-memory.js';

function setup() {
  const markers = new Map<string, string>();
  const added: any[] = [];
  const prompts: string[] = [];
  const capture = new LoomMemoryCapture({
    store: { marker: (k) => markers.get(k) ?? null, setMarker: (k, v) => void markers.set(k, v) },
    atlas: { memoryAdd: async (input: any) => { added.push(input); return { id: String(added.length) } as any; } },
    provider: { generate: async ({ prompt }) => { prompts.push(prompt); return { text: JSON.stringify([{ content: 'The staging build listens on port 4100', importance: 0.9, tags: ['loom'] }]) }; } },
    model: 'test-model',
  });
  return { capture, added, prompts };
}

const detail = (runs: LoomCaptureDetail['runs'], extra: Partial<LoomCaptureDetail> = {}): LoomCaptureDetail => ({
  thread: { id: 't1', title: 'Context design', kind: 'coding' },
  runs,
  messages: runs.flatMap((run) => [{ run_id: run.id, role: 'user' as const, text: `ask ${run.id}` }, { run_id: run.id, role: 'assistant' as const, text: `answer ${run.id}` }]),
  ...extra,
});

describe('Loom memory capture', () => {
  it('starts from now on first sight, then extracts each newly completed run into Atlas as the loom agent', async () => {
    const { capture, added, prompts } = setup();
    capture.capture(detail([{ id: 'r1', status: 'completed', ended_at: 10 }]));
    await capture.idle();
    expect(prompts).toEqual([]);
    capture.capture(detail([{ id: 'r1', status: 'completed', ended_at: 10 }, { id: 'r2', status: 'completed', ended_at: 20 }, { id: 'r3', status: 'running', ended_at: null }]));
    await capture.idle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('User: ask r2');
    expect(prompts[0]).toContain('Agent: answer r2');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ agent_id: LOOM_MEMORY_AGENT, session_id: 'loom:t1', content: 'The staging build listens on port 4100' });
    expect(added[0].metadata).toMatchObject({ thread_id: 't1', turn_id: 'r2', captured_by: 'post_turn_extraction' });
    // The same detail again sends nothing.
    capture.capture(detail([{ id: 'r2', status: 'completed', ended_at: 20 }]));
    await capture.idle();
    expect(prompts).toHaveLength(1);
  });

  it("files a new handoff once and skips the handoff turn itself and other sources' threads", async () => {
    const { capture, added, prompts } = setup();
    capture.capture(detail([]));
    capture.capture(detail([{ id: 'r9', status: 'completed', source: 'reset', ended_at: 30 }], { handoff: { body: '### Where it stands\nPhase 3 built', created_at: 31 } }));
    capture.capture(detail([{ id: 'r9', status: 'completed', source: 'reset', ended_at: 30 }], { handoff: { body: '### Where it stands\nPhase 3 built', created_at: 31 } }));
    capture.capture({ ...detail([{ id: 'x', status: 'completed', ended_at: 99 }]), thread: { id: 'agent', title: null, kind: 'tango-agent' } });
    await capture.idle();
    expect(prompts).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ agent_id: LOOM_MEMORY_AGENT, tags: ['loom', 'handoff'] });
    expect(added[0].content).toContain('Phase 3 built');
    expect(added[0].metadata).toMatchObject({ thread_id: 't1', captured_by: 'loom_handoff' });
  });
});

it('does not extract memory or handoffs from probes', async () => {
  const { capture, prompts, added } = setup();
  for (const ended_at of [10, 20]) capture.capture(detail([{ id: 'probe-run', status: 'completed', ended_at }], { thread: { id: 'probe', title: null, kind: 'probe' }, handoff: { body: 'probe output', created_at: ended_at } }));
  await capture.idle();
  expect(prompts).toEqual([]); expect(added).toEqual([]);
});
