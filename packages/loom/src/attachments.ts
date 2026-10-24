import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Images on a user message. The bytes live in files under Loom's state
 * directory, one folder per thread; the database keeps only a row per image.
 * Same limits as the Desk's T3 uploads: four types, 10 MB each, 8 per message.
 */

export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;

/** An image as a client sends it. */
export interface ImageUpload {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface DecodedImage {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** A turn's image, as a harness takes it. */
export interface TurnImage {
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
}

/** Decodes and checks a message's images. Throws a message for the first problem. */
export function decodeImages(uploads: unknown): DecodedImage[] {
  if (uploads === undefined || uploads === null) return [];
  if (!Array.isArray(uploads)) throw new Error("attachments must be a list");
  if (uploads.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images on one message (this one has ${uploads.length})`);
  return uploads.map((raw, index) => {
    const upload = (raw ?? {}) as Partial<ImageUpload>;
    const name = String(upload.name || `image-${index + 1}`).slice(0, 255);
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(upload.dataUrl ?? ""));
    if (!match || match[1] !== upload.mimeType) throw new Error(`“${name}” isn't a base64 image data URL matching its type`);
    if (!IMAGE_TYPES[match[1]!]) throw new Error(`“${name}” is ${match[1]}; Loom takes PNG, JPEG, GIF or WebP`);
    const bytes = Buffer.from(match[2]!.replace(/\s/g, ""), "base64");
    if (bytes.length === 0) throw new Error(`“${name}” is empty`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`“${name}” is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB`);
    return { name, mimeType: match[1]!, bytes };
  });
}

/** Where a thread's images live on disk. Paths are built from ids Loom made, and checked to stay inside. */
export class AttachmentFiles {
  constructor(readonly dir: string) {}

  private inside(path: string): string {
    const root = resolve(this.dir);
    const full = resolve(path);
    if (!full.startsWith(root + sep)) throw new Error("attachment path escapes the attachments folder");
    return full;
  }

  write(threadId: string, image: DecodedImage): { id: string; path: string } {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) throw new Error("bad thread id");
    const id = randomUUID();
    const folder = this.inside(join(this.dir, threadId));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = this.inside(join(folder, `${id}.${IMAGE_TYPES[image.mimeType]}`));
    writeFileSync(path, image.bytes, { mode: 0o600 });
    return { id, path };
  }

  read(path: string): Buffer {
    return readFileSync(this.inside(path));
  }

  remove(path: string): void {
    rmSync(this.inside(path), { force: true });
  }

  removeThread(threadId: string): void {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) return;
    rmSync(this.inside(join(this.dir, threadId)), { recursive: true, force: true });
  }
}
