import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TEXT_CHUNK_LIMIT = 4_000;
const ECHO_TTL_MS = 5_000;
const RESTART_DELAY_MS = 1_000;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface IMessageLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface IMessagePayload {
  id: number;
  chat_id: number;
  sender: string;
  is_from_me: boolean;
  text: string | null;
  chat_identifier?: string | null;
  is_group?: boolean;
  created_at?: string | null;
}

export interface IMessageInboundMessage {
  messageId: number;
  chatId: number;
  sender: string;
  displayName: string;
  content: string;
  channelKey: string;
  chatIdentifier: string | null;
  isGroup: boolean;
  createdAt: string | null;
  raw: IMessagePayload;
}

export interface IMessageRpcClientOptions {
  cliPath: string;
  logger?: IMessageLogger;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (error: Error) => void;
}

export interface IMessageListenerOptions {
  cliPath: string;
  contactsPath?: string;
  allowFrom?: string[];
  groupPolicy?: "mention" | "open" | "disabled";
  mentionNames?: string[];
  textChunkLimit?: number;
  logger?: IMessageLogger;
  onMessage: (message: IMessageInboundMessage) => Promise<void>;
}

function createDefaultLogger(): IMessageLogger {
  return {
    info(message: string): void {
      console.log(message);
    },
    warn(message: string): void {
      console.warn(message);
    },
    error(message: string): void {
      console.error(message);
    }
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildChatScope(chatId: number): string {
  return `chat:${chatId}`;
}

function normalizePhoneHandle(value: string): string {
  const digits = value.replace(/[^\d+]/g, "");
  if (!digits) return value;

  if (digits.startsWith("+")) {
    return `+${digits.slice(1).replace(/\D/g, "")}`;
  }

  const normalizedDigits = digits.replace(/\D/g, "");
  if (normalizedDigits.length === 10) {
    return `+1${normalizedDigits}`;
  }
  if (normalizedDigits.length === 11 && normalizedDigits.startsWith("1")) {
    return `+${normalizedDigits}`;
  }
  return normalizedDigits;
}

export function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("~/")) return trimmed;
  return path.join(os.homedir(), trimmed.slice(2));
}

export function normalizeIMessageHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withoutScheme = trimmed
    .replace(/^mailto:/iu, "")
    .replace(/^tel:/iu, "");
  const parts = withoutScheme.split(";").map((part) => part.trim()).filter(Boolean);
  const rawHandle = parts.length > 0 ? parts[parts.length - 1]! : withoutScheme;

  if (rawHandle.includes("@")) {
    return rawHandle.toLowerCase();
  }

  if (/^[+\d()[\]\s.-]+$/u.test(rawHandle)) {
    const prefixed = parts.length >= 2 && parts[1] === "+" && !rawHandle.startsWith("+")
      ? `+${rawHandle}`
      : rawHandle;
    return normalizePhoneHandle(prefixed);
  }

  return rawHandle;
}

function collectHandleValues(value: unknown, handles: string[]): void {
  if (typeof value === "string") {
    handles.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectHandleValues(item, handles);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  for (const key of ["value", "number", "phone", "address", "email", "handle"]) {
    if (key in record) {
      collectHandleValues(record[key], handles);
    }
  }
}

function resolveContactName(record: Record<string, unknown>): string | null {
  for (const key of ["displayName", "display_name", "name", "fullName", "full_name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const firstName =
    typeof record.firstName === "string"
      ? record.firstName.trim()
      : typeof record.first_name === "string"
        ? record.first_name.trim()
        : "";
  const lastName =
    typeof record.lastName === "string"
      ? record.lastName.trim()
      : typeof record.last_name === "string"
        ? record.last_name.trim()
        : "";
  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return combined.length > 0 ? combined : null;
}

function extractContactHandles(record: Record<string, unknown>): string[] {
  const rawHandles: string[] = [];
  for (const key of [
    "phone",
    "phones",
    "phoneNumber",
    "phoneNumbers",
    "mobile",
    "mobileNumbers",
    "numbers",
    "handles",
    "email",
    "emails",
    "emailAddresses"
  ]) {
    if (key in record) {
      collectHandleValues(record[key], rawHandles);
    }
  }

  const deduped = new Set<string>();
  for (const handle of rawHandles) {
    const normalized = normalizeIMessageHandle(handle);
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

function addContactRecord(
  contactMap: Map<string, string>,
  record: Record<string, unknown>
): void {
  const name = resolveContactName(record);
  if (!name) return;

  const handles = extractContactHandles(record);
  for (const handle of handles) {
    if (!contactMap.has(handle)) {
      contactMap.set(handle, name);
    }
  }
}

export function buildContactNameMap(document: unknown): Map<string, string> {
  const contacts = new Map<string, string>();

  if (Array.isArray(document)) {
    for (const entry of document) {
      const record = asRecord(entry);
      if (record) addContactRecord(contacts, record);
    }
    return contacts;
  }

  const record = asRecord(document);
  if (!record) return contacts;

  for (const collectionKey of ["contacts", "people", "items", "entries"]) {
    if (Array.isArray(record[collectionKey])) {
      for (const entry of record[collectionKey] as unknown[]) {
        const contact = asRecord(entry);
        if (contact) addContactRecord(contacts, contact);
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim().length > 0) {
      const normalizedHandle = normalizeIMessageHandle(key);
      if (normalizedHandle && !contacts.has(normalizedHandle)) {
        contacts.set(normalizedHandle, value.trim());
      }
      continue;
    }

    const entry = asRecord(value);
    if (entry) addContactRecord(contacts, entry);
  }

  return contacts;
}

export function mentionsAnyName(text: string, names: string[]): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  return names.some((name) => {
    const trimmedName = name.trim();
    if (!trimmedName) return false;
    return new RegExp(`\\b${escapeRegex(trimmedName)}\\b`, "iu").test(normalized);
  });
}

export function splitForIMessage(text: string, maxLength = DEFAULT_TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex < Math.floor(maxLength * 0.45)) {
      splitIndex = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitIndex < Math.floor(maxLength * 0.35)) {
      splitIndex = remaining.lastIndexOf(". ", maxLength);
      if (splitIndex >= 0) splitIndex += 1;
    }
    if (splitIndex < Math.floor(maxLength * 0.25)) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < 1) {
      splitIndex = maxLength;
    }

    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function loadContactsMap(contactsPath: string | undefined, logger: IMessageLogger): Map<string, string> {
  if (!contactsPath) return new Map();

  try {
    const resolvedPath = expandHomePath(contactsPath);
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const document = JSON.parse(raw) as unknown;
    return buildContactNameMap(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[tango-imessage] failed to load contacts: ${message}`);
    return new Map();
  }
}

function parseMessagePayload(params: unknown): IMessagePayload | null {
  const record = asRecord(params);
  if (!record) return null;

  const id = typeof record.id === "number" ? record.id : NaN;
  const chatId = typeof record.chat_id === "number" ? record.chat_id : NaN;
  const sender = typeof record.sender === "string" ? record.sender : "";
  const isFromMe = typeof record.is_from_me === "boolean" ? record.is_from_me : false;
  const text = typeof record.text === "string" ? record.text : null;
  const chatIdentifier =
    typeof record.chat_identifier === "string" ? record.chat_identifier : null;
  const isGroup = typeof record.is_group === "boolean" ? record.is_group : false;
  const createdAt = typeof record.created_at === "string" ? record.created_at : null;

  if (!Number.isFinite(id) || !Number.isFinite(chatId) || sender.trim().length === 0) {
    return null;
  }

  return {
    id,
    chat_id: chatId,
    sender,
    is_from_me: isFromMe,
    text,
    chat_identifier: chatIdentifier,
    is_group: isGroup,
    created_at: createdAt
  };
}

export class IMessageRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readline: Interface | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopping = false;
  private readonly logger: IMessageLogger;
  private readonly onNotification?: IMessageRpcClientOptions["onNotification"];
  private readonly onExit?: IMessageRpcClientOptions["onExit"];

  constructor(private readonly options: IMessageRpcClientOptions) {
    this.logger = options.logger ?? createDefaultLogger();
    this.onNotification = options.onNotification;
    this.onExit = options.onExit;
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;

    this.stopping = false;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.cliPath, ["rpc"], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let settled = false;

      const handleSpawn = (): void => {
        settled = true;
        this.child = child;
        this.readline = createInterface({ input: child.stdout });
        this.readline.on("line", (line) => {
          this.handleLine(line);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text.length > 0) {
            this.logger.warn(`[tango-imessage] ${text}`);
          }
        });
        child.on("exit", (code, signal) => {
          this.handleExit(code, signal);
        });
        child.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
            return;
          }
          this.handleExit(null, null, error);
        });
        resolve();
      };

      child.once("spawn", handleSpawn);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.rejectAllPending(new Error("iMessage RPC client stopped"));

    const child = this.child;
    if (!child) {
      this.readline?.close();
      this.readline = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        resolve();
      };

      child.once("exit", () => finish());
      child.stdin.end(() => {
        const timer = setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
          finish();
        }, 500);
        timer.unref();
      });
    });

    this.child = null;
    this.readline?.close();
    this.readline = null;
  }

  async request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    const child = this.child;
    if (!child || child.killed) {
      throw new Error("iMessage RPC client is not running");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params })
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`iMessage RPC request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });

      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[tango-imessage] failed to parse RPC line: ${message}`);
      return;
    }

    const response = asRecord(parsed);
    if (!response) return;

    if (typeof response.method === "string" && !("id" in response)) {
      this.onNotification?.(response.method, response.params);
      return;
    }

    const id = typeof response.id === "number" ? response.id : null;
    if (id === null) return;

    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(id);

    const errorPayload = asRecord(response.error);
    if (errorPayload) {
      const rpcError: JsonRpcError = {
        code: typeof errorPayload.code === "number" ? errorPayload.code : 0,
        message:
          typeof errorPayload.message === "string"
            ? errorPayload.message
            : "Unknown JSON-RPC error",
        data: errorPayload.data
      };
      pending.reject(new Error(`iMessage RPC ${rpcError.code}: ${rpcError.message}`));
      return;
    }

    pending.resolve(response.result);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    this.child = null;
    this.readline?.close();
    this.readline = null;

    const failure =
      error ??
      new Error(
        `iMessage RPC exited${code !== null ? ` code=${code}` : ""}${signal ? ` signal=${signal}` : ""}`
      );

    this.rejectAllPending(failure);

    if (!this.stopping) {
      this.onExit?.(failure);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export class IMessageListener {
  private readonly logger: IMessageLogger;
  private readonly client: IMessageRpcClient;
  private readonly echoCache = new Map<string, number>();
  private readonly allowFrom = new Set<string>();
  private readonly mentionNames: string[];
  private readonly groupPolicy: "mention" | "open" | "disabled";
  private readonly textChunkLimit: number;
  private contacts = new Map<string, string>();
  private desiredRunning = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: IMessageListenerOptions) {
    this.logger = options.logger ?? createDefaultLogger();
    this.groupPolicy = options.groupPolicy ?? "mention";
    this.textChunkLimit = options.textChunkLimit ?? DEFAULT_TEXT_CHUNK_LIMIT;
    this.mentionNames = [...new Set((options.mentionNames ?? []).map((name) => name.trim()).filter(Boolean))];
    for (const handle of options.allowFrom ?? []) {
      const normalized = normalizeIMessageHandle(handle);
      if (normalized) {
        this.allowFrom.add(normalized);
      }
    }

    this.client = new IMessageRpcClient({
      cliPath: options.cliPath,
      logger: this.logger,
      onNotification: (method, params) => {
        void this.handleNotification(method, params);
      },
      onExit: (error) => {
        this.logger.warn(`[tango-imessage] rpc exited: ${error.message}`);
        this.scheduleRestart();
      }
    });
  }

  async start(): Promise<void> {
    if (this.desiredRunning) return;

    this.desiredRunning = true;
    this.contacts = loadContactsMap(this.options.contactsPath, this.logger);
    try {
      await this.startClient();
    } catch (error) {
      this.desiredRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.client.isRunning()) return;

    try {
      await this.client.request("watch.unsubscribe", {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[tango-imessage] unsubscribe failed: ${message}`);
    }
    await this.client.stop();
  }

  async sendReply(chatId: number, text: string): Promise<number> {
    const normalized = text.trim().length > 0 ? text.trim() : "[empty response]";
    const chunks = splitForIMessage(normalized, this.textChunkLimit);
    for (const chunk of chunks) {
      this.rememberEcho(chunk, buildChatScope(chatId));
      await this.client.request("send", {
        chat_id: chatId,
        text: chunk
      });
    }
    return chunks.length;
  }

  async sendReplyToHandle(handle: string, text: string): Promise<number> {
    const normalized = text.trim().length > 0 ? text.trim() : "[empty response]";
    const chunks = splitForIMessage(normalized, this.textChunkLimit);
    const recipient = normalizeIMessageHandle(handle);
    for (const chunk of chunks) {
      await this.client.request("send", {
        handle: recipient,
        text: chunk
      });
    }
    return chunks.length;
  }

  private async startClient(): Promise<void> {
    await this.client.start();
    await this.client.request("watch.subscribe", {});
    this.logger.info("[tango-imessage] listener subscribed");
  }

  private scheduleRestart(): void {
    if (!this.desiredRunning || this.restartTimer) return;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desiredRunning) return;

      void this.startClient().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[tango-imessage] restart failed: ${message}`);
        this.scheduleRestart();
      });
    }, RESTART_DELAY_MS);
    this.restartTimer.unref();
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method !== "message") return;

    const payload = parseMessagePayload(params);
    if (!payload) {
      this.logger.warn("[tango-imessage] ignored malformed message notification");
      return;
    }

    await this.handleMessage(payload);
  }

  private async handleMessage(payload: IMessagePayload): Promise<void> {
    const content = payload.text?.trim() ?? "";
    if (!content) return;

    const sender = normalizeIMessageHandle(payload.sender);
    if (!sender) return;

    const chatScope = buildChatScope(payload.chat_id);
    if (payload.is_from_me) {
      return;
    }

    if (this.isEcho(content, chatScope)) {
      return;
    }

    if (this.allowFrom.size > 0 && !this.allowFrom.has(sender)) {
      this.logger.info(`[tango-imessage] ignored sender=${sender} reason=not-allowlisted`);
      return;
    }

    if (payload.is_group && !this.shouldHandleGroupMessage(content)) {
      return;
    }

    const channelKey = payload.is_group ? `imessage:group:${payload.chat_id}` : `imessage:${sender}`;
    await this.options.onMessage({
      messageId: payload.id,
      chatId: payload.chat_id,
      sender,
      displayName: this.resolveDisplayName(sender),
      content,
      channelKey,
      chatIdentifier: payload.chat_identifier ?? null,
      isGroup: payload.is_group === true,
      createdAt: payload.created_at ?? null,
      raw: payload
    });
  }

  private shouldHandleGroupMessage(text: string): boolean {
    if (this.groupPolicy === "open") return true;
    if (this.groupPolicy === "disabled") return false;
    return mentionsAnyName(text, this.mentionNames);
  }

  private rememberEcho(text: string, scope: string): void {
    this.pruneEchoCache();
    this.echoCache.set(`${scope}:${text}`, Date.now());
  }

  private isEcho(text: string, scope: string): boolean {
    this.pruneEchoCache();
    const key = `${scope}:${text}`;
    const cachedAt = this.echoCache.get(key);
    return typeof cachedAt === "number" && Date.now() - cachedAt <= ECHO_TTL_MS;
  }

  private pruneEchoCache(): void {
    const now = Date.now();
    for (const [key, createdAt] of this.echoCache.entries()) {
      if (now - createdAt > ECHO_TTL_MS) {
        this.echoCache.delete(key);
      }
    }
  }

  private resolveDisplayName(sender: string): string {
    return this.contacts.get(sender) ?? sender;
  }
}
