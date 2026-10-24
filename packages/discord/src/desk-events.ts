import { randomUUID } from "node:crypto";
import {
  classifyClaudeCodeFailureText,
  ClaudeCodeTimeoutError,
  type RuntimeTurnEvent,
} from "@tango/core";

/**
 * Agent turn lifecycle reported to the Agent Desk (apps/screen,
 * `POST /api/desk/agent-events`, docs/specs/agent-desk.md "Agent turn events")
 * so Working, Failed and the live activity ticker are exact for Tango agents.
 *
 * Everything here is fire-and-forget: a short timeout, no retries, and no
 * error ever reaches the turn. `TANGO_DESK_EVENTS=off` turns it into a no-op.
 */

export type DeskTurnEventType = "turn.started" | "turn.activity" | "turn.finished" | "turn.failed";
export type DeskTurnFailureReason = "timeout" | "overloaded" | "usage-limit" | "auth" | "error";

export interface DeskTurnFailure {
  reason: DeskTurnFailureReason;
  message: string;
}

export interface DeskTurnIdentity {
  agentId: string;
  /** Canonical `thread:<id>` / `channel:<id>`, for text and voice turns alike. */
  conversationKey: string;
  channelId: string;
  threadId?: string;
}

export interface DeskConversationEvent {
  type: 'message.created' | 'conversation.updated';
  agentId: string;
  conversationKey: string;
  messageId: number;
  at: number;
}

export interface DeskAgentEvent extends DeskTurnIdentity {
  type: DeskTurnEventType;
  turnId: string;
  at: number;
  activity?: string;
  error?: DeskTurnFailure;
}

export const DESK_AGENT_EVENTS_PATH = "/api/desk/agent-events";
export const DEFAULT_DESK_URL = "http://127.0.0.1:9410";
export const DESK_EVENT_TIMEOUT_MS = 2_000;
export const DESK_ACTIVITY_MIN_INTERVAL_MS = 2_000;
const MAX_ERROR_MESSAGE_CHARS = 300;

export interface DeskEventsConfig {
  enabled: boolean;
  endpoint: string;
  token?: string;
}

export function resolveDeskEventsConfig(env: NodeJS.ProcessEnv = process.env): DeskEventsConfig {
  const base = (env.TANGO_DESK_URL?.trim() || env.TANGO_SCREEN_URL?.trim() || DEFAULT_DESK_URL).replace(/\/+$/u, "");
  const flag = env.TANGO_DESK_EVENTS?.trim().toLowerCase();
  const token = env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim();
  return {
    enabled: !(flag === "off" || flag === "0" || flag === "false"),
    endpoint: `${base}${DESK_AGENT_EVENTS_PATH}`,
    ...(token ? { token } : {}),
  };
}

/**
 * Map a turn error to the desk's failure reasons, using the same categories
 * as the Claude Code secondary-retry and degraded-mode chain.
 */
export function classifyDeskTurnFailure(error: unknown): DeskTurnFailure {
  const message = (error instanceof Error ? error.message : String(error ?? "")).trim() || "Turn failed.";
  const clipped = message.length > MAX_ERROR_MESSAGE_CHARS ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…` : message;
  if (error instanceof ClaudeCodeTimeoutError) return { reason: "timeout", message: clipped };
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { reason: "timeout", message: clipped };
  }
  const classified = classifyClaudeCodeFailureText(message);
  if (classified) return { reason: classified, message: clipped };
  if (/\btimed out\b|\btimeout\b/iu.test(message)) return { reason: "timeout", message: clipped };
  return { reason: "error", message: clipped };
}

/**
 * A runtime that returned an error response instead of throwing (Claude CLI
 * non-zero exit with parseable output): the turn failed even though some text
 * may have been posted.
 */
export function runtimeErrorResponseFailure(response: { text?: string; metadata?: Record<string, unknown> }): DeskTurnFailure | null {
  if (response.metadata?.error !== true) return null;
  const stderr = typeof response.metadata.stderr === "string" ? response.metadata.stderr : "";
  const detail = [response.text ?? "", stderr].filter((part) => part.trim()).join("\n");
  return classifyDeskTurnFailure(new Error(detail || "The agent runtime returned an error response."));
}

/** One turn's events. Terminal calls are idempotent; anything after a terminal event is dropped. */
export interface DeskTurnTracker {
  readonly turnId: string;
  /** Report a live activity line (throttled to one per 2 s, latest wins). */
  activity(line: string): void;
  /** Ready-made SendOptions.onEvent listener. */
  readonly onEvent: (event: RuntimeTurnEvent) => void;
  finish(): void;
  fail(error: unknown): void;
  /** Fail with an explicit reason (e.g. a canned error reply rather than a thrown error). */
  failWith(failure: DeskTurnFailure): void;
}

export interface DeskEventsClient {
  readonly enabled: boolean;
  post(event: DeskAgentEvent | DeskConversationEvent): void;
  startTurn(identity: DeskTurnIdentity, options?: { turnId?: string }): DeskTurnTracker;
}

export interface DeskEventsClientOptions extends Partial<DeskEventsConfig> {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  activityIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const NOOP_TRACKER_LISTENER = () => {};

/** A tracker that reports nothing (turns the desk must not see, e.g. isolated agents). */
export const NOOP_DESK_TURN: DeskTurnTracker = Object.freeze({
  turnId: "",
  activity: () => {},
  onEvent: NOOP_TRACKER_LISTENER,
  finish: () => {},
  fail: () => {},
  failWith: () => {},
});

export function createDeskEventsClient(options: DeskEventsClientOptions = {}): DeskEventsClient {
  const defaults = resolveDeskEventsConfig();
  const enabled = options.enabled ?? defaults.enabled;
  const endpoint = options.endpoint ?? defaults.endpoint;
  const token = options.token ?? defaults.token;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DESK_EVENT_TIMEOUT_MS;
  const activityIntervalMs = options.activityIntervalMs ?? DESK_ACTIVITY_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  // Log an unreachable desk once per outage, not once per event.
  let reportedFailure = false;

  function post(event: DeskAgentEvent | DeskConversationEvent): void {
    if (!enabled) return;
    try {
      void fetchFn(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Tango-Collaboration-Token": token } : {}),
        },
        body: JSON.stringify(event),
      }).then(
        (response) => {
          if (response.ok) {
            reportedFailure = false;
          } else if (!reportedFailure) {
            reportedFailure = true;
            log(`[desk-events] ${event.type} rejected: HTTP ${response.status}`);
          }
          void response.body?.cancel().catch(() => {});
        },
        (error: unknown) => {
          if (reportedFailure) return;
          reportedFailure = true;
          log(`[desk-events] desk unreachable at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    } catch {
      // Never let reporting reach the turn.
    }
  }

  function startTurn(identity: DeskTurnIdentity, startOptions: { turnId?: string } = {}): DeskTurnTracker {
    const turnId = startOptions.turnId ?? randomUUID();
    const base = {
      agentId: identity.agentId,
      conversationKey: identity.conversationKey,
      channelId: identity.channelId,
      ...(identity.threadId ? { threadId: identity.threadId } : {}),
      turnId,
    };
    let terminal = false;
    let lastActivityAt = Number.NEGATIVE_INFINITY;
    let lastSentLine: string | undefined;
    let pendingLine: string | undefined;
    let pendingTimer: NodeJS.Timeout | undefined;

    const sendActivity = (line: string) => {
      lastActivityAt = now();
      if (line === lastSentLine) return;
      lastSentLine = line;
      post({ ...base, type: "turn.activity", at: lastActivityAt, activity: line });
    };

    const clearPending = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = undefined;
      pendingLine = undefined;
    };

    const end = (type: "turn.finished" | "turn.failed", error?: DeskTurnFailure) => {
      if (terminal) return;
      terminal = true;
      clearPending();
      post({ ...base, type, at: now(), ...(error ? { error } : {}) });
    };

    const activity = (line: string) => {
      if (terminal || !enabled) return;
      const text = line.trim();
      if (!text) return;
      const waitMs = lastActivityAt + activityIntervalMs - now();
      if (waitMs <= 0 && !pendingTimer) {
        sendActivity(text);
        return;
      }
      // Inside the window: keep only the latest line and send it when the window opens.
      pendingLine = text;
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = undefined;
          const next = pendingLine;
          pendingLine = undefined;
          if (!terminal && next) sendActivity(next);
        }, Math.max(0, waitMs));
        pendingTimer.unref?.();
      }
    };

    post({ ...base, type: "turn.started", at: now() });

    return {
      turnId,
      activity,
      onEvent: enabled ? (event) => activity(event.activity) : NOOP_TRACKER_LISTENER,
      finish: () => end("turn.finished"),
      fail: (error) => end("turn.failed", classifyDeskTurnFailure(error)),
      failWith: (failure) => end("turn.failed", failure),
    };
  }

  return { enabled, post, startTurn };
}
