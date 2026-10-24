import * as fs from 'node:fs';
import * as path from 'node:path';

// Images travel as data URLs; Loom and Discord store them in their own attachment stores.

export interface StartAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

/** An image on a stored message. `url` is the desk's own route for it (relative, like the API). */
export interface MessageAttachment {
  name: string;
  mimeType: string;
  url: string;
  sizeBytes?: number;
}

/** Images accepted by the desk: four types, 10 MiB each. */
export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
/**
 * A bot's upload limit on one Discord message (every file together) is 10 MiB on a server with no
 * boost; a little under it leaves room for the request around them.
 */
export const MAX_DISCORD_UPLOAD_BYTES = 9.5 * 1024 * 1024;

/** Each attachment's decoded size, or the problem with it. */
export function attachmentProblems(attachments: StartAttachment[]): { sizes: number[]; problems: string[] } {
  const problems: string[] = [];
  const sizes: number[] = [];
  if (attachments.length > MAX_ATTACHMENTS) problems.push(`At most ${MAX_ATTACHMENTS} images on one message (this one has ${attachments.length}).`);
  for (const attachment of attachments) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(attachment.dataUrl ?? '');
    const name = String(attachment.name || 'image').slice(0, 80);
    if (!match || match[1] !== attachment.mimeType) {
      problems.push(`“${name}” isn’t an image the desk can send.`);
      sizes.push(0);
      continue;
    }
    if (!ATTACHMENT_TYPES.includes(attachment.mimeType)) problems.push(`“${name}” is ${attachment.mimeType}; images must be PNG, JPEG, GIF or WebP.`);
    const base64 = match[2]!.replace(/\s/g, '');
    const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (bytes > MAX_ATTACHMENT_BYTES) problems.push(`“${name}” is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`);
    sizes.push(bytes);
  }
  return { sizes, problems };
}

/** A request body's `attachments`, shaped (not yet checked: attachmentProblems does that). Absent or not a list: none. */
export function parseAttachments(value: unknown): StartAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({ name: String(entry.name ?? ''), mimeType: String(entry.mimeType ?? ''), dataUrl: String(entry.dataUrl ?? '') }));
}

/** "2 images", for a reply that is only pictures. */
export function imagesWord(count: number): string {
  return `${count} image${count === 1 ? '' : 's'}`;
}

// ── serving retained T3 images ──────────────────────────────────────────
// T3 is retired, but retained desk records still link its stored images; serve them read-only while the files exist.

/** T3's attachment ids: `<thread>-<uuid>` (its ChatAttachmentId pattern), never a path. */
const T3_ATTACHMENT_ID = /^[a-z0-9_-]{1,128}$/i;

const EXTENSION_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** The file T3 stored for one image attachment (`<id>.<ext>` in its attachments directory), or null. */
export function t3AttachmentFile(dir: string, id: string): { file: string; mimeType: string } | null {
  if (!T3_ATTACHMENT_ID.test(id)) return null;
  for (const [extension, mimeType] of Object.entries(EXTENSION_TYPES)) {
    const file = path.join(dir, `${id}${extension}`);
    if (fs.existsSync(file)) return { file, mimeType };
  }
  return null;
}
