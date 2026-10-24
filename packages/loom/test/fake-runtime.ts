import { closingHandoff } from "../src/handoff.js";
import type { LoomStore } from "../src/store.js";
import type { OpenSessionOptions, Runtime, RuntimeEvent, RuntimeSession } from "../src/runtime.js";

export class FakeSession implements RuntimeSession {
  turns: { runId: string; text: string; images?: { mimeType: string; data: string }[] }[] = [];
  answers: { requestId: string; answer: unknown }[] = [];
  interrupted = 0;
  closed = false;
  constructor(
    readonly options: OpenSessionOptions,
    readonly emit: (event: RuntimeEvent) => void,
    readonly store?: LoomStore,
  ) {}
  get currentRun(): string {
    return this.turns.at(-1)!.runId;
  }
  startTurn(run: { runId: string; text: string; images?: { mimeType: string; data: string }[] }): void {
    this.turns.push(run);
  }
  injected: string[] = [];
  injectedImages: ({ mimeType: string; data: string }[] | undefined)[] = [];
  inject(text: string, images?: { mimeType: string; data: string }[]): void {
    this.injectedImages.push(images);
    this.injected.push(text);
  }
  async interrupt(): Promise<void> {
    this.interrupted++;
    this.emit({ type: "turn.failed", runId: this.currentRun, failure: { kind: "interrupted", message: "stopped" } });
  }
  failRespond = false;
  respond(requestId: string, answer: unknown): void {
    if (this.failRespond) throw new Error("transport closed");
    this.answers.push({ requestId, answer });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** A cooperating fake model records its hand-off before finishing. Omission tests use completeWithoutHandoff. */
  complete(text = "done"): void {
    if (this.store && !this.store.db.prepare("SELECT 1 FROM turn_handoffs WHERE run_id=?").get(this.currentRun)) {
      const parsed = closingHandoff(text, true);
      const handoff = parsed ?? { owner: "none", text: "done" };
      const next = handoff.owner === "you" ? { kind: "human", who: "fixture-owner" }
        : handoff.owner === "me" ? { kind: "agent", who: `loom:${this.options.threadId}` }
        : handoff.owner === "waiting" ? { kind: "system", who: handoff.waitingOn ?? "CI" }
        : { kind: "nobody", who: "" };
      this.store.db.prepare("INSERT INTO turn_handoffs (run_id,thread_id,record) VALUES (?,?,?)").run(this.currentRun, this.options.threadId,
        JSON.stringify({ ...handoff, next, ...(handoff.owner === "you" ? { ask: { kind: /\bD-\d+\b/i.test(handoff.text) ? "pointer" : "do" } } : {}), source: "tool", runId: this.currentRun, at: this.store.now(), messageId: null }));
    }
    this.completeWithoutHandoff(text);
  }
  completeWithoutHandoff(text = "done"): void {
    const runId = this.currentRun;
    this.emit({ type: "message.completed", runId, text });
    this.emit({ type: "turn.completed", runId });
  }
}

export class FakeRuntime implements Runtime {
  constructor(readonly store?: LoomStore) {}
  sessions: FakeSession[] = [];
  failOpen: Error | null = null;
  async open(options: OpenSessionOptions, emit: (event: RuntimeEvent) => void): Promise<RuntimeSession> {
    if (this.failOpen) throw this.failOpen;
    const s = new FakeSession(options, emit, this.store);
    this.sessions.push(s);
    return s;
  }
  get last(): FakeSession {
    return this.sessions.at(-1)!;
  }
}
