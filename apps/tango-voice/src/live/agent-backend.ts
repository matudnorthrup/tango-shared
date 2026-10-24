// Agents the live operator can delegate to, and the backend that runs them.
// Production would wrap the existing /voice/turn bridge; the lab uses
// SimulatedAgentBackend so timing can be controlled precisely.

export interface AgentDescriptor {
  id: string;
  name: string;
  aliases?: string[];
  role: string;
}

export type AgentUpdateKind = 'progress' | 'result' | 'question';

export interface AgentUpdate {
  kind: AgentUpdateKind;
  /** What the operator says (may be condensed for speech). */
  text: string;
  /** The agent's complete reply when `text` was condensed; used for read-back. */
  fullText?: string;
  /** Discord channel/thread and message ids where the reply was posted, when the backend knows. */
  channelId?: string;
  messageIds?: string[];
  /** The message the agent actually answered, when follow-ups queued behind a busy turn were merged into it. */
  asked?: string;
}

export interface AgentTaskRequest {
  taskId: string;
  agentId: string;
  message: string;
  /** 0 for the initial request, then 1, 2… for replies the user sends back. */
  turn: number;
  /** Discord thread to work in; omitted means the agent's home channel. */
  channelId?: string;
}

export interface AgentBackend {
  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void): void;
}

export interface TangoVoiceTurnBackendOptions {
  /** e.g. http://127.0.0.1:8787/voice/turn */
  endpoint: string;
  apiKey?: string;
  /** Session id per agent; reuse it across a task's turns so follow-ups keep context. */
  sessionIdFor?: (agentId: string) => string;
  channelIdFor?: (agentId: string) => string | undefined;
  /** Prepended to every request, e.g. a read-only guard for test runs. */
  preface?: string;
  /** Prepended when it returns text, e.g. "a screen is live" while one is connected. */
  hint?: () => string | undefined;
  /** Shortens long replies for speech (GPT-Live appends are capped at 500 tokens). */
  summarize?: (agentId: string, text: string, question?: string) => Promise<string>;
  timeoutMs?: number;
}

/**
 * Runs each delegated task as a normal Tango voice turn: the agent keeps its
 * tools and session, and the exchange is posted to its Discord channel. A reply
 * that ends in a question is surfaced as a question so the operator waits.
 */
export class TangoVoiceTurnBackend implements AgentBackend {
  constructor(private readonly options: TangoVoiceTurnBackendOptions) {}

  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void): void {
    void this.run(request).then(onUpdate, (err: Error) =>
      onUpdate(
        err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message)
          ? // We stopped waiting; the agent didn't stop working. Never resend this (it may have side effects).
            { kind: 'result', text: STILL_RUNNING_TEXT }
          : { kind: 'result', text: `I couldn't finish that: ${err.message}` },
      ),
    );
  }

  private async run(request: AgentTaskRequest): Promise<AgentUpdate> {
    const transcript = [this.options.preface, this.options.hint?.(), request.message].filter(Boolean).join('\n\n');
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        sessionId: this.options.sessionIdFor?.(request.agentId) ?? `live-operator-${request.agentId}`,
        agentId: request.agentId,
        transcript,
        channelId: request.channelId ?? this.options.channelIdFor?.(request.agentId),
        utteranceId: `${request.taskId}-${request.turn}-${Date.now()}`,
        discordUserId: 'live-operator',
      }),
    });
    if (!response.ok) throw new Error(`voice turn HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { responseText?: string; responseMessageIds?: string[]; postedChannelId?: string | null };
    const full = (body.responseText ?? '').trim() || 'Done.';
    // A question near the end (not just a trailing "?") means the agent is waiting on the user.
    const question = /\?/.test(full.slice(-240));
    const text = this.options.summarize && full.length > 600 ? await this.options.summarize(request.agentId, full, request.message) : full;
    return {
      kind: question ? 'question' : 'result',
      text,
      ...(text !== full ? { fullText: full } : {}),
      // Present once the bot reports where it posted the reply.
      ...(body.responseMessageIds?.length ? { messageIds: body.responseMessageIds } : {}),
      ...(body.postedChannelId ? { channelId: body.postedChannelId } : {}),
    };
  }
}

/** The bot's canned reply when a voice turn crashes (VOICE_V2_TTS_ERROR_MESSAGE). */
export const AGENT_TURN_FAILED_TEXT = "Sorry, I'm having trouble. Try again.";

/** What the operator relays when it stops waiting on a long turn that is still running bot-side. */
export const STILL_RUNNING_TEXT = "That's taking a while and is still running; the full reply will post in the conversation when it finishes.";

function isFailure(update: AgentUpdate): boolean {
  return update.text.trim() === AGENT_TURN_FAILED_TEXT || update.text.startsWith("I couldn't finish that:");
}

/**
 * Only a turn that certainly never ran is resent: the bot's canned crash reply, or a request
 * that never reached it. A timeout or an HTTP error after the turn started is not retried:
 * the agent may have acted already ("delete the extra copies" must not run twice).
 */
function isRetryable(update: AgentUpdate): boolean {
  return update.text.trim() === AGENT_TURN_FAILED_TEXT || /^I couldn't finish that: (fetch failed|.*ECONNREFUSED)/.test(update.text);
}

/**
 * One turn at a time per agent. A Tango agent session can't run two turns at
 * once (the second crashes and comes back as the canned "having trouble"), so
 * requests for a busy agent wait, and several waiting follow-ups for the same
 * task are merged into one message. A turn that never ran is retried once.
 */
export class SerializedAgentBackend implements AgentBackend {
  private busy = new Set<string>();
  private waiting = new Map<string, Array<{ request: AgentTaskRequest; onUpdate: (update: AgentUpdate) => void }>>();

  constructor(
    private readonly inner: AgentBackend,
    private readonly log: (event: string, data?: Record<string, unknown>) => void = () => {},
    private readonly retryDelayMs = 2000,
    /**
     * After a timeout the turn is still running bot-side: hold this conversation until the
     * probe says it's done (polled every `probeMs`, at most `holdMaxMs`), so nothing queued
     * runs concurrently. Without a probe, the hold lasts `holdMaxMs`.
     */
    private readonly hold: { stillRunning?: (conversation: string) => Promise<boolean>; probeMs?: number; holdMaxMs?: number } = {},
  ) {}

  /** The bot runs one turn per conversation: an agent's home channel and each thread are separate. */
  private key(request: AgentTaskRequest): string {
    return `${request.agentId}|${request.channelId ?? ''}`;
  }

  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void): void {
    const key = this.key(request);
    if (!this.busy.has(key)) {
      this.run(request, onUpdate, 0);
      return;
    }
    const queue = this.waiting.get(key) ?? [];
    const sameTask = queue.find((item) => item.request.taskId === request.taskId);
    if (sameTask) {
      sameTask.request = { ...sameTask.request, message: `${sameTask.request.message}\n\n${request.message}`, turn: request.turn };
      sameTask.onUpdate = onUpdate;
    } else {
      queue.push({ request, onUpdate });
    }
    this.waiting.set(key, queue);
    this.log('agent.waiting', { agent: request.agentId, taskId: request.taskId, queued: queue.length });
  }

  private run(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void, attempt: number): void {
    const key = this.key(request);
    this.busy.add(key);
    this.inner.send(request, (update) => {
      if (update.kind === 'progress') {
        onUpdate(update);
        return;
      }
      if (isRetryable(update) && attempt === 0) {
        this.log('agent.retry', { agent: request.agentId, taskId: request.taskId, reason: update.text });
        setTimeout(() => this.run(request, onUpdate, 1), this.retryDelayMs);
        return;
      }
      onUpdate(isFailure(update) ? { kind: 'result', text: 'I hit an error on that and could not finish it.' } : { ...update, asked: request.message });
      const release = () => {
        this.busy.delete(key);
        const next = this.waiting.get(key)?.shift();
        if (next) this.run(next.request, next.onUpdate, 0);
      };
      if (update.text === STILL_RUNNING_TEXT) this.holdUntilDone(key, release);
      else release();
    });
  }

  private holdUntilDone(key: string, release: () => void): void {
    const probeMs = this.hold.probeMs ?? 15_000;
    const deadline = Date.now() + (this.hold.holdMaxMs ?? 15 * 60_000);
    this.log('agent.hold', { key });
    const check = async () => {
      // An unanswered probe is not "done": keep holding until it answers or the cap runs out.
      const running = Date.now() < deadline && (this.hold.stillRunning ? await this.hold.stillRunning(key).catch(() => true) : true);
      if (running) setTimeout(() => void check(), probeMs);
      else release();
    };
    setTimeout(() => void check(), probeMs);
  }
}

export interface SimulatedStep extends AgentUpdate {
  /** Delay after the request (or after the previous step). */
  afterMs?: number;
  /** Hold the step until release(tag) is called. */
  releaseTag?: string;
}

export type SimulatedHandler = (request: AgentTaskRequest) => SimulatedStep[];

export interface SimulatedSendRecord {
  request: AgentTaskRequest;
  at: number;
}

export class SimulatedAgentBackend implements AgentBackend {
  readonly sends: SimulatedSendRecord[] = [];
  private waiting = new Map<string, () => void>();
  private released = new Set<string>();

  constructor(private readonly handlers: Record<string, SimulatedHandler>, private readonly now: () => number = Date.now) {}

  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void): void {
    this.sends.push({ request, at: this.now() });
    const handler = this.handlers[request.agentId];
    const steps = handler
      ? handler(request)
      : [{ kind: 'result' as const, text: `I don't have anything for "${request.message}".`, afterMs: 3000 }];
    void this.run(steps, onUpdate);
  }

  release(tag: string): void {
    this.released.add(tag);
    this.waiting.get(tag)?.();
    this.waiting.delete(tag);
  }

  private async run(steps: SimulatedStep[], onUpdate: (update: AgentUpdate) => void): Promise<void> {
    for (const step of steps) {
      if (step.afterMs) await new Promise((resolve) => setTimeout(resolve, step.afterMs));
      if (step.releaseTag && !this.released.has(step.releaseTag)) {
        await new Promise<void>((resolve) => this.waiting.set(step.releaseTag!, resolve));
      }
      onUpdate({
        kind: step.kind,
        text: step.text,
        ...(step.fullText ? { fullText: step.fullText } : {}),
        ...(step.messageIds ? { messageIds: step.messageIds, channelId: step.channelId } : {}),
      });
    }
  }
}
