import {
  APPLE_VISION_OCR_METHOD,
  runAppleVisionOcr,
} from "./apple-vision-ocr.js";
import {
  ATTACHMENT_DIRECTORY_SCHEMA,
  ATTACHMENT_DIRECTORY_SCHEMA_VERSION,
  buildAttachmentDirectory,
} from "./attachment-directory.js";
import {
  LLM_VISION_FALLBACK_METHOD,
  LLM_VISION_FALLBACK_PROMPT_VERSION,
  type AttachmentLlmFallbackRunner,
} from "./attachment-llm-fallback.js";
import {
  classifyAttachment,
  type AttachmentClassificationResult,
  type AttachmentClassifierSettings,
} from "./attachment-classifier.js";
import {
  chunkAttachmentText,
  extractAttachmentText,
} from "./attachment-text-extractor.js";
import type {
  AttachmentJobHandler,
  AttachmentJobHandlerRegistry,
} from "./attachment-worker.js";
import type {
  AttachmentExtractionRecord,
  AttachmentFileRecord,
  AttachmentJobKind,
  AttachmentJobRecord,
  AttachmentRecord,
  AttachmentStore,
} from "./attachments-store.js";

export interface AttachmentProcessingHandlersOptions {
  classifierSettings?: AttachmentClassifierSettings;
  extractText?: typeof extractAttachmentText;
  runOcr?: typeof runAppleVisionOcr;
  runLlmFallback?: AttachmentLlmFallbackRunner | null;
  chunkMaxTokens?: number;
  chunkOverlapTokens?: number;
}

interface AttachmentWithFile {
  attachment: AttachmentRecord;
  file: AttachmentFileRecord;
  filePath: string;
}

const DEFAULT_CHUNK_MAX_TOKENS = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 80;

export function createAttachmentProcessingHandlers(
  options: AttachmentProcessingHandlersOptions = {},
): AttachmentJobHandlerRegistry {
  const extractText = options.extractText ?? extractAttachmentText;
  const runOcr = options.runOcr ?? runAppleVisionOcr;
  const runLlmFallback = options.runLlmFallback ?? null;

  return {
    classify: createClassifyHandler(options),
    embedded_text: createEmbeddedTextHandler({ extractText, runLlmFallback }),
    apple_ocr: createAppleOcrHandler({ runOcr, runLlmFallback }),
    chunk: createChunkHandler(options),
    directory: createDirectoryHandler(),
    retention_review: createRetentionReviewHandler(),
    llm_fallback: createLlmFallbackHandler({ runLlmFallback }),
  };
}

function createClassifyHandler(
  options: AttachmentProcessingHandlersOptions,
): AttachmentJobHandler {
  return (job, { store }) => {
    const { attachment } = requireAttachmentWithFile(store, job);
    const classification = classifyAttachment(
      {
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.bytes,
        sourceMetadata: attachment.metadata,
      },
      options.classifierSettings,
    );
    const queuedJobs = enqueueFirstProcessingJob(store, job, classification);

    store.updateAttachmentStatus(attachment.id, "processing", {
      metadata: mergeMetadata(attachment.metadata, {
        classification,
        attachmentProcessing: {
          plannedJobs: classification.recommendedJobs,
          queuedJobs,
        },
      }),
    });

    return {
      metadata: {
        classification,
        queuedJobs,
      },
      attachmentStatus: queuedJobs.length > 0 ? undefined : "partial",
    };
  };
}

function createEmbeddedTextHandler(input: {
  extractText: typeof extractAttachmentText;
  runLlmFallback: AttachmentLlmFallbackRunner | null;
}): AttachmentJobHandler {
  return async (job, { store }) => {
    const { attachment, filePath } = requireAttachmentWithFile(store, job);
    const result = await input.extractText({
      filePath,
      filename: attachment.originalFilename,
      contentType: attachment.contentType,
    });
    const extraction = store.addExtraction({
      attachmentId: attachment.id,
      method: result.method,
      text: result.text,
      confidence: result.confidence,
      quality: { ...result.quality },
      metadata: {
        sourceFormat: result.sourceFormat,
        warnings: result.warnings,
        commandUsed: result.commandUsed,
        escalationRecommended: result.escalationRecommended,
        ...result.metadata,
      },
    });

    const queuedJobs = enqueuePostExtractionJobs(store, job, result.text, {
      allowLlmFallback: Boolean(input.runLlmFallback),
      escalationRecommended: result.escalationRecommended,
      escalationReason: result.warnings.includes("extraction_empty")
        ? "empty_embedded_text"
        : "embedded_text_escalation_recommended",
      previousExtractionId: extraction.id,
    });
    return {
      metadata: {
        extractionId: extraction.id,
        method: result.method,
        quality: result.quality,
        warnings: result.warnings,
        escalationRecommended: result.escalationRecommended,
        queuedJobs,
      },
    };
  };
}

function createAppleOcrHandler(input: {
  runOcr: typeof runAppleVisionOcr;
  runLlmFallback: AttachmentLlmFallbackRunner | null;
}): AttachmentJobHandler {
  return async (job, { store }) => {
    const { attachment, filePath } = requireAttachmentWithFile(store, job);
    const result = await input.runOcr({
      imagePath: filePath,
      sourceRef: `attachment:${attachment.id}`,
    });
    const extraction = store.addExtraction({
      attachmentId: attachment.id,
      method: result.method,
      text: result.text,
      confidence: result.confidence,
      quality: { ...result.quality },
      metadata: {
        lines: result.lines,
        warnings: result.warnings,
        escalation: result.escalation,
        available: result.available,
        ...result.metadata,
      },
    });

    const queuedJobs = enqueuePostExtractionJobs(store, job, result.text, {
      allowLlmFallback: Boolean(input.runLlmFallback),
      escalationRecommended: result.escalation.recommended,
      escalationReason: result.escalation.reason,
      previousExtractionId: extraction.id,
    });
    return {
      metadata: {
        extractionId: extraction.id,
        method: APPLE_VISION_OCR_METHOD,
        quality: result.quality,
        warnings: result.warnings,
        escalation: result.escalation,
        queuedJobs,
      },
    };
  };
}

function createChunkHandler(
  options: AttachmentProcessingHandlersOptions,
): AttachmentJobHandler {
  return (job, { store }) => {
    const attachment = requireAttachment(store, job);
    const extraction = latestTextExtraction(store, attachment.id);
    if (!extraction || extraction.text.trim().length === 0) {
      const queuedJobs = enqueueMissingJobs(store, job, ["directory"]);
      return {
        metadata: {
          skipped: true,
          reason: "no_extraction_text",
          queuedJobs,
        },
      };
    }

    const existingChunks = store.listChunks(attachment.id);
    if (existingChunks.length > 0) {
      const queuedJobs = enqueueMissingJobs(store, job, ["directory"]);
      return {
        metadata: {
          skipped: true,
          reason: "chunks_already_exist",
          extractionId: extraction.id,
          chunkCount: existingChunks.length,
          queuedJobs,
        },
      };
    }

    const chunks = chunkAttachmentText(extraction.text, {
      maxTokens: options.chunkMaxTokens ?? DEFAULT_CHUNK_MAX_TOKENS,
      overlapTokens: options.chunkOverlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS,
    });
    const records = chunks.map((chunk) =>
      store.addChunk({
        attachmentId: attachment.id,
        extractionId: extraction.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        tokenEstimate: chunk.tokenEstimate,
        metadata: {
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
        },
      }),
    );
    const queuedJobs = enqueueMissingJobs(store, job, ["directory"]);

    return {
      metadata: {
        extractionId: extraction.id,
        chunkCount: records.length,
        queuedJobs,
      },
    };
  };
}

function createDirectoryHandler(): AttachmentJobHandler {
  return (job, { store }) => {
    const attachment = requireAttachment(store, job);
    const file = attachment.fileId === null ? null : store.getFile(attachment.fileId);
    const extraction = latestExtraction(store, attachment.id);
    const chunks = store.listChunks(attachment.id);
    const hasText = Boolean(extraction?.text.trim());
    const status = hasText ? "ready" : "failed";
    // T-I-125 Phase 1: attachment_reprocess threads an optional context_hint
    // into THIS job's metadata (only when the reprocess call chose the
    // `directory` strategy directly — see the tool's doc comment). No hint
    // in metadata = contextHint stays null = buildAttachmentDirectory's
    // output is byte-identical to pre-T-I-125 behavior.
    const contextHint = readJobContextHint(job.metadata);
    const directory = buildAttachmentDirectory({
      attachment,
      file,
      extraction,
      chunks,
      status: hasText ? "ready" : "partial",
      contextHint,
    });

    const record = store.addDirectory({
      attachmentId: attachment.id,
      schemaVersion: ATTACHMENT_DIRECTORY_SCHEMA_VERSION,
      projectId: attachment.projectId,
      agentId: attachment.agentId,
      sessionId: attachment.sessionId,
      messageId: attachment.messageId,
      channelId: attachment.channelId,
      threadId: attachment.threadId,
      userId: attachment.userId,
      status,
      directory,
      metadata: {
        schema: ATTACHMENT_DIRECTORY_SCHEMA,
        generatedBy: "attachment-processing",
        extractionId: extraction?.id ?? null,
        chunkCount: chunks.length,
      },
    });

    return {
      attachmentStatus: hasText ? "ready" : "partial",
      metadata: {
        directoryId: record.id,
        schemaVersion: record.schemaVersion,
        status: record.status,
        chunkCount: chunks.length,
      },
    };
  };
}

function createRetentionReviewHandler(): AttachmentJobHandler {
  return (job, { store }) => {
    const attachment = requireAttachment(store, job);
    const decision = store.addRetentionDecision({
      attachmentId: attachment.id,
      decision: "review",
      status: "proposed",
      decidedBy: "attachment-processing",
      reason: "Attachment is unsupported, oversized, or needs manual retention review.",
      metadata: {
        jobId: job.id,
        jobMetadata: job.metadata,
        attachmentClassification: attachment.metadata?.classification ?? null,
      },
    });

    return {
      attachmentStatus: "partial",
      metadata: {
        retentionDecisionId: decision.id,
        decision: decision.decision,
        status: decision.status,
      },
    };
  };
}

function createLlmFallbackHandler(input: {
  runLlmFallback: AttachmentLlmFallbackRunner | null;
}): AttachmentJobHandler {
  return async (job, { store }) => {
    const { attachment, file, filePath } = requireAttachmentWithFile(store, job);
    const previousExtraction = latestExtraction(store, attachment.id);
    const reason = inferLlmFallbackReason(job, previousExtraction);

    if (!input.runLlmFallback) {
      const queuedJobs = enqueueMissingJobs(store, job, ["directory"], {
        reason: "llm_fallback_not_configured",
        previousExtractionId: previousExtraction?.id ?? null,
      });
      return {
        attachmentStatus: "partial",
        metadata: {
          skipped: true,
          reason: "llm_fallback_not_configured",
          jobId: job.id,
          queuedJobs,
          previousExtractionId: previousExtraction?.id ?? null,
        },
      };
    }

    const result = await input.runLlmFallback({
      attachment,
      file,
      filePath,
      job,
      previousExtraction,
      reason,
    });

    const extraction = store.addExtraction({
      attachmentId: attachment.id,
      method: result.method,
      text: result.text,
      confidence: result.confidence,
      quality: { ...result.quality },
      metadata: {
        promptVersion: LLM_VISION_FALLBACK_PROMPT_VERSION,
        fallbackReason: reason,
        previousExtractionId: previousExtraction?.id ?? null,
        structuredOutput: result.structuredOutput,
        warnings: result.warnings,
        ...result.metadata,
      },
    });
    const queuedJobs = enqueuePostExtractionJobs(store, job, result.text, {
      allowLlmFallback: false,
      escalationRecommended: false,
      escalationReason: "llm_fallback_completed",
      previousExtractionId: extraction.id,
    });

    return {
      metadata: {
        extractionId: extraction.id,
        method: LLM_VISION_FALLBACK_METHOD,
        confidence: result.confidence,
        quality: result.quality,
        warnings: result.warnings,
        previousExtractionId: previousExtraction?.id ?? null,
        queuedJobs,
      },
    };
  };
}

function requireAttachmentWithFile(
  store: AttachmentStore,
  job: AttachmentJobRecord,
): AttachmentWithFile {
  const attachment = requireAttachment(store, job);
  if (attachment.fileId === null) {
    throw new Error(`Attachment ${attachment.id} has no source file`);
  }

  const file = store.getFile(attachment.fileId);
  if (!file || file.status !== "available") {
    throw new Error(`Attachment ${attachment.id} source file is not available`);
  }

  return { attachment, file, filePath: file.storagePath };
}

function readJobContextHint(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.contextHint;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireAttachment(store: AttachmentStore, job: AttachmentJobRecord): AttachmentRecord {
  const attachment = store.getAttachment(job.attachmentId);
  if (!attachment) {
    throw new Error(`Attachment ${job.attachmentId} not found for job ${job.id}`);
  }
  return attachment;
}

function enqueueFirstProcessingJob(
  store: AttachmentStore,
  job: AttachmentJobRecord,
  classification: AttachmentClassificationResult,
): AttachmentJobKind[] {
  const firstKind = classification.recommendedJobs.find(
    (kind) => kind !== "classify" && kind !== "chunk" && kind !== "directory",
  );
  if (!firstKind) return [];

  return enqueueMissingJobs(store, job, [firstKind], {
    classification: classification.classification,
    classificationType: classification.type,
    reason:
      classification.jobRecommendations.find((entry) => entry.kind === firstKind)?.reason ?? null,
    possibleEscalationJobs: classification.possibleEscalationJobs,
  });
}

function enqueuePostExtractionJobs(
  store: AttachmentStore,
  job: AttachmentJobRecord,
  text: string,
  options: {
    allowLlmFallback?: boolean;
    escalationRecommended?: boolean;
    escalationReason?: string;
    previousExtractionId?: number | null;
  } = {},
): AttachmentJobKind[] {
  if (options.allowLlmFallback && options.escalationRecommended) {
    return enqueueMissingJobs(store, job, ["llm_fallback"], {
      reason: options.escalationReason ?? "extraction_escalation_recommended",
      previousExtractionId: options.previousExtractionId ?? null,
    });
  }

  if (text.trim().length === 0) {
    return enqueueMissingJobs(store, job, ["directory"], {
      reason: "extraction_empty",
    });
  }

  return enqueueMissingJobs(store, job, ["chunk"], {
    reason: "extraction_text_available",
  });
}

function enqueueMissingJobs(
  store: AttachmentStore,
  job: AttachmentJobRecord,
  kinds: AttachmentJobKind[],
  metadata: Record<string, unknown> = {},
): AttachmentJobKind[] {
  const queued: AttachmentJobKind[] = [];
  for (const kind of kinds) {
    if (hasExistingJob(store, job, kind)) continue;
    store.enqueueJob({
      attachmentId: job.attachmentId,
      kind,
      metadata: {
        queuedByJobId: job.id,
        ...metadata,
      },
    });
    queued.push(kind);
  }
  return queued;
}

function hasExistingJob(
  store: AttachmentStore,
  currentJob: AttachmentJobRecord,
  kind: AttachmentJobKind,
): boolean {
  return store
    .listJobs({ attachmentId: currentJob.attachmentId, kind, limit: 100 })
    .some((job) => job.id !== currentJob.id && job.status !== "canceled");
}

function latestTextExtraction(
  store: AttachmentStore,
  attachmentId: number,
): AttachmentExtractionRecord | null {
  const extractions = store
    .listExtractions(attachmentId)
    .filter((extraction) => extraction.text.trim().length > 0);
  return extractions.at(-1) ?? null;
}

function latestExtraction(
  store: AttachmentStore,
  attachmentId: number,
): AttachmentExtractionRecord | null {
  return store.listExtractions(attachmentId).at(-1) ?? null;
}

function inferLlmFallbackReason(
  job: AttachmentJobRecord,
  previousExtraction: AttachmentExtractionRecord | null,
): string {
  if (typeof job.metadata?.reason === "string" && job.metadata.reason.trim().length > 0) {
    return job.metadata.reason.trim();
  }

  const escalation = previousExtraction?.metadata?.escalation;
  if (escalation && typeof escalation === "object" && "reason" in escalation) {
    const reason = (escalation as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim().length > 0) {
      return reason.trim();
    }
  }

  if (previousExtraction?.quality && typeof previousExtraction.quality === "object") {
    const quality = previousExtraction.quality as { empty?: unknown; lowConfidence?: unknown };
    if (quality.empty === true) return "previous_extraction_empty";
    if (quality.lowConfidence === true) return "previous_extraction_low_confidence";
  }

  return "llm_fallback_requested";
}

function mergeMetadata(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(current ?? {}),
    ...next,
  };
}
