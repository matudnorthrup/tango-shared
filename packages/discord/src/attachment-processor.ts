import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Collection, Attachment, Snowflake } from "discord.js";
import {
  AttachmentFileStore,
  DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES,
  resolveTangoDataDir,
  sanitizeAttachmentFilename,
  type AttachmentRecord,
  type AttachmentStore,
} from "@tango/core";

const ATTACHMENT_BASE_DIR = "/tmp/tango-attachments";
const MAX_ATTACHMENT_SIZE = DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES;
const MAX_ATTACHMENT_SIZE_MB = MAX_ATTACHMENT_SIZE / 1024 / 1024;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface ProcessedAttachment {
  discordAttachmentId: string;
  filename: string;
  localPath: string;
  contentType: string | null;
  size: number;
  type: "image" | "file";
  durable: boolean;
  logicalAttachmentId?: number;
  fileId?: number;
  sha256?: string;
}

export interface AttachmentResult {
  processed: ProcessedAttachment[];
  promptSuffix: string;
  tempDir: string | null;
}

export interface AttachmentSourceRefs {
  agentId?: string | null;
  localMessageId?: string | number | null;
  discordMessageId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AgentAttachmentAccess {
  /**
   * The agent can open a local file by path (e.g. the Claude CLI's built-in Read
   * tool), which also renders images inline. False for stateless
   * OpenAI-compatible runtimes (Ollama clones) that have no such tool.
   */
  canReadLocalFiles: boolean;
  /** The agent holds attachment_* MCP tools to fetch extracted text / OCR. */
  canUseAttachmentTools: boolean;
  /**
   * The runtime is handed inbound image bytes for this turn and folds them
   * through a vision model (the Ollama clones' qwen3-vl inline path), so the
   * image's visual content is already available without a Read tool. When true,
   * the image suffix says the image is provided rather than "you cannot view it".
   */
  canViewImagesInline?: boolean;
}

/**
 * Default access: full. Preserves behavior for the Claude CLI path and any caller
 * that does not specify capabilities.
 */
const FULL_ATTACHMENT_ACCESS: AgentAttachmentAccess = {
  canReadLocalFiles: true,
  canUseAttachmentTools: true,
};

export interface ProcessAttachmentsOptions {
  attachmentStore?: AttachmentStore | null;
  dataDir?: string | null;
  sourceRefs?: AttachmentSourceRefs;
  /**
   * What the target agent can actually do with attachments. When omitted, full
   * access is assumed. Ollama-backed clones pass reduced access so the prompt
   * suffix does not instruct a non-actionable "Read the file" step (which would
   * invite hallucinated "I read the file" responses).
   */
  agentAttachmentAccess?: AgentAttachmentAccess;
}

interface DurableAttachmentContext {
  store: AttachmentStore;
  fileStore: AttachmentFileStore;
  refs: ResolvedAttachmentSourceRefs;
}

interface ResolvedAttachmentSourceRefs {
  sessionId: string;
  agentId: string | null;
  localMessageId: string | null;
  discordMessageId: string | null;
  channelId: string | null;
  threadId: string | null;
  userId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown> | null;
}

export async function processAttachments(
  attachments: Collection<Snowflake, Attachment>,
  sessionId: string,
  options: ProcessAttachmentsOptions = {},
): Promise<AttachmentResult> {
  const items = [...attachments.values()];
  if (items.length === 0) {
    return { processed: [], promptSuffix: "", tempDir: null };
  }

  const durableContext = createDurableContext(sessionId, options);
  let tempDir: string | null = null;
  const processed: ProcessedAttachment[] = [];
  const failures: string[] = [];
  const reportFailure = (filename: string, reason: string) => {
    failures.push(`${JSON.stringify(filename)}: ${reason}`);
  };
  const sizeFailure = (bytes: number) =>
    `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB and exceeds the ${MAX_ATTACHMENT_SIZE_MB} MB per-file limit. Ask the user to compress it or split it into smaller files.`;

  for (const attachment of items) {
    const declaredContentType = normalizeContentType(attachment.contentType);
    const size = attachment.size;
    const filename = attachment.name ?? `attachment-${attachment.id}`;

    if (size > MAX_ATTACHMENT_SIZE) {
      console.warn(
        `[attachment-processor] skipping oversized attachment: ${filename} (${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_ATTACHMENT_SIZE_MB}MB)`
      );
      reportFailure(filename, sizeFailure(size));
      continue;
    }

    if (durableContext) {
      const existing = durableContext.store.findAttachmentByDiscordAttachmentId(attachment.id);
      if (existing) {
        const existingProcessed = processedFromExistingAttachment(
          durableContext.store,
          existing,
          attachment,
        );
        if (existingProcessed) {
          processed.push(existingProcessed);
        } else {
          console.warn(
            `[attachment-processor] skipping duplicate attachment without available source file: ${filename} (${attachment.id})`
          );
          reportFailure(filename, "The previously stored file is no longer available. Ask the user to upload it again.");
        }
        continue;
      }
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.warn(
          `[attachment-processor] download failed for ${filename}: HTTP ${response.status}`
        );
        reportFailure(filename, `The download failed (HTTP ${response.status}). Ask the user to upload it again.`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_ATTACHMENT_SIZE) {
        console.warn(
          `[attachment-processor] skipping oversized downloaded attachment: ${filename} (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_ATTACHMENT_SIZE_MB}MB)`
        );
        reportFailure(filename, sizeFailure(buffer.byteLength));
        continue;
      }

      const responseContentType = normalizeContentType(response.headers.get("content-type"));
      const contentType = declaredContentType ?? responseContentType;
      if (durableContext) {
        processed.push(
          persistDurableAttachment({
            context: durableContext,
            attachment,
            buffer,
            filename,
            contentType,
          }),
        );
        continue;
      }

      if (!tempDir) {
        tempDir = join(ATTACHMENT_BASE_DIR, sessionId);
        mkdirSync(tempDir, { recursive: true });
      }
      processed.push(writeTempAttachment({
        attachment,
        buffer,
        tempDir,
        filename,
        contentType,
      }));
    } catch (err) {
      console.warn(
        `[attachment-processor] download error for ${filename}: ${err instanceof Error ? err.message : err}`
      );
      reportFailure(filename, "The file could not be downloaded or stored. Ask the user to upload it again.");
    }
  }

  const promptSuffix = buildPromptSuffix(
    processed,
    options.agentAttachmentAccess ?? FULL_ATTACHMENT_ACCESS,
  ) + (failures.length > 0
    ? `\n\n[Unavailable attachments]\nThe user attached these files, but their contents are unavailable. Explain these failures to the user; do not claim no file was attached or guess its contents.\n${failures.map((failure) => `- ${failure}`).join("\n")}`
    : "");

  return { processed, promptSuffix, tempDir };
}

export function cleanupAttachments(tempDir: string | null): void {
  if (!tempDir) return;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[attachment-processor] cleanup failed for ${tempDir}: ${err instanceof Error ? err.message : err}`
    );
  }
}

function createDurableContext(
  sessionId: string,
  options: ProcessAttachmentsOptions,
): DurableAttachmentContext | null {
  if (!options.attachmentStore) {
    return null;
  }

  const refs = options.sourceRefs ?? {};
  return {
    store: options.attachmentStore,
    fileStore: new AttachmentFileStore(options.dataDir ?? resolveTangoDataDir()),
    refs: {
      sessionId,
      agentId: nullableString(refs.agentId),
      localMessageId: nullableString(refs.localMessageId),
      discordMessageId: nullableString(refs.discordMessageId),
      channelId: nullableString(refs.channelId),
      threadId: nullableString(refs.threadId),
      userId: nullableString(refs.userId),
      projectId: nullableString(refs.projectId),
      metadata: refs.metadata ?? null,
    },
  };
}

function persistDurableAttachment(input: {
  context: DurableAttachmentContext;
  attachment: Attachment;
  buffer: Buffer;
  filename: string;
  contentType: string | null;
}): ProcessedAttachment {
  const { context, attachment, buffer, filename, contentType } = input;
  const stored = context.fileStore.ingestBuffer({
    data: buffer,
    originalFilename: filename,
  });

  const existingFile = context.store.findSourceFileBySha256(stored.sha256);
  const file = existingFile ?? context.store.upsertFile({
    role: "source",
    sha256: stored.sha256,
    bytes: stored.bytes,
    contentType,
    originalFilename: stored.originalFilename,
    storagePath: stored.storagePath,
    status: "available",
    metadata: compactRecord({
      source: "discord",
      storageRelativePath: stored.relativePath,
      storedFilename: stored.storedFilename,
      sourceUrl: attachment.url,
      proxyUrl: attachment.proxyURL,
      discordAttachmentId: attachment.id,
      discordMessageId: context.refs.discordMessageId,
      channelId: context.refs.channelId,
      threadId: context.refs.threadId,
      userId: context.refs.userId,
      projectId: context.refs.projectId,
      sessionId: context.refs.sessionId,
      agentId: context.refs.agentId,
      localMessageId: context.refs.localMessageId,
    }),
  });

  const existingAttachment = context.store.findAttachmentByDiscordAttachmentId(attachment.id);
  const logical = existingAttachment ?? context.store.createAttachment({
    projectId: context.refs.projectId,
    agentId: context.refs.agentId,
    sessionId: context.refs.sessionId,
    messageId: context.refs.localMessageId,
    channelId: context.refs.channelId,
    threadId: context.refs.threadId,
    userId: context.refs.userId,
    discordAttachmentId: attachment.id,
    fileId: file.id,
    title: filename,
    originalFilename: stored.originalFilename,
    contentType,
    bytes: stored.bytes,
    status: "received",
    metadata: compactRecord({
      source: "discord",
      discordMessageId: context.refs.discordMessageId,
      discordAttachmentId: attachment.id,
      sourceUrl: attachment.url,
      proxyUrl: attachment.proxyURL,
      storagePath: file.storagePath,
      storageRelativePath: stored.relativePath,
      sha256: stored.sha256,
      sourceFileDeduped: stored.deduped || Boolean(existingFile),
      declaredBytes: attachment.size,
      sourceRefs: context.refs.metadata,
    }),
  });
  if (!existingAttachment) {
    enqueueInitialAttachmentJob(context.store, logical.id);
  }

  return toProcessedAttachment({
    attachment,
    logical,
    filename: stored.originalFilename,
    localPath: file.storagePath,
    contentType,
    size: stored.bytes,
    durable: true,
    fileId: file.id,
    sha256: file.sha256,
  });
}

function enqueueInitialAttachmentJob(store: AttachmentStore, attachmentId: number): void {
  const existingClassifyJob = store.listJobs({
    attachmentId,
    kind: "classify",
    limit: 1,
  })[0];
  if (existingClassifyJob) {
    return;
  }

  store.enqueueJob({
    attachmentId,
    kind: "classify",
    metadata: {
      queuedBy: "discord_attachment_intake",
    },
  });
}

function processedFromExistingAttachment(
  store: AttachmentStore,
  logical: AttachmentRecord,
  attachment: Attachment,
): ProcessedAttachment | null {
  if (logical.fileId === null) {
    return null;
  }

  const file = store.getFile(logical.fileId);
  if (!file || file.status !== "available") {
    return null;
  }

  const contentType = normalizeContentType(
    logical.contentType ?? file.contentType ?? attachment.contentType,
  );
  return toProcessedAttachment({
    attachment,
    logical,
    filename: logical.originalFilename ?? file.originalFilename ?? attachment.name ?? `attachment-${attachment.id}`,
    localPath: file.storagePath,
    contentType,
    size: logical.bytes ?? file.bytes,
    durable: true,
    fileId: file.id,
    sha256: file.sha256,
  });
}

function writeTempAttachment(input: {
  attachment: Attachment;
  buffer: Buffer;
  tempDir: string;
  filename: string;
  contentType: string | null;
}): ProcessedAttachment {
  const { attachment, buffer, tempDir, filename, contentType } = input;
  const safeFilename = sanitizeAttachmentFilename(filename);
  const localPath = uniqueTempPath(tempDir, safeFilename, attachment.id);
  writeFileSync(localPath, buffer, { flag: "wx" });

  return toProcessedAttachment({
    attachment,
    filename,
    localPath,
    contentType,
    size: buffer.byteLength,
    durable: false,
  });
}

function toProcessedAttachment(input: {
  attachment: Attachment;
  logical?: AttachmentRecord;
  filename: string;
  localPath: string;
  contentType: string | null;
  size: number;
  durable: boolean;
  fileId?: number;
  sha256?: string;
}): ProcessedAttachment {
  const contentType = normalizeContentType(input.contentType);
  return {
    discordAttachmentId: input.attachment.id,
    filename: input.filename,
    localPath: input.localPath,
    contentType,
    size: input.size,
    type: isImageContentType(contentType) ? "image" : "file",
    durable: input.durable,
    logicalAttachmentId: input.logical?.id,
    fileId: input.fileId,
    sha256: input.sha256,
  };
}

function buildPromptSuffix(processed: ProcessedAttachment[], access: AgentAttachmentAccess): string {
  if (processed.length === 0) return "";

  const lines = processed.map((item, index) => {
    const sizeKB = Math.max(1, Math.round(item.size / 1024));
    const contentType = item.contentType ?? "unknown";
    const ordinal = index + 1;
    const attachmentRef =
      item.logicalAttachmentId !== undefined ? `attachment:${item.logicalAttachmentId}` : null;
    const header = `${ordinal}. ${item.filename} (${contentType}, ${sizeKB}KB)`;

    if (item.type === "image") {
      if (access.canReadLocalFiles) {
        const refClause = attachmentRef ? ` Stored as ${attachmentRef}.` : "";
        return `${header} — Read the file at ${item.localPath} to view this image.${refClause}`;
      }
      if (access.canViewImagesInline) {
        const refClause = attachmentRef
          ? ` Stored as ${attachmentRef}; you may also call attachment_read for any extracted text (e.g. OCR).`
          : "";
        return `${header} — This image's visual content is provided to you with this turn; describe and act on what you see.${refClause}`;
      }
      if (access.canUseAttachmentTools && attachmentRef) {
        return `${header} — Stored as ${attachmentRef}. You cannot view images directly; call attachment_read for any text extracted from it (e.g. OCR), or attachment_status if it is still processing. Do not describe visual contents you have not read.`;
      }
      return `${header} — The user attached an image. You cannot view it directly and have no tool to read it; acknowledge the attachment rather than describing or guessing its contents.`;
    }

    if (access.canUseAttachmentTools && attachmentRef) {
      return `${header} — Stored as ${attachmentRef}. Use attachment_read for extracted text or attachment_status if it is still processing.`;
    }

    if (access.canReadLocalFiles) {
      return `${header} — Read the file at ${item.localPath}.`;
    }

    return `${header} — The user attached a file. You cannot open it directly and have no tool to read it; acknowledge the attachment rather than guessing its contents.`;
  });

  return `\n\n[Attachments]\n${lines.join("\n")}`;
}

function uniqueTempPath(tempDir: string, safeFilename: string, attachmentId: string): string {
  const preferred = join(tempDir, safeFilename);
  if (!existsSync(preferred)) {
    return preferred;
  }

  const fallback = join(tempDir, `${attachmentId}-${safeFilename}`);
  if (!existsSync(fallback)) {
    return fallback;
  }

  return join(tempDir, `${attachmentId}-${Date.now()}-${safeFilename}`);
}

function isImageContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && IMAGE_MIME_TYPES.has(contentType));
}

function normalizeContentType(contentType: string | null | undefined): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function nullableString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}
