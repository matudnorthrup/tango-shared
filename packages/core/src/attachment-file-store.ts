import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ATTACHMENT_SOURCE_PREFIX = "attachments/source/sha256";
const DEFAULT_FILENAME = "attachment";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_STEM_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 32;

export interface StoredAttachmentFile {
  sha256: string;
  bytes: number;
  storagePath: string;
  relativePath: string;
  originalFilename: string;
  storedFilename: string;
  deduped: boolean;
}

export interface AttachmentBufferInput {
  data: Buffer | Uint8Array;
  originalFilename?: string | null;
}

export interface AttachmentLocalFileInput {
  sourcePath: string;
  originalFilename?: string | null;
}

type AttachmentStorageTarget = Pick<
  StoredAttachmentFile,
  "storagePath" | "relativePath" | "storedFilename"
>;

export class AttachmentFileStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (rootDir.trim().length === 0) {
      throw new Error("Attachment file store root directory is required");
    }

    this.rootDir = path.resolve(rootDir);
  }

  ingestBuffer(input: AttachmentBufferInput): StoredAttachmentFile {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const bytes = data.byteLength;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const originalFilename = normalizeOriginalFilename(input.originalFilename);
    const storedFilename = sanitizeAttachmentFilename(originalFilename);
    const existingTarget = this.findExistingTarget(sha256, bytes);

    if (existingTarget) {
      return { ...existingTarget, sha256, bytes, originalFilename, deduped: true };
    }

    const target = this.buildTarget(sha256, storedFilename);
    const tempPath = this.createTempPath();
    try {
      fs.writeFileSync(tempPath, data, { flag: "wx", mode: FILE_MODE });
      const { target: committedTarget, deduped } = this.commitTempFile(
        tempPath,
        target,
        sha256,
        bytes,
      );
      return { ...committedTarget, sha256, bytes, originalFilename, deduped };
    } catch (error) {
      rmFileIfExists(tempPath);
      throw error;
    }
  }

  ingestFile(input: AttachmentLocalFileInput): StoredAttachmentFile {
    const sourceStat = fs.statSync(input.sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`Attachment source is not a file: ${input.sourcePath}`);
    }

    const originalFilename = normalizeOriginalFilename(
      input.originalFilename,
      path.basename(input.sourcePath),
    );
    const storedFilename = sanitizeAttachmentFilename(originalFilename);
    const tempPath = this.createTempPath();

    try {
      const { sha256, bytes } = copyFileToTempAndHash(input.sourcePath, tempPath);
      const target = this.buildTarget(sha256, storedFilename);
      const { target: committedTarget, deduped } = this.commitTempFile(
        tempPath,
        target,
        sha256,
        bytes,
      );
      return { ...committedTarget, sha256, bytes, originalFilename, deduped };
    } catch (error) {
      rmFileIfExists(tempPath);
      throw error;
    }
  }

  private buildTarget(
    sha256: string,
    storedFilename: string,
  ): AttachmentStorageTarget {
    const { relativeDir, storageDir } = this.buildHashDir(sha256);
    const relativePath = path.posix.join(relativeDir, storedFilename);
    return {
      storedFilename,
      relativePath,
      storagePath: path.join(storageDir, storedFilename),
    };
  }

  private createTempPath(): string {
    const tempDir = path.join(this.rootDir, "attachments", "source", ".tmp");
    fs.mkdirSync(tempDir, { recursive: true, mode: DIR_MODE });
    return path.join(tempDir, `${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  }

  private commitTempFile(
    tempPath: string,
    target: AttachmentStorageTarget,
    sha256: string,
    bytes: number,
  ): { target: AttachmentStorageTarget; deduped: boolean } {
    const existingTarget = this.findExistingTarget(sha256, bytes);
    if (existingTarget) {
      rmFileIfExists(tempPath);
      return { target: existingTarget, deduped: true };
    }

    fs.mkdirSync(path.dirname(target.storagePath), { recursive: true, mode: DIR_MODE });

    try {
      fs.linkSync(tempPath, target.storagePath);
      rmFileIfExists(tempPath);
      return { target, deduped: false };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const racedTarget = this.findExistingTarget(sha256, bytes);
        if (racedTarget) {
          rmFileIfExists(tempPath);
          return { target: racedTarget, deduped: true };
        }
      }

      throw error;
    }
  }

  private findExistingTarget(sha256: string, bytes: number): AttachmentStorageTarget | null {
    const { relativeDir, storageDir } = this.buildHashDir(sha256);
    let filenames: string[];

    try {
      filenames = fs.readdirSync(storageDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    for (const storedFilename of filenames) {
      const storagePath = path.join(storageDir, storedFilename);
      try {
        const stat = fs.statSync(storagePath);
        if (stat.isFile() && stat.size === bytes) {
          return {
            storedFilename,
            storagePath,
            relativePath: path.posix.join(relativeDir, storedFilename),
          };
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    return null;
  }

  private buildHashDir(sha256: string): { storageDir: string; relativeDir: string } {
    const relativeDir = path.posix.join(ATTACHMENT_SOURCE_PREFIX, sha256.slice(0, 2), sha256);
    return {
      relativeDir,
      storageDir: path.join(this.rootDir, ...relativeDir.split("/")),
    };
  }
}

export function sanitizeAttachmentFilename(filename?: string | null): string {
  const originalFilename = normalizeOriginalFilename(filename);
  const extension = getSafeExtension(originalFilename);
  const rawStem = extension.length > 0
    ? originalFilename.slice(0, -extension.length)
    : originalFilename;
  const stem = sanitizeFilenamePart(rawStem).slice(0, MAX_STEM_LENGTH) || DEFAULT_FILENAME;

  return `${stem}${extension}`;
}

function normalizeOriginalFilename(filename?: string | null, fallback?: string | null): string {
  const candidate = filename?.trim() || fallback?.trim() || DEFAULT_FILENAME;
  const normalizedSeparators = candidate.replace(/\\/g, "/");
  const parts = normalizedSeparators.split("/").filter((part) => part.length > 0);
  const basename = parts.at(-1)?.trim() || DEFAULT_FILENAME;

  if (basename === "." || basename === "..") {
    return DEFAULT_FILENAME;
  }

  return basename;
}

function getSafeExtension(filename: string): string {
  const extension = path.posix.extname(filename);
  if (
    extension.length < 2 ||
    extension.length > MAX_EXTENSION_LENGTH + 1 ||
    !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extension)
  ) {
    return "";
  }

  return extension;
}

function sanitizeFilenamePart(part: string): string {
  return part
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

function copyFileToTempAndHash(sourcePath: string, tempPath: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  let sourceFd: number | undefined;
  let tempFd: number | undefined;

  try {
    sourceFd = fs.openSync(sourcePath, "r");
    tempFd = fs.openSync(tempPath, "wx", FILE_MODE);

    while (true) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      writeAllSync(tempFd, chunk);
      bytes += bytesRead;
    }
  } finally {
    if (tempFd !== undefined) {
      fs.closeSync(tempFd);
    }
    if (sourceFd !== undefined) {
      fs.closeSync(sourceFd);
    }
  }

  return { sha256: hash.digest("hex"), bytes };
}

function writeAllSync(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.byteLength) {
    offset += fs.writeSync(fd, data, offset, data.byteLength - offset);
  }
}

function rmFileIfExists(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
