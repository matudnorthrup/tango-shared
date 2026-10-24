// Wire subset checked against `codex app-server generate-ts`, codex-cli 0.163.0 (v2).
// Keep unknown fields open: app-server adds item variants without a protocol handshake bump.
export type Input = { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string };
export interface ThreadParams {
  cwd: string;
  approvalPolicy: "never" | "on-request";
  sandbox: "danger-full-access" | "read-only";
  developerInstructions?: string;
  model?: string;
  config?: Record<string, unknown>;
}
export interface TurnError {
  message?: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
  data?: unknown;
  resetAt?: number;
}
export interface Item {
  type: string;
  id: string;
  text?: string;
  command?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  changes?: unknown;
  query?: string;
  status?: string;
  aggregatedOutput?: string | null;
  result?: unknown;
  error?: unknown;
  exitCode?: number | null;
  /** subAgentActivity: started, interacted, interrupted or completed. */
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
}
export interface Turn { id: string; status: string; error?: TurnError | null }
export interface RateWindow { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }
export interface Notification {
  threadId?: string;
  turnId?: string;
  /** mcpServer/elicitation/request: the MCP server asking. */
  serverName?: string;
  item?: Item;
  delta?: string;
  turn?: Turn;
  error?: TurnError;
  willRetry?: boolean;
  rateLimits?: { primary?: RateWindow | null; secondary?: RateWindow | null; rateLimitReachedType?: string | null };
  tokenUsage?: { last: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; outputTokens: number }; modelContextWindow?: number | null };
}
export interface Requests {
  initialize: { params: { clientInfo: { name: string; version: string }; capabilities: null }; result: unknown };
  "config/read": { params: { cwd: string }; result: { config?: { developer_instructions?: string | null } } };
  "thread/start": { params: ThreadParams; result: { thread: { id: string } } };
  "thread/resume": { params: ThreadParams & { threadId: string }; result: { thread: { id: string } } };
  "turn/start": { params: { threadId: string; input: Input[] }; result: { turn: Turn } };
  "turn/steer": { params: { threadId: string; expectedTurnId: string; input: Input[] }; result: unknown };
  "turn/interrupt": { params: { threadId: string; turnId: string }; result: unknown };
}
export interface Envelope { id?: number | string; method?: string; params?: Notification; result?: unknown; error?: TurnError }
