// Loom threads join Tango's memory system (docs/specs/loom-context-management.md, "Full unified memory"): after each
// completed run the desk extracts durable facts into Atlas, the same post-turn pass the Discord agents run, and files
// each new handoff the thread saved. Loom reads them back when a session starts fresh. Loom itself stays free of
// Tango packages; the desk already reads every Loom conversation and already calls the extraction model's service.
import { extractAndStoreMemories, type ChatProvider, type MemoryCaptureConfig } from '@tango/atlas-memory/capture';
import type { AtlasMemoryClient } from '@tango/atlas-memory/memory-client';
import { withMemoryOrigin } from '@tango/atlas-memory';

/** The agent id Loom threads' memories carry: kept apart from the Discord agents', found by thread. */
export const LOOM_MEMORY_AGENT = 'loom';

export interface LoomCaptureDetail {
  thread: { id: string; title: string | null; kind?: string; role?: string };
  runs: Array<{ id: string; status: string; source?: string; text?: string; ended_at: number | null }>;
  messages: Array<{ run_id?: string | null; role: 'user' | 'assistant'; text: string; origin?: string | null }>;
  /** The latest handoff the thread saved (loom.save_handoff); absent from an older Loom. */
  handoff?: { id?: string; body: string; created_at: number } | null;
}

export interface LoomMemoryStore {
  marker(key: string): string | null | undefined;
  setMarker(key: string, value: string): void;
}

/** What one exchange may send the extractor: the start of the ask and the end of the answer matter most. */
const MAX_PART = 6_000;
const clip = (text: string) => (text.length > MAX_PART ? `${text.slice(0, MAX_PART / 2)}\n…\n${text.slice(-MAX_PART / 2)}` : text);

export class LoomMemoryCapture {
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;

  constructor(private readonly options: {
    store: LoomMemoryStore;
    atlas: Pick<AtlasMemoryClient, 'memoryAdd'>;
    provider: ChatProvider;
    model: string;
    importanceThreshold?: number;
    concurrency?: number;
    log?: (line: string) => void;
  }) {}

  /**
   * Called on every ingest of a Loom conversation. Only runs that completed since the last capture are sent; the
   * first sight of a thread starts from now, so a deploy never backfills every thread's history.
   */
  capture(detail: LoomCaptureDetail): void {
    // Tango agents and jobs keep their own memory; every other Loom thread (kind 'coding') is captured.
    if (detail.thread.kind === 'tango-agent' || detail.thread.kind === 'tango-job' || detail.thread.kind === 'probe') return;
    const key = `loom-memory:${detail.thread.id}`;
    const seen = parse(this.options.store.marker(key));
    const completed = detail.runs.filter((run) => run.status === 'completed' && run.ended_at !== null);
    const latestRun = completed.at(-1)?.ended_at ?? 0;
    const latestHandoff = detail.handoff?.created_at ?? 0;
    if (!seen) {
      this.options.store.setMarker(key, JSON.stringify({ run: latestRun, handoff: latestHandoff }));
      return;
    }
    const fresh = completed.filter((run) => (run.ended_at ?? 0) > seen.run && run.source !== 'reset');
    const handoff = detail.handoff && latestHandoff > seen.handoff ? detail.handoff : null;
    if (!fresh.length && !handoff) return;
    this.options.store.setMarker(key, JSON.stringify({ run: Math.max(seen.run, latestRun), handoff: Math.max(seen.handoff, latestHandoff) }));
    for (const run of fresh) {
      const asked = detail.messages.filter((m) => m.run_id === run.id && m.role === 'user').map((m) => m.text).join('\n\n') || run.text || '';
      const answered = detail.messages.filter((m) => m.run_id === run.id && m.role === 'assistant').map((m) => m.text).join('\n\n');
      if (!answered.trim()) continue;
      this.enqueue(() => extractAndStoreMemories({
        conversationKey: `loom:${detail.thread.id}`,
        agentId: LOOM_MEMORY_AGENT,
        userMessage: clip(asked),
        agentResponse: clip(answered),
        channelId: 'loom',
        threadId: detail.thread.id,
        turnId: run.id,
        contextRef: `loom:${detail.thread.id}`,
        ...(detail.thread.title ? { contextLabel: detail.thread.title } : {}),
      }, this.config(), this.options.atlas as AtlasMemoryClient, this.options.provider));
    }
    if (handoff) {
      this.enqueue(async () => {
        await this.options.atlas.memoryAdd({
          content: `Handoff for "${detail.thread.title ?? detail.thread.id}":\n${handoff.body}`,
          source: 'conversation',
          agent_id: LOOM_MEMORY_AGENT,
          session_id: `loom:${detail.thread.id}`,
          importance: 0.8,
          tags: ['loom', 'handoff'],
          metadata: withMemoryOrigin({ captured_by: 'loom_handoff', conversation_key: `loom:${detail.thread.id}`, thread_id: detail.thread.id, channel_id: 'loom' }, { source: 'conversation', contextRef: `loom:${detail.thread.id}` }),
        });
      });
    }
  }

  private config(): MemoryCaptureConfig {
    return { enabled: true, extractionProvider: 'ollama', extractionModel: this.options.model, importanceThreshold: this.options.importanceThreshold ?? 0.5 };
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.running < (this.options.concurrency ?? 2) && this.queue.length) {
      const job = this.queue.shift()!;
      this.running += 1;
      void job()
        .catch((error) => this.options.log?.(`[loom-memory] ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.running -= 1; this.pump(); });
    }
  }

  /** Resolves once everything queued has run (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parse(raw: string | null | undefined): { run: number; handoff: number } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { run?: unknown; handoff?: unknown };
    return { run: Number(value.run) || 0, handoff: Number(value.handoff) || 0 };
  } catch {
    return null;
  }
}

/** The extraction model's service, OpenAI-compatible (Ollama Cloud), as the desk's summarizer already calls it. */
export function ollamaChatProvider(options: { apiKey: string; baseUrl?: string; timeoutMs?: number; resolveModel?: (model: string) => string }): ChatProvider {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return {
    async generate(request) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        // Resolved per call: a model role falls through to its next model when the primary is retired.
        body: JSON.stringify({ model: request.model && options.resolveModel ? options.resolveModel(request.model) : request.model, messages: [{ role: 'user', content: request.prompt }], stream: false }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      if (!response.ok) throw new Error(`extraction model returned ${response.status}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return { text: body.choices?.[0]?.message?.content ?? '' };
    },
  };
}
