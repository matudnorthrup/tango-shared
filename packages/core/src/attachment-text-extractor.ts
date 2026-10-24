import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder, promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AttachmentTextSourceFormat =
  | "txt"
  | "markdown"
  | "csv"
  | "tsv"
  | "json"
  | "jsonl"
  | "docx"
  | "rtf"
  | "html"
  | "pdf"
  | "unsupported";

export type AttachmentTextExtractionMethod =
  | "utf8_text"
  | "textutil"
  | "pdftotext"
  | "unsupported"
  | "read_error";

export interface ExtractAttachmentTextFileInput {
  filePath: string;
  filename?: string | null;
  contentType?: string | null;
  sourceFormat?: AttachmentTextSourceFormat;
}

export type ExtractAttachmentTextInput = string | ExtractAttachmentTextFileInput;

export interface AttachmentTextCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface AttachmentTextCommandResult {
  stdout?: string | Buffer | Uint8Array;
  stderr?: string | Buffer | Uint8Array;
  exitCode?: number | null;
  signal?: string | null;
  error?: unknown;
  commandFound?: boolean;
}

export type AttachmentTextCommandRunner = (
  command: AttachmentTextCommand,
) => Promise<AttachmentTextCommandResult>;

export interface ExtractAttachmentTextOptions {
  commandRunner?: AttachmentTextCommandRunner;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface AttachmentTextQuality {
  score: number;
  empty: boolean;
  charCount: number;
  lineCount: number;
  tokenEstimate: number;
  warningCount: number;
}

export interface AttachmentTextExtractionResult {
  method: AttachmentTextExtractionMethod;
  text: string;
  confidence: number;
  quality: AttachmentTextQuality;
  warnings: string[];
  sourceFormat: AttachmentTextSourceFormat;
  commandUsed: string | null;
  escalationRecommended: boolean;
  metadata: {
    filePath: string;
    filename: string | null;
    contentType: string | null;
    bytes: number | null;
    commandArgs?: string[];
    commandExitCode?: number | null;
    commandSignal?: string | null;
    stderr?: string;
  };
}

export interface AttachmentTextChunk {
  ordinal: number;
  text: string;
  tokenEstimate: number;
  charStart: number;
  charEnd: number;
}

export interface ChunkAttachmentTextOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_FORMATS = new Set<AttachmentTextSourceFormat>([
  "txt",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
]);
const DOCUMENT_COMMAND_FORMATS = new Set<AttachmentTextSourceFormat>([
  "docx",
  "rtf",
  "html",
]);

export const defaultAttachmentTextCommandRunner: AttachmentTextCommandRunner = async ({
  command,
  args,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
}) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
    });
    return {
      stdout,
      stderr,
      exitCode: 0,
      signal: null,
      commandFound: true,
    };
  } catch (caughtError) {
    const error = caughtError as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      signal?: string | null;
    };
    return {
      stdout: error.stdout,
      stderr: error.stderr ?? error.message,
      exitCode: typeof error.code === "number" ? error.code : null,
      signal: error.signal ?? null,
      error,
      commandFound: error.code !== "ENOENT",
    };
  }
};

export async function extractAttachmentText(
  input: ExtractAttachmentTextInput,
  options: ExtractAttachmentTextOptions = {},
): Promise<AttachmentTextExtractionResult> {
  const normalizedInput = normalizeInput(input);
  const sourceFormat =
    normalizedInput.sourceFormat ??
    detectAttachmentTextSourceFormat(normalizedInput.filename, normalizedInput.contentType);
  const bytes = await getFileSize(normalizedInput.filePath);

  if (TEXT_FORMATS.has(sourceFormat)) {
    return extractUtf8Text(normalizedInput, sourceFormat, bytes);
  }

  if (DOCUMENT_COMMAND_FORMATS.has(sourceFormat)) {
    return extractWithCommand(
      normalizedInput,
      sourceFormat,
      {
        command: "textutil",
        args: ["-convert", "txt", "-stdout", normalizedInput.filePath],
      },
      "textutil",
      bytes,
      options,
    );
  }

  if (sourceFormat === "pdf") {
    return extractWithCommand(
      normalizedInput,
      sourceFormat,
      {
        command: "pdftotext",
        args: ["-layout", "-enc", "UTF-8", normalizedInput.filePath, "-"],
      },
      "pdftotext",
      bytes,
      options,
    );
  }

  return buildExtractionResult({
    input: normalizedInput,
    sourceFormat,
    method: "unsupported",
    text: "",
    bytes,
    warnings: ["unsupported_source_format"],
    supported: false,
    baseConfidence: 0,
  });
}

export function detectAttachmentTextSourceFormat(
  filename?: string | null,
  contentType?: string | null,
): AttachmentTextSourceFormat {
  const extension = filename ? path.extname(filename).toLowerCase() : "";
  switch (extension) {
    case ".txt":
    case ".text":
      return "txt";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".csv":
      return "csv";
    case ".tsv":
    case ".tab":
      return "tsv";
    case ".json":
      return "json";
    case ".jsonl":
    case ".ndjson":
      return "jsonl";
    case ".docx":
      return "docx";
    case ".rtf":
      return "rtf";
    case ".htm":
    case ".html":
      return "html";
    case ".pdf":
      return "pdf";
  }

  const normalizedContentType = normalizeContentType(contentType);
  switch (normalizedContentType) {
    case "text/plain":
      return "txt";
    case "text/markdown":
    case "text/x-markdown":
      return "markdown";
    case "text/csv":
    case "application/csv":
      return "csv";
    case "text/tab-separated-values":
      return "tsv";
    case "application/json":
    case "text/json":
      return "json";
    case "application/jsonl":
    case "application/x-jsonlines":
    case "application/x-ndjson":
      return "jsonl";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/rtf":
    case "text/rtf":
      return "rtf";
    case "text/html":
      return "html";
    case "application/pdf":
      return "pdf";
    default:
      return "unsupported";
  }
}

export function normalizeExtractedText(text: string): string {
  const withoutBom = text.replace(/^\uFEFF/u, "");
  const withLineFeeds = withoutBom.replace(/\r\n?/gu, "\n");
  const withoutNuls = withLineFeeds.replace(/\u0000/gu, "");
  const withSpaces = withoutNuls.replace(/\u00A0/gu, " ");
  return withSpaces
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function estimateTextTokens(text: string): number {
  const normalized = normalizeExtractedText(text);
  if (normalized.length === 0) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function chunkAttachmentText(
  text: string,
  options: ChunkAttachmentTextOptions = {},
): AttachmentTextChunk[] {
  const normalized = normalizeExtractedText(text);
  if (normalized.length === 0) return [];

  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? 800));
  const overlapTokens = Math.max(0, Math.floor(options.overlapTokens ?? 80));
  const maxChars = maxTokens * 4;
  const overlapChars = Math.min(overlapTokens * 4, Math.max(0, maxChars - 1));
  const chunks: AttachmentTextChunk[] = [];
  let start = 0;

  while (start < normalized.length) {
    const hardEnd = Math.min(normalized.length, start + maxChars);
    const end = chooseChunkEnd(normalized, start, hardEnd);
    const chunkText = normalized.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        ordinal: chunks.length,
        text: chunkText,
        tokenEstimate: estimateTextTokens(chunkText),
        charStart: start,
        charEnd: end,
      });
    }

    if (end >= normalized.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
}

async function extractUtf8Text(
  input: NormalizedExtractAttachmentTextInput,
  sourceFormat: AttachmentTextSourceFormat,
  bytes: number | null,
): Promise<AttachmentTextExtractionResult> {
  const warnings: string[] = [];
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(input.filePath);
  } catch {
    return buildExtractionResult({
      input,
      sourceFormat,
      method: "read_error",
      text: "",
      bytes,
      warnings: ["file_read_failed"],
      supported: false,
      baseConfidence: 0,
    });
  }

  if (buffer.includes(0)) {
    warnings.push("binary_null_bytes_removed");
  }

  let text: string;
  try {
    text = TEXT_DECODER.decode(buffer);
  } catch {
    warnings.push("invalid_utf8_replaced");
    text = buffer.toString("utf8");
  }

  return buildExtractionResult({
    input,
    sourceFormat,
    method: "utf8_text",
    text,
    bytes,
    warnings,
    supported: true,
    baseConfidence: warnings.length > 0 ? 0.85 : 0.95,
  });
}

async function extractWithCommand(
  input: NormalizedExtractAttachmentTextInput,
  sourceFormat: AttachmentTextSourceFormat,
  command: Pick<AttachmentTextCommand, "command" | "args">,
  method: Extract<AttachmentTextExtractionMethod, "textutil" | "pdftotext">,
  bytes: number | null,
  options: ExtractAttachmentTextOptions,
): Promise<AttachmentTextExtractionResult> {
  const commandRunner = options.commandRunner ?? defaultAttachmentTextCommandRunner;
  const commandRequest: AttachmentTextCommand = {
    ...command,
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  };

  let result: AttachmentTextCommandResult;
  try {
    result = await commandRunner(commandRequest);
  } catch (caughtError) {
    return buildExtractionResult({
      input,
      sourceFormat,
      method,
      text: "",
      bytes,
      warnings: commandErrorWarnings(command.command, {
        error: caughtError,
        commandFound: commandFoundFromError(caughtError),
      }),
      commandUsed: command.command,
      commandArgs: command.args,
      supported: true,
      baseConfidence: 0,
    });
  }

  const exitCode = result.exitCode ?? null;
  const stderr = commandOutputToString(result.stderr);
  const warnings = commandErrorWarnings(command.command, result);
  const text = warnings.length === 0 ? commandOutputToString(result.stdout) : "";

  return buildExtractionResult({
    input,
    sourceFormat,
    method,
    text,
    bytes,
    warnings,
    commandUsed: command.command,
    commandArgs: command.args,
    commandExitCode: exitCode,
    commandSignal: result.signal ?? null,
    stderr: truncate(stderr),
    supported: true,
    baseConfidence: method === "textutil" ? 0.8 : 0.72,
  });
}

interface NormalizedExtractAttachmentTextInput {
  filePath: string;
  filename: string | null;
  contentType: string | null;
  sourceFormat?: AttachmentTextSourceFormat;
}

interface BuildExtractionResultInput {
  input: NormalizedExtractAttachmentTextInput;
  sourceFormat: AttachmentTextSourceFormat;
  method: AttachmentTextExtractionMethod;
  text: string;
  bytes: number | null;
  warnings: string[];
  supported: boolean;
  baseConfidence: number;
  commandUsed?: string | null;
  commandArgs?: string[];
  commandExitCode?: number | null;
  commandSignal?: string | null;
  stderr?: string;
}

function buildExtractionResult({
  input,
  sourceFormat,
  method,
  text,
  bytes,
  warnings,
  supported,
  baseConfidence,
  commandUsed = null,
  commandArgs,
  commandExitCode,
  commandSignal,
  stderr,
}: BuildExtractionResultInput): AttachmentTextExtractionResult {
  const normalizedText = normalizeExtractedText(text);
  const dedupedWarnings = uniqueWarnings(
    normalizedText.length === 0 ? [...warnings, "extraction_empty"] : warnings,
  );
  const quality = buildQuality(normalizedText, dedupedWarnings, supported, baseConfidence);

  return {
    method,
    text: normalizedText,
    confidence: quality.score,
    quality,
    warnings: dedupedWarnings,
    sourceFormat,
    commandUsed,
    escalationRecommended: !supported || quality.empty,
    metadata: {
      filePath: input.filePath,
      filename: input.filename,
      contentType: input.contentType,
      bytes,
      ...(commandArgs ? { commandArgs } : {}),
      ...(commandExitCode !== undefined ? { commandExitCode } : {}),
      ...(commandSignal !== undefined ? { commandSignal } : {}),
      ...(stderr ? { stderr } : {}),
    },
  };
}

function buildQuality(
  text: string,
  warnings: string[],
  supported: boolean,
  baseConfidence: number,
): AttachmentTextQuality {
  const empty = text.length === 0;
  const lineCount = empty ? 0 : text.split("\n").length;
  const tokenEstimate = estimateTextTokens(text);
  const score =
    empty || !supported
      ? 0
      : roundQualityScore(Math.max(0, baseConfidence - Math.min(0.3, warnings.length * 0.05)));

  return {
    score,
    empty,
    charCount: text.length,
    lineCount,
    tokenEstimate,
    warningCount: warnings.length,
  };
}

function normalizeInput(input: ExtractAttachmentTextInput): NormalizedExtractAttachmentTextInput {
  if (typeof input === "string") {
    return {
      filePath: input,
      filename: path.basename(input),
      contentType: null,
    };
  }

  return {
    filePath: input.filePath,
    filename: input.filename ?? path.basename(input.filePath),
    contentType: input.contentType ?? null,
    sourceFormat: input.sourceFormat,
  };
}

async function getFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

function normalizeContentType(contentType?: string | null): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function commandErrorWarnings(
  command: string,
  result: Pick<AttachmentTextCommandResult, "exitCode" | "commandFound" | "error">,
): string[] {
  if (result.commandFound === false) {
    return [`command_unavailable:${command}`];
  }
  if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0) {
    return [`command_failed:${command}`];
  }
  if (result.error && (result.exitCode === undefined || result.exitCode === null)) {
    return [`command_error:${command}`];
  }
  return [];
}

function commandFoundFromError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code !== "ENOENT";
}

function commandOutputToString(output: string | Buffer | Uint8Array | undefined): string {
  if (output === undefined) return "";
  if (typeof output === "string") return output;
  if (Buffer.isBuffer(output)) return output.toString("utf8");
  return Buffer.from(output).toString("utf8");
}

function chooseChunkEnd(text: string, start: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;
  const minimumEnd = start + Math.floor((hardEnd - start) * 0.5);
  const window = text.slice(minimumEnd, hardEnd);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak >= 0) {
    return minimumEnd + paragraphBreak + 2;
  }
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= 0) {
    return minimumEnd + lineBreak + 1;
  }
  const space = window.lastIndexOf(" ");
  if (space >= 0) {
    return minimumEnd + space + 1;
  }
  return hardEnd;
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

function roundQualityScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function truncate(value: string, maxLength = 2_000): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
