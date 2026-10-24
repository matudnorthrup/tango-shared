/**
 * Piper / ops email tools — typed middleware over gog Gmail CLI.
 *
 * Spike 1a: hybrid email_thread_brief (metadata inline, full body on disk).
 * Spike 1a-search: email_inbox_scan, email_search.
 *
 * Account firewall: configured Piper Gmail account only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { readProfileConfigString, readProfileConfigStringList, type AgentTool } from "@tango/core";
import {
  decodeHtmlEntities,
  parseGogEmailFullOutput,
  stripHtmlToText,
} from "./reimbursement-automation.js";

const PIPER_ACCOUNT_CONFIG_PATH = "email/piper-account.txt";
const PIPER_FIREWALLED_ACCOUNTS_CONFIG_PATH = "email/piper-firewalled-accounts.txt";
const ATTACHMENT_BASE_DIR = "/tmp/tango-attachments";
const DEFAULT_GOG_COMMAND = "gog";
const ONE_LINER_MAX_CHARS = 140;

const DRIVE_LINK_PATTERNS = [
  /https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)(?:\/[^\s"'<>]*)?/gu,
  /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/[^\s"'<>]*)?/gu,
  /https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)(?:\/[^\s"'<>]*)?/gu,
  /https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)(?:\/[^\s"'<>]*)?/gu,
  /https:\/\/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/gu,
];

export interface EmailAgentToolOptions {
  gogCommand?: string;
  defaultAccount?: string;
  firewalledAccounts?: string[];
  runGog?: GogRunner;
}

export interface GogRunner {
  (args: string[], timeoutMs?: number): Promise<string>;
}

export interface ThreadTimelineEntry {
  message_id: string;
  from: string;
  date: string;
  one_liner: string;
}

export interface ThreadAttachmentMeta {
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  attachment_id: string | null;
  needs_extraction: boolean;
}

export interface DriveLinkMeta {
  url: string;
  kind: "document" | "spreadsheet" | "presentation" | "drive_file";
  file_id: string;
}

export interface ThreadBriefResult {
  thread_id: string;
  account: string;
  subject: string;
  participants: string[];
  timeline: ThreadTimelineEntry[];
  latest: {
    message_id: string;
    from: string;
    date: string;
  };
  attachments: ThreadAttachmentMeta[];
  drive_links: DriveLinkMeta[];
  latest_body_path: string;
}

export interface ThreadCard {
  thread_id: string;
  message_id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

interface ParsedThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  bodyFormat: "html" | "text";
  attachments: ThreadAttachmentMeta[];
}

interface SessionFileRegistration {
  sessionId: string;
  localPath: string;
  contentType: string;
  label: string;
}

function loadConfiguredPiperAccount(defaultAccount?: string): string | undefined {
  return defaultAccount?.trim()
    || readProfileConfigString({
      relativePath: PIPER_ACCOUNT_CONFIG_PATH,
      envPathVar: "TANGO_PIPER_GMAIL_ACCOUNT_FILE",
      envValueVar: "PIPER_GMAIL_ACCOUNT",
    })
    || process.env.TANGO_EMAIL_ACCOUNT?.trim()
    || undefined;
}

function loadFirewalledGmailAccounts(extraAccounts: string[] = []): Set<string> {
  return new Set([
    ...extraAccounts,
    ...readProfileConfigStringList({
      relativePath: PIPER_FIREWALLED_ACCOUNTS_CONFIG_PATH,
      envPathVar: "TANGO_PIPER_FIREWALLED_GMAIL_ACCOUNTS_FILE",
      envValueVar: "TANGO_PIPER_FIREWALLED_GMAIL_ACCOUNTS",
      lowercase: true,
    }),
  ].map((account) => account.trim().toLowerCase()).filter(Boolean));
}

export function resolveEmailAccount(
  override?: string | null,
  options: Pick<EmailAgentToolOptions, "defaultAccount" | "firewalledAccounts"> = {},
): string {
  const allowedAccount = loadConfiguredPiperAccount(options.defaultAccount);
  if (!allowedAccount) {
    throw new Error(
      `Piper email account is not configured. Set PIPER_GMAIL_ACCOUNT or profile config ${PIPER_ACCOUNT_CONFIG_PATH}.`,
    );
  }
  const normalizedAllowed = allowedAccount.toLowerCase();
  const firewalledAccounts = loadFirewalledGmailAccounts(options.firewalledAccounts);
  if (firewalledAccounts.has(normalizedAllowed)) {
    throw new Error("Configured Piper Gmail account is firewalled.");
  }

  const candidate = override?.trim() || allowedAccount;
  const normalized = candidate.toLowerCase();
  if (firewalledAccounts.has(normalized)) {
    throw new Error("Gmail account is firewalled for Piper email tools.");
  }
  if (normalized !== normalizedAllowed) {
    throw new Error("Piper email tools only support the configured Piper Gmail account.");
  }
  return allowedAccount;
}

export function registerSessionFile(_entry: SessionFileRegistration): void {
  // Phase 3 session attachment registry — wire when API lands.
}

export function extractDriveLinks(text: string): DriveLinkMeta[] {
  const links: DriveLinkMeta[] = [];
  const seen = new Set<string>();

  for (const pattern of DRIVE_LINK_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const url = match[0]?.trim();
      const fileId = match[1]?.trim();
      if (!url || !fileId || seen.has(url)) {
        continue;
      }
      seen.add(url);
      links.push({
        url,
        file_id: fileId,
        kind: inferDriveLinkKind(url),
      });
    }
  }

  return links;
}

export function buildTimelineOneLiner(body: string, bodyFormat: "html" | "text" = "text"): string {
  const plain = bodyFormat === "html"
    ? stripHtmlToText(body)
    : decodeHtmlEntities(body.replace(/\s+/gu, " ").trim());
  const collapsed = plain.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= ONE_LINER_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, ONE_LINER_MAX_CHARS - 1).trim()}…`;
}

export function parseGogThreadJson(raw: string): ParsedThreadMessage[] {
  const parsed = JSON.parse(raw) as unknown;
  const container = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const messagesRaw =
    Array.isArray(container.messages) ? container.messages
    : Array.isArray(container.thread) ? container.thread
    : Array.isArray(parsed) ? parsed
    : container.thread && typeof container.thread === "object"
      ? (container.thread as Record<string, unknown>).messages
      : null;

  if (!Array.isArray(messagesRaw)) {
    throw new Error("Unexpected gog thread JSON shape: missing messages array");
  }

  return messagesRaw
    .map((entry) => normalizeThreadMessage(entry))
    .filter((message): message is ParsedThreadMessage => message != null)
    .sort((a, b) => messageSortTimestamp(a, findRawMessageEntry(messagesRaw, a.id))
      - messageSortTimestamp(b, findRawMessageEntry(messagesRaw, b.id)));
}

export function buildThreadBrief(input: {
  threadId: string;
  account: string;
  messages: ParsedThreadMessage[];
  sessionId: string;
  writeBody?: (targetPath: string, body: string) => void;
}): ThreadBriefResult {
  if (input.messages.length === 0) {
    throw new Error(`Thread ${input.threadId} has no messages`);
  }

  const latest = input.messages[input.messages.length - 1]!;
  const subject = latest.subject || input.messages.find((message) => message.subject)?.subject || "(no subject)";
  const participants = collectParticipants(input.messages);
  const latestPlain = latest.bodyFormat === "html"
    ? stripHtmlToText(latest.body)
    : decodeHtmlEntities(latest.body.trim());

  const sessionDir = path.join(ATTACHMENT_BASE_DIR, sanitizeSessionId(input.sessionId));
  fs.mkdirSync(sessionDir, { recursive: true });
  const latestBodyPath = path.join(sessionDir, `thread-${sanitizeThreadId(input.threadId)}-latest.txt`);
  const writeBody = input.writeBody ?? ((targetPath, body) => {
    fs.writeFileSync(targetPath, body, "utf8");
  });
  writeBody(latestBodyPath, latestPlain);

  registerSessionFile({
    sessionId: input.sessionId,
    localPath: latestBodyPath,
    contentType: "text/plain",
    label: `email-thread-${input.threadId}-latest`,
  });

  const combinedText = input.messages.map((message) => message.body).join("\n");
  const attachments = dedupeAttachments(input.messages.flatMap((message) => message.attachments));
  const driveLinks = extractDriveLinks(combinedText);

  return {
    thread_id: input.threadId,
    account: input.account,
    subject,
    participants,
    timeline: input.messages.map((message) => ({
      message_id: message.id,
      from: message.from,
      date: message.date,
      one_liner: buildTimelineOneLiner(message.body, message.bodyFormat),
    })),
    latest: {
      message_id: latest.id,
      from: latest.from,
      date: latest.date,
    },
    attachments,
    drive_links: driveLinks,
    latest_body_path: latestBodyPath,
  };
}

export function parseGogSearchJson(raw: string): ThreadCard[] {
  const parsed = JSON.parse(raw) as unknown;
  const container = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const rows =
    Array.isArray(container.messages) ? container.messages
    : Array.isArray(container.threads) ? container.threads
    : Array.isArray(container.results) ? container.results
    : Array.isArray(parsed) ? parsed
    : [];

  return rows
    .map((entry) => normalizeThreadCard(entry))
    .filter((card): card is ThreadCard => card != null);
}

function defaultGogRunner(gogCommand: string): GogRunner {
  return (args, timeoutMs = 60_000) => runGogCommand(gogCommand, args, timeoutMs);
}

const EMAIL_ADDRESS_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Error surfaces (Discord replies, eval transcripts, logs) must never echo
 *  mailbox addresses — the configured and firewalled accounts are profile-layer
 *  denylisted values. Tool RESULTS keep real addresses; only errors redact. */
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_ADDRESS_PATTERN, "[redacted-email]");
}

function runGogCommand(gogCommand: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(gogCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(redactEmailAddresses(`${gogCommand} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`)));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end();
  });
}

function inferDriveLinkKind(url: string): DriveLinkMeta["kind"] {
  if (url.includes("/document/")) return "document";
  if (url.includes("/spreadsheets/")) return "spreadsheet";
  if (url.includes("/presentation/")) return "presentation";
  return "drive_file";
}

function sanitizeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "email-session";
}

function sanitizeThreadId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

function collectParticipants(messages: ParsedThreadMessage[]): string[] {
  const participants = new Set<string>();
  for (const message of messages) {
    if (message.from) participants.add(message.from);
    if (message.to) {
      for (const recipient of splitAddressList(message.to)) {
        participants.add(recipient);
      }
    }
  }
  return [...participants];
}

function splitAddressList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function dedupeAttachments(attachments: ThreadAttachmentMeta[]): ThreadAttachmentMeta[] {
  const byKey = new Map<string, ThreadAttachmentMeta>();
  for (const attachment of attachments) {
    const key = attachment.attachment_id || `${attachment.filename}:${attachment.mime_type ?? "unknown"}`;
    if (!byKey.has(key)) {
      byKey.set(key, attachment);
    }
  }
  return [...byKey.values()];
}

function normalizeThreadCard(entry: unknown): ThreadCard | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const threadId = stringField(record, ["threadId", "thread_id", "id"]);
  const messageId = stringField(record, ["messageId", "message_id", "latestMessageId", "id"]);
  if (!threadId || !messageId) {
    return null;
  }
  const subject = stringField(record, ["subject", "Subject"]) ?? "(no subject)";
  const from = stringField(record, ["from", "From"]) ?? "";
  const date = stringField(record, ["date", "internalDate", "internal_date"]) ?? "";
  const snippet = stringField(record, ["snippet", "summary", "one_liner"]) ?? buildTimelineOneLiner(
    stringField(record, ["body", "text", "plainBody"]) ?? subject,
    "text",
  );
  return {
    thread_id: threadId,
    message_id: messageId,
    from,
    subject,
    date,
    snippet,
  };
}

function findRawMessageEntry(messagesRaw: unknown[], messageId: string): unknown {
  for (const entry of messagesRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (stringField(record, ["id", "messageId", "message_id"]) === messageId) {
      return entry;
    }
  }
  return null;
}

function messageSortTimestamp(message: ParsedThreadMessage, rawEntry: unknown): number {
  if (rawEntry && typeof rawEntry === "object") {
    const internalDate = stringField(rawEntry as Record<string, unknown>, ["internalDate", "internal_date"]);
    if (internalDate && /^\d+$/u.test(internalDate)) {
      return Number(internalDate);
    }
  }
  const parsed = Date.parse(message.date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeThreadMessage(entry: unknown): ParsedThreadMessage | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = stringField(record, ["id", "messageId", "message_id"]);
  if (!id) {
    return null;
  }

  if (record.payload && typeof record.payload === "object") {
    return normalizeGmailApiMessage(record, id);
  }

  const rawBody =
    stringField(record, ["body", "plainBody", "textBody", "sanitizedBody", "snippet"])
    ?? "";
  const bodyFormat = /<(?:!doctype|html|body|table|div|p|span)\b/iu.test(rawBody) ? "html" : "text";

  return {
    id,
    from: stringField(record, ["from", "From"]) ?? "",
    to: stringField(record, ["to", "To"]) ?? "",
    subject: stringField(record, ["subject", "Subject"]) ?? "",
    date: formatEmailDate(stringField(record, ["date", "internalDate", "internal_date"])),
    body: rawBody,
    bodyFormat,
    attachments: normalizeAttachments(record.attachments ?? record.Attachments),
  };
}

function normalizeGmailApiMessage(record: Record<string, unknown>, id: string): ParsedThreadMessage {
  const headers = extractGmailHeaders(record.payload);
  const extracted = extractGmailBody(record.payload);
  return {
    id,
    from: headers.from ?? "",
    to: headers.to ?? "",
    subject: headers.subject ?? "",
    date: formatEmailDate(headers.date ?? stringField(record, ["internalDate", "internal_date"])),
    body: extracted.body,
    bodyFormat: extracted.bodyFormat,
    attachments: extractGmailAttachments(record.payload),
  };
}

function extractGmailHeaders(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const headersRaw = (payload as Record<string, unknown>).headers;
  if (!Array.isArray(headersRaw)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const entry of headersRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const header = entry as Record<string, unknown>;
    const name = stringField(header, ["name"]);
    const value = stringField(header, ["value"]);
    if (name && value) {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

function decodeGmailBodyData(data: string): string {
  const normalized = data.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function extractGmailBody(payload: unknown): { body: string; bodyFormat: "html" | "text" } {
  if (!payload || typeof payload !== "object") {
    return { body: "", bodyFormat: "text" };
  }

  const record = payload as Record<string, unknown>;
  const mimeType = stringField(record, ["mimeType"]) ?? "";
  const parts = Array.isArray(record.parts) ? record.parts : [];
  let plain = "";
  let html = "";

  const walkPart = (part: unknown): void => {
    if (!part || typeof part !== "object") {
      return;
    }
    const partRecord = part as Record<string, unknown>;
    const nestedParts = Array.isArray(partRecord.parts) ? partRecord.parts : [];
    if (nestedParts.length > 0) {
      for (const nested of nestedParts) {
        walkPart(nested);
      }
      return;
    }

    const partMime = stringField(partRecord, ["mimeType"]) ?? "";
    const data = stringField((partRecord.body as Record<string, unknown> | undefined) ?? {}, ["data"]);
    if (!data) {
      return;
    }

    const decoded = decodeGmailBodyData(data);
    if (partMime === "text/plain" && !plain) {
      plain = decoded;
    } else if (partMime === "text/html" && !html) {
      html = decoded;
    }
  };

  if (parts.length > 0) {
    for (const part of parts) {
      walkPart(part);
    }
    if (plain) {
      return { body: plain, bodyFormat: "text" };
    }
    if (html) {
      return { body: html, bodyFormat: "html" };
    }
  }

  const directData = stringField((record.body as Record<string, unknown> | undefined) ?? {}, ["data"]);
  if (directData) {
    const decoded = decodeGmailBodyData(directData);
    const bodyFormat = /html/iu.test(mimeType) || /<(?:!doctype|html|body|table|div|p|span)\b/iu.test(decoded)
      ? "html"
      : "text";
    return { body: decoded, bodyFormat };
  }

  return { body: "", bodyFormat: "text" };
}

function extractGmailAttachments(payload: unknown): ThreadAttachmentMeta[] {
  const attachments: ThreadAttachmentMeta[] = [];

  const walkPart = (part: unknown): void => {
    if (!part || typeof part !== "object") {
      return;
    }
    const partRecord = part as Record<string, unknown>;
    const filename = stringField(partRecord, ["filename"]);
    const mimeType = stringField(partRecord, ["mimeType"]);
    const body = partRecord.body;
    const attachmentId = body && typeof body === "object"
      ? stringField(body as Record<string, unknown>, ["attachmentId", "attachment_id"])
      : null;
    const size = body && typeof body === "object"
      ? numberField(body as Record<string, unknown>, ["size", "sizeBytes", "size_bytes"])
      : null;

    if (filename && attachmentId) {
      const needsExtraction = !mimeType?.startsWith("text/") && mimeType !== "message/rfc822";
      attachments.push({
        filename,
        mime_type: mimeType,
        size_bytes: size,
        attachment_id: attachmentId,
        needs_extraction: needsExtraction,
      });
    }

    const nestedParts = Array.isArray(partRecord.parts) ? partRecord.parts : [];
    for (const nested of nestedParts) {
      walkPart(nested);
    }
  };

  walkPart(payload);
  return attachments;
}

function formatEmailDate(raw: string | null): string {
  if (!raw) {
    return "";
  }
  if (/^\d{13}$/u.test(raw)) {
    const parsed = new Date(Number(raw));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().replace("T", " ").slice(0, 16);
    }
  }
  return raw.trim();
}

function normalizeAttachments(value: unknown): ThreadAttachmentMeta[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const filename = stringField(record, ["filename", "name", "fileName"]) ?? "attachment";
      const mimeType = stringField(record, ["mimeType", "contentType", "mime_type"]);
      const size = numberField(record, ["size", "sizeBytes", "size_bytes"]);
      const attachmentId = stringField(record, ["id", "attachmentId", "attachment_id"]);
      const needsExtraction = !mimeType?.startsWith("text/") && mimeType !== "message/rfc822";
      return {
        filename,
        mime_type: mimeType,
        size_bytes: size,
        attachment_id: attachmentId,
        needs_extraction: needsExtraction,
      } satisfies ThreadAttachmentMeta;
    })
    .filter((attachment): attachment is ThreadAttachmentMeta => attachment != null);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

async function fetchThreadMessages(
  runGog: GogRunner,
  threadId: string,
  account: string,
): Promise<ParsedThreadMessage[]> {
  const stdout = await runGog([
    "gmail",
    "thread",
    "get",
    threadId,
    "--account",
    account,
    "--full",
    "--json",
  ]);
  return parseGogThreadJson(stdout);
}

async function searchMessages(
  runGog: GogRunner,
  query: string,
  account: string,
  max: number,
): Promise<ThreadCard[]> {
  const stdout = await runGog([
    "gmail",
    "messages",
    "search",
    query,
    "--account",
    account,
    "--max",
    String(max),
    "--json",
  ]);
  return parseGogSearchJson(stdout);
}

function ensureArchiveScope(query: string): string {
  const normalized = query.trim();
  if (/\bin:anywhere\b/iu.test(normalized)) {
    return normalized;
  }
  return `${normalized} in:anywhere`.trim();
}

export function createEmailAgentTools(options: EmailAgentToolOptions = {}): AgentTool[] {
  const gogCommand = options.gogCommand ?? DEFAULT_GOG_COMMAND;
  const runGog = options.runGog ?? defaultGogRunner(gogCommand);
  const accountOptions = {
    defaultAccount: options.defaultAccount,
    firewalledAccounts: options.firewalledAccounts,
  };

  return [
    {
      name: "email_thread_brief",
      description: [
        "Fetch a Gmail thread as a hybrid brief for co-working triage.",
        "",
        "Returns metadata inline (timeline one-liners, participants, attachment inventory, drive_links).",
        "Writes the full latest message body to disk at latest_body_path — use Read on that path for full content.",
        "",
        "Account firewall: configured Piper Gmail account only.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Gmail thread ID" },
          session_id: {
            type: "string",
            description: "Co-working session ID for file paths under /tmp/tango-attachments/{session_id}/",
          },
          account: {
            type: "string",
            description: "Optional account override (must match configured Piper Gmail account)",
          },
        },
        required: ["thread_id"],
      },
      handler: async (input) => {
        const threadId = String(input.thread_id ?? "").trim();
        if (!threadId) {
          throw new Error("thread_id is required");
        }
        const sessionId = String(input.session_id ?? "co-working").trim() || "co-working";
        const account = resolveEmailAccount(
          typeof input.account === "string" ? input.account : null,
          accountOptions,
        );
        const messages = await fetchThreadMessages(runGog, threadId, account);
        const brief = buildThreadBrief({ threadId, account, messages, sessionId });
        return { result: brief };
      },
    },
    {
      name: "email_search",
      description: [
        "Search Gmail with Gmail query syntax. Includes archived mail via in:anywhere unless already present.",
        "",
        "Returns numbered ThreadCards (thread_id, message_id, from, subject, date, snippet).",
        "Account firewall: configured Piper Gmail account only.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query" },
          max: { type: "number", description: "Max results (default 20)" },
          account: { type: "string", description: "Optional account override" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = ensureArchiveScope(String(input.query ?? "").trim());
        if (!query) {
          throw new Error("query is required");
        }
        const max = clampMax(input.max, 20);
        const account = resolveEmailAccount(
          typeof input.account === "string" ? input.account : null,
          accountOptions,
        );
        const cards = await searchMessages(runGog, query, account, max);
        return {
          result: {
            account,
            query,
            cards: cards.map((card, index) => ({ index: index + 1, ...card })),
          },
        };
      },
    },
    {
      name: "email_inbox_scan",
      description: [
        "Scan unread inbox metadata for co-working triage.",
        "",
        "Returns numbered ThreadCards only — no full bodies.",
        "Account firewall: configured Piper Gmail account only.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          max: { type: "number", description: "Max unread threads to return (default 25)" },
          account: { type: "string", description: "Optional account override" },
        },
      },
      handler: async (input) => {
        const max = clampMax(input.max, 25);
        const account = resolveEmailAccount(
          typeof input.account === "string" ? input.account : null,
          accountOptions,
        );
        const cards = await searchMessages(runGog, "is:unread in:inbox", account, max);
        return {
          result: {
            account,
            query: "is:unread in:inbox",
            cards: cards.map((card, index) => ({ index: index + 1, ...card })),
          },
        };
      },
    },
  ];
}

function clampMax(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 100);
}

export function emailAgentToolLooksReadOnly(name: string): boolean {
  return name === "email_thread_brief" || name === "email_search" || name === "email_inbox_scan";
}

/** Parse single-message gog get --format full output for tests and legacy paths. */
export function parseGogEmailMessageOutput(raw: string) {
  return parseGogEmailFullOutput(raw);
}
