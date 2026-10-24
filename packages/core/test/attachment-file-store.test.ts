import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentFileStore, sanitizeAttachmentFilename } from "../src/attachment-file-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix = "tango-attachment-store-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("AttachmentFileStore", () => {
  it("stores buffer content under a hash-based source path", () => {
    const rootDir = createTempDir();
    const store = new AttachmentFileStore(rootDir);
    const data = Buffer.from("hello durable attachment storage", "utf8");
    const expectedHash = sha256(data);

    const result = store.ingestBuffer({ data, originalFilename: "notes.txt" });

    expect(result).toEqual({
      sha256: expectedHash,
      bytes: data.byteLength,
      storagePath: path.join(
        rootDir,
        "attachments",
        "source",
        "sha256",
        expectedHash.slice(0, 2),
        expectedHash,
        "notes.txt",
      ),
      relativePath: path.posix.join(
        "attachments",
        "source",
        "sha256",
        expectedHash.slice(0, 2),
        expectedHash,
        "notes.txt",
      ),
      originalFilename: "notes.txt",
      storedFilename: "notes.txt",
      deduped: false,
    });
    expect(fs.readFileSync(result.storagePath)).toEqual(data);
  });

  it("stores an existing local file and derives the filename from the path", () => {
    const tempDir = createTempDir();
    const rootDir = path.join(tempDir, "store-root");
    const sourceDir = path.join(tempDir, "source files");
    const sourcePath = path.join(sourceDir, "Photo.PNG");
    const data = Buffer.from([0, 1, 2, 3, 254, 255]);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, data);

    const result = new AttachmentFileStore(rootDir).ingestFile({ sourcePath });

    expect(result.sha256).toBe(sha256(data));
    expect(result.bytes).toBe(data.byteLength);
    expect(result.originalFilename).toBe("Photo.PNG");
    expect(result.storedFilename).toBe("Photo.PNG");
    expect(result.deduped).toBe(false);
    expect(fs.readFileSync(result.storagePath)).toEqual(data);
  });

  it("dedupes duplicate content without rewriting the existing target", () => {
    const rootDir = createTempDir();
    const store = new AttachmentFileStore(rootDir);
    const data = Buffer.from("same bytes, same source", "utf8");
    const first = store.ingestBuffer({ data, originalFilename: "dupe.bin" });
    const oldDate = new Date("2024-01-01T00:00:00.000Z");
    fs.utimesSync(first.storagePath, oldDate, oldDate);
    const before = fs.statSync(first.storagePath).mtimeMs;

    const second = store.ingestBuffer({ data, originalFilename: "dupe.bin" });

    expect(second).toEqual({ ...first, deduped: true });
    expect(fs.statSync(first.storagePath).mtimeMs).toBe(before);
  });

  it("dedupes identical bytes with different filenames to the existing hash source", () => {
    const tempDir = createTempDir();
    const rootDir = path.join(tempDir, "store-root");
    const sourceDir = path.join(tempDir, "source-files");
    const sourcePath = path.join(sourceDir, "renamed photo.jpg");
    const store = new AttachmentFileStore(rootDir);
    const data = Buffer.from("same bytes with a new filename", "utf8");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, data);

    const first = store.ingestBuffer({ data, originalFilename: "original.png" });
    const second = store.ingestFile({ sourcePath });
    const renamedTarget = path.join(
      rootDir,
      "attachments",
      "source",
      "sha256",
      first.sha256.slice(0, 2),
      first.sha256,
      "renamed-photo.jpg",
    );

    expect(second).toEqual({
      ...first,
      originalFilename: "renamed photo.jpg",
      deduped: true,
    });
    expect(fs.existsSync(renamedTarget)).toBe(false);
  });

  it("sanitizes path traversal and unsafe filename characters", () => {
    const rootDir = createTempDir();
    const result = new AttachmentFileStore(rootDir).ingestBuffer({
      data: Buffer.from("safe path please", "utf8"),
      originalFilename: "../../private/My unsafe image?.png",
    });

    expect(result.originalFilename).toBe("My unsafe image?.png");
    expect(result.storedFilename).toBe("My-unsafe-image.png");
    expect(result.storedFilename).not.toContain("/");
    expect(result.storedFilename).not.toContain("\\");
    expect(result.storedFilename).not.toContain("..");
    expect(path.relative(rootDir, result.storagePath).startsWith("..")).toBe(false);
    expect(fs.existsSync(result.storagePath)).toBe(true);
  });

  it("handles empty and extensionless filenames", () => {
    const rootDir = createTempDir();
    const store = new AttachmentFileStore(rootDir);

    const emptyName = store.ingestBuffer({
      data: Buffer.from("empty name", "utf8"),
      originalFilename: "   ",
    });
    const extensionless = store.ingestBuffer({
      data: Buffer.from("extensionless name", "utf8"),
      originalFilename: "README",
    });

    expect(emptyName.originalFilename).toBe("attachment");
    expect(emptyName.storedFilename).toBe("attachment");
    expect(extensionless.originalFilename).toBe("README");
    expect(extensionless.storedFilename).toBe("README");
    expect(fs.readFileSync(emptyName.storagePath, "utf8")).toBe("empty name");
    expect(fs.readFileSync(extensionless.storagePath, "utf8")).toBe("extensionless name");
  });

  it("reports accurate bytes and sha256 for Uint8Array views", () => {
    const rootDir = createTempDir();
    const backing = Uint8Array.from([9, 8, 7, 6, 5, 4]);
    const view = backing.subarray(1, 5);
    const expected = Buffer.from([8, 7, 6, 5]);

    const result = new AttachmentFileStore(rootDir).ingestBuffer({
      data: view,
      originalFilename: "bytes.dat",
    });

    expect(result.bytes).toBe(expected.byteLength);
    expect(result.sha256).toBe(sha256(expected));
    expect(fs.readFileSync(result.storagePath)).toEqual(expected);
  });

  it("preserves only safe extensions during filename sanitization", () => {
    expect(sanitizeAttachmentFilename("report.final.pdf")).toBe("report.final.pdf");
    expect(sanitizeAttachmentFilename("archive.tar.gz")).toBe("archive.tar.gz");
    expect(sanitizeAttachmentFilename("name.bad/ext")).toBe("ext");
    expect(sanitizeAttachmentFilename("script.sh;rm")).toBe("script.sh-rm");
  });
});
