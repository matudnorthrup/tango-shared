import type { BackgroundTask, RuntimeEvent, RuntimeSession } from "./runtime.js";
import type { TurnImage } from "./attachments.js";
export const HOST_PROTOCOL = 1;
export const SUPPORTED_HOST_PROTOCOLS: ReadonlySet<number> = new Set([1]);
export type WireEvent = Exclude<RuntimeEvent, { type: "wake.started" }> | { type: "wake.started"; text: string; wakeId: string };
export interface HostHello {
  sessionProfileHash?: string;
  type: "hello";
  protocol: number;
  instanceId: string;
  release: string;
  upgradeClose?: boolean;
  startedAt?: number;
  background?: BackgroundTask[];
  threadId: string;
  pid: number;
  nativeSessionId: string | null;
  activeRunId: string | null;
  openRequests: { requestId: string; kind: "question" | "plan"; payload: unknown; runId: string }[];
  answeredRequests: string[];
  /** Steers this host handed to its harness, by steer id (the message id), so a retry is a no-op. */
  injectedSteers?: string[];
  answeredAnswers: Record<string, unknown>;
  lastSeq: number;
  ended?: boolean;
}
export type HostMessage = HostHello | { type: "replay.end" } | { type: "event"; seq: number; event: WireEvent } | { type: "result"; id: string; ok: boolean; tasks?: BackgroundTask[]; error?: string };
export type HostCommand = { type: "ack"; seq: number } | { type: "bindWake"; wakeId: string; runId: string } |
  ({ id: string } & ({ type: "startTurn"; run: Parameters<RuntimeSession["startTurn"]>[0] } | { type: "inject"; text: string; images?: TurnImage[]; steerId?: string } | { type: "interrupt" } | { type: "respond"; requestId: string; answer: unknown } | { type: "closeForUpgrade"; forceBackground: boolean } | { type: "close" }));
