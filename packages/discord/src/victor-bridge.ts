import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const VICTOR_SESSION_NAME = "VICTOR-COS";
const VICTOR_INBOX_DIR = "/tmp/victor-cos-inbox";
const VICTOR_OUTBOX_DIR = "/tmp/victor-cos-outbox";
const SESSION_CACHE_TTL_MS = 30_000;
const RESPONSE_POLL_INTERVAL_MS = 250;
export const VICTOR_BRIDGE_MODE_ENV = "VICTOR_BRIDGE_MODE";
export const VICTOR_BRIDGE_MANUAL_CONSOLE_MODE = "manual-console";

export interface VictorBridgeMessage {
  id: string;
  timestamp: string;
  source: "discord-text" | "discord-voice";
  user: { id: string; username: string } | null;
  channel: { id: string; threadId?: string };
  content: string;
  sessionId: string;
  agentId: string;
}

export interface VictorBridgeResponse {
  requestId: string;
  text: string;
  timestamp: string;
}

let cachedSessionActive = false;
let cachedSessionCheckedAt = 0;

const inboxFilesByRequestId = new Map<string, string>();

export interface VictorBridgeSessionCheckOptions {
  env?: NodeJS.ProcessEnv;
  exec?: (command: string) => void;
  now?: number;
  useCache?: boolean;
}

export function isVictorBridgeManualConsoleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeBridgeMode(env[VICTOR_BRIDGE_MODE_ENV]) === VICTOR_BRIDGE_MANUAL_CONSOLE_MODE;
}

export function isVictorManualConsoleBridgeActive(options: VictorBridgeSessionCheckOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (!isVictorBridgeManualConsoleEnabled(env)) {
    return false;
  }

  const now = options.now ?? Date.now();
  const useCache =
    options.useCache ?? (options.env === undefined && options.exec === undefined && options.now === undefined);
  if (useCache && now - cachedSessionCheckedAt < SESSION_CACHE_TTL_MS) {
    return cachedSessionActive;
  }

  try {
    const exec = options.exec ?? runTmuxHasSession;
    exec(`tmux has-session -t ${VICTOR_SESSION_NAME} 2>/dev/null`);
    cachedSessionActive = true;
  } catch {
    cachedSessionActive = false;
  }

  if (useCache) {
    cachedSessionCheckedAt = now;
  }
  return cachedSessionActive;
}

export function isVictorPersistentSessionActive(options: VictorBridgeSessionCheckOptions = {}): boolean {
  return isVictorManualConsoleBridgeActive(options);
}

function runTmuxHasSession(command: string): void {
  execSync(command, { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
}

function normalizeBridgeMode(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export async function sendToVictorInbox(message: VictorBridgeMessage): Promise<string> {
  await ensureDirectory(VICTOR_INBOX_DIR);

  const requestId = randomUUID();
  const filenameTimestamp = formatFilenameTimestamp(message.timestamp);
  const finalPath = path.join(VICTOR_INBOX_DIR, `${filenameTimestamp}-${requestId}.json`);
  const tempPath = `${finalPath}.tmp`;

  await fs.promises.writeFile(tempPath, `${JSON.stringify(message, null, 2)}\n`, "utf8");
  await fs.promises.rename(tempPath, finalPath);

  inboxFilesByRequestId.set(requestId, finalPath);
  return requestId;
}

export async function waitForVictorResponse(
  requestId: string,
  timeoutMs: number,
): Promise<VictorBridgeResponse> {
  await ensureDirectory(VICTOR_OUTBOX_DIR);

  const responsePath = path.join(VICTOR_OUTBOX_DIR, `${requestId}.json`);

  return await new Promise<VictorBridgeResponse>((resolve, reject) => {
    let settled = false;
    let reading = false;
    let watcher: fs.FSWatcher | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (watcher) {
        watcher.close();
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      handler();
    };

    const tryResolveResponse = async (): Promise<void> => {
      if (settled || reading) {
        return;
      }

      reading = true;
      try {
        const response = await readVictorResponse(responsePath);
        if (!response) {
          return;
        }

        if (response.requestId !== requestId) {
          throw new Error(
            `Victor bridge response requestId mismatch: expected '${requestId}', got '${response.requestId}'.`,
          );
        }

        await cleanupBridgeFiles(requestId, responsePath);
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      } finally {
        reading = false;
      }
    };

    try {
      watcher = fs.watch(VICTOR_OUTBOX_DIR, (_eventType, filename) => {
        if (!filename || filename === `${requestId}.json`) {
          void tryResolveResponse();
        }
      });
    } catch {
      watcher = undefined;
    }

    pollTimer = setInterval(() => {
      void tryResolveResponse();
    }, RESPONSE_POLL_INTERVAL_MS);

    timeoutTimer = setTimeout(() => {
      inboxFilesByRequestId.delete(requestId);
      finish(() => reject(new Error(`Timed out waiting for Victor response for request '${requestId}'.`)));
    }, timeoutMs);

    void tryResolveResponse();
  });
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readVictorResponse(responsePath: string): Promise<VictorBridgeResponse | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(responsePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (raw.trim().length === 0) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }

  const requestId = typeof parsed.requestId === "string" ? parsed.requestId.trim() : "";
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";

  if (!requestId) {
    throw new Error(`Victor bridge response at '${responsePath}' is missing requestId.`);
  }
  if (!timestamp) {
    throw new Error(`Victor bridge response at '${responsePath}' is missing timestamp.`);
  }

  return {
    requestId,
    text,
    timestamp,
  };
}

async function cleanupBridgeFiles(requestId: string, responsePath: string): Promise<void> {
  const inboxPath = inboxFilesByRequestId.get(requestId);
  inboxFilesByRequestId.delete(requestId);

  const deletions = [fs.promises.unlink(responsePath)];
  if (inboxPath) {
    deletions.push(fs.promises.unlink(inboxPath));
  }

  const results = await Promise.allSettled(deletions);
  for (const result of results) {
    if (result.status === "rejected" && !isMissingFileError(result.reason)) {
      throw result.reason;
    }
  }
}

function formatFilenameTimestamp(timestamp: string): string {
  const normalized = timestamp.trim().length > 0 ? timestamp : new Date().toISOString();
  return normalized.replace(/[:.]/g, "-");
}

function isMissingFileError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
