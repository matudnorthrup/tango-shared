import { Agent, fetch as undiciFetch } from "undici";
import type {
  VoiceTurnInput,
  VoiceTurnResult
} from "./index.js";

export interface VoiceTurnClientOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (input: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: Error;
  }) => void;
}

export class VoiceTurnHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`Voice bridge HTTP ${status}: ${bodyText}`);
    this.name = "VoiceTurnHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Node's built-in fetch uses a roughly five-minute response-headers deadline.
// Voice turns can legitimately run longer, so requestVoiceTurn uses an explicit
// dispatcher with transport deadlines disabled. Caller-provided timeoutMs still
// cancels deliberately. Completions are short and keep the global fetch.
const UNBOUNDED_VOICE_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
});

const fetchVoiceRequest: typeof fetch = async (input, init) => {
  const requestInput = input instanceof Request ? input.url : input;
  return await undiciFetch(requestInput, {
    ...init,
    dispatcher: UNBOUNDED_VOICE_DISPATCHER,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
};

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableVoiceTurnError(error: unknown): boolean {
  if (error instanceof VoiceTurnHttpError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }

  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;

  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("eai_again")
  );
}

export function parseVoiceTurnResponse(payload: unknown): VoiceTurnResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("Voice bridge returned a non-object response.");
  }

  const body = payload as Record<string, unknown>;
  if (body.ok === false) {
    const message = optionalString(body.message);
    const code = optionalString(body.error) ?? "unknown-error";
    throw new Error(message ?? `Voice bridge returned ${code}.`);
  }

  const responseText = optionalString(body.responseText);
  if (!responseText) {
    throw new Error("Voice bridge response missing responseText.");
  }

  const providerName = optionalString(body.providerName);
  if (!providerName) {
    throw new Error("Voice bridge response missing providerName.");
  }

  const failureReason = optionalString(body.failureReason);
  return {
    turnId: optionalString(body.turnId),
    deduplicated: body.deduplicated === true,
    responseText,
    providerName,
    providerSessionId: optionalString(body.providerSessionId),
    warmStartUsed: body.warmStartUsed === true,
    providerUsedFailover: body.providerUsedFailover === true,
    ...(body.failed === true ? { failed: true, failureReason: failureReason ?? "error" } : {}),
    ...(Array.isArray(body.responseMessageIds)
      ? { responseMessageIds: body.responseMessageIds.filter((id): id is string => typeof id === "string") }
      : {}),
    ...("postedChannelId" in body
      ? { postedChannelId: optionalString(body.postedChannelId) ?? null }
      : {}),
    ...("transcriptMessageId" in body
      ? { transcriptMessageId: optionalString(body.transcriptMessageId) ?? null }
      : {}),
  };
}

function buildAuthHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  const normalizedApiKey = apiKey?.trim();
  if (normalizedApiKey) {
    headers.Authorization = `Bearer ${normalizedApiKey}`;
  }

  return headers;
}

function createRequestSignal(input: {
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (input.timeoutMs <= 0) {
    return {
      signal: input.externalSignal,
      cleanup: () => {}
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs);
  const signal = input.externalSignal
    ? AbortSignal.any([input.externalSignal, controller.signal])
    : controller.signal;

  return {
    signal,
    cleanup: () => clearTimeout(timeoutHandle)
  };
}

export async function requestVoiceTurn(
  input: VoiceTurnInput,
  options: VoiceTurnClientOptions
): Promise<VoiceTurnResult> {
  const endpoint = options.endpoint.trim();
  if (!endpoint) {
    throw new Error("Voice bridge endpoint is not configured.");
  }

  const maxRetries = Math.max(0, options.maxRetries ?? 0);
  const timeoutMs = options.timeoutMs != null && options.timeoutMs > 0
    ? Math.max(1000, options.timeoutMs)
    : 0; // 0 = no client-side deadline; explicit cancellation remains available
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 500);
  const fetchImpl = options.fetchImpl ?? fetchVoiceRequest;
  const headers = buildAuthHeaders(options.apiKey);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const requestSignal = createRequestSignal({ timeoutMs });

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: requestSignal.signal
      });

      const rawBody = await response.text();
      if (!response.ok) {
        throw new VoiceTurnHttpError(
          response.status,
          rawBody || response.statusText || "empty error body"
        );
      }

      const payload =
        rawBody.trim().length > 0 ? JSON.parse(rawBody) : {};

      return parseVoiceTurnResponse(payload);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      lastError = normalized;

      if (attempt >= maxRetries || !isRetryableVoiceTurnError(normalized)) {
        break;
      }

      const delayMs = retryBaseDelayMs * (attempt + 1);
      options.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: normalized
      });
      await delay(delayMs);
    } finally {
      requestSignal.cleanup();
    }
  }

  throw lastError ?? new Error("Unknown voice bridge failure.");
}
