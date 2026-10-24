import type { AttachmentJobKind } from "./attachments-store.js";

export const DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES = 100 * 1024 * 1024;

export type AttachmentType =
  | "image"
  | "pdf"
  | "text"
  | "document"
  | "spreadsheet_text"
  | "unsupported";

export type AttachmentClassification =
  | "image"
  | "pdf"
  | "text"
  | "markdown"
  | "csv"
  | "tsv"
  | "document"
  | "spreadsheet_text"
  | "unsupported_media"
  | "unsupported_archive"
  | "unsupported_other";

export type AttachmentUnsupportedCode =
  | "too_large"
  | "unsupported_media"
  | "unsupported_archive"
  | "unsupported_other";

export interface AttachmentClassifierInput {
  originalFilename?: string | null;
  filename?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  bytes?: number | null;
  sourceMetadata?: Record<string, unknown> | null;
}

export interface AttachmentClassifierSettings {
  maxBytes?: number | null;
  includeClassifyJob?: boolean;
  allowLlmFallback?: boolean;
  enqueueRetentionReviewForUnsupported?: boolean;
  enqueueRetentionReviewForOversized?: boolean;
}

export interface AttachmentJobRecommendation {
  kind: AttachmentJobKind;
  reason: string;
}

export interface AttachmentClassificationResult {
  classification: AttachmentClassification;
  type: AttachmentType;
  supported: boolean;
  normalizedContentType: string | null;
  reportedContentType: string | null;
  inferredContentType: string | null;
  extension: string | null;
  byteSize: number | null;
  recommendedJobs: AttachmentJobKind[];
  jobRecommendations: AttachmentJobRecommendation[];
  possibleEscalationJobs: AttachmentJobKind[];
  escalationRecommendations: AttachmentJobRecommendation[];
  unsupportedReason: string | null;
  unsupportedCode: AttachmentUnsupportedCode | null;
  rationale: string[];
}

interface ClassificationDescriptor {
  classification: AttachmentClassification;
  type: AttachmentType;
  canonicalContentType: string | null;
  label: string;
}

interface ResolvedClassification {
  descriptor: ClassificationDescriptor;
  selectedBy: "content_type" | "extension" | "fallback";
}

interface NormalizedSettings {
  maxBytes: number | null;
  includeClassifyJob: boolean;
  allowLlmFallback: boolean;
  enqueueRetentionReviewForUnsupported: boolean;
  enqueueRetentionReviewForOversized: boolean;
}

const DESCRIPTORS = {
  image: {
    classification: "image",
    type: "image",
    canonicalContentType: "image/png",
    label: "image",
  },
  pdf: {
    classification: "pdf",
    type: "pdf",
    canonicalContentType: "application/pdf",
    label: "PDF",
  },
  text: {
    classification: "text",
    type: "text",
    canonicalContentType: "text/plain",
    label: "plain text",
  },
  markdown: {
    classification: "markdown",
    type: "text",
    canonicalContentType: "text/markdown",
    label: "Markdown",
  },
  csv: {
    classification: "csv",
    type: "spreadsheet_text",
    canonicalContentType: "text/csv",
    label: "CSV",
  },
  tsv: {
    classification: "tsv",
    type: "spreadsheet_text",
    canonicalContentType: "text/tab-separated-values",
    label: "TSV",
  },
  document: {
    classification: "document",
    type: "document",
    canonicalContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "document",
  },
  spreadsheetText: {
    classification: "spreadsheet_text",
    type: "spreadsheet_text",
    canonicalContentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "spreadsheet-like text",
  },
  unsupportedMedia: {
    classification: "unsupported_media",
    type: "unsupported",
    canonicalContentType: null,
    label: "unsupported media",
  },
  unsupportedArchive: {
    classification: "unsupported_archive",
    type: "unsupported",
    canonicalContentType: null,
    label: "unsupported archive",
  },
  unsupportedOther: {
    classification: "unsupported_other",
    type: "unsupported",
    canonicalContentType: null,
    label: "unsupported attachment",
  },
} as const satisfies Record<string, ClassificationDescriptor>;

const MIME_CLASSIFICATIONS: Record<string, ClassificationDescriptor> = {
  "application/csv": DESCRIPTORS.csv,
  "application/json": DESCRIPTORS.text,
  "application/msword": DESCRIPTORS.document,
  "application/pdf": DESCRIPTORS.pdf,
  "application/rtf": DESCRIPTORS.document,
  "application/vnd.ms-excel": DESCRIPTORS.spreadsheetText,
  "application/vnd.ms-excel.sheet.macroenabled.12": DESCRIPTORS.spreadsheetText,
  "application/vnd.oasis.opendocument.spreadsheet": DESCRIPTORS.spreadsheetText,
  "application/vnd.oasis.opendocument.text": DESCRIPTORS.document,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    DESCRIPTORS.document,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    DESCRIPTORS.spreadsheetText,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    DESCRIPTORS.document,
  "application/x-csv": DESCRIPTORS.csv,
  "application/x-ndjson": DESCRIPTORS.text,
  "application/x-rtf": DESCRIPTORS.document,
  "application/x-yaml": DESCRIPTORS.text,
  "application/xml": DESCRIPTORS.text,
  "application/yaml": DESCRIPTORS.text,
  "text/csv": DESCRIPTORS.csv,
  "text/html": DESCRIPTORS.text,
  "text/markdown": DESCRIPTORS.markdown,
  "text/plain": DESCRIPTORS.text,
  "text/rtf": DESCRIPTORS.document,
  "text/tab-separated-values": DESCRIPTORS.tsv,
  "text/x-csv": DESCRIPTORS.csv,
  "text/x-markdown": DESCRIPTORS.markdown,
  "text/xml": DESCRIPTORS.text,
  "text/yaml": DESCRIPTORS.text,
};

const EXTENSION_CLASSIFICATIONS: Record<string, ClassificationDescriptor> = {
  bmp: { ...DESCRIPTORS.image, canonicalContentType: "image/bmp" },
  conf: DESCRIPTORS.text,
  css: { ...DESCRIPTORS.text, canonicalContentType: "text/css" },
  csv: DESCRIPTORS.csv,
  doc: { ...DESCRIPTORS.document, canonicalContentType: "application/msword" },
  docx: DESCRIPTORS.document,
  env: DESCRIPTORS.text,
  gif: { ...DESCRIPTORS.image, canonicalContentType: "image/gif" },
  heic: { ...DESCRIPTORS.image, canonicalContentType: "image/heic" },
  heif: { ...DESCRIPTORS.image, canonicalContentType: "image/heif" },
  htm: { ...DESCRIPTORS.text, canonicalContentType: "text/html" },
  html: { ...DESCRIPTORS.text, canonicalContentType: "text/html" },
  ini: DESCRIPTORS.text,
  jpeg: { ...DESCRIPTORS.image, canonicalContentType: "image/jpeg" },
  jpg: { ...DESCRIPTORS.image, canonicalContentType: "image/jpeg" },
  js: { ...DESCRIPTORS.text, canonicalContentType: "text/javascript" },
  json: { ...DESCRIPTORS.text, canonicalContentType: "application/json" },
  jsonl: { ...DESCRIPTORS.text, canonicalContentType: "application/x-ndjson" },
  log: DESCRIPTORS.text,
  markdown: DESCRIPTORS.markdown,
  md: DESCRIPTORS.markdown,
  mdown: DESCRIPTORS.markdown,
  mkdn: DESCRIPTORS.markdown,
  ndjson: { ...DESCRIPTORS.text, canonicalContentType: "application/x-ndjson" },
  ods: {
    ...DESCRIPTORS.spreadsheetText,
    canonicalContentType: "application/vnd.oasis.opendocument.spreadsheet",
  },
  odt: {
    ...DESCRIPTORS.document,
    canonicalContentType: "application/vnd.oasis.opendocument.text",
  },
  pdf: DESCRIPTORS.pdf,
  png: DESCRIPTORS.image,
  ppt: { ...DESCRIPTORS.document, canonicalContentType: "application/vnd.ms-powerpoint" },
  pptx: {
    ...DESCRIPTORS.document,
    canonicalContentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  psv: { ...DESCRIPTORS.spreadsheetText, canonicalContentType: "text/plain" },
  rtf: { ...DESCRIPTORS.document, canonicalContentType: "application/rtf" },
  sql: DESCRIPTORS.text,
  ssv: { ...DESCRIPTORS.spreadsheetText, canonicalContentType: "text/plain" },
  svg: { ...DESCRIPTORS.image, canonicalContentType: "image/svg+xml" },
  tab: DESCRIPTORS.tsv,
  text: DESCRIPTORS.text,
  tif: { ...DESCRIPTORS.image, canonicalContentType: "image/tiff" },
  tiff: { ...DESCRIPTORS.image, canonicalContentType: "image/tiff" },
  ts: { ...DESCRIPTORS.text, canonicalContentType: "text/plain" },
  tsx: { ...DESCRIPTORS.text, canonicalContentType: "text/plain" },
  tsv: DESCRIPTORS.tsv,
  txt: DESCRIPTORS.text,
  webp: { ...DESCRIPTORS.image, canonicalContentType: "image/webp" },
  xls: { ...DESCRIPTORS.spreadsheetText, canonicalContentType: "application/vnd.ms-excel" },
  xlsx: DESCRIPTORS.spreadsheetText,
  xml: { ...DESCRIPTORS.text, canonicalContentType: "application/xml" },
  yaml: { ...DESCRIPTORS.text, canonicalContentType: "application/yaml" },
  yml: { ...DESCRIPTORS.text, canonicalContentType: "application/yaml" },
};

const MEDIA_EXTENSIONS = new Set([
  "aac",
  "avi",
  "flac",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
]);

const ARCHIVE_EXTENSIONS = new Set([
  "7z",
  "bz2",
  "dmg",
  "gz",
  "iso",
  "rar",
  "tar",
  "tgz",
  "xz",
  "zip",
  "zst",
]);

const ARCHIVE_CONTENT_TYPES = new Set([
  "application/gzip",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/x-xz",
  "application/zip",
  "application/zstd",
]);

const GENERIC_CONTENT_TYPES = new Set([
  "application/binary",
  "application/octet-stream",
  "application/unknown",
  "application/x-binary",
  "binary/octet-stream",
]);

const TEXT_REFINEMENTS = new Set<AttachmentClassification>([
  "markdown",
  "csv",
  "tsv",
  "spreadsheet_text",
]);

const OFFICE_ZIP_EXTENSIONS = new Set(["docx", "ods", "odt", "pptx", "xlsx"]);

const EXTRACTABLE_CLASSIFICATIONS = new Set<AttachmentClassification>([
  "pdf",
  "text",
  "markdown",
  "csv",
  "tsv",
  "document",
  "spreadsheet_text",
]);

export function classifyAttachment(
  input: AttachmentClassifierInput,
  settings: AttachmentClassifierSettings = {},
): AttachmentClassificationResult {
  const normalizedSettings = normalizeSettings(settings);
  const filename = input.originalFilename ?? input.filename ?? null;
  const extension = extractExtension(filename);
  const reportedContentType = normalizeContentType(input.contentType);
  const byteSize = normalizeByteSize(input.byteSize ?? input.bytes);
  const rationale: string[] = [];

  if (reportedContentType) {
    rationale.push(`Reported content type normalized to ${reportedContentType}.`);
  } else {
    rationale.push("No reported content type was provided.");
  }

  if (extension) {
    rationale.push(`Filename extension .${extension} was normalized to ${extension}.`);
  } else {
    rationale.push("No filename extension was available for classification.");
  }

  const mimeDescriptor = classifyContentType(reportedContentType);
  const extensionDescriptor = classifyExtension(extension);
  const resolved = resolveClassification({
    reportedContentType,
    extension,
    mimeDescriptor,
    extensionDescriptor,
    rationale,
  });

  const inferredContentType = extensionDescriptor?.canonicalContentType ?? null;
  const normalizedContentType = selectNormalizedContentType({
    reportedContentType,
    inferredContentType,
    resolved,
  });

  const sizeUnsupportedReason = getSizeUnsupportedReason(byteSize, normalizedSettings.maxBytes);
  if (byteSize === null) {
    rationale.push("Byte size was not provided; size policy was not applied.");
  } else if (normalizedSettings.maxBytes === null) {
    rationale.push(`Byte size ${byteSize} accepted because maxBytes policy is disabled.`);
  } else if (sizeUnsupportedReason) {
    rationale.push(sizeUnsupportedReason);
  } else {
    rationale.push(
      `Byte size ${byteSize} is within maxBytes policy ${normalizedSettings.maxBytes}.`,
    );
  }

  const unsupportedByType = getUnsupportedByTypeReason(resolved.descriptor.classification);
  if (unsupportedByType) {
    rationale.push(unsupportedByType);
  }

  const unsupportedCode = getUnsupportedCode(
    resolved.descriptor.classification,
    sizeUnsupportedReason,
  );
  const unsupportedReason = sizeUnsupportedReason ?? unsupportedByType;
  const supported = unsupportedReason === null;

  const {
    jobRecommendations,
    escalationRecommendations,
  } = buildJobRecommendations(resolved.descriptor.classification, unsupportedCode, normalizedSettings);

  return {
    classification: resolved.descriptor.classification,
    type: resolved.descriptor.type,
    supported,
    normalizedContentType,
    reportedContentType,
    inferredContentType,
    extension,
    byteSize,
    recommendedJobs: jobRecommendations.map((job) => job.kind),
    jobRecommendations,
    possibleEscalationJobs: escalationRecommendations.map((job) => job.kind),
    escalationRecommendations,
    unsupportedReason,
    unsupportedCode,
    rationale,
  };
}

export function normalizeAttachmentContentType(
  contentType: string | null | undefined,
): string | null {
  return normalizeContentType(contentType);
}

export function extractAttachmentExtension(
  filename: string | null | undefined,
): string | null {
  return extractExtension(filename);
}

function normalizeSettings(settings: AttachmentClassifierSettings): NormalizedSettings {
  return {
    maxBytes: normalizeMaxBytes(settings.maxBytes, DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES),
    includeClassifyJob: settings.includeClassifyJob ?? false,
    allowLlmFallback: settings.allowLlmFallback ?? true,
    enqueueRetentionReviewForUnsupported:
      settings.enqueueRetentionReviewForUnsupported ?? true,
    enqueueRetentionReviewForOversized: settings.enqueueRetentionReviewForOversized ?? true,
  };
}

function normalizeMaxBytes(value: number | null | undefined, fallback: number): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value ?? Number.NaN)) return fallback;
  return Math.max(0, Math.trunc(value ?? fallback));
}

function normalizeByteSize(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? Number.NaN)) return null;
  return Math.max(0, Math.trunc(value ?? 0));
}

function normalizeContentType(contentType: string | null | undefined): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function extractExtension(filename: string | null | undefined): string | null {
  const trimmed = filename?.trim();
  if (!trimmed) return null;

  const withoutFragment = trimmed.split("#")[0] ?? trimmed;
  const withoutQuery = withoutFragment.split("?")[0] ?? withoutFragment;
  const basename = withoutQuery.split(/[\\/]/).pop() ?? withoutQuery;
  const dotIndex = basename.lastIndexOf(".");

  if (dotIndex < 0 || dotIndex === basename.length - 1) return null;
  if (dotIndex === 0 && basename.indexOf(".", 1) < 0) {
    return basename.slice(1).toLowerCase();
  }

  return basename.slice(dotIndex + 1).toLowerCase();
}

function classifyContentType(
  contentType: string | null,
): ClassificationDescriptor | null {
  if (!contentType || GENERIC_CONTENT_TYPES.has(contentType)) return null;

  const direct = MIME_CLASSIFICATIONS[contentType];
  if (direct) return withContentType(direct, contentType);

  if (contentType.startsWith("image/")) {
    return withContentType(DESCRIPTORS.image, contentType);
  }
  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) {
    return withContentType(DESCRIPTORS.unsupportedMedia, contentType);
  }
  if (ARCHIVE_CONTENT_TYPES.has(contentType)) {
    return withContentType(DESCRIPTORS.unsupportedArchive, contentType);
  }
  if (contentType.startsWith("text/")) {
    return withContentType(DESCRIPTORS.text, contentType);
  }
  if (contentType.endsWith("+json") || contentType.endsWith("+xml")) {
    return withContentType(DESCRIPTORS.text, contentType);
  }

  return null;
}

function classifyExtension(extension: string | null): ClassificationDescriptor | null {
  if (!extension) return null;

  const direct = EXTENSION_CLASSIFICATIONS[extension];
  if (direct) return direct;
  if (MEDIA_EXTENSIONS.has(extension)) return DESCRIPTORS.unsupportedMedia;
  if (ARCHIVE_EXTENSIONS.has(extension)) return DESCRIPTORS.unsupportedArchive;

  return null;
}

function resolveClassification(input: {
  reportedContentType: string | null;
  extension: string | null;
  mimeDescriptor: ClassificationDescriptor | null;
  extensionDescriptor: ClassificationDescriptor | null;
  rationale: string[];
}): ResolvedClassification {
  const {
    reportedContentType,
    extension,
    mimeDescriptor,
    extensionDescriptor,
    rationale,
  } = input;

  if (mimeDescriptor && extensionDescriptor) {
    if (shouldPreferExtension(reportedContentType, extension, mimeDescriptor, extensionDescriptor)) {
      rationale.push(
        `Extension .${extension} refined reported content type ${reportedContentType} to ${extensionDescriptor.label}.`,
      );
      return { descriptor: extensionDescriptor, selectedBy: "extension" };
    }

    if (mimeDescriptor.classification !== extensionDescriptor.classification) {
      rationale.push(
        `Content type ${reportedContentType} and extension .${extension} disagree; content type classification ${mimeDescriptor.classification} was selected.`,
      );
    } else {
      rationale.push(
        `Content type ${reportedContentType} and extension .${extension} both matched ${mimeDescriptor.label}.`,
      );
    }
    return { descriptor: mimeDescriptor, selectedBy: "content_type" };
  }

  if (mimeDescriptor) {
    rationale.push(`Content type ${reportedContentType} matched ${mimeDescriptor.label}.`);
    return { descriptor: mimeDescriptor, selectedBy: "content_type" };
  }

  if (extensionDescriptor) {
    if (reportedContentType && GENERIC_CONTENT_TYPES.has(reportedContentType)) {
      rationale.push(
        `Reported content type ${reportedContentType} is generic; extension .${extension} matched ${extensionDescriptor.label}.`,
      );
    } else {
      rationale.push(`Extension .${extension} matched ${extensionDescriptor.label}.`);
    }
    return { descriptor: extensionDescriptor, selectedBy: "extension" };
  }

  if (reportedContentType) {
    rationale.push(
      `Content type ${reportedContentType} is not in the supported attachment classifier map.`,
    );
  } else {
    rationale.push("No content type or extension matched the supported attachment classifier map.");
  }
  return { descriptor: DESCRIPTORS.unsupportedOther, selectedBy: "fallback" };
}

function shouldPreferExtension(
  reportedContentType: string | null,
  extension: string | null,
  mimeDescriptor: ClassificationDescriptor,
  extensionDescriptor: ClassificationDescriptor,
): boolean {
  if (!reportedContentType || !extension) return false;
  if (GENERIC_CONTENT_TYPES.has(reportedContentType)) return true;
  if (
    mimeDescriptor.classification === "unsupported_archive" &&
    OFFICE_ZIP_EXTENSIONS.has(extension)
  ) {
    return true;
  }
  if (
    mimeDescriptor.classification === "text" &&
    TEXT_REFINEMENTS.has(extensionDescriptor.classification)
  ) {
    return true;
  }
  if (
    mimeDescriptor.classification === "spreadsheet_text" &&
    (extensionDescriptor.classification === "csv" || extensionDescriptor.classification === "tsv")
  ) {
    return true;
  }
  return false;
}

function selectNormalizedContentType(input: {
  reportedContentType: string | null;
  inferredContentType: string | null;
  resolved: ResolvedClassification;
}): string | null {
  const { reportedContentType, inferredContentType, resolved } = input;
  if (resolved.selectedBy === "extension" && inferredContentType) {
    return inferredContentType;
  }
  if (reportedContentType && !GENERIC_CONTENT_TYPES.has(reportedContentType)) {
    return reportedContentType;
  }
  return inferredContentType ?? reportedContentType;
}

function getSizeUnsupportedReason(byteSize: number | null, maxBytes: number | null): string | null {
  if (byteSize === null || maxBytes === null || byteSize <= maxBytes) return null;
  return `Attachment exceeds maxBytes policy (${byteSize} > ${maxBytes}).`;
}

function getUnsupportedByTypeReason(
  classification: AttachmentClassification,
): string | null {
  switch (classification) {
    case "unsupported_media":
      return "Audio/video media attachments are recorded but not processed by the current pipeline.";
    case "unsupported_archive":
      return "Archive attachments are recorded but not unpacked by the current pipeline.";
    case "unsupported_other":
      return "Attachment type could not be classified into a supported extraction pipeline.";
    default:
      return null;
  }
}

function getUnsupportedCode(
  classification: AttachmentClassification,
  sizeUnsupportedReason: string | null,
): AttachmentUnsupportedCode | null {
  if (sizeUnsupportedReason) return "too_large";
  switch (classification) {
    case "unsupported_media":
      return "unsupported_media";
    case "unsupported_archive":
      return "unsupported_archive";
    case "unsupported_other":
      return "unsupported_other";
    default:
      return null;
  }
}

function buildJobRecommendations(
  classification: AttachmentClassification,
  unsupportedCode: AttachmentUnsupportedCode | null,
  settings: NormalizedSettings,
): {
  jobRecommendations: AttachmentJobRecommendation[];
  escalationRecommendations: AttachmentJobRecommendation[];
} {
  const jobRecommendations: AttachmentJobRecommendation[] = [];
  const escalationRecommendations: AttachmentJobRecommendation[] = [];

  if (settings.includeClassifyJob) {
    jobRecommendations.push({
      kind: "classify",
      reason: "Run the deterministic attachment classifier before extraction or review jobs.",
    });
  }

  if (unsupportedCode) {
    const shouldReview =
      unsupportedCode === "too_large"
        ? settings.enqueueRetentionReviewForOversized
        : settings.enqueueRetentionReviewForUnsupported;
    if (shouldReview) {
      jobRecommendations.push({
        kind: "retention_review",
        reason: "Unsupported or oversized attachments are kept visible for retention review.",
      });
    }
    return { jobRecommendations, escalationRecommendations };
  }

  if (classification === "image") {
    jobRecommendations.push({
      kind: "apple_ocr",
      reason: "Image attachments start with deterministic Apple OCR.",
    });
    addChunkAndDirectoryJobs(jobRecommendations);
    if (settings.allowLlmFallback) {
      escalationRecommendations.push({
        kind: "llm_fallback",
        reason:
          "Escalate to LLM vision only if OCR quality is low or the user asks for visual reasoning.",
      });
    }
    return { jobRecommendations, escalationRecommendations };
  }

  if (EXTRACTABLE_CLASSIFICATIONS.has(classification)) {
    jobRecommendations.push({
      kind: "embedded_text",
      reason: "Text, document, PDF, and spreadsheet-like attachments start with embedded text extraction.",
    });
    addChunkAndDirectoryJobs(jobRecommendations);

    if (classification === "pdf") {
      escalationRecommendations.push({
        kind: "apple_ocr",
        reason: "Use Apple OCR if embedded PDF text is empty or appears scanned.",
      });
      if (settings.allowLlmFallback) {
        escalationRecommendations.push({
          kind: "llm_fallback",
          reason:
            "Escalate scanned or visual PDFs to LLM fallback only after deterministic extraction/OCR is insufficient.",
        });
      }
    }
  }

  return { jobRecommendations, escalationRecommendations };
}

function addChunkAndDirectoryJobs(
  jobRecommendations: AttachmentJobRecommendation[],
): void {
  jobRecommendations.push(
    {
      kind: "chunk",
      reason: "Chunk extracted or OCR text with source pointers for bounded retrieval.",
    },
    {
      kind: "directory",
      reason: "Build a compact attachment directory record after extraction.",
    },
  );
}

function withContentType(
  descriptor: ClassificationDescriptor,
  contentType: string,
): ClassificationDescriptor {
  return {
    ...descriptor,
    canonicalContentType: contentType,
  };
}
