import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { VoiceTargetDirectory } from "./address-routing.js";
import { MobileVoiceTurns, parseMobileVoiceDispatchInput } from "./mobile-dispatch.js";

export * from "./address-routing.js";
export * from "./agent-address-book.js";
export * from "./mobile-dispatch.js";
export * from "./natural-routing.js";
export * from "./project-directory.js";
export * from "./project-routing.js";
export * from "./system-routing.js";
export * from "./topic-context.js";

export type VoiceTurnMessageTimestampSource =
  | "discord-sent"
  | "voice-captured"
  | "voice-finalized"
  | "db-write";

export interface VoiceTurnInput {
  sessionId: string;
  agentId: string;
  transcript: string;
  utteranceId?: string;
  guildId?: string;
  voiceChannelId?: string;
  channelId?: string;
  discordUserId?: string;
  messageTimestamp?: string;
  messageTimestampSource?: VoiceTurnMessageTimestampSource;
}

export interface VoiceTurnResult {
  /** Discord delivery IDs; absent on older servers. */
  responseMessageIds?: string[];
  /** First message if the transcript spans multiple Discord messages. */
  transcriptMessageId?: string | null;
  /** Resolved Discord destination, even if delivery failed. */
  postedChannelId?: string | null;
  turnId?: string;
  deduplicated?: boolean;
  responseText: string;
  providerName: string;
  providerSessionId?: string;
  warmStartUsed?: boolean;
  providerUsedFailover?: boolean;
  /**
   * The turn failed (router error or an empty reply). `responseText` still
   * carries the spoken fallback ("Sorry, I'm having trouble. Try again.") for
   * older clients; absent on success and on older servers.
   */
  failed?: boolean;
  /** Why it failed: "empty-reply", "timeout", "overloaded", "usage-limit", "auth" or "error". */
  failureReason?: string;
}

export interface VoiceTurnExecutor {
  executeTurn(input: VoiceTurnInput): Promise<VoiceTurnResult>;
}

export interface VoiceBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  onTranscript(input: VoiceTurnInput): Promise<VoiceTurnResult>;
}

export class StubVoiceBridge implements VoiceBridge {
  constructor(private readonly executor: VoiceTurnExecutor) {}

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async onTranscript(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    return this.executor.executeTurn(input);
  }
}

export interface HttpVoiceBridgeOptions {
  host?: string;
  port: number;
  path?: string;
  mobileDispatchPath?: string;
  apiKey?: string;
  defaultSessionId?: string;
  defaultAgentId?: string;
  maxBodyBytes?: number;
  voiceTargets?: VoiceTargetDirectory;
}

interface TurnRequestBody {
  sessionId?: unknown;
  agentId?: unknown;
  transcript?: unknown;
  utteranceId?: unknown;
  guildId?: unknown;
  voiceChannelId?: unknown;
  channelId?: unknown;
  discordUserId?: unknown;
  messageTimestamp?: unknown;
  messageTimestampSource?: unknown;
}

class VoiceInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceInputValidationError";
  }
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseMessageTimestampSource(value: unknown): VoiceTurnMessageTimestampSource | undefined {
  const source = trimString(value);
  if (!source) return undefined;
  if (
    source === "discord-sent" ||
    source === "voice-captured" ||
    source === "voice-finalized" ||
    source === "db-write"
  ) {
    return source;
  }
  throw new VoiceInputValidationError("Invalid field 'messageTimestampSource'.");
}

export function parseVoiceTurnInput(
  payload: unknown,
  defaults: { sessionId?: string; agentId?: string }
): VoiceTurnInput {
  if (!payload || typeof payload !== "object") {
    throw new VoiceInputValidationError("Request body must be a JSON object.");
  }

  const body = payload as TurnRequestBody;
  const sessionId = trimString(body.sessionId) ?? defaults.sessionId;
  const agentId = trimString(body.agentId) ?? defaults.agentId;
  const transcript = trimString(body.transcript);
  const utteranceId = trimString(body.utteranceId);
  const guildId = trimString(body.guildId);
  const voiceChannelId = trimString(body.voiceChannelId);
  const channelId = trimString(body.channelId);
  const discordUserId = trimString(body.discordUserId);
  const messageTimestamp = trimString(body.messageTimestamp);
  const messageTimestampSource = parseMessageTimestampSource(body.messageTimestampSource);

  if (!sessionId) {
    throw new VoiceInputValidationError("Missing required field 'sessionId'.");
  }
  if (!agentId) {
    throw new VoiceInputValidationError("Missing required field 'agentId'.");
  }
  if (!transcript) {
    throw new VoiceInputValidationError("Missing required field 'transcript'.");
  }

  return {
    sessionId,
    agentId,
    transcript,
    utteranceId,
    guildId,
    voiceChannelId,
    channelId,
    discordUserId,
    messageTimestamp,
    messageTimestampSource
  };
}

export function resolveVoiceApiKey(headers: IncomingHttpHeaders): string | undefined {
  const bearer = headers.authorization;
  if (typeof bearer === "string") {
    const normalized = bearer.trim();
    if (normalized.toLowerCase().startsWith("bearer ")) {
      const token = normalized.slice(7).trim();
      if (token.length > 0) return token;
    }
    if (normalized.length > 0) return normalized;
  }

  const headerValue = headers["x-tango-api-key"];
  if (typeof headerValue === "string") {
    const normalized = headerValue.trim();
    if (normalized.length > 0) return normalized;
  }
  if (Array.isArray(headerValue)) {
    for (const value of headerValue) {
      const normalized = value.trim();
      if (normalized.length > 0) return normalized;
    }
  }

  return undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export class HttpVoiceBridge implements VoiceBridge {
  private readonly mobileTurns = new MobileVoiceTurns((input) => this.onTranscript(input));
  private readonly host: string;
  private readonly path: string;
  private readonly mobileDispatchPath: string;
  private readonly apiKey?: string;
  private readonly defaultSessionId?: string;
  private readonly defaultAgentId?: string;
  private readonly maxBodyBytes: number;
  private readonly configuredVoiceTargets?: VoiceTargetDirectory;
  private lazyVoiceTargets: VoiceTargetDirectory | null = null;
  private server: Server | null = null;

  constructor(
    private readonly executor: VoiceTurnExecutor,
    private readonly options: HttpVoiceBridgeOptions
  ) {
    this.host = options.host?.trim() || "127.0.0.1";
    this.path = options.path?.trim() || "/voice/turn";
    this.mobileDispatchPath = options.mobileDispatchPath?.trim() || "/mobile/voice-dispatch";
    this.apiKey = options.apiKey?.trim() || undefined;
    this.defaultSessionId = options.defaultSessionId?.trim() || undefined;
    this.defaultAgentId = options.defaultAgentId?.trim() || undefined;
    this.maxBodyBytes = Math.max(options.maxBodyBytes ?? 1024 * 1024, 1024);
    this.configuredVoiceTargets = options.voiceTargets;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, {
          ok: false,
          error: "internal-error",
          message
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const current = this.server;
      if (!current) {
        reject(new Error("Voice bridge server initialization failed."));
        return;
      }

      current.once("error", reject);
      current.listen(this.options.port, this.host, () => {
        current.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.mobileTurns.stop();
    if (!this.server) return;

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async onTranscript(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    return this.executor.executeTurn(input);
  }

  private getVoiceTargets(): VoiceTargetDirectory {
    if (this.configuredVoiceTargets) return this.configuredVoiceTargets;
    this.lazyVoiceTargets ??= new VoiceTargetDirectory();
    return this.lazyVoiceTargets;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        status: "healthy"
      });
      return;
    }

    if (pathname === this.mobileDispatchPath) {
      if (method !== "POST") {
        response.setHeader("allow", "POST");
        sendJson(response, 405, {
          ok: false,
          error: "method-not-allowed"
        });
        return;
      }

      if (this.apiKey) {
        const provided = resolveVoiceApiKey(request.headers);
        if (!provided || provided !== this.apiKey) {
          sendJson(response, 401, {
            ok: false,
            error: "unauthorized"
          });
          return;
        }
      }

      let payload: unknown;
      try {
        const raw = await this.readRequestBody(request);
        payload = raw.length > 0 ? JSON.parse(raw) : {};
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, {
          ok: false,
          error: "invalid-json",
          message
        });
        return;
      }

      let mobileInput: ReturnType<typeof parseMobileVoiceDispatchInput>;
      try {
        mobileInput = parseMobileVoiceDispatchInput(payload, {
          defaults: {
            sessionId: this.defaultSessionId,
            agentId: this.defaultAgentId
          },
          voiceTargets: this.getVoiceTargets()
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, {
          ok: false,
          error: "invalid-input",
          message
        });
        return;
      }

      try {
        const dispatch = await this.mobileTurns.press(mobileInput);
        const turnInput = dispatch.input.turnInput;
        const result = dispatch.result;
        sendJson(response, 200, {
          ok: true,
          sessionId: turnInput.sessionId,
          agentId: turnInput.agentId,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          channelId: turnInput.channelId ?? null,
          discordUserId: turnInput.discordUserId ?? null,
          mobileDispatch: dispatch.input.route,
          ...(dispatch.turnTaking ? { turnTaking: dispatch.turnTaking } : {}),
          ...result
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, {
          ok: false,
          error: "dispatch-failed",
          message
        });
      }
      return;
    }

    if (pathname !== this.path) {
      sendJson(response, 404, {
        ok: false,
        error: "not-found"
      });
      return;
    }

    if (method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, {
        ok: false,
        error: "method-not-allowed"
      });
      return;
    }

    if (this.apiKey) {
      const provided = resolveVoiceApiKey(request.headers);
      if (!provided || provided !== this.apiKey) {
        sendJson(response, 401, {
          ok: false,
          error: "unauthorized"
        });
        return;
      }
    }

    let payload: unknown;
    try {
      const raw = await this.readRequestBody(request);
      payload = raw.length > 0 ? JSON.parse(raw) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, {
        ok: false,
        error: "invalid-json",
        message
      });
      return;
    }

    let turnInput: VoiceTurnInput;
    try {
      turnInput = parseVoiceTurnInput(payload, {
        sessionId: this.defaultSessionId,
        agentId: this.defaultAgentId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, {
        ok: false,
        error: "invalid-input",
        message
      });
      return;
    }

    try {
      const result = await this.onTranscript(turnInput);
      sendJson(response, 200, {
        ok: true,
        sessionId: turnInput.sessionId,
        agentId: turnInput.agentId,
        utteranceId: turnInput.utteranceId ?? null,
        guildId: turnInput.guildId ?? null,
        voiceChannelId: turnInput.voiceChannelId ?? null,
        channelId: turnInput.channelId ?? null,
        discordUserId: turnInput.discordUserId ?? null,
        ...result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, {
        ok: false,
        error: "turn-failed",
        message
      });
    }
  }

  private async readRequestBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > this.maxBodyBytes) {
        throw new Error(`Request body exceeds max size of ${this.maxBodyBytes} bytes.`);
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
  }
}

export * from "./channel-routing.js";
export * from "./client.js";
export * from "./assistant-format.js";
export * from "./agent-address-book.js";
export * from "./history-format.js";
export * from "./message-format.js";
export * from "./session-routing.js";
export * from "./tango-session-routing.js";
export * from "./topic-routing.js";
