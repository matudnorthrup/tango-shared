import type { SessionProfile } from "./session-profile.js";
import type { TurnImage } from "./attachments.js";
import type { ThreadRole } from "./store.js";
/**
 * The contract between Loom and a harness adapter (Claude Agent SDK, codex
 * app-server). An adapter owns one live harness process per open session and
 * reports what happens as RuntimeEvents. It never touches Loom's store.
 */

/** The text of a wake turn a message from another session started (a non-inline peer message): the host ties that message to the run. */
export const PEER_WAKE_TEXT = "A message from another session.";

export type FailureKind = "usage_limit" | "auth" | "overloaded" | "interrupted" | "crashed" | "other";

export interface RuntimeFailure {
  kind: FailureKind;
  message: string;
  /** When the account's limit resets, if the harness said. Epoch ms. */
  resetAt?: number;
}

export type RuntimeEvent =
  | { type: "worktree.promote"; runId: string }
  | { type: "tool.denied"; runId: string; itemId: string; name: string; source?: string }
  | { type: "host.heartbeat"; runId: string; at: number }
  /** The harness assigned or confirmed its own session id. */
  | { type: "session.native"; nativeSessionId: string }
  /** Streaming text. Published live, never stored. */
  | { type: "message.delta"; runId: string; text: string }
  | { type: "message.completed"; runId: string; text: string }
  | {
      type: "tool.updated";
      runId: string;
      itemId: string;
      name: string;
      input?: string;
      output?: string;
      status: "running" | "completed" | "failed";
    }
  | { type: "request.opened"; runId: string; requestId: string; kind: "question" | "plan"; payload: unknown }
  | { type: "turn.completed"; runId: string }
  | { type: "turn.failed"; runId: string; failure: RuntimeFailure }
  /**
   * The harness started a turn on its own, for example because a background
   * task finished while the thread was idle. Loom records it as a wake run;
   * the adapter keeps sending events with the returned run id.
   */
  | { type: "wake.started"; text: string; wakeId?: string; bind: (runId: string) => void }
  /**
   * The background work still running in the session (shells, subagents, workflows), replaced whole on
   * every change: a turn can end while it runs, and the harness wakes itself when it finishes.
   */
  | { type: "background.changed"; tasks: BackgroundTask[] }
  /** One main-chain model call: the context it carried (input + cache reads + cache writes) and its output. */
  | { type: "context.observed"; runId: string; context: number; cacheRead: number; cacheWrite: number; output: number; model?: string }
  /** The harness compacted the conversation (automatically past its window, or on /compact). */
  | { type: "context.compacted"; trigger: string; preTokens: number; postTokens?: number }
  /** A live rate-limit reading for the session's account. */
  | { type: "usage.observed"; status?: string; utilization?: number; resetsAt?: number; window?: string }
  /**
   * Another agent's conversation reached this one natively (Claude's SendMessage), or this one sent
   * such a message: read from the session's own transcript, since the harness never echoes it.
   */
  | { type: "peer.message"; direction: "in" | "out"; text: string; name?: string; address?: string; messageId: string; inline: boolean; at?: number }
  /** The harness process ended. Loom drops the session; the next run reopens it. */
  | { type: "session.ended"; failure?: RuntimeFailure };

export interface BackgroundTask {
  id: string;
  /** The harness's kind: local_bash, local_agent, monitor, workflow… */
  kind: string;
  description: string;
  /**
   * A watcher, not work (the harness's own word): it wakes the agent when what it watches changes, so the
   * agent isn't done, but it never holds an upgrade the way running work does.
   */
  ambient?: boolean;
}

/**
 * Whether a task left the set: one finished (work or a watcher), and the harness wakes the agent about it a
 * moment later, so that moment is no safe point yet.
 */
export function taskEnded(before: BackgroundTask[] | null | undefined, after: BackgroundTask[] | null | undefined): boolean {
  const now = new Set((after ?? []).map((task) => task.id));
  return (before ?? []).some((task) => !now.has(task.id));
}

/** Background work that holds a safe point: anything but watchers. */
export function holdsWork(tasks: BackgroundTask[] | null | undefined): boolean {
  return !!tasks?.some((task) => !task.ambient);
}

/** A command reached the session host but no answer came back: it may or may not have acted on it. */
export class HostOutcomeUnknown extends Error {}

export interface OpenSessionOptions {
  session?: SessionProfile;
  threadId: string;
  cwd: string;
  account: string | null;
  /** Resume this native session instead of starting a new one. */
  nativeSessionId: string | null;
  /** Who the thread works for: picks its instruction overlay (TGO-1024). */
  role?: ThreadRole;
  /** The thread's kind: only coding threads get the local edit guard (Tango agents and jobs own their checkout). */
  kind?: string;
  worktreeMode?: "auto" | "worktree" | "local";
}

export interface RuntimeSession {
  /** Remote hosts buffer replay until the coordinator has installed the session. */
  hello?: { nativeSessionId?: string | null; sessionProfileHash?: string; upgradeClose?: boolean; startedAt?: number; background?: BackgroundTask[]; release: string; instanceId: string; activeRunId?: string | null; ended?: boolean; answeredRequests?: string[]; answeredAnswers?: Record<string, unknown>; injectedSteers?: string[] };
  activate?(afterSeq: number): void | Promise<void>;
  acknowledge?(seq: number): void;
  detach?(): void;
  /** Start a turn. Only called when the thread has no turn in progress. */
  startTurn(run: { runId: string; text: string; images?: TurnImage[] }): void;
  /**
   * Hands words to the turn in progress: the harness reads them as soon as its current step finishes
   * (Claude: priority 'next'). Absent when the harness can't; the caller queues a run instead.
   */
  inject?(text: string, images?: TurnImage[], steerId?: string): void | Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, answer: unknown): void | Promise<void>;
  closeForUpgrade?(forceBackground: boolean): Promise<boolean | BackgroundTask[]>;
  close(): Promise<void>;
}

export type RuntimeEmit = (event: RuntimeEvent, seq?: number) => void;

export interface Runtime {
  open(options: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession>;
  /** Recovery only probes existing hosts; it must never start a replacement. */
  attach?(options: OpenSessionOptions, emit: RuntimeEmit): Promise<RuntimeSession | null>;
  discover?(): Promise<{ threadId: string }[]>;
  drainPending?(threadId: string, emit: RuntimeEmit, afterSeq: number, instanceId: string | null): Promise<void>;
}
