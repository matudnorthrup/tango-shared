/**
 * Personal Agent Tools — Tool definitions for Watson (personal assistant) worker agents.
 *
 * Tools:
 *   - gog_email: Gmail operations via gog CLI
 *   - system_clock: Current local date/time lookup
 *   - gog_calendar: Google Calendar operations via gog CLI
 *   - obsidian: Obsidian vault operations via obsidian-cli
 *   - health_morning: Morning health briefing via health-query script
 *   - lunch_money: Lunch Money REST API for finance
 *   - imessage: iMessage read/send via imsg CLI
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  extractAttachmentText,
  isGeneratedObsidianProjection,
  resolveDefaultObsidianVaultPath,
  type AgentTool,
} from "@tango/core";
import yaml from "js-yaml";
import { getBrowserManager } from "./browser-manager.js";
import { getSecret } from "./op-secret.js";
import {
  backfillWalmartReceiptNote,
  findWalmartReceiptRecord,
  listWalmartDeliveryCandidates,
  reconcileWalmartReimbursementsAgainstExpenseDesk,
  upsertWalmartReimbursementTracking,
} from "./receipt-reimbursement-registry.js";
import {
  checkSubmissionDedup,
  detectReimbursementGaps,
  generateMonthlyLedger,
  listReimbursementCandidates,
  lookupReceiptRecords,
  reconcileUniversalReimbursements,
  resolveDefaultMemo,
  resolveVendorConfig,
  upsertReimbursementTracking,
} from "./receipt-universal-registry.js";
import { executeGoogleDocTabUpdate } from "./google-doc-update-executor.js";
import { loadReimbursementEvidenceRecord } from "./reimbursement-evidence.js";
import { extractExpenseDeskReimbursementIdFromUrl } from "./reimbursement-automation.js";
import { createGogCommandEnv } from "./gog-keyring-password.js";
import { normalizeGogEmailCommand } from "./gog-email-access.js";
import { withCalendarTimezones } from "./gog-calendar-timezone.js";

// ---------------------------------------------------------------------------
// Command runner (shared)
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs, env);
  if (result.code !== 0 && result.stderr) {
    return `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  }
  return result.stdout.trim();
}

async function runRequiredCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface PersonalToolPaths {
  gogCommand?: string;
  healthScript?: string;
  imsgCommand?: string;
}

function resolvePaths(overrides?: PersonalToolPaths) {
  const home = os.homedir();
  return {
    gogCommand: overrides?.gogCommand ?? "/opt/homebrew/bin/gog",
    healthScript:
      overrides?.healthScript
      ?? process.env.TANGO_HEALTH_QUERY_SCRIPT?.trim()
      ?? path.join(home, ".tango", "bin", "health-query.js"),
    imsgCommand: overrides?.imsgCommand ?? "/opt/homebrew/bin/imsg",
  };
}

function gogCommandEnv(): NodeJS.ProcessEnv {
  return createGogCommandEnv();
}

const GOG_EMAIL_ATTACHMENT_TEXT_MAX_CHARS = 12_000;

interface GogEmailAttachmentText {
  filename: string;
  method: string | null;
  text: string;
  truncated: boolean;
  total_chars: number;
  warnings: string[];
}

function getOptionValue(args: string[], option: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === option) {
      return args[i + 1] ?? null;
    }
    if (arg?.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1);
    }
  }
  return null;
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isAllowedTempFile(filePath: string): Promise<boolean> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return false;
  }

  const realFilePath = await fs.realpath(filePath);
  const roots = await Promise.all([
    realpathIfExists("/tmp"),
    realpathIfExists(os.tmpdir()),
  ]);

  return roots.some((root) => root !== null && isPathInside(root, realFilePath));
}

async function maybeExtractGmailAttachmentText(args: string[]): Promise<GogEmailAttachmentText | null> {
  if (args[0] !== "gmail" || args[1] !== "attachment") {
    return null;
  }

  const outputDir = getOptionValue(args, "--out");
  const filename = getOptionValue(args, "--name");
  if (!outputDir || !filename) {
    return null;
  }

  if (path.basename(filename) !== filename || !filename.toLowerCase().endsWith(".pdf")) {
    return null;
  }

  const outputDirRealPath = await realpathIfExists(outputDir);
  const allowedRoots = await Promise.all([
    realpathIfExists("/tmp"),
    realpathIfExists(os.tmpdir()),
  ]);
  if (!outputDirRealPath || !allowedRoots.some((root) => root !== null && outputDirRealPath === root)) {
    return null;
  }

  const filePath = path.join(outputDir, filename);
  try {
    if (!(await isAllowedTempFile(filePath))) {
      return null;
    }

    const extraction = await extractAttachmentText({
      filePath,
      filename,
      contentType: "application/pdf",
      sourceFormat: "pdf",
    });
    const text = extraction.text.slice(0, GOG_EMAIL_ATTACHMENT_TEXT_MAX_CHARS);
    return {
      filename,
      method: extraction.commandUsed,
      text,
      truncated: extraction.text.length > GOG_EMAIL_ATTACHMENT_TEXT_MAX_CHARS,
      total_chars: extraction.text.length,
      warnings: extraction.warnings,
    };
  } catch (error) {
    return {
      filename,
      method: null,
      text: "",
      truncated: false,
      total_chars: 0,
      warnings: [`PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

// ---------------------------------------------------------------------------
// Email tools
// ---------------------------------------------------------------------------

export function createEmailTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "gog_email",
      description: [
        "Run Gmail operations via the gog CLI. Supports search, message fetch, attachment download, thread fetch, archive, and draft creation.",
        "Pass a Gmail command with or without the optional `gog` or `gmail` prefix; it is normalized before execution.",
        "",
        "Commands:",
        "  gog gmail messages search '<query>' [--max N] [--account <email>]",
        "    Search Gmail. Query uses Gmail syntax: from:, to:, subject:, is:unread, newer_than:1d, etc.",
        "    Accounts are installation-specific. Common patterns are personal@example.com and work@example.com. Pass --account explicitly, choosing by context.",
        "",
        "  gog gmail get <messageId> --format full [--account <email>]",
        "    Fetch a specific message with body text and attachment metadata.",
        "",
        "  gog gmail attachment <messageId> <attachmentId> --out /tmp --name '<filename>' [--account <email>]",
        "    Download a specific attachment to a real local file path for use as evidence in another tool.",
        "",
        "  gog gmail thread <thread_id> [--account <email>]",
        "    Fetch full thread conversation by ID.",
        "",
        "  gog gmail thread modify <thread_id> --remove INBOX [--account <email>]",
        "    Archive a thread (remove from inbox).",
        "",
        "  gog gmail drafts create --to <email> --subject '<subject>' --body '<body>' [--reply-to-message-id <id>] [--account <email>]",
        "    Create a draft email. Use --reply-to-message-id to reply to an existing thread.",
        "",
        "  gog gmail messages list [--max N] [--account <email>]",
        "    List recent inbox messages.",
        "",
        "Output: JSON. Message/thread objects include from, to, subject, body, date, and attachment metadata when present.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Gmail command. The `gog` and `gmail` prefixes are optional. Example: \"messages search 'is:unread newer_than:1d' --max 20\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = normalizeGogEmailCommand(input.command);
        // Parse the command string into args, respecting quotes
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.gogCommand, args, 60_000, gogCommandEnv());
        const attachmentText = await maybeExtractGmailAttachmentText(args);
        if (attachmentText) {
          return { result: stdout, attachment_text: attachmentText };
        }
        return { result: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// System clock tools
// ---------------------------------------------------------------------------

export function createSystemClockTools(): AgentTool[] {
  return [
    {
      name: "system_clock",
      description: [
        "Read the current local date and time from the runtime.",
        "",
        "Use this for questions like:",
        '  - "What time is it?"',
        '  - "What day is it today?"',
        '  - "What time is it in New York?"',
        "",
        "Returns structured local date/time strings plus the current UTC ISO timestamp.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone like America/Los_Angeles or America/New_York.",
          },
        },
      },
      handler: async (input) => {
        const requestedTimeZone =
          typeof input.timezone === "string" && input.timezone.trim().length > 0
            ? input.timezone.trim()
            : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

        try {
          const now = new Date();
          const date = new Intl.DateTimeFormat("en-CA", {
            timeZone: requestedTimeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(now);
          const time = new Intl.DateTimeFormat("en-US", {
            timeZone: requestedTimeZone,
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(now);

          return {
            now: {
              iso: now.toISOString(),
              timeZone: requestedTimeZone,
              date,
              time,
              dateTime: `${date} ${time}`,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            error: `Invalid timezone: ${requestedTimeZone}. ${message}`,
          };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

export function createCalendarTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "gog_calendar",
      description: [
        "Run Google Calendar operations via the gog CLI.",
        "",
        "Commands:",
        "  gog calendar events [--today] [--all] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--max N] [--account <email>] [--json]",
        "    List calendar events. Use --today for today, --days 7 for next week, or --from/--to for ranges.",
        "    IMPORTANT: --to is EXCLUSIVE — for a single day, use --today or set --to to the NEXT day.",
        "    Use --all to include all calendars (not just primary). Use --json for structured output.",
        "    Accounts are installation-specific. Common patterns are personal@example.com and work@example.com. Pass --account explicitly, choosing by context.",
        "",
        "  gog calendar create <calendarId> --summary '<title>' --from '<RFC3339 datetime>' --to '<RFC3339 datetime>' [--description '<desc>'] [--location '<loc>'] [--all-day] [--account <email>]",
        "    Create a calendar event. <calendarId> is POSITIONAL and is usually 'primary'.",
        "    Flags are --summary/--from/--to (NOT --title/--start/--end). Times are RFC3339, e.g. '2026-06-09T15:00:00-07:00'. --account is REQUIRED (multiple accounts configured, no default).",
        "    Example: calendar create primary --account work@example.com --summary 'Team sync' --from '2026-06-09T15:00:00-07:00' --to '2026-06-09T15:30:00-07:00'",
        "",
        "Timezone: use --timezone <IANA zone> on create, or --start-timezone/--end-timezone on create/update. Never infer a named zone from an offset.",
        "If omitted, Tango uses the destination calendar timezone for creates and preserves each existing endpoint timezone for updates. Explicit overrides are supported for travel.",
        "Use RFC3339 timestamps with the correct offset for the date (or UTC Z). All-day events use date-only values and no timezone flags. Recurring events must use one named zone for both endpoints.",
        "Output: JSON with event details (summary, start, end, location, attendees).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full gog calendar command (everything after 'gog'). Example: \"calendar events --today --all --json\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const env = gogCommandEnv();
        const args = await withCalendarTimezones(parseShellArgs(cmdStr), async (lookupArgs) => {
          const response = await execCommand(paths.gogCommand, lookupArgs, 30_000, env);
          if (response.code !== 0) throw new Error("Calendar timezone lookup failed; no calendar write attempted.");
          return response.stdout;
        });
        const stdout = await runCommand(paths.gogCommand, args, 30_000, env);
        return { result: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Obsidian tools
// ---------------------------------------------------------------------------

const OBSIDIAN_SEARCH_MAX_MATCHES = 50;
const OBSIDIAN_SEARCH_TIMEOUT_MS = 30_000;
const OBSIDIAN_VALUE_FLAGS = new Set(["--vault", "--key", "--value", "--restore", "--heading"]);
const OBSIDIAN_BOOLEAN_FLAGS = new Set(["--append", "--overwrite", "--edit", "--print", "--delete", "--force"]);
const OBSIDIAN_LIST_WIKILINK_FRONTMATTER_KEYS = new Set(["types", "areas", "collections", "categories"]);
const DAILY_NOTE_PROTECTED_SECTIONS = [
  "Notes",
  "Interstitial Log",
  "Other Work",
  "Energy Reflection",
  "Notes from Last Night",
] as const;

type ObsidianParsedCommand = {
  command: string;
  flags: Map<string, string | boolean>;
  positionals: string[];
};

type ObsidianFrontmatter = {
  body: string;
  data: Record<string, unknown>;
};

const OBSIDIAN_FRONTMATTER_YAML_OPTIONS = {
  schema: yaml.JSON_SCHEMA,
  lineWidth: -1,
  noRefs: true,
} as const;

function resolveObsidianVaultRoot(_vaultName?: string): string {
  // Same resolution as the memory indexer (TANGO_OBSIDIAN_VAULT → profile
  // notes → legacy ~/Documents/main) so the tool and the index never point at
  // different vaults (TGO-695).
  const resolved = resolveDefaultObsidianVaultPath();
  return resolved.startsWith("~") ? path.join(os.homedir(), resolved.slice(2)) : resolved;
}

function parseObsidianAppUrlPath(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed.toLowerCase().startsWith("obsidian://")) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Obsidian URL: ${candidate}`);
  }

  const action = url.hostname || url.pathname.replace(/^\/+/u, "");
  if (action !== "open") {
    throw new Error(`Unsupported Obsidian URL action: ${action || "(missing)"}`);
  }

  const targetPath = url.searchParams.get("file") ?? url.searchParams.get("path");
  if (targetPath == null || targetPath.trim().length === 0) {
    throw new Error("Obsidian URL must include a file or path parameter");
  }

  return targetPath;
}

function ensureVaultRelativePath(vaultRoot: string, candidate: string, options?: {
  allowRoot?: boolean;
  ensureMarkdownExtension?: boolean;
}): string {
  const trimmed = (parseObsidianAppUrlPath(candidate) ?? candidate).trim();
  if (trimmed.length === 0) {
    throw new Error("Path argument is required");
  }

  const relativePath = options?.ensureMarkdownExtension && !trimmed.endsWith(".md")
    ? `${trimmed}.md`
    : trimmed;
  const resolvedPath = path.resolve(vaultRoot, relativePath);
  const relativeFromVault = path.relative(vaultRoot, resolvedPath);
  const escapesVault = relativeFromVault === ".."
    || relativeFromVault.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeFromVault);

  if (escapesVault || (!options?.allowRoot && relativeFromVault.length === 0)) {
    throw new Error(`Path must stay inside the Obsidian vault: ${candidate}`);
  }

  return resolvedPath;
}

function parseObsidianCommandArgs(args: string[]): ObsidianParsedCommand {
  if (args.length === 0) {
    throw new Error("Obsidian command is required");
  }

  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const token = args[index]!;
    if (OBSIDIAN_BOOLEAN_FLAGS.has(token)) {
      flags.set(token, true);
      continue;
    }
    if (OBSIDIAN_VALUE_FLAGS.has(token)) {
      const value = args[index + 1];
      if (value == null) {
        throw new Error(`Missing value for ${token}`);
      }
      flags.set(token, value);
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unsupported obsidian flag: ${token}`);
    }
    positionals.push(token);
  }

  return {
    command: args[0]!,
    flags,
    positionals,
  };
}

function parseNoteFrontmatter(content: string): ObsidianFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) {
    return { body: content, data: {} };
  }

  const loaded = yaml.load(match[1] ?? "", { schema: yaml.JSON_SCHEMA });
  if (loaded == null) {
    return { body: content.slice(match[0].length), data: {} };
  }
  if (typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new Error("Obsidian frontmatter must be a YAML object");
  }

  return {
    body: content.slice(match[0].length),
    data: { ...(loaded as Record<string, unknown>) },
  };
}

function serializeNoteFrontmatter(frontmatter: ObsidianFrontmatter): string {
  if (Object.keys(frontmatter.data).length === 0) {
    return frontmatter.body;
  }

  const yamlText = yaml.dump(frontmatter.data, OBSIDIAN_FRONTMATTER_YAML_OPTIONS).trimEnd();
  return frontmatter.body.length > 0
    ? `---\n${yamlText}\n---\n${frontmatter.body}`
    : `---\n${yamlText}\n---\n`;
}

function parseFrontmatterEditValue(key: string, value: string): unknown {
  if (!OBSIDIAN_LIST_WIKILINK_FRONTMATTER_KEYS.has(key)) {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (/^\[\[.+\]\]$/u.test(trimmed)) {
    return [trimmed];
  }

  const parsed = tryParseYamlValue(trimmed);
  const rawValues = Array.isArray(parsed)
    ? parsed
    : trimmed.includes(",")
      ? trimmed.split(",")
      : [typeof parsed === "string" ? parsed : trimmed];

  return rawValues.map((item) => normalizeFrontmatterWikilinkValue(String(item)));
}

function tryParseYamlValue(value: string): unknown {
  try {
    return yaml.load(value, { schema: yaml.JSON_SCHEMA });
  } catch {
    return value;
  }
}

function normalizeFrontmatterWikilinkValue(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/gu, "").trim();
  if (trimmed.length === 0) {
    throw new Error("List frontmatter values cannot include empty items");
  }
  if (/^\[\[.+\]\]$/u.test(trimmed)) {
    return trimmed;
  }
  return `[[${trimmed}]]`;
}

function isDailyNotePath(vaultRoot: string, notePath: string): boolean {
  const relativePath = path.relative(vaultRoot, notePath).split(path.sep).join("/");
  return /^Planning\/Daily\/\d{4}-\d{2}-\d{2}\.md$/u.test(relativePath);
}

function validateDailyNoteOverwrite(vaultRoot: string, notePath: string, existing: string, next: string): void {
  if (!isDailyNotePath(vaultRoot, notePath)) return;

  for (const heading of DAILY_NOTE_PROTECTED_SECTIONS) {
    const existingSection = extractMarkdownSectionBody(existing, heading);
    if (existingSection == null || isPlaceholderSection(existingSection)) continue;

    const nextSection = extractMarkdownSectionBody(next, heading);
    if (nextSection == null) {
      throw new Error(`Refusing to overwrite daily note: protected section '${heading}' would be removed.`);
    }

    if (normalizeSectionForComparison(existingSection) !== normalizeSectionForComparison(nextSection)) {
      throw new Error(
        `Refusing to overwrite daily note: protected section '${heading}' has existing content that must be preserved. Use the 'section' command for targeted daily-note edits.`,
      );
    }
  }
}

function extractMarkdownSectionBody(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/u);
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) return null;

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index]?.trim() ?? "")) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex).join("\n");
}

function replaceMarkdownSectionBody(text: string, heading: string, body: string): string {
  const lines = text.split(/\r?\n/u);
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  const normalizedBody = body.replace(/\s+$/u, "");
  const bodyLines = normalizedBody.length > 0 ? normalizedBody.split(/\r?\n/u) : [];

  if (startIndex === -1) {
    const separator = text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${headingLine}\n${normalizedBody}\n`;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index]?.trim() ?? "")) {
      endIndex = index;
      break;
    }
  }

  const trailingLines = lines.slice(endIndex);
  const spacerLines = trailingLines.length > 0 ? [""] : [];
  const nextLines = [
    ...lines.slice(0, startIndex + 1),
    ...bodyLines,
    ...spacerLines,
    ...trailingLines,
  ];
  return `${nextLines.join("\n").replace(/\s+$/u, "")}\n`;
}

function appendMarkdownSectionBody(text: string, heading: string, body: string): string {
  const existingBody = extractMarkdownSectionBody(text, heading);
  if (existingBody == null || isPlaceholderSection(existingBody)) {
    return replaceMarkdownSectionBody(text, heading, body);
  }

  const appendedBody = `${existingBody.replace(/\s+$/u, "")}\n${body.replace(/\s+$/u, "")}`;
  return replaceMarkdownSectionBody(text, heading, appendedBody);
}

function isPlaceholderSection(body: string): boolean {
  const meaningfulLines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^<!--.*-->$/u.test(line));

  return meaningfulLines.length === 0
    || meaningfulLines.every((line) => line === "-" || line === "- [ ]");
}

function normalizeSectionForComparison(body: string): string {
  return body
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
}

function formatToolResult(value: string): { result: string } {
  return { result: value };
}

function formatToolError(error: unknown): { result: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { result: `Error: ${message}` };
}

function requirePositionalArguments(positionals: string[], expectedCount: number, usage: string): void {
  if (positionals.length !== expectedCount) {
    throw new Error(usage);
  }
}

async function searchObsidianVaultContent(vaultRoot: string, term: string): Promise<string[]> {
  const normalizedTerm = term.toLocaleLowerCase();
  const deadline = Date.now() + OBSIDIAN_SEARCH_TIMEOUT_MS;
  const matches: string[] = [];

  const assertWithinDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error(`search-content timed out after ${OBSIDIAN_SEARCH_TIMEOUT_MS}ms`);
    }
  };

  const walkDirectory = async (directoryPath: string): Promise<void> => {
    assertWithinDeadline();
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (matches.length >= OBSIDIAN_SEARCH_MAX_MATCHES) {
        return;
      }

      assertWithinDeadline();
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === ".obsidian" || entry.name === ".trash") {
          continue;
        }
        await walkDirectory(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileContent = await fs.readFile(fullPath, "utf8");
      const relativePath = path.relative(vaultRoot, fullPath).split(path.sep).join("/");
      const lines = fileContent.split(/\r?\n/u);
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        if (matches.length >= OBSIDIAN_SEARCH_MAX_MATCHES) {
          return;
        }

        const line = lines[lineNumber]!;
        if (line.toLocaleLowerCase().includes(normalizedTerm)) {
          matches.push(`${relativePath}:${lineNumber + 1}: ${line}`);
        }
      }
    }
  };

  await walkDirectory(vaultRoot);
  return matches;
}

// ---------------------------------------------------------------------------
// Obsidian governance (Unified Memory System, Slice 2)
//   - source-vs-working protection: notes with source_kind: source|reference are
//     read-only source material; agents may not mutate them without --force.
//   - versioning: notes with `versioned: true` get a prior-version snapshot under
//     <vault>/.versions/<note>/<timestamp>.md before any mutation.
// Notes without these frontmatter flags are unaffected (existing behavior).
// ---------------------------------------------------------------------------
const READONLY_SOURCE_KINDS = new Set(["source", "reference"]);

interface NoteGovernance {
  sourceKind?: string;
  versioned: boolean;
  readonly: boolean;
  readonlyProjection: boolean;
}

function readNoteGovernance(content: string): NoteGovernance {
  const frontmatter = parseNoteFrontmatter(content);
  const rawKind = frontmatter.data.source_kind;
  const sourceKind = typeof rawKind === "string" ? rawKind.trim().toLowerCase() : undefined;
  const versionedRaw = frontmatter.data.versioned;
  const versioned = versionedRaw === true || versionedRaw === "true";
  const readonlyProjection = isGeneratedObsidianProjection(content);
  return {
    ...(sourceKind ? { sourceKind } : {}),
    versioned,
    readonly: readonlyProjection || (sourceKind ? READONLY_SOURCE_KINDS.has(sourceKind) : false),
    readonlyProjection,
  };
}

function vaultRelative(vaultRoot: string, target: string): string {
  return path.relative(vaultRoot, target).split(path.sep).join("/");
}

// Write-time schema validation (Slice 2.3), scoped to memory-system "governed"
// notes — state files (state_managed) and source-classified notes (source_kind).
// The broad vault stays under the existing daily audit; this enforces the
// schema up front only for the docs that opt into the contract.
const REQUIRED_FRONTMATTER_FIELDS = ["date", "types", "areas"] as const;

function missingGovernedFrontmatter(content: string): string[] {
  const { data } = parseNoteFrontmatter(content);
  const governed = data.state_managed === true
    || data.state_managed === "true"
    || typeof data.source_kind === "string";
  if (!governed) return [];
  return REQUIRED_FRONTMATTER_FIELDS.filter((field) => {
    const value = data[field];
    if (value == null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "string") return value.trim().length === 0;
    return false;
  });
}

const MAX_VERSION_SNAPSHOTS_PER_NOTE = 20;

async function snapshotNoteVersion(
  vaultRoot: string,
  notePath: string,
  content: string,
): Promise<string> {
  const relNoExt = vaultRelative(vaultRoot, notePath).replace(/\.md$/iu, "");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const versionDir = path.join(vaultRoot, ".versions", relNoExt);
  await fs.mkdir(versionDir, { recursive: true });
  const versionPath = path.join(versionDir, `${stamp}.md`);
  await fs.writeFile(versionPath, content, "utf8");
  await pruneNoteVersions(versionDir);
  return vaultRelative(vaultRoot, versionPath);
}

/** Keep snapshot growth bounded: retain the newest N versions per note (TGO-695). */
async function pruneNoteVersions(versionDir: string): Promise<void> {
  try {
    const entries = (await fs.readdir(versionDir))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    const excess = entries.length - MAX_VERSION_SNAPSHOTS_PER_NOTE;
    for (let index = 0; index < excess; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      await fs.rm(path.join(versionDir, entry), { force: true });
    }
  } catch {
    // Retention is best-effort; never block the write that triggered it.
  }
}

/**
 * Guard + version an existing note before a mutating op. No-op when the note
 * does not exist. Throws on read-only source material unless `force` is set;
 * snapshots a prior version when the note opts into versioning.
 */
async function guardAndVersionExistingNote(
  vaultRoot: string,
  notePath: string,
  options: { force: boolean; operation: string },
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(notePath, "utf8");
  } catch {
    return;
  }
  const governance = readNoteGovernance(content);
  if (governance.readonlyProjection) {
    throw new Error(
      `Refusing to ${options.operation} '${vaultRelative(vaultRoot, notePath)}': `
      + "read_only_projection marks this as a generated state view. Regenerate it from canonical state instead.",
    );
  }
  if (governance.readonly && !options.force) {
    throw new Error(
      `Refusing to ${options.operation} '${vaultRelative(vaultRoot, notePath)}': `
      + `source_kind='${governance.sourceKind}' marks this as read-only source material. `
      + "Source data must not be modified. If this is truly intended, re-issue the command with --force.",
    );
  }
  if (governance.versioned) {
    await snapshotNoteVersion(vaultRoot, notePath, content);
  }
}

export function createObsidianTools(overrides?: PersonalToolPaths): AgentTool[] {
  void overrides;

  return [
    {
      name: "obsidian",
      description: [
        "Obsidian vault operations via obsidian-cli against the configured vault for this installation.",
        "Always include the active vault name in commands.",
        "",
        "Commands:",
        "  print '<note name>' --vault main",
        "    Read a note's full content (markdown with YAML frontmatter).",
        "    Note name is the display name, not file path (e.g. '3D Printing Setup', '2026 Week 10 Plan').",
        "    Also accepts obsidian://open URLs with file/path query parameters.",
        "",
        "  search-content '<term>' --vault main",
        "    Search note contents for a term.",
        "",
        "  create '<note name>' --vault main [--append] [--overwrite]",
        "    Create a new note or update an existing one. NEVER create new folders.",
        "    Pass note body via the separate 'content' parameter (NOT --content in the command string).",
        "    --append            Append to existing note instead of failing if it exists.",
        "    --overwrite         Replace existing note content. Use only after reading the note and preserving all current content.",
        "    Existing daily notes must not be updated with create --overwrite; use section/frontmatter commands instead.",
        "",
        "  section '<note name>' --vault main --heading '<heading>' [--append]",
        "    Replace one markdown ## section body, preserving the rest of the note.",
        "    Use this for generated daily-note sections like Today's Priorities.",
        "    --append            Append content inside the section instead of replacing the section body.",
        "    Protected daily-note sections (Notes, Interstitial Log, Other Work) cannot be replaced once they contain meaningful content. Use --append to add to Other Work.",
        "",
        "  frontmatter '<note name>' --vault main --edit --key '<key>' --value '<value>'",
        "    Modify a single frontmatter key. Also supports --print and --delete --key '<key>'.",
        "    For types, areas, collections, and categories, --value is stored as a YAML list of wikilinks.",
        "    Examples: --key areas --value '[[Personal]]' or --key areas --value '[\"[[Personal]]\", \"[[Tango]]\"]'.",
        "",
        "  move '<source>' '<dest>' --vault main",
        "    Move/rename a note.",
        "",
        "  versions '<note name>' --vault main [--restore <timestamp>]",
        "    List prior versions of a versioned note (newest first), or restore one.",
        "",
        "Governance (source protection + versioning):",
        "  Notes with frontmatter source_kind: source | reference are READ-ONLY source",
        "    material — create --overwrite/--append, frontmatter edits, move, and delete",
        "    are refused. Add --force only when you genuinely intend to modify source data.",
        "  Notes with frontmatter versioned: true get a prior-version snapshot before any",
        "    mutation; use 'versions' to list/restore. (canonical/working notes stay editable.)",
        "  Notes with frontmatter read_only_projection: true are generated state views and",
        "    cannot be mutated even with --force; update canonical state and regenerate them.",
        "",
        "For bulk search/read, use shell commands against the configured notes root directly.",
        "",
        "Conventions:",
        "  Frontmatter: date, areas, types (always required for new notes).",
        "  types, areas, and collections must be YAML lists of wikilinks, never scalar strings.",
        "  Approved areas: Home, Work, Health, Finance, Personal, Tango.",
        "  Do not use Travel, Projects, or Work as areas; use collections for finite trips, events, and initiatives.",
        "  Tappable links depend on the local note-link service for this installation",
        "  Task format: - [ ] Task description—YYYY-MM-DD (em-dash + date)",
        "  Key folders: Planning/ (Daily/Weekly), Records/ (Health Daily, Nutrition, Finance), References/",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "CLI command (everything after 'obsidian-cli'). For writes, omit --content here and use the 'content' parameter instead. Example: \"section 'Planning/Daily/2026-03-13' --vault main --heading \\\"Today's Priorities\\\"\"",
          },
          content: {
            type: "string",
            description: "Note body text (markdown). Used with create and section commands — passed directly to obsidian-cli, bypassing shell quoting issues. Always use this instead of --content in the command string.",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);
        try {
          const parsed = parseObsidianCommandArgs(args);
          const vaultRoot = resolveObsidianVaultRoot(
            typeof parsed.flags.get("--vault") === "string"
              ? String(parsed.flags.get("--vault"))
              : undefined,
          );
          const forceWrite = parsed.flags.get("--force") === true;

          switch (parsed.command) {
            case "print": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: print '<note name>' --vault main",
              );
              const notePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              const content = await fs.readFile(notePath, "utf8");
              return formatToolResult(content);
            }

            case "search-content": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: search-content '<term>' --vault main",
              );
              const matches = await searchObsidianVaultContent(vaultRoot, parsed.positionals[0]!);
              return formatToolResult(matches.join("\n"));
            }

            case "create": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: create '<note name>' --vault main [--append] [--overwrite]",
              );
              const notePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              const shouldAppend = parsed.flags.get("--append") === true;
              const shouldOverwrite = parsed.flags.get("--overwrite") === true;
              const content = input.content == null ? "" : String(input.content);
              await fs.mkdir(path.dirname(notePath), { recursive: true });

              let exists = true;
              try {
                await fs.access(notePath);
              } catch {
                exists = false;
              }

              if (shouldAppend) {
                await guardAndVersionExistingNote(vaultRoot, notePath, { force: forceWrite, operation: "append to" });
                await fs.appendFile(notePath, content, "utf8");
                return formatToolResult(`Appended ${path.relative(vaultRoot, notePath).split(path.sep).join("/")}`);
              }

              if (exists && !shouldOverwrite) {
                throw new Error(`Note already exists: ${path.relative(vaultRoot, notePath).split(path.sep).join("/")}`);
              }

              // Validations first (no side effects): daily-note section protection,
              // then governed-note schema requirements.
              if (exists && shouldOverwrite) {
                const existingContent = await fs.readFile(notePath, "utf8");
                validateDailyNoteOverwrite(vaultRoot, notePath, existingContent, content);
              }
              const missingFields = missingGovernedFrontmatter(content);
              if (missingFields.length > 0) {
                throw new Error(
                  `Refusing to write governed note '${vaultRelative(vaultRoot, notePath)}': `
                  + `missing required frontmatter [${missingFields.join(", ")}]. `
                  + "State files and source-classified notes must include date, types, and areas.",
                );
              }
              // Source-kind read-only guard + prior-version snapshot (side effect),
              // only once we're committed to writing.
              if (exists) {
                await guardAndVersionExistingNote(vaultRoot, notePath, { force: forceWrite, operation: "overwrite" });
              }
              await fs.writeFile(notePath, content, "utf8");
              return formatToolResult(
                `${exists ? "Overwrote" : "Created"} ${path.relative(vaultRoot, notePath).split(path.sep).join("/")}`,
              );
            }

            case "section": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: section '<note name>' --vault main --heading '<heading>' [--append]",
              );
              const heading = typeof parsed.flags.get("--heading") === "string"
                ? String(parsed.flags.get("--heading")).trim()
                : "";
              if (!heading) {
                throw new Error("section requires --heading");
              }

              const notePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              const existingContent = await fs.readFile(notePath, "utf8");
              const content = input.content == null ? "" : String(input.content);
              const shouldAppend = parsed.flags.get("--append") === true;
              const nextContent = shouldAppend
                ? appendMarkdownSectionBody(existingContent, heading, content)
                : replaceMarkdownSectionBody(existingContent, heading, content);

              if (!shouldAppend && isDailyNotePath(vaultRoot, notePath)) {
                const protectedHeading = DAILY_NOTE_PROTECTED_SECTIONS.find((section) => section === heading);
                if (protectedHeading != null) {
                  validateDailyNoteOverwrite(vaultRoot, notePath, existingContent, nextContent);
                }
              }

              if (existingContent === nextContent) {
                return formatToolResult(
                  `Section '${heading}' already up to date in ${path.relative(vaultRoot, notePath).split(path.sep).join("/")}`,
                );
              }

              await guardAndVersionExistingNote(vaultRoot, notePath, {
                force: forceWrite,
                operation: `edit section '${heading}' of`,
              });
              await fs.writeFile(notePath, nextContent, "utf8");
              return formatToolResult(
                `Updated section '${heading}' in ${path.relative(vaultRoot, notePath).split(path.sep).join("/")}`,
              );
            }

            case "frontmatter": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: frontmatter '<note name>' --vault main --edit --key '<key>' --value '<value>'",
              );
              const notePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              const content = await fs.readFile(notePath, "utf8");
              const frontmatter = parseNoteFrontmatter(content);
              const key = typeof parsed.flags.get("--key") === "string" ? String(parsed.flags.get("--key")) : undefined;

              if (parsed.flags.get("--print") === true) {
                const rendered = Object.keys(frontmatter.data).length === 0
                  ? ""
                  : yaml.dump(frontmatter.data, OBSIDIAN_FRONTMATTER_YAML_OPTIONS).trimEnd();
                return formatToolResult(rendered);
              }

              if (parsed.flags.get("--delete") === true) {
                if (!key) {
                  throw new Error("frontmatter --delete requires --key");
                }
                delete frontmatter.data[key];
                await guardAndVersionExistingNote(vaultRoot, notePath, { force: forceWrite, operation: "edit frontmatter of" });
                await fs.writeFile(notePath, serializeNoteFrontmatter(frontmatter), "utf8");
                return formatToolResult(`Deleted frontmatter key '${key}'`);
              }

              if (parsed.flags.get("--edit") === true) {
                const value = typeof parsed.flags.get("--value") === "string"
                  ? String(parsed.flags.get("--value"))
                  : undefined;
                if (!key || value == null) {
                  throw new Error("frontmatter --edit requires --key and --value");
                }
                frontmatter.data[key] = parseFrontmatterEditValue(key, value);
                await guardAndVersionExistingNote(vaultRoot, notePath, { force: forceWrite, operation: "edit frontmatter of" });
                await fs.writeFile(notePath, serializeNoteFrontmatter(frontmatter), "utf8");
                return formatToolResult(`Updated frontmatter key '${key}'`);
              }

              throw new Error("frontmatter requires one of --print, --edit, or --delete");
            }

            case "move": {
              requirePositionalArguments(
                parsed.positionals,
                2,
                "Usage: move '<source>' '<dest>' --vault main",
              );
              const sourcePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              const destPath = ensureVaultRelativePath(vaultRoot, parsed.positionals[1]!, {
                ensureMarkdownExtension: true,
              });
              await guardAndVersionExistingNote(vaultRoot, sourcePath, { force: forceWrite, operation: "move" });
              await fs.mkdir(path.dirname(destPath), { recursive: true });
              await fs.rename(sourcePath, destPath);
              return formatToolResult(
                `Moved ${path.relative(vaultRoot, sourcePath).split(path.sep).join("/")} -> ${path.relative(vaultRoot, destPath).split(path.sep).join("/")}`,
              );
            }

            case "list": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: list '<folder>' --vault main",
              );
              const folderPath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                allowRoot: true,
              });
              const entries = await fs.readdir(folderPath, { withFileTypes: true });
              entries.sort((left, right) => left.name.localeCompare(right.name));
              return formatToolResult(
                entries
                  .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
                  .join("\n"),
              );
            }

            case "delete": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: delete '<note name>' --vault main",
              );
              const notePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              await guardAndVersionExistingNote(vaultRoot, notePath, { force: forceWrite, operation: "delete" });
              await fs.unlink(notePath);
              return formatToolResult(`Deleted ${path.relative(vaultRoot, notePath).split(path.sep).join("/")}`);
            }

            case "versions": {
              requirePositionalArguments(
                parsed.positionals,
                1,
                "Usage: versions '<note name>' --vault main [--restore <timestamp>]",
              );
              const notePath = ensureVaultRelativePath(vaultRoot, parsed.positionals[0]!, {
                ensureMarkdownExtension: true,
              });
              const relNoExt = vaultRelative(vaultRoot, notePath).replace(/\.md$/iu, "");
              const versionDir = path.join(vaultRoot, ".versions", relNoExt);
              const restoreStamp = typeof parsed.flags.get("--restore") === "string"
                ? String(parsed.flags.get("--restore"))
                : undefined;

              if (restoreStamp) {
                const versionContent = await fs.readFile(path.join(versionDir, `${restoreStamp}.md`), "utf8");
                // Snapshot current content first so a restore is itself reversible.
                await guardAndVersionExistingNote(vaultRoot, notePath, { force: forceWrite, operation: "restore over" });
                await fs.writeFile(notePath, versionContent, "utf8");
                return formatToolResult(`Restored ${vaultRelative(vaultRoot, notePath)} from version ${restoreStamp}`);
              }

              let entries: string[] = [];
              try {
                entries = (await fs.readdir(versionDir))
                  .filter((file) => file.endsWith(".md"))
                  .map((file) => file.replace(/\.md$/iu, ""))
                  .sort()
                  .reverse();
              } catch {
                entries = [];
              }
              return formatToolResult(entries.length > 0 ? entries.join("\n") : "(no prior versions)");
            }

            default:
              throw new Error(`Unsupported obsidian command: ${parsed.command}`);
          }
        } catch (error) {
          return formatToolError(error);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Health morning briefing
// ---------------------------------------------------------------------------

export function createHealthBriefingTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "health_morning",
      description: [
        "Get the morning health briefing — sleep, recovery (HRV, RHR), and today's activity.",
        "Calls health-query.js --morning. Returns JSON with sleep hours, HRV, RHR, steps, exercise.",
        "",
        "Health baselines:",
        "  RHR: normal 55-65 bpm, good 50-55 bpm",
        "  HRV: normal 30-40ms, good 50-60ms",
        "  Steps: normal 8-10k, good 15k+",
        "  Sleep: normal 6-7h, good 8h+",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["morning", "recovery", "checkin", "trend"],
            description: "Query mode: morning (default), recovery, checkin, or trend",
          },
          days: {
            type: "number",
            description: "For trend mode: number of days (default 7)",
          },
          date: {
            type: "string",
            description: "Specific date in YYYY-MM-DD format (optional)",
          },
        },
      },
      handler: async (input) => {
        const mode = String(input.mode ?? "morning");
        const args: string[] = [`--${mode}`];
        if (mode === "trend" && typeof input.days === "number") {
          args.push(String(Math.round(input.days)));
        }
        if (input.date) {
          args.push("--date", String(input.date));
        }
        const stdout = await runCommand(process.execPath, [paths.healthScript, ...args], 60_000);
        try {
          return JSON.parse(stdout);
        } catch {
          return { result: stdout };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Lunch Money API
// ---------------------------------------------------------------------------

export function createFinanceTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  let cachedApiKey: string | null = null;
  async function getApiKey(): Promise<string> {
    if (!cachedApiKey) {
      // Prefer env var — op CLI hangs on macOS when desktop app integration is active
      const envKey = process.env.LUNCH_MONEY_ACCESS_TOKEN;
      if (envKey) {
        cachedApiKey = envKey;
      } else {
        const opKey = await getSecret("Watson", "Lunch Money API Key");
        if (!opKey) throw new Error("Lunch Money API key not found. Set LUNCH_MONEY_ACCESS_TOKEN in .env or add 'Lunch Money API Key' to Watson vault in 1Password.");
        cachedApiKey = opKey;
      }
    }
    return cachedApiKey;
  }

  return [
    {
      name: "lunch_money",
      description: [
        "Lunch Money REST API for personal finance — transactions, categories, and budgets.",
        "Base URL: https://dev.lunchmoney.app/v1",
        "",
        "Common endpoints:",
        "  GET /transactions?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD — list transactions",
        "  GET /transactions?status=uncleared&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD — transactions not yet reviewed by this workflow",
        "  PUT /transactions/:id — update transaction (body: {\"transaction\": {\"category_id\": N, \"status\": \"cleared\", \"notes\": \"...\"}})",
        "  PUT /transactions/:id — split transaction with a top-level split array",
        "  GET /categories — list all categories with IDs",
        "  GET /budgets?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD — budget summaries",
        "",
        "Notes:",
        "  - Use status=uncleared for the review inbox. Do not use status=unreviewed; Lunch Money does not define it.",
        "  - For receipt-backed spending notes, use receipt_registry lookup_receipts and copy its lunchMoneyNote value.",
        "  - Receipt-backed notes must list the purchased items or summary first and keep the Obsidian receipt link as the final line.",
        "  - Do not leave generic notes such as 'Receipt' or 'Personal Spending' when the receipt contents are known.",
        "  - Split amounts are DOLLAR STRINGS, not cents",
        "  - Updates require {\"transaction\": {...}} wrapper",
        "  - Rate limit: ~0.3s between calls",
        "  - Rules reference: use the installation's active finance rules note or profile override",
        "  - This environment does not expose a working recurring-items endpoint; verify recurring transfers/subscriptions from transactions instead.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "PUT", "POST", "DELETE"],
            description: "HTTP method",
          },
          endpoint: {
            type: "string",
            description: "API endpoint path (e.g. '/transactions?start_date=2026-03-01&end_date=2026-03-09')",
          },
          body: {
            type: "object",
            description: "Request body for PUT/POST requests (optional)",
          },
        },
        required: ["method", "endpoint"],
      },
      handler: async (input) => {
        const method = String(input.method ?? "GET").toUpperCase();
        const endpoint = String(input.endpoint);
        const url = new URL(`https://dev.lunchmoney.app/v1${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`);

        const isTransactionsCollectionRequest =
          method === "GET" &&
          url.pathname.startsWith("/v1/transactions") &&
          !/^\/v1\/transactions\/\d+(?:\/|$)/.test(url.pathname);

        if (isTransactionsCollectionRequest) {
          const hasStartDate = url.searchParams.has("start_date");
          const hasEndDate = url.searchParams.has("end_date");

          if (!hasStartDate || !hasEndDate) {
            const endDate = currentLocalIsoDate();
            const [yearText = "0", monthText = "1", dayText = "1"] = endDate.split("-");
            const startDateValue = new Date(Number(yearText), Number(monthText) - 1, Number(dayText));
            startDateValue.setDate(startDateValue.getDate() - 14);
            const startDate = [
              String(startDateValue.getFullYear()),
              String(startDateValue.getMonth() + 1).padStart(2, "0"),
              String(startDateValue.getDate()).padStart(2, "0"),
            ].join("-");

            if (!hasStartDate) {
              url.searchParams.set("start_date", startDate);
            }
            if (!hasEndDate) {
              url.searchParams.set("end_date", endDate);
            }
          }
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${await getApiKey()}`,
          "Content-Type": "application/json",
        };

        const fetchOptions: RequestInit = { method, headers };
        if (input.body && (method === "PUT" || method === "POST")) {
          fetchOptions.body = JSON.stringify(input.body);
        }

        const response = await fetch(url, fetchOptions);
        const text = await response.text();

        if (!response.ok) {
          return { error: `HTTP ${response.status}: ${text}` };
        }

        try {
          return JSON.parse(text);
        } catch {
          return { result: text };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Receipt reimbursement tracking
// ---------------------------------------------------------------------------

function currentLocalIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function syncWalmartTrackingFromExpenseDeskEvidence(input: {
  evidencePath: string;
  status: string;
  amount?: number;
  transactionDate?: string;
  submitted?: string;
  note?: string;
  expenseReportId?: string;
}): void {
  const evidenceRecord = loadReimbursementEvidenceRecord(input.evidencePath);
  const orderId = evidenceRecord?.orderId?.trim();

  const existing = orderId
    ? findWalmartReceiptRecord(orderId)
    : listWalmartDeliveryCandidates({
        since: input.transactionDate,
        includeSubmitted: true,
      }).find((record) =>
        (!input.transactionDate || record.date === input.transactionDate)
        && input.amount != null
        && record.driverTip != null
        && Math.abs(record.driverTip - input.amount) < 0.01
      );
  if (!existing) {
    return;
  }
  const existingStatus = existing?.reimbursement.status?.trim().toLowerCase();
  const nextStatus = existingStatus === "reimbursed" ? "reimbursed" : input.status;
  upsertWalmartReimbursementTracking({
    notePath: existing.filePath,
    status: nextStatus,
    system: "ExpenseDesk",
    reimbursableItem: "Driver tip",
    amount: input.amount,
    submitted: input.submitted,
    note: input.note,
    evidencePath: input.evidencePath,
    expenseReportId: input.expenseReportId,
  });
}

export function createReceiptRegistryTools(): AgentTool[] {
  return [
    {
      name: "receipt_registry",
      description: [
        "Structured receipt and reimbursement tracking for cataloged Obsidian receipt notes.",
        "",
        "Actions:",
        "  lookup_receipts",
        "    Find cataloged receipt notes by Lunch Money transaction id, amount, date, merchant/vendor, or text query.",
        "    Returns receipt metadata, linked Lunch Money transactions, item rows, category notes, and a lunchMoneyNote value.",
        "    Use lunchMoneyNote unchanged when updating Lunch Money notes for a receipt-backed transaction.",
        "    Use this before saying no receipt exists or asking the user for itemized split amounts.",
        "    Optional params: transaction_id, amount, date or transaction_date, merchant, query, max_results.",
        "",
        "  list_walmart_delivery_candidates",
        "    List Walmart receipt notes that include a delivery driver tip and are still missing reimbursement submission state.",
        "    By default this verifies the candidate list against live ExpenseDesk reimbursement history before returning anything as pending.",
        "    Optional params: since (YYYY-MM-DD), until (YYYY-MM-DD), include_submitted (boolean), verify_with_ramp (boolean), max_pages (number).",
        "",
        "  backfill_walmart_delivery_candidates",
        "    Scan live Walmart purchase history for delivery-from-store orders with driver tips, create missing receipt notes,",
        "    and return the pending reimbursement candidates Watson can file next.",
        "    Optional params: since (YYYY-MM-DD), until (YYYY-MM-DD), include_submitted (boolean), verify_with_ramp (boolean), max_pages (number).",
        "",
        "  reconcile_walmart_reimbursements",
        "    Verify Walmart tip notes against live ExpenseDesk reimbursement history and update stale note status fields in place.",
        "    Optional params: since (YYYY-MM-DD), until (YYYY-MM-DD), max_pages (number).",
        "",
        "  upsert_walmart_reimbursement",
        "    Create or update the standardized reimbursement tracking block inside a Walmart receipt note.",
        "    Provide either note_path or order_id, plus status.",
        "",
        "  check_submission_dedup",
        "    Check whether a reimbursement note or proposed submission already appears in local receipt notes or live ExpenseDesk history.",
        "    Optional params: note_path, vendor, merchant, amount, transaction_date, memo, verify_with_ramp (boolean), max_pages (number).",
        "",
        "  list_reimbursement_candidates",
        "    List configured reimbursement candidates across receipt folders using the universal reimbursement config.",
        "    Optional params: since, until, vendor, include_submitted, verify_with_ramp, max_pages.",
        "",
        "  reconcile_reimbursements",
        "    Verify configured reimbursement notes against live ExpenseDesk history and update stale tracking blocks in place.",
        "    Optional params: since, until, vendor, max_pages.",
        "",
        "  upsert_reimbursement",
        "    Create or update the standardized reimbursement tracking block inside any receipt note.",
        "    Requires note_path and status. Optional params: vendor, system, reimbursable_item, amount, submitted, note, evidence_path, ramp_report_id.",
        "",
        "  generate_monthly_ledger",
        "    Build a reimbursement ledger for a month or date range, grouped by vendor/category/status.",
        "    Optional params: month (YYYY-MM), since, until, vendor, verify_with_ramp, max_pages.",
        "",
        "  detect_gaps",
        "    Detect missing tracking blocks, stale submitted notes, missing recurring receipts, and other reimbursement coverage gaps.",
        "    Optional params: since, until, vendor, lookback_months, verify_with_ramp, max_pages.",
        "",
        "Tracking block fields:",
        "  status, system, reimbursable item, amount, submitted, note, evidence path, evidence provenance, ExpenseDesk report id",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "lookup_receipts",
              "list_walmart_delivery_candidates",
              "backfill_walmart_delivery_candidates",
              "reconcile_walmart_reimbursements",
              "upsert_walmart_reimbursement",
              "check_submission_dedup",
              "list_reimbursement_candidates",
              "reconcile_reimbursements",
              "upsert_reimbursement",
              "generate_monthly_ledger",
              "detect_gaps",
            ],
            description: "Receipt-registry action to perform.",
          },
          since: {
            type: "string",
            description: "For list/backfill/reconcile actions: optional lower date bound in YYYY-MM-DD format.",
          },
          until: {
            type: "string",
            description: "For list/backfill/reconcile actions: optional upper date bound in YYYY-MM-DD format.",
          },
          date: {
            type: "string",
            description: "For lookup_receipts: receipt date in YYYY-MM-DD format.",
          },
          include_submitted: {
            type: "boolean",
            description: "For list/backfill actions: include already-submitted or reimbursed notes.",
          },
          verify_with_ramp: {
            type: "boolean",
            description: "For list/backfill actions: verify note state against live ExpenseDesk history before claiming anything is pending. Defaults to true.",
          },
          max_pages: {
            type: "number",
            description: "For backfill/list/reconcile actions: maximum history pages to scan (default 8 for Walmart, 3 for ExpenseDesk).",
          },
          vendor: {
            type: "string",
            description: "For universal reimbursement actions: configured vendor key, receipt directory, or merchant alias from reimbursement-config.yaml.",
          },
          merchant: {
            type: "string",
            description: "For lookup_receipts or check_submission_dedup: merchant or payee name.",
          },
          transaction_id: {
            type: "string",
            description: "For lookup_receipts: Lunch Money transaction id linked from a receipt note.",
          },
          transaction_date: {
            type: "string",
            description: "For lookup_receipts or check_submission_dedup: transaction date in YYYY-MM-DD format.",
          },
          query: {
            type: "string",
            description: "For lookup_receipts: text to match in receipt metadata, linked transactions, store details, or item rows.",
          },
          max_results: {
            type: "number",
            description: "For lookup_receipts: maximum receipt matches to return. Defaults to 10.",
          },
          month: {
            type: "string",
            description: "For generate_monthly_ledger: optional month in YYYY-MM format.",
          },
          lookback_months: {
            type: "number",
            description: "For detect_gaps: recurring-receipt lookback window when since/until are omitted. Defaults to 3.",
          },
          note_path: {
            type: "string",
            description: "For upsert_walmart_reimbursement, upsert_reimbursement, or check_submission_dedup: absolute note path.",
          },
          order_id: {
            type: "string",
            description: "For upsert_walmart_reimbursement: Walmart order id if note_path is omitted.",
          },
          status: {
            type: "string",
            description: "For upsert_walmart_reimbursement: tracking status such as submitted, reimbursed, skipped, or not_submitted.",
          },
          system: {
            type: "string",
            description: "For upsert_walmart_reimbursement: reimbursement system name, e.g. ExpenseDesk.",
          },
          reimbursable_item: {
            type: "string",
            description: "For upsert_walmart_reimbursement: what is being reimbursed, e.g. Driver tip.",
          },
          amount: {
            type: "number",
            description: "For upsert_walmart_reimbursement: reimbursed or submitted amount in dollars.",
          },
          submitted: {
            type: "string",
            description: "For upsert_walmart_reimbursement: submission date in YYYY-MM-DD format.",
          },
          note: {
            type: "string",
            description: "For upsert_walmart_reimbursement or upsert_reimbursement: note or memo used on the submission.",
          },
          memo: {
            type: "string",
            description: "For check_submission_dedup: proposed reimbursement memo when note_path is omitted.",
          },
          evidence_path: {
            type: "string",
            description: "For upsert_walmart_reimbursement or upsert_reimbursement: screenshot or file path used as evidence.",
          },
          ramp_report_id: {
            type: "string",
            description: "For upsert_walmart_reimbursement or upsert_reimbursement: optional ExpenseDesk report or reimbursement identifier.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const since = typeof input.since === "string" ? input.since : undefined;
        const until = typeof input.until === "string" ? input.until : undefined;
        const vendor = typeof input.vendor === "string" ? input.vendor : undefined;
        const includeSubmitted = input.include_submitted === true;
        const verifyWithExpenseDesk = input.verify_with_ramp !== false;
        switch (action) {
          case "lookup_receipts": {
            const transactionId =
              typeof input.transaction_id === "string" || typeof input.transaction_id === "number"
                ? String(input.transaction_id)
                : undefined;
            const date =
              typeof input.date === "string"
                ? input.date
                : typeof input.transaction_date === "string"
                  ? input.transaction_date
                  : undefined;
            const results = lookupReceiptRecords({
              transactionId,
              amount: typeof input.amount === "number" ? input.amount : undefined,
              date,
              merchant: typeof input.merchant === "string" ? input.merchant : vendor,
              query: typeof input.query === "string" ? input.query : undefined,
              maxResults: typeof input.max_results === "number" ? input.max_results : undefined,
            });

            return {
              results,
              count: results.length,
            };
          }
          case "list_walmart_delivery_candidates": {
            const localResults = listWalmartDeliveryCandidates({
              since,
              includeSubmitted,
            }).filter((record) => !until || !record.date || record.date <= until);
            if (!verifyWithExpenseDesk) {
              return {
                retailer: "Walmart",
                verified_with_ramp: false,
                results: localResults,
              };
            }

            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listExpenseDeskReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileWalmartReimbursementsAgainstExpenseDesk({
              history,
              since,
              until,
              updateNotes: false,
            });
            return {
              retailer: "Walmart",
              verified_with_ramp: true,
              results: includeSubmitted ? reconciled.records : reconciled.pending,
              verification: {
                notes_examined: reconciled.notesExamined,
                history_entries_examined: reconciled.historyEntriesExamined,
                matched: reconciled.matched,
                unverified_submitted: reconciled.unverifiedSubmitted,
              },
            };
          }
          case "backfill_walmart_delivery_candidates": {
            const bm = getBrowserManager();
            await bm.launch(9223);
            const discovered = await bm.discoverWalmartDeliveryCandidates({
              since,
              until,
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const discoveredOrderIds = new Set<string>();
            const backfilled = discovered
              .map((candidate) => {
                discoveredOrderIds.add(candidate.orderId);
                const existing = findWalmartReceiptRecord(candidate.orderId);
                const noteRecord = existing ?? backfillWalmartReceiptNote({
                  orderId: candidate.orderId,
                  date: candidate.date,
                  total: candidate.total,
                  cardCharge: candidate.cardCharge,
                  itemsLine: candidate.itemsLine,
                  grocerySummary: "Walmart grocery delivery. Full item breakdown not yet backfilled into the note.",
                  notes: candidate.notes,
                  driverTip: candidate.driverTip,
                });
                return {
                  ...candidate,
                  note_path: noteRecord.filePath,
                  reimbursement_status: noteRecord.reimbursement.status ?? "not_submitted",
                };
              })
              .filter((candidate) => {
                if (includeSubmitted) {
                  return true;
                }
                return candidate.reimbursement_status !== "submitted"
                  && candidate.reimbursement_status !== "reimbursed";
              });

            if (!verifyWithExpenseDesk) {
              return {
                retailer: "Walmart",
                verified_with_ramp: false,
                results: backfilled,
              };
            }

            const history = await bm.listExpenseDeskReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileWalmartReimbursementsAgainstExpenseDesk({
              history,
              since,
              until,
              updateNotes: false,
            });
            const pendingByOrderId = new Set(reconciled.pending.map((record) => record.orderId));
            const verifiedMatches = reconciled.matched.filter((match) => discoveredOrderIds.has(match.orderId));
            const unverifiedSubmitted = reconciled.unverifiedSubmitted
              .filter((record) => discoveredOrderIds.has(record.orderId));
            const results = backfilled.filter((candidate) => {
              if (includeSubmitted) {
                return true;
              }
              return pendingByOrderId.has(candidate.orderId);
            });

            return {
              retailer: "Walmart",
              results,
              verified_with_ramp: true,
              verification: {
                notes_examined: reconciled.notesExamined,
                history_entries_examined: reconciled.historyEntriesExamined,
                matched: verifiedMatches,
                unverified_submitted: unverifiedSubmitted,
              },
            };
          }
          case "reconcile_walmart_reimbursements": {
            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listExpenseDeskReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileWalmartReimbursementsAgainstExpenseDesk({
              history,
              since,
              until,
              updateNotes: true,
            });
            return {
              retailer: "Walmart",
              verified_with_ramp: true,
              matched: reconciled.matched,
              updated: reconciled.updated,
              pending: reconciled.pending,
              unverified_submitted: reconciled.unverifiedSubmitted,
              notes_examined: reconciled.notesExamined,
              history_entries_examined: reconciled.historyEntriesExamined,
            };
          }
          case "upsert_walmart_reimbursement":
            if (typeof input.status !== "string" || input.status.trim().length === 0) {
              return { error: "upsert_walmart_reimbursement requires 'status'" };
            }
            return {
              retailer: "Walmart",
              result: upsertWalmartReimbursementTracking({
                notePath: typeof input.note_path === "string" ? input.note_path : undefined,
                orderId: typeof input.order_id === "string" ? input.order_id : undefined,
                status: input.status,
                system: typeof input.system === "string" ? input.system : undefined,
                reimbursableItem: typeof input.reimbursable_item === "string" ? input.reimbursable_item : undefined,
                amount: typeof input.amount === "number" ? input.amount : undefined,
                submitted: typeof input.submitted === "string" ? input.submitted : undefined,
                note: typeof input.note === "string" ? input.note : undefined,
                evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : undefined,
                expenseReportId: typeof input.ramp_report_id === "string" ? input.ramp_report_id : undefined,
              }),
            };
          case "check_submission_dedup": {
            if (
              (typeof input.note_path !== "string" || input.note_path.trim().length === 0)
              && (typeof input.amount !== "number"
                || typeof input.transaction_date !== "string"
                || input.transaction_date.trim().length === 0)
            ) {
              return {
                error: "check_submission_dedup requires note_path or both amount and transaction_date",
              };
            }

            const history = verifyWithExpenseDesk
              ? await (async () => {
                  const bm = getBrowserManager();
                  await bm.launch(9223);
                  return bm.listExpenseDeskReimbursementHistory({
                    maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
                  });
                })()
              : undefined;

            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: verifyWithExpenseDesk,
              result: checkSubmissionDedup({
                notePath: typeof input.note_path === "string" ? input.note_path : undefined,
                vendor,
                merchant: typeof input.merchant === "string" ? input.merchant : undefined,
                amount: typeof input.amount === "number" ? input.amount : undefined,
                transactionDate:
                  typeof input.transaction_date === "string" ? input.transaction_date : undefined,
                memo: typeof input.memo === "string" ? input.memo : undefined,
                history,
              }),
            };
          }
          case "list_reimbursement_candidates": {
            if (!verifyWithExpenseDesk) {
              return {
                vendor: resolveVendorConfig(vendor)?.key ?? vendor,
                verified_with_ramp: false,
                results: listReimbursementCandidates({
                  since,
                  until,
                  vendor,
                  includeSubmitted,
                }),
              };
            }

            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listExpenseDeskReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileUniversalReimbursements({
              history,
              since,
              until,
              vendor,
              includeSubmitted,
              updateNotes: false,
            });
            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: true,
              results: includeSubmitted ? reconciled.records : reconciled.pending,
              verification: {
                notes_examined: reconciled.notesExamined,
                history_entries_examined: reconciled.historyEntriesExamined,
                matched: reconciled.matched,
                unverified_submitted: reconciled.unverifiedSubmitted,
              },
            };
          }
          case "reconcile_reimbursements": {
            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listExpenseDeskReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileUniversalReimbursements({
              history,
              since,
              until,
              vendor,
              includeSubmitted: true,
              updateNotes: true,
            });
            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: true,
              matched: reconciled.matched,
              updated: reconciled.updated,
              pending: reconciled.pending,
              unverified_submitted: reconciled.unverifiedSubmitted,
              notes_examined: reconciled.notesExamined,
              history_entries_examined: reconciled.historyEntriesExamined,
            };
          }
          case "upsert_reimbursement":
            if (typeof input.note_path !== "string" || input.note_path.trim().length === 0) {
              return { error: "upsert_reimbursement requires note_path" };
            }
            if (typeof input.status !== "string" || input.status.trim().length === 0) {
              return { error: "upsert_reimbursement requires 'status'" };
            }
            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              result: upsertReimbursementTracking({
                notePath: input.note_path,
                vendor,
                status: input.status,
                system: typeof input.system === "string" ? input.system : undefined,
                reimbursableItem: typeof input.reimbursable_item === "string" ? input.reimbursable_item : undefined,
                amount: typeof input.amount === "number" ? input.amount : undefined,
                submitted: typeof input.submitted === "string" ? input.submitted : undefined,
                note: typeof input.note === "string" ? input.note : undefined,
                evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : undefined,
                expenseReportId: typeof input.ramp_report_id === "string" ? input.ramp_report_id : undefined,
              }),
            };
          case "generate_monthly_ledger": {
            const history = verifyWithExpenseDesk
              ? await (async () => {
                  const bm = getBrowserManager();
                  await bm.launch(9223);
                  return bm.listExpenseDeskReimbursementHistory({
                    maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
                  });
                })()
              : undefined;

            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: verifyWithExpenseDesk,
              ledger: generateMonthlyLedger({
                month: typeof input.month === "string" ? input.month : undefined,
                since,
                until,
                vendor,
                history,
              }),
            };
          }
          case "detect_gaps": {
            const history = verifyWithExpenseDesk
              ? await (async () => {
                  const bm = getBrowserManager();
                  await bm.launch(9223);
                  return bm.listExpenseDeskReimbursementHistory({
                    maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
                  });
                })()
              : undefined;

            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: verifyWithExpenseDesk,
              result: detectReimbursementGaps({
                since,
                until,
                vendor,
                history,
                lookbackMonths:
                  typeof input.lookback_months === "number" ? input.lookback_months : undefined,
              }),
            };
          }
          default:
            return { error: `Unknown receipt_registry action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// ExpenseDesk reimbursement automation
// ---------------------------------------------------------------------------

export function createReimbursementAutomationTools(): AgentTool[] {
  return [
    {
      name: "expense_reimbursement",
      description: [
        "Deterministic ExpenseDesk reimbursement browser automation for both generic invoice-backed submissions and delivery-fee reimbursements.",
        "",
        "Actions:",
        "  capture_walmart_tip_evidence",
        "    Open a Walmart order page and capture archived evidence that shows Driver tip plus an explicit visible date.",
        "",
        "  capture_email_reimbursement_evidence",
        "    Render a raw reimbursement email body into an archived screenshot evidence file for ExpenseDesk uploads when no better attachment exists.",
        "",
        "  capture_email_as_pdf",
        "    Render a raw email from `gog gmail get --format full` into a PDF file using the original email HTML. Prefer this over capture_email_reimbursement_evidence for HTML emails because it preserves original branding and layout.",
        "",
        "  prepare_expense_reimbursement_draft",
        "    Upload evidence and fill a ExpenseDesk reimbursement draft with amount, date, memo, and merchant. This stops before final submission.",
        "    A recent-history dedup gate runs automatically unless skip_dedup_check is true.",
        "",
        "  submit_reviewed_expense_reimbursement",
        "    Submit an already-prepared ExpenseDesk draft after checking the expected amount, transaction date, memo, and optional merchant.",
        "    Requires submission_confirmation='OWNER_REVIEWED_AND_APPROVED_SUBMISSION'.",
        "",
        "  submit_expense_reimbursement",
        "    Deprecated alias for prepare_expense_reimbursement_draft. It prepares a draft only; it does not click final Submit.",
        "",
        "  repair_expense_reimbursement_draft",
        "    Open an existing ExpenseDesk draft, optionally attach evidence, and repair amount, transaction date, memo, and merchant in place.",
        "",
        "  replace_expense_reimbursement_receipt",
        "    Open an existing ExpenseDesk reimbursement review page and replace or add receipt evidence, then capture a ExpenseDesk confirmation screenshot. Evidence may be a PDF or an image file.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "capture_walmart_tip_evidence",
              "capture_email_reimbursement_evidence",
              "capture_email_as_pdf",
              "prepare_expense_reimbursement_draft",
              "submit_expense_reimbursement",
              "submit_reviewed_expense_reimbursement",
              "repair_expense_reimbursement_draft",
              "replace_expense_reimbursement_receipt",
            ],
            description: "ExpenseDesk reimbursement automation action to perform.",
          },
          order_url: {
            type: "string",
            description: "For capture_walmart_tip_evidence: absolute Walmart order url.",
          },
          output_path: {
            type: "string",
            description: "For capture_walmart_tip_evidence or capture_email_reimbursement_evidence: optional destination png path. For capture_email_as_pdf: optional destination pdf path.",
          },
          email_content: {
            type: "string",
            description: "For capture_email_reimbursement_evidence or capture_email_as_pdf: raw `gog gmail get --format full` output for the reimbursement email.",
          },
          label: {
            type: "string",
            description: "For capture_email_reimbursement_evidence or capture_email_as_pdf: optional evidence label.",
          },
          amount: {
            type: "number",
            description: "For prepare_expense_reimbursement_draft or submit_reviewed_expense_reimbursement: amount in dollars.",
          },
          transaction_date: {
            type: "string",
            description: "For prepare_expense_reimbursement_draft or submit_reviewed_expense_reimbursement: date in YYYY-MM-DD or MM/DD/YYYY.",
          },
          memo: {
            type: "string",
            description: "For prepare_expense_reimbursement_draft: optional reimbursement memo text. Defaults from reimbursement-config.yaml when merchant or vendor matches. For submit_reviewed_expense_reimbursement: expected memo.",
          },
          evidence_path: {
            type: "string",
            description: "For prepare, submit-reviewed, or replace actions: absolute evidence file path (PDF or image).",
          },
          merchant: {
            type: "string",
            description: "For prepare_expense_reimbursement_draft: merchant name. Falls back to the vendor config when provided. For submit_reviewed_expense_reimbursement: optional expected merchant text.",
          },
          vendor: {
            type: "string",
            description: "For prepare_expense_reimbursement_draft: configured vendor key, receipt directory, or merchant alias from reimbursement-config.yaml.",
          },
          skip_dedup_check: {
            type: "boolean",
            description: "For prepare_expense_reimbursement_draft: bypass the automatic date+amount dedup gate. Use only for intentional re-submissions.",
          },
          review_url: {
            type: "string",
            description: "For submit_reviewed_expense_reimbursement, repair_expense_reimbursement_draft, or replace_expense_reimbursement_receipt: absolute ExpenseDesk reimbursement draft/review url.",
          },
          submission_confirmation: {
            type: "string",
            description: "For submit_reviewed_expense_reimbursement only: exact confirmation token OWNER_REVIEWED_AND_APPROVED_SUBMISSION after the owner explicitly approves submission.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const bm = getBrowserManager();
        await bm.launch(9223);
        const action = String(input.action ?? "");
        switch (action) {
          case "capture_walmart_tip_evidence":
            if (typeof input.order_url !== "string" || input.order_url.trim().length === 0) {
              return { error: "capture_walmart_tip_evidence requires order_url" };
            }
            return {
              result: await bm.captureWalmartTipEvidence({
                orderUrl: input.order_url,
                outputPath: typeof input.output_path === "string" ? input.output_path : undefined,
              }),
            };
          case "capture_email_reimbursement_evidence":
            if (typeof input.email_content !== "string" || input.email_content.trim().length === 0) {
              return { error: "capture_email_reimbursement_evidence requires email_content" };
            }
            return {
              result: await bm.captureEmailReimbursementEvidence({
                emailContent: input.email_content,
                label: typeof input.label === "string" ? input.label : undefined,
                outputPath: typeof input.output_path === "string" ? input.output_path : undefined,
              }),
            };
          case "capture_email_as_pdf":
            if (typeof input.email_content !== "string" || input.email_content.trim().length === 0) {
              return { error: "capture_email_as_pdf requires email_content" };
            }
            return {
              result: await bm.captureEmailAsPdf({
                emailContent: input.email_content,
                label: typeof input.label === "string" ? input.label : undefined,
                outputPath: typeof input.output_path === "string" ? input.output_path : undefined,
              }),
            };
          case "prepare_expense_reimbursement_draft":
          case "submit_expense_reimbursement":
            if (typeof input.amount !== "number") {
              return { error: `${action} requires amount` };
            }
            if (typeof input.transaction_date !== "string" || input.transaction_date.trim().length === 0) {
              return { error: `${action} requires transaction_date` };
            }
            if (typeof input.evidence_path !== "string" || input.evidence_path.trim().length === 0) {
              return { error: `${action} requires evidence_path` };
            }
            {
              const vendor = typeof input.vendor === "string" ? input.vendor : undefined;
              const resolvedVendor =
                resolveVendorConfig(vendor)
                ?? resolveVendorConfig(typeof input.merchant === "string" ? input.merchant : undefined);
              const resolvedMerchant =
                typeof input.merchant === "string" && input.merchant.trim().length > 0
                  ? input.merchant.trim()
                  : resolvedVendor?.merchantName;
              const resolvedMemo =
                typeof input.memo === "string" && input.memo.trim().length > 0
                  ? input.memo.trim()
                  : resolveDefaultMemo(vendor ?? resolvedMerchant);
              if (!resolvedMemo) {
                return {
                  error: `${action} requires memo or a merchant/vendor with a configured default memo`,
                };
              }

              if (input.skip_dedup_check !== true) {
                const history = await bm.listExpenseDeskReimbursementHistory();
                const dedup = checkSubmissionDedup({
                  vendor,
                  merchant: resolvedMerchant,
                  amount: input.amount,
                  transactionDate: input.transaction_date,
                  memo: resolvedMemo,
                  history,
                });
                if (dedup.duplicate) {
                  return {
                    error: `${action} blocked by dedup gate: ${dedup.reasons.join(", ")}`,
                    dedup,
                  };
                }
              }

              const result = await bm.prepareExpenseDeskReimbursementDraft({
                amount: input.amount,
                transactionDate: input.transaction_date,
                memo: resolvedMemo,
                evidencePath: input.evidence_path,
                merchant: resolvedMerchant,
              });
              syncWalmartTrackingFromExpenseDeskEvidence({
                evidencePath: result.evidencePath ?? input.evidence_path,
                status: "draft",
                amount: result.amount,
                transactionDate: result.transactionDate,
                submitted: "",
                note: result.memo,
                expenseReportId: result.expenseReportId,
              });
              return {
                result,
                draftUrl: result.reviewUrl,
                message: `ExpenseDesk reimbursement draft prepared for manual review at ${result.reviewUrl}. It has not been submitted.`,
                deprecatedAlias:
                  action === "submit_expense_reimbursement"
                    ? "submit_expense_reimbursement now prepares a draft only; prefer prepare_expense_reimbursement_draft."
                    : undefined,
              };
            }
          case "submit_reviewed_expense_reimbursement":
            if (typeof input.review_url !== "string" || input.review_url.trim().length === 0) {
              return { error: "submit_reviewed_expense_reimbursement requires review_url" };
            }
            if (input.submission_confirmation !== "OWNER_REVIEWED_AND_APPROVED_SUBMISSION") {
              return {
                error: "submit_reviewed_expense_reimbursement requires submission_confirmation=OWNER_REVIEWED_AND_APPROVED_SUBMISSION after the owner explicitly approves submission",
              };
            }
            if (typeof input.amount !== "number") {
              return { error: "submit_reviewed_expense_reimbursement requires amount" };
            }
            if (typeof input.transaction_date !== "string" || input.transaction_date.trim().length === 0) {
              return { error: "submit_reviewed_expense_reimbursement requires transaction_date" };
            }
            if (typeof input.memo !== "string" || input.memo.trim().length === 0) {
              return { error: "submit_reviewed_expense_reimbursement requires memo" };
            }
            {
              const result = await bm.submitReviewedExpenseDeskReimbursement({
                reviewUrl: input.review_url,
                amount: input.amount,
                transactionDate: input.transaction_date,
                memo: input.memo,
                merchant: typeof input.merchant === "string" ? input.merchant : undefined,
                evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : undefined,
              });
              if (typeof input.evidence_path === "string" && input.evidence_path.trim().length > 0) {
                syncWalmartTrackingFromExpenseDeskEvidence({
                  evidencePath: input.evidence_path,
                  status: "submitted",
                  amount: result.amount,
                  transactionDate: result.transactionDate,
                  submitted: currentLocalIsoDate(),
                  note: result.memo,
                  expenseReportId: result.expenseReportId,
                });
              }
              return {
                result,
                message: `ExpenseDesk reimbursement submitted after review check: ${result.reviewUrl}`,
              };
            }
          case "repair_expense_reimbursement_draft":
            if (typeof input.review_url !== "string" || input.review_url.trim().length === 0) {
              return { error: "repair_expense_reimbursement_draft requires review_url" };
            }
            if (typeof input.amount !== "number") {
              return { error: "repair_expense_reimbursement_draft requires amount" };
            }
            if (typeof input.transaction_date !== "string" || input.transaction_date.trim().length === 0) {
              return { error: "repair_expense_reimbursement_draft requires transaction_date" };
            }
            {
              const vendor = typeof input.vendor === "string" ? input.vendor : undefined;
              const resolvedVendor =
                resolveVendorConfig(vendor)
                ?? resolveVendorConfig(typeof input.merchant === "string" ? input.merchant : undefined);
              const resolvedMerchant =
                typeof input.merchant === "string" && input.merchant.trim().length > 0
                  ? input.merchant.trim()
                  : resolvedVendor?.merchantName;
              const resolvedMemo =
                typeof input.memo === "string" && input.memo.trim().length > 0
                  ? input.memo.trim()
                  : resolveDefaultMemo(vendor ?? resolvedMerchant);
              if (!resolvedMemo) {
                return {
                  error: "repair_expense_reimbursement_draft requires memo or a merchant/vendor with a configured default memo",
                };
              }
              const result = await bm.repairExpenseDeskReimbursementDraft({
                reviewUrl: input.review_url,
                amount: input.amount,
                transactionDate: input.transaction_date,
                memo: resolvedMemo,
                merchant: resolvedMerchant,
                evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : undefined,
              });
              return {
                result,
                draftUrl: result.reviewUrl,
                message: `ExpenseDesk reimbursement draft repaired for manual review at ${result.reviewUrl}. It has not been submitted.`,
              };
            }
          case "replace_expense_reimbursement_receipt":
            if (typeof input.review_url !== "string" || input.review_url.trim().length === 0) {
              return { error: "replace_expense_reimbursement_receipt requires review_url" };
            }
            if (typeof input.evidence_path !== "string" || input.evidence_path.trim().length === 0) {
              return { error: "replace_expense_reimbursement_receipt requires evidence_path" };
            }
            {
              const result = await bm.replaceExpenseDeskReimbursementReceipt({
                reviewUrl: input.review_url,
                evidencePath: input.evidence_path,
              });
              syncWalmartTrackingFromExpenseDeskEvidence({
                evidencePath: result.evidencePath,
                status: "submitted",
                expenseReportId: extractExpenseDeskReimbursementIdFromUrl(result.reviewUrl) ?? undefined,
              });
              return {
                result,
              };
            }
          default:
            return { error: `Unknown expense_reimbursement action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// iMessage tools
// ---------------------------------------------------------------------------

export function createIMessageTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "imessage",
      description: [
        "Read and send iMessages via the imsg CLI. Supports listing conversations, reading history, and sending messages.",
        "",
        "Commands:",
        "  imsg chats [--limit N] [--json]",
        "    List recent conversations. Use --json for structured output.",
        "    Output includes chat_id, display_name, participant handles, last message date.",
        "",
        "  imsg history --chat-id <id> [--limit N] [--start <ISO8601>] [--end <ISO8601>] [--attachments] [--json]",
        "    Read message history for a conversation. chat-id comes from 'chats' output.",
        "    Use --start/--end for date ranges (--end is exclusive).",
        "    Use --json for structured output with sender, text, timestamps.",
        "",
        "  imsg send --to <handle> --text '<message>'",
        "    Send a message to a phone number or email address.",
        "    Handle format: +15551234567 (E.164 phone) or email@example.com",
        "",
        "  imsg send --chat-id <id> --text '<message>'",
        "    Send a message to an existing conversation by chat ID.",
        "",
        "Notes:",
        "  - Always use --json for chats and history to get structured output.",
        "  - Use 'chats' first to find the chat_id for a person, then 'history' to read.",
        "  - For send: prefer --chat-id over --to when the conversation already exists.",
        "  - Sending is a real action — the recipient will see the message immediately.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full imsg command (everything after 'imsg'). Example: \"chats --limit 10 --json\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.imsgCommand, args, 30_000);
        try {
          return JSON.parse(stdout);
        } catch {
          return { result: stdout };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Google Docs tools
// ---------------------------------------------------------------------------

export function createDocsTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "gog_docs",
      description: [
        "Run Google Docs operations via the gog CLI: read, create, write, insert, delete (text range), export.",
        "NOTE: listing/renaming/sharing/trashing docs is under `gog drive`, NOT `gog docs` (those `docs` subcommands do not exist).",
        "Use gog_docs_update_tab instead when you already know the exact doc, tab, account, and edits.",
        "",
        "Commands:",
        "  gog docs cat <docId> [--account <email>]",
        "  gog docs read <docId> [--account <email>]",
        "    Read the full content of a document by ID.",
        "  gog docs list-tabs <docId> [--account <email>]",
        "    List every tab, including a tab's title and ID.",
        "  gog docs cat <docId> --tab '<tab title or id>' [--account <email>]",
        "    Read one explicitly selected tab. `cat` without --tab uses the document default and may not be the requested draft.",
        "  gog docs cat <docId> --all-tabs [--account <email>]",
        "    Read every tab only when the task genuinely needs all of them.",
        "",
        "Multi-tab documents: when the user names a draft, tab, version, or section, call `list-tabs` first and then use `cat --tab` with the matching title or ID. Do not claim a tab is unavailable before trying that targeted read.",
        "",
        "  gog docs create '<title>' [--account <email>]",
        "    Create a new empty Google Doc. <title> is POSITIONAL (not a --title flag).",
        "",
        "  gog docs write <docId> --text '<text>' [--append] [--account <email>]",
        "    Write content to a doc. Use --text '<text>' (NOT --content), or --file <path>. --append adds to the body instead of replacing it.",
        "",
        "  gog docs insert <docId> '<text>' [--account <email>]",
        "    Insert text. <text> is POSITIONAL (not --content).",
        "",
        "  gog docs delete <docId> --start <int> --end <int> [--account <email>]",
        "    Delete a TEXT RANGE by 1-based indices (start>=1, end>start). There is no whole-document delete here; to remove a doc use `gog drive`.",
        "",
        "  gog docs export <docId> --out <path> --format <pdf|docx|txt|md|html> [--account <email>]",
        "    Export a doc to a file. Use --out (NOT --output).",
        "",
        "Accounts are installation-specific. Common patterns are personal@example.com and work@example.com. Pass --account explicitly, choosing by context.",
        "Output: Returns CLI output in `result`. Use --json where supported for structured output.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full gog docs command (everything after 'gog'). Example: \"docs list-tabs <docId> --account work@example.com\" or \"docs cat <docId> --tab 'Draft 1' --account personal@example.com\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.gogCommand, args, 60_000, gogCommandEnv());
        return { result: stdout };
      },
    },
    {
      name: "gog_docs_update_tab",
      description: [
        "High-level Google Docs tab updater for targeted edit batches.",
        "Use this instead of many separate gog_docs reads/writes when you already know the doc, tab, and exact edits.",
        "It reads the target tab once, applies the replacement batch or full content write, then verifies the same tab before returning.",
        "",
        "Inputs:",
        "  doc: Google Doc id or full Google Docs URL",
        "  tab: tab id or full Google Docs URL with ?tab=...",
        "  account: Google account email to use",
        "  replacements?: [{ find, replace, first? }]",
        "  content?: full replacement text for the tab",
        "  verify_contains?: snippets that must appear in the verified tab after the write",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          doc: { type: "string" },
          tab: { type: "string" },
          account: { type: "string" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: { type: "string" },
                replace: { type: "string" },
                first: { type: "boolean" },
              },
              required: ["find", "replace"],
            },
          },
          content: { type: "string" },
          verify_contains: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["doc", "tab", "account"],
      },
      handler: async (input) => ({
        result: await executeGoogleDocTabUpdate(
          {
            doc: String(input.doc),
            tab: String(input.tab),
            account: String(input.account),
            replacements: Array.isArray(input.replacements)
              ? input.replacements.map((replacement) => ({
                  find: String((replacement as Record<string, unknown>).find ?? ""),
                  replace: String((replacement as Record<string, unknown>).replace ?? ""),
                  first: Boolean((replacement as Record<string, unknown>).first),
                }))
              : undefined,
            content: typeof input.content === "string" ? input.content : undefined,
            verify_contains: Array.isArray(input.verify_contains)
              ? input.verify_contains.map((value) => String(value))
              : undefined,
          },
          {
            gogCommand: paths.gogCommand,
            runCommand: (command, args, timeoutMs) => runRequiredCommand(command, args, timeoutMs, gogCommandEnv()),
          },
        ),
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// All personal tools combined
// ---------------------------------------------------------------------------

export function createAllPersonalTools(overrides?: PersonalToolPaths): AgentTool[] {
  return [
    ...createEmailTools(overrides),
    ...createSystemClockTools(),
    ...createCalendarTools(overrides),
    ...createDocsTools(overrides),
    ...createObsidianTools(overrides),
    ...createHealthBriefingTools(overrides),
    ...createFinanceTools(overrides),
    ...createReceiptRegistryTools(),
    ...createReimbursementAutomationTools(),
    ...createIMessageTools(overrides),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a shell-like command string into args, respecting single/double quotes.
 */
function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}
