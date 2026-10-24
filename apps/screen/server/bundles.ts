import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Bundles: a prototype's files (a folder of HTML, JS, CSS, images), uploaded by
// a local caller (the `tango-screen` CLI) and served at /bundles/<id>/<path>.
// The caller sends the bytes, so the server never reads a path it was handed:
// what an agent can show is what that agent could already read. Files are
// served under a CSP sandbox (an opaque origin), so a prototype can't reach
// the screen's own API even though it shares the screen's host.

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2000;
const ID_RE = /^[a-f0-9]{24}$/;
/** Kept this long after no live or retained scene refers to it. */
const ORPHAN_GRACE_MS = 60 * 60_000;

export class BundleRejected extends Error {}

export interface BundleFile {
  path: string;
  /** base64 */
  data: string;
}

/** A safe relative path inside a bundle: no absolute paths, no `..`, no empty segments. */
export function safeBundlePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.length > 512) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) return null;
  return segments.join('/');
}

/** `bundles/<id>/<path>` → its parts, or null. */
export function parseBundleRef(body: string): { id: string; file: string } | null {
  const match = /^bundles\/([a-f0-9]{24})\/(.+)$/.exec(body.trim());
  if (!match) return null;
  const file = safeBundlePath(decodeURIComponent(match[2]!.split(/[?#]/)[0]!));
  return file ? { id: match[1]!, file } : null;
}

export class BundleStore {
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  save(files: unknown): { id: string; files: number; bytes: number } {
    if (!Array.isArray(files) || files.length === 0) throw new BundleRejected('files must be a non-empty array of {path, data}');
    if (files.length > MAX_BUNDLE_FILES) throw new BundleRejected(`a bundle holds at most ${MAX_BUNDLE_FILES} files`);
    const decoded: Array<{ path: string; data: Buffer }> = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const raw of files as BundleFile[]) {
      const file = safeBundlePath(raw?.path);
      if (!file) throw new BundleRejected(`not a safe relative path: ${String(raw?.path)}`);
      if (seen.has(file)) throw new BundleRejected(`duplicate path: ${file}`);
      if (typeof raw.data !== 'string') throw new BundleRejected(`${file}: data must be base64`);
      seen.add(file);
      const data = Buffer.from(raw.data, 'base64');
      bytes += data.length;
      if (bytes > MAX_BUNDLE_BYTES) throw new BundleRejected(`bundle is over ${MAX_BUNDLE_BYTES / 1024 / 1024} MB`);
      decoded.push({ path: file, data });
    }
    const id = randomBytes(12).toString('hex');
    const root = path.join(this.dir, id);
    for (const file of decoded) {
      const target = path.join(root, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.data);
    }
    return { id, files: decoded.length, bytes };
  }

  has(id: string, file: string): boolean {
    return this.filePath(id, file) !== null;
  }

  /** The file on disk for /bundles/<id>/<file>, or null (unknown bundle, unsafe path, a directory). */
  filePath(id: string, file: string): string | null {
    if (!ID_RE.test(id)) return null;
    const relative = safeBundlePath(file);
    if (!relative) return null;
    const root = path.join(this.dir, id);
    let full = path.join(root, relative);
    try {
      if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
      // Written by save() only (no symlinks), but resolve anyway so nothing escapes the bundle.
      const real = fs.realpathSync(full);
      const rel = path.relative(fs.realpathSync(root), real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  /** Removes bundles no scene refers to once they are past the grace period. */
  sweep(referenced: Set<string>): string[] {
    const removed: string[] = [];
    for (const id of fs.readdirSync(this.dir)) {
      if (!ID_RE.test(id) || referenced.has(id)) continue;
      const full = path.join(this.dir, id);
      if (this.now() - fs.statSync(full).mtimeMs < ORPHAN_GRACE_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(id);
    }
    return removed;
  }
}

export const BUNDLE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

/** Bundle files run in an opaque origin: scripts and forms work, the screen's API and cookies don't. */
export const BUNDLE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/**
 * In an opaque origin, touching localStorage/sessionStorage throws, and plenty of
 * prototypes read one at startup. Before the page's own scripts: swap in an
 * in-memory Storage so they run (state lasts until reload).
 */
export const STORAGE_SHIM = `<script>(function(){function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('x')}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}})})();</script>`;

/** Puts the storage shim first in the document, before any of the page's scripts. */
export function withStorageShim(html: string): string {
  if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}${STORAGE_SHIM}`);
  if (/<html(\s[^>]*)?>/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (tag) => `${tag}${STORAGE_SHIM}`);
  // After a doctype, never before it: a script ahead of the doctype drops the page into quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + STORAGE_SHIM + html.slice(doctype[0].length);
  return STORAGE_SHIM + html;
}
