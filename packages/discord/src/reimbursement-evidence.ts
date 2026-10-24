import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfiguredPath } from "@tango/core";
import { resolveDefaultWalmartEvidenceRoot } from "./receipt-paths.js";

export interface ReimbursementEvidenceRecord {
  version: 1;
  kind?: string;
  orderId?: string;
  sourcePath: string;
  archivedPath: string;
  sha256: string;
  fileSize: number;
  imageWidth?: number;
  imageHeight?: number;
  captureMode?: string;
  selectorUsed?: string;
  dateVisible?: boolean;
  visibleDateText?: string[];
  verificationWarnings?: string[];
  capturedAt?: string;
  uploadedAt?: string;
  expenseReportId?: string;
  reviewUrl?: string;
  expenseConfirmationPath?: string;
  expenseConfirmationSha256?: string;
  expenseConfirmationImageWidth?: number;
  expenseConfirmationImageHeight?: number;
}

export interface ArchiveReimbursementEvidenceInput {
  sourcePath: string;
  orderId?: string;
  label?: string;
  metadata?: Partial<ReimbursementEvidenceRecord>;
}

function sanitizePathToken(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return sanitized.length > 0 ? sanitized : fallback;
}

function buildEvidenceSidecarPath(filePath: string): string {
  return `${filePath}.json`;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (
    buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return undefined;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      break;
    }

    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  return undefined;
}

export function readImageDimensions(filePath: string): { width: number; height: number } | undefined {
  const buffer = fs.readFileSync(filePath);
  return readPngDimensions(buffer) ?? readJpegDimensions(buffer);
}

export function computeFileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function resolveReimbursementEvidenceRoot(): string {
  const configured = process.env.TANGO_REIMBURSEMENT_EVIDENCE_DIR?.trim();
  const root = configured && configured.length > 0
    ? resolveConfiguredPath(configured)
    : resolveDefaultWalmartEvidenceRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function loadReimbursementEvidenceRecord(filePath: string): ReimbursementEvidenceRecord | null {
  const sidecarPath = buildEvidenceSidecarPath(path.resolve(filePath));
  if (!fs.existsSync(sidecarPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as ReimbursementEvidenceRecord;
  } catch {
    return null;
  }
}

function writeReimbursementEvidenceRecord(record: ReimbursementEvidenceRecord): void {
  fs.mkdirSync(path.dirname(record.archivedPath), { recursive: true });
  fs.writeFileSync(
    buildEvidenceSidecarPath(record.archivedPath),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export function archiveReimbursementEvidence(
  input: ArchiveReimbursementEvidenceInput,
): ReimbursementEvidenceRecord {
  const sourcePath = path.resolve(input.sourcePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Evidence file does not exist: ${sourcePath}`);
  }

  const rootDir = resolveReimbursementEvidenceRoot();
  const ext = path.extname(sourcePath) || ".bin";
  const sha256 = computeFileSha256(sourcePath);
  const dimensions = readImageDimensions(sourcePath);
  const stats = fs.statSync(sourcePath);
  const existing = loadReimbursementEvidenceRecord(sourcePath);

  let archivedPath = sourcePath;
  if (!sourcePath.startsWith(`${rootDir}${path.sep}`)) {
    const orderSegment = sanitizePathToken(input.orderId ?? input.metadata?.orderId, "_unassigned");
    const labelSegment = sanitizePathToken(input.label ?? input.metadata?.kind, "evidence");
    const archiveDir = path.join(rootDir, orderSegment);
    archivedPath = path.join(archiveDir, `${labelSegment}-${sha256.slice(0, 12)}${ext}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    if (!fs.existsSync(archivedPath)) {
      fs.copyFileSync(sourcePath, archivedPath);
    }
  }

  const archivedExisting = loadReimbursementEvidenceRecord(archivedPath);
  const archivedStats = fs.statSync(archivedPath);
  const record: ReimbursementEvidenceRecord = {
    version: 1,
    ...existing,
    ...archivedExisting,
    ...input.metadata,
    sourcePath: archivedExisting?.sourcePath ?? existing?.sourcePath ?? sourcePath,
    archivedPath,
    sha256,
    fileSize: archivedStats.size,
    imageWidth: dimensions?.width,
    imageHeight: dimensions?.height,
    orderId: input.orderId ?? input.metadata?.orderId ?? archivedExisting?.orderId ?? existing?.orderId,
  };

  if (archivedPath !== sourcePath && (!record.capturedAt || record.capturedAt.trim().length === 0)) {
    record.capturedAt = stats.birthtime.toISOString();
  }

  writeReimbursementEvidenceRecord(record);
  return record;
}
